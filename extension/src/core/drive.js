// Optional, one-way HTML backup. Tokens stay in Chrome's identity cache.
// Upload payloads survive worker restarts; successful uploads release the local duplicate.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const CHUNK = 4 * 1024 * 1024; // multiple of Drive's 256 KiB upload unit
const fields = 'id,trashed,appProperties,sha256Checksum';
const quote = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const prop = (key, value) => `appProperties has { key='${key}' and value='${quote(value)}' }`;
const recordKey = (account, id, kind) => `${account}:${id}:${kind}`;
const failure = (message, code) => Object.assign(new Error(message), { code });
export async function htmlHash(blob) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function createDriveBackup({ chrome, jobs, settings, fetchImpl = fetch, now = Date.now }) {
  let writeTail = Promise.resolve(), drainTask = null, recoveryTask = null, aborter = null, activeJobId = null, connectionEpoch = 0;
  const read = async () => {
    const { drive } = await chrome.storage.local.get('drive');
    return { account: null, records: {}, ...drive };
  };
  function change(fn) {
    const task = writeTail.then(async () => {
      const data = await read(); await fn(data); await chrome.storage.local.set({ drive: data });
      return data;
    });
    writeTail = task.catch(() => {}); return task;
  }
  const configured = () => Boolean(chrome.runtime.getManifest?.().oauth2?.client_id);
  async function token(interactive = false) {
    if (!configured()) throw failure('이 설치본은 Google Drive 연결 준비가 필요합니다. 설정 안내를 확인하세요.', 'setup');
    const result = await chrome.identity.getAuthToken({ interactive, scopes: [DRIVE_SCOPE] });
    const value = typeof result === 'string' ? result : result?.token;
    if (!value) throw failure('Google 계정을 다시 연결하세요.', 'auth');
    return value;
  }
  async function request(url, init = {}, auth, signal, retry = true) {
    const timeout = AbortSignal.timeout(25000);
    const result = await fetchImpl(url, { ...init, redirect: 'error',
      headers: { ...init.headers, Authorization: `Bearer ${auth}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (result.status === 401 && retry) {
      await chrome.identity.removeCachedAuthToken({ token: auth });
      const renewed = await token(), expected = (await read()).account?.id;
      const check = await fetchImpl(`${API}/about?fields=user(permissionId)`, { headers: { Authorization: `Bearer ${renewed}` }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
      if (!check.ok || !expected || (await check.json()).user?.permissionId !== expected) throw failure('Google 계정을 다시 연결하세요.', 'auth');
      return request(url, init, renewed, signal, false);
    }
    if (result.status === 401) throw failure('Google 인증이 만료됐어요. 계정을 다시 연결하세요.', 'auth');
    if (result.status === 403) throw failure('Drive 권한 또는 저장 용량을 확인하세요.', 'permission');
    if (result.status === 429) throw failure('Drive 요청이 많아요. 잠시 후 다시 백업하세요.', 'quota');
    if (!result.ok && ![308, 404, 410].includes(result.status)) throw failure('Drive 백업에 실패했어요. 잠시 후 다시 시도하세요.', 'network');
    return result;
  }
  async function json(url, init, auth, signal) {
    const r = await request(url, init, auth, signal);
    if (!r.ok) throw failure('Drive 파일을 확인할 수 없습니다.', 'missing');
    return r.json();
  }
  async function account(auth, signal) {
    const result = await json(`${API}/about?fields=user(permissionId,emailAddress)`, {}, auth, signal);
    if (!result.user?.permissionId) throw failure('Google 계정을 확인할 수 없어요.', 'auth');
    return { id: result.user.permissionId, email: String(result.user.emailAddress || '') };
  }
  async function list(query, auth, signal) {
    const found = []; let page = '';
    do {
      const params = new URLSearchParams({ q: `trashed=false and ${query}`, fields: `nextPageToken,files(${fields})`, pageSize: '100', ...(page ? { pageToken: page } : {}) });
      const r = await json(`${API}/files?${params}`, {}, auth, signal);
      found.push(...(r.files || [])); page = r.nextPageToken || '';
    } while (page);
    return found;
  }
  async function folder(name, parent, role, auth, signal) {
    const query = `mimeType='application/vnd.google-apps.folder' and ${prop('klasnote', 'v1')} and ${prop('role', role)} and name='${quote(name)}' and '${quote(parent)}' in parents`;
    const matches = await list(query, auth, signal);
    if (matches.length) return matches[0].id;
    const created = await json(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent], appProperties: { klasnote: 'v1', role } }) }, auth, signal);
    if (!created.id) throw failure('Drive 폴더를 만들지 못했어요.', 'network');
    return created.id;
  }
  async function updateRecord(job, patch) {
    await change(data => {
      if (data.records[job.key]?.jobId === job.jobId) {
        const record = data.records[job.key];
        data.records[job.key] = { ...record, ...patch, ...(patch.status === 'saved' && record.dirty ? { status: 'outdated' } : {}) };
      }
    });
  }
  async function ensureEnabled(accountId) {
    const [data, current] = await Promise.all([read(), settings()]);
    if (!current.driveBackup || !data.account || data.account.id !== accountId) throw failure('Drive 백업이 꺼졌거나 계정 연결이 변경됐어요.', 'cancelled');
    return data;
  }
  async function upload(job) {
    const data = await ensureEnabled(job.accountId);
    if (data.records[job.key]?.jobId !== job.jobId) { await jobs.remove(job.jobId); return; }
    activeJobId = job.jobId; aborter = new AbortController(); const signal = aborter.signal;
    await updateRecord(job, { status: 'uploading', error: null });
    try {
      const auth = await token();
      if ((await account(auth, signal)).id !== job.accountId) throw failure('연결된 Google 계정이 달라요. 설정에서 다시 연결하세요.', 'auth');
      await ensureEnabled(job.accountId);
      const matches = await list(`${prop('klasnote', 'v1')} and ${prop('contentId', job.contentId)} and ${prop('reportKind', job.kind)}`, auth, signal);
      let file = matches.find(f => f.id === data.records[job.key]?.fileId) || matches[0];
      if (file?.sha256Checksum === job.hash) {
        await updateRecord(job, { status: 'saved', fileId: file.id, hash: job.hash, checkedAt: now(), error: null });
        await jobs.remove(job.jobId); return;
      }
      if (!job.session) {
        const root = await folder('KLAS요약', 'root', 'root', auth, signal);
        const course = await folder(job.course, root, 'course', auth, signal);
        const metadata = { name: job.filename, mimeType: 'text/html', appProperties: { klasnote: 'v1', contentId: job.contentId, reportKind: job.kind, contentHash: job.hash } };
        if (!file) metadata.parents = [course];
        const endpoint = `https://www.googleapis.com/upload/drive/v3/files${file ? '/' + encodeURIComponent(file.id) : ''}?uploadType=resumable&fields=id`;
        await ensureEnabled(job.accountId);
        const r = await request(endpoint, { method: file ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'text/html', 'X-Upload-Content-Length': String(job.blob.size) }, body: JSON.stringify(metadata) }, auth, signal);
        const session = r.headers.get('Location');
        if (!session || !session.startsWith('https://www.googleapis.com/upload/drive/v3/files')) throw failure('Drive 업로드 주소를 확인할 수 없어요.', 'network');
        job = { ...job, session, offset: 0 }; await jobs.put(job);
      } else {
        const r = await request(job.session, { method: 'PUT', headers: { 'Content-Range': `bytes */${job.blob.size}` }, body: new Blob([]) }, auth, signal);
        if (r.ok) {
          file = await r.json();
          if (!file.id) throw failure('Drive 업로드 완료를 확인할 수 없어요.', 'network');
          await updateRecord(job, { status: 'saved', fileId: file.id, hash: job.hash, uploadedAt: now(), checkedAt: now(), error: null });
          await jobs.remove(job.jobId); return;
        }
        if (r.status === 404 || r.status === 410) {
          job = { ...job, session: null, offset: 0 }; await jobs.put(job); return upload(job);
        }
        job.offset = Number(r.headers.get('Range')?.match(/-(\d+)$/)?.[1] ?? -1) + 1;
      }
      while (job.offset < job.blob.size) {
        await ensureEnabled(job.accountId);
        const end = Math.min(job.offset + CHUNK, job.blob.size);
        const r = await request(job.session, { method: 'PUT', headers: { 'Content-Type': 'text/html', 'Content-Range': `bytes ${job.offset}-${end - 1}/${job.blob.size}` }, body: job.blob.slice(job.offset, end) }, auth, signal);
        if (r.status === 404 || r.status === 410) throw failure('업로드 시간이 만료됐어요. 다시 백업하세요.', 'network');
        if (r.status === 308) {
          const offset = Number(r.headers.get('Range')?.match(/-(\d+)$/)?.[1] ?? -1) + 1;
          if (offset <= job.offset || offset > end) throw failure('Drive 업로드 진행을 확인할 수 없어요.', 'network');
          job = { ...job, offset }; await jobs.put(job); continue;
        }
        const uploaded = await r.json();
        if (!uploaded.id) throw failure('Drive 업로드 완료를 확인할 수 없어요.', 'network');
        await updateRecord(job, { status: 'saved', fileId: uploaded.id, hash: job.hash, uploadedAt: now(), checkedAt: now(), error: null });
        await jobs.remove(job.jobId); return;
      }
      throw failure('Drive 업로드 완료를 확인할 수 없어요. 다시 백업하세요.', 'network');
    } catch (err) {
      await updateRecord(job, { status: 'failed', error: err.code ? err.message : 'Drive 백업이 중단됐어요. 인터넷 연결을 확인하고 다시 백업하세요.' });
    } finally { aborter = null; activeJobId = null; }
  }
  function drain() {
    if (drainTask) return drainTask;
    drainTask = (async () => {
      const data = await read(), current = await settings();
      if (!current.driveBackup || !data.account) return;
      while (true) {
        const latest = await read(), current = await settings();
        if (!current.driveBackup || latest.account?.id !== data.account.id) break;
        const pending = (await jobs.all()).filter(j => j.ready && j.accountId === data.account.id);
        for (const stale of pending.filter(j => latest.records[j.key]?.jobId !== j.jobId)) await jobs.remove(stale.jobId);
        const job = pending.find(j => latest.records[j.key]?.jobId === j.jobId && ['waiting', 'uploading'].includes(latest.records[j.key]?.status));
        if (!job) break;
        await upload(job);
      }
    })().finally(() => { drainTask = null; });
    return drainTask;
  }
  async function view(kind = 'summary', detailed = false) {
    const data = await read(), backups = {};
    if (data.account) for (const value of Object.values(data.records).sort((a,b) => Number(a.kind === kind) - Number(b.kind === kind))) {
      if (value.accountId === data.account.id) {
        const { status, uploadedAt, checkedAt, error } = value;
        backups[value.contentId] = { status, uploadedAt, checkedAt, error, kind: value.kind };
      }
    }
    return { configured: configured(), connected: Boolean(data.account), backups, ...(detailed ? { email: data.account?.email || '' } : {}) };
  }
  async function connect() {
    aborter?.abort();
    const epoch = ++connectionEpoch;
    const auth = await token(true), user = await account(auth);
    if (epoch !== connectionEpoch) throw failure('계정 연결이 취소됐어요.', 'cancelled');
    await change(data => {
      data.account = user;
      // The previous existence check is no longer current after reconnecting.
      for (const record of Object.values(data.records)) {
        if (record.accountId === user.id && record.status === 'saved') record.status = 'unknown';
      }
    });
    return view('summary', true);
  }
  async function disconnect() {
    connectionEpoch++; aborter?.abort();
    await change(data => {
      data.account = null;
      for (const [key, record] of Object.entries(data.records)) {
        if (!record.fileId) delete data.records[key];
        else if (['waiting','uploading','failed'].includes(record.status)) record.status = 'outdated';
      }
    });
    for (const job of await jobs.all()) await jobs.remove(job.jobId);
    try { const auth = await token(); await chrome.identity.removeCachedAuthToken({ token: auth }); } catch {}
  }
  async function stage({ blob, downloadId, contentId, kind, course, filename }) {
    const data = await read(), current = await settings();
    if (!current.driveBackup || !data.account) return false;
    const accountId = data.account.id, key = recordKey(accountId, contentId, kind);
    const job = { jobId: crypto.randomUUID(), key, accountId, contentId, kind, course, filename, blob, downloadId, hash: await htmlHash(blob), ready: false };
    await ensureEnabled(accountId);
    await jobs.put(job);
    try {
      await change(data => {
        if (data.account?.id !== accountId) throw failure('Drive 계정 연결이 변경됐어요.', 'cancelled');
        const previous = data.records[key] || {};
        data.records[key] = { ...previous, key, jobId: job.jobId, accountId, contentId, kind, status: 'waiting', localHash: job.hash, dirty: false, error: null };
      });
    } catch (error) { await jobs.remove(job.jobId); throw error; }
    // Close the event race: completion may have happened while persisting the Blob.
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (download?.state) await downloadChanged({ id: downloadId, state: { current: download.state } });
    return true;
  }
  async function downloadChanged(delta) {
    if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
    for (const job of (await jobs.all()).filter(j => j.downloadId === delta.id)) {
      if (delta.state.current === 'interrupted') {
        await updateRecord(job, { status: 'failed', error: '로컬 다운로드가 중단됐어요. HTML을 다시 받아주세요.' });
        await jobs.remove(job.jobId);
      } else {
        await jobs.put({ ...job, ready: true });
        await updateRecord(job, { status: 'waiting' });
      }
    }
    if (delta.state.current === 'complete') void drain().catch(() => {});
  }
  async function retry(contentId, kind) {
    const data = await read(); await ensureEnabled(data.account?.id);
    kind = kind || (await view()).backups[contentId]?.kind;
    const key = recordKey(data.account.id, contentId, kind);
    const record = data.records[key], job = record && (await jobs.all()).find(j => j.jobId === record.jobId);
    if (!job?.ready) throw failure('다시 백업할 HTML이 없어요. HTML을 다시 받아주세요.', 'missing');
    await updateRecord(job, { status: 'waiting', error: null });
    void drain().catch(() => {});
  }
  async function refresh() {
    const data = await read(); if (!data.account) return;
    const epoch = connectionEpoch, auth = await token();
    if ((await account(auth)).id !== data.account.id) throw failure('Google 계정이 달라요. 설정에서 다시 연결하세요.', 'auth');
    // One app-scoped listing, not one request per visible row.
    const files = await list(prop('klasnote', 'v1'), auth);
    const found = new Map(files.map(f => [f.id, f]));
    await change(latest => {
      if (epoch !== connectionEpoch || latest.account?.id !== data.account.id) return;
      for (const record of Object.values(latest.records)) {
        if (record.accountId !== data.account.id || !record.fileId || ['waiting', 'uploading', 'failed'].includes(record.status)) continue;
        const file = found.get(record.fileId);
        record.status = !file ? 'missing' : record.dirty || (file.sha256Checksum || file.appProperties?.contentHash) !== record.localHash ? 'outdated' : 'saved';
        record.checkedAt = now();
      }
    });
  }
  async function markOutdated(contentId, kind) {
    await change(data => {
      for (const record of Object.values(data.records)) if (record.contentId === contentId && (!kind || record.kind === kind)) {
        record.dirty = true;
        if (record.status === 'saved') record.status = 'outdated';
      }
    });
  }
  async function recoverWork() {
    const data = await read(), current = await settings(); if (!data.account || !current.driveBackup) return;
    for (const job of await jobs.all()) {
      if (job.accountId !== data.account.id) continue;
      const [download] = await chrome.downloads.search({ id: job.downloadId });
      if (!job.ready && download?.state) await downloadChanged({ id: job.downloadId, state: { current: download.state } });
      else if (!job.ready) { await updateRecord(job, { status: 'failed', error: '다운로드 기록이 없어요. HTML을 다시 받아주세요.' }); await jobs.remove(job.jobId); }
    }
    await drain();
  }
  function recover() {
    if (!recoveryTask) recoveryTask = recoverWork().finally(() => { recoveryTask = null; });
    return recoveryTask;
  }
  async function forgetLecture(contentId) {
    const pending = (await jobs.all()).filter(job => job.contentId === contentId);
    if (pending.some(job => job.jobId === activeJobId)) aborter?.abort();
    for (const job of pending) {
      await updateRecord(job, { status: 'outdated', dirty: true, error: null });
      await jobs.remove(job.jobId);
    }
  }
  async function refreshSafely() {
    try { await refresh(); } catch {
      await change(data => { for (const record of Object.values(data.records)) if (record.status === 'saved') record.status = 'unknown'; });
    }
  }
  return { view, connect, disconnect, stage, downloadChanged, retry, refresh: refreshSafely, markOutdated, forgetLecture, recover,
    stop: () => { aborter?.abort(); }, idle: () => drainTask || Promise.resolve() };
}
