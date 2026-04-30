# 个人知识库

[English](PERSONAL_KNOWLEDGE_BASE.en.md) | [简体中文](PERSONAL_KNOWLEDGE_BASE.zh-CN.md)

个人知识库（PKB）支持上传文档，并在聊天中注入可追溯的检索片段。

## 支持格式

- `md`, `markdown`
- `txt`, `text`, `log`
- `json`, `csv`
- `docx`, `xlsx`, `pptx`

## 工作机制

1. 上传文档会被转换为 Markdown。
2. 内容与资源文件保存在本地。
3. Markdown 在本地切分为可检索分块。
4. 检索采用词法评分，可选关键词扩展。
5. 启用 **Personal KB** 后，高相关片段会注入提示词上下文。

## 检索特性

- 不依赖 embedding。
- 不依赖外部向量数据库。
- 结果仅来源于本地解析出的文档内容。

## 聊天中使用

启用 **Personal KB** 后：

- 系统先解析查询词
- 再在本地候选分块中排序
- 将高相关证据注入本轮对话上下文

