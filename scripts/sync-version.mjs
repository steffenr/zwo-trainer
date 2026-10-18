// Set the app version everywhere it lives. No npm project needed — plain Node.
//
//   node scripts/sync-version.mjs            → print the current version
//   node scripts/sync-version.mjs <x.y.z>    → write it
//
// src-tauri/Cargo.toml [package] version is the single source of truth: tauri.conf.json has
// no "version", so Tauri takes it from Cargo.toml for the binary, the installers and their
// file names. Cargo.lock's entry for the zwotrainer package is kept in step so
// `cargo build --locked` stays happy.
import { readFileSync, writeFileSync } from 'node:fs';

const TOML = 'src-tauri/Cargo.toml';
const LOCK = 'src-tauri/Cargo.lock';
const PKG_RE = /^(\[package\][\s\S]*?^version = ")([^"]*)(")/m;

const version = process.argv[2];
if (!version) {
  const m = readFileSync(TOML, 'utf8').match(PKG_RE);
  if (!m) { console.error(`sync-version: no [package] version in ${TOML}`); process.exit(1); }
  console.log(m[2]);
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/sync-version.mjs [x.y.z]');
  process.exit(1);
}

function update(path, re) {
  const before = readFileSync(path, 'utf8');
  if (!re.test(before)) { console.error(`sync-version: could not find the version in ${path}`); process.exit(1); }
  writeFileSync(path, before.replace(re, `$1${version}$3`));
  console.log(`updated ${path} -> ${version}`);
}

update(TOML, PKG_RE);
update(LOCK, /(\[\[package\]\]\r?\nname = "zwotrainer"\r?\nversion = ")([^"]*)(")/);
