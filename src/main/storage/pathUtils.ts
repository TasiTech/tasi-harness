import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { AppConfig } from '../../shared/types.js';
import { providerDefaultBaseUrl, providerDefaultModel } from '../../shared/providerCatalog.js';

export const DEFAULT_HOME = join(homedir(), '.tasi-harness');

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function defaultConfig(): AppConfig {
  return {
    provider: 'openai',
    baseUrl: providerDefaultBaseUrl('openai'),
    apiKey: '',
    model: providerDefaultModel('openai'),
    temperature: 0.3,
    maxIterations: 8,
    workspaceDir: join(DEFAULT_HOME, 'workspace'),
    allowShellTools: false,
    enableNetworkTools: false,
    browserMode: 'embedded',
    externalBrowserEngine: 'auto',
    externalBrowserCdpEndpoint: 'http://127.0.0.1:9222',
    externalBrowserProfileMode: 'isolated',
    theme: 'dark',
    systemPersona:
      'You are Tasi Harness, a desktop AI agent. Be practical, tool-aware, careful with local files, and ask for clarification only when necessary.',
    defaultExecutionMode: 'workspace',
    skillMarketSources: [
      {
        id: 'clawhub',
        name: 'ClawHub',
        description: 'A curated workflow market for desktop agent skills.',
        enabled: true
      },
      {
        id: 'skillhub',
        name: 'SkillHub',
        description: 'A general-purpose skill catalog with reusable productivity skills.',
        enabled: true
      }
    ],
    emailNotifications: {
      enabled: false,
      host: '',
      port: 465,
      secure: true,
      username: '',
      password: '',
      from: '',
      to: ''
    },
    wechatChannel: {
      enabled: false,
      pluginName: 'clawbot',
      bindUrl: 'https://ilinkai.weixin.qq.com',
      loginStatus: 'idle'
    },
    enabledToolNames: [
      'memory',
      'session_search',
      'skill_manage',
      'skill_view',
      'file_list',
      'file_read',
      'file_write',
      'browser_open',
      'browser_state',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
      'browser_extract',
      'browser_close',
      'terminal'
    ]
  };
}

export function configFileForHome(home: string): string {
  return join(home, 'config.json');
}

export function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

export function safeJoin(root: string, input = '.'): string {
  const cleanInput = input.trim() || '.';
  const rootResolved = resolve(root);
  const target = isAbsolute(cleanInput) ? resolve(cleanInput) : resolve(rootResolved, cleanInput);
  const rel = normalize(target).startsWith(rootResolved + sep) || target === rootResolved;
  if (!rel) {
    throw new Error(`Path escapes workspace: ${input}`);
  }
  return target;
}

export function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Name must include at least one ASCII letter or number.');
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) throw new Error('Invalid name.');
  return slug;
}
