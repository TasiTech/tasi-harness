---
name: deep-search
description: Deep web search workflow using browser tools and multiple search engines such as Bing, Google, Baidu, Sogou/WeChat, 360, Toutiao, DuckDuckGo, Brave, Quark, or other available engines. Use when the user asks for deep_search, deep search, multi-engine research, source discovery, current web evidence, or when Codex needs to search, collect result links, de-duplicate sources, open candidate pages, and gather browser_snapshot/browser_extract evidence from each source.
category: browser
---

# Deep Search

Use this skill to run browser-backed research across search engines, collect candidate result links, de-duplicate sources, open the most relevant pages, and gather `browser_snapshot` / `browser_extract` evidence for downstream answering.

This workflow works in visible or headless external CDP mode. In headless mode, rely on `browser_snapshot`, `browser_extract`, `browser_screenshot`, and page state instead of visual browser inspection.

## Search Engines

Choose engines by task and network conditions:

- Broad/default: Bing `https://www.bing.com/search?q=<query>&count=10`
- International: Google `https://www.google.com/search?q=<query>&num=10`, Google HK `https://www.google.com.hk/search?q=<query>&num=10`, DuckDuckGo `https://duckduckgo.com/html/?q=<query>`, Brave `https://search.brave.com/search?q=<query>`
- Chinese/China-local: Baidu `https://www.baidu.com/s?wd=<query>`, Bing CN `https://cn.bing.com/search?q=<query>&ensearch=0`, 360 `https://www.so.com/s?q=<query>`, Sogou `https://www.sogou.com/web?query=<query>`, WeChat via Sogou `https://weixin.sogou.com/weixin?type=2&query=<query>`, Toutiao `https://so.toutiao.com/search?keyword=<query>`, Quark `https://quark.sm.cn/s?q=<query>&from=smor&safe=1`
- Finance/news direct leads when search results are thin: Sina Finance, Eastmoney, Tencent Finance, official exchanges/regulators, company IR pages, government/academic sources.

Use more than one engine when coverage matters, results look thin, the topic may differ across regions/languages, or one engine is blocked. For Chinese-language or China-local queries, try Bing CN plus Baidu/Sogou/360/Toutiao. For international queries, try Bing plus Google or DuckDuckGo/Brave. Treat search-engine AI summaries as leads, not evidence.

## Robust Browsing Pattern

- Open each search URL with `browser_open`, then `browser_wait` for load state, result text, or known result selectors.
- Use a normal desktop viewport with `browser_viewport` when responsive/mobile layouts hide links.
- After initial load, use one small `browser_scroll` to trigger lazy results, then wait briefly before extracting.
- If an engine returns zero usable organic links, captcha/interstitial content, consent-only content, or regional blocking, record it and switch engines. Do not try to bypass captchas, paywalls, login walls, or explicit access controls.
- Prefer visible or headless CDP browser tools over raw network fetching because search pages often need JavaScript, redirects, and accessibility-aware link inspection.

## Workflow

1. Clarify only if the search target is ambiguous enough that different interpretations would change the query.
2. Build 2-4 focused search queries. Include exact names, key terms, locations, dates, source type, language, or file/type terms when relevant.
3. Pick 2-4 engines from the engine list. Default to Bing + Google/DuckDuckGo for international work, and Bing CN + Baidu/Sogou/360 for Chinese work.
4. Open the first search engine with `browser_open`.
5. Use `browser_wait` for load state, text, or search result selectors, then use `browser_snapshot` to inspect the result page. Treat `browser_snapshot.snapshot` as the primary map of result links and refs.
6. Use `browser_extract format=json` when links/snippets are not clear from the snapshot. Capture title, URL, snippet, visible source, and result ref if available.
7. Normalize and de-duplicate candidate results by canonical URL and near-identical title. Keep a source list for duplicates found by multiple engines.
8. Open 3-8 promising result links with `browser_open`, one at a time. Use official/primary sources first, then reputable secondary sources for comparison.
9. For each opened page, use `browser_wait` then `browser_snapshot` to capture page structure and source context. Use `browser_extract format=json` for article/body text, links, metadata, and dates.
10. Cross-check important claims across at least two independent sources when the question is current, financial, medical, legal, or high-impact.
11. Stop when evidence is sufficient, sources converge, or the best available pages are exhausted. Mark gaps, blocked engines/pages, and uncertainty explicitly.

## Result Page Hints

These selectors are useful when `browser_extract` needs a bounded result area:

- Google: `#search .g`, `#rso .g`, `.yuRUbf`
- Bing: `.b_algo`, `#b_results .b_algo`
- Baidu: `#content_left .c-container`, `.result`, `.c-container`
- DuckDuckGo: `.result`, `.links`
- Sogou: `.vrwrap`, `.rb`, `.result`
- 360: `.res-list`, `.result`
- Toutiao/Quark: `.result`, `.result-item`, `.res-list`, `.article`

For each candidate, prefer `a[href^="http"]`, heading links, and visible organic result blocks. Skip ads, tracking-only links, duplicate snippets, login-only pages, and pages whose URL cannot be resolved.

## Result Link Selection

Prioritize:

- Official sites, primary documents, documentation, reports, datasets, company/project pages, government/academic sources, or original announcements.
- Pages with clear titles, source identity, dates, and accessible body content.
- Diverse domains when the task needs comparison.

Avoid unless necessary:

- Ads, shopping/SEO doorway pages, aggregator copies, unsupported snippets, captcha/interstitial-only pages, and pages that cannot be opened or inspected.
- Blindly trusting search-engine AI summaries. Treat them as leads, not evidence.

## Evidence Format

Keep an internal source ledger like:

```text
- query: <query>
  engine: <bing|google|baidu|sogou|360|toutiao|duckduckgo|brave|quark|other>
  result_ref: <@e ref if available>
  url: <opened URL>
  title: <page title>
  sources_seen: <engine names if duplicate result appeared across engines>
  snippet: <search result snippet if useful>
  evidence: <short note from opened-page snapshot/extract>
  status: <opened|blocked|duplicate|skipped>
```

## Citation Output

Use numbered inline Markdown citations in the final answer, similar to search-answer products:

- Assign each opened, usable source a stable number in first-use order.
- Put a citation immediately after the claim, table cell, or sentence it supports: `2025 年春节假期接待 16.8 万人次[1](https://example.com/news)。`
- Reuse the same number for the same URL. Do not invent citations for pages that were not opened and inspected.
- If a table has a source/notes column, put the citation in that cell. If a paragraph has several claims from different sources, cite each claim near the relevant text.
- Add a compact `Sources` / `来源` section at the end only when it helps readability, using the same numbers and titles.

Example:

```markdown
| Year | Data | Source |
| --- | --- | --- |
| 2025 | Spring Festival holiday, 7 days, 168k visits[1](https://example.com/news) | Official news |
| 2020 | Pandemic impact reduced visits to 27.4k[2](https://example.com/disclosure) | Company disclosure |

Sources: [1](https://example.com/news) Title A; [2](https://example.com/disclosure) Title B
```

When answering the user, cite or name the opened pages used as evidence. If browser tools fail, say which engine/query failed and provide a degraded result only if enough evidence remains.

## Browser Tool Guidance

- Use `browser_snapshot` before interaction on search result pages and opened sources.
- Use `@e` refs from snapshots for link clicks when available; otherwise open extracted URLs directly with `browser_open`.
- Use `browser_find` for search boxes, result links, consent buttons, pagination, or "next" controls.
- Use `browser_scroll` for lazy-loaded result pages before deciding no more links exist.
- Use `browser_screenshot` when a page is visually loaded but text extraction is sparse, captcha/interstitial state must be documented, or layout affects interpretation.
- Use `browser_console`, `browser_network`, or `browser_storage` only when debugging a blocked dynamic page.
- Use `browser_close` at the end when the search session should be reset.

## Completion Criteria

Before finalizing, make sure you can state:

- Which search engines and queries were used.
- Which result links were opened.
- Which pages produced usable `browser_snapshot` or `browser_extract` evidence.
- Any blocked engines/pages, captchas, regional differences, or remaining uncertainty.
