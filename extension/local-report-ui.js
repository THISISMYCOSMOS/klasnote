// Shared, small local-save indicator for the KLAS list and extension views.
(() => {
  const current = (status, mode) => mode === 'local' ? status?.localDownloads?.raw : status?.localDownloads?.summary || status?.localDownloads?.raw;
  const labels = { complete: '저장됨', in_progress: '다운로드 중', interrupted: '저장 중단', missing: '다시 받기 필요' };
  function create(status, mode) {
    const record = current(status, mode);
    if (!record || !labels[record.state]) return null;
    const node = document.createElement('span');
    node.className = 'local-report-badge'; node.dataset.state = record.outdated ? 'outdated' : record.state;
    const kind = record === status.localDownloads.summary ? '요약' : '원문';
    node.textContent = `${kind} HTML · ${record.outdated ? '이전 저장본' : labels[record.state]}`;
    node.title = record.outdated ? '내용이 갱신됐습니다. 최신 HTML을 받으세요.' : record.state === 'complete'
      ? `${record.filename}\n같은 HTML이 남아 있으면 추가 복사본을 만들지 않습니다.`
      : record.state === 'missing' ? '이전 다운로드 파일이나 기록이 없어 다시 받을 수 있습니다.'
      : record.state === 'interrupted' ? '로컬 다운로드가 중단됐습니다. 다시 받기를 누르세요.' : '로컬 다운로드가 진행 중입니다.';
    node.setAttribute('role', 'status');
    return node;
  }
  const message = result => result?.reused
    ? result.downloadState === 'complete' ? '같은 HTML이 이미 저장돼 있어 추가 파일을 만들지 않았어요.' : '이미 다운로드 중이에요. 추가 파일을 만들지 않았어요.'
    : '다운로드를 시작했어요. KLAS요약 폴더에서 확인하세요.';
  globalThis.KlasnoteLocalReportUI = {
    current, create, message,
    css: '.local-report-badge{font-size:11px;line-height:1.4;color:var(--drive-muted,#64748b);white-space:nowrap}.local-report-badge[data-state=complete]{color:var(--drive-ok,#337649)}.local-report-badge[data-state=interrupted],.local-report-badge[data-state=missing],.local-report-badge[data-state=outdated]{color:var(--drive-warn,#946b26)}',
  };
})();
