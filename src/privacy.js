/**
 * Output-only URL privacy. Never pass these display strings back to Chrome or
 * persist them as navigation/ownership state: the original URL remains internal.
 */
const HIDDEN = '[redacted]';
const PRIVATE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'token', 'accesstoken', 'idtoken', 'refreshtoken',
  'authtoken', 'bearertoken', 'sessiontoken', 'sessionid', 'secret', 'clientsecret',
  'apikey', 'authorization', 'auth', 'signature', 'sig', 'credential', 'credentials',
  'xamzsignature', 'xamzcredential', 'xamzsecuritytoken', 'xgoogsignature',
]);
const AMBIGUOUS_KEYS = new Set(['code', 'state', 't', 'key']);
const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
const keyName = (s) => decode(s).toLowerCase().replace(/[-_.]/g, '');
// Limit matching to URL/query syntax, including parameters in #/router?query.
const PARAM = /([?&#;])([^?&#;=\s<>"'`]+)=([^&#;\s<>"'`]*)/g;
const URL_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:#\/|\/)[^\s<>"'`]*\?|[?#](?=[^\s<>"'`]*=))[^\s<>"'`]+/gi;

function looksOpaque(value) {
  const text = decode(value);
  return text.length >= 16 && /^[A-Za-z0-9._~+/=-]+$/.test(text) &&
    (/[0-9._~+/=-]/.test(text) || /[A-Z]/.test(text) && /[a-z]/.test(text));
}

/** Redact known credentials without URL reserialization (which can change hash routes). */
export function redactUrl(value, depth = 0) {
  if (typeof value !== 'string' || !value) return value;
  let text = value.replace(/([a-z][a-z0-9+.-]*:\/\/|\/\/)[^/?#\s]*@/gi, `$1${HIDDEN}@`);
  const params = [...text.matchAll(PARAM)];
  const names = new Set(params.map(p => keyName(p[2])));
  const route = decode(text.split(/[?&]/, 1)[0]).toLowerCase();
  const oauth = /(?:^|[/.#_-])(?:oauth2?|auth|authorize|callback|signin|login)(?:$|[/#_.-])/.test(route) ||
    names.has('code') && names.has('state') || names.has('redirecturi') || names.has('responsetype') ||
    names.has('clientid') && (names.has('code') || names.has('state'));
  const exam = /(?:^|[/#_-])(?:exam|exams|paper|papers|quiz|assessment)(?:$|[/#_.-])/.test(route) ||
    names.has('paper') || names.has('paperid');
  const signed = names.has('signature') || names.has('sig') || names.has('xamzsignature');
  text = text.replace(PARAM, (whole, separator, rawKey, rawValue) => {
    const key = keyName(rawKey);
    const sensitive = PRIVATE_KEYS.has(key) || AMBIGUOUS_KEYS.has(key) &&
      (oauth || key === 't' && exam || key === 'key' && (signed || /(?:^|\/)api(?:\/|$)/.test(route)) || looksOpaque(rawValue));
    if (sensitive) return `${separator}${rawKey}=${HIDDEN}`;
    // An encoded redirect/return URL can itself carry credentials. Inspect only URL-like
    // values, with a finite nesting limit; do not decode or rewrite ordinary query values.
    if (depth < 3 && rawValue) {
      const decoded = decode(rawValue);
      if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/|#\/)/i.test(decoded)) {
        const redacted = redactUrl(decoded, depth + 1);
        if (redacted !== decoded) {
          return `${separator}${rawKey}=${rawValue === decoded ? redacted : encodeURIComponent(redacted)}`;
        }
      }
    }
    return whole;
  });
  return text;
}

/** URLs in page text, OCR text, titles, errors, and ledger notes share one filter. */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(URL_TEXT, (url) => {
    // Preserve surrounding Markdown/prose punctuation. It is not part of a query value.
    const punctuation = url.match(/[)\]},.，。；：！？]+$/)?.[0] || '';
    // A previous output boundary may already have redacted this URL. Its closing bracket
    // belongs to our placeholder, not to Markdown; filtering twice must be idempotent.
    const hiddenAt = url.lastIndexOf(HIDDEN);
    const end = Math.max(url.length - punctuation.length, hiddenAt < 0 ? 0 : hiddenAt + HIDDEN.length);
    return redactUrl(url.slice(0, end)) + url.slice(end);
  });
}

function redactData(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v)]));
  return value;
}

/** Final MCP boundary. Images/audio retain their original bytes and metadata. */
export function redactToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (Array.isArray(result.content)) {
    out.content = result.content.map(block => {
      if (block.type === 'text') return { ...block, text: redactText(block.text) };
      if (block.type === 'resource' && block.resource) {
        return { ...block, resource: { ...block.resource,
          uri: redactUrl(block.resource.uri),
          ...(typeof block.resource.text === 'string' ? { text: redactText(block.resource.text) } : {}),
        } };
      }
      return block;
    });
  }
  if (result.structuredContent) out.structuredContent = redactData(result.structuredContent);
  return out;
}
