/* Actual index preparation/click and bridge transport with inert page/native
 * effects. No Chrome, product helper, Session, shared lock or hardware input. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import * as bridge from '../src/bridge.js';
import { viewportOrigin, toScreen, rectToScreenRect, intersectRect } from '../src/coords.js';
import { checkViewportGeometry, planScrollStep, chainDelta, aimClickable, MAX_SCROLL_BURSTS } from '../src/guard.js';
import { planTemporalKeys } from '../src/temporal.js';
import { compileWindowConversationCapsule } from './window-visibility-native.test.mjs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function actualFunction(name, required = true) {
  const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm');
  const hit = re.exec(source);
  if (!hit) { assert.equal(required, false, `missing production function ${name}`); return ''; }
  const end = source.indexOf('\n}', hit.index);
  assert.ok(end > hit.index, `complete production function ${name}`);
  return source.slice(hit.index, end + 2).replace(/^export /, '');
}
const requiredFunctions = ['windowOn', 'keepAgentAway', 'prepareNativeTarget', 'bringOnScreen',
  'prepareActivate', 'locateScript', 'locateTarget', 'originFor', 'scrollToTarget', 'clickDeliver',
  'postedNothing', 'post'];
// New pure/local source dependencies are listed explicitly before the baseline
// oracle is frozen; absence on the pre-change source is intentional.
const optionalFunctions = ['geometryTarget', 'geometryKey', 'sameGeometryBounds', 'invalidateGeometry',
  'acceptGeometryResult', 'observeGeometryFailure', 'saveFittedAgentPlacement', 'corroborateGeometry', 'locateForInput',
  // G2 r2: locateForInput reads behind the strict gate; these fakes answer as a clean page does (the script's own result).
  'gatedPageScript', 'gatedLocateScript', 'passGate'];
const copied = value => structuredClone(value);
const ids = { chromePid: 42, cgWindow: 70, windowId: 10, tabId: 5 };
const full = { x: 0, y: 0, w: 1200, h: 900 };
const usable = { x: 0, y: 30, w: 1200, h: 830 };
const display = { id: 1, isMain: true, boundsPoints: full };
const contained = (r, frame) => r.x >= frame.x && r.y >= frame.y &&
  r.w > 0 && r.h > 0 && r.x + r.w <= frame.x + frame.w && r.y + r.h <= frame.y + frame.h;
const rect = b => ({ x: b.left, y: b.top, w: b.width, h: b.height });

export async function runClickGeometryCase({ left = -300, userMoved = false, stalePreflight = true } = {}) {
  const events = [], sent = new Set();
  const initial = { left, top: 60, width: 1000, height: 700 };
  let actualBounds = copied(initial);
  const state = { byProfile: userMoved ? { Fixture: { windowId: 10,
    placed: { left: 50, top: 60, width: 1000, height: 700 }, display: 1 } } : {} };
  const target = () => ({ ...ids, bounds: copied(actualBounds), tabActive: true, minimized: false,
    url: 'https://window.test/fixture', keyWindowIsTarget: true, targetOnTop: true });
  const location = () => ({ ...ids, bounds: copied(actualBounds), view: {
    outerWidth: 1000, innerWidth: 1000, outerHeight: 700, innerHeight: 612,
    screenX: actualBounds.left, screenY: actualBounds.top, dpr: 2 },
    rect: { x: 20, y: 220, width: 40, height: 40 }, visible: { x: 20, y: 220, width: 40, height: 40 },
    land: { x: 24, y: 224, width: 32, height: 32 }, aim: { x: 40, y: 240 },
    hitOk: true, tag: 'button', text: 'Fixture', url: 'https://window.test/fixture', chain: [] });
  const pre = stalePreflight ? { loc: location(), at: Date.now(), listBefore: [], token: 'fixture-ack' } : null;
  const native = async intent => {
    events.push({ type: 'native', intent: copied(intent) });
    assert.equal(intent.kind, 'activate', 'fixture forbids other native writes');
    assert.equal(intent.tabId, ids.tabId); assert.equal(intent.windowId, ids.windowId);
    const beforeBounds = copied(actualBounds);
    if (intent.fitCurrent === true && left < 0) {
      // Explicit synthetic OS outcome, not a duplicate of the fitting algorithm.
      // Native geometry calculation is independently tested by the source capsule.
      actualBounds = { left: 0, top: 60, width: 1000, height: 700 };
    }
    const changed = actualBounds.left !== beforeBounds.left;
    return { ok: true, ...target(), inputDelivery: 'sent',
      ...(intent.fitCurrent === true ? { geometry: { mode: 'fit-current', beforeBounds,
        displayId: 1, branch: 'usable', changed, possiblyChanged: changed } } : {}) };
  };
  const ctx = { native, check: async () => { events.push({ type: 'check' }); },
    bindNativeTarget: async t => { assert.deepEqual([t.chromePid,t.cgWindow,t.windowId,t.tabId], [42,70,10,5]); events.push({ type: 'bind' }); },
    mark() {}, step() {}, sent: kind => sent.add(kind), unsent: kind => sent.delete(kind) };
  const session = { request: async req => {
    assert.equal(req.op, 'click', 'fixture permits only final click sink');
    events.push({ type: 'sink', req: copied(req), actualBounds: copied(actualBounds) });
    assert.ok(contained(rect(actualBounds), usable), 'accepted click requires the whole actual target inside the usable display');
    assert.ok(contained({ x: req.aim.x, y: req.aim.y, w: 1, h: 1 }, usable), 'actual click aim must be physically reachable');
    assert.equal(req.aim.x, actualBounds.left + 40, 'click must use the final physical page origin');
    assert.equal(req.aim.y, actualBounds.top + 88 + 240, 'click must use the final physical viewport');
    assert.deepEqual(req.rect, { x: actualBounds.left + 24, y: actualBounds.top + 88 + 224, w: 32, h: 32 });
    return { ok: true, landed: copied(req.aim), postedInput: 1 };
  } };
  const context = vm.createContext({
    assert, Number, String, Object, Array, Set, Map, Math, Date, JSON, structuredClone,
    BridgeError: bridge.BridgeError, viewportOrigin, toScreen, rectToScreenRect, intersectRect,
    checkViewportGeometry, planScrollStep, chainDelta, aimClickable, MAX_SCROLL_BURSTS,
    PLAN: { task: 'window fixture' }, TASK_HOLD: null, USER_POINTER: { x: 400, y: 400 },
    DISPLAYS: { at: Date.now(), list: [display] }, NATIVE_TARGETS: new Map(), SHOTS: new Map(), GEOMETRY_UNVERIFIED: new Set(),
    CALL: { getStore: () => null }, PRE_LOC_FRESH_MS: 1500,
    agentDisplay: () => 'main', pickAgentDisplay: ds => ds[0],
    inDisplay: (p,d) => p.x >= d.boundsPoints.x && p.x < d.boundsPoints.x+d.boundsPoints.w && p.y >= d.boundsPoints.y && p.y < d.boundsPoints.y+d.boundsPoints.h,
    agentState: async () => state, saveAgentState: async () => { events.push({ type: 'save' }); },
    debugLog() {}, ownershipNote: async () => '', boundsRect: rect,
    conversationInputCheck() {}, guardNativeSelect: async () => {}, guardNativeTarget: async () => {},
    armAck: async () => 'fixture-ack', between: () => 0,
    sleep: async () => { throw Error('fixture must not sleep'); },
    pointerTo: async () => { throw Error('fixture must not scroll'); },
    B: {
      chromeInfo: async () => target(), activateChrome: bridge.activateChrome,
      moveWindow: async () => { throw Error('user-moved/non-agent fixture must not be explicitly placed'); },
      cgevent: async args => { assert.deepEqual(args, ['displays']); return { displays: [copied(display)] }; },
      listTabs: async () => [], pageScript: async (_name, vars) => JSON.stringify(vars),
      evalInPage: async (_script, tab, opts) => {
        assert.equal(tab, ids.tabId); events.push({ type: 'locate', options: copied(opts ?? null) }); return location();
      },
      pageContentRect: async t => {
        assert.equal(t.chromePid, ids.chromePid); assert.equal(t.cgWindow, ids.cgWindow);
        events.push({ type: 'ax' });
        return { ok: true, pid: ids.chromePid, cgWindow: ids.cgWindow, source: 'ax-web-area',
          windowBounds: rect(actualBounds), rect: { x: actualBounds.left, y: actualBounds.top + 88, w: 1000, h: 612 } };
      },
    },
  });
  vm.runInContext([...requiredFunctions.map(x => actualFunction(x)),
    ...optionalFunctions.map(x => actualFunction(x, false))].join('\n'), context);
  const prep = await context.prepareActivate(ids.tabId, null, ctx);
  await context.clickDeliver(session, prep, ctx, { marker: 1, scroll_into_view: false }, pre, { deferAck: true });
  return { events, state, finalBounds: copied(actualBounds), sent: [...sent] };
}

export async function runPreparationOracles() {
  const results = [];
  for (const [name, options] of [
    ['offscreen non-agent', {}], ['offscreen user-moved', { userMoved: true }],
    ['visible healthy control', { left: 100 }],
  ]) {
    try { await runClickGeometryCase(options); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, code: error.code, nameOfError: error.name, message: error.message, stack: error.stack }); }
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runPreparationOracles();
  console.log(JSON.stringify({ layer: 'actual-index-and-bridge-with-inert-effects', results }, null, 2));
  if (results.some(r => !r.ok)) process.exitCode = 1;
}

// Independent changed-geometry corroboration: synthetic page/AX returns are
// physical facts; all selection, checks and mark transitions are actual source.
function evidenceFixture({ zoom = 1, dpr = 2, marked = true, aPatch, bPatch, axPatch,
  stopAt = 0, field = false, sourceChange = s => s } = {}) {
  const bounds = { left: -1100, top: -300, width: 1000, height: 700 };
  const target = { ...ids, bounds };
  const base = { ok: true, target: { tabId: 5, windowId: 10 }, bounds: copied(bounds),
    view: { innerWidth: 1000 / zoom, innerHeight: 612 / zoom, outerWidth: 1000 / zoom,
      outerHeight: 700 / zoom, screenX: -1100, screenY: -300, dpr },
    rect: { x: 20, y: 200, width: 60, height: 40 }, visible: { x: 20, y: 200, width: 60, height: 40 },
    aim: { x: 50, y: 220 }, land: { x: 26, y: 204, width: 48, height: 32 },
    hitOk: true, tag: field ? 'input' : 'button', chain: [], url: 'https://window.test/evidence' };
  const axBase = { ok: true, source: 'ax-web-area', pid: 42, cgWindow: 70,
    windowBounds: rect(bounds), rect: { x: -1100, y: -212, w: 1000, h: 612 } };
  const events = [], marks = new Set(marked ? ['42:70:10:5'] : []), stop = new bridge.BridgeError('user_cancelled', 'synthetic Stop');
  let reads = 0, checks = 0;
  const c = vm.createContext({ Number, String, Object, Array, Set, Map, Math, Date, JSON,
    BridgeError: bridge.BridgeError, GEOMETRY_UNVERIFIED: marks, NATIVE_TARGETS: new Map(), SHOTS: new Map(),
    PRE_LOC_FRESH_MS: 1500, viewportOrigin, checkViewportGeometry,
    B: { pageScript: async (_name, vars) => JSON.stringify(vars),
      evalInPage: async (_script, tab, options) => {
        assert.equal(tab, 5); events.push({ kind: 'read', options: copied(options ?? null) });
        const value = copied(base); if (field) value.focusToken = `fresh-${reads}`;
        const patch = reads++ === 0 ? aPatch : bPatch;
        if (patch) patch(value);
        return value;
      },
      pageContentRect: async t => {
        assert.deepEqual([t.chromePid, t.cgWindow], [42, 70]); events.push({ kind: 'ax' });
        const value = copied(axBase); return axPatch ? axPatch(value) : value;
      },
    },
  });
  const code = ['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry',
    'corroborateGeometry','locateForInput','locateScript','gatedPageScript','gatedLocateScript','passGate','originFor'].map(x => actualFunction(x)).join('\n');
  vm.runInContext(sourceChange(code), c);
  const ctx = { check: async () => { if (++checks === stopAt) throw stop; } };
  return { c, marks, events, base, target, stop,
    run: pre => c.locateForInput({ ...ids, target, windowBounds: rect(bounds) }, ctx,
      { MARKER: 1, MODE: field ? 'field' : 'target' }, pre),
    get reads() { return reads; } };
}

async function evidenceChecks() {
  let checks = 0, mutants = 0;
  const check = async (name, fn) => { await fn(); checks++; console.log(`geometry evidence ${checks}: ${name}`); };
  const failure = error => error instanceof bridge.BridgeError && error.code === 'window_changed';
  for (const zoom of [1,1.5,2]) for (const dpr of [1,2]) await check(`native/AX viewport zoom ${zoom}, DPR ${dpr}, negative origin`, async () => {
    const h = evidenceFixture({ zoom, dpr }), value = await h.run();
    assert.deepEqual(h.events.map(e => e.kind), ['read','ax','read']);
    assert.equal(value.bounds.left, -1100); assert.equal(h.marks.size, 0);
    for (const event of h.events.filter(e => e.kind === 'read')) assert.deepEqual(event.options,
      { exactTarget: { chromePid:42,cgWindow:70,windowId:10,tabId:5 } });
  });
  await check('unchanged verified fresh preflight retains zero-read fast path', async () => {
    const h = evidenceFixture({ marked:false }), pre = { loc: h.base, at: Date.now() };
    assert.equal(await h.run(pre), h.base); assert.equal(h.events.length,0);
  });
  await check('retained uncertainty overrides matching fresh preflight', async () => {
    const h = evidenceFixture(); await h.run({ loc: h.base, at:Date.now() });
    assert.deepEqual(h.events.map(e=>e.kind),['read','ax','read']);
  });
  await check('different preflight geometry forces independent corroboration', async () => {
    const h = evidenceFixture({ marked:false }); const loc=copied(h.base); loc.bounds.left-=100;
    await h.run({loc,at:Date.now()}); assert.deepEqual(h.events.map(e=>e.kind),['read','ax','read']);
  });
  const invalid = [
    ['A wrong tab', {aPatch:v=>{v.target.tabId=6;}}],
    ['A wrong window', {aPatch:v=>{v.target.windowId=11;}}],
    ['A missing native bounds', {aPatch:v=>{delete v.bounds;}}],
    ['A stale native bounds', {aPatch:v=>{v.bounds.width-=10;}}],
    ['A unsupported scale', {aPatch:v=>{v.view.outerWidth=1;}}],
    ['AX unavailable', {axPatch:()=>null}],
    ['AX wrong PID', {axPatch:v=>({...v,pid:43})}],
    ['AX wrong CG', {axPatch:v=>({...v,cgWindow:71})}],
    ['AX wrong source', {axPatch:v=>({...v,source:'guess'})}],
    ['AX shifted viewport', {axPatch:v=>({...v,rect:{...v.rect,x:v.rect.x+8}})}],
    ['AX changed window', {axPatch:v=>({...v,windowBounds:{...v.windowBounds,x:v.windowBounds.x+8}})}],
    ['B layout changed', {bPatch:v=>{v.land.x+=10;}}],
    ['B target removed', {bPatch:v=>{v.visible=null;v.hitOk=false;}}],
    ['B zoom changed', {bPatch:v=>{v.view.outerWidth/=2;}}],
    ['B wrong identity', {bPatch:v=>{v.target.windowId=11;}}],
  ];
  for (const [name,options] of invalid) await check(name+' refuses and retains mark',async()=>{
    const h=evidenceFixture(options);await assert.rejects(h.run(),failure);assert.ok(h.marks.has('42:70:10:5'));
  });
  await check('Stop after AX retains original error and uncertainty',async()=>{
    const h=evidenceFixture({stopAt:3});await assert.rejects(h.run(),e=>e===h.stop);assert.ok(h.marks.has('42:70:10:5'));
  });
  await check('field A/B fresh tokens remain valid and B token wins',async()=>{
    const h=evidenceFixture({field:true});const v=await h.run();assert.equal(v.focusToken,'fresh-1');assert.equal(h.marks.size,0);
  });
  const mutant = async (name,from,to,oracle) => {
    await oracle(s=>s);
    let replaced=false;
    const change=s=>{assert.equal(s.split(from).length,2,`unique mutation ${name}`);replaced=true;return s.replace(from,to);};
    await assert.rejects(oracle(change),e=>e?.code==='ERR_ASSERTION');assert.equal(replaced,true);mutants++;
    console.log(`geometry mutant ${mutants}: ${name}`);
  };
  await mutant('drop retained uncertainty veto','GEOMETRY_UNVERIFIED.has(key)','false',async sourceChange=>{
    const h=evidenceFixture({sourceChange});await h.run({loc:h.base,at:Date.now()});assert.equal(h.reads,2);
  });
  await mutant('drop AX PID identity','ax.pid !== target.chromePid || ','',async sourceChange=>{
    const h=evidenceFixture({sourceChange,axPatch:v=>({...v,pid:43})});await assert.rejects(h.run(),failure);
  });
  await mutant('drop stable A/B evidence','if (stable(a) !== stable(bRead)) fail();','if (false) fail();',async sourceChange=>{
    const h=evidenceFixture({sourceChange,bPatch:v=>{v.land.x+=10;}});await assert.rejects(h.run(),failure);
  });
  return {checks,mutants};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await evidenceChecks()));
}

// Actual capture/OCR/click_at closures. Only external reads, task scheduling,
// native preparation result and final input sink are inert adapters.
function shotFixture({ duringCapture, duringOcr, duringPrepare, marked = false, sourceChange = s=>s } = {}) {
  const target={...ids,bounds:{left:40,top:50,width:1000,height:700},tabActive:true,minimized:false,url:'https://window.test/shot'};
  const shots=new Map(),marks=new Set(marked?['42:70:10:5']:[]),events=[];
  const shot={rect:{x:40,y:138,w:1000,h:612},width:1000,height:612,data:'inert-png',fullPath:'/inert/shot.png',dispose:async()=>events.push('dispose')};
  let c;
  const ctx={check:async()=>{},step(){},sent(){},unsent(){}};
  const session={request:async request=>{events.push({sink:copied(request)});return {ok:true,landed:request.aim,postedInput:1};}};
  const prep=()=>({...ids,target:{...copied(target),geometry:{mode:'fit-current',beforeBounds:copied(target.bounds),displayId:1,branch:'usable',changed:false,possiblyChanged:false}}});
  const sandbox={Number,String,Object,Array,Set,Map,Math,Date,JSON,process:{env:{}},
    BridgeError:bridge.BridgeError,SHOTS:shots,GEOMETRY_UNVERIFIED:marks,NATIVE_TARGETS:new Map(),SHOT_FRESH_MS:300000,
    CALL:{getStore:()=>null},viewportOrigin,checkViewportGeometry,
    pausedCheck(){},cancelledError:()=>Error('synthetic cancel'),siteGate:async()=>{},boundsRect:rect,
    ownershipNote:async()=>'',targetLine:()=> 'tab=5',rememberNativeTarget(){},
    layoutText:()=>({texts:new Map([['t1',{x:100,y:100,text:'Fixture content',conf:1}]])}),textBlock:()=> 'Fixture content',
    estimateTextTokens:()=>5,PAGE_FEEDBACK:{render:()=> 'screen text'},
    persist:async fn=>fn(false),inputAction:async(_name,prepare,deliver)=>deliver(session,await prepare(null,null,ctx),ctx),
    prepareActivate:async()=>{const p=prep();if(duringPrepare)await duringPrepare({c,p,target,shots});return p;},
    guardNativeSelect:async()=>{},guardNativeTarget:async()=>{},conversationInputCheck(){},taskKey:()=>'',veilFor:()=>null,
    GUI_SERVICE:null,GUI_RESTORE:null,LEDGER:{tabs:new Map(),seq:0,reportedSeq:0},
    ROUTINES:{runner:{exportCarry:()=>null,importCarry(){}}},WARNED_NOT_MINE:new Set(),NOTED_TAKEN:new Set(),TASK_CANCELLED:null,PANEL_TASK:{text:'',at:0},normalizeConversationBinding:()=>null,
    B:{
      cgevent:async args=>{assert.deepEqual(copied(args),['displays']);return {locked:false,displaysAsleep:false,displays:[{}]};},
      chromeInfo:async()=>copied(target),axInput:async()=>null,
      capturePageContent:async requested=>{assert.deepEqual([requested.chromePid,requested.cgWindow],[42,70]);events.push('capture');if(duringCapture)await duringCapture({c,target,shots});return shot;},
      ocrImage:async()=>{events.push('ocr');if(duringOcr)await duringOcr({c,target,shots});return {lines:[],width:1000,height:612};},
      pageScript:async(_name,vars)=>JSON.stringify(vars),
      // G2 r2: click_at's locate comes behind the strict gate in one eval; this page is clean, so the eval is locate.js's.
      evalInPage:async(script,tab,options)=>{events.push({read:copied(options)});assert.equal(tab,5);const own=script.match(/\nreturn \(([\s\S]*)\);\n\}\)\(\)$/);assert.ok(own,'a gated eval');assert.equal(JSON.parse(own[1]).MODE,'scroll');return {ok:true,target:{tabId:5,windowId:10},bounds:copied(target.bounds),view:{outerWidth:1000,outerHeight:700,innerWidth:1000,innerHeight:612},scroller:'document',scrollTop:0,max:500};},
      pageContentRect:async requested=>{assert.deepEqual([requested.chromePid,requested.cgWindow],[42,70]);events.push('ax');return {ok:true,pid:42,cgWindow:70,source:'ax-web-area',windowBounds:rect(target.bounds),rect:{x:40,y:138,w:1000,h:612}};},
    }};
  c=vm.createContext(sandbox);
  vm.runInContext(sourceChange(['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','corroborateGeometry','locateScript','gatedPageScript','gatedLocateScript','passGate','originFor',
    'readOnlyCapture','readShot','screenshotTool','readScreen','outlineTop','clickAt','postedNothing','post','handoverCarry','applyCarry'].map(name=>actualFunction(name)).join('\n')),c);
  return {c,target,shot,shots,marks,events,capture:route=>route==='readScreen'?c.readScreen({target:copied(target),visibility:'visible',own:'',dom:'',why:'test',limit:100}):c.screenshotTool({tab:5,image:route==='image',ocr:route!=='image'}),click:()=>c.clickAt({tab:5,x:100,y:100})};
}
async function shotChecks(){
  let checks=0;
  const check=async(name,fn)=>{await fn();checks++;console.log(`geometry screenshot ${checks}: ${name}`);};
  for(const route of ['image','ocr','readScreen'])await check(route+' saves a copied exact capture baseline',async()=>{
    const h=shotFixture();await h.capture(route);const saved=h.shots.get(5);
    assert.deepEqual(copied(saved.baseline),{...ids,bounds:copied(h.target.bounds)});assert.equal(saved.pending,undefined);
    h.target.bounds.left+=100;h.shot.rect.x+=100;assert.equal(saved.baseline.bounds.left,40);assert.equal(saved.rect.x,40);
  });
  await check('unchanged screenshot uses its original coordinates',async()=>{
    const h=shotFixture();await h.capture('image');await h.click();const posted=h.events.find(e=>e.sink);assert.deepEqual(posted.sink.aim,{x:140,y:238});
  });
  await check('capture-time invalidation discards late pending image',async()=>{
    const h=shotFixture({duringCapture:({c,target})=>c.invalidateGeometry(target)});
    await assert.rejects(h.capture('image'),e=>e.code==='screenshot_changed');assert.equal(h.shots.size,0);assert.ok(h.events.includes('dispose'));
  });
  for(const route of ['ocr','readScreen'])await check(route+' cannot resurrect an invalidated OCR record',async()=>{
    const h=shotFixture({duringOcr:({c,target})=>c.invalidateGeometry(target)});await h.capture(route);assert.equal(h.shots.size,0);assert.ok(h.marks.has('42:70:10:5'));
  });
  for(const mode of ['changed','possiblyChanged','deleted','replaced','different-final'])await check('captured click closure refuses '+mode,async()=>{
    const h=shotFixture({duringPrepare:({p,shots})=>{
      if(mode==='deleted')shots.delete(5);else if(mode==='replaced')shots.set(5,{...shots.get(5)});
      else if(mode==='different-final')p.target.bounds.left+=20;else p.target.geometry[mode]=true;
    }});await h.capture('image');await assert.rejects(h.click(),e=>e.code==='screenshot_changed');assert.equal(h.events.filter(e=>e.sink).length,0);
  });
  await check('fresh capture retains mark until bounded marker-free A/AX/B',async()=>{
    const h=shotFixture({marked:true});await h.capture('image');assert.equal(h.marks.size,1);await h.click();assert.equal(h.marks.size,0);
    assert.equal(h.events.filter(e=>e.read).length,2);assert.equal(h.events.filter(e=>e==='ax').length,1);assert.equal(h.events.filter(e=>e.sink).length,1);
  });
  await check('legacy carry has no inferred baseline and cannot click',async()=>{
    const h=shotFixture();h.c.applyCarry({shots:[[5,{at:Date.now(),width:1000,height:612,rect:{x:40,y:138,w:1000,h:612},texts:[]}]]});
    assert.equal(h.shots.get(5).baseline,null);await assert.rejects(h.click(),e=>e.code==='screenshot_changed');assert.equal(h.events.filter(e=>e.sink).length,0);
  });
  await check('hot-swap copies capture geometry and preserves only valid exact marks',async()=>{
    const a=shotFixture({marked:true});await a.capture('image');const carry=a.c.handoverCarry();carry.geometryUnverified.push('bad','0:1:2:3','42:70:10:5:9');
    const b=shotFixture();b.c.applyCarry(carry);carry.shots[0][1].baseline.bounds.left=999;
    assert.deepEqual([...b.marks],['42:70:10:5']);assert.equal(b.shots.get(5).baseline.bounds.left,40);await b.click();assert.equal(b.marks.size,0);
  });
  const mutant=async(name,from,to,oracle)=>{
    await oracle(s=>s);await assert.rejects(oracle(s=>{assert.equal(s.split(from).length,2);return s.replace(from,to);}),e=>e.code==='ERR_ASSERTION');console.log('geometry screenshot mutant: '+name);
  };
  await mutant('old captured record survives preparation invalidation','SHOTS.get(info.tabId) === shot &&','true &&',async sourceChange=>{
    const h=shotFixture({sourceChange,duringPrepare:({shots})=>shots.delete(5)});await h.capture('image');await assert.rejects(h.click(),e=>e.code==='screenshot_changed');
  });
  await mutant('OCR resurrects invalidated capture','if (SHOTS.get(tabId) === record) record.texts = layout ? layout.texts : new Map();','SHOTS.set(tabId, record); record.texts = layout ? layout.texts : new Map();',async sourceChange=>{
    const h=shotFixture({sourceChange,duringOcr:({c,target})=>c.invalidateGeometry(target)});await h.capture('ocr');assert.equal(h.shots.size,0);
  });
  return {checks,mutants:2};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await shotChecks()));

async function missingCGReceiptCheck(){
  const hint={...ids,bounds:{left:0,top:30,width:1000,height:700}},marks=new Set(),shots=new Map([[5,{baseline:hint}]]);
  const receipt={ok:true,...hint,cgWindow:null,targetOnTop:true,keyWindowIsTarget:true,inputDelivery:'sent',operationId:'inert-missing-cg',
    stage:'activate_verify',stages:[{stage:'activate_fit',entered:true,acknowledged:true,delivery:'sent'}],geometry:{mode:'fit-current',beforeBounds:{...hint.bounds},displayId:1,branch:'usable',changed:true,possiblyChanged:true}};
  const c=vm.createContext({Number,String,Object,Array,Set,Map,Math,BridgeError:bridge.BridgeError,GEOMETRY_UNVERIFIED:marks,SHOTS:shots,NATIVE_TARGETS:new Map(),DISPLAYS:{at:1,list:[]},B:{activateChrome:async()=>receipt}});
  vm.runInContext(['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure','bringOnScreen'].map(x=>actualFunction(x)).join('\n'),c);
  await assert.rejects(c.bringOnScreen(5,hint,{check:async()=>{},native:()=>{throw Error('no direct native')}}),e=>{
    assert.equal(e.code,'no_cg_window');assert.equal(e.reply,receipt);assert.equal(e.stages,receipt.stages);assert.equal(e.geometry,receipt.geometry);
    assert.equal(e.operationId,'inert-missing-cg');assert.equal(e.inputDelivery,'sent');assert.equal(e.noRetry,true);return true;
  });
  assert.equal(shots.size,0);assert.deepEqual([...marks],['42:70:10:5']);
  console.log('legacy missing-CG diagnostic preserves original geometry receipt facts and refuses');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await missingCGReceiptCheck();

async function focusRefusalChecks(){
  const results=[];
  for(const mode of ['negative-sparse','negative-missing-geometry','negative-complete-geometry','negative-foreign-receipt','native-stop','native-focus-error','incomplete-success','initial-guard','healthy']) {
    try {
      const hint={...ids,bounds:{left:0,top:30,width:1000,height:700}},key='42:70:10:5';
      const other={...hint,cgWindow:99,windowId:99,tabId:6},marks=new Set(),shots=new Map([[5,{baseline:hint}],[6,{baseline:other}]]),events=[],diagnostics=[];
      const receipt={ok:true,...hint,targetOnTop:!mode.startsWith('negative-'),keyWindowIsTarget:true,inputDelivery:'sent',
        operationId:'focus-refusal-fixture',stage:'activate_verify',stages:[{stage:'activate_fit',entered:true,acknowledged:true,delivery:'sent'}],
        geometry:{mode:'fit-current',beforeBounds:{...hint.bounds},displayId:1,branch:'usable',changed:false,possiblyChanged:false}};
      if(['negative-missing-geometry','incomplete-success'].includes(mode))delete receipt.geometry;
      if(mode==='negative-sparse')for(const k of ['ok','windowId','geometry','inputDelivery','stage','stages','operationId'])delete receipt[k];
      if(mode==='negative-foreign-receipt'){receipt.cgWindow=99;receipt.windowId=99;receipt.tabId=6;}
      const original=new bridge.BridgeError(mode==='native-stop'?'aborted':'activate_unconfirmed','original native refusal');
      original.reply={...receipt,targetOnTop:false,inputDelivery:'unknown'};original.inputDelivery='unknown';original.noRetry=true;
      const c=vm.createContext({Number,String,Object,Array,Set,Map,Math,BridgeError:bridge.BridgeError,GEOMETRY_UNVERIFIED:marks,
        SHOTS:shots,NATIVE_TARGETS:new Map([[5,{pid:42,window:70}]]),DISPLAYS:{at:1,list:[]},B:{
          activateChrome:async()=>{events.push('activate');if(mode.startsWith('native-'))throw original;return receipt;},
          cgevent:async(args)=>{events.push('diagnostic');diagnostics.push({args:[...args],marked:marks.has(key),ownShot:shots.has(5),otherShot:shots.has(6)});
            return {windows:[{id:70,pid:42,layer:0,owner:'Google Chrome'}]};}
        }});
      vm.runInContext(['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure','bringOnScreen'].map(x=>actualFunction(x)).join('\n'),c);
      let value,failure;try{value=await c.bringOnScreen(5,hint,{check:async()=>{events.push('check');if(mode==='initial-guard')throw original;},native:()=>{throw Error('no direct native')}});}catch(e){failure=e;}
      // FOCUS4: targetOnTop false is a fact, not a veto (G-d): a complete receipt proceeds like a healthy one; an
      // incomplete or foreign one is refused by acceptGeometryResult (window_changed, exact invalidation kept). No
      // window-centre diagnostic sample is taken any more.
      const proceeds=['healthy','negative-complete-geometry'].includes(mode);
      if(proceeds||mode==='initial-guard') {
        assert.equal(failure,proceeds?undefined:original);assert.equal(value,proceeds?receipt:undefined);assert.equal(marks.size,0);assert.equal(shots.size,2);
      } else {
        assert.equal(value,undefined);assert.equal(marks.has(key),true);assert.equal(shots.has(5),false);assert.equal(shots.has(6),true);
        if(mode.startsWith('native-'))assert.equal(failure,original,'native Stop/focus errors retain object identity');
        else {
          assert.equal(failure?.code,'window_changed');
          assert.equal(failure.reply,receipt);assert.equal(failure.stages,receipt.stages);assert.equal(failure.geometry,receipt.geometry);
          assert.equal(failure.operationId,receipt.operationId);assert.equal(failure.inputDelivery,receipt.inputDelivery||'unknown');assert.equal(failure.noRetry,true);
        }
      }
      assert.deepEqual(events,mode==='initial-guard'?['check']:['check','activate']);
      assert.deepEqual(diagnostics,[]);
      results.push({mode,ok:true});
    } catch(error){results.push({mode,ok:false,error:error.stack});}
  }
  console.log(JSON.stringify({focusRefusals:results}));
  assert.equal(results.filter(r=>!r.ok).length,0,'focus diagnostics preserve refusal receipt and exact invalidation');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await focusRefusalChecks();

async function transportAndPlacementChecks(){
  const calls=[],native=async intent=>{calls.push(intent);return {ok:true,...ids,bounds:{left:0,top:30,width:800,height:600},geometry:{mode:'fit-current',beforeBounds:{left:0,top:30,width:800,height:600},displayId:1,branch:'usable',changed:false,possiblyChanged:false}};};
  await bridge.activateChrome(5,{windowId:10},{native,fitCurrent:true});assert.equal(calls[0].fitCurrent,true);
  await bridge.moveWindow(10,null,{native,fitCurrent:true});assert.deepEqual(calls[1],{kind:'moveWindow',windowId:10,fitCurrent:true});
  for(const options of [{fitCurrent:'true'},{fitCurrent:true,bounds:{}},{fitCurrent:true,displayId:1}])await assert.rejects(bridge.activateChrome(5,{windowId:10},{native,...options}),e=>e.code==='native_request_invalid'&&e.inputDelivery==='not_sent');
  await assert.rejects(bridge.newWindow('https://fixture.invalid',{left:0,top:0,width:800,height:600},null,{native,displayId:1,fitCurrent:true}),e=>e.code==='native_request_invalid');
  assert.equal(calls.length,2,'prohibited bridge options do not dispatch');
  const before={left:0,top:30,width:1200,height:800},final={left:0,top:30,width:1000,height:750};
  for(const kind of ['owned','user-moved','unregistered','entry-changed','placement']){
    const first={byProfile:kind==='unregistered'?{}:{P:{windowId:10,display:1,placed:{...before,...(kind==='user-moved'?{left:200}:{})}}}};
    const second=copied(first);if(kind==='entry-changed')second.byProfile.P.placed.left=500;
    let reads=0;const saves=[];
    const c=vm.createContext({Number,String,Object,Array,Math,agentState:async()=>++reads===1?first:second,saveAgentState:async value=>saves.push(copied(value))});
    vm.runInContext(['sameGeometryBounds','saveFittedAgentPlacement'].map(x=>actualFunction(x)).join('\n'),c);
    await c.saveFittedAgentPlacement({...ids,bounds:final},{mode:kind==='placement'?'placement':'fit-current',beforeBounds:before,displayId:2});
    assert.equal(saves.length,kind==='owned'?1:0,kind);
    if(kind==='owned')assert.deepEqual(saves[0].byProfile.P,{windowId:10,display:2,placed:final});
  }
  console.log('closed bridge intents and 5 same-operation placement provenance cases passed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await transportAndPlacementChecks();

// Exercise the actual hover/temporal consumers as well as their shared evidence
// function. Input acquisition is inert here; its complete lifecycle has its own
// existing tests. Native requests are captured, never sent to a product helper.
async function coordinateConsumerChecks(){
  let checks=0;
  for(const staleB of [false,true]){
    const h=evidenceFixture({bPatch:staleB?v=>{v.land.x+=20;}:undefined});
    const prep={...ids,target:h.target,windowBounds:rect(h.target.bounds)},requests=[];
    const ctx={check:async()=>{},step(){}},session={request:async r=>{requests.push(copied(r));return {ok:true};}};
    Object.assign(h.c,{toScreen,rectToScreenRect,aimClickable,CALL:{getStore:()=>null},TASK_HOLD:{},PLAN:{},
      targetLine:()=>'',taskKey:()=>'',veilFor:()=>null,activationHint:()=>null,prepareActivate:async()=>prep,
      clickPreflight:async()=>({tab:5,loc:{...copied(h.base),aim:{x:999,y:999}},at:Date.now()}),
      persist:async fn=>fn({}),inputAction:async(_label,prepare,action,options)=>{
        const pre=await options.preflight();return action(session,await prepare(pre,null,ctx),ctx,pre);
      }});
    vm.runInContext(['hoverTool','pointerTo','postedNothing'].map(x=>actualFunction(x)).join('\n'),h.c);
    if(staleB){await assert.rejects(h.c.hoverTool({tab:5,marker:1}),e=>e.code==='window_changed');assert.deepEqual(requests,[]);}
    else{
      await h.c.hoverTool({tab:5,marker:1});
      assert.deepEqual(requests,[{op:'move',to:{x:-1050,y:8},rect:{x:-1074,y:-8,w:48,h:32}}]);
      assert.deepEqual(h.events.map(e=>e.kind),['read','ax','read']);
    }
    checks++;
  }
  for(const mode of ['healthy','ax-disagreement','aim-moved']){
    const h=evidenceFixture({axPatch:mode==='ax-disagreement'?v=>({...v,rect:{...v.rect,w:800}}):undefined});
    const prep={...ids,target:h.target,windowBounds:rect(h.target.bounds)},requests=[],reads=[];
    let typed=0;
    h.c.B.evalInPage=async(script,tab,options)=>{
      // G2: temporal.js comes behind the strict gate in one eval (gatedPageScript); this fake page is clean, so the eval is the script's.
      const own=script.match(/\nreturn \(([\s\S]*)\);\n\}\)\(\)$/);assert.ok(own,'a gated eval');
      assert.equal(tab,5);const request=JSON.parse(own[1]).TEMPORAL;reads.push({request,options:copied(options)});
      const value={...copied(h.base),type:'month',expected:'2026-10',focused:true,selected:typed===2};
      if(mode==='aim-moved'&&request.mode==='aim')value.rect.x+=10;
      return value;
    };
    h.c.B.axInput=async request=>{
      assert.deepEqual(copied(request),{pid:42,window:70,point:{x:-1050,y:8}});
      return {frontmost:true,windowMatches:true,segments:[
        {description:'Year',min:1,max:9999,rect:{x:-1080,y:-12,w:28,h:40}},
        {description:'Month',min:1,max:12,rect:{x:-1048,y:-12,w:28,h:40}},
      ]};
    };
    const ctx={check:async()=>{},step(){},panel(){},sent(){},unsent(){}};
    const session={request:async r=>{requests.push(copied(r));if(r.op==='type'){typed++;return {ok:true,typed:r.text.length};}return {ok:true};}};
    Object.assign(h.c,{planTemporalKeys,rectToScreenRect,targetLine:()=>'',typedCount:s=>s.length,conversationInputCheck(){},
      CALL:{getStore:()=>null},sleep:async()=>{throw Error('fixture must not wait');}});
    vm.runInContext(['gatedPageScript','passGate','temporalState','typeTemporalInSession','post','postedNothing'].map(x=>actualFunction(x)).join('\n'),h.c);
    const action=()=>h.c.typeTemporalInSession(session,prep,ctx,{text:'2026-10',submit:false,marker:null},
      {type:'month',expected:'2026-10',selected:false,focused:true},'synthetic-token',null);
    if(mode==='healthy'){
      await action();assert.deepEqual(requests.map(r=>r.op),['click','type','click','type']);
      assert.deepEqual(requests.filter(r=>r.op==='click').map(r=>r.aim),[{x:-1066,y:8},{x:-1034,y:8}]);
      assert.deepEqual(requests.filter(r=>r.op==='type').map(r=>r.text),['2026','10']);
      assert.equal(h.marks.size,0);
      assert.ok(reads.some(r=>r.options.lean===true),'value/focus read remains lean');
      assert.ok(reads.filter(r=>r.request.mode==='aim').every(r=>r.options.exactTarget?.cgWindow===70&&!r.options.lean));
    }else{
      await assert.rejects(action(),e=>e.code===(mode==='ax-disagreement'?'window_changed':'temporal_field_changed'));
      assert.deepEqual(requests,[],'changed temporal geometry refuses before target input');
    }
    assert.deepEqual(reads[0].options,{exactTarget:ids});
    checks++;
  }
  console.log(`actual hover and temporal consumers: ${checks} cases`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await coordinateConsumerChecks();

// Real source-to-source composition over one inert child: actual JS preparation
// sends its untouched bridge intent, consumes the actual Owner/Session reply,
// corroborates independent page/AX values, then sends its actual click request to
// that same Session. Neither identity translation nor native replay is involved.
async function composedPreparationChecks(){
  const capsule=compileWindowConversationCapsule(),results=[];
  console.log(`composition artifacts: ${capsule.dir}`);
  const exact={chromePid:42,cgWindow:20,windowId:2,tabId:9};
  for(const spec of [
    {name:'offscreen',initialBounds:[-300,60,1000,700],expected:[0,60,1000,700],writes:1},
    {name:'oversized',initialBounds:[0,60,1400,1000],expected:[0,30,1200,830],writes:1},
    {name:'visible',initialBounds:[100,60,1000,700],expected:[100,60,1000,700],writes:0},
    {name:'ignored',initialBounds:[-300,60,1000,700],boundsEffect:'ignored',error:'native_geometry_unconfirmed'},
    {name:'stopped',initialBounds:[-300,60,1000,700],stopAfterBounds:true,error:'user_cancelled'},
    {name:'stale-ax',initialBounds:[-300,60,1000,700],staleAX:true,error:'window_changed'},
  ]){
    const conversation=await capsule.start({name:'compose-'+spec.name,begun:true,initialBounds:spec.initialBounds,
      ...(spec.boundsEffect?{boundsEffect:spec.boundsEffect}:{}),...(spec.stopAfterBounds?{stopAfterBounds:true}:{})});
    let latest=conversation.initial,operation=0;
    const events=[],requests=[],marks=new Set(),shots=new Map([[9,{old:true}]]);
    const physicalBounds=()=>{
      const p=latest.physical.find(w=>w.windowId===2);assert.equal(p.cgWindow,20);
      const [left,top,width,height]=p.bounds;return {left,top,width,height};
    };
    const target=()=>({...exact,bounds:physicalBounds(),tabActive:true,minimized:false,
      url:'https://target.invalid/',keyWindowIsTarget:true,targetOnTop:true});
    const location=()=>{
      const b=physicalBounds();return {ok:true,target:{windowId:2,tabId:9},bounds:b,
        view:{outerWidth:b.width,outerHeight:b.height,innerWidth:b.width,innerHeight:b.height-88,screenX:b.left,screenY:b.top,dpr:2},
        rect:{x:20,y:220,width:40,height:40},visible:{x:20,y:220,width:40,height:40},
        land:{x:24,y:224,width:32,height:32},aim:{x:40,y:240},hitOk:true,tag:'button',text:'Composed',chain:[],url:'https://target.invalid/'};
    };
    const pre={loc:location(),at:Date.now(),listBefore:[],token:'composed-ack'};
    const native=async intent=>{
      assert.deepEqual(copied(intent),{kind:'activate',windowId:2,tabId:9,fitCurrent:true});
      const request={op:'nativeChrome',schema:1,epoch:1,operationId:`compose-${++operation}`,intent:copied(intent)};
      requests.push(request);events.push('native');latest=await conversation.request(request);return latest.replies.at(-1);
    };
    const ctx={native,check:async()=>{},bindNativeTarget:async t=>{
      assert.deepEqual([t.chromePid,t.windowId,t.tabId,t.cgWindow],[42,2,9,20]);
      assert.deepEqual(conversation.initial.bind.target,{chromePid:42,windowId:2,tabId:9,cgWindow:20});
    },mark(){},step(){},sent(){},unsent(){}};
    const session={request:async request=>{
      assert.equal(request.op,'click');const b=physicalBounds();
      assert.deepEqual(copied(request.aim),{x:b.left+40,y:b.top+88+240});
      assert.deepEqual(copied(request.rect),{x:b.left+24,y:b.top+88+224,w:32,h:32});
      requests.push(copied(request));events.push('click');latest=await conversation.request(copied(request));return latest.replies.at(-1);
    }};
    const context=vm.createContext({Number,String,Object,Array,Set,Map,Math,Date,JSON,structuredClone,
      BridgeError:bridge.BridgeError,viewportOrigin,toScreen,rectToScreenRect,intersectRect,
      checkViewportGeometry,planScrollStep,chainDelta,aimClickable,MAX_SCROLL_BURSTS,
      PLAN:{task:'composed'},TASK_HOLD:null,USER_POINTER:{x:400,y:400},CALL:{getStore:()=>null},PRE_LOC_FRESH_MS:1500,
      DISPLAYS:{at:Date.now(),list:[display]},NATIVE_TARGETS:new Map(),SHOTS:shots,GEOMETRY_UNVERIFIED:marks,
      agentDisplay:()=> 'main',pickAgentDisplay:ds=>ds[0],inDisplay:()=>true,
      agentState:async()=>({byProfile:{}}),saveAgentState:async()=>{throw Error('unregistered target cannot be owned');},
      debugLog(){},ownershipNote:async()=>'',boundsRect:rect,conversationInputCheck(){},guardNativeSelect:async()=>{},guardNativeTarget:async()=>{},
      armAck:async()=> 'composed-ack',between:()=>0,sleep:async()=>{throw Error('composition must not wait');},
      pointerTo:async()=>{throw Error('composition must not scroll');},
      B:{chromeInfo:async()=>target(),activateChrome:bridge.activateChrome,
        moveWindow:async()=>{throw Error('composition cannot arbitrarily place a user window');},
        cgevent:async args=>{assert.deepEqual(copied(args),['displays']);return {displays:[copied(display)]};},
        listTabs:async()=>[],pageScript:async(_name,vars)=>JSON.stringify(vars),
        evalInPage:async(_script,tab,options)=>{
          assert.equal(tab,9);assert.deepEqual(copied(options),{exactTarget:exact});events.push('dom');return location();
        },
        pageContentRect:async t=>{
          assert.deepEqual([t.chromePid,t.cgWindow],[42,20]);events.push('ax');const b=physicalBounds();
          return {ok:true,pid:42,cgWindow:20,source:'ax-web-area',windowBounds:rect(b),
            rect:{x:b.left,y:b.top+88,w:b.width-(spec.staleAX?100:0),h:b.height-88}};
        }},
    });
    vm.runInContext([...requiredFunctions,...optionalFunctions].map(x=>actualFunction(x)).join('\n'),context);
    let failure=null,closed;
    try{
      try{
        const prep=await context.prepareActivate(9,null,ctx);
        await context.clickDeliver(session,prep,ctx,{marker:1,scroll_into_view:false},pre,{deferAck:true});
      }catch(e){failure=e;}
      if(spec.error){
        assert.equal(failure?.code,spec.error);assert.equal(requests.length,1,'refusal does not dispatch or replay target input');
        assert.deepEqual(latest.input,[]);assert.equal(latest.counts.bounds,1);assert.ok(marks.has('42:20:2:9'));assert.equal(shots.size,0);
        if(spec.stopAfterBounds){assert.equal(failure.reply.error,'aborted');assert.equal(failure.inputDelivery,'sent');assert.equal(failure.noRetry,true);}
      }else{
        assert.equal(failure,null,failure?.stack);assert.deepEqual(latest.physical.find(w=>w.windowId===2).bounds,spec.expected);
        assert.equal(latest.counts.bounds,spec.writes);assert.equal(requests.length,2);assert.deepEqual(latest.input.map(x=>x.kind),['down','up']);
        assert.deepEqual(latest.session.bounds,spec.expected);assert.equal(marks.size,0);
        assert.deepEqual(events,spec.writes?['native','dom','ax','dom','click']:['native','click']);
        for(const effect of latest.input)assert.ok(contained({x:effect.point[0],y:effect.point[1],w:1,h:1},usable));
      }
      assert.equal(latest.counts.owners,1);assert.equal(latest.session.sameOwner,true);assert.equal(latest.session.epoch,1);
    }finally{closed=await conversation.close();}
    results.push({name:spec.name,events,requests,final:latest,closed,error:failure?.code??null});
  }
  fs.writeFileSync(new URL('composition.json',pathToFileURL(capsule.dir+'/')),JSON.stringify(results,null,2),{flag:'wx'});
  console.log(JSON.stringify({composedCases:results.length,directory:capsule.dir,sameSession:true,realNativeEffects:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await composedPreparationChecks();

async function fieldHandoffGeometryChecks(){
  for(const mode of ['healthy','ax-disagreement','blocked-field','no-field']){
    const h=evidenceFixture({field:true,axPatch:mode==='ax-disagreement'?v=>({...v,pid:43}):undefined});
    const prep={...ids,target:h.target,windowBounds:rect(h.target.bounds)},requests=[],lifecycle=[];
    const ctx={check:async()=>{},sent(){},unsent(){},step(){},native:async()=>{throw Error('inert authority adapter only');},
      handToHuman:async()=>{lifecycle.push('handoff');}};
    const session={request:async req=>{requests.push(copied(req));return {ok:true};}};
    Object.assign(h.c,{toScreen,rectToScreenRect,planScrollStep,chainDelta,aimClickable,MAX_SCROLL_BURSTS,
      process:{env:{}},CALL:{getStore:()=>null},TASK_HOLD:null,BLOCKS:new Map(),LEDGER:{get:()=>null},S:{get:()=>false},
      taskKey:()=>'',inputBoundaryCheck(){},waitMinutes:()=>1,
      blockCheck:async()=>({tabId:5,url:'https://window.test/',blocked:mode==='blocked-field'}),
      blockToken:r=>r.alertToken,markBlocked:async()=>{lifecycle.push('notify');return {alertToken:'blocked'};},
      prepareNativeTarget:async()=>({target:h.target}),nativeMutation:async(_ctx,_kind,fn)=>fn(),
      prepareActivate:async()=>{lifecycle.push('activate');return prep;},
      inputAction:async(_label,prepare,action)=>action(session,await prepare(null,null,ctx),ctx),
      armAsk:async(_tab,_marker,_why,_ctx,token)=>{lifecycle.push('arm:'+token);return {token:'ask',done:true};},
      randomUUID:()=> 'alert',siteOf:()=> 'window.test',writeTaskState(){},tellUser:()=>{lifecycle.push('notify');},
      myEntry:async()=>null,noteAgentDone:async()=>{},waitForFieldLoop:async()=> 'waiting-field',waitForUserLoop:async()=> 'waiting',
      conversationInputCheck(){},sleep:async()=>{throw Error('field must not scroll');},
      pointerTo:async()=>{throw Error('field must not scroll');}});
    h.c.B.selectTab=async()=>{lifecycle.push('select');return {};};
    vm.runInContext(['waitForUserTool','scrollToTarget','post','postedNothing'].map(x=>actualFunction(x)).join('\n'),h.c);
    const action=()=>h.c.waitForUserTool({tab:5,reason:'synthetic value',field:mode==='no-field'?null:1});
    if(mode==='ax-disagreement'){
      await assert.rejects(action(),e=>e.code==='window_changed');assert.deepEqual(requests,[]);
      assert.deepEqual(lifecycle,['select','activate']);
    }else if(mode==='healthy'){
      assert.equal(await action(),'waiting-field');
      assert.deepEqual(requests,[{op:'click',to:{x:-1050,y:8},rect:{x:-1080,y:-12,w:60,h:40}}]);
      assert.deepEqual(lifecycle,['select','activate','arm:fresh-2','handoff','notify']);
      assert.deepEqual(h.events.map(e=>e.kind),['read','ax','read','read']);
    }else{
      assert.equal(await action(),'waiting');assert.deepEqual(lifecycle,['notify']);assert.deepEqual(requests,[]);assert.deepEqual(h.events,[]);
    }
  }
  console.log('field handoff geometry and excluded wait routes: 4 cases');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await fieldHandoffGeometryChecks();
