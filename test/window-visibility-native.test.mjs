/** Actual non-dry Session.opNative -> Owner.run -> execute -> createWindow -> Transaction.
 * Unrelated branches are fail-closed traps, never refusal evidence.
 * Every generated capsule, binary and complete stdout/stderr is retained, including failed attempts.
 * This does not run the product helper or reproduce a historical live operation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SOURCE = fileURLToPath(new URL('../src/native-chrome.swift', import.meta.url));
const DRIVER = fileURLToPath(import.meta.url);
const HELPER = fileURLToPath(new URL('../src/helper.swift', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = filename => sha(fs.readFileSync(filename));
const source = fs.readFileSync(SOURCE, 'utf8'), SOURCE_SHA = sha(source);
const helperSource=fs.readFileSync(HELPER,'utf8'),HELPER_SHA=sha(helperSource),haltAnchor='enum Halt: Error {';
const haltStart=helperSource.indexOf(haltAnchor);assert.ok(haltStart>=0&&helperSource.indexOf(haltAnchor,haltStart+1)===-1);
const haltBlock=helperSource.slice(haltStart,helperSource.indexOf('\n}',haltStart)+2);
assert.equal(haltBlock.split('\n').length,5,'only the pure-value Halt enum is extracted');
const specs = [
  {
    "name": "DialogFailure",
    "anchor": "struct DialogFailure:",
    "indent": 0,
    "singleLine": false
  },
  {
    "name": "ChromeWin",
    "anchor": "struct ChromeWin {",
    "indent": 0,
    "singleLine": true
  },
  {
    "name": "dialogInt",
    "anchor": "static func dialogInt(",
    "indent": 0,
    "singleLine": false
  },
  {
    "name": "sameRect",
    "anchor": "static func sameRect(",
    "indent": 0,
    "singleLine": false
  },
  {
    "name": "matchWindows",
    "anchor": "static func matchWindows(",
    "indent": 0,
    "singleLine": false
  },
  {
    "name": "Target",
    "anchor": "    struct Target:",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "Failure",
    "anchor": "    struct Failure:",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "WindowRow",
    "anchor": "    struct WindowRow:",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "Transaction",
    "anchor": "    final class Transaction {",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "Probe.check",
    "anchor": "    func check() throws",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "Probe.around",
    "anchor": "    func around<T>(",
    "indent": 4,
    "singleLine": false
  },
  {
    "name": "Owner.requireAlive",
    "anchor": "        func requireAlive(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.probe",
    "anchor": "        func probe()",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.identity",
    "anchor": "        func identity(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.cgMapping",
    "anchor": "        func cgMapping(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.verify",
    "anchor": "        @discardableResult\n        func verify(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.creationPID",
    "anchor": "        func creationPID(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.bounds",
    "anchor": "        func bounds(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.url",
    "anchor": "        func url(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.resultTarget",
    "anchor": "        func resultTarget(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.object",
    "anchor": "        func object(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.code",
    "anchor": "        static func code(",
    "indent": 8,
    "singleLine": true
  },
  {
    "name": "Owner.event",
    "anchor": "        func event(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.windowProperty",
    "anchor": "        func windowProperty(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.tabProperty",
    "anchor": "        func tabProperty(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.setWindow",
    "anchor": "        func setWindow(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.newWindowMarker",
    "anchor": "        static func newWindowMarker(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.createdWindow",
    "anchor": "        static func createdWindow(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.createdWindowReceipt",
    "anchor": "        static func createdWindowReceipt(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "Owner.createWindow",
    "anchor": "        func createWindow(",
    "indent": 8,
    "singleLine": false
  },
  {
    "name": "BoundsEvidence",
    "anchor": "final class BoundsEvidence {",
    "indent": 0,
    "singleLine": false
  }
];
specs.push({name:'Probe.retryFacts',anchor:'    func retryFacts(',indent:4});
specs.push({name:'Owner.probeUntil',anchor:'        func probe(until deadline:',indent:8});
for (const name of ['run','enterCall','execute','bound','bind','rescanVerify','verifyAfterWrite','rescanPause','select','exactWindow',...(source.includes('        func axAssistWindow(')?['axAssistWindow']:[]),'activateApp',...(source.includes('        func appleFront(')?['appleActivate','appleFront']:[]),'awaitFront','rectangle','send','noDialog','settleFocus','focus']) specs.push({name:'Owner.'+name,anchor:'        '+(['send','verifyAfterWrite'].includes(name)?'@discardableResult\n        ':'')+'func '+name+'(',indent:8});
const geometryTypes=['WindowDisplayRecord','WindowScreenRecord','WindowDisplay','WindowDisplaySet','WindowGeometryIntent','WindowGeometryPlan'];
const geometryFunctions=['geometryRectValid','geometryContains','geometryUsableRect','windowDisplays','geometryFit','geometryIntent','geometryPlan','geometryPostcondition'];
const geometryOwner=['readWindowDisplays','readWindowGeometry','prepareWindowGeometry','verifyWindowGeometry','applyWindowGeometry'];
const hasGeometry=source.includes('    struct WindowDisplayRecord {');
if(hasGeometry){
  for(const name of geometryTypes) specs.push({name,anchor:'    struct '+name+' {',indent:4});
  for(const name of geometryFunctions) specs.push({name,anchor:'    static func '+name+'(',indent:4});
  for(const name of geometryOwner) specs.push({name:'Owner.'+name,anchor:'        '+(['verifyWindowGeometry','applyWindowGeometry'].includes(name)?'@discardableResult\n        ':'')+'func '+name+'(',indent:8});
}
specs.push({name:'Probe.axIsWindowSharingIndicator',anchor:'func axIsWindowSharingIndicator(',indent:0});
// PERM1: the popup policy (exact source) and the Owner's wiring of it; the AX/CG reads below are model stand-ins.
if(source.includes('\nenum Popup {')) specs.push({name:'Popup',anchor:'enum Popup {',indent:0},{name:'Owner.clearChromePrompt',anchor:'        func clearChromePrompt(',indent:8});
const blocks = new Map();
for (const spec of specs) {
  const start = source.indexOf(spec.anchor);
  assert.ok(start >= 0 && source.indexOf(spec.anchor, start + 1) === -1, `Unique source anchor: ${spec.name}`);
  assert.ok(start === 0 || source[start - 1] === '\n', `Line-aligned anchor: ${spec.name}`);
  const closing = spec.singleLine ? source.indexOf('\n', start) : source.indexOf('\n' + ' '.repeat(spec.indent) + '}', start);
  assert.ok(closing > start, `Complete source block: ${spec.name}`);
  blocks.set(spec.name, source.slice(start, spec.singleLine ? closing : closing + spec.indent + 2));
}
const block = name => { assert.ok(blocks.has(name), name); return blocks.get(name); };

const helperBlocks = new Map();
for (const name of ['checkNative','owner','opNative','checkStop','requireRestore','requireInput','guardPress','guardWheel','revokeNativeState','handle','releaseHeld','runMove','plannedJSON','opClick','opMove','opWheel','measuredStage',...(hasGeometry?['refreshNativeGeometry','guardLanding']:[])]) {
  const anchor='    func '+name+(name==='measuredStage'?'<T>(':'('), start=helperSource.indexOf(anchor);
  assert.ok(start>=0 && helperSource.indexOf(anchor,start+1)===-1, `Unique Session ${name}`);
  const end=helperSource.indexOf('\n    }',start)+6;
  helperBlocks.set(name,helperSource.slice(start,end));
}
const movementGlobals = new Map();
for(const [name,anchor,singleLine] of [
  ['dist','func dist(',true],['lerp','func lerp(',false],['within','func within(',false],['inner80','func inner80(',true],['clampInto','func clampInto(',false],
  ['Stroke','struct Stroke {',false],['MovePlan','struct MovePlan {',false],['planMove','func planMove(',false],['r2','func r2(',true],
  ['pointArg','func pointArg(',false],['rectArg','func rectArg(',false],['pointJSON','func pointJSON(',true],['uniform','func uniform(',true],
  ['gauss','func gauss(',false],['lognormalMs','func lognormalMs(',false],['sampleDwell','func sampleDwell(',true],['sampleReaction','func sampleReaction(',true]
]){
  const start=helperSource.indexOf(anchor);assert.ok(start>=0&&helperSource.indexOf(anchor,start+1)===-1,anchor);
  const end=singleLine?helperSource.indexOf('\n',start):helperSource.indexOf('\n}',start)+2;
  movementGlobals.set(name,helperSource.slice(start,end));
}
for(const [name,anchor] of [['MoveRun','    struct MoveRun {'],['pace','    func pace('],['wait','    func wait(']]){
  const start=helperSource.indexOf(anchor);assert.ok(start>=0&&helperSource.indexOf(anchor,start+1)===-1,anchor);
  helperBlocks.set(name,helperSource.slice(start,helperSource.indexOf('\n',start)));
}
const helperNumAnchor='func num(_ v: Any?) -> Double?';
const helperNumStart=helperSource.indexOf(helperNumAnchor);
assert.ok(helperNumStart>=0&&helperSource.indexOf(helperNumAnchor,helperNumStart+1)===-1);
const helperNum=helperSource.slice(helperNumStart,helperSource.indexOf('\n',helperNumStart));
const hb=name=>helperBlocks.get(name);
const program = String.raw`import Foundation
import CoreFoundation // CFGetTypeID/CFBooleanGetTypeID inspect NSNumber values only.
import CoreGraphics // CGRect value operations only; metadata effects are local doubles.

typealias CFString = String
typealias CFTypeRef = AnyObject
typealias FourCharCode = UInt32
typealias AEReturnID = Int16
typealias AETransactionID = Int32
let kAutoGenerateReturnID: Int16 = -1
let kAnyTransactionID: Int32 = 0
let typeObjectSpecifier: UInt32 = 0x6f626a20
let typeNull: UInt32 = 0x6e756c6c
let typeUTF8Text: UInt32 = 0x75746638
let kCGNullWindowID = 0
let kCGWindowOwnerPID = "pid", kCGWindowLayer = "layer", kCGWindowNumber = "number"
let kCGWindowBounds = "bounds", kCGWindowIsOnscreen = "onScreen"
let kAXTitleAttribute = "title", kAXMinimizedAttribute = "minimized", kAXDocumentAttribute = "document"
enum CGOption: Equatable { case optionAll, optionOnScreenOnly, excludeDesktopElements }
enum AXError: Int { case success, cannotComplete }
typealias AXUIElement = AXElement
final class AXElement: NSObject {
    let number:Int,title:String,minimized:Bool,rect:CGRect?
    init(number:Int,title:String,minimized:Bool,rect:CGRect?){self.number=number;self.title=title;self.minimized=minimized;self.rect=rect}
}
let kAXFocusedWindowAttribute="focusedWindow"
let kAXSubroleAttribute="subrole",kAXRoleAttribute="role",kAXChildrenAttribute="children"
let kAXDialogSubrole="AXDialog",kAXWindowRole="AXWindow",kAXButtonRole="AXButton"
func AXUIElementCreateApplication(_ pid:pid_t)->AXElement{AXElement(number:-Int(pid),title:"Synthetic app",minimized:false,rect:nil)}
func AXUIElementGetTypeID()->CFTypeID{CFGetTypeID(AXElement(number:0,title:"type value",minimized:false,rect:nil))}

// These names intentionally shadow framework effectful types. They have no OS access.
struct InertUUID { let uuidString = "01234567-89AB-4CDE-8F01-23456789ABCD" }
typealias UUID = InertUUID
enum InertThread { static let isMainThread = true }
typealias Thread = InertThread
struct InertClock {
    static let processInfo = InertClock()
    var systemUptime: Double { model.clock }
}
typealias ProcessInfo = InertClock
enum InertFileHandle { static let nullDevice = 0 }
typealias FileHandle = InertFileHandle
final class InertProcess {
    var executableURL: URL?, arguments: [String]?, standardOutput: Any?, standardError: Any?
    func run() throws {
        guard executableURL?.path == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              let args = arguments else { throw ChromeNative.Failure("fixture_launch_shape", "fixture") }
        try model.launch(args)
    }
}
typealias Process = InertProcess
struct NSRunningApplication {
    let processIdentifier: pid_t
    let isTerminated = false
    var localizedName: String? { "Synthetic Chrome" }
    func activate(options: [Int]) -> Bool { model.activateApp(processIdentifier) }
    let bundleIdentifier: String? = "com.google.Chrome"
    var executableURL: URL? { URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") }
    init?(processIdentifier: pid_t) {
        guard processIdentifier == 42 else { return nil }
        self.processIdentifier = processIdentifier
    }
}
struct NSWorkspace {
    static let shared = NSWorkspace()
    var frontmostApplication: NSRunningApplication? { model.front == 0 ? nil : NSRunningApplication(processIdentifier:model.front) }
}

// Descriptor trees and their local sendEvent method affect only the in-memory model.
final class NSAppleEventDescriptor {
    var descriptorType: UInt32 = typeNull
    var stringValue: String?
    var typeCodeValue: UInt32 = 0
    var enumCodeValue: UInt32 = 0
    var fields: [UInt32: NSAppleEventDescriptor] = [:]
    var objectType: String?, objectID: Int?, propertyCode: UInt32?, container: NSAppleEventDescriptor?
    var rect: CGRect?, eventID: UInt32?, processID: pid_t?
    var int32Value: Int32 = 0
    init(boolean: Bool) { int32Value = boolean ? 1 : 0 }
    init(int32: Int32) { int32Value = int32 }
    struct SendOptions: OptionSet { let rawValue: Int; static let noReply=Self(rawValue:1), neverInteract=Self(rawValue:2), waitForReply=Self(rawValue:4) }
    convenience init?(descriptorType: UInt32, bytes: UnsafeRawPointer, length: Int) {
        self.init(); precondition(descriptorType == typeQDRectangle && length == MemoryLayout<Carbon.Rect>.size)
        let r=bytes.load(as:Carbon.Rect.self); rect=CGRect(x:Int(r.left),y:Int(r.top),width:Int(r.right)-Int(r.left),height:Int(r.bottom)-Int(r.top))
    }
    func sendEvent(options: SendOptions, timeout: Double) throws -> NSAppleEventDescriptor {
        precondition(timeout == 0.05)
        if eventID == ChromeNative.Owner.code("crel") {return model.createEvent(self)}
        // FOCUS4 amendment A: Chrome's own activate Apple Event ('misc'/'actv'), modelled, never sent.
        if eventID == ChromeNative.Owner.code("actv") {precondition(fields[0]?.typeCodeValue == ChromeNative.Owner.code("misc"));model.appleActivate(Int(processID ?? 0));return NSAppleEventDescriptor()}
        try model.apply(self); return NSAppleEventDescriptor()
    }
    init() {}
    init(typeCode: UInt32) { typeCodeValue = typeCode }
    init(string: String) { stringValue = string }
    init(processIdentifier: pid_t) { processID = processIdentifier }
    init(eventClass: UInt32, eventID: UInt32, targetDescriptor: NSAppleEventDescriptor?,
         returnID: AEReturnID, transactionID: AETransactionID) {
        self.eventID = eventID; processID = targetDescriptor?.processID
        fields[0] = NSAppleEventDescriptor(typeCode: eventClass)
    }
    func setParam(_ value: NSAppleEventDescriptor, forKeyword: UInt32) { fields[forKeyword] = value }
    func paramDescriptor(forKeyword: UInt32) -> NSAppleEventDescriptor? { fields[forKeyword] }
    func forKeyword(_ key: UInt32) -> NSAppleEventDescriptor? { fields[key] }
    func coerce(toDescriptorType: UInt32) -> NSAppleEventDescriptor? { self }
}


let typeQDRectangle: UInt32 = 0x51447274
let kAXMainAttribute = "main", kAXRaiseAction = "raise", kAXPressAction = "press"
enum Carbon { struct Rect { let top: Int16, left: Int16, bottom: Int16, right: Int16 } }
enum ApplicationServices {
    static func AXUIElementSetMessagingTimeout(_ e: AXElement,_ t: Double) -> AXError { .success }
}
func AXUIElementSetAttributeValue(_ e:AXElement,_ k:CFString,_ v:Any?) -> AXError { model.axEffect(e,k) }
func AXUIElementPerformAction(_ e:AXElement,_ k:CFString) -> AXError { model.axEffect(e,k) }
let gTakeoverTap: Int? = 1, gTap: Int? = 1
struct CGEvent { static func tapIsEnabled(tap:Int)->Bool { true } }
typealias CGDirectDisplayID = UInt32
enum MonitorEvent { case tapDisabledByTimeout }
func secureInputHolder()->Int? { nil }
struct InertLock { func lock(){};func unlock(){} }
${[...movementGlobals.values()].join('\n')}
// Only random sampling, the timebase and saved habit values are inert inputs.
func unit()->Double{0.5}
func nowMs()->Double{model.clock*1000}
func fittsU()->Double{0.55}
struct InertDistribution{let value:Double;func sample()->Double{value}}
struct InertHabits{let peakScale=1.0,bowLo=0.0,bowHi=0.0;let pressDwell=InertDistribution(value:18),clickHold=InertDistribution(value:70),wheelGap=InertDistribution(value:80)}
let gHabits=InertHabits()
typealias CGKeyCode=UInt16
let kShift:CGKeyCode=56,kCommand:CGKeyCode=55
final class InertPanel{func begin(_ s:String,est:Double=0){};func finish(_ s:String){};func fail(){}}

// Every excluded path traps. A trap is always a fixture failure, never a semantic refusal.
func excluded<T>(_ name:String)->T { fatalError("FIXTURE_EXCLUDED_PATH: "+name) }

enum ChromeNative {
${hasGeometry?[...geometryTypes,...geometryFunctions].map(block).join('\n'):''}
${hasGeometry?`    static func sampleWindowDisplays() throws -> ([WindowDisplayRecord], [WindowScreenRecord]) {
        model.displaySamples()
    }`:''}
${block('DialogFailure')}
${block('ChromeWin')}
${block('dialogInt')}
${block('sameRect')}
${block('matchWindows')}
${block('Target')}
${block('Failure')}
${block('WindowRow')}
${block('Transaction')}
${block('BoundsEvidence')}
${blocks.has('Popup')?block('Popup'):''}
    final class Probe {
        let deadline:Double, checkpoint:()throws->Void, snapshot:(pid_t)throws->[WindowRow]
        var firstFailure:Error?, axRetries=0, axLastError:Int?
        init(budget:Double,checkpoint:@escaping ()throws->Void,snapshot:@escaping(pid_t)throws->[WindowRow]) {
            deadline=ProcessInfo.processInfo.systemUptime+budget;self.checkpoint=checkpoint;self.snapshot=snapshot
        }
${block('Probe.check')}
${block('Probe.around')}
${block('Probe.retryFacts')}
        func CGWindowListCopyWindowInfo(_ o:[CGOption],_ relative:Int)->Any? { around(nil as [[String:Any]]?) { model.cgRowsRead(options:o) } }
        func axWindows(pid:pid_t)->[AXElement] { around([]) { model.axRows() } }
        func axWindowNumber(_ e:AXElement)->Int? { around(nil as Int?) { e.number } }
        func AXUIElementCopyAttributeValue(_ e:AXElement,_ k:CFString,_ v:UnsafeMutablePointer<CFTypeRef?>)->AXError {
            around(.cannotComplete) {
                if k == kAXFocusedWindowAttribute { v.pointee=model.focusedElement();return v.pointee == nil ? .cannotComplete:.success }
                switch k {
                case kAXTitleAttribute:v.pointee=e.title as AnyObject
                case kAXMinimizedAttribute:v.pointee=e.minimized as AnyObject
                case kAXSubroleAttribute:v.pointee="AXStandardWindow" as AnyObject
                case kAXRoleAttribute:v.pointee="AXWindow" as AnyObject
                case kAXChildrenAttribute:v.pointee=[] as [AXElement] as AnyObject
                default:return .cannotComplete
                }
                return .success
            }
        }
        func axRect(_ e:AXElement)->CGRect? { around(nil as CGRect?) { e.rect } }
        func AXUIElementSetMessagingTimeout(_ e:AXElement,_ timeout:Float)->AXError{around(.cannotComplete){.success}}
${block('Probe.axIsWindowSharingIndicator')}
        func axPageDialog(pid:pid_t)throws->Int? { excluded("axPageDialog") }
        // PERM1: the popup reads, answered by the model (production Probe.popupAbove/popupShape are compiled by perm-prompt.test.mjs).
        func popupAbove(_ t:Target)->Popup.Above? { around(nil as Popup.Above?) { model.popupAbove(t.cgWindow) } }
        func popupShape(_ n:Int,pid:pid_t)->Popup.Shape { around(Popup.Shape()) { model.popupShape(n) } }
        func popupPressable(_ e:AXElement)->Bool { around(false) { model.popupPressable(e) } }
    }
    final class Owner {
        let dry:Bool
        private var creationPin:(window:Int,cg:Int,cgs:Set<Int>,windows:Set<Int>)?
        var dryCG:[Int:Int]=[:], target:Target?, scene:[String:Any]?
        var dryConfig:[String:Any]=[:]
        var stopped=false, creationAttempted=false, active:Transaction?, lastTransaction:Transaction?
        var operations=Set<String>(), seedCG=1, seedBounds=CGRect.null, mutationRequested=false, callId:String?=nil
        var stageCheck:(String)throws->Void={_ in}, pump:()throws->Void={model.clock += 1}
        var held:()->Bool={false}   // PERM1 r1 A3: wired by the Session's exact owner() block
        init(dry:Bool){self.dry=dry;precondition(!dry);model.ownerCreated()}
        func invalidate(){stopped=true}
        func seed(_ t:Target){precondition(!dry)}
${block('Owner.requireAlive')}
${block('Owner.probe')}
${block('Owner.probeUntil')}
${block('Owner.identity')}
${block('Owner.cgMapping')}
${block('Owner.verify')}
${block('Owner.creationPID')}
${block('Owner.bounds')}
${block('Owner.url')}
${block('Owner.resultTarget')}
${block('Owner.object')}
${block('Owner.code')}
${block('Owner.event')}
${block('Owner.windowProperty')}
${block('Owner.tabProperty')}
${block('Owner.setWindow')}
${block('Owner.newWindowMarker')}
${block('Owner.createdWindow')}
${block('Owner.createdWindowReceipt')}
${block('Owner.createWindow')}
${block('Owner.run')}
${block('Owner.execute')}
${block('Owner.bound')}
${block('Owner.bind')}
${block('Owner.enterCall')}
${block('Owner.rescanVerify')}
${block('Owner.verifyAfterWrite')}
${block('Owner.rescanPause')}
${block('Owner.select')}
${block('Owner.exactWindow')}
${blocks.has('Owner.axAssistWindow')?block('Owner.axAssistWindow'):''}
${block('Owner.activateApp')}
${blocks.has('Owner.appleFront')?block('Owner.appleActivate')+'\n'+block('Owner.appleFront'):''}
${blocks.has('Owner.clearChromePrompt')?block('Owner.clearChromePrompt'):''}
${block('Owner.awaitFront')}
${block('Owner.rectangle')}
${block('Owner.send')}
${block('Owner.noDialog')}
${hasGeometry?geometryOwner.map(name=>block('Owner.'+name)).join('\n'):''}
        func snapshot(_ pid:pid_t,until:Double?=nil)throws->[WindowRow] {
            try requireAlive("native_read");let r=model.snapshot(pid);try requireAlive("native_read");return r
        }
        // Descriptor construction is inert value plumbing, preserving exact addressed object/property IDs.
        func specifier(_ type:String,form:String,key:NSAppleEventDescriptor,container:NSAppleEventDescriptor?=nil)throws->NSAppleEventDescriptor {
            let d=NSAppleEventDescriptor();d.descriptorType=typeObjectSpecifier;d.objectType=type;d.container=container
            if type == "prop" && form == "prop" { d.propertyCode=key.typeCodeValue }
            else if ["cwin","CrTb"].contains(type),form == "ID  ",let id=key.stringValue.flatMap(Int.init),id>0 { d.objectID=id }
            else { return excluded("specifier shape") };return d
        }
        // Non-dry capsules never enter these branches; a trap is a fixture failure.
        func dryWrite(_ stage:String,tx:Transaction,_ body:()->Void = {})throws { fatalError("FIXTURE_EXCLUDED_PATH: dryWrite") }
        func dryUpdate(_ id:Int,rect:CGRect?) { fatalError("FIXTURE_EXCLUDED_PATH: dryUpdate") }
        func executeDry(_ i:[String:Any],request:[String:Any],tx:Transaction)throws->[String:Any]{excluded("executeDry")}
        func executeDialog(_ i:[String:Any],tx:Transaction)throws->[String:Any]{excluded("dialogAnswer")}
        func restore(_ i:[String:Any],request:[String:Any],tx:Transaction)throws->[String:Any]{excluded("restoreScene")}
        func createTab(_ t:Target,intent:[String:Any],before:WindowRow,tx:Transaction)throws->[String:Any]{excluded("openTab")}
        func inspect(_ t:[String:Any],existing:String?)throws->[String:Any]{excluded("inspectDialog")}
        func recordScene(_ t:[String:Any])throws->[String:Any]{excluded("recordScene")}
${block('Owner.settleFocus')}
${block('Owner.focus')}
    }
}
${haltBlock}
${helperNum}
final class InertVeil { var holes:[CGRect]=[];func updateHole(_ bounds:CGRect){holes.append(bounds)} }
final class Session {
    var veil:InertVeil?,panel:InertPanel?=InertPanel()
    var rate=2.0,speed=1.0,t0=0.0,slowestStageMs=0.0
    var currentStage="idle",currentOperation="idle",speedSaveState="idle",navigationOnly=false
    var recentStage:[String:Any]?,slowestStage:[String:Any]?,lastReply:[String:Any]=[:]
    var posted:[[String:Any]]=[],progress:[String:Any]=[:]
    var heldMouse:(CGPoint,Int)?,heldKey:(CGKeyCode,String?)?,heldShift=false,heldCmd=false
    func ms()->Double{r2(nowMs()-t0)}
    func waitUntil(_ deadline:Double)throws{try checkStop();model.clock=max(model.clock,deadline/1000);try checkStop()}
    func sendMove(_ p:CGPoint){model.postMove(p)}
    func sendButton(_ down:Bool,_ p:CGPoint,clicks:Int){model.postButton(down,p,clicks)}
    func sendWheel(_ delta:Int32,at p:CGPoint){model.postWheel(delta,p)}
    func sendKey(_ key:CGKeyCode,_ down:Bool,_ unicode:String?){let _:Void=excluded("key effect")}
    func sendFlags(_ key:CGKeyCode){let _:Void=excluded("flags effect")}
    func refreshSpeedSetting(){} // No saved configuration is read.
    func settle(){} // No run loop is serviced.
    func reply(_ req:[String:Any],_ body:[String:Any]){lastReply=body}
    func opWatchNavigation(_ r:[String:Any])throws->[String:Any]{excluded("watchNavigation")}
    func opNavigationState(_ r:[String:Any])->[String:Any]{excluded("navigationState")}
    func opBegin(_ r:[String:Any])throws->[String:Any]{excluded("begin")}
    func opHold(_ r:[String:Any])throws->[String:Any]{excluded("hold")}
    func opPrime()->[String:Any]{excluded("prime")}
    func opType(_ r:[String:Any])throws->[String:Any]{excluded("type")}
    func opKey(_ r:[String:Any])throws->[String:Any]{excluded("key")}
    func opPaste(_ r:[String:Any])throws->[String:Any]{excluded("paste")}
    func restoreClipboard()->[String:Any]{excluded("restoreClipboard")}
    func opRouted(_ r:[String:Any])throws->[String:Any]{excluded("routed")}
    func opWarp(_ r:[String:Any])throws->[String:Any]{excluded("warp")}
    func opHandBack(_ r:[String:Any])throws->[String:Any]{excluded("handBack")}
    func opPanel(_ r:[String:Any])->[String:Any]{excluded("panel")}
    func opVeil(_ r:[String:Any])->[String:Any]{excluded("veil")}
    func finish(_ reason:String,_ req:[String:Any])->Never{fatalError("FIXTURE_EXCLUDED_PATH: finish")}

    let dry=false, lock=InertLock()
    var monitor=true,takeover=true,holding=true,begun=false,nativeRevoked=false,nativeUncertain=false,nativePaused=false
    var aborted=false,terminate=false,eof=false,interrupted:String?,pendingEnd:[String:Any]?,tapFailure:[String:Any]?
    var nativePolicy="normal", nativeEpoch=1, nativeOwner:ChromeNative.Owner?, window=0, chromePid:pid_t=0,windowBounds=CGRect.null
    struct Fake { var screenState:String? };var fake=Fake()
    var stages:[String]=[], screenSamples=["console":0,"displayList":0,"displayAwake":0]
    // Instance members deliberately shadow imported CG symbols for actual checkNative.
    func CGSessionCopyCurrentDictionary()->Any? { screenSamples["console"]! += 1; return ["kCGSSessionOnConsoleKey":true,"kCGSessionLoginDoneKey":true,"CGSSessionScreenIsLocked":false] }
    func CGGetActiveDisplayList(_ n:UInt32,_ ids:inout [UInt32],_ count:inout UInt32)->AXError { screenSamples["displayList"]! += 1; ids[0]=1;count=1;return .success }
    func CGDisplayIsAsleep(_ id:UInt32)->Int32 { screenSamples["displayAwake"]! += 1; return 0 }
    func checkpoint(_ stage:String){stages.append(stage);model.checkpoint(self,stage)}
    func pumpNative()throws{model.clock += 0.001;try checkStop(true)}
    func drainControl(){}
    func recordMonitorDisabled(_ e:MonitorEvent){excluded("monitor disabled") as Void}
    func cursor()->CGPoint{model.cursor}
    func frontPid()->pid_t?{model.front}
    func topWindow(at p:CGPoint)->Int?{model.top}
    func foreignModifiers()->Bool{model.modifiersHeld}
${[...helperBlocks.values()].join('\n')}
}
struct PhysicalWindow { let id:Int,tab:Int,cg:Int;var rect:CGRect,url:String }
final class Model {
    let scenario:String
    let requested=CGRect(x:0,y:40,width:1000,height:700)
    let full=CGRect(x:0,y:0,width:1200,height:900),usable=CGRect(x:0,y:30,width:1200,height:830)
    var windows:[Int:PhysicalWindow]=[:],clock:Double=0,front:pid_t=42,top=20,cursor=CGPoint(x:100,y:100)
    var creates=0,boundsWrites=0,urlWrites=0,snapshots=0,cgReads=0,nativeEffects:[String]=[],descriptors:[[String:Any]]=[]
    init(_ s:String){scenario=s;windows[1]=PhysicalWindow(id:1,tab:5,cg:10,rect:CGRect(x:100,y:100,width:600,height:500),url:"about:blank#old")}
    func launch(_ a:[String])throws {
        precondition(creates==0 && a == ["--profile-directory=Profile 3","--new-window","data:text/plain,mychrome-native-01234567-89AB-4CDE-8F01-23456789ABCD"])
        creates+=1;windows[2]=PhysicalWindow(id:2,tab:9,cg:20,rect:CGRect(x:-300,y:60,width:1000,height:700),url:a[2])
    }
    func snapshot(_ pid:pid_t)->[ChromeNative.WindowRow] {
        precondition(pid==42 && snapshots<128);snapshots+=1
        return windows.keys.sorted().map { id in let w=windows[id]!;return ChromeNative.WindowRow(id:id,tabs:[w.tab],activeTab:w.tab,index:id==2 ? 1 : 2,bounds:w.rect,minimized:false,title:"Synthetic \(id)",tabURLs:[w.tab:w.url]) }
    }
    func cgRows()->[[String:Any]] {
        precondition(cgReads<64);cgReads+=1
        return windows.keys.sorted(by:>).map { id in let w=windows[id]!;return [kCGWindowOwnerPID:42,kCGWindowLayer:0,kCGWindowNumber:w.cg,kCGWindowBounds:w.rect.dictionaryRepresentation as NSDictionary,kCGWindowIsOnscreen:true] }
    }
    func axRows()->[AXElement] { windows.keys.sorted().map { id in let w=windows[id]!;return AXElement(number:w.cg,title:"Synthetic \(id)",minimized:false,rect:w.rect) } }
    func apply(_ d:NSAppleEventDescriptor)throws {
        let code=ChromeNative.Owner.code
        precondition(d.processID==42 && d.eventID==code("setd"))
        guard let p=d.fields[code("----")],let payload=d.fields[code("data")],let direct=p.container else { return excluded("primitive descriptor") }
        if p.propertyCode==code("pbnd") {
            precondition(direct.objectType=="cwin" && direct.objectID==2 && payload.rect==requested && boundsWrites==0 && urlWrites==0)
            boundsWrites+=1
            if scenario=="healthy" { windows[2]!.rect=requested }
            descriptors.append(["kind":"pbnd","windowId":2,"cgWindow":20])
        } else {
            precondition(p.propertyCode==code("URL ") && direct.objectType=="CrTb" && direct.objectID==9 && direct.container?.objectID==2 && payload.stringValue=="https://destination.invalid/inert")
            urlWrites+=1;windows[2]!.url=payload.stringValue!;descriptors.append(["kind":"url","windowId":2,"tabId":9])
        }
    }
}
extension Model {
    var modifiersHeld:Bool{false}
    func ownerCreated(){}
    func checkpoint(_ session:Session,_ stage:String){}
    func displaySamples()->([ChromeNative.WindowDisplayRecord],[ChromeNative.WindowScreenRecord]){
        ([ChromeNative.WindowDisplayRecord(id:1,full:full,awake:true,mirrored:false,main:true)],
         [ChromeNative.WindowScreenRecord(id:1,frame:full,visible:CGRect(x:0,y:40,width:1200,height:830),safeTop:0)])
    }
    func cgRows(options:[CGOption])->[[String:Any]]{let rows=cgRows();return options.contains(.optionOnScreenOnly) ? rows.filter{$0[kCGWindowIsOnscreen] as? Bool == true}:rows}
    func focusedElement()->AXElement?{guard let w=windows[2] else{return nil};return AXElement(number:w.cg,title:"Synthetic 2",minimized:false,rect:w.rect)}
    func activateApp(_ pid:pid_t)->Bool{front=pid;return true}
    func axEffect(_ e:AXElement,_ k:String)->AXError{nativeEffects.append(k);return .success}
    func postMove(_ p:CGPoint){let _:Void=excluded("creation pointer move")}
    func postButton(_ down:Bool,_ p:CGPoint,_ clicks:Int){let _:Void=excluded("creation pointer button")}
    func postWheel(_ delta:Int32,_ p:CGPoint){let _:Void=excluded("creation pointer wheel")}
}

extension Model {func createEvent(_ e:NSAppleEventDescriptor)->NSAppleEventDescriptor {fatalError("FIXTURE_EXCLUDED_PATH: original creation model uses only profile launch")}}
extension Model {func appleActivate(_ pid:Int){fatalError("FIXTURE_EXCLUDED_PATH: the creation model never activates")}}
extension Model {func cgRowsRead(options:[CGOption])->[[String:Any]]?{cgRows(options:options)}}
// PERM1: the creation model has no popup.
extension Model {func popupAbove(_ cg:Int)->ChromeNative.Popup.Above?{nil};func popupShape(_ n:Int)->ChromeNative.Popup.Shape{ChromeNative.Popup.Shape()};func popupPressable(_ e:AXElement)->Bool{false}}

precondition(CommandLine.arguments.count==2 && ["healthy","ignored"].contains(CommandLine.arguments[1]))
let model=Model(CommandLine.arguments[1]), session=Session()
let req:[String:Any]=["schema":1,"epoch":1,"op":"nativeChrome","operationId":"inert-create","call":"call-A","intent":["kind":"newWindow","chromePid":42,"profile":"Profile 3","url":"https://destination.invalid/inert","displayId":1,"bounds":["left":0,"top":40,"width":1000,"height":700]]]
let outcome=try session.opNative(req,"nativeChrome")
// NAT-RETRY r3b: a restore request carrying a different call id passes every Session gate and reaches the Owner
// (which refuses it by its own operation dedup, before the excluded restoreScene branch); restore never opens a call.
var restoreProbe:[String:Any]=["skipped":true]
if model.scenario=="healthy" {
    let restoreReq:[String:Any]=["schema":1,"epoch":session.nativeEpoch,"op":"nativeChrome","operationId":"inert-create","policy":"restore","restoreToken":"inert","call":"call-B","intent":["kind":"restoreScene"]]
    var restored:[String:Any]
    do { restored=try session.opNative(restoreReq,"nativeChrome") } catch let f as ChromeNative.Failure { restored=f.json }
    restoreProbe=["error":restored["error"] ?? NSNull(),"stage":restored["stage"] ?? NSNull(),"callAfter":session.nativeOwner?.callId ?? NSNull()]
}
let actual=model.windows[2]!
let receipt:[String:Any]=["scenario":model.scenario,"result":outcome,"counts":["creates":model.creates,"bounds":model.boundsWrites,"url":model.urlWrites,"snapshots":model.snapshots,"cg":model.cgReads],"physical":["windowId":actual.id,"tabId":actual.tab,"cgWindow":actual.cg,"bounds":[actual.rect.minX,actual.rect.minY,actual.rect.width,actual.rect.height]],"descriptors":model.descriptors,"session":["begun":session.begun,"holding":session.holding,"epoch":session.nativeEpoch,"stages":session.stages,"screenSamples":session.screenSamples,"nativeRevoked":session.nativeRevoked,"nativeUncertain":session.nativeUncertain,"nativeCall":session.nativeOwner?.callId ?? NSNull(),"mutationRequested":session.nativeOwner?.mutationRequested ?? NSNull(),"restoreProbe":restoreProbe],"scope":["nonDry":true,"completeOwnerRunExecute":true,"completeCreateWindow":true,"actualSessionNativeGates":true,"executedKinds":["newWindow"],"excludedBranches":["dialogAnswer","restoreScene","openTab","closeTab","inspectDialog","recordScene","activation focus pending"]]]
print(String(data:try JSONSerialization.data(withJSONObject:receipt,options:[.sortedKeys]),encoding:.utf8)!)
`;

for (const [name,value] of [...blocks,...helperBlocks,...movementGlobals]) assert.equal(program.split(value).length,2,`Exact source bytes once: ${name}`);
assert.equal(program.split(haltBlock).length,2);
assert.equal(program.split(helperNum).length,2);
assert.deepEqual([...program.matchAll(/^import (\w+)/gm)].map(m=>m[1]),['Foundation','CoreFoundation','CoreGraphics']);
for(const pattern of [/@_silgen_name/,/\b(?:NSAppleScript|SBApplication|ReadRunner|NSLock|NSMachPort|CGEventTapCreate)\b/,/\b(?:Foundation\.(?:Process|ProcessInfo|Thread|FileHandle)|ScriptingBridge\.)/,/\bCoreGraphics\.(?:CGWindow|CGEvent)/,/\b(?:sleep|usleep|nanosleep|kill|posix_spawn|system)\s*\(/]) assert.doesNotMatch(program,pattern);
for(const shadow of ['typealias Process = InertProcess','typealias ProcessInfo = InertClock','typealias Thread = InertThread','typealias FileHandle = InertFileHandle','typealias UUID = InertUUID','struct NSRunningApplication {','struct NSWorkspace {','final class NSAppleEventDescriptor {','enum ApplicationServices {','enum Carbon {']) assert.equal(program.split(shadow).length,2,shadow);
export function nativeCapsuleSource(){return program;}
export function assertCreationGeometry(receipt){
  assert.equal(receipt.counts.creates,1,'exactly one creation');
  assert.equal(receipt.counts.bounds,1,'exactly one pbnd');
  assert.deepEqual([receipt.physical.windowId,receipt.physical.tabId,receipt.physical.cgWindow],[2,9,20],'exact created identity');
  assert.equal(receipt.session.begun,false,'creation remains before first begin');
  // NAT-RETRY r3: the actual Session dispatch opens the request's MCP call on the Owner; run() then records the write.
  assert.equal(receipt.session.nativeCall,'call-A');assert.equal(receipt.session.mutationRequested,true);
  if(receipt.scenario==='healthy'){
    // r3b: the restore reached Owner.run (refused there only by operation dedup), and kept the open call.
    assert.equal(receipt.session.restoreProbe.error,'native_request_invalid',JSON.stringify(receipt.session.restoreProbe));
    assert.equal(receipt.session.restoreProbe.stage,'native_dispatch');
    assert.equal(receipt.session.restoreProbe.callAfter,'call-A','a restore request never opens a new call');
    assert.equal(receipt.session.epoch,1,'original healthy epoch');
    assert.equal(receipt.session.holding,true);
    assert.equal(receipt.result.ok,true,'actual bounds-update control succeeds');
    assert.equal(receipt.counts.url,1);
    assert.deepEqual(receipt.physical.bounds,[0,40,1000,700]);
  }else{
    assert.deepEqual(receipt.physical.bounds,[-300,60,1000,700],'ignored pbnd preserves both physical records');
    assert.equal(receipt.counts.url,0,'SEMANTIC_RED: accepted uncontained bounds must refuse before destination URL');
    assert.equal(receipt.result.ok,false);
    assert.equal(receipt.result.partial,true);
    assert.equal(receipt.result.creationAttempted,true);
    assert.equal(receipt.result.inputDelivery,'unknown');
    assert.equal(receipt.result.noRetry,true);
    assert.equal(receipt.session.epoch,2,'existing uncertainty revokes the original epoch');
    assert.equal(receipt.session.nativeRevoked,true);
    assert.equal(receipt.session.nativeUncertain,true);
  }
}
export function compileNativeCapsule(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-visibility-inert-'));
  const swift=path.join(dir,'capsule.swift'),binary=path.join(dir,'capsule'),cache=path.join(dir,'cache');fs.writeFileSync(swift,program,{flag:'wx'});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({driver:fileSha(DRIVER),native:SOURCE_SHA,helper:HELPER_SHA,blocks:Object.fromEntries([...blocks,...helperBlocks].map(([k,v])=>[k,sha(v)]))},null,2));
  function invoke(exe,args,label){
    const compilerArgs=[swift,'-module-cache-path',cache,'-o',binary];
    assert.ok((exe==='/usr/bin/swiftc'&&args.length===compilerArgs.length&&args.every((arg,i)=>arg===compilerArgs[i]))||(exe===binary&&args.length===1&&['healthy','ignored'].includes(args[0])),'inert invocation allowlist');
    const r=spawnSync(exe,args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,cwd:dir});
    fs.writeFileSync(path.join(dir,label+'.json'),JSON.stringify({argv:[exe,...args],status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2));
    assert.ok(!r.error&&!r.signal&&r.status===0,`FIXTURE_SETUP_OR_EXECUTION_FAILURE ${label}: ${dir}\n${r.stdout}\n${r.stderr}`);return r;
  }
  invoke('/usr/bin/swiftc',[swift,'-module-cache-path',cache,'-o',binary],'compile');
  return {dir,run(scenario){const r=invoke(binary,[scenario],scenario);return JSON.parse(r.stdout);}};
}

// A second driver uses the same actual methods and inert effect seams. It leaves the
// original creation physical model and corrected RED/GREEN oracle byte-for-byte intact.
const behaviorModel = String.raw`
struct BehaviorWindow {
    let id:Int;var tabs:[Int],active:Int,cg:Int,rect:CGRect,cgRect:CGRect,minimized:Bool,onScreen:Bool,urls:[Int:String]
}
final class BehaviorModel {
    let config:[String:Any]
    let full=CGRect(x:0,y:0,width:1200,height:900)
    var windows:[Int:BehaviorWindow]=[:],clock:Double=0,front:pid_t=42,top=20,cursor=CGPoint(x:100,y:100)
    var snapshots=0,cgReads=0,displayReads=0,ownerCount=0,creates=0,boundsWrites=0,urlWrites=0
    var nativeEffects:[String]=[],effects:[[String:Any]]=[],input:[[String:Any]]=[],moves:[CGPoint]=[]
    var stageCounts:[String:Int]=[:],lastStage="",stopInjected=false,focusedCG=20,postBoundsCGReads=0
    // NAT-RETRY2: snapshots counted after the first effect of kind flipAfterEffect ("" = from the start), and one clock jump.
    var flipSeen=0,flipped=0,jumped=false
    // FOCUS1: AX focused-window reads (only focus() makes them here) and the clock at the app activation write.
    var focusReads=0,appAt:Double?=nil
    // FOCUS1 r2: the world one focus sample sees ("focusWorld", per sample, last repeats), a slow final
    // verification ("slowSnapshotAfterApp" s, once) and slow focus calls ("focusAXCost"/"focusCGCost" s per call).
    var sampleWorld:[String:Any]=[:],slowed=false
    var modifiersHeld:Bool{config["modifiersHeld"] as? Bool == true}
    init(_ value:[String:Any]) {
        config=value;popupOpen=value["popup"] != nil
        cursor=point(value["cursor"],fallback:cursor)
        front=pid_t(value["front"] as? Int ?? 42);top=value["top"] as? Int ?? 20
        let old=CGRect(x:100,y:100,width:600,height:500)
        windows[1]=BehaviorWindow(id:1,tabs:[5],active:5,cg:10,rect:old,cgRect:old,minimized:false,onScreen:true,urls:[5:"about:blank#old"])
        if value["creation"] as? Bool != true {
            let initial=rect(value["initialBounds"],fallback:CGRect(x:-300,y:60,width:1000,height:700))
            windows[2]=BehaviorWindow(id:2,tabs:[8,9],active:value["activeTab"] as? Int ?? 9,cg:20,rect:initial,cgRect:initial,
                minimized:value["minimized"] as? Bool == true,onScreen:value["onScreen"] as? Bool ?? true,urls:[8:"about:blank#other",9:"https://target.invalid/"])
        }
    }
    func rect(_ raw:Any?,fallback:CGRect)->CGRect {
        guard let a=raw as? [Double],a.count==4 else{return fallback}
        return CGRect(x:a[0],y:a[1],width:a[2],height:a[3])
    }
    func point(_ raw:Any?,fallback:CGPoint)->CGPoint {
        guard let a=raw as? [Double],a.count==2 else{return fallback};return CGPoint(x:a[0],y:a[1])
    }
    func ownerCreated(){ownerCount += 1}
    func checkpoint(_ session:Session,_ stage:String) {
        lastStage=stage;stageCounts[stage,default:0] += 1
        // NAT-RETRY2: time passes after a re-read's two snapshots, before its final binding check.
        if let at=config["jumpAtFlipSeen"] as? Int,!jumped,stage=="native_binding",flipSeen==at {jumped=true;clock += 5}
        if config["changeSessionAtRefresh"] as? Bool == true && stage=="native_geometry_refresh" {session.window=999}
        let requestedStage=config["stopStage"] as? String
        let afterBounds=config["stopAfterBounds"] as? Bool == true && boundsWrites>0
        guard !stopInjected,(afterBounds || (requestedStage==stage && stageCounts[stage]==(config["stopOccurrence"] as? Int ?? 1))) else{return}
        stopInjected=true
        switch config["stopKind"] as? String ?? "aborted" {
        case "aborted":session.aborted=true
        case "interrupted":session.interrupted="synthetic human input"
        case "eof":session.eof=true
        case "end":session.pendingEnd=["op":"end"]
        case "epoch":session.revokeNativeState()
        case "hold":session.holding=false
        case "pause":session.nativePaused=true
        default:fatalError("FIXTURE_EXCLUDED_PATH: invalid Stop input")
        }
    }
    func displaySamples()->([ChromeNative.WindowDisplayRecord],[ChromeNative.WindowScreenRecord]) {
        displayReads += 1;precondition(displayReads<128)
        if let at=config["cursorAfterDisplaySample"] as? Int,displayReads==at {cursor=point(config["changedCursor"],fallback:CGPoint(x:110,y:100))}
        var raw=config["displays"] as? [[String:Any]] ?? [["id":1,"full":[0.0,0.0,1200.0,900.0],"frame":[0.0,0.0,1200.0,900.0],"visible":[0.0,40.0,1200.0,830.0],"main":true]]
        if let at=config["displayChangeAtSample"] as? Int,displayReads>=at,let changed=config["changedDisplays"] as? [[String:Any]] {raw=changed}
        let selected=(config["displayLossAfterBounds"] as? Bool == true && boundsWrites>0)
        let records=raw.map { d in ChromeNative.WindowDisplayRecord(id:selected ? 2:(d["id"] as? Int ?? 0),full:rect(d["full"],fallback:full),awake:d["awake"] as? Bool ?? true,mirrored:d["mirrored"] as? Bool ?? false,main:d["main"] as? Bool ?? false) }
        let screens=raw.filter{$0["unmatched"] as? Bool != true}.map { d in ChromeNative.WindowScreenRecord(id:selected ? 2:(d["id"] as? Int ?? 0),frame:rect(d["frame"],fallback:full),visible:rect(d["visible"],fallback:full),safeTop:(d["safeTop"] as? NSNumber)?.doubleValue ?? 0) }
        return (records,screens)
    }
    func snapshot(_ pid:pid_t)->[ChromeNative.WindowRow] {
        precondition(pid==42 && snapshots<128);snapshots += 1
        if let d=config["slowSnapshotAfterApp"] as? Double,appAt != nil,!slowed {slowed=true;clock += d}
        if snapshots==(config["mutateAtSnapshot"] as? Int),var w=windows[2] {
            let changed=rect(config["mutatedBounds"],fallback:CGRect(x:100,y:60,width:1000,height:700));w.rect=changed;w.cgRect=changed;windows[2]=w
        }
        // NAT-RETRY2: a window-list index that differs in the listed snapshots only (transient), or in every
        // second one (each verify's post-AX snapshot: persistent). No effect, write or ledger entry is involved.
        var flip=false
        if let kind=config["flipAfterEffect"] as? String,kind.isEmpty || effects.contains(where:{$0["kind"] as? String==kind}) {
            flipSeen += 1
            flip=(config["flipSnapshots"] as? [Int] ?? []).contains(flipSeen) || (config["flipPersistent"] as? Bool == true && flipSeen % 2 == 0)
            if flip {flipped += 1}
        }
        return windows.keys.sorted().map { id in let w=windows[id]!;return ChromeNative.WindowRow(id:id,tabs:w.tabs,activeTab:w.active,index:id==2 ? (flip ? 3:1):2,bounds:w.rect,minimized:w.minimized,title:"Synthetic \(id)",tabURLs:w.urls) }
    }
    func cgRows(options:[CGOption])->[[String:Any]] {
        precondition(cgReads<128);cgReads += 1
        if boundsWrites>0 {postBoundsCGReads += 1}
        let rows=chromeCGRows(options)
        // Only focus() asks for .excludeDesktopElements here: apply the sampled world to its CG order.
        guard options.contains(.excludeDesktopElements) else {return rows}
        clock += config["focusCGCost"] as? Double ?? 0
        var ordered=rows
        if sampleWorld["chromeAbove"] as? Bool == true,let i=ordered.firstIndex(where:{$0[kCGWindowNumber] as? Int==10}) {ordered.insert(ordered.remove(at:i),at:0)}
        // PERM1: an open Chrome popup (window 50, layer 0) is the frontmost Chrome window in every focus sample.
        if popupOpen {ordered.insert([kCGWindowOwnerPID:42,kCGWindowLayer:0,kCGWindowNumber:popupNumber,kCGWindowBounds:popupRect.dictionaryRepresentation as NSDictionary,kCGWindowIsOnscreen:true],at:0)}
        if sampleWorld["blocker"] as? Bool == true,let w=windows[2] {
            ordered.insert([kCGWindowOwnerPID:77,kCGWindowLayer:0,kCGWindowNumber:77,kCGWindowBounds:w.cgRect.dictionaryRepresentation as NSDictionary,kCGWindowIsOnscreen:true,
                            kCGWindowOwnerName as String:"Other App",kCGWindowAlpha as String:1.0],at:0)
        }
        return ordered
    }
    func chromeCGRows(_ options:[CGOption])->[[String:Any]] {
        return windows.keys.sorted(by:>).compactMap { id in
            let w=windows[id]!
            if options.contains(.optionOnScreenOnly) && !w.onScreen{return nil}
            if id==2 && boundsWrites>0 && (config["missingCGAfterBounds"] as? Bool == true || (config["missingCGOnceAfterBounds"] as? Bool == true && postBoundsCGReads==1)){return nil}
            let number=id==2 && boundsWrites>0 && config["wrongCGAfterBounds"] as? Bool == true ? 30:w.cg
            return [kCGWindowOwnerPID:42,kCGWindowLayer:0,kCGWindowNumber:number,kCGWindowBounds:w.cgRect.dictionaryRepresentation as NSDictionary,kCGWindowIsOnscreen:w.onScreen]
        }
    }
    // FOCUS4: "axEmpty" = this Chrome's AX window list is empty (field 11-04), "axFocusMissing" = no AX focused window.
    func axRows()->[AXElement]{if config["axEmpty"] as? Bool == true {return []};return windows.keys.sorted().map{id in let w=windows[id]!;return AXElement(number:w.cg,title:"Synthetic \(id)",minimized:w.minimized,rect:w.cgRect)}}
    func focusedElement()->AXElement?{
        focusReads += 1;clock += config["focusAXCost"] as? Double ?? 0
        if let world=config["focusWorld"] as? [[String:Any]],!world.isEmpty {
            sampleWorld=world[min(focusReads,world.count)-1];front=pid_t(sampleWorld["front"] as? Int ?? 42)
        }
        if appleFront {front=42}
        if config["axFocusMissing"] as? Bool == true {return nil}
        // FOCUS1: "keySamples" gives the AX key window per read (false = the other Chrome window); the last value repeats.
        var cg=focusedCG
        if let samples=config["keySamples"] as? [Bool],!samples.isEmpty,!samples[min(focusReads,samples.count)-1] {cg=10}
        guard let w=windows.values.first(where:{$0.cg==cg}) else{return nil};return AXElement(number:w.cg,title:"Synthetic \(w.id)",minimized:w.minimized,rect:w.cgRect)
    }
    func axEffect(_ e:AXElement,_ k:String)->AXError {
        effects.append(["stage":lastStage,"kind":k,"cgWindow":e.number]);nativeEffects.append(k)
        if k==kAXPressAction {return popupPress(e)}
        if k==kAXMainAttribute && config["wrongFocus"] as? Bool != true {focusedCG=e.number}
        if let stage=config["changeBoundsAfterStage"] as? String,stage==lastStage,var w=windows[2] {
            let changed=rect(config["laterBounds"],fallback:full);w.rect=changed;w.cgRect=changed;windows[2]=w
        }
        return config["unknownStage"] as? String == lastStage ? .cannotComplete:.success
    }
    func activateApp(_ pid:pid_t)->Bool{effects.append(["stage":lastStage,"kind":"app","pid":Int(pid)]);appAt=appAt ?? clock;front=pid;return config["unknownStage"] as? String != lastStage}
    // PERM1: "popup" = a Chrome popup (CG window 50) above the target: {labels, rect, subrole, role ("none" = AX-invisible),
    // modal, inSheet, known, fields, bound, attached (AXParent names the target), closes (default true), pressFails, notPressable, replacedAtRecheck (the window
    // above changes number on the second read), elementChangedAtRecheck (the buttons are new elements on the second read)}.
    var popupOpen=false,popupAboveReads=0,popupShapeReads=0,popupPresses=0,popupButtons:[AXElement]=[]
    var popupConfig:[String:Any]{config["popup"] as? [String:Any] ?? [:]}
    var popupNumber:Int{popupConfig["replacedAtRecheck"] as? Bool == true && popupAboveReads>=2 ? 51:50}
    var popupRect:CGRect{rect(popupConfig["rect"],fallback:CGRect(x:300,y:80,width:320,height:160))}
    func popupAbove(_ cg:Int)->ChromeNative.Popup.Above?{
        popupAboveReads += 1
        guard popupOpen,cg==20,let w=windows[2] else{return nil}
        return ChromeNative.Popup.Above(number:popupNumber,rect:popupRect,target:w.cgRect,bound:popupConfig["bound"] as? Bool ?? true,targetNumber:20)
    }
    func popupShape(_ n:Int)->ChromeNative.Popup.Shape{
        popupShapeReads += 1
        var s=ChromeNative.Popup.Shape()
        guard popupOpen,n==popupNumber else{return s}
        s.ownerIsChrome=true;s.layer=0;s.onScreen=true;s.rect=popupRect
        let role=popupConfig["role"] as? String ?? "AXWindow"
        if role=="none" {return s}
        s.role=role;s.subrole=popupConfig["subrole"] as? String ?? "AXUnknown";s.modal=popupConfig["modal"] as? Bool ?? false
        s.inSheet=popupConfig["inSheet"] as? Bool == true;s.known=popupConfig["known"] as? String;s.fields=popupConfig["fields"] as? Int ?? 0
        if popupConfig["attached"] as? Bool == true {s.parentWindow=20}   // r1 A1: AXParent/AXWindow names the target
        let labels=popupConfig["labels"] as? [String] ?? []
        if popupButtons.count != labels.count || (popupConfig["elementChangedAtRecheck"] as? Bool == true && popupShapeReads==2) {
            popupButtons=labels.indices.map{AXElement(number:500+$0+popupShapeReads*10,title:"button",minimized:false,rect:nil)}
        }
        s.labels=labels;s.enabled=labels.map{_ in true};s.elements=popupButtons
        return s
    }
    func popupPressable(_ e:AXElement)->Bool{popupConfig["notPressable"] as? Bool != true}
    func popupPress(_ e:AXElement)->AXError{
        popupPresses += 1
        if popupConfig["pressFails"] as? Bool == true {return .cannotComplete}
        if popupConfig["closes"] as? Bool ?? true {popupOpen=false}
        return .success
    }
    // FOCUS4 amendment A: Chrome's activate Apple Event; "appleFails" = macOS leaves the other app in front anyway.
    var appleFront=false,appleSent=false
    func appleActivate(_ pid:Int){appleSent=true;effects.append(["stage":lastStage,"kind":"apple","pid":pid]);if config["appleFails"] as? Bool != true {appleFront=true;front=pid_t(pid)}}
    // FOCUS4 r1 A3: "failCGAfterApple" = the focus sample after the Apple Event cannot read the window list (native_focus_unknown).
    func cgRowsRead(options:[CGOption])->[[String:Any]]?{
        if config["failCGAfterApple"] as? Bool == true && appleSent && options.contains(.excludeDesktopElements) {return nil}
        return cgRows(options:options)
    }
    func launch(_ argv:[String])throws {
        precondition(creates==0 && windows[2]==nil && argv.count==3 && argv[0]=="--profile-directory=Profile 3" && argv[1]=="--new-window")
        creates += 1;let b=rect(config["initialBounds"],fallback:CGRect(x:-300,y:60,width:1000,height:700))
        windows[2]=BehaviorWindow(id:2,tabs:[9],active:9,cg:20,rect:b,cgRect:b,minimized:false,onScreen:true,urls:[9:argv[2]])
        effects.append(["stage":lastStage,"kind":"create","windowId":2])
    }
    func createEvent(_ e:NSAppleEventDescriptor)->NSAppleEventDescriptor {
        let code=ChromeNative.Owner.code
        precondition(creates==0 && windows[2]==nil && e.processID==42 && e.eventID==code("crel"))
        precondition(e.fields[0]?.typeCodeValue==code("core") && e.fields[code("kocl")]?.typeCodeValue==code("cwin") && Set(e.fields.keys)==Set([0,code("kocl")]))
        creates += 1;let b=rect(config["initialBounds"],fallback:CGRect(x:-300,y:60,width:1000,height:700))
        windows[2]=BehaviorWindow(id:2,tabs:[9],active:9,cg:20,rect:b,cgRect:b,minimized:false,onScreen:true,urls:[9:"about:blank"])
        effects.append(["stage":lastStage,"kind":"create","windowId":2,"transport":"crel"])
        let reply=NSAppleEventDescriptor(),result=NSAppleEventDescriptor(),form=NSAppleEventDescriptor()
        result.descriptorType=typeObjectSpecifier;form.enumCodeValue=code("ID  ")
        result.fields[code("want")]=NSAppleEventDescriptor(typeCode:code("cwin"));result.fields[code("form")]=form
        if config["malformedCreateReceipt"] as? Bool != true {result.fields[code("from")]=NSAppleEventDescriptor()}
        result.fields[code("seld")]=NSAppleEventDescriptor(string:"2");reply.fields[code("----")]=result
        return reply
    }
    func apply(_ d:NSAppleEventDescriptor)throws {
        let code=ChromeNative.Owner.code
        precondition(d.processID==42 && d.eventID==code("setd"))
        guard let p=d.fields[code("----")],let payload=d.fields[code("data")],let direct=p.container else{fatalError("FIXTURE_EXCLUDED_PATH: descriptor")}
        let id=direct.objectType=="CrTb" ? direct.container?.objectID:direct.objectID
        guard id==2,var w=windows[2] else{fatalError("FIXTURE_EXCLUDED_PATH: foreign primitive")}
        switch p.propertyCode {
        case code("pbnd"):
            guard let b=payload.rect,direct.objectType=="cwin" else{fatalError("FIXTURE_EXCLUDED_PATH: pbnd shape")}
            boundsWrites += 1;precondition(boundsWrites<=8)
            effects.append(["stage":lastStage,"kind":"pbnd","windowId":2,"cgWindow":w.cg,"rect":[b.minX,b.minY,b.width,b.height]])
            let effect=config["boundsEffect"] as? String ?? "update"
            let actual=effect=="clamp" ? rect(config["clampedBounds"],fallback:b):b
            if effect != "ignored" && effect != "cg-only" {w.rect=actual}
            if effect != "ignored" && effect != "row-only" {w.cgRect=actual}
            if effect != "ignored" {w.onScreen=true}
        case code("pmnd"):
            precondition(direct.objectType=="cwin");w.minimized=payload.int32Value != 0;w.onScreen=true;effects.append(["stage":lastStage,"kind":"unminimize","windowId":2])
        case code("pidx"):
            precondition(direct.objectType=="cwin" && payload.int32Value==1);effects.append(["stage":lastStage,"kind":"index","windowId":2])
        case code("acTI"):
            let i=Int(payload.int32Value)-1;precondition(w.tabs.indices.contains(i));w.active=w.tabs[i];effects.append(["stage":lastStage,"kind":"select","tabId":w.active])
        case code("URL "):
            precondition(direct.objectType=="CrTb" && direct.objectID==9);urlWrites += 1;w.urls[9]=payload.stringValue;effects.append(["stage":lastStage,"kind":"url","windowId":2,"tabId":9])
        default:fatalError("FIXTURE_EXCLUDED_PATH: property")
        }
        windows[2]=w
        if config["unknownStage"] as? String == lastStage {throw NSError(domain:"inert-native",code:-1712)}
    }
    func postMove(_ p:CGPoint){precondition(moves.count<10000);moves.append(p);let offset=point(config["terminalOffset"],fallback:.zero);cursor=CGPoint(x:p.x+offset.x,y:p.y+offset.y)}
    func postButton(_ down:Bool,_ p:CGPoint,_ clicks:Int){input.append(["kind":down ? "down":"up","point":[p.x,p.y],"clicks":clicks])}
    func postWheel(_ delta:Int32,_ p:CGPoint){input.append(["kind":"wheel","point":[p.x,p.y],"delta":Int(delta)])}
    func physical()->[[String:Any]]{windows.keys.sorted().map{id in let w=windows[id]!;return ["windowId":id,"cgWindow":w.cg,"bounds":[w.rect.minX,w.rect.minY,w.rect.width,w.rect.height],"cgBounds":[w.cgRect.minX,w.cgRect.minY,w.cgRect.width,w.cgRect.height],"minimized":w.minimized]}}
}
`;
const behaviorDriver = String.raw`
precondition(CommandLine.arguments.count==2)
let fixture=try JSONSerialization.jsonObject(with:Data(CommandLine.arguments[1].utf8)) as! [String:Any]
let model=BehaviorModel(fixture),session=Session()
let initial=model.windows[2]?.rect ?? CGRect.null
let begun=fixture["begun"] as? Bool ?? true
session.begun=begun;session.takeover=fixture["takeover"] as? Bool ?? true;session.holding=fixture["holding"] as? Bool ?? true
if begun {session.chromePid=42;session.window=20;session.windowBounds=initial;session.veil=InertVeil()}
var bind:[String:Any]=[:]
if fixture["creation"] as? Bool != true && fixture["skipBind"] as? Bool != true {
    session.handle(["op":"bindNativeTarget","schema":1,"epoch":1,"target":["chromePid":42,"windowId":2,"tabId":9,"cgWindow":20]])
    bind=session.lastReply;precondition(bind["ok"] as? Bool == true,"FIXTURE_SETUP: exact bind failed")
}
let ownerBefore=session.nativeOwner
let requests=fixture["requests"] as! [[String:Any]]
precondition(!requests.isEmpty && requests.count<=8)
var replies:[[String:Any]]=[]
for request in requests {
    precondition(["nativeChrome","click","move","wheel"].contains(request["op"] as? String ?? ""))
    session.handle(request);replies.append(session.lastReply)
}
func boundsJSON(_ r:CGRect)->Any{r.isNull ? NSNull():[r.minX,r.minY,r.width,r.height] as Any}
let result:[String:Any]=["name":fixture["name"] ?? "fixture","replies":replies,"focusReads":model.focusReads,"appAt":model.appAt ?? NSNull(),"clock":model.clock,"bind":bind,"physical":model.physical(),"effects":model.effects,"input":model.input,"movePoints":model.moves.count,
    "counts":["creates":model.creates,"bounds":model.boundsWrites,"url":model.urlWrites,"snapshots":model.snapshots,"cg":model.cgReads,"display":model.displayReads,"owners":model.ownerCount,"postBoundsCG":model.postBoundsCGReads,"flipped":model.flipped],
    "cursor":[model.cursor.x,model.cursor.y],"lastMove":model.moves.last.map{[$0.x,$0.y] as Any} ?? NSNull(),"front":Int(model.front),"session":["begun":session.begun,"holding":session.holding,"epoch":session.nativeEpoch,"revoked":session.nativeRevoked,"uncertain":session.nativeUncertain,"window":session.window,"bounds":boundsJSON(session.windowBounds),"veilHoles":session.veil?.holes.map{[$0.minX,$0.minY,$0.width,$0.height]} ?? [],"sameOwner":ownerBefore == nil || ownerBefore === session.nativeOwner],
    "stages":session.stages,"scope":["actualOwnerRunExecuteFocus":true,"actualSessionHandleNativeGatesRefresh":true,"actualPlanMoveRunMoveClickMoveWheel":true,"actualSessionConstructorHoldBeginExecuted":false,"realNativeEffects":false]]
print(String(data:try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!)
`;
const behaviorStart=program.indexOf('precondition(CommandLine.arguments.count==2 && ["healthy","ignored"]');
assert.ok(behaviorStart>0);
const behaviorProgram=program.slice(0,behaviorStart)+behaviorModel+behaviorDriver;
for(const [name,value] of [...blocks,...helperBlocks,...movementGlobals]) assert.equal(behaviorProgram.split(value).length,2,`Expanded exact source bytes once: ${name}`);
for(const pattern of [/@_silgen_name/,/\b(?:NSAppleScript|SBApplication|ReadRunner|NSLock|NSMachPort|CGEventTapCreate)\b/,/\bFoundation\.(?:Process|ProcessInfo|Thread|FileHandle)/,/\bCoreGraphics\.(?:CGWindow|CGEvent)/,/\b(?:sleep|usleep|nanosleep|kill|posix_spawn|system)\s*\(/]) assert.doesNotMatch(behaviorProgram,pattern);
assert.deepEqual([...behaviorProgram.matchAll(/^import (\w+)/gm)].map(m=>m[1]),['Foundation','CoreFoundation','CoreGraphics']);
const geometryMutants={
  'strict-boolean':{source:'geometryIntent',testCase:'malformed-fit-1',before:'CFGetTypeID(n) == CFBooleanGetTypeID()',after:'true'},
  'ordinary-containment':{source:'geometryPostcondition',testCase:'ignored-fit-current-postcondition',before:'guard geometryContains(display.usable, row), geometryContains(display.usable, cg),',after:'guard true,'},
  'selected-display-pinned':{source:'geometryPostcondition',testCase:'selected-loss-after-write',before:'displays.valid.first(where: { $0.id == plan.display.id })',after:'displays.valid.first'},
  'explicit-placement-match':{source:'geometryPostcondition',testCase:'ignored-contained-placement',before:'plan.mode != "placement" || (sameRect(row, plan.fitted) && sameRect(cg, plan.fitted))',after:'true'},
  'full-frame-no-write':{source:'geometryPlan',testCase:'full-frame-no-write',before:'if let full {',after:'if false, let full {'},
  'full-frame-final-branch':{source:'geometryPostcondition',testCase:'full-frame-no-write',before:'if plan.branch == "full-frame" {',after:'if false {'},
  'inward-usable-rounding':{source:'geometryUsableRect',testCase:'inward-display-edges',before:'let left = ceil(c.minX + (u.minX - f.minX)), upper = ceil(c.minY + (f.maxY - u.maxY))',after:'let left = floor(c.minX + (u.minX - f.minX)), upper = floor(c.minY + (f.maxY - u.maxY))'},
  'prewrite-bounds-gate':{source:'Owner.applyWindowGeometry',testCase:'pre-pbnd-bounds-changed',before:'observe: observe, expectedBounds: plan.before)',after:'observe: observe, expectedBounds: nil)'},
  'accepted-geometry-checkpoint':{source:'Owner.verifyWindowGeometry',testCase:'ordinary-later-contained-position',before:'ChromeNative.sameRect(current.bounds, accepted.row), ChromeNative.sameRect(cg, accepted.cg)',after:'true'},
  'final-session-refresh-gate':{source:'refreshNativeGeometry',helper:true,testCase:'stop-final-refresh',before:'try checkNative("native_geometry_refresh")\n        windowBounds = bounds',after:'windowBounds = bounds'},
  'sampled-landing-before-post':{source:'guardLanding',helper:true,testCase:'unreachable-sampled-before-post',before:'guard displays.valid.contains(where: { p.x >= $0.usable.minX && p.x < $0.usable.maxX &&\n            p.y >= $0.usable.minY && p.y < $0.usable.maxY }) else { throw Halt.guardFailed("landing_unreachable") }',after:'guard true else { throw Halt.guardFailed("landing_unreachable") }'},
  'actual-terminal-cursor':{source:'opMove',helper:true,testCase:'sampled-terminal-cursor',before:'if dist(actual, plan.landing) > 1.5 { throw Halt.guardFailed("cursor_moved") }',after:'if false { throw Halt.guardFailed("cursor_moved") }'}
};
function behaviorVariant(name){
  if(name===null)return {program:behaviorProgram,mutation:null};
  if(name.startsWith('focus:')){
    const spec=focusMutants[name.slice(6)];assert.ok(spec,'only named FOCUS1 mutations');
    const original=blocks.get(spec.source),changed=replaceOnce(original,spec.before,spec.after,`unique FOCUS1 edit ${name}`);
    return {program:replaceOnce(behaviorProgram,original,changed,`unique FOCUS1 block ${name}`),mutation:{name,source:spec.source,testCase:spec.case,original:sha(original),changed:sha(changed)}};
  }
  if(name.startsWith('reread:')){
    const spec=rereadMutants[name.slice(7)];assert.ok(spec,'only named NAT-RETRY2 mutations');
    const owner=spec.before.startsWith('guard') || spec.before.startsWith('if let late')?'Owner.verifyAfterWrite':'Owner.execute',original=blocks.get(owner);
    const changed=replaceOnce(original,spec.before,spec.after,`unique NAT-RETRY2 edit ${name}`);
    return {program:replaceOnce(behaviorProgram,original,changed,`unique NAT-RETRY2 block ${name}`),mutation:{name,source:owner,testCase:spec.case,original:sha(original),changed:sha(changed)}};
  }
  assert.ok(Object.hasOwn(geometryMutants,name),'only named semantic mutations');
  const spec=geometryMutants[name],original=(spec.helper?helperBlocks:blocks).get(spec.source);
  assert.ok(original);const changed=replaceOnce(original,spec.before,spec.after,`unique semantic edit ${name}`);
  return {program:replaceOnce(behaviorProgram,original,changed,`unique actual block mutation ${name}`),mutation:{name,source:spec.source,testCase:spec.testCase,before:spec.before,after:spec.after,original:sha(original),changed:sha(changed)}};
}
export function runNativeGeometryMutants(baseline=compileWindowBehaviorCapsule()){
  const results=[];
  for(const [name,spec] of Object.entries(geometryMutants)){
    runWindowGeometryMatrix(baseline,{only:spec.testCase});
    const mutant=compileWindowBehaviorCapsule(name);let failure;
    try{runWindowGeometryMatrix(mutant,{only:spec.testCase});}catch(e){failure=e;}
    const killed=failure?.code==='ERR_ASSERTION'&&failure.semanticCase===spec.testCase&&!!failure.semanticReceipt;
    const receipt={name,testCase:spec.testCase,killed,directory:mutant.dir,assertion:failure?.stack,physicalReceipt:failure?.semanticReceipt};
    fs.writeFileSync(path.join(mutant.dir,'semantic-oracle.json'),JSON.stringify(receipt,null,2),{flag:'wx'});
    assert.ok(killed,`SEMANTIC_MUTANT_NOT_KILLED ${name}: ${mutant.dir}\n${failure?.stack??'mutated behavior passed its oracle'}`);
    results.push({name,testCase:spec.testCase,killed,directory:mutant.dir});
  }
  return results;
}

export function compileWindowBehaviorCapsule(mutant=null){
  const variant=behaviorVariant(mutant);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-behavior-inert-')),swift=path.join(dir,'capsule.swift'),binary=path.join(dir,'capsule'),cache=path.join(dir,'cache');
  fs.writeFileSync(swift,variant.program,{flag:'wx'});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({driver:fileSha(DRIVER),native:SOURCE_SHA,helper:HELPER_SHA,program:sha(variant.program),mutation:variant.mutation},null,2));
  let serial=0;
  function invoke(exe,args,label){
    const expected=[swift,'-module-cache-path',cache,'-o',binary];
    assert.ok((exe==='/usr/bin/swiftc'&&args.length===expected.length&&args.every((a,i)=>a===expected[i]))||(exe===binary&&args.length===1&&args[0].length<65536),'Expanded inert invocation allowlist');
    assert.match(label,/^[a-z0-9_-]+$/);
    const r=spawnSync(exe,args,{cwd:dir,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
    const artifact=path.join(dir,`${String(++serial).padStart(3,'0')}-${label}.json`);
    fs.writeFileSync(artifact,JSON.stringify({argv:[exe,...args],status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2),{flag:'wx'});
    assert.ok(!r.error&&!r.signal&&r.status===0,`FIXTURE_SETUP_OR_EXECUTION_FAILURE ${artifact}\n${r.stdout}\n${r.stderr}`);return r;
  }
  invoke('/usr/bin/swiftc',[swift,'-module-cache-path',cache,'-o',binary],'compile');
  return {dir,run(fixture){assert.ok(fixture&&typeof fixture==='object'&&!Array.isArray(fixture));return JSON.parse(invoke(binary,[JSON.stringify(fixture)],fixture.name??'case').stdout);}};
}
// The optional conversation driver changes only the input/output transport of the
// inert driver. Product source blocks and the physical model retain their scope.
function replaceOnce(text, before, after, label){
  assert.equal(text.split(before).length,2,label);return text.replace(before,after);
}
const batchRequestLoop=String.raw`let requests=fixture["requests"] as! [[String:Any]]
precondition(!requests.isEmpty && requests.count<=8)
var replies:[[String:Any]]=[]
for request in requests {
    precondition(["nativeChrome","click","move","wheel"].contains(request["op"] as? String ?? ""))
    session.handle(request);replies.append(session.lastReply)
}`;
const batchPrint='print(String(data:try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!)';
const pipeTail=String.raw`}
func emitReceipt() throws {
    var data=try JSONSerialization.data(withJSONObject:receipt(),options:[.sortedKeys]);data.append(10)
    Foundation.FileHandle.standardOutput.write(data)
}
try emitReceipt()
var requestCount=0
while let line=readLine() {
    precondition(line.utf8.count<=65536 && requestCount<8,"FIXTURE_PROTOCOL: bounded request line")
    let request=try JSONSerialization.jsonObject(with:Data(line.utf8)) as! [String:Any]
    precondition(["nativeChrome","click","move","wheel"].contains(request["op"] as? String ?? ""),"FIXTURE_PROTOCOL: operation")
    requestCount += 1;session.handle(request);replies.append(session.lastReply)
    try emitReceipt()
}`;
let conversationDriver=replaceOnce(behaviorDriver,batchRequestLoop,'var replies:[[String:Any]]=[]','conversation request seam');
conversationDriver=replaceOnce(conversationDriver,'let result:[String:Any]=','func receipt()->[String:Any] { return ','conversation receipt seam');
conversationDriver=replaceOnce(conversationDriver,batchPrint,pipeTail,'conversation output seam');
assert.equal(conversationDriver.split('Foundation.FileHandle.standardOutput.write(data)').length,2);
assert.doesNotMatch(conversationDriver.replace('Foundation.FileHandle.standardOutput.write(data)',''),/Foundation\.|\b(?:Process|NSWorkspace|NSRunningApplication|system|kill|posix_spawn)\b/);
const conversationProgram=program.slice(0,behaviorStart)+behaviorModel+conversationDriver;
for(const [name,value] of [...blocks,...helperBlocks,...movementGlobals])assert.equal(conversationProgram.split(value).length,2,`Conversation exact source bytes once: ${name}`);
assert.deepEqual([...conversationProgram.matchAll(/^import (\w+)/gm)].map(m=>m[1]),['Foundation','CoreFoundation','CoreGraphics']);
export function compileWindowConversationCapsule(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-conversation-inert-')),swift=path.join(dir,'capsule.swift'),binary=path.join(dir,'capsule'),cache=path.join(dir,'cache');
  fs.writeFileSync(swift,conversationProgram,{flag:'wx'});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({driver:fileSha(DRIVER),native:SOURCE_SHA,helper:HELPER_SHA,program:sha(conversationProgram),transport:'owned stdin/stdout only'},null,2),{flag:'wx'});
  const args=[swift,'-module-cache-path',cache,'-o',binary];
  const compiled=spawnSync('/usr/bin/swiftc',args,{cwd:dir,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(dir,'compile.json'),JSON.stringify({argv:['/usr/bin/swiftc',...args],status:compiled.status,signal:compiled.signal,error:compiled.error?.message,stdout:compiled.stdout,stderr:compiled.stderr},null,2),{flag:'wx'});
  assert.ok(!compiled.error&&!compiled.signal&&compiled.status===0,`FIXTURE_SETUP_FAILURE ${dir}\n${compiled.stdout}\n${compiled.stderr}`);
  let serial=0;
  return {dir,async start(fixture){
    assert.ok(fixture&&typeof fixture==='object'&&!Array.isArray(fixture));assert.equal(fixture.requests,undefined,'conversation receives requests only through its pipe');
    const initialJSON=JSON.stringify(fixture);assert.ok(Buffer.byteLength(initialJSON)<65536);
    const runDir=path.join(dir,`run-${String(++serial).padStart(3,'0')}`);fs.mkdirSync(runDir);
    const argv=[binary,initialJSON],child=spawn(binary,[initialJSON],{cwd:dir,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',buffer='',status=null,signal=null,error=null,exited=false,requestCount=0,inFlight=false,pending=null,closing=null;
    const queue=[];
    const persist=()=>fs.writeFileSync(path.join(runDir,'run.json'),JSON.stringify({argv,status,signal,error,exited,stdout,stderr,requestCount},null,2));
    persist();
    let resolveExit;const exitPromise=new Promise(resolve=>{resolveExit=resolve;});
    function fail(reason){error??=String(reason);persist();if(pending){const p=pending;pending=null;p.reject(new Error(error));}}
    function accept(line){
      try{const value=JSON.parse(line);if(pending){const p=pending;pending=null;p.resolve(value);}else queue.push(value);}
      catch(e){fail(`FIXTURE_PROTOCOL: invalid child JSON: ${e.message}`);}
    }
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      stdout+=chunk;fs.appendFileSync(path.join(runDir,'stdout.txt'),chunk);buffer+=chunk;
      if(Buffer.byteLength(stdout)>16*1024*1024){fail('FIXTURE_PROTOCOL: stdout limit');return;}
      let newline;while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);accept(line);}
    });
    child.stderr.on('data',chunk=>{stderr+=chunk;fs.appendFileSync(path.join(runDir,'stderr.txt'),chunk);if(Buffer.byteLength(stderr)>16*1024*1024)fail('FIXTURE_PROTOCOL: stderr limit');});
    child.stdin.on('error',e=>fail(`FIXTURE_PIPE: ${e.message}`));
    child.on('error',e=>fail(`FIXTURE_SPAWN: ${e.message}`));
    child.on('close',(code,sig)=>{status=code;signal=sig;exited=true;if(buffer.length)fail('FIXTURE_PROTOCOL: incomplete final line');if(pending)fail('FIXTURE_PROTOCOL: child exited before response');persist();resolveExit();});
    async function receive(){
      if(error)throw new Error(error);if(queue.length)return queue.shift();assert.ok(!pending&&!exited,'one live response waiter');
      let timer;try{return await new Promise((resolve,reject)=>{pending={resolve,reject};timer=setTimeout(()=>fail('FIXTURE_TIMEOUT: response exceeded 10000 ms'),10000);});}finally{clearTimeout(timer);}
    }
    async function close(){
      if(closing)return closing;
      closing=(async()=>{
        if(!child.stdin.destroyed)child.stdin.end();
        const term=setTimeout(()=>{if(!exited){error??='FIXTURE_TIMEOUT: child did not exit after EOF; owned-child SIGTERM';persist();child.kill('SIGTERM');}},1000);
        let deadline;try{await Promise.race([exitPromise,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('FIXTURE_TIMEOUT: owned child exit not confirmed; no SIGKILL sent')),4000);})]);}
        catch(e){fail(e.message);throw e;}finally{clearTimeout(term);clearTimeout(deadline);persist();}
        assert.ok(exited&&!error&&!signal&&status===0,`FIXTURE_EXECUTION_FAILURE ${runDir}: ${error??`status=${status} signal=${signal}`}`);
        return {dir:runDir,status,signal,requestCount};
      })();return closing;
    }
    let initial;try{initial=await receive();assert.deepEqual(initial.replies,[],'initial receipt follows one bind and no operation');}
    catch(e){try{await close();}catch{}throw e;}
    return {dir:runDir,initial,close,async request(request){
      assert.ok(!inFlight&&!closing&&!exited,'sequential live conversation');assert.ok(requestCount<8,'at most eight requests');
      assert.ok(request&&typeof request==='object'&&!Array.isArray(request));assert.ok(['nativeChrome','click','move','wheel'].includes(request.op));
      const line=JSON.stringify(request);assert.ok(Buffer.byteLength(line)<=65536);inFlight=true;requestCount++;
      fs.appendFileSync(path.join(runDir,'stdin.jsonl'),line+'\n');persist();
      try{child.stdin.write(line+'\n');const receipt=await receive();assert.equal(receipt.replies.length,requestCount,'one actual reply per request');return receipt;}
      catch(e){try{await close();}catch{}throw e;}finally{inFlight=false;}
    }};
  }};
}

const nativeRequest=(intent,id='a',epoch=1)=>({op:'nativeChrome',schema:1,epoch,operationId:id,intent});
const activation={kind:'activate',windowId:2,tabId:9,fitCurrent:true};
const pointerMove={op:'move',to:{x:100,y:100},rect:{x:90,y:90,w:20,h:20}};
const pointerClick={op:'click',aim:{x:100,y:100},rect:{x:90,y:90,w:20,h:20}};
function physicalTarget(r){return r.physical.find(w=>w.windowId===2);}
function assertNoInput(r){assert.deepEqual(r.input,[]);assert.equal(r.movePoints,0);}
export function runWindowBehaviorControls(capsule){
  const results=[];
  function check(fixture,oracle){const r=capsule.run(fixture);oracle(r);results.push({name:fixture.name,replies:r.replies,counts:r.counts});}
  for(const begun of [false,true])check({name:`activate-${begun?'begun':'unbegun'}`,begun,requests:[nativeRequest(activation)]},r=>{
    assert.equal(r.replies[0].ok,true);assert.equal(r.counts.bounds,1);assert.deepEqual(physicalTarget(r).bounds,[0,60,1000,700]);
    assert.deepEqual(physicalTarget(r).cgBounds,[0,60,1000,700]);assert.equal(r.session.epoch,1);assert.equal(r.session.sameOwner,true);assert.equal(r.counts.owners,1);
    assert.deepEqual(r.session.bounds,begun?[0,60,1000,700]:null);assert.deepEqual(r.session.veilHoles,begun?[[0,60,1000,700]]:[]);
  });
  check({name:'retained-fit-no-second-bounds',requests:[nativeRequest(activation),nativeRequest(activation,'b')]},r=>{
    assert.ok(r.replies.every(x=>x.ok===true));assert.equal(r.counts.bounds,1);assert.equal(r.replies[1].geometry.changed,false);assert.equal(r.session.epoch,1);assert.equal(r.counts.owners,1);
  });
  check({name:'ignored-fit-current',boundsEffect:'ignored',requests:[nativeRequest(activation)]},r=>{
    assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'native_geometry_unconfirmed');assert.equal(r.counts.bounds,1);
    assert.deepEqual(r.effects.map(x=>x.kind),['pbnd']);assert.deepEqual(r.session.bounds,[-300,60,1000,700]);assert.deepEqual(r.session.veilHoles,[]);assertNoInput(r);
  });
  check({name:'contained-fit-clamp',boundsEffect:'clamp',clampedBounds:[100,60,900,700],requests:[nativeRequest(activation)]},r=>{
    assert.equal(r.replies[0].ok,true);assert.deepEqual(physicalTarget(r).bounds,[100,60,900,700]);assert.deepEqual(r.session.bounds,[100,60,900,700]);
  });
  check({name:'stop-after-pbnd',stopAfterBounds:true,requests:[nativeRequest(activation)]},r=>{
    assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'aborted');assert.equal(r.counts.bounds,1);assert.deepEqual(r.effects.map(x=>x.kind),['pbnd']);assert.deepEqual(r.session.veilHoles,[]);assertNoInput(r);
  });
  check({name:'stop-before-refresh',stopStage:'native_geometry_refresh',requests:[nativeRequest(activation)]},r=>{
    assert.equal(r.replies[0].error,'aborted');assert.equal(r.counts.bounds,1);assert.deepEqual(r.session.bounds,[-300,60,1000,700]);assert.deepEqual(r.session.veilHoles,[]);assertNoInput(r);
  });
  check({name:'sampled-move-control',initialBounds:[0,40,1000,700],cursor:[200,200],requests:[pointerMove]},r=>{
    assert.equal(r.replies[0].ok,true);assert.equal(r.replies[0].skippedMove,false);assert.ok(r.movePoints>0);assert.deepEqual(r.cursor,r.lastMove,'actual terminal cursor equals final posted point');
    for(const [i,axis] of ['x','y'].entries())assert.ok(Math.abs(r.replies[0].landed[axis]-Math.round(r.lastMove[i]*100)/100)<=1e-10,'public landed uses existing two-decimal pointJSON');
  });
  check({name:'skipped-move-control',initialBounds:[0,40,1000,700],requests:[pointerMove]},r=>{
    assert.equal(r.replies[0].ok,true);assert.equal(r.replies[0].skippedMove,true);assert.equal(r.movePoints,0);assert.deepEqual(r.cursor,[100,100]);
  });
  check({name:'skipped-unreachable-landing',initialBounds:[-300,60,1000,700],cursor:[-100,100],requests:[{op:'move',to:{x:-100,y:100},rect:{x:-110,y:90,w:20,h:20}}]},r=>{
    assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'landing_unreachable');assertNoInput(r);
  });
  check({name:'terminal-cursor-mismatch',initialBounds:[0,40,1000,700],cursor:[200,200],terminalOffset:[10,0],requests:[pointerMove]},r=>{
    assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'cursor_moved');assert.deepEqual(r.input,[]);assert.ok(r.movePoints>0);
  });
  check({name:'cursor-changed-during-display-read',initialBounds:[0,40,1000,700],cursorAfterDisplaySample:2,changedCursor:[110,100],requests:[pointerMove]},r=>{
    assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'cursor_moved');assertNoInput(r);
  });
  check({name:'actual-click-control',initialBounds:[0,40,1000,700],requests:[pointerClick]},r=>{
    assert.equal(r.replies[0].ok,true);assert.deepEqual(r.input.map(x=>x.kind),['down','up']);assert.ok(r.input.every(x=>x.point[0]>=0&&x.point[0]<1200&&x.point[1]>=30&&x.point[1]<860));
  });
  check({name:'background-wheel-control',initialBounds:[0,40,1000,700],front:9,takeover:false,holding:false,requests:[{op:'wheel',notches:2,dir:'down'}]},r=>{
    assert.equal(r.replies[0].ok,true);assert.deepEqual(r.input.map(x=>x.kind),['wheel','wheel']);assert.equal(r.front,9);assert.deepEqual(r.effects,[]);assert.equal(r.counts.bounds,0);
  });
  return results;
}
// NAT-RETRY2: the activation transaction's read-only verification after its sent writes (index, main, raise,
// app) re-reads a transient window-list change; every write stays exactly once and the delivery stays "sent".
// Twin bounds put cgMapping on its AX path, whose second snapshot is where the change is seen (live 11-02).
export function runPostWriteRereads(capsule,{only=null}={}){
  const results=[],twin=[100,100,600,500],writes=['index','main','raise','app'];
  const request={...nativeRequest(activation),call:'call-A'},click={op:'click',aim:{x:300,y:300},rect:{x:290,y:290,w:20,h:20}};
  function check(name,fixture,oracle){
    if(only&&only!==name)return;
    const r=capsule.run({name,initialBounds:twin,requests:[request],...fixture});
    try{oracle(r,r.replies[0]);}catch(e){e.semanticCase=name;e.semanticReceipt=r;throw e;}
    results.push({name,reply:r.replies[0],counts:r.counts});
  }
  const ledger=x=>x.stages.map(st=>[st.stage,st.delivery]);
  let base;
  check('reread-baseline',{},(r,x)=>{base=r;assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.deepEqual(r.effects.map(e=>e.kind),writes);assert.equal(r.counts.flipped,0);});
  for(const [name,after] of [['reread-after-main','main'],['reread-final','app']])check(name,{flipAfterEffect:after,flipSnapshots:[2]},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.equal(r.counts.flipped,1);
    assert.deepEqual(r.effects.map(e=>e.kind),writes,'zero writes after the first: each write once, none re-run');
    assert.deepEqual(ledger(x),ledger(base.replies[0]));assert.equal(r.counts.snapshots,base.counts.snapshots+2,'one re-read: two more snapshots');
    assert.equal(x.keyWindowIsTarget,true);assert.equal(x.targetOnTop,true);assertNoInput(r);
  });
  // The same final verification without a geometry plan (raw activation, as selectTab and moveWindow share it).
  check('reread-final-raw',{flipAfterEffect:'app',flipSnapshots:[2],requests:[{...request,intent:{kind:'activate',windowId:2,tabId:9}}]},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.equal(r.counts.flipped,1);assert.deepEqual(r.effects.map(e=>e.kind),writes);
  });
  check('reread-then-click',{flipAfterEffect:'main',flipSnapshots:[2],requests:[request,click]},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(r.replies[1].ok,true,JSON.stringify(r.replies[1]));
    assert.deepEqual(r.effects.map(e=>e.kind),writes);assert.deepEqual(r.input.map(i=>i.kind),['down','up'],'the click is posted once, after the re-read');
  });
  for(const [name,after,effects] of [['persistent-after-main','main',writes.slice(0,2)],['persistent-final','app',writes]])check(name,{flipAfterEffect:after,flipPersistent:true},(r,x)=>{
    assert.equal(x.ok,false);assert.equal(x.error,'native_target_changed');assert.equal(x.stage,'native_window_binding');
    assert.equal(x.bindingReason,'snapshot_structure_changed');assert.equal(x.inputDelivery,'sent');assert.equal(x.noRetry,true);
    assert.equal(x.verifyRereads,2);assert.equal(r.counts.flipped,3);assert.deepEqual(r.effects.map(e=>e.kind),effects,'no write re-run, none after the refusal');
    assert.deepEqual(r.session.veilHoles,[]);assertNoInput(r);
  });
  check('late-reread',{flipAfterEffect:'main',flipSnapshots:[2],jumpAtFlipSeen:4},(r,x)=>{
    assert.equal(x.ok,false,JSON.stringify(x));assert.equal(x.bindingReason,'snapshot_structure_changed');assert.equal(x.verifyDeadline,true);
    assert.equal(x.verifyRereads,1);assert.equal(x.inputDelivery,'sent');assert.deepEqual(r.effects.map(e=>e.kind),writes.slice(0,2));assertNoInput(r);
  });
  // Kept behaviour: before any write of the transaction (its first verify) a transient change is refused at once, not_sent.
  check('prewrite-unchanged',{flipAfterEffect:'',flipSnapshots:[4]},(r,x)=>{
    assert.equal(x.ok,false);assert.equal(x.bindingReason,'snapshot_structure_changed');assert.equal(x.inputDelivery,'not_sent');
    assert.equal(Object.hasOwn(x,'verifyRereads'),false);assert.equal(r.counts.snapshots,4);assert.deepEqual(r.effects,[]);assertNoInput(r);
  });
  // Kept behaviour: a transaction that sent nothing (selectTab of the active tab) keeps its final verification single.
  check('unsent-final-unchanged',{flipAfterEffect:'',flipSnapshots:[8],requests:[{...request,intent:{kind:'selectTab',windowId:2,tabId:9}}]},(r,x)=>{
    assert.equal(x.ok,false,JSON.stringify(x));assert.equal(x.bindingReason,'snapshot_structure_changed');assert.equal(x.inputDelivery,'not_sent');
    assert.equal(Object.hasOwn(x,'verifyRereads'),false);assert.equal(r.counts.snapshots,8);assert.deepEqual(r.effects,[]);assertNoInput(r);
  });
  return results;
}
const rereadMutants={
  'reread-main-call':{case:'reread-after-main',before:'try verifyAfterWrite(tx) { try verify(t, until: $0) }\n',after:'_ = try verify(t)\n'},
  'reread-final-call':{case:'reread-final',before:'after = try verifyAfterWrite(tx) { try verifyWindowGeometry(t, plan: plan, tx: tx, until: $0) } }',after:'after = try verifyWindowGeometry(t, plan: plan, tx: tx) }'},
  'reread-final-raw-call':{case:'reread-final-raw',before:'else { after = try verifyAfterWrite(tx) { try verify(t, until: $0) } }',after:'else { after = try verify(t) }'},
  'reread-sent-gate':{case:'unsent-final-unchanged',before:'guard tx.delivery == "sent" else',after:'guard true else'},
  'reread-bound':{case:'persistent-final',before:'guard rereads < 2,',after:'guard rereads < 9,'},
  'reread-late':{case:'late-reread',before:'if let late = structural, ProcessInfo.processInfo.systemUptime >= deadline {',after:'if let late = structural, false {'}
};
export function runPostWriteRereadMutants(){
  const out=[];
  for(const [name,spec] of Object.entries(rereadMutants)){
    const capsule=compileWindowBehaviorCapsule('reread:'+name);let failure;
    try{runPostWriteRereads(capsule,{only:spec.case});}catch(e){failure=e;}
    assert.ok(failure?.code==='ERR_ASSERTION'&&failure.semanticCase===spec.case,`REREAD_MUTANT_NOT_KILLED ${name}: ${capsule.dir}`);
    out.push({name,case:spec.case,assertion:failure.message.split('\n')[0].slice(0,160)});
  }
  return out;
}
// FOCUS1: after the activation writes (index, main, raise, app) focus is re-sampled read-only inside one absolute
// window of about 1 s from the app write; the last complete sample is reported. Synthetic per-sample AX key window,
// frontmost app and CG order; every write is counted from the model's effect list; time is the model clock.
// FOCUS4 (contracts-batch4.md): the settle ends at the first sample with the target on top in CG order; the AX key
// window is read as a fact and never waited for, and no sample outcome refuses (only a wrong active tab does). The
// cases that kept the settle open with a non-key AX window now keep it open with another Chrome window above (CG).
export function runFocusSettle(capsule,{only=null}={}){
  const results=[],twin=[100,100,600,500],writes=['index','main','raise','app'];
  const request={...nativeRequest(activation),call:'call-A'},click={op:'click',aim:{x:300,y:300},rect:{x:290,y:290,w:20,h:20}};
  const never=[{chromeAbove:true}];   // Chrome's other window stays above the target: never on top in CG order
  function check(name,fixture,oracle){
    if(only&&only!==name)return;
    const r=capsule.run({name,initialBounds:twin,requests:[request],...fixture});
    try{oracle(r,r.replies[0],r.clock-r.appAt);}catch(e){e.semanticCase=name;e.semanticReceipt=r;throw e;}
    results.push({name,ok:r.replies[0].ok,error:r.replies[0].error??null,focusReads:r.focusReads,focusSamples:r.replies[0].focusSamples??null,elapsedMs:Math.round((r.clock-r.appAt)*1000)});
  }
  const once=r=>assert.deepEqual(r.effects.map(e=>e.kind),writes,'zero extra raise/activate writes: each write exactly once');
  // FOCUS4: the bounded settle that never sees the target on top reports its facts; it is not a refusal.
  const unsettled=(x,elapsed,max)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.equal(x.targetOnTop,false,JSON.stringify(x));
    assert.ok(elapsed<=max,`total activation time bound ${max}: ${elapsed}`);
  };
  // FOCUS4: the AX key window is a fact: the first on-top sample decides, the non-key fact is reported, nothing waits.
  check('focus-settle-late-key',{keySamples:[false,false,true]},(r,x,elapsed)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.equal(x.keyWindowIsTarget,false);assert.equal(x.targetOnTop,true);
    once(r);assert.equal(r.focusReads,1,'the first on-top sample decides; the key window is never waited for');assert.ok(elapsed<0.5,`decided early: ${elapsed}`);assertNoInput(r);
  });
  // Never on top -> the facts at about 1 s, with the last sample's details; nothing re-sent.
  check('focus-settle-never',{focusWorld:never},(r,x,elapsed)=>{
    unsettled(x,elapsed,1.05);assert.ok(elapsed>=0.95,String(elapsed));assert.equal(x.frontmostPid,42);
    assert.deepEqual(x.focusBlocker,{owner:'',pid:42,layer:0,width:600,height:500});assert.ok([r.focusReads,r.focusReads-1].includes(x.focusSamples),'complete samples decide; at most the last one is cut');
    once(r);assert.ok(r.focusReads>3,String(r.focusReads));assertNoInput(r);
  });
  // FOCUS1 (Codex A1): a slow sampler; each sample near the remaining time. The sample that would run past the
  // window is cut at its next probe check (one OS call over at most) and dropped; the previous sample decides.
  for(const [name,ax,cg] of [['focus-settle-slow-ax',0.2,0.2],['focus-settle-slow-cg',0.02,0.38]])check(name,{focusWorld:never,focusAXCost:ax,focusCGCost:cg},(r,x,elapsed)=>{
    unsettled(x,elapsed,1+Math.max(ax,cg)+0.03);
    assert.equal(x.focusSamples,r.focusReads-1,'the cut sample is dropped; the last complete one decides');assert.ok(x.focusSamples>=1);once(r);assertNoInput(r);
  });
  // FOCUS1 (Codex A1): the final verification already used the whole window -> no sample starts; every fact false.
  check('focus-settle-verify-consumed',{slowSnapshotAfterApp:1.2},(r,x,elapsed)=>{
    unsettled(x,elapsed,1.25);assert.equal(r.focusReads,0,'no focus sample starts after the window');assert.equal(x.keyWindowIsTarget,false);assert.equal(x.frontmostPid,0);
    assert.equal(x.focusSamples,0);assert.equal(x.focusSettleExpired,true);once(r);assertNoInput(r);
  });
  // FOCUS1 (Codex B): frontmost and CG order lag, with the blocker changing between samples, then settled.
  check('focus-settle-lag',{focusWorld:[{front:77,blocker:true},{chromeAbove:true},{}]},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.targetOnTop,true);assert.equal(x.keyWindowIsTarget,true);assert.equal(x.frontmostPid,42);
    assert.equal(r.focusReads,3);once(r);assertNoInput(r);
  });
  // Codex B: never settled; the reply names the blocker of the LAST sample (an earlier sample's blocker differs).
  // FOCUS4 amendment A: another app still in front -> one Apple Event activate and one more bounded window (0.7 s);
  // here macOS leaves the other app in front anyway (appleFails), so the facts stay those of the last sample.
  check('focus-settle-lag-never',{focusWorld:[{chromeAbove:true},{front:77,blocker:true}],appleFails:true},(r,x,elapsed)=>{
    unsettled(x,elapsed,1.05+0.75);assert.equal(x.frontmostPid,0);assert.equal(x.focusAppleActivate,true);
    assert.deepEqual(x.focusBlocker,{owner:'Other App',pid:77,layer:0,width:600,height:500});assert.ok(x.focusSamples>=2,String(x.focusSamples));
    assert.deepEqual(r.effects.map(e=>e.kind),[...writes,'apple'],'each write once, the Apple Event once');assertNoInput(r);
  });
  // A settled activation is followed by exactly one click.
  check('focus-settle-then-click',{keySamples:[false,true],requests:[request,click]},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(r.replies[1].ok,true,JSON.stringify(r.replies[1]));once(r);
    assert.deepEqual(r.input.map(i=>i.kind),['down','up'],'the click is posted once, after focus settled');
  });
  // The loop keeps Stop: a stop inside the settle loop ends the call (sent, noRetry), with no write and no input after it.
  check('focus-settle-stop',{focusWorld:never,stopStage:'native_focus_read',stopOccurrence:5},(r,x,elapsed)=>{
    assert.equal(x.ok,false);assert.equal(x.error,'aborted',JSON.stringify(x));assert.equal(x.inputDelivery,'sent');assert.equal(x.noRetry,true);
    once(r);assert.ok(elapsed<0.5,String(elapsed));assertNoInput(r);
  });
  // Kept behaviour: focus already confirmed -> success on one sample, each write once.
  check('focus-settle-baseline',{},(r,x)=>{
    assert.equal(x.ok,true,JSON.stringify(x));assert.equal(x.inputDelivery,'sent');once(r);assert.equal(r.focusReads,1);assertNoInput(r);
    assert.equal(x.keyWindowIsTarget,true);assert.equal(x.axWindowMissing,false);
  });
  return results;
}
const focusMutants={
  'settle-call':{source:'Owner.execute',case:'focus-settle-lag',before:'try settleFocus(t, until: focusSettleUntil ?? 0)',after:'try focus(t)'},
  'settle-deadline':{source:'Owner.execute',case:'focus-settle-never',before:'focusSettleUntil = ProcessInfo.processInfo.systemUptime + 1.0',after:'focusSettleUntil = ProcessInfo.processInfo.systemUptime + 1.5'},
  'settle-unbounded-probe':{source:'Owner.settleFocus',case:'focus-settle-slow-ax',before:'last = try focus(t, until: deadline)',after:'last = try focus(t)'},
  'settle-start-guard':{source:'Owner.settleFocus',case:'focus-settle-verify-consumed',before:'while ProcessInfo.processInfo.systemUptime < deadline {\n                do { last = try focus(t, until: deadline)',after:'while true {\n                do { last = try focus(t)'},
  'settle-cut-rethrow':{source:'Owner.settleFocus',case:'focus-settle-slow-ax',before:'.stage == "native_read_deadline" { break }',after:'.stage == "native_read_deadline" { throw cut }'},
  'focus-cut-surface':{source:'Owner.focus',case:'focus-settle-slow-cg',before:'                try p.check() // a probe cut (deadline, Stop) surfaces as itself, not as an unknown focus\n',after:''},
  'settle-expired-fail-open':{source:'Owner.settleFocus',case:'focus-settle-verify-consumed',before:'last ?? (false, false, 0, ["focusSettleExpired": true])',after:'last ?? (true, true, 42, ["focusSettleExpired": true])'},
  'settle-early-exit':{source:'Owner.settleFocus',case:'focus-settle-late-key',before:'if let sample = last, sample.0 { return sample }',after:'if false, let sample = last { return sample }'},
  'settle-no-rewrite':{source:'Owner.execute',case:'focus-settle-late-key',before:'_ = try awaitFront(t.chromePid,',after:'try activateApp(t.chromePid, stage: "activate_app", tx: tx); _ = try awaitFront(t.chromePid,'}
};
export function runFocusSettleMutants(){
  const out=[];
  for(const [name,spec] of Object.entries(focusMutants)){
    const capsule=compileWindowBehaviorCapsule('focus:'+name);let failure;
    try{runFocusSettle(capsule,{only:spec.case});}catch(e){failure=e;}
    assert.ok(failure?.code==='ERR_ASSERTION'&&failure.semanticCase===spec.case,`FOCUS_MUTANT_NOT_KILLED ${name}: ${capsule.dir}`);
    out.push({name,case:spec.case,assertion:failure.message.split('\n')[0].slice(0,160)});
  }
  return out;
}
export function runWindowGeometryMatrix(cap,{only=null}={}){
const results=[];
const activate={kind:'activate',windowId:2,tabId:9,fitCurrent:true};
const bounds=(a)=>({left:a[0],top:a[1],width:a[2],height:a[3]});
const request=(intent,op='matrix')=>({op:'nativeChrome',schema:1,epoch:1,operationId:op,intent});
const disp=(id,full,frame=full,extra={})=>({id,full,frame,visible:[frame[0],frame[1]+40,frame[2],frame[3]-70],...extra});
const base=disp(1,[0,0,1200,900],undefined,{main:true});
const target=r=>r.physical.find(w=>w.windowId===2);
function run(name,fixture,oracle){
  if(only && only!==name)return;
  const r=cap.run({name,displays:[base],requests:[request(activate)],...fixture});
  try{oracle(r);}catch(e){e.semanticCase=name;e.semanticReceipt=r;throw e;}
  results.push({name,replies:r.replies,counts:r.counts});return r;
}
function success(expected,writes=1){return r=>{assert.equal(r.replies[0].ok,true);assert.deepEqual(target(r).bounds,expected);assert.deepEqual(target(r).cgBounds,expected);assert.equal(r.counts.bounds,writes);assert.equal(r.session.epoch,1);assert.equal(r.counts.owners,1);assert.equal(r.session.sameOwner,true);assert.deepEqual(r.input,[]);};}
function refused(error,effects=[]){return r=>{assert.equal(r.replies[0].ok,false);if(error)assert.equal(r.replies[0].error,error);assert.deepEqual(r.effects.map(x=>x.kind),effects);assert.equal(r.counts.bounds,effects.filter(x=>x==='pbnd').length);assert.deepEqual(r.input,[]);assert.equal(r.movePoints,0);assert.deepEqual(r.session.veilHoles,[]);};}
for(const [name,initial,expected,writes] of [
  ['left',[-40,100,600,400],[0,100,600,400],1],['right',[800,100,600,400],[600,100,600,400],1],
  ['top',[100,-40,600,400],[100,30,600,400],1],['bottom',[100,650,600,400],[100,460,600,400],1],
  ['detached',[1500,1200,400,300],[800,560,400,300],1],['oversized',[-100,-100,1600,1000],[0,30,1200,830],1],
  ['fractional',[-0.4,29.4,600.8,400.9],[0,30,600,400],1],['small-no-enlarge',[100,100,300,200],[100,100,300,200],0]
])run('fit-'+name,{initialBounds:initial},success(expected,writes));
run('negative-left-display',{displays:[base,disp(2,[-1200,0,1200,900])],initialBounds:[-1400,100,600,400]},success([-1200,100,600,400]));
run('above-display',{displays:[base,disp(2,[0,-900,1200,900],[0,900,1200,900])],initialBounds:[100,-1000,600,400]},success([100,-870,600,400]));
run('gap-no-union',{displays:[base,disp(2,[1600,0,1200,900])],initialBounds:[1250,100,200,400]},success([1000,100,200,400]));
run('overlap-main-tie',{displays:[{...base,main:false},disp(2,[1600,0,1200,900],undefined,{main:true})],initialBounds:[1100,100,600,400]},success([1600,100,600,400]));
run('overlap-id-tie',{displays:[{...base,main:false},disp(2,[1600,0,1200,900])],initialBounds:[1100,100,600,400]},success([600,100,600,400]));
run('asymmetric-notch',{displays:[{...base,visible:[40,50,1100,800],safeTop:80}],initialBounds:[0,0,1200,896]},success([40,80,1100,770]));
run('inward-display-edges',{displays:[{...base,visible:[0.2,40.2,1199.6,829.6]}],initialBounds:[-1,29,1200,840]},success([1,31,1198,828]));
run('int16-refusal',{displays:[disp(1,[33000,0,1200,900])],initialBounds:[32900,100,600,400]},refused('native_bounds_invalid'));
run('duplicate-display',{displays:[base,base]},refused('native_display_unavailable'));
run('target-unmatched-display',{displays:[base,disp(2,[1600,0,1200,900],undefined,{unmatched:true})],initialBounds:[1700,100,600,400]},refused('native_display_unavailable'));
run('unrelated-unmatched-valid-target',{displays:[base,disp(2,[1600,0,1200,900],undefined,{unmatched:true})]},success([0,60,1000,700]));
run('unrelated-mirror-valid-target',{displays:[base,disp(2,[1600,0,1200,900],undefined,{mirrored:true})]},success([0,60,1000,700]));
for(const fitCurrent of [0,1,'true',null,[],{}])run('malformed-fit-'+JSON.stringify(fitCurrent).replace(/[^a-z0-9]/gi,'_'),{minimized:true,requests:[request({...activate,fitCurrent})]},refused('native_request_invalid'));
for(const [name,intent] of [
 ['activate-bounds',{...activate,bounds:bounds([0,40,600,400])}],['activate-display',{...activate,displayId:1}],
 ['move-false',{kind:'moveWindow',windowId:2,tabId:9,fitCurrent:false}],['move-mixed',{kind:'moveWindow',windowId:2,tabId:9,fitCurrent:true,displayId:1}],
 ['placement-fit-false',{kind:'moveWindow',windowId:2,tabId:9,fitCurrent:false,displayId:1,bounds:bounds([0,40,600,400])}],
 ['unrelated-fit',{kind:'selectTab',windowId:2,tabId:9,fitCurrent:true}]
])run('shape-'+name,{minimized:true,requests:[request(intent)]},refused('native_request_invalid'));
for(const displayId of [true,'1',0,-1,1.5,4294967296])run('invalid-selected-'+String(displayId).replace(/[^a-z0-9]/gi,'_'),{creation:true,begun:false,requests:[request({kind:'newWindow',chromePid:42,profile:'Profile 3',url:'https://destination.invalid/inert',displayId,bounds:bounds([0,40,600,400])})]},r=>{refused('native_request_invalid')(r);assert.equal(r.counts.creates,0);});
run('missing-selected-before-create',{creation:true,begun:false,requests:[request({kind:'newWindow',chromePid:42,profile:'Profile 3',url:'https://destination.invalid/inert',displayId:9,bounds:bounds([0,40,600,400])})]},r=>{refused('native_display_unavailable')(r);assert.equal(r.counts.creates,0);});
for(const fitCurrent of [undefined,false])run('raw-activation-'+String(fitCurrent),{requests:[request({kind:'activate',windowId:2,tabId:9,...(fitCurrent===undefined?{}:{fitCurrent})})]},success([-300,60,1000,700],0));
run('nonactivating-fit',{front:9,takeover:false,requests:[request({kind:'moveWindow',windowId:2,tabId:9,fitCurrent:true})]},r=>{success([0,60,1000,700])(r);assert.equal(r.front,9);assert.deepEqual(r.effects.map(e=>e.kind),['pbnd']);});
run('pre-fit-option-all',{onScreen:false,requests:[request({kind:'moveWindow',windowId:2,tabId:9,fitCurrent:true})]},r=>{success([0,60,1000,700])(r);assert.deepEqual(r.effects.map(e=>e.kind),['pbnd']);});
run('explicit-other-display',{initialBounds:[100,100,600,400],displays:[base,disp(2,[1600,0,1200,900])],requests:[request({kind:'moveWindow',windowId:2,tabId:9,displayId:2,bounds:bounds([1700,100,600,400])})]},r=>{success([1700,100,600,400])(r);assert.equal(r.replies[0].geometry.displayId,2);});
run('ignored-contained-placement',{initialBounds:[100,100,600,400],boundsEffect:'ignored',requests:[request({kind:'moveWindow',windowId:2,tabId:9,displayId:1,bounds:bounds([300,100,600,400])})]},refused('native_geometry_unconfirmed',['pbnd']));
run('selected-loss-after-write',{displayLossAfterBounds:true},refused('native_display_unavailable',['pbnd']));
for(const boundsEffect of ['row-only','cg-only'])run('disagreement-'+boundsEffect,{boundsEffect},refused('native_geometry_unconfirmed',['pbnd']));
for(const field of ['missingCGAfterBounds','missingCGOnceAfterBounds','wrongCGAfterBounds'])run(field.toLowerCase(),{[field]:true},r=>{refused(field==='wrongCGAfterBounds'?'native_target_changed':'native_geometry_unconfirmed',['pbnd'])(r);assert.equal(r.replies[0].bindingReason,field==='wrongCGAfterBounds'?'cg_mapping_mismatch':'cg_mapping_missing');assert.equal(r.counts.postBoundsCG,1);assert.equal(r.replies[0].noRetry,true);});
run('full-frame-no-write',{initialBounds:[0,0,1200,900]},r=>{success([0,0,1200,900],0)(r);assert.equal(r.replies[0].geometry.branch,'full-frame');});
run('full-frame-zero-inset-ordinary',{initialBounds:[0,0,1200,900],displays:[{...base,visible:[0,0,1200,900]}]},r=>{success([0,0,1200,900],0)(r);assert.equal(r.replies[0].geometry.branch,'usable');});
run('full-frame-placement-conflict',{initialBounds:[0,0,1200,900],requests:[request({kind:'moveWindow',windowId:2,tabId:9,displayId:1,bounds:bounds([100,100,600,400])})]},refused('native_full_frame_conflict'));
run('created-full-frame-conflict',{creation:true,begun:false,initialBounds:[0,0,1200,900],requests:[request({kind:'newWindow',chromePid:42,profile:'Profile 3',url:'https://destination.invalid/inert',displayId:1,bounds:bounds([100,100,600,400])})]},r=>{refused('native_full_frame_conflict',['create'])(r);assert.equal(r.counts.creates,1);assert.equal(r.counts.url,0);assert.equal(r.replies[0].partial,true);assert.equal(r.replies[0].noRetry,true);});
run('full-frame-later-ordinary-refuses',{initialBounds:[0,0,1200,900],changeBoundsAfterStage:'activate_main',laterBounds:[100,100,600,400]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'native_geometry_unconfirmed');assert.equal(r.counts.bounds,0);assert.deepEqual(r.session.veilHoles,[]);});
run('ordinary-later-full-frame-refuses',{changeBoundsAfterStage:'activate_main',laterBounds:[0,0,1200,900]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'native_geometry_unconfirmed');assert.equal(r.counts.bounds,1);assert.deepEqual(r.session.veilHoles,[]);});
// Freeze the accepted actual rectangle, including Chrome's immediate clamp, across
// later activation effects. These cases reuse only the existing row/CG effect seam.
for(const [name,fixture,expected,writes] of [
  ['ordinary-accepted-unchanged',{},[0,60,1000,700],1],
  ['initially-fit-accepted-unchanged',{initialBounds:[100,100,600,400]},[100,100,600,400],0],
  ['clamp-accepted-unchanged',{boundsEffect:'clamp',clampedBounds:[100,60,900,700]},[100,60,900,700],1],
  ['ordinary-accepted-tolerance',{changeBoundsAfterStage:'activate_main',laterBounds:[2,62,998,698]},[2,62,998,698],1]
])run(name,fixture,r=>{success(expected,writes)(r);assert.deepEqual(r.session.bounds,expected);assert.deepEqual(r.session.veilHoles,[expected]);});
const checkpointFailures=[];
for(const [name,fixture,initial,later,writes] of [
  ['ordinary-later-contained-position',{},[-300,60,1000,700],[100,60,1000,700],1],
  ['ordinary-later-contained-size',{},[-300,60,1000,700],[0,60,900,600],1],
  ['initially-fit-later-contained-position',{initialBounds:[100,100,600,400]},[100,100,600,400],[200,100,600,400],0],
  ['initially-fit-later-contained-size',{initialBounds:[100,100,600,400]},[100,100,600,400],[100,100,500,300],0],
  ['clamp-later-contained-position',{boundsEffect:'clamp',clampedBounds:[100,60,900,700]},[-300,60,1000,700],[200,60,900,700],1],
  ['clamp-later-contained-size',{boundsEffect:'clamp',clampedBounds:[100,60,900,700]},[-300,60,1000,700],[100,60,800,600],1]
]){
  try{run(name,{...fixture,changeBoundsAfterStage:'activate_main',laterBounds:later},r=>{
    assert.equal(r.replies[0].ok,false,`${name}: later contained geometry must refuse`);
    assert.equal(r.replies[0].error,'native_geometry_unconfirmed');assert.equal(r.replies[0].stage,'native_geometry_verify');
    assert.equal(r.replies[0].noRetry,true);assert.equal(r.replies[0].inputDelivery,'sent');
    assert.deepEqual(target(r).bounds,later);assert.deepEqual(target(r).cgBounds,later);
    assert.equal(r.counts.bounds,writes);assert.equal(r.counts.owners,1);assert.equal(r.counts.creates,0);assert.equal(r.counts.url,0);
    assert.deepEqual(r.session.bounds,initial);assert.deepEqual(r.session.veilHoles,[]);assert.equal(r.session.epoch,1);assert.equal(r.session.sameOwner,true);
    assertNoInput(r);
  });}catch(e){if(e.code!=='ERR_ASSERTION'||!e.semanticReceipt)throw e;checkpointFailures.push(e);}
}
if(checkpointFailures.length){const first=checkpointFailures[0];first.checkpointFailures=checkpointFailures.map(e=>({name:e.semanticCase,message:e.message,receipt:e.semanticReceipt}));throw first;}
for(const stopKind of ['aborted','interrupted','eof','end','epoch','hold','pause'])for(const timing of ['before','after'])run('stop-'+stopKind+'-'+timing,{stopKind,...(timing==='before'?{stopStage:'activate_fit'}:{stopAfterBounds:true})},r=>{refused({aborted:'aborted',interrupted:'interrupted',eof:'terminated',end:'terminated',epoch:'native_session_revoked',hold:'hold_ended',pause:'native_paused'}[stopKind],timing==='before'?[]:['pbnd'])(r);assert.equal(r.replies[0].inputDelivery,timing==='before'?'not_sent':'sent');assert.equal(r.session.sameOwner,true);assert.deepEqual(r.session.bounds,[-300,60,1000,700]);});
run('refresh-bound-window-mismatch',{changeSessionAtRefresh:true},r=>{assert.equal(r.replies[0].ok,false);assert.deepEqual(r.session.bounds,[-300,60,1000,700]);assert.deepEqual(r.session.veilHoles,[]);assert.equal(r.counts.bounds,1);});
for(const unknownStage of ['activate_fit','activate_main'])run('unknown-'+unknownStage.replaceAll('_','-'),{unknownStage},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].inputDelivery,'unknown');assert.equal(r.replies[0].noRetry,true);assert.equal(r.counts.bounds,1);assert.equal(r.session.revoked,true);assert.deepEqual(r.session.bounds,[-300,60,1000,700]);assert.deepEqual(r.session.veilHoles,[]);assert.deepEqual(r.input,[]);});

run('default-oversized-usable',{displays:undefined,initialBounds:[0,60,1400,1000]},success([0,30,1200,830]));
run('explicit-default-oversized-usable',{displays:[base],initialBounds:[0,60,1400,1000]},success([0,30,1200,830]));
run('stop-final-refresh',{stopStage:'native_geometry_refresh',stopOccurrence:2},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'aborted');assert.deepEqual(r.session.bounds,[-300,60,1000,700]);assert.deepEqual(r.session.veilHoles,[]);assert.equal(r.counts.bounds,1);});
run('full-frame-menu-landing',{initialBounds:[0,0,1200,900],cursor:[100,20],requests:[{op:'move',to:{x:100,y:20},rect:{x:90,y:10,w:20,h:20}}]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'landing_unreachable');assertNoInput(r);});
run('unreachable-sampled-before-post',{cursor:[100,100],requests:[{op:'move',to:{x:-100,y:100},rect:{x:-110,y:90,w:20,h:20}}]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'landing_unreachable');assertNoInput(r);});
run('sampled-terminal-cursor',{initialBounds:[0,40,1000,700],cursor:[200,200],terminalOffset:[10,0],requests:[pointerMove]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'cursor_moved');assert.deepEqual(r.input,[]);assert.ok(r.movePoints>0);});
run('background-move-no-activation',{initialBounds:[0,40,1000,700],cursor:[200,200],front:9,takeover:false,holding:false,requests:[pointerMove]},r=>{assert.equal(r.replies[0].ok,true);assert.equal(r.front,9);assert.deepEqual(r.effects,[]);assert.equal(r.counts.bounds,0);assert.ok(r.movePoints>0);});
run('top-window-refusal',{initialBounds:[0,40,1000,700],top:10,requests:[pointerMove]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].why,'window_not_top');assertNoInput(r);});
run('pointer-malformed-rect',{initialBounds:[0,40,1000,700],requests:[{op:'move',to:{x:100,y:100},rect:{x:90,y:90,w:0,h:20}}]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'bad_request');assertNoInput(r);});
run('explicit-clamp-differs-request',{initialBounds:[100,100,600,400],boundsEffect:'clamp',clampedBounds:[100,100,600,400],requests:[request({kind:'moveWindow',windowId:2,tabId:9,displayId:1,bounds:bounds([300,100,600,400])})]},refused('native_geometry_unconfirmed',['pbnd']));
for(const [name,display] of [['asleep',{...base,awake:false}],['unmatched',{...base,unmatched:true}],['dimensions',{...base,frame:[0,0,1199,900]}],['empty-usable',{...base,visible:[1400,0,100,100]}]])run('selected-'+name,{displays:[display,disp(2,[1600,0,1200,900])],creation:true,begun:false,requests:[request({kind:'newWindow',chromePid:42,profile:'Profile 3',url:'https://destination.invalid/inert',displayId:1,bounds:bounds([0,40,600,400])})]},r=>{refused('native_display_unavailable')(r);assert.equal(r.counts.creates,0);});
for(const [name,fields] of [['fit-false',{fitCurrent:false}],['fit-true',{fitCurrent:true}],['missing-display',{displayId:undefined}]])run('creation-shape-'+name,{creation:true,begun:false,requests:[request({kind:'newWindow',chromePid:42,profile:'Profile 3',url:'https://destination.invalid/inert',displayId:1,bounds:bounds([0,40,600,400]),...fields})]},r=>{refused('native_request_invalid')(r);assert.equal(r.counts.creates,0);});
run('full-frame-final-display-loss',{initialBounds:[0,0,1200,900],displayChangeAtSample:2,changedDisplays:[{...base,id:2}]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'native_display_unavailable');assert.equal(r.counts.bounds,0);assert.equal(r.counts.display,2);assert.deepEqual(r.session.veilHoles,[]);assert.deepEqual(r.input,[]);});
run('full-frame-final-topology-change',{initialBounds:[0,0,1200,900],displayChangeAtSample:2,changedDisplays:[{...base,visible:[40,50,1100,800]}]},r=>{assert.equal(r.replies[0].ok,false);assert.equal(r.replies[0].error,'native_display_unavailable');assert.equal(r.counts.bounds,0);assert.equal(r.counts.display,2);assert.deepEqual(r.session.veilHoles,[]);assert.deepEqual(r.input,[]);});
run('pre-pbnd-bounds-changed',{mutateAtSnapshot:4,mutatedBounds:[100,60,1000,700]},r=>{refused('native_geometry_unconfirmed')(r);assert.deepEqual(target(r).bounds,[100,60,1000,700]);assert.equal(r.replies[0].geometry.possiblyChanged,true);});
run('strict-edge-no-expanded-tolerance',{initialBounds:[-0.5,100,600,400]},success([0,100,600,400]));
run('strict-cg-edge-no-expanded-tolerance',{initialBounds:[-1.5,100,600,400],boundsEffect:'row-only'},refused('native_geometry_unconfirmed',['pbnd']));
run('contained-full-frame-tolerance',{initialBounds:[0,0,1200,899]},r=>{success([0,0,1200,899],0)(r);assert.equal(r.replies[0].geometry.branch,'full-frame');});
run('uncontained-near-full-frame',{initialBounds:[0,0,1200,901]},success([0,30,1200,830]));
run('ignored-fit-current-postcondition',{boundsEffect:'ignored'},refused('native_geometry_unconfirmed',['pbnd']));
const plainCreation={kind:'newWindow',chromePid:42,url:'https://destination.invalid/inert',displayId:1,bounds:bounds([0,40,1000,700])};
run('plain-creation-healthy',{creation:true,begun:false,requests:[request(plainCreation)]},r=>{success([0,40,1000,700])(r);assert.equal(r.counts.creates,1);assert.equal(r.counts.url,1);assert.deepEqual(r.effects.map(x=>x.kind),['create','pbnd','url']);assert.equal(r.effects[0].transport,'crel');assert.deepEqual([r.replies[0].chromePid,r.replies[0].windowId,r.replies[0].tabId,r.replies[0].cgWindow],[42,2,9,20]);assert.equal(r.session.begun,false);});
run('plain-creation-ignored-bounds',{creation:true,begun:false,boundsEffect:'ignored',requests:[request(plainCreation)]},r=>{refused('native_geometry_unconfirmed',['create','pbnd'])(r);assert.equal(r.counts.creates,1);assert.equal(r.counts.url,0);assert.equal(r.replies[0].partial,true);assert.equal(r.replies[0].creationAttempted,true);assert.equal(r.replies[0].noRetry,true);assert.deepEqual(target(r).bounds,[-300,60,1000,700]);});
run('plain-creation-malformed-receipt',{creation:true,begun:false,malformedCreateReceipt:true,requests:[request(plainCreation)]},r=>{refused('new_window_unconfirmed',['create'])(r);assert.equal(r.replies[0].stage,'new_window_receipt');assert.equal(r.counts.creates,1);assert.equal(r.counts.url,0);assert.equal(r.replies[0].partial,true);assert.equal(r.replies[0].creationAttempted,true);assert.equal(r.replies[0].noRetry,true);});
if(only)assert.equal(results.length,1,'selected semantic case exists');
return results;
}

// Value-only regression for the already reviewed DRY seed seam. No Session or OS adapters.
const drySeedMethods=new Map();
for(const name of ['configureDry','seed']){
  const anchor='        func '+name+'(',start=source.indexOf(anchor);
  assert.ok(start>=0&&source.indexOf(anchor,start+1)===-1,`Unique DRY value method ${name}`);
  const end=source.indexOf('\n        }',start)+10;assert.ok(end>start);
  drySeedMethods.set(name,source.slice(start,end));
}
const drySeedProgram=String.raw`import Foundation
import CoreFoundation
import CoreGraphics
struct Target { let windowId: Int; let tabId: Int; let cgWindow: Int }
${block('Failure')}
${block('WindowRow')}
final class Owner {
let dry: Bool
var target: Target? = nil
var scene: [String: Any]? = nil
var stopped = false
var creationAttempted = false
var active: Bool? = nil
var operations = Set<String>()
var dryRows: [WindowRow] = []
var dryCG: [Int: Int] = [:]
var dryConfig: [String: Any] = [:]
var seedBounds = CGRect(x: 0, y: 0, width: 800, height: 600)
init(dry: Bool) { self.dry = dry }
${drySeedMethods.get('configureDry')}
${block('Owner.bounds')}
${drySeedMethods.get('seed')}
}
func rect(_ r: CGRect) -> [String: Double] { ["left":r.minX,"top":r.minY,"width":r.width,"height":r.height] }
let name = CommandLine.arguments[1]
let owner = Owner(dry: name != "non-dry")
let target = Target(windowId: 7, tabId: 9, cgWindow: 11)
var initial: [String: Any] = ["left":100,"top":60,"width":1400,"height":900]
var config: [String: Any] = ["seedBounds":initial]
switch name {
case "default": config = [:]
case "bool": initial["left"] = true; config["seedBounds"] = initial
case "string": initial["width"] = "1400"; config["seedBounds"] = initial
case "null": config["seedBounds"] = NSNull()
case "missing": initial.removeValue(forKey: "top"); config["seedBounds"] = initial
case "extra": initial["x"] = 1; config["seedBounds"] = initial
case "nan": initial["left"] = Double.nan; config["seedBounds"] = initial
case "zero": initial["width"] = 0; config["seedBounds"] = initial
case "negative": initial["height"] = -1; config["seedBounds"] = initial
case "endpoint": initial["left"] = 32700; config["seedBounds"] = initial
case "rounded-zero": initial["width"] = 0.1; config["seedBounds"] = initial
case "stopped": owner.stopped = true
case "target": owner.target = target
case "scene": owner.scene = [:]
case "rows": owner.seed(target)
case "mapping": owner.dryCG[7] = 11
case "created": owner.creationAttempted = true
case "active": owner.active = true
case "operation": owner.operations.insert("once")
case "second": try owner.configureDry(config)
default: break
}
let before = rect(owner.seedBounds), beforeRows = owner.dryRows.map { rect($0.bounds) }
let beforeConfig = owner.dryConfig.count, beforeMapping = owner.dryCG.count
var failure: [String: Any]? = nil
do { try owner.configureDry(config) } catch let e as Failure { failure = e.json } catch { failure = ["unexpected":String(describing:error)] }
let after = rect(owner.seedBounds), afterRows = owner.dryRows.map { rect($0.bounds) }
let afterConfig = owner.dryConfig.count, afterMapping = owner.dryCG.count
owner.seed(target)
var result: [String: Any] = ["name":name,"before":before,"after":after,"beforeRows":beforeRows,"afterRows":afterRows,
"beforeConfig":beforeConfig,"afterConfig":afterConfig,"beforeMapping":beforeMapping,"afterMapping":afterMapping,"seededRows":owner.dryRows.map { rect($0.bounds) }]
if let failure { result["failure"] = failure }
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data:data,encoding:.utf8)!)
`;
for(const [name,value] of [['Failure',block('Failure')],['WindowRow',block('WindowRow')],['bounds',block('Owner.bounds')],...drySeedMethods])assert.equal(drySeedProgram.split(value).length,2,`Exact DRY value source once: ${name}`);
assert.doesNotMatch(drySeedProgram,/\b(?:Process|FileHandle|NSWorkspace|NSRunningApplication|AXUIElement|CGEvent|CGWindow|system|kill|posix_spawn)\b/);
const drySeedCases=['default','valid','bool','string','null','missing','extra','nan','zero','negative','endpoint','rounded-zero','stopped','target','scene','rows','mapping','created','active','operation','second','non-dry'];
export function runDrySeedRegression(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'window-dry-seed-values-')),swift=path.join(dir,'capsule.swift'),binary=path.join(dir,'capsule'),cache=path.join(dir,'cache');
  fs.writeFileSync(swift,drySeedProgram,{flag:'wx'});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({driver:fileSha(DRIVER),native:SOURCE_SHA,program:sha(drySeedProgram)},null,2));
  let serial=0;
  function invoke(exe,args,label){
    const compiler=[swift,'-module-cache-path',cache,'-o',binary];
    assert.ok((exe==='/usr/bin/swiftc'&&args.length===compiler.length&&args.every((x,i)=>x===compiler[i]))||(exe===binary&&args.length===1&&drySeedCases.includes(args[0])));
    const r=spawnSync(exe,args,{cwd:dir,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
    const artifact=path.join(dir,`${String(++serial).padStart(3,'0')}-${label}.json`);
    fs.writeFileSync(artifact,JSON.stringify({argv:[exe,...args],status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr},null,2),{flag:'wx'});
    assert.ok(!r.error&&!r.signal&&r.status===0,`FIXTURE_SETUP_OR_EXECUTION_FAILURE ${artifact}\n${r.stdout}\n${r.stderr}`);return r;
  }
  invoke('/usr/bin/swiftc',[swift,'-module-cache-path',cache,'-o',binary],'compile');
  const desired={left:100,top:60,width:1400,height:900},standard={left:0,top:0,width:800,height:600};
  const malformed=['bool','string','null','missing','extra','nan','zero','negative','endpoint','rounded-zero'];
  for(const name of drySeedCases){
    const child=invoke(binary,[name],name);assert.equal(child.stderr,'');const r=JSON.parse(child.stdout);
    if(['default','valid'].includes(name)){assert.equal(r.failure,undefined);assert.deepEqual(r.seededRows,[name==='default'?standard:desired]);}
    else if(name==='non-dry'){assert.equal(r.failure,undefined);assert.deepEqual(r.after,standard);assert.equal(r.afterConfig,0);assert.deepEqual(r.seededRows,[]);}
    else {assert.equal(r.failure?.error,malformed.includes(name)?'native_bounds_invalid':'native_request_invalid');assert.equal(r.failure.stage,'native_prepare');for(const suffix of ['','Rows','Config','Mapping'])assert.deepEqual(r['before'+suffix],r['after'+suffix],`${name} preserves ${suffix||'bounds'}`);}
  }
  return {dir,cases:drySeedCases.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===DRIVER){
  const creation=compileNativeCapsule();console.log(`creation artifacts: ${creation.dir}`);
  for(const scenario of ['healthy','ignored']){assertCreationGeometry(creation.run(scenario));console.log(`${scenario}: geometry assertion holds`);}
  const behavior=compileWindowBehaviorCapsule();console.log(`behavior artifacts: ${behavior.dir}`);
  const cases=runWindowBehaviorControls(behavior),matrix=runWindowGeometryMatrix(behavior);console.log(JSON.stringify({behaviorCases:cases.length,geometryCases:matrix.length,realNativeEffects:false,directory:behavior.dir}));
  console.log(JSON.stringify({postWriteRereads:runPostWriteRereads(behavior).map(x=>x.name),rereadMutants:runPostWriteRereadMutants()}));
  console.log(JSON.stringify({focusSettle:runFocusSettle(behavior),focusMutants:runFocusSettleMutants()}));
  console.log(JSON.stringify({drySeed:runDrySeedRegression()}));
  console.log(JSON.stringify({semanticMutants:runNativeGeometryMutants(behavior)}));
}
