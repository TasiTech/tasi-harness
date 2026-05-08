# Provider Extension Guide

## Goal
Add new travel platforms without changing the entry workflow contract.

## Provider Interface (Logical)
Each provider should expose these capabilities:
- availability_check(context) -> status, reason
- search_transport(input) -> normalized transport list
- search_hotel(input) -> normalized hotel list
- search_poi(input) -> normalized poi list
- search_weather_or_context(input) -> optional normalized context
- build_booking_link(item) -> verified link or unavailable reason

## Normalized Result Contract

```json
{
  "provider": "string",
  "category": "transport|hotel|poi|context",
  "status": "success|degraded|failed",
  "items": [],
  "booking_links": [],
  "uncertainty": [],
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

Each item should either carry its own `sourceId` / `sourceUrl` fields or be traceable to an entry in `sources`. Downstream itinerary output depends on this mapping for inline citations.

## Onboarding Checklist for New Platform
1. Add a new provider reference file under this folder.
2. Define command/API examples and required auth variables.
3. Define quota/rate-limit and retry strategy.
4. Map raw fields into normalized contract.
5. Define booking link validation rules.
6. Define evidence/source fields and which raw fields they support.
7. Update entry routing table in [../SKILL.md](../SKILL.md).

## Auth Contract (Extensible)
Each provider doc should explicitly define:
- `auth_mode`: `none|api_key|oauth|mixed`
- `auth_env_vars`: list of env vars used by the provider
- `probe_order`: capability probe before credential prompt whenever supported
- `prompt_policy`: ask user for credentials only on explicit auth failures

Recommended auth failure mapping:
- explicit auth failure (401/403/invalid credential): `failed_auth`
- quota/rate-limit (429/trial limit/rate limit): `degraded_quota`
- network/timeout/transport errors: `failed_network`

Prompting rules:
1. Do not claim "missing credential" unless the provider explicitly indicates auth failure.
2. Keep auth failures distinguishable from quota/network failures in tool logs.
3. For map features requiring Tencent services, proactively request key input when key is missing.

## Design Rules
- Keep provider-specific parameters inside provider docs.
- Keep entry file provider-agnostic.
- Never mix raw provider fields into final output without normalization.
- Never drop source URLs when converting provider rows into itinerary rows.
- Keep action links distinguishable from evidence links.
