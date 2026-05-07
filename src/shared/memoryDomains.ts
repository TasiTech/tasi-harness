import type { MemoryDomain } from './types.js';

const DEFAULT_DOMAIN: MemoryDomain = 'other';

const DOMAIN_ALIASES: Record<MemoryDomain, string[]> = {
  finance: [
    'finance', 'financial', 'stock', 'invest', 'trading', 'economy', 'market',
    '\u8d22\u7ecf', '\u91d1\u878d', '\u80a1\u7968', '\u57fa\u91d1', '\u6295\u8d44', '\u7406\u8d22', '\u4ea4\u6613', '\u7ecf\u6d4e', '\u884c\u60c5', '\u8d44\u4ea7'
  ],
  daily_life: [
    'daily', 'life', 'lifestyle', 'home', 'routine', 'habit',
    '\u65e5\u5e38', '\u751f\u6d3b', '\u5c45\u5bb6', '\u5bb6\u52a1', '\u4e60\u60ef', '\u4f5c\u606f', '\u5b89\u6392'
  ],
  work: [
    'work', 'career', 'project', 'meeting', 'business', 'office',
    '\u5de5\u4f5c', '\u804c\u4e1a', '\u9879\u76ee', '\u4f1a\u8bae', '\u4e1a\u52a1', '\u529e\u516c', '\u9700\u6c42', '\u6392\u671f', '\u6c47\u62a5', '\u5ba2\u6237'
  ],
  travel: [
    'travel', 'trip', 'itinerary', 'flight', 'hotel', 'train', 'vacation', 'tour', 'sightseeing',
    '\u65c5\u884c', '\u65c5\u6e38', '\u884c\u7a0b', '\u673a\u7968', '\u9152\u5e97', '\u706b\u8f66', '\u9ad8\u94c1', '\u666f\u70b9', '\u653b\u7565',
    '\u51fa\u884c', '\u5ea6\u5047', '\u822a\u73ed', '\u8f66\u7968', '\u4f4f\u5bbf', '\u95e8\u7968', '\u76ee\u7684\u5730', '\u6e38\u73a9',
    '\u81ea\u9a7e', '\u5468\u8fb9\u6e38', '\u643a\u7a0b', '\u540c\u7a0b', '\u98de\u732a', '\u53bb\u54ea\u513f',
    'ctrip', 'trip.com'
  ],
  reading: [
    'reading', 'book', 'article', 'paper', 'literature', 'read',
    '\u9605\u8bfb', '\u8bfb\u4e66', '\u4e66\u7c4d', '\u6587\u7ae0', '\u8bba\u6587', '\u6587\u732e'
  ],
  education: [
    'education', 'study', 'learning', 'school', 'course', 'training',
    '\u6559\u80b2', '\u5b66\u4e60', '\u8bfe\u7a0b', '\u5b66\u6821', '\u57f9\u8bad', '\u8003\u8bd5', '\u590d\u4e60'
  ],
  health: [
    'health', 'medical', 'wellness', 'fitness', 'doctor', 'medicine',
    '\u5065\u5eb7', '\u533b\u7597', '\u5065\u8eab', '\u8fd0\u52a8', '\u533b\u751f', '\u836f', '\u7528\u836f', '\u4f53\u68c0', '\u996e\u98df'
  ],
  other: ['other', 'misc', 'miscellaneous', 'default', 'general', '\u5176\u4ed6', '\u901a\u7528', '\u6742\u9879']
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasHitCount(text: string, alias: string): number {
  const source = text.trim().toLowerCase();
  const needle = alias.trim().toLowerCase();
  if (!source || !needle) return 0;

  const latinAlias = /^[a-z0-9._/-]+$/.test(needle);
  if (!latinAlias) {
    let idx = source.indexOf(needle);
    let count = 0;
    while (idx >= 0) {
      count += 1;
      idx = source.indexOf(needle, idx + needle.length);
    }
    return count;
  }

  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}(?=$|[^a-z0-9])`, 'g');
  let count = 0;
  while (pattern.exec(source)) count += 1;
  if (count > 0) return count;

  return source.includes(needle) ? 1 : 0;
}

export function normalizeMemoryDomain(input?: string): MemoryDomain {
  const raw = (input || '').trim().toLowerCase();
  if (!raw || raw === 'general') return DEFAULT_DOMAIN;
  for (const [domain, aliases] of Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>) {
    if (domain === raw) return domain;
    if (aliases.some((alias) => aliasHitCount(raw, alias) > 0)) return domain;
  }
  return DEFAULT_DOMAIN;
}

export function inferMemoryDomains(intent: string): MemoryDomain[] {
  const normalized = intent.trim().toLowerCase();
  if (!normalized) return [DEFAULT_DOMAIN];
  const scored = (Object.entries(DOMAIN_ALIASES) as Array<[MemoryDomain, string[]]>)
    .map(([domain, aliases], index) => ({
      domain,
      index,
      score: aliases.reduce((count, alias) => count + aliasHitCount(normalized, alias), 0)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.domain);
  return scored.length > 0 ? scored : [DEFAULT_DOMAIN];
}
