// Own-profile Chrome launcher. Uses only the official extension lifecycle/storage APIs.
// The pipe stays open until the human closes this Chrome window. No page automation.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync,existsSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {platformPaths,EXTENSION_ID,isLauncherAlive} from './platform.mjs';
const root=resolve(import.meta.dirname,'..');
const P=platformPaths();
const installed=P.installRoot;
const smoke=process.argv.includes('--smoke-close');
const profile=resolve(installed,smoke?'Chrome-smoke':'Chrome');
const chrome=P.chromeCandidates.find(existsSync);
if(!chrome)throw Error('Google Chrome을 찾을 수 없습니다.');
const extension=resolve(installed,'extension');
const helperRoot=P.helperRoot;
const helper=existsSync(helperRoot)?resolve(helperRoot,readdirSync(helperRoot).filter(v=>/^\d+(?:\.\d+)*_\d+$/.test(v)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1)||'missing'):'missing';
const id=EXTENSION_ID,pidFile=resolve(installed,smoke?'Chrome-smoke.pid':'Chrome-launch.pid');
mkdirSync(profile,{recursive:true});
if(existsSync(pidFile)){
  const alive=isLauncherAlive(pidFile);
  if(alive){const p=spawn(chrome,['--user-data-dir='+profile,'https://klas.kw.ac.kr/'],{windowsHide:false,detached:true,stdio:'ignore'});p.unref();process.exit(0);}
  unlinkSync(pidFile);
}
writeFileSync(pidFile,String(process.pid));
const p=spawn(chrome,['--user-data-dir='+profile,'--remote-debugging-pipe','--enable-unsafe-extension-debugging',...(smoke?['--headless=new']:[]),'--disable-background-mode','--no-first-run','--no-default-browser-check',smoke?'about:blank':'https://klas.kw.ac.kr/'],{windowsHide:smoke,stdio:['ignore','ignore','ignore','pipe','pipe']});
let buf='',seq=0,finished=false;const pending=new Map();const warnings=[];
function cleanup(){if(finished)return;finished=true;try{if(readFileSync(pidFile,'utf8')===String(process.pid))unlinkSync(pidFile);}catch{}for(const v of pending.values()){clearTimeout(v.timer);v.reject(Error('Chrome closed'));}pending.clear();}
p.on('exit',cleanup);p.on('error',cleanup);process.on('exit',cleanup);
p.stdio[4].on('data',d=>{buf+=d.toString();let at;while((at=buf.indexOf('\0'))>=0){const raw=buf.slice(0,at);buf=buf.slice(at+1);if(!raw)continue;try{const msg=JSON.parse(raw);if(msg.id&&pending.has(msg.id)){const v=pending.get(msg.id);pending.delete(msg.id);clearTimeout(v.timer);msg.error?v.reject(Error(msg.error.message)):v.resolve(msg.result);}}catch{}}});
function send(method,params={},sessionId){return new Promise((resolve,reject)=>{const callId=++seq,timer=setTimeout(()=>{pending.delete(callId);reject(Error('Chrome API timeout: '+method));},15000);pending.set(callId,{resolve,reject,timer});p.stdio[3].write(JSON.stringify({id:callId,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
try{
  const version=await send('Browser.getVersion');
  const loaded=await send('Extensions.loadUnpacked',{path:extension});
  if(loaded.id!==id)throw Error('Unexpected extension ID');
  // KLAS Helper는 있으면 함께 연결하되, 실패해도 우리 확장 실행은 계속한다(독립 검토 F9).
  if(existsSync(helper))await send('Extensions.loadUnpacked',{path:helper}).catch(e=>warnings.push('KLAS Helper 연결 실패: '+e.message));
  const list=await send('Extensions.getExtensions');
  if(!list.extensions.some(e=>e.id===id&&e.enabled))throw Error('Extension not enabled');
  let targets;
  for(let i=0;i<20;i++){
    targets=(await send('Target.getTargets')).targetInfos;
    if(targets.some(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'+id+'/')))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const worker=targets.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'+id+'/'));
  if(!worker&&smoke)throw Error('Extension service worker did not start');
  if(!worker){warnings.push('확장 서비스 워커 확인 지연');}
  if(!worker){writeFileSync(resolve(installed,'Chrome-start.log'),'Chrome ready (checks skipped): '+version.product+'\n'+warnings.join('\n'));}
  else{
  const {sessionId}=await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
  // Read only the fresh/default configuration; no lecture data, credentials or consent mutation.
  let storage=await send('Extensions.getStorageItems',{id,storageArea:'local',keys:['settings']},sessionId);
  for(let i=0;i<20&&!storage.data?.settings;i++){
    await new Promise(resolve=>setTimeout(resolve,250));
    storage=await send('Extensions.getStorageItems',{id,storageArea:'local',keys:['settings']},sessionId);
  }
  if(!storage.data?.settings){if(smoke)throw Error('Extension storage initialization did not complete');warnings.push('확장 저장소 초기화 확인 지연');}
  let persistence;
  if(smoke){const prior=await send('Extensions.getStorageItems',{id,storageArea:'local',keys:['__launcherSmoke']},sessionId);persistence=prior.data?.__launcherSmoke==='retained';await send('Extensions.setStorageItems',{id,storageArea:'local',values:{__launcherSmoke:'retained'}},sessionId);}
  await send('Target.detachFromTarget',{sessionId});
  const evidence={checkedAt:new Date().toISOString(),chrome:version.product,profile,extension:id,extensions:list.extensions,extensionWorkerRunning:true,settings:storage.data?.settings??null,connection:'Official Chrome Extensions API over a private process pipe; launcher required for each run',realLectureVerified:false,nativeHostViaChromeVerified:false,helperLiveCoexistenceVerified:false};
  const manifest=JSON.parse(readFileSync(resolve(extension,'manifest.json'),'utf8'));
  evidence.sidePanel={path:manifest.side_panel?.default_path,permission:manifest.permissions.includes('sidePanel'),visualOpeningVerified:false};
  if(smoke)evidence.storageRetainedAcrossReconnection=persistence;
  writeFileSync(resolve(installed,smoke?'Chrome-smoke.json':'Chrome-connection.json'),JSON.stringify(evidence,null,2));
  writeFileSync(resolve(installed,'Chrome-start.log'),'Chrome ready: '+version.product+'\n'+list.extensions.map(e=>e.name+': '+e.enabled).join('\n'));
  }
  if(smoke)await send('Browser.close');
}catch(e){
  writeFileSync(resolve(installed,'Chrome-start.log'),String(e.message));
  // 학생이 쓰던 Chrome 창은 닫지 않는다. 확인용 smoke 실행에서만 닫는다(독립 검토 F9).
  if(smoke){try{await send('Browser.close');}catch{}}
  cleanup();process.exitCode=1;
}
