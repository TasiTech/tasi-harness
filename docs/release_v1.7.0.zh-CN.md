# Tasi Harness 1.7.0 发布说明

[English](release_v1.7.0.en.md) | [简体中文](release_v1.7.0.zh-CN.md)

发布日期：2026-09-04

## 版本摘要

Tasi Harness 1.7.0 重点完善 DSH 插件兼容和内部浏览器稳定性。本版本通过通用 sidecar 桥接适配 DeepSeek Harness 风格插件，避免为每个插件单独补 shim，同时改进可见浏览器自动化、插件弹窗、Artifact 预览和中文界面文本显示。

## 主要更新

1. 扩展 DSH Cordis 宿主兼容层，覆盖 tools、commands、settings、skills、web、attachments、llm、sessions、agents、subagents、workspaceRegistry、storage、sandboxPolicy、webServer、clientRuntime、slots、locale、remote 以及相关前端服务。
2. 将 DSH 的 `skills.register` 和 `skills.registerProvider` 桥接到 Tasi 原生技能索引，`superdesign-dsh` 这类仅暴露 skill 的插件可以被发现、写入提示词，并通过 `skill_view` 读取。
3. 增加 DSH runtime tools 同步，搜索、读图和插件工具等 DSH 暴露的 agent-callable tools 可以动态注册到 Tasi 工具系统。
4. 改进 `@plugin` 提及：现在会展示插件 tools、skills、commands、settings 和运行状态；仅有 skills 的插件会进入技能工作流，而不是误路由到 sidecar chat。
5. 修复 sidecar 安装兼容问题，包括预发布 peer 依赖、hoisted node_modules、runtime entry 缺失以及 GitHub/NPM fallback 行为。
6. 改进插件客户端窗口和设置弹窗：使用 Tasi 品牌标识，提供稳定 Electron shell，补齐基础 UI primitive shim，并改善 client runtime 插件空白页问题。
7. 修复原生右键菜单、DSH client shell 标签和若干插件 UI 路径中的中文乱码。
8. 改进内部浏览器自动化：可见预览与自动化共享同一浏览器分区，浏览器工具运行时自动切到内部浏览器面板，并为页面脚本和 debugger 命令增加超时，避免工具调用卡死。
9. 修复 Artifact 预览路径解析，`MASTER.md` 等相对路径会按 session workspace、最近 artifact 元数据、配置工作区和 artifact 目录逐级查找。
10. 增加 DSH runtime 工具参数路径归一化，`screenshots/01-chat.png` 这类相对路径会按当前 workspace 转为绝对路径再传给插件工具。

## 适用场景

- 希望安装 DSH 插件后即用，而不是为每个插件手写 shim。
- 希望 `@superdesign-dsh` 即使没有 chat command handler，也能作为技能工作流参与设计任务。
- 希望 DSH 搜索、读图、设计辅助等工具进入普通 Tasi Agent 执行链路。
- 希望 Agent 登录、切换 SPA 页面、截图时，内部浏览器面板能同步展示真实操作状态。
- 希望当前 session 生成或引用的 Artifact 能稳定预览和打开。

## 体验改进

- 插件弹窗标题栏和 logo 统一为 Tasi Harness 品牌。
- 浏览器工具运行时会自动展开并切到内部浏览器面板。
- 浏览器工具异常时会返回有界超时错误，不再让整轮对话看起来一直卡住。
- 插件市场搜索在 API 失败或查询字符异常时降级更平滑。
- `@` 插件补全会包含仅暴露 skill 的插件，不再只显示 tools/commands 插件。

## 兼容性说明

- DSH chat 直连路由仍要求插件暴露 command/chat handler；仅有 skill 的插件会走 Tasi skills 和 `skill_view`。
- Superdesign CLI 命令仍需要通过 `superdesign login` 或 `SUPERDESIGN_TOKEN` 完成认证。
- DSH 插件兼容层已覆盖常见宿主服务，但不是 DeepSeek Harness 全量行为的完整复刻；未支持服务会更明确地降级。
- 内部浏览器状态从本版本开始共享；升级前已经启动的旧运行建议重启或开新 session 验证。

## 归档

- 上一版本发布说明：`docs/release_v1.6.0.zh-CN.md` 和 `docs/release_v1.6.0.en.md`。
