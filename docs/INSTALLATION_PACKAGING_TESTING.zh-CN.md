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
- 记忆行为
- 工作区安全约束
- 技能解析与更新
- 个人知识库流程
- 会话文档上下文流程
