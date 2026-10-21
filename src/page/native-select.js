/* Read-only guard before a click or key can open a macOS native select menu.
 * Apple Events cannot reach Chrome while that menu is open. Inspect labels,
 * open shadow roots and same-origin frames too; never open or change a control.
 * Cross-origin frames and closed shadow roots need a separate AX guard:
 * their internals are not exposed to this page script.
 * MODE: marker | point (screen points, BOUNDS is Chrome's window) | focus. */
(function () {
  var MODE = __MODE__, MARKER = __MARKER__, POINT = __POINT__, BOUNDS = __BOUNDS__;
  var reg = window.__chromeBridge && window.__chromeBridge.markers;
  function popupSelect(el) {
    return el && el.tagName === 'SELECT' && !el.multiple && el.size <= 1 ? el : null;
  }
  function selectFor(el) {
    for (var p = el; p; p = p.parentElement) {
      if (p.tagName === 'SELECT') return popupSelect(p);
      if (p.tagName === 'LABEL') {
        return popupSelect(p.control);
      }
      // Interactive descendants of a label do not activate its associated control.
      if (/^(BUTTON|A|INPUT|TEXTAREA)$/.test(p.tagName)) return null;
    }
    return null;
  }
  function focused(doc, depth) {
    if (!doc || depth > 16) return null;
    var el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (el && /^(IFRAME|FRAME)$/.test(el.tagName)) {
      try { return focused(el.contentDocument, depth + 1); } catch (e) { return null; }
    }
    return selectFor(el);
  }
  function atPoint(root, x, y, depth) {
    if (!root || depth > 16 || typeof root.elementFromPoint !== 'function') return null;
    var el = root.elementFromPoint(x, y);
    if (!el) return null;
    if (el.shadowRoot) {
      var shadow = atPoint(el.shadowRoot, x, y, depth + 1);
      if (shadow) return shadow;
    }
    if (/^(IFRAME|FRAME)$/.test(el.tagName)) {
      try {
        var r = el.getBoundingClientRect();
        // clientLeft/Top and offsetWidth/Height are untransformed; account for
        // CSS scaling before mapping into the embedded document's viewport.
        var sx = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
        var sy = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
        return atPoint(el.contentDocument, (x - r.left) / sx - el.clientLeft,
          (y - r.top) / sy - el.clientTop, depth + 1);
      } catch (e) { return null; }
    }
    return selectFor(el);
  }
  var found = null;
  if (MODE === 'marker') found = selectFor(reg && reg[MARKER]);
  else if (MODE === 'focus') found = focused(document, 0);
  else if (MODE === 'point') {
    var scale = BOUNDS && window.outerWidth > 0 ? BOUNDS.width / window.outerWidth : 1;
    if (!(scale >= 0.25 && scale <= 4)) scale = 1;
    var side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    var top = Math.max(0, window.outerHeight - window.innerHeight - side);
    var ox = (BOUNDS ? BOUNDS.left : window.screenX) + side * scale;
    var oy = (BOUNDS ? BOUNDS.top : window.screenY) + top * scale;
    // click_at's helper can land within its 6×6 point target. Check the centre
    // and edges, so a click beside a select cannot jitter onto it unnoticed.
    for (var dx = -3; dx <= 3 && !found; dx += 3) {
      for (var dy = -3; dy <= 3 && !found; dy += 3) {
        found = atPoint(document, (POINT.x + dx - ox) / scale, (POINT.y + dy - oy) / scale, 0);
      }
    }
  }
  var marker = null;
  if (found && reg) {
    for (var i = 1; i < reg.length; i++) if (reg[i] === found) { marker = i; break; }
  }
  return JSON.stringify({ ok: true, nativeSelect: !!found, marker: marker });
})()
