# DOCX Delivery Rules

Use this reference when creating, repairing, or auditing Word `.docx` bid output.

## When To Create DOCX

Create a Word file when:

- The user asks for `.docx` or Word output.
- The task is a full bid deliverable.
- The tender requires forms, layout, signatures, tables, headings, or embedded images that should be delivered as a document.

For simple text drafting, do not force Word output unless requested.

## Formatting Requirements

- Use real Word Heading styles with outline levels so headings appear in the navigation pane.
- Use a real TOC field for 目录, not a static typed list; the TOC and headings must appear in Word's navigation pane for final bid documents.
- Use automatic multilevel numbering for headings in final bid documents. Do not hand-type section numbers such as `1`, `1.1`, or `1.1.1` as plain heading text.
- Use paragraph `page_break_before` / 段前分页 for major section starts. Do not use manual page breaks for ordinary section separation.
- Remove blank pages before delivery.
- Body paragraphs use first-line indent of two Chinese characters and 1.5 line spacing.
- Tables should fill the available page width or AutoFit to the window.
- Tables and figures must use automatic captions for final Word output when the document tooling supports Word caption fields; if the tooling cannot create true automatic captions, state that limitation.

## Images In Word

- Insert actual image files, not placeholders.
- Preserve aspect ratio, especially for certificates, licenses, software copyright certificates, patents, authorization letters, product sheets, scans, and test reports.
- Keep images legible; do not shrink certificate scans below readable size.
- For final full-bid Word output, each substantial evidence image, certificate, authorization letter, product sheet, screenshot, scanned document, or generated figure must occupy its own page with its matching heading/short introduction and automatic caption. Do not place multiple substantial images on one page unless the tender explicitly requires a multi-image form.
- Start each substantial image block with paragraph `page_break_before` / 段前分页 on the image-hosting heading or paragraph, not a manual page break.
- Do not distort, crop, raster-compress, or shrink images below scan-style readability. Only proportional scaling to fit the printable page area is allowed.
- Place images under matching content headings in the body, not only as a generic appendix dump. If the tender explicitly requires attachment copies at the end, keep the body placement and add the required attachment copy or index only as an extra.

## Verification

Before final delivery of a full bid Word file:

1. Confirm the required part order appears; when the tender does not specify another order, confirm 商务/资信部分 comes before 技术部分 and 报价部分 comes last.
2. Confirm mandatory tables and forms are present.
3. Confirm images are embedded at mapped locations.
4. Confirm each substantial evidence image/figure is laid out as one image block per page with its matching heading/short introduction and automatic caption, unless the tender explicitly requires a multi-image form.
5. Confirm heading numbering is automatic and headings use real Word Heading styles.
6. Confirm the 目录 is a real TOC field and headings appear in Word's navigation pane.
7. Confirm no manual page breaks are used for ordinary section separation and no blank pages remain.
8. Confirm paragraphs use first-line indent of two Chinese characters and 1.5 line spacing.
9. Confirm tables fill the available page width or AutoFit to the window.
10. Confirm tables and figures have automatic captions, or state the tooling limitation.
11. Confirm no required field is silently left as `0`, `占位`, or vague `待填`.
12. If unable to inspect Word rendering directly, state the verification limitation.

## Reusable Generation Template

For full-bid DOCX generation with company material images, prefer
`scripts/create_docx_v2.py`. The template embeds evidence only through
section-to-image mapping and writes unmapped images to a JSON gap report.

Do not write ad hoc generation code that ends with an "append all remaining
images" step under a generic appendix or attachment heading. If an image cannot
be mapped to the body section it supports, leave it out of the DOCX and report
the unmapped item as a draft gap or blocker.

Image headings and captions must be section-specific bid prose. Do not write
`证据图片：<filename>`, `本页为与本节内容对应的企业资料证明图片：<path>`, or similar
internal workflow hints into the deliverable. Prefer the evidence subject or
the current response section, for example `H3C R4900 G2 服务器产品彩页`.
