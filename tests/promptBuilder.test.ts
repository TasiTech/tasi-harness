import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/main/storage/memoryStore.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { PersonalKnowledgeBase } from '../src/main/knowledge/personalKnowledgeBase.js';
import { SessionDocumentContextStore } from '../src/main/knowledge/sessionDocumentContextStore.js';
import { PromptBuilder } from '../src/main/agent/promptBuilder.js';
import { defaultConfig } from '../src/main/storage/pathUtils.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('PromptBuilder', () => {
  it('describes external browser bridge fallback strategy in external mode', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home),
      () =>
        '- External browser bridge snapshot: engine=auto; cdpEndpoint=http://127.0.0.1:9222; strategy=cdp -> shell.openExternal fallback.'
    );

    const prompt = await builder.build({ ...defaultConfig(), browserMode: 'external' }, { userInput: 'open example.com' });

    expect(prompt).toContain('Browser mode is external.');
    expect(prompt).toContain('In external browser mode, use browser_* tools as the default workflow');
    expect(prompt).toContain('Browser close policy');
    expect(prompt).toContain('engine=auto');
    expect(prompt).toContain('shell.openExternal fallback');
  });

  it('separates stable system instructions from volatile runtime context', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home)
    );

    const prompt = await builder.buildForMessages(defaultConfig(), { sessionId: 'session_cache', userInput: 'remember this' });

    expect(prompt.systemPrompt).toContain('## Operating model');
    expect(prompt.systemPrompt).toContain('## Installed skills index');
    expect(prompt.systemPrompt).toContain('Current session id: session_cache');
    expect(prompt.systemPrompt).not.toContain('Current timestamp:');
    expect(prompt.systemPrompt).not.toContain('## Persistent memory snapshot');
    expect(prompt.systemPrompt).not.toContain('## Session document XML snapshot');
    expect(prompt.runtimeContext).toContain('Current timestamp:');
    expect(prompt.runtimeContext).toContain('## Persistent memory snapshot');
    expect(prompt.runtimeContext).toContain('## Session document XML snapshot');
    expect(prompt.displayPrompt).toContain(prompt.systemPrompt);
    expect(prompt.displayPrompt).toContain(prompt.runtimeContext);
  });

  it('keeps skill, browser, and citation rules compact but enforceable', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home)
    );

    const prompt = await builder.build(defaultConfig(), { userInput: 'plan a trip itinerary' });

    expect(prompt).toContain('mandatory execution workflow');
    expect(prompt).toContain('your first substantive step should be to call skill_view');
    expect(prompt).toContain('routing rules, references, tool requirements, and completion criteria');
    expect(prompt).toContain('skill_view loads workflow guidance only');
    expect(prompt).toContain('clearly return a blocked/degraded answer');
    expect(prompt).toContain('Keep internal reasoning compact and non-repetitive');
    expect(prompt).toContain('Progress rule');
    expect(prompt).toContain('numbered inline Markdown links like [1](https://example.com)');
    expect(prompt).toContain('Important live or retrieved facts need citations near the value');
  });

  it('can disable memory and skills for a single run', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home)
    );

    const prompt = await builder.build(defaultConfig(), { userInput: 'hello', useMemory: false, useSkills: false });

    expect(prompt).toContain('Persistent memory is disabled for this run');
    expect(prompt).toContain('(memory disabled for this run)');
    expect(prompt).toContain('Skill execution is disabled for this run');
    expect(prompt).toContain('Skills disabled for this run.');
    expect(prompt).not.toContain('your first substantive step should be to call skill_view');
  });

  it('uses explicit memory domains when provided', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home)
    );

    const prompt = await builder.build(defaultConfig(), { userInput: 'plan a trip', memoryDomains: ['work', 'travel'] });

    expect(prompt).toContain('Requested memory domains: work, travel');
    expect(prompt).toContain('context: domain=work');
    expect(prompt).toContain('context: domain=travel');
  });

  it('injects uploaded session document XML into runtime context', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const sessionDocs = new SessionDocumentContextStore(env.home);
    await sessionDocs.addDocument({
      sessionId: 'session_xml',
      filename: 'source.xml',
      contentBase64: Buffer.from('<root><item>alpha</item></root>', 'utf8').toString('base64')
    });
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home),
      undefined,
      sessionDocs
    );

    const prompt = await builder.buildForMessages(defaultConfig(), { sessionId: 'session_xml', userInput: 'summarize this document' });

    expect(prompt.systemPrompt).not.toContain('<session_document');
    expect(prompt.runtimeContext).toContain('Session document XML snapshot');
    expect(prompt.runtimeContext).toContain('source.xml');
    expect(prompt.runtimeContext).toContain('<session_document');
  });

  it('includes up to ten uploaded session documents in runtime context', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const sessionDocs = new SessionDocumentContextStore(env.home);
    const sessionId = 'session_ten_docs';
    for (const name of ['a.xml', 'b.xml', 'c.xml', 'd.xml', 'e.xml', 'f.xml', 'g.xml', 'h.xml', 'i.xml', 'j.xml']) {
      await sessionDocs.addDocument({
        sessionId,
        filename: name,
        contentBase64: Buffer.from(`<root><file>${name}</file></root>`, 'utf8').toString('base64')
      });
    }
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home),
      undefined,
      sessionDocs
    );

    const prompt = await builder.buildForMessages(defaultConfig(), { sessionId, userInput: 'summarize uploaded files' });

    for (const name of ['a.xml', 'b.xml', 'c.xml', 'd.xml', 'e.xml', 'f.xml', 'g.xml', 'h.xml', 'i.xml', 'j.xml']) {
      expect(prompt.runtimeContext).toContain(name);
    }
  });

  it('respects configured session docs max from execution settings', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const sessionDocs = new SessionDocumentContextStore(env.home);
    const sessionId = 'session_configured_limit';
    for (const name of ['a.xml', 'b.xml', 'c.xml']) {
      await sessionDocs.addDocument({
        sessionId,
        filename: name,
        contentBase64: Buffer.from(`<root><file>${name}</file></root>`, 'utf8').toString('base64')
      });
    }
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home),
      undefined,
      sessionDocs
    );

    const prompt = await builder.buildForMessages({ ...defaultConfig(), sessionDocumentMaxDocs: 2 }, { sessionId, userInput: 'summarize uploaded files' });

    expect(prompt.runtimeContext).toContain('c.xml');
    expect(prompt.runtimeContext).toContain('b.xml');
    expect(prompt.runtimeContext).not.toContain('a.xml');
    expect(prompt.runtimeContext).toContain('Settings > Execution > Session docs max');
  });
});
