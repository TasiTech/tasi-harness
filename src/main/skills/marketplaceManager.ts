import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceBrowseRequest, MarketplaceBrowseResult, MarketplaceSkill, MarketplaceSkillSnapshot, SkillInstallRequest, SkillMarketplaceSource, SkillSupportingFile } from '../../shared/types.js';
import { parseSkillMarkdown, SkillManager } from './skillManager.js';

const CLAWHUB_BASE_URL = 'https://clawhub.ai';
const CLAWHUB_FALLBACK_CONVEX_URL = 'https://wry-manatee-359.convex.cloud';
const CLAWHUB_FALLBACK_CONVEX_SITE_URL = 'https://wry-manatee-359.convex.site';
const SKILLHUB_BASE_URL = 'https://skillhub.cn';
const SKILLHUB_API_BASE_URL = 'https://api.skillhub.cn';
const REMOTE_TIMEOUT_MS = 12_000;
const MAX_CLAWHUB_SKILLS = 80;
const MAX_SKILLHUB_SKILLS = 1000;
const DEFAULT_MARKET_PAGE_SIZE = 24;
const MAX_MARKET_PAGE_SIZE = 100;
const SEARCH_SYNONYM_GROUPS = [
  ['\u5c0f\u7ea2\u4e66', 'xiaohongshu', 'rednote']
];

interface CatalogFile {
  market?: {
    id?: string;
    name?: string;
    description?: string;
  };
  skills?: Array<{
    id: string;
    name: string;
    description: string;
    category?: string;
    version?: string;
    readme?: string;
    skillContent: string;
    supportingFiles?: SkillSupportingFile[];
    files?: SkillSupportingFile[];
    homepage?: string;
  }>;
}

interface ClawHubSkillListItem {
  skill?: {
    _id?: string;
    slug?: string;
    displayName?: string;
    summary?: string;
    capabilityTags?: unknown;
  };
  latestVersion?: {
    _id?: string;
    version?: string;
  };
  owner?: {
    handle?: string;
  };
  ownerHandle?: string;
}

interface ClawHubBrowseResponse {
  status?: string;
  value?: {
    page?: unknown[];
    hasMore?: boolean;
    nextCursor?: string;
  };
}

interface ClawHubSearchSkillItem {
  skill?: {
    _id?: string;
    slug?: string;
    displayName?: string;
    summary?: string;
    capabilityTags?: unknown;
    latestVersionId?: string;
  };
  version?: {
    _id?: string;
    version?: string;
  } | null;
  owner?: {
    handle?: string;
  };
  ownerHandle?: string;
}

interface ClawHubSearchResponse {
  status?: string;
  value?: unknown[];
}

interface ClawHubReadmeResponse {
  status?: string;
  value?: {
    text?: string;
  };
}

interface SkillHubDetailResult {
  skillContent: string;
  readme: string;
  version?: string;
  installCommand?: string;
}

interface SkillHubBrowseResponse {
  code?: number;
  data?: {
    skills?: unknown[];
    total?: number;
  };
  message?: string;
}

interface SkillHubDetailResponse {
  contentZhAvailable?: boolean;
  latestVersion?: {
    changelog?: string;
    version?: string;
  };
  namespace?: {
    canonicalName?: string;
    displayName?: string;
    handle?: string;
    publicSlug?: string;
  };
  owner?: {
    displayName?: string;
    handle?: string;
  };
  skill?: {
    category?: string;
    displayName?: string;
    labels?: Record<string, string>;
    slug?: string;
    source?: string;
    sourceUrl?: string | null;
    stats?: {
      downloads?: number;
      installs?: number;
      stars?: number;
      versions?: number;
    };
    subCategories?: Array<{ key?: string; name?: string }>;
    summary?: string;
    summary_zh?: string;
    tags?: Record<string, string>;
    upstream_url?: string | null;
    verified?: boolean;
  };
  slug?: string;
}

interface NormalizedMarketplaceBrowseRequest {
  query: string;
  page: number;
  pageSize: number;
}

export class MarketplaceManager {
  private clawHubConvexUrl: string | undefined;

  constructor(
    private readonly resourcesRoot: string,
    private readonly skillManager: SkillManager,
    private readonly getSources: () => SkillMarketplaceSource[]
  ) {}

  async browse(input: string | MarketplaceBrowseRequest = ''): Promise<MarketplaceBrowseResult> {
    const req = this.normalizeBrowseRequest(input);
    const installed = this.skillManager.list();
    const searchTerms = this.expandSearchTerms(req.query);
    const end = req.page * req.pageSize;
    const loadLimit = end + 1;
    const loadedSkills = await Promise.all(
      this.getSources()
        .filter((source) => source.enabled)
        .map(async (source) => {
          try {
            return await this.loadSource(source, searchTerms, loadLimit);
          } catch (error) {
            console.warn(`[marketplace] failed to load source ${source.id}:`, error);
            return [];
          }
        })
    );
    const allSkills = loadedSkills
      .flat()
      .filter((skill) => {
        if (searchTerms.length === 0) return true;
        const haystack = `${skill.name}\n${skill.description}\n${skill.category}\n${skill.readme}\n${skill.sourceName}\n${skill.sourceId}`.toLowerCase();
        return searchTerms.some((term) => haystack.includes(term));
      })
      .map((skill) => {
        const installedSkill = installed.find((item) => item.marketplaceSourceId === skill.sourceId && item.marketplaceSkillId === skill.id);
        return {
          ...skill,
          installed: Boolean(installedSkill),
          installedSkillName: installedSkill?.name
        };
      });
    const start = (req.page - 1) * req.pageSize;
    const skills = allSkills.slice(start, end);
    return {
      sources: this.getSources(),
      skills,
      page: req.page,
      pageSize: req.pageSize,
      total: allSkills.length,
      loaded: skills.length,
      hasMore: allSkills.length > end
    };
  }

  async install(req: SkillInstallRequest): Promise<MarketplaceSkill> {
    const catalogSkill = await this.resolveSkillForInstall(req);
    if (!catalogSkill) throw new Error('Marketplace skill not found.');
    const sourceId = req.sourceId.toLowerCase();
    let skillContent = catalogSkill.skillContent;
    let readme = catalogSkill.readme;
    let version = catalogSkill.version;
    let installCommand = catalogSkill.installCommand;

    if (sourceId === 'clawhub') {
      const installedFromArchive = await this.installClawHubArchive(catalogSkill, req);
      if (installedFromArchive) {
        return {
          ...catalogSkill,
          version,
          readme,
          skillContent,
          installCommand,
          installed: true,
          installedSkillName: installedFromArchive.name
        };
      }
      const readmeText = await this.fetchClawHubReadme(catalogSkill.remoteVersionId);
      if (readmeText) {
        skillContent = readmeText;
        readme = this.previewFromSkillContent(readmeText);
      }
    } else if (sourceId === 'skillhub') {
      const detail = await this.fetchSkillHubDetail(catalogSkill.homepage ?? `${SKILLHUB_BASE_URL}/skills/${encodeURIComponent(catalogSkill.id)}`, catalogSkill);
      if (detail) {
        skillContent = detail.skillContent;
        readme = detail.readme;
        version = detail.version ?? version;
        installCommand = detail.installCommand ?? installCommand;
      }
    }

    const parsed = parseSkillMarkdown(skillContent);
    const frontmatter = {
      ...parsed.frontmatter,
      name: parsed.frontmatter.name ?? catalogSkill.name,
      description: parsed.frontmatter.description ?? catalogSkill.description,
      category: parsed.frontmatter.category ?? catalogSkill.category,
      marketplace_source_id: req.sourceId,
      marketplace_skill_id: req.skillId,
      version
    };
    const frontmatterText = Object.entries(frontmatter).map(([key, value]) => `${key}: ${String(value)}`).join('\n');
    const content = ['---', frontmatterText, '---', '', parsed.body.trim()].join('\n');
    const doc = this.skillManager.create({
      name: String(frontmatter.name),
      category: String(frontmatter.category),
      content,
      overwrite: req.overwrite
    });
    this.writeSupportingFiles(doc.name, catalogSkill.supportingFiles);
    return {
      ...catalogSkill,
      version,
      readme,
      skillContent,
      installCommand,
      installed: true,
      installedSkillName: doc.name
    };
  }

  uninstall(name: string): boolean {
    return this.skillManager.delete(name);
  }

  private async resolveSkillForInstall(req: SkillInstallRequest): Promise<MarketplaceSkill | null> {
    const browsed = (await this.browse()).skills.find((skill) => skill.sourceId === req.sourceId && skill.id === req.skillId);
    if (browsed) return browsed;
    if (req.skill && req.skill.sourceId === req.sourceId && req.skill.id === req.skillId) {
      return this.snapshotToMarketplaceSkill(req.skill);
    }
    return null;
  }

  private async loadSource(source: SkillMarketplaceSource, searchTerms: string[], limit: number): Promise<MarketplaceSkill[]> {
    if (source.id.toLowerCase() === 'clawhub') {
      return this.loadClawHubSource(source, searchTerms, limit);
    }
    if (source.id.toLowerCase() === 'skillhub') {
      return this.loadSkillHubSource(source, searchTerms, limit);
    }
    return this.loadCatalogSource(source);
  }

  private async loadCatalogSource(source: SkillMarketplaceSource): Promise<MarketplaceSkill[]> {
    const localCatalogPath = join(this.resourcesRoot, 'markets', `${source.id}.json`);
    let content = '';
    if (existsSync(localCatalogPath)) {
      content = readFileSync(localCatalogPath, 'utf8');
    } else if (source.catalogUrl) {
      const response = await this.fetchWithTimeout(source.catalogUrl);
      if (!response.ok) return [];
      content = await response.text();
    } else {
      return [];
    }
    const catalog = JSON.parse(content) as CatalogFile;
    return (catalog.skills ?? []).map((skill) => ({
      id: skill.id,
      sourceId: source.id,
      sourceName: source.name,
      name: skill.name,
      description: skill.description,
      category: skill.category ?? 'general',
      version: skill.version ?? '1.0.0',
      readme: skill.readme ?? '',
      skillContent: skill.skillContent,
      supportingFiles: skill.supportingFiles ?? skill.files,
      homepage: skill.homepage,
      installed: false
    }));
  }

  private async loadClawHubSource(source: SkillMarketplaceSource, searchTerms: string[], limit: number): Promise<MarketplaceSkill[]> {
    try {
      if (searchTerms.length > 0) {
        const searched = await this.loadClawHubSearchRemote(source, searchTerms, limit);
        if (searched.length > 0) return searched;
      }
      const remote = await this.loadClawHubRemote(source, limit);
      if (remote.length > 0) return remote;
    } catch (error) {
      console.warn('[marketplace] ClawHub remote fetch failed, fallback to local catalog:', error);
    }
    return this.loadCatalogSource(source);
  }

  private async loadClawHubSearchRemote(source: SkillMarketplaceSource, searchTerms: string[], limit: number): Promise<MarketplaceSkill[]> {
    const convexUrl = await this.resolveClawHubConvexUrl(source);
    const skills: MarketplaceSkill[] = [];
    const settled = await Promise.allSettled(
      searchTerms.map((query) => this.postJson<ClawHubSearchResponse>(`${convexUrl}/api/action`, {
        path: 'search:searchSkills',
        args: {
          query,
          limit: Math.min(Math.max(limit, DEFAULT_MARKET_PAGE_SIZE), MAX_CLAWHUB_SKILLS),
          highlightedOnly: false,
          nonSuspiciousOnly: false
        }
      }))
    );
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const items = Array.isArray(result.value.value) ? result.value.value : [];
      for (const item of items as ClawHubSearchSkillItem[]) {
        const sourceSkill = item.skill ?? {};
        const slug = this.cleanText(String(sourceSkill.slug ?? sourceSkill._id ?? ''));
        if (!slug) continue;
        const name = this.cleanText(String(sourceSkill.displayName ?? slug));
        const description = this.cleanText(String(sourceSkill.summary ?? 'No description provided by ClawHub.'));
        const category = this.pickClawHubCategory(sourceSkill.capabilityTags);
        const version = this.cleanText(String(item.version?.version ?? 'latest'));
        const versionId = this.cleanText(String(item.version?._id ?? sourceSkill.latestVersionId ?? ''));
        const owner = this.cleanText(String(item.ownerHandle ?? item.owner?.handle ?? ''));
        const homepage = `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(slug)}`;
        skills.push({
          id: slug,
          sourceId: source.id,
          sourceName: source.name,
          name,
          description,
          category,
          version,
          readme: description,
          skillContent: this.buildGeneratedSkillContent({
            name: slug,
            title: name,
            description,
            category,
            sourceName: source.name,
            homepage,
            installCommand: owner ? `clawhub install ${owner}/${slug}` : undefined
          }),
          homepage,
          remoteVersionId: versionId || undefined,
          installCommand: owner ? `clawhub install ${owner}/${slug}` : undefined,
          installed: false
        });
      }
    }
    return this.dedupeBySourceSkillId(skills);
  }

  private async loadClawHubRemote(source: SkillMarketplaceSource, limit: number): Promise<MarketplaceSkill[]> {
    const convexUrl = await this.resolveClawHubConvexUrl(source);
    const skills: MarketplaceSkill[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    const target = Math.min(Math.max(limit, DEFAULT_MARKET_PAGE_SIZE), MAX_CLAWHUB_SKILLS);
    while (skills.length < target && pageCount < Math.ceil(target / 30) + 1) {
      const args: Record<string, unknown> = {
        numItems: 30,
        sort: 'downloads',
        dir: 'desc',
        nonSuspiciousOnly: true
      };
      if (cursor) args.cursor = cursor;
      const response = await this.postJson<ClawHubBrowseResponse>(`${convexUrl}/api/query`, {
        path: 'skills:listPublicPageV4',
        args
      });
      const page = Array.isArray(response.value?.page) ? response.value?.page : [];
      for (const item of page as ClawHubSkillListItem[]) {
        const sourceSkill = item.skill ?? {};
        const latestVersion = item.latestVersion ?? {};
        const slug = this.cleanText(String(sourceSkill.slug ?? sourceSkill._id ?? ''));
        if (!slug) continue;
        const name = this.cleanText(String(sourceSkill.displayName ?? slug));
        const description = this.cleanText(String(sourceSkill.summary ?? 'No description provided by ClawHub.'));
        const category = this.pickClawHubCategory(sourceSkill.capabilityTags);
        const version = this.cleanText(String(latestVersion.version ?? 'latest'));
        const versionId = this.cleanText(String(latestVersion._id ?? ''));
        const owner = this.cleanText(String(item.ownerHandle ?? item.owner?.handle ?? ''));
        const homepage = `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(slug)}`;
        skills.push({
          id: slug,
          sourceId: source.id,
          sourceName: source.name,
          name,
          description,
          category,
          version,
          readme: description,
          skillContent: this.buildGeneratedSkillContent({
            name: slug,
            title: name,
            description,
            category,
            sourceName: source.name,
            homepage,
            installCommand: owner ? `clawhub install ${owner}/${slug}` : undefined
          }),
          homepage,
          remoteVersionId: versionId || undefined,
          installCommand: owner ? `clawhub install ${owner}/${slug}` : undefined,
          installed: false
        });
        if (skills.length >= target) break;
      }
      pageCount += 1;
      const hasMore = Boolean(response.value?.hasMore);
      if (!hasMore || !response.value?.nextCursor) break;
      cursor = String(response.value.nextCursor);
    }
    return this.dedupeBySourceSkillId(skills);
  }

  private async resolveClawHubConvexUrl(source: SkillMarketplaceSource): Promise<string> {
    const fromSource = this.extractConvexUrlFromSource(source.catalogUrl);
    if (fromSource) {
      this.clawHubConvexUrl = fromSource;
      return fromSource;
    }
    if (this.clawHubConvexUrl) return this.clawHubConvexUrl;
    try {
      const browseHtml = await this.fetchText(`${CLAWHUB_BASE_URL}/skills?sort=downloads`);
      const runtimePath = this.extractFirst(browseHtml, /\/assets\/runtimeEnv-[^"']+\.js/);
      if (!runtimePath) {
        this.clawHubConvexUrl = CLAWHUB_FALLBACK_CONVEX_URL;
        return this.clawHubConvexUrl;
      }
      const runtimeContent = await this.fetchText(new URL(runtimePath, CLAWHUB_BASE_URL).toString());
      const resolved = this.extractFirst(runtimeContent, /VITE_CONVEX_URL["']?\s*[:=]\s*["']([^"']+)["']/);
      this.clawHubConvexUrl = resolved || CLAWHUB_FALLBACK_CONVEX_URL;
      return this.clawHubConvexUrl;
    } catch {
      this.clawHubConvexUrl = CLAWHUB_FALLBACK_CONVEX_URL;
      return this.clawHubConvexUrl;
    }
  }

  private async fetchClawHubReadme(versionId?: string): Promise<string | null> {
    if (!versionId) return null;
    try {
      const convexUrl = this.clawHubConvexUrl ?? CLAWHUB_FALLBACK_CONVEX_URL;
      const response = await this.postJson<ClawHubReadmeResponse>(`${convexUrl}/api/action`, {
        path: 'skills:getReadme',
        args: { versionId }
      });
      const text = response.value?.text;
      if (typeof text !== 'string' || !text.trim()) return null;
      return text;
    } catch {
      return null;
    }
  }

  private async installClawHubArchive(catalogSkill: MarketplaceSkill, req: SkillInstallRequest): Promise<{ name: string } | null> {
    const archive = await this.fetchClawHubArchive(catalogSkill);
    if (!archive) return null;
    try {
      const doc = await this.skillManager.installArchive(
        {
          filename: `${catalogSkill.id}.zip`,
          contentBase64: archive.toString('base64'),
          category: catalogSkill.category,
          overwrite: req.overwrite
        },
        {
          marketplace_source_id: req.sourceId,
          marketplace_skill_id: req.skillId,
          version: catalogSkill.version
        }
      );
      return { name: doc.name };
    } catch (error) {
      console.warn('[marketplace] ClawHub archive install failed, fallback to SKILL.md:', error);
      return null;
    }
  }

  private async fetchClawHubArchive(catalogSkill: MarketplaceSkill): Promise<Buffer | null> {
    const baseUrls = await this.clawHubDownloadBaseUrls(catalogSkill);
    const urls = baseUrls.flatMap((baseUrl) => this.clawHubDownloadUrls(baseUrl, catalogSkill.id, catalogSkill.version));
    for (const url of urls) {
      try {
        const response = await this.fetchWithTimeout(url, {
          headers: {
            Accept: 'application/zip,application/octet-stream;q=0.9,*/*;q=0.8'
          }
        });
        if (!response.ok) continue;
        const contentType = response.headers.get('content-type') ?? '';
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) continue;
        if (contentType && !/zip|octet-stream|application\/x-zip-compressed/i.test(contentType)) {
          continue;
        }
        return buffer;
      } catch {
        // Try the next known ClawHub download shape.
      }
    }
    return null;
  }

  private async clawHubDownloadBaseUrls(catalogSkill: MarketplaceSkill): Promise<string[]> {
    const urls = [
      this.baseUrlFromHomepage(catalogSkill.homepage),
      CLAWHUB_BASE_URL,
      this.clawHubConvexUrl ? this.toConvexSiteUrl(this.clawHubConvexUrl) : null,
      this.toConvexSiteUrl(await this.resolveClawHubConvexUrl({ id: 'clawhub', name: 'ClawHub', description: '', enabled: true })),
      CLAWHUB_FALLBACK_CONVEX_SITE_URL
    ];
    return [...new Set(urls.filter((url): url is string => Boolean(url)))];
  }

  private clawHubDownloadUrls(baseUrl: string, slug: string, version?: string): string[] {
    const urls: string[] = [];
    const add = (path: string, params?: Record<string, string | undefined>) => {
      const url = new URL(path, baseUrl);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value) url.searchParams.set(key, value);
      }
      urls.push(url.toString());
    };
    const requestedVersion = version && version !== 'latest' ? version : undefined;
    add('/api/v1/download', { slug, version: requestedVersion, tag: requestedVersion ? undefined : 'latest' });
    add('/api/v1/download', { slug, version: requestedVersion });
    add(`/api/v1/download/${encodeURIComponent(slug)}`, { version: requestedVersion });
    add('/api/download', { slug, version: requestedVersion });
    return [...new Set(urls)];
  }

  private toConvexSiteUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('.convex.site')) return `${parsed.protocol}//${parsed.host}`;
      if (parsed.hostname.endsWith('.convex.cloud')) return `${parsed.protocol}//${parsed.host.replace(/\.convex\.cloud$/i, '.convex.site')}`;
      return null;
    } catch {
      return null;
    }
  }

  private baseUrlFromHomepage(homepage?: string): string | null {
    if (!homepage) return null;
    try {
      const parsed = new URL(homepage);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return null;
    }
  }

  private writeSupportingFiles(name: string, files?: SkillSupportingFile[]): void {
    for (const file of files ?? []) {
      const path = file.path?.trim();
      if (!path) continue;
      if (typeof file.contentBase64 === 'string' && file.contentBase64.trim()) {
        this.skillManager.writeSupportingFile(name, path, Buffer.from(file.contentBase64, 'base64'));
      } else if (typeof file.content === 'string') {
        this.skillManager.writeSupportingFile(name, path, file.content);
      }
    }
  }

  private async loadSkillHubSource(source: SkillMarketplaceSource, searchTerms: string[], limit: number): Promise<MarketplaceSkill[]> {
    try {
      const remote = await this.loadSkillHubRemote(source, searchTerms, limit);
      if (remote.length > 0) return remote;
    } catch (error) {
      console.warn('[marketplace] SkillHub remote fetch failed, fallback to local catalog:', error);
    }
    return this.loadCatalogSource(source);
  }

  private async loadSkillHubRemote(source: SkillMarketplaceSource, searchTerms: string[], limit: number): Promise<MarketplaceSkill[]> {
    const url = new URL('/api/skills', this.skillHubApiBaseUrl(source));
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', String(Math.min(Math.max(limit, DEFAULT_MARKET_PAGE_SIZE), MAX_SKILLHUB_SKILLS)));
    const query = searchTerms[0];
    if (query) url.searchParams.set('q', query);
    const response = await this.fetchJson<SkillHubBrowseResponse>(url.toString());
    const items = Array.isArray(response.data?.skills) ? response.data.skills : [];
    const skills = items.map((item) => this.skillHubListItemToSkill(source, item)).filter((skill): skill is MarketplaceSkill => Boolean(skill));
    if (skills.length > 0 || !query) return this.dedupeBySourceSkillId(skills);
    const fallbackUrl = new URL('/api/skills', this.skillHubApiBaseUrl(source));
    fallbackUrl.searchParams.set('page', '1');
    fallbackUrl.searchParams.set('page_size', String(Math.min(Math.max(limit, DEFAULT_MARKET_PAGE_SIZE), MAX_SKILLHUB_SKILLS)));
    const fallback = await this.fetchJson<SkillHubBrowseResponse>(fallbackUrl.toString());
    const fallbackItems = Array.isArray(fallback.data?.skills) ? fallback.data.skills : [];
    return this.dedupeBySourceSkillId(
      fallbackItems
        .map((item) => this.skillHubListItemToSkill(source, item))
        .filter((skill): skill is MarketplaceSkill => Boolean(skill))
    );
  }

  private skillHubListItemToSkill(source: SkillMarketplaceSource, item: unknown): MarketplaceSkill | null {
    const obj = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const namespace = obj.namespace && typeof obj.namespace === 'object' ? obj.namespace as Record<string, unknown> : {};
    const slug = this.cleanText(String(obj.slug ?? namespace.publicSlug ?? ''));
    if (!slug) return null;
    const owner = this.cleanText(String(namespace.handle ?? obj.ownerName ?? ''));
    const id = owner ? `${owner}/${slug}` : slug;
    const name = this.cleanText(String(obj.name ?? slug));
    const description = this.cleanText(String(obj.description_zh ?? obj.description ?? `Skill from ${source.name}`));
    const category = this.cleanText(String(obj.category ?? 'general'));
    const version = this.cleanText(String(obj.version ?? 'latest'));
    const homepage = this.skillHubHomepage(owner, slug);
    const installCommand = `npx skillhub-install install ${owner ? `${owner}/` : ''}${slug}`;
    const metrics = [
      typeof obj.downloads === 'number' ? `Downloads: ${obj.downloads}` : '',
      typeof obj.installs === 'number' ? `Installs: ${obj.installs}` : '',
      typeof obj.stars === 'number' ? `Stars: ${obj.stars}` : ''
    ].filter(Boolean).join(' | ');
    const subCategories = Array.isArray(obj.subCategories)
      ? obj.subCategories
        .map((entry) => entry && typeof entry === 'object' ? this.cleanText(String((entry as Record<string, unknown>).name ?? '')) : '')
        .filter(Boolean)
      : [];
    const readme = [description, subCategories.length > 0 ? `Subcategories: ${subCategories.join(', ')}` : '', metrics, `Source: ${homepage}`].filter(Boolean).join('\n\n');
    return {
      id,
      sourceId: source.id,
      sourceName: source.name,
      name,
      description,
      category,
      version,
      readme,
      skillContent: this.buildGeneratedSkillContent({
        name: slug,
        title: name,
        description,
        category,
        sourceName: source.name,
        homepage,
        about: readme,
        installCommand
      }),
      homepage,
      installCommand,
      installed: false
    };
  }

  private skillHubApiBaseUrl(source: SkillMarketplaceSource): string {
    const catalogUrl = source.catalogUrl?.trim();
    if (!catalogUrl) return SKILLHUB_API_BASE_URL;
    try {
      const parsed = new URL(catalogUrl);
      if (parsed.hostname === 'api.skillhub.cn') return `${parsed.protocol}//${parsed.host}`;
      if (parsed.hostname === 'skillhub.cn' || parsed.hostname === 'www.skillhub.cn' || parsed.hostname === 'skillhub.builders') {
        return SKILLHUB_API_BASE_URL;
      }
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return SKILLHUB_API_BASE_URL;
    }
  }

  private async fetchSkillHubDetail(sourceHomepage: string, fallback: MarketplaceSkill): Promise<SkillHubDetailResult | null> {
    try {
      const identity = this.parseSkillHubIdentity(sourceHomepage, fallback.id);
      const detail = await this.fetchJson<SkillHubDetailResponse>(`${SKILLHUB_API_BASE_URL}/api/v1/skills/${encodeURIComponent(identity.slug)}`);
      const skill = detail.skill ?? {};
      const namespace = detail.namespace ?? {};
      const title = this.cleanText(skill.displayName ?? fallback.name);
      const description = this.cleanText(skill.summary_zh ?? skill.summary ?? fallback.description);
      const category = this.cleanText(skill.category ?? fallback.category);
      const version = this.cleanText(detail.latestVersion?.version ?? skill.tags?.latest ?? fallback.version);
      const owner = this.cleanText(namespace.handle ?? detail.owner?.handle ?? identity.owner ?? '');
      const homepage = this.skillHubHomepage(owner, identity.slug);
      const installCommand = `npx skillhub-install install ${owner ? `${owner}/` : ''}${identity.slug}`;
      const stats = [
        typeof skill.stats?.downloads === 'number' ? `Downloads: ${skill.stats.downloads}` : '',
        typeof skill.stats?.installs === 'number' ? `Installs: ${skill.stats.installs}` : '',
        typeof skill.stats?.stars === 'number' ? `Stars: ${skill.stats.stars}` : '',
        detail.latestVersion?.changelog ? `Changelog: ${detail.latestVersion.changelog}` : ''
      ].filter(Boolean).join('\n');
      const about = [description, stats].filter(Boolean).join('\n\n');
      const readme = [description, stats, `Install: ${installCommand}`].filter(Boolean).join('\n\n');
      const skillContent = this.buildGeneratedSkillContent({
        name: identity.slug,
        title,
        description,
        category,
        sourceName: fallback.sourceName,
        homepage,
        about,
        installCommand
      });
      return {
        skillContent,
        readme,
        version,
        installCommand
      };
    } catch {
      return null;
    }
  }

  private parseSkillHubIdentity(homepage: string, fallbackId: string): { owner?: string; slug: string } {
    const value = homepage || fallbackId;
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      const slug = parts.at(-1) || fallbackId.split('/').filter(Boolean).at(-1) || fallbackId;
      const owner = parts.length > 1 ? parts.at(-2) : fallbackId.split('/').filter(Boolean).at(-2);
      return { owner, slug };
    } catch {
      const parts = fallbackId.split('/').filter(Boolean);
      return parts.length > 1 ? { owner: parts[0], slug: parts[1] } : { slug: fallbackId };
    }
  }

  private skillHubHomepage(owner: string | undefined, slug: string): string {
    return owner
      ? `${SKILLHUB_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`
      : `${SKILLHUB_BASE_URL}/${encodeURIComponent(slug)}`;
  }

  private extractConvexUrlFromSource(catalogUrl?: string): string | null {
    if (!catalogUrl) return null;
    try {
      const parsed = new URL(catalogUrl);
      if (parsed.hostname.endsWith('.convex.cloud')) return `${parsed.protocol}//${parsed.host}`;
      return null;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchWithTimeout(url, {
      headers: {
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`Request failed: ${url} -> ${response.status}`);
    return response.text();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json,text/plain;q=0.5,*/*;q=0.2'
      }
    });
    if (!response.ok) throw new Error(`Request failed: ${url} -> ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async postJson<T>(url: string, payload: unknown): Promise<T> {
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Request failed: ${url} -> ${response.status}`);
    return response.json() as Promise<T>;
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

  private pickClawHubCategory(tags: unknown): string {
    if (Array.isArray(tags)) {
      const first = tags.find((item) => typeof item === 'string');
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
    return 'general';
  }

  private previewFromSkillContent(skillContent: string): string {
    const { body } = parseSkillMarkdown(skillContent);
    const text = body.trim();
    return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
  }

  private buildGeneratedSkillContent(options: {
    name: string;
    title: string;
    description: string;
    category: string;
    sourceName: string;
    homepage?: string;
    about?: string;
    installCommand?: string;
  }): string {
    const description = this.cleanText(options.description) || `Skill from ${options.sourceName}.`;
    const about = this.cleanText(options.about ?? '');
    const category = this.cleanText(options.category) || 'general';
    const lines = [
      `# ${this.cleanText(options.title) || options.name}`,
      '',
      description
    ];
    if (about && about !== description) {
      lines.push('', '## About', '', about);
    }
    if (options.installCommand) {
      lines.push('', '## Install Command', '', '```bash', this.cleanText(options.installCommand), '```');
    }
    if (options.homepage) {
      lines.push('', '## Source', '', options.homepage);
    }
    return [
      '---',
      `name: ${this.frontmatterValue(options.name)}`,
      `description: ${this.frontmatterValue(description)}`,
      `category: ${this.frontmatterValue(category)}`,
      '---',
      '',
      ...lines,
      ''
    ].join('\n');
  }

  private frontmatterValue(value: string): string {
    return JSON.stringify(this.cleanText(value));
  }

  private snapshotToMarketplaceSkill(skill: MarketplaceSkillSnapshot): MarketplaceSkill {
    return {
      ...skill,
      installed: false
    };
  }

  private dedupeBySourceSkillId(skills: MarketplaceSkill[]): MarketplaceSkill[] {
    const byKey = new Map<string, MarketplaceSkill>();
    for (const skill of skills) {
      byKey.set(`${skill.sourceId}::${skill.id}`, skill);
    }
    return [...byKey.values()];
  }

  private normalizeBrowseRequest(input: string | MarketplaceBrowseRequest): NormalizedMarketplaceBrowseRequest {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : { query: typeof input === 'string' ? input : '' };
    return {
      query: typeof raw.query === 'string' ? raw.query.trim() : '',
      page: Math.max(1, Math.floor(Number(raw.page) || 1)),
      pageSize: Math.max(1, Math.min(MAX_MARKET_PAGE_SIZE, Math.floor(Number(raw.pageSize) || DEFAULT_MARKET_PAGE_SIZE)))
    };
  }

  private expandSearchTerms(query: string): string[] {
    const text = this.cleanText(query).toLowerCase();
    if (!text) return [];
    const terms = new Set<string>([text]);
    for (const group of SEARCH_SYNONYM_GROUPS) {
      if (group.some((word) => text.includes(word))) {
        for (const word of group) terms.add(word);
      }
    }
    return [...terms];
  }

  private extractFirst(input: string, pattern: RegExp): string | undefined {
    const match = input.match(pattern);
    if (!match || match.length < 2) return undefined;
    return match[1];
  }

  private stripHtml(input: string): string {
    const normalized = input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ');
    return this.cleanText(this.decodeHtml(normalized).replace(/\n{3,}/g, '\n\n'));
  }

  private decodeHtml(input: string): string {
    const decodedEntities = input
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, '\'')
      .replace(/&apos;/g, '\'')
      .replace(/&#x([0-9a-fA-F]+);/g, (_full, hex: string) => {
        const value = Number.parseInt(hex, 16);
        return Number.isFinite(value) ? String.fromCodePoint(value) : '';
      })
      .replace(/&#(\d+);/g, (_full, dec: string) => {
        const value = Number.parseInt(dec, 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : '';
      });
    return decodedEntities;
  }

  private cleanText(input: string): string {
    return input
      .replace(/\r/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim();
  }
}
