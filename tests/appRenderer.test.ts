import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown } from '../src/renderer/App';

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;');
}

describe('renderInlineMarkdown', () => {
  it('auto-links bare URLs in assistant text', () => {
    const url = 'https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=%E5%8C%97%E4%BA%AC,BJP&ts=%E6%B5%8E%E5%8D%97,JNK&date=2026-05-20&flag=N,N,Y';
    const html = renderToStaticMarkup(
      createElement(Fragment, null, ...renderInlineMarkdown(`12306 official entry ${url}`, 'msg'))
    );

    expect(html).toContain('<a');
    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).toContain(`>${escapeAttr(url)}</a>`);
  });

  it('keeps trailing punctuation outside bare URL links', () => {
    const url = 'https://example.com/path?x=1&y=2';
    const html = renderToStaticMarkup(
      createElement(Fragment, null, ...renderInlineMarkdown(`Open ${url}.`, 'msg'))
    );

    expect(html).toContain(`href="${escapeAttr(url)}"`);
    expect(html).not.toContain(`href="${escapeAttr(`${url}.`)}"`);
    expect(html).toContain('</a><span>.</span>');
  });
});
