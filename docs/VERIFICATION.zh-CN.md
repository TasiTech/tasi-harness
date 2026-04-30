# 验证说明

[English](VERIFICATION.en.md) | [简体中文](VERIFICATION.zh-CN.md)

本项目在当前环境下已执行：

```bash
npm test
npm run build
```

结果：

```text
Vitest: 测试全部通过。
Build: TypeScript 主进程/预加载类型检查通过，Vite 渲染层构建通过。
```

补充：

- 在受限环境中可跳过 Electron 二进制下载；类型检查与单元测试不依赖 Electron 运行时二进制。
- 在常规开发机上，执行 `npm run dev` 或打包前，建议直接 `npm install`（不加 `--ignore-scripts`）以确保 Electron 运行时可用。

