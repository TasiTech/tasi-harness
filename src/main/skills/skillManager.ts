import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import JSZip from 'jszip';
import type { SkillArchiveUploadRequest, SkillDocument, SkillMetadata, SkillPatchRequest, SkillWriteRequest } from '../../shared/types.js';
import { ensureDir, safeJoin, slugifyName } from '../storage/pathUtils.js';

type Frontmatter = Record<string, string | string[] | boolean | number>;

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
    this.localRoot = join(harnessHome, 'skills');
    ensureDir(this.localRoot);
  }

  seedBundledSkills(): void {
    if (!this.bundledRoot || !existsSync(this.bundledRoot)) return;
    for (const file of this.findSkillFiles(this.bundledRoot)) {
      const rel = relative(this.bundledRoot, dirname(file));
      const targetDir = safeJoin(this.localRoot, rel);
      this.copyMissingSkillFiles(dirname(file), targetDir);
    }
  }

  list(): SkillMetadata[] {
    const bundled = this.bundledRoot && existsSync(this.bundledRoot) ? this.findSkillFiles(this.bundledRoot).map((f) => this.metadataFromFile(f, true, 'bundled')) : [];
    const local = this.findSkillFiles(this.localRoot).map((f) => this.metadataFromFile(f, false, 'local'));
    const byName = new Map<string, SkillMetadata>();
    for (const skill of bundled) byName.set(skill.name, skill);
    for (const skill of local) byName.set(skill.name, skill);
    return [...byName.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  read(name: string): SkillDocument | null {
    const file = this.resolveSkillFile(name);
    if (!file) return null;
    return this.documentFromFile(file, file.startsWith(this.localRoot), file.startsWith(this.localRoot) ? 'local' : 'bundled');
  }

  create(req: SkillWriteRequest): SkillDocument {
    const slug = slugifyName(req.name);
    const category = slugifyName(req.category || 'local');
    const dir = safeJoin(this.localRoot, join(category, slug));
    ensureDir(dir);
    const { frontmatter, body } = parseSkillMarkdown(req.content);
    const finalFrontmatter: Frontmatter = {
      name: String(frontmatter.name ?? slug),
      description: String(frontmatter.description ?? `Skill: ${slug}`),
      category,
      ...frontmatter
    };
    const content = stringifySkill(finalFrontmatter, body || req.content);
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
    return this.documentFromFile(join(dir, 'SKILL.md'), true, 'local');
  }

  patch(req: SkillPatchRequest): SkillDocument {
    const file = this.localSkillFile(req.name);
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes(req.oldString)) throw new Error('oldString not found in skill.');
    writeFileSync(file, raw.replace(req.oldString, req.newString), 'utf8');
    return this.documentFromFile(file, true, 'local');
  }

  async uploadArchive(req: SkillArchiveUploadRequest): Promise<SkillDocument> {
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
      name: skillName,
      category: skillCategory || 'local',
      description: parsed.frontmatter.description ?? `Skill: ${skillName}`
    };
    const frontmatterText = Object.entries(frontmatter).map(([key, value]) => `${key}: ${String(value)}`).join('\n');
    const content = ['---', frontmatterText, '---', '', parsed.body.trim()].join('\n');
    const created = this.create({
      name: skillName,
      category: skillCategory || 'local',
      content
    });
    const skillRoot = this.normalizeZipPath(skillEntry.name).replace(/(^|\/)SKILL\.md$/i, '');
    for (const entry of entries) {
      if (entry.name === skillEntry.name) continue;
      const entryPath = this.normalizeZipPath(entry.name);
      if (!this.belongsToSkillRoot(entryPath, skillRoot)) continue;
      const relPath = skillRoot ? entryPath.slice(skillRoot.length + 1) : entryPath;
      if (!relPath || /(^|\/)\.\.(\/|$)/.test(relPath)) continue;
      const fileContent = await entry.async('string');
      this.writeSupportingFile(created.name, relPath, fileContent);
    }
    return this.documentFromFile(this.localSkillFile(created.name), true, 'local');
  }

  delete(name: string): boolean {
    const file = this.resolveSkillFile(name);
    if (!file || !file.startsWith(this.localRoot)) return false;
    rmSync(dirname(file), { recursive: true, force: true });
    return true;
  }

  writeSupportingFile(name: string, filePath: string, fileContent: string): string {
    const skillFile = this.localSkillFile(name);
    const root = dirname(skillFile);
    const target = safeJoin(root, filePath);
    ensureDir(dirname(target));
    writeFileSync(target, fileContent, 'utf8');
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

  renderPromptIndex(): string {
    const skills = this.list();
    if (skills.length === 0) return 'No skills are installed.';
    return skills
      .map((skill) => {
        const skillDir = dirname(skill.path);
        return `- ${skill.name} [${skill.category}]: ${skill.description} | skill_file=${skill.path} | skill_dir=${skillDir}`;
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

  private copyMissingSkillFiles(sourceDir: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSync(sourceDir)) {
      if (name === '.DS_Store') continue;
      const source = join(sourceDir, name);
      const target = join(targetDir, name);
      const stat = statSync(source);
      if (stat.isDirectory()) {
        this.copyMissingSkillFiles(source, target);
        continue;
      }
      if (!existsSync(target)) copyFileSync(source, target);
    }
  }

  private metadataFromFile(file: string, readonly: boolean, source: 'bundled' | 'local'): SkillMetadata {
    const raw = readFileSync(file, 'utf8');
    const { frontmatter } = parseSkillMarkdown(raw);
    const folder = basename(dirname(file));
    const stat = statSync(file);
    return {
      name: String(frontmatter.name ?? folder),
      description: String(frontmatter.description ?? 'No description.'),
      category: String(frontmatter.category ?? basename(dirname(dirname(file))) ?? 'local'),
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

  private belongsToSkillRoot(entryPath: string, skillRoot: string): boolean {
    if (!skillRoot) return !entryPath.includes('/');
    return entryPath.startsWith(`${skillRoot}/`);
  }

  private basenameWithoutExt(path: string): string {
    const normalized = this.normalizeZipPath(path);
    const base = normalized.split('/').pop() ?? 'uploaded-skill';
    return base.replace(/\.[^./\\]+$/, '');
  }
}
