(() => {
  const valid=/^[0-9a-f]{8,32}$/i,controls=new Map();
  let items=[],current={statuses:{},opened:{}},lastSignature='';
  const send=async(type,data={})=>{const r=await chrome.runtime.sendMessage({target:'bg',type,...data});if(!r?.ok)throw new Error(r?.error||'확장 연결 오류');return r;};
  async function refresh(){try{current=await send('getState');render();}catch{}}
  function render(){
    for(const [id,view] of controls){
      const status=current.statuses?.[id]??{},opened=!!current.opened?.[id];
      view.toggle.checked=!!status.auto;view.toggle.setAttribute('aria-label',`${view.title} 자동 처리`);
      const ready=['done','awaiting_confirmation'].includes(status.state);
      view.button.textContent=ready?'확인하고 저장':'지금 요약';
      view.button.disabled=!opened;view.button.title=!opened?'강의를 한 번 열어 본 뒤 요약할 수 있습니다.':ready?'처리가 끝났어요. 확인 화면에서 저장합니다.':'로컬 처리 후 확장 화면에서 전송량을 확인합니다.';
      view.download.hidden=status.state!=='complete';
      const step=status.error||status.step||(opened?'개인 복습용':'한 번 열어야 요약 가능');
      if(view.status.textContent!==String(step).slice(0,200))view.status.textContent=String(step).slice(0,200);
      view.progress.hidden=!['queued','running','summarizing'].includes(status.state);
      view.progress.value=Number(status.progress)||0;
    }
  }
  function decorate(){
    for(const [id,view] of controls)if(!view.status.isConnected)controls.delete(id);
    const rows=[...document.querySelectorAll('tr')].filter(row=>[...row.querySelectorAll('button')].some(b=>b.textContent.trim()==='보기'));
    rows.forEach((row,i)=>{
      const title=row.querySelectorAll('td')[3]?.textContent?.trim()??'';
      const match=items[i]?.title===title?items[i]:items.find(item=>item.title===title);if(!match)return;
      const old=row.querySelector('[data-klas-summarizer-control]');
      if(old?.dataset.contentId===match.contentId)return;
      if(old){controls.delete(old.dataset.contentId);old.remove();}
      const cell=document.createElement('div');cell.dataset.klasSummarizerControl='';cell.dataset.contentId=match.contentId;
      const root=cell.attachShadow({mode:'closed'});
      const style=document.createElement('style');style.textContent=':host{display:block;margin-top:6px;font:12px system-ui;color:#333}*{box-sizing:border-box}.ks-summary-tools{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.ks-summary-switch{display:flex;align-items:center;gap:4px;white-space:nowrap}.ks-summary-button{font:inherit;white-space:nowrap;word-break:keep-all;padding:3px 8px;border:1px solid #80525d;border-radius:4px;background:#fff;color:#633242;cursor:pointer}.ks-summary-button:disabled{opacity:.5;cursor:default}.ks-summary-button[hidden]{display:none}.ks-summary-download{background:#633242;color:#fff;border-color:#633242}.ks-summary-status{display:block;margin-top:3px;max-width:240px;word-break:keep-all;overflow-wrap:break-word}progress{display:block;width:100%;max-width:240px;height:5px}progress[hidden]{display:none}';root.append(style);
      const group=document.createElement('div');group.className='ks-summary-tools';
      const label=document.createElement('label');label.className='ks-summary-switch';
      const toggle=document.createElement('input');toggle.type='checkbox';const text=document.createElement('span');text.textContent='자동 처리';label.append(toggle,text);
      const button=document.createElement('button');button.type='button';button.className='ks-summary-button';button.textContent='지금 요약';
      const download=document.createElement('button');download.type='button';download.className='ks-summary-button ks-summary-download';download.textContent='HTML 받기';download.title='저장된 결과로 HTML을 다시 받습니다 (AI 재호출 없음).';download.hidden=true;
      const status=document.createElement('span');status.className='ks-summary-status';status.setAttribute('role','status');
      const progress=document.createElement('progress');progress.max=1;progress.value=0;progress.setAttribute('aria-label','로컬 받아쓰기 진행률');
      group.append(label,button,download);root.append(group,status,progress);[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='보기')?.parentElement.append(cell);
      controls.set(match.contentId,{toggle,button,download,status,progress,title:match.title});
      download.addEventListener('click',async event=>{if(!event.isTrusted)return;download.disabled=true;try{await send('download',{contentId:match.contentId});status.textContent='다운로드 폴더의 KLAS요약에 저장했어요.';}catch(e){status.textContent=e.message;}finally{download.disabled=false;}});
      toggle.addEventListener('change',async event=>{if(!event.isTrusted){toggle.checked=!!current.statuses?.[match.contentId]?.auto;return;}toggle.disabled=true;try{await send('setAuto',{contentId:match.contentId,enabled:toggle.checked});await refresh();}catch(e){toggle.checked=!toggle.checked;status.textContent=e.message;}finally{toggle.disabled=false;}});
      button.addEventListener('click',async event=>{if(!event.isTrusted)return;button.disabled=true;try{await send('manualSummary',{contentId:match.contentId});}catch(e){status.textContent=e.message;}finally{button.disabled=!current.opened?.[match.contentId];}});
    });render();
  }
  window.addEventListener('message',async e=>{
    if(e.source!==window||e.origin!==location.origin||e.data?.source!=='klas-summarizer:list:v1'||!Array.isArray(e.data.items)||e.data.items.length>1000)return;
    const parsed=e.data.items.filter(x=>x&&typeof x.contentId==='string'&&valid.test(x.contentId)).map(x=>({contentId:x.contentId.toLowerCase(),title:String(x.title??'').slice(0,200),course:String(x.course??'').slice(0,100),professor:String(x.professor??'').slice(0,50),week:Number(x.week)||null,module:String(x.module??'').slice(0,200),period:String(x.period??'').slice(0,60)}));
    const signature=JSON.stringify(parsed);if(signature===lastSignature)return;lastSignature=signature;items=parsed;
    try{await send('registerLectures',{items});await refresh();decorate();}catch{}
  });
  let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;decorate();},300);}).observe(document.documentElement,{childList:true,subtree:true});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.statuses||changes.opened||changes.settings)&&!document.hidden)refresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();decorate();}});
  window.postMessage({source:'klas-summarizer:request-list:v1'},location.origin);
  refresh();
})();
