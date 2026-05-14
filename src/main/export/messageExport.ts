import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type AssistantMessageExportFormat = 'pdf' | 'docx';

export interface AssistantMessageExportRequest {
  format: AssistantMessageExportFormat;
  title?: string;
  content: string;
  html?: string;
}

const require = createRequire(import.meta.url);
let cachedKatexCss: string | undefined;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function katexCssForExport(): string {
  if (cachedKatexCss !== undefined) return cachedKatexCss;
  try {
    cachedKatexCss = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8');
  } catch {
    cachedKatexCss = [
      '.katex { font: normal 1.08em "Cambria Math", "Times New Roman", serif; line-height: 1.2; }',
      '.katex-display { display: block; margin: 0.65em 0; text-align: center; overflow-x: auto; overflow-y: hidden; }',
      '.katex .katex-mathml { display: none; }'
    ].join('\n');
  }
  return cachedKatexCss;
}

export function safeExportBasename(input: string | undefined, fallback = 'assistant-reply'): string {
  const cleaned = (input || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function buildAssistantMessageExportHtml(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body { margin: 0; padding: 34px; color: #14151f; font-family: "Segoe UI", Arial, sans-serif; line-height: 1.58; font-size: 14px; }',
    'main { max-width: 820px; margin: 0 auto; }',
    'h1, h2, h3, h4, h5, h6 { margin: 20px 0 10px; line-height: 1.3; color: #0d1321; }',
    'p { margin: 0 0 11px; }',
    'a { color: #007a66; text-decoration: none; }',
    '.msg-cite-ref { display: inline; vertical-align: super; margin-left: 1px; line-height: 0; }',
    '.msg-cite-ref a { display: inline; padding: 0; border: 0; background: transparent; font-size: 8px; font-weight: 800; color: #007a66; text-decoration: none; }',
    'pre, code { font-family: Consolas, "SFMono-Regular", monospace; }',
    'code { background: #f0f2f5; border-radius: 5px; padding: 1px 4px; }',
    'pre { overflow-wrap: anywhere; white-space: pre-wrap; background: #f5f6f8; border: 1px solid #dce1e8; border-radius: 8px; padding: 10px; }',
    'blockquote { margin: 0 0 11px; padding-left: 12px; border-left: 3px solid #00aa88; color: #4b5563; }',
    'table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }',
    'th, td { border: 1px solid #dce1e8; padding: 7px 8px; vertical-align: top; }',
    'th { background: #f5f6f8; }',
    katexCssForExport(),
    '.katex-display { overflow-x: auto; overflow-y: hidden; }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    bodyHtml || `<p>${escapeHtml(title)}</p>`,
    '</main>',
    '</body>',
    '</html>'
  ].join('');
}

interface WordExportContext {
  relationships: Array<{ id: string; target: string }>;
  citationHrefs: Map<string, string>;
}

function cleanInlineMarkdown(input: string): string {
  return input
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|#39|nbsp);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos' || entity === '#39') return "'";
    if (entity === 'nbsp') return ' ';
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

function htmlToPlainText(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function htmlToMarkdownInline(input: string): string {
  const parts: string[] = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let cursor = 0;
  for (const match of input.matchAll(anchorRe)) {
    const index = match.index ?? 0;
    const before = htmlToPlainText(input.slice(cursor, index));
    if (before) parts.push(before);
    const href = decodeHtmlEntities(match[1] ?? '').trim();
    const label = htmlToPlainText(match[2] ?? '').trim() || href;
    parts.push(/^https?:\/\//i.test(href) ? `[${label}](${href})` : label);
    cursor = index + match[0].length;
  }
  const tail = htmlToPlainText(input.slice(cursor));
  if (tail) parts.push(tail);
  return parts.join(' ').trim();
}

function createHyperlinkRelationship(ctx: WordExportContext, href: string): string {
  const id = `rId${ctx.relationships.length + 1}`;
  ctx.relationships.push({ id, target: href });
  return id;
}

function runXml(text: string, options: { bold?: boolean; size?: number; font?: string; superscript?: boolean } = {}): string {
  const props: string[] = [];
  if (options.bold) props.push('<w:b/>');
  if (options.size) props.push(`<w:sz w:val="${options.size}"/>`);
  if (options.font) props.push(`<w:rFonts w:ascii="${escapeXml(options.font)}" w:hAnsi="${escapeXml(options.font)}" w:eastAsia="${escapeXml(options.font)}"/>`);
  if (options.superscript) props.push('<w:vertAlign w:val="superscript"/>');
  const textXml = text
    .split('\n')
    .map((part, index) => `${index > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(part)}</w:t>`)
    .join('');
  return [
    '<w:r>',
    props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '',
    textXml,
    '</w:r>'
  ].join('');
}

function normalizeHrefForExport(href: string): string {
  const trimmed = href.trim().replace(/^<(.+)>$/, '$1');
  try {
    return encodeURI(trimmed);
  } catch {
    return trimmed.replace(/\s+/g, '%20');
  }
}

function hyperlinkXml(label: string, href: string, ctx: WordExportContext, options: { superscript?: boolean; underline?: boolean } = {}): string {
  const id = createHyperlinkRelationship(ctx, href);
  const props = [
    '<w:rStyle w:val="Hyperlink"/>',
    '<w:color w:val="0563C1"/>',
    options.underline === false ? '<w:u w:val="none"/>' : '<w:u w:val="single"/>',
    options.superscript ? '<w:vertAlign w:val="superscript"/><w:sz w:val="16"/>' : ''
  ].join('');
  return [
    `<w:hyperlink r:id="${id}" w:history="1">`,
    '<w:r>',
    `<w:rPr>${props}</w:rPr>`,
    `<w:t xml:space="preserve">${escapeXml(label)}</w:t>`,
    '</w:r>',
    '</w:hyperlink>'
  ].join('');
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findUnescaped(text: string, needle: string, start: number): number {
  let index = text.indexOf(needle, start);
  while (index >= 0) {
    if (!isEscaped(text, index)) return index;
    index = text.indexOf(needle, index + needle.length);
  }
  return -1;
}

function shouldStartDollarMath(text: string, index: number): boolean {
  if (isEscaped(text, index)) return false;
  const next = text[index + 1] ?? '';
  const previous = text[index - 1] ?? '';
  if (!next || /\s|\$/.test(next)) return false;
  if (previous && /[\w)]/.test(previous)) return false;
  return true;
}

function isLikelyDollarMath(tex: string): boolean {
  const trimmed = tex.trim();
  if (!trimmed) return false;
  if (/\\[a-zA-Z]+/.test(trimmed)) return true;
  if (/[_^{}=<>]/.test(trimmed)) return true;
  if (/[∫∑∏√∞≤≥≠≈ΩαβγδΔθλμπρσφω∂∇]/.test(trimmed)) return true;
  if (/^[A-Za-z]$/.test(trimmed)) return true;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed) && /[+\-*/]/.test(trimmed);
}

function splitMathSegments(input: string): Array<{ kind: 'text' | 'math'; value: string }> {
  const segments: Array<{ kind: 'text' | 'math'; value: string }> = [];
  let textStart = 0;
  let index = 0;

  function pushText(until: number): void {
    if (until > textStart) segments.push({ kind: 'text', value: input.slice(textStart, until) });
  }

  while (index < input.length) {
    if (input.startsWith('$$', index) && !isEscaped(input, index)) {
      const end = findUnescaped(input, '$$', index + 2);
      if (end > index + 2) {
        pushText(index);
        segments.push({ kind: 'math', value: input.slice(index + 2, end) });
        index = end + 2;
        textStart = index;
        continue;
      }
    }

    if (input.startsWith('\\(', index)) {
      const end = findUnescaped(input, '\\)', index + 2);
      if (end > index + 2) {
        pushText(index);
        segments.push({ kind: 'math', value: input.slice(index + 2, end) });
        index = end + 2;
        textStart = index;
        continue;
      }
    }

    if (input.startsWith('\\[', index)) {
      const end = findUnescaped(input, '\\]', index + 2);
      if (end > index + 2) {
        pushText(index);
        segments.push({ kind: 'math', value: input.slice(index + 2, end) });
        index = end + 2;
        textStart = index;
        continue;
      }
    }

    if (input[index] === '$' && shouldStartDollarMath(input, index)) {
      const end = findUnescaped(input, '$', index + 1);
      if (end > index + 1) {
        const tex = input.slice(index + 1, end);
        if (isLikelyDollarMath(tex)) {
          pushText(index);
          segments.push({ kind: 'math', value: tex });
          index = end + 1;
          textStart = index;
          continue;
        }
      }
    }

    index += 1;
  }

  pushText(input.length);
  return segments.length > 0 ? segments : [{ kind: 'text', value: input }];
}

function replaceLatexFractions(input: string): string {
  let output = input;
  const fracRe = /\\(?:d?frac|tfrac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g;
  let previous = '';
  while (output !== previous) {
    previous = output;
    output = output.replace(fracRe, (_match, numerator: string, denominator: string) => `${numerator}/${denominator}`);
  }
  return output;
}

function latexToPlainMath(input: string): string {
  let text = decodeHtmlEntities(input).trim();
  text = text.replace(/\\(?:left|right)\s*/g, '');
  text = replaceLatexFractions(text);
  text = text.replace(/\\(?:mathrm|operatorname|text)\s*\{([^{}]*)\}/g, '$1');
  text = text.replace(/\\exp\b/g, 'exp');
  const commands: Record<string, string> = {
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    Delta: 'Δ',
    epsilon: 'ε',
    theta: 'θ',
    lambda: 'λ',
    mu: 'μ',
    pi: 'π',
    rho: 'ρ',
    sigma: 'σ',
    tau: 'τ',
    phi: 'φ',
    omega: 'ω',
    Omega: 'Ω',
    partial: '∂',
    nabla: '∇',
    int: '∫',
    sum: '∑',
    sqrt: '√',
    infty: '∞',
    le: '≤',
    leq: '≤',
    ge: '≥',
    geq: '≥',
    neq: '≠',
    approx: '≈',
    times: '×',
    cdot: '·',
    pm: '±'
  };
  text = text.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (_match, name: string) => commands[name] ?? name);
  text = text.replace(/\^\{?2\}?/g, '²');
  text = text.replace(/\^\{?3\}?/g, '³');
  text = text.replace(/\^\{([^{}]+)\}/g, '^($1)');
  text = text.replace(/_\{([^{}]+)\}/g, '_$1');
  text = text.replace(/_([A-Za-z0-9])/g, '_$1');
  text = text.replace(/[{}]/g, '');
  text = text.replace(/\\[,;:! ]/g, ' ');
  text = text.replace(/\\([()[\]])/g, '$1');
  text = text.replace(/\s*([=<>≤≥≈≠+\-×·/])\s*/g, ' $1 ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/∇\s*²\s*/g, '∇²');
  text = text.replace(/ρ\s+c\b/g, 'ρc');
  text = text.replace(/∂\s+/g, '∂');
  return text;
}

function inlineMarkdownXml(input: string, ctx: WordExportContext, options: { bold?: boolean; size?: number; font?: string } = {}): string {
  const source = input.trim();
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\n]+)\)/g;
  const parts: string[] = [];
  let cursor = 0;

  for (const match of source.matchAll(linkRe)) {
    const index = match.index ?? 0;
    const before = source.slice(cursor, index);
    if (before) parts.push(inlinePlainTextXml(before, ctx, options));
    const rawLabel = cleanInlineMarkdown(match[1] ?? '').trim() || match[2] || '';
    const href = normalizeHrefForExport(match[2] ?? '');
    if (/^\d+$/.test(rawLabel)) {
      ctx.citationHrefs.set(rawLabel, href);
      parts.push(hyperlinkXml(rawLabel, href, ctx, { superscript: true, underline: false }));
    } else {
      parts.push(hyperlinkXml(rawLabel, href, ctx));
    }
    cursor = index + match[0].length;
  }

  const tail = source.slice(cursor);
  if (tail) parts.push(inlinePlainTextXml(tail, ctx, options));
  return parts.join('') || runXml('', options);
}

function inlinePlainTextWithoutMathXml(input: string, ctx: WordExportContext, options: { bold?: boolean; size?: number; font?: string }): string {
  const tokenRe = /\[(\d+)\]|https?:\/\/[^\s<]+/g;
  const parts: string[] = [];
  let cursor = 0;
  for (const match of input.matchAll(tokenRe)) {
    const index = match.index ?? 0;
    const before = input.slice(cursor, index);
    if (before) parts.push(runXml(cleanInlineMarkdown(before), options));
    if (match[1]) {
      const label = match[1];
      const href = ctx.citationHrefs.get(label);
      if (href) parts.push(hyperlinkXml(`[${label}]`, href, ctx));
      else parts.push(runXml(`[${label}]`, options));
      cursor = index + match[0].length;
      continue;
    }
    const href = normalizeHrefForExport((match[0] ?? '').replace(/[),.;:]+$/, ''));
    const trailing = (match[0] ?? '').slice((match[0] ?? '').replace(/[),.;:]+$/, '').length);
    parts.push(hyperlinkXml(href, href, ctx));
    if (trailing) parts.push(runXml(trailing, options));
    cursor = index + match[0].length;
  }
  const tail = input.slice(cursor);
  if (tail) parts.push(runXml(cleanInlineMarkdown(tail), options));
  return parts.join('');
}

function inlinePlainTextXml(input: string, ctx: WordExportContext, options: { bold?: boolean; size?: number; font?: string }): string {
  return splitMathSegments(input)
    .map((segment) => {
      if (segment.kind === 'math') {
        return runXml(latexToPlainMath(segment.value), { ...options, font: options.font ?? 'Cambria Math' });
      }
      return inlinePlainTextWithoutMathXml(segment.value, ctx, options);
    })
    .join('');
}

function htmlInlineXml(input: string, ctx: WordExportContext, options: { bold?: boolean; size?: number; font?: string } = {}): string {
  const parts: string[] = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let cursor = 0;
  for (const match of input.matchAll(anchorRe)) {
    const index = match.index ?? 0;
    const before = htmlToPlainText(input.slice(cursor, index));
    if (before) parts.push(inlinePlainTextXml(before, ctx, options));
    const href = normalizeHrefForExport(decodeHtmlEntities(match[1] ?? '').trim());
    const label = htmlToPlainText(match[2] ?? '').trim() || href;
    if (/^https?:\/\//i.test(href) && /^\d+$/.test(label)) {
      ctx.citationHrefs.set(label, href);
      parts.push(hyperlinkXml(label, href, ctx, { superscript: true, underline: false }));
    } else if (/^https?:\/\//i.test(href)) parts.push(hyperlinkXml(label, href, ctx));
    else if (label) parts.push(runXml(label, options));
    cursor = index + match[0].length;
  }
  const tail = htmlToPlainText(input.slice(cursor));
  if (tail) parts.push(inlinePlainTextXml(tail, ctx, options));
  return parts.join('') || runXml('', options);
}

function paragraphXml(text: string, options: { heading?: number; code?: boolean; ctx?: WordExportContext } = {}): string {
  const size = options.heading ? Math.max(24, 36 - (options.heading - 1) * 3) : undefined;
  const spacing = options.heading ? '<w:spacing w:before="240" w:after="120"/>' : '<w:spacing w:after="120"/>';
  const paragraphProps = `<w:pPr>${spacing}</w:pPr>`;
  const runContent = options.ctx && !options.code
    ? inlineMarkdownXml(text, options.ctx, { bold: Boolean(options.heading), size })
    : runXml(text, {
    bold: Boolean(options.heading),
    size,
    font: options.code ? 'Consolas' : undefined
  });
  return `<w:p>${paragraphProps}${runContent}</w:p>`;
}

function isMarkdownTableRow(line: string): boolean {
  const normalized = line.trim();
  return normalized.startsWith('|') && normalized.endsWith('|') && (normalized.match(/\|/g) ?? []).length >= 2;
}

function looksLikeTableRow(line: string): boolean {
  const normalized = line.trim();
  if (isMarkdownTableRow(normalized)) return true;
  if (!normalized.includes('|')) return false;
  return splitMarkdownTableCells(normalized).filter((cell) => cell.trim()).length >= 2;
}

function isTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableCells(line.trim());
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isTableBlock(lines: string[], index: number): boolean {
  return looksLikeTableRow(lines[index]?.trim() ?? '') && isTableSeparator(lines[index + 1]?.trim() ?? '');
}

function splitMarkdownTableCells(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let inCode = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1] ?? '';

    if (char === '\\' && next === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function tableCellXml(text: string, ctx: WordExportContext, options: { header?: boolean; width?: number } = {}): string {
  return [
    '<w:tc>',
    `<w:tcPr><w:tcW w:w="${options.width ?? 2400}" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4" w:color="DCE1E8"/><w:left w:val="single" w:sz="4" w:color="DCE1E8"/><w:bottom w:val="single" w:sz="4" w:color="DCE1E8"/><w:right w:val="single" w:sz="4" w:color="DCE1E8"/></w:tcBorders>${options.header ? '<w:shd w:fill="F5F6F8"/>' : ''}</w:tcPr>`,
    `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${inlineMarkdownXml(text, ctx, { bold: options.header })}</w:p>`,
    '</w:tc>'
  ].join('');
}

function tableRowsXml(rows: string[][], ctx: WordExportContext): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const cellWidth = Math.max(1200, Math.floor(9360 / columnCount));
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${cellWidth}"/>`).join('');
  const renderedRows = rows.map((row, rowIndex) => {
    const padded = [...row, ...Array.from({ length: columnCount - row.length }, () => '')];
    const cells = padded
      .slice(0, columnCount)
      .map((cell) => tableCellXml(cell, ctx, { header: rowIndex === 0, width: cellWidth }))
      .join('');
    return `<w:tr>${cells}</w:tr>`;
  });
  return [
    '<w:tbl>',
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>',
    `<w:tblGrid>${grid}</w:tblGrid>`,
    ...renderedRows,
    '</w:tbl>'
  ].join('');
}

function tableXml(tableLines: string[], ctx: WordExportContext): string {
  const rows = tableLines
    .filter((line, index) => index !== 1 || !isTableSeparator(line))
    .map((line) => splitMarkdownTableCells(line));
  return tableRowsXml(rows, ctx);
}

function htmlTableToRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
      cells.push(htmlToMarkdownInline(cellMatch[1] ?? ''));
    }
    if (cells.some((cell) => cell.trim())) rows.push(cells);
  }
  return rows;
}

function htmlSegmentToWordBlocks(html: string, ctx: WordExportContext): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = (match[1] ?? '').toLowerCase();
    const rawBody = match[2] ?? '';
    const text = htmlToPlainText(rawBody);
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(paragraphXml(text, { heading: Number(tag.slice(1)), ctx }));
    } else if (tag === 'li') {
      blocks.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runXml('- ')}${htmlInlineXml(rawBody, ctx)}</w:p>`);
    } else if (tag === 'blockquote') {
      blocks.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${runXml('> ')}${htmlInlineXml(rawBody, ctx)}</w:p>`);
    } else if (tag === 'pre') {
      for (const line of text.split('\n')) blocks.push(paragraphXml(line, { code: true }));
    } else {
      blocks.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${htmlInlineXml(rawBody, ctx)}</w:p>`);
    }
  }
  return blocks;
}

function htmlToWordBlocks(html: string, ctx: WordExportContext): string[] {
  const blocks: string[] = [];
  const tableRe = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let cursor = 0;
  for (const match of html.matchAll(tableRe)) {
    const index = match.index ?? 0;
    blocks.push(...htmlSegmentToWordBlocks(html.slice(cursor, index), ctx));
    const rows = htmlTableToRows(match[0]);
    if (rows.length > 0) blocks.push(tableRowsXml(rows, ctx));
    cursor = index + match[0].length;
  }
  blocks.push(...htmlSegmentToWordBlocks(html.slice(cursor), ctx));
  return blocks;
}

function markdownToWordBlocks(markdown: string, ctx: WordExportContext): string[] {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!trimmed) {
      continue;
    }
    if (inCodeBlock) {
      blocks.push(paragraphXml(line, { code: true }));
      continue;
    }
    if (isTableBlock(lines, index)) {
      const tableLines = [lines[index].trim(), lines[index + 1].trim()];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index]?.trim() ?? '';
        if (!tableLine || !looksLikeTableRow(tableLine)) break;
        tableLines.push(tableLine);
        index += 1;
      }
      index -= 1;
      blocks.push(tableXml(tableLines, ctx));
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = Math.min(trimmed.match(/^#+/)?.[0].length ?? 1, 6);
      blocks.push(paragraphXml(trimmed.replace(/^#{1,6}\s+/, ''), { heading: level, ctx }));
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push(paragraphXml(`- ${trimmed.replace(/^[-*]\s+/, '')}`, { ctx }));
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      blocks.push(paragraphXml(trimmed, { ctx }));
      continue;
    }
    if (trimmed.startsWith('>')) {
      blocks.push(paragraphXml(`> ${trimmed.replace(/^>\s?/, '')}`, { ctx }));
      continue;
    }
    if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|$/.test(trimmed)) {
      continue;
    }
    blocks.push(paragraphXml(line, { ctx }));
  }
  return blocks.length > 0 ? blocks : [paragraphXml('(empty reply)')];
}

function collectMarkdownCitationHrefs(markdown: string, ctx: WordExportContext): void {
  const linkRe = /\[(\d+)\]\((https?:\/\/[^)\n]+)\)/g;
  for (const match of markdown.matchAll(linkRe)) {
    const label = match[1] ?? '';
    const href = normalizeHrefForExport(match[2] ?? '');
    if (label && href && !ctx.citationHrefs.has(label)) ctx.citationHrefs.set(label, href);
  }
}

function containsMarkdownMath(markdown: string): boolean {
  return splitMathSegments(markdown).some((segment) => segment.kind === 'math');
}

function normalizeTitleForCompare(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase();
}

function firstMarkdownHeading(markdown: string): string {
  const line = markdown
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .find((item) => /^#{1,6}\s+\S/.test(item.trim()));
  return line?.trim().replace(/^#{1,6}\s+/, '').trim() ?? '';
}

function firstHtmlHeading(html: string): string {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
  return match ? htmlToPlainText(match[1] ?? '') : '';
}

export async function buildAssistantMessageDocx(title: string, markdown: string, html?: string): Promise<Buffer> {
  const zip = new JSZip();
  const ctx: WordExportContext = { relationships: [], citationHrefs: new Map() };
  collectMarkdownCitationHrefs(markdown, ctx);
  const shouldPreferMarkdown = containsMarkdownMath(markdown);
  const htmlBlocks = !shouldPreferMarkdown && html?.trim() ? htmlToWordBlocks(html, ctx) : [];
  const contentBlocks = htmlBlocks.length > 0 ? htmlBlocks : markdownToWordBlocks(markdown, ctx);
  const firstContentHeading = html?.trim() && !shouldPreferMarkdown ? firstHtmlHeading(html) : firstMarkdownHeading(markdown);
  const shouldPrependTitle = normalizeTitleForCompare(title) !== normalizeTitleForCompare(firstContentHeading);
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<w:body>',
    ...(shouldPrependTitle ? [paragraphXml(title, { heading: 1 })] : []),
    ...contentBlocks,
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
    '</w:body>',
    '</w:document>'
  ].join('');
  const documentRelsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...ctx.relationships.map((rel) => `<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(rel.target)}" TargetMode="External"/>`),
    '</Relationships>'
  ].join('');

  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', documentRelsXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
