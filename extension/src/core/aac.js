// AAC 샘플을 재인코딩 없이 M4A로 묶는다. PCM·음성 인식 모델을 만들지 않는다.
const concat = (...parts) => { const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out; };
const u32 = (...ns) => { const out=new Uint8Array(ns.length*4),v=new DataView(out.buffer);ns.forEach((n,i)=>v.setUint32(i*4,n));return out; };
const u16 = (...ns) => { const out=new Uint8Array(ns.length*2),v=new DataView(out.buffer);ns.forEach((n,i)=>v.setUint16(i*2,n));return out; };
const zeros = n => new Uint8Array(n);
const ascii = s => new TextEncoder().encode(s);
const box = (type,...parts) => { const data=concat(...parts);return concat(u32(data.length+8),ascii(type),data); };
const full = (type,flags,...parts) => box(type,u32(flags),...parts);
const matrix = u32(0x10000,0,0,0,0x10000,0,0,0,0x40000000);
function descriptor(tag,data){let n=data.length,bytes=[n&127];while(n>>=7)bytes.unshift((n&127)|128);return concat(new Uint8Array([tag,...bytes]),data);}

export function remuxAudioM4a(mp4,samples){
  if(!samples.length)throw new Error('이 구간에 음성 샘플이 없습니다.');
  const {info,description}=mp4.audio;
  const rate=info.audio?.sample_rate,channels=info.audio?.channel_count,timescale=info.timescale;
  if(!String(info.codec).startsWith('mp4a')||!description?.length||!Number.isInteger(timescale)||timescale<1||!Number.isInteger(rate)||rate<1||rate>65535||!Number.isInteger(channels)||channels<1||channels>8)throw new Error('지원하지 않는 AAC 음성 형식입니다.');
  let total=0,ticks=0;
  const durations=[],runs=[];
  for(const [i,s] of samples.entries()){
    const dur=Math.round(s.dur*timescale);
    if(!Number.isFinite(s.ts)||s.ts<0||!Number.isInteger(dur)||dur<1||!s.data?.byteLength)throw new Error('AAC 샘플 정보 오류');
    if(i&&Math.abs(s.ts-(samples[i-1].ts+samples[i-1].dur))>2/timescale)throw new Error('AAC 샘플 시간에 빈 구간이 있습니다.');
    durations.push(dur);ticks+=dur;total+=s.data.byteLength;
    if(total>10*1024*1024)throw new Error('음성 구간이 10 MiB를 초과했습니다.');
    const last=runs.at(-1);if(last?.[1]===dur)last[0]++;else runs.push([1,dur]);
  }
  const duration=ticks/timescale;
  if(duration>121)throw new Error('음성 구간이 121초를 초과했습니다.');
  const movieDuration=Math.ceil(duration*1000);
  const ftyp=box('ftyp',ascii('M4A '),u32(0),ascii('M4A isommp42'));
  const asc=descriptor(5,new Uint8Array(description));
  const esds=full('esds',0,descriptor(3,concat(u16(1),zeros(1),descriptor(4,concat(new Uint8Array([0x40,0x15,0,0,0]),u32(0,0),asc)),descriptor(6,new Uint8Array([2])))));
  const entry=box('mp4a',zeros(6),u16(1),zeros(8),u16(channels,16,0,0),u32(rate*65536),esds);
  const makeMoov=offset=>box('moov',
    full('mvhd',0,u32(0,0,1000,movieDuration,0x10000),u16(0x100,0),zeros(8),matrix,zeros(24),u32(2)),
    box('trak',full('tkhd',7,u32(0,0,1,0,movieDuration),zeros(8),u16(0,0,0x100,0),matrix,u32(0,0)),
      box('mdia',full('mdhd',0,u32(0,0,timescale,ticks),u16(0x55c4,0)),full('hdlr',0,u32(0),ascii('soun'),zeros(12),ascii('Sound\0')),
        box('minf',full('smhd',0,u16(0,0)),box('dinf',full('dref',0,u32(1),full('url ',1))),
          box('stbl',full('stsd',0,u32(1),entry),full('stts',0,u32(runs.length),...runs.map(r=>u32(...r))),
            full('stsc',0,u32(1,1,samples.length,1)),full('stsz',0,u32(0,samples.length),...samples.map(s=>u32(s.data.byteLength))),full('stco',0,u32(1,offset)))))));
  const header=makeMoov(0),moov=makeMoov(ftyp.length+header.length+8);
  const bytes=concat(ftyp,moov,u32(total+8),ascii('mdat'),...samples.map(s=>s.data));
  if(bytes.length>10*1024*1024)throw new Error('음성 파일이 10 MiB를 초과했습니다.');
  return {bytes,offset:samples[0].ts,duration};
}

export function audioBase64(bytes){
  const parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return btoa(parts.join(''));
}
