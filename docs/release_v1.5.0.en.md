# Tasi Harness 1.5.0 Release Notes

[English](release_v1.5.0.en.md) | [Simplified Chinese](release_v1.5.0.zh-CN.md)

Release date: 2026-07-22

## Summary

1.5.0 is a stability, CLI control, browser automation, and packaging release. It does not introduce the core workbench features; instead, it makes existing agent flows easier to script, safer around login pages and form filling, and easier to distribute on Linux/Ubuntu.

## Highlights

- Added granular CLI switches: `--no-memory`, `--memory-domains`, `--no-skills`, `--skill/--skills`, `--tools`, `--log-probs`, `--top-logprobs`, `--turn-type`, and `--session-done`, plus updated docs for piped input, `help`, `version`, and `sessions --json`.
- Improved LLM requests: provider metadata is passed through, JSON mode can include logprobs, and OpenAI-compatible tool arguments are normalized more defensively.
- Added providers: vLLM local OpenAI-compatible preset and SoildAPI text-model provider preset.
- Improved browser automation: click results now observe navigation/DOM changes, file upload is supported, login waits are longer, and filled login forms can be submitted automatically when appropriate.
- Added sensitive data redaction for browser snapshots, form values, URL parameters, and serialized content.
- Added AgentLoop repeat circuit breaker: three repeated iterations stop the run to reduce infinite-loop risk.
- Improved browser coach: external CDP recording is supported, with recording list, load, and delete APIs.
- Improved packaging: added Ubuntu/Linux `.bin` and `.deb` packaging scripts and docs, plus a more stable fixed-port dev startup flow.

## Compatibility Notes

- vLLM defaults to `http://127.0.0.1:8000/v1`; users must run a compatible local server.
- Browser redaction may hide form values during debugging. Prefer selectors, button text, and page structure for diagnosis.
- Ubuntu/Linux packaging should normally run on a Linux host.

## Archive

- Previous release notes: `docs/release_v1.4.0.en.md` and `docs/release_v1.4.0.zh-CN.md`.
