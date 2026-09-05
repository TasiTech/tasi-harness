import type { ConfigStore } from '../storage/configStore.js';
import type { ToolRegistry } from '../tools/toolRegistry.js';
import { resolveToolPath } from '../tools/toolRegistry.js';
import type { RegisteredTool, ToolDefinition } from '../../shared/types.js';
import type { DshSidecarManager } from './dshSidecarManager.js';
import type { SkillManager } from '../skills/skillManager.js';

function isPathLikeKey(key: string): boolean {
  const clean = key.trim();
  const lower = clean.toLowerCase();
  return lower === 'path'
    || lower === 'file'
    || lower === 'filename'
    || lower === 'filepath'
    || lower === 'file_path'
    || lower === 'imagepath'
    || lower === 'image_path'
    || lower === 'inputpath'
    || lower === 'input_path'
    || clean.endsWith('Path');
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
}

function resolveRuntimeToolArgs(value: unknown, workspaceDir: string, key = ''): unknown {
  if (typeof value === 'string') {
    const clean = value.trim();
    return clean && isPathLikeKey(key) && !isUrlLike(clean) ? resolveToolPath(workspaceDir, clean) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRuntimeToolArgs(item, workspaceDir, key));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    out[entryKey] = resolveRuntimeToolArgs(entryValue, workspaceDir, entryKey);
  }
  return out;
}

export class DshSidecarRuntimeBridge {
  private readonly disposers = new Map<string, () => void>();
  private lastError = '';

  constructor(
    private readonly sidecar: DshSidecarManager,
    private readonly toolRegistry: ToolRegistry,
    private readonly configStore: ConfigStore,
    private readonly skillManager?: SkillManager
  ) {}

  get error(): string | undefined {
    return this.lastError || undefined;
  }

  async sync(): Promise<{ toolNames: string[]; error?: string }> {
    const previousNames = new Set(this.disposers.keys());
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
    try {
      const tools = await this.sidecar.runtimeTools();
      const skills = typeof this.sidecar.runtimeSkills === 'function'
        ? await this.sidecar.runtimeSkills().catch(() => [])
        : [];
      this.skillManager?.setRuntimeSkills(skills);
      for (const definition of tools) {
        const tool = this.createProxyTool(definition);
        this.disposers.set(definition.function.name, this.toolRegistry.register(tool));
      }
      this.syncEnabledToolNames(previousNames, tools.map((tool) => tool.function.name));
      this.lastError = '';
      return { toolNames: tools.map((tool) => tool.function.name) };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.syncEnabledToolNames(previousNames, []);
      this.skillManager?.setRuntimeSkills([]);
      return { toolNames: [], error: this.lastError };
    }
  }

  private createProxyTool(definition: ToolDefinition): RegisteredTool {
    const name = definition.function.name;
    return {
      definition,
      safety: 'stateful',
      execute: async (args, context) => {
        const cfg = this.configStore.get();
        return await this.sidecar.callRuntimeTool({
          name,
          args: resolveRuntimeToolArgs(args, context.workspaceDir),
          context: {
            sessionId: context.sessionId,
            workspaceDir: context.workspaceDir,
            requestId: context.requestId,
            llm: {
              provider: cfg.provider,
              model: cfg.model,
              reasoningEffort: cfg.reasoningEffort
            }
          }
        });
      }
    };
  }

  private syncEnabledToolNames(previousNames: Set<string>, nextNames: string[]): void {
    const nextNameSet = new Set(nextNames);
    const current = this.configStore.get().enabledToolNames;
    const retained = current.filter((name) => !previousNames.has(name) || nextNameSet.has(name));
    const merged = [...retained];
    for (const name of nextNames) {
      if (!merged.includes(name)) merged.push(name);
    }
    if (merged.length !== current.length || merged.some((name, index) => current[index] !== name)) {
      this.configStore.update({ enabledToolNames: merged });
    }
  }
}
