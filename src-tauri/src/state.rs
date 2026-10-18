//! Persistent app state: rider profiles (settings, plan progress, history) as one JSON document,
//! plus a separate, owner-only `secrets.json` for third-party tokens.
//!
//! state.json (v2):
//! { "version": 2, "activeProfile": "p_…", "profiles": { "p_…": Profile } }
//! Profile: { id, name, createdAt, settings, activePlan, plans, history }
//! The profile schema is owned by the UI; Rust guarantees defaults, ids and atomic writes.

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn default_zwo_dir() -> String {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .map(|d| d.join("zwo").display().to_string())
        .unwrap_or_else(|| "zwo".into())
}

fn default_settings() -> Value {
    json!({
        "ftp": 250,
        "maxHr": 185,
        "weight": null,
        "zones": [55, 75, 90, 105],
        "beeps": true,
        "theme": "system",
        "mode": "plans",
        "zwoDir": default_zwo_dir(),
        "devices": {},
        "overlay": { "power": true, "cadence": false, "hr": true },
        "bests": {},
        "garmin": { "autoOpen": false }
    })
}

fn default_profile(id: &str, name: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "avatar": { "color": null, "emoji": null },
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "settings": default_settings(),
        "activePlan": null,
        "plans": {},
        "history": [],
        "tests": [],
        "favorites": []
    })
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// RFC 3339 UTC timestamp for a unix time (no external date crate).
pub fn iso_from_unix(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

pub fn now_iso() -> String {
    iso_from_unix(unix_now())
}

fn new_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("p_{:x}", n ^ ((std::process::id() as u128) << 64))
}

/// Deep-merge `d` (defaults) under `v` (values in `v` win).
fn merge_defaults(v: &mut Value, d: &Value) {
    if let (Some(vo), Some(dobj)) = (v.as_object_mut(), d.as_object()) {
        for (k, dv) in dobj {
            match vo.get_mut(k) {
                Some(existing) => merge_defaults(existing, dv),
                None => {
                    vo.insert(k.clone(), dv.clone());
                }
            }
        }
    }
}

pub(crate) fn normalize_profile(p: &mut Value, id: &str) {
    let name = p.get("name").and_then(Value::as_str).unwrap_or("Rider").to_string();
    merge_defaults(p, &default_profile(id, &name));
    p["id"] = json!(id);
}

pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.to_path_buf(), lock: Mutex::new(()) }
    }

    fn state_path(&self) -> PathBuf {
        self.dir.join("state.json")
    }
    fn secrets_path(&self) -> PathBuf {
        self.dir.join("secrets.json")
    }
    pub fn activities_dir(&self, profile: &str) -> PathBuf {
        self.dir.join("activities").join(profile)
    }

    /// Load (and migrate) the whole document. Always returns a valid v2 doc with ≥1 profile.
    fn load(&self) -> Value {
        let raw = std::fs::read_to_string(self.state_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));

        let mut created = false;
        let mut doc = if raw.get("profiles").is_some_and(Value::is_object) {
            raw
        } else if raw.get("settings").is_some_and(Value::is_object) {
            // v1 → v2: the single-rider state becomes the first profile
            let id = new_id();
            let mut p = raw.clone();
            if let Some(o) = p.as_object_mut() {
                o.remove("version");
            }
            p["name"] = json!("Rider 1");
            created = true;
            let mut profiles = Map::new();
            profiles.insert(id.clone(), p);
            json!({ "version": 2, "activeProfile": id, "profiles": profiles })
        } else {
            json!({ "version": 2, "profiles": {} })
        };

        let profiles = doc["profiles"].as_object_mut().unwrap();
        if profiles.is_empty() {
            let id = new_id();
            profiles.insert(id.clone(), default_profile(&id, "Rider 1"));
            created = true;
        }
        for (id, p) in profiles.iter_mut() {
            normalize_profile(p, id);
        }
        let active_ok = doc["activeProfile"].as_str().is_some_and(|a| doc["profiles"].get(a).is_some());
        if !active_ok {
            let first = doc["profiles"].as_object().unwrap().keys().next().cloned().unwrap();
            doc["activeProfile"] = json!(first);
        }
        doc["version"] = json!(2);
        if created {
            // persist new ids right away so every later read sees the same profile
            let _ = self.save(&doc);
        }
        doc
    }

    fn save(&self, doc: &Value) -> Result<(), String> {
        write_json(&self.state_path(), doc, false)
    }

    /// Run a read-modify-write on the document under the store lock.
    pub(crate) fn update<T>(&self, f: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
        let _g = self.lock.lock().unwrap();
        let mut doc = self.load();
        let out = f(&mut doc)?;
        self.save(&doc)?;
        Ok(out)
    }

    /// What the UI needs on boot or after switching: the active profile + the profile list.
    pub fn app_state(&self) -> Value {
        let _g = self.lock.lock().unwrap();
        Self::summary(&self.load())
    }

    pub(crate) fn summary(doc: &Value) -> Value {
        let active = doc["activeProfile"].as_str().unwrap_or_default();
        let mut list: Vec<Value> = doc["profiles"]
            .as_object()
            .unwrap()
            .values()
            .map(|p| json!({ "id": p["id"], "name": p["name"], "avatar": p["avatar"], "createdAt": p["createdAt"] }))
            .collect();
        list.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
        json!({ "activeProfile": active, "profiles": list, "profile": doc["profiles"][active], "sync": doc["sync"] })
    }

    pub fn active_profile(&self) -> Value {
        let _g = self.lock.lock().unwrap();
        let doc = self.load();
        let a = doc["activeProfile"].as_str().unwrap_or_default().to_string();
        doc["profiles"][a].clone()
    }

    pub fn active_id(&self) -> String {
        self.active_profile()["id"].as_str().unwrap_or_default().to_string()
    }

    pub fn save_profile(&self, profile: Value) -> Result<(), String> {
        let id = profile.get("id").and_then(Value::as_str).ok_or("profile has no id")?.to_string();
        if !profile.get("settings").is_some_and(Value::is_object) {
            return Err("invalid profile".into());
        }
        self.update(|doc| {
            if doc["profiles"].get(&id).is_none() {
                return Err("unknown profile".into());
            }
            let mut p = profile;
            normalize_profile(&mut p, &id);
            p["updatedAt"] = json!(now_iso());
            doc["profiles"][&id] = p;
            Ok(())
        })
    }

    /// New profile; device pairings, folder and theme are copied from the active profile
    /// (same computer), rider data starts from defaults. Becomes the active profile.
    pub fn create_profile(&self, name: &str) -> Result<Value, String> {
        let name = clean_name(name)?;
        self.update(|doc| {
            let id = new_id();
            let mut p = default_profile(&id, &name);
            let active = doc["activeProfile"].as_str().unwrap_or_default().to_string();
            for k in ["zwoDir", "theme", "devices", "beeps"] {
                if let Some(v) = doc["profiles"][&active]["settings"].get(k) {
                    p["settings"][k] = v.clone();
                }
            }
            doc["profiles"][&id] = p;
            doc["activeProfile"] = json!(id);
            Ok(Self::summary(doc))
        })
    }

    pub fn rename_profile(&self, id: &str, name: &str) -> Result<Value, String> {
        self.edit_profile(id, Some(name), None)
    }

    /// Change a rider's name and/or avatar ({ color: "#rrggbb" | null, emoji: "🚴" | null }).
    pub fn edit_profile(&self, id: &str, name: Option<&str>, avatar: Option<Value>) -> Result<Value, String> {
        let name = name.map(clean_name).transpose()?;
        let avatar = avatar.map(clean_avatar).transpose()?;
        self.update(|doc| {
            let p = doc["profiles"].get_mut(id).ok_or("unknown profile")?;
            if let Some(n) = name {
                p["name"] = json!(n);
            }
            if let Some(a) = avatar {
                p["avatar"] = a;
            }
            p["updatedAt"] = json!(now_iso());
            Ok(Self::summary(doc))
        })
    }

    pub fn delete_profile(&self, id: &str) -> Result<Value, String> {
        let out = self.update(|doc| {
            let profiles = doc["profiles"].as_object_mut().unwrap();
            if profiles.len() <= 1 {
                return Err("The last profile can't be deleted".into());
            }
            profiles.remove(id).ok_or("unknown profile")?;
            // remember the deletion so profile sync removes it on other Macs too
            if !doc["tombstones"].is_object() {
                doc["tombstones"] = json!({});
            }
            doc["tombstones"][id] = json!(now_iso());
            if doc["activeProfile"].as_str() == Some(id) {
                let first = doc["profiles"].as_object().unwrap().keys().next().cloned().unwrap();
                doc["activeProfile"] = json!(first);
            }
            Ok(Self::summary(doc))
        })?;
        let _ = self.update_secrets(|s| {
            if let Some(o) = s["profiles"].as_object_mut() {
                o.remove(id);
            }
            Ok(())
        });
        let _ = std::fs::remove_dir_all(self.activities_dir(id));
        Ok(out)
    }

    pub fn switch_profile(&self, id: &str) -> Result<Value, String> {
        self.update(|doc| {
            if doc["profiles"].get(id).is_none() {
                return Err("unknown profile".into());
            }
            doc["activeProfile"] = json!(id);
            Ok(Self::summary(doc))
        })
    }

    pub fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        self.update(|doc| {
            let a = doc["activeProfile"].as_str().unwrap_or_default().to_string();
            doc["profiles"][&a]["settings"][key] = value;
            Ok(())
        })
    }

    pub fn zwo_dir(&self) -> PathBuf {
        let p = self.active_profile();
        let d = p["settings"]["zwoDir"].as_str().map(str::to_string).unwrap_or_else(default_zwo_dir);
        expand(&d)
    }

    // ---------------------------------------------------------------- secrets

    fn load_secrets(&self) -> Value {
        let mut v = std::fs::read_to_string(self.secrets_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        merge_defaults(&mut v, &json!({ "profiles": {} }));
        v
    }

    pub fn secret(&self, profile: &str, service: &str) -> Value {
        let _g = self.lock.lock().unwrap();
        self.load_secrets()["profiles"][profile][service].clone()
    }

    pub fn update_secrets<T>(&self, f: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
        let _g = self.lock.lock().unwrap();
        let mut s = self.load_secrets();
        let out = f(&mut s)?;
        write_json(&self.secrets_path(), &s, true)?;
        Ok(out)
    }

    pub fn set_secret(&self, profile: &str, service: &str, value: Value) -> Result<(), String> {
        self.update_secrets(|s| {
            if s["profiles"].get(profile).is_none() {
                s["profiles"][profile] = json!({});
            }
            s["profiles"][profile][service] = value;
            Ok(())
        })
    }
}

fn clean_avatar(a: Value) -> Result<Value, String> {
    let color = a["color"].as_str().filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit()));
    let emoji = a["emoji"].as_str().map(str::trim).filter(|e| !e.is_empty());
    if let Some(e) = emoji {
        if e.chars().count() > 8 {
            return Err("Use a single emoji".into());
        }
    }
    Ok(json!({ "color": color, "emoji": emoji }))
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Please enter a name".into());
    }
    Ok(n.chars().take(40).collect())
}

pub(crate) fn write_json(path: &Path, v: &Value, private: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = private;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(p)),
        None => PathBuf::from(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zt-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn fresh_store_has_one_profile() {
        let dir = tmp("fresh");
        let s = Store::new(&dir);
        let a = s.app_state();
        assert_eq!(a["profiles"].as_array().unwrap().len(), 1);
        assert_eq!(a["profile"]["settings"]["ftp"], 250);
        assert_eq!(a["profile"]["settings"]["mode"], "plans");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migrates_v1() {
        let dir = tmp("v1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("state.json"),
            r#"{"version":1,"settings":{"ftp":281,"zones":[50,70,88,104]},"activePlan":"x","plans":{"x":{"entries":{"x/a.zwo":{"status":"done"}}}},"history":[{"file":"x/a.zwo"}]}"#,
        )
        .unwrap();
        let s = Store::new(&dir);
        let p = s.active_profile();
        assert_eq!(p["name"], "Rider 1");
        assert_eq!(p["settings"]["ftp"], 281);
        assert_eq!(p["settings"]["maxHr"], 185); // default filled in
        assert_eq!(p["activePlan"], "x");
        assert_eq!(p["history"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn profile_lifecycle() {
        let dir = tmp("life");
        let s = Store::new(&dir);
        let first = s.active_id();
        let mut p = s.active_profile();
        p["settings"]["ftp"] = json!(300);
        p["settings"]["zwoDir"] = json!("/w");
        s.save_profile(p).unwrap();

        let a = s.create_profile("  Anna ").unwrap();
        assert_eq!(a["profile"]["name"], "Anna");
        assert_eq!(a["profile"]["settings"]["ftp"], 250); // own rider data
        assert_eq!(a["profile"]["settings"]["zwoDir"], "/w"); // inherited machine setting
        let anna = a["activeProfile"].as_str().unwrap().to_string();
        assert_ne!(anna, first);

        s.set_secret(&anna, "garmin", json!({"accessToken": "t"})).unwrap();
        assert_eq!(s.secret(&anna, "garmin")["accessToken"], "t");

        let a = s.switch_profile(&first).unwrap();
        assert_eq!(a["profile"]["settings"]["ftp"], 300);
        s.rename_profile(&anna, "Anna B").unwrap();
        let a = s.delete_profile(&anna).unwrap();
        assert_eq!(a["profiles"].as_array().unwrap().len(), 1);
        assert!(s.secret(&anna, "garmin").is_null());
        assert!(s.delete_profile(&first).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn iso_time() {
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_unix(1_792_224_000), "2026-10-17T08:00:00Z");
        assert_eq!(iso_from_unix(951_782_400), "2000-02-29T00:00:00Z");
    }
}
