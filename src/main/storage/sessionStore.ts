import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentExecutionDetails,
  AgentMessage,
  LlmUsage,
  MemoryDomain,
  SearchResult,
  SessionHistoryCategory,
  SessionListPageRequest,
  SessionListPageResult,
  SessionOptimizationContextRequest,
  SessionOptimizationContextResult,
  SessionRecord,
  SessionSummary,
  SessionSystemPromptRecord,
  ToolEvent
} from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { inferMemoryDomains, normalizeMemoryDomain } from '../../shared/memoryDomains.js';
import { redactSensitiveObject } from '../privacy/sensitiveRedaction.js';
import { ensureDir, safeJoin } from './pathUtils.js';

const SEARCH_HIGHLIGHT_CHARS = 1200;
const OPTIMIZATION_CONTEXT_CHARS_PER_SESSION = 9000;
const OPTIMIZATION_CONTEXT_TOTAL_CHARS = 60000;
const DISPLAY_MESSAGE_CHARS = 12000;
const DISPLAY_TOOL_CONTENT_CHARS = 6000;
const DISPLAY_REASONING_CHARS = 4000;
const DISPLAY_ATTACHMENT_BASE64_CHARS = 0;
const DISPLAY_ARGS_CHARS = 2000;
const CONTENT_PARTS_CACHE_LIMIT = 200;
const SESSION_HISTORY_PAGE_SIZE = 24;
const SESSION_HISTORY_MAX_PAGE_SIZE = 100;
const FAILURE_SIGNAL_PATTERN = /\b(error|failed?|failure|exception|timeout|timed out|denied|refused|exceeded|too large|not found)\b|失败|错误|异常|超时|超过|拒绝|找不到/i;
const IMPORTANT_TOOL_PATTERN = /^(browser_|skill_|file_|terminal$|session_search$)/;

interface SessionSummaryIndexEntry extends SessionSummary {
  fileMtimeMs: number;
  fileSize: number;
}

interface SessionSummaryIndex {
  version: 1;
  sessions: Record<string, SessionSummaryIndexEntry>;
}

export class SessionStore {
  private readonly dir: string;
  private readonly indexFile: string;
  private readonly maxSystemPromptHistory = 1;
  private readonly contentPartsCache = new Map<string, { signature: string; partsByMessageId: Map<string, string[]> }>();

  constructor(harnessHome: string) {
    this.dir = join(harnessHome, 'sessions');
    this.indexFile = join(harnessHome, 'sessions-index.json');
    ensureDir(this.dir);
  }

  create(title = 'New session', id?: string, metadata?: Pick<SessionRecord, 'origin' | 'external'>): SessionRecord {
    const ts = nowIso();
    const record: SessionRecord = {
      id: id !== undefined ? this.ensureValidProvidedId(id) : createId('session'),
      title,
      createdAt: ts,
      updatedAt: ts,
      messageCount: 0,
      domain: 'other',
      origin: metadata?.origin ?? 'desktop',
      external: metadata?.external,
      systemPromptHistory: [],
      messages: [],
      toolEvents: [],
      lastExecution: {
        mode: 'workspace',
        workspaceDir: ''
      }
    };
    this.write(record);
    return record;
  }

  read(id: string): SessionRecord | null {
    const file = this.fileFor(id);
    if (!existsSync(file)) return null;
    const record = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord;
    const history = this.buildSystemPromptHistory(record);
    record.messages = record.messages ?? [];
    record.messageCount = record.messages.length;
    record.domain = normalizeMemoryDomain(record.domain || this.inferRecordDomain(record));
    record.toolEvents = this.buildToolEvents(record.messages, record.toolEvents);
    record.systemPromptHistory = history;
    record.systemPrompt = history.at(-1)?.prompt;
    record.lastExecution = record.lastExecution ?? { mode: 'workspace', workspaceDir: '' };
    record.lastUsage = record.lastUsage ?? undefined;
    record.totalUsage = record.totalUsage ?? undefined;
    record.origin = record.origin ?? (record.id.startsWith('im_') || record.id.startsWith('dsh-im-') ? 'external-im' : 'desktop');
    return record;
  }

  readForDisplay(id: string): SessionRecord | null {
    const record = this.read(id);
    if (!record) return null;
    const contentPartsByMessageId = this.contentPartsForRecord(record);
    return {
      ...record,
      systemPrompt: record.systemPrompt ? this.clipText(record.systemPrompt, DISPLAY_MESSAGE_CHARS) : undefined,
      systemPromptHistory: record.systemPromptHistory?.map((item) => ({
        ...item,
        prompt: this.clipText(item.prompt, DISPLAY_MESSAGE_CHARS)
      })),
      messages: record.messages
        .filter((message) => message.hidden !== true)
        .map((message) => this.compactMessageForDisplay(message, contentPartsByMessageId.get(message.id ?? ''))),
      toolEvents: record.toolEvents.map((event) => this.compactToolEventForDisplay(event))
    };
  }

  readMessageContent(sessionId: string, messageId: string): { content: string; reasoning_content?: string; content_parts?: string[]; attachments?: AgentMessage['attachments'] } | null {
    const record = this.read(sessionId);
    const message = record?.messages.find((item) => item.id === messageId);
    if (!message) return null;
    const contentParts = record ? this.contentPartsForRecord(record).get(messageId) : undefined;
    return {
      content: message.content,
      reasoning_content: message.reasoning_content,
      content_parts: contentParts ?? message.content_parts,
      attachments: message.attachments
    };
  }

  readToolEventContent(sessionId: string, toolEventId: string): { content: string; args: unknown } | null {
    const record = this.read(sessionId);
    const event = record?.toolEvents.find((item) => item.id === toolEventId);
    if (!event) return null;
    return {
      content: event.content,
      args: event.args
    };
  }

  toolEventForDisplay(event: ToolEvent): ToolEvent {
    return this.compactToolEventForDisplay(event);
  }

  list(): SessionSummary[] {
    return this.indexedSummaries();
  }

  listPage(req: SessionListPageRequest = {}): SessionListPageResult {
    const pageSize = this.clampInt(req.pageSize, SESSION_HISTORY_PAGE_SIZE, 1, SESSION_HISTORY_MAX_PAGE_SIZE);
    const requestedPage = this.clampInt(req.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const query = req.query?.trim().toLowerCase() ?? '';
    const category = req.category ?? 'all';
    const summaries = this.indexedSummaries();
    const categoryCounts = this.sessionCategoryCounts(summaries, req.wechatSessionId);
    const filtered = summaries.filter((summary) => (
      this.sessionMatchesCategory(summary, category, req.wechatSessionId)
      && (!query || summary.title.toLowerCase().includes(query))
    ));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    return {
      sessions: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total,
      totalPages,
      categoryCounts
    };
  }

  appendMessages(id: string, messages: AgentMessage[], toolEvents: ToolEvent[] = [], execution?: AgentExecutionDetails): SessionRecord {
    const record = this.read(id) ?? this.create();
    return this.writeMessages(record, [...record.messages, ...this.normalizeMessages(messages)], toolEvents, execution);
  }

  upsertMessages(id: string, messages: AgentMessage[], toolEvents: ToolEvent[] = [], execution?: AgentExecutionDetails): SessionRecord {
    const record = this.read(id) ?? this.create();
    const nextMessages = [...record.messages];
    for (const message of this.normalizeMessages(messages)) {
      const existingIndex = message.id ? nextMessages.findIndex((item) => item.id === message.id) : -1;
      if (existingIndex >= 0) {
        nextMessages[existingIndex] = {
          ...nextMessages[existingIndex],
          ...message,
          createdAt: message.createdAt ?? nextMessages[existingIndex].createdAt ?? nowIso()
        };
      } else {
        nextMessages.push(message);
      }
    }
    return this.writeMessages(record, nextMessages, toolEvents, execution);
  }

  setSystemPrompt(id: string, systemPrompt: string): SessionRecord {
    const record = this.read(id) ?? this.create();
    const historyEntry: SessionSystemPromptRecord = {
      prompt: systemPrompt,
      createdAt: nowIso()
    };
    const next: SessionRecord = {
      ...record,
      systemPrompt,
      systemPromptHistory: [historyEntry],
      updatedAt: nowIso()
    };
    this.write(next);
    return next;
  }

  replaceMessages(id: string, messages: AgentMessage[]): SessionRecord {
    const record = this.read(id) ?? this.create();
    const normalized = this.normalizeMessages(messages);
    const next = { ...record, messages: normalized, messageCount: normalized.length, updatedAt: nowIso() };
    next.domain = this.inferRecordDomain(next);
    this.write(next);
    return next;
  }

  recordUsage(id: string, usage?: LlmUsage): SessionRecord {
    const record = this.read(id) ?? this.create();
    if (!usage) return record;
    const current = record.totalUsage ?? {};
    const nextTotal: LlmUsage = {
      promptTokens: (current.promptTokens ?? 0) + (usage.promptTokens ?? 0),
      completionTokens: (current.completionTokens ?? 0) + (usage.completionTokens ?? 0),
      totalTokens: (current.totalTokens ?? 0) + (usage.totalTokens ?? 0)
    };
    const next: SessionRecord = {
      ...record,
      lastUsage: usage,
      totalUsage: nextTotal,
      updatedAt: nowIso()
    };
    this.write(next);
    return next;
  }

  rename(id: string, title: string): SessionSummary {
    const record = this.mustRead(id);
    const next = { ...record, title: title.trim() || record.title, updatedAt: nowIso() };
    next.domain = this.inferRecordDomain(next);
    this.write(next);
    return this.summary(next);
  }

  delete(id: string): boolean {
    const file = this.fileFor(id);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    this.removeIndexSummary(id);
    return true;
  }

  search(query: string, limit = 20): SearchResult<SessionSummary>[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.list().slice(0, limit).map((item) => ({ item, score: 0, highlights: [] }));
    const results: SearchResult<SessionSummary>[] = [];
    for (const summary of this.list()) {
      const record = this.read(summary.id);
      if (!record) continue;
      const searchableMessages = record.messages.filter((message) => message.role !== 'assistant' || message.hidden !== true);
      const corpus = `${record.title}\n${searchableMessages.map((m) => m.content).join('\n')}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (corpus.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        const highlights = searchableMessages
          .map((m) => m.content)
          .filter((text) => terms.some((term) => text.toLowerCase().includes(term)))
          .slice(0, 3)
          .map((text) => this.clipText(text, SEARCH_HIGHLIGHT_CHARS));
        results.push({ item: summary, score, highlights });
      }
    }
    return results.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt)).slice(0, limit);
  }

  buildOptimizationContext(request: SessionOptimizationContextRequest): SessionOptimizationContextResult {
    const sessionIds = [...new Set((request.sessionIds ?? []).map((id) => id.trim()).filter(Boolean))];
    const maxCharsPerSession = this.positiveNumber(request.maxCharsPerSession, OPTIMIZATION_CONTEXT_CHARS_PER_SESSION);
    const maxTotalChars = this.positiveNumber(request.maxTotalChars, OPTIMIZATION_CONTEXT_TOTAL_CHARS);
    const missingIds: string[] = [];
    const sections: string[] = [];
    let totalChars = 0;
    let truncated = false;

    for (const sessionId of sessionIds) {
      const record = this.read(sessionId);
      if (!record) {
        missingIds.push(sessionId);
        continue;
      }
      let section = this.buildOptimizationSessionSection(record);
      if (section.length > maxCharsPerSession) {
        section = this.clipText(section, maxCharsPerSession);
        truncated = true;
      }
      if (totalChars + section.length > maxTotalChars) {
        const remaining = Math.max(0, maxTotalChars - totalChars);
        if (remaining > 200) sections.push(this.clipText(section, remaining));
        truncated = true;
        totalChars = maxTotalChars;
        break;
      }
      sections.push(section);
      totalChars += section.length;
    }

    const missingSection = missingIds.length > 0 ? `\n\nMissing selected sessions: ${missingIds.join(', ')}` : '';
    const context = [
      'Selected session optimization context',
      'Only the sessions listed here were inspected. Large tool outputs and full snapshots are intentionally omitted.',
      sections.join('\n\n---\n\n') || '(No selected sessions were found.)',
      missingSection.trim()
    ].filter(Boolean).join('\n\n');

    return {
      sessionIds,
      missingIds,
      context,
      truncated,
      totalChars: context.length
    };
  }

  private write(record: SessionRecord): void {
    ensureDir(this.dir);
    const redactedRecord = redactSensitiveObject(record, { includeValues: false }) as SessionRecord;
    const history = this.buildSystemPromptHistory(redactedRecord);
    const persisted: Record<string, unknown> = {
      ...redactedRecord,
      messages: (redactedRecord.messages ?? []).map((message) => this.persistableMessage(message)),
      systemPromptHistory: history
    };
    delete persisted.systemPrompt;
    delete persisted.messageCount;
    delete persisted.toolEvents;
    writeFileSync(this.fileFor(record.id), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
    this.upsertIndexSummary(redactedRecord);
  }

  private writeMessages(
    record: SessionRecord,
    messages: AgentMessage[],
    toolEvents: ToolEvent[] = [],
    execution?: AgentExecutionDetails
  ): SessionRecord {
    const next: SessionRecord = {
      ...record,
      messages,
      toolEvents: [...(record.toolEvents ?? []), ...toolEvents],
      lastExecution: execution ?? record.lastExecution,
      updatedAt: nowIso()
    };
    if (record.title === 'New session') {
      const firstUser = next.messages.find((m) => m.role === 'user')?.content ?? 'New session';
      next.title = firstUser.slice(0, 64);
    }
    next.messageCount = next.messages.length;
    next.domain = this.inferRecordDomain(next);
    this.write(next);
    return next;
  }

  private normalizeMessages(messages: AgentMessage[]): AgentMessage[] {
    return messages.map((message) => ({ ...message, createdAt: message.createdAt ?? nowIso() }));
  }

  private compactMessageForDisplay(message: AgentMessage, derivedContentParts?: string[]): AgentMessage {
    const content = this.compactTextForDisplay(message.content, DISPLAY_MESSAGE_CHARS);
    const reasoning = message.reasoning_content ? this.compactTextForDisplay(message.reasoning_content, DISPLAY_REASONING_CHARS) : undefined;
    return {
      ...message,
      content: content.text,
      contentOmitted: content.omitted || undefined,
      contentLength: content.omitted ? content.length : undefined,
      reasoning_content: reasoning?.text,
      reasoningOmitted: reasoning?.omitted || undefined,
      reasoningLength: reasoning?.omitted ? reasoning.length : undefined,
      reasoning_parts: message.reasoning_parts?.map((part) => this.clipText(part, 1000)),
      content_parts: derivedContentParts?.map((part) => this.clipText(part, 2000)) ?? message.content_parts?.map((part) => this.clipText(part, 2000)),
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        contentBase64: DISPLAY_ATTACHMENT_BASE64_CHARS > 0
          ? this.clipText(attachment.contentBase64, DISPLAY_ATTACHMENT_BASE64_CHARS)
          : ''
      })),
      tool_calls: message.tool_calls?.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: this.clipText(call.function.arguments, DISPLAY_ARGS_CHARS)
        }
      }))
    };
  }

  private compactToolEventForDisplay(event: ToolEvent): ToolEvent {
    const content = this.compactTextForDisplay(event.content, DISPLAY_TOOL_CONTENT_CHARS);
    const args = this.compactUnknownForDisplay(event.args, DISPLAY_ARGS_CHARS);
    return {
      ...event,
      args: args.value,
      argsOmitted: args.omitted || undefined,
      argsLength: args.omitted ? args.length : undefined,
      content: content.text,
      contentOmitted: content.omitted || undefined,
      contentLength: content.omitted ? content.length : undefined
    };
  }

  private compactUnknownForDisplay(value: unknown, maxChars: number): { value: unknown; omitted: boolean; length: number } {
    const text = this.stringifyCompact(value);
    if (text.length <= maxChars) return { value, omitted: false, length: text.length };
    const compact = this.compactTextForDisplay(text, maxChars);
    return {
      value: {
        previewOnly: true,
        preview: compact.text,
        fullLength: compact.length
      },
      omitted: true,
      length: text.length
    };
  }

  private buildOptimizationSessionSection(record: SessionRecord): string {
    const userMessages = record.messages
      .filter((message) => message.role === 'user')
      .slice(-3)
      .map((message, index) => `User ${index + 1}: ${this.clipText(message.content, 1000)}`);
    const assistantMessages = record.messages
      .filter((message) => message.role === 'assistant' && message.hidden !== true && message.content.trim())
      .slice(-2)
      .map((message, index) => `Assistant ${index + 1}: ${this.clipText(message.content, 1000)}`);
    const failureEvents = record.toolEvents
      .filter((event) => !event.ok || FAILURE_SIGNAL_PATTERN.test(event.content) || FAILURE_SIGNAL_PATTERN.test(event.toolName))
      .slice(-10);
    const recentImportantEvents = record.toolEvents
      .filter((event) => IMPORTANT_TOOL_PATTERN.test(event.toolName))
      .slice(-8);
    const eventMap = new Map<string, ToolEvent>();
    for (const event of [...failureEvents, ...recentImportantEvents]) eventMap.set(event.id, event);
    const events = [...eventMap.values()]
      .slice(-14)
      .map((event, index) => {
        const args = this.clipText(this.stringifyCompact(event.args), 500);
        const content = this.clipText(event.content, 1200);
        return [
          `Event ${index + 1}: ${event.toolName} ${event.ok ? 'ok' : 'failed'} at ${event.createdAt}`,
          args && args !== '{}' ? `Args: ${args}` : '',
          `Content: ${content || '(empty)'}`
        ].filter(Boolean).join('\n');
      });

    const sections = [
      `Session: ${record.id}`,
      `Title: ${record.title}`,
      `Updated: ${record.updatedAt}`,
      `Messages: ${record.messages.length}`,
      userMessages.length > 0 ? `Recent user requests:\n${userMessages.join('\n')}` : '',
      assistantMessages.length > 0 ? `Recent assistant results:\n${assistantMessages.join('\n')}` : '',
      events.length > 0 ? `Failure and important tool signals:\n${events.join('\n\n')}` : 'Failure and important tool signals: none captured.'
    ];
    return sections.filter(Boolean).join('\n\n');
  }

  private positiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  private stringifyCompact(value: unknown): string {
    try {
      return JSON.stringify(value ?? {});
    } catch {
      return String(value ?? '');
    }
  }

  private clipText(input: string, maxChars: number): string {
    const text = String(input ?? '');
    if (text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, Math.max(0, maxChars - 40))}\n[truncated ${omitted} chars]`;
  }

  private compactTextForDisplay(input: string, maxChars: number): { text: string; omitted: boolean; length: number } {
    const text = String(input ?? '');
    if (text.length <= maxChars) return { text, omitted: false, length: text.length };
    const omitted = text.length - maxChars;
    return {
      text: `${text.slice(0, Math.max(0, maxChars - 64))}\n[preview only; full content available, omitted ${omitted} chars]`,
      omitted: true,
      length: text.length
    };
  }

  private persistableMessage(message: AgentMessage): AgentMessage {
    const next = { ...message };
    delete next.reasoning_parts;
    delete next.content_parts;
    return next;
  }

  private contentPartsForRecord(record: SessionRecord): Map<string, string[]> {
    const signature = this.contentPartsSignature(record);
    const cached = this.contentPartsCache.get(record.id);
    if (cached?.signature === signature) return cached.partsByMessageId;

    const partsByMessageId = new Map<string, string[]>();
    let pendingParts: string[] = [];
    for (const message of record.messages ?? []) {
      if (message.role === 'user') {
        pendingParts = [];
        continue;
      }
      if (message.role !== 'assistant') continue;

      const content = message.content.trim();
      if (message.hidden === true) {
        if (content) pendingParts.push(content);
        continue;
      }
      if (content && pendingParts.length > 0 && message.id) {
        partsByMessageId.set(message.id, [...pendingParts]);
      }
      if (content) pendingParts = [];
    }

    this.contentPartsCache.set(record.id, { signature, partsByMessageId });
    if (this.contentPartsCache.size > CONTENT_PARTS_CACHE_LIMIT) {
      const oldestKey = this.contentPartsCache.keys().next().value;
      if (oldestKey) this.contentPartsCache.delete(oldestKey);
    }
    return partsByMessageId;
  }

  private contentPartsSignature(record: SessionRecord): string {
    return (record.messages ?? [])
      .map((message) => [
        message.id ?? '',
        message.role,
        message.hidden === true ? '1' : '0',
        message.createdAt ?? '',
        message.content.length,
        message.hidden === true ? message.content : ''
      ].join(':'))
      .join('|');
  }

  private ensureValidProvidedId(id: string): string {
    const trimmed = id.trim();
    if (!trimmed || /[^a-zA-Z0-9_.-]/.test(trimmed)) {
      throw new Error(`Invalid session id: ${id}. Use only letters, numbers, '.', '_' or '-'.`);
    }
    return trimmed;
  }

  private fileFor(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe) throw new Error('Invalid session id.');
    return safeJoin(this.dir, `${safe}.json`);
  }

  private mustRead(id: string): SessionRecord {
    const record = this.read(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    return record;
  }

  private isHiddenSession(id: string): boolean {
    return id.startsWith('backend_session_');
  }

  private indexedSummaries(): SessionSummary[] {
    const index = this.readSummaryIndex();
    const nextEntries: Record<string, SessionSummaryIndexEntry> = {};
    let changed = false;
    for (const filename of readdirSync(this.dir).filter((name) => name.endsWith('.json'))) {
      const id = filename.slice(0, -5);
      if (this.isHiddenSession(id)) continue;
      let stat;
      try {
        stat = statSync(this.fileFor(id));
      } catch {
        changed = true;
        continue;
      }
      const current = index.sessions[id];
      if (current && current.fileMtimeMs === stat.mtimeMs && current.fileSize === stat.size) {
        nextEntries[id] = current;
        continue;
      }
      const summary = this.summaryFromFile(filename);
      if (!summary) {
        changed = true;
        continue;
      }
      nextEntries[id] = { ...summary, fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
      changed = true;
    }
    if (Object.keys(index.sessions).length !== Object.keys(nextEntries).length) changed = true;
    if (changed) this.writeSummaryIndex({ version: 1, sessions: nextEntries });
    return Object.values(nextEntries)
      .map(({ fileMtimeMs: _fileMtimeMs, fileSize: _fileSize, ...summary }) => summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private readSummaryIndex(): SessionSummaryIndex {
    if (!existsSync(this.indexFile)) return { version: 1, sessions: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Partial<SessionSummaryIndex>;
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') {
        return { version: 1, sessions: {} };
      }
      return {
        version: 1,
        sessions: Object.fromEntries(
          Object.entries(parsed.sessions).filter((entry): entry is [string, SessionSummaryIndexEntry] => {
            const item = entry[1];
            return Boolean(item?.id && item.title && item.createdAt && item.updatedAt);
          })
        )
      };
    } catch {
      return { version: 1, sessions: {} };
    }
  }

  private writeSummaryIndex(index: SessionSummaryIndex): void {
    writeFileSync(this.indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  private upsertIndexSummary(record: SessionRecord): void {
    if (this.isHiddenSession(record.id)) return;
    try {
      const stat = statSync(this.fileFor(record.id));
      const index = this.readSummaryIndex();
      index.sessions[record.id] = {
        ...this.summary(record),
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size
      };
      this.writeSummaryIndex(index);
    } catch {
      // Indexes are an optimization; session JSON remains the source of truth.
    }
  }

  private removeIndexSummary(id: string): void {
    const index = this.readSummaryIndex();
    if (!index.sessions[id]) return;
    delete index.sessions[id];
    this.writeSummaryIndex(index);
  }

  private summaryFromFile(filename: string): SessionSummary | null {
    const id = filename.slice(0, -5);
    if (this.isHiddenSession(id)) return null;
    try {
      const raw = readFileSync(this.fileFor(id), 'utf8');
      const title = this.readJsonString(raw, 'title') || 'New session';
      const createdAt = this.readJsonString(raw, 'createdAt') || nowIso();
      const updatedAt = this.readJsonString(raw, 'updatedAt') || createdAt;
      const messageCount = this.readJsonNumber(raw, 'messageCount') ?? this.estimateMessageCount(raw);
      const rawDomain = this.readJsonString(raw, 'domain');
      const domain = normalizeMemoryDomain(rawDomain || inferMemoryDomains(title)[0] || 'other');
      const origin = this.readJsonString(raw, 'origin') === 'external-im' ? 'external-im' : undefined;
      return { id, title, createdAt, updatedAt, messageCount, domain, origin };
    } catch {
      try {
        const record = this.read(id);
        return record ? this.summary(record) : null;
      } catch {
        return null;
      }
    }
  }

  private readJsonString(raw: string, key: string): string | undefined {
    const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!match) return undefined;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return undefined;
    }
  }

  private readJsonNumber(raw: string, key: string): number | undefined {
    const match = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }

  private estimateMessageCount(raw: string): number {
    return raw.match(/"role"\s*:\s*"(?:system|user|assistant|tool)"/g)?.length ?? 0;
  }

  private sessionCategoryCounts(sessions: SessionSummary[], wechatSessionId?: string): Partial<Record<SessionHistoryCategory, number>> {
    const counts: Partial<Record<SessionHistoryCategory, number>> = {
      all: sessions.length,
      'wechat-clawbot': 0,
      'external-im': 0
    };
    for (const session of sessions) {
      if (this.isExternalImSessionSummary(session)) {
        counts['external-im'] = (counts['external-im'] ?? 0) + 1;
        continue;
      }
      if (this.isWechatSessionSummary(session, wechatSessionId)) {
        counts['wechat-clawbot'] = (counts['wechat-clawbot'] ?? 0) + 1;
        continue;
      }
      const domain = normalizeMemoryDomain(session.domain);
      counts[domain] = (counts[domain] ?? 0) + 1;
    }
    return counts;
  }

  private sessionMatchesCategory(session: SessionSummary, category: SessionHistoryCategory, wechatSessionId?: string): boolean {
    if (category === 'all') return true;
    const isWechat = this.isWechatSessionSummary(session, wechatSessionId);
    if (category === 'external-im') return this.isExternalImSessionSummary(session);
    if (category === 'wechat-clawbot') return isWechat;
    return !isWechat && !this.isExternalImSessionSummary(session) && normalizeMemoryDomain(session.domain) === category;
  }

  private isExternalImSessionSummary(session: SessionSummary): boolean {
    return session.origin === 'external-im' || session.id.startsWith('im_') || session.id.startsWith('dsh-im-');
  }

  private isWechatSessionSummary(session: SessionSummary, wechatSessionId?: string): boolean {
    const configuredId = wechatSessionId?.trim();
    if (configuredId && session.id === configuredId) return true;
    const title = session.title.trim().toLowerCase();
    return title === 'wechat session' || title.startsWith('wechat clawbot') || title.startsWith('[wechat:');
  }

  private clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = Math.floor(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  private summary(record: SessionRecord): SessionSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messages.length,
      domain: normalizeMemoryDomain(record.domain || this.inferRecordDomain(record)),
      origin: record.origin,
      external: record.external
    };
  }

  private inferRecordDomain(record: Pick<SessionRecord, 'title' | 'messages'>): MemoryDomain {
    const seed = [
      record.title,
      ...record.messages
        .filter((message) => message.role === 'user' || (message.role === 'assistant' && message.hidden !== true))
        .slice(0, 8)
        .map((message) => message.content)
    ]
      .filter(Boolean)
      .join('\n');
    return inferMemoryDomains(seed)[0] ?? 'other';
  }

  private normalizeSystemPromptHistory(
    input: SessionRecord['systemPromptHistory']
  ): SessionSystemPromptRecord[] {
    if (!Array.isArray(input)) return [];
    const normalized: SessionSystemPromptRecord[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const prompt = typeof item.prompt === 'string' ? item.prompt : '';
      const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt : nowIso();
      if (!prompt.trim()) continue;
      normalized.push({ prompt, createdAt });
    }
    return normalized.slice(-this.maxSystemPromptHistory);
  }

  private buildSystemPromptHistory(record: Pick<SessionRecord, 'systemPrompt' | 'systemPromptHistory' | 'updatedAt'>): SessionSystemPromptRecord[] {
    const history = this.normalizeSystemPromptHistory(record.systemPromptHistory);
    const legacyPrompt = typeof record.systemPrompt === 'string' ? record.systemPrompt.trim() : '';
    if (!legacyPrompt) return history;
    const lastPrompt = history.at(-1)?.prompt.trim() ?? '';
    if (lastPrompt === legacyPrompt) return history;
    return [...history, { prompt: legacyPrompt, createdAt: record.updatedAt || nowIso() }].slice(-this.maxSystemPromptHistory);
  }

  private buildToolEvents(messages: AgentMessage[], existing?: ToolEvent[]): ToolEvent[] {
    if (Array.isArray(existing) && existing.length > 0) return existing;
    const events: ToolEvent[] = [];
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      const content = message.content ?? '';
      events.push({
        id: message.id || createId('toolevent'),
        toolName: message.name || 'tool',
        args: {},
        ok: !/\b(error|failed?|exception)\b/i.test(content),
        content,
        createdAt: message.createdAt ?? nowIso()
      });
    }
    return events;
  }
}
