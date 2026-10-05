import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { WINDOW, TAIL, commitWindow } from '../extension/src/core/window.js';
import { PAD, MAX_PER_WINDOW, MIN_GAP_MS, numbersIn, numberMismatch } from '../extension/src/core/numcheck.js';

const id = '0123456789abcdef', nextId = '1123456789abcdef', lastId = '2123456789abcdef';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function until(check) {
  for (let i=0;i<200;i++) { if (await check()) return; await tick(); }
  assert.fail('expected remote engine event was not emitted');
}
function abortable(promise, signal) {
  return new Promise((resolve,reject) => {
    const finish = (fn,value) => { signal.removeEventListener('abort',abort); fn(value); };
    const abort = () => finish(reject,signal.reason || new DOMException('cancelled','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal.aborted)abort();
  });
}
const failure = (code, retryAt) => Object.assign(new Error('safe fixture failure'), {code,retryAt});

function engine({ duration=360, onTranscribe, onFetch, onDecode, onPut, database=new Map() } = {}) {
  const requests=[],cancelRequests=[],statuses=[],fetches=[],writes=[],bitmaps=[],jpegCalls=[],seeds=[],deletions=[];
  const tables = name => { if(!database.has(name))database.set(name,new Map());return database.get(name); };
  const key = row => row.start===undefined?row.contentId:`${row.contentId}/${row.start}`;
  const store = {
    get: async (name,itemKey) => structuredClone(tables(name).get(itemKey)),
    put: async (name,row) => { await onPut?.(name,row);tables(name).set(key(row),structuredClone(row)); },
    putMany: async (name,rows) => {
      for(const row of rows) { tables(name).set(key(row),structuredClone(row));writes.push({name,...structuredClone(row)}); }
    },
    byLecture: async (name,contentId) => [...tables(name).values()].filter(row=>row.contentId===contentId).map(row=>structuredClone(row)).sort((a,b)=>a.start-b.start),
    deleteFrom: async (contentId,from) => {
      deletions.push({contentId,from});
      for(const name of ['slides','segments'])for(const [itemKey,row]of tables(name))if(row.contentId===contentId&&row.start>=from)tables(name).delete(itemKey);
    },
    deleteLecture: async contentId => { for(const table of database.values())for(const [itemKey,row]of table)if(row.contentId===contentId)table.delete(itemKey); },
  };
  const bitmap = screen => { const item={screen,width:1280,height:720,closed:0,close(){this.closed++;}};bitmaps.push(item);return item; };
  let now=1_700_000_000_000,timerId=0;
  const timers=new Map();
  class ClockDate extends Date { static now(){return now;} }
  const clock={get now(){return now;},async advance(ms){
    now+=ms;
    for(let i=0;i<100;i++){
      const ready=[...timers].filter(([,timer])=>timer.due<=now).sort((a,b)=>a[1].due-b[1].due);
      if(!ready.length)return;
      for(const [timerKey,timer]of ready){if(!timers.delete(timerKey))continue;timer.fn();}
      await tick();
    }
    assert.fail('fixture timer loop');
  }};
  // Run the actual slide detector. Flat mock frames make image differences explicit.
  class Canvas {
    constructor(width,height){this.width=width;this.height=height;}
    getContext(){return {drawImage:frame=>{this.screen=frame.screen;},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4).fill(this.screen)})};}
  }
  const context=vm.createContext({
    URL,AbortController,DOMException,Date:ClockDate,Uint8Array,Uint8ClampedArray,Float32Array,OffscreenCanvas:Canvas,
    setTimeout:(fn,ms)=>{const timerKey=++timerId;timers.set(timerKey,{fn,due:now+ms});return timerKey;},clearTimeout:timerKey=>timers.delete(timerKey),
    store,console,WINDOW,TAIL,commitWindow,PAD,MAX_PER_WINDOW,MIN_GAP_MS,numbersIn,numberMismatch,fetch:async()=>{throw new Error('real network is forbidden in engine unit tests');},
    chrome:{runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:{addListener(){}},sendMessage:async message=>{
      if(message.type==='status'){statuses.push({contentId:message.contentId,...structuredClone(message.patch)});return {ok:true};}
      if(message.type==='cancelAudio'){cancelRequests.push(message.contentId);return {ok:true};}
      assert.equal(message.type,'transcribeAudio');requests.push(structuredClone(message));
      try{
        const result=await (onTranscribe?.(message,requests.length) ?? {segments:[{start:message.offset,end:message.offset+Math.min(1,message.duration),text:'fixture transcript'}]});
        return {ok:true,...result};
      }catch(error){return {ok:false,error:error.message,code:error.code,retryAt:error.retryAt};}
    }}},
    createSource:()=>({}),
    loadContentInfo:async(_,contentId)=>({contentId,title:'fixture lecture',duration,mediaUrl:contentId}),
    openMp4:async(_,contentId)=>({contentId,duration}),
    fetchWindow:async(_,mp4,start,end,options)=>{
      const request={contentId:mp4.contentId,start,end,options};fetches.push(request);
      await abortable(onFetch?.(request) ?? Promise.resolve(),options.signal);
      return {audio:[{ts:start,dur:end-start,data:new Uint8Array([1])}],keyframes:[{ts:start,screen:start<120?0:255}]};
    },
    remuxAudioM4a:(_,audio)=>({offset:audio[0].ts,duration:audio[0].dur,bytes:new Uint8Array([1,2,3])}),
    audioBase64:()=> 'fixtureM4A',
    decodeKeyframes:async(mp4,frames,{signal,onFrame})=>{
      assert.equal(typeof onFrame,'function','engine must consume decoded frames as a stream');
      await abortable(onDecode?.(mp4,frames,signal) ?? Promise.resolve(),signal);
      for(const frame of frames){if(signal.aborted)throw signal.reason;await onFrame({ts:frame.ts,bitmap:bitmap(frame.screen)});}
      return [];
    },
    createImageBitmap:async blob=>{const result=bitmap(blob.screen);seeds.push(result);return result;},
    toJpeg:async frame=>{assert.equal(frame.closed,0,'JPEG uses a live bitmap');jpegCalls.push(frame);return {screen:frame.screen};},
    buildPack(){},groupBySlide(){},buildReport(){},
  });
  const slideSource=readFileSync(new URL('../extension/src/core/slides.js',import.meta.url),'utf8').split('// 슬라이드 가장자리')[0].replace(/^export /gm,'');
  vm.runInContext(slideSource,context);
  const source=readFileSync(new URL('../extension/offscreen.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source+'\nglobalThis.api={run,handlers};',context);
  const idle=()=>until(async()=>{const jobs=await context.api.handlers.jobs();return !jobs.running&&!jobs.queued.length&&!jobs.waiting;});
  return {...context.api,requests,cancelRequests,statuses,fetches,writes,bitmaps,jpegCalls,seeds,deletions,store,database,clock,idle};
}

test('Groq engine sends one current window at a time, retaining current lecture priority',async()=>{
  const first=deferred();
  const fixture=engine({onTranscribe:(message,number)=>number===1?first.promise:undefined});
  await fixture.handlers.enqueue({contentId:id});
  await until(()=>fixture.requests.length===1);
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.enqueue({contentId:lastId});
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.enqueue({contentId:id});
  assert.deepEqual(Array.from((await fixture.handlers.jobs()).queued),[nextId,lastId]);
  assert.deepEqual(fixture.requests.map(message=>message.offset),[0]);
  assert.equal(fixture.fetches.length,1,'no next audio window is fetched while Groq is pending');
  first.resolve({segments:[{start:0,end:1,text:'first'}]});
  await fixture.idle();
  assert.deepEqual(fixture.requests.map(message=>[message.contentId,message.offset]),
    [id,nextId,lastId].flatMap(contentId=>[0,109,218,327].map(offset=>[contentId,offset])));
  assert.equal((await fixture.store.get('lectures',id)).asrProvider,'groq');
  assert.equal((await fixture.store.get('lectures',id)).asrModel,'whisper-large-v3-turbo');
  assert.ok(fixture.bitmaps.every(frame=>frame.closed===1),'all streamed frame bitmaps are released exactly once');
});

test('cancelled pending media fetch releases the next queued lecture immediately',async()=>{
  const blocked=deferred();
  const fixture=engine({duration:120,onFetch:request=>request.contentId===id?blocked.promise:undefined});
  await fixture.handlers.enqueue({contentId:id});
  await until(()=>fixture.fetches.length===1);
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.cancel({contentId:id});
  await fixture.idle();
  assert.equal(fixture.fetches[0].options.signal.aborted,true);
  assert.deepEqual(fixture.requests.map(message=>message.contentId),[nextId]);
  assert.equal((await fixture.store.get('lectures',id)).state,'paused');
  blocked.resolve();await tick();
  assert.ok(!fixture.writes.some(row=>row.name==='segments'&&row.contentId===id));
});

test('cancelled pending native transcription advances queue and ignores late success',async()=>{
  const blocked=deferred();
  const fixture=engine({duration:120,onTranscribe:message=>message.contentId===id?blocked.promise:undefined});
  await fixture.handlers.enqueue({contentId:id});
  await until(()=>fixture.requests.length===1);
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.cancel({contentId:id});
  await fixture.idle();
  assert.deepEqual(fixture.cancelRequests,[id]);
  assert.deepEqual(fixture.requests.map(message=>message.contentId),[id,nextId]);
  assert.equal((await fixture.store.get('lectures',id)).state,'paused');
  blocked.resolve({segments:[{start:0,end:1,text:'late transcript must be ignored'}]});
  await tick();await tick();
  assert.deepEqual(await fixture.store.byLecture('segments',id),[]);
  assert.ok(!fixture.statuses.some(status=>status.contentId===id&&status.state==='done'));
});

test('late native failure after cancellation cannot hold or restart the queue',async()=>{
  const blocked=deferred();
  const fixture=engine({duration:120,onTranscribe:message=>message.contentId===id?blocked.promise:undefined});
  await fixture.handlers.enqueue({contentId:id});await until(()=>fixture.requests.length===1);
  await fixture.handlers.enqueue({contentId:nextId});await fixture.handlers.cancel({contentId:id});await fixture.idle();
  blocked.reject(failure('GROQ_RATE_LIMIT',fixture.clock.now+5000));await tick();await tick();
  const jobs=await fixture.handlers.jobs();
  assert.equal(jobs.waiting,null);assert.deepEqual(Array.from(jobs.queued),[]);assert.equal(fixture.requests.length,2);
});

test('429 holds current lecture at queue front and sends no other lecture until the deadline',async()=>{
  let attempts=0;
  const fixture=engine({duration:120,onTranscribe:()=>{if(++attempts===1)throw failure('GROQ_RATE_LIMIT',fixture.clock.now+5000);}});
  await fixture.handlers.enqueue({contentId:id});
  await until(async()=>{const jobs=await fixture.handlers.jobs();return jobs.waiting==='rate'&&!jobs.running;});
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.enqueue({contentId:lastId});
  assert.deepEqual(Array.from((await fixture.handlers.jobs()).queued),[id,nextId,lastId]);
  assert.equal(fixture.requests.length,1);
  const manual=await fixture.handlers.resumeQueue();assert.equal(manual.waiting,true);
  await fixture.clock.advance(4999);assert.equal(fixture.requests.length,1);
  await fixture.clock.advance(1);await fixture.idle();
  assert.deepEqual(fixture.requests.map(message=>message.contentId),[id,id,nextId,lastId]);
  await fixture.clock.advance(10_000);assert.equal(fixture.requests.length,4,'deadline resumes exactly once');
});

test('auth and transient failures retain FIFO order until an explicit connection resume',async()=>{
  for(const code of ['GROQ_AUTH','GROQ_TRANSIENT','GROQ_MODEL_UNAVAILABLE']){
    let attempts=0;
    const fixture=engine({duration:120,onTranscribe:()=>{if(++attempts===1)throw failure(code);}});
    await fixture.handlers.enqueue({contentId:id});
    await until(async()=>{const jobs=await fixture.handlers.jobs();return jobs.waiting==='connection'&&!jobs.running;});
    await fixture.handlers.enqueue({contentId:nextId});
    await fixture.clock.advance(24*60*60*1000);
    assert.equal(fixture.requests.length,1,code+' never retries automatically');
    assert.deepEqual(Array.from((await fixture.handlers.jobs()).queued),[id,nextId]);
    await fixture.handlers.resumeQueue();await fixture.idle();
    assert.deepEqual(fixture.requests.map(message=>message.contentId),[id,id,nextId]);
  }
});

test('quota resume starts at committed audio checkpoint and restores the pending slide',async()=>{
  let calls=0;
  const fixture=engine({onTranscribe:()=>{if(++calls===2)throw failure('GROQ_RATE_LIMIT',fixture.clock.now+5000);}});
  await fixture.handlers.enqueue({contentId:id});
  await until(async()=>{const jobs=await fixture.handlers.jobs();return jobs.waiting==='rate'&&!jobs.running;});
  assert.equal((await fixture.store.get('lectures',id)).progressSec,109);
  assert.deepEqual((await fixture.store.byLecture('slides',id)).map(row=>[row.start,row.end,row.pending]),[[0,109,true]]);
  assert.equal((await fixture.store.byLecture('segments',id))[0].text,'fixture transcript');
  await fixture.clock.advance(5000);await fixture.idle();
  assert.deepEqual(fixture.requests.map(message=>message.offset),[0,109,109,218,327]);
  assert.equal(fixture.requests.filter(message=>message.offset===0).length,1,'successful audio is not uploaded again');
  assert.deepEqual(fixture.deletions.map(item=>item.from),[0,109]);
  assert.equal(fixture.seeds.length,1);
  assert.deepEqual((await fixture.store.byLecture('slides',id)).map(row=>[row.start,row.end,!!row.pending]),[[0,218,false],[218,360,false]]);
  assert.deepEqual((await fixture.store.byLecture('segments',id)).map(row=>row.start),[0,109,218,327]);
  assert.ok(fixture.bitmaps.every(frame=>frame.closed===1));
});

test('resume respects audio progress even when a completed slide ended earlier',async()=>{
  const database=new Map([
    ['lectures',new Map([[id,{contentId:id,title:'cached',duration:360,mediaUrl:id,state:'paused',progressSec:120}]])],
    ['segments',new Map([[id+'/0',{contentId:id,start:0,end:1,text:'already transcribed'}],[id+'/60',{contentId:id,start:60,end:61,text:'keep this'}]])],
    ['slides',new Map([[id+'/0',{contentId:id,start:0,end:30,blob:{screen:255}}],[id+'/30',{contentId:id,start:30,end:120,blob:{screen:0},pending:true}]])],
  ]);
  const fixture=engine({database});await fixture.handlers.enqueue({contentId:id});await fixture.idle();
  assert.deepEqual(fixture.requests.map(message=>message.offset),[120,229,338]);
  assert.deepEqual((await fixture.store.byLecture('segments',id)).map(row=>row.start),[0,60,120,229,338]);
  assert.deepEqual((await fixture.store.byLecture('slides',id)).map(row=>[row.start,row.end,!!row.pending]),[[0,30,false],[30,120,false],[120,360,false]]);
  assert.ok(fixture.bitmaps.every(frame=>frame.closed===1));
});

test('oversized compressed media windows shrink before remote transcription and retain continuous coverage',async()=>{
  const fixture=engine({duration:120,onFetch:request=>{assert.equal(request.options.maxBytes,32*1024*1024);if(request.end-request.start>30)throw failure('PREFETCH_LIMIT');}});
  await fixture.handlers.enqueue({contentId:id});await fixture.idle();
  assert.deepEqual(fixture.fetches.slice(0,3).map(request=>[request.start,request.end]),[[0,120],[0,60],[0,30]]);
  assert.ok(fixture.requests.every(message=>message.duration<=30));
  // Windows overlap by design; each one must start inside the previous audio so no speech is skipped.
  let covered=0;
  for(const request of fixture.requests){assert.ok(request.offset<=covered&&request.offset+request.duration>covered);covered=request.offset+request.duration;}
  assert.equal(covered,120);assert.equal((await fixture.store.get('lectures',id)).state,'done');
  assert.ok(fixture.bitmaps.every(frame=>frame.closed===1));
});

test('decoder failures retain transcription and complete with an explicit missing-slide status',async()=>{
  const fixture=engine({duration:120,onDecode:()=>{throw new Error('unsupported video fixture');}});
  await fixture.handlers.enqueue({contentId:id});await fixture.idle();
  assert.equal((await fixture.store.byLecture('segments',id)).length,1);
  assert.equal((await fixture.store.get('lectures',id)).state,'done');
  assert.match(fixture.statuses.findLast(status=>status.state==='done').step,/일부 구간 슬라이드 없음/);
});

test('removing a queued lecture preserves current request and cannot bypass the global quota hold',async()=>{
  const fixture=engine({duration:120,onTranscribe:()=>{throw failure('GROQ_RATE_LIMIT',fixture.clock.now+5000);}});
  await fixture.handlers.enqueue({contentId:id});
  await until(async()=>{const jobs=await fixture.handlers.jobs();return jobs.waiting==='rate'&&!jobs.running;});
  await fixture.handlers.enqueue({contentId:nextId});
  await fixture.handlers.cancel({contentId:id});
  assert.deepEqual(Array.from((await fixture.handlers.jobs()).queued),[nextId]);
  assert.equal((await fixture.handlers.resumeQueue()).waiting,true);
  await fixture.clock.advance(4999);assert.equal(fixture.requests.length,1);
  await fixture.handlers.cancel({contentId:nextId});
  const jobs=await fixture.handlers.jobs();assert.equal(jobs.waiting,null);assert.equal(jobs.retryAt,null);
  await fixture.clock.advance(10_000);assert.equal(fixture.requests.length,1);
});

test('number utterances are re-transcribed once with padding, paced under the request limit, and a mismatch is stored',async()=>{
  const fixture=engine({onTranscribe:(message,number)=>{
    if(number===1)return {segments:[{start:10,end:13,text:'출석의 20%'},{start:20,end:22,text:'숫자 없는 발화'}]};
    if(number===2)return {segments:[{start:9,end:14,text:'출석의 10%'}]};
  }});
  await fixture.handlers.enqueue({contentId:id});
  await until(()=>fixture.requests.length===1);
  await tick();await tick();
  assert.equal(fixture.requests.length,1,'the recheck waits for the request gap');
  await fixture.clock.advance(3100);
  await until(()=>fixture.requests.length>=2);
  await fixture.idle();
  assert.equal(fixture.requests.length,5,'4 windows plus one recheck for the only number utterance');
  const segments=await fixture.store.byLecture('segments',id);
  assert.equal(segments.find(row=>row.start===10).numberCheck,'출석의 10%');
  assert.equal(segments.find(row=>row.start===20).numberCheck,undefined);
  assert.equal((await fixture.store.get('lectures',id)).state,'done');
});

test('a failed number recheck never stops or re-queues transcription',async()=>{
  const fixture=engine({duration:120,onTranscribe:(message,number)=>{
    if(number===1)return {segments:[{start:10,end:13,text:'출석의 20%'}]};
    throw failure('GROQ_RATE_LIMIT',fixture.clock.now+60_000);
  }});
  await fixture.handlers.enqueue({contentId:id});
  await until(()=>fixture.requests.length===1);
  await fixture.clock.advance(3100);await fixture.idle();
  assert.equal(fixture.requests.length,2);
  assert.equal((await fixture.store.get('lectures',id)).state,'done');
  assert.equal((await fixture.store.byLecture('segments',id))[0].numberCheck,undefined);
  assert.equal((await fixture.handlers.jobs()).waiting,null);
});

test('the lecture records the transcription model reported by the native host',async()=>{
  const fixture=engine({duration:120,onTranscribe:()=>({segments:[{start:0,end:1,text:'첫 발화'}],model:'whisper-large-v3',provider:'groq'})});
  await fixture.handlers.enqueue({contentId:id});await fixture.idle();
  assert.equal((await fixture.store.get('lectures',id)).asrModel,'whisper-large-v3');
});
