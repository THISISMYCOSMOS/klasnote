import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {buildReport} from '../extension/src/core/report.js';

const extensionId='klihhclhnhhmldcbnkpampimkjafmbdm';
test('lecture note displays whole-lecture points and evidence while keeping slides with raw speech only',async()=>{
  const html=await buildReport({lecture:{title:'예시 강의',duration:120},groups:[{start:0,end:120,segs:[{start:35,end:40,text:'이 비교는 중요합니다.'}]}],
    summary:{overview:'두 개념의 차이를 이해한다.\n강조 근거: S1 · 00:00–02:00',exam:['[중요 강조] 차이를 설명하기 (S1 · 00:00–02:00)'],slides:[{s:1,summary:['숨길 이전 슬라이드 요약'],comment:'숨길 이전 보충 설명'}],corrections:[]},meta:{}});
  assert.match(html,/강의 전체 핵심/);assert.match(html,/\[중요 강조\]/);assert.match(html,/교수님 원문/);assert.match(html,/00:35/);assert.match(html,/이 비교는 중요합니다/);
  assert.doesNotMatch(html,/숨길 이전|요약 없음|class="sum"/);
  assert.match(html,/body\[data-view=sum\] \.card\{display:none\}/);
  assert.match(html,/body\[data-view=raw\] \.lecture-summary\{display:none\}/);
});
test('standalone report links only a valid lecture to the restricted note entry',async()=>{
  const base={lecture:{contentId:'ABCDEF1234567890',title:'강의',duration:60},groups:[],summary:null,meta:{extensionId}};
  const html=await buildReport(base);
  assert.match(html,/href="chrome-extension:\/\/klihhclhnhhmldcbnkpampimkjafmbdm\/note-launch.html\?id=abcdef1234567890"/);
  assert.match(html,/요약노트 만들기<\/a>/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  for(const bad of [{...base,meta:{extensionId:'javascript:alert(1)'}},{...base,lecture:{...base.lecture,contentId:'x" onclick="alert(1)'}}]){
    assert.doesNotMatch(await buildReport(bad),/class="note-action"/);
  }
});

test('public note entry rejects frames and malformed IDs, and sends no processing requests',async()=>{
  const code=await readFile(new URL('../extension/note-launch.js',import.meta.url),'utf8');
  const run=(id,framed=false)=>{
    const destinations=[],status={};const win={};win.self=win;win.top=framed?{}:win;
    vm.runInNewContext(code,{window:win,URLSearchParams,location:{search:'?id='+encodeURIComponent(id),replace:u=>destinations.push(u)},document:{getElementById:()=>status},chrome:{runtime:{getURL:p=>`chrome-extension://${extensionId}/${p}`}}});
    return {destinations,status};
  };
  assert.deepEqual(run('ABCDEF1234567890').destinations,[`chrome-extension://${extensionId}/confirm.html?id=abcdef1234567890&note=1`]);
  assert.equal(run('abcdef1234567890',true).destinations.length,0);
  assert.equal(run('bad&force=1').destinations.length,0);
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.web_accessible_resources,[{resources:['note-launch.html'],matches:['file:///*'],use_dynamic_url:false}]);
});

test('note confirmation in local mode opens settings only on trusted click; frames do not initialize',async()=>{
  const code=(await readFile(new URL('../extension/confirm.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/m,'');
  const run=async(framed=false)=>{
    const calls=[],nodes=new Map(),win={};win.self=win;win.top=framed?{}:win;win.addEventListener=()=>{};
    const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,parentElement:{},classList:{add(){}},addEventListener(){}});return nodes.get(id);};
    vm.runInNewContext(code,{window:win,document:{getElementById:node},location:{search:'?id=abcdef1234567890&note=1',reload(){}},URLSearchParams,Intl,setTimeout,clearTimeout,mountCampusScene:()=>({setMotion(){},destroy(){}}),chrome:{runtime:{id:extensionId,sendMessage:async m=>{calls.push(m);return {ok:true,settings:{mode:'local',consent:true}};}}}});
    await new Promise(resolve=>setImmediate(resolve));return {calls,node};
  };
  const local=await run();assert.deepEqual(local.calls.map(x=>x.type),['getState']);
  assert.equal(local.node('confirmBtn').textContent,'요약 설정 열기');assert.equal(local.node('noteRetryBtn').hidden,false);
  local.node('confirmBtn').onclick({isTrusted:false});assert.equal(local.calls.length,1);
  local.node('confirmBtn').onclick({isTrusted:true});assert.equal(local.calls[1].type,'openConsent');
  assert.equal((await run(true)).calls.length,0);
});

test('report shows the summary time as a date, not a raw millisecond timestamp',async()=>{
  const at=new Date(2026,9,4,15,30).getTime();
  const html=await buildReport({lecture:{title:'강의',duration:60},groups:[],summary:null,meta:{aiLabel:'AI 요약 없음',createdAt:at}});
  assert.match(html,/AI 요약 없음 · 2026-10-04<\/dd>/);
  assert.doesNotMatch(html,new RegExp(String(at)));
});
