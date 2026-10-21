# What happens at a CAPTCHA or site challenge?

MyChrome stops when it detects a CAPTCHA, bot check or access restriction and hands control back to you. It does not solve or bypass site challenges.

The assistant can use `wait_for_user` to request your help. Complete the site's normal steps yourself if permitted, then decide whether the task can continue. A login, verification code or challenge is not proof that the original action succeeded; the assistant should reread the page before continuing.

Detection is a safeguard, not a guarantee that every challenge will be recognized. You can always stop the active agent by pressing Esc twice quickly. See [your controls](../getting-started.md#your-controls).
