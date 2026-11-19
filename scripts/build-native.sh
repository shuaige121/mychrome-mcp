#!/bin/sh
# Build only the two native input/read helpers. Never install or rebuild cbmenu.
set -eu

native_root=$(cd "$(dirname "$0")/.." && pwd)
native_compiler=${MYCHROME_SWIFTC:-$(/usr/bin/xcrun --find swiftc)}
native_target=arm64-apple-macos13
native_sdk=$(/usr/bin/xcrun --show-sdk-path)
mkdir -p "$native_root/bin"
native_build=$(mktemp -d "$native_root/bin/.native-build.XXXXXX")
cleanup_native_build() {
  # Only this invocation's known build outputs, never a checkout-wide cleanup.
  rm -f "$native_build/cgevent/main.swift" "$native_build/chromectl/main.swift" \
    "$native_build/cgevent/output" "$native_build/chromectl/output" "$native_build/objc-try.h"
  rmdir "$native_build/cgevent" "$native_build/chromectl" "$native_build" 2>/dev/null || true
}
trap cleanup_native_build EXIT HUP INT TERM
mkdir "$native_build/cgevent" "$native_build/chromectl"
cp "$native_root/src/helper.swift" "$native_build/cgevent/main.swift"
cp "$native_root/src/chromectl.swift" "$native_build/chromectl/main.swift"

# The Objective-C exception boundary for ScriptingBridge (CRASH1). Swift cannot catch an
# Objective-C exception, so one thrown inside ScriptingBridge aborted the whole helper.
# native-chrome.swift sends every ScriptingBridge message through exactly one of these
# functions. Each sends one message inside @try; a caught exception returns nil (or -1/NO)
# and keeps only the exception's name, never its reason or userInfo. It lives here, not in
# src/, so every checkout or release that can run this script also has the shim.
cat > "$native_build/objc-try.h" <<'OBJC_TRY'
#import <Foundation/Foundation.h>
#import <ScriptingBridge/ScriptingBridge.h>
NS_ASSUME_NONNULL_BEGIN
static inline void MyChromeSBCaught(id thrown, NSString * _Nullable * _Nonnull name) {
    *name = [thrown isKindOfClass:[NSException class]] ? (((NSException *)thrown).name ?: @"") : @"non_exception_object";
}
static inline SBApplication * _Nullable MyChromeSBApplication(pid_t pid, NSString * _Nullable * _Nonnull name) {
    @try { return [SBApplication applicationWithProcessIdentifier:pid]; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }
}
static inline BOOL MyChromeSBSetDelegate(SBApplication *app, id<SBApplicationDelegate> _Nullable delegate, NSString * _Nullable * _Nonnull name) {
    @try { app.delegate = delegate; return YES; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return NO; }
}
static inline BOOL MyChromeSBSetTimeout(SBApplication *app, long ticks, NSString * _Nullable * _Nonnull name) {
    @try { app.timeout = ticks; return YES; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return NO; }
}
static inline id _Nullable MyChromeSBValueForKey(id object, NSString *key, NSString * _Nullable * _Nonnull name) {
    @try { return [object valueForKey:key]; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }
}
static inline id _Nullable MyChromeSBObjectWithID(SBElementArray *array, id identifier, NSString * _Nullable * _Nonnull name) {
    @try { return [array objectWithID:identifier]; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }
}
static inline id _Nullable MyChromeSBObjectAtIndex(SBElementArray *array, NSUInteger index, NSString * _Nullable * _Nonnull name) {
    @try { return [array objectAtIndex:index]; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }
}
static inline NSInteger MyChromeSBCount(SBElementArray *array, NSString * _Nullable * _Nonnull name) {
    @try { return (NSInteger)array.count; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return -1; }
}
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
static inline id _Nullable MyChromeSBPerform(id object, SEL selector, id _Nullable argument, NSString * _Nullable * _Nonnull name) {
    @try { return [object performSelector:selector withObject:argument]; }
    @catch (id thrown) { MyChromeSBCaught(thrown, name); return nil; }
}
#pragma clang diagnostic pop
NS_ASSUME_NONNULL_END
OBJC_TRY

# Executable top-level statements must live in main.swift in a multi-file build.
# MYCHROME_FOCUS_BACKENDS compiles FOCUS2's one entry in Owner.execute (the opt-in activation backends; legacy
# stays the default and runs unchanged). Test capsules that extract execute compile without it.
"$native_compiler" -sdk "$native_sdk" -D MYCHROME_FOCUS_BACKENDS -O -target "$native_target" -o "$native_build/cgevent/output" \
  -import-objc-header "$native_build/objc-try.h" "$native_build/cgevent/main.swift" "$native_root/src/native-chrome.swift"
"$native_compiler" -sdk "$native_sdk" -D MYCHROME_FOCUS_BACKENDS -O -target "$native_target" -o "$native_build/chromectl/output" \
  -import-objc-header "$native_build/objc-try.h" "$native_build/chromectl/main.swift" "$native_root/src/native-chrome.swift"

# Both compilations succeeded. Each rename stays on the target filesystem.
mv -f "$native_build/cgevent/output" "$native_root/bin/cgevent"
mv -f "$native_build/chromectl/output" "$native_root/bin/chromectl"
