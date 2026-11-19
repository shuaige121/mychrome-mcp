import { createPageEvents, PAGE_PROMPT_CATALOG } from '../src/page-events.js';
export const target = { chromePid: 7, windowId: 11, tabId: 13, cgWindow: 17 };
export const source = { schema: 1, connectionId: 'connection', workerGeneration: 'worker',
  taskGeneration: 'task', provider: 'Claude', threadId: null, target };
export const context = Object.fromEntries(['connectionId', 'workerGeneration', 'taskGeneration'].map(k => [k, source[k]]));
export const template = PAGE_PROMPT_CATALOG.templates[0];
export const rule = { id: 'rule', enabled: true, origin: template.origins[0], templateId: template.id,
  templateVersion: template.version, semantic: 'keep_session', button: template.choices.keep_session };
export const settings = { version: 1, policy: 'auto_safe', rules: [rule] };
export function observation(patch = {}) {
  return { schema: 1, source: structuredClone(source), observedAt: 1000, kind: 'dom', origin: rule.origin,
    originEvidence: 'dom_current_document', title: template.title, texts: [...template.texts],
    buttons: [...template.buttons], hasField: false, complete: true, templateId: null, templateVersion: null,
    instance: { kind: 'dom', documentToken: 'document', nodeToken: 'node' }, ...patch };
}
export function fixture(options = {}) {
  let clock = 1000, entropy = 0;
  const events = createPageEvents({ now: () => clock, randomBytes: n => Buffer.alloc(n, ++entropy), ...options });
  events.bind(source);
  return { events, advance: ms => { clock += ms; }, event: patch => events.ingest(observation(patch)) };
}
export const ack = envelope => ({ event_id: envelope.event_id, task_generation: envelope.task_generation,
  delivery_token: envelope.delivery_token });
export const tick = () => new Promise(resolve => setImmediate(resolve));
