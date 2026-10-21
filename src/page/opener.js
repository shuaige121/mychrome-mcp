/* Who opened this tab: its referrer, whether it has an opener and, when the opener is of the same
   origin, the opener's URL. Read only, no DOM mutation.
   Before a tab that appeared during an agent's click is registered as that agent's popup
   (src/index.js claimPopups): a tab opened by a link or window.open of the clicked page carries that
   page as its referrer (the full URL from the same origin, at least the origin across origins under
   Chrome's default policy) or an opener; a URL another program or the user opened carries neither.
   rel="noreferrer" links carry neither too: such a tab is not registered (left alone, as before).

   Returns { ok: true, referrer: string, opener: boolean, openerUrl: string } */
(function () {
  var opener = false, openerUrl = '';
  try { opener = !!window.opener; } catch (e) { opener = true; }
  // Cross-origin openers throw on location: only a same-origin one says which page it is.
  try { if (window.opener) openerUrl = String(window.opener.location.href || ''); } catch (e) {}
  var referrer = '';
  try { referrer = String(document.referrer || ''); } catch (e) {}
  return JSON.stringify({ ok: true, referrer: referrer, opener: opener, openerUrl: openerUrl });
})()
