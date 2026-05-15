---
name: docx
description: "Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. When agent needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"
category: document-processing
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of a .docx file. A .docx file is essentially a ZIP archive containing XML files and other resources that you can read or edit. You have different tools and workflows available for different tasks.

## Content Quality Defaults (Critical)

When the user asks to create or rewrite document content and does **not** explicitly ask for brevity, generate a **substantive first draft** instead of skeletal outlines.

Required defaults:
- Prefer complete prose over bullet-only stubs.
- Each major section should contain at least 2-4 developed paragraphs unless the user requests a short memo format.
- Paragraphs should include concrete details: context, rationale, implications, and next actions (not generic filler).
- Add specific examples, scenarios, or mini case-style illustrations where appropriate.
- Use domain-appropriate terminology and define key concepts the first time they appear.
- If requirements are ambiguous, state reasonable assumptions in the document and continue with a complete draft.

Anti-patterns to avoid:
- One-line section placeholders (for example: "TBD", "待补充", "略").
- Repeating high-level statements without evidence, explanation, or actionable detail.
- Ending after a high-level outline when the user asked for "write/generate/draft".

Length guidance (default baseline unless user specifies otherwise):
- Short practical document: 800-1200 Chinese characters (or 500-900 English words).
- Standard report/proposal: 1500-3000 Chinese characters (or 1000-2000 English words).
- For multi-section documents, keep section depth balanced; avoid one oversized section plus many thin sections.

## Workflow Decision Tree

### Reading/Analyzing Content
Use "Text extraction" or "Raw XML access" sections below

### Creating New Document
Use "Creating a new Word document" workflow

### Editing Existing Document
- **Your own document + simple changes**
  Use "Basic OOXML editing" workflow

- **Someone else's document**
  Use **"Redlining workflow"** (recommended default)

- **Legal, academic, business, or government docs**
  Use **"Redlining workflow"** (required)

## Reading and analyzing content

### Text extraction
If you just need to read the text contents of a document, you should convert the document to markdown using pandoc. Pandoc provides excellent support for preserving document structure and can show tracked changes:

```bash
# Convert document to markdown with tracked changes
pandoc --track-changes=all path-to-file.docx -o output.md
# Options: --track-changes=accept/reject/all
```

### Raw XML access
You need raw XML access for: comments, complex formatting, document structure, embedded media, and metadata. For any of these features, you'll need to unpack a document and read its raw XML contents.

#### Unpacking a file
`python ooxml/scripts/unpack.py <office_file> <output_directory>`

#### Key file structures
* `word/document.xml` - Main document contents
* `word/comments.xml` - Comments referenced in document.xml
* `word/media/` - Embedded images and media files
* Tracked changes use `<w:ins>` (insertions) and `<w:del>` (deletions) tags

## Creating a new Word document

When creating a new Word document from scratch, use **docx-js**, which allows you to create Word documents using JavaScript/TypeScript.

### Workflow
1. **MANDATORY - READ ENTIRE FILE**: Read [`docx-js.md`](docx-js.md) (~500 lines) completely from start to finish. **NEVER set any range limits when reading this file.** Read the full file content for detailed syntax, critical formatting rules, and best practices before proceeding with document creation.
2. Draft rich source content first (full sections, complete paragraphs, concrete details, and examples) based on the "Content Quality Defaults" above.
3. If the source content includes figures, diagrams, screenshots, chart placeholders, or generated assets, **embed the exported image files in the document body** at the relevant locations using `ImageRun` (docx-js) or OOXML image relationships. Do not merely list asset paths in an appendix. A Word document is incomplete if required figures are not embedded near the sections that reference them.
   - For Draw.io diagrams, use assets exported from the `.drawio` source, not browser viewport screenshots or temporary HTML redraw screenshots.
   - Prefer SVG for vector diagrams and illustrations. If an SVG asset exists, embed the SVG directly in the `.docx`; do not convert it to PNG solely for Word insertion.
   - Use PNG/JPG only when the original asset is raster, when the user explicitly requests raster output, or when a target viewer/library requires a compatibility fallback. If a fallback PNG is needed from Draw.io SVG, render the SVG with Draw.io/diagrams.net export, Inkscape, rsvg-convert, Sharp, or resvg using the SVG viewBox/full canvas bounds; never use browser viewport screenshots or temporary HTML screenshots.
   - Before embedding diagram PNG/SVG files, run:
     ```bash
     node resources/skills/work/diagram-generator-1.1.1/scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports --drawio-dir diagrams/drawio
     ```
     If the images fail validation, regenerate them or mark the document degraded/incomplete.
4. Create a JavaScript/TypeScript file using Document, Paragraph, TextRun, ImageRun, and related components (You can assume all dependencies are installed, but if not, refer to the dependencies section below)
5. Export as .docx using Packer.toBuffer()
6. Run the DOCX openability validator before delivery:
   ```bash
   node resources/skills/work/docx/scripts/validate_docx.mjs --input output.docx
   ```
   Treat any `ok: false` result as a failed document. The validator checks package readability, required parts, XML well-formedness, direct body runs, bare page breaks, duplicate drawing ids, unqualified Word XML tags such as `<text>`, broken relationship targets, missing image relationships, and invalid embedded image signatures.
   If it reports repairable structural issues such as bare page-break runs, duplicate drawing ids, or bare page-number tags, repair and recheck:
   ```bash
   node resources/skills/work/docx/scripts/validate_docx.mjs --input output.docx --repair-output output.repaired.docx
   node resources/skills/work/docx/scripts/validate_docx.mjs --input output.repaired.docx
   ```
7. For the final file, run at least one openability smoke test when available: Word COM open/save on Windows, or LibreOffice headless conversion/re-save. If no GUI/headless office is available, explicitly say static validation passed but live Word opening was not available.
8. Verify figure completeness: every required figure mentioned in the source has an exported SVG/PNG/JPG asset, an embedded image in the `.docx`, and a nearby caption. For vector diagrams, prefer the SVG asset directly and do not rasterize it unless fallback compatibility is required. If an image asset is missing, cropped, screenshot-derived, or cannot be embedded, explicitly report a degraded/incomplete output instead of claiming the document is complete.

### Openability gate for generated DOCX

Before delivering a generated Word file, follow this gate:
- Generate the `.docx`.
- Validate it with `scripts/validate_docx.mjs`.
- If validation fails and repair is available, write a repaired copy, validate the repaired copy, and deliver only the passing file.
- If validation still fails, do not claim the Word file is complete; report the failing issue codes.
- Prefer a live open smoke test after static validation when Word or LibreOffice is available.

Common failures this gate must catch:
- Duplicate `wp:docPr` / `pic:cNvPr` ids from repeated image runs.
- Bare run-level objects directly under `w:body`, including standalone `PageBreak`.
- Broken internal `.rels` targets or missing image parts.
- Invalid PNG/JPEG/SVG signatures.
- Bare, unqualified tags inside `word/*.xml`, especially `<text>PAGE</text>` from incorrect page-number generation.
- Page numbers must use docx-js field constants such as `PageNumber.CURRENT` and `PageNumber.TOTAL_PAGES`, not `{ text: "PAGE" }` or `{ text: "NUMPAGES" }`.
- Vector figures should stay SVG in the DOCX; do not convert SVG diagrams to PNG merely to insert them.

### Drafting requirements for generated content
- Start each section with a clear section purpose sentence, then expand with reasoning and evidence.
- For recommendations/proposals, include: current situation, problem analysis, proposed solution, implementation steps, risk control, expected outcomes.
- For plans, include: timeline, owner roles, milestones, and measurable acceptance criteria.
- For analytical content, include: claim, supporting facts, interpretation, and conclusion.
- For documents with required diagrams or charts, embed the exported image asset immediately after the paragraph that introduces it, then add a caption. Prefer SVG assets directly for vector diagrams. Keep any appendix file list only as a secondary inventory.
- Close longer documents with a concise summary and explicit next-step checklist.

## Editing an existing Word document

When editing an existing Word document, use the **Document library** (a Python library for OOXML manipulation). The library automatically handles infrastructure setup and provides methods for document manipulation. For complex scenarios, you can access the underlying DOM directly through the library.

### Workflow
1. **MANDATORY - READ ENTIRE FILE**: Read [`ooxml.md`](ooxml.md) (~600 lines) completely from start to finish. **NEVER set any range limits when reading this file.** Read the full file content for the Document library API and XML patterns for directly editing document files.
2. Unpack the document: `python ooxml/scripts/unpack.py <office_file> <output_directory>`
3. Create and run a Python script using the Document library (see "Document Library" section in ooxml.md)
4. Pack the final document: `python ooxml/scripts/pack.py <input_directory> <office_file>`

The Document library provides both high-level methods for common operations and direct DOM access for complex scenarios.

## Redlining workflow for document review

This workflow allows you to plan comprehensive tracked changes using markdown before implementing them in OOXML. **CRITICAL**: For complete tracked changes, you must implement ALL changes systematically.

**Batching Strategy**: Group related changes into batches of 3-10 changes. This makes debugging manageable while maintaining efficiency. Test each batch before moving to the next.

**Principle: Minimal, Precise Edits**
When implementing tracked changes, only mark text that actually changes. Repeating unchanged text makes edits harder to review and appears unprofessional. Break replacements into: [unchanged text] + [deletion] + [insertion] + [unchanged text]. Preserve the original run's RSID for unchanged text by extracting the `<w:r>` element from the original and reusing it.

Example - Changing "30 days" to "60 days" in a sentence:
```python
# BAD - Replaces entire sentence
'<w:del><w:r><w:delText>The term is 30 days.</w:delText></w:r></w:del><w:ins><w:r><w:t>The term is 60 days.</w:t></w:r></w:ins>'

# GOOD - Only marks what changed, preserves original <w:r> for unchanged text
'<w:r w:rsidR="00AB12CD"><w:t>The term is </w:t></w:r><w:del><w:r><w:delText>30</w:delText></w:r></w:del><w:ins><w:r><w:t>60</w:t></w:r></w:ins><w:r w:rsidR="00AB12CD"><w:t> days.</w:t></w:r>'
```

### Tracked changes workflow

1. **Get markdown representation**: Convert document to markdown with tracked changes preserved:
   ```bash
   pandoc --track-changes=all path-to-file.docx -o current.md
   ```

2. **Identify and group changes**: Review the document and identify ALL changes needed, organizing them into logical batches:

   **Location methods** (for finding changes in XML):
   - Section/heading numbers (e.g., "Section 3.2", "Article IV")
   - Paragraph identifiers if numbered
   - Grep patterns with unique surrounding text
   - Document structure (e.g., "first paragraph", "signature block")
   - **DO NOT use markdown line numbers** - they don't map to XML structure

   **Batch organization** (group 3-10 related changes per batch):
   - By section: "Batch 1: Section 2 amendments", "Batch 2: Section 5 updates"
   - By type: "Batch 1: Date corrections", "Batch 2: Party name changes"
   - By complexity: Start with simple text replacements, then tackle complex structural changes
   - Sequential: "Batch 1: Pages 1-3", "Batch 2: Pages 4-6"

3. **Read documentation and unpack**:
   - **MANDATORY - READ ENTIRE FILE**: Read [`ooxml.md`](ooxml.md) (~600 lines) completely from start to finish. **NEVER set any range limits when reading this file.** Pay special attention to the "Document Library" and "Tracked Change Patterns" sections.
   - **Unpack the document**: `python ooxml/scripts/unpack.py <file.docx> <dir>`
   - **Note the suggested RSID**: The unpack script will suggest an RSID to use for your tracked changes. Copy this RSID for use in step 4b.

4. **Implement changes in batches**: Group changes logically (by section, by type, or by proximity) and implement them together in a single script. This approach:
   - Makes debugging easier (smaller batch = easier to isolate errors)
   - Allows incremental progress
   - Maintains efficiency (batch size of 3-10 changes works well)

   **Suggested batch groupings:**
   - By document section (e.g., "Section 3 changes", "Definitions", "Termination clause")
   - By change type (e.g., "Date changes", "Party name updates", "Legal term replacements")
   - By proximity (e.g., "Changes on pages 1-3", "Changes in first half of document")

   For each batch of related changes:

   **a. Map text to XML**: Grep for text in `word/document.xml` to verify how text is split across `<w:r>` elements.

   **b. Create and run script**: Use `get_node` to find nodes, implement changes, then `doc.save()`. See **"Document Library"** section in ooxml.md for patterns.

   **Note**: Always grep `word/document.xml` immediately before writing a script to get current line numbers and verify text content. Line numbers change after each script run.

5. **Pack the document**: After all batches are complete, convert the unpacked directory back to .docx:
   ```bash
   python ooxml/scripts/pack.py unpacked reviewed-document.docx
   ```

6. **Final verification**: Do a comprehensive check of the complete document:
   - Convert final document to markdown:
     ```bash
     pandoc --track-changes=all reviewed-document.docx -o verification.md
     ```
   - Verify ALL changes were applied correctly:
     ```bash
     grep "original phrase" verification.md  # Should NOT find it
     grep "replacement phrase" verification.md  # Should find it
     ```
   - Check that no unintended changes were introduced


## Converting Documents to Images

To visually analyze Word documents, convert them to images using a two-step process:

1. **Convert DOCX to PDF**:
   ```bash
   soffice --headless --convert-to pdf document.docx
   ```

2. **Convert PDF pages to JPEG images**:
   ```bash
   pdftoppm -jpeg -r 150 document.pdf page
   ```
   This creates files like `page-1.jpg`, `page-2.jpg`, etc.

Options:
- `-r 150`: Sets resolution to 150 DPI (adjust for quality/size balance)
- `-jpeg`: Output JPEG format (use `-png` for PNG if preferred)
- `-f N`: First page to convert (e.g., `-f 2` starts from page 2)
- `-l N`: Last page to convert (e.g., `-l 5` stops at page 5)
- `page`: Prefix for output files

Example for specific range:
```bash
pdftoppm -jpeg -r 150 -f 2 -l 5 document.pdf page  # Converts only pages 2-5
```

## Code Style Guidelines
**IMPORTANT**: When generating code for DOCX operations:
- Write concise code
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

## Writing Quality Checklist

Before finishing document generation, verify:
- The draft can be used immediately with minor edits (not just a framework).
- Each section contains substantive explanation, not only headings or bullets.
- The document includes concrete details (examples, constraints, assumptions, or metrics).
- Tone and wording match the target audience (e.g., management, technical team, client, regulator).
- The conclusion includes clear decisions or next actions.
- The generated `.docx` passes `scripts/validate_docx.mjs` with no error issues. Do not deliver a Word file that contains direct `w:r` nodes under `w:body`, bare page-break runs, broken relationships, unqualified Word XML tags, invalid embedded image signatures, duplicate drawing ids, or malformed page-number fields.

## Dependencies

Required dependencies (install if not available):

- **pandoc**: `sudo apt-get install pandoc` (for text extraction)
- **docx**: `npm install -g docx` (for creating new documents)
- **LibreOffice**: `sudo apt-get install libreoffice` (for PDF conversion)
- **Poppler**: `sudo apt-get install poppler-utils` (for pdftoppm to convert PDF to images)
- **defusedxml**: `pip install defusedxml` (for secure XML parsing)
