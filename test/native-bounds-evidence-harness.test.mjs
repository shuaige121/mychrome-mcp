/** Actual diagnostic installer/projector/writer/reader with inert Session transport.
 * Child processes run only generated JS and the unchanged terminal disposer. Artifacts are retained. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createBoundsEvidenceCollector, projectBoundsTrace, projectBoundsReceipt, readBoundsEvidenceReceipt,
  boundsEvidencePath, TRACE_BYTES, RECEIPT_BYTES } from './native-bounds-evidence.mjs';
import { installNativeBoundsEvidence, staticSafetyCheck, mcpReplyBoundary, LIVE_BUDGETS } from './reliability-reset-live.mjs';
import { terminalBinding, readTerminalReceipt, rpcFailureFact } from './harness-terminal.mjs';
import { normalizeReturnFocus } from '../src/guard.js';
import { redactText, redactToolResult } from '../src/privacy.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(),'native-bounds-evidence-harness-'));
const moduleURL = new URL('./native-bounds-evidence.mjs',import.meta.url), installerURL = new URL('./reliability-reset-live.mjs',import.meta.url);
const terminalURL = new URL('./harness-terminal.mjs',import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = Object.fromEntries([moduleURL,installerURL,terminalURL].map(u=>[fileURLToPath(u),hash(fs.readFileSync(u))]));
const execution = {schema:1,status:'started',directory:root,artifactsPreserved:true,pins,tests:[],invocations:[]};
const plain = x => JSON.parse(JSON.stringify(x));
const directory = label => fs.mkdtempSync(path.join(root,label+'-'));
const empty = () => ({state:'not_reached',attempts:0,target:null,expected:null,mapped:null,binding:'not_checked',structural:'not_checked',chrome:[],cg:[],
  ax:{state:'not_called',enumerationStatus:'unobserved',returned_count:null,rows:[]},relations:[],decisions:[]});
const trace = () => ({schema:1,status:'complete',reasons:[],requestedRect:[900,0,800,600],phases:{initial:{...empty(),state:'complete',attempts:1,target:'W1',mapped:'C1',
  chrome:[{w:'W1',rect:[0,0,800,600],index:1,minimized:false}],cg:[{c:'C1',rect:[0,0,800,600],onScreen:true}],
  decisions:[{w:'W1',c:'C1',branch:'unique_bounds'}]},pre_bounds:empty(),post_bounds:empty(),post_url:empty()}});
const request = (extra={}) => ({op:'nativeChrome',operationId:'private-operation-sentinel',epoch:7,intent:{kind:'newWindow',url:'https://selected.invalid/request'},...extra});
const reply = (extra={}) => ({ok:true,op:'nativeChrome',operationId:'private-operation-sentinel',epoch:8,tabId:91,windowId:72,chromePid:42,cgWindow:33,
  url:'https://selected.invalid/final',_boundsEvidence:trace(),...extra});
function harness({result=reply(),reject=false,sync=false,write,session:provided}={}) {
  const dir=directory('case'),binding='current-private-binding',calls=[],writes=[],promises=[];
  let opens=0,cancels=0,closes=0,getters=0,patch;
  const originalRequest=function(...args){assert.equal(this,session);calls.push(args);if(sync){if(reject)throw result;return result;}const pending=reject?Promise.reject(result):Promise.resolve(result);promises.push(pending);return pending;};
  const session=provided??{request:originalRequest,cancel(){cancels++;},close(){closes++;},get alive(){getters++;return true;}};
  const cancel=session.cancel,close=session.close,descriptor=Object.getOwnPropertyDescriptor(session,'alive');
  const collector=createBoundsEvidenceCollector({directory:dir,binding,write:(...args)=>{writes.push(args);return write?write(...args):fs.writeFileSync(...args);}});
  const api={__setBridgeForTests:value=>{patch=value;}},openArgs=[{inert:true},'rest'];
  installNativeBoundsEvidence(api,{openInputSession:(...args)=>{opens++;assert.deepEqual(args,openArgs);return session;}},collector);
  assert.deepEqual(Object.keys(patch),['openInputSession']);
  assert.equal(patch.openInputSession(...openArgs),session);assert.equal(opens,1);
  assert.equal(session.cancel,cancel);assert.equal(session.close,close);assert.deepEqual(Object.getOwnPropertyDescriptor(session,'alive'),descriptor);
  assert.equal(getters,0);
  return {dir,binding,session,collector,calls,writes,promises,getters:()=>getters,counters:()=>({opens,cancels,closes}),
    context:()=>collector.acceptCall('open_tab'),read:()=>JSON.parse(fs.readFileSync(boundsEvidencePath(dir),'utf8'))};
}
function dispatch(h,context=h.context(),req=request(),opts={raw:true,timeout:101}) {
  h.collector.markDispatched(context);
  const pending=h.collector.enterCall(context,()=>h.session.request(req,opts,'tail'));
  return {context,pending,req,opts};
}
const test=async(name,fn)=>{await fn();execution.tests.push(name);console.log('ok '+name);};
let failure;
try {
await test('closed trace/receipt projection validates facts, union references and bounded privacy',()=>{
  assert.deepEqual(projectBoundsTrace(trace()),trace());assert.equal(TRACE_BYTES,32768);assert.equal(RECEIPT_BYTES,65536);
  const legacy=trace();delete legacy.phases.post_url;
  assert.deepEqual(projectBoundsTrace(legacy),legacy,'exact legacy three-phase evidence remains readable');
  const postURL=trace();postURL.phases.post_url={...empty(),state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C1',binding:'matched'};
  assert.deepEqual(projectBoundsTrace(postURL),postURL,'post-URL references retain the same bounded union rule');
  postURL.phases.post_url.decisions=[{w:'W1',c:'C1',branch:'retained_exact'}];
  assert.deepEqual(projectBoundsTrace(postURL),postURL,'only the named retained_exact extension is admitted');
  for(const branch of ['document_exact','document_conflict_refused']) {
    const value=structuredClone(postURL);value.phases.post_url.decisions[0].branch=branch;
    assert.deepEqual(projectBoundsTrace(value),value,'Fresh document decisions preserve the existing closed schema.');
    value.phases.post_url.decisions[0].c='C2';
    assert.throws(()=>projectBoundsTrace(value),/bounds_evidence_invalid/,'Document decisions cannot invent an unobserved reference.');
  }
  for(const branch of ['order_pinned','retained',6,null]) {
    const invalid=structuredClone(postURL);invalid.phases.post_url.decisions[0].branch=branch;
    assert.throws(()=>projectBoundsTrace(invalid),/bounds_evidence_invalid/);
  }
  for(const base of [legacy,trace()]) for(const key of ['initial','pre_bounds','post_bounds']) {
    const absent=structuredClone(base);delete absent.phases[key];
    assert.throws(()=>projectBoundsTrace(absent),/bounds_evidence_invalid/,'both accepted sets require all legacy phases');
  }
  for(const change of [v=>{v.phases.extra=empty();},v=>{v.phases.post_url=undefined;},v=>{v.phases.post_url=null;},
    v=>{v.phases.post_url.raw='private-post-url';},v=>{v.phases.post_url.target='W1';},
    v=>{v.phases.post_url.chrome=Array(17).fill({w:'W1',rect:[0,0,800,600],index:1,minimized:false});}]) {
    const invalid=trace();change(invalid);assert.throws(()=>projectBoundsTrace(invalid),/bounds_evidence_invalid/);
  }
  const t=trace();t.phases.pre_bounds={...empty(),state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C1',binding:'matched'};
  assert.deepEqual(projectBoundsTrace(t),t,'prior-phase retained rows satisfy union references');
  const missing=structuredClone(t);missing.phases.pre_bounds.binding='window_missing';missing.phases.pre_bounds.mapped=null;
  assert.deepEqual(projectBoundsTrace(missing),missing,'observed absence is not alias loss');
  const capped=trace();capped.status='incomplete';capped.reasons=['row_cap'];capped.phases.initial.state='incomplete';capped.phases.initial.mapped='C2';
  assert.deepEqual(projectBoundsTrace(capped),capped);
  const invalids=[v=>{v.secret='diagnostic-private-text';},v=>{v.schema=2;},v=>{v.phases.initial.target='W17';},v=>{v.phases.initial.mapped='C33';},
    v=>{v.phases.initial.mapped='C2';},v=>{v.phases.initial.attempts=65536;},v=>{v.requestedRect=[0,0,Infinity,1];},v=>{v.requestedRect=null;},
    v=>{v.phases.initial.chrome[0].rect=[1000001,0,1,1];},v=>{v.phases.initial.chrome[0].index=0;},v=>{v.phases.initial.chrome[0].index=null;},
    v=>{v.phases.initial.ax.enumerationStatus='complete';},v=>{v.phases.initial.ax.returned_count=0;},v=>{v.phases.initial.decisions[0].w=null;},
    v=>{v.phases.initial.chrome=Array(17).fill(v.phases.initial.chrome[0]);},v=>{v.phases.initial.cg=Array(33).fill(v.phases.initial.cg[0]);},
    v=>{v.phases.initial.decisions=Array(33).fill(v.phases.initial.decisions[0]);},v=>{v.phases.initial.cg.push(v.phases.initial.cg[0]);},
    v=>{v.status='incomplete';v.reasons=['window_alias_cap'];v.phases.initial.target=null;},v=>{v.phases.post_bounds.target='W1';}];
  for(const change of invalids){const v=trace();change(v);assert.throws(()=>projectBoundsTrace(v),/bounds_evidence_invalid/);}
  let touched=0;for(const v of [Object.create(trace()),new Proxy(trace(),{ownKeys(){touched++;throw Error('private');}}),
    Object.defineProperty(trace(),'schema',{get(){touched++;return 1;}}),Object.assign(trace(),{toJSON(){touched++;throw Error('private');}})])
    assert.throws(()=>projectBoundsTrace(v),/bounds_evidence_invalid/);
  const arrayTrick=trace();Object.defineProperty(arrayTrick.phases.initial.chrome,'0',{get(){touched++;return {};}});
  assert.throws(()=>projectBoundsTrace(arrayTrick),/bounds_evidence_invalid/);assert.equal(touched,0);
  const phaseTrick=trace();Object.defineProperty(phaseTrick.phases,'post_url',{get(){touched++;return empty();}});
  assert.throws(()=>projectBoundsTrace(phaseTrick),/bounds_evidence_invalid/);assert.equal(touched,0);
  const phaseProxy=trace();phaseProxy.phases=new Proxy(phaseProxy.phases,{getOwnPropertyDescriptor(){touched++;throw Error('private');}});
  assert.throws(()=>projectBoundsTrace(phaseProxy),/bounds_evidence_invalid/);assert.equal(touched,0);
});
await test('first structure failure is optional, closed and distinct from exhaustive target stability',()=>{
  const changed=()=>{const value=trace();value.phases.initial.structural='changed';return value;};
  assert.deepEqual(projectBoundsTrace(changed()),changed(),'Legacy changed evidence remains readable without invented details.');
  for(const scope of ['target','other']) for(const field of ['duplicate_id','id','tabs','active_tab','bounds','minimized','index']) {
    const value=changed();value.phases.initial.firstStructureFailure={scope,field};
    assert.deepEqual(projectBoundsTrace(value),value);
  }
  for(const threePhases of [false,true]) {
    const value=changed();value.phases.initial.firstStructureFailure={scope:'snapshot',field:'count'};
    if(threePhases)delete value.phases.post_url;
    assert.deepEqual(projectBoundsTrace(value),value,'Extended failure detail coexists with legacy-shaped phases.');
  }
  const invalids=[p=>{p.firstStructureFailure={scope:'target',field:'count'};},p=>{p.firstStructureFailure={scope:'snapshot',field:'bounds'};},
    p=>{p.firstStructureFailure.scope='unknown';},p=>{p.firstStructureFailure.field='title';},p=>{p.firstStructureFailure.field=5;},
    p=>{p.firstStructureFailure.windowId=72;},p=>{p.firstStructureFailure.title='private';},p=>{p.firstStructureFailure.url='https://private.invalid';},
    p=>{p.firstStructureFailure.targetStable=true;},p=>{p.firstStructureFailure=undefined;},p=>{p.firstStructureFailure=null;},
    p=>{p.structural='same';},p=>{p.structural='unavailable';},p=>{p.structural='not_checked';},p=>{p.state='not_reached';}];
  for(const change of invalids) {
    const value=changed();value.phases.initial.firstStructureFailure={scope:'target',field:'bounds'};change(value.phases.initial);
    assert.throws(()=>projectBoundsTrace(value),/bounds_evidence_invalid/);
  }
  let touched=0;
  for(const detail of [new Proxy({scope:'target',field:'bounds'},{ownKeys(){touched++;throw Error('private');}}),
    Object.defineProperty({field:'bounds'},'scope',{enumerable:true,get(){touched++;return 'target';}})]) {
    const value=changed();value.phases.initial.firstStructureFailure=detail;
    assert.throws(()=>projectBoundsTrace(value),/bounds_evidence_invalid/);
  }
  const accessor=changed();Object.defineProperty(accessor.phases.initial,'firstStructureFailure',{enumerable:true,get(){touched++;return {scope:'target',field:'bounds'};}});
  assert.throws(()=>projectBoundsTrace(accessor),/bounds_evidence_invalid/);assert.equal(touched,0);
});
await test('original Session identity, getters, methods, one request delegation and same Promise/reply survive',async()=>{
  const result=Object.freeze(reply()),h=harness({result});
  const read=h.collector.acceptCall('read_page');h.collector.settleCall(read);
  const ctx=h.context(),req=request(),opts=Object.freeze({raw:true,timeout:123});
  let routed;const native=h.session.request;h.session.request=function(...args){routed=Reflect.apply(native,this,args);return routed;};
  const d=dispatch(h,ctx,req,opts);assert.equal(d.pending,routed);assert.equal(d.pending,h.promises[0]);assert.equal(await d.pending,result);
  assert.equal(h.calls.length,1);assert.notEqual(h.calls[0][0],req);assert.equal(Object.hasOwn(req,'_boundsEvidence'),false);
  assert.equal(h.calls[0][0]._boundsEvidence,1);assert.equal(h.calls[0][0].intent,req.intent);assert.equal(h.calls[0][1],opts);assert.equal(h.calls[0][2],'tail');
  assert.equal(h.session.alive,true);h.session.cancel();h.session.close();assert.equal(h.getters(),1);assert.deepEqual(h.counters(),{opens:1,cancels:1,closes:1});
  const receipt=h.read();assert.equal(receipt.callOrdinal,2);assert.equal(receipt.capture,'captured');assert.equal(receipt.outcome,'returned');
  assert.deepEqual(receipt.trace,trace());assert.deepEqual(h.writes[0][2],{mode:0o600,flag:'wx'});
  for(const s of ['private-operation-sentinel','current-private-binding','selected.invalid','chromePid','windowId','tabId','cgWindow','epoch'])assert.equal(h.writes[0][1].includes(s),false,s);
  h.collector.settleCall(ctx);h.collector.finalizeTerminal();assert.equal(h.writes.length,1);
  assert.deepEqual(await readBoundsEvidenceReceipt(h.dir,h.binding,process.pid,2),receipt);
});
await test('same failure object and advanced reply epoch retain capture; synchronous throws retain identity',async()=>{
  for(const sync of [false,true]){
    const error=Object.assign(Error('diagnostic-private-message'),{reply:reply({ok:false,epoch:9,error:'native_target_changed',stage:'native_binding'})});
    const h=harness({result:error,reject:true,sync}),ctx=h.context();let got;
    try{await dispatch(h,ctx).pending;}catch(e){got=e;}assert.equal(got,error);assert.equal(h.read().capture,'captured');assert.equal(h.read().outcome,'rejected');
    h.collector.settleCall(ctx);h.collector.finalizeTerminal();assert.equal(h.writes.length,1);
  }
});
await test('request admission affects only own-data nativeChrome/newWindow with a fresh selected call',async()=>{
  for(const req of [request({op:'status'}),request({intent:{kind:'openTab'}}),request({intent:{kind:'setBounds'}}),
    Object.create(request()),new Proxy(request(),{})]){
    const h=harness(),d=dispatch(h,undefined,req);await d.pending;assert.equal(h.calls[0][0],req);h.collector.settleCall(d.context);assert.equal(h.read().capture,'unavailable');
  }
  for(const req of [request({operationId:''}),request({epoch:-1}),Object.defineProperty(request(),'extra',{get(){throw Error('getter must not run');}})]){
    const h=harness(),d=dispatch(h,undefined,req);await d.pending;assert.equal(h.calls[0][0],req);assert.equal(h.read().reason,'malformed_or_uncorrelated');
  }
  const h=harness(),first=dispatch(h);await first.pending;h.collector.settleCall(first.context);const later=dispatch(h);await later.pending;
  assert.equal(h.calls[1][0],later.req);assert.equal(h.writes.length,1);assert.equal(h.read().callOrdinal,1);
});
await test('wrong operation/op/accessor/absent/malformed reply cannot become evidence',async()=>{
  let touched=0;
  const rows=[
    [reply({op:'other'}),'malformed_or_uncorrelated'],[reply({operationId:'other'}),'malformed_or_uncorrelated'],
    [null,'no_correlated_reply'],[reply({_boundsEvidence:undefined}),'trace_missing'],[reply({_boundsEvidence:null}),'projection_failure'],
    [reply({_boundsEvidence:{...trace(),raw:'diagnostic-private'}}),'projection_failure'],[new Proxy(reply(),{}),'malformed_or_uncorrelated'],
    [Object.create(reply()),'malformed_or_uncorrelated'],[Object.defineProperty(reply(),'operationId',{get(){touched++;return 'private-operation-sentinel';}}),'malformed_or_uncorrelated'],
    [Object.defineProperty(reply(),'_boundsEvidence',{get(){touched++;return trace();}}),'trace_missing']];
  for(const [result,reason] of rows){const h=harness({result}),d=dispatch(h);assert.equal(await d.pending,result);assert.equal(h.read().reason,reason);assert.equal(h.read().trace,null);}
  assert.equal(touched,0);
  for(const [error,stage,expected] of [['dialog_probe_unknown','native_read_deadline','dialog_failure'],['dialog_probe_unknown','native_read','trace_missing'],['terminated','native_read_deadline','trace_missing']]){
    const result=Object.assign(Error('private'),{reply:reply({_boundsEvidence:undefined,ok:false,error,stage})});
    const h=harness({result,reject:true});await assert.rejects(dispatch(h).pending,e=>e===result);assert.equal(h.read().reason,expected);
  }
  const h=harness({result:reply(),sync:true}),d=dispatch(h);assert.equal(d.pending.ok,true);assert.equal(h.read().reason,'no_correlated_reply');
});
await test('original request Promise is routing authority; another Session cannot supply its reply',async()=>{
  let release;const pending=new Promise(r=>{release=r;}),selected={request(){return pending;}};
  const h=harness({session:selected}),ctx=h.context();const other={request:()=>Promise.resolve(reply())};h.collector.wrapSession(other);
  await other.request(request());assert.equal(h.writes.length,0);
  const d=dispatch(h,ctx);assert.equal(d.pending,pending);await other.request(request());assert.equal(h.writes.length,0);
  release(reply());await pending;assert.equal(h.read().sessionOrdinal,1);assert.equal(h.read().capture,'captured');
});
await test('overlap before first await is unavailable; overlap after capture does not rewrite prior native outcome',async()=>{
  let resolve;const h=harness({session:{request:()=>new Promise(r=>{resolve=r;})}}),ctx=h.context();const d=dispatch(h,ctx);
  const overlap=h.collector.acceptCall('read_page');resolve(reply());await d.pending;assert.equal(h.read().reason,'overlap');
  h.collector.settleCall(overlap);h.collector.settleCall(ctx);assert.equal(h.writes.length,1);
  const after=harness(),a=dispatch(after);await a.pending;const bytes=fs.readFileSync(boundsEvidencePath(after.dir),'utf8');
  const later=after.collector.acceptCall('read_page');after.collector.settleCall(later);after.collector.settleCall(a.context);after.collector.finalizeTerminal();
  assert.equal(fs.readFileSync(boundsEvidencePath(after.dir),'utf8'),bytes);assert.equal(after.read().outcome,'returned');assert.equal(after.writes.length,1);
});
await test('settled/stale contexts, no native request and terminal pending consume at most one attempt',async()=>{
  for(const dispatched of [false,true]){const h=harness(),ctx=h.context();if(dispatched)h.collector.markDispatched(ctx);h.collector.settleCall(ctx);h.collector.finalizeTerminal();
    assert.equal(h.read().reason,dispatched?'no_new_window_request':'request_not_dispatched');assert.equal(h.writes.length,1);}
  let resolve;const h=harness({session:{request:()=>new Promise(r=>{resolve=r;})}}),d=dispatch(h);h.collector.finalizeTerminal();
  const before=h.writes[0][1];assert.equal(h.read().reason,'in_flight_at_terminal');h.collector.settleCall(d.context);resolve(reply());await d.pending;
  assert.equal(h.writes.length,1);assert.equal(h.writes[0][1],before);
  const none=harness();none.collector.finalizeTerminal();assert.equal(none.writes.length,0);
});
await test('write, EEXIST and serialization/projection failures never retry or replace product results',async()=>{
  for(const reject of [false,true]){
    const value=reject?Object.assign(Error('private'),{reply:reply()}):reply(),h=harness({result:value,reject,write:()=>{throw Error('inert I/O failure');}}),d=dispatch(h);
    if(reject)await assert.rejects(d.pending,e=>e===value);else assert.equal(await d.pending,value);
    assert.equal(h.collector.attempted,true);h.collector.settleCall(d.context);h.collector.finalizeTerminal();assert.equal(h.writes.length,1);
  }
  const collision=harness();fs.writeFileSync(boundsEvidencePath(collision.dir),'existing',{mode:0o600,flag:'wx'});const c=dispatch(collision);await c.pending;
  collision.collector.settleCall(c.context);collision.collector.finalizeTerminal();assert.equal(collision.writes.length,1);assert.equal(fs.readFileSync(boundsEvidencePath(collision.dir),'utf8'),'existing');
  let invoked=0;const value=reply({_boundsEvidence:Object.assign(trace(),{toJSON(){invoked++;throw Error('private');}})}),h=harness({result:value}),d=dispatch(h);
  assert.equal(await d.pending,value);assert.equal(invoked,0);assert.equal(h.read().reason,'projection_failure');h.collector.finalizeTerminal();assert.equal(h.writes.length,1);
});
await test('parent reader rejects stale binding/call, permissions, symlinks, excessive/partial/missing files',async()=>{
  const h=harness(),d=dispatch(h);await d.pending;const good=h.read();
  await assert.rejects(readBoundsEvidenceReceipt(h.dir,'old-binding',process.pid,1));await assert.rejects(readBoundsEvidenceReceipt(h.dir,h.binding,process.pid,2));
  const cases=[['partial','{',0o600],['empty','',0o600],['large','x'.repeat(RECEIPT_BYTES+1),0o600],['mode',JSON.stringify(good),0o644],
    ['extra',JSON.stringify({...good,raw:'private'}),0o600],['pid',JSON.stringify({...good,workerPid:process.pid+1}),0o600],
    ['reference',JSON.stringify({...good,trace:{...trace(),phases:{...trace().phases,initial:{...trace().phases.initial,mapped:'C2'}}}}),0o600]];
  for(const [label,bytes,mode]of cases){const dir=directory(label);fs.writeFileSync(boundsEvidencePath(dir),bytes,{flag:'wx',mode});await assert.rejects(readBoundsEvidenceReceipt(dir,h.binding,process.pid,1));}
  const absent=directory('absent');await assert.rejects(readBoundsEvidenceReceipt(absent,h.binding,process.pid,1));
  const linkdir=directory('filelink');fs.symlinkSync(boundsEvidencePath(h.dir),boundsEvidencePath(linkdir));await assert.rejects(readBoundsEvidenceReceipt(linkdir,h.binding,process.pid,1));
  const link=path.join(root,'directory-link');fs.symlinkSync(h.dir,link);await assert.rejects(readBoundsEvidenceReceipt(link,h.binding,process.pid,1));
  const wrongDir=directory('dirmode');fs.writeFileSync(boundsEvidencePath(wrongDir),JSON.stringify(good),{flag:'wx',mode:0o600});fs.chmodSync(wrongDir,0o755);
  await assert.rejects(readBoundsEvidenceReceipt(wrongDir,h.binding,process.pid,1));
  assert.equal(fs.statSync(h.dir).mode&0o777,0o700);assert.equal(fs.statSync(boundsEvidencePath(h.dir)).mode&0o777,0o600);
});
await test('static safety exemption is exact installer only',()=>{
  assert.deepEqual(staticSafetyCheck(installNativeBoundsEvidence.toString()),[]);
  assert.ok(staticSafetyCheck(installNativeBoundsEvidence.toString()+'\nB.openInputSession();').includes('direct_bridge:openInputSession'));
  assert.ok(staticSafetyCheck(installNativeBoundsEvidence.toString().replace('realOpen(...args)','realOpen(...args, 1)')).includes('direct_bridge:openInputSession'));
});
await test('actual public MCP and registry projection preserve selected IDs/URL and omit diagnostics/competitors',async()=>{
  const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8'),bridge=fs.readFileSync(new URL('../src/bridge.js',import.meta.url),'utf8'),tabs=fs.readFileSync(new URL('../src/tabs.js',import.meta.url),'utf8');
  function actual(name,source=index){const anchor=new RegExp(`(?:async )?function ${name}\\(`),start=source.search(anchor);assert.ok(start>=0,name);
    const end=source.indexOf('\n}',start);assert.ok(end>start,name);return source.slice(start,end+2);}
  const nrStart=tabs.indexOf('const newRecord = '),nrEnd=tabs.indexOf('\n});',nrStart)+4;assert.ok(nrStart>=0&&nrEnd>nrStart);
  async function project(enabled,failed=false){
    const target={tabId:91,windowId:72,chromePid:42,cgWindow:33,url:'https://selected.invalid/final',bounds:{left:900,top:0,width:800,height:600}};
    const nativeReply=reply({...target,geometry:{mode:'placement',beforeBounds:{...target.bounds},displayId:8,branch:'usable',changed:false,possiblyChanged:false},...(enabled?{_boundsEvidence:trace(),competingWindow:'diagnostic-competitor-sentinel'}:{_boundsEvidence:undefined})});
    if(!enabled)delete nativeReply._boundsEvidence;
    class BridgeError extends Error{constructor(code,message){super(message);this.code=code;}}
    const productFailure=Object.assign(new BridgeError('native_target_changed','safe native refusal'),{reply:{...nativeReply,ok:false,error:'native_target_changed',stage:'native_binding',bindingReason:'cg_mapping_mismatch'},
      stage:'native_binding',inputDelivery:'unknown',bindingReason:'cg_mapping_mismatch',creationAttempted:true,createdWindowId:72,createdTabId:91});
    const h=harness({result:failed?productFailure:nativeReply,reject:failed});
    const records=[],stateWrites=[],effects=[],CALL=new AsyncLocalStorage(),profile={dir:'Profile 3',name:'Profile',isDefault:false};
    const ctx={check:async()=>{},sent:k=>effects.push(k),unsent:k=>effects.push('unsent:'+k),settleScene:()=>{},
      native:intent=>h.session.request(request({intent}),{raw:true})};
    const B={chromeInfo:async()=>target,openNavigationObserver:async()=>({startedAt:123,close:async()=>{}})};
    const context=vm.createContext({normalizeReturnFocus,B,BridgeError,RoutineError:class extends Error{},CALL,PLAN:null,TASK_HOLD:null,WHY_VALUES:['user_asked'],NEW_WINDOW_SETTLE_MS:1,
      OPEN_NAVIGATIONS:new Map(),SHOTS:new Map(),NATIVE_TARGETS:new Map(),GEOMETRY_UNVERIFIED:new Set(),DISPLAYS:{at:0,list:null},OWNER_PID:444,Date:{now:()=>123},path,AGENT_STATE:'/inert/state.json',
      inputBoundaryCheck:()=>{},taskKey:()=>null,screenReady:async()=>'',agentDisplay:()=> 'away',resolveProfile:async()=>profile,
      agentWindowId:async()=>null,agentWindowBounds:async()=>({...target.bounds,display:{id:8,isMain:false}}),
      inputAction:async(_name,body)=>body(null,{scene:{appPid:1,chromePid:42}},ctx),prepareNativeTarget:async()=>({target}),
      agentState:async()=>({byProfile:{}}),mkdirP:async()=>{},writeFileP:async(_p,bytes)=>stateWrites.push(JSON.parse(bytes)),
      settledUrl:async()=>target.url,navigationObservation:async()=>({known:true,untouched:true}),agentName:()=> 'QA inert',
      put:async value=>records.push(plain(value)),getTab:async()=>records.at(-1),LEDGER:{apply:()=>{},get:()=>null},markTakenOver:async()=>{},retainOpenNavigation:()=>{},
      randomUUID:()=> 'inert',nextAction:()=>'',readPage:async()=>'tab=91 inert page',S:{get:()=>false},clip:s=>s,redactUrl:s=>s,redactText,redactToolResult,noteOutcome:()=>{},goneTabNote:()=>'',setupHint:()=>'',pauseGate:async()=>{},
      sessionError:r=>Object.assign(new BridgeError(r.error,'safe native refusal'),{reply:r})});
    const parts=[tabs.slice(nrStart,nrEnd),actual('registerTab',tabs),actual('nativeWrite',bridge),actual('newWindow',bridge),
      ...['geometryTarget','geometryKey','sameGeometryBounds','invalidateGeometry','acceptGeometryResult','observeGeometryFailure','actionReturnFocus','openTabFocusSelection','validateOpenTabArgs','registerSettled','openAndRegister','openTabTool','openTabRun','openTabAttach','nativeMutation','callToolInner','progressFor','callTool'].map(n=>actual(n)),
      'B.newWindow=newWindow; globalThis.callToolRun=req=>callToolInner(req.params.name,req.params.arguments,{},async()=>" "); globalThis.invoke=callTool;'];
    const capsule=parts.join('\n');fs.writeFileSync(path.join(h.dir,'actual-public-projection.js'),capsule,{flag:'wx'});vm.runInContext(capsule,context);
    const accepted=h.context();h.collector.markDispatched(accepted);
    const result=await h.collector.enterCall(accepted,()=>context.invoke({params:{name:'open_tab',arguments:{url:'https://selected.invalid/request',why:'user_asked'}}},{}));
    h.collector.settleCall(accepted);
    return {result:plain(result),records,stateWrites,effects,receipt:h.read()};
  }
  for(const failed of [false,true]){
    const off=await project(false,failed),on=await project(true,failed);
    for(const key of ['result','records','stateWrites','effects'])assert.deepEqual(on[key],off[key],key);
    assert.equal(on.receipt.capture,'captured');assert.equal(off.receipt.reason,'trace_missing');
    const publicBytes=JSON.stringify([on.result,on.records,on.stateWrites]);for(const s of ['_boundsEvidence','diagnostic-competitor-sentinel','private-operation-sentinel','requestedRect'])assert.equal(publicBytes.includes(s),false,s);
    if(!failed){assert.equal(on.records[0].tabId,91);assert.equal(on.records[0].windowId,72);assert.equal(on.records[0].expectedUrl,'https://selected.invalid/final');
      assert.match(on.result.content[0].text,/tab=91/);assert.ok(on.result.content[0].text.includes('https://selected.invalid/final'));}
    else{assert.equal(on.result.isError,true);assert.deepEqual(Object.keys(on.result.structuredContent.error).sort(),['bindingReason','code','inputDelivery','stage']);assert.equal(on.records.length,0);}
  }
});

await test('actual serializer failure consumes the attempt without replacing return/rethrow or retrying',async()=>{
  for(const reject of [false,true]){
    const value=reject?Object.assign(Error('private product error'),{reply:reply()}):reply();
    const h=harness({result:value,reject}),original=JSON.stringify;let serializations=0,observed;
    JSON.stringify=function(value,...args){
      if(value?.kind==='native_bounds'&&value.capture==='captured'&&++serializations===2)throw Error('inert final serialization failure');
      return Reflect.apply(original,JSON,[value,...args]);
    };
    let dispatched;
    try{dispatched=dispatch(h);try{observed=await dispatched.pending;}catch(error){observed=error;}}
    finally{JSON.stringify=original;}
    assert.equal(observed,value);assert.equal(dispatched.pending,h.promises[0]);assert.equal(serializations,2);
    assert.equal(h.collector.attempted,true);assert.equal(h.writes.length,0);assert.equal(fs.existsSync(boundsEvidencePath(h.dir)),false);
    h.collector.settleCall(dispatched.context);h.collector.finalizeTerminal();assert.equal(h.writes.length,0);
  }
});
await test('actual worker dispatch accepts before await and carries context through real MCP SDK to original Session',async()=>{
  const source=fs.readFileSync(installerURL,'utf8'),start=source.indexOf('  async function dispatch(m)'),end=source.indexOf("  process.on('message', m =>",start);
  assert.ok(start>=0&&end>start);const actual=source.slice(start,end);
  async function wire({overlap=false,mutant=false}={}){
    const h=harness(),events=[],contexts=[],originalAccept=h.collector.acceptCall;
    h.collector.acceptCall=tool=>{const context=originalAccept(tool);contexts.push(context);events.push('accept:'+tool);return context;};
    const server=new Server({name:'inert-bounds-server',version:'1'},{capabilities:{tools:{}}});
    let nativeCount=0;const product={content:[{type:'text',text:'inert MCP response'}]};
    server.setRequestHandler(CallToolRequestSchema,async req=>{
      events.push('sdk:'+req.params.name);
      if(req.params.name==='open_tab'){nativeCount++;const value=await h.session.request(request(),{raw:true});assert.equal(value.ok,true);}
      return product;
    });
    const client=new Client({name:'inert-bounds-client',version:'1'}),[serverSide,clientSide]=InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);await client.connect(clientSide);
    const gates=[];let freshCount=0;
    const fresh=()=>{events.push('fresh');freshCount++;if(overlap&&freshCount<=2)return new Promise(resolve=>gates.push(resolve));return Promise.resolve();};
    const context=vm.createContext({boundsEvidence:h.collector,releaseKind:null,fresh,client,requestContext:new AsyncLocalStorage(),eventSequence:0,controllers:new Map(),AbortController,
      workerState:{terminal:null,unknown:false},env:{MYCHROME_FIXTURE_CASE:'input'},retained:{},mcpReplyBoundary,LIVE_BUDGETS,rpcFailureFact,
      WRITE_TOOLS:new Set(['open_tab']),url:'http://127.0.0.1/fixture-inert',error:code=>Object.assign(Error(code),{code}),
      deny:code=>{throw Error(code);},own:async()=>({exact:true})});
    const route='evidence ? evidence.enterCall(acceptedCall, perform) : perform()';
    assert.equal(actual.split(route).length,2);
    const capsule=(mutant?actual.replace(route,'perform()'):actual)
      +'\nglobalThis.invoke=m=>requestContext.run(m.op===\'call\'?{id:m.id,tool:m.name,startedAt:Date.now(),responseAt:null,startedSequence:++eventSequence}:null,()=>dispatch(m));';
    fs.writeFileSync(path.join(h.dir,mutant?'worker-context-mutant.js':'actual-worker-dispatch.js'),capsule,{flag:'wx'});
    vm.runInContext(capsule,context);
    let first,second;
    try{
      first=context.invoke({op:'call',id:1,name:'open_tab',args:{url:'http://127.0.0.1/fixture-inert'}});
      if(overlap){
        second=context.invoke({op:'call',id:2,name:'read_page',args:{}});
        assert.deepEqual(events,['accept:open_tab','fresh','accept:read_page','fresh'],'accepted-call bookkeeping precedes either first await');
        assert.deepEqual(contexts.map(c=>c.callOrdinal),[1,2]);assert.ok(contexts.every(Object.isFrozen));assert.equal(nativeCount,0);
        gates[0]();assert.deepEqual(plain(await first),product);gates[1]();assert.deepEqual(plain(await second),product);
      }else assert.deepEqual(plain(await first),product);
      assert.equal(nativeCount,1);assert.equal(h.calls.length,1);assert.equal(h.writes.length,1);
      const receipt=h.read();
      if(overlap)assert.equal(receipt.reason,'overlap');
      else if(mutant){assert.equal(receipt.reason,'no_new_window_request');assert.equal(Object.hasOwn(h.calls[0][0],'_boundsEvidence'),false);
        assert.throws(()=>assert.equal(receipt.capture,'captured','worker context reaches the Session'),/worker context reaches the Session/);}
      else{assert.equal(receipt.capture,'captured');assert.equal(h.calls[0][0]._boundsEvidence,1);assert.equal(receipt.callOrdinal,1);}
    }finally{for(const release of gates)release();await Promise.allSettled([first,second].filter(Boolean));await client.close();await server.close();}
  }
  await wire();await wire({overlap:true});await wire({mutant:true});
});

await test('real disposable child saves sidecar before unchanged terminal immediate exit; deferred mutant fails diagnostic only',async()=>{
  const child=path.join(root,'terminal-child.mjs');
  fs.writeFileSync(child,`import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNativeBoundsEvidence } from ${JSON.stringify(installerURL.href)};
import { disposeTerminal } from ${JSON.stringify(terminalURL.href)};
const { createBoundsEvidenceCollector } = await import(process.argv[2]);
const directory=process.argv[3],binding='child-private-binding';
const result=${JSON.stringify(reply())},pending=Promise.resolve(result),session={request:()=>pending};
const collector=createBoundsEvidenceCollector({directory,binding});let patch;
installNativeBoundsEvidence({__setBridgeForTests:value=>{patch=value;}},{openInputSession:()=>session},collector);
assert.equal(patch.openInputSession(),session);
const context=collector.acceptCall('open_tab');collector.markDispatched(context);
const returned=collector.enterCall(context,()=>session.request(${JSON.stringify(request())},{raw:true}));
assert.equal(returned,pending);assert.equal(await returned,result);
process.stdout.write(JSON.stringify({productReturned:true,samePromise:true,sameReply:true})+'\\n');
collector.finalizeTerminal();
disposeTerminal({directory,binding,terminal:{code:'guard',stage:'harness'},call:{tool:'open_tab',startedAt:1,responseAt:2}});
throw Error('terminal returned');
`,{flag:'wx'});
  const original=fs.readFileSync(moduleURL,'utf8'),needle="reply => { try { capture(state, native, 'returned', reply); } catch {} }";
  assert.equal(original.split(needle).length,2,'exact mutation anchor');
  const mutated=original.replace("from './harness-terminal.mjs'",`from ${JSON.stringify(terminalURL.href)}`)
    .replace(needle,"reply => { setImmediate(() => { try { capture(state, native, 'returned', reply); } catch {} }); }");
  const mutant=path.join(root,'deferred-capture.mjs');fs.writeFileSync(mutant,mutated,{flag:'wx'});
  for(const [name,url]of [['actual',moduleURL.href],['mutant',pathToFileURL(mutant).href]]){
    const dir=directory('child-'+name),out=path.join(dir,'stdout.log'),err=path.join(dir,'stderr.log'),o=fs.openSync(out,'wx',0o600),e=fs.openSync(err,'wx',0o600),began=Date.now();
    let childResult;try{childResult=spawnSync(process.execPath,[child,url,dir],{stdio:['ignore',o,e]});}finally{fs.closeSync(o);fs.closeSync(e);}
    execution.invocations.push({argv:[process.execPath,child,url,dir],exitCode:childResult.status,signal:childResult.signal,elapsedMs:Date.now()-began,stdout:out,stderr:err,error:childResult.error?.message??null});
    assert.equal(childResult.error,undefined);assert.equal(childResult.signal,null);assert.equal(childResult.status,86,err);assert.equal(fs.statSync(err).size,0);
    assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')),{productReturned:true,samePromise:true,sameReply:true});
    const rawTerminal=JSON.parse(fs.readFileSync(path.join(dir,'terminal-receipt.json'),'utf8'));
    const terminal=await readTerminalReceipt(dir,'child-private-binding',rawTerminal.workerPid);assert.equal(terminal.terminal.code,'guard');
    const receipt=await readBoundsEvidenceReceipt(dir,'child-private-binding',rawTerminal.workerPid,1);
    const diagnostic=()=>assert.equal(receipt.capture,'captured','captured before immediate terminal exit');
    if(name==='actual')diagnostic();else{assert.equal(receipt.reason,'in_flight_at_terminal');assert.throws(diagnostic,/captured before immediate terminal exit/);}
  }
});

await test('BE-COV-01 complete order relations require exact ordered-list cardinality',()=>{
  const complete=trace(),p=complete.phases.initial;
  p.chrome.push({w:'W2',rect:[0,0,800,600],index:2,minimized:false});
  p.cg.push({c:'C2',rect:[0,0,800,600],onScreen:true});
  p.relations=[{w:'W2',kind:'order',counts:{hits:2,twins:null,visible:null,rivals:null,strict:null,loose:null,group:2},
    titleNonempty:null,titlesChanged:null,windows:['W1','W2'],cgs:['C1','C2']}];
  p.decisions=[{w:'W1',c:'C1',branch:'order'},{w:'W2',c:'C2',branch:'order'}];
  assert.deepEqual(projectBoundsTrace(complete),complete,'consistent complete order pairing remains representable');
  const incomplete=structuredClone(complete);incomplete.status='incomplete';incomplete.reasons=['projection_failure'];incomplete.phases.initial.state='incomplete';
  incomplete.phases.initial.relations[0].cgs=['C1'];
  assert.deepEqual(projectBoundsTrace(incomplete),incomplete,'explicit incomplete projection loss remains representable');
  const cases=[
    ['group/hits 2 but one CG alias',r=>{r.cgs=['C1'];}],
    ['group count differs from window list',r=>{r.counts.group=3;}],
    ['hit count differs from CG list',r=>{r.counts.hits=3;}],
    ['individually matched counts still have unequal pairing cardinality',r=>{r.windows=['W1'];r.counts.group=1;}],
  ];
  for(const [name,change]of cases){
    const invalid=structuredClone(complete);change(invalid.phases.initial.relations[0]);
    assert.throws(()=>projectBoundsTrace(invalid),/bounds_evidence_invalid/,`BE-COV-01: reject complete order relation: ${name}`);
  }
});

execution.status='passed';
} catch(error){failure=error;execution.status='failed';execution.failure={name:error.name,message:error.message,stack:error.stack};}
finally{execution.pinsAfter=Object.fromEntries(Object.keys(pins).map(p=>[p,hash(fs.readFileSync(p))]));
  execution.sourcesUnchanged=JSON.stringify(execution.pinsAfter)===JSON.stringify(pins);
  fs.writeFileSync(path.join(root,'execution-receipt.json'),JSON.stringify(execution,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:execution.status,tests:execution.tests.length,directory:root,artifactsPreserved:true}));
if(failure)throw failure;
