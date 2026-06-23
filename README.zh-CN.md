# Tasi Harness

[English](README.md) | [简体中文](README.zh-CN.md)

Tasi Harness 是一个本地优先的桌面 AI Agent，基于 Electron、TypeScript、React 和 Vite 构建。它将流式对话、多模态附件、工具调用、浏览器自动化、记忆、技能系统、定时任务、图文文档写作/导出与文档知识能力整合在同一个桌面应用中。

> Tasi Harness 在架构思路上参考了 Hermes-Agent 风格运行时，但不捆绑原 Python Hermes 运行时。

![Tasi Harness Screenshot](docs/screen_shot.png)

## 亮点

- 桌面优先：会话、记忆、技能文件都可在本地管理。
- 支持流式输出，以及面向多模态模型的图片、视频、音频附件。
- 内置多模型提供方预设：OpenAI、Anthropic、DeepSeek、Qwen / Bailian、MiniMax、Kimi、OpenAI-compatible、Ollama。
- 内置浏览器自动化工具，支持内嵌预览与外部浏览器桥接模式。
- 深度搜索技能支持 Baidu、Google、Bing 等多搜索源，并将网页证据转换为可引用回答。
- 支持 Chat 会话文档上传，适合一次性围绕文件分析、改写或写作。
- 个人知识库支持将 Office、PDF、OFD 与文本类文档转换为可检索内容。
- 技能系统基于可编辑 `SKILL.md`，支持市场来源浏览、安装、浏览器行为录制生成技能、UI 设计技能与技能优化。
- 支持定时任务、邮件通知、微信通知，以及按次沙箱执行。
- 支持带公式处理的 PDF / Word 导出、引用网页展示、图文文档草稿、工作区打开，以及安装后的命令行对话。
- 微信通道支持文本、文档/媒体上传，并可回传工作区内生成的文件。

## 功能概览

| 模块 | 说明 |
| --- | --- |
| Agent 运行时 | 支持流式输出、工具感知的多轮执行循环、Prompt 组装、多模态附件与会话持久化。 |
| 记忆系统 | 将长期事实写入本地 JSON 记忆，并在对话时注入相关上下文。 |
| 浏览器自动化 | 支持导航、基于 CDP 的外部 Chromium 自动化与可选无头启动、带 `@e` 引用的快照、语义查找、键盘/鼠标/表单操作、提取、截图/PDF、存储/Cookie、控制台、网络、视口与关闭重置工具。 |
| 深度搜索与引用 | 通过 `deep-search` 使用 Baidu、Google、Bing 等搜索源打开网页、抽取证据，并在回复中保留编号 Markdown 引用。 |
| 会话文档与媒体附件 | 支持在单次 Chat 会话中上传文档形成有界上下文，也可向支持多模态的提供方发送图片、视频、音频附件。 |
| 个人知识库 | 将本地文档转换并切分后做本地检索，支持 Office、PDF、OFD 与文本类格式，无需 embedding 或外部向量库。 |
| 技能系统 | 支持读取、创建、修改、上传、安装与优化 `SKILL.md` 技能，并可通过浏览器教练录制用户操作生成技能；内置深度搜索、旅行、浏览器自动化与 UI 设计相关技能。 |
| 历史会话 | 本地保存并检索历史对话。 |
| 定时任务 | 按时间/间隔执行任务，并可发送邮件或微信通知。 |
| 工作区安全 | 文件工具限定在工作区，支持复制式沙箱执行。 |
| 导出、微信与命令行 | 助手回复可导出带公式处理的 PDF / Word，可通过微信回传生成文件，安装后可在 PowerShell 或 bash 中使用 `tasi chat`。 |

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
5. 如需一次性文档或媒体上下文，可直接在 **Chat** 上传；如需跨会话复用文档，再在 **Knowledge** 上传并启用 **Personal KB**。
6. 如需可复用流程，进入 **Skills** 使用本地或市场技能，也可以录制浏览器教练流程或优化已有技能。
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

### 对话附件与会话文档

聊天页支持流式回复，并可为具备多模态能力的模型上传媒体附件。图片、视频和音频会在所选提供方支持时作为模型附件发送。

需要围绕某个文件做一次性分析、改写或写作时，使用 Chat 中的会话文档上传。会话文档会转换为当前会话可用的 XML 上下文。需要跨会话反复复用的材料，则放入 **Knowledge** 个人知识库。

### 引用溯源与导出

浏览器或搜索支撑的回答会优先输出编号 Markdown 引用，例如 `[1](https://example.com/source)`。聊天页会自动提取这些引用，在消息上方和引用网页区域展示来源，方便回看原网页。

助手回复支持导出为 PDF 或 Word，适合保存报告、行程规划、网页调研结论、带引用的表格和图文文档草稿。PDF 导出包含 KaTeX 公式样式，DOCX 导出会尽量保留可读公式文本。

### 技能系统与市场

技能文件采用 `SKILL.md` 规范，支持本地编辑、压缩包上传、市场浏览与安装，也支持根据历史 session 的失败信号做定向技能优化。内置 `deep-search` 可用于多搜索源网页调研，`tasi-travel` 可用于带携程数据和路线链接的行程规划，`ui-ux-pro-max` 可辅助 UI 设计工作。浏览器教练可以记录用户在浏览器中的操作，并生成可复用的浏览器技能。

### 微信通道

微信通道支持接收文本、文档上传以及图片/音频/视频媒体。文档会转换为会话文档上下文，媒体可作为多模态附件。需要把生成文件发回用户时，Agent 可通过 `wechat_send_file` 将工作区内文件回传到当前微信对话。

### 会话与记忆

- 会话历史保存在本地 JSON。
- 记忆条目保存在本地文件中，运行中写入采用延迟提交策略，降低失败时的半成品落盘风险。

### 命令行对话

安装 Windows NSIS 包后，安装目录会加入当前用户 `PATH`，新开 PowerShell 后可直接使用：

```powershell
tasi chat "帮我总结当前工作区"
tasi chat --session xxx "继续这个会话"
tasi chat -s xxx -e sandbox "继续这个会话"
tasi chat --execution sandbox --knowledge "根据个人知识库回答"
tasi chat --no-memory --no-skills --tools none "不使用记忆、技能或工具回答"
tasi chat --skill deep-search --tools browser_open,browser_extract "调研这个主题"
tasi sessions
```

如果 PowerShell 仍提示找不到 `tasi`，关闭所有 PowerShell / Windows Terminal 窗口后重新打开，并可运行 `Get-Command tasi` 检查来源。安装器也会在 `%LOCALAPPDATA%\Microsoft\WindowsApps` 写入 shim。PowerShell 使用 `tasi.ps1`，`cmd.exe` 下的 `tasi.cmd` 会委托给同一个 PowerShell 启动器；启动器会把控制台输入/输出设为 UTF-8，不再打印 `chcp` 输出，也不会清空终端内容。

macOS 安装到 `/Applications` 后，可在 bash 中使用应用内置命令：

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "帮我总结当前工作区"
ln -sf "/Applications/Tasi Harness.app/Contents/Resources/bin/tasi" "$HOME/.local/bin/tasi"
```

无参数运行 `tasi` 会进入交互式对话。`chat` 不传 `--session/-s` 会新建会话，传入 `--session xxx` 或 `-s xxx` 会追加到该会话，`xxx` 就是完整 session id，不需要固定前缀。`tasi sessions` 会列出已保存会话；脚本需要结构化会话列表时可加 `--json`。每次回复后都会显示当前 session id。命令行复用桌面应用的 `~/.tasi-harness/config.json`、会话、记忆、技能与个人知识库；浏览器自动化会通过外部 Chrome / Edge 的 CDP 模式运行。

常用对话选项：

- `--execution workspace|sandbox` / `-e workspace|sandbox`：选择工具直接在工作区运行，或在复制出的沙箱中运行。
- `--knowledge` / `-k`：启用个人知识库上下文。
- `--no-memory`：本次运行禁用持久记忆。
- `--memory-domains <list>`：用逗号分隔的记忆域替代自动推断。可用域包括 `finance`、`daily_life`、`work`、`travel`、`reading`、`education`、`health`、`other`。
- `--no-skills`：不把技能索引注入提示词。
- `--skill <name>`：启用一个指定技能，可重复传入。
- `--skills <list>`：启用逗号分隔的多个技能。
- `--tools <list>`：用逗号分隔的工具列表替代配置默认值；`--tools none` 表示禁用工具。
- `--stream` / `--no-stream`：默认流式输出；也可等待完整回复后再输出。
- `--plain` / `-p`：输出 Markdown 原文，而不是终端渲染版 Markdown。
- `--json` / `-j`：输出完整运行结果对象，包含 `sessionId`、`finalResponse`、`messages`、`toolEvents`、`usage` 与 `execution` 等字段。
- `--log-probs` 与 `--top-logprobs <0-5>`：在 `--json` 模式下请求 token log probabilities 和可选候选 token。
- `--verbose` / `-V`：将工具事件输出到 stderr。
- `--home <path>` / `-H <path>`：覆盖 `TASI_HARNESS_HOME`。

CLI 也支持管道输入：

```powershell
Get-Content .\prompt.md | tasi chat --plain
```

交互式命令包括 `:new`、`:session <id>`、`:exit`。可用 `tasi help` 或 `tasi --help` 查看内置用法，用 `tasi version` 或 `tasi --version` 输出打包版本。

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
- 终端工具与网络工具默认开启
- 开启安全审批后，风险终端命令需要审批
- 终端工具仍会拦截部分明显高风险命令模式

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
- [版本发布说明（v1.4.0）](docs/release_v1.4.0.zh-CN.md)
- [版本发布归档（v1.3.0）](docs/release_v1.3.0.zh-CN.md)
- [版本发布归档（v1.2.0）](docs/release_v1.2.0.zh-CN.md)
- [版本发布归档（v1.1.0）](docs/release_v1.1.0.zh-CN.md)

## 致谢

- Hermes Agent：运行时设计灵感来源
- Electron：桌面应用壳层
- React + Vite：前端技术栈
- Vitest：测试框架
- JSZip：Office 与压缩包处理

## 许可证

[MIT](LICENSE)
