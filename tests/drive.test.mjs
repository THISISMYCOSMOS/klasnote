import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveBackup, htmlHash, DRIVE_SCOPE } from '../extension/src/core/drive.js';
import { configureManifest } from '../scripts/configure-drive.mjs';
import { cleanSettings } from '../extension/src/core/policy.js';

const id = '0123456789abcdef';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function fixture() {
  let enabled = false, configured = true, user = 'account-a', tick = 1000, next = 0;
  const stored = {}, payloads = new Map(), files = new Map(), sessions = new Map(), downloads = new Map(), calls = [], tokens = [];
  const chrome = {
    runtime: { getManifest: () => configured ? { oauth2: { client_id:'fixture.apps.googleusercontent.com' } } : {} },
    storage: { local: { get: async () => structuredClone(stored), set: async data => Object.assign(stored, structuredClone(data)) } },
    identity: { getAuthToken: async options => { tokens.push(options); return { token: 'private-fixture-token' }; }, removeCachedAuthToken: async () => {} },
    downloads: { search: async ({ id }) => downloads.has(id) ? [{ id, state: downloads.get(id) }] : [] },
  };
  const jobs = { all: async () => [...payloads.values()].map(x => structuredClone(x)), put: async job => payloads.set(job.jobId, structuredClone(job)), remove: async key => payloads.delete(key) };
  const f = { stored, payloads, files, sessions, downloads, calls, tokens, chrome,
    set enabled(v) { enabled = v; }, set configured(v) { configured = v; }, set user(v) { user = v; }, fail: null };
  const fetchImpl = async (url, init = {}) => {
    init.signal?.throwIfAborted(); calls.push({ url, init });
    const intercepted = await f.fail?.(url, init); if (intercepted) return intercepted;
    init.signal?.throwIfAborted();
    if (url.includes('/about?')) return json({ user:{ permissionId:user, emailAddress:`${user}@example.test` } });
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files' && !init.method) {
      const query = u.searchParams.get('q');
      const props = [...query.matchAll(/key='([^']+)' and value='([^']+)'/g)].map(m => [m[1],m[2]]);
      const name = query.match(/ and name='([^']+)'/)?.[1], parent = query.match(/ and '([^']+)' in parents/)?.[1];
      return json({ files: [...files.values()].filter(file => !file.trashed && file.owner === user && props.every(([k,v]) => file.appProperties?.[k] === v) && (!name || file.name === name) && (!parent || file.parents?.includes(parent))) });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      const file = { ...JSON.parse(init.body), id:`file-${++next}`, owner:user }; files.set(file.id,file); return json({ id:file.id });
    }
    if (u.pathname.startsWith('/upload/drive/v3/files') && ['POST','PATCH'].includes(init.method)) {
      const fileId = init.method === 'PATCH' ? u.pathname.split('/').at(-1) : `file-${++next}`;
      const location = `https://www.googleapis.com/upload/drive/v3/files?session=${++next}`;
      sessions.set(location,{ fileId, metadata:JSON.parse(init.body), owner:user, bytes:[], offset:0, size:Number(init.headers['X-Upload-Content-Length']) });
      return json({},200,{ Location:location });
    }
    if (init.method === 'PUT' && sessions.has(url)) {
      const session = sessions.get(url), range = init.headers['Content-Range'];
      if (range.startsWith('bytes */')) {
        if (session.offset === session.size) return json({ id:session.fileId });
        return new Response(null,{ status:308, headers:session.offset ? { Range:`bytes=0-${session.offset-1}` } : {} });
      }
      const start = Number(range.match(/^bytes (\d+)/)[1]); assert.equal(start,session.offset);
      session.bytes.push(await init.body.arrayBuffer()); session.offset += init.body.size;
      if (session.offset < session.size) return new Response(null,{ status:308, headers:{ Range:`bytes=0-${session.offset-1}` } });
      const file = { ...files.get(session.fileId), ...session.metadata, id:session.fileId, owner:session.owner, sha256Checksum:await htmlHash(new Blob(session.bytes)) };
      files.set(file.id,file); return json({ id:file.id });
    }
    throw Error(`Unexpected request ${init.method || 'GET'} ${url}`);
  };
  f.newController = () => createDriveBackup({ chrome, jobs, settings:async () => ({ driveBackup:enabled }), fetchImpl, now:() => ++tick });
  f.drive = f.newController();
  f.connect = async () => { await f.drive.connect(); f.calls.length = 0; };
  f.stage = async (text='report', kind='raw', downloadId=1) => {
    if (!downloads.has(downloadId)) downloads.set(downloadId,'in_progress');
    return f.drive.stage({ blob:new Blob([text],{ type:'text/html' }), downloadId, contentId:id, kind, course:'과목', filename:`1주차_강의_${kind}.html` });
  };
  f.finish = async (downloadId=1) => { downloads.set(downloadId,'complete'); await f.drive.downloadChanged({ id:downloadId, state:{ current:'complete' } }); await f.drive.idle(); };
  f.record = async kind => (await f.drive.view(kind)).backups[id];
  f.reports = () => [...files.values()].filter(file => file.mimeType === 'text/html');
  return f;
}

test('backup is opt-in; an unconfigured install cannot authenticate; configuration is public and scoped', async () => {
  const f = fixture(); assert.equal(cleanSettings({}).driveBackup,false);
  assert.throws(() => cleanSettings({ driveBackup:'true' }));
  assert.equal(await f.stage(),false); assert.equal(f.payloads.size,0); assert.equal(f.calls.length,0); assert.equal(f.tokens.length,0);
  f.configured = false; await assert.rejects(f.drive.connect(),/준비/); assert.equal(f.tokens.length,0);
  const manifest = configureManifest({ key:'fixed', permissions:['identity'] },'123-example.apps.googleusercontent.com');
  assert.equal(manifest.key,'fixed'); assert.deepEqual(manifest.oauth2.scopes,[DRIVE_SCOPE]);
  assert.throws(() => configureManifest({},'invalid-client'));
});

test('connection alone does not upload; download completion gates backup and interruption cancels it', async () => {
  const f = fixture(); await f.connect(); assert.equal(await f.stage(),false); assert.equal(f.calls.length,0);
  f.enabled = true; await f.stage(); assert.equal((await f.record()).status,'waiting'); assert.equal(f.calls.length,0);
  await f.drive.downloadChanged({ id:1, state:{ current:'interrupted' } });
  assert.equal((await f.record()).status,'failed'); assert.equal(f.payloads.size,0); assert.equal(f.calls.length,0);
});

test('raw and summary have separate identity, repeat downloads skip unchanged bytes and changed reports update one file', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); await f.finish();
  assert.equal((await f.record()).status,'saved'); assert.equal(f.reports().length,1); assert.equal(f.payloads.size,0);
  const firstId = f.reports()[0].id, uploads = f.calls.filter(x => x.init.method === 'PUT').length;
  await f.stage(); await f.drive.idle(); assert.equal(f.calls.filter(x => x.init.method === 'PUT').length,uploads);
  await f.stage('changed'); await f.drive.idle(); assert.equal(f.reports()[0].id,firstId); assert.equal(f.reports().length,1);
  await f.stage('summary','summary',2); await f.finish(2); assert.equal(f.reports().length,2);
  const publicView = await f.drive.view('raw'); assert.equal(publicView.backups[id].kind,'raw');
  assert.equal(JSON.stringify(f.stored).includes('private-fixture-token'),false);
  assert.equal(JSON.stringify(publicView).includes('file-'),false);
  assert.equal(f.calls.some(x => /permissions/.test(x.url)),false);
});

test('completion before payload persistence is detected; cross-profile lookup updates the existing file', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; f.downloads.set(1,'complete'); await f.stage(); await f.drive.idle();
  assert.equal((await f.record()).status,'saved'); const fileId = f.reports()[0].id;
  f.stored.drive.records = {}; f.drive = f.newController(); await f.stage('new content'); await f.drive.idle();
  assert.equal(f.reports().length,1); assert.equal(f.reports()[0].id,fileId);
});

test('offline and quota failures preserve retry payload and never claim a successful backup', async () => {
  const f = fixture(); await f.connect(); f.enabled = true;
  f.fail = url => { if (url.includes('/about')) throw Error('offline'); };
  await f.stage(); await f.finish(); assert.equal((await f.record()).status,'failed'); assert.equal(f.payloads.size,1); assert.equal(f.reports().length,0);
  f.fail = null; await f.drive.retry(id,'raw'); await f.drive.idle(); assert.equal((await f.record()).status,'saved'); assert.equal(f.payloads.size,0);
  f.fail = url => url.includes('/upload/') ? json({},403) : null;
  await f.stage('second'); await f.drive.idle(); assert.equal((await f.record()).status,'failed'); assert.match((await f.record()).error,/권한|용량/);
});

test('remote existence, trash and offline checks do not leave a false success marker', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); await f.finish();
  const report = f.reports()[0]; report.trashed = true; await f.drive.refresh(); assert.equal((await f.record()).status,'missing');
  report.trashed = false; await f.drive.refresh(); assert.equal((await f.record()).status,'saved');
  report.sha256Checksum = 'modified-elsewhere'; await f.drive.refresh(); assert.equal((await f.record()).status,'outdated');
  report.sha256Checksum = await htmlHash(new Blob(['report'])); await f.drive.refresh();
  f.fail = () => { throw Error('offline'); }; await f.drive.refresh(); assert.equal((await f.record()).status,'unknown');
});

test('reconnecting never presents a previously checked backup as currently verified', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); await f.finish();
  await f.drive.disconnect(); f.reports()[0].trashed = true;
  const reconnected = await f.drive.connect();
  assert.equal(reconnected.backups[id].status, 'unknown');
  await f.drive.refresh(); assert.equal((await f.record()).status, 'missing');
  f.reports()[0].trashed = false;
  await f.drive.refresh(); assert.equal((await f.record()).status, 'saved');
});

test('regenerating a lecture marks the prior backup old, including after refreshing Drive', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); await f.finish();
  await f.drive.markOutdated(id); await f.drive.refresh(); assert.equal((await f.record()).status,'outdated');
  await f.stage(); await f.drive.idle(); assert.equal((await f.record()).status,'saved');
});

test('account changes never upload a private HTML to the wrong Google account', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); f.user = 'account-b'; await f.finish();
  assert.equal((await f.record()).status,'failed'); assert.equal(f.reports().length,0); assert.equal(f.calls.some(x => x.init.method === 'POST'),false);
  await f.drive.disconnect(); assert.equal((await f.drive.view()).connected,false); assert.equal(f.payloads.size,0); assert.deepEqual((await f.drive.view()).backups,{});
  await f.drive.connect(); assert.deepEqual((await f.drive.view()).backups,{});
});

test('worker restart resumes a multipart HTML upload from the acknowledged offset', async () => {
  const f = fixture(); await f.connect(); f.enabled = true;
  const large = 'a'.repeat(5 * 1024 * 1024);
  let chunks = 0; f.fail = (url, init) => { if (init.method === 'PUT' && !init.headers['Content-Range'].includes('*/') && ++chunks === 2) throw Error('connection lost'); };
  await f.stage(large); await f.finish(); assert.equal((await f.record()).status,'failed');
  const [job] = f.payloads.values(); assert.equal(job.offset,4 * 1024 * 1024);
  f.fail = null; f.drive = f.newController(); await f.drive.retry(id,'raw'); await f.drive.idle();
  assert.equal((await f.record()).status,'saved'); assert.equal(f.reports().length,1); assert.equal(f.payloads.size,0);
  assert.ok(f.calls.some(x => x.init.headers?.['Content-Range'] === `bytes 4194304-5242879/5242880`));
});

test('worker restart recovers a completed local download without creating a new local file', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); f.downloads.set(1,'complete');
  f.drive = f.newController(); await f.drive.recover(); await f.drive.idle();
  assert.equal((await f.record()).status,'saved'); assert.equal(f.reports().length,1);
});

test('local record deletion cancels pending payloads but leaves Drive files', async () => {
  const f = fixture(); await f.connect(); f.enabled = true; await f.stage(); await f.finish();
  f.downloads.set(2,'in_progress'); await f.stage('updated','raw',2); await f.drive.forgetLecture(id);
  assert.equal(f.payloads.size,0); assert.equal(f.reports().length,1); assert.equal(f.calls.some(x => x.init.method === 'DELETE'),false);
});

test('newer downloads staged during an upload drain replace older content without losing the new job', async () => {
  const f = fixture(); await f.connect(); f.enabled = true;
  let release, arrived; const ready = new Promise(r => { arrived = r; });
  f.fail = async (url,init) => { if (init.method === 'PUT' && !release) { await new Promise(r => { release = r; arrived(); }); } };
  await f.stage('older'); f.downloads.set(1,'complete'); await f.drive.downloadChanged({ id:1, state:{ current:'complete' } }); await ready;
  f.downloads.set(2,'complete'); await f.stage('newer','raw',2); release(); await f.drive.idle();
  assert.equal(f.reports().length,1); assert.equal(f.reports()[0].sha256Checksum,await htmlHash(new Blob(['newer'])));
  assert.equal((await f.record()).status,'saved'); assert.equal(f.payloads.size,0);
});

test('disabling backup during a request aborts the upload and leaves a manual retry',async()=>{
 const f=fixture();await f.connect();f.enabled=true;
 let arrived;const started=new Promise(r=>{arrived=r;});
 f.fail=(url,init)=>{if(init.method==='PUT')return new Promise((resolve,reject)=>{arrived();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});};
 await f.stage();await f.drive.downloadChanged({id:1,state:{current:'complete'}});await started;
 f.enabled=false;f.drive.stop();await f.drive.idle();
 assert.equal((await f.record()).status,'failed');assert.equal(f.reports().length,0);
 await assert.rejects(f.drive.retry(id,'raw'),/꺼졌/);
 f.enabled=true;f.fail=null;await f.drive.retry(id,'raw');await f.drive.idle();assert.equal((await f.record()).status,'saved');
});

test('disconnecting during an upload clears pending payloads and hides all account markers',async()=>{
 const f=fixture();await f.connect();f.enabled=true;
 let arrived;const started=new Promise(r=>{arrived=r;});
 f.fail=(url,init)=>{if(init.method==='PUT')return new Promise((resolve,reject)=>{arrived();init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});};
 await f.stage();await f.drive.downloadChanged({id:1,state:{current:'complete'}});await started;
 await f.drive.disconnect();await f.drive.idle();assert.equal(f.payloads.size,0);assert.deepEqual((await f.drive.view()).backups,{});assert.equal(f.reports().length,0);
});

test('a 401 refresh never replays upload bytes using a different account',async()=>{
 const f=fixture();await f.connect();f.enabled=true;let failed=false;
 f.fail=(url,init)=>{if(init.method==='PUT'&&!failed){failed=true;f.user='account-b';return json({},401);}};
 await f.stage();await f.finish();assert.equal((await f.record()).status,'failed');assert.equal(f.reports().length,0);
 assert.equal(f.calls.filter(x=>x.init.method==='PUT').length,1);
});
