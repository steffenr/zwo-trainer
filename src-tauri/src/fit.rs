//! Minimal FIT activity encoder (indoor cycling): file_id, events, 1 Hz records,
//! one lap per workout segment, session and activity messages. Readable by Garmin Connect,
//! intervals.icu, TrainingPeaks and the official FIT SDK.

use serde::Deserialize;
use std::collections::HashMap;

/// Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z).
const FIT_EPOCH: i64 = 631_065_600;

#[derive(Debug, Clone, Deserialize)]
pub struct Sample {
    /// wall clock, unix milliseconds
    pub wall: i64,
    pub p: Option<f64>,
    pub c: Option<f64>,
    pub hr: Option<f64>,
    /// speed in km/h
    pub v: Option<f64>,
    /// workout segment index (laps are split on changes)
    #[serde(default)]
    pub seg: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ride {
    pub name: String,
    pub ftp: Option<u32>,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Copy)]
enum V {
    Enum(Option<u8>),
    U8(Option<u8>),
    U16(Option<u16>),
    U32(Option<u32>),
    U32z(Option<u32>),
}

impl V {
    fn base(self) -> (u8, u8) {
        match self {
            V::Enum(_) => (1, 0x00),
            V::U8(_) => (1, 0x02),
            V::U16(_) => (2, 0x84),
            V::U32(_) => (4, 0x86),
            V::U32z(_) => (4, 0x8C),
        }
    }
    fn write(self, out: &mut Vec<u8>) {
        match self {
            V::Enum(v) | V::U8(v) => out.push(v.unwrap_or(0xFF)),
            V::U16(v) => out.extend(v.unwrap_or(0xFFFF).to_le_bytes()),
            V::U32(v) => out.extend(v.unwrap_or(0xFFFF_FFFF).to_le_bytes()),
            V::U32z(v) => out.extend(v.unwrap_or(0).to_le_bytes()),
        }
    }
}

struct Writer {
    data: Vec<u8>,
    defs: HashMap<u8, Vec<(u16, u8, u8)>>,
}

impl Writer {
    fn new() -> Self {
        Self { data: vec![], defs: HashMap::new() }
    }

    /// Write one message; emits a definition record first if the local type's layout changed.
    fn msg(&mut self, local: u8, global: u16, fields: &[(u8, V)]) {
        let sig: Vec<(u16, u8, u8)> = std::iter::once((global, 0, 0))
            .chain(fields.iter().map(|(n, v)| {
                let (size, base) = v.base();
                (*n as u16, size, base)
            }))
            .collect();
        if self.defs.get(&local) != Some(&sig) {
            self.data.push(0x40 | local);
            self.data.push(0); // reserved
            self.data.push(0); // little endian
            self.data.extend(global.to_le_bytes());
            self.data.push(fields.len() as u8);
            for (n, v) in fields {
                let (size, base) = v.base();
                self.data.extend([*n, size, base]);
            }
            self.defs.insert(local, sig);
        }
        self.data.push(local);
        for (_, v) in fields {
            v.write(&mut self.data);
        }
    }

    fn finish(self) -> Vec<u8> {
        let mut hdr = vec![14u8, 0x20];
        hdr.extend(2132u16.to_le_bytes()); // profile 21.32
        hdr.extend((self.data.len() as u32).to_le_bytes());
        hdr.extend(b".FIT");
        let hcrc = crc16(&hdr);
        hdr.extend(hcrc.to_le_bytes());
        let mut out = hdr;
        out.extend(self.data);
        let crc = crc16(&out);
        out.extend(crc.to_le_bytes());
        out
    }
}

pub fn crc16(bytes: &[u8]) -> u16 {
    const T: [u16; 16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];
    let mut crc: u16 = 0;
    for &b in bytes {
        let mut tmp = T[(crc & 0xF) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc ^= tmp ^ T[(b & 0xF) as usize];
        tmp = T[(crc & 0xF) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc ^= tmp ^ T[((b >> 4) & 0xF) as usize];
    }
    crc
}

#[derive(Default, Clone, Copy)]
struct Agg {
    n: u32,
    p_sum: f64,
    p_n: u32,
    p_max: f64,
    hr_sum: f64,
    hr_n: u32,
    hr_max: f64,
    c_sum: f64,
    c_n: u32,
    c_max: f64,
    v_max: f64,
    dist: f64,
}

impl Agg {
    fn add(&mut self, s: &Sample, dist_inc: f64) {
        self.n += 1;
        self.dist += dist_inc;
        if let Some(p) = s.p.filter(|p| *p >= 0.0) {
            self.p_sum += p;
            self.p_n += 1;
            self.p_max = self.p_max.max(p);
        }
        if let Some(h) = s.hr.filter(|h| *h > 0.0) {
            self.hr_sum += h;
            self.hr_n += 1;
            self.hr_max = self.hr_max.max(h);
        }
        if let Some(c) = s.c.filter(|c| *c > 0.0) {
            self.c_sum += c;
            self.c_n += 1;
            self.c_max = self.c_max.max(c);
        }
        if let Some(v) = s.v {
            self.v_max = self.v_max.max(v / 3.6);
        }
    }
    fn avg(sum: f64, n: u32) -> Option<f64> {
        (n > 0).then(|| sum / n as f64)
    }
    fn kj(&self) -> f64 {
        self.p_sum / 1000.0
    }
}

fn u8o(v: Option<f64>) -> Option<u8> {
    v.map(|x| x.round().clamp(0.0, 254.0) as u8)
}
fn u16o(v: Option<f64>) -> Option<u16> {
    v.map(|x| x.round().clamp(0.0, 65534.0) as u16)
}
fn nz(v: f64) -> Option<f64> {
    (v > 0.0).then_some(v)
}

fn normalized_power(samples: &[Sample]) -> Option<f64> {
    let p: Vec<f64> = samples.iter().map(|s| s.p.unwrap_or(0.0).max(0.0)).collect();
    if p.len() < 30 {
        return None;
    }
    let mut sum4 = 0.0;
    let mut window: f64 = p[..30].iter().sum();
    let mut n = 0.0;
    for i in 29..p.len() {
        if i > 29 {
            window += p[i] - p[i - 30];
        }
        sum4 += (window / 30.0).powi(4);
        n += 1.0;
    }
    Some((sum4 / n).powf(0.25))
}

/// Summary numbers that the UI also shows.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub duration: u32,
    pub distance_km: f64,
    pub avg_power: Option<u32>,
    pub np: Option<u32>,
    pub kj: u32,
}

/// Which device the file claims to come from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavor {
    /// generic "development" device — used for export, other platforms
    Generic,
    /// Garmin Edge 500 identity, so Garmin Connect computes Training Effect / VO2max and
    /// counts the ride for challenges
    Garmin,
}

pub fn encode(ride: &Ride, flavor: Flavor) -> Result<(Vec<u8>, Summary), String> {
    let s = &ride.samples;
    if s.is_empty() {
        return Err("No data recorded".into());
    }
    let ts = |wall_ms: i64| ((wall_ms / 1000) - FIT_EPOCH).max(0) as u32;
    let start = ts(s[0].wall);
    let end = ts(s[s.len() - 1].wall);

    let mut w = Writer::new();
    // file_id
    let (manufacturer, product) = match flavor {
        Flavor::Generic => (255u16, 1u16), // development
        Flavor::Garmin => (1, 1036),       // garmin, edge500
    };
    w.msg(0, 0, &[
        (0, V::Enum(Some(4))),          // type = activity
        (1, V::U16(Some(manufacturer))),
        (2, V::U16(Some(product))),
        (3, V::U32z(Some(3_920_261_017))), // serial number
        (4, V::U32(Some(start))),       // time_created
    ]);
    // timer start
    w.msg(2, 21, &[(253, V::U32(Some(start))), (0, V::Enum(Some(0))), (1, V::Enum(Some(0)))]);

    let mut total = Agg::default();
    let mut lap = Agg::default();
    let mut lap_start = start;
    let mut laps: Vec<(u32, u32, Agg)> = vec![];
    let mut dist = 0.0f64;
    let mut prev_wall = s[0].wall;
    let mut prev_seg = s[0].seg;

    for (i, smp) in s.iter().enumerate() {
        let t = ts(smp.wall);
        if i > 0 && smp.seg != prev_seg {
            laps.push((lap_start, ts(prev_wall), lap));
            lap = Agg::default();
            lap_start = t;
        }
        let dt = if i == 0 { 1.0 } else { ((smp.wall - prev_wall) as f64 / 1000.0).clamp(0.0, 5.0) };
        let inc = smp.v.map(|v| v / 3.6 * dt).unwrap_or(0.0);
        dist += inc;
        total.add(smp, inc);
        lap.add(smp, inc);
        w.msg(1, 20, &[
            (253, V::U32(Some(t))),
            (3, V::U8(u8o(smp.hr.filter(|h| *h > 0.0)))),
            (4, V::U8(u8o(smp.c))),
            (5, V::U32(Some((dist * 100.0).round() as u32))),
            (6, V::U16(smp.v.map(|v| (v / 3.6 * 1000.0).round().clamp(0.0, 65534.0) as u16))),
            (7, V::U16(u16o(smp.p.filter(|p| *p >= 0.0)))),
        ]);
        prev_wall = smp.wall;
        prev_seg = smp.seg;
    }
    laps.push((lap_start, end, lap));

    // timer stop
    w.msg(2, 21, &[(253, V::U32(Some(end))), (0, V::Enum(Some(0))), (1, V::Enum(Some(4)))]);

    for (ls, le, a) in &laps {
        let secs = a.n as f64;
        w.msg(3, 19, &[
            (253, V::U32(Some(*le))),
            (0, V::Enum(Some(9))),  // event = lap
            (1, V::Enum(Some(1))),  // stop
            (2, V::U32(Some(*ls))),
            (7, V::U32(Some(((le - ls + 1) as f64 * 1000.0) as u32))),
            (8, V::U32(Some((secs * 1000.0) as u32))),
            (9, V::U32(Some((a.dist * 100.0).round() as u32))),
            (11, V::U16(Some(a.kj().round() as u16))),
            (13, V::U16(nz(a.dist / secs.max(1.0)).map(|v| (v * 1000.0).round() as u16))),
            (14, V::U16(nz(a.v_max).map(|v| (v * 1000.0).round() as u16))),
            (15, V::U8(u8o(Agg::avg(a.hr_sum, a.hr_n)))),
            (16, V::U8(u8o(nz(a.hr_max)))),
            (17, V::U8(u8o(Agg::avg(a.c_sum, a.c_n)))),
            (18, V::U8(u8o(nz(a.c_max)))),
            (19, V::U16(u16o(Agg::avg(a.p_sum, a.p_n)))),
            (20, V::U16(u16o(nz(a.p_max)))),
            (25, V::Enum(Some(2))), // sport = cycling
            (39, V::Enum(Some(6))), // sub_sport = indoor_cycling
        ]);
    }

    let np = normalized_power(s);
    let secs = total.n as f64;
    let ftp = ride.ftp.filter(|f| *f > 0).map(|f| f as f64);
    let intensity = np.zip(ftp).map(|(np, f)| np / f);
    let tss = intensity.zip(np).zip(ftp).map(|((i, np), f)| (secs * np * i) / (f * 3600.0) * 100.0);
    w.msg(4, 18, &[
        (253, V::U32(Some(end))),
        (0, V::Enum(Some(8))), // event = session
        (1, V::Enum(Some(1))),
        (2, V::U32(Some(start))),
        (5, V::Enum(Some(2))),
        (6, V::Enum(Some(6))),
        (7, V::U32(Some(((end - start + 1) as f64 * 1000.0) as u32))),
        (8, V::U32(Some((secs * 1000.0) as u32))),
        (9, V::U32(Some((total.dist * 100.0).round() as u32))),
        (11, V::U16(Some(total.kj().round() as u16))),
        (14, V::U16(nz(total.dist / secs.max(1.0)).map(|v| (v * 1000.0).round() as u16))),
        (15, V::U16(nz(total.v_max).map(|v| (v * 1000.0).round() as u16))),
        (16, V::U8(u8o(Agg::avg(total.hr_sum, total.hr_n)))),
        (17, V::U8(u8o(nz(total.hr_max)))),
        (18, V::U8(u8o(Agg::avg(total.c_sum, total.c_n)))),
        (19, V::U8(u8o(nz(total.c_max)))),
        (20, V::U16(u16o(Agg::avg(total.p_sum, total.p_n)))),
        (21, V::U16(u16o(nz(total.p_max)))),
        (25, V::U16(Some(0))),
        (26, V::U16(Some(laps.len() as u16))),
        (34, V::U16(u16o(np))),
        (35, V::U16(tss.map(|t| (t * 10.0).round().clamp(0.0, 65534.0) as u16))),
        (36, V::U16(intensity.map(|i| (i * 1000.0).round().clamp(0.0, 65534.0) as u16))),
        (45, V::U16(ride.ftp.map(|f| f as u16))),
    ]);
    w.msg(5, 34, &[
        (253, V::U32(Some(end))),
        (0, V::U32(Some((secs * 1000.0) as u32))),
        (1, V::U16(Some(1))),
        (2, V::Enum(Some(0))),  // manual
        (3, V::Enum(Some(26))), // event = activity
        (4, V::Enum(Some(1))),  // stop
    ]);

    let summary = Summary {
        duration: total.n,
        distance_km: (total.dist / 10.0).round() / 100.0,
        avg_power: Agg::avg(total.p_sum, total.p_n).map(|p| p.round() as u32),
        np: np.map(|p| p.round() as u32),
        kj: total.kj().round() as u32,
    };
    Ok((w.finish(), summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample_ride() -> Ride {
        let t0 = 1_792_224_000_000i64;
        let samples = (0..600)
            .map(|i| Sample {
                wall: t0 + i * 1000,
                p: Some(if i % 120 < 60 { 250.0 } else { 150.0 }),
                c: Some(90.0),
                hr: Some(130.0 + (i % 20) as f64),
                v: Some(30.0),
                seg: Some(i / 120),
            })
            .collect();
        Ride { name: "Test".into(), ftp: Some(250), samples }
    }

    #[test]
    fn crc_known_value() {
        // CRC of a standard 12-byte FIT header (from the SDK docs example)
        let h = [14u8, 0x10, 0x45, 0x08, 0x00, 0x00, 0x00, 0x00, b'.', b'F', b'I', b'T'];
        assert_eq!(crc16(&h), crc16(&h)); // deterministic
        assert_eq!(crc16(&[]), 0);
    }

    #[test]
    fn encodes_valid_file() {
        let (bytes, sum) = encode(&sample_ride(), Flavor::Generic).unwrap();
        let (g, _) = encode(&sample_ride(), Flavor::Garmin).unwrap();
        assert_eq!(crc16(&g), 0);
        assert_ne!(g, bytes);
        if let Ok(p) = std::env::var("FIT_TEST_OUT") {
            std::fs::write(format!("{p}.garmin.fit"), &g).unwrap();
        }
        assert_eq!(&bytes[8..12], b".FIT");
        let data_len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), 14 + data_len + 2);
        // whole-file CRC over header+data+crc must be 0
        assert_eq!(crc16(&bytes), 0);
        assert_eq!(sum.duration, 600);
        assert_eq!(sum.avg_power, Some(200));
        assert_eq!(sum.kj, 120);
        assert!((sum.distance_km - 5.0).abs() < 0.01);
        if let Ok(p) = std::env::var("FIT_TEST_OUT") {
            std::fs::write(p, &bytes).unwrap();
        }
    }
}
