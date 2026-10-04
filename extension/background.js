import {DEFAULT_SETTINGS,validId,cleanSettings,cleanMeta,safeName,classifySender,parseSummary,checkPayload} from './src/core/policy.js';
import * as store from './src/core/store.js';

const SELF=chrome.runtime.getURL('');
const HOST='com.klas_summarizer.host';
let storageTail=Promise.resolve(), engineCreation=null;
const active=new Set(), deleted=new Set();
const nativeJobs=new Map();
const lastOpened=new Map(); // 강의 열림 이벤트 중복 방지(두 플레이어 프레임·빠른 재열기)
async function state(){const s=await chrome.storage.local.get(['settings','statuses','opened','metadata']);return {settings:{...DEFAULT_SETTINGS,...s.settings},statuses:s.statuses??{},opened:s.opened??{},metadata:s.metadata??{}};}
function mutate(fn){const p=storageTail.then(async()=>{const s=await state();await fn(s);await chrome.storage.local.set(s);chrome.runtime.sendMessage({target:'ui',type:'stateChanged'}).catch(()=>{});return s;});storageTail=p.catch(()=>{});return p;}
async function patch(id,p){await mutate(s=>{s.statuses[id]={...s.statuses[id],...p,updatedAt:Date.now()};});}
function requiredId(id){if(!validId(id))throw new Error('올바르지 않은 강의 ID');return id.toLowerCase();}
async function allowed(id){const s=await state();if(!s.settings.consent)throw new Error('먼저 데이터 처리 안내를 확인하세요.');if(!s.opened[id])throw new Error('이 강의를 한 번 열어 본 뒤 사용할 수 있습니다.');return s;}

export function nativeCall(message,{signal}={}){
  checkPayload(message);
  return new Promise((resolve,reject)=>{
    let port,settled=false;
    const abort=()=>finish(new Error('사용자가 AI 요청을 중지했습니다. 이미 사용한 사용량은 취소되지 않습니다.'));
    const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);try{port?.disconnect();}catch{}err?reject(err):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('AI 연결 시간이 초과되었습니다.')),12*60*1000);
    try{
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      port=chrome.runtime.connectNative(HOST);
      port.onMessage.addListener(response=>response?.ok?finish(null,response):finish(new Error(response?.error||'네이티브 호스트 오류')));
      port.onDisconnect.addListener(()=>{const e=chrome.runtime.lastError;finish(new Error(e?.message||'네이티브 호스트 연결이 끊겼습니다. 설치 상태를 확인하세요.'));});
      port.postMessage(message);
    }catch(e){finish(e);}
  });
}
async function rawEngine(cmd,data={}){const r=await chrome.runtime.sendMessage({target:'offscreen',cmd,...data});if(!r?.ok)throw new Error(r?.error||'로컬 처리 문서가 응답하지 않습니다.');return r;}
async function pingEngine(){for(let i=0;i<30;i++){try{return await rawEngine('ping');}catch{await new Promise(r=>setTimeout(r,100));}}throw new Error('로컬 처리 문서를 시작할 수 없습니다.');}
async function ensureEngine(){
  if(engineCreation)return engineCreation;
  engineCreation=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT','TAB'],documentUrls:[SELF+'offscreen.html',SELF+'processor.html']});
    if(contexts.some(c=>c.documentUrl===SELF+'processor.html'))return pingEngine();
    if(!contexts.some(c=>c.documentUrl===SELF+'offscreen.html'))await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS'],justification:'Whisper의 WASM/WebGPU 작업 및 MP4 트랙을 로컬에서 처리'});
    const caps=await pingEngine();
    if(!caps.gpu){await chrome.offscreen.closeDocument();await chrome.tabs.create({url:SELF+'processor.html',active:false});await pingEngine();}
  })().finally(()=>{engineCreation=null;});
  return engineCreation;
}
async function engine(cmd,data={}){await ensureEngine();return rawEngine(cmd,data);}
// 크롬 재시작·충돌·처리 탭 닫힘 뒤에는 메모리의 작업 큐가 사라진다. 실제 작업이 없는 '처리 중' 상태를 '중단됨'으로 돌려
// 학생이 '다시 시도'로 이어서 처리할 수 있게 한다(독립 검토 F1).
async function reconcile(){
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT','TAB'],documentUrls:[SELF+'offscreen.html',SELF+'processor.html']});
  let jobs=new Set();
  if(contexts.length){try{const r=await rawEngine('jobs');jobs=new Set([r.running,...(r.queued||[])].filter(Boolean));}catch{}}
  await mutate(s=>{for(const [id,st] of Object.entries(s.statuses)){
    if(['queued','running'].includes(st?.state)&&!jobs.has(id))s.statuses[id]={...st,state:'paused',step:'중단됨 · 다시 시도하면 이어서 처리해요',preview:null,updatedAt:Date.now()};
    else if(st?.state==='summarizing'&&!active.has(id))s.statuses[id]={...st,state:'error',step:'처리 오류',error:'Chrome이 닫히거나 다시 시작되어 AI 요약이 중단됐어요. "다시 시도"를 누르세요(이미 쓴 사용량은 돌아오지 않아요).',updatedAt:Date.now()};
  }});
}
reconcile().catch(()=>{});
chrome.runtime.onStartup?.addListener(()=>{reconcile().catch(()=>{});});
async function chooseProvider(settings){if(settings.provider!=='auto')return settings.provider;const host=await nativeCall({cmd:'detect'});if(host.claude)return 'claude';if(host.codex)return 'codex';throw new Error('Claude Code 또는 Codex CLI를 설치하고 로그인하세요.');}
const settingsKey=s=>JSON.stringify([s.mode,s.provider,s.claudeModel,s.codexModel,s.preset,s.confirmBeforeSend]);
const modelFor=(provider,s)=>provider==='codex'?s.codexModel:s.claudeModel;
async function packHash(pack){const data=new TextEncoder().encode(JSON.stringify({prompt:pack.prompt,images:pack.images}));const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',data));return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
async function download(id){
  const s=await allowed(id);
  const cached=await engine('getSummary',{contentId:id});
  const item=s.settings.mode==='ai'?cached.item:null;
  const r=await engine('report',{contentId:id,summary:item?.summary??null,meta:{aiLabel:item?.aiLabel??'로컬 받아쓰기 · AI 없음',createdAt:item?.createdAt??Date.now()}});
  const meta=s.metadata[id]??{},course=safeName(meta.course||'과목 미지정'),title=safeName(r.title);
  const prefix=meta.week?`${meta.week}주차_`:'';
  if(typeof r.url!=='string'||!r.url.startsWith('blob:'+SELF.slice(0,-1)+'/'))throw new Error('다운로드 주소 오류');
  const downloadId=await chrome.downloads.download({url:r.url,filename:`KLAS요약/${course}/${prefix}${title}.html`,conflictAction:'uniquify',saveAs:false});
  return {downloadId};
}
async function enqueue(id,{auto=false,force=false}={}){
  const s=await allowed(id);deleted.delete(id);
  if(s.statuses[id]?.state==='summarizing')throw new Error('현재 AI 요약 중입니다.');
  await patch(id,{intent:{auto,force,settingsKey:settingsKey(s.settings)},error:null});
  await engine('enqueue',{contentId:id,meta:s.metadata[id]??{},asrModel:s.settings.asrModel});
  return {pending:true};
}
async function prepare(id,force=false,{poll=false}={}){
  if(active.has(id))throw new Error('이 강의는 이미 처리 중입니다.');
  deleted.delete(id);
  const s=await allowed(id);
  const found=await engine('lecture',{contentId:id});
  // 확인 화면의 반복 확인(poll)은 상태만 보고 처리를 다시 시작하지 않는다. 그래야 '중지'가 3초 뒤 되살아나지 않고
  // 처리 내내 저장소 쓰기가 반복되지 않는다. 처리 시작은 첫 요청에서만 한다.
  if(found.item?.state!=='done'){if(poll)return {pending:true,state:s.statuses[id]?.state??null};return enqueue(id,{force});}
  const cached=await engine('getSummary',{contentId:id});
  const local=s.settings.mode==='local',useCache=!!cached.item&&!force;
  const provider=local?'local':useCache?cached.item.provider:await chooseProvider(s.settings);
  const pack=local||useCache?null:await engine('pack',{contentId:id,preset:s.settings.preset,provider});
  if(pack)checkPayload({cmd:'summarize',provider,model:modelFor(provider,s.settings),prompt:pack.prompt,images:pack.images});
  const requestId=crypto.randomUUID();
  const ticket={requestId,expires:Date.now()+20*60*1000,settingsKey:settingsKey(s.settings),provider,local,cached:useCache,force,hash:pack?await packHash(pack):null};
  const keepComplete=s.statuses[id]?.state==='complete'&&(local||useCache);
  await patch(id,{ticket,error:null,state:keepComplete?'complete':local||useCache?'done':'awaiting_confirmation',step:keepComplete?s.statuses[id].step:local?'로컬 HTML 준비됨':useCache?'저장된 요약 사용':'전송 확인 대기',estimate:pack?.estimate??{text:0,images:0,overhead:0,total:0}});
  return {requestId,estimate:pack?.estimate??{text:0,images:0,overhead:0,total:0},title:found.item.title,provider,cached:useCache,local};
}
async function summarize(id,requestId){
  if(active.has(id))throw new Error('이 강의는 이미 처리 중입니다.');
  active.add(id);
  try{
    const s=await allowed(id),ticket=s.statuses[id]?.ticket;
    if(!ticket||ticket.requestId!==requestId||ticket.expires<Date.now()||ticket.settingsKey!==settingsKey(s.settings))throw new Error('확인 정보가 만료되었거나 설정이 변경되었습니다. 다시 견적을 확인하세요.');
    // Consume before any paid call, so duplicate clicks/replays cannot charge twice.
    await patch(id,{ticket:null,intent:null});
    if(ticket.local||ticket.cached){const r=await download(id);await patch(id,{state:'complete',step:'HTML 저장 완료',error:null});return r;}
    const pack=await engine('pack',{contentId:id,preset:s.settings.preset,provider:ticket.provider});
    if(await packHash(pack)!==ticket.hash)throw new Error('전송할 내용이 변경되었습니다. 견적을 다시 확인하세요.');
    const request={cmd:'summarize',provider:ticket.provider,model:modelFor(ticket.provider,s.settings),prompt:pack.prompt,images:pack.images};checkPayload(request);
    if(deleted.has(id))throw new Error('작업이 중지되었습니다.');
    await patch(id,{state:'summarizing',step:'개인 계정으로 AI 요약 중'});
    const controller=new AbortController();nativeJobs.set(id,controller);
    const response=await nativeCall(request,{signal:controller.signal});
    const summary=parseSummary(response.text);
    // AI가 슬라이드를 하나 빼거나 합쳐도 결과를 버리지 않는다(독립 검토 F6). 범위 밖 번호는 버리고 빈 번호는 비운다.
    const byS=new Map();for(const x of summary.slides){const n=Number(x?.s);if(Number.isInteger(n)&&n>=1&&n<=pack.slideCount&&!byS.has(n))byS.set(n,x);}
    if(pack.slideCount>0&&byS.size===0&&!summary.overview)throw new Error('AI 응답에 사용할 수 있는 요약이 없습니다.');
    summary.slides=Array.from({length:pack.slideCount},(_,i)=>byS.get(i+1)??{s:i+1,summary:[],comment:''});
    const latest=await state();
    if(deleted.has(id)||!latest.settings.consent||latest.settings.mode!=='ai')throw new Error('작업이 취소되어 결과를 저장하지 않았습니다.');
    const aiLabel=ticket.provider==='codex'?`Codex · ${s.settings.codexModel}`:`Claude · ${s.settings.claudeModel}`;
    await engine('saveSummary',{contentId:id,item:{contentId:id,summary,provider:ticket.provider,aiLabel,createdAt:Date.now(),usage:response.usage,rawText:String(response.text||'').slice(0,400000)}});
    const r=await download(id);await patch(id,{state:'complete',step:'개인 요약 HTML 저장 완료',usage:response.usage,error:null});return r;
  }catch(e){if(!deleted.has(id))await patch(id,{state:'error',step:'처리 오류',error:String(e.message||e)});throw e;}finally{active.delete(id);nativeJobs.delete(id);}
}
async function afterTranscription(id){
  const s=await state(),intent=s.statuses[id]?.intent;
  if(!intent||!s.settings.consent||!s.opened[id]||active.has(id)||deleted.has(id))return;
  if(intent.settingsKey!==settingsKey(s.settings)){await patch(id,{intent:null,state:'done',step:'설정 변경됨 · 수동 실행 가능'});return;}
  const r=await prepare(id,intent.force);
  if(r.pending)return;
  if(intent.auto&&(r.local||r.cached||!s.settings.confirmBeforeSend))await summarize(id,r.requestId);
}
// '지금 요약'·'다시 시도': 받아쓰기가 아직이면 확인 화면 없이 처리만 시작한다. 끝나면 목록·패널에 '확인하고 저장'이 뜬다.
// (로컬 전용이거나 '전송 전 확인'을 끈 경우엔 끝나자마자 자동 저장된다.)
async function startProcessing(id){
  const s=await state();
  if(!s.settings.consent){await chrome.tabs.create({url:SELF+'consent.html'});throw new Error('처음 실행 안내를 확인한 뒤 다시 눌러 주세요.');}
  if(['queued','running','summarizing'].includes(s.statuses[id]?.state))return {pending:true};
  return enqueue(id,{auto:true});
}
async function openConfirm(id,force=false,sender){
  // Start opening within the original content-script gesture, before awaiting storage.
  const opening=chrome.sidePanel&&sender?.tab?chrome.sidePanel.open({tabId:sender.tab.id}).then(()=>true,()=>false):Promise.resolve(false);
  await allowed(id);
  if(chrome.sidePanel&&(await opening||sender?.url?.startsWith(SELF+'sidepanel.html'))){
    try{const path=`confirm.html?id=${id}&panel=1${force?'&force=1':''}`;await chrome.sidePanel.setOptions(sender?.tab?{tabId:sender.tab.id,path}:{path});return {panel:true};}catch{}
  }
  const tabs=await chrome.tabs.create({url:`${SELF}confirm.html?id=${id}${force?'&force=1':''}`});return {tabId:tabs.id};
}
const uiHandlers={
  getState:state,
  async saveSettings(m){const s=await mutate(s=>{s.settings=cleanSettings(m.settings,s.settings);});return {settings:s.settings};},
  async setConsent(m){if(!['local','ai'].includes(m.mode))throw new Error('처리 모드 오류');const s=await mutate(s=>{s.settings={...s.settings,consent:true,mode:m.mode};});return {settings:s.settings};},
  detect:()=>nativeCall({cmd:'detect'}),
  async test(){const s=await state();if(!s.settings.consent||s.settings.mode!=='ai')throw new Error('AI 모드 동의 후 연결 테스트가 가능합니다.');const provider=await chooseProvider(s.settings);return nativeCall({cmd:'test',provider,model:modelFor(provider,s.settings)});},
  codexModels:()=>nativeCall({cmd:'codexModels'}),
  async getLibrary(){const [items,summaries]=await Promise.all([store.allLectures(),store.allSummaries()]);return {items,summaries:Object.fromEntries(summaries.map(x=>[x.contentId,{createdAt:x.createdAt,aiLabel:x.aiLabel}]))};},
  async deleteLecture(m){const id=requiredId(m.contentId);if(active.has(id))throw new Error('AI 요청이 끝난 뒤 삭제할 수 있습니다.');const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT','TAB'],documentUrls:[SELF+'offscreen.html',SELF+'processor.html']});if(contexts.length)await rawEngine('remove',{contentId:id});else await store.deleteLecture(id);deleted.add(id);await mutate(s=>{delete s.statuses[id];});return {};},
  async cancel(m){const id=requiredId(m.contentId);if(active.has(id)){deleted.add(id);nativeJobs.get(id)?.abort();await patch(id,{intent:null,ticket:null,state:'paused',step:'AI 요청 중지됨 · 이미 사용한 사용량 유지'});return {};}const r=await engine('cancel',{contentId:id});await patch(id,r.found?{intent:null,ticket:null,step:'중지 요청됨'}:{intent:null,ticket:null,state:'paused',step:'중지됨',preview:null});return {};},
  download:m=>download(requiredId(m.contentId)),
  prepareSummary:m=>prepare(requiredId(m.contentId),m.force===true,{poll:m.poll===true}),
  summarize:m=>summarize(requiredId(m.contentId),m.requestId),
  openConfirm:(m,sender)=>openConfirm(requiredId(m.contentId),m.force===true,sender),
  startProcessing:m=>startProcessing(requiredId(m.contentId)),
  async openOptions(){await chrome.runtime.openOptionsPage();return {};},
  async resetPanel(){await chrome.sidePanel.setOptions({path:'sidepanel.html'});return {};},
};
export async function route(m,sender){
  const role=classifySender(sender,SELF,chrome.runtime.id);if(!role)throw new Error('허용되지 않은 메시지 발신자');
  if(role==='status'||role==='list'){
    if(m.type==='getStatus'){
      const s=await state(),counts={active:0,ready:0,error:0};
      for(const status of Object.values(s.statuses)){
        if(['queued','running','summarizing'].includes(status.state))counts.active++;
        else if(['done','awaiting_confirmation'].includes(status.state))counts.ready++;
        else if(status.state==='error')counts.error++;
      }
      return {consent:s.settings.consent,counts};
    }
    if(m.type==='openPanel'){const opening=chrome.sidePanel.open({tabId:sender.tab.id});chrome.sidePanel.setOptions({tabId:sender.tab.id,path:'sidepanel.html'}).catch(()=>{});await opening;return {};}
    if(role==='status')throw new Error('상태 표시에서 허용되지 않은 요청');
  }
  if(role==='engine'){
    if(m.type!=='status'||!validId(m.contentId))throw new Error('처리 상태 메시지 오류');
    const id=m.contentId.toLowerCase();if(deleted.has(id))return {};
    const input=m.patch??{},p={};
    for(const k of ['state','step','progress','title','preview','slides','error'])if(Object.hasOwn(input,k))p[k]=input[k];
    if(p.error!==undefined)p.error=p.error==null?null:String(p.error).slice(0,300);
    if(p.preview!==undefined)p.preview=String(p.preview).slice(0,400);if(p.slides!==undefined)p.slides=Math.max(0,Math.min(10000,Math.floor(Number(p.slides)||0)));
    if(p.state&&!['queued','running','done','paused','error'].includes(p.state))throw new Error('상태 오류');
    if(p.progress!==undefined)p.progress=Math.max(0,Math.min(1,Number(p.progress)||0));
    if(p.title)p.title=String(p.title).slice(0,200);if(p.step)p.step=String(p.step).slice(0,500);
    await patch(id,p);if(p.state==='done')afterTranscription(id).catch(e=>patch(id,{state:'error',error:String(e.message||e),intent:null}));return {};
  }
  if(role==='ui'){
    if(!Object.hasOwn(uiHandlers,m.type))throw new Error('알 수 없는 요청');return uiHandlers[m.type](m,sender);
  }
  if(role==='list'){
    if(m.type==='getState')return state();
    if(m.type==='registerLectures'){
      if(!Array.isArray(m.items)||m.items.length>1000)throw new Error('강의 목록 오류');
      // KLAS 진도가 0%보다 큰 강의는 학생이 이미 연 강의로 인정한다(설치 전에 다 들은 강의도 다시 열 필요 없음).
      // 진도 값은 페이지가 주는 정보라 위조될 수 있지만, 이것만으로는 처리·전송이 시작되지 않고 학생의 클릭과 확인이 여전히 필요하다.
      await mutate(s=>{for(const item of m.items)if(validId(item.contentId)){const id=item.contentId.toLowerCase();s.metadata[id]=cleanMeta(item);if(Number(item.prog)>0&&!s.opened[id])s.opened[id]=Date.now();}});return {};
    }
    if(m.type==='openOptions'){await chrome.runtime.openOptionsPage();return {};}
    const id=requiredId(m.contentId);
    if(m.type==='setAuto'){
      const s=await state();if(!s.settings.consent){await chrome.tabs.create({url:SELF+'consent.html'});throw new Error('처음 실행 안내를 확인한 뒤 켜 주세요.');}
      if(typeof m.enabled!=='boolean')throw new Error('스위치 값 오류');await patch(id,{auto:m.enabled});return {};
    }
    if(m.type==='manualSummary')return openConfirm(id,false,sender);
    if(m.type==='startProcessing')return startProcessing(id);
    // 목록의 'HTML 받기': 이미 완료된 강의만, 저장된 결과로 다시 만든다(AI 재호출 없음).
    if(m.type==='download'){const s=await state();if(s.statuses[id]?.state!=='complete')throw new Error('처리가 끝난 강의만 받을 수 있습니다.');return download(id);}
    throw new Error('목록에서 허용되지 않은 요청');
  }
  if(role==='player'){
    // 강의 재생 중 신호: 처리 엔진이 떠 있을 때만 전달해 재생 중엔 받아쓰기를 1개로 줄인다(GPU 경합 방지).
    if(m.type==='playerAlive'){const c=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT','TAB'],documentUrls:[SELF+'offscreen.html',SELF+'processor.html']});if(c.length)await rawEngine('playerAlive').catch(()=>{});return {};}
    if(m.type!=='lectureOpened')throw new Error('플레이어에서 허용되지 않은 요청');
    const id=requiredId(m.contentId),url=new URL(sender.url);
    const pathId=url.pathname.match(/^\/em\/([0-9a-f]{8,32})(?:\/|$)/i)?.[1];
    const queryId=url.searchParams.get('content_id')??url.searchParams.get('contentId');
    if((pathId??queryId)?.toLowerCase()!==id)throw new Error('플레이어 URL과 강의 ID가 다릅니다.');
    const s=await mutate(s=>{s.opened[id]=Date.now();});
    const st=s.statuses[id],now=Date.now();if(now-(lastOpened.get(id)||0)<10_000)return {};lastOpened.set(id,now);
    if(s.settings.consent&&st?.auto&&!['complete','queued','running','summarizing','awaiting_confirmation','done'].includes(st?.state))await enqueue(id,{auto:true});return {};
  }
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m?.target!=='bg')return;
  route(m,sender).then(r=>reply({ok:true,...r}),e=>reply({ok:false,error:String(e.message||e)}));return true;
});
chrome.runtime.onInstalled.addListener(async({reason})=>{const s=await mutate(()=>{});if(reason==='install'&&!s.settings.consent)await chrome.tabs.create({url:SELF+'consent.html'});});
chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});
