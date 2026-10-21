# MyChrome guide for AI agents

[README](../README.md) · [中文使用说明](usage.zh-CN.md) · [Changes](release/CHANGELOG.md)

MyChrome controls the user's own Chrome on their Mac. Reads can run in background tabs. Mouse and keyboard operations share the user's physical input and are serialized across MyChrome sessions. Treat each tool reply as evidence about one action, not proof that an entire task succeeded.

## Choose the appropriate tool

Use a public API or web fetch for public information. Use headless Playwright for a JavaScript page that needs no user login. Use MyChrome when the task needs the user's Chrome session, an existing shared page, or the user explicitly requests it. If another available tool cannot access the page, MyChrome is also an option.

If MyChrome reports a CAPTCHA, bot check, access denial or rate limit, stop automation on that page and call `wait_for_user`. Do not solve it, change tools to evade it or repeatedly retry. If MyChrome merely cannot locate an ordinary control, try a fresh `screenshot` and `click_at`; an available browser extension may be another option within the user's authorization.

## Establish the tab and account

1. For an existing page, call `list_tabs`, identify its URL/title and use its explicit `tab` ID. Use `mine: true` when looking only for this session's tabs.
2. For a new page, call `open_tab` with `url` and a reason. Valid `why` values are `needs_user_login`, `same_page_with_user`, `user_asked`, `site_restricts_automation` and `other_tool_failed`. `profile` optionally selects a Chrome profile by name, email or folder.
3. Store the actual returned tab ID. Pass it on all later reads and actions. Do not invent IDs or rely on the foreground tab remaining unchanged.
4. Read the page. Verify the active website account before changing data. A Chrome profile can contain several Google or website accounts.
5. Open only the site's entry page with `open_tab`; use the page's links for subsequent navigation. Track any new tab reported by a click.

```json
{"url":"https://example.com","why":"user_asked"}
```

All IDs below are illustrative. Replace them with current tool results.

## Read, act, verify

```json
{"tab":123,"query":"Search"}
```

`read_page` returns numbered DOM elements such as `[12]`, an outline and visible content. Its default `budget` is 2500; `sections: ["S3"]`, `query` or `full: true` request more. The budget chooses the reading form and is not an absolute reply-size cap. After navigation, a reload or a material layout change, read again before reusing markers.

```json
{"tab":123,"marker":12,"text":"sample search","submit":true}
```

In the GUI's follow-task mode, `type_text` defaults to `input_mode: "keys"`, sending real ASCII keys in character order. A user-fixed input preference overrides the tool argument. Keys refuse unsupported characters before any click or input and never silently switch to paste. Paste sends one Cmd+V and restores the clipboard unless another application changed it.

The tool enters text into the focused field, optionally clicking `marker` first. Do not assume it replaces an existing value. Success requires new text confirmed in the intended field; unconfirmed or incomplete input returns `input_unconfirmed`, not a successful click result. `submit: true` presses Return only after confirmation and a fresh focus/value check. If that last check fails, `submit_unconfirmed` means Return was not sent.

For a native `<select>`, use:

```json
{"tab":123,"marker":18,"option":"Practice"}
```

Never open a native `<select>` with `click`: its macOS menu can block Chrome's Apple Events handling. Custom dropdowns use their observed page controls, or `press_key` when appropriate.

`select_option` uses real type-ahead keys and verifies the selected option. If the keyboard selection cannot be confirmed, it returns `select_failed`; it never sets the answer through a page script. Read the current selection before choosing the next action.

`press_key(key="escape", tab=...)` can close a native popup only when a recent verified window/page identity is available and native checks still match. It sends one Escape, even if `times` is larger, then asks you to read the page again. If the identity is unavailable, a task still holds input, or a safety gate refuses recovery, ask the user to close the menu with Escape. Do not retry through another input driver.

For a control without a marker:

```json
{"tab":123,"image":true}
```

Use the resulting `text_id` with `click_at`, or the coordinates within that screenshot, not whole-screen coordinates. Refresh the screenshot if anything moved. After an action, read the page or its result. A click with no observable URL/focus change may still have worked; inspect before retrying.

`scroll` uses `direction: "up" | "down"` and `amount` in screens. `press_key` sends a supported key to the current page focus; focus must be established first. Use the whole job's existing `task_plan` for a hover-and-click sequence so the pointer remains in place between actions.

Use canonical values for native date/time fields: `2026-10-20`, `14:30`, `2026-10-20T14:30`, `2026-10`, or `2026-W43`. `type_text` validates the field constraints, maps its native accessibility segments to real key input and confirms the final value. Do not infer the displayed segment order from the browser's reported language. An unavailable or ambiguous segment layout requires a user handoff.

## Keep shared control usable

`list_tabs` and `read_page` can inspect any user-authorized existing tab, including one opened by another agent, without taking the input lock. `screenshot` also reads without activation or input ownership, but requires the target to be its window's visible tab. Hidden/minimized targets and identity changes are refused. Ownership labels do not prohibit reading; physical input and opening a tab still use the shared queue.

Respect the user's input preferences: `auto` follows the tool's `input_mode` (default keys), while `keys` or `paste` overrides it. The GUI's 0.5×–3× pace applies to subsequent operations even within one held task. Native temporal fields require keys and reject paste before input.

For a multi-step task, start one plan covering the whole job:

```json
{"task":"Complete the practice form, review answers and verify the saved result"}
```

The plan holds one continuous takeover across actions, reading and reasoning. Do not end it after each question or section. Other agents' physical-input requests remain queued until the whole plan ends; reads can continue. A recoverable tool error does not end the job while the same healthy helper still owns input. A system interruption, lost connection or unconfirmed ownership releases input and preserves the unfinished task and cause. Re-read the page before deciding how to resume.

The sidebar mirrors the host's existing visible assistant messages as they stream. Write normal user-facing updates in the conversation; do not produce a second version for the panel, attach per-action `step`/`note` fields or invent a question-by-question completion checklist. Tool commands/results, code blocks and private reasoning are excluded. A displayed message or question index is not evidence that a field was filled.

The local Codex app-server daemon adapter has passed a live stream check on version 0.163.0, including a character-by-character message whose final hash matched the original visible text. It discovers only the caller's existing Codex daemon, or uses an explicitly supplied socket. The thread ID comes from `task_plan.conversation_id`, `MYCHROME_VISIBLE_THREAD_ID` or the Codex runtime's `CODEX_THREAD_ID`; do not guess it. The adapter first verifies the exact thread is active with `thread/read(includeTurns: false)`, then rejoins it using `thread/resume(excludeTurns: true)` to observe future public messages. It never starts a thread or model turn, overrides settings, or loads earlier turns. This uses the [official app-server protocol](https://learn.chatgpt.com/docs/app-server). Other MCP clients do not automatically expose this stream. Missing, incompatible or disconnected sources are reported as unavailable instead of replaced with generated progress.

Always finish or abandon the plan explicitly:

```json
{"done":true}
```

The tool queue and user-idle wait run inside a pending call. Do not start a duplicate request because it is slow. Configure the MCP client to permit long calls; the README shows `tool_timeout_sec = 900` for Codex.

During takeover, ordinary physical input is intercepted and is not delivered to the page. Esc twice cancels the active agent, and another queued agent may then run. A cancelled task must wait for a new user instruction; do not create another plan to take control again automatically. The menu-bar pause is the user's way to stop all sessions from further action. Never override it. Do not mix MyChrome with an independent physical-input driver while either is acting.

## Hand off private input and challenges

For a password, verification code or another field the user must fill, use the observed field number:

```json
{"tab":123,"field":7,"reason":"Enter the verification code and press Return","minutes":10}
```

This highlights a standard text input/textarea and waits. It does not focus another application over the user's current work. The user can use the menu-bar button to reach it, type and press Return; multiline fields use Command+Return. A page transition may also end the wait, so read and verify the actual result.

For a challenge or a field that cannot be highlighted:

```json
{"tab":123,"reason":"Complete the site's verification in Chrome","minutes":3}
```

Waits last at most 10 minutes per call. If a wait times out and the user still intends to continue, call again. A timeout does not mean login succeeded or authorize a different login method. Do not ask the user to paste a password or one-time code into chat.

## Recover without duplicating actions

| Result or condition | Next action |
|---|---|
| `stale_marker` / `no_such_marker` | Read the tab again and use current markers. |
| No observable click change | Inspect the current page or screenshot before deciding whether to retry. |
| Partial typing / interrupted submission | Read the field, result or saved history. Resume only the missing action; avoid double submissions. |
| `input_unconfirmed` / `submit_unconfirmed` | Treat the action as failed. Inspect the intended field and do not mark its question or the overall task complete. |
| `task_interrupted` | The job remains unfinished. Inspect the page and reported cause before explicitly restarting; a user Stop still requires a new user instruction. |
| `site_blocked` | Stop input and use `wait_for_user`. No bypass or repeated probes. |
| `user_cancelled` | Stop. Wait for a new user instruction; do not retry automatically. |
| `paused_by_user` | Wait for the user to resume from the panel. |
| `taken_over` | Read the same tab to inspect its current state. Continue there only after a confirmed handoff; ask only if that intent is unclear. Do not open a duplicate entry page as a workaround. |
| `screen_locked` | Ask the user to unlock; `wake_screen` only wakes the display. |
| Permission / helper failure | Have the user run `node src/index.js doctor` from the launching application and follow its result. |
| Dialog blocks the page | Use `answer_dialog` with the exact reported button text, within the authorized task. |
| Covered target / wrong front window / display change | Follow the returned remedy, then refresh the page or screenshot. Never bypass coordinate/focus checks. |
| Queue call still pending | Wait on that call. Do not issue the same action again. |

A transport timeout is ambiguous: input might already have reached the page. Re-establish state before any retry. If a client moves a long typing call to the background, wait for that call’s completion; do not duplicate it or issue another input action while it is still running. Key-by-key typing follows the user’s chosen pace and can take several minutes for long text.

## Reuse a recorded website routine

The `routines` tool reads MyChrome's local website action metadata. Use `action: "history"` or `"snapshot"` with an optional exact website origin, query and limit. Save the returned event IDs in their original forward order, including every intervening action; candidate `eventIds` are already in that order. A saved range must stay within one session, tab, website, task and recording epoch, contain at most 50 eligible steps, and contain no failures, gaps or sensitive-input barriers. Do not reconstruct missing steps from conversation prose.

```json
{"action":"history","site":"https://example.com","limit":50}
```

```json
{"action":"save","name":"Search the catalogue","eventIds":["returned-first-event-id","returned-next-event-id"]}
```

Review the saved steps and returned `parameters`. Typed and selected values were not retained; supply fresh strings under the exact parameter names. Confirm the user's intended account, action and submission scope, and use an explicit existing tab at the recorded starting page. GUI input mode and speed remain authoritative. The runner uses existing guarded real input; it does not replace clicks or field entry with DOM writes and makes no model calls between steps.

```json
{"action":"start","id":"returned-routine-id","tab":123,"params":{"input_1":"sample search"},"nonce":"catalogue-run-unique-intent"}
```

`start` returns without waiting for completion; `run` waits for the same execution. Keep the nonce, worker identity and request body unchanged for that intent. On timeout or uncertain delivery, use `status` with the original nonce or run ID, never a fresh start. A changed body with the same nonce is refused. Graceful code hot-swap carries terminal receipts and request hashes without parameter values; pending or active execution prevents handover. A crash or restart without carry has no recovery ledger, so cross-restart automatic retry is unsupported. `run_not_found` is not proof that nothing was sent.

```json
{"action":"status","nonce":"catalogue-run-unique-intent"}
```

```json
{"action":"stop","nonce":"catalogue-run-unique-intent"}
```

Stop/Cancel leaves the request active until cleanup finishes. Do not infer cancellation from the request being accepted. `blocked` or partial input requires fresh page inspection and a deliberate next action, not automatic replay. `completed` establishes the routine's checked steps only; verify the actual saved business result before marking the whole task complete. A run inside an existing whole-task plan does not finish that plan.

The native **Website routines** page provides the same save, parameter, tab, status, stop, archive and recording controls without an AI request. Routine replay currently excludes iframe/shadow targets, ambiguous controls and nonstandard hash fragments; standard `#/path` and `#!/path` routes can be represented when their state is safe. Do not evade a refusal through a coordinate routine. See [website routines](routines.md) for storage and limitations.

## Example: an authorized practice test

1. Open the user-specified site/profile, read the page and verify the website's account identity.
2. Navigate through the site's controls to the chosen practice test. Confirm that completing and submitting this test is within the user's request.
3. Keep one plan for the whole attempt, including reading, answering, review, submission and saved-result verification. Read every prompt and current answer state; use `click`, `type_text` and `select_option` as appropriate. Do not generate separate overlay notes or guess question progress before opening the paper.
4. Check that every intended answer is present, including any skipped or failed field. Do not infer completion from a question number or successful focus click. Handle page dialogs using the exact buttons reported by the tool. Hand private login steps to the user.
5. Submit once. Read the result page, then inspect the site's saved attempt/history when available. Verify the account, test title and saved outcome before claiming completion.
6. Close the plan with `done: true`. Keep a result tab when the user needs it; close only owned tabs whose result is saved and which the user has not taken over. Closing may confirm leaving a page, so avoid discarding unsaved work.
7. Report how many tests were actually completed, which persistence checks passed, any reproduced bugs and remaining untested cases. Keep account identifiers and raw screenshots out of public artifacts.

## Privacy and evidence

Page text and screenshots are delivered to the MCP client. Local OCR does not make the returned data private from the AI provider. Read only the pages needed for the task and avoid exporting unrelated account data.

Keep credentials, local runtime files, browser state, full activity records and real-account screenshots outside Git. For issues, record sanitized reproduction steps, error codes, the code version and environment. Offline tests establish code behavior under the test harness; only an observed live run establishes that a particular real-site flow worked.

## Tool inventory

The server currently exposes 17 tools: `list_tabs`, `open_tab`, `close_tab`, `read_page`, `click`, `type_text`, `screenshot`, `click_at`, `press_key`, `hover`, `wake_screen`, `wait_for_user`, `answer_dialog`, `task_plan`, `select_option`, `scroll`, `routines`. Consult the connected tool schema for exact limits and arguments; do not infer an unsupported generic JavaScript or navigation tool.
