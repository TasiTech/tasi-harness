import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SessionDocumentContext, SessionDocumentUploadRequest } from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { JsonFileStore } from '../storage/jsonFileStore.js';
import { ensureDir } from '../storage/pathUtils.js';
import { convertDocumentToSessionXml } from './documentXmlConverter.js';

interface SessionDocumentIndex {
  docs: SessionDocumentContext[];
}

const INDEX_FILE = 'index.v1.json';
const DOCS_DIR = 'docs';
const XML_FILE = 'document.xml';
const WORKSPACE_DOCS_DIR = 'session-documents';

function sanitizeFilename(input: string, fallback: string): string {
  const safe = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || fallback;
}

function excerptFor(text: string, maxLength = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function splitNameAndExt(filename: string): { name: string; ext: string } {
  const ext = extname(filename);
  if (!ext) return { name: filename, ext: '' };
  return { name: filename.slice(0, -ext.length), ext };
}

function resolveWorkspaceSessionDir(workspaceDir: string, sessionId: string): string {
  return ensureDir(join(workspaceDir, WORKSPACE_DOCS_DIR, sanitizeFilename(sessionId, 'session')));
}

function resolveWorkspaceDocumentDir(workspaceDir: string, sessionId: string, id: string): string {
  return ensureDir(join(resolveWorkspaceSessionDir(workspaceDir, sessionId), DOCS_DIR, sanitizeFilename(id, 'document')));
}

function resolveWorkspaceCopyPath(workspaceDir: string, sessionId: string, filename: string): string {
  const sessionDir = resolveWorkspaceSessionDir(workspaceDir, sessionId);
  const cleanName = sanitizeFilename(filename, 'document');
  const { name, ext } = splitNameAndExt(cleanName);
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const candidate = join(sessionDir, `${name}${suffix}${ext}`);
    if (!existsSync(candidate)) return candidate;
    attempt += 1;
  }
  const unixTime = Date.now();
  return join(sessionDir, `${name}-${unixTime}${ext}`);
}

export class SessionDocumentContextStore {
  private readonly root: string;
  private readonly docsRoot: string;
  private readonly indexStore: JsonFileStore<SessionDocumentIndex>;

  constructor(harnessHome: string) {
    this.root = ensureDir(join(harnessHome, 'session-documents'));
    this.docsRoot = ensureDir(join(this.root, DOCS_DIR));
    this.indexStore = new JsonFileStore<SessionDocumentIndex>(join(this.root, INDEX_FILE), () => ({ docs: [] }));
  }

  list(sessionId: string): SessionDocumentContext[] {
    const cleanSessionId = sessionId.trim();
    if (!cleanSessionId) return [];
    return this.indexStore
      .read()
      .docs
      .filter((doc) => doc.sessionId === cleanSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async addDocument(req: SessionDocumentUploadRequest & { sessionId: string; workspaceDir?: string }): Promise<SessionDocumentContext> {
    const sessionId = req.sessionId.trim();
    if (!sessionId) throw new Error('sessionId is required.');
    const filename = sanitizeFilename(req.filename || 'document.docx', 'document.docx');
    const sourceExt = extname(filename).toLowerCase() || '.txt';
    const content = Buffer.from(req.contentBase64, 'base64');
    const converted = await convertDocumentToSessionXml(filename, content);
    const id = createId('sessiondoc');
    const createdAt = nowIso();
    const workspaceDir = req.workspaceDir?.trim();
    const docDir = workspaceDir ? resolveWorkspaceDocumentDir(workspaceDir, sessionId, id) : ensureDir(join(this.docsRoot, id));
    const xmlPath = join(docDir, XML_FILE);
    writeFileSync(xmlPath, converted.xml, 'utf8');
    const workspaceCopyPath = workspaceDir
      ? resolveWorkspaceCopyPath(workspaceDir, sessionId, filename)
      : undefined;
    if (workspaceCopyPath) writeFileSync(workspaceCopyPath, content);

    const doc: SessionDocumentContext = {
      id,
      sessionId,
      filename,
      sourceExt,
      xmlPath,
      workspaceCopyPath,
      commentCount: converted.commentCount,
      charCount: converted.xml.length,
      excerpt: excerptFor(converted.xml),
      createdAt,
      updatedAt: createdAt
    };

    const index = this.indexStore.read();
    index.docs = [doc, ...index.docs.filter((item) => item.id !== id)];
    this.indexStore.write(index);
    return doc;
  }

  deleteDocument(sessionId: string, id: string): boolean {
    const cleanSessionId = sessionId.trim();
    const cleanId = id.trim();
    if (!cleanSessionId || !cleanId) return false;
    const index = this.indexStore.read();
    const target = index.docs.find((doc) => doc.id === cleanId && doc.sessionId === cleanSessionId);
    if (!target) return false;
    rmSync(join(this.docsRoot, target.id), { recursive: true, force: true });
    index.docs = index.docs.filter((doc) => doc.id !== target.id);
    this.indexStore.write(index);
    return true;
  }

  renderPromptBlock(sessionId?: string, options: { maxDocs?: number; maxChars?: number } = {}): string {
    const cleanSessionId = sessionId?.trim();
    if (!cleanSessionId) return '(no session document)';
    const docs = this.list(cleanSessionId);
    if (docs.length === 0) return '(no session document)';

    const maxDocs = Math.max(1, options.maxDocs ?? 10);
    const maxChars = Math.max(1200, options.maxChars ?? 14_000);
    const lines: string[] = [
      '## Session Document XML Context',
      'The user uploaded these XML documents for this session. Use them as primary context when relevant.'
    ];
    if (docs.length > maxDocs) {
      lines.push(
        `Note: ${docs.length} documents are attached; only the latest ${maxDocs} are included below due to context limits. Configure this in Settings > Execution > Session docs max.`
      );
    }
    let usedChars = 0;
    let renderedCount = 0;
    const selected = docs.slice(0, maxDocs);
    for (const doc of selected) {
      if (!existsSync(doc.xmlPath)) continue;
      const raw = readFileSync(doc.xmlPath, 'utf8');
      const remainingDocs = Math.max(1, selected.length - renderedCount);
      const remainingBudget = Math.max(1200, maxChars - usedChars);
      // Keep a fair share for later documents so one large file does not consume all context.
      const budget = Math.max(1200, Math.floor(remainingBudget / remainingDocs));
      const trimmed = raw.length > budget ? `${raw.slice(0, budget)}\n<!-- truncated -->\n` : raw;
      if (usedChars + trimmed.length > maxChars && renderedCount > 0) break;
      lines.push('', `### ${doc.filename} (comments: ${doc.commentCount})`, '```xml', trimmed.trimEnd(), '```');
      usedChars += trimmed.length;
      renderedCount += 1;
      if (usedChars >= maxChars) break;
    }
    if (renderedCount === 0) return '(session document exists but XML content is unavailable)';
    return `${lines.join('\n')}\n`;
  }
}
