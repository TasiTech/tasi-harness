# Development Guide

[English](DEVELOPMENT.en.md) | [简体中文](DEVELOPMENT.zh-CN.md)

## Useful commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run pack
```

## Adding a tool

1. Add a `RegisteredTool` to `src/main/tools/builtinTools.ts` or a new module.
2. Provide an OpenAI-compatible JSON schema.
3. Keep all filesystem access inside `workspaceDir`.
4. Add unit tests in `tests/`.
5. Add the tool name to default `enabledToolNames` in `src/main/storage/pathUtils.ts` if it should be exposed by default.

## Adding a renderer page

1. Add the page key to `Page` in `src/renderer/App.tsx`.
2. Add a nav entry.
3. Create a component and style it in `styles.css`.

## Adding a bundled skill

Create a directory under `resources/skills/<category>/<skill-name>/SKILL.md`.

On startup, missing bundled skills are copied into `~/.tasi-harness/skills` so the app can scan them like normal local skills.

## Testing notes

The tests use temporary directories and do not write into the real user home. The agent-loop test uses `MockLlmClient`, so no network or API key is required.

