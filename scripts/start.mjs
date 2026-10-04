import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkSource} from './setup.mjs';
import {platformPaths,isLauncherAlive} from './platform.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  checkSource(source);
  const target=platformPaths().installRoot;
  const sourceManifest=JSON.parse(fs.readFileSync(path.join(source,'extension/manifest.json'),'utf8'));
  const stamp=path.join(target,'.installed-version');
  const current=fs.existsSync(stamp)?fs.readFileSync(stamp,'utf8').trim():null;
  if(current!==sourceManifest.version||!fs.existsSync(path.join(target,'host.mjs'))){
    // 실행 중인 KLAS용 Chrome이 예전 파일을 쓰고 있으면 섞이지 않게 먼저 닫도록 안내한다(독립 검토 F8).
    if(isLauncherAlive(path.join(target,'Chrome-launch.pid')))throw Error('새 버전을 설치하려면 KLAS용 Chrome 창을 모두 닫은 뒤 다시 실행하세요.');
    const result=spawnSync(process.execPath,[path.join(source,'scripts/setup.mjs'),'--install-only'],{stdio:'inherit',windowsHide:true});
    if(result.error||result.status!==0)throw Error('설치하지 못했습니다. 위 오류를 확인하세요.');
  }
  const child=spawn(process.execPath,[path.join(source,'scripts/chrome-launch.mjs')],{detached:true,stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();console.log('KLAS용 Chrome을 시작합니다. 창이 열리지 않으면 설치 폴더의 Chrome-start.log를 확인하세요.');
}catch(e){console.error(e.message);process.exitCode=1;}
