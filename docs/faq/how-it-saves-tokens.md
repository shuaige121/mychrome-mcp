# How does MyChrome read pages?

MyChrome can return a page outline and visible text, search for a term, or focus on a section. This gives an assistant a way to inspect the relevant part of a page without always requesting a screenshot or the entire document.

For larger visible content, the reading path can use on-device Apple Vision text recognition or a screenshot. Those fallbacks require the page to be visible and the appropriate macOS permission. A background or covered page may instead return page content with a note about visibility.

There is no fixed token saving: usage depends on the page, request, image handling and AI client. The configured text threshold selects a reading form; it is not a hard cap on every response. Prefer a focused query when you know what information you need, and use screenshots when visual layout matters.

See the [AI agent guide](../ai-guide.md) for tool examples.
