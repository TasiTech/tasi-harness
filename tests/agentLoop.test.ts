import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AgentLoop } from '../src/main/agent/agentLoop.js';
import { MockLlmClient, type LlmClient } from '../src/main/agent/llmClient.js';
import { PromptBuilder } from '../src/main/agent/promptBuilder.js';
import { PersonalKnowledgeBase } from '../src/main/knowledge/personalKnowledgeBase.js';
import { MemoryStore } from '../src/main/storage/memoryStore.js';
import { SessionStore } from '../src/main/storage/sessionStore.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { defaultConfig, ensureDir } from '../src/main/storage/pathUtils.js';
import { ToolRegistry } from '../src/main/tools/toolRegistry.js';
import { createBuiltinTools } from '../src/main/tools/builtinTools.js';
import type { AgentMessageDeltaStream, DshSidecarRuntimeStatus, LlmCompletion, LlmRequest, RegisteredTool } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('AgentLoop', () => {
  it('executes model-requested tool calls and returns final response', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'answer.txt', content: '42' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Done.' } }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });
    const result = await loop.run({ userInput: 'write a file' });
    expect(result.finalResponse).toBe('Done.');
    expect(result.toolEvents).toHaveLength(1);
    expect(result.messages.at(-1)?.artifacts?.[0]).toMatchObject({
      name: 'answer.txt',
      path: 'answer.txt',
      ext: '.txt',
      kind: 'text',
      previewMode: 'text'
    });
    expect(existsSync(join(cfg.workspaceDir, 'answer.txt'))).toBe(true);
    expect(readFileSync(join(cfg.workspaceDir, 'answer.txt'), 'utf8')).toBe('42');
    const storedMemory = memory.getState({ target: 'memory', sessionId: result.sessionId, includeGlobal: false }).entries;
    expect(storedMemory).toHaveLength(1);
    expect(storedMemory[0]?.content).toContain('write a file');
    const storedSession = sessions.read(result.sessionId);
    expect(storedSession?.systemPrompt).toContain(cfg.systemPersona);
    expect(storedSession?.systemPromptHistory?.length).toBe(1);
    expect(storedSession?.systemPromptHistory?.at(-1)?.prompt).toContain(cfg.systemPersona);
    expect(storedSession?.messages.some((message) => message.role === 'tool')).toBe(true);

    const rawSession = JSON.parse(readFileSync(join(env.home, 'sessions', `${result.sessionId}.json`), 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(rawSession, 'systemPrompt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rawSession, 'messageCount')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(rawSession, 'toolEvents')).toBe(false);
    const rawMessages = Array.isArray(rawSession.messages) ? rawSession.messages : [];
    expect(rawMessages.some((message) => message && typeof message === 'object' && (message as { role?: string }).role === 'tool')).toBe(true);
  });

  it('orders messages so stable prompt and previous history remain prefix-cache friendly', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 2 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const requests: LlmRequest[] = [];
    const client: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
        return { message: { role: 'assistant', content: 'Done.' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'first request', stream: false });
    await loop.run({ sessionId: result.sessionId, userInput: 'second request', stream: false });

    const firstMessages = requests[0]?.messages ?? [];
    const secondMessages = requests[1]?.messages ?? [];
    expect(firstMessages[0]?.role).toBe('system');
    expect(firstMessages[0]?.content).toContain('## Installed skills index');
    expect(firstMessages[0]?.content).not.toContain('Current timestamp:');
    expect(firstMessages[1]?.role).toBe('user');
    expect(firstMessages[1]?.content).toContain('first request');
    expect(firstMessages[1]?.content).toContain('## Runtime context');
    expect(secondMessages[1]).toMatchObject({ role: 'user', content: 'first request' });
    expect(secondMessages[2]).toMatchObject({ role: 'assistant', content: 'Done.' });
    expect(secondMessages.at(-1)?.content).toContain('second request');
    expect(secondMessages.at(-1)?.content).toContain('## Runtime context');
    expect(sessions.read(result.sessionId)?.messages[0]?.content).toBe('first request');
  });

  it('can run an internal followup without persisting or duplicating user turns', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const session = sessions.create('Plugin turn');
    sessions.appendMessages(session.id, [{
      id: 'msg_visible_user',
      role: 'user',
      content: '@nanmicoder/dsh-agent-teams explain weather',
      createdAt: '2026-09-02T00:00:00.000Z'
    }]);
    const registry = new ToolRegistry();
    let capturedRequest: LlmRequest | undefined;
    const client: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        capturedRequest = JSON.parse(JSON.stringify(request)) as LlmRequest;
        return { message: { role: 'assistant', content: 'Done.' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (record) => {
        void memory.syncSessionMemory(record);
      }
    });

    const result = await loop.run({
      sessionId: session.id,
      userInput: '/agent-teams explain weather',
      stream: false,
      persistUserMessage: false,
      omitHistoryMessageIds: ['msg_visible_user']
    });

    expect(result.finalResponse).toBe('Done.');
    const requestUsers = capturedRequest?.messages.filter((message) => message.role === 'user') ?? [];
    expect(requestUsers).toHaveLength(1);
    expect(requestUsers[0]?.content).toContain('/agent-teams explain weather');
    expect(requestUsers[0]?.content).not.toContain('@nanmicoder/dsh-agent-teams explain weather');
    expect(sessions.read(session.id)?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('enables referenced DSH plugin tools for the current turn with @ syntax', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 2, enabledToolNames: [] };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const pluginTool: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'demo_plugin_tool',
          description: 'Demo plugin tool.',
          parameters: { type: 'object', properties: {} }
        }
      },
      safety: 'stateful',
      execute: async () => ({ ok: true, content: 'ok' })
    };
    registry.register(pluginTool);
    const requests: LlmRequest[] = [];
    const client: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        requests.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
        return { message: { role: 'assistant', content: 'Done.' } };
      }
    };
    const runtimeStatus: DshSidecarRuntimeStatus = {
      status: {
        available: true,
        running: true,
        protocolVersion: 1,
        home: env.home,
        profileName: 'default',
        profileDir: join(env.home, 'profile')
      },
      plugins: [{
        id: 'demo-plugin',
        packageName: '@owner/demo-plugin',
        version: '1.0.0',
        enabled: true,
        status: 'loaded',
        tools: ['demo_plugin_tool'],
        commands: ['/demo-plugin'],
        settingsEntries: ['Demo Plugin']
      }],
      tools: [pluginTool.definition]
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      },
      getDshRuntimeStatus: async () => runtimeStatus
    });

    await loop.run({ userInput: '@demo-plugin handle this', stream: false });

    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['demo_plugin_tool']);
    expect(requests[0]?.messages.at(-1)?.content).toContain('## DSH Plugin References');
    expect(requests[0]?.messages.at(-1)?.content).toContain('@demo-plugin -> @owner/demo-plugin (loaded)');
    expect(requests[0]?.messages.at(-1)?.content).toContain('Tools: demo_plugin_tool');
  });

  it('repairs a skill-driven final answer when delivery validation fails', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 5 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    skills.create({
      name: 'demo-delivery',
      category: 'work',
      content: [
        '---',
        'name: demo-delivery',
        'description: Demo delivery skill.',
        '---',
        '',
        '# Demo Delivery',
        '',
        'Before finalizing, the answer must mention the verified source and completed validation.'
      ].join('\n')
    });
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_skill',
            type: 'function',
            function: { name: 'skill_view', arguments: JSON.stringify({ name: 'demo-delivery' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Done.' } },
      { message: { role: 'assistant', content: '{"ok":false,"issues":["missing validation"],"required_actions":["mention validation"]}' } },
      { message: { role: 'assistant', content: 'Done after checking the verified source and completed validation.' } },
      { message: { role: 'assistant', content: '{"ok":true,"issues":[],"required_actions":[]}' } }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'use demo-delivery to finish the task' });

    expect(result.finalResponse).toBe('Done after checking the verified source and completed validation.');
    expect(result.iterations).toBe(3);
    const stored = sessions.read(result.sessionId);
    expect(stored?.messages.some((message) => message.hidden && message.content.includes('Skill delivery validation failed'))).toBe(true);
    expect(stored?.messages.some((message) => !message.hidden && message.content === 'Done.')).toBe(false);
    const display = sessions.readForDisplay(result.sessionId);
    expect(display?.messages.some((message) => message.content.includes('Skill delivery validation failed'))).toBe(false);
    expect(display?.messages.some((message) => message.hidden === true)).toBe(false);
  });

  it('does not repair-loop when skill delivery validation returns neutral non-json text', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    skills.create({
      name: 'demo-delivery',
      category: 'work',
      content: '---\nname: demo-delivery\ndescription: Demo delivery skill.\n---\n\n# Demo Delivery\n\nValidate before final.'
    });
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_skill',
            type: 'function',
            function: { name: 'skill_view', arguments: JSON.stringify({ name: 'demo-delivery' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Done.' } },
      { message: { role: 'assistant', content: 'Looks acceptable.' } }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'use demo-delivery to finish the task' });

    expect(result.finalResponse).toBe('Done.');
    expect(result.iterations).toBe(2);
    expect(sessions.readForDisplay(result.sessionId)?.messages.some((message) => message.content.includes('Skill delivery validation failed'))).toBe(false);
  });

  it('validates document artifacts even when no skill was loaded', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const requests: LlmRequest[] = [];
    const client = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_report',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'report.md', content: '# Report\n\nThis generated report has enough body text for validation.' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Final delivery: report.md is ready.' } },
      { message: { role: 'assistant', content: '{"ok":true,"issues":[],"required_actions":[]}' } }
    ]);
    const wrappedClient: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        requests.push(request);
        return client.complete();
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => wrappedClient,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'generate a report markdown file', stream: false });

    expect(result.finalResponse).toBe('Final delivery: report.md is ready.');
    expect(result.iterations).toBe(2);
    expect(requests.some((request) => request.metadata?.turn_type === 'skill_delivery_validation')).toBe(true);
  });

  it('hard-gates final document delivery when generated artifacts contain placeholders', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 6 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_report_draft',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'report.md', content: '# Report\n\n[\u5f85\u8865\u5145: conclusion]' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Final delivery: report.md is complete.' } },
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_report_repair',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'report.md', content: '# Report\n\nCompleted audited body with final conclusions and evidence.' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Final delivery: report.md is complete.' } },
      { message: { role: 'assistant', content: '{"ok":true,"issues":[],"required_actions":[]}' } }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'generate a report markdown file', stream: false });

    expect(result.finalResponse).toBe('Final delivery: report.md is complete.');
    expect(result.iterations).toBe(4);
    expect(result.toolEvents).toHaveLength(2);
    expect(readFileSync(join(cfg.workspaceDir, 'report.md'), 'utf8')).not.toContain('[\u5f85\u8865\u5145');
    const stored = sessions.read(result.sessionId);
    expect(stored?.messages.some((message) => message.hidden && message.content.includes('deterministic document delivery gate failed'))).toBe(true);
  });

  it('does not hard-validate source materials, URLs, or corrupt path fragments as document artifacts', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    registry.register({
      safety: 'executes-command',
      definition: {
        type: 'function',
        function: {
          name: 'terminal',
          description: 'Mock terminal for artifact discovery tests.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
          }
        }
      },
      async execute(_args, context) {
        writeFileSync(join(context.workspaceDir, 'A-bid.md'), '# A Bid\n\nFinal audited bid content with enough text.', 'utf8');
        return {
          ok: true,
          content: [
            String.raw`Read source: D:\tender\source\tender_text.md`,
            String.raw`Tender notice: D:\tender\notice\notice.docx`,
            String.raw`Address: http://www.gxzfcg.gov.cn/view/staticpags/shengji_cggg/example.html`,
            'Corrupt fragment: d=docx.Doc',
            'Corrupt fragment: checkpoint_\uFFFD\uFFFDIPTV.md',
            'Ran inventory_materials.py',
            'Ran extract_tender_text.py',
            'Ran create_bid_checkpoint.py',
            'Ran validate_bid_package.py',
            'Generated: A-bid.md'
          ].join('\n')
        };
      }
    });
    const requests: LlmRequest[] = [];
    const client = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_bid',
            type: 'function',
            function: { name: 'terminal', arguments: JSON.stringify({ command: 'mock bid generation' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Final delivery: A-bid.md is complete.' } },
      { message: { role: 'assistant', content: '{"ok":true,"issues":[],"required_actions":[]}' } }
    ]);
    const wrappedClient: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        requests.push(request);
        return client.complete();
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => wrappedClient,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'generate a complete bid document from tender sources', stream: false });

    expect(result.finalResponse).toBe('Final delivery: A-bid.md is complete.');
    const validationRequest = requests.find((request) => request.metadata?.turn_type === 'skill_delivery_validation');
    const validationPrompt = validationRequest?.messages.at(-1)?.content ?? '';
    const contextLine = /Deterministic document delivery context:\n(.+)\n\nRelevant tool and skill evidence:/.exec(validationPrompt)?.[1] ?? '';
    expect(contextLine).toContain('"artifacts":["A-bid.md"]');
    expect(contextLine).not.toContain('tender_text.md');
    expect(contextLine).not.toContain('notice.docx');
    expect(contextLine).not.toContain('gxzfcg.gov.cn');
    expect(contextLine).not.toContain('docx.Doc');
    expect(contextLine).not.toContain('checkpoint_');
  });

  it('does not persist tool-call preambles as visible assistant replies', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: 'I will check that now. Please wait.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'answer.txt', content: '42' }) }
          }]
        }
      },
      { message: { role: 'assistant', content: 'Done.' } }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'write a file' });
    const stored = sessions.read(result.sessionId);
    const assistantMessages = stored?.messages.filter((message) => message.role === 'assistant') ?? [];

    expect(result.finalResponse).toBe('Done.');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]?.content).toBe('I will check that now. Please wait.');
    expect(assistantMessages[0]?.hidden).toBe(true);
    expect(assistantMessages[0]?.tool_calls?.[0]?.function.name).toBe('file_write');
    expect(assistantMessages[1]?.content).toBe('Done.');
    expect(stored?.messages.some((message) => message.content === 'I will check that now. Please wait.')).toBe(true);
  });

  it('emits streamed assistant deltas when the client supports streaming', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: 'Streamed answer.',
          reasoning_content: 'Brief reasoning.'
        }
      }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'hello',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'reasoning_content') deltas.push(`r:${event.delta}`);
        if (event.type === 'content') deltas.push(`c:${event.delta}`);
        if (event.type === 'done') deltas.push(`done:${event.content}`);
      }
    });

    expect(result.finalResponse).toBe('Streamed answer.');
    expect(deltas).toEqual(['r:Brief reasoning.', 'c:Streamed answer.', 'done:Streamed answer.']);
  });

  it('clips long streamed reasoning deltas while preserving full reasoning in the result', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const longReasoning = [
      'old reasoning '.repeat(320),
      'middle reasoning '.repeat(260),
      'latest reasoning'
    ].join('\n');
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: 'Streamed answer.',
          reasoning_content: longReasoning
        }
      }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const reasoningDeltas: Array<{ content?: string; omitted?: boolean; length?: number }> = [];
    const result = await loop.run({
      userInput: 'hello',
      onMessageDelta: (_sessionId, event) => {
        if (event.reasoning_content) {
          reasoningDeltas.push({
            content: event.reasoning_content,
            omitted: event.reasoningOmitted,
            length: event.reasoningLength
          });
        }
      }
    });

    expect(reasoningDeltas.length).toBeGreaterThan(0);
    expect(reasoningDeltas.every((event) => (event.content?.length ?? 0) <= 3000)).toBe(true);
    expect(reasoningDeltas.some((event) => event.omitted === true && (event.length ?? 0) > 3000)).toBe(true);
    const finalAssistant = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content === 'Streamed answer.');
    expect(finalAssistant?.reasoning_content).toContain('latest reasoning');
    expect(finalAssistant?.reasoning_content?.length).toBeGreaterThan(3000);
  });

  it('continues with a non-stream retry after a recoverable streamed LLM interruption', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    let streamCalls = 0;
    let completeCalls = 0;
    const client: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        completeCalls += 1;
        return { message: { role: 'assistant', content: 'Recovered answer.' } };
      },
      async streamComplete(_request: LlmRequest, onDelta: (delta: { reasoning_content?: string; content?: string }) => void): Promise<LlmCompletion> {
        streamCalls += 1;
        onDelta({ reasoning_content: 'partial thought' });
        onDelta({ content: 'partial answer' });
        throw new Error('Invalid LLM stream event: {"choices":[{"delta":{"reasoning":"."},"finish_reason":null');
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'recover please',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'reasoning_content') deltas.push(`r:${event.delta ?? ''}:${event.reasoning_content ?? ''}:${event.content ?? ''}`);
        if (event.type === 'content') deltas.push(`c:${event.delta ?? ''}:${event.content ?? ''}:${event.reasoning_content ?? ''}`);
        if (event.type === 'done') deltas.push(`done:${event.content}:${event.reasoning_content ?? ''}`);
      }
    });

    expect(streamCalls).toBe(1);
    expect(completeCalls).toBe(1);
    expect(result.finalResponse).toBe('Recovered answer.');
    expect(deltas).toEqual([
      'r:partial thought::',
      'c:partial answer::',
      'r:::',
      'done:Recovered answer.:'
    ]);
    expect(sessions.read(result.sessionId)?.messages.at(-1)?.content).toBe('Recovered answer.');
  });

  it('continues automatically when a completion has reasoning but no content or tool calls', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 3 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const requests: LlmRequest[] = [];
    let streamCalls = 0;
    const client: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        return { message: { role: 'assistant', content: 'fallback' } };
      },
      async streamComplete(request: LlmRequest, onDelta: (delta: { reasoning_content?: string; content?: string }) => void): Promise<LlmCompletion> {
        requests.push(request);
        streamCalls += 1;
        if (streamCalls === 1) {
          onDelta({ reasoning_content: 'Need one more pass.' });
          return { message: { role: 'assistant', content: '', reasoning_content: 'Need one more pass.' } };
        }
        onDelta({ content: 'Visible answer.' });
        return { message: { role: 'assistant', content: 'Visible answer.' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'continue from reasoning',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'reasoning_content') deltas.push(`r:${event.delta ?? ''}:${event.reasoning_content ?? ''}:${event.content ?? ''}`);
        if (event.type === 'content') deltas.push(`c:${event.delta ?? ''}:${event.content ?? ''}:${event.reasoning_content ?? ''}`);
        if (event.type === 'done') deltas.push(`done:${event.content}:${event.reasoning_content ?? ''}`);
      }
    });

    expect(streamCalls).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.finalResponse).toBe('Visible answer.');
    expect(requests[1]?.messages.some((message) => message.role === 'assistant' && message.reasoning_content === 'Need one more pass.')).toBe(true);
    expect(deltas).toEqual([
      'r:Need one more pass.::',
      'r:::',
      'c:Visible answer.::',
      'done:Visible answer.:'
    ]);
    const visibleAssistantMessages = result.messages.filter((message) => message.role === 'assistant' && message.hidden !== true && (message.content.trim() || message.reasoning_content?.trim()));
    expect(visibleAssistantMessages).toHaveLength(1);
    expect(visibleAssistantMessages[0]?.content).toBe('Visible answer.');
  });

  it('stops when streamed reasoning repeats the same planning pattern', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 10 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const planningBlock = [
      'Has detailed reformat planning plan',
      'Has detailed reindex planning plan',
      'Has detailed recompile planning plan',
      'Has detailed rebuild planning plan',
      'Has detailed repackage planning plan',
      'Has detailed redistribute planning plan',
      'Has detailed reinstall planning plan',
      'Has detailed reconfigure planning plan',
      'Has detailed reinitialize planning plan'
    ];
    let emittedReasoningLines = 0;
    const client: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      },
      async streamComplete(_request: LlmRequest, onDelta: (delta: { reasoning_content?: string; content?: string }) => void): Promise<LlmCompletion> {
        for (let repeat = 0; repeat < 20; repeat += 1) {
          for (const line of planningBlock) {
            emittedReasoningLines += 1;
            onDelta({ reasoning_content: `${line}\n` });
          }
        }
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const done: string[] = [];
    const result = await loop.run({
      userInput: 'loop in planning',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'done') done.push(event.content ?? '');
      }
    });

    expect(emittedReasoningLines).toBe(planningBlock.length * 5);
    expect(result.iterations).toBe(1);
    expect(result.finalResponse).toContain('Stopped because the model reasoning repeated the same planning pattern 5 times.');
    expect(result.finalResponse).toContain('Has detailed reformat planning plan');
    expect(done).toEqual([result.finalResponse]);
    expect(sessions.read(result.sessionId)?.messages.at(-1)?.content).toBe(result.finalResponse);
  });

  it('stops when streamed reasoning repeats with escaped newline text', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 10 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const planningBlock = [
      'Let me start with the plan:',
      '**A section structure:**',
      'Now let me start drafting.',
      'I will write the content in a structured way.',
      'OK, I am going to stop overthinking and just start drafting.'
    ];
    let emittedBlocks = 0;
    const client: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      },
      async streamComplete(_request: LlmRequest, onDelta: (delta: { reasoning_content?: string; content?: string }) => void): Promise<LlmCompletion> {
        for (let repeat = 0; repeat < 20; repeat += 1) {
          emittedBlocks += 1;
          onDelta({ reasoning_content: `${planningBlock.join('\\n')}\\n` });
        }
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({
      userInput: 'loop with escaped newline planning',
      onMessageDelta: () => undefined
    });

    expect(emittedBlocks).toBe(5);
    expect(result.iterations).toBe(1);
    expect(result.finalResponse).toContain('Stopped because the model reasoning repeated the same planning pattern 5 times.');
    expect(result.finalResponse).toContain('Let me start with the plan:');
  });

  it('stops when streamed reasoning grows too long without visible progress', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 10 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    let emittedChars = 0;
    const client: LlmClient = {
      async complete(): Promise<LlmCompletion> {
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      },
      async streamComplete(_request: LlmRequest, onDelta: (delta: { reasoning_content?: string; content?: string }) => void): Promise<LlmCompletion> {
        for (let index = 0; index < 1000; index += 1) {
          const chunk = `Considering next planning option ${index} with a slightly different phrase. `;
          emittedChars += chunk.length;
          onDelta({ reasoning_content: chunk });
        }
        return { message: { role: 'assistant', content: 'should not finish normally' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({
      userInput: 'loop with varied planning',
      onMessageDelta: () => undefined
    });

    expect(emittedChars).toBeGreaterThanOrEqual(12000);
    expect(result.iterations).toBe(1);
    expect(result.finalResponse).toContain('Stopped because the model produced a long reasoning stream without any visible answer or tool call.');
    expect(sessions.read(result.sessionId)?.messages.at(-1)?.content).toBe(result.finalResponse);
  });

  it('returns log probabilities from the final completion when requested', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const log_probs = { content: [{ token: 'Done', logprob: -0.1 }] };
    let capturedRequest: LlmRequest | undefined;
    const mock: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        capturedRequest = request;
        return {
          message: {
            role: 'assistant',
            content: 'Done.'
          },
          log_probs
        };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'hello', logProbs: true, topLogProbs: 2, stream: false });

    expect(result.finalResponse).toBe('Done.');
    expect(result.log_probs).toEqual(log_probs);
    expect(capturedRequest?.logProbs).toBe(true);
    expect(capturedRequest?.topLogProbs).toBe(2);
  });

  it('persists user and streamed assistant messages before the run finishes', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: 'Streamed answer.',
          reasoning_content: 'Brief reasoning.'
        }
      }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const snapshots: string[][] = [];
    const result = await loop.run({
      userInput: 'hello',
      onMessageDelta: () => undefined,
      onSessionUpdated: (session) => {
        snapshots.push(session.messages.map((message) => `${message.role}:${message.content}`));
      }
    });

    expect(snapshots.some((items) => items.includes('user:hello') && !items.includes('assistant:Streamed answer.'))).toBe(true);
    expect(snapshots.some((items) => items.includes('assistant:Streamed answer.'))).toBe(true);

    const rawSession = JSON.parse(readFileSync(join(env.home, 'sessions', `${result.sessionId}.json`), 'utf8')) as Record<string, unknown>;
    const rawMessages = Array.isArray(rawSession.messages) ? rawSession.messages : [];
    expect(rawMessages.some((message) => (
      message &&
      typeof message === 'object' &&
      Object.prototype.hasOwnProperty.call(message, 'reasoning_parts')
    ))).toBe(false);
  });

  it('replaces streamed reasoning with the current iteration instead of accumulating tool-call reasoning', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 4 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({ getConfig: () => cfg, memoryStore: memory, sessionStore: sessions, skillManager: skills })) registry.register(tool);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: 'I will inspect first.',
          reasoning_content: 'Need to inspect the workspace.\nNeed to write the file.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'file_write', arguments: JSON.stringify({ path: 'answer.txt', content: '42' }) }
          }]
        }
      },
      {
        message: {
          role: 'assistant',
          content: 'Done.',
          reasoning_content: 'Ready to answer.'
        }
      }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const messageIds: string[] = [];
    const deltas: AgentMessageDeltaStream[] = [];
    const result = await loop.run({
      userInput: 'write a file',
      onMessageDelta: (_sessionId, event) => {
        messageIds.push(event.messageId);
        deltas.push(event);
      }
    });

    expect(new Set(messageIds).size).toBe(1);
    expect(deltas.some((event) => event.type === 'reasoning_content' && event.content_parts?.[0] === 'I will inspect first.')).toBe(true);
    expect(deltas.every((event) => (event.reasoning_content?.length ?? 0) <= 3000)).toBe(true);
    const doneDelta = deltas.at(-1);
    expect(doneDelta?.type).toBe('done');
    expect(doneDelta?.content).toBe('Done.');
    expect(doneDelta?.reasoning_parts).toEqual(['Ready to answer.']);
    expect(doneDelta?.content_parts).toEqual(['I will inspect first.']);
    const finalAssistant = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content === 'Done.');
    expect(finalAssistant?.reasoning_content).toBe('Ready to answer.');
    expect(finalAssistant?.reasoning_parts).toEqual(['Ready to answer.']);
    expect(finalAssistant?.content_parts).toEqual(['I will inspect first.']);
  });

  it('stops when the same tool call returns the same result repeatedly', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 10 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    registry.register({
      safety: 'read-only',
      definition: {
        type: 'function',
        function: {
          name: 'repeat_probe',
          description: 'Returns the same result for repeat-loop tests.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' }
            }
          }
        }
      },
      async execute() {
        return { ok: false, content: 'fetch failed' };
      }
    });
    const repeatedCompletion = () => ({
      message: {
        role: 'assistant' as const,
        content: 'Trying again.',
        tool_calls: [{
          id: createMockToolCallId(),
          type: 'function' as const,
          function: { name: 'repeat_probe', arguments: JSON.stringify({ path: 'token-hub-v2.png' }) }
        }]
      }
    });
    const mock = new MockLlmClient(Array.from({ length: 10 }, repeatedCompletion));
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const result = await loop.run({ userInput: 'keep probing' });

    expect(result.toolEvents).toHaveLength(3);
    expect(result.iterations).toBe(3);
    expect(result.finalResponse).toContain('Stopped because the same tool call repeated 3 times with the same result.');
    expect(result.finalResponse).toContain('Tool: repeat_probe');
    expect(result.finalResponse).toContain('Result: fail - fetch failed');
    expect(result.finalResponse).not.toContain('Reached iteration limit');
    const storedSession = sessions.read(result.sessionId);
    expect(storedSession?.messages.at(-1)?.content).toBe(result.finalResponse);
  });

  it('returns a user-facing handoff when the iteration limit is reached', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 2 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const registry = new ToolRegistry();
    registry.register({
      safety: 'read-only',
      definition: {
        type: 'function',
        function: {
          name: 'step_probe',
          description: 'Probe a step.',
          parameters: { type: 'object', properties: {} }
        }
      },
      async execute() {
        return { ok: true, content: 'still working' };
      }
    });
    const repeatedCompletion = () => ({
      message: {
        role: 'assistant' as const,
        content: 'Continuing.',
        tool_calls: [{
          id: createMockToolCallId(),
          type: 'function' as const,
          function: { name: 'step_probe', arguments: '{}' }
        }]
      }
    });
    const mock = new MockLlmClient(Array.from({ length: 5 }, repeatedCompletion));
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: registry,
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        void memory.syncSessionMemory(session);
      }
    });

    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'keep going',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'done') deltas.push(event.content ?? '');
      }
    });

    expect(result.finalResponse).toContain('本轮已达到最大模型迭代轮次（2）');
    expect(result.finalResponse).toContain('本轮实际工具调用次数：2。');
    expect(result.finalResponse).toContain('最近完成的操作');
    expect(result.finalResponse).toContain('step_probe：成功');
    expect(result.finalResponse).not.toContain('Reached iteration limit');
    expect(result.finalResponse).not.toContain('Last tool events');
    expect(deltas.at(-1)).toBe(result.finalResponse);
    const storedSession = sessions.read(result.sessionId);
    expect(storedSession?.messages.at(-1)?.content).toBe(result.finalResponse);
  });

  it('does not report an iteration limit when the model returns an empty final message early', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 1 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const mock = new MockLlmClient([
      {
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'I have enough context but returned no visible answer.'
        }
      }
    ]);
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => mock,
      toolRegistry: new ToolRegistry(),
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (record) => {
        void memory.syncSessionMemory(record);
      }
    });

    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'finish with nothing',
      onMessageDelta: (_sessionId, event) => {
        if (event.type === 'done') deltas.push(event.content ?? '');
      }
    });

    expect(result.iterations).toBe(1);
    expect(result.finalResponse).toContain('模型本轮返回了空回复');
    expect(result.finalResponse).not.toContain('最大模型迭代轮次');
    expect(result.finalResponse).not.toContain('最大执行步数');
    expect(deltas).toEqual([result.finalResponse]);
    expect(result.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:finish with nothing',
      `assistant:${result.finalResponse}`
    ]);
  });

  it('does not send prior iteration-limit handoff messages back to the model', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), maxIterations: 2 };
    ensureDir(cfg.workspaceDir);
    const memory = new MemoryStore(env.home);
    const personalKnowledgeBase = new PersonalKnowledgeBase(env.home);
    const skills = new SkillManager(env.home);
    const sessions = new SessionStore(env.home);
    const session = sessions.create('handoff history');
    sessions.appendMessages(session.id, [
      {
        role: 'assistant',
        content: '本轮已达到最大执行步数（200），我先停在这里，避免继续消耗无效步骤。\n\n最近完成的操作：\n- terminal：成功',
        createdAt: new Date().toISOString()
      }
    ]);
    let capturedRequest: LlmRequest | undefined;
    const client: LlmClient = {
      async complete(request: LlmRequest): Promise<LlmCompletion> {
        capturedRequest = request;
        return { message: { role: 'assistant', content: 'Done.' } };
      }
    };
    const loop = new AgentLoop({
      getConfig: () => cfg,
      createClient: () => client,
      toolRegistry: new ToolRegistry(),
      sessions,
      promptBuilder: new PromptBuilder(memory, skills, personalKnowledgeBase),
      prepareExecution: () => ({ mode: 'workspace', workspaceDir: cfg.workspaceDir }),
      beginDeferredMemory: (sessionId) => memory.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        void memory.commitDeferredSession(sessionId);
      },
      discardDeferredMemory: (sessionId) => memory.discardDeferredSession(sessionId),
      syncSessionMemory: (record) => {
        void memory.syncSessionMemory(record);
      }
    });

    const result = await loop.run({ sessionId: session.id, userInput: 'continue', stream: false });

    expect(result.finalResponse).toBe('Done.');
    expect(result.iterations).toBe(1);
    expect(capturedRequest?.messages.some((message) => message.content.includes('本轮已达到最大执行步数'))).toBe(false);
    expect(capturedRequest?.messages.some((message) => message.content.includes('本轮已达到最大模型迭代轮次'))).toBe(false);
    expect(sessions.read(session.id)?.messages.some((message) => message.content.includes('本轮已达到最大执行步数'))).toBe(true);
  });
});

let mockToolCallCounter = 0;

function createMockToolCallId(): string {
  mockToolCallCounter += 1;
  return `call_repeat_${mockToolCallCounter}`;
}
