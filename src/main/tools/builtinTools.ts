import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AppConfig, MemoryMutationOptions, RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import type { MemoryStore } from '../storage/memoryStore.js';
import type { SessionStore } from '../storage/sessionStore.js';
import { safeJoin } from '../storage/pathUtils.js';
import type { SkillManager } from '../skills/skillManager.js';
import type { BrowserAutomation, BrowserExtractResult, BrowserPageState } from './browserAutomation.js';
import { booleanArg, objectArgs, stringArg } from './toolRegistry.js';
import { runTerminalCommand } from './terminalRunner.js';

export interface BuiltinToolDeps {
  getConfig: () => AppConfig;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  skillManager: SkillManager;
  browserAutomation?: BrowserAutomation;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const raw = args[name];
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
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
              enum: ['finance', 'daily_life', 'work', 'reading', 'education', 'health', 'other'],
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
          properties: { name: { type: 'string', description: 'Skill name.' } },
          required: ['name']
        }
      }
    },
    async execute(args) {
      const skill = deps.skillManager.read(stringArg(objectArgs(args), 'name'));
      if (!skill) return { ok: false, content: 'Skill not found.' };
      const skillDir = dirname(skill.path).replace(/\\/g, '/');
      const resolvedContent = skill.content
        .replace(/\{SKILL_DIR:-\.\}/g, skillDir)
        .replace(/\{SKILL_DIR\}/g, skillDir)
        .replace(/\$\{SKILL_DIR:-\.\}/g, skillDir)
        .replace(/\$\{SKILL_DIR\}/g, skillDir);
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
        ''
      ].join('\n');
      return { ok: true, content: `${guide}${resolvedContent}`, data: skill };
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
        const doc = deps.skillManager.patch({ name, oldString: stringArg(obj, 'old_string'), newString: stringArg(obj, 'new_string') });
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
        description: 'List files inside the configured workspace directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative workspace path.' } }
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const target = safeJoin(cfg.workspaceDir, stringArg(objectArgs(args), 'path', '.'));
      if (!existsSync(target)) return { ok: false, content: 'Path not found.' };
      const items = readdirSync(target).map((name) => {
        const file = join(target, name);
        const stat = statSync(file);
        return { name, path: relative(cfg.workspaceDir, file), type: stat.isDirectory() ? 'directory' : 'file', size: stat.size };
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
        description: 'Read a UTF-8 text file inside the configured workspace directory.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative workspace file path.' } },
          required: ['path']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const target = safeJoin(cfg.workspaceDir, stringArg(objectArgs(args), 'path'));
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
        description: 'Write a UTF-8 text file inside the configured workspace directory. Creates parent directories.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative workspace file path.' },
            content: { type: 'string', description: 'File content.' }
          },
          required: ['path', 'content']
        }
      }
    },
    async execute(args) {
      const cfg = deps.getConfig();
      const obj = objectArgs(args);
      const target = safeJoin(cfg.workspaceDir, stringArg(obj, 'path'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, stringArg(obj, 'content'), 'utf8');
      return { ok: true, content: `Wrote ${relative(cfg.workspaceDir, target)}.` };
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
            timeout_ms: { type: 'number', description: 'Optional load timeout in milliseconds.' }
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
      const state = await access.browser.open(url, { timeoutMs: numberArg(obj, 'timeout_ms', 20000) });
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
            timeout_ms: { type: 'number', description: 'Navigation wait timeout in milliseconds.' }
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
        timeoutMs: numberArg(obj, 'timeout_ms', 20000)
      });
      return { ok: true, content: withBrowserPreview(`Clicked selector: ${selector}`, state), data: state };
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
            direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
            amount: { type: 'number', description: 'Scroll amount in pixels for up/down.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const directionRaw = stringArg(obj, 'direction', 'down');
      const direction = directionRaw === 'up' || directionRaw === 'top' || directionRaw === 'bottom' ? directionRaw : 'down';
      const state = await access.browser.scroll({
        direction,
        amount: numberArg(obj, 'amount', 800)
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
        description: 'Wait for a duration or selector in the browser automation session.',
        parameters: {
          type: 'object',
          properties: {
            ms: { type: 'number', description: 'Milliseconds to wait.' },
            selector: { type: 'string', description: 'Wait until this selector appears.' },
            timeout_ms: { type: 'number', description: 'Timeout for selector waiting.' }
          }
        }
      }
    },
    async execute(args) {
      const access = requireBrowserAutomation();
      if (!access.ok) return access.result;
      const obj = objectArgs(args);
      const selector = stringArg(obj, 'selector', '').trim() || undefined;
      const ms = numberArg(obj, 'ms', selector ? 0 : 250);
      const state = await access.browser.wait({
        ms,
        selector,
        timeoutMs: numberArg(obj, 'timeout_ms', 20000)
      });
      return { ok: true, content: withBrowserPreview(`Wait completed.${selector ? ` selector=${selector}` : ''}`, state), data: state };
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
            max_chars: { type: 'number', description: 'Maximum characters to return.' }
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
      return { ok: true, content: renderBrowserExtractResult(extracted), data: extracted };
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
    browserOpen,
    browserState,
    browserClick,
    browserType,
    browserScroll,
    browserWait,
    browserExtract,
    browserClose,
    terminal,
    diagnostics
  ];
}
