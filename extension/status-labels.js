// status-labels.js — 사이드패널과 설정 화면이 같은 상태 이름을 쓰도록 모아 둔다.
// KLAS 목록(klas-list.js)은 모듈을 불러올 수 없는 콘텐츠 스크립트라 같은 이름을 따로 적어 둔다.
export const STATUS_LABEL = {
  queued: '대기 중',
  running: '처리 중',
  summarizing: '요약 중',
  awaiting_confirmation: '확인 필요',
  done: '확인 필요',
  complete: '완료',
  paused: '일시중지',
  error: '오류',
};

// 처리 중인 강의는 기록을 지울 수 없다(받아쓰기·AI 요청이 끝난 뒤 삭제).
export const BUSY_STATES = new Set(['queued', 'running', 'summarizing']);

// 'HTML 받기'로 원문을 이미 받은 강의는 확인 필요로 띄우지 않고 완료 쪽으로 보낸다.
export const rawSaved = (s) => ['awaiting_confirmation', 'done'].includes(s?.state) && s?.rawSaved === true;


// 대기열 위치: queue는 백그라운드가 준 [처리 중, 대기…] 순서다. KLAS 목록(klas-list.js)도 같은 규칙을 쓴다.
export function queueText(contentId, status, queue) {
  if (status?.state !== 'queued' || !Array.isArray(queue)) return '';
  const ahead = queue.indexOf(contentId);
  if (ahead < 0) return '';
  return ahead === 0 ? '다음 차례' : `앞에 ${ahead}개`;
}

// 이번 처리 시작 뒤 진행 속도로 남은 시간을 어림한다. 표본이 적으면 보여 주지 않는다.
export function etaText(status, now = Date.now()) {
  if (status?.state !== 'running') return '';
  const p = Number(status.progress), p0 = Number(status.runStartProgress) || 0, t0 = Number(status.runStartedAt);
  if (!Number.isFinite(p) || !Number.isFinite(t0) || p - p0 < 0.03 || now - t0 < 20000) return '';
  const min = Math.max(1, Math.round(((now - t0) / (p - p0)) * (1 - p) / 60000));
  return `약 ${min}분 남음`;
}

// 배지에 쓸 [이름, data-s 값]. 상태가 없으면 열람 여부로 나눈다.
export function statusBadge(status, opened) {
  const state = status?.state;
  if (rawSaved(status)) return ['HTML 저장됨', 'complete'];
  if (state) return [STATUS_LABEL[state] || '상태 확인 필요', state];
  return [opened ? '요약 전 (열람됨)' : '열람 전', 'opened'];
}
