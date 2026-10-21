# Your first local task

This synthetic page gives you a small, verifiable first success: read, type, choose, save, and read the result back. It uses no accounts, external services, cookies or persistent storage.

After setup, start the practice from the MyChrome welcome guide or run this command in your source directory:

```bash
node examples/first-task/serve.mjs --open
```

The command serves only on `127.0.0.1`, opens Google Chrome, and prints the exact local URL. Keep the terminal open while you practice. Press Control-C to stop; it also stops after 30 minutes. Each start gets a new port. `--json` prints one machine-readable startup record; omit `--open` when a test harness will open the URL itself.

Paste the request shown on the page into your connected AI client. It includes that page's exact URL. Ask the AI to enter **Visit the weekend market**, choose **Saturday morning**, press **Save practice plan**, then verify both values in the **Practice plan saved** result. For the native dropdown, use MyChrome's `select_option` tool.

Success means the visible saved result matches both requested values. The guide does not mark the task complete automatically. The result exists only in that page's memory; reloading clears it. The form never sends a request or creates a real booking or message.

Press Esc twice quickly (within 0.8 seconds) while the AI acts to stop input and take control. During a held action, ordinary mouse and keyboard input may be intercepted. Ask the AI to continue when you are ready. If a permission or browser check fails, use the welcome guide's check button or run `node src/index.js doctor` from the application that starts your MCP server.

## 中文

这是一个完全本地的练习：读取网页、输入计划、选择时间、点击保存，再读取保存结果。页面只使用虚构内容，不需要任何账号。运行上面的命令后，把页面下方的请求复制给已连接 MyChrome 的 AI 客户端。

确认保存结果显示 **Visit the weekend market** 和 **Saturday morning**，才算完成这次练习。刷新页面会清空结果；终端按 Control-C 可停止练习服务，服务最长运行 30 分钟。操作期间快速按两次 Esc（0.8 秒内）可以停止并接管；保持输入控制时，普通鼠标和键盘操作可能会被拦截。准备好后再请 AI 继续。
