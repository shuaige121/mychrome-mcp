# MyChrome FAQ

[Get started](../getting-started.md) · [Home](../../README.md)

## What is MyChrome?

A local MCP server and native macOS app that let an AI assistant read and operate the Google Chrome you already use. It uses Chrome Apple Events for page access and real mouse and keyboard input for actions. No Chrome extension or debugging port is needed.

## Which computers and clients work?

Apple Silicon Macs running macOS 13+ with Google Chrome, supported Node.js and Xcode Command Line Tools. Codex and Claude Code support the browser tools; other local stdio MCP clients can use the generated connection paths. The native conversation text/reply integration requires supported Codex integration and an associated thread. Claude live text and direct replies are not available in the MyChrome window.

## Can it use my existing login?

Yes, it operates your installed Chrome. Ask your assistant to use the exact existing tab and confirm the account displayed by the website before making changes. A Chrome profile and a website account are not necessarily the same identity. [Claude Code setup](use-my-logged-in-chrome-with-claude-code.md).

## Does it work on every website?

No. Compatibility depends on the site's controls, permissions and current page state. A site may require you to log in or handle a challenge. Named-platform compatibility needs a real test of that workflow; the local practice demo does not establish it. [Site challenges](what-happens-at-a-captcha.md).

## How do I stop it?

Press Esc twice quickly, within 0.8 seconds, to cancel the current agent and return keyboard and mouse control. The agent must wait for a new instruction before taking over again. To prevent new input across agents, use Pause AI actions after control is returned. Stopping does not undo actions already sent.

## Can I use the mouse while it works?

During takeover, ordinary physical input is intercepted. There is one pointer and keyboard on the desktop, and agent input takes turns. Reading can happen concurrently. Use double Esc when you need to take over.

## What stays on my Mac?

MyChrome's settings, operation records and website routine metadata are local. Routine recording is enabled by default and can be turned off. It records filtered page/target descriptions and action order; typed and selected values are not saved as replay defaults. Paths, labels and routine names may still reveal usage context. Page content returned through MCP goes to your AI client and is handled under its settings. Do not share runtime directories or account screenshots.

## What are website routines?

Saved continuous sequences of supported website actions. Review the steps, enter fresh values and select an existing tab for each run. Replay uses the same guarded input path without model calls between steps and stops when the page or target no longer matches. It does not support every control or prove an external business result. [Full routine guide](../routines.md).

## Is it free?

The project is open source under the [MIT License](../../LICENSE). Your AI client supplies model access, and its own charges or subscription may apply. This release uses source installation and is not published to npm.

## Should I use it for every page?

Choose the tool that fits the task. Public information often needs only an API or web fetch; headless browser automation suits JavaScript pages without your personal session. MyChrome is useful when your existing Chrome context or shared page matters. [Choosing a browser tool](mychrome-or-playwright.md).

## Does it always save tokens?

There is no general savings guarantee. Page reads can return an outline or focused text instead of an image; actual model usage depends on the page, client and task. [How page reading works](how-it-saves-tokens.md).
