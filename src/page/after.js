/* Injected after a click, and by type_text before and after typing. Read-only.
   Reports location.href, whether the document has keyboard focus, and what
   document.activeElement is, so the tool says what it actually observed
   instead of assuming the input worked.

   __MARKER__  the target marker, or null
   __EXPECT__  text that should now be in the focused field, or null. Only a
               yes/no comes back (fieldHasText), never the field's content.
   __BIND__    null, {set: token} or {check: token}. `set` remembers the focused
               editable field in the isolated world (window.__chromeBridgeType,
               invisible to the page, F1) with its content and selection at
               that moment (the baseline); `check` computes fieldHasText only
               for that field, while it still has focus in a focused document,
               so another field holding the same text cannot confirm typing
               (review codex1-6), and only when the field CHANGED since the
               baseline and now holds the text once more than it did (or at
               the old caret), so text that was already there, or a
               whitespace-only text, cannot confirm input that never arrived
               (codex2-8). `changed` says whether the content moved at all.
               Not tied to the marker registry, which a pushState during
               typing would empty. */
(function () {
  var N = __MARKER__;
  var EXPECT = __EXPECT__;
  var BIND = __BIND__;

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

  function describe(el) {
    if (!el || !el.tagName) return null;
    var t = '';
    try {
      var pw = String(el.type || '').toLowerCase() === 'password' || isPrivate(el);
      t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) ||
          (pw ? '' : (el.value || el.innerText || el.textContent)) || '';
    } catch (e) {}
    return {
      tag: String(el.tagName).toLowerCase(),
      id: el.id || '',
      text: String(t).replace(/\s+/g, ' ').trim().slice(0, 60)
    };
  }

  var TEXT_INPUTS = { '': 1, text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1 };
  function editable(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return !el.disabled && !el.readOnly;
    if (tag === 'input') {
      return !el.disabled && !el.readOnly && !!TEXT_INPUTS[String(el.getAttribute('type') || '').toLowerCase()];
    }
    if (el.isContentEditable) return true;
    var ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
    return ce !== null && /^(|true|plaintext-only)$/i.test(ce);
  }
  function fieldText(el) {
    if (!el) return '';
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return String(el.value || '');
    return String(el.innerText || el.textContent || '');
  }
  // Line breaks, tabs, runs of spaces and &nbsp; differ between what was
  // sent and what a field keeps; compare the words.
  function norm(s) {
    return String(s).replace(/\r\n?/g, '\n').replace(/[\s ]+/g, ' ').trim();
  }
  function occurrences(hay, needle) {
    return needle ? hay.split(needle).length - 1 : 0;
  }
  function selection(el) {
    try {
      var tag = String(el.tagName || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea') && typeof el.selectionStart === 'number') {
        return { start: el.selectionStart, end: el.selectionEnd };
      }
    } catch (e) {}
    return null;
  }

  var ae = null;
  try { ae = document.activeElement; } catch (e) {}
  if (ae === document.body || ae === document.documentElement) ae = null;

  // The marker registry is keyed to the URL it was built on, so after a
  // navigation there is deliberately nothing to compare against — which is
  // fine, because a navigation is itself the observable effect.
  var reg = window.__chromeBridge;
  var el = (N !== null && reg && reg.markers && reg.url === location.href) ? reg.markers[N] : null;

  var activeIsTarget = false;
  try {
    if (el && ae) activeIsTarget = (ae === el) || el.contains(ae) || (!!el.control && el.control === ae);
  } catch (e) {}

  var hasFocus = false;
  try { hasFocus = document.hasFocus(); } catch (e) {}

  var bound = null;
  if (BIND && BIND.set) {
    window.__chromeBridgeType = (ae && editable(ae))
      ? { el: ae, token: BIND.set, base: { text: fieldText(ae), sel: selection(ae) } } : null;
    bound = !!window.__chromeBridgeType;
  }
  var field = ae, focusMoved = false, base = null;
  if (BIND && BIND.check) {
    var tb = window.__chromeBridgeType;
    var same = false;
    try {
      same = !!tb && tb.token === BIND.check && !!tb.el && tb.el.isConnected && hasFocus &&
             !!ae && (ae === tb.el || tb.el.contains(ae));
    } catch (e) {}
    if (!same) { field = null; focusMoved = true; }
    else base = tb.base || null;
  }

  var fieldHasText = null, changed = null;
  if (EXPECT !== null) {
    try {
      if (!field || !editable(field)) fieldHasText = false;
      else if (!base) fieldHasText = norm(fieldText(field)).indexOf(norm(EXPECT)) !== -1;
      else {
        var now = fieldText(field), want = norm(EXPECT), sent = String(EXPECT);
        changed = now !== base.text;
        if (!want) {
          // Whitespace only: the field must have grown by at least what was sent.
          fieldHasText = changed && now.length - base.text.length >= sent.length;
        } else {
          var more = occurrences(norm(now), want) > occurrences(norm(base.text), want);
          var atCaret = !!base.sel && norm(now.slice(base.sel.start, base.sel.start + sent.length)) === want;
          fieldHasText = changed && (more || atCaret);
        }
      }
    } catch (e) { fieldHasText = false; }
  }

  return JSON.stringify({
    ok: true,
    href: location.href,
    title: String(document.title || '').slice(0, 80),
    readyState: document.readyState,
    hasFocus: hasFocus,
    activeElement: describe(ae),
    activeIsTarget: activeIsTarget,
    activeEditable: editable(ae),
    fieldHasText: fieldHasText,
    changed: changed,
    bound: bound,
    focusMoved: focusMoved,
    targetStillHere: !!(el && el.isConnected)
  });
})()
