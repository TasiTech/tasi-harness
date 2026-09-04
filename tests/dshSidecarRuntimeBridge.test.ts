import { afterEach, describe, expect, it } from 'vitest';
import type { DshSidecarRuntimeSkill, DshSidecarToolCallRequest, ToolDefinition, ToolExecutionResult } from '../src/shared/types.js';
import { ConfigStore } from '../src/main/storage/configStore.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { ToolRegistry } from '../src/main/tools/toolRegistry.js';
import type { DshSidecarManager } from '../src/main/plugins/dshSidecarManager.js';
import { DshSidecarRuntimeBridge } from '../src/main/plugins/dshSidecarRuntimeBridge.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('DshSidecarRuntimeBridge', () => {
  it('registers sidecar runtime tools and enables them for the agent loop', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const configStore = new ConfigStore(env.home);
    const registry = new ToolRegistry();
    const calls: DshSidecarToolCallRequest[] = [];
    const tool: ToolDefinition = {
      type: 'function',
      function: {
        name: 'agent_teams_view',
        description: 'View a compatibility team.',
        parameters: { type: 'object', properties: {} }
      }
    };
    const sidecar = {
      runtimeTools: async () => [tool],
      callRuntimeTool: async (req: DshSidecarToolCallRequest): Promise<ToolExecutionResult> => {
        calls.push(req);
        return { ok: true, content: 'team view' };
      }
    } as unknown as DshSidecarManager;

    const bridge = new DshSidecarRuntimeBridge(sidecar, registry, configStore);
    const result = await bridge.sync();

    expect(result.toolNames).toEqual(['agent_teams_view']);
    expect(registry.names()).toContain('agent_teams_view');
    expect(configStore.get().enabledToolNames).toContain('agent_teams_view');
    const executed = await registry.execute('agent_teams_view', { team_id: 'demo' }, {
      sessionId: 'session-1',
      workspaceDir: env.home,
      requestId: 'call-1'
    });
    expect(executed.content).toBe('team view');
    expect(calls[0]).toMatchObject({
      name: 'agent_teams_view',
      args: { team_id: 'demo' },
      context: {
        sessionId: 'session-1',
        workspaceDir: env.home,
        requestId: 'call-1'
      }
    });
  });

  it('syncs sidecar runtime skills into the installed skill index', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const configStore = new ConfigStore(env.home);
    const registry = new ToolRegistry();
    const skillManager = new SkillManager(env.home);
    const runtimeSkill: DshSidecarRuntimeSkill = {
      name: 'superdesign',
      description: 'Design frontend UI on the Superdesign canvas.',
      pluginId: 'superdesign-dsh',
      packageName: 'superdesign-dsh',
      path: 'C:\\plugin\\skills\\superdesign\\SKILL.md',
      content: '---\nname: superdesign\ndescription: Design frontend UI on the Superdesign canvas.\n---\n\nUse Superdesign for UI work.'
    };
    const sidecar = {
      runtimeTools: async () => [],
      runtimeSkills: async () => [runtimeSkill]
    } as unknown as DshSidecarManager;

    const bridge = new DshSidecarRuntimeBridge(sidecar, registry, configStore, skillManager);
    await bridge.sync();

    expect(skillManager.list().find((skill) => skill.name === 'superdesign')).toMatchObject({
      source: 'dsh',
      readonly: true,
      category: 'dsh',
      displayCategory: 'DSH (superdesign-dsh)'
    });
    expect(skillManager.renderPromptIndex()).toContain('superdesign [DSH (superdesign-dsh) (dsh)]');
    expect(skillManager.read('superdesign')?.content).toContain('Use Superdesign for UI work.');
  });
});
