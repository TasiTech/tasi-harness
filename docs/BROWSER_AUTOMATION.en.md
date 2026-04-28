# Browser Automation

[English](BROWSER_AUTOMATION.en.md) | [简体中文](BROWSER_AUTOMATION.zh-CN.md)

Tasi Harness provides built-in browser automation tools for web retrieval and page interaction.

## Tool Set

- `browser_open`
- `browser_state`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_wait`
- `browser_extract`
- `browser_close`

## Browser Modes

- `embedded`: page preview is rendered inside the app.
- `external`: pages can be surfaced in a managed system-browser preview flow.

## Typical Workflow

1. Open target page with `browser_open`.
2. Verify state/URL with `browser_state` when redirects are possible.
3. Wait for stable markers (`browser_wait`) before extracting.
4. Use `browser_scroll` for lazy-loaded content only when needed.
5. Extract bounded content via `browser_extract`.
6. Close session with `browser_close` when done.

## Reliability Notes

- Prefer stable, bounded extraction instead of full-page dumps.
- Preserve source URL evidence in results.
- Mark uncertain data clearly when the page is partially loaded or blocked.

