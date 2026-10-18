// sidepanel.js — 우측 도킹 사이드패널. options.js와 같은 bg 메시지 계약을 쓰되,
// 강의별 상태(대기/진행/확인/완료/오류)를 더 자세히 보여준다.
// 폴링 없음: stateChanged 브로드캐스트, storage 변경(화면이 보일 때만), visibilitychange에서만 갱신한다.
import { mountCampusScene } from './campus.js';
import { BUSY_STATES, etaText, queueText, rawSaved, statusBadge } from './status-labels.js';

const PROGRESS_STATES = new Set(['queued', 'running']);

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
let lastQueue = []; // 받아쓰기 대기열 순서(getState의 queue)
// 접어 둔 과목. 이 브라우저에만 기억한다(저장소가 막혀 있으면 이번 화면에서만 유지).
const COLLAPSED_KEY = 'klasnote.collapsedCourses';
const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); } catch { return []; } })());
function saveCollapsed() { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {} }

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

// 삭제 결과처럼 오류가 아닌 안내는 잠깐 보여 주고 지운다.
let noticeTimer = null;
function showNotice(message) {
  const box = el('noticeBanner');
  box.hidden = false;
  box.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { box.hidden = true; box.textContent = ''; }, 6000);
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
  if (vals.some((s) => ['awaiting_confirmation', 'done'].includes(s?.state) && !rawSaved(s))) return 'study';
  if (vals.some((s) => s?.state === 'complete')) return 'success';
  return 'idle';
}

function actionFor(contentId, status) {
  if (!status?.state) return { label: '지금 요약', type: 'startProcessing', payload: { contentId } };
  switch (status.state) {
    case 'awaiting_confirmation':
    case 'done':
      return { label: '확인하고 저장', type: 'openConfirm', payload: { contentId, force: false } };
    case 'paused':
    case 'error':
      return { label: '다시 시도', type: 'startProcessing', payload: { contentId } };
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
  const [badgeText, badgeKey] = statusBadge(status, opened);
  badge.dataset.s = badgeKey;
  badge.textContent = badgeText;
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
  // 요약 전(받아쓰기 완료) 강의도 AI 호출 없이 원문 HTML을 받을 수 있다.
  if (opened && (['done', 'awaiting_confirmation'].includes(state) || (state === 'error' && status?.transcribed === true))) {
    const raw = document.createElement('button');
    raw.type = 'button';
    raw.className = 'sp-mini-btn';
    raw.textContent = 'HTML 받기';
    raw.title = 'AI 요약 없이 받아쓰기 원문으로 HTML을 받습니다.';
    raw.disabled = pending.has(contentId);
    raw.addEventListener('click', async (e) => {
      if (!e.isTrusted || pending.has(contentId)) return;
      clearError();
      pending.add(contentId);
      raw.disabled = true;
      const res = await callBg('download', { contentId });
      pending.delete(contentId);
      if (res && res.ok === false) showError(res.error || 'HTML을 저장하지 못했어요.');
      await refresh();
    });
    row.appendChild(raw);
  }

  // 마지막으로 받은 HTML을 파일 탐색기에서 보여 준다.
  if (opened && Number.isInteger(status?.downloadId)) {
    const folder = document.createElement('button');
    folder.type = 'button';
    folder.className = 'sp-mini-btn sp-mini-btn--ghost';
    folder.textContent = '폴더 열기';
    folder.title = '받은 HTML 파일이 있는 폴더를 엽니다.';
    folder.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      clearError();
      const res = await callBg('showDownload', { contentId });
      if (res && res.ok === false) showError(res.error || '폴더를 열지 못했어요.');
    });
    row.appendChild(folder);
  }

  li.appendChild(row);

  if (status?.step) {
    const step = document.createElement('div');
    step.className = 'sp-item__step';
    step.textContent = String(status.step).slice(0,200);
    li.appendChild(step);
  }

  const when = queueText(contentId, status, lastQueue) || etaText(status);
  if (when) {
    const w = document.createElement('div');
    w.className = 'sp-item__step sp-item__when';
    w.textContent = when;
    li.appendChild(w);
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

  // 이 PC에 남은 기록(상태·대본·슬라이드·요약)을 지우고 목록에서 뺀다. 받은 HTML 파일은 그대로 둔다.
  // 상태만 남은 기록(대본 저장 전에 실패한 오류 등)도 여기서 지울 수 있다.
  if (state) {
    const foot = document.createElement('div');
    foot.className = 'sp-item__foot';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sp-del-btn';
    del.textContent = '기록 삭제';
    const busy = BUSY_STATES.has(state);
    del.disabled = busy || pending.has(contentId);
    if (busy) del.title = '처리 중에는 삭제할 수 없어요. 중지한 뒤 삭제하세요.';
    del.addEventListener('click', async (e) => {
      if (!e.isTrusted || pending.has(contentId)) return;
      clearError();
      pending.add(contentId);
      del.disabled = true;
      try {
        const res = await callBg('deleteLecture', { contentId });
        if (res && res.ok === false) showError(res.error || '기록을 삭제하지 못했어요.');
      } finally {
        pending.delete(contentId);
        await refresh();
      }
    });
    foot.appendChild(del);
    li.appendChild(foot);
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
  lastQueue = Array.isArray(res.queue) ? res.queue : [];
  // 기록을 삭제한 강의는 다시 처리하기 전까지 목록에 띄우지 않는다(상태가 새로 생기면 다시 보인다).
  const dismissed = res.dismissed || {};
  const ids = Array.from(new Set([...Object.keys(statuses), ...Object.keys(opened).filter((id) => !dismissed[id])]));
  const priority={running:0,summarizing:0,queued:0,awaiting_confirmation:1,done:1,error:2,paused:2,complete:3};
  const rank=id=>rawSaved(statuses[id])?priority.complete:(priority[statuses[id]?.state]??4);
  // 처리 중·대기 강의는 실제 대기열 순서대로(처리 중이 맨 위), 나머지는 최근 변경 순.
  const inQueue=id=>{const i=lastQueue.indexOf(id);return i<0?Infinity:i;};
  ids.sort((a,b)=>rank(a)-rank(b)||(inQueue(a)-inQueue(b)||0)||(statuses[b]?.updatedAt??opened[b]??0)-(statuses[a]?.updatedAt??opened[a]??0));

  // 지울 수 있는 강의(처리 중이 아닌 것)가 있을 때만 '전체 삭제'를 보인다.
  el('deleteAllBtn').hidden = !ids.some((id) => !BUSY_STATES.has(statuses[id]?.state));

  const list = el('lectureList');
  list.replaceChildren();

  if (ids.length === 0) {
    el('emptyMsg').hidden = false;
    el('emptyMsg').textContent = 'KLAS 강의 목록에서 보기를 눌러 강의를 열어보세요.';
  } else {
    el('emptyMsg').hidden = true;
    // 과목별로 묶는다. 묶음 순서는 그 과목에서 가장 급한 강의 순서를 따른다. 과목이 하나면 묶지 않는다.
    const groups = new Map();
    for (const contentId of ids) {
      const course = metadata[contentId]?.course || '과목 미지정';
      if (!groups.has(course)) groups.set(course, []);
      groups.get(course).push(contentId);
    }
    const item = (contentId) => buildItem(contentId, statuses[contentId] || null, metadata, !!opened[contentId]);
    if (groups.size === 1) {
      for (const contentId of ids) list.appendChild(item(contentId));
    } else {
      for (const [course, members] of groups) {
        const li = document.createElement('li');
        li.className = 'sp-group';
        const details = document.createElement('details');
        details.open = !collapsed.has(course);
        const summary = document.createElement('summary');
        summary.className = 'sp-group__head';
        const name = document.createElement('span');
        name.textContent = course;
        const count = document.createElement('span');
        count.className = 'sp-group__count';
        const ready = members.filter((id) => ['done', 'awaiting_confirmation'].includes(statuses[id]?.state) && !rawSaved(statuses[id])).length;
        count.textContent = ready ? `${members.length}개 · 확인 필요 ${ready}` : `${members.length}개`;
        summary.append(name, count);
        const sub = document.createElement('ul');
        sub.className = 'sp-list';
        for (const contentId of members) sub.appendChild(item(contentId));
        details.append(summary, sub);
        details.addEventListener('toggle', () => {
          if (details.open) collapsed.delete(course); else collapsed.add(course);
          saveCollapsed();
        });
        li.appendChild(details);
        list.appendChild(li);
      }
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
  el('deleteAllBtn').addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    const btn = el('deleteAllBtn');
    btn.disabled = true;
    clearError();
    const res = await callBg('deleteAll');
    btn.disabled = false;
    if (res.ok === false) showError(res.error || '전체 삭제를 하지 못했어요.');
    else showNotice(res.skipped ? `${res.removed}개를 지웠어요. 처리 중인 ${res.skipped}개는 남겨 뒀어요.` : `${res.removed}개를 지웠어요.`);
    await refresh();
  });
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
