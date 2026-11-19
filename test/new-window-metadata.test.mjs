/* Exact production provenance selectors and AE object-receipt parser; no events sent. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
const swift=fs.readFileSync(new URL('../src/native-chrome.swift',import.meta.url),'utf8');
function block(prefix, indent=8, source=swift) {
  const a=source.indexOf(prefix); assert.ok(a>=0,prefix);
  const end=source.indexOf('\n'+' '.repeat(indent)+'}',a); assert.ok(end>a,prefix);
  return source.slice(a,end+indent+2).replace(/^static /,'');
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mychrome-create-provenance-'));
const cache=path.join(tmp,'module-cache'),binaries=new Set();
let invocation=0;
console.log(`Preserved provenance capsule artifacts: ${tmp}`);
const marker='about:blank#mychrome-native-fixture';
function execute(file,args) {
  assert.ok((file==='/usr/bin/swiftc'&&args.length===5&&path.dirname(args[0])===tmp&&args[1]==='-module-cache-path'&&args[2]===cache&&args[3]==='-o'&&binaries.has(args[4]))||
    (binaries.has(file)&&args.length===1),'Only own inert compiler/binary invocations');
  const stem=path.join(tmp,String(++invocation).padStart(3,'0'));
  const stdout=stem+'.stdout.log',stderr=stem+'.stderr.log';
  const out=fs.openSync(stdout,'wx'),err=fs.openSync(stderr,'wx');
  let result;
  try { result=spawnSync(file,args,{cwd:tmp,stdio:['ignore',out,err]}); }
  finally { fs.closeSync(out);fs.closeSync(err); }
  fs.writeFileSync(stem+'.json',JSON.stringify({argv:[file,...args],exitCode:result.status,signal:result.signal,error:result.error?.message??null,stdout,stderr},null,2)+'\n',{flag:'wx'});
  assert.ok(!result.error&&!result.signal&&result.status===0,`Fixture compilation/execution failed; artifacts: ${stem}\n${fs.readFileSync(stdout,'utf8')}\n${fs.readFileSync(stderr,'utf8')}`);
  return fs.readFileSync(stdout,'utf8');
}
function compile(name, program) {
  const file=path.join(tmp,name+'.swift'),binary=path.join(tmp,name);
  fs.writeFileSync(file,program,{flag:'wx'});binaries.add(binary);
  execute('/usr/bin/swiftc',[file,'-module-cache-path',cache,'-o',binary]);
  return binary;
}
const invoke=(binary,fixture)=>JSON.parse(execute(binary,[JSON.stringify(fixture)]));
const markerHelper=block('static func newWindowMarker(');
const selectorProgram=`import Foundation
import Carbon
${block('struct Failure: Error {',4)}
${block('struct WindowRow: Sendable {',4)}
func code(_ text: String) -> FourCharCode { text.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) } }
${markerHelper}
${['createdWindow','createdTab','createdWindowReceipt'].map(name=>block('static func '+name+'(')).join('\n')}
let fixture = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
let marker = fixture["marker"] as? String ?? "${marker}"
func row(_ data: [String: Any]) -> WindowRow {
 let tabs = data["tabs"] as? [Int] ?? [9]
 var urls: [Int:String] = [:]
 for (id,url) in data["urls"] as? [String:String] ?? [:] { urls[Int(id)!] = url }
 return WindowRow(id: data["id"] as? Int ?? 2,tabs:tabs,activeTab:data["active"] as? Int ?? tabs[0],index:1,bounds:.zero,minimized:false,title:"fixture",tabURLs:urls)
}
var result: [String:Any]
do {
 if fixture["mode"] as? String == "marker" {
  let nonce=UUID(uuidString:fixture["nonce"] as! String)!
  result=["profile":newWindowMarker(profileCLI:true,nonce:nonce),"plain":newWindowMarker(profileCLI:false,nonce:nonce)]
 } else if fixture["mode"] as? String == "receipt" {
  let reply=NSAppleEventDescriptor(eventClass:code("aevt"),eventID:code("ansr"),targetDescriptor:nil,returnID:1,transactionID:0)
  if fixture["missing"] as? Bool != true {
   if fixture["malformed"] as? Bool == true { reply.setParam(NSAppleEventDescriptor(string:"not an object"),forKeyword:code("----")) }
   else {
    var parent=AEDesc(descriptorType:typeNull,dataHandle:nil),key=AEDesc(),out=AEDesc()
    let value=NSAppleEventDescriptor(string:fixture["id"] as? String ?? "9")
    AEDuplicateDesc(value.aeDesc!,&key)
    let status=CreateObjSpecifier(code(fixture["want"] as? String ?? "cwin"),&parent,code(fixture["form"] as? String ?? "ID  "),&key,false,&out)
    AEDisposeDesc(&key)
    guard status == noErr else { fatalError("fixture object construction failed") }
    reply.setParam(NSAppleEventDescriptor(aeDescNoCopy:&out),forKeyword:code("----"))
   }
  }
  result=["ok":true,"id":try createdWindowReceipt(reply)]
 } else if fixture["mode"] as? String == "tab" {
  result=["ok":true,"id":try createdTab(row(fixture["row"] as? [String:Any] ?? [:]),previous:Set([5]),marker:marker) ?? NSNull()]
 } else {
  let rows=(fixture["rows"] as? [[String:Any]] ?? []).map(row)
  let receipt=fixture["receipt"] as? Int
  result=["ok":true,"id":try createdWindow(rows,previous:Set([1]),marker:fixture["byReceipt"] as? Bool == true ? nil:marker,receiptID:receipt)?.id ?? NSNull()]
 }
} catch let error as Failure { result=error.json }
print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`;
const binary=compile('provenance',selectorProgram);
const run=fixture=>invoke(binary,fixture);
const owned=(id=2,tab=9)=>({id,tabs:[tab],urls:{[tab]:marker}});
test('one unrelated window first is not claimed; later exact marker is uniquely owned',()=>{
 const unrelated={id:3,tabs:[10],urls:{10:'https://unrelated.invalid/'}};
 assert.equal(run({rows:[unrelated]}).id,null);
 assert.equal(run({rows:[unrelated,owned()]}).id,2);
});
test('wrong and duplicate marker windows never authorize bounds or URL writes',()=>{
 assert.equal(run({rows:[{...owned(),urls:{9:marker+'-wrong'}}]}).id,null);
 assert.equal(run({rows:[owned(),owned(3,10)]}).error,'new_window_unconfirmed');
});
test('a stale existing marker window cannot be mistaken for a creation',()=>{
 assert.equal(run({rows:[owned(1)]}).id,null);
});
test('only the explicitly receipted window matches even with an unrelated new window',()=>{
 assert.equal(run({byReceipt:true,receipt:2,rows:[owned(3)]}).id,null);
 assert.equal(run({byReceipt:true,receipt:2,rows:[owned(3),owned(2)]}).id,2);
 for(const receipt of [undefined,-1,1]) assert.equal(run({byReceipt:true,receipt,rows:[owned()]}).error,'new_window_unconfirmed');
});
test('unrelated, wrong and duplicate marker tabs never become created target',()=>{
 assert.equal(run({mode:'tab',row:{tabs:[5,9],urls:{9:'https://unrelated.invalid/'}}}).id,null);
 assert.equal(run({mode:'tab',row:{tabs:[5,9],urls:{9:marker+'wrong'}}}).id,null);
 assert.equal(run({mode:'tab',row:{tabs:[5,9,10],urls:{9:marker,10:marker}}}).error,'new_tab_unconfirmed');
 assert.equal(run({mode:'tab',row:{tabs:[5,9,10],urls:{9:'about:blank',10:marker}}}).id,10);
});
test('explicit typed created-window receipt parses a positive ID',()=>{
 assert.equal(run({mode:'receipt',id:'2147483648'}).id,2147483648);
});
for(const fixture of [{missing:true},{malformed:true},{want:'CrTb'},{form:'indx'},{id:'?'},{id:'0'},{id:'-1'}]) test(`untrusted creation receipt ${JSON.stringify(fixture)} refuses`,()=>{
 assert.equal(run({mode:'receipt',...fixture}).error,'new_window_unconfirmed');
});

const nonce='01234567-89AB-4CDE-8F01-23456789ABCD';
const otherNonce='FEDCBA98-7654-4321-8ABC-DEF012345678';
const profileMarker='data:text/plain,mychrome-native-'+nonce;
const plainMarker='about:blank#mychrome-native-'+nonce;
test('the actual typed generator emits only independently expected inert profile and original plain markers',()=>{
 assert.deepEqual(run({mode:'marker',nonce}),{profile:profileMarker,plain:plainMarker});
 assert.deepEqual(run({mode:'marker',nonce:otherNonce}),{
  profile:'data:text/plain,mychrome-native-'+otherNonce,plain:'about:blank#mychrome-native-'+otherNonce});
 assert.notEqual(run({mode:'marker',nonce}).profile,run({mode:'marker',nonce:otherNonce}).profile);
 assert.match(profileMarker,/^[\x20-\x7e]+$/);
});

const profileOwned=(id=2,tab=9,url=profileMarker)=>({id,tabs:[tab],active:tab,urls:{[tab]:url}});
test('actual profile selector requires a unique new ID and exact active full URL across the negative matrix',()=>{
 const selected=run({mode:'marker',nonce}).profile;
 assert.equal(run({marker:selected,rows:[profileOwned()]}).id,2);
 const unrelated=profileOwned(3,10,'https://unrelated.invalid/');
 assert.equal(run({marker:selected,rows:[unrelated,profileOwned()]}).id,2);
 const missing={...profileOwned(),urls:{}};
 const inactive={id:2,tabs:[9,10],active:10,urls:{9:profileMarker,10:'about:blank'}};
 for(const row of [
  profileOwned(1),missing,inactive,unrelated,
  ...['data:text/plain,mychrome-native-'+otherNonce,profileMarker+'-suffix',profileMarker+'#fragment',
   profileMarker+'?query',plainMarker,'data:text/plain,mychrome-native-'].map(url=>profileOwned(2,9,url))
 ]) assert.equal(run({marker:selected,rows:[row]}).id,null,JSON.stringify(row));
 assert.equal(run({marker:selected,rows:[profileOwned(),profileOwned(3,10)]}).error,'new_window_unconfirmed');
});

function changedOnce(source, before, after) {
 assert.equal(source.split(before).length,2,before);
 return source.replace(before,after);
}
test('restoring the old profile prefix compiles but fails the independent marker assertion',()=>{
 const old=changedOnce(selectorProgram,'profileCLI ? "data:text/plain,mychrome-native-"','profileCLI ? "about:blank#mychrome-native-"');
 const mutant=compile('old-profile-prefix',old);
 const result=invoke(mutant,{mode:'marker',nonce});
 assert.equal(result.profile,plainMarker);
 assert.throws(()=>assert.equal(result.profile,profileMarker),assert.AssertionError);
});
test('loosening actual selector equality to a prefix compiles and exposes the wrong-suffix regression',()=>{
 const mutant=compile('prefix-selector',changedOnce(selectorProgram,'row.tabURLs[row.activeTab] == $0','row.tabURLs[row.activeTab]?.hasPrefix($0) == true'));
 const result=invoke(mutant,{marker:profileMarker,rows:[profileOwned(2,9,profileMarker+'-suffix')]});
 assert.equal(result.id,2);
 assert.throws(()=>assert.equal(result.id,null),assert.AssertionError);
});

const realCreate=block('func createWindow(');
const dryCreate=block('func executeDry(');
const profileDeclaration=realCreate.match(/let profile = .*\n/)[0];
const markerAssignment=realCreate.match(/let marker = .*\n/)[0];
const processStatements=realCreate.slice(realCreate.indexOf('let process = Process()'),realCreate.indexOf('                    try tx.write("new_window_create")'));
// This fixture executes the real Foundation.Process construction statements only.
// There is deliberately no run, wait or application lookup in its generated program.
const wireProgram=`import Foundation
struct Wire {
 static ${markerHelper}
 static func inspect(_ intent:[String:Any])->[String:Any] {
  ${profileDeclaration}${markerAssignment}
  if let profile = profile {
   ${processStatements}
   return ["marker":marker,"executable":process.executableURL!.path,"argv":process.arguments!]
  }
  return ["marker":marker,"argv":[]]
 }
}
let intent=try! JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
print(String(data:try! JSONSerialization.data(withJSONObject:Wire.inspect(intent)),encoding:.utf8)!)
`;
assert.doesNotMatch(wireProgram,/\.run\(|waitUntilExit|NSRunningApplication/);
const wireBinary=compile('real-process-construction',wireProgram);
const profilePattern=/^data:text\/plain,mychrome-native-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const plainPattern=/^about:blank#mychrome-native-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
function assertProfileWiring(result,profile) {
 assert.match(result.marker,profilePattern);
 assert.equal(result.executable,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 assert.deepEqual(result.argv,['--profile-directory='+profile,'--new-window',result.marker]);
}
test('actual real Process construction passes a fresh marker as one third argument and preserves profile predicates',()=>{
 for(const profile of ['Default','Profile 3']) {
  const first=invoke(wireBinary,{profile,url:'https://destination.invalid/private'});
  assertProfileWiring(first,profile);
  assert.notEqual(first.marker,invoke(wireBinary,{profile}).marker);
 }
 for(const profile of [undefined,'']) {
  const result=invoke(wireBinary,{profile}); assert.match(result.marker,plainPattern); assert.deepEqual(result.argv,[]);
 }
 assert.match(realCreate,/Self\.newWindowMarker\(profileCLI: profile != nil, nonce: UUID\(\)\)/);
 assert.match(realCreate,/Self\.createdWindow\(rows, previous: previous, marker: profile != nil \? marker : nil, receiptID: receiptID\)/);
 assert.match(dryCreate,/let profile = \(intent\["profile"\] as\? String\)\?\.isEmpty == false/);
 assert.match(dryCreate,/Self\.newWindowMarker\(profileCLI: profile, nonce: UUID\(\)\)/);
});
test('breaking the real profile helper call compiles and fails its actual Process marker assertion',()=>{
 const mutant=compile('real-callsite-plain',changedOnce(wireProgram,'profileCLI: profile != nil','profileCLI: false'));
 const result=invoke(mutant,{profile:'Profile 3'});
 assert.match(result.marker,plainPattern);
 assert.throws(()=>assertProfileWiring(result,'Profile 3'),assert.AssertionError);
});

// Only four inert scenarios exercise the unchanged production createWindow loop.
// All launch, Apple Event, metadata, CG, application and time effects below are doubles.
// The separately compiled Session suite owns noRetry/Stop enforcement outside this method.
const geometryTypes=['WindowDisplayRecord','WindowScreenRecord','WindowDisplay','WindowDisplaySet','WindowGeometryIntent','WindowGeometryPlan'];
const geometryPure=['geometryRectValid','geometryContains','geometryUsableRect','windowDisplays','geometryFit','geometryIntent','geometryPlan','geometryPostcondition'];
const geometryOwner=['readWindowDisplays','readWindowGeometry','prepareWindowGeometry','verifyWindowGeometry','applyWindowGeometry','setWindow'];
function createProgram(body=realCreate) {
 return `import Foundation
import CoreFoundation
import CoreGraphics // CGRect value operations only; every CG metadata effect is doubled.
enum ChromeNative {
 static ${block('static func dialogInt(',0)}
 static ${block('static func sameRect(',0)}
 ${geometryTypes.map(name=>block('    struct '+name+' {',4)).join('\n')}
 ${geometryPure.map(name=>block('    static func '+name+'(',4)).join('\n')}
 static func sampleWindowDisplays() throws -> ([WindowDisplayRecord],[WindowScreenRecord]) {
  let full=CGRect(x:0,y:0,width:1920,height:1080)
  return ([WindowDisplayRecord(id:1,full:full,awake:true,mirrored:false,main:true)],
   [WindowScreenRecord(id:1,frame:full,visible:full,safeTop:0)])
 }
}
${geometryTypes.map(name=>'typealias '+name+' = ChromeNative.'+name).join('\n')}
let kCGNullWindowID=0
let kCGWindowOwnerPID="pid",kCGWindowNumber="number",kCGWindowLayer="layer",kCGWindowBounds="bounds"
enum FixtureCGOption { case optionAll }
struct Probe {
 func check() throws {}
 func CGWindowListCopyWindowInfo(_ options:[FixtureCGOption],_ relative:Int)->Any? {
  model.geometryCGReads += 1
  return model.rows.map { row in [kCGWindowOwnerPID:42,kCGWindowLayer:0,kCGWindowNumber:row.id==2 ? 20:30,kCGWindowBounds:row.bounds.dictionaryRepresentation as NSDictionary] }
 }
}
${block('final class BoundsEvidence {',0)}
${['struct Target: Equatable {','struct Failure: Error {','struct WindowRow: Sendable {','final class Transaction {'].map(name=>block(name,4)).join('\n')}
final class Model {
 var scenario="success",clock:Double=0,creates=0,polls=0,cgReads=0,geometryCGReads=0
 var argv:[String]=[],executable="",effects:[String]=[]
 var rows=[WindowRow(id:1,tabs:[5],activeTab:5,index:1,bounds:.zero,minimized:false,title:"old",tabURLs:[5:"about:blank"])]
 func launch(_ args:[String]) {
  creates += 1; argv=args; effects.append("create")
  let marker=args.last!
  func row(_ id:Int,_ tab:Int,_ url:String)->WindowRow {
   WindowRow(id:id,tabs:[tab],activeTab:tab,index:1,bounds:CGRect(x:0,y:0,width:800,height:600),minimized:false,title:"fixture",tabURLs:[tab:url])
  }
  rows += scenario == "missing" ? [row(3,10,"https://unrelated.invalid/")] : [row(2,9,marker)]
  if scenario == "duplicate" { rows.append(row(3,10,marker)) }
 }
}
let model=Model()
final class InertProcess {
 var executableURL:URL?,arguments:[String]?,standardOutput:Any?,standardError:Any?
 func run() throws { model.executable=executableURL!.path; model.launch(arguments!) }
}
typealias Process=InertProcess
enum InertFileHandle { static let nullDevice=0 }
typealias FileHandle=InertFileHandle
struct InertClock { static let processInfo=InertClock(); var systemUptime:Double { model.clock } }
typealias ProcessInfo=InertClock
struct NSRunningApplication {
 let processIdentifier:pid_t
 init?(processIdentifier:pid_t) { self.processIdentifier=processIdentifier }
 var executableURL:URL? { URL(fileURLWithPath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") }
}
struct NSWorkspace { static let shared=NSWorkspace(); var frontmostApplication:NSRunningApplication? { nil } }
struct NSAppleEventDescriptor {
 var stringValue:String?=nil,rect:CGRect?=nil,property:String?=nil,targetWindow:Int?=nil
 init() {}
 init(typeCode:UInt32) {}
 init(string:String) { stringValue=string }
 func setParam(_ value:NSAppleEventDescriptor,forKeyword:UInt32) {}
}
final class Owner {
 var creationAttempted=false,target:Target?
 private var creationPin:(window:Int,cg:Int,cgs:Set<Int>,windows:Set<Int>)?
 let dry=false
 var dryConfig:[String:Any]=[:],dryCG:[Int:Int]=[:]
 func requireAlive(_ stage:String)throws {}
 static func code(_ value:String)->UInt32 { 0 }
 static ${markerHelper}
 static ${block('static func createdWindow(')}
 static func createdWindowReceipt(_ reply:NSAppleEventDescriptor)throws->Int { throw Failure("fixture_wrong_branch","fixture") }
 // Non-dry capsules never enter these branches; a trap is a fixture failure.
 func dryWrite(_ stage:String,tx:Transaction,_ body:()->Void = {})throws { fatalError("FIXTURE_EXCLUDED_PATH: dryWrite") }
 func dryUpdate(_ id:Int,rect:CGRect?) { fatalError("FIXTURE_EXCLUDED_PATH: dryUpdate") }
 func creationPID(_ intent:[String:Any])throws->pid_t { 42 }
 ${['bounds','url','resultTarget'].map(name=>block('func '+name+'(')).join('\n')}
 ${geometryOwner.map(name=>block('func '+name+'(')).join('\n')}
 func snapshot(_ pid:pid_t)throws->[WindowRow] { model.polls += 1; return model.rows }
 func pump()throws { model.clock += 2 }
 func probe()->Probe { Probe() }
 func cgMapping(_ pid:pid_t,rows:[WindowRow],access:Probe,observe:((Int,Int?,Int?,CGRect?,[Int?],[Bool?],[Int],[Int])->Void)? = nil,
  retaining:(window:Int,cg:Int,cgs:Set<Int>,windows:Set<Int>)? = nil,captureUnique:(([Int:Int],Set<Int>)->Void)? = nil)throws->[Int:Int] { model.cgReads += 1; return model.scenario == "noCG" ? [:] : [2:20,3:30] }
 func rectangle(_ rect:CGRect)throws->NSAppleEventDescriptor { var d=NSAppleEventDescriptor();d.rect=rect;return d }
 func event(_ pid:pid_t,id:String)->NSAppleEventDescriptor { NSAppleEventDescriptor() }
 func verify(_ target:Target,observe:((Int,Int?,Int?,CGRect?,[Int?],[Bool?],[Int],[Int])->Void)? = nil,until:Double?=nil)throws->WindowRow { model.rows.first(where:{$0.id == target.windowId})! }
 func windowProperty(_ target:Target,_ property:String,_ value:NSAppleEventDescriptor)throws->NSAppleEventDescriptor {
  var descriptor=value;descriptor.property=property;descriptor.targetWindow=target.windowId;return descriptor
 }
 func tabProperty(_ target:Target,_ property:String,_ value:NSAppleEventDescriptor)throws->NSAppleEventDescriptor { value }
 @discardableResult func send(_ event:NSAppleEventDescriptor,stage:String,tx:Transaction)throws->NSAppleEventDescriptor {
  try tx.write(stage) {
   if event.property == "pbnd" {
    model.effects.append("bounds")
    guard let rect=event.rect,let id=event.targetWindow,let i=model.rows.firstIndex(where:{$0.id == id}) else { fatalError("fixture bounds target missing") }
    let row=model.rows[i]
    model.rows[i]=WindowRow(id:row.id,tabs:row.tabs,activeTab:row.activeTab,index:row.index,bounds:rect,minimized:row.minimized,title:row.title,tabURLs:row.tabURLs)
   } else {
    model.effects.append("url")
    if let value=event.stringValue,let i=model.rows.firstIndex(where:{$0.id == 2}) { model.rows[i].tabURLs[9]=value }
   }
  }
  return NSAppleEventDescriptor()
 }
 ${body}
}
let fixture=try! JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
model.scenario=fixture["scenario"] as! String
let owner=Owner(),tx=Transaction(operationId:"fixture",checkpoint:{_ in})
var result:[String:Any]
do { result=try owner.createWindow(["kind":"newWindow","profile":"Profile 3","url":"https://destination.invalid/","displayId":1,"bounds":["left":100,"top":40,"width":800,"height":600]],tx:tx) }
catch let error as Failure { result=error.json }
catch { fatalError("unexpected fixture error: \\(error)") }
result["creates"]=model.creates; result["argv"]=model.argv; result["executable"]=model.executable
result["effects"]=model.effects; result["stages"]=tx.stages; result["polls"]=model.polls; result["cgReads"]=model.cgReads
result["target"]=owner.target?.json as Any? ?? NSNull()
result["geometryCGReads"]=model.geometryCGReads
print(String(data:try! JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`;
}
const inertCreateProgram=createProgram();
assert.doesNotMatch(inertCreateProgram,/import (?:AppKit|ApplicationServices|Carbon)|Foundation\.Process|NSAppleScript|CGEvent|posix_spawn/);
const createBinary=compile('actual-create-window-inert',inertCreateProgram);
function assertCreated(result) {
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.target,{chromePid:42,windowId:2,tabId:9,cgWindow:20});
 assert.equal(result.url,'https://destination.invalid/');
 assert.deepEqual(result.effects,['create','bounds','url']);
 assert.deepEqual(result.stages.map(x=>x.stage),['new_window_create','new_window_bounds','new_window_url']);
}
function assertRefused(result) {
 assert.equal(result.error,'new_window_unconfirmed',JSON.stringify(result));
 assert.equal(result.stage,'new_window_identity'); assert.equal(result.creationAttempted,true);
 assert.equal(result.partial,true); assert.equal(result.target,null);
 assert.equal(result.createdWindowId,undefined); assert.equal(result.createdTabId,undefined);
 assert.deepEqual(result.effects,['create']); assert.deepEqual(result.stages.map(x=>x.stage),['new_window_create']);
}
for(const scenario of ['success','missing','duplicate','noCG']) test(`actual createWindow inert ${scenario} keeps exact ownership and one launch`,()=>{
 const result=invoke(createBinary,{scenario});
 assert.equal(result.creates,1); assert.match(result.argv[2],profilePattern);
 assert.deepEqual(result.argv,['--profile-directory=Profile 3','--new-window',result.argv[2]]);
 assert.equal(result.executable,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 if(scenario==='success') { assertCreated(result); assert.equal(result.cgReads,1); }
 else { assertRefused(result); assert.equal(result.cgReads,scenario==='noCG'?3:0); }
 assert.equal(result.polls,scenario==='missing'||scenario==='noCG'?4:2);
});
test('breaking the real Process marker argument compiles then fails creation before bounds or URL',()=>{
 const mutant=compile('wrong-real-argv',createProgram(changedOnce(realCreate,'"--new-window", marker]','"--new-window", marker + "-wrong"]')));
 const result=invoke(mutant,{scenario:'success'});
 assertRefused(result); assert.equal(result.creates,1);
 assert.throws(()=>assertCreated(result),assert.AssertionError);
});
test('bypassing the actual CG gate compiles and exposes forbidden continuation in the noCG case',()=>{
 const mutant=compile('bypassed-real-cg',createProgram(changedOnce(realCreate,'if let cg = mapped {','if let cg = Optional(mapped ?? 20) {')));
 const result=invoke(mutant,{scenario:'noCG'});
 assertCreated(result);
 assert.throws(()=>assertRefused(result),assert.AssertionError);
});
