# 浏览器自动化

[English](BROWSER_AUTOMATION.en.md) | [简体中文](BROWSER_AUTOMATION.zh-CN.md)

Tasi Harness 内置浏览器自动化工具，可用于网页检索与页面交互。

## 工具集

- `browser_open`
- `browser_state`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_wait`
- `browser_extract`
- `browser_close`

## 浏览器模式

- `embedded`：页面在应用内预览。
- `external`：页面可在受控系统浏览器预览流中展示。

## 推荐流程

1. 用 `browser_open` 打开目标页面。
2. 遇到重定向时，用 `browser_state` 确认状态/URL。
3. 用 `browser_wait` 等待稳定标记再提取。
4. 仅在懒加载场景使用 `browser_scroll`。
5. 通过 `browser_extract` 做有边界的提取。
6. 完成后用 `browser_close` 关闭会话。

## 稳定性建议

- 优先使用有边界、可重复的提取方式，避免全页 dump。
- 在结果中保留来源 URL 证据。
- 页面未完整加载或受限时，明确标注不确定性。

