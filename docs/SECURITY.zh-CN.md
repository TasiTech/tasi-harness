# 安全说明

[English](SECURITY.en.md) | [简体中文](SECURITY.zh-CN.md)

Tasi Harness 是本地桌面 Agent。因为本地 Agent 执行能力较强，默认配置采用偏保守策略。

## 默认策略

- `allowShellTools` 默认为 `false`。
- 文件工具限定在配置的工作区目录。
- Renderer 不直接访问 Node.js。
- API Key 保存后不会直接返回给渲染层。

## 文件沙箱

`safeJoin(root, input)` 确保文件路径最终解析到 `workspaceDir` 内部。类似 `../outside.txt` 的越界路径会失败。

## 终端工具

终端工具需要显式开启 `allowShellTools: true`。即使开启，也会阻断一批高风险命令模式，例如：

- `rm -rf /`
- fork bomb
- 磁盘格式化命令
- 关机/重启命令
- 原始设备写入

这不是完整强隔离沙箱。面对不可信任务，建议将应用放入系统/容器沙箱，或保持终端工具关闭。

## API Key

主进程将提供方配置保存到 `~/.tasi-harness/config.json`。preload 桥接仅返回 `apiKeyConfigured: true/false`，不返回实际密钥。

## 建议的生产加固

- 为 API Key 接入系统钥匙串
- 为写入类工具和终端操作增加逐次确认
- 增加代码签名与自动更新签名验证
- 为不可信命令引入 Docker/远端终端后端
- 增加允许的工作区根目录白名单

