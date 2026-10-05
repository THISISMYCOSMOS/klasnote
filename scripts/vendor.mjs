// node_modules에서 확장에 필요한 브라우저 파일을 extension/vendor로 복사한다.
// 음성 인식 런타임은 포함하지 않는다. MP4 구조를 읽는 코드만 묶는다.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'extension', 'vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['mp4box/dist/mp4box.all.js', 'mp4box.all.js'],
];
for (const [src, dst] of files) {
  cpSync(join(nm, src), join(out, dst));
  console.log('vendored', dst);
}
