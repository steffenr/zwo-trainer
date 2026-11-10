// Ride sounds: the synthesized countdown beep plus three bundled recordings in ui/sounds/ (CC0).
// power-up / power-down hold a whole 3-2-1 countdown: three short notes about 1 s apart.
// Each countdown tick plays only its own note, so pausing or seeking never leaves a cue running.
// The note starts are measured in the decoded audio: MP3 decoders add a short, decoder-specific
// delay at the start, so fixed offsets of 0 / 1 / 2 s would cut into the notes.
const FILES = { up: 'sounds/power-up.mp3', down: 'sounds/power-down.mp3', done: 'sounds/workout-done.mp3' };
const ready = {}; // name → { buf, at: [note start in s, …] } once decoded
const loading = {};
let ctx;

function audio() {
  ctx ||= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Start times (s) of the notes in a buffer: sound after at least 0.3 s of near-silence. */
export function noteStarts(data, rate, threshold = 0.02, gap = 0.3) {
  const at = [];
  let quiet = Infinity;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) >= threshold) {
      if (quiet >= gap * rate) at.push(i / rate);
      quiet = 0;
    } else quiet++;
  }
  return at;
}

/** Decode the named sounds in the background (once); until then the plain beep is used. */
export function loadSounds(names) {
  for (const n of names) {
    if (loading[n]) continue;
    loading[n] = fetch(FILES[n])
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((b) => audio().decodeAudioData(b))
      .then((buf) => { ready[n] = { buf, at: noteStarts(buf.getChannelData(0), buf.sampleRate) }; })
      .catch(() => { delete loading[n]; }); // audio is optional; retried on the next ride
  }
}

function play(buf, offset, duration, gain) {
  const c = audio(), src = c.createBufferSource(), g = c.createGain();
  src.buffer = buf;
  g.gain.value = gain;
  src.connect(g).connect(c.destination);
  src.start(0, offset, duration);
}

export function beep(freq) {
  try {
    const c = audio(), o = c.createOscillator(), g = c.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.2);
  } catch { /* audio optional */ }
}

/** One countdown tick: `sec` is 3, 2 or 1; `dir` 'up' / 'down' plays the rising / falling note, null the beep. */
export function countdown(sec, dir) {
  try {
    const s = dir && ready[dir], at = s?.at[3 - sec];
    if (s && s.at.length === 3) return play(s.buf, at, 0.8, 0.9);
  } catch { /* fall back to the beep */ }
  beep(sec === 1 ? 880 : 660);
}

/** The end-of-workout chime (silent if it couldn't be loaded). */
export function endChime() {
  try { if (ready.done) play(ready.done.buf, 0, ready.done.buf.duration, 0.7); } catch { /* audio optional */ }
}
