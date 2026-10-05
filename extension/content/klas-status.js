(() => {
  if(document.querySelector('[data-klasnote-status]'))return;
  const host=document.createElement('span');host.dataset.klasnoteStatus='';
  const root=host.attachShadow({mode:'closed'}),style=document.createElement('style');
  style.textContent=':host{display:inline-block;margin:4px 8px;font:12px system-ui}:host([data-floating]){position:fixed;right:16px;bottom:16px;margin:0;z-index:1000}:host([data-moved]){position:fixed;right:auto;bottom:auto;margin:0;z-index:1000}button{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid #80525d;border-radius:6px;background:#fff;color:#633242;padding:5px 9px;cursor:grab;max-width:250px;touch-action:none;user-select:none}:host([data-dragging]) button{cursor:grabbing;box-shadow:0 4px 14px rgba(0,0,0,.18)}.dot{width:6px;height:6px;border-radius:50%;background:#999;flex:none}.dot[data-active]{background:#9b3450}.grip{color:#b08a94;letter-spacing:-2px;margin-right:2px}button:focus-visible{outline:2px solid #9b3450;outline-offset:2px}';
  const button=document.createElement('button');button.type='button';button.title='클릭: 요약 상태와 사용방법 열기 · 끌기: 위치 옮기기';
  const grip=document.createElement('span');grip.className='grip';grip.textContent='⋮⋮';grip.setAttribute('aria-hidden','true');
  const dot=document.createElement('span');dot.className='dot';dot.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.textContent='클라스노트 · 대기';label.setAttribute('role','status');
  button.append(grip,dot,label);root.append(style,button);
  const header=document.querySelector('header, #header');
  if(header)header.append(host);else{host.dataset.floating='';document.body.append(host);}
  const send=async type=>{let r;try{r=await chrome.runtime.sendMessage({target:'bg',type});}catch(e){throw Error(/context invalidated/i.test(String(e?.message))?'확장이 새로 설치되거나 새로고침되었어요. 이 페이지를 새로고침(F5)한 뒤 다시 눌러 주세요.':String(e?.message||e));}if(!r?.ok)throw Error(r?.error||'확장 연결 오류');return r;};
  let disposed=false;
  async function refresh(){
    if(disposed||document.hidden)return;
    try{
      const {counts,consent}=await send('getStatus');if(disposed)return;
      const text=!consent?'처음 설정':counts.active?`처리 중 ${counts.active}`:counts.ready?`확인 필요 ${counts.ready}`:counts.error?`오류 ${counts.error} · 눌러서 확인`:'대기';
      label.textContent=`클라스노트 · ${text}`;dot.toggleAttribute('data-active',counts.active>0);
    }catch{if(!disposed)label.textContent='클라스노트 · 연결 확인';}
  }

  // 끌어서 옮기기. 위치는 이 PC 브라우저에만 저장한다(statusPos). 화면 밖으로 나가지 않게 맞춘다.
  const POS_KEY='statusPos',DRAG_PX=4;
  function place(x,y){
    const w=host.offsetWidth||160,h=host.offsetHeight||30;
    const left=Math.min(Math.max(0,x),Math.max(0,innerWidth-w)),top=Math.min(Math.max(0,y),Math.max(0,innerHeight-h));
    host.dataset.moved='';host.style.left=left+'px';host.style.top=top+'px';
    return {x:left,y:top};
  }
  chrome.storage.local.get(POS_KEY).then(r=>{const p=r?.[POS_KEY];if(!disposed&&Number.isFinite(p?.x)&&Number.isFinite(p?.y))place(p.x,p.y);}).catch(()=>{});
  let drag=null,suppressClick=false;
  button.addEventListener('pointerdown',e=>{
    if(!e.isTrusted||e.button!==0)return;
    const r=host.getBoundingClientRect();
    drag={id:e.pointerId,sx:e.clientX,sy:e.clientY,ox:r.left,oy:r.top,moving:false};
  });
  button.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.id)return;
    const dx=e.clientX-drag.sx,dy=e.clientY-drag.sy;
    if(!drag.moving){if(Math.hypot(dx,dy)<DRAG_PX)return;drag.moving=true;host.dataset.dragging='';button.setPointerCapture(e.pointerId);}
    place(drag.ox+dx,drag.oy+dy);
  });
  const endDrag=e=>{
    if(!drag||e.pointerId!==drag.id)return;
    if(drag.moving){
      // 놓은 직후 오는 click 한 번만 막는다. 버튼 밖에서 놓아 click이 오지 않아도 다음 클릭은 살린다.
      suppressClick=true;setTimeout(()=>{suppressClick=false;},0);delete host.dataset.dragging;
      const r=host.getBoundingClientRect();
      chrome.storage.local.set({[POS_KEY]:{x:Math.round(r.left),y:Math.round(r.top)}}).catch(()=>{});
    }
    drag=null;
  };
  button.addEventListener('pointerup',endDrag);button.addEventListener('pointercancel',endDrag);
  const onResize=()=>{if(host.hasAttribute('data-moved')){const r=host.getBoundingClientRect();place(r.left,r.top);}};
  window.addEventListener('resize',onResize);

  button.addEventListener('click',async e=>{if(!e.isTrusted)return;if(suppressClick){suppressClick=false;return;}button.disabled=true;try{await send('openPanel');}catch(err){label.textContent=err.message;}finally{button.disabled=false;}});
  const changed=(changes,area)=>{if(area==='local'&&(changes.statuses||changes.settings))refresh();};
  const visible=()=>{if(!document.hidden)refresh();};
  chrome.storage.onChanged.addListener(changed);document.addEventListener('visibilitychange',visible);
  window.addEventListener('pagehide',()=>{disposed=true;chrome.storage.onChanged.removeListener(changed);document.removeEventListener('visibilitychange',visible);window.removeEventListener('resize',onResize);},{once:true});
  refresh();
})();
