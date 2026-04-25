# Provider: Ctrip Browser Tools

## Status
This is the primary Ctrip retrieval reference for `tasi-travel`.

Use browser automation as the only supported Ctrip path for `tasi-travel`.

## Browser Modes
- Embedded mode: use built-in `browser_*` tools and the built-in preview by default.
- External mode: prefer Agent Browser only when a working external bridge is clearly available.
- If bridge availability is unknown, disconnected, or unstable, continue with `browser_*` tools and rely on the harness preview or fallback opener.

Related browser skill references:
- Agent Browser: `../../../browser/agent-browser/SKILL.md`
- Built-in browser operator: `../../../browser/embedded-browser-operator/SKILL.md`

## Tooling
Use these browser tools:
- `browser_open`
- `browser_wait`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_extract`
- `browser_state`
- `browser_close`

## Reliable Workflow
1. Build the target Ctrip list or detail URL from normalized user constraints.
2. Open the page with `browser_open`.
3. Confirm page state with `browser_state` when navigation or redirect behavior is ambiguous.
4. Wait for a stable list container, detail section, or search marker with `browser_wait`.
5. Scroll only when lazy-loaded content is clearly incomplete.
6. Extract bounded page content with `browser_extract`, preferring `format=json`.
7. Normalize rows from visible page evidence only.
8. Preserve the active page URL as `sourceUrl` when item-level links are missing.
9. Close the browser session with `browser_close` when the task is done or the page state becomes polluted.

## Search Coverage

### Hotels
Use Ctrip hotel list or search pages when the user wants:
- nearby hotels
- hotel comparison
- booking or detail links
- accommodation around a landmark, station, or district

Required inputs:
- `city`
- `check_in`
- `check_out`

Optional inputs:
- `keyword`
- `limit`

Normalize these fields whenever available:
- `hotelName`
- `price`
- `score`
- `distanceText`
- `detailUrl`
- `sourceUrl`

### POI
Use Ctrip sight or guide pages when the user wants:
- attractions
- museums
- scenic spots
- landmarks
- ticket ideas

Required inputs:
- `city`

Optional inputs:
- `keyword`
- `limit`

Normalize these fields whenever available:
- `name`
- `category`
- `rating`
- `price`
- `address`
- `detailUrl`
- `sourceUrl`

### Flights and Trains
Use Ctrip web pages as the default first pass for flights or trains.

Fallback rule:
- if Ctrip browser retrieval does not surface usable rows, then fall back to `flyai`.

Extraction rules:
- capture only clearly visible rows;
- keep route and date evidence visible in the output;
- mark uncertainty when fare, seat, or policy details are partial or hidden behind follow-up interactions.

## Extraction Rules
- Prefer stable selectors or clearly bounded page regions over full-page dumps.
- Start with visible first-page results before attempting deeper pagination.
- Treat lazy-loaded or partially rendered prices as incomplete until they are clearly visible.
- Do not infer unavailable hotel names, POI names, prices, scores, ratings, or booking links.
- Keep extraction bounded with `max_chars` and iterate only when more detail is required.

## Degrade Rules
Treat these as degraded or failed states and expose them clearly:
- page did not load
- browser tools unavailable
- bridge disconnected
- no visible result cards after bounded retries
- anti-bot or login wall blocked extraction
- content changed before extraction completed

On degrade:
1. Stop repeated retries after a bounded attempt count.
2. Ask the user whether to retry with adjusted city, date, or keyword constraints.
3. Fall back to the next provider in the routing chain.
4. Keep uncertainty visible; never present guessed rows as verified results.
