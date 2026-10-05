import test from 'node:test';
import assert from 'node:assert/strict';
import MP4Box from 'mp4box';
import {remuxAudioM4a,audioBase64} from '../extension/src/core/aac.js';
const fixture=()=>({audio:{info:{codec:'mp4a.40.2',timescale:48000,audio:{sample_rate:48000,channel_count:2}},description:new Uint8Array([0x11,0x90])}});
const samples=(n=300,offset=120)=>Array.from({length:n},(_,i)=>({ts:offset+i*1024/48000,dur:1024/48000,data:new Uint8Array([1,i%256,3,4])}));
function parse(bytes){const file=MP4Box.createFile();let info,error;file.onReady=v=>{info=v;};file.onError=e=>{error=e;};const ab=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);ab.fileStart=0;file.appendBuffer(ab);file.flush();assert.equal(error,undefined);assert.ok(info);return {file,info};}
test('remux preserves AAC bytes, decoder config, duration, offset and sample table',()=>{
 const input=samples(),r=remuxAudioM4a(fixture(),input),{file,info}=parse(r.bytes),track=info.tracks[0];
 assert.equal(info.tracks.length,1);assert.equal(track.codec,'mp4a.40.2');assert.equal(track.audio.sample_rate,48000);assert.equal(track.audio.channel_count,2);
 assert.equal(track.nb_samples,300);assert.equal(track.duration/track.timescale,6.4);assert.equal(r.offset,120);assert.equal(r.duration,6.4);
 const t=file.getTrackById(track.id);assert.deepEqual([...t.mdia.minf.stbl.stsd.entries[0].esds.esd.descs[0].descs[0].data],[0x11,0x90]);
 for(const [i,s] of t.samples.entries())assert.deepEqual(r.bytes.subarray(s.offset,s.offset+s.size),input[i].data);
 assert.deepEqual(new Uint8Array(Buffer.from(audioBase64(r.bytes),'base64')),r.bytes);
});
test('variable AAC durations produce correct timing and offset tables',()=>{
 const input=[{ts:30,dur:1024/48000,data:new Uint8Array([1])},{ts:30+1024/48000,dur:960/48000,data:new Uint8Array([2,3])}];
 const r=remuxAudioM4a(fixture(),input),{file}=parse(r.bytes);assert.deepEqual(file.getTrackById(1).samples.map(s=>s.duration),[1024,960]);
 assert.equal(r.duration,1984/48000);
});
test('malformed, discontinuous, oversized and non-AAC inputs fail before upload',()=>{
 assert.throws(()=>remuxAudioM4a(fixture(),[]),/샘플/);
 const f=fixture();f.audio.info.codec='opus';assert.throws(()=>remuxAudioM4a(f,samples(1)),/AAC/);
 assert.throws(()=>remuxAudioM4a(fixture(),[{ts:0,dur:1,data:new Uint8Array(1)},{ts:2,dur:1,data:new Uint8Array(1)}]),/빈 구간/);
 assert.throws(()=>remuxAudioM4a(fixture(),[{ts:0,dur:122,data:new Uint8Array(1)}]),/121초/);
 assert.throws(()=>remuxAudioM4a(fixture(),[{ts:0,dur:1,data:new Uint8Array(10*1024*1024+1)}]),/10 MiB/);
});
