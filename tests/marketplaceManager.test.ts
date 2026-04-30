import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarketplaceManager } from '../src/main/skills/marketplaceManager.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import type { SkillMarketplaceSource } from '../src/shared/types.js';
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
});
