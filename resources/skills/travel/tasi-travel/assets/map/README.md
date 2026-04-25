# Skill Map Runtime Assets

This directory contains map runtime assets bundled with the `tasi-travel` skill.

## Files
- `app.py`: Flask backend for map config, routes file loading, and direction proxy with cache.
- `map.html`: Frontend map renderer with precomputed-path preference and local cache.

## Runtime

Default behavior:
- `app.py` is managed as an always-on background process by the skill runtime.
- No manual startup is required in normal skill execution.

Local debug only (optional):

```powershell
cd tasi-travel/assets/map
python app.py
```

Then open:

```text
http://127.0.0.1:8123/map.html
```

## Sync Policy
These files are copied from workspace `map/`.
When runtime logic changes in one location, sync the other copy to keep behavior consistent.
