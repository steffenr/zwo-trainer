// node --test scripts/updater-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./updater-manifest.mjs', import.meta.url).pathname;
// the files of a full release (v1.7.0), each with its signature
const FILES = [
  'zwoTrainer_1.8.0_aarch64.app.tar.gz', 'zwoTrainer_1.8.0_x64.app.tar.gz', 'zwoTrainer_1.8.0_x64-setup.exe',
  'zwoTrainer_1.8.0_x64_en-US.msi', 'zwoTrainer_1.8.0_amd64.AppImage', 'zwoTrainer_1.8.0_amd64.deb', 'zwoTrainer-1.8.0-1.x86_64.rpm',
];

function release(skipSig = []) {
  const dir = mkdtempSync(join(tmpdir(), 'zt-manifest-'));
  for (const f of FILES) {
    writeFileSync(join(dir, f), 'x');
    if (!skipSig.includes(f)) writeFileSync(join(dir, `${f}.sig`), `sig of ${f}\n`);
  }
  writeFileSync(join(dir, 'zwoTrainer_1.8.0_x64.dmg'), 'x'); // no updater file: ignored
  return dir;
}

test('a full release lists every platform', () => {
  const dir = release();
  const m = JSON.parse(execFileSync('node', [SCRIPT, dir, 'v1.8.0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(m.version, '1.8.0');
  assert.deepEqual(Object.keys(m.platforms).sort(), [
    'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app', 'linux-x86_64', 'linux-x86_64-appimage',
    'linux-x86_64-deb', 'linux-x86_64-rpm', 'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis',
  ]);
  assert.equal(m.platforms['linux-x86_64-deb'].signature, 'sig of zwoTrainer_1.8.0_amd64.deb');
  rmSync(dir, { recursive: true });
});

test('a missing signature fails the run', () => {
  const dir = release(['zwoTrainer_1.8.0_amd64.deb']);
  const r = spawnSync('node', [SCRIPT, dir, 'v1.8.0'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /amd64\.deb has no \.sig/);
  rmSync(dir, { recursive: true });
});

test('a missing installer fails the run', () => {
  const dir = release();
  rmSync(join(dir, 'zwoTrainer-1.8.0-1.x86_64.rpm'));
  rmSync(join(dir, 'zwoTrainer-1.8.0-1.x86_64.rpm.sig'));
  const r = spawnSync('node', [SCRIPT, dir, 'v1.8.0'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /linux-x86_64-rpm: no signed update file/);
  rmSync(dir, { recursive: true });
});
