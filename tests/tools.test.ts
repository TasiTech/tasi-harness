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
  });

  it('writes only inside workspace and rejects escaped paths', async () => {
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

    const bad = await registry.execute('file_write', { path: '../outside.txt', content: 'nope' }, { sessionId: 's', workspaceDir: cfg.workspaceDir, requestId: 'r' });
    expect(bad.ok).toBe(false);
    expect(existsSync(join(env.home, 'outside.txt'))).toBe(false);
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
