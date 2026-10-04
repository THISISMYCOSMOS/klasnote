// Synthetic browser fixture; never opens or fetches an actual lecture/player.
import * as store from '../extension/src/core/store.js';
import {buildPack,groupBySlide} from '../extension/src/core/pack.js';
import {buildReport} from '../extension/src/core/report.js';
import {toJpeg} from '../extension/src/core/slides.js';
const log=document.querySelector('#log'),id='ffffffffffffffff';let n=0;
function check(value,label){if(!value)throw Error(label);log.textContent+=`\nPASS ${++n}: ${label}`;}
try{
  log.textContent='합성 데이터 검증 (실제 강의·AI 호출 없음)';
  await store.deleteLecture(id);
  const canvas=new OffscreenCanvas(1000,560),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1000,560);ctx.fillStyle='#222';ctx.font='36px sans-serif';ctx.fillText('비동기 작업과 자료 구조',180,180);
  const blob=await canvas.convertToBlob({type:'image/jpeg'});
  const lecture={contentId:id,title:'합성 테스트 <img src=x onerror=alert(1)>',course:'검증용 과목',duration:60,state:'done',asrModel:'small'};
  const slides=[{contentId:id,start:0,end:60,blob}],segments=[{contentId:id,start:1,end:5,text:'음 비동기 작업은 노트로 관리합니다.'},{contentId:id,start:6,end:10,text:'<script>alert(1)</script>는 원문 텍스트입니다.'}];
  await store.put('lectures',lecture);await store.putMany('slides',slides);await store.putMany('segments',segments);
  check((await store.get('lectures',id)).state==='done','IndexedDB 강의 저장/조회');
  const savedSlides=await store.byLecture('slides',id),savedSegments=await store.byLecture('segments',id);
  check(savedSlides.length===1&&savedSegments.length===2,'슬라이드 Blob/대본 저장');
  const pack=await buildPack({lecture,slides:savedSlides,segments:savedSegments,preset:'standard',provider:'claude',toJpeg});
  check(pack.slideCount===1&&pack.images.length===1&&pack.prompt.startsWith('강의: '),'이미지 crop/resize와 전송 묶음');
  check(pack.estimate.total>0&&pack.estimate.overhead===1900,'전송 추정값');
  const summary={overview:'비동기 처리를 설명합니다.',slides:[{s:1,summary:['작업 상태를 관리한다.'],comment:'예제로 확인한다.'}],exam:['상태 변화를 설명하기'],corrections:[['노트','노드']]};
  await store.put('summaries',{contentId:id,summary,provider:'claude'});
  check((await store.allSummaries()).some(x=>x.contentId===id),'개인 요약 캐시');
  const html=await buildReport({lecture,groups:groupBySlide(savedSlides,savedSegments),summary,meta:{aiLabel:'합성 fixture · AI 호출 없음'}});
  check(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')&&!html.includes('<script>alert(1)</script>'),'원문/제목 HTML 주입 방지');
  check(html.includes('<mark')&&html.includes('노드')&&html.includes("default-src 'none'"),'교정 표시와 CSP');
  const saved=await fetch('/dump?name=integration-report.html',{method:'POST',body:html});if(!saved.ok)throw Error('report fixture write');
  const frame=document.createElement('iframe');frame.title='개인 HTML 결과';frame.src='/tmp/spike-out/integration-report.html';document.querySelector('#result').append(frame);
  await store.deleteLecture(id);
  check(!(await store.get('lectures',id))&&(await store.byLecture('slides',id)).length===0&&!(await store.get('summaries',id)),'강의/대본/이미지/요약 함께 삭제');
  log.textContent+='\nDONE: 8 browser checks';
}catch(e){log.textContent+='\nFAIL: '+e.stack;await store.deleteLecture(id).catch(()=>{});}
