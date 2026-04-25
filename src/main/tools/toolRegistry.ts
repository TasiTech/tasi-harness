import type { RegisteredTool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../../shared/types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
    this.tools.set(name, tool);
  }

  definitions(enabledNames?: string[]): ToolDefinition[] {
    const enabled = enabledNames && enabledNames.length > 0 ? new Set(enabledNames) : null;
    return [...this.tools.values()]
      .filter((tool) => !enabled || enabled.has(tool.definition.function.name))
      .map((tool) => tool.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  async execute(name: string, args: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, content: `Unknown tool: ${name}` };
    try {
      return await tool.execute(args, context);
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

export function stringArg(args: Record<string, unknown>, name: string, fallback = ''): string {
  const value = args[name];
  return typeof value === 'string' ? value : fallback;
}

export function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}
