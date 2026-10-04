import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { platformPaths, macHostScript, HOST_NAME } from '../scripts/platform.mjs';

test('windows paths stay where the existing installer put them', () => {
  const p = platformPaths({ platform: 'win32', env: { LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`, PROGRAMFILES: String.raw`C:\Program Files` }, home: String.raw`C:\Users\u` });
  assert.equal(p.installRoot, String.raw`C:\Users\u\AppData\Local\KlasSummarizer`);
  assert.equal(p.chromeCandidates[0], String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`);
  assert.equal(p.hostManifestDir, null);
  assert.equal(p.hostLauncher, 'host.bat');
});

test('macOS paths use Application Support and the Chrome NativeMessagingHosts folder', () => {
  const p = platformPaths({ platform: 'darwin', env: {}, home: '/Users/kw' });
  assert.equal(p.installRoot, '/Users/kw/Library/Application Support/KlasSummarizer');
  assert.equal(p.hostManifestDir, '/Users/kw/Library/Application Support/Google/Chrome/NativeMessagingHosts');
  assert.equal(p.chromeCandidates[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.match(p.helperRoot, /\/Google\/Chrome\/Default\/Extensions\/jicidjkhiefbhbgbfbemakjndloecjlf$/);
  assert.equal(p.hostLauncher, 'host.sh');
});

test('unsupported platforms fail clearly', () => {
  assert.throws(() => platformPaths({ platform: 'linux', env: {}, home: '/home/u' }), /Windows 또는 macOS/);
});

test('mac host script quotes paths with spaces and quotes, and is valid sh', () => {
  const s = macHostScript({ nodePath: '/opt/homebrew/bin/node', hostPath: "/Users/k w/Library/Application Support/KlasSummarizer/host.mjs", home: "/Users/k'w" });
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.match(s, /exec '\/opt\/homebrew\/bin\/node' '\/Users\/k w\/Library\/Application Support\/KlasSummarizer\/host\.mjs'/);
  assert.ok(s.includes(String.raw`'/Users/k'\''w/.local/bin'`), s);
  const check = spawnSync('sh', ['-n'], { input: s, encoding: 'utf8' });
  if (!check.error) assert.equal(check.status, 0, check.stderr);
  assert.equal(HOST_NAME, 'com.klas_summarizer.host');
});

test('launcher liveness ignores missing, invalid and dead pid files', async () => {
  const { isLauncherAlive } = await import('../scripts/platform.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klas-pid-'));
  const f = path.join(dir, 'Chrome-launch.pid');
  assert.equal(isLauncherAlive(f), false);
  fs.writeFileSync(f, 'abc'); assert.equal(isLauncherAlive(f), false);
  fs.writeFileSync(f, '999999'); assert.equal(isLauncherAlive(f), false);
  fs.writeFileSync(f, String(process.pid)); assert.equal(isLauncherAlive(f), false, 'a live pid that is not chrome-launch must not count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transcript survives when no slide was captured', async () => {
  const { groupBySlide } = await import('../extension/src/core/pack.js');
  const g = groupBySlide([], [{ start: 0, end: 3, text: 'a' }, { start: 3, end: 9, text: 'b' }]);
  assert.equal(g.length, 1); assert.equal(g[0].segs.length, 2); assert.equal(g[0].end, 9); assert.equal(g[0].blob, null);
  assert.equal(groupBySlide([], []).length, 0);
});
