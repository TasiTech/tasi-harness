import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import JSZip from 'jszip';
import type { BrowserCoachRecording, BrowserCoachStoredRecording, SkillArchiveUploadRequest, SkillDocument, SkillMetadata, SkillPatchRequest, SkillWriteRequest } from '../../shared/types.js';
import { ensureDir, safeJoin, slugifyName } from '../storage/pathUtils.js';

type FrontmatterValue = string | string[] | boolean | number;
type Frontmatter = Record<string, FrontmatterValue>;

export function parseSkillMarkdown(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Frontmatter = {};
  for (const raw of match[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const valueRaw = line.slice(idx + 1).trim();
    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      frontmatter[key] = valueRaw
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (valueRaw === 'true' || valueRaw === 'false') {
      frontmatter[key] = valueRaw === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
      frontmatter[key] = Number(valueRaw);
    } else {
      frontmatter[key] = valueRaw.replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

function stringifySkill(frontmatter: Frontmatter, body: string): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.join(', ')}]`);
    else lines.push(`${key}: ${String(value)}`);
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

export class SkillManager {
  private readonly localRoot: string;

  constructor(
    private readonly harnessHome: string,
    private readonly bundledRoot?: string
  ) {
    this.localRoot = resolve(harnessHome, 'skills');
    ensureDir(this.localRoot);
  }

  seedBundledSkills(options: { overwriteExisting?: boolean; overwriteSkillNames?: string[] } = {}): void {
    if (!this.bundledRoot || !existsSync(this.bundledRoot)) return;
    const overwriteNames = new Set((options.overwriteSkillNames ?? []).map((name) => slugifyName(name)));
    for (const file of this.findSkillFiles(this.bundledRoot)) {
      const rel = relative(this.bundledRoot, dirname(file));
      const targetDir = safeJoin(this.localRoot, rel);
      const skillName = this.metadataFromFile(file, true, 'bundled').name;
      const skillFolder = basename(dirname(file));
      const shouldOverwrite = options.overwriteExisting || overwriteNames.has(slugifyName(skillName)) || overwriteNames.has(slugifyName(skillFolder));
      if (existsSync(targetDir) && !shouldOverwrite) continue;
      this.replaceBundledSkillFiles(dirname(file), targetDir);
    }
  }

  list(): SkillMetadata[] {
    const bundled = this.bundledRoot && existsSync(this.bundledRoot) ? this.findSkillFiles(this.bundledRoot).map((f) => this.metadataFromFile(f, true, 'bundled')) : [];
    const local = this.findSkillFiles(this.localRoot).map((f) => this.metadataFromFile(f, false, 'local'));
    const byName = new Map<string, SkillMetadata>();
    for (const skill of bundled) byName.set(skill.name, skill);
    const bundledBySlug = new Map(bundled.map((skill) => [slugifyName(skill.name), skill]));
    for (const skill of local) {
      const shadowedBundled = bundledBySlug.get(slugifyName(skill.name));
      byName.set(skill.name, shadowedBundled
        ? {
          ...skill,
          bundledPath: shadowedBundled.path,
          bundledUpdatedAt: shadowedBundled.updatedAt
        }
        : skill);
    }
    return [...byName.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  read(name: string): SkillDocument | null {
    const file = this.resolveSkillFile(name);
    if (!file) return null;
    return this.documentFromFile(file, file.startsWith(this.localRoot), file.startsWith(this.localRoot) ? 'local' : 'bundled');
  }

  listBrowserCoachRecordings(): BrowserCoachStoredRecording[] {
    return this.findSkillFiles(this.localRoot)
      .map((file) => this.browserCoachRecordingSummary(file))
      .filter((item): item is BrowserCoachStoredRecording => Boolean(item))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.skillName.localeCompare(b.skillName));
  }

  readBrowserCoachRecording(skillName: string): BrowserCoachRecording | null {
    const file = this.localSkillFile(skillName);
    const recordingPath = join(dirname(file), 'references', 'recording.json');
    if (!existsSync(recordingPath)) return null;
    return this.parseBrowserCoachRecording(readFileSync(recordingPath, 'utf8'));
  }

  deleteBrowserCoachRecording(skillName: string): boolean {
    return this.removeSupportingFile(skillName, 'references/recording.json');
  }

  readBundled(name: string): SkillDocument | null {
    if (!this.bundledRoot || !existsSync(this.bundledRoot)) return null;
    const slug = slugifyName(name);
    const file = this.findSkillFiles(this.bundledRoot).find((candidate) => {
      const metadata = this.metadataFromFile(candidate, true, 'bundled');
      return slugifyName(metadata.name) === slug || basename(dirname(candidate)) === slug;
    });
    return file ? this.documentFromFile(file, true, 'bundled') : null;
  }

  create(req: SkillWriteRequest): SkillDocument {
    const slug = slugifyName(req.name);
    const category = slugifyName(req.category || 'local');
    const dir = safeJoin(this.localRoot, join(category, slug));
    if (existsSync(dir)) {
      if (!req.overwrite) throw new Error(`Skill already exists: ${req.name}. Choose overwrite to replace it.`);
      rmSync(dir, { recursive: true, force: true });
    }
    ensureDir(dir);
    const { frontmatter, body } = parseSkillMarkdown(req.content);
    const finalFrontmatter: Frontmatter = {
      name: String(frontmatter.name ?? slug),
      description: String(frontmatter.description ?? `Skill: ${slug}`),
      category,
      ...frontmatter,
      ...(req.displayName?.trim() ? { display_name: req.displayName.trim() } : {}),
      ...(req.displayCategory?.trim() ? { display_category: req.displayCategory.trim() } : {})
    };
    const content = stringifySkill(finalFrontmatter, body || req.content);
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
    return this.documentFromFile(join(dir, 'SKILL.md'), true, 'local');
  }

  nextAvailableName(name: string, category = 'local'): string {
    const base = slugifyName(name);
    const categorySlug = slugifyName(category || 'local');
    let candidate = base;
    let suffix = 2;
    while (existsSync(safeJoin(this.localRoot, join(categorySlug, candidate)))) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  patch(req: SkillPatchRequest): SkillDocument {
    const file = this.localSkillFile(req.name);
    const raw = readFileSync(file, 'utf8');
    if (req.oldString === req.newString || (req.newString && raw.includes(req.newString))) {
      return this.documentFromFile(file, true, 'local');
    }
    if (!raw.includes(req.oldString)) throw new Error('oldString not found in skill.');
    writeFileSync(file, raw.replace(req.oldString, req.newString), 'utf8');
    return this.documentFromFile(file, true, 'local');
  }

  async uploadArchive(req: SkillArchiveUploadRequest): Promise<SkillDocument> {
    return this.installArchive(req);
  }

  async installArchive(req: SkillArchiveUploadRequest, frontmatterOverrides: Record<string, FrontmatterValue | undefined> = {}): Promise<SkillDocument> {
    if (!req.contentBase64?.trim()) throw new Error('Archive content is empty.');
    const archive = Buffer.from(req.contentBase64, 'base64');
    if (archive.length === 0) throw new Error('Archive content is empty.');
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(archive);
    } catch (error) {
      throw new Error(`Invalid ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    const skillEntry = entries.find((entry) => this.isSkillMarkdown(entry.name));
    if (!skillEntry) throw new Error('Archive must include SKILL.md.');
    const rawSkillContent = await skillEntry.async('string');
    const parsed = parseSkillMarkdown(rawSkillContent);
    const fallbackName = this.basenameWithoutExt(req.filename || skillEntry.name || 'uploaded-skill');
    const skillName = String(req.name ?? parsed.frontmatter.name ?? fallbackName).trim();
    const skillCategory = String(req.category ?? parsed.frontmatter.category ?? 'local').trim();
    if (!skillName) throw new Error('Skill name is required.');
    const frontmatter: Frontmatter = {
      ...parsed.frontmatter,
      ...Object.fromEntries(Object.entries(frontmatterOverrides).filter((entry): entry is [string, FrontmatterValue] => entry[1] !== undefined)),
      name: skillName,
      category: skillCategory || 'local',
      ...(req.displayName?.trim() ? { display_name: req.displayName.trim() } : {}),
      ...(req.displayCategory?.trim() ? { display_category: req.displayCategory.trim() } : {}),
      description: parsed.frontmatter.description ?? `Skill: ${skillName}`
    };
    const content = stringifySkill(frontmatter, parsed.body);
    const created = this.create({
      name: skillName,
      category: skillCategory || 'local',
      content,
      overwrite: req.overwrite
    });
    const skillRoot = this.skillRootForEntry(skillEntry.name);
    for (const entry of entries) {
      if (entry === skillEntry) continue;
      const entryPath = this.normalizeZipPath(entry.name);
      if (!this.belongsToSkillRoot(entryPath, skillRoot)) continue;
      const relPath = skillRoot ? entryPath.slice(skillRoot.length + 1) : entryPath;
      if (!relPath || /(^|\/)\.\.(\/|$)/.test(relPath)) continue;
      const fileContent = await entry.async('nodebuffer');
      this.writeSupportingFile(created.name, relPath, fileContent);
    }
    return this.documentFromFile(this.localSkillFile(created.name), true, 'local');
  }

  installBundled(name: string, overwrite = false): SkillDocument {
    if (!this.bundledRoot || !existsSync(this.bundledRoot)) throw new Error('Bundled skills root is not available.');
    const bundled = this.readBundled(name);
    if (!bundled) throw new Error(`Bundled skill not found: ${name}`);
    const rel = relative(this.bundledRoot, dirname(bundled.path));
    const targetDir = safeJoin(this.localRoot, rel);
    if (existsSync(targetDir) && !overwrite) {
      throw new Error(`Local skill already exists: ${bundled.name}. Choose overwrite to replace it.`);
    }
    this.replaceBundledSkillFiles(dirname(bundled.path), targetDir);
    return this.documentFromFile(join(targetDir, 'SKILL.md'), false, 'local');
  }

  delete(name: string): boolean {
    const file = this.resolveSkillFile(name);
    if (!file || !file.startsWith(this.localRoot)) return false;
    rmSync(dirname(file), { recursive: true, force: true });
    return true;
  }

  writeSupportingFile(name: string, filePath: string, fileContent: string | Uint8Array): string {
    const skillFile = this.localSkillFile(name);
    const root = dirname(skillFile);
    const target = safeJoin(root, filePath);
    ensureDir(dirname(target));
    writeFileSync(target, fileContent);
    return relative(root, target);
  }

  removeSupportingFile(name: string, filePath: string): boolean {
    const skillFile = this.localSkillFile(name);
    const root = dirname(skillFile);
    const target = safeJoin(root, filePath);
    if (target === skillFile) throw new Error('Use delete skill to remove SKILL.md.');
    if (!existsSync(target)) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  }

  renderPromptIndex(enabledNames?: string[]): string {
    const enabled = enabledNames && enabledNames.length > 0 ? new Set(enabledNames.map((name) => slugifyName(name))) : null;
    const skills = enabled
      ? this.list().filter((skill) => enabled.has(slugifyName(skill.name)) || enabled.has(slugifyName(basename(dirname(skill.path)))))
      : this.list();
    if (skills.length === 0) return enabled ? 'No matching skills are enabled for this run.' : 'No skills are installed.';
    return skills
      .map((skill) => {
        const skillDir = dirname(skill.path);
        const display = skill.displayName && skill.displayName !== skill.name ? `${skill.displayName} (${skill.name})` : skill.name;
        const category = skill.displayCategory && skill.displayCategory !== skill.category ? `${skill.displayCategory} (${skill.category})` : skill.category;
        return `- ${display} [${category}]: ${skill.description} | skill_file=${skill.path} | skill_dir=${skillDir}`;
      })
      .join('\n');
  }

  private findSkillFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        const stat = statSync(file);
        if (stat.isDirectory()) visit(file);
        else if (name === 'SKILL.md') out.push(file);
      }
    };
    visit(root);
    return out;
  }

  private replaceBundledSkillFiles(sourceDir: string, targetDir: string): void {
    if (resolve(targetDir) !== this.localRoot && existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    this.copySkillFiles(sourceDir, targetDir);
  }

  private copySkillFiles(sourceDir: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(sourceDir)) {
      if (name === '.DS_Store') continue;
      const source = join(sourceDir, name);
      const target = join(targetDir, name);
      const stat = statSync(source);
      if (stat.isDirectory()) {
        this.copySkillFiles(source, target);
        continue;
      }
      copyFileSync(source, target);
    }
  }

  private metadataFromFile(file: string, readonly: boolean, source: 'bundled' | 'local'): SkillMetadata {
    const raw = readFileSync(file, 'utf8');
    const { frontmatter } = parseSkillMarkdown(raw);
    const folder = basename(dirname(file));
    const stat = statSync(file);
    return {
      name: String(frontmatter.name ?? folder),
      displayName: typeof frontmatter.display_name === 'string' ? frontmatter.display_name : undefined,
      description: String(frontmatter.description ?? 'No description.'),
      category: String(frontmatter.category ?? basename(dirname(dirname(file))) ?? 'local'),
      displayCategory: typeof frontmatter.display_category === 'string' ? frontmatter.display_category : undefined,
      path: file,
      readonly,
      source,
      marketplaceSourceId: typeof frontmatter.marketplace_source_id === 'string' ? frontmatter.marketplace_source_id : undefined,
      marketplaceSkillId: typeof frontmatter.marketplace_skill_id === 'string' ? frontmatter.marketplace_skill_id : undefined,
      version: typeof frontmatter.version === 'string' ? frontmatter.version : undefined,
      updatedAt: stat.mtime.toISOString()
    };
  }

  private documentFromFile(file: string, readonly: boolean, source: 'bundled' | 'local'): SkillDocument {
    const content = readFileSync(file, 'utf8');
    const { frontmatter } = parseSkillMarkdown(content);
    const meta = this.metadataFromFile(file, readonly, source);
    return { ...meta, content, frontmatter };
  }

  private browserCoachRecordingSummary(skillFile: string): BrowserCoachStoredRecording | null {
    const recordingPath = join(dirname(skillFile), 'references', 'recording.json');
    if (!existsSync(recordingPath)) return null;
    const recording = this.parseBrowserCoachRecording(readFileSync(recordingPath, 'utf8'));
    if (!recording) return null;
    const metadata = this.metadataFromFile(skillFile, false, 'local');
    const stat = statSync(recordingPath);
    return {
      id: `skill:${metadata.name}`,
      source: 'skill',
      skillName: metadata.name,
      displayName: metadata.displayName,
      category: metadata.category,
      displayCategory: metadata.displayCategory,
      path: recordingPath,
      startUrl: recording.startUrl,
      startedAt: recording.startedAt,
      updatedAt: stat.mtime.toISOString(),
      eventCount: recording.events.length
    };
  }

  private parseBrowserCoachRecording(raw: string): BrowserCoachRecording | null {
    try {
      const parsed = JSON.parse(raw) as Partial<BrowserCoachRecording>;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) return null;
      return {
        id: typeof parsed.id === 'string' ? parsed.id : '',
        startUrl: typeof parsed.startUrl === 'string' ? parsed.startUrl : '',
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        endedAt: typeof parsed.endedAt === 'string' ? parsed.endedAt : undefined,
        active: Boolean(parsed.active),
        events: parsed.events
      } as BrowserCoachRecording;
    } catch {
      return null;
    }
  }

  private resolveSkillFile(name: string): string | null {
    const slug = slugifyName(name);
    const local = this.findSkillFiles(this.localRoot).find((file) => slugifyName(this.metadataFromFile(file, false, 'local').name) === slug || basename(dirname(file)) === slug);
    if (local) return local;
    if (this.bundledRoot && existsSync(this.bundledRoot)) {
      const bundled = this.findSkillFiles(this.bundledRoot).find((file) => slugifyName(this.metadataFromFile(file, true, 'bundled').name) === slug || basename(dirname(file)) === slug);
      if (bundled) return bundled;
    }
    return null;
  }

  private localSkillFile(name: string): string {
    const file = this.resolveSkillFile(name);
    if (!file) throw new Error(`Skill not found: ${name}`);
    if (!file.startsWith(this.localRoot)) throw new Error(`Skill is bundled/read-only; create a local copy before editing: ${name}`);
    return file;
  }

  private isSkillMarkdown(path: string): boolean {
    return /(^|\/)SKILL\.md$/i.test(this.normalizeZipPath(path));
  }

  private normalizeZipPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  private skillRootForEntry(path: string): string {
    return this.normalizeZipPath(path).replace(/(^|\/)SKILL\.md$/i, '').replace(/\/+$/, '');
  }

  private belongsToSkillRoot(entryPath: string, skillRoot: string): boolean {
    if (!skillRoot) return true;
    return entryPath.startsWith(`${skillRoot}/`);
  }

  private basenameWithoutExt(path: string): string {
    const normalized = this.normalizeZipPath(path);
    const base = normalized.split('/').pop() ?? 'uploaded-skill';
    return base.replace(/\.[^./\\]+$/, '');
  }
}
