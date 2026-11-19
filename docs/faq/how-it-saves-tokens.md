# How does MyChrome read pages?

The first read returns top-level headings. Opening a section returns its own text and the next level of headings; nested content stays folded until requested. Controls appear once, with their click markers.

Repeated reads return changes in opened sections, or `unchanged`. The default 2500-token budget splits DOM feedback across reads instead of switching to a screenshot. A focused query can search folded content, and `full: true` explicitly requests the document. A new caller without the earlier context can use `refresh: true` to start at the top.

Only a page without readable DOM content, such as a canvas, needs the screen fallback. Capture requires a visible target and proven webpage bounds; tab and bookmark bars are excluded. Explicit `screenshot(image: true)` skips OCR, while the default screenshot call returns locally recognized text.

Token use still depends on the page, request and AI client. See the [AI agent guide](../ai-guide.md) for tool examples.
