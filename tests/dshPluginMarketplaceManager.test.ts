import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshPluginMarketplaceManager } from '../src/main/plugins/dshPluginMarketplaceManager.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('DshPluginMarketplaceManager', () => {
  it('normalizes the current SkillHub plugin API shape', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/plugins?')) {
        return new Response(JSON.stringify({
          items: [{
            description: 'AgentTeams plugin for DeepSeek Harness',
            fullName: 'nanmicoder/dsh-agent-teams',
            homepage: '',
            manifest: {
              name: '@nanmicoder/dsh-agent-teams',
              version: '0.1.15'
            },
            name: 'dsh-agent-teams',
            owner: 'NanmiCoder',
            repositoryUrl: 'https://github.com/NanmiCoder/dsh-agent-teams',
            stars: 1240,
            topics: ['dsh-plugin']
          }],
          page: 1,
          pageSize: 100,
          total: 1
        }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const sidecar = {
      list: async () => ({
        status: {
          available: true,
          running: false,
          protocolVersion: 1,
          home: '/tmp/tasi/dsh-sidecar',
          profileName: 'default',
          profileDir: '/tmp/tasi/dsh-sidecar/profiles/default'
        },
        plugins: []
      })
    };
    const manager = new DshPluginMarketplaceManager(sidecar as never);

    const result = await manager.browse();

    expect(result.total).toBe(1);
    expect(result.plugins[0]).toMatchObject({
      id: 'NanmiCoder/dsh-agent-teams',
      owner: 'NanmiCoder',
      slug: 'dsh-agent-teams',
      version: '0.1.15',
      installSource: '@nanmicoder/dsh-agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      tags: ['dsh-plugin'],
      downloads: 1240
    });
  });

  it('falls back to a pasted SkillHub plugin URL when the public API returns SPA HTML', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<!DOCTYPE html><div id="app"></div>', {
      headers: { 'content-type': 'text/html' }
    })) as typeof fetch;
    const sidecar = {
      list: async () => ({
        status: {
          available: true,
          running: false,
          protocolVersion: 1,
          home: '/tmp/tasi/dsh-sidecar',
          profileName: 'default',
          profileDir: '/tmp/tasi/dsh-sidecar/profiles/default'
        },
        plugins: []
      })
    };
    const manager = new DshPluginMarketplaceManager(sidecar as never);

    const result = await manager.browse('https://skillhub.cn/plugins/NanmiCoder/dsh-agent-teams');

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      id: 'NanmiCoder/dsh-agent-teams',
      owner: 'NanmiCoder',
      slug: 'dsh-agent-teams',
      installSource: '@nanmicoder/dsh-agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      installed: false
    });
  });

  it('marks scoped SkillHub entries installed when the actual npm package is unscoped', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/plugins?')) {
        return new Response(JSON.stringify({
          items: [{
            owner: 'vlln',
            slug: 'whale-girl',
            name: 'whale-girl',
            manifest: {
              name: '@vlln/whale-girl',
              version: '0.1.0'
            },
            repositoryUrl: 'https://github.com/vlln/whale-girl'
          }],
          total: 1
        }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const sidecar = {
      list: async () => ({
        status: {
          available: true,
          running: false,
          protocolVersion: 1,
          home: '/tmp/tasi/dsh-sidecar',
          profileName: 'default',
          profileDir: '/tmp/tasi/dsh-sidecar/profiles/default'
        },
        plugins: [{
          id: 'whale-girl',
          packageName: 'whale-girl',
          source: 'whale-girl',
          enabled: true,
          status: 'enabled',
          profileName: 'default',
          installedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z'
        }]
      })
    };
    const manager = new DshPluginMarketplaceManager(sidecar as never);

    const result = await manager.browse();

    expect(result.plugins[0]).toMatchObject({
      packageName: '@vlln/whale-girl',
      installed: true,
      installedPluginId: 'whale-girl',
      enabled: true,
      status: 'enabled'
    });
  });

  it('sanitizes quoted search queries and still matches Superdesign fallback entries', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/v1/plugins?')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const sidecar = {
      list: async () => ({
        status: {
          available: true,
          running: false,
          protocolVersion: 1,
          home: '/tmp/tasi/dsh-sidecar',
          profileName: 'default',
          profileDir: '/tmp/tasi/dsh-sidecar/profiles/default'
        },
        plugins: []
      })
    };
    const manager = new DshPluginMarketplaceManager(sidecar as never);

    const result = await manager.browse("de'si");

    expect(requestedUrls[0]).toContain('q=desi');
    expect(requestedUrls[0]).not.toContain('%27');
    expect(result.plugins[0]).toMatchObject({
      packageName: 'superdesign-dsh',
      installSource: 'github:superdesigndev/superdesign-skill'
    });
  });
});
