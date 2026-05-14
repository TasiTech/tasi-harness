---
name: chart-generator
description: "Generate reusable data charts from CSV files and chart specifications for reports, proposals, presentations, dashboards, and analytical documents. Use when Codex needs to create line charts, bar charts, scatter plots, correlation heatmaps, or chart image assets for insertion into Word/PDF/PPTX workflows."
category: work
license: Proprietary
---

# Chart Generator

## Scope

Use this skill to turn tabular data into chart assets and chart specifications. It is domain-neutral: do not assume Walmart, sales, unemployment, or any other business-specific fields unless the user provides them.

This skill provides a bundled zero-dependency Node.js script for SVG chart generation. SVG is the default source asset because it preserves text and vector quality. If the final document requires PNG, generate SVG first and then use a downstream renderer, office export workflow, or file-format skill to convert or embed as needed.

## Workflow

1. **Inspect the data request:** Identify the dataset path, chart purpose, audience, required chart type, and output location.
2. **Validate fields:** Confirm the referenced CSV columns exist and contain usable numeric/date/category values. State assumptions if column names are inferred.
3. **Choose a chart:**
   - Line chart for trends over time or ordered values.
   - Bar chart for category comparison or ranking.
   - Scatter plot for relationships between two numeric fields.
   - Correlation heatmap for relationships among multiple numeric fields.
4. **Create a chart spec:** Follow [chart-spec.md](references/chart-spec.md). Keep the spec explicit about columns, aggregation, sorting, labels, size, and export path.
5. **Run the script:** Use `scripts/generate_chart.mjs` with `--input`, `--spec`, and `--output`.
6. **Return assets and interpretation:** Report the generated SVG path, intended insertion format, and 1-3 findings the chart supports.

## Script Usage

```bash
node scripts/generate_chart.mjs --input data.csv --spec chart-spec.json --output output/chart.svg
```

The script supports:
- `bar`
- `line`
- `scatter`
- `heatmap`

The script writes an SVG file and a sidecar manifest JSON at `<output>.manifest.json`.

## Output Guidance

For Word/PDF/PPTX insertion:
- Prefer SVG for PPTX and modern Word when vector support is acceptable.
- Prefer PNG when maximum compatibility is required; convert the generated SVG using an available downstream renderer.
- Keep charts readable at final document size: short titles, clear axis labels, limited legends, and no crowded category labels.

## Quality Checks

Before delivering:
- Verify input columns exist.
- Verify the chart type matches the analytical claim.
- Verify exported asset path exists.
- Explain aggregation and filters in the document text or caption.
- Avoid causal claims unless the analysis proves causality.
