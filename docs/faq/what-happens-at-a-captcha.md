# How do passwords, verification and access restrictions work?

When a password, verification code or site challenge needs you, the assistant can use `wait_for_user` to hand the page back. Complete the site's normal step yourself, then explicitly tell the assistant to continue. It should read the current page again, check what changed and pick up the original task.

MyChrome stops when it detects a CAPTCHA, bot check or access restriction. A 403 response, denied access or rate limit means the assistant should stop and report what happened. It must not retry or switch tools to get around the restriction. Personal input timing is not a guarantee against detection or blocking.

Detection cannot recognize every challenge. You can stop the active agent by pressing Esc twice quickly. See [your controls](../getting-started.md#your-controls).
