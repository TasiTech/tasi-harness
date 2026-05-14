# Architecture

[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.zh-CN.md)

This document reflects the current Tasi Harness implementation as of v1.4.0.

## Code Architecture Diagram

![Tasi Harness architecture](architechcture.png)

The diagram keeps the existing `architechcture.png` filename for compatibility with older documentation links.

## Runtime Layers

Tasi Harness is an Electron desktop application with three active runtime layers:

- Renderer (`src/renderer/*`): React UI for Chat, Knowledge, Memory, Skills, Tasks, History, Settings, and About.
- Preload (`src/preload/preload.ts`): typed `window.tasiHarness` IPC bridge exposed through Electron `contextBridge`.
- Main process (`src/main/*`): application services, agent loop, model clients, tool execution, storage, browser automation, scheduler, WeChat channel, export, and app lifecycle.

There is also a CLI entry point in `src/main/cli.ts`. The CLI reuses the same main-process service classes through `CliContext`, so desktop and command-line chat share configuration, sessions, memory, skills, tools, browser automation, and personal knowledge storage.

## Main Composition

`src/main/appContext.ts` is the composition root. It creates and wires:

- Stores: `ConfigStore`, `SessionStore`, `MemoryStore`, `ScheduledTaskStore`, `McpConfigStore`.
- Skills and marketplace: `SkillManager`, `MarketplaceManager`.
- Knowledge services: `PersonalKnowledgeBase`, `SessionDocumentContextStore`.
- Runtime services: `AgentLoop`, `PromptBuilder`, `ToolRegistry`, `SandboxManager`.
- Browser services: `BrowserAutomationRouter`, `EmbeddedBrowserAutomation`, `ExternalBrowserAutomation`, `ExternalBrowserBridge`, `BrowserExecutionLogger`.
- Background services: `TaskScheduler`, `EmailNotifier`.

On startup, `AppContext` also seeds bundled skills from `resources/skills`, respects installer overwrite choices, syncs memory from existing sessions, registers built-in tools, and starts task polling.

## IPC Surface

`src/main/main.ts` registers the desktop IPC handlers exposed by the preload bridge:

- `config:*`: provider settings, WeChat QR login, connection testing.
- `agent:*`: chat, stop, streamed message deltas, streamed tool events.
- `sessions:*`: list, read, search, rename, delete, append external messages.
- `memory:*`: query and clear durable memory.
- `knowledge:*`: personal knowledge documents and folder import.
- `session-docs:*`: per-session uploaded document context.
- `skills:*`: local skill create/read/patch/delete, bundled install, archive upload, marketplace browse/install/uninstall.
- `browser-coach:*`: browser recording and skill generation.
- `tasks:*`: scheduled task CRUD and run-now.
- `tools:*`: list and manual tool execution.
- `app:*`: app info, PDF/DOCX export, open paths/URLs, browser preview binding.
- `tool-approval:*`: interactive safety approvals.

The renderer subscribes to `agent:message-delta`, `agent:tool-event`, `sessions:updated`, and `tool-approval:request` events.

## Agent Execution Flow

`AgentLoop` in `src/main/agent/agentLoop.ts` owns a run:

1. Prepare the execution directory through `SandboxManager` (`workspace` or copy-based `sandbox`).
2. Create or load a session and append the user message, including optional attachments.
3. Build a system prompt with `PromptBuilder`.
4. Create the configured `LlmClient` and send messages plus enabled tool definitions.
5. If the provider supports streaming, forward content and reasoning deltas to the UI/CLI and persist stream snapshots.
6. Execute model tool calls through `ToolRegistry`, emitting tool events as they complete.
7. Repeat until the model returns a final answer or the iteration limit is reached.
8. Commit deferred memory changes only after a successful run; discard them on failure.
9. Persist session messages, tool events, usage, and execution details.

The same loop is used by desktop chat, CLI chat, scheduled tasks, and WeChat auto-replies.

## Model and Multimodal Support

`src/main/agent/llmClient.ts` adapts provider-specific APIs:

- OpenAI-compatible chat completions: OpenAI, DeepSeek, Qwen / Bailian, MiniMax, Kimi, custom compatible providers.
- Anthropic Messages API.
- Ollama local chat API.
- Mock provider for tests.

Message attachments are represented by `AgentMessageAttachment` in `src/shared/types.ts` and support `image`, `video`, and `audio`.

Provider behavior:

- OpenAI-compatible requests can include `image_url`, `video_url`, and `input_audio` parts.
- Anthropic requests currently convert image attachments into image content blocks.
- Actual image/video/audio support still depends on the selected model and provider endpoint.

Streaming is exposed through `LlmClient.streamComplete`, `AgentLoop` delta events, renderer message updates, and CLI streamed terminal output.

## Tools and Safety

Built-in tools are registered by `createBuiltinTools` in `src/main/tools/builtinTools.ts`.

Major tool groups include:

- File tools: workspace-scoped read/list/write/delete.
- Memory tools: deferred durable memory mutations.
- Session search: local conversation search.
- Skill tools: `skill_view` and `skill_manage`.
- Browser tools: navigation, wait, snapshot, find, click/type/select, extract, screenshot, PDF, console/network/storage helpers.
- Terminal tool: controlled shell execution when enabled.
- WeChat file return: `wechat_send_file` is registered when the app is ready.

`ToolRegistry` applies workspace boundary checks, approval prompts, risky terminal command classification, and skill-optimization guardrails. Dangerous or broad skill patches are rejected before they can pollute unrelated skill workflows.

## Browser Architecture

Browser automation is routed through `BrowserAutomationRouter`:

- Embedded mode uses `EmbeddedBrowserAutomation` and the renderer webview preview.
- External mode uses `ExternalBrowserAutomation` and `ExternalBrowserBridge`.
- External bridge mode can attach to CDP targets, launch isolated browser profiles, use configured endpoints, and fall back to Safari/WebDriver or system URL opening where appropriate.
- Browser execution events can be written to `~/.tasi-harness/logs/browser-execution.log`.

Browser Coach records renderer-side browser actions and uses `browserCoachSkill.ts` to generate reusable browser skills through the current model.

## Knowledge Architecture

There are two knowledge paths:

1. Personal Knowledge Base (`src/main/knowledge/personalKnowledgeBase.ts`)
- Converts documents to Markdown through `documentConverter.ts`.
- Stores source files, extracted images, generated Markdown, and chunk indexes under `~/.tasi-harness/personal-knowledge/`.
- Retrieves chunks lexically, with optional LLM keyword expansion.
- Injected into prompts only when the chat enables Personal KB.

2. Session Document Context (`src/main/knowledge/sessionDocumentContextStore.ts`)
- Converts per-session uploads to XML through `documentXmlConverter.ts`.
- Supports Office, PDF, OFD, XML, Markdown, text, JSON, CSV, and related formats.
- Saves XML context under `~/.tasi-harness/session-documents/`.
- Optionally copies uploaded files into the workspace under `session-documents/<session-id>/`.
- Injects bounded XML snippets into `PromptBuilder` for the active session.

Media attachments used for multimodal model input are separate from document XML context.

## Skills Architecture

Skills are editable `SKILL.md` workflows with frontmatter. They can come from:

- Bundled skills in `resources/skills`.
- Local user skills in `~/.tasi-harness/skills`.
- Marketplace catalogs from `resources/markets` and configured remote sources.
- Uploaded skill archives.
- Browser Coach generated skills.

The Skills UI includes installed skills, marketplace browsing, archive upload, browser coach, and skill optimization. Skill optimization starts a normal agent run with a focused prompt that reads session failure signals, identifies affected skills, patches only relevant `SKILL.md` files or scripts, and verifies changes.

## WeChat Channel

The WeChat integration is hosted in `src/main/main.ts`:

- QR login and status polling store channel state in `ConfigStore`.
- `getupdates` polling appends inbound messages to a dedicated WeChat session.
- Document file items are converted through `SessionDocumentContextStore`.
- Image, audio, and video items can become `AgentMessageAttachment` values for multimodal context.
- Text messages can trigger an `AgentLoop` run and send the final response back to WeChat.
- `wechat_send_file` uploads and encrypts workspace files through the WeChat media API, then sends image, video, or file items back to the active WeChat conversation.
- Scheduled tasks can also send WeChat notifications.

## Export Architecture

Assistant message export is implemented by `src/main/export/messageExport.ts` and `src/main/main.ts`:

- PDF export renders printable HTML in a hidden `BrowserWindow` and calls `printToPDF`.
- DOCX export builds an Office package with `JSZip`.
- Markdown tables, headings, links, citation relationships, and source references are preserved where possible.
- KaTeX CSS is embedded for PDF formula rendering.
- DOCX export prefers Markdown math over rendered KaTeX HTML when LaTeX is present, avoiding formula text order problems in Word exports.

## Scheduling and Notifications

`TaskScheduler` polls due tasks every 15 seconds:

- Runs task prompts through `AgentLoop`.
- Records output, trace, iterations, and tool-event count in `ScheduledTaskStore`.
- Records token usage in `SessionStore`.
- Sends optional email via `EmailNotifier`.
- Sends optional WeChat task notifications using the active channel context.

Tasks can reuse an existing session or create a new one, and can choose `workspace` or `sandbox` execution.

## Persistence Layout

Default root:

```text
~/.tasi-harness/
```

Important paths:

```text
config.json
sessions/
memories/entries.v2.json
skills/
personal-knowledge/
session-documents/
scheduled-tasks.json
sandboxes/
logs/browser-execution.log
logs/agent-errors.log
runtime/
workspace/
```

Workspace outputs and generated artifacts are stored under the configured workspace directory unless a run uses sandbox execution.
