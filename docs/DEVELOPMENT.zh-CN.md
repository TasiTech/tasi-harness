# 开发指南

[English](DEVELOPMENT.en.md) | [简体中文](DEVELOPMENT.zh-CN.md)

## 常用命令

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run pack
```

## 新增工具

1. 在 `src/main/tools/builtinTools.ts` 或新模块中注册 `RegisteredTool`。
2. 提供 OpenAI 兼容 JSON Schema。
3. 确保文件访问限定在 `workspaceDir`。
4. 在 `tests/` 增加单元测试。
5. 若需默认启用，在 `src/main/storage/pathUtils.ts` 的 `enabledToolNames` 中追加。

## 新增前端页面

1. 在 `src/renderer/App.tsx` 的 `Page` 类型中添加页面 key。
2. 添加导航入口。
3. 创建页面组件并在 `styles.css` 补充样式。

## 新增内置技能

在 `resources/skills/<category>/<skill-name>/SKILL.md` 下创建目录与文档。

启动时，内置技能会同步到 `~/.tasi-harness/skills` 的对应目录：安装包里的文件会覆盖同路径内置技能副本，并清理该目录中旧版本残留文件；其他用户安装的技能目录保持不变。

## 测试说明

测试使用临时目录，不会写入真实用户目录。agent-loop 测试依赖 `MockLlmClient`，无需网络或 API Key。
