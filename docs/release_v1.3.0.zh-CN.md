# Tasi Harness 1.3.0 发布说明

[English](release_v1.3.0.en.md) | [简体中文](release_v1.3.0.zh-CN.md)

发布日期：2026-05-09

## 主要更新

1. 优化浏览器工具链：`browser_snapshot` 以 accessibility tree 为主要页面地图，并保留可操作的 `@e` 引用，方便后续点击、输入、选择与提取。
2. 增加深度搜索技能：内置 `deep-search`，支持 Baidu、Google、Bing、DuckDuckGo、Sogou、360 等搜索入口，按“搜索结果 -> 打开网页 -> 抓取证据”的流程获取更深入网页内容。
3. 增加引用溯源：浏览器和搜索类回答要求使用编号 Markdown 链接引用，UI 会提取并展示引用网页，保留来源 URL、站点和支持的事实。
4. 增加隐私与权限提醒：文件、删除、跨工作区访问和风险终端命令会触发安全审批弹窗，并支持“本次允许”和“以后不再询问”。
5. 优化行程规划技能：`tasi-travel` 优先使用携程浏览器检索链路，强化酒店、交通、景点数据的来源记录、引用输出、降级策略和高德路线链接。
6. 增加浏览器教练：用户可以记录浏览器导航、点击、输入、选择和键盘行为，并将操作轨迹生成可复用的浏览器技能。
7. 增加 PDF / Word 导出：助手回复可导出为 PDF 或 DOCX，并保留 Markdown 表格、标题、链接和引用关系。
8. 支持 OFD 文档解析：会话文档与个人知识库增加 `.ofd` 支持，采用包内 XML 与文本条目的 best-effort 提取。
9. 扩展文档解析：个人知识库和会话上下文支持 Markdown、TXT、JSON、CSV、DOCX、XLSX、PPTX、PDF、OFD 等格式。
10. 优化界面：侧栏可收缩，对话页展示更宽，原会话页调整为“历史”，并加入引用网页区域。
11. 增加工作区打开功能：聊天页可直接打开当前工作区目录，方便查看生成文件和导出内容。
12. 增加命令行对话：安装后可在 Windows PowerShell 或 macOS bash 中使用 `tasi chat`，支持 `--session/-s` 续聊、`--json/-j`、`--plain/-p`、交互模式和外部浏览器 CDP 工具。

## 命令行使用

Windows 安装包会把安装目录加入当前用户 `PATH`，新开 PowerShell 后可运行：

```powershell
tasi chat "帮我总结当前工作区"
tasi chat --session xxx "继续这个会话"
tasi chat -s xxx -e sandbox "继续这个会话"
tasi chat --json "输出结构化结果"
tasi sessions
```

macOS 可使用应用包内启动器：

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "帮我总结当前工作区"
```

不传 `--session/-s` 会新建会话，传入后会追加到对应 session id。普通输出会使用 `marked-terminal` 渲染 Markdown，`--plain` 输出原文，`--json` 输出完整运行结果对象。

## 打包说明

- 应用版本升级至 `1.3.0`。
- Windows NSIS 包包含 `tasi.cmd` / `tasi-harness.cmd` 与 `tasi.ps1` / `tasi-harness.ps1`，安装后加入当前用户 PATH，并在 `%LOCALAPPDATA%\Microsoft\WindowsApps` 写入 shim 以改善 PowerShell 命令发现。
- PowerShell 使用 `tasi.ps1`，`cmd.exe` 下的 `tasi.cmd` 会委托给同一个 PowerShell 启动器；启动器会把控制台输入/输出设为 UTF-8，不再打印 `chcp` 输出，也不会清空终端内容。
- macOS 应用包包含 `Contents/Resources/bin/tasi` / `tasi-harness`。
- 打包脚本会校验 Windows 可执行文件 metadata，并在 electron-builder 的瞬时 `rcedit` 重试最终恢复时给出提示。

## 兼容性说明

- 浏览器自动化在 CLI 中使用外部 Chrome / Edge CDP 模式，并为并行 CLI 进程分配独立端口和隔离 profile。
- OFD 解析为 best-effort 文本提取；扫描版或复杂版式 OFD 仍可能需要专用渲染器或 OCR。
- 引用展示依赖助手输出的编号 Markdown 链接，例如 `[1](https://example.com/source)`。

## 归档

- 上一版本发布说明：`docs/release_v1.2.0.en.md` 与 `docs/release_v1.2.0.zh-CN.md`。
