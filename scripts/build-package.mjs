// 학생 배포용 ZIP(Windows·macOS 공용)을 만든다: downloads/klasnote-<버전>.zip
// 사용: node scripts/vendor.mjs (최초 1회, node_modules 필요) → node scripts/build-package.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkSource } from './setup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = checkSource(root); // 필수 파일(vendor 포함)이 없으면 여기서 멈춘다
const stage = path.join(root, 'dist', 'klasnote');
const out = path.join(root, 'downloads', `klasnote-${version}.zip`);
const include = ['extension', 'native-host/host.mjs', 'native-host/groq.mjs', 'scripts/platform.mjs', 'scripts/setup.mjs', 'scripts/start.mjs', 'scripts/chrome-launch.mjs',
  'start.cmd', 'install.cmd', 'uninstall.ps1', 'start.command', 'install.command', 'uninstall.command', 'README.md', 'docs/licenses', 'docs/images', 'package.json'];

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
for (const item of include) {
  const from = path.join(root, item);
  if (!fs.existsSync(from)) throw Error(`누락: ${item}`);
  fs.cpSync(from, path.join(stage, item), { recursive: true });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
// Windows PowerShell 5.1의 Compress-Archive는 경로를 역슬래시로 저장해 macOS에서 폴더 구조가 깨진다.
// Windows 10 이상 내장 tar(bsdtar)로 표준 zip(슬래시 경로)을 만든다.
const r = process.platform === 'win32'
  // PATH의 다른 tar(Git의 GNU tar)는 'C:'를 원격 호스트로 해석하므로 System32의 bsdtar를 직접 지정한다.
  ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', out, 'klasnote'], { cwd: path.dirname(stage), stdio: 'inherit' })
  : spawnSync('zip', ['-qr', out, 'klasnote'], { cwd: path.dirname(stage), stdio: 'inherit' });
if (r.status !== 0) throw Error('ZIP 생성 실패');
console.log(`만들었습니다: ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
