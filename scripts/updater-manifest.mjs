// Write latest.json, the manifest the in-app updater reads from the newest GitHub release.
// No npm project needed — plain Node.
//
//   node scripts/updater-manifest.mjs <release-dir> <tag> [notes.md] > latest.json
//
// <release-dir> holds the installers and the updater files next to their .sig signatures
// (created by `tauri build` with tauri.updater.conf.json and TAURI_SIGNING_PRIVATE_KEY).
// Each signed file becomes a platform entry; the signature text goes into the manifest
// itself. The updater looks for "{os}-{arch}-{bundle}" first, then "{os}-{arch}", so every
// install type updates in kind (an .msi install stays an .msi install), and the plain key
// points to the default bundle of that platform.
//
// Download URLs point at the release assets: https://github.com/<repo>/releases/download/<tag>/<file>
// (repo from $GITHUB_REPOSITORY, default steffenr/zwo-trainer).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, notesFile] = process.argv.slice(2);
if (!dir || !tag) {
  console.error('usage: node scripts/updater-manifest.mjs <release-dir> <tag> [notes.md]');
  process.exit(1);
}

// file pattern → [platform key with bundle type, plain fallback key or null]
const RULES = [
  [/_aarch64\.app\.tar\.gz$/, 'darwin-aarch64-app', 'darwin-aarch64'],
  [/_x64\.app\.tar\.gz$/, 'darwin-x86_64-app', 'darwin-x86_64'],
  [/_x64-setup\.exe$/, 'windows-x86_64-nsis', 'windows-x86_64'],
  [/_x64_[^_]+\.msi$/, 'windows-x86_64-msi', null],
  [/_amd64\.AppImage$/, 'linux-x86_64-appimage', 'linux-x86_64'],
  [/_amd64\.deb$/, 'linux-x86_64-deb', null],
  [/\.x86_64\.rpm$/, 'linux-x86_64-rpm', null],
];

const repo = process.env.GITHUB_REPOSITORY || 'steffenr/zwo-trainer';
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const version = tag.replace(/^v/, '');
const platforms = {};

for (const file of readdirSync(dir).sort()) {
  const rule = RULES.find(([re]) => re.test(file));
  if (!rule) continue;
  const sig = join(dir, `${file}.sig`);
  if (!existsSync(sig)) { console.error(`updater-manifest: ${file} has no .sig — skipped`); continue; }
  const entry = {
    signature: readFileSync(sig, 'utf8').trim(),
    url: `${server}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`,
  };
  const [, key, plain] = rule;
  if (platforms[key]) { console.error(`updater-manifest: two files for ${key} (${file})`); process.exit(1); }
  platforms[key] = entry;
  if (plain) platforms[plain] = entry;
}

if (!Object.keys(platforms).length) {
  console.error(`updater-manifest: no signed update files in ${dir}`);
  process.exit(1);
}

// Release notes: the change list only, without the installer instructions above it.
let notes = '';
if (notesFile && existsSync(notesFile)) {
  notes = readFileSync(notesFile, 'utf8').trim();
}

const manifest = { version, notes, pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), platforms };
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
console.error(`updater-manifest: ${version} for ${Object.keys(platforms).sort().join(', ')}`);
