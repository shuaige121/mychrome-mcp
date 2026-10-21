/* select_option: a <select> by marker, chosen WITHOUT opening its menu (on macOS the open menu is a
   system menu: while it is up the page cannot be read or driven — seen live 2026-10-06).

   __MARKER__  the read_page marker
   __OPTION__  the option's text as read_page lists it, or its value (whitespace and case folded;
               a unique prefix of the text also matches)
   __MODE__    'plan'  resolve the select and the option, focus the select (focus() never opens
                       the menu) and say what to type for the browser's type-ahead to land on it
               'check' whether the select shows that option now, and still has focus
   Always ok:true (the bridge throws on ok:false and the option list would be lost); a failure is
   `fail`. Option texts only; never the page's other content. */
(function () {
  var N = __MARKER__;
  var OPTION = __OPTION__;
  var MODE = __MODE__;
  function out(o) { return JSON.stringify(o); }
  // Older workers may request their former fallback. Refuse before touching
  // the control so a running task also stays on the real-keyboard input path.
  if (MODE !== 'plan' && MODE !== 'check') return out({ ok: true, fail: 'bad_mode' });
  var reg = window.__chromeBridge && window.__chromeBridge.markers;
  var el = reg && reg[N];
  if (!el || !el.isConnected) return out({ ok: true, fail: 'stale_marker' });
  if (el.tagName !== 'SELECT') return out({ ok: true, fail: 'not_select', tag: String(el.tagName).toLowerCase() });
  if (el.multiple) return out({ ok: true, fail: 'multiple' });
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
  var opts = Array.prototype.slice.call(el.options);
  var want = norm(OPTION);
  var idx = -1, i;
  for (i = 0; i < opts.length && idx < 0; i++) if (norm(opts[i].text) === want) idx = i;
  for (i = 0; i < opts.length && idx < 0; i++) if (norm(opts[i].value) === want) idx = i;
  if (idx < 0 && want) {
    var pre = [];
    for (i = 0; i < opts.length; i++) if (norm(opts[i].text).indexOf(want) === 0) pre.push(i);
    if (pre.length === 1) idx = pre[0];
  }
  var names = opts.slice(0, 60).map(function (o) { return String(o.text).replace(/\s+/g, ' ').trim(); });
  if (idx < 0) return out({ ok: true, fail: 'no_option', options: names });
  var opt = opts[idx];
  var focused = function () { var a = null; try { a = document.activeElement; } catch (e) {} return a === el; };
  var base = { ok: true, index: idx, text: String(opt.text).replace(/\s+/g, ' ').trim(), value: opt.value,
    current: el.selectedIndex, total: opts.length };

  function disabled() {
    if (el.disabled || opt.disabled) return true;
    var group = opt.parentElement;
    if (group && group.tagName === 'OPTGROUP' && group.disabled) return true;
    // Includes disabled fieldsets, respecting their first-legend exception.
    try { if (el.matches(':disabled')) return true; } catch (e) {}
    return false;
  }
  if (MODE === 'plan' && disabled()) {
    return out({ ok: true, fail: 'disabled', text: base.text });
  }

  if (MODE === 'plan') {
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    // Type-ahead (Blink): typed text selects the next option, from the current one, whose text starts
    // with it; a run of ONE repeated character instead steps through the options starting with that
    // character. So the option's own text lands on it unless an earlier match is in the way — the
    // result is checked either way (MODE 'check'); an unmatched key sequence fails.
    var t = norm(opt.text);
    var ta = t;
    if (t && /^(.)\1*$/.test(t)) {
      // Repeated character: count the steps from the current option to this one among those starting with it.
      var c = t.charAt(0), steps = 0, k = el.selectedIndex;
      for (var n = 0; n < opts.length; n++) {
        k = (k + 1) % opts.length;
        var g = opts[k].parentElement;
        if (!opts[k].disabled && !(g && g.tagName === 'OPTGROUP' && g.disabled) &&
            norm(opts[k].text).charAt(0) === c) steps++;
        if (k === idx) break;
      }
      ta = new Array(steps + 1).join(c);
    }
    base.typeahead = ta;
    base.focused = focused();
    base.hasFocus = document.hasFocus();
    return out(base);
  }
  if (MODE === 'check') {
    base.selected = el.isConnected && el.options[el.selectedIndex] === opt;
    base.focused = focused();
    return out(base);
  }
  return out({ ok: true, fail: 'bad_mode' });
})()
