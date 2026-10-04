import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hostName='com.klas_summarizer.host';
const extensionId='klihhclhnhhmldcbnkpampimkjafmbdm';
const registryKey=`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
const required=['extension/manifest.json','extension/sidepanel.html','extension/assets/uni-basic.png','extension/assets/uni-study.png','extension/assets/uni-walk.png','extension/assets/uni-fly.png','extension/vendor/transformers.js','extension/vendor/mp4box.all.js','extension/vendor/ort-wasm-simd-threaded.asyncify.mjs','extension/vendor/ort-wasm-simd-threaded.asyncify.wasm','native-host/host.mjs'];

function inspectTree(file){
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())throw Error('심볼릭 링크를 포함한 설치 폴더는 지원하지 않습니다.');
  if(stat.isDirectory())for(const name of fs.readdirSync(file))inspectTree(path.join(file,name));
}
export function checkSource(root=source){
  for(const file of required)if(!fs.existsSync(path.join(root,file)))throw Error(`설치 파일 누락: ${file}. 설치 ZIP을 다시 풀어주세요.`);
  inspectTree(path.join(root,'extension'));inspectTree(path.join(root,'native-host'));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'extension/manifest.json'),'utf8'));
  if(manifest.manifest_version!==3||!manifest.key||!manifest.side_panel?.default_path)throw Error('확장 프로그램 설정 파일이 올바르지 않습니다.');
  return {files:required.length,version:manifest.version};
}
export function validateTarget(root,registeredPath){
  if(/["%\r\n]/.test(root)||/["%\r\n]/.test(process.execPath))throw Error('지원하지 않는 설치 경로 문자');
  const marker=path.join(root,'.klas-summarizer-host');
  if(fs.existsSync(root)&&(!fs.existsSync(marker)||fs.readFileSync(marker,'utf8').trim()!==hostName))throw Error('다른 폴더가 이미 있습니다. 기존 파일을 보존하고 설치를 중단합니다.');
  const manifestPath=path.join(root,hostName+'.json');
  if(registeredPath&&path.resolve(registeredPath).toLowerCase()!==manifestPath.toLowerCase())throw Error('다른 네이티브 호스트가 등록되어 있습니다. 기존 등록을 보존합니다.');
  if(fs.existsSync(root))inspectTree(root);
  return manifestPath;
}
function copyTree(from,to){
  if(fs.lstatSync(from).isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copyTree(path.join(from,name),path.join(to,name));}
  else fs.writeFileSync(to,fs.readFileSync(from));
}
function launch(executable,args){const p=spawn(executable,args,{detached:true,stdio:'ignore',windowsHide:false});p.on('error',()=>{});p.unref();}
function main(){
  const checked=checkSource();
  if(process.argv.includes('--check')){console.log(`설치 묶음 검사 통과: ${checked.files}개 필수 파일, 버전 ${checked.version}. 설치·등록은 수행하지 않았습니다.`);return;}
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Windows에서 install.cmd를 실행하세요.');
  const root=path.resolve(process.env.LOCALAPPDATA,'KlasSummarizer');
  const query=spawnSync('reg.exe',['query',registryKey,'/ve'],{encoding:'utf8',windowsHide:true});
  if(query.error)throw Error('네이티브 호스트 등록 상태를 확인할 수 없습니다.');
  if(query.status!==0&&query.status!==1)throw Error('레지스트리 조회에 실패했습니다.');
  const registered=query.status===0?query.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim():null;
  if(query.status===0&&!registered)throw Error('기존 호스트 등록 경로를 읽지 못했습니다.');
  const manifestPath=validateTarget(root,registered);
  const extensionTarget=path.join(root,'extension');
  const relative=path.relative(source,root);
  if(relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)))throw Error('설치 파일 폴더 내부에는 설치할 수 없습니다.');
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'.klas-summarizer-host'),hostName);
  copyTree(path.join(source,'extension'),extensionTarget);
  fs.copyFileSync(path.join(source,'native-host/host.mjs'),path.join(root,'host.mjs'));
  const launcher=path.join(root,'host.bat');
  // UTF-8 is enabled only in this host process; protocol stdout stays free of banners.
  fs.writeFileSync(launcher,'@echo off\r\nchcp 65001 >nul\r\n"'+process.execPath+'" "%~dp0host.mjs"\r\n');
  fs.writeFileSync(manifestPath,JSON.stringify({name:hostName,description:'Personal KLAS lecture summaries',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]},null,2));
  const result=spawnSync('reg.exe',['add',registryKey,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{encoding:'utf8',windowsHide:true});
  if(result.error||result.status!==0)throw Error('현재 사용자 네이티브 호스트 등록에 실패했습니다.');
  console.log('설치 완료. Chrome에서 개발자 모드 → 압축해제된 확장 프로그램 로드 → 아래 폴더를 선택하세요.\n'+extensionTarget+'\n이미 등록했다면 확장을 새로고침하세요.');
  const chrome=[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).map(p=>path.join(p,'Google/Chrome/Application/chrome.exe')).find(p=>fs.existsSync(p));
  if(chrome)launch(chrome,['chrome://extensions/']);
  launch('explorer.exe',[extensionTarget]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(e){console.error(e.message);process.exitCode=1;}
