import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionDocumentContextStore } from '../src/main/knowledge/sessionDocumentContextStore.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

async function createDocxWithComment(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'
  );
  zip.file(
    'word/comments.xml',
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"><w:p><w:r><w:t>Reviewer note</w:t></w:r></w:p></w:comment></w:comments>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function createXlsxWithComment(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" /></sheets></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" /></Relationships>'
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row></sheetData></worksheet>'
  );
  zip.file(
    'xl/comments1.xml',
    '<comments><commentList><comment ref="A1"><text><r><t>Reviewer note</t></r></text></comment></commentList></comments>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function createPptxWithComment(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" /></p:sldIdLst></p:presentation>'
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  );
  zip.file(
    'ppt/comments/comment1.xml',
    '<p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0" idx="1"><p:text>Reviewer note</p:text></p:cm></p:cmLst>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function createPdfWithAnnotation(): Buffer {
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Annots [5 0 R] >> endobj',
    '4 0 obj << /Length 42 >> stream',
    'BT /F1 12 Tf 72 200 Td (Hello PDF world) Tj ET',
    'endstream endobj',
    '5 0 obj << /Type /Annot /Subtype /Text /Rect [100 100 120 120] /Contents (Review note) >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF'
  ].join('\n');
  return Buffer.from(pdf, 'latin1');
}

describe('SessionDocumentContextStore', () => {
  it('stores uploaded docx as XML and keeps comment parts for prompt injection', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new SessionDocumentContextStore(env.home);
    const workspaceDir = join(env.home, 'workspace');
    const buffer = await createDocxWithComment();

    const added = await store.addDocument({
      sessionId: 'session_a',
      filename: 'notes.docx',
      contentBase64: buffer.toString('base64'),
      workspaceDir
    });
    expect(added.commentCount).toBe(1);
    expect(typeof added.workspaceCopyPath).toBe('string');
    expect(added.workspaceCopyPath).toContain('session-documents');
    expect(added.workspaceCopyPath).toContain('session_a');
    expect(existsSync(added.workspaceCopyPath ?? '')).toBe(true);
    expect(readFileSync(added.workspaceCopyPath ?? '')).toEqual(buffer);

    const docs = store.list('session_a');
    expect(docs).toHaveLength(1);
    expect(docs[0]?.id).toBe(added.id);

    const promptBlock = store.renderPromptBlock('session_a');
    expect(promptBlock).toContain('Session Document XML Context');
    expect(promptBlock).toContain('word/document.xml');
    expect(promptBlock).toContain('word/comments.xml');
    expect(promptBlock).toContain('comments: 1');

    const removed = store.deleteDocument('session_a', added.id);
    expect(removed).toBe(true);
    expect(store.list('session_a')).toHaveLength(0);
  });

  it('supports xlsx/pptx/pdf uploads and renders them as XML context', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new SessionDocumentContextStore(env.home);

    const xlsx = await createXlsxWithComment();
    const pptx = await createPptxWithComment();
    const pdf = createPdfWithAnnotation();

    const xlsxDoc = await store.addDocument({
      sessionId: 'session_mix',
      filename: 'table.xlsx',
      contentBase64: xlsx.toString('base64')
    });
    expect(xlsxDoc.commentCount).toBeGreaterThan(0);

    const pptxDoc = await store.addDocument({
      sessionId: 'session_mix',
      filename: 'slides.pptx',
      contentBase64: pptx.toString('base64')
    });
    expect(pptxDoc.commentCount).toBeGreaterThan(0);

    const pdfDoc = await store.addDocument({
      sessionId: 'session_mix',
      filename: 'report.pdf',
      contentBase64: pdf.toString('base64')
    });
    expect(pdfDoc.commentCount).toBeGreaterThan(0);

    const promptBlock = store.renderPromptBlock('session_mix', { maxDocs: 3, maxChars: 30_000 });
    expect(promptBlock).toContain('table.xlsx');
    expect(promptBlock).toContain('xl/comments1.xml');
    expect(promptBlock).toContain('slides.pptx');
    expect(promptBlock).toContain('ppt/comments/comment1.xml');
    expect(promptBlock).toContain('report.pdf');
    expect(promptBlock).toContain('Hello PDF world');
  });

  it('limits prompt injection to ten documents and adds an overflow notice', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const store = new SessionDocumentContextStore(env.home);
    const sessionId = 'session_overflow';
    for (let i = 1; i <= 11; i += 1) {
      await store.addDocument({
        sessionId,
        filename: `doc-${i}.xml`,
        contentBase64: Buffer.from(`<root><id>${i}</id></root>`, 'utf8').toString('base64')
      });
    }

    const promptBlock = store.renderPromptBlock(sessionId);
    expect(promptBlock).toContain('only the latest 10 are included');
    expect(promptBlock).toContain('doc-11.xml');
    expect(promptBlock).not.toContain('doc-1.xml');
  });
});
