# Let Claude Code use your logged-in Chrome

MyChrome lets Claude Code help on the Google Chrome page you're already using on your Apple Silicon Mac. Bring it into the task when needed, take over a step yourself, and explicitly tell it to continue afterward. Your pages, website sessions and task conversation stay part of the same workflow.

1. Follow the [getting-started guide](../getting-started.md) to install MyChrome and grant the requested permissions.
2. Run `bash scripts/setup.sh --instructions` inside the checkout.
3. Run the generated Claude Code registration command, which uses your absolute Node and source paths. Review any existing registration before replacing it.
4. After Claude Code loads the connection, return to your task conversation. If a restart is needed, resume that conversation afterward. Ask it to list your Chrome tabs using MyChrome.
5. Give the title or URL of your existing page and the outcome you want. Have it read the actual page, carry out the authorized task and check the result. [Continue with your open page](../getting-started.md#5-continue-with-your-open-page).

Claude Code supports MyChrome's browser tools and page handoff. Live Claude conversation text and direct replies are not available in MyChrome's native window; continue the conversation in Claude Code.

For a password or verification code, handle the step yourself and explicitly tell Claude to continue. It should reread the page and resume the same task. Press Esc twice quickly whenever you need to cancel active input.

Use MyChrome's **Operation settings** to choose input mode and pace. Optional experimental habit sampling can adapt later typing and mouse movement to your rhythm. [Input settings](../getting-started.md#your-input-pace).
