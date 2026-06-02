import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentExecutionDetails,
  AgentMessage,
  LlmUsage,
  MemoryDomain,
  SearchResult,
  SessionRecord,
  SessionSummary,
  SessionSystemPromptRecord,
  ToolEvent
} from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { inferMemoryDomains, normalizeMemoryDomain } from '../../shared/memoryDomains.js';
import { ensureDir, safeJoin } from './pathUtils.js';

export class SessionStore {
  private readonly dir: string;
  private readonly maxSystemPromptHistory = 1;

  constructor(harnessHome: string) {
    this.dir = join(harnessHome, 'sessions');
    ensureDir(this.dir);
  }

  create(title = 'New session', id?: string): SessionRecord {
    const ts = nowIso();
    const record: SessionRecord = {
      id: id !== undefined ? this.ensureValidProvidedId(id) : createId('session'),
      title,
      createdAt: ts,
      updatedAt: ts,
      messageCount: 0,
      domain: 'other',
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
    return record;
  }

  list(): SessionSummary[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((record): record is SessionRecord => Boolean(record))
      .map((record) => this.summary(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    return true;
  }

  search(query: string, limit = 20): SearchResult<SessionSummary>[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.list().slice(0, limit).map((item) => ({ item, score: 0, highlights: [] }));
    const results: SearchResult<SessionSummary>[] = [];
    for (const summary of this.list()) {
      const record = this.read(summary.id);
      if (!record) continue;
      const corpus = `${record.title}\n${record.messages.map((m) => m.content).join('\n')}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (corpus.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        const highlights = record.messages
          .map((m) => m.content)
          .filter((text) => terms.some((term) => text.toLowerCase().includes(term)))
          .slice(0, 3);
        results.push({ item: summary, score, highlights });
      }
    }
    return results.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt)).slice(0, limit);
  }

  private write(record: SessionRecord): void {
    ensureDir(this.dir);
    const history = this.buildSystemPromptHistory(record);
    const persisted: Record<string, unknown> = {
      ...record,
      messages: (record.messages ?? []).map((message) => this.persistableMessage(message)),
      systemPromptHistory: history
    };
    delete persisted.systemPrompt;
    delete persisted.messageCount;
    delete persisted.toolEvents;
    writeFileSync(this.fileFor(record.id), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
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

  private persistableMessage(message: AgentMessage): AgentMessage {
    const next = { ...message };
    delete next.reasoning_parts;
    return next;
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

  private summary(record: SessionRecord): SessionSummary {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messageCount: record.messages.length,
      domain: normalizeMemoryDomain(record.domain || this.inferRecordDomain(record))
    };
  }

  private inferRecordDomain(record: Pick<SessionRecord, 'title' | 'messages'>): MemoryDomain {
    const seed = [
      record.title,
      ...record.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
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
