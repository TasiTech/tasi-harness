import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { nowIso } from '../../shared/types.js';

export interface ConvertedSessionDocumentXml {
  xml: string;
  commentCount: number;
}

interface SessionDocumentPart {
  name: string;
  content: string;
}

const XML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

function escapeXmlAttr(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toSafeCdata(input: string): string {
  return input.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

async function readZipTextOptional(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  return file.async('string');
}

function countCommentLikeElements(input: string): number {
  return (input.match(/<(?:[A-Za-z_][\w.-]*:)?(?:comment|cm)\b/g) ?? []).length;
}

function normalizeLineBreaks(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    if (entity in XML_ENTITY_MAP) return XML_ENTITY_MAP[entity];
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

function decodeXmlText(input: string): string {
  return decodeXmlEntities(input)
    .replace(/<[^>]+>/g, '\n')
    .replace(/\u00a0/g, ' ');
}

function buildSessionXmlDocument(
  filename: string,
  sourceExt: string,
  parts: SessionDocumentPart[],
  commentCount: number,
  extraSummaryAttrs: Record<string, string | number> = {}
): ConvertedSessionDocumentXml {
  const summaryAttrs = [
    `comment_count="${commentCount}"`,
    `part_count="${parts.length}"`,
    ...Object.entries(extraSummaryAttrs).map(([key, value]) => `${key}="${escapeXmlAttr(String(value))}"`)
  ];
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<session_document filename="${escapeXmlAttr(filename)}" source_ext="${escapeXmlAttr(sourceExt)}" generated_at="${escapeXmlAttr(nowIso())}">`,
    `  <summary ${summaryAttrs.join(' ')} />`,
    '  <parts>'
  ];
  for (const part of parts) {
    lines.push(`    <part name="${escapeXmlAttr(part.name)}">`);
    lines.push('      <content><![CDATA[');
    lines.push(toSafeCdata(part.content));
    lines.push('      ]]></content>');
    lines.push('    </part>');
  }
  lines.push('  </parts>');
  lines.push('</session_document>');
  return {
    xml: `${lines.join('\n')}\n`,
    commentCount
  };
}

async function convertDocxToXml(filename: string, buffer: Buffer): Promise<ConvertedSessionDocumentXml> {
  const zip = await JSZip.loadAsync(buffer);
  const parts: SessionDocumentPart[] = [];

  const documentXml = await readZipTextOptional(zip, 'word/document.xml');
  if (!documentXml) throw new Error('Invalid .docx: missing word/document.xml');
  parts.push({ name: 'word/document.xml', content: documentXml });

  const optionalPartNames = [
    'word/comments.xml',
    'word/commentsExtended.xml',
    'word/commentsExtensible.xml',
    'word/people.xml',
    'word/footnotes.xml',
    'word/endnotes.xml',
    'word/_rels/document.xml.rels'
  ];
  for (const partName of optionalPartNames) {
    const text = await readZipTextOptional(zip, partName);
    if (text != null) parts.push({ name: partName, content: text });
  }

  const commentsPart = parts.find((part) => part.name === 'word/comments.xml')?.content ?? '';
  const commentCount = (commentsPart.match(/<w:comment\b/g) ?? []).length;

  return buildSessionXmlDocument(filename, '.docx', parts, commentCount);
}

async function convertOpenXmlPackageToXml(
  filename: string,
  sourceExt: '.pptx' | '.xlsx',
  buffer: Buffer,
  packageRoot: 'ppt' | 'xl',
  requiredEntry: string
): Promise<ConvertedSessionDocumentXml> {
  const zip = await JSZip.loadAsync(buffer);
  const requiredFile = zip.file(requiredEntry);
  if (!requiredFile) throw new Error(`Invalid ${sourceExt}: missing ${requiredEntry}`);
  const partNames = Object.keys(zip.files)
    .filter((partName) => {
      const part = zip.files[partName];
      if (!part || part.dir) return false;
      const lower = partName.toLowerCase();
      const isXmlLike = lower.endsWith('.xml') || lower.endsWith('.rels');
      if (!isXmlLike) return false;
      return (
        lower === '[content_types].xml' ||
        lower.startsWith('_rels/') ||
        lower.startsWith(`${packageRoot}/`)
      );
    })
    .sort((left, right) => left.localeCompare(right));
  const parts: SessionDocumentPart[] = [];
  for (const partName of partNames) {
    const content = await zip.file(partName)?.async('string');
    if (typeof content !== 'string') continue;
    parts.push({ name: partName, content });
  }
  const commentCount = parts.reduce((total, part) => total + countCommentLikeElements(part.content), 0);
  return buildSessionXmlDocument(filename, sourceExt, parts, commentCount);
}

function extractOfdXmlText(input: string): string {
  const textCodes = Array.from(input.matchAll(/<(?:[A-Za-z_][\w.-]*:)?TextCode\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?TextCode>/g))
    .map((match) => decodeXmlText(match[1] ?? '').trim())
    .filter(Boolean);
  const rawText = textCodes.length > 0 ? textCodes.join('\n') : decodeXmlText(input);
  return normalizeLineBreaks(rawText)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function rankOfdEntry(path: string): number {
  const lower = path.toLowerCase();
  if (/content\.xml$/.test(lower) || /page_\d+\.xml$/.test(lower) || /\/pages?\//.test(lower)) return 0;
  if (/document\.xml$/.test(lower) || lower.endsWith('/ofd.xml') || lower === 'ofd.xml') return 1;
  if (lower.endsWith('.xml')) return 2;
  if (lower.endsWith('.txt')) return 3;
  return 4;
}

async function convertOfdToXml(filename: string, buffer: Buffer): Promise<ConvertedSessionDocumentXml> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files)
    .filter((path) => {
      const entry = zip.files[path];
      if (!entry || entry.dir) return false;
      const lower = path.toLowerCase();
      return lower.endsWith('.xml') || lower.endsWith('.txt');
    })
    .sort((left, right) => {
      const rankDelta = rankOfdEntry(left) - rankOfdEntry(right);
      return rankDelta || left.localeCompare(right);
    });
  const parts: SessionDocumentPart[] = [];
  let totalChars = 0;
  for (const entryName of entries) {
    if (parts.length >= 60 || totalChars >= 250_000) break;
    const file = zip.file(entryName);
    if (!file) continue;
    const raw = await file.async('string');
    const lower = entryName.toLowerCase();
    const text = lower.endsWith('.xml')
      ? extractOfdXmlText(raw)
      : normalizeLineBreaks(raw).replace(/\u00a0/g, ' ').trim();
    if (!text) continue;
    const remaining = 250_000 - totalChars;
    const clipped = text.length > remaining ? `${text.slice(0, remaining).trim()}\n...(truncated)` : text;
    parts.push({ name: `ofd/extracted-text/${entryName}`, content: clipped });
    totalChars += clipped.length;
  }
  if (parts.length === 0) {
    parts.push({
      name: 'ofd/extracted-text.txt',
      content: '(No extractable OFD text found. The file may require a dedicated OFD renderer or OCR.)'
    });
  }
  return buildSessionXmlDocument(filename, '.ofd', parts, 0, {
    extraction: 'best-effort',
    package_text_part_count: parts.length
  });
}

function decodePdfLiteralString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[i + 1];
    if (next == null) break;
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(') out += '(';
    else if (next === ')') out += ')';
    else if (next === '\\') out += '\\';
    else if (next === '\n' || next === '\r') {
      if (next === '\r' && raw[i + 1] === '\n') i += 1;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let offset = 1; offset <= 2; offset += 1) {
        const digit = raw[i + offset];
        if (!digit || !/[0-7]/.test(digit)) break;
        octal += digit;
      }
      i += octal.length - 1;
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexString(raw: string): string {
  const compact = raw.replace(/[^0-9a-fA-F]/g, '');
  if (compact.length === 0) return '';
  const normalized = compact.length % 2 === 0 ? compact : `${compact}0`;
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 2) {
    bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
  }
  return Buffer.from(bytes).toString('latin1');
}

function decodePdfAnnotationContents(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePdfExtractedText(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPdfTextCandidates(rawPdf: string): string[] {
  const found: string[] = [];
  for (const match of rawPdf.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|')/g)) {
    const decoded = normalizePdfExtractedText(decodePdfLiteralString(match[1] ?? ''));
    if (decoded) found.push(decoded);
  }
  for (const match of rawPdf.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) {
    const decoded = normalizePdfExtractedText(decodePdfHexString(match[1] ?? ''));
    if (decoded) found.push(decoded);
  }
  for (const match of rawPdf.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    const body = match[1] ?? '';
    for (const textChunk of body.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]+)>/g)) {
      const rawLiteral = textChunk[1];
      const rawHex = textChunk[2];
      const decoded = rawLiteral != null
        ? normalizePdfExtractedText(decodePdfLiteralString(rawLiteral))
        : normalizePdfExtractedText(decodePdfHexString(rawHex ?? ''));
      if (decoded) found.push(decoded);
    }
  }
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const item of found) {
    if (unique.has(item)) continue;
    unique.add(item);
    ordered.push(item);
    if (ordered.length >= 500) break;
  }
  return ordered;
}

function ensureDomMatrixPolyfill(): void {
  const globalRef = globalThis as Record<string, unknown>;
  if (typeof globalRef.DOMMatrix === 'function') return;
  class MinimalDOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;

    multiply(_other?: unknown): MinimalDOMMatrix {
      return this;
    }
  }
  globalRef.DOMMatrix = MinimalDOMMatrix;
}

function parseHighlightRect(rect: unknown): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (!Array.isArray(rect) || rect.length < 4) return null;
  const nums = rect.slice(0, 4).map((item) => Number(item));
  if (nums.some((num) => !Number.isFinite(num))) return null;
  const [x1, y1, x2, y2] = nums;
  return {
    minX: Math.min(x1, x2),
    maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2)
  };
}

function compactTextWithEol(items: Array<{ str: string; hasEOL?: boolean }>): string {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const fragment = item.str.trim();
    if (!fragment) continue;
    current += current ? ` ${fragment}` : fragment;
    if (item.hasEOL) {
      lines.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join('\n');
}

function collectHighlightTextByRect(
  textItems: Array<{ str: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }>,
  rect: { minX: number; maxX: number; minY: number; maxY: number }
): string {
  const padding = 8;
  const matched: Array<{ x: number; y: number; str: string; hasEOL?: boolean }> = [];
  for (const item of textItems) {
    const tx = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(tx[4]);
    const y = Number(tx[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < rect.minX - padding || x > rect.maxX + padding || y < rect.minY - padding || y > rect.maxY + padding) continue;
    const str = item.str?.trim() ?? '';
    if (!str) continue;
    matched.push({ x, y, str, hasEOL: item.hasEOL });
  }
  if (matched.length === 0) return '';
  matched.sort((left, right) => {
    if (Math.abs(right.y - left.y) > 4) return right.y - left.y;
    return left.x - right.x;
  });
  return compactTextWithEol(matched);
}

async function tryConvertPdfWithPdfJs(filename: string, buffer: Buffer): Promise<ConvertedSessionDocumentXml | null> {
  try {
    ensureDomMatrixPolyfill();
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontsPath = join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/pdfjs-dist/standard_fonts');
    const standardFontDataUrl = `${pathToFileURL(standardFontsPath).href.replace(/\/?$/, '/')}`;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl
    } as Record<string, unknown>);
    const pdf = await loadingTask.promise;
    const pageCount = Number(pdf.numPages) || 0;
    const pageTexts: string[] = [];
    const highlights: Array<{ page: number; rect: number[]; contents: string; extractedText: string }> = [];
    let annotationCount = 0;
    let textItemCount = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableCombineTextItems: false } as Record<string, unknown>);
      const items = (Array.isArray(textContent?.items) ? textContent.items : []) as Array<{
        str: string;
        hasEOL?: boolean;
        transform?: number[];
        width?: number;
        height?: number;
      }>;
      const cleanedItems = items.filter((item) => typeof item.str === 'string' && item.str.trim());
      textItemCount += cleanedItems.length;
      const pageText = compactTextWithEol(cleanedItems).trim();
      if (pageText) pageTexts.push(`## Page ${pageNumber}\n${pageText}`);

      const annotations = await page.getAnnotations();
      annotationCount += annotations.length;
      for (const annotation of annotations as Array<Record<string, unknown>>) {
        if (annotation.subtype !== 'Highlight') continue;
        const rectRaw = Array.isArray(annotation.rect) ? annotation.rect.map((value) => Number(value)) : [];
        const rect = parseHighlightRect(annotation.rect);
        const extractedText = rect ? collectHighlightTextByRect(cleanedItems, rect) : '';
        const contents = decodePdfAnnotationContents(annotation.contents);
        highlights.push({
          page: pageNumber,
          rect: rectRaw,
          contents,
          extractedText: extractedText || contents
        });
      }
    }

    await pdf.cleanup();
    await pdf.destroy();

    const highlightLines: string[] = ['<highlights>'];
    for (const highlight of highlights) {
      highlightLines.push(
        `  <highlight page="${highlight.page}" rect="${highlight.rect.join(',')}">`,
        `    <contents>${escapeXmlAttr(highlight.contents || '(empty)')}</contents>`,
        `    <text>${escapeXmlAttr(highlight.extractedText || '(no text matched)')}</text>`,
        '  </highlight>'
      );
    }
    highlightLines.push('</highlights>');
    const parts: SessionDocumentPart[] = [
      { name: 'pdf/highlights.xml', content: highlightLines.join('\n') },
      { name: 'pdf/extracted-text.txt', content: pageTexts.join('\n\n') || '(No extractable text found)' }
    ];
    return buildSessionXmlDocument(filename, '.pdf', parts, Math.max(highlights.length, annotationCount), {
      page_count: pageCount,
      text_item_count: textItemCount
    });
  } catch {
    return null;
  }
}

function convertPdfToXmlFallback(filename: string, buffer: Buffer): ConvertedSessionDocumentXml {
  const rawPdf = buffer.toString('latin1');
  const pageCount = (rawPdf.match(/\/Type\s*\/Page\b/g) ?? []).length;
  const annotationMatches = Array.from(rawPdf.matchAll(/\/Subtype\s*\/([A-Za-z]+)/g));
  const annotationCount = annotationMatches.length;
  const subtypeCounts = new Map<string, number>();
  for (const match of annotationMatches) {
    const subtype = match[1] ?? 'Unknown';
    subtypeCounts.set(subtype, (subtypeCounts.get(subtype) ?? 0) + 1);
  }
  const extractedLines = extractPdfTextCandidates(rawPdf);
  const extractedText = extractedLines.length > 0
    ? extractedLines.join('\n')
    : '(No extractable PDF text found in content streams. The file might be scanned or use unsupported encoding/compression.)';
  const annotationSummary = subtypeCounts.size > 0
    ? Array.from(subtypeCounts.entries()).map(([name, count]) => `${name}: ${count}`).join('\n')
    : '(No explicit PDF annotations detected)';
  const parts: SessionDocumentPart[] = [
    { name: 'pdf/extracted-text.txt', content: extractedText },
    { name: 'pdf/annotation-summary.txt', content: annotationSummary }
  ];
  return buildSessionXmlDocument(filename, '.pdf', parts, annotationCount, {
    page_count: pageCount,
    text_item_count: extractedLines.length
  });
}

async function convertPdfToXml(filename: string, buffer: Buffer): Promise<ConvertedSessionDocumentXml> {
  const converted = await tryConvertPdfWithPdfJs(filename, buffer);
  if (converted) return converted;
  return convertPdfToXmlFallback(filename, buffer);
}

function convertTextLikeToXml(filename: string, buffer: Buffer, sourceExt: string): ConvertedSessionDocumentXml {
  const text = buffer.toString('utf8');
  const title = basename(filename, sourceExt) || 'document';
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<session_document filename="${escapeXmlAttr(filename)}" source_ext="${escapeXmlAttr(sourceExt)}" generated_at="${escapeXmlAttr(nowIso())}">`,
    `  <summary comment_count="0" part_count="1" title="${escapeXmlAttr(title)}" />`,
    '  <parts>',
    `    <part name="${escapeXmlAttr(filename)}">`,
    '      <content><![CDATA[',
    toSafeCdata(text),
    '      ]]></content>',
    '    </part>',
    '  </parts>',
    '</session_document>',
    ''
  ].join('\n');
  return {
    xml,
    commentCount: 0
  };
}

export async function convertDocumentToSessionXml(filename: string, buffer: Buffer): Promise<ConvertedSessionDocumentXml> {
  const sourceExt = extname(filename).toLowerCase();
  if (sourceExt === '.docx') return convertDocxToXml(filename, buffer);
  if (sourceExt === '.pptx') return convertOpenXmlPackageToXml(filename, '.pptx', buffer, 'ppt', 'ppt/presentation.xml');
  if (sourceExt === '.xlsx') return convertOpenXmlPackageToXml(filename, '.xlsx', buffer, 'xl', 'xl/workbook.xml');
  if (sourceExt === '.pdf') return convertPdfToXml(filename, buffer);
  if (sourceExt === '.ofd') return convertOfdToXml(filename, buffer);
  if (['.xml', '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.text'].includes(sourceExt)) {
    return convertTextLikeToXml(filename, buffer, sourceExt || '.txt');
  }
  throw new Error(
    `Unsupported document type: ${sourceExt || '(no extension)'}. Supported types: .docx, .pptx, .xlsx, .pdf, .ofd, .xml, .txt, .md, .json, .csv`
  );
}
