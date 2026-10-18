//! Training platforms besides Garmin, kept deliberately small:
//!
//! - **Intervals.icu** — automatic upload with the rider's personal API key (official API).
//! - **COROS** — manual Training Hub import: the ride is saved as a ZIP (the only format the
//!   importer accepts), shown in Finder and the Training Hub is opened.
//!
//! (Wahoo, TrainingPeaks and Suunto only accept uploads from approved partner apps, so they
//! are intentionally not part of zwoTrainer.)

use base64::Engine;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const UA: &str = concat!("zwoTrainer/", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    ApiKey,
    Manual,
}

pub struct Service {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// manual upload page (opened together with the FIT file in Finder), if the platform has one
    pub manual_url: Option<&'static str>,
    /// COROS Training Hub only accepts FIT files inside a ZIP
    pub manual_zip: bool,
    pub hint: &'static str,
}

pub const SERVICES: &[Service] = &[
    Service {
        id: "intervals",
        name: "Intervals.icu",
        kind: Kind::ApiKey,
        manual_url: None,
        manual_zip: false,
        hint: "Paste your personal API key from intervals.icu → Settings → Developer Settings.",
    },
    Service {
        id: "coros",
        name: "COROS",
        kind: Kind::Manual,
        manual_url: Some("https://t.coros.com/login"),
        manual_zip: true,
        hint: "Training Hub → Activity List → Import Data, then choose the highlighted ZIP.",
    },
];

pub fn get(id: &str) -> Result<&'static Service, String> {
    SERVICES.iter().find(|s| s.id == id).ok_or_else(|| format!("Unknown service {id}"))
}

pub fn secret_key(id: &str) -> String {
    format!("svc:{id}")
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent(UA).timeout(Duration::from_secs(60)).build().unwrap()
}

fn err_text(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error_description"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(160).collect());
    match status.as_u16() {
        401 | 403 => "Not authorised — please connect again".into(),
        _ => format!("{} ({})", msg.trim(), status.as_u16()),
    }
}

// ------------------------------------------------------------------------------- Intervals.icu

fn intervals_auth(key: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("API_KEY:{key}")))
}

/// Check an Intervals.icu API key; returns the secret record { apiKey, account }.
pub async fn intervals_connect(key: &str) -> Result<Value, String> {
    let key = key.trim();
    if key.len() < 10 {
        return Err("That doesn't look like an Intervals.icu API key".into());
    }
    let r = http().get("https://intervals.icu/api/v1/athlete/0").header("Authorization", intervals_auth(key)).send().await.map_err(|e| e.to_string())?;
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(if status.as_u16() == 401 || status.as_u16() == 403 { "Intervals.icu didn't accept this API key".into() } else { err_text(status, &body) });
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let account = v["name"].as_str().or(v["firstname"].as_str()).unwrap_or("athlete").to_string();
    Ok(json!({ "apiKey": key, "account": account, "athleteId": v["id"] }))
}

async fn intervals_upload(rec: &Value, path: &Path, name: &str, description: &str) -> Result<Value, String> {
    let key = rec["apiKey"].as_str().ok_or("Intervals.icu is not connected")?;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("ride.fit").to_string();
    let ext_id = format!("zwotrainer-{}", path.file_stem().and_then(|s| s.to_str()).unwrap_or("ride"));
    let part = reqwest::multipart::Part::bytes(bytes).file_name(fname).mime_str("application/octet-stream").map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let r = http()
        .post("https://intervals.icu/api/v1/athlete/0/activities")
        .header("Authorization", intervals_auth(key))
        .query(&[("name", name), ("description", description), ("external_id", ext_id.as_str())])
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status();
    let body = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err_text(status, &body));
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let v = if v.is_array() { v[0].clone() } else { v };
    let id = v["id"].as_str().map(str::to_string).or_else(|| v["id"].as_i64().map(|i| i.to_string()));
    // Make sure the activity carries the workout's name (Intervals.icu may otherwise name it
    // from the file); harmless if the upload parameter already did.
    if let Some(i) = &id {
        let _ = http()
            .put(format!("https://intervals.icu/api/v1/activity/{i}"))
            .header("Authorization", intervals_auth(key))
            .json(&json!({ "name": name, "description": description }))
            .send()
            .await;
    }
    Ok(json!({ "id": id, "url": id.map(|i| format!("https://intervals.icu/activities/{i}")).unwrap_or_else(|| "https://intervals.icu/activities".into()) }))
}

/// Upload one ride to an API-connected platform.
pub async fn upload(s: &Service, rec: &Value, path: &Path, name: &str, description: &str) -> Result<Value, String> {
    match s.kind {
        Kind::ApiKey => intervals_upload(rec, path, name, description).await,
        Kind::Manual => Err(format!("{} uses the manual import", s.name)),
    }
}

// ------------------------------------------------------------------------------- manual import

/// Put the ride file where the user can drag it into the platform's upload page: a copy of the
/// FIT (or a ZIP containing it, for COROS) in `folder`. Returns the written path.
pub fn prepare_manual(s: &Service, src: &Path, folder: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("ride.fit").to_string();
    let bytes = std::fs::read(src).map_err(|e| format!("{}: {e}", src.display()))?;
    if s.manual_zip {
        let dst = folder.join(name.replace(".fit", ".zip"));
        std::fs::write(&dst, zip_stored(&name, &bytes)).map_err(|e| e.to_string())?;
        Ok(dst)
    } else {
        let dst = folder.join(&name);
        std::fs::write(&dst, bytes).map_err(|e| e.to_string())?;
        Ok(dst)
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Minimal single-file ZIP (method 0 "stored") — enough for Training Hub's importer.
pub fn zip_stored(name: &str, data: &[u8]) -> Vec<u8> {
    let crc = crc32(data);
    let (n, len) = (name.as_bytes(), data.len() as u32);
    let mut out = Vec::with_capacity(data.len() + 128);
    let le16 = |v: &mut Vec<u8>, x: u16| v.extend_from_slice(&x.to_le_bytes());
    let le32 = |v: &mut Vec<u8>, x: u32| v.extend_from_slice(&x.to_le_bytes());
    // local file header
    le32(&mut out, 0x0403_4b50);
    for x in [20u16, 0, 0, 0, 0x21] { le16(&mut out, x); } // version, flags, method, time, date (1980-01-01)
    le32(&mut out, crc);
    le32(&mut out, len);
    le32(&mut out, len);
    le16(&mut out, n.len() as u16);
    le16(&mut out, 0);
    out.extend_from_slice(n);
    out.extend_from_slice(data);
    let cd_start = out.len() as u32;
    // central directory
    le32(&mut out, 0x0201_4b50);
    for x in [20u16, 20, 0, 0, 0, 0x21] { le16(&mut out, x); }
    le32(&mut out, crc);
    le32(&mut out, len);
    le32(&mut out, len);
    le16(&mut out, n.len() as u16);
    for x in [0u16, 0, 0, 0] { le16(&mut out, x); }
    le32(&mut out, 0);
    le32(&mut out, 0);
    out.extend_from_slice(n);
    let cd_len = out.len() as u32 - cd_start;
    // end of central directory
    le32(&mut out, 0x0605_4b50);
    for x in [0u16, 0, 1, 1] { le16(&mut out, x); }
    le32(&mut out, cd_len);
    le32(&mut out, cd_start);
    le16(&mut out, 0);
    out
}

/// Status of every service for the UI: [{ id, name, kind, connected, account, manualUrl, manualZip, hint }].
pub fn status(secret: impl Fn(&str) -> Value) -> Vec<Value> {
    SERVICES
        .iter()
        .map(|s| {
            let rec = secret(&secret_key(s.id));
            let connected = s.kind == Kind::ApiKey && rec["apiKey"].is_string();
            json!({
                "id": s.id, "name": s.name,
                "kind": match s.kind { Kind::ApiKey => "apikey", Kind::Manual => "manual" },
                "connected": connected, "account": rec["account"],
                "manualUrl": s.manual_url, "manualZip": s.manual_zip, "hint": s.hint,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_and_zip() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        let z = zip_stored("a.fit", b"hello");
        assert_eq!(&z[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert_eq!(&z[z.len() - 22..z.len() - 18], &[0x50, 0x4b, 0x05, 0x06]);
        // central directory offset points at the CD signature
        let off = u32::from_le_bytes(z[z.len() - 6..z.len() - 2].try_into().unwrap()) as usize;
        assert_eq!(&z[off..off + 4], &[0x50, 0x4b, 0x01, 0x02]);
    }

    #[test]
    fn services() {
        assert_eq!(SERVICES.len(), 2);
        assert_eq!(get("intervals").unwrap().kind, Kind::ApiKey);
        assert!(get("coros").unwrap().manual_zip);
        assert!(get("wahoo").is_err());
        assert_eq!(intervals_auth("abc"), "Basic QVBJX0tFWTphYmM=");
    }

    #[test]
    fn manual_prepare() {
        let dir = std::env::temp_dir().join(format!("zt-svc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("ride.fit");
        std::fs::write(&src, b"FITDATA").unwrap();
        let out = dir.join("out");
        let z = prepare_manual(get("coros").unwrap(), &src, &out).unwrap();
        assert_eq!(z.extension().unwrap(), "zip");
        assert_eq!(std::fs::read(&z).unwrap()[30..35], *b"ride.");
        let _ = std::fs::remove_dir_all(dir);
    }
}
