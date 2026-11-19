#!/usr/bin/env node
/* Chrome window -> CG window matching (chromectl matchWindows), through `chromectl windowmatch`:
 * Matcher inputs are synthetic. Profiles read fixture files only. The separately labelled
 * own-Node-PID axwindows case is read-only host AX/CG integration, not a pure matcher test.
 * Twins (same bounds: every maximized window on a display) are told apart by the AX window number
 * (_AXUIElementGetWindow, as JustTab does) before Chrome's z-order is paired with CoreGraphics'. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMECTL = process.env.CHROMECTL_BIN || path.join(ROOT, 'bin', 'chromectl');
const receipts = [];
process.once('exit', () => console.log('  retained invocation evidence: '+JSON.stringify(receipts)));

// Each invocation owns a separate process group. A deadline is a failure, even
// when SIGTERM succeeds. Unsettled cleanup is reported, never hidden or escalated.
function runOwned(file, args, { input='', env=process.env, timeoutMs=10000, retain=false }={}) {
  assert.equal(process.platform,'darwin','This native suite uses macOS process groups.');
  const started=Date.now();
  return new Promise((resolve,reject) => {
    const child=spawn(file,args,{env,detached:true,stdio:['pipe','pipe','pipe']});
    const stdoutParts=[],stderrParts=[];
    let retainedBytes=0,truncated=false,stopReason=null,signalError=null,launchError=null,stdinError=null;
    let done=false,grace,deadline;
    const finish=(code,signal,closed) => {
      if(done) return; done=true; clearTimeout(deadline); clearTimeout(grace);
      const result={file:path.basename(file),args,pid:child.pid??null,code,signal,closed,
        stopReason,signalError,launchError,stdinError,elapsedMs:Date.now()-started,retainedBytes,truncated,
        stdout:Buffer.concat(stdoutParts).toString('utf8'),stderr:Buffer.concat(stderrParts).toString('utf8')};
      if(retain || stopReason || launchError) receipts.push(result);
      if(!closed) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      if(stopReason || launchError || !closed) {
        const error=new Error('Owned invocation failed: '+JSON.stringify(result)); error.receipt=result; reject(error);
      } else resolve(result);
    };
    const stop=reason => {
      if(done || stopReason) return; stopReason=reason;
      try { if(child.pid) process.kill(-child.pid,'SIGTERM'); }
      catch(error) { signalError=error.code??String(error); }
      grace=setTimeout(()=>finish(null,null,false),2000);
    };
    const collect=stream => chunk => {
      const remaining=1024*1024-retainedBytes,kept=chunk.subarray(0,remaining);
      if(kept.length) (stream==='stdout'?stdoutParts:stderrParts).push(kept);
      retainedBytes+=kept.length;
      if(chunk.length>remaining) { truncated=true; stop('output_limit'); }
    };
    child.stdout.on('data',collect('stdout'));
    child.stderr.on('data',collect('stderr'));
    child.once('error',error=>{ launchError=error.code??String(error); });
    child.once('close',(code,signal)=>finish(code,signal,true));
    child.stdin.on('error',error=>{ stdinError=error.code??String(error); if(error.code!=='EPIPE') stop('stdin_error'); });
    deadline=setTimeout(()=>stop('deadline'),timeoutMs);
    child.stdin.end(input);
  });
}
async function jsonCommand(file,args,options) {
  const r=await runOwned(file,args,options);
  assert.equal(r.code,0,JSON.stringify(r)); assert.equal(r.signal,null,JSON.stringify(r));
  return JSON.parse(r.stdout);
}
const match = async input => jsonCommand(CHROMECTL, ['windowmatch'], { input: JSON.stringify(input) });
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

const MAX = [0, 30, 1920, 970], SMALL = [100, 100, 800, 600];
const win = (id, rect, index, title, minimized = false) => ({ id, rect, index, title, minimized });
const cgw = (num, rect, onScreen = true) => ({ num, rect, onScreen });
const axw = (num, title, rect, minimized = false) => ({ num, title, rect, minimized });

console.log('chromectl windowmatch');
{
  let failure;
  try { await runOwned(process.execPath,['-e','process.stdout.write("ready\\n"); setInterval(()=>{},1000)'],{timeoutMs:1000,retain:true}); }
  catch(error) { failure=error; }
  assert.ok(failure?.receipt,'The cooperative child must fail its deadline.');
  const r=failure.receipt;
  assert.equal(r.stopReason,'deadline'); assert.equal(r.signal,'SIGTERM'); assert.equal(r.closed,true);
  assert.equal(r.signalError,null); assert.equal(r.stdout,'ready\n'); assert.ok(r.elapsedMs<4000,JSON.stringify(r));
  ok('owned cooperative child deadline fails, SIGTERM settles and close is observed without descendants');
}
{
  const r = await match({ chrome: [win(1, MAX, 1, 'A'), win(2, SMALL, 2, 'B')], cg: [cgw(10, MAX), cgw(20, SMALL)] });
  assert.deepEqual(r.map, { 1: 10, 2: 20 });
  assert.equal(r.axAsked, false);
  assert.equal(r.titlesAsked, 0);
  ok('distinct bounds: matched by bounds, Accessibility not asked');
}
{
  // Two maximized windows; Chrome's order and the CG order disagree (a raise in flight): z-order
  // pairing alone would swap them. The AX window numbers decide.
  const r = await match({
    chrome: [win(1, MAX, 1, '邮箱'), win(2, MAX, 2, '文档')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(11, '邮箱 - Google Chrome', MAX), axw(10, '文档 - Google Chrome - 工作', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  assert.equal(r.axAsked, true);
  ok('maximized twins: told apart by AX window number + active tab title, ahead of z-order pairing');
}
{
  const r = await match({
    chrome: [win(1, MAX, 2, '新标签页'), win(2, MAX, 1, '新标签页')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 11, rect: MAX }, { num: 10, rect: MAX }],
    ax: [axw(10, '新标签页 - Google Chrome', MAX), axw(11, '新标签页 - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 2: 11, 1: 10 });
  ok('twins with the same title: AX cannot tell, z-order pairing still does');
}
{
  const r = await match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'X')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', MAX), axw(11, 'X - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  ok('twins with the same title and no window order: no entry (refused, never guessed)');
}
{
  const r = await match({
    chrome: [win(1, MAX, null, 'Foo'), win(2, MAX, null, 'Foo - Bar')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'Foo - Bar - Google Chrome', MAX), axw(11, 'Foo - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  ok('a title that is the start of the other window\'s title: "<title> - Google Chrome" decides');
}
{
  const r = await match({
    chrome: [win(1, MAX, null, '音乐'), win(2, MAX, null, '邮件')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, '音乐 - Audio playing - Google Chrome', MAX), axw(11, '邮件 - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  ok('Chrome\'s state in the window title ("- Audio playing"): still matched');
}
{
  const r = await match({
    chrome: [win(1, MAX, 1, 'A'), win(2, MAX, 2, 'B', true)],
    cg: [cgw(10, MAX, true), cgw(11, MAX, false)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  assert.equal(r.axAsked, false);
  ok('a minimized and a normal twin: on-screen state decides, Accessibility not asked');
}
{
  const r = await match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'Y')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', MAX), axw(10, 'Y - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  ok('one CG window claimed by two Chrome windows: neither gets it');
}
{
  const r = await match({
    chrome: [win(1, MAX, null, ''), win(2, MAX, null, 'B')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, ' - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX, true)]
  });
  assert.deepEqual(r.map, {});
  const f = await match({
    chrome: [win(1, MAX, null, 'X'), win(2, MAX, null, 'Y')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'X - Google Chrome', SMALL), axw(11, 'Y - Google Chrome', null)]
  });
  assert.deepEqual(f.map, {});
  ok('an empty title, or an AX window in another minimized state or frame: not matched');
}
{
  // Two windows with the same title and only one AX window answering with a number: AX names
  // neither (it cannot say which one), so z-order pairing still gets both.
  const r = await match({
    chrome: [win(1, MAX, 1, 'X'), win(2, MAX, 2, 'X')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 11, rect: MAX }, { num: 10, rect: MAX }],
    ax: [axw(10, 'X - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 11, 2: 10 });
  ok('one AX window for two same-titled Chrome windows: AX names neither, z-order pairs both');
}
{
  const r = await match({
    chrome: [win(1, MAX, 1, 'A'), win(2, MAX, 2, 'B'), win(3, MAX, 3, 'B')],
    cg: [cgw(10, MAX), cgw(11, MAX), cgw(12, MAX)],
    onOrder: [{ num: 12, rect: MAX }, { num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(12, 'A - Google Chrome', MAX), axw(10, 'B - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX)]
  });
  // A by AX (12); the two "B" windows by z-order among the CG windows nobody took (10 front, 11 back).
  assert.deepEqual(r.map, { 1: 12, 2: 10, 3: 11 });
  ok('three twins: one by AX, the other two paired by z-order among the CG windows left');
}
{
  // Codex r1 A: AX names one twin (the other page has no title): the last one is still paired by z-order.
  const r = await match({
    chrome: [win(1, MAX, 1, 'Mail'), win(2, MAX, 2, '')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(10, 'Mail - Google Chrome', MAX), axw(11, ' - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  ok('AX names one twin, the other page has no title: the last window is still paired (Codex r1 A)');
}
{
  // Codex r1 B3: the titles swap between the AX read and Chrome's (a page retitles itself, a tab switch).
  const r = await match({
    chrome: [win(1, MAX, null, 'A', false), win(2, MAX, null, 'B', false)].map((w, i) => ({ ...w, title2: i ? 'A' : 'B' })),
    cg: [cgw(10, MAX), cgw(11, MAX)],
    ax: [axw(10, 'A - Google Chrome', MAX), axw(11, 'B - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, {});
  assert.equal(r.titlesAsked, 4);
  ok('a title that changed while the AX table was read: that match is not used (Codex r1 B3)');
}
{
  // Codex r2 B1: both titled "A"; one retitles to "B" while AX (answering for one window only) still says
  // "A". Dropping just the changed title would leave the other "unique" and swap both; the group is skipped.
  const r = await match({
    chrome: [{ ...win(1, MAX, 1, 'A'), title2: 'B' }, win(2, MAX, 2, 'A')],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(10, 'A - Google Chrome', MAX)]
  });
  assert.deepEqual(r.map, { 1: 10, 2: 11 });
  // Window 2 passes through "A" (B → A → C) just as AX reads it, and AX misses window 1: window 1's
  // steady "A" would take window 2's number if only the changed window were skipped.
  const t = await match({
    chrome: [win(1, MAX, 1, 'A'), { ...win(2, MAX, 2, 'B'), title2: 'C' }],
    cg: [cgw(10, MAX), cgw(11, MAX)],
    onOrder: [{ num: 10, rect: MAX }, { num: 11, rect: MAX }],
    ax: [axw(11, 'A - Google Chrome', MAX)]
  });
  assert.deepEqual(t.map, { 1: 10, 2: 11 });
  ok('a title changed in a group of twins: no title match in that group, z-order pairs them (Codex r2 B1)');
}
{
  // Host AX/CG integration, read-only: only this test's own Node PID, not Chrome or a pure fixture.
  assert.deepEqual((await jsonCommand(CHROMECTL, ['axwindows', String(process.pid)])).windows, []);
  assert.equal((await jsonCommand(CHROMECTL, ['axwindows'])).ok, false);
  ok('host AX/CG, own Node PID: a windowless process has no AX windows; no pid is a usage error');
  const warm = await jsonCommand(CHROMECTL, ['--warm'], { input: JSON.stringify(['axwindows'])+'\n', retain:true });
  assert.equal(warm.ok,false); assert.equal(warm.error,'usage');
  ok('warm axwindows missing PID refuses before unrelated Chrome discovery');
}
{
  // `chromectl profiles`: the Apple Events JavaScript switch of a profile signed in to Chrome is kept with its
  // account (account_values.browser…), often with no local browser… key: that value is the one in force
  // (seen 2026-10-14: the owner's main profile read as off, and the panel said a permission was missing).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-profiles-'));
  try {
  const prefs = {
    A: { account_values: { browser: { allow_javascript_apple_events: true } } },
    B: { browser: { allow_javascript_apple_events: true } },
    C: { account_values: { browser: { allow_javascript_apple_events: false } }, browser: { allow_javascript_apple_events: true } },
    D: {}
  };
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { last_used: 'A', info_cache: Object.fromEntries(Object.keys(prefs).map(k => [k, { name: k }])) } }));
  for (const [k, v] of Object.entries(prefs)) { fs.mkdirSync(path.join(dir, k)); fs.writeFileSync(path.join(dir, k, 'Preferences'), JSON.stringify(v)); }
  const r = await jsonCommand(CHROMECTL, ['profiles'], { env: { ...process.env, CHROME_BRIDGE_CHROME_DIR: dir }, retain:true });
  assert.deepEqual(Object.fromEntries(r.profiles.map(p => [p.dir, p.appleEventsJS])), { A: true, B: true, C: false, D: false });
  const warm = await jsonCommand(CHROMECTL, ['--warm'], { input:JSON.stringify(['profiles'])+'\n', env:{ ...process.env, CHROME_BRIDGE_CHROME_DIR:dir }, retain:true });
  assert.deepEqual(Object.fromEntries(warm.profiles.map(p => [p.dir, p.appleEventsJS])), { A: true, B: true, C: false, D: false });
  ok('warm profiles reads the same fixture values before discovery or Apple Events');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  ok('profiles: the account value of the JavaScript switch wins (signed-in profiles); the local key otherwise; missing = off');
}

for(const input of ['{broken','[]','']) {
  const r=await jsonCommand(CHROMECTL,['windowmatch'],{input,retain:true});
  assert.equal(r.ok,false); assert.equal(r.error,'usage');
}
ok('actual windowmatch invalid JSON, wrong shape and EOF retain usage refusal');

const protectedCommands=[['open','https://example.invalid/'],['newwindow','https://example.invalid/'],
  ['move','1','0,0,800,600'],['close','5'],['select','5'],['activate','--tab','5'],['restore','9'],
  ['dialog','--press','OK'],['dialog','--text','fixture']];
const framing=(args,warm)=>warm?{args:['--warm'],input:JSON.stringify(args)+'\n'}:{args,input:''};
async function assertRefusals(file) {
  for(const args of protectedCommands) for(const warm of [false,true]) {
    const framed=framing(args,warm);
    const r=await jsonCommand(file,framed.args,{input:framed.input});
    assert.equal(r.ok,false); assert.equal(r.error,'native_session_required'); assert.equal(r.inputDelivery,'not_sent');
  }
}
await assertRefusals(CHROMECTL);
ok('actual cold and warm protected commands refuse before any native write');

// This small capsule checks actual startup/dispatch ordering only. Its matcher,
// profiles and AX/CG dependencies are inert; semantic cases above use the binary.
const source=fs.readFileSync(path.join(ROOT,'src/chromectl.swift'),'utf8');
function unique(text,needle) {
  const at=text.indexOf(needle); assert.ok(at>=0,needle); assert.equal(text.indexOf(needle,at+needle.length),-1,needle);
  return at;
}
function sourceFunction(prefix) {
  const start=unique(source,prefix),end=source.indexOf('\n}',start); assert.ok(end>start,prefix);
  return source.slice(start,end+2);
}
const start=unique(source,'let warm = CommandLine.arguments.count > 1');
const end=unique(source,'// Must stay before SBApplication initialization.');
assert.ok(start<end);
const dispatch=source.slice(start,end);
const early=unique(dispatch,'// Files only: works while Chrome is closed too');
const picker=unique(dispatch,'let (chromeProc, pickReport) = preWarmed?.pick ?? pickChrome()');
assert.ok(early<picker,'Offline dispatch must precede discovery.');
const earlyBlock=dispatch.slice(early,picker);
// Reverse the complete original block relocation, including its blank lines.
// No hard-coded line count and no guessed or reimplemented branch order.
const oldOrder=dispatch.slice(0,early)+dispatch.slice(picker)+earlyBlock;
assert.ok(oldOrder.indexOf('native_session_required')<oldOrder.indexOf('?? pickChrome()'));
assert.ok(oldOrder.indexOf('?? pickChrome()')<oldOrder.indexOf('// Files only:'));
const capsule=body=>`import Foundation
import CoreFoundation
import CoreGraphics // CGRect values only; the CG query symbol below is an inert local double.
${sourceFunction('func emit(')}
${sourceFunction('func fail(')}
func trace(_ value:String) {}
func trap(_ name:String,_ status:Int32)->Never {
 FileHandle.standardError.write(Data((name+"\\n").utf8)); exit(status)
}
struct FixtureChrome { let processIdentifier:pid_t }
func pickChrome()->(FixtureChrome?,[[String:Any]]) { trap("qa_discovery_reached",73) }
final class SBApplication {
 init?(processIdentifier:pid_t) { trap("qa_warm_ae_reached",74) }
 func value(forKey:String)->Any? { trap("qa_warm_ae_reached",74) }
}
final class SBElementArray { let count=0 }
func profilesReport()->[String:Any] { ["ok":true,"qaProfiles":true] }
struct ChromeWin { let id:Int,rect:CGRect,minimized:Bool,index:Int? }
func matchWindows(_ cw:[ChromeWin],cg:[(num:Int,rect:CGRect,onScreen:Bool)],
 onOrder:()->[(num:Int,rect:CGRect)],ax:()->[(num:Int,title:String,minimized:Bool,rect:CGRect?)],
 title:(Int)->String)->[Int:Int] { [701:801] }
func CGWindowListCopyWindowInfo(_ options:CGWindowListOption,_ id:CGWindowID)->CFArray? {
 FileHandle.standardError.write(Data("qa_cg_stub\\n".utf8)); return nil
}
func axWindowTable(pid:pid_t)->[(num:Int,title:String,minimized:Bool,rect:CGRect?)] {
 FileHandle.standardError.write(Data("qa_ax_stub:\\(pid)\\n".utf8)); return []
}
func sameRect(_ a:CGRect,_ b:CGRect)->Bool { false }
// The --warm-read pre-warm is test/warm-read.test.mjs's; no fixture here may reach it.
func preWarmReadOnly()->(pick:(FixtureChrome?,[[String:Any]]),chrome:SBApplication) { trap("qa_prewarm_reached",75) }
func preWarmBindingCurrent(_ pid:pid_t)->Bool { trap("qa_binding_reached",76) }
// Cold-only native probes of a given pid: inert doubles that report their own dispatch.
struct NativeInputProbeError: Error { let code:String; let message:String; var details:[String:Any]=[:] }
func nativePageContent(pid:pid_t,expectedWindow:Int) throws->[String:Any] { ["ok":true,"qaContent":Int(pid)] }
func nativeInputProbe(pid:pid_t,expectedWindow:Int,point:CGPoint?) throws->[String:Any] { ["ok":true,"qaInput":Int(pid)] }
func nativeDialogCommand(_ args:[String])->Never { emit(["ok":true,"qaDialog":args.count]) }
${body}
fail("qa_unhandled","Dispatch did not handle the fixture")
`;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cb-dispatch-'));
try {
  const build=async(name,body)=>{
    const file=path.join(tmp,name+'.swift'),binary=path.join(tmp,name),program=capsule(body);
    assert.doesNotMatch(program,/import (?:AppKit|ScriptingBridge|ApplicationServices)|NSWorkspace|Process\(|\.run\(|processArgs\(|CoreGraphics\.|AXUIElement/);
    fs.writeFileSync(file,program);
    const result=await runOwned('/usr/bin/swiftc',[file,'-o',binary],{timeoutMs:60000,retain:true});
    assert.equal(result.code,0,JSON.stringify(result)); assert.equal(result.signal,null);
    return binary;
  };
  const current=await build('current-dispatch',dispatch),mutant=await build('old-order',oldOrder);
  const cases=[
    {name:'windowmatch',args:['windowmatch'],input:'{}',expected:{ok:true,map:{701:801},axAsked:false,titlesAsked:0}},
    {name:'windowmatch malformed',args:['windowmatch'],input:'{broken',error:'usage'},
    {name:'profiles cold',args:['profiles'],expected:{ok:true,qaProfiles:true}},
    {name:'profiles warm',...framing(['profiles'],true),expected:{ok:true,qaProfiles:true}},
    {name:'axwindows inert PID',args:['axwindows','777'],expected:{ok:true,pid:777,windows:[]},stderr:'qa_cg_stub\nqa_ax_stub:777\n'},
    {name:'axwindows missing PID',args:['axwindows'],error:'usage'},
    {name:'axwindows warm missing PID',...framing(['axwindows'],true),error:'usage'},
    {name:'unbound dialog cold',args:['dialog'],expected:{ok:true,qaDialog:1}},
    {name:'axinput given PID',args:['axinput','777','--window','5','--focus'],expected:{ok:true,qaInput:777}},
    {name:'axcontent given PID',args:['axcontent','777','--window','5'],expected:{ok:true,qaContent:777}},
    {name:'axinput warm',...framing(['axinput','777','--window','5','--focus'],true),error:'usage'}
  ];
  for(const fixture of cases) {
    const result=await runOwned(current,fixture.args,{input:fixture.input,retain:true});
    assert.equal(result.code,0,JSON.stringify(result)); assert.equal(result.stderr,fixture.stderr??'');
    const parsed=JSON.parse(result.stdout);
    if(fixture.error) { assert.equal(parsed.ok,false); assert.equal(parsed.error,fixture.error); }
    else assert.deepEqual(parsed,fixture.expected);
    const old=await runOwned(mutant,fixture.args,{input:fixture.input,retain:true});
    assert.equal(old.code,73); assert.equal(old.signal,null); assert.equal(old.stderr,'qa_discovery_reached\n'); assert.equal(old.stdout,'');
    assert.throws(()=>assert.equal(old.code,0,fixture.name+': expected normal dispatch, reached discovery sentinel'),assert.AssertionError);
  }
  const control=await runOwned(current,['pick'],{retain:true});
  assert.equal(control.code,73); assert.equal(control.stderr,'qa_discovery_reached\n');
  await assertRefusals(current); await assertRefusals(mutant);
  receipts.push({dispatchSha256:createHash('sha256').update(dispatch).digest('hex'),
    oldOrderSha256:createHash('sha256').update(oldOrder).digest('hex'),cases:cases.length,
    currentAndMutantCompiled:true,oldOrderFailures:'All reached exact discovery sentinel; normal-result assertions failed.',
    protectedColdWarmRefusalsPerBinary:protectedCommands.length*2});
  ok('actual dispatch avoids discovery; successfully compiled old-order mutant reaches the armed sentinel');
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
console.log(`\nwindowmatch checks passed (${passed}).`);
