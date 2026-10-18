//! Workout library: every sub-folder of the ZWO root is a plan; loose files are single workouts.

use crate::zwo;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
pub struct WorkoutInfo {
    pub file: String,
    pub week: Option<u32>,
    pub day: Option<u32>,
    pub title: String,
    pub name: String,
    pub duration: u32,
    pub tss: u32,
    /// training intensity 1–5 (Z1 Recovery … Z5 VO2max), see zwo::main_zone
    pub zone: u8,
    /// seconds per zone Z1..Z5
    #[serde(rename = "zoneTime")]
    pub zone_time: [u32; 5],
    /// compact profile for previews: [duration, p0, p1] (p = null → free ride)
    pub profile: Vec<(u32, Option<f64>, Option<f64>)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub parent: Option<String>,
    pub count: usize,
    pub weeks: Option<usize>,
    pub duration: u32,
    pub workouts: Vec<WorkoutInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Library {
    pub root: String,
    pub exists: bool,
    pub plans: Vec<Plan>,
    pub singles: Vec<WorkoutInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoadedWorkout {
    pub file: String,
    pub week: Option<u32>,
    pub day: Option<u32>,
    pub title: String,
    pub workout: zwo::Workout,
}

/// Parsed-file cache keyed by absolute path, invalidated by mtime.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<PathBuf, (SystemTime, WorkoutInfo)>>);

// ---------------------------------------------------------------- helpers

/// Natural ("human") ordering: `Week2` < `Week10`, case-insensitive.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) { na.push(c); ai.next(); }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) { nb.push(c); bi.next(); }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal { return o; }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != Ordering::Equal { return o; }
                ai.next();
                bi.next();
            }
        }
    }
}

const ACRONYMS: &[&str] = &["ftp", "prl", "tt", "gc", "gcn", "vo2", "vo2max", "hiit", "mtb", "ai", "cvr", "xc", "uci"];

pub fn pretty_folder(name: &str) -> String {
    name.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let lw = w.to_lowercase();
            if ACRONYMS.contains(&lw.as_str()) {
                lw.to_uppercase()
            } else if lw.ends_with("wk") && lw[..lw.len() - 2].chars().all(|c| c.is_ascii_digit()) && lw.len() > 2 {
                lw
            } else if lw == "plus" {
                "+".into()
            } else {
                let mut c = lw.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" +", "+")
}

/// `Week01_Day02_Some_Title.zwo` → (Some(1), Some(2), "Some Title")
pub fn parse_file_name(file: &str) -> (Option<u32>, Option<u32>, String) {
    let base = Path::new(file).file_stem().and_then(|s| s.to_str()).unwrap_or(file);
    let clean = |s: &str| s.replace('_', " ").trim().to_string();
    let lower = base.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("week") {
        let rest = rest.trim_start();
        let wd: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let after = rest[wd.len()..].trim_start_matches(['_', ' ', '-']);
        if !wd.is_empty() {
            if let Some(r2) = after.strip_prefix("day") {
                let r2 = r2.trim_start();
                let dd: String = r2.chars().take_while(char::is_ascii_digit).collect();
                if !dd.is_empty() {
                    // map back to original-case title via byte offset
                    let consumed = base.len() - r2[dd.len()..].len();
                    let title = base[consumed..].trim_start_matches(['_', ' ', '-']);
                    return (wd.parse().ok(), dd.parse().ok(), clean(title));
                }
            }
        }
    }
    (None, None, clean(base))
}

/// Resolve a library-relative path, refusing anything that escapes the root.
pub fn inside_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("invalid path".into());
    }
    Ok(root.join(p))
}

fn rel_string(p: &Path) -> String {
    p.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/")
}

// ---------------------------------------------------------------- scanning

impl Cache {
    fn info(&self, abs: &Path, rel: &str) -> Result<WorkoutInfo, String> {
        let mtime = std::fs::metadata(abs).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
        if let Some((t, info)) = self.0.lock().unwrap().get(abs) {
            if *t == mtime {
                return Ok(info.clone());
            }
        }
        let xml = std::fs::read_to_string(abs).map_err(|e| e.to_string())?;
        let w = zwo::parse(&xml)?;
        let (week, day, title) = parse_file_name(rel);
        let r3 = |v: Option<f64>| v.map(|x| (x * 1000.0).round() / 1000.0);
        let info = WorkoutInfo {
            file: rel.to_string(),
            week,
            day,
            name: if w.name.is_empty() { title.clone() } else { w.name.clone() },
            title,
            duration: w.duration,
            tss: zwo::estimate_tss(&w.segments),
            zone: zwo::classify(&w.segments),
            zone_time: zwo::zone_seconds(&w.segments),
            profile: w.segments.iter().map(|s| (s.duration, r3(s.p0), r3(s.p1))).collect(),
        };
        self.0.lock().unwrap().insert(abs.to_path_buf(), (mtime, info.clone()));
        Ok(info)
    }

    pub fn scan(&self, root: &Path) -> Library {
        let mut plans = vec![];
        let mut singles = vec![];
        self.walk(root, Path::new(""), &mut plans, &mut singles);
        plans.sort_by(|a: &Plan, b| natural_cmp(&a.id, &b.id));
        Library { root: root.display().to_string(), exists: root.is_dir(), plans, singles }
    }

    fn walk(&self, abs: &Path, rel: &Path, plans: &mut Vec<Plan>, singles: &mut Vec<WorkoutInfo>) {
        let Ok(rd) = std::fs::read_dir(abs) else { return };
        let mut files = vec![];
        let mut dirs = vec![];
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                dirs.push(name);
            } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".zwo") {
                files.push(name);
            }
        }
        files.sort_by(|a, b| natural_cmp(a, b));
        dirs.sort_by(|a, b| natural_cmp(a, b));

        let mut workouts = vec![];
        for f in &files {
            let r = rel_string(&rel.join(f));
            match self.info(&abs.join(f), &r) {
                Ok(i) => workouts.push(i),
                Err(e) => eprintln!("skip {r}: {e}"),
            }
        }
        let rel_s = rel_string(rel);
        if rel_s.is_empty() {
            singles.extend(workouts);
        } else if !workouts.is_empty() {
            let weeks: BTreeSet<u32> = workouts.iter().filter_map(|w| w.week).collect();
            let parent = rel.parent().map(rel_string).filter(|p| !p.is_empty());
            plans.push(Plan {
                name: pretty_folder(rel.file_name().and_then(|s| s.to_str()).unwrap_or(&rel_s)),
                id: rel_s,
                parent,
                count: workouts.len(),
                weeks: if weeks.is_empty() { None } else { Some(weeks.len()) },
                duration: workouts.iter().map(|w| w.duration).sum(),
                workouts,
            });
        }
        for d in dirs {
            self.walk(&abs.join(&d), &rel.join(&d), plans, singles);
        }
    }
}

pub fn load(root: &Path, rel: &str) -> Result<LoadedWorkout, String> {
    if !rel.to_ascii_lowercase().ends_with(".zwo") {
        return Err("not a .zwo file".into());
    }
    let abs = inside_root(root, rel)?;
    let xml = std::fs::read_to_string(&abs).map_err(|e| format!("{rel}: {e}"))?;
    let (week, day, title) = parse_file_name(rel);
    Ok(LoadedWorkout { file: rel.to_string(), week, day, title, workout: zwo::parse(&xml)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_sort() {
        let mut v = vec!["Week10_Day01", "Week2_Day01", "week01_Day02", "Week01_Day01"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Week01_Day01", "week01_Day02", "Week2_Day01", "Week10_Day01"]);
    }

    #[test]
    fn file_names() {
        assert_eq!(parse_file_name("p/Week01_Day03_Tempo_into_Sprints.zwo"), (Some(1), Some(3), "Tempo into Sprints".into()));
        assert_eq!(parse_file_name("Week12_Day01_FTP_Test_[Standard].zwo"), (Some(12), Some(1), "FTP Test [Standard]".into()));
        assert_eq!(parse_file_name("Recovery_Spin.zwo"), (None, None, "Recovery Spin".into()));
    }

    #[test]
    fn folders() {
        assert_eq!(pretty_folder("4wk-ftp-booster"), "4wk FTP Booster");
        assert_eq!(pretty_folder("90plus-minutes-to-burn"), "90plus Minutes To Burn");
        assert_eq!(pretty_folder("gcn-zero-to-hero-plan"), "GCN Zero To Hero Plan");
    }

    #[test]
    fn rejects_escape() {
        assert!(inside_root(Path::new("/x"), "../etc/passwd.zwo").is_err());
        assert!(inside_root(Path::new("/x"), "/etc/passwd.zwo").is_err());
        assert!(inside_root(Path::new("/x"), "a/b.zwo").is_ok());
    }
}
