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
  - map_focus (city|day|full_trip, optional; default day)
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
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_extract`
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
3. Scroll only when needed to load visible hotel cards.
4. Extract bounded JSON from visible cards with `browser_extract` using `format=json`, then normalize rows.
5. Preserve the active listing page URL as `sourceUrl` whenever item-level detail links are missing.

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
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_extract`
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
3. Scroll only when needed for lazy-loaded result cards.
4. Extract bounded JSON card content with `browser_extract` using `format=json`, and capture visible detail or list URLs.
5. Normalize result rows and keep the page URL as a fallback `sourceUrl`.

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

Auth and capability probe rules:
- Run capability probe first for providers that support it.
- Ask for credentials only on explicit auth errors (401/403), not on generic network or quota failures.

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
Goal: output an Amap route URL instead of generating map artifacts.

Entry-level rules:
1. Use name-only mode by default for simplicity and robustness.
2. If `use_lnglat=true`, include both `name` and `lnglat` for each point to avoid ambiguity.
3. Enforce Amap limitations: only `car` supports via points, up to 6 via points, and the total number of points (including origin and destination) must not exceed 8.
4. For `walk`, `bus`, or `bike`, ignore via points and explain that Amap will ignore them. If you want to display the route more clearly and connect the locations, also provide a separate `car` link that includes all POIs as a demonstration.
5. Map focus behavior:
  - `day` (default): generate one Amap link per day.
  - `full_trip`: attempt a single link for the whole trip (may exceed Amap point limits).
  - `city`: generate a single intra-city link when the trip stays within one city.

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

When `map_render_request.map_enabled` is true, also include:
11. Amap route link notes (mode, via limits, and link formatting)

### Amap Route Link Contract (When Map Is Requested)
Generate an Amap route URL based on either name-only or lnglat-enhanced mode.

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
- Via points are supported only when `type=car` and are ignored for `walk`, `bus`, `bike`.
- If a walking (or other non-car) itinerary must show via points, include a separate `car` link that chains all POIs as a sample visualization.
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
  "evidence_ref": "string"
}
```

## Forbidden Behavior
- Never fabricate tool data.
- Never hide degraded states.
- Never present uncertain data as confirmed.
