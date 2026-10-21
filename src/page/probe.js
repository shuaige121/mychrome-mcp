/* Cheap read of window metrics and scroll position. No DOM mutation.
 *
 * If a pointer screen position is supplied, also reports the nearest scrollable
 * ancestor under that pointer. Modern web apps (mail clients, feeds, consoles)
 * leave document.scrollY pinned at 0 and scroll an inner container instead, so
 * reporting only window.scrollY would claim "moved 0px" after a wheel event that
 * actually scrolled the page perfectly well. */
(function () {
  var SX = __SX__;   // pointer screen x, or null
  var SY = __SY__;   // pointer screen y, or null

  var toolbar = Math.max(0, window.outerHeight - window.innerHeight);
  var sideInset = Math.max(0, (window.outerWidth - window.innerWidth) / 2);

  function sig(e) {
    if (!e) return null;
    if (e === document.scrollingElement || e === document.documentElement) return 'document';
    return e.tagName.toLowerCase() +
      (e.id ? '#' + e.id : '') +
      (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  }

  function scrollableAt(vx, vy) {
    var el = null;
    try { el = document.elementFromPoint(vx, vy); } catch (e) { return null; }
    while (el && el !== document.body && el !== document.documentElement) {
      var st = window.getComputedStyle(el);
      var oy = st.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          el.scrollHeight > el.clientHeight + 2) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  var pointer = null;
  if (SX !== null && SY !== null) {
    var vx = SX - window.screenX - sideInset;
    var vy = SY - window.screenY - toolbar;
    var inner = null;
    if (vx >= 0 && vy >= 0 && vx <= window.innerWidth && vy <= window.innerHeight) {
      inner = scrollableAt(vx, vy);
    }
    pointer = {
      viewportX: Math.round(vx), viewportY: Math.round(vy),
      insideViewport: vx >= 0 && vy >= 0 && vx <= window.innerWidth && vy <= window.innerHeight,
      scroller: sig(inner),
      scrollerTop: inner ? Math.round(inner.scrollTop) : null,
      scrollerMax: inner ? Math.round(inner.scrollHeight - inner.clientHeight) : null,
      scrollerHeight: inner ? Math.round(inner.clientHeight) : null
    };
  }

  var docMax = document.documentElement.scrollHeight - window.innerHeight;

  return JSON.stringify({
    ok: true,
    url: location.href,
    title: document.title,
    view: {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      screenX: window.screenX, screenY: window.screenY,
      dpr: window.devicePixelRatio
    },
    scrollY: Math.round(window.scrollY),
    scrollX: Math.round(window.scrollX),
    scrollHeight: document.documentElement.scrollHeight,
    docScrollable: docMax > 2,
    atBottom: window.scrollY >= docMax - 2,
    pointer: pointer
  });
})()
