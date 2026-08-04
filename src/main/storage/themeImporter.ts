import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import JSZip from 'jszip';
import type { CustomTheme, CustomThemeTokens, ThemeImportRequest } from '../../shared/types.js';
import { nowIso } from '../../shared/types.js';

const MAX_THEME_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_THEME_IMAGE_BYTES = 10 * 1024 * 1024;
const COLOR_FIELD_MAP: Record<string, keyof CustomThemeTokens> = {
  background: 'bgPrimary',
  panel: 'bgSecondary',
  panelAlt: 'bgTertiary',
  accent: 'accent',
  accentAlt: 'accent2',
  secondary: 'warn',
  highlight: 'borderActive',
  text: 'textPrimary',
  muted: 'textSecondary',
  line: 'border'
};
const DREAMSKIN_CSS_VAR_MAP: Record<string, keyof CustomThemeTokens> = {
  '--ds-theme-color-background': 'bgPrimary',
  '--ds-theme-color-panel': 'bgSecondary',
  '--ds-theme-color-panel-alt': 'bgTertiary',
  '--ds-theme-color-accent': 'accent',
  '--ds-theme-color-accent-alt': 'accent2',
  '--ds-theme-color-secondary': 'warn',
  '--ds-theme-color-highlight': 'borderActive',
  '--ds-theme-color-text': 'textPrimary',
  '--ds-theme-color-muted': 'textSecondary',
  '--ds-theme-color-line': 'border'
};
const TASI_TOKEN_KEYS = new Set<keyof CustomThemeTokens>([
  'bgPrimary',
  'bgSecondary',
  'bgTertiary',
  'bgCard',
  'bgCardHover',
  'accent',
  'accentDim',
  'accent2',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'border',
  'borderActive',
  'ok',
  'warn',
  'danger',
  'shadow'
]);

function cleanThemeId(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Theme id is missing.');
  const id = input.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) throw new Error('Theme id must use lowercase letters, numbers, dots, and dashes.');
  return id;
}

function cleanThemeName(input: unknown, fallback: string): string {
  const value = typeof input === 'string' ? input.trim().slice(0, 80) : '';
  return value || fallback;
}

function cleanColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().slice(0, 160);
  if (!clean || /[;{}<>]/.test(clean) || /url\s*\(/i.test(clean)) return undefined;
  if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|color-mix\([^)]+\)|[a-z]+)$/i.test(clean)) return undefined;
  return clean;
}

function alphaColor(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

function backgroundImageExt(imageName: string): string {
  const ext = extname(imageName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
  if (ext === '.png') return '.png';
  if (ext === '.webp') return '.webp';
  throw new Error('DreamSkin background image must be JPEG, PNG, or WebP.');
}

function customThemeDir(harnessHome: string, id: string): string {
  return join(harnessHome, 'themes', id);
}

function customThemeImagePath(harnessHome: string, id: string, imageName: string): string {
  return join(customThemeDir(harnessHome, id), `background${backgroundImageExt(imageName)}`);
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Theme JSON must be an object.');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tokensFromDreamSkinColors(colors: unknown): CustomThemeTokens {
  const raw = recordValue(colors);
  const tokens: CustomThemeTokens = {};
  for (const [sourceKey, targetKey] of Object.entries(COLOR_FIELD_MAP)) {
    const color = cleanColor(raw[sourceKey]);
    if (color) tokens[targetKey] = color;
  }
  const panel = tokens.bgSecondary;
  const panelAlt = tokens.bgTertiary;
  const accent = tokens.accent;
  const textSecondary = tokens.textSecondary;
  if (panel) tokens.bgCard = alphaColor(panel, 0.72);
  if (panelAlt) tokens.bgCardHover = alphaColor(panelAlt, 0.82);
  if (accent) {
    tokens.accentDim = alphaColor(accent, 0.18);
    tokens.ok = accent;
  }
  if (textSecondary) tokens.textMuted = alphaColor(textSecondary, 0.72);
  tokens.shadow = '0 22px 70px rgba(0, 0, 0, 0.34)';
  return tokens;
}

function mergeDreamSkinSafeCssVars(tokens: CustomThemeTokens, cssText: string | null): CustomThemeTokens {
  if (!cssText) return tokens;
  const next = { ...tokens };
  const varPattern = /(--ds-theme-[a-z0-9-]+)\s*:\s*([^;{}]+);/gi;
  for (const match of cssText.matchAll(varPattern)) {
    const key = DREAMSKIN_CSS_VAR_MAP[match[1]];
    const value = cleanColor(match[2]);
    if (key && value) next[key] = value;
  }
  return next;
}

function buildThemeFromDreamSkin(themeJson: Record<string, unknown>, harnessHome: string, background?: { name: string; bytes: Buffer }, tokenOverride?: CustomThemeTokens): CustomTheme {
  const id = cleanThemeId(themeJson.id);
  const name = cleanThemeName(themeJson.name, id);
  const tokens = tokenOverride ?? tokensFromDreamSkinColors(themeJson.colors);
  if (!tokens.bgPrimary || !tokens.accent || !tokens.textPrimary) {
    throw new Error('DreamSkin theme.json must include colors.background, colors.accent, and colors.text.');
  }
  let backgroundPath: string | undefined;
  if (background) {
    if (background.bytes.length > MAX_THEME_IMAGE_BYTES) throw new Error('DreamSkin background image is larger than 10 MB.');
    const dir = customThemeDir(harnessHome, id);
    mkdirSync(dir, { recursive: true });
    backgroundPath = customThemeImagePath(harnessHome, id, background.name);
    writeFileSync(backgroundPath, background.bytes);
    writeFileSync(join(dir, 'theme.json'), JSON.stringify(themeJson, null, 2), 'utf8');
  }
  const art = recordValue(themeJson.art);
  const focusX = typeof art.focusX === 'number' && Number.isFinite(art.focusX) ? Math.min(1, Math.max(0, art.focusX)) : undefined;
  const focusY = typeof art.focusY === 'number' && Number.isFinite(art.focusY) ? Math.min(1, Math.max(0, art.focusY)) : undefined;
  return {
    id,
    name,
    source: 'dreamskin',
    tokens,
    backgroundPath,
    backgroundFocusX: focusX,
    backgroundFocusY: focusY,
    createdAt: nowIso()
  };
}

function buildThemeFromTasiJson(themeJson: Record<string, unknown>): CustomTheme {
  const id = cleanThemeId(themeJson.id);
  const name = cleanThemeName(themeJson.name, id);
  const tokens = recordValue(themeJson.tokens);
  const cleanTokens: CustomThemeTokens = {};
  for (const [key, value] of Object.entries(tokens)) {
    const color = key === 'shadow' ? (typeof value === 'string' ? value.trim().slice(0, 180) : undefined) : cleanColor(value);
    if (color && TASI_TOKEN_KEYS.has(key as keyof CustomThemeTokens)) cleanTokens[key as keyof CustomThemeTokens] = color;
  }
  if (Object.keys(cleanTokens).length === 0) throw new Error('Tasi theme JSON must include a tokens object.');
  return {
    id,
    name,
    source: 'tasi',
    tokens: cleanTokens,
    createdAt: nowIso()
  };
}

async function importZipTheme(buffer: Buffer, harnessHome: string): Promise<CustomTheme> {
  const zip = await JSZip.loadAsync(buffer);
  const themeEntry = zip.file('theme.json') ?? zip.file(/(^|\/)theme\.json$/i)[0];
  if (!themeEntry) throw new Error('Theme package must include theme.json.');
  const themePathPrefix = themeEntry.name.includes('/') ? themeEntry.name.slice(0, themeEntry.name.lastIndexOf('/') + 1) : '';
  const themeJson = parseJson(await themeEntry.async('string'));
  const imageName = typeof themeJson.image === 'string' ? themeJson.image : '';
  const imageEntry = imageName
    ? zip.file(`${themePathPrefix}${imageName}`) ?? zip.file(imageName)
    : zip.file(/(^|\/)background\.(webp|jpg|png)$/i)[0];
  if (!imageEntry) throw new Error('DreamSkin theme package must include background.webp, background.jpg, or background.png.');
  const cssEntry = zip.file(`${themePathPrefix}theme.css`) ?? zip.file('theme.css');
  let tokens = tokensFromDreamSkinColors(themeJson.colors);
  if (cssEntry) {
    tokens = mergeDreamSkinSafeCssVars(tokens, await cssEntry.async('string'));
  }
  return buildThemeFromDreamSkin(themeJson, harnessHome, {
    name: imageEntry.name.split('/').at(-1) || imageName || 'background.jpg',
    bytes: Buffer.from(await imageEntry.async('uint8array'))
  }, tokens);
}

export async function importThemePackage(harnessHome: string, req: ThemeImportRequest): Promise<CustomTheme> {
  const filename = req.filename.trim() || 'theme.zip';
  const buffer = Buffer.from(req.contentBase64, 'base64');
  if (buffer.length <= 0) throw new Error('Theme package is empty.');
  if (buffer.length > MAX_THEME_PACKAGE_BYTES) throw new Error('Theme package is larger than 32 MB.');
  if (/\.zip$/i.test(filename)) return importZipTheme(buffer, harnessHome);

  const parsed = parseJson(buffer.toString('utf8'));
  if (parsed.schemaVersion === 1 && parsed.colors) return buildThemeFromDreamSkin(parsed, harnessHome);
  return buildThemeFromTasiJson(parsed);
}
