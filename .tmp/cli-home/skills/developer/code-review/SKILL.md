---
name: code-review
description: Review local code changes using file tools and optional terminal commands, then produce an actionable summary.
category: developer
---

# Code Review

Use this skill when asked to review a local project, inspect source files, or summarize risks in a patch.

## Workflow

1. Use `file_list` to understand the workspace structure.
2. Read the smallest relevant files with `file_read`.
3. When terminal is enabled, run focused commands such as `git diff --stat`, `npm test`, or language-specific checks.
4. Report correctness bugs first, then security, reliability, maintainability, and style.
5. Include exact file paths and concise suggested fixes.
