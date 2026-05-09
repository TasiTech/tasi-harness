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
});
