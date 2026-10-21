# Get started with MyChrome

[Home](../README.md) · [简体中文](getting-started.zh-CN.md) · [FAQ](faq/README.md)

Install MyChrome, connect your AI client, then try one task on the included offline practice page.

## 1. Check your Mac

- Apple Silicon Mac running macOS 13 or later.
- [Google Chrome](https://www.google.com/chrome/) installed at `/Applications/Google Chrome.app`.
- [Node.js](https://nodejs.org/en/download) 24 or later recommended, using the native Apple Silicon (arm64) build with npm. Node 20.19+ and 22.13+ are also supported.
- Git and Xcode Command Line Tools. Run `xcode-select --install` if the tools are missing, then finish the macOS installer.
- A local MCP client such as Codex or Claude Code, with its own model access.

## 2. Install from source

Choose a permanent folder for the checkout, then run:

```bash
git clone https://github.com/shuaige121/mychrome-mcp.git
cd mychrome-mcp
bash scripts/setup.sh
```

Setup checks prerequisites, runs the dependency installation and build, installs the native MyChrome app in `~/Applications`, and checks permissions. It does not change your AI client's configuration or grant macOS permissions for you. If it reports that installation succeeded but permissions need attention, complete the next step before trying a task.

Setup opens MyChrome after installation. On first use, its getting-started guide appears. If you skip or close it, reopen it from the question-mark button or **Getting started** in the menu.

Keep the checkout where it is: the app and MCP client reference it. This release is installed from source, not npm.

To check an existing checkout without installing or changing settings:

```bash
bash scripts/setup.sh --check
```

## 3. Allow Chrome access

Open Chrome and enable **View → Developer → Allow JavaScript from Apple Events** for each Chrome profile you intend to use.

In **System Settings → Privacy & Security**, grant the permissions requested for the application that launches MyChrome. That may be Terminal or your desktop AI client; use the diagnostics to identify it.

| Permission | What it enables |
|---|---|
| Automation → Google Chrome | Read and control Chrome through Apple Events |
| Accessibility | Real mouse and keyboard input |
| Screen Recording | Screenshots and on-device text recognition |
| Input Monitoring | Optional recording of your own input pace; not needed for the first task |

Restart the responsible application if macOS asks you to. Run the check from the same application that will launch the MCP server:

```bash
node src/index.js doctor
```

If Automation has not prompted yet, `node src/index.js doctor --ask` requests the prompt. `--open` opens the relevant settings page. These commands do not grant approval automatically.

## 4. Connect your AI client

Print the commands using your actual Node and checkout paths:

```bash
bash scripts/setup.sh --instructions
```

Choose the **Codex** or **Claude Code** instructions and run the printed registration command. Review an existing `mychrome` registration before replacing it. For another stdio MCP client, use the printed absolute Node executable and `src/index.js` path.

For **Codex**, also apply the printed TOML settings to the existing MyChrome entry in `~/.codex/config.toml`. Set `startup_timeout_sec = 30` and `tool_timeout_sec = 900`; do not create a second entry with the same name. The longer timeout lets queued actions and user handoffs finish.

Start a new AI client session and ask it to list Chrome tabs with MyChrome. If you closed MyChrome, reopen it from Spotlight or Finder to see its native window.

| Client | Browser tools | Live conversation text and replies in the MyChrome window |
|---|---|---|
| Codex | Supported | Requires a supported local Codex integration and an associated thread |
| Claude Code | Supported | Not available; continue the conversation in Claude Code |
| Other local stdio MCP client | Connect with the generated paths | No adapter provided |

An empty conversation view does not by itself mean the browser tools are disconnected. See the [conversation center guide](conversation-center.md) for Codex thread association.

## 5. Finish one local task

Start the included practice page and open it in Chrome:

```bash
node examples/first-task/serve.mjs --open
```

The command starts a server only on `127.0.0.1`, opens Chrome and prints the exact local URL. Keep the terminal open while you practice; Control-C stops the server, and it also stops after 30 minutes. The page uses synthetic content and sends nothing to an external service. Copy the request shown on the page, which includes this run's URL, or ask your assistant:

> Use MyChrome on the open local practice page. Read the weekend plan. Enter “Visit the weekend market”, choose “Saturday morning”, and click “Save practice plan”. Then read the visible saved result and tell me exactly what it says.

Watch the page as the assistant works. Completion means the visible saved result contains the requested plan and time. Refreshing the practice page resets it. For a website you use, give the assistant the specific tab and desired outcome, confirm the active website account, and have it verify the result after any change.

## Your controls

The getting-started guide supports English and Chinese; the main workspace currently uses Chinese labels. Open **对话 (Conversations)** to see your connected conversations.

- **Stop now:** press Esc twice quickly, within 0.8 seconds. This cancels the current agent and returns the pointer and keyboard. A new instruction is required before another takeover.
- **Pause everyone:** after control is returned, use **暂停 AI 操作 (Pause AI actions)** in MyChrome to prevent further input across connections.
- **Choose input:** in **操作设置 (Operation settings)**, use **跟随任务 (Follow task)**, **逐字键盘输入 (Type key by key)** or **直接粘贴 (Paste)**, with a pace from 0.5× to 3×. Your explicit choice overrides the agent for the next action. Use Paste for Chinese or other text unsupported by key-by-key input.
- **Handle a private field:** take over for passwords, verification codes and site challenges, then tell the assistant when to continue.
- **Reuse a sequence:** open **网站流程 (Website routines)**, inspect suitable recorded steps and save a continuous range. Supply fresh values and select an existing tab for each run. [Routine guide](routines.md).

During takeover, ordinary physical input is intercepted, so use double Esc instead of trying to click a stop button. Stopping does not undo text, clicks or submissions already sent.

## Troubleshooting

| What you see | Next step |
|---|---|
| Unsupported Mac or Node version | Compare with the requirements above. Install a supported Node version and rerun setup. Intel Macs, Rosetta Node, Windows, Linux and other browsers are not supported by this build. |
| Command Line Tools missing | Complete `xcode-select --install`, then rerun setup. |
| Permission still missing | Check the app named by `doctor`, restart that app if requested, and rerun `doctor` from the same launcher. |
| Existing MyChrome app belongs to another checkout | Keep that installation intact. Continue using its checkout, or use `--app-path` with a new absolute path for a separate installation. |
| MCP client cannot find Node | Regenerate instructions and use their absolute Node path; desktop apps may have a different PATH. |
| Codex tool call times out | Apply `tool_timeout_sec = 900` to the existing server entry and start a new client session. |
| Claude tools work but the MyChrome conversation is empty | Use Claude Code for the conversation. Live text and direct replies in MyChrome are not supported for Claude. |
| Chinese or other text is refused in key mode | Choose **直接粘贴 (Paste)** in **操作设置 (Operation settings)**, then retry only after reading the current field. |
| Page changed or action result is uncertain | Read the current page before retrying. Check whether the original action already took effect. |
| Login, CAPTCHA or access check | Complete it yourself if the site permits, then decide whether the task can continue. MyChrome does not bypass site challenges. |

For help, use [Support](../SUPPORT.md). Share a small sanitized reproduction, not account screenshots or runtime records.
