import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient } from '../src/main/agent/llmClient.js';
import type { ToolDefinition } from '../src/shared/types.js';
import { defaultConfig } from '../src/main/storage/pathUtils.js';

const browserOpenTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'browser_open',
    description: 'Open a webpage.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    }
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('llmClient', () => {
  it('uses Anthropic Messages API and parses tool_use blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_test',
          role: 'assistant',
          content: [
            { type: 'text', text: 'I can open that.' },
            { type: 'tool_use', id: 'toolu_1', name: 'browser_open', input: { url: 'https://example.com' } }
          ],
          usage: { input_tokens: 11, output_tokens: 7 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient({
      ...defaultConfig(),
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'anthropic-test-key',
      model: 'claude-3-7-sonnet-latest'
    });

    const result = await client.complete({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Please open example.com' }
      ],
      tools: [browserOpenTool],
      maxTokens: 256
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('anthropic-test-key');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(String(init.body));
    expect(body.system).toBe('You are helpful.');
    expect(body.model).toBe('claude-3-7-sonnet-latest');
    expect(body.tools[0].name).toBe('browser_open');
    expect(body.tools[0].input_schema.required).toEqual(['url']);

    expect(result.message.content).toBe('I can open that.');
    expect(result.message.tool_calls?.[0].function.name).toBe('browser_open');
    expect(result.message.tool_calls?.[0].function.arguments).toBe('{"url":"https://example.com"}');
    expect(result.usage?.totalTokens).toBe(18);
  });

  it('retries transient 500 HTML upstream failures and eventually succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          [
            '<html>',
            '<head><title>500 Internal Server Error</title></head>',
            '<body><center><h1>500 Internal Server Error</h1></center><hr><center>nginx</center></body>',
            '</html>'
          ].join('\n'),
          {
            status: 500,
            headers: {
              'Content-Type': 'text/html',
              'Retry-After': '0'
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'Recovered after retry.' }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient({
      ...defaultConfig(),
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4'
    });

    const result = await client.complete({
      messages: [{ role: 'user', content: 'hello' }]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.message.content).toBe('Recovered after retry.');
  });

  it('returns sanitized HTML error details instead of raw HTML', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          [
            '<html>',
            '<head><title>500 Internal Server Error</title></head>',
            '<body><center><h1>500 Internal Server Error</h1></center><hr><center>nginx</center></body>',
            '</html>'
          ].join('\n'),
          {
            status: 500,
            headers: {
              'Content-Type': 'text/html',
              'Retry-After': '0'
            }
          }
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient({
      ...defaultConfig(),
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4'
    });

    let cause: unknown;
    try {
      await client.complete({
        messages: [{ role: 'user', content: 'hello' }]
      });
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(Error);
    const message = (cause as Error).message;
    expect(message).toMatch(/LLM request failed \(500\)/);
    expect(message).toContain('HTML error page');
    expect(message).toContain('nginx');
    expect(message).not.toMatch(/<html>/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('preserves and forwards reasoning_content for openai-compatible providers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  reasoning_content: 'internal chain',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: 'done' }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient({
      ...defaultConfig(),
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek_v4_flash'
    });

    const first = await client.complete({
      messages: [{ role: 'user', content: 'open example.com' }],
      tools: [browserOpenTool]
    });
    expect(first.message.reasoning_content).toBe('internal chain');

    await client.complete({
      messages: [
        { role: 'user', content: 'open example.com' },
        first.message,
        { role: 'tool', tool_call_id: 'call_1', content: 'opened' }
      ],
      tools: [browserOpenTool]
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body));
    expect(secondBody.messages[1].reasoning_content).toBe('internal chain');
  });

  it('drops malformed deepseek historical tool traces that miss reasoning_content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'ok' }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = createLlmClient({
      ...defaultConfig(),
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash'
    });

    await client.complete({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'question 1' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'legacy_call_1',
              type: 'function',
              function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' }
            }
          ]
        },
        { role: 'tool', tool_call_id: 'legacy_call_1', content: 'opened' },
        { role: 'assistant', content: 'old final answer' },
        { role: 'user', content: 'question 2' }
      ],
      tools: [browserOpenTool]
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const outgoingMessages = body.messages as Array<Record<string, unknown>>;
    const hasLegacyToolCall = outgoingMessages.some(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.some((call: any) => call?.id === 'legacy_call_1')
    );
    const hasLegacyToolResult = outgoingMessages.some(
      (message) => message.role === 'tool' && message.tool_call_id === 'legacy_call_1'
    );
    expect(hasLegacyToolCall).toBe(false);
    expect(hasLegacyToolResult).toBe(false);
  });
});
