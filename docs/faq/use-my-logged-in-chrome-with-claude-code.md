# Let Claude Code use your logged-in Chrome

MyChrome connects Claude Code to the Google Chrome on your Apple Silicon Mac. Your existing pages and website sessions remain available; actions use real mouse and keyboard input.

1. Follow the [getting-started guide](../getting-started.md) to install MyChrome and grant the requested permissions.
2. Run `bash scripts/setup.sh --instructions` inside the checkout.
3. Run the generated Claude Code registration command, which uses your absolute Node and source paths. Review any existing registration before replacing it.
4. Start a new Claude Code session and ask it to list your Chrome tabs using MyChrome.
5. Complete the [offline practice task](../getting-started.md#5-finish-one-local-task), then specify the exact existing tab and outcome for your own work.

Claude Code supports MyChrome's browser tools and page handoff. Live Claude conversation text and direct replies are not available in MyChrome's native window; continue the conversation in Claude Code.

Press Esc twice quickly to cancel active input. Before changes on a real website, confirm the website account, and check the result afterward.
