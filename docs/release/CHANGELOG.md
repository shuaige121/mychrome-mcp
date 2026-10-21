# Changelog

Release notes describe changes in this source tree. A source version, an npm publication, a GitHub push and a successful live test are separate events.

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
