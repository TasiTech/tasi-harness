import { isAbsolute, relative, resolve } from 'node:path';
import type {
  RegisteredTool,
  SafetyApprovalSettings,
  ToolApprovalRecord,
  ToolApprovalRequest,
  ToolApprovalRisk,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult
} from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { classifyTerminalCommandSafety } from './terminalRunner.js';

const DEFAULT_APPROVAL_SETTINGS: SafetyApprovalSettings = {
  enabled: true,
  approveRiskyTerminalCommands: true,
  timeoutMs: 60000,
  neverAskAgainKeys: []
};

type ApprovalCandidate = { key: string; risk: ToolApprovalRisk; summary: string; blocked?: boolean };
const APPROVAL_FREE_TASI_DIRS = new Set(['memories', 'personal-knowledge', 'session-documents', 'sessions', 'skills', 'workspace']);

function normalizePathSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

export function resolveToolPath(workspaceDir: string, input = '.'): string {
  const cleanInput = input.trim() || '.';
  const rootResolved = resolve(workspaceDir);
  return isAbsolute(cleanInput) ? resolve(cleanInput) : resolve(rootResolved, cleanInput);
}

export function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = normalizePathSlashes(resolve(root)).replace(/\/+$/, '');
  const normalizedTarget = normalizePathSlashes(resolve(target));
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function isPathInsideApprovalFreeTasiDir(target: string): boolean {
  const segments = normalizePathSlashes(resolve(target)).split('/').map((segment) => segment.toLowerCase());
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === '.tasi-harness' && APPROVAL_FREE_TASI_DIRS.has(segments[index + 1])) return true;
  }
  return false;
}

function shortPath(workspaceDir: string, target: string): string {
  return isPathInside(workspaceDir, target) ? relative(workspaceDir, target) || '.' : target;
}

function approvalFromFileTool(toolName: string, args: unknown, context: ToolExecutionContext): ApprovalCandidate | null {
  const obj = objectArgs(args);
  if (toolName === 'browser_upload_file') {
    const rawPaths = Array.isArray(obj.paths) ? obj.paths : [obj.path];
    const targets = rawPaths
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => resolveToolPath(context.workspaceDir, item));
    const outside = targets.filter((target) => !isPathInside(context.workspaceDir, target) && !isPathInsideApprovalFreeTasiDir(target));
    if (outside.length === 0) return null;
    const labels = outside.map((target) => shortPath(context.workspaceDir, target)).join(', ');
    return {
      key: `outside:read:${outside.join('|')}`,
      risk: 'outside-read',
      summary: `Upload outside-workspace file(s) through browser: ${labels}`
    };
  }
  const pathArg = stringArg(obj, 'path');
  if (!pathArg && toolName !== 'file_list') return null;
  const target = resolveToolPath(context.workspaceDir, pathArg || '.');
  const inside = isPathInside(context.workspaceDir, target);
  const label = shortPath(context.workspaceDir, target);
  if (toolName !== 'file_delete' && isPathInsideApprovalFreeTasiDir(target)) return null;
  if (toolName === 'file_delete') {
    return {
      key: `${inside ? 'workspace' : 'outside'}:delete:${target}`,
      risk: inside ? 'workspace-delete' : 'outside-delete',
      summary: `${inside ? 'Delete workspace path' : 'Delete outside-workspace path'}: ${label}`
    };
  }
  if (!inside && (toolName === 'file_read' || toolName === 'file_list')) {
    return {
      key: `outside:read:${target}`,
      risk: 'outside-read',
      summary: `Read outside-workspace path: ${label}`
    };
  }
  if (!inside && toolName === 'file_write') {
    return {
      key: `outside:write:${target}`,
      risk: 'outside-write',
      summary: `Write outside-workspace path: ${label}`
    };
  }
  return null;
}

function approvalFromTerminal(args: unknown): ApprovalCandidate | null {
  const command = stringArg(objectArgs(args), 'command').trim();
  const safety = classifyTerminalCommandSafety(command);
  if (safety.blocked) {
    return { key: `terminal:blocked:${command}`, risk: 'terminal-risk', summary: safety.reason, blocked: true };
  }
  if (!safety.requiresApproval) return null;
  return {
    key: `terminal:risk:${command}`,
    risk: 'terminal-risk',
    summary: `${safety.reason}\n${command}`
  };
}

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
      const approval = await this.requestApprovalIfNeeded(tool, args, context);
      if (approval.status === 'blocked') return { ok: false, content: approval.summary || 'Blocked dangerous operation.', approval };
      if (approval.status === 'denied') return { ok: false, content: `User denied ${name}.`, approval };
      if (approval.status === 'unavailable') {
        return { ok: false, content: `${name} requires interactive approval, but no approval UI is available for this run.`, approval };
      }
      const result = await tool.execute(args, context);
      return approval.status === 'not_required' ? result : { ...result, approval };
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  }

  private async requestApprovalIfNeeded(tool: RegisteredTool, args: unknown, context: ToolExecutionContext): Promise<ToolApprovalRecord> {
    const settings = context.safetyApproval ?? DEFAULT_APPROVAL_SETTINGS;
    if (!settings.enabled) return { status: 'not_required' };
    const name = tool.definition.function.name;
    const candidate: ApprovalCandidate | null = name === 'terminal'
      ? (settings.approveRiskyTerminalCommands ? approvalFromTerminal(args) : null)
      : approvalFromFileTool(name, args, context);
    if (!candidate) return { status: 'not_required' };
    if (candidate.blocked) return { status: 'blocked', key: candidate.key, risk: candidate.risk, summary: candidate.summary };
    if (settings.neverAskAgainKeys.includes(candidate.key)) {
      return { status: 'remembered', key: candidate.key, risk: candidate.risk, summary: candidate.summary };
    }
    if (!context.requestToolApproval) {
      return { status: 'unavailable', key: candidate.key, risk: candidate.risk, summary: candidate.summary };
    }
    const request: ToolApprovalRequest = {
      id: createId('approval'),
      key: candidate.key,
      toolName: name,
      safety: tool.safety,
      risk: candidate.risk,
      summary: candidate.summary,
      args,
      workspaceDir: context.workspaceDir,
      sessionId: context.sessionId,
      requestId: context.requestId,
      createdAt: nowIso(),
      timeoutMs: settings.timeoutMs,
      allowNeverAskAgain: true
    };
    const decision = await context.requestToolApproval(request);
    return {
      status: decision.approved ? 'approved' : 'denied',
      key: candidate.key,
      risk: candidate.risk,
      summary: candidate.summary,
      requestId: request.id
    };
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
