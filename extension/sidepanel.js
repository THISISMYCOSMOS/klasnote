// sidepanel.js — 우측 도킹 사이드패널. options.js와 같은 bg 메시지 계약을 쓰되,
// 강의별 상태(대기/진행/확인/완료/오류)를 더 자세히 보여준다.
// 폴링 없음: stateChanged 브로드캐스트, storage 변경(화면이 보일 때만), visibilitychange에서만 갱신한다.
import { mountCampusScene } from './campus.js';

const STATUS_LABEL = {
  queued: '대기 중',
  running: '처리 중',
  summarizing: '요약 중',
  awaiting_confirmation: '확인 필요',
  done: '확인 필요',
  complete: '완료',
  paused: '일시중지',
  error: '오류',
};

const PROGRESS_STATES = new Set(['queued', 'running']);
const OPENED_LABEL = '요약 전 (열람됨)';
const UNKNOWN_LABEL = '상태 확인 필요';

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

let scene;
let helpOpen = false;
const pending = new Set(); // 응답 대기 중인 contentId (중복 클릭 방지)

function showError(message) {
  const box = el('errorBanner');
  box.hidden = false;
  box.textContent = message;
}
function clearError() {
  const box = el('errorBanner');
  box.hidden = true;
  box.textContent = '';
}

async function openOptions() {
  if (hasRuntime()) {const res=await callBg('openOptions');if(res.ok===false)showError(res.error||'설정을 열지 못했어요.');}
  else showError('확장 프로그램과 연결되어 있지 않아 설정을 열 수 없어요.');
}

function openConsentOnce() {
  if (!hasRuntime()) return;
  window.open(chrome.runtime.getURL('consent.html'), '_blank', 'noopener');
}

function modeLabel(settings) {
  return settings?.mode==='ai'?'AI 모드 · 내 계정 사용량':'로컬 전용';
}

function mascotStateFor(statuses) {
  const vals = Object.values(statuses || {});
  if (vals.some((s) => ['running', 'queued', 'summarizing'].includes(s?.state))) return 'walk';
  if (vals.some((s) => ['awaiting_confirmation', 'done'].includes(s?.state))) return 'study';
  if (vals.some((s) => s?.state === 'complete')) return 'success';
  return 'idle';
}

function actionFor(contentId, status) {
  if (!status?.state) return { label: '지금 요약', type: 'openConfirm', payload: { contentId, force: false } };
  switch (status.state) {
    case 'awaiting_confirmation':
    case 'done':
      return { label: '확인하고 저장', type: 'openConfirm', payload: { contentId, force: false } };
    case 'paused':
    case 'error':
      return { label: '다시 시도', type: 'openConfirm', payload: { contentId, force: false } };
    case 'complete':
      return { label: 'HTML 다시 저장', type: 'download', payload: { contentId } };
    case 'running':
    case 'queued':
    case 'summarizing':
      return { label: '중지', type: 'cancel', payload: { contentId } };
    default:
      return null;
  }
}

function clampProgress(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  return Math.min(1, Math.max(0, p));
}

function buildItem(contentId, status, metadata, opened) {
  const meta = metadata?.[contentId] || {};
  const li = document.createElement('li');
  li.className = 'sp-item';

  const title = document.createElement('div');
  title.className = 'sp-item__title';
  title.textContent = meta.title || `강의 ${contentId}`;
  li.appendChild(title);

  if (meta.course || meta.week) {
    const sub = document.createElement('div');
    sub.className = 'sp-item__sub';
    sub.textContent = [meta.course, meta.week ? `${meta.week}주차` : null].filter(Boolean).join(' · ');
    li.appendChild(sub);
  }

  const row = document.createElement('div');
  row.className = 'sp-item__row';

  const badge = document.createElement('span');
  badge.className = 'status-badge';
  const state = status?.state;
  badge.dataset.s = state || 'opened';
  badge.textContent = state ? (STATUS_LABEL[state] || UNKNOWN_LABEL) : opened?OPENED_LABEL:'열람 전';
  row.appendChild(badge);

  const progress = status ? clampProgress(status.progress) : null;
  if (status && PROGRESS_STATES.has(state) && progress !== null) {
    const bar = document.createElement('progress');
    bar.className = 'sp-progress';
    bar.max = 1;
    bar.value = progress;
    bar.setAttribute('aria-label', `${meta.title || '강의'} 진행률`);
    const pct = document.createElement('span');
    pct.className = 'sp-progress__pct';
    pct.textContent = `${Math.round(progress * 100)}%`;
    row.appendChild(bar);
    row.appendChild(pct);
  }

  const action = opened?actionFor(contentId, status):null;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-mini-btn';
    btn.textContent = action.label;
    btn.disabled = pending.has(contentId);
    btn.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      if (pending.has(contentId)) return;
      clearError();
      pending.add(contentId);
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      const res = await callBg(action.type, action.payload);
      pending.delete(contentId);
      if (res && res.ok === false) {
        showError(res.error || '요청을 처리하지 못했어요.');
      }
      await refresh();
    });
    row.appendChild(btn);
  }

  li.appendChild(row);

  if (status?.step) {
    const step = document.createElement('div');
    step.className = 'sp-item__step';
    step.textContent = String(status.step).slice(0,200);
    li.appendChild(step);
  }

  if (status && PROGRESS_STATES.has(state) && status.preview) {
    const live = document.createElement('div');
    live.className = 'sp-item__live';
    const head = document.createElement('div');
    head.className = 'sp-item__live-head';
    head.textContent = `최근 받아쓰기 · 슬라이드 ${Number(status.slides) || 0}장`;
    const body = document.createElement('div');
    body.className = 'sp-item__live-body';
    body.textContent = String(status.preview).slice(0, 400);
    live.append(head, body);
    li.appendChild(live);
  }

  if(!opened){const hint=document.createElement('div');hint.className='sp-item__hint';hint.textContent='보기로 강의를 한 번 열어주세요.';li.appendChild(hint);}

  if (status && state === 'error' && status.error) {
    const errLine = document.createElement('div');
    errLine.className = 'sp-item__error';
    errLine.textContent = `오류: ${status.error}`;
    li.appendChild(errLine);
  }

  if (status && state === 'complete') {
    const hint = document.createElement('div');
    hint.className = 'sp-item__hint';
    hint.textContent = '저장된 HTML을 다시 받아요 (추가 AI 처리 없음).';
    li.appendChild(hint);
  }

  return li;
}

function setBanner(text, state) {
  const b = el('connBanner');
  b.textContent = text;
  if (state) b.dataset.state = state; else delete b.dataset.state;
}

function renderDisconnected() {
  setBanner('미연결 — 확장 프로그램 밖에서 보는 미리보기입니다.', 'off');
  el('setupCard').hidden = true;
  el('mainView').hidden = true;
  clearError();
}

function toggleHelp(open) {
  helpOpen = open;
  el('helpBox').hidden = !open;
  el('helpBtn').setAttribute('aria-expanded', String(open));
}

async function refresh() {
  if (!hasRuntime()) { renderDisconnected(); return; }
  const res = await callBg('getState');
  if (res.ok === false) {
    setBanner(`연결 실패: ${res.error || ''}`, 'off');
    el('setupCard').hidden = true;
    el('mainView').hidden = true;
    return;
  }
  setBanner('연결됨', 'ok');
  const settings = res.settings || {};
  const needsSetup = settings.consent !== true;

  el('setupCard').hidden = !needsSetup;
  el('mainView').hidden = needsSetup;

  if (needsSetup) {
    scene?.setMotion(settings.motion !== false);
    scene?.setState('idle');
    return;
  }

  el('modeLabel').textContent = modeLabel(settings);

  const statuses = res.statuses || {};
  const opened = res.opened || {};
  const metadata = res.metadata || {};
  const ids = Array.from(new Set([...Object.keys(statuses), ...Object.keys(opened)]));
  const priority={running:0,summarizing:0,queued:0,awaiting_confirmation:1,done:1,error:2,paused:2,complete:3};
  ids.sort((a,b)=>(priority[statuses[a]?.state]??4)-(priority[statuses[b]?.state]??4)||(statuses[b]?.updatedAt??opened[b]??0)-(statuses[a]?.updatedAt??opened[a]??0));

  const list = el('lectureList');
  list.replaceChildren();

  if (ids.length === 0) {
    el('emptyMsg').hidden = false;
    el('emptyMsg').textContent = 'KLAS 강의 목록에서 보기를 눌러 강의를 열어보세요.';
  } else {
    el('emptyMsg').hidden = true;
    for (const contentId of ids) {
      list.appendChild(buildItem(contentId, statuses[contentId] || null, metadata,!!opened[contentId]));
    }
  }

  scene?.setMotion(settings.motion !== false);
  scene?.setState(mascotStateFor(statuses));
}

let onRuntimeMessage = null;
let onStorageChanged = null;
let onVisibility = null;

function init() {
  scene = mountCampusScene(el('campusHost'), {
    state: 'idle', motion: true, compact: true,
    onToggleMotion: async (motion) => {
      const res = await callBg('saveSettings', { settings: { motion } });
      if (res.ok === false) {
        showError(res.error || '모션 설정을 저장하지 못했어요.');
        await refresh();
        return;
      }
      scene?.setMotion(res.settings?.motion !== false);
    },
  });

  el('settingsBtn').addEventListener('click', (e) => { if (e.isTrusted) openOptions(); });
  el('setupBtn').addEventListener('click', (e) => { if (e.isTrusted) openConsentOnce(); });
  el('helpBtn').addEventListener('click', (e) => { if (e.isTrusted) toggleHelp(!helpOpen); });
  el('helpCloseBtn').addEventListener('click', (e) => { if (e.isTrusted) toggleHelp(false); });

  if (hasRuntime()) {
    if (chrome.runtime.onMessage) {
      onRuntimeMessage = (msg) => {
        if (!document.hidden && msg && msg.target === 'ui' && msg.type === 'stateChanged') refresh();
      };
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    }
    if (chrome.storage && chrome.storage.onChanged) {
      onStorageChanged = (changes,area) => { if (area==='local'&&(changes.settings||changes.statuses||changes.opened||changes.metadata)&&!document.hidden) refresh(); };
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
    onVisibility = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', () => {
      scene?.destroy();
      if (onRuntimeMessage) chrome.runtime.onMessage?.removeListener(onRuntimeMessage);
      if (onStorageChanged) chrome.storage?.onChanged?.removeListener(onStorageChanged);
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  refresh();
}

init();
