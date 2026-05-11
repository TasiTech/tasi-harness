import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
    expect(cfg.externalBrowserProfileMode).toBe('isolated');
    expect(cfg.browserHeadless).toBe(false);
    expect(cfg.browserExecutionLoggingEnabled).toBe(false);
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
    const mockBrowser: BrowserAutomation = {
      async open(url: string) {
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
      async wait() {
        return { url: 'https://example.com', title: 'Example' };
      },
      async extract() {
        return {
          url: 'https://example.com',
          title: 'Example',
          content: JSON.stringify(
            {
              tool: 'browser_extract',
              format: 'json',
              browser_preview_url: 'https://example.com',
              url: 'https://example.com',
              title: 'Example',
              text: 'Hello world',
              headings: [],
              links: []
            },
            null,
            2
          ),
          format: 'json' as const
        };
      },
      async snapshot() {
        return {
          url: 'https://example.com',
          title: 'Example',
          content: JSON.stringify({ tool: 'browser_snapshot', browser_preview_url: 'https://example.com', elements: [] }),
          elements: [],
          headings: [],
          links: [],
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

    const extract = await registry.execute(
      'browser_extract',
      { max_chars: 2000 },
      { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' }
    );
    expect(extract.ok).toBe(true);
    expect(JSON.parse(extract.content)).toMatchObject({
      format: 'json',
      text: 'Hello world',
      url: 'https://example.com'
    });

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
  });
});
