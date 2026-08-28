import { readFileSync } from 'node:fs';
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
      expect(display?.messages[1]?.content).toBe('I will call the file tool before answering.');
      expect(search).toHaveLength(0);
      expect(optimization.context).not.toContain('before answering');
      expect(optimization.context).toContain('Done.');
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
