import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise extracted production Swift, including main's delegate wiring and signal handlers.
// Foundation-only stand-ins dispatch lifecycle callbacks without starting AppKit or opening a window.
// The fake recorder is our own child process: it handles termination but never monitors any input.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(path.join(root, 'src/menubar.swift'), 'utf8');
function block(marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Production section missing: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed production section: ${marker}`);
}
const controllerHeader = source.match(/final class Controller:[^{]+\{/u)?.[0];
assert.ok(controllerHeader, 'Production Controller declaration missing');
const wiringStart = source.indexOf('        controller = Controller(model: m)');
const wiringEnd = source.indexOf('\n        for sig in [SIGTERM, SIGINT]', wiringStart);
assert.ok(wiringStart >= 0 && wiringEnd > wiringStart, 'Production application wiring missing');
const wiring = source.slice(wiringStart, wiringEnd);
const showConversations = block('    func showConversations(');
const presentationStart = showConversations.indexOf('        NSApp.activate(');
assert.ok(presentationStart >= 0, 'Production window presentation missing');
const presentation = showConversations.slice(presentationStart, showConversations.lastIndexOf('}'));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mychrome-gui-lifecycle-'));
const binary = path.join(tmp, 'lifecycle');
const children = new Set();
const recorderPids = new Set();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const eventually = async (check, message, timeout = 4000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(message);
};

try {
  const swift = path.join(tmp, 'lifecycle.swift');
  writeFileSync(swift, `import Foundation
import Darwin

let args = CommandLine.arguments
let mode = args[1], dir = args[2]
let PID_FILE = dir + "/panel.pid", STATE_FILE = dir + "/state.json"
func mark(_ name: String, _ value: String = "yes") {
    try! value.write(toFile: dir + "/" + name, atomically: true, encoding: .utf8)
}
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
func setMode(_ mode: String) { mark("mode", mode) }
func writeJSON(_ file: String, _ value: [String: Any]) {
    try! JSONSerialization.data(withJSONObject: value).write(to: URL(fileURLWithPath: file))
}
final class ExitApplication {
    func activate(ignoringOtherApps: Bool) { mark("activated") }
    func terminate(_ sender: Any?) -> Never { mark("quit"); exit(0) }
}
let NSApp = ExitApplication()
final class ProbeOnboarding {
    var shouldAutoPresent = mode == "first-guide"
    var stops = 0, dismissals = 0
    func stop() { stops += 1; mark("onboarding-stopped") }
    func dismiss() { dismissals += 1 }
}
final class ProbeNewSession {
    var stops = 0
    func stop() { stops += 1; mark("new-session-stopped") }
}
final class Model {
    let onboarding = ProbeOnboarding()
    let newSession = ProbeNewSession()
    var recorder: Process?
    var cancelling = false
    var conversationVisible = true
    var holding = true
    func hold(_ on: Bool) { holding = on; if !on { mark("released") } }
    ${block('    func prepareForExit()')}
    ${block('    func quit()')}
}

protocol NSWindowDelegate {}
protocol NSApplicationDelegate: AnyObject {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
}
final class NSApplication {
    weak var delegate: NSApplicationDelegate?
    func reopen(_ visible: Bool) -> Bool {
        delegate?.applicationShouldHandleReopen(self, hasVisibleWindows: visible) ?? false
    }
}
final class ProbeWindow {
    var isMiniaturized = false
    var shown = 0, restored = 0
    func deminiaturize(_ sender: Any?) { isMiniaturized = false; restored += 1 }
    func makeKeyAndOrderFront(_ sender: Any?) { shown += 1 }
}
typealias NSWindow = ProbeWindow
${controllerHeader}
    let model: Model
    var shows = 0
    var conversationWindow: ProbeWindow? = ProbeWindow()
    var onboardingWindow: ProbeWindow? = ProbeWindow()
    var guideShows = 0
    init(model: Model) { self.model = model }
    func showConversations() {
        shows += 1; model.conversationVisible = true
        ${presentation}
    }
    func showOnboarding() { guideShows += 1 }
    ${block('    func applicationShouldHandleReopen(')}
    ${block('    func windowWillClose(')}
}

if mode == "fake-recorder" {
    var childSources: [DispatchSourceSignal] = []
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        s.setEventHandler { mark("cancelled"); exit(0) }
        s.resume(); childSources.append(s)
    }
    mark("recorder.ready")
    let end = Date(timeIntervalSinceNow: 5)
    while Date() < end { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
    mark("expired"); exit(4)
}

let m = Model()
if mode == "reopen" || mode == "first-guide" {
    let app = NSApplication()
    var controller: Controller?
    let openConversations = false
    ${wiring}
    precondition(controller?.shows == 0)
    precondition(controller?.guideShows == (mode == "first-guide" ? 1 : 0))
    controller!.windowWillClose(Notification(name: Notification.Name("closed"), object: controller!.onboardingWindow))
    precondition(m.conversationVisible && m.onboarding.dismissals == 1, "Closing the guide must not hide the conversation model")
    controller!.windowWillClose(Notification(name: Notification.Name("closed"), object: controller!.conversationWindow))
    precondition(!m.conversationVisible)
    precondition(app.reopen(false))
    precondition(m.conversationVisible && controller!.shows == 1)
    precondition(app.reopen(true))
    precondition(controller!.shows == 2)
    let window = controller!.conversationWindow!
    window.isMiniaturized = true
    precondition(app.reopen(false))
    precondition(controller!.conversationWindow === window)
    precondition(!window.isMiniaturized && window.restored == 1 && window.shown == 3)
    precondition(FileManager.default.fileExists(atPath: dir + "/activated"))
    print("reopen restores the closed or minimized window and raises an existing one"); exit(0)
}

try! String(getpid()).write(toFile: PID_FILE, atomically: true, encoding: .utf8)
if mode == "empty" || mode == "finished" {
    if mode == "finished" {
        let child = Process(); child.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try! child.run(); child.waitUntilExit(); m.recorder = child
    }
    m.prepareForExit(); m.prepareForExit()
    precondition(!m.holding && !FileManager.default.fileExists(atPath: PID_FILE))
    precondition(m.onboarding.stops == 2 && m.newSession.stops == 2)
    print("cleanup tolerates absent and already finished recorders"); exit(0)
}

let recorder = Process()
recorder.executableURL = URL(fileURLWithPath: args[0])
recorder.arguments = ["fake-recorder", dir]
recorder.standardOutput = FileHandle.nullDevice
recorder.standardError = FileHandle.nullDevice
try! recorder.run(); m.recorder = recorder
mark("recorder.pid", String(recorder.processIdentifier))
let readyUntil = Date(timeIntervalSinceNow: 3)
while !FileManager.default.fileExists(atPath: dir + "/recorder.ready") && Date() < readyUntil {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
}
precondition(FileManager.default.fileExists(atPath: dir + "/recorder.ready"))
if mode == "quit" { m.quit() }

var sources: [DispatchSourceSignal] = []
${block('        for sig in [SIGTERM, SIGINT]')}
mark("panel.ready")
while true { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
`);
  execFileSync('/usr/bin/swiftc', ['-o', binary, swift], { timeout: 60_000, stdio: 'pipe' });

  for (const mode of ['reopen', 'first-guide', 'empty', 'finished']) {
    const dir = mkdtempSync(path.join(tmp, `${mode}-`));
    execFileSync(binary, [mode, dir], { timeout: 5000, stdio: 'pipe' });
    console.log(`ok - ${mode}: production lifecycle callbacks execute without AppKit`);
  }

  for (const mode of ['SIGTERM', 'SIGINT', 'quit']) {
    const dir = mkdtempSync(path.join(tmp, `${mode}-`));
    const child = spawn(binary, [mode === 'quit' ? 'quit' : 'signal', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    await eventually(() => existsSync(path.join(dir, 'recorder.pid')), `${mode}: missing owned child identity`);
    const recorderPid = Number(readFileSync(path.join(dir, 'recorder.pid'), 'utf8'));
    recorderPids.add(recorderPid);
    if (mode !== 'quit') {
      await eventually(() => existsSync(path.join(dir, 'panel.ready')), `${mode}: handlers were not ready`);
      child.kill(mode);
    }
    const [code, signal] = await Promise.race([
      exited,
      delay(5000, undefined, { ref: false }).then(() => { throw new Error(`${mode}: panel did not exit`); }),
    ]);
    children.delete(child);
    assert.equal(signal, null, `${mode}: exited by unhandled signal; ${stderr}`);
    assert.equal(code, 0, `${mode}: ${stderr}`);
    await eventually(() => existsSync(path.join(dir, 'cancelled')), `${mode}: recorder was not cancelled`);
    await eventually(() => !alive(recorderPid), `${mode}: recorder is still running`);
    recorderPids.delete(recorderPid);
    assert.ok(!existsSync(path.join(dir, 'panel.pid')), `${mode}: stale panel PID`);
    assert.ok(existsSync(path.join(dir, 'released')), `${mode}: keepawake not released`);
    assert.ok(existsSync(path.join(dir, 'onboarding-stopped')), `${mode}: onboarding child cleanup not called`);
    assert.ok(existsSync(path.join(dir, 'new-session-stopped')), `${mode}: new-session child cleanup not called`);
    assert.ok(!existsSync(path.join(dir, 'expired')), `${mode}: recorder ran to completion`);
    if (mode === 'quit') {
      const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(state.quit, true);
      assert.equal(state.holding, false);
      assert.equal(readFileSync(path.join(dir, 'mode'), 'utf8'), 'off');
      assert.ok(existsSync(path.join(dir, 'quit')));
    }
    console.log(`ok - ${mode}: production exit cancels its child and clears keepawake/PID`);
  }
} finally {
  // Only our isolated children are signalled. The fake recorder also has its own five-second lifetime.
  for (const child of children) child.kill('SIGTERM');
  for (const pid of recorderPids) if (alive(pid)) process.kill(pid, 'SIGTERM');
  await eventually(() => [...children].every(child => child.exitCode !== null || child.signalCode !== null)
    && [...recorderPids].every(pid => !alive(pid)), 'isolated lifecycle fixture did not stop', 6000);
  rmSync(tmp, { recursive: true, force: true });
}
