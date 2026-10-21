# MyChrome FAQ

[Get started](../getting-started.md) · [Home](../../README.md)

## What is MyChrome?

MyChrome lets you bring your AI assistant into the Chrome page you're already using when you need a hand. It can work on the task, hand control back when a step needs you, and resume after you explicitly tell it to continue. It runs as a local MCP server and native macOS app, using Chrome Apple Events and real mouse and keyboard input. No Chrome extension or debugging port is needed.

## Which computers and clients work?

Apple Silicon Macs running macOS 13+ with Google Chrome, supported Node.js and Xcode Command Line Tools. Codex and Claude Code support the browser tools; other local stdio MCP clients can use the generated connection paths. The native conversation text/reply integration requires supported Codex integration and an associated thread. Claude live text and direct replies are not available in the MyChrome window.

## Can it use my existing login?

Yes, it operates your installed Chrome. Give the page title or URL in your existing AI conversation. The assistant should read that tab and identify the website account before making changes; a Chrome profile and a website account are not necessarily the same identity. [Claude Code setup](use-my-logged-in-chrome-with-claude-code.md).

## How do I hand over a task?

Keep browsing normally. When you want help, tell your assistant which open page to use and what to do, referring to details already in the conversation. It should read the current page, carry out the authorized steps and check the result. It asks if the target is unclear, information is missing or a new decision is needed. [Start with your open page](../getting-started.md#5-continue-with-your-open-page).

For a password, verification code or challenge you can complete, take over that step and explicitly tell the assistant to continue afterward. It should reread the page and pick up the original task. [Handoff and site access](what-happens-at-a-captcha.md).

## Can it use my typing and mouse habits?

You can choose key-by-key input or paste and set the speed of typing, pointer movement and scrolling from 0.5× to 3×. The optional experimental **My habits** feature samples three minutes of your keyboard and mouse rhythm and fits timing statistics for later input. You can enable or disable their use, sample again or delete them. When there are too few samples for a parameter, the default remains in use. [Input settings](../getting-started.md#your-input-pace).

## Does it work on every website?

Compatibility depends on the site's controls, permissions and current page state. Task examples involving LinkedIn, Facebook, 小红书 or Reddit describe requests you can make; they are not verified coverage of those platforms. Input timing and habit sampling do not guarantee that a site will accept an action or avoid access checks. [Site access and restrictions](what-happens-at-a-captcha.md).

## How do I stop it?

Press Esc twice quickly, within 0.8 seconds, to cancel the current agent and return keyboard and mouse control. The agent must wait for a new instruction before taking over again. To prevent new input across agents, use Pause AI actions after control is returned. Stopping does not undo actions already sent.

## Can I use the mouse while it works?

During takeover, ordinary physical input is intercepted. There is one pointer and keyboard on the desktop, and agent input takes turns. Reading can happen concurrently. Use double Esc when you need to take over.

## What stays on my Mac?

MyChrome's settings, habit statistics, operation records and website routine metadata are local. Optional habit sampling stores timing statistics, not typed text or a screen recording. Routine recording is enabled by default and can be turned off. It records filtered page/target descriptions and action order; typed and selected values are not saved as replay defaults. Paths, labels and routine names may still reveal usage context. Page content returned through MCP goes to your AI client and is handled under its settings. Keep runtime directories private.

## What are website routines?

Saved continuous sequences of supported website actions. Review the steps, enter fresh values and select an existing tab for each run. Replay uses the same guarded input path without model calls between steps and stops when the page or target no longer matches. It does not support every control or prove an external business result. [Full routine guide](../routines.md).

## Is it free?

The project is open source under the [MIT License](../../LICENSE). Your AI client supplies model access, and its own charges or subscription may apply. This release uses source installation and is not published to npm.

## Should I use it for every page?

Choose the tool that fits the task. Public information often needs only an API or web fetch; headless browser automation suits JavaScript pages without your personal session. MyChrome is useful when your existing Chrome context or shared page matters. [Choosing a browser tool](mychrome-or-playwright.md).

## Does it always save tokens?

There is no general savings guarantee. Page reads can return an outline or focused text instead of an image; actual model usage depends on the page, client and task. [How page reading works](how-it-saves-tokens.md).
