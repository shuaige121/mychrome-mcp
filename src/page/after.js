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
               typing would empty.
               {check, record: true} (type_text's last confirmation, for
               read_page's typed-text check): `typedField` = {id, value, ...}.
               A password or a field the user filled for the agent (isPrivate)
               is decided first, on attributes: its content is not read, it
               gets no id, and an earlier id comes back with value null.
               Otherwise id is a random one this field element keeps in the
               isolated world (window.__chromeBridgeTyped, read by
               src/page/read.js) together with its fingerprint; value is the
               field's content only when the typing is confirmed and it is
               exactly what the typing should have produced, else null.
   __FILES__   upload_file only (absent elsewhere): the ONE file input bound to
               marker __MARKER__, by file NAME only; never a file's contents,
               another input or another file's name.
               {arm: token, name}: bind the input (the marker itself; the
               file input a <label> controls; the single file input inside
               the marker or its open shadow root; else the single one in the
               nearest ancestor below <body>, up to 4 levels), refuse private
               fields (isPrivate) before reading anything, and put one capture
               listener on that input (isolated world, like ack.js): trusted
               change events then holding exactly `name` (changed), other
               files (other), or none (cleared). Baseline: the input holds
               `name`. {check: token, name, disarm?}: fileChanged,
               otherChanged, cleared, fileHeld (holds `name` now, not at arm).
               No page text is read: only that input's file names. */
(function () {
  var N = __MARKER__;
  var EXPECT = __EXPECT__;
  var BIND = __BIND__;
  var FILES = typeof __FILES__ === 'undefined' ? null : __FILES__;

  if (FILES) {
    var isFile = function (e) { return !!e && e.tagName === 'INPUT' && String(e.type).toLowerCase() === 'file'; };
    var holds = function (input, name) {
      try {
        var f = input.files;
        for (var i = 0; f && i < f.length; i++) if (f[i] && f[i].name === name) return true;
      } catch (e) {}
      return false;
    };
    // File inputs under one element, its open shadow roots included (bounded).
    var inputsUnder = function (root) {
      var out = [], seen = 0;
      (function walk(r, depth) {
        var list = r.querySelectorAll('input[type=file]');
        for (var i = 0; i < list.length && out.length < 8; i++) out.push(list[i]);
        if (depth >= 3) return;
        if (r.shadowRoot) walk(r.shadowRoot, depth + 1);
        var all = r.querySelectorAll('*');
        for (var j = 0; j < all.length && seen < 5000; j++, seen++) if (all[j].shadowRoot) walk(all[j].shadowRoot, depth + 1);
      })(root, 0);
      return out;
    };
    var fname = String(FILES.name || '');
    var cur = window.__chromeBridgeFiles;
    var off = function (st) { if (st && st.handler && st.input) st.input.removeEventListener('change', st.handler, true); };
    if (FILES.arm) {
      off(cur); window.__chromeBridgeFiles = null;
      var reg = window.__chromeBridge;
      var el = N !== null && reg && reg.markers && reg.url === location.href ? reg.markers[N] : null;
      if (!el || !el.isConnected) return JSON.stringify({ ok: true, armed: false, bound: false, reason: 'stale' });
      var input = null, how = '';
      if (isFile(el)) { input = el; how = 'input'; }
      else if (el.tagName === 'LABEL' && isFile(el.control)) { input = el.control; how = 'label'; }
      else {
        var inside = inputsUnder(el);
        if (inside.length === 1) { input = inside[0]; how = 'contains'; }
        else if (!inside.length) {
          for (var up = el.parentElement, k = 0; up && k < 4 && up !== document.body && up !== document.documentElement; up = up.parentElement, k++) {
            var near = inputsUnder(up);
            if (near.length === 1) { input = near[0]; how = 'container'; }
            if (near.length) break;
          }
        }
      }
      if (!input) return JSON.stringify({ ok: true, armed: false, bound: false, reason: 'unbound' });
      for (var a = input; a; a = a.parentElement) if (isPrivate(a)) return JSON.stringify({ ok: true, armed: false, bound: false, reason: 'private' });
      if (isPrivate(el)) return JSON.stringify({ ok: true, armed: false, bound: false, reason: 'private' });
      var st = { token: FILES.arm, name: fname, input: input, changed: 0, other: 0, cleared: 0,
        held: holds(input, fname), handler: null };
      st.handler = function (e) {
        if (!e.isTrusted || e.target !== st.input) return;
        if (holds(st.input, st.name)) st.changed++;
        else if (st.input.files && st.input.files.length) st.other++;
        else st.cleared++;
      };
      input.addEventListener('change', st.handler, true);
      window.__chromeBridgeFiles = st;
      return JSON.stringify({ ok: true, armed: true, bound: true, binding: how });
    }
    var mine = !!cur && !!cur.handler && cur.token === FILES.check && cur.name === fname;
    var state = { ok: true, armed: mine, bound: mine,
      fileChanged: mine && cur.changed > 0, otherChanged: mine && cur.other > 0,
      cleared: mine && cur.cleared > 0,
      fileHeld: mine && cur.input.isConnected && holds(cur.input, fname) && !cur.held };
    if (mine && FILES.disarm) { off(cur); window.__chromeBridgeFiles = null; }
    return JSON.stringify(state);
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

  /* read_page's typed-text records (see BIND above), this world only. fields: element → {id, fp, form};
     fp is the field's fingerprint (tag, type, name, id, page URL; the owning form is compared as an
     element); live holds the recorded elements so that a node removed from the document (also when it
     comes back later) loses its record: the observer drops it, and src/page/read.js flushes pending
     removals through `sweep` before it reads. */
  function fieldPrint(el) {
    return [el.tagName, String(el.getAttribute('type') || '').toLowerCase(), el.getAttribute('name') || '', el.id || '', location.href].join('\u0001');
  }
  function typedRegistry() {
    var reg = window.__chromeBridgeTyped;
    if (reg && reg.fields instanceof WeakMap && reg.live instanceof Set) return reg;
    reg = window.__chromeBridgeTyped = { fields: new WeakMap(), live: new Set(), observer: null, sweep: null };
    reg.sweep = function (records) {
      if (!records || !reg.live.size) return;
      for (var i = 0; i < records.length; i++) {
        var gone = records[i].removedNodes;
        for (var j = 0; gone && j < gone.length; j++) {
          var n = gone[j];
          if (!n || n.nodeType !== 1) continue;
          reg.live.forEach(function (f) { if (n === f || n.contains(f)) { reg.live.delete(f); reg.fields.delete(f); } });
        }
      }
    };
    try {
      reg.observer = new MutationObserver(reg.sweep);
      reg.observer.observe(document, { childList: true, subtree: true });
    } catch (e) { reg.observer = null; }
    return reg;
  }

  function describe(el) {
    if (!el || !el.tagName) return null;
    var t = '';
    try {
      var typing = window.__chromeBridgeType;
      var pw = String(el.type || '').toLowerCase() === 'password' || isPrivate(el) ||
        (BIND && typing && typing.strict && typing.el === el);
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
      if (editable(el) && tag !== 'input' && tag !== 'textarea') {
        var s = window.getSelection();
        if (!s || s.rangeCount !== 1 || !el.contains(s.anchorNode) || !el.contains(s.focusNode)) return null;
        var r = s.getRangeAt(0), head = document.createRange(), tail = document.createRange();
        head.selectNodeContents(el); head.setEnd(r.startContainer, r.startOffset);
        tail.selectNodeContents(el); tail.setEnd(r.endContainer, r.endOffset);
        return { start: head.toString().length, end: tail.toString().length,
          full: head.toString().length === 0 && tail.toString() === String(el.textContent || ''),
          atEnd: s.isCollapsed && tail.toString() === String(el.textContent || '') };
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
      ? { el: ae, token: BIND.set, strict: BIND.strict === true,
          base: { text: fieldText(ae), sel: selection(ae), strict: BIND.strict === true } } : null;
    bound = !!window.__chromeBridgeType;
  }
  var field = ae, focusMoved = false, base = null;
  if (BIND && BIND.check) {
    var tb = window.__chromeBridgeType;
    var same = false;
    try {
      same = !!tb && tb.token === BIND.check && !!tb.el && tb.el.isConnected && hasFocus &&
             !!ae && (ae === tb.el || (!tb.strict && tb.el.contains(ae)));
    } catch (e) {}
    if (!same) { field = null; focusMoved = true; }
    else { field = tb.el; base = tb.base || null; }
  }

  var nowSelection = field ? selection(field) : null;
  var bindingMatches = !!base && !!field && editable(field);
  var selectionAll = false;
  if (BIND && BIND.selectAll && bindingMatches && nowSelection && fieldText(field) === base.text) {
    selectionAll = nowSelection.full === true || (nowSelection.start === 0 && nowSelection.end === base.text.length);
    if (selectionAll) {
      base.sel = { start: 0, end: base.text.length };
      base.replace = true;
    }
  }
  var selectionStable = bindingMatches && fieldText(field) === base.text &&
    ((!base.sel && !nowSelection) || (!!base.sel && !!nowSelection &&
      (base.replace ? selectionAll || nowSelection.full === true ||
        (nowSelection.start === 0 && nowSelection.end === base.text.length)
        : base.sel.start === nowSelection.start && base.sel.end === nowSelection.end)));
  var fieldHasText = null, changed = null, confirmedChars = 0;
  if (EXPECT !== null) {
    try {
      if (!field || !editable(field)) fieldHasText = false;
      else if (!base) fieldHasText = norm(fieldText(field)).indexOf(norm(EXPECT)) !== -1;
      else {
        var now = fieldText(field), want = norm(EXPECT), sent = String(EXPECT);
        changed = now !== base.text;
        if (base.strict && base.sel) {
          var canonical = function (s) { return String(s).replace(/\r\n?/g, '\n'); };
          var expected = base.replace ? sent : base.text.slice(0, base.sel.start) + sent + base.text.slice(base.sel.end);
          var caret = !!nowSelection && nowSelection.start === nowSelection.end &&
            (base.replace && nowSelection.atEnd === true || nowSelection.start === base.sel.start + sent.length);
          var replaced = base.sel.end > base.sel.start && caret;
          fieldHasText = canonical(now) === canonical(expected) && caret && (changed || replaced);
        } else if (!want) {
          // Whitespace only: the field must have grown by at least what was sent.
          fieldHasText = changed && now.length - base.text.length >= sent.length;
        } else {
          var more = occurrences(norm(now), want) > occurrences(norm(base.text), want);
          var atCaret = !!base.sel && norm(now.slice(base.sel.start, base.sel.start + sent.length)) === want;
          fieldHasText = changed && (more || atCaret);
        }
      }
      if (fieldHasText) confirmedChars = Array.from(String(EXPECT)).length;
    } catch (e) { fieldHasText = false; }
  }

  // PERM1 (ruling 4): type_text's probe never types into a password, one-time-code, payment or private field. Decided
  // on the field's attributes only (type, autocomplete, name/id/aria-label, masking, isPrivate), never its content;
  // only a boolean leaves. A read that throws counts as sensitive.
  var fieldSensitive = false;
  try {
    var sf = field || ae;
    if (sf && sf.getAttribute) {
      var ac = String(sf.getAttribute('autocomplete') || '').toLowerCase();
      var named = [sf.getAttribute('name'), sf.id, sf.getAttribute('aria-label')].join(' ').toLowerCase();
      var masked = false;
      try { var cs = window.getComputedStyle(sf); masked = !!cs && !!cs.webkitTextSecurity && cs.webkitTextSecurity !== 'none'; } catch (e) {}
      fieldSensitive = String(sf.getAttribute('type') || '').toLowerCase() === 'password' || masked ||
        /(^|\s)(one-time-code|current-password|new-password|cc-[a-z-]+)(\s|$)/.test(ac) ||
        /(^|[^a-z])(otp|one[-_ ]?time|passcode|password|passwd|pin|cvv|cvc|csc)([^a-z]|$)|card[-_ ]?num|cc[-_]?num/.test(named);
      for (var pp = sf; pp && !fieldSensitive; pp = pp.parentElement) fieldSensitive = isPrivate(pp);
    }
  } catch (e) { fieldSensitive = true; }

  var typedField = null;
  if (BIND && BIND.record && EXPECT !== null && field && base) {
    try {
      var reg = typedRegistry();
      var known = reg.fields.get(field) || null;
      // Privacy first: a password or a field the user filled for the agent is decided on attributes only,
      // and its content is not read here; an earlier record of it is dropped.
      var secret = String(field.getAttribute('type') || '').toLowerCase() === 'password';
      for (var pa = field; pa && !secret; pa = pa.parentElement) secret = isPrivate(pa);
      if (secret) {
        if (known) { reg.fields.delete(field); reg.live.delete(field); typedField = { id: known.id, value: null }; }
      } else {
        var fp = fieldPrint(field), form = field.form || null;
        // The same node now stands for another field: a new record.
        if (known && (known.fp !== fp || known.form !== form)) { reg.fields.delete(field); reg.live.delete(field); known = null; }
        if (!known && fieldHasText && field.isConnected) {
          known = { id: 'f' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36), fp: fp, form: form };
          reg.fields.set(field, known);
          reg.live.add(field);
          while (reg.live.size > 64) { var oldest = reg.live.values().next().value; reg.live.delete(oldest); reg.fields.delete(oldest); }
        }
        if (known) {
          // What the field must hold now: the typed text alone (replace, or an empty field), or the
          // text typed at the baseline caret / over its selection.
          var canon = function (s) { return String(s).replace(/\r\n?/g, '\n'); };
          var sentText = String(EXPECT), want = null;
          if (base.replace) want = sentText;
          else if (base.sel) want = base.text.slice(0, base.sel.start) + sentText + base.text.slice(base.sel.end);
          else if (base.text === '') want = sentText;
          var holds = fieldHasText && want !== null ? canon(fieldText(field)) : null;
          var exact = holds !== null && holds === canon(want);
          typedField = { id: known.id, value: exact ? holds : null, replace: base.replace === true,
            at: exact && !base.replace && base.sel ? base.sel.start : null,
            cut: exact && !base.replace && base.sel ? base.sel.end - base.sel.start : null };
        }
      }
    } catch (e) { typedField = null; }
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
    confirmedChars: confirmedChars,
    bindingMatches: bindingMatches,
    selectionAll: selectionAll,
    selectionStable: selectionStable,
    changed: changed,
    bound: bound,
    focusMoved: focusMoved,
    fieldSensitive: fieldSensitive,
    typedField: typedField,
    targetStillHere: !!(el && el.isConnected)
  });
})()
