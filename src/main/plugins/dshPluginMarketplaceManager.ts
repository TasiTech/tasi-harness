import type {
  DshMarketplaceBrowseResult,
  DshMarketplaceBrowseRequest,
  DshMarketplacePlugin,
  DshMarketplacePluginDetail,
  DshMarketplacePluginInstallRequest,
  DshMarketplacePluginVersion,
  DshSidecarPluginRecord
} from '../../shared/types.js';
import { DshSidecarManager } from './dshSidecarManager.js';

const SKILLHUB_BASE_URL = 'https://skillhub.cn';
const SKILLHUB_API_BASE_URL = 'https://api.skillhub.cn';
const REMOTE_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

type UnknownRecord = Record<string, unknown>;
type SkillHubPage = {
  plugins: DshMarketplacePlugin[];
  total?: number;
  page: number;
  pageSize: number;
};

export class DshPluginMarketplaceManager {
  constructor(private readonly sidecar: DshSidecarManager) {}

  async browse(input: string | DshMarketplaceBrowseRequest = ''): Promise<DshMarketplaceBrowseResult> {
    const req = normalizeBrowseRequest(input);
    const installed = await this.sidecar.list();
    const installedByKey = installedPluginKeyMap(installed.plugins);
    const page = await this.loadSkillHubPlugins(req.query, req.page, req.pageSize);
    return {
      source: {
        id: 'skillhub',
        name: 'SkillHub',
        homepage: `${SKILLHUB_BASE_URL}/plugins`
      },
      plugins: this.markInstalled(page.plugins, installedByKey),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      loaded: page.plugins.length,
      hasMore: page.total === undefined ? page.plugins.length >= page.pageSize : page.page * page.pageSize < page.total
    };
  }

  async detail(id: string): Promise<DshMarketplacePluginDetail> {
    const parsed = parsePluginId(id);
    const base = pluginFromIdentity(parsed.owner, parsed.slug);
    const installed = await this.sidecar.list();
    const installedByKey = installedPluginKeyMap(installed.plugins);
    const enriched = await this.fetchDetail(base).catch(() => base);
    const [marked] = this.markInstalled([enriched], installedByKey);
    return {
      ...marked,
      versions: await this.fetchVersions(marked).catch(() => []),
      manifestPreview: await this.fetchManifestPreview(marked).catch(() => undefined),
      readme: marked.readme ?? await this.fetchReadme(marked).catch(() => undefined)
    };
  }

  async install(req: DshMarketplacePluginInstallRequest): Promise<DshSidecarPluginRecord> {
    const version = req.version?.trim();
    const source = installSourceForVersion(req.plugin, version);
    const record = await this.sidecar.install({
      source,
      packageName: req.plugin.packageName
    });
    if (req.enable && record.status !== 'failed' && record.status !== 'incompatible') {
      return this.sidecar.enable({ id: record.id });
    }
    return record;
  }

  private async loadSkillHubPlugins(query: string, page: number, pageSize: number): Promise<SkillHubPage> {
    const cleanQuery = query.trim();
    try {
      const remote = await this.fetchSkillHubPage(page, pageSize, cleanQuery);
      if (remote.plugins.length > 0 || !cleanQuery) return remote;
      const fallbackPlugins = this.fallbackPlugins(cleanQuery);
      return { plugins: fallbackPlugins, total: remote.total, page, pageSize };
    } catch (error) {
      console.warn(`[plugins] SkillHub plugin API fetch failed, using static plugin-page fallback: ${conciseError(error)}`);
      const plugins = this.fallbackPlugins(cleanQuery);
      return { plugins, total: plugins.length, page, pageSize };
    }
  }

  private async fetchDetail(base: DshMarketplacePlugin): Promise<DshMarketplacePlugin> {
    const candidates = [
      base.owner ? `${SKILLHUB_API_BASE_URL}/api/v1/plugins/${encodeURIComponent(base.owner)}/${encodeURIComponent(base.slug)}` : '',
      `${SKILLHUB_API_BASE_URL}/api/v1/plugins/${encodeURIComponent(base.slug)}`,
      `${SKILLHUB_BASE_URL}/api/v1/plugins/${encodeURIComponent(base.slug)}`
    ].filter(Boolean);
    for (const url of candidates) {
      try {
        const data = await this.fetchJson<unknown>(url);
        const [normalized] = normalizePluginList(data);
        if (normalized) return { ...base, ...normalized, id: base.id, owner: base.owner, slug: base.slug };
      } catch {
        // Try the next known shape.
      }
    }
    return base;
  }

  private async fetchSkillHubPage(page: number, pageSize: number, query: string): Promise<SkillHubPage> {
    const direct = parseSkillHubPluginUrl(query);
    if (direct) {
      return { plugins: [pluginFromIdentity(direct.owner, direct.slug)], total: 1, page, pageSize };
    }
    const url = new URL('/api/v1/plugins', SKILLHUB_API_BASE_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(pageSize));
    url.searchParams.set('scope', 'verified');
    url.searchParams.set('sort', 'stars');
    const apiQuery = skillHubApiQuery(query);
    if (apiQuery && !apiQuery.includes('/')) url.searchParams.set('q', apiQuery);
    const data = await this.fetchJson<unknown>(url.toString());
    return {
      plugins: normalizePluginList(data),
      total: numberValue(asRecord(data).total),
      page,
      pageSize
    };
  }

  private async fetchVersions(plugin: DshMarketplacePlugin): Promise<DshMarketplacePluginVersion[]> {
    const detail = await this.fetchDetail(plugin);
    const versions = [
      stringValue(asRecord(asRecord(detail as unknown).manifest).version),
      detail.version
    ].filter(Boolean);
    return Array.from(new Set(versions)).map((version) => ({ version }));
  }

  private async fetchManifestPreview(plugin: DshMarketplacePlugin): Promise<string | undefined> {
    const data = await this.fetchJson<unknown>(
      plugin.owner
        ? `${SKILLHUB_API_BASE_URL}/api/v1/plugins/${encodeURIComponent(plugin.owner)}/${encodeURIComponent(plugin.slug)}`
        : `${SKILLHUB_API_BASE_URL}/api/v1/plugins/${encodeURIComponent(plugin.slug)}`
    );
    const manifest = asRecord(data).manifest;
    if (!manifest) return undefined;
    return JSON.stringify(manifest, null, 2);
  }

  private async fetchReadme(plugin: DshMarketplacePlugin): Promise<string | undefined> {
    if (!plugin.owner) return undefined;
    const response = await this.fetchWithTimeout(
      `${SKILLHUB_API_BASE_URL}/api/v1/plugins/${encodeURIComponent(plugin.owner)}/${encodeURIComponent(plugin.slug)}/readme`,
      { headers: { Accept: 'text/plain,text/markdown,*/*;q=0.5' } }
    );
    if (!response.ok) return undefined;
    return await response.text();
  }

  private fallbackPlugins(query: string): DshMarketplacePlugin[] {
    const direct = parseSkillHubPluginUrl(query);
    if (direct) return [pluginFromIdentity(direct.owner, direct.slug)];
    if (query.includes('/') && !query.includes(' ')) {
      const parsed = parsePluginId(query);
      return [pluginFromIdentity(parsed.owner, parsed.slug)];
    }
    const featured = [
      {
        ...pluginFromIdentity('xmanrui', 'dsh-im'),
        name: 'dsh-im',
        description: 'IM channel plugin for DSH-compatible agents: WeChat, Feishu, DingTalk, Slack, Telegram and more.'
      },
      {
        ...pluginFromIdentity('NanmiCoder', 'dsh-agent-teams'),
        name: 'dsh-agent-teams',
        description: 'Multi-agent team orchestration plugin with captain/member sessions, task DAGs and subagent scheduling.'
      },
      {
        ...pluginFromIdentity('superdesigndev', 'superdesign-skill'),
        name: 'superdesign-dsh',
        packageName: 'superdesign-dsh',
        installSource: 'github:superdesigndev/superdesign-skill',
        description: 'Superdesign DSH skill provider for frontend UI design workflows.'
      }
    ];
    return featured.filter((plugin) => matchesQuery(plugin, query));
  }

  private markInstalled(
    plugins: DshMarketplacePlugin[],
    installedByKey: Map<string, DshSidecarPluginRecord>
  ): DshMarketplacePlugin[] {
    return plugins.map((plugin) => {
      const installed = marketplacePluginKeys(plugin)
        .map((key) => installedByKey.get(key))
        .find((record): record is DshSidecarPluginRecord => Boolean(record));
      return {
        ...plugin,
        installed: Boolean(installed),
        installedPluginId: installed?.id,
        enabled: installed?.enabled,
        status: installed?.status
      };
    });
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchWithTimeout(url, { headers: { Accept: 'application/json,text/html;q=0.3,*/*;q=0.2' } });
    if (!response.ok) throw new Error(`Request failed: ${url} -> ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!contentType.includes('json') && text.trim().startsWith('<')) throw new Error(`Request returned HTML: ${url}`);
    return JSON.parse(text) as T;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function installedPluginKeyMap(plugins: DshSidecarPluginRecord[]): Map<string, DshSidecarPluginRecord> {
  const map = new Map<string, DshSidecarPluginRecord>();
  for (const plugin of plugins) {
    for (const key of installedPluginKeys(plugin)) {
      if (!map.has(key)) map.set(key, plugin);
    }
  }
  return map;
}

function installedPluginKeys(plugin: DshSidecarPluginRecord): string[] {
  return normalizedPluginKeys([
    plugin.id,
    plugin.packageName,
    plugin.source,
    pluginIdFromPackage(plugin.packageName),
    unscopedPackageName(plugin.packageName),
    githubSourceFromScopedPackage(plugin.packageName),
    githubSourceFromHomepage(plugin.source),
    packageNameFromGithubSource(plugin.source)
  ]);
}

function marketplacePluginKeys(plugin: DshMarketplacePlugin): string[] {
  return normalizedPluginKeys([
    plugin.id,
    plugin.packageName,
    plugin.installSource,
    plugin.owner && plugin.slug ? `${plugin.owner}/${plugin.slug}` : undefined,
    plugin.owner && plugin.slug ? `github:${plugin.owner}/${plugin.slug}` : undefined,
    plugin.owner && plugin.slug ? `@${plugin.owner}/${plugin.slug}` : undefined,
    plugin.slug,
    plugin.packageName ? pluginIdFromPackage(plugin.packageName) : undefined,
    plugin.packageName ? unscopedPackageName(plugin.packageName) : undefined,
    plugin.packageName ? githubSourceFromScopedPackage(plugin.packageName) : undefined,
    githubSourceFromHomepage(plugin.homepage),
    packageNameFromGithubSource(plugin.installSource)
  ]);
}

function normalizedPluginKeys(values: Array<string | undefined>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const clean = value?.trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    keys.add(lower);
    keys.add(lower.replace(/^github:/, ''));
    keys.add(pluginIdFromPackage(lower));
  }
  return [...keys];
}

function normalizePluginList(data: unknown): DshMarketplacePlugin[] {
  const items = pickArray(data);
  return items.map(normalizePlugin).filter((plugin): plugin is DshMarketplacePlugin => Boolean(plugin));
}

function pickArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const obj = asRecord(data);
  for (const key of ['items', 'plugins', 'data', 'results']) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (Array.isArray(nested.items)) return nested.items;
    if (Array.isArray(nested.plugins)) return nested.plugins;
  }
  return Object.keys(obj).length > 0 ? [obj] : [];
}

function normalizePlugin(item: unknown): DshMarketplacePlugin | null {
  const obj = asRecord(item);
  const owner = stringValue(obj.owner)
    || stringValue(obj.ownerHandle)
    || stringValue(obj.owner_handle)
    || stringValue(asRecord(obj.author).handle)
    || undefined;
  const slug = stringValue(obj.slug)
    || stringValue(obj.name)
    || stringValue(obj.fullName)
    || stringValue(obj.id)
    || '';
  if (!slug) return null;
  const cleanSlug = slug.includes('/') ? slug.split('/').filter(Boolean).pop() || slug : slug;
  const cleanOwner = owner || (slug.includes('/') ? slug.split('/').filter(Boolean)[0] : undefined);
  const homepage = stringValue(obj.homepage)
    || stringValue(obj.url)
    || `${SKILLHUB_BASE_URL}/plugins/${cleanOwner ? `${encodeURIComponent(cleanOwner)}/` : ''}${encodeURIComponent(cleanSlug)}`;
  const manifest = asRecord(obj.manifest);
  const packageName = stringValue(obj.packageName)
    || stringValue(obj.package_name)
    || stringValue(manifest.name)
    || packageNameFromIdentity(cleanOwner, cleanSlug);
  const repositoryUrl = stringValue(obj.repositoryUrl)
    || stringValue(obj.repository_url)
    || stringValue(asRecord(manifest.repository).url);
  const installSource = stringValue(obj.installSource)
    || stringValue(obj.install_source)
    || stringValue(obj.packageSpec)
    || stringValue(obj.package_spec)
    || packageName
    || stringValue(obj.repository)
    || githubSourceFromHomepage(repositoryUrl)
    || stringValue(obj.repo)
    || githubSourceFromHomepage(homepage)
    || (cleanOwner ? `github:${cleanOwner}/${cleanSlug}` : packageName);
  return {
    id: cleanOwner ? `${cleanOwner}/${cleanSlug}` : cleanSlug,
    sourceId: 'skillhub',
    owner: cleanOwner,
    slug: cleanSlug,
    name: stringValue(obj.title) || stringValue(obj.displayName) || stringValue(obj.name) || cleanSlug,
    description: stringValue(obj.description) || stringValue(manifest.description) || stringValue(obj.summary) || 'SkillHub DSH plugin.',
    version: stringValue(obj.version) || stringValue(manifest.version) || stringValue(obj.latestVersion) || stringValue(obj.latest_version) || 'latest',
    homepage,
    packageName,
    installSource,
    readme: stringValue(obj.readme) || stringValue(obj.readmeMd) || stringValue(obj.markdown) || undefined,
    tags: arrayOfStrings(obj.tags) ?? arrayOfStrings(obj.topics),
    downloads: numberValue(obj.downloads) ?? numberValue(obj.downloadCount) ?? numberValue(obj.stars),
    installed: false
  };
}

function pluginFromIdentity(owner: string | undefined, slug: string): DshMarketplacePlugin {
  const packageName = packageNameFromIdentity(owner, slug);
  return {
    id: owner ? `${owner}/${slug}` : slug,
    sourceId: 'skillhub',
    owner,
    slug,
    name: slug,
    description: 'SkillHub DSH plugin. Preview details are loaded from the public plugin registry when available.',
    version: 'latest',
    homepage: `${SKILLHUB_BASE_URL}/plugins/${owner ? `${encodeURIComponent(owner)}/` : ''}${encodeURIComponent(slug)}`,
    packageName,
    installSource: packageName,
    installed: false
  };
}

function installSourceForVersion(plugin: DshMarketplacePlugin, version?: string): string {
  const base = plugin.packageName || plugin.installSource;
  if (!version || version === 'latest') return base;
  if (base.startsWith('@')) {
    const [scope, name] = base.split('/');
    return scope && name ? `${scope}/${name}@${version}` : base;
  }
  if (/^[a-zA-Z0-9._-]+$/.test(base)) return `${base}@${version}`;
  return plugin.installSource.startsWith('github:') ? `${plugin.installSource}#${version}` : plugin.installSource;
}

function packageNameFromIdentity(owner: string | undefined, slug: string): string {
  return owner ? `@${owner.toLowerCase()}/${slug}` : slug;
}

function parsePluginId(id: string): { owner?: string; slug: string } {
  const clean = id.trim()
    .replace(/^https?:\/\/(?:www\.)?skillhub\.cn\/plugins\//i, '')
    .replace(/^https?:\/\/api\.skillhub\.cn\/api\/v1\/plugins\//i, '');
  const [ownerOrSlug = '', maybeSlug] = clean.split('/').filter(Boolean);
  return maybeSlug ? { owner: ownerOrSlug, slug: maybeSlug } : { slug: ownerOrSlug };
}

function parseSkillHubPluginUrl(value: string): { owner?: string; slug: string } | null {
  try {
    const url = new URL(value.trim());
    if (url.hostname !== 'skillhub.cn' || !url.pathname.startsWith('/plugins/')) return null;
    return parsePluginId(url.pathname.replace(/^\/plugins\//, ''));
  } catch {
    return null;
  }
}

function matchesQuery(plugin: DshMarketplacePlugin, query: string): boolean {
  if (!query) return true;
  const haystack = [plugin.id, plugin.name, plugin.description, plugin.owner, plugin.slug, ...(plugin.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
  const needle = query.toLowerCase();
  const compactNeedle = compactSearchText(needle);
  return haystack.includes(needle) || Boolean(compactNeedle && compactSearchText(haystack).includes(compactNeedle));
}

function skillHubApiQuery(query: string): string {
  return query
    .trim()
    .replace(/['"`‘’“”]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff\uf900-\ufaff]+/g, '');
}

function conciseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function githubSourceFromHomepage(homepage: string): string | undefined {
  try {
    const url = new URL(homepage);
    if (url.hostname !== 'github.com') return undefined;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner && repo ? `github:${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

function githubSourceFromScopedPackage(packageName: string): string | undefined {
  const clean = packageName.trim();
  if (!clean.startsWith('@') || !clean.includes('/')) return undefined;
  const [scope, name] = clean.slice(1).split('/');
  return scope && name ? `github:${scope}/${name}` : undefined;
}

function packageNameFromGithubSource(source: string): string | undefined {
  const clean = source.trim().replace(/^github:/i, '').replace(/^https?:\/\/github\.com\//i, '');
  const [owner, repoWithSuffix] = clean.split('/').filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/i, '').replace(/#.+$/, '');
  return owner && repo ? repo : undefined;
}

function unscopedPackageName(packageName: string): string | undefined {
  const clean = packageName.trim();
  if (!clean.startsWith('@') || !clean.includes('/')) return undefined;
  const base = clean.split('/').filter(Boolean).pop();
  return base && base !== clean ? base : undefined;
}

function pluginIdFromPackage(packageName: string): string {
  return packageName.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return items.length > 0 ? items : undefined;
}

function normalizeBrowseRequest(input: string | DshMarketplaceBrowseRequest): Required<DshMarketplaceBrowseRequest> {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : { query: typeof input === 'string' ? input : '' };
  const page = Math.max(1, Math.floor(Number(raw.page) || 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(raw.pageSize) || DEFAULT_PAGE_SIZE)));
  return {
    query: typeof raw.query === 'string' ? raw.query.trim() : '',
    page,
    pageSize
  };
}
