# Chart Specification

Create a JSON spec before running `scripts/generate_chart.mjs`.

## Common Fields

```json
{
  "chartType": "bar|line|scatter|heatmap",
  "title": "Chart title",
  "subtitle": "Optional subtitle",
  "width": 960,
  "height": 560,
  "data": {},
  "encoding": {},
  "style": {}
}
```

## Bar Chart

Use for category comparison and ranking.

```json
{
  "chartType": "bar",
  "title": "Average Revenue by Region",
  "data": {
    "x": "Region",
    "y": "Revenue",
    "aggregation": "avg",
    "sort": "desc",
    "limit": 12
  },
  "encoding": {
    "xLabel": "Region",
    "yLabel": "Average revenue"
  }
}
```

Supported aggregations: `sum`, `avg`, `count`, `min`, `max`.

## Line Chart

Use for time series and ordered trends.

```json
{
  "chartType": "line",
  "title": "Monthly Revenue Trend",
  "data": {
    "x": "Month",
    "y": "Revenue",
    "series": "Product",
    "aggregation": "sum"
  },
  "encoding": {
    "xLabel": "Month",
    "yLabel": "Revenue"
  }
}
```

If `series` is omitted, the script renders one line.

## Scatter Plot

Use for relationships between two numeric fields.

```json
{
  "chartType": "scatter",
  "title": "Price vs Demand",
  "data": {
    "x": "Price",
    "y": "Units",
    "series": "Segment",
    "trendline": true
  },
  "encoding": {
    "xLabel": "Price",
    "yLabel": "Units sold"
  }
}
```

## Correlation Heatmap

Use for exploratory relationships among numeric fields.

```json
{
  "chartType": "heatmap",
  "title": "Metric Correlation Heatmap",
  "data": {
    "columns": ["Revenue", "Units", "Discount", "Margin"]
  }
}
```

If `columns` is omitted, the script uses all numeric CSV columns.

## Style

Optional style fields:

```json
{
  "style": {
    "palette": ["#2563eb", "#16a34a", "#f97316", "#9333ea"],
    "background": "#ffffff",
    "textColor": "#111827"
  }
}
```

## Output Contract

The generated SVG should be treated as the chart source asset. For final document insertion, specify:

```markdown
Source format: chart-generator/svg
Export format for insertion: svg; png fallback if required by the target document workflow
```
