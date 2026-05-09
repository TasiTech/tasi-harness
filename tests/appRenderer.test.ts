import { describe, expect, it } from 'vitest';
import { extractCitationLinks, normalizeCitationHref } from '../src/renderer/citations';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from '../src/renderer/markdown';

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
