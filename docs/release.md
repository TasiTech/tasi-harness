# Tasi Harness 1.2.0 Release Notes / 发布说明

Release date / 发布日期: 2026-04-28

## English

1. Fixed Markdown table rendering stability in chat output, including mixed paragraphs/table blocks and trailing URL punctuation handling.
2. External browser preview now auto-closes when a task/session completes (normal completion, stop, and cleanup paths).
3. Added a conversation stop button behavior consistent with in-chat running state.
4. Improved Skill Marketplace UX and retrieval: clearer cards, source badges, result visibility, and debounced search calls.
5. Added session document upload for direct chat context (e.g. PDF) without adding files into the Personal Knowledge Base.
6. Added DeepSeek v4 model options: `deepseek-v4-flash` and `deepseek-v4-pro`, plus thinking-mode compatibility handling.
7. Verified scheduled task notification flow and added WeChat notification support alongside email notifications.
8. Added token usage statistics display (last run + cumulative), formatted in `M` units.
9. Expanded document interpretation support across multiple formats, including Office OpenXML and PDF session-context ingestion.

## 中文

1. 修复 Markdown 表格显示问题，提升聊天中表格/段落混排稳定性，并修正 URL 末尾标点链接边界。
2. 外部浏览器在任务完成后可自动关闭（覆盖正常完成、停止与清理路径）。
3. 增加对话停止按钮，并与对话执行中的等待状态保持一致。
4. 优化技能市场展示与检索体验：卡片信息更清晰、来源标识更直观、结果信息更明确，并加入检索防抖。
5. 增加会话级文档上传对话能力（如 PDF），仅用于当前对话上下文，不进入个人知识库。
6. 支持 DeepSeek v4 模型：`deepseek-v4-flash`、`deepseek-v4-pro`，并增强 thinking 模式兼容处理。
7. 测试并完善定时任务通知链路：保留邮件通知，同时增加微信通知能力。
8. 增加 Token 使用量统计显示（本次 + 累计），并以 `M` 单位展示。
9. 增强多文档格式解读能力，支持 Office OpenXML 与 PDF 等格式的会话上下文解析。

## Packaging / 打包

- App version bumped to `1.2.0`.
- Existing installer scripts remain compatible.

## Archive / 归档

- Previous release notes archived as `docs/release_v1.1.0.md`.
