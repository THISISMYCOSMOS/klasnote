// node_modules에서 확장에 필요한 브라우저 파일을 extension/vendor로 복사한다.
// MV3는 원격 코드를 금지하므로 transformers.js와 ONNX Runtime wasm을 확장 안에 포함해야 한다.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'extension', 'vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['@huggingface/transformers/dist/transformers.js', 'transformers.js'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm'],
  ['mp4box/dist/mp4box.all.js', 'mp4box.all.js'],
];
for (const [src, dst] of files) {
  cpSync(join(nm, src), join(out, dst));
  console.log('vendored', dst);
}
