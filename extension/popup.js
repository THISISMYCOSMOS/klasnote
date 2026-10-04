// popup.js — 툴바 팝업. 처리 중/확인 필요 강의만 간단히 보여주고, 자세한 관리는 설정 화면에서 한다.
import { mountCampusScene } from './campus.js';

const STATUS_LABEL = {
  queued: '대기 중',
  running: '처리 중',
  summarizing: '요약 중',
  awaiting_confirmation: '확인 필요',
  complete: '완료',
  paused: '일시중지',
  error: '오류',
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

let scene;

function openOptions() {
  if (hasRuntime()) {
    callBg('openOptions');
  } else {
    window.open('options.html', '_blank', 'noopener');
  }
}

function mascotStateFor(statuses) {
  const vals = Object.values(statuses || {});
  if (vals.some((s) => s.state === 'running' || s.state === 'queued' || s.state === 'summarizing')) return 'walk';
  if (vals.some((s) => s.state === 'awaiting_confirmation')) return 'study';
  if (vals.some((s) => s.state === 'complete')) return 'success';
  return 'idle';
}

function buildItem(contentId, status, metadata) {
  const meta = metadata?.[contentId] || {};
  const li = document.createElement('li');
  li.className = 'pop-item';

  const title = document.createElement('div');
  title.className = 'pop-item__title';
  title.textContent = meta.title || `강의 ${contentId}`;
  li.appendChild(title);

  if (meta.course || meta.week) {
    const sub = document.createElement('div');
    sub.className = 'pop-item__sub';
    sub.textContent = [meta.course, meta.week ? `${meta.week}주차` : null].filter(Boolean).join(' · ');
    li.appendChild(sub);
  }

  const row = document.createElement('div');
  row.className = 'pop-item__row';
  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.dataset.s = status.state;
  badge.textContent = STATUS_LABEL[status.state] || status.state;
  row.appendChild(badge);

  if (status.state === 'awaiting_confirmation') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.textContent = '검토하기';
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      callBg('openConfirm', { contentId, force: false });
    });
    row.appendChild(btn);
  } else if (status.state === 'running' || status.state === 'queued' || status.state === 'summarizing') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mini-btn';
    btn.textContent = '취소';
    btn.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      await callBg('cancel', { contentId });
      refresh();
    });
    row.appendChild(btn);
  }

  li.appendChild(row);
  return li;
}

function renderPreview() {
  el('connBanner').textContent = '미연결 — 확장 프로그램 밖에서 보는 미리보기입니다.';
  el('connBanner').dataset.state = 'off';
  el('emptyMsg').hidden = false;
  el('emptyMsg').textContent = '확장 프로그램에서 열면 실제 진행 상태가 표시됩니다.';
  scene?.setState('walk');
}

async function refresh() {
  if (!hasRuntime()) { renderPreview(); return; }
  const res = await callBg('getState');
  if (res.ok === false) {
    el('connBanner').textContent = `연결 실패: ${res.error || ''}`;
    el('connBanner').dataset.state = 'off';
    return;
  }
  el('connBanner').textContent = '연결됨';
  el('connBanner').dataset.state = 'ok';
  const setupNeeded=res.settings?.consent!==true;
  el('openOptionsFooter').hidden=!setupNeeded;
  if(setupNeeded){
    el('popList').replaceChildren();
    el('emptyMsg').hidden=false;
    el('emptyMsg').textContent='처리 방식을 먼저 선택하세요.';
    el('openOptionsFooter').textContent='처음 설정';
    scene?.setMotion(res.settings?.motion!==false);
    scene?.setState('idle');
    return;
  }

  const statuses = res.statuses || {};
  const metadata = res.metadata || {};
  const list = el('popList');
  list.replaceChildren();

  const notable = Object.entries(statuses).filter(([, s]) =>
    ['queued', 'running', 'summarizing', 'awaiting_confirmation'].includes(s.state));

  if (notable.length === 0) {
    el('emptyMsg').hidden = false;
    el('emptyMsg').textContent = '지금 진행 중이거나 확인이 필요한 요약이 없어요.';
  } else {
    el('emptyMsg').hidden = true;
    for (const [contentId, status] of notable) {
      list.appendChild(buildItem(contentId, status, metadata));
    }
  }

  scene?.setMotion(res.settings?.motion !== false);
  scene?.setState(mascotStateFor(statuses));
}

function init() {
  scene = mountCampusScene(el('campusHost'), { state: 'idle', motion: true, compact: true,
    onToggleMotion: async (motion) => {
      const res=await callBg('saveSettings',{settings:{motion}});
      if(res.ok===false){await refresh();return;}
      scene?.setMotion(res.settings?.motion!==false);
    },
  });

  el('optionsBtn').addEventListener('click', (e) => { if (e.isTrusted) openOptions(); });
  el('openOptionsFooter').addEventListener('click', (e) => {
    if(!e.isTrusted)return;
    if(hasRuntime())window.open(chrome.runtime.getURL('consent.html'),'_blank','noopener');
    else openOptions();
  });

  if (hasRuntime() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!document.hidden && msg && msg.target === 'ui' && msg.type === 'stateChanged') refresh();
    });
  }

  refresh();
  if (hasRuntime()) {
    // 주기적 폴링 없음: stateChanged 브로드캐스트와 탭 재표시 시점에만 갱신한다.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener('pagehide', () => { scene?.destroy(); });
  }
}

init();
