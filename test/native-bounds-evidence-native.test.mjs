/** Actual production createWindow -> matcher -> Transaction with exclusively inert effects.
 * Every generated capsule, binary and complete stdout/stderr is retained, including failed attempts.
 * This does not run the product helper or reproduce a historical live operation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectBoundsTrace } from './native-bounds-evidence.mjs';
const SOURCE = fileURLToPath(new URL('../src/native-chrome.swift', import.meta.url));
const DRIVER = fileURLToPath(import.meta.url);
const HELPER = fileURLToPath(new URL('../src/helper.swift', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fileSha = filename => sha(fs.readFileSync(filename));
const source = fs.readFileSync(SOURCE, 'utf8'), SOURCE_SHA = sha(source);
const pinDeclaration=source.match(/^        private var creationPin:.*$/m)?.[0];
const hasCreationPin=!!pinDeclaration;
const hasCaptureRows=source.includes('captureRows: (([WindowRow]) -> Void)?');
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
const geometryTypes=['WindowDisplayRecord','WindowScreenRecord','WindowDisplay','WindowDisplaySet','WindowGeometryIntent','WindowGeometryPlan'];
const geometryPure=['geometryRectValid','geometryContains','geometryUsableRect','windowDisplays','geometryFit','geometryIntent','geometryPlan','geometryPostcondition'];
const geometryOwner=['readWindowDisplays','readWindowGeometry','prepareWindowGeometry','verifyWindowGeometry','applyWindowGeometry'];
const hasGeometry=source.includes('    struct WindowDisplayRecord {');
specs.push({name:'Owner.probeUntil',anchor:'        func probe(until deadline:',indent:8}); // NAT-RETRY r2
if(hasGeometry){
  for(const name of geometryTypes) specs.push({name,anchor:'    struct '+name+' {',indent:4});
  for(const name of geometryPure) specs.push({name,anchor:'    static func '+name+'(',indent:4});
  for(const name of geometryOwner) specs.push({name:'Owner.'+name,anchor:'        '+(['verifyWindowGeometry','applyWindowGeometry'].includes(name)?'@discardableResult\n        ':'')+'func '+name+'(',indent:8});
}
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
const executeStart = source.indexOf('        func execute(_ intent:'), admissionStart = source.indexOf('            if kind == "newWindow" {', executeStart);
const admissionEnd = source.indexOf('\n            }', admissionStart) + 14;
assert.ok(executeStart >= 0 && admissionStart > executeStart && admissionEnd > admissionStart);
const admissionBranch = source.slice(admissionStart, admissionEnd);
assert.match(admissionBranch, /return try createWindow\(intent, tx: tx, boundsEvidence: enabled\)/);
const SCENARIOS = ['stable_control', 'repeated_order_disagreement', 'initial_bad_prewrite_corrected', 'genuine_cg_replacement'];
const POST_URL_SCENARIOS = ['post_url_healthy', 'post_url_order_disagreement', 'post_url_cg_replacement'];
const DOCUMENT_CASES = ['document_healthy', 'document_nonfirst_active', 'document_missing', 'document_unsupported',
  'document_duplicate_ax', 'document_extra_cg', 'document_cap9', 'document_cap16', 'document_cap17',
  'document_unicode', 'document_global_duplicate_inactive', 'document_global_duplicate_rival_inactive', 'document_active_url_change', 'document_swap',
  'document_partial_swap', 'document_strong_title', 'document_wrong_type', 'document_invalid_url',
  'document_wrong_minimized', 'document_wrong_rect', 'document_missing_url_table'];
const RETENTION_CASES=['post_bounds_order_disagreement_strong_pin','post_url_order_disagreement'];
const PIN_CONTROLS=['post_url_transfer_new_cg','post_url_pin_strongly_claimed','post_url_target_strong_contrary','post_url_pin_offscreen',
  'post_url_pin_moved','post_url_extra_same_bounds_cg','post_url_new_chrome_id','post_url_existing_cg_swap_boundary'];
const STRUCTURE_FAILURES = {
  structural_target_bounds: {scope:'target',field:'bounds'}, structural_other_bounds: {scope:'other',field:'bounds'},
  structural_target_id: {scope:'target',field:'id'}, structural_target_tabs: {scope:'target',field:'tabs'},
  structural_target_active: {scope:'target',field:'active_tab'}, structural_target_minimized: {scope:'target',field:'minimized'},
  structural_target_index: {scope:'target',field:'index'}, structural_count: {scope:'snapshot',field:'count'},
  structural_after_duplicate_target: {scope:'target',field:'duplicate_id'},
};
const EXTRA = ['initial_cg_nil', 'initial_duplicate_rows', 'structural_change', 'ordinary_failure', 'typed_halt', 'typed_dialog', 'empty_title', 'changed_title',
  'strict_ax', 'failed_ax_empty', 'repeat_initial', 'duplicate_claims', 'invalid_geometry', 'invalid_index', 'missing_window', 'invalid_requested', 'initial_unique_duplicate_claim',
  ...Object.keys(STRUCTURE_FAILURES)];
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
enum CGOption { case optionAll }
enum AXError { case success, cannotComplete, attributeUnsupported, noValue }
struct AXElement { let number: Int, title: String, minimized: Bool, rect: CGRect?; var document: AnyObject? = nil; var documentStatus: AXError = .attributeUnsupported }

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
    let bundleIdentifier: String? = "com.google.Chrome"
    var executableURL: URL? { URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") }
    init?(processIdentifier: pid_t) {
        guard processIdentifier == 42 else { return nil }
        self.processIdentifier = processIdentifier
    }
}
struct NSWorkspace {
    static let shared = NSWorkspace()
    var frontmostApplication: NSRunningApplication? { nil }
}

// Descriptor trees are values in memory. This class has no sendEvent method.
final class NSAppleEventDescriptor {
    var descriptorType: UInt32 = typeNull
    var stringValue: String?
    var typeCodeValue: UInt32 = 0
    var enumCodeValue: UInt32 = 0
    var fields: [UInt32: NSAppleEventDescriptor] = [:]
    var objectType: String?, objectID: Int?, propertyCode: UInt32?, container: NSAppleEventDescriptor?
    var rect: CGRect?, eventID: UInt32?, processID: pid_t?
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

enum ChromeNative {
${hasGeometry?[...geometryTypes,...geometryPure].map(block).join('\n'):''}
${hasGeometry?`    static func sampleWindowDisplays() throws -> ([WindowDisplayRecord],[WindowScreenRecord]) {
        let full=CGRect(x:-100,y:-100,width:2200,height:1100)
        return ([WindowDisplayRecord(id:1,full:full,awake:true,mirrored:false,main:true)],
            [WindowScreenRecord(id:1,frame:full,visible:full,safeTop:0)])
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

    final class Probe {
        let deadline: Double
        let checkpoint: () throws -> Void
        let snapshot: (pid_t) throws -> [WindowRow]
        var cycle: Int
        var mappingRead = false
        var firstFailure: Error?
        init(budget: Double, checkpoint: @escaping () throws -> Void,
             snapshot: @escaping (pid_t) throws -> [WindowRow]) {
            deadline = ProcessInfo.processInfo.systemUptime + budget
            self.checkpoint = checkpoint
            cycle = model.mapCycle
            self.snapshot = { pid in
                precondition(!model.afterAXRead)
                model.afterAXRead = true
                defer { model.afterAXRead = false }
                return try snapshot(pid)
            }
        }
${block('Probe.check')}
${block('Probe.around')}
        func CGWindowListCopyWindowInfo(_ options: [CGOption], _ relative: Int) -> Any? {
            around(nil as [[String: Any]]?) { model.scenario == "initial_cg_nil" ? nil : model.cgRows(cycle: cycle, mapping: mappingRead) }
        }
        func axWindows(pid: pid_t) -> [AXElement] {
            around([]) {
                precondition(pid == 42)
                model.record(["kind": "ax", "cycle": cycle]); model.axReads += 1
                return model.axRows() // Failed enumeration and successful empty share this exact observed array.
            }
        }
        func axWindowNumber(_ element: AXElement) -> Int? { around(nil as Int?) { element.number } }
        func AXUIElementCopyAttributeValue(_ element: AXElement, _ key: CFString,
                                          _ value: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
            around(.cannotComplete) {
                if key == kAXDocumentAttribute {
                    model.documentReads += 1
                    model.record(["kind": "document", "cycle": cycle, "cg": element.number])
                    value.pointee = element.document
                    return element.documentStatus
                }
                value.pointee = (key == kAXTitleAttribute ? element.title as AnyObject : element.minimized as AnyObject)
                return .success
            }
        }
        func axRect(_ element: AXElement) -> CGRect? { around(nil as CGRect?) { element.rect } }
    }

    class OwnerCore {
        let dry = false
        var dryCG: [Int: Int] = [:]
        var dryConfig: [String: Any] = [:]
        var target: Target?, scene: [String: Any]?
${pinDeclaration??'        private var creationPin: (window: Int, cg: Int, cgs: Set<Int>, windows: Set<Int>)?'}
        var pinForFixture: [String: Any]? {
            guard let pin = creationPin else { return nil }
            return ["window": pin.window, "cg": pin.cg, "cgs": pin.cgs.sorted(), "windows": pin.windows.sorted()]
        }
        var stopped = false, creationAttempted = false
        var stageCheck: (String) throws -> Void = { _ in }
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
${hasGeometry?geometryOwner.map(name=>block('Owner.'+name)).join('\n'):''}

        // Non-dry capsules never enter these branches; a trap is a fixture failure.
        func dryWrite(_ stage:String,tx:Transaction,_ body:()->Void = {})throws { fatalError("FIXTURE_EXCLUDED_PATH: dryWrite") }
        func dryUpdate(_ id:Int,rect:CGRect?) { fatalError("FIXTURE_EXCLUDED_PATH: dryUpdate") }
        // The production asynchronous reader and every host lookup are excluded; these are scripted values.
        func snapshot(_ pid: pid_t, until: Double? = nil) throws -> [WindowRow] {
            try requireAlive("native_read")
            let value = try model.snapshot(pid)
            try requireAlive("native_read")
            return value
        }
        func pump() throws {
            model.pumps += 1; model.clock += 1
            guard model.pumps <= 6 else { throw Failure("fixture_pump_overflow", "fixture") }
        }
        func specifier(_ type: String, form: String, key: NSAppleEventDescriptor,
                       container: NSAppleEventDescriptor? = nil) throws -> NSAppleEventDescriptor {
            let descriptor = NSAppleEventDescriptor()
            descriptor.descriptorType = typeObjectSpecifier; descriptor.objectType = type; descriptor.container = container
            if type == "prop" && form == "prop" { descriptor.propertyCode = key.typeCodeValue }
            else if ["cwin", "CrTb"].contains(type), form == "ID  ", let id = key.stringValue.flatMap(Int.init), id > 0 {
                descriptor.objectID = id
            } else { throw Failure("fixture_specifier_shape", "fixture") }
            return descriptor
        }
        func rectangle(_ rect: CGRect) throws -> NSAppleEventDescriptor {
            let descriptor = NSAppleEventDescriptor(); descriptor.rect = rect; return descriptor
        }
        @discardableResult
        func send(_ descriptor: NSAppleEventDescriptor, stage: String, tx: Transaction,
                  noReply: Bool = false) throws -> NSAppleEventDescriptor {
            // Only a local primitive is substituted; the real Transaction owns its ledger.
            // This rejects the unused non-profile create branch instead of faking its receipt.
            guard ["new_window_bounds", "new_window_url"].contains(stage), !noReply else {
                throw Failure("fixture_unexpected_send", "fixture")
            }
            return try tx.write(stage, acknowledged: !noReply) {
                try model.apply(descriptor, stage: stage)
                return NSAppleEventDescriptor()
            }
        }
    }

    // Observation-only wrappers preserve the complete selected production method bytes.
    final class Owner: OwnerCore {
        override func cgMapping(_ pid: pid_t, rows: [WindowRow], access: Probe,
            observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil${hasCreationPin?', retaining: (window: Int, cg: Int, cgs: Set<Int>, windows: Set<Int>)? = nil, captureUnique: (([Int: Int], Set<Int>) -> Void)? = nil':''}${hasCaptureRows?', captureRows: (([WindowRow]) -> Void)? = nil':''}) throws -> [Int: Int] {
            access.cycle = model.beginProbe(); access.mappingRead = true
${hasCreationPin?`            let capture: (([Int: Int], Set<Int>) -> Void)? = captureUnique.map { downstream in
                { unique, numbers in
                    model.uniqueCaptures.append(["unique": unique.reduce(into: [String: Int]()) { $0[String($1.key)] = $1.value }, "cgs": numbers.sorted()])
                    downstream(unique, numbers)
                }
            }`:''}
            let actual = try super.cgMapping(pid, rows: rows, access: access, observe: observe${hasCreationPin?', retaining: retaining, captureUnique: capture':''}${hasCaptureRows?', captureRows: captureRows':''})
            model.maps.append(["cycle": access.cycle, "phase": model.phase(access.cycle),
                               "mapping": actual.reduce(into: [String: Int]()) { $0[String($1.key)] = $1.value }])
            model.record(["kind": "map_return", "cycle": access.cycle])
            return actual
        }
        override func verify(_ target: Target, requireActive: Bool = false,
            observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil, until: Double? = nil) throws -> WindowRow {
            let slot = model.verifyReceipts.count
            model.pinObservations.append(pinForFixture as Any? ?? NSNull())
            model.verifyReceipts.append(["phase": model.phase(model.mapCycle + 1), "target": target.json])
            do {
                let actual = try super.verify(target, requireActive: requireActive, observe: observe, until: until)
                model.verifyReceipts[slot]["ok"] = true
                return actual
            } catch let failure as Failure {
                model.verifyReceipts[slot]["ok"] = false; model.verifyReceipts[slot]["failure"] = failure.json
                throw failure
            } catch { throw error }
        }
    }
}

${haltBlock}
struct PhysicalWindow {
    let id: Int, tabID: Int
    var cg: Int, rect: CGRect, url: String
}
final class Model {
    let scenario: String
    let initialRect = CGRect(x: 0, y: 0, width: 800, height: 600)
    let destinationRect = CGRect(x: 900, y: 0, width: 800, height: 600)
    var windows: [Int: PhysicalWindow] = [:]
    var clock: Double = 0
    var mapCycle = 0, snapshots = 0, cgReads = 0, axReads = 0, pumps = 0, creates = 0, boundsWrites = 0, urlWrites = 0, geometryCGReads = 0
    var afterAXRead = false, replacementApplied = false
    var documentReads = 0
    var rawAXEnumerationFailed = 0, rawAXEnumerationEmpty = 0
    var argv: [String] = []
    var events: [[String: Any]] = [], maps: [[String: Any]] = [], verifyReceipts: [[String: Any]] = []
    var pinObservations: [Any] = []
    var uniqueCaptures: [[String: Any]] = []
    var effects: [[String: Any]] = [], descriptors: [[String: Any]] = []
    init(_ scenario: String) {
        self.scenario = scenario
        windows[1] = PhysicalWindow(id: 1, tabID: 5, cg: 10,
            rect: scenario.hasPrefix("document_") || scenario.hasPrefix("post_url_") || ["post_bounds_order_disagreement_strong_pin", "initial_unique_duplicate_claim"].contains(scenario) ? destinationRect : initialRect, url: "about:blank#synthetic-old")
        if scenario == "document_unicode" { windows[1]!.url = "https://old.invalid/caf\u{00e9}" }
        let total = scenario == "document_cap9" ? 9 : scenario == "document_cap16" ? 16 : scenario == "document_cap17" ? 17 : 2
        if total > 2 {
            for id in 3...total { windows[id] = PhysicalWindow(id: id, tabID: id * 10, cg: id * 10,
                rect: destinationRect, url: "https://old.invalid/\(id)") }
        }
    }
    func record(_ value: [String: Any]) {
        precondition(events.count < 1024, "finite synthetic observation budget")
        events.append(value.merging(["ordinal": events.count + 1]) { first, _ in first })
    }
    func phase(_ cycle: Int) -> String {
        cycle == 0 ? "before_create" : cycle == 1 ? "creation_selected" : boundsWrites == 0 ? "bounds_preverify" : urlWrites == 0 ? "bounds_postverify" : "url_postverify"
    }
    func rectJSON(_ rect: CGRect) -> [Double] { [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)] }
    func launch(_ args: [String]) throws {
        guard creates == 0, args.count == 3, args[0] == "--profile-directory=Profile 3", args[1] == "--new-window",
              args[2] == "data:text/plain,mychrome-native-01234567-89AB-4CDE-8F01-23456789ABCD" else {
            throw ChromeNative.Failure("fixture_launch_arguments", "fixture")
        }
        creates += 1; argv = args
        windows[2] = PhysicalWindow(id: 2, tabID: 9, cg: 20, rect: scenario == "invalid_geometry" ? CGRect(x: 1000001, y: 0, width: 800, height: 600) : initialRect, url: args[2])
        effects.append(["kind": "create", "windowId": 2, "physicalCG": 20])
        record(["kind": "create", "windowId": 2, "physicalCG": 20])
    }
    func beginProbe() -> Int {
        precondition(mapCycle < 64, "finite mapping budget")
        mapCycle += 1; record(["kind": "probe", "cycle": mapCycle]); return mapCycle
    }
    func disagreement(_ cycle: Int) -> Bool {
        (scenario == "repeated_order_disagreement" && boundsWrites == 0) ||
        (scenario == "initial_bad_prewrite_corrected" && cycle == 1) ||
        ((scenario.hasPrefix("document_") || ["post_url_order_disagreement", "post_url_new_chrome_id"].contains(scenario)) && urlWrites == 1) ||
        (scenario == "post_bounds_order_disagreement_strong_pin" && boundsWrites == 1)
    }
    func snapshot(_ pid: pid_t) throws -> [ChromeNative.WindowRow] {
        guard pid == 42, snapshots < 128 else { throw ChromeNative.Failure("fixture_snapshot_budget", "fixture") }
        if ((scenario == "genuine_cg_replacement" && boundsWrites == 1) ||
            (scenario == "post_url_cg_replacement" && urlWrites == 1)), !replacementApplied {
            guard var created = windows[2], created.cg == 20 else { throw ChromeNative.Failure("fixture_replacement_state", "fixture") }
            created.cg = 30; windows[2] = created; replacementApplied = true
            record(["kind": "physical_cg_replacement", "windowId": 2, "before": 20, "after": 30])
        }
        if urlWrites == 1, !replacementApplied {
            if ["post_url_transfer_new_cg", "post_url_existing_cg_swap_boundary", "document_swap", "document_partial_swap"].contains(scenario) {
                var rival = windows[1]!, created = windows[2]!
                rival.cg = 20; created.cg = scenario == "post_url_transfer_new_cg" ? 30 : 10
                windows[1] = rival; windows[2] = created; replacementApplied = true
                record(["kind": "physical_cg_transfer", "targetCG": created.cg, "rivalCG": rival.cg])
            } else if scenario == "post_url_new_chrome_id" {
                let rival = windows.removeValue(forKey: 1)!
                windows[3] = PhysicalWindow(id: 3, tabID: 15, cg: rival.cg, rect: rival.rect, url: rival.url)
                replacementApplied = true; record(["kind": "chrome_id_replacement", "before": 1, "after": 3, "physicalCG": 10])
            }
        }
        let cycle = creates == 0 ? 0 : (afterAXRead ? mapCycle : mapCycle + 1)
        guard (0...64).contains(cycle) else { throw ChromeNative.Failure("fixture_snapshot_cycle", "fixture") }
        if afterAXRead && scenario == "ordinary_failure" { throw ChromeNative.Failure("native_read_unknown", "native_read") }
        if afterAXRead && scenario == "typed_halt" { throw Halt.terminated }
        if afterAXRead && scenario == "typed_dialog" { throw ChromeNative.DialogFailure(code: "dialog_probe_unknown", stage: "native_read_deadline") }
        snapshots += 1
        var rows = windows.keys.sorted().filter { !(scenario == "missing_window" && mapCycle >= 1 && !afterAXRead && $0 == 2) }.map { id -> ChromeNative.WindowRow in
            let window = windows[id]!
            let index = scenario.hasPrefix("document_") && id > 2 ? id : creates == 0 ? 1 : (disagreement(cycle) ? (id == 2 ? 2 : 1) : (id == 2 ? 1 : 2))
            let changedTarget = afterAXRead && id == 2
            let changedBounds = afterAXRead && (scenario == "structural_change" ||
                (scenario == "structural_target_bounds" && id == 2) || (scenario == "structural_other_bounds" && id == 1))
            var tabs = changedTarget && scenario == "structural_target_tabs" ? [window.tabID, 99] : [window.tabID]
            var urls = [window.tabID: window.url]
            if scenario == "document_nonfirst_active" { tabs.insert(window.tabID + 1000, at: 0); urls[window.tabID + 1000] = "https://inactive.invalid/\(id)" }
            if urlWrites == 1 && id == 2 && ["document_global_duplicate_inactive", "document_active_url_change"].contains(scenario) {
                tabs.append(1009)
                if scenario == "document_global_duplicate_inactive" { urls[1009] = window.url }
                else {
                    let future = "https://destination.invalid/redirected"
                    urls[window.tabID] = afterAXRead ? future : window.url
                    urls[1009] = afterAXRead ? window.url : future
                }
            }
            if urlWrites == 1 && id == 1 && scenario == "document_global_duplicate_rival_inactive" {
                tabs.append(1005); urls[1005] = windows[2]!.url
            }
            if urlWrites == 1 && id == 2 && scenario == "document_missing_url_table" { urls.removeValue(forKey: window.tabID) }
            return ChromeNative.WindowRow(id: changedTarget && scenario == "structural_target_id" ? 99 : id,
                tabs: tabs,
                activeTab: changedTarget && scenario == "structural_target_active" ? 99 : window.tabID,
                index: scenario == "invalid_index" ? 65536 + index : (changedTarget && scenario == "structural_target_index" ? index + 2 : index),
                bounds: changedBounds ? destinationRect : window.rect, minimized: changedTarget && scenario == "structural_target_minimized", title: scenario == "empty_title" ? "" : (scenario == "changed_title" && afterAXRead ? "Changed private title" : (id == 1 ? "Old synthetic title" : "New synthetic title")),
                tabURLs: urls)
        }
        if afterAXRead && scenario == "structural_count" {
            rows.append(ChromeNative.WindowRow(id: 99, tabs: [99], activeTab: 99, index: 3, bounds: initialRect, minimized: false, title: "Synthetic extra row", tabURLs: [:]))
        }
        if afterAXRead && scenario == "structural_after_duplicate_target" { rows.append(rows.first { $0.id == 2 }!) }
        record(["kind": "snapshot", "cycle": cycle, "read": afterAXRead ? "after_ax" : "owner",
                "rows": rows.map { ["id": $0.id, "index": $0.index, "rect": rectJSON($0.bounds), "minimized": $0.minimized] as [String: Any] }])
        return model.scenario == "initial_duplicate_rows" && creates > 0 && !afterAXRead ? rows + [rows[0]] : rows
    }
    func cgRows(cycle: Int, mapping: Bool) -> [[String: Any]] {
        precondition(cycle == mapCycle && windows[2] != nil)
        cgReads += 1
        if !mapping { geometryCGReads += 1 }
        let kind = mapping ? "cg" : "geometry_cg"
        if scenario == "repeat_initial" && cycle <= 2 { record(["kind": kind, "cycle": cycle, "rows": []]); return [] }
        let order = [windows[2]!, windows[1] ?? windows[3]!] + windows.keys.sorted().filter { $0 > 2 && !(scenario == "post_url_new_chrome_id" && $0 == 3) }.map { windows[$0]! }
        var values: [(number: Int, rect: CGRect, onScreen: Bool)] = order.map {
            ($0.cg, scenario == "post_url_pin_moved" && urlWrites == 1 && $0.id == 2 ? initialRect : $0.rect,
             !(scenario == "post_url_pin_offscreen" && urlWrites == 1 && $0.id == 2))
        }
        if ["post_url_extra_same_bounds_cg", "document_extra_cg"].contains(scenario) && urlWrites == 1 { values.append((30, destinationRect, true)) }
        record(["kind": kind, "cycle": cycle,
                "rows": values.map { ["number": $0.number, "rect": rectJSON($0.rect), "onScreen": $0.onScreen] as [String: Any] }])
        return values.map { [kCGWindowOwnerPID: 42, kCGWindowLayer: 0, kCGWindowNumber: ["duplicate_claims", "initial_unique_duplicate_claim"].contains(scenario) ? 20 : $0.number,
                            kCGWindowBounds: $0.rect.dictionaryRepresentation as NSDictionary, kCGWindowIsOnscreen: $0.onScreen] }
    }
    func axRows() -> [AXElement] {
        if scenario.hasPrefix("document_") {
            var values = windows.keys.sorted().map { id -> AXElement in
                let w = windows[id]!
                if urlWrites == 1 {
                    if scenario == "document_partial_swap" && id == 1 { return AXElement(number: w.cg, title: "Same synthetic title", minimized: false, rect: w.rect) }
                    if id == 2 && ["document_missing", "document_unsupported"].contains(scenario) {
                        return AXElement(number: w.cg, title: "Same synthetic title", minimized: false, rect: w.rect,
                            document: nil, documentStatus: scenario == "document_missing" ? .noValue : .attributeUnsupported)
                    }
                    if scenario == "document_strong_title" {
                        return AXElement(number: w.cg, title: (id == 1 ? "New" : "Old") + " synthetic title - Google Chrome", minimized: false, rect: w.rect,
                            document: w.url as AnyObject, documentStatus: .success)
                    }
                    if id == 1 && scenario == "document_unicode" {
                        return AXElement(number: w.cg, title: "Same synthetic title", minimized: false, rect: w.rect,
                            document: "https://old.invalid/cafe\u{0301}" as AnyObject, documentStatus: .success)
                    }
                    if id == 2 && ["document_wrong_type", "document_invalid_url", "document_wrong_minimized", "document_wrong_rect"].contains(scenario) {
                        return AXElement(number: w.cg, title: "Same synthetic title", minimized: scenario == "document_wrong_minimized",
                            rect: scenario == "document_wrong_rect" ? initialRect : w.rect,
                            document: scenario == "document_wrong_type" ? NSNumber(value: 42) : (scenario == "document_invalid_url" ? "relative path" : w.url) as AnyObject,
                            documentStatus: .success)
                    }
                }
                return AXElement(number: w.cg, title: "Same synthetic title", minimized: false,
                    rect: w.rect, document: w.url as AnyObject, documentStatus: .success)
            }
            if scenario == "document_duplicate_ax" && urlWrites == 1 { values.append(values.last!) }
            return values
        }
        if scenario == "post_url_pin_strongly_claimed" && urlWrites == 1 {
            return [AXElement(number: 20, title: "Old synthetic title - Google Chrome", minimized: false, rect: destinationRect)]
        }
        if scenario == "post_url_target_strong_contrary" && urlWrites == 1 {
            return [AXElement(number: 10, title: "New synthetic title - Google Chrome", minimized: false, rect: destinationRect)]
        }
        if scenario == "strict_ax" {
            return [AXElement(number: 10, title: "Old synthetic title - Google Chrome", minimized: false, rect: initialRect),
                    AXElement(number: 20, title: "New synthetic title - Google Chrome", minimized: false, rect: initialRect)]
        }
        // Model the low-level optional result before its existing nil-to-empty fold.
        // This is an inert input distinction, not execution of an actual AX enumerator.
        let enumeration: [AXElement]?
        if scenario == "failed_ax_empty" { rawAXEnumerationFailed += 1; enumeration = nil }
        else { rawAXEnumerationEmpty += 1; enumeration = [] }
        return enumeration ?? []
    }
    func apply(_ descriptor: NSAppleEventDescriptor, stage: String) throws {
        let code = ChromeNative.OwnerCore.code
        guard descriptor.processID == 42, descriptor.eventID == code("setd"),
              let property = descriptor.fields[code("----")], property.objectType == "prop",
              let payload = descriptor.fields[code("data")], let direct = property.container else {
            throw ChromeNative.Failure("fixture_descriptor_shape", "fixture")
        }
        if stage == "new_window_bounds" {
            guard property.propertyCode == code("pbnd"), direct.objectType == "cwin", let id = direct.objectID,
                  var actualWindow = windows[id], let rect = payload.rect, rect == destinationRect,
                  creates == 1, boundsWrites == 0, urlWrites == 0 else {
                throw ChromeNative.Failure("fixture_bounds_target", "fixture")
            }
            let addressedCG = actualWindow.cg
            descriptors.append(["stage": stage, "objectType": "cwin", "windowId": id, "property": "pbnd", "rect": rectJSON(rect)])
            actualWindow.rect = rect; windows[id] = actualWindow; boundsWrites += 1
            effects.append(["kind": "bounds", "windowId": id, "physicalCG": addressedCG, "rect": rectJSON(rect)])
            record(["kind": "bounds", "windowId": id, "physicalCG": addressedCG])
        } else {
            guard stage == "new_window_url", property.propertyCode == code("URL "), direct.objectType == "CrTb",
                  let tabID = direct.objectID, let container = direct.container, container.objectType == "cwin",
                  let id = container.objectID, var actualWindow = windows[id], actualWindow.tabID == tabID,
                  let value = payload.stringValue, value == "https://destination.invalid/inert",
                  boundsWrites == 1, urlWrites == 0 else {
                throw ChromeNative.Failure("fixture_url_target", "fixture")
            }
            descriptors.append(["stage": stage, "objectType": "CrTb", "windowId": id, "tabId": tabID, "property": "URL "])
            actualWindow.url = value; windows[id] = actualWindow; urlWrites += 1
            effects.append(["kind": "url", "windowId": id, "tabId": tabID]); record(["kind": "url", "windowId": id, "tabId": tabID])
        }
    }
    func physicalJSON() -> [[String: Any]] {
        windows.keys.sorted().map { id in
            let window = windows[id]!
            return ["windowId": id, "cgWindow": window.cg, "rect": rectJSON(window.rect)]
        }
    }
}

precondition(CommandLine.arguments.count == 3)

func collectorFixtures() -> [String: Any] {
    var outputs: [String: Any] = [:]
    let r = CGRect(x: 0, y: 0, width: 800, height: 600)
    for mode in ["caps", "bytes", "invalid_event", "missing_rect", "row_reference"] {
        let e = ChromeNative.BoundsEvidence(requestedRect: r)
        let phases = mode == "bytes" ? ["initial", "pre_bounds", "post_bounds", "post_url"] : ["initial"]
        for phase in phases {
            e.begin(phase, window: 100, expected: phase == "initial" ? nil : 200)
            for i in 0..<(mode == "caps" ? 20 : 16) { e.record(0, 100 + i, nil, r, [i + 1], [false], [], []) }
            for i in 0..<(mode == "row_reference" ? 1 : (mode == "caps" ? 40 : 32)) { e.record(1, nil, 200 + i, r, [], [true], [], []) }
            if mode == "missing_rect" { e.record(2, nil, nil, nil, [], [], [], []); e.record(3, nil, nil, nil, [1], [], [], []); e.record(4, nil, 200, nil, [], [false], [], []) }
            if mode == "invalid_event" { e.record(99, nil, nil, nil, [], [], [], []) }
            if mode == "row_reference" { e.record(6, 100, 999, nil, [0], [], [], []) }
            for i in 0..<(mode == "row_reference" ? 0 : (mode == "caps" ? 40 : 32)) {
                let ws = Array(100..<116), cs = Array(200..<232)
                e.record(5, 100, nil, nil, [0, mode == "caps" ? 65536 : 32, 16, nil, nil, nil, nil, nil], [nil, nil], ws, cs)
                e.record(6, 100, 200 + i, nil, [4], [], [], [])
            }
            if phase == "initial" { e.initialMapped(200) }
            else { e.record(8, 100, 200, nil, [0], [], [], []); e.end() }
        }
        outputs[mode] = e.project()
    }
    let retained = ChromeNative.BoundsEvidence(requestedRect: r)
    retained.begin("initial", window: 100, expected: nil)
    retained.seedTarget(rect: r, index: 1, minimized: false)
    retained.record(1, nil, 200, r, [], [true], [], [])
    retained.record(6, 100, 200, nil, [0], [], [], [])
    retained.initialMapped(200)
    retained.begin("post_url", window: 100, expected: 200)
    retained.record(0, 100, nil, r, [2], [false], [], [])
    retained.record(1, nil, 200, r, [], [true], [], [])
    retained.record(6, 100, 200, nil, [6], [], [], [])
    retained.record(8, 100, 200, nil, [0], [], [], []); retained.end()
    outputs["retained_branch"] = retained.project()
    for mode in ["first_structure_failure", "legacy_structure_changed", "structure_same", "structure_unavailable",
                 "invalid_structure_field", "invalid_structure_count_window", "invalid_structure_result"] {
        let e = ChromeNative.BoundsEvidence(requestedRect: r)
        e.begin("initial", window: 100, expected: nil)
        e.seedTarget(rect: r, index: 1, minimized: false)
        e.record(1, nil, 200, r, [], [true], [], [])
        switch mode {
        case "first_structure_failure":
            e.record(7, 101, nil, nil, [1, 5], [], [], [])
            e.record(7, 100, nil, nil, [1, 7], [], [], [])
        case "legacy_structure_changed": e.record(7, nil, nil, nil, [1], [], [], [])
        case "structure_same": e.record(7, nil, nil, nil, [0], [], [], [])
        case "structure_unavailable": e.record(7, nil, nil, nil, [2], [], [], [])
        case "invalid_structure_field": e.record(7, 100, nil, nil, [1, 99], [], [], [])
        case "invalid_structure_count_window": e.record(7, 100, nil, nil, [1, 1], [], [], [])
        default: e.record(7, 100, nil, nil, [0, 5], [], [], [])
        }
        e.initialMapped(200)
        outputs[mode] = e.project()
    }
    return outputs
}


final class Admission {
    let dry: Bool
    init(_ dry: Bool) { self.dry = dry }
    func createWindow(_ intent: [String: Any], tx: ChromeNative.Transaction, boundsEvidence: Bool = false) throws -> [String: Any] { ["enabled": boundsEvidence] }
    func run(_ intent: [String: Any], request: [String: Any], tx: ChromeNative.Transaction) throws -> [String: Any] {
        let kind = intent["kind"] as! String
${admissionBranch}
        return ["other": true]
    }
}
func admissionFixtures(_ tx: ChromeNative.Transaction) -> [String: Any] {
    var out: [String: Any] = [:]
    let values: [(String, Any?)] = [("absent",nil),("integer_one",NSNumber(value:1)),("boolean_true",NSNumber(value:true)),("zero",NSNumber(value:0)),("two",NSNumber(value:2)),("fraction",NSNumber(value:1.5)),("string","1"),("null",NSNull()),("array",[1])]
    for (name,value) in values {
        var request: [String: Any] = ["op": "nativeChrome"]
        if let value { request["_boundsEvidence"] = value }
        out[name] = try! Admission(false).run(["kind":"newWindow"], request:request, tx:tx)
    }
    out["dry"] = try! Admission(true).run(["kind":"newWindow"],request:["op":"nativeChrome","_boundsEvidence":1],tx:tx)
    out["wrong_op"] = try! Admission(false).run(["kind":"newWindow"],request:["op":"status","_boundsEvidence":1],tx:tx)
    out["other_kind"] = try! Admission(false).run(["kind":"openTab"],request:["op":"nativeChrome","_boundsEvidence":1],tx:tx)
    return out
}

let model = Model(CommandLine.arguments[1])
let owner = ChromeNative.Owner()
let transaction = ChromeNative.Transaction(operationId: "inert-only-operation", checkpoint: { _ in })
var outcome: [String: Any]
var errorClass = "none"
let input: [String: Any] = ["kind": "newWindow", "chromePid": 42, "profile": "Profile 3", "url": "https://destination.invalid/inert", "displayId": 1,
    "bounds": ["left": 900, "top": 0, "width": model.scenario == "invalid_requested" ? 0 : 800, "height": 600]]
do {
    if CommandLine.arguments[2] == "enabled" { outcome = try owner.createWindow(input, tx: transaction, boundsEvidence: true) }
    else { outcome = try owner.createWindow(input, tx: transaction) }
} catch let failure as ChromeNative.Failure { outcome = failure.json; errorClass = "Failure" }
catch let failure as ChromeNative.DialogFailure { outcome = failure.json; errorClass = "DialogFailure" }
catch let halt as Halt {
    guard case .terminated = halt else { fatalError("unexpected inert Halt case") }
    outcome = ["ok": false, "error": "terminated"]; errorClass = "Halt"
}
catch { outcome = ["ok": false, "error": "fixture_unexpected_error"] }
var receipt: [String: Any] = [
    "scenario": model.scenario, "result": outcome, "errorClass": errorClass, "maps": model.maps, "verifications": model.verifyReceipts,
    "events": model.events, "effects": model.effects, "descriptors": model.descriptors,
    "ledger": transaction.stages, "primitiveLedgerDelivery": transaction.delivery,
    "initialPhysicalTruth": ["1": 10, "2": 20], "physicalAfter": model.physicalJSON(),
    "replacementApplied": model.replacementApplied, "documentReadCount": model.documentReads,
    "creationPinCleared": owner.pinForFixture == nil, "pinObservations": model.pinObservations, "uniqueCaptures": model.uniqueCaptures,
    "axEnumerationModel": ["failed": model.rawAXEnumerationFailed, "empty": model.rawAXEnumerationEmpty],
    "target": owner.target?.json as Any? ?? NSNull(), "creationAttempted": owner.creationAttempted,
    "counts": ["creates": model.creates, "bounds": model.boundsWrites, "url": model.urlWrites,
               "snapshots": model.snapshots, "cg": model.cgReads, "ax": model.axReads, "pumps": model.pumps, "geometryCG": model.geometryCGReads],
    "outerOwnerRunAndSessionIncluded": false, "realNativeEffects": false, "collectorFixtures": collectorFixtures(), "admissionFixtures": admissionFixtures(transaction)
]
// Product receipt above is frozen before this separate, read-only post-request scope probe.
if model.scenario.hasPrefix("document_") || ["post_bounds_order_disagreement_strong_pin", "post_url_order_disagreement"].contains(model.scenario), let target = owner.target {
    let snapshots = model.snapshots, cg = model.cgReads, ax = model.axReads, docs = model.documentReads
    var scope: [String: Any]
    do { _ = try owner.verify(target); scope = ["ok": true] }
    catch let error as ChromeNative.Failure { scope = error.json }
    catch { fatalError("unexpected scope probe error") }
    scope["pinCleared"] = owner.pinForFixture == nil
    scope["reads"] = ["snapshots": model.snapshots - snapshots, "cg": model.cgReads - cg, "ax": model.axReads - ax]
    if model.scenario.hasPrefix("document_") { scope["documentReads"] = model.documentReads - docs }
    receipt["afterCreationVerify"] = scope
}
print(String(data: try! JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), encoding: .utf8)!)
`;

for (const [name, value] of blocks) {
  assert.equal(program.split(value).length, 2, `Selected block appears exactly once, byte-for-byte: ${name}`);
}
assert.equal(program.split(haltBlock).length,2,'Actual pure-value Halt enum appears once, unchanged');
const imports = [...program.matchAll(/^import ([A-Za-z]+).*$/gm)].map(match => match[1]);
assert.deepEqual(imports, ['Foundation', 'CoreFoundation', 'CoreGraphics']);
for (const forbidden of [
  /@_silgen_name/, /\bsendEvent\s*\(/, /\b(?:NSAppleScript|SBApplication|ReadRunner|NSLock|NSMachPort|CGEventTapCreate)\b/,
  /\b(?:Foundation\.(?:Process|ProcessInfo|Thread|FileHandle)|ApplicationServices\.|ScriptingBridge\.|Carbon\.)/,
  /\bCoreGraphics\.(?:CGWindow|CGEvent)/, /\b(?:sleep|usleep|nanosleep|kill|posix_spawn|system)\s*\(/,
]) assert.doesNotMatch(program, forbidden, `Forbidden real effect: ${forbidden}`);
for (const localShadow of ['typealias Process = InertProcess', 'typealias ProcessInfo = InertClock',
  'typealias Thread = InertThread', 'typealias FileHandle = InertFileHandle', 'typealias UUID = InertUUID',
  'struct NSRunningApplication {', 'struct NSWorkspace {', 'final class NSAppleEventDescriptor {']) {
  assert.equal(program.split(localShadow).length, 2, `Exactly one local effect shadow: ${localShadow}`);
}
function assertCase(receipt) {
  const scenario = receipt.scenario;
  assert.ok(SCENARIOS.includes(scenario));
  assert.equal(receipt.realNativeEffects, false);
  assert.equal(receipt.outerOwnerRunAndSessionIncluded, false);
  assert.equal(receipt.creationAttempted, true);
  assert.equal(receipt.counts.creates, 1);
  assert.equal(receipt.counts.pumps, 0);
  assert.equal(receipt.counts.ax, hasGeometry && scenario !== 'initial_bad_prewrite_corrected' ? 3 : 2);
  assert.deepEqual(receipt.initialPhysicalTruth, { 1: 10, 2: 20 });
  const correct = { 1: 10, 2: 20 }, swapped = { 1: 20, 2: 10 }, replaced = { 1: 10, 2: 30 };
  const expectedMaps = {
    stable_control: hasGeometry ? [correct, correct, correct, correct, correct] : [correct, correct, correct, correct],
    repeated_order_disagreement: hasGeometry ? [swapped, swapped, swapped, correct] : [swapped, swapped, correct],
    initial_bad_prewrite_corrected: [swapped, correct],
    genuine_cg_replacement: hasGeometry ? [correct, correct, correct, replaced] : [correct, correct, replaced],
  }[scenario];
  assert.deepEqual(receipt.maps.map(item => item.mapping), expectedMaps, 'Actual source mapping sequence');
  assert.deepEqual(receipt.maps.map(item => item.cycle), expectedMaps.map((_, i) => i + 1));
  const geometryReads = hasGeometry ? (scenario === 'initial_bad_prewrite_corrected' ? 0 : scenario === 'stable_control' ? 3 : 1) : 0;
  assert.equal(receipt.counts.geometryCG, geometryReads, 'Exact pinned-CG samples are separate from actual mapping probes.');
  assert.equal(receipt.counts.cg, expectedMaps.length + geometryReads);
  assert.equal(receipt.counts.snapshots, expectedMaps.length + 1 + receipt.counts.ax);
  const observed = receipt.maps[0].mapping['2'];
  const expectedTruthFailure = ['repeated_order_disagreement', 'initial_bad_prewrite_corrected'].includes(scenario);
  if (expectedTruthFailure) assert.throws(() => assert.equal(observed, 20, 'Initial mapped W2 must equal fixed model truth CG20'), { code: 'ERR_ASSERTION' });
  else assert.equal(observed, 20);
  const initialTruth = {
    assertion: 'initial mapped W2 equals model physical CG20', expected: 20, observed,
    passed: !expectedTruthFailure, expectedFailure: expectedTruthFailure,
    classification: expectedTruthFailure ? 'observed assertion mismatch inside an expected characterization' : 'truth control holds',
  };
  const isStable = scenario === 'stable_control';
  const noBounds = scenario === 'initial_bad_prewrite_corrected';
  const expectedStages = noBounds ? ['new_window_create'] : isStable
    ? ['new_window_create', 'new_window_bounds', 'new_window_url'] : ['new_window_create', 'new_window_bounds'];
  assert.deepEqual(receipt.ledger.map(item => item.stage), expectedStages);
  receipt.ledger.forEach((entry, index) => assert.deepEqual(entry, {
    sequence: index + 1, stage: expectedStages[index], entered: true, delivery: 'sent', acknowledged: true,
  }));
  assert.equal(receipt.primitiveLedgerDelivery, 'sent', 'Actual primitive ledger only; outer Owner.run/Session are excluded.');
  assert.equal(Object.hasOwn(receipt.result, 'noRetry'), false, 'Do not manufacture outer Session proof.');
  assert.equal(receipt.counts.bounds, noBounds ? 0 : 1);
  assert.equal(receipt.counts.url, isStable ? 1 : 0);
  assert.deepEqual(receipt.effects.map(item => item.kind), noBounds ? ['create'] : isStable ? ['create', 'bounds', 'url'] : ['create', 'bounds']);
  const expectedPinned = scenario === 'repeated_order_disagreement' ? (hasGeometry ? [10, 10, 10] : [10, 10])
    : noBounds ? [10] : isStable ? (hasGeometry ? [20, 20, 20, 20] : [20, 20, 20]) : (hasGeometry ? [20, 20, 20] : [20, 20]);
  assert.deepEqual(receipt.verifications.map(item => item.target.cgWindow), expectedPinned, 'Actual verify inputs retain the creation pin.');
  assert.deepEqual(receipt.verifications.map(item => item.ok), isStable ? (hasGeometry ? [true, true, true, true] : [true, true, true]) : noBounds ? [false] : (hasGeometry ? [true, true, false] : [true, false]));
  if (isStable) {
    assert.equal(receipt.result.ok, true);
    assert.deepEqual(receipt.target, { chromePid: 42, windowId: 2, tabId: 9, cgWindow: 20 });
    assert.equal(receipt.result.url, 'https://destination.invalid/inert');
  } else {
    assert.equal(receipt.result.ok, false);
    assert.equal(receipt.result.error, 'native_target_changed');
    assert.equal(receipt.result.stage, 'native_binding');
    assert.equal(receipt.result.bindingReason, 'cg_mapping_mismatch');
    assert.equal(receipt.result.partial, true);
    assert.equal(receipt.result.createdWindowId, 2);
    assert.equal(receipt.result.createdTabId, 9);
    assert.equal(receipt.target, null);
    assert.equal(receipt.counts.url, 0, 'Strict mismatch must prevent destination dispatch.');
  }
  if (noBounds) assert.deepEqual(receipt.descriptors, []);
  else {
    assert.deepEqual(receipt.descriptors[0], {
      stage: 'new_window_bounds', objectType: 'cwin', windowId: 2, property: 'pbnd', rect: [900, 0, 800, 600],
    });
    assert.deepEqual(receipt.effects[1], { kind: 'bounds', windowId: 2, physicalCG: 20, rect: [900, 0, 800, 600] },
      'The actual descriptor moves W2/CG20, never the mistaken CG10 pin.');
    if (!isStable) assert.equal(receipt.ledger.at(-1).stage, 'new_window_bounds');
    if (!isStable) assert.equal(receipt.ledger.at(-1).delivery, 'sent');
  }
  assert.deepEqual(receipt.physicalAfter[0], { windowId: 1, cgWindow: 10, rect: [0, 0, 800, 600] });
  assert.deepEqual(receipt.physicalAfter[1], {
    windowId: 2, cgWindow: scenario === 'genuine_cg_replacement' ? 30 : 20,
    rect: noBounds ? [0, 0, 800, 600] : [900, 0, 800, 600],
  });
  assert.equal(receipt.replacementApplied, scenario === 'genuine_cg_replacement');
  const expectedReads = ['snapshot:0:owner', 'snapshot:1:owner', 'cg:1', 'ax:1', 'snapshot:1:after_ax',
    'snapshot:2:owner', 'cg:2', 'ax:2', 'snapshot:2:after_ax'];
  if (hasGeometry && !noBounds) {
    expectedReads.push('geometry_cg:2', 'snapshot:3:owner', 'cg:3', 'ax:3', 'snapshot:3:after_ax', 'snapshot:4:owner', 'cg:4');
    if (isStable) expectedReads.push('geometry_cg:4', 'snapshot:5:owner', 'cg:5', 'geometry_cg:5');
  } else {
    if (!noBounds) expectedReads.push('snapshot:3:owner', 'cg:3');
    if (isStable) expectedReads.push('snapshot:4:owner', 'cg:4');
  }
  const actualReads = receipt.events.filter(item => ['snapshot', 'cg', 'ax', 'geometry_cg'].includes(item.kind))
    .map(item => item.kind === 'snapshot' ? `${item.kind}:${item.cycle}:${item.read}` : `${item.kind}:${item.cycle}`);
  assert.deepEqual(actualReads, expectedReads, 'Actual read/AX order, including no AX after geometry separates.');
  return { scenario, initialTruth, safetyAssertionsPassed: true, expectedTerminalRefusal: !isStable,
    counts: receipt.counts, maps: receipt.maps, finalTarget: receipt.target };
}


function behavior(receipt) {
  const copy = structuredClone(receipt);
  delete copy.result._boundsEvidence;
  delete copy.collectorFixtures;
  delete copy.admissionFixtures;
  return copy;
}

function assertPostURLCase(receipt) {
  const {scenario}=receipt,replaced=scenario==='post_url_cg_replacement',healthy=!replaced,retained=RETENTION_CASES.includes(scenario);
  assert.ok(POST_URL_SCENARIOS.includes(scenario)||retained);assert.equal(hasGeometry,true);
  assert.equal(receipt.realNativeEffects,false);assert.equal(receipt.outerOwnerRunAndSessionIncluded,false);
  assert.equal(receipt.creationAttempted,true);assert.equal(receipt.replacementApplied,replaced);
  assert.deepEqual(receipt.initialPhysicalTruth,{1:10,2:20});
  const correct={1:10,2:20},last=retained?{2:20}:replaced?{1:10,2:30}:correct;
  assert.deepEqual(receipt.maps.map(m=>m.mapping),[correct,correct,correct,scenario===RETENTION_CASES[0]?{2:20}:correct,last]);
  assert.deepEqual(receipt.maps.map(m=>m.phase),['creation_selected','bounds_preverify','bounds_preverify','bounds_postverify','url_postverify']);
  assert.deepEqual(receipt.counts,{creates:1,bounds:1,url:1,snapshots:8,cg:healthy?8:7,ax:2,pumps:0,geometryCG:healthy?3:2});
  assert.deepEqual(receipt.verifications.map(v=>v.target),Array(4).fill({chromePid:42,windowId:2,tabId:9,cgWindow:20}),
    'Every actual verifier retains CG20; no replacement pin or retry is introduced.');
  assert.deepEqual(receipt.verifications.map(v=>v.ok),[true,true,true,healthy]);
  const stages=['new_window_create','new_window_bounds','new_window_url'];
  assert.deepEqual(receipt.ledger,stages.map((stage,i)=>({sequence:i+1,stage,entered:true,delivery:'sent',acknowledged:true})));
  assert.equal(receipt.primitiveLedgerDelivery,'sent');assert.equal(Object.hasOwn(receipt.result,'noRetry'),false);
  assert.deepEqual(receipt.effects,[{kind:'create',windowId:2,physicalCG:20},
    {kind:'bounds',windowId:2,physicalCG:20,rect:[900,0,800,600]},{kind:'url',windowId:2,tabId:9}]);
  assert.deepEqual(receipt.descriptors,[{stage:'new_window_bounds',objectType:'cwin',windowId:2,property:'pbnd',rect:[900,0,800,600]},
    {stage:'new_window_url',objectType:'CrTb',windowId:2,tabId:9,property:'URL '}]);
  assert.deepEqual(receipt.physicalAfter,[{windowId:1,cgWindow:10,rect:[900,0,800,600]},
    {windowId:2,cgWindow:replaced?30:20,rect:[900,0,800,600]}]);
  const urlEvent=receipt.events.findIndex(e=>e.kind==='url'),replacementEvent=receipt.events.findIndex(e=>e.kind==='physical_cg_replacement');
  assert.ok(urlEvent>0);if(replaced)assert.ok(replacementEvent>urlEvent);else assert.equal(replacementEvent,-1);
  assert.deepEqual(receipt.events.filter(e=>['snapshot','cg','ax','geometry_cg'].includes(e.kind))
    .map(e=>e.kind==='snapshot'?`${e.kind}:${e.cycle}:${e.read}`:`${e.kind}:${e.cycle}`),
    ['snapshot:0:owner','snapshot:1:owner','cg:1','snapshot:2:owner','cg:2','geometry_cg:2',
      'snapshot:3:owner','cg:3','snapshot:4:owner','cg:4','ax:4','snapshot:4:after_ax','geometry_cg:4',
      'snapshot:5:owner','cg:5','ax:5','snapshot:5:after_ax',...(healthy?['geometry_cg:5']:[])],
    'Only the existing post-URL mapping read runs, with no retry or extra sampling.');
  if(healthy) {
    assert.equal(receipt.result.ok,true);assert.equal(receipt.errorClass,'none');
    assert.deepEqual(receipt.target,{chromePid:42,windowId:2,tabId:9,cgWindow:20});
    assert.equal(receipt.result.url,'https://destination.invalid/inert');
  } else {
    assert.equal(receipt.result.ok,false);assert.equal(receipt.errorClass,'Failure');assert.equal(receipt.target,null);
    assert.equal(receipt.result.error,'native_target_changed');assert.equal(receipt.result.stage,'native_binding');
    assert.equal(receipt.result.bindingReason,'cg_mapping_mismatch');assert.equal(receipt.result.partial,true);
    assert.equal(receipt.result.createdWindowId,2);assert.equal(receipt.result.createdTabId,9);
    assert.equal(receipt.verifications.at(-1).phase,'url_postverify');
  }
  assert.equal(receipt.creationPinCleared,true,'Creation pin clears on both successful and failing exits.');
  assert.deepEqual(receipt.pinObservations,Array(4).fill({window:2,cg:20,cgs:[10,20],windows:[1,2]}));
  if(retained) {
    assert.equal(receipt.afterCreationVerify.ok,false);assert.equal(receipt.afterCreationVerify.error,'native_target_changed');
    assert.equal(receipt.afterCreationVerify.bindingReason,'cg_mapping_mismatch');assert.equal(receipt.afterCreationVerify.pinCleared,true);
    assert.deepEqual(receipt.afterCreationVerify.reads,{snapshots:2,cg:1,ax:1},'Later verify uses ordinary mapping without inheriting the pin.');
  }
}

function assertPinControl(receipt,t) {
  const {scenario}=receipt,boundary=scenario==='post_url_existing_cg_swap_boundary';
  const missing=['post_url_pin_offscreen','post_url_pin_moved','post_url_extra_same_bounds_cg'].includes(scenario);
  const finalMap={post_url_transfer_new_cg:{1:20,2:30},post_url_pin_strongly_claimed:{1:20,2:10},post_url_target_strong_contrary:{1:20,2:10},
    post_url_pin_offscreen:{},post_url_pin_moved:{},post_url_extra_same_bounds_cg:{},post_url_new_chrome_id:{2:10,3:20},
    post_url_existing_cg_swap_boundary:{2:20}}[scenario];
  assert.ok(finalMap);assert.equal(receipt.creationPinCleared,true);assert.equal(receipt.counts.creates,1);
  assert.deepEqual(receipt.maps.map(m=>m.mapping),[{1:10,2:20},{1:10,2:20},{1:10,2:20},{1:10,2:20},finalMap]);
  assert.deepEqual(receipt.pinObservations,Array(4).fill({window:2,cg:20,cgs:[10,20],windows:[1,2]}));
  assert.deepEqual(receipt.counts,{creates:1,bounds:1,url:1,snapshots:scenario==='post_url_pin_moved'?7:8,
    cg:boundary?8:7,ax:scenario==='post_url_pin_moved'?1:2,pumps:0,geometryCG:boundary?3:2});
  assert.deepEqual(receipt.ledger.map(x=>[x.stage,x.delivery]),[['new_window_create','sent'],['new_window_bounds','sent'],['new_window_url','sent']]);
  assert.deepEqual(receipt.effects.map(x=>x.kind),['create','bounds','url']);
  assert.deepEqual(receipt.verifications.map(x=>x.ok),[true,true,true,boundary]);
  const retained=Object.entries(t.phases).flatMap(([name,p])=>p.decisions.filter(d=>d.branch==='retained_exact').map(d=>({name,...d})));
  assert.deepEqual(retained,boundary?[{name:'post_url',w:'W1',c:'C1',branch:'retained_exact'}]:[],
    'Guard controls never retain; only the documented unobservable existing-CG swap is accepted.');
  if(boundary) {
    assert.equal(receipt.result.ok,true);assert.equal(receipt.target.cgWindow,20);
    assert.equal(receipt.physicalAfter.find(w=>w.windowId===2).cgWindow,10);
    assert.notEqual(receipt.target.cgWindow,receipt.physicalAfter.find(w=>w.windowId===2).cgWindow,
      'Residual boundary: retention cannot observe a physical swap among pre-existing CGs and Chrome IDs.');
  } else {
    assert.equal(receipt.result.ok,false);assert.equal(receipt.target,null);assert.equal(receipt.errorClass,'Failure');
    assert.equal(receipt.result.error,missing?'native_geometry_unconfirmed':'native_target_changed');
    assert.equal(receipt.result.stage,'native_binding');assert.equal(receipt.result.bindingReason,missing?'cg_mapping_missing':'cg_mapping_mismatch');
    assert.equal(t.phases.post_url.binding,receipt.result.bindingReason);
  }
  if(scenario==='post_url_transfer_new_cg') {
    assert.deepEqual(receipt.physicalAfter.map(w=>[w.windowId,w.cgWindow]),[[1,20],[2,30]]);
    assert.deepEqual(t.phases.post_url.cg.map(c=>c.c),['C3','C1'],'Old pin remains, but a previously unseen CG blocks retention.');
  }
  if(scenario==='post_url_pin_strongly_claimed') assert.ok(t.phases.post_url.decisions.some(d=>d.w==='W2'&&d.c==='C1'&&d.branch==='ax_strict'));
  if(scenario==='post_url_target_strong_contrary') assert.ok(t.phases.post_url.decisions.some(d=>d.w==='W1'&&d.c==='C2'&&d.branch==='ax_strict'));
  if(scenario==='post_url_pin_offscreen') assert.equal(t.phases.post_url.cg.find(c=>c.c==='C1').onScreen,false);
  if(scenario==='post_url_pin_moved') assert.deepEqual(t.phases.post_url.cg.find(c=>c.c==='C1').rect,[0,0,800,600]);
  if(scenario==='post_url_extra_same_bounds_cg') assert.deepEqual(t.phases.post_url.cg.map(c=>c.c),['C1','C2','C3']);
  if(scenario==='post_url_new_chrome_id') {
    assert.deepEqual(receipt.physicalAfter.map(w=>[w.windowId,w.cgWindow]),[[2,20],[3,10]]);
    assert.deepEqual(t.phases.post_url.chrome.map(w=>w.w),['W1','W3'],'A new Chrome ID blocks retention even when every CG was initially present.');
  }
}

// Independent fixed-model oracle: created Chrome window 2 reserves W1; existing
// Chrome window 1 becomes W2. Initial CG enumeration is 20 then 10, hence C1/C2;
// the modeled replacement 30 first appears post-bounds and must be C3. These
// expectations do not derive identities or pairings from any observed trace.
const ORACLE_R=[0,0,800,600],ORACLE_S=[900,0,800,600];
const oracleChrome=(w,index,rect=ORACLE_R)=>({w,index,rect,minimized:false});
const oracleCG=(c,rect=ORACLE_R)=>({c,rect,onScreen:true});
const oracleDecision=(w,c,branch='order')=>({w,c,branch});
const oracleOrder=windows=>({w:'W2',kind:'order',counts:{hits:2,twins:null,visible:null,rivals:null,strict:null,loose:null,group:2},
  titleNonempty:null,titlesChanged:null,windows,cgs:['C1','C2']});
const orderedPhase=(initial,wrong,expected)=>({state:'complete',attempts:1,target:'W1',expected,mapped:wrong?'C2':'C1',
  chrome:initial?[oracleChrome('W1',wrong?2:1),oracleChrome('W2',wrong?1:2)]:[oracleChrome('W2',wrong?1:2),oracleChrome('W1',wrong?2:1)],
  cg:[oracleCG('C1'),oracleCG('C2')],orders:[oracleOrder(wrong?['W2','W1']:['W1','W2'])],
  decisions:wrong?[oracleDecision('W2','C1'),oracleDecision('W1','C2')]:[oracleDecision('W1','C1'),oracleDecision('W2','C2')]});
const notReachedPhase={state:'not_reached',attempts:0,target:null,expected:null,mapped:null,chrome:[],cg:[],orders:[],decisions:[]};
const BASELINE_ALIAS_ORACLES={
  stable_control:{initial:orderedPhase(true,false,null),pre_bounds:orderedPhase(false,false,'C1'),
    post_bounds:{state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C1',chrome:[oracleChrome('W1',1,ORACLE_S)],cg:[oracleCG('C1',ORACLE_S)],orders:[],decisions:[oracleDecision('W1','C1','unique_bounds')]}},
  repeated_order_disagreement:{initial:orderedPhase(true,true,null),pre_bounds:orderedPhase(false,true,'C2'),
    post_bounds:{state:'complete',attempts:1,target:'W1',expected:'C2',mapped:'C1',chrome:[oracleChrome('W2',2),oracleChrome('W1',1,ORACLE_S)],
      cg:[oracleCG('C1',ORACLE_S),oracleCG('C2')],orders:[],decisions:[oracleDecision('W2','C2','unique_bounds'),oracleDecision('W1','C1','unique_bounds')]}},
  initial_bad_prewrite_corrected:{initial:orderedPhase(true,true,null),pre_bounds:orderedPhase(false,false,'C2'),post_bounds:notReachedPhase},
  genuine_cg_replacement:{initial:orderedPhase(true,false,null),pre_bounds:orderedPhase(false,false,'C1'),
    post_bounds:{state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C3',chrome:[oracleChrome('W1',1,ORACLE_S)],cg:[oracleCG('C3',ORACLE_S)],orders:[],decisions:[oracleDecision('W1','C3','unique_bounds')]}},
};
function assertBaselineAliases(scenario,t) {
  for(const [name,baselineExpected]of Object.entries(BASELINE_ALIAS_ORACLES[scenario])){
    // prepareWindowGeometry and setWindow each run the actual verifier before pbnd.
    // Row aliases deduplicate; the two observed decision/relation sequences remain explicit.
    const expected=hasGeometry&&name==='pre_bounds'&&scenario!=='initial_bad_prewrite_corrected'
      ? {...baselineExpected,orders:[...baselineExpected.orders,...baselineExpected.orders],decisions:[...baselineExpected.decisions,...baselineExpected.decisions]}
      : baselineExpected;
    const p=t.phases[name],orders=p.relations.filter(r=>r.kind==='order');
    assert.deepEqual({state:p.state,attempts:p.attempts,target:p.target,expected:p.expected,mapped:p.mapped,chrome:p.chrome,cg:p.cg,orders,decisions:p.decisions},
      expected,`${scenario}/${name}: exact independently expected aliases, row order and actual decisions`);
    // Make the pairing assertion explicit, rather than independently checking
    // two sets that could silently lose or reverse their positional relation.
    assert.deepEqual(orders.map(r=>r.windows.map((w,i)=>[w,r.cgs[i]])),
      expected.orders.map(r=>r.windows.map((w,i)=>[w,r.cgs[i]])),`${scenario}/${name}: exact ordered W/C pairs`);
  }
  const p=t.phases.post_url,expected=scenario==='stable_control'?BASELINE_ALIAS_ORACLES.stable_control.post_bounds:notReachedPhase;
  assert.deepEqual({state:p.state,attempts:p.attempts,target:p.target,expected:p.expected,mapped:p.mapped,chrome:p.chrome,cg:p.cg,
    orders:p.relations.filter(r=>r.kind==='order'),decisions:p.decisions},expected,`${scenario}: post_url retains the existing success or pre-URL refusal`);
  assert.equal(p.binding,scenario==='stable_control'?'matched':'not_checked');
}

function assertPostURLAliases(scenario,t) {
  const wrong=RETENTION_CASES.includes(scenario),replaced=scenario==='post_url_cg_replacement';
  const unique={state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C1',
    chrome:[oracleChrome('W1',1)],cg:[oracleCG('C1')],orders:[],decisions:[oracleDecision('W1','C1','unique_bounds')]};
  const ordered={state:'complete',attempts:1,target:'W1',expected:'C1',mapped:'C1',
    chrome:[oracleChrome('W2',2,ORACLE_S),oracleChrome('W1',1,ORACLE_S)],cg:[oracleCG('C1',ORACLE_S),oracleCG('C2',ORACLE_S)],
    orders:[oracleOrder(['W1','W2'])],decisions:[oracleDecision('W1','C1'),oracleDecision('W2','C2')]};
  const postURL={...ordered,mapped:replaced?'C3':'C1',
    chrome:[oracleChrome('W2',wrong?1:2,ORACLE_S),oracleChrome('W1',wrong?2:1,ORACLE_S)],
    cg:[oracleCG(replaced?'C3':'C1',ORACLE_S),oracleCG('C2',ORACLE_S)],
    orders:[{...oracleOrder(wrong?['W2','W1']:['W1','W2']),cgs:[replaced?'C3':'C1','C2']}],
    decisions:wrong?[oracleDecision('W1','C1','retained_exact')]:[oracleDecision('W1',replaced?'C3':'C1'),oracleDecision('W2','C2')]};
  const expected={initial:{...unique,expected:null},pre_bounds:{...unique,decisions:[...unique.decisions,...unique.decisions]},
    post_bounds:scenario===RETENTION_CASES[0]?postURL:ordered,post_url:postURL};
  assert.equal(t.status,'complete');assert.deepEqual(t.reasons,[]);
  for(const [name,wanted]of Object.entries(expected)) {
    const p=t.phases[name],orders=p.relations.filter(r=>r.kind==='order');
    assert.deepEqual({state:p.state,attempts:p.attempts,target:p.target,expected:p.expected,mapped:p.mapped,chrome:p.chrome,cg:p.cg,orders,decisions:p.decisions},
      wanted,`${scenario}/${name}: fixed physical model yields exact aliases and ordered pairs`);
    assert.deepEqual(p.ax,name==='initial'||name==='pre_bounds'
      ?{state:'not_called',enumerationStatus:'unobserved',returned_count:null,rows:[]}
      :{state:'called',enumerationStatus:'unobserved',returned_count:0,rows:[]});
    assert.equal(p.structural,name==='initial'||name==='pre_bounds'?'not_checked':'same');
    assert.equal(p.binding,name==='initial'?'not_checked':name==='post_url'&&replaced?'cg_mapping_mismatch':'matched');
  }
}

function assertTrace(receipt) {
  const t = receipt.result._boundsEvidence;
  assert.ok(t, 'diagnostic field must attach after valid actual-source execution');
  assert.deepEqual(projectBoundsTrace(t), t, 'Swift output interoperates with the actual closed JS projector');
  assert.deepEqual(Object.keys(t.phases).sort(),['initial','post_bounds','post_url','pre_bounds']);
  assert.ok(Buffer.byteLength(JSON.stringify(t)) <= 32768);
  const serialized = JSON.stringify(t);
  for (const sentinel of ['synthetic title', 'private title', 'destination.invalid', 'mychrome-native-', 'operation', 'epoch', 'chromePid', 'windowId', 'tabId', 'cgWindow'])
    assert.equal(serialized.includes(sentinel), false, sentinel);
  assert.equal(t.phases.initial.target, 'W1');
  assert.equal(t.phases.initial.expected, null);
  return t;
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bounds-evidence-native-'));
const receiptFile = path.join(temp, 'execution-receipt.json');
const execution = {schema:1, status:'started', directory:temp, artifactsPreserved:true, realNativeEffects:false,
  sourceSha256:SOURCE_SHA, helperSourceSha256:HELPER_SHA, haltEnumSha256:sha(haltBlock), driverSha256:fileSha(DRIVER), sourceBlocks:specs.map(s=>({name:s.name,sha256:sha(block(s.name))})), invocations:[], cases:[]};
const binaries = new Set();
function invoke(file,args,label) {
  assert.ok(file === '/usr/bin/swiftc' || binaries.has(file));
  assert.equal(fileSha(SOURCE), SOURCE_SHA);assert.equal(fileSha(HELPER),HELPER_SHA);
  const stdoutPath = path.join(temp,label+'.stdout.log'), stderrPath = path.join(temp,label+'.stderr.log');
  const out=fs.openSync(stdoutPath,'wx',0o600),err=fs.openSync(stderrPath,'wx',0o600),began=Date.now();
  let child; try { child=spawnSync(file,args,{cwd:temp,stdio:['ignore',out,err]}); } finally {fs.closeSync(out);fs.closeSync(err);}
  execution.invocations.push({argv:[file,...args],elapsedMs:Date.now()-began,exitCode:child.status,signal:child.signal,
    error:child.error?.message??null,stdout:stdoutPath,stderr:stderrPath,stdoutSha256:fileSha(stdoutPath),stderrSha256:fileSha(stderrPath)});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,`Full logs: ${stderrPath}`);
  return fs.readFileSync(stdoutPath,'utf8');
}
function compile(contents,label) {
  const filename=path.join(temp,label+'.swift'),binary=path.join(temp,label),cache=path.join(temp,label+'-module-cache');
  fs.mkdirSync(cache);fs.writeFileSync(filename,contents,{flag:'wx'});binaries.add(binary);
  invoke('/usr/bin/swiftc',['-module-cache-path',cache,filename,'-o',binary],label+'-compile');return binary;
}
let failure;
try {
  const binary=compile(program,'actual');
  const capturedTraces=new Map(),cached=new Map();
  execution.documentCases=[];
  for(const scenario of DOCUMENT_CASES) {
    const off=JSON.parse(invoke(binary,[scenario,'disabled'],scenario+'-disabled'));
    const on=JSON.parse(invoke(binary,[scenario,'enabled'],scenario+'-enabled'));
    execution.documentCases.push({scenario,ok:on.result.ok,afterCreationVerify:on.afterCreationVerify,documentReadCount:on.documentReadCount});
    assert.deepEqual(behavior(on),behavior(off),'Document evidence has identical effects with diagnostics enabled or disabled.');
    assert.equal(on.documentReadCount,off.documentReadCount);
    assert.deepEqual(on.afterCreationVerify,off.afterCreationVerify);
    const healthy=['document_healthy','document_nonfirst_active','document_cap9','document_cap16'].includes(scenario);
    const refused=['document_swap','document_partial_swap','document_strong_title','document_extra_cg'].includes(scenario);
    assert.equal(on.result.ok,!refused,scenario+' creation result');
    assert.equal((on.target??on.verifications.at(-1).target).cgWindow,20,'The originally selected CG20 is never silently retargeted.');
    assert.equal(on.creationPinCleared,true,'Creation pin still clears before the next verify.');
    if(refused) { assert.equal(on.target,null);assert.equal(on.afterCreationVerify,undefined); }
    else {
      assert.equal(on.afterCreationVerify.ok,healthy,scenario+': only complete fresh documents resolve the next verify after the request pin has cleared.');
      assert.equal(on.afterCreationVerify.pinCleared,true);
      assert.deepEqual(on.afterCreationVerify.reads,{snapshots:2,cg:1,ax:1},'No extra mapping, polling or snapshots.');
    }
    const total=scenario==='document_cap9'?9:scenario==='document_cap16'?16:scenario==='document_cap17'?17:2;
    assert.equal(on.documentReadCount,total>2?(total-1)*3+(total<=16?total*2:0):4,scenario+' bounded per-read document count');
    if(!refused) assert.equal(on.afterCreationVerify.documentReads,total<=16?total:0);
    for(const event of on.events.filter(e=>e.kind==='document')) {
      const cg=on.events.find(e=>e.kind==='cg'&&e.cycle===event.cycle);
      assert.ok(cg&&cg.ordinal<event.ordinal);
      const after=on.events.find(e=>e.kind==='snapshot'&&e.read==='after_ax'&&e.cycle===event.cycle);
      assert.ok(after&&event.ordinal<after.ordinal,'Document is read inside the existing before/after snapshot boundary.');
    }
    const trace=assertTrace(on),branches=trace.phases.post_url.decisions.map(d=>d.branch);
    if(healthy||scenario==='document_swap')assert.ok(branches.includes('document_exact'),scenario);
    else assert.ok(!branches.includes('document_exact'),'Partial/missing/changed evidence cannot upgrade the group.');
    if(scenario==='document_partial_swap')assert.ok(branches.includes('document_conflict_refused'),'Fresh contrary content vetoes a stale creation pin.');
    if(scenario==='document_strong_title')assert.ok(branches.includes('ax_strict'),'Existing stronger title decisions remain authoritative.');
  }
  // The same fixed-physical-CG oracle runs against a frozen old source without
  // treating compilation errors or expected refusals as a successful RED proof.
  for(const scenario of RETENTION_CASES) {
    const off=JSON.parse(invoke(binary,[scenario,'disabled'],scenario+'-disabled'));
    const on=JSON.parse(invoke(binary,[scenario,'enabled'],scenario+'-enabled'));
    assert.deepEqual(behavior(on),behavior(off));
    assert.equal(on.initialPhysicalTruth['2'],20);assert.equal(on.maps[0].mapping['2'],20);
    assert.equal(on.physicalAfter.find(w=>w.windowId===2).cgWindow,20);assert.equal(on.replacementApplied,false);
    cached.set(scenario,{off,on});
  }
  execution.retentionGate=RETENTION_CASES.map(scenario=>{
    const {on}=cached.get(scenario);
    return {scenario,physicalCG:20,ok:on.result.ok,targetCG:on.target?.cgWindow??null,error:on.result.error??null,
      lastMapping:on.maps.at(-1).mapping,ledger:on.ledger.map(x=>[x.stage,x.delivery])};
  });
  assert.deepEqual(execution.retentionGate.map(({scenario,physicalCG,ok,targetCG})=>({scenario,physicalCG,ok,targetCG})),
    RETENTION_CASES.map(scenario=>({scenario,physicalCG:20,ok:true,targetCG:20})),
    'Fixed physical CG20 survives post-bounds and post-URL order disagreement without retargeting.');
  for(const scenario of [...SCENARIOS,...POST_URL_SCENARIOS,RETENTION_CASES[0],...PIN_CONTROLS,...EXTRA]) {
    const off=cached.get(scenario)?.off??JSON.parse(invoke(binary,[scenario,'disabled'],scenario+'-disabled'));
    const on=cached.get(scenario)?.on??JSON.parse(invoke(binary,[scenario,'enabled'],scenario+'-enabled'));
    assert.equal(Object.hasOwn(off.result,'_boundsEvidence'),false,'default no private field');
    assert.deepEqual(behavior(on),behavior(off),'diagnostics preserve result/error class, descriptors, maps, writes, order, ledger and read/AX counts');
    assert.equal(on.creationPinCleared,true,'Request pin is cleared on every normal, Failure, DialogFailure and Halt exit.');
    if(SCENARIOS.includes(scenario)) assertCase(behavior(on));
    if(POST_URL_SCENARIOS.includes(scenario)||RETENTION_CASES.includes(scenario)) assertPostURLCase(behavior(on));
    if([...SCENARIOS,'strict_ax','empty_title','changed_title'].includes(scenario)) {
      assert.ok(on.pinObservations.every(p=>p===null),'Order/title-derived initial mappings never establish a retention pin.');
      assert.ok(on.uniqueCaptures.every(c=>Object.keys(c.unique).length===0));
    }
    if(['typed_halt','typed_dialog','invalid_requested'].includes(scenario)) {
      assert.equal(Object.hasOwn(on.result,'_boundsEvidence'),false);
      assert.equal(on.errorClass,scenario==='typed_halt'?'Halt':scenario==='typed_dialog'?'DialogFailure':'Failure');
      if(scenario==='typed_halt')assert.equal(on.result.error,'terminated');
    } else {
      const t=assertTrace(on),p=t.phases;capturedTraces.set(scenario,t);
      if(POST_URL_SCENARIOS.includes(scenario)||RETENTION_CASES.includes(scenario)) assertPostURLAliases(scenario,t);
      if(PIN_CONTROLS.includes(scenario)) assertPinControl(behavior(on),t);
      const retentionPhases=Object.entries(p).flatMap(([name,frame])=>frame.decisions.filter(d=>d.branch==='retained_exact').map(()=>name));
      assert.deepEqual(retentionPhases,scenario===RETENTION_CASES[0]?['post_bounds','post_url']
        :[RETENTION_CASES[1],'post_url_existing_cg_swap_boundary'].includes(scenario)?['post_url']:[],
        'retained_exact occurs only in the authorized conflicting-order branch.');
      if(SCENARIOS.includes(scenario)) {
        assertBaselineAliases(scenario,t);
        assert.equal(p.initial.state,'complete');assert.equal(p.initial.attempts,1);
        assert.deepEqual(p.initial.ax,{state:'called',enumerationStatus:'unobserved',returned_count:0,rows:[]});
        assert.ok(p.initial.decisions.some(d=>d.w==='W1'&&d.branch==='order'));
        assert.equal(p.initial.mapped,p.pre_bounds.expected);
        assert.equal(p.pre_bounds.binding,scenario==='initial_bad_prewrite_corrected'?'cg_mapping_mismatch':'matched');
        assert.equal(p.post_bounds.binding,scenario==='stable_control'?'matched':scenario==='initial_bad_prewrite_corrected'?'not_checked':'cg_mapping_mismatch');
      }
      if(['initial_cg_nil','initial_duplicate_rows'].includes(scenario)) {assert.ok(!t.reasons.includes('row_cap'));assert.ok(p.initial.chrome.some(r=>r.w==='W1'));assert.equal(on.counts.bounds,0);assert.equal(p.initial.structural,scenario==='initial_cg_nil'?'unavailable':'changed');}
      if(scenario==='initial_duplicate_rows') assert.deepEqual(p.initial.firstStructureFailure,{scope:'other',field:'duplicate_id'});
      if(scenario==='structural_change') {
        assert.equal(p.initial.structural,'changed');assert.equal(on.result.bindingReason,'snapshot_structure_changed');
        assert.equal(p.initial.firstStructureFailure.field,'bounds');
        assert.ok(['target','other'].includes(p.initial.firstStructureFailure.scope),'First Dictionary failure is not an exhaustive target-stability check.');
      }
      if(Object.hasOwn(STRUCTURE_FAILURES,scenario)) {
        assert.deepEqual(p.initial.firstStructureFailure,STRUCTURE_FAILURES[scenario]);
        assert.equal(p.initial.structural,'changed');assert.equal(on.result.bindingReason,'snapshot_structure_changed');
        assert.equal(on.result.error,'native_target_changed');assert.equal(on.result.stage,'native_window_binding');
        assert.equal(on.counts.creates,1);assert.equal(on.counts.bounds,0);assert.equal(on.counts.url,0);assert.equal(on.counts.pumps,0);
        assert.equal(on.counts.ax,1);assert.equal(on.counts.cg,1);assert.equal(on.counts.snapshots,3);
        for(const name of ['pre_bounds','post_bounds','post_url']) assert.equal(Object.hasOwn(p[name],'firstStructureFailure'),false);
      }
      if(scenario==='ordinary_failure') {assert.equal(on.result.error,'native_read_unknown');assert.equal(p.initial.structural,'unavailable');}
      if(scenario==='empty_title') for(const name of ['initial','pre_bounds']) {
        const titles=p[name].relations.filter(r=>r.kind==='title');
        const expectedTitles=hasGeometry&&name==='pre_bounds'?['W2','W1','W2','W1']:['W2','W1'];
        assert.equal(titles.length,expectedTitles.length,`empty-title/${name}: both real title short-circuits per actual verify must be observed`);
        assert.deepEqual(titles.map(r=>r.w),expectedTitles,`empty-title/${name}: source traversal identities`);
        for(const r of titles) {assert.equal(r.titleNonempty,false);assert.equal(r.titlesChanged,null);assert.equal(r.counts.rivals,null);}
      }
      if(scenario==='changed_title') assert.ok(p.initial.relations.some(r=>r.kind==='title'&&r.titlesChanged===true&&r.counts.rivals===null));
      if(scenario==='strict_ax') {assert.ok(p.initial.decisions.some(d=>d.branch==='ax_strict'));assert.ok(p.initial.relations.some(r=>r.kind==='title'&&r.counts.strict===1&&r.counts.loose===null));}
      if(scenario==='failed_ax_empty') {assert.deepEqual(p.initial.ax,{state:'called',enumerationStatus:'unobserved',returned_count:0,rows:[]});assert.ok(on.axEnumerationModel.failed>0);assert.equal(on.axEnumerationModel.empty,0);assert.deepEqual(t,capturedTraces.get('stable_control'),'failed nil and successful empty fold to the same observed trace');}
      if(scenario==='stable_control') {assert.equal(on.axEnumerationModel.failed,0);assert.ok(on.axEnumerationModel.empty>0);}
      if(scenario==='repeat_initial') {assert.equal(p.initial.attempts,3);assert.equal(on.counts.pumps,2);assert.equal(on.result.ok,true);}
      if(scenario==='duplicate_claims') {
        assert.ok(p.initial.decisions.some(d=>d.branch==='duplicate_claim_removed'));assert.equal(p.initial.mapped,null);assert.equal(on.counts.bounds,0);
        const assignments=p.initial.decisions.filter(d=>d.branch==='order'),removals=p.initial.decisions.filter(d=>d.branch==='duplicate_claim_removed');
        assert.deepEqual(assignments,[oracleDecision('W1','C1'),oracleDecision('W2','C1')],'duplicate claims: both actual ordered assignments remain visible');
        assert.equal(p.initial.decisions.length,4,'duplicate claims: exactly two assignments followed by two removals');
        assert.deepEqual(p.initial.decisions.slice(0,2),assignments,'duplicate claims: assignments precede dictionary filtering');
        // Dictionary filter visitation order is unspecified; identity/count is exact.
        assert.deepEqual([...removals].sort((a,b)=>a.w.localeCompare(b.w)),[oracleDecision('W1','C1','duplicate_claim_removed'),oracleDecision('W2','C1','duplicate_claim_removed')],
          'duplicate claims: both assigned identities must be removed exactly once');
        assert.deepEqual(p.initial.relations.filter(r=>r.kind==='order'),[{...oracleOrder(['W1','W2']),cgs:['C1']}],
          'duplicate claims: schema keeps the unique alias list while preserving observed counts');
        assert.equal(t.status,'incomplete','BE-COV-01: duplicate relationship identities must mark the trace incomplete');
        assert.equal(p.initial.state,'incomplete','BE-COV-01: the affected phase must be incomplete');
        assert.ok(t.reasons.includes('projection_failure'),'BE-COV-01: omitted repeated identity requires explicit projection_failure');
      }
      if(scenario==='invalid_geometry') {assert.ok(t.reasons.includes('geometry_out_of_range'));assert.equal(p.initial.chrome.find(r=>r.w==='W1').rect,null);}
      if(scenario==='invalid_index') {assert.ok(t.reasons.includes('index_out_of_range'));assert.equal(p.initial.chrome.find(r=>r.w==='W1').index,null);}
      if(scenario==='missing_window') {assert.equal(p.pre_bounds.binding,'window_missing');assert.equal(p.pre_bounds.target,'W1');assert.equal(p.pre_bounds.mapped,null);}
      if(scenario==='initial_unique_duplicate_claim') {
        assert.equal(on.result.error,'new_window_unconfirmed');assert.equal(on.counts.bounds,0);assert.equal(on.counts.url,0);
        assert.ok(on.uniqueCaptures.length>0);assert.ok(on.uniqueCaptures.every(c=>Object.keys(c.unique).length===0));
        assert.ok(p.initial.decisions.some(d=>d.branch==='unique_bounds'));
        assert.ok(p.initial.decisions.some(d=>d.branch==='duplicate_claim_removed'));
        assert.equal(p.initial.mapped,null,'A unique-bounds assignment removed by the final duplicate filter is never strong evidence.');
      }
    }
    for(const [name,trace] of Object.entries(on.collectorFixtures)) {
      assert.deepEqual(projectBoundsTrace(trace),trace,`collector fixture ${name}`);
      assert.ok(Buffer.byteLength(JSON.stringify(trace))<=32768);
    }
    for(const [name,value] of Object.entries(on.admissionFixtures)) assert.deepEqual(value,name==='other_kind'?{other:true}:{enabled:name==='integer_one'},`actual execute admission fragment ${name}`);
    const fixtures=on.collectorFixtures;
    for(const reason of ['window_alias_cap','cg_alias_cap','relation_cap','decision_cap','count_saturated']) assert.ok(fixtures.caps.reasons.includes(reason),reason);
    assert.equal(fixtures.caps.phases.initial.relations[0].counts.hits,65535);
    assert.deepEqual(fixtures.bytes.reasons,['byte_cap']);
    assert.ok(fixtures.invalid_event.reasons.includes('projection_failure'));
    assert.deepEqual(fixtures.row_reference.reasons,['projection_failure']);assert.equal(fixtures.row_reference.status,'unavailable');
    assert.equal(fixtures.retained_branch.status,'complete');
    assert.deepEqual(fixtures.retained_branch.phases.post_url.decisions,[oracleDecision('W1','C1','retained_exact')]);
    assert.deepEqual(fixtures.first_structure_failure.phases.initial.firstStructureFailure,{scope:'other',field:'bounds'},'First observed structure failure is retained without allocating a raw identity.');
    assert.equal(fixtures.first_structure_failure.phases.initial.chrome.length,1);
    for(const [name,structural] of Object.entries({legacy_structure_changed:'changed',structure_same:'same',structure_unavailable:'unavailable'})) {
      assert.equal(fixtures[name].phases.initial.structural,structural);
      assert.equal(Object.hasOwn(fixtures[name].phases.initial,'firstStructureFailure'),false,'Legacy and non-failing observations keep their original shape.');
    }
    for(const name of ['invalid_structure_field','invalid_structure_count_window','invalid_structure_result']) {
      assert.ok(fixtures[name].reasons.includes('projection_failure'));
      assert.equal(Object.hasOwn(fixtures[name].phases.initial,'firstStructureFailure'),false);
    }
    execution.cases.push({scenario,counts:on.counts,errorClass:on.errorClass,diagnosticStatus:on.result._boundsEvidence?.status??'absent'});
  }
  // A meaningful mutant compiles, performs the same refusal/write path, then fails only the diagnostic assertion.
  const drop='if let evidence { error.details["_boundsEvidence"] = evidence.project() }';
  assert.equal(program.split(drop).length,2);
  const mutant=compile(program.replace(drop,'if let evidence { _ = evidence }'),'dropped-failure-capture');
  const mutation=JSON.parse(invoke(mutant,['repeated_order_disagreement','enabled'],'mutant-valid-execution'));
  assertCase(behavior(mutation));
  assert.throws(()=>assertTrace(mutation),/diagnostic field must attach/);
  execution.mutant={compiled:true,validBehavior:true,killedBy:'diagnostic field must attach'};
  const observedPostURL='let after = try verifyWindowGeometry(made, plan: plan, tx: tx, observe: observe)';
  assert.equal(program.split(observedPostURL).length,2);
  const blind=compile(program.replace(observedPostURL,'let after = try verifyWindowGeometry(made, plan: plan, tx: tx)'),'dropped-post-url-observer');
  const blindReceipt=JSON.parse(invoke(blind,['post_url_order_disagreement','enabled'],'mutant-post-url-valid-success'));
  assertPostURLCase(behavior(blindReceipt));
  assert.throws(()=>assertPostURLAliases('post_url_order_disagreement',assertTrace(blindReceipt)),assert.AssertionError);
  execution.postURLMutant={compiled:true,validBehavior:true,killedBy:'missing post_url observations'};
  execution.documentMutants=[];
  for(const [name,needle,replacement,scenario,assertion] of [
    ['document-global-unique','oldBytes == nextBytes, beforeCounts[oldBytes] == 1, afterCounts[oldBytes] == 1','oldBytes == nextBytes','document_global_duplicate_inactive',
      r=>assert.equal(r.afterCreationVerify.ok,false,'Inactive duplicate must prevent document assignment.')],
    ['document-freshness','oldBytes == nextBytes, beforeCounts[oldBytes] == 1, afterCounts[oldBytes] == 1','beforeCounts[oldBytes] == 1, afterCounts[oldBytes] == 1','document_active_url_change',
      r=>assert.equal(r.afterCreationVerify.ok,false,'Active URL change must prevent document assignment.')],
    ['document-veto','proposal.contains { window, number in','false && proposal.contains { window, number in','document_partial_swap',
      r=>assert.equal(r.result.ok,false,'Fresh contrary evidence must veto the old creation pin.')],
  ]) {
    assert.equal(program.split(needle).length,2);
    const altered=compile(program.replace(needle,replacement),name);
    const result=JSON.parse(invoke(altered,[scenario,'enabled'],name+'-valid-execution'));
    assert.equal(result.result.ok,true,'Mutant reaches valid success; compilation/runtime errors cannot kill it.');
    assert.equal(result.creationPinCleared,true);
    assert.equal(result.counts.creates,1);assert.equal(result.counts.bounds,1);assert.equal(result.counts.url,1);
    assert.throws(()=>assertion(result),assert.AssertionError);
    execution.documentMutants.push({name,scenario,compiled:true,validSuccess:true,killedBy:'behavioral refusal assertion'});
  }
  execution.status='passed';
} catch(error) {failure=error;execution.status='failed';execution.failure={name:error.name,message:error.message,stack:error.stack};}
finally {execution.sourceUnchanged=fileSha(SOURCE)===SOURCE_SHA&&fileSha(HELPER)===HELPER_SHA;fs.writeFileSync(receiptFile,JSON.stringify(execution,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify({status:execution.status,receipt:receiptFile,directory:temp,artifactsPreserved:true,cases:execution.cases.length}));
if(failure) throw failure;
