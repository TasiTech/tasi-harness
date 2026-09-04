import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshCordisHost } from '../src/main/plugins/dshCordisHost.js';
import type { DshSidecarPluginRecord } from '../src/shared/types.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

function pluginRecord(id: string): DshSidecarPluginRecord {
  return {
    id,
    packageName: id,
    source: id,
    version: '1.0.0',
    enabled: true,
    status: 'enabled',
    dshBundlePatch: './cordis.patch.yml',
    profileName: 'default',
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z'
  };
}

function writePlugin(envHome: string, id: string, source: string): { root: string; entry: string; patch: string } {
  const root = join(envHome, id);
  mkdirSync(root, { recursive: true });
  const entry = join(root, 'index.mjs');
  const patch = join(root, 'cordis.patch.yml');
  writeFileSync(entry, source, 'utf8');
  writeFileSync(patch, `- insert:\n  - id: ${id}\n    name: ${id}\n`, 'utf8');
  return { root, entry, patch };
}

describe('DshCordisHost', () => {
  it('loads a function plugin and exposes registered tools', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'demo-tool', `
      export default function apply(ctx) {
        ctx.tools.register({
          name: 'demo_echo',
          description: 'Echo text through a Cordis plugin.',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          output: {
            schema: { type: 'object' },
            render(args, value) { return [{ type: 'text', text: value.message }] }
          },
          async execute(args) { return { message: 'echo:' + args.text } }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('demo-tool'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.tools).toEqual(['demo_echo']);
    expect(host.toolDefinitions()[0]?.function.name).toBe('demo_echo');
    const result = await host.callTool({
      name: 'demo_echo',
      args: { text: 'hi' },
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });
    expect(result).toMatchObject({ ok: true, content: 'echo:hi' });
  });

  it('loads class plugins', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'class-tool', `
      export default class Plugin {
        constructor(ctx) {
          ctx.tools.register({
            name: 'class_ping',
            description: 'Ping from a class plugin.',
            parameters: {},
            async execute() { return [{ type: 'text', text: 'pong' }] }
          })
        }
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('class-tool'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.tools).toEqual(['class_ping']);
    const result = await host.callTool({
      name: 'class_ping',
      args: {},
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });
    expect(result?.content).toBe('pong');
  });

  it('loads named apply exports and records host service registrations', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'service-plugin', `
      export const inject = ['settings', 'webServer', 'jobs', 'sessions', 'agents'];
      export function apply(ctx) {
        ctx.settings.register('Demo Settings', {}, {});
        ctx.webServer.register({ kind: 'exact', path: '/demo' });
        ctx.provide('demo.service', { ok: true });
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('service-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.settingsEntries).toContain('Demo Settings');
    expect(state.webRoutes).toContain('/demo');
    expect(state.providedServices).toContain('demo.service');
    expect(state.missingServices).toEqual([]);
  });

  it('supports webServer.tapIndex for web widget plugins', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'widget-plugin', `
      export const inject = ['webServer']
      export function apply(ctx) {
        ctx.webServer.tapIndex((html) => html.replace('</body>', '<script src="/widget.js"></script></body>'))
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('widget-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });
    const html = await host.transformIndexHtml('<html><body>ok</body></html>');

    expect(state.status).toBe('loaded');
    expect(state.providedServices).toContain('webServer:tapIndex');
    expect(html).toContain('<script src="/widget.js"></script>');
  });

  it('supports web search provider plugins such as Modsearch bundles', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'web-provider-plugin', `
      export const inject = ['tools', 'web']
      export function apply(ctx) {
        ctx.web.registerSearchProvider({
          id: 'modsearch',
          async search(request) {
            return { content: 'searched:' + request.query, sources: [] }
          }
        })
        ctx.tools.register({
          name: 'x_search',
          description: 'Search X posts.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          async execute(args) { return 'x:' + args.query }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('web-provider-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.missingServices).toEqual([]);
    expect(state.providedServices).toContain('web:searchProvider:modsearch');
    expect(state.tools).toEqual(['x_search']);
  });

  it('supports attachment-reading vision plugins such as Modlens bundles', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'vision-plugin', `
      export const inject = ['tools', 'agents', 'attachments', 'llm']
      export function apply(ctx) {
        ctx.tools.register({
          name: 'modlens_read_image',
          description: 'Read image evidence.',
          parameters: { type: 'object', properties: { image: { type: 'object' } }, required: ['image'] },
          async execute(args) {
            const stored = await ctx.attachments.readImage(args.image)
            return 'bytes:' + stored.data.length + ':' + stored.ref.mediaType
          }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('vision-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });
    const result = await host.callTool({
      name: 'modlens_read_image',
      args: { image: { mediaType: 'image/png', data: Buffer.from('png').toString('base64') } },
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });

    expect(state.status).toBe('loaded');
    expect(state.missingServices).toEqual([]);
    expect(state.tools).toEqual(['modlens_read_image']);
    expect(result?.content).toBe('bytes:3:image/png');
  });

  it('passes plugin config and supports system prompt sections', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'configured-plugin', `
      export function apply(ctx, config) {
        ctx.systemPrompt.section({
          name: 'configured-plugin',
          text: () => 'state:' + config.stateDir
        })
        ctx.tools.register({
          name: 'configured_state',
          description: 'Read configured state dir.',
          parameters: {},
          async execute() { return 'state:' + config.stateDir }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('configured-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry,
      config: { stateDir: '.configured-state' }
    });

    expect(state.status).toBe('loaded');
    expect(state.tools).toEqual(['configured_state']);
    const result = await host.callTool({
      name: 'configured_state',
      args: {},
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });
    expect(result?.content).toBe('state:.configured-state');
  });

  it('exposes DSH session request headers and llm config resolution to tools', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'session-plugin', `
      export function apply(ctx) {
        ctx.tools.register({
          name: 'session_header_probe',
          description: 'Reads the DSH session request header.',
          parameters: {},
          async execute(_args, exec) {
            const current = exec.agent.session.requestHeader().config
            const resolved = await ctx.llm.resolveCallConfig(current, exec.signal)
            return resolved.provider + '/' + resolved.model + '/' + resolved.reasoningEffort
          }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    await host.loadPlugin({
      record: pluginRecord('session-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    const result = await host.callTool({
      name: 'session_header_probe',
      args: {},
      context: {
        sessionId: 's1',
        workspaceDir: env.home,
        requestId: 'r1',
        llm: {
          provider: 'openai',
          model: 'gpt-test',
          reasoningEffort: 'high'
        }
      }
    });

    expect(result?.content).toBe('openai/gpt-test/high');
  });

  it('supports subagent setup registration during plugin load', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'subagent-plugin', `
      export function apply(ctx) {
        ctx.subagents.registerContinuableSetup(() => () => undefined)
        ctx.tools.register({
          name: 'subagent_setup_ready',
          description: 'Reports that subagent setup registration completed.',
          parameters: {},
          async execute() { return 'ready' }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('subagent-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.providedServices).toContain('subagents:continuable-setup:1');
    expect(state.tools).toEqual(['subagent_setup_ready']);
  });

  it('passes the service-aware context into inject callbacks', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'inject-plugin', `
      export function apply(ctx) {
        ctx.inject(['commands'], (commandCtx) => {
          commandCtx.commands.register('inject-command', () => 'ok')
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('inject-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.commands).toEqual(['inject-command']);
  });

  it('records client runtime mounts registered by UI plugins', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'ui-plugin', `
      export function apply(ctx) {
        ctx.clientRuntime.register({
          id: 'companion',
          title: 'Demo Companion',
          mountPoint: 'desktop-companion',
          permissions: ['window.desktop']
        })
        ctx.clientRuntime.registerSidebar({
          id: 'sidebar-entry',
          title: 'Sidebar Entry'
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default', clientBaseUrl: 'http://127.0.0.1:3456' });

    const state = await host.loadPlugin({
      record: pluginRecord('ui-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.clientMounts).toHaveLength(2);
    expect(state.clientMounts[0]).toMatchObject({
      id: 'companion',
      pluginId: 'ui-plugin',
      mountPoint: 'desktop-companion',
      title: 'Demo Companion',
      permissions: ['window.desktop']
    });
    expect(state.clientMounts[0]?.url).toBe('http://127.0.0.1:3456/client-mount/ui-plugin/companion/');
    expect(state.clientMounts[1]).toMatchObject({
      id: 'sidebar-entry',
      mountPoint: 'sidebar',
      title: 'Sidebar Entry'
    });
  });

  it('loads skill-provider-only plugins such as Superdesign bundles', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'skill-provider-plugin', `
      let providerSignal
      const provider = {
        name: 'superdesign',
        async list() {
          return [{
            name: 'superdesign',
            description: 'Design frontend UI on an infinite canvas.',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'superdesign',
            source: 'bundled',
            rank: 600
          }]
        },
        async get() {
          return {
            name: 'superdesign',
            description: 'Design frontend UI on an infinite canvas.',
            invocation: { modelInvocable: true, userInvocable: true },
            provider: 'superdesign',
            source: 'bundled',
            content: 'Use Superdesign for UI work.'
          }
        }
      }
      export const inject = ['skills']
      export function apply(ctx) {
        ctx.skills.registerProvider((control) => {
          providerSignal = control.signal
          return provider
        })
        ctx.skills.register({
          name: 'runtime-helper',
          description: 'Runtime helper skill.',
          source: 'runtime',
          content: 'Runtime helper body.'
        })
        ctx.tools.register({
          name: 'skill_provider_probe',
          description: 'Reads the registered skill provider.',
          parameters: {},
          async execute() {
            const listed = await ctx.skills.list()
            const superdesign = await ctx.skills.get('superdesign')
            const runtime = await ctx.skills.get('runtime-helper')
            return JSON.stringify({
              listed: listed.map((skill) => skill.name).sort(),
              superdesign: superdesign?.content,
              runtime: runtime?.content,
              hasSignal: !!providerSignal
            })
          }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('skill-provider-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.missingServices).toEqual([]);
    expect(state.providedServices).toContain('skills:superdesign');
    expect(state.providedServices).toContain('skills:runtime:runtime-helper');
    const result = await host.callTool({
      name: 'skill_provider_probe',
      args: {},
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });
    expect(JSON.parse(result?.content ?? '{}')).toEqual({
      listed: ['runtime-helper', 'superdesign'],
      superdesign: 'Use Superdesign for UI work.',
      runtime: 'Runtime helper body.',
      hasSignal: true
    });
    const skills = await host.skillDocuments();
    expect(skills.map((skill) => skill.name).sort()).toEqual(['runtime-helper', 'superdesign']);
    expect(skills.find((skill) => skill.name === 'superdesign')).toMatchObject({
      description: 'Design frontend UI on an infinite canvas.',
      pluginId: 'skill-provider-plugin',
      packageName: 'skill-provider-plugin',
      content: 'Use Superdesign for UI work.'
    });
  });

  it('reports skills-only plugins as not directly chat-callable', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'skills-only-plugin', `
      export const inject = ['skills']
      export function apply(ctx) {
        ctx.skills.registerProvider(() => ({
          name: 'superdesign',
          async list() {
            return [{ name: 'superdesign', description: 'Design frontend UI.' }]
          },
          async get() {
            return { name: 'superdesign', content: 'Use Superdesign for UI work.' }
          }
        }))
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('skills-only-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });
    const result = await host.runChat({
      pluginRef: 'skills-only-plugin',
      sessionId: 's1',
      workspaceDir: env.home,
      input: {
        parts: [{ type: 'text', text: '@skills-only-plugin design a page' }]
      }
    });

    expect(state.status).toBe('loaded');
    expect(state.tools).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('has no direct sidecar chat entrypoint');
    expect(result.content).toContain('Skills-only plugins');
  });

  it('provides host services expected by dsh-im style channel plugins', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'im-host-plugin', `
      export const inject = ['connection', 'credentials', 'typertGateway'];
      export async function apply(ctx) {
        if (typeof ctx.connection?.rpc?.handle !== 'function') throw new Error('missing connection rpc');
        if (typeof ctx.credentials?.resolve !== 'function') throw new Error('missing credentials resolve');
        if (typeof ctx.credentials?.set !== 'function') throw new Error('missing credentials set');
        if (typeof ctx.credentials?.unset !== 'function') throw new Error('missing credentials unset');
        if (typeof ctx.typertGateway?.invoke !== 'function') throw new Error('missing typert invoke');
        if (typeof ctx.typertGateway?.stream !== 'function') throw new Error('missing typert stream');
        await ctx.inject(['sessionController', 'workspaceController'], async (readyCtx) => {
          readyCtx.connection.rpc.handle('/im-test', async () => ({ ok: true, value: { ready: true } }));
          await readyCtx.credentials.set('dsh-im:test', 'secret');
          const credential = await readyCtx.credentials.resolve('dsh-im:test');
          if (credential?.value !== 'secret') throw new Error('credential roundtrip failed');
          await readyCtx.credentials.unset('dsh-im:test');
        });
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('im-host-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(state.missingServices).toEqual([]);
    expect(state.providedServices).toContain('rpc:/im-test');
  });

  it('provides reusable DSH runtime services without per-plugin shims', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'standard-services-plugin', `
      export const inject = [
        'storage',
        'storageDomain',
        'workspaceRegistry',
        'workspaces',
        'sandboxPolicy',
        'locale',
        'slots',
        'remote',
        'remote.session',
        'uiConversation',
        'uiWorkspace',
        'modelDirectories',
        'conversation',
        'commandUi',
        'uiSession',
        'settingsScope'
      ];
      let snapshot
      export async function apply(ctx) {
        const domain = await ctx.storageDomain.open({
          name: 'compat-domain',
          global: { initial: { count: 0 } },
          tables: { items: {} }
        })
        const items = domain.table('items')
        await items.put('alpha', { ok: true })
        await domain.global.set({ count: 1 })
        const workspace = await ctx.workspaceRegistry.create(process.cwd(), 'Compat Workspace')
        await workspace.insertSessionBefore('s1')
        const policy = ctx.sandboxPolicy.resolve({
          session: { id: 's1', header: { cwd: process.cwd() }, events: [] }
        })
        ctx.locale.register('compat', { zh: { hi: '你好 {name}' }, en: { hi: 'Hello {name}' } })
        const translated = ctx.locale.bind('compat')('hi', { name: 'DSH' })
        ctx.slots.register({ name: 'settings.section', id: 'compat-settings' }, function CompatSettings() {})
        const remotePick = await ctx.remote.directoryPicker.pick()
        ctx.uiConversation.events.register({ name: 'compat-event' })
        const modelState = await ctx.modelDirectories.directoryFor('s1').load()
        ctx.conversation.blocks.set('s1', { reason: 'blocked' })
        await ctx.settingsScope.set('ready', true)
        snapshot = {
          item: items.get('alpha'),
          itemCount: items.size,
          global: domain.global.get(),
          workspaceTitle: workspace.title,
          workspaceSessions: workspace.sessionIds,
          workspaces: ctx.workspaces.list().length,
          policyMode: policy.mode,
          translated,
          slots: ctx.slots.entries('settings.section').length,
          remotePick,
          modelPhase: modelState.phase,
          block: ctx.conversation.blocks.get('s1'),
          settingsReady: ctx.settingsScope.get('ready')
        }
        ctx.tools.register({
          name: 'standard_services_probe',
          description: 'Reports standard DSH services exposed by the Tasi host.',
          parameters: {},
          async execute() { return JSON.stringify(snapshot) }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('standard-services-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });
    const result = await host.callTool({
      name: 'standard_services_probe',
      args: {},
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });

    expect(state.status).toBe('loaded');
    expect(state.missingServices).toEqual([]);
    expect(state.tools).toEqual(['standard_services_probe']);
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({
      item: { ok: true },
      itemCount: 1,
      global: { count: 1 },
      workspaceTitle: 'Compat Workspace',
      workspaceSessions: ['s1'],
      workspaces: 1,
      policyMode: 'workspace-write',
      translated: '你好 DSH',
      slots: 1,
      remotePick: { ok: true, value: null },
      modelPhase: 'ready',
      block: { reason: 'blocked' },
      settingsReady: true
    });
  });

  it('queues DSH session prompts and exposes completed history events', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const calls: Array<{ method: string; params: unknown }> = [];
    const plugin = writePlugin(env.home, 'im-prompt-plugin', `
      let prompted
      let gateway
      export async function apply(ctx) {
        gateway = ctx.typertGateway
        prompted = await ctx.typertGateway.invoke({
          namespace: 'session',
          method: 'prompt',
          args: {
            request: {
              sessionId: 'qq-demo',
              input: 'hello from qq'
            }
          }
        })
        ctx.tools.register({
          name: 'im_prompt_probe',
          description: 'Reports the prompt bridge result.',
          parameters: {},
          async execute() {
            const history = await gateway.invoke({
              namespace: 'session',
              method: 'history',
              args: { sessionId: 'qq-demo', maxMessages: 50 }
            })
            return JSON.stringify({ prompted, history })
          }
        })
      }
    `);
    const host = new DshCordisHost({
      sidecarHome: env.home,
      profileName: 'default',
      mainRequest: async (method, params) => {
        calls.push({ method, params });
        return { sessionId: 'main-session', finalResponse: 'reply from tasi' };
      }
    });

    const state = await host.loadPlugin({
      record: pluginRecord('im-prompt-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('loaded');
    expect(calls[0]?.method).toBe('main.chat.run');
    expect(calls[0]?.params).toMatchObject({
      source: 'dsh-sidecar',
      endpoint: 'session/prompt',
      input: 'hello from qq'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await host.callTool({
      name: 'im_prompt_probe',
      args: {},
      context: { sessionId: 's1', workspaceDir: env.home, requestId: 'r1' }
    });
    const content = JSON.parse(result?.content ?? '{}');
    expect(content.prompted).toMatchObject({ accepted: true, queued: true, sessionId: 'qq-demo' });
    expect(JSON.stringify(content.history)).toContain('reply from tasi');
  });

  it('supports command followup during sidecar chat runs', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'followup-plugin', `
      export function apply(ctx) {
        ctx.commands.register({
          name: 'followup-command',
          handler(invocation) {
            invocation.agent.followup({
              content: [{ type: 'text', text: 'followed:' + invocation.rawInput }],
              source: { kind: 'plugin' }
            })
            return { kind: 'success', text: 'done' }
          }
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    await host.loadPlugin({
      record: pluginRecord('followup-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    const result = await host.runChat({
      pluginRef: 'followup-plugin',
      sessionId: 's1',
      workspaceDir: env.home,
      input: {
        parts: [{ type: 'text', text: '@followup-plugin explain weather forecasts' }]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.messages?.[0]?.content).toContain('followed: explain weather forecasts');
    expect(result.content).toContain('done');
    expect(result.content).not.toContain('@followup-plugin');
  });

  it('routes sidecar chat runs to plugin command handlers with input parts', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'chat-plugin', `
      export default function apply(ctx) {
        ctx.commands.registerSlash('demo-chat', async (turn) => {
          return 'handled:' + turn.parts.map((part) => part.type).join(',') + ':' + turn.input
        })
      }
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    await host.loadPlugin({
      record: pluginRecord('chat-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    const result = await host.runChat({
      pluginRef: 'chat-plugin',
      sessionId: 's1',
      workspaceDir: env.home,
      input: {
        parts: [
          { type: 'text', text: '@chat-plugin /demo-chat summarize' },
          { type: 'image', name: 'screen.png', mime: 'image/png', data: 'abc' }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('handled:text,image:@chat-plugin /demo-chat summarize');
    expect(result.diagnostics?.command).toBe('/demo-chat');
  });

  it('reports module load failures without crashing the host', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const plugin = writePlugin(env.home, 'broken-plugin', `
      throw new Error('boom')
    `);
    const host = new DshCordisHost({ sidecarHome: env.home, profileName: 'default' });

    const state = await host.loadPlugin({
      record: pluginRecord('broken-plugin'),
      packageRoot: plugin.root,
      patchPath: plugin.patch,
      moduleEntry: plugin.entry
    });

    expect(state.status).toBe('failed');
    expect(state.lastError).toContain('boom');
    expect(host.toolDefinitions()).toEqual([]);
  });
});
