(() => {
  if(document.querySelector('[data-klasnote-status]'))return;
  const host=document.createElement('span');host.dataset.klasnoteStatus='';
  const root=host.attachShadow({mode:'closed'}),style=document.createElement('style');
  style.textContent=':host{display:inline-block;margin:4px 8px;font:12px system-ui}:host([data-floating]){position:fixed;right:16px;bottom:16px;margin:0;z-index:1000}button{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid #80525d;border-radius:6px;background:#fff;color:#633242;padding:5px 9px;cursor:pointer;max-width:250px}.dot{width:6px;height:6px;border-radius:50%;background:#999;flex:none}.dot[data-active]{background:#9b3450}button:focus-visible{outline:2px solid #9b3450;outline-offset:2px}';
  const button=document.createElement('button');button.type='button';button.title='요약 상태와 사용방법 열기';
  const dot=document.createElement('span');dot.className='dot';dot.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.textContent='클라스노트 · 대기';label.setAttribute('role','status');
  button.append(dot,label);root.append(style,button);
  const header=document.querySelector('header, #header');
  if(header)header.append(host);else{host.dataset.floating='';document.body.append(host);}
  const send=async type=>{const r=await chrome.runtime.sendMessage({target:'bg',type});if(!r?.ok)throw Error(r?.error||'확장 연결 오류');return r;};
  let disposed=false;
  async function refresh(){
    if(disposed||document.hidden)return;
    try{
      const {counts,consent}=await send('getStatus');if(disposed)return;
      const text=!consent?'처음 설정':counts.active?`처리 중 ${counts.active}`:counts.ready?`확인 필요 ${counts.ready}`:counts.error?`오류 ${counts.error}`:'대기';
      label.textContent=`클라스노트 · ${text}`;dot.toggleAttribute('data-active',counts.active>0);
    }catch{if(!disposed)label.textContent='클라스노트 · 연결 확인';}
  }
  button.addEventListener('click',async e=>{if(!e.isTrusted)return;button.disabled=true;try{await send('openPanel');}catch(err){label.textContent=err.message;}finally{button.disabled=false;}});
  const changed=(changes,area)=>{if(area==='local'&&(changes.statuses||changes.settings))refresh();};
  const visible=()=>{if(!document.hidden)refresh();};
  chrome.storage.onChanged.addListener(changed);document.addEventListener('visibilitychange',visible);
  window.addEventListener('pagehide',()=>{disposed=true;chrome.storage.onChanged.removeListener(changed);document.removeEventListener('visibilitychange',visible);},{once:true});
  refresh();
})();
