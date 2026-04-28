# 架构说明

[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.zh-CN.md)

本文档基于当前代码实现，描述 Tasi Harness 的实际架构。

## 运行时分层

Tasi Harness 是一个 Electron 桌面应用，分为三层：

- Renderer（`src/renderer/*`）：React 页面与交互状态。
- Preload（`src/preload/*`）：类型化 `window.tasiHarness` 桥接。
- Main（`src/main/*`）：Agent 运行时、工具系统、存储、浏览器桥接、调度与通知、IPC 接口。

## 代码架构图

![architecture](architechcture.png)

## 主体装配（`AppContext`）

`src/main/appContext.ts` 负责组装核心服务：

- 存储层：`ConfigStore`、`MemoryStore`、`SessionStore`、`ScheduledTaskStore`、`McpConfigStore`
- 技能层：`SkillManager`、`MarketplaceManager`
- 知识层：`PersonalKnowledgeBase`、`SessionDocumentContextStore`
- 运行时：`ToolRegistry`、`PromptBuilder`、`AgentLoop`、`SandboxManager`
- 通知/调度：`EmailNotifier`、`TaskScheduler`、`EmbeddedBrowserAutomation`

同时负责内置技能落盘与定时任务调度启动。

## IPC 与应用控制（`main.ts`）

`src/main/main.ts` 负责：

- 提供 config、agent chat/stop、sessions、memory、knowledge、session-doc、skills、marketplace、tasks、tools、app 等 IPC 接口。
- 管理外部浏览器预览生命周期（`ExternalBrowserBridge`）与内嵌预览绑定。
- 管理微信通道（二维码登录状态、消息轮询、外部消息入会话、智能体回复回写）。
- 在任务结束/停止时自动清理外部浏览器预览。

## Agent 运行流程图

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant IPC as main.ts
  participant LOOP as AgentLoop
  participant PROMPT as PromptBuilder
  participant LLM as LlmClient
  participant TOOLS as ToolRegistry
  participant STORE as SessionStore/MemoryStore

  UI->>IPC: agent:chat(input, sessionId, mode, usePKB)
  IPC->>LOOP: run(...)
  LOOP->>STORE: beginDeferredMemory + 追加用户消息
  LOOP->>PROMPT: build(系统提示词)
  LOOP->>LLM: complete(messages, tools)
  LLM-->>LOOP: assistant + tool_calls/answer
  LOOP->>TOOLS: 迭代执行工具调用
  TOOLS-->>LOOP: 工具结果
  LOOP->>STORE: 追加消息与工具事件
  LOOP->>STORE: commitDeferredMemory + 同步会话记忆
  LOOP-->>IPC: 最终回复 + usage + events
  IPC-->>UI: 返回结果 + 会话更新事件
```

## Prompt 构建结构

`PromptBuilder` 当前会拼装：

- system persona 与 operating model
- 当前时间戳与意图域推断
- 记忆快照
- 可选个人知识库快照（`PersonalKnowledgeBase`）
- 可选会话文档 XML 快照（`SessionDocumentContextStore`）
- 已安装技能索引
- 浏览器模式与外部桥接提示

## 知识能力双通道

当前实现包含两条独立知识路径：

1. 个人知识库（`src/main/knowledge/personalKnowledgeBase.ts`）
- 上传文档 -> 转 Markdown -> 切分 -> 词法检索（可选关键词扩展）。
- 在聊天显式启用个人知识库时参与 Prompt。

2. 会话文档上下文（`src/main/knowledge/sessionDocumentContextStore.ts`）
- 会话级上传（docx/xlsx/pptx/pdf/txt 等）-> 转 XML 上下文。
- 可选保存一份到 workspace 供编辑流程使用。
- 以有字符预算上限的 XML 片段注入 Prompt。

## 定时任务与通知

`TaskScheduler` 每 15 秒轮询到期任务：

- 通过 `AgentLoop` 执行任务
- 在 `ScheduledTaskStore` 记录结果与执行轨迹
- 在 `SessionStore` 累积 token usage
- 按任务配置发送 SMTP 邮件通知（`EmailNotifier`）
- 按任务配置发送微信通知（依赖通道 token/context）

## 持久化目录

默认根目录：`~/.tasi-harness/`

关键路径：

- `config.json`
- `sessions/`
- `memories/entries.v2.json`
- `skills/`
- `personal-knowledge/`
- `session-documents/`
- `scheduled-tasks.json`
- `sandboxes/`
