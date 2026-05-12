#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_COLORS = ['#2563eb', '#16a34a', '#f97316', '#9333ea', '#dc2626', '#0891b2', '#7c3aed', '#4b5563'];

function parseArgs(argv) {
  if (argv.length === 1 && argv[0]?.trim().startsWith('{')) {
    const parsed = JSON.parse(argv[0]);
    return {
      input: parsed.input || parsed.input_file || parsed.csv || parsed.data_path,
      spec: parsed.spec || parsed.spec_file,
      output: parsed.output || parsed.output_file
    };
  }
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--input') args.input = argv[++i];
    else if (key === '--spec') args.spec = argv[++i];
    else if (key === '--output') args.output = argv[++i];
    else if (key === '--help' || key === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/generate_chart.mjs --input data.csv --spec chart-spec.json --output chart.svg',
    '',
    'Supported chartType values: bar, line, scatter, heatmap'
  ].join('\n');
}

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length < 2) throw new Error('CSV must include a header and at least one data row.');
  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((values) => Object.fromEntries(headers.map((h, idx) => [h, values[idx] ?? ''])));
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value).trim().replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!cleaned) return NaN;
  return Number(cleaned);
}

function ensureColumns(rows, columns) {
  const available = new Set(Object.keys(rows[0] ?? {}));
  const missing = columns.filter(Boolean).filter((col) => !available.has(col));
  if (missing.length) throw new Error(`Missing CSV column(s): ${missing.join(', ')}`);
}

function aggregate(values, method) {
  const nums = values.map(toNumber).filter(Number.isFinite);
  if (method === 'count') return values.length;
  if (!nums.length) return NaN;
  if (method === 'min') return Math.min(...nums);
  if (method === 'max') return Math.max(...nums);
  if (method === 'avg') return nums.reduce((sum, v) => sum + v, 0) / nums.length;
  return nums.reduce((sum, v) => sum + v, 0);
}

function groupAggregate(rows, xKey, yKey, method = 'sum') {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row[xKey] ?? '').trim() || '(blank)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row[yKey]);
  }
  return [...groups.entries()].map(([x, values]) => ({ x, y: aggregate(values, method) })).filter((d) => Number.isFinite(d.y));
}

function extent(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return [0, 1];
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return [min, max];
}

function niceTicks(min, max, count = 5) {
  const ticks = [];
  for (let i = 0; i <= count; i += 1) ticks.push(min + ((max - min) * i) / count);
  return ticks;
}

function fmt(value) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}K`;
  if (abs < 1 && abs !== 0) return value.toFixed(2);
  return String(Math.round(value * 100) / 100);
}

function baseSvg(spec) {
  const width = Number(spec.width) || 960;
  const height = Number(spec.height) || 560;
  const style = spec.style || {};
  return {
    width,
    height,
    margin: { top: 76, right: 36, bottom: 96, left: 86 },
    bg: style.background || '#ffffff',
    text: style.textColor || '#111827',
    grid: '#e5e7eb',
    axis: '#374151',
    colors: Array.isArray(style.palette) && style.palette.length ? style.palette : DEFAULT_COLORS
  };
}

function svgFrame(spec, inner) {
  const c = baseSvg(spec);
  const title = escapeXml(spec.title || 'Chart');
  const subtitle = escapeXml(spec.subtitle || '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}">
  <rect width="100%" height="100%" fill="${c.bg}"/>
  <text x="${c.margin.left}" y="34" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${c.text}">${title}</text>
  ${subtitle ? `<text x="${c.margin.left}" y="58" font-family="Arial, sans-serif" font-size="13" fill="#6b7280">${subtitle}</text>` : ''}
  ${inner}
</svg>
`;
}

function drawAxes(c, xLabel, yLabel, yMin, yMax) {
  const left = c.margin.left;
  const top = c.margin.top;
  const right = c.width - c.margin.right;
  const bottom = c.height - c.margin.bottom;
  const ticks = niceTicks(yMin, yMax);
  const lines = [
    `<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="${c.axis}" stroke-width="1.2"/>`,
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="${c.axis}" stroke-width="1.2"/>`
  ];
  for (const tick of ticks) {
    const y = bottom - ((tick - yMin) / (yMax - yMin)) * (bottom - top);
    lines.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${c.grid}" stroke-width="1"/>`);
    lines.push(`<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="#6b7280">${fmt(tick)}</text>`);
  }
  if (xLabel) lines.push(`<text x="${(left + right) / 2}" y="${c.height - 24}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="${c.text}">${escapeXml(xLabel)}</text>`);
  if (yLabel) lines.push(`<text transform="translate(22 ${(top + bottom) / 2}) rotate(-90)" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="${c.text}">${escapeXml(yLabel)}</text>`);
  return lines.join('\n  ');
}

function renderBar(rows, spec) {
  const c = baseSvg(spec);
  const dataSpec = spec.data || {};
  ensureColumns(rows, [dataSpec.x, dataSpec.y]);
  let data = groupAggregate(rows, dataSpec.x, dataSpec.y, dataSpec.aggregation || 'sum');
  if (dataSpec.sort === 'desc') data.sort((a, b) => b.y - a.y);
  else if (dataSpec.sort === 'asc') data.sort((a, b) => a.y - b.y);
  if (dataSpec.limit) data = data.slice(0, Number(dataSpec.limit));
  const [rawMin, rawMax] = extent(data.map((d) => d.y));
  const yMin = Math.min(0, rawMin);
  const yMax = rawMax;
  const left = c.margin.left;
  const top = c.margin.top;
  const right = c.width - c.margin.right;
  const bottom = c.height - c.margin.bottom;
  const plotW = right - left;
  const plotH = bottom - top;
  const gap = Math.max(4, Math.min(16, plotW / Math.max(data.length, 1) * 0.16));
  const barW = Math.max(2, (plotW - gap * (data.length - 1)) / Math.max(data.length, 1));
  const parts = [drawAxes(c, spec.encoding?.xLabel || dataSpec.x, spec.encoding?.yLabel || dataSpec.y, yMin, yMax)];
  data.forEach((d, idx) => {
    const x = left + idx * (barW + gap);
    const y = bottom - ((d.y - yMin) / (yMax - yMin)) * plotH;
    const h = bottom - y;
    parts.push(`<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${c.colors[idx % c.colors.length]}" rx="2"/>`);
    if (data.length <= 24) {
      parts.push(`<text transform="translate(${x + barW / 2} ${bottom + 14}) rotate(35)" text-anchor="start" font-family="Arial, sans-serif" font-size="10" fill="#6b7280">${escapeXml(d.x)}</text>`);
    }
  });
  return svgFrame(spec, parts.join('\n  '));
}

function renderLine(rows, spec) {
  const c = baseSvg(spec);
  const dataSpec = spec.data || {};
  ensureColumns(rows, [dataSpec.x, dataSpec.y, dataSpec.series].filter(Boolean));
  const seriesKey = dataSpec.series || '__series';
  const groups = new Map();
  for (const row of rows) {
    const series = dataSpec.series ? String(row[seriesKey] || '(blank)') : 'Value';
    const xRaw = row[dataSpec.x];
    const parsedDate = Date.parse(xRaw);
    const xVal = Number.isFinite(parsedDate) ? parsedDate : toNumber(xRaw);
    const yVal = toNumber(row[dataSpec.y]);
    if (!Number.isFinite(xVal) || !Number.isFinite(yVal)) continue;
    if (!groups.has(series)) groups.set(series, []);
    groups.get(series).push({ x: xVal, xLabel: String(xRaw), y: yVal });
  }
  const all = [...groups.values()].flat();
  const [xMin, xMax] = extent(all.map((d) => d.x));
  const [yMin, yMax] = extent(all.map((d) => d.y));
  const left = c.margin.left;
  const top = c.margin.top;
  const right = c.width - c.margin.right;
  const bottom = c.height - c.margin.bottom;
  const sx = (v) => left + ((v - xMin) / (xMax - xMin)) * (right - left);
  const sy = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
  const parts = [drawAxes(c, spec.encoding?.xLabel || dataSpec.x, spec.encoding?.yLabel || dataSpec.y, yMin, yMax)];
  let idx = 0;
  for (const [name, points] of groups.entries()) {
    points.sort((a, b) => a.x - b.x);
    const path = points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ');
    const color = c.colors[idx % c.colors.length];
    parts.push(`<polyline fill="none" stroke="${color}" stroke-width="2.4" points="${path}"/>`);
    points.forEach((p) => parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="3" fill="${color}"/>`));
    parts.push(`<circle cx="${right - 150}" cy="${top + idx * 20}" r="5" fill="${color}"/><text x="${right - 138}" y="${top + idx * 20 + 4}" font-family="Arial, sans-serif" font-size="12" fill="${c.text}">${escapeXml(name)}</text>`);
    idx += 1;
  }
  return svgFrame(spec, parts.join('\n  '));
}

function renderScatter(rows, spec) {
  const c = baseSvg(spec);
  const dataSpec = spec.data || {};
  ensureColumns(rows, [dataSpec.x, dataSpec.y, dataSpec.series].filter(Boolean));
  const points = rows.map((row) => ({
    x: toNumber(row[dataSpec.x]),
    y: toNumber(row[dataSpec.y]),
    series: dataSpec.series ? String(row[dataSpec.series] || '(blank)') : 'Value'
  })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const [xMin, xMax] = extent(points.map((p) => p.x));
  const [yMin, yMax] = extent(points.map((p) => p.y));
  const left = c.margin.left;
  const top = c.margin.top;
  const right = c.width - c.margin.right;
  const bottom = c.height - c.margin.bottom;
  const sx = (v) => left + ((v - xMin) / (xMax - xMin)) * (right - left);
  const sy = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
  const seriesNames = [...new Set(points.map((p) => p.series))];
  const parts = [drawAxes(c, spec.encoding?.xLabel || dataSpec.x, spec.encoding?.yLabel || dataSpec.y, yMin, yMax)];
  points.forEach((p) => {
    const idx = seriesNames.indexOf(p.series);
    parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${c.colors[idx % c.colors.length]}" opacity="0.68"/>`);
  });
  if (dataSpec.trendline && points.length > 1) {
    const n = points.length;
    const sumX = points.reduce((s, p) => s + p.x, 0);
    const sumY = points.reduce((s, p) => s + p.y, 0);
    const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
    const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    if (Number.isFinite(slope) && Number.isFinite(intercept)) {
      parts.push(`<line x1="${sx(xMin)}" y1="${sy(slope * xMin + intercept)}" x2="${sx(xMax)}" y2="${sy(slope * xMax + intercept)}" stroke="#dc2626" stroke-width="2.2" stroke-dasharray="6 4"/>`);
    }
  }
  return svgFrame(spec, parts.join('\n  '));
}

function corr(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return NaN;
  const meanA = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const meanB = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  const num = pairs.reduce((s, [x, y]) => s + (x - meanA) * (y - meanB), 0);
  const denA = Math.sqrt(pairs.reduce((s, [x]) => s + (x - meanA) ** 2, 0));
  const denB = Math.sqrt(pairs.reduce((s, [, y]) => s + (y - meanB) ** 2, 0));
  return denA && denB ? num / (denA * denB) : NaN;
}

function heatColor(v) {
  if (!Number.isFinite(v)) return '#f3f4f6';
  const clamped = Math.max(-1, Math.min(1, v));
  if (clamped >= 0) {
    const intensity = Math.round(255 - clamped * 130);
    return `rgb(255,${intensity},${intensity})`;
  }
  const intensity = Math.round(255 + clamped * 130);
  return `rgb(${intensity},${intensity},255)`;
}

function renderHeatmap(rows, spec) {
  const c = baseSvg(spec);
  const dataSpec = spec.data || {};
  let columns = Array.isArray(dataSpec.columns) ? dataSpec.columns : [];
  if (!columns.length) {
    columns = Object.keys(rows[0] ?? {}).filter((col) => rows.some((row) => Number.isFinite(toNumber(row[col]))));
  }
  ensureColumns(rows, columns);
  const vectors = Object.fromEntries(columns.map((col) => [col, rows.map((row) => toNumber(row[col]))]));
  const top = c.margin.top + 20;
  const left = c.margin.left + 60;
  const size = Math.min((c.width - left - 40) / columns.length, (c.height - top - 90) / columns.length);
  const parts = [];
  columns.forEach((rowCol, r) => {
    columns.forEach((col, q) => {
      const value = corr(vectors[rowCol], vectors[col]);
      const x = left + q * size;
      const y = top + r * size;
      parts.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${heatColor(value)}" stroke="#ffffff"/>`);
      if (size >= 38) parts.push(`<text x="${x + size / 2}" y="${y + size / 2 + 4}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#111827">${fmt(value)}</text>`);
    });
  });
  columns.forEach((col, idx) => {
    parts.push(`<text transform="translate(${left + idx * size + size / 2} ${top - 8}) rotate(-35)" text-anchor="start" font-family="Arial, sans-serif" font-size="11" fill="${c.text}">${escapeXml(col)}</text>`);
    parts.push(`<text x="${left - 8}" y="${top + idx * size + size / 2 + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="${c.text}">${escapeXml(col)}</text>`);
  });
  return svgFrame(spec, parts.join('\n  '));
}

function render(rows, spec) {
  const chartType = String(spec.chartType || spec.type || '').toLowerCase();
  if (chartType === 'bar') return renderBar(rows, spec);
  if (chartType === 'line') return renderLine(rows, spec);
  if (chartType === 'scatter') return renderScatter(rows, spec);
  if (chartType === 'heatmap') return renderHeatmap(rows, spec);
  throw new Error(`Unsupported chartType: ${chartType || '(missing)'}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.input || !args.spec || !args.output) throw new Error(`${usage()}\n\nMissing --input, --spec, or --output.`);
  const csvPath = resolve(args.input);
  const specPath = resolve(args.spec);
  const outputPath = resolve(args.output);
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const spec = JSON.parse(readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
  const svg = render(rows, spec);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, svg, 'utf8');
  const manifest = {
    output: outputPath,
    sourceFormat: 'chart-generator/svg',
    insertionFormat: 'svg',
    chartType: spec.chartType || spec.type,
    title: spec.title || 'Chart',
    rows: rows.length
  };
  writeFileSync(`${outputPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
