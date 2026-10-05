// Groq 받아쓰기와 로컬 슬라이드 캡처. 음성 인식 모델·PCM·GPU 추론을 만들지 않는다.
import {createSource,loadContentInfo,openMp4,fetchWindow,decodeKeyframes} from './src/core/media.js';
import {remuxAudioM4a,audioBase64} from './src/core/aac.js';
import {WINDOW,TAIL,commitWindow} from './src/core/window.js';
import {PAD,MAX_PER_WINDOW,MIN_GAP_MS,numbersIn,numberMismatch} from './src/core/numcheck.js';
import {createSlideDetector,toJpeg} from './src/core/slides.js';
import {buildPack,groupBySlide} from './src/core/pack.js';
import {buildReport} from './src/core/report.js';
import * as store from './src/core/store.js';
const MAX_WINDOW_BYTES=32*1024*1024,MODEL='whisper-large-v3-turbo';
const queue=[],cancelled=new Set();
let running=null,activeAbort=null,waiting=null,retryAt=0,retryTimer=null,lastGroqAt=0;
const pausedError=()=>Object.assign(new Error('사용자가 중지함'),{paused:true});
async function bg(type,data={}){const r=await chrome.runtime.sendMessage({target:'bg',type,...data});if(!r?.ok)throw Object.assign(new Error(r?.error||'연결 프로그램이 응답하지 않습니다.'),{code:r?.code,retryAt:r?.retryAt});return r;}
const status=(contentId,patch)=>chrome.runtime.sendMessage({target:'bg',type:'status',contentId,patch}).catch(()=>{});
function abortable(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>finish(reject,pausedError());const finish=(fn,v)=>{signal.removeEventListener('abort',abort);fn(v);};Promise.resolve(promise).then(v=>finish(resolve,v),e=>finish(reject,e));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
const mmss=x=>String(Math.floor(x/60)).padStart(2,'0')+':'+String(Math.floor(x%60)).padStart(2,'0');
async function run(job){
 const {contentId}=job,controller=new AbortController(),signal=controller.signal;activeAbort=controller;
 const checkCancel=()=>{if(signal.aborted||cancelled.has(contentId))throw pausedError();};
 const src=createSource((url,init)=>fetch(url,{...init,signal}));let det;
 try{
  checkCancel();let lec=await store.get('lectures',contentId);
  if(!lec){const info=await loadContentInfo(src,contentId);checkCancel();const extra=job.meta??{};
   lec={...info,title:info.title||String(extra.title||'').slice(0,200),course:String(extra.course||'').slice(0,100),professor:String(extra.professor||'').slice(0,50),week:Number(extra.week)||null,module:String(extra.module||'').slice(0,200),period:String(extra.period||'').slice(0,60),progressSec:0,state:'running',createdAt:Date.now()};}
  if(lec.state==='done')return status(contentId,{state:'done',progress:1,title:lec.title});
  const prevSlides=await store.byLecture('slides',contentId);
  const resumeAt=lec.progressSec||0;
  await store.deleteFrom(contentId,resumeAt);checkCancel();
  lec={...lec,state:'running',progressSec:resumeAt,error:null,asrModel:MODEL,asrProvider:'groq'};
  await store.put('lectures',lec);await status(contentId,{state:'running',progress:resumeAt/lec.duration,title:lec.title,step:'압축 음성 준비 중'});
  const mp4=await openMp4(src,lec.mediaUrl);checkCancel();const end=mp4.duration;
  const pendingSlide=prevSlides.findLast(s=>s.pending&&s.start<resumeAt);
  let seed=null;
  if(pendingSlide){const bitmap=await createImageBitmap(pendingSlide.blob);if(signal.aborted){bitmap.close();checkCancel();}seed={start:pendingSlide.start,bitmap};}
  det=createSlideDetector({seed});let slideCount=prevSlides.filter(s=>!s.pending).length;const skippedVideo=[];
  const saveSlides=async slides=>{for(const slide of slides){try{checkCancel();const blob=await toJpeg(slide.bitmap,{maxWidth:1280});checkCancel();await store.putMany('slides',[{contentId,start:slide.start,end:slide.end,blob}]);slideCount++;}finally{slide.bitmap.close();}}};
  for(let t=resumeAt;t<end;){
   // 확정 범위 WINDOW초에 TAIL초를 더 보낸다. 다음 구간은 저장한 마지막 발화 끝에서 시작한다(window.js).
   checkCancel();let span=Math.min(end-t,WINDOW+TAIL),w;
   while(true){try{w=await retryMedia(()=>fetchWindow(src,mp4,t,t+span,{slideEvery:2,signal,maxBytes:MAX_WINDOW_BYTES}),signal);break;}catch(e){if(e.code!=='PREFETCH_LIMIT'||span<=5)throw e;span/=2;}}
   const final=span===end-t,aEnd=final?end:t+span;
   checkCancel();const audio=remuxAudioM4a(mp4,w.audio);
   await status(contentId,{step:'Groq 받아쓰기 '+mmss(t)+'~'+mmss(aEnd)});
   const result=await abortable(bg('transcribeAudio',{contentId,audioB64:audioBase64(audio.bytes),offset:audio.offset,duration:audio.duration}),signal);
   checkCancel();
   if(!Array.isArray(result.segments))throw new Error('받아쓰기 응답 형식 오류');
   const {segs,next}=commitWindow(result.segments,{t,aEnd,final});lastGroqAt=Date.now();
   await recheckNumbers({contentId,mp4,audio:w.audio,segs,signal});checkCancel();
   await store.putMany('segments',segs.map(s=>({contentId,...s})));checkCancel();
   // 다음 시작 이후의 키프레임은 다음 구간에서 다시 받아 처리한다(슬라이드 중복 방지).
   try{await decodeKeyframes(mp4,w.keyframes.filter(k=>final||k.ts<next),{signal,onFrame:async frame=>{checkCancel();await saveSlides(det.push([frame]));}});}
   catch(e){if(signal.aborted||e.paused)throw e;skippedVideo.push(mmss(t)+'~'+mmss(next));}
   checkCancel();if(final)await saveSlides(det.finish(end));
   const checkpoint=det.checkpoint(next);
   if(checkpoint){const blob=await toJpeg(checkpoint.bitmap,{maxWidth:1280});checkCancel();await store.putMany('slides',[{contentId,start:checkpoint.start,end:next,blob,pending:true}]);}
   lec.progressSec=next;await store.put('lectures',lec);checkCancel();
   await status(contentId,{state:'running',progress:next/end,step:'Groq 받아쓰기 '+Math.round(next/end*100)+'%',preview:segs.slice(-2).map(s=>mmss(s.start)+' '+s.text).join('\n').slice(0,400),slides:slideCount});t=next;
  }
  checkCancel();lec.state='done';await store.put('lectures',lec);checkCancel();
  await status(contentId,{state:'done',progress:1,step:skippedVideo.length?'완료 · 일부 구간 슬라이드 없음('+skippedVideo.slice(0,3).join(', ')+')':'완료'});
 }finally{controller.abort();det?.dispose();if(activeAbort===controller)activeAbort=null;}
}
// 숫자가 든 발화만 앞뒤 PAD초를 붙여 다시 받아쓴다(numcheck.js). 분당 요청 한도를 넘지 않게 간격을 두고,
// 실패해도 받아쓰기는 계속하며 그 발화의 확인만 생략한다(중지는 그대로 전달).
async function recheckNumbers({contentId,mp4,audio,segs,signal}){
 let count=0;
 for(const s of segs){
  if(count>=MAX_PER_WINDOW||!numbersIn(s.text).length)continue;
  const samples=audio.filter(a=>a.ts+a.dur>s.start-PAD&&a.ts<s.end+PAD);
  if(!samples.length)continue;count++;
  try{
   await abortable(new Promise(r=>setTimeout(r,Math.max(0,lastGroqAt+MIN_GAP_MS-Date.now()))),signal);
   const clip=remuxAudioM4a(mp4,samples);
   const r=await abortable(bg('transcribeAudio',{contentId,audioB64:audioBase64(clip.bytes),offset:clip.offset,duration:clip.duration}),signal);
   const mismatch=Array.isArray(r.segments)?numberMismatch(s,r.segments):null;
   if(mismatch)s.numberCheck=mismatch.alt.slice(0,200);
  }catch(e){if(signal.aborted||e.paused)throw e;}
  finally{lastGroqAt=Date.now();}
 }
}
async function retryMedia(fn,signal){for(let attempt=0;;attempt++){if(signal.aborted)throw pausedError();try{return await fn();}catch(e){if(signal.aborted||e.paused)throw pausedError();if(attempt||e.code==='PREFETCH_LIMIT')throw e;await abortable(new Promise(r=>setTimeout(r,1500)),signal);}}}
function scheduleQuota(){clearTimeout(retryTimer);retryTimer=setTimeout(()=>{if(Date.now()<retryAt){scheduleQuota();return;}waiting=null;retryAt=0;pump();},Math.min(2147483647,Math.max(1,retryAt-Date.now())));}
async function pump(){
 if(running||waiting||!queue.length)return;running=queue.shift();
 try{await run(running);}catch(e){
  const stopped=!!e.paused||cancelled.has(running.contentId);cancelled.delete(running.contentId);
  const held=!stopped&&(e.code==='GROQ_RATE_LIMIT'||['GROQ_AUTH','GROQ_TRANSIENT','GROQ_MODEL_UNAVAILABLE'].includes(e.code)||/네이티브 호스트|연결 프로그램|Native host/i.test(e.message));
  if(held){queue.unshift(running);waiting=e.code==='GROQ_RATE_LIMIT'?'rate':'connection';retryAt=waiting==='rate'?Math.max(Date.now()+1000,Number(e.retryAt)||Date.now()+60000):0;
   await status(running.contentId,{state:'queued',error:null,step:waiting==='rate'?'Groq 한도 대기 · '+new Date(retryAt).toLocaleString()+' 이후 자동 재개':'Groq 연결 대기 · 설정에서 키 확인 후 연결 테스트를 눌러 주세요.'});if(waiting==='rate')scheduleQuota();
  }else{const lec=await store.get('lectures',running.contentId);if(lec)await store.put('lectures',{...lec,state:stopped?'paused':'error',error:stopped?null:String(e.message||e)});
   await status(running.contentId,stopped?{state:'paused',step:'일시정지'}:{state:'error',step:'오류 · 다시 시도할 수 있어요',error:String(e.message||e).slice(0,300)});}
 }finally{running=null;if(queue.length&&!waiting)pump();}
}

async function loadGroups(contentId) {
  const [lecture, slides, segments] = await Promise.all([
    store.get('lectures', contentId), store.byLecture('slides', contentId), store.byLecture('segments', contentId),
  ]);
  if (!lecture || lecture.state !== 'done') throw new Error('아직 받아쓰기가 끝나지 않았습니다.');
  return { lecture, slides, segments };
}

const handlers = {
  async ping(){return {provider:'groq'};},
  async playerAlive(){return {};},
  async jobs(){return {running:running?.contentId??null,queued:queue.map(j=>j.contentId),waiting, retryAt:retryAt||null};},
  async pauseQueue(){waiting='connection';clearTimeout(retryTimer);retryAt=0;if(running){cancelled.add(running.contentId);activeAbort?.abort();bg('cancelAudio',{contentId:running.contentId}).catch(()=>{});}return {};},
  async resumeQueue(){if(waiting==='rate'&&Date.now()<retryAt)return {waiting:true,retryAt};waiting=null;retryAt=0;clearTimeout(retryTimer);pump();return {};},
  async lecture({contentId}){return {item:await store.get('lectures',contentId)};},
  async getSummary({contentId}){return {item:await store.get('summaries',contentId)};},
  async saveSummary({contentId,item}){await store.put('summaries',{...item,contentId});return {};},
  async enqueue({contentId,meta}){
    if(running?.contentId===contentId||queue.some(j=>j.contentId===contentId))return {queued:true};
    cancelled.delete(contentId);queue.push({contentId,meta});await status(contentId,{state:'queued',step:'대기 중'});pump();return {queued:true};
  },
  async cancel({contentId}){
    const i=queue.findIndex(j=>j.contentId===contentId);
    if(i>=0){queue.splice(i,1);await status(contentId,{state:'paused',step:'일시정지'});if(!queue.length){clearTimeout(retryTimer);waiting=null;retryAt=0;}return {found:true};}
    if(running?.contentId===contentId){cancelled.add(contentId);activeAbort?.abort();bg('cancelAudio',{contentId}).catch(()=>{});return {found:true};}
    return {found:false};
  },
  async pack({ contentId, preset, provider }) {
    const { lecture, slides, segments } = await loadGroups(contentId);
    const pack = await buildPack({ lecture, slides, segments, preset, provider, toJpeg });
    return { ...pack, title: lecture.title };
  },
  async report({ contentId, summary, meta }) {
    const { lecture, slides, segments } = await loadGroups(contentId);
    const groups = groupBySlide(slides, segments);
    const html = await buildReport({ lecture, groups, summary, meta: { ...meta, asrModel: lecture.asrModel || '기존 받아쓰기', extensionId: chrome.runtime.id } });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    return { url, title: lecture.title };
  },
  async list() {
    return { items: await store.allLectures() };
  },
  async remove({ contentId }) {
    if (running?.contentId === contentId || queue.some(j => j.contentId === contentId)) throw new Error('받아쓰기가 멈춘 뒤 삭제할 수 있습니다. 잠시 후 다시 시도하세요.');
    await store.deleteLecture(contentId);
    return { ok: true };
  },
};

// 확장 내부(background)에서 온 메시지만 받는다. 콘텐츠 스크립트(탭에서 온 메시지)는 거부한다(레드팀 R3).
const SELF = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  if (sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(SELF)) return;
  if (!Object.hasOwn(handlers, msg.cmd)) return;
  if (msg.contentId !== undefined && !/^[0-9a-f]{8,32}$/i.test(String(msg.contentId))) { reply({ ok: false, error: 'bad contentId' }); return; }
  const h = handlers[msg.cmd];
  h(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: String(e.message || e),code:e.code,retryAt:e.retryAt }));
  return true;
});
