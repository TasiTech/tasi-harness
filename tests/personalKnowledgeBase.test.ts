import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { PersonalKnowledgeBase } from '../src/main/knowledge/personalKnowledgeBase.js';
import { tempHome } from './helpers.js';

function createPdfWithText(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, '\\$&');
  const body = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${escaped.length + 30} >> stream`,
    `BT /F1 12 Tf 72 200 Td (${escaped}) Tj ET`,
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF'
  ].join('\n');
  return Buffer.from(body, 'latin1');
}

async function createOfdWithText(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'OFD.xml',
    '<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>'
  );
  zip.file(
    'Doc_0/Pages/Page_0/Content.xml',
    `<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Content><ofd:TextObject><ofd:TextCode>${text}</ofd:TextCode></ofd:TextObject></ofd:Content></ofd:Page>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('PersonalKnowledgeBase', () => {
  it('adds, searches, and deletes markdown documents', async () => {
    const env = tempHome();
    try {
      const knowledgeBase = new PersonalKnowledgeBase(env.home);
      const markdown = [
        '# Travel Notes',
        '',
        'I prefer bullet trains between Shanghai and Hangzhou.',
        '',
        '## Packing',
        '',
        '- Bring a rain jacket.',
        '- Keep passport copies in cloud storage.'
      ].join('\n');

      const doc = await knowledgeBase.addDocument({
        filename: 'notes.md',
        contentBase64: Buffer.from(markdown, 'utf8').toString('base64')
      });

      expect(doc.filename).toBe('notes.md');
      expect(doc.chunkCount).toBeGreaterThan(0);
      expect(doc.excerpt).toContain('Travel Notes');
      expect(existsSync(doc.markdownPath)).toBe(true);
      expect(readFileSync(doc.markdownPath, 'utf8')).toContain('bullet trains');

      const state = knowledgeBase.getState();
      expect(state.totalDocs).toBe(1);
      expect(state.totalChunks).toBe(doc.chunkCount);
      expect(state.totalChars).toBeGreaterThan(20);

      const hits = await knowledgeBase.search('rain jacket passport', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.filename).toBe('notes.md');

      const promptBlock = await knowledgeBase.renderPromptBlock('rain jacket passport');
      expect(promptBlock).toContain('notes.md');
      expect(promptBlock.toLowerCase()).toContain('rain jacket');

      expect(knowledgeBase.deleteDocument(doc.id)).toBe(true);
      expect(knowledgeBase.getState().totalDocs).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('uses extracted keywords to improve retrieval', async () => {
    const env = tempHome();
    const keywordExtractor = vi.fn(async () => ['passport copies', 'rain jacket']);
    try {
      const knowledgeBase = new PersonalKnowledgeBase(env.home, { keywordExtractor });
      await knowledgeBase.addDocument({
        filename: 'packing.md',
        contentBase64: Buffer.from('Remember to carry passport copies and a rain jacket.', 'utf8').toString('base64')
      });

      const hits = await knowledgeBase.search('travel documents for bad weather', 3);
      expect(keywordExtractor).toHaveBeenCalledTimes(1);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.filename).toBe('packing.md');

      const promptBlock = await knowledgeBase.renderPromptBlock('travel documents for bad weather');
      expect(keywordExtractor).toHaveBeenCalledTimes(1);
      expect(promptBlock).toContain('packing.md');
      expect(promptBlock.toLowerCase()).toContain('passport copies');
    } finally {
      env.cleanup();
    }
  });

  it('imports pdf documents into markdown for retrieval', async () => {
    const env = tempHome();
    try {
      const knowledgeBase = new PersonalKnowledgeBase(env.home);
      const pdf = createPdfWithText('Hello PDF world');

      const doc = await knowledgeBase.addDocument({
        filename: 'report.pdf',
        contentBase64: pdf.toString('base64')
      });

      expect(doc.filename).toBe('report.pdf');
      expect(existsSync(doc.markdownPath)).toBe(true);
      expect(readFileSync(doc.markdownPath, 'utf8')).toContain('Hello PDF world');
      const hits = await knowledgeBase.search('PDF world', 3);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      env.cleanup();
    }
  });

  it('imports ofd documents into markdown for retrieval', async () => {
    const env = tempHome();
    try {
      const knowledgeBase = new PersonalKnowledgeBase(env.home);
      const ofd = await createOfdWithText('Hello OFD world');

      const doc = await knowledgeBase.addDocument({
        filename: 'notice.ofd',
        contentBase64: ofd.toString('base64')
      });

      expect(doc.filename).toBe('notice.ofd');
      expect(existsSync(doc.markdownPath)).toBe(true);
      expect(readFileSync(doc.markdownPath, 'utf8')).toContain('Hello OFD world');
      const hits = await knowledgeBase.search('OFD world', 3);
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      env.cleanup();
    }
  });
});
