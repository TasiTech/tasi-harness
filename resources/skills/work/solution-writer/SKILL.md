---
name: solution-writer
description: "Generate, rewrite, expand, or polish high-quality document text for solutions, reports, proposals, plans, presentations, or analysis before Word/PDF/PPT formatting. Use for text-first deliverables that may need planned figure insertions, including flowcharts, architecture diagrams, topology diagrams, process diagrams, design sketches, data charts, and analytical visualizations. Enforce Request → Plan → Draft → Audit → Refine → Deliver for complex writing tasks; allow streamlined handling for simple text-only requests."
category: work
license: Proprietary
---

# Solution content generation

## Scope

This skill controls **document content and figure planning**: topic understanding, section writing, detail depth, final narrative quality, and where diagrams should appear in the document.

Use this skill when users ask to write, rewrite, expand, or polish document text. When diagrams would improve comprehension, include clear figure placeholders and diagram specifications in the document content. This skill does not directly edit binary Word/PDF/PPT files; use file-format skills for final document packaging.

## Workflow

```
Request → Plan → Draft → Audit → Refine → Deliver
```

Language-process constraints (no script orchestration required):
- **Request:** Restate objective, audience, output type, and constraints before drafting.
- **Plan:** Build a clear section-level outline with intended depth for each section.
- **Draft:** Produce a complete first draft (not skeleton bullets) following the plan.
- **Audit:** Check structure, factual consistency, clarity, actionability, and audience fit.
- **Refine:** Revise weak sections with concrete detail; remove repetition and vague claims.
- **Deliver:** Return a polished final version with clear conclusions and next actions when applicable.

Complexity gate (must decide before writing):
- Treat as **complex** when any of the following is true: multi-section deliverable, high-stakes audience, requested depth is standard/thorough, non-trivial constraints (policy/compliance/format/terminology), or requested length exceeds short memo scope.
- Treat as **simple** when the request is short, low-risk, single-purpose, and can be completed with one concise pass.

Execution rules:
- For **complex** tasks, follow all six stages in order and do not skip stages.
- For **simple** tasks, stage merging is allowed (for example, Request+Plan or Audit+Refine), but the output must still meet quality requirements.
- If information is missing, state assumptions explicitly and continue.
- Keep outputs substantive by default unless the user explicitly requests brevity.
- If the user asks for only one stage (for example, outline only), comply while preserving quality standards for that stage.
- Match the user's language by default unless they request another language.
- Do not fabricate specific facts, metrics, citations, or policy details; mark uncertain items clearly.
- When the document would benefit from a visual, plan the figure location during **Plan**, draft the surrounding explanation during **Draft**, and verify every figure has a purpose, title, and source/specification during **Audit**. See [diagram-inserts.md](references/diagram-inserts.md) for diagram placement rules and [data-chart-inserts.md](references/data-chart-inserts.md) for data chart planning rules.
- For formal方案/设计文档, require Draw.io diagram sources and exported PNG/SVG assets for all required design figures. Do not use Mermaid. The final document package is incomplete until exported images are embedded in the Word/PDF/PPTX body near their relevant sections.

## Content Quality Defaults (Critical)

When the user asks to create or rewrite document content and does **not** explicitly ask for brevity, generate a **substantive first draft** instead of skeletal outlines.

Required defaults:
- Prefer complete prose over bullet-only stubs.
- Each major section should contain at least 2-4 developed paragraphs unless the user requests a short memo format.
- Paragraphs should include concrete details: context, rationale, implications, and next actions (not generic filler).
- Add specific examples, scenarios, or mini case-style illustrations where appropriate.
- Use domain-appropriate terminology and define key concepts the first time they appear.

When key constraints are missing at request time, normalize inputs in this order:
- Must capture: objective, target audience, output type (report/proposal/plan/analysis), and depth expectation.
- Should capture when available: tone, section preferences, and hard constraints (length, compliance, terminology).
- If some items remain unknown, proceed with explicit assumptions instead of returning a shallow draft.

Anti-patterns to avoid:
- One-line section placeholders (for example: "TBD", "待补充", "略").
- Repeating high-level statements without evidence, explanation, or actionable detail.
- Ending after a high-level outline when the user asked for "write/generate/draft".

Length guidance (default baseline unless user specifies otherwise):
- Short practical document: 800-1200 Chinese characters (or 500-900 English words).
- Standard report/proposal: 1500-3000 Chinese characters (or 1000-2000 English words).
- For multi-section documents, keep section depth balanced; avoid one oversized section plus many thin sections.

## Drafting requirements for generated content

- Start each section with a clear section purpose sentence, then expand with reasoning and evidence.
- For recommendations/proposals, include: current situation, problem analysis, proposed solution, implementation steps, risk control, expected outcomes.
- For plans, include: timeline, owner roles, milestones, and measurable acceptance criteria.
- For analytical content, include: claim, supporting facts, interpretation, and conclusion.
- For visual-heavy documents, insert diagrams or data charts immediately after the paragraph that introduces the process, architecture, topology, design decision, metric trend, comparison, or analytical claim. Include a caption, source format, target export format (SVG/PNG), and, when useful, a compact specification block that downstream diagram/chart/file skills can render.
- For formal方案/设计文档 with diagrams, include an embedded asset path for each figure and require the downstream docx/pdf/pptx workflow to insert the exported image itself. A file list in the appendix is supplementary and never a substitute for embedded figures.
- Close longer documents with a concise summary and explicit next-step checklist.

## Writing Quality Checklist

Before finishing content generation, verify:
- The draft can be used immediately with minor edits (not just a framework).
- Each section contains substantive explanation, not only headings or bullets.
- The document includes concrete details (examples, constraints, assumptions, or metrics).
- Tone and wording match the target audience (e.g., management, technical team, client, regulator).
- The conclusion includes clear decisions or next actions.
- Visual deliverables include exported and embedded figure assets; no required diagram remains only as a source file, path, appendix inventory row, or Mermaid block.
- Any uncertain or unverified factual detail is clearly labeled, not presented as confirmed fact.
