(() => {
  const valid=/^[0-9a-f]{8,32}$/i;
  let last='';
  let vueNode=null;
  function publish(){
    if(document.hidden)return;
    let data=null;
    if(vueNode?.isConnected&&Array.isArray(vueNode.__vue__?.$data?.list))data=vueNode.__vue__.$data;
    if(!data)for(const node of document.querySelectorAll('body *')){
      if(node.__vue__?.$data&&Array.isArray(node.__vue__.$data.list)){vueNode=node;data=node.__vue__.$data;break;}
    }
    if(!data)return;
    const subjectSelect=[...document.querySelectorAll('select')].find(s=>/과목|교과|subject|subj|sbjt/i.test(s.name+' '+s.id+' '+s.textContent));
    const selected=subjectSelect?.selectedOptions?.[0]?.textContent?.trim()??'';
    const items=data.list.slice(0,1000).flatMap(row=>{
      let u;try{u=new URL(String(row.starting));}catch{return [];}
      if(u.origin!=='https://kwcommons.kw.ac.kr')return [];
      const id=u.pathname.match(/^\/em\/([0-9a-f]{8,32})(?:\/|$)/i)?.[1];
      if(!id||!valid.test(id))return [];
      const title=String(row.sbjt??row.title??'').slice(0,200);
      const professor=String(row.professor??row.profNm??row.profName??data.professor??'').slice(0,50);
      return [{contentId:id.toLowerCase(),title,course:String(row.course??selected).slice(0,100),professor,week:Number(row.weekNo)||null,module:String(row.moduletitle??'').slice(0,200),period:[row.sdate,row.edate].filter(Boolean).join(' ~ ').slice(0,60)}];
    });
    const signature=JSON.stringify(items);if(signature===last)return;last=signature;
    window.postMessage({source:'klas-summarizer:list:v1',items},location.origin);
  }
  let scheduled=false;
  const schedule=()=>{if(scheduled)return;scheduled=true;setTimeout(()=>{scheduled=false;publish();},300);};
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('change',schedule);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  window.addEventListener('message',e=>{if(e.source===window&&e.origin===location.origin&&e.data?.source==='klas-summarizer:request-list:v1'){last='';publish();}});publish();
})();
