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
    expect(prompt).toContain('engine=auto');
    expect(prompt).toContain('shell.openExternal fallback');
  });

  it('tells the agent to follow relevant skill workflows instead of skipping to a self-generated answer', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const builder = new PromptBuilder(
      new MemoryStore(env.home),
      new SkillManager(env.home),
      new PersonalKnowledgeBase(env.home)
    );

    const prompt = await builder.build(defaultConfig(), { userInput: 'plan a trip itinerary' });

    expect(prompt).toContain('treat that skill as an execution workflow, not optional background reading');
    expect(prompt).toContain('enter skill execution mode and stay in that mode');
    expect(prompt).toContain('your first substantive step should be to call skill_view for that skill');
    expect(prompt).toContain('follow its instructions, routing rules, and completion criteria');
    expect(prompt).toContain('Reading skill_view only loads instructions; it does not count as completing the skill');
    expect(prompt).toContain('The content returned by skill_view is workflow guidance, not evidence');
    expect(prompt).toContain('do not skip straight to a general-knowledge answer');
    expect(prompt).toContain('If the only tool you have called for a skill-driven request is skill_view');
    expect(prompt).toContain('prefer an assistant turn with tool calls immediately after reading the skill');
    expect(prompt).toContain('the next substantive action must be one of');
    expect(prompt).toContain('A final answer that skips required skill steps is incorrect');
    expect(prompt).toContain('Before producing a final answer for a skill-driven request');
    expect(prompt).toContain('return a degraded answer rather than presenting an unverified answer as complete');
  });

  it('injects uploaded session document XML into the system prompt', async () => {
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

    const prompt = await builder.build(defaultConfig(), { sessionId: 'session_xml', userInput: 'summarize this document' });

    expect(prompt).toContain('Session document XML snapshot');
    expect(prompt).toContain('source.xml');
    expect(prompt).toContain('<session_document');
  });
});
