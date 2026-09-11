---
name: article-writer
description: "Generate and rewrite high-quality article text (not layout) for reports, proposals, plans, or analysis before Word/PDF formatting. Enforce Request → Plan → Draft → Audit → Refine → Deliver for complex tasks; allow streamlined handling for simple requests."
category: document-processing
license: Proprietary
---

# Article content generation

## Scope

This skill controls **text content only**: topic understanding, section writing, detail depth, and final narrative quality.

Use this skill when users ask to write, rewrite, expand, or polish document text.

Do **not** use this skill for OOXML structure editing, Word styling, table rendering, PDF conversion, or page layout operations.

## Workflow

```
Request → Plan → Draft → Audit → Refine → Deliver
```

Language-process constraints (no script orchestration required):
- **Request:** Restate objective, audience, output type, and constraints before drafting.
- **Plan:** Build a clear section-level outline with intended depth for each section. Include subheadings when they improve structure and readability.
  Example (structure only):
  1. Background
     1.1 Current state
     1.2 Key pain points
  2. Objectives
  3. Proposed solution
     3.1 Core approach
     3.2 Implementation steps
  4. Risks and mitigations
  5. Expected outcomes and next steps
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
- **Output policy:** Only the **Deliver** stage content should be output to the user or written to files. All other stage notes are internal only and must not appear in the final output.
- **Structure fidelity:** The Deliver content must follow the section structure finalized in **Plan** (same order, headings, and subheadings). If the plan is adjusted during drafting, update it internally and keep the deliver structure aligned.

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
- **Reference count:** Technical articles targeting `informational` profile must include 10-15 authoritative references minimum. Fewer than 10 sources for complex technical topics indicates insufficient research depth. <!-- improving: IMP-004 -->

## Drafting requirements for generated content

- Start each section with a clear section purpose sentence, then expand with reasoning and evidence.
- For recommendations/proposals, include: current situation, problem analysis, proposed solution, implementation steps, risk control, expected outcomes.
- For plans, include: timeline, owner roles, milestones, and measurable acceptance criteria.
- For analytical content, include: claim, supporting facts, interpretation, and conclusion.
- Close longer documents with a concise summary and explicit next-step checklist.
- **No draft metadata sections:** Do not include "Image Notes", "Source Notes", "Implementation Notes", or similar author-facing metadata in the final deliverable. Such content belongs in author comments or separate documentation, not the published article. <!-- improving: IMP-001 -->

## Diagram and image anchor contract

When the request includes flowcharts/architecture diagrams or web-searched images intended for Word or Markdown output, include deterministic anchor markers in the generated text so downstream formatting can insert images at exact positions. **All flowcharts/architecture diagrams must be produced via the `diagram-generator-1.1.1` skill (do not generate diagrams directly in this skill).** Images are obtained via internet search.

Selection rule (web images):
- Web-searched image insertion is optional.
- If the user agrees to web images, include at least one image per major section and keep the total image count aligned with the number of Plan major sections unless they request a different density.
- Image queries must be derived from each section's summary or key points so the results are directly relevant to the section content.
- Before adding any `[[IMAGE:...]]` marker, the agent must ask the user whether internet-searched images should be inserted in the generated document.
- If the user declines, do not output any `[[IMAGE:...]]` markers.
- `[[IMAGE:...]]` is for real-world visuals (for example: 实物图、场景图、产品照片、设备照片), not flowcharts/architecture diagrams.

Rules:
- For Markdown output, insert images using an HTML block and size them to max width 480px or 70% of the container, whichever is smaller.
  Example:
  <div align="center">
    <img src="https://upload.wikimedia.org/wikipedia/commons/8/89/Knowledge_graph_management_system.png" alt="Architecture of the Vadalog Knowledge Graph Management System" style="max-width:480px; width:70%;" />
  </div>
- Use standalone marker lines only (no inline markers inside normal sentences).
- Marker format:
  - `[[DIAGRAM:diagram-id]]`
  - `[[DIAGRAM:diagram-id|title=Figure X: Description]]` (caption required for formal documents)
  - `[[IMAGE:image-id|query=检索关键词]]` (real-world internet image)
  - `[[IMAGE:image-id|query=检索关键词 |title=Figure X: Description]]` (real-world internet image, caption required for formal documents)
- Place the marker exactly where the figure should appear in the final document.
- Keep `diagram-id` / `image-id` stable and unique across the document.
- For `IMAGE` markers, `query` must be explicit and specific enough for downstream web search.
- **Caption enforcement:** Before Deliver, verify every figure marker has a `title=` attribute with formal caption format ("Figure 1: ...", "Figure 2: ..."). Informal captions or missing titles are draft failures. <!-- improving: IMP-002 -->
- If multiple figures are needed, output one marker per intended figure location.

## Writing Quality Checklist

Before finishing content generation, verify:
- The draft can be used immediately with minor edits (not just a framework).
- **Markdown markers resolved:** All `[[DIAGRAM:...]]` and `[[FIGURE:...]]` placeholders are either rendered as actual images in the output or removed. Raw marker syntax must not appear in the final deliverable. 
- Each section contains substantive explanation, not only headings or bullets.
- Added more subsections to the article to make it more comprehensive and detailed. <!-- improving: IMP-003 -->
- The document includes concrete details (examples, constraints, assumptions, or metrics).
- Tone and wording match the target audience (e.g., management, technical team, client, regulator).
- The conclusion includes clear decisions or next actions.
- Any uncertain or unverified factual detail is clearly labeled, not presented as confirmed fact.
