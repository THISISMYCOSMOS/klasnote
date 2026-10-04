// 개발용 서버: 프로젝트 정적 파일 + kwcommons 프록시(Range 전달) + 결과 저장(/dump).
// 확장에서는 host_permissions로 kwcommons에 직접 접근하므로 이 서버는 개발·실측에만 쓴다.
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'tmp', 'spike-out');
const PORT = Number(process.env.PORT || 8787);
const ALLOW = 'https://kwcommons.kw.ac.kr/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/proxy') {
      const target = url.searchParams.get('u') || '';
      if (!target.startsWith(ALLOW)) { res.writeHead(403).end('forbidden'); return; }
      const headers = req.headers.range ? { Range: req.headers.range } : {};
      const r = await fetch(target, { headers });
      const h = { 'content-type': r.headers.get('content-type') || 'application/octet-stream' };
      for (const k of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(k)) h[k] = r.headers.get(k);
      res.writeHead(r.status, h);
      Readable.fromWeb(r.body).pipe(res);
      return;
    }
    if (url.pathname === '/dump' && req.method === 'POST') {
      // 다른 사이트가 보낸 요청으로 파일을 쓰지 못하게 같은 출처만 허용한다(레드팀 R8).
      if (req.headers.origin !== `http://localhost:${PORT}`) { res.writeHead(403).end('forbidden'); return; }
      const name = (url.searchParams.get('name') || 'out.bin').replace(/[^\w.\-]/g, '_');
      mkdirSync(outDir, { recursive: true });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      writeFileSync(join(outDir, name), Buffer.concat(chunks));
      res.writeHead(200).end('ok');
      return;
    }
    const p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root + sep) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    createReadStream(p).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`devserver http://localhost:${PORT}/tools/spike.html`));
