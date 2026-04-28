import type { AgentMessage, AppConfig, LlmCompletion, LlmRequest, ToolCall, ToolDefinition } from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import { providerApiStyle, providerRequiresApiKey } from '../../shared/providerCatalog.js';

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmCompletion>;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

const MAX_LLM_REQUEST_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 2000;

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function runtimeFetch(input: string, init: RequestInit): Promise<Response> {
  if (process.versions?.electron) {
    try {
      const electron = await import('electron');
      if (typeof electron.net?.fetch === 'function') {
        return await electron.net.fetch(input, init);
      }
    } catch {
      // Fall back to the Node/global fetch implementation below.
    }
  }
  return fetch(input, init);
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function fetchFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = error.message || error.name || 'Unknown fetch error';
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return base;
  const code = 'code' in cause && typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : '';
  const causeMessage = 'message' in cause && typeof (cause as { message?: unknown }).message === 'string' ? (cause as { message: string }).message : '';
  return [base, code, causeMessage].filter(Boolean).join(' | ');
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function appendAttemptSuffix(message: string, attempt: number): string {
  if (attempt <= 0) return message;
  return `${message} (after ${attempt + 1} attempts)`;
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.max(0, Math.min(RETRY_MAX_DELAY_MS, asSeconds * 1000));
  }
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, Math.min(RETRY_MAX_DELAY_MS, asDate - Date.now()));
}

function retryDelayMs(attempt: number, response?: Response): number {
  const fromHeader = response ? retryAfterMs(response) : undefined;
  if (fromHeader != null) return fromHeader;
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(RETRY_MAX_DELAY_MS, exponential);
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function htmlToText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlMatch(html: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(html);
  const value = match?.[1] ? htmlToText(String(match[1])) : '';
  return value || undefined;
}

function isHtmlBody(text: string, contentType?: string | null): boolean {
  const content = (contentType || '').toLowerCase();
  if (content.includes('text/html')) return true;
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || (trimmed.includes('<head') && trimmed.includes('</html>'));
}

function summarizeHtmlError(text: string): string {
  const title = htmlMatch(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const heading = htmlMatch(text, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const server = htmlMatch(text, /<hr[^>]*>\s*<center[^>]*>([\s\S]*?)<\/center>/i);
  const summaryParts = [title, heading].filter((item, index, list) => item && list.indexOf(item) === index);
  const summary = summaryParts.join(' - ');
  const serverPart = server ? ` (server: ${server})` : '';
  if (summary) return `Upstream returned an HTML error page${serverPart}: ${summary}`;
  return `Upstream returned an HTML error page${serverPart}.`;
}

function responseErrorDetail(response: Response, text: string, json: any): string {
  if (typeof json?.error?.message === 'string' && json.error.message.trim()) return json.error.message.trim();
  if (typeof json?.message === 'string' && json.message.trim()) return json.message.trim();
  if (isHtmlBody(text, response.headers.get('content-type'))) return summarizeHtmlError(text);
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return response.statusText || 'No error details returned by upstream service.';
  return compact.slice(0, 1000);
}

function formatFetchFailure(config: AppConfig, endpoint: string, error: unknown): string {
  const detail = fetchFailureDetail(error);
  const style = providerApiStyle(config.provider);
  const hints = [
    'Network request to the model failed.',
    `Provider=${config.provider}.`,
    `Endpoint=${endpoint}.`,
    `Detail=${detail}.`
  ];
  if (style === 'ollama') {
    hints.push('Check that Ollama is running and reachable from this machine.');
  } else if (style === 'anthropic') {
    hints.push('Check Base URL, x-api-key, proxy/firewall settings, DNS, and TLS certificate trust on this machine.');
  } else {
    hints.push('Check Base URL, API key, proxy/firewall settings, DNS, and TLS certificate trust on this machine.');
  }
  if (config.browserMode === 'external') {
    hints.push('This happened before the external browser step; verify model/network connectivity first.');
  }
  return hints.join(' ');
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function anthropicTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text: text.trim() || ' ' };
}

function toAnthropicSystem(messages: AgentMessage[]): string | undefined {
  const parts = messages
    .filter((message) => message.role === 'system' && message.content.trim())
    .map((message) => message.content.trim());
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function toAnthropicMessages(messages: AgentMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const blocks: AnthropicContentBlock[] = [];
      while (index < messages.length && messages[index].role === 'tool') {
        const toolMessage = messages[index];
        blocks.push({
          type: 'tool_result',
          tool_use_id: toolMessage.tool_call_id || createId('tool_result'),
          content: toolMessage.content || ' '
        });
        index += 1;
      }
      index -= 1;
      if (blocks.length > 0) result.push({ role: 'user', content: blocks });
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content.trim()) blocks.push(anthropicTextBlock(message.content));
      for (const toolCall of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: String(toolCall.id || createId('tool_call')),
          name: String(toolCall.function?.name || ''),
          input: parseToolArguments(String(toolCall.function?.arguments || '{}'))
        });
      }
      if (blocks.length === 0) blocks.push(anthropicTextBlock(' '));
      result.push({ role: 'assistant', content: blocks });
      continue;
    }
    result.push({ role: 'user', content: [anthropicTextBlock(message.content)] });
  }
  return result;
}

function toAnthropicTools(tools: ToolDefinition[] | undefined): Array<{ name: string; description: string; input_schema: unknown }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

function parseOpenAiCompletion(json: any): LlmCompletion {
  const choice = json.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: String(tc.id ?? createId('toolcall')),
        type: 'function',
        function: {
          name: String(tc.function?.name ?? tc.name ?? ''),
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {})
        }
      }))
    : undefined;

  return {
    message: {
      id: createId('msg'),
      role: 'assistant',
      content: String(msg.content ?? ''),
      reasoning_content: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
      tool_calls: toolCalls
    },
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens
    },
    raw: json
  };
}

function normalizeOpenAiCompatibleMessages(messages: AgentMessage[], provider: AppConfig['provider']): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];
  const droppedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      const next: Record<string, unknown> = {
        role: message.role,
        content: String(message.content ?? '')
      };
      if (typeof message.name === 'string' && message.name.trim()) next.name = message.name.trim();
      normalized.push(next);
      continue;
    }

    if (message.role === 'assistant') {
      const next: Record<string, unknown> = {
        role: 'assistant',
        content: String(message.content ?? '')
      };
      if (typeof message.name === 'string' && message.name.trim()) next.name = message.name.trim();
      if (typeof message.reasoning_content === 'string') next.reasoning_content = message.reasoning_content;

      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls = rawToolCalls
        .map((call) => ({
          id: String(call.id ?? createId('toolcall')),
          type: 'function' as const,
          function: {
            name: String(call.function?.name ?? ''),
            arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})
          }
        }))
        .filter((call) => call.function.name);

      const hasReasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.trim().length > 0;
      const canKeepToolCalls = toolCalls.length > 0 && (provider !== 'deepseek' || hasReasoning);
      if (canKeepToolCalls) {
        next.tool_calls = toolCalls;
      } else if (toolCalls.length > 0) {
        for (const call of toolCalls) droppedToolCallIds.add(call.id);
      }

      normalized.push(next);
      continue;
    }

    const toolCallId = String(message.tool_call_id ?? '').trim();
    if (!toolCallId) continue;
    if (droppedToolCallIds.has(toolCallId)) continue;
    normalized.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: String(message.content ?? '')
    });
  }

  return normalized;
}

function parseAnthropicCompletion(json: any): LlmCompletion {
  const contentBlocks = Array.isArray(json.content) ? json.content : [];
  const textContent = contentBlocks
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => String(block.text))
    .join('\n\n')
    .trim();
  const toolCalls: ToolCall[] | undefined = contentBlocks
    .filter((block: any) => block?.type === 'tool_use' && typeof block.name === 'string')
    .map((block: any) => ({
      id: String(block.id ?? createId('toolcall')),
      type: 'function' as const,
      function: {
        name: String(block.name),
        arguments: JSON.stringify(block.input ?? {})
      }
    }));

  const usage = json.usage
    ? {
        promptTokens: json.usage.input_tokens,
        completionTokens: json.usage.output_tokens,
        totalTokens:
          typeof json.usage.input_tokens === 'number' && typeof json.usage.output_tokens === 'number'
            ? json.usage.input_tokens + json.usage.output_tokens
            : undefined
      }
    : undefined;

  return {
    message: {
      id: String(json.id ?? createId('msg')),
      role: 'assistant',
      content: textContent,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined
    },
    usage,
    raw: json
  };
}

class ModelClient implements LlmClient {
  constructor(private readonly config: AppConfig) {}

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const style = providerApiStyle(this.config.provider);
    if (style === 'mock') {
      return {
        message: {
          id: createId('msg'),
          role: 'assistant',
          content: 'Mock provider is active.'
        }
      };
    }
    if (style === 'ollama') return this.completeWithOllama(request);
    if (style === 'anthropic') return this.completeWithAnthropic(request);
    return this.completeWithOpenAiCompatible(request);
  }

  private async postJson(endpoint: string, headers: Record<string, string>, body: unknown, request: LlmRequest): Promise<any> {
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await runtimeFetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal
        });
      } catch (error) {
        if (!isAbortError(error) && attempt < MAX_LLM_REQUEST_RETRIES) {
          await sleepWithSignal(retryDelayMs(attempt), request.signal);
          attempt += 1;
          continue;
        }
        throw new Error(appendAttemptSuffix(formatFetchFailure(this.config, endpoint, error), attempt));
      }

      const text = await response.text();
      const json = parseJsonBody(text) as any;
      if (!response.ok) {
        const detail = responseErrorDetail(response, text, json);
        if (isRetriableStatus(response.status) && attempt < MAX_LLM_REQUEST_RETRIES) {
          await sleepWithSignal(retryDelayMs(attempt, response), request.signal);
          attempt += 1;
          continue;
        }
        throw new Error(appendAttemptSuffix(`LLM request failed (${response.status}): ${detail}`, attempt));
      }
      return json;
    }
  }

  private async completeWithOpenAiCompatible(request: LlmRequest): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const body = {
      model: this.config.model,
      messages: normalizeOpenAiCompatibleMessages(request.messages, this.config.provider),
      tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens,
      stream: false
    };
    const json = await this.postJson(endpoint, headers, body, request);
    return parseOpenAiCompletion(json);
  }

  private async completeWithAnthropic(request: LlmRequest): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/messages`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01'
    };
    const body = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? 2048,
      messages: toAnthropicMessages(request.messages),
      system: toAnthropicSystem(request.messages),
      tools: toAnthropicTools(request.tools),
      temperature: request.temperature ?? this.config.temperature
    };
    const json = await this.postJson(endpoint, headers, body, request);
    return parseAnthropicCompletion(json);
  }

  private async completeWithOllama(request: LlmRequest): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const body = {
      model: this.config.model,
      messages: request.messages.map((message) => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content })),
      stream: false,
      options: { temperature: request.temperature ?? this.config.temperature }
    };
    const json = await this.postJson(endpoint, headers, body, request);
    return {
      message: {
        id: createId('msg'),
        role: 'assistant',
        content: String(json.message?.content ?? '')
      },
      raw: json
    };
  }
}

export class MockLlmClient implements LlmClient {
  constructor(private readonly completions: LlmCompletion[]) {}

  async complete(): Promise<LlmCompletion> {
    const next = this.completions.shift();
    if (!next) return { message: { role: 'assistant', content: 'No mock response.' } };
    return next;
  }
}

export function createLlmClient(config: AppConfig): LlmClient {
  if (providerApiStyle(config.provider) === 'mock') {
    return new MockLlmClient([{ message: { role: 'assistant', content: 'Mock provider is active.' } }]);
  }
  return new ModelClient(config);
}

export async function testLlmConnection(config: AppConfig): Promise<{ ok: boolean; content: string }> {
  if (providerRequiresApiKey(config.provider) && !config.apiKey) return { ok: false, content: 'API key is empty.' };
  if (!config.baseUrl) return { ok: false, content: 'Base URL is empty.' };
  if (!config.model) return { ok: false, content: 'Model is empty.' };
  const client = createLlmClient(config);
  try {
    const result = await client.complete({ messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxTokens: 8 });
    return { ok: true, content: result.message.content || 'Connected.' };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}
