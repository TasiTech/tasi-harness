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

  it('updates bundled skill local copies without changing unrelated local skills', () => {
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

    expect(readFileSync(join(localSkillDir, 'SKILL.md'), 'utf8')).toContain('Use bundled skill.');
    expect(existsSync(join(localSkillDir, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(localSkillDir, 'docx-js.md'), 'utf8')).toContain('reference doc');
    expect(readFileSync(join(localSkillDir, 'scripts', 'document.py'), 'utf8')).toContain('print("ok")');
    expect(readFileSync(join(localSkillDir, 'scripts', 'templates', 'people.xml'), 'utf8')).toContain('<people />');
    expect(readFileSync(join(localSkillDir, 'ooxml', 'schemas', 'wml.xsd'), 'utf8')).toContain('<schema />');
    expect(readFileSync(join(userSkillDir, 'SKILL.md'), 'utf8')).toContain('Keep user skill.');
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
