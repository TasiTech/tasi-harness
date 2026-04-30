import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceBrowseResult, MarketplaceSkill, SkillInstallRequest, SkillMarketplaceSource } from '../../shared/types.js';
import { parseSkillMarkdown, SkillManager } from './skillManager.js';

const CLAWHUB_BASE_URL = 'https://clawhub.ai';
const CLAWHUB_FALLBACK_CONVEX_URL = 'https://wry-manatee-359.convex.cloud';
const SKILLHUB_BASE_URL = 'https://skillhub.builders';
const REMOTE_TIMEOUT_MS = 12_000;
const MAX_CLAWHUB_SKILLS = 80;
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

export class MarketplaceManager {
  private clawHubConvexUrl: string | undefined;

  constructor(
    private readonly resourcesRoot: string,
    private readonly skillManager: SkillManager,
    private readonly getSources: () => SkillMarketplaceSource[]
  ) {}

  async browse(query = ''): Promise<MarketplaceBrowseResult> {
    const installed = this.skillManager.list();
    const searchTerms = this.expandSearchTerms(query);
    const loadedSkills = await Promise.all(
      this.getSources()
        .filter((source) => source.enabled)
        .map(async (source) => {
          try {
            return await this.loadSource(source, searchTerms);
          } catch (error) {
            console.warn(`[marketplace] failed to load source ${source.id}:`, error);
            return [];
          }
        })
    );
    const skills = loadedSkills
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
    return {
      sources: this.getSources(),
      skills
    };
  }

  async install(req: SkillInstallRequest): Promise<MarketplaceSkill> {
    const catalogSkill = (await this.browse()).skills.find((skill) => skill.sourceId === req.sourceId && skill.id === req.skillId);
    if (!catalogSkill) throw new Error('Marketplace skill not found.');
    const sourceId = req.sourceId.toLowerCase();
    let skillContent = catalogSkill.skillContent;
    let readme = catalogSkill.readme;
    let version = catalogSkill.version;
    let installCommand = catalogSkill.installCommand;

    if (sourceId === 'clawhub') {
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
      content
    });
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

  private async loadSource(source: SkillMarketplaceSource, searchTerms: string[]): Promise<MarketplaceSkill[]> {
    if (source.id.toLowerCase() === 'clawhub') {
      return this.loadClawHubSource(source, searchTerms);
    }
    if (source.id.toLowerCase() === 'skillhub') {
      return this.loadSkillHubSource(source);
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
      homepage: skill.homepage,
      installed: false
    }));
  }

  private async loadClawHubSource(source: SkillMarketplaceSource, searchTerms: string[]): Promise<MarketplaceSkill[]> {
    try {
      if (searchTerms.length > 0) {
        const searched = await this.loadClawHubSearchRemote(source, searchTerms);
        if (searched.length > 0) return searched;
      }
      const remote = await this.loadClawHubRemote(source);
      if (remote.length > 0) return remote;
    } catch (error) {
      console.warn('[marketplace] ClawHub remote fetch failed, fallback to local catalog:', error);
    }
    return this.loadCatalogSource(source);
  }

  private async loadClawHubSearchRemote(source: SkillMarketplaceSource, searchTerms: string[]): Promise<MarketplaceSkill[]> {
    const convexUrl = await this.resolveClawHubConvexUrl(source);
    const skills: MarketplaceSkill[] = [];
    const settled = await Promise.allSettled(
      searchTerms.map((query) => this.postJson<ClawHubSearchResponse>(`${convexUrl}/api/action`, {
        path: 'search:searchSkills',
        args: {
          query,
          limit: MAX_CLAWHUB_SKILLS,
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

  private async loadClawHubRemote(source: SkillMarketplaceSource): Promise<MarketplaceSkill[]> {
    const convexUrl = await this.resolveClawHubConvexUrl(source);
    const skills: MarketplaceSkill[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    while (skills.length < MAX_CLAWHUB_SKILLS && pageCount < 4) {
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
        if (skills.length >= MAX_CLAWHUB_SKILLS) break;
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

  private async loadSkillHubSource(source: SkillMarketplaceSource): Promise<MarketplaceSkill[]> {
    try {
      const remote = await this.loadSkillHubRemote(source);
      if (remote.length > 0) return remote;
    } catch (error) {
      console.warn('[marketplace] SkillHub remote fetch failed, fallback to local catalog:', error);
    }
    return this.loadCatalogSource(source);
  }

  private async loadSkillHubRemote(source: SkillMarketplaceSource): Promise<MarketplaceSkill[]> {
    const browseUrl = source.catalogUrl?.trim() || `${SKILLHUB_BASE_URL}/browse`;
    const html = await this.fetchText(browseUrl);
    const cardRegex = /<a[^>]*href="\/skills\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const skills: MarketplaceSkill[] = [];
    for (const match of html.matchAll(cardRegex)) {
      const slugRaw = this.cleanText(match[1] ?? '');
      const block = match[2] ?? '';
      if (!slugRaw || !/<h3/i.test(block) || !/installs/i.test(block)) continue;
      const slug = this.decodeHtml(slugRaw);
      const name = this.stripHtml(this.extractFirst(block, /<h3[^>]*>([\s\S]*?)<\/h3>/i) ?? slug);
      const description = this.stripHtml(this.extractFirst(block, /<p[^>]*>([\s\S]*?)<\/p>/i) ?? `Skill from ${source.name}`);
      const category = this.stripHtml(this.extractFirst(block, /<span[^>]*rounded-full[^>]*border-primary\/30[^>]*>([\s\S]*?)<\/span>/i) ?? 'general');
      const installs = this.cleanText(this.extractFirst(block, /([\d,]+)(?:<!-- -->)?\s*installs/i) ?? '');
      const homepage = `${SKILLHUB_BASE_URL}/skills/${encodeURIComponent(slug)}`;
      const installCommand = `npx skillhub-install install ${slug}`;
      const readme = [description, installs ? `Installs: ${installs}` : '', `Source: ${homepage}`].filter(Boolean).join('\n\n');
      skills.push({
        id: slug,
        sourceId: source.id,
        sourceName: source.name,
        name,
        description,
        category,
        version: 'latest',
        readme,
        skillContent: this.buildGeneratedSkillContent({
          name: slug,
          title: name,
          description,
          category,
          sourceName: source.name,
          homepage,
          installCommand
        }),
        homepage,
        installCommand,
        installed: false
      });
    }
    return this.dedupeBySourceSkillId(skills);
  }

  private async fetchSkillHubDetail(homepage: string, fallback: MarketplaceSkill): Promise<SkillHubDetailResult | null> {
    try {
      const html = await this.fetchText(homepage);
      const title = this.stripHtml(this.extractFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? fallback.name);
      const metaDescription = this.decodeHtml(this.extractFirst(html, /<meta\s+name="description"\s+content="([^"]*)"/i) ?? fallback.description);
      const category = this.stripHtml(this.extractFirst(html, /<span class="rounded-full bg-secondary[^"]*"[^>]*>([^<]+)<\/span>/i) ?? fallback.category);
      const version = this.cleanText(
        this.extractFirst(html, /"softwareVersion":"([^"]+)"/i)
          ?? this.extractFirst(html, />v(?:<!-- -->)?\s*([^<]+)</i)
          ?? fallback.version
      );
      const installCommand = this.decodeHtml(this.extractFirst(html, /<code[^>]*>([^<]*skillhub-install[^<]*)<\/code>/i) ?? '');
      const aboutHtml = this.extractFirst(html, /<h2[^>]*>\s*About\s*<\/h2>\s*<div[^>]*>([\s\S]*?)<\/div>\s*<\/section>/i);
      const about = aboutHtml ? this.stripHtml(aboutHtml) : '';
      const readme = [metaDescription, about, installCommand ? `Install: ${installCommand}` : ''].filter(Boolean).join('\n\n');
      const skillContent = this.buildGeneratedSkillContent({
        name: fallback.id,
        title,
        description: metaDescription,
        category,
        sourceName: fallback.sourceName,
        homepage,
        about,
        installCommand: installCommand || undefined
      });
      return {
        skillContent,
        readme,
        version,
        installCommand: installCommand || undefined
      };
    } catch {
      return null;
    }
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

  private dedupeBySourceSkillId(skills: MarketplaceSkill[]): MarketplaceSkill[] {
    const byKey = new Map<string, MarketplaceSkill>();
    for (const skill of skills) {
      byKey.set(`${skill.sourceId}::${skill.id}`, skill);
    }
    return [...byKey.values()];
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

