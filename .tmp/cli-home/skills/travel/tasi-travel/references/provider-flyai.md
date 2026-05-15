# Provider: Flyai

## Purpose
Primary provider for booking-oriented retrieval:
- flights
- hotels
- trains
- POI with booking links
- semantic travel search

## Setup
```bash
npm install -g @fly-ai/flyai-cli
flyai --help
```

Auth modes:
- `none`: runtime can call Flyai without user-provided key
- `api_key`: runtime requires explicit `FLYAI_API_KEY` and optional `FLYAI_SIGN_SECRET`

Detection order (required):
1. Probe command/runtime capability first: `flyai --help`.
2. Run a minimal read-only request without credential override when supported.
3. If the provider returns explicit auth failure (401/403/invalid credential), request credentials.
4. Do not ask for credentials before probe unless user explicitly requests key-only mode.

Optional key override (when auth is required):

Bash:
```bash
export FLYAI_API_KEY="your_api_key"
export FLYAI_SIGN_SECRET="your_sign_secret"
```

PowerShell:
```powershell
$env:FLYAI_API_KEY = "your_api_key"
$env:FLYAI_SIGN_SECRET = "your_sign_secret"
```

## Recommended Commands
- POI: `flyai search-poi --city-name <CITY> [--keyword <KW>]`
- Hotel: `flyai search-hotel --dest-name <DEST> [--check-in-date <YYYY-MM-DD>] [--check-out-date <YYYY-MM-DD>]`
- Flight: `flyai search-flight --origin <CITY> [--destination <CITY>] [--dep-date <YYYY-MM-DD>]`
- Train: `flyai search-train --origin <CITY> [--destination <CITY>] [--dep-date <YYYY-MM-DD>]`
- Semantic: `flyai ai-search --query <TEXT>`

## Execution Rules
1. Verify command availability first: `flyai --help`.
2. Run capability probe before prompting for credential input.
3. Validate required options before execution.
4. Prefer targeted commands over broad search when constraints are clear.
5. Use semantic search only for ambiguous intent.
6. Never fabricate output.

## Credential Prompt Rules
- Ask user for Flyai credentials only when auth failure is explicit.
- If request failed for non-auth reasons (network, quota, timeout), do not label as missing credential.
- In normalized logs, keep auth and non-auth failures distinguishable.

Suggested status mapping:
- explicit auth failure (401/403/invalid credential): `failed_auth`
- quota/rate-limit (429/trial limit/rate limit): `degraded_quota`
- network/timeout/transport errors: `failed_network`

## Degrade Rules
Treat these as quota/rate-limit:
- HTTP 429
- Trial limit reached
- Rate limit exceeded

On degrade:
1. Stop repeated retries for the same category in this turn.
2. Mark status as degraded.
3. Route POI/route/weather needs to Tencent Map.
4. Keep booking links strict: use only verified fields (`jumpUrl`, `detailUrl`).
