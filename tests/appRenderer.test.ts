import { describe, expect, it } from 'vitest';
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

  it('renders numeric markdown links as citation badges', () => {
    const url = 'https://example.com/source';
    const html = renderMarkdownToHtml(normalizeMarkdownForRender(`Claim[3](${url}) and [source](${url}).`));

    expect(html).toContain(`<a class="msg-cite" href="${url}" target="_blank" rel="noreferrer" title="${url}">3</a>`);
    expect(html).toContain(`<a href="${url}" target="_blank" rel="noreferrer">source</a>`);
  });
});
