import { createHash } from 'node:crypto';
import type {
  DreamSkinGalleryQuery,
  DreamSkinGalleryResult,
  DreamSkinGalleryTheme,
  DreamSkinThemeInstallRequest,
  PublicAppConfig
} from '../../shared/types.js';
import type { ConfigStore } from './configStore.js';
import { importThemePackage } from './themeImporter.js';

const DREAMSKIN_API_BASE = 'https://api.dreamskin.cc';
const MAX_GALLERY_LIMIT = 24;
const DEFAULT_GALLERY_LIMIT = 12;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const VERSION_ID_RE = /^ver_[a-z0-9]{8,64}$/i;

interface DreamSkinApiListResponse {
  items?: unknown[];
  total?: number;
  limit?: number;
  offset?: number;
}

function cleanText(value: unknown, fallback: string, maxLength = 160): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim().slice(0, maxLength);
  return clean || fallback;
}

function cleanNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cleanOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanDisplayMeta(input: unknown): DreamSkinGalleryTheme['displayMeta'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const colors = raw.colors && typeof raw.colors === 'object'
    ? Object.fromEntries(
      Object.entries(raw.colors as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .slice(0, 20)
    )
    : undefined;
  const art = raw.art && typeof raw.art === 'object' ? raw.art as Record<string, unknown> : undefined;
  return {
    appearance: raw.appearance === 'auto' || raw.appearance === 'light' || raw.appearance === 'dark' ? raw.appearance : undefined,
    colors,
    art: art
      ? {
        focusX: cleanOptionalNumber(art.focusX),
        focusY: cleanOptionalNumber(art.focusY),
        safeArea: typeof art.safeArea === 'string' ? art.safeArea : undefined,
        taskMode: typeof art.taskMode === 'string' ? art.taskMode : undefined
      }
      : undefined
  };
}

function cleanTheme(input: unknown): DreamSkinGalleryTheme | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const id = cleanText(raw.id, '');
  if (!VERSION_ID_RE.test(id)) return undefined;
  return {
    id,
    themeId: cleanText(raw.themeId, id, 120),
    slug: cleanText(raw.slug, id, 120),
    name: cleanText(raw.name, id, 120),
    authorDisplayName: cleanText(raw.authorDisplayName, 'DreamSkin', 120),
    version: cleanText(raw.version, '0.0.0', 40),
    license: cleanText(raw.license, 'unknown', 80),
    packageBytes: cleanNumber(raw.packageBytes),
    downloadCount: cleanNumber(raw.downloadCount),
    reviewedAt: typeof raw.reviewedAt === 'string' ? raw.reviewedAt : undefined,
    submittedAt: typeof raw.submittedAt === 'string' ? raw.submittedAt : undefined,
    displayMeta: cleanDisplayMeta(raw.displayMeta)
  };
}

function imageDataUrl(bytes: Uint8Array, mimeType: string): string | undefined {
  if (!mimeType.startsWith('image/') || bytes.length > MAX_THUMBNAIL_BYTES) return undefined;
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`DreamSkin request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`DreamSkin download failed: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream'
  };
}

async function withThumbnail(theme: DreamSkinGalleryTheme): Promise<DreamSkinGalleryTheme> {
  try {
    const { bytes, mimeType } = await fetchBytes(`${DREAMSKIN_API_BASE}/v1/themes/${encodeURIComponent(theme.id)}/preview/thumbnail`);
    return { ...theme, thumbnailDataUrl: imageDataUrl(bytes, mimeType) };
  } catch {
    return theme;
  }
}

export async function listDreamSkinGallery(query: DreamSkinGalleryQuery = {}): Promise<DreamSkinGalleryResult> {
  const limit = Math.min(MAX_GALLERY_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_GALLERY_LIMIT)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const sort = query.sort === 'popular' ? 'popular' : 'recent';
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort
  });
  const raw = await fetchJson(`${DREAMSKIN_API_BASE}/v1/themes?${params.toString()}`) as DreamSkinApiListResponse;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(cleanTheme)
    .filter((item): item is DreamSkinGalleryTheme => Boolean(item));
  const withImages = await Promise.all(items.map(withThumbnail));
  return {
    items: withImages,
    total: cleanNumber(raw.total, withImages.length),
    limit: cleanNumber(raw.limit, limit),
    offset: cleanNumber(raw.offset, offset)
  };
}

export async function installDreamSkinTheme(
  harnessHome: string,
  configStore: ConfigStore,
  req: DreamSkinThemeInstallRequest
): Promise<PublicAppConfig> {
  const themeVersionId = cleanText(req.themeVersionId, '');
  if (!VERSION_ID_RE.test(themeVersionId)) throw new Error('Invalid DreamSkin theme id.');
  const { bytes, mimeType } = await fetchBytes(`${DREAMSKIN_API_BASE}/v1/themes/${encodeURIComponent(themeVersionId)}/download`);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('DreamSkin theme package is too large.');
  if (mimeType && mimeType !== 'application/zip' && mimeType !== 'application/octet-stream') {
    throw new Error(`Unexpected DreamSkin package type: ${mimeType}`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const filename = `${cleanText(req.name, 'dreamskin-theme', 80).replace(/[^a-z0-9._-]+/gi, '-')}-${hash}.zip`;
  const theme = await importThemePackage(harnessHome, {
    filename,
    contentBase64: Buffer.from(bytes).toString('base64')
  });
  const config = configStore.get();
  const next = configStore.update({
    customThemes: [
      theme,
      ...config.customThemes.filter((item) => item.id !== theme.id)
    ],
    theme: `custom:${theme.id}`
  });
  return { ...configStore.publicConfig(false), apiKeyConfigured: Boolean(next.apiKey) };
}
