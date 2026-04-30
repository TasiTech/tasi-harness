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
  finance: [
    'finance', 'financial', 'stock', 'invest', 'trading', 'economy', 'market',
    '\u8d22\u7ecf', '\u91d1\u878d', '\u80a1\u7968', '\u57fa\u91d1', '\u6295\u8d44', '\u7406\u8d22', '\u4ea4\u6613', '\u7ecf\u6d4e', '\u884c\u60c5', '\u8d44\u4ea7'
  ],
  daily_life: [
    'daily', 'life', 'lifestyle', 'home', 'routine', 'habit',
    '\u65e5\u5e38', '\u751f\u6d3b', '\u5c45\u5bb6', '\u5bb6\u52a1', '\u4e60\u60ef', '\u4f5c\u606f', '\u5b89\u6392'
  ],
  work: [
    'work', 'career', 'project', 'meeting', 'business', 'office',
    '\u5de5\u4f5c', '\u804c\u4e1a', '\u9879\u76ee', '\u4f1a\u8bae', '\u4e1a\u52a1', '\u529e\u516c', '\u9700\u6c42', '\u6392\u671f', '\u6c47\u62a5', '\u5ba2\u6237'
  ],
  travel: [
    'travel', 'trip', 'itinerary', 'flight', 'hotel', 'train', 'vacation', 'tour', 'sightseeing',
    '\u65c5\u884c', '\u65c5\u6e38', '\u884c\u7a0b', '\u673a\u7968', '\u9152\u5e97', '\u706b\u8f66', '\u9ad8\u94c1', '\u666f\u70b9', '\u653b\u7565',
    '\u51fa\u884c', '\u5ea6\u5047', '\u822a\u73ed', '\u8f66\u7968', '\u4f4f\u5bbf', '\u95e8\u7968', '\u76ee\u7684\u5730', '\u6e38\u73a9',
    '\u81ea\u9a7e', '\u5468\u8fb9\u6e38', '\u643a\u7a0b', '\u540c\u7a0b', '\u98de\u732a', '\u53bb\u54ea\u513f',
    'ctrip', 'trip.com'
  ],
  reading: [
    'reading', 'book', 'article', 'paper', 'literature', 'read',
    '\u9605\u8bfb', '\u8bfb\u4e66', '\u4e66\u7c4d', '\u6587\u7ae0', '\u8bba\u6587', '\u6587\u732e'
  ],
  education: [
    'education', 'study', 'learning', 'school', 'course', 'training',
    '\u6559\u80b2', '\u5b66\u4e60', '\u8bfe\u7a0b', '\u5b66\u6821', '\u57f9\u8bad', '\u8003\u8bd5', '\u590d\u4e60'
  ],
  health: [
    'health', 'medical', 'wellness', 'fitness', 'doctor', 'medicine',
    '\u5065\u5eb7', '\u533b\u7597', '\u5065\u8eab', '\u8fd0\u52a8', '\u533b\u751f', '\u836f', '\u7528\u836f', '\u4f53\u68c0', '\u996e\u98df'
  ],
  other: ['other', 'misc', 'miscellaneous', 'default', 'general', '\u5176\u4ed6', '\u901a\u7528', '\u6742\u9879']
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasHitCount(text: string, alias: string): number {
  const source = text.trim().toLowerCase();
  const needle = alias.trim().toLowerCase();
  if (!source || !needle) return 0;

  const latinAlias = /^[a-z0-9._/-]+$/.test(needle);
  if (!latinAlias) {
    let idx = source.indexOf(needle);
    let count = 0;
    while (idx >= 0) {
      count += 1;
      idx = source.indexOf(needle, idx + needle.length);
    }
    return count;
  }

  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}(?=$|[^a-z0-9])`, 'g');
  let count = 0;
  while (pattern.exec(source)) count += 1;
  if (count > 0) return count;

  return source.includes(needle) ? 1 : 0;
}

function normalizeDomainValue(input?: string): MemoryDomain {
  const raw = (input || '').trim().toLowerCase();
  if (!raw || raw === 'general') return DEFAULT_DOMAIN;
  for (const [domain, aliases] of Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>) {
    if (domain === raw) return domain;
    if (aliases.some((alias) => aliasHitCount(raw, alias) > 0)) return domain;
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
    const scored = (Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>)
      .map(([domain, aliases], index) => ({
        domain,
        index,
        score: aliases.reduce((count, alias) => count + aliasHitCount(normalized, alias), 0)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.domain);
    return scored.length > 0 ? scored : [DEFAULT_DOMAIN];
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
    const inferredDomain = this.inferDomains(clean)[0] ?? DEFAULT_DOMAIN;
    const requestedDomain = options.domain ? normalizeDomainValue(options.domain) : undefined;
    // If caller passes "other" but content clearly matches a concrete domain, prefer inferred classification.
    const domain = requestedDomain
      ? (requestedDomain === DEFAULT_DOMAIN && inferredDomain !== DEFAULT_DOMAIN ? inferredDomain : requestedDomain)
      : inferredDomain;
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
      .split(/[\s,.;:!?，。；：！、]+/)
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
    const userMessages = record.messages
      .filter((message) => message.role === 'user')
      .map((message) => compactText(message.content, 180))
      .filter(Boolean);
    const assistantMessages = record.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .filter((content) => content.trim() && !/^Reached iteration limit\b/i.test(content))
      .map((content) => compactText(content, 220))
      .filter(Boolean);

    const firstUser = compactText(userMessages[0] ?? '', 140);
    if (!firstUser) return null;

    const latestUser = compactText(userMessages[userMessages.length - 1] ?? '', 160);
    const lastAssistant = compactText(assistantMessages[assistantMessages.length - 1] ?? '', 220);
    const toolSignals = this.collectToolSignals(record);
    const constraints = this.collectConstraintSignals(userMessages);

    const parts: string[] = [`Goal: ${firstUser}`];
    if (latestUser && !this.snapshotNearDuplicate(latestUser, firstUser)) {
      parts.push(`Latest ask: ${latestUser}`);
    }
    if (constraints.length > 0) {
      parts.push(`Constraints: ${constraints.join(' ; ')}`);
    }
    if (toolSignals.length > 0) {
      parts.push(`Tools: ${toolSignals.join(', ')}`);
    }
    if (lastAssistant && !this.snapshotNearDuplicate(lastAssistant, firstUser)) {
      parts.push(`Outcome: ${lastAssistant}`);
    }

    const content = compactText(parts.join(' | '), 720);
    const domainSeed = [firstUser, latestUser, lastAssistant, ...toolSignals].filter(Boolean).join(' ');
    return {
      content,
      domain: this.inferDomains(domainSeed || firstUser)[0] ?? DEFAULT_DOMAIN
    };
  }

  private collectConstraintSignals(userMessages: string[]): string[] {
    const terms = [
      'must', 'should', 'avoid', 'deadline', 'budget', 'limit',
      '\u5fc5\u987b', '\u4e0d\u8981', '\u4f18\u5148', '\u622a\u6b62', '\u9884\u7b97', '\u9650\u5236', '\u5c3d\u5feb', '\u5148'
    ];
    const picked: string[] = [];
    const seen = new Set<string>();

    for (let i = userMessages.length - 1; i >= 0; i--) {
      const message = normalizeLineBreaks(userMessages[i] ?? '');
      const fragments = message
        .split(/\n|[。！？!?;；]/)
        .map((chunk) => chunk.trim())
        .filter(Boolean);
      for (const fragment of fragments) {
        const lower = fragment.toLowerCase();
        if (!terms.some((term) => lower.includes(term))) continue;
        const signal = compactText(fragment, 96);
        if (!signal || seen.has(signal)) continue;
        seen.add(signal);
        picked.push(signal);
        if (picked.length >= 2) return picked;
      }
    }

    return picked;
  }
  private snapshotNearDuplicate(left: string, right: string): boolean {
    const a = normalizeLineBreaks(left).replace(/\s+/g, ' ').trim().toLowerCase();
    const b = normalizeLineBreaks(right).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  private collectToolSignals(record: SessionRecord): string[] {
    const seen = new Set<string>();
    const signals: string[] = [];

    for (const message of record.messages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const name = call?.function?.name?.trim();
          if (!name) continue;
          const token = `call:${name}`;
          if (seen.has(token)) continue;
          seen.add(token);
          signals.push(token);
          if (signals.length >= 4) return signals;
        }
      }

      if (message.role !== 'tool') continue;
      const explicitName = message.name?.trim();
      if (explicitName) {
        const token = `tool:${explicitName}`;
        if (!seen.has(token)) {
          seen.add(token);
          signals.push(token);
          if (signals.length >= 4) return signals;
        }
      }
      const contentHint = compactText(message.content, 44);
      if (contentHint) {
        const token = `result:${contentHint}`;
        if (!seen.has(token)) {
          seen.add(token);
          signals.push(token);
          if (signals.length >= 4) return signals;
        }
      }
    }

    return signals;
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
      .flatMap((line) => line.split(/[;；、]+/))
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

