---
name: tasi-travel
description: "Use when users ask for travel planning or itinerary generation (e.g., travel planning/itinerary), especially with constraints like destination, dates, budget, and travelers; this entry skill orchestrates providers and loads provider references on demand."
---

# Tasi-Travel Skill (Entry)

## Purpose
Provide a single entry workflow for trip planning while keeping provider logic modular and extensible.

## Architecture
This skill uses an entry-plus-modules structure:
- Entry layer (this file): request understanding, orchestration, provider routing, and output assembly.
- Provider layer: platform-specific retrieval and normalization.
- Browser evidence layer: Ctrip web retrieval through built-in `browser_*` tools, with runtime mode handled by the harness.
- Visualization layer: map route link generation and formatting policy (Amap URL).
- Capability details: kept inside provider docs to reduce fragmentation while preserving extension points.

## Required Inputs
- user_request
- constraints:
  - city_or_region
  - start_date
  - end_date
  - traveler_count
  - total_budget
  - must_visit (optional)
  - avoid_items (optional)
  - hotel_preference (optional)
  - transport_preference (optional)
- tool_capabilities: list of available tools and keys
- feedback_history (optional)
- map_render_request (optional):
  - map_enabled (bool; default true)
  - map_focus (day, optional; default day)
  - travel_mode (car|walk|bus|bike, optional; default car)
  - use_lnglat (bool, optional; default false)

## Provider Configuration

### Provider Priority by Capability

| Capability | Primary Provider | Secondary Provider | Fallback |
|---|---|---|---|
| Flight search | ctrip_browser | flyai | offline_estimate |
| Hotel search | ctrip_browser | flyai | offline_estimate |
| Train search | ctrip_browser | flyai | offline_estimate |
| POI discovery | ctrip_browser | flyai | offline_estimate |
| Route/Distance matrix | flyai | tencent_map | offline_estimate |
| Weather | flyai | tencent_map | offline_estimate |

### Offline Fallback Definitions
- `offline_sketch`: a fallback mechanism that fills content using alternative methods or offline/pre-generated data when dynamic services are unavailable.
- `offline_estimate`: a fallback mechanism that generates conservative approximations using heuristics, historical averages, or cached static data when online providers fail. Results must be explicitly marked with `[estimated]`.

### Provider Details

| Provider | Auth Method | Rate Limit Handling | Credential Key |
|---|---|---|---|
| flyai | Probe first; ask on 401/403 only | Stop retries; mark degraded; fallback | Not required unless auth error |
| ctrip_browser | Browser tools first; external mode is harness-managed (auto-detect controlled runtime, then fallback opener if needed) | Stop retries; mark degraded; fallback | None |
| tencent_map | Check key availability for non-map capabilities only | Stop retries; mark degraded; fallback | TENCENT_KEY or TENCENT_MAP_KEY |

### Provider References
- flyai: ./references/provider-flyai.md
- tencent-map: ./references/provider-tencent-map.md
- ctrip-browser: ./references/provider-ctrip-browser.md
- Ctrip guide: ./references/ctrip-information-search-guide.md
- Extension guide: ./references/provider-extension.md
- Tasi browser automation skill: ../../browser/tasi-browser-automation/SKILL.md
- Built-in browser operator: ../../browser/embedded-browser-operator/SKILL.md

### Helper Scripts
- Ctrip destination links: ./scripts/extract_ctrip_destinations.py

## Provider Routing Policy

### Selection Logic
1. **Priority queue**: for each capability, attempt providers in priority order.
2. **Fallback chain**:
   - Attempt the current provider.
   - If `status` is `failed`, `degraded`, or missing required fields, auto-fallback to the next provider.
   - For hotel, POI, flight, and train information, try `ctrip_browser` first. If browser extraction returns no accepted rows or cannot produce usable evidence, fall back to `flyai`.
   - If all providers fail, trigger `Offline Degradation Mode`.
3. **Browser policy**:
   - In both embedded and external modes, use `browser_*` tools as the default Ctrip workflow.
   - In external mode, rely on harness-managed external runtime selection (Chromium-family via CDP first; Safari via WebDriver on macOS when configured).
   - If controlled external runtime is unavailable and the harness falls back to a plain external opener, continue workflow and keep uncertainty visible; do not block on manual runtime setup.

### Degradation Rules
- **HTTP 429 / Rate Limit / Trial Limit**: mark category as `degraded`, stop retries for this turn, and switch to the next provider.
- **Auth Error (401/403)**: for flyai, prompt user for credentials. For tencent_map with map_enabled=true, ask for TENCENT_KEY or confirm offline degradation.
- **Network / Quota Failure**: treat as degraded and fall back to the next provider.
- **Browser Failure**: if browser tools fail, the page does not load, or extraction is blocked, mark the category as degraded and fall back.
- **All Providers Failed**: return conservative offline suggestions with explicit uncertainty marking.

## Hotel Search Integration (Ctrip/Browser Tools)

### When to Trigger
Use hotel search when the user asks for nearby hotels, accommodation options, hotel comparison, or booking links.

### Tool Binding
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_snapshot` -> `browser_extract`
- Preferred extract format: `format=json`
- External runtime policy: in external browser mode, continue using `browser_*`; the harness manages controlled system browser routing and auto-close when available.
- Required args: `city`, `check_in`, `check_out`
- Optional args: `keyword`, `limit`
- Preferred source: Ctrip hotel list or search pages that match the requested city and date range.

If required args are missing:
1. Ask one concise follow-up question.
2. Convert relative dates to absolute `YYYY-MM-DD` before opening any browser page.
3. Do not fabricate or guess dates or city silently.

### Extraction Rules
1. Open the hotel list or search page with the requested city and dates.
2. Wait for a stable hotel list container before extracting content.
3. Run `browser_snapshot` to inspect the page structure, visible hotel-card regions, and available link/click refs before extraction.
4. Scroll only when needed to load visible hotel cards, then run `browser_snapshot` again if the visible card set changed.
5. Extract bounded JSON from visible cards with `browser_extract` using `format=json`, then normalize rows.
6. Preserve the active listing page URL as `sourceUrl` whenever item-level detail links are missing.

### Output Contract for Hotel Rows
When extraction succeeds, render hotel recommendations directly from normalized browser rows.
Each displayed row should keep these fields whenever available:
- `hotelName`
- `price`
- `score`
- `distanceText`
- `detailUrl` (preferred booking/detail link)
- `sourceUrl` (fallback list link)

Never fabricate hotel names, prices, scores, areas, or booking links.

### Degradation and Retry Policy
- If browser extraction returns zero accepted rows or explicit error, state this clearly.
- Ask the user whether to retry with adjusted inputs such as city, date range, or keyword.
- Keep uncertainty visible if only degraded or fallback data is available.

## POI Search Integration (Ctrip/Browser Tools)

### When to Trigger
Use POI search when the user asks for city attractions, scenic spots, museums, landmarks, ticket ideas, or nearby places to visit.

### Tool Binding
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_snapshot` -> `browser_extract`
- Preferred extract format: `format=json`
- External runtime policy: in external browser mode, continue using `browser_*`; the harness manages controlled system browser routing and auto-close when available.
- Required args: `city`
- Optional args: `keyword`, `limit`
- Preferred source: Ctrip sight or guide listing pages and clearly attributable POI detail pages.

If required args are missing:
1. Ask one concise follow-up question.
2. Do not fabricate city or keyword silently.

### Extraction Rules
1. Open the relevant Ctrip city sight list or search page.
2. Wait for the list container or detail content to stabilize before extraction.
3. Run `browser_snapshot` to inspect result cards, city/POI/detail links, hover/click refs, and visible page sections before extraction.
4. Scroll only when needed for lazy-loaded result cards, then run `browser_snapshot` again if new result cards or links appear.
5. Extract bounded JSON card content with `browser_extract` using `format=json`, and capture visible detail or list URLs.
6. Normalize result rows and keep the page URL as a fallback `sourceUrl`.

### Output Contract for POI Rows
When POI retrieval succeeds, render attraction rows directly from normalized browser output.
Each displayed row should keep these fields whenever available:
- `name`
- `category`
- `rating`
- `price`
- `address`
- `detailUrl` (preferred detail/booking link)
- `sourceUrl` (fallback list link)

Never fabricate POI names, categories, prices, or links.

### Degradation and Retry Policy
- If browser extraction returns zero rows or explicit error, state this clearly.
- Ask the user whether to retry with adjusted city or keyword constraints.
- Keep uncertainty visible if only degraded or fallback data is available.

## Integrated Workflow

### Goal
Turn user constraints into an executable itinerary with evidence, uncertainty labels, and fallback options.

### Step 1: Understand Request
Extract:
- destination and date range
- traveler count and budget
- must-visit and avoid constraints
- transport and hotel preferences

If critical constraints are missing, ask concise follow-up questions.

### Step 2: Collect Evidence
Execute provider calls following the priority table:
- For each requested capability, try providers in order.
- Apply degradation rules from the Provider Routing Policy.
- Record each call using canonical tool logs.
- For hotel, POI, flight, and train information, start with `ctrip_browser` using browser tools. Only if Ctrip browser retrieval fails or returns insufficient usable rows should the workflow fall back to `flyai`.
- Preserve a source ledger while collecting evidence. For each usable source, keep `sourceId`, `sourceTitle`, `publisherOrSite`, `sourceUrl`, `observedAt`, and the exact fields supported by that source.
- Treat provider result links as evidence only when the page was opened/inspected or returned by a trusted provider response with enough context to support the displayed fields.

Auth and capability probe rules:
- Run capability probe first for providers that support it.
- Ask for credentials only on explicit auth errors (401/403), not on generic network or quota failures.

### Step 2A: Source Ledger and Citation Handoff
Goal: preserve data traceability from provider collection to final itinerary output.

Rules:
1. Assign citation numbers in first-use order from the source ledger.
2. Reuse the same number for the same `sourceUrl`.
3. Keep citation links in renderer-detectable Markdown format: `[1](https://...)`.
4. URL-encode spaces and unsafe characters in citation URLs; do not leave raw spaces inside link destinations.
5. Use item detail URLs as evidence when they support the displayed item fields. Use the list/search page URL when detail links are missing or when the list page is the only inspected evidence.
6. Keep action links separate from evidence links. Booking, route, map, and generated search URLs are useful actions, but they are not evidence unless opened/inspected as a source.
7. If a data value is estimated, inferred, generated from URL parameters, or not directly visible in a source, label it as `[estimated]`, `[inferred]`, or `[unverified]`.

### Step 3: Degrade Strategy
Apply the degradation rules consistently:
1. Stop repeated retries for the same category in this turn.
2. Mark the category as degraded.
3. Route to the alternate provider per the priority table.
4. If all providers fail, use conservative offline suggestions and clearly mark uncertainty.

### Step 4: Build Itinerary
- Produce a day-by-day schedule.
- Leave transportation time plus a flexible buffer between activities.
- Avoid overloading any single day.
- If multiple `must_visit` items cannot be reasonably covered within the given date range due to geographic dispersion, either distribute them across available days with clear labeling or flag this in "Risks and missing information" with a recommendation to prioritize or extend the trip.

### Step 4A: Build Amap Route Links (When Map Is Requested)
Goal: output one direct Amap route Markdown link per itinerary day. Do not wrap routes in a local HTML viewer.

Entry-level rules:
1. Generate direct Amap routing URLs using name-only mode by default for simplicity and robustness.
2. If `use_lnglat=true`, include both `name` and `lnglat` for each point to avoid ambiguity.
3. Enforce Amap limitations: only `car` supports via points, up to 6 via points, and the total number of points (including origin and destination) must not exceed 8.
4. For `walk`, `bus`, or `bike`, ignore via points and explain that Amap will ignore them. If a non-car day has multiple stops, generate a direct `car` route link as a route preview and label it clearly.
5. Map focus behavior is always `day`: generate one direct Amap link per day that has routeable stops.

Link Generation:
- Use direct Amap URLs starting with `https://ditu.amap.com/dir`.
- Encode Chinese names and special characters in final Markdown links when needed.
- For each day, use the first routeable stop as `from[name]`, the last routeable stop as `to[name]`, and intermediate stops as `via[i][name]` when `type=car`.
- If a day has more than 8 total points, keep the most important 8 points and mention that extra stops are omitted from the map link.

Fallback Strategy:
- If a day has fewer than two routeable stops, omit that day's map link and state why.
- If Amap URL generation is ambiguous, provide a direct Amap search URL or mark the map link as unavailable instead of fabricating coordinates.

Example:
```markdown
- Day 1 map: [机场 -> 解放碑 -> 洪崖洞](https://ditu.amap.com/dir?from[name]=重庆江北国际机场&to[name]=洪崖洞民俗风貌区&type=car&via[0][name]=解放碑步行街)
- Day 2 map: [解放碑 -> 长江索道 -> 南山一棵树](https://ditu.amap.com/dir?from[name]=解放碑步行街&to[name]=南山一棵树观景台&type=car&via[0][name]=长江索道)
```

### Step 5: Budget and Risks
Provide a budget split for:
- hotel
- transport
- food
- attractions
- contingency

Always include:
- uncertainty notes
- at least one fallback for weather, closure, or disruption

### Step 6: Verify and Revise
After drafting the itinerary, perform a full-pass verification before final output.

Verification checklist:
1. Distance and commute load: check whether consecutive spots are too far apart or commute time is too long and exhausting.
2. Time logic: check open hours, transfer time, meal windows, and day boundaries for scheduling conflicts.
3. Activity duration fit: check whether major attractions that require long visits are given enough stay time.
4. Daily intensity: avoid packing too many heavy activities into one day.
5. Constraint consistency: verify must-visit items, avoid-items, budget, and traveler preferences are still satisfied.

Compactness label (must assign one):
- Relaxed: low commute load, enough rest windows, and limited daily activity density.
- Moderate: balanced commute and activity density with a manageable day rhythm.
- Compact: high activity density and/or long commute blocks, but still feasible.

If any issue is found:
- revise route order, time allocation, and transport mode;
- keep uncertainty labels when evidence is weak;
- then re-check once before publishing the final itinerary.

## Output Contract

### Required Sections
The final Markdown output must include:
1. Overview
2. Day-by-day itinerary
3. Budget breakdown
4. Transport notes
5. Hotel and dining recommendations
6. Alternatives and fallback options
7. Risks and missing information
8. One-Click Booking Links
9. Verification notes (what was checked and what was adjusted)
10. Itinerary compactness label (Relaxed/Moderate/Compact)
11. Data Sources / Sources

When `map_render_request.map_enabled` is true, also include:
12. Per-day Amap route link notes (mode, via limits, and link formatting)

### Evidence and Citation Contract
The final itinerary must preserve citations for sourced travel data.

Data that requires a nearby citation:
- flight numbers, airline names, departure/arrival times, fare or fare range, airport names, and availability status
- train numbers, departure/arrival times, duration, fare or seat class, station names, and availability status
- hotel names, prices, scores/ratings, location or distance text, room/policy details, and booking/detail links
- POI names, ratings, comment counts, ticket prices, opening hours, addresses, and attraction/detail links
- weather, policy, closure, crowding, traffic, or other current/contextual claims

Citation placement:
- In paragraphs, place the citation immediately after the supported sentence or value.
- In tables, place the citation in the same row, the same data cell, or a dedicated Source column.
- Do not put all citations only in a final list when individual rows contain distinct sourced data.
- Do not cite a generic homepage, search page, or encyclopedia page for item-level data when an opened list/detail/article page is available.

`Data Sources / Sources` section:
- Required when any web/provider data is used.
- Preserve the same citation numbers used inline.
- Write each source number as an actual Markdown link, for example `[1](https://example.com/source) Ctrip hotel list`. Do not write plain `[1] Ctrip hotel list`.
- Include source title or publisher/site plus the actual Markdown link.
- Keep it compact; do not repeat every booking/action link unless it was also the evidence source.
- Never write vague entries such as "Ctrip data", "media reports", or "multiple sources" without actual links.

Example:
```markdown
| Option | Key data | Source |
| --- | --- | --- |
| Flight JD5755 | 07:55-10:35, fare from CNY 520[1](https://flights.ctrip.com/online/list/oneway-bjs-ckg?depdate=2026-06-01) | Ctrip flight list |
| Hotel A | Score 4.8, from CNY 120/night[2](https://hotels.ctrip.com/hotels/detail/?hotelId=123) | Ctrip hotel detail |

Sources: [1](https://flights.ctrip.com/online/list/oneway-bjs-ckg?depdate=2026-06-01) Ctrip flight list; [2](https://hotels.ctrip.com/hotels/detail/?hotelId=123) Ctrip hotel detail
```

### Per-Day Amap Route Link Contract (When Map Is Requested)
Generate one direct Amap route URL per itinerary day based on either name-only or lnglat-enhanced mode.

**Base URL**: `https://ditu.amap.com/dir`

#### Name-Only Mode (Recommended)
Required:
- `from[name]={origin}`
- `to[name]={destination}`
- `type={car|walk|bus|bike}`

Optional (car only, up to 6 via points):
- `via[0][name]={stop1}` ... `via[5][name]={stop6}`

Template:
```text
https://ditu.amap.com/dir?from[name]={origin}&to[name]={destination}&type=car&via[0][name]={stop1}&via[1][name]={stop2}
```

#### Lnglat Mode (Precise Control)
When using coordinates, always include `name` as label and `lnglat` as routing anchor.

Required:
- `from[name]={origin}`
- `from[lnglat]={lng},{lat}`
- `to[name]={destination}`
- `to[lnglat]={lng},{lat}`
- `type={car|walk|bus|bike}`

Optional (car only, up to 6 via points):
- `via[i][name]={stop}`
- `via[i][lnglat]={lng},{lat}`

Template:
```text
https://ditu.amap.com/dir?from[name]={origin}&from[lnglat]={lng},{lat}&to[name]={destination}&to[lnglat]={lng},{lat}&type=car&via[0][name]={stop1}&via[0][lnglat]={lng},{lat}
```

#### Rules
- Output per-day Markdown links only, such as `Day 1 map: [A -> B -> C](https://ditu.amap.com/dir?...)`.
- Via points are supported only when `type=car` and are ignored for `walk`, `bus`, `bike`.
- If a walking (or other non-car) itinerary must show via points, include a direct `car` link that chains the day's POIs as a sample visualization and label it clearly.
- Max via points: 6 (indices 0..5), total points <= 8.
- `lnglat` order is `longitude,latitude`.
- URL-encoding for Chinese names is recommended but not required.

### Booking Links Policy
- Use verified links from provider results when present.
- For train ticket booking, always display the official 12306 link generated from the template and validated by the precision rules below.
- If a link is unavailable, keep the item and mark the reason explicitly.
- Never fabricate links.

### Link Sources
| Category | Platform | Link Source |
|---|---|---|
| Attraction tickets | Ctrip | `detailUrl` or `sourceUrl` from provider POI |
| Flights | Provider-native | `jumpUrl` or equivalent verified provider link |
| Hotels | Ctrip | `detailUrl` or `sourceUrl` from provider hotel |
| Trains | 12306 | Constructed URL |

### Evidence Links vs Action Links
| Link Type | Purpose | Can support citations? |
|---|---|---|
| Evidence link | Source page inspected or returned with provider evidence fields | Yes |
| Booking link | User action to book a flight, hotel, train, or ticket | Only if it is also the inspected evidence source |
| Map/route link | User action to view route | No, unless the route/distance data was inspected from that page |
| Generated search link | User action to continue searching | No, unless it was opened and extracted as evidence |

### 12306 URL Template

```text
https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs={origin_city},{origin_code}&ts={dest_city},{dest_code}&date={YYYY-MM-DD}&flag=N,N,Y
```

### 12306 Link Precision Rules
- Use ASCII comma `,` in `fs` and `ts` values.
- Prefer station-level pairs when a specific station is recommended by the itinerary.
- If the itinerary specifies only city-level departure or arrival, use city-level codes consistently.
- Station or city name and code must match the same location. Never mix mismatched name-code pairs.
- URL-encode Chinese station or city names in the final rendered URL when needed.
- Validate one final time before output:
  - route direction in the URL matches the displayed route direction;
  - date matches the corresponding itinerary day;
  - `flag` remains `N,N,Y`.

Reference city-level example:

```text
https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E6%B5%8E%E5%8D%97,JNK&ts=%E5%8C%97%E4%BA%AC,BJP&date=2026-04-10&flag=N,N,Y
```

### Unavailable Link Handling
Format example:
- Unavailable (provider quota limit); fallback: manual search on a trusted channel.

## Execution Contract
All provider outputs should be normalized before itinerary assembly.

Canonical tool log object:

```json
{
  "tool": "string",
  "provider": "flyai|ctrip_browser|tencent_map|future_provider",
  "params": {},
  "status": "success|degraded|failed",
  "result_summary": "string",
  "evidence_ref": "string",
  "sources": [
    {
      "sourceId": "string",
      "sourceTitle": "string",
      "publisherOrSite": "string",
      "sourceUrl": "https://example.com/source",
      "observedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
      "supports": ["field_or_claim"]
    }
  ]
}
```

## Forbidden Behavior
- Never fabricate tool data.
- Never hide degraded states.
- Never present uncertain data as confirmed.
