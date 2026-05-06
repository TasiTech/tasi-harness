import JSZip from 'jszip';

export type AssistantMessageExportFormat = 'pdf' | 'docx';

export interface AssistantMessageExportRequest {
  format: AssistantMessageExportFormat;
  title?: string;
  content: string;
  html?: string;
}

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
    'a.msg-cite { display: inline-block; min-width: 16px; padding: 1px 5px; border: 1px solid #00aa88; border-radius: 999px; font-size: 11px; font-weight: 700; color: #007a66; }',
    'pre, code { font-family: Consolas, "SFMono-Regular", monospace; }',
    'code { background: #f0f2f5; border-radius: 5px; padding: 1px 4px; }',
    'pre { overflow-wrap: anywhere; white-space: pre-wrap; background: #f5f6f8; border: 1px solid #dce1e8; border-radius: 8px; padding: 10px; }',
    'blockquote { margin: 0 0 11px; padding-left: 12px; border-left: 3px solid #00aa88; color: #4b5563; }',
    'table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-size: 13px; }',
    'th, td { border: 1px solid #dce1e8; padding: 7px 8px; vertical-align: top; }',
    'th { background: #f5f6f8; }',
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

function inlineMarkdownToText(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, href: string) => {
      const trimmed = label.trim();
      return /^\d+$/.test(trimmed) ? `[${trimmed}] ${href}` : `${trimmed} (${href})`;
    })
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .trim();
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

function runXml(text: string, options: { bold?: boolean; size?: number; font?: string } = {}): string {
  const props: string[] = [];
  if (options.bold) props.push('<w:b/>');
  if (options.size) props.push(`<w:sz w:val="${options.size}"/>`);
  if (options.font) props.push(`<w:rFonts w:ascii="${escapeXml(options.font)}" w:hAnsi="${escapeXml(options.font)}" w:eastAsia="${escapeXml(options.font)}"/>`);
  return [
    '<w:r>',
    props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '',
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`,
    '</w:r>'
  ].join('');
}

function paragraphXml(text: string, options: { heading?: number; code?: boolean } = {}): string {
  const size = options.heading ? Math.max(24, 36 - (options.heading - 1) * 3) : undefined;
  const spacing = options.heading ? '<w:spacing w:before="240" w:after="120"/>' : '<w:spacing w:after="120"/>';
  const paragraphProps = `<w:pPr>${spacing}</w:pPr>`;
  return `<w:p>${paragraphProps}${runXml(text, {
    bold: Boolean(options.heading),
    size,
    font: options.code ? 'Consolas' : undefined
  })}</w:p>`;
}

function looksLikeTableRow(line: string): boolean {
  const normalized = line.trim();
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

function tableCellXml(text: string, options: { header?: boolean; width?: number } = {}): string {
  return [
    '<w:tc>',
    `<w:tcPr><w:tcW w:w="${options.width ?? 2400}" w:type="dxa"/><w:tcBorders><w:top w:val="single" w:sz="4" w:color="DCE1E8"/><w:left w:val="single" w:sz="4" w:color="DCE1E8"/><w:bottom w:val="single" w:sz="4" w:color="DCE1E8"/><w:right w:val="single" w:sz="4" w:color="DCE1E8"/></w:tcBorders>${options.header ? '<w:shd w:fill="F5F6F8"/>' : ''}</w:tcPr>`,
    `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${runXml(inlineMarkdownToText(text), { bold: options.header })}</w:p>`,
    '</w:tc>'
  ].join('');
}

function tableRowsXml(rows: string[][]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const cellWidth = Math.max(1200, Math.floor(9360 / columnCount));
  const grid = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${cellWidth}"/>`).join('');
  const renderedRows = rows.map((row, rowIndex) => {
    const padded = [...row, ...Array.from({ length: columnCount - row.length }, () => '')];
    const cells = padded
      .slice(0, columnCount)
      .map((cell) => tableCellXml(cell, { header: rowIndex === 0, width: cellWidth }))
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

function tableXml(tableLines: string[]): string {
  const rows = tableLines
    .filter((line, index) => index !== 1 || !isTableSeparator(line))
    .map((line) => splitMarkdownTableCells(line));
  return tableRowsXml(rows);
}

function htmlTableToRows(tableHtml: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
      cells.push(htmlToPlainText(cellMatch[1] ?? ''));
    }
    if (cells.some((cell) => cell.trim())) rows.push(cells);
  }
  return rows;
}

function htmlSegmentToWordBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = (match[1] ?? '').toLowerCase();
    const text = htmlToPlainText(match[2] ?? '');
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(paragraphXml(text, { heading: Number(tag.slice(1)) }));
    } else if (tag === 'li') {
      blocks.push(paragraphXml(`- ${text}`));
    } else if (tag === 'blockquote') {
      blocks.push(paragraphXml(`> ${text}`));
    } else if (tag === 'pre') {
      for (const line of text.split('\n')) blocks.push(paragraphXml(line, { code: true }));
    } else {
      blocks.push(paragraphXml(text));
    }
  }
  return blocks;
}

function htmlToWordBlocks(html: string): string[] {
  const blocks: string[] = [];
  const tableRe = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let cursor = 0;
  for (const match of html.matchAll(tableRe)) {
    const index = match.index ?? 0;
    blocks.push(...htmlSegmentToWordBlocks(html.slice(cursor, index)));
    const rows = htmlTableToRows(match[0]);
    if (rows.length > 0) blocks.push(tableRowsXml(rows));
    cursor = index + match[0].length;
  }
  blocks.push(...htmlSegmentToWordBlocks(html.slice(cursor)));
  return blocks;
}

function markdownToWordBlocks(markdown: string): string[] {
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
      blocks.push(tableXml(tableLines));
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = Math.min(trimmed.match(/^#+/)?.[0].length ?? 1, 6);
      blocks.push(paragraphXml(inlineMarkdownToText(trimmed.replace(/^#{1,6}\s+/, '')), { heading: level }));
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      blocks.push(paragraphXml(`- ${inlineMarkdownToText(trimmed.replace(/^[-*]\s+/, ''))}`));
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      blocks.push(paragraphXml(inlineMarkdownToText(trimmed)));
      continue;
    }
    if (trimmed.startsWith('>')) {
      blocks.push(paragraphXml(`> ${inlineMarkdownToText(trimmed.replace(/^>\s?/, ''))}`));
      continue;
    }
    if (/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|$/.test(trimmed)) {
      continue;
    }
    blocks.push(paragraphXml(inlineMarkdownToText(line)));
  }
  return blocks.length > 0 ? blocks : [paragraphXml('(empty reply)')];
}

export async function buildAssistantMessageDocx(title: string, markdown: string, html?: string): Promise<Buffer> {
  const zip = new JSZip();
  const htmlBlocks = html?.trim() ? htmlToWordBlocks(html) : [];
  const contentBlocks = htmlBlocks.length > 0 ? htmlBlocks : markdownToWordBlocks(markdown);
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    paragraphXml(title, { heading: 1 }),
    ...contentBlocks,
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
    '</w:body>',
    '</w:document>'
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
  return zip.generateAsync({ type: 'nodebuffer' });
}
