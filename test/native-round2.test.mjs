// Compile extracted production flows against inert effects. No AX/CG input,
// Apple Events, Chrome, or product binaries are invoked by this fixture.
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as B from '../src/bridge.js';
import { checkTakeover, closeVerdict } from '../src/tabs.js';
const helper = fs.readFileSync(new URL('../src/helper.swift', import.meta.url), 'utf8');
const native = fs.readFileSync(process.env.MYCHROME_ROUND2_NATIVE_SOURCE || new URL('../src/native-chrome.swift', import.meta.url), 'utf8');
const cli = fs.readFileSync(process.env.MYCHROME_ROUND2_CLI_SOURCE || new URL('../src/chromectl.swift', import.meta.url), 'utf8');
function block(source, declaration) {
  const start = source.indexOf(declaration); assert.ok(start >= 0, declaration);
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
  const end = source.indexOf('\n' + indent + '}', start); assert.ok(end > start, declaration);
  return source.slice(start, end + indent.length + 2);
}
const evidenceRoot = process.env.MYCHROME_ROUND2_EVIDENCE_DIR || os.tmpdir();
fs.mkdirSync(evidenceRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(evidenceRoot, 'mychrome-native-round2-'));
const invocations = [];
const digest = value => createHash('sha256').update(value).digest('hex');
function invoke(file, args, label) {
 const child = spawnSync(file, args, { stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
 const stdout = child.stdout || Buffer.alloc(0), stderr = child.stderr || Buffer.alloc(0);
 const stem = path.join(temp, `${invocations.length}-${label}`);
 fs.writeFileSync(stem + '.stdout', stdout); fs.writeFileSync(stem + '.stderr', stderr);
 invocations.push({ argv: [file, ...args], exitCode: child.status, signal: child.signal, error: child.error?.message ?? null,
   stdout: stem + '.stdout', stderr: stem + '.stderr', stdoutSha256: digest(stdout), stderrSha256: digest(stderr) });
 fs.writeFileSync(path.join(temp, 'execution-receipt.json'), JSON.stringify({ sourceSha256: digest(native), cliSha256: digest(cli), invocations }, null, 2) + '\n');
 assert.equal(child.error, undefined, `Full execution logs: ${stem}`);
 assert.equal(child.signal, null, `Full execution logs: ${stem}`);
 assert.equal(child.status, 0, `Full execution logs: ${stem}`);
 return stdout.toString();
}
const requireRestore = block(helper, 'func requireRestore()');
const swift = `import Foundation
import AppKit
import Carbon
struct ChromeNative { static func dialogInt(_ v: Any?) -> Int? { guard let n = v as? Int, n > 0 else { return nil }; return n } }
${['struct Target:', 'struct Failure:', 'struct WindowRow:'].map(x => block(native, x)).join('\n')}
${['func bounds(', 'func resultTarget(', 'func rectangle('].map(x => block(native, x)).join('\n')}
enum Halt: Error { case bad(String, String), aborted, interrupted, terminated }
func pointArg(_ v: Any?) -> CGPoint? { guard let r = v as? [String: Double], let x = r["x"], let y = r["y"] else { return nil }; return CGPoint(x: x,y: y) }
func pointJSON(_ p: CGPoint) -> [String: Any] { ["x":p.x,"y":p.y] }
func writeLine(_ value: [String: Any]) {}
final class Panel { var callback: (() -> Void)?; func begin(_ value: String) { callback?() } }
final class Veil { func pointerReturned(to p: CGPoint) {} }
final class Fixture {
 var monitor=true, begun=true, nativeRevoked=false, nativeUncertain=false, takeover=true, holding=true, nativePaused=false
 var aborted=false, eof=false, terminate=false, opRunning=true, dry=false
 var pendingEnd: [String: Any]? = nil, interrupted: [String: Any]? = nil
 let lock=NSLock(); var queue:[[String:Any]]=[], triggers:[[String:Any]]=[]
 var panel:Panel?=Panel(), veil:Veil?=nil
 var fake=(cursor:CGPoint.zero, unused:0), warps=0, controls=0, settleControl:String?=nil, panelControl:String?=nil
 func revokeNativeState() { nativeRevoked=true }
 // Only the OS/control effect is injected; queue extraction, stop check and
 // both restoration guards below are the unchanged production functions.
 func applyControl(_ c:[String:Any]) { controls += 1
   let op=c["op"] as? String ?? ""
   if op == "cancel" { aborted=true; nativeRevoked=true; holding=false }
   if op == "revokeNative" { if c["reason"] as? String == "pause" { nativePaused=true } else { nativeRevoked=true; holding=false } }
   if op == "end" { pendingEnd=c }
 }
 func enqueue(_ kind:String) { if kind == "eof" { eof=true } else { queue.append(["op":kind == "pause" ? "revokeNative" : kind,"reason":kind == "pause" ? "pause":"caller_cancel"]) } }
 func settle() { if let c=settleControl { enqueue(c) } }
 func restorePointer(to p:CGPoint) -> [String:Any] { warps += 1; return ["ok":true,"verified":true,"warped":pointJSON(p)] }
 ${['func checkStop(', 'func isControl(', 'func drainControl(', 'func requireRestore()', 'func opWarp('].map(x => block(helper,x)).join('\n')}
}
let arg=try! JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
var r:[String:Any]=[:]
do {
 if arg["mode"] as? String == "warp" {
   let f=Fixture(); f.settleControl=arg["control"] as? String
   if arg["during"] as? String == "panel" { f.settleControl=nil; f.panel?.callback={ f.enqueue(arg["control"] as! String) } }
   if arg["holdLost"] as? Bool == true { f.holding=false }
   do { r=try f.opWarp(["to":["x":10.0,"y":20.0]]) } catch { r=["ok":false,"error":String(describing:error)] }
   r["warps"]=f.warps; r["controls"]=f.controls
 } else if arg["mode"] as? String == "target" {
   let t=try Target(["chromePid":7,"windowId":4,"tabId":9,"cgWindow":11])
   let row=WindowRow(id:4,tabs:[9,10],activeTab:arg["active"] as? Int ?? 9,index:1,bounds:CGRect(x:0,y:0,width:800,height:600),minimized:false,title:"active title",tabURLs:(arg["url"] as? String).map{[9:$0]} ?? [:])
   r=resultTarget(t,row); r["ok"]=true
 } else {
   let rect: CGRect
   if arg["mode"] as? String == "rectangle" { let a=arg["values"] as! [Double]; rect=CGRect(x:a[0],y:a[1],width:a[2],height:a[3]) }
   else { rect=try bounds(["bounds":arg["bounds"]!]) }
   let descriptor=try rectangle(rect)
   r=["ok":true,"rect":[rect.minX,rect.minY,rect.width,rect.height],"bytes":descriptor.data.count]
 }
} catch let e as Failure { r=e.json } catch { r=["ok":false,"error":String(describing:error)] }
print(String(data:try! JSONSerialization.data(withJSONObject:r),encoding:.utf8)!)
`;
function compile(name, script) { const src=path.join(temp,name+'.swift'), bin=path.join(temp,name); fs.writeFileSync(src,script); invoke('/usr/bin/swiftc',[src,'-o',bin],name+'-compile'); return bin; }
const binary = compile('actual',swift);
const run = (value, bin=binary) => JSON.parse(invoke(bin,[JSON.stringify(value)],path.basename(bin)));
let passed=0;
async function test(name,fn){ await fn(); console.log(`ok ${++passed} ${name}`); }
await test('queued cancel/revoke/end during settle or panel callback blocks actual opWarp',()=>{
 for(const control of ['cancel','revokeNative','end']) for(const during of ['settle','panel']) {
  const r=run({mode:'warp',control,during}); assert.equal(r.ok,false,JSON.stringify(r)); assert.equal(r.warps,0); assert.equal(r.controls,1);
 }
 for(const v of [{control:'eof'},{holdLost:true}]) { const r=run({mode:'warp',...v}); assert.equal(r.ok,false); assert.equal(r.warps,0); }
});
await test('healthy Pause permits restoration after servicing its queued control',()=>{
 for(const during of ['settle','panel']) { const r=run({mode:'warp',control:'pause',during}); assert.equal(r.ok,true); assert.equal(r.warps,1); assert.equal(r.controls,1); }
});
await test('removing requireRestore control drain reproduces pointer dispatch after queued Stop',()=>{
 const mutant=requireRestore.replace('drainControl()','/* mutant removed control service */'); assert.notEqual(mutant,requireRestore);
 const bin=compile('no-drain',swift.replace(requireRestore,mutant));
 for(const control of ['cancel','revokeNative','end']) { const r=run({mode:'warp',control},bin); assert.equal(r.warps,1); assert.equal(r.controls,0); }
});
await test('actual bounds and Apple Event rectangle descriptor accept ordinary and boundary rectangles',()=>{
 for(const bounds of [{left:10.2,top:20.3,width:799.7,height:599.9},{left:-32768,top:-32768,width:65535,height:65535}]) {
  const r=run({bounds}); assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.bytes,8);
 }
});
await test('rounded endpoint overflow, zero-rounded size and unchecked descriptor extremes refuse',()=>{
 for(const bounds of [
  {left:32766.6,top:0,width:0.6,height:1}, {left:0,top:32766.6,width:1,height:0.6},
  {left:0,top:0,width:0.4,height:1}, {left:0,top:0,width:1,height:0.4},
  {left:-32768.1,top:0,width:1,height:1}, {left:0,top:0,width:1e100,height:1},
 ]) { const r=run({bounds}); assert.equal(r.error,'native_bounds_invalid',JSON.stringify(r)); }
 for(const values of [[0,0,-1,1],[0,0,1,0],[0.1,0,1,1],[32767,0,1,1],[-32769,0,1,1],[0,0,1e100,1]])
  assert.equal(run({mode:'rectangle',values}).error,'native_bounds_invalid');
});
await test('actual resultTarget current metadata survives real activate/select and caller ownership checks',async()=>{
 for(const op of ['activate','selectTab']) for(const url of ['https://fixture.test/','https://changed.test/',null]) {
  const shape=run({mode:'target',url,active:10}); assert.equal(shape.url,url); assert.equal(shape.title,null);
  const native=async intent=>{assert.equal(intent.kind,op);assert.equal(intent.windowId,null);return shape;};
  const receipt=op==='activate'?await B.activateChrome(9,null,{native}):await B.selectTab(9,{native});
  const rec={tabId:9,windowId:4,expectedUrl:'https://fixture.test/'};
  const ownership=checkTakeover(rec,{...receipt,id:9}); assert.equal(ownership.changed,url==='https://changed.test/');
  if(url===null) assert.equal(closeVerdict(ownership.rec,receipt).reason,'ownership_unverified');
 }
 const active=run({mode:'target',url:'https://fixture.test/'}); assert.equal(active.title,'active title');
});
// The raw handBack branch is separate from typed native restoration. Compile
// its exact flow with Foundation only: these App/Workspace names are local
// inert fakes, and activate merely changes an in-memory PID and counter.
const handBack = block(helper, 'func opHandBack(');
const dryFinal = 'if dry {\n            try requireRestore()';
const lookupFinal = '        try requireRestore()\n        app.activate(options: [])';
assert.equal(handBack.split(dryFinal).length, 2, 'one precise dry final guard');
assert.equal(handBack.split(lookupFinal).length, 2, 'one precise lookup final guard');
const handBackSwift = `import Foundation
enum Halt: Error { case bad(String,String), aborted, interrupted, terminated }
func num(_ v:Any?) -> Int? { v as? Int }
func writeLine(_ value:[String:Any]) {}
final class NSRunningApplication {
 static var lookup:(()->Void)?=nil, activations=0
 let processIdentifier:pid_t
 init?(processIdentifier:pid_t) { Self.lookup?(); self.processIdentifier=processIdentifier }
 func activate(options:[String]) { Self.activations += 1; NSWorkspace.shared.frontmostApplication=self }
}
final class NSWorkspace { static let shared=NSWorkspace(); var frontmostApplication:NSRunningApplication?=nil }
final class Panel { var callback:(()->Void)?=nil; func begin(_ stage:String) { callback?() } }
final class Fixture {
 var monitor=true, begun=true, nativeRevoked=false, nativeUncertain=false, takeover=true, holding=true, nativePaused=false
 var aborted=false, eof=false, terminate=false, opRunning=true, dry=false
 var pendingEnd:[String:Any]?=nil, interrupted:[String:Any]?=nil
 let lock=NSLock(); var queue:[[String:Any]]=[],triggers:[[String:Any]]=[]
 var panel:Panel?=Panel(),controls=0,waits=0
 func revokeNativeState() { nativeRevoked=true }
 func settle() {}
 func wait(_ ms:Double) throws { waits += 1; try checkStop() }
 func applyControl(_ c:[String:Any]) { controls += 1
  let op=c["op"] as? String ?? ""
  if op == "cancel" { aborted=true; nativeRevoked=true; holding=false }
  if op == "revokeNative" { if c["reason"] as? String == "pause" { nativePaused=true } else { nativeRevoked=true; holding=false } }
  if op == "end" { pendingEnd=c }
 }
 func enqueue(_ kind:String) { if kind == "eof" { eof=true } else { queue.append(["op":kind == "pause" ? "revokeNative":kind,"reason":kind == "pause" ? "pause":"caller_cancel"]) } }
 ${['func checkStop(', 'func isControl(', 'func drainControl(', 'func requireRestore()'].map(x=>block(helper,x)).join('\n')}
 ${handBack}
}
let arg=try! JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
let f=Fixture();f.dry=arg["dry"] as? Bool ?? false
let kind=arg["control"] as? String
if let c=kind {
 if arg["during"] as? String == "lookup" { NSRunningApplication.lookup={f.enqueue(c)} }
 else { f.panel?.callback={f.enqueue(c)} }
}
var result:[String:Any]=[:]
do { result=try f.opHandBack(["pid":99]) } catch { result=["ok":false,"error":String(describing:error)] }
// Removing the queued control cannot revive a terminal Session.
f.panel?.callback=nil;NSRunningApplication.lookup=nil;f.queue.removeAll()
if result["ok"] as? Bool == false {
 do { result["secondOk"]=try f.opHandBack(["pid":99])["ok"] ?? NSNull() }
 catch { result["secondOk"]=false;result["secondError"]=String(describing:error) }
}
result["activations"]=NSRunningApplication.activations;result["controls"]=f.controls;result["waits"]=f.waits
result["frontmostPid"]=NSWorkspace.shared.frontmostApplication?.processIdentifier as Any? ?? NSNull()
print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`;
assert.doesNotMatch(handBackSwift, /import AppKit|import ApplicationServices|import Carbon/);
const handBackBinary = compile('handback-actual', handBackSwift);
await test('actual raw handBack refuses panel/lookup Stop and EOF and remains terminal on the next call',()=>{
 for(const control of ['cancel','revokeNative','end','eof']) for(const during of ['panel','lookup']) {
  const r=run({control,during},handBackBinary);assert.equal(r.ok,false,JSON.stringify(r));
  assert.equal(r.activations,0);assert.equal(r.frontmostPid,null);assert.equal(r.secondOk,false);assert.equal(r.waits,0);
 }
 for(const control of ['cancel','revokeNative','end','eof']) {
  const r=run({control,during:'panel',dry:true},handBackBinary);assert.equal(r.ok,false);assert.equal(r.secondOk,false);assert.equal(r.activations,0);
 }
});
await test('raw handBack admits healthy Pause once with immediate fake frontmost and supports its dry reply',()=>{
 for(const during of ['panel','lookup']) {
  const r=run({control:'pause',during},handBackBinary);assert.equal(r.ok,true);assert.equal(r.frontmost,true);
  assert.equal(r.activations,1);assert.equal(r.frontmostPid,99);assert.equal(r.controls,1);assert.equal(r.waits,0);
 }
 const dry=run({control:'pause',during:'panel',dry:true},handBackBinary);
 assert.equal(dry.ok,true);assert.equal(dry.dryRun,true);assert.equal(dry.controls,1);assert.equal(dry.activations,0);
});
await test('removing only raw handBack post-lookup final guard exposes a forbidden fake activation',()=>{
 const mutant=handBack.replace(lookupFinal,'        app.activate(options: [])');assert.notEqual(mutant,handBack);
 const bin=compile('handback-no-lookup-guard',handBackSwift.replace(handBack,mutant));
 for(const control of ['cancel','revokeNative','end','eof']) {
  const r=run({control,during:'lookup'},bin);assert.equal(r.activations,1);assert.equal(r.frontmostPid,99);assert.equal(r.ok,true);
 }
});
await test('removing only raw handBack dry final guard falsely acknowledges queued panel Stop',()=>{
 const mutant=handBack.replace(dryFinal,'if dry {');assert.notEqual(mutant,handBack);
 const bin=compile('handback-no-dry-guard',handBackSwift.replace(handBack,mutant));
 for(const control of ['cancel','revokeNative','end','eof']) {
  const r=run({control,during:'panel',dry:true},bin);assert.equal(r.ok,true);assert.equal(r.dryRun,true);assert.equal(r.activations,0);
 }
});
// Exercise the Owner adapter, not a replica of matchWindows. Only effects and
// framework handles are inert; closure wiring, guards and transaction ledger
// below are extracted verbatim from the source under test.
function exactBlock(source, declaration) {
 assert.equal(source.split(declaration).length,2,`unique production declaration: ${declaration}`);
 return block(source,declaration);
}
const mappingBody=exactBlock(native,'func cgMapping(');
const titleCallback=/title: \{ currentTitles\[rows\[\$0\]\.id\] \?\? "" \}/;
const mappingMutant=process.env.MYCHROME_MAPPING_MUTANT==='frozen-title';
let testedMapping=mappingBody;
if(mappingMutant){
 assert.equal([...mappingBody.matchAll(new RegExp(titleCallback.source,'g'))].length,1,'one production title callback');
 testedMapping=mappingBody.replace(titleCallback,'title: { rows[$0].title }');
}
const mappingTypes=`import Foundation
import CoreFoundation
import CoreGraphics
typealias CFString = String
typealias CFTypeRef = AnyObject
let kCGNullWindowID=0
let kCGWindowOwnerPID="pid",kCGWindowLayer="layer",kCGWindowNumber="number",kCGWindowBounds="bounds",kCGWindowIsOnscreen="onScreen"
let kAXTitleAttribute="title",kAXMinimizedAttribute="minimized",kAXDocumentAttribute="document"
enum CGOption { case optionAll }
enum AXError { case success, cannotComplete }
struct AXElement { let num:Int,title:String,minimized:Bool,rect:CGRect?; var document:String? = nil }
// Deterministic time is a fixture dependency, not a new production deadline.
final class ProcessInfo { static let processInfo=ProcessInfo(); var systemUptime:Double=0 }
enum ChromeNative {
 ${['struct Target:','struct Failure:','struct WindowRow:','struct DialogFailure:','static func dialogInt(','static func sameRect(','static func matchWindows(','final class Transaction {','struct WindowGeometryIntent {','static func geometryIntent('].map(x=>exactBlock(native,x)).join('\n')}
 ${exactBlock(native, 'struct ReadFailure:')}
 ${native.match(/^struct ChromeWin \{[^\n]+$/m)?.[0] ?? assert.fail('production ChromeWin value type')}
 static var readSnapshotEffect: (pid_t) throws -> [WindowRow] = { _ in [] }
 static func readSnapshot(_ pid: pid_t) throws -> [WindowRow] { try readSnapshotEffect(pid) }
 final class Probe {
  var deadline:Double=10,firstFailure:Error?,checkpoint:() throws -> Void={}
  var snapshot:(pid_t) throws -> [WindowRow]={_ in []}
  var cg:[[String:Any]]=[],ax:[AXElement]=[],events:[String]=[],phase="initial",snapshots=0,axCalls=0
  static var configure: ((Probe) -> Void)?
  init() { Self.configure?(self) }
  ${exactBlock(native,'func check() throws')}
  ${exactBlock(native,'func around<T>(')}
  func CGWindowListCopyWindowInfo(_ options:[CGOption],_ relative:Int)->Any? { around(nil as [[String:Any]]?) { events.append("cg");phase="after_cg";return cg } }
  func axWindows(pid:pid_t)->[AXElement] { around([]) { axCalls += 1;events.append("ax");phase="after_ax";return ax } }
  func axWindowNumber(_ e:AXElement)->Int? { around(nil as Int?) { e.num } }
  func AXUIElementCopyAttributeValue(_ e:AXElement,_ key:CFString,_ value:UnsafeMutablePointer<CFTypeRef?>)->AXError {
   around(.cannotComplete) {
    if key == kAXDocumentAttribute { guard let document=e.document else { return .cannotComplete };value.pointee=document as AnyObject }
    else { value.pointee=(key==kAXTitleAttribute ? e.title as AnyObject : e.minimized as AnyObject) }
    return .success
   }
  }
  func axRect(_ e:AXElement)->CGRect? { around(nil as CGRect?) { e.rect } }
 }
 final class Owner {
  var dry=false,dryCG:[Int:Int]=[:],stopped=false,rows:[WindowRow]=[],continuations=0,identityCalls=0,snapshotCalls=0,freshProbe=false,pauses=0,ownerDelay=0.0,selectDelivery:String?=nil,snapshotUntils:[Double]=[],probeUntils:[Double]=[]
  var target:Target?=nil
  func seed(_ t:Target) {}
  // Round 2 (A2): the production run() with an inert one-write executor (a select_tab ledger entry, no OS call).
  var active:Transaction?,lastTransaction:Transaction?,mutationRequested=false,callId:String?=nil
  private var operations=Set<String>()
  var pump:() throws -> Void={ ProcessInfo.processInfo.systemUptime += 0.01 }
  func execute(_ intent:[String:Any],request:[String:Any],tx:Transaction) throws -> [String:Any] { _ = try tx.write("select_tab") { 1 };return ["ok":true] }
  func executeDry(_ intent:[String:Any],request:[String:Any],tx:Transaction) throws -> [String:Any] { try execute(intent,request:request,tx:tx) }
  private var creationPin:(window:Int,cg:Int,cgs:Set<Int>,windows:Set<Int>)?
  var stageCheck:(String) throws -> Void={_ in};let access=Probe()
  init(dry: Bool = false) { self.dry = dry }
  func identity(_ pid:pid_t) throws { identityCalls += 1;try requireAlive("native_identity") }
  func snapshot(_ pid:pid_t,until:Double?=nil) throws ->[WindowRow] {
   snapshotCalls += 1;snapshotUntils.append(until ?? -1);ProcessInfo.processInfo.systemUptime += ownerDelay;return rows
  }
  // freshProbe: production probe() returns a new Probe per call (no carried firstFailure); until is its absolute deadline.
  func probe(until:Double?=nil)->Probe { if freshProbe { access.firstFailure=nil };probeUntils.append(until ?? -1);access.deadline=until ?? 10;return access }
  ${exactBlock(native,'func requireAlive(')}
  ${testedMapping}
  ${exactBlock(native,'func verify(')}
  ${exactBlock(native,'func bind(')}
  ${exactBlock(native,'func rescanVerify(')}
  ${exactBlock(native,'func rescanPause(').replace('throws {','throws { pauses += 1')}
  ${exactBlock(native,'func run(')}
  ${exactBlock(native,'func enterCall(')}
 }
}
typealias Row=ChromeNative.WindowRow
func rect(_ raw:Any?)->CGRect { let a=raw as? [Double] ?? [0,0,800,600];return CGRect(x:a[0],y:a[1],width:a[2],height:a[3]) }
func rows(_ raw:Any?)->[Row] { (raw as? [[String:Any]] ?? []).map { r in
 var urls=(r["urls"] as? [String:String] ?? [:]).reduce(into:[Int:String]()) { if let key=Int($1.key) { $0[key]=$1.value } }
 if let url=r["url"] as? String { urls[11]=url }
 return Row(id:r["id"] as! Int,tabs:r["tabs"] as? [Int] ?? [11,12],activeTab:r["active"] as? Int ?? 11,index:r["index"] as! Int,
 bounds:rect(r["rect"]),minimized:r["minimized"] as? Bool ?? false,title:r["title"] as? String ?? "",tabURLs:urls)
} }
`;
const mappingSwift=mappingTypes+`
let arg=try! JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
let o=ChromeNative.Owner(),p=o.access;o.rows=rows(arg["before"])
p.cg=(arg["cg"] as? [[String:Any]] ?? []).map { r in
 [kCGWindowOwnerPID:7,kCGWindowLayer:0,kCGWindowNumber:r["num"]!,kCGWindowBounds:rect(r["rect"]).dictionaryRepresentation as NSDictionary,kCGWindowIsOnscreen:r["onScreen"] ?? true]
}
p.ax=(arg["ax"] as? [[String:Any]] ?? []).map{ AXElement(num:$0["num"] as! Int,title:$0["title"] as! String,minimized:$0["minimized"] as? Bool ?? false,rect:rect($0["rect"]),document:$0["document"] as? String) }
p.snapshot={_ in
 p.snapshots += 1;p.events.append("snapshot");p.phase="after_snapshot"
 if let code=arg["readFailure"] as? String { throw ChromeNative.Failure(code,"native_read",osStatus:-1743) }
 // NAT-RETRY: the window list settles at "after"; the next owner snapshot reads it.
 if arg["settle"] as? Bool == true { o.rows=rows(arg["after"]) }
 return rows(arg["after"] ?? arg["before"])
}
p.checkpoint={
 if arg["haltPhase"] as? String == p.phase {
  if arg["haltKind"] as? String == "deadline" { ProcessInfo.processInfo.systemUptime=20 }
  else { throw ChromeNative.Failure("user_cancelled","native_ax_read") }
 }
}
if arg["firstFailure"] as? Bool == true { p.firstFailure=ChromeNative.Failure("native_permission_required","native_read",osStatus:-1743) }
var result:[String:Any]=[:]
do {
 if arg["mode"] as? String == "transaction" {
  let tx=ChromeNative.Transaction(operationId:"synthetic-private-operation",checkpoint:{_ in})
  for step in arg["steps"] as? [[String:Any]] ?? [] {
   if step["kind"] as? String == "read" { _ = try tx.read(step["stage"] as! String) { 1 } }
   else { do { _ = try tx.write(step["stage"] as! String) { () throws -> Int in
     if step["fail"] as? Bool == true { throw ChromeNative.Failure("native_write_unknown","native_dispatch") };return 1
   } } catch {} }
  }
  result=tx.result(["ok":false,"code":"native_target_changed","stage":"native_binding","bindingReason":"cg_mapping_mismatch"])
 } else if arg["mode"] as? String == "verify" {
  let target=try ChromeNative.Target(["chromePid":7,"windowId":1,"tabId":11,"cgWindow":arg["targetCG"] ?? 201])
  _ = try o.verify(target,requireActive:arg["requireActive"] as? Bool ?? false)
  o.continuations += 1;result=["ok":true]
 } else if arg["mode"] as? String == "calls" {
  // NAT-RETRY r3: one held Owner across MCP calls. Each attempt re-arms the same transient window-list change.
  o.freshProbe=true
  o.enterCall("call-A")
  _ = try o.run(["operationId":"select-op","intent":["kind":"selectTab"]])
  func attempt() -> [String:Any] {
   o.rows=rows(arg["before"]);o.pauses=0
   do { _ = try o.bind(["chromePid":7,"windowId":1,"tabId":11,"cgWindow":201]);return ["ok":true,"pauses":o.pauses] }
   catch let e as ChromeNative.Failure { var j=e.json;j["pauses"]=o.pauses;return j }
   catch { return ["ok":false,"error":String(describing:error)] }
  }
  result["sameCall"]=attempt()
  o.enterCall("call-A");result["sameIdAgain"]=attempt()
  o.enterCall("call-B");result["nextCall"]=attempt()
  o.continuations += 1;result["ok"]=true
 } else if arg["mode"] as? String == "bind" {
  o.freshProbe=true;o.ownerDelay=arg["ownerDelay"] as? Double ?? 0
  if arg["selectFirst"] as? Bool == true {
   let sent=try o.run(["operationId":"select-op","intent":["kind":"selectTab"]])
   o.selectDelivery=sent["inputDelivery"] as? String
  }
  if arg["slowFinal"] as? Bool == true { o.stageCheck={ stage in if stage == "native_binding" && o.identityCalls == 2 { ProcessInfo.processInfo.systemUptime += 5 } } }
  _ = try o.bind(["chromePid":7,"windowId":1,"tabId":11,"cgWindow":arg["targetCG"] ?? 201])
  o.continuations += 1;result["ok"]=true;result["bound"]=o.target != nil
 } else {
  let mapping=try o.cgMapping(7,rows:o.rows,access:p)
  // A synthetic would-be-write continuation proves return/throw control flow
  // only. This counter performs no native/OS operation.
  o.continuations += 1
  result=["ok":true,"mapping":mapping.reduce(into:[String:Int]()){$0[String($1.key)]=$1.value}]
 }
} catch let e as ChromeNative.Failure { result=e.json }
catch let e as ChromeNative.DialogFailure { result=e.json }
catch { result=["ok":false,"error":String(describing:error)] }
result["snapshotCount"]=p.snapshots;result["axCount"]=p.axCalls;result["events"]=p.events;result["continuations"]=o.continuations
result["ownerSnapshotCount"]=o.snapshotCalls;result["identityCount"]=o.identityCalls;result["pauses"]=o.pauses
result["selectDelivery"]=o.selectDelivery ?? NSNull();result["snapshotUntils"]=o.snapshotUntils;result["probeUntils"]=o.probeUntils;result["clock"]=ProcessInfo.processInfo.systemUptime
print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`;
assert.doesNotMatch(mappingSwift,/import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)|@_silgen_name|CoreGraphics\.CGWindowListCopyWindowInfo|ApplicationServices\./);
const mappingBinary=compile(mappingMutant?'mapping-frozen-title':'mapping-actual',mappingSwift);
console.log(`mapping capsule compiled successfully (${mappingMutant?'frozen-title mutant':'production'})`);
const row=(id,title,index=id,extra={})=>({id,title,index,...extra});
const baseRows=[row(1,'A'),row(2,'B')];
const baseCG=[{num:202},{num:201}];
const partialAX=[{num:201,title:'A - Google Chrome'}];
const retitle={before:baseRows,after:[row(1,'C'),row(2,'A')],cg:baseCG,ax:partialAX};
const mappingRun=value=>run(value,mappingBinary);
function assertRetitle(result){
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.mapping,{'1':202,'2':201},'fresh-title Owner adapter must use the unchanged order fallback');
 assert.equal(result.snapshotCount,1);assert.equal(result.axCount,1);assert.equal(result.continuations,1);
}
await test('actual Owner fresh-title callback rejects the stale partial-AX pairing',()=>assertRetitle(mappingRun(retitle)));
await test('actual Owner unique bounds avoids AX and the added snapshot',()=>{
 const r=mappingRun({before:[row(1,'A')],cg:[{num:201}],ax:partialAX});
 assert.deepEqual(r.mapping,{'1':201});assert.equal(r.snapshotCount,0);assert.equal(r.axCount,0);assert.equal(r.continuations,1);
});
await test('actual Owner stable, reordered and complete-retitle rows use one after-AX snapshot',()=>{
 const ax=[{num:201,title:'A - Google Chrome'},{num:202,title:'B - Google Chrome'}];
 for(const after of [baseRows,[...baseRows].reverse(),baseRows.map(r=>({...r,url:'https://changed.invalid/'}))]){
  const r=mappingRun({before:baseRows,after,cg:baseCG,ax});assert.deepEqual(r.mapping,{'1':201,'2':202});
  assert.equal(r.snapshotCount,1);assert.equal(r.axCount,1);assert.deepEqual(r.events,['cg','ax','snapshot']);
 }
 assertRetitle(mappingRun({...retitle,ax:[...partialAX,{num:202,title:'C - Google Chrome'}]}));
 assertRetitle(mappingRun({...retitle,after:[...retitle.after].reverse()}));
});
await test('actual Owner rejects every structural drift and duplicate ID before an inert continuation',()=>{
 const drifts={removed:[baseRows[0]],added:[...baseRows,row(3,'C')],id:[row(3,'A'),baseRows[1]],
  tabs:[row(1,'A',1,{tabs:[11,13]}),baseRows[1]],tabOrder:[row(1,'A',1,{tabs:[12,11]}),baseRows[1]],
  active:[row(1,'A',1,{active:12}),baseRows[1]],bounds:[row(1,'A',1,{rect:[1,0,800,600]}),baseRows[1]],
  minimized:[row(1,'A',1,{minimized:true}),baseRows[1]],index:[row(1,'A',3),baseRows[1]],duplicate:[baseRows[0],baseRows[0]]};
 for(const [field,after]of Object.entries(drifts)){
  const r=mappingRun({before:baseRows,after,cg:baseCG,ax:partialAX});
  assert.equal(r.error,'native_target_changed',field);assert.equal(r.stage,'native_window_binding',field);
  assert.equal(r.bindingReason,'snapshot_structure_changed',field);assert.equal(r.snapshotCount,1);assert.equal(r.continuations,0);
 }
 const duplicate=mappingRun({before:[baseRows[0],baseRows[0]],after:baseRows,cg:baseCG,ax:partialAX});
 assert.equal(duplicate.bindingReason,'snapshot_structure_changed');assert.equal(duplicate.continuations,0);
 assert.equal(duplicate.snapshotCount,0);assert.equal(duplicate.axCount,0);
});
await test('actual Owner preserves read, Stop, deadline and first-error failures',()=>{
 for(const code of ['native_permission_required','native_read_unknown','native_read_timeout']){
  const r=mappingRun({...retitle,readFailure:code});assert.equal(r.error,code);assert.equal(r.stage,'native_read');
  assert.equal(r.osStatus,-1743);assert.equal(r.snapshotCount,1);assert.equal(r.continuations,0);assert.equal(Object.hasOwn(r,'mapping'),false);
 }
 for(const haltKind of ['stop','deadline'])for(const haltPhase of ['after_ax','after_snapshot']){
  const r=mappingRun({...retitle,haltKind,haltPhase});
  assert.equal(r.error,haltKind==='stop'?'user_cancelled':'dialog_probe_unknown');
  assert.equal(r.stage,haltKind==='stop'?'native_ax_read':'native_read_deadline');
  assert.equal(r.snapshotCount,haltPhase==='after_ax'?0:1);assert.equal(r.continuations,0);assert.equal(Object.hasOwn(r,'mapping'),false);
 }
 const r=mappingRun({...retitle,firstFailure:true,haltKind:'deadline',haltPhase:'initial',readFailure:'native_read_unknown'});
 assert.equal(r.error,'native_permission_required');assert.equal(r.osStatus,-1743);assert.equal(r.snapshotCount,0);assert.equal(r.axCount,0);
});
await test('actual Owner verify keeps five guard reasons and canonical failure facts',()=>{
 const cases=[
  ['window_missing',{before:[row(2,'B')]}],['tab_not_in_window',{before:[row(1,'A',1,{tabs:[12],active:12})]}],
  ['active_tab_mismatch',{before:[row(1,'A',1,{active:12})],requireActive:true}],
  ['cg_mapping_missing',{before:[row(1,'A')],cg:[]}],['cg_mapping_mismatch',{before:[row(1,'A')],cg:[{num:202}]}]
 ];
 for(const [reason,value]of cases){
  const r=mappingRun({mode:'verify',...value});assert.equal(r.error,'native_target_changed');assert.equal(r.stage,'native_binding');
  assert.equal(r.bindingReason,reason);assert.equal(r.continuations,0);assert.equal(r.identityCount,1);assert.equal(r.ownerSnapshotCount,1);
  if(['window_missing','tab_not_in_window','active_tab_mismatch'].includes(reason))assert.deepEqual(r.events,[]);
 }
});
await test('NAT-RETRY: pre-input bind rescans a transient window-list change; persistent change and verify stay refused',()=>{
 const ax=[{num:201,title:'A - Google Chrome'},{num:202,title:'B - Google Chrome'}];
 const moved=[row(1,'A',2),row(2,'B',1)];
 const settled=mappingRun({mode:'bind',before:baseRows,after:moved,cg:baseCG,ax,settle:true});
 assert.equal(settled.ok,true,JSON.stringify(settled));assert.equal(settled.bound,true);assert.equal(settled.pauses,1);assert.equal(settled.continuations,1);
 assert.equal(settled.ownerSnapshotCount,2);assert.equal(settled.snapshotCount,2);
 const persistent=mappingRun({mode:'bind',before:baseRows,after:moved,cg:baseCG,ax});
 assert.equal(persistent.error,'native_target_changed');assert.equal(persistent.stage,'native_window_binding');
 assert.equal(persistent.bindingReason,'snapshot_structure_changed');assert.equal(persistent.bindingRescans,2);
 assert.equal(persistent.pauses,2);assert.equal(persistent.snapshotCount,3);assert.equal(persistent.continuations,0);
 // verify itself (every post-input caller) never rescans.
 const once=mappingRun({mode:'verify',before:baseRows,after:moved,cg:baseCG,ax,settle:true});
 assert.equal(once.bindingReason,'snapshot_structure_changed');assert.equal(once.pauses,0);assert.equal(once.snapshotCount,1);
 assert.equal(Object.hasOwn(once,'bindingRescans'),false);assert.equal(once.continuations,0);
 // Any other binding refusal is final at once.
 const mismatch=mappingRun({mode:'bind',before:baseRows,cg:baseCG,ax,targetCG:202});
 assert.equal(mismatch.bindingReason,'cg_mapping_mismatch');assert.equal(mismatch.pauses,0);assert.equal(mismatch.continuations,0);
});
await test('NAT-RETRY r2: rescans share one absolute 4 s budget; a late confirmation is refused; no rescan after a native write',()=>{
 const ax=[{num:201,title:'A - Google Chrome'},{num:202,title:'B - Google Chrome'}];
 const moved=[row(1,'A',2),row(2,'B',1)];
 // A1: slow reads. The rescan gets the shared absolute deadline (4) for its snapshot and its probe; the probe stops it.
 const slow=mappingRun({mode:'bind',before:baseRows,after:moved,cg:baseCG,ax,settle:true,ownerDelay:3.9});
 assert.equal(slow.error,'dialog_probe_unknown',JSON.stringify(slow));assert.equal(slow.stage,'native_read_deadline');
 assert.deepEqual(slow.snapshotUntils,[-1,4]);assert.deepEqual(slow.probeUntils,[-1,4]);assert.equal(slow.continuations,0);
 assert.equal(slow.pauses,1);assert.ok(slow.clock>=7.8&&slow.clock<7.9,'pause clipped to the shared deadline: '+slow.clock);
 // A1: a rescan that confirms only after the deadline is not accepted.
 const late=mappingRun({mode:'bind',before:baseRows,after:moved,cg:baseCG,ax,settle:true,slowFinal:true});
 assert.equal(late.error,'native_target_changed',JSON.stringify(late));assert.equal(late.bindingReason,'snapshot_structure_changed');
 assert.equal(late.bindingDeadline,true);assert.equal(late.bindingRescans,1);assert.equal(late.bound,undefined);assert.equal(late.continuations,0);
 // A2: select_tab already sent in this session (production run + Transaction): the transient change fails as before.
 const after=mappingRun({mode:'bind',before:baseRows,after:moved,cg:baseCG,ax,settle:true,selectFirst:true});
 assert.equal(after.selectDelivery,'sent');assert.equal(after.bindingReason,'snapshot_structure_changed',JSON.stringify(after));
 assert.equal(after.pauses,0);assert.equal(after.snapshotCount,1);assert.equal(Object.hasOwn(after,'bindingRescans'),false);assert.equal(after.continuations,0);
});
await test('NAT-RETRY r3: in one call a write stops binding rescans; the next call of the same held Owner may rescan',()=>{
 const ax=[{num:201,title:'A - Google Chrome'},{num:202,title:'B - Google Chrome'}];
 const r=mappingRun({mode:'calls',before:baseRows,after:[row(1,'A',2),row(2,'B',1)],cg:baseCG,ax,settle:true});
 assert.equal(r.ok,true,JSON.stringify(r));
 for(const key of ['sameCall','sameIdAgain']){
  assert.equal(r[key].bindingReason,'snapshot_structure_changed',key);assert.equal(r[key].pauses,0,key);assert.equal(Object.hasOwn(r[key],'bindingRescans'),false,key);
 }
 assert.equal(r.nextCall.ok,true,JSON.stringify(r.nextCall));assert.equal(r.nextCall.pauses,1);
});
await test('actual Transaction final write ledger feeds the production optional projection',async()=>{
 const index=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const jsBlock=name=>{const pattern=new RegExp(`(?:async )?function ${name}\\(`,'g');const matches=[...index.matchAll(pattern)];
  assert.equal(matches.length,1,`one ${name}`);const start=matches[0].index;return index.slice(start,index.indexOf('\n}',start)+2);};
 let current;const context=vm.createContext({CALL:new AsyncLocalStorage(),redactToolResult:value=>value,
  callToolRun:async()=>{throw Object.assign(Error('Safe native receipt'),current);}});
 vm.runInContext(jsBlock('progressFor')+'\n'+jsBlock('callTool')+'\nglobalThis.invoke=callTool;',context);
 for(const [steps,expected]of [
  [[],{}],[[{stage:'activate_tab'},{kind:'read',stage:'native_binding'}],{lastWriteStage:'activate_tab',lastWriteDelivery:'sent'}],
  [[{stage:'activate_tab'},{stage:'window_bounds',fail:true}],{lastWriteStage:'window_bounds',lastWriteDelivery:'unknown'}]
 ]){
  const receipt=mappingRun({mode:'transaction',steps});
  assert.equal(receipt.stages.length,steps.filter(x=>x.kind!=='read').length);
  current=receipt;const result=await context.invoke({params:{name:'open_tab',arguments:{}}},{});
  const projected=JSON.parse(JSON.stringify(result.structuredContent.error));
  assert.deepEqual(projected,{code:'native_target_changed',stage:'native_binding',inputDelivery:receipt.inputDelivery,
   bindingReason:'cg_mapping_mismatch',...expected});
  assert.equal(JSON.stringify(projected).includes('synthetic-private-'),false);
 }
});
// Compile the actual CLI info branch and its reader/validation functions with
// inert metadata, snapshot and AX effects. The old source uses its actual
// legacy mapping adapter; it must fail this same behavior oracle, not parsing.
const infoStart = cli.indexOf('    case "info":');
const infoEnd = cli.indexOf('\n    case "eval":', infoStart);
assert.ok(infoStart >= 0 && infoEnd > infoStart, 'one CLI info branch');
const infoBody = cli.slice(infoStart + '    case "info":'.length, infoEnd);
const infoFunctions = ['func nativeInfoTarget(', 'func nativeInfoFailure(']
  .filter(name => cli.includes(name)).map(name => exactBlock(cli, name)).join('\n');
const oldCGJSON = cli.match(/^func cgWindowJSON\([^\n]+$/m)?.[0] ?? assert.fail('legacy list CG wrapper');
const cliSwift = mappingTypes + `
let input = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let fixtureBefore = rows(input["before"]), fixtureAfter = rows(input["after"] ?? input["before"])
var snapshotReads = 0, legacyReads = 0, probes: [ChromeNative.Probe] = []
func fixtureCG() -> [(num: Int, rect: CGRect, onScreen: Bool)] {
    (input["cg"] as? [[String: Any]] ?? []).map { ($0["num"] as! Int, rect($0["rect"]), $0["onScreen"] as? Bool ?? true) }
}
func fixtureAX() -> [AXElement] {
    (input["ax"] as? [[String: Any]] ?? []).map {
        AXElement(num: $0["num"] as! Int, title: $0["title"] as? String ?? "", minimized: $0["minimized"] as? Bool ?? false,
                  rect: rect($0["rect"]), document: $0["document"] as? String)
    }
}
ChromeNative.readSnapshotEffect = { pid in
    snapshotReads += 1
    if let failure = input["snapshotFailure"] as? [String: Any], snapshotReads == failure["at"] as? Int {
        throw ChromeNative.ReadFailure(code: failure["code"] as! String, osStatus: failure["osStatus"] as? Int,
            point: (failure["point"] as? String).flatMap { ChromeNative.ReadFailure.Point(rawValue: $0) },
            reason: (failure["reason"] as? String).flatMap { ChromeNative.ReadFailure.Reason(rawValue: $0) })
    }
    return snapshotReads == 1 ? fixtureBefore : fixtureAfter
}
ChromeNative.Probe.configure = { p in
    probes.append(p)
    p.cg = fixtureCG().map { [kCGWindowOwnerPID: 7, kCGWindowLayer: 0, kCGWindowNumber: $0.num,
                              kCGWindowBounds: $0.rect.dictionaryRepresentation as NSDictionary, kCGWindowIsOnscreen: $0.onScreen] }
    p.ax = fixtureAX()
    p.snapshot = { pid in
        p.snapshots += 1; p.events.append("snapshot"); p.phase = "after_snapshot"
        return try ChromeNative.readSnapshot(pid)
    }
    p.checkpoint = {
        if input["haltPhase"] as? String == p.phase {
            if input["haltKind"] as? String == "deadline" { ProcessInfo.processInfo.systemUptime = 20 }
            else { throw ChromeNative.Failure("user_cancelled", "native_ax_read") }
        }
    }
}
// The legacy adapter is extracted unchanged too; only its OS value sources
// below are fake. No Apple Event/AX/CG function from a framework is invoked.
class SBObject {
    let values: [String: Any]
    init(_ values: [String: Any]) { self.values = values }
    func value(forKey key: String) -> Any? { values[key] }
}
final class SBElementArray {
    let values: [Row]
    init(_ values: [Row]) { self.values = values }
    func value(forKey key: String) -> Any? {
        switch key {
        case "bounds": return values.map { NSValue(rect: $0.bounds) } as NSArray
        case "minimized": return values.map { $0.minimized } as NSArray
        case "index": return values.map { $0.index } as NSArray
        default: return values.map { $0.id } as NSArray
        }
    }
    func object(at index: Int) -> Any? { SBObject(["activeTab": SBObject(["title": values[index].title])]) }
}
struct FakeChrome { let processIdentifier: pid_t = 7 }
struct FakeApp { let localizedName = "Fixture App" }
let chromeProc = FakeChrome()
func windows() -> SBElementArray { legacyReads += 1; return SBElementArray(fixtureBefore) }
func ids(_ values: SBElementArray) -> [Int] { values.values.map { $0.id } }
func str(_ value: Any?) -> String { value as? String ?? "" }
func cgWindows(pid: pid_t) -> [(num: Int, rect: CGRect, onScreen: Bool)] { fixtureCG() }
func cgOnScreenOrder(pid: pid_t) -> [(num: Int, rect: CGRect)] { fixtureCG().filter { $0.onScreen }.map { ($0.num, $0.rect) } }
func axWindowTable(pid: pid_t) -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)] {
    fixtureAX().map { ($0.num, $0.title, $0.minimized, $0.rect) }
}
typealias ChromeWin = ChromeNative.ChromeWin
${exactBlock(cli, 'func cgWindowIds(')}
${exactBlock(cli, 'func matchWindows(')}
${oldCGJSON}
${infoFunctions}
func check(_ stage: String = "apple_event") {}
func frontApp() -> FakeApp? { FakeApp() }
func emit(_ value: [String: Any]) -> Never {
    var result = value
    result["_fixture"] = ["snapshotReads": snapshotReads, "legacyReads": legacyReads,
                           "axCalls": probes.reduce(0) { $0 + $1.axCalls }, "realNativeEffects": false]
    print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    exit(0)
}
if let projection = input["failureProjection"] as? String {
    let failure: Error
    switch projection {
    case "mailbox": failure = ChromeNative.Failure("native_read_timeout", "native_read")
    case "native": failure = ChromeNative.Failure("user_cancelled", "native_ax_read", osStatus: -1701)
    case "dialog": failure = ChromeNative.DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect")
    default: failure = NSError(domain: "private fixture domain", code: 99, userInfo: [NSLocalizedDescriptionKey: "private fixture message"])
    }
    emit(nativeInfoFailure(failure))
}
var target = input["metadata"] as! [String: Any]
let tid = target["tabId"] as! Int, wid = target["windowId"] as! Int
let activeTab = input["metadataActiveTab"] as? Int ?? (target["tabActive"] as? Bool == true ? tid : 11)
let activeObject: SBObject? = SBObject(["URL": input["metadataActiveURL"] ?? target["url"]!])
let b = target["bounds"] as! [String: Double]
let targetBounds = CGRect(x: b["left"]!, y: b["top"]!, width: b["width"]!, height: b["height"]!)
let t = SBObject(["loading": input["loading"] as? Bool ?? false])
${infoBody}
`;
assert.doesNotMatch(cliSwift, /import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)|@_silgen_name|CoreGraphics\.CGWindowListCopyWindowInfo|ApplicationServices\./);
const cliBinary = compile('cli-info-actual', cliSwift);
const cliRun = value => run(value, cliBinary);
const docRows = [row(1, 'Repeated', 1, { tabs: [11], active: 11, urls: { 11: 'https://fixture.invalid/a?x=1#one' } }),
  row(2, 'Repeated', 2, { tabs: [21], active: 21, urls: { 21: 'https://fixture.invalid/b?x=2#two' } })];
const docAX = [{ num: 201, title: 'Repeated - Google Chrome', document: docRows[0].urls[11] },
  { num: 202, title: 'Repeated - Google Chrome', document: docRows[1].urls[21] }];
const infoMetadata = (patch = {}) => ({ tabId: 11, windowId: 1, chromePid: 7, tabActive: true, windowIndex: 1,
  minimized: false, title: 'Repeated', url: docRows[0].urls[11], tabCount: 1,
  bounds: { left: 0, top: 0, width: 800, height: 600 }, driver: 'chromectl', sidebarFixture: 'kept', ...patch });
const infoDocument = { metadata: infoMetadata(), before: docRows, cg: baseCG, ax: docAX };
const singleInfo = { metadata: infoMetadata(), before: [docRows[0]], cg: [{ num: 201 }] };
const metadataDrifts = {
  window: { before: [{ ...docRows[0], id: 3 }] },
  tab: { before: [{ ...docRows[0], tabs: [12], active: 12, urls: { 12: docRows[0].urls[11] } }] },
  bounds: { before: [{ ...docRows[0], rect: [10, 0, 800, 600] }], cg: [{ num: 201, rect: [10, 0, 800, 600] }] },
  activeURL: { before: [{ ...docRows[0], urls: { 11: 'https://changed.invalid/' } }] },
  activeTab: { before: [{ ...docRows[0], tabs: [11, 12], active: 12, urls: { 11: docRows[0].urls[11], 12: 'https://active.invalid/' } }] },
  index: { before: [{ ...docRows[0], index: 2 }] },
  minimized: { before: [{ ...docRows[0], minimized: true }] },
  pid: { metadata: infoMetadata({ chromePid: 8 }) },
};
// Run all old/new cases before checking assertions, retaining complete output
// even when the frozen old source fails at the first required behavior.
const infoObserved = {
  document: cliRun(infoDocument),
  drifts: Object.fromEntries(Object.entries(metadataDrifts).map(([name, patch]) => [name, cliRun({ ...singleInfo, ...patch })])),
};
await test('actual CLI info uses the shared fresh document mapping and rejects metadata A/B mixing', () => {
  assert.equal(infoObserved.document.ok, true, JSON.stringify(infoObserved.document));
  assert.equal(infoObserved.document.cgWindow, 201, 'info must use the same document-qualified pair as native verification');
  assert.equal(infoObserved.document._fixture.legacyReads, 0, 'info never falls back to the legacy list mapper');
  for (const [name, result] of Object.entries(infoObserved.drifts)) {
    assert.equal(result.ok, false, `${name}: mixed metadata must not escape: ${JSON.stringify(result)}`);
    assert.equal(result.error, 'native_target_changed', name);
    assert.equal(result.stage, 'native_window_binding', name);
    assert.equal(Object.hasOwn(result, 'cgWindow'), false, name);
  }
});
await test('actual CLI and native mapping agree and info preserves inactive-tab metadata', () => {
  const nativeResult = mappingRun({ before: docRows, cg: baseCG, ax: docAX });
  assert.equal(nativeResult.mapping['1'], infoObserved.document.cgWindow);
  assert.equal(infoObserved.document._fixture.snapshotReads, 2);
  const inactiveURL = 'https://inactive.invalid/query?q=3#fragment';
  const target = { ...docRows[0], tabs: [11, 12], urls: { ...docRows[0].urls, 12: inactiveURL } };
  const metadata = infoMetadata({ tabId: 12, tabActive: false, tabCount: 2, url: inactiveURL, title: 'Inactive title' });
  const result = cliRun({ ...singleInfo, before: [target], metadata, metadataActiveTab: 11,
    metadataActiveURL: docRows[0].urls[11], loading: true });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.cgWindow, 201);
  assert.equal(result.title, 'Inactive title'); assert.equal(result.url, inactiveURL); assert.equal(result.tabActive, false);
  assert.equal(result.loading, true); assert.equal(result.frontmost, 'Fixture App'); assert.equal(result.sidebarFixture, 'kept');
  assert.equal(result._fixture.snapshotReads, 1); assert.equal(result._fixture.axCalls, 0);
});
await test('actual CLI shared reader preserves typed initial/post-AX failures and Stop/deadline', () => {
  for (const [code, osStatus] of [['native_permission_required', -1743], ['native_read_timeout', null], ['chrome_error', -1701]]) {
    for (const at of [1, 2]) {
      const result = cliRun({ ...infoDocument, snapshotFailure: { at, code, osStatus } });
      assert.equal(result.ok, false); assert.equal(result.error, code); assert.equal(result.stage, 'native_read');
      if (osStatus == null) assert.equal(Object.hasOwn(result, 'osStatus'), false);
      else assert.equal(result.osStatus, osStatus);
      assert.equal(result._fixture.snapshotReads, at); assert.equal(result._fixture.legacyReads, 0);
      assert.equal(Object.hasOwn(result, 'cgWindow'), false);
    }
  }
  const changed = cliRun({ ...infoDocument, after: [{ ...docRows[0], index: 3 }, docRows[1]] });
  assert.equal(changed.error, 'native_target_changed'); assert.equal(changed.stage, 'native_window_binding');
  assert.equal(changed.bindingReason, 'snapshot_structure_changed');
  for (const haltKind of ['stop', 'deadline']) for (const haltPhase of ['after_ax', 'after_snapshot']) {
    const result = cliRun({ ...infoDocument, haltKind, haltPhase });
    assert.equal(result.error, haltKind === 'stop' ? 'user_cancelled' : 'dialog_probe_unknown');
    assert.equal(result.stage, haltKind === 'stop' ? 'native_ax_read' : 'native_read_deadline');
    assert.equal(Object.hasOwn(result, 'cgWindow'), false); assert.equal(result._fixture.legacyReads, 0);
  }
});
await test('actual CLI nativeInfoFailure preserves typed read facts at initial and post-AX snapshot failure', () => {
  for (const [code, point, reason] of [
    ['native_read_timeout', 'windows', 'before_deadline'],
    ['native_read_unknown', 'bounds', 'nil_or_type'],
    ['native_read_unknown', 'tab_urls', 'after_deadline'],
    ['native_read_unknown', 'window_ids_shape', 'shape'],
    ['native_read_unknown', 'tab_url_ids_shape', 'shape'],
    ['native_read_unknown', 'row_shape', 'shape'],
    ['native_read_unknown', 'runner', 'runner_other'],
  ]) for (const at of [1, 2]) {
    const result = cliRun({ ...infoDocument, snapshotFailure: { at, code, point, reason,
      osStatus: -1701, privateFixtureValue: 'must not be projected' } });
    assert.deepEqual(result, { ok: false, error: code, stage: 'native_read', osStatus: -1701,
      nativeReadPoint: point, nativeReadReason: reason,
      _fixture: { snapshotReads: at, legacyReads: 0, axCalls: at - 1, realNativeEffects: false } });
  }
});
await test('actual CLI nativeInfoFailure preserves absent facts, non-read failures and generic fallback without added data', () => {
  for (const fields of [
    {}, { point: 'bounds' }, { reason: 'nil_or_type' },
    { point: 'private fixture value', reason: 'nil_or_type' },
    { code: 'native_permission_required', osStatus: -1743, point: 'bounds', reason: 'nil_or_type' },
  ]) {
    const failure = { at: 1, code: 'native_read_unknown', ...fields };
    const result = cliRun({ ...infoDocument, snapshotFailure: failure });
    assert.deepEqual(result, { ok: false, error: failure.code, stage: 'native_read',
      ...(failure.osStatus == null ? {} : { osStatus: failure.osStatus }),
      _fixture: { snapshotReads: 1, legacyReads: 0, axCalls: 0, realNativeEffects: false } });
  }
  for (const [failureProjection, expected] of [
    ['generic', { ok: false, error: 'native_read_unknown', stage: 'native_read' }],
    ['mailbox', { ok: false, error: 'native_read_timeout', stage: 'native_read' }],
    ['native', { ok: false, error: 'user_cancelled', stage: 'native_ax_read', osStatus: -1701 }],
    ['dialog', { ok: false, error: 'dialog_probe_unknown', stage: 'dialog_inspect', inputDelivery: 'not_sent',
      message: '无法完整确认指定原生对话框；请检查当前状态，不要重复发送。' }],
  ]) {
    assert.deepEqual(cliRun({ failureProjection }), { ...expected,
      _fixture: { snapshotReads: 0, legacyReads: 0, axCalls: 0, realNativeEffects: false } });
  }
});
// Only fake ScriptingBridge values and a deterministic clock enter these
// extracted readSnapshot/Owner.snapshot functions. The optional frozen source
// supplies an independent before-change effect trace for a repair receipt.
const readPoints = ['windows', 'window_ids', 'window', 'bounds', 'minimized', 'index', 'tabs',
  'tab_ids', 'tab_urls', 'tab_url_ids', 'active_tab', 'active_tab_id', 'title'];
const readFailureType = source => source.includes('enum Point: String, Sendable')
  ? exactBlock(source, 'struct ReadFailure:')
  : source.match(/^    struct ReadFailure:[^\n]+$/m)?.[0] ?? assert.fail('frozen ReadFailure');
function readProgram(source = native) {
  return `import Foundation
struct CGRect: Sendable {
    let minX: Double, minY: Double, width: Double, height: Double
    init(x: Double, y: Double, width: Double, height: Double) { minX = x; minY = y; self.width = width; self.height = height }
}
final class NSValue {
    let rectValue: CGRect
    init(rect: CGRect) { rectValue = rect }
}
let input = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
var events: [String] = [], clockReads = 0, tabIDReads = 0, ownerPumps = 0
final class ProcessInfo {
    static let processInfo = ProcessInfo()
    var systemUptime: Double {
        events.append("clock"); clockReads += 1
        if let values = input["clockValues"] as? [Double], !values.isEmpty { return values[min(clockReads - 1, values.count - 1)] }
        return clockReads >= (input["expireClock"] as? Int ?? Int.max) ? (input["expireValue"] as? Double ?? 4) : 0
    }
}
final class ReadErrors { var status: Int? }
var currentErrors: ReadErrors?
func getter(_ point: String, _ value: Any?) -> Any? {
    events.append("get:" + point)
    if input["at"] as? String == point {
        if let status = input["osStatus"] as? Int { currentErrors?.status = status }
        if input["fault"] as? String == "nil" { return nil }
        if input["fault"] as? String == "type" { return NSNull() }
    }
    return value
}
class SBObject {
    let kind: String
    init(_ kind: String) { self.kind = kind }
    func value(forKey key: String) -> Any? {
        if kind == "window" {
            switch key {
            case "bounds": return getter("bounds", NSValue(rect: CGRect(x: 0, y: 0, width: input["shape"] as? String == "bounds" ? 0 : 800, height: 600)))
            case "minimized": return getter("minimized", false)
            case "index": return getter("index", input["shape"] as? String == "index" ? 0 : 1)
            case "tabs": return getter("tabs", SBElementArray("tabs"))
            default: return getter("active_tab", SBObject("active"))
            }
        }
        if key == "id" { return getter("active_tab_id", input["shape"] as? String == "active" ? 99 : 11) }
        return getter("title", "private fixture title")
    }
}
final class SBElementArray: SBObject {
    override func value(forKey key: String) -> Any? {
        if kind == "windows" { return getter("window_ids", input["shape"] as? String == "window_ids" ? [1, 1] : [1]) }
        if key == "URL" { return getter("tab_urls", input["shape"] as? String == "url_count" ? [] as [String] : ["https://fixture.invalid/private"]) }
        tabIDReads += 1
        return getter(tabIDReads == 1 ? "tab_ids" : "tab_url_ids", input["shape"] as? String == "tab_url_ids" && tabIDReads == 2 ? [12] : [11])
    }
    func object(withID id: String) -> Any? { getter("window", SBObject("window")) }
}
final class SBApplication {
    var delegate: ReadErrors? { didSet { currentErrors = delegate } }
    var timeout = 0
    init?(processIdentifier: pid_t) { if input["appMissing"] as? Bool == true { return nil } }
    func value(forKey key: String) -> Any? { getter("windows", SBElementArray("windows")) }
}
enum ChromeNative {
    ${exactBlock(native, 'struct Failure:')}
    ${exactBlock(native, 'struct WindowRow:')}
    ${readFailureType(source)}
    ${exactBlock(source, 'static func num(')}
    ${exactBlock(source, 'static func readSnapshot(')}
    final class ReadRunner {
        static var outcome: Result<[WindowRow], ReadFailure>?
        var takes = 0
        func start(_ pid: pid_t) throws -> UInt64 { events.append("owner:start"); return 1 }
        func take(_ ticket: UInt64) -> Result<[WindowRow], ReadFailure>? {
            events.append("owner:take"); takes += 1
            precondition(takes <= 16, "fixture mailbox failed to terminate")
            if let ready = input["readyTake"] as? Int, takes >= ready { return .success([]) }
            return Self.outcome
        }
        func abandon(_ ticket: UInt64) { events.append("owner:abandon") }
    }
    final class Owner {
        var stopped = false, dry = false, dryConfig: [String: Any] = [:], dryRows: [WindowRow] = []
        var readRunner: ReadRunner?
        var stageCheck: (String) throws -> Void = { stage in
            events.append("owner:alive")
            if input["stopAfterPump"] as? Bool == true && ownerPumps > 0 { throw Failure("user_cancelled", stage) }
        }
        func pump() throws { events.append("owner:pump"); ownerPumps += 1 }
        ${exactBlock(source, 'func requireAlive(')}
        ${exactBlock(source, 'func snapshot(_ pid:')}
    }
}
var result: [String: Any] = [:]
do {
    if input["mode"] as? String == "mailbox" {
        let rows = try ChromeNative.Owner().snapshot(7${source.includes('func snapshot(_ pid: pid_t, until:') ? ', until: input["until"] as? Double' : ''})
        result = ["ok": true, "rows": rows.count]
    } else if input["mode"] as? String == "projection" {
        let ${source.includes('enum Point: String, Sendable') ? 'failure' : '_'} = ChromeNative.ReadFailure(code: input["code"] as! String, osStatus: nil${source.includes('enum Point: String, Sendable') ? ', point: input["omitPoint"] as? Bool == true ? nil : .bounds, reason: input["omitReason"] as? Bool == true ? nil : .nil_or_type' : ''})
        result = ${source.includes('enum Point: String, Sendable') ? 'failure.details' : '[:]'}
    } else {
        do {
            let rows = try ChromeNative.readSnapshot(input["pid"] as? Int32 ?? 7)
            result = ["ok": true, "rows": rows.count]
        } catch let failure as ChromeNative.ReadFailure {
            if input["mode"] as? String == "owner" {
                ChromeNative.ReadRunner.outcome = .failure(failure)
                _ = try ChromeNative.Owner().snapshot(7)
            }
            result = ["ok": false, "error": failure.code]
            if let status = failure.osStatus { result["osStatus"] = status }
            result.merge(${source.includes('enum Point: String, Sendable') ? 'failure.details' : '[:]'} ) { first, _ in first }
        }
    }
} catch let failure as ChromeNative.Failure { result = failure.json }
catch { result = ["unexpected": String(describing: error)] }
result["events"] = events; result["clockReads"] = clockReads
print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
`;
}
const readSwift = readProgram();
assert.doesNotMatch(readSwift, /import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)|@_silgen_name|Foundation\.ProcessInfo/);
const readBinary = compile('snapshot-read-actual', readSwift);
const baselineSource = process.env.MYCHROME_READ_BASELINE_SOURCE && fs.readFileSync(process.env.MYCHROME_READ_BASELINE_SOURCE, 'utf8');
const baselineReadBinary = baselineSource && compile('snapshot-read-frozen-before', readProgram(baselineSource));
let baselineComparisons = 0, admittedBudgetComparisons = 0;
function withoutReadFacts(value) {
  const { nativeReadPoint, nativeReadReason, ...rest } = value; return rest;
}
function readRun(input, admittedBudget = false) {
  const result = run(input, readBinary);
  if (baselineReadBinary && input.mode !== 'projection') {
    const before = run(input, baselineReadBinary);
    if (admittedBudget) {
      if (input.mode === 'mailbox') {
        assert.deepEqual(before, { ok: false, error: 'native_read_timeout', stage: 'native_read', clockReads: 2,
          events: [...result.events.slice(0, 6), 'owner:abandon'] });
      } else {
        assert.equal(before.error, 'native_read_unknown'); assert.equal(before.nativeReadPoint, 'title');
        assert.equal(before.nativeReadReason, 'after_deadline'); assert.deepEqual(before.events, result.events);
        assert.equal(before.clockReads, result.clockReads);
      }
      admittedBudgetComparisons++;
    } else {
      assert.deepEqual(withoutReadFacts(result), withoutReadFacts(before), `frozen before/after effects: ${JSON.stringify(input)}`);
      if (baselineSource.includes('enum Point: String, Sendable')) {
        assert.equal(result.nativeReadPoint, before.nativeReadPoint); assert.equal(result.nativeReadReason, before.nativeReadReason);
      }
      baselineComparisons++;
    }
  }
  assert.equal(Object.hasOwn(result, 'unexpected'), false, JSON.stringify(result));
  return result;
}
const healthyReadEvents = ['clock', ...readPoints.flatMap(point => ['clock', `get:${point}`, 'clock'])];
function expectReadFailure(result, code, point, reason, expectedEvents) {
  assert.equal(result.error, code); assert.equal(result.nativeReadPoint, point); assert.equal(result.nativeReadReason, reason);
  assert.deepEqual(result.events, expectedEvents); assert.equal(result.clockReads, expectedEvents.filter(e => e === 'clock').length);
  assert.equal(JSON.stringify(withoutReadFacts(result)).includes('private'), false);
}
await test('actual readSnapshot admits a complete 2.2s snapshot but refuses exact/over 3s at unchanged checks', () => {
  const clockValues = Array.from({ length: 27 }, (_, i) => i === 26 ? 2.2 : i * 1.9 / 25);
  const complete = readRun({ clockValues }, true);
  assert.equal(complete.ok, true); assert.equal(complete.rows, 1); assert.deepEqual(complete.events, healthyReadEvents);
  assert.equal(complete.clockReads, 27); assert.equal(Object.hasOwn(complete, 'nativeReadPoint'), false);
  for (const expireValue of [3, 3.01]) {
    expectReadFailure(readRun({ expireClock: 26, expireValue }), 'native_read_timeout', 'title', 'before_deadline', healthyReadEvents.slice(0, 38));
    expectReadFailure(readRun({ expireClock: 27, expireValue }), 'native_read_unknown', 'title', 'after_deadline', healthyReadEvents);
  }
});
await test('actual Owner mailbox admits a 3.4s result, refuses at 3.5s, and pumps Stop before abandonment', () => {
  const prefix = ['owner:alive', 'owner:start', 'clock', 'owner:alive', 'owner:take', 'clock'];
  const ready = readRun({ mode: 'mailbox', clockValues: [0, 3.4], readyTake: 2 }, true);
  assert.equal(ready.ok, true); assert.equal(ready.rows, 0); assert.equal(ready.clockReads, 2);
  assert.deepEqual(ready.events, [...prefix, 'owner:pump', 'owner:alive', 'owner:take', 'owner:alive']);
  const missing = readRun({ mode: 'mailbox', clockValues: [0, 3.5] });
  assert.equal(missing.error, 'native_read_timeout'); assert.equal(missing.stage, 'native_read');
  assert.equal(Object.hasOwn(missing, 'nativeReadPoint'), false); assert.equal(Object.hasOwn(missing, 'nativeReadReason'), false);
  assert.deepEqual(missing.events, [...prefix, 'owner:abandon']);
  const stopped = readRun({ mode: 'mailbox', clockValues: [0, 3.4], readyTake: 2, stopAfterPump: true }, true);
  assert.equal(stopped.error, 'user_cancelled'); assert.equal(stopped.stage, 'native_read');
  assert.deepEqual(stopped.events, [...prefix, 'owner:pump', 'owner:alive', 'owner:abandon']);
  assert.match(exactBlock(native, 'static func readSnapshot('), /app\.timeout = 12/);
  assert.match(exactBlock(native, 'final class Probe {'), /budget: Double = 4/);
  assert.match(exactBlock(native, 'func probe()'), /Probe\(budget: 4,/);
  // NAT-RETRY r3 (real deadline behaviour, production Owner.snapshot): a rescan's shared deadline ends the same
  // mailbox wait that the 3.5 s budget would still admit.
  const admitted = run({ mode: 'mailbox', clockValues: [0, 2], readyTake: 2 }, readBinary);
  assert.equal(admitted.ok, true); assert.equal(admitted.clockReads, 2);
  const limited = run({ mode: 'mailbox', clockValues: [0, 2], readyTake: 2, until: 2 }, readBinary);
  assert.equal(limited.error, 'native_read_timeout'); assert.equal(limited.stage, 'native_read'); assert.equal(limited.clockReads, 2);
  assert.deepEqual(limited.events, [...prefix, 'owner:abandon']);
  assert.match(exactBlock(native, 'func createTab('), /systemUptime \+ 3/);
  assert.match(exactBlock(native, 'func createWindow('), /systemUptime \+ 6/);
});
await test('actual readSnapshot labels every getter without adding or reordering reads/clocks', () => {
  const success = readRun({}); assert.equal(success.ok, true); assert.equal(success.rows, 1); assert.deepEqual(success.events, healthyReadEvents);
  for (const [i, point] of readPoints.entries()) {
    const prefix = healthyReadEvents.slice(0, 1 + i * 3);
    expectReadFailure(readRun({ at: point, fault: 'nil' }), 'native_read_unknown', point, 'nil_or_type', [...prefix, 'clock', `get:${point}`]);
    if (!['index', 'active_tab_id'].includes(point)) {
      expectReadFailure(readRun({ at: point, fault: 'type' }), 'native_read_unknown', point, 'nil_or_type', [...prefix, 'clock', `get:${point}`]);
    }
    expectReadFailure(readRun({ expireClock: 2 + i * 2 }), 'native_read_timeout', point, 'before_deadline', [...prefix, 'clock']);
    expectReadFailure(readRun({ expireClock: 3 + i * 2 }), 'native_read_unknown', point, 'after_deadline', [...prefix, 'clock', `get:${point}`, 'clock']);
    // Nil and Apple Event errors must short-circuit a simultaneously expired post-read clock.
    expectReadFailure(readRun({ at: point, fault: 'nil', expireClock: 3 + i * 2 }), 'native_read_unknown', point, 'nil_or_type', [...prefix, 'clock', `get:${point}`]);
    for (const osStatus of [-1743, -1701]) {
      const r = readRun({ at: point, fault: 'nil', osStatus, expireClock: 3 + i * 2 });
      assert.equal(r.error, osStatus === -1743 ? 'native_permission_required' : 'chrome_error'); assert.equal(r.osStatus, osStatus);
      assert.equal(Object.hasOwn(r, 'nativeReadPoint'), false); assert.equal(Object.hasOwn(r, 'nativeReadReason'), false);
      assert.deepEqual(r.events, [...prefix, 'clock', `get:${point}`]);
    }
  }
});
await test('actual readSnapshot shape failures and first-error precedence remain bounded and value-free', () => {
  for (const [shape, point, count] of [['window_ids', 'window_ids_shape', 2], ['url_count', 'tab_url_ids_shape', 10],
    ['tab_url_ids', 'tab_url_ids_shape', 10], ['active', 'row_shape', 13], ['bounds', 'row_shape', 13], ['index', 'row_shape', 13]]) {
    expectReadFailure(readRun({ shape }), 'native_read_unknown', point, 'shape', healthyReadEvents.slice(0, 1 + count * 3));
  }
  expectReadFailure(readRun({ at: 'bounds', fault: 'nil', shape: 'active' }), 'native_read_unknown', 'bounds', 'nil_or_type', healthyReadEvents.slice(0, 12));
  for (const input of [{ pid: 0 }, { appMissing: true }]) {
    const r = readRun(input); assert.equal(r.error, 'chrome_not_running'); assert.deepEqual(r.events, ['clock']); assert.equal(Object.hasOwn(r, 'nativeReadPoint'), false);
  }
  for (const code of ['native_permission_required', 'chrome_error', 'chrome_not_running', 'native_reader_busy']) {
    const r = readRun({ mode: 'projection', code }); assert.deepEqual(r, { events: [], clockReads: 0 });
  }
  for (const missing of ['omitPoint', 'omitReason']) {
    assert.deepEqual(readRun({ mode: 'projection', code: 'native_read_unknown', [missing]: true }), { events: [], clockReads: 0 });
  }
});
await test('actual Owner.snapshot transfers the first typed read facts while mailbox timeout stays unlabelled', () => {
  for (const fault of [{ at: 'bounds', fault: 'nil' }, { expireClock: 2 }]) {
    const r = readRun({ ...fault, mode: 'owner' }); assert.equal(r.stage, 'native_read');
    assert.equal(r.nativeReadPoint, fault.at || 'windows'); assert.equal(r.nativeReadReason, fault.at ? 'nil_or_type' : 'before_deadline');
    assert.deepEqual(r.events.slice(-5), ['owner:alive', 'owner:start', 'clock', 'owner:alive', 'owner:take']);
    assert.equal(r.events.includes('owner:abandon'), false); assert.equal(r.events.includes('owner:pump'), false);
  }
  const permission = readRun({ mode: 'owner', at: 'bounds', osStatus: -1743 });
  assert.equal(permission.error, 'native_permission_required'); assert.equal(permission.osStatus, -1743); assert.equal(Object.hasOwn(permission, 'nativeReadPoint'), false);
  const timeout = readRun({ mode: 'mailbox', expireClock: 2 });
  assert.equal(timeout.error, 'native_read_timeout'); assert.equal(timeout.stage, 'native_read'); assert.equal(Object.hasOwn(timeout, 'nativeReadPoint'), false);
  assert.deepEqual(timeout.events, ['owner:alive', 'owner:start', 'clock', 'owner:alive', 'owner:take', 'clock', 'owner:abandon']);
});
await test('a valid omitted typed-transfer mutant fails the same Owner read-fact oracle', () => {
  const original = 'details: error.details'; assert.equal(readSwift.split(original).length, 2);
  const mutant = compile('snapshot-no-typed-facts', readSwift.replace(original, 'details: [:]'));
  const input = { mode: 'owner', at: 'bounds', fault: 'nil' }, actual = readRun(input), lost = run(input, mutant);
  assert.deepEqual(withoutReadFacts(lost), withoutReadFacts(actual), 'mutant changes only evidence');
  assert.throws(() => assert.equal(lost.nativeReadPoint, 'bounds'), assert.AssertionError);
  assert.equal(Object.hasOwn(lost, 'nativeReadReason'), false);
});
const runnerSwift = `import Foundation
enum ChromeNative {
    ${exactBlock(native, 'struct Failure:')}
    ${exactBlock(native, 'struct WindowRow:')}
    ${exactBlock(native, 'struct ReadFailure:')}
    static func readSnapshot(_ pid: pid_t) throws -> [WindowRow] {
        if pid == 7 { throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: .bounds, reason: .nil_or_type) }
        throw NSError(domain: "private fixture error", code: 99)
    }
    ${exactBlock(native, 'final class ReadRunner {')}
}
let reader = ChromeNative.ReadRunner(), ticket = try reader.start(Int32(CommandLine.arguments[1])!)
let limit = Date().addingTimeInterval(2)
var response: Result<[ChromeNative.WindowRow], ChromeNative.ReadFailure>?
while response == nil && Date() < limit { response = reader.take(ticket); if response == nil { Thread.sleep(forTimeInterval: 0.001) } }
reader.stop()
guard case .failure(let failure)? = response else { fatalError("read runner did not return the fixture failure") }
var result: [String: Any] = ["error": failure.code]
result.merge(failure.details) { first, _ in first }
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`;
assert.doesNotMatch(runnerSwift, /import (?:AppKit|ApplicationServices|ScriptingBridge|Carbon)|@_silgen_name/);
const runnerBinary = compile('read-runner-actual', runnerSwift);
await test('actual ReadRunner preserves typed first facts and classifies only its unknown catch', () => {
  const typed = JSON.parse(invoke(runnerBinary, ['7'], 'runner-typed'));
  assert.deepEqual(typed, { error: 'native_read_unknown', nativeReadPoint: 'bounds', nativeReadReason: 'nil_or_type' });
  const other = JSON.parse(invoke(runnerBinary, ['8'], 'runner-other'));
  assert.deepEqual(other, { error: 'native_read_unknown', nativeReadPoint: 'runner', nativeReadReason: 'runner_other' });
});
console.log(`${baselineComparisons} frozen before/after read-effect comparisons.`);
console.log(`${admittedBudgetComparisons} bounded admission comparisons against prior deadlines.`);
console.log(`${passed} extracted native groups; isolated compiler fixtures only. Artifacts: ${temp}`);
