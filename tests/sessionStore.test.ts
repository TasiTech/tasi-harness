import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/main/storage/sessionStore.js';
import { tempHome } from './helpers.js';

describe('SessionStore', () => {
  it('classifies session summaries with memory domains', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create();
      store.appendMessages(session.id, [
        { id: 'm1', role: 'user', content: 'Plan a travel itinerary with flights and hotels.', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'I will compare flight and hotel options.', createdAt: '2026-01-01T00:00:01.000Z' }
      ]);

      expect(store.read(session.id)?.domain).toBe('travel');
      expect(store.list()[0]?.domain).toBe('travel');
    } finally {
      env.cleanup();
    }
  });

  it('lists session history in pages with query and category counts', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      for (let index = 0; index < 30; index += 1) {
        const session = store.create(index % 2 === 0 ? `Travel item ${index}` : `Work item ${index}`);
        store.appendMessages(session.id, [
          {
            id: `m${index}`,
            role: 'user',
            content: index % 2 === 0 ? 'Plan a travel itinerary with hotels.' : 'Prepare a work project update.',
            createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`
          }
        ]);
      }
      const wechat = store.create('WeChat ClawBot');

      const page = store.listPage({ page: 2, pageSize: 10 });
      const travel = store.listPage({ page: 1, pageSize: 5, query: 'item', category: 'travel' });
      const wechatPage = store.listPage({ page: 1, pageSize: 10, category: 'wechat-clawbot', wechatSessionId: wechat.id });

      expect(page.total).toBe(31);
      expect(page.sessions).toHaveLength(10);
      expect(page.totalPages).toBe(4);
      expect(page.categoryCounts.all).toBe(31);
      expect(page.categoryCounts.travel).toBe(15);
      expect(page.categoryCounts.work).toBe(15);
      expect(page.categoryCounts['wechat-clawbot']).toBe(1);
      expect(travel.total).toBe(15);
      expect(travel.sessions).toHaveLength(5);
      expect(travel.sessions.every((session) => session.title.toLowerCase().includes('travel item'))).toBe(true);
      expect(wechatPage.total).toBe(1);
      expect(wechatPage.sessions[0]?.id).toBe(wechat.id);
    } finally {
      env.cleanup();
    }
  });

  it('keeps the session summary index current for fast list loading', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Indexed session');
      store.appendMessages(session.id, [
        { id: 'm1', role: 'user', content: 'Prepare a work update.', createdAt: '2026-01-01T00:00:00.000Z' }
      ]);

      expect(store.listPage({ page: 1, pageSize: 10 }).sessions[0]?.title).toBe('Indexed session');
      expect(existsSync(join(env.home, 'sessions-index.json'))).toBe(true);

      store.rename(session.id, 'Renamed indexed session');
      expect(store.list()[0]?.title).toBe('Renamed indexed session');

      store.delete(session.id);
      expect(store.listPage({ page: 1, pageSize: 10 }).total).toBe(0);
      const indexRaw = readFileSync(join(env.home, 'sessions-index.json'), 'utf8');
      expect(indexRaw).not.toContain(session.id);
    } finally {
      env.cleanup();
    }
  });

  it('clips search highlights so large session messages do not become huge tool results', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Huge browser output');
      const huge = `needle ${'x'.repeat(10000)}`;
      store.appendMessages(session.id, [
        { id: 'm1', role: 'tool', name: 'browser_snapshot', content: huge, createdAt: '2026-01-01T00:00:00.000Z' }
      ]);

      const results = store.search('needle', 1);

      expect(results).toHaveLength(1);
      expect(results[0]?.highlights[0]?.length).toBeLessThan(1300);
      expect(results[0]?.highlights[0]).toContain('[truncated');
    } finally {
      env.cleanup();
    }
  });

  it('builds skill optimization context only from selected sessions and keeps it bounded', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const selected = store.create('Selected failing task');
      const other = store.create('Unrelated task');
      store.appendMessages(selected.id, [
        { id: 'm1', role: 'user', content: 'Fill the reimbursement form.', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', role: 'tool', name: 'browser_snapshot', content: `Error: login timed out ${'x'.repeat(20000)}`, createdAt: '2026-01-01T00:00:01.000Z' }
      ]);
      store.appendMessages(other.id, [
        { id: 'm3', role: 'user', content: 'This unrelated session must not appear.', createdAt: '2026-01-01T00:00:00.000Z' }
      ]);

      const result = store.buildOptimizationContext({
        sessionIds: [selected.id],
        maxCharsPerSession: 3000,
        maxTotalChars: 4000
      });

      expect(result.context).toContain(selected.id);
      expect(result.context).toContain('login timed out');
      expect(result.context).toContain('[truncated');
      expect(result.context).not.toContain(other.id);
      expect(result.context).not.toContain('This unrelated session must not appear');
      expect(result.totalChars).toBeLessThan(4500);
    } finally {
      env.cleanup();
    }
  });

  it('returns compact records for UI display without changing stored full content', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Large UI session');
      const hugeMessage = `Visible start ${'m'.repeat(20000)}`;
      const hugeTool = `Tool start ${'t'.repeat(20000)}`;
      store.appendMessages(session.id, [
        {
          id: 'm1',
          role: 'user',
          content: hugeMessage,
          attachments: [{
            id: 'a1',
            kind: 'image',
            filename: 'screenshot.png',
            mimeType: 'image/png',
            contentBase64: 'x'.repeat(10000),
            sizeBytes: 7500
          }],
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        { id: 'm2', role: 'tool', name: 'session_search', content: hugeTool, createdAt: '2026-01-01T00:00:01.000Z' }
      ]);

      const display = store.readForDisplay(session.id);
      const full = store.read(session.id);

      expect(display?.messages[0]?.content.length).toBeLessThan(13000);
      expect(display?.messages[0]?.content).toContain('[preview only');
      expect(display?.messages[0]?.contentOmitted).toBe(true);
      expect(display?.messages[0]?.attachments?.[0]?.contentBase64).toBe('');
      expect(display?.toolEvents[0]?.content.length).toBeLessThan(7000);
      expect(display?.toolEvents[0]?.content).toContain('[preview only');
      expect(display?.toolEvents[0]?.contentOmitted).toBe(true);
      expect(full?.messages[0]?.content.length).toBe(hugeMessage.length);
      expect(full?.messages[0]?.attachments?.[0]?.contentBase64.length).toBe(10000);
    } finally {
      env.cleanup();
    }
  });

  it('rebuilds hidden sidecar tool audit messages as tool events without showing them as chat messages', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('DSH sidecar run');
      store.appendMessages(session.id, [
        {
          id: 'toolevent_sidecar',
          role: 'tool',
          name: 'dsh_sidecar_chat',
          hidden: true,
          content: '{"plugin":"@nanmicoder/dsh-agent-teams"}',
          createdAt: '2026-09-02T00:00:00.000Z'
        },
        {
          id: 'msg_answer',
          role: 'assistant',
          content: 'Done.',
          createdAt: '2026-09-02T00:00:01.000Z'
        }
      ]);

      const full = store.read(session.id);
      const display = store.readForDisplay(session.id);

      expect(full?.toolEvents).toHaveLength(1);
      expect(full?.toolEvents[0]?.toolName).toBe('dsh_sidecar_chat');
      expect(display?.messages.map((message) => message.id)).toEqual(['msg_answer']);
      expect(display?.toolEvents).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });

  it('preserves hidden assistant content while omitting it from searchable visible context', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Hidden assistant preamble');
      store.appendMessages(session.id, [
        { id: 'm1', role: 'user', content: 'Write a file.', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          id: 'm2',
          role: 'assistant',
          hidden: true,
          content: 'I will call the file tool before answering.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_write', arguments: '{}' }
          }],
          createdAt: '2026-01-01T00:00:01.000Z'
        },
        { id: 'm3', role: 'tool', name: 'file_write', tool_call_id: 'call_1', content: 'ok', createdAt: '2026-01-01T00:00:02.000Z' },
        { id: 'm4', role: 'assistant', content: 'Done.', createdAt: '2026-01-01T00:00:03.000Z' }
      ]);

      const raw = readFileSync(join(env.home, 'sessions', `${session.id}.json`), 'utf8');
      const full = store.read(session.id);
      const display = store.readForDisplay(session.id);
      const search = store.search('before answering');
      const optimization = store.buildOptimizationContext({ sessionIds: [session.id] });

      expect(raw).toContain('I will call the file tool before answering.');
      expect(full?.messages[1]?.content).toBe('I will call the file tool before answering.');
      expect(full?.messages[1]?.hidden).toBe(true);
      expect(display?.messages.some((message) => message.hidden === true)).toBe(false);
      expect(display?.messages.some((message) => message.content === 'I will call the file tool before answering.')).toBe(false);
      expect(search).toHaveLength(0);
      expect(optimization.context).not.toContain('before answering');
      expect(optimization.context).toContain('Done.');
    } finally {
      env.cleanup();
    }
  });

  it('derives assistant content parts from hidden session messages without persisting content_parts', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Derived content parts');
      store.appendMessages(session.id, [
        { id: 'm1', role: 'user', content: 'Write a file.', createdAt: '2026-01-01T00:00:00.000Z' },
        {
          id: 'm2',
          role: 'assistant',
          hidden: true,
          content: 'I will inspect first.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_read', arguments: '{}' }
          }],
          createdAt: '2026-01-01T00:00:01.000Z'
        },
        { id: 'm3', role: 'tool', name: 'file_read', tool_call_id: 'call_1', content: 'ok', createdAt: '2026-01-01T00:00:02.000Z' },
        {
          id: 'm4',
          role: 'assistant',
          content: 'Done.',
          content_parts: ['I will inspect first.'],
          createdAt: '2026-01-01T00:00:03.000Z'
        }
      ]);

      const raw = readFileSync(join(env.home, 'sessions', `${session.id}.json`), 'utf8');
      const full = store.read(session.id);
      const display = store.readForDisplay(session.id);
      const fullMessage = store.readMessageContent(session.id, 'm4');

      expect(raw).not.toContain('content_parts');
      expect(full?.messages.find((message) => message.id === 'm4')?.content_parts).toBeUndefined();
      expect(display?.messages.find((message) => message.id === 'm4')?.content_parts).toEqual(['I will inspect first.']);
      expect(fullMessage?.content_parts).toEqual(['I will inspect first.']);
    } finally {
      env.cleanup();
    }
  });

  it('redacts browser credential values before persisting session records', () => {
    const env = tempHome();
    try {
      const store = new SessionStore(env.home);
      const session = store.create('Browser login');
      store.appendMessages(session.id, [
        {
          id: 'm1',
          role: 'assistant',
          content: '\u59d3\u540d\n\u5f20\u4e09\n\u7533\u8bf7\u4eba\n\u674e\u56db',
          reasoning_content: 'The username is 1234567890 and the password field is filled. 申请人：张三。',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'browser_type',
              arguments: JSON.stringify({ selector: '#i_user', text: '9876543210', 收款人: '李四' })
            }
          }],
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'm2',
          role: 'tool',
          name: 'browser_snapshot',
          content: JSON.stringify({
            tool: 'browser_snapshot',
            snapshot: '- textbox "Username" [@e1] value="1357913579"\n- textbox "姓名" [@e2] value="王五"',
            elements: [
              { ref: '@e1', role: 'textbox', name: 'Username', selector: '#i_user', value: '2468024680' },
              { ref: '@e2', role: 'textbox', name: '姓名', selector: '#person_name', value: '赵六' }
            ]
          }),
          createdAt: '2026-01-01T00:00:01.000Z'
        }
      ]);

      const raw = readFileSync(join(env.home, 'sessions', `${session.id}.json`), 'utf8');
      const record = store.read(session.id);

      expect(raw).toContain('xxxx');
      for (const fakeAccount of ['1234567890', '9876543210', '1357913579', '2468024680']) {
        expect(raw).not.toContain(fakeAccount);
        expect(JSON.stringify(record)).not.toContain(fakeAccount);
      }
      for (const fakeName of ['张三', '李四', '王五', '赵六', '\u5f20\u4e09', '\u674e\u56db']) {
        expect(raw).not.toContain(fakeName);
        expect(JSON.stringify(record)).not.toContain(fakeName);
      }
    } finally {
      env.cleanup();
    }
  });
});
