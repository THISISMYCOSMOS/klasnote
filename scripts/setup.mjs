import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {HOST_NAME as hostName,EXTENSION_ID as extensionId,platformPaths,macHostScript} from './platform.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
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
// manifestPath: Windows는 설치 폴더 안(레지스트리가 가리킴), macOS는 Chrome의 NativeMessagingHosts 폴더.
// registeredPath: 이미 등록된 대상(Windows는 레지스트리 값, macOS는 기존 manifest의 실행 파일 경로). 우리 것이 아니면 보존하고 중단한다.
export function validateTarget(root,registeredPath,{manifestPath=path.join(root,hostName+'.json'),expectedRegistered=manifestPath}={}){
  if(/["%\r\n]/.test(root)||/["%\r\n]/.test(process.execPath))throw Error('지원하지 않는 설치 경로 문자');
  const marker=path.join(root,'.klas-summarizer-host');
  if(fs.existsSync(root)&&(!fs.existsSync(marker)||fs.readFileSync(marker,'utf8').trim()!==hostName))throw Error('다른 폴더가 이미 있습니다. 기존 파일을 보존하고 설치를 중단합니다.');
  if(registeredPath&&path.resolve(registeredPath).toLowerCase()!==path.resolve(expectedRegistered).toLowerCase())throw Error('다른 네이티브 호스트가 등록되어 있습니다. 기존 등록을 보존합니다.');
  // 실행기 Chrome 프로필(Chrome, Chrome-smoke)은 Chrome이 관리하며 macOS에서는 SingletonLock 심볼릭 링크가 생긴다. 검사에서 제외한다.
  if(fs.existsSync(root))for(const name of fs.readdirSync(root))if(!/^Chrome(-smoke)?$/.test(name))inspectTree(path.join(root,name));
  return manifestPath;
}
function copyTree(from,to){
  if(fs.lstatSync(from).isDirectory()){fs.mkdirSync(to,{recursive:true});for(const name of fs.readdirSync(from))copyTree(path.join(from,name),path.join(to,name));}
  else fs.writeFileSync(to,fs.readFileSync(from));
}
function launch(executable,args){const p=spawn(executable,args,{detached:true,stdio:'ignore',windowsHide:false});p.on('error',()=>{});p.unref();}
function hostManifest(launcher){return JSON.stringify({name:hostName,description:'Personal KLAS lecture summaries',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]},null,2);}

function findNpmCli(){
  const dir=path.dirname(process.execPath);
  return [path.join(dir,'node_modules','npm','bin','npm-cli.js'),path.join(dir,'..','lib','node_modules','npm','bin','npm-cli.js')].find(f=>fs.existsSync(f))||null;
}
function writeHostConfig(root){
  let npmPrefix=null;const cli=findNpmCli();
  if(cli){const r=spawnSync(process.execPath,[cli,'prefix','-g'],{encoding:'utf8',windowsHide:true,timeout:20000});if(r.status===0)npmPrefix=r.stdout.trim()||null;}
  fs.writeFileSync(path.join(root,'host-config.json'),JSON.stringify({npmPrefix},null,2));
}
function windowsRegistered(){
  const query=spawnSync('reg.exe',['query',registryKey,'/ve'],{encoding:'utf8',windowsHide:true});
  if(query.error)throw Error('네이티브 호스트 등록 상태를 확인할 수 없습니다.');
  if(query.status!==0&&query.status!==1)throw Error('레지스트리 조회에 실패했습니다.');
  const registered=query.status===0?query.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim():null;
  if(query.status===0&&!registered)throw Error('기존 호스트 등록 경로를 읽지 못했습니다.');
  return registered;
}
function macRegistered(manifestPath){
  if(!fs.existsSync(manifestPath))return null;
  try{return JSON.parse(fs.readFileSync(manifestPath,'utf8')).path||manifestPath;}catch{return manifestPath;}
}

function install(){
  const P=platformPaths(),root=P.installRoot;
  const launcher=path.join(root,P.hostLauncher);
  const manifestPath=P.platform==='win32'?path.join(root,hostName+'.json'):path.join(P.hostManifestDir,hostName+'.json');
  const registered=P.platform==='win32'?windowsRegistered():macRegistered(manifestPath);
  validateTarget(root,registered,{manifestPath,expectedRegistered:P.platform==='win32'?manifestPath:launcher});
  const relative=path.relative(source,root);
  if(relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)))throw Error('설치 파일 폴더 내부에는 설치할 수 없습니다.');
  fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'.klas-summarizer-host'),hostName);
  // 업데이트는 새 폴더에 다 복사한 뒤 한 번에 바꿔 끼운다. 중간에 실패해도 예전 확장이 온전히 남는다(독립 검토 F8).
  const target=path.join(root,'extension'),staged=path.join(root,'extension.new'),old=path.join(root,'extension.old');
  fs.rmSync(staged,{recursive:true,force:true});fs.rmSync(old,{recursive:true,force:true});
  copyTree(path.join(source,'extension'),staged);
  if(fs.existsSync(target))fs.renameSync(target,old);
  fs.renameSync(staged,target);
  fs.rmSync(old,{recursive:true,force:true});
  fs.copyFileSync(path.join(source,'native-host/host.mjs'),path.join(root,'host.mjs'));
  if(P.platform==='win32'){
    // UTF-8 is enabled only in this host process; protocol stdout stays free of banners.
    fs.writeFileSync(launcher,'@echo off\r\nchcp 65001 >nul\r\n"'+process.execPath+'" "%~dp0host.mjs"\r\n');
    fs.writeFileSync(manifestPath,hostManifest(launcher));
    const result=spawnSync('reg.exe',['add',registryKey,'/ve','/t','REG_SZ','/d',manifestPath,'/f'],{encoding:'utf8',windowsHide:true});
    if(result.error||result.status!==0)throw Error('현재 사용자 네이티브 호스트 등록에 실패했습니다.');
  }else{
    fs.writeFileSync(launcher,macHostScript({nodePath:process.execPath,hostPath:path.join(root,'host.mjs'),home:os.homedir()}),{mode:0o755});
    fs.chmodSync(launcher,0o755);
    fs.mkdirSync(P.hostManifestDir,{recursive:true});
    fs.writeFileSync(manifestPath,hostManifest(launcher));
    // --user-data-dir로 띄운 Chrome은 macOS에서 <프로필 폴더>/NativeMessagingHosts를 본다(독립 검토 F2). 두 곳 모두 쓴다.
    const profileHosts=path.join(root,'Chrome','NativeMessagingHosts');
    fs.mkdirSync(profileHosts,{recursive:true});fs.writeFileSync(path.join(profileHosts,hostName+'.json'),hostManifest(launcher));
  }
  writeHostConfig(root);
  fs.writeFileSync(path.join(root,'.installed-version'),checkSource().version); // 모든 단계가 끝난 뒤에만 기록
  console.log('설치 완료: '+path.join(root,'extension'));
}

// macOS 제거(Windows는 uninstall.ps1). 우리 표식이 있는 폴더와 우리 것을 가리키는 등록만 지운다.
function uninstall(){
  const P=platformPaths();
  if(P.platform==='win32')throw Error('Windows에서는 uninstall.ps1을 사용하세요.');
  const root=P.installRoot,marker=path.join(root,'.klas-summarizer-host');
  if(!fs.existsSync(marker)||fs.readFileSync(marker,'utf8').trim()!==hostName)throw Error('설치 확인 파일이 없습니다. 삭제하지 않습니다.');
  const manifestPath=path.join(P.hostManifestDir,hostName+'.json');
  const registered=macRegistered(manifestPath);
  if(registered&&path.resolve(registered)===path.join(root,P.hostLauncher))fs.rmSync(manifestPath,{force:true});
  fs.rmSync(root,{recursive:true,force:true});
  console.log('제거했습니다. 브라우저에 남은 강의 기록은 확장의 로컬 기록에서 따로 삭제하세요.');
}

function main(){
  if(process.argv.includes('--uninstall')){uninstall();return;}
  const checked=checkSource();
  if(process.argv.includes('--check')){console.log(`설치 묶음 검사 통과: ${checked.files}개 필수 파일, 버전 ${checked.version}. 설치·등록은 수행하지 않았습니다.`);return;}
  install();
  if(!process.argv.includes('--install-only'))launch(process.execPath,[path.join(source,'scripts/chrome-launch.mjs')]);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(e){console.error(e.message);process.exitCode=1;}
