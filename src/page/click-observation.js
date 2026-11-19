/* Bounded click evidence, read-only for the page. No DOM/marker writes,
 * listeners, input values or editable drafts. An isolated-world binding keeps
 * only node references for comparing the exact same checkbox/radio. */
(function () {
  var O = __OBSERVE__;
  var texts = [], nodes = [], complete = true, count = 0, chars = 0, renderedHash = 2166136261;
  var root = document.body;
  var P = window.__chromeBridgePrivate;
  var skipped = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|OPTION|TIME)$/;
  function isPrivate(el) {
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      if (P) {
        if ((P.set && P.set.has(p)) || (P.forms && (P.forms.has(p) || (p.form && P.forms.has(p.form))))) return true;
        var like = P.like || [];
        for (var j = 0; j < like.length; j++) {
          var l = like[j];
          if (p.tagName === l.tag && String(p.getAttribute('type') || '').toLowerCase() === l.type &&
              ((l.id && p.id === l.id) || (l.name && p.getAttribute('name') === l.name))) return true;
        }
      }
    }
    return false;
  }
  function privateOrHidden(el, allowInput) {
    if (isPrivate(el)) return true;
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      var role = String(p.getAttribute('role') || '').toLowerCase().trim().split(/\s+/)[0];
      if ((skipped.test(p.tagName) && !(allowInput && p === el && p.tagName === 'INPUT')) || p.hidden ||
          /^(timer|textbox|searchbox|combobox|spinbutton)$/.test(role) || p.hasAttribute('contenteditable')) return true;
      var s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' ||
          (s.opacity !== '' && Number(s.opacity) === 0)) return true;
    }
    return false;
  }
  function visible(el, allowInput) {
    if (!el || privateOrHidden(el, allowInput)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < innerHeight && r.left < innerWidth;
  }
  var targetState = null, reg = window.__chromeBridge;
  var markerNode = O && reg && reg.url === location.href && reg.markers && reg.markers[O.marker];
  var control = markerNode && markerNode.tagName === 'LABEL' ? markerNode.control : markerNode;
  var kind = control && String(control.type || '').toLowerCase();
  var eligible = markerNode && markerNode.isConnected && visible(markerNode, true) && control &&
    control.isConnected && control.tagName === 'INPUT' && /^(checkbox|radio)$/.test(kind) && !isPrivate(control);
  var bind = O && O.bind, old = window.__chromeBridgeClickObservation;
  if (bind && bind.set) {
    old = eligible ? { token: bind.set, registry: reg, markerNode: markerNode, control: control, kind: kind } : null;
    window.__chromeBridgeClickObservation = old;
  }
  if (eligible && bind && old && old.token === (bind.set || bind.check) && old.registry === reg &&
      old.markerNode === markerNode && old.control === control && old.kind === kind) {
    targetState = { token: old.token, kind: kind, checked: !!control.checked };
  }
  if (root) {
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = walk.nextNode())) {
      if (++count > 2400 || texts.length >= 200 || chars >= 12000) { complete = false; break; }
      var text = String(n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!text || privateOrHidden(n.parentElement)) continue;
      text = text.slice(0, 160);
      // All rendered text provides a scroll-stable baseline. Moving the
      // viewport (including an inner scroller) alone is not a content update.
      for (var h = 0; h <= text.length; h++) {
        renderedHash ^= h === text.length ? 0 : text.charCodeAt(h);
        renderedHash = Math.imul(renderedHash, 16777619);
      }
      if (!visible(n.parentElement)) continue;
      texts.push(text); nodes.push(n); chars += text.length;
    }
  } else complete = false;
  var dialogs = [];
  var candidates = document.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"],[popover]');
  for (var i = 0; i < candidates.length && dialogs.length < 8; i++) {
    var el = candidates[i];
    if (!visible(el)) continue;
    if (el.tagName === 'DIALOG' && !el.hasAttribute('open')) continue;
    if (el.hasAttribute('popover')) {
      try { if (!el.matches(':popover-open')) continue; } catch (e) { continue; }
    }
    var parts = [];
    for (var k = 0; k < nodes.length; k++) if (el.contains(nodes[k])) parts.push(texts[k]);
    dialogs.push((parts.join(' ') || el.getAttribute('aria-label') || '无文字弹层').slice(0, 160));
  }
  var busy = Array.prototype.some.call(document.querySelectorAll('[aria-busy="true"],[role="progressbar"]'), function (el) {
    return visible(el);
  });
  return JSON.stringify({ ok: true, href: location.href, texts: texts, dialogs: dialogs, complete: complete, busy: busy,
    renderedHash: renderedHash >>> 0, scrollX: scrollX, scrollY: scrollY, targetState: targetState });
})()
