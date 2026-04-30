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

  it('classifies travel intents into the travel domain', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);

    expect(store.inferDomains('plan a 5-day trip with flight and hotel')).toContain('travel');
    store.add('memory', 'Compare hotel options near the station and check flight prices.', { scope: 'session', sessionId: 's_trip' });
    const trip = store.getState({ target: 'memory', sessionId: 's_trip', includeGlobal: false });
    expect(trip.entries[0]?.domain).toBe('travel');
  });

  it('classifies Chinese intents into matching domains', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);

    expect(store.inferDomains('帮我做一份旅行行程和酒店机票攻略')).toContain('travel');
    expect(store.inferDomains('整理一下股票和基金投资计划')).toContain('finance');
    expect(store.inferDomains('下周项目排期和会议安排')).toContain('work');
    expect(store.inferDomains('最近健身和体检提醒')).toContain('health');
    expect(store.inferDomains('携程景点和攻略页参数整理')).toContain('travel');
  });

  it('upgrades explicit other domain when content strongly matches travel', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);

    store.add('memory', '携程行程：机票酒店和景点攻略安排。', {
      scope: 'session',
      sessionId: 's_travel',
      domain: 'other'
    });
    const state = store.getState({ target: 'memory', sessionId: 's_travel', includeGlobal: false });
    expect(state.entries[0]?.domain).toBe('travel');
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
    expect(entries[0]?.content).toContain('Goal:');
    expect(entries[0]?.content).toContain('Fix the preview resize behavior');
    expect(entries[0]?.content).toContain('Outcome:');
    expect(entries[0]?.content).toContain('resize logic');
  });

  it('includes tool signals in automatic session memory snapshots', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new MemoryStore(env.home);
    const session: SessionRecord = {
      id: 'session_tools',
      title: 'tools',
      createdAt: '2026-04-22T00:00:00.000Z',
      updatedAt: '2026-04-22T00:02:00.000Z',
      messageCount: 3,
      messages: [
        { id: 'm1', role: 'user', content: 'Search ctrip hotel and flight options for Shanghai', createdAt: '2026-04-22T00:00:00.000Z' },
        {
          id: 'm2',
          role: 'assistant',
          content: '',
          createdAt: '2026-04-22T00:01:00.000Z',
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'skill_view', arguments: '{"ref_path":"provider-ctrip-browser.md"}' } }]
        },
        {
          id: 'm3',
          role: 'tool',
          name: 'skill_view',
          tool_call_id: 'tc_1',
          content: 'Loaded provider-ctrip-browser reference',
          createdAt: '2026-04-22T00:01:05.000Z'
        },
        {
          id: 'm4',
          role: 'assistant',
          content: 'Collected hotel, flight, train, and attractions URLs, then prepared tool-ready parameters.',
          createdAt: '2026-04-22T00:02:00.000Z'
        }
      ],
      toolEvents: [],
      lastExecution: { mode: 'workspace', workspaceDir: '' }
    };

    expect(store.syncSessionMemory(session)).toBe(true);

    const entry = store.getState({ target: 'memory', sessionId: 'session_tools', includeGlobal: false }).entries[0];
    expect(entry?.content).toContain('Tools:');
    expect(entry?.content).toContain('call:skill_view');
    expect(entry?.content).toContain('Outcome:');
    expect(entry?.content.length ?? 0).toBeGreaterThan(120);
  });
});
