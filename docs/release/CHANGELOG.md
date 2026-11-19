# Changelog

Release notes describe changes in this source tree. A source version, an npm publication, a GitHub push and a successful live test are separate events.

## 0.15.0 — 2026-11-07

### Claude Code conversations

In 0.15.0, a terminal Claude Code session connected to MyChrome appears as a read-only mirror of your prompts and Claude's reply text, from the moment it connects. During takeover, the sidebar shows Claude's reply text. Thinking, tool calls and tool results are not shown. Reply in the terminal; MyChrome never types into it. Mirror text stays in memory and is not written to logs or files.

The mirror is on by default. To turn it off, set `CHROME_BRIDGE_CLAUDE_FEED=0` in the MCP server's environment, or `"claudeFeed": false` in settings, and reconnect. Connection states distinguish browser tools only, an unavailable conversation record, a session open in several processes and a disabled mirror.

### Focus and the page you asked for

In 0.15.0, MyChrome brings Google Chrome forward before acting when it is not in front. It uses the pointer landing point and checks the page’s keyboard focus before every key, rather than depending on window-focus signals that can be missing. If it still cannot act, it returns quickly and says what was in front and whether anything was sent.

When you ask the assistant to work on a page you already have open or in your own Chrome, MyChrome's instructions direct it to that exact tab ahead of other browser tools. Reconnect the MCP client to receive the new instructions.

### A bounded wait for text recognition

In 0.15.0, if text recognition is slow, for example on first use, a screenshot returns about 8 seconds after recognition starts with the image and a note that the text was not ready. Background warm-up checks for ongoing input before starting and defers when it finds any. It runs at most once per 10-minute window across relays and never at server start. It does not hold the input lock or stop if input begins after warm-up has started.

### Page reading and result checks

In 0.15.0, page reading starts with headings and expands on request. Click replies separate confirmed page changes from unconfirmed input, and screenshots are limited to the verified webpage area.

### MyChrome in your language

In 0.15.0, MyChrome's windows and notifications follow your Mac's language (English or Chinese), with a Language setting under Settings in the menu bar panel. The takeover card and sidebar also follow that language. Language precedence is `CHROME_BRIDGE_UI_LANG` (`en` or `zh`), the older `CHROME_BRIDGE_LANG`, the Language setting, then the Mac's first preferred language (Chinese if it starts with `zh`, otherwise English). Agent-facing tool text and receipts do not change.

### Internal fixes and historical pre-release validation

The entries below retain their original development and validation context. Candidate installation statements describe those earlier runs, not the status of 0.15.0 on 2026-11-07. Page-prompt observation, Claude Channel notifications and automatic handling remain outside the release highlights: their live verification is not established here.

- Bind visible window/tab creation, native dialog answers, closing and field handoff preparation to the shared input lease and healthy native Session. Recheck Stop at native commit/restoration boundaries, retain exact owner/target identity and refuse uncertain replay.
- Preserve nested dialog controls inside clickable backdrops and aggregate containers, with bounded privacy and reachability checks. Remove automatic script-scroll fallback from input preparation; use bounded native scrolling or an explicit refusal.
- Add bounded passive observation of the current task's exact page. Terminal Claude Code Channel and next-tool fallback use separate receipt tokens; the first actually forwarded server initialize pins the Channel capability. No startup message, config rewrite or automatic trust acceptance.
- Add `page_event_ack` for receipt only. Transport writes remain unconfirmed until the same route/connection/worker/task acknowledges; uncertain sends do not trigger proactive duplicates.
- Add reviewed inactivity rules to both settings surfaces under the original shared lock. Rules are created disabled, default policy is notify, and full origin/template/button/semantic must agree. Malformed rules/catalog disable auto while preserving unrelated settings.
- Keep observation separate from input authority. Auto reuses the original healthy hold and Session, checks current exact target/origin/full template and retained node/dialog identity, and permits one attempt without reacquisition, activation, scrolling or replay. Unknown native probes never fall through to DOM; truncated native display prefixes cannot authorize auto. Native FEFF templates refuse because the helper's ordinary Foundation JSON parser cannot preserve that boundary.
- Package the shared catalog and DOM observer and include both in matching source fingerprints. Only synthetic localhost templates exist; the native catalog's custom title/buttons are offline AX fixtures, not verified Chrome confirm or real MCF support.
- Preserve bounded ordinary MCP error code, stage and delivery claims through the existing privacy boundary and synchronous terminal receipts. Unknown words fall back or reject on stored-receipt validation; a public word does not authenticate its source. Terminal unknown/noRetry and immediate exit remain independent of these claims, with no error-prose identity inference or replay.
- Use a typed UUID with a fixed inert `data:text/plain` marker for profile CLI window creation. Keep typed Apple Event receipts, tab markers and exact new-window/active-URL/CG identity checks unchanged.
- Dispatch `profiles`, fixture `windowmatch` and explicit-PID `axwindows` before unrelated Chrome discovery or warm Apple Events. Preserve protected native mutation refusals and the existing picker/matcher behavior for other commands.

- Read one fresh window snapshot after AX title enumeration, keyed by window ID, before accepting ambiguous window matches. Reject structural drift and retain the existing matcher/order fallback, Stop and deadline behavior; unique-bounds matches add no snapshot.
- Preserve finite binding reasons and the existing transaction's last-write stage/delivery through ordinary error capture and terminal receipts. Optional data uses own data properties and fixed vocabularies; it does not change canonical error/delivery facts, authorize input or permit retries.

- Return the actual `held` Boolean for bare or non-dictionary veil requests, preserving the existing hold and strict reuse checks without acquiring a replacement.
- Settle an unconfirmed explicit held close only from that same guarded native call's strict receipt. Recheck original holder/Session/lease/record identity and independent sticky flags after the existing native postcheck, preserve Stop/noRetry and generic observer behavior, and describe an unconfirmed close without asserting that the tab remains present.

- Add opt-in, request-local native bounds diagnostics for one fresh root-operated input fixture. Record only existing initial/pre-bounds/post-bounds mapping values with bounded aliases and explicit incomplete/unavailable states; preserve the original Session, reply/error, native decisions and immediate terminal behavior. The private sidecar is not input or cleanup authority. Duplicate identity loss now marks the trace incomplete and complete order relations require consistent cardinality.

- Ignore older or equal-time setup-check results and recheck whether a request has already been answered after asynchronous waits. Preserve Pause at those continuation boundaries.
- Coalesce server follow-up checks by the latest unanswered original request time and recheck queued callbacks. Give panel automatic retries their own 30-second window while retaining explicit manual requests and existing per-app grouping.
- Bind clear-records confirmation timers to their generation so an old timer cannot cancel a newer confirmation after a busy rotation lock. Record deletion and lock behavior are unchanged.

#### 27 October close-phase and dialog failure-point candidate (offline PASS; live NOT_PASS)

For the existing eligible explicit held single-close observer, separate preparation authorization from confirmation. Its fixed 25,000 ms budget starts inside `closeAndConfirm`; it does not cover earlier tool setup. The 3,000 ms confirmation clock starts only when the final synchronous enqueue guard passes after the last awaited `ctx.check`, directly before the captured Session's `nativeChrome` request. The hook must grant literal `true` for the exact normal close intent; async/Promise, other-intent/target and restore misuse refuse. The hook stays local and is never serialized to the helper.

An unsent preparation expiry seals that attempt and reports `close_prepare_timeout / close_preflight / not_sent / noRetry` without setting `closeBlocked`. A resumed callback cannot gain late close authority. The callback is still drained, and its precise sent/unknown error or Stop remains authoritative; existing component timeouts and filesystem IO mean **25 seconds is not a total tool wall-time promise**. Generic/sweep callbacks retain their prior timing. The existing first-listing grace, same native receipt/operationId/epoch checks, original hold/lease identity, independent sticky flags and final record settlement remain unchanged; there is no second close send.

Add the optional `dialogProbePoint` only under `dialog_probe_unknown / dialog_inspect`. Its 15 closed labels identify 12 native/CLI rejection sites and three bridge collapse sites. The CLI generic catch can also cover a later binding error; a label identifies the existing failure site, not a root cause. No raw AX key/status/text, window identity or count is exposed. Existing firstFailure, typed errors, guard predicates and ordered reads are unchanged; there are no added AX reads, retries, timeout changes or input. The CALL and terminal projections use own data and finite labels, clear old captures, suppress fallback after an empty capture and reject cross-code/stage stored evidence. `close_prepare_timeout` is preserved as product metadata, while every terminal receipt remains `unknown/noRetry`.

Scoped actual Fable 5.1 QA passed for the six native/bridge files, and actual Opus 5.5 QA passed for the eight close/JS metadata files. Builder evidence retains dialog-reader 15 groups with 28 actual-source synthetic walker cases, native transaction 56, bridge 41, the close same-oracle old-source RED, 393 input lifecycle groups, tabs, and the valid final-hook-position mutant. Root then ran the actual integrated receipt 34 / terminal 23 suites: both passed with all 630 source/test/helper fingerprints unchanged. The earlier external patched-copy and old-index RED evidence remain separately recorded. A coherent cgevent/chromectl build passed in 32.588 seconds; cbmenu was unchanged, and the existing unused-`idN` compiler warning is retained.

All three Opus warnings are settled: W1's exact integrated lifecycle393/tabs checks passed in the normal full126 on Node24.14.1; W2's missing public close-timeout assertion has external supplemental actualCatchWrapper PASS plus a valid allowlist-omission mutant that produces `unavailable`, without changing the repository/default suite; W3 is resolved by source confirmation that helper/native operationId is an opaque unique string and need not be contiguous. **The normal-start full126 passed with exit 0 in 892.525953 seconds, with all 630 source/test/helper fingerprints unchanged and matching the approved set.** This full covers the combined close-phase and diagnostic delta; the retained stderr contains the known jsdom `HTMLFormElement.requestSubmit()` diagnostic. This is offline evidence, with no installation or historical origin3/current4 cause claimed.

**Fresh current5 and origin4: NOT_PASS.** Each returned only `task_plan`; `open_tab` then reported `native_target_changed / native_binding / sent` with `bindingReason=cg_mapping_mismatch`. Both terminated as `unexpected_mcp_error / open_tab / unknown`, `noRetry=true`, worker exit 86. Fixture identity remained unregistered/unobserved; read and subsequent actions, including close, were not reached. Origin4 captured an incomplete bounds trace (`cg_alias_cap`, `relation_cap`); `post_bounds` and `post_url` recorded `binding=matched` and `retained_exact`. These partial observations establish neither a complete trace nor a root cause or live close-repair acceptance. No post-terminal product calls or cleanup replay occurred.

`test/dialog-reader.test.mjs` now invokes `/usr/bin/swiftc` and requires macOS with Swift/Xcode Command Line Tools. Its generated Foundation-only capsule uses local AX/time doubles and does not access real AX. Preserve the explicit 28-case baseline-equivalence sources, synthetic outputs and execution receipt through release review. Default execution compiles/checks the candidate; it repeats the old/new comparison only when `DIALOG_PROBE_BASELINE_SOURCE` and `DIALOG_PROBE_BASELINE_CLI` are supplied. An unchanged saved equivalence proof is not a claim that every default test run revalidated the baseline.

The previous current4 and origin3 runs below remain **NOT_PASS**. Their diagnostics are not retroactively attributed by this candidate. No new live acceptance or installation is claimed; the owner App remains at the previously verified 0.14.0 state, with Base/master unchanged.

#### Historical 27 October failure-evidence follow-up (scoped checks passed; no separate full at that checkpoint)

The preceding batch (native `5b51543c`) adds closed `targetCoveredSource` facts (`dom_hit_test` / `native_point_blocker`; actual Opus QA PASS), optional private `firstStructureFailure` scope/field facts (actual Fable QA PASS), and an opt-in external-origin driver (actual Fable QA PASS). Structure evidence reports only the first rejected guard: `other` does not establish that the target was checked or stayed stable. These additions preserve the existing guards, first failure, delivery and no-retry behavior; they do not attribute historical failures.

Scoped validation passed: receipt 29, terminal 21, native-input 13, native evidence 42, evidence harness 17, native-round2 17 and external-origin driver 13. The cgevent/chromectl build passed in 33.2 seconds; native-commit 49, harness integration 55 and same-connection harness 62 also passed. The first same-connection attempt failed on a stale helper SHA and remains recorded as failed. Only its test pin was updated to the exact reviewed helper SHA; the rerun passed. **No separate full run had been completed at this diagnostic checkpoint. The current combined close-phase full above now covers its diagnostic delta; the older `3b98bf4` full126 remains limited to its own checkpoint.**

Fresh current4 (`mainline-current-kUbSAA`) recorded eight public calls and reached scroll, then `read_page` returned `dialog_probe_unknown / dialog_inspect / not_sent`. The terminal receipt retained `unknown/noRetry`; confirm click, answer, close and done were not reached. The run remains **NOT_PASS**, without retry or historical attribution.

Fresh origin3 (`focus-origin-hyKUaU`) recorded four calls (plan/open/read/click), then `close_tab` returned `close_blocked / unobserved / not_sent` and the worker exited 86. Terminal remained `unknown/noRetry`; done and final focus checks were not reached. The sidecar was `capture=captured`, but its trace was `incomplete` with `cg_alias_cap`. All four creation phases reported `structural=same` with the target mapped to C3; binding was initially `not_checked`, then `matched` in the other three phases. None contained `firstStructureFailure`. The 630 source/test/helper fingerprints matched before and after. This is not a complete trace or evidence that the old origin2 cause was repaired. **Current4 and origin3 both remain NOT_PASS; this diagnostic batch has not passed live acceptance**.

The candidate has not been installed. The owner App remains 0.14.0; Base and master are unchanged. Other live, installed, Channel and physical acceptance gates remain open.

#### Historical 27 October new-window mapping checkpoint (`3b98bf4`; offline verified, live NOT_PASS)

The candidate repair retains an initial `unique_bounds` pin only within the current `createWindow` request, after duplicate-claim removal, and clears it on every exit. It applies only to conflicting order fallback under the original group/count guards. The pinned CG must remain an eligible same-rectangle, on-screen, unclaimed hit; all group Chrome window IDs must have existed in the initial creation snapshot, with no newly observed group CG. Only the exact target remains assigned; other ambiguous group members remain unassigned. Strong contrary evidence, missing/moved/offscreen or weak pins, and physical replacement controls still refuse. The repair does not persist a cache across calls, change the pin or add OS reads, writes, waits, pumps or retries.

`creationPin` is cleared when `createWindow` returns, limiting this repair to creation-time false refusals; if Chrome index and CG z-order remain inconsistent afterwards, a subsequent ordinary `verify`, `moveWindow`, `activate` or `openTab` may still return `cg_mapping_mismatch`; this intentional scope limit does not establish a historical failure's cause.

Actual Fable and Opus reviewed the design; root selected the bounded Opus P1 variant. Those design reviews did not establish implementation QA. At the historical `3b98bf4` checkpoint (native `b01d28e2`), actual Fable source QA returned PASS and root read the full review. Five targeted suites (33 native cases), coherent cgevent/chromectl build, native-commit, windowmatch and both harness integrations passed. The normal-start full126 passed with exit 0 in 884.4 seconds and 630 unchanged source/test/helper fingerprints. Fresh live remained **NOT_PASS**: current3 completed open/read/click/type/scroll observations, then confirm click returned `target_covered`; origin2 stopped after `new_window_create/sent` with `snapshot_structure_changed`. Both ended without retry or post-terminal cleanup; final close/done/focus checks were not reached. These results belong to that mapping checkpoint and do not cover the later failure-evidence batch.

The separate earlier `post_url` diagnostics passed scoped actual Fable QA, build and targeted checks. Two fresh input runs each completed 10 public calls and 12 checks, including close/done, with PASS. Ordinary `mainline-current2` subsequently stopped after bounds with `cg_mapping_mismatch` and remains **NOT_PASS**. Those results and the historical `2b06f13` 126-script PASS do not validate this mapping repair or establish a historical failure's cause.

Tagged Chromium structure supports ordinary window-lifetime reasoning, not a universal CG ID lifetime guarantee. Existing-ID double-swap remains unobservable with these samples; historical live mismatches remain unattributed. This is still a 0.15.0 candidate. The latest verified installed version is 0.14.0; final App/worker installation status: **Not installed; the original owner App remains 0.14.0, with all six installation artifacts matching the verified recovery archive**. Other existing acceptance conditions are unchanged.

#### 27 October close postcheck follow-up

After the single guarded close send, use the closeTab branch's existing complete snapshot to confirm that the exact tab ID is absent across all windows. Only a still-present tab proceeds to the app-wide AX scan and prompt/pending result. The original transaction and healthy snapshot checks remain; the branch adds no read, send, retry or extended budget. Snapshot/AX unknown after a confirmed send retains `inputDelivery=sent` and `noRetry=true`.

The inert production-branch comparison retained one expected old-source RED and seven passing controls; the candidate and its registered regression passed all eight fixed cases. Actual Fable 5.1 (`claude-fable-5-1`) reviewed the four-file delta and returned PASS with non-blocking observations; the three-helper build passed. The historical `2b06f13` normal-start 126-script full run is **PASS: exit 0 in 881.4 seconds, with all 630 source/test/helper fingerprints unchanged**; it does not cover the later post_url diagnostics or mapping repair. The 921.2-second full PASS below belongs to the earlier 26 October checkpoint and does not cover this later change.

The preceding H1 live run on `85f5a85` passed all ten action checks. Its first cleanup close was confirmed; the last-tab cleanup returned `dialog_probe_unknown / dialog_inspect / sent` with last write `close_tab / sent`, and no replay or post-terminal browser probe followed the terminal receipt. The specific AX failure and actual final tab presence are not established. The offline comparison proves the conditional check-order issue, not that historical live cause.

The later two post_url input cases completed close/done, as scoped above; they do not establish the H1 cause or all close-timing behavior. A close that finishes after the earlier snapshot can conservatively remain `close_pending`. Installed App/worker, Channel, real-site and physical acceptance remain separate pending gates.

#### 26 October focus/window delivery candidate

- Add explicit `task_plan.return_focus`: `current` retains the current app/page/pointer for shared work; `origin` restores a temporarily borrowed scene. A new plan that omits it retains the legacy `origin` default. The policy is fixed while held; `done:true` ignores a new value and uses the held policy. Release facts and successful website outcomes remain distinct.
- Keep the accepted native geometry checkpoint and reject later drift before refreshing the Session or veil. Use completion ordinals to order audit events when timestamps are equal.
- Count attempted pointer movement in the delivery ledger. Positive or unknown motion evidence prevents replay; a confirmed zero-motion refusal can roll back only its own ledger entry.
- Require a positive protocol-2 owner acknowledgement for inherited handoff. Terminal or unknown close cancels only that offer. Mixed-version participants use the ordinary queue. A live giver or unreadable owner state may leave an inherited claim pending; age alone never authorizes reacquisition. A failed acknowledgement does not authorize compensating restore input.
- Retain existing test assertions while updating their fixtures for complete geometry/release receipts and screenshot carry. The native Stop mutant capsule now includes its exact production type dependencies. Tool definitions remain below the unchanged 15,000-character limit.

Actual Fable 5.1 and Opus 5.5 source QA found no remaining blockers; final fixture/metadata deltas received a separate actual Opus PASS. The three-helper build exited 0. One fresh normal-start `npm test` then completed all 126 registered scripts with exit 0 in 921.2 seconds; all 630 source/test/helper fingerprints matched before and after. The earlier 18-check attempt with stale helpers, the first full run's fixture failure and the metadata-contract failure remain failures in the retained evidence. Segmented diagnostics were not used as a full-suite pass.

This checkpoint is an offline candidate. Candidate live tests, the installed App and workers, real Channel acknowledgement, website/account flows and physical input/display acceptance remain separate gates.

#### Candidate evidence limits

The combined source at `6fd00b6` completed a fresh normal-start 123-script `npm test` on 26 October 2026: actual exit 0, no signal, timeout or TERM, 844.494897 seconds. All 624 tracked files and three helper binaries matched before/after and in root's recheck. Full streams are retained; stderr has the known jsdom requestSubmit diagnostic and an npm update notice. Descendants were not inventoried. The product/GUI build had exited 0 in 47.061457 seconds; the only subsequent implementation change was the old bounds test capsule, and all product and binary bytes stayed identical. The staged-source export check passed for 286 files. No runtime switch, installation or publication occurred.

The preceding QC1 normal123 run remains failed: exit 1 after 835.623743 seconds at command 118, where `native-bounds-evidence-harness.test.mjs` had not supplied requestContext/eventSequence to its actual dispatch capsule. The prior 117 commands completed and the last five did not run. The compatibility repair supplies the same request record as ingress while preserving the complete actual dispatch slice, 16 original test oracles and existing mutants. Eight focused suites passed; independent review found no further missing consumers among the four dispatch extraction users. This new complete run is separate evidence, not a backfill of that failure.

The same-connection harness at `8f3a661` has its own bounded offline PASS: COMPLETE / ATTRIBUTED / MACHINE_VERIFIED, with the Console confirming only that harness outcome. Actual unchanged-source overlap failures, a byte-identical passing test, 62 checks, 11 valid behavioral mutants and two fresh reviews support it. Worker request context stays isolated through preflight, dispatch, response and IPC; worker-level terminal facts are not copied to pending RPC rows. The fixed dual-field case requires real dispatch overlap and exactly 24 trusted ordered input events; non-overlap, drift, wrong field evidence and a third write refuse without retry. Existing48/20 checks, schema1 terminal behavior and original fixtures remain intact. No live queue, independent caller identity or physical delivery conclusion follows.

The historical `6fd00b6` checkpoint predates the focus-return clarification. The current candidate implements and tests `current` / `origin` as described above; the old 123-script result does not cover this later code. Physical restoration remains a separate acceptance condition.

The combined source at `82fa76d` completed one new normal-start 122-script `npm test` on 25 October 2026: actual exit 0, no signal, timeout or TERM, 835.070568 seconds. All 623 tracked file fingerprints and all three rebuilt helper hashes matched before/after the run and root's independent recheck. Complete output is retained; stderr contains the existing non-failing jsdom requestSubmit diagnostic and an npm update notice. Descendant processes were not inventoried. The normal product/GUI build exited 0 in 55.805807 seconds, and the staged-source export check passed with 285 files. No actual export, publication, runtime switch or installation occurred.

The state changes have two separate bounded offline settlements. `8b65d66` covers P42e/P42g: 25 check-order checks including six valid mutants, plus nine Swift confirmation scenarios with 37 assertions and three compiled behavioral mutants. `82fa76d` covers P42f and source integration: 29 server checks including five valid mutants, plus 18 panel scenarios with 70 assertions and two compiled behavioral mutants. Both retained actual unchanged-source failures, same-test-byte passing runs and two fresh independent reviews without remaining findings. Both settlements are PASS with COMPLETE / ATTRIBUTED / MACHINE_VERIFIED; the Console's achieved outcome applies only to each offline contract. These tests do not exercise real permission checks, clear real records or establish live GUI behavior.

The preceding normal 120-script integration at `8b65d66` remains failed: exit 1 after 802.241121 seconds at command 102, where the scroll harness's explicit full-source pin still named pre-P42e index bytes. The first 101 commands exited 0 and the last 18 did not run. Its exporter also failed because four registered tests were absent; independent review found their required bounds-evidence helper missing too. The repair reviews the full approved index delta and unchanged scroll/veil execution slices before updating one literal pin, retains drift-negative tests, and adds all five dependencies plus the two P42f suites to the manifest. The new full run does not turn that earlier failure into a pass.

An isolated harness follow-up at `3aae9f8` adds one root-operated `scroll-document` case. It preserves the existing seven cases and terminal behavior, checks one protected native scroll against passive document counters, and records bounded script/native evidence. Exact frozen block/locate bytes, sticky uncertainty from prompt-observer children, the real held-scroll veil envelope and separate product/executing-harness file identities prevent unsupported completeness claims. Product and native sources are unchanged.

Its second-round offline settlement is PASS: delivery COMPLETE, attribution ATTRIBUTED, acceptance MACHINE_VERIFIED, with the Console confirming only this isolated harness deliverable. Focused execution passed 48 harness checks, 20 unchanged terminal groups, 33 valid behavioral mutants, safe `--check` and whitespace checks; two fresh reviews found no remaining findings. Root independently exercised the actual manifest helper/final integrity code and killed a selected-root mutant. The first round remains NOT_PASS because both reviewers found the veil rectangle mismatch and cross-root provenance gap. The combined 122-script result above now covers this follow-up; the earlier 118-script result did not. No live scroll was run and the active HUD has not switched to this branch. Live/installed and original issue acceptance remain required.

On 25 October 2026 (local time), source commit `c31ca9b` completed one frozen, normal-start `npm test`: all 115 registered scripts, exit 0 in 787.4 seconds on Node 24.14.1. Both independent Round 3 reviews returned no unresolved findings. All 213 auxiliary source/test/build/binary fingerprints and six protected paths matched after verification; native binary contents were checked separately from the settlement engine's ignored-directory coverage. Earlier failed rounds and their focused diagnostics remain distinct records.

The diagnostic follow-up at source commit `082dd95` completed a separate frozen, normal-start `npm test`: all 116 registered scripts, exit 0 in 798.0 seconds on Node 24.14.1. Two fresh independent reviews returned no unresolved findings, and all 214 source/test/build/binary fingerprints plus the six protected paths matched. Diagnostic Round 1 remains NOT_PASS despite its test exit 0: both reviewers found an identifier leak, which Round 2 replaced with explicit finite vocabularies and actual upstream negative tests.

The combined marker and offline-dispatch repair at source commit `f173e58` completed a new frozen, normal-start `npm test`: all 116 scripts, exit 0 in 805.3 seconds on Node 24.14.1. Two fresh reviews returned no findings; all 214 fingerprints and nine protected paths matched afterward. Focused dispatch checks passed 22 groups, preserving the original 16, and successfully compiled old-order mutants reached the intended discovery sentinel. The earlier marker run remains NOT_PASS: it was interrupted after an existing eager-discovery path waited in `processArgs`; the exact ps stall cause is unproven. The remaining picker path is unchanged and still has an unbounded subprocess wait.

The native-title and bounded-facts repair at source commit `2d9eec6` completed the normal 116-script `npm test` with exit 0 on Node 24.14.1. Two fresh reviews found no product or QA defects; all 214 fingerprints and ten protected paths matched afterward. Targeted checks passed 17 native, 23 receipt and 20 terminal groups. Restoring only the frozen callback produced the wrong mapping and failed the same assertion after compilation; dropping only the actual inner-catch handoff reached terminal exit 86 and failed the unchanged optional-field assertion. The matcher and Transaction remain byte-identical.

This run has no sealed settlement: the publisher timed out after verification, and the Console explicitly recorded the verification exit 0 while returning exit 3 for publication failure. Full test output is retained. The engine also collapses ignored binary directories; separate root build receipts and independent hashes verify the two binaries, without claiming engine-wide attribution. Exact npm elapsed time and background-cleanup flags were not retained; the combined Console duration is not substituted for them.

Two later independent live attempts on the pre-title-repair candidate remain separate records: DA3 confirmed open_tab/read_page but its first click returned product facts `dialog_probe_unknown / dialog_inspect / not_sent`; DA4's open_tab returned `native_target_changed / native_binding / unknown` without a confirmed fixture. Terminal unknown/noRetry stopped each attempt without further probes or cleanup. The adapter defect is established independently; neither these offline results nor the new diagnostic fields establish either historical failure's cause.

A second awake input attempt before these two fixes retained `new_window_unconfirmed / new_window_identity / unknown` after 8.480 seconds. It confirmed no fixture and performed no retry or cleanup. The CLI marker compatibility defect was verified against matching Chromium source; actual corrected marker admission/readback and the full causes of the historical live failures still need independent live evidence.

The bare-veil reply repair at source commit `fc3242b` completed the normal 116-script `npm test`: exit 0 in 805.6 seconds on Node 24.14.1, with no timeout and both background-process killed/survived flags false. Two fresh independent reviews found no defects; all 214 fingerprints and 15 protected paths matched afterward. The retained previous binary passed the original 41 session groups and failed only the two new missing-held checks, with normal protocol shutdown in both cases. The rebuilt binary passed all 43 session and 42 lifecycle groups; missing/false held replies and later inactive/aborted status still refuse reuse. These are isolated protocol and inert integration tests.

Its sealed settlement is `UNVERIFIED / CLAIMS_DO_NOT_MATCH_MEASUREMENT`, with only `bin/cgevent` listed as an extra claim: the engine collapses the ignored binary directory. Independent build receipts and hashes establish the binary identity separately. The verified generation and honest claim remain unchanged; no settlement PASS is implied.

Before this reply repair, independent live DA5 completed its first open/read/click replies, then its second same-window open returned `task_hold_lost / unobserved / not_sent`. The final input assertions were not reached; terminal unknown/noRetry retained the fixture without subsequent probes, replay or cleanup. The source defect is proven, but DA5 did not retain its raw native reply, so the exact historical cause remains unproven.

The held-close repair at source commit `0218bd0` completed a new normal 116-script `npm test`: exit 0 in 804.0 seconds on Node 24.14.1, with no timeout or remaining background processes. Its sealed offline settlement is PASS; all 619 frozen file fingerprints and 22 protected paths matched afterward. Current focused checks passed 98 lifecycle, 54 tab, 9 native-ownership and 25 harness groups/checks. Two fresh independent reviews found no remaining defects. Both actual unchanged-source regression failures are retained: the initial stale close result and the first reviewers' final-status-wait registry race. Three new interleavings preserve taken flags, blocked flags and replacement records. Original assertions, the late `ok:true` negative and all failed attempts remain; no atomic filesystem CAS or live acceptance is implied.

Before that close repair, independent DA6 passed all ten input scenario assertions, including the second same-window tab, original hold and trusted exact typing. Its first cleanup close returned `close_blocked / unobserved / unknown`; the whole attempt stayed deferred, with no second close, done or final scene readback. The original fixture was retained. Raw native/list receipts were not captured, so the unique historical cause and actual final tab presence remain unproved. A new independent fixture is required for the repaired candidate.

The bounds-diagnostics source commit `61d802c` completed a new frozen normal 118-script `npm test`: actual exit 0, no signal or timeout, 821.965 seconds on Node 24.14.1, with both background-process killed/survived flags false. All 622 frozen file fingerprints and 19 protected paths matched; both rebuilt helpers matched their actual r2 build receipt and all four build inputs. Complete stdout/stderr are retained; stderr contains one non-failing jsdom requestSubmit diagnostic. Two fresh final reviews returned no findings. Final focused checks passed 20 native, 16 new harness, 25 metadata, 26 retained harness, 17 native-round2, 48 native-commit and 20 terminal groups. The new normal-run suites also retained all 43 valid compiler/capsule invocations and both expected exit-86 terminal children with unchanged product-return evidence.

The sealed formal result remains `UNVERIFIED / CLAIMS_DO_NOT_MATCH_MEASUREMENT`: delivery COMPLETE, attribution AMBIGUOUS, acceptance MACHINE_VERIFIED, outcome UNCONFIRMED. The only extra claims are `bin/cgevent` and `bin/chromectl`, omitted individually by the engine's collapsed ignored-directory inventory. Root separately accepted this bounded offline implementation using the actual build receipts and full-file hashes; the frozen claims, baseline and formal result were not rewritten into PASS. Earlier compatibility failures, both genuine pre-repair BE-COV-01 REDs and diagnostic mutants remain preserved.

Before this instrumentation, independent DA7 stopped at its first open_tab with `native_target_changed / native_binding / unknown`, `cg_mapping_mismatch`, and last write `new_window_bounds / sent`. No input/close assertions or later cleanup were reached. An empty confirmed-fixture list does not prove that no window was created. The diagnostic addition is not a mapping repair or proof of DA7's cause; a new independently planned fixture is required. Its trace contains existing observed values only, AX enumeration remains unobserved, diagnostic timing is not ordinary performance acceptance, and same-account deliberate receipt forgery is outside the guarantee.

Actual terminal Channel loading, idle/busy ACK, live automatic handling, installed App/runtime, original 44 issue IDs and 20 subissue IDs, physical Caps HUD, ACRA, queue/Stop timing, exact restoration and real-site template gates remain open individually. The historical pre-feature attempt stopped before product calls at screen preflight. A later awake attempt completed task_plan but open_tab ended in error after 16.558 seconds; no fixture was confirmed and no retry or cleanup write followed. Its original cause remains unknown because the error facts were lost. The diagnostic repair does not claim to fix that cause. The candidate is committed locally; the last verified installation was 0.14.0 and was not rechecked in this offline run. No Marketing release is implied.

## 0.14.0 — 2026-10-23 (not published; included in 0.15.0)

These entries record the earlier local installation and validation. The user-visible changes ship in 0.15.0; later 0.15.0 entries supersede the earlier OCR wait and external-conversation descriptions.

- Return newly revealed or updated controls, their live marker IDs and concise context directly after same-URL clicks. Wait through short loading states, retain privacy filters, and avoid resending old controls after a modal closes.
- Keep the entire native takeover card above the dimming layer and inside the target window when space permits. Verify the production view hierarchy, card transitions and stop-hint margins.
- Describe unsupported external-client progress feeds and between-action input holding accurately. Distinguish an actual occluding window from a later diagnostic sample of the target itself.
- Give local Vision OCR a separate bounded 60-second budget for model compilation and report OCR failures accurately; input command timeouts remain unchanged.
- Distinguish the observed inactive Chrome translation bubble from a page alert using its nonmodal accessibility structure, language tabs and toolbar buttons. Preserve real alert detection and all foreground/occlusion guards. A paired native probe reproduced the old false positive and verified the repair while the same bubble remained open.
- Retire unused warm helper processes when the helper binary changes, preserving commands already in flight. An unreadable binary identity uses a fresh process instead of trusting a cached helper.

- Start page reads with top-level headings and expand one level on request. Return scoped changes on subsequent reads, keep section/control identities stable, and continue DOM output within the requested budget instead of switching to OCR because the page is long. Keep native and ARIA articles in separate scopes, avoid resending unchanged text after insertion, and explicitly report changed reading order.
- Confirm marker-click outcomes through navigation, new tabs, visible content/dialogs or bound checkbox/radio changes. Focus alone remains unconfirmed. Screenshot-based clicks report delivery only, explicitly leaving the outcome unconfirmed. Normal receipts omit coordinates, mouse paths and pacing diagnostics; screenshot-click coordinates remain available in diagnostic mode. Errors no longer append a repeated cross-tool fallback tutorial. Existing native page dialogs are detected before ordinary input attempts to evaluate page JavaScript.
- Capture only verified webpage bounds, excluding tabs/bookmarks and separately composited native windows. Image-only requests skip OCR; unknown geometry fails without a whole-window fallback. Capture does not redact visible personal information or guarantee exclusion of browser overlays painted inside the same content area.
- Verify the exact foreground tab/window before takeover input, including scrolling. Retain Stop and input ownership guards, distinguish uncertain navigation from proven user input, and recheck ownership immediately before closing tabs.
- Add verified `replace: true` through real Command-A, ordered typing chunks and confirmed-character progress. Report sent-but-unconfirmed keys or paste separately; client timeout policy remains client-controlled.
- Keep new tabs from replacing an existing visible tab, retain partial new-window creation identity, and retry only read-only observations after qualified transient native failures. Keep shared-connection identity explicit and task completion/restoration receipts generic and evidence-based.

### Current HUD and click-delta validation (2026-10-23)

- The renewed full-scope audit reproduced and repaired the translation-bubble false positive. The 96-script regression completed with exit 0 after repairing its extracted Swift test dependency; the subsequently added warm-helper upgrade regression passed separately. The default list now contains 97 scripts; this is not described as one uninterrupted 97-script run. All three helpers built and the reviewed staged export contains 240 files.
- The translation/warm-helper follow-up was installed locally at `9326fb6`: the native helper matches the tested build and all ten observed live main-checkout workers refreshed to the new JavaScript fingerprint. The previous helper and unrelated work were preserved, and master remained unchanged. The Mac locked before the follow-up native alert/coordination/fault fixture, so those live cases remain pending.
- Installed long-input verification confirmed 530 trusted characters in 158.929 seconds, 17 progress updates and zero paste, followed by exact 21-character replacement. Thirty-two behavior checks passed, but that harness's separate final test-preparation App restoration was unconfirmed, so the whole run retained a failing exit status. The complete 23-item matrix preserves that distinction and the remaining live gaps.
- All 96 default test scripts completed successfully after the OCR timeout repair. The final card-contrast adjustment also passed the production hidden-window layout checks (12 transitions) and the complete panel tests. All three native helpers rebuilt successfully; public documentation checks passed 511 assertions and the reviewed export contains 239 files.
- The real same-URL fixture returned both identity choices with live markers, continued through the returned markers, waited through delayed loading, handled a modal and avoided repeating old controls on close. All six clicks were trusted and delivered once; input was released and the fixture was closed. Actual wide-window frames verified the whole card and stop hint inside the ring. Installed-runtime readback subsequently passed all 11 assertions, including exact original App/window/tab restoration; final physical inline/modal frames verified the contrast backing.
- A real native fixture passed 22 assertions: two page-only image/OCR layouts, Caps-on typing/read/click, native alert refusal and safe answering, double-Esc cancellation, stable partial input, lock release and refusal of subsequent input. The exact Caps indicator was not observed, so that visual case remains pending; Caps state and fixture bounds were restored.
- Installed App 0.14.0, all three matching helpers and 13 observed live MCP workers were verified locally. The App restarted itself normally; clients were not forcibly restarted. The previous valid App/helpers were backed up, unrelated work was preserved byte-for-byte, and the remote-deployment master ref was unchanged.
- Actual LTA Login returned only its four new options and context, with live marker IDs and an unchanged URL. The ACRA probe stopped at a conservative verification-text guard; no matched excerpt or visible challenge frame was retained, so an actual site block is not established and that live case remains pending. No identity was selected and no account transaction was submitted. The exact Caps HUD and ACRA case require further live evidence; this is not a claim that arbitrary sites or every native overlay are verified.

### Earlier reliability candidate checkpoint

- An offline comparison of the same 20-step synthetic workflow (`967fdfe` versus `dabdfe6`) reduced text output from 26,087 to 5,480 bytes (21.01% of baseline), including the candidate's two extra expansion replies (22 versus 20 calls). Estimated tokens were 7,953 versus 1,614. Exact fixture values, final state, errors and unconfirmed outcomes were checked. This is one simulated workflow, not measured model usage, a general savings guarantee or real-device evidence; it excludes the later screenshot-click receipt change.
- The final `npm test` passed all 92 default scripts in one uninterrupted run, including all 189 page-test groups. Final focused checks also passed hierarchy (27), private-subtree (5), feedback (23), read integration (6), dialog-input (7), and native-select/error-receipt (26) groups. The optional strict scheduler-latency mode was not enabled.
- All three native helpers built successfully. This source candidate has not been installed or published.
- Real local-fixture acceptance passed 32 checks, including hierarchical reading, exact foreground scrolling, observed click outcomes, 530 trusted characters over 164.163 seconds with no paste, confirmed progress, replacement, input release and independent App/pointer restoration. Original window/tab restoration remains unverified.
- Two independent MCP workers passed 11 coordination checks: reads and image capture during a held task, a queued write delivered once, redirect ownership, retained tab selection and guarded cleanup. The initial coordination failure lacked a detailed native receipt; its original cause remains unconfirmed.
- Webpage-only images and OCR passed two window layouts at the observed DPR 2, and both images were visually checked. Caps-on read/click passed, but the exact Caps HUD was not observed. The live native run exposed a DOM probe before the dialog check; the shared input entry is repaired and covered offline. Physical retesting of that repair and double-Esc cancellation stopped at screen preflight after the Mac locked again. Installation and Marketing remain pending.

## 0.13.0 — 2026-10-22

- Start a Codex or Claude Code conversation from the native App with New conversation or Command-N. Select a working folder, a model from the installed client's current catalog, and a supported thinking effort; these choices do not rewrite client settings.
- Show streamed public assistant text, follow-up replies and supported questions or one-time approval requests for App-created conversations. Existing external Claude conversations retain their browser tools and page handoff, but cannot be attached as live conversations.
- Keep the first task as an exact-conversation draft and send it through the normal delivery ledger. Repeated or uncertain creation requests retain their identity, and uncertain message delivery never triggers automatic resending.
- Read back effective model and effort settings. Confirm Claude messages through matching CLI acknowledgements, distinguish generation failures from accepted input, and provide Stop generation for the selected conversation.
- Keep managed conversations separate from MCP-server restart and permission checks. Closing the App leaves their background work running; exited backend sessions are not automatically restored.

### Validation scope

- All 71 default test scripts passed across the initial run, the corrected page test and the remaining-script continuation. Two obsolete test fixtures were updated to match existing navigation and handoff behavior; the full page test passed 188 groups. Optional strict scheduler-latency assertions were not enabled.
- A clean 212-file allowlisted export installed and built all three native helpers. The final session adapters, launcher, worker, native UI and affected GUI regressions passed again from that export. The package dry run contained 102 files; no npm publication was performed.
- Real App-created Codex and Claude Code conversations returned their requested synthetic replies, reported effective model/effort, and accepted follow-up input. Native checks covered empty and prefilled creation, model selection, changing folders, Stop and continuing afterward, and reconnecting after the GUI process restarted. The final Claude interruption fix was also verified against its real CLI.
- Verification used the installed Codex 0.163.0 and Claude Code 2.1.307 clients. Authentication and global client settings were not rewritten. Client/model availability can vary; existing external Claude conversations and exited managed backends are not restored by this feature.

## 0.12.1 — 2026-10-22

- Replace the first-run practice server with a short continuation request for the user's existing Chrome page and AI conversation. Opening the guide never starts a sample task or leaves a localhost tab behind.
- Center the product introduction on same-page collaboration: AI takes over when asked, hands the page back for steps requiring the user, and resumes the original task after an explicit continuation.
- Refresh the selectable continuation request immediately when the first-run guide language changes.
- Explain configurable typing, pointer and scrolling pace and optional personal habit sampling alongside the handoff controls. Keep experimental and client-specific capabilities explicit.
- Align handoff notifications, field hints, tool results and agent guidance: detecting Return or a page change ends observation, not authorization to resume input. The assistant should wait for the user’s explicit continuation for that handoff and reread the same page. This is a client/agent protocol, not a server-enforced chat gate.
- Replace the previous practice demonstration with an edited product explainer using current native views and labelled animation reconstruction. Example social tasks do not claim verified platform compatibility or actual publication.

### Validation scope

- An isolated 201-file export built all three native helpers and passed all 66 default test scripts. After the final handoff wording changes, the refreshed export was rebuilt and passed the affected ask (23), block (12), ledger (67), peer-routing (6) and public-site (511) checks. The package dry run contained 96 files; no npm publication was performed.
- Real native-window checks covered Chinese/English request copying and closing, guide reopening, immediate language switching and the Operation Settings destination. Existing client configuration and macOS approvals were not changed.
- All six site pages passed 18 desktop/mobile layouts. Browser playback, pause, seeking, subtitles, download, reduced-motion behavior, navigation and copy actions passed. Final MP4/GIF decoding and media privacy review passed. The film is a labelled reconstruction with synthetic content, not evidence of completed social-platform transactions.

## 0.12.0 — 2026-10-22

- Add one guided source setup command with prerequisite checks, an owned App destination, exact-path client instructions and actionable permission diagnostics. Existing client configuration is never silently rewritten.
- Add a bilingual, reopenable first-run guide for installation, client connection, a local practice task and desktop controls. Diagnostics run asynchronously and distinguish the checked host from the AI client's host.
- Include a temporary localhost practice page: read, type, select, save and verify a synthetic weekend plan. Copying the practice request includes its current URL; starting the page does not claim task completion.
- Publish concise bilingual documentation and a static product site with accessible navigation, factual metadata, canonical URLs, sitemap, structured data and opt-in demo playback.
- Extend the reviewed source exporter for four exact public image/GIF paths, with format and size checks. Raw recordings, runtime data and development history remain excluded.
- Unify supported Node versions across setup, diagnostics and package metadata: 20.19+ on 20.x, 22.13+ on 22.x, or stable 24+.

### Validation scope

- A fresh 200-file allowlisted source export completed guided setup, built all three native helpers and passed all 66 default test scripts in one uninterrupted run. The public documentation/site check covered 427 assertions. Optional strict scheduler-latency assertions were not enabled.
- Real native-window checks covered first launch, skip/reopen, host-specific permission diagnostics, exact client commands, practice-page startup, copied prompts and saved input preferences. The exported build was also opened and its source paths verified.
- A real MCP connection read the local practice page, typed the plan key by key, selected its time, saved it and independently read back both values. Two fresh MCP connections could read the existing practice tab. The demo shows this synthetic local task, with waiting intervals removed and playback at 2× speed.
- Claude Code 2.1.306 connected using isolated configuration; Codex CLI 0.163.0 parsed the exact server paths and 900-second timeout using temporary overrides. These checks did not modify existing client configuration or run a model conversation.
- Live checks used Apple Silicon, macOS 27 and Node 26. The broader documented OS/Node ranges were not each tested on separate machines. Existing macOS approvals were not reset to simulate every first-time permission prompt. The main workspace is currently Chinese; the first-run guide is bilingual. Claude live text and terminal replies remain unsupported in the GUI.
- This is a source release, not an npm publication or a guarantee of arbitrary website compatibility. User stopping, input ownership and uncertain restoration results retain their existing boundaries.

## 0.11.0 — 2026-10-21

- Automatically record local website action metadata and offer continuous sequences as reusable routines. Save a named prefix from the first attempt, then execute it with one MCP request and no model decisions between steps.
- Resolve each current target from its semantic identity instead of saved marker numbers or coordinates. Check exact site, route, query fingerprint and observable page/target state; stop with the confirmed step count when a target changes or delivery cannot be verified.
- Add a Website Routines page to the native GUI: site search, recent actions, sequence selection, reusable routine parameters, exact destination tab, progress, stop and a recording switch. Keep conversation streaming and operation preferences separate.
- Parameterize typed and selected values. Sensitive fields, unsupported targets, failures, missing records and interrupted writes form barriers that cannot be skipped when saving a sequence. Store bounded metadata locally with private permissions and atomic cross-process writes.
- Reuse the guarded mouse, keyboard, selection and wheel implementations, preserving user input-mode and speed preferences. Routines do not fall back to scripted scrolling, DOM clicks or value assignment.
- Preserve request identity for uncertain responses and expose truthful stopping/cleanup states. Native session cancellation interrupts a long input operation while retaining release and clipboard restoration checks.
- Keep GUI polling attached to the persistent routine model so parent-window refreshes cannot stall progress. Preserve concurrent user waits while serializing their input setup and excluding routine starts for their full duration.

### Validation scope

- A fresh 155-file allowlisted source export installed with zero reported npm vulnerabilities, built all three Apple Silicon helpers and passed all 62 default test scripts in one uninterrupted run. The package dry run contained 53 files and no private verification material. Optional strict scheduler-latency assertions were not enabled.
- A controlled local Chrome fixture recorded three ordinary actions and replayed them with one request after inserting an unrelated button. Both passes produced three trusted clicks, with zero untrusted or unrelated clicks, and reached the intended lesson.
- The native GUI saved a selected three-step range and ran it on an explicitly selected fixture tab. Progress automatically advanced from 0/3 through 1/3 to 3/3 without manual refresh; the page independently confirmed the destination and three trusted clicks.
- A long ordered-key input stopped with four matching keydown/keyup pairs, no held keys and no later input. A separate run honored the current paste preference, producing one trusted paste and the exact supplied Chinese value. These are individual fixture runs, not latency guarantees.
- This is a source release, not an npm publication. Live verification used controlled local fixtures; it does not establish support for an arbitrary website, official exam workflow or external business transaction.

## 0.10.3 — 2026-10-21

- Use consistent semantic status colors, icons and labels in the native conversation list, detail view and delivery receipts. Connected/active state comes from host metadata; a message ending does not imply task success. Green confirms an accepted reply only.
- Replace takeover recovery advice that encouraged duplicate tabs with read-first guidance for the user's existing tab and an explicit handoff before further input. Keep ownership and close protections unchanged. Explain how to wait for long typing calls that a client moves into the background.
- Recognize the exact Caps Lock indicator label only within the existing narrowly verified nonmodal, unfocused, single-button native indicator shape. Unknown windows and genuine webpage dialogs remain protected.
- Recover one explicit-tab page-script request after a structured native `chrome_error`, `osStatus: -1701`, `stage: find_tab_windows` failure: pause 250 ms and retry in a fresh process. That stage precedes script execution. Errors after execution, permission failures, unqualified front-tab requests and repeated failures are not replayed.
- Disable the older empty-output retry for page-script requests because their execution status is unknown. Preserve a second native lookup error, including permission denial, instead of masking it with the first transient error.

### Validation scope

- A fresh 137-file allowlisted source export installed and built successfully, then passed all 54 default test scripts in one uninterrupted run. The package dry run contained 48 files and no private verification material; the optional strict scheduler-latency assertions were not enabled. This is a source release, not an npm publication.
- The reported Claude session and its existing investigation distinguish failed attempts from normal cancellation and background typing. The exact historical AX/CG snapshot for the Caps Lock incident was not retained; synthetic indicator regressions do not prove that every native indicator shape is covered.
- Long typing completed in the reported session. This release does not change Claude's client-side background-task behavior or add a terminal conversation adapter.
- Checked semantic colors in light and dark rendering fixtures. In the installed App, the current conversation showed the blue active state and the same public progress message emitted by its host.

## 0.10.2 — 2026-10-21

- Separate the native GUI into searchable conversations and operation settings, with a persistent pause control. Opening a conversation from a prompt also switches back from settings. Show a recovery link for drafts retained after a connection changes.
- Expose follow-task, key-by-key and paste input choices, plus six pacing presets from 0.5× to 3×. Explicit user choices override tool arguments and are rechecked before input; speed changes apply within an ongoing task. Native temporal fields reject paste before input.
- Serialize settings updates across the GUI, server and native speed controls so concurrent changes preserve independent preferences. Refuse corrupt settings rather than overwrite them.
- Save preferences off the GUI thread and retain an independent pause signal when the settings file cannot be updated. An older resume request cannot clear a newer pause.
- Let screenshot reads run while another agent holds input. Capture only the identified Chrome window without activation or a screen-region fallback, and discard captures if tab/window identity changes. Automatic OCR uses the same checks. Physical input remains serialized.
- Reuse verified Codex GUI bindings for task feeds, retain the source when a task update omits its ID, and keep the original task stream when the GUI switches conversations. Accept live messages arriving during the initial join and recover from temporary disconnects with bounded retries.
- Preserve uncertain delivery state without automatic resend. Unavailable streams no longer claim to be connected. Claude's existing terminal text stream remains unsupported and is labeled explicitly.


### Validation scope

- A fresh 137-file allowlisted source export installed with zero reported npm vulnerabilities and built all three Apple Silicon helpers. All 54 default test scripts passed across the initial run and a focused continuation: the initial run stopped on one outdated ownership-message assertion; after updating that test, its 66 checks and all 11 remaining scripts passed. No product code changed for that correction. The optional strict scheduler-latency assertions were not enabled.
- The package dry run contained 48 files and no private verification material; this does not represent an npm publication.
- The installed native App was checked with real clicks: input mode and speed persisted, conversation title search worked, and opening a conversation switched back from settings. New public Codex progress messages appeared in the selected conversation.
- A local Chrome form recorded trusted key events for all 13 characters at both 0.5× and 3×, with no paste events. Observed key spans were 7.1 s and 1.3 s respectively; these are individual runs, not fixed timing guarantees. Paste mode produced one trusted paste event and the exact Chinese text.
- With one MCP worker continuously holding input, a second worker completed list, DOM read and screenshot/OCR operations; native input ownership remained active at every checkpoint. The test ended the hold, restored follow-task/1× settings and closed only its own tab.

## 0.10.1 — 2026-10-21

- Show real conversation titles before client names, collapse unassociated idle connections, and keep waiting tasks, current selections, drafts and unconfirmed sends visible. Preserve exact reply and draft identities.
- Restore the conversation window when the running App is opened again after its window was closed.
- Resolve the recording helper through the installation root from the native App bundle; retain existing habits paths and cancel in-flight recording on process signals as well as menu Quit.
- Add focused native path, list and lifecycle regressions.

## 0.10.0 — 2026-10-21

- Add a native conversation center with waiting-task priority, actionable handoff prompts, target-page results, per-conversation drafts and explicit Codex thread association.
- Bind page navigation to the current worker generation and alert token; reject stale requests, coalesce duplicate clicks, retain input-lock/pause checks and report queue, failure and success states.
- Add a local Codex conversation adapter for public live messages, structured questions and user-submitted replies. Validate direct-input capability, exact thread/turn/request identity, and host acknowledgement. Reject stale metadata and late-receipt races.
- Keep GUI replies in memory and private local sockets, preserve split UTF-8, deduplicate submissions, and make receipt lookup strictly read-only. Unknown delivery never triggers automatic resend.
- Preserve verified conversation selection across worker updates while replacing connection identities; completing a browser task keeps the conversation center available.
- Release browser input when an AI question needs the user. Guard queued and in-flight action boundaries, retain the unfinished plan, and require an explicit restart after the reply.
- Add Finder/Spotlight launcher installation. Claude and unbound clients are explicitly shown as unavailable for direct terminal replies; no foreground-terminal typing fallback.
- The GUI lists connected MyChrome clients and loaded conversations on their own Codex host, not every terminal on the machine.

## 0.9.1 — 2026-10-21

### Controls and privacy

- Guard native dropdowns before marker clicks, coordinate clicks and menu-opening keys. A cold AX probe checks controls across iframe and shadow boundaries while preserving ordinary visual interactions.
- Add a guarded, single-Escape native-menu recovery that avoids Apple Events, checks the frontmost window and recent page identity, and retains pause, cancellation and website-block boundaries. Unproven recovery requires the user's Escape.
- Permit ordinary Escape without a recent page mapping only when a cold accessibility read confirms that the frontmost Chrome has no menu; unknown menu state remains blocked.
- Validate native date/time values and HTML constraints, identify their actual accessibility segments, type with real keys and confirm the final field value.
- Make ordered ASCII keystrokes the default for `type_text`. Unsupported characters are rejected before input; clipboard use requires explicit `input_mode: "paste"`.
- Remove the implicit script fallback from native dropdown selection. Failed keyboard selection returns `select_failed`; even an older running worker's former `set` request is refused by the freshly loaded page helper without writing a value.
- Confirm new text in the intended field before reporting input success. Incomplete, swallowed or unconfirmed text returns a tool error, with the failed input result first; failed verification never presses Return.
- Check display/session state before input, and use a read-only input observer when attributing navigation to an agent.
- Redact sensitive URL parameters and private-field material at the tool-output boundary.
- Calibrate wheel movement separately for each scroll container. Targets more than two viewports away can use conservative bursts of up to 24 ticks after calibration; nearby targets retain the existing pacing, waits and input checks.
- Release the session's retained input hold before closing its own tab, then apply the existing ownership and user-viewing checks.
- Report confirmed input release, foreground-app and pointer results when ending a task; do not claim that window restoration succeeded without evidence.
- Correct tab lookup. Identify clients from their MCP handshake or an exact executable name, rather than command or prompt substrings.
- Use appearance-aware warning colors so menu-panel errors remain readable in dark mode.
- Retain one takeover for an explicit whole-task plan through reading and reasoning. Recoverable failures keep confirmed healthy input ownership; lost or unknown ownership preserves the unfinished task and interruption reason. Stop prevents automatic re-takeover.
- Preserve takeover when the same long task title is updated, while distinguishing different titles that share a shortened sidebar label.
- Replace generated sidebar notes and inferred question completion with a projection of the host's existing visible assistant message stream. Filter tool data, command/code blocks and private reasoning. The local Codex daemon adapter requires a selected active thread and compatible host. On Codex 0.163.0, a real message streamed from 1 to 70 characters and its final hash matched the original visible text including the host's trailing newline. Other MCP clients are not assumed to support it.
- Reserve sidebar space beside agent-owned windows on larger displays, retaining at least 1000 pt for the page. Record Chrome's accepted bounds after creating a window; macOS can adjust the requested position. User-owned or manually repositioned windows are preserved.
- Distinguish the observed WeType input-source indicator from a webpage dialog. Match its nonmodal, unfocused accessibility structure and small Chrome-owned layer-3 window; unknown indicators and real dialogs remain protected. A live before/after check and 24 targeted regressions verified this case.
- Attribute delayed page navigation to the preceding input only while the same whole-task hold remains continuously healthy. Require matching tab, window, Chrome process, native focus and ownership, plus zero observed user input. Keep sticky user-takeover decisions; 49 regression scenarios cover delayed navigation, deferred acknowledgement and refusal boundaries.
- Separate tap-disable notifications during preparation from a lost active takeover. A real tap failure during a hold still releases input and prevents further actions; later shutdown notifications preserve the first failure. Click acknowledgements describe delivery without incorrectly claiming that a whole-task takeover has already ended.
- Retry one failed read of Chrome's window collection after Apple Event error -1701, without replaying input. Corroborate a missing native application bundle through the exact running process; reject known wrong or terminated processes. These narrow recoveries do not eliminate every transient macOS metadata failure.
- If the read-only `info` command still returns structured `chrome_error`, `osStatus: -1701` and `stage: find_tab_windows`, retry that metadata read once in a fresh process. Permission failures, unknown failures and commands that change the page do not enter this recovery; a second failure is returned unchanged.
- Update seven existing vulnerable dependency packages within their current major versions. The fresh npm audit on 2026-10-20 reported zero vulnerabilities; the new WebSocket transport uses ws 8.22.0.

### Documentation

- Reworked English and Chinese setup around the source checkout and locally compiled Swift helpers. The npm package name returned 404 during the 2026-10-20 check.
- Added an AI guide covering explicit tab targeting, account checks, whole-task plans, native dropdowns, private-field handoff, interrupted actions and saved-result verification.
- Removed instructions to create short plans per page or supply `step`/`note` on every action. One plan covers the complete job, and visible messages come from the conversation itself. Retained helper liveness and user handoff rules; after Stop, agents must wait for new user direction before starting another plan.
- Clarified that page reads can run concurrently while physical input is shared, that Esc cancels the current agent, and that the panel pause stops further actions across agents.
- Added a Codex tool-timeout example for queue and user-input waits.
- Replaced stale tool counts, contradictory update instructions and internal evidence links with maintained user documentation.

### Source distribution

- Added an explicit source manifest and an exporter with list/check modes, staged-index-only reads, tracked-file checks, symlink rejection, credential-pattern checks, documentation-link checks and SHA-256 readback. It refuses existing destinations and omits unstaged changes, Git history and binary/runtime evidence.

### Validation scope

- Package entry-point smoke test: 5 checks passed on 2026-10-20, including a repeat after the documentation revision.
- Native-control and export tests are offline checks. They do not establish successful interaction with every macOS menu or date-field layout.
- Added offline scroll/close regressions for calibration, container isolation, stalled or interrupted scrolling, retained-hold release and genuine user-takeover protection.
- Added 14 offline typing-mode checks for default key dispatch, explicit paste, unsupported-character refusal, field confirmation, MCP error status and submission gating. The related guard suite passed 96 checks; the isolated Chromium temporal suite passed 11 checks. These do not establish real macOS keyboard-event or full release acceptance.
- An independent agent completed a 40-question IELTS Academic reading practice paper with real input, verified all answers before submission, and reopened the saved history entry: 40/40, 100/100. The six text answers used sequential keys and all eleven dropdown answers used keyboard selection. One whole-task plan covered the attempt and saved-result check.
- The Chrome-only recording finished normally and decoded at both the beginning and end, lasting 23 minutes 46 seconds. The mask and sidebar were absent from the captured window; resizing Chrome left unused canvas beside later frames. This does not establish exclusion from arbitrary full-screen recorders.
- A separate live synthetic fixture verified ten trusted keystrokes, zero pastes, trusted keyboard selection and a trusted submit click. A deliberately delayed 2.5-second navigation remained owned. Input release, pointer restoration and closure of that test tab were confirmed; window/tab restoration was not confirmed.
- The isolated 115-file source snapshot installed with zero reported npm vulnerabilities and built all three Apple Silicon helpers. All test files passed across the full suite and a targeted doctor rerun after correcting its outdated npm-install hint expectation; no product code changed for that rerun. The strict timing check was skipped because host load exceeded its threshold, so strict scheduler timing remains unverified.
- The package dry run contained 41 files, with complete documentation links and no private verification material. GitHub source distribution excludes compiled helpers; the documented source install builds them locally.

## 0.9.0 — source baseline

The previous local source baseline identified version 0.9.0. It included 16 MCP tools, Apple Silicon Swift helpers, a menu-bar panel, serialized input, tab ownership tracking, user handoff, setup diagnostics and idle worker reload. This baseline version number is not evidence of an npm release.
