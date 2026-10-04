export const ID_RE = /^[0-9a-f]{8,32}$/i;
export const DEFAULT_SETTINGS = Object.freeze({consent:false, mode:'local', provider:'auto', claudeModel:'sonnet', codexModel:'gpt-5.6-terra', preset:'standard', confirmBeforeSend:true, asrModel:'base', motion:true});
export const CODEX_MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,40}$/;
export const validId = id => typeof id === 'string' && ID_RE.test(id);
export function cleanSettings(input, previous = DEFAULT_SETTINGS) {
  const result = {...previous};
  const choices = {mode:['local','ai'],provider:['auto','claude','codex'],claudeModel:['haiku','sonnet','opus'],preset:['save','standard','detail'],asrModel:['base','small']};
  for (const [key, values] of Object.entries(choices)) if (Object.hasOwn(input??{},key)) {
    if (!values.includes(input[key])) throw new Error(`설정 값 오류: ${key}`);
    result[key]=input[key];
  }
  // Codex 모델 목록은 학생 PC의 Codex마다 달라 고정 목록 대신 형식만 검사한다(실제 허용 여부는 host가 그 PC의 목록으로 다시 확인).
  if (Object.hasOwn(input??{},'codexModel')) {
    if (typeof input.codexModel !== 'string' || !CODEX_MODEL_RE.test(input.codexModel)) throw new Error('설정 값 오류: codexModel');
    result.codexModel=input.codexModel;
  }
  for (const key of ['confirmBeforeSend','motion']) if (Object.hasOwn(input??{},key)) {
    if (typeof input[key] !== 'boolean') throw new Error(`설정 값 오류: ${key}`);
    result[key]=input[key];
  }
  return result;
}
export function cleanMeta(meta={}) {
  const text=(key,max)=>String(meta[key]??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max);
  return {title:text('title',200),course:text('course',100),professor:text('professor',50),week:Number.isInteger(Number(meta.week))&&Number(meta.week)>0&&Number(meta.week)<100?Number(meta.week):null,module:text('module',200),period:text('period',60)};
}
export function safeName(value, fallback='강의') {
  let name=String(value??'').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,100).replace(/[. ]+$/g,'');
  if(!name||/^\.+$/.test(name))name=fallback;
  if(/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(name))name=`_${name}`;
  return name;
}
export function classifySender(sender,self,id) {
  if(sender?.id!==id)return null;
  let u;try{u=new URL(sender.url);}catch{return null;}
  const own=new URL(self);
  if(u.protocol===own.protocol&&u.host===own.host) {
    if(['/offscreen.html','/processor.html'].includes(u.pathname))return 'engine';
    if(['/options.html','/sidepanel.html','/consent.html','/confirm.html'].includes(u.pathname))return 'ui';
    return null;
  }
  if(!sender.tab||u.protocol!=='https:')return null;
  if(u.hostname==='klas.kw.ac.kr'&&u.pathname==='/std/lis/evltn/OnlineCntntsStdPage.do')return 'list';
  if(u.hostname==='klas.kw.ac.kr'&&(sender.frameId===undefined||sender.frameId===0))return 'status';
  if(u.hostname==='kwcommons.kw.ac.kr'&&(/^\/em\//.test(u.pathname)||/^\/viewer\/ssplayer\//.test(u.pathname)))return 'player';
  return null;
}
export function parseSummary(raw) {
  if(typeof raw!=='string'||raw.length>2_000_000)throw new Error('AI 응답 크기/형식 오류');
  let parsed;
  try{parsed=JSON.parse(raw.trim());}catch{
    // Locate a balanced object while respecting quoted braces/escapes, then validate its schema.
    for(let start=raw.indexOf('{');start>=0&&!parsed;start=raw.indexOf('{',start+1)){
      let depth=0,quoted=false,escaped=false;
      for(let i=start;i<raw.length;i++){
        const c=raw[i];
        if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
        if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{const v=JSON.parse(raw.slice(start,i+1));if(Array.isArray(v.slides))parsed=v;}catch{}break;}
      }
    }
  }
  if(!parsed||!Array.isArray(parsed.slides)||typeof parsed.overview!=='string'||!Array.isArray(parsed.exam))throw new Error('AI가 올바른 요약 JSON을 반환하지 않았습니다');
  if(parsed.slides.length>3000)throw new Error('AI 슬라이드 수 초과');
  const bounded=(v,n)=>{if(typeof v!=='string')throw new Error('AI 텍스트 형식 오류');return v.slice(0,n);};
  const seen=new Set();
  // 사용량을 이미 쓴 뒤라, 형식이 어긋난 슬라이드 줄 하나 때문에 응답 전체를 버리지 않는다.
  // 번호가 문자열이면 숫자로 읽고, 잘못된 줄·중복 번호는 건너뛴다(빈 칸은 background에서 채움).
  const slides=[];
  for(const row of parsed.slides){
    const s=Number(row?.s);
    if(!Number.isInteger(s)||s<1||seen.has(s))continue;
    const summary=Array.isArray(row.summary)?row.summary:typeof row.summary==='string'?[row.summary]:[];
    seen.add(s);
    slides.push({s,summary:summary.filter(v=>typeof v==='string').slice(0,3).map(v=>v.slice(0,500)),comment:typeof row.comment==='string'?row.comment.slice(0,1000):''});
  }
  return {overview:bounded(parsed.overview,4000),slides,exam:parsed.exam.filter(v=>typeof v==="string").slice(0,10).map(v=>v.slice(0,1000)),corrections:(Array.isArray(parsed.corrections)?parsed.corrections:[]).filter(x=>Array.isArray(x)&&x.length===2&&x.every(y=>typeof y==='string')&&x[0].length<=40&&x[1].length<=80).slice(0,40)};
}
export function checkPayload(payload) {
  const bytes=new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if(bytes>=64*1024*1024)throw new Error('전송 묶음이 64 MiB 이상입니다. 절약 프리셋을 선택하세요.');
  return bytes;
}
