# 架构说明

[English](ARCHITECTURE.en.md) | [简体中文](ARCHITECTURE.zh-CN.md)

本文档对应 Tasi Harness v1.4.0 附近的当前代码实现。

## 代码架构图

![Tasi Harness architecture](architechcture.png)

图片文件名继续使用历史上的 `architechcture.png`，以兼容已有文档链接。

## 运行时分层

Tasi Harness 是一个 Electron 桌面应用，主要分为三层：

- Renderer（`src/renderer/*`）：React 前端页面，包括 Chat、Knowledge、Memory、Skills、Tasks、History、Settings、About。
- Preload（`src/preload/preload.ts`）：通过 Electron `contextBridge` 暴露类型化 `window.tasiHarness` IPC 桥。
- Main process（`src/main/*`）：应用服务、Agent 循环、模型客户端、工具执行、存储、浏览器自动化、定时任务、微信通道、导出与生命周期管理。

此外还有命令行入口 `src/main/cli.ts`。CLI 通过 `CliContext` 复用主进程服务类，因此桌面端和命令行共享配置、会话、记忆、技能、工具、浏览器自动化和个人知识库。

## 主体装配

`src/main/appContext.ts` 是组合根，负责创建和连接核心服务：

- 存储：`ConfigStore`、`SessionStore`、`MemoryStore`、`ScheduledTaskStore`、`McpConfigStore`。
- 技能与市场：`SkillManager`、`MarketplaceManager`。
- 知识服务：`PersonalKnowledgeBase`、`SessionDocumentContextStore`。
- 运行时：`AgentLoop`、`PromptBuilder`、`ToolRegistry`、`SandboxManager`。
- 浏览器服务：`BrowserAutomationRouter`、`EmbeddedBrowserAutomation`、`ExternalBrowserAutomation`、`ExternalBrowserBridge`、`BrowserExecutionLogger`。
- 后台服务：`TaskScheduler`、`EmailNotifier`。

启动时，`AppContext` 还会落盘内置技能、处理安装器传入的覆盖选择、从已有会话同步记忆、注册内置工具，并启动定时任务轮询。

## IPC 接口

`src/main/main.ts` 注册桌面端 IPC，并通过 preload 暴露给前端：

- `config:*`：模型提供方配置、微信二维码登录、连接测试。
- `agent:*`：对话、停止、流式消息增量、工具事件。
- `sessions:*`：会话列表、读取、搜索、重命名、删除、外部消息追加。
- `memory:*`：记忆查询与清理。
- `knowledge:*`：个人知识库文档与文件夹导入。
- `session-docs:*`：会话级上传文档上下文。
- `skills:*`：本地技能创建/读取/修改/删除、内置技能安装、技能压缩包上传、市场浏览/安装/卸载。
- `browser-coach:*`：浏览器行为录制与技能生成。
- `tasks:*`：定时任务增删改查与立即运行。
- `tools:*`：工具列表与手动工具执行。
- `app:*`：应用信息、PDF/DOCX 导出、打开路径/URL、浏览器预览绑定。
- `tool-approval:*`：交互式安全审批。

前端订阅 `agent:message-delta`、`agent:tool-event`、`sessions:updated` 和 `tool-approval:request`。

## Agent 执行流程

`src/main/agent/agentLoop.ts` 中的 `AgentLoop` 管理一次运行：

1. 通过 `SandboxManager` 准备执行目录，支持 `workspace` 或复制式 `sandbox`。
2. 创建或读取会话，追加用户消息和可选附件。
3. 通过 `PromptBuilder` 构建系统提示词。
4. 创建当前配置对应的 `LlmClient`，发送消息和启用的工具定义。
5. 如果模型客户端支持流式输出，则把正文和 reasoning 增量推给 UI/CLI，并按节流策略持久化流式快照。
6. 模型返回工具调用时，通过 `ToolRegistry` 执行工具，并持续发出工具事件。
7. 循环执行，直到模型返回最终回答或达到迭代上限。
8. 成功时提交延迟记忆写入；失败时丢弃本轮延迟记忆。
9. 持久化会话消息、工具事件、token usage 和执行目录信息。

桌面对话、CLI 对话、定时任务和微信自动回复都复用同一套 Agent 循环。

## 模型与多模态

`src/main/agent/llmClient.ts` 适配不同模型接口：

- OpenAI-compatible Chat Completions：OpenAI、DeepSeek、Qwen / Bailian、MiniMax、Kimi、自定义兼容接口。
- Anthropic Messages API。
- Ollama 本地接口。
- 测试用 mock provider。

附件统一使用 `src/shared/types.ts` 中的 `AgentMessageAttachment`，支持 `image`、`video`、`audio`。

当前提供方行为：

- OpenAI-compatible 请求可以携带 `image_url`、`video_url`、`input_audio` parts。
- Anthropic 请求当前会把图片附件转换为 image content block。
- 实际图片、视频、音频能力仍取决于所选模型和提供方接口是否支持。

流式输出通过 `LlmClient.streamComplete`、`AgentLoop` delta 事件、前端消息更新和 CLI 终端流式输出串起来。

## 工具与安全

内置工具由 `src/main/tools/builtinTools.ts` 的 `createBuiltinTools` 注册。

主要工具类别包括：

- 文件工具：限定工作区的读取、列表、写入、删除。
- 记忆工具：延迟提交的长期记忆变更。
- 会话搜索：本地历史会话检索。
- 技能工具：`skill_view` 和 `skill_manage`。
- 浏览器工具：打开、等待、快照、查找、点击、输入、选择、提取、截图、PDF、控制台/网络/存储等。
- 终端工具：在配置允许时执行受控 shell 命令。
- 微信文件回传：应用 ready 后注册 `wechat_send_file`。

`ToolRegistry` 负责工作区边界检查、安全审批、风险终端命令分类，以及技能优化保护。过宽、跨领域污染或把失败信号白名单化的技能补丁会在工具层被拒绝。

## 浏览器架构

浏览器自动化通过 `BrowserAutomationRouter` 路由：

- Embedded 模式使用 `EmbeddedBrowserAutomation` 和 renderer webview 预览。
- External 模式使用 `ExternalBrowserAutomation` 和 `ExternalBrowserBridge`。
- 外部桥接可连接 CDP target、启动隔离 profile、使用配置的 CDP endpoint，并在需要时退回 Safari/WebDriver 或系统浏览器打开。
- 浏览器执行日志可写入 `~/.tasi-harness/logs/browser-execution.log`。

Browser Coach 会记录 renderer 侧浏览器操作，并通过 `browserCoachSkill.ts` 调用当前模型生成可复用浏览器技能。

## 知识架构

当前有两条知识路径：

1. 个人知识库（`src/main/knowledge/personalKnowledgeBase.ts`）
- 通过 `documentConverter.ts` 将文档转换为 Markdown。
- 在 `~/.tasi-harness/personal-knowledge/` 下保存源文件、提取图片、Markdown 和 chunk 索引。
- 使用本地词法检索，并可选用 LLM 做关键词扩展。
- 只有聊天中启用 Personal KB 时才注入 Prompt。

2. 会话文档上下文（`src/main/knowledge/sessionDocumentContextStore.ts`）
- 通过 `documentXmlConverter.ts` 将会话级上传文档转换为 XML。
- 支持 Office、PDF、OFD、XML、Markdown、文本、JSON、CSV 等格式。
- XML 上下文保存在 `~/.tasi-harness/session-documents/`。
- 可选将上传文件复制到工作区 `session-documents/<session-id>/` 下，方便后续编辑。
- `PromptBuilder` 会将当前会话的 XML 片段按预算注入系统提示词。

用于多模态模型输入的媒体附件，与会话文档 XML 上下文是两条不同路径。

## 技能架构

技能是带 frontmatter 的可编辑 `SKILL.md` 工作流，来源包括：

- `resources/skills` 中的内置技能。
- `~/.tasi-harness/skills` 下的本地技能。
- `resources/markets` 和配置的远程市场来源。
- 用户上传的技能压缩包。
- Browser Coach 生成的技能。

Skills 页面包括已安装技能、市场浏览、压缩包上传、Browser Coach 和技能优化。技能优化本质上是一次带有聚焦提示词的 Agent 运行：读取会话失败信号，识别受影响技能，只修改相关 `SKILL.md` 或脚本，并完成校验。

## 微信通道

微信集成主要位于 `src/main/main.ts`：

- 二维码登录和状态轮询会写入 `ConfigStore`。
- `getupdates` 轮询会把外部消息追加到专用微信会话。
- 文档类文件项会进入 `SessionDocumentContextStore` 并转换为会话 XML 上下文。
- 图片、音频、视频可转换为 `AgentMessageAttachment`，用于多模态上下文。
- 文本消息可触发 `AgentLoop` 自动回复，并将最终回答发送回微信。
- `wechat_send_file` 会通过微信媒体 API 加密上传工作区文件，并以图片、视频或普通文件形式回传到当前微信对话。
- 定时任务也可以通过当前微信通道发送任务通知。

## 导出架构

助手消息导出由 `src/main/export/messageExport.ts` 和 `src/main/main.ts` 实现：

- PDF 导出会在隐藏 `BrowserWindow` 中渲染可打印 HTML，再调用 `printToPDF`。
- DOCX 导出用 `JSZip` 构造 Office 包。
- 尽量保留 Markdown 表格、标题、链接、引用关系和来源段落。
- PDF 导出内嵌 KaTeX CSS 以支持公式显示。
- DOCX 导出在检测到 LaTeX 时优先从原始 Markdown 转换公式，避免从 KaTeX HTML 抽取文本时出现分式顺序错误。

## 定时任务与通知

`TaskScheduler` 每 15 秒轮询到期任务：

- 通过 `AgentLoop` 执行任务 prompt。
- 在 `ScheduledTaskStore` 中记录输出、trace、迭代次数和工具事件数量。
- 在 `SessionStore` 中记录 token usage。
- 按配置通过 `EmailNotifier` 发送邮件。
- 按配置通过当前微信通道发送任务通知。

任务可以复用已有会话，也可以自动创建新会话，并可选择 `workspace` 或 `sandbox` 执行模式。

## 持久化目录

默认根目录：

```text
~/.tasi-harness/
```

关键路径：

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

工作区产物和生成文件默认写入当前配置的 workspace；如果本轮使用 sandbox 执行，则会写入复制出的沙箱工作区。
