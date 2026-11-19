mod battery;
mod ble;
mod fit;
mod garmin;
mod library;
mod obc;
mod ride_window;
mod shifter;
mod services;
mod state;
mod sync;
mod updater;
mod zwo;

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct App {
    store: Arc<state::Store>,
    cache: Arc<library::Cache>,
    ble: Arc<ble::Ble>,
    shifters: Arc<shifter::Controllers>,
    awake: Mutex<Option<std::process::Child>>,
}

type Res<T> = Result<T, String>;

// ---------------------------------------------------------------- profiles & state

#[tauri::command]
fn app_state(app: State<'_, App>) -> Value {
    app.store.app_state()
}

#[tauri::command]
fn save_profile(app: State<'_, App>, profile: Value) -> Res<()> {
    app.store.save_profile(profile)
}

#[tauri::command]
fn create_profile(app: State<'_, App>, name: String) -> Res<Value> {
    app.store.create_profile(&name)
}

#[tauri::command]
fn rename_profile(app: State<'_, App>, id: String, name: String) -> Res<Value> {
    app.store.rename_profile(&id, &name)
}

/// Name and/or avatar ({ color, emoji }) of a rider.
#[tauri::command]
fn edit_profile(app: State<'_, App>, id: String, name: Option<String>, avatar: Option<Value>) -> Res<Value> {
    app.store.edit_profile(&id, name.as_deref(), avatar)
}

// ---------------------------------------------------------------- app updates

/// Newer release? `{ version, current, notes }` or `null`. The UI never calls this during a ride.
#[tauri::command]
async fn update_check(handle: tauri::AppHandle) -> Res<Value> {
    updater::check(&handle).await
}

/// Download and install the update found by `update_check`, then restart the app.
#[tauri::command]
async fn update_install(handle: tauri::AppHandle) -> Res<()> {
    updater::install(handle).await
}

/// Machine-local update preferences ({ auto }); stays out of profile sync.
#[tauri::command]
fn update_prefs(handle: tauri::AppHandle, app: State<'_, App>, auto: bool) -> Res<Value> {
    let configured = updater::configured(&handle);
    app.store.update(|doc| {
        doc["updates"]["auto"] = json!(auto);
        let mut u = doc["updates"].clone();
        u["available"] = json!(configured);
        Ok(u)
    })
}

/// Update preferences plus whether this build can update itself at all.
#[tauri::command]
fn update_status(handle: tauri::AppHandle, app: State<'_, App>) -> Value {
    let doc = app.store.app_state();
    json!({ "auto": doc["updates"]["auto"].as_bool().unwrap_or(true), "available": updater::configured(&handle) })
}

// ---------------------------------------------------------------- profile sync

#[tauri::command]
fn sync_targets() -> Vec<Value> {
    sync::targets()
}

/// Choose the sync folder ({ provider, dir, auto }) or switch sync off (provider "off").
#[tauri::command]
fn sync_config(app: State<'_, App>, provider: String, dir: Option<String>, auto: Option<bool>) -> Res<Value> {
    app.store.update(|doc| {
        if provider == "off" {
            doc["sync"] = json!({ "provider": "off" });
        } else {
            let dir = dir.filter(|d| !d.is_empty()).ok_or("Choose a folder")?;
            doc["sync"] = json!({ "provider": provider, "dir": dir, "auto": auto.unwrap_or(true) });
        }
        Ok(doc["sync"].clone())
    })
}

#[tauri::command]
async fn sync_now(app: State<'_, App>) -> Res<Value> {
    let store = app.store.clone();
    let r = tokio::task::spawn_blocking(move || sync::run(&store)).await.map_err(|e| e.to_string())?;
    if let Err(e) = &r {
        let msg = e.clone();
        let _ = app.store.update(|doc| { doc["sync"]["lastError"] = json!(msg); Ok(()) });
    }
    r
}

#[tauri::command]
async fn pick_sync_dir(handle: tauri::AppHandle) -> Res<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.dialog().file().set_title("Folder to sync zwoTrainer profiles through").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    Ok(Some(picked.into_path().map_err(|e| e.to_string())?.display().to_string()))
}

#[tauri::command]
fn delete_profile(app: State<'_, App>, id: String) -> Res<Value> {
    app.store.delete_profile(&id)
}

#[tauri::command]
fn switch_profile(app: State<'_, App>, id: String) -> Res<Value> {
    app.store.switch_profile(&id)
}

// ---------------------------------------------------------------- library

/// Scanning reads up to thousands of files: on a blocking thread, never on an async worker
/// (Bluetooth events and other commands run there).
#[tauri::command]
async fn scan_library(app: State<'_, App>) -> Res<library::Library> {
    let (root, cache) = (app.store.zwo_dir(), app.cache.clone());
    tokio::task::spawn_blocking(move || cache.scan(&root)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_workout(app: State<'_, App>, file: String) -> Res<library::LoadedWorkout> {
    let root = app.store.zwo_dir();
    tokio::task::spawn_blocking(move || library::load(&root, &file)).await.map_err(|e| e.to_string())?
}

/// Native folder picker; stores the choice in the active profile (None if cancelled).
#[tauri::command]
async fn pick_zwo_dir(handle: tauri::AppHandle, app: State<'_, App>) -> Res<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dlg = handle.dialog().file().set_title("Choose your ZWO workouts folder");
    let current = app.store.zwo_dir();
    if current.is_dir() {
        dlg = dlg.set_directory(current);
    }
    dlg.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path: PathBuf = picked.into_path().map_err(|e| e.to_string())?;
    app.store.set_setting("zwoDir", json!(path.display().to_string()))?;
    Ok(Some(path.display().to_string()))
}

// ---------------------------------------------------------------- library admin

/// Show a workout file or plan folder (library-relative path, "" = root) in Finder.
#[tauri::command]
fn reveal_in_library(handle: tauri::AppHandle, app: State<'_, App>, rel: String) -> Res<()> {
    let root = app.store.zwo_dir();
    let abs = if rel.is_empty() { root } else { library::inside_root(&root, &rel)? };
    if !abs.exists() {
        return Err(format!("{} no longer exists", abs.display()));
    }
    handle.opener().reveal_item_in_dir(&abs).map_err(|e| e.to_string())
}

/// Move a workout file or a whole plan folder to the macOS Trash (recoverable).
#[tauri::command]
fn trash_in_library(app: State<'_, App>, rel: String) -> Res<()> {
    if rel.trim().is_empty() {
        return Err("Refusing to delete the whole library".into());
    }
    let root = app.store.zwo_dir();
    let abs = library::inside_root(&root, &rel)?;
    let meta = std::fs::metadata(&abs).map_err(|e| format!("{rel}: {e}"))?;
    if meta.is_file() && !rel.to_ascii_lowercase().ends_with(".zwo") {
        return Err("Only .zwo files can be deleted here".into());
    }
    trash::delete(&abs).map_err(|e| format!("Could not move to Trash: {e}"))
}

// ---------------------------------------------------------------- activities

fn safe_name(s: &str) -> String {
    let n: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect();
    n.trim_matches('_').chars().take(60).collect()
}

/// First of `base`, `base-2`, `base-3`… for which no `dir/<stem><suffix>` exists yet.
fn free_stem(dir: &Path, base: &str, suffixes: &[&str]) -> String {
    let taken = |stem: &str| suffixes.iter().any(|x| dir.join(format!("{stem}{x}")).exists());
    if !taken(base) {
        return base.to_string();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|s| !taken(s)).unwrap_or_default()
}

/// Where `garmin_import` puts its copy: the same name again when that file already is this
/// ride (imported twice), otherwise the first free `-2`, `-3`… name; never another ride's file.
fn garmin_copy_path(folder: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let base = name.strip_suffix(".fit").unwrap_or(name);
    let same_or_free = |p: &PathBuf| !p.exists() || std::fs::read(p).is_ok_and(|b| b == bytes);
    std::iter::once(base.to_string())
        .chain((2..).map(|n| format!("{base}-{n}")))
        .map(|s| folder.join(format!("{s}.fit")))
        .find(same_or_free)
        .unwrap_or_else(|| folder.join(name))
}

/// Write a file completely or not at all: tmp file, fsync, rename (like `state::write_json`).
fn write_bytes(path: &Path, bytes: &[u8]) -> Res<()> {
    use std::io::Write;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("Invalid file name")?;
    // dot-prefixed, so FIT sync and folder listings never pick up a half-written file
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    res.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/// The ride file a command got from the UI: a `.fit` directly inside the active rider's
/// activities folder (where `save_activity` and sync put them), so a compromised page can't
/// export or upload any other readable file.
fn ride_file(app: &App, path: &str) -> Res<PathBuf> {
    in_activities(&app.store.activities_dir(&app.store.active_id()), Path::new(path))
}

fn in_activities(dir: &Path, path: &Path) -> Res<PathBuf> {
    let outside = || "This ride file isn't in the rider's activities folder".to_string();
    if path.extension().and_then(|e| e.to_str()) != Some("fit") {
        return Err(outside());
    }
    // resolved, so `..` and symlinks can't lead out
    let file = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    let dir = dir.canonicalize().map_err(|_| outside())?;
    if file.parent() == Some(dir.as_path()) { Ok(file) } else { Err(outside()) }
}

/// Encode a finished ride as FIT and store it with the profile: a generic file
/// (export) plus a Garmin-flavoured copy for Garmin Connect. Returns { path, garminPath, summary }.
#[tauri::command]
async fn save_activity(app: State<'_, App>, ride: fit::Ride) -> Res<Value> {
    let (bytes, summary) = fit::encode(&ride, fit::Flavor::Generic)?;
    let (garmin, _) = fit::encode(&ride, fit::Flavor::Garmin)?;
    let profile = app.store.active_id();
    let dir = app.store.activities_dir(&profile);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let start = state::iso_from_unix(ride.samples[0].wall / 1000);
    let base = format!("{}_{}", start[..16].replace([':', 'T'], "-"), safe_name(&ride.name));
    // two rides started in the same minute must not share (and overwrite) one file
    let stem = free_stem(&dir, &base, &[".fit", ".garmin.fit"]);
    let path = dir.join(format!("{stem}.fit"));
    let gpath = dir.join(format!("{stem}.garmin.fit"));
    write_bytes(&path, &bytes)?;
    write_bytes(&gpath, &garmin)?;
    Ok(json!({ "path": path.display().to_string(), "garminPath": gpath.display().to_string(), "summary": summary }))
}

/// Save a copy of a stored activity via the native save dialog.
#[tauri::command]
async fn export_activity(handle: tauri::AppHandle, app: State<'_, App>, path: String) -> Res<Option<String>> {
    let src = ride_file(&app, &path)?;
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("ride.fit").to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dlg = handle.dialog().file().set_file_name(&name).add_filter("FIT activity", &["fit"]);
    if let Some(d) = dirs::download_dir() {
        dlg = dlg.set_directory(d);
    }
    dlg.save_file(move |p| {
        let _ = tx.send(p);
    });
    let Some(p) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let dst = p.into_path().map_err(|e| e.to_string())?;
    std::fs::copy(&src, &dst).map_err(|e| format!("{}: {e}", src.display()))?;
    Ok(Some(dst.display().to_string()))
}

/// Garmin Connect offers no upload API to individuals. Copy the Garmin-flavoured FIT into
/// the rider's Garmin folder
/// (default: Downloads), reveal it in Finder and open Garmin Connect's import page.
#[tauri::command]
fn garmin_import(handle: tauri::AppHandle, app: State<'_, App>, path: String) -> Res<String> {
    let src = ride_file(&app, &path)?;
    let gsrc = src.with_extension("garmin.fit");
    let src = if gsrc.exists() { gsrc } else { src };
    let folder = app.store.active_profile()["settings"]["garmin"]["folder"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(state::expand)
        .or_else(dirs::download_dir)
        .ok_or("No folder for Garmin files")?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("ride.fit").replace(".garmin.fit", ".fit");
    let bytes = std::fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    let dst = garmin_copy_path(&folder, &name, &bytes);
    if !dst.exists() {
        write_bytes(&dst, &bytes)?;
    }
    let opener = handle.opener();
    let _ = opener.reveal_item_in_dir(&dst);
    opener
        .open_url("https://connect.garmin.com/modern/import-data", None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(dst.display().to_string())
}

/// Folder picker for the Garmin FIT copies.
#[tauri::command]
async fn pick_garmin_dir(handle: tauri::AppHandle, app: State<'_, App>) -> Res<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.dialog().file().set_title("Where should Garmin FIT files be saved?").pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?.display().to_string();
    let mut garmin = app.store.active_profile()["settings"]["garmin"].clone();
    if !garmin.is_object() {
        garmin = json!({});
    }
    garmin["folder"] = json!(path);
    app.store.set_setting("garmin", garmin)?;
    Ok(Some(path))
}

#[tauri::command]
fn open_url(handle: tauri::AppHandle, url: String) -> Res<()> {
    const ALLOWED: &[&str] = &["https://connect.garmin.com/", "https://intervals.icu/", "https://t.coros.com/", "https://www.strava.com/"];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("URL not allowed".into());
    }
    handle.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Open an http(s) link from a plan description in the default browser.
#[tauri::command]
fn open_link(handle: tauri::AppHandle, url: String) -> Res<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    handle.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- macOS app menu

#[cfg(target_os = "macos")]
const WEBSITE: &str = "https://steffenr.github.io/zwo-trainer/";
#[cfg(target_os = "macos")]
const SOURCE: &str = "https://github.com/steffenr/zwo-trainer";

/// Tauri's default macOS menu with the licence in "About zwoTrainer" and links to the
/// website and the source code in the Help menu.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, HELP_SUBMENU_ID};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let pkg = app.package_info();
        let about = PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata {
                name: Some(pkg.name.clone()),
                version: Some(pkg.version.to_string()),
                copyright: app.config().bundle.copyright.clone(),
                credits: Some("MIT License".into()),
                ..Default::default()
            }),
        )?;
        app_menu.remove_at(0)?;
        app_menu.insert(&about, 0)?;
    }
    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_SUBMENU_ID) {
        help.append(&MenuItem::with_id(app, "website", "zwoTrainer Website", true, None::<&str>)?)?;
        help.append(&MenuItem::with_id(app, "source", "Source Code on GitHub", true, None::<&str>)?)?;
    }
    Ok(menu)
}

// ---------------------------------------------------------------- other platforms

#[tauri::command]
fn services_status(app: State<'_, App>) -> Vec<Value> {
    let profile = app.store.active_id();
    services::status(|k| app.store.secret(&profile, k))
}

/// Connect Intervals.icu with the rider's personal API key.
#[tauri::command]
async fn service_connect(app: State<'_, App>, id: String, api_key: Option<String>) -> Res<Vec<Value>> {
    let s = services::get(&id)?;
    let profile = app.store.active_id();
    let rec = match s.kind {
        services::Kind::ApiKey => services::intervals_connect(api_key.as_deref().unwrap_or("")).await?,
        services::Kind::Manual => return Err(format!("{} has no account connection — use the manual import", s.name)),
    };
    app.store.set_secret(&profile, &services::secret_key(&id), rec)?;
    Ok(services_status(app))
}

#[tauri::command]
fn service_disconnect(app: State<'_, App>, id: String) -> Res<Vec<Value>> {
    services::get(&id)?;
    app.store.set_secret(&app.store.active_id(), &services::secret_key(&id), json!({}))?;
    Ok(services_status(app))
}

/// Upload a stored ride to a connected platform → { id, url }.
#[tauri::command]
async fn service_upload(app: State<'_, App>, id: String, path: String, name: String, description: String) -> Res<Value> {
    let s = services::get(&id)?;
    let profile = app.store.active_id();
    let rec = app.store.secret(&profile, &services::secret_key(&id));
    let file = ride_file(&app, &path)?;
    services::upload(s, &rec, &file, &name, &description).await
}

/// Manual route: put the FIT (COROS: a ZIP) into the export folder, show it in Finder and open
/// the platform's upload page for drag & drop.
#[tauri::command]
fn service_manual(handle: tauri::AppHandle, app: State<'_, App>, id: String, path: String) -> Res<String> {
    let s = services::get(&id)?;
    let url = s.manual_url.ok_or_else(|| format!("{} has no manual upload page", s.name))?;
    let folder = app.store.active_profile()["settings"]["garmin"]["folder"]
        .as_str()
        .filter(|f| !f.is_empty())
        .map(state::expand)
        .or_else(dirs::download_dir)
        .ok_or("No folder for ride files")?;
    let dst = services::prepare_manual(s, &ride_file(&app, &path)?, &folder)?;
    let opener = handle.opener();
    let _ = opener.reveal_item_in_dir(&dst);
    opener.open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(dst.display().to_string())
}

// ---------------------------------------------------------------- garmin

#[tauri::command]
fn garmin_status(app: State<'_, App>) -> Value {
    let s = app.store.secret(&app.store.active_id(), "garmin");
    json!({ "connected": s["oauth1"]["token"].is_string(), "name": s["displayName"] })
}

/// "Sign in to Garmin": Garmin's own login page in an app window; the service ticket it
/// returns is exchanged for a long-lived token stored for this rider only.
#[tauri::command]
async fn garmin_connect(handle: tauri::AppHandle, app: State<'_, App>) -> Res<Value> {
    let profile = app.store.active_id();
    if let Some(w) = handle.get_webview_window("garmin-login") {
        let _ = w.close();
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
    let tx_nav = tx.clone();
    let url: tauri::Url = garmin::signin_url().parse().map_err(|e| format!("{e:?}"))?;
    let win = tauri::WebviewWindowBuilder::new(&handle, "garmin-login", tauri::WebviewUrl::External(url))
        .title("Sign in to Garmin Connect")
        .inner_size(480.0, 720.0)
        .resizable(true)
        .initialization_script(garmin::TICKET_SCRIPT)
        .on_navigation(move |u| {
            if let Some(t) = garmin::ticket_from_url(u.as_str()) {
                if let Some(s) = tx_nav.lock().unwrap().take() {
                    let _ = s.send(Some(t));
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    let tx_close = tx.clone();
    win.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Destroyed) {
            if let Some(s) = tx_close.lock().unwrap().take() {
                let _ = s.send(None);
            }
        }
    });
    let ticket = tokio::time::timeout(Duration::from_secs(600), rx).await.map_err(|_| "Garmin sign-in timed out".to_string())?.map_err(|e| e.to_string())?;
    let _ = win.close();
    let ticket = ticket.ok_or("Garmin sign-in was cancelled")?;
    let rec = garmin::login_with_ticket(&ticket, state::unix_now()).await?;
    app.store.set_secret(&profile, "garmin", rec)?;
    Ok(garmin_status(app))
}

#[tauri::command]
fn garmin_disconnect(app: State<'_, App>) -> Res<Value> {
    app.store.set_secret(&app.store.active_id(), "garmin", json!({}))?;
    Ok(garmin_status(app))
}

/// Upload the Garmin-flavoured FIT of a ride; returns { activityId, url } (id may be null while Garmin processes).
#[tauri::command]
async fn garmin_upload(app: State<'_, App>, path: String, name: Option<String>, description: Option<String>, start: Option<i64>) -> Res<Value> {
    let src = ride_file(&app, &path)?;
    let profile = app.store.active_id();
    let mut rec = app.store.secret(&profile, "garmin");
    let before = rec["oauth2"].clone();
    let token = garmin::bearer(&mut rec, state::unix_now()).await?;
    if rec["oauth2"] != before {
        app.store.set_secret(&profile, "garmin", rec)?;
    }
    let gsrc = src.with_extension("garmin.fit");
    let file = if gsrc.exists() { gsrc } else { src };
    let mut id = garmin::upload(&token, &file).await?;
    // Name the activity after the workout (Garmin would call it "Indoor Cycling").
    let mut renamed = false;
    if let Some(name) = name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        if id.is_none() {
            if let Some(t) = start {
                id = garmin::find_by_start(&token, t).await;
            }
        }
        if let Some(i) = id {
            renamed = garmin::rename(&token, i, name, description.as_deref().unwrap_or("")).await.is_ok();
        }
    }
    Ok(json!({ "activityId": id, "renamed": renamed, "url": id.map(|i| format!("https://connect.garmin.com/modern/activity/{i}")).unwrap_or_else(|| "https://connect.garmin.com/modern/activities".into()) }))
}

// ---------------------------------------------------------------- system

/// Keep the display awake during a ride, released on stop or exit: `caffeinate` on macOS,
/// `systemd-inhibit` on Linux. (Windows uses the web Screen Wake Lock API in the UI.)
#[tauri::command]
fn keep_awake(app: State<'_, App>, on: bool) {
    let mut g = app.awake.lock().unwrap();
    if let Some(mut c) = g.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    #[cfg(target_os = "macos")]
    if on {
        *g = std::process::Command::new("caffeinate").args(["-di", "-w", &std::process::id().to_string()]).spawn().ok();
    }
    #[cfg(target_os = "linux")]
    if on {
        *g = std::process::Command::new("systemd-inhibit")
            .args(["--what=idle:sleep", "--who=zwoTrainer", "--why=Workout in progress", "--mode=block", "sleep", "infinity"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let _ = on;
}

// ---------------------------------------------------------------- bluetooth

#[tauri::command]
async fn ble_scan(app: State<'_, App>, kind: String, secs: Option<u64>) -> Res<Vec<ble::Found>> {
    app.ble.scan(ble::Kind::parse(&kind)?, secs.unwrap_or(4)).await
}

#[tauri::command]
async fn ble_connect(app: State<'_, App>, kind: String, id: String) -> Res<Value> {
    app.ble.connect(ble::Kind::parse(&kind)?, &id).await
}

#[tauri::command]
async fn ble_disconnect(app: State<'_, App>, kind: String) -> Res<()> {
    app.ble.disconnect(ble::Kind::parse(&kind)?).await;
    Ok(())
}

#[tauri::command]
async fn ble_current(app: State<'_, App>, kind: String) -> Res<Option<Value>> {
    Ok(app.ble.current(ble::Kind::parse(&kind)?).await)
}

#[tauri::command]
async fn trainer_set_power(app: State<'_, App>, watts: i32) -> Res<()> {
    app.ble.set_power(watts).await
}

#[tauri::command]
async fn trainer_free_ride(app: State<'_, App>) -> Res<()> {
    app.ble.free_ride().await
}

#[tauri::command]
async fn trainer_resume(app: State<'_, App>) -> Res<()> {
    app.ble.resume().await;
    Ok(())
}

// ---------------------------------------------------------------- compact ride window

#[tauri::command]
fn ride_window(window: tauri::WebviewWindow, pending: State<'_, ride_window::Pending>, compact: bool) -> Res<()> {
    pending.set(&window, compact)
}

// ---------------------------------------------------------------- virtual shifting controllers

#[tauri::command]
async fn ctrl_scan(app: State<'_, App>, secs: Option<u64>) -> Res<Vec<ble::Found>> {
    app.shifters.scan(secs.unwrap_or(4)).await
}

#[tauri::command]
async fn ctrl_connect(app: State<'_, App>, id: String) -> Res<Value> {
    app.shifters.connect(&id).await
}

#[tauri::command]
async fn ctrl_disconnect(app: State<'_, App>) -> Res<()> {
    app.shifters.disconnect_all().await;
    Ok(())
}

#[tauri::command]
async fn ctrl_list(app: State<'_, App>) -> Res<Vec<Value>> {
    Ok(app.shifters.connected().await)
}

// ---------------------------------------------------------------- entry

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let ble = ble::Ble::new(app.handle().clone());
            app.manage(App {
                store: Arc::new(state::Store::new(&data_dir)),
                cache: Arc::new(library::Cache::default()),
                shifters: shifter::Controllers::new(app.handle().clone(), ble.clone()),
                ble,
                awake: Mutex::new(None),
            });
            app.manage(updater::Pending::default());
            app.manage(ride_window::Pending::default());
            #[cfg(target_os = "macos")]
            {
                app.set_menu(app_menu(app.handle())?)?;
                app.on_menu_event(|app, event| {
                    let url = match event.id().as_ref() {
                        "website" => WEBSITE,
                        "source" => SOURCE,
                        _ => return,
                    };
                    let _ = app.opener().open_url(url, None::<&str>);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_state,
            save_profile,
            create_profile,
            rename_profile,
            edit_profile,
            sync_targets,
            sync_config,
            sync_now,
            pick_sync_dir,
            delete_profile,
            switch_profile,
            scan_library,
            load_workout,
            pick_zwo_dir,
            save_activity,
            reveal_in_library,
            trash_in_library,
            export_activity,
            garmin_import,
            pick_garmin_dir,
            open_url,
            open_link,
            services_status,
            service_connect,
            service_disconnect,
            service_upload,
            service_manual,
            garmin_status,
            garmin_connect,
            garmin_disconnect,
            garmin_upload,
            keep_awake,
            ride_window,
            ble_scan,
            ble_connect,
            ble_disconnect,
            ble_current,
            trainer_set_power,
            trainer_free_ride,
            trainer_resume,
            ctrl_scan,
            ctrl_connect,
            ctrl_disconnect,
            ctrl_list,
            update_check,
            update_install,
            update_prefs,
            update_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building zwoTrainer")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(app) = handle.try_state::<App>() {
                    if let Some(mut c) = app.awake.lock().unwrap().take() {
                        let _ = c.kill();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ride_files_stay_in_the_activities_folder() {
        let root = std::env::temp_dir().join(format!("zt-ridefile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("activities").join("p_1");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for f in [dir.join("ride.fit"), dir.join("notes.txt"), dir.join("sub/deep.fit"), root.join("other.fit")] {
            std::fs::write(f, b"x").unwrap();
        }
        assert_eq!(in_activities(&dir, &dir.join("ride.fit")).unwrap(), dir.join("ride.fit").canonicalize().unwrap());
        assert!(in_activities(&dir, &root.join("other.fit")).is_err(), "outside");
        assert!(in_activities(&dir, &dir.join("../../other.fit")).is_err(), "`..` out of the folder");
        assert!(in_activities(&dir, &dir.join("notes.txt")).is_err(), "not a FIT file");
        assert!(in_activities(&dir, &dir.join("sub/deep.fit")).is_err(), "only the folder itself");
        assert!(in_activities(&dir, &dir.join("missing.fit")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn activity_names_never_collide() {
        let dir = std::env::temp_dir().join(format!("zt-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sfx = [".fit", ".garmin.fit"];
        let base = "2026-11-19-10-00_Ride";
        assert_eq!(free_stem(&dir, base, &sfx), base);
        write_bytes(&dir.join(format!("{base}.fit")), b"one").unwrap();
        assert_eq!(free_stem(&dir, base, &sfx), format!("{base}-2"));
        // a lone Garmin copy blocks the name too
        write_bytes(&dir.join(format!("{base}-2.garmin.fit")), b"two").unwrap();
        assert_eq!(free_stem(&dir, base, &sfx), format!("{base}-3"));
        assert_eq!(std::fs::read(dir.join(format!("{base}.fit"))).unwrap(), b"one");
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        // Garmin folder: the same ride again reuses its file, a different ride gets a new name
        assert_eq!(garmin_copy_path(&dir, &format!("{base}.fit"), b"one"), dir.join(format!("{base}.fit")));
        assert_eq!(garmin_copy_path(&dir, &format!("{base}.fit"), b"other"), dir.join(format!("{base}-2.fit")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Parse every .zwo below $ZWO_TEST_DIR (if set) — used to validate against a real library.
    #[test]
    fn scan_real_library() {
        let Ok(dir) = std::env::var("ZWO_TEST_DIR") else { return };
        let cache = library::Cache::default();
        let t = std::time::Instant::now();
        let lib = cache.scan(std::path::Path::new(&dir));
        let n: usize = lib.plans.iter().map(|p| p.count).sum::<usize>() + lib.singles.len();
        eprintln!("{} plans, {} workouts in {:?}", lib.plans.len(), n, t.elapsed());
        assert!(n > 0);
        for p in &lib.plans {
            for w in &p.workouts {
                assert!(w.duration > 0, "{} has zero duration", w.file);
            }
        }
        if let Ok(out) = std::env::var("ZWO_TEST_DUMP") {
            std::fs::write(out, serde_json::to_string(&lib).unwrap()).unwrap();
        }
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("HIT 80% FTP #1"), "HIT_80__FTP__1");
    }
}
