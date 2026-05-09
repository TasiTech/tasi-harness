import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildAssistantMessageDocx, buildAssistantMessageExportHtml, safeExportBasename } from '../src/main/export/messageExport.js';

describe('message export helpers', () => {
  it('builds printable html with rendered answer content', () => {
    const html = buildAssistantMessageExportHtml('Answer', '<p>Hello <strong>world</strong></p>');

    expect(html).toContain('<title>Answer</title>');
    expect(html).toContain('<p>Hello <strong>world</strong></p>');
  });

  it('builds a docx package containing reply text and citations', async () => {
    const docx = await buildAssistantMessageDocx('Answer', '# Heading\n\nClaim[1](https://example.com/source)\n\n- Item');
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');

    expect(zip.file('[Content_Types].xml')).toBeTruthy();
    expect(documentXml).toContain('Heading');
    expect(documentXml).toContain('<w:hyperlink');
    expect(documentXml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(documentXml).toContain('<w:u w:val="none"/>');
    expect(documentXml).toContain('>1</w:t>');
    expect(relsXml).toContain('https://example.com/source');
    expect(documentXml).toContain('- Item');
  });

  it('does not duplicate the title when the message already starts with the same heading', async () => {
    const docx = await buildAssistantMessageDocx('Same Title', '# Same Title\n\nBody');
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect((documentXml.match(/Same Title/g) ?? []).length).toBe(1);
  });

  it('links plain source references back to collected citation URLs in docx export', async () => {
    const docx = await buildAssistantMessageDocx(
      'Answer',
      [
        '# Answer',
        '',
        'Claim[1](https://example.com/source path).',
        '',
        '**来源：**',
        '[1] Example source title.'
      ].join('\n')
    );
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? '';

    expect(documentXml).toContain('来源：');
    expect(documentXml).toContain('[1]');
    expect(relsXml).toContain('https://example.com/source%20path');
  });

  it('preserves html line breaks in docx source paragraphs', async () => {
    const html = '<p><strong>来源：</strong><br />[1] Example source title.<br />[2] Second source.</p>';
    const docx = await buildAssistantMessageDocx(
      'Answer',
      'Claim[1](https://example.com/one)\n\nOther[2](https://example.com/two)',
      html
    );
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? '';

    expect(documentXml).toContain('<w:br/>');
    expect(documentXml).toContain('[1]');
    expect(documentXml).toContain('[2]');
    expect(relsXml).toContain('https://example.com/one');
    expect(relsXml).toContain('https://example.com/two');
  });

  it('exports markdown tables as real Word tables', async () => {
    const docx = await buildAssistantMessageDocx(
      'Answer',
      [
        '| Name | Notes |',
        '| --- | --- |',
        '| Alpha | left \\| right |',
        '| Beta | `x | y` |'
      ].join('\n')
    );
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('<w:tr>');
    expect(documentXml).toContain('<w:tc>');
    expect(documentXml).toContain('Name');
    expect(documentXml).toContain('left | right');
    expect(documentXml).toContain('x | y');
  });

  it('keeps markdown table section rows with empty cells in docx export', async () => {
    const docx = await buildAssistantMessageDocx(
      'Answer',
      [
        '| 项目 | 单价 | 数量 | 小计 | 备注 |',
        '|------|------|------|------|------|',
        '| **交通** | | | | |',
        '| 高铁往返 | ¥784/人 | 2人×2程 | ¥3,136 | 北京西↔成都东 |',
        '| **住宿** | | | | |',
        '| 酒店 | ¥150/晚 | 4晚 | ¥600 | 经济型酒店 |',
        '| **合计** | | | **¥3,736** | 人均约¥1,868 |'
      ].join('\n')
    );
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string') ?? '';

    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml.match(/<w:tr>/g)).toHaveLength(6);
    expect(documentXml).toContain('交通');
    expect(documentXml).toContain('住宿');
    expect(documentXml).toContain('高铁往返');
    expect(documentXml).toContain('合计');
  });

  it('exports rendered html tables as real Word tables', async () => {
    const html = [
      '<p>Before table</p>',
      '<div class="msg-table-wrap"><table class="msg-table">',
      '<thead><tr><th>Name</th><th>Score</th></tr></thead>',
      '<tbody><tr><td>Alpha</td><td><strong>42</strong></td></tr></tbody>',
      '</table></div>',
      '<p>After table</p>'
    ].join('');
    const docx = await buildAssistantMessageDocx('Answer', 'fallback text', html);
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string');

    expect(documentXml).toContain('Before table');
    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('Name');
    expect(documentXml).toContain('Score');
    expect(documentXml).toContain('Alpha');
    expect(documentXml).toContain('42');
    expect(documentXml).toContain('After table');
    expect(documentXml).not.toContain('fallback text');
  });

  it('exports markdown and html links as clickable Word hyperlinks', async () => {
    const html = [
      '<p>Open <a href="https://example.com/day1">Day 1 map</a></p>',
      '<table><tbody><tr><td><a href="https://example.com/hotel">Hotel</a></td></tr></tbody></table>'
    ].join('');
    const docx = await buildAssistantMessageDocx('Answer', '[fallback](https://example.com/fallback)', html);
    const zip = await JSZip.loadAsync(docx);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');

    expect(documentXml).toContain('<w:hyperlink');
    expect(documentXml).toContain('Day 1 map');
    expect(documentXml).toContain('Hotel');
    expect(relsXml).toContain('https://example.com/day1');
    expect(relsXml).toContain('https://example.com/hotel');
  });

  it('sanitizes export filenames', () => {
    expect(safeExportBasename('a/b:c*?')).toBe('a-b-c');
  });
});
