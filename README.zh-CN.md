# Tasi Harness

[English](README.md) | [简体中文](README.zh-CN.md)

Tasi Harness 是一个基于 Electron、TypeScript、React 与 Vite 的本地优先桌面 AI Agent。它把桌面化聊天体验、OpenAI 兼容工具调用、浏览器自动化、持久记忆、技能系统、定时任务，以及可将 Office 文档转换为 Markdown 的个人知识库整合在一起。

> Tasi Harness 在架构上借鉴了 Hermes-Agent 风格的运行时模式。

## 项目特点

- 桌面优先的 AI Agent，聊天、技能、记忆、文档知识库都在本地完成管理。
- 内置 OpenAI、Anthropic、DeepSeek、Qwen / Bailian、MiniMax、Kimi、OpenAI-compatible 与 Ollama 等模型提供方预设。
- 内置浏览器自动化工具，支持应用内网页预览和外部浏览器桥接模式。
- 支持将 `DOCX`、`XLSX`、`PPTX`、`Markdown`、`TXT`、`JSON`、`CSV` 转换为 Markdown 作为个人知识库。
- 基于 `SKILL.md` 的技能机制，支持内置技能、本地技能和技能市场。
- 支持定时任务、邮件通知，以及按次复制工作区的沙箱执行模式。
- 默认配置偏保守：启用 context isolation、文件访问受工作区限制、终端工具默认关闭。

## 功能概览

| 模块 | 说明 |
| --- | --- |
| Agent 运行时 | 提供工具感知的对话循环、Prompt 构建、多轮工具执行与会话持久化。 |
| 记忆系统 | 用本地 JSON 记忆条目保存长期事实，并在对话时注入相关记忆。 |
| 浏览器自动化 | 内置 `browser_open`、`browser_click`、`browser_type`、`browser_extract` 等浏览器工具。 |
| 个人知识库 | 将本地文档转换成 Markdown、提取资源、切分分块，并通过本地词法检索与可选关键词扩展召回片段，无需 embedding 或外部向量库。 |
| 技能系统 | 支持读取、创建、修改、上传、安装 `SKILL.md` 技能。 |
| 会话管理 | 本地保存并检索历史会话。 |
| 定时任务 | 支持按时间或间隔执行 Prompt，并可发送邮件通知。 |
| 工作区安全 | 文件工具仅允许访问配置的工作区，并支持复制式沙箱运行。 |

## 安装文档

### 环境要求

- Node.js 20+
- npm 10+
- Windows、macOS 或 Linux

### 安装依赖

```bash
npm install
```

如果你处在受限 CI 环境里，只需要跑类型检查或测试，可以跳过 Electron 二进制下载：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts
```

### 开发模式运行

```bash
npm run dev
```

这个命令会同时启动：

- Electron 主进程和 preload 的 TypeScript 编译
- Vite 前端开发服务
- Electron 桌面窗口

### 构建

```bash
npm run build
```

构建产物会输出到 `dist/`。

### 打包桌面应用

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:installers
powershell -ExecutionPolicy Bypass -File scripts/package-win-installer.ps1
bash scripts/package-macos-installer.sh
```

Electron Builder 会把打包产物写到 `release/`。

说明：

- `npm run dist:win` 用于生成 Windows `NSIS` 安装包。
- `npm run dist:mac` 用于生成 macOS `DMG` 安装包。
- `npm run dist:installers` 会一次性触发两个目标。
- `scripts/package-win-installer.ps1` 是面向 Windows 的 PowerShell 打包脚本。
- `scripts/package-macos-installer.sh` 是面向 macOS 的 Bash 打包脚本。
- macOS 安装包通常需要在 macOS 主机上执行打包。

### 测试

```bash
npm test
```

当前 Vitest 测试覆盖的核心流程包括：

- Agent 循环中的工具执行
- 记忆系统行为
- 工作区安全写入
- 技能解析与修改
- 个人知识库的添加、检索与删除

## 快速开始

1. 执行 `npm run dev` 启动应用。
2. 打开 **Settings** 配置模型提供方。
3. 如有需要，修改工作区目录。
4. 进入 **Chat** 开始对话。
5. 如果你希望对话引用私人文档，先到 **Knowledge** 上传文件，再在聊天页勾选 **Personal KB**。
6. 如果你想复用流程，进入 **Skills** 查看内置技能或市场技能。
7. 如果你想自动执行任务，进入 **Tasks** 创建定时任务。

## 使用文档

### 模型配置

当前 UI 内置了多种模型提供方预设：

- `OpenAI`、`DeepSeek`、`Qwen / Bailian`、`MiniMax`、`Kimi` 与 `OpenAI-compatible`：使用 `/chat/completions` 风格接口，支持工具调用。
- `Anthropic`：使用 `/messages` 接口与 tool-use block。
- `Ollama`：使用本地 `/api/chat` 接口连接本地模型。

### 浏览器自动化与网页预览

系统内置浏览器自动化工具，包括：

- `browser_open`
- `browser_state`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_wait`
- `browser_extract`
- `browser_close`

支持两种网页展示模式：

- `embedded`：网页直接在应用内预览，开箱即用。
- `external`：网页可在外部 Chromium 浏览器中展示；打包应用时可自动加载 `resources/opencli-extension` 中的 OpenCLI 桥接扩展。

### 个人知识库

**Knowledge** 页面支持上传：

- `md`
- `markdown`
- `txt`
- `text`
- `log`
- `json`
- `csv`
- `docx`
- `xlsx`
- `pptx`

上传后，系统会把文档转换为 Markdown、本地保存、按段落切分分块，并通过本地词法检索进行打分召回；整个流程不依赖 embedding 管线或外部向量数据库。聊天页勾选 **Personal KB** 后，系统会：

- 先从你的问题中提取检索关键词
- 如果当前模型可用，再用大模型补充检索关键词
- 把得分最高的片段注入到本轮对话 Prompt 中

### 技能系统与技能市场

技能以 `SKILL.md` 文件存在，支持 frontmatter 和说明正文。你可以：

- 浏览内置技能
- 创建或修改本地技能
- 上传技能压缩包
- 浏览 ClawHub、SkillHub 等市场来源

浏览器自动化相关的内置技能现在以 `agent-browser` 提供。

### 会话与记忆

Tasi Harness 会在本地保存：

- JSON 格式的会话历史
- `~/.tasi-harness/memories/entries.v2.json` 中的环境、项目与用户记忆条目
- 如存在旧版 `MEMORY.md` / `USER.md`，会在首次启动时导入

记忆写入会在一次运行结束后统一提交，避免中途失败导致半成品记忆落盘。

### 定时任务与通知

**Tasks** 页面支持：

- 单次任务
- 周期任务
- 为每个任务单独选择执行模式
- 执行完成后按需发送邮件通知

定时任务既可以继续已有会话，也可以在需要时创建新会话。

### 执行模式

应用支持两种执行模式：

- `workspace`：工具直接在配置好的工作区中运行。
- `sandbox`：运行前会把工作区复制到独立沙箱目录，再在该副本中执行。

## 数据目录

默认情况下，应用数据保存在：

```text
~/.tasi-harness/
```

常见路径如下：

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

Tasi Harness 默认采用比较保守的本地安全策略，但它仍然是一个能力很强的桌面 Agent。当前主要保护措施包括：

- Electron context isolation 与类型化 preload bridge
- Renderer 不直接访问 Node.js API
- 文件工具只允许访问工作区
- 终端工具默认关闭
- 即使开启终端，也会拦截若干明显危险的命令模式

它并不是一个完整意义上的强隔离沙箱。面对高风险或不可信任务时，建议保持终端关闭，或把应用放进系统级沙箱/容器中运行。

更多说明见 [docs/SECURITY.md](docs/SECURITY.md)。

## 项目结构

```text
src/
  main/       Electron 主进程、Agent 运行时、工具、存储、调度器
  preload/    类型化上下文桥接
  renderer/   React 前端界面
  shared/     共享 TypeScript 类型
resources/
  skills/     内置 SKILL.md 技能资源
  markets/    技能市场目录
tests/        Vitest 测试
docs/         工程与安全文档
```

## 参考文档

- [架构说明](docs/ARCHITECTURE.md)
- [开发文档](docs/DEVELOPMENT.md)
- [安全文档](docs/SECURITY.md)
- [验证说明](docs/VERIFICATION.md)

## 参考与致谢

- Hermes Agent：Prompt 组织、工具循环、过程记忆等架构思路来源
- Electron：桌面应用壳层与进程模型
- React + Vite：前端渲染栈
- Vitest：测试框架
- JSZip：Office 文档与压缩包处理

## 许可证

[MIT](LICENSE)
