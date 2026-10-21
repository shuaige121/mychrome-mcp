# When should I use MyChrome or a headless browser?

Use MyChrome when your task depends on an existing signed-in Chrome tab or when you want to share the same page with your assistant. It reads through Chrome Apple Events and acts through the real pointer and keyboard on your Mac.

For a public page or API, a web fetch may be enough. For a JavaScript page that does not need your existing session, a headless browser such as Playwright can work in the background without taking over the desktop.

| Need | Starting point |
|---|---|
| Read public information or an API | Web fetch or the API |
| Test a JavaScript page in a separate browser | Headless browser automation |
| Continue work in your own signed-in Chrome tab | MyChrome |
| Share the page and take over during the task | MyChrome |
| Complete a CAPTCHA or site access check | The user, following the site's normal process |

MyChrome requires Apple Silicon macOS and Google Chrome. It shares one physical pointer and keyboard: reads may run concurrently, while input takes turns. Website compatibility still depends on the actual page and permissions; MyChrome does not guarantee access to a site.
