# Diagram Inserts for Documents

Use this reference when a document would be clearer with an inserted visual such as a flowchart, architecture diagram, network topology, sequence diagram, ER diagram, mind map, or design sketch.

For方案、详细设计、技术设计、实施方案、投标/汇报材料等正式交付文档，**do not generate Mermaid diagrams**. Use Draw.io as the diagram source format for every process, architecture, sequence, ER, topology, module dependency, and UI/design figure so the diagram can be manually refined and exported consistently for Word/PDF/PPTX.

## When to Add a Diagram

Add a diagram when prose alone makes relationships hard to scan:
- **Flowchart:** process steps, decisions, approvals, exception handling.
- **Architecture diagram:** systems, components, dependencies, interfaces, deployment layers.
- **Network topology:** environments, datacenters, zones, routers, switches, firewalls, servers, or cross-site links.
- **Sequence diagram:** time-ordered interactions between users, services, APIs, and data stores.
- **ER/class diagram:** structured entities, classes, fields, and relationships.
- **Mind map/design sketch:** conceptual grouping, ideation, product or UX structure.

Do not add a diagram only as decoration. Each diagram must explain a decision, relationship, process, or risk that the surrounding text depends on.

## Placement Rules

Place the figure directly after the paragraph where the concept is first explained. Use this pattern in the document draft:

```markdown
[Figure 1: <short title>]
Purpose: <what the reader should understand from this figure>.
Recommended format: drawio.
Caption: <one sentence caption for the final document>.
Source format: drawio.
Export format for insertion: <png|svg>.
Embedded asset path: <path to exported png/svg image that must be inserted into the final Word/PDF/PPTX>.
Diagram specification: <structured Draw.io JSON or concise generation brief>.
```

For a formal document, reference the figure in prose before the placeholder, for example: "The target architecture is shown in Figure 1." For a slide/PPT content draft, use "Visual:" or "Diagram:" under the relevant slide.

## Format Selection

- Use **Draw.io** for all formal document diagrams, including flowcharts, sequence diagrams, class diagrams, ER diagrams, mind maps, architecture diagrams, network topologies, UI wireframes, module dependency diagrams, and diagrams that will need manual refinement.
- Do **not** use Mermaid for formal方案/设计文档 deliverables. If an existing Mermaid diagram exists, convert or recreate it as Draw.io before final packaging.
- Use Excalidraw only when the user explicitly asks for a hand-drawn/whiteboard style; otherwise use Draw.io.

Network topology diagrams must use Draw.io because they often need nested containers such as environment -> datacenter -> zone -> device.

## Export Format for Insertion

Draw.io source files are editable diagram sources, not final embedded images. When planning a figure for Word, PDF, or PPTX, always state the intended export format and the exported image path:

- Use **PNG** for Word by default because it is the most compatible embedded image format.
- Use **SVG** when the diagram is mostly vector shapes/text and needs crisp scaling, especially for PPTX and modern Word workflows that support SVG.
- For Word, prefer PNG for broad compatibility and SVG only when the Office version and document library support it.
- For PPTX, prefer SVG for editable-looking, scalable diagrams; use PNG as a fallback.
- For PDF, either SVG or PNG can work as source assets before final PDF export; prefer SVG for line art and PNG for screenshots or raster visuals.

The final Word/PDF/PPTX deliverable is incomplete if it only contains diagram source paths or a diagram file list. Every required figure must be exported to PNG/SVG and embedded near the relevant section, with a caption.

## Export Completeness Rules

- Export image assets from the Draw.io source itself. Do not use a browser viewport screenshot, full-page screenshot, or temporary HTML/CSS redraw as the final document figure.
- If several PNG figures have identical browser-like dimensions such as `1910x915`, `1920x1080`, or `1366x768`, treat them as screenshot fallbacks and reject them for formal Word/PDF/PPTX output.
- Reject PNGs where visible diagram content touches the bottom or right image edge; this usually means the screenshot or export was clipped.
- Before packaging a formal document, validate exported assets:
  ```bash
  node resources/skills/work/diagram-generator-1.1.1/scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports --drawio-dir diagrams/drawio
  ```
- If the validator fails, regenerate the figure exports or mark the document output degraded/incomplete. Do not embed known-cropped images into Word/PDF/PPTX.

## Diagram Specification Contract

When the user asks for renderable diagram content, provide this compact Draw.io-oriented JSON shape:

```json
{
  "format": "drawio",
  "title": "Diagram title",
  "elements": [
    {
      "id": "unique-id",
      "type": "container|node|edge",
      "name": "Display name",
      "level": "environment|datacenter|zone|other",
      "deviceType": "router|switch|firewall|server|pc|database|cloud|other",
      "shape": "rect|rounded|diamond|parallelogram|cylinder|cloud|other",
      "geometry": {"x": 0, "y": 0, "width": 120, "height": 60},
      "children": []
    },
    {
      "id": "edge-1",
      "type": "edge",
      "source": "source-id",
      "target": "target-id",
      "label": "Connection label"
    }
  ]
}
```

Keep IDs unique and stable. Use descriptive prefixes such as `step-`, `svc-`, `db-`, `env-`, `zone-`, and `edge-`.

## Minimal Examples

Flowchart placeholder:

```markdown
[Figure 1: 用户登录流程]
Purpose: Show the normal login path and failed-authentication branch.
Recommended format: drawio.
Source format: drawio.
Export format for insertion: png.
Embedded asset path: diagrams/exports/01-user-login-flow.png
Caption: 用户登录流程包括凭证提交、身份校验、成功重定向和失败提示。
Diagram specification: Create a Draw.io flowchart with rounded start/end nodes, process nodes for credential input and page routing, a diamond decision node for identity verification, and labeled success/failure branches.
```

Architecture placeholder:

```markdown
[Figure 2: 目标系统架构]
Purpose: Show how client, API gateway, services, cache, database, and observability components interact.
Recommended format: drawio.
Source format: drawio.
Export format for insertion: png for Word; svg acceptable for PPTX.
Embedded asset path: diagrams/exports/02-target-architecture.png
Caption: 目标架构通过网关统一接入，核心服务分层部署，并通过监控链路支撑运行治理。
Diagram specification: Create containers for access layer, service layer, data layer, and operations layer; connect client -> gateway -> services -> cache/database; add monitoring links from services to observability.
```

## Audit Checklist

Before delivering the document:
- Every figure has a title, purpose, and caption.
- Every figure states both a source format and an export format for insertion.
- Every figure has an exported PNG/SVG asset path before final Word/PDF/PPTX packaging.
- Exported assets pass `validate_diagram_exports.mjs`; no viewport screenshot batch is used as formal figures.
- Final Word/PDF/PPTX output embeds the exported image itself, not only the Draw.io source path or a diagram inventory table.
- No Mermaid source files or Mermaid code blocks remain in formal方案/设计文档 deliverables; convert them to Draw.io.
- The text explains why the figure matters, not just what it contains.
- The figure appears close to the first relevant explanation.
- Diagram labels use the same terminology as the surrounding document.
- Technical diagrams avoid unverifiable infrastructure details unless clearly marked as assumptions.
