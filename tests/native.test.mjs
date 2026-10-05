import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {claudeArguments,codexArguments,SYSTEM,taskInput} from '../native-host/host.mjs';
import {SYSTEM as packSystem} from '../extension/src/core/pack.js';
import {parseSummary} from '../extension/src/core/policy.js';
import {buildReport} from '../extension/src/core/report.js';
const host=fileURLToPath(new URL('../native-host/host.mjs',import.meta.url));
function request(message){return new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[host],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let buf=Buffer.alloc(0),settled=false;
  const finish=(e,r)=>{if(settled)return;settled=true;clearTimeout(timer);p.stdin.end();e?reject(e):resolve(r);};
  const timer=setTimeout(()=>{p.kill();finish(Error('native host timeout'));},5000);
  p.on('error',e=>finish(e));p.on('exit',()=>{if(!settled)finish(Error('host ended without response'));});
  p.stdout.on('data',b=>{buf=Buffer.concat([buf,b]);if(buf.length>=4){const n=buf.readUInt32LE(0);if(buf.length>=n+4){try{finish(null,JSON.parse(buf.subarray(4,n+4)));}catch(e){finish(e);}}}});
  const b=Buffer.from(JSON.stringify(message)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);p.stdin.write(Buffer.concat([h,b]));
});}
test('actual native binary protocol detects installed CLIs without paid calls',async()=>{const r=await request({cmd:'detect'});assert.equal(r.ok,true);assert.equal(typeof r.claude,'boolean');assert.equal(typeof r.codex,'boolean');});
test('host rejects unknown commands and malformed lecture payload before provider invocation',async()=>{
  for(const m of [{cmd:'shell',command:'echo unsafe'},{cmd:'summarize',provider:'claude',model:'sonnet',prompt:'not a lecture',images:[]},{cmd:'summarize',provider:'claude',model:'invalid',prompt:'강의: fixture',images:[]}]){const r=await request(m);assert.equal(r.ok,false);assert.ok(r.error);}
});
test('summary CLI invocations retain personal instruction loading and reasoning preferences',()=>{
  const claude=claudeArguments('sonnet');
  assert.equal(claude[claude.indexOf('--setting-sources')+1],'user,project,local');
  for(const flag of ['--system-prompt','--append-system-prompt','--bare','--safe-mode','--dangerously-skip-permissions'])assert.ok(!claude.includes(flag));
  assert.equal(claude[claude.indexOf('--tools')+1],'');assert.ok(claude.includes('--strict-mcp-config'));
  assert.equal(JSON.parse(claude[claude.indexOf('--settings')+1]).disableAllHooks,true);
  const codex=codexArguments({model:'fixture-model',cwd:'/fixture',files:['--image=/fixture/s1.jpg']});
  assert.equal(codex[codex.indexOf('-C')+1],'/fixture');assert.equal(codex[codex.indexOf('-m')+1],'fixture-model');
  for(const flag of ['--ignore-user-config','--ignore-rules','--dangerously-bypass-approvals-and-sandbox'])assert.ok(!codex.includes(flag));
  assert.ok(!codex.some(x=>x.startsWith('model_reasoning_effort=')));
  assert.equal(codex[codex.indexOf('-s')+1],'read-only');assert.ok(codex.includes('features.shell_tool=false'));assert.ok(codex.includes('mcp_servers={}'));
  assert.equal(SYSTEM,packSystem);assert.match(SYSTEM,/개인 지침을 우선/);
  for(const criterion of ['강의 전체를 주제별로 통합','[시험 언급]','[중요 강조]','[복습 추천]','시험에 나오지 않는다고','시각이나 인용을 만들어내지','slides는 항상 빈 배열'])assert.ok(SYSTEM.includes(criterion));
  assert.doesNotMatch(SYSTEM,/3~5문장|60자 이내|1~3개|3~7개/);
  assert.match(taskInput(SYSTEM,'강의: fixture'),/<lecture_data>\n강의: fixture\n<\/lecture_data>$/);
});
test('personal summary detail survives parsing and HTML export without editorial truncation',async()=>{
  const prose='<내용> '+ '상세 설명 '.repeat(1000);
  const summary={overview:prose,slides:[],exam:Array.from({length:12},(_,i)=>`${i}: ${prose}`),corrections:[]};
  const parsed=parseSummary(JSON.stringify(summary));assert.deepEqual(parsed,summary);
  const html=await buildReport({lecture:{title:'검증',duration:60},groups:[{start:0,end:60,segs:[]}],summary:parsed,meta:{}});
  assert.match(html,/&lt;내용&gt;/);assert.ok(html.includes('5: &lt;내용&gt;'));assert.ok(html.includes('11: &lt;내용&gt;'));
  assert.throws(()=>parseSummary('x'.repeat(2_000_001)),/크기/);
});
