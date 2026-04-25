import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PersonalKnowledgeBase } from '../src/main/knowledge/personalKnowledgeBase.js';
import { tempHome } from './helpers.js';

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
});
