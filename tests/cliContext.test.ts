import { describe, expect, it } from 'vitest';
import { CliContext } from '../src/main/cliContext.js';
import { tempHome } from './helpers.js';

describe('CliContext', () => {
  it('runs chat with the shared agent loop and exposes CLI browser tools', async () => {
    const env = tempHome();
    try {
      const context = new CliContext(env.home);
      context.configStore.update({ provider: 'mock', enabledToolNames: ['browser_open', 'session_search', 'file_read'] });

      const toolNames = context.toolRegistry.definitions(context.getConfig().enabledToolNames).map((tool) => tool.function.name);
      expect(toolNames).toContain('session_search');
      expect(toolNames).toContain('file_read');
      expect(toolNames).toContain('browser_open');

      const result = await context.runChat({ userInput: 'hello from cli' });
      expect(result.finalResponse).toBe('Mock provider is active.');
      expect(context.sessionStore.read(result.sessionId)?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(context.getConfig().externalBrowserProfileMode).toBe('isolated');
      expect(context.getConfig().externalBrowserCdpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(context.getConfig().externalBrowserCdpEndpoint).not.toBe('http://127.0.0.1:9222');
    } finally {
      env.cleanup();
    }
  });

  it('uses a separate CDP endpoint for each CLI context', () => {
    const env = tempHome();
    try {
      const first = new CliContext(env.home);
      const second = new CliContext(env.home);
      expect(first.getConfig().externalBrowserCdpEndpoint).not.toBe(second.getConfig().externalBrowserCdpEndpoint);
    } finally {
      env.cleanup();
    }
  });
});
