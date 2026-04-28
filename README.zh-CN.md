# Tasi Harness

[English](README.md) | [简体中文](README.zh-CN.md)

Tasi Harness 是一个本地优先的桌面 AI Agent，基于 Electron、TypeScript、React 和 Vite 构建。它将对话、工具调用、浏览器自动化、记忆、技能系统、定时任务与文档知识能力整合在同一个桌面应用中。

> Tasi Harness 在架构思路上参考了 Hermes-Agent 风格运行时，但不捆绑原 Python Hermes 运行时。

![Tasi Harness Screenshot](docs/screen_shot.png)

## 亮点

- 桌面优先：会话、记忆、技能文件都可在本地管理。
- 内置多模型提供方预设：OpenAI、Anthropic、DeepSeek、Qwen / Bailian、MiniMax、Kimi、OpenAI-compatible、Ollama。
- 内置浏览器自动化工具，支持内嵌预览与外部浏览器桥接模式。
- 个人知识库支持将 Office 与文本类文档转换为可检索内容。
- 技能系统基于可编辑 `SKILL.md`，并支持市场来源浏览与安装。
- 支持定时任务、邮件通知、微信通知，以及按次沙箱执行。

## 功能概览

| 模块 | 说明 |
| --- | --- |
| Agent 运行时 | 支持工具感知的多轮执行循环、Prompt 组装与会话持久化。 |
| 记忆系统 | 将长期事实写入本地 JSON 记忆，并在对话时注入相关上下文。 |
| 浏览器自动化 | 内置 `browser_open`、`browser_click`、`browser_type`、`browser_extract` 等工具。 |
| 个人知识库 | 将本地文档转换并切分后做本地检索，无需 embedding 或外部向量库。 |
| 技能系统 | 支持读取、创建、修改、上传、安装 `SKILL.md` 技能。 |
| 会话管理 | 本地保存并检索历史会话。 |
| 定时任务 | 按时间/间隔执行任务，并可发送通知。 |
| 工作区安全 | 文件工具限定在工作区，支持复制式沙箱执行。 |

## 安装与打包测试

安装、打包、测试的详细步骤已拆分到独立文档：

- [安装、打包与测试指南](docs/INSTALLATION_PACKAGING_TESTING.zh-CN.md)

常用命令：

- 安装依赖：`npm install`
- 开发运行：`npm run dev`
- 构建：`npm run build`
- 测试：`npm test`
- Windows 打包：`npm run dist:win`
- macOS 打包：`npm run dist:mac`

## 快速开始

1. 执行 `npm run dev` 启动应用。
2. 打开 **Settings** 配置模型提供方。
3. 按需修改工作区目录。
4. 进入 **Chat** 开始对话。
5. 如需文档增强对话，先在 **Knowledge** 上传文档，再在聊天页启用 **Personal KB**。
6. 如需可复用流程，进入 **Skills** 使用本地或市场技能。
7. 如需后台执行，进入 **Tasks** 创建定时任务。

## 使用说明

### 模型提供方

内置预设包括：

- `OpenAI`、`DeepSeek`、`Qwen / Bailian`、`MiniMax`、`Kimi`、`OpenAI-compatible`：`/chat/completions` 风格接口。
- `Anthropic`：`/messages` 接口。
- `Ollama`：本地 `/api/chat`。

### 浏览器自动化与预览

应用内置 `browser_open`、`browser_wait`、`browser_extract` 等浏览器工具，支持 `embedded` 与 `external` 两种展示模式。

详细文档：

- [浏览器自动化](docs/BROWSER_AUTOMATION.zh-CN.md)

### 个人知识库

个人知识库支持文档上传、转换、切分与检索，并将高相关片段注入对话上下文。

详细文档：

- [个人知识库](docs/PERSONAL_KNOWLEDGE_BASE.zh-CN.md)

### 技能系统与市场

技能文件采用 `SKILL.md` 规范，支持本地编辑、压缩包上传、市场浏览与安装。

### 会话与记忆

- 会话历史保存在本地 JSON。
- 记忆条目保存在本地文件中，运行中写入采用延迟提交策略，降低失败时的半成品落盘风险。

### 定时任务与通知

- 支持单次/周期任务。
- 支持邮件通知与微信通知。
- 支持复用会话或自动创建新会话。

### 执行模式

- `workspace`：直接在工作区运行。
- `sandbox`：运行前复制工作区到独立沙箱后执行。

## 数据目录

默认数据目录：

```text
~/.tasi-harness/
```

常见路径：

```text
~/.tasi-harness/config.json
~/.tasi-harness/workspace/
~/.tasi-harness/memories/entries.v2.json
~/.tasi-harness/sessions/
~/.tasi-harness/skills/
~/.tasi-harness/personal-knowledge/
~/.tasi-harness/sandboxes/
```

## 安全说明

当前默认保护包括：

- Electron context isolation + typed preload bridge
- Renderer 不直接暴露 Node.js 能力
- 文件工具限定工作区
- 终端工具默认关闭
- 启用终端时仍拦截部分高风险命令模式

更多说明见：[docs/SECURITY.zh-CN.md](docs/SECURITY.zh-CN.md)

## 项目结构

```text
src/
  main/       Electron 主进程、Agent 运行时、工具、存储、调度
  preload/    类型化上下文桥接
  renderer/   React 前端
  shared/     共享 TypeScript 类型
resources/
  skills/     内置技能资源
  markets/    技能市场目录
tests/        Vitest 测试
docs/         文档目录
```

## 文档导航

- [架构说明](docs/ARCHITECTURE.zh-CN.md)
- [开发指南](docs/DEVELOPMENT.zh-CN.md)
- [安全说明](docs/SECURITY.zh-CN.md)
- [验证说明](docs/VERIFICATION.zh-CN.md)
- [安装、打包与测试指南](docs/INSTALLATION_PACKAGING_TESTING.zh-CN.md)
- [浏览器自动化](docs/BROWSER_AUTOMATION.zh-CN.md)
- [个人知识库](docs/PERSONAL_KNOWLEDGE_BASE.zh-CN.md)
- [版本发布说明（v1.2.0）](docs/release_v1.2.0.zh-CN.md)
- [版本发布归档（v1.1.0）](docs/release_v1.1.0.zh-CN.md)

## 致谢

- Hermes Agent：运行时设计灵感来源
- Electron：桌面应用壳层
- React + Vite：前端技术栈
- Vitest：测试框架
- JSZip：Office 与压缩包处理

## 许可证

[MIT](LICENSE)
