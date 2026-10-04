// 모델 파일들의 바이트 진행률을 합친다. 뒤늦게 다른 파일이 시작돼도 표시가 뒤로 가지 않는다.
// 실제 파일 목록은 다운로드 중에 알려지므로 100%는 파이프라인 ready 이후에만 표시한다.
export function createModelProgress(onPercent) {
  const files = new Map();
  let previous = -1;
  return (event) => {
    if (!event) return;
    let percent;
    if (event.status === 'ready') {
      percent = 100;
    } else {
      if (!event.file) return;
      const key = `${event.name || ''}/${event.file}`;
      const file = files.get(key) || { total: 0, loaded: 0, done: false };
      if (Number.isFinite(event.total) && event.total > 0) file.total = Math.max(file.total, event.total);
      if (event.status === 'progress' && file.total) {
        const loaded = Number.isFinite(event.loaded) ? event.loaded : file.total * (event.progress || 0) / 100;
        file.loaded = Math.max(file.loaded, Math.min(file.total, Math.max(0, loaded)));
      }
      if (event.status === 'done') file.done = true;
      files.set(key, file);
      let total = 0, loaded = 0;
      for (const item of files.values()) {
        total += item.total;
        loaded += item.done ? item.total : item.loaded;
      }
      if (!total) return;
      percent = Math.min(99, Math.floor(100 * loaded / total));
    }
    percent = Math.max(previous, percent);
    if (percent !== previous) {
      previous = percent;
      onPercent(percent);
    }
  };
}
