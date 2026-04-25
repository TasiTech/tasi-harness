import type { AppConfig, PersonalKnowledgeDocument } from '../../shared/types.js';
import { providerRequiresApiKey } from '../../shared/providerCatalog.js';
import { createLlmClient } from '../agent/llmClient.js';

export type PersonalKnowledgeKeywordExtractor = (query: string, docs: PersonalKnowledgeDocument[]) => Promise<string[]>;

function stripCodeFences(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[\w-]*\s*|\s*```$/g, '').trim();
}

function dedupeTerms(input: string[], limit = 12): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const normalized = item.trim().replace(/^[-*•\d.\s]+/, '').replace(/\s+/g, ' ');
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function parseKeywords(content: string): string[] {
  const cleaned = stripCodeFences(content);
  if (!cleaned) return [];

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return dedupeTerms(parsed.filter((item): item is string => typeof item === 'string'));
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { keywords?: unknown }).keywords)) {
      return dedupeTerms(((parsed as { keywords: unknown[] }).keywords).filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    // Fall back to plain-text parsing.
  }

  const lines = cleaned
    .split(/\r?\n|[，,；;、]/)
    .map((line) => line.trim())
    .filter(Boolean);
  return dedupeTerms(lines.length > 1 ? lines : cleaned.split(/\s{2,}/).filter(Boolean));
}

export function createPersonalKnowledgeKeywordExtractor(getConfig: () => AppConfig): PersonalKnowledgeKeywordExtractor {
  return async (query: string, docs: PersonalKnowledgeDocument[]): Promise<string[]> => {
    const config = getConfig();
    if (!config.baseUrl || !config.model) return [];
    if (providerRequiresApiKey(config.provider) && !config.apiKey) return [];

    const client = createLlmClient(config);
    const docHints = docs
      .slice(0, 12)
      .map((doc) => `${doc.filename}${doc.title && doc.title !== doc.filename ? ` | ${doc.title}` : ''}`)
      .join('\n');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const completion = await client.complete({
        temperature: 0.1,
        maxTokens: 96,
        signal: controller.signal,
        messages: [
          {
            role: 'system',
            content: [
              'You generate retrieval keywords for a local personal knowledge base.',
              'Return 3 to 8 concise keywords or short phrases, one per line.',
              'Prefer entities, aliases, file-name clues, domain terms, and search-friendly wording.',
              'Do not explain the result.'
            ].join(' ')
          },
          {
            role: 'user',
            content: [
              `Query: ${query}`,
              docHints ? `Available documents:\n${docHints}` : 'Available documents: (none listed)',
              'Return only the keywords.'
            ].join('\n\n')
          }
        ]
      });
      return parseKeywords(completion.message.content ?? '');
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
