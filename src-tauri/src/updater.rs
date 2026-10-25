//! In-app updates through `tauri-plugin-updater`.
//!
//! The app reads `latest.json` from the newest GitHub release (endpoint and public key in
//! `tauri.conf.json` → `plugins.updater`). Every update file is signed with the project's
//! updater key (minisign, not Apple code signing), and the plugin refuses anything whose
//! signature doesn't match the public key. The UI decides *when* to check and install; this
//! module never acts on its own, so nothing happens during a ride.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Placeholder for `plugins.updater.pubkey` until the updater key is set up.
const PUBKEY_UNSET: &str = "UPDATER_PUBLIC_KEY_NOT_SET";

/// The update found by the last check, kept until it is installed or a new check replaces it.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// True when this build carries a real updater public key.
pub fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|k| !k.trim().is_empty() && k != PUBKEY_UNSET)
}

/// Ask the release manifest for a newer version.
/// Returns `{ version, current, notes }` or `null` when the app is up to date.
pub async fn check(app: &AppHandle) -> Result<Value, String> {
    if !configured(app) {
        return Err("Updates aren't set up for this build".into());
    }
    let update = app
        .updater()
        .map_err(|e| format!("Could not check for updates: {e}"))?
        .check()
        .await
        .map_err(friendly)?;
    let info = update.as_ref().map_or(Value::Null, |u| {
        json!({ "version": u.version, "current": u.current_version, "notes": u.body })
    });
    *app.state::<Pending>().0.lock().unwrap() = update;
    Ok(info)
}

/// Download, verify and install the pending update, then restart into the new version.
/// Progress goes to the UI as `update-progress { done, total }` (whole percent steps only).
/// On Windows the installer quits the app by itself before this returns.
pub async fn install(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<Pending>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("No update to install. Check for updates again.")?;
    let events = app.clone();
    let mut done: u64 = 0;
    let mut last_pct: Option<u64> = None;
    let result = update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let pct = total.filter(|t| *t > 0).map(|t| done * 100 / t);
                if pct.is_none() || pct != last_pct {
                    last_pct = pct;
                    let _ = events.emit("update-progress", json!({ "done": done, "total": total }));
                }
            },
            || {},
        )
        .await;
    if let Err(e) = result {
        // keep it so "Install" can be tried again without a new check
        *app.state::<Pending>().0.lock().unwrap() = Some(update);
        return Err(friendly(e));
    }
    app.restart();
}

/// Short, plain error text for the UI.
fn friendly(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::TargetsNotFound(_) | E::TargetNotFound(_) => "No update is published for this platform yet".into(),
        E::Reqwest(_) | E::Network(_) => "Could not reach GitHub. Check your internet connection.".into(),
        E::Minisign(_) | E::SignatureUtf8(_) => "The update's signature didn't match, so it wasn't installed".into(),
        e => format!("Update failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_updater::Error as E;

    #[test]
    fn friendly_errors() {
        assert_eq!(friendly(E::TargetsNotFound(vec!["linux-x86_64-deb".into()])), "No update is published for this platform yet");
        assert_eq!(friendly(E::Network("timeout".into())), "Could not reach GitHub. Check your internet connection.");
        assert!(friendly(E::ReleaseNotFound).starts_with("Update failed: "));
    }

    #[test]
    fn updater_config_is_valid() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let key = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        // the shipped config either still has the placeholder or a real minisign public key (base64)
        assert!(key == PUBKEY_UNSET || key.len() > 40, "unexpected updater pubkey: {key}");
        let endpoint = conf["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
        assert!(endpoint.starts_with("https://github.com/") && endpoint.ends_with("/releases/latest/download/latest.json"));
    }
}
