(() => {
  const u=new URL(location.href);
  const id=u.pathname.match(/^\/em\/([0-9a-f]{8,32})(?:\/|$)/i)?.[1]??u.searchParams.get('content_id')??u.searchParams.get('contentId');
  if(!id||!/^[0-9a-f]{8,32}$/i.test(id))return;
  // Read the real frame URL only. Never touch video controls, playback, progress or attendance.
  chrome.runtime.sendMessage({target:'bg',type:'lectureOpened',contentId:id.toLowerCase()}).catch(()=>{});
})();
