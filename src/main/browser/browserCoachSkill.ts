import type { BrowserCoachGenerateSkillRequest, BrowserCoachRecordedEvent, BrowserCoachRecording } from '../../shared/types.js';
import { slugifyName } from '../storage/pathUtils.js';
import type { LlmClient } from '../agent/llmClient.js';

function clip(input: string | undefined, max = 120): string {
  const text = (input ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function uniqueHosts(recording: BrowserCoachRecording): string[] {
  const hosts = new Set<string>();
  for (const event of recording.events) {
    try {
      const host = new URL(event.url).hostname.replace(/^www\./, '');
      if (host) hosts.add(host);
    } catch {
      // Ignore non-URL pages such as about:blank.
    }
  }
  return [...hosts].slice(0, 6);
}

function eventTargetLabel(event: BrowserCoachRecordedEvent): string {
  const primary = event.name
    ? `"${clip(event.name, 80)}"`
    : event.text
      ? `text "${clip(event.text, 80)}"`
      : event.tag
        ? `<${event.tag.toLowerCase()}>`
        : 'the current element';
  return event.selector ? `${primary} (selector hint: \`${event.selector}\`)` : primary;
}

export function browserCoachEventToInstruction(event: BrowserCoachRecordedEvent): string {
  if (event.type === 'navigation') return `Open or navigate to ${event.url}${event.title ? ` (${clip(event.title, 80)})` : ''}.`;
  if (event.type === 'click') return `Click ${eventTargetLabel(event)}.`;
  if (event.type === 'input' || event.type === 'change') {
    const value = event.value ? ` with value \`${clip(event.value, 80)}\`` : '';
    return `Fill ${eventTargetLabel(event)}${value}. Replace private or task-specific values with user-provided variables.`;
  }
  if (event.type === 'submit') return `Submit the form near ${eventTargetLabel(event)}.`;
  if (event.type === 'keydown') return `Press ${event.key ?? 'the recorded key'} on ${eventTargetLabel(event)}.`;
  if (event.type === 'window_closed') return 'Finish the browser workflow.';
  return `Perform recorded browser action ${event.type}.`;
}

function relevantEvents(recording: BrowserCoachRecording): BrowserCoachRecordedEvent[] {
  const out: BrowserCoachRecordedEvent[] = [];
  let lastKey = '';
  for (const event of recording.events) {
    if (event.type === 'input' && event.value === '[masked]') continue;
    const key = [event.type, event.url, event.selector, event.name, event.text, event.value, event.key].join('|');
    if (key === lastKey) continue;
    lastKey = key;
    out.push(event);
    if (out.length >= 80) break;
  }
  return out;
}

export function buildBrowserCoachSkillContent(req: BrowserCoachGenerateSkillRequest, recording: BrowserCoachRecording): string {
  const name = slugifyName(req.name);
  const category = slugifyName(req.category || 'browser');
  const hosts = uniqueHosts(recording);
  const description = req.description?.trim() ||
    `Use when the user asks to repeat the recorded browser workflow${hosts.length ? ` for ${hosts.join(', ')}` : ''}.`;
  const steps = relevantEvents(recording)
    .map((event, index) => `${index + 1}. ${browserCoachEventToInstruction(event)}`)
    .join('\n');
  const firstUrl = recording.events.find((event) => event.url && event.url !== 'about:blank')?.url || recording.startUrl;

  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    `category: ${category}`,
    '---',
    '',
    `# ${name}`,
    '',
    '## Workflow',
    '',
    steps || '1. Open the target site and inspect the page with `browser_snapshot`.',
    '',
    '## Browser Execution Rules',
    '',
    `- Start from ${firstUrl || 'the recorded target URL'} unless the user gives a different URL.`,
    '- Prefer `browser_snapshot` before acting, then choose elements by accessible name, visible text, label, placeholder, or stable selector.',
    '- Treat recorded refs, CSS paths, and exact values as hints. If the page changed, locate the matching field or button semantically.',
    '- Replace private values, account-specific values, dates, search terms, order IDs, and filters with values supplied by the user.',
    '- After the workflow reaches the result page, use `browser_snapshot`, `browser_extract`, or `browser_find` to gather data and cite the current page URL.',
    '- If login, captcha, MFA, or permission prompts appear, pause and ask the user to complete them in the browser.',
    '',
    '## References',
    '',
    '- Raw browser recording: `./references/recording.json`'
  ].join('\n');
}

function recordingForPrompt(recording: BrowserCoachRecording): unknown {
  return {
    startUrl: recording.startUrl,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    hosts: uniqueHosts(recording),
    eventCount: recording.events.length,
    events: relevantEvents(recording).map((event) => ({
      index: event.index,
      type: event.type,
      url: event.url,
      title: event.title,
      target: {
        selector: event.selector,
        tag: event.tag,
        role: event.role,
        name: event.name,
        text: event.text
      },
      valueHint: event.value ? clip(event.value, 80) : undefined,
      key: event.key
    }))
  };
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function ensureGeneratedSkillFrontmatter(content: string, req: BrowserCoachGenerateSkillRequest, fallbackDescription: string): string {
  const name = slugifyName(req.name);
  const category = slugifyName(req.category || 'browser');
  const cleaned = stripCodeFence(content);
  const body = cleaned.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() || buildBrowserCoachSkillContent(req, {
    id: '',
    startUrl: '',
    startedAt: '',
    active: false,
    events: []
  }).replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
  const frontmatter = cleaned.match(/^---\n([\s\S]*?)\n---\n?/);
  const kept = (frontmatter?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(name|category|description)\s*:/i.test(line));
  const description = frontmatter?.[1].match(/^description\s*:\s*(.+)$/im)?.[1]?.trim() || req.description?.trim() || fallbackDescription;
  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    `category: ${category}`,
    ...kept,
    '---',
    '',
    body,
    ''
  ].join('\n');
}

export async function buildBrowserCoachSkillContentWithModel(
  req: BrowserCoachGenerateSkillRequest,
  recording: BrowserCoachRecording,
  client: LlmClient,
  skillCreatorGuide?: string
): Promise<string> {
  const name = slugifyName(req.name);
  const category = slugifyName(req.category || 'browser');
  const hosts = uniqueHosts(recording);
  const fallbackDescription = req.description?.trim() ||
    `Use when the user asks to repeat the recorded browser workflow${hosts.length ? ` for ${hosts.join(', ')}` : ''}.`;
  const fallback = buildBrowserCoachSkillContent(req, recording);
  try {
    const completion = await client.complete({
      temperature: 0.2,
      maxTokens: 2600,
      messages: [
        {
          role: 'system',
          content: [
            'You are Tasi Harness built-in Skill Creator, following Codex skill-creator rules.',
            'Create one reusable SKILL.md from a recorded browser workflow.',
            'Output only Markdown for SKILL.md. Do not wrap in code fences.',
            'The skill must be concise, procedural, and reusable. It must not read like a chronological transcript or raw event log.',
            'Infer the user-facing purpose and business workflow behind the actions.',
            'Use imperative workflow instructions, semantic element descriptions, variables for user-specific inputs, validation steps, data extraction guidance, and failure handling.',
            'Do not include secrets, exact private values, or one-time account data except as variable placeholders.',
            'Keep raw recording details out of the main instructions; always include a References section that points to ./references/recording.json.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `Required frontmatter name: ${name}`,
            `Required frontmatter category: ${category}`,
            `Suggested description: ${fallbackDescription}`,
            '',
            'Generate a high-quality skill for this browser workflow.',
            '',
            'Skill quality requirements:',
            '- Frontmatter must include name, description, and category.',
            '- The description must clearly state when this skill should trigger.',
            '- The body should include Workflow, Inputs/Variables, Browser Strategy, Data Extraction, Validation, and Recovery sections when useful.',
            '- Prefer instructions like "locate the search field by label or placeholder" over brittle selectors.',
            '- Include selector hints only as fallback hints.',
            '- Convert repeated low-level actions into business-level steps.',
            '- Remove noisy intermediate clicks, repeated inputs, typing traces, and page-transition trivia.',
            '- Tell the agent to use browser_snapshot before acting and browser_extract/browser_find on result pages.',
            '',
            skillCreatorGuide?.trim()
              ? [
                  'Built-in skill-creator guidance to follow:',
                  '---',
                  skillCreatorGuide.trim().slice(0, 18000),
                  '---',
                  ''
                ].join('\n')
              : '',
            '',
            'Recorded workflow summary JSON:',
            JSON.stringify(recordingForPrompt(recording), null, 2)
          ].join('\n')
        }
      ]
    });
    const generated = completion.message.content?.trim();
    if (!generated || !/^---\n[\s\S]*?\n---/.test(stripCodeFence(generated))) return fallback;
    const normalized = ensureGeneratedSkillFrontmatter(generated, req, fallbackDescription);
    if (!normalized.includes('./references/recording.json')) {
      return `${normalized.trim()}\n\n## References\n\n- Raw browser recording: \`./references/recording.json\`\n`;
    }
    return normalized;
  } catch {
    return fallback;
  }
}
