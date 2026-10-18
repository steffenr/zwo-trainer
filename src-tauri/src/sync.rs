//! Profile sync through a cloud-synced folder: iCloud Drive, Dropbox or Nextcloud (their desktop
//! clients keep a local folder in sync, so zwoTrainer only reads and writes plain files there —
//! no accounts, API keys or tokens).
//!
//! Layout inside the chosen folder:
//!   zwoTrainer/profiles/<profileId>.json   { format: 1, updatedAt, deleted?, profile }
//!   zwoTrainer/activities/<profileId>/*.fit
//!
//! Rules (predictable, never "resurrects" what you deleted):
//!  - the newer copy of a profile (updatedAt) wins for everything it owns: name, avatar,
//!    rider settings, plan progress, favorites;
//!  - ride history and FTP tests are append-only logs and are merged from both sides;
//!  - machine-specific settings stay local: paired devices, workouts folder, Garmin FIT folder;
//!  - a deleted profile leaves a tombstone, so it is removed on the other Macs too;
//!  - secrets (Garmin session) are never synced — sign in once per Mac.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::state::{self, Store};

pub const FORMAT: u32 = 1;

/// Known cloud folders on this computer: [{ provider, label, path, found }].
/// macOS: iCloud Drive and File Provider folders under ~/Library/CloudStorage;
/// Windows: ~/iCloudDrive (iCloud for Windows); everywhere: ~/Dropbox and ~/Nextcloud.
pub fn targets() -> Vec<Value> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let cloud = home.join("Library/CloudStorage");
    let in_cloud = |prefix: &str| -> Option<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(&cloud)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix)))
            .collect();
        v.sort();
        v.into_iter().next()
    };
    let pick = |cands: Vec<Option<PathBuf>>| cands.into_iter().flatten().find(|p| p.is_dir());
    let icloud = pick(vec![Some(home.join("Library/Mobile Documents/com~apple~CloudDocs")), Some(home.join("iCloudDrive"))]);
    let dropbox = pick(vec![in_cloud("Dropbox"), Some(home.join("Dropbox"))]);
    let nextcloud = pick(vec![in_cloud("Nextcloud"), Some(home.join("Nextcloud"))]);
    [("icloud", "iCloud Drive", icloud), ("dropbox", "Dropbox", dropbox), ("nextcloud", "Nextcloud", nextcloud)]
        .into_iter()
        .map(|(id, label, p)| json!({ "provider": id, "label": label, "path": p.as_ref().map(|p| p.display().to_string()), "found": p.is_some() }))
        .collect()
}

fn root(dir: &Path) -> PathBuf {
    dir.join("zwoTrainer")
}

/// Settings that belong to this computer, not to the rider.
fn strip_local(p: &Value) -> Value {
    let mut p = p.clone();
    if let Some(s) = p["settings"].as_object_mut() {
        s.remove("devices");
        s.remove("zwoDir");
        if let Some(g) = s.get_mut("garmin").and_then(Value::as_object_mut) {
            g.remove("folder");
        }
    }
    p
}

/// Copy this Mac's local settings from `local` into `p`.
fn keep_local(p: &mut Value, local: &Value) {
    for k in ["devices", "zwoDir"] {
        if let Some(v) = local["settings"].get(k) {
            p["settings"][k] = v.clone();
        }
    }
    if let Some(f) = local["settings"]["garmin"].get("folder") {
        if p["settings"]["garmin"].is_object() {
            p["settings"]["garmin"]["folder"] = f.clone();
        }
    }
}

fn ts(p: &Value) -> &str {
    p["updatedAt"].as_str().or_else(|| p["createdAt"].as_str()).unwrap_or("")
}

/// Merge an append-only log (history / tests) from both sides; `newer` wins for identical keys.
fn union_log(newer: &Value, older: &Value, key: impl Fn(&Value) -> String, cap: usize) -> Value {
    let mut m: BTreeMap<String, Value> = BTreeMap::new();
    for e in older.as_array().into_iter().flatten().chain(newer.as_array().into_iter().flatten()) {
        m.insert(key(e), e.clone());
    }
    let mut v: Vec<Value> = m.into_values().collect();
    v.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    v.truncate(cap);
    Value::Array(v)
}

/// Merge two copies of the same profile (see module docs). `local` keeps its machine settings.
pub fn merge(local: &Value, remote: &Value) -> Value {
    let remote_newer = ts(remote) > ts(local);
    let (newer, older) = if remote_newer { (remote, local) } else { (local, remote) };
    let mut out = newer.clone();
    keep_local(&mut out, local);
    let hk = |e: &Value| format!("{}|{}", e["at"].as_str().unwrap_or(""), e["file"].as_str().unwrap_or(""));
    out["history"] = union_log(&newer["history"], &older["history"], hk, 1000);
    out["tests"] = union_log(&newer["tests"], &older["tests"], |e| e["at"].as_str().unwrap_or("").to_string(), 200);
    out["updatedAt"] = json!(ts(newer));
    out
}

/// Point *Path fields of history entries at this Mac's activities folder.
fn relocate_paths(p: &mut Value, act_dir: &Path) {
    for e in p["history"].as_array_mut().into_iter().flatten() {
        if let Some(o) = e.as_object_mut() {
            for (k, v) in o.iter_mut() {
                if !k.ends_with("Path") {
                    continue;
                }
                if let Some(name) = v.as_str().and_then(|s| Path::new(s).file_name()).map(|n| n.to_owned()) {
                    *v = json!(act_dir.join(name).display().to_string());
                }
            }
        }
    }
}

/// Copy .fit files that exist on one side only.
fn sync_files(a: &Path, b: &Path) -> (u32, u32) {
    let list = |d: &Path| -> Vec<String> {
        std::fs::read_dir(d).into_iter().flatten().flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).filter(|n| n.ends_with(".fit")).collect()
    };
    let (la, lb) = (list(a), list(b));
    let mut n = (0, 0);
    for f in la.iter().filter(|f| !lb.contains(f)) {
        if std::fs::create_dir_all(b).is_ok() && std::fs::copy(a.join(f), b.join(f)).is_ok() {
            n.0 += 1;
        }
    }
    for f in lb.iter().filter(|f| !la.contains(f)) {
        if std::fs::create_dir_all(a).is_ok() && std::fs::copy(b.join(f), a.join(f)).is_ok() {
            n.1 += 1;
        }
    }
    n
}

/// iCloud keeps files it hasn't downloaded yet as ".<name>.icloud" placeholders.
fn request_icloud_downloads(dir: &Path) -> u32 {
    let mut n = 0;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name.ends_with(".icloud") {
            n += 1;
            #[cfg(target_os = "macos")]
            let _ = std::process::Command::new("brctl").arg("download").arg(e.path()).spawn();
        }
    }
    n
}

/// Run one sync against the configured folder. Returns { changed, pulled, pushed, files, pending, at }.
pub fn run(store: &Store) -> Result<Value, String> {
    store.update(|doc| {
        let dir = doc["sync"]["dir"].as_str().filter(|s| !s.is_empty()).map(state::expand).ok_or("No sync folder chosen")?;
        if !dir.is_dir() {
            return Err(format!("Sync folder not found: {}", dir.display()));
        }
        let pdir = root(&dir).join("profiles");
        std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
        let pending = request_icloud_downloads(&pdir);

        let mut remote: BTreeMap<String, Value> = BTreeMap::new();
        for e in std::fs::read_dir(&pdir).map_err(|e| e.to_string())?.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            if let Some(v) = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                remote.insert(id, v);
            }
        }
        // First sync on this Mac and the folder already has riders: drop untouched default
        // profiles here, so a fresh install doesn't add a second "Rider 1" everywhere.
        let has_remote = remote.values().any(|r| r["profile"].is_object());
        if doc["sync"]["lastSync"].is_null() && has_remote {
            let pristine: Vec<String> = doc["profiles"].as_object().unwrap().iter()
                .filter(|(id, p)| !remote.contains_key(*id) && is_pristine(p))
                .map(|(id, _)| id.clone()).collect();
            for id in pristine {
                doc["profiles"].as_object_mut().unwrap().remove(&id);
            }
        }
        let tomb = doc["tombstones"].clone();
        let mut ids: Vec<String> = remote.keys().cloned().collect();
        ids.extend(doc["profiles"].as_object().unwrap().keys().cloned());
        ids.extend(tomb.as_object().into_iter().flat_map(|o| o.keys().cloned()));
        ids.sort();
        ids.dedup();

        let (mut pulled, mut pushed, mut changed) = (0, 0, false);
        let write_remote = |id: &str, v: Value| state::write_json(&pdir.join(format!("{id}.json")), &v, false);
        let template = doc["profiles"][doc["activeProfile"].as_str().unwrap_or_default()].clone();

        for id in ids {
            let r = remote.get(&id);
            let r_deleted = r.is_some_and(|r| r["deleted"].as_bool() == Some(true));
            let local = doc["profiles"].get(&id).cloned();

            if let Some(at) = tomb.get(&id).and_then(Value::as_str) {
                if !r_deleted {
                    write_remote(&id, json!({ "format": FORMAT, "updatedAt": at, "deleted": true }))?;
                    pushed += 1;
                }
                continue;
            }
            if r_deleted {
                let del_at = r.unwrap()["updatedAt"].as_str().unwrap_or("");
                if let Some(l) = &local {
                    if ts(l) <= del_at && doc["profiles"].as_object().unwrap().len() > 1 {
                        doc["profiles"].as_object_mut().unwrap().remove(&id);
                        if !doc["tombstones"].is_object() {
                            doc["tombstones"] = json!({});
                        }
                        doc["tombstones"][&id] = json!(del_at);
                        if doc["activeProfile"].as_str() == Some(id.as_str()) {
                            let first = doc["profiles"].as_object().unwrap().keys().next().cloned().unwrap();
                            doc["activeProfile"] = json!(first);
                        }
                        changed = true;
                    }
                }
                continue;
            }
            let act_local = store.activities_dir(&id);
            let rp = r.map(|r| r["profile"].clone()).filter(Value::is_object);
            match (local, rp) {
                (Some(l), None) => {
                    write_remote(&id, json!({ "format": FORMAT, "updatedAt": ts(&l), "profile": strip_local(&l) }))?;
                    pushed += 1;
                }
                (None, Some(mut p)) => {
                    state::normalize_profile(&mut p, &id);
                    keep_local(&mut p, &template);
                    relocate_paths(&mut p, &act_local);
                    doc["profiles"][&id] = p;
                    pulled += 1;
                    changed = true;
                }
                (Some(l), Some(rp)) => {
                    let mut m = merge(&l, &rp);
                    relocate_paths(&mut m, &act_local);
                    state::normalize_profile(&mut m, &id);
                    if m != l {
                        doc["profiles"][&id] = m.clone();
                        pulled += 1;
                        changed = true;
                    }
                    let stripped = strip_local(&m);
                    if strip_paths(&stripped) != strip_paths(&strip_local(&rp)) {
                        write_remote(&id, json!({ "format": FORMAT, "updatedAt": ts(&m), "profile": stripped }))?;
                        pushed += 1;
                    }
                }
                (None, None) => {}
            }
        }

        let active_ok = doc["activeProfile"].as_str().is_some_and(|a| doc["profiles"].get(a).is_some());
        if !active_ok {
            let first = doc["profiles"].as_object().unwrap().keys().next().cloned().ok_or("no profiles")?;
            doc["activeProfile"] = json!(first);
            changed = true;
        }

        // ride files (FIT) for every remaining profile
        let mut files = (0, 0);
        for id in doc["profiles"].as_object().unwrap().keys() {
            let (a, b) = sync_files(&store.activities_dir(id), &root(&dir).join("activities").join(id));
            files.0 += a;
            files.1 += b;
        }
        let at = state::now_iso();
        doc["sync"]["lastSync"] = json!(at);
        doc["sync"]["lastError"] = Value::Null;
        Ok(json!({ "changed": changed, "pulled": pulled, "pushed": pushed, "filesUp": files.0, "filesDown": files.1, "pending": pending, "at": at, "app": Store::summary(doc) }))
    })
}

/// A profile nobody has used yet (fresh install).
fn is_pristine(p: &Value) -> bool {
    let empty = |k: &str| p[k].as_array().is_none_or(|a| a.is_empty()) && p[k].as_object().is_none_or(|o| o.is_empty());
    empty("history") && empty("tests") && empty("plans") && empty("favorites") && p["settings"]["ftp"] == json!(250)
}

/// History paths differ per Mac; compare without them.
fn strip_paths(p: &Value) -> Value {
    let mut p = p.clone();
    for e in p["history"].as_array_mut().into_iter().flatten() {
        if let Some(o) = e.as_object_mut() {
            o.retain(|k, _| !k.ends_with("Path"));
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prof(name: &str, at: &str, hist: &[&str]) -> Value {
        json!({ "id": "p1", "name": name, "updatedAt": at,
            "settings": { "ftp": 250, "devices": { "trainer": { "id": "x" } }, "zwoDir": "/mine" },
            "history": hist.iter().map(|h| json!({ "at": h, "file": "a.zwo" })).collect::<Vec<_>>(), "tests": [] })
    }

    #[test]
    fn newer_wins_history_unions_local_kept() {
        let mut local = prof("Me", "2026-10-01T10:00:00Z", &["2026-09-01T00:00:00Z"]);
        let mut remote = prof("Me renamed", "2026-10-02T10:00:00Z", &["2026-09-05T00:00:00Z"]);
        remote["settings"]["zwoDir"] = json!("/theirs");
        remote["settings"]["devices"] = json!({});
        local["settings"]["ftp"] = json!(240);
        let m = merge(&local, &remote);
        assert_eq!(m["name"], "Me renamed");
        assert_eq!(m["settings"]["ftp"], 250);
        assert_eq!(m["settings"]["zwoDir"], "/mine");
        assert_eq!(m["settings"]["devices"]["trainer"]["id"], "x");
        assert_eq!(m["history"].as_array().unwrap().len(), 2);
        assert_eq!(m["history"][0]["at"], "2026-09-05T00:00:00Z");
    }

    #[test]
    fn two_stores_sync_through_a_folder() {
        let base = std::env::temp_dir().join(format!("zt-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cloud = base.join("cloud");
        std::fs::create_dir_all(&cloud).unwrap();
        let a = Store::new(&base.join("a"));
        let b = Store::new(&base.join("b"));
        for s in [&a, &b] {
            s.update(|d| { d["sync"] = json!({ "dir": cloud.display().to_string() }); Ok(()) }).unwrap();
        }
        // A: set FTP, create Anna; sync up
        let mut p = a.active_profile();
        p["settings"]["ftp"] = json!(301);
        a.save_profile(p).unwrap();
        let anna = a.create_profile("Anna").unwrap()["activeProfile"].as_str().unwrap().to_string();
        let r = run(&a).unwrap();
        assert_eq!(r["pushed"], 2);
        // B pulls both riders
        let r = run(&b).unwrap();
        assert_eq!(r["pulled"], 2);
        let app = b.app_state();
        assert_eq!(app["profiles"].as_array().unwrap().len(), 2); // B's untouched default was replaced
        assert!(b.active_profile()["settings"]["ftp"].as_i64().is_some());
        // A deletes Anna → B loses her after the next round trip
        a.delete_profile(&anna).unwrap();
        run(&a).unwrap();
        run(&b).unwrap();
        assert!(b.app_state()["profiles"].as_array().unwrap().iter().all(|p| p["id"] != anna));
        let _ = std::fs::remove_dir_all(&base);
    }
}
