// OS별 경로를 한곳에 모은다. Windows와 macOS를 지원한다.
// 인자를 받는 순수 함수라서 Windows에서도 macOS 경로를 테스트할 수 있다.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const HOST_NAME = 'com.klas_summarizer.host';
export const EXTENSION_ID = 'klihhclhnhhmldcbnkpampimkjafmbdm';
export const HELPER_ID = 'jicidjkhiefbhbgbfbemakjndloecjlf'; // KLAS Helper (있으면 같은 창에 함께 연결)

export function platformPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const p = path.win32;
    if (!env.LOCALAPPDATA) throw Error('LOCALAPPDATA 환경 변수가 없습니다.');
    const local = env.LOCALAPPDATA;
    return {
      platform,
      installRoot: p.join(local, 'KlasSummarizer'),
      chromeCandidates: [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], local].filter(Boolean)
        .map((d) => p.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      helperRoot: p.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', HELPER_ID),
      // Windows는 레지스트리가 설치 폴더 안의 manifest를 가리킨다.
      hostManifestDir: null,
      hostLauncher: 'host.bat',
    };
  }
  if (platform === 'darwin') {
    const p = path.posix;
    const support = p.join(home, 'Library', 'Application Support');
    return {
      platform,
      installRoot: p.join(support, 'KlasSummarizer'),
      chromeCandidates: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        p.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      ],
      helperRoot: p.join(support, 'Google', 'Chrome', 'Default', 'Extensions', HELPER_ID),
      // macOS는 이 폴더의 manifest 파일 자체가 등록이다(레지스트리 없음).
      hostManifestDir: p.join(support, 'Google', 'Chrome', 'NativeMessagingHosts'),
      hostLauncher: 'host.sh',
    };
  }
  throw Error('Windows 또는 macOS에서 실행하세요.');
}

// 저장된 PID가 살아 있고, 그 프로세스가 정말 우리 실행기(chrome-launch)인지 확인한다(독립 검토 F9).
// Windows 강제 종료 뒤 남은 PID 파일이 다른 프로세스 번호와 겹쳐도 속지 않는다.
export function isLauncherAlive(pidFile, { platform = process.platform } = {}) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const r = platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (r.error || typeof r.stdout !== 'string') return true; // 확인 수단이 없으면 보수적으로 살아 있다고 본다
  return r.stdout.includes('chrome-launch');
}

// macOS용 host 실행 스크립트. Chrome이 Finder에서 실행되면 PATH가 짧아 node·claude·codex를 못 찾으므로 보강한다.
export function macHostScript({ nodePath, hostPath, home }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const extra = [path.posix.dirname(nodePath), `${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'].map(q).join(':');
  return `#!/bin/sh\nexport PATH=${extra}:"$PATH"\nexec ${q(nodePath)} ${q(hostPath)}\n`;
}
