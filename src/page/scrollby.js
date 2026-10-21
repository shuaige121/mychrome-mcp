/* Fallback scrolling when the pointer is not over the Chrome window, so a
   real wheel event would land in some other app. */
(function () {
  var DY = __DY__;
  var before = window.scrollY;
  window.scrollBy({ top: DY, left: 0, behavior: 'instant' });
  return JSON.stringify({
    ok: true,
    method: 'window.scrollBy',
    requested: DY,
    from: Math.round(before),
    to: Math.round(window.scrollY),
    delta: Math.round(window.scrollY - before),
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
  });
})()
