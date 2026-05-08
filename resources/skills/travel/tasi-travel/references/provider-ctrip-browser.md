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
- `browser_snapshot`
- `browser_hover`
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
5. Run `browser_snapshot` before extraction or interaction to inspect visible structure, accessible refs, result-card regions, and candidate links.
6. Scroll only when lazy-loaded content is clearly incomplete; after scrolling, run `browser_snapshot` again if new cards/links appeared.
7. Extract bounded page content with `browser_extract`, preferring `format=json`.
8. Normalize rows from visible page evidence only.
9. Preserve the active page URL as `sourceUrl` when item-level links are missing.
10. Close the browser session with `browser_close` when the task is done or the page state becomes polluted.

## Snapshot Usage
Use `browser_snapshot` as the navigation and structure inspection tool, not as the final data extractor.

Call `browser_snapshot`:
- after `browser_wait` on list, search, guide, or detail pages;
- before `browser_click` when choosing a city, POI, hotel, date, pagination, or tab ref;
- after `browser_hover` when a city menu, destination list, or dropdown is expected;
- after `browser_scroll` when lazy-loaded cards or links may have changed;
- when `browser_extract` returns navigation/footer noise and you need to identify a tighter visible region.

Use snapshot results to:
- choose stable refs for `browser_click` / `browser_hover`;
- confirm that visible cards match the intended city/date/keyword/search scope;
- identify whether the page is a list page, detail page, login wall, captcha/interstitial, or irrelevant navigation shell;
- find visible detail links that should be preserved as `detailUrl`.

Do not treat `browser_snapshot` text alone as sufficient item data when prices, ratings, times, policies, or availability need structured extraction. Use `browser_extract format=json` for those fields after snapshot confirms the right page region.

## Evidence Handoff
Every normalized Ctrip result row must carry enough source metadata for the entry skill to cite it later.

Required source fields whenever available:
- `sourceUrl`: the opened list, detail, search, or guide URL that visibly supports the row.
- `detailUrl`: the concrete item URL when visible and relevant.
- `sourceTitle`: visible page title, result title, hotel/POI title, or browser page title.
- `publisherOrSite`: usually `Ctrip`, `Trip.com`, `you.ctrip.com`, `hotels.ctrip.com`, `flights.ctrip.com`, or `trains.ctrip.com`.
- `observedAt`: current timestamp for live browser evidence.
- `evidenceFields`: list of normalized fields actually supported by the inspected page, such as `price`, `score`, `departureTime`, `hotelName`, or `openingHours`.

Rules:
- Do not mark a field as supported unless it was visible in the extracted page content or in a provider-native row.
- Prefer `detailUrl` for item-specific data; use `sourceUrl` when only the list page was inspected.
- Keep booking/action URLs, map URLs, and generated search URLs separate from source URLs unless they were opened and extracted as evidence.
- If a visible Ctrip URL contains Chinese, spaces, brackets, or other unsafe characters, URL-encode it before handing it to the final answer for citation.

## Search Coverage

### Hotels
Use Ctrip hotel list pages when the user wants:
- hotels in a city
- hotels near an airport, station, landmark, school, hospital, district, or business area
- hotel comparison
- booking or detail links

Required inputs:
- `city`
- `check_in`
- `check_out`

Normalize these fields whenever available:
- `hotelName`
- `price`
- `score`
- `distanceText`
- `locationText`
- `detailUrl`
- `sourceUrl`
- `sourceTitle`
- `publisherOrSite`
- `observedAt`
- `evidenceFields`

Hotel URL pattern:
- Preferred desktop list pattern:
  - `https://hotels.ctrip.com/hotels/list?...`
- Build hotel list URLs from city text, destination text, search text, dates, occupancy, filters, currency, locale, and Ctrip-returned scoped-search params.
- For now, do not add, look up, or synthesize hotel-channel `cityId` values.
- Do not consult `city_id.txt` for Hotels unless this rule is explicitly changed later.
- If a user-provided or Ctrip-returned hotel URL already contains `cityId`, keep the full URL as opaque route evidence, but do not extract or reuse that `cityId`.
- Use concrete hotel detail URLs only when Ctrip UI or the user provides them; do not synthesize detail URLs from ids.

Hotel search strategy:
- Prefer desktop `hotels/list` URLs over generic keyword-only hotel search pages.
- When the user provides a working Ctrip hotel list URL, preserve that URL structure and only adjust user-requested constraints.
- Treat hotel search on Ctrip as a scoped list search. Preserve the city/date/search scope instead of collapsing it into a plain keyword query.
- If starting from `https://www.ctrip.com/`, the hotel home form may submit directly to `hotels/list`; after form submission, use the resulting URL as city/date/search evidence instead of reconstructing it from memory.
- If the URL has repeated trace/version params such as repeated `v2_mod` or `v2_version`, preserve them when opening the exact user URL. When rebuilding a URL, do not intentionally duplicate those params.

Parameter hit rules for desktop `hotels/list`:
- Preserve city and destination text:
  - `cityName`
  - `destName`
- Preserve search scope:
  - `searchWord`
  - `searchType`
  - `optionId` when Ctrip returns it
  - `searchValue` when Ctrip returns it
  - `directSearch`
- Preserve dates and occupancy:
  - `checkin`
  - `checkout`
  - `crn`
  - `adult` / `children` when present
- Preserve page-shaping and display params when already present:
  - `flexType`
  - `fixedDate`
  - `listFilters`
  - `curr`
  - `locale`
  - `old`
  - `allianceid`
  - `sid`
  - `v2_mod`
  - `v2_version`

Common `searchType` meanings from observed links:
- `searchType=CT`
  - use for city-scoped text search within the destination
  - example intent: `cityName=广州`, `destName=广州`, `searchWord=机场` means hotels in Guangzhou with an airport-related search scope
- `searchType=LM`
  - use for landmark / POI / school / station nearby hotels when Ctrip returns the scoped-search payload
- `searchType=Z`
  - use for zone / district / neighborhood / business-area hotels when Ctrip returns the scoped-search payload

Canonical no-`cityId` hotel list example:
- `https://hotels.ctrip.com/hotels/list?flexType=1&fixedDate=0&cityName=%E5%B9%BF%E5%B7%9E&destName=%E5%B9%BF%E5%B7%9E&searchWord=%E6%9C%BA%E5%9C%BA&searchType=CT&checkin=2026-05-08&checkout=2026-05-09&crn=1&listFilters=29~1*29*1~2*2&curr=CNY&locale=zh-CN&directSearch=1&allianceid=4899&sid=963772&old=1&v2_mod=11&v2_version=E`
- Decode this as: Guangzhou hotel search, airport keyword scope, 2026-05-08 to 2026-05-09, 1 room, CNY, zh-CN locale, preserving the visible filters and trace params.

Extraction hints for hotel list pages:
- Echo parsed city, keyword, check-in, check-out, room count, currency, and filter constraints before listing rows.
- Run `browser_snapshot` before extraction to confirm the visible list region, city/search scope, date widgets, and whether the page is a login/captcha/empty shell.
- Prioritize visible hotel cards tied to the current city/search/date scope.
- When `searchType=CT` with a keyword such as `机场`, prioritize airport/location cues and distance text visible on hotel cards.
- When `searchType=LM`, prioritize distance-to-landmark text and visible evidence that the page is scoped to that POI or landmark.
- When `searchType=Z`, prioritize district / neighborhood / business-area labels and visible evidence that the page is scoped to that zone.
- Do not infer hotel names, prices, scores, distances, or booking links when they are not clearly visible.

Recovery rule:
- If extraction from a hotel URL returns mostly global navigation, footer, or copyright text, treat that URL choice as weak.
- Retry once with the same desktop `hotels/list` scope after `browser_wait`, `browser_snapshot`, and one bounded interaction or scroll.
- If still unusable, mark degraded and ask whether to retry with adjusted city, date, or keyword constraints.


### POI and Travel Guides
Use Ctrip `you.ctrip.com` pages when the user wants:
- attractions / scenic spots
- museums
- landmarks
- destination guide context
- ticket ideas or opening-hour / address / rating context from visible Ctrip pages
- itinerary inspiration from real travel notes

Required inputs:
- `city` or `keyword`

Normalize these POI fields whenever available:
- `name`
- `category`
- `rating`
- `commentCount`
- `price`
- `address`
- `openingHours`
- `rankOrBadge`
- `detailUrl`
- `sourceUrl`
- `sourceTitle`
- `publisherOrSite`
- `observedAt`
- `evidenceFields`

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
- `sourceTitle`
- `publisherOrSite`
- `observedAt`
- `evidenceFields`

Primary POI workflow:
1. Open the direct global-search URL for the city or scenic-spot keyword:
   - example keyword: `广州`
   - `https://you.ctrip.com/globalsearch/?keyword=%E5%B9%BF%E5%B7%9E`
2. On `globalsearch`, run `browser_snapshot`, then use `browser_click` to click the matching city name, destination card, scenic-spot name, or attraction card.
   - Prefer visible result links over generated URLs.
   - Do not require a visible `href` on the result card. Ctrip global-search often renders city/POI cards as clickable anchors such as `<a class="guide-main-item" target="_blank">` with no `href` in the visible DOM snapshot; these must still be treated as clickable result candidates when their text matches the keyword.
   - In `browser_snapshot`, search `elements` and `tree`, not only `links`. A valid city or POI result may appear as `tag=a`, `role=link`, `name/text` containing the requested city, POI, or matching English/alternate name, with a selector or class path like `guide-main-item` / `gsl-common-card`, but without `href`.
   - If snapshot exposes a matching `@e` ref for a no-`href` card, click that ref directly. If no ref is exposed but the card is visible, use `browser_find` by exact/near text with `action=click` only as a bounded fallback.
   - If both city and attraction results are visible, click the one that matches the user's intent: city-wide attraction discovery uses the city/destination result; a named attraction uses the attraction/scenic-spot result.
   - The click is mandatory route evidence. Record the clicked ref/name and the resulting browser URL before treating any POI page as valid.
3. Capture the final opened `you.ctrip.com` URL as route evidence.
   - example city scenic route:
     - `https://you.ctrip.com/sight/guangzhou152.html`
   - Global-search city cards may first open `place/*`, such as `https://you.ctrip.com/place/guangzhou152.html`; keep that `place/*` URL as the city guide route evidence, then use visible page navigation or links to reach `sight/*` if scenic-list data is needed.
   - parse route segments such as `guangzhou152` or `guangzhou152` only from the clicked/opened `you.ctrip.com` URL; do not import hotel-channel ids.
4. Extract scenic-spot details from the final `place/*`, `sight/*`, or scenic detail page.
   - If the final page is a city guide page such as `/place/guangzhou152.html`, extract guide context from that page and click the visible `景点` / scenic navigation or visible `sight/*` link before extracting scenic-card lists.
   - If the final page is a city-level scenic list such as `/sight/guangzhou152.html`, extract visible scenic cards first.
   - If a specific card has a concrete detail link, click it when full detail is needed, then extract the detail page.

Global-search click rule:
- Always use the result page click as the source of the city/scenic route. Do not jump straight from a keyword to a fabricated `sight/*` URL.
- After `browser_snapshot` on `globalsearch`, the next navigation to `place/*`, `sight/*`, or `travels/*` must come from `browser_click` on a visible snapshot ref. Do not use `browser_open` with a guessed slug/id route.
- For Ctrip global search, absence from `links` is not enough to declare failure. Check `elements` / `tree` for clickable anchors and card containers whose text matches the keyword, especially `a.guide-main-item` and `.gsl-common-card`.
- A no-`href` result card is valid click evidence only after it is actually clicked and the resulting URL is observed. Do not convert its text to a route yourself.
- If a clicked card uses `target="_blank"` or JavaScript `window.open`, inspect the active/new page state after the click and preserve the actual opened URL. If the automation remains on the search URL and no new Ctrip page is reachable, mark the route unresolved instead of guessing.
- If no click was performed, there is no valid POI route evidence. Mark POI retrieval degraded instead of citing or using a constructed `you.ctrip.com` route.
- If `browser_snapshot` does not expose a clickable city or scenic-spot result, run one bounded `browser_wait` or `browser_scroll`, snapshot again, then click only if the target result is visible.

Global-search validity check:
- After opening `globalsearch`, the snapshot must show the decoded keyword or a matching result name in the visible result area before any POI click.
- Recommended snapshot call for Ctrip global search: omit `max_elements` and use a larger `max_chars` budget, for example `browser_snapshot {"max_chars": 200000}`. Do not pass small `max_elements` values that can hide result cards behind navigation noise.
- If the snapshot shows only global navigation, footer links, an empty search box, or generic site index links, treat it as a search-shell snapshot, not a result snapshot.
- For a search-shell snapshot, retry in this order:
  - `browser_wait` for the results region or visible keyword text;
  - `browser_scroll` once and run `browser_snapshot` again with a larger bound;
  - if the search input is visible but empty, type the keyword into that search box on the `globalsearch` page, submit it, wait, and snapshot again.
- If the decoded keyword still does not appear and no visible city/scenic result ref is available, mark POI retrieval degraded. Do not open a guessed route.

POI anti-patterns:
- Do not open a guessed URL such as `https://you.ctrip.com/sight/{guessedSlug}{guessedId}.html` after search results.
- Do not infer `{citySlug}{cityId}` from memory, hotel ids, offline tables, or prior examples.
- Do not use a `place/*`, `sight/*`, or `travels/*` URL as evidence unless it was user-provided, visible in extraction output, or reached by `browser_click` from a visible result/link.
- Do not continue with common-knowledge attractions when Ctrip POI click-through failed; label the Ctrip POI path as degraded and keep those attractions unverified or use another provider.

URL patterns (from `you.ctrip.com`):
- Global search:
  - `https://you.ctrip.com/globalsearch/?keyword={encodedKeyword}`
- City-level scenic route:
  - `https://you.ctrip.com/sight/{citySlug}{cityId}.html`
- Scenic detail route, when visible from result cards or list cards:
  - `https://you.ctrip.com/sight/{citySlug}{cityId}/{poiId}.html`
  - preserve `poiType` when present
- Travel note / guide route, when visible:
  - `https://you.ctrip.com/travels/{citySlug}{cityId}/{articleId}.html`
  - numeric city-route variants may also appear; preserve the clicked URL as-is

City / route-id rules:
- On POI and guide pages, the route id is attached to the `you.ctrip.com` path, such as `guangzhou152`.
- Use only visible links or the final opened URL as route evidence:
  - `https://you.ctrip.com/sight/guangzhou152.html` -> city route segment `guangzhou152`
  - `https://you.ctrip.com/place/guangzhou152.html` -> city route segment `guangzhou152`
- Do not copy hotel-channel `cityId` values into `place/*`, `sight/*`, or `travels/*`.
- If the visible city/scenic name conflicts with the path segment, trust the visible page title or breadcrumb and keep the conflict explicit.

Extraction hints:
- Run `browser_snapshot` before every click that chooses a city, scenic spot, tab, or result card.
- Run `browser_extract format=json` after the final `sight/*` page is visibly stable.
- For city-level scenic pages, prioritize:
  - visible scenic card names
  - ratings / comment counts
  - price or ticket text
  - address / area / distance text
  - rank labels or badges
  - concrete detail links
- For scenic detail pages, prioritize:
  - page title / scenic spot name
  - rating, score, comment count
  - ticket / price blocks
  - opening hours
  - address and transport/location text
  - introduction / highlights
  - nearby or related `sight/*`, `hotel/*`, or ticket links as evidence links only
- For guide/travel-note pages, prioritize visible article metadata and body itinerary text; capture related `sight/*` and `travels/*` links as `relatedPoiLinks`.

Quality gate:
- If extraction is mostly global navigation, footer, copyright, or search shell text, treat it as unusable.
- Retry once with `browser_wait`, `browser_snapshot`, and one bounded click or scroll within the city/scenic result region.
- If still unusable, mark degraded and ask whether to retry with a more specific city or scenic-spot keyword.


### Flights and Trains
Use Ctrip web pages as the default first pass for flights or trains.

Fallback rule:
- if Ctrip browser retrieval does not surface usable rows, then fall back to `flyai`.

Extraction rules:
- capture only clearly visible rows;
- keep route and date evidence visible in the output;
- mark uncertainty when fare, seat, or policy details are partial or hidden behind follow-up interactions.
- normalize each visible flight/train row with `sourceUrl`, `sourceTitle`, `publisherOrSite`, `observedAt`, and `evidenceFields`.
- if a generated 12306 booking URL is displayed later, label it as an action link unless it was opened/inspected as train evidence.
- run `browser_snapshot` before row extraction to confirm the route/date list region and detect login, captcha, empty-state, or placeholder pages.

Flight URL template and parameter hit rules:
- One-way list pattern:
  - `https://flights.ctrip.com/online/list/oneway-{dep}-{arr}?depdate=YYYY-MM-DD&cabin=y_s_c_f&adult=1&child=0&infant=0`
- required hit: route segment `oneway-{dep}-{arr}`, `depdate`
- strongly recommended: `cabin`, `adult`, `child`, `infant`
- Round-trip list pattern:
  - `https://flights.ctrip.com/online/list/round-{dep}-{arr}?depdate=YYYY-MM-DD_YYYY-MM-DD&cabin=y_s_c_f&adult=1&child=0&infant=0`
- round-trip required hit: route segment `round-{dep}-{arr}`, `depdate` with outbound and return dates separated by `_`
- `cabin` may appear as `Y_S_C_F` or `y_s_c_f`; preserve the case used by the working URL.
- Ignore or preserve cache-only params such as `_` when already present, but do not treat them as route, passenger, or pricing evidence.
- Date format: `YYYY-MM-DD`
- Example:
  - `https://flights.ctrip.com/online/list/oneway-bjs-syx?depdate=2026-05-02&cabin=y_s_c_f&adult=1&child=0&infant=0`
- Round-trip example observed from form submission:
  - `https://flights.ctrip.com/online/list/round-sha-bjs?depdate=2026-05-07_2026-05-10&cabin=y_s_c_f&adult=1&child=0&infant=0`

Train URL template and parameter hit rules:
- Train list pattern:
  - `https://trains.ctrip.com/webapp/train/list?ticketType=0&dStation={depCn}&aStation={arrCn}&dDate=YYYY-MM-DD&rDate=&trainsType=&hubCityName=&highSpeedOnly=0`
- required hit: `dStation`, `aStation`, `dDate`
- strongly recommended: `ticketType`, `highSpeedOnly`
- optional filters: `rDate`, `trainsType`, `hubCityName`
- `trainsType=gaotie-dongche` means high-speed rail / EMU filtering; preserve it when the user selects or asks for 高铁/动车 only.
- `rDate` is the return-date slot; keep it empty for one-way train searches unless the user explicitly asks for a return journey.
- Date format: `YYYY-MM-DD`
- Example:
  - `https://trains.ctrip.com/webapp/train/list?ticketType=0&dStation=Beijing&aStation=Shanghai&dDate=2026-05-01&highSpeedOnly=0`
- High-speed/EMU example:
  - `https://trains.ctrip.com/webapp/train/list?ticketType=0&dStation=%E5%8C%97%E4%BA%AC&aStation=%E4%B8%8A%E6%B5%B7&dDate=2026-05-09&rDate=&trainsType=gaotie-dongche&hubCityName=&highSpeedOnly=0`

Parameter hit checklist (all Ctrip domains):
1. Keep user-given date format per domain. Flight/train are `YYYY-MM-DD`; hotel links should preserve the format already used by the working Ctrip URL.
2. Do not drop passenger/occupancy params (`adult`, `children`, `child`, `infant`) if user provided them.
3. Preserve route/city identity in both path and query when both exist.
4. Preserve non-semantic trace/version params as-is when already present; do not invent new values.
5. If required params are missing, ask a focused follow-up instead of guessing.

Observed channel and form-entry URLs:
- Ctrip homepage entry:
  - `https://www.ctrip.com/`
- Flight channel entry:
  - `https://flights.ctrip.com/online/channel/domestic`
- Train channel entry:
  - `https://trains.ctrip.com/`
- Hotel channel/list entry:
  - `https://hotels.ctrip.com/hotels/list`
- Travel guide / POI channel entry:
  - `https://you.ctrip.com/`
- When using these entry pages, prefer semantic labels, placeholders, aria labels, and current snapshot refs over brittle `nth-of-type` selectors.
- After typing into city, hotel, search, date, or other autocomplete fields, select a concrete suggestion/dropdown option and verify the selected value before submitting.

## Extraction Rules
- Prefer stable selectors or clearly bounded page regions over full-page dumps.
- Use `browser_snapshot` to choose or confirm bounded regions before calling `browser_extract` on dynamic Ctrip pages.
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
