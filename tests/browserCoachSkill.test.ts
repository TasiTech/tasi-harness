import { describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/main/agent/llmClient.js';
import type { BrowserCoachRecording } from '../src/shared/types.js';
import type { LlmRequest } from '../src/shared/types.js';
import {
  buildBrowserCoachSkillContent,
  buildBrowserCoachSkillContentWithModel,
  browserCoachEventToInstruction,
  normalizeBrowserCoachSkillRequest
} from '../src/main/browser/browserCoachSkill.js';

function sampleRecording(): BrowserCoachRecording {
  return {
    id: 'rec_1',
    startUrl: 'https://example.com/login?channel=web&token=secret-token',
    startedAt: '2026-05-06T00:00:00.000Z',
    active: false,
    events: [
      {
        id: 'evt_1',
        index: 1,
        type: 'navigation',
        url: 'https://example.com/login?channel=web&token=secret-token',
        title: 'Login',
        createdAt: '2026-05-06T00:00:01.000Z'
      },
      {
        id: 'evt_2',
        index: 2,
        type: 'input',
        url: 'https://example.com/login?channel=web&token=secret-token',
        title: 'Login',
        selector: 'input[name="q"]',
        tag: 'input',
        name: 'Search',
        value: 'invoice 123',
        createdAt: '2026-05-06T00:00:02.000Z'
      },
      {
        id: 'evt_3',
        index: 3,
        type: 'click',
        url: 'https://example.com/results?channel=web&q=invoice%20123',
        title: 'Login',
        selector: 'button[type="submit"]',
        tag: 'button',
        text: 'Search',
        createdAt: '2026-05-06T00:00:03.000Z'
      }
    ]
  };
}

describe('browser coach skill generation', () => {
  it('renders browser events as reusable instructions', () => {
    expect(browserCoachEventToInstruction(sampleRecording().events[1])).toContain('Replace private or task-specific values');
    expect(browserCoachEventToInstruction(sampleRecording().events[2])).toContain('Click');
  });

  it('builds a valid SKILL.md body with recording reference', () => {
    const content = buildBrowserCoachSkillContent(
      {
        name: 'Example Search Coach',
        category: 'browser',
        description: 'Repeat example.com search workflow.',
        userGuidance: 'Prefer semantic fields and keep the workflow in Chinese.'
      },
      sampleRecording()
    );

    expect(content).toContain('name: example-search-coach');
    expect(content).toContain('category: browser');
    expect(content).toContain('Repeat example.com search workflow.');
    expect(content).toContain('input[name="q"]');
    expect(content).toContain('Recorded Links And Parameters');
    expect(content).toContain('channel=web');
    expect(content).toContain('token=[redacted]');
    expect(content).toContain('Search = `invoice 123`');
    expect(content).toContain('Browser Reliability Rules');
    expect(content).toContain('Do not guess provider result URLs');
    expect(content).toContain('User Guidance');
    expect(content).toContain('Prefer semantic fields and keep the workflow in Chinese.');
    expect(content).toContain('./references/recording.json');
  });

  it('uses a safe browser workflow name when the requested name has no ASCII slug', () => {
    const normalized = normalizeBrowserCoachSkillRequest(
      { name: '携程旅行', category: '浏览器', description: 'Repeat the recorded workflow.' },
      sampleRecording()
    );
    const content = buildBrowserCoachSkillContent(
      { name: '携程旅行', category: '浏览器', description: 'Repeat the recorded workflow.' },
      sampleRecording()
    );

    expect(normalized.name).toBe('example.com-browser-workflow');
    expect(normalized.category).toBe('browser');
    expect(normalized.displayName).toBe('携程旅行');
    expect(content).toContain('name: example.com-browser-workflow');
    expect(content).toContain('display_name: 携程旅行');
    expect(content).toContain('category: browser');
  });

  it('uses the built-in skill creator guide when generating with a model', async () => {
    let capturedRequest: LlmRequest | undefined;
    const client: LlmClient = {
      async complete(request) {
        capturedRequest = request;
        return {
          message: {
            role: 'assistant',
            content: [
              '---',
              'name: wrong-name',
              'description: Use when the user asks to search example.com invoices and extract the result record.',
              'category: wrong-category',
              '---',
              '',
              '# Example invoice search',
              '',
              '## Workflow',
              '',
              '1. Open the target search page and inspect it with `browser_snapshot`.',
              '2. Locate the invoice search field by label or placeholder and enter the user-provided invoice id.',
              '',
              '## Inputs/Variables',
              '',
              '- `invoice_id`: Invoice identifier supplied by the user.',
              '',
              '## References',
              '',
              '- Raw browser recording: `./references/recording.json`'
            ].join('\n')
          }
        };
      }
    };

    const content = await buildBrowserCoachSkillContentWithModel(
      {
        name: 'Example Search Coach',
        category: 'browser',
        description: 'Repeat example.com search workflow.',
        userGuidance: 'Always ask the user for the invoice id before searching.'
      },
      sampleRecording(),
      client,
      'SKILL CREATOR GUIDE\nCore Principles\nUse concise reusable workflows.'
    );

    const prompt = capturedRequest?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('Built-in skill-creator guidance to follow');
    expect(prompt).toContain('SKILL CREATOR GUIDE');
    expect(prompt).toContain('prevent the my-travel failure pattern');
    expect(prompt).toContain('mark live-data failures as degraded');
    expect(prompt).toContain('Recorded Links And Parameters');
    expect(prompt).toContain('User-provided guidance to preserve and follow');
    expect(prompt).toContain('Always ask the user for the invoice id before searching.');
    expect(prompt).toContain('linksAndParams');
    expect(prompt).toContain('"channel"');
    expect(prompt).toContain('Recorded workflow summary JSON');
    expect(content).toContain('name: example-search-coach');
    expect(content).toContain('category: browser');
    expect(content).toContain('Inputs/Variables');
    expect(content).toContain('Recorded Links And Parameters');
    expect(content).toContain('channel=web');
    expect(content).toContain('Browser Reliability Rules');
    expect(content).toContain('User Guidance');
    expect(content).toContain('Always ask the user for the invoice id before searching.');
    expect(content).toContain('Do not guess provider result URLs');
    expect(content).toContain('./references/recording.json');
  });

  it('falls back to deterministic skill content when model output is invalid', async () => {
    const client: LlmClient = {
      async complete() {
        return { message: { role: 'assistant', content: 'This is not a SKILL.md file.' } };
      }
    };

    const content = await buildBrowserCoachSkillContentWithModel(
      { name: 'Example Search Coach', category: 'browser', description: 'Repeat example.com search workflow.' },
      sampleRecording(),
      client,
      'SKILL CREATOR GUIDE'
    );

    expect(content).toContain('name: example-search-coach');
    expect(content).toContain('Browser Execution Rules');
    expect(content).toContain('input[name="q"]');
    expect(content).toContain('./references/recording.json');
  });
});
