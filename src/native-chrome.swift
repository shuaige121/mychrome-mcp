// Shared Chrome inspection and owner-thread transactions. Declarations only.
import Foundation
import AppKit
import ApplicationServices
import ScriptingBridge
import Carbon
import CryptoKit

@_silgen_name("_AXUIElementGetWindow")
private func chromeNativeWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

enum ChromeNative {
struct DialogFailure: Error {
    // Closed failure sites only; no AX values or window identity enter this field.
    enum ProbePoint: String {
        case native_attribute_deadline, native_attribute_read, native_windows_shape, native_subrole_shape
        case native_sheets_shape, native_walk_guard, native_button_title, native_button_label
        case native_text_value, native_children_read, native_dialog_final, cli_inspect_catch
    }
    let code: String
    let stage: String
    var delivery: String = "not_sent"
    var dialogProbePoint: ProbePoint? = nil
    // Whole-scan rescans after transient AX statuses, and the last such status (an AXError code).
    var axRetries: Int? = nil
    var axError: Int? = nil
    var json: [String: Any] {
        var result: [String: Any] = ["ok": false, "error": code, "stage": stage, "inputDelivery": delivery,
         "message": "无法完整确认指定原生对话框；请检查当前状态，不要重复发送。"]
        if code == "dialog_probe_unknown", stage == "dialog_inspect", let point = dialogProbePoint {
            result["dialogProbePoint"] = point.rawValue
        }
        if code == "dialog_probe_unknown", ["dialog_inspect", "dialog_binding", "native_read_deadline"].contains(stage), let retries = axRetries {
            result["axRetries"] = retries
            if let status = axError { result["axError"] = status }
        }
        return result
    }
}

struct DialogIdentity: Equatable {
    let chromePid: Int, tabId: Int, windowId: Int, cgWindow: Int, dialogCgWindow: Int
    let token: String
    var json: [String: Any] {
        ["version": 1, "chromePid": chromePid, "tabId": tabId, "windowId": windowId,
         "cgWindow": cgWindow, "dialogCgWindow": dialogCgWindow, "token": token]
    }
}
struct PageDialog {
    let title: String, texts: [String], buttons: [(String, AXUIElement)], fields: [AXUIElement]
    let window: AXUIElement, descriptor: [String]
    var identity: DialogIdentity? = nil
    var origin: String? = nil // Fresh value-only snapshot evidence; never instance authority.
    var templateComplete = true
    var hasField: Bool { !fields.isEmpty }
}
struct DialogParent {
    let cgWindow: Int, windowId: Int, tabId: Int, rect: CGRect
}

static func promptText(_ value: String) -> String {
    let pattern = "[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]+"
    let normalized = value.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
    return normalized.trimmingCharacters(in: CharacterSet(charactersIn: " "))
}
static func promptOrigin(_ value: String) -> String? {
    guard let u = URLComponents(string: value), let scheme = u.scheme?.lowercased(),
          ["http", "https"].contains(scheme), u.user == nil, u.password == nil,
          let host = u.host?.lowercased(), !host.isEmpty,
          !host.unicodeScalars.contains(where: { $0.value < 33 || $0.value > 126 }),
          u.port == nil || (u.port! > 0 && u.port! <= 65535) else { return nil }
    let port = u.port, standard = scheme == "https" ? 443 : 80
    let address = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    return scheme + "://" + address + (port != nil && port != standard ? ":\(port!)" : "")
}

static func dialogInt(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
          n.doubleValue.isFinite, n.doubleValue > 0, n.doubleValue <= 9007199254740991,
          n.doubleValue.rounded() == n.doubleValue else { return nil }
    return n.intValue
}
static func dialogIdentity(_ value: [String: Any]) throws -> DialogIdentity {
    guard dialogInt(value["version"]) == 1, let pid = dialogInt(value["chromePid"]), pid <= Int(Int32.max),
          let tab = dialogInt(value["tabId"]), let win = dialogInt(value["windowId"]),
          let cg = dialogInt(value["cgWindow"]), let dcg = dialogInt(value["dialogCgWindow"]),
          let token = value["token"] as? String, token.count == 64,
          token.allSatisfy({ "0123456789abcdef".contains($0) }) else {
        throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity")
    }
    return DialogIdentity(chromePid: pid, tabId: tab, windowId: win, cgWindow: cg, dialogCgWindow: dcg, token: token)
}

static func dialogOptions(_ args: [String]) throws -> [String: String] {
    let allowed: Set<String> = ["--pid", "--identity", "--target", "--press", "--text"]
    guard args.first == "dialog", args.count % 2 == 1 else { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
    var result: [String: String] = [:]
    for i in stride(from: 1, to: args.count, by: 2) {
        guard allowed.contains(args[i]), result[args[i]] == nil else { throw DialogFailure(code: "dialog_identity_required", stage: "dialog_identity") }
        // Values are opaque, even when a button label or prompt text looks like a flag.
        result[args[i]] = args[i + 1]
    }
    return result
}


struct ChromeWin { let id: Int; let rect: CGRect; let minimized: Bool; let index: Int? }
static func num(_ v: Any?) -> Int {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String { return Int(s) ?? 0 }
    return 0
}

static func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= 2 && abs(a.origin.y - b.origin.y) <= 2 &&
    abs(a.size.width - b.size.width) <= 2 && abs(a.size.height - b.size.height) <= 2
}

static func bindDialog(pid: Int, dialogCG: Int, dialogRect: CGRect, descriptor: [String],
                parents: [DialogParent], attachments: [Int], target: [String: Any]?) throws -> DialogIdentity {
    guard pid > 0, dialogCG > 0, dialogRect.width > 0, dialogRect.height > 0,
          [dialogRect.minX, dialogRect.minY, dialogRect.width, dialogRect.height].allSatisfy({ $0.isFinite }),
          parents.allSatisfy({ $0.cgWindow > 0 && $0.windowId > 0 && $0.tabId > 0 && $0.cgWindow != dialogCG }),
          Set(parents.map { $0.cgWindow }).count == parents.count,
          Set(parents.map { $0.windowId }).count == parents.count else {
        throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
    }
    let eligible = parents.filter { $0.rect.contains(dialogRect) }
    guard eligible.count == 1 else { throw DialogFailure(code: eligible.count > 1 ? "dialog_ambiguous" : "dialog_probe_unknown", stage: "dialog_binding") }
    let p = eligible[0]
    guard attachments.allSatisfy({ $0 == p.cgWindow }) else { throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_binding") }
    if let t = target {
        guard dialogInt(t["chromePid"]) == pid, dialogInt(t["tabId"]) == p.tabId,
              dialogInt(t["windowId"]) == p.windowId, dialogInt(t["cgWindow"]) == p.cgWindow else {
            throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_binding")
        }
    }
    let payload: [String: Any] = ["pid": pid, "tab": p.tabId, "window": p.windowId, "parent": p.cgWindow,
                                "dialog": dialogCG, "rect": [dialogRect.minX, dialogRect.minY, dialogRect.width, dialogRect.height], "descriptor": descriptor]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let token = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    return DialogIdentity(chromePid: pid, tabId: p.tabId, windowId: p.windowId, cgWindow: p.cgWindow, dialogCgWindow: dialogCG, token: token)
}

static func answerPageDialog(expected: DialogIdentity, button: String, text: String?,
                      inspect: () throws -> PageDialog?, validateButton: (AXUIElement) throws -> Void,
                      validateField: (AXUIElement) throws -> Void, set: (AXUIElement, String) throws -> Bool,
                      read: (AXUIElement) throws -> String?, press: (AXUIElement) throws -> Bool,
                      settle: () throws -> Void) throws -> [String: Any] {
    var attempted = false
    func current() throws -> PageDialog {
        guard let d = try inspect(), d.identity == expected else { throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_recheck") }
        return d
    }
    func selected(_ d: PageDialog) throws -> AXUIElement {
        let matches = d.buttons.filter { $0.0 == button }
        guard matches.count == 1 else { throw DialogFailure(code: matches.isEmpty ? "no_such_button" : "dialog_button_ambiguous", stage: "dialog_button") }
        try validateButton(matches[0].1)
        return matches[0].1
    }
    do {
        let initial = try current()
        _ = try selected(initial)
        if text != nil {
            guard initial.fields.count == 1 else { throw DialogFailure(code: "dialog_field_ambiguous", stage: "dialog_field") }
            try validateField(initial.fields[0])
        }
        let before = try current()
        _ = try selected(before)
        if let value = text {
            guard before.fields.count == 1 else { throw DialogFailure(code: "dialog_field_ambiguous", stage: "dialog_field") }
            let field = before.fields[0]
            try validateField(field)
            attempted = true
            guard try set(field, value) else { throw DialogFailure(code: "dialog_set_failed", stage: "dialog_set") }
            guard try read(field) == value else { throw DialogFailure(code: "dialog_set_unconfirmed", stage: "dialog_readback") }
        }
        let atPress = try current()
        let nativeButton = try selected(atPress)
        attempted = true
        guard try press(nativeButton) else { throw DialogFailure(code: "dialog_press_unconfirmed", stage: "dialog_press") }
        try settle()
        var result: [String: Any] = ["ok": true, "open": true, "pressed": button, "inputDelivery": "sent", "stage": "dialog_postcheck"]
        do {
            let after = try inspect()
            result["sameStillOpen"] = after?.identity == expected
            result["stillOpen"] = after != nil
        } catch { result["sameStillOpen"] = NSNull(); result["stillOpen"] = NSNull(); result["postcheckError"] = "dialog_probe_unknown" }
        return result
    } catch var e as DialogFailure {
        if attempted { e.delivery = "unknown" }
        throw e
    } catch { throw error }
}

static func matchWindows(_ cw: [ChromeWin], cg: [(num: Int, rect: CGRect, onScreen: Bool)],
                  onOrder: () -> [(num: Int, rect: CGRect)],
                  ax: () -> [(num: Int, title: String, minimized: Bool, rect: CGRect?)],
                  title: (Int) -> String,
                  observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                  retaining: (window: Int, cg: Int, cgs: Set<Int>, windows: Set<Int>)? = nil,
                  captureUnique: (([Int: Int], Set<Int>) -> Void)? = nil,
                  documentEvidence: (() -> (documents: [Int: Data], urls: [Int: Data])?)? = nil) -> [Int: Int] {
    var out: [Int: Int] = [:]
    var uniqueBounds: [Int: Int] = [:]
    for k in cw.indices {
        let hits = cg.filter { sameRect($0.rect, cw[k].rect) }
        if hits.count == 1 {
            if let observe { observe(5, cw[k].id, nil, nil, [0, hits.count, nil, nil, nil, nil, nil, nil], [nil, nil], [], hits.prefix(32).map { $0.num }) }
            out[cw[k].id] = hits[0].num
            if captureUnique != nil { uniqueBounds[cw[k].id] = hits[0].num }
            if let observe { observe(6, cw[k].id, hits[0].num, nil, [0], [], [], []) }
            continue
        }
        let twins = cw.indices.filter { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized }
        guard hits.count > 1, twins.count == 1 else {
            if let observe { observe(5, cw[k].id, nil, nil, [0, hits.count, twins.count, nil, nil, nil, nil, nil], [nil, nil], twins.prefix(16).map { cw[$0].id }, hits.prefix(32).map { $0.num }) }
            continue
        }
        let vis = hits.filter { $0.onScreen != cw[k].minimized }
        if let observe { observe(5, cw[k].id, nil, nil, [0, hits.count, twins.count, vis.count, nil, nil, nil, nil], [nil, nil], twins.prefix(16).map { cw[$0].id }, hits.prefix(32).map { $0.num }) }
        if vis.count == 1 {
            out[cw[k].id] = vis[0].num
            if let observe { observe(6, cw[k].id, vis[0].num, nil, [1], [], [], []) }
        }
    }
    var observedAX: [(num: Int, title: String, minimized: Bool, rect: CGRect?)] = []
    let left = cw.indices.filter { k in out[cw[k].id] == nil && cg.contains { sameRect($0.rect, cw[k].rect) } }
    if !left.isEmpty {
        // Chrome's titles are read before and after the AX table: when a title changed in between (a page
        // retitling itself, a tab switch), the AX snapshot may belong to other titles, so no window of
        // that bounds group is matched by title (dropping only the changed one would make a rival vanish).
        var titles: [Int: String] = [:]
        for k in left { titles[k] = title(k) }
        let axw = ax()
        observedAX = axw
        let changed = left.filter { title($0) != titles[$0] }
        for k in left {
            guard let t = titles[k] else {
                if let observe { observe(5, cw[k].id, nil, nil, [1, nil, nil, nil, nil, nil, nil, nil], [nil, nil], [], []) }
                continue
            }
            guard !t.isEmpty else {
                if let observe { observe(5, cw[k].id, nil, nil, [1, nil, nil, nil, nil, nil, nil, nil], [false, nil], [], []) }
                continue
            }
            let titlesChanged = changed.contains(where: { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized })
            guard !titlesChanged else {
                if let observe { observe(5, cw[k].id, nil, nil, [1, nil, nil, nil, nil, nil, nil, nil], [true, titlesChanged], [], []) }
                continue
            }
            let rivals = left.filter { sameRect(cw[$0].rect, cw[k].rect) && cw[$0].minimized == cw[k].minimized && titles[$0] == t }
            let same = axw.filter { $0.minimized == cw[k].minimized && ($0.rect.map { sameRect($0, cw[k].rect) } ?? false) }
            // "<title> - Google Chrome…" first; Chrome may put a state in between ("- Audio playing").
            let strict = same.filter { $0.title.hasPrefix(t + " - Google Chrome") }
            let strictWins = strict.count == 1
            let hits = strictWins ? strict : same.filter { $0.title.hasPrefix(t + " - ") }
            if let observe { observe(5, cw[k].id, nil, nil, [1, hits.count, nil, nil, rivals.count, strict.count, strictWins ? nil : hits.count, nil], [true, titlesChanged], rivals.prefix(16).map { cw[$0].id }, hits.prefix(32).map { $0.num }) }
            if rivals.count == 1 && hits.count == 1 {
                out[cw[k].id] = hits[0].num
                if let observe { observe(6, cw[k].id, hits[0].num, nil, [strictWins ? 2 : 3], [], [], []) }
            }
        }
    }
    // Documents are fresh content evidence only. Assign a whole unmatched group, or retain
    // individual positive pairs solely to refuse a contradictory order/pin guess below.
    var documentPairs: [Int: Int] = [:]
    if let evidence = documentEvidence?() {
        var visited = Set<Int>()
        let taken = Set(out.values)
        for k in cw.indices where out[cw[k].id] == nil && !visited.contains(cw[k].id) {
            let group = cw.indices.filter { out[cw[$0].id] == nil && cw[$0].minimized == cw[k].minimized && sameRect(cw[$0].rect, cw[k].rect) }
            group.forEach { visited.insert(cw[$0].id) }
            let hits = cg.filter { sameRect($0.rect, cw[k].rect) && !taken.contains($0.num) }
            guard Set(hits.map { $0.num }).count == hits.count else { continue }
            var usable: [Int: Data] = [:]
            for hit in hits {
                let axHits = observedAX.filter { $0.num == hit.num }
                guard axHits.count == 1, axHits[0].minimized == cw[k].minimized,
                      let rect = axHits[0].rect, sameRect(rect, hit.rect),
                      let document = evidence.documents[hit.num] else { continue }
                usable[hit.num] = document
            }
            for g in group {
                guard let url = evidence.urls[cw[g].id] else { continue }
                let matches = usable.filter { $0.value == url }
                if matches.count == 1 { documentPairs[cw[g].id] = matches.first!.key }
            }
            let pairs = group.compactMap { documentPairs[cw[$0].id] }
            guard group.count > 1, hits.count == group.count, usable.count == hits.count,
                  pairs.count == group.count, Set(pairs).count == hits.count else { continue }
            for g in group {
                let number = documentPairs[cw[g].id]!
                out[cw[g].id] = number
                if let observe { observe(6, cw[g].id, number, nil, [7], [], [], []) }
            }
        }
    }
    func contradictsDocument(_ proposal: [(Int, Int)]) -> Bool {
        proposal.contains { window, number in
            documentPairs.contains { $0.key == window ? $0.value != number : $0.value == number }
        }
    }
    if cw.allSatisfy({ $0.index != nil }), cw.contains(where: { w in !w.minimized && out[w.id] == nil }) {
        let order = onOrder()
        var done = Set(out.keys)
        let taken = Set(out.values)
        for k in cw.indices where !done.contains(cw[k].id) && !cw[k].minimized {
            let group = cw.indices.filter { !cw[$0].minimized && sameRect(cw[$0].rect, cw[k].rect) && !done.contains(cw[$0].id) }
            let hits = order.filter { sameRect($0.rect, cw[k].rect) && !taken.contains($0.num) }
            // A single window left is paired too when Accessibility took its twins (the last of the group).
            let axTookTwins = order.contains { sameRect($0.rect, cw[k].rect) && taken.contains($0.num) }
            guard group.count > 1 || (group.count == 1 && axTookTwins), hits.count == group.count else { continue }
            let sortedGroup = group.sorted { cw[$0].index! < cw[$1].index! }
            if let observe { observe(5, cw[k].id, nil, nil, [2, hits.count, nil, nil, nil, nil, nil, group.count], [nil, nil], sortedGroup.prefix(16).map { cw[$0].id }, hits.prefix(32).map { $0.num }) }
            // Only a same-creation unique-bounds pin may outrank a conflicting order guess.
            // Retain no other pairing: this group remains ambiguous for every rival.
            if let pin = retaining, let position = sortedGroup.firstIndex(where: { cw[$0].id == pin.window }),
               hits[position].num != pin.cg, hits.contains(where: { $0.num == pin.cg }),
               Set(hits.map { $0.num }).isSubset(of: pin.cgs),
               Set(group.map { cw[$0].id }).isSubset(of: pin.windows) {
                if contradictsDocument([(pin.window, pin.cg)]) {
                    for g in group { done.insert(cw[g].id) }
                    if let observe { observe(6, pin.window, pin.cg, nil, [8], [], [], []) }
                    continue
                }
                out[pin.window] = pin.cg
                for g in group { done.insert(cw[g].id) }
                if let observe { observe(6, pin.window, pin.cg, nil, [6], [], [], []) }
                continue
            }
            if contradictsDocument(zip(sortedGroup, hits).map { (cw[$0.0].id, $0.1.num) }) {
                for g in group { done.insert(cw[g].id) }
                if let observe { observe(6, cw[k].id, hits[0].num, nil, [8], [], [], []) }
                continue
            }
            for (g, h) in zip(sortedGroup, hits) {
                out[cw[g].id] = h.num; done.insert(cw[g].id)
                if let observe { observe(6, cw[g].id, h.num, nil, [4], [], [], []) }
            }
        }
    }
    let claimed = Dictionary(grouping: out.values, by: { $0 })
    let filtered = out.filter {
        let unique = claimed[$0.value]!.count == 1
        if !unique, let observe { observe(6, $0.key, $0.value, nil, [5], [], [], []) }
        return unique
    }
    captureUnique?(uniqueBounds.filter { filtered[$0.key] == $0.value }, Set(cg.map { $0.num }))
    return filtered
}

// Request-local value projection only. This collector never reads or controls native state.
final class BoundsEvidence {
    private struct Row {
        let id: Int
        let json: [String: Any]
    }
    private struct Relation {
        let window: Int
        let kind: Int
        let counts: [Int?]
        let flags: [Bool?]
        let windows: [Int]
        let cgs: [Int]
    }
    private struct Decision {
        let window: Int
        let cg: Int
        let branch: Int
    }
    private final class Frame {
        var attempts = 0
        var target: Int?
        var expected: Int?
        var mapped: Int?
        var mappingReturned = false
        var incomplete = false
        var binding = "not_checked"
        var structural = "not_checked"
        var firstStructureFailure: [String: String]?
        var axCalled = false
        var axCount: Int?
        var chrome: [Row] = []
        var cg: [Row] = []
        var ax: [Row] = []
        var relations: [Relation] = []
        var decisions: [Decision] = []
        var neededWindows = Set<String>()
        var neededCGs = Set<String>()
    }
    private var windows: [Int: String] = [:]
    private var cgs: [Int: String] = [:]
    private var phases: [String: Frame] = [:]
    private var active: String?
    private var reasons: [String] = []
    private var requested: Any = NSNull()
    private let phaseNames = ["initial", "pre_bounds", "post_bounds", "post_url"]
    private let countNames = ["hits", "twins", "visible", "rivals", "strict", "loose", "group"]

    init(requestedRect: CGRect) {
        requested = geometry(requestedRect)
    }
    private func mark(_ reason: String, frame: Frame? = nil) {
        if !reasons.contains(reason) { reasons.append(reason) }
        (frame ?? active.flatMap { phases[$0] })?.incomplete = true
    }
    private func count(_ value: Int?) -> Int? {
        guard let value else { return nil }
        if value < 0 { mark("projection_failure"); return nil }
        if value > 65535 { mark("count_saturated"); return 65535 }
        return value
    }
    private func geometry(_ rect: CGRect?) -> Any {
        guard let rect else { mark("read_unavailable"); return NSNull() }
        let values = [Double(rect.origin.x), Double(rect.origin.y), Double(rect.size.width), Double(rect.size.height)]
        guard values.allSatisfy({ $0.isFinite }), abs(values[0]) <= 1_000_000, abs(values[1]) <= 1_000_000,
              values[2] > 0, values[2] <= 1_000_000, values[3] > 0, values[3] <= 1_000_000 else {
            mark("geometry_out_of_range"); return NSNull()
        }
        return values
    }
    private func windowAlias(_ id: Int) -> String? {
        if let known = windows[id] { return known }
        guard windows.count < 16 else { mark("window_alias_cap"); return nil }
        let alias = "W\(windows.count + 1)"
        windows[id] = alias
        return alias
    }
    private func cgAlias(_ id: Int) -> String? {
        if let known = cgs[id] { return known }
        guard cgs.count < 32 else { mark("cg_alias_cap"); return nil }
        let alias = "C\(cgs.count + 1)"
        cgs[id] = alias
        return alias
    }
    func begin(_ phase: String, window: Int, expected: Int?) {
        guard phaseNames.contains(phase), phase == "initial" || phases[phase] == nil else { mark("projection_failure"); return }
        let frame = Frame()
        frame.attempts = (phases[phase]?.attempts ?? 0) + 1
        frame.target = window
        frame.expected = expected
        phases[phase] = frame
        active = phase
        frame.attempts = count(frame.attempts) ?? 0
        // The created row is reserved before any observation can allocate another W alias.
        _ = windowAlias(window)
        if let expected { _ = cgAlias(expected) }
    }
    func seedTarget(rect: CGRect, index: Int?, minimized: Bool) {
        guard active == "initial", let target = phases["initial"]?.target else { mark("projection_failure"); return }
        // createdWindow already selected this value row before cgMapping can fail early.
        record(0, target, nil, rect, [index], [minimized], [], [])
    }
    func initialMapped(_ mapped: Int?) {
        guard active == "initial", let frame = phases["initial"] else { mark("projection_failure"); return }
        frame.mapped = mapped
        frame.mappingReturned = true
        if let mapped { _ = cgAlias(mapped) }
        active = nil
    }
    func end() { active = nil }

    func record(_ event: Int, _ window: Int?, _ cg: Int?, _ rect: CGRect?, _ nums: [Int?], _ flags: [Bool?], _ windowIDs: [Int], _ cgIDs: [Int]) {
        guard let name = active, let frame = phases[name] else { mark("projection_failure"); return }
        func invalid() { mark("projection_failure", frame: frame) }
        switch event {
        case 0:
            guard let window, cg == nil, let rect, nums.count == 1, flags.count == 1, let minimized = flags[0], windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            guard let alias = windowAlias(window) else { return }
            if frame.chrome.contains(where: { $0.id == window }) { return }
            guard frame.chrome.count < 16 else { mark("row_cap"); return }
            let index: Any
            if let value = nums[0], value > 0, value <= 65535 { index = value }
            else { index = NSNull(); mark("index_out_of_range") }
            frame.chrome.append(Row(id: window, json: ["w": alias, "rect": geometry(rect), "index": index, "minimized": minimized]))
        case 1, 4:
            guard window == nil, let cg, event == 4 || rect != nil, nums.isEmpty, flags.count == 1, let flag = flags[0], windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            guard let alias = cgAlias(cg) else { return }
            if event == 1 {
                if frame.cg.contains(where: { $0.id == cg }) { return }
                guard frame.cg.count < 32 else { mark("row_cap"); return }
                frame.cg.append(Row(id: cg, json: ["c": alias, "rect": geometry(rect), "onScreen": flag]))
            } else {
                if frame.ax.contains(where: { $0.id == cg }) { return }
                guard frame.ax.count < 32 else { mark("row_cap"); return }
                frame.ax.append(Row(id: cg, json: ["c": alias, "rect": geometry(rect), "minimized": flag]))
            }
        case 2:
            guard window == nil, cg == nil, rect == nil, nums.isEmpty, flags.isEmpty, windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            frame.axCalled = true
        case 3:
            guard window == nil, cg == nil, rect == nil, nums.count == 1, nums[0] != nil, flags.isEmpty, windowIDs.isEmpty, cgIDs.isEmpty, frame.axCalled else { invalid(); return }
            frame.axCount = count(nums[0])
        case 5:
            guard let window, cg == nil, rect == nil, nums.count == 8, let kind = nums[0], (0...2).contains(kind), flags.count == 2 else { invalid(); return }
            guard frame.relations.count < 32 else { mark("relation_cap"); return }
            let counts = nums.dropFirst().map { count($0) }
            let relevantWindowCount = kind == 0 ? nums[2] : kind == 1 ? nums[4] : nums[7]
            if windowIDs.count > 16 || (relevantWindowCount ?? 0) > 16 || cgIDs.count > 32 || (nums[1] ?? 0) > 32 { mark("relation_cap") }
            _ = windowAlias(window)
            let ws = Array(windowIDs.prefix(16)), cs = Array(cgIDs.prefix(32))
            for id in ws { _ = windowAlias(id) }
            for id in cs { _ = cgAlias(id) }
            frame.relations.append(Relation(window: window, kind: kind, counts: counts, flags: flags, windows: ws, cgs: cs))
        case 6:
            guard let window, let cg, rect == nil, nums.count == 1, let branch = nums[0], (0...8).contains(branch), flags.isEmpty, windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            guard frame.decisions.count < 32 else { mark("decision_cap"); return }
            _ = windowAlias(window); _ = cgAlias(cg)
            frame.decisions.append(Decision(window: window, cg: cg, branch: branch))
        case 7:
            guard cg == nil, rect == nil, (nums.count == 1 || nums.count == 2), let result = nums[0], (0...2).contains(result), flags.isEmpty, windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            if nums.count == 1 {
                guard window == nil else { invalid(); return }
            } else {
                let fields = ["duplicate_id", "count", "id", "tabs", "active_tab", "bounds", "minimized", "index"]
                guard result == 1, let field = nums[1], fields.indices.contains(field), (field == 1) == (window == nil) else { invalid(); return }
                // First observed failure only: Dictionary iteration does not establish
                // that the target was already checked when another row failed.
                if frame.firstStructureFailure == nil {
                    frame.firstStructureFailure = ["scope": window == nil ? "snapshot" : window == frame.target ? "target" : "other",
                                                   "field": fields[field]]
                }
            }
            frame.structural = ["same", "changed", "unavailable"][result]
            if result == 2 { mark("read_unavailable") }
        case 8:
            guard let window, rect == nil, nums.count == 1, let result = nums[0], (0...5).contains(result), flags.isEmpty, windowIDs.isEmpty, cgIDs.isEmpty else { invalid(); return }
            guard frame.target == window, (result == 0 || result == 5) == (cg != nil) else { invalid(); return }
            frame.binding = ["matched", "window_missing", "tab_not_in_window", "active_tab_mismatch", "cg_mapping_missing", "cg_mapping_mismatch"][result]
            frame.mapped = cg
            if let cg { _ = cgAlias(cg) }
        default: invalid()
        }
    }
    private func emptyPhase() -> [String: Any] {
        ["state": "not_reached", "attempts": 0, "target": NSNull(), "expected": NSNull(), "mapped": NSNull(),
         "binding": "not_checked", "structural": "not_checked", "chrome": [], "cg": [],
         "ax": ["state": "not_called", "enumerationStatus": "unobserved", "returned_count": NSNull(), "rows": []],
         "relations": [], "decisions": []]
    }
    private func projectPhase(_ frame: Frame) -> [String: Any] {
        var relatedWindows = Set<Int>(), relatedCGs = Set<Int>()
        if let target = frame.target { relatedWindows.insert(target) }
        if let expected = frame.expected { relatedCGs.insert(expected) }
        if let mapped = frame.mapped { relatedCGs.insert(mapped) }
        // Only bounded value buffers participate. Include competitors that claimed a target candidate.
        var changed = true
        while changed {
            let previousWindows = relatedWindows.count, previousCGs = relatedCGs.count
            for relation in frame.relations where relatedWindows.contains(relation.window) || relation.windows.contains(where: { relatedWindows.contains($0) }) || relation.cgs.contains(where: { relatedCGs.contains($0) }) {
                relatedWindows.insert(relation.window)
                relatedWindows.formUnion(relation.windows); relatedCGs.formUnion(relation.cgs)
            }
            for decision in frame.decisions where relatedWindows.contains(decision.window) || relatedCGs.contains(decision.cg) {
                relatedWindows.insert(decision.window); relatedCGs.insert(decision.cg)
            }
            changed = previousWindows != relatedWindows.count || previousCGs != relatedCGs.count
        }
        func w(_ id: Int?) -> Any {
            guard let id else { return NSNull() }
            guard let alias = windowAlias(id) else { return NSNull() }
            frame.neededWindows.insert(alias); return alias
        }
        func c(_ id: Int?) -> Any {
            guard let id else { return NSNull() }
            guard let alias = cgAlias(id) else { return NSNull() }
            frame.neededCGs.insert(alias); return alias
        }
        let relations: [[String: Any]] = frame.relations.compactMap { relation in
            guard relatedWindows.contains(relation.window) || relation.windows.contains(where: { relatedWindows.contains($0) }) || relation.cgs.contains(where: { relatedCGs.contains($0) }) else { return nil }
            var counts: [String: Any] = [:]
            for (key, value) in zip(countNames, relation.counts) { counts[key] = value.map { $0 as Any } ?? NSNull() }
            var ws: [String] = [], cs: [String] = []
            for id in relation.windows {
                if let alias = w(id) as? String {
                    if !ws.contains(alias) { ws.append(alias) }
                    else { mark("projection_failure", frame: frame) }
                }
            }
            for id in relation.cgs {
                if let alias = c(id) as? String {
                    if !cs.contains(alias) { cs.append(alias) }
                    else { mark("projection_failure", frame: frame) }
                }
            }
            return ["w": w(relation.window), "kind": ["bounds", "title", "order"][relation.kind], "counts": counts,
                    "titleNonempty": relation.flags[0].map { $0 as Any } ?? NSNull(), "titlesChanged": relation.flags[1].map { $0 as Any } ?? NSNull(), "windows": ws, "cgs": cs]
        }
        let decisions: [[String: Any]] = frame.decisions.compactMap { decision in
            guard relatedWindows.contains(decision.window) || relatedCGs.contains(decision.cg) else { return nil }
            return ["w": w(decision.window), "c": c(decision.cg), "branch": ["unique_bounds", "visibility", "ax_strict", "ax_loose", "order", "duplicate_claim_removed", "retained_exact", "document_exact", "document_conflict_refused"][decision.branch]]
        }
        let target = w(frame.target), expected = c(frame.expected), mapped = c(frame.mapped)
        var result: [String: Any] = ["state": frame.incomplete ? "incomplete" : "complete", "attempts": frame.attempts,
                "target": target, "expected": expected, "mapped": mapped, "binding": frame.binding, "structural": frame.structural,
                "chrome": frame.chrome.filter { relatedWindows.contains($0.id) }.map { $0.json },
                "cg": frame.cg.filter { relatedCGs.contains($0.id) }.map { $0.json },
                "ax": ["state": frame.axCalled ? "called" : "not_called", "enumerationStatus": "unobserved",
                       "returned_count": frame.axCount.map { $0 as Any } ?? NSNull(), "rows": frame.ax.filter { relatedCGs.contains($0.id) }.map { $0.json }],
                "relations": relations, "decisions": decisions]
        if frame.structural == "changed", let failure = frame.firstStructureFailure { result["firstStructureFailure"] = failure }
        return result
    }
    private func fallback(_ status: String, _ reason: String) -> [String: Any] {
        ["schema": 1, "status": status, "reasons": [reason], "requestedRect": NSNull(),
         "phases": ["initial": emptyPhase(), "pre_bounds": emptyPhase(), "post_bounds": emptyPhase(), "post_url": emptyPhase()]]
    }
    func project() -> [String: Any] {
        if let name = active, let frame = phases[name] {
            if name == "initial" && !frame.mappingReturned { mark("phase_incomplete", frame: frame) }
            if name != "initial" && frame.binding == "not_checked" { frame.binding = "unavailable"; mark("phase_incomplete", frame: frame) }
            if frame.axCalled && frame.axCount == nil { mark("read_unavailable", frame: frame) }
        }
        var output: [String: [String: Any]] = [:]
        for name in phaseNames {
            active = name
            output[name] = phases[name].map { projectPhase($0) } ?? emptyPhase()
        }
        active = nil
        var retainedWindows = Set<String>(), retainedCGs = Set<String>()
        for value in output.values {
            for row in value["chrome"] as? [[String: Any]] ?? [] { if let alias = row["w"] as? String { retainedWindows.insert(alias) } }
            for row in value["cg"] as? [[String: Any]] ?? [] { if let alias = row["c"] as? String { retainedCGs.insert(alias) } }
            let ax = value["ax"] as? [String: Any] ?? [:]
            for row in ax["rows"] as? [[String: Any]] ?? [] { if let alias = row["c"] as? String { retainedCGs.insert(alias) } }
        }
        for name in phaseNames {
            guard let frame = phases[name] else { continue }
            if !frame.neededWindows.isSubset(of: retainedWindows) || !frame.neededCGs.isSubset(of: retainedCGs) {
                // A missing observation is not evidence that a capacity limit was reached.
                return fallback("unavailable", "projection_failure")
            }
            output[name]?["state"] = frame.incomplete ? "incomplete" : "complete"
        }
        let result: [String: Any] = ["schema": 1, "status": reasons.isEmpty ? "complete" : "incomplete", "reasons": reasons, "requestedRect": requested, "phases": output]
        guard let bytes = try? JSONSerialization.data(withJSONObject: result) else { return fallback("unavailable", "projection_failure") }
        guard bytes.count <= 32768 else { return fallback("incomplete", "byte_cap") }
        return result
    }
}

// MARK: - owner-local AX access (all handles stay on this thread)
final class Probe {
    let deadline: Double
    let checkpoint: () throws -> Void
    let snapshot: (pid_t) throws -> [WindowRow]
    var firstFailure: Error?
    // axPageDialog's whole-scan rescans and the last real transient AXError code (NAT-RETRY diagnostics).
    var axRetries = 0
    var axLastError: Int?
    let axMessagingTimeout: Float
    init(timeout: Float = 0.025, budget: Double = 4,
         checkpoint: @escaping () throws -> Void = {},
         snapshot: @escaping (pid_t) throws -> [WindowRow] = ChromeNative.readSnapshot) {
        self.axMessagingTimeout = timeout
        self.deadline = ProcessInfo.processInfo.systemUptime + budget
        self.checkpoint = checkpoint
        self.snapshot = snapshot
    }
    func check() throws {
        if let error = firstFailure { throw error }
        try checkpoint()
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "native_read_deadline")
        }
    }
    func around<T>(_ fallback: T, _ body: () -> T) -> T {
        do { try check(); let result = body(); try check(); return result }
        catch { firstFailure = firstFailure ?? error; return fallback }
    }
    @discardableResult
    func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ ignored: Float) -> AXError {
        around(.cannotComplete) { ApplicationServices.AXUIElementSetMessagingTimeout(element, axMessagingTimeout) }
    }
    func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ key: CFString,
                                      _ value: UnsafeMutablePointer<CFTypeRef?>) -> AXError {
        around(.cannotComplete) {
            let bounded = ApplicationServices.AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
            guard bounded == .success else { return bounded }
            return ApplicationServices.AXUIElementCopyAttributeValue(element, key, value)
        }
    }
    func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError {
        around(.cannotComplete) {
            let bounded = ApplicationServices.AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
            guard bounded == .success else { return bounded }
            return chromeNativeWindowNumber(element, id)
        }
    }
    func CGWindowListCopyWindowInfo(_ options: CGWindowListOption, _ relative: CGWindowID) -> CFArray? {
        around(nil) { CoreGraphics.CGWindowListCopyWindowInfo(options, relative) }
    }
    func sameRect(_ a: CGRect, _ b: CGRect) -> Bool { ChromeNative.sameRect(a, b) }
    func dialogInt(_ value: Any?) -> Int? { ChromeNative.dialogInt(value) }
    func bindDialog(pid: Int, dialogCG: Int, dialogRect: CGRect, descriptor: [String],
                    parents: [DialogParent], attachments: [Int], target: [String: Any]?) throws -> DialogIdentity {
        try ChromeNative.bindDialog(pid: pid, dialogCG: dialogCG, dialogRect: dialogRect, descriptor: descriptor,
                                    parents: parents, attachments: attachments, target: target)
    }
    func inspect(pid: pid_t, target: [String: Any]?) throws -> PageDialog? {
        do { let result = try inspectBoundDialog(pid: pid, target: target); try check(); return result }
        catch { throw retryFacts(firstFailure ?? error) }
    }
    /// A Stop or deadline keeps precedence; it only gains this probe's rescan count and last AX status.
    func retryFacts(_ error: Error) -> Error {
        guard axRetries > 0 else { return error }
        if var failure = error as? DialogFailure {
            if failure.axRetries == nil { failure.axRetries = axRetries; failure.axError = axLastError }
            return failure
        }
        if var failure = error as? Failure {
            failure.details["axRetries"] = axRetries
            if let status = axLastError { failure.details["axError"] = status }
            return failure
        }
        return error
    }
func axWindowNumber(_ w: AXUIElement) -> Int? {
    var n: CGWindowID = 0
    return _AXUIElementGetWindow(w, &n) == .success && n != 0 ? Int(n) : nil
}

func axRect(_ w: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?, sv: CFTypeRef?
    var pos = CGPoint.zero, size = CGSize.zero
    guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv) == .success,
          let p = pv, let s = sv, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID(),
          AXValueGetType(p as! AXValue) == .cgPoint, AXValueGetType(s as! AXValue) == .cgSize,
          AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: pos, size: size)
}

func axWindows(pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, axMessagingTimeout)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let wins = value as? [AXUIElement] else { return [] }
    for w in wins { AXUIElementSetMessagingTimeout(w, axMessagingTimeout) }
    return wins
}

func axIsWindowSharingIndicator(_ w: AXUIElement, timeout: Float = 0.025) -> Bool {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(e, timeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
        return value
    }
    guard attr(w, kAXSubroleAttribute) as? String == (kAXDialogSubrole as String),
          attr(w, kAXRoleAttribute) as? String == (kAXWindowRole as String),
          attr(w, kAXTitleAttribute) as? String == "Window",
          let children = attr(w, kAXChildrenAttribute) as? [AXUIElement], children.count == 1 else { return false }
    let button = children[0]
    return attr(button, kAXRoleAttribute) as? String == (kAXButtonRole as String) &&
           attr(button, kAXTitleAttribute) as? String == "WindowSharingSessionButton"
}

func axIsInputSourceIndicator(_ w: AXUIElement, pid: pid_t) -> Bool {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(e, axMessagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
        return value
    }
    guard attr(w, kAXRoleAttribute) as? String == (kAXWindowRole as String),
          attr(w, kAXSubroleAttribute) as? String == (kAXDialogSubrole as String),
          attr(w, kAXTitleAttribute) as? String == "",
          attr(w, kAXModalAttribute) as? Bool == false,
          attr(w, kAXFocusedAttribute) as? Bool == false,
          attr(w, kAXMainAttribute) as? Bool == false,
          let children = attr(w, kAXChildrenAttribute) as? [AXUIElement], children.count == 1 else { return false }
    let button = children[0]
    guard attr(button, kAXRoleAttribute) as? String == (kAXButtonRole as String),
          let title = attr(button, kAXTitleAttribute) as? String,
          let description = attr(button, kAXDescriptionAttribute) as? String,
          attr(button, kAXFocusedAttribute) as? Bool == false else { return false }
    // The incident retained the resolved button label, not which AX attribute
    // supplied it. Accept its exact spelling in either otherwise-empty slot.
    let inputSource = title.isEmpty && description == "com.tencent.inputmethod.wetype.pinyin"
    let capsLock = (title.isEmpty && description == "Capslock Enabled") ||
                   (title == "Capslock Enabled" && description.isEmpty)
    guard inputSource || capsLock else { return false }
    var buttonChildren: CFTypeRef?
    let childrenStatus = AXUIElementCopyAttributeValue(button, kAXChildrenAttribute as CFString, &buttonChildren)
    // AX reports noValue for this leaf button; unsupported/failed reads are not evidence of a leaf.
    guard childrenStatus == .noValue ||
          (childrenStatus == .success && (buttonChildren as? [AXUIElement])?.isEmpty == true) else { return false }
    guard let number = axWindowNumber(w),
          let focused = attr(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID(),
          let focusedNumber = axWindowNumber(focused as! AXUIElement), focusedNumber != number,
          let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]],
          let row = windows.first(where: { ($0[kCGWindowNumber as String] as? Int) == number }),
          (row[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          (row[kCGWindowLayer as String] as? Int) == 3,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
          width > 0, width <= 120, height > 0, height <= 120 else { return false }
    return true
}

func axIsChromeTranslationBubble(_ w: AXUIElement) -> Bool {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(e, axMessagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success else { return nil }
        return value
    }
    guard attr(w, kAXRoleAttribute) as? String == "AXWindow",
          attr(w, kAXSubroleAttribute) as? String == "AXUnknown",
          attr(w, kAXModalAttribute) as? Bool == false,
          attr(w, kAXFocusedAttribute) as? Bool == false,
          attr(w, kAXMainAttribute) as? Bool == false,
          let title = attr(w, kAXTitleAttribute) as? String,
          let expected = ["翻译此页？": ["翻译选项", "关闭"],
                          "Translate this page?": ["Translate options", "Close"]][title],
          let children = attr(w, kAXChildrenAttribute) as? [AXUIElement], children.count == 1,
          attr(children[0], kAXRoleAttribute) as? String == "AXGroup",
          attr(children[0], kAXSubroleAttribute) as? String == "AXApplicationAlertDialog",
          attr(children[0], kAXTitleAttribute) as? String == title else { return false }
    var count = 0, tabGroups = 0, tabs = 0, labels: [String] = []
    func walk(_ e: AXUIElement, _ depth: Int) -> Bool {
        count += 1
        guard depth <= 12, count <= 64, let role = attr(e, kAXRoleAttribute) as? String else { return false }
        switch role {
        case "AXGroup": break
        case "AXTabGroup": tabGroups += 1
        case "AXRadioButton":
            guard attr(e, kAXSubroleAttribute) as? String == "AXTabButton",
                  let label = attr(e, kAXTitleAttribute) as? String, !label.isEmpty else { return false }
            tabs += 1
        case "AXButton":
            let title = attr(e, kAXTitleAttribute) as? String ?? ""
            let label = title.isEmpty ? attr(e, kAXDescriptionAttribute) as? String ?? "" : title
            guard expected.contains(label) else { return false }
            labels.append(label)
        default: return false
        }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &value)
        if status == .noValue { return role == "AXButton" || role == "AXRadioButton" }
        guard status == .success, let kids = value as? [AXUIElement] else { return false }
        return kids.allSatisfy { walk($0, depth + 1) }
    }
    return walk(children[0], 0) && tabGroups == 1 && tabs == 2 && labels.sorted() == expected.sorted()
}

/// PERM1: the first Chrome layer-0 window of at least 100 × 100 above the bound target in the on-screen CG order (front
/// to back), the target's rect, and whether it is the only such window there. nil: the target is Chrome's first such
/// window, or it is not listed. Read-only; window numbers and rects only.
func popupAbove(_ t: Target) -> Popup.Above? {
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    func rect(_ row: [String: Any]) -> CGRect? { (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) } }
    let pid = Int(t.chromePid)
    let chrome = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    guard let i = chrome.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == t.cgWindow }), let target = rect(chrome[i]) else { return nil }
    let above = chrome[..<i].filter { rect($0).map { $0.width >= 100 && $0.height >= 100 } == true }
    guard let first = above.first, let number = first[kCGWindowNumber as String] as? Int, let r = rect(first) else { return nil }
    return Popup.Above(number: number, rect: r, target: target, bound: above.count == 1, targetNumber: t.cgWindow)
}

/// PERM1: one Chrome window's AX and CG shape for Popup.classify (bounded walk: depth 8, 64 nodes). Button labels are
/// read only to be compared inside the classifier; nothing here is logged, returned to the bridge or kept.
func popupShape(_ number: Int, pid: pid_t) -> Popup.Shape {
    var s = Popup.Shape()
    if let rows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]],
       let row = rows.first(where: { ($0[kCGWindowNumber as String] as? Int) == number }) {
        s.ownerIsChrome = (row[kCGWindowOwnerPID as String] as? Int) == Int(pid)
        s.layer = row[kCGWindowLayer as String] as? Int
        s.onScreen = (row[kCGWindowIsOnscreen as String] as? Bool) == true
        s.rect = (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
    }
    func attr(_ e: AXUIElement, _ key: String) -> (AXError, CFTypeRef?) {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, key as CFString, &value)
        return (status, value)
    }
    let windows = axWindows(pid: pid)
    for w in windows where attr(w, kAXSubroleAttribute).1 as? String == (kAXStandardWindowSubrole as String) {
        if let sheets = attr(w, "AXSheets").1 as? [AXUIElement], sheets.contains(where: { axWindowNumber($0) == number }) { s.inSheet = true }
    }
    guard let w = windows.first(where: { axWindowNumber($0) == number }) else { return s }
    if axIsChromeTranslationBubble(w) { s.known = "translate" }
    else if axIsWindowSharingIndicator(w) || axIsInputSourceIndicator(w, pid: pid) { s.known = "indicator" }
    s.role = attr(w, kAXRoleAttribute).1 as? String ?? ""
    s.subrole = attr(w, kAXSubroleAttribute).1 as? String
    for key in [kAXWindowAttribute, kAXParentAttribute] {
        if let v = attr(w, key).1, CFGetTypeID(v) == AXUIElementGetTypeID(), let n = axWindowNumber(v as! AXUIElement), n != number { s.parentWindow = n }
    }
    s.modal = attr(w, kAXModalAttribute).1 as? Bool
    var nodes = 0
    func walk(_ e: AXUIElement, _ depth: Int) {
        nodes += 1
        guard depth <= 8, nodes <= 64 else { s.complete = false; return }
        let (status, value) = attr(e, kAXChildrenAttribute)
        if status == .noValue { return }
        guard status == .success, let kids = value as? [AXUIElement] else { s.complete = false; return }
        for kid in kids {
            guard let role = attr(kid, kAXRoleAttribute).1 as? String else { s.complete = false; continue }
            if role == (kAXButtonRole as String) {
                let title = attr(kid, kAXTitleAttribute).1 as? String ?? ""
                s.labels.append(title.isEmpty ? attr(kid, kAXDescriptionAttribute).1 as? String ?? "" : title)
                s.enabled.append(attr(kid, kAXEnabledAttribute).1 as? Bool == true)
                s.elements.append(kid)
            } else if role == (kAXTextFieldRole as String) || role == (kAXTextAreaRole as String) {
                s.fields += 1
            } else if !Popup.roles.contains(role) {
                s.foreign += 1
            }
            walk(kid, depth + 1)
        }
    }
    walk(w, 0)
    return s
}

/// PERM1: immediately before the one write: the button is enabled and offers AXPress (as dialog_button's check).
func popupPressable(_ e: AXUIElement) -> Bool {
    var enabled: CFTypeRef?, actions: CFArray?
    guard AXUIElementCopyAttributeValue(e, kAXEnabledAttribute as CFString, &enabled) == .success, enabled as? Bool == true else { return false }
    let status = around(AXError.cannotComplete) { AXUIElementCopyActionNames(e, &actions) }
    return status == .success && (actions as? [String])?.contains(kAXPressAction as String) == true
}

/// PERM1 ruling 2: a positively identified Chrome permission prompt never blocks the renderer, so it is not a page
/// dialog for the read pre-checks; the input tools answer it inside the held takeover. Same classifier, no target
/// (nothing is pressed here).
/// PERM1 r1 A4 (and A1): what the read pre-check's dialog is. "js_dialog" only with positive evidence that it is a
/// page's own dialog (alert / confirm / prompt / "Leave site?"): a sheet of a standard window, AXModal, or exactly one of
/// Chrome's JS-dialog button sets; anything else is an unclassified browser surface ("browser"). attached: its AXWindow
/// or AXParent names its bound parent window. Only the surface word and the boolean leave the helper.
func pageDialogSurface(_ d: PageDialog, pid: pid_t) -> (surface: String, attached: Bool) {
    func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
    }
    var inSheet = false, attached = false
    for w in axWindows(pid: pid) where attr(w, kAXSubroleAttribute) as? String == (kAXStandardWindowSubrole as String) {
        if let sheets = attr(w, "AXSheets") as? [AXUIElement], sheets.contains(where: { CFEqual($0, d.window) }) { inSheet = true }
    }
    for key in [kAXWindowAttribute, kAXParentAttribute] {
        if let v = attr(d.window, key), CFGetTypeID(v) == AXUIElementGetTypeID(), let n = axWindowNumber(v as! AXUIElement),
           let parent = d.identity?.cgWindow, n == parent { attached = true }
    }
    let labels = d.buttons.map { $0.0 }
    let js = inSheet || attr(d.window, kAXModalAttribute) as? Bool == true ||
        (Set(labels).count == labels.count && Popup.jsDialogSets.contains(Set(labels)))
    return (js ? "js_dialog" : "browser", attached)
}

func axIsChromePermissionPrompt(_ w: AXUIElement, pid: pid_t) -> Bool {
    guard let number = axWindowNumber(w) else { return false }
    return Popup.classify(popupShape(number, pid: pid), target: nil, bound: true).kind == "permission"
}

func axPageDialog(pid: pid_t) throws -> PageDialog? {
    let deadline = Date().addingTimeInterval(4)
    // A busy target (cannotComplete) or an element gone mid-scan (invalidUIElement) proves nothing either
    // way: the whole window list is rescanned, bounded by count and this deadline. Never "no dialog" by itself.
    struct TransientRead: Error { let point: DialogFailure.ProbePoint, status: AXError }
    var retries = 0, lastStatus: AXError? = nil
    func scan() throws -> PageDialog? {
    var seen = 0
    func attr(_ e: AXUIElement, _ key: String, optional: Bool = false) throws -> CFTypeRef? {
        guard Date() < deadline else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_attribute_deadline) }
        AXUIElementSetMessagingTimeout(e, axMessagingTimeout)
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, key as CFString, &value)
        if optional && (status == .noValue || status == .attributeUnsupported) { return nil }
        if status == .cannotComplete || status == .invalidUIElement { throw TransientRead(point: .native_attribute_read, status: status) }
        guard status == .success, value != nil else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_attribute_read) }
        return value
    }
    guard let wins = try attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement], wins.count <= 64 else {
        throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_windows_shape)
    }
    var candidates: [AXUIElement] = []
    for w in wins {
        guard let subrole = try attr(w, kAXSubroleAttribute) as? String else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_subrole_shape)
        }
        if subrole == (kAXStandardWindowSubrole as String) {
            if let sheetsValue = try attr(w, "AXSheets", optional: true) {
                guard let sheets = sheetsValue as? [AXUIElement], sheets.count <= 4 else {
                    throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_sheets_shape)
                }
                candidates.append(contentsOf: sheets)
            }
            continue
        }
        if axIsWindowSharingIndicator(w) || axIsInputSourceIndicator(w, pid: pid) || axIsChromeTranslationBubble(w) { continue }
        if axIsChromePermissionPrompt(w, pid: pid) { continue }   // PERM1 ruling 2: answered inside the input hold
        candidates.append(w)
    }
    var unique: [AXUIElement] = []
    for candidate in candidates where !unique.contains(where: { CFEqual($0, candidate) }) { unique.append(candidate) }
    guard unique.count <= 1 else { throw DialogFailure(code: "dialog_ambiguous", stage: "dialog_inspect") }
    guard let w = unique.first else { return nil }
    var texts: [String] = [], buttons: [(String, AXUIElement)] = [], fields: [AXUIElement] = [], descriptor: [String] = []
    var templateComplete = true
    func walk(_ e: AXUIElement, _ depth: Int, _ path: String) throws {
        seen += 1
        guard depth <= 12, seen <= 600, let role = try attr(e, kAXRoleAttribute) as? String else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_walk_guard)
        }
        descriptor.append(path + ":" + role + ":" + String(CFHash(e)))
        if role == (kAXButtonRole as String) {
            let titleValue = try attr(e, kAXTitleAttribute, optional: true)
            guard titleValue == nil || titleValue is String else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_button_title) }
            let title = (titleValue as? String) ?? ""
            let labelValue = title.isEmpty ? try attr(e, kAXDescriptionAttribute) : title as CFTypeRef
            guard let label = labelValue as? String, !label.isEmpty else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_button_label) }
            buttons.append((label, e)); descriptor.append(label)
        } else if role == (kAXStaticTextRole as String) {
            guard let value = try attr(e, kAXValueAttribute) as? String else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_text_value) }
            descriptor.append(value)
            let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if v.count > 300 || ChromeNative.promptText(value) != ChromeNative.promptText(v) { templateComplete = false }
            if !v.isEmpty { texts.append(String(v.prefix(300))) }
        } else if role == (kAXTextFieldRole as String) || role == (kAXTextAreaRole as String) { fields.append(e) }
        // noValue is a proven leaf; failed/unsupported child reads are not proof of completeness.
        var kidsValue: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kidsValue)
        if status == .noValue { return }
        if status == .cannotComplete || status == .invalidUIElement { throw TransientRead(point: .native_children_read, status: status) }
        guard status == .success, let kids = kidsValue as? [AXUIElement] else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_children_read)
        }
        for (i, child) in kids.enumerated() { try walk(child, depth + 1, path + "." + String(i)) }
    }
    try walk(w, 0, "0")
    guard Date() < deadline, !buttons.isEmpty, let title = try attr(w, kAXTitleAttribute) as? String else {
        throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: .native_dialog_final)
    }
    descriptor.append(title)
    templateComplete = templateComplete && texts.count <= 32 && buttons.count <= 8 &&
        buttons.allSatisfy { $0.0.utf16.count <= 256 } && ([title] + texts + buttons.map { $0.0 }).joined().utf16.count <= 4096
    return PageDialog(title: title, texts: texts, buttons: buttons, fields: fields, window: w,
                      descriptor: descriptor, templateComplete: templateComplete)
    }
    while true {
        do { return try scan() }
        catch let transient as TransientRead {
            // A Stop or the probe budget reads as cannotComplete with firstFailure set: never rescanned,
            // and that stand-in status is not an AX error. The caller rethrows the first failure.
            guard firstFailure == nil else {
                throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: transient.point,
                                    axRetries: retries > 0 ? retries : nil, axError: lastStatus.map { Int($0.rawValue) })
            }
            lastStatus = transient.status
            axLastError = Int(transient.status.rawValue)
            guard retries < 4, Date() < deadline else {
                throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_inspect", dialogProbePoint: transient.point,
                                    axRetries: retries, axError: Int(transient.status.rawValue))
            }
            retries += 1
            axRetries += 1
            axRetryPause(until: deadline)
        } catch var failure as DialogFailure where retries > 0 {
            failure.axRetries = retries; failure.axError = lastStatus.map { Int($0.rawValue) }
            throw failure
        }
    }
}

/// The pause between whole-scan rescans; the next read still checks Stop and both deadlines.
func axRetryPause(until deadline: Date) {
    let wait = min(0.05, deadline.timeIntervalSinceNow)
    if wait > 0 { Thread.sleep(forTimeInterval: wait) }
}

func dialogAX(_ element: AXUIElement, _ key: String, optional: Bool = false) throws -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, axMessagingTimeout)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    if optional && (status == .noValue || status == .attributeUnsupported) { return nil }
    guard status == .success, value != nil else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
    return value
}

func inspectBoundDialog(pid: pid_t, target: [String: Any]?) throws -> PageDialog? {
    guard var d = try axPageDialog(pid: pid) else {
        if let target = target {
            guard let expectedPID = ChromeNative.dialogInt(target["chromePid"]), expectedPID == Int(pid),
                  let windowID = ChromeNative.dialogInt(target["windowId"]), let tabID = ChromeNative.dialogInt(target["tabId"]),
                  let cgID = ChromeNative.dialogInt(target["cgWindow"]),
                  let row = try snapshot(pid).first(where: { $0.id == windowID }), row.tabs.contains(tabID),
                  let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
                throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_binding")
            }
            let matches = windows.filter { ($0[kCGWindowNumber as String] as? Int) == cgID &&
                ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
            guard matches.count == 1, let bounds = matches[0][kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), sameRect(rect, row.bounds) else {
                throw DialogFailure(code: "dialog_identity_mismatch", stage: "dialog_binding")
            }
        }
        return nil
    }
    let currentRows = try snapshot(pid).filter { !$0.minimized }
    let chromeRows = currentRows.map { ($0.id, $0.activeTab, $0.bounds) }
    guard let cg = axWindowNumber(d.window),
          let cgRows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]],
          let axWins = try dialogAX(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] else {
        throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
    }
    func verifiedRect(_ element: AXUIElement, standard: Bool) throws -> CGRect {
        guard let n = axWindowNumber(element), let r = axRect(element),
              [r.minX, r.minY, r.width, r.height].allSatisfy({ $0.isFinite }), r.width > 0, r.height > 0 else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
        }
        let rows = cgRows.filter { ($0[kCGWindowNumber as String] as? Int) == n }
        guard rows.count == 1, let row = rows.first, (row[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              (row[kCGWindowIsOnscreen as String] as? Bool) == true,
              let layer = row[kCGWindowLayer as String] as? Int, !standard || layer == 0,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let cr = CGRect(dictionaryRepresentation: bounds), sameRect(r, cr) else {
            throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
        }
        return r
    }
    let dialogRect = try verifiedRect(d.window, standard: false)
    var standards: [(AXUIElement, Int, CGRect)] = [], attachments: [Int] = []
    for window in axWins {
        guard let role = try dialogAX(window, kAXSubroleAttribute) as? String else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
        if role != (kAXStandardWindowSubrole as String) { continue }
        guard let n = axWindowNumber(window), n != cg,
              let minimized = try dialogAX(window, kAXMinimizedAttribute) as? Bool else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
        if minimized { continue }
        standards.append((window, n, try verifiedRect(window, standard: true)))
        if let sheetsValue = try dialogAX(window, "AXSheets", optional: true) {
            guard let sheets = sheetsValue as? [AXUIElement] else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
            if sheets.contains(where: { CFEqual($0, d.window) }) { attachments.append(n) }
        }
    }
    // Explicit AXWindow/AXParent attachment is additional evidence; it must agree with the
    // unique eligible standard parent. App parents/noValue add no invented attachment.
    for key in [kAXWindowAttribute, kAXParentAttribute] {
        if let value = try dialogAX(d.window, key, optional: true) {
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
            let e = value as! AXUIElement
            if let n = axWindowNumber(e) {
                if n != cg { attachments.append(n) }
            } else if try dialogAX(e, kAXRoleAttribute) as? String != (kAXApplicationRole as String) {
                // An unreadable parent/window reference cannot be silently discarded.
                throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding")
            }
        }
    }
    var parents: [DialogParent] = []
    for (_, n, r) in standards {
        let matches = chromeRows.filter { sameRect($0.2, r) }
        guard matches.count == 1, standards.filter({ sameRect($0.2, r) }).count == 1 else { throw DialogFailure(code: "dialog_ambiguous", stage: "dialog_binding") }
        parents.append(DialogParent(cgWindow: n, windowId: matches[0].0, tabId: matches[0].1, rect: r))
    }
    // Missing AX standard windows might hide an overlapping Chrome parent.
    guard parents.count == chromeRows.count else { throw DialogFailure(code: "dialog_probe_unknown", stage: "dialog_binding") }
    d.identity = try bindDialog(pid: Int(pid), dialogCG: cg, dialogRect: dialogRect, descriptor: d.descriptor,
                                parents: parents, attachments: attachments, target: target)
    if let identity = d.identity, let row = currentRows.first(where: { $0.id == identity.windowId && $0.activeTab == identity.tabId }),
       let url = row.tabURLs[identity.tabId] { d.origin = ChromeNative.promptOrigin(url) }
    return d
}
}
}

extension ChromeNative {
    struct WindowDisplayRecord {
        let id: Int, full: CGRect, awake: Bool, mirrored: Bool, main: Bool
    }
    struct WindowScreenRecord {
        let id: Int, frame: CGRect, visible: CGRect, safeTop: CGFloat
    }
    struct WindowDisplay {
        let id: Int, full: CGRect, usable: CGRect, main: Bool
    }
    struct WindowDisplaySet {
        let valid: [WindowDisplay], unavailable: [WindowDisplayRecord]
    }
    struct WindowGeometryIntent {
        let mode: String
        let displayId: Int?
    }
    struct WindowGeometryPlan {
        let mode: String, before: CGRect, beforeCG: CGRect, display: WindowDisplay, branch: String, fitted: CGRect
        let needsWrite: Bool
        var json: [String: Any] {
            ["mode": mode, "beforeBounds": ["left": before.minX, "top": before.minY,
                "width": before.width, "height": before.height], "displayId": display.id,
             "branch": branch, "possiblyChanged": false]
        }
    }
    // This sampler contains OS reads only. Selection and validation below also
    // run unchanged in the inert Owner capsule.
    static func sampleWindowDisplays() throws -> ([WindowDisplayRecord], [WindowScreenRecord]) {
        var ids = [CGDirectDisplayID](repeating: 0, count: 64), count: UInt32 = 0
        guard CGGetActiveDisplayList(64, &ids, &count) == .success, count > 0, count <= 64 else {
            throw Failure("native_display_unavailable", "native_display_read")
        }
        let displays = ids.prefix(Int(count)).map { id in
            WindowDisplayRecord(id: Int(id), full: CGDisplayBounds(id), awake: CGDisplayIsAsleep(id) == 0,
                mirrored: CGDisplayMirrorsDisplay(id) != kCGNullDirectDisplay, main: CGDisplayIsMain(id) != 0)
        }
        let screens = NSScreen.screens.map { screen in
            WindowScreenRecord(id: (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0,
                frame: screen.frame, visible: screen.visibleFrame, safeTop: screen.safeAreaInsets.top)
        }
        return (displays, screens)
    }
    static func geometryRectValid(_ r: CGRect) -> Bool {
        [r.origin.x, r.origin.y, r.width, r.height, r.maxX, r.maxY].allSatisfy { $0.isFinite } && r.width > 0 && r.height > 0
    }
    static func geometryContains(_ outer: CGRect, _ inner: CGRect) -> Bool {
        geometryRectValid(outer) && geometryRectValid(inner) && inner.minX >= outer.minX && inner.minY >= outer.minY &&
            inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
    }
    static func geometryUsableRect(_ display: WindowDisplayRecord, _ screen: WindowScreenRecord) -> CGRect? {
        let f = screen.frame, c = display.full
        guard geometryRectValid(f), geometryRectValid(c), geometryRectValid(screen.visible),
              f.width == c.width, f.height == c.height, screen.safeTop.isFinite,
              screen.safeTop >= 0, screen.safeTop < f.height else { return nil }
        var u = screen.visible.intersection(f)
        guard geometryRectValid(u) else { return nil }
        let top = min(u.maxY, f.maxY - screen.safeTop)
        u.size.height = top - u.minY
        guard geometryRectValid(u), geometryContains(f, u) else { return nil }
        let left = ceil(c.minX + (u.minX - f.minX)), upper = ceil(c.minY + (f.maxY - u.maxY))
        let right = floor(c.minX + (u.maxX - f.minX)), lower = floor(c.minY + (f.maxY - u.minY))
        let result = CGRect(x: left, y: upper, width: right - left, height: lower - upper)
        return geometryContains(c, result) ? result : nil
    }
    static func windowDisplays(_ records: [WindowDisplayRecord], _ screens: [WindowScreenRecord]) throws -> WindowDisplaySet {
        guard Set(records.map { $0.id }).count == records.count,
              screens.filter({ $0.id > 0 }).allSatisfy({ screen in screens.filter { $0.id == screen.id }.count == 1 }) else {
            throw Failure("native_display_unavailable", "native_display_read")
        }
        var valid: [WindowDisplay] = [], unavailable: [WindowDisplayRecord] = []
        for record in records where record.awake && !record.mirrored {
            guard record.id > 0, record.id <= Int(UInt32.max), geometryRectValid(record.full),
                  let screen = screens.first(where: { $0.id == record.id }),
                  let usable = geometryUsableRect(record, screen) else {
                if geometryRectValid(record.full) { unavailable.append(record) }
                continue
            }
            valid.append(WindowDisplay(id: record.id, full: record.full, usable: usable, main: record.main))
        }
        guard !valid.isEmpty else { throw Failure("native_display_unavailable", "native_display_read") }
        return WindowDisplaySet(valid: valid, unavailable: unavailable)
    }
    static func geometryFit(_ candidate: CGRect, _ usable: CGRect) throws -> CGRect {
        guard geometryRectValid(candidate), geometryRectValid(usable) else { throw Failure("native_bounds_invalid", "native_prepare") }
        let w = min(floor(candidate.width), usable.width), h = min(floor(candidate.height), usable.height)
        let x = min(max(ceil(candidate.minX), usable.minX), usable.maxX - w)
        let y = min(max(ceil(candidate.minY), usable.minY), usable.maxY - h)
        let result = CGRect(x: x, y: y, width: w, height: h)
        guard geometryContains(usable, result), [result.minX, result.minY, result.maxX, result.maxY].allSatisfy({ Int16(exactly: $0) != nil }) else {
            throw Failure("native_bounds_invalid", "native_prepare")
        }
        return result
    }
    static func geometryIntent(_ intent: [String: Any]) throws -> WindowGeometryIntent? {
        let kind = intent["kind"] as? String
        let hasFit = intent.keys.contains("fitCurrent"), hasBounds = intent.keys.contains("bounds"), hasDisplay = intent.keys.contains("displayId")
        func invalid() -> Failure { Failure("native_request_invalid", "native_prepare") }
        func fitBoolean() throws -> Bool {
            guard let n = intent["fitCurrent"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw invalid() }
            return n.boolValue
        }
        if kind == "activate" {
            guard !hasBounds, !hasDisplay else { throw invalid() }
            return try hasFit && fitBoolean() ? WindowGeometryIntent(mode: "fit-current", displayId: nil) : nil
        }
        if kind == "moveWindow", hasFit {
            guard !hasBounds, !hasDisplay, try fitBoolean() else { throw invalid() }
            return WindowGeometryIntent(mode: "fit-current", displayId: nil)
        }
        if kind == "newWindow" || kind == "moveWindow" {
            guard !hasFit, hasBounds, hasDisplay, let id = dialogInt(intent["displayId"]), id <= Int(UInt32.max) else { throw invalid() }
            return WindowGeometryIntent(mode: "placement", displayId: id)
        }
        guard !hasFit, !hasBounds, !hasDisplay else { throw invalid() }
        return nil
    }
    static func geometryPlan(_ mode: WindowGeometryIntent, before: CGRect, cg: CGRect,
                             requested: CGRect?, displays: WindowDisplaySet) throws -> WindowGeometryPlan {
        guard geometryRectValid(before), geometryRectValid(cg), sameRect(before, cg) else {
            throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
        }
        func tie(_ a: WindowDisplay, _ b: WindowDisplay) -> Bool { a.main != b.main ? a.main : a.id < b.id }
        func overlap(_ r: CGRect, _ f: CGRect) -> CGFloat {
            let intersection = r.intersection(f)
            return geometryRectValid(intersection) ? intersection.width * intersection.height : 0
        }
        func distance(_ r: CGRect, _ f: CGRect) -> CGFloat {
            let dx = max(0, max(f.minX - r.maxX, r.minX - f.maxX)), dy = max(0, max(f.minY - r.maxY, r.minY - f.maxY))
            return dx * dx + dy * dy
        }
        let ordered = displays.valid.sorted(by: tie)
        let full = ordered.first { geometryContains($0.full, before) && geometryContains($0.full, cg) && sameRect(before, $0.full) && sameRect(cg, $0.full) }
        if let selected = mode.displayId {
            guard let display = ordered.first(where: { $0.id == selected }), let requested else {
                throw Failure("native_display_unavailable", "native_display_read")
            }
            let fitted = try geometryFit(requested, display.usable)
            if let full, (!geometryContains(full.usable, before) || !geometryContains(full.usable, cg)),
               full.id != display.id || before != fitted || cg != fitted {
                throw Failure("native_full_frame_conflict", "native_geometry_prepare")
            }
            return WindowGeometryPlan(mode: mode.mode, before: before, beforeCG: cg, display: display, branch: "usable", fitted: fitted,
                                      needsWrite: before != fitted || cg != fitted)
        }
        let bestValidFull = ordered.map { overlap(before, $0.full) }.max() ?? 0
        if displays.unavailable.contains(where: { overlap(before, $0.full) > 0 && overlap(before, $0.full) >= bestValidFull }) {
            throw Failure("native_display_unavailable", "native_display_read")
        }
        if let fitting = ordered.first(where: { geometryContains($0.usable, before) && geometryContains($0.usable, cg) }) {
            return WindowGeometryPlan(mode: mode.mode, before: before, beforeCG: cg, display: fitting, branch: "usable", fitted: before, needsWrite: false)
        }
        if let full {
            return WindowGeometryPlan(mode: mode.mode, before: before, beforeCG: cg, display: full, branch: "full-frame", fitted: before, needsWrite: false)
        }
        guard let display = ordered.sorted(by: { a, b in
            let oa = overlap(before, a.usable), ob = overlap(before, b.usable)
            if oa != ob { return oa > ob }
            if oa == 0 { let da = distance(before, a.usable), db = distance(before, b.usable); if da != db { return da < db } }
            return tie(a, b)
        }).first else { throw Failure("native_display_unavailable", "native_display_read") }
        return WindowGeometryPlan(mode: mode.mode, before: before, beforeCG: cg, display: display, branch: "usable", fitted: try geometryFit(before, display.usable), needsWrite: true)
    }
    static func geometryPostcondition(_ plan: WindowGeometryPlan, row: CGRect, cg: CGRect, displays: WindowDisplaySet) throws {
        guard let display = displays.valid.first(where: { $0.id == plan.display.id }),
              display.full == plan.display.full, display.usable == plan.display.usable else {
            throw Failure("native_display_unavailable", "native_display_read")
        }
        guard geometryRectValid(row), geometryRectValid(cg), sameRect(row, cg) else {
            throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
        }
        if plan.branch == "full-frame" {
            guard geometryContains(display.full, row), geometryContains(display.full, cg),
                  sameRect(row, display.full), sameRect(cg, display.full) else {
                throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
            }
        } else {
            guard geometryContains(display.usable, row), geometryContains(display.usable, cg),
                  plan.mode != "placement" || (sameRect(row, plan.fitted) && sameRect(cg, plan.fitted)) else {
                throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
            }
        }
    }

    struct Target: Equatable {
        let chromePid: Int32
        let windowId: Int, tabId: Int, cgWindow: Int
        init(_ value: [String: Any]) throws {
            guard let pid = ChromeNative.dialogInt(value["chromePid"]), pid <= Int(Int32.max),
                  let win = ChromeNative.dialogInt(value["windowId"]), let tab = ChromeNative.dialogInt(value["tabId"]),
                  let cg = ChromeNative.dialogInt(value["cgWindow"]) else {
                throw Failure("native_target_invalid", "native_binding")
            }
            chromePid = Int32(pid); windowId = win; tabId = tab; cgWindow = cg
        }
        var json: [String: Any] { ["chromePid": Int(chromePid), "windowId": windowId, "tabId": tabId, "cgWindow": cgWindow] }
        func sameWindow(_ other: Target) -> Bool {
            chromePid == other.chromePid && windowId == other.windowId && cgWindow == other.cgWindow
        }
    }
    struct Failure: Error {
        let code: String, stage: String
        var osStatus: Int? = nil
        var details: [String: Any] = [:]
        init(_ code: String, _ stage: String, osStatus: Int? = nil, details: [String: Any] = [:]) {
            self.code = code; self.stage = stage; self.osStatus = osStatus; self.details = details
        }
        var json: [String: Any] {
            var r: [String: Any] = ["ok": false, "error": code, "stage": stage]
            if let status = osStatus { r["osStatus"] = status }
            return r.merging(details) { first, _ in first }
        }
    }
    struct WindowRow: Sendable {
        let id: Int, tabs: [Int], activeTab: Int, index: Int
        let bounds: CGRect, minimized: Bool, title: String
        var tabURLs: [Int: String] = [:]
    }
    struct ReadFailure: Error, Sendable, CustomNSError {
        enum Point: String, Sendable {
            case windows, window_ids, window, bounds, minimized, index, tabs, tab_ids, tab_urls, tab_url_ids
            case active_tab, active_tab_id, title, window_ids_shape, tab_url_ids_shape, row_shape, runner
        }
        enum Reason: String, Sendable { case before_deadline, nil_or_type, after_deadline, shape, runner_other, objc_exception }
        let code: String; let osStatus: Int?
        var point: Point? = nil
        var reason: Reason? = nil
        /// The caught Objective-C exception's name (reason objc_exception only); never its reason text.
        var exceptionName: String? = nil
        var details: [String: Any] {
            guard ["native_read_unknown", "native_read_timeout"].contains(code), let point, let reason else { return [:] }
            var facts: [String: Any] = ["nativeReadPoint": point.rawValue, "nativeReadReason": reason.rawValue]
            if reason == .objc_exception, let exceptionName { facts["exceptionName"] = exceptionName }
            return facts
        }
        /// A ScriptingBridge exception caught at this getter (CRASH1): the same unknown read, never a value.
        /// The name comes through NSError, so this type needs nothing beyond Foundation.
        static func caught(_ error: Error, at point: Point) -> ReadFailure {
            ReadFailure(code: "native_read_unknown", osStatus: nil, point: point, reason: .objc_exception,
                        exceptionName: (error as NSError).userInfo["exceptionName"] as? String ?? "unnamed_exception")
        }
        /// CRASH1 r2: chromectl's dialog catch-all names no ChromeNative type; only these closed facts travel,
        /// under this domain.
        static var errorDomain: String { "MyChromeNativeReadFailure" }
        var errorUserInfo: [String: Any] { details }
    }
    final class ReadErrors: NSObject, SBApplicationDelegate {
        var status: Int?
        func eventDidFail(_ event: UnsafePointer<AppleEvent>, withError error: Error) -> Any? {
            status = (error as NSError).code; return nil
        }
    }
    /// Thread-local ScriptingBridge objects. Only value rows escape this method.
    /// SBApplication/SBElementArray/SBObject here are the boundary classes at the end of this file.
    static func readSnapshot(_ pid: pid_t) throws -> [WindowRow] {
        // Total snapshot budget; the owner mailbox retains a separate 0.5s margin.
        let deadline = ProcessInfo.processInfo.systemUptime + 3
        guard pid > 0, let app = SBApplication(processIdentifier: pid) else {
            throw ReadFailure(code: "chrome_not_running", osStatus: nil)
        }
        let errors = ReadErrors(); app.delegate = errors
        app.timeout = 12 // Apple Event ticks; a read never inherits the one-minute default.
        func checked<T>(_ point: ReadFailure.Point, _ read: () throws -> T?) throws -> T {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw ReadFailure(code: "native_read_timeout", osStatus: nil, point: point, reason: .before_deadline) }
            let value: T?
            // Only the boundary throws here: a caught exception is this getter's unknown read. An Apple
            // Event error reported in the same read keeps its precedence.
            do { value = try read() } catch {
                if let code = errors.status { throw ReadFailure(code: code == -1743 ? "native_permission_required" : "chrome_error", osStatus: code) }
                throw ReadFailure.caught(error, at: point)
            }
            if let code = errors.status {
                throw ReadFailure(code: code == -1743 ? "native_permission_required" : "chrome_error", osStatus: code)
            }
            guard let value = value else {
                throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: point, reason: .nil_or_type)
            }
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: point, reason: .after_deadline)
            }
            return value
        }
        let windows = try checked(.windows) { try app.value(forKey: "windows") as? SBElementArray }
        let rawIDs = try checked(.window_ids) { try windows.value(forKey: "id") as? [Any] }
        let ids = rawIDs.map { num($0) }
        guard ids.count <= 64, ids.allSatisfy({ $0 > 0 }), Set(ids).count == ids.count else {
            throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: .window_ids_shape, reason: .shape)
        }
        var result: [WindowRow] = []
        for id in ids {
            let window = try checked(.window) { try windows.object(withID: String(id)) as? SBObject }
            let bounds = try checked(.bounds) { (try window.value(forKey: "bounds") as? NSValue)?.rectValue }
            let minimized = try checked(.minimized) { try window.value(forKey: "minimized") as? Bool }
            let indexValue = try checked(.index) { try window.value(forKey: "index") }
            let tabs = try checked(.tabs) { try window.value(forKey: "tabs") as? SBElementArray }
            let tabValues = try checked(.tab_ids) { try tabs.value(forKey: "id") as? [Any] }
            let tabIDs = tabValues.map { num($0) }
            let urls = try checked(.tab_urls) { try tabs.value(forKey: "URL") as? [String] }
            let repeatedIDs = try checked(.tab_url_ids) { try tabs.value(forKey: "id") as? [Any] }.map { num($0) }
            guard repeatedIDs == tabIDs, urls.count == tabIDs.count else { throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: .tab_url_ids_shape, reason: .shape) }
            let active = try checked(.active_tab) { try window.value(forKey: "activeTab") as? SBObject }
            let activeValue = try checked(.active_tab_id) { try active.value(forKey: "id") }
            let activeID = num(activeValue)
            let title = try checked(.title) { try active.value(forKey: "title") as? String }
            guard tabIDs.count <= 2000, tabIDs.allSatisfy({ $0 > 0 }), Set(tabIDs).count == tabIDs.count,
                  tabIDs.contains(activeID), num(indexValue) > 0,
                  [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite }),
                  bounds.width > 0, bounds.height > 0 else { throw ReadFailure(code: "native_read_unknown", osStatus: nil, point: .row_shape, reason: .shape) }
            result.append(WindowRow(id: id, tabs: tabIDs, activeTab: activeID, index: num(indexValue),
                                    bounds: bounds, minimized: minimized, title: title, tabURLs: Dictionary(uniqueKeysWithValues: zip(tabIDs, urls))))
        }
        return result
    }

    /// One dedicated Thread with its own run loop. Its mailbox contains value types only.
    final class ReadRunner {
        private let lock = NSLock()
        private var pending: (UInt64, pid_t)?
        private var result: (UInt64, Result<[WindowRow], ReadFailure>)?
        private var stopped = false
        private var busy = false
        private var abandonedTicket: UInt64?
        private var thread: Thread?
        private var nextTicket: UInt64 = 0
        init() {
            let worker = Thread { [weak self] in
                let port = NSMachPort()
                RunLoop.current.add(port, forMode: .default)
                while let me = self {
                    me.lock.lock()
                    let quit = me.stopped, job = me.pending
                    me.pending = nil
                    me.lock.unlock()
                    if quit { return }
                    if let (ticket, pid) = job {
                        let value: Result<[WindowRow], ReadFailure> = autoreleasepool {
                            do { return .success(try ChromeNative.readSnapshot(pid)) }
                            catch let error as ReadFailure { return .failure(error) }
                            catch { return .failure(ReadFailure(code: "native_read_unknown", osStatus: nil, point: .runner, reason: .runner_other)) }
                        }
                        me.lock.lock()
                        if me.abandonedTicket == ticket {
                            me.abandonedTicket = nil; me.busy = false
                        } else { me.result = (ticket, value) }
                        me.lock.unlock()
                    }
                    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
                }
            }
            worker.name = "MyChrome native read"
            thread = worker; worker.start()
        }
        func start(_ pid: pid_t) throws -> UInt64 {
            lock.lock(); defer { lock.unlock() }
            guard !stopped, !busy, pending == nil, result == nil else { throw Failure("native_reader_busy", "native_read") }
            nextTicket += 1; busy = true; pending = (nextTicket, pid); return nextTicket
        }
        func take(_ ticket: UInt64) -> Result<[WindowRow], ReadFailure>? {
            lock.lock(); defer { lock.unlock() }
            guard let value = result, value.0 == ticket else { return nil }
            result = nil; busy = false; return value.1
        }
        func abandon(_ ticket: UInt64) {
            lock.lock(); defer { lock.unlock() }
            guard busy, ticket == nextTicket else { return }
            if result?.0 == ticket { result = nil; busy = false }
            else { abandonedTicket = ticket }
        }
        func stop() { lock.lock(); stopped = true; lock.unlock() }
        deinit { stop() }
    }

    // This core is also compiled unchanged with pure closures by native-commit.test.mjs.
    final class Transaction {
        let operationId: String
        let checkpoint: (String) throws -> Void
        var stages: [[String: Any]] = []
        var geometry: [String: Any]?
        var geometryTarget: Target?
        var acceptedGeometry: (row: CGRect, cg: CGRect)?
        /// FOCUS2: an activation backend's facts (driver, fallback, child outcome, timings). Empty otherwise.
        var facts: [String: Any] = [:]
        private var unknown = false
        init(operationId: String, checkpoint: @escaping (String) throws -> Void) {
            self.operationId = operationId; self.checkpoint = checkpoint
        }
        var delivery: String {
            if unknown || stages.contains(where: { $0["delivery"] as? String == "unknown" }) { return "unknown" }
            return stages.contains(where: { $0["delivery"] as? String == "sent" }) ? "sent" : "not_sent"
        }
        func read<T>(_ stage: String, _ body: () throws -> T) throws -> T {
            try checkpoint(stage)
            let result = try body()
            try checkpoint(stage)
            return result
        }
        /// The closure must be ONE primitive OS call, prepared before this method.
        /// No permit, queued work or asynchronous write may escape this method.
        func write<T>(_ stage: String, acknowledged: Bool = true, _ enterOS: () throws -> T) throws -> T {
            guard !unknown else { throw Failure("native_delivery_unknown", stage) }
            try checkpoint(stage)
            let index = stages.count
            stages.append(["sequence": index + 1, "stage": stage, "entered": true,
                           "delivery": "unknown", "acknowledged": false])
            do {
                let result = try enterOS()
                stages[index]["delivery"] = "sent"
                stages[index]["acknowledged"] = acknowledged
                try checkpoint(stage)
                return result
            } catch {
                // A known successful entry remains sent on ordinary Stop; transport/API
                // failures and control-integrity loss are uncertainty, never replayable.
                if stages[index]["delivery"] as? String != "sent" { unknown = true }
                throw error
            }
        }
        func markUnresolved() {
            if stages.contains(where: { $0["entered"] as? Bool == true }) { unknown = true }
        }
        func result(_ value: [String: Any]) -> [String: Any] {
            var r = value
            if var geometry {
                let entered = stages.contains { ["activate_unminimize", "activate_fit", "window_bounds", "new_window_bounds"].contains($0["stage"] as? String ?? "") && $0["entered"] as? Bool == true }
                geometry["possiblyChanged"] = entered || geometry["changed"] as? Bool == true || geometry["possiblyChanged"] as? Bool == true
                r["geometry"] = geometry
                if let target = geometryTarget { for (key, value) in target.json where r[key] == nil { r[key] = value } }
            }
            for (key, value) in facts where r[key] == nil { r[key] = value }
            r["operationId"] = operationId; r["stages"] = stages; r["inputDelivery"] = delivery
            if delivery != "not_sent" && r["ok"] as? Bool == false { r["noRetry"] = true }
            return r
        }
    }
}

extension ChromeNative {
// MARK: - PERM1: Chrome's own popup directly above the bound target (contracts-batch4.md PERM1, rulings 1-5)
// After the activation and its verdict (Owner.clearChromePrompt), a Chrome layer-0 window directly above the target is
// classified read-only from CG + AX facts. A permission prompt bound to the target window gets ONE re-verified AXPress on
// its one-time ("Allow this time"), else plain ("Allow"/"允许") button, a bound translate bubble one on its own Close button,
// through the transaction ledger; never a key (never Return), never a second press in one activation. Everything else
// (JS dialog sheets, indicators, unknown or unbound popups) gets nothing. Only finite words and counts leave this enum.
enum Popup {
    /// One Chrome window's AX and CG facts, read transiently by Probe.popupShape. Labels never leave this enum.
    struct Shape {
        /// nil: no AX window of this Chrome has the window number (AX-invisible); "" when found but unreadable.
        var role: String? = nil
        var subrole: String? = nil
        var modal: Bool? = nil
        /// A member of a standard window's AXSheets (a JS dialog or "Leave site?" sheet): D's domain.
        var inSheet = false
        /// "translate" or "indicator": one of the existing exact bubble predicates matched this window.
        var known: String? = nil
        /// Every AXButton under the window in walk order: its label (title, else description), AXEnabled, the element.
        var labels: [String] = []
        var enabled: [Bool] = []
        var elements: [AXUIElement] = []
        /// AXTextField/AXTextArea descendants, and descendants whose role is outside `roles`.
        var fields = 0
        var foreign = 0
        /// Every role and child list read, within the walk bounds (depth 8, 64 nodes).
        var complete = true
        var rect: CGRect? = nil
        var ownerIsChrome = false
        var layer: Int? = nil
        var onScreen = false
        /// r1 A1: the window number its AXWindow or AXParent attribute names (another window than itself), if any: the
        /// only attachment evidence that lets the agent see a picture of it.
        var parentWindow: Int? = nil
    }
    /// The first Chrome layer-0 window (≥ 100 × 100) above the bound target in on-screen CG order, the target's rect, and
    /// whether it is the only one there (bound: of the target's own window group, never another window's).
    struct Above { let number: Int; let rect: CGRect; let target: CGRect; let bound: Bool; let targetNumber: Int }
    /// Exact button-label sets of Chrome's permission prompt, from the installed Chrome's own locale.pak (en, zh_CN;
    /// 156.0.8078.80 and 157.0.8103.38). Whole-label set equality: "Don't allow"/"不允许" match nothing. The zh_CN one-time
    /// label is unverified and absent (fails closed to unknown). The real prompt's AX shape is matched at the live check.
    static let permissionSets: [Set<String>] = [
        ["Allow", "Block"],
        ["Allow this time", "Allow on every visit", "Never allow"],
        ["Allow while visiting the site", "Allow this time", "Never allow"],
        ["允许", "禁止"],
    ]
    static let closeLabels: Set<String> = ["Close", "关闭"]
    /// The one button pressed: the one-time grant when offered, else the plain allow. Never "Allow on every visit".
    static let allowOrder = ["Allow this time", "Allow", "允许"]
    static let roles: Set<String> = ["AXGroup", "AXStaticText", "AXImage", "AXButton"]
    /// r1 A4: Chrome's own JS-dialog button sets (alert, confirm/prompt, "Leave site?"; en, zh_CN) [INF: live check]: with
    /// sheet membership or AXModal, the positive evidence that a pre-check dialog is the page's own (D's domain).
    static let jsDialogSets: [Set<String>] = [["OK"], ["OK", "Cancel"], ["Leave", "Cancel"], ["确定"], ["确定", "取消"], ["离开", "取消"]]

    /// kind: permission | translate | indicator | js_dialog | window | unknown. button: the index (into Shape.labels) of
    /// the one button to press, only for a positively identified, bound permission prompt or translate bubble.
    /// `target` nil (the read pre-check): no anchoring to a window; nothing is pressed there.
    static func classify(_ s: Shape, target: CGRect?, bound: Bool) -> (kind: String, button: Int?) {
        if s.inSheet || s.modal == true { return ("js_dialog", nil) }
        if s.subrole == "AXStandardWindow" { return ("window", nil) }
        if s.role == nil, let r = s.rect, let t = target, r.width * r.height >= t.width * t.height / 2 { return ("window", nil) }
        if s.known == "indicator" { return ("indicator", nil) }
        guard bound, s.ownerIsChrome, s.layer == 0, s.onScreen, s.labels.count == s.enabled.count else { return ("unknown", nil) }
        if s.known == "translate" {
            let close = s.labels.indices.filter { closeLabels.contains(s.labels[$0]) }
            return ("translate", close.count == 1 && s.enabled[close[0]] ? close[0] : nil)
        }
        let main = s.labels.filter { !closeLabels.contains($0) }
        guard s.role == "AXWindow", s.complete, s.fields == 0, s.foreign == 0, s.labels.count - main.count <= 1,
              Set(main).count == main.count, permissionSets.contains(Set(main)),
              let r = s.rect, r.width >= 100, r.width <= 600, r.height >= 100, r.height <= 400 else { return ("unknown", nil) }
        if let t = target {
            guard r.minX >= t.minX - 8, r.maxX <= t.maxX + 8, r.minY >= t.minY, r.minY <= t.minY + 200 else { return ("unknown", nil) }
        }
        for label in allowOrder {
            if let i = s.labels.firstIndex(of: label) { return ("permission", s.enabled[i] ? i : nil) }
        }
        return ("permission", nil)
    }
    /// What resolve reads and writes; Owner.clearChromePrompt wires them to its probes, stop checks and the settle.
    struct Effects {
        let now: () -> Double
        /// Read-only, bounded by the classification deadline; a cut throws (DialogFailure native_read_deadline).
        let above: () throws -> Above?
        let shape: (Int) throws -> Shape
        /// Read-only, immediately before the write: the button enabled and offering AXPress.
        let pressable: (AXUIElement) throws -> Bool
        /// Prepared before the write (stop check, messaging timeout); false = no press.
        let prepare: (AXUIElement) throws -> Bool
        /// The one primitive write.
        let press: (AXUIElement) -> AXError
        /// Read-only focus samples after the press (≤ 0.7 s).
        let settle: () throws -> (Bool, Bool, Int, [String: Any])
        /// r1 A3: a healthy physical hold now (takeover, held, tap healthy); false = observe only, never press.
        let held: () -> Bool
    }
    /// The decision. Only when the completed sample says a Chrome layer-0 window is above the target with Chrome in front.
    /// Facts: popupKind, popupAction (none | allow | dismiss | observe: recognised, but no healthy physical hold, so not
    /// pressed), popupDelivery (not_sent | sent | unknown), popupResult (cleared | remains | changed | unknown), popupMs,
    /// popupWindow (the CG number, for the agent's private look: only when the popup's AXWindow/AXParent names the bound
    /// target window, r1 A1).
    static func resolve(_ fx: Effects, state: (Bool, Bool, Int, [String: Any]), chromePid: Int, tx: Transaction) throws
        -> ((Bool, Bool, Int, [String: Any]), [String: Any]) {
        guard !state.0, state.2 == chromePid, let blocker = state.3["focusBlocker"] as? [String: Any],
              blocker["pid"] as? Int == chromePid, blocker["layer"] as? Int == 0 else { return (state, [:]) }
        let t0 = fx.now()
        var facts: [String: Any] = ["popupKind": "unknown", "popupAction": "none", "popupDelivery": "not_sent", "popupResult": "remains"]
        func finish(_ s: (Bool, Bool, Int, [String: Any])) -> ((Bool, Bool, Int, [String: Any]), [String: Any]) {
            facts["popupMs"] = max(0, Int(((fx.now() - t0) * 1000).rounded()))
            return (s, facts)
        }
        // A read cut by the classification deadline proves nothing: no write. A Stop surfaces as itself.
        func cut(_ e: Error) -> Bool {
            guard let f = e as? DialogFailure else { return false }
            return f.code == "dialog_probe_unknown" && f.stage == "native_read_deadline"
        }
        let above: Above, shape: Shape, kind: String, button: Int?
        do {
            guard let found = try fx.above() else { return (state, [:]) }
            let read = try fx.shape(found.number), decided = classify(read, target: found.target, bound: found.bound)
            (above, shape, kind, button) = (found, read, decided.kind, decided.button)
        } catch let e where cut(e) { facts["popupResult"] = "unknown"; return finish(state) }
        if kind == "window" { return (state, [:]) }   // another browser window: FOCUS4's destination checks decide
        facts["popupKind"] = kind
        if shape.parentWindow == above.targetNumber { facts["popupWindow"] = above.number }
        guard kind == "permission" || kind == "translate", let index = button else { return finish(state) }
        // Immediately before the one write: the same window still directly above the target, the same classification
        // and labels, the same button element, still enabled and offering AXPress. Any difference: no press.
        let element: AXUIElement
        do {
            guard let again = try fx.above(), again.number == above.number else { facts["popupResult"] = "changed"; return finish(state) }
            let fresh = try fx.shape(again.number), check = classify(fresh, target: again.target, bound: again.bound)
            guard check.kind == kind, check.button == index, fresh.labels == shape.labels, fresh.elements.indices.contains(index),
                  shape.elements.indices.contains(index), CFEqual(fresh.elements[index], shape.elements[index]),
                  try fx.pressable(fresh.elements[index]), try fx.prepare(fresh.elements[index]) else {
                facts["popupResult"] = "changed"; return finish(state)
            }
            element = fresh.elements[index]
        } catch let e where cut(e) { facts["popupResult"] = "unknown"; return finish(state) }
        // r1 A3: the press needs a healthy physical hold, checked here, at the write boundary (monitored mode or a lost
        // hold: observe only; the tool then refuses keys with the facts).
        guard fx.held() else { facts["popupAction"] = "observe"; return finish(state) }
        let stage = kind == "permission" ? "popup_allow" : "popup_dismiss"
        facts["popupAction"] = kind == "permission" ? "allow" : "dismiss"
        // On every reply from here on (a failed press, a Stop): Transaction.result carries tx.facts. The delivery word
        // moves with the ledger: unknown once the write is entered, sent once the press returned success.
        for (key, value) in facts where key != "popupWindow" { tx.facts[key] = value }
        try tx.write(stage) {
            tx.facts["popupDelivery"] = "unknown"
            let status = fx.press(element)
            guard status == .success else { throw Failure("popup_press_unknown", stage, osStatus: Int(status.rawValue)) }
            tx.facts["popupDelivery"] = "sent"
        }
        facts["popupDelivery"] = "sent"
        let after = try fx.settle()
        facts["popupResult"] = after.0 ? "cleared" : "remains"
        tx.facts["popupResult"] = facts["popupResult"]
        return finish(after)
    }
}
}

extension ChromeNative {
    final class Owner {
        let dry: Bool
        let generation = UUID().uuidString
        var target: Target?
        var scene: [String: Any]?
        var sceneToken: String?
        var creationAttempted = false
        private var creationPin: (window: Int, cg: Int, cgs: Set<Int>, windows: Set<Int>)?
        var stopped = false
        var active: Transaction?
        var lastTransaction: Transaction?
        private var operations = Set<String>()
        /// Set before a native write is attempted; binding rescans stop until the next MCP call.
        private(set) var mutationRequested = false
        /// The MCP call (index.js CALL context) whose ordinary requests this Owner is serving.
        private(set) var callId: String?
        /// The first ordinary request of a new call starts its write-sent boundary afresh. The same call never
        /// resets it; operation dedup, the ledger, target, scene and revocation state are untouched.
        func enterCall(_ id: String) {
            guard !id.isEmpty, id.utf8.count <= 128, id != callId else { return }
            callId = id; mutationRequested = false
        }
        private var dialogs: [String: PageDialog] = [:]
        private var dialogTargets: [String: Target] = [:]
        private var dryDialogInstances: [String: String] = [:]
        private var readRunner: ReadRunner?
        private var dryRows: [WindowRow] = []
        private var dryCG: [Int: Int] = [:]
        private var dryConfig: [String: Any] = [:]
        var seedBounds = CGRect(x: 0, y: 0, width: 800, height: 600)
        var seedCG = 1
        var stageCheck: (String) throws -> Void = { _ in }
        var pump: () throws -> Void = {}
        /// PERM1 r1 A3: a healthy physical hold now; the helper Session wires it. Unwired (chromectl): false, never pressed.
        var held: () -> Bool = { false }
        init(dry: Bool) { self.dry = dry }
        deinit { readRunner?.stop() }
        func invalidate() { stopped = true; dialogs.removeAll(); dialogTargets.removeAll(); dryDialogInstances.removeAll() }
        func configureDry(_ value: [String: Any]) throws {
            guard dry else { return }
            if let initial = value["seedBounds"] {
                guard !stopped, target == nil, scene == nil, dryRows.isEmpty, dryCG.isEmpty,
                      !creationAttempted, active == nil, operations.isEmpty, dryConfig["seedBounds"] == nil else { throw Failure("native_request_invalid", "native_prepare") }
                seedBounds = try bounds(["bounds": initial])
            }
            dryConfig.merge(value) { _, new in new }
            if let url = value["currentURL"] as? String {
                dryRows = dryRows.map { row in WindowRow(id: row.id, tabs: row.tabs, activeTab: row.activeTab, index: row.index,
                    bounds: row.bounds, minimized: row.minimized, title: row.title, tabURLs: Dictionary(uniqueKeysWithValues: row.tabs.map { ($0, url) })) }
            }
        }
        func token(_ label: String) -> String {
            SHA256.hash(data: Data((generation + ":" + label + ":" + UUID().uuidString).utf8)).map { String(format: "%02x", $0) }.joined()
        }
        func requireAlive(_ stage: String) throws {
            precondition(Thread.isMainThread)
            if stopped { throw Failure("native_session_revoked", stage) }
            try stageCheck(stage)
        }
        func snapshot(_ pid: pid_t, until: Double? = nil) throws -> [WindowRow] {
            try requireAlive("native_read")
            if dry {
                let delay = max(0, min(2000, (dryConfig["readDelayMs"] as? NSNumber)?.doubleValue ?? 0)) / 1000
                let until = ProcessInfo.processInfo.systemUptime + delay
                while ProcessInfo.processInfo.systemUptime < until { try pump(); try requireAlive("native_read") }
                return dryRows
            }
            if readRunner == nil { readRunner = ReadRunner() }
            let runner = readRunner!, ticket = try runner.start(pid)
            var consumed = false
            defer { if !consumed { runner.abandon(ticket) } }
            let deadline = min(ProcessInfo.processInfo.systemUptime + 3.5, until ?? .infinity)
            while true {
                try requireAlive("native_read")
                if let value = runner.take(ticket) {
                    consumed = true
                    switch value {
                    case .success(let rows): try requireAlive("native_read"); return rows
                    case .failure(let error): throw Failure(error.code, "native_read", osStatus: error.osStatus, details: error.details)
                    }
                }
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw Failure("native_read_timeout", "native_read") }
                try pump()
            }
        }
        func probe() -> Probe {
            Probe(budget: 4, checkpoint: { [unowned self] in try self.requireAlive("native_ax_read") },
                  snapshot: { [unowned self] pid in try self.snapshot(pid) })
        }
        /// A binding rescan's probe: the rest of the shared absolute deadline, never more than the usual 4 s.
        func probe(until deadline: Double) -> Probe {
            Probe(budget: min(4, max(0, deadline - ProcessInfo.processInfo.systemUptime)),
                  checkpoint: { [unowned self] in try self.requireAlive("native_ax_read") },
                  snapshot: { [unowned self] pid in try self.snapshot(pid, until: deadline) })
        }
        func seed(_ t: Target) {
            guard dry else { return }
            if !dryRows.contains(where: { $0.id == t.windowId }) {
                dryRows.append(WindowRow(id: t.windowId, tabs: [t.tabId], activeTab: t.tabId,
                                         index: dryRows.count + 1, bounds: seedBounds, minimized: false, title: "fixture",
                                         tabURLs: (dryConfig["currentURL"] as? String).map { [t.tabId: $0] } ?? [:]))
            } else if let i = dryRows.firstIndex(where: { $0.id == t.windowId }), !dryRows[i].tabs.contains(t.tabId) {
                let row = dryRows[i]
                dryRows[i] = WindowRow(id: row.id, tabs: row.tabs + [t.tabId], activeTab: row.activeTab,
                                      index: row.index, bounds: row.bounds, minimized: row.minimized, title: row.title)
            }
            dryCG[t.windowId] = t.cgWindow
        }
        func identity(_ pid: pid_t) throws {
            if dry { return }
            try requireAlive("native_identity")
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
                  app.bundleIdentifier == "com.google.Chrome" else { throw Failure("native_target_invalid", "native_identity") }
            try requireAlive("native_identity")
        }
        func cgMapping(_ pid: pid_t, rows: [WindowRow], access: Probe,
                       observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                       retaining: (window: Int, cg: Int, cgs: Set<Int>, windows: Set<Int>)? = nil,
                       captureUnique: (([Int: Int], Set<Int>) -> Void)? = nil,
                       captureRows: (([WindowRow]) -> Void)? = nil) throws -> [Int: Int] {
            if dry {
                if let captureRows { try access.check(); captureRows(rows) }
                return dryCG
            }
            var structureWasChanged = false
            func structureChanged(_ window: Int?, _ field: Int) -> Failure {
                if let observe { structureWasChanged = true; observe(7, window, nil, nil, [1, field], [], [], []) }
                return Failure("native_target_changed", "native_window_binding", details: ["bindingReason": "snapshot_structure_changed"])
            }
            func keyedRows(_ values: [WindowRow]) throws -> [Int: WindowRow] {
                var keyed: [Int: WindowRow] = [:]
                for row in values {
                    guard keyed[row.id] == nil else { throw structureChanged(row.id, 0) }
                    keyed[row.id] = row
                }
                return keyed
            }
            func urlBytes(_ value: String) -> Data? {
                guard !value.isEmpty, value.utf8.count <= 32768,
                      !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
                      URL(string: value)?.scheme != nil else { return nil }
                // Foundation URL and Swift String equality may normalize content; neither
                // representation is used for identity or for the exact comparison below.
                return Data(value.utf8)
            }
            func urlCounts(_ values: [WindowRow]) -> [Data: Int]? {
                var counts: [Data: Int] = [:]
                for row in values {
                    guard Set(row.tabs).count == row.tabs.count, Set(row.tabURLs.keys) == Set(row.tabs) else { return nil }
                    for tab in row.tabs {
                        guard let value = row.tabURLs[tab] else { return nil }
                        counts[Data(value.utf8), default: 0] += 1
                    }
                }
                return counts
            }
            guard let list = access.CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
                try access.check()
                if let observe { observe(7, nil, nil, nil, [2], [], [], []) }
                throw Failure("native_target_unknown", "native_window_binding")
            }
            let cg = list.compactMap { row -> (num: Int, rect: CGRect, onScreen: Bool)? in
                guard (row[kCGWindowOwnerPID as String] as? Int) == Int(pid),
                      (row[kCGWindowLayer as String] as? Int) == 0,
                      let number = row[kCGWindowNumber as String] as? Int,
                      let b = row[kCGWindowBounds as String] as? NSDictionary,
                      let r = CGRect(dictionaryRepresentation: b) else { return nil }
                let onScreen = row[kCGWindowIsOnscreen as String] as? Bool ?? false
                if let observe { observe(1, nil, number, r, [], [onScreen], [], []) }
                return (number, r, onScreen)
            }
            let before = try keyedRows(rows)
            var currentTitles = before.mapValues { $0.title }
            var validatedRows = rows
            var documents: [Int: Data] = [:], stableURLs: [Int: Data] = [:]
            let ambiguousNumbers = Set(rows.flatMap { row -> [Int] in
                let hits = cg.filter { ChromeNative.sameRect($0.rect, row.bounds) }
                return hits.count > 1 ? hits.map { $0.num } : []
            })
            let canReadDocuments = !ambiguousNumbers.isEmpty && ambiguousNumbers.count <= 16
            let cw = rows.map {
                if let observe { observe(0, $0.id, nil, $0.bounds, [$0.index], [$0.minimized], [], []) }
                return ChromeWin(id: $0.id, rect: $0.bounds, minimized: $0.minimized, index: $0.index)
            }
            let mapped = ChromeNative.matchWindows(cw, cg: cg, onOrder: { cg.filter { $0.onScreen }.map { ($0.num, $0.rect) } }, ax: {
                if let observe { observe(2, nil, nil, nil, [], [], [], []) }
                let elements = access.axWindows(pid: pid)
                if let observe { observe(3, nil, nil, nil, [elements.count], [], [], []) }
                var numberCounts: [Int: Int] = [:], attemptedDocuments = Set<Int>()
                let axRows: [(num: Int, title: String, minimized: Bool, rect: CGRect?)] = elements.compactMap { element in
                    guard let number = access.axWindowNumber(element) else { return nil }
                    numberCounts[number, default: 0] += 1
                    var title: CFTypeRef?, minimized: CFTypeRef?
                    guard access.AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title) == .success,
                          access.AXUIElementCopyAttributeValue(element, kAXMinimizedAttribute as CFString, &minimized) == .success,
                          let value = title as? String, let mini = minimized as? Bool else { return nil }
                    let rect = access.axRect(element)
                    if let observe { observe(4, nil, number, rect, [], [mini], [], []) }
                    if canReadDocuments, ambiguousNumbers.contains(number), attemptedDocuments.insert(number).inserted {
                        var document: CFTypeRef?
                        if access.AXUIElementCopyAttributeValue(element, kAXDocumentAttribute as CFString, &document) == .success,
                           let document, CFGetTypeID(document) == CFStringGetTypeID(),
                           let value = document as? String, let bytes = urlBytes(value) {
                            documents[number] = bytes
                        }
                    }
                    return (number, value, mini, rect)
                }
                documents = documents.filter { numberCounts[$0.key] == 1 }
                do {
                    try access.check()
                    let fresh = try access.snapshot(pid)
                    try access.check()
                    let after = try keyedRows(fresh)
                    guard after.count == before.count else { throw structureChanged(nil, 1) }
                    for (id, row) in before {
                        guard let next = after[id], next.tabs == row.tabs, next.activeTab == row.activeTab,
                              next.bounds == row.bounds, next.minimized == row.minimized, next.index == row.index else {
                            // Classify only this failed guard using its existing value rows.
                            // Keep the guard and Dictionary traversal order unchanged.
                            var field = 2
                            if let next = after[id] {
                                field = next.tabs != row.tabs ? 3 : next.activeTab != row.activeTab ? 4 :
                                    next.bounds != row.bounds ? 5 : next.minimized != row.minimized ? 6 : 7
                            }
                            throw structureChanged(id, field)
                        }
                    }
                    if let observe { observe(7, nil, nil, nil, [0], [], [], []) }
                    // Every post-AX title comes from this one value snapshot, matched by identity.
                    currentTitles = after.mapValues { $0.title }
                    validatedRows = fresh
                    if let beforeCounts = urlCounts(rows), let afterCounts = urlCounts(fresh) {
                        for (id, row) in before {
                            let active = row.activeTab
                            guard row.tabs.contains(active),
                                  let old = row.tabURLs[active], let next = after[id]?.tabURLs[active],
                                  let oldBytes = urlBytes(old), let nextBytes = urlBytes(next),
                                  oldBytes == nextBytes, beforeCounts[oldBytes] == 1, afterCounts[oldBytes] == 1 else { continue }
                            stableURLs[id] = oldBytes
                        }
                    }
                } catch {
                    if !structureWasChanged, let observe { observe(7, nil, nil, nil, [2], [], [], []) }
                    access.firstFailure = access.firstFailure ?? error
                    currentTitles.removeAll()
                    documents.removeAll(); stableURLs.removeAll()
                }
                return axRows
            }, title: { currentTitles[rows[$0].id] ?? "" }, observe: observe, retaining: retaining, captureUnique: captureUnique,
               documentEvidence: { documents.isEmpty ? nil : (documents, stableURLs) })
            try access.check()
            captureRows?(validatedRows)
            return mapped
        }
        @discardableResult
        func verify(_ t: Target, requireActive: Bool = false,
                    observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                    until: Double? = nil) throws -> WindowRow {
            try identity(t.chromePid)
            let rows = try snapshot(t.chromePid, until: until)
            guard let row = rows.first(where: { $0.id == t.windowId }) else {
                if let observe { observe(8, t.windowId, nil, nil, [1], [], [], []) }
                throw Failure("native_target_changed", "native_binding", details: ["bindingReason": "window_missing"])
            }
            guard row.tabs.contains(t.tabId) else {
                if let observe { observe(8, t.windowId, nil, nil, [2], [], [], []) }
                throw Failure("native_target_changed", "native_binding", details: ["bindingReason": "tab_not_in_window"])
            }
            guard !requireActive || row.activeTab == t.tabId else {
                if let observe { observe(8, t.windowId, nil, nil, [3], [], [], []) }
                throw Failure("native_target_changed", "native_binding", details: ["bindingReason": "active_tab_mismatch"])
            }
            let pin = creationPin.flatMap { $0.window == t.windowId && $0.cg == t.cgWindow ? $0 : nil }
            let p = until.map { probe(until: $0) } ?? probe(), mapping = try cgMapping(t.chromePid, rows: rows, access: p, observe: observe, retaining: pin)
            guard let cg = mapping[t.windowId] else {
                if let observe { observe(8, t.windowId, nil, nil, [4], [], [], []) }
                throw Failure("native_target_changed", "native_binding", details: ["bindingReason": "cg_mapping_missing"])
            }
            guard cg == t.cgWindow else {
                if let observe { observe(8, t.windowId, cg, nil, [5], [], [], []) }
                throw Failure("native_target_changed", "native_binding", details: ["bindingReason": "cg_mapping_mismatch"])
            }
            try requireAlive("native_binding")
            if let observe { observe(8, t.windowId, cg, nil, [0], [], [], []) }
            return row
        }
        func bind(_ value: [String: Any]) throws -> [String: Any] {
            let next = try Target(value)
            if let previous = target, !previous.sameWindow(next) { throw Failure("native_target_rebind", "native_binding") }
            seed(next)
            try rescanVerify(next)
            target = next
            return ["ok": true, "target": next.json]
        }
        /// Binding before this session's first native write only: a window list that changed between the two
        /// snapshot reads is read again. The rescans share one absolute 4 s budget (reads, probe and pauses);
        /// a confirmation after it is not accepted. Every other refusal is final, as in verify.
        /// CRASH1: a ScriptingBridge exception caught in a snapshot read counts like a transient AX status here.
        func rescanVerify(_ t: Target) throws {
            let eligible = !mutationRequested
            let deadline = ProcessInfo.processInfo.systemUptime + 4
            var rescans = 0, structural: Failure?
            while true {
                do { try verify(t, until: rescans > 0 ? deadline : nil) }
                catch let failure as Failure where eligible && ((failure.code == "native_target_changed" &&
                    failure.stage == "native_window_binding" && failure.details["bindingReason"] as? String == "snapshot_structure_changed") ||
                    (failure.code == "native_read_unknown" && failure.stage == "native_read" &&
                     failure.details["nativeReadReason"] as? String == "objc_exception")) {
                    guard rescans < 2, ProcessInfo.processInfo.systemUptime < deadline else {
                        var last = failure; last.details["bindingRescans"] = rescans; throw last
                    }
                    structural = failure
                    rescans += 1
                    try rescanPause(until: deadline)
                    continue
                }
                if let late = structural, ProcessInfo.processInfo.systemUptime >= deadline {
                    var last = late; last.details["bindingRescans"] = rescans; last.details["bindingDeadline"] = true; throw last
                }
                return
            }
        }
        /// NAT-RETRY2: the read-only verification right after this transaction's sent write. It is NOT the
        /// pre-input binding rescan above (that one stays off once a write was sent in this call): `read` runs
        /// only snapshot and CG/AX reads, so no write and never the transaction is re-run, and the delivery stays
        /// the ledger's (`sent`, noRetry). Only `snapshot_structure_changed` is read again, at most twice inside
        /// one absolute 4 s budget; a persistent or late one and every other refusal fail as before.
        /// CRASH1: so is a ScriptingBridge exception caught in one of those snapshot reads (read-only, nothing re-sent).
        @discardableResult
        func verifyAfterWrite(_ tx: Transaction, _ read: (Double?) throws -> WindowRow) throws -> WindowRow {
            guard tx.delivery == "sent" else { return try read(nil) }
            let deadline = ProcessInfo.processInfo.systemUptime + 4
            var rereads = 0, structural: Failure?
            while true {
                do {
                    let row = try read(rereads > 0 ? deadline : nil)
                    if let late = structural, ProcessInfo.processInfo.systemUptime >= deadline {
                        var last = late; last.details["verifyRereads"] = rereads; last.details["verifyDeadline"] = true; throw last
                    }
                    return row
                } catch let failure as Failure where (failure.code == "native_target_changed" &&
                    failure.stage == "native_window_binding" && failure.details["bindingReason"] as? String == "snapshot_structure_changed") ||
                    (failure.code == "native_read_unknown" && failure.stage == "native_read" &&
                     failure.details["nativeReadReason"] as? String == "objc_exception") {
                    guard rereads < 2, ProcessInfo.processInfo.systemUptime < deadline else {
                        var last = failure; last.details["verifyRereads"] = rereads; throw last
                    }
                    structural = failure
                    rereads += 1
                    try rescanPause(until: deadline)
                }
            }
        }
        func rescanPause(until deadline: Double) throws {
            let until = min(ProcessInfo.processInfo.systemUptime + 0.05, deadline)
            while ProcessInfo.processInfo.systemUptime < until { try pump(); try requireAlive("native_binding") }
        }
        func recordScene(_ value: [String: Any]) throws -> [String: Any] {
            if let stored = scene {
                // Registration is idempotent only for the same original scene.
                let keys = ["appPid", "chromePid", "chromeWindow", "chromeTab", "windowId", "tabId", "cgWindow"]
                guard keys.allSatisfy({ String(describing: stored[$0] ?? NSNull()) == String(describing: value[$0] ?? NSNull()) }) else {
                    throw Failure("native_scene_already_recorded", "native_scene")
                }
                return ["ok": true, "restoreToken": sceneToken!]
            }
            let allowed = ["appPid", "chromePid", "chromeWindow", "chromeTab", "windowId", "tabId", "cgWindow"]
            var captured: [String: Any] = [:]
            for key in allowed {
                if let v = value[key], !(v is NSNull) {
                    guard let n = ChromeNative.dialogInt(v) else { throw Failure("native_scene_invalid", "native_scene") }
                    captured[key] = n
                }
            }
            if let pid = ChromeNative.dialogInt(captured["chromePid"]) {
                guard pid <= Int(Int32.max) else { throw Failure("native_scene_invalid", "native_scene") }
                try identity(pid_t(pid))
                if let win = ChromeNative.dialogInt(captured["chromeWindow"] ?? captured["windowId"]),
                   let tab = ChromeNative.dialogInt(captured["chromeTab"] ?? captured["tabId"]) {
                    if dry { seed(try Target(["chromePid": pid, "windowId": win, "tabId": tab,
                                              "cgWindow": captured["cgWindow"] ?? seedCG])) }
                    let rows = try snapshot(pid_t(pid))
                    guard let row = rows.first(where: { $0.id == win }), row.tabs.contains(tab) else { throw Failure("native_scene_invalid", "native_scene") }
                    let p = probe(), map = try cgMapping(pid_t(pid), rows: rows, access: p)
                    guard let cg = map[win] else { throw Failure("native_scene_invalid", "native_scene") }
                    captured["capturedCG"] = cg
                }
            }
            try requireAlive("native_scene")
            scene = captured; sceneToken = token("scene")
            return ["ok": true, "restoreToken": sceneToken!]
        }
        func inspect(_ value: [String: Any], existing: String? = nil) throws -> [String: Any] {
            let t = try Target(value)
            seed(t)
            let d: PageDialog?
            if dry { return try inspectDry(t, existing: existing) }
            try identity(t.chromePid)
            let p = probe()
            d = try p.inspect(pid: t.chromePid, target: t.json)
            guard let current = d else {
                if existing != nil { throw Failure("dialog_identity_mismatch", "dialog_recheck") }
                return ["ok": true, "known": true, "open": false, "inputDelivery": "not_sent"]
            }
            guard let currentIdentity = current.identity else { throw Failure("dialog_probe_unknown", "dialog_binding") }
            let key: String
            if let old = existing {
                guard let original = dialogs[old], dialogTargets[old] == t, sameDialog(original, current) else {
                    throw Failure("dialog_identity_mismatch", "dialog_recheck")
                }
                key = old
            } else {
                guard dialogs.count < 8 else { throw Failure("dialog_registry_full", "dialog_inspect") }
                key = token("dialog"); dialogs[key] = current; dialogTargets[key] = t
            }
            var wire = currentIdentity.json
            wire["token"] = key; wire["dialogToken"] = key
            return ["ok": true, "known": true, "open": true, "title": current.title, "texts": current.texts,
                    "buttons": current.buttons.map { $0.0 }, "hasField": current.hasField,
                    "identity": wire, "complete": current.templateComplete, "origin": current.origin as Any? ?? NSNull(),
                    "originEvidence": current.origin == nil ? "unverified" : "native_current_snapshot", "inputDelivery": "not_sent"]
        }
        func sameDialog(_ original: PageDialog, _ current: PageDialog) -> Bool {
            guard CFEqual(original.window, current.window), original.identity == current.identity,
                  original.fields.count == current.fields.count, original.buttons.count == current.buttons.count else { return false }
            return zip(original.fields, current.fields).allSatisfy { CFEqual($0, $1) } &&
                   zip(original.buttons, current.buttons).allSatisfy { $0.0 == $1.0 && CFEqual($0.1, $1.1) }
        }
        func inspectDry(_ t: Target, existing: String?) throws -> [String: Any] {
            let rows = try snapshot(t.chromePid)
            let origin = rows.first(where: { $0.id == t.windowId && $0.activeTab == t.tabId })?.tabURLs[t.tabId].flatMap(ChromeNative.promptOrigin)
            guard let config = dryConfig["dialog"] as? [String: Any], config["open"] as? Bool != false else {
                if existing != nil { throw Failure("dialog_identity_mismatch", "dialog_recheck") }
                return ["ok": true, "known": true, "open": false, "inputDelivery": "not_sent"]
            }
            let instance = config["instance"] as? String ?? "A"
            let key: String
            if let old = existing {
                guard dryDialogInstances[old] == instance, dialogTargets[old] == t else { throw Failure("dialog_identity_mismatch", "dialog_recheck") }
                key = old
            } else { key = token("dialog"); dryDialogInstances[key] = instance; dialogTargets[key] = t }
            var wire = t.json
            wire["version"] = 1; wire["dialogCgWindow"] = config["dialogCgWindow"] ?? 21
            wire["token"] = key; wire["dialogToken"] = key
            return ["ok": true, "known": true, "open": true, "title": config["title"] ?? "fixture", "texts": config["texts"] ?? [],
                    "buttons": config["buttons"] ?? ["OK", "Cancel"], "hasField": (config["fields"] as? Int ?? 0) > 0,
                    "identity": wire, "complete": config["complete"] as? Bool ?? true, "origin": origin as Any? ?? NSNull(),
                    "originEvidence": origin == nil ? "unverified" : "native_current_snapshot", "inputDelivery": "not_sent"]
        }
        func run(_ request: [String: Any]) throws -> [String: Any] {
            lastTransaction = nil
            guard let operation = request["operationId"] as? String, !operation.isEmpty, operation.count <= 160,
                  !operations.contains(operation), active == nil, operations.count < 4096,
                  let intent = request["intent"] as? [String: Any], let kind = intent["kind"] as? String,
                  ["dialogAnswer", "closeTab", "openTab", "newWindow", "selectTab", "moveWindow", "activate", "restoreScene"].contains(kind) else {
                throw Failure("native_request_invalid", "native_dispatch")
            }
            _ = try ChromeNative.geometryIntent(intent)
            operations.insert(operation)
            mutationRequested = true
            let transaction = Transaction(operationId: operation, checkpoint: { [unowned self] stage in
                try self.requireAlive(stage)
            })
            active = transaction; lastTransaction = transaction
            defer { active = nil }
            do {
                let result = dry ? try executeDry(intent, request: request, tx: transaction) : try execute(intent, request: request, tx: transaction)
                return transaction.result(result)
            } catch var error as Failure {
                if ["newWindow", "openTab"].contains(kind), !transaction.stages.isEmpty {
                    transaction.markUnresolved(); error.details["partial"] = true; error.details["creationAttempted"] = true
                }
                return transaction.result(error.json)
            } catch let error as DialogFailure {
                return transaction.result(error.json)
            } catch {
                // Preserve Session's typed Stop error; Session decorates it with this ledger.
                if ["newWindow", "openTab"].contains(kind), !transaction.stages.isEmpty { transaction.markUnresolved() }
                throw error
            }
        }
        func bound(_ intent: [String: Any]) throws -> Target {
            guard let t = target else { throw Failure("native_target_unbound", "native_binding") }
            if let window = intent["windowId"], !(window is NSNull), ChromeNative.dialogInt(window) != t.windowId {
                throw Failure("native_target_changed", "native_binding")
            }
            if let tab = intent["tabId"], !(tab is NSNull), ChromeNative.dialogInt(tab) != t.tabId {
                throw Failure("native_target_changed", "native_binding")
            }
            return t
        }
        func creationPID(_ intent: [String: Any]) throws -> pid_t {
            let explicit = ChromeNative.dialogInt(intent["chromePid"]), recorded = ChromeNative.dialogInt(scene?["chromePid"])
            if let a = explicit, let b = recorded, a != b { throw Failure("native_target_changed", "new_window_identity") }
            guard let pid = explicit ?? recorded, pid <= Int(Int32.max), target == nil, !creationAttempted else {
                throw Failure("native_creation_unbound", "new_window_identity")
            }
            try identity(pid_t(pid)); return pid_t(pid)
        }
        func bounds(_ intent: [String: Any]) throws -> CGRect {
            guard let b = intent["bounds"] as? [String: Any],
                  Set(b.keys) == Set(["left", "top", "width", "height"]),
                  b.values.allSatisfy({ value in (value as? NSNumber).map { CFGetTypeID($0) != CFBooleanGetTypeID() } == true }),
                  let x = (b["left"] as? NSNumber)?.doubleValue, let y = (b["top"] as? NSNumber)?.doubleValue,
                  let w = (b["width"] as? NSNumber)?.doubleValue, let h = (b["height"] as? NSNumber)?.doubleValue,
                  [x, y, w, h].allSatisfy({ $0.isFinite }), w > 0, h > 0,
                  [x, y, x + w, y + h].allSatisfy({ $0 >= -32768 && $0 <= 32767 }) else {
                throw Failure("native_bounds_invalid", "native_prepare")
            }
            let rounded = CGRect(x: x.rounded(), y: y.rounded(), width: w.rounded(), height: h.rounded())
            guard rounded.size.width > 0, rounded.size.height > 0,
                  [rounded.minX, rounded.minY, rounded.maxX, rounded.maxY].allSatisfy({ Int16(exactly: $0) != nil }) else {
                throw Failure("native_bounds_invalid", "native_prepare")
            }
            return rounded
        }
        func readWindowDisplays() throws -> WindowDisplaySet {
            try requireAlive("native_display_read")
            let records: [WindowDisplayRecord], screens: [WindowScreenRecord]
            if dry {
                // Dry values are synthetic; the production sampler is never called.
                let values = dryConfig["displays"] as? [[String: Any]] ?? [
                    ["id": 1, "left": 0, "top": 0, "width": 1920, "height": 1080, "main": true]]
                var ds: [WindowDisplayRecord] = [], ss: [WindowScreenRecord] = []
                for value in values {
                    guard let id = ChromeNative.dialogInt(value["id"]),
                          let x = (value["left"] as? NSNumber)?.doubleValue, let y = (value["top"] as? NSNumber)?.doubleValue,
                          let w = (value["width"] as? NSNumber)?.doubleValue, let h = (value["height"] as? NSNumber)?.doubleValue else {
                        throw Failure("native_display_unavailable", "native_display_read")
                    }
                    let full = CGRect(x: x, y: y, width: w, height: h)
                    let top = (value["insetTop"] as? NSNumber)?.doubleValue ?? 0, bottom = (value["insetBottom"] as? NSNumber)?.doubleValue ?? 0
                    let left = (value["insetLeft"] as? NSNumber)?.doubleValue ?? 0, right = (value["insetRight"] as? NSNumber)?.doubleValue ?? 0
                    ds.append(WindowDisplayRecord(id: id, full: full, awake: value["asleep"] as? Bool != true,
                        mirrored: value["mirrored"] as? Bool == true, main: value["main"] as? Bool == true))
                    ss.append(WindowScreenRecord(id: id, frame: full,
                        visible: CGRect(x: x + left, y: y + bottom, width: w - left - right, height: h - top - bottom), safeTop: 0))
                }
                records = ds; screens = ss
            } else { (records, screens) = try ChromeNative.sampleWindowDisplays() }
            let result = try ChromeNative.windowDisplays(records, screens)
            try requireAlive("native_display_read")
            return result
        }
        func readWindowGeometry(_ t: Target, row: WindowRow) throws -> CGRect {
            try requireAlive("native_geometry_verify")
            if dry {
                guard row.id == t.windowId, dryCG[t.windowId] == t.cgWindow, ChromeNative.geometryRectValid(row.bounds) else {
                    throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
                }
                return row.bounds
            }
            let p = probe()
            guard let values = p.CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
                try p.check(); throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
            }
            let exact = values.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(t.chromePid) &&
                ($0[kCGWindowNumber as String] as? Int) == t.cgWindow && ($0[kCGWindowLayer as String] as? Int) == 0 }
            try p.check()
            guard exact.count == 1, let value = exact[0][kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: value), row.id == t.windowId,
                  ChromeNative.geometryRectValid(rect), ChromeNative.geometryRectValid(row.bounds), ChromeNative.sameRect(row.bounds, rect) else {
                throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
            }
            try requireAlive("native_geometry_verify")
            return rect
        }
        func prepareWindowGeometry(_ t: Target, mode: WindowGeometryIntent, requested: CGRect?, tx: Transaction,
                                   observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil) throws -> WindowGeometryPlan {
            tx.geometryTarget = t
            tx.geometry = ["mode": mode.mode, "possiblyChanged": false]
            let row = try verify(t, observe: observe), cg = try readWindowGeometry(t, row: row)
            let plan = try ChromeNative.geometryPlan(mode, before: row.bounds, cg: cg, requested: requested, displays: readWindowDisplays())
            tx.geometry = plan.json
            return plan
        }
        @discardableResult
        func verifyWindowGeometry(_ t: Target, plan: WindowGeometryPlan, tx: Transaction, row: WindowRow? = nil,
                                  observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                                  until: Double? = nil) throws -> WindowRow {
            let current: WindowRow
            do { current = try row ?? verify(t, observe: observe, until: until) }
            catch let error as Failure {
                if error.details["bindingReason"] as? String == "cg_mapping_missing",
                   tx.stages.contains(where: { ["activate_fit", "window_bounds", "new_window_bounds"].contains($0["stage"] as? String ?? "") && $0["acknowledged"] as? Bool == true }) {
                    throw Failure("native_geometry_unconfirmed", error.stage, osStatus: error.osStatus, details: error.details)
                }
                throw error
            }
            let cg = try readWindowGeometry(t, row: current)
            try ChromeNative.geometryPostcondition(plan, row: current.bounds, cg: cg, displays: readWindowDisplays())
            if let accepted = tx.acceptedGeometry {
                guard ChromeNative.sameRect(current.bounds, accepted.row), ChromeNative.sameRect(cg, accepted.cg) else {
                    throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
                }
            } else {
                // Retain Chrome's accepted actual clamp, including zero-write fits.
                tx.acceptedGeometry = (current.bounds, cg)
            }
            tx.geometry?["changed"] = current.bounds != plan.before || cg != plan.beforeCG
            return current
        }
        @discardableResult
        func applyWindowGeometry(_ t: Target, plan: WindowGeometryPlan, stage: String, tx: Transaction,
                                 observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                                 postWrite: (() -> Void)? = nil) throws -> WindowRow {
            if plan.needsWrite {
                guard !tx.stages.contains(where: { ["activate_fit", "window_bounds", "new_window_bounds"].contains($0["stage"] as? String ?? "") }) else {
                    throw Failure("native_request_invalid", "native_geometry_prepare")
                }
                if dry {
                    let current = try verify(t, observe: observe)
                    guard current.bounds == plan.before else {
                        tx.geometry?["possiblyChanged"] = true
                        throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
                    }
                    try dryWrite(stage, tx: tx) { dryUpdate(t.windowId, rect: plan.fitted) }
                } else {
                    try setWindow(t, property: "pbnd", value: rectangle(plan.fitted), stage: stage, tx: tx,
                                  observe: observe, expectedBounds: plan.before)
                }
            }
            postWrite?()
            return try verifyWindowGeometry(t, plan: plan, tx: tx, observe: observe)
        }
        func url(_ intent: [String: Any]) throws -> String {
            guard let url = intent["url"] as? String, !url.isEmpty, url.utf8.count <= 32768,
                  !url.contains("\0"), !url.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("javascript:") else { throw Failure("native_url_invalid", "native_prepare") }
            return url
        }
        func resultTarget(_ t: Target, _ row: WindowRow) -> [String: Any] {
            var result = t.json.merging(["bounds": ["left": row.bounds.minX, "top": row.bounds.minY, "width": row.bounds.width, "height": row.bounds.height],
                                        "tabActive": row.activeTab == t.tabId, "minimized": row.minimized,
                                        "windowIndex": row.index]) { first, _ in first }
            // Only the final snapshot's exact tab supplies current ownership metadata.
            // WindowRow.title belongs to its active tab, which may be a different tab.
            result["url"] = row.tabURLs[t.tabId] as Any? ?? NSNull()
            result["title"] = row.activeTab == t.tabId ? row.title as Any : NSNull()
            return result
        }
        func dryUpdate(_ id: Int, tabs: [Int]? = nil, active: Int? = nil, rect: CGRect? = nil, index: Int? = nil, minimized: Bool? = nil, urls: [Int: String]? = nil) {
            guard let i = dryRows.firstIndex(where: { $0.id == id }) else { return }
            let r = dryRows[i]
            dryRows[i] = WindowRow(id: id, tabs: tabs ?? r.tabs, activeTab: active ?? r.activeTab,
                                  index: index ?? r.index, bounds: rect ?? r.bounds, minimized: minimized ?? r.minimized, title: r.title, tabURLs: urls ?? r.tabURLs)
        }
        func dryWrite(_ stage: String, tx: Transaction, _ body: () -> Void = {}) throws {
            try tx.write(stage) {
                if dryConfig["failStage"] as? String == stage { throw Failure("native_write_unknown", stage) }
                body()
            }
        }
        func executeDry(_ intent: [String: Any], request: [String: Any], tx: Transaction) throws -> [String: Any] {
            let kind = intent["kind"] as! String
            let geometryMode = try ChromeNative.geometryIntent(intent)
            if kind == "dialogAnswer" {
                guard let key = intent["dialogToken"] as? String, let t = dialogTargets[key], target == t,
                      let button = intent["button"] as? String else { throw Failure("dialog_identity_required", "dialog_identity") }
                _ = try inspectDry(t, existing: key)
                let config = dryConfig["dialog"] as? [String: Any] ?? [:]
                let buttons = config["buttons"] as? [String] ?? ["OK", "Cancel"]
                guard buttons.filter({ $0 == button }).count == 1 else { throw Failure("dialog_button_ambiguous", "dialog_button") }
                let text = intent["text"] as? String
                func checkAuto() throws {
                    let current = dryConfig["dialog"] as? [String: Any] ?? [:]
                    if intent["autoConstraint"] != nil && text != nil { throw Failure("auto_skipped_field", "dialog_auto_constraint") }
                    if intent["autoConstraint"] != nil && current["complete"] as? Bool == false { throw Failure("auto_skipped_incomplete_template", "dialog_auto_constraint") }
                    try checkAutoConstraint(intent["autoConstraint"], target: t, title: current["title"] as? String ?? "fixture",
                        texts: current["texts"] as? [String] ?? [], buttons: current["buttons"] as? [String] ?? ["OK", "Cancel"],
                        hasField: (current["fields"] as? Int ?? 0) > 0, button: button)
                }
                try checkAuto()
                if text != nil && (config["fields"] as? Int ?? 0) != 1 { throw Failure("dialog_field_ambiguous", "dialog_field") }
                _ = try inspectDry(t, existing: key)
                if let value = text {
                    try dryWrite("dialog_set", tx: tx) {
                        var d = dryConfig["dialog"] as? [String: Any] ?? [:]; d["fieldValue"] = value; dryConfig["dialog"] = d
                    }
                    _ = try tx.read("dialog_readback") { value }
                }
                _ = try inspectDry(t, existing: key)
                try checkAuto()
                _ = try inspectDry(t, existing: key)
                try dryWrite("dialog_press", tx: tx) {
                    var d = dryConfig["dialog"] as? [String: Any] ?? [:]
                    if d["keepOpen"] as? Bool != true { d["open"] = false }
                    dryConfig["dialog"] = d
                }
                let still = (dryConfig["dialog"] as? [String: Any])?["open"] as? Bool != false
                return ["ok": true, "open": true, "pressed": button, "sameStillOpen": still, "stillOpen": still, "stage": "dialog_postcheck"]
            }
            if kind == "restoreScene" {
                guard let stored = scene, let supplied = request["restoreToken"] as? String, supplied == sceneToken else {
                    throw Failure("native_restore_token_invalid", "native_restore")
                }
                try requireAlive("restore_prepare")
                let win = ChromeNative.dialogInt(stored["chromeWindow"] ?? stored["windowId"])
                let preserve = intent["preserveSelection"] as? Bool == true
                if preserve && (win == nil || target?.windowId != win) { throw Failure("native_restore_target_invalid", "native_restore") }
                if stored["appPid"] != nil { try dryWrite("restore_app", tx: tx) }
                if let win = win {
                    if !preserve, let tab = ChromeNative.dialogInt(stored["chromeTab"] ?? stored["tabId"]) {
                        try dryWrite("restore_tab", tx: tx) { dryUpdate(win, active: tab) }
                    }
                    try dryWrite("restore_index", tx: tx) { dryUpdate(win, index: 1) }
                }
                return ["ok": true, "appFrontmost": true, "chromeReordered": win != nil, "activated": true, "changed": stored["appPid"] != nil]
            }
            if kind == "newWindow" {
                guard let mode = geometryMode, mode.mode == "placement" else { throw Failure("native_request_invalid", "native_prepare") }
                let pid = try creationPID(intent), b = try bounds(intent), destination = try url(intent)
                tx.geometry = ["mode": mode.mode, "possiblyChanged": false]
                guard let selected = try readWindowDisplays().valid.first(where: { $0.id == mode.displayId }) else {
                    throw Failure("native_display_unavailable", "native_display_read")
                }
                _ = try ChromeNative.geometryFit(b, selected.usable)
                let before = try snapshot(pid), previous = Set(before.map { $0.id })
                let id = (dryRows.map { $0.id }.max() ?? 0) + 1, tab = (dryRows.flatMap { $0.tabs }.max() ?? 0) + 1
                let profile = (intent["profile"] as? String)?.isEmpty == false
                let marker = Self.newWindowMarker(profileCLI: profile, nonce: UUID())
                let scenario = dryConfig["creationScenario"] as? String ?? "owned"
                creationAttempted = true
                try dryWrite("new_window_create", tx: tx) {
                    let actualID = scenario == "unrelated" ? id + 1 : id
                    let actualURL = ["unrelated", "wrong_marker"].contains(scenario) ? "about:blank#unrelated" : marker
                    dryRows.append(WindowRow(id: actualID, tabs: [tab], activeTab: tab, index: 1, bounds: seedBounds, minimized: false, title: "fixture", tabURLs: [tab: actualURL]))
                    dryCG[actualID] = (dryCG.values.max() ?? seedCG) + 1
                    if scenario == "duplicate_marker" {
                        dryRows.append(WindowRow(id: profile ? id + 1 : id, tabs: [tab + 1], activeTab: tab + 1, index: 2, bounds: seedBounds, minimized: false, title: "fixture", tabURLs: [tab + 1: marker]))
                    }
                }
                let receipt: Int? = scenario == "missing_receipt" ? nil : scenario == "invalid_receipt" ? -1 : id
                if !profile && (receipt == nil || receipt! <= 0) { throw Failure("new_window_unconfirmed", "new_window_receipt") }
                guard let row = try Self.createdWindow(snapshot(pid), previous: previous, marker: profile ? marker : nil, receiptID: profile ? nil : receipt) else {
                    throw Failure("new_window_unconfirmed", "new_window_identity")
                }
                let made = try Target(["chromePid": Int(pid), "windowId": row.id, "tabId": row.activeTab, "cgWindow": dryCG[row.id]!])
                let plan = try prepareWindowGeometry(made, mode: mode, requested: b, tx: tx)
                try applyWindowGeometry(made, plan: plan, stage: "new_window_bounds", tx: tx)
                try dryWrite("new_window_url", tx: tx) { dryUpdate(row.id, urls: [row.activeTab: destination]) }
                let after = try verifyWindowGeometry(made, plan: plan, tx: tx)
                target = made
                // DRY exposes the captured creation URL; all physical fields are verified final values.
                var result = resultTarget(made, after)
                result["url"] = row.tabURLs[made.tabId] as Any? ?? NSNull()
                return result.merging(["ok": true, "creationAttempted": true, "chromeCameForward": false, "forwardMs": 0]) { _, new in new }
            }
            let t = try bound(intent), row = try verify(t)
            var geometryPlan: WindowGeometryPlan?
            if let geometryMode { tx.geometryTarget = t; tx.geometry = ["mode": geometryMode.mode, "possiblyChanged": false] }
            switch kind {
            case "closeTab":
                if let d = dryConfig["dialog"] as? [String: Any], d["open"] as? Bool != false {
                    throw Failure("close_prompt_pending", "close_preflight", details: ["promptPending": true])
                }
                try dryWrite("close_tab", tx: tx) { dryUpdate(t.windowId, tabs: row.tabs.filter { $0 != t.tabId }) }
                return ["ok": true, "closed": true, "leavePrompt": false, "stage": "close_postcheck"]
            case "openTab":
                let destination = try url(intent), marker = "about:blank#mychrome-native-" + UUID().uuidString
                let newID = (dryRows.flatMap { $0.tabs }.max() ?? 0) + 1
                let scenario = dryConfig["creationScenario"] as? String ?? "owned"
                try dryWrite("open_tab_create", tx: tx) {
                    var urls = row.tabURLs
                    urls[newID] = ["unrelated", "wrong_marker"].contains(scenario) ? "about:blank#unrelated" : marker
                    let added = scenario == "duplicate_marker" ? [newID, newID + 1] : [newID]
                    if added.count > 1 { urls[newID + 1] = marker }
                    dryUpdate(t.windowId, tabs: row.tabs + added, active: newID, urls: urls)
                }
                guard let current = try snapshot(t.chromePid).first(where: { $0.id == t.windowId }),
                      let owned = try Self.createdTab(current, previous: Set(row.tabs), marker: marker) else {
                    throw Failure("new_tab_unconfirmed", "open_tab_identity")
                }
                try dryWrite("open_tab_url", tx: tx) { var urls = current.tabURLs; urls[owned] = destination; dryUpdate(t.windowId, urls: urls) }
                if intent["select"] as? Bool != true { try dryWrite("open_restore_tab", tx: tx) { dryUpdate(t.windowId, active: row.activeTab) } }
                return ["ok": true, "chromePid": Int(t.chromePid), "windowId": t.windowId, "tabId": owned, "cgWindow": t.cgWindow,
                        "selected": intent["select"] as? Bool == true, "creationAttempted": true]
            case "moveWindow":
                guard let mode = geometryMode else { throw Failure("native_request_invalid", "native_prepare") }
                let requested = mode.mode == "placement" ? try bounds(intent) : nil
                let plan = try prepareWindowGeometry(t, mode: mode, requested: requested, tx: tx)
                geometryPlan = plan
                try applyWindowGeometry(t, plan: plan, stage: "window_bounds", tx: tx)
            case "selectTab":
                try dryWrite("select_tab", tx: tx) { dryUpdate(t.windowId, active: t.tabId) }
            case "activate":
                if let mode = geometryMode {
                    if row.minimized {
                        try dryWrite("activate_unminimize", tx: tx) { dryUpdate(t.windowId, minimized: false) }
                    }
                    let plan = try prepareWindowGeometry(t, mode: mode, requested: nil, tx: tx)
                    geometryPlan = plan
                    try applyWindowGeometry(t, plan: plan, stage: "activate_fit", tx: tx)
                    for stage in ["activate_tab", "activate_index", "activate_main", "activate_raise", "activate_app"] { try dryWrite(stage, tx: tx) }
                } else {
                    for stage in ["activate_unminimize", "activate_tab", "activate_index", "activate_main", "activate_raise", "activate_app"] { try dryWrite(stage, tx: tx) }
                }
                dryUpdate(t.windowId, active: t.tabId, index: 1, minimized: false)
            default: throw Failure("native_request_invalid", "native_dispatch")
            }
            let after = try geometryPlan.map { try verifyWindowGeometry(t, plan: $0, tx: tx) } ?? dryRows.first { $0.id == t.windowId }!
            let changed = kind == "moveWindow" ? tx.geometry?["changed"] as? Bool == true : true
            return resultTarget(t, after).merging(["ok": true, "changed": changed, "frontmost": "Google Chrome", "frontmostPid": Int(t.chromePid), "waitedMs": 0,
                "targetOnTop": true, "keyWindowIsTarget": true, "frontmostChanged": false, "prevFrontPutBack": false]) { _, new in new }
        }
        func exactWindow(_ t: Target, access: Probe) throws -> AXUIElement {
            let matches = access.axWindows(pid: t.chromePid).filter { access.axWindowNumber($0) == t.cgWindow }
            try access.check()
            guard matches.count == 1 else { throw Failure("native_target_changed", "native_window_binding") }
            return matches[0]
        }
        /// FOCUS4 (G-a): the exact AX window for the optional AXMain/AXRaise assistance, or nil when this Chrome's AX
        /// window list does not hold the target exactly once or its messaging timeout cannot be set. A probe cut
        /// (deadline, Stop) still surfaces as itself; nil is never a binding verdict (that is bound/verify's, by CG).
        func axAssistWindow(_ t: Target, access: Probe) throws -> AXUIElement? {
            let matches = access.axWindows(pid: t.chromePid).filter { access.axWindowNumber($0) == t.cgWindow }
            try access.check()
            guard matches.count == 1, ApplicationServices.AXUIElementSetMessagingTimeout(matches[0], 0.05) == .success else { return nil }
            return matches[0]
        }
        func object(_ type: String, id: Int, container: NSAppleEventDescriptor? = nil) throws -> NSAppleEventDescriptor {
            try specifier(type, form: "ID  ", key: NSAppleEventDescriptor(string: String(id)), container: container)
        }
        func specifier(_ type: String, form: String, key: NSAppleEventDescriptor,
                       container: NSAppleEventDescriptor? = nil) throws -> NSAppleEventDescriptor {
            var parent = AEDesc(descriptorType: typeNull, dataHandle: nil), keyCopy = AEDesc(), out = AEDesc()
            if let value = container, let desc = value.aeDesc { AEDuplicateDesc(desc, &parent) }
            guard let desc = key.aeDesc, AEDuplicateDesc(desc, &keyCopy) == noErr else { throw Failure("native_event_invalid", "native_prepare") }
            defer { AEDisposeDesc(&parent); AEDisposeDesc(&keyCopy) }
            guard CreateObjSpecifier(Self.code(type), &parent, Self.code(form), &keyCopy, false, &out) == noErr else {
                throw Failure("native_event_invalid", "native_prepare")
            }
            return NSAppleEventDescriptor(aeDescNoCopy: &out)
        }
        static func code(_ text: String) -> FourCharCode { text.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) } }
        func event(_ pid: pid_t, id: String) -> NSAppleEventDescriptor {
            NSAppleEventDescriptor(eventClass: Self.code("core"), eventID: Self.code(id),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        }
        func windowProperty(_ t: Target, _ property: String, _ value: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
            let window = try object("cwin", id: t.windowId)
            let key = try specifier("prop", form: "prop", key: NSAppleEventDescriptor(typeCode: Self.code(property)), container: window)
            let e = event(t.chromePid, id: "setd")
            e.setParam(key, forKeyword: Self.code("----")); e.setParam(value, forKeyword: Self.code("data"))
            return e
        }
        func tabProperty(_ t: Target, _ property: String, _ value: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
            let window = try object("cwin", id: t.windowId), tab = try object("CrTb", id: t.tabId, container: window)
            let key = try specifier("prop", form: "prop", key: NSAppleEventDescriptor(typeCode: Self.code(property)), container: tab)
            let e = event(t.chromePid, id: "setd")
            e.setParam(key, forKeyword: Self.code("----")); e.setParam(value, forKeyword: Self.code("data"))
            return e
        }
        func rectangle(_ r: CGRect) throws -> NSAppleEventDescriptor {
            guard r.size.width > 0, r.size.height > 0,
                  let top = Int16(exactly: r.minY), let left = Int16(exactly: r.minX),
                  let bottom = Int16(exactly: r.maxY), let right = Int16(exactly: r.maxX) else {
                throw Failure("native_bounds_invalid", "native_prepare")
            }
            var value = Carbon.Rect(top: top, left: left, bottom: bottom, right: right)
            guard let descriptor = withUnsafePointer(to: &value, {
                NSAppleEventDescriptor(descriptorType: typeQDRectangle, bytes: $0, length: MemoryLayout<Carbon.Rect>.size)
            }) else { throw Failure("native_event_invalid", "native_prepare") }
            return descriptor
        }
        @discardableResult
        func send(_ e: NSAppleEventDescriptor, stage: String, tx: Transaction, noReply: Bool = false) throws -> NSAppleEventDescriptor {
            // Descriptor creation/lookup is complete BEFORE Transaction's final check.
            let options: NSAppleEventDescriptor.SendOptions = noReply ? [.noReply, .neverInteract] : [.waitForReply, .neverInteract]
            return try tx.write(stage, acknowledged: !noReply) {
                let reply: NSAppleEventDescriptor
                do { reply = try e.sendEvent(options: options, timeout: 0.05) }
                catch {
                    let status = (error as NSError).code
                    throw Failure(status == -1743 ? "native_permission_required" : "native_write_unknown", stage, osStatus: status)
                }
                if !noReply, let error = reply.paramDescriptor(forKeyword: Self.code("errn")), error.int32Value != 0 {
                    throw Failure("native_write_unknown", stage, osStatus: Int(error.int32Value))
                }
                return reply
            }
        }
        func setWindow(_ t: Target, property: String, value: NSAppleEventDescriptor, stage: String, tx: Transaction,
                       observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = nil,
                       expectedBounds: CGRect? = nil) throws {
            let row = try verify(t, observe: observe)
            if let expectedBounds, row.bounds != expectedBounds {
                tx.geometry?["possiblyChanged"] = true
                throw Failure("native_geometry_unconfirmed", "native_geometry_verify")
            }
            let e = try windowProperty(t, property, value)
            try send(e, stage: stage, tx: tx)
        }
        func select(_ t: Target, stage: String, tx: Transaction) throws {
            let row = try verify(t)
            guard let index = row.tabs.firstIndex(of: t.tabId) else { throw Failure("native_target_changed", "native_binding") }
            if row.activeTab == t.tabId { return }
            let e = try windowProperty(t, "acTI", NSAppleEventDescriptor(int32: Int32(index + 1)))
            try send(e, stage: stage, tx: tx)
        }
        func activateApp(_ pid: pid_t, stage: String, tx: Transaction) throws {
            try requireAlive("native_app_lookup")
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
                throw Failure("native_app_missing", "native_app_lookup")
            }
            try tx.write(stage) {
                guard app.activate(options: []) else { throw Failure("native_write_unknown", stage) }
            }
        }
        /// FOCUS4 amendment A (user decision 3, contracts-batch4.md): Chrome's own `activate` Apple Event, once: the
        /// same as `tell application "Google Chrome" to activate` (the target is already Chrome's index-1 window; raising
        /// Chrome's other windows is accepted). Sent without awaiting a reply, so a busy Chrome cannot make the activation
        /// unknown; the facts are read again afterwards (appleFront). r1 A3: `focusAppleActivate` is recorded on the
        /// transaction at the send itself (inside the ledger's write), so it stays on the reply through any later error
        /// or Stop; Transaction.result carries it on success, failure and the Session's Stop reply alike.
        func appleActivate(_ t: Target, tx: Transaction) throws {
            let e = NSAppleEventDescriptor(eventClass: Self.code("misc"), eventID: Self.code("actv"),
                targetDescriptor: NSAppleEventDescriptor(processIdentifier: t.chromePid),
                returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            try tx.write("activate_apple", acknowledged: false) {
                tx.facts["focusAppleActivate"] = true
                do { _ = try e.sendEvent(options: [.noReply, .neverInteract], timeout: 0.05) }
                catch {
                    let status = (error as NSError).code
                    throw Failure(status == -1743 ? "native_permission_required" : "native_write_unknown", "activate_apple", osStatus: status)
                }
            }
        }
        /// FOCUS4 amendment A: Chrome is still not the frontmost app after MyChrome's own activation: the Apple Event
        /// activate once, then front and focus are sampled again within one more bounded window (0.7 s; read-only; the
        /// first sample with Chrome in front and the target on top ends it, else the last complete sample is reported).
        func appleFront(_ t: Target, tx: Transaction) throws -> (Bool, Bool, Int, [String: Any]) {
            try appleActivate(t, tx: tx)
            return try settleFocus(t, until: ProcessInfo.processInfo.systemUptime + 0.7)
        }
        /// PERM1 (contracts-batch4.md PERM1, rulings 1-3): Popup.resolve wired to this Owner. Reads share one 0.3 s
        /// classification deadline (a cut = no press); the one press is prepared (stop check, messaging timeout) before
        /// the ledger's write; afterwards focus is sampled again for at most 0.7 s (read-only). Called once per activation.
        func clearChromePrompt(_ t: Target, _ state: (Bool, Bool, Int, [String: Any]), tx: Transaction) throws -> ((Bool, Bool, Int, [String: Any]), [String: Any]) {
            let until = ProcessInfo.processInfo.systemUptime + 0.3
            func read<T>(_ body: (Probe) -> T) throws -> T { let p = probe(until: until); let r = body(p); try p.check(); return r }
            return try Popup.resolve(Popup.Effects(
                now: { ProcessInfo.processInfo.systemUptime },
                above: { try read { $0.popupAbove(t) } },
                shape: { number in try read { $0.popupShape(number, pid: t.chromePid) } },
                pressable: { element in try read { $0.popupPressable(element) } },
                prepare: { [unowned self] element in
                    try self.requireAlive("popup_press_prepare")
                    return ApplicationServices.AXUIElementSetMessagingTimeout(element, 0.05) == .success
                },
                press: { element in AXUIElementPerformAction(element, kAXPressAction as CFString) },
                settle: { [unowned self] in try self.settleFocus(t, until: ProcessInfo.processInfo.systemUptime + 0.7) },
                held: { [unowned self] in self.held() }),
                state: state, chromePid: Int(t.chromePid), tx: tx)
        }
        func awaitFront(_ pid: pid_t, deadline: Double) throws -> Bool {
            while ProcessInfo.processInfo.systemUptime < deadline {
                try requireAlive("native_focus_read")
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
                try pump()
            }
            return false
        }
        /// FOCUS1: after the activation writes, focus is sampled read-only until the target is on top, or until the one
        /// absolute `deadline`. No sample starts at or after it, and each sample's probe is bounded by it; a sample cut by
        /// it is dropped. The last complete sample is reported; none at all = every fact false (focusSettleExpired).
        /// FOCUS4: the AX key window is read in each sample as a diagnostic only; the settle never waits for it.
        /// Nothing is raised, activated or selected here and no write is repeated.
        func settleFocus(_ t: Target, until deadline: Double) throws -> (Bool, Bool, Int, [String: Any]) {
            var last: (Bool, Bool, Int, [String: Any])?, samples = 0
            while ProcessInfo.processInfo.systemUptime < deadline {
                do { last = try focus(t, until: deadline); samples += 1 }
                catch let cut as DialogFailure where cut.code == "dialog_probe_unknown" && cut.stage == "native_read_deadline" { break }
                if let sample = last, sample.0 { return sample }
                let next = min(ProcessInfo.processInfo.systemUptime + 0.02, deadline)
                while ProcessInfo.processInfo.systemUptime < next { try pump(); try requireAlive("native_focus_read") }
            }
            var decided = last ?? (false, false, 0, ["focusSettleExpired": true])
            decided.3["focusSamples"] = samples
            return decided
        }
        /// The fourth element is the complete activate_unconfirmed detail set (names, pids, layer, size only).
        func focus(_ t: Target, until deadline: Double? = nil) throws -> (Bool, Bool, Int, [String: Any]) {
            /// Pure order decision over one front-to-back on-screen CG list. The target must be the first
            /// layer-0 window of its Chrome process. Skipped: verified sharing indicators and, exactly as
            /// helper.swift cgWindowNumberAt, this Chrome's own windows under 100 pt wide or high (link
            /// status bubble, tooltips). `blocker` is diagnostic only (owner name, pid, layer, size; never a
            /// title): the Chrome window that failed the order, else the first other-app window over the target.
            func focusOrder(_ rows: [[String: Any]], pid: Int, cg: Int, frontPid: Int,
                            indicators: Set<Int>, ownPid: Int) -> (onTop: Bool, blocker: [String: Any]?) {
                func rect(_ row: [String: Any]) -> CGRect? {
                    (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
                }
                func chromeCandidate(_ row: [String: Any]) -> Bool {
                    guard (row[kCGWindowOwnerPID as String] as? Int) == pid, (row[kCGWindowLayer as String] as? Int) == 0 else { return false }
                    let number = row[kCGWindowNumber as String] as? Int ?? 0
                    if number == cg { return true }
                    if indicators.contains(number) { return false }
                    if let r = rect(row), r.width < 100 || r.height < 100 { return false }
                    return true
                }
                let onTop = frontPid == pid && (rows.first(where: chromeCandidate)?[kCGWindowNumber as String] as? Int) == cg
                if onTop { return (true, nil) }
                let target = rows.first { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowNumber as String] as? Int) == cg }.flatMap(rect)
                for row in rows {
                    let owner = row[kCGWindowOwnerPID as String] as? Int ?? 0, layer = row[kCGWindowLayer as String] as? Int ?? -1
                    if owner == pid && (row[kCGWindowNumber as String] as? Int) == cg { break }
                    let r = rect(row)
                    if owner == pid {
                        guard chromeCandidate(row) else { continue }
                    } else {
                        // Covering windows only, as helper.swift topOwner(at:); never this helper's own veil.
                        guard owner != ownPid, layer >= 0, layer <= 19, let box = r, let covered = target, box.intersects(covered),
                              box.width >= 2, box.height >= 2, (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                              let name = row[kCGWindowOwnerName as String] as? String, !name.isEmpty, name != "Window Server" else { continue }
                    }
                    var blocker: [String: Any] = ["owner": row[kCGWindowOwnerName as String] as? String ?? "", "pid": owner, "layer": layer,
                                                  "width": NSNull(), "height": NSNull()]
                    if let box = r { blocker["width"] = Int(box.width.rounded()); blocker["height"] = Int(box.height.rounded()) }
                    return (false, blocker)
                }
                return (false, nil)
            }
            let p = deadline.map { probe(until: $0) } ?? probe()
            var focused: CFTypeRef?
            let status = p.AXUIElementCopyAttributeValue(AXUIElementCreateApplication(t.chromePid), kAXFocusedWindowAttribute as CFString, &focused)
            try p.check()
            let exact = status == .success && focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && p.axWindowNumber($0 as! AXUIElement) == t.cgWindow } == true
            guard let rows = p.CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
                try p.check() // a probe cut (deadline, Stop) surfaces as itself, not as an unknown focus
                throw Failure("native_focus_unknown", "native_focus_read")
            }
            let indicators = Set(p.axWindows(pid: t.chromePid).filter { p.axIsWindowSharingIndicator($0) }.compactMap { p.axWindowNumber($0) })
            let frontApp = NSWorkspace.shared.frontmostApplication
            let front = Int(frontApp?.processIdentifier ?? 0)
            let decision = focusOrder(rows, pid: Int(t.chromePid), cg: t.cgWindow, frontPid: front,
                                      indicators: indicators, ownPid: Int(getpid()))
            try p.check(); try requireAlive("native_focus_read")
            return (decision.onTop, exact, front, ["targetOnTop": decision.onTop, "keyWindowIsTarget": exact,
                "frontmost": frontApp?.localizedName ?? "", "frontmostPid": front, "focusBlocker": decision.blocker ?? NSNull()])
        }
        func noDialog(_ t: Target) throws {
            let p = probe()
            do {
                let d = try p.axPageDialog(pid: t.chromePid); try p.check()
                if d != nil { throw Failure("close_prompt_pending", "close_preflight", details: ["promptPending": true]) }
            } catch { throw p.retryFacts(p.firstFailure ?? error) }
        }
        func checkAutoConstraint(_ raw: Any?, target t: Target, title: String, texts: [String],
                                 buttons: [String], hasField: Bool, button: String) throws {
            guard let raw = raw else { return }
            guard let constraint = raw as? [String: Any], Set(constraint.keys) == Set(["version", "origin", "template", "semantic", "button"]),
                  ChromeNative.dialogInt(constraint["version"]) == 1,
                  let origin = constraint["origin"] as? String, ChromeNative.promptOrigin(origin) == origin,
                  let semantic = constraint["semantic"] as? String, ["keep_session", "exit_session"].contains(semantic),
                  constraint["button"] as? String == button,
                  let template = constraint["template"] as? [String: Any],
                  Set(template.keys) == Set(["id", "version", "title", "texts", "buttons", "hasField"]),
                  let id = template["id"] as? String, id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil,
                  ChromeNative.dialogInt(template["version"]) != nil,
                  let expectedTitle = template["title"] as? String, let expectedTexts = template["texts"] as? [String],
                  let expectedButtons = template["buttons"] as? [String],
                  let field = template["hasField"] as? NSNumber, CFGetTypeID(field) == CFBooleanGetTypeID(), !field.boolValue,
                  !hasField, buttons.count <= 8, !buttons.isEmpty, Set(buttons).count == buttons.count,
                  buttons.allSatisfy({ $0.count <= 256 }),
                  ([title] + texts + buttons).joined().utf16.count <= 4096,
                  ChromeNative.promptText(title) == ChromeNative.promptText(expectedTitle),
                  texts.map(ChromeNative.promptText) == expectedTexts.map(ChromeNative.promptText),
                  buttons.map(ChromeNative.promptText) == expectedButtons.map(ChromeNative.promptText),
                  buttons.filter({ $0 == button }).count == 1 else { throw Failure("auto_skipped_template_mismatch", "dialog_auto_constraint") }
            // Same owner, same exact PID/window/tab/CG and a fresh URL snapshot on every check.
            let row = try verify(t, requireActive: true)
            guard let url = row.tabURLs[t.tabId], let current = ChromeNative.promptOrigin(url) else {
                throw Failure("auto_skipped_origin_unverified", "dialog_auto_origin")
            }
            guard current == origin else { throw Failure("auto_skipped_origin_mismatch", "dialog_auto_origin") }
            try requireAlive("dialog_auto_constraint")
        }
        func executeDialog(_ intent: [String: Any], tx: Transaction) throws -> [String: Any] {
            guard let key = intent["dialogToken"] as? String, let original = dialogs[key],
                  let t = dialogTargets[key], t == target, let expected = original.identity,
                  let button = intent["button"] as? String, !button.isEmpty, button.utf8.count <= 4096 else {
                throw Failure("dialog_identity_required", "dialog_identity")
            }
            let text = intent["text"] as? String
            if intent["autoConstraint"] != nil && text != nil { throw Failure("auto_skipped_field", "dialog_auto_constraint") }
            if let text = text, text.utf8.count > 1_000_000 { throw Failure("dialog_text_invalid", "dialog_identity") }
            func inspectCurrent() throws -> PageDialog? {
                let p = probe(), current = try p.inspect(pid: t.chromePid, target: t.json)
                if let current = current {
                    guard sameDialog(original, current) else { throw Failure("dialog_identity_mismatch", "dialog_recheck") }
                    if intent["autoConstraint"] != nil && !current.templateComplete { throw Failure("auto_skipped_incomplete_template", "dialog_auto_constraint") }
                    try checkAutoConstraint(intent["autoConstraint"], target: t, title: current.title, texts: current.texts,
                                            buttons: current.buttons.map { $0.0 }, hasField: current.hasField, button: button)
                }
                return current
            }
            return try ChromeNative.answerPageDialog(expected: expected, button: button, text: text,
                inspect: inspectCurrent,
                validateButton: { [unowned self] element in
                    let p = self.probe()
                    guard try p.dialogAX(element, kAXEnabledAttribute) as? Bool == true else { throw Failure("dialog_button_unavailable", "dialog_button") }
                    var actions: CFArray?
                    try self.requireAlive("dialog_button")
                    guard ApplicationServices.AXUIElementSetMessagingTimeout(element, 0.025) == .success else { throw Failure("dialog_probe_unknown", "dialog_button") }
                    let status = AXUIElementCopyActionNames(element, &actions)
                    try self.requireAlive("dialog_button")
                    guard status == .success, (actions as? [String])?.contains(kAXPressAction as String) == true else {
                        throw Failure("dialog_button_unavailable", "dialog_button")
                    }
                }, validateField: { [unowned self] element in
                    let p = self.probe()
                    guard try p.dialogAX(element, kAXEnabledAttribute) as? Bool == true else { throw Failure("dialog_field_unavailable", "dialog_field") }
                    var settable = DarwinBoolean(false)
                    try self.requireAlive("dialog_field")
                    guard ApplicationServices.AXUIElementSetMessagingTimeout(element, 0.025) == .success else { throw Failure("dialog_probe_unknown", "dialog_field") }
                    let status = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
                    try self.requireAlive("dialog_field")
                    guard status == .success, settable.boolValue else { throw Failure("dialog_field_unavailable", "dialog_field") }
                }, set: { [unowned self] element, value in
                    try self.requireAlive("dialog_set_prepare")
                    guard ApplicationServices.AXUIElementSetMessagingTimeout(element, 0.05) == .success else { throw Failure("dialog_probe_unknown", "dialog_set_prepare") }
                    let fieldValue = value as CFString
                    return try tx.write("dialog_set") {
                        let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, fieldValue)
                        guard status == .success else { throw Failure("dialog_set_failed", "dialog_set", osStatus: Int(status.rawValue)) }
                        return true
                    }
                }, read: { [unowned self] element in
                    let p = self.probe(); let value = try p.dialogAX(element, kAXValueAttribute); try p.check(); return value as? String
                }, press: { [unowned self] element in
                    if intent["autoConstraint"] != nil {
                        guard let current = try inspectCurrent(), current.buttons.contains(where: { $0.0 == button && CFEqual($0.1, element) }) else {
                            throw Failure("dialog_identity_mismatch", "dialog_auto_constraint")
                        }
                    }
                    try self.requireAlive("dialog_press_prepare")
                    guard ApplicationServices.AXUIElementSetMessagingTimeout(element, 0.05) == .success else { throw Failure("dialog_probe_unknown", "dialog_press_prepare") }
                    return try tx.write("dialog_press") {
                        let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
                        guard status == .success else { throw Failure("dialog_press_unconfirmed", "dialog_press", osStatus: Int(status.rawValue)) }
                        return true
                    }
                }, settle: { [unowned self] in
                    let deadline = ProcessInfo.processInfo.systemUptime + 0.05
                    while ProcessInfo.processInfo.systemUptime < deadline { try self.pump(); try self.requireAlive("dialog_postcheck") }
                })
        }
        func execute(_ intent: [String: Any], request: [String: Any], tx: Transaction) throws -> [String: Any] {
            let kind = intent["kind"] as! String
            let geometryMode = try ChromeNative.geometryIntent(intent)
            if kind == "dialogAnswer" { return try executeDialog(intent, tx: tx) }
            if kind == "restoreScene" { return try restore(intent, request: request, tx: tx) }
            if kind == "newWindow" {
                let flag = request["_boundsEvidence"] as? NSNumber
                let enabled = !dry && request["op"] as? String == "nativeChrome" && flag.map { CFGetTypeID($0) != CFBooleanGetTypeID() &&
                    ["c", "s", "i", "l", "q", "C", "S", "I", "L", "Q"].contains(String(cString: $0.objCType)) && $0.int64Value == 1 } == true
                return try createWindow(intent, tx: tx, boundsEvidence: enabled)
            }
            let t = try bound(intent), row = try verify(t)
            var geometryPlan: WindowGeometryPlan?
            var focusSettleUntil: Double?
            var axWindowMissing = false
            if let geometryMode {
                tx.geometryTarget = t; tx.geometry = ["mode": geometryMode.mode, "possiblyChanged": false]
            }
            switch kind {
            case "closeTab":
                try noDialog(t)
                // Ownership reads above are followed by Transaction's final live check.
                let window = try object("cwin", id: t.windowId), tab = try object("CrTb", id: t.tabId, container: window)
                let e = event(t.chromePid, id: "clos"); e.setParam(tab, forKeyword: Self.code("----"))
                try send(e, stage: "close_tab", tx: tx)
                let after = try snapshot(t.chromePid)
                if !after.contains(where: { $0.tabs.contains(t.tabId) }) {
                    return ["ok": true, "closed": true, "leavePrompt": false, "stage": "close_postcheck"]
                }
                let p = probe()
                if try p.axPageDialog(pid: t.chromePid) != nil {
                    throw Failure("close_prompt_pending", "close_postcheck", details: ["promptPending": true])
                }
                try p.check()
                throw Failure("close_pending", "close_postcheck")
            case "openTab": return try createTab(t, intent: intent, before: row, tx: tx)
            case "moveWindow":
                guard let mode = geometryMode else { throw Failure("native_request_invalid", "native_prepare") }
                let requested = mode.mode == "placement" ? try bounds(intent) : nil
                let plan = try prepareWindowGeometry(t, mode: mode, requested: requested, tx: tx)
                geometryPlan = plan
                try applyWindowGeometry(t, plan: plan, stage: "window_bounds", tx: tx)
            case "selectTab":
                try select(t, stage: "select_tab", tx: tx)
            case "activate":
                if row.minimized { try setWindow(t, property: "pmnd", value: NSAppleEventDescriptor(boolean: false), stage: "activate_unminimize", tx: tx) }
                if let mode = geometryMode {
                    let plan = try prepareWindowGeometry(t, mode: mode, requested: nil, tx: tx)
                    geometryPlan = plan
                    try applyWindowGeometry(t, plan: plan, stage: "activate_fit", tx: tx)
                }
                try select(t, stage: "activate_tab", tx: tx)
                try setWindow(t, property: "pidx", value: NSAppleEventDescriptor(int32: 1), stage: "activate_index", tx: tx)
                #if MYCHROME_FOCUS_BACKENDS
                // FOCUS2: an opt-in backend replaces the steps below; nil = the legacy steps run unchanged.
                if let result = try activateBackend(t, before: row, intent: intent, plan: geometryPlan, tx: tx) { return result }
                #endif
                // FOCUS4 (G-a): AXMain and AXRaise only assist the activation. When this Chrome's AX window list does not
                // hold the target exactly once (field: AXWindows empty while the window is visibly in front), each is
                // skipped and recorded (axWindowMissing); the CG/browser binding above and the ledger of sent writes stay.
                if let ax = try axAssistWindow(t, access: probe()) {
                    try tx.write("activate_main") {
                        let status = AXUIElementSetAttributeValue(ax, kAXMainAttribute as CFString, kCFBooleanTrue)
                        guard status == .success else { throw Failure("native_write_unknown", "activate_main", osStatus: Int(status.rawValue)) }
                    }
                    // Post-write, read-only (NAT-RETRY2): a transient window-list change is read again, nothing re-sent.
                    try verifyAfterWrite(tx) { try verify(t, until: $0) }
                } else { axWindowMissing = true }
                if let exact = try axAssistWindow(t, access: probe()) {
                    try tx.write("activate_raise") {
                        let status = AXUIElementPerformAction(exact, kAXRaiseAction as CFString)
                        guard status == .success else { throw Failure("native_write_unknown", "activate_raise", osStatus: Int(status.rawValue)) }
                    }
                } else { axWindowMissing = true }
                // FOCUS1: one absolute settle window, about 1 s from the app activation write. awaitFront and the
                // final verification count against it; no focus sample (read-only, below) starts or runs past it.
                focusSettleUntil = ProcessInfo.processInfo.systemUptime + 1.0
                try activateApp(t.chromePid, stage: "activate_app", tx: tx)
                _ = try awaitFront(t.chromePid, deadline: ProcessInfo.processInfo.systemUptime + 0.7)
            default: throw Failure("native_request_invalid", "native_dispatch")
            }
            // The final post-action verification (read-only; NAT-RETRY2 when a write of this transaction was sent).
            let after: WindowRow
            if let plan = geometryPlan { after = try verifyAfterWrite(tx) { try verifyWindowGeometry(t, plan: plan, tx: tx, until: $0) } }
            else { after = try verifyAfterWrite(tx) { try verify(t, until: $0) } }
            var focusState = kind == "activate" ? try settleFocus(t, until: focusSettleUntil ?? 0) : (false, false, 0, [:])
            // FOCUS4 amendment A (user decision 3): Chrome still not the frontmost app after this activation: the Apple
            // Event activate once, before the destination checks decide (appleFront; it records focusAppleActivate).
            if kind == "activate" && NSWorkspace.shared.frontmostApplication?.processIdentifier != t.chromePid {
                focusState = try appleFront(t, tx: tx)
            }
            // FOCUS4 (G-b): the only activation verdict here is the bound tab being the window's active tab. CG order,
            // the AX key window and the settle outcome are facts on the reply; the caller decides input eligibility at
            // the destination (pointer landing point, page keyboard focus) under the input lock.
            if kind == "activate" && after.activeTab != t.tabId {
                throw Failure("activate_unconfirmed", "activate_verify", details: focusState.3.merging(
                    ["axWindowMissing": axWindowMissing, "focusVerdict": "tab_not_current"]) { first, _ in first })
            }
            // PERM1: the bound tab is its window's active tab (above): a Chrome window directly above the target is
            // classified, and a bound permission prompt or translate bubble answered once through the ledger.
            var popup: [String: Any] = [:]
            if kind == "activate" { (focusState, popup) = try clearChromePrompt(t, focusState, tx: tx) }
            var facts: [String: Any] = popup
            if kind == "activate" {
                for key in ["focusBlocker", "focusSamples", "focusSettleExpired"] { if let value = focusState.3[key] { facts[key] = value } }
                facts["axWindowMissing"] = axWindowMissing
            }
            return resultTarget(t, after).merging(["ok": true, "changed": row.activeTab != after.activeTab || (kind == "moveWindow" && tx.geometry?["changed"] as? Bool == true),
                "frontmost": NSWorkspace.shared.frontmostApplication?.localizedName ?? "", "frontmostPid": focusState.2, "waitedMs": 0,
                "targetOnTop": focusState.0, "keyWindowIsTarget": focusState.1,
                "frontmostChanged": false, "prevFrontPutBack": false].merging(facts) { first, _ in first }) { _, new in new }
        }
        // Profile CLI markers need a launchable URL without page or user data.
        static func newWindowMarker(profileCLI: Bool, nonce: UUID) -> String {
            let prefix = profileCLI ? "data:text/plain,mychrome-native-" : "about:blank#mychrome-native-"
            return prefix + nonce.uuidString
        }
        // These selectors are pure and shared by real and dry creation. A count
        // difference alone never establishes provenance for a newly seen object.
        static func createdWindow(_ rows: [WindowRow], previous: Set<Int>, marker: String?, receiptID: Int?) throws -> WindowRow? {
            guard (marker != nil) != (receiptID != nil) else { throw Failure("new_window_unconfirmed", "new_window_identity") }
            if let receipt = receiptID, receipt <= 0 || previous.contains(receipt) { throw Failure("new_window_unconfirmed", "new_window_identity") }
            let matches = rows.filter { row in
                !previous.contains(row.id) && (marker.map { row.tabURLs[row.activeTab] == $0 } ?? (row.id == receiptID))
            }
            guard matches.count <= 1 else { throw Failure("new_window_unconfirmed", "new_window_identity") }
            return matches.first
        }
        static func createdTab(_ row: WindowRow, previous: Set<Int>, marker: String) throws -> Int? {
            let matches = row.tabs.filter { !previous.contains($0) && row.tabURLs[$0] == marker }
            guard matches.count <= 1 else { throw Failure("new_tab_unconfirmed", "open_tab_identity") }
            return matches.first
        }
        static func createdWindowReceipt(_ reply: NSAppleEventDescriptor) throws -> Int {
            guard let result = reply.paramDescriptor(forKeyword: code("----")), result.descriptorType == typeObjectSpecifier,
                  result.forKeyword(code("want"))?.typeCodeValue == code("cwin"),
                  result.forKeyword(code("form"))?.enumCodeValue == code("ID  "),
                  result.forKeyword(code("from"))?.descriptorType == typeNull,
                  let selected = result.forKeyword(code("seld")),
                  let value = selected.coerce(toDescriptorType: typeUTF8Text)?.stringValue,
                  let id = Int(value), id > 0 else { throw Failure("new_window_unconfirmed", "new_window_receipt") }
            return id
        }
        func createTab(_ t: Target, intent: [String: Any], before: WindowRow, tx: Transaction) throws -> [String: Any] {
            let destination = try url(intent), marker = "about:blank#mychrome-native-" + UUID().uuidString
            let window = try object("cwin", id: t.windowId)
            var ordinal = Self.code("all ")
            guard let all = NSAppleEventDescriptor(descriptorType: Self.code("abso"), bytes: &ordinal, length: 4) else { throw Failure("native_event_invalid", "native_prepare") }
            let tabs = try specifier("CrTb", form: "indx", key: all, container: window)
            let location = NSAppleEventDescriptor.record()
            location.setDescriptor(tabs, forKeyword: Self.code("kobj"))
            location.setDescriptor(NSAppleEventDescriptor(enumCode: Self.code("end ")), forKeyword: Self.code("kpos"))
            let properties = NSAppleEventDescriptor.record()
            properties.setDescriptor(NSAppleEventDescriptor(string: marker), forKeyword: Self.code("URL "))
            let e = event(t.chromePid, id: "crel")
            e.setParam(NSAppleEventDescriptor(typeCode: Self.code("CrTb")), forKeyword: Self.code("kocl"))
            e.setParam(location, forKeyword: Self.code("insh")); e.setParam(properties, forKeyword: Self.code("prdt"))
            try send(e, stage: "open_tab_create", tx: tx, noReply: true)
            let deadline = ProcessInfo.processInfo.systemUptime + 3
            var made: WindowRow?, createdID: Int?
            repeat {
                let rows = try snapshot(t.chromePid)
                guard let row = rows.first(where: { $0.id == t.windowId }) else { throw Failure("new_tab_unconfirmed", "open_tab_identity") }
                if let id = try Self.createdTab(row, previous: Set(before.tabs), marker: marker) { made = row; createdID = id; break }
                try pump()
            } while ProcessInfo.processInfo.systemUptime < deadline
            guard made != nil, let id = createdID else { throw Failure("new_tab_unconfirmed", "open_tab_identity") }
            let created = try Target(["chromePid": Int(t.chromePid), "windowId": t.windowId, "tabId": id, "cgWindow": t.cgWindow])
            _ = try verify(created)
            let navigate = try tabProperty(created, "URL ", NSAppleEventDescriptor(string: destination))
            try send(navigate, stage: "open_tab_url", tx: tx)
            if intent["select"] as? Bool != true {
                let previous = try Target(["chromePid": Int(t.chromePid), "windowId": t.windowId, "tabId": before.activeTab, "cgWindow": t.cgWindow])
                try select(previous, stage: "open_restore_tab", tx: tx)
                if let scene = scene, ChromeNative.dialogInt(scene["chromePid"]) == Int(t.chromePid),
                   let win = ChromeNative.dialogInt(scene["chromeWindow"] ?? scene["windowId"]), win != t.windowId,
                   let tab = ChromeNative.dialogInt(scene["chromeTab"] ?? scene["tabId"]),
                   let cg = ChromeNative.dialogInt(scene["capturedCG"]) {
                    let previousWindow = try Target(["chromePid": Int(t.chromePid), "windowId": win, "tabId": tab, "cgWindow": cg])
                    try setWindow(previousWindow, property: "pidx", value: NSAppleEventDescriptor(int32: 1), stage: "open_restore_index", tx: tx)
                }
            }
            return ["ok": true, "chromePid": Int(t.chromePid), "windowId": t.windowId, "tabId": id,
                    "cgWindow": t.cgWindow, "selected": intent["select"] as? Bool == true, "creationAttempted": true]
        }
        func createWindow(_ intent: [String: Any], tx: Transaction, boundsEvidence: Bool = false) throws -> [String: Any] {
            creationPin = nil
            defer { creationPin = nil }
            guard let mode = try ChromeNative.geometryIntent(intent), mode.mode == "placement" else {
                throw Failure("native_request_invalid", "native_prepare")
            }
            let pid = try creationPID(intent), b = try bounds(intent), destination = try url(intent)
            tx.geometry = ["mode": mode.mode, "possiblyChanged": false]
            guard let selected = try readWindowDisplays().valid.first(where: { $0.id == mode.displayId }) else {
                throw Failure("native_display_unavailable", "native_display_read")
            }
            _ = try ChromeNative.geometryFit(b, selected.usable)
            let evidence = boundsEvidence ? BoundsEvidence(requestedRect: b) : nil
            let observe: ((Int, Int?, Int?, CGRect?, [Int?], [Bool?], [Int], [Int]) -> Void)? = evidence.map { collector in
                { collector.record($0, $1, $2, $3, $4, $5, $6, $7) }
            }
            let before = try snapshot(pid), previous = Set(before.map { $0.id })
            let profile = (intent["profile"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let marker = Self.newWindowMarker(profileCLI: profile != nil, nonce: UUID())
            var receiptID: Int?
            var known: Target?
            do {
                creationAttempted = true
                if let profile = profile {
                    guard profile.utf8.count <= 80, profile.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || " _-".unicodeScalars.contains($0) }),
                          let app = NSRunningApplication(processIdentifier: pid),
                          app.executableURL?.path == "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" else {
                        throw Failure("native_profile_invalid", "new_window_prepare")
                    }
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
                    process.arguments = ["--profile-directory=\(profile)", "--new-window", marker]
                    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                    try tx.write("new_window_create") { try process.run() }
                    // No waitUntilExit on the input owner. Only bounded metadata polling follows.
                } else {
                    let e = event(pid, id: "crel")
                    e.setParam(NSAppleEventDescriptor(typeCode: Self.code("cwin")), forKeyword: Self.code("kocl"))
                    let reply = try send(e, stage: "new_window_create", tx: tx)
                    receiptID = try Self.createdWindowReceipt(reply)
                }
                let deadline = ProcessInfo.processInfo.systemUptime + 6
                var row: WindowRow?
                repeat {
                    let rows = try snapshot(pid)
                    if let made = try Self.createdWindow(rows, previous: previous, marker: profile != nil ? marker : nil, receiptID: receiptID) {
                        let p = probe()
                        evidence?.begin("initial", window: made.id, expected: nil)
                        evidence?.seedTarget(rect: made.bounds, index: made.index, minimized: made.minimized)
                        var unique: [Int: Int] = [:], numbers = Set<Int>()
                        let map = try cgMapping(pid, rows: rows, access: p, observe: observe,
                            captureUnique: { unique = $0; numbers = $1 })
                        let mapped = map[made.id]
                        evidence?.initialMapped(mapped)
                        if let cg = mapped {
                            known = try Target(["chromePid": Int(pid), "windowId": made.id, "tabId": made.activeTab, "cgWindow": cg])
                            if unique[made.id] == cg {
                                creationPin = (made.id, cg, numbers, Set(rows.map { $0.id }))
                            }
                            row = made; break
                        }
                    }
                    try pump()
                } while ProcessInfo.processInfo.systemUptime < deadline
                guard let made = known, row != nil else { throw Failure("new_window_unconfirmed", "new_window_identity") }
                evidence?.begin("pre_bounds", window: made.windowId, expected: made.cgWindow)
                let plan = try prepareWindowGeometry(made, mode: mode, requested: b, tx: tx, observe: observe)
                try applyWindowGeometry(made, plan: plan, stage: "new_window_bounds", tx: tx, observe: observe, postWrite: {
                    evidence?.end()
                    evidence?.begin("post_bounds", window: made.windowId, expected: made.cgWindow)
                })
                evidence?.end()
                let e = try tabProperty(made, "URL ", NSAppleEventDescriptor(string: destination))
                try send(e, stage: "new_window_url", tx: tx)
                evidence?.begin("post_url", window: made.windowId, expected: made.cgWindow)
                let after = try verifyWindowGeometry(made, plan: plan, tx: tx, observe: observe)
                evidence?.end()
                target = made
                var result = resultTarget(made, after).merging(["ok": true, "creationAttempted": true,
                    "chromeCameForward": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "forwardMs": 0]) { _, new in new }
                if let evidence { result["_boundsEvidence"] = evidence.project() }
                return result
            } catch var error as Failure {
                if !tx.stages.isEmpty {
                    error.details["partial"] = true; error.details["creationAttempted"] = true
                    if let known = known { error.details["createdWindowId"] = known.windowId; error.details["createdTabId"] = known.tabId }
                }
                if let evidence { error.details["_boundsEvidence"] = evidence.project() }
                throw error
            }
        }
        func restore(_ intent: [String: Any], request: [String: Any], tx: Transaction) throws -> [String: Any] {
            guard let stored = scene, let supplied = request["restoreToken"] as? String, supplied == sceneToken else {
                throw Failure("native_restore_token_invalid", "native_restore")
            }
            let pid = ChromeNative.dialogInt(stored["chromePid"])
            let window = ChromeNative.dialogInt(stored["chromeWindow"] ?? stored["windowId"])
            let preserve = intent["preserveSelection"] as? Bool == true
            if preserve && (window == nil || target?.windowId != window || Int(target?.chromePid ?? 0) != pid) {
                throw Failure("native_restore_target_invalid", "native_restore")
            }
            let appPid = ChromeNative.dialogInt(stored["appPid"])
            var activated = false
            if let appPid = appPid, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid_t(appPid) {
                try activateApp(pid_t(appPid), stage: "restore_app", tx: tx); activated = true
                guard try awaitFront(pid_t(appPid), deadline: ProcessInfo.processInfo.systemUptime + 0.7) else {
                    throw Failure("restore_unconfirmed", "restore_app_verify")
                }
            }
            var reordered = false
            if let pid = pid, let window = window,
               let tab = preserve ? target?.tabId : ChromeNative.dialogInt(stored["chromeTab"] ?? stored["tabId"]),
               let cg = ChromeNative.dialogInt(stored["capturedCG"]) {
                let original = try Target(["chromePid": pid, "windowId": window, "tabId": tab, "cgWindow": cg])
                if !preserve { try select(original, stage: "restore_tab", tx: tx) }
                try setWindow(original, property: "pidx", value: NSAppleEventDescriptor(int32: 1), stage: "restore_index", tx: tx)
                reordered = true
            }
            if reordered, let appPid = appPid, appPid != pid, NSWorkspace.shared.frontmostApplication?.processIdentifier != pid_t(appPid) {
                try pump()
                try activateApp(pid_t(appPid), stage: "restore_app_again", tx: tx)
                guard try awaitFront(pid_t(appPid), deadline: ProcessInfo.processInfo.systemUptime + 0.5) else {
                    throw Failure("restore_unconfirmed", "restore_app_verify")
                }
            }
            return ["ok": true, "appFrontmost": appPid == nil || NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(appPid!),
                    "chromeReordered": reordered, "activated": true, "changed": activated]
        }
    }
}

// MARK: - FOCUS2: opt-in activation backends (skylight / carbon); legacy stays the default
// MYCHROME_FOCUS_BACKEND=skylight|carbon reaches the helper as intent.focusBackend (bridge.js), and only while
// Node's breaker is closed. Owner.execute enters here from one `#if MYCHROME_FOCUS_BACKENDS` block (the flag is
// set by scripts/build-native.sh); without a recognised backend activateBackend returns nil before any read or
// write, and execute's legacy steps below that block run unchanged.
// skylight (INV-FOCUS2 final.md §3): read-only preflight, else legacy; one short-lived `cgevent focus-front` child
// (no ScriptingBridge, private symbols by dlsym) fronts the process for this one window id and posts one make-key
// record; AXRaise; the read-only settle, with at most one AXRaise repair driven by a separate foreign-coverage scan.
// carbon (ruling 8): AXMain, SetFrontProcessWithOptions(psn, flag 1|3), AXRaise, the same settle without repair.
// Neither ever calls activate() after its front. Fallback to legacy happens only before the first private call.
extension ChromeNative {
enum Focus {
    enum Backend: String { case skylight, carbon }
    struct Request: Equatable {
        let backend: Backend
        /// SetFrontProcessWithOptions options: 1 = kSetFrontProcessFrontWindowOnly, 3 = that | kSetFrontProcessCausedByUser.
        let carbonFlag: UInt32
        /// skylight only: the one coverage-driven AXRaise repair (arm R); false is arm S.
        let reraise: Bool
        /// skylight only: false fronts without the make-key record (the A/B's fallback recipe).
        let record: Bool
    }
    /// The backend this intent asks for; nil (absent, "legacy" or anything else) is today's legacy path.
    static func request(_ intent: [String: Any]) -> Request? {
        guard let name = intent["focusBackend"] as? String, let backend = Backend(rawValue: name) else { return nil }
        let flag: UInt32 = (intent["carbonFlag"] as? NSNumber)?.intValue == 1 ? 1 : 3
        return Request(backend: backend, carbonFlag: flag, reraise: intent["focusReraise"] as? Bool != false,
                       record: intent["focusRecord"] as? Bool != false)
    }

    /// `_SLPSSetFrontProcessWithOptions` mode for one window (kCPSUserGenerated). Never 0x100 (all windows) or 0x400.
    static let frontMode: UInt32 = 0x200
    static let recordSize = 0x100
    /// The parent's whole wait for the child, spawn included.
    static let childLimit = 0.3
    static let settleWindow = 1.0
    static let reraiseAfter = 0.150
    static let sampleSpacing = 0.02

    /// The make-key event record: 0x100 zeroed bytes; [0x04]=0xF8 (declared length); [0x08]=0x01 (left mouse down
    /// only, never a mouse-up); [0x20..0x2F] two Float64 300000.0 (a window-relative point far outside any view),
    /// copied as bytes; [0x3A]=0x10; [0x3C..0x3F] the window id as UInt32. Every other byte stays 0.
    static func keyRecord(wid: UInt32) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: recordSize)
        bytes[0x04] = 0xF8
        bytes[0x08] = 0x01
        let far: Float64 = 300000.0
        withUnsafeBytes(of: far) { raw in
            for (i, b) in raw.enumerated() { bytes[0x20 + i] = b; bytes[0x28 + i] = b }
        }
        bytes[0x3A] = 0x10
        withUnsafeBytes(of: wid) { raw in for (i, b) in raw.enumerated() { bytes[0x3C + i] = b } }
        return bytes
    }

    // Symbols. Private ones only by dlsym; a missing one selects legacy before any private call.
    typealias PSNFn = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias FrontFn = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UInt32, UInt32) -> Int32
    typealias PostFn = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<UInt8>) -> Int32
    typealias CarbonFrontFn = @convention(c) (UnsafePointer<ProcessSerialNumber>, UInt32) -> OSStatus
    struct SkyLight { let psn: PSNFn; let front: FrontFn; let post: PostFn }
    struct CarbonFront { let psn: PSNFn; let front: CarbonFrontFn }
    static let skyLightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    /// RTLD_DEFAULT for public symbols; the SkyLight image for the two private ones.
    static func find(_ name: String) -> UnsafeMutableRawPointer? {
        if name.hasPrefix("_SLPS") || name.hasPrefix("SLPS") {
            guard let image = dlopen(skyLightPath, RTLD_LAZY) else { return nil }
            return dlsym(image, name)
        }
        return dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)
    }
    static func skyLight(_ lookup: (String) -> UnsafeMutableRawPointer? = find) -> SkyLight? {
        guard let psn = lookup("GetProcessForPID"), let front = lookup("_SLPSSetFrontProcessWithOptions"),
              let post = lookup("SLPSPostEventRecordTo") else { return nil }
        return SkyLight(psn: unsafeBitCast(psn, to: PSNFn.self), front: unsafeBitCast(front, to: FrontFn.self),
                        post: unsafeBitCast(post, to: PostFn.self))
    }
    static func carbonFront(_ lookup: (String) -> UnsafeMutableRawPointer? = find) -> CarbonFront? {
        guard let psn = lookup("GetProcessForPID"), let front = lookup("SetFrontProcessWithOptions") else { return nil }
        return CarbonFront(psn: unsafeBitCast(psn, to: PSNFn.self), front: unsafeBitCast(front, to: CarbonFrontFn.self))
    }
    /// `cgevent trust` (doctor) and the probe's --check: presence only, nothing called.
    static func symbolReport(_ lookup: (String) -> UnsafeMutableRawPointer? = find) -> [String: Any] {
        var r: [String: Any] = [:]
        for name in ["GetProcessForPID", "_SLPSSetFrontProcessWithOptions", "SLPSPostEventRecordTo", "SetFrontProcessWithOptions"] {
            r[name] = lookup(name) != nil
        }
        r["skylight"] = skyLight(lookup) != nil; r["carbon"] = carbonFront(lookup) != nil
        return r
    }
    /// This process's own executable: the child is the same binary.
    static func childExecutable() -> String? {
        guard let path = Bundle.main.executableURL?.resolvingSymlinksInPath().path, FileManager.default.isExecutableFile(atPath: path) else { return nil }
        return path
    }

    // MARK: child mode (`cgevent focus-front --pid P --wid W [--no-record]`)
    /// The child's whole sequence over its three calls (production: the dlsym'd symbols; tests: counters).
    /// Exit 2: nothing private entered (usage, symbols, GetProcessForPID). Exit 3: the front call returned a CGError;
    /// no record is posted. Exit 0: front landed and the one record was accepted (or not requested). Exit 4: front
    /// landed, the record was refused. The record is posted at most once and never followed by a mouse-up.
    struct ChildCalls {
        var psn: (pid_t, inout ProcessSerialNumber) -> OSStatus
        var front: (inout ProcessSerialNumber, UInt32, UInt32) -> Int32
        var post: (inout ProcessSerialNumber, UnsafeMutablePointer<UInt8>) -> Int32
    }
    static func childSequence(pid: pid_t, wid: UInt32, record: Bool, calls: ChildCalls) -> [String: Any] {
        var reply: [String: Any] = ["focusFront": 1, "pid": Int(pid), "wid": Int(wid)]
        var psn = ProcessSerialNumber()
        let status = calls.psn(pid, &psn)
        guard status == noErr else { reply["exit"] = 2; reply["stage"] = "psn"; reply["psnStatus"] = Int(status); return reply }
        let front = calls.front(&psn, wid, frontMode)
        reply["frontStatus"] = Int(front)
        guard front == 0 else { reply["exit"] = 3; return reply }
        guard record else { reply["exit"] = 0; reply["posted"] = false; return reply }
        var bytes = keyRecord(wid: wid)
        let post = bytes.withUnsafeMutableBufferPointer { calls.post(&psn, $0.baseAddress!) }
        reply["posted"] = true; reply["postStatus"] = Int(post); reply["exit"] = post == 0 ? 0 : 4
        return reply
    }
    static func childMain(_ args: [String]) -> Never {
        func finish(_ reply: [String: Any]) -> Never {
            if let data = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
            }
            exit(Int32(reply["exit"] as? Int ?? 2))
        }
        var pid: pid_t = 0, wid: UInt32 = 0, record = true, i = 1
        while i < args.count {
            if args[i] == "--pid", i + 1 < args.count, let v = Int32(args[i + 1]), v > 0 { pid = v; i += 2; continue }
            if args[i] == "--wid", i + 1 < args.count, let v = UInt32(args[i + 1]), v > 0 { wid = v; i += 2; continue }
            if args[i] == "--no-record" { record = false; i += 1; continue }
            finish(["focusFront": 1, "exit": 2, "stage": "usage"])
        }
        guard pid > 0, wid > 0 else { finish(["focusFront": 1, "exit": 2, "stage": "usage"]) }
        // The helper's own state during a takeover: an accessory NSApplication (no Dock icon, never active).
        NSApplication.shared.setActivationPolicy(.accessory)
        guard let s = skyLight() else { finish(["focusFront": 1, "exit": 2, "stage": "symbols", "pid": Int(pid), "wid": Int(wid)]) }
        finish(childSequence(pid: pid, wid: wid, record: record, calls: ChildCalls(
            psn: { pid, psn in s.psn(pid, &psn) },
            front: { psn, wid, mode in s.front(&psn, wid, mode) },
            post: { psn, bytes in s.post(&psn, bytes) })))
    }

    // MARK: parent side of the child
    struct ChildResult {
        /// posted | front_only | post_refused | front_error | signal | timeout | malformed | spawn_failed
        let kind: String
        let ms: Double
        var exitCode: Int32? = nil
        var signal: Int32? = nil
        var frontStatus: Int? = nil
        var postStatus: Int? = nil
        /// Only posted / front_only / post_refused mean the front call returned success.
        var landed: Bool { ["posted", "front_only", "post_refused"].contains(kind) }
        /// A child that died, hung, or answered outside the protocol: Node pins the server to legacy.
        var breaks: Bool { ["signal", "timeout", "malformed", "spawn_failed"].contains(kind) }
    }
    /// The reply must be one JSON object that agrees with the exit status and echoes this pid and window.
    static func classify(code: Int32, output: Data, pid: pid_t, wid: UInt32, ms: Double) -> ChildResult {
        let text = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains("\n"), output.count <= 4096,
              let reply = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              reply["focusFront"] as? Int == 1, reply["exit"] as? Int == Int(code),
              reply["pid"] as? Int == Int(pid), reply["wid"] as? Int == Int(wid) else {
            return ChildResult(kind: "malformed", ms: ms, exitCode: code)
        }
        let front = reply["frontStatus"] as? Int, post = reply["postStatus"] as? Int, posted = reply["posted"] as? Bool
        switch code {
        case 0 where front == 0 && posted == true && post == 0:
            return ChildResult(kind: "posted", ms: ms, exitCode: code, frontStatus: front, postStatus: post)
        case 0 where front == 0 && posted == false && post == nil:
            return ChildResult(kind: "front_only", ms: ms, exitCode: code, frontStatus: front)
        case 4 where front == 0 && posted == true && post != nil && post != 0:
            return ChildResult(kind: "post_refused", ms: ms, exitCode: code, frontStatus: front, postStatus: post)
        case 3 where front != nil && front != 0 && posted == nil:
            return ChildResult(kind: "front_error", ms: ms, exitCode: code, frontStatus: front)
        default:
            return ChildResult(kind: "malformed", ms: ms, exitCode: code)
        }
    }
    /// Spawn, wait at most `limit` (spawn included), SIGKILL and reap on overrun. Nothing outlives this call:
    /// the child is always reaped before it returns. `service` runs between polls (production: the run loop, 1 ms).
    /// After SIGKILL the child is reaped with WNOHANG for at most this long; one that is still not reaped goes to a
    /// background reaper, so the whole call stays within limit + reapLimit (r2 item 6).
    static let reapLimit = 0.1
    static func backgroundReap(_ child: pid_t) {
        Thread.detachNewThread { var status: Int32 = 0; while waitpid(child, &status, 0) == -1 && errno == EINTR {} }
    }
    static func runChild(executable: String, arguments: [String], pid: pid_t, wid: UInt32, limit: Double = childLimit,
                         now: () -> Double = { ProcessInfo.processInfo.systemUptime }, service: () -> Void,
                         wait: (pid_t, UnsafeMutablePointer<Int32>, Int32) -> pid_t = { waitpid($0, $1, $2) },
                         reaper: (pid_t) -> Void = Focus.backgroundReap) -> ChildResult {
        let start = now()
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { return ChildResult(kind: "spawn_failed", ms: 0) }
        var actions: posix_spawn_file_actions_t? = nil, attributes: posix_spawnattr_t? = nil
        posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        // Only these three descriptors reach the child: never the helper's own JSON-lines pipes.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, fds[1], 1)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
        defer { for p in argv { free(p) } }
        var child: pid_t = 0
        let spawned = posix_spawn(&child, executable, &actions, &attributes, argv, environ)
        close(fds[1])
        guard spawned == 0, child > 0 else { close(fds[0]); return ChildResult(kind: "spawn_failed", ms: (now() - start) * 1000) }
        var status: Int32 = 0, timedOut = false
        while true {
            let r = wait(child, &status, WNOHANG)
            if r == child { break }
            if r == -1 && errno != EINTR { close(fds[0]); return ChildResult(kind: "malformed", ms: (now() - start) * 1000) }
            if now() - start >= limit {
                kill(child, SIGKILL)
                let killed = now()
                var reaped = false
                while now() - killed < reapLimit {
                    let r = wait(child, &status, WNOHANG)
                    if r == child || (r == -1 && errno != EINTR) { reaped = true; break }
                    usleep(1000)
                }
                if !reaped { reaper(child) }
                timedOut = true; break
            }
            service()
        }
        // What the reaped child wrote is already in the pipe; never wait on another holder of its write end.
        _ = fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK)
        var output = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while output.count <= 4096 {
            let n = read(fds[0], &buffer, buffer.count)
            if n > 0 { output.append(contentsOf: buffer[0..<n]) } else if n < 0 && errno == EINTR { continue } else { break }
        }
        close(fds[0])
        let ms = (now() - start) * 1000
        if timedOut { return ChildResult(kind: "timeout", ms: ms) }
        // WIFSIGNALED / WEXITSTATUS (macros Swift does not import).
        let low = status & 0x7f
        if low != 0 && low != 0x7f { return ChildResult(kind: "signal", ms: ms, signal: low) }
        guard low == 0 else { return ChildResult(kind: "malformed", ms: ms) }
        return classify(code: (status >> 8) & 0xff, output: output, pid: pid, wid: wid, ms: ms)
    }

    // MARK: foreign coverage (separate from focusOrder, whose semantics stay unchanged)
    enum Coverage: String { case none, normal, floating }
    /// One front-to-back on-screen CG list. Windows above the target that belong to another process (never this
    /// helper's own veil), layer 0...19, alpha > 0.05, at least 2×2, named, not the Window Server, and overlapping the
    /// target with a non-empty area. Any floating one (layer 1...19) wins: the repair is never for a floating blocker.
    static func coverage(_ rows: [[String: Any]], pid: Int, cg: Int, ownPid: Int) -> Coverage {
        func rect(_ row: [String: Any]) -> CGRect? {
            (row[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
        }
        guard let target = rows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowNumber as String] as? Int) == cg }).flatMap(rect) else {
            return .none
        }
        var normal = false
        for row in rows {
            let owner = row[kCGWindowOwnerPID as String] as? Int ?? 0, layer = row[kCGWindowLayer as String] as? Int ?? -1
            if owner == pid && (row[kCGWindowNumber as String] as? Int) == cg { break }
            guard owner != pid, owner != ownPid, layer >= 0, layer <= 19, let box = rect(row), box.width >= 2, box.height >= 2,
                  (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let name = row[kCGWindowOwnerName as String] as? String, !name.isEmpty, name != "Window Server" else { continue }
            let overlap = box.intersection(target)
            guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { continue }
            if layer > 0 { return .floating }
            normal = true
        }
        return normal ? .normal : .none
    }

    // MARK: the sequence (production binds Owner methods; tests bind fakes)
    struct WindowFacts { var onScreen: Bool; var owner: Int?; var layer: Int?; var axMatches: Int }
    typealias Sample = (Bool, Bool, Int, [String: Any])
    struct Effects {
        var now: () -> Double
        var chromePid: Int
        var tabId: Int
        /// Preflight, read-only and in this order; the first that fails names the fallback.
        var symbols: (Backend) -> Bool
        var tabBound: () throws -> Bool
        var window: () throws -> WindowFacts
        var mode: () -> String?
        var psn: () -> Bool
        /// Each prepare is read-only and returns the one primitive its write stage enters.
        var prepareMain: () throws -> () throws -> Void
        var prepareRaise: (String) throws -> () throws -> Void
        var prepareChild: (Request) -> () -> ChildResult
        var prepareCarbon: (UInt32) throws -> () throws -> Void
        /// Read-only after the writes.
        var finalVerify: () throws -> WindowRow
        var sample: (Double) throws -> Sample
        var coverage: (Double) throws -> Coverage
        var tabActive: (Double) throws -> Bool
        var pause: (Double) throws -> Void
        /// FOCUS4 amendment A: the front app now (read-only), and Chrome's `activate` Apple Event (one write).
        var frontIsChrome: () -> Bool
        var appleActivate: () throws -> Void
    }
    /// FOCUS4 amendment A: the read-only window after the Apple Event activate (as Owner.appleFront).
    static let appleSettleWindow = 0.7
    /// nil: fall back to legacy (tx.facts names why; FOCUS4: legacy's AX assistance is optional); nothing private was
    /// called. Otherwise the completed activation with its facts; a wrong active tab throws activate_unconfirmed, as legacy.
    static func drive(_ request: Request, _ fx: Effects, tx: Transaction) throws -> (after: WindowRow, focus: Sample, facts: [String: Any])? {
        func fallback(_ reason: String) -> (after: WindowRow, focus: Sample, facts: [String: Any])? {
            tx.facts = ["focusDriver": "legacy", "focusRequested": request.backend.rawValue, "focusFallback": reason]
            return nil
        }
        guard fx.symbols(request.backend) else { return fallback("symbols_missing") }
        guard try fx.tabBound() else { return fallback("tab_unbound") }
        let w = try fx.window()
        guard w.onScreen else { return fallback("off_screen") }
        guard w.owner == fx.chromePid else { return fallback("owner") }
        guard w.layer == 0 else { return fallback("layer") }
        guard w.axMatches == 1 else { return fallback("ax_window") }
        guard let mode = fx.mode() else { return fallback("mode_unknown") }
        guard mode == "normal" else { return fallback("mode_not_normal") }
        guard fx.psn() else { return fallback("psn") }

        var facts: [String: Any] = ["focusDriver": request.backend.rawValue]
        tx.facts = facts
        let t0: Double
        switch request.backend {
        case .skylight:
            let child = fx.prepareChild(request)
            t0 = fx.now()
            try tx.write("activate_front_key") {
                let r = child()
                facts["focusChild"] = r.kind; facts["tSpawnMs"] = Int(r.ms.rounded())
                tx.facts = facts
                guard r.landed else {
                    // Entered and not confirmed: unknown, noRetry, the transaction ends here.
                    var details: [String: Any] = facts
                    if let s = r.frontStatus { details["focusFrontStatus"] = s }
                    if let s = r.signal { details["focusChildSignal"] = Int(s) }
                    throw Failure("native_write_unknown", "activate_front_key", details: details)
                }
            }
        case .carbon:
            let main = try fx.prepareMain()
            try tx.write("activate_main") { try main() }
            let front = try fx.prepareCarbon(request.carbonFlag)
            t0 = fx.now()
            try tx.write("activate_front") { try front() }
        }
        // The landed point: the child's front call returned success, or activate_front was entered.
        let (after, settled, apple) = try afterLanding(tx, facts) { () throws -> (WindowRow, (focus: Sample, facts: [String: Any]), Bool) in
            let raise = try fx.prepareRaise("activate_raise")
            try tx.write("activate_raise") { try raise() }
            let after = try fx.finalVerify()
            let first = try settle(fx, t0: t0, deadline: t0 + settleWindow, reraise: request.backend == .skylight && request.reraise, tx: tx)
            // FOCUS4 amendment A (user decision 3): Chrome still not the frontmost app: the Apple Event activate once, then
            // the facts are read again (no repair); inside the landed unit, so an error there is unknown + noRetry.
            if fx.frontIsChrome() { return (after, first, false) }
            try fx.appleActivate()
            let t1 = fx.now()
            let again = try settle(fx, t0: t1, deadline: t1 + appleSettleWindow, reraise: false, tx: tx)
            return (after, (again.focus, first.facts), true)
        }
        if apple { facts["focusAppleActivate"] = true }
        facts.merge(settled.facts) { _, new in new }
        tx.facts = facts
        // FOCUS4 (G-b): as legacy, only the bound tab's being active is a verdict; order and the AX key window are facts.
        if after.activeTab != fx.tabId {
            throw Failure("activate_unconfirmed", "activate_verify", details: settled.focus.3.merging(facts) { first, _ in first }
                .merging(["axWindowMissing": false, "focusVerdict": "tab_not_current"]) { first, _ in first })
        }
        return (after, settled.focus, facts)
    }
    /// r2 item 5: everything after the landed point is one unit. Any error from it (preparing or writing the raise,
    /// the final verify, the settle and its repair) ends the transaction as unknown and noRetry: a Failure or a probe
    /// cut becomes native_write_unknown with the original code and stage in its details. A Stop (the session's own
    /// typed error, e.g. Esc twice) keeps its identity so the agent still sees the user's stop, and the ledger is
    /// marked unknown all the same. activate_unconfirmed is decided after this unit and is not converted.
    static func afterLanding<T>(_ tx: Transaction, _ facts: [String: Any], _ body: () throws -> T) throws -> T {
        do { return try body() }
        catch let f as Failure {
            tx.markUnresolved()
            var details = facts; details["focusOriginalError"] = f.code; details["focusOriginalStage"] = f.stage
            if let status = f.osStatus { details["focusOriginalOsStatus"] = status }
            throw Failure("native_write_unknown", f.stage, details: details)
        } catch let f as DialogFailure {
            tx.markUnresolved()
            var details = facts; details["focusOriginalError"] = f.code; details["focusOriginalStage"] = f.stage
            throw Failure("native_write_unknown", f.stage, details: details)
        } catch {
            tx.markUnresolved()
            throw error
        }
    }
    /// Read-only settle, as Owner.settleFocus: 20 ms spacing, one absolute deadline, a sample cut by it is dropped,
    /// and a complete passing sample (Chrome order, focusOrder unchanged; FOCUS4: the AX key window is a fact, never
    /// waited for, so it is no longer part of "passing") ends it. With the repair enabled, a
    /// passing sample that a foreign layer-0 window still covers keeps the settle open until the first complete
    /// sample at ≥ 150 ms; there, if Chrome is front, the target is key, the tab is right and that coverage is still
    /// there, all four are read again and one AXRaise (activate_reraise) is written. Never a second one, never for a
    /// floating blocker, never anything but AXRaise.
    static func settle(_ fx: Effects, t0: Double, deadline: Double, reraise: Bool, tx: Transaction) throws -> (focus: Sample, facts: [String: Any]) {
        var last: Sample?, samples = 0, decided = !reraise, reraised = false
        var tKey: Double?, tFront: Double?, tTop: Double?
        func ms(_ v: Double?) -> Any { v.map { Int(($0 * 1000).rounded()) } ?? NSNull() }
        func facts() -> [String: Any] {
            var f: [String: Any] = ["tKeyMs": ms(tKey), "tFrontMs": ms(tFront), "tTopMs": ms(tTop)]
            if reraise { f["focusReraised"] = reraised }
            return f
        }
        func note(_ s: Sample) {
            let at = fx.now() - t0
            if s.2 == fx.chromePid && tFront == nil { tFront = at }
            if s.1 && tKey == nil { tKey = at }
            if s.0 && tTop == nil { tTop = at }
        }
        func cut(_ error: Error) -> Bool {
            (error as? DialogFailure).map { $0.code == "dialog_probe_unknown" && $0.stage == "native_read_deadline" } == true
        }
        /// The four facts, read as they stand now. A coverage read cut by the deadline counts as no coverage.
        func repairs(_ s: Sample) throws -> Bool {
            guard s.2 == fx.chromePid, s.1 else { return false }
            let covered: Coverage
            do { covered = try fx.coverage(deadline) } catch where cut(error) { return false }
            return try covered == .normal && fx.tabActive(deadline)
        }
        while fx.now() < deadline {
            var s: Sample
            do { s = try fx.sample(deadline) } catch where cut(error) { break }
            last = s; samples += 1; note(s)
            if !decided {
                if fx.now() - t0 >= reraiseAfter {
                    // The first complete sample at or after 150 ms decides, once.
                    decided = true
                    if try repairs(s) {
                        do { s = try fx.sample(deadline) } catch where cut(error) { break }
                        last = s; samples += 1; note(s)
                        if try repairs(s) {
                            let raise = try fx.prepareRaise("activate_reraise")
                            try tx.write("activate_reraise") { try raise() }
                            reraised = true
                            try fx.pause(min(fx.now() + sampleSpacing, deadline))
                            continue
                        }
                    }
                } else if s.0 {
                    let covered: Coverage
                    do { covered = try fx.coverage(deadline) } catch where cut(error) { covered = .none }
                    if covered == .normal {
                        try fx.pause(min(fx.now() + sampleSpacing, deadline))
                        continue
                    }
                }
            }
            if s.0 { var d = s; d.3["focusSamples"] = samples; return (d, facts()) }
            try fx.pause(min(fx.now() + sampleSpacing, deadline))
        }
        var decidedSample = last ?? (false, false, 0, ["focusSettleExpired": true])
        decidedSample.3["focusSamples"] = samples
        return (decidedSample, facts())
    }
}
}

extension ChromeNative.Owner {
    /// FOCUS2: the only entry, from Owner.execute's `activate` case inside `#if MYCHROME_FOCUS_BACKENDS`. nil = the
    /// legacy steps below that block run unchanged (no backend asked for, or the read-only preflight fell back).
    func activateBackend(_ t: ChromeNative.Target, before row: ChromeNative.WindowRow, intent: [String: Any],
                         plan: ChromeNative.WindowGeometryPlan?, tx: ChromeNative.Transaction) throws -> [String: Any]? {
        typealias Focus = ChromeNative.Focus
        typealias Failure = ChromeNative.Failure
        guard let request = Focus.request(intent) else { return nil }
        let pid = t.chromePid
        let now = { ProcessInfo.processInfo.systemUptime }
        func exactPrimitive(_ stage: String, _ write: @escaping (AXUIElement) -> AXError) throws -> () throws -> Void {
            let p = probe(), exact = try exactWindow(t, access: p)
            guard ApplicationServices.AXUIElementSetMessagingTimeout(exact, 0.05) == .success else { throw Failure("native_target_unknown", stage) }
            return {
                let status = write(exact)
                guard status == .success else { throw Failure("native_write_unknown", stage, osStatus: Int(status.rawValue)) }
            }
        }
        let fx = Focus.Effects(
            now: now, chromePid: Int(pid), tabId: t.tabId,
            symbols: { backend in backend == .skylight ? Focus.skyLight() != nil && Focus.childExecutable() != nil : Focus.carbonFront() != nil },
            tabBound: { [unowned self] in try self.verifyAfterWrite(tx) { try self.verify(t, until: $0) }.activeTab == t.tabId },
            window: { [unowned self] in
                let p = self.probe()
                let rows = p.CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
                try p.check()
                let row = rows?.first { ($0[kCGWindowNumber as String] as? Int) == t.cgWindow }
                let matches = p.axWindows(pid: pid).filter { p.axWindowNumber($0) == t.cgWindow }.count
                try p.check()
                return Focus.WindowFacts(onScreen: row != nil, owner: row?[kCGWindowOwnerPID as String] as? Int,
                                         layer: row?[kCGWindowLayer as String] as? Int, axMatches: matches)
            },
            mode: { [unowned self] in self.windowMode(t) },
            psn: {
                var psn = ProcessSerialNumber()
                guard let f = request.backend == .skylight ? Focus.skyLight()?.psn : Focus.carbonFront()?.psn else { return false }
                return f(pid, &psn) == noErr
            },
            prepareMain: { try exactPrimitive("activate_main") { AXUIElementSetAttributeValue($0, kAXMainAttribute as CFString, kCFBooleanTrue) } },
            prepareRaise: { stage in try exactPrimitive(stage) { AXUIElementPerformAction($0, kAXRaiseAction as CFString) } },
            prepareChild: { request in
                let exe = Focus.childExecutable() ?? "/nonexistent"
                let args = ["focus-front", "--pid", String(pid), "--wid", String(t.cgWindow)] + (request.record ? [] : ["--no-record"])
                return { Focus.runChild(executable: exe, arguments: args, pid: pid, wid: UInt32(truncatingIfNeeded: t.cgWindow),
                                        service: { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.001)) }) }
            },
            prepareCarbon: { flag in
                guard let c = Focus.carbonFront() else { throw Failure("native_target_unknown", "activate_front") }
                var psn = ProcessSerialNumber()
                guard c.psn(pid, &psn) == noErr else { throw Failure("native_target_unknown", "activate_front") }
                let target = psn
                return {
                    let status = withUnsafePointer(to: target) { c.front($0, flag) }
                    guard status == noErr else { throw Failure("native_write_unknown", "activate_front", osStatus: Int(status)) }
                }
            },
            finalVerify: { [unowned self] in
                if let plan { return try self.verifyAfterWrite(tx) { try self.verifyWindowGeometry(t, plan: plan, tx: tx, until: $0) } }
                return try self.verifyAfterWrite(tx) { try self.verify(t, until: $0) }
            },
            sample: { [unowned self] deadline in try self.focus(t, until: deadline) },
            coverage: { [unowned self] deadline in
                let p = self.probe(until: deadline)
                let rows = p.CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
                try p.check()
                return rows.map { Focus.coverage($0, pid: Int(pid), cg: t.cgWindow, ownPid: Int(getpid())) } ?? .none
            },
            tabActive: { [unowned self] deadline in
                // A failed read only withholds the repair; Stop stays sticky and the next sample surfaces it.
                do { return try self.verify(t, until: deadline).activeTab == t.tabId } catch is Failure { return false } catch is ChromeNative.DialogFailure { return false }
            },
            pause: { [unowned self] until in
                while ProcessInfo.processInfo.systemUptime < until { try self.pump(); try self.requireAlive("native_focus_read") }
            },
            frontIsChrome: { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid },
            appleActivate: { [unowned self] in try self.appleActivate(t, tx: tx) })
        guard let done = try Focus.drive(request, fx, tx: tx) else { return nil }
        // PERM1: as legacy, after the verdict (Focus.drive refused a wrong active tab).
        let (focus, popup) = try clearChromePrompt(t, done.focus, tx: tx)
        // As the legacy tail; Transaction.result adds tx.facts (driver, child outcome, timings).
        var facts: [String: Any] = popup.merging(["axWindowMissing": false]) { first, _ in first }   // the preflight required the exact AX window
        for key in ["focusBlocker", "focusSamples", "focusSettleExpired"] { if let value = focus.3[key] { facts[key] = value } }
        return resultTarget(t, done.after).merging(["ok": true, "changed": row.activeTab != done.after.activeTab,
            "frontmost": NSWorkspace.shared.frontmostApplication?.localizedName ?? "", "frontmostPid": focus.2, "waitedMs": 0,
            "targetOnTop": focus.0, "keyWindowIsTarget": focus.1,
            "frontmostChanged": false, "prevFrontPutBack": false].merging(facts) { first, _ in first }) { _, new in new }
    }
    /// Chrome's own `mode` of this window ("normal" or "incognito"), one read-only Apple Event (getd), 50 ms.
    /// nil when it cannot be read; the preflight then keeps legacy.
    func windowMode(_ t: ChromeNative.Target) -> String? {
        guard let window = try? object("cwin", id: t.windowId),
              let key = try? specifier("prop", form: "prop", key: NSAppleEventDescriptor(typeCode: Self.code("mode")), container: window) else { return nil }
        let e = event(t.chromePid, id: "getd")
        e.setParam(key, forKeyword: Self.code("----"))
        guard let reply = try? e.sendEvent(options: [.waitForReply, .neverInteract], timeout: 0.05) else { return nil }
        if let error = reply.paramDescriptor(forKeyword: Self.code("errn")), error.int32Value != 0 { return nil }
        return reply.paramDescriptor(forKeyword: Self.code("----"))?.stringValue
    }
}

// MARK: - ScriptingBridge boundary (CRASH1)
// Swift cannot catch an Objective-C exception. One thrown inside ScriptingBridge aborted the whole helper
// (REL-T2, 2026-11-03: NSUnknownKeyException from -[SBObject valueForKey:] for "windows", on an SBApplication
// that ScriptingBridge had made without Chrome's scripting definition). These classes are the only code that
// holds ScriptingBridge's own objects: each method sends exactly one message through the @try shim that
// scripts/build-native.sh compiles in (objc-try.h) and turns a caught exception into SBException.
// Inside ChromeNative their names shadow ScriptingBridge's classes on purpose, so readSnapshot keeps its shape;
// chromectl.swift's top-level boundary wraps these. test/sb-boundary.test.mjs keeps every other line of the
// helpers away from ScriptingBridge's classes.
extension ChromeNative {
struct SBException: Error, CustomNSError {
    enum Operation: String { case application, delegate, timeout, value, object_id, object_index, count, perform }
    /// The exception's name, an identifier such as NSUnknownKeyException; never its reason or userInfo.
    let name: String
    let operation: Operation
    /// The KVC key or selector from this source, never a value read from Chrome.
    let key: String
    init(_ caught: NSString?, _ operation: Operation, _ key: String) {
        let text = (caught as String?) ?? "", bytes = Array(text.utf8)
        func letter(_ c: UInt8) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 }
        let valid = !bytes.isEmpty && bytes.count <= 64 && letter(bytes[0]) && bytes.allSatisfy { letter($0) || ($0 >= 48 && $0 <= 57) }
        name = valid ? text : "unnamed_exception"
        self.operation = operation; self.key = key
    }
    static var errorDomain: String { "MyChromeScriptingBridgeException" }
    var errorUserInfo: [String: Any] { ["exceptionName": name, "sbOperation": operation.rawValue, "sbKey": key] }
}
/// A result keeps its ScriptingBridge object references inside the boundary.
static func sbWrap(_ value: Any?) -> Any? {
    if let array = value as? ScriptingBridge.SBElementArray { return SBElementArray(array) }
    if let object = value as? ScriptingBridge.SBObject { return SBObject(object) }
    return value
}
final class SBApplication {
    private let raw: ScriptingBridge.SBApplication?
    /// An exception while making or configuring the application object; its first read throws it.
    private var pending: SBException?
    private var assignedDelegate: SBApplicationDelegate?
    private var assignedTimeout = 0
    /// nil only when ScriptingBridge itself returns no object, as before.
    init?(processIdentifier pid: pid_t) {
        var caught: NSString?
        let app = MyChromeSBApplication(pid, &caught)
        if caught != nil { raw = nil; pending = SBException(caught, .application, "application") }
        else if let app { raw = app }
        else { return nil }
    }
    var delegate: SBApplicationDelegate? {
        get { assignedDelegate }
        set {
            assignedDelegate = newValue
            guard let raw, pending == nil else { return }
            var caught: NSString?
            if !MyChromeSBSetDelegate(raw, newValue, &caught) { pending = SBException(caught, .delegate, "delegate") }
        }
    }
    var timeout: Int {
        get { assignedTimeout }
        set {
            assignedTimeout = newValue
            guard let raw, pending == nil else { return }
            var caught: NSString?
            if !MyChromeSBSetTimeout(raw, newValue, &caught) { pending = SBException(caught, .timeout, "timeout") }
        }
    }
    func value(forKey key: String) throws -> Any? {
        if let pending { throw pending }
        guard let raw else { throw SBException(nil, .value, key) }
        var caught: NSString?
        let value = MyChromeSBValueForKey(raw, key, &caught)
        if caught != nil { throw SBException(caught, .value, key) }
        return ChromeNative.sbWrap(value)
    }
}
final class SBObject {
    private let raw: ScriptingBridge.SBObject
    init(_ raw: ScriptingBridge.SBObject) { self.raw = raw }
    func value(forKey key: String) throws -> Any? {
        var caught: NSString?
        let value = MyChromeSBValueForKey(raw, key, &caught)
        if caught != nil { throw SBException(caught, .value, key) }
        return ChromeNative.sbWrap(value)
    }
    /// One scripting command (chromectl eval: executeJavascript:). An exception may follow its delivery:
    /// the caller treats the command as possibly run and never sends it again.
    func perform(_ selector: Selector, with argument: Any?) throws -> Any? {
        var caught: NSString?
        let value = MyChromeSBPerform(raw, selector, argument, &caught)
        if caught != nil { throw SBException(caught, .perform, NSStringFromSelector(selector)) }
        return value
    }
}
final class SBElementArray {
    private let raw: ScriptingBridge.SBElementArray
    init(_ raw: ScriptingBridge.SBElementArray) { self.raw = raw }
    func value(forKey key: String) throws -> Any? {
        var caught: NSString?
        let value = MyChromeSBValueForKey(raw, key, &caught)
        if caught != nil { throw SBException(caught, .value, key) }
        return ChromeNative.sbWrap(value)
    }
    func object(withID identifier: Any) throws -> Any? {
        var caught: NSString?
        let value = MyChromeSBObjectWithID(raw, identifier, &caught)
        if caught != nil { throw SBException(caught, .object_id, "id") }
        return ChromeNative.sbWrap(value)
    }
    func object(at index: Int) throws -> Any? {
        var caught: NSString?
        let value = MyChromeSBObjectAtIndex(raw, UInt(bitPattern: index), &caught)
        if caught != nil { throw SBException(caught, .object_index, "index") }
        return ChromeNative.sbWrap(value)
    }
    var count: Int {
        get throws {
            var caught: NSString?
            let value = MyChromeSBCount(raw, &caught)
            if caught != nil { throw SBException(caught, .count, "count") }
            return value
        }
    }
}
}
