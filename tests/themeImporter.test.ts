import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { importThemePackage } from '../src/main/storage/themeImporter.js';
import { tempHome } from './helpers.js';

describe('themeImporter', () => {
  it('imports a DreamSkin zip package', async () => {
    const env = tempHome();
    const zip = new JSZip();
    zip.file('theme.json', JSON.stringify({
      schemaVersion: 1,
      id: 'neon-lab',
      name: 'Neon Lab',
      image: 'background.png',
      appearance: 'dark',
      art: {
        focusX: 0.7,
        focusY: 0.35,
        safeArea: 'left',
        taskMode: 'ambient'
      },
      colors: {
        background: '#06111f',
        panel: 'rgba(9, 28, 52, 0.78)',
        panelAlt: 'rgba(17, 47, 78, 0.62)',
        accent: '#18f0cf',
        accentAlt: '#3aa8ff',
        secondary: '#ffd166',
        highlight: '#67c1ff',
        text: '#eef9ff',
        muted: '#9fc3df',
        line: 'rgba(105, 190, 255, 0.18)'
      }
    }));
    zip.file('background.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    const theme = await importThemePackage(env.home, {
      filename: 'neon-lab.zip',
      contentBase64: archive.toString('base64')
    });

    expect(theme.id).toBe('neon-lab');
    expect(theme.name).toBe('Neon Lab');
    expect(theme.source).toBe('dreamskin');
    expect(theme.tokens.bgPrimary).toBe('#06111f');
    expect(theme.tokens.accent).toBe('#18f0cf');
    expect(theme.tokens.accent2).toBe('#3aa8ff');
    expect(theme.backgroundFocusX).toBe(0.7);
    expect(theme.backgroundFocusY).toBe(0.35);
    expect(theme.backgroundPath).toBeTruthy();
    expect(existsSync(theme.backgroundPath!)).toBe(true);

    env.cleanup();
  });
});
