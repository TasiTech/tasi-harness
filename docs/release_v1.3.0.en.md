# Tasi Harness 1.3.0 Release Notes

[English](release_v1.3.0.en.md) | [简体中文](release_v1.3.0.zh-CN.md)

Release date: 2026-05-09

## Highlights

1. Improved browser tools: `browser_snapshot` now treats the accessibility tree as the primary page map and preserves actionable `@e` refs for clicks, typing, selection, and extraction.
2. Added a deep-search skill: bundled `deep-search` supports Baidu, Google, Bing, DuckDuckGo, Sogou, 360, and other engines, following a search-result -> opened-page -> evidence-extraction workflow.
3. Added citation traceability: browser/search-backed answers are prompted to use numbered Markdown links, and the UI extracts referenced pages with URL, host, and supporting excerpt display.
4. Added privacy and permission prompts: file deletes, outside-workspace access, and risky terminal commands can trigger safety approval with one-time or remembered approval.
5. Improved travel planning: `tasi-travel` prefers Ctrip browser retrieval for hotels, transport, and POIs, with stronger source ledgers, citations, degradation rules, and Amap route links.
6. Added Browser Coach: users can record browser navigation, clicks, input, selection, and keyboard behavior, then generate a reusable browser skill from the trace.
7. Added PDF / Word export: assistant replies can be exported as PDF or DOCX while preserving Markdown tables, headings, links, and citation relationships.
8. Added OFD document parsing: session documents and Personal Knowledge Base support `.ofd` through best-effort extraction from package XML and text entries.
9. Expanded document ingestion: Personal Knowledge Base and session context support Markdown, TXT, JSON, CSV, DOCX, XLSX, PPTX, PDF, and OFD.
10. Improved the UI: the sidebar is collapsible, the chat page is wider, Sessions is now History, and cited webpages are shown alongside web-backed answers.
11. Added workspace opening: the chat page can open the current workspace directory directly.
12. Added command-line chat: installed apps expose `tasi chat` in Windows PowerShell and macOS bash, with `--session/-s`, `--json/-j`, `--plain/-p`, interactive mode, and external-browser CDP tools.

## Command-Line Chat

The Windows installer adds the install directory to the current user's `PATH`. Open a new PowerShell window and run:

```powershell
tasi chat "summarize the current workspace"
tasi chat --session xxx "continue this session"
tasi chat -s xxx -e sandbox "continue this session"
tasi chat --json "print structured output"
tasi sessions
```

On macOS, use the bundled launcher inside the app:

```bash
/Applications/Tasi\ Harness.app/Contents/Resources/bin/tasi chat "summarize the current workspace"
```

Omitting `--session/-s` creates a new session; passing it appends to that session id. Normal output renders Markdown with `marked-terminal`, `--plain` prints raw Markdown, and `--json` prints the full run result object.

## Packaging

- App version bumped to `1.3.0`.
- Windows NSIS packages include `tasi.cmd` / `tasi-harness.cmd`, add the install directory to the current user's PATH, and create shims in `%LOCALAPPDATA%\Microsoft\WindowsApps` for better PowerShell command discovery.
- PowerShell uses `tasi.ps1`, while `cmd.exe` delegates `tasi.cmd` to the same PowerShell launcher; the launcher sets console input/output to UTF-8 without printing `chcp` output or clearing the terminal.
- macOS app bundles include `Contents/Resources/bin/tasi` / `tasi-harness`.
- Packaging verifies Windows executable metadata and explains recovered transient electron-builder `rcedit` retries when final packaging succeeds.

## Compatibility Notes

- Browser automation in the CLI uses external Chrome / Edge CDP mode with isolated profiles and per-process ports for parallel CLI runs.
- OFD parsing is best-effort text extraction; scanned or complex-layout OFD files may still require a dedicated renderer or OCR.
- Citation display depends on numbered Markdown links in assistant output, such as `[1](https://example.com/source)`.

## Archive

- Previous release: `docs/release_v1.2.0.en.md` and `docs/release_v1.2.0.zh-CN.md`.
