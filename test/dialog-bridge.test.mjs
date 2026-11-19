/* Real bridge functions with fake subprocess transports. No helpers or UI are started. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { sessionError } from '../src/bridge.js';
const source = fs.readFileSync(process.env.BRIDGE_SOURCE || new URL('../src/bridge.js', import.meta.url), 'utf8');
const fn = name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start,source.indexOf('\n}',start)+2);
};
const identity = { version:1, chromePid:7, tabId:9, windowId:1, cgWindow:11, dialogCgWindow:21, token:'a'.repeat(64), dialogToken:'a'.repeat(64) };
const target = { chromePid:7, tabId:9, windowId:1, cgWindow:11 };
function harness({ output = {}, warm = false, transportError = null, empty = false, malformed = false } = {}) {
  const calls = [];
  class BridgeError extends Error { constructor(code,message) { super(message); this.code = code; } }
  const response = () => {
    if (transportError) throw Object.assign(new Error('synthetic transport failure'), transportError);
    return { stdout: malformed ? 'PRIVATE_PROMPT_VALUE invalid json' : empty ? '' : JSON.stringify(output), stderr:'' };
  };
  const ctx = vm.createContext({
    sessionError, BridgeError, WARM_ON:warm, CHROMECTL:'/synthetic/chromectl',
    process:{env:{},stderr:{write(){throw Error('unexpected trace');}}},
    humanMessage:(_code,message)=>message,
    takeWarm(){ calls.push(['pool']); return {}; },
    async runWarm(_w,args){calls.push(['warm',Array.from(args)]); return response();},
    async execFileP(file,args,options){calls.push(['cold',file,Array.from(args),options]); return response();},
  });
  vm.runInContext(['nativeWrite','driverFailureFacts','runDriver','dialogTarget','pageDialog','answerDialog','closeTab','openTab','selectTab','newWindow'].map(fn).join('\n'),ctx);
  const native = async (intent,options) => {
    calls.push(['native',intent,options]);
    if (transportError) throw Object.assign(new Error('synthetic transport failure'),transportError);
    return empty ? undefined : malformed ? 'invalid native response' : output;
  };
  return {ctx,calls,native};
}
const message = {ok:true,known:true,open:true,title:'fixture',texts:['Continue?'],buttons:['OK'],hasField:true,identity};

test('inspect pins explicit PID with serialized target and never consumes a warm process',async()=>{
  const {ctx,calls} = harness({output:message,warm:true});
  const result = await ctx.pageDialog(target);
  assert.equal(result.identity.token,identity.token); assert.equal(calls.length,1); assert.equal(calls[0][0],'cold');
  const args = calls[0][2]; assert.deepEqual(args.slice(0,3),['dialog','--pid','7']);
  assert.deepEqual(JSON.parse(args[4]),target);
});
test('conclusive empty inspect stays known/open false',async()=>{
  const {ctx,calls} = harness({output:{ok:true,known:true,open:false},warm:true});
  assert.equal((await ctx.pageDialog()).open,false); assert.deepEqual(calls[0][2],['dialog']); assert.equal(calls.length,1);
});
for (const output of [{ok:true,open:false},{ok:true,known:false,open:false},{ok:true,known:true,open:true},
  {...message,identity:{...identity,tabId:10}}]) test('incomplete or wrong native identity is not a closed result',async()=>{
  const {ctx,calls} = harness({output});
  await assert.rejects(ctx.pageDialog(target),e=>e.code==='dialog_probe_unknown'&&e.inputDelivery==='not_sent');
  assert.equal(calls.length,1);
});
for (const response of [{empty:true},{malformed:true},{transportError:{code:'ETIMEDOUT'}}]) test('unknown read transport returns bounded error without contents',async()=>{
  const {ctx,calls}=harness({...response,warm:true});
  await assert.rejects(ctx.pageDialog(),e=>e.code==='dialog_probe_unknown'&&e.stage==='dialog_inspect'&&!e.message.includes('PRIVATE_PROMPT_VALUE'));
  assert.equal(calls.length,1);
});
test('dialog failure point survives the cold driver without changing reads or canonical facts',async()=>{
  for(const point of ['native_attribute_deadline','native_attribute_read','native_windows_shape','native_subrole_shape',
    'native_sheets_shape','native_walk_guard','native_button_title','native_button_label','native_text_value',
    'native_children_read','native_dialog_final','cli_inspect_catch']) {
    const {ctx,calls}=harness({output:{ok:false,error:'dialog_probe_unknown',stage:'dialog_inspect',inputDelivery:'not_sent',dialogProbePoint:point}});
    await assert.rejects(ctx.pageDialog(),e=>e.code==='dialog_probe_unknown'&&e.stage==='dialog_inspect'&&e.inputDelivery==='not_sent'&&e.dialogProbePoint===point);
    assert.equal(calls.length,1);assert.equal(calls[0][0],'cold');assert.deepEqual(calls[0][2],['dialog']);
  }
});
test('dialog failure point is closed and scoped to the original native error',async()=>{
  for(const extra of [{dialogProbePoint:'PRIVATE_AX_TEXT'},{dialogProbePoint:5},{dialogProbePoint:null},
    {dialogProbePoint:{windowId:7}},{dialogProbePoint:'bridge_child_failed'},
    {dialogProbePoint:'native_attribute_read',stage:'dialog_binding'},{dialogProbePoint:'native_attribute_read',error:'terminated'}]) {
    const output={ok:false,error:'dialog_probe_unknown',stage:'dialog_inspect',inputDelivery:'not_sent',...extra};
    const {ctx,calls}=harness({output});
    await assert.rejects(ctx.pageDialog(),e=>e.code===output.error&&e.stage===output.stage&&e.inputDelivery==='not_sent'&&!Object.hasOwn(e,'dialogProbePoint'));
    assert.equal(calls.length,1);
  }
});
test('NAT-RETRY: rescan count and last AX status survive the cold driver, closed and scoped',async()=>{
  const base={ok:false,error:'dialog_probe_unknown',stage:'dialog_inspect',inputDelivery:'not_sent',dialogProbePoint:'native_attribute_read'};
  {
    const {ctx,calls}=harness({output:{...base,axRetries:4,axError:-25204}});
    await assert.rejects(ctx.pageDialog(),e=>e.axRetries===4&&e.axError===-25204&&e.dialogProbePoint==='native_attribute_read');
    assert.equal(calls.length,1);
  }
  // Round 2 (A3): the Probe deadline and the binding stage carry them too; other stages and codes never do.
  for(const stage of ['native_read_deadline','dialog_binding']) {
    const {ctx}=harness({output:{ok:false,error:'dialog_probe_unknown',stage,inputDelivery:'not_sent',axRetries:1,axError:-25202}});
    await assert.rejects(ctx.pageDialog(),e=>e.stage===stage&&e.axRetries===1&&e.axError===-25202);
  }
  for(const extra of [{axRetries:5,axError:-25204},{axRetries:'4'},{axRetries:4,axError:'PRIVATE_AX_TEXT'},{axRetries:4,stage:'native_read'},{axRetries:4,error:'terminated'}]) {
    const output={...base,...extra},{ctx,calls}=harness({output});
    await assert.rejects(ctx.pageDialog(),e=>e.code===output.error&&!(Object.hasOwn(e,'axError'))&&
      (Object.hasOwn(e,'axRetries')===(extra.axRetries===4&&!extra.stage&&!extra.error)));
    assert.equal(calls.length,1);
  }
});
test('bridge-only dialog collapse points are distinct and never retry a child',async()=>{
  for(const [options,point] of [[{empty:true},'bridge_child_failed'],[{transportError:{code:'ETIMEDOUT'}},'bridge_child_failed'],
    [{malformed:true},'bridge_output_invalid'],[{output:{ok:true,known:false,open:false}},'bridge_reply_invalid'],
    [{output:{...message,identity:{...identity,tabId:10}}},'bridge_reply_invalid']]) {
    const {ctx,calls}=harness({...options,warm:true});
    await assert.rejects(ctx.pageDialog(target),e=>e.code==='dialog_probe_unknown'&&e.stage==='dialog_inspect'&&e.inputDelivery==='not_sent'&&e.dialogProbePoint===point&&!e.message.includes('PRIVATE_'));
    assert.equal(calls.length,1);assert.equal(calls[0][0],'cold');
  }
});
for (const missing of [null,{}, {...identity,token:''},{...identity,tabId:NaN},{...identity,chromePid:true},{...identity,chromePid:2147483648}]) {
  test('missing or malformed identity is rejected before any driver call',async()=>{
    const {ctx,calls}=harness();
    await assert.rejects(ctx.answerDialog('OK','private',missing),e=>e.code==='dialog_identity_required'&&e.inputDelivery==='not_sent');
    assert.deepEqual(calls,[]);
  });
}
test('answer preserves opaque strings in one typed Session intent and never calls the CLI',async()=>{
  const text = 'quote"; $(not a shell)\n中文', button = '--pid';
  const {ctx,calls,native}=harness({output:{ok:true,pressed:button,inputDelivery:'sent',sameStillOpen:false}});
  const r=await ctx.answerDialog(button,text,identity,{native});
  assert.equal(r.pressed,button); assert.equal(calls.length,1); assert.equal(calls[0][0],'native');
  assert.equal(calls[0][1].dialogToken,identity.dialogToken); assert.equal(calls[0][1].text,text); assert.equal(calls[0][1].button,button);
});
test('a cold fingerprint without the opaque Session token never authorizes a press',async()=>{
  const {ctx,calls,native}=harness(); const cold={...identity}; delete cold.dialogToken;
  await assert.rejects(ctx.answerDialog('OK',null,cold,{native}),e=>e.code==='dialog_identity_required'&&e.inputDelivery==='not_sent');
  assert.deepEqual(calls,[]);
});
for (const response of [{empty:true},{malformed:true},{transportError:{code:'ETIMEDOUT'}}]) test('answer dispatch uncertainty is never replayed',async()=>{
  const {ctx,calls,native}=harness(response);
  await assert.rejects(ctx.answerDialog('OK','PRIVATE_PROMPT_VALUE',identity,{native}),e=>e.inputDelivery==='unknown'&&e.noRetry===true&&!e.message.includes('PRIVATE_PROMPT_VALUE'));
  assert.equal(calls.length,1); assert.equal(calls[0][0],'native');
});
for (const output of [{ok:true,open:false},{ok:true,pressed:'Cancel',inputDelivery:'sent',sameStillOpen:false},
  {ok:true,pressed:'OK',inputDelivery:'not_sent',sameStillOpen:false},{ok:true,pressed:'OK',inputDelivery:'sent'}]) {
  test('success without the requested button delivery receipt is unknown',async()=>{
    const {ctx,calls,native}=harness({output});
    await assert.rejects(ctx.answerDialog('OK',null,identity,{native}),e=>e.code==='dialog_response_unknown'&&e.inputDelivery==='unknown'&&e.noRetry===true);
    assert.equal(calls.length,1);
  });
}
test('native partial stage ledger survives BridgeError including Stop',async()=>{
  const stages=[{sequence:1,stage:'dialog_set',delivery:'sent',entered:true,acknowledged:true}];
  const {ctx,native}=harness({output:{ok:false,error:'aborted',takeover:{aborted:true,abortedBy:'esc'},inputDelivery:'sent',stages,epoch:2,operationId:'one'}});
  await assert.rejects(ctx.answerDialog('OK','private',identity,{native}),e=>e.code==='user_cancelled'&&e.inputDelivery==='sent'&&e.noRetry&&e.stages===stages&&e.epoch===2&&e.operationId==='one');
});
test('close uses the Session bound target and never requests automatic Leave',async()=>{
  const h=harness({output:{ok:true,closed:true,inputDelivery:'sent'}}); await h.ctx.closeTab(9,{target,native:h.native});
  assert.equal(h.calls.length,1); assert.equal(h.calls[0][0],'native'); assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][1])),{kind:'closeTab',tabId:9});
  const bad=harness(); await assert.rejects(bad.ctx.closeTab(10,{target,native:bad.native}),e=>e.inputDelivery==='not_sent'); assert.deepEqual(bad.calls,[]);
});
test('close pending preserves prompt and delivery evidence',async()=>{
  const {ctx,native}=harness({output:{ok:false,error:'close_prompt_pending',message:'safe',promptPending:true,stage:'close_postcheck',inputDelivery:'sent'}});
  await assert.rejects(ctx.closeTab(9,{native}),e=>e.code==='close_prompt_pending'&&e.promptPending===true&&e.inputDelivery==='sent'&&e.noRetry);
});
for (const [name,call] of [
  ['open',(c,native)=>c.openTab('https://example.invalid',1,{native})],
  ['select',(c,native)=>c.selectTab(9,{windowId:1,native})],
  ['close',(c,native)=>c.closeTab(9,{native})],
  ['new window',(c,native)=>c.newWindow('https://example.invalid',{left:0,top:0,right:800,bottom:600},null,{native,displayId:1})],
  ['dialog',(c,native)=>c.answerDialog('OK',null,identity,{native})],
]) {
  test(`${name} refuses a missing native route without CLI fallback`,async()=>{
    const {ctx,calls}=harness(); await assert.rejects(call(ctx),e=>e.inputDelivery==='not_sent'); assert.deepEqual(calls,[]);
  });
  test(`${name} never replays an empty Session response`,async()=>{
    const {ctx,calls,native}=harness({empty:true}); await assert.rejects(call(ctx,native),e=>e.inputDelivery==='unknown'&&e.noRetry);
    assert.equal(calls.length,1); assert.equal(calls[0][0],'native');
  });
}
test('cold inspect explicitly disables empty-output replay',()=>{
  assert.match(fn('pageDialog'),/cold: true, retryEmptyOutput: false/);
});
