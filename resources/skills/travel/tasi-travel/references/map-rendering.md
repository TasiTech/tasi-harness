# Map Rendering Mechanism

Status: Step 4A is temporarily disabled in the `tasi-travel` entry skill.
Keep this file as parked design notes only; do not generate map artifacts from the current default workflow.

## Goal
Provide stable map rendering without repeatedly calling route APIs on every page open.

## Runtime Assets
Skill-local executable files:
- backend: `../assets/map/app.py`
- frontend: `../assets/map/map.html`

Notes:
- these files are copied from workspace `map/` for skill-local execution
- keep both copies in sync when runtime logic changes

## Runtime Process Model
The map backend process (`../assets/map/app.py`) is treated as a persistent background service managed by the skill runtime.

Rules:
- No manual startup is required during normal skill execution.
- Do not instruct users to run `python app.py` as a default step.
- Assume map service endpoint is continuously available at `http://127.0.0.1:8123`.
- If the service is unavailable, mark map rendering as degraded and continue with fallback behavior.

## Trigger
Use this module when:
- user asks for map output or route visualization
- itinerary output includes a map artifact
- route drawing quality or refresh behavior is in scope

## Inputs
- map_render_request:
	- map_enabled
	- map_focus (`city|day|full_trip`)
	- map_file_name (optional)
	- force_refresh_routes (optional)
- normalized itinerary segments with start/end coordinates
- provider availability and key status

## Route Artifact Storage
Write/read rules for map route JSON:
- Route JSON files are read by the runtime backend from `routes/` next to the running `app.py`.
- `map_file_name` is a basename only (for example: `routes_beijing_20260410.json`), not a directory path.
- Never write route JSON to an assumed workspace path unless it is confirmed to be the active runtime `app.py` directory.
- Typical hosted runtime example: `C:/Users/dell/.qwen/skills/tasi-travel/assets/map/routes/`.

Operational note:
- If the runtime route directory cannot be written, mark map rendering as degraded and provide itinerary output with explicit map unavailability notes.

## Workflow
1. Parse map request and determine render scope (`day` or `full_trip`).
2. Build route segments from itinerary order.
3. Resolve geometry source using priority:
	 - precomputed route geometry
	 - persisted cache
	 - live provider call
4. Generate map artifact JSON and persist it with metadata.
5. Return map rendering notes in final itinerary output.

## Cache Policy
Use three cache layers:
1. In-turn memory cache (single run/session)
2. Persisted local cache artifact (JSON)
3. Live provider API (only when needed)

Segment fingerprint fields:
- mode
- origin lat/lng
- destination lat/lng
- date window (if relevant)
- provider

Example:

```text
sha256("walking|39.9093,116.3974|39.9165,116.3971|2026-05-01..2026-05-03|tencent_map")
```

TTL rules:
- transit: 1800 seconds (30 minutes)
- driving/walking/bicycling/ebicycling/edriving: 86400 seconds (24 hours)

Refresh only when one is true:
- `force_refresh_routes=true`
- cache expired
- fingerprint changed
- required geometry fields missing

Cache state values for logs:
- `precomputed_hit`
- `cache_hit`
- `cache_miss`
- `stale_refresh`

## Map Artifact Contract
Required top-level fields:
- `center`: `{ lat, lng }`
- `zoom`: number
- `routes`: array

Required fields per route:
- `id`
- `group`
- `mode`
- `start`: `{ name, lat, lng }`
- `end`: `{ name, lat, lng }`
- `precomputed_route`:
	- `path`: array of `{ lat, lng }`
	- `distance` (optional but recommended)
	- `duration` (optional but recommended)
- `cache`:
	- `fingerprint`
	- `generated_at`
	- `ttl_seconds`
	- `provider`
	- `status`

Minimum example:

```json
{
	"center": { "lat": 39.90923, "lng": 116.397428 },
	"zoom": 12,
	"routes": [
		{
			"id": "D1-R1",
			"group": "Day 1",
			"mode": "walking",
			"start": { "name": "景点A", "lat": 39.9093, "lng": 116.3974 },
			"end": { "name": "景点B", "lat": 39.9165, "lng": 116.3971 },
			"precomputed_route": {
				"distance": 1200,
				"duration": 900,
				"path": [
					{ "lat": 39.9093, "lng": 116.3974 },
					{ "lat": 39.9120, "lng": 116.3970 },
					{ "lat": 39.9165, "lng": 116.3971 }
				]
			},
			"cache": {
				"fingerprint": "<sha256>",
				"generated_at": "2026-04-07T09:30:00Z",
				"ttl_seconds": 86400,
				"provider": "tencent_map",
				"status": "fresh"
			}
		}
	]
}
```

## Logging Requirement
Record one normalized log object per route segment:

```json
{
	"tool": "direction",
	"provider": "tencent_map",
	"params": { "mode": "walking", "from": "...", "to": "..." },
	"status": "success|degraded|failed",
	"result_summary": "distance/duration/path_count",
	"evidence_ref": "route:D1-R1",
	"cache_state": "precomputed_hit|cache_hit|cache_miss|stale_refresh"
}
```

## Degrade and Fallback
If provider API is degraded/unavailable:
1. keep valid cached or precomputed geometry if present
2. otherwise fallback to straight-line geometry
3. mark uncertainty explicitly
4. never hide degraded state
