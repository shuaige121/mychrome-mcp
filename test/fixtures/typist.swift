// Someone typing, for test/held-wait-live.mjs: right Option pressed and released every <gapMs> for
// <ms> (a lone Option types nothing in any app). Posted like hardware input, without MyChrome's tag,
// so the bridge sees it as the user's. Prints {"first": epochMs, "last": epochMs} when done.
import CoreGraphics
import Foundation
let a = CommandLine.arguments
let total = Double(a.count > 1 ? a[1] : "3000") ?? 3000, gap = Double(a.count > 2 ? a[2] : "250") ?? 250
func now() -> Double { Date().timeIntervalSince1970 * 1000 }
func opt(_ down: Bool) {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: 61, keyDown: down) else { return }
    e.type = .flagsChanged
    e.flags = down ? [.maskAlternate] : []
    e.post(tap: .cghidEventTap)
}
let t0 = now()
var last = t0
while now() - t0 < total {
    opt(true); usleep(60_000); opt(false)
    last = now()
    usleep(useconds_t(max(0, gap - 60) * 1000))
}
print("{\"first\": \(Int(t0)), \"last\": \(Int(last))}")
