import { describe, expect, it } from 'vitest';
import { parseArgs, renderMarkdownForTerminal } from '../src/main/cli.js';

describe('CLI argument parsing', () => {
  it('continues a chat with --session', () => {
    expect(parseArgs(['chat', '--session', 'abc123', 'continue this chat'])).toMatchObject({
      command: 'chat',
      sessionId: 'abc123',
      message: 'continue this chat'
    });
  });

  it('creates a new chat when no session id is provided', () => {
    const parsed = parseArgs(['chat', 'write a plan']);
    expect(parsed).toMatchObject({
      command: 'chat',
      message: 'write a plan'
    });
    expect(parsed.sessionId).toBeUndefined();
  });

  it('supports short options for common parameters', () => {
    expect(parseArgs(['chat', '-s', 'abc123', '-e', 'sandbox', '-k', '-j', '-p', '-V', '-H', '.tmp/home', 'hello'])).toMatchObject({
      command: 'chat',
      sessionId: 'abc123',
      executionMode: 'sandbox',
      usePersonalKnowledgeBase: true,
      json: true,
      plain: true,
      verbose: true,
      home: '.tmp/home',
      message: 'hello'
    });
  });

  it('does not treat a positional id-like value as the session id', () => {
    const parsed = parseArgs(['chat', 'abc123', 'hello']);
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.message).toBe('abc123 hello');
  });

  it('renders headings without markdown prefixes and de-indents markdown list items', () => {
    const rendered = renderMarkdownForTerminal(['## 北京当前天气', '', '    * **温度**：21°C'].join('\n'));

    expect(rendered).toContain('北京当前天气');
    expect(rendered).not.toContain('## 北京当前天气');
    expect(rendered).toContain('温度');
    expect(rendered).not.toContain('**温度**');
  });
});
