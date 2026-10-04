// Chrome native messaging host: 확장의 요청을 받아 이 PC에 로그인된 claude 또는 codex CLI로 요약을 실행한다.
// 보안 원칙
// - 명령은 detect / test / summarize 세 가지만 받는다. 실행 파일과 인자는 여기서 고정한다.
// - shell을 거치지 않고 실행 파일을 직접 띄운다. 강의 내용(프롬프트·이미지)은 인자가 아니라 stdin·임시 파일로만 넘긴다.
// - CLI의 도구(파일 수정·명령 실행)는 끄거나 읽기 전용으로 둔다. 작업 폴더는 매번 새 빈 임시 폴더이며 끝나면 지운다.
// - 계정 정보는 다루지 않는다. 각 CLI가 이미 가진 로그인을 그대로 쓴다.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CLAUDE_MODELS = new Set(['haiku', 'sonnet', 'opus']);
const CODEX_MODEL = 'gpt-5.6-terra'; // 사용자 결정: Codex는 Terra 고정
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROMPT = 400_000; // 문자
const MAX_IMAGES = 80;
const MAX_IMAGE_B64 = 3_000_000;

// ---- native messaging 입출력 (4바이트 길이 + JSON) ----
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const raw = buf.subarray(4, 4 + n).toString('utf8');
    buf = buf.subarray(4 + n);
    let msg;
    try { msg = JSON.parse(raw); } catch { send({ ok: false, error: 'bad json' }); continue; }
    handle(msg).then(send, (e) => send({ ok: false, error: String(e?.message || e).slice(0, 2000) }));
  }
});
// Chrome이 연결을 끊으면 실행 중인 CLI를 종료하고 임시 폴더를 지운 뒤 끝낸다(레드팀 R4).
const children = new Set();
const tempDirs = new Set();
function cleanupAndExit() {
  for (const p of children) { try { p.kill(); } catch {} }
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(0);
}
process.stdin.on('end', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('SIGINT', cleanupAndExit);

function makeTemp() {
  const d = mkdtempSync(join(tmpdir(), 'klas-sum-'));
  tempDirs.add(d);
  return d;
}
function dropTemp(d) {
  rmSync(d, { recursive: true, force: true });
  tempDirs.delete(d);
}

function send(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  process.stdout.write(Buffer.concat([h, b]));
}

// ---- 실행 파일 찾기 (Windows·macOS). 반환: { cmd, pre } — pre는 cmd 뒤에 붙는 고정 인자(예: node가 실행할 .js) ----
const WIN = process.platform === 'win32';

function readHostConfig() {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'host-config.json'), 'utf8')) || {}; } catch { return {}; }
}

// npm 전역 모듈 폴더. Windows: <prefix>\node_modules, macOS: <prefix>/lib/node_modules
// (prefix는 이 host를 실행한 node 기준이라 Homebrew·nvm·공식 설치 모두 잡힌다)
function npmModuleDirs() {
  const dirs = [];
  if (WIN) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm', 'node_modules'));
    dirs.push(join(dirname(process.execPath), 'node_modules')); // nvm-windows 등: 전역 모듈이 node 옆에 있음
    const cfg = readHostConfig(); if (cfg.npmPrefix) dirs.push(join(cfg.npmPrefix, 'node_modules')); // 설치 때 기록한 npm prefix -g (독립 검토 F11)
    if (process.env.npm_config_prefix) dirs.push(join(process.env.npm_config_prefix, 'node_modules'));
  } else {
    const nodePrefix = dirname(dirname(process.execPath));
    dirs.push(join(nodePrefix, 'lib', 'node_modules'), join(homedir(), '.npm-global', 'lib', 'node_modules'));
    const cfg = readHostConfig(); if (cfg.npmPrefix) dirs.push(join(cfg.npmPrefix, 'lib', 'node_modules'));
    if (process.env.npm_config_prefix) dirs.push(join(process.env.npm_config_prefix, 'lib', 'node_modules'));
  }
  return dirs;
}

// macOS에서 CLI가 흔히 설치되는 bin 폴더(공식 설치, Homebrew, npm, node 옆)
function unixBinDirs() {
  const h = homedir();
  return [join(h, '.local', 'bin'), join(h, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin',
    join(h, '.npm-global', 'bin'), dirname(process.execPath)];
}

// 심볼릭 링크를 따라가 .js 진입점이면 이 node로, 실행 파일이면 직접 실행한다(shell 없이).
function asCommand(file) {
  try {
    const real = realpathSync(file);
    if (!statSync(real).isFile()) return null;
    if (/\.(c|m)?js$/i.test(real)) return { cmd: process.execPath, pre: [real] };
    if (!WIN) accessSync(real, fsConstants.X_OK);
    return { cmd: real, pre: [] };
  } catch { return null; }
}

function firstCommand(files) {
  for (const f of files) { const c = existsSync(f) && asCommand(f); if (c) return c; }
  return null;
}

function findClaude() {
  if (WIN) {
    return firstCommand([
      ...npmModuleDirs().map((d) => join(d, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')),
      join(homedir(), '.local', 'bin', 'claude.exe'),
    ]);
  }
  return firstCommand([
    ...unixBinDirs().map((d) => join(d, 'claude')),
    ...npmModuleDirs().flatMap((d) => [join(d, '@anthropic-ai', 'claude-code', 'bin', 'claude'), join(d, '@anthropic-ai', 'claude-code', 'cli.js')]),
  ]);
}

function findCodex() {
  const js = npmModuleDirs().map((d) => join(d, '@openai', 'codex', 'bin', 'codex.js'));
  return firstCommand(WIN ? js : [...js, ...unixBinDirs().map((d) => join(d, 'codex'))]);
}

// Chrome이 Finder에서 실행되면 PATH가 짧다. CLI가 내부에서 node 등을 찾을 수 있게 보강한다.
if (!WIN) process.env.PATH = [...unixBinDirs(), process.env.PATH || '/usr/bin:/bin'].join(':');

function run(cmd, args, { stdin, cwd }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: false, windowsHide: true, env: process.env });
    children.add(p);
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('시간 초과(10분)')); }, TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => { clearTimeout(timer); children.delete(p); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); children.delete(p); resolve({ code, out, err }); });
    p.stdin.end(stdin ?? '');
  });
}

// 시스템 프롬프트는 호출자가 바꿀 수 없게 여기서 고정한다(레드팀 R7). extension/src/core/pack.js의 SYSTEM과 같은 내용으로 유지할 것.
const SYSTEM = `너는 대학 강의 요약가다. 입력은 슬라이드(S번호)별 교수 발화 받아쓰기와 일부 슬라이드 이미지다(이미지는 '이미지 N번째' 표시 순서대로 첨부).
받아쓰기는 음성인식이라 오인식이 있다. 슬라이드 내용으로 바로잡아 이해하라.
반드시 JSON 하나만 출력하라. 설명·코드펜스 금지. 형식:
{"overview":"강의 전체 핵심 3~5문장","slides":[{"s":1,"summary":["핵심 1~3개, 각 60자 이내"],"comment":"교수가 강조한 점이나 슬라이드에 없는 보충 설명 1문장, 없으면 빈 문자열"}],"corrections":[["오인식","바른 말"]],"exam":["시험에 나올 만한 포인트 3~7개"]}
- slides는 입력의 모든 S번호를 순서대로 포함. 발화가 없고 이미지도 없으면 summary는 [].
- corrections는 확실한 음성인식 오류만, 최대 40개. 같은 오류는 한 번만.
- 수식은 일반 텍스트로(예: O(n log n)).`;

function validate(m) {
  if (typeof m.prompt !== 'string' || m.prompt.length > MAX_PROMPT || !m.prompt.startsWith('강의: ')) throw new Error('프롬프트 형식 오류');
  const images = Array.isArray(m.images) ? m.images : [];
  if (images.length > MAX_IMAGES) throw new Error('이미지가 너무 많습니다');
  for (const im of images) {
    if (typeof im?.b64 !== 'string' || im.b64.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(im.b64)) throw new Error('이미지 형식 오류');
  }
  return images;
}

async function claude({ model, system, prompt, images }) {
  const c = findClaude();
  if (!c) throw new Error('claude CLI를 찾지 못했습니다');
  if (!CLAUDE_MODELS.has(model)) throw new Error('허용되지 않은 모델');
  const cwd = makeTemp();
  try {
    const content = [
      ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.b64 } })),
      { type: 'text', text: prompt },
    ];
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    // 토큰 절약(실측 52.6k → 1.8k): 기본 시스템 프롬프트·도구·MCP·사용자 설정을 모두 뺀다.
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--system-prompt', system, '--tools', '', '--strict-mcp-config',
      '--setting-sources', 'project', '--disable-slash-commands', '--model', model];
    const r = await run(c.cmd, [...c.pre, ...args], { stdin: line, cwd });
    const res = r.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.type === 'result');
    if (!res) throw new Error(`claude 실행 실패 (code ${r.code}) ${r.err.slice(-500)}`);
    if (res.is_error) throw new Error(`claude 오류: ${String(res.result).slice(0, 500)}`);
    const u = res.usage || {};
    return { text: res.result, usage: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 } };
  } finally {
    dropTemp(cwd);
  }
}

async function codex({ system, prompt, images }) {
  const c = findCodex();
  if (!c) throw new Error('codex CLI를 찾지 못했습니다');
  const cwd = makeTemp();
  try {
    const files = images.map((im, i) => {
      const f = join(cwd, `s${i + 1}.jpg`);
      writeFileSync(f, Buffer.from(im.b64, 'base64'));
      return `--image=${f}`;
    });
    // 프롬프트는 stdin으로만 넘긴다('-'). 읽기 전용 샌드박스, 기록 남기지 않음.
    // read-only여도 셸로 디스크 전체를 읽을 수 있어, 강의 내용 속 지시(프롬프트 주입)로 파일이 유출될 수 있다(레드팀 R1).
    // 명령 실행·브라우저·플러그인·MCP·메모리 도구를 모두 끈다. 실측: 끄면 echo 요청에 명령 실행 없음, 켜면 실행됨.
    // 부수 효과로 고정 입력 토큰도 약 22.7k → 15.2k로 준다.
    const off = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
      'in_app_browser', 'computer_use', 'memories', 'code_mode_host', 'skill_search', 'skill_mcp_dependency_install',
      'tool_suggest', 'sleep_tool', 'shell_snapshot'].flatMap((f) => ['-c', `features.${f}=false`]);
    const args = [...c.pre, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
      '-m', CODEX_MODEL, '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}', ...off, '-C', cwd, ...files, '-'];
    const r = await run(c.cmd, args, { stdin: `${system}\n\n${prompt}`, cwd });
    let text = null, usage = null, fail = null;
    for (const l of r.out.split('\n')) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.type === 'item.completed' && j.item?.type === 'agent_message') text = j.item.text;
      if (j.type === 'turn.completed') usage = j.usage;
      if (j.type === 'turn.failed') fail = j.error?.message;
    }
    if (fail) throw new Error(`codex 오류: ${String(fail).slice(0, 500)}`);
    if (text == null) throw new Error(`codex 실행 실패 (code ${r.code}) ${r.err.slice(-500)}`);
    return { text, usage: { input: usage?.input_tokens || 0, output: (usage?.output_tokens || 0) + (usage?.reasoning_output_tokens || 0) } };
  } finally {
    dropTemp(cwd);
  }
}

async function handle(m) {
  switch (m?.cmd) {
    case 'detect':
      return { ok: true, claude: !!findClaude(), codex: !!findCodex() };
    case 'test': {
      const req = { model: m.model, system: '짧게 답한다.', prompt: 'OK라고만 답해.', images: [] };
      const r = m.provider === 'codex' ? await codex(req) : await claude(req);
      return { ok: true, ...r };
    }
    case 'summarize': {
      const images = validate(m);
      const req = { model: m.model, system: SYSTEM, prompt: m.prompt, images };
      const r = m.provider === 'codex' ? await codex(req) : await claude(req);
      return { ok: true, ...r };
    }
    default:
      throw new Error('알 수 없는 명령');
  }
}
