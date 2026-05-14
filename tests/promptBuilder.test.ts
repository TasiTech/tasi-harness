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
    expect(prompt).toContain('If SKILL.md lists references/*.md files, load the references relevant to the planned provider/tool path');
    expect(prompt).toContain('Prioritize reading the most relevant provider reference first');
    expect(prompt).toContain('If the only tool you have called for a skill-driven request is skill_view');
    expect(prompt).toContain('prefer an assistant turn with tool calls immediately after reading the skill');
    expect(prompt).toContain('the next substantive action must be one of');
    expect(prompt).toContain('A final answer that skips required skill steps is incorrect');
    expect(prompt).toContain('Before producing a final answer for a skill-driven request');
    expect(prompt).toContain('return a degraded answer rather than presenting an unverified answer as complete');
    expect(prompt).toContain('2025 年春节假期接待 16.8 万人次[1](https://example.com/news)。');
    expect(prompt).toContain('inline citations near claims are required for web-backed answers');
    expect(prompt).toContain('Do not use named Markdown links such as `[Source Title](https://example.com)` as evidence citations');
    expect(prompt).toContain('Convert every evidence URL to a numbered citation like `[1](https://example.com)`');
    expect(prompt).toContain('Do not output source-only named links without numeric labels');
    expect(prompt).toContain('Preserve source traceability from tool use to final answer');
    expect(prompt).toContain('Important data and important viewpoints taken from retrieved/opened content must include numbered citation links');
    expect(prompt).toContain('study conclusions, policy positions, quoted or paraphrased expert views');
    expect(prompt).toContain('For data-heavy answers, cite every important number or live-data item near the value');
    expect(prompt).toContain('In tables, put the citation in the same row or source column');
    expect(prompt).toContain('cite article-level or official-page URLs for timelines, quotes, official responses');
    expect(prompt).toContain('Do not replace opened article/source URLs with a generic search page');
    expect(prompt).toContain('add a compact Sources/来源 section');
    expect(prompt).toContain('Do not write plain `[1] Source title`');
    expect(prompt).toContain('Keep evidence links separate from action links');
    expect(prompt).toContain('label it as [estimated], [inferred], or [unverified]');
    expect(prompt).toContain('URL-encode spaces and unsafe characters');
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

  it('includes up to ten uploaded session documents in the system prompt', async () => {
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

    const prompt = await builder.build(defaultConfig(), { sessionId, userInput: 'summarize uploaded files' });

    expect(prompt).toContain('a.xml');
    expect(prompt).toContain('b.xml');
    expect(prompt).toContain('c.xml');
    expect(prompt).toContain('d.xml');
    expect(prompt).toContain('e.xml');
    expect(prompt).toContain('f.xml');
    expect(prompt).toContain('g.xml');
    expect(prompt).toContain('h.xml');
    expect(prompt).toContain('i.xml');
    expect(prompt).toContain('j.xml');
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

    const prompt = await builder.build({ ...defaultConfig(), sessionDocumentMaxDocs: 2 }, { sessionId, userInput: 'summarize uploaded files' });

    expect(prompt).toContain('c.xml');
    expect(prompt).toContain('b.xml');
    expect(prompt).not.toContain('a.xml');
    expect(prompt).toContain('Settings > Execution > Session docs max');
  });
});
