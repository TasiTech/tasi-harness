export interface CitationLink {
  label: string;
  href: string;
  host: string;
  excerpt?: string;
}

export const NUMERIC_CITATION_LINK_RE = /\[(\d+)\]\((https?:\/\/[^)\n]+)\)/g;
const MARKDOWN_HTTP_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\n]+)\)/g;
const SENTENCE_BOUNDARIES = ['\n', '.', ';', '\u3002', '\uff1b'];
const DOUBLE_ENCODED_PERCENT_ESCAPE_RE = /%25[0-9a-f]{2}/i;

function decodeDoubleEncodedHref(rawHref: string): string {
  let current = rawHref;
  for (let index = 0; index < 2 && DOUBLE_ENCODED_PERCENT_ESCAPE_RE.test(current); index += 1) {
    try {
      current = decodeURI(current);
    } catch {
      return rawHref;
    }
  }
  return current;
}

export function normalizeCitationHref(rawHref: string): string {
  const trimmed = decodeDoubleEncodedHref(rawHref.trim().replace(/^<(.+)>$/, '$1'));
  try {
    return new URL(trimmed.replace(/&amp;/g, '&')).href;
  } catch {
    try {
      return encodeURI(trimmed);
    } catch {
      return trimmed.replace(/\s+/g, '%20');
    }
  }
}

function citationHost(href: string): string {
  try {
    return new URL(href.replace(/&amp;/g, '&')).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

function citationExcerpt(content: string, matchIndex: number, matchLength: number): string {
  const sentenceStart = Math.max(...SENTENCE_BOUNDARIES.map((token) => content.lastIndexOf(token, matchIndex))) + 1;
  const sentenceEndCandidates = SENTENCE_BOUNDARIES
    .map((token) => content.indexOf(token, matchIndex + matchLength))
    .filter((index) => index >= 0);
  const sentenceEnd = sentenceEndCandidates.length > 0 ? Math.min(...sentenceEndCandidates) + 1 : Math.min(content.length, matchIndex + 180);
  return content
    .slice(sentenceStart, sentenceEnd)
    .replace(MARKDOWN_HTTP_LINK_RE, (_match, label: string) => `[${label}]`)
    .replace(/[*_`>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function nextUnusedNumericLabel(usedLabels: Set<string>): string {
  let next = 1;
  while (usedLabels.has(String(next))) next += 1;
  return String(next);
}

export function extractCitationLinks(content: string): CitationLink[] {
  const out: CitationLink[] = [];
  const seenHrefs = new Set<string>();
  const usedLabels = new Set<string>();

  for (const match of content.matchAll(MARKDOWN_HTTP_LINK_RE)) {
    const rawLabel = (match[1] ?? '').trim();
    const href = normalizeCitationHref(match[2] ?? '');
    if (!rawLabel || !href || seenHrefs.has(href)) continue;

    const label = /^\d+$/.test(rawLabel) ? rawLabel : nextUnusedNumericLabel(usedLabels);
    usedLabels.add(label);

    const matchIndex = typeof match.index === 'number' ? match.index : 0;
    out.push({
      label,
      href,
      host: citationHost(href),
      excerpt: citationExcerpt(content, matchIndex, match[0].length)
    });
    seenHrefs.add(href);
  }

  return out;
}
