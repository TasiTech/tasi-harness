# Tasi Harness 1.6.0 Release Notes

[English](release_v1.6.0.en.md) | [Simplified Chinese](release_v1.6.0.zh-CN.md)

Release date: 2026-08-04

## Summary

Tasi Harness 1.6.0 turns the desktop agent into a more continuous workbench: realtime voice, agent loops, tool registration, a skill marketplace, scheduled tasks, email notifications, sandbox execution, expanded Omni providers, and a richer theme system.

## Highlights

1. Added realtime voice mode: users can talk to Omni / Realtime models and create background tasks from live sessions.
2. Improved agent loops: background tasks can run tools, collect results, update task cards, and trigger a follow-up model response when finished.
3. Added tool registration: tool requests, tool results, and traces are easier to inspect and separate from reasoning content.
4. Added a skill marketplace: users can browse, install, and manage reusable workflow skills.
5. Added scheduled tasks: users can create, run, and manage recurring or asynchronous work.
6. Added email notifications: long-running background tasks can notify users when finished.
7. Added sandbox execution: tool runs now have clearer execution modes and safer local boundaries.
8. Expanded Omni providers: Qwen Omni and a SoildAPI Omni preset were added, with OpenAI Realtime-compatible wiring for future provider support.
9. Enhanced themes: added a tech-blue theme, DreamSkin gallery browsing and one-click install, theme package import, background image support, and text brightness control.
10. Polished desktop UX: hidden native menu/title chrome, improved microphone selection, background image rendering, task completion flashing, and duplicate realtime response handling.

## Use Cases

- Talk through work in realtime while the agent creates and follows background tasks.
- Let long-running tool workflows complete in the background, then have the model respond with the final result.
- Install reusable capabilities from the skill marketplace instead of hand-maintaining local workflows.
- Schedule checks, reminders, recurring processing, or automation jobs.
- Connect different Omni / Realtime providers, including Qwen and OpenAI-compatible services.
- Customize the app visually with DreamSkin packages or imported local themes.

## Stability and UX Improvements

- Fixed duplicate replies and duplicate background task creation in realtime mode.
- Task cards now flash three times when a background task completes.
- Background task panels scroll to the latest task activity.
- Trace panels focus on tool requests and tool results; reasoning is shown in the task card reasoning area.
- Fixed microphone list text overlapping the dropdown indicator.
- Improved custom theme background rendering across sidebars, main panels, and realtime mode.
- Added text brightness control to make low-contrast themes easier to read.

## Compatibility Notes

- SoildAPI Omni is included as a preset provider and follows the OpenAI Realtime-compatible path; final debugging still depends on the live service behavior.
- Omni capabilities depend on each provider's actual Realtime, voice, and multimodal support.
- DreamSkin installation depends on `dreamskin.cc` and its API availability; local theme package import remains available for offline use.
- Sandbox execution can restrict tools that need direct system access. Users can change the execution mode or safety settings when needed.

## Archive

- Previous release notes: `docs/release_v1.4.0.en.md` and `docs/release_v1.4.0.zh-CN.md`.
