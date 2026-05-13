import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { AgentLoop } from '../src/main/agent/agentLoop.js';
import { MockLlmClient } from '../src/main/agent/llmClient.js';
import { PromptBuilder } from '../src/main/agent/promptBuilder.js';
import { PersonalKnowledgeBase } from '../src/main/knowledge/personalKnowledgeBase.js';
import { MemoryStore } from '../src/main/storage/memoryStore.js';
import { SessionStore } from '../src/main/storage/sessionStore.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { defaultConfig, ensureDir } from '../src/main/storage/pathUtils.js';
import { ToolRegistry } from '../src/main/tools/toolRegistry.js';
import { createBuiltinTools } from '../src/main/tools/builtinTools.js';
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

  it('keeps tool-call reasoning on the same streamed assistant bubble as the final answer', async () => {
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
          reasoning_content: 'Need to inspect the workspace.\nNeed to write the file.',
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

    const messageIds: string[] = [];
    const deltas: string[] = [];
    const result = await loop.run({
      userInput: 'write a file',
      onMessageDelta: (_sessionId, event) => {
        messageIds.push(event.messageId);
        if (event.type === 'reasoning_content') deltas.push(`r:${event.reasoning_parts?.join('|')}`);
        if (event.type === 'content') deltas.push(`c:${event.content}:${event.reasoning_parts?.join('|')}`);
        if (event.type === 'done') deltas.push(`done:${event.content}:${event.reasoning_parts?.join('|')}`);
      }
    });

    expect(new Set(messageIds).size).toBe(1);
    expect(deltas).toEqual([
      'r:Need to inspect the workspace.|Need to write the file.',
      'c:Done.:Need to inspect the workspace.|Need to write the file.',
      'done:Done.:Need to inspect the workspace.|Need to write the file.'
    ]);
    const finalAssistant = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content === 'Done.');
    expect(finalAssistant?.reasoning_content).toBe('Need to inspect the workspace.\nNeed to write the file.');
    expect(finalAssistant?.reasoning_parts).toEqual(['Need to inspect the workspace.', 'Need to write the file.']);
  });
});
