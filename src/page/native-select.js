/* Read-only guard before a click or key can open a macOS native select menu.
 * Apple Events cannot reach Chrome while that menu is open. Inspect labels,
 * open shadow roots and same-origin frames too; never open or change a control.
 * Cross-origin frames and closed shadow roots need a separate AX guard:
 * their internals are not exposed to this page script.
 * MODE: marker | point (screen points, BOUNDS is Chrome's window; RECT, optional, a screen landing rect) | focus.
 * FOCUS4 r1/r2 (A1): `control` says what actually receives the input, for the input guard when AX cannot inspect it:
 * the deepest element of a composed hit test at the landing point(s) (point mode) or of the focus chain (focus mode),
 * through open shadow roots and accessible frames. 'native-select' (a popup <select>, directly or through its label);
 * 'unknown' for nothing found, an inaccessible frame, a plugin, a shadow host the traversal could not resolve, or a
 * custom element with no accessible shadow root (it may hide closed content); else 'ordinary', built-in elements
 * included (r3, the user's decision against over-protection: a div/span button, body/html as the key recipient; a
 * built-in hosting a closed shadow root with a <select> inside is an accepted B residual). Marker mode cannot see
 * the recipient: its control is always 'unknown'.
 * `nativeSelect:false` alone is not that evidence. `hasFocus` (G-g) is the read-only key-recipient fact: this
 * document owns keyboard focus. */
(function () {
  var MODE = __MODE__, MARKER = __MARKER__, POINT = __POINT__, BOUNDS = __BOUNDS__, RECT = __RECT__;
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
  function classify(el) {
    if (!el || el.nodeType !== 1) return 'unknown';
    if (selectFor(el)) return 'native-select';
    if (/^(IFRAME|FRAME|EMBED|OBJECT|APPLET|PORTAL|FENCEDFRAME)$/.test(el.tagName)) return 'unknown';
    if (el.shadowRoot) return 'unknown';   // an open shadow host the traversal stopped at: unresolved
    if (el.tagName.indexOf('-') >= 0) return 'unknown';   // a custom element with no accessible shadow root
    return 'ordinary';
  }
  function frameDoc(el) {
    try { return el.contentDocument || null; } catch (e) { return null; }
  }
  // The element that owns keyboard focus, through open shadow roots and accessible frames; an inaccessible frame stays.
  function focusedEl(doc, depth) {
    if (!doc || depth > 16) return null;
    var el = doc.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (el && /^(IFRAME|FRAME)$/.test(el.tagName)) { var inner = frameDoc(el); return inner ? focusedEl(inner, depth + 1) : el; }
    return el || doc.body || doc.documentElement || null;
  }
  // The innermost element at a viewport point, as atPoint traverses; an inaccessible frame stays.
  function atPointEl(root, x, y, depth) {
    if (!root || depth > 16 || typeof root.elementFromPoint !== 'function') return null;
    var el = root.elementFromPoint(x, y);
    if (!el) return null;
    if (el.shadowRoot) {
      // Composed hit test: into the open shadow root, down to its deepest element; else the host stays (unresolved).
      var shadow = atPointEl(el.shadowRoot, x, y, depth + 1);
      return shadow && shadow !== el ? shadow : el;
    }
    if (/^(IFRAME|FRAME)$/.test(el.tagName)) {
      var doc = frameDoc(el);
      if (!doc) return el;
      var r = el.getBoundingClientRect();
      var sx = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      var sy = el.offsetHeight > 0 ? r.height / el.offsetHeight : 1;
      return atPointEl(doc, (x - r.left) / sx - el.clientLeft, (y - r.top) / sy - el.clientTop, depth + 1) || el;
    }
    return el;
  }
  var found = null, control = 'unknown';
  if (MODE === 'marker') found = selectFor(reg && reg[MARKER]);   // control stays 'unknown': the recipient is at a point
  else if (MODE === 'focus') { found = focused(document, 0); control = classify(focusedEl(document, 0)); }
  else if (MODE === 'point') {
    var scale = BOUNDS && window.outerWidth > 0 ? BOUNDS.width / window.outerWidth : 1;
    if (!(scale >= 0.25 && scale <= 4)) scale = 1;
    var side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    var top = Math.max(0, window.outerHeight - window.innerHeight - side);
    var ox = (BOUNDS ? BOUNDS.left : window.screenX) + side * scale;
    var oy = (BOUNDS ? BOUNDS.top : window.screenY) + top * scale;
    // click_at's helper can land within its 6×6 point target. Check the centre
    // and edges, so a click beside a select cannot jitter onto it unnoticed.
    var pts = [];
    for (var dx = -3; dx <= 3; dx += 3) for (var dy = -3; dy <= 3; dy += 3) pts.push([POINT.x + dx, POINT.y + dy]);
    // FOCUS4 r2 A1: a marker click may land anywhere in the inner 80% of its landing rect: sample that too.
    if (RECT && RECT.w > 0 && RECT.h > 0) {
      for (var fx = 0; fx < 3; fx++) for (var fy = 0; fy < 3; fy++) pts.push([RECT.x + RECT.w * (0.1 + 0.4 * fx), RECT.y + RECT.h * (0.1 + 0.4 * fy)]);
    }
    var kinds = [];
    for (var k = 0; k < pts.length && !found; k++) {
      var vx = (pts[k][0] - ox) / scale, vy = (pts[k][1] - oy) / scale;
      found = atPoint(document, vx, vy, 0);
      kinds.push(classify(atPointEl(document, vx, vy, 0)));
    }
    // Every point the click may land on must be positively ordinary.
    control = kinds.indexOf('native-select') >= 0 ? 'native-select' : kinds.indexOf('unknown') >= 0 ? 'unknown' : 'ordinary';
  }
  if (found) control = 'native-select';
  var marker = null;
  if (found && reg) {
    for (var i = 1; i < reg.length; i++) if (reg[i] === found) { marker = i; break; }
  }
  return JSON.stringify({ ok: true, nativeSelect: !!found, marker: marker, hasFocus: document.hasFocus(), control: control });
})()
