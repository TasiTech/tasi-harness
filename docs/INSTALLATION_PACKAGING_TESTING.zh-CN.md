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

