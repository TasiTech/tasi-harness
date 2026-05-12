import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { SkillManager, parseSkillMarkdown } from '../src/main/skills/skillManager.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('SkillManager', () => {
  it('parses YAML-like frontmatter', () => {
    const parsed = parseSkillMarkdown('---\nname: demo\ndescription: Demo skill\ncategory: dev\nallowed: [file_read, terminal]\n---\nBody');
    expect(parsed.frontmatter.name).toBe('demo');
    expect(parsed.frontmatter.allowed).toEqual(['file_read', 'terminal']);
    expect(parsed.body).toBe('Body');
  });

  it('creates and patches a local skill', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const manager = new SkillManager(env.home);
    const doc = manager.create({
      name: 'Repo Review',
      category: 'developer',
      content: '---\nname: repo-review\ndescription: Review repos\n---\n\nStep 1: inspect files.'
    });
    expect(doc.name).toBe('repo-review');
    expect(existsSync(doc.path)).toBe(true);
    const patched = manager.patch({ name: 'repo-review', oldString: 'inspect files', newString: 'inspect files and tests' });
    expect(patched.content).toContain('inspect files and tests');
    expect(manager.list().map((s) => s.name)).toContain('repo-review');
  });

  it('seeds bundled skills without overwriting existing local edits', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const bundledRoot = join(env.home, 'bundled-skills');
    const bundledSkillDir = join(bundledRoot, 'work', 'docx');
    mkdirSync(join(bundledSkillDir, 'scripts', 'templates'), { recursive: true });
    mkdirSync(join(bundledSkillDir, 'ooxml', 'schemas'), { recursive: true });
    writeFileSync(join(bundledSkillDir, 'SKILL.md'), '---\nname: docx\ndescription: bundled\ncategory: work\n---\n\nUse bundled skill.\n', 'utf8');
    writeFileSync(join(bundledSkillDir, 'docx-js.md'), 'reference doc', 'utf8');
    writeFileSync(join(bundledSkillDir, 'scripts', 'document.py'), 'print("ok")\n', 'utf8');
    writeFileSync(join(bundledSkillDir, 'scripts', 'templates', 'people.xml'), '<people />\n', 'utf8');
    writeFileSync(join(bundledSkillDir, 'ooxml', 'schemas', 'wml.xsd'), '<schema />\n', 'utf8');

    const localSkillDir = join(env.home, 'skills', 'work', 'docx');
    mkdirSync(localSkillDir, { recursive: true });
    writeFileSync(join(localSkillDir, 'SKILL.md'), '---\nname: docx\ndescription: local\ncategory: work\n---\n\nKeep local edits.\n', 'utf8');
    writeFileSync(join(localSkillDir, 'stale.txt'), 'old bundled file\n', 'utf8');
    const userSkillDir = join(env.home, 'skills', 'local', 'my-skill');
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(join(userSkillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: user skill\ncategory: local\n---\n\nKeep user skill.\n', 'utf8');

    const manager = new SkillManager(env.home, bundledRoot);
    manager.seedBundledSkills();

    expect(readFileSync(join(localSkillDir, 'SKILL.md'), 'utf8')).toContain('Keep local edits.');
    expect(readFileSync(join(localSkillDir, 'stale.txt'), 'utf8')).toContain('old bundled file');
    expect(readFileSync(join(userSkillDir, 'SKILL.md'), 'utf8')).toContain('Keep user skill.');
    expect(manager.list().find((skill) => skill.name === 'docx')?.bundledPath).toContain(join('bundled-skills', 'work', 'docx', 'SKILL.md'));
  });

  it('installs a bundled skill only when overwrite is chosen', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const bundledRoot = join(env.home, 'bundled-skills');
    const bundledSkillDir = join(bundledRoot, 'work', 'docx');
    mkdirSync(join(bundledSkillDir, 'scripts'), { recursive: true });
    writeFileSync(join(bundledSkillDir, 'SKILL.md'), '---\nname: docx\ndescription: bundled\ncategory: work\n---\n\nUse bundled skill.\n', 'utf8');
    writeFileSync(join(bundledSkillDir, 'scripts', 'document.py'), 'print("ok")\n', 'utf8');

    const localSkillDir = join(env.home, 'skills', 'work', 'docx');
    mkdirSync(localSkillDir, { recursive: true });
    writeFileSync(join(localSkillDir, 'SKILL.md'), '---\nname: docx\ndescription: local\ncategory: work\n---\n\nKeep local edits.\n', 'utf8');
    writeFileSync(join(localSkillDir, 'stale.txt'), 'old bundled file\n', 'utf8');

    const manager = new SkillManager(env.home, bundledRoot);
    expect(() => manager.installBundled('docx')).toThrow(/already exists/i);

    const installed = manager.installBundled('docx', true);
    expect(installed.readonly).toBe(false);
    expect(readFileSync(join(localSkillDir, 'SKILL.md'), 'utf8')).toContain('Use bundled skill.');
    expect(existsSync(join(localSkillDir, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(localSkillDir, 'scripts', 'document.py'), 'utf8')).toContain('print("ok")');
  });

  it('seeds only selected bundled skills when names are provided', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const bundledRoot = join(env.home, 'bundled-skills');
    const bundledDocxDir = join(bundledRoot, 'work', 'docx');
    const bundledPptxDir = join(bundledRoot, 'work', 'pptx');
    mkdirSync(bundledDocxDir, { recursive: true });
    mkdirSync(bundledPptxDir, { recursive: true });
    writeFileSync(join(bundledDocxDir, 'SKILL.md'), '---\nname: docx\ndescription: bundled\ncategory: work\n---\n\nBundled docx.\n', 'utf8');
    writeFileSync(join(bundledPptxDir, 'SKILL.md'), '---\nname: pptx\ndescription: bundled\ncategory: work\n---\n\nBundled pptx.\n', 'utf8');

    const localDocxDir = join(env.home, 'skills', 'work', 'docx');
    const localPptxDir = join(env.home, 'skills', 'work', 'pptx');
    mkdirSync(localDocxDir, { recursive: true });
    mkdirSync(localPptxDir, { recursive: true });
    writeFileSync(join(localDocxDir, 'SKILL.md'), '---\nname: docx\ndescription: local\ncategory: work\n---\n\nLocal docx.\n', 'utf8');
    writeFileSync(join(localPptxDir, 'SKILL.md'), '---\nname: pptx\ndescription: local\ncategory: work\n---\n\nLocal pptx.\n', 'utf8');

    const manager = new SkillManager(env.home, bundledRoot);
    manager.seedBundledSkills({ overwriteSkillNames: ['pptx'] });

    expect(readFileSync(join(localDocxDir, 'SKILL.md'), 'utf8')).toContain('Local docx.');
    expect(readFileSync(join(localPptxDir, 'SKILL.md'), 'utf8')).toContain('Bundled pptx.');
  });

  it('uploads root skill archives with nested supporting files', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const manager = new SkillManager(env.home);
    const zip = new JSZip();
    zip.file('SKILL.md', '---\nname: root-pack\ndescription: root package\ncategory: local\n---\n\nUse support files.\n');
    zip.file('references/provider.md', '# Provider\n\nUse provider.\n');
    zip.file('scripts/run.py', 'print("ok")\n');

    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    const doc = await manager.uploadArchive({
      filename: 'root-pack.zip',
      contentBase64: archive.toString('base64')
    });
    const root = dirname(doc.path);

    expect(readFileSync(join(root, 'references', 'provider.md'), 'utf8')).toContain('Use provider.');
    expect(readFileSync(join(root, 'scripts', 'run.py'), 'utf8')).toContain('print("ok")');
  });
});
