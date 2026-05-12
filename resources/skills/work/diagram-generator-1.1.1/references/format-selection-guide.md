# Format Selection Guide

Choose the right diagram format based on your needs. For formal方案、详细设计、技术设计、实施方案、报告、Word/PDF/PPTX deliverables, use **Draw.io** as the final diagram source format. Do not deliver Mermaid diagrams in formal documents; convert or recreate them as Draw.io and export PNG/SVG for insertion.

## Quick Decision Matrix

| Factor | Draw.io | Mermaid | Excalidraw |
|--------|---------|---------|------------|
| **Learning curve** | Low | Low | Low |
| **Quick generation** | Medium | High (legacy/source only) | Medium |
| **Manual editing** | **Excellent** (GUI) | Code-based | Good (GUI) |
| **Version control** | XML (verbose) | Markdown (clean, but not final for formal docs) | JSON |
| **Code documentation** | Medium | Good for source docs, not final formal docs | Poor |
| **Complex nesting** | **Excellent** | Poor | Good |
| **Custom styling** | **Excellent** | Limited | Good |
| **Hand-drawn style** | No | No | **Yes** |
| **Export options** | PDF, PNG, SVG, etc. | PNG, SVG | PNG, SVG, JSON |

## When to Use Draw.io

### Ideal For:
- **Formal Word/PDF/PPTX deliverables** that need embedded, manually refinable figures
- **方案、详细设计、技术设计、实施方案、投标/汇报材料**
- **Flowcharts, sequence diagrams, class diagrams, ER diagrams, mind maps, UI wireframes, module dependency diagrams**
- **Network topology diagrams** with nested environments/datacenters/zones
- **Complex architecture diagrams** with many layers
- **Diagrams requiring fine-grained control** over positioning and styling
- **Professional technical diagrams** for documentation
- **Diagrams that need manual refinement** after generation

### Examples:
- Enterprise network topology (environments → datacenters → zones → devices)
- Microservices architecture with many components
- System diagrams with custom icons and layouts
- Production infrastructure maps

### Strengths:
- Best-in-class nested container support (swimlanes)
- Powerful GUI editor for fine-tuning
- Export to multiple formats (PDF, PNG, SVG)
- Large library of pre-built shapes and icons
- Supports multiple pages in one file

### Weaknesses:
- XML format is verbose (larger files)
- Not ideal for quick iterations
- Manual positioning can be time-consuming

---

## Legacy Mermaid Inputs

### Use Only For:
- **Legacy input** that must be converted to Draw.io for formal documents
- **Code repository documentation** only when the final deliverable is Markdown/README, not Word/PDF/PPTX
- **Quick rough drafts** that will be recreated as Draw.io before delivery

### Examples:
- User authentication flow
- API sequence diagram
- Class diagram for a module
- ER diagram for a database
- Git workflow visualization

### Strengths:
- Text-based, easy to version control
- Can be embedded in Markdown
- Renders in GitHub, GitLab, many markdown editors
- Compact syntax
- Good support for UML diagrams (class, sequence, state, activity)

### Weaknesses:
- Not acceptable as the final diagram source for formal方案/设计文档 in this skill.
- Limited styling options
- Poor support for complex nesting
- Layout is auto-generated (less control)
- No GUI editor (must edit code)

---

## When to Use Excalidraw

### Ideal For:
- **Hand-drawn / informal diagrams**
- **Brainstorming sessions** and mindmaps
- **Creative diagrams** with custom freeform elements
- **Informal presentations** that feel more human

### Examples:
- Whiteboard-style architecture sketches
- Meeting notes with diagrams
- Brainstorming mindmaps
- Informal process flows
- Wireframes (basic)

### Strengths:
- Unique hand-drawn aesthetic
- Freeform drawing capability
- Excellent for creative/brainstorming scenarios
- Can embed in web pages (ExcalidrawEmbed)
- Good sharing and collaboration features

### Weaknesses:
- Not ideal for precise technical diagrams
- JSON format is verbose and hard to edit manually
- Limited support for complex relationships
- Less standard in technical documentation

---

## Decision Tree

```
Start
  │
  ├─ Formal Word/PDF/PPTX/方案/设计文档 deliverable?
  │   └─ Yes → Draw.io
  │   └─ No → Continue
  │
  ├─ Existing Mermaid source?
  │   └─ Yes → Convert/recreate as Draw.io for formal delivery
  │   └─ No → Continue
  │
  ├─ Explicitly requested hand-drawn style?
  │   └─ Yes → Excalidraw draft, then convert to Draw.io if formal delivery
  │   └─ No → Draw.io
```

## Format Comparison by Diagram Type

| Diagram Type | Recommended | Alternative |
|--------------|--------------|-------------|
| Simple Flowchart | **Draw.io** | Legacy Mermaid source must be converted |
| Complex Flowchart (10+ nodes) | **Draw.io** | - |
| Sequence Diagram | **Draw.io** | Legacy Mermaid source must be converted |
| Class Diagram | **Draw.io** | Legacy Mermaid source must be converted |
| ER Diagram | **Draw.io** | Legacy Mermaid source must be converted |
| Mindmap | **Draw.io** | Excalidraw only for explicitly informal style |
| Network Topology | **Draw.io** (required) | - |
| System Architecture | **Draw.io** | - |
| Whiteboard Sketch | **Excalidraw** | Draw.io (formal) |
| Brainstorming | **Excalidraw** | Draw.io when the result enters a formal deliverable |

## Migration Considerations

### Mermaid → Draw.io
- Import or recreate manually
- Gain manual control over layout
- Add nested containers if needed
- Export PNG/SVG after conversion before embedding in Word/PDF/PPTX

### Any Format → Excalidraw
- Recreate manually in Excalidraw editor
- Hand-drawn aesthetic adds informal feel
- Good for brainstorming iterations
