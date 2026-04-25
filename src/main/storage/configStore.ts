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
    const merged = { ...defaultConfig(), ...this.store.read() };
    merged.provider = normalizeProviderKind(merged.provider);
    merged.temperature = Number.isFinite(merged.temperature) ? merged.temperature : defaultConfig().temperature;
    merged.maxIterations = Math.max(1, Math.min(32, Number(merged.maxIterations) || defaultConfig().maxIterations));
    if (!merged.workspaceDir) merged.workspaceDir = defaultConfig().workspaceDir;
    merged.defaultExecutionMode = merged.defaultExecutionMode === 'sandbox' ? 'sandbox' : 'workspace';
    merged.opencliBridgeMode = merged.opencliBridgeMode === 'external' ? 'external' : 'embedded';
    merged.opencliExtensionPath = typeof merged.opencliExtensionPath === 'string' ? merged.opencliExtensionPath : defaultConfig().opencliExtensionPath;
    merged.skillMarketSources = Array.isArray(merged.skillMarketSources) && merged.skillMarketSources.length > 0 ? merged.skillMarketSources : defaultConfig().skillMarketSources;
    const configuredTools = Array.isArray(merged.enabledToolNames) ? merged.enabledToolNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : [];
    merged.enabledToolNames = [...new Set([...configuredTools, ...defaultConfig().enabledToolNames])];
    merged.emailNotifications = {
      ...defaultConfig().emailNotifications,
      ...merged.emailNotifications
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
      }
    };
    ensureDir(next.workspaceDir);
    this.store.write(next);
    return next;
  }
}
