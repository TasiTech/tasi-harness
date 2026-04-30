# Provider: Ctrip Browser Tools

## Status
This is the primary Ctrip retrieval reference for `tasi-travel`.

Use browser automation as the only supported Ctrip path for `tasi-travel`.

## Browser Modes
- Embedded mode: use built-in `browser_*` tools and the built-in preview by default.
- External mode: continue using `browser_*`; the harness auto-selects controlled system browser runtime when available.
- If controlled external runtime is unavailable, the harness may fall back to a plain opener; continue with `browser_*` and keep degraded state explicit when extraction quality drops.

Related browser skill references:
- Tasi browser automation: `../../../browser/tasi-browser-automation/SKILL.md`
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
   - Pick the URL family first: `hotels.ctrip.com` (hotel list), `flights.ctrip.com` (flight list), `trains.ctrip.com` (train list), `you.ctrip.com` (POI/guide).
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

Hotel URL templates and parameter hit rules:
- Preferred desktop list pattern:
  - `https://hotels.ctrip.com/hotels/list?...`
- Also accepted mobile list pattern:
  - `https://m.ctrip.com/webapp/hotels/hotelsearch/listPage?...`
- For desktop `hotels/list`, prioritize these parameters:
  - required hit: `city`, `checkin`, `checkout`, `adult`, `children`
  - strongly recommended: `countryId`, `optionId`, `optionType`, `display`
  - routing/context: `provinceId`, `directSearch`, `travelPurpose`, `domestic`, `crn`
  - trace/version (preserve only): `ctm_ref`, `v2_mod`, `v2_version`
- Date format normalization:
  - hotel links use `YYYY/MM/DD` (example: `checkin=2026/04/30`, `checkout=2026/05/01`)
- Occupancy defaults when user did not specify:
  - `adult=1`, `children=0`
- If user gives a landmark/keyword, keep nearby-context params when present and prioritize extraction of:
  - distance-to-landmark text
  - nearby transport/landmark cues
  - hotel cards clearly matching the nearby context
- Always echo parsed city and date constraints before listing rows.

Hotel desktop example:
- `https://hotels.ctrip.com/hotels/list?countryId=1&city=2&provinceId=0&checkin=2026/04/30&checkout=2026/05/01&optionId=2&optionType=City&display=Shanghai&crn=1&adult=1&children=0&travelPurpose=0&domestic=1`

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

POI/guide URL patterns:
- POI detail/list entry:
  - `https://you.ctrip.com/sight/{citySlug}{cityId}/{poiId}.html?poiType=3`
- Guide/article page:
  - `https://you.ctrip.com/travels/{citySlug}{cityId}/{articleId}.html`
- Parameter rules:
  - preserve `poiType` when present
  - preserve slug+id segments in path as route evidence
  - if city path id and query city conflict, trust the visible page breadcrumb/title

### Flights and Trains
Use Ctrip web pages as the default first pass for flights or trains.

Fallback rule:
- if Ctrip browser retrieval does not surface usable rows, then fall back to `flyai`.

Extraction rules:
- capture only clearly visible rows;
- keep route and date evidence visible in the output;
- mark uncertainty when fare, seat, or policy details are partial or hidden behind follow-up interactions.

Flight URL template and parameter hit rules:
- One-way list pattern:
  - `https://flights.ctrip.com/online/list/oneway-{dep}-{arr}?depdate=YYYY-MM-DD&cabin=y_s_c_f&adult=1&child=0&infant=0`
- required hit: route segment `oneway-{dep}-{arr}`, `depdate`
- strongly recommended: `cabin`, `adult`, `child`, `infant`
- Date format: `YYYY-MM-DD`
- Example:
  - `https://flights.ctrip.com/online/list/oneway-bjs-syx?depdate=2026-05-02&cabin=y_s_c_f&adult=1&child=0&infant=0`

Train URL template and parameter hit rules:
- Train list pattern:
  - `https://trains.ctrip.com/webapp/train/list?ticketType=0&dStation={depCn}&aStation={arrCn}&dDate=YYYY-MM-DD&rDate=&trainsType=&hubCityName=&highSpeedOnly=0`
- required hit: `dStation`, `aStation`, `dDate`
- strongly recommended: `ticketType`, `highSpeedOnly`
- optional filters: `rDate`, `trainsType`, `hubCityName`
- Date format: `YYYY-MM-DD`
- Example:
  - `https://trains.ctrip.com/webapp/train/list?ticketType=0&dStation=Beijing&aStation=Shanghai&dDate=2026-05-01&highSpeedOnly=0`

Parameter hit checklist (all Ctrip domains):
1. Keep user-given date format per domain (hotel `YYYY/MM/DD`; flight/train `YYYY-MM-DD`).
2. Do not drop passenger/occupancy params (`adult`, `children`, `child`, `infant`) if user provided them.
3. Preserve route/city identity in both path and query when both exist.
4. Preserve non-semantic trace/version params as-is when already present; do not invent new values.
5. If required params are missing, ask a focused follow-up instead of guessing.

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
- controlled external runtime unavailable and fallback opener cannot keep stable extractable context
- no visible result cards after bounded retries
- anti-bot or login wall blocked extraction
- content changed before extraction completed

On degrade:
1. Stop repeated retries after a bounded attempt count.
2. Ask the user whether to retry with adjusted city, date, or keyword constraints.
3. Fall back to the next provider in the routing chain.
4. Keep uncertainty visible; never present guessed rows as verified results.
