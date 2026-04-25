import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MemoryClearRequest,
  MemoryDomain,
  MemoryDomainUsage,
  MemoryEntry,
  MemoryMutationOptions,
  MemoryQueryOptions,
  SessionRecord,
  MemoryState,
  MemoryTarget,
  MemoryUsage
} from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { ensureDir } from './pathUtils.js';

const LIMITS: Record<MemoryTarget, number> = {
  memory: 2200,
  user: 1375
};

const DEFAULT_DOMAIN: MemoryDomain = 'other';
const ENTRIES_FILE = 'entries.v2.json';
const LEGACY_FILES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md'
};
const LEGACY_SEPARATOR = /\n(?:\u6402|---)\n/gm;
const AUTO_SESSION_ENTRY_PREFIX = 'memory_auto_session_';

const DOMAIN_ALIASES: Record<MemoryDomain, string[]> = {
  finance: ['finance', 'financial', 'stock', 'invest', 'trading', 'economy', 'market'],
  daily_life: ['daily', 'life', 'lifestyle', 'home', 'routine', 'habit'],
  work: ['work', 'career', 'project', 'meeting', 'business', 'office'],
  reading: ['reading', 'book', 'article', 'paper', 'literature', 'read'],
  education: ['education', 'study', 'learning', 'school', 'course', 'training'],
  health: ['health', 'medical', 'wellness', 'fitness', 'doctor', 'medicine'],
  other: ['other', 'misc', 'miscellaneous', 'default', 'general']
};

type PendingMutation =
  | {
      kind: 'add';
      target: MemoryTarget;
      content: string;
      options: MemoryMutationOptions;
    }
  | {
      kind: 'remove';
      target: MemoryTarget;
      oldText: string;
      options: MemoryMutationOptions;
    };

function titleFor(target: MemoryTarget): string {
  return target === 'memory' ? 'SESSION + PROJECT MEMORY' : 'USER PROFILE MEMORY';
}

function normalizeLineBreaks(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeDomainValue(input?: string): MemoryDomain {
  const raw = (input || '').trim().toLowerCase();
  if (!raw || raw === 'general') return DEFAULT_DOMAIN;
  for (const [domain, aliases] of Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>) {
    if (domain === raw || aliases.some((alias) => raw.includes(alias))) return domain;
  }
  return DEFAULT_DOMAIN;
}

function toSafeQuery(query?: MemoryQueryOptions): MemoryQueryOptions | undefined {
  if (!query) return undefined;
  const safe: MemoryQueryOptions = {};
  if (query.target) safe.target = query.target;
  if (query.sessionId?.trim()) safe.sessionId = query.sessionId.trim();
  if (query.domain?.trim()) safe.domain = query.domain.trim();
  if (query.intent?.trim()) safe.intent = query.intent.trim();
  if (Number.isFinite(query.limit)) safe.limit = Number(query.limit);
  if (typeof query.includeGlobal === 'boolean') safe.includeGlobal = query.includeGlobal;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function compactText(input: string, maxLength: number): string {
  const clean = normalizeLineBreaks(input).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
}

export class MemoryStore {
  private readonly dir: string;
  private readonly entriesFile: string;
  private readonly pendingBySession = new Map<string, PendingMutation[]>();

  constructor(harnessHome: string) {
    this.dir = join(harnessHome, 'memories');
    ensureDir(this.dir);
    this.entriesFile = join(this.dir, ENTRIES_FILE);
    if (!existsSync(this.entriesFile)) {
      const migrated = this.readLegacyEntries();
      this.writeEntries(migrated);
    }
  }

  beginDeferredSession(sessionId: string): void {
    this.pendingBySession.set(sessionId, []);
  }

  discardDeferredSession(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
  }

  commitDeferredSession(sessionId: string): { applied: number; errors: string[] } {
    const pending = this.pendingBySession.get(sessionId) ?? [];
    this.pendingBySession.delete(sessionId);
    if (pending.length === 0) return { applied: 0, errors: [] };

    try {
      const entries = this.readEntries();
      const next = this.applyPendingMutations(entries, pending);
      this.writeEntries(next);
      return { applied: pending.length, errors: [] };
    } catch (error) {
      return { applied: 0, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  pendingCount(sessionId: string): number {
    return this.pendingBySession.get(sessionId)?.length ?? 0;
  }

  queueAdd(sessionId: string, target: MemoryTarget, content: string, options: MemoryMutationOptions = {}): void {
    const queuedOptions = this.normalizeQueuedOptions(sessionId, target, options);
    const mutation: PendingMutation = { kind: 'add', target, content, options: queuedOptions };
    this.assertQueueMutation(sessionId, mutation);
    const pending = this.pendingBySession.get(sessionId) ?? [];
    pending.push(mutation);
    this.pendingBySession.set(sessionId, pending);
  }

  queueRemove(sessionId: string, target: MemoryTarget, oldText: string, options: MemoryMutationOptions = {}): void {
    const queuedOptions = this.normalizeQueuedOptions(sessionId, target, options);
    const mutation: PendingMutation = { kind: 'remove', target, oldText, options: queuedOptions };
    this.assertQueueMutation(sessionId, mutation);
    const pending = this.pendingBySession.get(sessionId) ?? [];
    pending.push(mutation);
    this.pendingBySession.set(sessionId, pending);
  }

  listEntries(query?: MemoryQueryOptions): MemoryEntry[] {
    const all = this.readEntries();
    return this.searchEntries(all, query, query?.limit ?? 200);
  }

  getState(query?: MemoryQueryOptions): MemoryState {
    const entries = this.listEntries(query);
    const usage = (['memory', 'user'] as const).map((target) => this.usageFor(target));
    return {
      entries,
      usage,
      domains: this.domainUsage(entries),
      query: toSafeQuery(query),
      rendered: this.renderPromptBlock(query)
    };
  }

  add(target: MemoryTarget, content: string, options: MemoryMutationOptions = {}): MemoryState {
    const entries = this.readEntries();
    const next = this.applyAdd(entries, target, content, options);
    this.writeEntries(next);
    return this.getState();
  }

  replace(_target: MemoryTarget, _oldText: string, _content: string, _options: MemoryMutationOptions = {}): MemoryState {
    throw new Error('Memory editing is disabled. Delete the old item and add a new one.');
  }

  remove(target: MemoryTarget, oldText: string, options: MemoryMutationOptions = {}): MemoryState {
    const entries = this.readEntries();
    const next = this.applyRemove(entries, target, oldText, options);
    this.writeEntries(next);
    return this.getState();
  }

  clear(request: MemoryClearRequest): MemoryState {
    const entries = this.readEntries();
    const next = this.applyClear(entries, request);
    this.writeEntries(next);
    return this.getState();
  }

  syncSessionMemory(record: SessionRecord): boolean {
    const entries = this.readEntries();
    const next = this.upsertAutoSessionMemory(entries, record);
    if (!next) return false;
    this.writeEntries(next);
    return true;
  }

  syncSessionMemories(records: SessionRecord[]): number {
    if (records.length === 0) return 0;
    let next = this.readEntries();
    let changed = 0;
    for (const record of records) {
      const updated = this.upsertAutoSessionMemory(next, record);
      if (!updated) continue;
      next = updated;
      changed += 1;
    }
    if (changed > 0) this.writeEntries(next);
    return changed;
  }

  inferDomains(intent: string): MemoryDomain[] {
    const normalized = normalizeLineBreaks(intent).trim().toLowerCase();
    if (!normalized) return [DEFAULT_DOMAIN];
    const matched: MemoryDomain[] = [];
    for (const [domain, aliases] of Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>) {
      if (aliases.some((alias) => normalized.includes(alias))) matched.push(domain);
    }
    return matched.length > 0 ? [...new Set(matched)] : [DEFAULT_DOMAIN];
  }

  renderPromptBlock(query: MemoryQueryOptions = {}): string {
    const resolvedQuery = {
      includeGlobal: true,
      ...query
    };
    const inferred = resolvedQuery.intent ? this.inferDomains(resolvedQuery.intent) : [];
    return (['memory', 'user'] as const)
      .map((target) => {
        const entries = this.listEntries({
          ...resolvedQuery,
          target,
          limit: target === 'memory' ? 12 : 8
        });
        const used = entries.map((entry) => entry.content).join('\n').length;
        const limit = LIMITS[target];
        const percent = Math.round((used / limit) * 100);
        const domainSummary = [...new Set(entries.map((entry) => normalizeDomainValue(entry.domain)))].join(', ') || DEFAULT_DOMAIN;
        const contextBits = [
          resolvedQuery.sessionId ? `session=${resolvedQuery.sessionId}` : '',
          resolvedQuery.domain ? `domain=${normalizeDomainValue(resolvedQuery.domain)}` : '',
          inferred.length > 0 ? `intent_domains=${inferred.join(',')}` : ''
        ]
          .filter(Boolean)
          .join(' | ');
        const body = entries.length > 0
          ? entries
              .map((entry) => {
                const scope = entry.scope === 'session' ? `session:${entry.sessionId ?? 'unknown'}` : 'global';
                return `- [${normalizeDomainValue(entry.domain)} | ${scope}] ${entry.content}`;
              })
              .join('\n')
          : '(empty)';
        return [
          `======================`,
          `${titleFor(target)} [${percent}% - ${used}/${limit} chars]`,
          `domains: ${domainSummary}`,
          contextBits ? `context: ${contextBits}` : '',
          `======================`,
          body
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
  }

  private normalizeQueuedOptions(sessionId: string, target: MemoryTarget, options: MemoryMutationOptions): MemoryMutationOptions {
    const fromInput = options.sessionId?.trim();
    const resolvedSessionId = target === 'memory' ? fromInput || sessionId : fromInput;
    return {
      ...options,
      sessionId: resolvedSessionId
    };
  }

  private assertQueueMutation(sessionId: string, mutation: PendingMutation): void {
    const current = this.pendingBySession.get(sessionId) ?? [];
    const entries = this.readEntries();
    void this.applyPendingMutations(entries, [...current, mutation]);
  }

  private applyPendingMutations(entries: MemoryEntry[], mutations: PendingMutation[]): MemoryEntry[] {
    let next = [...entries];
    for (const mutation of mutations) {
      next = mutation.kind === 'add'
        ? this.applyAdd(next, mutation.target, mutation.content, mutation.options)
        : this.applyRemove(next, mutation.target, mutation.oldText, mutation.options);
    }
    return next;
  }

  private applyAdd(entries: MemoryEntry[], target: MemoryTarget, content: string, options: MemoryMutationOptions): MemoryEntry[] {
    const clean = this.cleanContent(content);
    const resolvedScope = this.resolveScope(target, options);
    const resolvedSessionId = this.resolveSessionId(resolvedScope, options.sessionId);
    const domain = normalizeDomainValue(options.domain ?? this.inferDomains(clean)[0]);
    const contentItems = target === 'memory' ? this.splitContentEntries(clean) : [clean];
    const now = nowIso();
    const additions = contentItems.map((item) => ({
      id: createId(target),
      target,
      scope: resolvedScope,
      sessionId: resolvedSessionId,
      domain,
      content: item,
      createdAt: now,
      updatedAt: now
    }));
    const next = [...entries, ...additions];
    this.assertCapacity(target, next);
    return next;
  }

  private applyRemove(entries: MemoryEntry[], target: MemoryTarget, oldText: string, options: MemoryMutationOptions): MemoryEntry[] {
    const index = this.findUniqueIndex(entries, target, oldText, options);
    return entries.filter((_, i) => i !== index);
  }

  private applyClear(entries: MemoryEntry[], request: MemoryClearRequest): MemoryEntry[] {
    const target = request.target === 'user' ? 'user' : 'memory';
    const mode = request.mode;
    if (mode === 'entry') {
      const entryId = request.entryId?.trim();
      if (!entryId) throw new Error('entryId is required.');
      const index = entries.findIndex((entry) => entry.target === target && entry.id === entryId);
      if (index < 0) throw new Error(`No memory entry found for id: ${entryId}`);
      return entries.filter((_, entryIndex) => entryIndex !== index);
    }

    const sessionId = request.sessionId?.trim();
    const domain = mode === 'domain' ? normalizeDomainValue(request.domain) : undefined;
    if (mode === 'domain' && !request.domain?.trim()) throw new Error('domain is required.');

    const next = entries.filter((entry) => {
      if (entry.target !== target) return true;
      if (sessionId && (entry.scope !== 'session' || entry.sessionId !== sessionId)) return true;
      if (mode === 'domain' && normalizeDomainValue(entry.domain) !== domain) return true;
      return false;
    });

    if (next.length === entries.length) {
      if (mode === 'all') {
        throw new Error(sessionId ? `No session memory found for session: ${sessionId}` : `No ${target} memory entries found.`);
      }
      throw new Error(sessionId ? `No ${target} memory entries found for domain ${domain} in session ${sessionId}` : `No ${target} memory entries found for domain: ${domain}`);
    }
    return next;
  }

  private readEntries(): MemoryEntry[] {
    if (!existsSync(this.entriesFile)) return [];
    try {
      const raw = readFileSync(this.entriesFile, 'utf8').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item, index) => this.normalizeEntry(item, index)).filter((entry): entry is MemoryEntry => Boolean(entry));
    } catch {
      const migrated = this.readLegacyEntries();
      this.writeEntries(migrated);
      return migrated;
    }
  }

  private readLegacyEntries(): MemoryEntry[] {
    const now = nowIso();
    const entries: MemoryEntry[] = [];
    for (const target of ['memory', 'user'] as const) {
      const file = join(this.dir, LEGACY_FILES[target]);
      if (!existsSync(file)) continue;
      const raw = normalizeLineBreaks(readFileSync(file, 'utf8')).trim();
      if (!raw) continue;
      const chunks = raw.split(LEGACY_SEPARATOR).map((chunk) => chunk.trim()).filter(Boolean);
      for (const chunk of chunks) {
        entries.push({
          id: createId(target),
          target,
          scope: 'global',
          domain: DEFAULT_DOMAIN,
          content: chunk,
          createdAt: now,
          updatedAt: now
        });
      }
    }
    return entries;
  }

  private writeEntries(entries: MemoryEntry[]): void {
    ensureDir(this.dir);
    writeFileSync(this.entriesFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }

  private normalizeEntry(input: unknown, index: number): MemoryEntry | null {
    if (!input || typeof input !== 'object') return null;
    const raw = input as Partial<MemoryEntry>;
    const target = raw.target === 'user' ? 'user' : 'memory';
    const content = typeof raw.content === 'string' ? this.cleanContent(raw.content) : '';
    if (!content) return null;
    const scope = raw.scope === 'session' ? 'session' : 'global';
    const sessionId = scope === 'session' && typeof raw.sessionId === 'string' && raw.sessionId.trim() ? raw.sessionId.trim() : undefined;
    const now = nowIso();
    return {
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `memory_${index}`,
      target,
      scope: sessionId ? 'session' : scope,
      sessionId,
      domain: normalizeDomainValue(raw.domain),
      content,
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now
    };
  }

  private searchEntries(entries: MemoryEntry[], query: MemoryQueryOptions | undefined, defaultLimit: number): MemoryEntry[] {
    const sessionId = query?.sessionId?.trim();
    const includeGlobal = query?.includeGlobal ?? true;
    const domain = query?.domain ? normalizeDomainValue(query.domain) : undefined;
    const inferredDomains = query?.intent ? this.inferDomains(query.intent) : [];
    const intentTerms = normalizeLineBreaks(query?.intent ?? '')
      .toLowerCase()
      .split(/[\s,.;:!?，。；：！？]+/)
      .filter((term) => term.length >= 2);

    const filtered = entries
      .filter((entry) => !query?.target || entry.target === query.target)
      .filter((entry) => {
        if (!sessionId) return true;
        if (entry.scope === 'session') return entry.sessionId === sessionId;
        return includeGlobal;
      })
      .filter((entry) => (domain ? normalizeDomainValue(entry.domain) === domain : true))
      .map((entry) => ({
        entry,
        score: this.scoreEntry(entry, { sessionId, domain, inferredDomains, intentTerms })
      }))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));

    const limit = Math.max(1, Math.min(200, Number(query?.limit) || defaultLimit));
    return filtered.slice(0, limit).map((item) => item.entry);
  }

  private scoreEntry(
    entry: MemoryEntry,
    context: { sessionId?: string; domain?: MemoryDomain; inferredDomains: MemoryDomain[]; intentTerms: string[] }
  ): number {
    let score = 0;
    if (entry.scope === 'global') score += 2;
    if (entry.target === 'user') score += 1;
    if (context.sessionId) {
      if (entry.scope === 'session' && entry.sessionId === context.sessionId) score += 24;
      if (entry.scope === 'session' && entry.sessionId !== context.sessionId) score -= 10;
    }
    const entryDomain = normalizeDomainValue(entry.domain);
    if (context.domain) {
      if (entryDomain === context.domain) score += 22;
      else score -= 12;
    }
    if (context.inferredDomains.length > 0) {
      if (context.inferredDomains.includes(entryDomain)) score += 14;
      else if (!context.domain) score -= 3;
    }
    if (context.intentTerms.length > 0) {
      const contentLower = entry.content.toLowerCase();
      const hits = context.intentTerms.reduce((count, term) => count + (contentLower.includes(term) ? 1 : 0), 0);
      score += hits * 4;
    }
    return score;
  }

  private domainUsage(entries: MemoryEntry[]): MemoryDomainUsage[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const domain = normalizeDomainValue(entry.domain);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
  }

  private usageFor(target: MemoryTarget): MemoryUsage {
    const used = this.usedCharsFor(this.readEntries(), target);
    const limit = LIMITS[target];
    return { target, limit, used, percent: Math.round((used / limit) * 100) };
  }

  private assertCapacity(target: MemoryTarget, entries: MemoryEntry[]): void {
    const used = this.usedCharsFor(entries, target);
    const limit = LIMITS[target];
    if (used > limit) {
      throw new Error(`${target} memory would exceed ${limit} chars (${used}/${limit}). Remove older entries first.`);
    }
  }

  private usedCharsFor(entries: MemoryEntry[], target: MemoryTarget): number {
    return entries
      .filter((entry) => entry.target === target)
      .map((entry) => entry.content)
      .join('\n').length;
  }

  private upsertAutoSessionMemory(entries: MemoryEntry[], record: SessionRecord): MemoryEntry[] | null {
    const snapshot = this.buildSessionSnapshot(record);
    if (!snapshot) return null;
    const id = `${AUTO_SESSION_ENTRY_PREFIX}${record.id}`;
    const updatedAt = record.updatedAt || nowIso();
    const existingIndex = entries.findIndex((entry) => entry.id === id);
    const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
    if (
      existing &&
      existing.content === snapshot.content &&
      existing.sessionId === record.id &&
      normalizeDomainValue(existing.domain) === snapshot.domain &&
      existing.updatedAt === updatedAt
    ) {
      return null;
    }
    const nextEntry: MemoryEntry = {
      id,
      target: 'memory',
      scope: 'session',
      sessionId: record.id,
      domain: snapshot.domain,
      content: snapshot.content,
      createdAt: existing?.createdAt ?? record.createdAt ?? updatedAt,
      updatedAt
    };
    const next = existingIndex >= 0
      ? entries.map((entry, index) => (index === existingIndex ? nextEntry : entry))
      : [...entries, nextEntry];
    return this.trimAutoSessionEntries(next);
  }

  private buildSessionSnapshot(record: SessionRecord): { content: string; domain: MemoryDomain } | null {
    const firstUser = compactText(
      record.messages.find((message) => message.role === 'user' && message.content.trim())?.content ?? '',
      96
    );
    if (!firstUser) return null;
    const lastAssistantRaw = [...record.messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim())?.content ?? '';
    const lastAssistant = /^Reached iteration limit\b/i.test(lastAssistantRaw) ? '' : compactText(lastAssistantRaw, 72);
    const duplicate =
      !lastAssistant ||
      lastAssistant.toLowerCase() === firstUser.toLowerCase() ||
      lastAssistant.toLowerCase().includes(firstUser.toLowerCase()) ||
      firstUser.toLowerCase().includes(lastAssistant.toLowerCase());
    const content = duplicate ? firstUser : compactText(`${firstUser} -> ${lastAssistant}`, 180);
    return {
      content,
      domain: this.inferDomains(firstUser)[0] ?? DEFAULT_DOMAIN
    };
  }

  private trimAutoSessionEntries(entries: MemoryEntry[]): MemoryEntry[] {
    let next = [...entries];
    while (this.usedCharsFor(next, 'memory') > LIMITS.memory) {
      const oldestAuto = next
        .filter((entry) => entry.target === 'memory' && entry.id.startsWith(AUTO_SESSION_ENTRY_PREFIX))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!oldestAuto) break;
      next = next.filter((entry) => entry.id !== oldestAuto.id);
    }
    return next;
  }

  private findUniqueIndex(entries: MemoryEntry[], target: MemoryTarget, oldText: string, options: MemoryMutationOptions): number {
    const entryId = options.entryId?.trim();
    if (entryId) {
      const index = entries.findIndex((entry) => entry.target === target && entry.id === entryId);
      if (index < 0) throw new Error(`No memory entry found for id: ${entryId}`);
      return index;
    }
    const needle = oldText.trim();
    if (!needle) throw new Error('oldText is required.');
    const sessionId = options.sessionId?.trim();
    const domain = options.domain ? normalizeDomainValue(options.domain) : undefined;
    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.target === target)
      .filter(({ entry }) => (options.scope ? entry.scope === options.scope : true))
      .filter(({ entry }) => (sessionId ? entry.sessionId === sessionId : true))
      .filter(({ entry }) => (domain ? normalizeDomainValue(entry.domain) === domain : true))
      .filter(({ entry }) => entry.content.includes(needle));
    if (matches.length === 0) throw new Error(`No memory entry contains: ${needle}`);
    if (matches.length > 1) throw new Error(`More than one memory entry contains: ${needle}. Add session/domain filters.`);
    return matches[0].index;
  }

  private resolveScope(target: MemoryTarget, options: MemoryMutationOptions): 'global' | 'session' {
    if (target === 'memory') return 'session';
    if (options.scope) return options.scope;
    return 'global';
  }

  private resolveSessionId(scope: 'global' | 'session', sessionId?: string): string | undefined {
    if (scope === 'global') return undefined;
    const clean = sessionId?.trim();
    if (!clean) throw new Error('sessionId is required for session-scoped memory.');
    return clean;
  }

  private cleanContent(content: string): string {
    const clean = normalizeLineBreaks(content).trim();
    if (!clean) throw new Error('Memory content cannot be empty.');
    return clean;
  }

  private splitContentEntries(content: string): string[] {
    const items = normalizeLineBreaks(content)
      .split('\n')
      .flatMap((line) => line.split(/[;；]+/))
      .map((line) => line.trim())
      .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    if (items.length === 0) return [content];
    const unique: string[] = [];
    for (const item of items) {
      if (!unique.includes(item)) unique.push(item);
    }
    return unique;
  }
}
