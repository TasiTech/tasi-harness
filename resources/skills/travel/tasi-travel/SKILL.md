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
- Browser evidence layer: Ctrip web retrieval through Agent Browser or built-in `browser_*` tools.
- Visualization layer: parked for now; Step 4A map artifact generation is temporarily disabled.
- Asset layer: map runtime files under `./assets/map/` are retained for future re-enable, but are not part of the active workflow right now.
- Capability details: kept inside provider docs to reduce fragmentation while preserving extension points.

## Runtime Assets
Skill-bundled map runtime files:
- Python backend: `./assets/map/app.py`
- Map frontend: `./assets/map/map.html`

These files remain bundled, but the entry workflow currently does not start them because Step 4A is temporarily disabled.

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
  - map_enabled (bool)
  - map_focus (city|day|full_trip)
  - map_file_name (optional)
  - force_refresh_routes (optional, default false)

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
| Map rendering | disabled_temporarily | offline_sketch | N/A |

### Offline Fallback Definitions
- `offline_sketch`: a fallback mechanism that fills content using alternative methods or offline/pre-generated data when dynamic services are unavailable.
- `offline_estimate`: a fallback mechanism that generates conservative approximations using heuristics, historical averages, or cached static data when online providers fail. Results must be explicitly marked with `[estimated]`.

### Provider Details

| Provider | Auth Method | Rate Limit Handling | Credential Key |
|---|---|---|---|
| flyai | Probe first; ask on 401/403 only | Stop retries; mark degraded; fallback | Not required unless auth error |
| ctrip_browser | Browser-mode dependent; do not assume an external bridge exists | Stop retries; mark degraded; fallback | None |
| tencent_map | Check key availability for non-map capabilities only | Stop retries; mark degraded; fallback | TENCENT_KEY or TENCENT_MAP_KEY |

### Provider References
- flyai: ./references/provider-flyai.md
- tencent-map: ./references/provider-tencent-map.md
- ctrip-browser: ./references/provider-ctrip-browser.md
- Ctrip guide: ./references/ctrip-information-search-guide.md
- Extension guide: ./references/provider-extension.md
- Agent Browser skill: ../../browser/agent-browser/SKILL.md
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
   - In embedded mode, use built-in `browser_*` tools as the default Ctrip workflow.
   - In external mode, prefer Agent Browser only when a working external bridge is clearly available.
   - If bridge availability is unknown, disconnected, or unstable, continue with `browser_*` tools instead of blocking on bridge setup.

### Degradation Rules
- **HTTP 429 / Rate Limit / Trial Limit**: mark category as `degraded`, stop retries for this turn, and switch to the next provider.
- **Auth Error (401/403)**: for flyai, prompt user for credentials. For map requests, do not ask for Tencent map credentials yet because Step 4A is temporarily disabled; continue without map artifacts and note the limitation.
- **Network / Quota Failure**: treat as degraded and fall back to the next provider.
- **Browser Failure**: if browser tools fail, the page does not load, or extraction is blocked, mark the category as degraded and fall back.
- **All Providers Failed**: return conservative offline suggestions with explicit uncertainty marking.

## Hotel Search Integration (Ctrip/Browser Tools)

### When to Trigger
Use hotel search when the user asks for nearby hotels, accommodation options, hotel comparison, or booking links.

### Tool Binding
- Preferred workflow: `browser_open` -> `browser_wait` -> `browser_extract`
- Preferred extract format: `format=json`
- External bridge policy: in external browser mode, prefer Agent Browser only when a working external bridge is clearly available; otherwise continue with `browser_*` tools.
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
- External bridge policy: in external browser mode, prefer Agent Browser only when a working external bridge is clearly available; otherwise continue with `browser_*` tools.
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
- When `map_render_request.map_enabled=true`, acknowledge that map artifact generation is temporarily disabled in this skill version and continue without requesting map keys or starting map services.

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

### Step 4A: Map Artifact Build Disabled (Temporarily Off)
Status: disabled for now.

Entry-level rules:
1. Do not generate route JSON artifacts in the current workflow.
2. Do not start or depend on `./assets/map/app.py`.
3. Do not ask the user for Tencent map keys solely for map rendering.
4. If the user requests a map, state that Step 4A is temporarily unavailable and continue with textual itinerary and transport guidance.

Design notes for a future re-enable remain parked in:
- `./references/map-rendering.md`

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
11. Map status note (Step 4A is temporarily disabled; no artifact was generated)

### Map Artifact Contract (Temporarily Disabled)
Do not produce or persist a map JSON artifact in the current workflow.

If the user requested map output:
- explicitly state that Step 4A is disabled;
- do not mention cache policy, file names, or refresh conditions as if they were executed;
- continue with itinerary content and textual transport notes only.

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
