// One-time publisher configuration. OAuth client IDs are public; no secret is used.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVE_SCOPE } from '../extension/src/core/drive.js';
export function configureManifest(manifest, clientId) {
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw Error('Google Chrome 확장용 OAuth 클라이언트 ID를 입력하세요.');
  return { ...manifest, oauth2: { client_id: clientId, scopes: [DRIVE_SCOPE] } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../extension/manifest.json', import.meta.url));
  const manifest = configureManifest(JSON.parse(fs.readFileSync(file,'utf8')), process.argv[2]);
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
  console.log('Google Drive OAuth 설정 완료. Chrome에서 확장을 다시 로드하세요.');
}
