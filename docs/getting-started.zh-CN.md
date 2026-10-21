# 开始使用 MyChrome

[首页](../README.zh-CN.md) · [English](getting-started.md) · [完整使用说明](usage.zh-CN.md)

安装 MyChrome、连接 AI 客户端，再用内置离线页面完成一次小任务。

## 1. 检查环境

- Apple Silicon Mac，macOS 13 或更新版本。
- [Google Chrome](https://www.google.com/chrome/) 位于 `/Applications/Google Chrome.app`。
- 推荐 [Node.js](https://nodejs.org/en/download) 24+，选择带 npm 的 Apple Silicon（arm64）版本。也支持 Node 20.19+、22.13+。
- Git 和 Xcode Command Line Tools。缺少时运行 `xcode-select --install`，并完成系统安装窗口中的步骤。
- Codex、Claude Code 等本机 MCP 客户端及其模型访问权限。

## 2. 安装源码

选一个准备长期保留的目录，运行：

```bash
git clone https://github.com/shuaige121/mychrome-mcp.git
cd mychrome-mcp
bash scripts/setup.sh
```

安装程序检查环境、安装依赖、编译辅助程序，将 MyChrome App 安装到 `~/Applications`，然后检查权限。客户端配置和系统权限仍由你决定。如果提示已安装但权限尚不完整，先完成下一步。

安装后会打开 MyChrome，首次使用时显示入门引导。跳过或关闭后，可以通过顶部问号按钮或菜单中的**入门引导**重新打开。

App 和 MCP 客户端会引用这个源码目录，请保留其位置。当前版本通过源码安装，尚未发布到 npm。

仅检查现有目录，不安装或更改设置：

```bash
bash scripts/setup.sh --check
```

## 3. 允许访问 Chrome

在 Chrome 中开启 **View → Developer → Allow JavaScript from Apple Events**。需要使用的每个 Chrome profile 都应开启。

打开 **系统设置 → 隐私与安全性**，为启动 MyChrome 的应用授权。它可能是 Terminal，也可能是桌面 AI 客户端，以诊断结果指出的应用为准。

| 权限 | 用途 |
|---|---|
| 自动化 → Google Chrome | 通过 Apple Events 读取和控制 Chrome |
| 辅助功能 | 真实鼠标与键盘输入 |
| 屏幕录制 | 截图和本机文字识别 |
| 输入监控 | 可选的个人操作节奏录制；首次练习不需要 |

如果系统要求重启应用，重启对应应用，再从实际启动 MCP server 的同一应用运行：

```bash
node src/index.js doctor
```

尚未出现自动化提示时，可用 `node src/index.js doctor --ask` 请求系统提示；`--open` 打开相关设置页。授权由你在系统界面中完成。

## 4. 连接 AI 客户端

生成适合当前 Node 和源码目录的准确命令：

```bash
bash scripts/setup.sh --instructions
```

选择 **Codex** 或 **Claude Code** 部分，运行打印出的注册命令。如果已有名为 `mychrome` 的配置，先确认它指向哪里再替换。其他 stdio MCP 客户端使用打印出的 Node 绝对路径和 `src/index.js` 路径。

使用 **Codex** 时，还需把打印的 TOML 设置应用到 `~/.codex/config.toml` 中已有的 MyChrome 项，设置 `startup_timeout_sec = 30` 和 `tool_timeout_sec = 900`，不要建立同名重复项。较长的超时让排队与人工接手有时间完成。

新开一个 AI 客户端会话，让它用 MyChrome 列出 Chrome 标签页。如果已关闭 MyChrome，可通过 Spotlight 或 Finder 重新打开原生窗口。

| 客户端 | 浏览器工具 | MyChrome 窗口中的实时文字与直接回复 |
|---|---|---|
| Codex | 支持 | 需要支持的本机集成和已关联会话 |
| Claude Code | 支持 | 暂不支持；继续在 Claude Code 中对话 |
| 其他本机 stdio MCP 客户端 | 使用生成的绝对路径连接 | 未提供适配器 |

会话窗口没有文字，不一定表示浏览器工具未连接。Codex 会话关联方法见[会话窗口指南](conversation-center.md)。

## 5. 完成一个本地任务

启动内置练习页并在 Chrome 中打开：

```bash
node examples/first-task/serve.mjs --open
```

命令只在 `127.0.0.1` 启动服务，打开 Chrome 并打印本次准确的 URL。练习期间保持终端打开；Control-C 可停止服务，30 分钟后也会自动停止。页面只用虚构内容，不向外部服务发送信息。可复制页面下方附带本次 URL 的请求，或告诉助手：

> 用 MyChrome 操作当前打开的本地练习页。先读周末计划，把内容填成 “Visit the weekend market”，选择 “Saturday morning”，点击 “Save practice plan”。再读取页面上保存后的结果，准确告诉我保存了什么。

观察页面变化。只有保存结果显示了指定内容和时间，才算完成；刷新练习页即可重置。用到真实网站时，明确标签页和目标，先确认网站当前账号，再让助手在变更后核对结果。

## 随时接回控制

- **立即停止：** 在 0.8 秒内连按两次 Esc，取消当前 AI 并收回键鼠。AI 需要你的新指令才能再次接管。
- **暂停所有连接：** 收回控制后，在 MyChrome 中打开**暂停 AI 操作**，阻止后续输入。
- **选择输入方式：** 在**操作设置**中选择**跟随任务**、**逐字输入**或**粘贴**，速度可调为 0.5×–3×。明确选择对下一次操作生效，优先于 AI 参数。中文等逐字模式不支持的文字请选择粘贴。
- **处理私密输入：** 密码、验证码和网站验证由你接手，完成后再决定是否继续。
- **保存重复步骤：** 在**网站流程**检查记录并保存连续片段。每次运行提供新参数、明确选择现有标签页。[流程指南](routines.md)。

接管期间普通物理输入会被拦截，请用双 Esc，不要依赖点击停止按钮。停止不会撤销已发出的文字、点击或提交。

## 常见故障

| 遇到的问题 | 下一步 |
|---|---|
| Mac 或 Node 不受支持 | 对照上方要求更新环境。当前构建不支持 Intel Mac、Rosetta Node、Windows、Linux 或其他浏览器。 |
| 缺少 Command Line Tools | 完成 `xcode-select --install` 后重跑安装。 |
| 已勾选权限但仍失败 | 检查 `doctor` 指出的应用，按系统要求重启，再从实际启动应用运行诊断。 |
| 已有 MyChrome App 属于另一个源码目录 | 保留原安装；继续使用原目录，或通过 `--app-path` 指定新的绝对路径安装独立副本。 |
| MCP 找不到 Node | 重新生成连接说明，使用 Node 绝对路径；桌面应用的 PATH 可能不同。 |
| Codex 工具超时 | 在现有配置项设置 `tool_timeout_sec = 900`，新开客户端会话。 |
| Claude 工具正常，MyChrome 对话区为空 | 继续在 Claude Code 对话；MyChrome 暂未提供 Claude 实时文字和直接回复适配器。 |
| 中文被逐字模式拒绝 | 在操作设置选择**粘贴**，读取当前输入框后再重试。 |
| 页面改变或结果不确定 | 先读取当前页面，确认原操作是否已经生效。 |
| 登录、CAPTCHA 或访问验证 | 在网站允许的范围内自行处理，再决定是否继续；MyChrome 不绕过验证。 |

仍有问题见[支持说明](../SUPPORT.md)。提供去除私人信息的小型复现，不要上传账号截图或运行记录。
