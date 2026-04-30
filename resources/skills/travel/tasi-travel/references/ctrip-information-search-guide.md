# Ctrip Information Retrieval Guide

## Status
The primary `tasi-travel` path now uses built-in `browser_*` tools for Ctrip retrieval.

This guide is browser-only.

## Preferred Runtime Modes
- Embedded mode: use built-in `browser_*` tools and the built-in preview by default.
- External mode: continue using `browser_*`; the harness auto-selects controlled system browser runtime when available.
- If controlled external runtime is unavailable, the harness may fall back to a plain opener; continue extraction workflow and mark degraded status when evidence is insufficient.

## Search Coverage
| Capability | Preferred Path | Notes |
|---|---|---|
| Hotels | Ctrip browser pages | Best for visible hotel cards and direct detail links |
| POI | Ctrip sight/guide pages | Best for attraction lists and page-grounded links |
| Flights | Ctrip browser first, then Flyai fallback | Use browser pages first; fall back when visible rows are missing or unusable |
| Trains | Ctrip browser first, then Flyai fallback | Use browser pages first; fall back when visible rows are missing or unusable |

## Recommended Browser Workflow
1. Normalize city, date, and keyword constraints first.
2. Open the relevant Ctrip list or detail page with `browser_open`.
3. Wait for a stable list or detail region with `browser_wait`.
4. Scroll only when the page is clearly lazy-loaded.
5. Extract bounded JSON with `browser_extract` using `format=json`.
6. Normalize visible rows only.
7. Preserve the active page URL as `sourceUrl` when item-level links are missing.

## Evidence Rules
- Do not fabricate hotel names, POI names, prices, scores, ratings, or links.
- Treat partially rendered prices or rates as incomplete until they are clearly visible.
- Keep route and date evidence visible when extracting flights or trains.
- If extraction fails, mark the result as degraded and fall back to the next provider.

## Related Active Docs
- Browser-first provider: `./provider-ctrip-browser.md`
- Tasi browser automation skill: `../../../browser/tasi-browser-automation/SKILL.md`
- Built-in browser operator: `../../../browser/embedded-browser-operator/SKILL.md`
