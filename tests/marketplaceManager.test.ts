import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { MarketplaceManager } from '../src/main/skills/marketplaceManager.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import type { MarketplaceSkillSnapshot, SkillMarketplaceSource } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('MarketplaceManager', () => {
  it('expands Chinese aliases so 小红书 can find xiaohongshu skills', async () => {
    const env = tempHome();
    cleanup = env.cleanup;

    const resourcesRoot = join(env.home, 'resources');
    mkdirSync(join(resourcesRoot, 'markets'), { recursive: true });
    writeFileSync(join(resourcesRoot, 'markets', 'clawhub.json'), JSON.stringify({ market: { id: 'clawhub' }, skills: [] }), 'utf8');

    const skillManager = new SkillManager(env.home);
    const sources: SkillMarketplaceSource[] = [{
      id: 'clawhub',
      name: 'ClawHub',
      description: 'ClawHub source',
      catalogUrl: 'https://wry-manatee-359.convex.cloud/api/query',
      enabled: true
    }];
    const manager = new MarketplaceManager(resourcesRoot, skillManager, () => sources);

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (urlText.endsWith('/api/action') && body.path === 'search:searchSkills') {
        if (body.args?.query === '\u5c0f\u7ea2\u4e66') {
          return new Response(JSON.stringify({ status: 'success', value: [] }), { status: 200 });
        }
        if (body.args?.query === 'xiaohongshu') {
          return new Response(JSON.stringify({
            status: 'success',
            value: [{
              ownerHandle: 'enjoytdl',
              skill: {
                slug: 'xiaohongshu-publish',
                displayName: 'Xiaohongshu Publish',
                summary: 'Publish long-form Xiaohongshu notes.'
              }
            }]
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'success', value: [] }), { status: 200 });
      }
      if (urlText.endsWith('/api/query') && body.path === 'skills:listPublicPageV4') {
        return new Response(JSON.stringify({ status: 'success', value: { page: [], hasMore: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'success', value: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await manager.browse('\u5c0f\u7ea2\u4e66');
    expect(result.skills.map((skill) => skill.id)).toContain('xiaohongshu-publish');

    const actionQueries = fetchMock.mock.calls
      .map((call) => {
        const [url, init] = call;
        const parsed = init?.body ? JSON.parse(String(init.body)) : null;
        if (!String(url).endsWith('/api/action') || parsed?.path !== 'search:searchSkills') return null;
        return parsed.args?.query as string | undefined;
      })
      .filter((item): item is string => Boolean(item));
    expect(actionQueries).toContain('\u5c0f\u7ea2\u4e66');
    expect(actionQueries).toContain('xiaohongshu');
  });

  it('installs from the clicked marketplace snapshot when the default browse list does not contain the skill', async () => {
    const env = tempHome();
    cleanup = env.cleanup;

    const resourcesRoot = join(env.home, 'resources');
    mkdirSync(join(resourcesRoot, 'markets'), { recursive: true });
    writeFileSync(join(resourcesRoot, 'markets', 'clawhub.json'), JSON.stringify({ market: { id: 'clawhub' }, skills: [] }), 'utf8');

    const skillManager = new SkillManager(env.home);
    const sources: SkillMarketplaceSource[] = [{
      id: 'clawhub',
      name: 'ClawHub',
      description: 'ClawHub source',
      catalogUrl: 'https://wry-manatee-359.convex.cloud/api/query',
      enabled: true
    }];
    const manager = new MarketplaceManager(resourcesRoot, skillManager, () => sources);

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (urlText.endsWith('/api/query') && body.path === 'skills:listPublicPageV4') {
        return new Response(JSON.stringify({ status: 'success', value: { page: [], hasMore: false } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'success', value: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const snapshot: MarketplaceSkillSnapshot = {
      id: 'xiaohongshu-publish',
      sourceId: 'clawhub',
      sourceName: 'ClawHub',
      name: 'Xiaohongshu Publish',
      description: 'Publish long-form Xiaohongshu notes.',
      category: 'content',
      version: 'latest',
      readme: 'Publish long-form Xiaohongshu notes.',
      skillContent: ['---', 'name: \"xiaohongshu-publish\"', 'description: \"Publish long-form Xiaohongshu notes.\"', 'category: \"content\"', '---', '', '# Xiaohongshu Publish', '', 'Publish long-form Xiaohongshu notes.', ''].join('\n'),
      homepage: 'https://clawhub.ai/skills/xiaohongshu-publish',
      remoteVersionId: 'ver_123'
    };

    const installed = await manager.install({
      sourceId: 'clawhub',
      skillId: 'xiaohongshu-publish',
      skill: snapshot
    });

    expect(installed.installed).toBe(true);
    expect(installed.installedSkillName).toBe('xiaohongshu-publish');
    expect(skillManager.read('xiaohongshu-publish')?.content).toContain('marketplace_source_id: clawhub');
  });

  it('installs ClawHub archive supporting files when a zip package is available', async () => {
    const env = tempHome();
    cleanup = env.cleanup;

    const resourcesRoot = join(env.home, 'resources');
    mkdirSync(join(resourcesRoot, 'markets'), { recursive: true });
    writeFileSync(join(resourcesRoot, 'markets', 'clawhub.json'), JSON.stringify({ market: { id: 'clawhub' }, skills: [] }), 'utf8');

    const skillManager = new SkillManager(env.home);
    const sources: SkillMarketplaceSource[] = [{
      id: 'clawhub',
      name: 'ClawHub',
      description: 'ClawHub source',
      catalogUrl: 'https://wry-manatee-359.convex.cloud/api/query',
      enabled: true
    }];
    const manager = new MarketplaceManager(resourcesRoot, skillManager, () => sources);
    const zip = new JSZip();
    zip.file('SKILL.md', '---\nname: archive-pack\ndescription: Install archive pack.\ncategory: content\n---\n\nUse bundled helpers.\n');
    zip.file('references/provider.md', '# Provider\n\nUse the provider guide.\n');
    zip.file('scripts/run.py', 'print("archive")\n');
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (urlText.endsWith('/api/query') && body.path === 'skills:listPublicPageV4') {
        return new Response(JSON.stringify({ status: 'success', value: { page: [], hasMore: false } }), { status: 200 });
      }
      if (urlText === 'https://wry-manatee-359.convex.site/api/v1/download?slug=archive-pack&version=1.2.3') {
        return new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const snapshot: MarketplaceSkillSnapshot = {
      id: 'archive-pack',
      sourceId: 'clawhub',
      sourceName: 'ClawHub',
      name: 'Archive Pack',
      description: 'Install archive pack.',
      category: 'content',
      version: '1.2.3',
      readme: 'Install archive pack.',
      skillContent: ['---', 'name: archive-pack', 'description: Install archive pack.', 'category: content', '---', '', '# Archive Pack', ''].join('\n'),
      homepage: 'https://clawhub.ai/skills/archive-pack',
      remoteVersionId: 'ver_456'
    };

    const installed = await manager.install({
      sourceId: 'clawhub',
      skillId: 'archive-pack',
      skill: snapshot
    });
    const doc = skillManager.read(installed.installedSkillName ?? 'archive-pack');
    expect(doc?.content).toContain('marketplace_source_id: clawhub');
    expect(readFileSync(join(dirname(doc?.path ?? ''), 'references', 'provider.md'), 'utf8')).toContain('Use the provider guide.');
    expect(readFileSync(join(dirname(doc?.path ?? ''), 'scripts', 'run.py'), 'utf8')).toContain('print("archive")');
  });
});
