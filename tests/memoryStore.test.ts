import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/main/storage/memoryStore.js';
import type { SessionRecord } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('MemoryStore', () => {
  it('adds split session entries and removes them', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    store.add('memory', 'Track AAPL earnings\nReview monthly budget;Sync invoice reminders', { sessionId: 's_finance', domain: 'finance' });

    const stateAfterAdd = store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false });
    expect(stateAfterAdd.entries).toHaveLength(3);
    expect(stateAfterAdd.entries.every((entry) => entry.scope === 'session' && entry.sessionId === 's_finance')).toBe(true);

    const firstId = stateAfterAdd.entries[0]?.id;
    expect(firstId).toBeTruthy();
    store.remove('memory', '', { entryId: firstId });
    expect(store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false }).entries).toHaveLength(2);
  });

  it('clears memory by entry, domain, and all', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);

    store.add('memory', 'Finance note A\nFinance note B', { sessionId: 's_finance', domain: 'finance' });
    store.add('memory', 'Health note', { sessionId: 's_finance', domain: 'health' });
    store.add('memory', 'Work note', { sessionId: 's_work', domain: 'work' });

    const financeEntries = store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false }).entries;
    const entryId = financeEntries.find((entry) => entry.domain === 'finance')?.id;
    expect(entryId).toBeTruthy();

    store.clear({ target: 'memory', mode: 'entry', entryId });
    expect(store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false }).entries).toHaveLength(2);

    store.clear({ target: 'memory', mode: 'domain', domain: 'finance', sessionId: 's_finance' });
    const remainingFinanceSession = store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false }).entries;
    expect(remainingFinanceSession).toHaveLength(1);
    expect(remainingFinanceSession[0]?.domain).toBe('health');

    store.clear({ target: 'memory', mode: 'all', sessionId: 's_work' });
    expect(store.getState({ target: 'memory', sessionId: 's_work', includeGlobal: false }).entries).toHaveLength(0);
    expect(store.getState({ target: 'memory', sessionId: 's_finance', includeGlobal: false }).entries).toHaveLength(1);

    store.clear({ target: 'memory', mode: 'all' });
    expect(store.getState({ target: 'memory', includeGlobal: true }).entries).toHaveLength(0);
  });

  it('rejects entries over target capacity', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    expect(() => store.add('user', 'x'.repeat(2000))).toThrow(/exceed/);
  });

  it('retrieves session memory by domain and intent', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    store.add('memory', 'Watch AAPL earnings release and portfolio risk.', { scope: 'session', sessionId: 's_finance', domain: 'finance' });
    store.add('memory', 'Increase daily walking and hydration reminders.', { scope: 'session', sessionId: 's_health', domain: 'health' });
    store.add('user', 'User prefers concise summaries.', { scope: 'global', domain: 'other' });

    const finance = store.getState({ sessionId: 's_finance', domain: 'finance', intent: 'today stock finance update' });
    expect(finance.entries.some((entry) => entry.content.includes('AAPL'))).toBe(true);
    expect(finance.entries.some((entry) => entry.domain === 'health')).toBe(false);
    expect(finance.rendered).toContain('finance');
  });

  it('queues memory and commits only after completion', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);

    store.beginDeferredSession('s_work');
    store.queueAdd('s_work', 'memory', 'Prepare roadmap\nShare sprint demo', { domain: 'work' });
    expect(store.getState({ target: 'memory', sessionId: 's_work', includeGlobal: false }).entries).toHaveLength(0);
    expect(store.pendingCount('s_work')).toBe(1);

    const added = store.commitDeferredSession('s_work');
    expect(added.applied).toBe(1);
    expect(added.errors).toHaveLength(0);
    expect(store.getState({ target: 'memory', sessionId: 's_work', includeGlobal: false }).entries).toHaveLength(2);

    store.beginDeferredSession('s_work');
    store.queueRemove('s_work', 'memory', 'roadmap', { sessionId: 's_work', domain: 'work' });
    expect(store.getState({ target: 'memory', sessionId: 's_work', includeGlobal: false }).entries).toHaveLength(2);
    const removed = store.commitDeferredSession('s_work');
    expect(removed.applied).toBe(1);
    expect(store.getState({ target: 'memory', sessionId: 's_work', includeGlobal: false }).entries).toHaveLength(1);
  });

  it('rejects replace edits', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    store.add('user', 'User prefers TypeScript over JavaScript.', { domain: 'work' });
    expect(() => store.replace('user', 'TypeScript', 'User prefers strict TypeScript.')).toThrow(/disabled/i);
  });

  it('syncs automatic session memory from stored conversations', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    const session: SessionRecord = {
      id: 'session_demo',
      title: 'demo',
      createdAt: '2026-04-22T00:00:00.000Z',
      updatedAt: '2026-04-22T00:01:00.000Z',
      messageCount: 2,
      messages: [
        { id: 'm1', role: 'user', content: 'Fix the preview resize behavior', createdAt: '2026-04-22T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'I updated the resize logic and verified the build.', createdAt: '2026-04-22T00:01:00.000Z' }
      ],
      toolEvents: [],
      lastExecution: { mode: 'workspace', workspaceDir: '' }
    };

    expect(store.syncSessionMemory(session)).toBe(true);

    const entries = store.getState({ target: 'memory', sessionId: 'session_demo', includeGlobal: false }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toContain('Fix the preview resize behavior');
    expect(entries[0]?.content).toContain('resize logic');
  });
});
