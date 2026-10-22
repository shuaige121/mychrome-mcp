# Get started with MyChrome

[Home](../README.md) · [简体中文](getting-started.zh-CN.md) · [FAQ](faq/README.md)

Install MyChrome, connect your AI client, then keep using Chrome as usual. When you need a hand, bring your assistant into the same page and task. You can handle a password or verification step yourself, then explicitly tell it to continue.

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
| Input Monitoring | Optional sampling of your keyboard and mouse rhythm |

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

After your client loads the connection, return to your task conversation and ask it to list Chrome tabs with MyChrome. If your client needs a restart to load new MCP servers, restart it and resume that conversation. If you closed MyChrome, reopen it from Spotlight or Finder to see its native window.

| Client | Browser tools | Live conversation text and replies in the MyChrome window |
|---|---|---|
| Codex | Supported | App-created sessions work directly; existing external sessions require a supported integration and association |
| Claude Code | Supported | App-created sessions work directly; existing external sessions remain in Claude Code |
| Other local stdio MCP client | Connect with the generated paths | No adapter provided |

To start from MyChrome, click **新对话 (New conversation)**, choose Codex or Claude Code, and select a model, supported thinking effort, and working folder. The model list comes from the installed CLI. The CLI must already be signed in; MyChrome uses its existing account, permissions and MCP configuration. Model and effort selections apply to this session without changing persistent client settings.

You can enter a first task or create an empty conversation. The App opens the exact new session, where you can send messages, see live assistant text and handle supported questions or approvals. If creating the session is slow, **检查创建结果 (Check creation result)** checks the same request rather than starting another session. A first message whose delivery is uncertain stays in that session's draft and is not automatically resent.

An empty external conversation view does not by itself mean the browser tools are disconnected. Existing Claude Code terminal sessions cannot be attached for live replies. See the [conversation center guide](conversation-center.md) for existing Codex thread association and App-created sessions.

## 5. Continue with your open page

Keep the relevant Chrome tabs open and return to the AI conversation where you're working on the task. Give the assistant the page title or URL and the outcome you want. You can refer to details already in the conversation.

For example, adapt this request to your page and task:

> Use MyChrome on my open Chrome page: [title or URL]. Read the current page, then use the details we discussed to [desired outcome]. Check the result. If a password or verification step needs me, hand the page back and wait until I tell you to continue.

Examples of requests you can make; these platform workflows have not all been verified:

- Organize your open LinkedIn page with the introduction and section text you've approved.
- Check your Facebook notifications and messages, and summarize who is trying to reach you.
- Distribute an article you've already written to the Facebook, 小红书, Reddit and LinkedIn accounts you specify, using your supplied platform versions and publishing instructions.

The assistant should read the actual page and identify the target before acting, including the displayed website account when relevant. It can then carry out the authorized steps without asking at each click. It should ask if the page is ambiguous, required information is missing or the task needs a decision you haven't made. After a change, it should read the result and report what is confirmed.

When you take over for a password or verification code, finish that step and explicitly tell the assistant to continue. It should reread the page and resume the original task. If the site denies access or rate-limits the task, it should stop and report the restriction. See [handoff and site access](faq/what-happens-at-a-captcha.md).

## Your input pace

In **操作设置 (Operation settings)**, choose **跟随任务 (Follow task)**, **逐字键盘输入 (Type key by key)** or **直接粘贴 (Paste)**. Adjust the speed from 0.5× to 3× to change the pace of typing, pointer movement and scrolling. Your explicit settings apply to subsequent actions. Use Paste for Chinese or other text unsupported by key-by-key input.

For a more personal rhythm, **我的操作习惯 (My habits)** offers optional three-minute sampling of your keyboard and mouse use. It fits timing statistics for later typing and movement. This feature is experimental; you can turn its use on or off, sample again or delete its data. It stores rhythm statistics rather than typed text or a screen recording.

## Your controls

The getting-started guide supports English and Chinese; the main workspace currently uses Chinese labels. Open **对话 (Conversations)** to see your connected conversations.

- **Stop now:** press Esc twice quickly, within 0.8 seconds. This cancels the current agent and returns the pointer and keyboard. A new instruction is required before another takeover.
- **Stop an App-created conversation:** use **停止生成 (Stop generation)** in its conversation view to interrupt current work. Closing or quitting MyChrome keeps the session running. Reopen the App to rejoin it while its backend process is alive; automatic recovery after backend exit is not supported.
- **Pause everyone:** after control is returned, use **暂停 AI 操作 (Pause AI actions)** in MyChrome to prevent further input across connections.
- **Handle a private field:** take over for passwords, verification codes and site challenges you can complete. Tell the assistant explicitly when to continue with the original task.
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
| Codex tool call times out | Apply `tool_timeout_sec = 900` to the existing server entry, reload the client configuration and resume your task conversation. |
| Existing Claude tools work but the MyChrome conversation is empty | Continue the external conversation in Claude Code. For a separate conversation with live replies in MyChrome, use **新对话 (New conversation)** and select Claude Code. |
| The chosen client or models cannot be loaded | Install and sign in to that CLI, confirm the working folder is available, then reload the model list. |
| Chinese or other text is refused in key mode | Choose **直接粘贴 (Paste)** in **操作设置 (Operation settings)**, then retry only after reading the current field. |
| Page changed or action result is uncertain | Read the current page before retrying. Check whether the original action already took effect. |
| Login, CAPTCHA or access check | Complete it yourself if the site permits, then decide whether the task can continue. MyChrome does not bypass site challenges. |

For help, use [Support](../SUPPORT.md). Share a small sanitized reproduction, not account screenshots or runtime records.
