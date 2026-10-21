# MyChrome

**Keep browsing. Bring in AI when you need a hand.**

Use Chrome as you normally do. When you want help, ask your AI assistant to join you on the page and carry out the task, using the account, tabs and conversation you already have.

MyChrome gives the assistant access to that Chrome page and real mouse and keyboard input. When a password or verification code needs you, it hands the page back. Handle that step and tell the assistant to continue; it reads the page again and picks up the same task.

[Get started](docs/getting-started.md) · [简体中文](README.zh-CN.md) · [Website](https://shuaige121.github.io/mychrome-mcp/) · [FAQ](docs/faq/README.md)

[![Watch the 38-second MyChrome overview](site/assets/mychrome-overview-poster.webp)](https://shuaige121.github.io/mychrome-mcp/#film)

[Watch the film](https://shuaige121.github.io/mychrome-mcp/#film) · [MP4](site/assets/mychrome-overview.mp4) · [22-second GIF](site/assets/mychrome-overview.gif) · [English captions](site/assets/mychrome-overview.en.vtt)

Product UI rendering and animation reconstruction with example content; no real posts were made. The conversation-center sequence uses the supported Codex integration.

## At your pace

Choose key-by-key typing or paste, and adjust the pace of typing, mouse movement and scrolling from 0.5× to 3×. Your settings apply to subsequent actions.

For input closer to your own rhythm, **My habits** can optionally sample three minutes of your keyboard and mouse use and fit timing statistics for later input. This experimental feature has a use switch, resampling and deletion controls. It records rhythm statistics, not the text you type or a screen video.

## Tasks you can hand over

These are example requests, not verified case studies for the named platforms:

- **Organize your LinkedIn page.** “Use the LinkedIn page I have open. Tidy its introduction and sections using the wording we agreed on, then show me what changed.”
- **Check whether someone needs you.** “Look at my open Facebook page and check notifications and messages for people trying to reach me. Tell me who needs a response.”
- **Distribute an article you've written.** “Use this finished article and the platform versions I've supplied. Publish to the Facebook, 小红书, Reddit and LinkedIn accounts I specify, then report each result and its link.”

Give the page title or URL in your existing AI conversation. The assistant first reads the actual page to identify the target, then carries out the task you've authorized and checks the result. It asks when the target or required information is unclear, or the work needs a new decision.

MyChrome is a local MCP server with a native macOS app. It needs no Chrome extension or debugging port. Website compatibility depends on the page; a login or site challenge may need your help.

## Get started

You need an **Apple Silicon Mac, macOS 13+, Google Chrome in `/Applications`, Node.js 24+ (recommended), Git and Xcode Command Line Tools**. Node 20.19+ and 22.13+ are also supported. Install the command line tools with `xcode-select --install` if needed.

```bash
git clone https://github.com/shuaige121/mychrome-mcp.git
cd mychrome-mcp
bash scripts/setup.sh
```

Setup checks prerequisites, installs dependencies, builds the native helpers and installs MyChrome in `~/Applications`. It explains any missing permissions and prints the exact commands for connecting your AI client. Keep the checkout in a stable location: the app and client use it.

Follow the [getting-started guide](docs/getting-started.md) to grant permissions and connect a client. Then return to your AI conversation and the Chrome page you want help with. Source installation is the supported route; this release is not published to npm.

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

Open **Operation settings** for input modes, speed and optional habit sampling. Choose Paste for text that key-by-key input cannot represent, such as Chinese.

In **Website routines**, review recorded steps, save a suitable sequence, enter fresh values and explicitly select an existing tab. Replay stops if the page or target no longer matches. See the [routine guide](docs/routines.md) for supported controls and limits.

## Data and privacy

MyChrome runs locally. Page content returned through MCP is shared with your AI client and handled under that client's settings. Local operation records and routine metadata may reveal the websites you use. Routine recording is on by default and can be turned off; typed and selected values are not saved as replay defaults. Keep runtime records private. See [FAQ](docs/faq/README.md#what-stays-on-my-mac).

## Learn more

- [First-use guide](docs/getting-started.md) and [troubleshooting](docs/getting-started.md#troubleshooting)
- [AI agent guide](docs/ai-guide.md) — tools, tab selection and result verification
- [Conversation center](docs/conversation-center.md) · [Website routines](docs/routines.md) · [中文使用说明](docs/usage.zh-CN.md)
- [Release notes](docs/release/CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)

[MIT License](LICENSE) · Copyright 2026 Leonard Chow. MyChrome is an independent project, not affiliated with or endorsed by Google. Chrome is a trademark of Google LLC.
