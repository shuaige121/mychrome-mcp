/* Delivery acknowledgment (impl-contract §7): proof that the page consumed
   our input before the foreground is handed back. Key events go to whatever
   app is frontmost when they are dequeued, so handing back before Chrome
   consumed them would send them into the user's app.

   __ACK__  {arm: token}: install one capture listener on window for trusted
            click / pointerup / keyup, counting what it sees under `token`.
            It lives in the AppleScript isolated world (F1): page scripts can
            neither see it nor its counters. A previous one is removed first.
            {read: token, need?: {click|pointerup|keyup: n}, disarm?: bool}:
            the counters, if that token is still armed in this document
            (armed:false after a navigation replaced the document, or after
            another arm). `met`: any counter reached its `need`; the listener
            is removed then, and on disarm (one-shot).
   Key-ups of modifiers and of Cmd shortcuts are not counted (macOS does not
   deliver the key-up of a key pressed with Cmd). Read-only for the page. */
(function () {
  var A = __ACK__;
  var TYPES = ['click', 'pointerup', 'keyup'];
  var MODS = { Shift: 1, Meta: 1, Control: 1, Alt: 1, CapsLock: 1, Fn: 1 };
  var cur = window.__chromeBridgeAck;

  function off(st) {
    if (!st || !st.handler) return;
    for (var i = 0; i < TYPES.length; i++) window.removeEventListener(TYPES[i], st.handler, true);
    st.handler = null;
  }

  if (A && A.arm) {
    off(cur);
    var st = { token: A.arm, click: 0, pointerup: 0, keyup: 0, lastKey: null, handler: null };
    st.handler = function (e) {
      if (!e.isTrusted) return;
      if (e.type === 'keyup') {
        if (MODS[e.key] || e.metaKey) return;
        st.keyup++;
        st.lastKey = e.key;
      } else {
        st[e.type]++;
      }
    };
    for (var i = 0; i < TYPES.length; i++) window.addEventListener(TYPES[i], st.handler, true);
    window.__chromeBridgeAck = st;
    return JSON.stringify({ ok: true, armed: true });
  }

  var mine = !!cur && !!A && cur.token === A.read && !!cur.handler;
  var met = false;
  if (mine && A.need) {
    for (var k in A.need) {
      if (Object.prototype.hasOwnProperty.call(A.need, k) && typeof cur[k] === 'number' && cur[k] >= A.need[k]) met = true;
    }
  }
  var out = {
    ok: true,
    armed: mine,
    met: met,
    click: mine ? cur.click : 0,
    pointerup: mine ? cur.pointerup : 0,
    keyup: mine ? cur.keyup : 0,
    lastKey: mine ? cur.lastKey : null
  };
  if (mine && (met || A.disarm)) { off(cur); window.__chromeBridgeAck = null; }
  return JSON.stringify(out);
})()
