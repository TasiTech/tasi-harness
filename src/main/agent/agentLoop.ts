import type { AgentMessage, AgentRunOptions, AgentRunResult, AppConfig, SessionRecord, ToolEvent } from '../../shared/types.js';
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
    const cfg = this.deps.getConfig();
    const requestId = createId('run');
    const execution = this.deps.prepareExecution(options.executionMode ?? cfg.defaultExecutionMode, requestId);
    const session = options.sessionId ? this.deps.sessions.read(options.sessionId) ?? this.deps.sessions.create() : this.deps.sessions.create();
    this.deps.beginDeferredMemory(session.id);
    const userMessage: AgentMessage = { id: createId('msg'), role: 'user', content: options.userInput, createdAt: nowIso() };
    try {
      const history = [...session.messages, userMessage];
      const prompt = await this.deps.promptBuilder.build(cfg, {
        sessionId: session.id,
        userInput: options.userInput,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase
      });
      const messages: AgentMessage[] = [{ role: 'system', content: prompt }, ...history];
      const client = this.deps.createClient();
      const tools = this.deps.toolRegistry.definitions(cfg.enabledToolNames);
      const toolEvents: ToolEvent[] = [];
      let usage = undefined as AgentRunResult['usage'];
      let finalResponse = '';
      let iterations = 0;
      const appended: AgentMessage[] = [userMessage];

      for (; iterations < cfg.maxIterations; iterations++) {
        const completion = await client.complete({ messages, tools, temperature: cfg.temperature });
        const assistant = { ...completion.message, id: completion.message.id ?? createId('msg'), createdAt: nowIso() };
        usage = completion.usage ?? usage;
        messages.push(assistant);
        appended.push(assistant);

        const toolCalls = assistant.tool_calls ?? [];
        if (toolCalls.length === 0) {
          finalResponse = assistant.content || '';
          break;
        }

        for (const call of toolCalls) {
          const args = parseToolArgs(call.function.arguments);
          const result = await this.deps.toolRegistry.execute(call.function.name, args, {
            sessionId: session.id,
            workspaceDir: execution.workspaceDir,
            requestId: call.id
          });
          const event: ToolEvent = {
            id: createId('toolevent'),
            toolName: call.function.name,
            args,
            ok: result.ok,
            content: result.content,
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
