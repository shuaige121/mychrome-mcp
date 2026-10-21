import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { connectConversationHost } from '../src/conversation-host.js';

const THREAD = 'synthetic-thread-a', TURN = 'synthetic-turn-a';
let passed = 0;
async function eventually(check) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for synthetic host');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const event = (method, params = {}) => ({ method, params: { threadId: THREAD, ...params } });
const started = (id = TURN) => event('turn/started', { turn: { id, status: 'inProgress', items: [] } });
const question = (id = 'question:1', overrides = {}) => ({
  id, method: 'item/tool/requestUserInput',
  params: {
    threadId: THREAD, turnId: TURN, itemId: 'question-item', isBlocking: true,
    questions: [{
      id: 'choice', header: '选择', question: '选哪一个？',
      options: [{ label: 'Alpha', description: 'First' }, { label: 'Beta', description: 'Second' }],
    }],
    ...overrides,
  },
});
const answers = { choice: { answers: ['Beta'] } };

async function withHost(name, options, run) {
  if (typeof options === 'function') { run = options; options = {}; }
  const directory = await mkdtemp('/tmp/mychrome-conversation-test-');
  const socketPath = `${directory}/host.sock`;
  const server = http.createServer(), ws = new WebSocketServer({ server });
  const requests = [], updates = [];
  const state = {
    threadId: THREAD, status: 'idle', directInput: true, ...options.state,
    handler: options.handler ?? null,
  };
  let peer;
  function send(message) { peer.send(JSON.stringify(message)); }
  function reply(message, result) { send({ id: message.id, result }); }
  ws.on('connection', connection => {
    peer = connection;
    connection.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      requests.push(message);
      if (state.handler?.(message, { send, reply, peer }) === true) return;
      if (message.method === 'initialize') reply(message, {});
      else if (message.method === 'thread/read' || message.method === 'thread/resume') {
        reply(message, { thread: {
          id: state.threadId, status: { type: state.status },
          canAcceptDirectInput: state.directInput, turns: [],
          name: state.name ?? null,
          preview: 'Private first prompt is never projected', path: '/never-read-history',
        } });
      } else if (message.method === 'turn/start') {
        state.status = 'active';
        reply(message, { turn: { id: TURN, status: 'inProgress', items: [] } });
      } else if (message.method === 'turn/steer') reply(message, { turnId: message.params.expectedTurnId });
      else if (!message.method && message.result) {
        send(event('serverRequest/resolved', { requestId: message.id }));
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  await chmod(socketPath, options.mode ?? 0o600);
  const host = connectConversationHost({
    threadId: THREAD, socketPath, timeoutMs: options.timeoutMs ?? 100,
    onChange: s => updates.push(s),
  });
  try {
    await run({ host, state, requests, updates, send, reply, disconnect: () => peer.close() });
    passed++;
    console.log(`  ok  ${name}`);
  } finally {
    host.close();
    await eventually(() => ws.clients.size === 0);
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rmdir(directory);
  }
}
const connected = host => eventually(() => host.snapshot().status === 'connected');
const mutations = requests => requests.filter(x => /^turn\//.test(x.method || '') || x.result);

await withHost('binds only the exact loaded idle thread without history/settings overrides', async ({ host, requests }) => {
  await connected(host);
  assert.deepEqual(requests.map(x => x.method), ['initialize', 'initialized', 'thread/read', 'thread/resume']);
  assert.deepEqual(requests[2].params, { threadId: THREAD, includeTurns: false });
  assert.deepEqual(requests[3].params, { threadId: THREAD, excludeTurns: true });
  assert.equal(host.snapshot().canSend, true);
  assert.equal(JSON.stringify(host.snapshot()).includes('Private first prompt'), false);
  const r = await host.send({ text: 'Hello\n继续', nonce: 'send-1' });
  assert.equal(r.delivery, 'accepted');
  assert.deepEqual(mutations(requests)[0].params, {
    threadId: THREAD, input: [{ type: 'text', text: 'Hello\n继续' }], clientUserMessageId: 'send-1',
  });
});

await withHost('an active turn requires its live ID and uses the server turn precondition', {
  state: { status: 'active' },
}, async ({ host, send, requests }) => {
  await connected(host);
  assert.equal(host.snapshot().reason, 'active_turn_unknown');
  await assert.rejects(host.send({ text: 'Unknown turn', nonce: 'unknown-turn' }), { code: 'active_turn_unknown' });
  send(started());
  await eventually(() => host.snapshot().activeTurnId === TURN);
  const r = await host.send({ text: 'Continue', nonce: 'steer-1' });
  assert.equal(r.method, 'turn/steer');
  assert.equal(mutations(requests).length, 1);
  assert.equal(mutations(requests)[0].params.expectedTurnId, TURN);
});

await withHost('item-start metadata can discover the active turn without hydrating history', {
  state: { status: 'active' },
}, async ({ host, send }) => {
  await connected(host);
  send(event('item/started', {
    turnId: TURN, item: { id: 'tool-1', type: 'commandExecution', command: 'PRIVATE COMMAND' },
  }));
  await eventually(() => host.snapshot().activeTurnId === TURN);
  assert.equal(host.snapshot().canSend, true);
  assert.equal(JSON.stringify(host.snapshot()).includes('PRIVATE COMMAND'), false);
});

for (const directInput of [false, null, undefined]) {
  await withHost(`capability ${String(directInput)} refuses direct input before mutation`, {
    state: { directInput },
  }, async ({ host, requests }) => {
    await connected(host);
    assert.equal(host.snapshot().reason, 'direct_input_unsupported');
    await assert.rejects(host.send({ text: 'No', nonce: 'capability-1' }), { code: 'direct_input_unsupported' });
    assert.equal(mutations(requests).length, 0);
  });
}

await withHost('metadata identity mismatch does not join another thread', {
  state: { threadId: 'other-thread' },
}, async ({ host, requests }) => {
  await eventually(() => host.snapshot().status === 'unavailable');
  assert.equal(requests.some(x => x.method === 'thread/resume'), false);
});

await withHost('unloaded threads cannot be restored behind the GUI', {
  state: { status: 'notLoaded' },
}, async ({ host, requests }) => {
  await eventually(() => host.snapshot().status === 'unavailable');
  assert.equal(requests.some(x => x.method === 'thread/resume'), false);
});

await withHost('a non-private socket is not contacted', { mode: 0o666 }, async ({ host, requests }) => {
  assert.equal(host.snapshot().status, 'unavailable');
  await assert.rejects(host.send({ text: 'No', nonce: 'unavailable-1' }), { code: 'host_unavailable' });
  assert.equal(requests.length, 0);
});

await withHost('public feed rejects cross-thread, reasoning, tool output, and completed history', {
  state: { status: 'active' },
}, async ({ host, send }) => {
  await connected(host);
  send(event('item/started', {
    threadId: 'other-thread', turnId: TURN,
    item: { id: 'foreign', type: 'agentMessage', phase: 'commentary', text: 'FOREIGN' },
  }));
  send(event('item/completed', { turnId: TURN,
    item: { id: 'history', type: 'agentMessage', phase: 'final_answer', text: 'HISTORY' },
  }));
  send(event('item/started', { turnId: TURN,
    item: { id: 'reasoning', type: 'reasoning', text: 'PRIVATE REASONING' },
  }));
  send(event('item/started', { turnId: TURN,
    item: { id: 'visible', type: 'agentMessage', phase: 'commentary', text: '正在处理。\n```sh\nhidden\n```' },
  }));
  await eventually(() => host.snapshot().entries.length === 1);
  assert.equal(host.snapshot().entries[0].text, '正在处理。');
  assert.equal(/FOREIGN|HISTORY|PRIVATE REASONING|hidden/.test(JSON.stringify(host.snapshot())), false);
});

await withHost('a matching nonce coalesces double clicks and conflicting reuse fails', async ({ host, requests }) => {
  await connected(host);
  const a = host.send({ text: 'Only once', nonce: 'same-nonce' });
  const b = host.send({ text: 'Only once', nonce: 'same-nonce' });
  assert.strictEqual(a, b);
  await a;
  await assert.rejects(host.send({ text: 'Different', nonce: 'same-nonce' }), { code: 'nonce_conflict' });
  await host.send({ text: 'Only once', nonce: 'same-nonce' });
  assert.equal(mutations(requests).length, 1);
});

await withHost('busy rejects another concurrent submission without sending it', {
  handler(message, { reply }) {
    if (message.method !== 'turn/start') return false;
    setTimeout(() => reply(message, { turn: { id: TURN } }), 25);
    return true;
  },
}, async ({ host, requests }) => {
  await connected(host);
  const a = host.send({ text: 'First', nonce: 'first-nonce' });
  await eventually(() => mutations(requests).length === 1);
  await assert.rejects(host.send({ text: 'Second', nonce: 'second-nonce' }), { code: 'busy' });
  await a;
  assert.equal(mutations(requests).length, 1);
});

await withHost('capability and thread identity are revalidated at the moment of sending', async ({ host, state, requests }) => {
  await connected(host);
  state.directInput = false;
  await assert.rejects(host.send({ text: 'No longer allowed', nonce: 'revalidate-1' }), { code: 'direct_input_unsupported' });
  state.directInput = true;
  state.threadId = 'other-thread';
  await assert.rejects(host.send({ text: 'Wrong identity', nonce: 'revalidate-2' }), { code: 'thread_mismatch' });
  assert.equal(mutations(requests).length, 0);
});

await withHost('host errors are rejected once with no automatic alternate start or retry', {
  state: { status: 'active' },
  handler(message, { send }) {
    if (message.method !== 'turn/steer') return false;
    send({ id: message.id, error: { code: -32000, message: 'expected turn has ended' } });
    return true;
  },
}, async ({ host, send, requests }) => {
  await connected(host);
  send(started());
  await eventually(() => host.snapshot().activeTurnId === TURN);
  const input = { text: 'Stale steer', nonce: 'stale-steer' };
  await assert.rejects(host.send(input), { code: 'host_rejected', delivery: 'rejected', rpcCode: -32000 });
  await assert.rejects(host.send(input), { code: 'host_rejected' });
  assert.equal(mutations(requests).length, 1);
});

await withHost('disconnect after write is unknown delivery and neither nonce nor adapter can replay', {
  handler(message, { peer }) {
    if (message.method !== 'turn/start') return false;
    peer.close();
    return true;
  },
}, async ({ host, requests }) => {
  await connected(host);
  const input = { text: 'Once', nonce: 'lost-1' };
  await assert.rejects(host.send(input), { delivery: 'unknown' });
  await assert.rejects(host.send(input), { delivery: 'unknown' });
  await assert.rejects(host.send({ text: 'No retry', nonce: 'lost-2' }), { code: 'host_unavailable' });
  assert.equal(mutations(requests).length, 1);
});

await withHost('mutation timeout closes the adapter instead of silently resending', {
  timeoutMs: 40, handler: message => message.method === 'turn/start',
}, async ({ host, requests }) => {
  await connected(host);
  await assert.rejects(host.send({ text: 'Once', nonce: 'timeout-1' }), { code: 'response_timeout', delivery: 'unknown' });
  assert.equal(host.snapshot().status, 'disconnected');
  assert.equal(mutations(requests).length, 1);
});

await withHost('wrong-turn delivery receipt is unknown, never accepted', {
  state: { status: 'active' },
  handler(message, { reply }) {
    if (message.method !== 'turn/steer') return false;
    reply(message, { turnId: 'different-turn' });
    return true;
  },
}, async ({ host, send }) => {
  await connected(host);
  send(started());
  await eventually(() => host.snapshot().activeTurnId === TURN);
  await assert.rejects(host.send({ text: 'Once', nonce: 'wrong-receipt' }), { code: 'invalid_delivery_receipt', delivery: 'unknown' });
});

await withHost('only a request received on this connection can be answered', {
  state: { status: 'active' },
}, async ({ host, send, requests }) => {
  await connected(host);
  send(question('foreign-id', { threadId: 'other-thread' }));
  send(question('local:id'));
  await eventually(() => host.snapshot().pending.length === 1);
  assert.equal(host.snapshot().canSend, false);
  await assert.rejects(host.send({ text: 'A chat is not an answer', nonce: 'not-answer' }), { code: 'answer_pending_question' });
  await assert.rejects(host.send({ requestId: 'foreign-id', answers, nonce: 'foreign-answer' }), { code: 'request_expired' });
  const response = await host.send({ requestId: 'local:id', answers, nonce: 'local-answer' });
  assert.deepEqual(response, { status: 'resolved', delivery: 'unconfirmed', requestId: 'local:id' });
  const wire = mutations(requests);
  assert.deepEqual(wire, [{ id: 'local:id', result: { answers } }]);
  assert.equal(host.snapshot().pending.length, 0);
  assert.equal(JSON.stringify(host.snapshot()).includes('"answers"'), false);
});

for (const kind of ['resolved', 'completed', 'new-turn', 'idle']) {
  await withHost(`${kind} expires a pending request before any answer transmission`, {
    state: { status: 'active' },
  }, async ({ host, send, requests }) => {
    await connected(host);
    send(question());
    await eventually(() => host.snapshot().pending.length === 1);
    if (kind === 'resolved') send(event('serverRequest/resolved', { requestId: 'question:1' }));
    if (kind === 'completed') send(event('turn/completed', { turn: { id: TURN, status: 'completed' } }));
    if (kind === 'new-turn') send(started('replacement-turn'));
    if (kind === 'idle') send(event('thread/status/changed', { status: { type: 'idle' } }));
    await eventually(() => host.snapshot().pending.length === 0);
    await assert.rejects(host.send({ requestId: 'question:1', answers, nonce: 'expired-answer' }), { code: 'request_expired' });
    assert.equal(mutations(requests).length, 0);
  });
}

await withHost('request IDs preserve JSON number/string identity and cannot be resurrected', {
  state: { status: 'active' },
}, async ({ host, send, requests }) => {
  await connected(host);
  send(question(7));
  send(question('7', { isBlocking: false }));
  await eventually(() => host.snapshot().pending.length === 2);
  send(event('serverRequest/resolved', { requestId: 7 }));
  send(question(7));
  await eventually(() => host.snapshot().pending.length === 1);
  assert.strictEqual(host.snapshot().pending[0].requestId, '7');
  await host.send({ requestId: '7', answers, nonce: 'typed-id-answer' });
  assert.strictEqual(mutations(requests)[0].id, '7');
});

await withHost('resolved-before-request cannot resurrect a late or replayed question', {
  state: { status: 'active' },
}, async ({ host, send, requests }) => {
  await connected(host);
  send(event('serverRequest/resolved', { requestId: 'already-gone' }));
  send(question('already-gone'));
  send(started());
  await eventually(() => host.snapshot().activeTurnId === TURN);
  assert.equal(host.snapshot().pending.length, 0);
  await assert.rejects(host.send({ requestId: 'already-gone', answers, nonce: 'late-answer' }), { code: 'request_expired' });
  assert.equal(mutations(requests).length, 0);
});

await withHost('answer payload is snapshotted and secret answers never enter GUI snapshots', {
  state: { status: 'active' },
}, async ({ host, send, requests, updates }) => {
  await connected(host);
  send(question('secret-question', {
    questions: [{ id: 'secret', header: 'Secret', question: 'Enter a synthetic secret', isSecret: true }],
  }));
  await eventually(() => host.snapshot().pending.length === 1);
  const inputAnswers = { secret: { answers: ['SYNTHETIC_PRIVATE_VALUE'] } };
  const p = host.send({ requestId: 'secret-question', answers: inputAnswers, nonce: 'secret-answer' });
  inputAnswers.secret.answers[0] = 'CHANGED_AFTER_SUBMIT';
  await p;
  assert.equal(mutations(requests)[0].result.answers.secret.answers[0], 'SYNTHETIC_PRIVATE_VALUE');
  assert.equal(/SYNTHETIC_PRIVATE_VALUE|CHANGED_AFTER_SUBMIT/.test(JSON.stringify(updates)), false);
});

await withHost('invalid answers and approval requests are never translated into ordinary replies', {
  state: { status: 'active' },
}, async ({ host, send, requests }) => {
  await connected(host);
  send({ ...question('approval-id'), method: 'item/permissions/requestApproval' });
  send(question('real-question'));
  await eventually(() => host.snapshot().pending.length === 1);
  await assert.rejects(host.send({ requestId: 'real-question', answers: { wrong: { answers: ['Yes'] } }, nonce: 'bad-answer' }), { code: 'invalid_answers' });
  await assert.rejects(host.send({ requestId: 'approval-id', answers, nonce: 'not-permission' }), { code: 'request_expired' });
  assert.equal(mutations(requests).length, 0);
});

await withHost('an unanswered receipt remains submitted/unconfirmed and cannot be sent twice', {
  state: { status: 'active' }, timeoutMs: 40,
  handler: message => message.result !== undefined,
}, async ({ host, send, requests }) => {
  await connected(host);
  send(question());
  await eventually(() => host.snapshot().pending.length === 1);
  const input = { requestId: 'question:1', answers, nonce: 'unconfirmed-answer' };
  assert.equal((await host.send(input)).status, 'submitted');
  assert.equal((await host.send(input)).delivery, 'unconfirmed');
  await assert.rejects(host.send({ ...input, nonce: 'different-answer-nonce' }), { code: 'request_expired' });
  assert.equal(mutations(requests).length, 1);
});

await withHost('disconnect expires all pending requests without replying to any', {
  state: { status: 'active' },
}, async ({ host, send, disconnect, requests }) => {
  await connected(host);
  send(question());
  await eventually(() => host.snapshot().pending.length === 1);
  disconnect();
  await eventually(() => host.snapshot().status === 'disconnected');
  assert.equal(host.snapshot().pending.length, 0);
  await assert.rejects(host.send({ requestId: 'question:1', answers, nonce: 'gone-answer' }), { code: 'host_unavailable' });
  assert.equal(mutations(requests).length, 0);
});

await withHost('new live blocking question cannot be erased by an older in-flight metadata snapshot', {
  handler: (() => {
    let reads = 0;
    return (message, { send, reply }) => {
      if (message.method !== 'thread/read' || ++reads !== 2) return false;
      // The server has captured idle status, then awaits read_state before returning it.
      send(started());
      send(question('fresh-pending'));
      setTimeout(() => reply(message, { thread: {
        id: THREAD, status: { type: 'idle' }, canAcceptDirectInput: true, turns: [],
      } }), 10);
      return true;
    };
  })(),
}, async ({ host, requests }) => {
  await connected(host);
  await assert.rejects(host.send({ text: 'Ordinary input', nonce: 'snapshot-race' }), {
    code: 'thread_state_changed', delivery: 'not_sent',
  });
  assert.equal(mutations(requests).length, 0);
  assert.equal(host.snapshot().pending[0].requestId, 'fresh-pending');
  assert.equal(host.snapshot().activeTurnId, TURN);
  assert.equal(host.snapshot().canSend, false);
});

await withHost('joining keeps newer live pending state when resume metadata is older', {
  handler(message, { send, reply }) {
    if (message.method !== 'thread/resume') return false;
    send(started());
    send(question('joining-pending'));
    reply(message, { thread: {
      id: THREAD, status: { type: 'idle' }, canAcceptDirectInput: true, name: 'Bound conversation',
    } });
    return true;
  },
}, async ({ host, requests }) => {
  await connected(host);
  assert.equal(host.snapshot().pending[0]?.requestId, 'joining-pending');
  assert.equal(host.snapshot().activeTurnId, TURN);
  assert.equal(host.snapshot().threadStatus, 'active');
  assert.equal(host.snapshot().title, 'Bound conversation');
  assert.equal(mutations(requests).length, 0);
});

await withHost('late accepted receipt cannot replace a newer live turn or clear its question', {
  handler(message, { send, reply }) {
    if (message.method !== 'turn/start') return false;
    send(started());
    send(event('turn/completed', { turn: { id: TURN, status: 'completed' } }));
    send(started('newer-turn'));
    send(question('newer-question', { turnId: 'newer-turn' }));
    setTimeout(() => reply(message, { turn: { id: TURN, status: 'completed' } }), 10);
    return true;
  },
}, async ({ host, requests }) => {
  await connected(host);
  const r = await host.send({ text: 'First turn', nonce: 'late-receipt' });
  assert.equal(r.delivery, 'accepted');
  assert.equal(r.turnId, TURN);
  assert.equal(host.snapshot().activeTurnId, 'newer-turn');
  assert.equal(host.snapshot().pending[0]?.requestId, 'newer-question');
  assert.equal(mutations(requests).length, 1);
});

await withHost('title is exact bound-thread name metadata, never preview or user input', {
  state: { name: '真实会话标题' },
}, async ({ host, state }) => {
  await connected(host);
  assert.equal(host.snapshot().title, '真实会话标题');
  state.name = null;
  await host.send({ text: 'Do not use this as a title', nonce: 'title-check' });
  assert.equal(host.snapshot().title, null);
  assert.equal(JSON.stringify(host.snapshot()).includes('Private first prompt'), false);
});

console.log(`\nConversation host: ${passed} checks passed (synthetic Unix sockets only).`);
