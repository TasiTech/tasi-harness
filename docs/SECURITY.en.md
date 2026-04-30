# Security

[English](SECURITY.en.md) | [简体中文](SECURITY.zh-CN.md)

Tasi Harness is a local desktop agent. Local agents can be powerful, so the default configuration is intentionally conservative.

## Defaults

- `allowShellTools` is `false`.
- File tools are confined to the configured workspace directory.
- Renderer has no direct Node.js access.
- API key material is not returned to the renderer after storage.

## File sandbox

`safeJoin(root, input)` ensures every file path used by file tools resolves inside `workspaceDir`. Attempts such as `../outside.txt` fail.

## Terminal tool

The terminal tool requires `allowShellTools: true`. Even when enabled, it blocks several destructive command patterns, including obvious forms of:

- `rm -rf /`
- fork bombs
- disk formatting commands
- shutdown/reboot commands
- raw device writes

This is not a full sandbox. For untrusted tasks, run the app inside an OS/container sandbox or keep terminal disabled.

## API keys

The main process stores provider settings in `~/.tasi-harness/config.json`. The preload bridge returns only `apiKeyConfigured: true/false`, not the stored key value.

## Recommended production hardening

- Add OS keychain storage for API keys.
- Add per-tool approval prompts before write/terminal operations.
- Add code signing and auto-update signature verification.
- Add a Docker or remote terminal backend for untrusted commands.
- Add an allowlist of approved workspace roots.

