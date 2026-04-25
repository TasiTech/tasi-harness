# Architecture

Tasi Harness mirrors the important runtime seams of Hermes Agent in TypeScript while remaining a desktop-first Electron app.

## System overview

```text
Electron main process
+- AppContext
   +- ConfigStore
   +- MemoryStore
   +- SessionStore
   +- SkillManager
   +- PersonalKnowledgeBase
   +- ToolRegistry
   +- PromptBuilder
   +- AgentLoop
   +- TaskScheduler
   +- EmailNotifier
+- IPC handlers
+- BrowserWindow

Preload
+- window.tasiHarness typed bridge

Renderer
+- React pages: Chat, Knowledge, Memory, Skills, Tasks, Sessions, Settings, About
```

## Agent loop

`src/main/agent/agentLoop.ts` is the orchestration engine.

1. Load or create a session.
2. Append the user's message.
3. Build the system prompt from persona, operating instructions, memory snapshot, optional personal-knowledge matches, browser-bridge guidance, and the installed skills index.
4. Send the conversation to the selected provider adapter (`/chat/completions`, Anthropic `/messages`, or Ollama `/api/chat`).
5. Execute returned tool calls through `ToolRegistry`.
6. Append tool messages and continue until the model returns a final answer or the iteration budget is reached.
7. Persist the run to the session store, then commit deferred memory updates after the run succeeds.

## Prompt builder

`PromptBuilder` includes:

- user-configured persona
- tool-use operating model
- timestamp
- frozen memory snapshot
- optional personal knowledge snapshot
- installed skill index
- browser bridge guidance based on embedded or external mode

This follows the same high-level Hermes pattern of assembling a tool-aware system prompt from memory, skills, and runtime context.

## Tools

Tools are registered as `RegisteredTool` objects:

```ts
interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
  safety: 'read-only' | 'writes-workspace' | 'executes-command' | 'network' | 'stateful';
}
```

Current built-ins cover memory mutations, session search, skill management, workspace file I/O, browser automation, terminal execution, and runtime diagnostics.

## Memory

Memory is stored in `~/.tasi-harness/memories/entries.v2.json` as structured entries with target, scope, domain, and content metadata.

- `memory` entries store environment, project, workflow, and session facts
- `user` entries store preferences, profile details, and communication style

Legacy `MEMORY.md` and `USER.md` files are imported on first run when present. During a chat or scheduled run, memory writes are queued and committed only after the run completes successfully.

## Personal knowledge base

The personal knowledge base lives under `~/.tasi-harness/personal-knowledge/`.

- local files are converted to Markdown
- extracted assets are stored alongside the normalized document
- Markdown content is chunked locally
- retrieval uses lexical scoring with optional LLM keyword expansion

This design avoids mandatory embeddings or an external vector database.

## Skills

Skills are `SKILL.md` documents with simple YAML-like frontmatter:

```md
---
name: code-review
description: Review local code changes.
category: developer
---

# Code Review
...
```

Bundled skills live in `resources/skills`. On app startup they are seeded into the user's local skill directory if missing.

## Data locations

```text
~/.tasi-harness/config.json
~/.tasi-harness/workspace/
~/.tasi-harness/memories/entries.v2.json
~/.tasi-harness/sessions/
~/.tasi-harness/skills/
~/.tasi-harness/personal-knowledge/
~/.tasi-harness/sandboxes/
```
