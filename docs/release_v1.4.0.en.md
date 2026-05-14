# Tasi Harness 1.4.0 Release Notes

[English](release_v1.4.0.en.md) | [简体中文](release_v1.4.0.zh-CN.md)

Release date: 2026-05-14

## Highlights

1. Added streaming output: chat replies can now appear while they are being generated, reducing wait time for long answers, long tool runs, and command-line conversations.
2. Expanded multimodal input: for models that support multimodal capabilities, Tasi Harness now supports image and video input for screenshot analysis, image understanding, video material review, and media-grounded Q&A.
3. Added image-and-text document writing: the app can organize text, images, and document material into richer report-style outputs, including plans, explanations, summaries, and structured drafts.
4. Added a UI design skill: bundled UI design guidance helps with product interfaces, webpages, dashboards, interaction design, and implementation-oriented design reasoning.
5. Added skill optimization: the app can analyze session results and failure signals, then improve targeted skill workflows for more stable repeated task execution.
6. Enhanced WeChat conversations: WeChat chat now supports document upload, image upload, and returning generated files to the user, making mobile-side document processing and file delivery easier.

## Use Cases

- Long writing, research summaries, and code explanations can show progress sooner through streaming output.
- Image, video, and document inputs can be handled together in multimodal conversations.
- Report-style outputs can combine text, tables, images, and structured sections.
- UI/UX design, page redesign, and product prototype tasks can use the UI design skill for more consistent design guidance.
- Frequently reused automation workflows can be improved through skill optimization.
- WeChat can support lightweight office workflows such as receiving files, analyzing images, generating documents, and sending files back.

## Compatibility Notes

- Image and video input depend on whether the selected model provider supports the required multimodal capability; text-only models continue to behave as text chat models.
- Image-and-text document writing and file return depend on available file tools, export tools, and WeChat connection status.
- Skill optimization is designed to keep changes scoped to the relevant skill instead of broadening unrelated workflows.

## Archive

- Previous release: `docs/release_v1.3.0.en.md` and `docs/release_v1.3.0.zh-CN.md`.
