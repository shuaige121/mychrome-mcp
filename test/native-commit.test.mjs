/* The compiled candidate Session in dry mode plus the exact pure commit core.
 * No Chrome process, AX access, Apple Event, hardware input or runtime install. */
import './isolate-settings.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { test } from 'node:test';

const bin = new URL('../bin/cgevent', import.meta.url).pathname;
const target = { chromePid: 42, windowId: 1, tabId: 5, cgWindow: 7 };
const scene = { appPid: 9, chromePid: 42, chromeWindow: 1, chromeTab: 5, cgWindow: 7 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let serial = 0;
async function session(fn, { hold = true, begin = false } = {}) {
  const child = spawn(bin, ['session'], { env: { ...process.env, CGEVENT_DRYRUN: '1', CHROME_BRIDGE_HABITS: 'off',
    CGEVENT_SEED: 'native-commit', CGEVENT_DRYRUN_PASTEBOARD: `com.chromebridge.dryrun.native${process.pid}.${++serial}` }, stdio: ['pipe','pipe','pipe'] });
  let sequence = 0, errors = '', ended = false;
  child.stderr.on('data', chunk => { errors += chunk; });
  const pending = new Map(), replies = [];
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const r = JSON.parse(line); replies.push(r); if(r.op === "end") ended = true;
    const entry = pending.get(r.id);
    if (entry) { pending.delete(r.id); clearTimeout(entry.timer); entry.resolve(r); }
  });
  const req = (op, fields = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(Error(`No ${op} response: ${errors}`)), 6000);
    pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ op, id, ...fields }) + '\n');
  });
  let operation = 0, epoch = 1, restoreToken;
  const native = (intent, fields = {}) => req('nativeChrome', { schema: 1, epoch, operationId: `fixture-${++operation}`, intent, ...fields });
  const bind = (value = target, fields = {}) => req('bindNativeTarget', { schema: 1, epoch, target: value, ...fields });
  const record = async () => { const r = await req('recordNativeScene', { schema: 1, epoch, scene }); assert.equal(r.ok,true,JSON.stringify(r)); restoreToken = r.restoreToken; return r; };
  const restore = fields => native({ kind:'restoreScene' }, { policy:'restore', restoreToken, ...fields });
  try {
    if (hold) { const r = await req('hold', { takeoverIdleMs: 10000 }); assert.equal(r.ok,true,JSON.stringify(r)); epoch = r.epoch; }
    if (begin) assert.equal((await req('begin', { chromePid:42, window:7, windowBounds:{x:0,y:0,w:800,h:600} })).ok,true);
    await fn({ req, native, bind, record, restore, epoch, child, replies });
  } finally {
    if (!ended && child.exitCode === null && !child.stdin.destroyed && !child.stdin.writableEnded) {
      await req('end').catch(() => {}); child.stdin.end();
    }
    assert.equal(await exit, 0, errors);
    for (const p of pending.values()) clearTimeout(p.timer);
  }
}

const assertNone = r => { assert.equal(r.ok,false,JSON.stringify(r)); assert.equal(r.inputDelivery,'not_sent'); assert.deepEqual(r.stages ?? [],[]); };

const autoTemplate = { id: 'fixture-native-inactivity', version: 1, title: 'Session inactive',
  texts: ['Your session is inactive. Keep this session open?'], buttons: ['Keep session', 'Exit session'], hasField: false };
const autoConstraint = { version: 1, origin: 'http://127.0.0.1:17744', template: autoTemplate, semantic: 'keep_session', button: 'Keep session' };
test('native same-owner auto validates fresh origin, complete template, fields and original token before one press', async () => {
  for (const [name, patch, constraint, expected] of [
    ['exact', {}, autoConstraint, null],
    ['wrong origin', { currentURL: 'https://other.example/' }, autoConstraint, 'auto_skipped_origin_mismatch'],
    ['missing origin', { currentURL: '' }, autoConstraint, 'auto_skipped_origin_unverified'],
    ['incomplete', { dialog: { complete: false } }, autoConstraint, 'auto_skipped_incomplete_template'],
    ['extra suffix', { dialog: { texts: [autoTemplate.texts[0] + ' different'] } }, autoConstraint, 'auto_skipped_template_mismatch'],
    ['field', { dialog: { fields: 1 } }, autoConstraint, 'auto_skipped_template_mismatch'],
    ['button order', { dialog: { buttons: [...autoTemplate.buttons].reverse() } }, autoConstraint, 'auto_skipped_template_mismatch'],
    ['extra authority', {}, { ...autoConstraint, arbitrary: true }, 'auto_skipped_template_mismatch'],
    ['total character bound', { dialog: { title: 'x'.repeat(2048), texts: ['y'.repeat(2048)] } },
      { ...autoConstraint, template: { ...autoTemplate, title: 'x'.repeat(2048), texts: ['y'.repeat(2048)] } }, 'auto_skipped_template_mismatch'],
  ]) await session(async s => {
    const dialog = { instance: 'A', open: true, ...autoTemplate, fields: 0, complete: true, ...patch.dialog };
    await s.req('_native', { currentURL: autoConstraint.origin + '/fixture', ...patch, dialog });
    const probe = await s.req('inspectDialog', { schema: 1, target }); await s.bind();
    const result = await s.native({ kind: 'dialogAnswer', dialogToken: probe.identity.dialogToken,
      button: autoConstraint.button, autoConstraint: constraint });
    if (expected) { assertNone(result); assert.equal(result.error, expected, name); }
    else { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.inputDelivery, 'sent'); assert.deepEqual(result.stages.map(s => s.stage), ['dialog_press']); }
  });
});

test('native auto rechecks a changed origin and retained AX instance after its initial probe', async () => session(async s => {
  const dialog = { instance: 'A', open: true, ...autoTemplate, fields: 0, complete: true };
  await s.req('_native', { currentURL: autoConstraint.origin + '/fixture', dialog });
  const probe = await s.req('inspectDialog', { schema: 1, target }); await s.bind();
  await s.req('_native', { currentURL: 'https://changed.example/', dialog });
  const result = await s.native({ kind: 'dialogAnswer', dialogToken: probe.identity.dialogToken, button: autoConstraint.button, autoConstraint });
  assertNone(result); assert.equal(result.error, 'auto_skipped_origin_mismatch');
  await s.req('_native', { currentURL: autoConstraint.origin, dialog: { ...dialog, instance: 'B' } });
  assertNone(await s.native({ kind: 'dialogAnswer', dialogToken: probe.identity.dialogToken, button: autoConstraint.button, autoConstraint }));
}));

test('removing only production native fresh-origin comparison defeats the intended origin negative', () => {
  const source = fs.readFileSync(new URL('../src/native-chrome.swift', import.meta.url), 'utf8');
  const extract = (marker, end = '\n        }') => { const start = source.indexOf(marker); assert.ok(start >= 0, marker); return source.slice(start, source.indexOf(end, start) + end.length); };
  const helpers = ['promptText', 'promptOrigin', 'dialogInt'].map(name => extract(`static func ${name}(`, '\n}')).join('\n');
  const body = extract('        func checkAutoConstraint(');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-auto-origin-'));
  const run = implementation => {
    const file = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'probe');
    fs.writeFileSync(file, `import Foundation\nimport CoreFoundation\nstruct Failure: Error { init(_ a: String, _ b: String) {} }\nstruct Target { let tabId = 5 }\nstruct Row { let tabURLs = [5: "https://changed.example/path"] }\nenum ChromeNative { ${helpers} }\nfunc verify(_ t: Target, requireActive: Bool) throws -> Row { Row() }\nfunc requireAlive(_ stage: String) throws {}\n${implementation}\nlet c = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8))\nvar accepted = false\ndo { try checkAutoConstraint(c, target: Target(), title: "Session inactive", texts: ["Your session is inactive. Keep this session open?"], buttons: ["Keep session", "Exit session"], hasField: false, button: "Keep session"); accepted = true } catch {}\nprint(accepted)\n`);
    execFileSync('/usr/bin/swiftc', [file, '-o', binary], { stdio: 'pipe' });
    return execFileSync(binary, [JSON.stringify(autoConstraint)], { encoding: 'utf8' }).trim();
  };
  try {
    assert.equal(run(body), 'false');
    const guard = 'guard current == origin else { throw Failure("auto_skipped_origin_mismatch", "dialog_auto_origin") }'; assert.ok(body.includes(guard));
    assert.throws(() => assert.equal(run(body.replace(guard, '/* remove fresh-origin comparison in inert fixture */')), 'false'), assert.AssertionError);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('held preparation binds once, begin preserves epoch, and activation reports confirmed PID', async () => session(async s => {
  await s.record(); assert.equal((await s.bind()).ok,true);
  const begin = await s.req('begin',{chromePid:42,window:7,windowBounds:{x:0,y:0,w:800,h:600}});
  assert.equal(begin.epoch,s.epoch);
  const r = await s.native({kind:'activate',tabId:5,windowId:1});
  assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.frontmostPid,42); assert.equal(r.inputDelivery,'sent');
  assert.ok(r.stages.length > 0); assert.ok(r.stages.every(x => x.delivery === 'sent'));
}));

test('stale epoch, cross-window bind and mismatching begin refuse before native entry', async () => session(async s => {
  assert.equal((await s.bind()).ok,true);
  assert.equal((await s.bind({...target,windowId:2,cgWindow:8})).error,'native_target_rebind');
  assertNone(await s.native({kind:'selectTab',tabId:5},{epoch:s.epoch+1}));
  assertNone(await s.native({kind:'selectTab',tabId:6}));
  assert.equal((await s.req('begin',{chromePid:42,window:8,windowBounds:{x:0,y:0,w:800,h:600}})).error,'native_target_changed');
}));

test('queued status and Stop are serviced during a synthetic slow metadata read', async () => session(async s => {
  await s.bind(); await s.req('_native',{readDelayMs:500});
  const operation = s.native({kind:'activate',tabId:5});
  await sleep(20);
  const start = Date.now();
  const status = await s.req('status'); assert.equal(status.ok,true); assert.ok(Date.now()-start < 450);
  const stop = await s.req('revokeNative',{reason:'task'}); assert.ok(stop.epoch > s.epoch);
  const result = await operation; assertNone(result); assert.equal(result.error,'aborted');
  const restore = await s.restore(); assertNone(restore);
}));

test('priority end during slow preparation returns terminal operation then end', async () => session(async s => {
  await s.bind(); await s.req('_native',{readDelayMs:500});
  const operation = s.native({kind:'activate',tabId:5}); await sleep(20);
  const ending = s.req('end'); const r = await operation;
  assertNone(r); assert.equal(r.error,'terminated'); assert.equal((await ending).reason,'end');
}));

test('EOF during a read denies the pending native stage', async () => session(async s => {
  await s.bind(); await s.req('_native',{readDelayMs:500});
  const operation = s.native({kind:'activate',tabId:5}); await sleep(20); s.child.stdin.end();
  assertNone(await operation);
}));

test('Pause denies normal native and CGEvent input but allows healthy held restoration', async () => session(async s => {
  await s.record(); await s.bind();
  const p = await s.req('revokeNative',{reason:'pause'}); assert.equal(p.epoch,s.epoch); assert.equal(p.paused,true);
  assertNone(await s.native({kind:'selectTab',tabId:5}));
  const input = await s.req('key',{key:'return'}); assert.equal(input.ok,false); assert.deepEqual(input.posted,[]);
  const r = await s.restore(); assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.activated,true);
}, { begin:true }));

for (const reason of ['caller','routine','task','conversation']) test(`${reason} cancellation stops an ongoing CGEvent type`, async () => session(async s => {
  const typing = s.req('type',{text:'This sequence must stop before all of its characters are posted.'.repeat(5)});
  await sleep(25); await s.req('revokeNative',{reason});
  const r = await typing; assert.equal(r.ok,false); assert.equal(r.error,'aborted');
  const later = await s.req('key',{key:'return'}); assert.equal(later.ok,false); assert.deepEqual(later.posted,[]);
}, { begin:true }));

test('Pause during a long CGEvent stage stops normal work without releasing the healthy hold', async () => session(async s => {
  await s.record();
  const typing = s.req('type',{text:'A long paused typing stage.'.repeat(10)});
  await sleep(20); await s.req('revokeNative',{reason:'pause'});
  const r = await typing; assert.equal(r.error,'native_paused'); assert.equal(r.takeover.active,true);
  assert.equal((await s.restore()).ok,true);
}, { begin:true }));

test('Esc after AXSet retains its sent stage and sends no press or restoration', async () => session(async s => {
  await s.req('_native',{dialog:{instance:'A',open:true,buttons:['OK'],fields:1}});
  const probe = await s.req('inspectDialog',{schema:1,target}); await s.bind(); await s.record();
  const firstEsc = s.req('_inject',{kind:'esc',at:'dialog_readback'});
  const secondEsc = s.req('_inject',{kind:'esc',at:'dialog_readback'});
  const r = await s.native({kind:'dialogAnswer',dialogToken:probe.identity.dialogToken,button:'OK',text:'fixture'});
  await Promise.all([firstEsc,secondEsc]);
  assert.equal(r.ok,false); assert.equal(r.error,'aborted'); assert.equal(r.inputDelivery,'sent'); assert.equal(r.noRetry,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['dialog_set']);
  assertNone(await s.restore());
}));

test('tap loss after AXSet marks the unresolved transaction unknown and forbids every later stage', async () => session(async s => {
  await s.req('_native',{dialog:{instance:'A',open:true,buttons:['OK'],fields:1}});
  const probe = await s.req('inspectDialog',{schema:1,target}); await s.bind(); await s.record();
  const disabled = s.req('_inject',{kind:'tapDisabled',at:'dialog_readback'});
  const r = await s.native({kind:'dialogAnswer',dialogToken:probe.identity.dialogToken,button:'OK',text:'fixture'});
  await disabled;
  assert.equal(r.ok,false); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.noRetry,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['dialog_set']); assertNone(await s.restore());
}));

test('original dialog token survives prime to hold, replacement and foreign tokens fail closed', async () => session(async s => {
  await s.req('_native',{dialog:{instance:'A',open:true,buttons:['OK'],fields:1}});
  const first = await s.req('inspectDialog',{schema:1,target}); assert.equal(first.ok,true);
  await s.req('hold'); await s.bind();
  const second = await s.req('inspectDialog',{schema:1,target,dialogToken:first.identity.dialogToken});
  assert.equal(second.identity.dialogToken,first.identity.dialogToken);
  await s.req('_native',{dialog:{instance:'B',open:true,buttons:['OK'],fields:1}});
  assert.equal((await s.req('inspectDialog',{schema:1,target,dialogToken:first.identity.dialogToken})).error,'dialog_identity_mismatch');
  assertNone(await s.native({kind:'dialogAnswer',dialogToken:first.identity.dialogToken,button:'OK'}));
  assertNone(await s.native({kind:'dialogAnswer',dialogToken:'f'.repeat(64),button:'OK'}));
}, { hold:false }));

test('unknown primitive result freezes native retries and subsequent ordinary input', async () => session(async s => {
  await s.bind(); await s.req('_native',{failStage:'select_tab'});
  const r = await s.native({kind:'selectTab',tabId:5});
  assert.equal(r.inputDelivery,'unknown'); assert.equal(r.noRetry,true); assert.equal(r.stages.length,1);
  assertNone(await s.native({kind:'selectTab',tabId:5}));
  const input = await s.req('key',{key:'return'}); assert.equal(input.ok,false); assert.deepEqual(input.posted,[]);
}, { begin:true }));

test('non-takeover preparation requires monitored begin and respects physical interruption', async () => session(async s => {
  assert.equal((await s.bind()).error,'not_begun');
  await s.req('begin',{chromePid:42,window:7,windowBounds:{x:0,y:0,w:800,h:600}}); await s.record(); await s.bind();
  assert.equal((await s.native({kind:'selectTab',tabId:5})).ok,true);
  await s.req('_inject',{kind:'key'}); assertNone(await s.native({kind:'activate',tabId:5})); assertNone(await s.restore());
}, { hold:false }));

test('creation is single-use, pinned, and never rebinds an already bound window', async () => session(async s => {
  await s.record();
  const r = await s.native({kind:'newWindow',chromePid:42,displayId:1,url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}});
  assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.windowId,2); assert.equal(r.creationAttempted,true);
  assertNone(await s.native({kind:'newWindow',chromePid:42,displayId:1,url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}}));
  assert.equal((await s.bind()).error,'native_target_rebind');
}));

test('compiled profile creation uses the inert data marker and commits once to its exact new target', async () => session(async s => {
  await s.record();
  const r = await s.native({kind:'newWindow',chromePid:42,displayId:1,profile:'Profile 3',url:'https://example.invalid/',bounds:{left:40,top:40,width:800,height:600}});
  assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.creationAttempted,true); assert.equal(r.inputDelivery,'sent');
  assert.deepEqual([r.chromePid,r.windowId,r.tabId,r.cgWindow],[42,2,6,8]);
  assert.deepEqual(r.bounds,{left:40,top:40,width:800,height:600});
  assert.deepEqual(r.stages.map(x=>x.stage),['new_window_create','new_window_bounds','new_window_url']);
  // executeDry preserves the captured creation URL while returning final physical
  // fields. The marker is creation evidence, not a live destination URL readback.
  assert.match(r.url,/^data:text\/plain,mychrome-native-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
}));

test('profile identity uncertainty latches same-Session creation, previously usable ordinary input and restore', async () => session(async s => {
  await s.record();
  const before=await s.req('key',{name:'return'}); assert.equal(before.ok,true,JSON.stringify(before));
  await s.req('_native',{creationScenario:'wrong_marker'});
  const intent={kind:'newWindow',chromePid:42,displayId:1,profile:'Default',url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}};
  const r=await s.native(intent);
  assert.equal(r.ok,false); assert.equal(r.error,'new_window_unconfirmed'); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.noRetry,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['new_window_create']); assert.equal(r.createdWindowId,undefined);
  assertNone(await s.native(intent));
  const after=await s.req('key',{name:'return'}); assert.equal(after.ok,false); assert.deepEqual(after.posted,[]);
  assertNone(await s.restore());
}, {begin:true}));

test('restore requires the opaque original token and preserveSelection cannot cross windows', async () => session(async s => {
  await s.record(); await s.bind({...target,windowId:2,cgWindow:8});
  assertNone(await s.restore({restoreToken:'forged'}));
  const r = await s.native({kind:'restoreScene',preserveSelection:true},{policy:'restore',restoreToken:(await s.record()).restoreToken});
  assertNone(r);
}));

test('production commit core refuses Stop before entry; deleting that exact guard fails the negative', () => {
  const source = fs.readFileSync(new URL('../src/native-chrome.swift',import.meta.url),'utf8');
  const start = source.indexOf('    final class Transaction {');
  const core = source.slice(start,source.indexOf('\n}\n\nextension ChromeNative',start));
  const targetStart = source.indexOf('    struct Target: Equatable {');
  const targetEnd = source.indexOf('\n    struct Failure:',targetStart);
  const intStart = source.indexOf('static func dialogInt(');
  const intEnd = source.indexOf('\nstatic func dialogIdentity(',intStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart && intStart >= 0 && intEnd > intStart,
    'production Target and dialogInt extraction anchors');
  const exactTarget = source.slice(targetStart,targetEnd);
  const exactDialogInt = source.slice(intStart,intEnd);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'native-commit-core-'));
  try {
    const run = body => {
      const file = path.join(tmp,'main.swift'), binary = path.join(tmp,'core');
      fs.writeFileSync(file,`import Foundation\nimport CoreFoundation\nstruct Failure: Error { init(_ a: String, _ b: String) {} }\nenum ChromeNative {\n${exactDialogInt}\n${exactTarget}\n}\ntypealias Target = ChromeNative.Target\n${body}\nvar entered = 0\nlet tx = Transaction(operationId: "test", checkpoint: { _ in throw Failure("stop", "commit") })\ndo { try tx.write("primitive") { entered += 1 } } catch {}\nprint(entered)\n`);
      execFileSync('/usr/bin/swiftc',[file,'-o',binary],{stdio:'pipe'}); return Number(execFileSync(binary,{encoding:'utf8'}).trim());
    };
    assert.equal(run(core),0);
    const write = core.indexOf('func write<T>');
    const check = core.indexOf('            try checkpoint(stage)',write);
    assert.ok(check>write);
    const mutant = core.slice(0,check)+core.slice(check).replace('            try checkpoint(stage)','            // removed final owner guard');
    assert.throws(()=>assert.equal(run(mutant),0),assert.AssertionError);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});

test('real closeTab confirms complete absence before post-close AX and preserves sent refusals', t => {
  const source = fs.readFileSync(process.env.NATIVE_CHROME_SOURCE ?? new URL('../src/native-chrome.swift', import.meta.url), 'utf8');
  const block = declaration => {
    const start = source.indexOf(declaration); assert.ok(start >= 0, declaration);
    const indent = source.slice(source.lastIndexOf('\n', start) + 1, start);
    const end = source.indexOf('\n' + indent + '}', start); assert.ok(end > start, declaration);
    return source.slice(start, end + indent.length + 2);
  };
  const execute = source.indexOf('func execute(_ intent:');
  const start = source.indexOf('case "closeTab":\n', execute), end = source.indexOf('            case "openTab":', start);
  assert.ok(execute >= 0 && start > execute && end > start, 'real closeTab extraction anchors');
  const close = source.slice(start + 'case "closeTab":\n'.length, end);
  // Fixed expectations also apply when NATIVE_CHROME_SOURCE supplies a frozen old source.
  const cases = [
    { name: 'complete_absent_clean', snapshot: 'absent', ax: 'none', expected: 'closed' },
    { name: 'complete_absent_ax_unknown', snapshot: 'absent', ax: 'unknown', expected: 'closed' },
    { name: 'snapshot_unknown', snapshot: 'unknown', ax: 'none', expected: 'native_read_unknown' },
    { name: 'present_prompt', snapshot: 'present', ax: 'prompt', expected: 'close_prompt_pending' },
    { name: 'present_pending', snapshot: 'present', ax: 'none', expected: 'close_pending' },
    { name: 'present_ax_unknown', snapshot: 'present', ax: 'unknown', expected: 'dialog_probe_unknown' },
    { name: 'snapshot_health_revoked', snapshot: 'revoke', ax: 'none', expected: 'native_session_revoked' },
    { name: 'exact_tab_in_other_window', snapshot: 'other_window', ax: 'none', expected: 'close_pending' },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-close-postcheck-'));
  try {
    const file = path.join(tmp, 'main.swift'), binary = path.join(tmp, 'close');
    fs.writeFileSync(file, `import Foundation
import CoreGraphics
struct ChromeNative { static func dialogInt(_ v: Any?) -> Int? { guard let n = v as? Int, n > 0 else { return nil }; return n } }
${['struct DialogFailure:', 'struct Target:', 'struct Failure:', 'struct WindowRow:', 'final class Transaction'].map(block).join('\n')}
// Inert dependencies: no AX, Apple Event, Chrome, helper or input is invoked.
final class Descriptor { func setParam(_ value: Descriptor, forKeyword: String) {} }
final class Probe {
  let read: () throws -> Int?, checkpoint: () throws -> Void
  var firstFailure: Error? = nil
  init(read: @escaping () throws -> Int?, checkpoint: @escaping () throws -> Void) { self.read = read; self.checkpoint = checkpoint }
  func axPageDialog(pid: Int32) throws -> Int? { try read() }
  func check() throws { try checkpoint() }
  func retryFacts(_ error: Error) -> Error { error } // NAT-RETRY: this inert reader never rescans.
}
final class Fixture {
  let scenario: [String: String]
  let t = try! Target(["chromePid":7,"windowId":4,"tabId":9,"cgWindow":11])
  var writes = 0, preflightScans = 0, postScans = 0, snapshotReads = 0, alive = true
  init(_ scenario: [String: String]) { self.scenario = scenario }
  static func code(_ value: String) -> String { value }
  func requireAlive(_ stage: String) throws { if !alive { throw Failure("native_session_revoked", stage) } }
  func object(_ type: String, id: Int, container: Descriptor? = nil) throws -> Descriptor { Descriptor() }
  func event(_ pid: Int32, id: String) -> Descriptor { Descriptor() }
  func send(_ event: Descriptor, stage: String, tx: Transaction) throws { try tx.write(stage) { self.writes += 1 } }
  func probe() -> Probe {
    Probe(read: { [unowned self] in
      try self.requireAlive("native_ax_read")
      if self.writes == 0 { self.preflightScans += 1; return nil }
      self.postScans += 1
      if self.scenario["ax"] == "unknown" { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect") }
      return self.scenario["ax"] == "prompt" ? 1 : nil
    }, checkpoint: { [unowned self] in try self.requireAlive("native_ax_read") })
  }
  func snapshot(_ pid: Int32) throws -> [WindowRow] {
    try requireAlive("native_read"); snapshotReads += 1
    if scenario["snapshot"] == "unknown" { throw Failure("native_read_unknown", "native_read") }
    if scenario["snapshot"] == "revoke" { alive = false }
    // Production snapshot checks health again after its complete successful read.
    try requireAlive("native_read")
    if scenario["snapshot"] == "absent" { return [] }
    let id = scenario["snapshot"] == "other_window" ? 99 : 4
    return [WindowRow(id:id,tabs:[9],activeTab:9,index:1,bounds:CGRect(x:0,y:0,width:800,height:600),minimized:false,title:"fixture")]
  }
  ${block('func noDialog(_ t:')}
  func execute(_ tx: Transaction) throws -> [String: Any] {
${close}
  }
  func run() -> [String: Any] {
    let tx = Transaction(operationId: scenario["name"]!, checkpoint: { [unowned self] stage in try self.requireAlive(stage) })
    let result: [String: Any]
    do { result = tx.result(try execute(tx)) }
    catch let error as Failure { result = tx.result(error.json) }
    catch let error as DialogFailure { result = tx.result(error.json) }
    catch { fatalError("unexpected fixture error: \\(error)") }
    return ["result":result,"writes":writes,"preflightScans":preflightScans,"postScans":postScans,"snapshotReads":snapshotReads]
  }
}
let cases = try! JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [[String:String]]
let results = cases.map { Fixture($0).run() }
print(String(data:try! JSONSerialization.data(withJSONObject:results),encoding:.utf8)!)
`);
    execFileSync('/usr/bin/swiftc', [file, '-o', binary], { stdio: 'pipe' });
    const rows = JSON.parse(execFileSync(binary, [JSON.stringify(cases)], { encoding: 'utf8' }));
    assert.equal(rows.length, cases.length);
    for (const [i, row] of rows.entries()) {
      const item = cases[i], result = row.result, detail = JSON.stringify({ name: item.name, ...row });
      assert.equal(result.ok ? 'closed' : result.error, item.expected, detail);
      assert.equal(row.writes, 1, detail); assert.equal(row.preflightScans, 1, detail);
      assert.ok(row.snapshotReads <= 1, detail);
      assert.equal(result.inputDelivery, 'sent', detail);
      assert.deepEqual(result.stages.map(s => [s.stage, s.delivery]), [['close_tab', 'sent']], detail);
      if (result.ok) { assert.equal(result.closed, true, detail); assert.equal(result.leavePrompt, false, detail); }
      else assert.equal(result.noRetry, true, detail);
      if (['present', 'other_window'].includes(item.snapshot)) assert.equal(row.postScans, 1, detail);
      t.diagnostic(`${item.name}: ${item.expected}; one close; sent${result.noRetry ? '/noRetry' : ''}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

for(const command of [['open','https://example.invalid'],['newwindow','https://example.invalid'],['move','1','0,0,800,600'],['close','5'],['select','5'],['activate','--tab','5'],['restore','9'],['dialog','--press','OK']]) test(`direct ${command[0]} CLI mutation refuses before Chrome discovery`,()=>{
  const cli = new URL('../bin/chromectl',import.meta.url).pathname;
  for(const warm of [false,true]) {
    const r=JSON.parse(execFileSync(cli,warm?['--warm']:command,{encoding:'utf8',input:warm?JSON.stringify(command)+'\n':undefined}));
    assert.equal(r.error,'native_session_required'); assert.equal(r.inputDelivery,'not_sent');
  }
});

test('the exact read-thread mailbox rejects overlap and discards an abandoned result before reopening',()=>{
  const source=fs.readFileSync(new URL('../src/native-chrome.swift',import.meta.url),'utf8');
  const start=source.indexOf('    final class ReadRunner {');
  const runner=source.slice(start,source.indexOf('\n\n    // This core is also compiled',start));
  const failureStart=source.indexOf('    struct ReadFailure:');
  const readFailure=source.slice(failureStart,source.indexOf('\n    final class ReadErrors:',failureStart));
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-read-mailbox-'));
  try {
    const file=path.join(tmp,'main.swift'),binary=path.join(tmp,'mailbox');
    fs.writeFileSync(file,`import Foundation
struct Failure: Error { init(_ a: String, _ b: String) {} }
${readFailure}
struct WindowRow { let id: Int }
let condition = NSCondition()
var readEntered = false, releaseRead = false, invocations = 0
let firstPID: pid_t = 42
enum ChromeNative {
 static func readSnapshot(_ pid: pid_t) throws -> [WindowRow] {
  condition.lock(); invocations += 1
  if invocations == 1 {
   readEntered = true; condition.broadcast()
   while !releaseRead { condition.wait() }
  }
  condition.unlock(); return [WindowRow(id: Int(pid))]
 }
${runner}
}
let reader = ChromeNative.ReadRunner()
let first = try reader.start(firstPID)
condition.lock(); while !readEntered { condition.wait() }; condition.unlock()
var rejected = 0
for _ in 0..<2 { do { _ = try reader.start(99) } catch { rejected += 1 } }
reader.abandon(first)
do { _ = try reader.start(100) } catch { rejected += 1 }
condition.lock(); let beforeRelease = invocations; releaseRead = true; condition.broadcast(); condition.unlock()
let deadline = Date().addingTimeInterval(2)
var second: UInt64?
while second == nil && Date() < deadline { second = try? reader.start(43); if second == nil { Thread.sleep(forTimeInterval: 0.001) } }
guard let second = second else { fatalError("abandoned mailbox did not reopen") }
var received: Result<[WindowRow], ReadFailure>?
while received == nil && Date() < deadline { received = reader.take(second); if received == nil { Thread.sleep(forTimeInterval: 0.001) } }
guard case .success(let rows)? = received else { fatalError("next read did not complete") }
let discarded = reader.take(first) == nil
reader.stop()
print("\\(rejected),\\(beforeRelease),\\(rows[0].id),\\(discarded)")
`);
    execFileSync('/usr/bin/swiftc',[file,'-o',binary],{stdio:'pipe'});
    assert.equal(execFileSync(binary,{encoding:'utf8'}).trim(),'3,1,43,true');
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});

for(const scenario of ['unrelated','wrong_marker','duplicate_marker']) test(`profile creation ${scenario} cannot authorize another window's URL`,async()=>session(async s=>{
  await s.record(); await s.req('_native',{creationScenario:scenario});
  const r=await s.native({kind:'newWindow',chromePid:42,displayId:1,profile:'Default',url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}});
  assert.equal(r.ok,false); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.partial,true); assert.equal(r.noRetry,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['new_window_create']); assert.equal(r.createdWindowId,undefined);
  assertNone(await s.restore());
}));
for(const scenario of ['unrelated','missing_receipt','invalid_receipt']) test(`typed window create ${scenario} has no authoritative created target`,async()=>session(async s=>{
  await s.record(); await s.req('_native',{creationScenario:scenario});
  const r=await s.native({kind:'newWindow',chromePid:42,displayId:1,url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}});
  assert.equal(r.ok,false); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.partial,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['new_window_create']); assert.equal(r.createdWindowId,undefined);
  assertNone(await s.native({kind:'newWindow',chromePid:42,displayId:1,url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}}));
}));
for(const scenario of ['unrelated','wrong_marker','duplicate_marker']) test(`tab creation ${scenario} cannot navigate or select an unrelated tab`,async()=>session(async s=>{
  await s.bind(); await s.req('_native',{creationScenario:scenario});
  const r=await s.native({kind:'openTab',windowId:1,url:'https://example.invalid/',select:true});
  assert.equal(r.ok,false); assert.equal(r.inputDelivery,'unknown'); assert.equal(r.noRetry,true);
  assert.deepEqual(r.stages.map(x=>x.stage),['open_tab_create']);
}));
for(const kind of ['newWindow','openTab']) test(`Stop after ${kind} marker never sends the requested destination URL`,async()=>session(async s=>{
  await s.record(); if(kind==='openTab') await s.bind();
  const stage=kind==='newWindow'?'new_window_url':'open_tab_url';
  const first=s.req('_inject',{kind:'esc',at:stage}),second=s.req('_inject',{kind:'esc',at:stage});
  const r=await s.native(kind==='newWindow'?{kind,chromePid:42,displayId:1,profile:'Default',url:'https://example.invalid/',bounds:{left:0,top:0,width:800,height:600}}:{kind,windowId:1,url:'https://example.invalid/'});
  await Promise.all([first,second]);
  assert.equal(r.ok,false); assert.ok(!r.stages.some(x=>x.stage===stage)); assert.equal(r.noRetry,true);
  assertNone(await s.restore());
}));

for(const screenState of ['locked','asleep','unknown']) test(`screen ${screenState} permanently denies native write and restore`,async()=>session(async s=>{
  await s.record(); await s.bind(); await s.req('_fake',{screenState});
  assertNone(await s.native({kind:'selectTab',tabId:5}));
  await s.req('_fake',{screenState:'awake'}); assertNone(await s.restore());
}));
test('monitored non-takeover input loses authority when its listen-only tap is disabled',async()=>session(async s=>{
  await s.record(); await s.bind(); await s.req('_inject',{kind:'monitorDisabled'});
  assertNone(await s.native({kind:'selectTab',tabId:5}));
  const r=await s.req('key',{name:'return'}); assert.equal(r.ok,false); assert.deepEqual(r.posted,[]);
}, {hold:false,begin:true}));
