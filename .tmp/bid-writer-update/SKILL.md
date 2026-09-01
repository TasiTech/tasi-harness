---
name: bid-writer
description: Write, revise, audit, or assemble Chinese bid/tender documents when the user provides tender requirements, scoring criteria, or bidder materials. Use a light path for single sections and a staged DOCX workflow only for full bid deliverables.
license: Proprietary
---

# Bid Writer

Use this skill for Chinese bid/tender work: 投标文件, 招标响应, 技术标, 商务标, 报价文件, 偏离表, 技术响应表, 标书润色, and compliance checks.

## First Decision

Classify the request before doing work:

- **Simple:** one section, one table, polishing, rewriting, extracting requirements, or answering a bid-writing question.
- **Focused:** one part of a bid, such as 技术方案, 商务响应, 偏离表, 报价说明, implementation plan, training plan, or after-sales plan.
- **Full bid:** a complete multi-part deliverable, especially when the user expects a final Word `.docx`.

Do not force the full four-stage workflow for simple or focused tasks. For those, answer directly using the provided tender/materials and clearly mark missing facts.

## Source Boundary

Write factual claims only from the current tender/招标文件, tender announcement/招标公告, scoring criteria/评分标准, user-provided company materials/企业资料, or files the user explicitly asks you to use.

Do not invent qualifications, cases, software copyrights, patents, prices, personnel, certificate numbers, dates, product parameters, authorization letters, or contract facts. If required data appears missing, search the available company material library first; only after the search is attempted may you use a specific marker such as `[待补充：报价金额]` or report the blocker.

Do not use another bidder's or a competitor bid's data as a factual source. Copying tender text is acceptable; copying another bidder's facts (著作权/业绩/人员/价格/企业主体/产品参数) must be marked `[待替换：来源]`, not presented as the bidder's own facts.

For each key fact (著作权/业绩/人员/价格/企业主体/产品参数), tag its source: `[来源：企业资料]` / `[来源：招标]` / `[待补充]`. A final bid must not present competitor-copied facts as the bidder's own.

## Material Search Before Placeholders

When a required bid fact, price, certificate, screenshot, authorization, product parameter, case, personnel record, seal/signature page, or company identity field is missing, do not immediately write `[待补充]`.

First search accessible company materials and any user-provided material paths. If the user mentioned an enterprise material library/企业资料库, treat it as the primary evidence source. Also check common local tender workspaces when accessible, such as `企业资料库`, `招投标`, `company materials`, `materials`, and the current workspace.

Use layered search before marking a blocker:

- Search filenames and folders for project, company, product, vendor, certificate, quotation, authorization, contract, screenshot, and personnel keywords.
- Search readable document text with targeted keywords from the tender requirement, scoring item, product name/model, certificate type, and required form field.
- For image/PDF-only materials, inventory the files by path and filename, then use available OCR/conversion/inspection tools when practical before declaring the content unreadable.
- Cross-check found facts against the tender requirement before inserting them; do not fill a field only because a vaguely similar file exists.

Record search evidence in the checkpoint for full bids: material paths checked, keywords or categories searched, files found, facts extracted, and items still missing. A placeholder or `Blocked` status is valid only when this search has been attempted or the user has confirmed the material is unavailable.

**Material assembly completeness rule:** When the company material library contains N matching items (e.g., 14 software copyrights, 14 personnel certificates, 10 contracts), take ALL N items, not a subset. Do not stop at 5/14 or 9/14. Record the total found count and the total embedded count. If the embedded count < found count, list the gap as a blocker.

**Evidence embedding rule:** Certificates, reports, contracts, color pages, and other evidence must be embedded in the matching body section, not only in an appendix. Count required evidence vs embedded evidence per section. If a section's evidence coverage is <80%, list the gap as a blocker.

## Hard Document Rules

For full bid documents, unless the tender explicitly requires a different order, organize major parts as 商务/资信部分, then 技术部分, then 报价部分. If the tender specifies another order, follow the tender exactly and record that order in the checkpoint.

If the tender provides required formats, forms, tables, column order, signatures, seals, or numbering expectations, reproduce those formats first. Do not invent a cleaner or more attractive structure.

Final Word bid documents must use automatic heading numbering, real Word Heading styles, and a real TOC field so the table of contents and headings appear in Word's navigation pane. Do not hand-type section numbers for final `.docx` output.

Use paragraph `page_break_before` / 段前分页 for major section starts instead of manual page breaks. Final Word output must not contain blank pages. Body paragraphs use first-line indent of two Chinese characters and 1.5 line spacing. Tables must use real Word tables that fill the available page width or AutoFit to the window. Tables and figures must have automatic captions when final Word output is required.

Place company material screenshots, certificates, product sheets, diagrams, and generated screenshots inline in the matching body section. Do not place them only in a generic appendix or attachment section. Preserve image aspect ratio and scan-style legibility.

For final full-bid Word output, each substantial evidence image, certificate, authorization letter, product sheet, screenshot, scanned document, or generated figure must occupy its own page with its matching heading/short introduction and automatic caption. Use paragraph `page_break_before` / 段前分页 on the image-hosting heading or paragraph to start the image block on a new page. Do not put multiple substantial images on one page unless the tender explicitly requires a multi-image form. Do not distort, crop, raster-compress, or shrink images below scan-style readability; only proportional scaling to fit the printable page area is allowed.

Equipment lists must include 投标产品内容, brand/model, specifications, quantity, and price fields required by the tender. Technical response tables must respond row by row with substantive bidder/product facts, not only `符合` or copied tender text. Implementation, training, after-sales, acceptance, and other plans must contain substantive responses tied to tender requirements and scoring items.

For full bid documents, the 项目实施人员 / 项目团队 / 人员一览表 section must include matching evidence screenshots or scanned copies for each claimed person when available or required by the tender: qualification certificates, professional certificates, ID/authorization materials, labor contract, social-security proof, appointment documents, or other personnel evidence. Place these screenshots in the body under the corresponding personnel/team subsection, not only in an appendix. If personnel evidence is missing, search the company material library first and record the search trail before marking it as a draft gap or blocker.

If the tender requires hardware/product manufacturer authorization, treat the authorization response and evidence as a primary rejection-risk item. Do not deliver a final full bid without resolving or explicitly reporting that blocker.

## Lightweight Workflow

For simple or focused requests:

1. Identify the tender requirement or scoring item being answered.
2. Extract only the relevant source facts.
3. Draft the requested text/table in the tender's wording style and order.
4. Run a short self-check for missing requirements, factual uncertainty, and starred/mandatory clauses.
5. Deliver the requested content in the user's requested format. Create `.docx` only if the user asks for a Word file or the task is a full bid deliverable.

## Reference Compliance

When a condition in Reference Routing or a stage-specific note matches the current task, read the referenced file before doing that part of the work. Loaded reference instructions are binding for that task stage, not optional background.

For full bid work, read both [references/full-bid-workflow.md](references/full-bid-workflow.md) and [references/bid-writer-process-rules.md](references/bid-writer-process-rules.md) before drafting. For final merge or compliance review, read [references/audit-checklist.md](references/audit-checklist.md) before delivery.

Read only the references relevant to the current task stage. Do not load archived or unrelated reference files unless the user explicitly asks to investigate legacy behavior.

If references overlap, use this priority:

1. This `SKILL.md`.
2. The user's explicit current request.
3. The stage-specific reference for the current work.
4. General process guidance.

## Full Bid Workflow

For full bid generation, use the staged workflow and checkpoint discipline in [references/full-bid-workflow.md](references/full-bid-workflow.md), and use the interpretation, generation-planning, stage-check, and anti-loop rules in [references/bid-writer-process-rules.md](references/bid-writer-process-rules.md).

Before drafting a full bid:

- Read the tender outline/format requirements and lock the required part order.
- Create or update a checkpoint file in the workspace.
- Build a compact tender interpretation once; on "继续" turns read the checkpoint first and avoid re-reading the entire tender unless a specific section is missing.
- Use the tender's required structure over any generic two-part or three-part template.

## Script Helpers

For full bid work, prefer the deterministic helper scripts in [references/script-helpers.md](references/script-helpers.md) when local Python is available. Use them as control and verification artifacts, not as substitutes for reading the tender or writing the bid.

- Run `scripts/inventory_materials.py` before drafting or before marking any required fact, evidence image, certificate, personnel proof, authorization, quotation, or product parameter as missing.
- Run `scripts/extract_tender_text.py` before tender interpretation when the tender source is `.docx`, `.doc`, `.pdf`, `.txt`, `.md`, or a directory containing those files.
- Run `scripts/create_bid_checkpoint.py` after tender extraction and material inventory to create the initial checkpoint for full bid work.
- Run `scripts/validate_bid_package.py` before final full-bid delivery when a `.docx` or Markdown package is produced.

If a helper script is unavailable or fails, record the failure in the checkpoint and complete an equivalent manual check before final delivery. Do not label a full bid as `Final delivery` without either script validation or recorded equivalent validation evidence.

## Word And Assets

Use the `docx` skill or `python-docx` only when a Word file is required. For Word-specific rules, read [references/docx-delivery.md](references/docx-delivery.md).

For full-bid DOCX generation with company material images, prefer `scripts/create_docx_v2.py`. Do not create ad hoc scripts that append all remaining enterprise material images under a generic appendix/attachment section. Unmapped images must be reported in an unmapped-image gap report instead of being dumped into `附录：企业资料图片`.

Evidence image headings and captions must read like bid content, not file-management notes. Use section-specific titles such as `H3C R4900 G2 服务器产品彩页` or `软件著作权证书：广告视频发现方法及装置`; never emit generic boilerplate such as `证据图片：<filename>` or `本页为与本节内容对应的企业资料证明图片：<path>`.

For images, screenshots, diagrams, certificates, product sheets, and generated figures, read [references/visual-assets.md](references/visual-assets.md) only when the current task requires visual assets or a full bid package.

## Audit

For a full bid, final merge, or explicit compliance review, read [references/audit-checklist.md](references/audit-checklist.md). Treat it as the final delivery audit. Keep audits proportional for simple tasks.

When a benchmark or competitor bid is provided and the user asks for comparison, use `bid-comparison-evaluation` if available.

## Completeness Gate (P0 — blocks delivery)
Before presenting any full bid as final, enforce this gate. If any item fails, do not present as final — either fix it or deliver a degraded draft with the failure clearly stated.

1. **No [待补充] in critical scoring items.** 投标总价/报价明细/开标一览/政策功能项 must not be `[待补充]`, `0`, or `占位`. If price is missing, explicitly mark "价格分无法计算，此稿不可作为有效投标" and do not present as a viable submission.
2. **Scoring-aware depth.** Map each 评分标准 item to a section. High-weight items (≥10 points) must have proportionate depth: ≥3 developed paragraphs + at least one concrete example, table, or figure. Do not leave high-weight items as a single overview paragraph.
3. **Evidence coverage.** Count required evidence items (certificates, reports, contracts, color pages) vs embedded evidence items. If coverage is <80%, list the gap as a blocker. Do not silently leave `[待补充]` in evidence sections.
4. **Material assembly completeness.** Before any `[待补充]`, search the company material library and record the search trail (searched paths, found items, not-found items). Do not leave `[待补充]` without a recorded search trail.
5. **4-stage completion.** The 4-stage workflow (目录大纲 → 模板 → 逐部分生成 → 综合合并) must complete all stages. Do not stop at the skeleton/outline stage and present it as a final deliverable. If a stage cannot complete, report the blocker and deliver a degraded draft with the incomplete stages listed.

## Delivery Contract

For full bid `.docx` work, there are only three valid delivery statuses:

- **Final delivery:** all tender-required formats, section order, mandatory/starred/rejection-risk items, scoring responses, quotation fields, source facts, evidence images, Word structure, TOC/navigation pane, automatic numbering, captions, and final audit checks are completed or verified.
- **Draft delivery:** a document was generated but any required field, evidence item, formatting requirement, source fact, quotation value, product parameter, authorization, screenshot, or audit item remains missing, unverified, placeholder-filled, or dependent on human completion.
- **Blocked:** required source material, evidence, authorization, pricing, product facts, tender text, or document tooling is unavailable, and the missing item prevents a compliant final bid.

Never label a full bid as `complete`, `final`, `已完成`, or `可正式交付` when the answer, checkpoint, generated document, or audit still contains unresolved placeholders, missing evidence, unverified facts, pending Word structure work, or rejection-risk blockers. In that case, either continue fixing the deliverable or explicitly label it as a draft/blocked result and list the remaining blockers.

Before finalizing a full bid, the final answer must state the delivery status as `Final delivery`, `Draft delivery`, or `Blocked`, and the status must match the audit evidence.

## Reference Routing

- `references/bid-writer-process-rules.md`: read for full bids, tender interpretation, section generation planning, and stage-level checks.
- `references/full-bid-workflow.md`: read for full bid generation and continuation/checkpoint work.
- `references/script-helpers.md`: read when using or interpreting bid-writer helper scripts.
- `references/docx-delivery.md`: read before creating or repairing `.docx` output.
- `references/visual-assets.md`: read when figures, screenshots, certificates, or embedded images are required.
- `references/audit-checklist.md`: read before final full-bid delivery or when auditing a bid.

If a referenced skill or tool is unavailable, do not loop on it. Use available local files and tools, state the degraded path, and ask for the missing material only when it blocks the requested deliverable.
