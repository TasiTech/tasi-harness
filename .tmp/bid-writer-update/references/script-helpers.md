# Script Helpers

Use these scripts as deterministic helpers for full bid work. They do not write
the bid narrative; they create evidence that prevents skipped sources, missing
images, false completion claims, and unverified final delivery.

Run scripts from the skill directory or reference them by absolute path.

## Material Inventory

```bash
python scripts/inventory_materials.py --materials "<企业资料库>" --tender "<招标文件目录>" --out "<workspace>/materials_inventory.json"
```

Use before drafting a full bid or before leaving any field as missing. The JSON
lists every file, category, image count, and missing root. Put the inventory path
and key counts in the checkpoint.

## Tender Text Extraction

```bash
python scripts/extract_tender_text.py "<招标文件或目录>" --out-md "<workspace>/tender_text.md" --out-json "<workspace>/tender_signals.json"
```

Use when the tender is a `.docx`, `.doc`, `.pdf`, `.txt`, or `.md` file. `.docx`
is supported directly. `.doc` requires LibreOffice conversion. `.pdf` requires
`pypdf`/`PyPDF2` or a separate OCR/conversion step.

The JSON signal file is only a starting point. Inspect the extracted text before
locking tender order, formats, starred clauses, rejection risks, and scoring
items.

## Checkpoint Creation

```bash
python scripts/create_bid_checkpoint.py --tender-json "<workspace>/tender_signals.json" --materials-json "<workspace>/materials_inventory.json" --project-name "<项目名>" --package "<分标>" --out "<workspace>/checkpoint_<项目名>.md"
```

Use after extraction/inventory and before drafting. The checkpoint is the run's
control ledger: document order, required formats, scoring/mandatory mappings,
evidence image map, and remaining missing items.

## Delivery Validation

```bash
python scripts/validate_bid_package.py --docx "<生成的投标文件.docx>" --materials-json "<workspace>/materials_inventory.json" --out "<workspace>/validation_report.json"
```

Use before final full-bid delivery. If the script returns `BLOCKED` or `DRAFT`,
do not call the deliverable final. Fix the issues or report the exact degraded
status.

The validator checks observable structure only: placeholders, real Word heading
styles, real TOC field, manual page breaks, tables, embedded images, image count
against the material inventory, and a page-break-before heuristic for dedicated
image pages. It does not replace manual procurement review or tender-specific
legal judgment.

## DOCX Generation With Evidence Images

Use the reusable DOCX template instead of writing one-off Python that dumps company material images into an appendix:

```bash
python scripts/create_docx_v2.py --markdown "<workspace>/bid.md" --out "<workspace>/bid.docx" --materials-json "<workspace>/materials_inventory.json" --asset-map "<workspace>/asset_map.json" --unmapped-report "<workspace>/unmapped_images.json"
```

The template only embeds images that can be mapped to matching body sections. It does **not** create a generic appendix such as "附录：企业资料图片". Unmapped images are written to the unmapped report and must be mapped to a body section, omitted with a reason, or reported as a Draft/Blocked gap.

For full-bid Word output, do not create replacement scripts that add all remaining images under a generic appendix or attachment heading. If custom generation code is needed, preserve the same invariant: body-section image mapping first, no appendix dump fallback.
