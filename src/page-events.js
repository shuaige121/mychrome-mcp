/** Bounded, memory-only page prompt state. This module grants no input authority. */
import { readFileSync } from 'node:fs';
import { randomBytes as cryptoRandomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const PAGE_EVENT_LIMITS = Object.freeze({ events: 64, rules: 32, candidates: 8,
  buttons: 8, templateCharacters: 4096, buttonCharacters: 256, ttlMs: 600000, autoAgeMs: 2000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\s\S])/;
const TOKEN = /^[A-Za-z0-9_-]{43}(?![\s\S])/;
const FIXTURE_ORIGINS = new Set(['http://127.0.0.1:17744', 'http://localhost:17744']);
const ROUTES = ['claude_channel', 'next_tool'];
const SEMANTICS = ['keep_session', 'exit_session'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const positive = n => Number.isSafeInteger(n) && n > 0;
const id = value => typeof value === 'string' && ID.test(value);
const copy = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const defaultSettings = () => ({ version: 1, policy: 'notify_ai', rules: [] });
const freeze = value => { if (value && typeof value === 'object') {
  Object.values(value).forEach(freeze); Object.freeze(value);
} return value; };

/** Explicit portable whitespace set, shared with Swift; FEFF/zero-width space remain literal. */
export function normalizePromptText(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').replace(/^ +| +$/g, '')
    : null;
}

/** Deliberately narrow portable origin grammar. No credentials, IPv6, paths or aliases. */
export function canonicalPromptOrigin(value) {
  if (typeof value !== 'string' || value.length > 280 || !/^[\x21-\x7e]+$/.test(value)) return null;
  const m = /^(https?):\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!m || m[2].length > 253 || m[2].split('.').some(label => label.startsWith('xn--') ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (/^[0-9.]+$/.test(m[2])) {
    const octets = m[2].split('.');
    if (octets.length !== 4 || octets.some(o => !/^(0|[1-9][0-9]{0,2})$/.test(o) || +o > 255)) return null;
  }
  if (m[3] && (+m[3] > 65535 || +m[3] === (m[1] === 'http' ? 80 : 443))) return null;
  try { return new URL(value).origin === value ? value : null; } catch { return null; }
}

function templatesOf(catalog) { return Array.isArray(catalog) ? catalog : catalog?.templates; }
function boundedText(value, max = PAGE_EVENT_LIMITS.templateCharacters) {
  return typeof value === 'string' && value.length <= max && normalizePromptText(value) === value;
}
function validContent(value) {
  return boundedText(value.title) && Array.isArray(value.texts) && value.texts.length <= 32 &&
    value.texts.every(t => boundedText(t) && t.length > 0) && Array.isArray(value.buttons) &&
    value.buttons.length <= 8 && value.buttons.every(b => boundedText(b, 256) && b.length > 0) &&
    value.title.length + value.texts.join('').length + value.buttons.join('').length <= 4096;
}
export function validatePromptCatalog(catalog) {
  if (!Array.isArray(catalog) && (!exactKeys(catalog, ['version', 'templates']) || catalog.version !== 1)) return false;
  const templates = templatesOf(catalog);
  if (!Array.isArray(templates) || !templates.length || templates.length > 64) return false;
  const ids = new Set();
  return templates.every(t => {
    if (!exactKeys(t, ['id', 'version', 'fixtureOnly', 'kind', 'semanticClass', 'title', 'texts',
      'buttons', 'choices', 'hasField', 'origins']) || !id(t.id) || ids.has(t.id) || !positive(t.version) ||
      typeof t.fixtureOnly !== 'boolean' || !['dom', 'native'].includes(t.kind) ||
      t.semanticClass !== 'inactivity' || t.hasField !== false || !validContent(t) || !t.buttons.length ||
      new Set(t.buttons).size !== t.buttons.length || !plain(t.choices) ||
      Object.keys(t.choices).length < 1 || Object.keys(t.choices).some(s => !SEMANTICS.includes(s)) ||
      Object.values(t.choices).some(b => !t.buttons.includes(b)) ||
      new Set(Object.values(t.choices)).size !== Object.values(t.choices).length ||
      !Array.isArray(t.origins) || !t.origins.length || t.origins.length > 8 ||
      new Set(t.origins).size !== t.origins.length || t.origins.some(o => !canonicalPromptOrigin(o) ||
        (t.fixtureOnly ? !FIXTURE_ORIGINS.has(o) : !o.startsWith('https://')))) return false;
    ids.add(t.id); return true;
  });
}
let loadedCatalog = null;
try {
  const value = JSON.parse(readFileSync(new URL('./page-prompt-templates.json', import.meta.url), 'utf8'));
  if (!Array.isArray(value) && validatePromptCatalog(value)) loadedCatalog = freeze(value);
} catch { /* Missing or malformed catalog disables automatic handling, not the server. */ }
export const PAGE_PROMPT_CATALOG = loadedCatalog;

export function normalizePagePromptSettings(raw, catalog = PAGE_PROMPT_CATALOG) {
  const fail = reason => ({ value: defaultSettings(), valid: false, reason });
  if (!validatePromptCatalog(catalog)) return fail('catalog_unavailable');
  if (raw === undefined) return { value: defaultSettings(), valid: true, reason: null };
  if (!exactKeys(raw, ['version', 'policy', 'rules']) || raw.version !== 1 ||
    !['off', 'notify_ai', 'auto_safe'].includes(raw.policy) || !Array.isArray(raw.rules) || raw.rules.length > 32)
    return fail('invalid_page_prompt_settings');
  const ids = new Set(), templates = templatesOf(catalog);
  for (const rule of raw.rules) {
    if (!exactKeys(rule, ['id', 'enabled', 'origin', 'templateId', 'templateVersion', 'semantic', 'button']) ||
      !id(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' || !canonicalPromptOrigin(rule.origin) ||
      !id(rule.templateId) || !positive(rule.templateVersion) || !SEMANTICS.includes(rule.semantic))
      return fail('invalid_page_prompt_settings');
    const template = templates.find(t => t.id === rule.templateId && t.version === rule.templateVersion);
    if (!template || !template.origins.includes(rule.origin) || !Object.hasOwn(template.choices, rule.semantic) ||
      template.choices[rule.semantic] !== rule.button) return fail('invalid_page_prompt_settings');
    ids.add(rule.id);
  }
  return { value: copy(raw), valid: true, reason: null };
}
function templateFor(observation, catalog) {
  if (!observation || !validatePromptCatalog(catalog) || !observation.complete || observation.hasField ||
    !canonicalPromptOrigin(observation.origin) || observation.originEvidence !==
      (observation.kind === 'dom' ? 'dom_current_document' : 'native_current_snapshot')) return null;
  const matches = templatesOf(catalog).filter(t => t.kind === observation.kind && t.origins.includes(observation.origin) &&
    t.title === observation.title && equal(t.texts, observation.texts) && equal(t.buttons, observation.buttons));
  return matches.length === 1 ? matches[0] : null;
}
export function matchPromptRule(observation, settings, catalog = PAGE_PROMPT_CATALOG) {
  if (!settings?.valid) return null;
  const normalized = normalizePagePromptSettings(settings.value, catalog);
  if (!normalized.valid || normalized.value.policy !== 'auto_safe') return null;
  const template = templateFor(observation, catalog);
  if (!template) return null;
  const matches = normalized.value.rules.filter(r => r.enabled && r.origin === observation.origin &&
    r.templateId === template.id && r.templateVersion === template.version);
  return matches.length === 1 ? copy(matches[0]) : null;
}

const targetKeys = ['chromePid', 'windowId', 'tabId', 'cgWindow'];
function validSource(source) {
  return exactKeys(source, ['schema', 'connectionId', 'workerGeneration', 'taskGeneration', 'provider', 'threadId', 'target']) &&
    source.schema === 1 && ['connectionId', 'workerGeneration', 'taskGeneration'].every(k => id(source[k])) &&
    ['Claude', 'Codex', 'other'].includes(source.provider) && (source.threadId === null || id(source.threadId)) &&
    exactKeys(source.target, targetKeys) && targetKeys.every(k => positive(source.target[k]));
}
function sameSource(a, b) {
  return !!a && !!b && ['connectionId', 'workerGeneration', 'taskGeneration', 'provider', 'threadId'].every(k => a[k] === b[k]) &&
    targetKeys.every(k => a.target[k] === b.target[k]);
}
function sameContext(source, actual) {
  return source && exactKeys(actual, ['connectionId', 'workerGeneration', 'taskGeneration']) &&
    ['connectionId', 'workerGeneration', 'taskGeneration'].every(k => source[k] === actual[k]);
}
function normalizeObservation(value, source, catalog) {
  if (!exactKeys(value, ['schema', 'source', 'observedAt', 'kind', 'origin', 'originEvidence', 'title', 'texts',
    'buttons', 'hasField', 'complete', 'templateId', 'templateVersion', 'instance']) || value.schema !== 1 ||
    !validSource(value.source) || !sameSource(value.source, source) || !Number.isFinite(value.observedAt) ||
    !['dom', 'native'].includes(value.kind) || !(value.origin === null || canonicalPromptOrigin(value.origin)) ||
    !['dom_current_document', 'native_current_snapshot', 'unverified'].includes(value.originEvidence) ||
    typeof value.title !== 'string' || !Array.isArray(value.texts) || !Array.isArray(value.buttons) ||
    value.texts.some(t => typeof t !== 'string') || value.buttons.some(t => typeof t !== 'string') ||
    typeof value.hasField !== 'boolean' || typeof value.complete !== 'boolean') return null;
  const instance = value.instance;
  if (value.kind === 'dom' ? !exactKeys(instance, ['kind', 'documentToken', 'nodeToken']) || instance.kind !== 'dom' ||
    !id(instance.documentToken) || !id(instance.nodeToken) :
    !exactKeys(instance, ['kind', 'episodeId', 'fingerprint']) || instance.kind !== 'native_episode' ||
    !id(instance.episodeId) || typeof instance.fingerprint !== 'string' || instance.fingerprint.length > 256) return null;
  const observation = copy(value);
  observation.title = normalizePromptText(value.title);
  observation.texts = value.texts.map(normalizePromptText);
  observation.buttons = value.buttons.map(normalizePromptText);
  if (!validContent(observation)) return null;
  const template = templateFor(observation, catalog);
  observation.templateId = template?.id ?? null;
  observation.templateVersion = template?.version ?? null;
  return observation;
}
function identity(observation) {
  if (observation.kind === 'dom') return `dom:${observation.instance.documentToken}:${observation.instance.nodeToken}`;
  return `native:${createHash('sha256').update(JSON.stringify([observation.title,
    observation.texts, observation.buttons, observation.hasField])).digest('hex')}`;
}
const initialAuto = () => ({ state: 'not_requested', reason: null, ruleId: null, attempted: 0, outcome: 'not_checked' });
const safeReason = reason => typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}(?![\s\S])/.test(reason) ? reason : 'unavailable';

export function createPageEvents({ now = Date.now, randomBytes = cryptoRandomBytes, probe,
  onEvent = () => {}, onState = () => {}, setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout, intervalMs = 1000, catalog = PAGE_PROMPT_CATALOG } = {}) {
  const events = new Map(), deliveries = new Map(), active = new Map();
  let source = null, generation = 0, timer = null, flight = null, wanted = false, disposed = false;
  let overflow = false, sequence = 0;
  let observer = { state: 'idle', reason: null, lastObservedAt: null, eventCount: 0 };
  const randomToken = () => {
    const bytes = Buffer.from(randomBytes(32));
    if (bytes.length !== 32) throw new Error('invalid_random_bytes');
    return bytes.toString('base64url');
  };
  let namespace = `p44_${randomToken()}`, namespaceBinding = null;
  const emit = (callback, value) => { try { callback(copy(value))?.catch?.(() => {}); } catch { /* Hooks do not alter state. */ } };
  const state = (status, reason = null) => {
    observer = { ...observer, state: status, reason: reason === null ? null : safeReason(reason), eventCount: events.size };
    emit(onState, observer);
  };
  function expire() {
    const at = now();
    for (const event of events.values()) if (event.expiresAt <= at) {
      event.lifecycle = 'expired';
      // Keep the identity/attempt tombstone, but discard expired observed prose.
      event.observation.title = ''; event.observation.texts = []; event.observation.buttons = [];
      event.observation.complete = false; event.observation.templateId = null; event.observation.templateVersion = null;
      for (const delivery of deliveries.values()) if (delivery.record.eventId === event.eventId &&
        delivery.record.model !== 'acknowledged') delivery.record.model = 'expired';
    }
  }
  function current(event) { return event && sameSource(event.source, source) && event.expiresAt > now(); }
  function ingest(observed) {
    expire();
    const observation = normalizeObservation(observed, source, catalog);
    if (!observation || disposed) return null;
    const key = identity(observation), previous = events.get(active.get(key));
    // An expired still-visible node/episode must not regain an automatic attempt.
    if (previous) {
      if (previous.lifecycle === 'open') previous.observation = observation;
      return copy(previous);
    }
    if (events.size >= 64 || overflow) { overflow = true; state('unavailable', 'event_capacity'); return null; }
    const at = now(), eventId = `event_${++sequence}_${randomToken()}`;
    const event = { schema: 1, eventId, source: copy(source), createdAt: at, expiresAt: at + 600000,
      lifecycle: 'open', observation, auto: initialAuto() };
    events.set(eventId, event); active.set(key, eventId);
    emit(onEvent, event); return copy(event);
  }
  function ingestProbe(result) {
    const serial = generation;
    if (!result || !validSource(result.source) || !sameSource(result.source, source)) return false;
    if (result.status !== 'observed') { state(result.status === 'cancelled' ? 'idle' : 'unavailable', result.reason); return false; }
    if (!Array.isArray(result.observations) || result.observations.length > 8 || typeof result.complete !== 'boolean' ||
      !Number.isFinite(result.observedAt)) { state('unavailable', 'invalid_probe'); return false; }
    const normalized = result.observations.map(o => normalizeObservation(o, source, catalog));
    if (normalized.some(o => !o)) { state('unavailable', 'invalid_probe'); return false; }
    const keys = new Set(normalized.map(identity));
    const sweepComplete = result.complete && normalized.every(o => o.complete);
    if (sweepComplete) for (const [key, eventId] of active) if (!keys.has(key)) {
      const event = events.get(eventId);
      if (event?.lifecycle === 'open') event.lifecycle = 'resolved';
      active.delete(key);
    }
    // More than one candidate or an incomplete sweep is notification-only.
    observer.lastObservedAt = result.observedAt;
    for (const observation of normalized) {
      if (serial !== generation || disposed || !sameSource(result.source, source)) break;
      if (!sweepComplete || normalized.length !== 1) observation.complete = false;
      ingest(observation);
    }
    if (serial !== generation || disposed) return true;
    state(overflow ? 'unavailable' : 'observing', overflow ? 'event_capacity' : null);
    return true;
  }
  function queue() {
    if (!wanted || disposed || !source || timer !== null || flight) return;
    timer = schedule(() => { timer = null; run(); }, Math.max(0, intervalMs));
    timer?.unref?.();
  }
  function run() {
    if (!wanted || disposed || !source || flight) return;
    if (typeof probe !== 'function') { wanted = false; state('unavailable', 'probe_unavailable'); return; }
    const serial = generation, captured = copy(source), controller = new AbortController();
    const owned = { controller, promise: null }; flight = owned;
    state('probing');
    owned.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted || serial !== generation) return null;
      return probe({ source: captured, target: copy(captured.target), namespace, signal: controller.signal });
    }).then(result => {
      if (result && serial === generation && !controller.signal.aborted && !disposed) ingestProbe(result);
    }, () => {
      if (serial === generation && !controller.signal.aborted && !disposed) state('unavailable', 'probe_failed');
    }).finally(() => { if (flight === owned) flight = null; queue(); });
  }
  function preempt(reason = 'preempted') {
    wanted = false; generation++;
    if (timer !== null) { unschedule(timer); timer = null; }
    flight?.controller.abort(reason); state('idle', reason);
  }
  function bind(next) {
    if (next !== null && !validSource(next)) throw new Error('invalid_source_binding');
    if (sameSource(next, source) || (next === null && source === null)) return;
    preempt('binding_changed');
    events.clear(); deliveries.clear(); active.clear(); overflow = false;
    const nextNamespaceBinding = next && JSON.stringify([next.connectionId, next.workerGeneration]);
    if (next && nextNamespaceBinding !== namespaceBinding) {
      namespace = `p44_${randomToken()}`; namespaceBinding = nextNamespaceBinding;
    }
    source = next && copy(next);
    observer = { state: 'idle', reason: next ? null : 'unbound_source', lastObservedAt: null, eventCount: 0 };
    emit(onState, observer);
  }
  function project(event) {
    const projected = copy(event), observation = projected.observation;
    // Unknown page prose may contain private drafts or injection. Never export it.
    if (!templateFor(observation, catalog)) {
      observation.title = '[Unreviewed page prompt]'; observation.texts = []; observation.buttons = [];
    }
    return projected;
  }
  function makeDelivery(eventId, route, routeBindingId) {
    expire();
    const event = events.get(eventId);
    if (!current(event) || !ROUTES.includes(route) || !id(routeBindingId)) throw new Error('invalid_delivery_binding');
    const key = `${eventId}:${route}`;
    let delivery = deliveries.get(key);
    if (delivery && delivery.record.routeBindingId !== routeBindingId) throw new Error('delivery_binding_changed');
    if (!delivery) {
      const token = randomToken();
      if ([...deliveries.values()].some(d => d.token === token)) throw new Error('duplicate_delivery_token');
      delivery = { token, record: { eventId, route, routeBindingId, transport: 'not_sent',
        model: 'not_acknowledged', reason: null, dispatchedAt: null, acceptedTurnId: null, acknowledgedAt: null } };
      deliveries.set(key, delivery);
    }
    return { schema: 1, event_id: eventId, task_generation: event.source.taskGeneration,
      delivery_token: delivery.token, route, event: project(event) };
  }
  function recordDelivery(eventId, route, receipt) {
    const delivery = deliveries.get(`${eventId}:${route}`);
    if (!delivery || !plain(receipt)) return false;
    const record = delivery.record;
    if (['not_sent', 'queued_busy', 'sent_unconfirmed', 'host_accepted', 'rejected', 'unknown', 'unavailable'].includes(receipt.transport))
      record.transport = receipt.transport;
    if (receipt.reason === null || typeof receipt.reason === 'string') record.reason = receipt.reason === null ? null : safeReason(receipt.reason);
    if (Number.isFinite(receipt.dispatchedAt)) record.dispatchedAt = receipt.dispatchedAt;
    // This is terminal Claude only: transport cannot assert model ACK or an accepted turn.
    return true;
  }
  function acknowledge(args, actual) {
    expire();
    const reject = reason => ({ status: 'rejected', reason });
    if (!exactKeys(args, ['event_id', 'task_generation', 'delivery_token']) || !id(args.event_id) ||
      !id(args.task_generation)) return reject('invalid_token');
    if (!sameContext(source, actual) || args.task_generation !== source?.taskGeneration) return reject('binding_changed');
    const event = events.get(args.event_id);
    if (!event) return reject('unknown_event');
    if (!sameContext(event.source, actual)) return reject('binding_changed');
    if (event.expiresAt <= now()) return reject('expired');
    if (typeof args.delivery_token !== 'string' || !TOKEN.test(args.delivery_token)) return reject('invalid_token');
    const bytes = Buffer.from(args.delivery_token, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== args.delivery_token) return reject('invalid_token');
    for (const delivery of deliveries.values()) if (delivery.record.eventId === event.eventId &&
      timingSafeEqual(Buffer.from(delivery.token, 'base64url'), bytes)) {
      const repeated = delivery.record.model === 'acknowledged';
      delivery.record.model = 'acknowledged';
      if (!repeated) delivery.record.acknowledgedAt = now();
      return { status: repeated ? 'already_acknowledged' : 'acknowledged', reason: null,
        route: delivery.record.route, lifecycle: event.lifecycle, auto: copy(event.auto) };
    }
    return reject('invalid_token');
  }
  function reserveAuto(eventId) {
    expire();
    const event = events.get(eventId), age = event && now() - event.observation.observedAt;
    if (!current(event) || event.lifecycle !== 'open' || event.auto.attempted || overflow ||
      age < 0 || age > 2000 || !templateFor(event.observation, catalog)) return false;
    event.auto = { state: 'queued', reason: null, ruleId: null, attempted: 1, outcome: 'not_checked' }; return true;
  }
  function recordAuto(eventId, outcome) {
    const event = events.get(eventId);
    if (!event || !exactKeys(outcome, ['state', 'reason', 'ruleId', 'attempted', 'outcome']) ||
      !['not_requested', 'queued', 'not_sent', 'sent', 'unknown'].includes(outcome.state) ||
      !(outcome.reason === null || typeof outcome.reason === 'string') || !(outcome.ruleId === null || id(outcome.ruleId)) ||
      ![0, 1].includes(outcome.attempted) || !['not_checked', 'confirmed', 'unconfirmed'].includes(outcome.outcome)) return false;
    if (['sent', 'unknown', 'queued'].includes(outcome.state) && !event.auto.attempted) return false;
    if (['sent', 'unknown'].includes(event.auto.state) && outcome.state !== event.auto.state) return false;
    event.auto = { ...copy(outcome), attempted: Math.max(event.auto.attempted, outcome.attempted),
      reason: outcome.reason === null ? null : safeReason(outcome.reason) }; return true;
  }
  return {
    bind, ingest, ingestProbe, preempt, makeDelivery, recordDelivery, acknowledge, reserveAuto, recordAuto,
    getNamespace() { return namespace; },
    resume() { if (!disposed && source) { wanted = true; queue(); } },
    async dispose(reason = 'disposed') { disposed = true; preempt(reason); await flight?.promise; },
    getEvent(eventId) { expire(); return events.has(eventId) ? copy(events.get(eventId)) : null; },
    snapshot() { expire(); return { events: copy([...events.values()]),
      deliveries: copy([...deliveries.values()].map(d => d.record)), observer: copy(observer) }; }
  };
}
