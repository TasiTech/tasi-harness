---
name: tasi-browser-automation
description: Use browser tools to open webpages, interact with elements, and extract page content in the browser automation session.
category: browser
---

# Tasi Browser Automation

Use this skill when the user needs web actions through Tasi Harness browser automation.

In external browser mode, treat these browser tools as the default plan and rely on the harness-managed external preview window when needed.

## Tooling

Use these browser tools:

- `browser_open` to navigate to a URL.
- `browser_wait` to wait for selectors or a short delay after navigation.
- `browser_click` and `browser_type` to interact with controls.
- `browser_scroll` to load lazy content.
- `browser_extract` to capture text, HTML, or structured JSON from the full page or a selector.
- `browser_state` to verify current page location.
- `browser_close` to reset the browser session.

## Reliable Workflow

1. Open with `browser_open`.
2. Confirm state with `browser_state` if navigation is ambiguous.
3. Wait for critical selectors before clicking or typing.
4. Extract structured content with `browser_extract` and prefer `format=json` for page data you want to normalize.
5. Keep extraction bounded with `max_chars` and iterate if more detail is needed.

## Notes

- Prefer CSS selectors over brittle positional assumptions.
- If an interaction fails, re-check page state, then wait and retry once.
- In embedded mode, do not ask the user to install Chrome extensions for this flow.
- In external mode, use these browser tools and rely on `browser_preview_url` plus the harness external preview opener to surface the final page.
- This bundled skill is named `tasi-browser-automation` to avoid confusion with similarly named community skills.
