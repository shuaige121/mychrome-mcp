/* Fixed, read-only page script. The injected request is internal JSON data.
 * The namespaced registry detects stale nodes, but is not an authority boundary.
 * No input values, markup writes, listeners, focus, scroll or clicks. */
(function () {
  'use strict';
  var request = __PROMPT_OBSERVATION__;
  var ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
  function out(value) { return JSON.stringify(value); }
  function fail(reason) { return out({ ok: false, status: 'unavailable', reason: reason }); }
  if (!request || !['observe', 'validate'].includes(request.mode) || !ID.test(request.namespace || '')) return fail('invalid_request');
  function norm(value) {
    return String(value == null ? '' : value).replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').replace(/^ +| +$/g, '');
  }
  function token() {
    var bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  var registryKey = Symbol.for('mychrome.pagePrompt.' + request.namespace), registry;
  try {
    registry = window[registryKey];
    if (!registry || registry.document !== document || registry.timeOrigin !== performance.timeOrigin) {
      if (request.mode === 'validate') return fail('document_changed');
      registry = { document: document, timeOrigin: performance.timeOrigin, documentToken: token(),
        weak: new WeakMap(), strong: new Map() };
      window[registryKey] = registry;
    }
    if (!ID.test(registry.documentToken || '') || !(registry.weak instanceof WeakMap) ||
      !(registry.strong instanceof Map) || registry.strong.size > 64) return fail('registry_unavailable');
  } catch (error) { return fail('registry_unavailable'); }
  var complete = true, styleCache = new Map(), globalBudget = 4096;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, SVG: 1, CANVAS: 1, OBJECT: 1, EMBED: 1 };
  var BLOCK = { P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BR: 1 };
  function attr(el, name) { try { return el.getAttribute(name); } catch (error) { complete = false; return null; } }
  function style(el) {
    if (!styleCache.has(el)) {
      try { styleCache.set(el, window.getComputedStyle(el)); } catch (error) { styleCache.set(el, null); }
    }
    return styleCache.get(el);
  }
  function privateNode(el) {
    var role = attr(el, 'role'), editable = attr(el, 'contenteditable');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (editable !== null && editable !== 'false') ||
      ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role)) return true;
    var p = window.__chromeBridgePrivate;
    try {
      if (p && p.set && p.set.has(el)) return true;
      if (p && Array.isArray(p.like)) for (var i = 0; i < Math.min(p.like.length, 50); i++) {
        var match = p.like[i];
        if (el.tagName === match.tag && (attr(el, 'type') || '').toLowerCase() === match.type &&
          ((match.id && el.id === match.id) || (match.name && attr(el, 'name') === match.name))) return true;
      }
    } catch (error) { return true; }
    return false;
  }
  function field(el) {
    var editable = attr(el, 'contenteditable');
    return (editable !== null && editable !== 'false') ||
      ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(attr(el, 'role')) ||
      el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
      (el.tagName === 'INPUT' && !button(el));
  }
  // A portal/display:contents wrapper can have no box (or an offscreen box)
  // while its fixed descendants are visible. Only subtree-wide boundaries
  // may prune traversal; own geometry is checked for actual candidates.
  function readableSubtree(el) {
    if (!el || !el.isConnected || el.ownerDocument !== document) return false;
    try {
      for (var current = el, depth = 0; current && depth < 64; current = current.parentElement, depth++) {
        var s = style(current);
        if (!s) { complete = false; return false; }
        if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || +s.opacity === 0 ||
          s.contentVisibility === 'hidden' || attr(current, 'hidden') !== null || attr(current, 'aria-hidden') === 'true' ||
          attr(current, 'inert') !== null || privateNode(current)) return false;
      }
      if (current) { complete = false; return false; }
      return true;
    } catch (error) { complete = false; return false; }
  }
  function visible(el) {
    if (!readableSubtree(el)) return false;
    try {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
      var r = el.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
        r.left < window.innerWidth && r.top < window.innerHeight && el.getClientRects().length > 0;
    } catch (error) { complete = false; return false; }
  }
  function prompt(el) {
    var role = attr(el, 'role');
    return (el.tagName === 'DIALOG' && attr(el, 'open') !== null) || role === 'dialog' ||
      role === 'alertdialog' || attr(el, 'aria-modal') === 'true';
  }
  function button(el) {
    return el.tagName === 'BUTTON' || attr(el, 'role') === 'button' ||
      (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes((attr(el, 'type') || '').toLowerCase()));
  }
  function walk(root, visit, budget) {
    var node = root, count = 0;
    while (node && count++ < budget) {
      var descend = visit(node) !== false;
      if (descend && node.firstChild) { node = node.firstChild; continue; }
      while (node && node !== root && !node.nextSibling) node = node.parentNode;
      if (!node || node === root) return true;
      node = node.nextSibling;
    }
    return !node;
  }
  var candidates = [];
  if (!document.documentElement || !walk(document.documentElement, function (node) {
    if (node.nodeType !== 1) return false;
    if (SKIP[node.tagName] || !readableSubtree(node)) return false;
    if (node.tagName === 'IFRAME' || node.shadowRoot) { complete = false; return false; }
    if (prompt(node) && visible(node)) {
      if (candidates.length < 8) candidates.push(node); else { complete = false; return false; }
    }
    return true;
  }, globalBudget)) complete = false;
  // A root and its nested modal cannot both authorize an automatic action.
  for (var ca = 0; ca < candidates.length; ca++) for (var cb = ca + 1; cb < candidates.length; cb++)
    if (candidates[ca].contains(candidates[cb]) || candidates[cb].contains(candidates[ca])) complete = false;
  var seen = new Set(candidates);
  registry.strong.forEach(function (node, nodeToken) {
    if (!node.isConnected || (complete && !seen.has(node))) { registry.strong.delete(nodeToken); registry.weak.delete(node); }
  });
  function identify(el) {
    var value = registry.weak.get(el);
    if (!value || registry.strong.get(value) !== el) {
      if (registry.strong.size >= 64) return null;
      value = token(); registry.weak.set(el, value); registry.strong.set(value, el);
    }
    return { kind: 'dom', documentToken: registry.documentToken, nodeToken: value };
  }
  function inspect(el) {
    var localComplete = true, hasField = false, buttons = [], headings = [], nodes = 0;
    if (!walk(el, function (node) {
      if (++nodes > 512) { localComplete = false; return false; }
      if (node.nodeType !== 1) return false;
      if (SKIP[node.tagName]) return false;
      if (node.tagName === 'IFRAME' || node.shadowRoot) { localComplete = false; return false; }
      if (field(node) || privateNode(node)) { hasField = true; return false; }
      if (!readableSubtree(node)) return false;
      var ownVisible = visible(node);
      if (node !== el && prompt(node) && ownVisible) { localComplete = false; return false; }
      if (button(node) && ownVisible) { if (buttons.length < 8) buttons.push(node); else localComplete = false; return false; }
      if (ownVisible && (/^H[1-6]$/.test(node.tagName) || attr(node, 'role') === 'heading')) headings.push(node);
      return true;
    }, 512)) localComplete = false;
    var textBudget = 2048, characterBudget = 16384;
    function textOf(root, excludes, depth) {
      if (--textBudget < 0 || depth > 64) { localComplete = false; return ''; }
      if (root.nodeType === 3) {
        if (!visible(root.parentElement)) {
          // Direct text of a boxless wrapper needs its own read-only geometry.
          // Unknown geometry is incomplete, never permission to omit a suffix.
          try {
            var range = document.createRange(); range.selectNodeContents(root);
            var rects = range.getClientRects(), onScreen = false;
            if (rects.length > 64) { localComplete = false; return ''; }
            for (var ri = 0; ri < rects.length; ri++) {
              var tr = rects[ri];
              if (tr.width > 0 && tr.height > 0 && tr.right > 0 && tr.bottom > 0 &&
                tr.left < window.innerWidth && tr.top < window.innerHeight) { onScreen = true; break; }
            }
            if (!onScreen) return '';
          } catch (error) { localComplete = false; return ''; }
        }
        var raw = String(root.nodeValue || '');
        if (raw.length > characterBudget) { localComplete = false; raw = raw.slice(0, Math.max(0, characterBudget)); }
        characterBudget -= raw.length; return raw;
      }
      if (root.nodeType !== 1 || excludes.has(root) || SKIP[root.tagName] || privateNode(root) || !readableSubtree(root)) return '';
      if (root.tagName === 'IFRAME' || root.shadowRoot) { localComplete = false; return ''; }
      var value = '';
      for (var child = root.firstChild; child; child = child.nextSibling) {
        if (textBudget < 0 || characterBudget < 0) { localComplete = false; break; }
        value += textOf(child, excludes, depth + 1);
      }
      return BLOCK[root.tagName] ? '\n' + value + '\n' : value;
    }
    var titleNode = headings[0] || null, title = '';
    var labelled = attr(el, 'aria-labelledby');
    if (labelled) {
      var refs = norm(labelled).split(' ');
      if (refs.length !== 1 || refs[0].length > 128) localComplete = false;
      else {
        var ref = document.getElementById(refs[0]);
        if (!ref || !el.contains(ref) || !visible(ref) || privateNode(ref)) localComplete = false;
        else titleNode = ref;
      }
    }
    if (titleNode) title = norm(textOf(titleNode, new Set(), 0));
    var ariaTitle = attr(el, 'aria-label');
    if (ariaTitle !== null) {
      if (ariaTitle.length > 4096) localComplete = false;
      var normalizedTitle = norm(ariaTitle.slice(0, 4096));
      if (title && title !== normalizedTitle) localComplete = false;
      title = normalizedTitle;
    }
    var labels = buttons.map(function (node) {
      var label = norm(textOf(node, new Set(), 0)), aria = attr(node, 'aria-label');
      if (aria !== null) {
        var named = norm(aria.slice(0, 257));
        if ((label && named !== label) || aria.length > 256) localComplete = false;
        label = named;
      }
      if (!label || label.length > 256) localComplete = false;
      return label.slice(0, 256) || '[Unlabelled button]';
    });
    if (new Set(labels).size !== labels.length) localComplete = false;
    var excluded = new Set(buttons); if (titleNode) excluded.add(titleNode);
    var body = textOf(el, excluded, 0);
    var texts = body.split('\n').map(norm).filter(Boolean);
    if (texts.length > 32) { localComplete = false; texts = texts.slice(0, 32); }
    var remaining = 4096 - title.length - labels.join('').length;
    if (remaining < 0) { localComplete = false; title = title.slice(0, 2048); remaining = 4096 - title.length - labels.join('').length; }
    texts = texts.map(function (text) {
      if (text.length > remaining) { localComplete = false; text = text.slice(0, Math.max(0, remaining)); }
      remaining -= text.length; return text;
    }).filter(Boolean);
    var origin = null;
    try { if (/^https?:$/.test(location.protocol) && location.origin !== 'null') origin = location.origin; } catch (error) { localComplete = false; }
    return { record: { kind: 'dom', origin: origin,
      originEvidence: origin ? 'dom_current_document' : 'unverified', title: title, texts: texts,
      buttons: labels, hasField: hasField, complete: localComplete && complete,
      templateId: null, templateVersion: null, instance: identify(el) }, buttons: buttons };
  }
  var inspected;
  try { inspected = candidates.map(inspect); } catch (error) { return fail('observation_unavailable'); }
  if (inspected.some(function (entry) { return !entry.record.instance; })) return fail('registry_capacity');
  if (request.mode === 'observe') return out({ ok: true, status: 'observed',
    observations: inspected.map(function (entry) { return entry.record; }), complete: complete, observedAt: Date.now() });
  if (request.documentToken !== registry.documentToken) return fail('document_changed');
  var node = registry.strong.get(request.nodeToken);
  if (!node || !node.isConnected || registry.weak.get(node) !== request.nodeToken) return fail('node_changed');
  var entry = inspected.find(function (item) { return item.record.instance.nodeToken === request.nodeToken; });
  if (!entry || !complete || inspected.length !== 1 || !entry.record.complete) return fail('ambiguous_or_incomplete_prompt');
  var actual = entry.record, expected = request.expectedTemplate;
  if (!expected || expected.kind !== 'dom' || expected.semanticClass !== 'inactivity' || expected.hasField !== false || actual.hasField ||
    actual.origin !== request.expectedOrigin || !Array.isArray(expected.origins) || !expected.origins.includes(request.expectedOrigin) ||
    actual.title !== expected.title || JSON.stringify(actual.texts) !== JSON.stringify(expected.texts) ||
    JSON.stringify(actual.buttons) !== JSON.stringify(expected.buttons)) return fail('template_changed');
  var positions = actual.buttons.map(function (label, index) { return label === request.button ? index : -1; }).filter(function (index) { return index >= 0; });
  if (positions.length !== 1 || !expected.choices || !Object.values(expected.choices).includes(request.button)) return fail('button_ambiguous');
  var target = entry.buttons[positions[0]];
  if (!visible(target) || target.disabled || attr(target, 'aria-disabled') === 'true') return fail('button_disabled');
  try {
    if (typeof target.matches === 'function' && target.matches(':disabled')) return fail('button_disabled');
    for (var parent = target.parentElement, depth = 0; parent && depth < 64; parent = parent.parentElement, depth++) {
      if (attr(parent, 'aria-disabled') === 'true' || (parent.tagName === 'FIELDSET' && parent.disabled)) return fail('button_disabled');
    }
    if (parent) return fail('button_unreachable');
    var rect = target.getBoundingClientRect();
    var left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    var right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    for (var ancestor = target.parentElement, count = 0; ancestor && count < 64; ancestor = ancestor.parentElement, count++) {
      var cs = style(ancestor), ar = ancestor.getBoundingClientRect();
      if (!cs) return fail('button_unreachable');
      if (cs.overflowX && cs.overflowX !== 'visible') {
        left = Math.max(left, ar.left + (ancestor.clientLeft || 0));
        right = Math.min(right, ar.left + (ancestor.clientLeft || 0) + ancestor.clientWidth);
      }
      if (cs.overflowY && cs.overflowY !== 'visible') {
        top = Math.max(top, ar.top + (ancestor.clientTop || 0));
        bottom = Math.min(bottom, ar.top + (ancestor.clientTop || 0) + ancestor.clientHeight);
      }
    }
    if (ancestor || right - left < 8 || bottom - top < 8) return fail('button_unreachable');
    var x = (left + right) / 2, y = (top + bottom) / 2;
    for (var offset of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
      var hit = document.elementFromPoint(x + offset[0], y + offset[1]);
      if (!hit || !(hit === target || target.contains(hit))) return fail('button_covered');
    }
    return out({ ok: true, reason: null, point: { x: x, y: y },
      rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }, instance: actual.instance,
      view: { innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio } });
  } catch (error) { return fail('button_unreachable'); }
}())
