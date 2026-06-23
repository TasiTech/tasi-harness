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
      message: 'write a plan',
      stream: true
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

  it('supports explicit stream and no-stream flags', () => {
    expect(parseArgs(['chat', '--no-stream', 'hello'])).toMatchObject({
      message: 'hello',
      stream: false
    });
    expect(parseArgs(['chat', '--no-stream', '--stream', 'hello'])).toMatchObject({
      message: 'hello',
      stream: true
    });
  });

  it('parses runtime memory, skill, and tool controls', () => {
    expect(parseArgs([
      'chat',
      '--no-memory',
      '--memory-domains',
      'work,travel',
      '--no-skills',
      '--skill',
      'docx',
      '--skills',
      'tasi-travel,deep-search',
      '--tools',
      'file_read,browser_open',
      'hello'
    ])).toMatchObject({
      message: 'hello',
      useMemory: false,
      memoryDomains: ['work', 'travel'],
      useSkills: false,
      enabledSkillNames: ['docx', 'tasi-travel', 'deep-search'],
      enabledToolNames: ['file_read', 'browser_open']
    });
  });

  it('supports disabling all tools from the CLI', () => {
    expect(parseArgs(['chat', '--tools', 'none', 'hello'])).toMatchObject({
      message: 'hello',
      enabledToolNames: []
    });
  });

  it('parses log probs request flags', () => {
    expect(parseArgs(['chat', '--json', '--log-probs', 'hello'])).toMatchObject({
      message: 'hello',
      json: true,
      logProbs: true
    });
    expect(parseArgs(['chat', '--json', '--log_probs', 'hello'])).toMatchObject({
      message: 'hello',
      json: true,
      logProbs: true
    });
  });

  it('parses top logprobs and implies log probs', () => {
    expect(parseArgs(['chat', '--json', '--top-logprobs', '3', 'hello'])).toMatchObject({
      message: 'hello',
      json: true,
      logProbs: true,
      topLogProbs: 3
    });
    expect(parseArgs(['chat', '--json', '--top_logprobs', '1', 'hello'])).toMatchObject({
      message: 'hello',
      json: true,
      logProbs: true,
      topLogProbs: 1
    });
    expect(() => parseArgs(['chat', '--top-logprobs', '6', 'hello'])).toThrow(/Expected an integer from 0 to 5/);
  });

  it('renders headings without markdown prefixes and de-indents markdown list items', () => {
    const rendered = renderMarkdownForTerminal(['## Current weather', '', '    * **Temperature**: 21 C'].join('\n'));

    expect(rendered).toContain('Current weather');
    expect(rendered).not.toContain('## Current weather');
    expect(rendered).toContain('Temperature');
    expect(rendered).not.toContain('**Temperature**');
  });

});
