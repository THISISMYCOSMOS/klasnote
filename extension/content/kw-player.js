(() => {
  const u=new URL(location.href);
  const id=u.pathname.match(/^\/em\/([0-9a-f]{8,32})(?:\/|$)/i)?.[1]??u.searchParams.get('content_id')??u.searchParams.get('contentId');
  if(!id||!/^[0-9a-f]{8,32}$/i.test(id))return;
  // Read the real frame URL only. Never touch video controls, playback, progress or attendance.
  chrome.runtime.sendMessage({target:'bg',type:'lectureOpened',contentId:id.toLowerCase()}).catch(()=>{});
  // 플레이어가 열려 있는 동안 15초마다 알린다. 백그라운드 받아쓰기가 GPU를 영상 재생과 나눠 쓰도록 1개로 줄이는 데만 쓴다.
  const alive=()=>chrome.runtime.sendMessage({target:'bg',type:'playerAlive'}).catch(()=>{});
  alive();const timer=setInterval(alive,15000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
