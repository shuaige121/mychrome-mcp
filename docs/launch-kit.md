# MyChrome launch kit — drafts

Draft copy for review; nothing in this kit has been posted. These drafts describe capabilities available in 0.15.0.

## One line

Let Codex or Claude Code work in your own logged-in Google Chrome on macOS, with real mouse and keyboard input and handoff when a step needs you.

## Short description

MyChrome is a local MCP server with a native macOS app. Codex, Claude Code and other local stdio MCP clients can work in your existing Google Chrome tabs and signed-in accounts. Real mouse and keyboard input, adjustable pace and same-page handoff support work that needs your own session. MyChrome is open source under the MIT License.

## Show HN draft

**Title:** Show HN: MyChrome — let AI work in your logged-in Chrome on macOS

MyChrome is a local MCP server with a native macOS app for work that needs your own Google Chrome, login or shared page. It connects Codex, Claude Code and other local stdio MCP clients to the Chrome you already use.

- Pages are read through Chrome's “Allow JavaScript from Apple Events” setting; no extension, remote debugging port or separate browser profile is needed.
- Clicks, typing and scrolling use the Mac's real mouse and keyboard. During takeover, ordinary physical input is intercepted and a card shows the task, steps, time left and speed.
- Press Esc twice within 0.8 seconds to stop the current agent. Another takeover needs a new instruction; stopping does not undo actions already sent. The pause control blocks further input from all connections.
- Passwords and verification codes come back to you. The assistant should wait for an explicit “continue” in the original conversation, then reread the page. Continuation follows the assistant's instructions; MyChrome does not enforce a cross-client continuation gate.
- Choose follow-task, key-by-key or paste input and a speed from 0.5× to 3×. Optional personal input habit sampling is experimental: a 3-minute sample supplies timing statistics, with defaults kept where samples are insufficient.

In 0.15.0, a terminal Claude Code session connected to MyChrome appears as a read-only mirror of prompts and reply text from connection time. The takeover sidebar shows reply text. Thinking, tool calls and tool results are excluded. You reply in the terminal. Mirror text stays in memory only. It is on by default; set `CHROME_BRIDGE_CLAUDE_FEED=0` in the MCP server's environment and reconnect the MCP client to turn it off.

For public pages, MyChrome's instructions prefer an API or web fetch; for JavaScript pages without a login, headless Playwright. Sites may restrict automation: MyChrome stops and hands over at CAPTCHAs or bot checks and does not solve them. On access denial or rate limits, the assistant should stop and report. Compatibility depends on the site, account permissions and current page.

Requirements: Apple Silicon, macOS 13+, Google Chrome in `/Applications`, native arm64 Node.js (24+ recommended; 20.19+ and 22.13+ supported), Git and Xcode Command Line Tools. Install from source; MyChrome is not published to npm. In 0.15.0, MyChrome's windows and notifications follow your Mac's language (English or Chinese), with a Language setting under Settings in the menu bar panel.

MyChrome runs locally. Page content returned through MCP goes to the AI client and is handled under its settings. The client provides model access through its own account; its charges or subscription may apply.

[MIT-licensed source](https://github.com/shuaige121/mychrome-mcp) · [Source installation and permissions](https://shuaige121.github.io/mychrome-mcp/getting-started.html)

## X / Twitter thread draft

1/ MyChrome lets Codex or Claude Code work in your own Google Chrome on macOS: existing tabs, signed-in accounts, real mouse and keyboard. Local MCP server and native app. Source: https://github.com/shuaige121/mychrome-mcp

2/ Passwords and verification codes come back to you. The assistant should wait for “continue” in the original conversation, then reread the page. Continuation follows assistant instructions; MyChrome does not enforce a cross-client continuation gate.

3/ During takeover, ordinary input is intercepted. Press Esc twice within 0.8 seconds to stop the current agent. A new instruction is needed before another takeover. Stopping does not undo actions already sent.

4/ MyChrome stops at CAPTCHAs and bot checks and hands over; it does not solve them. On access denial or rate limits, the assistant should stop and report. Website compatibility depends on the site, account permissions and current page.

5/ Choose input mode and speed from 0.5× to 3×. Apple Silicon, macOS 13+, Google Chrome; source install, not npm. MIT License. AI client model access may have charges. Setup: https://shuaige121.github.io/mychrome-mcp/getting-started.html

## Reddit draft

**Title:** MyChrome: a local MCP server for your logged-in Google Chrome on macOS

MyChrome lets Codex, Claude Code or another local stdio MCP client work in the Google Chrome you already use. It uses the Mac's real mouse and keyboard, with a takeover card showing the task and steps. During takeover, ordinary input is intercepted. Press Esc twice within 0.8 seconds to stop the current agent; stopping does not undo prior actions.

Example requests, not verified case studies: update your LinkedIn page with details you provide; check Facebook notifications and messages for people trying to reach you; publish an article you wrote to the Facebook, Xiaohongshu, Reddit or LinkedIn accounts you specify.

The assistant hands personal steps back to you and should wait for an explicit “continue” in the original conversation. Continuation follows assistant instructions; MyChrome does not enforce a cross-client continuation gate. At a CAPTCHA or bot check it stops and hands over, without solving it. On access denial or rate limits, the assistant should stop and report. Compatibility depends on the site, account permissions and current page.

Apple Silicon and macOS 13+; Google Chrome only; source installation, not npm. In 0.15.0, MyChrome's windows and notifications follow your Mac's language (English or Chinese), with a Language setting under Settings in the menu bar panel. Page content returned through MCP goes to your AI client under its settings; client model access may have charges.

[MIT-licensed source](https://github.com/shuaige121/mychrome-mcp) · [MyChrome FAQ](https://shuaige121.github.io/mychrome-mcp/faq.html)

## Product Hunt draft

**Name:** MyChrome

**Tagline:** Let AI work in your own Google Chrome on macOS

**Description:** A local MCP server and native macOS app. Codex and Claude Code work in your existing Google Chrome tabs and signed-in accounts, with real mouse and keyboard input. Press Esc twice within 0.8 seconds to stop. MIT-licensed source.

**First comment:** MyChrome is for work that needs your own Chrome, login or shared page. It needs no extension, remote debugging port or separate browser profile. Passwords and verification codes come back to you. The assistant should wait for an explicit continuation instruction; MyChrome does not enforce a cross-client continuation gate. It stops and hands over at CAPTCHAs or bot checks and does not solve them. On access denial or rate limits, the assistant should stop and report. Apple Silicon and macOS 13+; source installation, not npm. In 0.15.0, MyChrome's windows and notifications follow your Mac's language (English or Chinese), with a Language setting under Settings in the menu bar panel. Page content returned through MCP goes to the AI client; its model access may have charges.

## Media and links

Use the [English takeover animation](../site/assets/takeover-card-en.gif), captioned: “Rendered from MyChrome's own code with a sample task; not a screen recording.” The [brand card](../site/assets/social-card.png) is the existing English sharing image. The Chinese-interface overview film is for Chinese surfaces only.

- [Product website](https://shuaige121.github.io/mychrome-mcp/)
- [Source installation and permissions](https://shuaige121.github.io/mychrome-mcp/getting-started.html)
- [MIT License](../LICENSE)
