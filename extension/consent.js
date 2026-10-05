// consent.js — 최초 1회 설정 화면. consent=true가 저장되면 팝업은 다시 이 화면을 띄우지 않는다.
// 설정에서 "동의 화면 다시 보기"로 재열람할 수 있지만, 그때도 팝업이 강제로 다시 열리지는 않는다.
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

function updateVisibility() {
  const isAi = document.querySelector('input[name="mode"]:checked')?.value === 'ai';
  el('providerBlock').hidden = !isAi;
  el('noticeLine').hidden = !isAi;
  el('confirmRow').hidden = !isAi;
}

async function onContinue() {
  const result = el('result');
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'local';
  if (!hasRuntime()) {
    result.textContent = '미리보기 모드: 실제 저장은 확장 프로그램 환경에서만 됩니다.';
    return;
  }
  if(!el('asrConsent').checked){result.textContent='Groq 음성 전송 동의를 확인하세요.';return;}
  result.textContent = '저장 중…';

  if (mode === 'ai') {
    const provider = el('providerSel').value;
    const confirmBeforeSend = el('confirmBeforeSend').checked;
    const settingsRes = await callBg('saveSettings', {
      settings: { mode, provider, confirmBeforeSend },
    });
    if (settingsRes.ok === false) {
      result.textContent = `저장 실패: ${settingsRes.error || ''}`;
      return;
    }
  }

  const res = await callBg('setConsent', { mode,asrConsent:true });
  if (res.ok === false) {
    result.textContent = `저장 실패: ${res.error || ''}`;
    return;
  }
  result.textContent = mode === 'ai' ? 'AI 모드로 저장했습니다.' : '원문만 모드로 저장했습니다.';
  await callBg('openOptions');
  setTimeout(() => { if (hasRuntime()) window.close(); }, 600);
}

function init() {
  mountCampusScene(el('campusHost'), { state: 'study', motion: true, compact: true });

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', updateVisibility));
  updateVisibility();

  el('continueBtn').addEventListener('click', (e) => { if (e.isTrusted) onContinue(); });

  if (!hasRuntime()) {
    el('result').textContent = '미연결 — 확장 프로그램 밖에서 보는 미리보기입니다.';
  }
}

init();
