# MyChrome public content and design brief

## Audience and promise

For people whose work already lives in signed-in Chrome tabs and who want their AI assistant to help finish it. The entry point is an existing page and a concrete outcome.

**English:** Your browser is already open. Let your AI help you finish the task.

**中文：** 浏览器已经打开，让 AI 帮你把事情做完。

Supporting ideas: keep the page and login context; use real keyboard and mouse input; hand control back easily; save suitable repeated steps as website routines. Examples describe possible tasks, not verified compatibility with named platforms.

## Product facts

- Local MCP server and native macOS app; Apple Silicon, macOS 13+, Google Chrome, supported Node.js, Xcode Command Line Tools.
- Source installation. No npm installation command or hosted service promise.
- Codex and Claude Code can use browser tools. Supported Codex integrations can show live assistant text and accept replies; Claude has no live conversation/direct reply adapter in the native window.
- During takeover there is one shared pointer and keyboard. Double Esc cancels the active agent; global pause prevents new input actions.
- Website routine recording is on by default. It stores local action metadata; fresh typed and selected values are supplied for each run. Page or target changes stop replay. Routine completion is not independent proof of a business outcome.
- No guaranteed website compatibility, task success, time/token savings, search ranking, reviews or usage counts.

## Existing visual context

The native app uses macOS system typography, light surfaces and semantic status colors. Its light-theme active blue is approximately `#1261AD` (`src/conversation-ui.swift`). There is no dedicated app icon file in the baseline source; a public mark may derive from the actual native symbol.

The website extends that context with ink `#172C3B`, warm paper `#F7F6F2`, white surfaces and blue `#145FA6`. Georgia is used sparingly for display headlines; body and interface use the system sans-serif stack. Typography, spacing and real captures carry the design. No fabricated app panels, testimonials or status indicators.

## Media contract

- `assets/mychrome-workspace.webp`: actual native MyChrome first-run guide in an isolated fresh state.
- `assets/mychrome-practice.gif`: actual local first-task interaction at 2× speed, with waiting intervals removed and browser toolbar cropped; those edits are stated in its visible caption.
- `assets/mychrome-practice-poster.webp`: one actual frame from the synthetic local practice page.
- `assets/social-card.png`: 1200 × 630 social preview with title and real capture.
- Optional `assets/logo.svg`: derived from the native product symbol.

Demo playback is opt-in, with a static poster and a stop control. Every meaningful image has descriptive alt text. Captures exclude personal accounts, conversations, profile names, desktop notifications and private records.

## Content and accessibility

One primary action: Get started. Put prerequisites next to it. Guide users through prerequisites, installation, permissions, client connection and the offline first task. Explain controls where people need them. Troubleshooting gives a next action.

Use semantic headings, visible keyboard focus, readable contrast, responsive layouts, plain-text code and native disclosure controls. Core content is available without JavaScript. English and Chinese pages link to their counterparts.

## Discoverability

Each page has a descriptive title, description, canonical URL and Open Graph metadata. Visible product facts back SoftwareApplication JSON-LD. The sitemap lists canonical HTML pages; relative links support the GitHub Pages project path. `llms.txt` is a reading guide, not a ranking mechanism. Keep published facts synchronized with the source release.

References: [Google SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
