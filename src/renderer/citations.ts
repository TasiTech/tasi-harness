export interface CitationLink {
  label: string;
  href: string;
  host: string;
  excerpt?: string;
}

export const NUMERIC_CITATION_LINK_RE = /\[(\d+)\]\((https?:\/\/[^)\n]+)\)/g;

export function normalizeCitationHref(rawHref: string): string {
  const trimmed = rawHref.trim().replace(/^<(.+)>$/, '$1');
  try {
    return encodeURI(trimmed);
  } catch {
    return trimmed.replace(/\s+/g, '%20');
  }
}

export function extractCitationLinks(content: string): CitationLink[] {
  const out: CitationLink[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(NUMERIC_CITATION_LINK_RE)) {
    const label = match[1] ?? '';
    const href = normalizeCitationHref(match[2] ?? '');
    if (!label || !href || seen.has(href)) continue;
    const matchIndex = typeof match.index === 'number' ? match.index : 0;
    const sentenceStartCandidates = [
      content.lastIndexOf('\n', matchIndex),
      content.lastIndexOf('。', matchIndex),
      content.lastIndexOf('.', matchIndex),
      content.lastIndexOf('；', matchIndex),
      content.lastIndexOf(';', matchIndex)
    ];
    const sentenceStart = Math.max(...sentenceStartCandidates) + 1;
    const sentenceEndCandidates = ['\n', '。', '.', '；', ';']
      .map((token) => content.indexOf(token, matchIndex + match[0].length))
      .filter((index) => index >= 0);
    const sentenceEnd = sentenceEndCandidates.length > 0 ? Math.min(...sentenceEndCandidates) + 1 : Math.min(content.length, matchIndex + 180);
    const excerpt = content
      .slice(sentenceStart, sentenceEnd)
      .replace(NUMERIC_CITATION_LINK_RE, '[$1]')
      .replace(/[*_`>#|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    let host = href;
    try {
      host = new URL(href.replace(/&amp;/g, '&')).hostname.replace(/^www\./, '');
    } catch {
      host = href;
    }
    out.push({ label, href, host, excerpt });
    seen.add(href);
  }
  return out;
}
