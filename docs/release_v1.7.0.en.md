# Tasi Harness 1.7.0 Release Notes

[English](release_v1.7.0.en.md) | [Simplified Chinese](release_v1.7.0.zh-CN.md)

Release date: 2026-09-04

## Summary

Tasi Harness 1.7.0 focuses on DSH plugin compatibility and embedded browser reliability. This release makes DeepSeek Harness style plugins install and run through a generic sidecar bridge instead of per-plugin shims, while improving visible browser automation, plugin popups, artifact preview, and Chinese UI text rendering.

## Highlights

1. Added a broader DSH Cordis host compatibility layer for common plugin services, including tools, commands, settings, skills, web, attachments, LLM, sessions, agents, subagents, workspace registry, storage, sandbox policy, web server, client runtime, slots, locale, remote services, and related frontend services.
2. Bridged DSH `skills.register` and `skills.registerProvider` into the native Tasi skill index, so skills-only plugins such as `superdesign-dsh` can be discovered, shown in prompts, and loaded with `skill_view`.
3. Added DSH runtime tool synchronization, allowing agent-callable tools exposed by DSH plugins such as search, image reading, or plugin utilities to be registered dynamically.
4. Improved `@plugin` mentions: mentions now list plugin tools, skills, commands, settings, and status, and skills-only plugins are handled through the skill workflow instead of being misrouted to sidecar chat.
5. Fixed sidecar install compatibility for prerelease peer dependencies, hoisted node modules, missing runtime entries, and GitHub/NPM fallback behavior.
6. Improved plugin client windows and settings popups, including Tasi branding, a stable Electron shell, primitive UI shims, and better blank-page handling for client runtime plugins.
7. Fixed Chinese mojibake in native context menus, DSH client shell labels, and several plugin-facing UI paths.
8. Improved embedded browser automation by sharing the visible preview partition with automation, auto-opening the browser panel for browser tool activity, and adding script/debugger timeouts to prevent stuck tool calls.
9. Fixed artifact preview path resolution for relative files such as `MASTER.md`, using session workspace, recent artifact metadata, configured workspace roots, and artifact directories.
10. Added DSH runtime path normalization so plugin tools receive workspace-resolved absolute paths for relative file inputs such as screenshots.

## Use Cases

- Install and use DSH plugins without writing plugin-specific shim code.
- Use `@superdesign-dsh` as a skill-backed design workflow even though it exposes no chat command handler.
- Let DSH tools such as search and image analysis participate in normal Tasi agent runs.
- Watch browser automation in the built-in browser panel while the agent logs in, navigates SPA pages, and captures screenshots.
- Preview generated or referenced artifacts reliably from the current session workspace.

## UX Improvements

- The plugin popup title and logo now match Tasi Harness branding.
- The built-in browser panel switches into view automatically when browser tools run.
- Browser tool failures now return bounded timeout errors instead of leaving the run apparently frozen.
- Plugin marketplace search tolerates API failures and problematic query characters more gracefully.
- DSH plugin mention autocomplete includes skill-only plugins, not only tool or command plugins.

## Compatibility Notes

- DSH chat routing still requires a plugin command/chat handler. Skills-only plugins are intentionally handled through Tasi skills and `skill_view`.
- Superdesign CLI operations still require Superdesign authentication through `superdesign login` or `SUPERDESIGN_TOKEN`.
- DSH plugin compatibility is broad but not a complete reimplementation of every DeepSeek Harness host behavior; unsupported services now degrade more clearly.
- Embedded browser state is shared after this release, but existing runs started before upgrading may need a restart or a new session.

## Archive

- Previous release notes: `docs/release_v1.6.0.en.md` and `docs/release_v1.6.0.zh-CN.md`.
