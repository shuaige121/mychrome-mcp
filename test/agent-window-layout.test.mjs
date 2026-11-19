import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BridgeError } from '../src/bridge.js';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const extract = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const geometry = ['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure'].map(name=>{const a=source.indexOf('function '+name+'(');assert.ok(a>=0);return source.slice(a,source.indexOf('\n}',a)+2);}).join('\n');
const code = geometry + '\n' + extract('function windowOn(', '\nasync function agentWindowBounds') + '\n' +
  extract('async function keepAgentAway(', '\nasync function saveAgentState');

async function run({ width = 2048, owned = true, moved = false, plan = true } = {}) {
  const display = { id: 1, isMain: true, boundsPoints: { x: 0, y: 0, w: width, h: 1100 } };
  let bounds = { left: 20, top: 40, width: width - 40, height: 1040 };
  const entry = { windowId: owned ? 7 : 99, placed: { ...bounds } };
  if (moved) bounds = { ...bounds, left: 30 };
  const calls = [];
  let checks = 0;
  const ctx = { check: async () => { checks++; }, native: async () => ({ ok: true }) };
  const context = vm.createContext({
    PLAN: plan ? { task: 'Complete the paper' } : null,
    Date, Math, Object, String, BridgeError, GEOMETRY_UNVERIFIED:new Set(), SHOTS:new Map(), NATIVE_TARGETS:new Map(),
    DISPLAYS: { at: 0, list: null },
    agentDisplay: () => 'main',
    pickAgentDisplay: ds => ds[0],
    inDisplay: () => true,
    agentState: async () => ({ byProfile: { P: entry } }),
    saveAgentState: async () => {},
    debugLog: () => {},
    B: {
      cgevent: async () => ({ displays: [display] }),
      chromeInfo: async () => ({ tabId:1,windowId:7,chromePid:42,cgWindow:70,bounds:{...bounds} }),
      moveWindow: async (_id, b, options) => {
        assert.equal(checks, calls.length + 1, 'native move must follow its guard');
        assert.equal(options.native, ctx.native);
        assert.equal(options.displayId,display.id);const beforeBounds={...bounds};
        calls.push(b);
        bounds = { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top };
        return {ok:true,tabId:1,windowId:7,chromePid:42,cgWindow:70,bounds:{...bounds},geometry:{mode:"placement",beforeBounds,displayId:display.id,branch:"usable",changed:true,possiblyChanged:true}};
      },
    },
  });
  vm.runInContext(code, context);
  // Each action passes the target its prepare just bound (prepareNativeTarget's chromeInfo).
  await context.keepAgentAway(await context.B.chromeInfo(1), { x: 200, y: 200 }, ctx);
  await context.keepAgentAway(await context.B.chromeInfo(1), { x: 200, y: 200 }, ctx);
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
