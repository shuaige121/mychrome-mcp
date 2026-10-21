/* Injected by wait_for_user with `field`: point the user at a field only they should fill, and
   tell the agent when they are done with it. Lives in the AppleScript isolated world
   (window.__chromeBridgeAsk): page scripts cannot see its state.

   __ASK__  {arm: token, marker, text: {title, hint, hintMulti, brand}}: resolve the read_page
              marker, scroll it into view, focus it, draw a ring around it with a note (a closed
              shadow root, styles set through the CSSOM so a page's CSP does not drop them,
              pointer-events none), and listen in its document for
                - a trusted Return in it or in another field of its form (Cmd/Ctrl+Return in a
                  multi-line field; never the Return that confirms an IME composition),
                - a submit of its form right after a trusted click on one of its submit buttons (a
                  page's requestSubmit() is trusted too, so the click is what proves the user).
              The page still handles that Return / submit itself: nothing is prevented.
              The field is also put on window.__chromeBridgePrivate (this world only): read.js and
              after.js never print its value, also after the wait and for a re-rendered copy (a field
              with no id or name: no text field of its form prints its value).
            {read: token}: whether that token is still armed in this document (armed:false after
              a navigation or reload replaced it), entered {how, filled}, the field still
              connected, reloaded (the same-origin frame holding it loaded another document).
              A field the page re-rendered (the same id; else the same name, tag and type; else
              the same tag, type, placeholder and aria-label in its form: one match only) is
              followed to its replacement; only when there is none is it gone.
              Once entered, gone or reloaded it disarms itself (one-shot).
            {disarm: token}: remove the ring, the note and the listeners.
   Never returns what the field holds: `filled` only says whether it is empty. */
(function () {
  var A = __ASK__;
  var cur = window.__chromeBridgeAsk;
  function out(o) { o.ok = o.ok !== false; return JSON.stringify(o); }

  function off(st) {
    if (!st) return;
    try { st.win.removeEventListener('keydown', st.onKey, true); } catch (e) {}
    try { st.win.removeEventListener('submit', st.onSubmit, true); } catch (e) {}
    try { st.win.removeEventListener('click', st.onClick, true); } catch (e) {}
    hide(st);
    if (window.__chromeBridgeAsk === st) window.__chromeBridgeAsk = null;
  }

  /* The highlight off the screen and the tab title back (the listeners stay until the agent reads). */
  function hide(st) {
    try { cancelAnimationFrame(st.raf); } catch (e) {}
    st.raf = 0; st.hidden = true;
    try { st.host.remove(); } catch (e) {}
    // Wherever the page moved it ("(1) 【需要你输入】登录"), every copy: the page's own title stays.
    try { var t = document.title; if (st.prefix && t.indexOf(st.prefix) !== -1) document.title = t.split(st.prefix).join(''); } catch (e) {}
    try { if (!st.entered) sessionStorage.removeItem(CARRY + st.token); } catch (e) {}
  }

  /* The user's Return / submit, kept for the next document of this tab when the page moves on before the
     agent looks (a form POST): sessionStorage outlives a same-origin navigation; only how and when, under
     the agent's token, which the page never sees before it is written. */
  var CARRY = 'mychrome-ask-';
  function carry(st) {
    try { sessionStorage.setItem(CARRY + st.token, JSON.stringify({ how: st.entered.how, at: st.entered.at })); } catch (e) {}
  }
  function carried(token) {
    var v = null;
    try { v = JSON.parse(sessionStorage.getItem(CARRY + token) || 'null'); sessionStorage.removeItem(CARRY + token); } catch (e) {}
    return v && typeof v.how === 'string' && typeof v.at === 'number' ? { how: v.how, at: v.at } : null;
  }

  function filled(el) { return String(el.value || '').length > 0; }

  /* Fields the user filled at the agent's request: their values are never printed (read.js, after.js). */
  function keepPrivate(el, like) {
    var P = window.__chromeBridgePrivate || (window.__chromeBridgePrivate = { set: new WeakSet(), like: [], forms: new WeakSet() });
    P.set.add(el);
    if (like && (like.id || like.name) && P.like.length < 50) P.like.push({ tag: like.tag, type: like.type, id: like.id, name: like.name });
    // Nothing to know a re-rendered copy by: its form's text fields keep their values to themselves.
    else if (like && el.form) P.forms.add(el.form);
  }

  var TEXT_TYPES = { '': 1, text: 1, password: 1, email: 1, tel: 1, number: 1, search: 1, url: 1 };
  /* Inputs and textareas only: a contenteditable's text is page text, which read_page prints. */
  function kindOf(el) {
    if (el.tagName === 'TEXTAREA') return el.readOnly || el.disabled ? null : 'multi';
    if (el.tagName !== 'INPUT') return null;
    var t = String(el.getAttribute('type') || '').toLowerCase();
    if (!TEXT_TYPES[t] || el.readOnly || el.disabled) return null;
    return 'single';
  }

  /* The element's box in the top document's viewport (same-origin frames add their offset). */
  function topRect(el) {
    var r = el.getBoundingClientRect();
    var x = r.left, y = r.top, w = r.width, h = r.height;
    var win = el.ownerDocument.defaultView;
    try {
      while (win && win !== window && win.frameElement) {
        var f = win.frameElement.getBoundingClientRect();
        x += f.left + win.frameElement.clientLeft; y += f.top + win.frameElement.clientTop;
        win = win.parent;
      }
    } catch (e) {}
    return { x: x, y: y, w: w, h: h };
  }

  /* The field the page put in place of a re-rendered one: the same id, or the same tag, name and type
     (one such field only); null when there is none (the page moved on). */
  function replacement(st) {
    var L = st.like, d = st.doc, c = null;
    function same(x) { return x.tagName === L.tag && String(x.getAttribute('type') || '').toLowerCase() === L.type; }
    function only(list, ok) {
      var hits = [];
      for (var i = 0; i < list.length; i++) if (ok(list[i])) hits.push(list[i]);
      return hits.length === 1 ? hits[0] : null;
    }
    try {
      if (L.id) c = d.getElementById(L.id);
      if ((!c || !same(c)) && L.name) c = only(d.getElementsByName(L.name), same);
      if ((!c || !same(c)) && (L.placeholder || L.label)) {
        var scope = st.form && st.form.isConnected ? st.form.querySelectorAll(L.tag) : d.getElementsByTagName(L.tag);
        c = only(scope, function (x) {
          return same(x) && (x.getAttribute('placeholder') || '') === L.placeholder && (x.getAttribute('aria-label') || '') === L.label;
        });
      }
    } catch (e) { c = null; }
    return c && c.isConnected && same(c) && kindOf(c) ? c : null;
  }

  /* Every same-origin frame between the top page and the field, with the document it showed. */
  function frameChain(doc) {
    var chain = [];
    try {
      for (var win = doc.defaultView; win && win !== window && win.frameElement; win = win.parent) {
        chain.push({ el: win.frameElement, doc: win.document });
      }
    } catch (e) {}
    return chain;
  }
  /* Each frame still shows the document it showed at arm (a frame that loaded another document leaves
     the old one detached, and its nodes still say isConnected). */
  function docLive(st) {
    for (var i = 0; i < st.frames.length; i++) {
      var f = st.frames[i];
      try { if (!f.el.isConnected || f.el.contentDocument !== f.doc) return false; } catch (e) { return false; }
    }
    return true;
  }

  function follow(st) {
    if (st.el.isConnected || !docLive(st)) return;
    var r = replacement(st);
    if (r) { st.el = r; keepPrivate(r, null); }
  }

  function set(node, css) { for (var k in css) node.style[k] = css[k]; return node; }

  function draw(el, text, multi) {
    var host = document.createElement('div');
    host.setAttribute('data-mychrome-ask', '');
    set(host, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483647', pointerEvents: 'none' });
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    // Spotlight: the rest of the page dimmed around the field (clicks still pass through).
    var spot = set(document.createElement('div'), {
      position: 'fixed', borderRadius: '8px', boxShadow: '0 0 0 200vmax rgba(0,0,0,.55)', pointerEvents: 'none'
    });
    var ring = set(document.createElement('div'), {
      position: 'fixed', boxSizing: 'border-box', border: '4px solid #ff9f0a', borderRadius: '8px',
      boxShadow: '0 0 0 4px rgba(255,159,10,.45)', pointerEvents: 'none'
    });
    var note = set(document.createElement('div'), {
      position: 'fixed', maxWidth: '420px', boxSizing: 'border-box', padding: '12px 16px', borderRadius: '12px',
      background: '#1d1d1f', color: '#fff', font: '16px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,.35)', pointerEvents: 'none', whiteSpace: 'normal', wordBreak: 'break-word'
    });
    var head = set(document.createElement('div'), { fontWeight: '600', fontSize: '18px', color: '#ffd60a' });
    head.textContent = text.title;
    var hint = set(document.createElement('div'), { marginTop: '4px', color: '#f2f2f7' });
    hint.textContent = multi ? text.hintMulti : text.hint;
    var brand = set(document.createElement('div'), { marginTop: '6px', fontSize: '11px', color: '#8e8e93' });
    brand.textContent = text.brand;
    note.appendChild(head); note.appendChild(hint); note.appendChild(brand);
    root.appendChild(spot); root.appendChild(ring); root.appendChild(note);
    (document.body || document.documentElement).appendChild(host);
    try {
      ring.animate([{ boxShadow: '0 0 0 2px rgba(255,159,10,.7)' }, { boxShadow: '0 0 0 16px rgba(255,159,10,0)' }],
        { duration: 1200, iterations: Infinity });
    } catch (e) {}
    // The tab title says it too, for a tab not in view (the page may rewrite its title: put it back about once a second).
    var st = { host: host, spot: spot, ring: ring, note: note, raf: 0, el: el, prefix: String(text.tab || ''), frame: 0 };
    function mark() {
      try { if (st.prefix && document.title.indexOf(st.prefix) === -1) document.title = st.prefix + document.title; } catch (e) {}
    }
    mark();
    function place() {
      if (st.hidden) return;
      if (++st.frame % 60 === 0) mark();
      var r = st.el.isConnected ? topRect(st.el) : { x: 0, y: 0, w: 0, h: 0 }, pad = 4;
      var hidden = r.w === 0 && r.h === 0;
      spot.style.display = ring.style.display = note.style.display = hidden ? 'none' : 'block';
      if (!hidden) {
        var box = { left: (r.x - pad) + 'px', top: (r.y - pad) + 'px', width: (r.w + 2 * pad) + 'px', height: (r.h + 2 * pad) + 'px' };
        set(spot, box); set(ring, box);
        var nh = note.offsetHeight || 64, nw = note.offsetWidth || 300;
        var top = r.y - pad - 10 - nh >= 8 ? r.y - pad - 10 - nh : r.y + r.h + pad + 10;
        var left = Math.max(8, Math.min(r.x - pad, window.innerWidth - nw - 8));
        set(note, { left: left + 'px', top: Math.max(8, top) + 'px' });
      }
      st.raf = requestAnimationFrame(place);
    }
    place();
    return st;
  }

  if (A && A.arm) {
    off(cur);
    var reg = window.__chromeBridge;
    if (!reg || !reg.markers || reg.url !== location.href) {
      return out({ ok: false, error: 'stale', message: '标记号已失效（页面没读过或已跳转/刷新），请先重新调用 read_page' });
    }
    var el = reg.markers[A.marker];
    if (!el) return out({ ok: false, error: 'no_such_marker', message: '没有编号为 [' + A.marker + '] 的元素，请先重新调用 read_page' });
    if (!el.isConnected) return out({ ok: false, error: 'stale', message: '编号 [' + A.marker + '] 的元素已经从页面上消失，请重新调用 read_page' });
    // read_page numbers a label next to its field ("[3] 密码 [4] 输入框"); the label means its field.
    try { if (el.tagName === 'LABEL' && el.control && kindOf(el.control)) el = el.control; } catch (e) {}
    var kind = kindOf(el);
    if (!kind) {
      return out({ ok: false, error: 'not_a_field',
        message: '[' + A.marker + '] 不是可输入的文本框（' + String(el.tagName).toLowerCase() + '），field 只能指向用户要输入文字的框' });
    }
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) {}
    try { el.focus({ preventScroll: true }); } catch (e) {}
    var st = draw(el, A.text || {}, kind === 'multi');
    st.token = A.arm; st.doc = el.ownerDocument; st.win = st.doc.defaultView || window; st.entered = null;
    st.like = { id: el.id || '', name: el.getAttribute('name') || '', type: String(el.getAttribute('type') || '').toLowerCase(), tag: el.tagName,
      placeholder: el.getAttribute('placeholder') || '', label: el.getAttribute('aria-label') || '' };
    st.form = el.form || null;
    st.frames = frameChain(st.doc);
    keepPrivate(el, st.like);
    // Window, capture phase: ahead of the page's own handlers on the document and the field.
    st.onKey = function (e) {
      if (!e.isTrusted || e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      follow(st);
      var el = st.el;
      var t = e.composedPath ? e.composedPath()[0] : e.target;
      var inField = t === el || (t && t.nodeType === 1 && el.contains(t));
      var inForm = !inField && el.form && t && t.form === el.form;
      if (!inField && !inForm) return;
      // Return in a multi-line field is a new line: done there is Cmd/Ctrl+Return.
      var multi = inField ? kindOf(el) === 'multi' : t.tagName === 'TEXTAREA';
      if (multi && !(e.metaKey || e.ctrlKey)) return;
      st.entered = { how: 'enter', filled: filled(el), at: Date.now() };
      hide(st);
      carry(st);
    };
    // A trusted click on a submit button of the form: what makes the submit that follows the user's
    // (not a click into a field, nor a "show password" button).
    st.onClick = function (e) {
      if (!e.isTrusted) return;
      var f = st.el.form, t = e.composedPath ? e.composedPath()[0] : e.target, b = null;
      if (!f || !t || t.nodeType !== 1) return;
      try { b = t.closest('button, input'); } catch (x) {}
      if (b && b.form === f && String(b.type || '').toLowerCase() === 'submit') st.clickAt = Date.now();
    };
    st.onSubmit = function (e) {
      // A page's dispatched submit is untrusted; its requestSubmit() is trusted but has no click before it.
      if (!e.isTrusted || !(st.clickAt && Date.now() - st.clickAt < 3000)) return;
      var f = e.target;
      follow(st);
      if (f && f.contains && f.contains(st.el) && !st.entered) { st.entered = { how: 'submit', filled: filled(st.el), at: Date.now() }; hide(st); carry(st); }
    };
    st.win.addEventListener('keydown', st.onKey, true);
    st.win.addEventListener('submit', st.onSubmit, true);
    st.win.addEventListener('click', st.onClick, true);
    window.__chromeBridgeAsk = st;
    var tp = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    return out({ armed: true, kind: kind, password: tp === 'password', filled: filled(el) });
  }

  var mine = !!cur && !!A && (cur.token === A.read || cur.token === A.disarm);
  if (!mine) {
    // Another document now: was it the user's Return that brought it?
    var was = A && (A.read || A.disarm) ? carried(A.read || A.disarm) : null;
    return out(was && A.read ? { armed: false, carried: was } : { armed: false });
  }
  if (A.disarm) { off(cur); return out({ armed: false, disarmed: true }); }
  follow(cur);
  var reloaded = !docLive(cur);
  var connected = !reloaded && cur.el.isConnected;
  var res = { armed: true, entered: cur.entered, connected: connected };
  if (reloaded) res.reloaded = true;
  if (cur.entered || !connected) { off(cur); carried(cur.token); }
  return out(res);
})()
