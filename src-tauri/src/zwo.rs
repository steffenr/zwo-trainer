//! ZWO (Zwift workout) parser.
//! Produces a flat list of timed segments; power values are fractions of FTP.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextEvent {
    pub t: f64,
    pub msg: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub idx: u32,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub start: u32,
    pub duration: u32,
    /// start power (fraction of FTP); `None` = free ride
    pub p0: Option<f64>,
    /// end power (fraction of FTP)
    pub p1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_low: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cadence_high: Option<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub free_ride: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rep: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reps: Option<u32>,
    pub texts: Vec<TextEvent>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Workout {
    pub name: String,
    pub author: String,
    pub description: String,
    pub tags: Vec<String>,
    pub segments: Vec<Segment>,
    pub duration: u32,
}

/// Attribute lookup, case-insensitive (files in the wild vary: `Power`, `power`, `OnPower`, …).
fn attr<'a>(n: &roxmltree::Node<'a, '_>, name: &str) -> Option<&'a str> {
    n.attributes().find(|a| a.name().eq_ignore_ascii_case(name)).map(|a| a.value())
}

fn num(n: &roxmltree::Node, name: &str) -> Option<f64> {
    attr(n, name).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// Zwift stores power as a fraction of FTP; some third-party files use percent.
fn frac(n: &roxmltree::Node, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|k| num(n, k)).map(|v| if v > 5.0 { v / 100.0 } else { v })
}

fn dur(n: &roxmltree::Node, name: &str) -> u32 {
    num(n, name).map(|v| v.round().max(0.0) as u32).unwrap_or(0)
}

struct Cad {
    cadence: Option<u32>,
    low: Option<u32>,
    high: Option<u32>,
}

fn cadence_of(n: &roxmltree::Node) -> Cad {
    let c = num(n, "Cadence").filter(|v| *v > 0.0);
    let lo = num(n, "CadenceLow").filter(|v| *v > 0.0);
    let hi = num(n, "CadenceHigh").filter(|v| *v > 0.0);
    match (c, lo, hi) {
        (Some(c), _, _) => Cad { cadence: Some(c.round() as u32), low: None, high: None },
        (None, Some(l), Some(h)) => Cad { cadence: Some(((l + h) / 2.0).round() as u32), low: Some(l as u32), high: Some(h as u32) },
        _ => Cad { cadence: None, low: None, high: None },
    }
}

fn child_text(root: &roxmltree::Node, tag: &str) -> String {
    root.children()
        .find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case(tag))
        .and_then(|c| c.text())
        .map(|t| t.trim().to_string())
        .unwrap_or_default()
}

/// Escape stray `&` that are not entities — common in hand-made ZWO files.
fn sanitize(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() + 16);
    let b = xml.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'&' {
            let rest = &xml[i + 1..];
            let ok = rest.find(';').map(|e| e <= 8 && rest[..e].chars().all(|c| c.is_ascii_alphanumeric() || c == '#')).unwrap_or(false);
            out.push_str(if ok { "&" } else { "&amp;" });
            i += 1;
        } else {
            let ch = xml[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

pub fn parse(xml: &str) -> Result<Workout, String> {
    let xml = xml.trim_start_matches('\u{feff}');
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => {
            let fixed = sanitize(xml);
            return parse_doc(&roxmltree::Document::parse(&fixed).map_err(|e| e.to_string())?);
        }
    };
    parse_doc(&doc)
}

fn parse_doc(doc: &roxmltree::Document) -> Result<Workout, String> {
    let root = doc.root_element();
    let mut w = Workout {
        name: child_text(&root, "name"),
        author: child_text(&root, "author"),
        description: child_text(&root, "description"),
        tags: root
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name().eq_ignore_ascii_case("tag"))
            .filter_map(|n| attr(&n, "name").map(str::to_string))
            .collect(),
        ..Default::default()
    };

    let Some(body) = root.children().find(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("workout")) else {
        return Ok(w);
    };

    let mut t: u32 = 0;
    let mut block: u32 = 0;
    let mut global_texts: Vec<TextEvent> = vec![];

    let push = |segs: &mut Vec<Segment>, mut s: Segment, texts: Vec<TextEvent>, t: &mut u32| {
        s.start = *t;
        s.texts = texts.into_iter().filter(|x| x.t < s.duration as f64).collect();
        *t += s.duration;
        segs.push(s);
    };

    let mut segments = vec![];
    for el in body.children().filter(|c| c.is_element()) {
        let tag = el.tag_name().name().to_ascii_lowercase();
        let texts: Vec<TextEvent> = el
            .children()
            .filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("textevent"))
            .map(|c| TextEvent { t: num(&c, "timeoffset").unwrap_or(0.0), msg: attr(&c, "message").unwrap_or("").to_string() })
            .collect();

        if tag == "textevent" {
            global_texts.push(TextEvent { t: num(&el, "timeoffset").unwrap_or(0.0), msg: attr(&el, "message").unwrap_or("").to_string() });
            continue;
        }

        let base = |kind: &'static str, label: String, d: u32, p0: Option<f64>, p1: Option<f64>, cad: Cad| Segment {
            idx: 0, label, kind, start: 0, duration: d, p0, p1,
            cadence: cad.cadence, cadence_low: cad.low, cadence_high: cad.high,
            free_ride: false, rep: None, reps: None, texts: vec![],
        };

        match tag.as_str() {
            "steadystate" | "solidstate" => {
                block += 1;
                let p = frac(&el, &["Power", "PowerLow"]);
                let mut s = base("steady", block.to_string(), dur(&el, "Duration"), p, p, cadence_of(&el));
                s.idx = block;
                push(&mut segments, s, texts, &mut t);
            }
            "warmup" | "cooldown" | "ramp" => {
                // Zwift semantics: PowerLow is the start value, PowerHigh the end value.
                block += 1;
                let kind = match tag.as_str() { "warmup" => "warmup", "cooldown" => "cooldown", _ => "ramp" };
                let mut s = base(kind, block.to_string(), dur(&el, "Duration"), frac(&el, &["PowerLow"]), frac(&el, &["PowerHigh"]), cadence_of(&el));
                s.idx = block;
                push(&mut segments, s, texts, &mut t);
            }
            "intervalst" => {
                block += 1;
                let reps = num(&el, "Repeat").map(|v| v.round().max(1.0) as u32).unwrap_or(1);
                let on_d = dur(&el, "OnDuration");
                let off_d = dur(&el, "OffDuration");
                let on_p = frac(&el, &["OnPower", "PowerOnHigh", "PowerOnLow"]);
                let off_p = frac(&el, &["OffPower", "PowerOffHigh", "PowerOffLow"]);
                let off_cad = num(&el, "CadenceResting").filter(|v| *v > 0.0).map(|v| v.round() as u32);
                let period = (on_d + off_d) as f64;
                for r in 0..reps {
                    let b = r as f64 * period;
                    // textevents inside IntervalsT are relative to the whole block
                    let t_on = texts.iter().filter(|x| x.t >= b && x.t < b + on_d as f64).map(|x| TextEvent { t: x.t - b, msg: x.msg.clone() }).collect();
                    let t_off = texts.iter().filter(|x| x.t >= b + on_d as f64 && x.t < b + period).map(|x| TextEvent { t: x.t - b - on_d as f64, msg: x.msg.clone() }).collect();
                    if on_d > 0 {
                        let mut s = base("on", format!("{block}.1"), on_d, on_p, on_p, cadence_of(&el));
                        s.idx = block; s.rep = Some(r + 1); s.reps = Some(reps);
                        push(&mut segments, s, t_on, &mut t);
                    }
                    if off_d > 0 {
                        let mut s = base("off", format!("{block}.2"), off_d, off_p, off_p, Cad { cadence: off_cad, low: None, high: None });
                        s.idx = block; s.rep = Some(r + 1); s.reps = Some(reps);
                        push(&mut segments, s, t_off, &mut t);
                    }
                }
            }
            "freeride" | "maxeffort" => {
                block += 1;
                let kind = if tag == "maxeffort" { "maxeffort" } else { "freeride" };
                let mut s = base(kind, block.to_string(), dur(&el, "Duration"), None, None, cadence_of(&el));
                s.idx = block;
                s.free_ride = true;
                push(&mut segments, s, texts, &mut t);
            }
            _ => {} // unknown element — ignore
        }
    }

    // workout-level text events use absolute offsets
    for g in global_texts {
        if let Some(s) = segments.iter_mut().find(|s| g.t >= s.start as f64 && g.t < (s.start + s.duration) as f64) {
            s.texts.push(TextEvent { t: g.t - s.start as f64, msg: g.msg });
        }
    }
    for s in &mut segments {
        s.texts.sort_by(|a, b| a.t.total_cmp(&b.t));
    }

    w.duration = t;
    w.segments = segments;
    Ok(w)
}

/// Standard zone limits (fraction of FTP) used to classify workouts at parse time:
/// Z1 Recovery ≤55 % · Z2 Base endurance ≤75 % · Z3 Tempo ≤90 % · Z4 Threshold ≤105 % · Z5 VO2max >105 %
pub const ZONE_LIMITS: [f64; 4] = [0.55, 0.75, 0.90, 1.05];

fn zone_index(p: f64) -> usize {
    ZONE_LIMITS.iter().position(|&l| p <= l + 1e-9).unwrap_or(4)
}

/// Seconds spent in each of the five zones (free-ride segments are not counted).
pub fn zone_seconds(segments: &[Segment]) -> [u32; 5] {
    let mut out = [0u32; 5];
    for s in segments {
        let (Some(p0), Some(p1)) = (s.p0, s.p1) else { continue };
        let d = s.duration.max(1);
        for i in 0..d {
            let p = p0 + (p1 - p0) * ((i as f64 + 0.5) / d as f64);
            out[zone_index(p)] += 1;
        }
    }
    out
}

/// The workout's training intensity (1–5): the highest zone the workout spends real time in —
/// at least 60 s and 8 % of its structured time — so a VO2max session with 5×3 min at 115 %
/// counts as Z5 even though most of it is warm-up and recovery.
pub fn main_zone(zone_time: &[u32; 5]) -> u8 {
    let work: u32 = zone_time.iter().sum();
    if work == 0 {
        return 2; // pure free ride → endurance
    }
    let need = (work as f64 * 0.08).max(60.0) as u32;
    for z in (1..5).rev() {
        if zone_time[z] >= need {
            return z as u8 + 1;
        }
    }
    1
}

/// Workout intensity from its segments: free-ride time (ridden by feel) counts as base endurance.
pub fn classify(segments: &[Segment]) -> u8 {
    let mut zt = zone_seconds(segments);
    let free: u32 = segments.iter().filter(|s| s.p0.is_none()).map(|s| s.duration).sum();
    zt[1] += free;
    main_zone(&zt)
}

/// Rough training stress estimate (IF² × hours × 100); free rides counted at 60 %.
pub fn estimate_tss(segments: &[Segment]) -> u32 {
    let (mut sum, mut total) = (0.0f64, 0.0f64);
    for s in segments {
        let (p0, p1) = (s.p0.unwrap_or(0.6), s.p1.unwrap_or(0.6));
        let d = s.duration as f64;
        let steps = ((d / 15.0).round() as i64).clamp(1, 20) as usize;
        for i in 0..steps {
            let p = p0 + (p1 - p0) * ((i as f64 + 0.5) / steps as f64);
            sum += p.powi(4) * (d / steps as f64);
        }
        total += d;
    }
    if total == 0.0 {
        return 0;
    }
    let intensity = (sum / total).powf(0.25);
    (intensity * intensity * (total / 3600.0) * 100.0).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(d: u32, p0: f64, p1: f64) -> Segment {
        Segment { idx: 0, label: String::new(), kind: "steady", start: 0, duration: d, p0: Some(p0), p1: Some(p1), cadence: None, cadence_low: None, cadence_high: None, free_ride: false, rep: None, reps: None, texts: vec![] }
    }

    #[test]
    fn zones_and_main_zone() {
        // 10' warm-up 50→70 %, 5×3' @ 115 % with 3' @ 50 %, 10' cool-down
        let mut segs = vec![seg(600, 0.5, 0.7)];
        for _ in 0..5 { segs.push(seg(180, 1.15, 1.15)); segs.push(seg(180, 0.5, 0.5)); }
        segs.push(seg(600, 0.6, 0.45));
        let z = zone_seconds(&segs);
        assert_eq!(z[4], 900);
        assert_eq!(main_zone(&z), 5);
        assert_eq!(main_zone(&zone_seconds(&[seg(3600, 0.65, 0.65)])), 2);
        assert_eq!(main_zone(&zone_seconds(&[seg(1800, 0.5, 0.5)])), 1);
        assert_eq!(main_zone(&zone_seconds(&[seg(600, 0.6, 0.6), seg(2400, 0.95, 0.95)])), 4);
        assert_eq!(main_zone(&zone_seconds(&[seg(600, 0.6, 0.6), seg(1800, 0.85, 0.85)])), 3);
        let mut free = seg(3600, 0.0, 0.0);
        free.p0 = None; free.p1 = None;
        assert_eq!(classify(&[seg(300, 0.4, 0.5), free, seg(300, 0.5, 0.4)]), 2);
    }

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<workout_file><author>WhatsOnZwift</author><name>Test</name><description>d</description>
<tags><tag name="A"/></tags>
<workout>
  <Warmup Duration="300" PowerLow="0.42" PowerHigh="0.70"/>
  <SteadyState Duration="10" Power="1.75" Cadence="110"><textevent timeoffset="2" message="Go!"/></SteadyState>
  <IntervalsT Repeat="4" OnDuration="300" OffDuration="60" OnPower="0.80" OffPower="0.61"/>
  <FreeRide Duration="600" FlatRoad="1"/>
  <Cooldown Duration="300" PowerLow="0.75" PowerHigh="0.65"/>
</workout></workout_file>"#;

    #[test]
    fn parses_elements() {
        let w = parse(SAMPLE).unwrap();
        assert_eq!(w.duration, 300 + 10 + 4 * 360 + 600 + 300);
        assert_eq!(w.segments.len(), 1 + 1 + 8 + 1 + 1);
        assert_eq!(w.segments[1].texts, vec![TextEvent { t: 2.0, msg: "Go!".into() }]);
        assert_eq!(w.segments[1].cadence, Some(110));
        assert_eq!(w.segments[2].label, "3.1");
        assert_eq!(w.segments[3].label, "3.2");
        assert!(w.segments[10].free_ride);
        let cd = w.segments.last().unwrap();
        assert_eq!((cd.p0, cd.p1), (Some(0.75), Some(0.65)));
        assert_eq!(w.tags, vec!["A"]);
    }

    #[test]
    fn tolerates_stray_ampersand() {
        let w = parse(&SAMPLE.replace("<name>Test</name>", "<name>Fit & Fun</name>")).unwrap();
        assert_eq!(w.name, "Fit & Fun");
    }
}
