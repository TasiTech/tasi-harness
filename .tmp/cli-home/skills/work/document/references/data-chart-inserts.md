# Data Chart Inserts for Documents

Use this reference when a report, proposal, plan, presentation, or analysis would be stronger with a data visualization. This guidance generalizes the useful chart-generation pattern from data-analysis skills: analyze a tabular dataset, choose an appropriate chart, export it as an image, and place it near the claim it supports. When an actual chart asset is needed and `$chart-generator` is available, pass the chart specification to that skill to generate an SVG source asset.

## When to Add a Data Chart

Add a chart when a claim depends on numeric evidence, trend behavior, distribution, correlation, or category comparison:
- **Line chart / time series:** trends over dates, seasonality, before/after changes, metric drift.
- **Bar chart:** category ranking, group comparison, top/bottom performers, budget or workload split.
- **Scatter plot:** relationship between two numeric variables; add a regression line when the trend matters.
- **Correlation heatmap:** relationship among multiple numeric variables; useful during exploratory analysis.
- **Stacked bar / area chart:** composition over categories or time.
- **Histogram / box plot:** distribution, variance, outliers, quality or risk spread.
- **KPI card/table:** exact values, thresholds, or small sets of metrics where a chart would be noisy.

Do not add a chart only because data exists. Each chart must support a specific sentence, decision, risk, or recommendation in the surrounding text.

## Placement Pattern

Place the chart directly after the paragraph that makes the data-backed claim. Use this pattern:

```markdown
[Figure 1: <short chart title>]
Purpose: <what the reader should learn from the chart>.
Data source: <file/table/query name, date range, filters, or assumptions>.
Chart type: <line|bar|scatter|heatmap|stacked bar|histogram|box plot|table>.
Source format: <chart-generator/svg|python/matplotlib|python/seaborn|spreadsheet chart|vega-lite|other>.
Export format for insertion: <png|svg>.
Caption: <one sentence caption for the final document>.
Chart specification: <columns, aggregation, axes, grouping, labels, and styling notes>.
```

For PPT content, use the same fields under the relevant slide as `Visual:` or `Chart:`.

## Export Format for Insertion

- Use **PNG** by default for Word/PDF/PPTX compatibility, especially for matplotlib/seaborn charts and heatmaps.
- Use **SVG** when the chart is simple vector line art, needs sharp scaling in PPTX, and the downstream tool supports SVG. `$chart-generator` produces SVG assets by default.
- Use at least 150 DPI for drafts and 300 DPI for final print-oriented reports when exporting PNG.
- Keep chart labels large enough for the final document size; avoid tiny legends and crowded axis labels.
- Prefer transparent or white backgrounds unless the final document has a known dark theme.

## Chart Specification Rules

A good chart specification should include:
- **Input fields:** column names and expected types.
- **Filtering:** date range, stores/regions/products, missing-value handling, outlier policy.
- **Transformation:** grouping, aggregation, rolling average, normalization, or correlation method.
- **Encoding:** x-axis, y-axis, color, size, facet, label, sort order.
- **Interpretation:** one or two findings the text should discuss.
- **Export:** target filename and format, usually `png` for direct document insertion.

Avoid hardcoding business-specific assumptions unless the user provides them. For example, a Walmart sales chart can use `Store`, `Date`, `Weekly_Sales`, and `Unemployment` only when the supplied dataset actually has those columns.

## Common Analytical Chart Patterns

Correlation heatmap:

```markdown
[Figure 1: 指标相关性热力图]
Purpose: Identify which numeric variables move together and which relationships need deeper analysis.
Data source: <dataset name>; numeric columns only; missing values excluded pairwise.
Chart type: heatmap.
Source format: chart-generator/svg or python/seaborn.
Export format for insertion: png.
Caption: 相关性热力图展示各核心指标之间的线性相关强度，帮助识别后续分析重点。
Chart specification: Compute Pearson correlation for numeric columns; render annotated heatmap with diverging color scale; sort related variables together when possible.
```

Scatter plot with trend line:

```markdown
[Figure 2: 销售额与失业率关系]
Purpose: Show whether unemployment is associated with weekly sales changes.
Data source: CSV with `Weekly_Sales` and `Unemployment`; remove rows missing either value.
Chart type: scatter.
Source format: chart-generator/svg or python/seaborn.
Export format for insertion: png.
Caption: 散点图和回归线用于观察失业率变化与周销售额之间是否存在明显趋势。
Chart specification: x=`Unemployment`, y=`Weekly_Sales`, alpha=0.3, add regression line, label axes with units, include caveat that correlation is not causation.
```

Time series trend:

```markdown
[Figure 3: 销售与外部指标时间趋势]
Purpose: Compare business metric movement against an external factor over time.
Data source: CSV with date, metric, and comparison indicator columns.
Chart type: line.
Source format: chart-generator/svg or python/matplotlib.
Export format for insertion: png.
Caption: 时间序列图用于区分季节性波动、长期趋势和外部指标变化。
Chart specification: Parse date column; sort by date; plot primary metric on left axis and comparison indicator on right axis only when units differ; use clear legends.
```

Group comparison:

```markdown
[Figure 4: 分组平均表现对比]
Purpose: Compare average performance across stores, regions, products, or teams.
Data source: Dataset grouped by selected category.
Chart type: bar or scatter.
Source format: chart-generator/svg or python/seaborn.
Export format for insertion: png.
Caption: 分组对比图展示不同对象之间的平均表现差异，为资源配置或运营策略提供依据。
Chart specification: Group by category; calculate mean or median for target metric; sort descending; label top and bottom groups; use bar chart for one metric or scatter for two metrics.
```

## Audit Checklist

Before delivering the document:
- Every chart supports a nearby claim or decision.
- Every chart states data source, chart type, source format, and export format.
- Axes, units, filters, date ranges, and aggregation rules are explicit.
- The caption states the insight, not merely the chart type.
- The text distinguishes observed correlation from causal claims.
- Any missing data, assumptions, or unverified fields are clearly labeled.
