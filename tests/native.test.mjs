import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
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
