import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AppBrandingSettings, AppConfig, AppTheme, CustomTheme, CustomThemeTokens, PublicAppConfig } from '../../shared/types.js';
import { isOmniProviderKind, normalizeProviderKind, omniProviderDefaultBaseUrl, omniProviderDefaultModel } from '../../shared/providerCatalog.js';
import { defaultConfig, ensureDir } from './pathUtils.js';
import { JsonFileStore } from './jsonFileStore.js';

const REASONING_EFFORTS = new Set(['auto', 'none', 'low', 'medium', 'xhigh']);
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const MAX_BRAND_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_THEME_BACKGROUND_BYTES = 10 * 1024 * 1024;

function cleanText(value: unknown, fallback: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim().slice(0, maxLength);
  return clean || (allowEmpty ? '' : fallback);
}

function sanitizeBranding(input: unknown, defaults: AppBrandingSettings): AppBrandingSettings {
  const raw = input && typeof input === 'object' ? input as Partial<AppBrandingSettings> : {};
  return {
    productName: cleanText(raw.productName, defaults.productName, 80),
    logoPath: cleanText(raw.logoPath, defaults.logoPath, 1000, true),
    logoInitials: cleanText(raw.logoInitials, defaults.logoInitials, 8)
  };
}

function sanitizeTheme(input: unknown, fallback: AppTheme, customThemes: CustomTheme[]): AppTheme {
  if (input === 'dark' || input === 'light' || input === 'tech') return input;
  if (typeof input === 'string' && input.startsWith('custom:')) {
    const id = input.slice('custom:'.length);
    if (customThemes.some((theme) => theme.id === id)) return input as AppTheme;
  }
  return fallback;
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().slice(0, maxLength);
  return clean || undefined;
}

function cleanOptionalColor(value: unknown): string {
  const clean = cleanOptionalText(value, 80);
  if (!clean) return '';
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(clean)) return clean;
  if (/^rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(clean)) return clean;
  return '';
}

function sanitizeReasoningEffort(value: unknown, fallback: AppConfig['reasoningEffort']): AppConfig['reasoningEffort'] {
  if (value === 'high') return 'xhigh';
  return REASONING_EFFORTS.has(value as string) ? value as AppConfig['reasoningEffort'] : fallback;
}

function sanitizeCustomThemeTokens(input: unknown): CustomThemeTokens {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const allowed = [
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
  ] as const;
  const tokens: CustomThemeTokens = {};
  for (const key of allowed) {
    const value = cleanOptionalText(raw[key], 160);
    if (value) tokens[key] = value;
  }
  return tokens;
}

function sanitizeCustomThemes(input: unknown): CustomTheme[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const themes: CustomTheme[] = [];
  for (const item of input) {
    const raw = item && typeof item === 'object' ? item as Partial<CustomTheme> : {};
    const id = cleanOptionalText(raw.id, 64);
    const name = cleanOptionalText(raw.name, 80);
    if (!id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || !name || seen.has(id)) continue;
    const tokens = sanitizeCustomThemeTokens(raw.tokens);
    if (Object.keys(tokens).length === 0) continue;
    seen.add(id);
    themes.push({
      id,
      name,
      source: raw.source === 'dreamskin' ? 'dreamskin' : 'tasi',
      tokens,
      backgroundPath: cleanOptionalText(raw.backgroundPath, 1000),
      backgroundFocusX: typeof raw.backgroundFocusX === 'number' && Number.isFinite(raw.backgroundFocusX) ? Math.min(1, Math.max(0, raw.backgroundFocusX)) : undefined,
      backgroundFocusY: typeof raw.backgroundFocusY === 'number' && Number.isFinite(raw.backgroundFocusY) ? Math.min(1, Math.max(0, raw.backgroundFocusY)) : undefined,
      createdAt: cleanOptionalText(raw.createdAt, 40) || new Date(0).toISOString()
    });
  }
  return themes;
}

function imageDataUrl(imagePath: string, maxBytes: number): string | undefined {
  const ext = extname(imagePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) return undefined;
  try {
    if (!existsSync(imagePath)) return undefined;
    const stat = statSync(imagePath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return `data:${mimeType};base64,${readFileSync(imagePath).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function logoDataUrl(logoPath: string): string | undefined {
  return imageDataUrl(logoPath, MAX_BRAND_LOGO_BYTES);
}

export class ConfigStore {
  private readonly store: JsonFileStore<AppConfig>;

  constructor(private readonly harnessHome: string) {
    ensureDir(harnessHome);
    this.store = new JsonFileStore<AppConfig>(join(harnessHome, 'config.json'), defaultConfig);
    const cfg = this.get();
    ensureDir(cfg.workspaceDir);
  }

  get(): AppConfig {
    const defaults = defaultConfig();
    const merged = { ...defaults, ...this.store.read() };
    merged.branding = sanitizeBranding(merged.branding, defaults.branding);
    merged.customThemes = sanitizeCustomThemes(merged.customThemes);
    merged.provider = normalizeProviderKind(merged.provider);
    merged.omniProvider = normalizeProviderKind(merged.omniProvider);
    if (!isOmniProviderKind(merged.omniProvider)) merged.omniProvider = defaults.omniProvider;
    merged.omniBaseUrl = cleanText(merged.omniBaseUrl, defaults.omniBaseUrl, 1000);
    merged.omniModel = cleanText(merged.omniModel, omniProviderDefaultModel(merged.omniProvider), 200);
    if (!merged.omniBaseUrl) merged.omniBaseUrl = omniProviderDefaultBaseUrl(merged.omniProvider);
    merged.omniApiKey = typeof merged.omniApiKey === 'string' ? merged.omniApiKey : defaults.omniApiKey;
    merged.reasoningEffort = sanitizeReasoningEffort(merged.reasoningEffort, defaults.reasoningEffort);
    merged.temperature = Number.isFinite(merged.temperature) ? merged.temperature : defaults.temperature;
    merged.maxIterations = Math.max(1, Math.min(200, Number(merged.maxIterations) || defaults.maxIterations));
    merged.sessionDocumentMaxDocs = Math.max(1, Math.min(100, Number(merged.sessionDocumentMaxDocs) || defaults.sessionDocumentMaxDocs));
    if (!merged.workspaceDir) merged.workspaceDir = defaults.workspaceDir;
    const approval = merged.safetyApproval ?? defaults.safetyApproval;
    merged.safetyApproval = {
      enabled: approval.enabled !== false,
      approveRiskyTerminalCommands: approval.approveRiskyTerminalCommands !== false,
      timeoutMs: Math.max(5000, Math.min(300000, Number(approval.timeoutMs) || defaults.safetyApproval.timeoutMs)),
      neverAskAgainKeys: Array.isArray(approval.neverAskAgainKeys)
        ? [...new Set(approval.neverAskAgainKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0))]
        : []
    };
    merged.defaultExecutionMode = merged.defaultExecutionMode === 'sandbox' ? 'sandbox' : 'workspace';
    merged.browserMode = merged.browserMode === 'external' ? 'external' : 'embedded';
    merged.externalBrowserEngine =
      merged.externalBrowserEngine === 'cdp' || merged.externalBrowserEngine === 'webdriver-safari' || merged.externalBrowserEngine === 'auto'
        ? merged.externalBrowserEngine
        : defaults.externalBrowserEngine;
    const cdpEndpoint = typeof merged.externalBrowserCdpEndpoint === 'string' ? merged.externalBrowserCdpEndpoint.trim() : '';
    merged.externalBrowserCdpEndpoint = cdpEndpoint || defaults.externalBrowserCdpEndpoint;
    merged.externalBrowserProfileMode = merged.externalBrowserProfileMode === 'system' ? 'system' : 'isolated';
    merged.browserHeadless = merged.browserHeadless === true;
    merged.browserExecutionLoggingEnabled = merged.browserExecutionLoggingEnabled === true;
    merged.theme = sanitizeTheme(merged.theme, defaults.theme, merged.customThemes);
    merged.textBrightness = Math.max(70, Math.min(150, Number(merged.textBrightness) || defaults.textBrightness));
    merged.textColor = cleanOptionalColor(merged.textColor);
    merged.omniSystemPrompt = cleanText(merged.omniSystemPrompt, defaults.omniSystemPrompt, 12000);
    merged.skillMarketSources = Array.isArray(merged.skillMarketSources) && merged.skillMarketSources.length > 0 ? merged.skillMarketSources : defaults.skillMarketSources;
    const configuredTools = Array.isArray(merged.enabledToolNames) ? merged.enabledToolNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : [];
    merged.enabledToolNames = [...new Set([...configuredTools, ...defaults.enabledToolNames])];
    merged.emailNotifications = {
      ...defaults.emailNotifications,
      ...merged.emailNotifications
    };
    merged.wechatChannel = {
      ...defaults.wechatChannel,
      ...merged.wechatChannel,
      pluginName: 'clawbot'
    };
    return merged;
  }

  publicConfig(includeApiKey = false): PublicAppConfig {
    const cfg = this.get();
    const pub: PublicAppConfig = {
      ...cfg,
      branding: {
        ...cfg.branding,
        logoDataUrl: cfg.branding.logoPath ? logoDataUrl(cfg.branding.logoPath) : undefined
      },
      customThemes: cfg.customThemes.map((theme) => ({
        ...theme,
        backgroundDataUrl: theme.backgroundPath ? imageDataUrl(theme.backgroundPath, MAX_THEME_BACKGROUND_BYTES) : undefined
      })),
      apiKey: includeApiKey ? cfg.apiKey : undefined,
      apiKeyConfigured: Boolean(cfg.apiKey),
      omniApiKey: includeApiKey ? cfg.omniApiKey : undefined,
      omniApiKeyConfigured: Boolean(cfg.omniApiKey),
      emailNotifications: {
        ...cfg.emailNotifications,
        password: undefined,
        passwordConfigured: Boolean(cfg.emailNotifications.password)
      }
    };
    if (!includeApiKey) delete pub.apiKey;
    if (!includeApiKey) delete pub.omniApiKey;
    delete pub.emailNotifications.password;
    return pub;
  }

  update(partial: Partial<AppConfig>): AppConfig {
    const current = this.get();
    const next: AppConfig = {
      ...current,
      ...partial,
      enabledToolNames: partial.enabledToolNames ?? current.enabledToolNames,
      safetyApproval: {
        ...current.safetyApproval,
        ...(partial.safetyApproval ?? {}),
        neverAskAgainKeys: partial.safetyApproval?.neverAskAgainKeys ?? current.safetyApproval.neverAskAgainKeys
      },
      skillMarketSources: partial.skillMarketSources ?? current.skillMarketSources,
      emailNotifications: {
        ...current.emailNotifications,
        ...(partial.emailNotifications ?? {}),
        password: typeof partial.emailNotifications?.password === 'string' && partial.emailNotifications.password.length > 0
          ? partial.emailNotifications.password
          : current.emailNotifications.password
      },
      customThemes: sanitizeCustomThemes(partial.customThemes ?? current.customThemes),
      omniApiKey: typeof partial.omniApiKey === 'string' && partial.omniApiKey.length > 0
        ? partial.omniApiKey
        : current.omniApiKey,
      wechatChannel: {
        ...current.wechatChannel,
        ...(partial.wechatChannel ?? {}),
        pluginName: 'clawbot'
      },
      branding: sanitizeBranding(partial.branding ?? current.branding, current.branding)
    };
    next.reasoningEffort = sanitizeReasoningEffort(next.reasoningEffort, current.reasoningEffort);
    ensureDir(next.workspaceDir);
    this.store.write(next);
    return next;
  }
}
