# 安装、打包与测试

[English](INSTALLATION_PACKAGING_TESTING.en.md) | [简体中文](INSTALLATION_PACKAGING_TESTING.zh-CN.md)

本文档提供 Tasi Harness 的安装、构建、打包与测试详细说明。

## 环境要求

- Node.js 20+
- npm 10+
- Windows、macOS 或 Linux（运行/打包）

## 安装依赖

```bash
npm install
```

若在受限 CI 仅做类型检查或测试，可跳过 Electron 二进制下载：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts
```

## 开发运行

```bash
npm run dev
```

会同时启动：

- Electron main/preload TypeScript 编译
- Vite 渲染层开发服务
- Electron 应用

## 首次桌面端配置

1. 打开 **Settings**，选择模型提供方、Base URL、API Key 和模型名称。
2. 选择工作区目录。生成文件、浏览器产物、导出文件和会话文档的可编辑副本会写入该目录。
3. 选择执行模式：
   - `workspace`：工具直接在配置的工作区中运行。
   - `sandbox`：每次运行前复制工作区到 `~/.tasi-harness/sandboxes/` 下的独立沙箱。
4. 只启用你希望模型使用的工具。开启安全审批后，风险文件操作和终端命令会触发审批。
5. 浏览器任务可在 **Settings** 中选择内嵌预览或外部浏览器模式。外部模式优先使用 Chrome / Edge CDP。

## 桌面端使用

### 对话、流式输出与附件

- 模型生成时，回复会流式显示在聊天窗口；工具事件也会实时出现。
- 对话输入支持给具备多模态能力的模型上传媒体附件：
  - 图片：截图分析、UI 检查、视觉问答
  - 视频：所选模型支持视频输入时，可用于视频素材理解
  - 音频：兼容 OpenAI 风格音频输入的端点可使用
- 多模态能力取决于所选模型和提供方。纯文本模型仍会收到文本内容，但可能拒绝不支持的附件。

### 会话文档与个人知识库

Tasi Harness 有两条文档路径：

- **Chat 中的会话文档上传**：把文档附加到当前会话，转换为有预算上限的 XML 上下文，适合一次性的分析、改写、抽取和文档写作。
- **Knowledge 中的个人知识库**：把文档导入可复用的本地知识库，转换为 Markdown 并切分，在聊天中开启 **Personal KB** 后参与检索。

临时处理某个文件时用会话文档；需要跨会话反复检索的材料放入个人知识库。

### 图文文档写作与导出

- 在 Chat 中上传源文档或媒体后，可以要求生成报告、摘要、方案、说明文档或图文草稿。
- 助手消息可通过消息操作导出为 PDF 或 DOCX。
- PDF 导出使用可打印 HTML，并包含 KaTeX 样式以支持公式显示。
- DOCX 导出会尽量保留标题、表格、链接、引用关系和可读公式文本。

### 技能、Browser Coach 与技能优化

进入 **Skills** 可以：

- 浏览已安装的内置/本地技能
- 浏览和安装市场技能
- 上传技能压缩包
- 创建或编辑本地 `SKILL.md` 工作流
- 使用 Browser Coach 录制浏览器操作并生成可复用浏览器技能
- 使用 **Optimize** 页签检查历史 session，识别失败的技能行为，并只修补受影响的技能工作流

技能优化使用普通 Agent 运行时和内置技能管理保护规则。过宽的跨领域补丁、或把失败信号降级/白名单化的补丁会被拒绝。

### 微信通道

在 **Settings** 中配置微信：

1. 获取二维码并使用微信扫码。
2. 登录确认后，微信消息会进入专用微信会话。
3. 微信文本消息可触发 Agent 自动回复。
4. 微信上传的文档会转换为会话文档 XML 上下文。
5. 微信上传的图片、音频、视频可作为多模态附件。
6. 用户要求接收生成文件时，Agent 可使用 `wechat_send_file` 将工作区内的文件回传到当前微信对话。

微信文件回传仅支持工作区内文件，并要求微信通道 token、最近用户 id 和 context token 可用。

## 构建

```bash
npm run build
```

产物输出到 `dist/`。

## 桌面打包

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:installers
powershell -ExecutionPolicy Bypass -File scripts/package-win-installer.ps1
bash scripts/package-macos-installer.sh
```

打包产物输出到 `release/`。

说明：

- `npm run dist:win` 生成 Windows `NSIS` 安装包
- `npm run dist:mac` 生成 macOS `DMG`
- `npm run dist:installers` 一次触发双平台目标
- `scripts/package-win-installer.ps1` 为 Windows 打包脚本
- `scripts/package-macos-installer.sh` 为 macOS 打包脚本
- macOS 打包通常应在 macOS 主机执行
- 安装包会包含命令行启动器：Windows 为安装目录下的 `tasi.cmd` / `tasi-harness.cmd`，macOS 为应用包内的 `Contents/Resources/bin/tasi` / `tasi-harness`
- Windows 安装器会在写入新文件前清理旧的程序安装目录；用户数据目录 `~/.tasi-harness` 不会被清理。启动时，安装包内置技能会同步到 `~/.tasi-harness/skills` 的对应内置副本，其他用户安装的技能保持不变。

## 命令行使用

Windows 安装后，新开 PowerShell：

```powershell
tasi chat "写一个今天的工作计划"
tasi chat --session xxx "继续上次的方案"
tasi chat -s xxx -e sandbox "继续上次的方案"
tasi chat --execution sandbox --knowledge "基于个人知识库回答"
tasi sessions
```

如果刚安装完 PowerShell 仍提示找不到 `tasi`，先关闭所有 PowerShell / Windows Terminal 窗口后重新打开；也可以用下面命令检查命令来源：

```powershell
Get-Command tasi
```

安装器会同时把安装目录写入当前用户 `PATH`，并在 `%LOCALAPPDATA%\Microsoft\WindowsApps` 写入 `tasi.cmd` / `tasi-harness.cmd` shim。PowerShell 使用 `tasi.ps1`，`cmd.exe` 下的 `tasi.cmd` 会委托给同一个 PowerShell 启动器；启动器会把控制台输入/输出设为 UTF-8，不再打印 `chcp` 输出，也不会清空终端内容。

macOS 安装到 `/Applications` 后：

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "写一个今天的工作计划"
mkdir -p "$HOME/.local/bin"
ln -sf "/Applications/Tasi Harness.app/Contents/Resources/bin/tasi" "$HOME/.local/bin/tasi"
```

常用选项：

- `--session <id>` / `-s <id>`：复用已有会话；`<id>` 就是完整 session id，不需要固定前缀；不传则新建会话
- `--execution workspace|sandbox` / `-e workspace|sandbox`：选择执行模式
- `--knowledge` / `-k`：启用个人知识库上下文
- `--plain` / `-p`：只输出 Markdown 原文流；默认流式输出会先实时打印原文，完成后清掉原文并替换成 `marked-terminal` 渲染版
- `--json` / `-j`：输出完整 JSON 结果，包含 `sessionId`、`finalResponse`、`messages`、`toolEvents`、`usage`、`execution` 等字段，便于脚本解析
- `--verbose` / `-V`：输出工具事件
- `--home <path>` / `-H <path>`：覆盖默认数据目录

无消息运行 `tasi` 会进入交互式对话，支持 `:new`、`:session <id>`、`:exit`。每次回复后都会显示当前 session id。命令行复用桌面端配置与本地数据；浏览器自动化工具通过外部 Chrome / Edge 的 CDP 模式运行。

## 测试

```bash
npm test
```

Vitest 覆盖包括：

- agent-loop 工具执行
- 流式消息增量
- 记忆行为
- 工作区安全约束
- 技能解析与更新
- 个人知识库流程
- 会话文档上下文流程
- 渲染层 Markdown、引用和 LaTeX 渲染
- PDF/DOCX 导出辅助逻辑
- 定时任务与通知路径
