---
name: diagram-generator-1.1.1
description: Generate and edit Draw.io-first diagrams for formal documents, reports, proposals, design documents, and implementation plans. Use Draw.io for flowcharts, sequence diagrams, class diagrams, Entity-Relationship (ER) diagrams, mind maps, architecture diagrams, UI wireframes, module dependency diagrams, and network topologies. Do not generate Mermaid for formal方案/设计文档; convert any existing Mermaid content into Draw.io diagrams and export PNG/SVG assets for insertion into Word/PDF/PPTX.
category: local
Natural Language Creation: Create new diagrams based on simple text descriptions.
Legacy File Support: Read and modify existing .drawio files; treat .mmd (Mermaid) or Excalidraw files as legacy inputs that should be converted/recreated as Draw.io for formal deliverables.
MCP Server Integration: Utilizes a dedicated MCP server (mcp-diagram-generator) to generate files, which minimizes token consumption and ensures consistent output formatting.
Automated Configuration: * Default Output Path: Diagrams are saved to diagrams/{format}/ within the project directory.
Customization: Supports custom file paths and automatic directory creation.
---

# Diagram Generator

## Overview

Generate and edit diagrams as Draw.io-first assets by creating structured JSON descriptions and delegating file generation to the mcp-diagram-generator MCP server. For formal方案/设计文档, do not create Mermaid output; generate Draw.io sources and exported PNG/SVG images that can be embedded into Word/PDF/PPTX.

> **Contact Information** If you encounter any issues, please contact **AlkaidY** at [tccio2023@gmail.com](mailto:tccio2023@gmail.com).

## Prerequisites Check

**IMPORTANT**: This skill requires the `mcp-diagram-generator` MCP server to be installed and configured.

### Quick Verification

Before using this skill, verify the MCP server is available by checking if you can access these tools:
- `mcp__mcp-diagram-generator__get_config`
- `mcp__mcp-diagram-generator__generate_diagram`
- `mcp__mcp-diagram-generator__init_config`

If these tools are **NOT available**, you need to configure the MCP server first (see below).

### Installation & Configuration

**Option 1: Using npx (Recommended - Auto-downloads the package)**

Add the following to your Claude Code configuration file:

- **Global config** (`~/.claude.json`) for all projects, or
- **Project config** (`.claude.json`) for specific project

```json
{
  "mcpServers": {
    "mcp-diagram-generator": {
      "command": "npx",
      "args": ["-y", "mcp-diagram-generator"]
    }
  }
}
```

After adding this configuration:
1. Restart Claude Code
2. The MCP server will auto-download via npx on first use
3. No manual installation needed

**Option 2: Local Development (For developers)**

If you're developing the MCP server locally:

```json
{
  "mcpServers": {
    "mcp-diagram-generator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-diagram-generator/dist/index.js"]
    }
  }
}
```

### Verification Steps

After configuration, verify it works:

1. Check configuration: Call `get_config()` tool
2. If successful, you'll see current paths and initialization status
3. If the tool doesn't exist, check your configuration file syntax

### Common Issues

**Issue**: "Tool not found" error
- **Solution**: MCP server not configured. Follow installation steps above.

**Issue**: Configuration looks correct but tools still not available
- **Solution**: Restart Claude Code to reload MCP server configuration

## Quick Start

### First Time Use

On first use, the MCP server will automatically:
1. Create default configuration file (`.diagram-config.json`)
2. Create default output directories if they don't exist
3. Use sensible defaults: `diagrams/{format}/`

You can customize paths at any time using the `init_config` tool.

### Basic Usage

**Simple example** - just provide diagram spec, let the server handle the rest:

```
User: "创建一个网络拓扑图"
```

Skill will:
1. Generate JSON spec
2. Call `generate_diagram` with only `diagram_spec` parameter
3. Server auto-creates directories and saves to `diagrams/{format}/{title}-{date}.{ext}`

## Workflow

### Step 1: Understand Requirements

Extract from user's natural language:
- **Diagram type**: flowchart, sequence diagram, class diagram, ER diagram, mindmap, architecture diagram, network topology
- **Content**: nodes, relationships, nested structure (for network topology)
- **Style/theme**: if mentioned (e.g., "clean style", "detailed")
- **Output preferences**: specific filename? custom path?

### Step 2: Choose Format

Use Draw.io by default for formal document diagrams. Use [format-selection-guide.md](references/format-selection-guide.md) only to understand legacy/source-format tradeoffs; formal deliverables should still be converted to Draw.io.

| Format | Best For |
|--------|----------|
| **drawio** | Formal document diagrams, complex diagrams, flowcharts, sequence diagrams, ER diagrams, UI wireframes, network topology with nested containers, fine-grained styling, manual editing |
| **mermaid** | Legacy/input only for formal documents; convert to Draw.io before delivery |
| **excalidraw** | Informal sketches only when explicitly requested; convert to Draw.io for formal delivery |

### Step 3: Generate Structured JSON

Create a JSON description following the [JSON Schema](references/json-schema-guide.md). Key structure:

```json
{
  "format": "drawio",
  "title": "diagram name",
  "elements": [
    {
      "id": "unique-id",
      "type": "container|node|edge",
      "name": "display name",
      "level": "environment|datacenter|zone|device", // for network topology
      "style": {...},
      "geometry": {...},
      "children": [...] // for nested containers
    }
  ]
}
```

**Important**: Use unique IDs for all elements. For nested structures, maintain parent-child relationships.

### Step 4: Call MCP Server

**Option A: Use defaults (recommended)**

```json
{
  "diagram_spec": <the JSON object created above>
  // output_path is optional - server will use configured default
  // filename is optional - server will auto-generate based on title and date
}
```

The MCP server will:
- Validate the JSON schema
- Generate the appropriate XML/JSON/markdown
- Auto-create output directories if needed
- Save to configured default path (e.g., `diagrams/drawio/network-topology-2025-02-03.drawio`)

### Step 4.5: Export Embed-Ready Image Assets

For formal方案/设计文档, Word/PDF/PPTX, or any request that asks for a complete document with figures, a `.drawio` source file alone is not enough.

After generating each Draw.io source:
- Export an embed-ready **PNG** for Word compatibility by default.
- Export **SVG** when the downstream PPTX/modern Word workflow supports SVG and crisp scaling is preferred.
- Record both paths:
  - Source: `diagrams/drawio/<name>.drawio`
  - Embedded asset: `diagrams/exports/<name>.png` or `.svg`
- Use a real Draw.io/diagrams.net export path whenever possible, for example a desktop/CLI export (`drawio -x -f png -s 2 -o diagrams/exports/name.png diagrams/drawio/name.drawio`) or an equivalent app export. Do not substitute a browser viewport screenshot.
- SVG exports must come from Draw.io/diagrams.net or a faithful renderer of the Draw.io source. Do not hand-recreate Draw.io diagrams as standalone SVG; manual SVG redraws often miss connectors, arrowheads, waypoints, grouped shapes, or labels.
- If the `.drawio` source contains `edge="1"` cells, the exported SVG must include connector primitives such as `<path>`, `<line>`, or `<polyline>`. A matching SVG with only rectangles/text is incomplete and must be regenerated from Draw.io.
- When a PNG must be derived from an exported Draw.io SVG, render the SVG file with a real SVG renderer instead of taking a browser screenshot. Use the SVG `viewBox`/canvas as the export bounds, preserve aspect ratio, and add padding if visible content touches an edge.
  - Preferred tools: `drawio -x -f png ...` directly from `.drawio`; otherwise `inkscape input.svg --export-type=png --export-filename=output.png`, `rsvg-convert input.svg -o output.png`, or an equivalent SVG renderer such as Sharp/resvg.
  - Do not use Playwright/browser viewport screenshots, whole-page screenshots, scroll-position screenshots, or temporary HTML render pages as PNG exports.
  - If SVG uses external images/fonts/styles, inline or resolve them before rendering; missing dependencies can produce incomplete PNGs.
- If the available tools cannot export PNG/SVG from the Draw.io source, report the output as degraded/incomplete and tell the document-generation step that the figure cannot yet be embedded.
- After export, validate assets before passing them to docx/pdf/pptx:
  ```bash
  node resources/skills/work/diagram-generator-1.1.1/scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports --drawio-dir diagrams/drawio
  ```

### SVG-to-PNG Completeness Workflow

Use this only when the downstream workflow requires PNG. Keep SVG as the source of truth.

1. Export SVG from the Draw.io source using Draw.io/diagrams.net export, not by redrawing in HTML.
2. Inspect the SVG root:
   - It should have a `viewBox`.
   - If the source `.drawio` has `edge="1"` cells, the SVG should contain connector primitives (`<path>`, `<line>`, or `<polyline>`). If not, the SVG is missing connectors.
   - The viewBox should include the full diagram plus safe padding for strokes, arrows, labels, and shadows.
   - Do not crop to a browser viewport or a visible editor canvas.
3. Render the SVG with a file renderer:
   ```bash
   inkscape diagrams/exports/name.svg --export-type=png --export-filename=diagrams/exports/name.png
   ```
   or:
   ```bash
   rsvg-convert diagrams/exports/name.svg -o diagrams/exports/name.png
   ```
4. Validate the PNG:
   ```bash
   node resources/skills/work/diagram-generator-1.1.1/scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports --drawio-dir diagrams/drawio
   ```
5. If validation reports identical viewport-sized PNGs, blank/near-blank content, or visible content touching any export edge, treat the PNG as incomplete. Regenerate from the SVG/Draw.io export with larger bounds or padding; do not patch it with a screenshot.

**Option B: Specify custom path**

```json
{
  "diagram_spec": <the JSON object>,
  "output_path": "custom/path/to/diagram.drawio",
  "filename": "my-custom-name" // optional, overrides auto-generated filename
}
```

**Option C: Just provide filename, use default directory**

```json
{
  "diagram_spec": <the JSON object>,
  "filename": "my-diagram.drawio"
  // Saves to diagrams/{format}/my-diagram.drawio
}
```

### Step 5: Editing Existing Diagrams

1. **Read the existing file** to understand structure
2. **Parse** the diagram (use MCP tool if available, or read raw file)
3. **Modify** the JSON description based on user's change request
4. **Generate** new diagram (overwrite or create new file)

## Configuration Management

### Initialize Configuration

**Initialize with defaults:**
```
Call: init_config()
Result: Creates .diagram-config.json with default paths
```

**Initialize with custom paths:**
```
Call: init_config({
  paths: {
    drawio: "output/diagrams/drawio",
    exports: "output/diagrams/exports"
  }
})
```

### View Current Configuration

```
Call: get_config()
Returns: Current paths and initialization status
```

### Update Single Path

```
Call: set_output_path({
  format: "drawio",
  path: "custom/drawio-path"
})
```

## Supported Diagram Types

### Flowchart
- Simple process flows, decision trees
- Use **drawio** for all formal document outputs, including simple and complex flows

### Sequence Diagram
- Show interactions over time between components
- Use **drawio** for formal document outputs and recreate lifelines/messages as editable Draw.io elements

### Class Diagram
- Show classes, methods, relationships
- Use **drawio** for formal document outputs, including UML-style classes and relationships

### ER Diagram
- Database schema, entity relationships
- Use **drawio** for formal document outputs, including simple and complex schemas

### Mindmap
- Hierarchical ideas, brainstorming
- Use **drawio** for formal document outputs; use Excalidraw only when the user explicitly asks for hand-drawn style

### Architecture Diagram
- System architecture, component relationships
- **drawio** recommended for complex systems
- Use **drawio** for high-level overviews too when the diagram will be included in a formal document

### Network Topology
- Network environments, datacenters, zones, devices
- **Must use drawio** (4-layer nesting: environment → datacenter → zone → device)
- See [network-topology-examples.md](references/network-topology-examples.md) for patterns

## Network Topology Special Notes

Network topology diagrams require a 4-level hierarchical structure:

```
Environment (level="environment")
  └── Datacenter (level="datacenter")
        └── Zone (level="zone")
              └── Device (type="node")
```

**Style conventions**:
- **Environment**: `fillColor: #e1d5e7`, `strokeColor: #9673a6` (purple)
- **Datacenter**: `fillColor: #d5e8d4`, `strokeColor: #82b366` (green)
- **Zone**: `fillColor: #fff2cc`, `strokeColor: #d6b656` (yellow)
- **Device**: Based on device type (router, switch, firewall, etc.)

**Device types and styles**:
- Router: `strokeColor: #607D8B` (blue-gray)
- Switch: `strokeColor: #4CAF50` (green)
- Firewall: `strokeColor: #F44336` (red)
- PC/Server: `strokeColor: #607D8B` (blue-gray)

## Common Patterns

### Pattern 1: Simple Flowchart (Draw.io)

User: "画一个用户登录流程图，包含登录验证、重定向、错误处理"

Generate Draw.io JSON:
```json
{
  "format": "drawio",
  "title": "用户登录流程",
  "elements": [
    {"type": "node", "id": "start", "name": "开始", "geometry": {"x": 0, "y": 0}},
    {"type": "node", "id": "login", "name": "输入用户名密码", "geometry": {"x": 0, "y": 100}},
    {"type": "node", "id": "validate", "name": "验证", "geometry": {"x": 0, "y": 200}},
    {"type": "node", "id": "success", "name": "登录成功", "geometry": {"x": -100, "y": 300}},
    {"type": "node", "id": "error", "name": "显示错误", "geometry": {"x": 100, "y": 300}},
    {"type": "edge", "source": "start", "target": "login"},
    {"type": "edge", "source": "login", "target": "validate"},
    {"type": "edge", "source": "validate", "target": "success", "label": "成功"},
    {"type": "edge", "source": "validate", "target": "error", "label": "失败"}
  ]
}
```

Call MCP:
```
generate_diagram({
  diagram_spec: <above JSON>,
  format: "drawio"
  // No output_path needed - auto-saves to diagrams/drawio/
})
```

### Pattern 2: Network Topology (Drawio)

User: "创建一个网络拓扑图，包含省中心机房（上联区、汇聚区、终端区），连接到生产网"

Generate JSON with nested containers (see [json-schema-guide.md](references/json-schema-guide.md) for details).

Call MCP:
```
generate_diagram({
  diagram_spec: <network topology JSON>,
  filename: "省中心网络拓扑" // Optional, for custom filename
})
```

## Resources

### references/
- **format-selection-guide.md**: Draw.io-first guidance and legacy format conversion notes
- **json-schema-guide.md**: Complete JSON schema with examples for all diagram types
- **network-topology-examples.md**: Example JSON for network topology patterns

### assets/
- No templates needed - MCP server handles all generation

### scripts/
- Not used - all generation delegated to MCP server

## Troubleshooting

### MCP Server Setup

If `mcp-diagram-generator` is not available, you need to install it.

**Option 1: Using npx (Recommended)**

Add to your Claude Code/OpenCode settings:

```json
{
  "mcpServers": {
    "diagram-generator": {
      "command": "npx",
      "args": ["-y", "mcp-diagram-generator"]
    }
  }
}
```

**Option 2: Local Development**

1. Install dependencies: `cd mcp-diagram-generator && npm install`
2. Build: `npm run build`
3. Configure with local path:
```json
{
  "mcpServers": {
    "diagram-generator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-diagram-generator/dist/index.js"]
    }
  }
}
```

### Invalid JSON Schema

If MCP server returns validation error:
1. Check [json-schema-guide.md](references/json-schema-guide.md)
2. Verify all required fields are present
3. Ensure all IDs are unique
4. Check parent-child relationships

### Directory Not Found

**Old behavior**: Error if directory doesn't exist
**New behavior**: Directory is created automatically ✅

If you still see directory errors:
1. Check write permissions for the project directory
2. Verify configuration with `get_config()`
3. Reinitialize with `init_config()`

### Wrong File Extension

The server automatically uses the correct extension based on format:
- drawio → `.drawio`
- mermaid → legacy `.md` input only; convert/recreate as `.drawio` for formal deliverables
- excalidraw → legacy/informal `.excalidraw` input only; convert/recreate as `.drawio` for formal deliverables

You don't need to specify extension in filename parameter.

### Nested Container Issues (Network Topology)

- Verify `level` field matches hierarchy (environment/datacenter/zone)
- Check `parent` IDs are correct in child elements
- Ensure geometry coordinates are relative to parent container

## Best Practices

### 1. Use Default Paths

Let the server manage output paths for consistency:

```json
{
  "diagram_spec": <spec>
  // Don't specify output_path unless necessary
}
```

### 2. Provide Descriptive Titles

Titles are used for auto-generated filenames:

```json
{
  "title": "生产环境网络拓扑-亦庄与西五环",
  // Generates: 生产环境网络拓扑-亦庄与西五环-2025-02-03.drawio
}
```

### 3. Use Configuration for Custom Paths

Instead of specifying output_path every time, configure once:

```
First time: init_config({ paths: { drawio: "custom/path" } })
After that: Just use generate_diagram() without output_path
```

### 4. Check Configuration When Troubleshooting

```
get_config() // Shows all paths and status
```

## Completion Gate for Document Workflows

Before claiming a方案/设计文档 with diagrams is complete:
- Every required diagram uses `format: "drawio"`.
- No Mermaid output is created for the formal deliverable.
- Every `.drawio` source has a corresponding exported PNG/SVG asset.
- Exported PNG/SVG assets are produced by Draw.io export, not by full-page or viewport browser screenshots.
- The downstream docx/pdf/pptx workflow receives the exported image paths, not only the `.drawio` paths.
- If a Word document is generated, verify that each required figure is embedded in the body near its referenced section; an appendix file list alone is not sufficient.
- Every `.drawio` file opens in diagrams.net/draw.io without import errors. Validate generated sources with:
  ```bash
  node resources/skills/work/diagram-generator-1.1.1/scripts/validate_drawio.mjs diagrams/drawio
  ```
- Every exported image passes the export validator:
  ```bash
  node resources/skills/work/diagram-generator-1.1.1/scripts/validate_diagram_exports.mjs --asset-dir diagrams/exports --drawio-dir diagrams/drawio
  ```
- If multiple PNG files have the same browser-like dimensions (for example `1910x915`, `1920x1080`, `1366x768`), the image is blank/near-blank, or visible content touches any export edge, treat the exported images as incomplete until regenerated from Draw.io/SVG with proper bounds.
- If a Draw.io source has `edge="1"` connectors but the matching SVG has no `<path>`, `<line>`, or `<polyline>` connector primitives, treat the SVG as incomplete. Regenerate it with Draw.io/diagrams.net export; do not patch by hand unless every source edge is intentionally and visibly represented.

## Prohibited Export Fallbacks

- Do not create HTML/CSS redraws of Draw.io diagrams and screenshot those pages as final document figures.
- Do not manually redraw a Draw.io diagram into plain SVG for formal export; this commonly drops connectors and arrow geometry.
- Do not use `browser_screenshot` of the whole page or current viewport as a formal diagram export.
- Do not export PNG from SVG by screenshotting a browser tab. Use a real SVG renderer with the SVG viewBox as the export bounds.
- Do not embed PNGs generated from a partially visible browser window, a zoomed editor canvas, or a local render page unless the screenshot is an element-level capture with verified full bounds and passes `validate_diagram_exports.mjs`.
- Do not claim a Word/PDF/PPTX document is complete when diagram assets are screenshot fallbacks or cropped images.

## Draw.io XML Compatibility Rules

- Use `<mxGeometry ... as="geometry" />` for mxCell geometry. Never generate `asGeometry="true"`.
- For explicit edge endpoints inside geometry, use `<mxPoint ... as="sourcePoint" />` and `<mxPoint ... as="targetPoint" />`. Never generate `asPoint="true"` or `asGeometry="true"` on `mxPoint`.
- If using intermediate waypoints, place them inside `<Array as="points">...</Array>` and do not mark them as geometry.
- If diagrams.net reports `Could not add object for mxGeometry`, inspect the source for legacy `asGeometry`/`asPoint` attributes first.
- Save editable `.drawio` XML as UTF-8 without BOM and include `<?xml version="1.0" encoding="UTF-8"?>` at the top. PowerShell `Set-Content -Encoding UTF8` on Windows PowerShell can add a BOM; prefer Node `fs.writeFileSync(path, text, "utf8")` or .NET `UTF8Encoding(false)`.
- If diagrams.net reports `Invalid file data`, check for BOM or a missing XML declaration before changing diagram content.
