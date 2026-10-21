import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const extract = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const code = extract('function windowOn(', '\nasync function agentWindowBounds') + '\n' +
  extract('async function keepAgentAway(', '\nasync function saveAgentState');

async function run({ width = 2048, owned = true, moved = false, plan = true } = {}) {
  const display = { id: 1, isMain: true, boundsPoints: { x: 0, y: 0, w: width, h: 1100 } };
  let bounds = { left: 20, top: 40, width: width - 40, height: 1040 };
  const entry = { windowId: owned ? 7 : 99, placed: { ...bounds } };
  if (moved) bounds = { ...bounds, left: 30 };
  const calls = [];
  const context = vm.createContext({
    PLAN: plan ? { task: 'Complete the paper' } : null,
    Date, Math, Object, String,
    DISPLAYS: { at: 0, list: null },
    agentDisplay: () => 'main',
    pickAgentDisplay: ds => ds[0],
    inDisplay: () => true,
    agentState: async () => ({ byProfile: { P: entry } }),
    saveAgentState: async () => {},
    debugLog: () => {},
    B: {
      cgevent: async () => ({ displays: [display] }),
      chromeInfo: async () => ({ windowId: 7, bounds }),
      moveWindow: async (_id, b) => {
        calls.push(b);
        bounds = { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top };
      },
    },
  });
  vm.runInContext(code, context);
  await context.keepAgentAway(1, { x: 200, y: 200 });
  await context.keepAgentAway(1, { x: 200, y: 200 });
  return { calls, bounds, display };
}

const reserved = await run();
assert.equal(reserved.calls.length, 1, 'reserve the strip once, without moving it on later actions');
assert.equal(reserved.display.boundsPoints.w - reserved.calls[0].right, 460);
assert.ok(reserved.bounds.width >= 1000);
for (const options of [{ width: 1400 }, { owned: false }, { moved: true }, { plan: false }]) {
  assert.equal((await run(options)).calls.length, 0, JSON.stringify(options));
}
console.log('agent-window-layout: 5 ownership and layout cases passed');
