import type { AgentMessage, AgentMessageDeltaStream, AgentRunOptions, AgentRunResult, AppConfig, SessionRecord, ToolApprovalRequester, ToolEvent } from '../../shared/types.js';
import type { LlmClient } from './llmClient.js';
import { createId, nowIso } from '../../shared/types.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { SessionStore } from '../storage/sessionStore.js';
import { PromptBuilder } from './promptBuilder.js';

const REPEATED_TOOL_RESULT_LIMIT = 3;

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
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
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
    const requestId = createId('run');
    const execution = this.deps.prepareExecution(options.executionMode ?? cfg.defaultExecutionMode, requestId);
    const session = options.sessionId ? this.deps.sessions.read(options.sessionId) ?? this.deps.sessions.create() : this.deps.sessions.create();
    this.deps.beginDeferredMemory(session.id);
    const userMessage: AgentMessage = {
      id: createId('msg'),
      role: 'user',
      content: options.userInput,
      attachments: options.attachments?.length ? options.attachments : undefined,
      createdAt: nowIso()
    };
    try {
      const history = [...session.messages, userMessage];
      const prompt = await this.deps.promptBuilder.build(cfg, {
        sessionId: session.id,
        userInput: options.userInput,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase
      });
      this.deps.sessions.setSystemPrompt(session.id, prompt);
      const messages: AgentMessage[] = [{ role: 'system', content: prompt }, ...history];
      const client = this.deps.createClient();
      const tools = this.deps.toolRegistry.definitions(cfg.enabledToolNames);
      const toolEvents: ToolEvent[] = [];
      let usage = undefined as AgentRunResult['usage'];
      let finalResponse = '';
      let iterations = 0;
      let updatedSession = this.deps.sessions.appendMessages(session.id, [userMessage], [], execution);
      options.onSessionUpdated?.(updatedSession);
      const visibleAssistantId = createId('msg');
      const visibleAssistantCreatedAt = nowIso();
      let accumulatedReasoning = '';
      const accumulatedReasoningParts: string[] = [];
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
      const persistStreamSnapshot = (messageId: string, createdAt: string, content: string, reasoning: string | undefined, force = false): void => {
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
          createdAt
        }]);
      };

      for (; iterations < cfg.maxIterations; iterations++) {
        throwIfAborted(options.signal);
        const streamPersistId = createId('msg');
        const streamPersistCreatedAt = nowIso();
        lastStreamPersistedAt = 0;
        lastStreamPersistedLength = 0;
        let streamedContent = '';
        let streamedReasoning = '';
        const streamComplete = typeof client.streamComplete === 'function' ? client.streamComplete.bind(client) : undefined;
        const canStream = options.stream !== false && Boolean(streamComplete) && typeof options.onMessageDelta === 'function';
        const completion = canStream
          ? await streamComplete!({ messages, tools, temperature: cfg.temperature, signal: options.signal }, (delta) => {
              if (delta.reasoning_content) {
                streamedReasoning += delta.reasoning_content;
                const visibleReasoningParts = joinReasoningParts([...accumulatedReasoningParts, ...splitReasoningParts(streamedReasoning)]);
                options.onMessageDelta?.(session.id, {
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'reasoning_content',
                  delta: delta.reasoning_content,
                  reasoning_content: joinReasoning(visibleReasoningParts),
                  reasoning_parts: visibleReasoningParts,
                  content: streamedContent,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, joinReasoning(visibleReasoningParts) || undefined);
              }
              if (delta.content) {
                streamedContent += delta.content;
                const visibleReasoningParts = joinReasoningParts([...accumulatedReasoningParts, ...splitReasoningParts(streamedReasoning)]);
                options.onMessageDelta?.(session.id, {
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'content',
                  delta: delta.content,
                  content: streamedContent,
                  reasoning_content: joinReasoning(visibleReasoningParts) || undefined,
                  reasoning_parts: visibleReasoningParts.length > 0 ? visibleReasoningParts : undefined,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, joinReasoning(visibleReasoningParts) || undefined);
              }
            })
          : await client.complete({ messages, tools, temperature: cfg.temperature, signal: options.signal });
        const toolCalls = completion.message.tool_calls ?? [];
        const assistant = {
          ...completion.message,
          id: streamPersistId,
          createdAt: streamPersistCreatedAt
        };
        const currentReasoning = assistant.reasoning_content || streamedReasoning;
        if (currentReasoning.trim()) {
          const currentParts = splitReasoningParts(currentReasoning);
          accumulatedReasoningParts.push(...currentParts);
          accumulatedReasoning = joinReasoning(accumulatedReasoningParts);
          assistant.reasoning_parts = currentParts.length > 0 ? currentParts : undefined;
        }
        usage = completion.usage ?? usage;
        messages.push(assistant);
        persistMessages([assistant]);

        if (toolCalls.length === 0) {
          if (accumulatedReasoning) assistant.reasoning_content = accumulatedReasoning;
          if (accumulatedReasoningParts.length > 0) assistant.reasoning_parts = [...accumulatedReasoningParts];
          finalResponse = assistant.content || '';
          persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, finalResponse, assistant.reasoning_content, true);
          if (canStream) {
            options.onMessageDelta?.(session.id, {
              sessionId: session.id,
              messageId: visibleAssistantId,
              role: 'assistant',
              type: 'done',
              content: assistant.content,
              reasoning_content: assistant.reasoning_content,
              reasoning_parts: assistant.reasoning_parts,
              createdAt: visibleAssistantCreatedAt
            });
          }
          persistMessages([assistant]);
          break;
        }

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
            const diagnosticMessage: AgentMessage = {
              id: createId('msg'),
              role: 'assistant',
              content: finalResponse,
              createdAt: nowIso()
            };
            messages.push(diagnosticMessage);
            persistMessages([diagnosticMessage]);
            if (canStream) {
              options.onMessageDelta?.(session.id, {
                sessionId: session.id,
                messageId: visibleAssistantId,
                role: 'assistant',
                type: 'done',
                content: finalResponse,
                reasoning_content: accumulatedReasoning || undefined,
                reasoning_parts: accumulatedReasoningParts.length > 0 ? accumulatedReasoningParts : undefined,
                createdAt: visibleAssistantCreatedAt
              });
            }
            break;
          }
        }
        if (finalResponse) break;
      }

      if (!finalResponse) {
        finalResponse = `Reached iteration limit (${cfg.maxIterations}). Last tool events: ${toolEvents.map((e) => `${e.toolName}:${e.ok ? 'ok' : 'fail'}`).join(', ')}`;
        const limitMessage: AgentMessage = { id: createId('msg'), role: 'assistant', content: finalResponse, createdAt: nowIso() };
        persistMessages([limitMessage]);
      }

      this.deps.commitDeferredMemory(session.id);
      this.deps.syncSessionMemory(updatedSession);
      return {
        sessionId: session.id,
        finalResponse,
        messages: updatedSession.messages,
        toolEvents,
        usage,
        iterations: iterations + 1,
        execution
      };
    } catch (error) {
      this.deps.discardDeferredMemory(session.id);
      throw error;
    }
  }
}
