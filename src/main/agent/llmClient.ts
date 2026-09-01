import type { AgentMessage, AgentMessageAttachment, AppConfig, LlmCompletion, LlmRequest, ToolCall, ToolDefinition } from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import { providerApiStyle, providerRequiresApiKey } from '../../shared/providerCatalog.js';

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmCompletion>;
  streamComplete?(request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion>;
}

export interface LlmStreamDelta {
  content?: string;
  reasoning_content?: string;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

const MAX_LLM_REQUEST_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 2000;
const CONTEXT_COMPRESSION_THRESHOLD = 0.8;
const MODEL_CONTEXT_LOOKUP_TOKEN_FLOOR = 1024;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const INTERACTIVE_CONTEXT_SOFT_BUDGET_TOKENS = 96_000;
const MIN_CONTEXT_SUMMARY_TOKENS = 512;
const MAX_CONTEXT_SUMMARY_TOKENS = 24_000;
const RECENT_CONTEXT_BLOCKS = 6;
const CONTEXT_RETRY_COMPRESSION_RATIO = 0.65;
const MODEL_CONTEXT_PROBE_MAX_TOKENS = 99_999_999;
const MODEL_CONTEXT_PROBE_TIMEOUT_MS = 5000;
const MODEL_CONTEXT_WINDOW_CACHE = new Map<string, number | undefined>();
type ContextCompressionMode = 'turn_boundary' | 'iteration' | 'provider_retry';

const MODEL_CONTEXT_WINDOW_HINTS: Array<[RegExp, number]> = [
  [/^gpt-5\.6(?:-|$)|^gpt-5\.6$/i, 1_050_000],
  [/^gpt-5\.4(?:-|$)|^gpt-5\.4$/i, 1_010_000],
  [/^gpt-4\.1(?:-|$)|^gpt-4\.1$/i, 1_000_000],
  [/^gpt-4o(?:-|$)|^chatgpt-4o/i, 128_000],
  [/^o[134](?:-|$)|^o[134]-/i, 200_000],
  [/^claude-3|^claude-opus|^claude-sonnet|^claude-haiku/i, 200_000],
  [/^deepseek/i, 128_000],
  [/^kimi/i, 128_000],
  [/^qwen/i, 128_000],
  [/^llama|^mistral|^gemma/i, 128_000]
];

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const nonCjkLength = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(nonCjkLength / 3);
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTextTokens(value);
  if (value == null) return 0;
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

function estimateOpenAiPromptTokens(messages: Array<Record<string, unknown>>, tools?: ToolDefinition[]): number {
  const messageTokens = messages.reduce((sum, message) => sum + 6 + estimateValueTokens(message), 0);
  const toolTokens = tools && tools.length > 0 ? estimateValueTokens(tools) : 0;
  return messageTokens + toolTokens + 12;
}

function modelContextHint(model: string): number | undefined {
  const clean = model.trim();
  return MODEL_CONTEXT_WINDOW_HINTS.find(([pattern]) => pattern.test(clean))?.[1];
}

export function clearModelContextWindowCacheForTests(): void {
  MODEL_CONTEXT_WINDOW_CACHE.clear();
}

function requestContextCompressionMode(request: LlmRequest): ContextCompressionMode {
  return request.metadata?.context_compression ?? 'turn_boundary';
}

function effectiveContextBudget(
  contextWindowTokens: number,
  budgetRatio: number,
  mode: ContextCompressionMode = 'turn_boundary'
): { budgetTokens: number; windowBudgetTokens: number; softBudgetTokens: number; budgetSource: string } {
  const windowBudgetTokens = Math.max(256, Math.floor(contextWindowTokens * budgetRatio));
  const softBudgetTokens = Math.min(INTERACTIVE_CONTEXT_SOFT_BUDGET_TOKENS, windowBudgetTokens);
  const useSoftBudget = mode === 'turn_boundary';
  return {
    budgetTokens: useSoftBudget ? softBudgetTokens : windowBudgetTokens,
    windowBudgetTokens,
    softBudgetTokens,
    budgetSource: useSoftBudget && softBudgetTokens < windowBudgetTokens ? 'interactive_soft_budget' : 'context_window_ratio'
  };
}

function parseContextLimitFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    /maximum context length is\s+(\d+)\s+tokens/i,
    /context (?:window|length|limit).*?(\d+)\s+tokens/i,
    /max_model_len\s*=\s*(?:max_total_tokens\s*=\s*)?(\d+)/i,
    /max_total_tokens\s*=\s*(\d+)/i,
    /max(?:imum)?(?: context)?(?: length)?[:= ]+(\d+)/i,
    /max(?:imum)?(?: model)?(?: len| length).*?(\d+)/i,
    /(?:supports|allows|allowed|limit is|at most|up to)\s+(\d+)\s+tokens/i,
    /max_tokens.*?(?:<=|less than or equal to|at most|maximum(?: value)?(?: is)?|limit(?: is)?)[^\d]*(\d+)/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    const value = match?.[1] ? Number(match[1]) : NaN;
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return valuePreview(content, 400);
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, any>;
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text);
    } else if (typeof record.type === 'string') {
      parts.push(`[${record.type} attachment omitted from compressed history]`);
    }
  }
  return parts.join('\n');
}

function valuePreview(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      const json = JSON.stringify(value);
      text = typeof json === 'string' ? json : String(value ?? '');
    } catch {
      text = String(value);
    }
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 3))}...` : compact;
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function parseToolArgumentsRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function addBounded(set: Set<string>, value: unknown, maxChars = 240): void {
  const text = typeof value === 'string' ? value.trim() : valuePreview(value, maxChars).trim();
  if (text) set.add(text.length > maxChars ? `${text.slice(0, maxChars - 3).trimEnd()}...` : text);
}

function extractLinesMatching(text: unknown, pattern: RegExp, maxLines: number): string[] {
  const lines: string[] = [];
  for (const rawLine of textValue(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || !pattern.test(line)) continue;
    lines.push(line.length > 260 ? `${line.slice(0, 257).trimEnd()}...` : line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function buildCriticalContextCapsule(messages: Array<Record<string, unknown>>, query: string): string {
  const activeTasks: string[] = [];
  const skills = new Set<string>();
  const references = new Set<string>();
  const sourceFiles = new Set<string>();
  const outputFiles = new Set<string>();
  const constraints = new Set<string>();
  const blockers = new Set<string>();
  let sawSkill = false;
  let sawDelivery = false;

  const importantLinePattern = /must|required|mandatory|shall|should|verify|validate|blocked|blocker|failure|failed|error|source|evidence|skill|reference|必须|务必|一定|不要|禁止|除非|验证|检查|源文件|证据|引用|格式|目录|编号|废标|星号|评分|授权|缺少|失败|错误|阻塞/i;
  const blockerPattern = /blocked|blocker|failed|failure|error|missing|unresolved|cannot|invalid|缺少|未完成|未读取|失败|错误|阻塞|无法|不通过/i;

  for (const message of messages) {
    const role = String(message.role ?? '');
    const text = contentToText(message.content);
    if (role === 'user' && text.trim()) activeTasks.push(valuePreview(text, 420));
    if (role === 'user' || role === 'system') {
      for (const line of extractLinesMatching(text, importantLinePattern, 10)) constraints.add(line);
    }
    if (role === 'assistant' || role === 'tool') {
      for (const line of extractLinesMatching(text, blockerPattern, 8)) blockers.add(line);
    }
    if (role === 'tool' && String(message.name ?? '') === 'skill_view') {
      sawSkill = true;
      const skillName = /^# Skill(?: reference for)?:\s*(.+)$/im.exec(text)?.[1]?.trim();
      const refPath = /^# Reference path:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (skillName) addBounded(skills, skillName);
      if (refPath) addBounded(references, refPath);
      for (const line of extractLinesMatching(text, importantLinePattern, 14)) constraints.add(line);
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
    for (const call of toolCalls) {
      const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : {};
      const name = String(fn.name ?? '');
      const args = parseToolArgumentsRecord(fn.arguments);
      if (name === 'skill_view') {
        sawSkill = true;
        addBounded(skills, args.name);
        addBounded(references, args.ref_path);
      } else if (name === 'file_read') {
        addBounded(sourceFiles, args.path);
      } else if (name === 'file_write') {
        sawDelivery = true;
        addBounded(outputFiles, args.path);
      } else if (name === 'skill_manage') {
        sawDelivery = true;
        addBounded(outputFiles, `skill:${String(args.name ?? '(unknown)')} ${String(args.action ?? '')}`.trim());
      } else if (/terminal|exec|bash|shell/i.test(name)) {
        const command = String(args.command ?? args.cmd ?? '');
        if (/\b(Get-Content|cat|type|rg|Select-String)\b/i.test(command)) addBounded(sourceFiles, command);
        if (/\b(apply_patch|Set-Content|Out-File|Copy-Item|Move-Item|npm run build|npm test|pytest|cargo test|uv run)\b/i.test(command)) {
          sawDelivery = true;
          addBounded(outputFiles, command);
        }
      }
    }
  }

  if (query.trim()) constraints.add(`Current user request/query: ${valuePreview(query, 360)}`);
  if (!sawSkill && !sawDelivery && constraints.size === 0 && blockers.size === 0) return '';

  const latestTask = query.trim() ? valuePreview(query, 420) : (activeTasks.at(-1) ?? '');
  const lines = [
    'Critical Context Capsule:',
    `- Active task: ${latestTask || '(unknown)'}`,
    `- Active skill(s): ${skills.size > 0 ? [...skills].slice(-5).join('; ') : '(none recorded)'}`,
    `- Loaded skill reference(s): ${references.size > 0 ? [...references].slice(-8).join('; ') : '(none recorded)'}`,
    `- Source files read: ${sourceFiles.size > 0 ? [...sourceFiles].slice(-12).join('; ') : '(none recorded)'}`,
    `- Output files created/modified: ${outputFiles.size > 0 ? [...outputFiles].slice(-12).join('; ') : '(none recorded)'}`,
    `- Mandatory constraints: ${constraints.size > 0 ? [...constraints].slice(-18).join(' | ') : '(none recorded)'}`,
    `- Unresolved blockers or failed checks: ${blockers.size > 0 ? [...blockers].slice(-10).join(' | ') : '(none recorded)'}`,
    `- Required validation before final: ${sawSkill ? 'validate the deliverable against the loaded skill and references; fail if required sources or mandatory steps are missing.' : 'validate produced deliverables before presenting them as complete.'}`
  ];
  return lines.join('\n');
}

function tokenizeQuery(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]{2,}/g) ?? [];
  return [...new Set([...latin, ...cjk])].slice(0, 80);
}

function lineScore(line: string, queryTokens: string[]): number {
  const lower = line.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lower.includes(token.toLowerCase())) score += token.length >= 6 ? 4 : 2;
  }
  if (/error|failed|exception|trace|todo|决定|错误|失败|异常|结论|需求|问题/.test(lower)) score += 3;
  if (/^\s*(#{1,6}|[-*]|\d+[.)])\s+/.test(line)) score += 1;
  return score;
}

function compressTextExtractive(text: string, targetTokens: number, query = ''): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized || estimateTextTokens(normalized) <= targetTokens) return normalized;
  if (targetTokens <= 0) return '';

  const targetChars = Math.max(160, targetTokens * 4);
  const queryTokens = tokenizeQuery(query);
  const lines = normalized
    .split('\n')
    .map((line, index) => ({ index, line: line.trim() }))
    .filter((item) => item.line);

  if (lines.length <= 2) {
    const head = normalized.slice(0, Math.floor(targetChars * 0.62)).trim();
    const tail = normalized.slice(-Math.floor(targetChars * 0.28)).trim();
    return [head, '[...compressed...]', tail].filter(Boolean).join('\n');
  }

  const selected = new Map<number, string>();
  const edgeCount = Math.min(4, Math.ceil(lines.length * 0.08));
  for (const item of lines.slice(0, edgeCount)) selected.set(item.index, item.line);
  for (const item of lines.slice(-edgeCount)) selected.set(item.index, item.line);

  const ranked = lines
    .slice(edgeCount, Math.max(edgeCount, lines.length - edgeCount))
    .map((item) => ({ ...item, score: lineScore(item.line, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  let assembled = [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('\n');
  for (const item of ranked) {
    const next = [...selected.entries(), [item.index, item.line] as [number, string]]
      .sort((a, b) => a[0] - b[0])
      .map(([, line]) => line)
      .join('\n');
    if (next.length > targetChars) break;
    selected.set(item.index, item.line);
    assembled = next;
  }

  if (estimateTextTokens(assembled) > targetTokens) {
    assembled = assembled.slice(0, targetChars).trim();
  }
  return `${assembled}\n[compressed from ${estimateTextTokens(normalized)} estimated tokens to fit context budget]`;
}

function compactMessageContent(message: Record<string, unknown>, targetTokens: number, query: string): Record<string, unknown> {
  const text = contentToText(message.content);
  const compressed = compressTextExtractive(text, targetTokens, query);
  return {
    ...message,
    content: compressed || '[content omitted by context compression]'
  };
}

function stripHistoricalAttachments(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const lastUserIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return index;
    }
    return messages.length - 1;
  })();
  return messages.map((message, index) => {
    if (index === lastUserIndex || !Array.isArray(message.content)) return message;
    return { ...message, content: contentToText(message.content) };
  });
}

interface MessageBlock {
  start: number;
  end: number;
  messages: Array<Record<string, unknown>>;
}

function buildMessageBlocks(messages: Array<Record<string, unknown>>): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, any>> : [];
    if (message.role === 'assistant' && toolCalls.length > 0) {
      const ids = new Set(toolCalls.map((call) => String(call?.id ?? '')).filter(Boolean));
      let end = index + 1;
      while (end < messages.length && messages[end].role === 'tool' && ids.has(String(messages[end].tool_call_id ?? ''))) {
        end += 1;
      }
      blocks.push({ start: index, end, messages: messages.slice(index, end) });
      index = end;
      continue;
    }
    blocks.push({ start: index, end: index + 1, messages: [message] });
    index += 1;
  }
  return blocks;
}

function summarizeBlocks(blocks: MessageBlock[], targetTokens: number, query: string): string {
  const capsule = buildCriticalContextCapsule(blocks.flatMap((block) => block.messages), query);
  const raw = blocks
    .flatMap((block) => block.messages)
    .map((message) => {
      const role = String(message.role ?? 'message');
      const name = typeof message.name === 'string' && message.name ? ` ${message.name}` : '';
      const text = contentToText(message.content);
      const toolCalls = Array.isArray(message.tool_calls)
        ? `\nTool calls: ${valuePreview(message.tool_calls, 800)}`
        : '';
      return `<${role}${name}>\n${text}${toolCalls}\n</${role}>`;
    })
    .join('\n\n');
  return [
    'Earlier conversation history was compressed to keep the request inside the model context window.',
    'Preserve these decisions, constraints, user preferences, files touched, tool observations, and unresolved tasks:',
    capsule,
    compressTextExtractive(raw, targetTokens, query)
  ].filter(Boolean).join('\n');
}

function compressOpenAiMessagesToBudget(
  messages: Array<Record<string, unknown>>,
  tools: ToolDefinition[] | undefined,
  contextWindowTokens: number,
  query: string,
  recentBlocks = RECENT_CONTEXT_BLOCKS,
  budgetRatio = CONTEXT_COMPRESSION_THRESHOLD,
  mode: ContextCompressionMode = 'turn_boundary'
): { messages: Array<Record<string, unknown>>; compressed: boolean; beforeTokens: number; afterTokens: number; budgetTokens: number; windowBudgetTokens: number; softBudgetTokens: number; budgetSource: string } {
  const { budgetTokens, windowBudgetTokens, softBudgetTokens, budgetSource } = effectiveContextBudget(contextWindowTokens, budgetRatio, mode);
  const beforeTokens = estimateOpenAiPromptTokens(messages, tools);
  if (beforeTokens <= budgetTokens) {
    return { messages, compressed: false, beforeTokens, afterTokens: beforeTokens, budgetTokens, windowBudgetTokens, softBudgetTokens, budgetSource };
  }

  const sanitized = stripHistoricalAttachments(messages);
  if (estimateOpenAiPromptTokens(sanitized, tools) <= budgetTokens) {
    const afterTokens = estimateOpenAiPromptTokens(sanitized, tools);
    return { messages: sanitized, compressed: true, beforeTokens, afterTokens, budgetTokens, windowBudgetTokens, softBudgetTokens, budgetSource };
  }

  const systemMessages = sanitized.filter((message) => message.role === 'system');
  const nonSystem = sanitized.filter((message) => message.role !== 'system');
  const blocks = buildMessageBlocks(nonSystem);
  const suffixCount = Math.max(1, Math.min(recentBlocks, blocks.length));
  const keepStart = Math.max(0, blocks.length - suffixCount);
  const olderBlocks = blocks.slice(0, keepStart);
  const recentMessages = blocks.slice(keepStart).flatMap((block) => block.messages);
  const summaryTokenFloor = Math.min(MIN_CONTEXT_SUMMARY_TOKENS, Math.max(64, Math.floor(budgetTokens * 0.25)));
  const summaryTokens = Math.max(
    summaryTokenFloor,
    Math.min(MAX_CONTEXT_SUMMARY_TOKENS, Math.floor(budgetTokens * 0.12))
  );
  const summary = olderBlocks.length > 0 ? summarizeBlocks(olderBlocks, summaryTokens, query) : '';
  let nextMessages =
    summary && systemMessages.length > 0
      ? [
          { ...systemMessages[0], content: [contentToText(systemMessages[0].content), summary].filter(Boolean).join('\n\n') },
          ...systemMessages.slice(1),
          ...recentMessages
        ]
      : [...systemMessages, ...recentMessages];
  let afterTokens = estimateOpenAiPromptTokens(nextMessages, tools);
  if (afterTokens <= budgetTokens || suffixCount <= 1) {
    if (afterTokens > budgetTokens) {
      nextMessages = shrinkLargestMessages(nextMessages, tools, budgetTokens, query);
      afterTokens = estimateOpenAiPromptTokens(nextMessages, tools);
    }
    return { messages: nextMessages, compressed: true, beforeTokens, afterTokens, budgetTokens, windowBudgetTokens, softBudgetTokens, budgetSource };
  }
  return compressOpenAiMessagesToBudget(sanitized, tools, contextWindowTokens, query, Math.max(1, Math.floor(suffixCount / 2)), budgetRatio, mode);
}

function logContextCompression(event: {
  provider: string;
  model: string;
  beforeTokens: number;
  afterTokens: number;
  budgetTokens: number;
  windowBudgetTokens?: number;
  softBudgetTokens?: number;
  budgetSource?: string;
  mode?: ContextCompressionMode;
  contextWindowTokens: number;
  budgetRatio: number;
  triggerReason: string;
}): void {
  const windowBudget = event.windowBudgetTokens ?? Math.max(256, Math.floor(event.contextWindowTokens * event.budgetRatio));
  const budgetSource = event.budgetSource ?? (event.budgetTokens < windowBudget ? 'interactive_soft_budget' : 'context_window_ratio');
  const triggerCondition = budgetSource === 'interactive_soft_budget'
    ? `${event.beforeTokens} > ${event.budgetTokens} (interactive soft budget; ${Math.round(event.budgetRatio * 100)}% of ${event.contextWindowTokens} = ${windowBudget})`
    : `${event.beforeTokens} > ${event.budgetTokens} (${Math.round(event.budgetRatio * 100)}% of ${event.contextWindowTokens})`;
  console.info(`[llm][context-compression] ${JSON.stringify({
    at: new Date().toISOString(),
    provider: event.provider,
    model: event.model,
    before_tokens: event.beforeTokens,
    after_tokens: event.afterTokens,
    budget_tokens: event.budgetTokens,
    window_budget_tokens: windowBudget,
    soft_budget_tokens: event.softBudgetTokens,
    budget_source: budgetSource,
    context_compression: event.mode,
    context_window_tokens: event.contextWindowTokens,
    budget_ratio: event.budgetRatio,
    trigger_reason: event.triggerReason,
    trigger_condition: triggerCondition
  })}`);
}

function shrinkLargestMessages(
  messages: Array<Record<string, unknown>>,
  tools: ToolDefinition[] | undefined,
  budgetTokens: number,
  query: string
): Array<Record<string, unknown>> {
  let next = [...messages];
  let guard = 0;
  while (estimateOpenAiPromptTokens(next, tools) > budgetTokens && guard < 12) {
    guard += 1;
    const candidates = next
      .map((message, index) => ({ index, tokens: estimateValueTokens(message.content), role: String(message.role ?? '') }))
      .filter((item) => item.tokens > 256)
      .sort((a, b) => b.tokens - a.tokens);
    const largest = candidates[0];
    if (!largest) break;
    const overflow = estimateOpenAiPromptTokens(next, tools) - budgetTokens;
    const target = Math.max(128, largest.tokens - overflow - 256, Math.floor(largest.tokens * 0.55));
    next = next.map((message, index) => (index === largest.index ? compactMessageContent(message, target, query) : message));
  }
  return next;
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

function parseSseJsonData(dataParts: string[]): unknown {
  const specData = dataParts.join('\n').trim();
  try {
    return JSON.parse(specData);
  } catch (specError) {
    const compactData = dataParts.join('').trim();
    if (compactData !== specData) {
      try {
        return JSON.parse(compactData);
      } catch {
        // Report the original SSE-shaped payload below.
      }
    }
    throw specError;
  }
}

function looksLikeIncompleteJson(text: string): boolean {
  return analyzeIncompleteJson(text).incomplete;
}

function analyzeIncompleteJson(text: string): { incomplete: boolean; missingClosers: string } {
  const trimmed = text.trim();
  if (!trimmed) return { incomplete: false, missingClosers: '' };
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return { incomplete: false, missingClosers: '' };
    }
  }
  return {
    incomplete: inString || stack.length > 0 || /[:,]\s*$/.test(trimmed),
    missingClosers: !inString && !/[:,]\s*$/.test(trimmed) ? [...stack].reverse().join('') : ''
  };
}

function parseRepairableFinalSseJson(dataParts: string[]): unknown | undefined {
  const candidates = [dataParts.join('\n').trim(), dataParts.join('').trim()]
    .filter((item, index, items) => item && items.indexOf(item) === index);
  for (const candidate of candidates) {
    const analysis = analyzeIncompleteJson(candidate);
    if (!analysis.incomplete || !analysis.missingClosers) continue;
    try {
      return JSON.parse(`${candidate}${analysis.missingClosers}`);
    } catch {
      // Try the next candidate shape.
    }
  }
  return undefined;
}

type SseEventBlockStatus = 'processed' | 'done' | 'open';

function processSseEventBlock(block: string, onJsonEvent: (json: any) => void, options: { final?: boolean } = {}): SseEventBlockStatus {
  const dataParts: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      dataParts.push(value.startsWith(' ') ? value.slice(1) : value);
      continue;
    }
    if (/^(?:event|id|retry):/.test(line)) continue;
    if (dataParts.length > 0 && line.trim()) dataParts[dataParts.length - 1] += line.trimEnd();
  }
  if (dataParts.length === 0) return 'processed';
  const data = dataParts.join('\n').trim();
  if (!data) return 'processed';
  if (data === '[DONE]') return 'done';
  try {
    onJsonEvent(parseSseJsonData(dataParts));
  } catch {
    if (!options.final && looksLikeIncompleteJson(data)) return 'open';
    if (options.final && looksLikeIncompleteJson(data)) {
      const repaired = parseRepairableFinalSseJson(dataParts);
      if (repaired !== undefined) onJsonEvent(repaired);
      return 'processed';
    }
    throw new Error(`Invalid LLM stream event: ${data.slice(0, 200)}`);
  }
  return 'processed';
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

function normalizeToolArgumentsForRequest(value: unknown): string {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return '{}';
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return JSON.stringify({ raw: value });
    }
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function reasoningTextFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      for (const key of ['text', 'content', 'reasoning', 'summary']) {
        if (typeof record[key] === 'string') return record[key] as string;
      }
      return '';
    })
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function splitThinkBlocks(content: string, explicitReasoning?: string): { content: string; reasoning_content?: string } {
  const thinkParts: string[] = [];
  const stripped = content
    .replace(/<think>\s*([\s\S]*?)\s*<\/think>/gi, (_match, inner: string) => {
      const clean = String(inner ?? '').trim();
      if (clean) thinkParts.push(clean);
      return '';
    })
    .trim();
  const reasoningParts = [explicitReasoning?.trim(), ...thinkParts].filter((part): part is string => Boolean(part));
  return {
    content: stripped,
    reasoning_content: reasoningParts.length > 0 ? reasoningParts.join('\n') : undefined
  };
}

function anthropicTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text: text.trim() || ' ' };
}

function attachmentDataUrl(attachment: AgentMessageAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
}

function audioFormat(attachment: AgentMessageAttachment): string {
  const fromMime = attachment.mimeType.split('/')[1]?.toLowerCase().replace(/^x-/, '') ?? '';
  const fromName = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
  const value = fromMime || fromName || 'mp3';
  if (value === 'mpeg') return 'mp3';
  if (value === 'x-wav') return 'wav';
  return value;
}

function openAiContentParts(message: AgentMessage, provider: AppConfig['provider']): string | Array<Record<string, unknown>> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return String(message.content ?? '');
  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) parts.push({ type: 'text', text: message.content });
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: attachmentDataUrl(attachment) } });
      continue;
    }
    if (attachment.kind === 'audio') {
      parts.push({
        type: 'input_audio',
        input_audio: {
          data: provider === 'openai' ? attachment.contentBase64 : attachmentDataUrl(attachment),
          format: audioFormat(attachment)
        }
      });
      continue;
    }
    if (attachment.kind === 'video') {
      parts.push({ type: 'video_url', video_url: { url: attachmentDataUrl(attachment) } });
    }
  }
  return parts.length > 0 ? parts : String(message.content ?? '');
}

function anthropicImageBlocks(attachments: AgentMessageAttachment[]): AnthropicContentBlock[] {
  return attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.mimeType.startsWith('image/'))
    .map((attachment) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: attachment.mimeType,
        data: attachment.contentBase64
      }
    }));
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
    result.push({ role: 'user', content: [anthropicTextBlock(message.content), ...anthropicImageBlocks(message.attachments ?? [])] });
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
  const parsedContent = splitThinkBlocks(
    String(msg.content ?? ''),
    reasoningTextFromValue(msg.reasoning) ?? reasoningTextFromValue(msg.reasoning_content) ?? reasoningTextFromValue(msg.reasoning_details)
  );
  const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((tc: any) => ({
        id: String(tc.id ?? createId('toolcall')),
        type: 'function',
        function: {
          name: String(tc.function?.name ?? tc.name ?? ''),
          arguments: normalizeToolArgumentsForRequest(tc.function?.arguments)
        }
      }))
    : undefined;

  return {
    message: {
      id: createId('msg'),
      role: 'assistant',
      content: parsedContent.content,
      reasoning_content: parsedContent.reasoning_content,
      tool_calls: toolCalls
    },
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens
    },
    log_probs: choice?.logprobs,
    raw: json
  };
}

interface OpenAiStreamingToolCall {
  id?: string;
  type?: 'function';
  function: {
    name?: string;
    arguments: string;
  };
}

function applyOpenAiToolCallDeltas(acc: OpenAiStreamingToolCall[], rawToolCalls: unknown): void {
  if (!Array.isArray(rawToolCalls)) return;
  for (const raw of rawToolCalls) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, any>;
    const index = typeof item.index === 'number' && Number.isInteger(item.index) && item.index >= 0 ? item.index : acc.length;
    const current = acc[index] ?? { function: { arguments: '' } };
    if (typeof item.id === 'string' && item.id) current.id = item.id;
    if (item.type === 'function') current.type = 'function';
    const fn = item.function && typeof item.function === 'object' ? item.function as Record<string, unknown> : null;
    if (typeof fn?.name === 'string' && fn.name) current.function.name = `${current.function.name ?? ''}${fn.name}`;
    if (typeof fn?.arguments === 'string') current.function.arguments += fn.arguments;
    acc[index] = current;
  }
}

function finalizeStreamingToolCalls(acc: OpenAiStreamingToolCall[]): ToolCall[] | undefined {
  const calls = acc
    .map((call) => ({
      id: String(call.id ?? createId('toolcall')),
      type: 'function' as const,
      function: {
        name: String(call.function.name ?? ''),
        arguments: normalizeToolArgumentsForRequest(call.function.arguments)
      }
    }))
    .filter((call) => call.function.name);
  return calls.length > 0 ? calls : undefined;
}

function normalizeOpenAiCompatibleMessages(messages: AgentMessage[], provider: AppConfig['provider']): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];
  const droppedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      const next: Record<string, unknown> = {
        role: message.role,
        content: message.role === 'user' ? openAiContentParts(message, provider) : String(message.content ?? '')
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
      if (typeof message.reasoning_content === 'string') {
        if (provider === 'vllm') next.reasoning = message.reasoning_content;
        else next.reasoning_content = message.reasoning_content;
      }

      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls = rawToolCalls
        .map((call) => ({
          id: String(call.id ?? createId('toolcall')),
          type: 'function' as const,
          function: {
            name: String(call.function?.name ?? ''),
            arguments: normalizeToolArgumentsForRequest(call.function?.arguments)
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

function vllmReasoningRequestParams(config: AppConfig): Record<string, unknown> {
  if (config.provider !== 'vllm') return {};
  if (config.reasoningEffort === 'auto') return { include_reasoning: true };
  return {
    reasoning_effort: config.reasoningEffort,
    include_reasoning: config.reasoningEffort !== 'none'
  };
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

  private async getJson(endpoint: string, headers: Record<string, string>, request: LlmRequest): Promise<any | undefined> {
    try {
      const response = await runtimeFetch(endpoint, {
        method: 'GET',
        headers,
        signal: request.signal
      });
      if (!response.ok) return undefined;
      return parseJsonBody(await response.text());
    } catch {
      return undefined;
    }
  }

  private async postContextProbe(endpoint: string, headers: Record<string, string>, request: LlmRequest): Promise<string | undefined> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODEL_CONTEXT_PROBE_TIMEOUT_MS);
    const abortProbe = (): void => controller.abort();
    request.signal?.addEventListener('abort', abortProbe, { once: true });
    try {
      const response = await runtimeFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: MODEL_CONTEXT_PROBE_MAX_TOKENS,
          stream: false
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (response.ok) return undefined;
      const json = parseJsonBody(text) as any;
      return responseErrorDetail(response, text, json);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeoutId);
      request.signal?.removeEventListener('abort', abortProbe);
    }
  }

  private async postEventStream(
    endpoint: string,
    headers: Record<string, string>,
    body: unknown,
    request: LlmRequest,
    onJsonEvent: (json: any) => void
  ): Promise<void> {
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

      if (!response.ok) {
        const text = await response.text();
        const json = parseJsonBody(text) as any;
        const detail = responseErrorDetail(response, text, json);
        if (isRetriableStatus(response.status) && attempt < MAX_LLM_REQUEST_RETRIES) {
          await sleepWithSignal(retryDelayMs(attempt, response), request.signal);
          attempt += 1;
          continue;
        }
        throw new Error(appendAttemptSuffix(`LLM request failed (${response.status}): ${detail}`, attempt));
      }

      if (!response.body) throw new Error('LLM stream response did not include a readable body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamFinished = false;
      try {
        let buffer = '';
        let doneEventSeen = false;

        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary < 0) break;
            const eventBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const status = processSseEventBlock(eventBlock, onJsonEvent);
            if (status === 'open') {
              buffer = `${eventBlock}\n${buffer}`;
              continue;
            }
            doneEventSeen = status === 'done';
            if (doneEventSeen) break;
          }
          if (doneEventSeen) break;
        }

        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (!doneEventSeen) {
          const trimmed = buffer.trim();
          if (trimmed) {
            doneEventSeen = processSseEventBlock(trimmed, onJsonEvent, { final: true }) === 'done';
          }
        }
        streamFinished = true;
        return;
      } finally {
        if (!streamFinished) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancellation cleanup failures; the original parse/network error is more useful.
          }
        }
      }
    }
  }

  private async postJsonLineStream(
    endpoint: string,
    headers: Record<string, string>,
    body: unknown,
    request: LlmRequest,
    onJsonEvent: (json: any) => void
  ): Promise<void> {
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

      if (!response.ok) {
        const text = await response.text();
        const json = parseJsonBody(text) as any;
        const detail = responseErrorDetail(response, text, json);
        if (isRetriableStatus(response.status) && attempt < MAX_LLM_REQUEST_RETRIES) {
          await sleepWithSignal(retryDelayMs(attempt, response), request.signal);
          attempt += 1;
          continue;
        }
        throw new Error(appendAttemptSuffix(`LLM request failed (${response.status}): ${detail}`, attempt));
      }

      if (!response.body) throw new Error('LLM stream response did not include a readable body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            onJsonEvent(JSON.parse(trimmed));
          } catch {
            throw new Error(`Invalid LLM JSON stream event: ${trimmed.slice(0, 200)}`);
          }
        }
      }

      buffer += decoder.decode();
      const trimmed = buffer.trim();
      if (trimmed) {
        try {
          onJsonEvent(JSON.parse(trimmed));
        } catch {
          throw new Error(`Invalid LLM JSON stream event: ${trimmed.slice(0, 200)}`);
        }
      }
      return;
    }
  }

  async streamComplete(request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion> {
    const style = providerApiStyle(this.config.provider);
    if (style === 'ollama') return this.completeWithOllamaStream(request, onDelta);
    if (style === 'anthropic') return this.completeWithAnthropicStream(request, onDelta);
    if (style !== 'openai') return this.complete(request);
    return this.completeWithOpenAiCompatibleStream(request, onDelta);
  }

  private async prepareOpenAiCompatibleMessages(
    request: LlmRequest,
    headers: Record<string, string>
  ): Promise<{ messages: Array<Record<string, unknown>>; compressed: boolean; beforeTokens: number; afterTokens: number; budgetTokens?: number }> {
    const messages = normalizeOpenAiCompatibleMessages(request.messages, this.config.provider);
    const estimatedTokens = estimateOpenAiPromptTokens(messages, request.tools);
    const compressionMode = requestContextCompressionMode(request);
    const explicitHint = modelContextHint(this.config.model);
    const localHint = explicitHint ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const cacheKey = `${normalizeBase(this.config.baseUrl)}\n${this.config.model}`;
    let contextWindowTokens = MODEL_CONTEXT_WINDOW_CACHE.has(cacheKey)
      ? MODEL_CONTEXT_WINDOW_CACHE.get(cacheKey) ?? localHint
      : localHint;
    if (!MODEL_CONTEXT_WINDOW_CACHE.has(cacheKey)) {
      const localBudget = effectiveContextBudget(localHint, CONTEXT_COMPRESSION_THRESHOLD, compressionMode).budgetTokens;
      const shouldResolveContext =
        estimatedTokens > localBudget ||
        (explicitHint === undefined && estimatedTokens > MODEL_CONTEXT_LOOKUP_TOKEN_FLOOR);
      contextWindowTokens = shouldResolveContext
        ? (await this.resolveModelContextWindow(headers, request)) ?? localHint
        : localHint;
    }
    return this.compressOpenAiRequest(request, contextWindowTokens, messages, CONTEXT_COMPRESSION_THRESHOLD, 'estimated_prompt_tokens_exceed_context_budget', compressionMode);
  }

  private async resolveModelContextWindow(headers: Record<string, string>, request: LlmRequest): Promise<number | undefined> {
    const cacheKey = `${normalizeBase(this.config.baseUrl)}\n${this.config.model}`;
    if (MODEL_CONTEXT_WINDOW_CACHE.has(cacheKey)) return MODEL_CONTEXT_WINDOW_CACHE.get(cacheKey);
    const chatEndpoint = `${normalizeBase(this.config.baseUrl)}/chat/completions`;
    const probeDetail = await this.postContextProbe(chatEndpoint, headers, request);
    const probeTokens = probeDetail ? parseContextLimitFromError(probeDetail) : undefined;
    const tokens = probeTokens ?? modelContextHint(this.config.model);
    MODEL_CONTEXT_WINDOW_CACHE.set(cacheKey, tokens);
    return tokens;
  }

  private compressOpenAiRequest(
    request: LlmRequest,
    contextWindowTokens: number,
    normalizedMessages?: Array<Record<string, unknown>>,
    budgetRatio = CONTEXT_COMPRESSION_THRESHOLD,
    triggerReason = 'estimated_prompt_tokens_exceed_context_budget',
    mode: ContextCompressionMode = requestContextCompressionMode(request)
  ): { messages: Array<Record<string, unknown>>; compressed: boolean; beforeTokens: number; afterTokens: number; budgetTokens: number } {
    const messages = normalizedMessages ?? normalizeOpenAiCompatibleMessages(request.messages, this.config.provider);
    const query = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const result = compressOpenAiMessagesToBudget(messages, request.tools, contextWindowTokens, query, RECENT_CONTEXT_BLOCKS, budgetRatio, mode);
    if (result.compressed) {
      logContextCompression({
        provider: this.config.provider,
        model: this.config.model,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        budgetTokens: result.budgetTokens,
        windowBudgetTokens: result.windowBudgetTokens,
        softBudgetTokens: result.softBudgetTokens,
        budgetSource: result.budgetSource,
        mode,
        contextWindowTokens,
        budgetRatio,
        triggerReason
      });
    }
    return result;
  }

  private async postJsonWithContextRetry(
    endpoint: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    request: LlmRequest,
    _prepared: { compressed: boolean }
  ): Promise<any> {
    try {
      return await this.postJson(endpoint, headers, body, request);
    } catch (error) {
      const contextWindowTokens = parseContextLimitFromError(error);
      if (!contextWindowTokens) throw error;
      const retry = this.compressOpenAiRequest(request, contextWindowTokens, undefined, CONTEXT_RETRY_COMPRESSION_RATIO, 'provider_context_limit_error', 'provider_retry');
      return this.postJson(endpoint, headers, { ...body, messages: retry.messages }, request);
    }
  }

  private async completeWithOpenAiCompatible(request: LlmRequest): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const prepared = await this.prepareOpenAiCompatibleMessages(request, headers);
    const body = {
      model: this.config.model,
      messages: prepared.messages,
      tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens,
      logprobs: request.logProbs === true ? true : undefined,
      top_logprobs: request.logProbs === true ? request.topLogProbs : undefined,
      metadata: request.metadata,
      stream: false,
      ...vllmReasoningRequestParams(this.config)
    };
    const json = await this.postJsonWithContextRetry(endpoint, headers, body, request, prepared);
    return parseOpenAiCompletion(json);
  }

  private async completeWithOpenAiCompatibleStream(request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    const prepared = await this.prepareOpenAiCompatibleMessages(request, headers);
    let body = {
      model: this.config.model,
      messages: prepared.messages,
      tools: request.tools && request.tools.length > 0 ? request.tools : undefined,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens,
      metadata: request.metadata,
      stream: true,
      ...vllmReasoningRequestParams(this.config)
    };

    let content = '';
    let reasoningContent = '';
    let usage: LlmCompletion['usage'];
    let rawId = '';
    const toolCallAcc: OpenAiStreamingToolCall[] = [];
    let rawEventCount = 0;

    const handleEvent = (json: any): void => {
      rawEventCount += 1;
      if (typeof json.id === 'string' && json.id) rawId = json.id;
      if (json.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens
        };
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta ?? {};
      const reasoningDelta = typeof delta.reasoning === 'string'
        ? delta.reasoning
        : typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : '';
      const contentDelta = typeof delta.content === 'string' ? delta.content : '';
      if (reasoningDelta) {
        reasoningContent += reasoningDelta;
        onDelta({ reasoning_content: reasoningDelta });
      }
      if (contentDelta) {
        content += contentDelta;
        onDelta({ content: contentDelta });
      }
      applyOpenAiToolCallDeltas(toolCallAcc, delta.tool_calls);
    };

    try {
      await this.postEventStream(endpoint, headers, body, request, handleEvent);
    } catch (error) {
      const contextWindowTokens = parseContextLimitFromError(error);
      if (!contextWindowTokens) throw error;
      const retry = this.compressOpenAiRequest(request, contextWindowTokens, undefined, CONTEXT_RETRY_COMPRESSION_RATIO, 'provider_context_limit_error', 'provider_retry');
      body = { ...body, messages: retry.messages };
      content = '';
      reasoningContent = '';
      usage = undefined;
      rawId = '';
      toolCallAcc.length = 0;
      rawEventCount = 0;
      await this.postEventStream(endpoint, headers, body, request, handleEvent);
    }

    const parsedContent = splitThinkBlocks(content, reasoningContent || undefined);
    return {
      message: {
        id: rawId || createId('msg'),
        role: 'assistant',
        content: parsedContent.content,
        reasoning_content: parsedContent.reasoning_content,
        tool_calls: finalizeStreamingToolCalls(toolCallAcc)
      },
      usage,
      raw: { stream: true, eventCount: rawEventCount }
    };
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
      temperature: request.temperature ?? this.config.temperature,
      metadata: request.metadata
    };
    const json = await this.postJson(endpoint, headers, body, request);
    return parseAnthropicCompletion(json);
  }

  private async completeWithAnthropicStream(request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion> {
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
      temperature: request.temperature ?? this.config.temperature,
      metadata: request.metadata,
      stream: true
    };

    let rawId = '';
    let content = '';
    let usage: LlmCompletion['usage'];
    const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    let rawEventCount = 0;

    await this.postEventStream(endpoint, headers, body, request, (json) => {
      rawEventCount += 1;
      if (json.type === 'message_start' && json.message) {
        if (typeof json.message.id === 'string') rawId = json.message.id;
        if (json.message.usage) {
          usage = {
            promptTokens: json.message.usage.input_tokens,
            completionTokens: json.message.usage.output_tokens,
            totalTokens:
              typeof json.message.usage.input_tokens === 'number' && typeof json.message.usage.output_tokens === 'number'
                ? json.message.usage.input_tokens + json.message.usage.output_tokens
                : undefined
          };
        }
      }
      if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
        toolBlocks.set(Number(json.index ?? toolBlocks.size), {
          id: String(json.content_block.id ?? createId('toolcall')),
          name: String(json.content_block.name ?? ''),
          inputJson: json.content_block.input ? JSON.stringify(json.content_block.input) : ''
        });
      }
      if (json.type === 'content_block_delta') {
        if (json.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
          content += json.delta.text;
          onDelta({ content: json.delta.text });
        }
        if (json.delta?.type === 'input_json_delta') {
          const tool = toolBlocks.get(Number(json.index));
          if (tool && typeof json.delta.partial_json === 'string') tool.inputJson += json.delta.partial_json;
        }
      }
      if (json.type === 'message_delta' && json.usage) {
        usage = {
          promptTokens: usage?.promptTokens,
          completionTokens: json.usage.output_tokens ?? usage?.completionTokens,
          totalTokens:
            typeof usage?.promptTokens === 'number' && typeof json.usage.output_tokens === 'number'
              ? usage.promptTokens + json.usage.output_tokens
              : usage?.totalTokens
        };
      }
    });

    const toolCalls = [...toolBlocks.values()]
      .filter((tool) => tool.name)
      .map((tool) => ({
        id: tool.id,
        type: 'function' as const,
        function: {
          name: tool.name,
          arguments: tool.inputJson || '{}'
        }
      }));

    return {
      message: {
        id: rawId || createId('msg'),
        role: 'assistant',
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      },
      usage,
      raw: { stream: true, eventCount: rawEventCount }
    };
  }

  private async completeWithOllama(request: LlmRequest): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const body = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
        images: message.attachments?.filter((attachment) => attachment.kind === 'image').map((attachment) => attachment.contentBase64)
      })),
      stream: false,
      options: { temperature: request.temperature ?? this.config.temperature },
      metadata: request.metadata
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

  private async completeWithOllamaStream(request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion> {
    const endpoint = `${normalizeBase(this.config.baseUrl)}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const body = {
      model: this.config.model,
      messages: request.messages.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
        images: message.attachments?.filter((attachment) => attachment.kind === 'image').map((attachment) => attachment.contentBase64)
      })),
      stream: true,
      options: { temperature: request.temperature ?? this.config.temperature },
      metadata: request.metadata
    };

    let content = '';
    let rawEventCount = 0;
    await this.postJsonLineStream(endpoint, headers, body, request, (json) => {
      rawEventCount += 1;
      const delta = typeof json.message?.content === 'string' ? json.message.content : '';
      if (delta) {
        content += delta;
        onDelta({ content: delta });
      }
    });

    return {
      message: {
        id: createId('msg'),
        role: 'assistant',
        content
      },
      raw: { stream: true, eventCount: rawEventCount }
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

  async streamComplete(_request: LlmRequest, onDelta: (delta: LlmStreamDelta) => void): Promise<LlmCompletion> {
    const next = await this.complete();
    if (next.message.reasoning_content) onDelta({ reasoning_content: next.message.reasoning_content });
    if (next.message.content) onDelta({ content: next.message.content });
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
