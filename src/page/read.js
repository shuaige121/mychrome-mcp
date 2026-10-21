/* Injected into the active tab by read_page.
   Rules: idempotent, no visible DOM mutation (only a window property),
   returns a JSON string. Chrome's `execute javascript` hands back the value
   of the last expression, so the whole thing is one IIFE.

   Marker numbers follow document order and are the same whatever is open on
   top; what changes with an open modal or popup is the ORDER of the output and
   what survives truncation:
   - an open modal (<dialog open>, or role=dialog/alertdialog with
     aria-modal=true) is listed first, in the text and in the index, and the
     elements outside it are flagged [被弹窗挡住];
   - the modal, expanded popups (what an aria-expanded=true control points at
     with aria-controls/aria-owns) and portal layers at the end of <body> are
     kept whole when the output has to be cut; the rest of the text is cut.
   States are shown next to the marker and in the index: [展开]/[收起],
   [已选], [禁用]. A native <select> lists its options in the index.
   An element found only by its pointer cursor (a listener we cannot see) is
   flagged (推测可点).

   What is printed (__READ__, filled in by src/index.js; numbering and the
   click registry are the same in every mode — only the printing differs):
   - {} (default): an open modal first and whole, then the page outline —
     visible headings h1–h6/role=heading as S1, S2… (S0 = what comes before
     the first one), indented by level, each with its estimated size in tokens
     (sub-sections included), its clickable count and whether it is on
     screen; a page without headings falls back to landmarks (header, nav,
     main, aside, footer, form and their roles); then "this screen": the text
     and the clickable elements that meet the viewport.
   - {sections: ['S3', 'S7']}: those sections with their sub-sections.
   - {query: 'x'}: the blocks (and elements) that contain x, case-insensitive,
     with their section; with sections, only inside those.
   - {full: true}: the whole page, capped, exactly as before the outline. */
(function () {
  // A server started before the outline (3a25299) loads this file fresh on every read and leaves
  // __READ__ unreplaced: give it the whole page, which is what it expects.
  var REQ = typeof __READ__ === 'undefined' ? { full: true } : (__READ__ || {});
  var MODE = REQ.full ? 'full'
    : (REQ.query != null && /\S/.test(String(REQ.query)) ? 'query'
      : (REQ.sections && REQ.sections.length ? 'sections' : 'screen'));
  var TRACK = MODE !== 'full';  // sections, viewport and sizes are only needed outside full mode
  var MAX_OUT = 12000;
  var INDEX_CAP = 5000;
  var SCREEN_MAX = 6000;        // default mode: this screen (with an open modal), text + index
  var SCREEN_INDEX_CAP = 2500;
  var OUTLINE_MAX = 2500;
  var SECTIONS_MAX = 12000;
  var QUERY_MAX = 6000;
  var QUERY_HITS = 20;
  var BIG_SECTION = 8000;       // tokens: references, navigation boxes, comment threads
  var BIG_PAGE = 50000;
  var SELECT_LIST_MAX = 30;
  var HTML_NS = 'http://www.w3.org/1999/xhtml';
  var TEXT_INPUT_TYPES = {
    text: 1, search: 1, email: 1, password: 1, tel: 1, url: 1,
    number: 1, date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1
  };
  var CLICK_INPUT_TYPES = { submit: 1, button: 1, reset: 1, checkbox: 1, radio: 1, file: 1, image: 1 };

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1,
    LINK: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1
  };

  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BR: 1, DD: 1, DETAILS: 1,
    DIALOG: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1,
    FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1,
    HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1,
    TD: 1, TH: 1, TR: 1, UL: 1, SUMMARY: 1, OPTION: 1
  };

  // Roles that make an element a target of its own.
  var CANDIDATE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
    menuitemradio: 1, option: 1, 'switch': 1, searchbox: 1, textbox: 1,
    combobox: 1, treeitem: 1, gridcell: 1
  };
  // Candidates that do not stand for what is inside them: a combobox holds its
  // input and its list, a treeitem its child items, a gridcell its buttons.
  var OPEN_ROLES = { combobox: 1, treeitem: 1, gridcell: 1 };
  // tabindex on these makes a region focusable (to scroll it, to trap focus);
  // it is not a control.
  var REGION_TAGS = {
    HTML: 1, BODY: 1, MAIN: 1, SECTION: 1, ARTICLE: 1, NAV: 1, ASIDE: 1, HEADER: 1, FOOTER: 1,
    FORM: 1, TABLE: 1, UL: 1, OL: 1, DL: 1, DIALOG: 1, FIELDSET: 1
  };
  var REGION_ROLES = {
    tabpanel: 1, dialog: 1, alertdialog: 1, region: 1, main: 1, document: 1, article: 1,
    application: 1, log: 1, feed: 1, group: 1, list: 1, navigation: 1, complementary: 1,
    banner: 1, contentinfo: 1, form: 1, search: 1, toolbar: 1, tablist: 1, listbox: 1,
    menu: 1, menubar: 1, tree: 1, grid: 1, treegrid: 1, radiogroup: 1, table: 1,
    rowgroup: 1, presentation: 1, none: 1, status: 1, alert: 1, tooltip: 1
  };
  var POPUP_ROLE_SEL = '[role="listbox"],[role="menu"],[role="option"],[role="menuitem"],' +
    '[role="menuitemradio"],[role="menuitemcheckbox"],[role="tree"],[role="grid"]';

  // One computed style per element per read: the candidate pass, the cursor
  // check and the text walk all look at the same elements.
  var styleCache = new Map();
  function styleOf(el) {
    var s = styleCache.get(el);
    if (s === undefined) {
      try { s = window.getComputedStyle(el); } catch (e) { s = null; }
      styleCache.set(el, s);
    }
    return s;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    // checkVisibility() is the only check that also catches display:none on an
    // ANCESTOR — getComputedStyle(el).display on a child of a hidden parent
    // still reports the child's own value, so the manual checks below would
    // wave it through. Chrome 105+ has it; keep the manual path as a fallback.
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true
        })) return false;
      } catch (e) { /* older signature: fall through */ }
    }

    var st = styleOf(el);
    if (!st) return false;
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity) === 0) return false;
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width <= 0 || r.height <= 0) return false;
    // getClientRects() is empty for elements that generate no boxes at all.
    if (el.getClientRects().length === 0) return false;
    return true;
  }

  function normText(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // Token estimate (docs/discussion-round7/measure.md): a CJK character ≈ 1
  // token, other text ≈ 3.5 characters per token, and each clickable element
  // +6 (its marker in the text and its index line).
  var CJK_RE = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g;
  function estimateTokens(text, clicks) {
    var s = String(text == null ? '' : text);
    var cjk = (s.match(CJK_RE) || []).length;
    return Math.round(cjk + (s.length - cjk) / 3.5 + 6 * (clicks || 0));
  }

  /* --- the viewport ------------------------------------------------------ */

  var VW = window.innerWidth || 0;
  var VH = window.innerHeight || 0;
  var rectCache = new Map();
  function rectOf(el) {
    var r = rectCache.get(el);
    if (r === undefined) {
      try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
      rectCache.set(el, r);
    }
    return r;
  }
  function meetsViewport(r) {
    return !!r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < VH && r.left < VW;
  }
  function elOnScreen(el) { return meetsViewport(rectOf(el)); }
  /* A text node meets the viewport: its parent's box decides, unless that box
     reaches past the screen edge — then the text's own line boxes do. */
  function textOnScreen(node) {
    var p = node.parentElement, r = null;
    // display:contents has no box of its own: the nearest ancestor that has one.
    for (; p; p = p.parentElement) {
      r = rectOf(p);
      if (r && (r.width > 0 || r.height > 0)) break;
    }
    if (!p || !meetsViewport(r)) return false;
    if (r.top >= 0 && r.left >= 0 && r.bottom <= VH && r.right <= VW) return true;
    var rs = null;
    try {
      var rg = document.createRange();
      rg.selectNodeContents(node);
      rs = rg.getClientRects();
    } catch (e) { rs = null; }
    if (!rs || !rs.length) return true;
    for (var k = 0; k < rs.length; k++) if (meetsViewport(rs[k])) return true;
    return false;
  }

  function roleOf(el) {
    return (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
  }

  /* --- candidate collection ------------------------------------------- */

  function isCandidate(el) {
    var tag = el.tagName;
    if (tag === 'A') return !!el.getAttribute('href') || el.hasAttribute('onclick');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return false;
      return !!(TEXT_INPUT_TYPES[t] || CLICK_INPUT_TYPES[t]);
    }
    if (tag === 'LABEL') {
      // Only labels that actually drive a form control.
      if (el.control) return true;
      return !!el.getAttribute('for');
    }
    if (CANDIDATE_ROLES[roleOf(el)]) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    return false;
  }

  /* tabindex >= 0 on something that is not a region. */
  function isFocusTarget(el) {
    if (el.namespaceURI !== HTML_NS) return false;
    var v = el.getAttribute('tabindex');
    if (v == null) return false;
    var n = parseInt(v, 10);
    if (isNaN(n) || n < 0) return false;
    if (REGION_TAGS[el.tagName]) return false;
    var role = roleOf(el);
    return !(role && REGION_ROLES[role]);
  }

  function cursorOf(el) {
    var s = el && el.nodeType === 1 ? styleOf(el) : null;
    return s ? s.cursor : '';
  }

  /* The outermost element of a cursor:pointer subtree (cursor is inherited, so
     every descendant reports it too), with text or an aria-label of its own. */
  function isPointerRoot(el) {
    if (el.namespaceURI !== HTML_NS) return false;
    if (cursorOf(el) !== 'pointer') return false;
    if (el.parentElement && cursorOf(el.parentElement) === 'pointer') return false;
    return !!(normText(el.innerText || el.textContent) || normText(el.getAttribute('aria-label')));
  }

  function isTextField(el) {
    var tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !!TEXT_INPUT_TYPES[(el.type || 'text').toLowerCase()];
    var role = roleOf(el);
    if (role === 'textbox' || role === 'searchbox') return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    return false;
  }

  /* A field the user filled at the agent's request (wait_for_user field, src/page/ask.js): its value is
     never printed. Same id or name + tag + type also counts (the page may have re-rendered it). */
  function isPrivate(el) {
    var P = window.__chromeBridgePrivate;
    if (!P || !el) return false;
    try {
      if (P.set && P.set.has(el)) return true;
      if (P.forms && el.form && P.forms.has(el.form) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return true;
      var type = String(el.getAttribute('type') || '').toLowerCase(), name = el.getAttribute('name');
      for (var i = 0; i < P.like.length; i++) {
        var L = P.like[i];
        if (el.tagName === L.tag && type === L.type && ((L.id && el.id === L.id) || (L.name && name === L.name))) return true;
      }
    } catch (e) {}
    return false;
  }

  function labelFor(el) {
    var tag = el.tagName;
    if (tag === 'SELECT') {
      var o = el.options && el.options[el.selectedIndex];
      return normText((o && o.text) || el.getAttribute('aria-label') || el.name || '下拉框');
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // A password's value is never its label, nor what the user typed for the agent (after.js describe() does the same).
      var pw = String(el.type || '').toLowerCase() === 'password' || isPrivate(el);
      return normText(
        el.getAttribute('aria-label') || el.placeholder || (pw ? '' : el.value) ||
        el.getAttribute('title') || el.name || el.type || tag.toLowerCase()
      );
    }
    var t = normText(el.innerText || el.textContent);
    if (t) return t;
    return normText(
      el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('alt') || (el.querySelector('img') && el.querySelector('img').alt) || ''
    );
  }

  // Document order. querySelectorAll('*') is heavy on huge pages but keeps the
  // ordering guarantee we need for stable marker numbers.
  var all = document.body ? document.body.querySelectorAll('*') : [];

  // Pass 1: what is a candidate by itself ('strong': tag, role, onclick,
  // contenteditable; 'focus': tabindex only), and which elements contain one.
  var kindOf = new Map();
  var hasCandDesc = new Set();
  var hasStrongDesc = new Set();
  var hasPointerDesc = new Set(); // holds a pointer-cursor subtree (for portal detection)
  var i, a, el;
  for (i = 0; i < all.length; i++) {
    el = all[i];
    if (SKIP_TAGS[el.tagName]) continue;
    var k = isCandidate(el) ? 'strong' : (isFocusTarget(el) ? 'focus' : null);
    if (!k) {
      if (cursorOf(el) === 'pointer' && !(el.parentElement && cursorOf(el.parentElement) === 'pointer')) {
        for (a = el.parentElement; a && !hasPointerDesc.has(a); a = a.parentElement) hasPointerDesc.add(a);
      }
      continue;
    }
    if (!isVisible(el)) continue;
    kindOf.set(el, k);
    for (a = el.parentElement; a; a = a.parentElement) {
      var had = hasCandDesc.has(a);
      hasCandDesc.add(a);
      if (k === 'strong') {
        if (hasStrongDesc.has(a)) break;
        hasStrongDesc.add(a);
      } else if (had) break;
    }
  }

  /* --- what is open on top ---------------------------------------------- */

  function inside(node, roots) {
    for (var x = node; x; x = x.parentElement) if (roots.has(x)) return true;
    return false;
  }

  // The active modal: the innermost visible one, the last in document order
  // when several are side by side (portals append the newest at the end).
  var modal = null;
  (function () {
    var list = document.querySelectorAll(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
    var open = [];
    for (var p = 0; p < list.length; p++) if (isVisible(list[p])) open.push(list[p]);
    for (var q = 0; q < open.length; q++) {
      var innermost = true;
      for (var r = 0; r < open.length; r++) {
        if (r !== q && open[q].contains(open[r])) { innermost = false; break; }
      }
      if (innermost) modal = open[q];
    }
  })();

  function dialogTitle(m) {
    var t = '';
    var ids = (m.getAttribute('aria-labelledby') || '').split(/\s+/);
    for (var p = 0; p < ids.length; p++) {
      var n = ids[p] && document.getElementById(ids[p]);
      if (n) t += ' ' + (n.innerText || n.textContent);
    }
    t = normText(t) || normText(m.getAttribute('aria-label'));
    if (!t) {
      var h = m.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend');
      if (h) t = normText(h.innerText || h.textContent);
    }
    if (!t) t = normText(m.innerText || m.textContent);
    if (t.length > 40) t = t.slice(0, 40) + '…';
    return t || '无标题';
  }

  // Expanded popups: what an aria-expanded=true control points at.
  var popupRoots = [];
  var popupOwner = new Map();
  var expandedCtl = document.querySelectorAll('[aria-expanded="true"]');
  for (i = 0; i < expandedCtl.length; i++) {
    var c = expandedCtl[i];
    var ids = ((c.getAttribute('aria-controls') || '') + ' ' + (c.getAttribute('aria-owns') || '')).split(/\s+/);
    for (var p = 0; p < ids.length; p++) {
      var n = ids[p] && document.getElementById(ids[p]);
      if (!n || n === c || n === document.body || n.contains(c) || popupOwner.has(n)) continue;
      if (!isVisible(n) && !hasCandDesc.has(n)) continue;
      popupOwner.set(n, c);
      popupRoots.push(n);
    }
  }

  // Portal layers: containers appended at the end of <body> that hold popups
  // (menus, listboxes, banners rendered outside the app root): positioned
  // themselves, a listbox/menu themselves, or flat boxes whose content is all
  // out of flow (a portal root holding absolutely placed popups). Only trailing
  // ones, and never the first body child that holds controls (the app). Merely
  // containing a menu somewhere does not count: a <main> or <footer> would.
  var portals = [];
  (function () {
    if (!document.body) return;
    var withControls = [];
    for (var ch = document.body.firstElementChild; ch; ch = ch.nextElementSibling) {
      if (SKIP_TAGS[ch.tagName]) continue;
      if (hasCandDesc.has(ch) || kindOf.has(ch) || hasPointerDesc.has(ch) || isPointerRoot(ch)) withControls.push(ch);
    }
    function positioned(x) {
      var st = styleOf(x);
      return !!st && (st.position === 'fixed' || st.position === 'absolute');
    }
    function portalLike(x) {
      if (positioned(x)) return true;
      var role = roleOf(x);
      if (role === 'listbox' || role === 'menu') return true;
      var r;
      try { r = x.getBoundingClientRect(); } catch (e) { return false; }
      return !!r && r.height < 1;
    }
    for (var w = withControls.length - 1; w >= 1; w--) {
      if (!portalLike(withControls[w])) break;
      portals.unshift(withControls[w]);
    }
  })();

  // With a modal open, what is in front of it: the modal, popups opened from
  // inside it, and popup layers (lists, menus) that come after it.
  var frontRoots = [];
  var frontPopups = [];
  if (modal) {
    frontRoots.push(modal);
    var after = function (x) {
      return !x.contains(modal) && !modal.contains(x) &&
        !!(modal.compareDocumentPosition(x) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
    };
    for (i = 0; i < popupRoots.length; i++) {
      var pr = popupRoots[i];
      if (!modal.contains(pr) && modal.contains(popupOwner.get(pr))) frontPopups.push(pr);
    }
    for (i = 0; i < portals.length; i++) {
      var pl = portals[i];
      var popupish = roleOf(pl) === 'listbox' || roleOf(pl) === 'menu' || !!pl.querySelector(POPUP_ROLE_SEL);
      if (after(pl) && popupish && frontPopups.indexOf(pl) === -1) frontPopups.push(pl);
    }
    // Inner ones are covered by an outer one already.
    frontPopups = frontPopups.filter(function (x) {
      for (var y = 0; y < frontPopups.length; y++) if (frontPopups[y] !== x && frontPopups[y].contains(x)) return false;
      return true;
    });
    frontPopups.sort(function (x, y) { return x.compareDocumentPosition(y) & 4 ? -1 : 1; });
    frontRoots = frontRoots.concat(frontPopups);
  }
  var frontSet = new Set(frontRoots);
  var prioRootSet = new Set(frontRoots.concat(popupRoots, portals));
  // Nesting stops at these: an option in a listbox is its own target even when
  // the listbox sits inside a clickable trigger.
  var boundary = prioRootSet;

  /* --- pass 2: the markers ------------------------------------------------ */

  var candidateSet = new Set();
  var candidates = [];
  var inferred = new Set();

  function swallows(x) { return kindOf.get(x) === 'strong' && !OPEN_ROLES[roleOf(x)]; }
  // Inside an already chosen candidate (any kind when anyKind), up to the
  // nearest popup / modal boundary.
  function insideCandidate(x, anyKind) {
    for (var y = x.parentElement; y; y = y.parentElement) {
      if (candidateSet.has(y) && (anyKind || inferred.has(y) || swallows(y))) return true;
      if (boundary.has(y)) return false;
    }
    return false;
  }

  for (i = 0; i < all.length; i++) {
    el = all[i];
    if (SKIP_TAGS[el.tagName]) continue;
    var kind = kindOf.get(el);
    if (kind === 'focus') {
      // A focusable wrapper around real controls: the controls are the targets.
      if (hasStrongDesc.has(el)) continue;
      if (insideCandidate(el, false)) continue;
    } else if (kind === 'strong') {
      // Clickable-inside-clickable: the outer one already covers it, unless this
      // is a real form field the agent may need to focus separately.
      // select_option requires the select's own marker. A surrounding label
      // or clickable wrapper must not hide it or its available options.
      if (!isTextField(el) && el.tagName !== 'SELECT' && insideCandidate(el, false)) continue;
    } else {
      // No role, no tag, no onclick: a listener we cannot see, guessed from the
      // pointer cursor. Only the outermost pointer element, and only when no
      // real control is inside it or around it.
      if (!isPointerRoot(el) || hasCandDesc.has(el) || !isVisible(el)) continue;
      if (insideCandidate(el, true)) continue;
      inferred.add(el);
    }
    candidateSet.add(el);
    candidates.push(el);
  }

  var markerOf = new Map();
  var registry = [null]; // 1-based
  for (var j = 0; j < candidates.length; j++) {
    markerOf.set(candidates[j], j + 1);
    registry.push(candidates[j]);
  }

  // Handoff to click/type. A window property only — nothing visible changes.
  window.__chromeBridge = {
    markers: registry,
    url: location.href,
    stamp: Date.now()
  };

  /* --- states ------------------------------------------------------------ */

  function isChecked(x) {
    if (x.getAttribute('aria-selected') === 'true' || x.getAttribute('aria-checked') === 'true') return true;
    if (x.tagName === 'INPUT') {
      var t = (x.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return !!x.checked;
    }
    if (x.tagName === 'LABEL' && x.control && x.control !== x) {
      var ct = (x.control.type || '').toLowerCase();
      if (x.control.tagName === 'INPUT' && (ct === 'checkbox' || ct === 'radio')) return !!x.control.checked;
    }
    return false;
  }

  function isDisabled(x) {
    if (x.disabled === true) return true;
    // :disabled also covers a control inside a disabled <fieldset> (outside its legend).
    try { if (x.matches(':disabled')) return true; } catch (e) { /* no :disabled */ }
    if (x.closest('[aria-disabled="true"]')) return true;
    if (x.closest('[inert]')) return true;
    if (x.tagName === 'LABEL' && x.control && x.control !== x && x.control.tagName !== 'LABEL') return isDisabled(x.control);
    return false;
  }

  function stateTags(x) {
    var tags = [];
    var ex = x.getAttribute('aria-expanded');
    if (ex === 'true') tags.push('[展开]');
    else if (ex === 'false') tags.push('[收起]');
    else if (x.tagName === 'SUMMARY' && x.parentElement && x.parentElement.tagName === 'DETAILS') {
      tags.push(x.parentElement.open ? '[展开]' : '[收起]');
    }
    if (isChecked(x)) tags.push('[已选]');
    if (isDisabled(x)) tags.push('[禁用]');
    if (inferred.has(x)) tags.push('(推测可点)');
    return tags;
  }
  var tagsOf = new Map();
  for (var s = 1; s < registry.length; s++) tagsOf.set(registry[s], stateTags(registry[s]));

  /* --- the outline: sections ---------------------------------------------- */

  // S0 holds what comes before the first heading (or, by landmarks, what is in
  // none). Each section: its own text pieces and clickables as the walk meets
  // them; sizes add up the sub-sections afterwards. The ids are document order.
  var HEADING_SEL = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  var LANDMARK_NAMES = {
    banner: '页首', navigation: '导航', main: '主体', complementary: '侧栏',
    contentinfo: '页脚', form: '表单', search: '搜索'
  };
  var LANDMARK_TAGS = { HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FOOTER: 'contentinfo', FORM: 'form' };
  var secs = [];
  var secBy = 'none';            // 'headings' | 'landmarks' | 'none'
  var secStart = new Map();      // element → section id: the walk enters that section there
  var markerSec = new Map();     // marker element → section id, as the walk met it

  function newSec(title, el) {
    var x = { id: secs.length, title: title, el: el, level: 0, depth: 0, parent: -1, kids: [], last: secs.length,
              texts: [], clicks: 0, scr: false, tok: 0, clk: 0 };
    secs.push(x);
    return x;
  }
  function inFront(x) { return !!modal && inside(x, frontSet); }
  function accName(x) {
    var t = '';
    var ids = (x.getAttribute('aria-labelledby') || '').split(/\s+/);
    for (var p = 0; p < ids.length; p++) {
      var n = ids[p] && document.getElementById(ids[p]);
      if (n) t += ' ' + (n.innerText || n.textContent);
    }
    return normText(t) || normText(x.getAttribute('aria-label'));
  }
  function cut(t, max) { return t.length > max ? t.slice(0, max) + '…' : t; }
  function headingLevel(h) {
    var lv = parseInt(h.getAttribute('aria-level'), 10);
    if (lv >= 1) return lv;
    var m = /^H([1-6])$/.exec(h.tagName);
    return m ? +m[1] : 2;
  }
  function landmarkRole(x) {
    var role = roleOf(x);
    if (role) return LANDMARK_NAMES[role] ? role : null;  // an explicit role wins over the tag
    var r = LANDMARK_TAGS[x.tagName];
    // <header>/<footer> are the page's banner/contentinfo only outside sectioning content.
    if ((r === 'banner' || r === 'contentinfo') && x.parentElement &&
        x.parentElement.closest('article,aside,main,nav,section')) return null;
    return r || null;
  }

  if (TRACK && document.body) {
    newSec('', null);
    var hl = document.body.querySelectorAll(HEADING_SEL);
    var heads = [];
    for (i = 0; i < hl.length; i++) {
      var h = hl[i];
      if (h.parentElement && h.parentElement.closest(HEADING_SEL)) continue;  // a heading inside a heading
      if (inFront(h) || !isVisible(h)) continue;
      heads.push(h);
    }
    if (heads.length) {
      secBy = 'headings';
      secs[0].title = '（第一个标题之前）';
      // A single h1 is the page title: its section is the lead, the h2s are not under it.
      var h1s = 0;
      for (i = 0; i < heads.length; i++) if (headingLevel(heads[i]) === 1) h1s++;
      var stack = [];
      for (i = 0; i < heads.length; i++) {
        h = heads[i];
        var hs = newSec(cut(normText(h.innerText || h.textContent) || accName(h) || '（无文字标题）', 60), h);
        hs.level = headingLevel(h);
        var titleH1 = h1s === 1 && hs.level === 1;
        while (stack.length && stack[stack.length - 1].level >= hs.level) stack.pop();
        if (stack.length && !titleH1) {
          hs.parent = stack[stack.length - 1].id;
          hs.depth = stack[stack.length - 1].depth + 1;
          secs[hs.parent].kids.push(hs.id);
        }
        if (!titleH1) stack.push(hs);
        // A heading inside a link or button card starts its section at the card,
        // so the card's marker belongs with its title (when it is the card's first heading).
        var startAt = h;
        for (a = h.parentElement; a && a !== document.body; a = a.parentElement) {
          if (candidateSet.has(a) && a.querySelector(HEADING_SEL) === h) startAt = a;
        }
        secStart.set(secStart.has(startAt) ? h : startAt, hs.id);
      }
    } else {
      var ll = document.body.querySelectorAll(
        'header,nav,main,aside,footer,form,[role="banner"],[role="navigation"],[role="main"],' +
        '[role="complementary"],[role="contentinfo"],[role="form"],[role="search"]');
      for (i = 0; i < ll.length; i++) {
        var lm = ll[i];
        var lr = landmarkRole(lm);
        if (!lr || inFront(lm) || !isVisible(lm)) continue;
        var nm = accName(lm);
        if (!nm) nm = cut(normText(lm.innerText || lm.textContent), 30);
        var ls = newSec(LANDMARK_NAMES[lr] + (nm ? '「' + cut(nm, 30) + '」' : ''), lm);
        for (a = lm.parentElement; a; a = a.parentElement) {
          if (secStart.has(a)) {
            ls.parent = secStart.get(a);
            ls.depth = secs[ls.parent].depth + 1;
            secs[ls.parent].kids.push(ls.id);
            break;
          }
        }
        secStart.set(lm, ls.id);
      }
      if (secs.length > 1) {
        secBy = 'landmarks';
        secs[0].title = '（不在任何区域里的内容）';
      }
    }
  }

  /* --- text extraction ------------------------------------------------- */

  // Segment marks around the parts that survive truncation (modal, popups).
  var PRIO_ON = '\u0001', PRIO_OFF = '\u0002';
  var parts = [];
  // Outside full mode, per part: its section (-1 = the modal block), whether
  // it meets the viewport (screen mode; undefined for layout-only parts) and
  // whether it is inside an expanded popup (aria-expanded → aria-controls),
  // which "this screen" shows whole. Portal layers follow the viewport there:
  // an off-canvas drawer is a portal too.
  var partSec = [], partScr = [], partPop = [];
  var popupSet = new Set(popupRoots);
  var popDepth = 0;
  var zoneFront = false;
  var curSec = 0;
  function push(str, scr) {
    if (!str) return;
    parts.push(str);
    if (TRACK) {
      partSec.push(zoneFront ? -1 : curSec);
      partScr.push(scr);
      partPop.push(popDepth > 0);
    }
  }
  var prioDepth = 0;
  var skipRoots = null;

  function walk(node, depth) {
    if (depth > 80) return;
    if (node.nodeType === 3) { // text
      var t = node.nodeValue;
      if (t && /\S/.test(t)) {
        var scr;
        if (TRACK && !zoneFront) {
          secs[curSec].texts.push(normText(t));
          if (MODE === 'screen') {
            scr = textOnScreen(node);
            if (scr) secs[curSec].scr = true;
          }
        }
        push(t.replace(/\s+/g, ' '), scr);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    var e = node;
    if (SKIP_TAGS[e.tagName]) return;
    if (skipRoots && skipRoots.has(e)) {
      if (e === modal && !TRACK) push('\n（这里是弹窗，内容见上）\n');
      return;
    }
    var enter = TRACK && !zoneFront ? secStart.get(e) : undefined;
    var outer = curSec;
    if (enter !== undefined) curSec = enter;
    var prio = prioRootSet.has(e);
    var pop = TRACK && popupSet.has(e);
    if (pop) popDepth++;
    if (prio && prioDepth++ === 0) push(PRIO_ON);
    walkElement(e, depth);
    if (prio && --prioDepth === 0) push(PRIO_OFF);
    if (pop) popDepth--;
    // A landmark section ends with its element; a heading section runs on to the next heading.
    if (enter !== undefined && secBy === 'landmarks') curSec = outer;
  }

  function walkElement(e, depth) {
    var st = styleOf(e);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return;
    // Zero-box elements are a common way to hide text (width:0;height:0,
    // clip, off-flow). display:contents legitimately has no box of its own
    // while its children are visible, so it must not be dropped.
    if (st && st.display !== 'contents' && e.getClientRects().length === 0) return;

    var mark = markerOf.get(e);
    var block = BLOCK_TAGS[e.tagName];

    if (block) push('\n');
    var mscr;
    if (mark) {
      var tg = tagsOf.get(e);
      if (TRACK && !zoneFront) {
        secs[curSec].clicks++;
        markerSec.set(e, curSec);
        if (MODE === 'screen') {
          mscr = elOnScreen(e);
          if (mscr) secs[curSec].scr = true;
        }
      }
      push(' [' + mark + '] ' + (tg.length ? tg.join(' ') + ' ' : ''), mscr);
    }

    if (mark && (isTextField(e) || e.tagName === 'SELECT' || e.tagName === 'INPUT')) {
      // Form controls have no useful child text; describe them instead.
      var kindName = isTextField(e) ? '输入框' : (e.tagName === 'SELECT' ? '下拉框' : '控件');
      var desc = kindName + ': ' + (labelFor(e) || '(空)') + ' ';
      if (TRACK && !zoneFront) secs[curSec].texts.push(normText(desc));
      push(desc, mscr);
      if (block) push('\n');
      return;
    }

    for (var ch = e.firstChild; ch; ch = ch.nextSibling) walk(ch, depth + 1);
    if (mark) push(' ');
    if (block) push('\n');
  }

  var modalTitle = modal ? dialogTitle(modal) : '';
  if (document.body) {
    if (modal) {
      zoneFront = true;
      push(PRIO_ON);
      prioDepth = 1;
      push('--- 弹窗「' + modalTitle + '」里的内容 ---\n');
      for (i = 0; i < frontRoots.length; i++) { push('\n'); walk(frontRoots[i], 0); }
      prioDepth = 0;
      push(PRIO_OFF);
      zoneFront = false;
      if (!TRACK) push('\n\n--- 弹窗外的页面：下面的元素都[被弹窗挡住]，先处理弹窗 ---\n');
      skipRoots = frontSet;
    }
    walk(document.body, 0);
  }

  function tidy(str) {
    return str
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  // Pieces in document order, each kept whole (prio) or cut from the tail.
  function splitPieces(str) {
    var list = [];
    var any = false;
    var inPrio = false;
    var raw = tidy(str).split(/([\u0001\u0002])/);
    for (var p = 0; p < raw.length; p++) {
      if (raw[p] === PRIO_ON) inPrio = true;
      else if (raw[p] === PRIO_OFF) inPrio = false;
      else if (raw[p]) { list.push({ t: raw[p], prio: inPrio }); if (inPrio && /\S/.test(raw[p])) any = true; }
    }
    return { list: list, hasPrio: any };
  }

  var CUT = '\n…（此处正文已省略）\n';
  /* The text within budget: priority pieces first (cut only if they alone are
     too long), the rest of the text gets what is left, from the head. */
  function fitBody(pp, budget) {
    var pieces = pp.list;
    var bodyLen = 0, prioLen = 0, prioCount = 0, q;
    for (q = 0; q < pieces.length; q++) {
      bodyLen += pieces[q].t.length;
      if (pieces[q].prio) { prioLen += pieces[q].t.length; prioCount++; }
    }
    if (bodyLen <= budget) return { text: pieces.map(function (x) { return x.t; }).join(''), cut: false };
    var prioLeft = Math.min(prioLen, Math.max(0, budget - CUT.length * (prioCount + 1)));
    var restLeft = Math.max(0, budget - prioLen - CUT.length * (prioCount + 1));
    var outParts = [];
    var pendingCut = false;
    for (q = 0; q < pieces.length; q++) {
      var pc = pieces[q];
      var room = pc.prio ? prioLeft : restLeft;
      var take = Math.min(room, pc.t.length);
      if (take > 0) {
        if (pendingCut) { outParts.push(CUT); pendingCut = false; }
        outParts.push(pc.t.slice(0, take));
        if (pc.prio) prioLeft -= take; else restLeft -= take;
      }
      if (take < pc.t.length && /\S/.test(pc.t.slice(take))) pendingCut = true;
    }
    return { text: outParts.join(''), cut: true };
  }

  /* --- index ----------------------------------------------------------- */

  function selectOptionsLine(sel) {
    var opts = sel.options ? Array.prototype.slice.call(sel.options) : [];
    var total = opts.length;
    if (!total) return '    选项：（没有选项）';
    var shown = Math.min(total, SELECT_LIST_MAX);
    var out = [];
    var lastGroup = null;
    function optText(o) {
      var t = normText(o.text);
      return t.length > 40 ? t.slice(0, 40) + '…' : t;
    }
    for (var p = 0; p < shown; p++) {
      var o = opts[p];
      var g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
      if (g !== lastGroup) {
        if (g) out.push('〔' + normText(g.label) + (g.disabled ? '·禁用' : '') + '〕');
        lastGroup = g;
      }
      out.push('「' + optText(o) + '」' + (o.selected ? '[已选]' : '') +
               (o.disabled || (g && g.disabled) ? '[禁用]' : ''));
    }
    var line = '    选项（共 ' + total + ' 个' + (total > shown ? '，只列前 ' + shown + ' 个' : '') + '）：' + out.join(' ');
    if (total > shown) {
      var later = [];
      for (var q = shown; q < total; q++) {
        if (opts[q].selected) later.push('「' + optText(opts[q]) + '」（第 ' + (q + 1) + ' 个）');
      }
      line += ' …' + (later.length ? '；当前选中 ' + later.join(' ') : '');
    }
    return line;
  }

  var entries = [];
  for (var kx = 1; kx < registry.length; kx++) {
    var r = registry[kx];
    var txt = labelFor(r);
    if (txt.length > 60) txt = txt.slice(0, 60) + '…';
    var tag = r.tagName.toLowerCase();
    if (tag === 'input') tag = 'input[' + ((r.type || 'text').toLowerCase()) + ']';
    var role = (r.getAttribute('role') || '').toLowerCase();
    if (role && tag.indexOf(role) === -1) tag += '(role=' + role + ')';
    var front = !!modal && inside(r, frontSet);
    var flags = [];
    if (isTextField(r)) flags.push('文本输入框');
    flags = flags.concat(tagsOf.get(r));
    if (modal && !front) flags.push('[被弹窗挡住]');
    var line = '[' + kx + '] ' + tag + ' | ' + (txt || '(无文字)') + (flags.length ? ' | ' + flags.join(' ') : '');
    if (r.tagName === 'SELECT') line += '\n' + selectOptionsLine(r);
    var isPrio = front || inside(r, prioRootSet) || r.getAttribute('aria-expanded') === 'true';
    entries.push({ line: line, front: front, prio: isPrio, n: kx, el: r, pop: TRACK && inside(r, popupSet) });
  }
  if (modal) {
    // The modal's own elements first; numbers stay as they are.
    entries = entries.filter(function (x) { return x.front; })
      .concat(entries.filter(function (x) { return !x.front; }));
  }

  /* Index lines within cap: popups and the modal first, then the rest from
     the head; shown in order. */
  function buildIndex(list, cap) {
    var len = 0, q;
    for (q = 0; q < list.length; q++) len += list[q].line.length + 1;
    if (len <= cap) return list.map(function (x) { return x.line; }).join('\n');
    var prioN = 0;
    for (q = 0; q < list.length; q++) if (list[q].prio) prioN++;
    var keep = new Set();
    var used = 0;
    var full = false;
    for (var pass = 0; pass < 2 && !full; pass++) {
      for (q = 0; q < list.length; q++) {
        if (keep.has(q) || list[q].prio !== (pass === 0)) continue;
        if (used + list[q].line.length + 1 > cap) { full = true; break; }
        keep.add(q);
        used += list[q].line.length + 1;
      }
    }
    var kept = [];
    for (q = 0; q < list.length; q++) if (keep.has(q)) kept.push(list[q].line);
    kept.push('…（索引已截断，另有 ' + (list.length - keep.size) + ' 个元素未列出' +
              (prioN ? '；弹窗和展开的列表里的元素已优先列出' : '') +
              '；正文里出现的编号照样能点）');
    return kept.join('\n');
  }

  var warn = modal ? '⚠️ 页面开着弹窗「' + modalTitle + '」：先列弹窗里的元素；弹窗外的元素被它挡住\n' : '';
  var header = '# ' + normText(document.title) + '\n# ' + location.href + '\n';

  /* How much of the viewport shows things this reader cannot put into words (read_page then reads the screen
     instead): canvases, frames, videos, plug-ins, SVG, and large pictures without alt text. Overlaps are counted
     twice (an estimate), capped at 1. */
  function opaqueShare() {
    if (!VW || !VH) return 0;
    var els = document.querySelectorAll('canvas, iframe, frame, embed, object, video, svg, img');
    var area = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.tagName === 'IMG' && (el.getAttribute('alt') || '').trim().length > 2) continue;
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement && el.parentElement.closest('svg')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 80) continue;
      var w = Math.min(r.right, VW) - Math.max(r.left, 0), h = Math.min(r.bottom, VH) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      area += w * h;
    }
    return Math.min(1, Math.round(area / (VW * VH) * 100) / 100);
  }

  function result(text, hint) {
    return JSON.stringify({
      ok: true,
      mode: MODE,
      visibility: document.visibilityState,
      opaque: opaqueShare(),
      url: location.href,
      title: document.title,
      count: registry.length - 1,
      text: text,
      hint: hint,
      outline: secs.slice(0, 300).map(function (x) {
        return { id: x.id, title: x.title, depth: x.depth, parent: x.parent, last: x.last, tok: x.tok, clk: x.clk, scr: x.scr };
      }),
      view: {
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        screenX: window.screenX, screenY: window.screenY,
        dpr: window.devicePixelRatio,
        scrollY: window.scrollY, scrollMax: document.documentElement.scrollHeight
      }
    });
  }

  /* --- full mode: the whole page, as before the outline ------------------- */

  if (MODE === 'full') {
    var index = buildIndex(entries, INDEX_CAP);
    var indexHead = '\n\n=== 可点击元素索引（共 ' + (registry.length - 1) + ' 个' +
                    (modal ? '；弹窗里的排在最前' : '') + '）===\n';
    var pp = splitPieces(parts.join(''));
    var budget = MAX_OUT - warn.length - header.length - indexHead.length - index.length - 200;
    if (budget < 1000) budget = 1000;
    var fb = fitBody(pp, budget);
    var truncNote = !fb.cut ? '' : (pp.hasPrio
      ? '\n\n…（正文过长已截断：弹窗和展开的列表完整保留，其余正文只显示了一部分）'
      : '\n\n…（正文过长已截断，只显示前 ' + budget + ' 个字符）');
    return result(warn + header + tidy(fb.text).trim() + truncNote + indexHead + index, '');
  }

  /* --- section sizes and the outline -------------------------------------- */

  // A section's size includes its sub-sections (ids id+1 … last, preorder).
  for (i = secs.length - 1; i >= 0; i--) {
    var sx = secs[i];
    var allText = sx.texts.join('');
    sx.clk = sx.clicks;
    for (var kk = 0; kk < sx.kids.length; kk++) {
      var kd = secs[sx.kids[kk]];
      allText += kd.all;
      sx.clk += kd.clk;
      if (kd.last > sx.last) sx.last = kd.last;
    }
    sx.all = allText;
    sx.tok = estimateTokens(allText, sx.clk);
  }
  var pageAll = '', pageClk = 0;
  for (i = 0; i < secs.length; i++) {
    if (secs[i].parent === -1) { pageAll += secs[i].all; pageClk += secs[i].clk; }
  }
  var pageTok = estimateTokens(pageAll, pageClk);
  pageAll = null;
  for (i = 0; i < secs.length; i++) secs[i].all = null;

  function listed(x) { return !(x.id === 0 && x.tok === 0 && x.clk === 0); }
  function indent(n) { var t = ''; for (var q = 0; q < n; q++) t += '  '; return t; }
  function anyOnScreen(x) { for (var q = x.id; q <= x.last; q++) if (secs[q].scr) return true; return false; }
  function sizeLine(x, more) {
    var bits = ['约 ' + x.tok + ' token', x.clk + ' 个可点'];
    if (more) bits.push(more);
    var t = 'S' + x.id + ' ' + x.title + '（' + bits.join('，') + '）';
    if (x.tok > BIG_SECTION) {
      t += ' ⚠️ 异常大（约 ' + x.tok + ' token），多半是参考文献/导航/评论区，别整节展开，' +
        (x.kids.length ? '用 query 或展开它的子节' : '用 query 找需要的部分');
    }
    return t;
  }
  function outlineLines(maxDepth, withScreen) {
    var out = [];
    for (var q = 0; q < secs.length; q++) {
      var x = secs[q];
      if (!listed(x) || x.depth > maxDepth) continue;
      var folded = x.depth === maxDepth && x.kids.length > 0;
      var t = indent(x.depth) + sizeLine(x, folded ? '含 ' + (x.last - x.id) + ' 个子节' : '');
      if (withScreen && (folded ? anyOnScreen(x) : x.scr)) t += ' [在屏上]';
      out.push(t);
    }
    return out;
  }
  function outlineBlock(withScreen) {
    if (secBy === 'none') {
      return '（这个页面没有标题结构，也没有页首、导航、主体这类区域标记，所以没有目录：找内容用 query，整页用 full=true）';
    }
    var n = 0;
    for (var q = 0; q < secs.length; q++) if (listed(secs[q])) n++;
    var head = '=== 页面目录（' + (secBy === 'landmarks' ? '页面没有标题，按页面区域分节；' : '') +
      n + ' 节；整页约 ' + pageTok + ' token、' + pageClk + ' 个可点）===\n';
    if (pageTok > BIG_PAGE) {
      head += '⚠️ 整页约 ' + pageTok + ' token，异常大：别用 full 整页读，按目录展开需要的节，或用 query\n';
    }
    var room = OUTLINE_MAX - head.length;
    var lines = outlineLines(99, withScreen);
    var note = '';
    if (lines.join('\n').length > room) {
      lines = outlineLines(1, withScreen);
      note = '（目录太长，只列了前两层；展开一节时会列出它的子节）\n';
    }
    if (note.length + lines.join('\n').length > room) {
      var kept = [], used = note.length + 60;
      for (q = 0; q < lines.length; q++) {
        if (used + lines[q].length + 1 > room) break;
        kept.push(lines[q]);
        used += lines[q].length + 1;
      }
      kept.push('…（还有 ' + (lines.length - kept.length) + ' 行目录没列出：用 query 找，或展开前面的节）');
      lines = kept;
    }
    return head + note + lines.join('\n');
  }

  /* --- which section a marker is in --------------------------------------- */

  function secOfMarker(el) {
    var sm = markerSec.get(el);
    if (sm !== undefined) return sm;
    // Not reached by the text walk (inside a box that has no size): by place.
    var q;
    if (secBy === 'landmarks') {
      for (q = el; q; q = q.parentElement) if (secStart.has(q)) return secStart.get(q);
      return 0;
    }
    var best = 0;
    if (secBy === 'headings') {
      for (q = 1; q < secs.length; q++) {
        var st = secs[q].el;
        if (st === el || (st.compareDocumentPosition(el) & 4 /* FOLLOWING */)) best = q; else break;
      }
    }
    return best;
  }
  function sectionId(raw) {
    var mm = /^\s*[Ss]?(\d+)\s*$/.exec(String(raw));
    var id = mm ? parseInt(mm[1], 10) : -1;
    return id >= 0 && id < secs.length && secBy !== 'none' && listed(secs[id]) ? id : -1;
  }
  /* The page text of sections lo…hi (a section and its sub-sections), in document order. */
  function rangeText(lo, hi) {
    var t = [];
    for (var q = 0; q < parts.length; q++) if (partSec[q] >= lo && partSec[q] <= hi) t.push(parts[q]);
    return t.join('');
  }

  var warnOther = modal
    ? '⚠️ 页面开着弹窗「' + modalTitle + '」：下面的元素都被它挡住，先处理弹窗（不带参数的 read_page 会先列出弹窗里的内容）\n'
    : '';

  /* --- default: an open modal, the outline, this screen ------------------- */

  if (MODE === 'screen') {
    var frontEntries = entries.filter(function (x) { return x.front; });
    var pageEntries = entries.filter(function (x) { return !x.front && (x.pop || elOnScreen(x.el)); });
    var modalIdx = modal ? buildIndex(frontEntries, SCREEN_INDEX_CAP) : '';
    var screenIdx = buildIndex(pageEntries, Math.max(800, SCREEN_INDEX_CAP - modalIdx.length));
    var scrollMax = document.documentElement ? document.documentElement.scrollHeight : 0;
    var screens = VH > 0 ? Math.ceil(scrollMax / VH) : 0;
    var at = VH > 0 ? Math.min(screens, Math.floor((window.scrollY || 0) / VH) + 1) : 1;
    var where = screens > 1 ? '整页约 ' + screens + ' 屏，这是第 ' + at + ' 屏' : '整页只有这一屏';
    var screenHead = '\n\n=== 这一屏' + (modal ? '：弹窗外的页面，元素都[被弹窗挡住]，先处理弹窗' : '') +
      '（' + where + '）===\n';
    var idxHead = '\n\n=== 这一屏的可点击元素（' + pageEntries.length + ' 个；整页共 ' + (registry.length - 1) +
      ' 个，编号全页通用）===\n';
    var modalIdxHead = '\n--- 弹窗里的可点击元素（' + frontEntries.length + ' 个）---\n';
    var budgetS = SCREEN_MAX - modalIdx.length - screenIdx.length - screenHead.length - idxHead.length -
      (modal ? modalIdxHead.length : 0) - 150;
    if (budgetS < 1000) budgetS = 1000;

    var modalBody = '';
    if (modal) {
      var mf = [];
      for (i = 0; i < parts.length; i++) if (partSec[i] === -1) mf.push(parts[i]);
      var mb = fitBody(splitPieces(mf.join('')), budgetS);
      modalBody = tidy(mb.text).trim() + (mb.cut ? '\n…（弹窗内容过长，只显示了一部分）' : '');
    }
    // On screen: text and markers that meet the viewport, and expanded popups whole.
    var sv = [];
    for (i = 0; i < parts.length; i++) {
      if (partSec[i] === -1) continue;
      var pt = parts[i];
      if (pt === PRIO_ON || pt === PRIO_OFF || !/\S/.test(pt) || partScr[i] === true || partPop[i]) sv.push(pt);
    }
    var sb = fitBody(splitPieces(sv.join('')), Math.max(500, budgetS - modalBody.length));
    var screenBody = tidy(sb.text).trim() || '（这一屏没有文字）';
    if (sb.cut) {
      screenBody += '\n…（这一屏的文字超过预算，后面的省略了：用 sections 展开所在的节，或用 query 找）';
    }
    var hintD = secBy === 'none'
      ? '提示：这个页面没有目录可展开：找关键词用 read_page(query="…")，整页用 read_page(full=true)，或 scroll 往下翻再读。'
      : '提示：展开几节用 read_page(sections=["S2","S5"])（大节连同子节）；找关键词用 read_page(query="…")；' +
        '整页用 read_page(full=true)（约 12000 字封顶）。';
    return result(warn + header +
      (modal ? '\n' + modalBody + modalIdxHead + (modalIdx || '（没有）') + '\n' : '') +
      '\n' + outlineBlock(true) +
      screenHead + screenBody +
      idxHead + (screenIdx || '（这一屏没有可点击元素）') +
      '\n\n' + hintD, hintD);
  }

  /* --- sections: chosen sections with their sub-sections ------------------ */

  function sectionBlock(x, per) {
    var head = '=== S' + x.id + ' ' + x.title + '（约 ' + x.tok + ' token，' + x.clk + ' 个可点' +
      (x.last > x.id ? '，含子节 S' + (x.id + 1) + '–S' + x.last : '') + '）===\n';
    var sub = '';
    if (x.last > x.id) {
      var sl = [], dl = [];
      for (var q = x.id + 1; q <= x.last; q++) {
        var t = indent(secs[q].depth - x.depth - 1) + sizeLine(secs[q], '');
        sl.push(t);
        if (secs[q].parent === x.id) dl.push(t);
      }
      sub = '子节：\n' + (sl.join('\n').length > 1500 ? dl : sl).join('\n') + '\n\n';
    }
    var list = entries.filter(function (e) {
      if (e.front) return false;
      var sm = secOfMarker(e.el);
      return sm >= x.id && sm <= x.last;
    });
    var idx = buildIndex(list, Math.floor(per * 0.4));
    var idxH = '\n--- S' + x.id + ' 里的可点击元素（' + list.length + ' 个）---\n';
    var budget = per - head.length - sub.length - idx.length - idxH.length - 150;
    if (budget < 800) budget = 800;
    var fb = fitBody(splitPieces(rangeText(x.id, x.last)), budget);
    var body = tidy(fb.text).trim() || '（这一节没有文字）';
    if (fb.cut) {
      body += '\n…（S' + x.id + ' 超过这次的预算，只显示了前 ' + budget + ' 字' +
        (x.kids.length ? '；可以分别展开它的子节（见上面的子节目录）' : '') + '，或用 query 找需要的内容）';
    }
    return head + sub + body + idxH + (idx || '（这一节没有可点击元素）');
  }

  if (MODE === 'sections') {
    var want = [], bad = [];
    var askList = [].concat(REQ.sections);
    for (i = 0; i < askList.length; i++) {
      var sid = sectionId(askList[i]);
      if (sid < 0) bad.push(String(askList[i]));
      else if (want.indexOf(sid) === -1) want.push(sid);
    }
    // A section inside another chosen one comes with it.
    var chosen = want.filter(function (id) {
      return !want.some(function (o) { return o < id && id <= secs[o].last; });
    });
    var blocks = [];
    if (secBy === 'none') {
      blocks.push('（这个页面没有标题结构，没有可展开的节：找内容用 query，整页用 full=true）');
    } else if (bad.length) {
      blocks.push('（目录里没有 ' + bad.join('、') + '：目录是 S0–S' + (secs.length - 1) +
        '，不带参数的 read_page 可以看目录）');
    }
    var nested = want.filter(function (id) { return chosen.indexOf(id) === -1; });
    if (nested.length) {
      blocks.push('（' + nested.map(function (id) { return 'S' + id; }).join('、') + ' 在一起展开的大节里，不再单列）');
    }
    var per = chosen.length ? Math.max(2500, Math.floor((SECTIONS_MAX - 400) / chosen.length)) : 0;
    for (i = 0; i < chosen.length; i++) blocks.push(sectionBlock(secs[chosen[i]], per));
    var hintS = '提示：别的节见目录（不带参数的 read_page）；找关键词用 read_page(query="…")；整页用 read_page(full=true)。';
    return result(warnOther + header + '\n' + blocks.join('\n\n') + '\n\n' + hintS, hintS);
  }

  /* --- query: the blocks and elements that contain it --------------------- */

  var qShown = normText(REQ.query);
  var qq = qShown.toLowerCase();
  var scope = null;   // section ids to search; null = the whole page (and an open modal)
  var scopeNote = '';
  if (REQ.sections && [].concat(REQ.sections).length && secBy !== 'none') {
    scope = new Set();
    [].concat(REQ.sections).forEach(function (raw) {
      var id = sectionId(raw);
      if (id >= 0) for (var q = id; q <= secs[id].last; q++) scope.add(q);
    });
    if (!scope.size) {
      scope = null;
      scopeNote = '（sections 里的节号目录里都没有，查的是整页）\n';
    }
  }
  var groups = [];
  var groupOf = {};
  if (modal && !scope) groups.push(groupOf[-1] = { id: -1, label: '弹窗「' + modalTitle + '」' });
  for (i = 0; i < secs.length; i++) {
    if (scope && !scope.has(i)) continue;
    groups.push(groupOf[i] = { id: i, label: secBy === 'none' ? '页面' : 'S' + i + ' ' + secs[i].title });
  }
  for (i = 0; i < groups.length; i++) groups[i].order = i;
  var bySec = {};
  for (i = 0; i < parts.length; i++) (bySec[partSec[i]] || (bySec[partSec[i]] = [])).push(parts[i]);

  function snippet(l) {
    if (l.length <= 300) return l;
    var p = l.toLowerCase().indexOf(qq);
    var a0 = Math.max(0, p - 120), b0 = Math.min(l.length, a0 + 300);
    return (a0 > 0 ? '…' : '') + l.slice(a0, b0) + (b0 < l.length ? '…' : '');
  }
  var hits = [], total = 0, inHitLines = new Set();
  for (var gi = 0; gi < groups.length; gi++) {
    var gtext = tidy((bySec[groups[gi].id] || []).join('')).replace(/[\u0001\u0002]/g, '').split('\n');
    for (var li = 0; li < gtext.length; li++) {
      var ln = gtext[li].trim();
      if (!ln || ln.toLowerCase().indexOf(qq) === -1) continue;
      total++;
      var ms = ln.match(/\[\d+\]/g) || [];
      for (var mi = 0; mi < ms.length; mi++) inHitLines.add(parseInt(ms[mi].slice(1), 10));
      hits.push({ g: groups[gi], t: snippet(ln), el: false });
    }
  }
  // Elements whose name holds it but the text does not show it (icon buttons, fields).
  for (i = 0; i < entries.length; i++) {
    var en = entries[i];
    if (inHitLines.has(en.n) || labelFor(en.el).toLowerCase().indexOf(qq) === -1) continue;
    var eg = groupOf[en.front ? -1 : secOfMarker(en.el)];
    if (!eg) continue;
    total++;
    hits.push({ g: eg, t: en.line, el: true });
  }
  // By section (stable sort): within one, text hits in document order, then element-name hits.
  hits.sort(function (x, y) { return x.g.order - y.g.order; });

  var qLines = [], marks = new Set(), shownHits = 0, usedQ = 0, lastG = null;
  for (i = 0; i < hits.length && shownHits < QUERY_HITS; i++) {
    var hh = hits[i];
    if (usedQ + hh.t.length > QUERY_MAX) break;
    if (hh.g !== lastG) { qLines.push(hh.g.label + '：'); lastG = hh.g; }
    qLines.push('  ' + hh.t);
    usedQ += hh.t.length + hh.g.label.length + 4;
    shownHits++;
    if (!hh.el) {
      var hm = hh.t.match(/\[\d+\]/g) || [];
      for (var mj = 0; mj < hm.length; mj++) marks.add(parseInt(hm[mj].slice(1), 10));
    }
  }
  var qIdx = buildIndex(entries.filter(function (x) { return marks.has(x.n); }), 2500);
  var qHead = '=== 查找「' + qShown + '」（不区分大小写' + (scope ? '，只在指定的节里' : '') + '）：' +
    (total ? '找到 ' + total + ' 处' : '没有找到') + ' ===\n';
  var qBody = total
    ? qLines.join('\n') +
      (total > shownHits ? '\n…（另有 ' + (total - shownHits) + ' 处没列出：换个更具体的词，或加 sections 限定在某几节里）' : '') +
      (qIdx ? '\n--- 上面这些段落里的可点击元素 ---\n' + qIdx : '')
    : '（查了' + (scope ? '指定的节' : '整页') + '的正文和元素的文字，都没有「' + qShown + '」）';
  var hintQ = '提示：要看命中处所在的整节用 read_page(sections=["S…"])；目录见不带参数的 read_page；整页用 read_page(full=true)。';
  return result(warnOther + header + '\n' + scopeNote + qHead + qBody + '\n\n' + hintQ, hintQ);
})()
