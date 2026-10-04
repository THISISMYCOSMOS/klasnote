(() => {
  // Public entry only navigates to the private confirmation page; it sends no messages.
  const id = new URLSearchParams(location.search).get('id') ?? '';
  if (window.top !== window.self || !/^[0-9a-f]{8,32}$/i.test(id)) {
    document.getElementById('status').textContent = '올바른 강의 HTML에서 요약노트 만들기를 눌러 주세요.';
    return;
  }
  location.replace(chrome.runtime.getURL(`confirm.html?id=${id.toLowerCase()}&note=1`));
})();
