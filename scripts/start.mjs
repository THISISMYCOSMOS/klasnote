import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkSource,validateTarget} from './setup.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  checkSource(source);
  if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Windows에서 start.cmd를 실행하세요.');
  const target=path.resolve(process.env.LOCALAPPDATA,'KlasSummarizer');
  validateTarget(target,null);
  const installed=path.join(target,'extension/manifest.json');
  const sourceManifest=JSON.parse(fs.readFileSync(path.join(source,'extension/manifest.json'),'utf8'));
  const current=fs.existsSync(installed)?JSON.parse(fs.readFileSync(installed,'utf8')).version:null;
  if(current!==sourceManifest.version||!fs.existsSync(path.join(target,'host.mjs'))){
    const result=spawnSync(process.execPath,[path.join(source,'scripts/setup.mjs'),'--install-only'],{stdio:'inherit',windowsHide:true});
    if(result.error||result.status!==0)throw Error('설치하지 못했습니다. 위 오류를 확인하세요.');
  }
  const child=spawn(process.execPath,[path.join(source,'scripts/chrome-launch.mjs')],{detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();console.log('KLAS용 Chrome을 시작합니다. 창이 열리지 않으면 설치 폴더의 Chrome-start.log를 확인하세요.');
}catch(e){console.error(e.message);process.exitCode=1;}
