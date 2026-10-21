/* Is the page waiting for a human: a CAPTCHA, a bot challenge, "too many requests", "access denied"?
   MyChrome never solves or gets around these (owner, 2026-10-06: a tool that saves the user's
   time on their own computer, not one that escapes CAPTCHAs). The agent stops, the user is told,
   and the agent waits for them (wait_for_user) instead of sitting there stuck.

   Conservative on purpose: only rendered, sizeable widgets count, and a solved one (its response
   field filled) does not. An invisible reCAPTCHA badge, a "获取验证码" SMS field or an article that
   talks about CAPTCHAs is not a block. Text alone counts only on a short page (challenge and
   error pages are short).

   Returns { ok: true, blocked: null | { kind, vendor, evidence } }
     kind: 'captcha' | 'challenge' | 'rate_limit' | 'forbidden' */
(function () {
  try {
    var doc = document, body = doc.body;
    if (!body) return JSON.stringify({ ok: true, blocked: null });

    function rendered(el, minW, minH) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (r.width < (minW || 1) || r.height < (minH || 1)) return false;
      for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
        var cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
      return true;
    }
    function filled(sel) {
      var els = doc.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) if ((els[i].value || '').length > 0) return true;
      return false;
    }
    function hit(kind, vendor, evidence) { return { kind: kind, vendor: vendor, evidence: String(evidence).slice(0, 120) }; }

    var found = null;

    // 1. Vendor widgets in frames (cross-origin: only the frame's address and size are visible).
    var VENDORS = [
      { re: /google\.com\/recaptcha|recaptcha\.net\/recaptcha/i, vendor: 'reCAPTCHA', solved: '[name="g-recaptcha-response"],#g-recaptcha-response', w: 100, h: 40 },
      { re: /hcaptcha\.com/i, vendor: 'hCaptcha', solved: '[name="h-captcha-response"]', w: 100, h: 40 },
      { re: /challenges\.cloudflare\.com/i, vendor: 'Cloudflare Turnstile', solved: '[name="cf-turnstile-response"]', w: 100, h: 40 },
      { re: /arkoselabs\.com|funcaptcha\.com/i, vendor: 'Arkose', solved: null, w: 150, h: 100 },
      { re: /captcha-delivery\.com/i, vendor: 'DataDome', solved: null, w: 150, h: 100 },
      { re: /turing\.captcha\.qcloud\.com|captcha\.qq\.com/i, vendor: '腾讯验证码', solved: null, w: 150, h: 100 }
    ];
    var frames = doc.querySelectorAll('iframe');
    for (var i = 0; i < frames.length && !found; i++) {
      var src = frames[i].getAttribute('src') || '';
      if (/[?&]size=invisible\b/i.test(src)) continue;
      for (var v = 0; v < VENDORS.length; v++) {
        var V = VENDORS[v];
        if (!V.re.test(src)) continue;
        if (!rendered(frames[i], V.w, V.h)) break;
        if (V.solved && filled(V.solved)) break;
        found = hit('captcha', V.vendor, src.replace(/[?#].*$/, ''));
        break;
      }
    }

    // 2. Vendor widgets drawn in the page itself (sliders, puzzle and click-the-picture pop-ups).
    var WIDGETS = [
      ['.geetest_panel, .geetest_box, .geetest_holder, .geetest_box_wrap, .geetest_popup_wrap', '极验'],
      ['.yidun_popup, .yidun_modal, .yidun--jigsaw, .yidun_slider', '网易易盾'],
      ['#nc_1_wrapper, .nc-container, .nc_wrapper, #baxia-dialog-content, .baxia-dialog', '阿里滑块'],
      ['#tcaptcha_transform, #tCaptchaDyMainWrap', '腾讯验证码'],
      ['#px-captcha', 'PerimeterX']
    ];
    for (var k = 0; k < WIDGETS.length && !found; k++) {
      var ws = doc.querySelectorAll(WIDGETS[k][0]);
      for (var j = 0; j < ws.length; j++) {
        if (rendered(ws[j], 120, 30)) { found = hit('captcha', WIDGETS[k][1], WIDGETS[k][0].split(',')[0]); break; }
      }
    }

    // 3. Bot-check interstitials (the whole page is the check).
    var title = (doc.title || '').trim();
    if (!found) {
      var cf = doc.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-browser-verification, #challenge-stage');
      if (cf && rendered(cf)) found = hit('challenge', 'Cloudflare', '#' + (cf.id || cf.className));
      else if (/^(just a moment|attention required|one more step|请稍候|请稍等)/i.test(title)) found = hit('challenge', 'Cloudflare', '标题「' + title + '」');
    }

    // 4. A picture CAPTCHA in a form: a code field next to an image of the code.
    if (!found) {
      var inputs = doc.querySelectorAll('input');
      for (var n = 0; n < inputs.length && !found; n++) {
        var inp = inputs[n];
        var label = [inp.getAttribute('placeholder'), inp.getAttribute('aria-label'), inp.name, inp.id].join(' ');
        if (!/图形验证码|图片验证码|验证码图片|captcha/i.test(label) || /短信|sms|手机/i.test(label) || !rendered(inp)) continue;
        var box = inp.closest('form, div, p, li, td') || inp.parentElement;
        var imgs = box ? box.querySelectorAll('img, canvas') : [];
        for (var q = 0; q < imgs.length; q++) {
          if (rendered(imgs[q], 30, 12)) { found = hit('captcha', '图形验证码', '输入框「' + (inp.getAttribute('placeholder') || inp.name || inp.id) + '」旁边有验证码图片'); break; }
        }
      }
    }

    // 5. Error and check pages are short: their title or main heading starts with the status, or the
    //    whole (short) text asks for it. A heading that merely mentions it ("如何看待 429") is not one.
    if (!found) {
      var text = (body.innerText || body.textContent || '').replace(/\s+/g, ' ').trim();
      var h1 = doc.querySelector('h1');
      var heads = [title, h1 ? (h1.textContent || '').trim() : ''];
      var RATE = /^\s*(429\b|too many requests|访问过于频繁|请求过于频繁|操作过于频繁|访问太频繁)/i;
      var DENY = /^\s*(403\b|access denied|forbidden|访问被拒绝|拒绝访问|访问受限)/i;
      var m = null, short = text.length < 1500;
      // The document's own HTTP status (Chrome 109+): 429 is a rate limit whatever the page says;
      // 403 counts on a short page (a long one is an app's own "no permission" view the agent can read).
      var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      var status = nav && nav.responseStatus;
      if (status === 429) found = hit('rate_limit', '', 'HTTP 429');
      else if (status === 403 && text.length < 3000) found = hit('forbidden', '', 'HTTP 403');
      for (var z = 0; z < heads.length && !found; z++) {
        if ((m = heads[z].match(RATE))) found = hit('rate_limit', '', '「' + heads[z].slice(0, 40) + '」');
        else if ((m = heads[z].match(DENY))) found = hit('forbidden', '', '「' + heads[z].slice(0, 40) + '」');
      }
      if (!found && short) {
        if ((m = text.match(/(访问|请求|操作)(过于|太)频繁|unusual traffic|异常流量/i))) found = hit('rate_limit', '', '「' + m[0] + '」');
        else if ((m = text.match(/(请完成|进行)?安全验证|人机验证|拖动(下方)?滑块|按住滑块|向右(拖动|滑动)|请依次点击|verify (that )?you('re| are) (a )?human|are you a robot/i))) found = hit('captcha', '', '「' + m[0] + '」');
      }
    }

    return JSON.stringify({ ok: true, blocked: found });
  } catch (e) {
    // The check never stands in the way of work: an error means "not seen".
    return JSON.stringify({ ok: true, blocked: null, error: String(e && e.message || e).slice(0, 200) });
  }
})()
