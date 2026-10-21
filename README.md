# MyChrome

**Your browser is already open. Let your AI help you finish the task.**

MyChrome connects your AI assistant to the Google Chrome you already use on your Mac. Keep your signed-in pages and context. Ask it to read a page, fill a form or work through a task using real mouse and keyboard input, then take over whenever you need to.

[Get started](docs/getting-started.md) · [简体中文](README.zh-CN.md) · [Website](https://shuaige121.github.io/mychrome-mcp/) · [FAQ](docs/faq/README.md)

[![Watch the local practice demo: enter a plan, choose a time, save and verify the result](site/assets/mychrome-practice-poster.webp)](site/assets/mychrome-practice.gif)

**Click the image to play the real local practice demo.** About 27 seconds · 2× speed · pauses trimmed · browser toolbar cropped. Synthetic practice content. [Watch on the website with a Stop control](https://shuaige121.github.io/mychrome-mcp/#demo).

## What you can do

- **Continue where you are.** Give your assistant the page and the outcome, without moving your work into a separate browser session.
- **Get help with everyday steps.** Read information, enter details, choose options and verify the result on the page.
- **Keep control.** Press **Esc twice quickly** to cancel the active agent. Use **Pause AI actions** to prevent further input across agents.
- **Reuse suitable steps.** Save a continuous sequence as a website routine, supply fresh values and choose a tab for the next run.

MyChrome is a local MCP server with a native macOS app. It needs no Chrome extension or debugging port. Website compatibility depends on the page; a login or site challenge may need your help.

## Get started

You need an **Apple Silicon Mac, macOS 13+, Google Chrome in `/Applications`, Node.js 24+ (recommended), Git and Xcode Command Line Tools**. Node 20.19+ and 22.13+ are also supported. Install the command line tools with `xcode-select --install` if needed.

```bash
git clone https://github.com/shuaige121/mychrome-mcp.git
cd mychrome-mcp
bash scripts/setup.sh
```

Setup checks prerequisites, installs dependencies, builds the native helpers and installs MyChrome in `~/Applications`. It explains any missing permissions and prints the exact commands for connecting your AI client. Keep the checkout in a stable location: the app and client use it.

Follow the [getting-started guide](docs/getting-started.md) to grant permissions, connect a client and complete the included offline practice task. Source installation is the supported route; this release is not published to npm.

<details>
<summary>Preview the native first-run guide</summary>

![MyChrome first-run guide in its native macOS window](site/assets/mychrome-workspace.webp)

</details>

## Works with your assistant

| Capability | Codex | Claude Code | Other local MCP clients |
|---|---|---|---|
| Read and operate Chrome | Yes | Yes | Requires stdio MCP support |
| Hand a page back to you | Yes | Yes | Via the browser tools |
| Live assistant text and replies in MyChrome | Supported Codex integration and associated thread required | Not available | No adapter provided |

MyChrome runs on the Mac whose Chrome it controls. Your AI client provides the model and its own account or subscription.

The getting-started guide supports English and Chinese; the main workspace currently uses Chinese labels.

## Sharing the desktop

AI input uses your Mac's real pointer and keyboard. During takeover, ordinary physical input is intercepted. **Double Esc** returns control; the agent must wait for a new instruction before taking over again. Stop does not undo actions already sent. Reads can happen concurrently, while physical actions take turns.

In **Operation settings**, choose **Follow task**, **Type key by key** or **Paste**, and adjust the pace. Your explicit choice applies to the next action, including website routines. Choose Paste for text that key-by-key input cannot represent, such as Chinese.

In **Website routines**, review recorded steps, save a suitable sequence, enter fresh values and explicitly select an existing tab. Replay stops if the page or target no longer matches. See the [routine guide](docs/routines.md) for supported controls and limits.

## Data and privacy

MyChrome runs locally. Page content returned through MCP is shared with your AI client and handled under that client's settings. Local operation records and routine metadata may reveal the websites you use. Routine recording is on by default and can be turned off; typed and selected values are not saved as replay defaults. Keep runtime records private. See [FAQ](docs/faq/README.md#what-stays-on-my-mac).

## Learn more

- [First-use guide](docs/getting-started.md) and [troubleshooting](docs/getting-started.md#troubleshooting)
- [AI agent guide](docs/ai-guide.md) — tools, tab selection and result verification
- [Conversation center](docs/conversation-center.md) · [Website routines](docs/routines.md) · [中文使用说明](docs/usage.zh-CN.md)
- [Release notes](docs/release/CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)

[MIT License](LICENSE) · Copyright 2026 Leonard Chow. MyChrome is an independent project, not affiliated with or endorsed by Google. Chrome is a trademark of Google LLC.
