# Tasi Harness 1.6.0 Release Notes

[English](release_v1.6.0.en.md) | [Simplified Chinese](release_v1.6.0.zh-CN.md)

Release date: 2026-08-04

## Summary

Tasi Harness 1.6.0 focuses on two areas: realtime voice mode and theme settings. This release makes live conversations more natural while turning theme import, the DreamSkin gallery, background images, and text brightness into a fuller visual customization experience.

## Highlights

1. Added realtime voice mode: users can hold duplex voice conversations through Omni / Realtime models.
2. Added background tasks from realtime mode: complex work can move from a live conversation into background execution.
3. Sends completed task results back to Omni: when a background task finishes, the result is passed to the Omni model so it can produce a new follow-up response.
4. Fixed duplicate realtime responses: one user request no longer creates duplicate replies or duplicate background tasks.
5. Improved realtime task feedback: completed task cards flash three times and task panels scroll to the latest activity.
6. Refined realtime traces: trace panels focus on tool requests and tool results, while reasoning stays in the task card reasoning area.
7. Expanded Omni presets: added Qwen Omni model options and a SoildAPI Omni provider preset using the OpenAI Realtime-compatible path.
8. Added a tech-blue theme: a translucent blue base with bright blue-green accents.
9. Added DreamSkin gallery support: the theme settings page can browse `dreamskin.cc/gallery` themes and install selected themes with one click.
10. Improved theme package handling: imported themes can use background images, sidebars and realtime mode render backgrounds more clearly, and text brightness can be adjusted.

## Use Cases

- Talk with the agent in realtime while complex tasks continue in the background.
- Let the Omni model respond again after a background task completes with new results.
- Connect Qwen Omni, OpenAI Realtime-compatible services, or the preconfigured SoildAPI Omni endpoint.
- Customize the workbench quickly through DreamSkin or local theme packages.
- Improve readability when a theme has dim text, subtle backgrounds, or low sidebar contrast.

## UX Improvements

- Fixed microphone list text overlapping the dropdown indicator.
- Improved custom theme background rendering across sidebars, main panels, and realtime mode.
- Fixed imported theme backgrounds not appearing.
- Added text brightness control for primary, secondary, and muted text.
- Hid native menu and title chrome for a more immersive app window.

## Compatibility Notes

- SoildAPI Omni is currently included as a preset provider; final debugging still depends on the live service behavior.
- Omni capabilities depend on each provider's actual Realtime, voice, and multimodal support.
- DreamSkin installation depends on `dreamskin.cc` and its API availability; local theme package import remains available for offline use.
- Text brightness changes rendered theme colors but does not modify the original theme package files.

## Archive

- Previous release notes: `docs/release_v1.5.0.en.md` and `docs/release_v1.5.0.zh-CN.md`.
