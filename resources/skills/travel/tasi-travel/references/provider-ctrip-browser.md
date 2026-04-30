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
Use Ctrip hotel list pages when the user wants:
- hotels in a city
- hotels near a landmark, school, hospital, or station
- hotels in a district, neighborhood, or business area
- hotel comparison
- booking or detail links

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

Hotel URL pattern:
- Preferred desktop list pattern:
  - `https://hotels.ctrip.com/hotels/list?...`

Hotel search strategy:
- Prefer desktop `hotels/list` URLs over generic keyword-only hotel search pages.
- When the user already provides a working Ctrip hotel list URL, preserve that URL structure and only adjust user-requested constraints.
- Treat hotel search on Ctrip as a scoped list search. The model should preserve the full search scope instead of collapsing it into a plain keyword query.

Parameter hit rules for desktop `hotels/list`:
- Always preserve stay dates:
  - `checkin`
  - `checkout`
- Always preserve city identity as a bundle when present:
  - `cityId`
  - `provinceId`
  - `districtId` when present
  - `countryId`
  - `cityName`
  - `destName`
- Always preserve occupancy and room-count context when present:
  - `crn`
- Preserve search-behavior and page-shaping params when already present:
  - `flexType`
  - `fixedDate`
  - `listFilters`
  - `curr`
  - `locale`
  - `old`
- Preserve trace/version params as-is when present:
  - `v2_mod`
  - `v2_version`

Scoped-search rules:
- Preserve this scoped-search bundle together when present:
  - `searchType`
  - `searchWord`
  - `optionId`
  - `searchValue`
- `searchValue` is a high-signal routing payload. Keep it fully encoded and unchanged; do not truncate, partially rewrite, or regenerate it.
- If `searchType` is already present, do not silently downgrade to plain city search.

Common `searchType` meanings from the provided links:
- `searchType=LM`
  - use for landmark / POI / school / station nearby hotels
  - example intent: “清华大学附近酒店”
- `searchType=Z`
  - use for zone / district / neighborhood / business-area hotels
  - example intent: “尖沙咀酒店”

Anti-patterns:
- Do not prefer weak fallback routes like:
  - `https://hotels.ctrip.com/hotels/search?keyword=...`
  - `https://m.ctrip.com/hotel/list?city=...&keyword=...`
- These routes often lose the scoped-search context and may extract only shell, navigation, or footer text.

Extraction hints for hotel list pages:
- Echo parsed city and date constraints before listing rows.
- Prioritize visible hotel cards tied to the current search scope.
- When `searchType=LM`, prioritize:
  - distance-to-landmark text
  - nearby transport / landmark cues
  - visible evidence that the page is scoped to that POI or landmark
- When `searchType=Z`, prioritize:
  - district / neighborhood / business-area labels on hotel cards
  - visible evidence that the page is scoped to that district or zone
- Do not infer hotel names, prices, or scores when they are not clearly visible.

Date handling:
- Preserve the date format already used by the working hotel URL.
- Desktop hotel list URLs may use `YYYY-MM-DD`.
- Do not rewrite an otherwise working hotel URL only to change date separators.

Examples:
- District / business-area hotel example:
  - `https://hotels.ctrip.com/hotels/list?flexType=1&fixedDate=0&cityId=58&provinceId=32&countryId=1&cityName=%E9%A6%99%E6%B8%AF&destName=%E9%A6%99%E6%B8%AF&searchWord=%E5%B0%96%E6%B2%99%E5%92%80&searchType=Z&optionId=142&searchValue=8%7C142*8*142&checkin=2026-05-01&checkout=2026-05-05&crn=4&listFilters=29~1*29*1~4*2&curr=CNY&locale=zh-CN&old=1&v2_mod=87&v2_version=E`
- Landmark-nearby hotel example:
  - `https://hotels.ctrip.com/hotels/list?flexType=1&cityId=1&provinceId=0&districtId=0&countryId=1&cityName=%E5%8C%97%E4%BA%AC&destName=%E5%8C%97%E4%BA%AC&searchWord=%E6%B8%85%E5%8D%8E%E5%A4%A7%E5%AD%A6&searchType=LM&optionId=4189241&searchValue=13%7C4189241*13*40.0039098%7C116.3267669%7C%E6%B8%85%E5%8D%8E%E5%A4%A7%E5%AD%A6%7C4189241&checkin=2026-04-30&checkout=2026-05-01&crn=1&listFilters=29~1*29*1~1*2&curr=CNY&locale=zh-CN&old=1&v2_mod=87&v2_version=E`

Recovery rule:
- If extraction from a hotel URL returns mostly global navigation, footer, or copyright text, treat that URL choice as weak.
- Retry once with the stronger desktop `hotels/list` scoped-search URL before degrading or asking the user.

### POI and Travel Guides
Use Ctrip sight or travel-guide pages when the user wants:
- attractions
- museums
- scenic spots
- landmarks
- ticket ideas
- destination guides
- itinerary inspiration from real travel notes

Required inputs:
- `city`

Optional inputs:
- `keyword`
- `limit`

Normalize these POI fields whenever available:
- `name`
- `category`
- `rating`
- `commentCount`
- `price`
- `address`
- `detailUrl`
- `sourceUrl`

Normalize these guide/article fields whenever available:
- `title`
- `publishDate`
- `readCountText`
- `startMonthText`
- `tripDaysText`
- `perCapitaCostText`
- `travelWithText`
- `keyItinerary`
- `relatedPoiLinks`
- `sourceUrl`

POI/guide URL patterns (from `you.ctrip.com`):
- City destination page (city-level POI hub):
  - `https://you.ctrip.com/place/{citySlug}{cityId}.html`
- POI detail/list entry:
  - `https://you.ctrip.com/sight/{citySlug}{cityId}/{poiId}.html?poiType=3`
- POI list pagination (common pattern):
  - `https://you.ctrip.com/sight/{citySlug}{cityId}/s0-p{page}.html`
- Guide/article page:
  - `https://you.ctrip.com/travels/{citySlug}{cityId}/{articleId}.html`
  - also seen numeric city route variants:
    - `https://you.ctrip.com/travels/{cityNumericId}/{articleId}.html`
- `cityId` extraction rule:
  - on `you.ctrip.com`, the city destination URL usually carries the city id directly in the path
  - parse the trailing digits from `/place/{citySlug}{cityId}.html`
  - examples:
    - `https://you.ctrip.com/place/beijing1.html` -> `cityId=1`
    - `https://you.ctrip.com/place/shanghai2.html` -> `cityId=2`
    - `https://you.ctrip.com/place/hongkong38.html` -> `cityId=38`
    - `https://you.ctrip.com/place/newyork248.html` -> `cityId=248`
- How to obtain `cityId` from homepage or search results:
  - if starting from `https://you.ctrip.com/`, first open the city link from the homepage, destination list, or search result
  - once the city page is open, treat the `/place/*` URL as the primary city-id evidence
  - if multiple internal links are visible, prefer in this order:
    - `/place/{citySlug}{cityId}.html`
    - `/sight/{citySlug}{cityId}/...`
    - `/travels/{citySlug}{cityId}/...`
  - when extracting from `sight/*` or `travels/*`, the digits attached to the city slug in the path usually match the same `cityId`
  - if the visible city name conflicts with the inferred path id, trust the visible page title or breadcrumb and keep the conflict explicit
- Parameter rules:
  - preserve `poiType` when present
  - preserve slug+id segments in path as route evidence
  - if city path id and query city conflict, trust the visible page breadcrumb/title

POI extraction hints:
- On `place/*` city pages, prioritize extracting city-scoped modules such as:
  - 热门景点 / 必玩景点
  - 分区或主题景点入口
  - 跳转到 `sight/*` 的景点详情链接
- When the task starts from the homepage or a broad city page, capture and reuse the detected `cityId` before building deeper `sight/*` or `travels/*` URLs.
- Prefer extracting from visible POI title/header area, score/comment widgets, ticket/price blocks, and address/opening-time sections.
- Keep nearby booking links if present (`hotel`, `ticket`, `sight` related links) as evidence links, not as fabricated recommendations.

Guide extraction hints:
- On `travels/*/*.html`, prioritize structured labels often shown on page:
  - `出发时间` (start month/time)
  - `行程天数` (trip days)
  - `人均花费` (per-capita cost)
  - `和谁出行` (travel companion type)
- Extract itinerary bullets/day plans from visible article body only.
- Capture referenced internal links in the article body (especially `you.ctrip.com/sight/*` and `you.ctrip.com/travels/*`) as `relatedPoiLinks`.

POI/guide quality gate:
- If extracted content is mostly global navigation/copyright text and lacks POI/article core fields, treat it as unusable extraction.
- In that case, do a bounded retry (`browser_wait` + one targeted interaction/scroll), then re-extract.
- If still unusable, mark degraded and fall back according to routing policy.

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
1. Keep user-given date format per domain. Flight/train are `YYYY-MM-DD`; hotel links should preserve the format already used by the working Ctrip URL.
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
