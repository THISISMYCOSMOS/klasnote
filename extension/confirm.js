// confirm.js — 전송 확인 화면. background가 confirm.html?id=<contentId>&force=<bool>로 연다.
import { mountCampusScene } from './campus.js';

function hasRuntime() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

async function callBg(type, payload = {}) {
  if (!hasRuntime()) return { ok: false, error: 'no-runtime' };
  try {
    const res = await chrome.runtime.sendMessage({ target: 'bg', type, ...payload });
    return res ?? { ok: false, error: 'empty-response' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function el(id) { return document.getElementById(id); }
const nf = new Intl.NumberFormat('ko-KR');

const params = new URLSearchParams(location.search);
const contentId = (params.get('id') || '').trim();
const force = params.get('force') === 'true' || params.get('force') === '1';
const inPanel=params.get('panel')==='1';

let scene;
let requestId = null;
let ready = null; // 마지막 prepareSummary 성공 응답
let destroyed = false;
let pendingPrepareTimer = null;

function setStatus(text, kind) {
  const n = el('statusLine');
  n.textContent = text || '';
  if (kind) n.dataset.k = kind; else delete n.dataset.k;
}

function fail(msg) {
  el('loadingMsg').textContent = msg;
  el('content').hidden = true;
}

function describeDestination(settings, host) {
  const providerLabel = { claude: 'Claude', codex: 'Codex', auto: '자동 선택(Claude/Codex)' };
  // provider가 'auto'였어도 실제로 결정된 값은 ready.provider이므로 그걸 우선 보여준다.
  const actualProvider = ready?.provider || settings?.provider;
  const base = providerLabel[actualProvider] || '알 수 없음';
  const model = actualProvider === 'codex' ? (settings?.codexModel ? ` · 모델 ${settings.codexModel}` : '') : settings?.claudeModel ? ` · 모델 ${settings.claudeModel}` : '';
  let account = '본인이 PC에 로컬 로그인한 계정';
  if (host && typeof host === 'object') {
    const parts = Object.entries(host).filter(([, v]) => typeof v === 'string' && v).map(([, v]) => v);
    if (parts.length) account = parts.join(' / ');
  }
  return `${base}${model} (${account})`;
}

function renderReady(res, settings, host) {
  ready = res;
  requestId = res.requestId;
  el('loadingMsg').textContent = '';
  el('content').hidden = false;
  el('est-h').parentElement.hidden=!!(res.local||res.cached);

  el('lecTitle').textContent = res.title || `강의 ${contentId}`;
  el('lecDest').textContent = res.local ? '전송 없음(로컬 전용)' : describeDestination(settings, host);

  const est = res.estimate || { text: 0, images: 0, overhead: 0, total: 0 };
  el('estText').textContent = `${nf.format(est.text || 0)} 토큰`;
  el('estImages').textContent = `${nf.format(est.images || 0)} 토큰`;
  el('estOverhead').textContent = `${nf.format(est.overhead || 0)} 토큰 (고정)`;
  el('estTotal').textContent = `${nf.format(est.total || 0)} 토큰`;

  const notice = el('transNotice');
  if (res.local) {
    notice.className = 'notice notice--local';
    notice.textContent = '이 요약은 AI로 전송하지 않고 로컬 받아쓰기만으로 만들어집니다.';
    setConfirmAction('로컬로 만들기', doSummarize);
  } else if (res.cached) {
    notice.className = 'notice notice--muted';
    notice.textContent = '이미 만들어진 요약이 저장되어 있습니다. 새로 전송하지 않고 저장된 결과를 내려받습니다.';
    setConfirmAction('저장된 결과 다운로드', doSummarize);
  } else {
    notice.className = 'notice notice--cloud';
    notice.textContent = '받아쓴 대본 일부와 선택된 슬라이드 이미지가 위 계정으로 전송됩니다. 강의 영상 자체는 전송되지 않습니다.';
    setConfirmAction('AI로 보내고 요약 만들기', doSummarize);
  }

  scene?.setState('study');
}

let polling = false; // 첫 요청 뒤에는 상태 확인만 한다(처리 재시작 금지)
async function pollPrepare(settings, host, forceOverride = force) {
  if (destroyed) return;
  const res = await callBg('prepareSummary', { contentId, force: forceOverride, poll: polling });
  if (destroyed) return;
  if (res.ok === false) { fail(`준비 실패: ${res.error || ''}`); return; }
  if (res.pending) {
    if (polling && ['paused', 'error'].includes(res.state)) { fail(res.state === 'paused' ? '처리가 중지됐어요. 강의 목록에서 "다시 시도"를 누르면 이어서 처리해요.' : '처리 중 오류가 났어요. 패널에서 이유를 확인하고 다시 시도하세요.'); return; }
    polling = true;
    el('loadingMsg').textContent = '로컬 받아쓰기를 준비하는 중입니다… (잠시 후 자동으로 다시 확인)';
    pendingPrepareTimer = setTimeout(() => { pendingPrepareTimer = null; pollPrepare(settings, host, forceOverride); }, 3000);
    return;
  }
  renderReady(res, settings, host);
}

// confirmBtn은 단계마다 역할이 달라지지만 리스너는 하나만 유지한다(중복 핸들러로 티켓이
// 두 번 소모되는 문제를 막기 위해 매번 el.onclick을 새로 지정해서 교체한다).
let sentOnce = false; // summarize가 한 번이라도 성공해 티켓이 실제로 소모됐는지

function setConfirmAction(label, handler, { disabled = false } = {}) {
  const confirmBtn = el('confirmBtn');
  confirmBtn.textContent = label;
  confirmBtn.disabled = disabled;
  confirmBtn.onclick = (e) => { if (e.isTrusted) handler(e); };
}

async function doSummarize() {
  const confirmBtn = el('confirmBtn');
  const cancelBtn = el('cancelBtn');
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  setStatus('처리 중…');
  scene?.setState('walk');

  const res = await callBg('summarize', { contentId, requestId });
  if (res.ok === false) {
    setStatus(`실패: ${res.error || '알 수 없는 오류'}`, 'error');
    cancelBtn.disabled = false;
    if (sentOnce) {
      // 이미 한 번 성공해 결과가 저장돼 있다면, 다시 비용을 쓰지 않고 다운로드만 재시도한다.
      setConfirmAction('다운로드 다시 받기', doRedownload);
    } else {
      // 아직 AI로 보내지 않았으므로 다시 준비한다. 이미 캐시가 있으면 재사용하고(추가 과금 없음),
      // 캐시가 없으면 새 추정치를 보여주고 사용자의 다음 확인을 다시 거친다. 원래 force 값과
      // 무관하게 재시도는 항상 force:false로 요청해 중복 과금을 막는다.
      setConfirmAction('다시 시도', async () => {
        setConfirmAction('다시 준비하는 중…', () => {}, { disabled: true });
        const stateRes = await callBg('getState');
        await pollPrepare(stateRes.settings, stateRes.host, false);
      });
    }
    scene?.setState('study');
    return;
  }

  sentOnce = true;
  setStatus('완료되었습니다. 다운로드가 시작됩니다.', 'ok');
  scene?.setState('success', { holdMs: 5000 });
  cancelBtn.disabled = false;
  cancelBtn.textContent = '닫기';
  setConfirmAction('다운로드 다시 받기', doRedownload);
}

async function doRedownload() {
  const confirmBtn = el('confirmBtn');
  confirmBtn.disabled = true;
  setStatus('다운로드 중…');
  const res = await callBg('download', { contentId });
  confirmBtn.disabled = false;
  if (res.ok === false) {
    setStatus(`다운로드 실패: ${res.error || ''}`, 'error');
  } else {
    setStatus('다운로드를 다시 시작했습니다.', 'ok');
  }
}

function onCancel(e) {
  if (!e.isTrusted) return;
  if(inPanel){returnToList();return;}
  // 이미 AI로 전송이 완료된 뒤에는 '취소'가 되돌릴 수 없으므로, 그 전까지만 창을 닫는 용도로 쓴다.
  window.close();
}
async function returnToList(){
  try{await chrome.sidePanel.setOptions({path:'sidepanel.html'});}catch{el('loadingMsg').textContent='목록을 열지 못했어요. 확장 아이콘으로 다시 열어주세요.';}
}

function init() {
  if(inPanel){document.body.classList.add('in-panel');el('backBtn').hidden=false;el('backBtn').addEventListener('click',e=>{if(e.isTrusted)returnToList();});}
  if(!inPanel)scene = mountCampusScene(el('campusHost'), { state: 'study', motion: true, compact: true });

  if (!contentId) {
    fail('잘못된 접근입니다 (강의 id 없음).');
    return;
  }
  if (!hasRuntime()) {
    fail('미연결 — 확장 프로그램 환경에서 열어야 합니다.');
    return;
  }

  el('cancelBtn').addEventListener('click', onCancel);

  callBg('getState').then((stateRes) => {
    const settings = stateRes.ok === false ? {} : stateRes.settings;
    const host = stateRes.ok === false ? undefined : stateRes.host;
    scene?.setMotion(settings?.motion !== false);
    pollPrepare(settings, host);
  });

  window.addEventListener('pagehide', () => {
    // 패널을 X로 닫아도 다음에 열 때 지난 강의 확인 화면이 남지 않게 목록으로 되돌린다(독립 검토 F3).
    if (inPanel) chrome.runtime.sendMessage({ target: 'bg', type: 'resetPanel' }).catch(() => {});
    destroyed = true;
    if (pendingPrepareTimer) { clearTimeout(pendingPrepareTimer); pendingPrepareTimer = null; }
    scene?.destroy();
  });
}

init();
