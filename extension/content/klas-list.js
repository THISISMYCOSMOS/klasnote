(() => {
  const valid=/^[0-9a-f]{8,32}$/i,controls=new Map(),NOTE_MS=6000;
  // status-labels.js의 queueText·etaText와 같은 규칙(콘텐츠 스크립트는 모듈을 불러올 수 없다).
  const queueText=(id,s,q)=>{if(s?.state!=='queued'||!Array.isArray(q))return '';const a=q.indexOf(id);return a<0?'':a===0?'다음 차례':`앞에 ${a}개`;};
  const etaText=s=>{if(s?.state!=='running')return '';const p=Number(s.progress),p0=Number(s.runStartProgress)||0,t0=Number(s.runStartedAt),now=Date.now();if(!Number.isFinite(p)||!Number.isFinite(t0)||p-p0<0.03||now-t0<20000)return '';return `약 ${Math.max(1,Math.round((now-t0)/(p-p0)*(1-p)/60000))}분 남음`;};
  let items=[],current={statuses:{},opened:{}},lastSignature='';
  // 확장을 다시 불러오면 이 페이지에 남은 스크립트의 연결이 끊긴다(Extension context invalidated). 새로고침을 안내한다.
  const send=async(type,data={})=>{let r;try{r=await chrome.runtime.sendMessage({target:'bg',type,...data});}catch(e){throw new Error(/context invalidated/i.test(String(e?.message))?'확장이 새로 설치되거나 새로고침되었어요. 이 페이지를 새로고침(F5)한 뒤 다시 눌러 주세요.':String(e?.message||e));}if(!r?.ok)throw new Error(r?.error||'확장 연결 오류');return r;};
  async function refresh(){try{current=await send('getState');render();}catch{}}
  function render(){
    for(const [id,view] of controls){
      const status=current.statuses?.[id]??{},opened=!!current.opened?.[id];
      view.toggle.checked=!!status.auto;view.toggle.setAttribute('aria-label',`${view.title} 자동 처리`);
      const ready=['done','awaiting_confirmation'].includes(status.state);const saved=ready&&status.rawSaved===true;
      // 버튼 이름은 누르면 실제로 하는 일과 맞춘다: 완료된 강의도 확인 화면을 열고, 처리 중에는 누를 수 없다.
      const busy=['queued','running','summarizing'].includes(status.state),retry=['paused','error'].includes(status.state);
      view.button.textContent=busy?'처리 중':ready||status.state==='complete'?'확인하고 저장':retry?'다시 시도':'지금 요약';
      view.button.disabled=!opened||busy;view.button.title=!opened?'강의를 한 번 열어 본 뒤 요약할 수 있습니다.':busy?'처리가 끝나면 다시 누를 수 있어요.':status.state==='complete'?'확인 화면에서 저장된 결과를 다시 받습니다 (AI 재호출 없음).':ready?'처리가 끝났어요. 확인 화면에서 저장합니다.':'로컬 처리 후 확장 화면에서 전송량을 확인합니다.';
      // 요약 전이어도 받아쓰기가 끝났으면 원문 HTML을 받을 수 있다.
      view.folder.hidden=!Number.isInteger(status.downloadId);
      view.download.hidden=!(['done','awaiting_confirmation','complete'].includes(status.state)||status.transcribed===true);
      view.download.title=status.state==='complete'?'저장된 결과로 HTML을 다시 받습니다 (AI 재호출 없음).':'AI 요약 없이 받아쓰기 원문으로 HTML을 받습니다.';
      // 버튼을 누른 결과(저장 완료·오류)는 잠시 유지한다. 바로 뒤 상태 갱신이 덮어써 안 보이던 문제.
      const note=view.note&&Date.now()<view.note.until?view.note.text:null;
      const step=note??(status.error||status.step||(opened?'':'한 번 열어야 요약 가능'));
      if(view.status.textContent!==String(step).slice(0,200))view.status.textContent=String(step).slice(0,200);
      const pct=Math.round((Number(status.progress)||0)*100);
      const eta=etaText(status),place=queueText(id,status,current.queue);
      const BADGE={complete:['완료','ok'],saved:['HTML 저장됨','ok'],done:['확인 필요','warn'],awaiting_confirmation:['확인 필요','warn'],running:[`처리 중 ${pct}%${eta?` · ${eta}`:''}`,'busy'],queued:[place?`대기 · ${place}`:'대기 중','busy'],summarizing:['AI 요약 중','busy'],paused:['일시정지','idle'],error:['오류','err']}[saved?'saved':status.state];
      view.badge.hidden=!BADGE;if(BADGE){view.badge.textContent=BADGE[0];view.badge.dataset.kind=BADGE[1];}
      view.progress.hidden=!['queued','running','summarizing'].includes(status.state);
      view.progress.value=Number(status.progress)||0;
    }
  }
  function decorate(){
    for(const [id,view] of controls)if(!view.status.isConnected)controls.delete(id);
    // 바깥 레이아웃 표의 줄까지 잡히지 않게, 그 줄 자신의 칸(:scope > td)에 '보기'가 있는 줄만 쓴다.
    const ownCells=row=>[...row.children].filter(c=>c.tagName==='TD');
    // KLAS는 화면에 안 보이는 모바일용 표도 함께 그린다. 보이는 줄에만 버튼을 붙인다.
    const rows=[...document.querySelectorAll('tr')].filter(row=>row.getClientRects().length>0&&ownCells(row).some(td=>[...td.querySelectorAll('button')].some(b=>b.textContent.trim()==='보기')));
    // 같은 주차의 둘째 줄부터는 주차·단원 칸이 위 줄과 합쳐져(rowspan) 칸 순서가 달라진다.
    // 칸 위치 대신 '강의 제목과 똑같은 칸'을 찾아 연결하고, 같은 제목이 여러 번 나오면 등장 순서대로 짝짓는다.
    const byTitle=new Map();for(const item of items){if(!byTitle.has(item.title))byTitle.set(item.title,[]);byTitle.get(item.title).push(item);}
    const seen=new Map();
    rows.forEach(row=>{
      const title=ownCells(row).map(td=>td.textContent.trim()).find(t=>byTitle.has(t));if(!title)return;
      const n=seen.get(title)??0;seen.set(title,n+1);
      const match=byTitle.get(title)[n];if(!match)return;
      const old=row.querySelector('[data-klas-summarizer-control]');
      if(old?.dataset.contentId===match.contentId)return;
      if(old){controls.delete(old.dataset.contentId);old.remove();}
      const cell=document.createElement('div');cell.dataset.klasSummarizerControl='';cell.dataset.contentId=match.contentId;
      const root=cell.attachShadow({mode:'closed'});
      const style=document.createElement('style');style.textContent=':host{display:block;margin-top:6px;font:12px system-ui;color:#333}*{box-sizing:border-box}.ks-summary-tools{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.ks-summary-switch{display:flex;align-items:center;gap:4px;white-space:nowrap}.ks-summary-button{font:inherit;white-space:nowrap;word-break:keep-all;padding:3px 8px;border:1px solid #80525d;border-radius:4px;background:#fff;color:#633242;cursor:pointer}.ks-summary-button:disabled{opacity:.5;cursor:default}.ks-summary-button[hidden]{display:none}.ks-badge{display:inline-block;margin:0 0 4px;padding:1px 8px;border-radius:999px;font-weight:600;white-space:nowrap;border:1px solid transparent}.ks-badge[hidden]{display:none}.ks-badge[data-kind=ok]{background:#e6f4ea;color:#1e6b34;border-color:#a8d5b5}.ks-badge[data-kind=warn]{background:#fff4d6;color:#7a5200;border-color:#f0d58a}.ks-badge[data-kind=busy]{background:#e8f0fe;color:#1a4fa0;border-color:#b6ccf5}.ks-badge[data-kind=idle]{background:#f1f1f1;color:#555;border-color:#ddd}.ks-badge[data-kind=err]{background:#fdecea;color:#a12622;border-color:#f3b8b4}.ks-summary-download{background:#633242;color:#fff;border-color:#633242}.ks-summary-status{display:block;margin-top:3px;max-width:240px;word-break:keep-all;overflow-wrap:break-word}progress{display:block;width:100%;max-width:240px;height:5px}progress[hidden]{display:none}';root.append(style);
      const group=document.createElement('div');group.className='ks-summary-tools';
      const label=document.createElement('label');label.className='ks-summary-switch';
      const toggle=document.createElement('input');toggle.type='checkbox';const text=document.createElement('span');text.textContent='자동 처리';label.append(toggle,text);label.title='켜 두면 이 강의를 "보기"로 열 때 받아쓰기를 자동으로 시작해요. AI 요약은 자동으로 하지 않아요.';
      const button=document.createElement('button');button.type='button';button.className='ks-summary-button';button.textContent='지금 요약';
      const download=document.createElement('button');download.type='button';download.className='ks-summary-button ks-summary-download';download.textContent='HTML 받기';download.title='저장된 결과로 HTML을 다시 받습니다 (AI 재호출 없음).';download.hidden=true;
      const folder=document.createElement('button');folder.type='button';folder.className='ks-summary-button';folder.textContent='폴더 열기';folder.title='받은 HTML 파일이 있는 폴더를 엽니다.';folder.hidden=true;
      const status=document.createElement('span');status.className='ks-summary-status';status.setAttribute('role','status');
      const progress=document.createElement('progress');progress.max=1;progress.value=0;progress.setAttribute('aria-label','받아쓰기 진행률');
      const badge=document.createElement('span');badge.className='ks-badge';badge.hidden=true;badge.setAttribute('role','status');
      group.append(label,button,download,folder);root.append(badge,group,status,progress);[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='보기')?.parentElement.append(cell);
      controls.set(match.contentId,{toggle,button,download,folder,status,progress,badge,title:match.title});
      const say=text=>{const view=controls.get(match.contentId);if(!view)return;view.note={text:String(text).slice(0,200),until:Date.now()+NOTE_MS};view.status.textContent=view.note.text;setTimeout(render,NOTE_MS+50);};
      folder.addEventListener('click',async event=>{if(!event.isTrusted)return;try{await send('showDownload',{contentId:match.contentId});}catch(e){say(e.message);}});
      download.addEventListener('click',async event=>{if(!event.isTrusted)return;download.disabled=true;try{await send('download',{contentId:match.contentId});say('다운로드 폴더의 KLAS요약에 저장했어요.');}catch(e){say(e.message);}finally{download.disabled=false;}});
      toggle.addEventListener('change',async event=>{if(!event.isTrusted){toggle.checked=!!current.statuses?.[match.contentId]?.auto;return;}toggle.disabled=true;try{await send('setAuto',{contentId:match.contentId,enabled:toggle.checked});await refresh();}catch(e){toggle.checked=!toggle.checked;say(e.message);}finally{toggle.disabled=false;}});
      button.addEventListener('click',async event=>{if(!event.isTrusted)return;button.disabled=true;try{const st=current.statuses?.[match.contentId]?.state;const ready=['done','awaiting_confirmation','complete'].includes(st);await send(ready?'manualSummary':'startProcessing',{contentId:match.contentId});if(!ready)say('받아쓰기를 시작했어요.');}catch(e){say(e.message);}finally{render();await refresh();}});
    });render();
  }
  window.addEventListener('message',async e=>{
    if(e.source!==window||e.origin!==location.origin||e.data?.source!=='klas-summarizer:list:v1'||!Array.isArray(e.data.items)||e.data.items.length>1000)return;
    const parsed=e.data.items.filter(x=>x&&typeof x.contentId==='string'&&valid.test(x.contentId)).map(x=>({contentId:x.contentId.toLowerCase(),title:String(x.title??'').slice(0,200),course:String(x.course??'').slice(0,100),professor:String(x.professor??'').slice(0,50),week:Number(x.week)||null,prog:Math.max(0,Math.min(100,Number(x.prog)||0)),module:String(x.module??'').slice(0,200),period:String(x.period??'').slice(0,60)}));
    const signature=JSON.stringify(parsed);if(signature===lastSignature)return;lastSignature=signature;items=parsed;
    try{await send('registerLectures',{items});await refresh();decorate();}catch{}
  });
  let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;decorate();},300);}).observe(document.documentElement,{childList:true,subtree:true});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&(changes.statuses||changes.opened||changes.settings)&&!document.hidden)refresh();});
  // 확장을 다시 불러온 뒤에는 연결이 끊긴 이 스크립트가 아무것도 보내지 않는다(버튼은 새로고침 안내를 보여 준다).
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&chrome.runtime?.id){refresh();decorate();}});
  window.postMessage({source:'klas-summarizer:request-list:v1'},location.origin);
  refresh();
})();
