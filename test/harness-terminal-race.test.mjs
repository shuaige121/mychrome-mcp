// Real startGap/endTaskHoldNow/releaseKept continuations and each real harness
// seal run inside disposable inert workers. No product import or desktop IO.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTerminalReceipt, productErrorFact, workerFailureFact, rpcFailureFact } from './harness-terminal.mjs';
import { LIVE_BUDGETS } from './reliability-reset-live.mjs';
const read = name => fs.readFile(new URL(name,import.meta.url),'utf8');
const [index,guard,panel,reliability,terminal,bridge]=await Promise.all([
 read('../src/index.js'),read('../src/guard.js'),read('./click-delta-live.mjs'),read('./reliability-reset-live.mjs'),read('./harness-terminal.mjs'),read('../src/bridge.js')]);
function production(src,name) { const start=src.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0,name);return src.slice(start,src.indexOf('\n}',start)+2); }
const runner=panel.slice(panel.indexOf('async function runPanelHarness('),panel.indexOf('\nasync function panelScenario('));
const denyStart=reliability.indexOf('  const deny = (reason, facts = {}) => {');
const deny=reliability.slice(denyStart,reliability.indexOf('\n  };',denyStart)+5);
const dispatchStart=reliability.indexOf('  async function dispatch(m) {');
const dispatch=reliability.slice(dispatchStart,reliability.indexOf('\n  }',dispatchStart)+4);
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mychrome-terminal-race-'));
const actualHelper=new URL('./harness-terminal.mjs',import.meta.url).href;
const mutantHelper=path.join(temp,'terminal-mutant.mjs');
assert.ok(terminal.includes('process.exit(exitCode);'));
await fs.writeFile(mutantHelper,terminal.replace('process.exit(exitCode);','/* immediate exit removed for negative regression */'));
const fixture=path.join(temp,'worker.mjs');
await fs.writeFile(fixture,`
import assert from 'node:assert/strict';
import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import { appendFileSync } from 'node:fs';
const [kind,race,mutant,directory]=process.argv.slice(2);
const {disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact}=await import(mutant==='yes'?${JSON.stringify(new URL('file://'+mutantHelper).href)}:${JSON.stringify(actualHelper)});
const trace=effect=>appendFileSync(path.join(directory,'trace.jsonl'),JSON.stringify({effect})+'\\n');
const error=code=>Object.assign(Error(code),{code});
let deferred,entered=false,resumed=false;
const healthy={ok:true,takeover:{active:true,aborted:false}};
const session={pid:43210,request:async req=>{
 trace('native:'+req.op);
 if(req.op==='status'&&!entered){entered=true;return new Promise(resolve=>{deferred=resolve;});}
 if(req.op==='warp')return {ok:true,verified:true,warped:req.to};
 return healthy;
},close:async()=>{trace('session.close');return {ok:true,takeover:{active:false}};}};
const hold={task:'synthetic',kept:{returnFocus:{mode:'origin',source:'legacy_default'},session,scene:{appPid:10},pointer:{x:2,y:3},chromePid:20,nativeState:{epoch:3}},
 lease:{token:'private-original-lease',release:async()=>trace('lease.release')}};
const no=()=>{};
const c=vm.createContext({process,Date,console,Map,Set,Promise,clearTimeout:no,clearInterval:no,
 preemptPageEvents:no,resumePageObservation:no,pageEventControl:no,clearPageEventTask:no,
 setTimeout:()=>1,setInterval:fn=>{c.poll=fn;return 2;},
 TASK_HOLD:hold,HOLD_ENDING:0,YIELDING:null,PLAN:null,TASK_GAP_MS:5000,TASK_CANCELLED:null,
 S:{get:()=>false},writeTaskState:no,debugLog:no,notifyUserHeld:no,pauseCleanup:()=>trace('pauseCleanup'),
 holdActive:st=>st?.takeover?.active===true,queueList:async()=>[],interruptTaskPlan:no,taskInterruptionReason:x=>x,
 taskRestoreOps:()=>({now:Date.now,restoreScene:async()=>{trace('restoreScene');return {ok:true,appFrontmost:true};}})});
vm.runInContext(${JSON.stringify(['normalizeReturnFocus','focusReturnMetadata','terminalInputFacts','mergeInterrupted','restoreHeldScene','releaseKept'].map(n=>production(guard,n)).join('\n')+'\n'+['latchTerminalTaskInterruption','endTaskHold','endTaskHoldNow','startGap'].map(n=>production(index,n)).join('\n'))},c);
let background;
function enter(){
 if(race==='gap'){c.startGap(hold);background=c.poll();assert.equal(c.TASK_HOLD,hold);}
 else {background=c.endTaskHoldNow(hold);assert.equal(c.TASK_HOLD,null);}
 assert.equal(entered,true);trace('entered:'+race);trace('current_hold:'+(c.TASK_HOLD===null?'null':'original'));
}
process.on('message',m=>{if(m==='resume'&&!resumed){resumed=true;trace('resume');deferred(race==='gap'?{ok:true,takeover:{active:false}}:healthy);
 Promise.resolve(background).then(()=>{trace('background.finished');setTimeout(()=>process.exit(0),10);},()=>process.exit(8));}});
function terminalSeal(seal){
 trace('terminal.seal');
 // A deliberately delayed IPC callback/resource completion cannot delay exit.
 process.send({kind:'entered',race,currentHold:c.TASK_HOLD===null?'null':'original'},()=>{trace('ipc.callback');});
 try{seal();}catch(e){trace('mutant.seal.returned');}
}
if(kind==='panel'){
 const report={calls:[],observations:[],checks:{},cleanup:{}};
 const p=vm.createContext({assert,path,process,AbortController,console,productErrorFact,clearTimeout:no,clearInterval:no});
 vm.runInContext(${JSON.stringify(runner+'\nglobalThis.run=runPanelHarness;')},p);
 await p.run({client:{close:async()=>{trace('client.close');return new Promise(()=>{});}},api:{__taskHoldForTests:()=>c.TASK_HOLD},
 B:{},tabs:{},settings:{},fs:{},lockDir:'/inert',url:'http://127.0.0.1/fixture',token:'fixture',report,
 save:async()=>trace('save'),closeResources:async()=>{trace('resources.close');return new Promise(()=>{});},screenshot:no,
 terminalDirectory:directory,terminalSecret:'run-binding',terminalDispose:disposeTerminal,
 scenario:async h=>{Object.assign(h.state,{plan:true,pinnedHold:hold,lastSession:session,pinnedLeaseToken:hold.lease.token,
 fixture:{tabId:7,windowId:9,chromePid:20,cgWindow:29}});enter();terminalSeal(()=>process.emit('SIGINT'));}});
}else{
 const w=vm.createContext({process,disposeTerminal,error,env:{MYCHROME_FIXTURE_DIR:directory},rpcToken:'run-binding',
 workerState:{terminal:null},requestContext:{getStore:()=>({tool:'click',startedAt:Date.now()})},firstTerminal:null,fixtures:new Map([[7,{tabId:7,windowId:9,chromePid:20,cgWindow:29}]]),
 retained:{created:null},fence:{pinned:{hold,session,token:hold.lease.token}},diagnosticSessionId:'synthetic-session'});
 vm.runInContext(${JSON.stringify(deny+'\nglobalThis.seal=deny;')},w);
 enter();terminalSeal(()=>w.seal('unknown_delivery'));
}
setTimeout(()=>{trace('unexpected.worker.timeout');process.exit(9);},1500);
`);
async function run(kind,race,mutant=false){
 const directory=await fs.mkdtemp(path.join(temp,`${kind}-${race}-`));
 const child=fork(fixture,[kind,race,mutant?'yes':'no',directory],{stdio:['ignore','pipe','pipe','ipc']});
 let stderr='',entered=null;child.stderr.on('data',x=>stderr+=x);
 child.on('message',m=>{entered=m;setTimeout(()=>{if(child.connected)child.send('resume',()=>{});},30);});
 const exit=await new Promise((resolve,reject)=>{child.on('exit',(code,signal)=>resolve({code,signal}));child.on('error',reject);});
 const trace=(await fs.readFile(path.join(directory,'trace.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x).effect);
 const receipt=await readTerminalReceipt(directory,'run-binding',child.pid);
 return {directory,child,exit,trace,receipt,entered,stderr};
}
let passed=0;
async function test(name,fn){await fn();console.log(`ok ${++passed} ${name}`);}
for(const kind of ['panel','reliability'])for(const race of ['gap','release']){
 await test(`${kind} seals an actual already-entered ${race} continuation and exits synchronously`,async()=>{
  const r=await run(kind,race);assert.equal(r.exit.code,86,r.stderr);
  assert.ok(r.trace.includes('entered:'+race));
  assert.ok(r.trace.includes('current_hold:'+(race==='release'?'null':'original')));
  const tail=r.trace.slice(r.trace.indexOf('terminal.seal')+1);assert.deepEqual(tail,[]);
  assert.equal(r.receipt.pinned.helperPid,43210);assert.equal(r.receipt.pinned.epoch,3);
  assert.match(r.receipt.pinned.leaseTokenSha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(r.receipt).includes('private-original-lease'),false);
  assert.deepEqual(r.receipt.fixtures,[{tabId:7,windowId:9,chromePid:20,cgWindow:29}]);
  await assert.rejects(readTerminalReceipt(r.directory,'wrong-run',r.child.pid),/binding_invalid/);
  await assert.rejects(readTerminalReceipt(r.directory,'run-binding',r.child.pid+1),/binding_invalid/);
 });
 await test(`${kind} ${race} immediate-exit removal allows the forbidden production cleanup tail`,async()=>{
  const r=await run(kind,race,true);assert.equal(r.exit.code,0,r.stderr);
  for(const effect of ['restoreScene','native:warp','session.close','lease.release'])assert.ok(r.trace.includes(effect),`${effect}: ${r.trace}`);
 });
}
await test('terminal evidence file must be exclusive, private and bound to its worker',async()=>{
 const r=await run('reliability','release');await fs.chmod(path.join(r.directory,'terminal-receipt.json'),0o644);
 await assert.rejects(readTerminalReceipt(r.directory,'run-binding',r.child.pid),/file_invalid/);
 await fs.chmod(path.join(r.directory,'terminal-receipt.json'),0o600);
 await fs.writeFile(path.join(r.directory,'terminal-receipt.json'),JSON.stringify({...r.receipt,unexpectedRawCapability:'must-not-propagate'}));
 await assert.rejects(readTerminalReceipt(r.directory,'run-binding',r.child.pid),/content_invalid/);
 const d=await fs.mkdtemp(path.join(temp,'existing-'));const old=path.join(d,'terminal-receipt.json');await fs.writeFile(old,'existing',{mode:0o600});
 const script=path.join(temp,'exclusive.mjs');await fs.writeFile(script,`import {disposeTerminal} from ${JSON.stringify(actualHelper)};disposeTerminal({directory:process.argv[2],binding:'run',terminal:{code:'unknown'}});`);
 const child=fork(script,[d],{stdio:'ignore'});const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,87);assert.equal(await fs.readFile(old,'utf8'),'existing');
});
await test('actual partial-create wrapper and worker dispatch persist proof then exit without follow-up RPC',async()=>{
 const directory=await fs.mkdtemp(path.join(temp,'partial-')),script=path.join(temp,'partial.mjs');
 await fs.writeFile(script,`
import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';import {appendFileSync} from 'node:fs';import {disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact} from ${JSON.stringify(actualHelper)};
const directory=process.argv[2],trace=x=>appendFileSync(directory+'/trace',x+'\\n'),error=code=>Object.assign(Error(code),{code});
const retained={attempts:0,created:null},api={__setBridgeForTests:v=>Object.assign(api,v)};
const c=vm.createContext({process,disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact,LIVE_BUDGETS:${JSON.stringify(LIVE_BUDGETS)},error,AbortController,URL,Date,Map,
 env:{MYCHROME_FIXTURE_DIR:directory,MYCHROME_FIXTURE_CASE:'partial-create'},rpcToken:'run-binding',token:'synthetic',url:'http://127.0.0.1/fixture-synthetic',
 workerState:{terminal:null,unknown:false},requestContext:new AsyncLocalStorage(),eventSequence:0,firstTerminal:null,fixtures:new Map(),retained,fence:{pinned:null},diagnosticSessionId:'partial',
 releaseKind:null,WRITE_TOOLS:new Set(['open_tab','task_plan','close_tab']),controllers:new Map(),fresh:async()=>trace('fresh'),own:async()=>{trace('own');return {exact:true};},
 client:{callTool:async()=>{trace('mcp.open');try{await api.newWindow();}catch(e){trace(e.code);return {isError:true,content:[]};}}}});
vm.runInContext(${JSON.stringify(production(reliability,'installPartialCreateFault')+'\n'+production(reliability,'mcpReplyBoundary')+'\n'+deny+'\n'+dispatch+'\nglobalThis.run=m=>requestContext.run(m.op===\'call\'?{id:m.id,tool:m.name,startedAt:Date.now(),responseAt:null,startedSequence:++eventSequence}:null,()=>dispatch(m));')},c);
c.installPartialCreateFault(api,{newWindow:async()=>{trace('create.once');return {tabId:7,windowId:9,chromePid:20,cgWindow:29};}},retained,async()=>{
 trace('proof.before.loss');return {attempts:retained.attempts,registered:false,exact:true,identity:retained.created,createdAt:Date.now()};});
await c.run({op:'call',id:1,name:'open_tab',args:{url:c.url},expectedError:'partial-create-response'});
trace('forbidden.after.dispatch');await c.run({op:'fault'});await c.run({op:'call',id:2,name:'task_plan',args:{done:true}});
`);
 const child=fork(script,[directory],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',x=>stderr+=x);
 const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,86,stderr);
 const trace=(await fs.readFile(path.join(directory,'trace'),'utf8')).trim().split('\n');
 assert.deepEqual(trace,['fresh','fresh','mcp.open','create.once','proof.before.loss','fixture_response_lost']);
 const receipt=await readTerminalReceipt(directory,'run-binding',child.pid);assert.equal(receipt.terminal.code,'fixture_response_lost');
 assert.equal(receipt.diagnostic.attempts,1);assert.equal(receipt.diagnostic.registered,false);assert.equal(receipt.diagnostic.exact,true);
 assert.deepEqual(receipt.fixtures,[{tabId:7,windowId:9,chromePid:20,cgWindow:29}]);assert.equal(receipt.call.tool,'open_tab');
});
async function metadataWorker(product, { removeTransfer = false } = {}) {
 const directory=await fs.mkdtemp(path.join(temp,'metadata-')),script=path.join(directory,'worker.mjs');
 const transfer='productError: firstTerminal.productError,';assert.ok(deny.includes(transfer));
 const actualDeny=removeTransfer?deny.replace(transfer,''):deny;
 const reply={isError:true,content:[{type:'text',text:'synthetic-private-error https://example.test/?token=synthetic-private-token'}],
  ...(product===null?{}:{structuredContent:{error:product}})};
 await fs.writeFile(script,`
import vm from 'node:vm';import {AsyncLocalStorage} from 'node:async_hooks';import {appendFileSync} from 'node:fs';import {disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact} from ${JSON.stringify(actualHelper)};
const directory=process.argv[2],trace=x=>appendFileSync(directory+'/trace',x+'\\n'),error=code=>Object.assign(Error(code),{code});
const controllers=new Map();controllers.delete=()=>{trace('forbidden.finally');return true;};
const requestContext=new AsyncLocalStorage();
requestContext.enterWith({productError:{code:'new_tab_unconfirmed',stage:'open_tab_identity',inputDelivery:'sent'}});
const c=vm.createContext({process,disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact,LIVE_BUDGETS:${JSON.stringify(LIVE_BUDGETS)},error,AbortController,URL,Date,Map,
 env:{MYCHROME_FIXTURE_DIR:directory,MYCHROME_FIXTURE_CASE:'input'},rpcToken:'run-binding',token:'synthetic',url:'http://127.0.0.1/fixture-synthetic',
 workerState:{terminal:null,unknown:false},requestContext,eventSequence:0,firstTerminal:null,fixtures:new Map(),retained:{},fence:{pinned:null},diagnosticSessionId:'metadata',
 releaseKind:null,WRITE_TOOLS:new Set(['open_tab','task_plan','close_tab']),controllers,fresh:async()=>trace('fresh'),
 own:async()=>{trace('forbidden.own');return {exact:true};},client:{callTool:async()=>{trace('mcp.open');return ${JSON.stringify(reply)};}}});
vm.runInContext(${JSON.stringify(production(reliability,'mcpReplyBoundary')+'\n'+actualDeny+'\n'+dispatch+'\nglobalThis.run=m=>requestContext.run(m.op===\'call\'?{id:m.id,tool:m.name,startedAt:Date.now(),responseAt:null,startedSequence:++eventSequence}:null,()=>dispatch(m));')},c);
await c.run({op:'call',id:1,name:'open_tab',args:{url:c.url}});
trace('forbidden.after.dispatch');await c.run({op:'call',id:2,name:'task_plan',args:{done:true}});
`);
 const child=fork(script,[directory],{stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',x=>stderr+=x);
 const code=await new Promise(resolve=>child.on('exit',resolve));assert.equal(code,86,stderr);
 const receipt=await readTerminalReceipt(directory,'run-binding',child.pid);
 const trace=(await fs.readFile(path.join(directory,'trace'),'utf8')).trim().split('\n');
 assert.deepEqual(trace,['fresh','fresh','mcp.open']);
 assert.equal(receipt.terminal.inputDelivery,'unknown');assert.equal(receipt.terminal.noRetry,true);
 assert.equal(receipt.call.responseAt>=receipt.call.startedAt,true);
 assert.equal(JSON.stringify(receipt).includes('synthetic-private-'),false);
 return {receipt,directory,pid:child.pid};
}
for(const inputDelivery of ['sent','not_sent','unknown'])await test(`actual worker preserves ${inputDelivery} product claim before synchronous terminal exit`,async()=>{
 const product={code:'native_target_changed',stage:'native_prepare',inputDelivery};
 const r=await metadataWorker({...product,message:'synthetic-private-error',token:'synthetic-private-token'});
 assert.deepEqual(r.receipt.productError,product);assert.equal(r.receipt.terminal.code,'unexpected_mcp_error');
});
await test('removing the actual reliability receipt transfer loses the otherwise available product facts',async()=>{
 const product={code:'native_target_changed',stage:'native_prepare',inputDelivery:'not_sent'};
 const r=await metadataWorker(product,{removeTransfer:true});
 assert.throws(()=>assert.deepEqual(r.receipt.productError,product),{code:'ERR_ASSERTION'});
});
await test('known Stop still wins and absent metadata never inherits a previous call error',async()=>{
 const stopped=await metadataWorker({code:'user_cancelled',stage:'native_prepare',inputDelivery:'sent'});
 assert.equal(stopped.receipt.terminal.code,'user_cancelled');assert.equal(stopped.receipt.productError.code,'user_cancelled');
 const legacy=await metadataWorker(null);assert.equal(Object.hasOwn(legacy.receipt,'productError'),false);
 assert.equal(legacy.receipt.terminal.code,'unexpected_mcp_error');
});
await test('actual terminal child replaces identifier-shaped private metadata before writing without continuing',async()=>{
 const canary='synthetic_private_token_abc';
 const r=await metadataWorker({code:canary,stage:'synthetic_private_stage_abc',inputDelivery:'not_sent'});
 assert.deepEqual(r.receipt.productError,{code:'unavailable',stage:'unobserved',inputDelivery:'not_sent'});
 assert.equal(JSON.stringify(r.receipt).includes('synthetic_private_'),false);
 assert.equal(r.receipt.terminal.code,'unexpected_mcp_error');
});
await test('schema1 accepts old receipts and exact bounded productError only, retaining file and binding checks',async()=>{
 const r=await metadataWorker({code:'native_target_changed',stage:'native_prepare',inputDelivery:'not_sent'});
 const file=path.join(r.directory,'terminal-receipt.json');
 const legacy={...r.receipt};delete legacy.productError;
 await fs.writeFile(file,JSON.stringify(legacy));assert.deepEqual(await readTerminalReceipt(r.directory,'run-binding',r.pid),legacy);
 for(const productError of [null,[],{}, {code:'native_target_changed\n',stage:'native_prepare',inputDelivery:'unknown'},
  {code:'a'.repeat(81),stage:'native_prepare',inputDelivery:'unknown'}, {code:'native_target_changed',stage:'raw text',inputDelivery:'unknown'},
  {code:'native_target_changed',stage:'native_prepare',inputDelivery:'assume_not_sent'},
  {code:'native_target_changed',stage:'native_prepare',inputDelivery:'unknown',token:'synthetic-private-token'},
  {code:'synthetic_private_token_abc',stage:'native_prepare',inputDelivery:'unknown'},
  {code:'native_target_changed',stage:'synthetic_private_stage_abc',inputDelivery:'unknown'}]){
  await fs.writeFile(file,JSON.stringify({...legacy,productError}));
  await assert.rejects(readTerminalReceipt(r.directory,'run-binding',r.pid),/content_invalid/);
 }
 await fs.writeFile(file,JSON.stringify({...r.receipt,padding:'x'.repeat(65536)}));
 await assert.rejects(readTerminalReceipt(r.directory,'run-binding',r.pid),/file_invalid/);
 await fs.writeFile(file,JSON.stringify(r.receipt));
 const linkDirectory=await fs.mkdtemp(path.join(temp,'symlink-'));await fs.symlink(file,path.join(linkDirectory,'terminal-receipt.json'));
 await assert.rejects(readTerminalReceipt(linkDirectory,'run-binding',r.pid),/file_invalid/);
});
// Real inner catch -> CALL -> MCP wrapper -> production reply boundary ->
// dispatch -> synchronous terminal writer. No synthetic structuredContent is
// supplied to the harness in this fixture.
const actualInner=production(index,'callToolInner');
const bridgeErrorAt=bridge.indexOf('class BridgeError ');assert.ok(bridgeErrorAt>=0);
const actualBridgeError=bridge.slice(bridgeErrorAt,bridge.indexOf('\n}',bridgeErrorAt)+2);
const captureAnchor='      st.captureNativeErrorFacts?.(e);';
assert.equal(actualInner.split(captureAnchor).length,2,'one exact inner optional capture handoff');
const pipelineMutant=process.env.MYCHROME_RECEIPT_MUTANT==='drop-inner-optional';
async function pipelineWorker(scenario,{mutant=false}={}){
 const directory=await fs.mkdtemp(path.join(temp,'pipeline-')),script=path.join(directory,'worker.mjs');
 const inner=mutant?actualInner.replace(captureAnchor,'      /* mutant: dropped optional capture */'):actualInner;
 const privacy=new URL('../src/privacy.js',import.meta.url).href;
 await fs.writeFile(script,`
import vm from 'node:vm';import assert from 'node:assert/strict';import {AsyncLocalStorage} from 'node:async_hooks';
import {appendFileSync} from 'node:fs';import {redactText,redactToolResult} from ${JSON.stringify(privacy)};
import {disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact} from ${JSON.stringify(actualHelper)};
const directory=process.argv[2],scenario=${JSON.stringify(scenario)},trace=x=>appendFileSync(directory+'/trace',x+'\\n');
const error=code=>Object.assign(Error(code),{code}),CALL=new AsyncLocalStorage();
const base={code:'native_target_changed',stage:'native_binding',inputDelivery:'unknown'};
const ledger=(stage='activate_tab',delivery='sent')=>[{entered:true,stage,delivery,operationId:'synthetic_private_operation'}];
const complete={bindingReason:'cg_mapping_mismatch',stages:ledger()};
const covered=scenario==='covered-dom'||scenario==='covered-native',producerEffects=[];
const coveredLoc={visible:{x:10,y:20,width:30,height:40},land:{x:10,y:20,width:30,height:40},aim:{x:25,y:40},
 hitOk:scenario==='covered-native',hitBy:'fixture-overlay',tag:'button',text:'Fixture confirm',private:'synthetic_private_dom'};
const unexpected=()=>{throw Error('unexpected covered-target continuation');};
let getterHits=0,ready,release;const entered=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
function nativeFailure(kind){
 const e=Object.assign(Error('Safe native fixture failure'),base);
 if(kind.startsWith('dialog-')){
  Object.assign(e,{code:'dialog_probe_unknown',stage:'dialog_inspect',inputDelivery:'not_sent'});
  if(kind==='dialog-direct')e.dialogProbePoint='native_attribute_read';
  if(kind==='dialog-nested')e.reply={dialogProbePoint:'bridge_reply_invalid'};
  if(kind==='dialog-invalid')e.dialogProbePoint='synthetic_private_point';
  if(kind==='dialog-wrong-stage')Object.assign(e,{stage:'dialog_identity',dialogProbePoint:'native_attribute_read'});
  if(kind==='dialog-getter')Object.defineProperty(e,'dialogProbePoint',{get(){getterHits++;throw Error('synthetic_private_getter');}});
  return e;
 }
 if(kind==='absent')return e;
 if(kind==='nested'){e.reply={...complete};return e;}
 if(kind==='canary'){e.bindingReason='synthetic_private_reason';e.stages=ledger('synthetic_private_stage','sent');return e;}
 if(kind==='invalid-direct'){e.bindingReason='synthetic_private_reason';e.stages=[];e.reply=complete;return e;}
 if(kind==='getter'){
  for(const key of ['bindingReason','stages','reply'])Object.defineProperty(e,key,{get(){getterHits++;throw Error('synthetic_private_getter');}});
  return e;
 }
 if(kind==='inherited'){Object.setPrototypeOf(e,{...complete});return e;}
 return Object.assign(e,complete);
}
const product=vm.createContext({CALL,redactText,redactToolResult,PLAN:null,RoutineError:class extends Error{},BridgeError:class extends Error{},
 pauseGate:async()=>{},noteOutcome:()=>{},goneTabNote:()=>'',setupHint:()=>'',
 B:{axInput:async()=>{producerEffects.push('axInput');return {blocker:{appName:'Fixture app',private:'synthetic_private_native'}};}},
 locateForInput:async()=>{producerEffects.push('locate');return coveredLoc;},
 originFor:()=>{producerEffects.push('origin');return {};},
 scrollToTarget:async()=>{producerEffects.push('scroll');return {loc:coveredLoc,done:true,notches:0};},
 guardNativeSelect:async()=>{producerEffects.push('nativeSelect');},
 rectToScreenRect:v=>{producerEffects.push('screenRect');return v;},toScreen:v=>{producerEffects.push('screenPoint');return v;},
 planScrollStep:unexpected,post:unexpected,armAck:unexpected,clickObservation:unexpected,rememberNativeTarget:unexpected,refuseNativeSelect:unexpected,
 producerEffects,
 openTabTool:async args=>{
  if(covered)return product.coveredClick();
  if(args.which==='first'){ready();await gate;throw nativeFailure('complete');}
  if(args.which==='second')throw Object.assign(nativeFailure('absent'),{bindingReason:'window_missing',stages:ledger('close_tab','unknown')});
  if(args.which==='success')return 'Safe successful fixture';
  throw nativeFailure(scenario);
 }});
vm.runInContext(${JSON.stringify(actualBridgeError+'\n'+production(index,'guardNativeTarget')+'\n'+production(index,'clickDeliver')+'\n'+inner+'\n'+production(index,'progressFor')+'\n'+production(index,'callTool')+
 '\nglobalThis.coveredClick=()=>clickDeliver({},{chromePid:50,cgWindow:90,target:{tabId:7}},{mark:v=>producerEffects.push("mark:"+v)},{marker:1},{listBefore:[]});'+
 '\nglobalThis.callToolRun=req=>callToolInner(req.params.name,req.params.arguments,{},async()=>" ");globalThis.invoke=callTool;')},product);
const invoke=args=>product.invoke({params:{name:'open_tab',arguments:args}},{});
const controllers=new Map();controllers.delete=()=>{trace('forbidden.finally');return true;};
const client={callTool:async()=>{
 trace('mcp.open');let result;
 if(scenario==='overlap'){
  const first=invoke({which:'first'});await entered;
  const second=await invoke({which:'second'});release();result=await first;
  assert.equal(second.structuredContent.error.bindingReason,'window_missing');
  assert.equal(second.structuredContent.error.lastWriteStage,'close_tab');
  assert.equal(result.structuredContent.error.bindingReason,'cg_mapping_mismatch');
  const success=await invoke({which:'success'});assert.equal(Object.hasOwn(success,'structuredContent'),false);
 }else result=await invoke({});
 if(covered){
  assert.deepEqual(producerEffects,['locate','mark:relocated','origin','scroll','nativeSelect',
   ...(scenario==='covered-native'?['origin','screenRect','screenPoint','axInput']:[])]);
  trace('producer:'+scenario);
 }
 assert.equal(getterHits,0);trace('inner.return');trace('getters:'+getterHits);
 assert.equal(JSON.stringify(result).includes('synthetic_private_'),false);
 return result;
}};
const requestContext=new AsyncLocalStorage();
requestContext.enterWith({productError:{...base,bindingReason:'window_missing',lastWriteStage:'close_tab',lastWriteDelivery:'sent'}});
const c=vm.createContext({process,disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact,LIVE_BUDGETS:${JSON.stringify(LIVE_BUDGETS)},error,AbortController,URL,Date,Map,
 env:{MYCHROME_FIXTURE_DIR:directory,MYCHROME_FIXTURE_CASE:'input'},rpcToken:'run-binding',token:'synthetic',url:'http://127.0.0.1/fixture-synthetic',
 workerState:{terminal:null,unknown:false},requestContext,eventSequence:0,firstTerminal:null,
 fixtures:new Map(),retained:{},fence:{pinned:null},diagnosticSessionId:'pipeline',releaseKind:null,
 WRITE_TOOLS:new Set(['open_tab','task_plan','close_tab']),controllers,fresh:async()=>trace('fresh'),
 own:async()=>{trace('forbidden.own');return {exact:true};},client});
vm.runInContext(${JSON.stringify(production(reliability,'mcpReplyBoundary')+'\n'+deny+'\n'+dispatch+'\nglobalThis.run=m=>requestContext.run(m.op===\'call\'?{id:m.id,tool:m.name,startedAt:Date.now(),responseAt:null,startedSequence:++eventSequence}:null,()=>dispatch(m));')},c);
await c.run({op:'call',id:1,name:'open_tab',args:{url:c.url}});
trace('forbidden.after.dispatch');
`);
 const child=fork(script,[directory],{stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const exit=await new Promise((resolve,reject)=>{child.on('exit',(code,signal)=>resolve({code,signal}));child.on('error',reject);});
 assert.equal(exit.code,86,`actual pipeline worker failed: ${stderr}`);assert.equal(exit.signal,null);
 const receipt=await readTerminalReceipt(directory,'run-binding',child.pid);
 const trace=(await fs.readFile(path.join(directory,'trace'),'utf8')).trim().split('\n');
 assert.deepEqual(trace,['fresh','fresh','mcp.open',...(['covered-dom','covered-native'].includes(scenario)?['producer:'+scenario]:[]),'inner.return','getters:0']);
 assert.equal(receipt.terminal.inputDelivery,'unknown');assert.equal(receipt.terminal.noRetry,true);
 assert.equal(receipt.terminal.code,'unexpected_mcp_error');
 assert.equal(receipt.call.responseAt>=receipt.call.startedAt,true);
 assert.equal(JSON.stringify(receipt).includes('synthetic_private_'),false);
 return {receipt,stdout,stderr,exit};
}
function assertPipelineFacts(receipt,optional){
 assert.deepEqual(receipt.productError,{code:'native_target_changed',stage:'native_binding',inputDelivery:'unknown',...optional},
  'actual inner catch optional facts must survive the unchanged final terminal field assertion');
}
const pipelineExpected={bindingReason:'cg_mapping_mismatch',lastWriteStage:'activate_tab',lastWriteDelivery:'sent'};
await test('actual inner catch optional facts survive CALL, wrapper, unwrap and synchronous terminal',async()=>{
 const r=await pipelineWorker('complete',{mutant:pipelineMutant});
 console.log(`actual pipeline reached terminal with worker exit ${r.exit.code} (${pipelineMutant?'dropped-capture mutant':'production'})`);
 assertPipelineFacts(r.receipt,pipelineExpected);
});
await test('actual pipeline retains nested and overlapping call facts without promoting sent to terminal delivery',async()=>{
 for(const scenario of ['nested','overlap'])assertPipelineFacts((await pipelineWorker(scenario)).receipt,pipelineExpected);
});
await test('actual pipeline omits absent, private, inherited and getter facts and does not inherit previous request context facts',async()=>{
 for(const scenario of ['absent','canary','invalid-direct','getter','inherited'])
  assertPipelineFacts((await pipelineWorker(scenario)).receipt,{});
});
await test('both actual target_covered reject sites survive the complete synchronous terminal pipeline',async()=>{
 for(const [scenario,targetCoveredSource]of [['covered-dom','dom_hit_test'],['covered-native','native_point_blocker']]){
  const r=await pipelineWorker(scenario);
  assert.deepEqual(r.receipt.productError,{code:'target_covered',stage:'unobserved',inputDelivery:'unknown',targetCoveredSource});
  assert.equal(r.receipt.terminal.inputDelivery,'unknown');assert.equal(r.receipt.terminal.noRetry,true);
 }
});
await test('dialog points survive actual inner catch to terminal only for matching code and stage',async()=>{
 for(const [scenario,optional]of [
  ['dialog-direct',{dialogProbePoint:'native_attribute_read'}],['dialog-nested',{dialogProbePoint:'bridge_reply_invalid'}],
  ['dialog-absent',{}],['dialog-invalid',{}],['dialog-getter',{}],['dialog-wrong-stage',{}]]){
  const r=await pipelineWorker(scenario);
  assert.deepEqual(r.receipt.productError,{code:'dialog_probe_unknown',
   stage:scenario==='dialog-wrong-stage'?'dialog_identity':'dialog_inspect',inputDelivery:'not_sent',...optional});
 }
});
await test('close_prepare_timeout retains product not_sent while the terminal remains unknown and noRetry',async()=>{
 const product={code:'close_prepare_timeout',stage:'close_preflight',inputDelivery:'not_sent'};
 const r=await metadataWorker(product);
 assert.deepEqual(r.receipt.productError,product);
 assert.equal(r.receipt.terminal.code,'unexpected_mcp_error');
 assert.equal(r.receipt.terminal.inputDelivery,'unknown');assert.equal(r.receipt.terminal.noRetry,true);
});

const messageStart=reliability.indexOf("  process.on('message', m => {");
assert.ok(messageStart>=0);
const actualMessage=reliability.slice(messageStart,reliability.indexOf("\n  process.on('disconnect'",messageStart));
const actualOwnSample=reliability.slice(reliability.indexOf('  async function own(tab)'),reliability.indexOf('  async function observe()'));
async function rejectionWorker(op,{warm=false,rpcCode=-32001,dropTransfer=false}={}){
 const directory=await fs.mkdtemp(path.join(temp,'rejection-')),script=path.join(directory,'worker.mjs');
 const transfer='workerFailure: firstTerminal.workerFailure, rpcFailure: firstTerminal.rpcFailure,';
 assert.ok(deny.includes(transfer));
 const workerDeny=dropTransfer?deny.replace(transfer,''):deny;
 const body=actualBridgeError+'\n'+['driverFailureFacts','runDriver','chromeInfo','evalInPage'].map(n=>production(bridge,n)).join('\n')+'\n'+actualOwnSample+'\n'+workerDeny+'\n'+dispatch+'\n'+actualMessage;
 await fs.writeFile(script,`
import vm from 'node:vm';import path from 'node:path';import {AsyncLocalStorage} from 'node:async_hooks';import {appendFileSync} from 'node:fs';
import {disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact} from ${JSON.stringify(actualHelper)};
const directory=process.argv[2],op=${JSON.stringify(op)},warm=${JSON.stringify(warm)};
const trace=x=>appendFileSync(directory+'/trace',x+'\\n'),error=code=>Object.assign(Error(code),{code});
const failure=()=>Object.assign(Error('synthetic_private_message'),{code:7,signal:'SIGTERM',killed:true,stdout:'',stderr:'synthetic_private_stderr',timedOut:true});
const receive=args=>{trace('driver:'+args[0]);if(op==='sample'&&args[0]==='info')return {stdout:JSON.stringify({ok:true,url:'http://127.0.0.1/fixture-synthetic',tabId:7,windowId:9,chromePid:20,cgWindow:29}),stderr:''};throw failure();};
const controllers=new Map();controllers.delete=()=>{trace('forbidden.finally');return true;};
const requestContext=new AsyncLocalStorage();requestContext.enterWith({tool:'earlier',productError:{code:'new_tab_unconfirmed',stage:'open_tab_identity',inputDelivery:'sent'}});
const c=vm.createContext({process,disposeTerminal,productErrorFact,workerFailureFact,rpcFailureFact,error,AbortController,URL,Date,Map,
 LIVE_BUDGETS:${JSON.stringify(LIVE_BUDGETS)},env:{MYCHROME_FIXTURE_DIR:directory,MYCHROME_FIXTURE_CASE:'input'},rpcToken:'run-binding',token:'synthetic',url:'http://127.0.0.1/fixture-synthetic',
 workerState:{terminal:null,unknown:false},requestContext,eventSequence:0,firstTerminal:null,fixtures:new Map(),retained:{},fence:{pinned:null},diagnosticSessionId:'child',
 releaseKind:null,WRITE_TOOLS:new Set(['type_text']),controllers,fresh:async()=>{},api:{__taskHoldForTests:()=>({})},
 tabs:{readTabRecord:async()=>({ownerPid:process.pid,expectedUrl:'http://127.0.0.1/fixture-synthetic',windowId:9})},B:{},
 WARM_ON:warm,CHROMECTL:'/synthetic_private_helper',takeWarm:()=>({}),runWarm:async(_w,args)=>receive(args),execFileP:async(_file,args,options)=>{if(options.timeout!==25000)throw Error('product timeout changed');return receive(args);},
 humanMessage:(_code,message)=>message,path,os:{tmpdir:()=>'/synthetic_private_directory'},crypto:{randomBytes:()=>Buffer.from('synthetic')},
 writeFile:async()=>trace('script'),unlink:async()=>trace('unlink'),
 client:{callTool:async()=>{trace('mcp.type_text');throw Object.assign(Error('synthetic_private_rpc_message'),{code:${JSON.stringify(rpcCode)},data:'synthetic_private_data'});}}});
vm.runInContext(${JSON.stringify(body)},c);
c.B.chromeInfo=c.chromeInfo;c.B.evalInPage=c.evalInPage;
process.emit('message',{token:'run-binding',id:1,op,...(op==='call'?{name:'type_text',args:{}}:{tab:7})});
setImmediate(()=>trace('forbidden.after.terminal'));
`);
 const child=fork(script,[directory],{stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='';
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const exit=await new Promise((resolve,reject)=>{child.on('exit',(code,signal)=>resolve({code,signal}));child.on('error',reject);});
 assert.equal(exit.code,86,stderr);assert.equal(exit.signal,null);
 const receipt=await readTerminalReceipt(directory,'run-binding',child.pid);
 const trace=(await fs.readFile(path.join(directory,'trace'),'utf8')).trim().split('\n');
 assert.equal(trace.some(x=>x.startsWith('forbidden')),false);assert.equal(stdout,'');assert.equal(stderr,'');
 assert.equal(JSON.stringify(receipt).includes('synthetic_private_'),false);
 assert.equal(Object.hasOwn(receipt,'productError'),false);
 assert.equal(receipt.terminal.inputDelivery,'unknown');assert.equal(receipt.terminal.noRetry,true);
 return {receipt,trace};
}
function assertWorkerFailure(receipt,op='own',warm=false){
 assert.deepEqual(receipt.workerFailure,{op,code:'chromectl_failed',driverCommand:op==='own'?'info':'eval',
  exitCode:warm?null:7,signal:warm?null:'SIGTERM',killed:warm?null:true,timedOut:null});
}
function assertRpcFailure(receipt,rpcCode=-32001){
 assert.deepEqual(receipt.rpcFailure,{code:[-32000,-32001].includes(rpcCode)?rpcCode:null});
}
await test('actual cold and warm driver failures reach first own/sample terminal without a fabricated MCP call',async()=>{
 for(const op of ['own','sample'])for(const warm of [false,true]){
  const r=await rejectionWorker(op,{warm});
  assert.deepEqual(r.trace,op==='own'?['driver:info']:['driver:info','script','driver:eval','unlink']);
  assert.equal(r.receipt.call,null);assert.equal(r.receipt.terminal.code,'chromectl_failed');
  assertWorkerFailure(r.receipt,op,warm);
  assert.equal(Object.hasOwn(r.receipt,'rpcFailure'),false);
 }
});
await test('actual dispatched rejection retains only numeric SDK evidence and never runs finally cleanup',async()=>{
 for(const rpcCode of [-32000,-32001,-32603,'ETIMEDOUT']){
  const r=await rejectionWorker('call',{rpcCode});assert.deepEqual(r.trace,['mcp.type_text']);
  assert.equal(r.receipt.call.tool,'type_text');assert.equal(r.receipt.call.responseAt,null);
  assert.equal(r.receipt.terminal.code,'dispatched_rpc_rejected');
  assertRpcFailure(r.receipt,rpcCode);
  assert.equal(Object.hasOwn(r.receipt,'workerFailure'),false);
 }
});
await test('the same positive receipt oracles kill both child and RPC transfer-removal mutants',async()=>{
 const worker=await rejectionWorker('own',{dropTransfer:true}),rpc=await rejectionWorker('call',{dropTransfer:true});
 assert.throws(()=>assertWorkerFailure(worker.receipt),{code:'ERR_ASSERTION'});
 assert.throws(()=>assertRpcFailure(rpc.receipt),{code:'ERR_ASSERTION'});
});
await test('first synchronous terminal snapshot rejects later worker or RPC replacements',()=>{
 const snapshots=[],context=vm.createContext({workerState:{terminal:null},requestContext:{getStore:()=>null},firstTerminal:null,
  disposeTerminal:value=>{snapshots.push(value);},env:{MYCHROME_FIXTURE_DIR:'inert'},rpcToken:'inert',fixtures:new Map(),retained:{},fence:{pinned:null},
  diagnosticSessionId:'inert',error:code=>Object.assign(Error(code),{code})});
 vm.runInContext(deny+'\nglobalThis.seal=deny;',context);
 const initial=workerFailureFact('own',{code:'chromectl_failed',driverCommand:'info',exitCode:7,signal:'SIGTERM',killed:true});
 assert.throws(()=>context.seal('chromectl_failed',{workerFailure:initial}),/chromectl_failed/);
 assert.throws(()=>context.seal('dispatched_rpc_rejected',{rpcFailure:rpcFailureFact({code:-32001})}),/chromectl_failed/);
 assert.equal(snapshots.length,2);
 for(const snapshot of snapshots){assert.equal(snapshot.terminal.code,'chromectl_failed');assert.equal(snapshot.call,null);assert.equal(snapshot.workerFailure,initial);assert.equal(snapshot.rpcFailure,null);}
});

console.log(`${passed} real-continuation terminal groups; disposable inert workers only.`);
