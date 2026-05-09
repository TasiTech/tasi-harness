---
name: tasi-browser-automation
description: Use browser tools to open webpages, inspect page state, interact with elements, debug browser data, and extract content in the browser automation session.
category: browser
---

# Tasi Browser Automation

Use this skill when the user needs web actions through Tasi Harness browser automation.

In external browser mode, these browser tools attach to the managed Chromium-family external browser through CDP. Treat the external page as the real automation target, and use the harness-managed preview opener only as a fallback or manual surfacing path.

If the app setting enables headless external CDP mode, no browser window is visible. Continue by observing pages with `browser_snapshot`, `browser_extract`, and `browser_screenshot`.

## Tooling

Use these browser tools:

- `browser_open` to navigate to a URL.
- `browser_snapshot` to get the default accessibility/semantic tree with `@e` refs, roles, names, states, links, headings, images, and viewport data. Prefer this before interacting with unfamiliar pages.
- `browser_find` to locate elements by role, text, label, placeholder, alt text, title, test id, or CSS; it can return a ref or perform `click`, `fill`, `type`, `hover`, `check`, `uncheck`, `select`, or `text`.
- `browser_click`, `browser_type`, `browser_hover`, `browser_select`, `browser_check`, and `browser_press` to interact with controls. Use `@e` refs from `browser_snapshot` when available.
- `browser_wait` to wait for selectors, visible/hidden/detached state, text, URL glob, load state, JavaScript condition, or a short delay after navigation.
- `browser_scroll` to load lazy content; it can scroll the page or a scrollable selector/ref.
- `browser_extract` to capture text, HTML, or structured JSON from the full page or a selector/ref.
- `browser_screenshot` and `browser_pdf` to save visual evidence or a printable copy inside the workspace.
- `browser_storage`, `browser_cookies`, `browser_console`, and `browser_network` to inspect storage, cookies, console/page errors, and resource timing/network data.
- `browser_eval` for bounded page-side JavaScript inspection when the dedicated tools do not expose the needed data.
- `browser_viewport` to resize the browser for responsive checks.
- `browser_state` to verify current page location and title.
- `browser_close` to reset the browser session.

## Reliable Workflow

1. Open with `browser_open`.
2. Confirm state with `browser_state` if navigation or redirects are ambiguous.
3. Use `browser_snapshot` to read the accessibility tree, identify interactive elements, and collect `@e` refs.
4. Wait for critical selectors/text/URL/load state before clicking or typing.
5. Prefer `browser_find` or `@e` refs over brittle positional CSS selectors.
6. Extract structured content with `browser_extract` and prefer `format=json` for page data you want to normalize.
7. Use `browser_console`, `browser_network`, `browser_storage`, or `browser_cookies` when debugging failed interactions, auth state, SPA/API behavior, or missing data.
8. Keep extraction bounded with `max_chars` and iterate if more detail is needed.

## Citation Output

When the final answer uses facts from opened webpages, include numbered inline Markdown citation links:

- Use `claim text[1](https://example.com/source)` immediately after the supported claim.
- Assign citation numbers in first-use order and reuse the same number for the same URL.
- In tables, put the citation in the data or source cell that the URL supports.
- Do not cite search snippets alone unless the source page could not be opened and you clearly mark the answer as degraded.

## Notes

- Treat `browser_snapshot.snapshot` as the primary page observation for actions: it is an accessibility-first tree optimized for LLMs. Prefer semantic lookup and `@e` refs over brittle positional assumptions.
- Use `browser_extract` after `browser_snapshot` when you need article/body text, HTML, or normalized content rather than page controls.
- If an interaction fails, re-check page state, then wait and retry once.
- In embedded mode, do not ask the user to install Chrome extensions for this flow.
- In external mode, `browser_open`, `browser_click`, `browser_find`, and `browser_extract` operate on the external CDP target. If the external engine is set to Safari/WebDriver or falls back to `shell.openExternal`, the page may be preview-only and browser data tools can be unavailable.
- In headless external CDP mode, do not rely on visual browser presence; use snapshots, extraction, screenshots, state, console, and network tools as the observation channel.
- Use `browser_eval` sparingly. Prefer dedicated tools for state, storage, network, console, and extraction.
- This bundled skill is named `tasi-browser-automation` to avoid confusion with similarly named community skills.
