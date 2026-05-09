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
- booking links or hotel detail links

Required inputs:
- `city`
- `check_in`
- `check_out`

Optional inputs:
- `destName`
- `searchWord`
- `searchType`
- `optionId`
- `rooms`
- `adults`
- `childAges`
- `currency`
- `locale`

Default input values:
- `destName` defaults to `city`
- `searchWord` defaults to empty string
- `searchType` defaults to `CT`
- `rooms` defaults to `1`
- `adults` defaults to `2`
- `childAges` defaults to empty array
- `currency` defaults to `CNY`
- `locale` defaults to `zh-CN`

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
- Use the simplified desktop Ctrip hotel list pattern:
  - `https://hotels.ctrip.com/hotels/list?...`
- Build hotel list URLs from:
  - city text
  - destination text
  - optional search text
  - search type
  - optional Ctrip-returned `optionId`
  - dates
  - room count
  - adult count
  - child ages
  - currency
  - locale
  - page/version params
- Do not add, look up, or synthesize hotel-channel `cityId`, `provinceId`, or `countryId` values.
- Do not consult `city_id.txt` for Hotels unless this rule is explicitly changed later.
- If a user-provided or Ctrip-returned hotel URL already contains `cityId`, `provinceId`, or `countryId`, keep the full URL as opaque route evidence when opening it, but do not extract, reuse, or synthesize those IDs when rebuilding simplified URLs.
- Use concrete hotel detail URLs only when the Ctrip UI or the user provides them. Do not synthesize hotel detail URLs from hotel IDs.

Simplified desktop hotel list URL template:
- Base URL:
  - `https://hotels.ctrip.com/hotels/list`
- Query params:
  - `flexType=1`
  - `fixedDate=0`
  - `cityName={encodedCityName}`
  - `destName={encodedDestName}`
  - `searchWord={encodedSearchWord}` when a keyword is available; otherwise omit it or keep it as an empty string if preserving an existing URL shape
  - `searchType={searchType}`
  - `optionId={optionId}` only when the user provides it or Ctrip returns it
  - `checkin={YYYY-MM-DD}`
  - `checkout={YYYY-MM-DD}`
  - `crn={rooms}`
  - `listFilters={encodedListFilters}`
  - `curr={currency}`
  - `locale={locale}`
  - `old=1`
  - `v2_mod=11`
  - `v2_version=E`

Canonical simplified URL shape:
- `https://hotels.ctrip.com/hotels/list?flexType=1&fixedDate=0&cityName={cityName}&destName={destName}&searchWord={searchWord}&searchType={searchType}&optionId={optionId}&checkin={checkin}&checkout={checkout}&crn={rooms}&listFilters={listFilters}&curr=CNY&locale=zh-CN&old=1&v2_mod=11&v2_version=E`

Parameter handling rules:
- Preserve city and destination text:
  - `cityName`
  - `destName`
- Preserve search scope when available:
  - `searchWord`
  - `searchType`
  - `optionId` only when provided by the user or returned by Ctrip
  - `searchValue` only when Ctrip returns it
  - `directSearch` only when present in an existing working URL or returned by Ctrip
- Preserve dates and occupancy:
  - `checkin`
  - `checkout`
  - `crn`
  - `listFilters`
- Preserve page-shaping and display params when already present:
  - `flexType`
  - `fixedDate`
  - `curr`
  - `locale`
  - `old`
  - `allianceid`
  - `sid`
  - `v2_mod`
  - `v2_version`
- If a URL has repeated trace/version params such as repeated `v2_mod` or repeated `v2_version`, preserve them when opening the exact user URL. When rebuilding a URL, include each trace/version param only once.
- If changing the destination city, do not carry over a stale `optionId` unless the new `optionId` is explicitly provided by the user or returned by Ctrip for the new destination.

Occupancy rules:
- `crn` means room count.
- Example:
  - `crn=1` means 1 room
  - `crn=2` means 2 rooms
  - `crn=4` means 4 rooms

`listFilters` rules:
- `listFilters` encodes adult count and child ages.
- Adult count uses this format:
  - `29~1*29*1~{adults}*2`
- Examples:
  - `29~1*29*1~1*2` means 1 adult
  - `29~1*29*1~2*2` means 2 adults
  - `29~1*29*1~4*2` means 4 adults
- If there are no children, `listFilters` should contain only the adult segment.
- Example:
  - `crn=1&listFilters=29~1*29*1~2*2`
  - Decode as: 1 room, 2 adults, 0 children

Child age rules:
- Children are represented by one age segment per child.
- The first child starts at index `2`.
- The second child uses index `3`.
- The third child uses index `4`.
- General child segment:
  - `29~{childIndex}~{age}*29*{childIndex}~{age}`
- Child index formula:
  - `childIndex = childNumber + 1`
- Examples:
  - First child, age 8:
    - `29~2~8*29*2~8`
  - Second child, age 11:
    - `29~3~11*29*3~11`
  - Third child, age 13:
    - `29~4~13*29*4~13`

When children are present:
- Append all child age segments after the adult segment.
- Then append these fixed child-related filter segments:
  - `80~2*80*2`
  - `17~1*17*1`

Full `listFilters` generation formula:
- Input:
  - `adults`
  - `childAges`
- Output:
  - `29~1*29*1~{adults}*2`
  - plus one child segment per child age
  - plus `80~2*80*2,17~1*17*1` when `childAges.length > 0`

Examples:
- 1 room, 2 adults, 0 children:
  - `crn=1`
  - `listFilters=29~1*29*1~2*2`
- 2 rooms, 2 adults, 1 child age 8:
  - `crn=2`
  - `listFilters=29~1*29*1~2*2,29~2~8*29*2~8,80~2*80*2,17~1*17*1`
- 1 room, 1 adult, 2 children ages 8 and 10:
  - `crn=1`
  - `listFilters=29~1*29*1~1*2,29~2~8*29*2~8,29~3~10*29*3~10,80~2*80*2,17~1*17*1`
- 4 rooms, 4 adults, 3 children ages 8, 11, and 13:
  - `crn=4`
  - `listFilters=29~1*29*1~4*2,29~2~8*29*2~8,29~3~11*29*3~11,29~4~13*29*4~13,80~2*80*2,17~1*17*1`

Important occupancy limitation:
- The simplified Ctrip list URL expresses total room count, total adult count, and child ages.
- It does not reliably express per-room allocation.
- Do not infer which adult or child belongs to which room unless the Ctrip UI explicitly shows that allocation.

URL encoding rules:
- Encode query params with a standard URL encoder.
- Encode Chinese text in `cityName`, `destName`, and `searchWord`.
- Encode `listFilters` as one query value.
- Do not double-encode values.
- Common encodings:
  - `,` becomes `%2C`
  - `*` may become `%2A`
  - `桂林` becomes `%E6%A1%82%E6%9E%97`
- Both raw `*` and encoded `%2A` may appear in observed Ctrip URLs. When building URLs, prefer standard query encoding.

Common `searchType` meanings from observed links:
- `searchType=CT`
  - City-only hotel search.
  - There should be no `searchWord`; omit it or keep it empty only when preserving an existing URL shape.
- `searchType=T`
  - `searchWord` is a location / place / area text.
  - Use for user requests such as hotels near an airport, station, landmark, scenic area, school, hospital, district, or business area when Ctrip does not provide a more specific scoped payload.
- `searchType=B`
  - `searchWord` is a hotel brand.
  - Use when the user asks for hotels by brand, such as Hilton, Atour, Marriott, or 全季.
- `searchType=H`
  - `searchWord` is a hotel name.
  - Use when the user asks for one named hotel or hotels matching an explicit hotel-name text.

Canonical simplified no-child example:
- `https://hotels.ctrip.com/hotels/list?flexType=1&fixedDate=0&cityName=%E6%A1%82%E6%9E%97&destName=%E6%A1%82%E6%9E%97&searchType=CT&optionId=33&checkin=2026-06-01&checkout=2026-06-05&crn=4&listFilters=29~1*29*1~4*2&curr=CNY&locale=zh-CN&old=1&v2_mod=11&v2_version=E`
- Decode this as:
  - Ctrip desktop hotel list page
  - city text: 桂林
  - destination text: 桂林
  - search type: city search
  - option ID: 33, only because it was present in the supplied URL
  - check-in: 2026-06-01
  - check-out: 2026-06-05
  - 4 rooms
  - 4 adults
  - 0 children
  - currency: CNY
  - locale: zh-CN

Canonical simplified child example:
- `https://hotels.ctrip.com/hotels/list?flexType=1&fixedDate=0&cityName=%E6%A1%82%E6%9E%97&destName=%E6%A1%82%E6%9E%97&searchType=CT&optionId=33&checkin=2026-06-01&checkout=2026-06-05&crn=4&listFilters=29~1%2A29%2A1~4%2A2%2C29~2~8%2A29%2A2~8%2C29~3~11%2A29%2A3~11%2C29~4~13%2A29%2A4~13%2C80~2%2A80%2A2%2C17~1%2A17%2A1&curr=CNY&locale=zh-CN&old=1&v2_mod=11&v2_version=E`
- Decode this as:
  - Ctrip desktop hotel list page
  - city text: 桂林
  - destination text: 桂林
  - search type: city search
  - option ID: 33, only because it was present in the supplied URL
  - check-in: 2026-06-01
  - check-out: 2026-06-05
  - 4 rooms
  - 4 adults
  - 3 children
  - child ages: 8, 11, 13
  - currency: CNY
  - locale: zh-CN

Hotel search strategy:
- Prefer desktop `hotels/list` URLs over generic keyword-only hotel search pages.
- When the user provides a working Ctrip hotel list URL, preserve that URL structure and only adjust user-requested constraints.
- Treat hotel search on Ctrip as a scoped list search. Preserve the city/date/search scope instead of collapsing it into a plain keyword query.
- If starting from `https://www.ctrip.com/`, the hotel home form may submit directly to `hotels/list`. After form submission, use the resulting URL as city/date/search evidence instead of reconstructing it from memory.
- When rebuilding a URL, use the simplified no-`cityId` pattern unless the user explicitly asks to preserve the exact original URL.
- When changing only dates, update only `checkin` and `checkout`.
- When changing room/adult/child constraints, recompute `crn` and `listFilters`.
- When changing city or destination, update `cityName` and `destName`; remove stale `optionId`, `searchValue`, or scoped POI params unless the new scoped values are explicitly provided or returned by Ctrip.
- When changing only the keyword, update `searchWord` and choose `searchType` by intent: `T` for location/place, `B` for hotel brand, `H` for hotel name. Do not use `CT` with a non-empty `searchWord`.

Extraction hints for hotel list pages:
- Echo parsed city, destination, keyword, check-in, check-out, room count, adult count, child ages, currency, locale, and visible filter constraints before listing rows.
- Run `browser_snapshot` before extraction to confirm:
  - the visible list region
  - city/search scope
  - date widgets
  - occupancy widgets
  - whether the page is a login page, captcha page, or empty shell
- Prioritize visible hotel cards tied to the current city/search/date/occupancy scope.
- When `searchType=CT`, confirm the page is scoped to the city and not to a stale `searchWord`.
- When `searchType=T`, prioritize location/distance cues visible on hotel cards.
- When `searchType=B`, prioritize visible brand/name matches.
- When `searchType=H`, prioritize exact hotel-name matches and concrete hotel detail links.
- Do not infer hotel names, prices, scores, distances, room availability, cancellation terms, or booking links when they are not clearly visible.
- Do not infer a hotel detail URL unless it is present in a visible card, link, or Ctrip-provided route.

Recovery rule:
- If extraction from a hotel URL returns mostly global navigation, footer, legal text, copyright text, or an empty app shell, treat that URL choice as weak.
- Retry once with the same desktop `hotels/list` scope after:
  - `browser_wait`
  - `browser_snapshot`
  - one bounded interaction or scroll
- If still unusable, mark the extraction as degraded and ask whether to retry with adjusted city, date, keyword, or occupancy constraints.

### POI and Travel Guides

Use Ctrip `you.ctrip.com` pages when the user asks for attractions, scenic spots, museums, landmarks, destination guide context, food/restaurant ideas, travel notes, ticket ideas, opening hours, addresses, or ratings.

No-guessing contract:
- Never open, cite, or extract from a `you.ctrip.com` `place/*`, `sight/*`, `restaurant/*`, or `travels/*` URL that was made from memory, examples, hotel ids, or an inferred slug/id.
- Valid route evidence is only: helper output, a user-provided URL, a visible browser link, a URL reached by clicking a visible browser result, or a channel URL built from a verified `routeSegment` and then opened and verified.
- If no valid route evidence exists, use the global-search fallback with visible click evidence or mark the Ctrip POI path degraded.

Tool binding:
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_snapshot` -> `browser_extract`
- Preferred extract format: `format=json`
- External runtime policy: in external browser mode, continue using `browser_*`; the harness manages controlled system browser routing and auto-close when available.
- Required args: `city` for city-wide POI discovery, or `keyword` for named POI / search fallback.
- Optional args: `limit`
- Preferred source: verified Ctrip guide, sight, restaurant, travels, or POI detail pages.

If required args are missing:
1. Ask one concise follow-up question.
2. Do not fabricate city or keyword silently.

Mandatory city / destination resolution:
1. For a named city or destination, first run `../scripts/extract_ctrip_destinations.py` with exact matching:
   - `python ../scripts/extract_ctrip_destinations.py --name 三亚 --require-match`
2. Use only the returned `url` as the guide route. Examples:
   - 三亚 must resolve to `https://you.ctrip.com/place/sanya61.html`, not `https://you.ctrip.com/place/sanya3.html`.
3. `routeSegment` means the exact path segment between `/place/` and `.html` in the resolved Ctrip guide URL.
   - `https://you.ctrip.com/place/sanya61.html` -> `routeSegment=sanya61`
   - It is not the Chinese city name, not the numeric id alone, and not a hotel-channel `cityId`.
4. The helper reads `https://you.ctrip.com/`, prefers `script#__NEXT_DATA__`, and may fall back to rendered `/place/*.html` anchors.
5. Treat helper results as destination links, not strictly administrative city links; they can include cities, scenic areas, islands, regions, and landmarks.

Primary workflow:
1. Open the exact resolved `place/*` guide URL.
2. Run `browser_snapshot` and verify the title, heading, breadcrumb, or visible guide link names the requested city/destination.
3. If the opened page is generic or exposes a different exact link for the requested destination, switch to that exact link before extracting.
4. For attractions, use visible `景点` navigation or construct `https://you.ctrip.com/sight/{routeSegment}.html` only from the verified `routeSegment`; open and verify it before extracting POI cards.
5. For related content, construct these entries only from the verified `routeSegment`, and only when the user asks for that content:
   - food / restaurants: `https://you.ctrip.com/restaurant/{routeSegment}.html`
   - travel notes / guides: `https://you.ctrip.com/travels/{routeSegment}.html`
6. On list pages, extract visible cards first; click concrete detail links only when full detail is needed.

Global-search fallback:
- Use `https://you.ctrip.com/globalsearch/?keyword={encodedKeyword}` only when the helper cannot run, returns no exact match, or the request is for a specific POI/keyword rather than a destination.
- After `browser_snapshot`, click only a visible result/card/ref that matches the requested city, destination, or POI.
- Check `elements` and `tree`, not only `links`; Ctrip may render clickable result cards without visible `href`.
- If no matching visible result/ref exists after one bounded wait or scroll, mark POI retrieval degraded instead of guessing a route.

Extraction fields:
- POI rows: `name`, `category`, `rating`, `commentCount`, `price`, `address`, `openingHours`, `rankOrBadge`, `detailUrl`, `sourceUrl`, `sourceTitle`, `publisherOrSite`, `observedAt`, `evidenceFields`
- Guide/article rows: `title`, `publishDate`, `readCountText`, `startMonthText`, `tripDaysText`, `perCapitaCostText`, `travelWithText`, `keyItinerary`, `relatedPoiLinks`, `sourceUrl`, `sourceTitle`, `publisherOrSite`, `observedAt`, `evidenceFields`

Quality gate:
- Before extraction, confirm the page is not just global navigation, footer, copyright, an empty search shell, or a generic guide page.
- Run `browser_snapshot` before each click that chooses a city, scenic spot, tab, or result card.
- Run `browser_extract format=json` only after the final guide/list/detail page is visibly stable.
- Keep conflicts explicit if the visible city/scenic name disagrees with the path segment.
- Never fabricate POI names, ratings, prices, opening hours, addresses, or links.

Degradation and retry:
- If browser extraction returns zero rows or explicit error, state this clearly.
- Ask whether to retry with adjusted city, destination, or keyword constraints.
- Keep uncertainty visible if only degraded or fallback data is available.

Implementation note for the helper:
- It parses:
   - `props.pageProps.initialState.CitySelectorData.domesticTab.tabList[*].districtList[*]`
   - `props.pageProps.initialState.CitySelectorData.internationalTab.tabList[*].districtList[*]`



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
