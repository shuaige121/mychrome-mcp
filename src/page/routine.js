/* Read-only routine descriptors. Never read field values or perform an action.
 * read.js owns the current 1-based marker registry. Persistent descriptors do
 * not contain markers, coordinates, selectors, query strings or field values.
 * Current read.js has no iframe/shadow traversal; those contexts fail closed. */
(function () {
  var request = typeof __ROUTINE__ === 'undefined' ? null : __ROUTINE__;
  var MAX_NAME = 160, MAX_PATH = 512;
  var sensitiveWords = /(?:password|passcode|one[\s_-]*time|\botp\b|verification[\s_-]*code|security[\s_-]*code|\bcvv\b|\bcvc\b|credit[\s_-]*card|card[\s_-]*(?:number|num)|验证码|密码|信用卡|银行卡)/i;
  var secretKey = /^(?:token|access[-_]?token|refresh[-_]?token|secret|password|passcode|otp|code|auth|authorization|session|sessionid|reset|reset[-_]?password)$/i;
  function attr(el, key) { return el.getAttribute(key) || ''; }
  function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function hasSecret(value) {
    return /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value) || /\d{6,}/.test(value) ||
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/.test(value) ||
      /(?:token|secret|password|authorization|otp|code)\s*[:=]\s*\S+/i.test(value) ||
      /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]+\b/.test(value);
  }
  function cleanText(value) {
    var raw = String(value || ''), text = normalize(raw);
    var unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(raw) || hasSecret(text);
    // Do not return a secret-bearing label, even for a non-replayable capture.
    if (unsafe) return { text: '', unsafe: true };
    if (text.length > MAX_NAME) return { text: text.slice(0, MAX_NAME), unsafe: true };
    return { text: text, unsafe: false };
  }
  // SHA-256 over UTF-8. The input is the exact serialized, non-sensitive query
  // pair, not a normalized set: order, duplicates and main/hash location matter.
  function sha256(input) {
    var bytes = [], encoded = encodeURIComponent(input);
    for (var i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(encoded.charCodeAt(i));
    }
    var bitLength = bytes.length * 8;
    bytes.push(128);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var high = 3; high >= 0; high--) bytes.push(Math.floor(bitLength / 4294967296) >>> (high * 8) & 255);
    for (var low = 3; low >= 0; low--) bytes.push(bitLength >>> (low * 8) & 255);
    var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function r(value, bits) { return (value >>> bits) | (value << (32 - bits)); }
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var w = [];
      for (i = 0; i < 16; i++) w[i] = bytes[offset+i*4]<<24 | bytes[offset+i*4+1]<<16 | bytes[offset+i*4+2]<<8 | bytes[offset+i*4+3];
      for (i = 16; i < 64; i++) {
        var x = w[i-15], y = w[i-2];
        w[i] = (w[i-16] + (r(x,7)^r(x,18)^(x>>>3)) + w[i-7] + (r(y,17)^r(y,19)^(y>>>10))) | 0;
      }
      var a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (j + (r(e,6)^r(e,11)^r(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) | 0;
        var t2 = ((r(a,2)^r(a,13)^r(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
        j=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,j].forEach(function (value, index) { h[index] = (h[index] + value) | 0; });
    }
    return h.map(function (value) { return (value >>> 0).toString(16).padStart(8, '0'); }).join('');
  }
  function queryIdentity(search, routeQuery) {
    if (!search && !routeQuery) return { unsafe: false };
    // Avoid unbounded work for hostile URLs. Never fingerprint known secrets.
    if (search.length + routeQuery.length > 8192) return { unsafe: true };
    var unsafe = false;
    [search, routeQuery].forEach(function (part) {
      new URLSearchParams(part).forEach(function (value, key) {
        if (secretKey.test(key) || /(?:token|password|passwd|passcode|otp|auth|session|secret|csrf|xsrf|credential|api[-_]?key)/i.test(key) || sensitiveWords.test(key) ||
            /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(value) || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value) ||
            /(?:token|secret|password|authorization|otp|code)\s*[:=]\s*\S+/i.test(value)) unsafe = true;
      });
    });
    return unsafe ? { unsafe: true } : { unsafe: false, hash: sha256(JSON.stringify([search, routeQuery])) };
  }
  function routePath(raw) {
    var unsafe = false, previousSecret = false;
    var parts = raw.split('/').map(function (part) {
      var decoded;
      try { decoded = decodeURIComponent(part); } catch (e) { unsafe = true; return ':redacted'; }
      var secret = previousSecret || hasSecret(decoded) || /[%\\/?#\u0000-\u0020\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(decoded);
      previousSecret = secretKey.test(decoded);
      if (secret) { unsafe = true; return ':redacted'; }
      return part;
    });
    var text = parts.join('/');
    if (text.length > MAX_PATH) { unsafe = true; text = '/:redacted'; }
    return { text: text, unsafe: unsafe };
  }
  function safeURL(raw, base) {
    try {
      var url = new URL(raw, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      var path = routePath(url.pathname), hash = '', routeQuery = '', unsafe = path.unsafe || !!url.username || !!url.password;
      if (/^#!?\//.test(url.hash)) {
        if (url.hash.indexOf('#', 1) !== -1) unsafe = true;
        var route = routePath(url.hash.replace(/^#!/, '#').slice(1).split('?')[0].split('#')[0]);
        hash = (url.hash.startsWith('#!/') ? '#!' : '#') + route.text; unsafe = unsafe || route.unsafe;
        var query = url.hash.indexOf('?');
        if (query !== -1) routeQuery = url.hash.slice(query);
      } else if (url.hash.includes('=')) {
        unsafe = unsafe || queryIdentity('', '?' + url.hash.slice(1)).unsafe;
      }
      var identity = queryIdentity(url.search, routeQuery), omittedIdentity = !!url.hash && !hash;
      unsafe = unsafe || identity.unsafe || omittedIdentity;
      return { origin: url.origin, path: path.text + hash, unsafe: unsafe, queryHash: unsafe ? undefined : identity.hash,
        href: url.origin + path.text + hash,
        omittedIdentity: omittedIdentity };
    } catch (e) { return null; }
  }
  var url = safeURL(location.href), page = url ? { origin: url.origin, path: url.path } : null;
  if (url && url.queryHash) page.queryHash = url.queryHash;
  function inContext(el) {
    return !!el && el instanceof window.Element && el.ownerDocument === document && el.getRootNode() === document;
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
        var style = window.getComputedStyle(node);
        if (node.hidden || attr(node, 'aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' ||
            style.contentVisibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      }
      var rect = el.getBoundingClientRect();
      return !!rect && rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
    } catch (e) { return false; }
  }
  function disabled(el) {
    try {
      if (el.disabled === true || el.matches(':disabled') || el.closest('[aria-disabled="true"],[inert]')) return true;
      if (el.tagName === 'LABEL' && el.control) return disabled(el.control);
    } catch (e) { return true; }
    return false;
  }
  function editable(el) {
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ||
      (el.hasAttribute('contenteditable') && attr(el, 'contenteditable') !== 'false') ||
      /^(textbox|searchbox|combobox)$/.test(attr(el, 'role').toLowerCase());
  }
  function privateField(el) {
    var p = window.__chromeBridgePrivate;
    if (!p) return false;
    try {
      if (p.set && p.set.has(el)) return true;
      if (p.forms && el.form && p.forms.has(el.form)) return true;
      return Array.isArray(p.like) && p.like.some(function (item) {
        return item && el.tagName === item.tag && attr(el, 'type').toLowerCase() === item.type &&
          ((item.id && el.id === item.id) || (item.name && attr(el, 'name') === item.name));
      });
    } catch (e) { return true; }
  }
  function sensitive(el) {
    if (el.tagName === 'LABEL' && el.control) return sensitive(el.control);
    if (!editable(el)) return false;
    if (privateField(el) || attr(el, 'type').toLowerCase() === 'password') return true;
    var autocomplete = attr(el, 'autocomplete').toLowerCase().split(/\s+/);
    if (autocomplete.some(function (part) { return /^(?:current-password|new-password|one-time-code|cc-.+)$/.test(part); })) return true;
    var hints = ['id', 'name', 'aria-label', 'placeholder', 'title'].map(function (key) { return attr(el, key); }).join(' ') + ' ' + label(el, false).text;
    return sensitiveWords.test(hints.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' '));
  }
  function staticText(root, visibleOnly) {
    var text = '', visited = 0, truncated = false;
    function walk(node) {
      if (++visited > 200 || text.length > 1024) { truncated = true; return; }
      if (node.nodeType === 3) { text += node.nodeValue || ''; return; }
      if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName) || editable(node)) return;
      if (visibleOnly && node !== root) {
        var style = window.getComputedStyle(node);
        if (node.hidden || attr(node, 'aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || style.contentVisibility === 'hidden' || parseFloat(style.opacity) === 0) return;
      }
      for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
    walk(root);
    return { text: text, truncated: truncated };
  }
  function label(el, explicitOnly) {
    var refs = normalize(attr(el, 'aria-labelledby')).split(' ').filter(Boolean), parts = [], truncated = false;
    if (refs.length > 12) return { text: '', unsafe: true };
    refs.forEach(function (id) {
      var ref = document.getElementById(id);
      if (ref) { var text = staticText(ref); parts.push(text.text); truncated = truncated || text.truncated; }
    });
    var text = normalize(parts.join(' ')) || attr(el, 'aria-label');
    if (!text && !explicitOnly && el.labels) {
      Array.from(el.labels).slice(0, 12).forEach(function (node) {
        var item = staticText(node); parts.push(item.text); truncated = truncated || item.truncated;
      });
      text = normalize(parts.join(' '));
    }
    if (!text && !explicitOnly) text = attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'alt');
    if (!text && !explicitOnly && !editable(el)) {
      var content = staticText(el); text = content.text; truncated = truncated || content.truncated;
    }
    var result = cleanText(text);
    result.unsafe = result.unsafe || truncated;
    return result;
  }
  function view() {
    var result = [], nodes = document.querySelectorAll('h1,h2'), dialogs = document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]');
    for (var i = 0; i < nodes.length && result.length < 11; i++) {
      if (!visible(nodes[i])) continue;
      var content = staticText(nodes[i], true), heading = cleanText(content.text);
      if (heading.text && !heading.unsafe && !content.truncated && !sensitiveWords.test(heading.text)) result.push({ role: 'heading', name: heading.text });
    }
    for (var j = dialogs.length - 1; j >= 0; j--) {
      if (!visible(dialogs[j])) continue;
      var name = label(dialogs[j], true);
      if (name.text && !name.unsafe && !sensitiveWords.test(name.text)) result.push({ role: 'dialog', name: name.text });
      break;
    }
    return result;
  }
  var currentView = view();
  function fail(reason) { return JSON.stringify({ ok: false, error: reason, reason: reason, page: page, view: currentView }); }
  function state(el) {
    var result = { disabled: disabled(el), focused: document.activeElement === el };
    [['aria-checked', 'checked'], ['aria-expanded', 'expanded'], ['aria-selected', 'selected']].forEach(function (pair) {
      var value = attr(el, pair[0]);
      if (value === 'true' || value === 'false') result[pair[1]] = value === 'true';
    });
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type)) result.checked = el.checked === true;
    if (el.tagName === 'OPTION') result.selected = el.selected === true;
    return result;
  }
  function role(el) {
    var explicit = normalize(attr(el, 'role')).toLowerCase().split(' ')[0];
    if (/^[a-z][a-z-]{0,39}$/.test(explicit)) return explicit;
    var roles = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', LABEL: 'label' };
    if (el.tagName === 'INPUT') {
      var type = el.type;
      return /^(checkbox|radio)$/.test(type) ? type : /^(button|submit|reset|image)$/.test(type) ? 'button' : type === 'number' ? 'spinbutton' : 'textbox';
    }
    return roles[el.tagName] || (editable(el) ? 'textbox' : 'generic');
  }
  function identifier(value) { return /^[A-Za-z0-9_.:-]{1,80}$/.test(value) && !hasSecret(value); }
  function describe(el) {
    var isSensitive = sensitive(el), named = isSensitive ? { text: '', unsafe: false } : label(el, false);
    var descriptor = { version: 1, tag: el.tagName.toLowerCase(), role: role(el), name: named.text };
    if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') descriptor.type = el.type;
    var reason = isSensitive ? 'sensitive_target' : named.unsafe ? 'unsafe_label' : null;
    if (!isSensitive) {
      [['id', attr(el, 'id')], ['testId', attr(el, 'data-testid') || attr(el, 'data-test-id') || attr(el, 'data-test') || attr(el, 'data-qa')]].forEach(function (pair) {
        if (!pair[1]) return;
        if (identifier(pair[1])) descriptor[pair[0]] = pair[1];
        else reason = reason || 'unsafe_identifier';
      });
      if (el.tagName === 'A' && el.hasAttribute('href')) {
        var href = safeURL(attr(el, 'href'), document.baseURI);
        if (href) descriptor.href = href.href;
        if (href && href.queryHash) descriptor.hrefQueryHash = href.queryHash;
        if (!href || href.unsafe || href.omittedIdentity) reason = reason || 'unsafe_link';
      }
    }
    if (!descriptor.name && !descriptor.id && !descriptor.testId && !descriptor.href) reason = reason || 'unnamed_target';
    if (!visible(el)) reason = reason || 'target_hidden';
    if (disabled(el)) reason = reason || 'target_disabled';
    if (url.unsafe) reason = reason || 'unsafe_page';
    return { descriptor: descriptor, sensitive: isSensitive, replayable: !reason, reason: reason, targetState: state(el) };
  }
  function validTarget(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || target.version !== 1) return false;
    var allowed = ['version', 'tag', 'role', 'name', 'id', 'testId', 'href', 'hrefQueryHash', 'type', 'frame'];
    if (Object.keys(target).some(function (key) { return allowed.indexOf(key) === -1; })) return false;
    if (typeof target.tag !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(target.tag) ||
        typeof target.role !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(target.role) ||
        typeof target.name !== 'string' || cleanText(target.name).unsafe || normalize(target.name) !== target.name) return false;
    for (var i = 0; i < 2; i++) { var key = ['id', 'testId'][i]; if (key in target && (typeof target[key] !== 'string' || !identifier(target[key]))) return false; }
    if ('type' in target && (typeof target.type !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(target.type))) return false;
    if ('href' in target) {
      var href = typeof target.href === 'string' && safeURL(target.href);
      if (!href || href.unsafe || href.href !== target.href) return false;
    }
    if ('hrefQueryHash' in target && (!('href' in target) || typeof target.hrefQueryHash !== 'string' || !/^[0-9a-f]{64}$/.test(target.hrefQueryHash))) return false;
    if ('frame' in target && (!target.frame || typeof target.frame !== 'object' || Array.isArray(target.frame))) return false;
    return !!(target.name || target.id || target.testId || target.href);
  }
  function same(a, b) {
    var keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(function (key) { return a[key] === b[key]; });
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || !['state', 'capture', 'resolve'].includes(request.mode)) return fail('bad_request');
  if (!page) return fail('unsupported_page');
  if (request.mode === 'state') return JSON.stringify({ ok: true, page: page, view: currentView, replayable: !url.unsafe, ...(url.unsafe ? { reason: 'unsafe_page' } : {}) });
  var registry = window.__chromeBridge;
  if (!registry || !Array.isArray(registry.markers) || registry.markers[0] !== null || registry.url !== location.href || !Number.isFinite(registry.stamp)) return fail('stale_registry');
  var markers = registry.markers;
  if (request.mode === 'capture') {
    var element, marker;
    if (request.focused === true && request.marker == null) {
      element = document.activeElement;
      if (element && (/^(IFRAME|FRAME)$/.test(element.tagName) || (element.shadowRoot && element.shadowRoot.activeElement))) return fail('unsupported_context');
      marker = markers.indexOf(element);
      if (marker < 1) return fail('unsupported_target');
    } else if (Number.isSafeInteger(request.marker) && request.marker > 0 && request.focused !== true) {
      marker = request.marker; element = markers[marker];
    } else return fail('bad_request');
    if (!element || !element.isConnected) return fail('target_missing');
    if (!inContext(element)) return fail('unsupported_context');
    var captured = describe(element);
    // A descriptor which already identifies multiple candidates cannot be replayed.
    var matches = markers.slice(1).filter(function (other) { return inContext(other) && other.isConnected && same(describe(other).descriptor, captured.descriptor); });
    if (matches.length !== 1) { captured.replayable = false; captured.reason = captured.reason || 'target_ambiguous'; }
    if (!captured.reason) delete captured.reason;
    return JSON.stringify(Object.assign({ ok: true, page: page, view: currentView }, captured));
  }
  if (!validTarget(request.target)) return fail('malformed_target');
  if ('frame' in request.target) return fail('unsupported_context');
  if (url.unsafe) return fail('unsafe_page');
  var found = [];
  for (var index = 1; index < markers.length; index++) {
    var candidate = markers[index];
    if (!inContext(candidate) || !candidate.isConnected) continue;
    var description = describe(candidate);
    if (same(description.descriptor, request.target)) found.push({ marker: index, description: description });
  }
  if (!found.length) return fail('target_missing');
  if (found.length !== 1) return fail('target_ambiguous');
  if (!found[0].description.replayable) return fail(found[0].description.reason);
  return JSON.stringify({ ok: true, marker: found[0].marker, page: page, view: currentView,
    descriptor: found[0].description.descriptor, targetState: found[0].description.targetState });
})();
