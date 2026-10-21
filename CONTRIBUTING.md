# Contributing to MyChrome

Small, focused improvements are welcome: clearer first-use instructions, reproducible bug fixes, accessibility improvements and supported-browser workflows.

1. Read the [getting-started guide](docs/getting-started.md) and [AI agent guide](docs/ai-guide.md).
2. Open an issue for a substantial behavior change so its scope can be discussed.
3. Work on a branch. Keep changes focused and explain the user-visible behavior.
4. Run the smallest relevant test, then `npm test` for changes to shared behavior. Native changes also need `npm run build`. Run `git diff --check` before submitting.
5. Describe what you tested, including the macOS and Node versions, and any coverage limits.

Use synthetic pages and accounts for demonstrations. Do not include credentials, browser profiles, runtime records, conversation content or personal screenshots. Do not weaken tab ownership, user stop, permission, sensitive-field or access-challenge checks to make a test pass.

The project runs on Apple Silicon macOS. Some tests simulate browser state; passing those is not evidence that a particular live website works. Label real-device checks separately.

Public source exports follow [the distribution guide](docs/release/DISTRIBUTION.md). New files must be deliberately included in the release allowlist. Contributions are provided under the project's [MIT License](LICENSE).
