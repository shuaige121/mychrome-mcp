/* Bind and verify a native date/time input. The actual field is never assigned:
 * constraints are validated on a detached clone, then the caller sends real keys.
 * __TEMPORAL__: {mode:'plan'|'status'|'check', marker, text, token}. */
(function () {
  var req = __TEMPORAL__;
  function out(o) { return JSON.stringify(o); }
  function fail(code) { return out({ ok: true, fail: code }); }
  var types = { date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1 };
  var binding = window.__chromeBridgeTemporal, el;
  if (req.mode === 'plan') {
    var reg = window.__chromeBridge;
    if (req.marker != null) {
      el = reg && reg.url === location.href && reg.markers && reg.markers[req.marker];
      if (!el || !el.isConnected) return fail('stale_marker');
      if (el.tagName === 'LABEL') el = el.control;
    } else el = document.activeElement;
    if (!el || el.tagName !== 'INPUT' || !types[el.type]) return fail('not_temporal');
    if (el.disabled || el.readOnly || el.matches(':disabled') || el.closest('[inert]')) return fail('disabled');
    var text = String(req.text || '');
    var pattern = el.type === 'date' ? /^\d{4,}-\d{2}-\d{2}$/ :
      el.type === 'month' ? /^\d{4,}-\d{2}$/ : el.type === 'week' ? /^\d{4,}-W\d{2}$/ :
      el.type === 'time' ? /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/ :
      /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
    if (!pattern.test(text)) return fail('invalid_value');
    var clone = el.cloneNode(false);
    clone.value = text;
    if (!clone.value || !clone.validity.valid) return fail('invalid_value');
    binding = { el: el, token: req.token, expected: clone.value, type: el.type };
    window.__chromeBridgeTemporal = binding;
  } else {
    if (!binding || binding.token !== req.token || !binding.el || !binding.el.isConnected) return fail('field_changed');
    el = binding.el;
    if (el.type !== binding.type || el.disabled || el.readOnly || el.matches(':disabled') || el.closest('[inert]')) return fail('field_changed');
  }
  if (req.mode === 'aim') {
    var hit = document.elementFromPoint(req.point.x, req.point.y);
    while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      var child = hit.shadowRoot.elementFromPoint(req.point.x, req.point.y);
      if (!child || child === hit) break;
      hit = child;
    }
    if (hit !== el) return fail('field_covered');
  }
  var r = el.getBoundingClientRect();
  return out({
    ok: true, type: binding.type, expected: binding.expected,
    selected: el.value === binding.expected && el.validity.valid,
    focused: document.hasFocus() && document.activeElement === el,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    view: { innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight, screenX: window.screenX, screenY: window.screenY }
  });
})()
