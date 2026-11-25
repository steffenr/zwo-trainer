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
//!    rider settings, favorites;
//!  - ride history and FTP tests are append-only logs and are merged from both sides;
//!  - what a ride or test produced on one Mac survives a later, unrelated save on the other:
//!    plan progress is merged per workout (the later `at` wins), personal bests per duration
//!    (the higher one), and the FTP of an applied test newer than the other side's applied test
//!    wins over the newer profile's FTP. (Unmarking a workout as done can come back from the
//!    other Mac this way; losing a ridden workout would be worse.)
//!  - machine-specific settings stay local: paired devices, workouts folder, Garmin FIT folder;
//!  - a deleted profile leaves a tombstone, so it is removed on the other Macs too;
//!  - secrets (Garmin session) are never synced — sign in once per Mac.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
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
/// Newest first, at most `cap` entries (`None`: all of them).
fn union_log(newer: &Value, older: &Value, key: impl Fn(&Value) -> String, cap: Option<usize>) -> Value {
    let mut m: BTreeMap<String, Value> = BTreeMap::new();
    for e in older.as_array().into_iter().flatten().chain(newer.as_array().into_iter().flatten()) {
        m.insert(key(e), e.clone());
    }
    let mut v: Vec<Value> = m.into_values().collect();
    v.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    if let Some(cap) = cap {
        v.truncate(cap);
    }
    Value::Array(v)
}

/// Plans of both sides; per workout entry the one with the later `at`.
fn merge_plans(newer: &Value, older: &Value) -> Value {
    let mut out = newer.as_object().cloned().unwrap_or_default();
    for (folder, op) in older.as_object().into_iter().flatten() {
        let Some(np) = out.get_mut(folder).filter(|p| p.is_object()) else {
            out.insert(folder.clone(), op.clone());
            continue;
        };
        let mut entries = np["entries"].as_object().cloned().unwrap_or_default();
        for (file, oe) in op["entries"].as_object().into_iter().flatten() {
            let at = |e: &Value| e["at"].as_str().unwrap_or("").to_string();
            if entries.get(file).is_none_or(|ne| at(ne) < at(oe)) {
                entries.insert(file.clone(), oe.clone());
            }
        }
        np["entries"] = Value::Object(entries);
    }
    Value::Object(out)
}

/// Personal bests of both sides: the higher value per duration.
fn merge_bests(newer: &Value, older: &Value) -> Value {
    let mut out = newer.as_object().cloned().unwrap_or_default();
    for (k, ov) in older.as_object().into_iter().flatten() {
        if out.get(k).and_then(Value::as_f64).is_none_or(|nv| ov.as_f64().is_some_and(|o| o > nv)) {
            out.insert(k.clone(), ov.clone());
        }
    }
    Value::Object(out)
}

/// `at` of the test a profile applied as its FTP (`accepted`), if its FTP still is that test's.
fn applied_test(p: &Value) -> Option<&str> {
    p["tests"].as_array()?.iter().find(|t| t["accepted"] == json!(true) && t["ftp"] == p["settings"]["ftp"])?["at"].as_str()
}

/// Merge two copies of the same profile (see module docs). `local` keeps its machine settings.
pub fn merge(local: &Value, remote: &Value) -> Value {
    let remote_newer = ts(remote) > ts(local);
    let (newer, older) = if remote_newer { (remote, local) } else { (local, remote) };
    let mut out = newer.clone();
    keep_local(&mut out, local);
    let hk = |e: &Value| format!("{}|{}", e["at"].as_str().unwrap_or(""), e["file"].as_str().unwrap_or(""));
    // every ride is kept: a ride's FIT file outlives a capped list, and old rides are the rider's
    out["history"] = union_log(&newer["history"], &older["history"], hk, None);
    out["tests"] = union_log(&newer["tests"], &older["tests"], |e| e["at"].as_str().unwrap_or("").to_string(), Some(200));
    if older["plans"].is_object() {
        out["plans"] = merge_plans(&newer["plans"], &older["plans"]);
    }
    if older["settings"]["bests"].is_object() && out["settings"].is_object() {
        out["settings"]["bests"] = merge_bests(&newer["settings"]["bests"], &older["settings"]["bests"]);
    }
    // A test the newer side hasn't seen yet, applied after the newer side's own applied test,
    // brings its FTP along. A test it has seen was already superseded there (e.g. by hand).
    let seen = |at: &str| newer["tests"].as_array().into_iter().flatten().any(|t| t["at"].as_str() == Some(at));
    if let Some(at) = applied_test(older).filter(|a| !seen(a) && applied_test(newer).is_none_or(|n| n < *a)) {
        if out["settings"].is_object() {
            out["settings"]["ftp"] = older["settings"]["ftp"].clone();
        }
        // only that test stays marked as applied
        for t in out["tests"].as_array_mut().into_iter().flatten() {
            t["accepted"] = json!(t["at"].as_str() == Some(at));
        }
    }
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

/// A FIT file is at most this big; anything larger in a sync folder is not a ride of ours.
const MAX_FIT_BYTES: u64 = 100 * 1024 * 1024;

/// Does this look like a FIT file? The FIT SDK puts the ".FIT" tag at bytes 8–11 of the header.
/// A sync folder is shared with other apps (and with whoever else can write to it), so only real
/// ride files are copied out of it — never whatever else was dropped there.
fn is_fit_file(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() || !(12..=MAX_FIT_BYTES).contains(&meta.len()) {
        return false;
    }
    let mut header = [0u8; 12];
    std::fs::File::open(path).ok().and_then(|mut f| f.read_exact(&mut header).ok()).is_some_and(|()| &header[8..12] == b".FIT")
}

/// Copy .fit files that exist on one side only.
fn sync_files(a: &Path, b: &Path) -> (u32, u32) {
    let list = |d: &Path| -> Vec<String> {
        std::fs::read_dir(d)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|n| n.ends_with(".fit") && is_fit_file(&d.join(n)))
            .collect()
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

/// Profile id of an iCloud placeholder for one of our files (".p_x.json.icloud").
fn placeholder_id(name: &str) -> Option<&str> {
    name.strip_prefix('.')?.strip_suffix(".json.icloud").filter(|id| state::is_profile_id(id))
}

/// Run one sync against the configured folder.
/// Returns { changed, pulled, pushed, filesUp, filesDown, pending, skipped, at, app }:
/// `pending` = iCloud placeholders still downloading, `skipped` = riders left alone this run
/// because their remote file isn't readable yet.
/// One sync at a time (auto sync and "Sync now" can overlap).
static RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Profile files in the sync folder: readable ones by id, plus the ids whose copy exists but
/// can't be used in this run (iCloud placeholder not downloaded yet, unreadable or not a
/// profile file); those are never pushed over or deleted.
fn read_remote(pdir: &Path) -> Result<(BTreeMap<String, Value>, BTreeSet<String>), String> {
    let mut remote: BTreeMap<String, Value> = BTreeMap::new();
    let mut blocked: BTreeSet<String> = BTreeSet::new();
    for e in std::fs::read_dir(pdir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(id) = placeholder_id(&name) {
            blocked.insert(id.to_string());
            continue;
        }
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        // only our own file names: skips "p_x (conflicted copy).json", "p_x 2.json", "...json"
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|s| state::is_profile_id(s)).map(str::to_string) else { continue };
        match std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            Some(v) if v["profile"].is_object() || v["deleted"].as_bool() == Some(true) => {
                remote.insert(id, v);
            }
            _ => {
                blocked.insert(id);
            }
        }
    }
    // a readable copy wins over a stale placeholder of the same file
    blocked.retain(|id| !remote.contains_key(id));
    Ok((remote, blocked))
}

/// Sync in three steps, so the store lock (which every command needs) is held only for the
/// merge itself, never during cloud-folder I/O: read the folder, merge into state.json under
/// the lock, then write the profile files and copy FIT files.
pub fn run(store: &Store) -> Result<Value, String> {
    let _one = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let dir = store.read(|doc| doc["sync"]["dir"].as_str().filter(|s| !s.is_empty()).map(state::expand))?.ok_or("No sync folder chosen")?;
    if !dir.is_dir() {
        return Err(format!("Sync folder not found: {}", dir.display()));
    }
    let pdir = root(&dir).join("profiles");
    std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
    let pending = request_icloud_downloads(&pdir);
    let (remote, blocked) = read_remote(&pdir)?;

    let (writes, ids, mut out) = store.update(|doc| {
        let first_sync = doc["sync"]["lastSync"].is_null();
        // First sync on this Mac and the folder already has riders: drop untouched default
        // profiles here, so a fresh install doesn't add a second "Rider 1" everywhere.
        let has_remote = remote.values().any(|r| r["profile"].is_object());
        // While riders may still be downloading, a pristine default is neither pushed nor
        // dropped; the next sync (still a "first" one) decides once the files are here.
        let hold_pristine = first_sync && (pending > 0 || !blocked.is_empty());
        if first_sync && has_remote {
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

        let (mut pulled, mut changed) = (0, false);
        // profile files to write once the lock is released
        let mut writes: Vec<(String, Value)> = vec![];
        let template = doc["profiles"][doc["activeProfile"].as_str().unwrap_or_default()].clone();

        for id in ids {
            let r = remote.get(&id);
            let r_deleted = r.is_some_and(|r| r["deleted"].as_bool() == Some(true));
            let local = doc["profiles"].get(&id).cloned();
            if blocked.contains(&id) {
                continue; // its remote copy may be newer: decide when it can be read
            }

            if let Some(at) = tomb.get(&id).and_then(Value::as_str) {
                if !r_deleted {
                    writes.push((id.clone(), json!({ "format": FORMAT, "updatedAt": at, "deleted": true })));
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
                    if hold_pristine && is_pristine(&l) {
                        continue;
                    }
                    writes.push((id.clone(), json!({ "format": FORMAT, "updatedAt": ts(&l), "profile": strip_local(&l) })));
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
                        writes.push((id.clone(), json!({ "format": FORMAT, "updatedAt": ts(&m), "profile": stripped })));
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

        let at = state::now_iso();
        // a first sync that couldn't see every rider yet stays "first", so the next run can
        // still replace an untouched default with the riders from the folder
        if !hold_pristine {
            doc["sync"]["lastSync"] = json!(at);
        }
        doc["sync"]["lastError"] = Value::Null;
        let ids: Vec<String> = doc["profiles"].as_object().unwrap().keys().cloned().collect();
        let out = json!({ "changed": changed, "pulled": pulled, "pending": pending, "skipped": blocked.len(), "at": at, "app": Store::summary(doc) });
        Ok((writes, ids, out))
    })?;

    for (id, v) in &writes {
        state::write_json(&pdir.join(format!("{id}.json")), v, false)?;
    }
    // ride files (FIT) for every remaining profile
    let mut files = (0, 0);
    for id in &ids {
        let (a, b) = sync_files(&store.activities_dir(id), &root(&dir).join("activities").join(id));
        files.0 += a;
        files.1 += b;
    }
    out["pushed"] = json!(writes.len());
    out["filesUp"] = json!(files.0);
    out["filesDown"] = json!(files.1);
    Ok(out)
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
    fn long_histories_are_kept_whole() {
        let at = |i: usize| format!("2020-01-01T00:{:02}:{:02}Z", i / 60, i % 60);
        let side = |r: std::ops::Range<usize>| r.map(at).collect::<Vec<_>>();
        let (a, b) = (side(0..900), side(900..1800));
        let m = merge(&prof("Me", "2026-01-02T00:00:00Z", &a.iter().map(String::as_str).collect::<Vec<_>>()),
                      &prof("Me", "2026-01-01T00:00:00Z", &b.iter().map(String::as_str).collect::<Vec<_>>()));
        assert_eq!(m["history"].as_array().unwrap().len(), 1800, "no ride dropped above 1000");
    }

    #[test]
    fn ride_results_survive_a_later_save_elsewhere() {
        // Mac A: rode plan day 2, a new 20-min best, applied an FTP test (all at 10:00)
        let mut a = prof("Me", "2026-11-01T10:00:00Z", &[]);
        a["settings"]["ftp"] = json!(262);
        a["settings"]["bests"] = json!({ "m20": 275, "s5": 900 });
        a["tests"] = json!([{ "at": "2026-11-01T09:00:00Z", "ftp": 262, "accepted": true },
                            { "at": "2026-10-01T09:00:00Z", "ftp": 250, "accepted": false }]);
        a["plans"] = json!({ "base": { "startedAt": "s", "entries": {
            "d1.zwo": { "status": "done", "at": "2026-10-30T10:00:00Z" },
            "d2.zwo": { "status": "done", "at": "2026-11-01T10:00:00Z" } } } });
        // Mac B, not synced since day 1: changed the theme at 11:00 (newer profile)
        let mut b = prof("Me", "2026-11-01T11:00:00Z", &[]);
        b["settings"]["theme"] = json!("dark");
        b["settings"]["bests"] = json!({ "m20": 268, "s5": 950 });
        b["tests"] = json!([{ "at": "2026-10-01T09:00:00Z", "ftp": 250, "accepted": true }]);
        b["plans"] = json!({ "base": { "startedAt": "s", "entries": {
            "d1.zwo": { "status": "done", "at": "2026-10-30T10:00:00Z" } } },
            "other": { "entries": { "x.zwo": { "status": "skipped", "at": "2026-10-31T10:00:00Z" } } } });
        for m in [merge(&a, &b), merge(&b, &a)] {
            assert_eq!(m["settings"]["theme"], "dark", "the newer save still wins");
            assert_eq!(m["settings"]["ftp"], 262, "FTP of the newer applied test");
            let applied: Vec<_> = m["tests"].as_array().unwrap().iter().filter(|t| t["accepted"] == true).map(|t| t["at"].clone()).collect();
            assert_eq!(applied, vec![json!("2026-11-01T09:00:00Z")], "one applied test");
            assert_eq!(m["settings"]["bests"], json!({ "m20": 275, "s5": 950 }), "higher best per duration");
            assert_eq!(m["plans"]["base"]["entries"]["d2.zwo"]["status"], "done", "day 2 kept");
            assert_eq!(m["plans"]["other"]["entries"]["x.zwo"]["status"], "skipped", "plans of both sides");
        }
        // a later entry for the same workout wins
        let mut c = b.clone();
        c["plans"]["base"]["entries"]["d2.zwo"] = json!({ "status": "skipped", "at": "2026-11-02T10:00:00Z" });
        assert_eq!(merge(&a, &c)["plans"]["base"]["entries"]["d2.zwo"]["status"], "skipped");
        // an FTP typed in by hand on the newer side (no applied test behind it) is kept unless
        // the other side applied a test
        let mut d = prof("Me", "2026-11-03T10:00:00Z", &[]);
        d["settings"]["ftp"] = json!(255);
        assert_eq!(merge(&d, &prof("Me", "2026-11-01T10:00:00Z", &[]))["settings"]["ftp"], 255);
        // … also when the other side still has an applied test this side already knew
        d["tests"] = a["tests"].clone();
        assert_eq!(merge(&d, &a)["settings"]["ftp"], 255, "typed in after seeing that test");
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

    #[test]
    fn foreign_file_names_are_ignored() {
        let base = std::env::temp_dir().join(format!("zt-sync-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cloud = base.join("cloud");
        std::fs::create_dir_all(&cloud).unwrap();
        let a = Store::new(&base.join("a"));
        let b = Store::new(&base.join("b"));
        for s in [&a, &b] {
            s.update(|d| { d["sync"] = json!({ "dir": cloud.display().to_string() }); Ok(()) }).unwrap();
        }
        let mut p = a.active_profile();
        p["settings"]["ftp"] = json!(301);
        a.save_profile(p).unwrap();
        run(&a).unwrap();
        // copies a cloud service or a user might leave next to the real file
        let pdir = root(&cloud).join("profiles");
        let real = pdir.join(format!("{}.json", a.active_id()));
        for name in ["...json", "p_1 (conflicted copy 2026-11-19).json", "p_1 2.json", "notes.json"] {
            std::fs::copy(&real, pdir.join(name)).unwrap();
        }
        run(&b).unwrap();
        let ids: Vec<String> = b.app_state()["profiles"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec![a.active_id()]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn profile_ids() {
        assert!(state::is_profile_id("p_18a3f0c2b"));
        for bad in ["..", "", "p_", "p_1 (conflicted copy)", "p_1 2", "P_1", "p_xyz", "p_../x"] {
            assert!(!state::is_profile_id(bad), "{bad}");
        }
    }

    /// Two stores (A, B) sharing one cloud folder; A has synced a rider with FTP 301.
    fn setup(tag: &str) -> (PathBuf, PathBuf, Store, Store) {
        let base = std::env::temp_dir().join(format!("zt-sync-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let cloud = base.join("cloud");
        std::fs::create_dir_all(&cloud).unwrap();
        let a = Store::new(&base.join("a"));
        let b = Store::new(&base.join("b"));
        for s in [&a, &b] {
            s.update(|d| { d["sync"] = json!({ "dir": cloud.display().to_string() }); Ok(()) }).unwrap();
        }
        let mut p = a.active_profile();
        p["settings"]["ftp"] = json!(301);
        a.save_profile(p).unwrap();
        assert_eq!(run(&a).unwrap()["pushed"], 1);
        (base, root(&cloud).join("profiles"), a, b)
    }

    #[test]
    fn ride_paths_point_at_this_machines_folder() {
        let mut p = json!({ "history": [
            { "at": "1", "fitPath": "/Users/other/Library/x/activities/p_1/ride.fit", "garminPath": "/elsewhere/ride.garmin.fit", "file": "plan/w.zwo" },
            { "at": "2" },
        ] });
        let here = Path::new("/home/me/data/activities/p_1");
        relocate_paths(&mut p, here);
        assert_eq!(p["history"][0]["fitPath"], json!(here.join("ride.fit").display().to_string()));
        assert_eq!(p["history"][0]["garminPath"], json!(here.join("ride.garmin.fit").display().to_string()));
        assert_eq!(p["history"][0]["file"], "plan/w.zwo", "only *Path fields");
        assert_eq!(p["history"][1], json!({ "at": "2" }), "entries without files stay as they are");
    }

    #[test]
    fn deleted_riders_stay_deleted() {
        let (base, pdir, a, b) = setup("tomb");
        let anna = a.create_profile("Anna").unwrap()["activeProfile"].as_str().unwrap().to_string();
        let ben = a.create_profile("Ben").unwrap()["activeProfile"].as_str().unwrap().to_string();
        run(&a).unwrap();
        run(&b).unwrap();
        a.delete_profile(&anna).unwrap();
        a.delete_profile(&ben).unwrap();
        run(&a).unwrap();
        // B edits Ben after the deletion (later updatedAt): Ben is kept; Anna (untouched) goes
        b.update(|d| { d["profiles"][&ben]["updatedAt"] = json!("2999-01-01T00:00:00Z"); Ok(()) }).unwrap();
        run(&b).unwrap();
        let ids = |s: &Store| s.app_state()["profiles"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(!ids(&b).contains(&anna));
        assert!(ids(&b).contains(&ben), "edited after the deletion");
        // the tombstone keeps Anna gone in later rounds on both sides, and her file says deleted
        run(&a).unwrap();
        run(&b).unwrap();
        assert!(!ids(&a).contains(&anna) && !ids(&b).contains(&anna));
        let f: Value = serde_json::from_str(&std::fs::read_to_string(pdir.join(format!("{anna}.json"))).unwrap()).unwrap();
        assert_eq!(f["deleted"], true);
        let _ = std::fs::remove_dir_all(&base);
    }

    fn profile_files(pdir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(pdir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(".json")).collect();
        v.sort();
        v
    }

    #[test]
    fn placeholder_is_not_pushed_over() {
        let (base, pdir, a, _) = setup("ph");
        let id = a.active_id();
        let ph = pdir.join(format!(".{id}.json.icloud"));
        std::fs::rename(pdir.join(format!("{id}.json")), &ph).unwrap();
        let mut p = a.active_profile();
        p["name"] = json!("Older here");
        a.save_profile(p).unwrap();
        let r = run(&a).unwrap();
        assert_eq!(r["pushed"], 0);
        assert_eq!(r["pending"], 1);
        assert_eq!(r["skipped"], 1);
        assert!(profile_files(&pdir).is_empty() && ph.exists());
        assert_eq!(a.active_profile()["name"], "Older here");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unparseable_remote_is_not_overwritten() {
        let (base, pdir, a, _) = setup("bad");
        let file = pdir.join(format!("{}.json", a.active_id()));
        for junk in ["{ \"format\": 1, \"upd", "{\"format\": 1}"] {
            std::fs::write(&file, junk).unwrap();
            let r = run(&a).unwrap();
            assert_eq!(r["pushed"], 0);
            assert_eq!(r["skipped"], 1);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), junk);
            assert_eq!(a.app_state()["profiles"].as_array().unwrap().len(), 1);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fresh_store_waits_for_placeholders() {
        let (base, pdir, a, b) = setup("fresh");
        let id = a.active_id();
        let real = pdir.join(format!("{id}.json"));
        let ph = pdir.join(format!(".{id}.json.icloud"));
        std::fs::rename(&real, &ph).unwrap();
        // B sees only a placeholder: its untouched "Rider 1" must not be pushed
        let r = run(&b).unwrap();
        assert_eq!(r["pushed"], 0);
        assert!(profile_files(&pdir).is_empty());
        // download finished: the next sync is still a first one and replaces the default
        std::fs::rename(&ph, &real).unwrap();
        let r = run(&b).unwrap();
        assert_eq!(r["pulled"], 1);
        let ids: Vec<String> = b.app_state()["profiles"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, vec![id.clone()]);
        assert_eq!(profile_files(&pdir), vec![format!("{id}.json")]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn placeholder_names() {
        assert_eq!(placeholder_id(".p_18a3f0c2b.json.icloud"), Some("p_18a3f0c2b"));
        for bad in ["p_1.json.icloud", ".p_1.fit.icloud", ".notes.json.icloud", ".p_1 2.json.icloud"] {
            assert_eq!(placeholder_id(bad), None, "{bad}");
        }
    }

    /// A FIT header as the SDK writes it: 12 bytes with ".FIT" at 8–11.
    fn fit_bytes() -> Vec<u8> {
        let mut v = vec![14u8, 0x20, 0, 0, 0, 0, 0, 0];
        v.extend_from_slice(b".FIT");
        v
    }

    #[test]
    fn only_real_fit_files_cross_the_folder() {
        let base = std::env::temp_dir().join(format!("zt-sync-fit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (local, cloud) = (base.join("local"), base.join("cloud"));
        std::fs::create_dir_all(&cloud).unwrap();
        std::fs::write(cloud.join("ride.fit"), fit_bytes()).unwrap();
        // what else can end up in a shared cloud folder: a fake extension, a truncated file,
        // and something not a FIT file at all
        std::fs::write(cloud.join("payload.fit"), b"#!/bin/sh\nrm -rf ~\n").unwrap();
        std::fs::write(cloud.join("short.fit"), b".FIT").unwrap();
        assert!(is_fit_file(&cloud.join("ride.fit")));
        assert!(!is_fit_file(&cloud.join("payload.fit")));
        assert!(!is_fit_file(&cloud.join("short.fit")));
        assert!(!is_fit_file(&cloud.join("missing.fit")));
        let (up, down) = sync_files(&local, &cloud);
        assert_eq!((up, down), (0, 1), "only the real ride is copied");
        assert_eq!(std::fs::read(local.join("ride.fit")).unwrap(), fit_bytes());
        assert!(!local.join("payload.fit").exists() && !local.join("short.fit").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
