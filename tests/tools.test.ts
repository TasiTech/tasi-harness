import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBuiltinTools } from '../src/main/tools/builtinTools.js';
import { ToolRegistry } from '../src/main/tools/toolRegistry.js';
import type { BrowserAutomation } from '../src/main/tools/browserAutomation.js';
import { MemoryStore } from '../src/main/storage/memoryStore.js';
import { SessionStore } from '../src/main/storage/sessionStore.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { defaultConfig, ensureDir } from '../src/main/storage/pathUtils.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => cleanup());

describe('builtin tools', () => {
  it('includes external browser defaults for controlled system-browser mode', () => {
    const cfg = defaultConfig();
    expect(cfg.browserMode).toBe('external');
    expect(cfg.sessionDocumentMaxDocs).toBe(10);
    expect(cfg.externalBrowserEngine).toBe('auto');
    expect(cfg.externalBrowserCdpEndpoint).toBe('http://127.0.0.1:9222');
    expect(cfg.externalBrowserProfileMode).toBe('system');
    expect(cfg.browserHeadless).toBe(false);
    expect(cfg.browserExecutionLoggingEnabled).toBe(false);
    expect(cfg.enabledToolNames).toContain('browser_close_policy');
  });

  it('writes inside workspace without approval and outside workspace with approval', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);

    const ok = await registry.execute('file_write', { path: 'notes/a.txt', content: 'hello' }, { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' });
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(cfg.workspaceDir, 'notes/a.txt'), 'utf8')).toBe('hello');

    const outside = await registry.execute(
      'file_write',
      { path: '../outside.txt', content: 'approved' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => ({ id: request.id, approved: true })
      }
    );
    expect(outside.ok).toBe(true);
    expect(readFileSync(join(env.home, 'outside.txt'), 'utf8')).toBe('approved');
  });

  it('requires approval for workspace deletes but not workspace writes', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);
    let approvals = 0;
    const write = await registry.execute(
      'file_write',
      { path: 'a.txt', content: 'hello' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      }
    );
    expect(write.ok).toBe(true);
    expect(approvals).toBe(0);

    const deniedDelete = await registry.execute(
      'file_delete',
      { path: 'a.txt' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r2',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      }
    );
    expect(deniedDelete.ok).toBe(false);
    expect(deniedDelete.approval?.risk).toBe('workspace-delete');
    expect(existsSync(join(cfg.workspaceDir, 'a.txt'))).toBe(true);
    expect(approvals).toBe(1);
  });

  it('requires approval for outside-workspace reads and writes', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const outsidePath = join(env.home, 'outside.txt');
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);

    const deniedWrite = await registry.execute(
      'file_write',
      { path: outsidePath, content: 'nope' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => ({ id: request.id, approved: false })
      }
    );
    expect(deniedWrite.ok).toBe(false);
    expect(deniedWrite.approval?.risk).toBe('outside-write');
    expect(existsSync(outsidePath)).toBe(false);

    const approvedWrite = await registry.execute(
      'file_write',
      { path: outsidePath, content: 'outside' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r2',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => ({ id: request.id, approved: true })
      }
    );
    expect(approvedWrite.ok).toBe(true);

    const deniedRead = await registry.execute(
      'file_read',
      { path: outsidePath },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r3',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => ({ id: request.id, approved: false })
      }
    );
    expect(deniedRead.ok).toBe(false);
    expect(deniedRead.approval?.risk).toBe('outside-read');
  });

  it('does not require approval for reads and writes under app data directories', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const appHome = join(env.home, '.tasi-harness');
    const cfg = { ...defaultConfig(), workspaceDir: join(appHome, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(appHome),
      sessionStore: new SessionStore(appHome),
      skillManager: new SkillManager(appHome)
    })) registry.register(tool);

    let approvals = 0;
    for (const dir of ['memories', 'personal-knowledge', 'session-documents', 'sessions', 'skills', 'workspace']) {
      const targetDir = join(appHome, dir, 'agent-test');
      const targetFile = join(targetDir, 'note.txt');
      const context = {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: `r-${dir}`,
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request: any) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      };

      const write = await registry.execute('file_write', { path: targetFile, content: dir }, context);
      expect(write.ok).toBe(true);
      const read = await registry.execute('file_read', { path: targetFile }, context);
      expect(read.ok).toBe(true);
      expect(read.content).toBe(dir);
      const list = await registry.execute('file_list', { path: targetDir }, context);
      expect(list.ok).toBe(true);
    }
    expect(approvals).toBe(0);
  });

  it('uses remembered approval keys', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const outsidePath = join(env.home, 'outside.txt');
    const rememberedKey = `outside:write:${outsidePath}`;
    const rememberedCfg = {
      ...cfg,
      safetyApproval: { ...cfg.safetyApproval, neverAskAgainKeys: [rememberedKey] }
    };
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => rememberedCfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);
    let approvals = 0;
    const result = await registry.execute(
      'file_write',
      { path: outsidePath, content: 'remembered' },
      {
        sessionId: 's',
        workspaceDir: rememberedCfg.workspaceDir,
        requestId: 'r',
        safetyApproval: rememberedCfg.safetyApproval,
        requestToolApproval: async (request) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      }
    );
    expect(result.ok).toBe(true);
    expect(result.approval?.status).toBe('remembered');
    expect(approvals).toBe(0);
  });

  it('approves only risky terminal commands', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), allowShellTools: true };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);
    let approvals = 0;
    const safe = await registry.execute(
      'terminal',
      { command: 'echo hello' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      }
    );
    expect(safe.ok).toBe(true);
    expect(approvals).toBe(0);

    const risky = await registry.execute(
      'terminal',
      { command: 'del a.txt' },
      {
        sessionId: 's',
        workspaceDir: cfg.workspaceDir,
        requestId: 'r2',
        safetyApproval: cfg.safetyApproval,
        requestToolApproval: async (request) => {
          approvals += 1;
          return { id: request.id, approved: false };
        }
      }
    );
    expect(risky.ok).toBe(false);
    expect(risky.approval?.risk).toBe('terminal-risk');
    expect(approvals).toBe(1);
  });

  it('blocks terminal tool by default', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), allowShellTools: false };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);
    const result = await registry.execute('terminal', { command: 'echo hi' }, { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/disabled/i);
  });

  it('returns skill content with resolved SKILL_DIR placeholders', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const skills = new SkillManager(env.home);
    const skill = skills.create({
      name: 'Tasi Browser Helper 1.0.1',
      category: 'local',
      content: '---\nname: tasi-browser-helper-1.0.1\ndescription: demo\ncategory: local\n---\n\nbash {SKILL_DIR}/scripts/check_setup.sh'
    });
    skills.writeSupportingFile(skill.name, 'scripts/check_setup.sh', '#!/usr/bin/env bash\necho ok\n');
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: skills
    })) registry.register(tool);
    const result = await registry.execute('skill_view', { name: 'tasi-browser-helper-1.0.1' }, { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('# Resolved skill directory:');
    expect(result.content).toContain('# Skills are execution workflows, not optional reference text.');
    expect(result.content).toContain('# Reading this tool output does not count as completing the skill or gathering evidence.');
    expect(result.content).toContain('# If this skill routes the task to provider or browser tools, your next assistant turn should usually contain those tool calls instead of a polished narrative answer.');
    expect(result.content).toContain('/scripts/check_setup.sh');
    expect(result.content).not.toContain('{SKILL_DIR}');
    expect(result.content).toContain('## Referenced markdown files');
  });

  it('loads skill reference markdown only when ref_path is provided', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const skills = new SkillManager(env.home);
    const skill = skills.create({
      name: 'Travel Ref Skill',
      category: 'local',
      content: '---\nname: travel-ref-skill\ndescription: demo\ncategory: local\n---\n\n- provider: ./references/provider-a.md\n'
    });
    skills.writeSupportingFile(skill.name, 'references/provider-a.md', '# Provider A\n\nUse provider A.\n');

    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: skills
    })) registry.register(tool);

    const skillOnly = await registry.execute('skill_view', { name: 'travel-ref-skill' }, { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' });
    expect(skillOnly.ok).toBe(true);
    expect(skillOnly.content).toContain('## Referenced markdown files');
    expect(skillOnly.content).toContain('./references/provider-a.md');
    expect(skillOnly.content).not.toContain('Use provider A.');

    const refLoaded = await registry.execute(
      'skill_view',
      { name: 'travel-ref-skill', ref_path: './references/provider-a.md' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r2' }
    );
    expect(refLoaded.ok).toBe(true);
    expect(refLoaded.content).toContain('Reference path: ./references/provider-a.md');
    expect(refLoaded.content).toContain('Use provider A.');
  });

  it('reports duplicate skill patches as skipped', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const skills = new SkillManager(env.home);
    skills.create({
      name: 'Repo Review',
      category: 'developer',
      content: '---\nname: repo-review\ndescription: Review repos\n---\n\nStep 1: inspect files.'
    });
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: skills
    })) registry.register(tool);

    const first = await registry.execute(
      'skill_manage',
      { action: 'patch', name: 'repo-review', old_string: 'inspect files', new_string: 'inspect files and tests' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    const repeated = await registry.execute(
      'skill_manage',
      { action: 'patch', name: 'repo-review', old_string: 'inspect files', new_string: 'inspect files and tests' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r2' }
    );

    expect(first.ok).toBe(true);
    expect(first.content).toContain('Patched skill repo-review.');
    expect(repeated.ok).toBe(true);
    expect(repeated.content).toContain('Skipped patch for repo-review');
    expect(skills.read('repo-review')?.content.match(/inspect files and tests/g)).toHaveLength(1);
  });

  it('rejects unsafe skill optimization patches', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const skills = new SkillManager(env.home);
    for (const name of ['Repo Review', 'Tasi Browser Automation']) {
      skills.create({
        name,
        category: 'developer',
        content: `---\nname: ${name.toLowerCase().replaceAll(' ', '-')}\ndescription: Test skill\n---\n\n## Notes\n\nUse narrow rules.\n`
      });
    }
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: skills
    })) registry.register(tool);

    const broad = await registry.execute(
      'skill_manage',
      {
        action: 'patch',
        name: 'repo-review',
        old_string: 'Use narrow rules.',
        new_string: 'Global rule for all skills: always handle browser screenshots, diagram SVG export, and DOCX repair the same way.'
      },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r-broad' }
    );
    const whitelist = await registry.execute(
      'skill_manage',
      {
        action: 'patch',
        name: 'repo-review',
        old_string: 'Use narrow rules.',
        new_string: 'Treat image_or_diagram_integrity as a routine signal, not a failure, and ignore the screenshot warning.'
      },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r-whitelist' }
    );
    const polluted = await registry.execute(
      'skill_manage',
      {
        action: 'patch',
        name: 'tasi-browser-automation',
        old_string: 'Use narrow rules.',
        new_string: 'Use browser automation for page state. Also define Draw.io diagram-export and DOCX document figure policy here.'
      },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r-polluted' }
    );

    expect(broad.ok).toBe(false);
    expect(broad.content).toContain('Rejected broad skill optimization patch');
    expect(whitelist.ok).toBe(false);
    expect(whitelist.content).toContain('Rejected failure-signal whitelist patch');
    expect(polluted.ok).toBe(false);
    expect(polluted.content).toContain('Rejected skill responsibility pollution');
  });

  it('returns raw terminal output without injecting browser preview markers', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace'), allowShellTools: true };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home)
    })) registry.register(tool);
    const result = await registry.execute(
      'terminal',
      { command: 'echo hello', timeout_ms: 120000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('exit=0');
    expect(result.content).toContain('stdout:\nhello');
    expect(result.content).not.toContain('browser_preview_url:');
  });

  it('returns browser preview markers for built-in browser tools in embedded mode', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const cfg = { ...defaultConfig(), workspaceDir: join(env.home, 'workspace') };
    ensureDir(cfg.workspaceDir);
    const registry = new ToolRegistry();
    const browserCalls: Array<{ tool: string; options?: unknown }> = [];
    const mockBrowser: BrowserAutomation = {
      async open(url: string, options?: { timeoutMs?: number }) {
        browserCalls.push({ tool: 'open', options });
        return { url: url.startsWith('http') ? url : `https://${url}`, title: 'Example' };
      },
      async click() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async type() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async scroll() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async wait(options) {
        browserCalls.push({ tool: 'wait', options });
        return { url: 'https://example.com', title: 'Example' };
      },
      async extract() {
        return {
          url: 'https://example.com/?ticket=secret-ticket',
          title: 'Example',
          content: JSON.stringify(
            {
              tool: 'browser_extract',
              format: 'json',
              browser_preview_url: 'https://example.com/?ticket=secret-ticket',
              url: 'https://example.com/?ticket=secret-ticket',
              title: 'Example',
              text: 'Hello world\nPhone 13812345678\nWeather sunny',
              headings: ['Hello world', 'Weather'],
              links: [{ text: 'Auth link', href: 'https://example.com/callback?token=abc123' }]
            },
            null,
            2
          ),
          format: 'json' as const
        };
      },
      async snapshot() {
        return {
          url: 'https://example.com/?ticket=secret-ticket',
          title: 'Example',
          content: JSON.stringify({
            tool: 'browser_snapshot',
            browser_preview_url: 'https://example.com/?ticket=secret-ticket',
            url: 'https://example.com/?ticket=secret-ticket',
            elements: [
              { ref: '@e1', tag: 'input', role: 'textbox', name: 'Phone', text: 'Phone 13812345678', selector: '#phone', value: '13812345678', visible: true, enabled: true },
              { ref: '@e3', tag: 'input', role: 'textbox', name: 'Username', text: '', selector: '#i_user', value: '2022620869', visible: true, enabled: true },
              { ref: '@e2', tag: 'div', role: 'div', name: 'Weather', text: 'Weather sunny', selector: '#weather', visible: true, enabled: true }
            ],
            headings: [{ level: 1, text: 'Phone profile' }],
            links: [{ text: 'Auth link', href: 'https://example.com/callback?token=abc123' }],
            images: []
          }),
          elements: [
            { ref: '@e1', tag: 'input', role: 'textbox', name: 'Phone', text: 'Phone 13812345678', selector: '#phone', value: '13812345678', visible: true, enabled: true },
            { ref: '@e3', tag: 'input', role: 'textbox', name: 'Username', text: '', selector: '#i_user', value: '2022620869', visible: true, enabled: true },
            { ref: '@e2', tag: 'div', role: 'div', name: 'Weather', text: 'Weather sunny', selector: '#weather', visible: true, enabled: true }
          ],
          headings: [{ level: 1, text: 'Phone profile' }],
          links: [{ text: 'Auth link', href: 'https://example.com/callback?token=abc123' }],
          images: [],
          viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 }
        };
      },
      async find() {
        return { url: 'https://example.com', title: 'Example', ref: '@e1', selector: '#demo', text: 'Hello world' };
      },
      async hover() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async select() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async check() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async press() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async uploadFile(selector: string, files: string[]) {
        browserCalls.push({ tool: 'uploadFile', options: { selector, files } });
        return { url: 'https://example.com', title: 'Example', selector, files };
      },
      async screenshot() {
        return { url: 'https://example.com', title: 'Example', data: Buffer.from('png'), mimeType: 'image/png', extension: 'png' };
      },
      async pdf() {
        return { url: 'https://example.com', title: 'Example', data: Buffer.from('pdf'), mimeType: 'application/pdf', extension: 'pdf' };
      },
      async storage() {
        return { url: 'https://example.com', title: 'Example', area: 'local' as const, content: '{}' };
      },
      async cookies() {
        return { url: 'https://example.com', title: 'Example', content: '[]' };
      },
      async console() {
        return { url: 'https://example.com', title: 'Example', content: '{"console":[]}' };
      },
      async network() {
        return { url: 'https://example.com', title: 'Example', content: '[]' };
      },
      async evaluate() {
        return { url: 'https://example.com', title: 'Example', content: '"ok"' };
      },
      async setViewport() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async state() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async close() {
        return;
      }
    };
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home),
      browserAutomation: mockBrowser
    })) registry.register(tool);

    const open = await registry.execute(
      'browser_open',
      { url: 'example.com' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(open.ok).toBe(true);
    expect(open.content).toContain('browser_preview_url: https://example.com');
    expect(browserCalls.find((call) => call.tool === 'open')?.options).toMatchObject({ timeoutMs: 60000 });

    const click = await registry.execute(
      'browser_click',
      { selector: '#demo' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(click.ok).toBe(true);
    expect(JSON.parse(click.content)).toMatchObject({
      tool: 'browser_click',
      browser_preview_url: 'https://example.com',
      url: 'https://example.com',
      action: 'dispatched_click_events',
      recommended_next_tools: ['browser_snapshot', 'browser_extract', 'browser_console', 'browser_network']
    });

    const extract = await registry.execute(
      'browser_extract',
      { max_chars: 2000, filter_text: 'Hello' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(extract.ok).toBe(true);
    expect(JSON.parse(extract.content)).toMatchObject({
      format: 'json',
      text: 'Hello world',
      url: 'https://example.com/?ticket=xxxx'
    });
    expect(extract.content).not.toContain('13812345678');
    expect(extract.content).not.toContain('abc123');

    const snapshot = await registry.execute(
      'browser_snapshot',
      { filter_text: 'Phone', include_values: false, max_chars: 10000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.content).toContain('xxxx');
    expect(snapshot.content).not.toContain('[redacted');
    expect(snapshot.content).toContain('Phone');
    expect(snapshot.content).not.toContain('Weather sunny');
    expect(snapshot.content).not.toContain('abc123');

    const sensitiveSnapshot = await registry.execute(
      'browser_snapshot',
      { filter_text: 'Username', include_values: true, max_chars: 10000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(sensitiveSnapshot.ok).toBe(true);
    expect(sensitiveSnapshot.content).toContain('xxxx');
    expect(sensitiveSnapshot.content).not.toContain('2022620869');

    mockBrowser.extract = async (options) => ({
      url: 'https://example.com',
      title: 'Example',
      content:
        options?.format === 'json'
          ? '{not-json'
          : '<html><body><main id="content">fallback html</main></body></html>',
      format: options?.format === 'html' ? ('html' as const) : ('json' as const)
    });

    const extractJson = await registry.execute(
      'browser_extract',
      { format: 'json', max_chars: 2000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(extractJson.ok).toBe(true);
    expect(extractJson.content).toContain('browser_extract format=html');
    expect(extractJson.content).toContain('fallback html');

    const policies: Array<{ sessionId: string; policy: string; reason?: string }> = [];
    const policyRegistry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home),
      setBrowserClosePolicy: (sessionId, policy, reason) => policies.push({ sessionId, policy, reason })
    })) policyRegistry.register(tool);
    const policy = await policyRegistry.execute(
      'browser_close_policy',
      { policy: 'keep_open', reason: 'form submitted for user review' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(policy.ok).toBe(true);
    expect(policy.content).toContain('keep_open');
    expect(policies).toEqual([{ sessionId: 's', policy: 'keep_open', reason: 'form submitted for user review' }]);

    const wait = await registry.execute(
      'browser_wait',
      { url: 'dashboard' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(wait.ok).toBe(true);
    expect([...browserCalls].reverse().find((call) => call.tool === 'wait')?.options).toMatchObject({
      url: 'dashboard',
      untilChanged: true,
      untilLoggedIn: true,
      timeoutMs: 300000
    });

    const longConditionalWait = await registry.execute(
      'browser_wait',
      { url: 'dashboard', timeout_ms: 300000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(longConditionalWait.ok).toBe(true);
    expect([...browserCalls].reverse().find((call) => call.tool === 'wait')?.options).toMatchObject({
      url: 'dashboard',
      untilChanged: true,
      untilLoggedIn: true,
      timeoutMs: 300000
    });

    const manualWait = await registry.execute(
      'browser_wait',
      { ms: 300000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(manualWait.ok).toBe(true);
    expect([...browserCalls].reverse().find((call) => call.tool === 'wait')?.options).toMatchObject({
      ms: 0,
      untilChanged: true,
      untilLoggedIn: true,
      timeoutMs: 300000
    });

    const originalWait = mockBrowser.wait;
    const waitPolicies: Array<{ sessionId: string; policy: string; reason?: string }> = [];
    mockBrowser.wait = async (options) => {
      browserCalls.push({ tool: 'wait', options });
      throw new Error('Timed out waiting for browser condition after 300000 ms.');
    };
    const manualLoginWaitRegistry = new ToolRegistry();
    for (const tool of createBuiltinTools({
      getConfig: () => cfg,
      memoryStore: new MemoryStore(env.home),
      sessionStore: new SessionStore(env.home),
      skillManager: new SkillManager(env.home),
      browserAutomation: mockBrowser,
      setBrowserClosePolicy: (sessionId, policy, reason) => waitPolicies.push({ sessionId, policy, reason })
    })) manualLoginWaitRegistry.register(tool);
    const pendingManualLogin = await manualLoginWaitRegistry.execute(
      'browser_wait',
      { wait_for_user: true, until_logged_in: true, until_changed: true, timeout_ms: 300000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(pendingManualLogin.ok).toBe(true);
    expect(pendingManualLogin.content).toContain('Waiting for user input');
    expect(waitPolicies).toEqual([{ sessionId: 's', policy: 'keep_open', reason: 'waiting for user login, captcha, or MFA in browser' }]);
    mockBrowser.wait = originalWait;

    writeFileSync(join(cfg.workspaceDir, 'invoice.pdf'), 'pdf');
    const upload = await registry.execute(
      'browser_upload_file',
      { selector: 'input[type=file]', path: 'invoice.pdf' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(upload.ok).toBe(true);
    expect(upload.content).toContain('Uploaded 1 file');
    expect(browserCalls.find((call) => call.tool === 'uploadFile')?.options).toMatchObject({
      selector: 'input[type=file]',
      files: [join(cfg.workspaceDir, 'invoice.pdf')]
    });

    browserCalls.length = 0;
    const uploadDefaultSelector = await registry.execute(
      'browser_upload_file',
      { path: 'invoice.pdf' },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(uploadDefaultSelector.ok).toBe(true);
    expect(browserCalls.find((call) => call.tool === 'uploadFile')?.options).toMatchObject({
      selector: 'input[type=file]',
      files: [join(cfg.workspaceDir, 'invoice.pdf')]
    });
  });
});
