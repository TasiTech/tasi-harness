# Tasi Harness 1.5.0 发布说明

[English](release_v1.5.0.en.md) | [简体中文](release_v1.5.0.zh-CN.md)

发布日期：2026-07-22

## 版本摘要

1.5.0 主要是运行稳定性、CLI 可控性、浏览器自动化和打包链路的增强版本。它不是新增基础工作台能力，而是让已有智能体流程更适合脚本化调用、网页登录、自动填单和 Linux/Ubuntu 分发。

## 主要更新

- CLI 增加更细粒度参数：`--no-memory`、`--memory-domains`、`--no-skills`、`--skill/--skills`、`--tools`、`--log-probs`、`--top-logprobs`、`--turn-type`、`--session-done`，并完善管道输入、`help`、`version` 和 `sessions --json` 文档。
- LLM 调用增强：支持请求 metadata、JSON 输出中的 logprobs，并规范 OpenAI 兼容工具参数，减少工具调用参数格式异常。
- 新增 provider：加入 vLLM 本地 OpenAI 兼容服务预置，并增加 SoildAPI 文本模型 provider 预置。
- 浏览器自动化增强：改进点击后的导航/DOM 变化观察，新增文件上传工具，优化网页登录等待、已填账号密码的登录提交和长等待超时。
- 增加敏感信息脱敏：浏览器快照、表单值、URL 参数和序列化内容会更主动遮蔽账号、密码、token、手机号等敏感字段。
- AgentLoop 增加重复熔断：连续 3 次重复模式会中止，降低无限循环风险。
- 浏览器教练增强：支持外部 CDP 浏览器录制，并增加录制列表、读取和删除能力。
- 打包链路增强：新增 Ubuntu/Linux `.bin` 与 `.deb` 打包脚本和文档，开发模式启动脚本也改为更稳定的固定端口流程。

## 兼容性说明

- vLLM 默认指向 `http://127.0.0.1:8000/v1`，需要用户本地自行启动兼容服务。
- 浏览器自动化的脱敏策略会隐藏部分表单值；如需排查页面状态，应优先依赖 selector、按钮文本和页面结构。
- Ubuntu/Linux 打包通常需要在 Linux 环境执行。

## 归档

- 上一版本发布说明：`docs/release_v1.4.0.zh-CN.md` 和 `docs/release_v1.4.0.en.md`。
