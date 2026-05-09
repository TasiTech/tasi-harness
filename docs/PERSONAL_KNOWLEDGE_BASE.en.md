# Personal Knowledge Base

[English](PERSONAL_KNOWLEDGE_BASE.en.md) | [简体中文](PERSONAL_KNOWLEDGE_BASE.zh-CN.md)

The Personal Knowledge Base (PKB) lets you upload documents and retrieve grounded snippets during chat.

## Supported File Types

- `md`, `markdown`
- `txt`, `text`, `log`
- `json`, `csv`
- `docx`, `xlsx`, `pptx`
- `pdf`
- `ofd`

## How It Works

1. Uploaded files are converted to Markdown; PDF and OFD use best-effort text extraction.
2. Content and assets are stored locally.
3. Markdown is split into local chunks.
4. Retrieval uses lexical scoring, optionally with query expansion.
5. Top snippets are injected into chat prompts when **Personal KB** is enabled.

## Retrieval Behavior

- No embeddings required.
- No external vector database required.
- Results are grounded in local parsed content only.

## Usage in Chat

When **Personal KB** is enabled in Chat:

- the query is analyzed for search terms
- candidate chunks are ranked locally
- top evidence is added to the model prompt context
