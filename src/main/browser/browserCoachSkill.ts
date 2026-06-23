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

function slugifyOrFallback(input: string | undefined, fallback: string): string {
  for (const candidate of [input, fallback, 'recorded-browser-workflow']) {
    try {
      return slugifyName(candidate ?? '');
    } catch {
      // Try the next fallback.
    }
  }
  return 'recorded-browser-workflow';
}

function fallbackSkillName(recording: BrowserCoachRecording): string {
  const host = uniqueHosts(recording)[0];
  return host ? `${host}-browser-workflow` : 'recorded-browser-workflow';
}

function displayValue(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function frontmatterLine(key: string, value: string | undefined): string[] {
  return value ? [`${key}: ${value.replace(/\n/g, ' ')}`] : [];
}

function userGuidanceSection(guidance: string | undefined): string[] {
  const trimmed = guidance?.trim();
  if (!trimmed) return [];
  return [
    '## User Guidance',
    '',
    'Follow these user-provided instructions when they do not conflict with safety rules, tool reliability rules, or the recorded workflow evidence.',
    '',
    trimmed
  ];
}

export function normalizeBrowserCoachSkillRequest(
  req: BrowserCoachGenerateSkillRequest,
  recording: BrowserCoachRecording
): BrowserCoachGenerateSkillRequest {
  const rawName = displayValue(req.displayName) ?? displayValue(req.name);
  const rawCategory = displayValue(req.displayCategory);
  return {
    ...req,
    name: slugifyOrFallback(req.name, fallbackSkillName(recording)),
    category: slugifyOrFallback(req.category, 'browser'),
    displayName: rawName,
    displayCategory: rawCategory
  };
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

const SENSITIVE_PARAM_PATTERN = /(token|secret|password|passwd|pwd|auth|authorization|session|cookie|key|credential|ticket|sign|signature)/i;

function redactParamValue(key: string, value: string): string {
  if (!value) return '';
  if (SENSITIVE_PARAM_PATTERN.test(key)) return '[redacted]';
  return clip(value, 80);
}

function urlSummary(url: string): { href: string; params: Array<{ key: string; value: string }> } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:') return null;
    const params = [...parsed.searchParams.entries()]
      .slice(0, 20)
      .map(([key, value]) => ({ key, value: redactParamValue(key, value) }));
    return { href: parsed.toString(), params };
  } catch {
    return null;
  }
}

function recordedLinksAndParams(recording: BrowserCoachRecording): {
  urls: Array<{ index: number; title?: string; href: string; params: Array<{ key: string; value: string }> }>;
  fields: Array<{ index: number; label: string; valueHint: string; selector?: string; url: string }>;
} {
  const urls: Array<{ index: number; title?: string; href: string; params: Array<{ key: string; value: string }> }> = [];
  const seenUrls = new Set<string>();
  for (const event of relevantEvents(recording)) {
    const summary = urlSummary(event.url);
    if (!summary || seenUrls.has(summary.href)) continue;
    seenUrls.add(summary.href);
    urls.push({
      index: event.index,
      title: event.title ? clip(event.title, 100) : undefined,
      href: summary.href,
      params: summary.params
    });
    if (urls.length >= 20) break;
  }

  const fields = relevantEvents(recording)
    .filter((event) => (event.type === 'input' || event.type === 'change') && event.value && event.value !== '[masked]')
    .slice(0, 30)
    .map((event) => ({
      index: event.index,
      label: clip(event.name || event.text || event.selector || event.tag || 'field', 100),
      valueHint: clip(event.value, 80),
      selector: event.selector,
      url: event.url
    }));
  return { urls, fields };
}

function recordedLinksAndParamsSection(recording: BrowserCoachRecording): string[] {
  const data = recordedLinksAndParams(recording);
  const lines = [
    '## Recorded Links And Parameters',
    '',
    '- Treat these recorded URLs, query parameters, and field values as route and schema hints. Replace task-specific values with user-provided variables before execution.'
  ];
  if (data.urls.length > 0) {
    lines.push('', '### URLs');
    for (const item of data.urls.slice(0, 12)) {
      lines.push(`- Step ${item.index}: ${item.href}${item.title ? ` (${item.title})` : ''}`);
      if (item.params.length > 0) {
        lines.push(`  - Query params: ${item.params.map((param) => `${param.key}=${param.value || '""'}`).join('; ')}`);
      }
    }
  }
  if (data.fields.length > 0) {
    lines.push('', '### Input Hints');
    for (const field of data.fields.slice(0, 12)) {
      lines.push(`- Step ${field.index}: ${field.label} = \`${field.valueHint}\`${field.selector ? ` (selector hint: \`${field.selector}\`)` : ''}`);
    }
  }
  if (data.urls.length === 0 && data.fields.length === 0) {
    lines.push('- No URL parameters or input values were captured in this recording.');
  }
  return lines;
}

const BROWSER_RELIABILITY_RULES = [
  '- Prefer `browser_find` with `action` or a fresh `@e` ref from the current `browser_snapshot`; avoid reusing brittle `body > div:nth-of-type(...)` selectors on dynamic pages.',
  '- After typing into city, search, date, or other autocomplete fields, handle the suggestion/dropdown confirmation step and verify the selected value before continuing.',
  '- After every critical click or form fill, verify the page state with `browser_snapshot`, `browser_find`, or `browser_extract` before moving to the next step.',
  '- Do not guess provider result URLs, city IDs, schedules, prices, inventory, or availability. If live evidence cannot be gathered, explicitly mark the output as degraded instead of presenting estimates as verified facts.',
  '- If a page snapshot only exposes navigation/header content, narrow the target area, use semantic find/actions, inspect page text, or report the blocked evidence path rather than inventing results.'
];

function browserReliabilitySection(): string[] {
  return [
    '## Browser Reliability Rules',
    '',
    ...BROWSER_RELIABILITY_RULES
  ];
}

function ensureBrowserReliabilitySection(content: string): string {
  if (/Browser Reliability Rules/i.test(content) || /Do not guess provider result URLs/i.test(content)) return content;
  const referencesMatch = content.match(/\n## References\s*\n/i);
  const section = ['', ...browserReliabilitySection(), ''].join('\n');
  if (!referencesMatch?.index) return `${content.trim()}\n${section}\n`;
  return `${content.slice(0, referencesMatch.index).trim()}\n${section}${content.slice(referencesMatch.index)}`;
}

function ensureRecordedLinksAndParamsSection(content: string, recording: BrowserCoachRecording): string {
  if (/Recorded Links And Parameters/i.test(content)) return content;
  const referencesMatch = content.match(/\n## References\s*\n/i);
  const section = ['', ...recordedLinksAndParamsSection(recording), ''].join('\n');
  if (!referencesMatch?.index) return `${content.trim()}\n${section}\n`;
  return `${content.slice(0, referencesMatch.index).trim()}\n${section}${content.slice(referencesMatch.index)}`;
}

function ensureUserGuidanceSection(content: string, guidance: string | undefined): string {
  if (!guidance?.trim() || /User Guidance/i.test(content)) return content;
  const referencesMatch = content.match(/\n## References\s*\n/i);
  const section = ['', ...userGuidanceSection(guidance), ''].join('\n');
  if (!referencesMatch?.index) return `${content.trim()}\n${section}\n`;
  return `${content.slice(0, referencesMatch.index).trim()}\n${section}${content.slice(referencesMatch.index)}`;
}

export function buildBrowserCoachSkillContent(req: BrowserCoachGenerateSkillRequest, recording: BrowserCoachRecording): string {
  const normalizedReq = normalizeBrowserCoachSkillRequest(req, recording);
  const name = normalizedReq.name;
  const category = normalizedReq.category;
  const hosts = uniqueHosts(recording);
  const description = normalizedReq.description?.trim() ||
    `Use when the user asks to repeat the recorded browser workflow${hosts.length ? ` for ${hosts.join(', ')}` : ''}.`;
  const steps = relevantEvents(recording)
    .map((event, index) => `${index + 1}. ${browserCoachEventToInstruction(event)}`)
    .join('\n');
  const firstUrl = recording.events.find((event) => event.url && event.url !== 'about:blank')?.url || recording.startUrl;

  return [
    '---',
    `name: ${name}`,
    ...frontmatterLine('display_name', normalizedReq.displayName),
    `description: ${description.replace(/\n/g, ' ')}`,
    `category: ${category}`,
    ...frontmatterLine('display_category', normalizedReq.displayCategory),
    '---',
    '',
    `# ${normalizedReq.displayName || name}`,
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
    '- If login, captcha, MFA, or permission prompts appear, pause and ask the user to complete them in the browser, then use `browser_wait` with `until_logged_in: true`, `until_changed: true`, and `timeout_ms: 300000` before checking the page again. Avoid fixed long sleeps such as `ms: 300000`.',
  '- If the login page already has saved credentials or the user has filled the username/password fields, do not ask for the password again. Click the visible login/sign-in button, then wait with `until_logged_in: true` and `timeout_ms: 300000`.',
  '- If the page says the user is about to log in or authorize access after credentials were accepted, inspect the page and click the visible confirm/login/continue/authorize button instead of waiting for the final site indefinitely.',
  '- If this workflow fills forms, submits requests, changes account state, or leaves a page for user review, call `browser_close_policy` with `policy: "keep_open"` before the final answer. If the workflow only extracts/read-only data, allow the default auto-close behavior.',
    '',
    ...userGuidanceSection(normalizedReq.userGuidance),
    ...(normalizedReq.userGuidance?.trim() ? [''] : []),
    ...recordedLinksAndParamsSection(recording),
    '',
    ...browserReliabilitySection(),
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
    linksAndParams: recordedLinksAndParams(recording),
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
  const name = slugifyOrFallback(req.name, 'recorded-browser-workflow');
  const category = slugifyOrFallback(req.category, 'browser');
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
    .filter((line) => line && !/^(name|display_name|category|display_category|description)\s*:/i.test(line));
  const description = frontmatter?.[1].match(/^description\s*:\s*(.+)$/im)?.[1]?.trim() || req.description?.trim() || fallbackDescription;
  return [
    '---',
    `name: ${name}`,
    ...frontmatterLine('display_name', req.displayName),
    `description: ${description.replace(/\n/g, ' ')}`,
    `category: ${category}`,
    ...frontmatterLine('display_category', req.displayCategory),
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
  const normalizedReq = normalizeBrowserCoachSkillRequest(req, recording);
  const name = normalizedReq.name;
  const category = normalizedReq.category;
  const hosts = uniqueHosts(recording);
  const fallbackDescription = normalizedReq.description?.trim() ||
    `Use when the user asks to repeat the recorded browser workflow${hosts.length ? ` for ${hosts.join(', ')}` : ''}.`;
  const fallback = buildBrowserCoachSkillContent(normalizedReq, recording);
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
            normalizedReq.displayName ? `Display name to preserve: ${normalizedReq.displayName}` : '',
            normalizedReq.displayCategory ? `Display category to preserve: ${normalizedReq.displayCategory}` : '',
            `Suggested description: ${fallbackDescription}`,
            normalizedReq.userGuidance?.trim()
              ? [
                  '',
                  'User-provided guidance to preserve and follow:',
                  '---',
                  normalizedReq.userGuidance.trim(),
                  '---'
                ].join('\n')
              : '',
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
            '- Include a Recorded Links And Parameters section that preserves useful recorded URLs, query parameter names/values, route patterns, and input hints. Convert task-specific values into variables in the workflow, but keep the captured examples as hints.',
            '- Include Browser Reliability Rules that prevent the my-travel failure pattern: do not reuse brittle nth-of-type selectors, confirm autocomplete/dropdown selections, verify every critical state change, do not guess provider result URLs, and mark live-data failures as degraded.',
            '- For travel, booking, shopping, finance, or other live-provider workflows, require tool-backed evidence before reporting prices, schedules, inventory, availability, or ratings.',
            '- Include browser close policy guidance: keep the browser open for form filling/submissions/account changes/user review, and allow auto-close for read-only data lookup/extraction.',
            normalizedReq.userGuidance?.trim() ? '- Include a User Guidance section or weave the user-provided guidance into the relevant workflow sections.' : '',
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
    const normalized = ensureBrowserReliabilitySection(
      ensureRecordedLinksAndParamsSection(
        ensureUserGuidanceSection(ensureGeneratedSkillFrontmatter(generated, normalizedReq, fallbackDescription), normalizedReq.userGuidance),
        recording
      )
    );
    if (!normalized.includes('./references/recording.json')) {
      return `${normalized.trim()}\n\n## References\n\n- Raw browser recording: \`./references/recording.json\`\n`;
    }
    return normalized;
  } catch {
    return fallback;
  }
}
