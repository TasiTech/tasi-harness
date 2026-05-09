import { normalizeCitationHref } from './citations.js';

const BARE_HTTP_URL_RE = /(^|[\s(>])((https?:\/\/[^\s<)]+))/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\n]+)\)/g;

function restoreFlattenedTableLine(line: string): string {
  const pipeCount = (line.match(/\|/g) ?? []).length;
  const hasDelimiterRow = /\|\s*:?-{3,}:?\s*\|/.test(line);
  if (pipeCount < 6 || !hasDelimiterRow) return line;

  const firstPipe = line.indexOf('|');
  const lastPipe = line.lastIndexOf('|');
  if (firstPipe < 0 || lastPipe <= firstPipe) return line;

  const before = line.slice(0, firstPipe).trim();
  const table = line
    .slice(firstPipe, lastPipe + 1)
    .replace(/\|\s+(?=\|)/g, '|\n')
    .replace(/\|\|/g, '|\n|')
    .trim();
  const after = line.slice(lastPipe + 1).trim();

  return [before, table, after].filter(Boolean).join('\n\n');
}

function restoreFlattenedTableLines(input: string): string {
  return input
    .split('\n')
    .map((line) => restoreFlattenedTableLine(line))
    .join('\n');
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && (trimmed.match(/\|/g) ?? []).length >= 2;
}

function isMarkdownTableDelimiter(line: string): boolean {
  return /^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|$/.test(line.trim());
}

function isolateMarkdownTables(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isTableStart = isMarkdownTableRow(line) && isMarkdownTableDelimiter(lines[i + 1] ?? '');
    const previous = out[out.length - 1] ?? '';
    if (isTableStart && previous.trim()) {
      out.push('');
    }

    out.push(line);

    const isTableLine = isMarkdownTableRow(line);
    const next = lines[i + 1] ?? '';
    if (isTableLine && !isMarkdownTableRow(next) && next.trim()) {
      out.push('');
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function normalizeMarkdownForRender(content: string): string {
  let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.replace(/\u00a0/g, ' ');

  const escapedNewlineCount = (normalized.match(/\\n/g) ?? []).length;
  if (!normalized.includes('\n') && escapedNewlineCount >= 2) {
    normalized = normalized.replace(/\\n/g, '\n');
  }

  return isolateMarkdownTables(restoreFlattenedTableLines(normalized));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdownLink(label: string, href: string): string {
  const normalizedHref = /^https?:\/\//i.test(href) ? normalizeCitationHref(href) : href.trim();
  const escapedHref = escapeHtml(normalizedHref);
  if (/^\d+$/.test(label.trim())) {
    return `<sup class="msg-cite-ref"><a href="${escapedHref}" target="_blank" rel="noreferrer" title="${escapedHref}">${label}</a></sup>`;
  }
  return `<a href="${escapedHref}" target="_blank" rel="noreferrer">${label}</a>`;
}

function renderInlineHtml(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(MARKDOWN_LINK_RE, (_match, label: string, href: string) => renderMarkdownLink(label, href));
  html = html.replace(BARE_HTTP_URL_RE, (_match, prefix: string, url: string) => {
    const safePrefix = prefix ?? '';
    const trailing = url.match(/[.,;!?]+$/)?.[0] ?? '';
    const normalizedUrl = trailing ? url.slice(0, -trailing.length) : url;
    return `${safePrefix}<a href="${normalizedUrl}" target="_blank" rel="noreferrer">${normalizedUrl}</a>${trailing}`;
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

function isHorizontalRule(line: string): boolean {
  return /^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line);
}

function looksLikeTableRow(line: string): boolean {
  const normalized = line.trim();
  if (isMarkdownTableRow(normalized)) return true;
  if (!normalized.includes('|')) return false;
  return normalized.split('|').filter((cell) => cell.trim()).length >= 2;
}

function isTableSeparator(line: string): boolean {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!normalized) return false;
  return normalized
    .split('|')
    .map((cell) => cell.trim())
    .every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableBlock(lines: string[], index: number): boolean {
  return looksLikeTableRow(lines[index]?.trim() ?? '') && isTableSeparator(lines[index + 1]?.trim() ?? '');
}

function splitTableCells(line: string): string[] {
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

function tableAlignments(separatorLine: string, columnCount: number): Array<'left' | 'center' | 'right' | undefined> {
  const cells = splitTableCells(separatorLine);
  return Array.from({ length: columnCount }, (_, index) => {
    const cell = cells[index] ?? '';
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    if (cell.startsWith(':')) return 'left';
    return undefined;
  });
}

function renderMarkdownTable(lines: string[]): string {
  const [headerLine, separatorLine, ...bodyLines] = lines;
  const headers = splitTableCells(headerLine);
  const alignments = tableAlignments(separatorLine, headers.length);
  const cellStyle = (index: number) => (alignments[index] ? ` style="text-align:${alignments[index]}"` : '');
  const thead = `<thead><tr>${headers
    .map((cell, index) => `<th${cellStyle(index)}>${renderInlineHtml(cell)}</th>`)
    .join('')}</tr></thead>`;
  const tbody = bodyLines.length
    ? `<tbody>${bodyLines
        .map((line) => {
          const cells = splitTableCells(line);
          while (cells.length < headers.length) cells.push('');
          return `<tr>${cells
            .slice(0, headers.length)
            .map((cell, index) => `<td${cellStyle(index)}>${renderInlineHtml(cell)}</td>`)
            .join('')}</tr>`;
        })
        .join('')}</tbody>`
    : '';
  return `<div class="msg-table-wrap"><table class="msg-table">${thead}${tbody}</table></div>`;
}

export function renderMarkdownToHtml(source: string): string {
  const codeBlocks: string[] = [];
  const withoutCodeBlocks = source.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) => {
    const _ignoredLanguage = language;
    const index = codeBlocks.push(`<pre class="msg-code-block"><code>${escapeHtml(code.trimEnd())}</code></pre>`) - 1;
    return `@@CODE_BLOCK_${index}@@`;
  });

  const lines = withoutCodeBlocks.split('\n');
  const rendered: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^@@CODE_BLOCK_\d+@@$/.test(trimmed)) {
      rendered.push(trimmed);
      index += 1;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = Math.min(trimmed.match(/^#+/)?.[0].length ?? 1, 6);
      rendered.push(`<h${level}>${renderInlineHtml(trimmed.replace(/^#{1,6}\s+/, ''))}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHorizontalRule(trimmed)) {
      rendered.push('<hr />');
      index += 1;
      continue;
    }

    if (isTableBlock(lines, index)) {
      const tableLines = [lines[index].trim(), lines[index + 1].trim()];
      index += 2;
      while (index < lines.length) {
        const nextLine = lines[index].trim();
        if (!nextLine || !looksLikeTableRow(nextLine)) break;
        tableLines.push(nextLine);
        index += 1;
      }
      rendered.push(renderMarkdownTable(tableLines));
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quoteLine = lines[index].trim();
        if (!quoteLine.startsWith('>')) break;
        quoteLines.push(quoteLine.replace(/^>\s?/, ''));
        index += 1;
      }
      rendered.push(`<blockquote>${renderInlineHtml(quoteLines.join('\n')).replace(/\n/g, '<br />')}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const match = itemLine.match(/^[-*]\s+(.+)$/);
        if (!itemLine || !match) break;
        items.push(`<li>${renderInlineHtml(match[1])}</li>`);
        index += 1;
      }
      rendered.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemLine = lines[index].trim();
        const match = itemLine.match(/^\d+\.\s+(.+)$/);
        if (!itemLine || !match) break;
        items.push(`<li>${renderInlineHtml(match[1])}</li>`);
        index += 1;
      }
      rendered.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const paragraphLine = lines[index] ?? '';
      const paragraphTrimmed = paragraphLine.trim();
      if (
        !paragraphTrimmed ||
        /^@@CODE_BLOCK_\d+@@$/.test(paragraphTrimmed) ||
        /^#{1,6}\s+/.test(paragraphTrimmed) ||
        isHorizontalRule(paragraphTrimmed) ||
        paragraphTrimmed.startsWith('>') ||
        /^[-*]\s+/.test(paragraphTrimmed) ||
        /^\d+\.\s+/.test(paragraphTrimmed) ||
        isTableBlock(lines, index)
      ) {
        break;
      }
      paragraphLines.push(paragraphLine);
      index += 1;
    }
    rendered.push(`<p>${renderInlineHtml(paragraphLines.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return rendered.join('').replace(/@@CODE_BLOCK_(\d+)@@/g, (_match, indexText: string) => codeBlocks[Number(indexText)] ?? '');
}
