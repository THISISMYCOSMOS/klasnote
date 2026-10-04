// 받아쓰기 전용 작업자(Web Worker). 작업자마다 Whisper 모델을 따로 불러 두 구간을 동시에 받아쓴다.
// 실측(2026-10-04, 내장 GPU): 1분 구간을 하나씩 18.3초, 두 개 동시에 각 약 22초 → 약 1.6배 처리량.
import { loadAsr, transcribe, releaseAsr } from './src/core/asr.js';

let model = null;
let modelKey = null;

self.onmessage = async ({ data }) => {
  const { id, cmd } = data || {};
  try {
    if (cmd === 'load') {
      modelKey = data.asrModel === 'base' ? 'base' : 'small';
      model = await loadAsr(modelKey, (p) => {
        if (p.status === 'progress' && p.total > 5e6) self.postMessage({ id, progress: Math.round(p.progress) });
      });
      self.postMessage({ id, ok: true, device: model.device });
    } else if (cmd === 'transcribe') {
      const pcm = new Float32Array(data.pcm);
      let segs;
      try {
        segs = await transcribe(model, pcm, data.offset);
      } catch (e) {
        // GPU 장치 리셋 등으로 모델이 망가지면(예: 'destroy' 오류) 새로 불러 한 번 더 한다.
        console.warn('asr worker retry', e);
        await releaseAsr().catch(() => {});
        model = await loadAsr(modelKey);
        segs = await transcribe(model, pcm, data.offset);
      }
      self.postMessage({ id, ok: true, segs });
    } else if (cmd === 'release') {
      await releaseAsr();
      model = null;
      self.postMessage({ id, ok: true });
    } else {
      throw new Error('알 수 없는 작업자 명령');
    }
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
