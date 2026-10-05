(() => {
  const u=new URL(location.href);
  const id=u.pathname.match(/^\/em\/([0-9a-f]{8,32})(?:\/|$)/i)?.[1]??u.searchParams.get('content_id')??u.searchParams.get('contentId');
  if(!id||!/^[0-9a-f]{8,32}$/i.test(id))return;
  // Read the real frame URL only. Never touch video controls, playback, progress or attendance.
  // 연결이 끊긴(확장 재로드 후) 스크립트에서는 sendMessage가 동기 예외를 던지므로 try로 감싼다.
  const post=message=>{if(!chrome.runtime?.id)return false;try{chrome.runtime.sendMessage(message).catch(()=>{});return true;}catch{return false;}};
  post({target:'bg',type:'lectureOpened',contentId:id.toLowerCase()});
  // 플레이어가 열려 있는 동안 15초마다 알린다. 백그라운드 받아쓰기가 GPU를 영상 재생과 나눠 쓰도록 1개로 줄이는 데만 쓴다.
  let timer=null;
  const alive=()=>{if(!post({target:'bg',type:'playerAlive'})&&timer!==null)clearInterval(timer);};
  alive();timer=setInterval(alive,15000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
