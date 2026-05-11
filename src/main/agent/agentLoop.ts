import type { AgentMessage, AgentMessageDeltaStream, AgentRunOptions, AgentRunResult, AppConfig, SessionRecord, ToolApprovalRequester, ToolEvent } from '../../shared/types.js';
import type { LlmClient } from './llmClient.js';
import { createId, nowIso } from '../../shared/types.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { SessionStore } from '../storage/sessionStore.js';
import { PromptBuilder } from './promptBuilder.js';

function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

interface AgentLoopRuntimeOptions extends AgentRunOptions {
  onToolEvent?: (sessionId: string, event: ToolEvent) => void;
  onMessageDelta?: (sessionId: string, event: AgentMessageDeltaStream) => void;
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
      const appended: AgentMessage[] = [userMessage];
      const visibleAssistantId = createId('msg');
      const visibleAssistantCreatedAt = nowIso();
      let accumulatedReasoning = '';
      const accumulatedReasoningParts: string[] = [];

      const joinReasoning = (parts: string[]): string => parts.map((part) => part.trim()).filter(Boolean).join('\n');
      const joinReasoningParts = (parts: string[]): string[] => parts.map((part) => part.trim()).filter(Boolean);

      for (; iterations < cfg.maxIterations; iterations++) {
        throwIfAborted(options.signal);
        const assistantId = createId('msg');
        const assistantCreatedAt = nowIso();
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
              }
            })
          : await client.complete({ messages, tools, temperature: cfg.temperature, signal: options.signal });
        const assistant = { ...completion.message, id: assistantId, createdAt: assistantCreatedAt };
        const currentReasoning = assistant.reasoning_content || streamedReasoning;
        if (currentReasoning.trim()) {
          const currentParts = splitReasoningParts(currentReasoning);
          accumulatedReasoningParts.push(...currentParts);
          accumulatedReasoning = joinReasoning(accumulatedReasoningParts);
          assistant.reasoning_parts = currentParts.length > 0 ? currentParts : undefined;
        }
        usage = completion.usage ?? usage;
        messages.push(assistant);
        appended.push(assistant);

        const toolCalls = assistant.tool_calls ?? [];
        if (toolCalls.length === 0) {
          if (accumulatedReasoning) assistant.reasoning_content = accumulatedReasoning;
          if (accumulatedReasoningParts.length > 0) assistant.reasoning_parts = [...accumulatedReasoningParts];
          finalResponse = assistant.content || '';
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
          appended.push(toolMessage);
        }
      }

      if (!finalResponse) {
        finalResponse = `Reached iteration limit (${cfg.maxIterations}). Last tool events: ${toolEvents.map((e) => `${e.toolName}:${e.ok ? 'ok' : 'fail'}`).join(', ')}`;
        const limitMessage: AgentMessage = { id: createId('msg'), role: 'assistant', content: finalResponse, createdAt: nowIso() };
        appended.push(limitMessage);
      }

      const updated = this.deps.sessions.appendMessages(session.id, appended, toolEvents, execution);
      this.deps.commitDeferredMemory(session.id);
      this.deps.syncSessionMemory(updated);
      return {
        sessionId: session.id,
        finalResponse,
        messages: updated.messages,
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
