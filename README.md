# Tasi Harness

[English](README.md) | [简体中文](README.zh-CN.md)

Tasi Harness is a local-first desktop AI agent built with Electron, TypeScript, React, and Vite. It combines a streaming, desktop-oriented chat experience with an OpenAI-compatible tool-calling runtime, multimodal attachments, browser automation, persistent memory, skills, scheduled tasks, document writing/export, and a personal knowledge base that converts Office documents into Markdown for retrieval.

> Tasi Harness is inspired by Hermes-Agent-style runtime patterns. It does not bundle the original Python Hermes Agent runtime.

![Tasi Harness Screenshot](docs/screen_shot.png)

## Highlights

- Desktop-first AI agent with local sessions, local memory, and local skill files.
- Streamed chat responses, plus image, video, and audio attachments for multimodal-capable models.
- Built-in provider presets for OpenAI, Anthropic, DeepSeek, Qwen / Bailian, MiniMax, Kimi, OpenAI-compatible APIs, and Ollama.
- Built-in browser automation tools with embedded web preview and external-browser bridge mode.
- Deep-search skill for Baidu, Google, Bing, and other engines, turning opened webpages into cited answers.
- Session document upload for one-off file-grounded work, alongside the reusable personal knowledge base.
- Personal knowledge base that converts Office, PDF, OFD, Markdown, TXT, JSON, and CSV files into searchable Markdown.
- Skill system based on editable `SKILL.md` files, plus bundled skills, marketplace sources, Browser Coach recording, UI design guidance, and skill optimization.
- Scheduled tasks, optional email / WeChat notifications, and per-run workspace sandbox copies.
- PDF / Word export with formula-aware rendering, cited webpage display, image-and-text document drafting, open-workspace action, and installed command-line chat.
- WeChat channel support for text, document/media uploads, and returning generated workspace files.
- Local safety defaults: context isolation enabled, workspace-scoped file access, terminal and network tools enabled, and risky terminal commands gated by approval.

## Features

| Area | What it does |
| --- | --- |
| Agent runtime | Runs a streaming, tool-aware chat loop with prompt building, iterative tool execution, multimodal attachments, and session persistence. |
| Memory | Stores durable facts in local JSON-backed memory entries and injects relevant memory into prompts. |
| Browser automation | Supports navigation, CDP-backed external Chromium automation with optional headless launches, snapshots with `@e` refs, semantic lookup, keyboard/mouse/form actions, extraction, screenshots/PDF, storage/cookies, console, network, viewport, and close/reset tools. |
| Deep search and citations | Uses `deep-search` across Baidu, Google, Bing, and other engines, opens webpages for evidence, and keeps numbered Markdown citations in replies. |
| Session documents and media | Uploads per-session documents for bounded chat context and sends image/video/audio attachments to providers that support multimodal input. |
| Personal knowledge base | Converts local documents to Markdown, stores extracted assets, chunks content locally, and retrieves snippets with lexical search plus optional keyword expansion. Supports Office, PDF, OFD, and text formats without embeddings or an external vector DB. |
| Skills | Reads, creates, patches, uploads, optimizes, and installs `SKILL.md` workflows from local files and marketplace catalogs. Browser Coach can turn recorded browser behavior into a reusable skill, and bundled skills include deep search, travel, browser automation, and UI design support. |
| History | Keeps searchable local conversation history in JSON. |
| Scheduled tasks | Runs prompts on a schedule, can reuse sessions, and can send email or WeChat notifications. |
| Workspace safety | Restricts file tools to the configured workspace and supports a copy-based sandbox execution mode. |
| Export, WeChat, and CLI | Exports assistant replies to formula-aware PDF / Word documents, returns generated files through WeChat, and exposes `tasi chat` after installation. |

## Installation

Setup, packaging, and test steps are documented here:

- [Installation, Packaging, and Testing](docs/INSTALLATION_PACKAGING_TESTING.en.md)

Quick commands:

- Install dependencies: `npm install`
- Run dev app: `npm run dev`
- Build: `npm run build`
- Test: `npm test`
- Package (Windows): `npm run dist:win`
- Package (macOS): `npm run dist:mac`

## Quick Start

1. Run `npm run dev`.
2. Open **Settings** and configure your model provider.
3. Choose a workspace directory if you do not want to use the default one.
4. Go to **Chat** and start a conversation.
5. Upload documents or media directly in **Chat** for one-off context, or use **Knowledge** plus the **Personal KB** toggle for reusable document grounding.
6. If you want reusable workflows, open **Skills** to browse bundled or marketplace skills, record Browser Coach flows, or optimize an existing skill.
7. If you want background execution, create a job in **Tasks**.

## Usage Guide

### Model providers

Tasi Harness ships with multiple provider presets in the UI:

- `OpenAI`, `DeepSeek`, `Qwen / Bailian`, `MiniMax`, `Kimi`, and `OpenAI-compatible`: use a `/chat/completions` style endpoint with tool-calling support.
- `Anthropic`: uses the `/messages` API with tool-use blocks.
- `Ollama`: uses local `/api/chat` requests for local models.

### Browser automation and preview

Tasi Harness includes built-in browser and extenal browser tools modes.

Detailed guide:

- [Browser Automation](docs/BROWSER_AUTOMATION.en.md)

### Personal knowledge base

The **Knowledge** flow supports document upload and local retrieval-augmented context injection for chat, without requiring embeddings or an external vector DB.

Detailed guide:

- [Personal Knowledge Base](docs/PERSONAL_KNOWLEDGE_BASE.en.md)

### Chat attachments and session documents

Chat supports streamed replies and optional media attachments for multimodal-capable models. Images, video, and audio are sent as model attachments where the selected provider supports them.

For file-grounded work, use session document upload in Chat. Session documents are converted to bounded XML context for the active conversation. Use **Knowledge** instead when the material should become reusable across sessions.

### Citations and export

Browser/search-backed answers are prompted to include numbered Markdown citations such as `[1](https://example.com/source)`. The chat UI extracts these links and shows referenced webpages above the message and in the references panel.

Assistant replies can be exported to PDF or Word, which is useful for reports, itinerary plans, web research summaries, citation-backed tables, and image-and-text document drafts. PDF export includes KaTeX styling for formulas, and DOCX export preserves readable formula text where possible.

### Skills and skill marketplace

Skills are plain `SKILL.md` files with frontmatter and instructions. You can:

- browse bundled skills
- create or patch local skills
- upload skill archives
- browse marketplace catalogs such as ClawHub and SkillHub
- optimize skills from a previous session's failure signals

Bundled browser automation guidance is available as the `tasi-browser-automation` skill. The `deep-search` skill provides multi-engine web research, `tasi-travel` provides itinerary planning with Ctrip-backed evidence and route links, `ui-ux-pro-max` helps with UI design work, and Browser Coach can generate a skill from recorded browser behavior. The Skills page also includes an Optimize tab for targeted skill improvements.

### WeChat channel

The WeChat channel can receive text, document uploads, and image/audio/video media. Documents are converted into session document context, while media can be used as multimodal attachments. When a generated file should be returned, the agent can send workspace files back to the active WeChat conversation with the `wechat_send_file` tool.

### Sessions and memory

Tasi Harness stores:

- session history as local JSON files
- durable environment, project, and user memory entries in `~/.tasi-harness/memories/entries.v2.json`
- legacy `MEMORY.md` and `USER.md` files are imported on first run when present

Memory updates are queued during a run and committed after the run completes, which reduces partial-memory writes from failed executions.

### Command-Line Chat

After installing the Windows NSIS package, the install directory is added to the current user's `PATH`. Open a new PowerShell window and run:

```powershell
tasi chat "summarize the current workspace"
tasi chat --session xxx "continue this session"
tasi chat -s xxx -e sandbox "continue this session"
tasi chat --execution sandbox --knowledge "answer with my personal knowledge base"
tasi chat --no-memory --no-skills --tools none "answer without memory, skills, or tools"
tasi chat --skill deep-search --tools browser_open,browser_extract "research this topic"
tasi sessions
```

If PowerShell still cannot find `tasi`, close all PowerShell / Windows Terminal windows and open a fresh one, then run `Get-Command tasi` to inspect the resolved launcher. The installer also creates shims in `%LOCALAPPDATA%\Microsoft\WindowsApps`. PowerShell uses `tasi.ps1`, while `cmd.exe` delegates `tasi.cmd` to the same PowerShell launcher; the launcher sets console input/output to UTF-8 without printing `chcp` output or clearing the terminal.

On macOS, after installing the app in `/Applications`, the bundled bash launcher is available inside the app bundle:

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "summarize the current workspace"
ln -sf "/Applications/Tasi Harness.app/Contents/Resources/bin/tasi" "$HOME/.local/bin/tasi"
```

Running `tasi` with no message starts an interactive chat. `chat` creates a new session when `--session/-s` is omitted, and appends to an existing session when `--session xxx` or `-s xxx` is provided; `xxx` is the full session id and does not need a fixed prefix. `tasi sessions` lists saved sessions; add `--json` when scripts need structured session data. Each reply prints the current session id. The CLI shares the desktop app's `~/.tasi-harness/config.json`, sessions, memory, skills, and personal knowledge base. Browser automation runs through external Chrome / Edge CDP mode.

Common chat options:

- `--execution workspace|sandbox` / `-e workspace|sandbox`: choose whether tools run directly in the configured workspace or in a copied sandbox.
- `--knowledge` / `-k`: include the personal knowledge base.
- `--no-memory`: disable persistent memory for this run.
- `--memory-domains <list>`: use comma-separated memory domains instead of auto inference. Valid domains include `finance`, `daily_life`, `work`, `travel`, `reading`, `education`, `health`, and `other`.
- `--no-skills`: omit the skill index from the prompt.
- `--skill <name>`: enable one named skill. Can be repeated.
- `--skills <list>`: enable comma-separated skills.
- `--tools <list>`: use comma-separated tools instead of the configured defaults. Use `--tools none` to disable tools.
- `--stream` / `--no-stream`: stream output by default, or wait for the full response before printing.
- `--plain` / `-p`: print raw Markdown instead of terminal-rendered Markdown.
- `--json` / `-j`: print the full run result object, including `sessionId`, `finalResponse`, `messages`, `toolEvents`, `usage`, and `execution`.
- `--log-probs` and `--top-logprobs <0-5>`: in `--json` mode, request token log probabilities and optional top alternatives.
- `--verbose` / `-V`: print tool events to stderr.
- `--home <path>` / `-H <path>`: override `TASI_HARNESS_HOME`.

The CLI also accepts piped input:

```powershell
Get-Content .\prompt.md | tasi chat --plain
```

Interactive commands are `:new`, `:session <id>`, and `:exit`. Use `tasi help` or `tasi --help` for built-in usage, and `tasi version` or `tasi --version` to print the packaged app version.

### Scheduled tasks and notifications

The **Tasks** page supports:

- one-time runs
- interval-based runs
- per-task execution mode selection
- optional email notifications after completion

Scheduled tasks can continue an existing session or create a new one as needed.

### Execution modes

Two execution modes are available:

- `workspace`: tools operate directly inside the configured workspace directory.
- `sandbox`: the workspace is copied into a per-run sandbox directory before the run starts.

## Data Locations

By default, app data is stored under:

```text
~/.tasi-harness/
```

Important paths:

```text
~/.tasi-harness/config.json
~/.tasi-harness/workspace/
~/.tasi-harness/memories/entries.v2.json
~/.tasi-harness/sessions/
~/.tasi-harness/skills/
~/.tasi-harness/personal-knowledge/
~/.tasi-harness/sandboxes/
```

## Security Notes

Tasi Harness is designed with conservative local defaults, but it is still a powerful desktop agent. Current protections include:

- Electron context isolation with a typed preload bridge
- no direct Node.js access from the renderer
- workspace-confined file tools
- terminal and network tools enabled by default
- risky terminal commands gated by approval when safety approval is enabled
- blocking of several obviously dangerous shell command patterns even when terminal access is enabled

This is not a complete sandbox for untrusted workloads. For higher-risk automation, keep terminal access disabled or run the app inside an OS/container sandbox.

More details: [docs/SECURITY.en.md](docs/SECURITY.en.md)

## Project Structure

```text
src/
  main/       Electron main process, agent loop, tools, storage, scheduler
  preload/    Typed context bridge
  renderer/   React UI
  shared/     Shared TypeScript types
resources/
  skills/     Bundled SKILL.md assets
  markets/    Marketplace catalogs
tests/        Vitest test suite
docs/         Engineering and security documentation
```

## Documentation

- [Architecture](docs/ARCHITECTURE.en.md)
- [Development Guide](docs/DEVELOPMENT.en.md)
- [Security](docs/SECURITY.en.md)
- [Verification Notes](docs/VERIFICATION.en.md)
- [Installation, Packaging, and Testing](docs/INSTALLATION_PACKAGING_TESTING.en.md)
- [Browser Automation](docs/BROWSER_AUTOMATION.en.md)
- [Personal Knowledge Base](docs/PERSONAL_KNOWLEDGE_BASE.en.md)
- [Release Notes (v1.4.0)](docs/release_v1.4.0.en.md)
- [Release Notes Archive (v1.3.0)](docs/release_v1.3.0.en.md)
- [Release Notes Archive (v1.2.0)](docs/release_v1.2.0.en.md)
- [Release Notes Archive (v1.1.0)](docs/release_v1.1.0.en.md)

## References and Acknowledgements

- Hermes Agent: architectural inspiration for prompt building, tool loops, and procedural memory patterns
- Electron: desktop shell and process model
- React + Vite: renderer stack
- Vitest: test runner
- JSZip: Office document and archive processing

## License

[MIT](LICENSE)
