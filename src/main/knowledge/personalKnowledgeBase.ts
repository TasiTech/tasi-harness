import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { PersonalKnowledgeDocument, PersonalKnowledgeState, PersonalKnowledgeUploadRequest } from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { JsonFileStore } from '../storage/jsonFileStore.js';
import { ensureDir } from '../storage/pathUtils.js';
import { convertDocumentToMarkdown } from './documentConverter.js';
import type { PersonalKnowledgeKeywordExtractor } from './keywordExtractor.js';

interface PersonalKnowledgeChunkRecord {
  id: string;
  docId: string;
  docTitle: string;
  filename: string;
  heading: string;
  content: string;
}

interface PersonalKnowledgeIndex {
  docs: PersonalKnowledgeDocument[];
}

interface SearchHit extends PersonalKnowledgeChunkRecord {
  score: number;
}

interface PersonalKnowledgeBaseOptions {
  keywordExtractor?: PersonalKnowledgeKeywordExtractor;
}

const INDEX_FILE = 'documents.v1.json';
const CHUNKS_FILE = 'chunks.v1.json';
const MARKDOWN_FILE = 'document.md';
const IMAGES_DIR = 'images';
const SOURCE_DIR = 'source';
const MAX_CHUNK_CHARS = 1400;
const MAX_PROMPT_CHARS = 7000;

function normalizeLineBreaks(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sanitizeFilename(input: string, fallback: string): string {
  const safe = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return safe || fallback;
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}

function excerptFor(text: string, maxLength = 180): string {
  const compact = normalizeLineBreaks(text).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function tokenizeQuery(query: string): string[] {
  const raw = normalizeLineBreaks(query).toLowerCase();
  const terms: string[] = [];
  for (const part of raw.match(/[a-z0-9._-]{2,}/g) ?? []) {
    terms.push(part);
  }
  for (const run of raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    terms.push(run);
    const maxGram = Math.min(4, run.length);
    for (let size = 2; size <= maxGram; size++) {
      for (let index = 0; index <= run.length - size; index++) {
        terms.push(run.slice(index, index + size));
      }
    }
  }
  return [...new Set(terms)].slice(0, 48);
}

function dedupeTerms(input: string[], limit = 64): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const normalized = item.trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function splitOversizedBlock(block: string, maxChars: number): string[] {
  const normalized = block.trim();
  if (normalized.length <= maxChars) return [normalized];
  const sentences = normalized.split(/(?<=[.!?\u3002\uff01\uff1f])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChars && current) {
      pieces.push(current);
      current = sentence;
      continue;
    }
    current = next;
  }
  if (current) pieces.push(current);
  if (pieces.length === 1 && pieces[0].length > maxChars) {
    const chunks: string[] = [];
    for (let i = 0; i < normalized.length; i += maxChars) chunks.push(normalized.slice(i, i + maxChars));
    return chunks;
  }
  return pieces;
}

function splitIntoChunks(markdown: string, doc: Pick<PersonalKnowledgeDocument, 'id' | 'title' | 'filename'>): PersonalKnowledgeChunkRecord[] {
  const lines = normalizeLineBreaks(markdown).split('\n');
  const chunks: PersonalKnowledgeChunkRecord[] = [];
  let currentHeading = doc.title;
  let sectionLines: string[] = [];

  const flushSection = () => {
    const sectionText = sectionLines.join('\n').trim();
    sectionLines = [];
    if (!sectionText) return;
    const blocks = sectionText
      .split(/\n\s*\n/g)
      .map((block) => block.trim())
      .filter(Boolean)
      .flatMap((block) => splitOversizedBlock(block, MAX_CHUNK_CHARS));
    let current = '';
    for (const block of blocks) {
      const next = current ? `${current}\n\n${block}` : block;
      if (next.length > MAX_CHUNK_CHARS && current) {
        chunks.push({
          id: createId('pkbchunk'),
          docId: doc.id,
          docTitle: doc.title,
          filename: doc.filename,
          heading: currentHeading,
          content: current
        });
        current = block;
      } else {
        current = next;
      }
    }
    if (current) {
      chunks.push({
        id: createId('pkbchunk'),
        docId: doc.id,
        docTitle: doc.title,
        filename: doc.filename,
        heading: currentHeading,
        content: current
      });
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[2].trim();
      continue;
    }
    sectionLines.push(line);
  }
  flushSection();

  if (chunks.length === 0) {
    const fallback = normalizeLineBreaks(markdown).trim();
    if (fallback) {
      for (const block of splitOversizedBlock(fallback, MAX_CHUNK_CHARS)) {
        chunks.push({
          id: createId('pkbchunk'),
          docId: doc.id,
          docTitle: doc.title,
          filename: doc.filename,
          heading: doc.title,
          content: block
        });
      }
    }
  }

  return chunks;
}

function scoreChunk(query: string, tokens: string[], chunk: PersonalKnowledgeChunkRecord): number {
  const queryText = query.toLowerCase().trim();
  const title = `${chunk.docTitle} ${chunk.heading} ${chunk.filename}`.toLowerCase();
  const content = chunk.content.toLowerCase();
  let score = 0;
  if (queryText && content.includes(queryText)) score += 8;
  if (queryText && title.includes(queryText)) score += 5;
  for (const token of tokens) {
    if (content.includes(token)) score += 1.5 + Math.min(3, content.split(token).length - 1) * 0.2;
    if (title.includes(token)) score += 2;
  }
  return score;
}

export class PersonalKnowledgeBase {
  private readonly root: string;
  private readonly docsRoot: string;
  private readonly indexStore: JsonFileStore<PersonalKnowledgeIndex>;
  private readonly keywordExtractor?: PersonalKnowledgeKeywordExtractor;
  private readonly keywordCache = new Map<string, string[]>();

  constructor(harnessHome: string, options: PersonalKnowledgeBaseOptions = {}) {
    this.root = ensureDir(join(harnessHome, 'personal-knowledge'));
    this.docsRoot = ensureDir(join(this.root, 'docs'));
    this.indexStore = new JsonFileStore<PersonalKnowledgeIndex>(join(this.root, INDEX_FILE), () => ({ docs: [] }));
    this.keywordExtractor = options.keywordExtractor;
  }

  listDocuments(): PersonalKnowledgeDocument[] {
    return [...this.indexStore.read().docs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getState(): PersonalKnowledgeState {
    const docs = this.listDocuments();
    return {
      docs,
      totalDocs: docs.length,
      totalChunks: docs.reduce((sum, doc) => sum + doc.chunkCount, 0),
      totalChars: docs.reduce((sum, doc) => sum + doc.charCount, 0)
    };
  }

  async addDocument(req: PersonalKnowledgeUploadRequest): Promise<PersonalKnowledgeDocument> {
    const filename = sanitizeFilename(req.filename || 'document', 'document');
    const sourceExt = extname(filename).toLowerCase();
    const content = Buffer.from(req.contentBase64, 'base64');
    const converted = await convertDocumentToMarkdown(filename, content);
    const id = createId('pkbdoc');
    const createdAt = nowIso();
    const docDir = ensureDir(join(this.docsRoot, id));
    const sourceDir = ensureDir(join(docDir, SOURCE_DIR));
    const imagesDir = ensureDir(join(docDir, IMAGES_DIR));
    const sourcePath = join(sourceDir, filename);
    const markdownPath = join(docDir, MARKDOWN_FILE);
    writeFileSync(sourcePath, content);
    writeFileSync(markdownPath, ensureTrailingNewline(converted.markdown), 'utf8');
    for (const asset of converted.assets) {
      writeFileSync(join(imagesDir, asset.name), asset.data);
    }

    const docMetaBase = {
      id,
      title: converted.title,
      filename,
      sourceExt,
      sourcePath,
      markdownPath,
      imagesDir: converted.assets.length > 0 ? imagesDir : undefined,
      createdAt,
      updatedAt: createdAt
    };
    const chunks = splitIntoChunks(converted.markdown, {
      id,
      title: docMetaBase.title,
      filename
    });
    writeFileSync(join(docDir, CHUNKS_FILE), `${JSON.stringify(chunks, null, 2)}\n`, 'utf8');

    const nextDoc: PersonalKnowledgeDocument = {
      ...docMetaBase,
      chunkCount: chunks.length,
      charCount: converted.markdown.length,
      excerpt: excerptFor(converted.markdown)
    };

    const current = this.indexStore.read();
    current.docs = [nextDoc, ...current.docs.filter((doc) => doc.id !== id)];
    this.indexStore.write(current);
    return nextDoc;
  }

  deleteDocument(id: string): boolean {
    const current = this.indexStore.read();
    const existing = current.docs.find((doc) => doc.id === id);
    if (!existing) return false;
    rmSync(join(this.docsRoot, id), { recursive: true, force: true });
    current.docs = current.docs.filter((doc) => doc.id !== id);
    this.indexStore.write(current);
    return true;
  }

  private async resolveSearchTerms(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const localTerms = tokenizeQuery(trimmed);
    const cacheKey = trimmed.toLowerCase();
    let extracted = this.keywordCache.get(cacheKey);
    if (!extracted && this.keywordExtractor) {
      extracted = dedupeTerms(await this.keywordExtractor(trimmed, this.listDocuments()), 24);
      this.keywordCache.set(cacheKey, extracted);
    }
    return dedupeTerms([trimmed, ...(extracted ?? []), ...localTerms]);
  }

  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const tokens = await this.resolveSearchTerms(trimmed);
    const docs = this.listDocuments();
    const hits: SearchHit[] = [];
    for (const doc of docs) {
      const chunksPath = join(this.docsRoot, doc.id, CHUNKS_FILE);
      if (!existsSync(chunksPath)) continue;
      const raw = readFileSync(chunksPath, 'utf8');
      const chunks = JSON.parse(raw) as PersonalKnowledgeChunkRecord[];
      for (const chunk of chunks) {
        const score = scoreChunk(trimmed, tokens, chunk);
        if (score <= 0) continue;
        hits.push({ ...chunk, score });
      }
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, Math.max(1, limit));
  }

  async renderPromptBlock(query: string, options: { limit?: number; maxChars?: number } = {}): Promise<string> {
    const docs = this.listDocuments();
    if (docs.length === 0) return '(no personal knowledge documents)';
    const hits = await this.search(query, Math.max(1, options.limit ?? 5));
    if (hits.length === 0) return '(no relevant personal knowledge matches)';

    const lines = ['## Personal Knowledge Base Matches'];
    const maxChars = options.maxChars ?? MAX_PROMPT_CHARS;
    let used = 0;
    for (const hit of hits) {
      const snippet = excerptFor(hit.content, 1100);
      if (used + snippet.length > maxChars && used > 0) break;
      lines.push(`- [${hit.filename}${hit.heading && hit.heading !== hit.docTitle ? ` > ${hit.heading}` : ''}]`);
      lines.push(snippet);
      lines.push('');
      used += snippet.length;
    }
    return lines.join('\n').trim();
  }
}
