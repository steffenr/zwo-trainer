//! Garmin Connect: sign-in and automatic FIT upload
//! (one-time login per rider, a session token stored only on this Mac, uploads afterwards).
//!
//! Flow (same as the Garmin Connect mobile app / the open-source `garth` client):
//!  1. The rider signs in on Garmin's own SSO page in a small app window (password, MFA and
//!     captcha are handled by Garmin; zwoTrainer never sees the password).
//!  2. The SSO page returns a one-time service ticket (`ST-…`).
//!  3. Ticket → OAuth1 token (long-lived, ~1 year) via `oauth-service/oauth/preauthorized`.
//!  4. OAuth1 → OAuth2 bearer (short-lived) via `oauth-service/oauth/exchange/user/2.0`;
//!     re-exchanged automatically when it expires.
//!  5. Upload: `upload-service/upload` (multipart FIT).

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use std::path::Path;
use std::time::Duration;

pub const SSO_EMBED: &str = "https://sso.garmin.com/sso/embed";
const CONNECT_API: &str = "https://connectapi.garmin.com";
const CONSUMER_URL: &str = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const USER_AGENT: &str = "com.garmin.android.apps.connectmobile";

/// Garmin's SSO sign-in page in "embed widget" mode (what the mobile app uses).
pub fn signin_url() -> String {
    let q = [
        ("id", "gauth-widget"),
        ("embedWidget", "true"),
        ("gauthHost", SSO_EMBED),
        ("service", SSO_EMBED),
        ("source", SSO_EMBED),
        ("redirectAfterAccountLoginUrl", SSO_EMBED),
        ("redirectAfterAccountCreationUrl", SSO_EMBED),
    ];
    format!("https://sso.garmin.com/sso/signin?{}", q.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&"))
}

/// Injected into the sign-in window: once Garmin shows the success page, hand the service
/// ticket to the app by navigating to a sentinel URL that the window intercepts.
pub const TICKET_SCRIPT: &str = r#"
(function () {
  function grab() {
    var html = document.documentElement ? document.documentElement.innerHTML : '';
    var m = html.match(/ticket=(ST-[A-Za-z0-9\-._~]+)/) || String(location.href).match(/ticket=(ST-[A-Za-z0-9\-._~]+)/);
    if (m) { location.href = 'https://zwotrainer.invalid/garmin-ticket?ticket=' + encodeURIComponent(m[1]); return true; }
    return false;
  }
  if (!grab()) {
    document.addEventListener('DOMContentLoaded', grab);
    var n = 0, t = setInterval(function () { if (grab() || ++n > 40) clearInterval(t); }, 500);
  }
})();
"#;

/// Extract a service ticket from a URL the sign-in window navigates to.
pub fn ticket_from_url(url: &str) -> Option<String> {
    let i = url.find("ticket=ST-")?;
    let t: String = url[i + 7..].chars().take_while(|c| c.is_ascii_alphanumeric() || "-._~%".contains(*c)).collect();
    Some(dec(&t))
}

// ---------------------------------------------------------------- OAuth1 (RFC 5849, HMAC-SHA1)

pub fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, &RFC3986).to_string()
}
fn dec(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}
const RFC3986: percent_encoding::AsciiSet = percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// Build an OAuth1 `Authorization` header. `params` = query + form-body parameters of the request.
pub fn oauth1_header(
    method: &str,
    url: &str,
    params: &[(String, String)],
    consumer: (&str, &str),
    token: Option<(&str, &str)>,
    nonce: &str,
    timestamp: i64,
) -> String {
    let mut oauth: Vec<(String, String)> = vec![
        ("oauth_consumer_key".into(), consumer.0.into()),
        ("oauth_nonce".into(), nonce.into()),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp.to_string()),
        ("oauth_version".into(), "1.0".into()),
    ];
    if let Some((t, _)) = token {
        oauth.push(("oauth_token".into(), t.into()));
    }
    let mut all: Vec<(String, String)> = oauth.iter().chain(params.iter()).map(|(k, v)| (enc(k), enc(v))).collect();
    all.sort();
    let param_str = all.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let base = format!("{}&{}&{}", method.to_uppercase(), enc(url), enc(&param_str));
    let key = format!("{}&{}", enc(consumer.1), enc(token.map(|t| t.1).unwrap_or("")));
    let mut mac = Hmac::<Sha1>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(base.as_bytes());
    let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    oauth.push(("oauth_signature".into(), sig));
    format!("OAuth {}", oauth.iter().map(|(k, v)| format!("{}=\"{}\"", enc(k), enc(v))).collect::<Vec<_>>().join(", "))
}

fn nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent(USER_AGENT).build().expect("http client")
}

async fn consumer() -> Result<(String, String), String> {
    let v: Value = http().get(CONSUMER_URL).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    Ok((
        v["consumer_key"].as_str().ok_or("Garmin consumer key unavailable")?.to_string(),
        v["consumer_secret"].as_str().ok_or("Garmin consumer key unavailable")?.to_string(),
    ))
}

fn parse_form(s: &str) -> Vec<(String, String)> {
    s.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (dec(k), dec(v))).collect()
}

/// Ticket → OAuth1 → OAuth2. Returns the secret record stored for the rider.
pub async fn login_with_ticket(ticket: &str, now: i64) -> Result<Value, String> {
    let (ck, cs) = consumer().await?;
    let url = format!("{CONNECT_API}/oauth-service/oauth/preauthorized");
    let q = vec![
        ("ticket".to_string(), ticket.to_string()),
        ("login-url".to_string(), SSO_EMBED.to_string()),
        ("accepts-mfa-tokens".to_string(), "true".to_string()),
    ];
    let auth = oauth1_header("GET", &url, &q, (&ck, &cs), None, &nonce(), now);
    let r = http().get(&url).query(&q).header("Authorization", auth).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("Garmin sign-in failed ({})", r.status()));
    }
    let body = r.text().await.map_err(|e| e.to_string())?;
    let f = parse_form(&body);
    let get = |k: &str| f.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
    let token = get("oauth_token").ok_or("Garmin did not return a token")?;
    let secret = get("oauth_token_secret").ok_or("Garmin did not return a token")?;
    let mut rec = json!({ "oauth1": { "token": token, "secret": secret, "mfaToken": get("mfa_token") } });
    refresh_oauth2(&mut rec, now).await?;
    // who is signed in (best effort)
    if let Ok(name) = display_name(&rec).await {
        rec["displayName"] = json!(name);
    }
    Ok(rec)
}

/// OAuth1 → fresh OAuth2 bearer (mutates `rec`).
pub async fn refresh_oauth2(rec: &mut Value, now: i64) -> Result<(), String> {
    let (ck, cs) = consumer().await?;
    let t = rec["oauth1"]["token"].as_str().ok_or("Garmin is not connected")?.to_string();
    let ts = rec["oauth1"]["secret"].as_str().ok_or("Garmin is not connected")?.to_string();
    let url = format!("{CONNECT_API}/oauth-service/oauth/exchange/user/2.0");
    let mut body: Vec<(String, String)> = vec![];
    if let Some(m) = rec["oauth1"]["mfaToken"].as_str() {
        body.push(("mfa_token".into(), m.into()));
    }
    let auth = oauth1_header("POST", &url, &body, (&ck, &cs), Some((&t, &ts)), &nonce(), now);
    let r = http().post(&url).header("Authorization", auth).form(&body).send().await.map_err(|e| e.to_string())?;
    if r.status().as_u16() == 401 {
        return Err("Garmin session expired — please sign in to Garmin again".into());
    }
    if !r.status().is_success() {
        return Err(format!("Garmin token exchange failed ({})", r.status()));
    }
    let o: Value = r.json().await.map_err(|e| e.to_string())?;
    let access = o["access_token"].as_str().ok_or("Garmin did not return an access token")?;
    rec["oauth2"] = json!({
        "accessToken": access,
        "expiresAt": now + o["expires_in"].as_i64().unwrap_or(3600),
    });
    Ok(())
}

/// Valid bearer token, re-exchanged when it expires within 5 minutes.
pub async fn bearer(rec: &mut Value, now: i64) -> Result<String, String> {
    if rec["oauth2"]["expiresAt"].as_i64().unwrap_or(0) - 300 <= now {
        refresh_oauth2(rec, now).await?;
    }
    rec["oauth2"]["accessToken"].as_str().map(str::to_string).ok_or_else(|| "Garmin is not connected".into())
}

async fn display_name(rec: &Value) -> Result<String, String> {
    let tok = rec["oauth2"]["accessToken"].as_str().ok_or("no token")?;
    let v: Value = http()
        .get(format!("{CONNECT_API}/userprofile-service/socialProfile"))
        .bearer_auth(tok)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v["fullName"].as_str().or(v["displayName"].as_str()).unwrap_or("Garmin user").to_string())
}

/// Upload a FIT file. Returns Some(activity id) when Garmin reports it right away.
pub async fn upload(token: &str, path: &Path) -> Result<Option<i64>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("ride.fit").replace(".garmin.fit", ".fit");
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(bytes).file_name(name).mime_str("application/octet-stream").unwrap());
    let r = http()
        .post(format!("{CONNECT_API}/upload-service/upload"))
        .bearer_auth(token)
        .header("NK", "NT")
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let res = &v["detailedImportResult"];
    let id = res["successes"][0]["internalId"].as_i64();
    let failure = res["failures"][0]["messages"][0]["content"].as_str().map(str::to_string);
    match status {
        200..=202 => match (id, failure) {
            (Some(i), _) => Ok(Some(i)),
            (None, Some(msg)) if msg.to_lowercase().contains("duplicate") => {
                Ok(res["failures"][0]["internalId"].as_i64())
            }
            (None, Some(msg)) => Err(format!("Garmin: {msg}")),
            (None, None) => Ok(None), // accepted, still processing
        },
        409 => Ok(res["failures"][0]["internalId"].as_i64()), // duplicate — already on Garmin
        401 | 403 => Err("Garmin session expired — please sign in to Garmin again".into()),
        s => Err(format!("Garmin upload failed ({s}) {}", failure.unwrap_or_default())),
    }
}

/// Give an uploaded activity the workout's name (and a short description). Garmin derives
/// the title from the location/sport ("Indoor Cycling") because FIT has no title field, so
/// zwoTrainer sets it afterwards — the same call the Garmin Connect app makes when you rename.
pub async fn rename(token: &str, id: i64, name: &str, description: &str) -> Result<(), String> {
    let mut body = json!({ "activityId": id, "activityName": name });
    if !description.is_empty() {
        body["description"] = json!(description);
    }
    let r = http()
        .put(format!("{CONNECT_API}/activity-service/activity/{id}"))
        .bearer_auth(token)
        .header("NK", "NT")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match r.status().as_u16() {
        200..=299 => Ok(()),
        s => Err(format!("Garmin rename failed ({s})")),
    }
}

/// Garmin sometimes answers an upload before the activity exists. Find it among the latest
/// activities by its start time (± 3 min), retrying for a few seconds.
pub async fn find_by_start(token: &str, start_unix: i64) -> Option<i64> {
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        let Ok(r) = http()
            .get(format!("{CONNECT_API}/activitylist-service/activities/search/activities?start=0&limit=10"))
            .bearer_auth(token)
            .header("NK", "NT")
            .send()
            .await
        else {
            continue;
        };
        let list: Value = r.json().await.unwrap_or(Value::Null);
        let hit = list.as_array().into_iter().flatten().find(|a| {
            a["startTimeGMT"].as_str().and_then(gmt_to_unix).is_some_and(|t| (t - start_unix).abs() <= 180)
        });
        if let Some(id) = hit.and_then(|a| a["activityId"].as_i64()) {
            return Some(id);
        }
    }
    None
}

/// "2026-10-18 06:19:00" (UTC) → unix seconds.
pub fn gmt_to_unix(s: &str) -> Option<i64> {
    let (d, t) = s.trim().split_once([' ', 'T'])?;
    let mut dp = d.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (dp.next()?.ok()?, dp.next()?.ok()?, dp.next()?.ok()?);
    let mut tp = t.trim_end_matches('Z').split(':').map(|x| x.split('.').next().unwrap_or("0").parse::<i64>());
    let (hh, mm, ss) = (tp.next()?.ok()?, tp.next()?.ok()?, tp.next().and_then(|x| x.ok()).unwrap_or(0));
    // days from civil (Howard Hinnant)
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + hh * 3600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5849 / Twitter developer docs reference example for HMAC-SHA1 signing.
    #[test]
    fn oauth1_signature_matches_reference() {
        let params = vec![
            ("include_entities".to_string(), "true".to_string()),
            ("status".to_string(), "Hello Ladies + Gentlemen, a signed OAuth request!".to_string()),
        ];
        let h = oauth1_header(
            "POST",
            "https://api.twitter.com/1.1/statuses/update.json",
            &params,
            ("xvz1evFS4wEEPTGEFPHBog", "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw"),
            Some(("370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE")),
            "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
            1318622958,
        );
        assert!(h.contains("oauth_signature=\"hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D\""), "{h}");
    }

    #[test]
    fn gmt_parsing() {
        assert_eq!(gmt_to_unix("1970-01-01 00:00:00"), Some(0));
        assert_eq!(gmt_to_unix("2026-10-18 06:19:00"), Some(1_792_304_340));
        assert_eq!(gmt_to_unix("2026-10-18T06:19:00.0Z"), Some(1_792_304_340));
        assert_eq!(gmt_to_unix("garbage"), None);
    }

    #[test]
    fn ticket_extraction() {
        assert_eq!(ticket_from_url("https://zwotrainer.invalid/garmin-ticket?ticket=ST-0123-abc-cas").as_deref(), Some("ST-0123-abc-cas"));
        assert_eq!(ticket_from_url("https://sso.garmin.com/sso/embed?ticket=ST-9%2D1&x=1").as_deref(), Some("ST-9-1"));
        assert!(ticket_from_url("https://sso.garmin.com/sso/signin").is_none());
    }

    #[test]
    fn signin_url_shape() {
        let u = signin_url();
        assert!(u.starts_with("https://sso.garmin.com/sso/signin?id=gauth-widget&embedWidget=true"));
        assert!(u.contains("service=https%3A%2F%2Fsso.garmin.com%2Fsso%2Fembed"));
    }
}
