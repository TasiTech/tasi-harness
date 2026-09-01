# Full Bid Workflow

Use this reference only for complete bid/tender deliverables or continuation work on an existing full bid.

## Scripted Preflight

When local Python is available, use the helper scripts before drafting a full bid:

1. Run `scripts/inventory_materials.py` on the accessible company material library and tender workspace. Use the resulting `materials_inventory.json` to count all candidate certificates, screenshots, contracts, software copyrights, personnel evidence, authorization files, quotation files, and product sheets before deciding that anything is missing.
2. Run `scripts/extract_tender_text.py` on the tender file or tender directory. Inspect the extracted Markdown before locking the tender-required order, forms, starred/mandatory clauses, rejection-risk items, and scoring map.
3. Run `scripts/create_bid_checkpoint.py` from the tender signal JSON and material inventory JSON. Treat the generated checkpoint as the starting control ledger, then manually enrich it with exact tender formats, scoring mappings, and evidence placement decisions.

If any script cannot run or cannot parse the source, write that failure and the manual replacement check into the checkpoint. A script failure is not permission to skip source extraction, material search, or final validation.

## Checkpoint Discipline

Create one checkpoint file in the workspace, named like `checkpoint_<项目名>.md`. Update it after each stage or completed section.

The checkpoint should contain:

- Project basics, package/scope, purchaser/agency, deadline, budget or ceiling price.
- Tender-required part order, section outline, forms, tables, signatures/seals, and attachment positions.
- Qualification thresholds, mandatory clauses, starred clauses, rejection risks, and scoring criteria.
- Technical parameters, implementation/service/training/acceptance requirements, commercial and contract terms.
- Image/material inventory and target section mapping.
- Script output paths and validation status: tender extraction, material inventory, checkpoint creation, and final delivery validation.
- Company material search log: material library paths checked, filename/text keywords searched, evidence files found, facts extracted, and unresolved items.
- Project implementation personnel evidence map: claimed personnel, role, certificate/evidence type, source file path, and target body section.
- Progress checklist with each section marked `todo`, `doing`, `done`, or `reviewed`.
- Stage file paths already produced.

On "继续" turns:

1. Read the checkpoint first.
2. Continue from the first unfinished or unreviewed item.
3. Do not re-read the whole raw tender unless the checkpoint lacks a specific needed clause.
4. Do not rewrite completed sections unless the user asks or audit found a concrete defect.

## Staged Workflow For Full Bids

Use four stages for full bid generation:

1. **目录大纲:** mirror the tender-required part order, section names, forms, tables, and mandatory/starred/scoring mappings. Search the available company material library and map found evidence files to target sections before deciding that facts are missing.
2. **模板:** create the tender-required Word-ready structure first, with heading levels, table placeholders, image positions, captions, and required forms. If the tender lacks a complete outline, use `references/bid-template.md` as a reference-only module library, then adapt or delete modules until the skeleton matches the current tender.
3. **逐部分生成内容:** fill each section from tender requirements and company materials; maintain the checkpoint after each section. For every `[待补充]`, `[待核实]`, placeholder, or blocker, confirm the relevant company-material search was attempted and recorded.
4. **综合合并:** assemble the final `.docx`, run `scripts/validate_bid_package.py` when available, then run the audit checklist before delivery.

Do not skip stages for a full bid unless the user explicitly asks for a partial or rough deliverable. If you take a degraded path, say so clearly.

## Structure Rules

- The tender's required structure always wins over generic templates.
- `references/bid-template.md` is a fallback module library, not deliverable text. Do not copy its frontmatter, usage notes, template variables, evidence-slot markers, or non-deliverable guidance into the final bid.
- If the tender does not explicitly define a different major-part order, use 商务/资信部分 -> 技术部分 -> 报价部分. If the tender defines another order, follow the tender exactly and record the exception in the checkpoint.
- Preserve part order, form names, table columns, signature/seal requirements, and numbering expectations from the tender. If the tender defines a format, use that format rather than creating a new one.
- Map each scoring item and mandatory/starred clause to a response section.
- For high-score sections, write deeper and include concrete evidence; for low-score formal sections, be concise but complete.

## Common Bid Sections

Commercial/资信 content often includes bid letter, opening summary, quotation forms, authorization, business license, bid deposit proof, qualifications, similar projects, team/personnel, company profile, tax/social-security/audit/credit proofs, after-sales commitments, and declarations.

Technical content often includes requirement analysis, overall design, function design, hardware/software selection, equipment list, technical response table, technical deviation table, interface/integration plan, implementation plan, quality assurance, training, after-sales, acceptance, risk/difficulty handling, and appendices required by the tender.

Quotation content must stay consistent with equipment lists, deviation tables, and tender budget constraints.
