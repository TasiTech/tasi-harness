import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshSidecarManager } from '../src/main/plugins/dshSidecarManager.js';
import { clientMountShellHtml, clientMountsFromManifest, dshFindInstalledPackage, dshPluginInstallSourceCandidates, listWorkspaceDirectory, moduleEntryPath, prereleaseFallbackSpecifier } from '../src/main/plugins/dshSidecarProcess.js';
import { DshSidecarStore } from '../src/main/plugins/dshSidecarStore.js';
import type { DshSidecarPluginRecord } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

function pluginRecord(overrides: Partial<DshSidecarPluginRecord> = {}): DshSidecarPluginRecord {
  return {
    id: 'nanmicoder-dsh-agent-teams',
    packageName: '@nanmicoder/dsh-agent-teams',
    source: '@nanmicoder/dsh-agent-teams',
    version: '0.1.15',
    enabled: true,
    status: 'enabled',
    dshBundlePatch: './cordis.patch.yml',
    profileName: 'default',
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

describe('DshSidecarManager', () => {
  it('lists persisted plugins without starting the sidecar process', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const sidecarHome = join(env.home, 'dsh-sidecar');
    const store = new DshSidecarStore(sidecarHome);
    store.upsert({
      id: 'xmanrui-dsh-im',
      packageName: '@xmanrui/dsh-im',
      source: '@xmanrui/dsh-im',
      version: '1.0.0',
      enabled: false,
      status: 'installed',
      dshBundlePatch: './cordis.patch.yml',
      profileName: 'default',
      installedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    });

    const manager = new DshSidecarManager(env.home);
    const result = await manager.list();

    expect(result.status.running).toBe(false);
    expect(result.status.home).toBe(sidecarHome);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.packageName).toBe('@xmanrui/dsh-im');
  });

  it('can remove persisted plugins by package name when ids drift', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const sidecarHome = join(env.home, 'dsh-sidecar');
    const store = new DshSidecarStore(sidecarHome);
    store.upsert({
      id: 'nanmicoder-dsh-agent-teams',
      packageName: '@nanmicoder/dsh-agent-teams',
      source: '@nanmicoder/dsh-agent-teams',
      version: '0.1.15',
      enabled: true,
      status: 'enabled',
      dshBundlePatch: './cordis.patch.yml',
      profileName: 'default',
      installedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    });

    expect(store.removeBy({ id: 'NanmiCoder/dsh-agent-teams', packageName: '@nanmicoder/dsh-agent-teams' })).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('falls back from scoped SkillHub package names to GitHub source candidates', () => {
    expect(dshPluginInstallSourceCandidates('@vlln/whale-girl', '@vlln/whale-girl')).toEqual([
      '@vlln/whale-girl',
      'whale-girl',
      'github:vlln/whale-girl'
    ]);
  });

  it('recognizes unscoped package keys created by scoped SkillHub installs', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const profile = join(env.home, 'dsh-sidecar', 'profiles', 'default');
    const root = join(profile, 'node_modules', 'whale-girl');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      type: 'module',
      dependencies: {
        'whale-girl': '^0.1.0'
      }
    }), 'utf8');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'whale-girl',
      version: '0.1.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }), 'utf8');

    expect(dshFindInstalledPackage(profile, '@vlln/whale-girl', '@vlln/whale-girl')).toBe('whale-girl');
  });

  it('resolves DSH runtime entries from package exports before falling back to main', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const root = join(env.home, 'modsearch');
    mkdirSync(join(root, 'dsh'), { recursive: true });
    writeFileSync(join(root, 'dsh', 'index.js'), 'export function apply() {}', 'utf8');

    expect(moduleEntryPath(root, {
      main: './missing.js',
      exports: {
        '.': './dsh/index.js',
        './dsh': './dsh/index.js'
      }
    })).toBe(join(root, 'dsh', 'index.js'));
  });

  it('uses npm dist-tags for DeepSeek prerelease peer dependencies when stable ranges are unavailable', () => {
    const error = [
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh-sandbox-policy@>=0.1.2 <0.2.0-0',
      'Other releases are:',
      '- next: 0.1.2-rc.1'
    ].join('\n');

    expect(prereleaseFallbackSpecifier('@deepseek-ai/dsh-sandbox-policy@>=0.1.2 <0.2.0-0', error)).toBe('@deepseek-ai/dsh-sandbox-policy@next');
    expect(prereleaseFallbackSpecifier('left-pad@>=1.0.0', error)).toBeUndefined();
  });

  it('does not create a visible client mount for DSH web dependency injection only', () => {
    const mounts = clientMountsFromManifest(pluginRecord(), {
      name: '@nanmicoder/dsh-agent-teams',
      exports: {
        './client': './lib/client.js'
      },
      dsh: {
        client: {
          platform: 'web',
          inject: [
            '@deepseek-ai/dsh-client-ui-layout',
            '@deepseek-ai/dsh-client-ui-chat'
          ]
        }
      }
    });

    expect(mounts).toEqual([]);
  });

  it('creates a desktop companion mount for standalone web client plugins', () => {
    const mounts = clientMountsFromManifest(pluginRecord({
      id: 'whale-girl',
      packageName: 'whale-girl',
      source: 'whale-girl',
      version: '0.1.0'
    }), {
      name: 'whale-girl',
      description: 'Desktop pet for DSH Web GUI.',
      exports: {
        './client': './lib/client.js'
      },
      dsh: {
        client: {
          platform: 'web'
        }
      }
    });

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      id: 'client',
      pluginId: 'whale-girl',
      packageName: 'whale-girl',
      mountPoint: 'desktop-companion'
    });
  });

  it('keeps non-pet standalone web client plugins in a panel by default', () => {
    const mounts = clientMountsFromManifest(pluginRecord({
      id: 'demo-dashboard',
      packageName: 'demo-dashboard',
      source: 'demo-dashboard'
    }), {
      name: 'demo-dashboard',
      exports: {
        './client': './lib/client.js'
      },
      dsh: {
        client: {
          platform: 'web'
        }
      }
    });

    expect(mounts[0]).toMatchObject({
      mountPoint: 'right-panel'
    });
  });

  it('creates a settings mount for DSH client settings extensions without standalone routes', () => {
    const mounts = clientMountsFromManifest(pluginRecord({
      id: 'xmanrui-dsh-im',
      packageName: '@xmanrui/dsh-im',
      source: '@xmanrui/dsh-im',
      version: '4.7.0'
    }), {
      name: '@xmanrui/dsh-im',
      exports: {
        './client': './lib/client.js'
      },
      dsh: {
        client: {
          platform: 'web',
          inject: [
            '@deepseek-ai/dsh-client-connection',
            '@deepseek-ai/dsh-client-runtime',
            '@deepseek-ai/dsh-client-ui-settings',
            '@deepseek-ai/dsh-client-ui-slots'
          ]
        }
      }
    });

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      id: 'settings',
      pluginId: 'xmanrui-dsh-im',
      packageName: '@xmanrui/dsh-im',
      title: '@xmanrui/dsh-im Settings',
      mountPoint: 'settings'
    });
  });

  it('creates client mounts when a plugin explicitly declares standalone UI', () => {
    const mounts = clientMountsFromManifest(pluginRecord({
      id: 'demo-ui',
      packageName: 'demo-ui',
      source: 'demo-ui'
    }), {
      name: 'demo-ui',
      dsh: {
        client: {
          platform: 'web',
          mounts: [{
            id: 'panel',
            title: 'Demo Panel',
            mountPoint: 'right-panel',
            path: 'assets/panel.js'
          }]
        }
      }
    });

    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({
      id: 'panel',
      pluginId: 'demo-ui',
      packageName: 'demo-ui',
      title: 'Demo Panel',
      mountPoint: 'right-panel'
    });
  });

  it('supports lazy DSH client modules that register settings plugin item slots', () => {
    const html = clientMountShellHtml({
      id: 'client',
      pluginId: 'liustack-modlens',
      packageName: '@liustack/modlens',
      title: '@liustack/modlens',
      mountPoint: 'right-panel',
      url: '/client-mount/liustack-modlens/client/',
      permissions: []
    }, 'liustack-modlens', 'client', undefined, '/client-asset/liustack-modlens/dsh/client.js');

    expect(html).toContain('__ModuleLoader__');
    expect(html).toContain('settings.plugin.item');
    expect(html).toContain('consumeEffectResult(callback())');
    expect(html).toContain("@deepseek-ai/dsh-client-ui-primitives");
    expect(html).toContain('React.createElement(active.component');
  });

  it('lists workspace directories for client mounted plugin pickers', () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const root = join(env.home, 'workspace');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.cache'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# demo', 'utf8');

    const listing = listWorkspaceDirectory(root);

    expect(listing.path).toBe(root);
    expect(listing.crumbs.at(-1)).toMatchObject({ name: 'workspace', path: root });
    expect(listing.entries).toEqual([
      { name: '.cache', path: join(root, '.cache'), hidden: true },
      { name: 'src', path: join(root, 'src'), hidden: false }
    ]);
  });
});
