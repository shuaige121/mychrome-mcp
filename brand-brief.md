# MyChrome public content and design brief

## Audience and promise

For people who browse in Chrome as usual and want to bring their AI assistant into the same page whenever a task needs a hand. Their signed-in account, open tabs and existing conversation provide the starting point.

**English:** Keep browsing. Bring in AI when you need a hand.

**中文：** 你的 Chrome，随时多一双手。

The central story is shared work on the same page: the user asks for help, AI carries out the authorized task, a password or verification code goes back to the user, and AI rereads the page and resumes the original task after an explicit instruction to continue. Reading the page is how the assistant finds its place in the task, not the whole product promise.

Personal input habits are a main benefit. Users can choose typing or paste, tune the pace of keyboard, pointer and scrolling actions, and optionally sample their own keyboard and mouse rhythm. Describe habit sampling as an experimental statistical fit used for subsequent input, with use, resample and delete controls. Do not describe a complete behavioral clone or promise freedom from detection, 403 responses or account restrictions.

Use the user's actual kinds of requests: organize their LinkedIn page, check whether anyone is trying to reach them on Facebook, or distribute an already-written article to their specified Facebook, 小红书, Reddit and LinkedIn accounts. Label these as example requests. Name platforms neutrally; do not present the examples as completed cases or verified compatibility.

## Product facts

- Local MCP server and native macOS app; Apple Silicon, macOS 13+, Google Chrome, supported Node.js, Xcode Command Line Tools.
- Source installation. No npm installation command or hosted service promise.
- Codex and Claude Code can use browser tools. Supported Codex integrations can show live assistant text and accept replies; Claude has no live conversation/direct reply adapter in the native window.
- During takeover there is one shared pointer and keyboard. Double Esc cancels the active agent; global pause prevents new input actions.
- Input modes include task-selected input, key-by-key typing and paste. Speed settings run from 0.5× to 3× and affect typing, pointer movement and scrolling.
- Optional experimental **My habits** sampling lasts three minutes and fits rhythm statistics. Insufficient samples retain default parameters. It stores statistics rather than typed text or screen video.
- Passwords, verification codes and normal steps requiring the user are handed back. Resume the original task only after the user explicitly says to continue. Access denial and rate limits require stopping and reporting the actual restriction.
- Website routine recording is on by default. It stores local action metadata; fresh typed and selected values are supplied for each run. Page or target changes stop replay. Routine completion is not independent proof of a business outcome.
- No guaranteed website compatibility, task success, time/token savings, search ranking, reviews or usage counts.

## Existing visual context

The native app uses macOS system typography, light surfaces and semantic status colors. Its light-theme active blue is approximately `#1261AD` (`src/conversation-ui.swift`). There is no dedicated app icon file in the baseline source; a public mark may derive from the actual native symbol.

The website extends that context with ink `#172C3B`, warm paper `#F7F6F2`, white surfaces and blue `#145FA6`. Georgia is used sparingly for display headlines; body and interface use the system sans-serif stack. Typography, spacing and current product views carry the design. Never invent product controls, customer testimonials or verified outcomes.

## Task evidence and media

The synthetic practice fixture and previous launch media are engineering material. Keep them out of promotional links and the first-use path. The new film demonstrates bringing AI into an existing page, personal input settings, a handoff to the user, and explicit continuation of the original task.

Use recordings when available. Native views rendered with synthetic data and faithful HTML reconstruction of uncaptured layers are also authorized for this explainer; label them as interface rendering/reconstruction with example content. Match current controls and behavior, including the Codex-only conversation integration. Do not present a reconstructed scene as a real social post, successful verification or measured performance. Cursor tracking, focus, smooth zoom and editing may improve legibility without inventing capabilities.

Review all final media for personal accounts, conversations, notifications and private records before publication. Every meaningful image needs descriptive alt text; motion needs user control. Provide captions, a poster and a downloadable video; keep raw/private footage outside the public export.

## Content and accessibility

One primary action: Get started. Put prerequisites next to it. Guide users through installation, permissions and client connection, then back to the existing AI conversation and Chrome page. Ask for a page title or URL and a task. The assistant reads the actual page, identifies the target and proceeds within the authorized scope, asking only when information or a new decision is needed.

Show same-page handoff and resumption alongside personal input pace. Keep controls where people need them, and place specific access restrictions in the FAQ. Troubleshooting gives a next action. Do not require a new conversation, separate browser or local practice task to demonstrate the product's value.

Use semantic headings, visible keyboard focus, readable contrast, responsive layouts, plain-text code and native disclosure controls. Core content is available without JavaScript. English and Chinese pages link to their counterparts.

## Discoverability

Each page has a descriptive title, description, canonical URL and Open Graph metadata. Visible product facts back SoftwareApplication JSON-LD. The sitemap lists canonical HTML pages; relative links support the GitHub Pages project path. `llms.txt` is a reading guide, not a ranking mechanism. Keep published facts synchronized with the source release.

References: [Google SEO starter guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide), [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
