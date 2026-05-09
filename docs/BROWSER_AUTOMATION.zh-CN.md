# 浏览器自动化

[English](BROWSER_AUTOMATION.en.md) | [简体中文](BROWSER_AUTOMATION.zh-CN.md)

Tasi Harness 内置浏览器自动化工具，可用于网页检索与页面交互。

## 相关技能

- `tasi-browser-automation`：浏览器工具使用规范，强调先用 `browser_snapshot` 获取 accessibility tree 与 `@e` 引用。
- `deep-search`：多搜索源深度检索流程，支持 Baidu、Google、Bing、DuckDuckGo、Sogou、360 等入口，要求打开网页并抽取证据后再回答。
- `tasi-travel`：行程规划入口技能，优先使用携程浏览器检索链路，并保留来源引用。

## 工具集

- `browser_open`
- `browser_state`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_wait`
- `browser_extract`
- `browser_snapshot`（accessibility-first tree，带 `@e` 引用）
- `browser_find`
- `browser_hover`
- `browser_select`
- `browser_check`
- `browser_press`
- `browser_screenshot`
- `browser_pdf`
- `browser_storage`
- `browser_cookies`
- `browser_console`
- `browser_network`
- `browser_eval`
- `browser_viewport`
- `browser_close`

## 浏览器模式

- `embedded`：页面在应用内预览。
- `external`：浏览器工具会通过 CDP attach 到受控 Chromium 系外部浏览器页面，点击、快照、提取、截图、存储、Cookie、控制台、网络检查都作用在外部页面上。Safari/WebDriver 与 shell fallback 仍属于仅预览路径。
- `browserHeadless`：受管外部 CDP 浏览器的可选无头模式。开启后不会显示浏览器窗口，需要通过 `browser_snapshot`、`browser_extract` 与 `browser_screenshot` 检查页面。

## 推荐流程

1. 用 `browser_open` 打开目标页面。
2. 遇到重定向时，用 `browser_state` 确认状态/URL。
3. 面对不熟悉页面时，先用 `browser_snapshot` 获取 accessibility/semantic tree 和 `@e` 元素引用。
4. 用 `browser_wait` 等待稳定标记后再交互或提取。
5. 优先用 `browser_find` 或 `@e` 引用操作控件；CSS 选择器只在稳定时使用。
6. 仅在懒加载场景使用 `browser_scroll`。
7. 通过 `browser_extract` 做有边界的提取。
8. 调试动态页面、登录状态或缺失数据时，使用 `browser_console`、`browser_network`、`browser_storage`、`browser_cookies`。
9. 完成后用 `browser_close` 关闭会话。

## 稳定性建议

- 优先使用有边界、可重复的提取方式，避免全页 dump。
- 将 `browser_snapshot.snapshot` 作为主要操作地图；需要正文/内容数据时再用 `browser_extract`。
- 在结果中保留来源 URL 证据。
- 面向用户的网页事实回答应使用编号 Markdown 链接引用，例如 `[1](https://example.com/source)`，以便 UI 展示引用网页。
- 文本提取不足时，可用 `browser_screenshot` 或 `browser_pdf` 保存视觉证据。
- 页面未完整加载或受限时，明确标注不确定性。
