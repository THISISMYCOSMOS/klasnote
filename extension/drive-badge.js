// Shared by extension views and the isolated KLAS content script; no HTML injection.
(() => {
  const labels = { waiting:'백업 대기', uploading:'백업 중', saved:'Drive', failed:'백업 실패', missing:'백업 없음', outdated:'이전 백업', unknown:'확인 필요' };
  const css = '.drive-badge{display:inline-flex;align-items:center;gap:3px;margin-left:5px;padding:1px 4px;border:0;border-radius:4px;background:transparent;color:var(--drive-muted,#64748b);font:11px/1.5 system-ui;white-space:nowrap;vertical-align:middle}.drive-badge svg{width:13px;height:13px;flex:none}.drive-badge[data-state=saved]{color:var(--drive-ok,#237449)}.drive-badge[data-state=failed],.drive-badge[data-state=missing],.drive-badge[data-state=outdated]{color:var(--drive-warn,#9a6413)}button.drive-badge{cursor:pointer;text-decoration:underline;text-underline-offset:2px}.drive-badge:focus-visible{outline:2px solid currentColor;outline-offset:2px}';
  function create(record, retry) {
    if (!record || !labels[record.status]) return null;
    const canRetry = record.status === 'failed' && typeof retry === 'function';
    const badge = document.createElement(canRetry ? 'button' : 'span');
    if (canRetry) badge.type = 'button';
    badge.className = 'drive-badge'; badge.dataset.state = record.status;
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','1.8'); svg.setAttribute('aria-hidden','true');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M6 18a4 4 0 0 1-.6-7.95A6.5 6.5 0 0 1 18 9.5a4.25 4.25 0 0 1 .5 8.5H6Z'); svg.append(path);
    const label = document.createElement('span'); label.textContent = labels[record.status]; badge.append(svg,label);
    const kind = record.kind === 'raw' ? '원문 HTML' : '요약 HTML';
    const descriptions = { saved:'Drive에 백업됨', waiting:'다운로드 완료 후 Drive 백업 대기', uploading:'Drive에 백업 중', failed:record.error || 'Drive 백업 실패', missing:'Drive 파일이 없거나 휴지통에 있어요. HTML을 다시 받으면 백업돼요.', outdated:'Drive 백업이 현재 내용보다 오래됐어요. HTML을 다시 받으면 갱신돼요.', unknown:'현재 Drive 파일을 확인하지 못했어요' };
    const time = record.checkedAt || record.uploadedAt;
    badge.title = `${kind} · ${descriptions[record.status]}${time ? ' · 마지막 확인 '+new Date(time).toLocaleString('ko-KR') : ''}${canRetry ? ' · 클릭하여 다시 백업' : ''}`;
    badge.setAttribute('aria-label',badge.title);
    if (canRetry) badge.addEventListener('click',async event => {
      if (!event.isTrusted || badge.disabled) return;
      badge.disabled = true; try { await retry(); } finally { badge.disabled = false; }
    });
    return badge;
  }
  globalThis.KlasnoteDriveUI = { create, css };
})();
