// 받아쓰기 전용 작업자(Web Worker). 하나의 모델로 구간을 순서대로 처리한다.
import { loadAsr, transcribe, releaseAsr } from './src/core/asr.js';
import { createModelProgress } from './src/core/model-progress.js';

let model = null;
let modelKey = null;

let pending = Promise.resolve();
self.onmessage = ({ data }) => {
  // async onmessage는 다음 메시지를 기다리지 않는다. 재시도·해제를 포함한 명령 전체를 직렬화한다.
  pending = pending.then(() => handle(data)).catch((e) => console.error('asr worker handler failed', e));
};

async function handle(data) {
  const { id, cmd } = data || {};
  try {
    if (cmd === 'load') {
      modelKey = data.asrModel === 'small' ? 'small' : 'base';
      model = await loadAsr(modelKey, createModelProgress((progress) => self.postMessage({ id, progress })));
      self.postMessage({ id, ok: true, device: model.device, decoderDtype: model.device === 'wasm' ? 'q8' : model.decoderDtype });
    } else if (cmd === 'transcribe') {
      const pcm = new Float32Array(data.pcm);
      let segs;
      try {
        segs = await transcribe(model, pcm, data.offset);
      } catch (e) {
        if (['ASR_REPETITION', 'ASR_GENERATION_LIMIT'].includes(e?.code)) throw e;
        // GPU 장치 리셋 등으로 모델이 망가지면(예: 'destroy' 오류) 새로 불러 한 번 더 한다.
        console.warn('asr worker retry', e);
        self.postMessage({ id, diagnostic: e?.stack || String(e) });
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
    console.error('asr worker failed', e);
    self.postMessage({ id, ok: false, error: String(e?.message || e), stack: e?.stack, code: e?.code });
  }
}
