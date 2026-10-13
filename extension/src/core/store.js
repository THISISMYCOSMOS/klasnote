// 강의 원본은 이 PC에 둔다. Drive 백업을 켠 경우에만 완성된 HTML을 업로드한다.
// lectures: 강의 정보와 진행 상태 / segments: 받아쓴 문장 / slides: 슬라이드 이미지 / summaries: AI 요약 결과

const DB = 'klas-summarizer';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('lectures')) {
        db.createObjectStore('lectures', { keyPath: 'contentId' });
        db.createObjectStore('segments', { keyPath: ['contentId', 'start'] }).createIndex('byLecture', 'contentId');
        db.createObjectStore('slides', { keyPath: ['contentId', 'start'] }).createIndex('byLecture', 'contentId');
        db.createObjectStore('summaries', { keyPath: 'contentId' });
      }
      if (!db.objectStoreNames.contains('driveJobs')) db.createObjectStore('driveJobs', { keyPath: 'jobId' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const txDone = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

export async function get(store, key) {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await open();
  const tx=db.transaction(store,'readwrite');
  const [result]=await Promise.all([done(tx.objectStore(store).put(value)),txDone(tx)]);
  return result;
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  for (const v of values) tx.objectStore(store).put(v);
  return txDone(tx);
}

export async function driveJobs() {
  const db = await open();
  return done(db.transaction('driveJobs').objectStore('driveJobs').getAll());
}
export async function removeDriveJob(jobId) {
  const db = await open(), tx = db.transaction('driveJobs', 'readwrite');
  await Promise.all([done(tx.objectStore('driveJobs').delete(jobId)), txDone(tx)]);
}

export async function byLecture(store, contentId) {
  const db = await open();
  const rows = await done(db.transaction(store).objectStore(store).index('byLecture').getAll(contentId));
  return rows.sort((a, b) => a.start - b.start);
}

export async function allLectures() {
  const db = await open();
  return done(db.transaction('lectures').objectStore('lectures').getAll());
}

export async function allSummaries() {
  const db = await open();
  // Library view needs only metadata, not every stored AI response in memory.
  return new Promise((resolve,reject)=>{
    const rows=[],req=db.transaction('summaries').objectStore('summaries').openCursor();
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{const cursor=req.result;if(!cursor){resolve(rows);return;}const x=cursor.value;rows.push({contentId:x.contentId,createdAt:x.createdAt,aiLabel:x.aiLabel});cursor.continue();};
  });
}

// 받아쓰기를 이어서 할 때 진행 지점 이후의 불완전한 데이터를 지운다.
export async function deleteFrom(contentId, fromSec) {
  const db = await open();
  const tx = db.transaction(['segments', 'slides'], 'readwrite');
  for (const s of ['segments', 'slides']) {
    tx.objectStore(s).delete(IDBKeyRange.bound([contentId, fromSec], [contentId, Infinity]));
  }
  return txDone(tx);
}

export async function deleteLecture(contentId) {
  const db = await open();
  const tx = db.transaction(['lectures', 'segments', 'slides', 'summaries'], 'readwrite');
  tx.objectStore('lectures').delete(contentId);
  tx.objectStore('summaries').delete(contentId);
  for (const s of ['segments', 'slides']) {
    tx.objectStore(s).delete(IDBKeyRange.bound([contentId, -Infinity], [contentId, Infinity]));
  }
  return txDone(tx);
}
