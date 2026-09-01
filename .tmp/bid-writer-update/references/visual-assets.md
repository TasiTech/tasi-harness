# Visual Assets For Bid Documents

Use this reference when the task requires screenshots, diagrams, certificates, product sheets, or embedded images.

## Asset Inventory

Before full bid drafting, scan the company materials directory and build an inventory:

- Business license, qualifications, certificates, ISO, software copyrights, patents.
- Product sheets, manuals, test reports, inspection reports, authorization letters.
- Similar-project contracts, acceptance reports, project implementation personnel certificates, ID/authorization materials, labor contracts, social-security proof, appointment documents, and other personnel evidence screenshots/scans.
- Software screenshots, system screens, portals, dashboards, monitoring pages.
- Existing architecture, network, deployment, process, data-flow, or interface diagrams.

Map each asset to a target section. Use real source images before generated assets.

## Generated Diagrams And Screenshots

Generate visual assets only when they are required by the tender, scoring criteria, a full bid package, or the user. Do not force visual generation for simple text-only requests.

If available, use:

- `diagram-generator-1.1.1` for architecture, topology, process, ER, deployment, data-flow, and interface diagrams.
- `ui-ux-pro-max` for UI prototypes and interface screenshots.

If a referenced skill/tool is unavailable, use an available local method or mark the missing asset as a blocker. Do not repeatedly retry the same unavailable tool.

## Placement Rules

- Put each image near the section it supports.
- Use a matching subheading and a short intro paragraph before important figures.
- Place company material screenshots, certificates, product sheets, diagrams, and generated screenshots inline in the matching body section. Do not place them only in a generic 附件, 附录, or "附图" section.
- Name figure pages with the evidence subject or matching response section, for example `H3C R4900 G2 服务器产品彩页`, `KVM 切换器产品彩页`, or `软件著作权证书：广告视频发现方法及装置`. Do not use `证据图片：<filename>`, `本页为与本节内容对应的企业资料证明图片：<path>`, or other internal workflow hints as visible bid text.
- Project implementation personnel evidence screenshots/scans must be placed in the 项目实施人员 / 项目团队 / 人员一览表 body section under the matching person, role, or certificate subheading. Do not leave personnel evidence only in attachments.
- Do not group unrelated screenshots under one generic "附图" heading unless the tender template explicitly requires that layout.
- Preserve original aspect ratio and scan-style legibility for certificates, product sheets, authorization letters, and test reports.
- For final full-bid Word output, each substantial evidence image, certificate, authorization letter, product sheet, screenshot, scanned document, or generated figure must occupy its own page with its matching heading/short introduction and automatic caption. Start the image block with paragraph `page_break_before` / 段前分页. Do not put multiple substantial images on one page unless the tender explicitly requires a multi-image form.
- Do not distort, crop, raster-compress, or shrink images below scan-style readability. Only proportional scaling to fit the printable page area is allowed.
- For scoring-critical sections, prefer concrete screenshots/diagrams over abstract prose.
- When creating full-bid DOCX output, use `scripts/create_docx_v2.py` or preserve its invariant in custom code: embed mapped evidence in body sections and write unmapped images to a gap report. Do not create a generic `附录：企业资料图片`, attachment dump, or "remaining images" section as a fallback.

## Missing Assets

If a required asset is missing:

- Use `[待补充：具体图片/证书名称]` for drafts.
- For full final delivery, report the missing asset as a blocker unless the user explicitly accepts a degraded draft.
