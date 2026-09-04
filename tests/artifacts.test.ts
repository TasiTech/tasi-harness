import { describe, expect, it } from 'vitest';
import { classifyArtifactKind, decodeArtifactPathText, previewModeForArtifact } from '../src/shared/artifacts.js';

describe('artifact classification', () => {
  it('routes common generated files to inline preview or external open', () => {
    expect(previewModeForArtifact('.md')).toBe('markdown');
    expect(previewModeForArtifact('.py')).toBe('code');
    expect(previewModeForArtifact('.ts')).toBe('code');
    expect(previewModeForArtifact('.html')).toBe('text');
    expect(previewModeForArtifact('.htm')).toBe('text');
    expect(previewModeForArtifact('.txt')).toBe('text');
    expect(previewModeForArtifact('.pdf')).toBe('pdf');
    expect(previewModeForArtifact('.stl')).toBe('model3d');
    expect(previewModeForArtifact('.png')).toBe('image');
    expect(previewModeForArtifact('.docx')).toBe('office');
    expect(previewModeForArtifact('.pptx')).toBe('office');
    expect(previewModeForArtifact('.xlsx')).toBe('office');
    expect(previewModeForArtifact('.doc')).toBe('external');
    expect(classifyArtifactKind('.ps1')).toBe('executable');
    expect(previewModeForArtifact('.ps1')).toBe('external');
  });

  it('decodes percent-encoded local artifact paths', () => {
    expect(decodeArtifactPathText('d:\\%E6%8B%9B%E6%8A%95%E6%A0%87\\file.docx')).toBe('d:\\招投标\\file.docx');
  });
});
