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
  });
});
