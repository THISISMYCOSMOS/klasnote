import test from 'node:test';
import assert from 'node:assert/strict';
import {SUMMARY_FORMAT} from '../extension/src/core/pack.js';
import {DEFAULT_SETTINGS,classifySender,safeName,parseSummary,cleanSettings,checkPayload} from '../extension/src/core/policy.js';

const id='0123456789abcdef',ext='klihhclhnhhmldcbnkpampimkjafmbdm',self=`chrome-extension://${ext}/`;
const ui={id:ext,url:self+'confirm.html?id='+id,tab:{id:1}};
let nativeFail=null;
let data,nativeCount,downloads,cache,pack,engineCount,nativeDelay=5,downloadFailures=0,panelOpens=[],lectureState='done',enqueueCount=0;
const clone=v=>structuredClone(v);
const summary={overview:'개요',slides:[{s:1,summary:['핵심'],comment:'설명'}],exam:['점검'],corrections:[]};
function reset(){data={settings:{...DEFAULT_SETTINGS,consent:true,asrConsent:true,mode:'ai',provider:'claude'},opened:{[id]:1},statuses:{},metadata:{[id]:{course:'과목',title:'강의'}}};nativeCount=0;downloads=0;cache=null;engineCount=0;pack={prompt:'강의: 테스트',images:[],slideCount:1,estimate:{total:2000}};}
reset();
globalThis.chrome={
  storage:{local:{get:async()=>clone(data),set:async v=>{data=clone(v);}}},
  runtime:{id:ext,getURL:p=>self+p,lastError:null,onMessage:{addListener(){}},onInstalled:{addListener(){}},
    getContexts:async()=>[{documentUrl:self+'offscreen.html'}],
    sendMessage:async m=>{
      if(m.target!=='offscreen')return;
      engineCount++;
      switch(m.cmd){case 'pauseQueue':return {ok:true};case 'ping':return {ok:true,gpu:true};case 'lecture':return {ok:true,item:{state:lectureState,title:'테스트'}};case 'enqueue':enqueueCount++;return {ok:true,queued:true};case 'getSummary':return {ok:true,item:cache};case 'pack':return {ok:true,...clone(pack)};case 'saveSummary':cache=clone(m.item);return {ok:true};case 'report':return lectureState==='missing'?{ok:false,error:'아직 받아쓰기가 끝나지 않았습니다.'}:{ok:true,url:'blob:'+self+'abc',title:'CON'};default:throw Error('unexpected engine command '+m.cmd);}
    },
    connectNative(){let onMessage,onDisconnect,timer;return {onMessage:{addListener(fn){onMessage=fn;}},onDisconnect:{addListener(fn){onDisconnect=fn;}},disconnect(){clearTimeout(timer);onDisconnect?.();},postMessage(m){nativeCount++;timer=setTimeout(()=>onMessage(m.cmd==='groqStatus'?{ok:true,configured:true}:m.cmd==='transcribeGroq'?{ok:true,segments:[]}:m.cmd==='summarize'&&nativeFail?{ok:false,error:nativeFail}:{ok:true,text:JSON.stringify(summary),usage:{input:42}}),nativeDelay);}};},
  },
  downloads:{download:async args=>{assert.match(args.filename,/KLAS요약\/과목\/_CON\.html$/);if(downloadFailures){downloadFailures--;throw Error('download failed');}downloads++;return downloads;}},
  offscreen:{createDocument:async()=>{},closeDocument:async()=>{}},tabs:{create:async()=>({id:2})}
};
let panelPaths=[];
chrome.sidePanel={setPanelBehavior:async()=>{},open:async options=>{panelOpens.push(options);},setOptions:async options=>{panelPaths.push(options.path);}};
const {route,friendlyError}=await import('../extension/background.js');
const send=(type,extra={})=>route({type,...extra},ui);

test('strict sender routes reject external and lookalike pages',()=>{
  assert.equal(classifySender(ui,self,ext),'ui');
  assert.equal(classifySender({...ui,url:self+'sidepanel.html'},self,ext),'ui');
  for(const url of ['https://evil.test/confirm.html','https://klas.kw.ac.kr.evil.test/std/lis/evltn/OnlineCntntsStdPage.do',self+'tools/test.html'])assert.equal(classifySender({...ui,url},self,ext),null);
  assert.equal(classifySender({...ui,id:'other'},self,ext),null);
});
test('KLAS controls open only their own tab side panel without starting processing',async()=>{
  reset();panelOpens=[];
  const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:27}};
  await route({type:'openPanel',tabId:999},listSender);
  assert.deepEqual(panelOpens,[{tabId:27}]);assert.equal(engineCount,0);assert.equal(nativeCount,0);
  await assert.rejects(route({type:'openPanel'},{...listSender,url:'https://example.com/'}),/발신자/);
  assert.equal(panelOpens.length,1);
});
test('KLAS header exposes only aggregate status and panel opening, never processing or automatic opening',async()=>{
  reset();panelOpens=[];
  const sender={id:ext,url:'https://klas.kw.ac.kr/std/cmn/frame/Frame.do',tab:{id:28},frameId:0};
  data.statuses={a:{state:'running'},b:{state:'awaiting_confirmation'},c:{state:'error'},d:{state:'complete'}};
  const status=await route({type:'getStatus'},sender);
  assert.deepEqual(status,{consent:true,counts:{active:1,ready:1,error:1}});
  assert.equal(panelOpens.length,0);assert.equal(engineCount,0);assert.equal(nativeCount,0);
  for(const type of ['manualSummary','setAuto','registerLectures','saveSettings'])await assert.rejects(route({type,contentId:id,enabled:true},sender),/허용되지/);
  await route({type:'openPanel',tabId:999},sender);assert.deepEqual(panelOpens,[{tabId:28}]);
  assert.equal(classifySender({...sender,frameId:1},self,ext),null);
});
test('manual row and sidebar actions review in the panel without invoking the engine or AI',async()=>{
  reset();panelPaths=[];
  const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:27}};
  const row=await route({type:'manualSummary',contentId:id},listSender);assert.equal(row.panel,true);
  const pane=await route({type:'openConfirm',contentId:id},{id:ext,url:self+'sidepanel.html'});assert.equal(pane.panel,true);
  assert.equal(panelPaths.length,2);assert.match(panelPaths[0],/confirm\.html\?id=0123456789abcdef&panel=1$/);
  assert.equal(engineCount,0);assert.equal(nativeCount,0);
  delete data.opened[id];await assert.rejects(route({type:'manualSummary',contentId:id},listSender),/열어/);assert.equal(panelPaths.length,2);
});
test('Windows output filenames and settings cannot bypass consent',()=>{
  assert.equal(safeName('../CON'),'.._CON');assert.equal(safeName('CON.txt'),'_CON.txt');assert.equal(safeName('..'),'강의');
  assert.equal(cleanSettings({consent:true}).consent,false);assert.throws(()=>cleanSettings({mode:'remote'}));
  assert.throws(()=>checkPayload({x:'a'.repeat(64*1024*1024)}),/64 MiB/);
});
test('summary parsing handles quoted braces and drops duplicate or malformed slide rows instead of discarding a paid result',()=>{
  assert.equal(parseSummary('```json\n'+JSON.stringify({...summary,overview:'문자 { } " 내용'})+'\n```').slides.length,1);
  const dup=parseSummary(JSON.stringify({...summary,slides:[summary.slides[0],{...summary.slides[0],comment:'중복'},{s:'2',summary:['문자열 번호']},{s:0,summary:[]},{s:3,summary:'한 줄'}]}));
  assert.deepEqual(dup.slides.map(x=>x.s),[1,2,3]);
  assert.notEqual(dup.slides[0].comment,'중복');
  assert.deepEqual(dup.slides[2].summary,['한 줄']);
  assert.throws(()=>parseSummary('요약을 만들 수 없습니다'),/JSON/);
});
test('unopened lecture and missing consent block processing',async()=>{
  reset();delete data.opened[id];await assert.rejects(send('prepareSummary',{contentId:id}),/열어/);assert.equal(engineCount,0);
  reset();data.settings.consent=false;await assert.rejects(send('prepareSummary',{contentId:id}),/안내/);assert.equal(nativeCount,0);
});
test('forged player ID cannot grant opened permission',async()=>{
  reset();delete data.opened[id];await assert.rejects(route({type:'lectureOpened',contentId:id},{id:ext,url:'https://kwcommons.kw.ac.kr/em/aaaaaaaaaaaaaaaa',tab:{id:3}}),/다릅니다/);assert.equal(data.opened[id],undefined);
});
test('report note action uses completed saved transcription without ASR or automatic AI',async()=>{
  reset();lectureState='done';enqueueCount=0;
  const ready=await send('prepareNote',{contentId:id});
  assert.equal(ready.local,false);assert.equal(enqueueCount,0);assert.equal(nativeCount,0);assert.equal(downloads,0);
  await send('summarize',{contentId:id,requestId:ready.requestId});assert.equal(nativeCount,1);assert.equal(downloads,1);
  reset();lectureState='paused';enqueueCount=0;
  await assert.rejects(send('prepareNote',{contentId:id}),/저장된 받아쓰기/);
  assert.equal(enqueueCount,0);assert.equal(nativeCount,0);assert.equal(downloads,0);
  lectureState='done';data.settings.mode='local';engineCount=0;
  await assert.rejects(send('prepareNote',{contentId:id}),/AI 모드/);
  assert.equal(engineCount,0);assert.equal(nativeCount,0);assert.equal(downloads,0);
  data.settings.mode='ai';data.settings.consent=false;
  await assert.rejects(send('prepareNote',{contentId:id}),/안내/);
});
test('preparing estimate never invokes AI; concurrent/replayed confirmation charges once',async()=>{
  reset();const ready=await send('prepareSummary',{contentId:id});assert.equal(nativeCount,0);
  const results=await Promise.allSettled([send('summarize',{contentId:id,requestId:ready.requestId}),send('summarize',{contentId:id,requestId:ready.requestId})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(nativeCount,1);assert.equal(downloads,1);
  await assert.rejects(send('summarize',{contentId:id,requestId:ready.requestId}),/만료/);assert.equal(nativeCount,1);
});
test('cache and local mode use no AI; local report does not attach cached AI',async()=>{
  reset();cache={provider:'claude',summary,summaryFormat:SUMMARY_FORMAT,aiLabel:'Claude'};let r=await send('prepareSummary',{contentId:id});assert.equal(r.cached,true);await send('summarize',{contentId:id,requestId:r.requestId});assert.equal(nativeCount,0);
  data.settings.mode='local';r=await send('prepareSummary',{contentId:id});assert.equal(r.local,true);await send('summarize',{contentId:id,requestId:r.requestId});assert.equal(nativeCount,0);
});

test('old slide summaries require a new explicit confirmation; new lecture notes reuse the cache',async()=>{
  reset();cache={provider:'claude',summary,aiLabel:'Claude'};
  const oldCache=cache;
  const ready=await send('prepareNote',{contentId:id});
  assert.equal(ready.cached,false);assert.equal(ready.outdatedSummary,true);
  assert.equal(cache,oldCache);assert.equal(nativeCount,0);assert.equal(downloads,0);
  await send('summarize',{contentId:id,requestId:ready.requestId});
  assert.equal(nativeCount,1);assert.equal(cache.summaryFormat,SUMMARY_FORMAT);assert.deepEqual(cache.summary.slides,[]);
  const again=await send('prepareNote',{contentId:id});assert.equal(again.cached,true);assert.equal(again.outdatedSummary,false);
  await send('summarize',{contentId:id,requestId:again.requestId});assert.equal(nativeCount,1);
});
test('changed settings or payload invalidate confirmation without AI',async()=>{
  reset();let r=await send('prepareSummary',{contentId:id});data.settings.preset='save';await assert.rejects(send('summarize',{contentId:id,requestId:r.requestId}),/변경/);assert.equal(nativeCount,0);
  reset();r=await send('prepareSummary',{contentId:id});pack.prompt+=' modified';await assert.rejects(send('summarize',{contentId:id,requestId:r.requestId}),/내용이 변경/);assert.equal(nativeCount,0);
});
test('cancel disconnects active native request and permits a later explicit retry',async()=>{
  reset();nativeDelay=1000;const r=await send('prepareSummary',{contentId:id});const pending=send('summarize',{contentId:id,requestId:r.requestId});
  const rejected=assert.rejects(pending,/중지/);
  while(nativeCount===0)await new Promise(resolve=>setTimeout(resolve,1));
  await send('cancel',{contentId:id});await rejected;assert.equal(cache,null);assert.equal(downloads,0);
  nativeDelay=5;const retry=await send('prepareSummary',{contentId:id});await send('summarize',{contentId:id,requestId:retry.requestId});assert.equal(cache.provider,'claude');assert.equal(nativeCount,2);
});
test('AI success plus download failure retries cache without charging and fills ready fields',async()=>{
  reset();downloadFailures=1;const ready=await send('prepareSummary',{contentId:id,force:true});await assert.rejects(send('summarize',{contentId:id,requestId:ready.requestId}),/download failed/);
  assert.equal(cache.provider,'claude');const retry=await send('prepareSummary',{contentId:id,force:false});assert.equal(retry.cached,true);assert.equal(retry.provider,'claude');assert.equal(retry.title,'테스트');assert.equal(retry.estimate.total,0);
  await send('download',{contentId:id});assert.equal(nativeCount,1);assert.equal(downloads,1);
});
test('transcription completion never creates a note or calls AI before explicit selection',async()=>{
  const engineSender={id:ext,url:self+'offscreen.html'};
  for(const mode of ['local','ai'])for(const auto of [false,true]){
    reset();data.settings.mode=mode;data.settings.confirmBeforeSend=false;
    data.statuses[id]={intent:{auto,force:false,settingsKey:JSON.stringify([mode,'claude',data.settings.claudeModel,data.settings.codexModel,'standard',false])}};
    await route({type:'status',contentId:id,patch:{state:'done'}},engineSender);await new Promise(r=>setTimeout(r,15));
    assert.equal(downloads,0);assert.equal(nativeCount,0);assert.equal(data.statuses[id].ticket,null);assert.equal(data.statuses[id].state,'done');
  }
  reset();data.settings.mode='local';const selected=await send('prepareSummary',{contentId:id});
  await send('summarize',{contentId:id,requestId:selected.requestId});assert.equal(downloads,1);assert.equal(nativeCount,0);
});

test('confirm page polling never restarts processing, so a cancel is not undone',async()=>{
  reset();lectureState='running';enqueueCount=0;data.statuses[id]={state:'paused'};
  const polled=await send('prepareSummary',{contentId:id,poll:true});
  assert.equal(polled.pending,true);assert.equal(polled.state,'paused');assert.equal(enqueueCount,0);
  const first=await send('prepareSummary',{contentId:id});
  assert.equal(first.pending,true);assert.equal(enqueueCount,1);
  lectureState='done';
});

test('a lecture with KLAS progress counts as opened, one without progress does not',async()=>{
  reset();delete data.opened[id];const other='fedcba9876543210';
  const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:5}};
  await route({type:'registerLectures',items:[{contentId:id,title:'들은 강의',prog:100},{contentId:other,title:'안 들은 강의',prog:0}]},listSender);
  assert.ok(data.opened[id]);assert.equal(data.opened[other],undefined);
});

test('"지금 요약" on an unprocessed lecture starts processing without opening the confirm screen',async()=>{
  reset();enqueueCount=0;panelOpens=[];panelPaths=[];
  const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:9}};
  const r=await route({type:'startProcessing',contentId:id},listSender);
  assert.equal(r.pending,true);assert.equal(enqueueCount,1);assert.equal(panelOpens.length,0);assert.equal(panelPaths.length,0);
  data.statuses[id]={state:'running'};
  await route({type:'startProcessing',contentId:id},listSender);
  assert.equal(enqueueCount,1,'already running: no second enqueue');
  reset();data.settings.consent=false;await assert.rejects(route({type:'startProcessing',contentId:id},listSender),/안내/);
});

test('Codex model setting is validated and used for Codex requests only',()=>{
  assert.equal(cleanSettings({codexModel:'gpt-5.6-luna'}).codexModel,'gpt-5.6-luna');
  assert.equal(cleanSettings({}).codexModel,'gpt-6-sol');
  assert.throws(()=>cleanSettings({codexModel:'evil; calc'}),/codexModel/);
  assert.throws(()=>cleanSettings({codexModel:'../x'}),/codexModel/);
});

test('legacy consent never grants external audio consent and strips the local model',()=>{
 const migrated=cleanSettings({},{...DEFAULT_SETTINGS,consent:true,asrModel:'small'});
 assert.equal(migrated.asrConsent,false);assert.equal(Object.hasOwn(migrated,'asrModel'),false);
});
test('Groq keys are available only through options, never KLAS or other extension views',async()=>{
 reset();const before=nativeCount;
 for(const sender of [ui,{id:ext,url:self+'sidepanel.html'},{id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:1}},{id:ext,url:self+'offscreen.html'}]){
  for(const type of ['groqStatus','saveGroqKey','removeGroqKey','testGroq'])await assert.rejects(route({type,apiKey:'fixture-key'},sender));
 }
 assert.equal(nativeCount,before);assert.equal(JSON.stringify(data).includes('fixture-key'),false);
 await route({type:'groqStatus'},{id:ext,url:self+'options.html'});assert.equal(nativeCount,before+1);
});
test('audio consent is required for initial enqueue and every native chunk',async()=>{
 reset();data.settings.asrConsent=false;const before=nativeCount;
 await assert.rejects(send('startProcessing',{contentId:id}),/Groq.*동의/);
 await assert.rejects(route({type:'transcribeAudio',contentId:id},{id:ext,url:self+'offscreen.html'}),/동의/);
 assert.equal(nativeCount,before);
});
test('cancellation during storage permission check never starts a late remote request',async()=>{
 reset();const original=chrome.storage.local.get;let release;
 chrome.storage.local.get=()=>new Promise(r=>{release=()=>r(clone(data));});
 const engineSender={id:ext,url:self+'offscreen.html'};
 const pending=route({type:'transcribeAudio',contentId:id,audioB64:'fixture',offset:0,duration:1},engineSender);
 const rejected=assert.rejects(pending,{name:'AbortError'});
 await route({type:'cancelAudio',contentId:id},engineSender);release();await rejected;
 assert.equal(nativeCount,0);chrome.storage.local.get=original;
});
test('the KLAS list can save a raw HTML once transcription is done, without an AI summary',async()=>{
 reset();
 const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:11}};
 data.statuses[id]={state:'running'};
 await assert.rejects(route({type:'download',contentId:id},listSender),/받아쓰기가 끝난/);
 for(const state of ['done','awaiting_confirmation','complete']){
  data.statuses[id]={state};const before=downloads;
  await route({type:'download',contentId:id},listSender);
  assert.equal(downloads,before+1,state);assert.equal(data.statuses[id].state,state,'saving raw HTML keeps the summary flow open');
 }
 assert.equal(nativeCount,0,'no AI call');
});

test('an outdated Claude Code error is explained in Korean and the raw HTML stays downloadable',async()=>{
 // Exact CLI message seen on 2026-10-05 with Claude Code 2.1.258 and claude-opus-5-5.
 const cli='claude 오류: API Error: 400 Claude Code 2.1.258 does not support this model; version 2.1.280 or newer is required. Run "claude update", or update the Claude desktop app, then try again.';
 assert.match(friendlyError(cli),/^Claude Code가 오래되어 .*claude update를 실행한 뒤 다시 시도하세요\. \(원문: claude 오류/);
 assert.equal(friendlyError('다른 오류'),'다른 오류');
 reset();lectureState='done';nativeFail=cli;
 try{
  const ready=await send('prepareNote',{contentId:id});
  await assert.rejects(send('summarize',{contentId:id,requestId:ready.requestId}));
 }finally{nativeFail=null;}
 assert.equal(data.statuses[id].state,'error');assert.equal(data.statuses[id].transcribed,true);
 assert.match(data.statuses[id].error,/claude update/);
 const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:12}};
 const before=downloads;await route({type:'download',contentId:id},listSender);assert.equal(downloads,before+1);
});
test('the engine status marks transcription done and clears the mark when transcription runs again',async()=>{
 reset();const engineSender={id:ext,url:self+'offscreen.html'};
 await route({type:'status',contentId:id,patch:{state:'running',progress:0.5}},engineSender);assert.equal(data.statuses[id].transcribed,false);
 await route({type:'status',contentId:id,patch:{state:'done'}},engineSender);await new Promise(r=>setTimeout(r,15));
 assert.equal(data.statuses[id].transcribed,true);
 data.statuses[id]={...data.statuses[id],state:'error'};
 const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:13}};
 await route({type:'download',contentId:id},listSender);
 await route({type:'status',contentId:id,patch:{state:'running'}},engineSender);
 data.statuses[id]={...data.statuses[id],state:'error'};
 await assert.rejects(route({type:'download',contentId:id},listSender),/받아쓰기가 끝난/);
});

test('a completed status without a stored transcript explains the fix and reopens processing',async()=>{
 // Seen 2026-10-05: lectures marked complete in the list had no transcript in this Chrome's IndexedDB.
 reset();lectureState='missing';
 const listSender={id:ext,url:'https://klas.kw.ac.kr/std/lis/evltn/OnlineCntntsStdPage.do',tab:{id:14}};
 data.statuses[id]={state:'complete',step:'HTML 저장 완료'};
 try{await assert.rejects(route({type:'download',contentId:id},listSender),/저장된 받아쓰기가 없습니다.*지금 요약/);}
 finally{lectureState='done';}
 assert.equal(data.statuses[id].state,'paused');assert.equal(data.statuses[id].transcribed,false);assert.equal(downloads,0);
});
