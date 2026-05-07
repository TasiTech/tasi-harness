# Security

[English](SECURITY.en.md) | [简体中文](SECURITY.zh-CN.md)

Tasi Harness is a local desktop agent. Local agents can be powerful, so the default configuration is intentionally conservative.

## Defaults

- `allowShellTools` is `false`.
- Safety approval is enabled by default.
- Renderer has no direct Node.js access.
- API key material is not returned to the renderer after storage.

## File Access And Approval

File tools resolve relative paths from `workspaceDir`. When safety approval is enabled:

- Reads, directory listings, and writes inside the workspace do not require approval.
- Deletes inside the workspace require approval.
- Reads, directory listings, writes, and deletes outside the workspace require approval.
- The approval prompt can remember an allowed action with "Allow and do not ask again".

## Terminal tool

The terminal tool requires `allowShellTools: true`. Even when enabled, it blocks several destructive command patterns, including obvious forms of:

- `rm -rf /`
- fork bombs
- disk formatting commands
- shutdown/reboot commands
- raw device writes

With safety approval enabled, low-risk terminal commands run without approval; commands that may modify files, permissions, packages, or system settings require approval.

This is not a full sandbox. For untrusted tasks, run the app inside an OS/container sandbox or keep terminal disabled.

## API keys

The main process stores provider settings in `~/.tasi-harness/config.json`. The preload bridge returns only `apiKeyConfigured: true/false`, not the stored key value.

## Recommended production hardening

- Add OS keychain storage for API keys.
- Add code signing and auto-update signature verification.
- Add a Docker or remote terminal backend for untrusted commands.
- Add an allowlist of approved workspace roots.
