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

   What is printed (__READ__, filled in by src/index.js):
   - {}: highest content headings only, plus currently open modal/popups.
   - {sections: ['S3']}: open that section's own body and its immediate child
     headings. Descendants stay folded; opened sections persist per reader.
   - {query: 'x'}: matching blocks, including folded descendants; sections
     narrows the search to those subtrees.
   - {full: true}: capped full-page text with each control described inline once.
   The compact modes return stable blocks for server-side delta feedback and
   budget continuation; marker numbering remains global and mode-independent. */
(function () {
  // A server started before the outline (3a25299) loads this file fresh on every read and leaves
  // __READ__ unreplaced: give it the whole page, which is what it expects.
  var REQ = typeof __READ__ === 'undefined' ? { full: true } : (__READ__ || {});
  var ACTION = REQ.actionSnapshot === true;
  var MODE = REQ.full ? 'full'
    : (REQ.query != null && /\S/.test(String(REQ.query)) ? 'query'
      : (REQ.sections && REQ.sections.length ? 'sections' : 'screen'));
  var COMPACT = MODE === 'screen' || MODE === 'sections';
  var TRACK = MODE !== 'full';  // sections, viewport and sizes are only needed outside full mode
  var MAX_OUT = 12000;
  var CONTROL_CAP = 5000;
  var QUERY_MAX = 6000;
  var QUERY_HITS = 20;
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

  /* Long labels and options are cut at a word boundary, never inside a word of a script written with
     spaces; Chinese / Japanese / Thai may break between any two characters. Only an unbroken token longer
     than half the room (a URL, an identifier) is cut where the room ends; every cut is followed by a
     marker (… in compact output, 「（续）」 or 「（后略）」 in full and query). cutAt gives where the kept
     part ends. */
  var WORD_CHAR = /[\p{L}\p{N}\p{M}'’_]/u;
  var UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
  function wordChar(c) { return !!c && WORD_CHAR.test(c) && !UNSPACED.test(c); }
  function cutAt(t, max) {
    if (t.length <= max) return t.length;
    var k = max;
    if (wordChar(t.charAt(k - 1)) && wordChar(t.charAt(k))) {
      var j = k;
      while (j > 0 && wordChar(t.charAt(j - 1))) j--;
      if (j >= max / 2) k = j;
    }
    var code = t.charCodeAt(k - 1);
    if (code >= 0xD800 && code <= 0xDBFF) k--;
    return k;
  }
  function clip(t, max) {
    var k = cutAt(t, max);
    return k >= t.length ? t : t.slice(0, k) + '…';
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
    return !!(normText(textWithoutPrivateFields(el)) || normText(el.getAttribute('aria-label')));
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

  /* read_page's typed-text check (src/index.js applyTypedChecks). REQ.typed lists the field ids this server
     typed into; src/page/after.js keeps each with the field's fingerprint (tag, type, name, id, form, page
     URL) and drops it when the node leaves the document. A listed field that still matches is "typed": its
     content is never printed (not as its label, not as text, not through controls inside it); its line gets
     a slot \u0003id\u0003 and the content goes back in the result's `typed`, for the server to compare.
     A password or a field the user filled for the agent is never typed, and its content is not read. */
  var TYPED_IDS = !ACTION && Array.isArray(REQ.typed) && REQ.typed.length ? new Set(REQ.typed.map(String)) : null;
  var typedReg = TYPED_IDS ? window.__chromeBridgeTyped : null;
  if (!typedReg || !(typedReg.fields instanceof WeakMap)) typedReg = null;
  var typedNow = TYPED_IDS ? {} : undefined;
  var typedFields = new Map();   // field element → id, for this read
  // Removals not yet delivered to after.js's observer (it runs after this script) count now.
  try { if (typedReg && typedReg.observer && typeof typedReg.sweep === 'function') typedReg.sweep(typedReg.observer.takeRecords()); } catch (e) {}
  // Same as src/page/after.js fieldPrint.
  function fieldPrint(el) {
    return [el.tagName, String(el.getAttribute('type') || '').toLowerCase(), el.getAttribute('name') || '', el.id || '', location.href].join('\u0001');
  }
  function secretField(el) {
    if (String(el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    for (var pa = el; pa; pa = pa.parentElement) if (isPrivate(pa)) return true;
    return false;
  }
  function typedIdOf(el) {
    var rec = typedReg && el ? typedReg.fields.get(el) : null;
    if (!rec || !TYPED_IDS.has(rec.id)) return null;
    if (!el.isConnected || rec.fp !== fieldPrint(el) || rec.form !== (el.form || null)) {
      typedReg.fields.delete(el);
      if (typedReg.live) typedReg.live.delete(el);
      return null;
    }
    return secretField(el) ? null : rec.id;
  }
  function fieldValue(el) {
    var v = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent);
    return String(v == null ? '' : v).replace(/\r\n?/g, '\n');
  }
  function insideTyped(el) {
    if (!typedFields.size) return false;
    for (var a = el.parentElement; a; a = a.parentElement) if (typedFields.has(a)) return true;
    return false;
  }
  // A typed field is named by what labels it, never by its content.
  function typedLabel(el) {
    var named = '';
    try { if (el.labels && el.labels.length) named = Array.prototype.map.call(el.labels, textWithoutPrivateFields).join(' '); } catch (e) {}
    return normText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') ||
      normText(named) || el.getAttribute('title') || el.getAttribute('name') ||
      (el.tagName === 'INPUT' ? String(el.getAttribute('type') || 'text').toLowerCase() : el.tagName.toLowerCase()));
  }

  // A textarea's defaultValue is also a child text node. Frameworks can mirror
  // private input there, so reading an ancestor label/title must not read that
  // subtree again. Keep the ordinary innerText path for unaffected elements;
  // neither clear the field nor clone/mutate the live page to obtain safe text.
  // Fields the agent typed into are kept out the same way.
  var privateTextFields = new Set(), privateTextAncestors = new Set();
  var textFields = document.querySelectorAll(ACTION
    ? 'input,textarea,[contenteditable],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]'
    : (typedReg ? 'input,textarea,[contenteditable]' : 'input,textarea'));
  for (var pi = 0; pi < textFields.length; pi++) {
    var field = textFields[pi], typedFieldId = typedReg ? typedIdOf(field) : null;
    if (typedFieldId) typedFields.set(field, typedFieldId);
    if (!ACTION && !typedFieldId && String(field.type || '').toLowerCase() !== 'password' && !isPrivate(field)) continue;
    privateTextFields.add(field);
    for (var parent = field.parentElement; parent; parent = parent.parentElement) {
      if (privateTextAncestors.has(parent)) break;
      privateTextAncestors.add(parent);
    }
  }
  // Inside a private or typed field (outside click snapshots, where every text field is in the set).
  function inPrivateText(el) {
    for (var a = el; a && privateTextFields.size; a = a.parentElement) if (privateTextFields.has(a)) return true;
    return false;
  }
  function textWithoutPrivateFields(el) {
    if (!el || privateTextFields.has(el) || (!ACTION && inPrivateText(el))) return '';
    if (!privateTextAncestors.has(el)) return el.innerText || el.textContent || '';
    var pieces = [], pending = [el];
    while (pending.length) {
      var node = pending.pop();
      if (node.nodeType === 3) { pieces.push(node.nodeValue || ''); continue; }
      if (node.nodeType !== 1 || privateTextFields.has(node) || SKIP_TAGS[node.tagName]) continue;
      var style = styleOf(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || parseFloat(style.opacity) === 0)) continue;
      if (!privateTextAncestors.has(node)) { pieces.push(node.innerText || node.textContent || ''); continue; }
      for (var child = node.lastChild; child; child = child.previousSibling) pending.push(child);
    }
    return pieces.join('');
  }

  function labelFor(el) {
    var tag = el.tagName;
    if (typedFields.has(el)) return typedLabel(el);
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
    var t = normText(dialogLabelContainers && dialogLabelContainers.has(el)
      ? textOutsideDialogs(el) : textWithoutPrivateFields(el));
    if (t) return t;
    return normText(
      el.getAttribute('aria-label') || el.getAttribute('title') ||
      el.getAttribute('alt') || imageAltOutsideDialogs(el) || ''
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

  // Dialog boundaries are independent of whether an actionable ancestor keeps
  // its marker. Only an unlabeled generic aggregate is treated as a backdrop;
  // an actual launcher keeps its own text, excluding the dialog subtree.
  var dialogRoots = [], dialogSet = new Set(), dialogContainers = new Set();
  var dialogLabelRoots = new Set(), dialogLabelContainers = new Set();
  var dialogList = document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]');
  for (var di = 0; di < dialogList.length; di++) {
    var dialog = dialogList[di];
    dialogLabelRoots.add(dialog);
    for (var dl = dialog.parentElement; dl && !dialogLabelContainers.has(dl); dl = dl.parentElement) dialogLabelContainers.add(dl);
    if ((dialog.tagName === 'DIALOG' && !dialog.hasAttribute('open')) || !isVisible(dialog)) continue;
    dialogRoots.push(dialog);
    dialogSet.add(dialog);
    for (var da = dialog.parentElement; da && !dialogContainers.has(da); da = da.parentElement) dialogContainers.add(da);
  }
  function textOutsideDialogs(el) {
    var pieces = [], pending = [el];
    while (pending.length) {
      var node = pending.pop();
      if (node.nodeType === 3) { pieces.push(node.nodeValue || ''); continue; }
      if (node.nodeType !== 1 || dialogLabelRoots.has(node) || privateTextFields.has(node) || SKIP_TAGS[node.tagName]) continue;
      var st = styleOf(node);
      if (node.hidden || (st && (st.display === 'none' || st.visibility === 'hidden' ||
          st.visibility === 'collapse' || parseFloat(st.opacity) === 0))) continue;
      for (var ch = node.lastChild; ch; ch = ch.previousSibling) pending.push(ch);
    }
    return pieces.join('');
  }
  function imageAltOutsideDialogs(el) {
    var imgs = el.querySelectorAll('img[alt]');
    for (var im = 0; im < imgs.length; im++) {
      var img = imgs[im], skip = false;
      for (var pa = img; pa && pa !== el; pa = pa.parentElement) {
        if ((dialogLabelRoots && dialogLabelRoots.has(pa)) || privateTextFields.has(pa) || isPrivate(pa)) { skip = true; break; }
        var st = styleOf(pa);
        if (pa.hidden || (st && (st.display === 'none' || st.visibility === 'hidden' ||
            st.visibility === 'collapse' || parseFloat(st.opacity) === 0))) { skip = true; break; }
      }
      if (!skip && normText(img.alt)) return img.alt;
    }
    return '';
  }
  function isDialogBackdrop(el) {
    return dialogContainers.has(el) && /^(DIV|SPAN)$/.test(el.tagName) && !labelFor(el);
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
      if (n) t += ' ' + textWithoutPrivateFields(n);
    }
    t = normText(t) || normText(m.getAttribute('aria-label'));
    if (!t) {
      var h = m.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend');
      if (h) t = normText(textWithoutPrivateFields(h));
    }
    if (!t) t = normText(textWithoutPrivateFields(m));
    t = clip(t, 40);
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
  var prioRootSet = new Set(frontRoots.concat(popupRoots, portals, dialogRoots));
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
      if (boundary.has(y)) return false;
      if (candidateSet.has(y) && (anyKind || inferred.has(y) || swallows(y))) return true;
    }
    return false;
  }

  for (i = 0; i < all.length; i++) {
    el = all[i];
    if (SKIP_TAGS[el.tagName] || isDialogBackdrop(el)) continue;
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
  var markerIdentity = window.__chromeBridgeMarkerIdentity;
  if (!markerIdentity || !(markerIdentity.nodes instanceof WeakMap)) {
    markerIdentity = window.__chromeBridgeMarkerIdentity = { nodes: new WeakMap(), next: 1 };
  }
  var registry = [null]; // 1-based, sparse: removed/hidden controls leave invalid IDs, never aliases
  for (var j = 0; j < candidates.length; j++) {
    var markerId = markerIdentity.nodes.get(candidates[j]);
    if (markerId === undefined) { markerId = markerIdentity.next++; markerIdentity.nodes.set(candidates[j], markerId); }
    markerOf.set(candidates[j], markerId);
    registry[markerId] = candidates[j];
  }

  // Handoff to click/type. A window property only — nothing visible changes.
  // Automatic observations keep the binding object: click-observation pins
  // the same checkbox/radio across the before/after snapshots. Node IDs remain
  // stable, and removed/hidden candidates are still removed from the registry.
  var previousRegistry = ACTION && window.__chromeBridge;
  var nextRegistry = previousRegistry && previousRegistry.url === location.href ? previousRegistry : {};
  nextRegistry.markers = registry;
  nextRegistry.url = location.href;
  nextRegistry.stamp = Date.now();
  window.__chromeBridge = nextRegistry;

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

  // Only new/changed action-delta candidates need hit probes. A before
  // snapshot does none. A failed sample is not proof of inaccessibility:
  // use the click locator's text aim + full 5x5 search for simple geometry;
  // clipped/unknown geometry, errors and budget exhaustion retain the option.
  var baselineControls = ACTION && Array.isArray(REQ.baselineControls)
    ? new Map(REQ.baselineControls.map(function (c) { return [c.n, c.line]; })) : null;
  var hitTests = 0, hitTestLimit = 200, reachabilityComplete = true;
  function unknownReachability() { reachabilityComplete = false; return true; }
  function reachableWithDialogs(x, line) {
    if (!dialogRoots.length || !baselineControls || baselineControls.get(markerOf.get(x)) === line) return true;
    if (typeof document.elementFromPoint !== 'function') return unknownReachability();
    var r = rectOf(x);
    if (!r || !meetsViewport(r)) return unknownReachability();
    // Clipping changes the locator's visible 5x5 grid. Leave those cases to
    // the authoritative click guard rather than approximate them here.
    for (var pa = x.parentElement; pa && pa !== document.body && pa !== document.documentElement; pa = pa.parentElement) {
      var st = styleOf(pa);
      if (!st || (st.overflowX && st.overflowX !== 'visible') || (st.overflowY && st.overflowY !== 'visible')) return unknownReachability();
    }
    var left = Math.max(0, r.left), top = Math.max(0, r.top);
    var width = Math.min(VW, r.right) - left, height = Math.min(VH, r.bottom) - top;
    var aim = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (r.width > 3 * r.height) {
      try {
        var tw = document.createTreeWalker(x, NodeFilter.SHOW_TEXT, null), tn;
        while ((tn = tw.nextNode())) {
          if (!/\S/.test(tn.nodeValue)) continue;
          var rg = document.createRange(); rg.selectNodeContents(tn);
          var rs = rg.getClientRects();
          if (rs && rs.length && rs[0].width > 0 && rs[0].height > 0) {
            var lx = Math.max(rs[0].left, r.left), ly = Math.max(rs[0].top, r.top);
            var lr = Math.min(rs[0].left + rs[0].width, r.right), lb = Math.min(rs[0].top + rs[0].height, r.bottom);
            if (lr > lx && lb > ly) aim = { x: (lx + lr) / 2, y: (ly + lb) / 2 };
          }
          break;
        }
      } catch (e) { /* locator also falls back to the centre */ }
    }
    function hitAt(px, py) {
      if (hitTests >= hitTestLimit) return null;
      hitTests++;
      try {
        var hit = document.elementFromPoint(px, py);
        // Missing native hit evidence is unknown, not a covered target.
        return hit ? hit === x || x.contains(hit) : null;
      } catch (e) { return null; }
    }
    if (aim.x < left || aim.x > left + width || aim.y < top || aim.y > top + height) return unknownReachability();
    var found = hitAt(aim.x, aim.y);
    if (found === null) return unknownReachability();
    if (found) return true;
    for (var hx = 0; hx < 5; hx++) {
      for (var hy = 0; hy < 5; hy++) {
        found = hitAt(left + width * (0.1 + 0.8 * hx / 4), top + height * (0.1 + 0.8 * hy / 4));
        if (found === null) return unknownReachability();
        if (found) return true;
      }
    }
    return false;
  }
  var tagsOf = new Map();
  for (var s = 0; s < candidates.length; s++) tagsOf.set(candidates[s], stateTags(candidates[s]));

  // Internal click baseline/delta only. Reuse read_page's candidate selection
  // and marker identity without expanding sections or returning page prose.
  // Include rendered offscreen controls in the baseline so scrolling an old
  // option into view does not make it a newly created option.
  if (ACTION) {
    var controls = [], controlLimit = 3000, controlsComplete = true;
    for (var ai = 0; ai < candidates.length; ai++) {
      var ac = candidates[ai], privateControl = false;
      for (var ap = ac; ap; ap = ap.parentElement) {
        if ((ap !== ac && privateTextFields.has(ap)) || isPrivate(ap)) { privateControl = true; break; }
      }
      if (privateControl) continue;
      if (controls.length >= controlLimit) { controlsComplete = false; break; }
      var actionLabel = labelFor(ac);
      if (privateTextFields.has(ac)) {
        actionLabel = ac.getAttribute('aria-label') || ac.getAttribute('placeholder') ||
          (ac.labels && Array.prototype.map.call(ac.labels, textWithoutPrivateFields).join(' ')) ||
          ac.getAttribute('title') || ac.getAttribute('name') || ac.getAttribute('role') || ac.tagName.toLowerCase();
        if (ac.tagName === 'INPUT' && /^(button|submit|reset)$/.test(ac.type)) actionLabel = ac.value || actionLabel;
      }
      var atag = ac.tagName.toLowerCase(), alabel = normText(actionLabel).slice(0, 240);
      var aline = '[' + markerOf.get(ac) + '] ' + atag + ' | ' + (alabel || '(无文字)');
      var aflags = tagsOf.get(ac) || [];
      if (aflags.length) aline += ' | ' + aflags.join(' ');
      if (ac.tagName === 'SELECT') aline += '\n' + selectOptionsLine(ac);
      controls.push({ n: markerOf.get(ac), label: alabel, line: aline,
        visible: elOnScreen(ac) && (!modal || inside(ac, frontSet)) && reachableWithDialogs(ac, aline), priority: inside(ac, prioRootSet) });
    }
    return JSON.stringify({ ok: true, controls: controls, controlsComplete: controlsComplete, reachabilityComplete: reachabilityComplete });
  }

  /* --- the outline: sections ---------------------------------------------- */

  // S0 holds what comes before the first heading (or, by landmarks, what is in
  // none). Each section: its own text pieces and clickables as the walk meets
  // them; sizes add up the sub-sections afterwards. Internal indexes follow document order;
  // public S IDs belong to actual nodes and are never reassigned to a replacement heading.
  var HEADING_SEL = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  var ARTICLE_SEL = 'article,[role="article"]';
  var LANDMARK_NAMES = {
    banner: '页首', navigation: '导航', main: '主体', complementary: '侧栏',
    contentinfo: '页脚', form: '表单', search: '搜索', article: '文章'
  };
  var LANDMARK_TAGS = { HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FOOTER: 'contentinfo', FORM: 'form', ARTICLE: 'article' };
  var contentRoots = Array.prototype.slice.call(document.querySelectorAll('main,[role="main"]'))
    .filter(function (el) { return isVisible(el) && !inFront(el); });
  if (!contentRoots.length) contentRoots = Array.prototype.slice.call(document.querySelectorAll(ARTICLE_SEL))
    .filter(function (el) { return isVisible(el) && !inFront(el); });
  contentRoots = contentRoots.filter(function (el) {
    return !contentRoots.some(function (other) { return other !== el && other.contains(el); });
  });
  var contentRegions = contentRoots.slice();
  Array.prototype.forEach.call(document.querySelectorAll(ARTICLE_SEL), function (el) {
    if (isVisible(el) && !inFront(el) && contentRoots.some(function (root) { return root !== el && root.contains(el); })) {
      contentRegions.push(el);
    }
  });
  var contentRootSet = new Set(contentRegions);
  function contentRootOf(el) {
    for (var cr = el; cr; cr = cr.parentElement) if (contentRootSet.has(cr)) return cr;
    return null;
  }
  var secs = [];
  var secBy = 'none';            // 'headings' | 'landmarks' | 'none'
  var secStart = new Map();      // element → section id: the walk enters that section there
  var markerSec = new Map();     // marker element → section id, as the walk met it
  var publicSections = new Map(); // public S id → current internal index
  var sectionIdentity = window.__chromeBridgeSectionIdentity;
  if (TRACK && (!sectionIdentity || !(sectionIdentity.nodes instanceof WeakMap))) {
    sectionIdentity = window.__chromeBridgeSectionIdentity = { nodes: new WeakMap(), next: 1 };
  }

  function newSec(title, el) {
    var publicId = 0;
    if (el) {
      publicId = sectionIdentity.nodes.get(el);
      if (publicId === undefined) { publicId = sectionIdentity.next++; sectionIdentity.nodes.set(el, publicId); }
    }
    var x = { id: secs.length, publicId: publicId, title: title, el: el, level: 0, depth: 0, parent: -1, kids: [], last: secs.length,
              texts: [], clicks: 0, scr: false, tok: 0, clk: 0 };
    publicSections.set(publicId, x.id);
    secs.push(x);
    return x;
  }
  function inFront(x) { return !!modal && inside(x, frontSet); }
  function accName(x) {
    var t = '';
    var ids = (x.getAttribute('aria-labelledby') || '').split(/\s+/);
    for (var p = 0; p < ids.length; p++) {
      var n = ids[p] && document.getElementById(ids[p]);
      if (n) t += ' ' + textWithoutPrivateFields(n);
    }
    return normText(t) || normText(x.getAttribute('aria-label'));
  }
  function cut(t, max) { return clip(t, max); }
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
      if (inPrivateText(h)) continue;  // a heading inside a private or typed field is the field's content
      if (inFront(h) || !isVisible(h)) continue;
      heads.push(h);
    }
    if (heads.length) {
      // Navigation headings must not hide a headingless main, and separate
      // articles must remain separate roots regardless of their heading levels.
      var regionRoots = new Set();
      contentRegions.forEach(function (root) {
        if (heads.some(function (heading) { return contentRootOf(heading) === root; })) return;
        // A main that only wraps titled articles needs no extra generic level.
        if (root.tagName !== 'ARTICLE' && roleOf(root) !== 'article' && heads.some(function (heading) { return root.contains(heading); })) return;
        regionRoots.add(root); heads.push(root);
      });
      heads.sort(function (a, b) { return a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1); });
      secBy = 'headings';
      secs[0].title = '（标题之外的内容）';
      var headingStacks = new Map(), previousRoot = null;
      function stackFor(root) {
        if (!headingStacks.has(root)) {
          var parentRoot = root && contentRootOf(root.parentElement);
          var inherited = parentRoot ? stackFor(parentRoot).items.slice() : [];
          headingStacks.set(root, { items: inherited, floor: inherited.length });
        }
        return headingStacks.get(root);
      }
      for (i = 0; i < heads.length; i++) {
        h = heads[i];
        var region = regionRoots.has(h);
        var title = region ? (accName(h) || LANDMARK_NAMES[landmarkRole(h)] || '文章')
          : (normText(textWithoutPrivateFields(h)) || accName(h) || '（无文字标题）');
        var hs = newSec(cut(title, 60), h);
        hs.level = region ? 1 : headingLevel(h);
        hs.contentRoot = contentRootOf(h);
        hs.content = !!hs.contentRoot;
        if (!hs.contentRoot && previousRoot) headingStacks.delete(null);
        var headingStack = stackFor(hs.contentRoot), stack = headingStack.items;
        previousRoot = hs.contentRoot;
        // Article-local headings cannot consume their enclosing main/article's
        // active heading or inherit the preceding sibling article's headings.
        while (stack.length > headingStack.floor && stack[stack.length - 1].level >= hs.level) stack.pop();
        if (stack.length) {
          hs.parent = stack[stack.length - 1].id;
          hs.depth = stack[stack.length - 1].depth + 1;
          secs[hs.parent].kids.push(hs.id);
        }
        stack.push(hs);
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
        ARTICLE_SEL + ',header,nav,main,aside,footer,form,[role="banner"],[role="navigation"],[role="main"],' +
        '[role="complementary"],[role="contentinfo"],[role="form"],[role="search"]');
      for (i = 0; i < ll.length; i++) {
        var lm = ll[i];
        var lr = landmarkRole(lm);
        if (!lr || inFront(lm) || !isVisible(lm)) continue;
        var nm = accName(lm);
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
  var partSec = [], partScr = [], partPop = [], partControl = [], partHeading = [];
  var partOwner = [], controlStack = [];
  var controlDepth = 0, headingDepth = 0;
  var popupSet = new Set(popupRoots.concat(dialogRoots.filter(function (x) { return !inside(x, frontSet); })));
  var popDepth = 0;
  var zoneFront = false;
  var curSec = 0;
  function push(str, scr) {
    if (!str) return;
    parts.push(str);
    if (!COMPACT) partOwner.push(controlStack.length ? controlStack[controlStack.length - 1] : 0);
    if (TRACK) {
      partSec.push(zoneFront ? -1 : curSec);
      partScr.push(scr);
      partPop.push(popDepth > 0);
      partControl.push(controlDepth > 0);
      partHeading.push(headingDepth > 0);
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
    var outerControlDepth = controlDepth, outerControlStack = controlStack;
    if (dialogSet.has(e)) { controlDepth = 0; controlStack = []; }
    var prio = prioRootSet.has(e);
    var pop = TRACK && popupSet.has(e);
    if (pop) popDepth++;
    if (prio && prioDepth++ === 0) push(PRIO_ON);
    var isControl = markerOf.has(e);
    var isHeading = /^H[1-6]$/.test(e.tagName) || roleOf(e) === 'heading';
    if (isControl) { controlDepth++; if (!COMPACT) controlStack.push(markerOf.get(e)); }
    if (isHeading) headingDepth++;
    walkElement(e, depth);
    if (isControl) { controlDepth--; if (!COMPACT) controlStack.pop(); }
    if (isHeading) headingDepth--;
    if (prio && --prioDepth === 0) push(PRIO_OFF);
    if (pop) popDepth--;
    if (dialogSet.has(e)) { controlDepth = outerControlDepth; controlStack = outerControlStack; }
    // A landmark section ends with its element; a heading section runs on to the next heading.
    if ((enter !== undefined && secBy === 'landmarks') || contentRootSet.has(e)) curSec = outer;
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
    // A field the agent typed into: never its content as page text (with a marker it is described below).
    if (!mark && typedFields.has(e)) return;

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

    if (mark && (typedFields.has(e) || isTextField(e) || e.tagName === 'SELECT' || e.tagName === 'INPUT')) {
      // Form controls have no useful child text; describe them instead.
      var kindName = typedFields.has(e) || isTextField(e) ? '输入框' : (e.tagName === 'SELECT' ? '下拉框' : '控件');
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

  /* --- complete control descriptions ----------------------------------- */

  function selectOptionsLine(sel) {
    var opts = sel.options ? Array.prototype.slice.call(sel.options) : [];
    var total = opts.length;
    if (!total) return '    选项：（没有选项）';
    var shown = Math.min(total, SELECT_LIST_MAX);
    var out = [];
    var lastGroup = null;
    // Full and query reads give option text whole; compact cuts it at 40 characters.
    function optText(o) { return MODE === 'full' || MODE === 'query' ? normText(o.text) : clip(normText(o.text), 40); }
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
  for (var ci = 0; ci < candidates.length; ci++) {
    var r = candidates[ci], kx = markerOf.get(r);
    // Controls inside a field the agent typed into (rich-text editors) would print its content.
    if (insideTyped(r)) continue;
    var txt = labelFor(r), fullLabel = txt, labelEnd = cutAt(txt, 60);
    if (labelEnd < txt.length) txt = txt.slice(0, labelEnd) + '…';
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
    var typedId = typedFields.get(r);
    if (typedId) { line += '\u0003' + typedId + '\u0003'; typedNow[typedId] = fieldValue(r); }
    var isPrio = front || inside(r, prioRootSet) || r.getAttribute('aria-expanded') === 'true';
    entries.push({ line: line, label: fullLabel, labelEnd: labelEnd, front: front, prio: isPrio, n: kx, el: r,
      pop: TRACK && inside(r, popupSet), typed: !!typedId });
  }
  if (modal) {
    // The modal's own elements first; numbers stay as they are.
    entries = entries.filter(function (x) { return x.front; })
      .concat(entries.filter(function (x) { return !x.front; }));
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

  var feedbackBlocks = null;
  var documentKey = COMPACT ? window.__chromeBridgeReadDocument : undefined;
  if (COMPACT && !documentKey) documentKey = window.__chromeBridgeReadDocument = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  function result(text, hint) {
    return JSON.stringify({
      ok: true,
      mode: MODE,
      visibility: document.visibilityState,
      opaque: opaqueShare(),
      url: location.href,
      title: document.title,
      count: candidates.length,
      text: text,
      hint: hint,
      documentKey: documentKey,
      blocks: feedbackBlocks,
      typed: typedNow,
      outline: secs.slice(0, 300).map(function (x) {
        return { id: x.publicId, title: x.title, depth: x.depth,
          parent: x.parent < 0 ? -1 : secs[x.parent].publicId,
          last: secs[x.last].publicId, tok: x.tok, clk: x.clk, scr: x.scr };
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

  // Full/query place each complete control description at its position in the
  // text, instead of repeating its marker in a trailing index. Nested controls
  // keep their own units; aria labels and select options remain attached.
  function explicitUnits() {
    var byMarker = new Map(entries.map(function (e) { return [e.n, e]; }));
    var seen = new Set(), out = [], prio = false;
    function control(e) {
      if (seen.has(e.n)) return;
      seen.add(e.n);
      out.push({ t: '\n' + e.line + '\n', prio: e.prio, entry: e,
        sec: TRACK ? (e.front ? -1 : secOfMarker(e.el)) : 0 });
      // Keep long public control text reachable in full mode without repeating
      // its marker or its first part: the line ends with … at a word boundary
      // and the rest follows on the next line after 「（续）」 (the line part
      // without … and the rest are the label). Query uses the complete label.
      if (MODE === 'full' && e.labelEnd < e.label.length) {
        out.push({ t: '（续）' + e.label.slice(e.labelEnd) + '\n', prio: e.prio, sec: 0 });
      }
    }
    for (var p = 0; p < parts.length; p++) {
      if (parts[p] === PRIO_ON) { prio = true; continue; }
      if (parts[p] === PRIO_OFF) { prio = false; continue; }
      var owner = partOwner[p];
      if (owner) { var e = byMarker.get(owner); if (e) control(e); continue; }
      var last = out[out.length - 1], sec = TRACK ? partSec[p] : 0;
      if (last && !last.entry && last.prio === prio && last.sec === sec) last.t += parts[p];
      else out.push({ t: parts[p], prio: prio, sec: sec });
    }
    // A visible candidate can live in a zero-box wrapper the text walk skipped.
    entries.forEach(control);
    return out;
  }

  /* --- full mode: bounded text with one complete inline control unit ----- */

  if (MODE === 'full') {
    var units = explicitUnits(), kept = new Set(), controlSize = 0;
    for (var pass = 0; pass < 2; pass++) {
      for (var ei = 0; ei < entries.length; ei++) {
        var en = entries[ei];
        if (en.prio !== (pass === 0) || controlSize + en.line.length + 2 > CONTROL_CAP) continue;
        kept.add(en.n); controlSize += en.line.length + 2;
      }
    }
    var budget = Math.max(0, MAX_OUT - warn.length - header.length - controlSize - 200 - 3 * (kept.size + 2));
    var prioSize = units.filter(function (u) { return !u.entry && u.prio; }).reduce(function (n, u) { return n + u.t.length; }, 0);
    var prioLeft = Math.min(prioSize, budget), restLeft = Math.max(0, budget - prioSize);
    var body = [], cut = false, gap = false;
    units.forEach(function (u) {
      var text = '';
      if (u.entry) {
        if (kept.has(u.entry.n)) text = u.t;
        else { cut = true; gap = true; }
      } else {
        var room = u.prio ? prioLeft : restLeft;
        // Out of room: stop at a word boundary; the gap mark and the note below say the rest was cut.
        text = u.t.slice(0, room >= u.t.length ? room : cutAt(u.t, room));
        if (u.prio) prioLeft -= text.length; else restLeft -= text.length;
      }
      if (text) { if (gap) { body.push('\n…\n'); gap = false; } body.push(text); }
      if (!u.entry && /\S/.test(u.t.slice(text.length))) { cut = true; gap = true; }
    });
    var omitted = entries.length - kept.size;
    var truncNote = !cut ? '' : '\n\n…（正文过长已截断' + (omitted ? '；另有 ' + omitted + ' 个控件未列出' : '') + '）';
    return result(warn + header + body.join('').replace(/\n{3,}/g, '\n\n').trim() + truncNote, '');
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
  for (i = 0; i < secs.length; i++) secs[i].all = null;

  function listed(x) { return !(x.id === 0 && x.tok === 0 && x.clk === 0); }
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
    var id = mm ? publicSections.get(parseInt(mm[1], 10)) : undefined;
    return id !== undefined && (listed(secs[id]) || (id === 0 && secBy === 'none')) ? id : -1;
  }
  var warnOther = modal
    ? '⚠️ 页面开着弹窗「' + modalTitle + '」：背景元素被它挡住，先处理弹窗。\n'
    : '';

  /* Default: top-level headings only. Explicit sections open one layer.
     Expansion state is private to this reader, held only in this document.
     The server receives stable blocks and decides which changed lines fit its budget. */
  if (COMPACT) {
    var readers = window.__chromeBridgeReaders;
    if (!(readers instanceof Map)) readers = window.__chromeBridgeReaders = new Map();
    var reader = String(REQ.reader || 'default');
    var state = readers.get(reader);
    if (!state || state.version !== 2 || REQ.refresh === true || state.url !== location.href) {
      state = { version: 2, url: location.href, expanded: new Set() };
    }
    state.expanded.forEach(function (id) { if (!publicSections.has(id)) state.expanded.delete(id); });
    readers.delete(reader);
    readers.set(reader, state);
    while (readers.size > 64) readers.delete(readers.keys().next().value);
    var unknown = [];
    if (REQ.sections) [].concat(REQ.sections).forEach(function (raw) {
      var id = sectionId(raw);
      if (id < 0) unknown.push(String(raw)); else state.expanded.add(secs[id].publicId);
    });
    var visible = new Set();
    if (secBy === 'none') {
      secs[0].title = normText(document.title) || 'Page';
      visible.add(0);
    } else {
      var hasContentHeading = secs.some(function (s) { return s.content; });
      secs.forEach(function (s) { if (s.id > 0 && s.parent === -1 && (!hasContentHeading || s.content)) visible.add(s.id); });
    }
    state.expanded.forEach(function (publicId) {
      var id = publicSections.get(publicId);
      visible.add(id);
      secs[id].kids.forEach(function (kid) { visible.add(kid); });
    });
    feedbackBlocks = [];
    function plainLines(id, popup) {
      var out = [];
      for (var p = 0; p < parts.length; p++) {
        if ((popup ? partPop[p] && partSec[p] !== -1 : partSec[p] === id && !partPop[p]) && !partControl[p] && !partHeading[p]) out.push(parts[p]);
      }
      return tidy(out.join('')).replace(/[\u0001\u0002]/g, '').trim().split('\n').filter(function (s) { return s.trim(); });
    }
    function controls(id) {
      return entries.filter(function (e) { return id === -1 ? e.front : !e.front && !e.pop && secOfMarker(e.el) === id; });
    }
    function feedbackBlock(id, title, lines, items) {
      var targets = {};
      items.forEach(function (e, index) { targets[lines.length + index] = '[' + e.n + '] ' + e.el.tagName.toLowerCase(); });
      return { id: id, title: title, lines: lines.concat(items.map(function (e) { return e.line; })), lineTargets: targets };
    }
    // A persistent nonmodal dialog is automatic compact content too. Bound
    // each automatic layer before feedback caching; reserve whole marker lines
    // before prose so truncation cannot detach a target from its description.
    function layerBlock(id, title, lines, items) {
      var limit = 6000, note = '… Layer content truncated; use read_page query for more.';
      var room = limit - note.length - 2, itemSize = 0, kept = [], prose = [], cut = false;
      items.forEach(function (e) {
        if (itemSize + e.line.length + 1 <= CONTROL_CAP) { kept.push(e); itemSize += e.line.length + 1; }
        else cut = true;
      });
      room -= itemSize;
      lines.forEach(function (line) {
        if (room <= 1) { cut = true; return; }
        var text = line.slice(0, room - 1);
        prose.push(text); room -= text.length + 1;
        if (text.length < line.length) cut = true;
      });
      var block = feedbackBlock(id, title, prose, kept);
      if (cut) block.lines.push(note);
      return block;
    }
    if (modal) {
      var ml = plainLines(-1).filter(function (s) { return !/^--- 弹窗/.test(s); });
      feedbackBlocks.push(layerBlock('modal', 'Dialog: ' + modalTitle, ['Dialog: ' + modalTitle].concat(ml), controls(-1)));
    }
    var popupEntries = entries.filter(function (e) { return e.pop && !e.front; });
    if (popupEntries.length || dialogRoots.some(function (x) { return !inside(x, frontSet); })) feedbackBlocks.push(layerBlock('popup', 'Expanded popup',
      ['Expanded popup'].concat(plainLines(null, true)), popupEntries));
    Array.from(visible).sort(function (a, b) { return a - b; }).forEach(function (id) {
      var x = secs[id], expanded = state.expanded.has(x.publicId);
      var title = 'S' + x.publicId + ' ' + x.title;
      var line = title + (expanded ? '' : ' [collapsed]');
      if (x.kids.length) line += ' (' + x.kids.length + ' sections)';
      var lines = [line];
      if (expanded) lines = lines.concat(plainLines(id));
      feedbackBlocks.push(feedbackBlock('S' + x.publicId, title, lines, expanded ? controls(id) : []));
    });
    if (unknown.length) feedbackBlocks.push({ id: 'unknown', title: 'Unknown sections',
      lines: ['Unknown sections: ' + unknown.join(', ') + '; IDs may be stale. Read again with refresh: true for the current sections.'] });
    var compactText = feedbackBlocks.map(function (b) { return b.lines.join('\n'); }).join('\n\n');
    return result(header + compactText, '');
  }

  /* --- query: the blocks and elements that contain it --------------------- */

  var qShown = normText(REQ.query);
  var qq = qShown.toLowerCase();
  var scope = null;   // section ids to search; null = the whole page (and an open modal)
  var scopeNote = '';
  if (REQ.sections && [].concat(REQ.sections).length) {
    scope = new Set();
    var unknownScope = [];
    [].concat(REQ.sections).forEach(function (raw) {
      var id = sectionId(raw);
      if (id < 0) unknownScope.push(String(raw));
      else for (var q = id; q <= secs[id].last; q++) scope.add(q);
    });
    if (unknownScope.length) {
      return result(header + 'Unknown sections: ' + unknownScope.join(', ') +
        '; IDs may be stale. Read again with refresh: true for the current sections. No search was performed.', '');
    }
  }
  var groups = [];
  var groupOf = {};
  if (modal && !scope) groups.push(groupOf[-1] = { id: -1, label: '弹窗「' + modalTitle + '」' });
  for (i = 0; i < secs.length; i++) {
    if (scope && !scope.has(i)) continue;
    groups.push(groupOf[i] = { id: i, label: secBy === 'none' ? '页面' : 'S' + secs[i].publicId + ' ' + secs[i].title });
  }
  for (i = 0; i < groups.length; i++) groups[i].order = i;
  var bySec = {};
  explicitUnits().forEach(function (u) { (bySec[u.sec] || (bySec[u.sec] = [])).push(u); });

  // At most 300 characters around the match; both ends at word boundaries.
  function snippet(l) {
    if (l.length <= 300) return l;
    var p = l.toLowerCase().indexOf(qq);
    var a0 = Math.max(0, p - 120);
    while (a0 > 0 && a0 < p && wordChar(l.charAt(a0 - 1)) && wordChar(l.charAt(a0))) a0++;
    var rest = l.slice(a0), b0 = cutAt(rest, 300);
    return (a0 > 0 ? '…' : '') + rest.slice(0, b0) + (b0 < rest.length ? '…' : '');
  }
  // A matching label: whole up to 1000 characters; a longer one around the match, marked where it goes on.
  function labelSnippet(l) {
    if (l.length <= 1000) return l;
    var p = Math.max(0, l.toLowerCase().indexOf(qq));
    var a0 = Math.max(0, p - 300);
    while (a0 > 0 && a0 < p && wordChar(l.charAt(a0 - 1)) && wordChar(l.charAt(a0))) a0++;
    while (a0 > 0 && a0 < p && /\s/.test(l.charAt(a0))) a0++;
    var rest = l.slice(a0), b0 = cutAt(rest, 1000);
    return (a0 > 0 ? '（前略）' : '') + rest.slice(0, b0).replace(/\s+$/, '') + (b0 < rest.length ? '…（后略，共 ' + l.length + ' 字）' : '');
  }
  var hits = [], total = 0, hitMarkers = new Set();
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    (bySec[group.id] || []).forEach(function (u) {
      if (u.entry) {
        var labelHit = u.entry.label.toLowerCase().indexOf(qq) !== -1;
        var lineHit = u.entry.line.toLowerCase().indexOf(qq) !== -1;
        if (!labelHit && !lineHit) return;
        var text = u.entry.line;
        // A label cut in its line is given whole below it.
        if (u.entry.labelEnd < u.entry.label.length) text += '\n  ' + labelSnippet(u.entry.label);
        hits.push({ g: group, t: text, el: true }); total++; hitMarkers.add(u.entry.n);
      } else {
        tidy(u.t).split('\n').forEach(function (line) {
          var text = line.trim();
          if (!text || text.toLowerCase().indexOf(qq) === -1) return;
          hits.push({ g: group, t: snippet(text) }); total++;
        });
      }
    });
  }

  var qLines = [], shownHits = 0, usedQ = 0, lastG = null;
  for (i = 0; i < hits.length && shownHits < QUERY_HITS; i++) {
    var hh = hits[i];
    if (usedQ + hh.t.length > QUERY_MAX) break;
    if (hh.g !== lastG) { qLines.push(hh.g.label + '：'); lastG = hh.g; }
    qLines.push((hh.el ? '' : '  ') + hh.t);
    usedQ += hh.t.length + hh.g.label.length + 4;
    shownHits++;
  }
  var qHead = '=== 查找「' + qShown + '」（不区分大小写' + (scope ? '，只在指定的节里' : '') + '）：' +
    (total ? '找到 ' + total + ' 处' : '没有找到') + ' ===\n';
  var qBody = total
    ? qLines.join('\n') +
      (total > shownHits ? '\n…（另有 ' + (total - shownHits) + ' 处没列出）' : '')
    : '（查了' + (scope ? '指定的节' : '整页') + '的正文和元素的文字，都没有「' + qShown + '」）';
  // Text inside input fields is not searched: fields the agent typed into say here whether they still hold it.
  var typedRest = entries.filter(function (e) { return e.typed && !hitMarkers.has(e.n); });
  if (typedRest.length) {
    qBody += '\n输入框里的文字不在查找范围；agent 输入过的框：\n' + typedRest.map(function (e) { return e.line; }).join('\n');
  }
  return result(warnOther + header + '\n' + scopeNote + qHead + qBody, '');
})()
