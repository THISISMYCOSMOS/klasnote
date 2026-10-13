// Read-only installation checks. Never prints a key or sends audio/API requests.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {platformPaths,HOST_NAME,EXTENSION_ID} from './platform.mjs';

export function manifestExtensionId(key){
  if(typeof key!=='string'||!key)return null;
  return createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,char=>String.fromCharCode(97+parseInt(char,16)));
}
function registration(P){
  if(P.platform==='win32'){
    const key=`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    const result=spawnSync('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(result.error)throw Error('레지스트리 조회 도구를 실행하지 못했습니다.');
    if(result.status!==0)throw Error('네이티브 호스트 등록을 확인하지 못했습니다. 설치 여부와 레지스트리 접근 권한을 확인하세요.');
    const target=result.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
    if(!target)throw Error('호스트 등록 경로를 읽지 못했습니다.');
    return target;
  }
  return path.join(P.hostManifestDir,HOST_NAME+'.json');
}
export function diagnoseInstallation({P=platformPaths(),readRegistration=registration}={}){
  const checks=[];
  const add=(name,ok,detail)=>checks.push({name,ok,detail});
  add('Node.js 실행 환경',typeof fetch==='function'&&typeof FormData==='function'&&typeof Blob==='function',process.version+' · 최신 Node.js LTS 권장');
  const root=P.installRoot;
  add('설치 폴더',fs.existsSync(path.join(root,'.klas-summarizer-host')),root);
  for(const file of ['host.mjs','groq.mjs',P.hostLauncher,'extension/manifest.json','extension/vendor/mp4box.all.js']){
    add(file,fs.existsSync(path.join(root,file)),fs.existsSync(path.join(root,file))?'있음':'없음 · install을 다시 실행하세요.');
  }
  try{
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'),'utf8'));
    add('확장 ID',manifestExtensionId(manifest.key)===EXTENSION_ID,manifestExtensionId(manifest.key)||'key 없음');
  }catch{add('확장 ID',false,'설치된 manifest.json을 확인하지 못했습니다.');}
  try{
    const registered=readRegistration(P),host=JSON.parse(fs.readFileSync(registered,'utf8'));
    const expected=path.join(root,P.hostLauncher);
    add('Chrome 호스트 등록',host.name===HOST_NAME&&path.resolve(host.path)===path.resolve(expected)&&host.allowed_origins?.includes(`chrome-extension://${EXTENSION_ID}/`),registered);
    const script=fs.readFileSync(expected,'utf8');
    const nodePath=P.platform==='win32'?script.match(/^"([^"\r\n]+)"\s+"%~dp0host\.mjs"/m)?.[1]:script.match(/^exec '([^']+)'/m)?.[1];
    add('호스트 Node.js 경로',!!nodePath&&fs.existsSync(nodePath),nodePath||'실행 경로를 확인하지 못했습니다. install을 다시 실행하세요.');
  }catch(error){add('Chrome 호스트 등록',false,error.message);}
  // Presence only: no credential parsing or contents appear in the report.
  add('Groq 키 파일',true,fs.existsSync(path.join(root,'groq-config.json'))?'키 파일 있음 · 유효성은 설정의 연결 테스트로 확인':'키 파일 없음 · 설정에서 키를 저장하세요.');
  return {ok:checks.every(check=>check.ok),platform:P.platform,node:process.version,checks,googleDrive:'보류',realGroqAuthenticationVerified:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const report=diagnoseInstallation();console.log(process.argv.includes('--json')?JSON.stringify(report,null,2):report.checks.map(check=>`${check.ok?'[확인]':'[필요]'} ${check.name}: ${check.detail}`).join('\n'));process.exitCode=report.ok?0:1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
