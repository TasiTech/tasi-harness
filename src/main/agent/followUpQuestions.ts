import type { AppConfig } from '../../shared/types.js';
import { providerRequiresApiKey } from '../../shared/providerCatalog.js';
import type { LlmClient } from './llmClient.js';

const FOLLOW_UP_TIMEOUT_MS = 8000;

function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[\w-]*\s*|\s*```$/g, '').trim();
}

function normalizeQuestion(input: string): string {
  return input
    .trim()
    .replace(/^[-*\d.()\s]+/, '')
    .replace(
      /^(?:you can ask|you could ask|the user could ask|the user might ask|suggested question|follow-up question)\s*[:：-]\s*/i,
      ''
    )
    .replace(
      /^(?:\u4f60\u53ef\u4ee5\u7ee7\u7eed\u95ee|\u4f60\u8fd8\u53ef\u4ee5\u95ee|\u5efa\u8bae\u7ee7\u7eed\u8ffd\u95ee|\u53ef\u4ee5\u7ee7\u7eed\u95ee|\u7528\u6237\u53ef\u4ee5\u95ee|\u7528\u6237\u53ef\u80fd\u4f1a\u95ee)\s*[:：-]\s*/,
      ''
    )
    .replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/g, '')
    .replace(/\s+/g, ' ');
}

function dedupeQuestions(input: string[], limit = 4): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const normalized = normalizeQuestion(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function parseFollowUpQuestions(content: string): string[] {
  const cleaned = stripCodeFences(content);
  if (!cleaned) return [];

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return dedupeQuestions(parsed.filter((item): item is string => typeof item === 'string'));
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)) {
      return dedupeQuestions(((parsed as { questions: unknown[] }).questions).filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    // Fall back to line parsing.
  }

  return dedupeQuestions(cleaned.split(/\r?\n/));
}

function looksChinese(input: string): boolean {
  return /[\u4e00-\u9fff]/.test(input);
}

function isServicePerspectiveQuestion(input: string): boolean {
  const normalized = normalizeQuestion(input);
  if (!normalized) return true;
  return [
    /^would you like me to\b/i,
    /^do you want me to\b/i,
    /^should i\b/i,
    /^i can\b/i,
    /^i could\b/i,
    /^let me\b/i,
    /^let me know if you'd like\b/i,
    /^need me to\b/i,
    /^want me to\b/i,
    /^\u9700\u8981\u6211/,
    /^\u662f\u5426\u9700\u8981\u6211/,
    /^\u8981\u4e0d\u8981\u6211/,
    /^\u6211\u53ef\u4ee5/,
    /^\u6211\u6765/,
    /^\u8981\u6211/,
    /^\u5982\u679c\u4f60\u9700\u8981(?:\u7684\u8bdd)?[，,]\u6211\u53ef\u4ee5/
  ].some((pattern) => pattern.test(normalized));
}

function isMetaPromptQuestion(input: string): boolean {
  const normalized = normalizeQuestion(input);
  if (!normalized) return true;
  return [
    /^the user\b/i,
    /^user[:：]/i,
    /^assistant[:：]/i,
    /^follow-?up\b/i,
    /^suggested\b/i,
    /^\u7528\u6237/,
    /^\u52a9\u624b/,
    /^\u63d0\u793a\u95ee\u9898/,
    /^\u5efa\u8bae\u95ee\u9898/
  ].some((pattern) => pattern.test(normalized));
}

function finalizeQuestions(primary: string[], fallback: string[], limit: number): string[] {
  const preferred = dedupeQuestions(
    primary.filter((item) => !isServicePerspectiveQuestion(item) && !isMetaPromptQuestion(item)),
    limit
  );
  if (preferred.length >= limit) return preferred;
  return dedupeQuestions([...preferred, ...fallback], limit);
}

function truncateQuestionTopic(input: string, maxChars: number): string {
  const singleLine = input
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[“”"'`]/g, '')
    .trim();
  if (!singleLine) return '';
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars).trim()}...`;
}

function topicFromContext(userInput: string, finalResponse: string): string {
  const candidates = [userInput, finalResponse]
    .map((item) => item.trim())
    .filter((item) => item.length >= 4)
    .map((item) => item.split(/[。！？!?;；\n]/)[0]?.trim() ?? '')
    .filter((item) => item.length >= 4);
  if (candidates.length === 0) return '';
  const maxChars = looksChinese(candidates.join(' ')) ? 16 : 28;
  return truncateQuestionTopic(candidates[0], maxChars);
}

function fallbackQuestions(userInput: string, finalResponse: string): string[] {
  const topic = topicFromContext(userInput, finalResponse);
  if (looksChinese(userInput)) {
    if (topic) {
      return [
        `围绕“${topic}”，我下一步先做什么最合适？`,
        `按你刚才的建议推进，这件事最容易踩的坑是什么？`,
        `你能帮我把“${topic}”整理成一个按优先级执行的清单吗？`
      ];
    }
    return [
      '\u4f60\u80fd\u5e2e\u6211\u628a\u4e0a\u9762\u7684\u5185\u5bb9\u6574\u7406\u6210\u4e00\u4e2a\u5206\u6b65\u6e05\u5355\u5417\uff1f',
      '\u6211\u5982\u679c\u73b0\u5728\u5f00\u59cb\uff0c\u7b2c\u4e00\u6b65\u5e94\u8be5\u5148\u505a\u4ec0\u4e48\uff1f',
      '\u7ed3\u5408\u6211\u7684\u60c5\u51b5\uff0c\u6700\u9700\u8981\u6ce8\u610f\u7684\u98ce\u9669\u3001\u9650\u5236\u6216\u524d\u63d0\u662f\u4ec0\u4e48\uff1f'
    ];
  }
  if (topic) {
    return [
      `For "${topic}", what should I do first?`,
      'If I follow your advice now, what is the easiest mistake to make?',
      `Can you turn "${topic}" into a prioritized checklist for me?`
    ];
  }
  return [
    'Can you turn that into a step-by-step checklist for me?',
    'If I start right now, what should I do first?',
    'Given my situation, what risks, limits, or prerequisites should I pay attention to?'
  ];
}

export async function generateFollowUpQuestions(
  createClient: () => LlmClient,
  config: AppConfig,
  context: { userInput: string; finalResponse: string },
  limit = 3
): Promise<string[]> {
  const baseFallback = fallbackQuestions(context.userInput, context.finalResponse).slice(0, limit);
  if (!context.finalResponse.trim()) return baseFallback;
  if (!config.baseUrl?.trim() || !config.model?.trim()) return baseFallback;
  if (providerRequiresApiKey(config.provider) && !config.apiKey?.trim()) return baseFallback;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FOLLOW_UP_TIMEOUT_MS);
    try {
      const completion = await createClient().complete({
        temperature: 0.4,
        maxTokens: 160,
        signal: controller.signal,
        messages: [
          {
            role: 'system',
            content: [
              'Generate 3 short follow-up questions that the user could click and send immediately after an assistant reply.',
              'Return only a JSON array of strings.',
              'Keep each question practical, concrete, and closely tied to the latest answer.',
              'Write each question exactly in the user voice, as if the user is directly asking the assistant.',
              'Prefer first-person wording like "I", "my", "\u6211", or "\u6211\u7684" when natural.',
              'Do not write assistant offers, service prompts, narrator text, or "Would you like me to..." style phrasing.',
              'Do not prefix with labels like "Suggested question", "Follow-up", "\u4f60\u53ef\u4ee5\u7ee7\u7eed\u95ee", or "\u7528\u6237\u53ef\u4ee5\u95ee".',
              'Use the same language as the user.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              `User question:\n${context.userInput}`,
              `Assistant answer:\n${context.finalResponse}`,
              'Return 3 follow-up questions written exactly as the user would send them in chat.'
            ].join('\n\n')
          }
        ]
      });
      const parsed = parseFollowUpQuestions(completion.message.content ?? '');
      return finalizeQuestions(parsed, baseFallback, limit);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return baseFallback;
  }
}
