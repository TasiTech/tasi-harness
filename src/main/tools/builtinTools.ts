import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { AppConfig, MemoryMutationOptions, RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import type { MemoryStore } from '../storage/memoryStore.js';
import type { SessionStore } from '../storage/sessionStore.js';
import { safeJoin } from '../storage/pathUtils.js';
import type { SkillManager } from '../skills/skillManager.js';
import { BROWSER_REDACTION_MASK, redactSensitiveObject, redactSensitiveText } from '../privacy/sensitiveRedaction.js';
import type { BrowserAutomation, BrowserBinaryResult, BrowserClickResult, BrowserExtractResult, BrowserPageState, BrowserSnapshotResult } from './browserAutomation.js';
import { booleanArg, isPathInside, objectArgs, resolveToolPath, stringArg } from './toolRegistry.js';
import { runTerminalCommand } from './terminalRunner.js';

const BROWSER_DEFAULT_TIMEOUT_MS = 60000;
const BROWSER_MANUAL_LOGIN_TIMEOUT_MS = 300000;

export interface BuiltinToolDeps {
  getConfig: () => AppConfig;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  skillManager: SkillManager;
  browserAutomation?: BrowserAutomation;
  setBrowserClosePolicy?: (sessionId: string, policy: 'auto_close' | 'keep_open', reason?: string) => void;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const raw = args[name];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function normalizePathSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

function extractReferencedMarkdownPaths(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const normalized = candidate.trim().replace(/\\/g, '/');
    if (!normalized || !normalized.startsWith('.')) return;
    if (!/\.md$/i.test(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const match of markdown.matchAll(/\[[^\]]*\]\((\.\.?\/[^)\s]+\.md)\)/g)) {
    const ref = match[1];
    if (ref) push(ref);
  }
  for (const match of markdown.matchAll(/(?:^|\s|`)(\.\.?\/[^\s`"'()]+\.md)(?=$|\s|`)/gm)) {
    const ref = match[1];
    if (ref) push(ref);
  }
  return out.slice(0, 16);
}

function browserStateLine(state: BrowserPageState): string {
  return `browser_state: url=${state.url} title=${state.title || '(untitled)'}`;
}

function withBrowserPreview(content: string, state?: BrowserPageState): string {
  if (!state?.url) return content;
  const hasPreview = /browser_preview_url:\s*https?:\/\/\S+/i.test(content);
  if (hasPreview) return content;
  return [content, '', `browser_preview_url: ${state.url}`, browserStateLine(state)].filter(Boolean).join('\n');
}

function renderBrowserExtractResult(result: BrowserExtractResult): string {
  if (result.format === 'json') return result.content;
  const header = [
    `browser_extract format=${result.format}${result.selector ? ` selector=${result.selector}` : ''}`,
    `browser_preview_url: ${result.url}`,
    browserStateLine(result),
    ''
  ];
  return `${header.join('\n')}${result.content}`;
}

function renderBrowserJsonTool(tool: string, state: BrowserPageState, payload: unknown): string {
  return JSON.stringify(
    {
      tool,
      browser_preview_url: state.url,
      ...state,
      payload
    },
    null,
    2
  );
}

function filterTerms(input: string): string[] {
  return input
    .split(/[,，|]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
}

function textMatchesTerms(value: unknown, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const lowered = text.toLowerCase();
  return terms.some((term) => lowered.includes(term));
}

function filterTextByTerms(value: string, terms: string[]): string {
  if (terms.length === 0) return value;
  const parts = value.includes('\n')
    ? value.split(/\r?\n/)
    : value.split(/(?<=[。！？.!?])\s*/);
  const kept = parts.filter((part) => textMatchesTerms(part, terms));
  return kept.length > 0 ? kept.join('\n') : '';
}

function processBrowserExtractResult(
  result: BrowserExtractResult,
  options: { terms: string[]; redact: boolean; includeValues: boolean; maxChars: number }
): BrowserExtractResult {
  let content = result.content;
  if (result.format === 'json') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.text === 'string') parsed.text = filterTextByTerms(parsed.text, options.terms);
      if (Array.isArray(parsed.headings)) parsed.headings = parsed.headings.filter((item) => textMatchesTerms(item, options.terms));
      if (Array.isArray(parsed.links)) parsed.links = parsed.links.filter((item) => textMatchesTerms(item, options.terms));
      const processed = options.redact ? redactSensitiveObject(parsed, { includeValues: options.includeValues }) : parsed;
      content = JSON.stringify(processed, null, 2);
    } catch {
      content = filterTextByTerms(content, options.terms);
      if (options.redact) content = redactSensitiveText(content);
    }
  } else {
    content = filterTextByTerms(content, options.terms);
    if (options.redact) content = redactSensitiveText(content);
  }
  const next = { ...result, content: content.slice(0, options.maxChars) };
  return options.redact ? redactSensitiveObject(next, { includeValues: options.includeValues }) as BrowserExtractResult : next;
}

function processBrowserSnapshotResult(
  result: BrowserSnapshotResult,
  options: { terms: string[]; redact: boolean; includeValues: boolean; maxChars: number }
): BrowserSnapshotResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.content) as Record<string, unknown>;
  } catch {
    const content = options.redact ? redactSensitiveText(filterTextByTerms(result.content, options.terms)) : filterTextByTerms(result.content, options.terms);
    return { ...result, content: content.slice(0, options.maxChars), truncated: result.truncated || content.length > options.maxChars };
  }
  const keep = (item: unknown) => textMatchesTerms(item, options.terms);
  if (options.terms.length > 0) {
    if (typeof parsed.snapshot === 'string') parsed.snapshot = filterTextByTerms(parsed.snapshot, options.terms);
    for (const key of ['elements', 'headings', 'links', 'images', 'tree']) {
      if (Array.isArray(parsed[key])) parsed[key] = parsed[key].filter(keep);
    }
  }
  const processed = options.redact ? redactSensitiveObject(parsed, { includeValues: options.includeValues }) : parsed;
  const content = JSON.stringify(processed, null, 2);
  const next = {
    ...result,
    content: content.slice(0, options.maxChars),
    truncated: result.truncated || content.length > options.maxChars
  };
  return options.redact ? redactSensitiveObject(next, { includeValues: options.includeValues }) as BrowserSnapshotResult : next;
}

function renderBrowserClickResult(result: BrowserClickResult): string {
  const observation = result.observation;
  const recommendedNextTools = observation?.currentPageNavigationDetected
    ? ['browser_snapshot', 'browser_extract']
    : (observation?.newTargets?.length || observation?.windowOpenCalls?.length)
      ? ['browser_state', 'browser_snapshot', 'browser_console']
      : ['browser_snapshot', 'browser_extract', 'browser_console', 'browser_network'];
  return JSON.stringify(
    {
      tool: 'browser_click',
      browser_preview_url: result.url,
      url: result.url,
      title: result.title,
      action: result.action || 'dispatched_click_events',
      selector: result.selector,
      index: result.index,
      element: result.element,
      before: result.before,
      after: result.after ?? { url: result.url, title: result.title },
      observation,
      recommended_next_tools: recommendedNextTools
    },
    null,
    2
  );
}

function saveBrowserBinary(result: BrowserBinaryResult, context: ToolExecutionContext, requestedPath: string): string {
  const fallbackName = `${context.requestId || createId('browser')}.${result.extension}`;
  const relPath = requestedPath.trim() || join('browser-artifacts', fallbackName);
  const target = safeJoin(context.workspaceDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.data);
  return relative(context.workspaceDir, target);
}

function riskySkillOptimizationPatchReason(name: string, newString: string): string | null {
  const skill = name.toLowerCase();
  const text = newString.toLowerCase();
  const domainHints = [
    /browser|browser_screenshot|cdp|webdriver/,
    /draw\.?io|diagram|svg|png export|connector|cropped/,
    /docx|word|openability|office package|repair/,
    /pptx|powerpoint|slide/,
    /xlsx|excel|spreadsheet/,
    /chart|visualization|plot/,
    /travel|flight|hotel/,
    /skill-creator|skill authoring|skill optimization/
  ];
  const mentionedDomains = domainHints.filter((hint) => hint.test(text)).length;
  const broadLanguage = /all skills|every skill|every workflow|global|universal|generic|always|never|所有|全部|全局|通用|一律/.test(text);
  if (!/skill-creator|skill|router|orchestr/i.test(name) && broadLanguage && mentionedDomains >= 3) {
    return 'Rejected broad skill optimization patch. Patch the narrow owner skill for each failure instead of adding global cross-domain rules to one skill.';
  }

  const integritySignal = /image_or_diagram_integrity|validator|validation|openability|corrupt|repair|missing|cropped|connector|screenshot|failure|failed|error/.test(text);
  const downplaysFailure = /routine signal|not a failure|non-failure|safe to ignore|can be ignored|ignore (the )?(signal|failure|error)|whitelist|allowlist|白名单|不是失败|忽略/.test(text);
  if (integritySignal && downplaysFailure) {
    return 'Rejected failure-signal whitelist patch. Do not downgrade validation, screenshot, image, diagram, or openability failures as routine; route the issue to the responsible skill and add verification.';
  }

  const isBrowserSkill = /browser/.test(skill);
  const diagramOrOfficePolicy = /draw\.?io|diagram[- ]export|formal diagram|document figure|docx|pptx|xlsx|office package|word repair|powerpoint|excel/.test(text);
  if (isBrowserSkill && diagramOrOfficePolicy) {
    return 'Rejected skill responsibility pollution. Browser automation skills should not absorb diagram, Draw.io, Office, or document-export policy; patch the diagram or Office skill that owns the failure.';
  }

  return null;
}

export function createBuiltinTools(deps: BuiltinToolDeps): RegisteredTool[] {
  const requireBrowserAutomation = (): { ok: true; browser: BrowserAutomation } | { ok: false; result: ToolExecutionResult } => {
    if (!deps.browserAutomation) {
      return { ok: false, result: { ok: false, content: 'Browser automation is unavailable in this runtime.' } };
    }
    return { ok: true, browser: deps.browserAutomation };
  };

  const memory: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'memory',
        description: 'Add or remove compact persistent memory entries. Use for durable user preferences, project facts, and tool quirks.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove'], description: 'Memory operation.' },
            target: { type: 'string', enum: ['memory', 'user'], description: 'memory for environment/project facts; user for preferences/profile.' },
            scope: { type: 'string', enum: ['global', 'session'], description: 'session scope stores memory on a specific session id.' },
            session_id: { type: 'string', description: 'Optional session id for session-scoped memory.' },
            domain: {
              type: 'string',
              enum: ['finance', 'daily_life', 'work', 'reading', 'education', 'health', 'travel', 'other'],
              description: 'Knowledge domain for retrieval.'
            },
            content: { type: 'string', description: 'New content for add.' },
            old_text: { type: 'string', description: 'Unique substring identifying the entry to remove.' }
          },
          required: ['action', 'target']
        }
      }
    },
    async execute(args, context) {
      const obj = objectArgs(args);
      const action = stringArg(obj, 'action');
      const target = stringArg(obj, 'target') as 'memory' | 'user';
      if (target !== 'memory' && target !== 'user') return { ok: false, content: 'target must be memory or user.' };
      const scopeRaw = stringArg(obj, 'scope', '');
      const options: MemoryMutationOptions = {
        scope: scopeRaw === 'session' || scopeRaw === 'global' ? scopeRaw : undefined,
        domain: stringArg(obj, 'domain', ''),
        sessionId: stringArg(obj, 'session_id', '') || context.sessionId
      };
      if (action === 'add') deps.memoryStore.queueAdd(context.sessionId, target, stringArg(obj, 'content'), options);
      else if (action === 'remove') deps.memoryStore.queueRemove(context.sessionId, target, stringArg(obj, 'old_text'), options);
      else return { ok: false, content: 'action must be add or remove.' };
      return {
        ok: true,
        content: `Queued memory ${action}. Pending writes for this run: ${deps.memoryStore.pendingCount(context.sessionId)}. Changes are committed when the run completes.`
      };
    }
  };

  const sessionSearch: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'session_search',
        description: 'Search previous local conversation sessions for relevant context.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            limit: { type: 'number', description: 'Maximum results.' }
          },
          required: ['query']
        }
      }
    },
    async execute(args) {
      const obj = objectArgs(args);
      const results = deps.sessionStore.search(stringArg(obj, 'query'), Number(obj.limit) || 5);
      return { ok: true, content: JSON.stringify(results, null, 2), data: results };
    }
  };

  const skillView: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'skill_view',
        description: 'Read an installed skill by name. Skills are procedural workflow instructions: after reading one, follow it instead of skipping to a self-generated final answer.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name.' },
            ref_path: { type: 'string', description: 'Optional relative markdown path under references/, such as ./references/provider-ctrip-browser.md.' }
          },
          required: ['name']
        }
      }
    },
    async execute(args) {
      const obj = objectArgs(args);
      const skill = deps.skillManager.read(stringArg(obj, 'name'));
      if (!skill) return { ok: false, content: 'Skill not found.' };
      const skillDirFs = dirname(skill.path);
      const skillDir = normalizePathSlashes(skillDirFs);
      const skillsRootFs = dirname(dirname(dirname(skill.path)));
      const refPathRaw = stringArg(obj, 'ref_path', '').trim();
      const resolvedContent = skill.content
        .replace(/\{SKILL_DIR:-\.\}/g, skillDir)
        .replace(/\{SKILL_DIR\}/g, skillDir)
        .replace(/\$\{SKILL_DIR:-\.\}/g, skillDir)
        .replace(/\$\{SKILL_DIR\}/g, skillDir);

      const referencedPaths = extractReferencedMarkdownPaths(resolvedContent)
        .map((item) => item.replace(/\\/g, '/'))
        .filter((item) => item.replace(/^\.\//, '').startsWith('references/'));

      if (refPathRaw) {
        const refPath = refPathRaw.replace(/\\/g, '/');
        if (!/^\.\.?\/.*\.md$/i.test(refPath)) {
          return { ok: false, content: 'ref_path must be a relative .md path, for example ./references/provider-ctrip-browser.md' };
        }
        const normalizedRef = refPath.replace(/^\.\//, '');
        if (!normalizedRef.startsWith('references/')) {
          return { ok: false, content: 'ref_path must be under references/.' };
        }
        const refAbsPath = resolve(skillDirFs, refPath);
        if (!isPathInside(skillsRootFs, refAbsPath)) {
          return { ok: false, content: 'ref_path resolves outside skills roots.' };
        }
        if (!existsSync(refAbsPath)) {
          return { ok: false, content: `Reference file not found: ${refPath}` };
        }
        if (!statSync(refAbsPath).isFile()) {
          return { ok: false, content: `Reference path is not a file: ${refPath}` };
        }
        const content = readFileSync(refAbsPath, 'utf8');
        const bounded = content.length > 30000 ? `${content.slice(0, 30000)}\n\n...[truncated]` : content;
        const refGuide = [
          `# Skill reference for: ${skill.name}`,
          `# Reference path: ${refPath}`,
          `# Absolute reference path: ${refAbsPath}`,
          '# This reference is loaded on demand from the skill references folder.',
          ''
        ].join('\n');
        return { ok: true, content: `${refGuide}${bounded}`, data: skill };
      }

      const guide = [
        `# Skill: ${skill.name}`,
        `# Absolute skill directory: ${skillDir}`,
        `# Absolute SKILL.md path: ${skill.path}`,
        `# Resolved skill directory: ${skillDir}`,
        `# Skill file: ${skill.path}`,
        '# Skills are execution workflows, not optional reference text.',
        '# Reading this tool output does not count as completing the skill or gathering evidence.',
        '# After reading this skill, either perform its required tool steps, ask its required follow-up question, or explicitly report a blocked/degraded path.',
        '# If this skill routes the task to provider or browser tools, your next assistant turn should usually contain those tool calls instead of a polished narrative answer.',
        '# Do not stop at reading the skill and then answer from general knowledge if the skill requires evidence gathering or verification.',
        '# Replace any SKILL_DIR placeholders with the resolved directory before running commands.',
        '# If SKILL.md lists referenced markdown files that are relevant, you must call skill_view again with ref_path to read them before finalizing.',
        '# Do not assume provider-specific rules before loading the relevant references/*.md file.',
        ''
      ].join('\n');

      const referenceHints = referencedPaths.length === 0
        ? '\n## Referenced markdown files\n(none detected in SKILL.md)'
        : ['\n## Referenced markdown files', ...referencedPaths.map((item) => `- ${item}`)].join('\n');

      return { ok: true, content: `${guide}${resolvedContent}${referenceHints}`, data: skill };
    }
  };

  const skillManage: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'skill_manage',
        description: 'Create, patch, edit, delete, or list local skills. Use after solving non-trivial repeatable workflows.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'patch', 'edit', 'delete', 'write_file', 'remove_file'] },
            name: { type: 'string' },
            content: { type: 'string', description: 'Full SKILL.md content for create/edit.' },
            old_string: { type: 'string', description: 'Text to replace for patch.' },
            new_string: { type: 'string', description: 'Replacement text for patch.' },
            category: { type: 'string' },
            file_path: { type: 'string' },
            file_content: { type: 'string' }
          },
          required: ['action']
        }
      }
    },
    async execute(args) {
      const obj = objectArgs(args);
      const action = stringArg(obj, 'action');
      if (action === 'list') return { ok: true, content: JSON.stringify(deps.skillManager.list(), null, 2) };
      const name = stringArg(obj, 'name');
      if (!name) return { ok: false, content: 'name is required.' };
      if (action === 'create' || action === 'edit') {
        const doc = deps.skillManager.create({ name, content: stringArg(obj, 'content'), category: stringArg(obj, 'category', 'local') });
        return { ok: true, content: `Saved skill ${doc.name}.`, data: doc };
      }
      if (action === 'patch') {
        const before = deps.skillManager.read(name);
        const newString = stringArg(obj, 'new_string');
        const riskyPatchReason = riskySkillOptimizationPatchReason(name, newString);
        if (riskyPatchReason) return { ok: false, content: riskyPatchReason };
        const doc = deps.skillManager.patch({ name, oldString: stringArg(obj, 'old_string'), newString });
        if (before?.content === doc.content) return { ok: true, content: `Skipped patch for ${doc.name}; requested content is already present.`, data: doc };
        return { ok: true, content: `Patched skill ${doc.name}.`, data: doc };
      }
      if (action === 'delete') return { ok: deps.skillManager.delete(name), content: `Deleted local skill ${name}.` };
      if (action === 'write_file') {
        const rel = deps.skillManager.writeSupportingFile(name, stringArg(obj, 'file_path'), stringArg(obj, 'file_content'));
        return { ok: true, content: `Wrote ${rel}.` };
      }
      if (action === 'remove_file') {
        const ok = deps.skillManager.removeSupportingFile(name, stringArg(obj, 'file_path'));
        return { ok, content: ok ? 'Removed file.' : 'File not found.' };
      }
      return { ok: false, content: 'Unknown skill_manage action.' };
    }
  };

  const fileList: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'file_list',
        description: 'List files in a directory. Relative paths resolve inside the workspace; outside-workspace paths require approval.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative workspace path.' } }
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const target = resolveToolPath(cfg.workspaceDir, stringArg(objectArgs(args), 'path', '.'));
      if (!existsSync(target)) return { ok: false, content: 'Path not found.' };
      if (!statSync(target).isDirectory()) return { ok: false, content: 'Path is not a directory.' };
      const items = readdirSync(target).map((name) => {
        const file = join(target, name);
        const stat = statSync(file);
        return {
          name,
          path: isPathInside(cfg.workspaceDir, file) ? relative(cfg.workspaceDir, file) : file,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size
        };
      });
      return { ok: true, content: JSON.stringify(items, null, 2), data: items };
    }
  };

  const fileRead: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description: 'Read a UTF-8 text file. Relative paths resolve inside the workspace; outside-workspace paths require approval.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Workspace-relative or absolute file path.' } },
          required: ['path']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const target = resolveToolPath(cfg.workspaceDir, stringArg(objectArgs(args), 'path'));
      if (!existsSync(target)) return { ok: false, content: 'File not found.' };
      if (statSync(target).isDirectory()) return { ok: false, content: 'Path is a directory.' };
      return { ok: true, content: readFileSync(target, 'utf8') };
    }
  };

  const fileWrite: RegisteredTool = {
    safety: 'writes-workspace',
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description: 'Write a UTF-8 text file. Relative paths resolve inside the workspace; outside-workspace paths require approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
            content: { type: 'string', description: 'File content.' }
          },
          required: ['path', 'content']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const obj = objectArgs(args);
      const target = resolveToolPath(cfg.workspaceDir, stringArg(obj, 'path'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, stringArg(obj, 'content'), 'utf8');
      return { ok: true, content: `Wrote ${isPathInside(cfg.workspaceDir, target) ? relative(cfg.workspaceDir, target) : target}.` };
    }
  };

  const fileDelete: RegisteredTool = {
    safety: 'writes-workspace',
    definition: {
      type: 'function',
      function: {
        name: 'file_delete',
        description: 'Delete a file or directory. Workspace deletes and all outside-workspace deletes require approval. Directories require recursive=true.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute path to delete.' },
            recursive: { type: 'boolean', description: 'Required when deleting a directory.' },
            permanent: { type: 'boolean', description: 'Permanently remove instead of moving workspace files to .tasi-trash.' }
          },
          required: ['path']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const obj = objectArgs(args);
      const target = resolveToolPath(cfg.workspaceDir, stringArg(obj, 'path'));
      if (target === resolveToolPath(cfg.workspaceDir, '.')) return { ok: false, content: 'Refusing to delete the workspace root.' };
      if (!existsSync(target)) return { ok: false, content: 'Path not found.' };
      const stat = statSync(target);
      if (stat.isDirectory() && !booleanArg(obj, 'recursive', false)) {
        return { ok: false, content: 'Path is a directory. Set recursive=true to delete it.' };
      }
      const inside = isPathInside(cfg.workspaceDir, target);
      const label = inside ? relative(cfg.workspaceDir, target) : target;
      if (inside && !booleanArg(obj, 'permanent', false)) {
        const trashName = `${label.replace(/[\\/:"*?<>|]+/g, '__')}.${Date.now()}`;
        const trashPath = safeJoin(cfg.workspaceDir, join('.tasi-trash', trashName));
        mkdirSync(dirname(trashPath), { recursive: true });
        renameSync(target, trashPath);
        return { ok: true, content: `Moved ${label} to .tasi-trash/${trashName}.` };
      }
      rmSync(target, { recursive: stat.isDirectory(), force: false });
      return { ok: true, content: `Deleted ${label}.` };
    }
  };

  const browserOpen: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_open',
        description: 'Open a webpage in the browser automation session.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target URL. Accepts full URL or hostname.' },
            timeout_ms: { type: 'number', description: 'Optional load timeout in milliseconds. Use up to 300000 when the user may need to complete login, captcha, or MFA in the browser.' }
          },
          required: ['url']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const url = stringArg(obj, 'url').trim();
      if (!url) return { ok: false, content: 'url is required.' };
      const state = await access.browser.open(url, { timeoutMs: numberArg(obj, 'timeout_ms', BROWSER_DEFAULT_TIMEOUT_MS) });
      return { ok: true, content: withBrowserPreview(`Opened ${state.url}.`, state), data: state };
    }
  };

  const browserState: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_state',
        description: 'Get current URL and title from the browser automation session.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute() {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const state = await access.browser.state();
      return { ok: true, content: withBrowserPreview(browserStateLine(state), state), data: state };
    }
  };

  const browserClick: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an element in the browser automation session using a CSS selector.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the target element.' },
            index: { type: 'number', description: 'Zero-based index when selector matches multiple elements.' },
            wait_for_navigation: { type: 'boolean', description: 'Wait for page navigation after clicking.' },
            timeout_ms: { type: 'number', description: 'Navigation wait timeout in milliseconds. Use a longer timeout when a click leads to login, captcha, or MFA.' },
            observe_ms: { type: 'number', description: 'Short post-click observation window for DOM changes or new targets. Defaults to 500 ms.' }
          },
          required: ['selector']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector').trim();
      if (!selector) return { ok: false, content: 'selector is required.' };
      const state = await access.browser.click(selector, {
        index: numberArg(obj, 'index', 0),
        waitForNavigation: booleanArg(obj, 'wait_for_navigation', false),
        timeoutMs: numberArg(obj, 'timeout_ms', BROWSER_DEFAULT_TIMEOUT_MS),
        observeMs: numberArg(obj, 'observe_ms', 500)
      });
      return { ok: true, content: renderBrowserClickResult(state), data: state };
    }
  };

  const browserType: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_type',
        description: 'Type text into an input/textarea/contenteditable element in the browser automation session.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the target field.' },
            text: { type: 'string', description: 'Text to input.' },
            clear: { type: 'boolean', description: 'Clear existing value before typing. Defaults to true.' },
            submit: { type: 'boolean', description: 'Submit with Enter after typing.' }
          },
          required: ['selector', 'text']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector').trim();
      if (!selector) return { ok: false, content: 'selector is required.' };
      const state = await access.browser.type(selector, stringArg(obj, 'text'), {
        clear: booleanArg(obj, 'clear', true),
        submit: booleanArg(obj, 'submit', false)
      });
      return { ok: true, content: withBrowserPreview(`Typed into selector: ${selector}`, state), data: state };
    }
  };

  const browserScroll: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_scroll',
        description: 'Scroll the current page in the browser automation session.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
            amount: { type: 'number', description: 'Scroll amount in pixels for directional scrolling.' },
            selector: { type: 'string', description: 'Optional CSS selector or @e ref for a scrollable element.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const directionRaw = stringArg(obj, 'direction', 'down');
      const direction =
        directionRaw === 'up' || directionRaw === 'left' || directionRaw === 'right' || directionRaw === 'top' || directionRaw === 'bottom'
          ? directionRaw
          : 'down';
      const state = await access.browser.scroll({
        direction,
        amount: numberArg(obj, 'amount', 800),
        selector: stringArg(obj, 'selector', '').trim() || undefined
      });
      return { ok: true, content: withBrowserPreview(`Scrolled ${direction}.`, state), data: state };
    }
  };

  const browserWait: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_wait',
        description: 'Wait for a duration, selector, text, URL pattern, load state, or JavaScript condition in the browser automation session.',
        parameters: {
          type: 'object',
          properties: {
            ms: { type: 'number', description: 'Milliseconds to wait. Long waits without other conditions return early when the page changes.' },
            selector: { type: 'string', description: 'Wait until this selector condition is satisfied.' },
            text: { type: 'string', description: 'Wait until this text appears in the page body.' },
            url: { type: 'string', description: 'Wait until the current URL contains this text or matches a * glob.' },
            state: { type: 'string', enum: ['attached', 'visible', 'hidden', 'detached'], description: 'Selector state to wait for.' },
            load_state: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Wait for page load settling.' },
            function: { type: 'string', description: 'JavaScript boolean expression to poll, such as window.ready === true.' },
            until_changed: { type: 'boolean', description: 'Return as soon as URL, title, or visible page text changes. Useful after asking the user to complete login.' },
            until_logged_in: { type: 'boolean', description: 'Return as soon as the page appears past credential entry, such as an SSO confirmation/authorization page or non-login destination.' },
            wait_for_user: { type: 'boolean', description: 'Use when the browser is waiting for the user to type credentials, captcha, or MFA. Keeps the browser open and returns the current page instead of failing if the user has not finished before timeout.' },
            timeout_ms: { type: 'number', description: 'Timeout for selector/text/URL waiting. For manual login, captcha, or MFA, use up to 300000 ms.' }
          }
        }
      }
    },
    async execute(args, context) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector', '').trim() || undefined;
      const text = stringArg(obj, 'text', '').trim() || undefined;
      const url = stringArg(obj, 'url', '').trim() || undefined;
      const loadStateRaw = stringArg(obj, 'load_state', '').trim();
      const loadState = loadStateRaw === 'load' || loadStateRaw === 'domcontentloaded' || loadStateRaw === 'networkidle' ? loadStateRaw : undefined;
      const stateRaw = stringArg(obj, 'state', '').trim();
      const selectorState = stateRaw === 'visible' || stateRaw === 'hidden' || stateRaw === 'detached' ? stateRaw : 'attached';
      const fn = stringArg(obj, 'function', '').trim() || undefined;
      const hasCondition = Boolean(selector || text || url || loadState || fn);
      const ms = numberArg(obj, 'ms', selector || text || url || loadState || fn ? 0 : 250);
      const timeoutMs = numberArg(obj, 'timeout_ms', BROWSER_MANUAL_LOGIN_TIMEOUT_MS);
      const untilChanged = booleanArg(obj, 'until_changed', (!hasCondition && ms >= 5000) || timeoutMs > BROWSER_DEFAULT_TIMEOUT_MS);
      const untilLoggedIn = booleanArg(obj, 'until_logged_in', timeoutMs > BROWSER_DEFAULT_TIMEOUT_MS);
      const explicitUntilLoggedIn = Object.prototype.hasOwnProperty.call(obj, 'until_logged_in') && untilLoggedIn;
      const waitForUser = booleanArg(obj, 'wait_for_user', false);
      const manualUserWait = waitForUser || explicitUntilLoggedIn || (!hasCondition && ms >= 5000);
      if (manualUserWait) {
        deps.setBrowserClosePolicy?.(context.sessionId, 'keep_open', 'waiting for user login, captcha, or MFA in browser');
      }
      const waitOptions: Parameters<BrowserAutomation['wait']>[0] = {
        ms: untilChanged ? 0 : ms,
        selector,
        text,
        url,
        state: selectorState,
        loadState,
        function: fn,
        untilChanged,
        untilLoggedIn,
        timeoutMs: untilChanged && ms > 0 ? ms : timeoutMs
      };
      let pageState: BrowserPageState;
      let stillWaitingForUser = false;
      try {
        pageState = await access.browser.wait(waitOptions);
      } catch (error) {
        if (!manualUserWait || !/timed out waiting/i.test(error instanceof Error ? error.message : String(error))) throw error;
        stillWaitingForUser = true;
        pageState = await access.browser.state();
      }
      const message = stillWaitingForUser
        ? 'Waiting for user input in the browser. The browser is kept open; ask the user to enter credentials/captcha/MFA and continue in this same session.'
        : `Wait completed.${selector ? ` selector=${selector}` : ''}`;
      return { ok: true, content: withBrowserPreview(message, pageState), data: pageState };
    }
  };

  const browserExtract: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_extract',
        description: 'Extract structured JSON from the current page in the browser automation session. Falls back to HTML when JSON is invalid.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Optional CSS selector to scope extraction.' },
            format: { type: 'string', enum: ['html', 'json'] },
            max_chars: { type: 'number', description: 'Maximum characters to return.' },
            filter_text: { type: 'string', description: 'Optional comma-separated keywords. When set, return only matching page text/headings/links to reduce token use.' },
            redact_sensitive: { type: 'boolean', description: 'Redact common sensitive data such as emails, phone numbers, ID numbers, auth tokens, cookies, and secrets. Defaults to true.' },
            include_values: { type: 'boolean', description: 'Include non-sensitive non-form value fields in output. Defaults to false; form/control values and sensitive fields are always masked as xxxx.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector', '').trim() || undefined;
      const maxChars = numberArg(obj, 'max_chars', 8000);
      const terms = filterTerms(stringArg(obj, 'filter_text', ''));
      const redact = booleanArg(obj, 'redact_sensitive', true);
      const includeValues = booleanArg(obj, 'include_values', false);
      const formatRaw = stringArg(obj, 'format', 'json').toLowerCase();
      const format = formatRaw === 'html' ? 'html' : 'json';
      let extracted = await access.browser.extract({
        selector,
        format,
        maxChars
      });
      if (format === 'json') {
        try {
          JSON.parse(extracted.content);
        } catch {
          extracted = await access.browser.extract({
            selector,
            format: 'html',
            maxChars
          });
        }
      }
      extracted = processBrowserExtractResult(extracted, { terms, redact, includeValues, maxChars });
      return { ok: true, content: renderBrowserExtractResult(extracted), data: extracted };
    }
  };

  const browserSnapshot: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_snapshot',
        description: 'Capture an agent-friendly page snapshot with stable @e element refs, roles, names, links, images, headings, and viewport data.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Optional CSS selector or @e ref to scope the snapshot.' },
            max_elements: { type: 'number', description: 'Maximum elements to include. Omit to include all discovered elements.' },
            max_chars: { type: 'number', description: 'Maximum characters to return. Defaults to a large snapshot budget.' },
            filter_text: { type: 'string', description: 'Optional comma-separated keywords. When set, keep only matching elements/headings/links/images/tree lines to reduce token use.' },
            redact_sensitive: { type: 'boolean', description: 'Redact common sensitive data such as emails, phone numbers, ID numbers, auth tokens, cookies, and secrets. Defaults to true.' },
            include_values: { type: 'boolean', description: 'Include non-sensitive non-form value fields in output. Defaults to false; form/control values and sensitive fields are always masked as xxxx.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const hasMaxElements = Object.prototype.hasOwnProperty.call(obj, 'max_elements');
      const maxChars = numberArg(obj, 'max_chars', 100000);
      const result = await access.browser.snapshot({
        selector: stringArg(obj, 'selector', '').trim() || undefined,
        maxElements: hasMaxElements ? numberArg(obj, 'max_elements', 0) : undefined,
        maxChars
      });
      const processed = processBrowserSnapshotResult(result, {
        terms: filterTerms(stringArg(obj, 'filter_text', '')),
        redact: booleanArg(obj, 'redact_sensitive', true),
        includeValues: booleanArg(obj, 'include_values', false),
        maxChars
      });
      return { ok: true, content: processed.content, data: processed };
    }
  };

  const browserFind: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_find',
        description: 'Find an element semantically by role, text, label, placeholder, alt text, title, test id, or CSS, then optionally act on it.',
        parameters: {
          type: 'object',
          properties: {
            by: { type: 'string', enum: ['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'css'] },
            value: { type: 'string', description: 'Semantic query value, role name, or CSS selector.' },
            action: { type: 'string', enum: ['snapshot', 'text', 'click', 'type', 'fill', 'focus', 'hover', 'check', 'uncheck', 'select'] },
            text: { type: 'string', description: 'Text/value for type, fill, or select.' },
            name: { type: 'string', description: 'Accessible name filter for role lookup.' },
            exact: { type: 'boolean', description: 'Use exact text matching.' },
            index: { type: 'number', description: 'Zero-based match index.' },
            wait_for_navigation: { type: 'boolean', description: 'Wait after click-like actions.' },
            timeout_ms: { type: 'number', description: 'Navigation wait timeout. Use a longer timeout when the action leads to login, captcha, or MFA.' }
          },
          required: ['by', 'value']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const byRaw = stringArg(obj, 'by', 'css');
      const by =
        byRaw === 'role' ||
        byRaw === 'text' ||
        byRaw === 'label' ||
        byRaw === 'placeholder' ||
        byRaw === 'alt' ||
        byRaw === 'title' ||
        byRaw === 'testid'
          ? byRaw
          : 'css';
      const actionRaw = stringArg(obj, 'action', 'snapshot');
      const action =
        actionRaw === 'text' ||
        actionRaw === 'click' ||
        actionRaw === 'type' ||
        actionRaw === 'fill' ||
        actionRaw === 'focus' ||
        actionRaw === 'hover' ||
        actionRaw === 'check' ||
        actionRaw === 'uncheck' ||
        actionRaw === 'select'
          ? actionRaw
          : 'snapshot';
      const result = await access.browser.find({
        by,
        value: stringArg(obj, 'value'),
        action,
        text: stringArg(obj, 'text', ''),
        name: stringArg(obj, 'name', '').trim() || undefined,
        exact: booleanArg(obj, 'exact', false),
        index: numberArg(obj, 'index', 0),
        waitForNavigation: booleanArg(obj, 'wait_for_navigation', false),
        timeoutMs: numberArg(obj, 'timeout_ms', BROWSER_DEFAULT_TIMEOUT_MS)
      });
      return {
        ok: true,
        content: withBrowserPreview(renderBrowserJsonTool('browser_find', result, { ref: result.ref, selector: result.selector, text: result.text, element: result.element }), result),
        data: result
      };
    }
  };

  const browserHover: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_hover',
        description: 'Hover an element using a CSS selector or @e ref.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            index: { type: 'number' }
          },
          required: ['selector']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector').trim();
      if (!selector) return { ok: false, content: 'selector is required.' };
      const state = await access.browser.hover(selector, { index: numberArg(obj, 'index', 0) });
      return { ok: true, content: withBrowserPreview(`Hovered selector: ${selector}`, state), data: state };
    }
  };

  const browserSelect: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_select',
        description: 'Select an option value in a select element using a CSS selector or @e ref.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            value: { type: 'string' },
            index: { type: 'number' }
          },
          required: ['selector', 'value']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector').trim();
      if (!selector) return { ok: false, content: 'selector is required.' };
      const state = await access.browser.select(selector, stringArg(obj, 'value'), { index: numberArg(obj, 'index', 0) });
      return { ok: true, content: withBrowserPreview(`Selected value for selector: ${selector}`, state), data: state };
    }
  };

  const browserCheck: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_check',
        description: 'Check or uncheck a checkbox/radio using a CSS selector or @e ref.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            checked: { type: 'boolean', description: 'Defaults to true.' },
            index: { type: 'number' }
          },
          required: ['selector']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector').trim();
      if (!selector) return { ok: false, content: 'selector is required.' };
      const checked = booleanArg(obj, 'checked', true);
      const state = await access.browser.check(selector, checked, { index: numberArg(obj, 'index', 0) });
      return { ok: true, content: withBrowserPreview(`${checked ? 'Checked' : 'Unchecked'} selector: ${selector}`, state), data: state };
    }
  };

  const browserPress: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_press',
        description: 'Press a key or keyboard shortcut, or insert text into the focused/selected element.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key or shortcut, such as Enter, Tab, Control+a.' },
            selector: { type: 'string', description: 'Optional selector or @e ref to focus before pressing.' },
            text: { type: 'string', description: 'Optional text to insert instead of a key press.' }
          },
          required: ['key']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const key = stringArg(obj, 'key').trim();
      if (!key) return { ok: false, content: 'key is required.' };
      const state = await access.browser.press(key, {
        selector: stringArg(obj, 'selector', '').trim() || undefined,
        text: typeof obj.text === 'string' ? obj.text : undefined
      });
      return { ok: true, content: withBrowserPreview(`Pressed key: ${key}`, state), data: state };
    }
  };

  const browserUploadFile: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_upload_file',
        description: 'Set one or more local files on an input[type=file] element in the browser automation session, including hidden file inputs. Use this for webpage uploads such as invoices or reimbursement attachments. Do not use browser_eval/JavaScript to simulate local file selection.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector or @e ref for the target input[type=file]. Defaults to input[type=file]. Use browser_snapshot or browser_find first when multiple inputs exist.' },
            path: { type: 'string', description: 'Workspace-relative or absolute local file path to upload.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Optional multiple file paths. Use only when the file input supports multiple files.' },
            index: { type: 'number', description: 'Zero-based index when selector matches multiple file inputs.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const cfg = deps.getConfig();
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector', 'input[type=file]').trim() || 'input[type=file]';
      const rawPaths = Array.isArray(obj.paths)
        ? obj.paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [stringArg(obj, 'path')].filter(Boolean);
      if (rawPaths.length === 0) return { ok: false, content: 'path or paths is required.' };
      const files = rawPaths.map((item) => resolveToolPath(cfg.workspaceDir, item));
      for (const file of files) {
        if (!existsSync(file)) return { ok: false, content: `Upload file not found: ${file}` };
        if (!statSync(file).isFile()) return { ok: false, content: `Upload path is not a file: ${file}` };
      }
      const state = await access.browser.uploadFile(selector, files, { index: numberArg(obj, 'index', 0) });
      const labels = files.map((file) => isPathInside(cfg.workspaceDir, file) ? relative(cfg.workspaceDir, file) : file);
      return {
        ok: true,
        content: withBrowserPreview(`Uploaded ${labels.length} file(s) to ${selector}: ${labels.join(', ')}`, state),
        data: state
      };
    }
  };

  const browserScreenshot: RegisteredTool = {
    safety: 'writes-workspace',
    definition: {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: 'Capture a PNG screenshot of the current browser page and save it inside the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional workspace-relative output path.' },
            full_page: { type: 'boolean', description: 'Reserved for compatibility; captures the visible page in this runtime.' }
          }
        }
      }
    },
    async execute(args, context) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const result = await access.browser.screenshot({ fullPage: booleanArg(obj, 'full_page', false) });
      const relPath = saveBrowserBinary(result, context, stringArg(obj, 'path', ''));
      return { ok: true, content: withBrowserPreview(`Saved browser screenshot to ${relPath}.`, result), data: { path: relPath, url: result.url, title: result.title } };
    }
  };

  const browserPdf: RegisteredTool = {
    safety: 'writes-workspace',
    definition: {
      type: 'function',
      function: {
        name: 'browser_pdf',
        description: 'Print the current browser page to a PDF file inside the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional workspace-relative output path.' }
          }
        }
      }
    },
    async execute(args, context) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const result = await access.browser.pdf();
      const relPath = saveBrowserBinary(result, context, stringArg(objectArgs(args), 'path', ''));
      return { ok: true, content: withBrowserPreview(`Saved browser PDF to ${relPath}.`, result), data: { path: relPath, url: result.url, title: result.title } };
    }
  };

  const browserStorage: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_storage',
        description: 'Read, set, or clear localStorage/sessionStorage for the current page.',
        parameters: {
          type: 'object',
          properties: {
            area: { type: 'string', enum: ['local', 'session'] },
            action: { type: 'string', enum: ['get', 'set', 'clear'] },
            key: { type: 'string' },
            value: { type: 'string' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const areaRaw = stringArg(obj, 'area', 'local');
      const actionRaw = stringArg(obj, 'action', 'get');
      const result = await access.browser.storage({
        area: areaRaw === 'session' ? 'session' : 'local',
        action: actionRaw === 'set' || actionRaw === 'clear' ? actionRaw : 'get',
        key: stringArg(obj, 'key', '').trim() || undefined,
        value: stringArg(obj, 'value', '')
      });
      return { ok: true, content: withBrowserPreview(result.content, result), data: result };
    }
  };

  const browserCookies: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_cookies',
        description: 'Read, set, or clear cookies for the current page URL.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'set', 'clear'] },
            name: { type: 'string' },
            value: { type: 'string' },
            url: { type: 'string' },
            domain: { type: 'string' },
            path: { type: 'string' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const actionRaw = stringArg(obj, 'action', 'get');
      const result = await access.browser.cookies({
        action: actionRaw === 'set' || actionRaw === 'clear' ? actionRaw : 'get',
        name: stringArg(obj, 'name', '').trim() || undefined,
        value: stringArg(obj, 'value', ''),
        url: stringArg(obj, 'url', '').trim() || undefined,
        domain: stringArg(obj, 'domain', '').trim() || undefined,
        path: stringArg(obj, 'path', '').trim() || undefined
      });
      return { ok: true, content: withBrowserPreview(result.content, result), data: result };
    }
  };

  const browserConsole: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_console',
        description: 'Read or clear captured browser console messages and page errors.',
        parameters: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['all', 'log', 'info', 'warning', 'error'] },
            clear: { type: 'boolean' },
            max_items: { type: 'number' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const levelRaw = stringArg(obj, 'level', 'all');
      const result = await access.browser.console({
        level: levelRaw === 'log' || levelRaw === 'info' || levelRaw === 'warning' || levelRaw === 'error' ? levelRaw : 'all',
        clear: booleanArg(obj, 'clear', false),
        maxItems: numberArg(obj, 'max_items', 100)
      });
      return { ok: true, content: withBrowserPreview(result.content, result), data: result };
    }
  };

  const browserNetwork: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'browser_network',
        description: 'Inspect performance/network resource entries for the current page.',
        parameters: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Filter by URL substring.' },
            type: { type: 'string', description: 'Comma-separated initiator types such as fetch,xhr,script,img.' },
            max_items: { type: 'number' },
            clear: { type: 'boolean' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const result = await access.browser.network({
        filter: stringArg(obj, 'filter', '').trim() || undefined,
        type: stringArg(obj, 'type', '').trim() || undefined,
        maxItems: numberArg(obj, 'max_items', 100),
        clear: booleanArg(obj, 'clear', false)
      });
      return { ok: true, content: withBrowserPreview(result.content, result), data: result };
    }
  };

  const browserEval: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_eval',
        description: 'Evaluate a JavaScript expression in the current page and return a bounded result.',
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'JavaScript expression. Example: document.title' },
            max_chars: { type: 'number' }
          },
          required: ['script']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const script = stringArg(obj, 'script').trim();
      if (!script) return { ok: false, content: 'script is required.' };
      const result = await access.browser.evaluate(script, { maxChars: numberArg(obj, 'max_chars', 8000) });
      return { ok: true, content: withBrowserPreview(result.content, result), data: result };
    }
  };

  const browserViewport: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_viewport',
        description: 'Set the browser viewport size and optional zoom scale.',
        parameters: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            scale: { type: 'number' }
          },
          required: ['width', 'height']
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const state = await access.browser.setViewport({
        width: numberArg(obj, 'width', 1280),
        height: numberArg(obj, 'height', 900),
        scale: numberArg(obj, 'scale', 1)
      });
      return { ok: true, content: withBrowserPreview(`Set browser viewport to ${numberArg(obj, 'width', 1280)}x${numberArg(obj, 'height', 900)}.`, state), data: state };
    }
  };

  const browserClose: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_close',
        description: 'Close the browser automation session and reset state.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute() {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      await access.browser.close();
      return { ok: true, content: 'Browser automation session closed.' };
    }
  };

  const browserClosePolicy: RegisteredTool = {
    safety: 'stateful',
    definition: {
      type: 'function',
      function: {
        name: 'browser_close_policy',
        description: 'Set whether the current browser should auto-close when this run finishes. Use keep_open for form filling, submissions, approvals, account changes, or any workflow where the user may need to review the final browser state. Use auto_close for read-only data lookup/extraction tasks.',
        parameters: {
          type: 'object',
          properties: {
            policy: { type: 'string', enum: ['auto_close', 'keep_open'], description: 'Browser close behavior for the current run.' },
            reason: { type: 'string', description: 'Short reason for the policy.' }
          },
          required: ['policy']
        }
      }
    },
    async execute(args, context) {
      const obj = objectArgs(args);
      const rawPolicy = stringArg(obj, 'policy', 'auto_close');
      const policy = rawPolicy === 'keep_open' ? 'keep_open' : 'auto_close';
      const reason = stringArg(obj, 'reason', '').trim() || undefined;
      deps.setBrowserClosePolicy?.(context.sessionId, policy, reason);
      return {
        ok: true,
        content: `Browser close policy set to ${policy}${reason ? `: ${reason}` : '.'}`
      };
    }
  };

  const terminal: RegisteredTool = {
    safety: 'executes-command',
    definition: {
      type: 'function',
      function: {
        name: 'terminal',
        description: 'Run a shell command in the workspace. Disabled by default for safety and blocked for dangerous patterns.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command.' },
            cwd: { type: 'string', description: 'Optional relative workspace cwd.' },
            timeout_ms: { type: 'number' }
          },
          required: ['command']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const obj = objectArgs(args);
      const cwd = safeJoin(cfg.workspaceDir, stringArg(obj, 'cwd', '.'));
      const result = await runTerminalCommand({
        command: stringArg(obj, 'command'),
        cwd,
        timeoutMs: Number(obj.timeout_ms) || 120000,
        allowShellTools: cfg.allowShellTools
      });
      return result;
    }
  };

  const diagnostics: RegisteredTool = {
    safety: 'read-only',
    definition: {
      type: 'function',
      function: {
        name: 'harness_diagnostics',
        description: 'Return current Tasi Harness runtime diagnostics: workspace, enabled tools, memory usage, and installed skill count.',
        parameters: { type: 'object', properties: {} }
      }
    },
    async execute(_args, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const cfg = deps.getConfig();
      return {
        ok: true,
        content: JSON.stringify(
          {
            requestId: context.requestId || createId('request'),
            sessionId: context.sessionId,
            workspaceDir: cfg.workspaceDir,
            allowShellTools: cfg.allowShellTools,
            enabledTools: cfg.enabledToolNames,
            memory: deps.memoryStore.getState().usage,
            skills: deps.skillManager.list().length
          },
          null,
          2
        )
      };
    }
  };

  return [
    memory,
    sessionSearch,
    skillView,
    skillManage,
    fileList,
    fileRead,
    fileWrite,
    fileDelete,
    browserOpen,
    browserState,
    browserClick,
    browserType,
    browserScroll,
    browserWait,
    browserExtract,
    browserSnapshot,
    browserFind,
    browserHover,
    browserSelect,
    browserCheck,
    browserPress,
    browserUploadFile,
    browserScreenshot,
    browserPdf,
    browserStorage,
    browserCookies,
    browserConsole,
    browserNetwork,
    browserEval,
    browserViewport,
    browserClosePolicy,
    browserClose,
    terminal,
    diagnostics
  ];
}
