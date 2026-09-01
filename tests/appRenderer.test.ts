import { describe, expect, it } from 'vitest';
import { extractCitationLinks, normalizeCitationHref } from '../src/renderer/citations';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from '../src/renderer/markdown';
import { assistantContentListView, assistantLiveContentPreviewText, decodeLikelyPercentEncodedChineseText, isVisibleChatMessage, reasoningPanelText } from '../src/renderer/App';

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;');
}

describe('renderMarkdownToHtml', () => {
  it('auto-links bare URLs in assistant text', () => {
    const url = 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC,BJP&ts=%E6%B5%8E%E5%8D%97,JNK&date=2026-05-20&flag=N,N,Y';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`12306 official entry ${url}`));

    expect(html).toContain('<a');
    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).toContain(`>${escapeAttr(url)}</a>`);
  });

  it('keeps trailing punctuation outside bare URL links', () => {
    const url = 'https://example.com/path?x=1&y=2';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`Open ${url}.`));

    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).not.toContain(`href="${escapeAttr(`${url}.`)}"`);
    expect(html).toContain(`>${escapeAttr(url)}</a>.`);
  });

  it('renders numeric markdown links as circular superscript citations', () => {
    const url = 'https://example.com/source';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`Claim[3](${url}) and [source](${url}).`));

    expect(html).toContain(`<sup class="msg-cite-ref"><a href="${url}" target="_blank" rel="noreferrer" title="${url}">3</a></sup>`);
    expect(html).toContain(`<a href="${url}" target="_blank" rel="noreferrer">source</a>`);
  });

  it('normalizes double-encoded search URLs before rendering links', () => {
    const rawUrl = 'https://www.baidu.com/s?wd=%25E5%258C%2597%25E4%25BA%25AC%25E4%25BB%258A%25E5%25A4%25A9%25E5%25A4%25A9%25E6%25B0%2594';
    const normalizedUrl = 'https://www.baidu.com/s?wd=%E5%8C%97%E4%BA%AC%E4%BB%8A%E5%A4%A9%E5%A4%A9%E6%B0%94';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`[baidu weather](${rawUrl})`));

    expect(normalizeCitationHref(rawUrl)).toBe(normalizedUrl);
    expect(html).toContain(`href="${normalizedUrl}"`);
    expect(html).not.toContain('%25E5');
  });

  it('renders citation badges for raw Chinese URLs containing spaces', () => {
    const rawUrl = 'https://baike.baidu.com/item/5·4 三亚海鲜店皮皮虾价格过高事件/67742287';
    const encodedUrl = normalizeCitationHref(rawUrl);
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`事件引发关注[1](${rawUrl})。`));

    expect(html).toContain(`<sup class="msg-cite-ref"><a href="${escapeAttr(encodedUrl)}" target="_blank" rel="noreferrer" title="${escapeAttr(encodedUrl)}">1</a></sup>`);
  });

  it('extracts referenced pages and excerpts from raw Chinese citation URLs', () => {
    const rawUrl = 'https://baike.baidu.com/item/5·4 三亚海鲜店皮皮虾价格过高事件/67742287';
    const citations = extractCitationLinks(`4 只皮皮虾花费 1035 元[1](${rawUrl})。后续说明。`);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      label: '1',
      href: normalizeCitationHref(rawUrl),
      host: 'baike.baidu.com'
    });
    expect(citations[0]?.excerpt).toContain('1035 元[1]');
  });
});

describe('extractCitationLinks fallback links', () => {
  it('auto-numbers named markdown source links for the referenced pages panel', () => {
    const citations = extractCitationLinks([
      'Useful sources:',
      '[American Physiological Society Journal](https://journals.physiology.org/doi/full/10.1152/jappl.1948.1.2.93)',
      '[Frontiers in Physics](https://www.frontiersin.org/journals/physics/articles/10.3389/fphy.2019.00189/full)'
    ].join('\n'));

    expect(citations.map((citation) => citation.label)).toEqual(['1', '2']);
    expect(citations.map((citation) => citation.host)).toEqual(['journals.physiology.org', 'frontiersin.org']);
  });
});

describe('assistantContentListView', () => {
  it('splits assistant content into display items without splitting fenced code blanks', () => {
    const view = assistantContentListView([
      '第一段回复。',
      '',
      '```ts',
      'const value = 1;',
      '',
      'console.log(value);',
      '```',
      '',
      '- 后续条目'
    ].join('\n'));

    expect(view.clipped).toBe(false);
    expect(view.items).toHaveLength(3);
    expect(view.items[0]).toBe('第一段回复。');
    expect(view.items[1]).toContain('const value = 1;\n\nconsole.log(value);');
    expect(view.items[2]).toBe('- 后续条目');
  });
});

describe('decodeLikelyPercentEncodedChineseText', () => {
  it('decodes pasted URL-encoded Chinese in user-visible text', () => {
    const raw = 'c:\\Users\\hujuntao\\.tasi-harness\\sessions\\session_mtfoi7vl_lfndcngk.json %E7%BB%93%E5%90%88session %E8%AE%B0%E5%BD%95%E5%88%86%E6%9E%90';

    expect(decodeLikelyPercentEncodedChineseText(raw)).toBe(
      'c:\\Users\\hujuntao\\.tasi-harness\\sessions\\session_mtfoi7vl_lfndcngk.json 结合session 记录分析'
    );
  });

  it('leaves non-Chinese percent encodings unchanged', () => {
    expect(decodeLikelyPercentEncodedChineseText('progress 100% and file%20name')).toBe('progress 100% and file%20name');
  });
});

describe('assistantLiveContentPreviewText', () => {
  it('clips live assistant content to the latest text as a single preview block', () => {
    const view = assistantLiveContentPreviewText(`start-marker\n${'older content '.repeat(600)}\nlatest answer`);

    expect(view.clipped).toBe(true);
    expect(view.text).toContain('latest answer');
    expect(view.text).not.toContain('start-marker');
    expect(view.text.length).toBeLessThanOrEqual(5000);
  });
});

describe('reasoningPanelText', () => {
  it('clips live reasoning from the newest reasoning parts', () => {
    const parts = [
      'old reasoning '.repeat(400),
      'middle reasoning '.repeat(300),
      'latest reasoning'
    ];
    const view = reasoningPanelText(parts.join('\n'), parts, true);

    expect(view.clippedText).toBe(true);
    expect(view.text).toContain('latest reasoning');
    expect(view.text).not.toContain('old reasoning old reasoning');
    expect(view.text.length).toBeLessThanOrEqual(3000);
  });
});

describe('isVisibleChatMessage', () => {
  it('keeps the streamed assistant bubble visible when only prior iteration content remains', () => {
    expect(isVisibleChatMessage({
      id: 'msg_visible',
      role: 'assistant',
      content: '',
      reasoning_content: '',
      content_parts: ['I will inspect first.'],
      createdAt: '2026-08-28T00:00:00.000Z'
    })).toBe(true);
  });
});
