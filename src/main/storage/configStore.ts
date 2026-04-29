import { join } from 'node:path';
import type { AppConfig, PublicAppConfig } from '../../shared/types.js';
import { normalizeProviderKind } from '../../shared/providerCatalog.js';
import { defaultConfig, ensureDir } from './pathUtils.js';
import { JsonFileStore } from './jsonFileStore.js';

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
    merged.provider = normalizeProviderKind(merged.provider);
    merged.temperature = Number.isFinite(merged.temperature) ? merged.temperature : defaults.temperature;
    merged.maxIterations = Math.max(1, Math.min(50, Number(merged.maxIterations) || defaults.maxIterations));
    merged.sessionDocumentMaxDocs = Math.max(1, Math.min(100, Number(merged.sessionDocumentMaxDocs) || defaults.sessionDocumentMaxDocs));
    if (!merged.workspaceDir) merged.workspaceDir = defaults.workspaceDir;
    merged.defaultExecutionMode = merged.defaultExecutionMode === 'sandbox' ? 'sandbox' : 'workspace';
    merged.browserMode = merged.browserMode === 'external' ? 'external' : 'embedded';
    merged.externalBrowserEngine =
      merged.externalBrowserEngine === 'cdp' || merged.externalBrowserEngine === 'webdriver-safari' || merged.externalBrowserEngine === 'auto'
        ? merged.externalBrowserEngine
        : defaults.externalBrowserEngine;
    const cdpEndpoint = typeof merged.externalBrowserCdpEndpoint === 'string' ? merged.externalBrowserCdpEndpoint.trim() : '';
    merged.externalBrowserCdpEndpoint = cdpEndpoint || defaults.externalBrowserCdpEndpoint;
    merged.externalBrowserProfileMode = merged.externalBrowserProfileMode === 'system' ? 'system' : 'isolated';
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
      apiKey: includeApiKey ? cfg.apiKey : undefined,
      apiKeyConfigured: Boolean(cfg.apiKey),
      emailNotifications: {
        ...cfg.emailNotifications,
        password: undefined,
        passwordConfigured: Boolean(cfg.emailNotifications.password)
      }
    };
    if (!includeApiKey) delete pub.apiKey;
    delete pub.emailNotifications.password;
    return pub;
  }

  update(partial: Partial<AppConfig>): AppConfig {
    const current = this.get();
    const next: AppConfig = {
      ...current,
      ...partial,
      enabledToolNames: partial.enabledToolNames ?? current.enabledToolNames,
      skillMarketSources: partial.skillMarketSources ?? current.skillMarketSources,
      emailNotifications: {
        ...current.emailNotifications,
        ...(partial.emailNotifications ?? {}),
        password: typeof partial.emailNotifications?.password === 'string' && partial.emailNotifications.password.length > 0
          ? partial.emailNotifications.password
          : current.emailNotifications.password
      },
      wechatChannel: {
        ...current.wechatChannel,
        ...(partial.wechatChannel ?? {}),
        pluginName: 'clawbot'
      }
    };
    ensureDir(next.workspaceDir);
    this.store.write(next);
    return next;
  }
}
