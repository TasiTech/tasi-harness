import type { AgentMessage, AgentMessageDeltaStream, AgentRunOptions, AgentRunResult, AppConfig, LlmCompletion, LlmRequestMetadata, SessionRecord, ToolApprovalRequester, ToolEvent } from '../../shared/types.js';
import type { LlmClient } from './llmClient.js';
import { createId, nowIso } from '../../shared/types.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { SessionStore } from '../storage/sessionStore.js';
import { PromptBuilder } from './promptBuilder.js';

const REPEATED_TOOL_RESULT_LIMIT = 3;
const REPEATED_REASONING_PATTERN_LIMIT = 5;
const REPEATED_REASONING_MAX_BLOCK_LINES = 24;
const REASONING_WITHOUT_CONTENT_CHAR_LIMIT = 12000;
const REASONING_TOTAL_CHAR_LIMIT = 32000;
const REASONING_ONLY_CONTINUE_LIMIT = 3;
const RECOVERABLE_LLM_INTERRUPTION_PATTERN = /Invalid LLM (?:JSON )?stream event|LLM stream response did not include a readable body|fetch failed|terminated|socket hang up|ECONNRESET|EPIPE|UND_ERR|network/i;
const ITERATION_LIMIT_MESSAGE_PATTERN = /^本轮已达到最大(?:模型迭代轮次|执行步数)（\d+），我先停在这里，避免继续消耗无效(?:请求|步骤)。/;

function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function repeatedToolDiagnostic(toolName: string, args: unknown, ok: boolean, content: string, limit: number): string {
  const resultLabel = ok ? 'ok' : 'fail';
  return [
    `Stopped because the same tool call repeated ${limit} times with the same result.`,
    `Tool: ${toolName}`,
    `Args: ${stableStringify(args)}`,
    `Result: ${resultLabel} - ${content || '(empty)'}`
  ].join('\n');
}

interface ReasoningLoopDetection {
  repeats: number;
  block: string[];
}

class ReasoningLoopAbort extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = 'ReasoningLoopAbort';
  }
}

function normalizeReasoningNewlines(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\r\\n|\\n|\\r/g, '\n');
}

function normalizeReasoningLines(content: string): string[] {
  return normalizeReasoningNewlines(content)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\s+/g, ' '))
    .filter(Boolean);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function detectRepeatedReasoningLoop(content: string): ReasoningLoopDetection | null {
  const lines = normalizeReasoningLines(content);
  const maxBlockLines = Math.min(REPEATED_REASONING_MAX_BLOCK_LINES, Math.floor(lines.length / REPEATED_REASONING_PATTERN_LIMIT));
  for (let blockSize = 1; blockSize <= maxBlockLines; blockSize += 1) {
    const block = lines.slice(lines.length - blockSize);
    let repeats = 1;
    for (let offset = lines.length - blockSize * 2; offset >= 0; offset -= blockSize) {
      if (!arraysEqual(lines.slice(offset, offset + blockSize), block)) break;
      repeats += 1;
    }
    if (repeats >= REPEATED_REASONING_PATTERN_LIMIT) return { repeats, block };
  }
  return null;
}

function repeatedReasoningDiagnostic(detection: ReasoningLoopDetection): string {
  const preview = detection.block.slice(0, 12).map((line) => `- ${line}`);
  if (detection.block.length > preview.length) preview.push(`- ... (${detection.block.length - preview.length} more lines)`);
  return [
    `Stopped because the model reasoning repeated the same planning pattern ${detection.repeats} times.`,
    'This usually indicates the model is stuck in a planning loop, so the run was stopped before more context was consumed.',
    '',
    'Repeated reasoning block:',
    ...preview
  ].join('\n');
}

function reasoningOverrunDiagnostic(reasoning: string, reason: 'without-content' | 'total-limit'): string {
  const lineCount = normalizeReasoningLines(reasoning).length;
  const lead = reason === 'without-content'
    ? 'Stopped because the model produced a long reasoning stream without any visible answer or tool call.'
    : 'Stopped because the model reasoning exceeded the safety limit for one run.';
  return [
    lead,
    `Reasoning length: ${reasoning.length} chars, ${lineCount} non-empty lines.`,
    'This usually means the model is stuck planning instead of making progress. Try continuing with a narrower next step, or use a tool/file-backed workflow for the blocking operation.'
  ].join('\n');
}

function reasoningOverrunReason(reasoning: string, visibleContent: string): 'without-content' | 'total-limit' | null {
  if (reasoning.length >= REASONING_TOTAL_CHAR_LIMIT) return 'total-limit';
  if (!visibleContent.trim() && reasoning.length >= REASONING_WITHOUT_CONTENT_CHAR_LIMIT) return 'without-content';
  return null;
}

function compactToolText(content: string, maxLength = 160): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function iterationLimitResponse(maxIterations: number, toolEvents: ToolEvent[]): string {
  const recentEvents = toolEvents.slice(-5);
  const lines = [
    `本轮已达到最大模型迭代轮次（${maxIterations}），我先停在这里，避免继续消耗无效请求。`,
    '',
    `本轮实际工具调用次数：${toolEvents.length}。`
  ];
  if (recentEvents.length > 0) {
    lines.push('', '最近完成的操作：');
    for (const event of recentEvents) {
      const status = event.ok ? '成功' : '失败';
      const detail = compactToolText(event.content);
      lines.push(`- ${event.toolName}：${status}${detail ? `，${detail}` : ''}`);
    }
  }
  lines.push('', '当前页面和会话状态已保留，可以继续让我从当前状态接着做。');
  return lines.join('\n');
}

function emptyAssistantResponse(): string {
  return [
    '模型本轮返回了空回复，且没有请求新的工具调用；我先停在这里，避免继续空转。',
    '',
    '当前页面和会话状态已保留，可以继续让我从当前状态接着做。'
  ].join('\n');
}

function isRecoverableLlmInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/LLM request failed \((?:400|401|403|404|422)\)/i.test(message)) return false;
  return RECOVERABLE_LLM_INTERRUPTION_PATTERN.test(message);
}

function isIterationLimitMessage(message: AgentMessage): boolean {
  return message.role === 'assistant' && ITERATION_LIMIT_MESSAGE_PATTERN.test(message.content.trim());
}

function isInvisibleEmptyAssistantMessage(message: AgentMessage): boolean {
  return message.role === 'assistant'
    && message.hidden === true
    && !message.content.trim()
    && !message.reasoning_content?.trim()
    && (message.tool_calls?.length ?? 0) === 0;
}

function sessionVisibleAssistantMessage(message: AgentMessage, toolCallCount: number): AgentMessage {
  if (toolCallCount === 0) return message;
  return {
    ...message,
    hidden: true
  };
}

interface AgentLoopRuntimeOptions extends AgentRunOptions {
  onToolEvent?: (sessionId: string, event: ToolEvent) => void;
  onMessageDelta?: (sessionId: string, event: AgentMessageDeltaStream) => void;
  onSessionUpdated?: (session: SessionRecord) => void;
  requestToolApproval?: ToolApprovalRequester;
  signal?: AbortSignal;
}

function createAbortError(): Error {
  const error = new Error('Session stopped by user.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function splitReasoningParts(content: string): string[] {
  const normalized = normalizeReasoningNewlines(content).trim();
  if (!normalized) return [];
  const lineItems = normalized
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter(Boolean);
  if (lineItems.length > 1) return lineItems;
  const sentenceItems = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
  return sentenceItems.length > 0 ? sentenceItems : [normalized];
}

export class AgentLoop {
  constructor(
    private readonly deps: {
      getConfig: () => AppConfig;
      createClient: () => LlmClient;
      toolRegistry: ToolRegistry;
      sessions: SessionStore;
      promptBuilder: PromptBuilder;
      prepareExecution: (mode: AgentRunOptions['executionMode'], runId: string) => AgentRunResult['execution'];
      beginDeferredMemory: (sessionId: string) => void;
      commitDeferredMemory: (sessionId: string) => void;
      discardDeferredMemory: (sessionId: string) => void;
      syncSessionMemory: (session: SessionRecord) => void;
    }
  ) {}

  async run(options: AgentLoopRuntimeOptions): Promise<AgentRunResult> {
    throwIfAborted(options.signal);
    const cfg = this.deps.getConfig();
    const memoryEnabled = options.useMemory !== false;
    const skillsEnabled = options.useSkills !== false;
    const requestId = createId('run');
    const execution = this.deps.prepareExecution(options.executionMode ?? cfg.defaultExecutionMode, requestId);
    const session = options.sessionId
      ? this.deps.sessions.read(options.sessionId) ?? this.deps.sessions.create('New session', options.sessionId)
      : this.deps.sessions.create();
    if (memoryEnabled) this.deps.beginDeferredMemory(session.id);
    const userMessage: AgentMessage = {
      id: createId('msg'),
      role: 'user',
      content: options.userInput,
      attachments: options.attachments?.length ? options.attachments : undefined,
      createdAt: nowIso()
    };
    try {
      const history = [
        ...session.messages.filter((message) => !isIterationLimitMessage(message) && !isInvisibleEmptyAssistantMessage(message)),
        userMessage
      ];
      const prompt = await this.deps.promptBuilder.build(cfg, {
        sessionId: session.id,
        userInput: options.userInput,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase,
        useMemory: options.useMemory,
        memoryDomains: options.memoryDomains,
        useSkills: options.useSkills,
        enabledSkillNames: options.enabledSkillNames
      });
      this.deps.sessions.setSystemPrompt(session.id, prompt);
      const messages: AgentMessage[] = [{ role: 'system', content: prompt }, ...history];
      const requestMetadata: LlmRequestMetadata = { session: session.id };
      if (options.turnType !== undefined) requestMetadata.turn_type = options.turnType;
      if (options.sessionDone !== undefined) requestMetadata.session_done = options.sessionDone;
      const client = this.deps.createClient();
      const enabledToolNames = (options.enabledToolNames ?? cfg.enabledToolNames).filter((name) => {
        if (!memoryEnabled && name === 'memory') return false;
        if (!skillsEnabled && (name === 'skill_view' || name === 'skill_manage')) return false;
        return true;
      });
      const tools = this.deps.toolRegistry.definitions(enabledToolNames);
      const toolEvents: ToolEvent[] = [];
      let usage = undefined as AgentRunResult['usage'];
      let log_probs: AgentRunResult['log_probs'];
      let finalResponse = '';
      let stopReason: 'final' | 'empty' | 'repeated-tool' | 'reasoning-loop' | 'iteration-limit' | undefined;
      let iterations = 0;
      let updatedSession = this.deps.sessions.appendMessages(session.id, [userMessage], [], execution);
      options.onSessionUpdated?.(updatedSession);
      const visibleAssistantId = createId('msg');
      const visibleAssistantCreatedAt = nowIso();
      let accumulatedReasoning = '';
      const accumulatedReasoningParts: string[] = [];
      let latestIterationReasoning = '';
      let latestIterationReasoningParts: string[] = [];
      const visibleContentParts: string[] = [];
      let reasoningOnlyContinuationCount = 0;
      let lastStreamPersistedAt = 0;
      let lastStreamPersistedLength = 0;
      let lastToolResultSignature = '';
      let repeatedToolResultCount = 0;

      const joinReasoning = (parts: string[]): string => parts.map((part) => part.trim()).filter(Boolean).join('\n');
      const joinReasoningParts = (parts: string[]): string[] => parts.map((part) => part.trim()).filter(Boolean);
      const persistMessages = (messagesToPersist: AgentMessage[], events: ToolEvent[] = []): SessionRecord => {
        updatedSession = this.deps.sessions.upsertMessages(session.id, messagesToPersist, events, execution);
        options.onSessionUpdated?.(updatedSession);
        return updatedSession;
      };
      const persistStreamSnapshot = (messageId: string, createdAt: string, content: string, reasoning: string | undefined, force = false, contentParts: string[] = []): void => {
        if (!content && !reasoning) return;
        const now = Date.now();
        if (!force && now - lastStreamPersistedAt < 250 && content.length - lastStreamPersistedLength < 160) return;
        lastStreamPersistedAt = now;
        lastStreamPersistedLength = content.length;
        persistMessages([{
          id: messageId,
          role: 'assistant',
          content,
          reasoning_content: reasoning,
          content_parts: contentParts.length > 0 ? [...contentParts] : undefined,
          createdAt
        }]);
      };
      const emitDoneDelta = (content: string, reasoning?: string, reasoningParts?: string[], contentParts: string[] = []): void => {
        if (options.stream === false || typeof options.onMessageDelta !== 'function') return;
        options.onMessageDelta(session.id, {
          sessionId: session.id,
          messageId: visibleAssistantId,
          role: 'assistant',
          type: 'done',
          content,
          reasoning_content: reasoning,
          reasoning_parts: reasoningParts,
          content_parts: contentParts.length > 0 ? [...contentParts] : undefined,
          createdAt: visibleAssistantCreatedAt
        });
      };
      const currentReasoningPayload = (reasoning: string): { text: string; parts: string[] } => {
        const parts = joinReasoningParts(splitReasoningParts(reasoning));
        return { text: joinReasoning(parts), parts };
      };

      for (; iterations < cfg.maxIterations;) {
        iterations += 1;
        throwIfAborted(options.signal);
        const streamPersistId = createId('msg');
        const streamPersistCreatedAt = nowIso();
        lastStreamPersistedAt = 0;
        lastStreamPersistedLength = 0;
        let streamedContent = '';
        let streamedReasoning = '';
        const streamComplete = typeof client.streamComplete === 'function' ? client.streamComplete.bind(client) : undefined;
        const canStream = options.stream !== false && Boolean(streamComplete) && typeof options.onMessageDelta === 'function';
        if (canStream && iterations > 1) {
          options.onMessageDelta?.(session.id, {
            sessionId: session.id,
            messageId: visibleAssistantId,
            role: 'assistant',
            type: 'reasoning_content',
            delta: '',
            content: '',
            reasoning_content: '',
            reasoning_parts: [],
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: visibleAssistantCreatedAt
          });
        }
        let completion: LlmCompletion;
        try {
          completion = canStream
            ? await streamComplete!({ messages, tools, temperature: cfg.temperature, metadata: requestMetadata, signal: options.signal }, (delta) => {
              if (delta.reasoning_content) {
                streamedReasoning += delta.reasoning_content;
                const reasoningLoop = detectRepeatedReasoningLoop([accumulatedReasoning, streamedReasoning].filter(Boolean).join('\n'));
                if (reasoningLoop) throw new ReasoningLoopAbort(repeatedReasoningDiagnostic(reasoningLoop));
                const overrunReason = reasoningOverrunReason(streamedReasoning, streamedContent);
                if (overrunReason) throw new ReasoningLoopAbort(reasoningOverrunDiagnostic(streamedReasoning, overrunReason));
                const visibleReasoning = currentReasoningPayload(streamedReasoning);
                options.onMessageDelta?.(session.id, {
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'reasoning_content',
                  delta: delta.reasoning_content,
                  reasoning_content: visibleReasoning.text,
                  reasoning_parts: visibleReasoning.parts,
                  content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
                  content: streamedContent,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, visibleReasoning.text || undefined, false, visibleContentParts);
              }
              if (delta.content) {
                streamedContent += delta.content;
                const visibleReasoning = currentReasoningPayload(streamedReasoning);
                options.onMessageDelta?.(session.id, {
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'content',
                  delta: delta.content,
                  content: streamedContent,
                  reasoning_content: visibleReasoning.text,
                  reasoning_parts: visibleReasoning.parts,
                  content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, visibleReasoning.text || undefined, false, visibleContentParts);
              }
            })
            : await client.complete({
              messages,
              tools,
              temperature: cfg.temperature,
              logProbs: options.logProbs,
              topLogProbs: options.topLogProbs,
              metadata: requestMetadata,
              signal: options.signal
            });
        } catch (error) {
          if (error instanceof ReasoningLoopAbort) {
            finalResponse = error.diagnostic;
            stopReason = 'reasoning-loop';
            const diagnosticMessage: AgentMessage = {
              id: streamPersistId,
              role: 'assistant',
              content: finalResponse,
              content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
              createdAt: streamPersistCreatedAt
            };
            messages.push(diagnosticMessage);
            persistMessages([diagnosticMessage]);
            const visibleReasoning = currentReasoningPayload(streamedReasoning);
            if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
            break;
          }
          if (!canStream || !isRecoverableLlmInterruption(error) || options.signal?.aborted) throw error;
          console.warn(`[agent] streaming LLM call interrupted; retrying once without streaming: ${error instanceof Error ? error.message : String(error)}`);
          streamedContent = '';
          streamedReasoning = '';
          options.onMessageDelta?.(session.id, {
            sessionId: session.id,
            messageId: visibleAssistantId,
            role: 'assistant',
            type: 'reasoning_content',
            delta: '',
            content: '',
            reasoning_content: '',
            reasoning_parts: [],
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: visibleAssistantCreatedAt
          });
          completion = await client.complete({
            messages,
            tools,
            temperature: cfg.temperature,
            logProbs: options.logProbs,
            topLogProbs: options.topLogProbs,
            metadata: requestMetadata,
            signal: options.signal
          });
        }
        const toolCalls = completion.message.tool_calls ?? [];
        const assistant = {
          ...completion.message,
          id: streamPersistId,
          createdAt: streamPersistCreatedAt
        };
        const currentReasoning = assistant.reasoning_content || streamedReasoning;
        const reasoningOverrun = currentReasoning.trim() ? reasoningOverrunReason(currentReasoning, assistant.content ?? streamedContent) : null;
        if (reasoningOverrun) {
          usage = completion.usage ?? usage;
          log_probs = completion.log_probs ?? log_probs;
          finalResponse = reasoningOverrunDiagnostic(currentReasoning, reasoningOverrun);
          stopReason = 'reasoning-loop';
          const diagnosticMessage: AgentMessage = {
            id: streamPersistId,
            role: 'assistant',
            content: finalResponse,
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: streamPersistCreatedAt
          };
          messages.push(diagnosticMessage);
          persistMessages([diagnosticMessage]);
          const visibleReasoning = currentReasoningPayload(currentReasoning);
          if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
          break;
        }
        const reasoningLoop = currentReasoning.trim()
          ? detectRepeatedReasoningLoop([accumulatedReasoning, currentReasoning].filter(Boolean).join('\n'))
          : null;
        if (reasoningLoop) {
          usage = completion.usage ?? usage;
          log_probs = completion.log_probs ?? log_probs;
          finalResponse = repeatedReasoningDiagnostic(reasoningLoop);
          stopReason = 'reasoning-loop';
          const diagnosticMessage: AgentMessage = {
            id: streamPersistId,
            role: 'assistant',
            content: finalResponse,
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: streamPersistCreatedAt
          };
          messages.push(diagnosticMessage);
          persistMessages([diagnosticMessage]);
          const visibleReasoning = currentReasoningPayload(currentReasoning);
          if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
          break;
        }
        if (currentReasoning.trim()) {
          const currentParts = splitReasoningParts(currentReasoning);
          latestIterationReasoningParts = currentParts;
          latestIterationReasoning = joinReasoning(currentParts);
          accumulatedReasoningParts.push(...currentParts);
          accumulatedReasoning = joinReasoning(accumulatedReasoningParts);
          assistant.reasoning_parts = currentParts.length > 0 ? currentParts : undefined;
          assistant.reasoning_content = latestIterationReasoning || currentReasoning;
        } else {
          latestIterationReasoning = '';
          latestIterationReasoningParts = [];
          delete assistant.reasoning_content;
          delete assistant.reasoning_parts;
        }
        usage = completion.usage ?? usage;
        log_probs = completion.log_probs ?? log_probs;
        messages.push(assistant);

        if (toolCalls.length === 0) {
          const assistantContent = assistant.content ?? '';
          const hasCurrentReasoning = currentReasoning.trim().length > 0;
          if (!assistantContent.trim() && hasCurrentReasoning && iterations < cfg.maxIterations && reasoningOnlyContinuationCount < REASONING_ONLY_CONTINUE_LIMIT) {
            reasoningOnlyContinuationCount += 1;
            persistMessages([{
              id: streamPersistId,
              role: 'assistant',
              hidden: true,
              content: '',
              reasoning_content: undefined,
              reasoning_parts: undefined,
              createdAt: streamPersistCreatedAt
            }]);
            continue;
          }
          finalResponse = assistantContent.trim() ? assistantContent : '';
          stopReason = finalResponse ? 'final' : 'empty';
          if (stopReason === 'empty') {
            finalResponse = emptyAssistantResponse();
            assistant.content = finalResponse;
          }
          assistant.content_parts = visibleContentParts.length > 0 ? [...visibleContentParts] : undefined;
          persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, finalResponse, assistant.reasoning_content, true, visibleContentParts);
          if (canStream) emitDoneDelta(finalResponse, assistant.reasoning_content, assistant.reasoning_parts, visibleContentParts);
          persistMessages([assistant]);
          break;
        }

        reasoningOnlyContinuationCount = 0;
        if (assistant.content?.trim()) {
          visibleContentParts.push(assistant.content.trim());
        }
        assistant.content_parts = visibleContentParts.length > 0 ? [...visibleContentParts] : undefined;
        persistMessages([sessionVisibleAssistantMessage(assistant, toolCalls.length)]);

        for (const call of toolCalls) {
          throwIfAborted(options.signal);
          const args = parseToolArgs(call.function.arguments);
          const result = await this.deps.toolRegistry.execute(call.function.name, args, {
            sessionId: session.id,
            workspaceDir: execution.workspaceDir,
            requestId: call.id,
            safetyApproval: this.deps.getConfig().safetyApproval,
            requestToolApproval: options.requestToolApproval
          });
          throwIfAborted(options.signal);
          const event: ToolEvent = {
            id: createId('toolevent'),
            toolName: call.function.name,
            args,
            ok: result.ok,
            content: result.content,
            approval: result.approval,
            createdAt: nowIso()
          };
          toolEvents.push(event);
          options.onToolEvent?.(session.id, event);
          const toolMessage: AgentMessage = {
            id: createId('msg'),
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: result.content,
            createdAt: nowIso()
          };
          messages.push(toolMessage);
          persistMessages([toolMessage], [event]);

          const toolResultSignature = stableStringify({
            toolName: call.function.name,
            args,
            ok: result.ok,
            content: result.content
          });
          repeatedToolResultCount = toolResultSignature === lastToolResultSignature ? repeatedToolResultCount + 1 : 1;
          lastToolResultSignature = toolResultSignature;
          if (repeatedToolResultCount >= REPEATED_TOOL_RESULT_LIMIT) {
            finalResponse = repeatedToolDiagnostic(call.function.name, args, result.ok, result.content, REPEATED_TOOL_RESULT_LIMIT);
            stopReason = 'repeated-tool';
            const diagnosticMessage: AgentMessage = {
              id: createId('msg'),
              role: 'assistant',
              content: finalResponse,
              content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
              createdAt: nowIso()
            };
            messages.push(diagnosticMessage);
            persistMessages([diagnosticMessage]);
            if (canStream) emitDoneDelta(finalResponse, latestIterationReasoning, latestIterationReasoningParts, visibleContentParts);
            break;
          }
        }
        if (finalResponse) break;
      }

      if (!stopReason && iterations >= cfg.maxIterations) {
        stopReason = 'iteration-limit';
      }

      if (!finalResponse && stopReason === 'iteration-limit') {
        finalResponse = iterationLimitResponse(cfg.maxIterations, toolEvents);
        const limitMessage: AgentMessage = {
          id: createId('msg'),
          role: 'assistant',
          content: finalResponse,
          content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
          createdAt: nowIso()
        };
        persistMessages([limitMessage]);
        emitDoneDelta(finalResponse, latestIterationReasoning, latestIterationReasoningParts, visibleContentParts);
      }

      if (memoryEnabled) {
        this.deps.commitDeferredMemory(session.id);
        this.deps.syncSessionMemory(updatedSession);
      }
      return {
        sessionId: session.id,
        finalResponse,
        messages: updatedSession.messages,
        toolEvents,
        usage,
        log_probs,
        iterations,
        execution
      };
    } catch (error) {
      if (memoryEnabled) this.deps.discardDeferredMemory(session.id);
      throw error;
    }
  }
}
