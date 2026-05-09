# Browser Automation

[English](BROWSER_AUTOMATION.en.md) | [简体中文](BROWSER_AUTOMATION.zh-CN.md)

Tasi Harness provides built-in browser automation tools for web retrieval and page interaction.

## Related Skills

- `tasi-browser-automation`: browser tool guidance that emphasizes `browser_snapshot` as an accessibility tree with actionable `@e` refs.
- `deep-search`: multi-engine deep search across Baidu, Google, Bing, DuckDuckGo, Sogou, 360, and other engines, with opened-page evidence extraction before answering.
- `tasi-travel`: itinerary planning skill that prefers Ctrip browser retrieval and preserves source citations.

## Tool Set

- `browser_open`
- `browser_state`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_wait`
- `browser_extract`
- `browser_snapshot` (accessibility-first tree with `@e` refs)
- `browser_find`
- `browser_hover`
- `browser_select`
- `browser_check`
- `browser_press`
- `browser_screenshot`
- `browser_pdf`
- `browser_storage`
- `browser_cookies`
- `browser_console`
- `browser_network`
- `browser_eval`
- `browser_viewport`
- `browser_close`

## Browser Modes

- `embedded`: page preview is rendered inside the app.
- `external`: browser tools attach to the managed Chromium-family browser over CDP, so clicks, snapshots, extraction, screenshots, storage, cookies, console, and network inspection operate against the external page. Safari/WebDriver and shell fallback remain preview-only paths.
- `browserHeadless`: optional setting for managed external CDP launches. When enabled, the browser window is hidden; inspect pages through `browser_snapshot`, `browser_extract`, and `browser_screenshot`.

## Typical Workflow

1. Open target page with `browser_open`.
2. Verify state/URL with `browser_state` when redirects are possible.
3. Use `browser_snapshot` to collect the accessibility/semantic tree and `@e` element refs before unfamiliar interactions.
4. Wait for stable markers (`browser_wait`) before extracting or interacting.
5. Prefer `browser_find` or `@e` refs for controls; use CSS selectors when they are stable.
6. Use `browser_scroll` for lazy-loaded content only when needed.
7. Extract bounded content via `browser_extract`.
8. Inspect `browser_console`, `browser_network`, `browser_storage`, or `browser_cookies` when debugging dynamic pages or auth state.
9. Close session with `browser_close` when done.

## Reliability Notes

- Prefer stable, bounded extraction instead of full-page dumps.
- Use `browser_snapshot.snapshot` as the primary action map; use `browser_extract` when you need content/body data.
- Preserve source URL evidence in results.
- Web-backed user answers should use numbered Markdown citations such as `[1](https://example.com/source)` so the UI can display referenced pages.
- Use screenshots/PDFs for visual evidence when text extraction is not enough.
- Mark uncertain data clearly when the page is partially loaded or blocked.
