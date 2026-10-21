/* Injected by click() and scroll(). Read-only: no DOM mutation, and no
   scrolling unless __SCROLL__ is true (the labelled programmatic fallback).

   MODE 'target' (click): resolve a marker number to a live element and report
     - rect: its full viewport rect; visible: the part visible through every
       clipping ancestor and the viewport (null when none is); land: the part
       of it around the aim where a press still hits the target;
     - chain: every clipping / scrolling ancestor, innermost first, ending
       with the document scroller, each with its visible box, scroll extents
       and a point where a wheel in each direction would reach it;
     - aim: where to press (the label's text box for wide elements), plus a
       hit-test of that point (elementFromPoint is the target or inside it);
     - hadFocus: whether the target already had keyboard focus.
   MODE 'scroll' (scroll tool): the scroller a wheel in __DIR__ would move
     (the document if it can, else the largest visible scroller), candidate
     pointer positions for it, and its scroll position. The chosen element is
     kept in the isolated world (window.__chromeBridgeScroll, invisible to the
     page) so MODE 'measure' can read its position after each burst. */
(function () {
  var N = __MARKER__;
  var MODE = __MODE__;
  var SCROLL = __SCROLL__;
  var DIR = __DIR__;

  /* Points closer than this to a box edge do not count as inside it. */
  var EDGE = 4;
  /* A wheel point must route to the same scroller this far around it. */
  var SPREAD = 12;

  function view() {
    return {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      screenX: window.screenX, screenY: window.screenY,
      dpr: window.devicePixelRatio
    };
  }
  function box(x, y, w, h) { return { x: x, y: y, width: w, height: h }; }
  function inter(a, b) {
    if (!a || !b) return null;
    var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    var r = Math.min(a.x + a.width, b.x + b.width), btm = Math.min(a.y + a.height, b.y + b.height);
    return (r - x > 0 && btm - y > 0) ? box(x, y, r - x, btm - y) : null;
  }
  function inside(p, r, m) {
    return !!r && p.x >= r.x + m && p.x <= r.x + r.width - m && p.y >= r.y + m && p.y <= r.y + r.height - m;
  }
  function sig(e) {
    if (!e || e === docEl()) return 'document';
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
      (e.className && typeof e.className === 'string' && e.className.trim()
        ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  }
  function docEl() { return document.scrollingElement || document.documentElement; }
  function viewportBox() { return box(0, 0, window.innerWidth, window.innerHeight); }
  function docMax() { return Math.max(0, docEl().scrollHeight - window.innerHeight); }

  /* The padding box an element clips its content to (viewport coords). */
  function clientBox(el) {
    var r = el.getBoundingClientRect();
    var w = el.clientWidth, h = el.clientHeight;
    if (!(w > 0) || !(h > 0)) return box(r.left, r.top, r.width, r.height);
    return box(r.left + (el.clientLeft || 0), r.top + (el.clientTop || 0), w, h);
  }
  function overflowOf(el) {
    var st = window.getComputedStyle(el);
    return { x: st.overflowX, y: st.overflowY };
  }
  function clipsContent(o) { return o.x !== 'visible' || o.y !== 'visible'; }
  function wheelable(v) { return v === 'auto' || v === 'scroll' || v === 'overlay'; }
  function isScrollerY(el) {
    if (el === docEl() || el === document.body || el === document.documentElement) return false;
    return wheelable(overflowOf(el).y) && el.scrollHeight > el.clientHeight + 1;
  }
  function canScroll(el, dir) {
    if (el === 'document') {
      return dir === 'down' ? window.scrollY < docMax() - 1 : window.scrollY > 0;
    }
    var max = el.scrollHeight - el.clientHeight;
    return dir === 'down' ? el.scrollTop < max - 1 : el.scrollTop > 0;
  }

  /* Which scroller a wheel at viewport point p in `dir` would move first:
     the innermost ancestor of the element under p that can still scroll that
     way, else the document (if it can), else null. */
  function routeWheel(p, dir) {
    var e = null;
    try { e = document.elementFromPoint(p.x, p.y); } catch (err) { return null; }
    if (!e) return null;
    for (var a = e; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (isScrollerY(a) && canScroll(a, dir)) return a;
    }
    return canScroll('document', dir) ? 'document' : null;
  }

  /* The visible part of an element's clip box: its own box cut by every
     clipping ancestor and the viewport. */
  function visibleBoxOf(el) {
    var v = clientBox(el);
    for (var a = el.parentElement; a && v && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (clipsContent(overflowOf(a))) v = inter(v, clientBox(a));
    }
    return inter(v, viewportBox());
  }

  /* Up to `max` points in `vis` where a wheel in `dir` reaches `target`
     ('document' or an element), each checked at SPREAD px around it too;
     ordered from the box centre outwards. */
  function wheelPoints(vis, target, dir, max) {
    if (!vis) return [];
    var pts = [], G = 7;
    for (var i = 0; i < G; i++) {
      for (var j = 0; j < G; j++) {
        pts.push({ x: vis.x + vis.width * (0.1 + 0.8 * i / (G - 1)),
                   y: vis.y + vis.height * (0.1 + 0.8 * j / (G - 1)) });
      }
    }
    var cx = vis.x + vis.width / 2, cy = vis.y + vis.height / 2;
    pts.sort(function (a, b) {
      return (Math.pow(a.x - cx, 2) + Math.pow(a.y - cy, 2)) - (Math.pow(b.x - cx, 2) + Math.pow(b.y - cy, 2));
    });
    var out = [], vp = viewportBox();
    for (var k = 0; k < pts.length && out.length < max; k++) {
      var p = pts[k], ok = true;
      var probe = [p, { x: p.x - SPREAD, y: p.y }, { x: p.x + SPREAD, y: p.y },
                      { x: p.x, y: p.y - SPREAD }, { x: p.x, y: p.y + SPREAD }];
      for (var q = 0; q < probe.length && ok; q++) {
        ok = inside(probe[q], vp, 1) && routeWheel(probe[q], dir) === target;
      }
      if (ok) out.push({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
    }
    return out;
  }

  function firstPoint(vis, target, dir) {
    var p = wheelPoints(vis, target, dir, 1);
    return p.length ? p[0] : null;
  }

  /* ------------------------------------------------------ scroll modes */

  if (MODE === 'measure') {
    var st = window.__chromeBridgeScroll;
    var el0 = st && st.el;
    if (!el0 || (el0 !== 'document' && !el0.isConnected)) {
      return JSON.stringify({ ok: false, error: 'stale', message: '滚动目标已经不在页面上' });
    }
    return JSON.stringify({
      ok: true, url: location.href,
      scrollTop: Math.round(el0 === 'document' ? window.scrollY : el0.scrollTop),
      max: Math.round(el0 === 'document' ? docMax() : el0.scrollHeight - el0.clientHeight)
    });
  }

  if (MODE === 'scroll') {
    var chosen = null;
    if (canScroll('document', DIR)) {
      chosen = 'document';
    } else {
      // Tally which scroller a wheel at each grid point would move; the one
      // under the most points is the page's main content area.
      var tally = [], G2 = 9, vp2 = viewportBox();
      for (var i2 = 0; i2 < G2; i2++) {
        for (var j2 = 0; j2 < G2; j2++) {
          var t = routeWheel({ x: vp2.width * (0.05 + 0.9 * i2 / (G2 - 1)),
                               y: vp2.height * (0.05 + 0.9 * j2 / (G2 - 1)) }, DIR);
          if (!t || t === 'document') continue;
          var hit = null;
          for (var z = 0; z < tally.length; z++) if (tally[z].el === t) hit = tally[z];
          if (hit) hit.n++; else tally.push({ el: t, n: 1 });
        }
      }
      tally.sort(function (a, b) { return b.n - a.n; });
      if (tally.length) chosen = tally[0].el;
    }
    if (!chosen) {
      window.__chromeBridgeScroll = null;
      return JSON.stringify({ ok: true, url: location.href, title: document.title, view: view(),
        scroller: null, docScrollY: Math.round(window.scrollY), docMax: Math.round(docMax()) });
    }
    window.__chromeBridgeScroll = { el: chosen };
    var vis2 = chosen === 'document' ? viewportBox() : visibleBoxOf(chosen);
    return JSON.stringify({
      ok: true, url: location.href, title: document.title, view: view(),
      scroller: sig(chosen === 'document' ? null : chosen),
      height: Math.round(chosen === 'document' ? window.innerHeight : chosen.clientHeight),
      scrollTop: Math.round(chosen === 'document' ? window.scrollY : chosen.scrollTop),
      max: Math.round(chosen === 'document' ? docMax() : chosen.scrollHeight - chosen.clientHeight),
      points: wheelPoints(vis2, chosen, DIR, 5)
    });
  }

  /* -------------------------------------------------------- target mode */

  var reg = window.__chromeBridge;
  if (!reg || !reg.markers) {
    return JSON.stringify({ ok: false, error: 'stale',
      message: '页面还没有被 read_page 读过（或已经跳转/刷新），标记号已失效，请先重新调用 read_page' });
  }
  if (reg.url !== location.href) {
    return JSON.stringify({ ok: false, error: 'stale',
      message: '页面已经跳转到 ' + location.href + '，标记号失效，请重新调用 read_page' });
  }
  var el = reg.markers[N];
  if (!el) {
    return JSON.stringify({ ok: false, error: 'no_such_marker',
      message: '没有编号为 [' + N + '] 的元素，可用范围 1..' + (reg.markers.length - 1) });
  }
  if (!el.isConnected) {
    return JSON.stringify({ ok: false, error: 'stale',
      message: '编号 [' + N + '] 的元素已经从页面上消失，请重新调用 read_page' });
  }

  if (SCROLL) {
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
    catch (e) { try { el.scrollIntoView(false); } catch (e2) {} }
  }

  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    return JSON.stringify({ ok: false, error: 'not_visible',
      message: '编号 [' + N + '] 的元素当前不可见（尺寸为 0）' });
  }
  var rect = box(r.left, r.top, r.width, r.height);

  // The nearest position:fixed box at or above the target. Scrollers outside
  // it neither clip nor move the target: they are left out of the chain, and
  // the document is marked movesAim:false (no wheel brings the target closer).
  var fixedEl = null;
  for (var f = el; f && f !== document.body && f !== document.documentElement; f = f.parentElement) {
    try { if (window.getComputedStyle(f).position === 'fixed') { fixedEl = f; break; } } catch (e) {}
  }

  // Clipping ancestors, innermost first, then the document.
  var chain = [];
  var visible = rect;
  for (var a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    if (fixedEl && !fixedEl.contains(a)) break;
    var o = overflowOf(a);
    if (!clipsContent(o)) continue;
    var cb = clientBox(a);
    visible = inter(visible, cb);
    var scY = wheelable(o.y) && a.scrollHeight > a.clientHeight + 1;
    var vis = visibleBoxOf(a);
    chain.push({
      sig: sig(a), clip: cb, visible: vis,
      scrollableY: scY,
      scrollTop: Math.round(a.scrollTop), maxTop: Math.max(0, Math.round(a.scrollHeight - a.clientHeight)),
      scrollableX: wheelable(o.x) && a.scrollWidth > a.clientWidth + 1,
      wheel: scY ? { down: canScroll(a, 'down') ? firstPoint(vis, a, 'down') : null,
                     up: canScroll(a, 'up') ? firstPoint(vis, a, 'up') : null } : null
    });
  }
  var vp = viewportBox();
  visible = inter(visible, vp);
  chain.push({
    sig: 'document', clip: vp, visible: vp, document: true, movesAim: !fixedEl,
    scrollableY: docMax() > 1,
    scrollTop: Math.round(window.scrollY), maxTop: Math.round(docMax()),
    scrollableX: false,
    wheel: { down: canScroll('document', 'down') ? firstPoint(vp, 'document', 'down') : null,
             up: canScroll('document', 'up') ? firstPoint(vp, 'document', 'up') : null }
  });

  // Aim: for wide elements the label's text box (people aim at the words),
  // otherwise the centre.
  var aim = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, aimAt = 'center';
  if (rect.width > 3 * rect.height) {
    try {
      var tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var tn;
      while ((tn = tw.nextNode())) {
        if (!/\S/.test(tn.nodeValue)) continue;
        var rg = document.createRange();
        rg.selectNodeContents(tn);
        var rs = rg.getClientRects();
        if (rs && rs.length && rs[0].width > 0 && rs[0].height > 0) {
          var lb = inter(box(rs[0].left, rs[0].top, rs[0].width, rs[0].height), rect);
          if (lb) { aim = { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 }; aimAt = 'label'; }
        }
        break;
      }
    } catch (e) {}
  }

  function hitAt(p) {
    if (!inside(p, vp, 0)) return { ok: false, by: '' };
    var h = null;
    try { h = document.elementFromPoint(p.x, p.y); } catch (e) {}
    if (!h) return { ok: false, by: '' };
    if (h === el || el.contains(h)) return { ok: true, by: '' };
    return { ok: false, by: h.tagName.toLowerCase() +
      (h.className && typeof h.className === 'string' && h.className.trim() ? '.' + h.className.trim().split(/\s+/)[0] : '') };
  }

  // Hit-test the aim. If it is inside the visible part but covered (a sticky
  // bar, a badge), take the visible point nearest it that does reach the
  // target. An aim outside the visible part is left for scrolling to fix.
  var hit0 = hitAt(aim), hitOk = hit0.ok, hitBy = hit0.by, aimMoved = false;
  if (!hitOk && visible && inside(aim, visible, 0)) {
    var best = null, bestD = Infinity, G3 = 5;
    for (var ia = 0; ia < G3; ia++) {
      for (var ja = 0; ja < G3; ja++) {
        var cand = { x: visible.x + visible.width * (0.1 + 0.8 * ia / (G3 - 1)),
                     y: visible.y + visible.height * (0.1 + 0.8 * ja / (G3 - 1)) };
        if (!hitAt(cand).ok) continue;
        var d = Math.pow(cand.x - aim.x, 2) + Math.pow(cand.y - aim.y, 2);
        if (d < bestD) { bestD = d; best = cand; }
      }
    }
    if (best) { aim = best; hitOk = true; aimMoved = true; }
  }

  // Where the press may land (review A1). The helper draws the landing over
  // the inner 80% of the rect it is given, and presses where the pointer
  // already is when that is anywhere inside it, so every part of that rect
  // must hit the target, not only the aim. Start from the target's own box
  // fragment that holds the aim (a link wrapped over two lines is two boxes,
  // and the gap between them is someone else's), else a small box around the
  // aim; shrink it toward the aim until a 5x5 grid over its inner 80% hits.
  function allHit(r) {
    for (var gi = 0; gi < 5; gi++) {
      for (var gj = 0; gj < 5; gj++) {
        if (!hitAt({ x: r.x + r.width * (0.1 + 0.2 * gi), y: r.y + r.height * (0.1 + 0.2 * gj) }).ok) return false;
      }
    }
    return true;
  }
  var land = null;
  if (hitOk && visible && inside(aim, visible, 0)) {
    try {
      var frs = el.getClientRects();
      for (var fi = 0; fi < frs.length && !land; fi++) {
        var fb = inter(box(frs[fi].left, frs[fi].top, frs[fi].width, frs[fi].height), visible);
        if (fb && inside(aim, fb, 0)) land = fb;
      }
    } catch (e) {}
    if (!land) {
      var hw = Math.min(8, visible.width / 2), hh = Math.min(8, visible.height / 2);
      land = inter(box(aim.x - hw, aim.y - hh, 2 * hw, 2 * hh), visible);
    }
    for (var sk = 0; land && sk < 12 && !allHit(land) && (land.width > 4 || land.height > 4); sk++) {
      land = box(aim.x - (aim.x - land.x) / 2, aim.y - (aim.y - land.y) / 2, land.width / 2, land.height / 2);
    }
  }

  var ae = null;
  try { ae = document.activeElement; } catch (e) {}
  var hadFocus = false;
  try { hadFocus = !!ae && ae !== document.body && (ae === el || el.contains(ae) || (!!el.control && el.control === ae)); } catch (e) {}

  var label = (el.innerText || el.textContent || el.value ||
               el.getAttribute('aria-label') || el.getAttribute('title') || '');
  label = String(label).replace(/\s+/g, ' ').trim().slice(0, 80);

  // A form field, for the takeover panel: named by its label, never by its value.
  var field = null;
  if (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable) {
    var fname = '';
    try {
      fname = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
        (el.labels && el.labels[0] ? (el.labels[0].innerText || '') : '') || el.getAttribute('name') || '';
    } catch (e) {}
    field = {
      type: String(el.isContentEditable ? 'contenteditable' : (el.type || el.tagName)).toLowerCase(),
      autocomplete: String(el.getAttribute('autocomplete') || '').toLowerCase(),
      name: String(fname).replace(/\s+/g, ' ').trim().slice(0, 40)
    };
  }

  return JSON.stringify({
    field: field,
    ok: true,
    marker: N,
    tag: el.tagName.toLowerCase(),
    text: label,
    rect: rect,
    visible: visible,
    land: land,
    fixed: !!fixedEl,
    chain: chain,
    aim: { x: Math.round(aim.x * 10) / 10, y: Math.round(aim.y * 10) / 10 },
    aimAt: aimMoved ? 'uncovered' : aimAt,
    hitOk: hitOk,
    hitBy: hitBy,
    hadFocus: hadFocus,
    programmaticScroll: !!SCROLL,
    view: view(),
    url: location.href
  });
})()
