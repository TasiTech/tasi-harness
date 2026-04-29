import { basename, dirname, extname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

export interface ConvertedDocumentAsset {
  name: string;
  data: Buffer;
}

export interface ConvertedDocument {
  title: string;
  markdown: string;
  assets: ConvertedDocumentAsset[];
}

const XML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

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
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ');
}

function sanitizeName(input: string, fallback: string): string {
  const cleaned = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function finalizeMarkdown(lines: string[]): string {
  const merged = normalizeLineBreaks(lines.join('\n'));
  return `${merged.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function resolveZipPath(baseDir: string, target: string): string {
  return posix.normalize(posix.join(baseDir, target));
}

function attributeValue(tagAttributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}="([^"]*)"`);
  const match = tagAttributes.match(pattern);
  return match?.[1];
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`Missing required archive entry: ${path}`);
  return file.async('string');
}

async function ensureAsset(
  zip: JSZip,
  sourcePath: string,
  assets: ConvertedDocumentAsset[],
  assetMap: Map<string, string>,
  fallbackPrefix: string
): Promise<string | null> {
  if (assetMap.has(sourcePath)) return assetMap.get(sourcePath) ?? null;
  const file = zip.file(sourcePath);
  if (!file) return null;
  const original = basename(sourcePath);
  const ext = extname(original) || '.bin';
  const stem = original.slice(0, original.length - ext.length) || fallbackPrefix;
  const safeStem = sanitizeName(stem, fallbackPrefix);
  const baseName = `${safeStem}${ext.toLowerCase()}`;
  let assetName = baseName;
  let counter = 1;
  const usedNames = new Set(assets.map((asset) => asset.name));
  while (usedNames.has(assetName)) {
    assetName = `${safeStem}-${counter}${ext.toLowerCase()}`;
    counter += 1;
  }
  assets.push({ name: assetName, data: await file.async('nodebuffer') });
  assetMap.set(sourcePath, assetName);
  return assetName;
}

function parseRelationships(xml: string, baseDir: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = match[1] ?? '';
    const id = attributeValue(attrs, 'Id');
    const target = attributeValue(attrs, 'Target');
    if (!id || !target) continue;
    rels.set(id, resolveZipPath(baseDir, target));
  }
  return rels;
}

function extractDocxText(fragment: string): string {
  const tokens = fragment.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g) ?? [];
  let result = '';
  for (const token of tokens) {
    if (token.startsWith('<w:tab')) {
      result += '\t';
      continue;
    }
    if (token.startsWith('<w:br') || token.startsWith('<w:cr')) {
      result += '\n';
      continue;
    }
    const text = token.replace(/^<w:t\b[^>]*>/, '').replace(/<\/w:t>$/, '');
    result += decodeXmlEntities(text);
  }
  return normalizeLineBreaks(result)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMarkdownTable(rows: string[][]): string {
  const normalizedRows = rows
    .map((row) => row.map((cell) => cell.replace(/\n/g, '<br>').replace(/\|/g, '\\|').trim()))
    .filter((row) => row.some((cell) => cell.length > 0));
  if (normalizedRows.length === 0) return '';
  const columnCount = Math.max(...normalizedRows.map((row) => row.length));
  const padded = normalizedRows.map((row) => [...row, ...Array.from({ length: columnCount - row.length }, () => '')]);
  const header = padded[0];
  const body = padded.slice(1);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`
  ];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function renderDocxTable(tableXml: string): string {
  const rows: string[][] = [];
  for (const rowXml of tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells = (rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((cellXml) => extractDocxText(cellXml));
    rows.push(cells);
  }
  return renderMarkdownTable(rows);
}

async function convertDocx(title: string, buffer: Buffer): Promise<ConvertedDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await readZipText(zip, 'word/document.xml');
  const relsXml = zip.file('word/_rels/document.xml.rels') ? await readZipText(zip, 'word/_rels/document.xml.rels') : '';
  const rels = parseRelationships(relsXml, 'word');
  const assets: ConvertedDocumentAsset[] = [];
  const assetMap = new Map<string, string>();
  const lines: string[] = [`# ${title}`, ''];
  const blocks = documentXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g) ?? [];

  for (const block of blocks) {
    if (block.startsWith('<w:tbl')) {
      const table = renderDocxTable(block);
      if (table) {
        lines.push(table, '');
      }
      continue;
    }

    const text = extractDocxText(block);
    const headingLevel = block.match(/<w:pStyle\b[^>]*w:val="(?:Heading|heading)([1-6])"/)?.[1];
    const isTitle = /<w:pStyle\b[^>]*w:val="(?:Title|title)"/.test(block);
    const isList = /<w:numPr\b[\s\S]*?<\/w:numPr>/.test(block);
    const imageRefs: string[] = [];
    for (const relIdMatch of block.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const relId = relIdMatch[1];
      const target = rels.get(relId);
      if (!target) continue;
      const assetName = await ensureAsset(zip, target, assets, assetMap, `docx-image-${assets.length + 1}`);
      if (assetName) imageRefs.push(`![${assetName}](images/${assetName})`);
    }

    if (text) {
      if (headingLevel) lines.push(`${'#'.repeat(Number(headingLevel))} ${text}`);
      else if (isTitle) lines.push(`# ${text}`);
      else if (isList) lines.push(`- ${text}`);
      else lines.push(text);
      lines.push('');
    }

    if (imageRefs.length > 0) {
      lines.push(...imageRefs, '');
    }
  }

  return { title, markdown: finalizeMarkdown(lines), assets };
}

function columnRefToIndex(ref: string): number {
  let index = 0;
  for (const char of ref) {
    const code = char.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) continue;
    index = index * 26 + (code - 64);
  }
  return Math.max(0, index - 1);
}

function extractSharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const text = Array.from(match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((item) => decodeXmlEntities(item[1] ?? ''))
      .join('');
    values.push(text.trim());
  }
  return values;
}

function extractXlsxCellValue(cellXml: string, sharedStrings: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] ?? '';
  if (type === 'inlineStr') {
    return Array.from(cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((match) => decodeXmlEntities(match[1] ?? ''))
      .join('')
      .trim();
  }
  const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
  const value = decodeXmlEntities(raw).trim();
  if (type === 's') {
    const index = Number.parseInt(value, 10);
    return Number.isFinite(index) ? sharedStrings[index] ?? '' : '';
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return value;
}

function parseXlsxSheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowXml of sheetXml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = [];
    for (const cellXml of rowXml.match(/<c\b[\s\S]*?(?:<\/c>|\/>)/g) ?? []) {
      const cellRef = cellXml.match(/\br="([A-Z]+)\d+"/)?.[1] ?? '';
      const index = columnRefToIndex(cellRef);
      while (row.length <= index) row.push('');
      row[index] = extractXlsxCellValue(cellXml, sharedStrings);
    }
    rows.push(row);
  }
  return rows;
}

async function convertXlsx(title: string, buffer: Buffer): Promise<ConvertedDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await readZipText(zip, 'xl/workbook.xml');
  const workbookRelsXml = await readZipText(zip, 'xl/_rels/workbook.xml.rels');
  const sharedStrings = zip.file('xl/sharedStrings.xml') ? extractSharedStrings(await readZipText(zip, 'xl/sharedStrings.xml')) : [];
  const rels = parseRelationships(workbookRelsXml, 'xl');
  const sheetDefs = Array.from(workbookXml.matchAll(/<sheet\b([^>]*)\/>/g))
    .map((match) => {
      const attrs = match[1] ?? '';
      return {
        name: decodeXmlEntities(attributeValue(attrs, 'name') ?? 'Sheet'),
        relId: attributeValue(attrs, 'r:id') ?? ''
      };
    })
    .filter((sheet) => sheet.relId);
  const assets: ConvertedDocumentAsset[] = [];
  const assetMap = new Map<string, string>();
  const lines: string[] = [`# ${title}`, ''];

  for (const sheet of sheetDefs) {
    const target = rels.get(sheet.relId);
    if (!target) continue;
    const sheetXml = await readZipText(zip, target);
    const rows = parseXlsxSheetRows(sheetXml, sharedStrings);
    lines.push(`## Sheet: ${sheet.name}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('(Empty sheet)', '');
      continue;
    }
    const table = renderMarkdownTable(rows);
    lines.push(table || '(Unable to render sheet contents)', '');
  }

  for (const path of Object.keys(zip.files).filter((item) => item.startsWith('xl/media/') && !zip.files[item].dir).sort()) {
    const assetName = await ensureAsset(zip, path, assets, assetMap, `sheet-image-${assets.length + 1}`);
    if (!assetName) continue;
    if (!lines.includes('## Embedded Images')) {
      lines.push('## Embedded Images', '');
    }
    lines.push(`![${assetName}](images/${assetName})`, '');
  }

  return { title, markdown: finalizeMarkdown(lines), assets };
}

async function convertPptx(title: string, buffer: Buffer): Promise<ConvertedDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const assets: ConvertedDocumentAsset[] = [];
  const assetMap = new Map<string, string>();
  const lines: string[] = [`# ${title}`, ''];
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left.match(/slide(\d+)\.xml/i)?.[1] ?? '0', 10);
      const rightIndex = Number.parseInt(right.match(/slide(\d+)\.xml/i)?.[1] ?? '0', 10);
      return leftIndex - rightIndex;
    });

  for (const slidePath of slidePaths) {
    const slideNumber = Number.parseInt(slidePath.match(/slide(\d+)\.xml/i)?.[1] ?? '0', 10) || 0;
    const slideXml = await readZipText(zip, slidePath);
    const relsPath = slidePath.replace(/slides\/([^/]+)\.xml$/i, 'slides/_rels/$1.xml.rels');
    const rels = zip.file(relsPath) ? parseRelationships(await readZipText(zip, relsPath), 'ppt/slides') : new Map<string, string>();
    const texts = Array.from(slideXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
      .map((match) => decodeXmlEntities(match[1] ?? '').trim())
      .filter(Boolean);

    lines.push(`## Slide ${slideNumber || lines.length}`, '');
    if (texts.length > 0) {
      lines.push(`### ${texts[0]}`);
      lines.push('');
      for (const bullet of texts.slice(1)) lines.push(`- ${bullet}`);
      lines.push('');
    }

    for (const relIdMatch of slideXml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
      const target = rels.get(relIdMatch[1]);
      if (!target) continue;
      const assetName = await ensureAsset(zip, target, assets, assetMap, `slide-${slideNumber}-image-${assets.length + 1}`);
      if (assetName) lines.push(`![${assetName}](images/${assetName})`, '');
    }
  }

  return { title, markdown: finalizeMarkdown(lines), assets };
}

function convertTextLikeDocument(title: string, ext: string, buffer: Buffer): ConvertedDocument {
  const text = buffer.toString('utf8');
  if (ext === '.md' || ext === '.markdown') return { title, markdown: normalizeLineBreaks(text).trim() + '\n', assets: [] };
  if (ext === '.json') {
    return { title, markdown: finalizeMarkdown([`# ${title}`, '', '```json', text.trim(), '```']), assets: [] };
  }
  return { title, markdown: finalizeMarkdown([`# ${title}`, '', text.trim()]), assets: [] };
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
    if (ordered.length >= 600) break;
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

async function convertPdfWithPdfJs(title: string, buffer: Buffer): Promise<ConvertedDocument | null> {
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
    const lines: string[] = [`# ${title}`, ''];
    let extractedAny = false;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ disableCombineTextItems: false } as Record<string, unknown>);
      const items = (Array.isArray(textContent?.items) ? textContent.items : []) as Array<{ str?: string; hasEOL?: boolean }>;
      const segments: string[] = [];
      let current = '';
      for (const item of items) {
        const text = String(item.str ?? '').trim();
        if (!text) continue;
        current += current ? ` ${text}` : text;
        if (item.hasEOL) {
          if (current.trim()) segments.push(current.trim());
          current = '';
        }
      }
      if (current.trim()) segments.push(current.trim());
      const content = segments.join('\n').trim();
      if (!content) continue;
      extractedAny = true;
      lines.push(`## Page ${pageNumber}`, '', content, '');
    }
    await pdf.cleanup();
    await pdf.destroy();
    if (!extractedAny) return null;
    return { title, markdown: finalizeMarkdown(lines), assets: [] };
  } catch {
    return null;
  }
}

async function convertPdf(title: string, buffer: Buffer): Promise<ConvertedDocument> {
  const viaPdfJs = await convertPdfWithPdfJs(title, buffer);
  if (viaPdfJs) return viaPdfJs;
  const rawPdf = buffer.toString('latin1');
  const extractedLines = extractPdfTextCandidates(rawPdf);
  const fallbackText = extractedLines.length > 0
    ? extractedLines.join('\n')
    : '(No extractable PDF text found. The file may be scanned or encoded in an unsupported way.)';
  return {
    title,
    markdown: finalizeMarkdown([`# ${title}`, '', fallbackText]),
    assets: []
  };
}

export async function convertDocumentToMarkdown(filename: string, buffer: Buffer): Promise<ConvertedDocument> {
  const ext = extname(filename).toLowerCase();
  const title = basename(filename, ext) || 'document';

  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    throw new Error(`Legacy Office format ${ext} is not supported. Please convert it to ${ext}x first.`);
  }

  if (ext === '.docx') return convertDocx(title, buffer);
  if (ext === '.xlsx') return convertXlsx(title, buffer);
  if (ext === '.pptx') return convertPptx(title, buffer);
  if (ext === '.pdf') return convertPdf(title, buffer);
  if (['.md', '.markdown', '.txt', '.text', '.log', '.json', '.csv'].includes(ext)) {
    return convertTextLikeDocument(title, ext, buffer);
  }

  throw new Error(`Unsupported document type: ${ext || '(no extension)'}. Supported types: .md, .txt, .json, .csv, .docx, .xlsx, .pptx, .pdf`);
}
