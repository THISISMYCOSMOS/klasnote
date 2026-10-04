// options.js — 설정 화면 로직. 백그라운드와는 chrome.runtime.sendMessage({target:'bg',...})로만 통신한다.
import { mountCampusScene } from './campus.js';

const ALLOWED = {
  provider: ['auto', 'claude', 'codex'],
  claudeModel: ['haiku', 'sonnet', 'opus'],
  preset: ['save', 'standard', 'detail'],
  asrModel: ['small', 'base'],
};

const STATUS_LABEL = {
  queued: '대기 중',
  running: '처리 중',
  done: '받아쓰기 완료',
  summarizing: '요약 중',
  awaiting_confirmation: '확인 필요',
  complete: '완료',
  paused: '일시중지',
  error: '오류',
};

const DEFAULT_SETTINGS = {
  consent: false,
  mode: 'local',
  provider: 'auto',
  claudeModel: 'sonnet',
  preset: 'standard',
  confirmBeforeSend: true,
  asrModel: 'small',
  motion: true,
};

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

function askConfirm(title, msg) {
  const dialog = el('confirmDialog');
  el('confirmDialogTitle').textContent = title;
  el('confirmDialogMsg').textContent = msg;
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

let scene;
let latest = { settings: { ...DEFAULT_SETTINGS }, statuses: {}, opened: {}, metadata: {} };
let library = { items: [] };
// 사용자가 저장하지 않은 채 설정 폼을 고치고 있는 동안에는 주기적 refresh가 그 입력을 덮어쓰지 않게 막는다.
let formDirty = false;
function markFormDirty() { formDirty = true; }

function overallMascotState() {
  const vals = Object.values(latest.statuses || {});
  if (vals.some((s) => s.state === 'running' || s.state === 'queued' || s.state === 'summarizing')) return 'walk';
  if (vals.some((s) => s.state === 'awaiting_confirmation')) return 'study';
  return 'idle';
}

// 실제 연결 성공/실패 여부는 refresh()의 getState 응답에 따라 갱신한다(미리보기 모드만 여기서 처리).
function applyConnBanner() {
  if (hasRuntime()) return;
  const banner = el('connBanner');
  banner.textContent = '미연결 — 확장 프로그램 환경 밖에서 보는 미리보기 화면입니다.';
  banner.dataset.state = 'off';
}

function setConnBanner(ok, errorText) {
  const banner = el('connBanner');
  if (ok) {
    banner.textContent = '확장 연결됨';
    banner.dataset.state = 'ok';
  } else {
    banner.textContent = `연결 실패: ${errorText || ''}`;
    banner.dataset.state = 'off';
  }
}

function fillSettingsForm(settings) {
  document.querySelectorAll('input[name="provider"]').forEach((r) => { r.checked = r.value === settings.provider; });
  el('claudeModel').value = settings.claudeModel;
  el('preset').value = settings.preset;
  el('asrModel').value = settings.asrModel;
  el('confirmBeforeSend').checked = !!settings.confirmBeforeSend;
  el('motionToggle').checked = settings.motion !== false;
}

function renderConsent(settings) {
  const p = el('consentState');
  if (settings.mode === 'ai' && settings.consent) {
    p.textContent = '현재: AI 모드 (대본 일부 + 선택 슬라이드가 본인 Claude/Codex 계정으로 전송됨)';
  } else {
    p.textContent = '현재: 로컬 전용 모드 (AI로 아무것도 전송하지 않음)';
  }
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildLectureItem(item) {
  const li = document.createElement('li');
  li.className = 'lecture-item';

  const meta = document.createElement('div');
  meta.className = 'lecture-item__meta';
  const title = document.createElement('div');
  title.className = 'lecture-item__title';
  title.textContent = item.title || '(제목 없음)';
  const sub = document.createElement('div');
  sub.className = 'lecture-item__sub';
  const subParts = [item.course, item.week ? `${item.week}주차` : null].filter(Boolean);
  sub.textContent = subParts.join(' · ');
  meta.appendChild(title);
  meta.appendChild(sub);

  const status = latest.statuses?.[item.contentId];
  const stateKey = status?.state || item.state;
  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.dataset.s = stateKey || '';
  badge.textContent = STATUS_LABEL[stateKey] || (stateKey ? stateKey : '미시작');
  meta.appendChild(document.createElement('br'));
  meta.appendChild(badge);

  if (status && (status.state === 'running' || status.state === 'summarizing') && Number.isFinite(status.progress)) {
    const bar = document.createElement('div');
    bar.className = 'lecture-item__progress';
    const inner = document.createElement('span');
    // 백엔드 progress는 0..1 비율이다(퍼센트 아님).
    const pct = Math.max(0, Math.min(1, status.progress)) * 100;
    inner.style.width = `${pct}%`;
    bar.appendChild(inner);
    meta.appendChild(bar);
    if (status.step) {
      const stepP = document.createElement('div');
      stepP.className = 'lecture-item__sub';
      stepP.textContent = status.step;
      meta.appendChild(stepP);
    }
  }
  if (status?.state === 'error' && status.error) {
    const errP = document.createElement('div');
    errP.className = 'lecture-item__sub';
    errP.textContent = `오류: ${status.error}`;
    meta.appendChild(errP);
  }

  li.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'lecture-item__actions';

  const opened = !!latest.opened?.[item.contentId];
  const hasSummary = !!(library.summaries && library.summaries[item.contentId]) || item.state === 'complete';

  if (stateKey === 'awaiting_confirmation') {
    actions.appendChild(makeBtn('검토하기', 'btn--primary', async () => {
      await callBg('openConfirm', { contentId: item.contentId, force: false });
    }));
  } else {
    const runBtn = makeBtn(hasSummary ? '요약 다시 만들기' : '지금 요약', 'btn--primary', async () => {
      await callBg('openConfirm', { contentId: item.contentId, force: hasSummary });
    });
    if (!opened) {
      runBtn.disabled = true;
      runBtn.title = '이 강의를 한 번 이상 열어본 뒤에 사용할 수 있어요.';
    }
    actions.appendChild(runBtn);
  }

  if (hasSummary) {
    actions.appendChild(makeBtn('다운로드', 'btn--ghost', async () => {
      const res = await callBg('download', { contentId: item.contentId });
      if (!res.ok) showTemp(el('saveResult'), `다운로드 실패: ${res.error || ''}`);
    }));
  }

  if (stateKey === 'queued' || stateKey === 'running' || stateKey === 'summarizing') {
    actions.appendChild(makeBtn('취소', 'btn--ghost', async () => {
      await callBg('cancel', { contentId: item.contentId });
      refresh();
    }));
  }

  actions.appendChild(makeBtn('삭제', 'btn--danger btn--sm', async () => {
    const ok = await askConfirm('강의 기록 삭제', `"${item.title || '이 강의'}"의 로컬 기록(대본·슬라이드·요약)을 삭제할까요? 되돌릴 수 없습니다.`);
    if (!ok) return;
    const res = await callBg('deleteLecture', { contentId: item.contentId });
    if (res.ok) refresh();
  }));

  li.appendChild(actions);
  return li;
}

function makeBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    onClick(e);
  });
  return b;
}

function showTemp(node, text, ms = 4000) {
  node.textContent = text;
  if (ms) setTimeout(() => { if (node.textContent === text) node.textContent = ''; }, ms);
}

function renderLibrary() {
  const ul = el('lectureList');
  ul.replaceChildren();
  const items = library.items || [];
  el('libraryEmpty').hidden = items.length > 0;
  for (const item of items) ul.appendChild(buildLectureItem(item));
}

async function refresh() {
  if (!hasRuntime()) return;
  const stateRes = await callBg('getState');
  if (stateRes.ok === false) {
    setConnBanner(false, stateRes.error);
  } else {
    setConnBanner(true);
    latest = {
      settings: { ...DEFAULT_SETTINGS, ...(stateRes.settings || {}) },
      statuses: stateRes.statuses || {},
      opened: stateRes.opened || {},
      metadata: stateRes.metadata || {},
    };
    // 사용자가 폼을 고치고 있는 중이면(저장 전) 백그라운드 값으로 덮어쓰지 않는다.
    if (!formDirty) {
      fillSettingsForm(latest.settings);
      renderConsent(latest.settings);
      scene?.setMotion(latest.settings.motion !== false);
    }
  }
  const libRes = await callBg('getLibrary');
  if (libRes.ok !== false) {
    library = libRes;
    renderLibrary();
  }
  scene?.setState(overallMascotState());
}

function gatherSettingsFromForm() {
  const provider = document.querySelector('input[name="provider"]:checked')?.value || 'auto';
  const claudeModel = el('claudeModel').value;
  const preset = el('preset').value;
  const asrModel = el('asrModel').value;
  const confirmBeforeSend = el('confirmBeforeSend').checked;
  const motion = el('motionToggle').checked;
  if (!ALLOWED.provider.includes(provider)) throw new Error('invalid provider');
  if (!ALLOWED.claudeModel.includes(claudeModel)) throw new Error('invalid claudeModel');
  if (!ALLOWED.preset.includes(preset)) throw new Error('invalid preset');
  if (!ALLOWED.asrModel.includes(asrModel)) throw new Error('invalid asrModel');
  return { ...latest.settings, provider, claudeModel, preset, asrModel, confirmBeforeSend, motion };
}

function wireEvents() {
  el('detectBtn').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    el('detectResult').textContent = '감지 중…';
    const res = await callBg('detect');
    if (res.ok === false) { el('detectResult').textContent = `감지 실패: ${res.error || ''}`; return; }
    const parts = [];
    parts.push(`Claude: ${res.claude ? '사용 가능' : '사용 불가'}`);
    parts.push(`Codex: ${res.codex ? '사용 가능' : '사용 불가'}`);
    el('detectResult').textContent = parts.join(' · ');
  });

  el('saveBtn').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    let settings;
    try { settings = gatherSettingsFromForm(); } catch (err) {
      showTemp(el('saveResult'), '설정 값이 올바르지 않습니다.');
      return;
    }
    const res = await callBg('saveSettings', { settings });
    if (res.ok === false) { showTemp(el('saveResult'), `저장 실패: ${res.error || ''}`); return; }
    latest.settings = { ...DEFAULT_SETTINGS, ...(res.settings || settings) };
    formDirty = false;
    fillSettingsForm(latest.settings);
    renderConsent(latest.settings);
    scene?.setMotion(latest.settings.motion !== false);
    showTemp(el('saveResult'), '저장했습니다.');
  });

  document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener('change', markFormDirty));
  el('claudeModel').addEventListener('change', markFormDirty);
  el('preset').addEventListener('change', markFormDirty);
  el('asrModel').addEventListener('change', markFormDirty);
  el('confirmBeforeSend').addEventListener('change', markFormDirty);
  el('motionToggle').addEventListener('change', () => {
    markFormDirty();
    scene?.setMotion(el('motionToggle').checked);
  });

  el('testBtn').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    const ok = await askConfirm('연결 테스트', '실제 AI 호출이 1회 발생하며 본인 계정 사용량이 소모됩니다. 계속할까요?');
    if (!ok) return;
    el('testResult').textContent = '테스트 중…';
    const res = await callBg('test');
    if (res.ok === false) { el('testResult').textContent = `실패: ${res.error || ''}`; return; }
    el('testResult').textContent = '성공: AI 응답을 정상적으로 받았습니다.';
  });

  el('openConsentBtn').addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (hasRuntime()) {
      window.open(chrome.runtime.getURL('consent.html'), '_blank', 'noopener');
    } else {
      showTemp(el('saveResult'), '확장 프로그램 환경에서만 열 수 있습니다.');
    }
  });

  if (hasRuntime() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!document.hidden && msg && msg.target === 'ui' && msg.type === 'stateChanged') refresh();
    });
  }
}

function init() {
  scene = mountCampusScene(el('campusHost'), {
    state: 'idle',
    motion: true,
    onToggleMotion: (on) => { el('motionToggle').checked = on; markFormDirty(); },
  });
  applyConnBanner();
  wireEvents();
  if (hasRuntime()) {
    refresh();
    // 주기적 폴링 없음: 백그라운드의 stateChanged 브로드캐스트와 탭 재표시 시점에만 갱신한다.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener('pagehide', () => { scene?.destroy(); });
  } else {
    fillSettingsForm(DEFAULT_SETTINGS);
    renderConsent(DEFAULT_SETTINGS);
    el('libraryEmpty').hidden = false;
    el('libraryEmpty').textContent = '미리보기 모드에서는 강의 기록을 표시할 수 없습니다.';
  }
}

init();
