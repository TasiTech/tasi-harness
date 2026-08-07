import { memo, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactElement, type SetStateAction } from 'react';
import type { CSSProperties } from 'react';
import type {
  AgentMessage,
  AgentMessageAttachment,
  AppInfo,
  BrowserCoachRecordedEvent,
  BrowserCoachRecording,
  BrowserCoachStoredRecording,
  CustomTheme,
  DreamSkinGalleryResult,
  DreamSkinGallerySort,
  DreamSkinGalleryTheme,
  LlmUsage,
  MarketplaceBrowseResult,
  MarketplaceSkill,
  MemoryDomain,
  MemoryEntry,
  MemoryState,
  PersonalKnowledgeDocument,
  PersonalKnowledgeState,
  PublicAppConfig,
  ScheduledTask,
  SessionDocumentContext,
  SessionSummary,
  SkillDocument,
  SkillMetadata,
  ToolApprovalRequest,
  ToolEvent
} from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browserConstants.js';
import { DEFAULT_OMNI_SYSTEM_PROMPT } from '../shared/defaultPrompts.js';
import {
  OMNI_PROVIDER_PRESETS,
  PROVIDER_PRESETS,
  omniProviderDefaultBaseUrl,
  omniProviderDefaultModel,
  omniProviderModelOptions,
  omniProviderPreset,
  providerDefaultBaseUrl,
  providerDefaultModel,
  providerModelOptions,
  providerPreset,
  providerRequiresApiKey
} from '../shared/providerCatalog.js';
import { extractCitationLinks, type CitationLink } from './citations.js';
import { LiveAgentPage, type LiveAgentOutboundMessage } from './LiveAgentPage.js';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from './markdown.js';
import * as QRCode from 'qrcode';
import JSZip from 'jszip';

type Page = 'chat' | 'knowledge' | 'memory' | 'skills' | 'tasks' | 'sessions' | 'settings' | 'about';
type UiLanguage = 'zh' | 'en';
type TranslateFn = (en: string, zh: string) => string;

const SKILL_CATEGORIES = [
  { value: 'local', en: 'Local', zh: '本地' },
  { value: 'browser', en: 'Browser', zh: '浏览器' },
  { value: 'travel', en: 'Travel', zh: '旅行' },
  { value: 'shopping', en: 'Shopping', zh: '购物' },
  { value: 'work', en: 'Work', zh: '工作' },
  { value: 'documents', en: 'Documents', zh: '文档' },
  { value: 'finance', en: 'Finance', zh: '财务' },
  { value: 'education', en: 'Education', zh: '学习' },
  { value: 'other', en: 'Other', zh: '其他' }
];

const CATEGORY_ALIASES: Record<string, string> = {
  浏览器: 'browser',
  浏览: 'browser',
  browser: 'browser',
  旅行: 'travel',
  旅游: 'travel',
  出行: 'travel',
  travel: 'travel',
  购物: 'shopping',
  电商: 'shopping',
  shopping: 'shopping',
  工作: 'work',
  办公: 'work',
  work: 'work',
  文档: 'documents',
  文件: 'documents',
  document: 'documents',
  documents: 'documents',
  财务: 'finance',
  金融: 'finance',
  finance: 'finance',
  学习: 'education',
  教育: 'education',
  education: 'education',
  本地: 'local',
  local: 'local',
  其他: 'other',
  other: 'other'
};

const defaultConfig: PublicAppConfig = {
  branding: {
    productName: 'Tasi Harness',
    logoPath: '',
    logoInitials: 'TH'
  },
  provider: 'openai',
  baseUrl: providerDefaultBaseUrl('openai'),
  apiKeyConfigured: false,
  model: providerDefaultModel('openai'),
  omniProvider: 'openai',
  omniBaseUrl: omniProviderDefaultBaseUrl('openai'),
  omniApiKeyConfigured: false,
  omniModel: omniProviderDefaultModel('openai'),
  temperature: 0.3,
  maxIterations: 200,
  sessionDocumentMaxDocs: 10,
  workspaceDir: '',
  allowShellTools: true,
  enableNetworkTools: true,
  safetyApproval: {
    enabled: true,
    approveRiskyTerminalCommands: true,
    timeoutMs: 60000,
    neverAskAgainKeys: []
  },
  browserMode: 'embedded',
  externalBrowserEngine: 'auto',
  externalBrowserCdpEndpoint: 'http://127.0.0.1:9222',
  externalBrowserProfileMode: 'system',
  browserHeadless: false,
  browserExecutionLoggingEnabled: false,
  theme: 'dark',
  textBrightness: 100,
  customThemes: [],
  systemPersona: 'You are Tasi Harness, a desktop AI agent.',
  omniSystemPrompt: DEFAULT_OMNI_SYSTEM_PROMPT,
  enabledToolNames: [],
  defaultExecutionMode: 'workspace',
  skillMarketSources: [],
  emailNotifications: {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    username: '',
    from: '',
    to: '',
    passwordConfigured: false
  },
  wechatChannel: {
    enabled: false,
    pluginName: 'clawbot',
    bindUrl: 'https://ilinkai.weixin.qq.com',
    loginStatus: 'idle'
  }
};
const WECHAT_PENDING_MARKER = '__TASI_WECHAT_PENDING__';
const MAX_MULTIMEDIA_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type SettingsDraft = PublicAppConfig & {
  apiKey?: string;
  emailNotifications: PublicAppConfig['emailNotifications'] & { password?: string };
};

function brandInitials(branding?: PublicAppConfig['branding']): string {
  const explicit = branding?.logoInitials?.trim();
  if (explicit) return explicit.slice(0, 8);
  const productName = branding?.productName?.trim() || 'Tasi Harness';
  return productName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 4)
    .toUpperCase() || 'TH';
}

function BrandLogo({ branding, className }: { branding: PublicAppConfig['branding']; className: string }): ReactElement {
  const label = branding.productName || 'Tasi Harness';
  if (branding.logoDataUrl) {
    return <img className={`${className} brand-logo-image`} src={branding.logoDataUrl} alt={label} />;
  }
  return <div className={className}>{brandInitials(branding)}</div>;
}

const CUSTOM_THEME_STYLE_KEYS = [
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-card',
  '--bg-card-hover',
  '--accent',
  '--accent-dim',
  '--accent-2',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--border',
  '--border-active',
  '--ok',
  '--warn',
  '--danger',
  '--shadow',
  '--custom-theme-background-image',
  '--custom-theme-background-position'
];

const CUSTOM_THEME_TOKEN_TO_CSS: Array<[keyof CustomTheme['tokens'], string]> = [
  ['bgPrimary', '--bg-primary'],
  ['bgSecondary', '--bg-secondary'],
  ['bgTertiary', '--bg-tertiary'],
  ['bgCard', '--bg-card'],
  ['bgCardHover', '--bg-card-hover'],
  ['accent', '--accent'],
  ['accentDim', '--accent-dim'],
  ['accent2', '--accent-2'],
  ['textPrimary', '--text-primary'],
  ['textSecondary', '--text-secondary'],
  ['textMuted', '--text-muted'],
  ['border', '--border'],
  ['borderActive', '--border-active'],
  ['ok', '--ok'],
  ['warn', '--warn'],
  ['danger', '--danger'],
  ['shadow', '--shadow']
];

function customThemeId(value: string): string {
  return value.startsWith('custom:') ? value.slice('custom:'.length) : '';
}

const BUILTIN_TEXT_TOKENS: Record<'dark' | 'light' | 'tech', Required<Pick<CustomTheme['tokens'], 'textPrimary' | 'textSecondary' | 'textMuted'>>> = {
  dark: {
    textPrimary: '#f0f0f5',
    textSecondary: '#9696b7',
    textMuted: '#62627a'
  },
  light: {
    textPrimary: '#1a1a2e',
    textSecondary: '#5d607a',
    textMuted: '#8b8da3'
  },
  tech: {
    textPrimary: '#eef9ff',
    textSecondary: '#9fc3df',
    textMuted: '#64819a'
  }
};

function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | undefined {
  const text = value.trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3
      ? raw.split('').map((char) => `${char}${char}`).join('')
      : raw;
    const r = Number.parseInt(full.slice(0, 2), 16);
    const g = Number.parseInt(full.slice(2, 4), 16);
    const b = Number.parseInt(full.slice(4, 6), 16);
    const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return undefined;
  const parts = rgb[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return undefined;
  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const a = parts[3] == null ? 1 : Number.parseFloat(parts[3]);
  if (![r, g, b, a].every(Number.isFinite)) return undefined;
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

function mixColor(color: { r: number; g: number; b: number; a: number }, target: { r: number; g: number; b: number }, amount: number): string {
  const weight = Math.max(0, Math.min(1, amount));
  const r = Math.round(color.r + (target.r - color.r) * weight);
  const g = Math.round(color.g + (target.g - color.g) * weight);
  const b = Math.round(color.b + (target.b - color.b) * weight);
  if (color.a < 1) return `rgba(${r}, ${g}, ${b}, ${Number(color.a.toFixed(3))})`;
  return `rgb(${r}, ${g}, ${b})`;
}

function adjustTextColor(value: string, brightness: number): string | undefined {
  const color = parseCssColor(value);
  if (!color) return undefined;
  if (brightness === 100) return value;
  if (brightness > 100) return mixColor(color, { r: 255, g: 255, b: 255 }, Math.min(0.8, (brightness - 100) / 70));
  return mixColor(color, { r: 0, g: 0, b: 0 }, Math.min(0.65, (100 - brightness) / 80));
}

function baseTextTokens(config: PublicAppConfig, theme?: CustomTheme): Required<Pick<CustomTheme['tokens'], 'textPrimary' | 'textSecondary' | 'textMuted'>> {
  if (theme) {
    return {
      textPrimary: theme.tokens.textPrimary || BUILTIN_TEXT_TOKENS.dark.textPrimary,
      textSecondary: theme.tokens.textSecondary || BUILTIN_TEXT_TOKENS.dark.textSecondary,
      textMuted: theme.tokens.textMuted || BUILTIN_TEXT_TOKENS.dark.textMuted
    };
  }
  if (config.theme === 'light' || config.theme === 'tech') return BUILTIN_TEXT_TOKENS[config.theme];
  return BUILTIN_TEXT_TOKENS.dark;
}

function applyTextBrightness(config: PublicAppConfig, theme?: CustomTheme): void {
  const brightness = Math.max(70, Math.min(150, Number(config.textBrightness) || 100));
  const root = document.documentElement;
  const tokens = baseTextTokens(config, theme);
  const targets = [
    ['--text-primary', tokens.textPrimary],
    ['--text-secondary', tokens.textSecondary],
    ['--text-muted', tokens.textMuted]
  ] as const;
  for (const [cssKey, base] of targets) {
    const adjusted = adjustTextColor(base, brightness);
    root.style.setProperty(cssKey, adjusted || base);
  }
}

function applyDocumentTheme(config: PublicAppConfig): void {
  const root = document.documentElement;
  for (const key of CUSTOM_THEME_STYLE_KEYS) root.style.removeProperty(key);
  const customId = customThemeId(config.theme);
  const theme = customId ? (config.customThemes ?? []).find((item) => item.id === customId) : undefined;
  if (!theme) {
    root.setAttribute('data-theme', config.theme || 'dark');
    applyTextBrightness(config);
    return;
  }
  root.setAttribute('data-theme', 'custom');
  for (const [tokenKey, cssKey] of CUSTOM_THEME_TOKEN_TO_CSS) {
    const value = theme.tokens[tokenKey];
    if (value) root.style.setProperty(cssKey, value);
  }
  if (theme.backgroundDataUrl) {
    root.style.setProperty('--custom-theme-background-image', `url("${theme.backgroundDataUrl}")`);
    const focusX = Math.round((theme.backgroundFocusX ?? 0.5) * 100);
    const focusY = Math.round((theme.backgroundFocusY ?? 0.5) * 100);
    root.style.setProperty('--custom-theme-background-position', `${focusX}% ${focusY}%`);
  }
  applyTextBrightness(config, theme);
}

function getActiveCustomTheme(config: PublicAppConfig): CustomTheme | undefined {
  const id = customThemeId(config.theme);
  return id ? config.customThemes.find((theme) => theme.id === id) : undefined;
}

function customThemeBackgroundStyle(theme?: CustomTheme): CSSProperties | undefined {
  if (!theme?.backgroundDataUrl) return undefined;
  const focusX = Math.round((theme.backgroundFocusX ?? 0.5) * 100);
  const focusY = Math.round((theme.backgroundFocusY ?? 0.5) * 100);
  return {
    backgroundImage: `url("${theme.backgroundDataUrl}")`,
    backgroundPosition: `${focusX}% ${focusY}%`
  };
}

function prettyDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function padTimePart(value: unknown): string {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return '00';
  return String(Math.min(99, Math.max(0, parsed))).padStart(2, '0');
}

function taskTimeLabel(task: ScheduledTask): string {
  return `${padTimePart(task.scheduleHour)}:${padTimePart(task.scheduleMinute)}`;
}

function weekdayLabel(day: unknown, tr: TranslateFn): string {
  const labels = [
    tr('Sunday', '周日'),
    tr('Monday', '周一'),
    tr('Tuesday', '周二'),
    tr('Wednesday', '周三'),
    tr('Thursday', '周四'),
    tr('Friday', '周五'),
    tr('Saturday', '周六')
  ];
  const index = Math.trunc(Number(day));
  return labels[index >= 0 && index <= 6 ? index : 1];
}

function normalizeNumberSelection(value: unknown, min: number, max: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Math.trunc(Number(item))).filter((item) => Number.isFinite(item) && item >= min && item <= max))]
    .sort((a, b) => a - b);
}

function taskWeekdaySelection(task: ScheduledTask): number[] {
  const days = normalizeNumberSelection(task.scheduleWeekdays, 0, 6);
  if (days.length > 0) return days;
  return [Math.min(6, Math.max(0, Math.trunc(Number(task.scheduleWeekday ?? 1))))];
}

function taskMonthDaySelection(task: ScheduledTask): number[] {
  const days = normalizeNumberSelection(task.scheduleMonthDays, 1, 31);
  if (days.length > 0) return days;
  return [Math.min(31, Math.max(1, Math.trunc(Number(task.scheduleMonthDay ?? 1))))];
}

function weekdayOrderIndex(day: number): number {
  return day === 0 ? 6 : day - 1;
}

function formatWeekdaySelection(days: number[], tr: TranslateFn): string {
  const ordered = [...new Set(days)].sort((a, b) => weekdayOrderIndex(a) - weekdayOrderIndex(b));
  const groups: number[][] = [];
  ordered.forEach((day) => {
    const last = groups[groups.length - 1];
    if (last && weekdayOrderIndex(day) === weekdayOrderIndex(last[last.length - 1]) + 1) {
      last.push(day);
    } else {
      groups.push([day]);
    }
  });
  return groups
    .map((group) => {
      if (group.length >= 2) {
        return tr(`${weekdayLabel(group[0], tr)}-${weekdayLabel(group[group.length - 1], tr)}`, `${weekdayLabel(group[0], tr)}至${weekdayLabel(group[group.length - 1], tr)}`);
      }
      return group.map((day) => weekdayLabel(day, tr)).join(tr(', ', '、'));
    })
    .join(tr(', ', '、'));
}

function formatNumberRanges(values: number[]): string {
  const ordered = [...new Set(values)].sort((a, b) => a - b);
  const groups: number[][] = [];
  ordered.forEach((value) => {
    const last = groups[groups.length - 1];
    if (last && value === last[last.length - 1] + 1) {
      last.push(value);
    } else {
      groups.push([value]);
    }
  });
  return groups.map((group) => (group.length >= 2 ? `${group[0]}-${group[group.length - 1]}` : group.join(', '))).join(', ');
}

function formatMonthDaySelection(days: number[], tr: TranslateFn): string {
  return tr(`days ${formatNumberRanges(days)}`, `${formatNumberRanges(days).replaceAll(', ', '、')}号`);
}

function taskScheduleLabel(task: ScheduledTask, tr: TranslateFn): string {
  if (task.scheduleType === 'interval') return tr(`Every ${task.intervalMinutes} minutes`, `每 ${task.intervalMinutes} 分钟`);
  if (task.scheduleType === 'daily') return tr(`Daily at ${taskTimeLabel(task)}`, `每日 ${taskTimeLabel(task)}`);
  if (task.scheduleType === 'weekly') return tr(`Weekly on ${formatWeekdaySelection(taskWeekdaySelection(task), tr)} at ${taskTimeLabel(task)}`, `每周${formatWeekdaySelection(taskWeekdaySelection(task), tr).replace(/^周/, '')} ${taskTimeLabel(task)}`);
  if (task.scheduleType === 'monthly') return tr(`Monthly on ${formatMonthDaySelection(taskMonthDaySelection(task), tr)} at ${taskTimeLabel(task)}`, `每月 ${formatMonthDaySelection(taskMonthDaySelection(task), tr)} ${taskTimeLabel(task)}`);
  return tr(`Once at ${prettyDate(task.runAt)}`, `执行时间：${prettyDate(task.runAt)}`);
}

function parseMonthDaySelection(value: string): number[] {
  const days = new Set<number>();
  value.split(/[\s,，、;；]+/).forEach((part) => {
    if (!part) return;
    const range = part.match(/^(\d{1,2})\s*[-~至到]\s*(\d{1,2})$/);
    if (range) {
      const start = Math.max(1, Math.min(31, Number(range[1])));
      const end = Math.max(1, Math.min(31, Number(range[2])));
      for (let day = Math.min(start, end); day <= Math.max(start, end); day += 1) days.add(day);
      return;
    }
    const day = Math.trunc(Number(part));
    if (Number.isFinite(day) && day >= 1 && day <= 31) days.add(day);
  });
  return [...days].sort((a, b) => a - b);
}

function parseIsoMs(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function latestRoundToolEvents(messages: AgentMessage[], events: ToolEvent[]): ToolEvent[] {
  if (events.length === 0) return events;
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const cutoff = parseIsoMs(lastUser?.createdAt);
  if (cutoff == null) return events;
  const scoped = events.filter((event) => {
    const createdMs = parseIsoMs(event.createdAt);
    if (createdMs == null) return false;
    return createdMs >= cutoff;
  });
  return scoped;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLocalId(prefix = 'ui'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function multimediaKind(mimeType: string): AgentMessageAttachment['kind'] | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function formatBytes(bytes?: number): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(value?: number): string {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count) || count <= 0) return '0';
  return new Intl.NumberFormat().format(count);
}

function dreamSkinSwatches(theme: DreamSkinGalleryTheme): string[] {
  const colors = theme.displayMeta?.colors ?? {};
  return ['background', 'panel', 'accent', 'highlight', 'text']
    .map((key) => colors[key])
    .filter((value): value is string => Boolean(value));
}

function findFirstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>`)\]}]+/i);
  if (!match) return undefined;
  return match[0].replace(/[),.;!?]+$/, '');
}

function extractUrlFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'string') return findFirstHttpUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrlFromValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const prioritizedKeys = ['url', 'href', 'link', 'pageUrl', 'page_url', 'targetUrl', 'target_url', 'website'];
  for (const key of prioritizedKeys) {
    if (!(key in record)) continue;
    const found = extractUrlFromValue(record[key], depth + 1);
    if (found) return found;
  }
  for (const [key, nested] of entries) {
    if (!/url|href|link|web|site|page/i.test(key)) continue;
    const found = extractUrlFromValue(nested, depth + 1);
    if (found) return found;
  }
  for (const [, nested] of entries) {
    const found = extractUrlFromValue(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function extractPreviewUrlMarker(text: string): string | undefined {
  const marker = text.match(/browser_preview_url:\s*(https?:\/\/[^\s"'<>`]+)/i);
  if (!marker?.[1]) return undefined;
  return marker[1].replace(/[),.;!?]+$/, '');
}

function previewSourceText(toolName: string, args: unknown, content: string): string {
  return `${toolName} ${safeJson(args)} ${content}`.toLowerCase();
}

function shouldFallbackOpenExternal(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (event.toolName.startsWith('browser_')) return false;
  if (combined.includes('browser_preview_url')) return true;
  return false;
}

function isWebPreviewEvent(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (event.toolName.startsWith('browser_')) return true;
  if (combined.includes('browser_preview_url')) return true;
  return event.toolName.toLowerCase().includes('open') && combined.includes('http');
}

function latestWebPreviewUrl(events: ToolEvent[], fallbackOnly = false): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isWebPreviewEvent(event)) continue;
    if (fallbackOnly && !shouldFallbackOpenExternal(event)) continue;
    const fromMarker = extractPreviewUrlMarker(event.content);
    if (fromMarker) return fromMarker;
    const fromArgs = extractUrlFromValue(event.args);
    if (fromArgs) return fromArgs;
    const fromContent = extractUrlFromValue(event.content);
    if (fromContent) return fromContent;
  }
  return undefined;
}

function useAsyncData<T>(loader: () => Promise<T>, fallback: T): [T, () => Promise<void>] {
  const [value, setValue] = useState<T>(fallback);
  const refresh = async () => setValue(await loader());
  useEffect(() => {
    void refresh();
  }, []);
  return [value, refresh];
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.split(',').at(1) ?? '';
      if (!data) reject(new Error('Failed to read file content.'));
      else resolve(data);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('Copy failed.');
}

function SidebarIcon(props: { kind: Page }): ReactElement {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };

  switch (props.kind) {
    case 'chat':
      return (
        <svg {...common}>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
        </svg>
      );
    case 'memory':
      return (
        <svg {...common}>
          <path d="M6.5 5.5h11v13h-11z" />
          <path d="M9 3.5v4" />
          <path d="M15 3.5v4" />
          <path d="M8.5 11h7" />
          <path d="M8.5 14.5h5" />
        </svg>
      );
    case 'knowledge':
      return (
        <svg {...common}>
          <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h10A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-10A2.5 2.5 0 0 1 5 17.5z" />
          <path d="M8.5 8.5h8" />
          <path d="M8.5 12h8" />
          <path d="M8.5 15.5h5" />
        </svg>
      );
    case 'skills':
      return (
        <svg {...common}>
          <path d="m14.5 4 5.5 5.5-8 8-5.5.5.5-5.5z" />
          <path d="m12.5 6 5.5 5.5" />
          <path d="M5 6h4" />
          <path d="M4 10h3" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="15" rx="2.5" />
          <path d="M8 3.5v3" />
          <path d="M16 3.5v3" />
          <path d="M4 9.5h16" />
          <path d="m9.5 14 1.5 1.5 3.5-3.5" />
        </svg>
      );
    case 'sessions':
      return (
        <svg {...common}>
          <path d="M12 5a7 7 0 1 0 7 7" />
          <path d="M12 8v4l2.5 2.5" />
          <path d="M17.5 4.5v4h-4" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12 3.5v3" />
          <path d="M12 17.5v3" />
          <path d="M4.6 7.6l2.1 2.1" />
          <path d="M17.3 14.3l2.1 2.1" />
          <path d="M3.5 12h3" />
          <path d="M17.5 12h3" />
          <path d="M4.6 16.4l2.1-2.1" />
          <path d="M17.3 9.7l2.1-2.1" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      );
    case 'about':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 10v5" />
          <path d="M12 7.5h.01" />
        </svg>
      );
  }
}

export function App(): ReactElement {
  const [page, setPage] = useState<Page>('chat');
  const [language, setLanguage] = useState<UiLanguage>(() => {
    const saved = globalThis.localStorage?.getItem('tasi_harness_ui_language');
    return saved === 'zh' ? 'zh' : 'en';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_sidebar_collapsed') === '1');
  const [config, setConfig] = useState<PublicAppConfig>(defaultConfig);
  const [sessions, refreshSessions] = useAsyncData<SessionSummary[]>(() => window.tasiHarness.sessions.list(), []);
  const [tasks, refreshTasks] = useAsyncData<ScheduledTask[]>(() => window.tasiHarness.tasks.list(), []);
  const [memory, refreshMemory] = useAsyncData<MemoryState>(() => window.tasiHarness.memory.get(), { entries: [], usage: [], domains: [], rendered: '' });
  const [knowledge, refreshKnowledge] = useAsyncData<PersonalKnowledgeState>(() => window.tasiHarness.knowledge.list(), {
    docs: [],
    totalDocs: 0,
    totalChunks: 0,
    totalChars: 0
  });
  const [skills, refreshSkills] = useAsyncData<SkillMetadata[]>(() => window.tasiHarness.skills.list(), []);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [restoreLiveSession, setRestoreLiveSession] = useState<{ sessionId: string; token: number } | null>(null);
  const [lastUsage, setLastUsage] = useState<LlmUsage | undefined>();
  const [totalUsage, setTotalUsage] = useState<LlmUsage | undefined>();
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStopping, setChatStopping] = useState(false);
  const [chatLiveModeActive, setChatLiveModeActive] = useState(false);
  const [executionMode, setExecutionMode] = useState<'workspace' | 'sandbox'>('workspace');
  const activeWechatSessionId = config.wechatChannel.sessionId?.trim() || '';
  const isWechatSessionActive = Boolean(sessionId && activeWechatSessionId && sessionId === activeWechatSessionId);
  const tr: TranslateFn = useMemo(() => (en: string, zh: string) => (language === 'zh' ? zh : en), [language]);

  function formatTokensM(value?: number): string {
    const tokens = Number(value ?? 0);
    if (!Number.isFinite(tokens)) return '0.000M';
    return `${(tokens / 1_000_000).toFixed(3)}M`;
  }

  function usageLabel(usage?: LlmUsage): string {
    if (!usage) return '-';
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const total = usage.totalTokens ?? prompt + completion;
    return `P:${formatTokensM(prompt)} C:${formatTokensM(completion)} T:${formatTokensM(total)}`;
  }
  const nav = useMemo<Array<{ page: Page; icon: ReactElement; label: string }>>(
    () => [
      { page: 'chat', icon: <SidebarIcon kind="chat" />, label: tr('Chat', '对话') },
      { page: 'memory', icon: <SidebarIcon kind="memory" />, label: tr('Memory', '记忆') },
      { page: 'skills', icon: <SidebarIcon kind="skills" />, label: tr('Skills', '技能') },
      { page: 'tasks', icon: <SidebarIcon kind="tasks" />, label: tr('Tasks', '任务') },
      { page: 'sessions', icon: <SidebarIcon kind="sessions" />, label: tr('History', '历史') },
      { page: 'settings', icon: <SidebarIcon kind="settings" />, label: tr('Settings', '设置') },
      { page: 'about', icon: <SidebarIcon kind="about" />, label: tr('About', '关于') }
    ],
    [tr]
  );
  const sidebarNav = useMemo<Array<{ page: Page; icon: ReactElement; label: string }>>(() => {
    if (nav.some((item) => item.page === 'knowledge')) return nav;
    return [
      nav[0] ?? { page: 'chat', icon: <SidebarIcon kind="chat" />, label: tr('Chat', '对话') },
      { page: 'knowledge', icon: <SidebarIcon kind="knowledge" />, label: tr('Knowledge', '知识库') },
      ...nav.slice(1)
    ];
  }, [nav, tr]);

  useEffect(() => {
    void window.tasiHarness.config.get().then((cfg) => {
      setConfig(cfg);
      setExecutionMode(cfg.defaultExecutionMode);
      applyDocumentTheme(cfg);
    });
    void window.tasiHarness.app.info().then(setInfo);
  }, []);

  useEffect(() => {
    applyDocumentTheme(config);
  }, [config.theme, config.customThemes, config.textBrightness]);

  useEffect(() => {
    document.title = config.branding.productName || 'Tasi Harness';
  }, [config.branding.productName]);

  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_ui_language', language);
    document.documentElement.setAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
  }, [language]);
  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refreshTasks]);

  useEffect(() => {
    const off = window.tasiHarness.sessions.onUpdated((payload) => {
      void refreshSessions();
      if (chatBusy && payload.source === 'chat') return;
      if (!sessionId || payload.sessionId !== sessionId) return;
      void window.tasiHarness.sessions.readForDisplay(payload.sessionId).then((record) => {
        if (!record) return;
        setMessages(record.messages);
        setLastUsage(record.lastUsage);
        setTotalUsage(record.totalUsage);
        const events = record.toolEvents ?? [];
        if (isWechatSessionActive && payload.source === 'external') {
          setToolEvents(latestRoundToolEvents(record.messages, events));
        } else {
          setToolEvents(events);
        }
        setExecutionMode(record.lastExecution?.mode ?? config.defaultExecutionMode);
      });
    });
    return off;
  }, [sessionId, config.defaultExecutionMode, isWechatSessionActive, chatBusy]);

  useEffect(() => {
    const off = window.tasiHarness.security.onToolApprovalRequest((request) => {
      setApprovalRequest(request);
    });
    return off;
  }, []);

  async function resolveApproval(request: ToolApprovalRequest, approved: boolean, neverAskAgain = false): Promise<void> {
    setApprovalRequest((current) => (current?.id === request.id ? null : current));
    await window.tasiHarness.security.resolveToolApproval({ id: request.id, approved, neverAskAgain });
    if (approved && neverAskAgain) {
      const next = await window.tasiHarness.config.get();
      setConfig(next);
    }
  }

  async function startSkillOptimization(targets: SessionSummary[], userGuidance?: string): Promise<void> {
    if (chatBusy) return;
    if (targets.length === 0) return;
    const extraGuidance = userGuidance?.trim();
    const sessionList = targets
      .map((target, index) => `${index + 1}. ${target.id} (${target.title || 'Untitled'}, updated ${target.updatedAt}, messages ${target.messageCount})`)
      .join('\n');
    const sessionIds = targets.map((target) => target.id).join(', ');
    const prompt = tr(
      [
        `Use skill-creator to jointly inspect these sessions for failed work and recurring failure patterns, identify all related skills, and optimize each affected skill separately. Session ids: ${sessionIds}.`,
        sessionList,
        'Apply three guards: keep each optimization narrowly scoped, do not whitelist or downgrade failure signals as routine, and do not put domain-specific rules into unrelated skills. Use only the selected-session context supplied by the app, then patch the relevant SKILL.md files or scripts, verify the changes, and report what was changed.',
        extraGuidance ? `User guidance for this optimization:\n---\n${extraGuidance}\n---\nFollow this guidance when it does not conflict with the guards above.` : ''
      ].filter(Boolean).join('\n\n'),
      [
        `使用 skill-creator，联合检查这些 session 中的失败问题和重复失败模式，识别所有相关技能，并分别优化每个受影响的技能。Session ids: ${sessionIds}。`,
        sessionList,
        '应用三项防护：每次优化保持窄范围，不要把失败信号白名单化或降级为 routine，不要把领域规则写进无关技能。只使用应用提供的选中 session 上下文，再修改相关 SKILL.md 或脚本，完成校验后汇报改动内容。',
        extraGuidance ? `本次优化的用户指导提示词：\n---\n${extraGuidance}\n---\n在不违背上述防护规则时遵循这些指导。` : ''
      ].filter(Boolean).join('\n\n')
    );
    const userMessage: AgentMessage = {
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString()
    };
    setPage('chat');
    setChatBusy(true);
    setChatStopping(false);
    setSessionId(undefined);
    setToolEvents([]);
    setMessages([userMessage]);
    setLastUsage(undefined);
    try {
      const result = await window.tasiHarness.agent.optimizeSkills({
        prompt,
        sessionIds: targets.map((target) => target.id),
        executionMode
      });
      setSessionId(result.sessionId);
      setMessages(result.messages.filter((m) => m.role !== 'system'));
      setLastUsage(result.usage);
      setTotalUsage(result.totalUsage);
      setToolEvents(result.toolEvents);
      setExecutionMode(result.execution.mode);
      await refreshSessions();
      await refreshSkills();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages([
        userMessage,
        {
          role: 'assistant',
          content: tr(`Skill optimization failed: ${message}`, `技能优化失败：${message}`),
          createdAt: new Date().toISOString()
        }
      ]);
    } finally {
      setChatStopping(false);
      setChatBusy(false);
    }
  }

  const activeCustomTheme = getActiveCustomTheme(config);
  const customThemeBackground = customThemeBackgroundStyle(activeCustomTheme);

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {customThemeBackground && <div className="custom-theme-background" style={customThemeBackground} aria-hidden="true" />}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <BrandLogo branding={config.branding} className="logo-icon" />
          <div className="logo-copy">
            <div className="logo-head">
              <div className="logo-text">{config.branding.productName || 'Tasi Harness'}</div>
              <button className="lang-toggle" onClick={() => setLanguage((current) => (current === 'zh' ? 'en' : 'zh'))}>
                {language === 'zh' ? 'EN' : '中文'}
              </button>
            </div>
            <div className="logo-sub">{tr('Desktop Agent', '桌面智能体')}</div>
          </div>
        </div>
        <div className="nav-section">
          <div className="nav-toolbar">
            <button
              className="sidebar-collapse-button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? tr('Expand workspace sidebar', '展开工作区侧栏') : tr('Collapse workspace sidebar', '收起工作区侧栏')}
              aria-label={sidebarCollapsed ? tr('Expand workspace sidebar', '展开工作区侧栏') : tr('Collapse workspace sidebar', '收起工作区侧栏')}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
          </div>
          {sidebarNav.map((item) => (
            <button
              key={item.page}
              className={`nav-item ${page === item.page ? 'active' : ''}`}
              onClick={() => setPage(item.page)}
              title={item.label}
              aria-label={item.label}
              data-label={item.label}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="meta-row wrap">
            <span className="soft-badge">{tr('Last', '本次')}: {usageLabel(lastUsage)}</span>
            <span className="soft-badge">{tr('Total', '累计')}: {usageLabel(totalUsage)}</span>
          </div>
        </div>
      </aside>
      <main className="main-pane">
        {page === 'chat' && (
          <ChatPage
            tr={tr}
            config={config}
            setConfig={setConfig}
            messages={messages}
            setMessages={setMessages}
            sessionId={sessionId}
            setSessionId={setSessionId}
            restoreLiveSession={restoreLiveSession}
            lastUsage={lastUsage}
            setLastUsage={setLastUsage}
            totalUsage={totalUsage}
            setTotalUsage={setTotalUsage}
            toolEvents={toolEvents}
            setToolEvents={setToolEvents}
            busy={chatBusy}
            setBusy={setChatBusy}
            stopping={chatStopping}
            setStopping={setChatStopping}
            executionMode={executionMode}
            setExecutionMode={setExecutionMode}
            refreshSessions={refreshSessions}
            personalKnowledgeDocCount={knowledge.totalDocs}
            onLiveModeActiveChange={setChatLiveModeActive}
          />
        )}
        {page === 'knowledge' && <KnowledgePage tr={tr} knowledge={knowledge} refreshKnowledge={refreshKnowledge} />}
        {page === 'memory' && <MemoryPage tr={tr} memory={memory} sessionId={sessionId} />}
        {page === 'skills' && (
          <SkillsPage
            tr={tr}
            skills={skills}
            sessions={sessions}
            refreshSkills={refreshSkills}
            refreshSessions={refreshSessions}
            optimizeBusy={chatBusy}
            onOptimizeSession={startSkillOptimization}
          />
        )}
        {page === 'tasks' && <TasksPage tr={tr} tasks={tasks} refreshTasks={refreshTasks} refreshSessions={refreshSessions} />}
        {page === 'sessions' && (
          <SessionsPage
            tr={tr}
            sessions={sessions}
            wechatSessionId={activeWechatSessionId}
            onOpen={async (id) => {
              const record = await window.tasiHarness.sessions.readForDisplay(id);
              if (record) {
                const liveRelation = await window.tasiHarness.liveSessions.read(record.id);
                setSessionId(record.id);
                setMessages(record.messages);
                setLastUsage(record.lastUsage);
                setTotalUsage(record.totalUsage);
                const isWechat = Boolean(config.wechatChannel.sessionId?.trim() && record.id === config.wechatChannel.sessionId?.trim());
                const events = record.toolEvents ?? [];
                setToolEvents(isWechat ? latestRoundToolEvents(record.messages, events) : events);
                setExecutionMode(record.lastExecution?.mode ?? config.defaultExecutionMode);
                setRestoreLiveSession(liveRelation ? { sessionId: record.id, token: Date.now() } : null);
                setPage('chat');
              }
            }}
            refreshSessions={refreshSessions}
          />
        )}
        {page === 'settings' && <SettingsPage tr={tr} config={config} setConfig={setConfig} />}
        {page === 'about' && <AboutPage tr={tr} info={info} branding={config.branding} />}
      </main>
      {approvalRequest && (
        <ToolApprovalModal
          tr={tr}
          request={approvalRequest}
          productName={config.branding.productName || 'Tasi Harness'}
          onApprove={() => void resolveApproval(approvalRequest, true)}
          onApproveNever={() => void resolveApproval(approvalRequest, true, true)}
          onDeny={() => void resolveApproval(approvalRequest, false)}
        />
      )}
    </div>
  );
}

function ToolApprovalModal(props: { tr: TranslateFn; request: ToolApprovalRequest; productName: string; onApprove: () => void; onApproveNever: () => void; onDeny: () => void }): ReactElement {
  const [remainingMs, setRemainingMs] = useState(props.request.timeoutMs);
  useEffect(() => {
    setRemainingMs(props.request.timeoutMs);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const next = Math.max(0, props.request.timeoutMs - (Date.now() - started));
      setRemainingMs(next);
      if (next <= 0) {
        window.clearInterval(timer);
        props.onDeny();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [props.request]);
  const riskLabel = props.request.risk === 'workspace-delete'
    ? props.tr('Workspace delete', '工作区删除')
    : props.request.risk === 'outside-read'
      ? props.tr('Outside read', '工作区外读取')
      : props.request.risk === 'outside-write'
        ? props.tr('Outside write', '工作区外写入')
        : props.request.risk === 'outside-delete'
          ? props.tr('Outside delete', '工作区外删除')
          : props.tr('Risky command', '风险命令');
  return (
    <div className="modal-backdrop approval-backdrop" onClick={props.onDeny}>
      <div className="modal-card approval-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{props.tr('Approval Required', '需要审批')}</h2>
            <div className="card-subtle">{props.tr(`Review this action before ${props.productName} continues.`, `请在 ${props.productName} 继续前确认此操作。`)}</div>
          </div>
          <span className="soft-badge">{riskLabel}</span>
        </div>
        <div className="approval-summary">{props.request.summary}</div>
        <div className="meta-row wrap">
          <span className="soft-badge">{props.tr('Tool', '工具')} {props.request.toolName}</span>
          <span className="soft-badge">{props.tr('Timeout', '超时')} {Math.ceil(remainingMs / 1000)}s</span>
        </div>
        <pre className="code-block small approval-args">{JSON.stringify(props.request.args, null, 2)}</pre>
        <div className="button-row modal-actions">
          <button className="ghost-button" onClick={props.onDeny}>{props.tr('Deny', '拒绝')}</button>
          <button className="ghost-button" onClick={props.onApproveNever}>{props.tr('Allow and do not ask again', '允许且不再需要审批')}</button>
          <button className="primary-button" onClick={props.onApprove}>{props.tr('Allow once', '允许一次')}</button>
        </div>
      </div>
    </div>
  );
}

function PageHeader(props: { title: string; subtitle: string; action?: ReactElement }): ReactElement {
  return (
    <div className="page-header">
      <div>
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      {props.action}
    </div>
  );
}

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  getURL?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  loadURL?: (url: string) => Promise<void> | void;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  setZoomFactor?: (factor: number) => void;
  setZoomLevel?: (level: number) => void;
}

const PREVIEW_MIN_ZOOM_FACTOR = 0.08;
const PREVIEW_ZOOM_LEVEL_BASE = 1.2;

function normalizePreviewUrlInput(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function clampPreviewRect(rect: PreviewRect, containerWidth: number, containerHeight: number): PreviewRect {
  const minWidth = 360;
  const minHeight = 220;
  const maxWidth = Math.max(minWidth, containerWidth - 12);
  const maxHeight = Math.max(minHeight, containerHeight - 12);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, minHeight), maxHeight);
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, containerWidth - width));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, containerHeight - height));
  return { x, y, width, height };
}

function buildDefaultPreviewRect(containerWidth: number, containerHeight: number): PreviewRect {
  const targetWidth = Math.round(containerWidth * 0.98);
  const targetHeight = Math.round(containerHeight * 0.94);
  const rect = clampPreviewRect(
    {
      x: Math.round((containerWidth - targetWidth) / 2),
      y: Math.round((containerHeight - targetHeight) / 2),
      width: targetWidth,
      height: targetHeight
    },
    containerWidth,
    containerHeight
  );
  return rect;
}

function ChatPage(props: {
  tr: TranslateFn;
  config: PublicAppConfig;
  setConfig: (cfg: PublicAppConfig) => void;
  messages: AgentMessage[];
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  sessionId?: string;
  setSessionId: (id?: string) => void;
  restoreLiveSession?: { sessionId: string; token: number } | null;
  lastUsage?: LlmUsage;
  setLastUsage: (usage?: LlmUsage) => void;
  totalUsage?: LlmUsage;
  setTotalUsage: (usage?: LlmUsage) => void;
  toolEvents: ToolEvent[];
  setToolEvents: Dispatch<SetStateAction<ToolEvent[]>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  stopping: boolean;
  setStopping: Dispatch<SetStateAction<boolean>>;
  executionMode: 'workspace' | 'sandbox';
  setExecutionMode: (mode: 'workspace' | 'sandbox') => void;
  refreshSessions: () => Promise<void>;
  personalKnowledgeDocCount: number;
  onLiveModeActiveChange: (active: boolean) => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const [liveModeActive, setLiveModeActive] = useState(false);
  const [liveAutoStart, setLiveAutoStart] = useState(false);
  const [liveStartSignal, setLiveStartSignal] = useState(0);
  const [liveStopSignal, setLiveStopSignal] = useState(0);
  const [liveSessionId, setLiveSessionId] = useState('');
  const [liveRealtimeStatus, setLiveRealtimeStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle');
  const [liveRealtimeMessage, setLiveRealtimeMessage] = useState('');
  const [liveOutboundMessage, setLiveOutboundMessage] = useState<LiveAgentOutboundMessage | null>(null);
  const [error, setError] = useState('');
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([]);
  const [sessionDocs, setSessionDocs] = useState<SessionDocumentContext[]>([]);
  const [sessionDocBusy, setSessionDocBusy] = useState(false);
  const [sessionDocError, setSessionDocError] = useState('');
  const [multimediaAttachments, setMultimediaAttachments] = useState<AgentMessageAttachment[]>([]);
  const [multimediaError, setMultimediaError] = useState('');
  const [wechatChipClearedAt, setWechatChipClearedAt] = useState(() => new Date().toISOString());
  const [usePersonalKnowledgeBase, setUsePersonalKnowledgeBase] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_use_personal_kb') === '1');
  const [toolPanelTab, setToolPanelTab] = useState<'tools' | 'sources'>('tools');
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false);
  const [webPreviewExpanded, setWebPreviewExpanded] = useState(false);
  const [webPreviewRect, setWebPreviewRect] = useState<PreviewRect | null>(null);
  const [previewAddress, setPreviewAddress] = useState('');
  const [previewCanGoBack, setPreviewCanGoBack] = useState(false);
  const [previewCanGoForward, setPreviewCanGoForward] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const toolPanelBodyRef = useRef<HTMLDivElement | null>(null);
  const chatContentGridRef = useRef<HTMLDivElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const previewWebviewRef = useRef<PreviewWebviewElement | null>(null);
  const uploadSessionDocInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMultimediaInputRef = useRef<HTMLInputElement | null>(null);
  const previewZoomFactorRef = useRef(1);
  const previewZoomSyncIdRef = useRef(0);
  const previewContentMetricsRef = useRef<{ contentWidth: number; contentHeight: number } | null>(null);
  const previewMeasuredViewportRef = useRef<{ width: number; height: number } | null>(null);
  const previewNeedsMeasurementRef = useRef(true);
  const externalPreviewOpenUrlRef = useRef('');
  const previousWechatBusyRef = useRef(false);
  const dragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    originRect: PreviewRect;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);
  const visibleMessages = useMemo(
    () => props.messages.filter((m) => {
      if (m.role === 'assistant' && m.content === WECHAT_PENDING_MARKER) return false;
      const isIntermediateToolAssistant = m.role === 'assistant' && !m.content?.trim() && (m.tool_calls?.length ?? 0) > 0;
      if (isIntermediateToolAssistant) return false;
      return m.role === 'user' || (m.role === 'assistant' && Boolean(m.content?.trim() || m.reasoning_content?.trim()));
    }),
    [props.messages]
  );
  const previewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents), [props.toolEvents]);
  const externalFallbackPreviewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents, true), [props.toolEvents]);
  const latestAssistantContent = useMemo(() => {
    const latest = [...visibleMessages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    return latest?.content ?? '';
  }, [visibleMessages]);
  const referencedPages = useMemo(() => extractCitationLinks(latestAssistantContent), [latestAssistantContent]);
  const showEmbeddedWebPreview = props.config.browserMode === 'embedded';
  const shouldShowWebPreview = showEmbeddedWebPreview && Boolean(previewUrl);
  const personalKnowledgeEnabled = usePersonalKnowledgeBase && props.personalKnowledgeDocCount > 0;
  const isWechatSession = Boolean(
    props.sessionId
      && props.config.wechatChannel.sessionId
      && props.sessionId === props.config.wechatChannel.sessionId
  );
  const wechatBusy = isWechatSession && props.messages.some((message) => message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER);
  const runBusy = props.busy || wechatBusy;
  const wechatSessionAttachments = useMemo(() => {
    if (!isWechatSession) return [];
    const seen = new Set<string>();
    const attachments: AgentMessageAttachment[] = [];
    for (const message of props.messages) {
      if (message.role !== 'user') continue;
      if (!message.createdAt || message.createdAt <= wechatChipClearedAt) continue;
      for (const attachment of message.attachments ?? []) {
        const key = attachment.id ?? `${attachment.kind}:${attachment.filename}:${attachment.sizeBytes ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        attachments.push(attachment);
      }
    }
    return attachments.slice(-12);
  }, [isWechatSession, props.messages, wechatChipClearedAt]);
  const activeSessionDocs = useMemo(() => (
    isWechatSession ? sessionDocs.filter((doc) => doc.updatedAt > wechatChipClearedAt) : sessionDocs
  ), [isWechatSession, sessionDocs, wechatChipClearedAt]);
  const visibleSessionDocs = useMemo(() => (
    isWechatSession ? activeSessionDocs.slice(0, 3) : activeSessionDocs
  ), [isWechatSession, activeSessionDocs]);
  const hiddenSessionDocCount = Math.max(0, activeSessionDocs.length - visibleSessionDocs.length);
  const visibleWechatSessionAttachments = useMemo(() => (
    isWechatSession ? wechatSessionAttachments.slice(-3) : wechatSessionAttachments
  ), [isWechatSession, wechatSessionAttachments]);
  const hiddenWechatAttachmentCount = Math.max(0, wechatSessionAttachments.length - visibleWechatSessionAttachments.length);
  useEffect(() => {
    setWechatChipClearedAt(new Date().toISOString());
    previousWechatBusyRef.current = false;
  }, [props.sessionId]);
  useEffect(() => {
    if (!isWechatSession) {
      previousWechatBusyRef.current = false;
      return;
    }
    if (previousWechatBusyRef.current && !wechatBusy) {
      setWechatChipClearedAt(new Date().toISOString());
    }
    previousWechatBusyRef.current = wechatBusy;
  }, [isWechatSession, wechatBusy]);
  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_use_personal_kb', usePersonalKnowledgeBase ? '1' : '0');
  }, [usePersonalKnowledgeBase]);
  useEffect(() => {
    props.onLiveModeActiveChange(liveModeActive);
    return () => props.onLiveModeActiveChange(false);
  }, [liveModeActive]);
  useEffect(() => {
    if (props.personalKnowledgeDocCount > 0 || !usePersonalKnowledgeBase) return;
    setUsePersonalKnowledgeBase(false);
  }, [props.personalKnowledgeDocCount, usePersonalKnowledgeBase]);

  useEffect(() => {
    const restore = props.restoreLiveSession;
    if (!restore || restore.sessionId !== props.sessionId) return;
    setLiveSessionId(restore.sessionId);
    setLiveAutoStart(false);
    setLiveStartSignal(0);
    setLiveStopSignal(0);
    setLiveRealtimeStatus('idle');
    setLiveRealtimeMessage('');
    setLiveOutboundMessage(null);
    setLiveModeActive(true);
  }, [props.restoreLiveSession?.token, props.restoreLiveSession?.sessionId, props.sessionId]);

  async function refreshSessionDocuments(sessionId = props.sessionId): Promise<void> {
    if (!sessionId) {
      setSessionDocs([]);
      setSessionDocError('');
      return;
    }
    try {
      const docs = await window.tasiHarness.sessionDocs.list(sessionId);
      setSessionDocs(docs);
      setSessionDocError('');
    } catch (e) {
      setSessionDocError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    let cancelled = false;
    const sessionId = props.sessionId;
    if (!sessionId) {
      setSessionDocs([]);
      setSessionDocError('');
      return () => {
        cancelled = true;
      };
    }
    void window.tasiHarness.sessionDocs.list(sessionId)
      .then((docs) => {
        if (cancelled) return;
        setSessionDocs(docs);
        setSessionDocError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setSessionDocError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId]);
  useEffect(() => {
    const off = window.tasiHarness.sessions.onUpdated((payload) => {
      if (!props.sessionId || payload.sessionId !== props.sessionId) return;
      void refreshSessionDocuments(payload.sessionId);
    });
    return off;
  }, [props.sessionId]);
  useEffect(() => {
    if (!shouldShowWebPreview) {
      setWebPreviewExpanded(false);
      setWebPreviewRect(null);
      setPreviewAddress('');
      setPreviewCanGoBack(false);
      setPreviewCanGoForward(false);
      setPreviewLoading(false);
      previewZoomFactorRef.current = 1;
      previewZoomSyncIdRef.current += 1;
      previewContentMetricsRef.current = null;
      previewMeasuredViewportRef.current = null;
      previewNeedsMeasurementRef.current = true;
    }
  }, [shouldShowWebPreview]);
  useEffect(() => {
    if (!previewUrl) return;
    setPreviewAddress(previewUrl);
  }, [previewUrl]);
  useEffect(() => {
    if (showEmbeddedWebPreview || !externalFallbackPreviewUrl || !props.busy) {
      externalPreviewOpenUrlRef.current = '';
      return;
    }
    if (externalPreviewOpenUrlRef.current === externalFallbackPreviewUrl) return;
    externalPreviewOpenUrlRef.current = externalFallbackPreviewUrl;
    void window.tasiHarness.app.openExternalUrl(externalFallbackPreviewUrl).then((result) => {
      if (!result.ok && /failed to open/i.test(result.content)) {
        setError(result.content);
      }
    }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [showEmbeddedWebPreview, externalFallbackPreviewUrl, props.busy]);
  useEffect(() => {
    if (!shouldShowWebPreview) return;
    previewContentMetricsRef.current = null;
    previewMeasuredViewportRef.current = null;
    previewNeedsMeasurementRef.current = true;
    previewZoomSyncIdRef.current += 1;
    setPreviewZoomFactor(1, true);
  }, [previewUrl, shouldShowWebPreview]);
  useEffect(() => {
    if (!webPreviewExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWebPreviewExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [webPreviewExpanded]);
  useEffect(() => {
    if (!webPreviewExpanded) return;
    const syncWithinBounds = () => {
      const container = chatContentGridRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      setWebPreviewRect((old) => clampPreviewRect(old ?? buildDefaultPreviewRect(bounds.width, bounds.height), bounds.width, bounds.height));
    };
    syncWithinBounds();
    window.addEventListener('resize', syncWithinBounds);
    return () => window.removeEventListener('resize', syncWithinBounds);
  }, [webPreviewExpanded]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [visibleMessages, props.toolEvents, runBusy]);
  useEffect(() => {
    if (toolPanelCollapsed || toolPanelTab !== 'tools') return;
    const panel = toolPanelBodyRef.current;
    if (!panel) return;
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
  }, [props.toolEvents, toolPanelCollapsed, toolPanelTab]);
  useEffect(() => {
    const off = window.tasiHarness.agent.onToolEvent((payload) => {
      if (props.sessionId && payload.sessionId !== props.sessionId) return;
      props.setToolEvents((old) => [...old, payload.event]);
    });
    return off;
  }, [props.sessionId, props.setToolEvents]);
  useEffect(() => {
    const off = window.tasiHarness.agent.onMessageDelta((payload) => {
      if (props.sessionId && payload.sessionId !== props.sessionId) return;
      props.setMessages((old) => {
        const existing = old.find((message) => message.id === payload.messageId);
        if (!existing) {
          return [
            ...old,
            {
              id: payload.messageId,
              role: 'assistant',
              content: payload.content ?? '',
              reasoning_content: payload.reasoning_content,
              reasoning_parts: payload.reasoning_parts,
              createdAt: payload.createdAt
            }
          ];
        }
        return old.map((message) => {
          if (message.id !== payload.messageId) return message;
          return {
            ...message,
            content: payload.content ?? message.content,
            reasoning_content: payload.reasoning_content ?? message.reasoning_content,
            reasoning_parts: payload.reasoning_parts ?? message.reasoning_parts,
            createdAt: message.createdAt ?? payload.createdAt
          };
        });
      });
    });
    return off;
  }, [props.sessionId, props.setMessages]);
  useEffect(() => {
    if (!showEmbeddedWebPreview) {
      void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(null);
      return;
    }
    const webview = previewWebviewRef.current;
    if (!webview) return;
    const syncBinding = () => {
      try {
        const id = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return;
        void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(id);
      } catch {
        // Ignore transient webview readiness errors.
      }
    };
    webview.addEventListener('dom-ready', syncBinding as EventListener);
    syncBinding();
    return () => {
      webview.removeEventListener('dom-ready', syncBinding as EventListener);
      void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(null);
    };
  }, [showEmbeddedWebPreview]);
  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    if (!webview) return;

    let rafId = 0;
    let disposed = false;
    const syncNavigationState = () => {
      if (disposed) return;
      try {
        const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
        if (currentUrl) setPreviewAddress(currentUrl);
        setPreviewCanGoBack(typeof webview.canGoBack === 'function' ? webview.canGoBack() : false);
        setPreviewCanGoForward(typeof webview.canGoForward === 'function' ? webview.canGoForward() : false);
      } catch {
        // Ignore transient navigation-state read failures.
      }
    };
    const scheduleNavigationStateSync = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncNavigationState);
    };

    const onStartLoading = () => setPreviewLoading(true);
    const onStopLoading = () => {
      setPreviewLoading(false);
      scheduleNavigationStateSync();
    };

    webview.addEventListener('dom-ready', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-navigate', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-navigate-in-page', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-start-loading', onStartLoading as EventListener);
    webview.addEventListener('did-stop-loading', onStopLoading as EventListener);
    scheduleNavigationStateSync();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      webview.removeEventListener('dom-ready', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-navigate', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-navigate-in-page', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-start-loading', onStartLoading as EventListener);
      webview.removeEventListener('did-stop-loading', onStopLoading as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl]);

  function syncPreviewWebviewHostSize(): void {
    const webview = previewWebviewRef.current;
    const body = previewBodyRef.current;
    if (!webview || !body) return;

    try {
      const width = Math.max(1, Math.round(body.clientWidth));
      const height = Math.max(1, Math.round(body.clientHeight));
      if (width < 2 || height < 2) return;

      const nextWidth = `${width}px`;
      const nextHeight = `${height}px`;
      if (webview.style.display !== 'flex') webview.style.display = 'flex';
      if (webview.style.width !== nextWidth) webview.style.width = nextWidth;
      if (webview.style.height !== nextHeight) webview.style.height = nextHeight;
      if (webview.style.minWidth !== '0px') webview.style.minWidth = '0px';
      if (webview.style.minHeight !== '0px') webview.style.minHeight = '0px';
    } catch {
      // Ignore transient host sizing failures while layout is changing.
    }
  }

  function zoomLevelFromFactor(factor: number): number {
    if (!Number.isFinite(factor) || factor <= 0) return 0;
    return Math.log(factor) / Math.log(PREVIEW_ZOOM_LEVEL_BASE);
  }

  function setPreviewZoomFactor(factor: number, force = false): void {
    const webview = previewWebviewRef.current;
    if (!webview) return;
    const nextFactor = Math.min(1, Math.max(PREVIEW_MIN_ZOOM_FACTOR, factor));
    if (!force && Math.abs(previewZoomFactorRef.current - nextFactor) < 0.005) return;
    previewZoomFactorRef.current = nextFactor;
    try {
      webview.setZoomFactor?.(nextFactor);
      webview.setZoomLevel?.(zoomLevelFromFactor(nextFactor));
    } catch {
      // Ignore transient zoom update failures while page is changing.
    }
  }

  function applyPreviewContentZoom(force = false): void {
    const body = previewBodyRef.current;
    const metrics = previewContentMetricsRef.current;
    if (!body || !metrics) return;

    const viewportWidth = Math.max(1, Math.round(body.clientWidth));
    const viewportHeight = Math.max(1, Math.round(body.clientHeight));
    if (viewportWidth < 2 || viewportHeight < 2) return;

    const widthFactor = viewportWidth / Math.max(metrics.contentWidth, 1);
    const heightFactor = viewportHeight / Math.max(metrics.contentHeight, 1);
    setPreviewZoomFactor(Math.min(1, widthFactor, heightFactor), force);
  }

  function currentPreviewViewport(): { width: number; height: number } | null {
    const body = previewBodyRef.current;
    if (!body) return null;
    const width = Math.max(1, Math.round(body.clientWidth));
    const height = Math.max(1, Math.round(body.clientHeight));
    if (width < 2 || height < 2) return null;
    return { width, height };
  }

  function shouldRemeasurePreviewMetrics(): boolean {
    const viewport = currentPreviewViewport();
    if (!viewport) return false;
    if (!previewContentMetricsRef.current) return true;
    const measured = previewMeasuredViewportRef.current;
    if (!measured) return true;
    const widthRatio = viewport.width / Math.max(1, measured.width);
    const heightRatio = viewport.height / Math.max(1, measured.height);
    return (
      Math.abs(viewport.width - measured.width) >= 72 ||
      Math.abs(viewport.height - measured.height) >= 72 ||
      Math.abs(widthRatio - 1) >= 0.12 ||
      Math.abs(heightRatio - 1) >= 0.12
    );
  }

  async function readPreviewContentMetrics(syncId: number): Promise<{ contentWidth: number; contentHeight: number } | null> {
    const webview = previewWebviewRef.current;
    if (!webview) return null;

    try {
      const result = await webview.executeJavaScript?.(
        `new Promise((resolve) => {
          const collect = () => {
            const doc = document.documentElement;
            const body = document.body;
            const contentWidth = Math.max(
              doc ? doc.scrollWidth : 0,
              doc ? doc.offsetWidth : 0,
              doc ? doc.clientWidth : 0,
              body ? body.scrollWidth : 0,
              body ? body.offsetWidth : 0,
              body ? body.clientWidth : 0,
              window.innerWidth || 0
            );
            const contentHeight = Math.max(
              doc ? doc.scrollHeight : 0,
              doc ? doc.offsetHeight : 0,
              doc ? doc.clientHeight : 0,
              body ? body.scrollHeight : 0,
              body ? body.offsetHeight : 0,
              body ? body.clientHeight : 0,
              window.innerHeight || 0
            );
            resolve({ contentWidth, contentHeight });
          };
          requestAnimationFrame(() => requestAnimationFrame(collect));
        })`,
        true
      );
      if (syncId !== previewZoomSyncIdRef.current) return null;
      const metrics = result as { contentWidth?: unknown; contentHeight?: unknown } | undefined;
      const contentWidth = typeof metrics?.contentWidth === 'number' && Number.isFinite(metrics.contentWidth) ? metrics.contentWidth : 0;
      const contentHeight = typeof metrics?.contentHeight === 'number' && Number.isFinite(metrics.contentHeight) ? metrics.contentHeight : 0;
      return { contentWidth, contentHeight };
    } catch {
      return null;
    }
  }

  async function refreshPreviewNaturalMetrics(force = false): Promise<void> {
    if (!force && !previewNeedsMeasurementRef.current && !shouldRemeasurePreviewMetrics()) {
      applyPreviewContentZoom();
      return;
    }

    const syncId = previewZoomSyncIdRef.current + 1;
    previewZoomSyncIdRef.current = syncId;
    const metrics = await readPreviewContentMetrics(syncId);
    if (syncId !== previewZoomSyncIdRef.current || !metrics) return;
    if (metrics.contentWidth < 1 || metrics.contentHeight < 1) return;

    previewContentMetricsRef.current = metrics;
    previewMeasuredViewportRef.current = currentPreviewViewport();
    previewNeedsMeasurementRef.current = false;
    applyPreviewContentZoom(true);
  }

  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    const body = previewBodyRef.current;
    if (!webview || !body) return;
    let disposed = false;
    let rafId = 0;
    let measurementTimeoutId = 0;

    const syncHostSize = () => {
      if (disposed) return;
      syncPreviewWebviewHostSize();
    };

    const scheduleNaturalMeasurement = (delay = webPreviewExpanded ? 90 : 140) => {
      if (disposed) return;
      if (!shouldRemeasurePreviewMetrics()) return;
      previewNeedsMeasurementRef.current = true;
      if (measurementTimeoutId) window.clearTimeout(measurementTimeoutId);
      measurementTimeoutId = window.setTimeout(() => {
        measurementTimeoutId = 0;
        if (disposed) return;
        void refreshPreviewNaturalMetrics(true);
      }, delay);
    };

    const schedulePreviewSync = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncHostSize();
        applyPreviewContentZoom();
        scheduleNaturalMeasurement();
      });
    };

    webview.addEventListener('dom-ready', schedulePreviewSync as EventListener);
    webview.addEventListener('did-stop-loading', schedulePreviewSync as EventListener);
    webview.addEventListener('did-navigate', schedulePreviewSync as EventListener);
    webview.addEventListener('did-navigate-in-page', schedulePreviewSync as EventListener);
    const resizeObserver = new ResizeObserver(() => schedulePreviewSync());
    resizeObserver.observe(body);
    schedulePreviewSync();
    const syncTimeouts = [80, 220].map((delay) => window.setTimeout(schedulePreviewSync, delay));

    return () => {
      disposed = true;
      for (const timeoutId of syncTimeouts) window.clearTimeout(timeoutId);
      if (measurementTimeoutId) window.clearTimeout(measurementTimeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      webview.removeEventListener('dom-ready', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-stop-loading', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-navigate', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-navigate-in-page', schedulePreviewSync as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl, webPreviewExpanded, webPreviewRect?.width, webPreviewRect?.height]);

  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    if (!webview) return;

    let disposed = false;
    let rafId = 0;
    const measurementTimeouts: number[] = [];

    const clearPreviewMeasurement = () => {
      previewContentMetricsRef.current = null;
      previewMeasuredViewportRef.current = null;
      previewNeedsMeasurementRef.current = true;
      previewZoomSyncIdRef.current += 1;
      setPreviewZoomFactor(1, true);
    };

    const scheduleMeasurement = (delay = 0) => {
      const run = () => {
        if (disposed) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          void refreshPreviewNaturalMetrics();
        });
      };
      if (delay <= 0) {
        run();
        return;
      }
      measurementTimeouts.push(window.setTimeout(run, delay));
    };

    const onStartLoading = () => clearPreviewMeasurement();
    const onReadyToMeasure = () => {
      if (!previewNeedsMeasurementRef.current) return;
      scheduleMeasurement();
      scheduleMeasurement(120);
      scheduleMeasurement(320);
    };

    webview.addEventListener('did-start-loading', onStartLoading as EventListener);
    webview.addEventListener('dom-ready', onReadyToMeasure as EventListener);
    webview.addEventListener('did-stop-loading', onReadyToMeasure as EventListener);
    webview.addEventListener('did-navigate', onReadyToMeasure as EventListener);
    webview.addEventListener('did-navigate-in-page', onReadyToMeasure as EventListener);
    onReadyToMeasure();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      for (const timeoutId of measurementTimeouts) window.clearTimeout(timeoutId);
      webview.removeEventListener('did-start-loading', onStartLoading as EventListener);
      webview.removeEventListener('dom-ready', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-stop-loading', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-navigate', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-navigate-in-page', onReadyToMeasure as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl]);

  const connected = props.config.apiKeyConfigured || !providerRequiresApiKey(props.config.provider);
  const liveCallReady = props.config.omniApiKeyConfigured && Boolean(props.config.omniBaseUrl && props.config.omniModel);
  const liveInputReady = liveModeActive && liveRealtimeStatus === 'connected';
  const livePhoneTitle = liveModeActive
    ? liveRealtimeStatus === 'connected'
      ? props.tr('Hang up realtime call', '挂断实时通话')
      : liveRealtimeStatus === 'connecting'
      ? props.tr('Cancel realtime call', '取消实时通话连接')
      : props.tr('Connect realtime call', '接通实时通话')
    : props.tr('Enable realtime mode from the top bar first', '请先在上方打开实时模式');
  const liveModeToggleTitle = liveModeActive
    ? props.tr('Switch back to text chat', '切换回文字对话')
    : liveCallReady
    ? props.tr('Switch to realtime voice mode', '切换到实时语音模式')
    : props.tr('Configure Omni model first', '请先配置 Omni 模型');
  const liveModeToggleDisabled = !liveModeActive && (runBusy || !liveCallReady);

  function isStoppedByUserError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError') return true;
    return /session stopped by user|operation was aborted|aborted/i.test(error.message);
  }

  async function setBridgeMode(mode: PublicAppConfig['browserMode']): Promise<void> {
    if (mode === props.config.browserMode) return;
    try {
      setError('');
      const next = await window.tasiHarness.config.set({ browserMode: mode });
      props.setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitMessage(rawText: string): Promise<void> {
    const text = rawText.trim();
    const outgoingAttachments = multimediaAttachments;
    if ((!text && outgoingAttachments.length === 0) || props.busy) return;
    setInput('');
    setError('');
    setMultimediaError('');
    setMultimediaAttachments([]);
    props.setBusy(true);
    props.setStopping(false);
    setFollowUpQuestions([]);
    props.setToolEvents([]);
    props.setMessages([...props.messages, { role: 'user', content: text, attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined, createdAt: new Date().toISOString() }]);
    try {
      const result = await window.tasiHarness.agent.chat(text, props.sessionId, props.executionMode, personalKnowledgeEnabled, outgoingAttachments);
      props.setSessionId(result.sessionId);
      props.setMessages(result.messages.filter((m) => m.role !== 'system'));
      props.setLastUsage(result.usage);
      props.setTotalUsage(result.totalUsage);
      props.setToolEvents(result.toolEvents);
      props.setExecutionMode(result.execution.mode);
      setFollowUpQuestions((result.followUpQuestions ?? []).filter((item) => item.trim()).slice(0, 4));
      await props.refreshSessions();
    } catch (e) {
      if (isStoppedByUserError(e)) {
        setError('');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      props.setStopping(false);
      props.setBusy(false);
    }
  }

  async function submitLiveMessage(rawText: string): Promise<void> {
    const text = rawText.trim();
    const outgoingAttachments = multimediaAttachments;
    const outgoingDocuments = activeSessionDocs;
    if ((!text && outgoingAttachments.length === 0 && outgoingDocuments.length === 0) || !liveInputReady) return;
    setInput('');
    setError('');
    setMultimediaError('');
    setMultimediaAttachments([]);
    setLiveOutboundMessage({
      id: createLocalId('liveout'),
      text,
      attachments: outgoingAttachments,
      documents: outgoingDocuments
    });
  }

  async function stopCurrentSession(): Promise<void> {
    if ((!props.busy && !wechatBusy) || props.stopping) return;
    props.setStopping(true);
    setError('');
    try {
      await window.tasiHarness.agent.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!props.busy) props.setStopping(false);
    }
  }

  async function send(): Promise<void> {
    if (liveModeActive) {
      await submitLiveMessage(input);
      return;
    }
    await submitMessage(input);
  }

  function toggleWebPreviewExpanded(): void {
    if (!webPreviewExpanded) {
      const container = chatContentGridRef.current;
      if (container) {
        const bounds = container.getBoundingClientRect();
        setWebPreviewRect(clampPreviewRect(buildDefaultPreviewRect(bounds.width, bounds.height), bounds.width, bounds.height));
      }
      previewNeedsMeasurementRef.current = true;
      setWebPreviewExpanded(true);
      window.requestAnimationFrame(() => {
        const webview = previewWebviewRef.current;
        if (!webview) return;
        try {
          syncPreviewWebviewHostSize();
          void refreshPreviewNaturalMetrics(true);
        } catch {
          // Ignore transient readiness failures.
        }
      });
      return;
    }
    setWebPreviewExpanded(false);
  }

  function handlePreviewDragStart(event: React.MouseEvent<HTMLDivElement>): void {
    if (!webPreviewExpanded || !webPreviewRect) return;
    if (event.button !== 0) return;
    if ((event.target as Element).closest('button, a, input, textarea, select')) return;
    const container = chatContentGridRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    dragStateRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect: webPreviewRect,
      containerWidth: bounds.width,
      containerHeight: bounds.height
    };
    const onMouseMove = (moveEvent: MouseEvent) => {
      const dragging = dragStateRef.current;
      if (!dragging) return;
      const deltaX = moveEvent.clientX - dragging.startClientX;
      const deltaY = moveEvent.clientY - dragging.startClientY;
      const next = clampPreviewRect(
        {
          x: dragging.originRect.x + deltaX,
          y: dragging.originRect.y + deltaY,
          width: dragging.originRect.width,
          height: dragging.originRect.height
        },
        dragging.containerWidth,
        dragging.containerHeight
      );
      setWebPreviewRect(next);
    };
    const onMouseUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function syncPreviewNavigationState(): void {
    const webview = previewWebviewRef.current;
    if (!webview) return;
    try {
      const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
      if (currentUrl) setPreviewAddress(currentUrl);
      setPreviewCanGoBack(typeof webview.canGoBack === 'function' ? webview.canGoBack() : false);
      setPreviewCanGoForward(typeof webview.canGoForward === 'function' ? webview.canGoForward() : false);
    } catch {
      // Ignore transient errors while page changes.
    }
  }

  function handlePreviewBack(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.goBack !== 'function') return;
    try {
      if (typeof webview.canGoBack === 'function' && !webview.canGoBack()) return;
      webview.goBack();
      window.setTimeout(syncPreviewNavigationState, 80);
    } catch {
      // Ignore transient navigation errors.
    }
  }

  function handlePreviewForward(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.goForward !== 'function') return;
    try {
      if (typeof webview.canGoForward === 'function' && !webview.canGoForward()) return;
      webview.goForward();
      window.setTimeout(syncPreviewNavigationState, 80);
    } catch {
      // Ignore transient navigation errors.
    }
  }

  function handlePreviewRefresh(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.reload !== 'function') return;
    try {
      webview.reload();
    } catch {
      // Ignore transient navigation errors.
    }
  }

  async function navigatePreviewToAddress(): Promise<void> {
    const normalized = normalizePreviewUrlInput(previewAddress);
    if (!normalized) {
      setError(props.tr('Invalid URL. Please input a valid http(s) address.', 'URL 无效，请输入有效的 http(s) 地址。'));
      return;
    }
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.loadURL !== 'function') return;
    setError('');
    setPreviewAddress(normalized);
    try {
      await webview.loadURL(normalized);
      syncPreviewNavigationState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function openSessionDocumentPicker(): void {
    if (runBusy || sessionDocBusy) return;
    if (!uploadSessionDocInputRef.current) return;
    uploadSessionDocInputRef.current.value = '';
    uploadSessionDocInputRef.current.click();
  }

  function openMultimediaPicker(): void {
    if (runBusy) return;
    if (!uploadMultimediaInputRef.current) return;
    uploadMultimediaInputRef.current.value = '';
    uploadMultimediaInputRef.current.click();
  }

  async function openWorkspaceDirectory(): Promise<void> {
    const workspaceDir = props.config.workspaceDir.trim();
    if (!workspaceDir) {
      setError(props.tr('Workspace directory is not configured.', '尚未配置工作区目录。'));
      return;
    }
    setError('');
    try {
      const result = await window.tasiHarness.app.openPath(workspaceDir);
      if (!result.ok) setError(result.content || props.tr('Failed to open workspace directory.', '打开工作区目录失败。'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadSessionDocuments(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setSessionDocBusy(true);
    setSessionDocError('');
    try {
      let activeSessionId = props.sessionId;
      const failures: string[] = [];
      for (const file of files) {
        try {
          const contentBase64 = await fileToBase64(file);
          const result = await window.tasiHarness.sessionDocs.upload({
            sessionId: activeSessionId,
            filename: file.name,
            contentBase64
          });
          activeSessionId = result.sessionId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${file.name}: ${message}`);
        }
      }
      if (activeSessionId && props.sessionId !== activeSessionId) props.setSessionId(activeSessionId);
      if (!activeSessionId) return;
      const docs = await window.tasiHarness.sessionDocs.list(activeSessionId);
      setSessionDocs(docs);
      await props.refreshSessions();
      if (failures.length > 0) {
        setSessionDocError(
          props.tr(
            `Some files failed to upload:\n${failures.join('\n')}`,
            `部分文件上传失败：\n${failures.join('\n')}`
          )
        );
      }
    } catch (e) {
      setSessionDocError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionDocBusy(false);
    }
  }

  async function addMultimediaAttachments(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setMultimediaError('');
    const next: AgentMessageAttachment[] = [];
    const failures: string[] = [];
    for (const file of files) {
      const kind = multimediaKind(file.type);
      if (!kind) {
        failures.push(`${file.name}: ${props.tr('unsupported media type', '不支持的媒体类型')}`);
        continue;
      }
      if (file.size > MAX_MULTIMEDIA_ATTACHMENT_BYTES) {
        failures.push(`${file.name}: ${props.tr('file is larger than 8 MB', '文件超过 8 MB')}`);
        continue;
      }
      try {
        next.push({
          id: createLocalId('media'),
          kind,
          filename: file.name,
          mimeType: file.type,
          contentBase64: await fileToBase64(file),
          sizeBytes: file.size
        });
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (next.length > 0) setMultimediaAttachments((old) => [...old, ...next]);
    if (failures.length > 0) setMultimediaError(failures.join('\n'));
  }

  function removeMultimediaAttachment(id: string | undefined): void {
    if (!id) return;
    setMultimediaAttachments((old) => old.filter((item) => item.id !== id));
  }

  function resetTextSessionState(): void {
    setInput('');
    props.setMessages([]);
    props.setSessionId(undefined);
    props.setLastUsage(undefined);
    props.setTotalUsage(undefined);
    props.setToolEvents([]);
    props.setExecutionMode(props.config.defaultExecutionMode);
    setFollowUpQuestions([]);
    setSessionDocs([]);
    setSessionDocError('');
    setMultimediaAttachments([]);
    setMultimediaError('');
  }

  async function removeSessionDocument(id: string): Promise<void> {
    if (!props.sessionId) return;
    setSessionDocBusy(true);
    setSessionDocError('');
    try {
      await window.tasiHarness.sessionDocs.deleteDocument(props.sessionId, id);
      const docs = await window.tasiHarness.sessionDocs.list(props.sessionId);
      setSessionDocs(docs);
    } catch (e) {
      setSessionDocError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionDocBusy(false);
    }
  }

  async function startLiveMode(): Promise<void> {
    if (runBusy || !liveCallReady) return;
    setError('');
    try {
      const created = await window.tasiHarness.liveSessions.create();
      props.setSessionId(created.sessionId);
      props.setMessages([]);
      props.setToolEvents([]);
      props.setLastUsage(undefined);
      props.setTotalUsage(undefined);
      setFollowUpQuestions([]);
      setSessionDocs([]);
      setSessionDocError('');
      setMultimediaAttachments([]);
      setMultimediaError('');
      setLiveSessionId(created.sessionId);
      setLiveAutoStart(false);
      setLiveStartSignal(0);
      setLiveStopSignal(0);
      setLiveRealtimeStatus('idle');
      setLiveRealtimeMessage('');
      setLiveOutboundMessage(null);
      setLiveModeActive(true);
      await props.refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function stopLiveMode(): Promise<void> {
    await window.tasiHarness.liveRealtime.stop().catch(() => undefined);
    setLiveModeActive(false);
    setLiveAutoStart(false);
    setLiveStartSignal(0);
    setLiveStopSignal(0);
    setLiveSessionId('');
    setLiveRealtimeStatus('closed');
    setLiveRealtimeMessage('');
    setLiveOutboundMessage(null);
    resetTextSessionState();
  }

  function startLiveCall(): void {
    if (!liveModeActive || !liveCallReady || liveRealtimeStatus === 'connecting' || liveRealtimeStatus === 'connected') return;
    setLiveRealtimeStatus('connecting');
    setLiveRealtimeMessage('');
    setLiveStartSignal((value) => value + 1);
  }

  function stopLiveCall(): void {
    if (!liveModeActive || (liveRealtimeStatus !== 'connecting' && liveRealtimeStatus !== 'connected')) return;
    setLiveStopSignal((value) => value + 1);
    setLiveRealtimeStatus('closed');
    setLiveRealtimeMessage('');
  }

  return (
    <section className="page chat-page">
      <div className="chat-header">
        <div className="chat-session-title">{props.tr('Assistant Chat', '助手对话')}</div>
        <div className="chat-actions">
          <label
            className={`toggle-line chat-control chat-toggle live-mode-toggle ${liveModeActive ? 'active' : ''} ${liveModeToggleDisabled ? 'disabled' : ''}`}
            title={liveModeToggleTitle}
          >
            <input
              className="live-mode-switch-input"
              type="checkbox"
              checked={liveModeActive}
              disabled={liveModeToggleDisabled}
              onChange={(event) => void (event.target.checked ? startLiveMode() : stopLiveMode())}
            />
            <span className="live-mode-switch" aria-hidden="true">
              <span />
            </span>
            <span>{props.tr('Realtime', '实时模式')}</span>
          </label>
          <label
            className="toggle-line chat-control chat-toggle"
            title={
              props.personalKnowledgeDocCount > 0
                ? props.tr('Use your converted personal documents as extra context for this chat.', '在当前对话中使用已转换的个人文档作为额外上下文。')
                : props.tr('Add documents on the Knowledge page first.', '请先在知识库页面添加文档。')
            }
          >
            <input
              type="checkbox"
              checked={personalKnowledgeEnabled}
              disabled={runBusy || props.personalKnowledgeDocCount === 0}
              onChange={(event) => setUsePersonalKnowledgeBase(event.target.checked)}
            />
            <span>{props.tr('Personal KB', '个人知识库')}</span>
            <span className="soft-badge">{props.personalKnowledgeDocCount}</span>
          </label>
          <select value={props.executionMode} onChange={(e) => props.setExecutionMode(e.target.value as 'workspace' | 'sandbox')}>
            <option value="workspace">{props.tr('Workspace', '工作区')}</option>
            <option value="sandbox">{props.tr('Sandbox', '沙箱')}</option>
          </select>
          <select value={props.config.browserMode} onChange={(e) => void setBridgeMode(e.target.value as PublicAppConfig['browserMode'])}>
            <option value="embedded">{props.tr('Built-in browser', '内部浏览器')}</option>
            <option value="external">{props.tr('External browser', '外部浏览器')}</option>
          </select>
          <button
            className="ghost-button"
            onClick={() => {
              if (liveModeActive) void stopLiveMode();
              else resetTextSessionState();
            }}
          >
            {props.tr('New session', '新会话')}
          </button>
          <button className="ghost-button" onClick={() => void openWorkspaceDirectory()}>
            {props.tr('Open workspace', '打开工作区')}
          </button>
        </div>
      </div>
      {liveModeActive ? (
        <div className="chat-live-content">
          <LiveAgentPage
            tr={props.tr}
            config={props.config}
            embedded
            autoStart={liveAutoStart}
            startSignal={liveStartSignal}
            stopSignal={liveStopSignal}
            initialSessionId={liveSessionId || props.sessionId || ''}
            initialMessages={props.messages}
            hideHeader
            hideComposer
            outboundMessage={liveOutboundMessage}
            onOutboundMessageConsumed={(id) => {
              setLiveOutboundMessage((old) => old?.id === id ? null : old);
            }}
            onSessionRecordChange={(record) => {
              props.setSessionId(record.id);
              props.setMessages(record.messages);
              props.setLastUsage(record.lastUsage);
              props.setTotalUsage(record.totalUsage);
              void props.refreshSessions();
            }}
            onStatusChange={setLiveRealtimeStatus}
            onStatusMessageChange={setLiveRealtimeMessage}
            onClose={() => void stopLiveMode()}
          />
        </div>
      ) : (
      <div className={`chat-content-grid ${toolPanelCollapsed ? 'tool-panel-collapsed' : ''}`} ref={chatContentGridRef}>
        <div className="chat-messages">
          {visibleMessages.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">AI</div>
              <div className="empty-title">{props.tr('Start a local agent session', '开始一个本地智能体会话')}</div>
              <div className="empty-desc">{props.tr('Main chat only shows your messages and the final assistant replies. Tool calls and tool outputs now stream in the side panel.', '主聊天区仅展示你的消息和助手最终回复，工具调用与输出会显示在右侧面板。')}</div>
            </div>
          )}
          {visibleMessages.map((m, idx) => (
            <MessageBubble
              key={`${m.id ?? idx}-${idx}`}
              message={m}
              sessionId={props.sessionId}
              tr={props.tr}
              productName={props.config.branding.productName || 'Tasi Harness'}
            />
          ))}
          {runBusy && <div className="typing-indicator"><span /> <span /> <span /></div>}
          {followUpQuestions.length > 0 && !runBusy && (
            <div className="follow-up-panel">
              <div className="follow-up-label">{props.tr('Suggested next questions', '建议继续追问')}</div>
              <div className="follow-up-list">
                {followUpQuestions.map((question, index) => (
                  <button key={`${question}-${index}`} className="follow-up-chip" onClick={() => void submitMessage(question)}>
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className={`tool-panel ${toolPanelCollapsed ? 'collapsed' : ''}`}>
          {toolPanelCollapsed ? (
            <button
              className="tool-panel-expand-button"
              onClick={() => setToolPanelCollapsed(false)}
              title={props.tr('Expand side panel', '展开侧边栏')}
              aria-label={props.tr('Expand side panel', '展开侧边栏')}
            >
              <span>‹</span>
              <strong>{props.tr('Trace', '轨迹')}</strong>
            </button>
          ) : (
            <>
          <div className="tool-panel-header">
            <button
              className="tool-panel-collapse-button"
              onClick={() => setToolPanelCollapsed(true)}
              title={props.tr('Collapse side panel', '收起侧边栏')}
              aria-label={props.tr('Collapse side panel', '收起侧边栏')}
            >
              ›
            </button>
            <div className="tool-panel-tabs" role="tablist" aria-label={props.tr('Side panel', '侧边栏')}>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'tools' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'tools'}
                onClick={() => setToolPanelTab('tools')}
              >
                {props.tr('Tool Trace', '工具轨迹')}
                <span>{props.toolEvents.length}</span>
              </button>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'sources' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'sources'}
                onClick={() => setToolPanelTab('sources')}
              >
                {props.tr('Referenced Pages', '引用网页')}
                <span>{referencedPages.length}</span>
              </button>
            </div>
          </div>
          <div className="tool-panel-body" ref={toolPanelBodyRef}>
            {toolPanelTab === 'sources' ? (
              referencedPages.length === 0 ? (
                <div className="tool-empty">{props.tr('Referenced webpages from the latest answer will appear here.', '最新回复中的引用网页会显示在这里。')}</div>
              ) : (
                <div className="reference-panel">
                  <div className="reference-summary">
                    <strong>{props.tr(`Read ${referencedPages.length} webpages`, `已引用 ${referencedPages.length} 个网页`)}</strong>
                    <div className="reference-favicons">
                      {referencedPages.slice(0, 5).map((page) => (
                        <ReferenceFavicon key={page.href} page={page} compact />
                      ))}
                    </div>
                  </div>
                  {referencedPages.map((page) => (
                    <button key={`${page.label}-${page.href}`} className="reference-card" onClick={() => void window.tasiHarness.app.openExternalUrl(page.href, { system: true })}>
                      <div className="reference-card-top">
                        <span className="reference-index">{page.label}</span>
                        <ReferenceFavicon page={page} />
                        <strong>{page.host}</strong>
                      </div>
                      {page.excerpt && <p>{page.excerpt}</p>}
                      <span>{page.href}</span>
                    </button>
                  ))}
                </div>
              )
            ) : props.toolEvents.length === 0 ? (
              <div className="tool-empty">{props.tr('Tool requests and results will appear here in a separate scrollable pane.', '工具请求和结果会显示在这里。')}</div>
            ) : (
              props.toolEvents.map((event) => (
                <ToolEventCard key={event.id} event={event} sessionId={props.sessionId} tr={props.tr} />
              ))
            )}
          </div>
          {false && (
            <div className="tool-web-preview tool-web-preview-external">
              <div className="tool-web-preview-head">
                <strong>{props.tr('External Browser', '外部浏览器')}</strong>
              </div>
              <div className="tool-web-preview-toolbar">
                <input
                  className="tool-web-preview-address"
                  value={previewUrl ?? ''}
                  readOnly
                  placeholder={props.tr('Waiting for a browsable page URL...', '等待可打开的网页地址...')}
                />
                <button className="mini-button tool-web-preview-open" onClick={() => void window.tasiHarness.app.openExternalUrl(previewUrl ?? '')} disabled={!previewUrl}>
                  {props.tr('Open', '打开')}
                </button>
              </div>
              <div className="tool-web-preview-empty">
                {previewUrl
                  ? props.tr(
                      'The latest browsable page has been detected. If your system browser did not appear automatically, use Open to launch it again.',
                      '已经识别到最新网页地址；如果系统浏览器没有自动弹出，可以点上面的“打开”重新拉起。'
                    )
                  : props.tr(
                      'External browser mode is active. A manual open button will appear here after the agent reaches a webpage.',
                      '当前使用外部浏览器模式。等智能体拿到网页地址后，这里会出现可手动打开的入口。'
                    )}
              </div>
            </div>
          )}
          {showEmbeddedWebPreview && (
            <div
              className={`tool-web-preview ${shouldShowWebPreview ? '' : 'hidden'} ${webPreviewExpanded ? 'expanded' : ''}`}
              style={webPreviewExpanded && webPreviewRect ? { left: webPreviewRect.x, top: webPreviewRect.y, width: webPreviewRect.width, height: webPreviewRect.height } : undefined}
            >
              <div className={`tool-web-preview-head ${webPreviewExpanded ? 'draggable' : ''}`} onMouseDown={handlePreviewDragStart}>
                <strong>{props.tr('Web Preview', '网页预览')}</strong>
                {shouldShowWebPreview && (
                  <button className="mini-button" onClick={toggleWebPreviewExpanded}>
                    {webPreviewExpanded ? props.tr('Collapse', '收起') : props.tr('Pop out', '弹出')}
                  </button>
                )}
              </div>
              <div className="tool-web-preview-toolbar">
                <button className="mini-button" onClick={handlePreviewBack} disabled={!previewCanGoBack} title={props.tr('Back', '后退')}>
                  Back
                </button>
                <button className="mini-button" onClick={handlePreviewForward} disabled={!previewCanGoForward} title={props.tr('Forward', '前进')}>
                  Forward
                </button>
                <button className="mini-button" onClick={handlePreviewRefresh} title={props.tr('Refresh', '刷新')}>
                  {previewLoading ? '...' : 'Refresh'}
                </button>
                <input
                  className="tool-web-preview-address"
                  value={previewAddress}
                  onChange={(event) => setPreviewAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void navigatePreviewToAddress();
                    }
                  }}
                  placeholder={props.tr('Enter URL and press Enter', '输入网址后按回车')}
                />
                <a className="mini-button tool-web-preview-open" href={previewAddress || previewUrl || 'about:blank'} target="_blank" rel="noreferrer">
                  {props.tr('Open', '打开')}
                </a>
              </div>
              <div className="tool-web-preview-body" ref={previewBodyRef}>
                <webview
                  ref={previewWebviewRef}
                  className="tool-web-preview-frame"
                  src={previewUrl || 'about:blank'}
                  partition={EMBEDDED_BROWSER_PARTITION}
                />
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {sessionDocError && <div className="error-box">{sessionDocError}</div>}
      {multimediaError && <div className="error-box">{multimediaError}</div>}
      <div className="chat-input-area">
        <div className="chat-input-main">
          <input
            ref={uploadSessionDocInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            accept=".docx,.pptx,.xlsx,.pdf,.ofd,.xml,.txt,.md,.markdown,.json,.csv,.log,.text"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length === 0) return;
              void uploadSessionDocuments(files);
            }}
          />
          <input
            ref={uploadMultimediaInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length === 0) return;
              void addMultimediaAttachments(files);
            }}
          />
          <div className="chat-session-doc-row">
            {visibleSessionDocs.map((doc) => (
              <span key={doc.id} className="chat-session-doc-chip" title={doc.filename}>
                <span className="chat-session-doc-name">{doc.filename}</span>
                <span className="chat-session-doc-meta">{props.tr(`${doc.commentCount} comments`, `${doc.commentCount} comments`)}</span>
                <button
                  className="chat-session-doc-remove"
                  onClick={() => void removeSessionDocument(doc.id)}
                  disabled={sessionDocBusy}
                  title={props.tr('Remove document', 'Remove document')}
                  aria-label={props.tr('Remove document', 'Remove document')}
                >
                  x
                </button>
              </span>
            ))}
            {hiddenSessionDocCount > 0 && (
              <span className="chat-overflow-chip" title={props.tr('Older WeChat documents are still stored in this session.', '较早的微信文档仍保存在当前 session 中。')}>
                {props.tr(`+${hiddenSessionDocCount} more docs`, `还有 ${hiddenSessionDocCount} 个文档`)}
              </span>
            )}
          </div>
          {(multimediaAttachments.length > 0 || visibleWechatSessionAttachments.length > 0) && (
            <div className="chat-media-row">
              {multimediaAttachments.map((attachment) => (
                <span key={attachment.id} className={`chat-media-chip ${attachment.kind}`} title={attachment.filename}>
                  <span className="chat-media-kind">{attachment.kind}</span>
                  <span className="chat-media-name">{attachment.filename}</span>
                  <span className="chat-media-size">{formatBytes(attachment.sizeBytes)}</span>
                  <button
                    className="chat-session-doc-remove"
                    onClick={() => removeMultimediaAttachment(attachment.id)}
                    disabled={!liveModeActive && runBusy}
                    title={props.tr('Remove media', '移除多媒体')}
                    aria-label={props.tr('Remove media', '移除多媒体')}
                  >
                    x
                  </button>
                </span>
              ))}
              {visibleWechatSessionAttachments.map((attachment, index) => (
                <span
                  key={`wechat-${attachment.id ?? `${attachment.filename}-${index}`}`}
                  className={`chat-media-chip ${attachment.kind} readonly`}
                  title={attachment.filename}
                >
                  <span className="chat-media-kind">{attachment.kind}</span>
                  <span className="chat-media-name">{attachment.filename}</span>
                  <span className="chat-media-size">{formatBytes(attachment.sizeBytes)}</span>
                  <span className="chat-media-source">{props.tr('WeChat', '微信')}</span>
                </span>
              ))}
              {hiddenWechatAttachmentCount > 0 && (
                <span className="chat-overflow-chip" title={props.tr('Older WeChat media is still stored in this session.', '较早的微信媒体仍保存在当前 session 中。')}>
                  {props.tr(`+${hiddenWechatAttachmentCount} more media`, `还有 ${hiddenWechatAttachmentCount} 个媒体`)}
                </span>
              )}
            </div>
          )}
          <div className={`chat-textarea-wrap ${liveModeActive ? 'has-phone' : ''}`}>
            <textarea
              className="chat-textarea"
              placeholder={liveModeActive
                ? liveRealtimeStatus === 'error'
                  ? liveRealtimeMessage || props.tr('Realtime call failed. Hang up and try again.', '实时通话连接失败，请挂断后重试。')
                  : liveRealtimeStatus === 'closed'
                  ? liveRealtimeMessage && !/stopped/i.test(liveRealtimeMessage)
                    ? liveRealtimeMessage
                    : props.tr('Click the phone button to reconnect realtime call.', '点击电话按钮重新接通实时通话。')
                  : liveInputReady
                  ? props.tr('Realtime call is active. Speak, type, or attach files/images.', '实时通话中。可以说话、打字，也可以上传文件/图片。')
                  : liveRealtimeStatus === 'connecting'
                  ? props.tr('Connecting realtime call...', '实时通话连接中...')
                  : props.tr('Click the phone button to connect realtime call.', '点击电话按钮接通实时通话。')
                : connected
                ? props.tr(
                  `Message ${props.config.branding.productName || 'Tasi Harness'}. Enter sends, Shift+Enter line break.`,
                  `发送给 ${props.config.branding.productName || 'Tasi Harness'}，回车发送，Shift+Enter 换行。`
                )
                : props.tr('Configure your provider in Settings first.', '请先在设置中配置模型提供方。')}
              value={input}
              disabled={liveModeActive ? !liveInputReady : runBusy || !connected}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="chat-attach-toolbar">
              <button
                className="chat-attach-button"
                onClick={openSessionDocumentPicker}
                disabled={liveModeActive ? !liveInputReady || sessionDocBusy : runBusy || sessionDocBusy || !connected}
                title={sessionDocBusy ? props.tr('Uploading...', 'Uploading...') : props.tr('Upload document', 'Upload document')}
                aria-label={sessionDocBusy ? props.tr('Uploading...', 'Uploading...') : props.tr('Upload document', 'Upload document')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M21 11.5 12.2 20.3a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 0 1-2.8-2.8l8.4-8.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="chat-attach-button chat-media-button"
                onClick={openMultimediaPicker}
                disabled={liveModeActive ? !liveInputReady : runBusy || !connected}
                title={props.tr('Upload image, video, or audio', '上传图片、视频或音频')}
                aria-label={props.tr('Upload image, video, or audio', '上传图片、视频或音频')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="4" y="5" width="16" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="m7 15 3-3 2.4 2.4L14.5 12 18 15.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
                </svg>
              </button>
            </div>
            <button
              className={`send-btn${runBusy ? ' stop' : ''}`}
              disabled={liveModeActive
                ? !liveInputReady || (!input.trim() && multimediaAttachments.length === 0 && activeSessionDocs.length === 0)
                : (runBusy ? props.stopping : (!input.trim() && multimediaAttachments.length === 0) || !connected)}
              title={runBusy ? props.tr('Stop current session', '停止当前会话') : props.tr('Send message', '发送消息')}
              onClick={() => {
                if (runBusy) {
                  void stopCurrentSession();
                  return;
                }
                void send();
              }}
            >
              {runBusy ? (
                props.stopping ? '...' : <span className="send-stop-icon" aria-hidden="true" />
              ) : (
                <svg className="send-arrow-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m6 11 6-6 6 6" />
                </svg>
              )}
            </button>
            {liveModeActive && (
              <button
                className={`phone-btn ${liveRealtimeStatus === 'connected' || liveRealtimeStatus === 'connecting' ? 'active' : ''}`}
                title={livePhoneTitle}
                aria-label={livePhoneTitle}
                disabled={!liveCallReady}
                onClick={() => {
                  if (liveRealtimeStatus === 'connected' || liveRealtimeStatus === 'connecting') stopLiveCall();
                  else startLiveCall();
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7.5 4.5 10 9l-2 1.5c1.1 2.3 2.7 3.9 5 5l1.5-2 4.5 2.5c.6.3.9 1 .7 1.7-.5 1.7-1.8 2.8-3.5 2.8C9.2 20.5 3.5 14.8 3.5 7.8c0-1.7 1.1-3 2.8-3.5.7-.2 1.4.1 1.7.7Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function renderMarkdownContent(content: string, keyPrefix: string): ReactElement {
  const normalized = normalizeMarkdownForRender(content);
  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    void window.tasiHarness.app.openExternalUrl(href, { system: true });
  };
  return (
    <div
      key={`${keyPrefix}-md`}
      className="msg-markdown"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(normalized) }}
    />
  );
}

function ToolEventCardComponent({ event, sessionId, tr }: { event: ToolEvent; sessionId?: string; tr: TranslateFn }): ReactElement {
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [fullArgs, setFullArgs] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const content = fullContent ?? event.content;
  const args = fullArgs ?? event.args;
  const argsPreview = useMemo(() => JSON.stringify(args, null, 2), [args]);
  const canLoadFull = Boolean(sessionId && event.id && (event.contentOmitted || event.argsOmitted) && fullContent === null);

  async function loadFull(): Promise<void> {
    if (!sessionId || !event.id || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await window.tasiHarness.sessions.readToolEventContent({ sessionId, toolEventId: event.id });
      setFullContent(result.content);
      setFullArgs(result.args);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`tool-event-card ${event.ok ? 'ok' : 'fail'}`}>
      <div className="tool-event-top">
        <strong>{event.toolName}</strong>
        <span>{prettyDate(event.createdAt)}</span>
      </div>
      <pre className="code-block small">{argsPreview}</pre>
      <pre className="code-block small">{content}</pre>
      {canLoadFull && (
        <button className="mini-button" disabled={loading} onClick={() => void loadFull()}>
          {loading ? '...' : tr('Load full tool output', '加载完整工具输出')}
        </button>
      )}
      {error && <div className="error-box">{error}</div>}
    </div>
  );
}

const ToolEventCard = memo(ToolEventCardComponent);

function reasoningItems(content: string, parts?: string[]): string[] {
  const explicitParts = parts?.map((part) => part.trim()).filter(Boolean) ?? [];
  if (explicitParts.length > 0) return explicitParts;
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const lineItems = normalized
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter(Boolean);
  if (lineItems.length > 1) return lineItems;

  const sentenceItems = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
  return sentenceItems.length > 0 ? sentenceItems : [normalized];
}

function ReasoningListComponent({ content, parts, tr }: { content: string; parts?: string[]; tr: TranslateFn }): ReactElement | null {
  const listRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => reasoningItems(content, parts), [content, parts]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [content, parts, items.length]);
  if (items.length === 0) return null;
  return (
    <div className="msg-reasoning">
      <div className="msg-reasoning-title">{tr('Reasoning', '推理过程')}</div>
      <div className="msg-reasoning-list" ref={listRef}>
        {items.map((item, index) => (
          <details key={`${index}-${item.slice(0, 24)}`} className="msg-reasoning-item" open>
            <summary>{tr(`Step ${index + 1}`, `第 ${index + 1} 条`)}</summary>
            <div className="msg-reasoning-item-body">{item}</div>
          </details>
        ))}
      </div>
    </div>
  );
}

const ReasoningList = memo(ReasoningListComponent);

function CitationLinkStripComponent({ citations }: { citations: CitationLink[] }): ReactElement | null {
  if (citations.length === 0) return null;
  return (
    <div className="msg-citation-strip" aria-label="Referenced webpages">
      {citations.map((citation) => (
        <button
          key={`${citation.label}-${citation.href}`}
          className="msg-citation-chip"
          title={[`${citation.label}. ${citation.host}`, citation.excerpt].filter(Boolean).join(' - ')}
          aria-label={[`${citation.label}. ${citation.host}`, citation.excerpt].filter(Boolean).join(' - ')}
          onClick={() => void window.tasiHarness.app.openExternalUrl(citation.href, { system: true })}
        >
          <span className="msg-citation-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
              <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
            </svg>
          </span>
          <span>{citation.label}</span>
          <span className="msg-citation-host">{citation.host}</span>
        </button>
      ))}
    </div>
  );
}

const CitationLinkStrip = memo(CitationLinkStripComponent);

function faviconCandidates(page: CitationLink): string[] {
  const candidates: string[] = [];
  try {
    const url = new URL(page.href);
    candidates.push(`${url.origin}/favicon.ico`);
    candidates.push(`https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(page.href)}&sz=32`);
  } catch {
    // Fall back to host-based services below.
  }
  if (page.host) {
    candidates.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(page.host)}&sz=32`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(page.host)}.ico`);
  }
  return [...new Set(candidates)];
}

function ReferenceFaviconComponent({ page, compact = false }: { page: CitationLink; compact?: boolean }): ReactElement {
  const candidates = useMemo(() => faviconCandidates(page), [page]);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  const fallbackText = (page.host || page.label || '?').replace(/^www\./, '').slice(0, 1).toUpperCase();

  useEffect(() => {
    setIndex(0);
  }, [page.href]);

  if (!src) {
    return <span className={`reference-favicon-fallback ${compact ? 'compact' : ''}`}>{fallbackText}</span>;
  }

  return (
    <img
      className="reference-favicon"
      src={src}
      alt=""
      onError={() => setIndex((old) => old + 1)}
    />
  );
}

const ReferenceFavicon = memo(ReferenceFaviconComponent);

function assistantExportTitle(content: string): string {
  const lines = normalizeMarkdownForRender(content).split('\n');
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line.trim()))?.replace(/^#{1,6}\s+/, '').trim();
  if (heading) return heading.slice(0, 80);
  const firstText = lines.find((line) => line.trim() && !/^```/.test(line.trim()))?.trim() ?? 'Assistant Reply';
  return firstText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1').slice(0, 80);
}

function LegacyMessageBubble({ message }: { message: AgentMessage }): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  return (
    <div className={`msg-row ${role}`}>
      <div className="msg-avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
      <div className="msg-bubble-wrap">
        <div className="msg-bubble">{renderMarkdownContent(message.content, `msg-${message.id ?? 'x'}`)}</div>
        <div className="msg-time">{prettyDate(message.createdAt)}</div>
      </div>
    </div>
  );
}

function MessageAttachmentsComponent({ attachments }: { attachments?: AgentMessageAttachment[] }): ReactElement | null {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="msg-attachment-list">
      {attachments.map((attachment, index) => (
        <div key={attachment.id ?? `${attachment.filename}-${index}`} className={`msg-attachment ${attachment.kind}`}>
          <span className="msg-attachment-kind">{attachment.kind}</span>
          <span className="msg-attachment-name">{attachment.filename}</span>
          <span className="msg-attachment-size">{formatBytes(attachment.sizeBytes)}</span>
        </div>
      ))}
    </div>
  );
}

const MessageAttachments = memo(MessageAttachmentsComponent);

function MessageBubbleComponent({ message, sessionId, tr, productName }: { message: AgentMessage; sessionId?: string; tr: TranslateFn; productName: string }): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  const isWechatPending = message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER;
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [fullReasoning, setFullReasoning] = useState<string | undefined>();
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState('');
  const content = fullContent ?? message.content;
  const reasoningContent = fullReasoning ?? message.reasoning_content;
  const citations = useMemo(() => (message.role === 'assistant' ? extractCitationLinks(content) : []), [message.role, content]);
  const renderedMarkdown = useMemo(
    () => (content.trim() ? renderMarkdownContent(content, `msg-${message.id ?? 'x'}`) : null),
    [content, message.id]
  );
  const [copied, setCopied] = useState(false);
  const [exportBusy, setExportBusy] = useState<'pdf' | 'docx' | null>(null);
  const canLoadFull = Boolean(sessionId && message.id && message.contentOmitted && fullContent === null);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function handleCopy(): Promise<void> {
    try {
      await copyTextToClipboard(content || '');
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function loadFullContent(): Promise<void> {
    if (!sessionId || !message.id || loadingFull) return;
    setLoadingFull(true);
    setLoadError('');
    try {
      const result = await window.tasiHarness.sessions.readMessageContent({ sessionId, messageId: message.id });
      setFullContent(result.content);
      setFullReasoning(result.reasoning_content);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingFull(false);
    }
  }

  async function handleExport(format: 'pdf' | 'docx'): Promise<void> {
    if (message.role !== 'assistant' || exportBusy) return;
    const exportAssistantMessage = window.tasiHarness.app.exportAssistantMessage;
    if (typeof exportAssistantMessage !== 'function') {
      window.alert(tr(
        `Export is not available in this window yet. Please restart ${productName} once so the updated preload API is loaded.`,
        `当前窗口尚未加载导出接口。请重启一次 ${productName}，让新的 preload API 生效。`
      ));
      return;
    }
    setExportBusy(format);
    try {
      const normalized = normalizeMarkdownForRender(content);
      const html = renderMarkdownToHtml(normalized);
      const result = await exportAssistantMessage({
        format,
        title: assistantExportTitle(content),
        content: normalized,
        html
      });
      if (!result.ok) window.alert(result.content);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setExportBusy(null);
    }
  }

  return (
    <div className={`msg-row ${role}`}>
      <div className="msg-avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
      <div className="msg-bubble-wrap">
        <div className="msg-bubble">
          {isWechatPending ? (
            <div>
              <div className="card-subtle">{tr('WeChat message is being processed...', '微信消息处理中...')}</div>
              <div className="typing-indicator"><span /> <span /> <span /></div>
            </div>
          ) : (
            <>
              <CitationLinkStrip citations={citations} />
              <MessageAttachments attachments={message.attachments} />
              {message.role === 'assistant' && reasoningContent?.trim()
                ? <ReasoningList content={reasoningContent} parts={message.reasoning_parts} tr={tr} />
                : null}
              {renderedMarkdown}
              {canLoadFull && (
                <button className="mini-button" disabled={loadingFull} onClick={() => void loadFullContent()}>
                  {loadingFull ? '...' : tr('Load full message', '加载完整消息')}
                </button>
              )}
              {loadError && <div className="error-box">{loadError}</div>}
              <div className="msg-bubble-actions">
                {message.role === 'assistant' && (
                  <>
                    <button
                      className="msg-export-button"
                      onClick={() => void handleExport('pdf')}
                      disabled={exportBusy != null}
                      title={tr('Export as PDF', '导出为 PDF')}
                      aria-label={tr('Export as PDF', '导出为 PDF')}
                    >
                      {exportBusy === 'pdf' ? '...' : 'P'}
                    </button>
                    <button
                      className="msg-export-button"
                      onClick={() => void handleExport('docx')}
                      disabled={exportBusy != null}
                      title={tr('Export as Word', '导出为 Word')}
                      aria-label={tr('Export as Word', '导出为 Word')}
                    >
                      {exportBusy === 'docx' ? '...' : 'W'}
                    </button>
                  </>
                )}
                <button
                  className={`msg-icon-button ${copied ? 'copied' : ''}`}
                  onClick={() => void handleCopy()}
                  title={copied ? tr('Copied', '已复制') : tr('Copy message', '复制消息')}
                  aria-label={copied ? tr('Copied', '已复制') : tr('Copy message', '复制消息')}
                >
                  {copied ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12.5 9.2 16.7 19 7.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="9" y="9" width="10" height="10" rx="2" />
                      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                    </svg>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
        <div className="msg-time">{prettyDate(message.createdAt)}</div>
      </div>
    </div>
  );
}

const MessageBubble = memo(MessageBubbleComponent);

const MEMORY_DOMAINS: Array<{ value: MemoryDomain; labelEn: string; labelZh: string }> = [
  { value: 'finance', labelEn: 'Finance', labelZh: '财经' },
  { value: 'daily_life', labelEn: 'Daily Life', labelZh: '日常' },
  { value: 'work', labelEn: 'Work', labelZh: '工作' },
  { value: 'travel', labelEn: 'Travel', labelZh: '旅行' },
  { value: 'reading', labelEn: 'Reading', labelZh: '阅读' },
  { value: 'education', labelEn: 'Education', labelZh: '教育' },
  { value: 'health', labelEn: 'Health', labelZh: '健康' },
  { value: 'other', labelEn: 'Other', labelZh: '其他' }
];

function knownMemoryDomain(value?: string): MemoryDomain {
  return MEMORY_DOMAINS.some((item) => item.value === value) ? (value as MemoryDomain) : 'other';
}

function KnowledgePage(props: { tr: TranslateFn; knowledge: PersonalKnowledgeState; refreshKnowledge: () => Promise<void> }): ReactElement {
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [folderImportBusy, setFolderImportBusy] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function openStoredPath(path: string): Promise<void> {
    try {
      setError('');
      const result = await window.tasiHarness.app.openPath(path);
      if (!result.ok) {
        setError(result.content || props.tr('Failed to open the selected file.', '打开所选文件失败。'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function addDocument(): Promise<void> {
    if (!uploadFile) {
      setError(props.tr('Choose a document first.', '请先选择一个文档。'));
      return;
    }
    setUploadBusy(true);
    setError('');
    setNotice('');
    try {
      const contentBase64 = await fileToBase64(uploadFile);
      const doc = await window.tasiHarness.knowledge.addDocument({
        filename: uploadFile.name,
        contentBase64
      });
      setNotice(props.tr(`Added ${doc.filename} to your personal knowledge base.`, `已将 ${doc.filename} 添加到个人知识库。`));
      setUploadFile(null);
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploadBusy(false);
    }
  }

  async function addFolder(): Promise<void> {
    setFolderImportBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.tasiHarness.knowledge.addFolder();
      if (!result.folderPath) {
        setNotice(props.tr('Folder import canceled.', '已取消文件夹导入。'));
        return;
      }
      const failedCount = result.failed.length;
      setNotice(
        props.tr(
          `Folder import complete: ${result.imported} imported, ${result.skipped} skipped, ${failedCount} failed (scanned ${result.discovered} files).`,
          `文件夹导入完成：成功 ${result.imported}，跳过 ${result.skipped}，失败 ${failedCount}（共扫描 ${result.discovered} 个文件）。`
        )
      );
      if (failedCount > 0) {
        const preview = result.failed
          .slice(0, 5)
          .map((item) => `- ${item.filePath}: ${item.error}`)
          .join('\n');
        const rest = failedCount > 5 ? props.tr(`\n...and ${failedCount - 5} more failures.`, `\n...以及另外 ${failedCount - 5} 个失败项。`) : '';
        setError(props.tr(`Some files failed to import:\n${preview}${rest}`, `部分文件导入失败：\n${preview}${rest}`));
      }
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderImportBusy(false);
    }
  }

  async function deleteDocument(doc: PersonalKnowledgeDocument): Promise<void> {
    const confirmed = globalThis.confirm(
      props.tr(
        `Delete ${doc.filename} and its generated markdown from your personal knowledge base?`,
        `确认从个人知识库删除 ${doc.filename} 及其生成的 Markdown 吗？`
      )
    );
    if (!confirmed) return;
    setDeletingDocId(doc.id);
    setError('');
    setNotice('');
    try {
      const removed = await window.tasiHarness.knowledge.deleteDocument(doc.id);
      if (!removed) throw new Error(props.tr('The document no longer exists.', '该文档已不存在。'));
      setNotice(props.tr(`Removed ${doc.filename}.`, `已删除 ${doc.filename}。`));
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingDocId(null);
    }
  }

  return (
    <section className="page">
      <PageHeader
        title={props.tr('Personal Knowledge', '个人知识库')}
        subtitle={props.tr(
          'Convert local Office and text documents into Markdown, store them locally, and optionally inject relevant excerpts into chat.',
          '将本地 Office 和文本文件转换成 Markdown，本地保存，并可在对话时按需注入相关片段。'
        )}
        action={<button className="mini-button" onClick={() => void props.refreshKnowledge()}>{props.tr('Refresh', '刷新')}</button>}
      />
      <div className="split-grid knowledge-layout">
        <div className="card">
          <h2>{props.tr('Add Document', '添加文档')}</h2>
          <p>{props.tr('Supported formats: Markdown, TXT, JSON, CSV, DOCX, XLSX, PPTX, PDF, OFD.', '支持格式：Markdown、TXT、JSON、CSV、DOCX、XLSX、PPTX、PDF、OFD。')}</p>
          <label>{props.tr('Source document', '源文档')}</label>
          <input
            type="file"
            accept=".md,.markdown,.txt,.text,.log,.json,.csv,.docx,.xlsx,.pptx,.pdf,.ofd"
            disabled={uploadBusy || folderImportBusy}
            onChange={(event) => {
              setUploadFile(event.target.files?.[0] ?? null);
              setError('');
            }}
          />
          {uploadFile && (
            <div className="meta-row wrap upload-file-row">
              <span className="soft-badge">{props.tr('File', '文件')}: {uploadFile.name}</span>
              <span className="soft-badge">{props.tr('Size', '大小')}: {(uploadFile.size / 1024).toFixed(1)} KB</span>
            </div>
          )}
          <div className="button-row">
            <button className="primary-button" disabled={!uploadFile || uploadBusy || folderImportBusy} onClick={() => void addDocument()}>
              {uploadBusy ? '...' : props.tr('Add to Knowledge Base', '加入知识库')}
            </button>
            <button className="ghost-button" disabled={uploadBusy || folderImportBusy} onClick={() => void addFolder()}>
              {folderImportBusy ? '...' : props.tr('Import Folder', '导入文件夹')}
            </button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
          {error && <div className="error-box knowledge-error">{error}</div>}
        </div>
        <div className="card">
          <h2>{props.tr('Overview', '概览')}</h2>
          <p>{props.tr('Each document is converted into Markdown and chunked for lexical retrieval. Chat can then pull the most relevant excerpts when the toggle is enabled.', '每个文档会被转换成 Markdown 并切分为检索片段；在聊天中打开开关后，会自动拉取最相关的片段。')}</p>
          <div className="knowledge-stats">
            <span className="soft-badge">{props.tr('Documents', '文档')}: {props.knowledge.totalDocs}</span>
            <span className="soft-badge">{props.tr('Chunks', '分块')}: {props.knowledge.totalChunks}</span>
            <span className="soft-badge">{props.tr('Chars', '字符')}: {props.knowledge.totalChars}</span>
          </div>
        </div>
      </div>
      <div className="card knowledge-library">
        <div className="marketplace-card-top">
          <div>
            <h2>{props.tr('Document Library', '文档列表')}</h2>
            <div className="card-subtle">{props.tr('Open the generated Markdown or delete documents you no longer want to use.', '可以打开生成后的 Markdown，也可以删除不再需要的文档。')}</div>
          </div>
        </div>
        <div className="marketplace-list knowledge-list">
          {props.knowledge.docs.map((doc) => (
            <div key={doc.id} className="marketplace-card">
              <div className="marketplace-card-top">
                <div>
                  <strong>{doc.title}</strong>
                  <div className="card-subtle">{doc.filename}</div>
                </div>
                <div className="button-row compact knowledge-actions">
                  <button className="ghost-button" onClick={() => void openStoredPath(doc.markdownPath)}>
                    {props.tr('Open Markdown', '打开 Markdown')}
                  </button>
                  <button className="ghost-button" onClick={() => void openStoredPath(doc.sourcePath)}>
                    {props.tr('Open Source', '打开源文件')}
                  </button>
                  <button className="danger-button" disabled={deletingDocId === doc.id} onClick={() => void deleteDocument(doc)}>
                    {deletingDocId === doc.id ? '...' : props.tr('Delete', '删除')}
                  </button>
                </div>
              </div>
              <p className="knowledge-card-text">{doc.excerpt || props.tr('No excerpt available.', '暂无摘要。')}</p>
              <div className="meta-row wrap">
                <span className="soft-badge">{props.tr('Chunks', '分块')}: {doc.chunkCount}</span>
                <span className="soft-badge">{props.tr('Chars', '字符')}: {doc.charCount}</span>
                <span className="soft-badge">{props.tr('Updated', '更新时间')}: {prettyDate(doc.updatedAt)}</span>
                {doc.imagesDir && <span className="soft-badge">{props.tr('Images extracted', '已提取图片')}</span>}
              </div>
            </div>
          ))}
          {props.knowledge.docs.length === 0 && (
            <div className="tool-empty">{props.tr('No personal knowledge documents yet.', '暂时还没有个人知识库文档。')}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function MemoryPage(props: { tr: TranslateFn; memory: MemoryState; sessionId?: string }): ReactElement {
  const [notice, setNotice] = useState('');
  const [searchIntent, setSearchIntent] = useState('');
  const [searchDomain, setSearchDomain] = useState<MemoryDomain | 'all'>('all');
  const [searchSessionId, setSearchSessionId] = useState(props.sessionId ?? '');
  const [activeCategory, setActiveCategory] = useState<MemoryDomain | 'all'>('all');
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<MemoryEntry | null>(null);
  const [retrieved, setRetrieved] = useState<MemoryState>({
    ...props.memory,
    entries: props.memory.entries.filter((entry) => entry.target === 'memory'),
    usage: props.memory.usage.filter((u) => u.target === 'memory')
  });

  useEffect(() => {
    setRetrieved({
      ...props.memory,
      entries: props.memory.entries.filter((entry) => entry.target === 'memory'),
      usage: props.memory.usage.filter((u) => u.target === 'memory')
    });
    if (props.sessionId && !searchSessionId) setSearchSessionId(props.sessionId);
  }, [props.memory, props.sessionId]);

  async function refreshRetrieved(): Promise<void> {
    const next = await window.tasiHarness.memory.get({
      target: 'memory',
      sessionId: searchSessionId.trim() || undefined,
      domain: searchDomain === 'all' ? undefined : searchDomain,
      intent: searchIntent.trim() || undefined,
      includeGlobal: true,
      limit: 200
    });
    setRetrieved({
      ...next,
      entries: next.entries.filter((entry) => entry.target === 'memory'),
      usage: next.usage.filter((u) => u.target === 'memory')
    });
  }

  async function retrieve(): Promise<void> {
    try {
      await refreshRetrieved();
      setNotice(props.tr('Memory retrieval updated.', '记忆检索已更新。'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const categorizedEntries = useMemo(() => {
    const byDomain = new Map<MemoryDomain, MemoryEntry[]>();
    for (const item of MEMORY_DOMAINS) byDomain.set(item.value, []);
    const allSorted = [...retrieved.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const entry of allSorted) {
      const domain = knownMemoryDomain(entry.domain);
      byDomain.get(domain)?.push(entry);
    }
    return { allSorted, byDomain };
  }, [retrieved.entries]);

  const categories = useMemo(
    () => [
      { value: 'all' as const, label: props.tr('All categories', '所有类别'), count: categorizedEntries.allSorted.length },
      ...MEMORY_DOMAINS.map((item) => ({
        value: item.value,
        label: props.tr(item.labelEn, item.labelZh),
        count: categorizedEntries.byDomain.get(item.value)?.length ?? 0
      }))
    ],
    [categorizedEntries, props.tr]
  );

  const visibleEntries = useMemo(() => {
    if (activeCategory === 'all') return categorizedEntries.allSorted;
    return categorizedEntries.byDomain.get(activeCategory) ?? [];
  }, [activeCategory, categorizedEntries]);

  useEffect(() => {
    if (activeEntryId && !visibleEntries.some((entry) => entry.id === activeEntryId)) {
      setActiveEntryId(null);
    }
    if (previewEntry && !retrieved.entries.some((entry) => entry.id === previewEntry.id)) {
      setPreviewEntry(null);
    }
  }, [visibleEntries, activeEntryId, previewEntry, retrieved.entries]);

  function entryTitle(content: string): string {
    const line = content.split('\n')[0]?.trim() ?? '';
    if (!line) return '(empty)';
    return line.length > 60 ? `${line.slice(0, 60)}...` : line;
  }

  return (
    <>
      <section className="page">
      <PageHeader title={props.tr('Memory', '记忆')} subtitle={props.tr('Display and retrieval only. Memory is committed after one chat run or one scheduled task run completes.', '仅展示和检索。Memory 会在一次对话或定时任务完成后统一存储。')} />
      <div className="split-grid memory-layout">
        <div className="card">
          <h2>{props.tr('Search Filters', '检索条件')}</h2>
          <label>{props.tr('Intent query', '意图查询')}</label>
          <input value={searchIntent} onChange={(e) => setSearchIntent(e.target.value)} placeholder={props.tr('e.g. stock analysis, study plan, health reminders', '比如：股票分析、学习计划、健康提醒')} />
          <label>{props.tr('Domain filter', '分类筛选')}</label>
          <select value={searchDomain} onChange={(e) => setSearchDomain(e.target.value as MemoryDomain | 'all')}>
            <option value="all">{props.tr('all domains', '全部分类')}</option>
            {MEMORY_DOMAINS.map((item) => (
              <option key={item.value} value={item.value}>{props.tr(item.labelEn, item.labelZh)}</option>
            ))}
          </select>
          <label>{props.tr('Session ID (optional)', '会话 ID（可选）')}</label>
          <input value={searchSessionId} onChange={(e) => setSearchSessionId(e.target.value)} placeholder={props.tr('limit retrieval to one session', '限定检索到某个会话')} />
          <div className="button-row">
            <button className="primary-button" onClick={() => void retrieve()}>{props.tr('Retrieve', '检索')}</button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
          <h2>{props.tr('Memory usage', '记忆用量')}</h2>
          {retrieved.usage.map((u) => (
            <div className="usage-row" key={u.target}>
              <span>{u.target}</span>
              <progress value={u.used} max={u.limit} />
              <span>{u.used}/{u.limit}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>{props.tr('Categories', '分类展示')}</h2>
          <div className="memory-browser">
            <div className="memory-category-list">
              {categories.map((category) => (
                <button
                  key={category.value}
                  className={`memory-category-item ${activeCategory === category.value ? 'active' : ''}`}
                  onClick={() => setActiveCategory(category.value)}
                >
                  <span>{category.label}</span>
                  <span>{category.count}</span>
                </button>
              ))}
            </div>
            <div className="memory-entry-list">
              {visibleEntries.length === 0 ? (
                <div className="tool-empty">{props.tr('No memory entries in this category.', '该分类下暂无条目。')}</div>
              ) : (
                visibleEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`memory-entry-item ${activeEntryId === entry.id ? 'active' : ''}`}
                    onClick={() => {
                      setActiveEntryId(entry.id);
                      setPreviewEntry(entry);
                    }}
                  >
                    <div className="memory-entry-title">{entryTitle(entry.content)}</div>
                    <div className="memory-entry-meta">{entry.scope === 'session' ? `session:${entry.sessionId ?? 'unknown'}` : 'global'}</div>
                  </button>
                ))
              )}
            </div>
          </div>
          {retrieved.entries.length === 0 && <div className="tool-empty">{props.tr('No memory entries matched this retrieval.', '没有匹配本次检索的记忆条目。')}</div>}
        </div>
      </div>
      </section>
      {previewEntry && (
        <div className="modal-backdrop" onClick={() => setPreviewEntry(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{props.tr('Memory Entry', '记忆条目')}</h2>
              <button className="ghost-button" onClick={() => setPreviewEntry(null)}>{props.tr('Close', '关闭')}</button>
            </div>
            <div className="meta-row wrap">
              <span className="soft-badge">{previewEntry.domain}</span>
              <span className="soft-badge">{previewEntry.scope === 'session' ? `session:${previewEntry.sessionId ?? 'unknown'}` : 'global'}</span>
              <span className="soft-badge">{prettyDate(previewEntry.updatedAt)}</span>
            </div>
            <pre className="code-block">{previewEntry.content}</pre>
          </div>
        </div>
      )}
    </>
  );
}
function createSkillTemplate(name: string, category: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: A reusable local workflow created from the desktop UI.`,
    `category: ${category}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Use this skill when the user asks for this workflow.',
    '',
    '## Steps',
    '',
    '1. Clarify inputs.',
    '2. Inspect relevant files.',
    '3. Apply the smallest safe change.',
    '4. Run tests and summarize results.',
    ''
  ].join('\n');
}

function slugifyUiName(name: string, fallback = 'my-workflow'): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (normalized) return normalized;
  let hash = 0;
  for (const char of name.trim()) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `${fallback}-${Math.abs(hash).toString(36).slice(0, 6)}`;
}

function normalizeSkillCategory(value: string, fallback = 'other'): string {
  const trimmed = value.trim();
  const alias = CATEGORY_ALIASES[trimmed] ?? CATEGORY_ALIASES[trimmed.toLowerCase()];
  return alias || slugifyUiName(trimmed, fallback);
}

function skillCategoryLabel(value: string, tr: TranslateFn): string {
  const option = SKILL_CATEGORIES.find((item) => item.value === value);
  return option ? tr(option.en, option.zh) : value;
}

function normalizeSkillContent(content: string, name: string, category: string, displayName?: string, displayCategory?: string): string {
  const safeName = name.trim() || 'my-workflow';
  const safeCategory = category.trim() || 'local';
  const trimmed = content.trim();
  const frontmatterMatch = trimmed.match(/^---\n([\s\S]*?)\n---\n?/);
  const displayLines = [
    ...(displayName?.trim() && displayName.trim() !== safeName ? [`display_name: ${displayName.trim().replace(/\n/g, ' ')}`] : []),
    ...(displayCategory?.trim() && displayCategory.trim() !== safeCategory ? [`display_category: ${displayCategory.trim().replace(/\n/g, ' ')}`] : [])
  ];
  if (frontmatterMatch) {
    const existingLines = frontmatterMatch[1]
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const keptLines = existingLines.filter((line) => {
      const key = line.split(':', 1)[0]?.trim().toLowerCase();
      return key !== 'name' && key !== 'category' && key !== 'display_name' && key !== 'display_category';
    });
    const hasDescription = keptLines.some((line) => line.split(':', 1)[0]?.trim().toLowerCase() === 'description');
    const body = trimmed.slice(frontmatterMatch[0].length).trim();
    const lines = ['---', `name: ${safeName}`];
    if (!hasDescription) lines.push(`description: Skill ${safeName}.`);
    lines.push(`category: ${safeCategory}`, ...displayLines, ...keptLines, '---', '', body, '');
    return lines.join('\n');
  }
  const body = trimmed || `# ${displayName?.trim() || safeName}\n\nDescribe what this skill does.`;
  return ['---', `name: ${safeName}`, `description: Skill ${safeName}.`, `category: ${safeCategory}`, ...displayLines, '---', '', body, ''].join('\n');
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

async function inspectSkillArchive(file: File): Promise<{ name?: string; category?: string }> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const skillEntry = entries.find((entry) => /(^|\/)SKILL\.md$/i.test(entry.name.replace(/\\/g, '/')));
  if (!skillEntry) throw new Error('Archive must include SKILL.md.');
  const frontmatter = parseSkillFrontmatter(await skillEntry.async('string'));
  return {
    name: frontmatter.name,
    category: frontmatter.category
  };
}

const emptyCoachRecording: BrowserCoachRecording = {
  id: '',
  startUrl: '',
  startedAt: '',
  active: false,
  events: []
};

function formatCoachEvent(event: BrowserCoachRecordedEvent): string {
  const target = event.name || event.text || event.selector || event.tag || '';
  const detail = event.value ? ` = ${event.value}` : event.key ? ` key=${event.key}` : '';
  return `${event.index}. ${event.type}${target ? ` | ${target}` : ''}${detail}`;
}

function reindexCoachEvents(events: BrowserCoachRecordedEvent[]): BrowserCoachRecordedEvent[] {
  return events.map((event, index) => ({ ...event, index: index + 1 }));
}

type CoachEventDraft = {
  type: BrowserCoachRecordedEvent['type'];
  url: string;
  title: string;
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  value: string;
  key: string;
};

function coachEventToDraft(event: BrowserCoachRecordedEvent): CoachEventDraft {
  return {
    type: event.type,
    url: event.url,
    title: event.title ?? '',
    selector: event.selector ?? '',
    tag: event.tag ?? '',
    role: event.role ?? '',
    name: event.name ?? '',
    text: event.text ?? '',
    value: event.value ?? '',
    key: event.key ?? ''
  };
}

function draftToCoachEvent(event: BrowserCoachRecordedEvent, draft: CoachEventDraft): BrowserCoachRecordedEvent {
  const optional = (value: string): string | undefined => value.trim() || undefined;
  return {
    ...event,
    type: draft.type,
    url: draft.url.trim() || event.url,
    title: optional(draft.title),
    selector: optional(draft.selector),
    tag: optional(draft.tag),
    role: optional(draft.role),
    name: optional(draft.name),
    text: optional(draft.text),
    value: optional(draft.value),
    key: optional(draft.key)
  };
}

function SkillsPage({
  tr,
  skills,
  sessions,
  refreshSkills,
  refreshSessions,
  optimizeBusy,
  onOptimizeSession
}: {
  tr: TranslateFn;
  skills: SkillMetadata[];
  sessions: SessionSummary[];
  refreshSkills: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  optimizeBusy: boolean;
  onOptimizeSession: (sessions: SessionSummary[], userGuidance?: string) => Promise<void>;
}): ReactElement {
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace' | 'upload' | 'coach' | 'optimize'>('installed');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [marketplace, setMarketplace] = useState<MarketplaceBrowseResult>({ sources: [], skills: [] });
  const [marketError, setMarketError] = useState('');
  const [marketActionKey, setMarketActionKey] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('uploaded-skill');
  const [uploadCategory, setUploadCategory] = useState('local');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadNotice, setUploadNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploadOverwrite, setUploadOverwrite] = useState(false);
  const [uploadPackageSkillName, setUploadPackageSkillName] = useState('');
  const [overwriteSelections, setOverwriteSelections] = useState<Record<string, boolean>>({});
  const [coachUrl, setCoachUrl] = useState('https://www.baidu.com');
  const [coachRecording, setCoachRecording] = useState<BrowserCoachRecording>(emptyCoachRecording);
  const [coachSkillName, setCoachSkillName] = useState('recorded-browser-workflow');
  const [coachCategory, setCoachCategory] = useState('browser');
  const [coachDescription, setCoachDescription] = useState('');
  const [coachUserGuidance, setCoachUserGuidance] = useState('');
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachNotice, setCoachNotice] = useState('');
  const [coachError, setCoachError] = useState('');
  const [coachTraceDirty, setCoachTraceDirty] = useState(false);
  const [coachEditingEventId, setCoachEditingEventId] = useState<string | null>(null);
  const [coachEventDraft, setCoachEventDraft] = useState<CoachEventDraft | null>(null);
  const [coachRecordingSource, setCoachRecordingSource] = useState<'live' | 'stored'>('live');
  const [coachStoredRecordings, setCoachStoredRecordings] = useState<BrowserCoachStoredRecording[]>([]);
  const [coachSelectedStoredSkill, setCoachSelectedStoredSkill] = useState('');
  const [coachStoredBusy, setCoachStoredBusy] = useState(false);
  const [optimizeSessionIds, setOptimizeSessionIds] = useState<string[]>([]);
  const [optimizeUserGuidance, setOptimizeUserGuidance] = useState('');
  const [optimizeError, setOptimizeError] = useState('');
  const [optimizeRefreshing, setOptimizeRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editorName, setEditorName] = useState('my-workflow');
  const [editorCategory, setEditorCategory] = useState('local');
  const [editorContent, setEditorContent] = useState(createSkillTemplate('my-workflow', 'local'));
  const [editorReadonly, setEditorReadonly] = useState(false);
  const [editorOriginalName, setEditorOriginalName] = useState<string | null>(null);
  const [editorOriginalContent, setEditorOriginalContent] = useState('');
  const [editorError, setEditorError] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const coachWasActiveRef = useRef(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 240);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    void window.tasiHarness.skills
      .browseMarketplace(debouncedQuery)
      .then((result) => {
        setMarketplace(result);
        setMarketError('');
      })
      .catch((error) => {
        setMarketplace({ sources: [], skills: [] });
        setMarketError(error instanceof Error ? error.message : String(error));
      });
  }, [debouncedQuery, skills, activeTab]);

  useEffect(() => {
    if (activeTab !== 'coach') return;
    let canceled = false;
    const refresh = () => {
      void window.tasiHarness.browserCoach.status()
        .then((recording) => {
          if (!canceled) {
            if (coachWasActiveRef.current && !recording.active && recording.events.length > 0) {
              void refreshCoachStoredRecordings();
            }
            coachWasActiveRef.current = recording.active;
            setCoachRecording((current) => {
              if ((coachRecordingSource === 'stored' || coachTraceDirty) && !recording.active) return current;
              return recording;
            });
          }
        })
        .catch((error) => {
          if (!canceled) setCoachError(error instanceof Error ? error.message : String(error));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 900);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [activeTab, coachRecordingSource, coachTraceDirty]);

  useEffect(() => {
    if (activeTab !== 'coach') return;
    void refreshCoachStoredRecordings();
  }, [activeTab]);

  const displayedCoachEvents = useMemo(() => coachRecording.events.slice(-120), [coachRecording.events]);

  useEffect(() => {
    setOptimizeSessionIds((current) => {
      const available = new Set(sessions.map((session) => session.id));
      const kept = current.filter((id) => available.has(id));
      if (kept.length > 0 || sessions.length === 0) return kept;
      return [sessions[0].id];
    });
  }, [sessions]);

  function closeEditor(): void {
    if (editorSaving) return;
    setEditorOpen(false);
    setEditorError('');
  }

  function openCreateEditor(): void {
    const initialName = 'my-workflow';
    setEditorMode('create');
    setEditorName(initialName);
    setEditorCategory('local');
    setEditorContent(createSkillTemplate(initialName, 'local'));
    setEditorReadonly(false);
    setEditorOriginalName(null);
    setEditorOriginalContent('');
    setEditorError('');
    setEditorOpen(true);
    setActiveTab('installed');
  }

  async function openInstalledSkill(name: string): Promise<void> {
    const doc = await window.tasiHarness.skills.read(name);
    if (!doc) {
      setNotice(`Unable to open ${name}.`);
      return;
    }
    setEditorMode('edit');
    setEditorName(doc.displayName || doc.name);
    setEditorCategory(doc.category);
    setEditorContent(doc.content);
    setEditorReadonly(doc.readonly);
    setEditorOriginalName(doc.name);
    setEditorOriginalContent(doc.content);
    setEditorError('');
    setEditorOpen(true);
    setActiveTab('installed');
  }

  async function refreshMarketplaceSnapshot(): Promise<void> {
    try {
      const latest = await window.tasiHarness.skills.browseMarketplace(debouncedQuery);
      setMarketplace(latest);
      setMarketError('');
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    }
  }

  function suggestSkillNameFromFilename(filename: string): string {
    const base = filename.replace(/\.[^./\\]+$/, '').toLowerCase();
    const normalized = base
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    return normalized || 'uploaded-skill';
  }

  function normalizeSkillNameForCompare(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function existingSkillForName(name: string): SkillMetadata | undefined {
    const target = normalizeSkillNameForCompare(name);
    if (!target) return undefined;
    return skills.find((skill) => normalizeSkillNameForCompare(skill.name) === target);
  }

  function existingSkillForDisplayName(name: string, fallback = 'my-workflow'): SkillMetadata | undefined {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    return existingSkillForName(slugifyUiName(trimmed, fallback));
  }

  function marketplaceExistingSkill(skill: MarketplaceSkill): SkillMetadata | undefined {
    return [skill.installedSkillName, skill.name, skill.id]
      .filter((name): name is string => Boolean(name?.trim()))
      .map((name) => existingSkillForName(name))
      .find((item): item is SkillMetadata => Boolean(item));
  }

  function overwriteSelected(key: string): boolean {
    return Boolean(overwriteSelections[key]);
  }

  function setOverwriteSelection(key: string, checked: boolean): void {
    setOverwriteSelections((old) => ({ ...old, [key]: checked }));
  }

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const data = result.split(',').at(1) ?? '';
        if (!data) reject(new Error('Failed to read file content.'));
        else resolve(data);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }

  async function inspectUploadPackage(file: File): Promise<void> {
    setUploadPackageSkillName('');
    try {
      const metadata = await inspectSkillArchive(file);
      if (metadata.name?.trim()) {
        setUploadName(metadata.name.trim());
        setUploadPackageSkillName(metadata.name.trim());
      }
      if (metadata.category?.trim()) setUploadCategory(normalizeSkillCategory(metadata.category.trim(), 'other'));
      setUploadOverwrite(false);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveEditor(): Promise<void> {
    const displayName = editorName.trim();
    const name = slugifyUiName(displayName, 'my-workflow');
    const category = normalizeSkillCategory(editorCategory, 'other');
    const displayCategory = skillCategoryLabel(category, tr);
    if (!displayName) {
      setEditorError('Skill name is required.');
      return;
    }
    if (!editorContent.trim()) {
      setEditorError('Skill content cannot be empty.');
      return;
    }
    const content = normalizeSkillContent(editorContent, name, category, displayName, displayCategory);
    setEditorSaving(true);
    setEditorError('');
    try {
      if (editorMode === 'create') {
        await window.tasiHarness.skills.create({ name, category, content, displayName, displayCategory });
        setNotice(`Created ${displayName}.`);
      } else {
        if (editorReadonly) throw new Error('This skill is read-only and cannot be edited.');
        if (!editorOriginalName) throw new Error('Missing original skill name.');
        if (name === editorOriginalName) {
          await window.tasiHarness.skills.patch({
            name: editorOriginalName,
            oldString: editorOriginalContent,
            newString: content
          });
          setNotice(`Saved ${name}.`);
        } else {
          await window.tasiHarness.skills.create({ name, category, content, displayName, displayCategory });
          const removed = await window.tasiHarness.skills.delete(editorOriginalName);
          if (!removed) throw new Error(`Renamed ${name}, but failed to remove old skill ${editorOriginalName}.`);
          setNotice(`Renamed ${editorOriginalName} to ${name}.`);
        }
      }
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      setEditorOpen(false);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorSaving(false);
    }
  }

  async function install(skill: MarketplaceSkill): Promise<void> {
    const { sourceId, id: skillId } = skill;
    const actionKey = `install:${sourceId}:${skillId}`;
    const existing = marketplaceExistingSkill(skill);
    const overwrite = existing ? overwriteSelected(actionKey) : false;
    if (existing && !overwrite) {
      setMarketError(tr(
        `Skill ${existing.name} already exists. Check "Overwrite existing skill" to replace it.`,
        `技能 ${existing.name} 已存在。勾选“覆盖现有技能”后才会替换。`
      ));
      return;
    }
    setMarketActionKey(actionKey);
    setMarketError('');
    try {
      const installed = await window.tasiHarness.skills.installFromMarketplace({
        sourceId,
        skillId,
        skill: {
          id: skill.id,
          sourceId: skill.sourceId,
          sourceName: skill.sourceName,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          version: skill.version,
          readme: skill.readme,
          skillContent: skill.skillContent,
          supportingFiles: skill.supportingFiles,
          homepage: skill.homepage,
          remoteVersionId: skill.remoteVersionId,
          installCommand: skill.installCommand
        },
        overwrite
      });
      setNotice(`Marketplace skill installed: ${installed.installedSkillName ?? installed.name}.`);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      await openInstalledSkill(installed.installedSkillName ?? installed.name);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketActionKey(null);
    }
  }

  async function uninstall(name: string): Promise<void> {
    if (!name) return;
    const actionKey = `uninstall:${name}`;
    setMarketActionKey(actionKey);
    setMarketError('');
    try {
      await window.tasiHarness.skills.uninstallMarketplaceSkill(name);
      setNotice(`Removed ${name}.`);
      if (editorOpen && editorOriginalName === name) setEditorOpen(false);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketActionKey(null);
    }
  }

  async function uploadArchive(): Promise<void> {
    setUploadError('');
    setUploadNotice('');
    if (!uploadFile) {
      setUploadError('Please choose a ZIP package first.');
      return;
    }
    const uploadDisplayName = uploadName.trim();
    const skillName = slugifyUiName(uploadDisplayName, 'uploaded-skill');
    const skillCategory = normalizeSkillCategory(uploadCategory, 'other');
    const displayCategory = skillCategoryLabel(skillCategory, tr);
    if (!uploadDisplayName) {
      setUploadError('Please fill in a skill name.');
      return;
    }
    const existing = existingSkillForName(skillName);
    const overwrite = existing ? uploadOverwrite : false;
    if (existing && !overwrite) {
      setUploadError(tr(
        `Skill ${existing.name} already exists. Check "Overwrite existing skill" to replace it.`,
        `技能 ${existing.name} 已存在。勾选“覆盖现有技能”后才会替换。`
      ));
      return;
    }
    setUploadBusy(true);
    try {
      const contentBase64 = await fileToBase64(uploadFile);
      const created = await window.tasiHarness.skills.uploadArchive({
        filename: uploadFile.name,
        contentBase64,
        name: skillName,
        category: skillCategory,
        displayName: uploadDisplayName,
        displayCategory,
        overwrite
      });
      setUploadNotice(`Uploaded and installed ${created.name}.`);
      setNotice(`Uploaded and installed ${created.name}.`);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      setActiveTab('installed');
      await openInstalledSkill(created.name);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadBusy(false);
    }
  }

  async function refreshCoachStoredRecordings(): Promise<BrowserCoachStoredRecording[]> {
    setCoachStoredBusy(true);
    try {
      const listRecordings = window.tasiHarness.browserCoach.listRecordings;
      if (!listRecordings) {
        setCoachStoredRecordings([]);
        setCoachSelectedStoredSkill('');
        setCoachError(tr('Browser coach trace list API is not loaded yet. Restart the app to load the updated preload script.', '浏览器教练轨迹列表 API 尚未加载。请重启应用以加载更新后的 preload 脚本。'));
        return [];
      }
      const recordings = await listRecordings();
      setCoachStoredRecordings(recordings);
      setCoachSelectedStoredSkill((current) => (
        current && recordings.some((item) => item.id === current) ? current : recordings[0]?.id ?? ''
      ));
      return recordings;
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
      return [];
    } finally {
      setCoachStoredBusy(false);
    }
  }

  async function loadCoachStoredRecording(recordingId: string): Promise<void> {
    setCoachSelectedStoredSkill(recordingId);
    if (!recordingId) return;
    setCoachStoredBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      const loadRecording = window.tasiHarness.browserCoach.loadRecording;
      const summary = coachStoredRecordings.find((item) => item.id === recordingId);
      const label = summary?.displayName || summary?.skillName || recordingId;
      if (!loadRecording) {
        throw new Error(tr('Browser coach trace loader API is not loaded yet. Restart the app to load the updated preload script.', '浏览器教练轨迹载入 API 尚未加载。请重启应用以加载更新后的 preload 脚本。'));
      }
      const recording = await loadRecording(recordingId);
      if (!recording) throw new Error(tr(`No saved recording found for ${label}.`, `没有找到 ${label} 的已保存轨迹。`));
      setCoachRecording({ ...recording, active: false, events: reindexCoachEvents(recording.events) });
      setCoachRecordingSource('stored');
      setCoachTraceDirty(false);
      setCoachEditingEventId(null);
      setCoachEventDraft(null);
      setCoachSkillName(summary?.displayName || summary?.skillName || 'recorded-browser-workflow');
      setCoachCategory(summary?.category || 'browser');
      setCoachNotice(tr(`Loaded saved trace from ${label}.`, `已载入 ${label} 的保存轨迹。`));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachStoredBusy(false);
    }
  }

  async function startCoach(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    setCoachTraceDirty(false);
    setCoachEditingEventId(null);
    setCoachEventDraft(null);
    setCoachRecordingSource('live');
    try {
      const recording = await window.tasiHarness.browserCoach.start({ url: coachUrl });
      setCoachRecording(recording);
      setCoachNotice(tr('Browser coach started. Operate in the opened browser window.', '教练已开始。请在弹出的浏览器窗口中操作。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function stopCoach(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    try {
      const stopped = await window.tasiHarness.browserCoach.stop();
      setCoachRecording(stopped);
      const recordings = await refreshCoachStoredRecordings();
      const saved = recordings.find((item) => item.source === 'recording' && item.startedAt === stopped.startedAt && item.eventCount === stopped.events.length);
      if (saved) {
        setCoachSelectedStoredSkill(saved.id);
        setCoachRecordingSource('stored');
      } else {
        setCoachRecordingSource('live');
      }
      setCoachTraceDirty(false);
      setCoachEditingEventId(null);
      setCoachEventDraft(null);
      setCoachNotice(tr('Browser coach stopped and saved as a trace.', '教练已停止，轨迹已保存。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function clearCoachTrace(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      const selectedRecordingId = coachRecordingSource === 'stored' ? coachSelectedStoredSkill : '';
      if (selectedRecordingId) {
        const deleteRecording = window.tasiHarness.browserCoach.deleteRecording;
        if (!deleteRecording) {
          throw new Error(tr('Browser coach trace delete API is not loaded yet. Restart the app to load the updated preload script.', '浏览器教练轨迹删除 API 尚未加载。请重启应用以加载更新后的 preload 脚本。'));
        }
        await deleteRecording(selectedRecordingId);
      }
      setCoachRecording(await window.tasiHarness.browserCoach.clear());
      setCoachRecordingSource('live');
      setCoachTraceDirty(false);
      setCoachEditingEventId(null);
      setCoachEventDraft(null);
      await refreshCoachStoredRecordings();
      setCoachNotice(selectedRecordingId
        ? tr('Browser trace cleared and saved trace file deleted.', '浏览器操作轨迹已清除，已保存轨迹文件已删除。')
        : tr('Browser trace cleared.', '浏览器操作轨迹已清除。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function generateCoachSkill(): Promise<void> {
    const displayName = coachSkillName.trim();
    const name = displayName;
    const category = normalizeSkillCategory(coachCategory, 'browser');
    const displayCategory = skillCategoryLabel(category, tr);
    if (!displayName) {
      setCoachError(tr('Skill name is required.', '请填写技能名称。'));
      return;
    }
    if (coachRecording.events.length === 0) {
      setCoachError(tr('Record at least one browser action before generating a skill.', '请至少记录一个浏览器操作后再生成技能。'));
      return;
    }
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      const result = await window.tasiHarness.browserCoach.generateSkill({
        name,
        category,
        description: coachDescription.trim() || undefined,
        userGuidance: coachUserGuidance.trim() || undefined,
        recording: coachRecording,
        displayName,
        displayCategory
      });
      setCoachTraceDirty(false);
      await refreshCoachStoredRecordings();
      setNotice(tr(`Generated skill ${result.skill.name}.`, `已生成技能 ${result.skill.name}。`));
      setCoachNotice(tr(`Generated skill ${result.skill.name}; recording saved to ${result.recordingReferencePath}.`, `已生成技能 ${result.skill.name}；轨迹已保存到 ${result.recordingReferencePath}。`));
      await refreshSkills();
      await openInstalledSkill(result.skill.name);
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  function beginEditCoachEvent(event: BrowserCoachRecordedEvent): void {
    if (coachRecording.active) return;
    setCoachEditingEventId(event.id);
    setCoachEventDraft(coachEventToDraft(event));
    setCoachError('');
  }

  function cancelEditCoachEvent(): void {
    setCoachEditingEventId(null);
    setCoachEventDraft(null);
  }

  function saveEditCoachEvent(eventId: string): void {
    if (!coachEventDraft) return;
    setCoachRecording((recording) => ({
      ...recording,
      events: recording.events.map((event) => event.id === eventId ? draftToCoachEvent(event, coachEventDraft) : event)
    }));
    setCoachTraceDirty(true);
    setCoachEditingEventId(null);
    setCoachEventDraft(null);
    setCoachNotice(tr('Trace event updated. Generate the skill to use the edited trace.', '轨迹事件已修改。生成技能时会使用修改后的轨迹。'));
  }

  function deleteCoachEvent(eventId: string): void {
    if (coachRecording.active) return;
    setCoachRecording((recording) => ({
      ...recording,
      events: reindexCoachEvents(recording.events.filter((event) => event.id !== eventId))
    }));
    if (coachEditingEventId === eventId) {
      setCoachEditingEventId(null);
      setCoachEventDraft(null);
    }
    setCoachTraceDirty(true);
    setCoachNotice(tr('Trace event deleted. Generate the skill to use the edited trace.', '轨迹事件已删除。生成技能时会使用修改后的轨迹。'));
  }

  async function installBundledVersion(skill: SkillMetadata): Promise<void> {
    const actionKey = `bundled:${skill.name}`;
    const overwrite = overwriteSelected(actionKey);
    if (!overwrite) {
      setNotice(tr(
        `Skill ${skill.name} was kept. Check "Overwrite existing skill" to replace it with the bundled version.`,
        `已保留技能 ${skill.name}。勾选“覆盖现有技能”后才会用内置版本替换。`
      ));
      return;
    }
    setMarketActionKey(actionKey);
    setMarketError('');
    try {
      const installed = await window.tasiHarness.skills.installBundled(skill.name, true);
      setNotice(tr(`Replaced ${skill.name} with bundled skill.`, `已用内置版本覆盖 ${skill.name}。`));
      await refreshSkills();
      await openInstalledSkill(installed.name);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketActionKey(null);
    }
  }

  async function refreshOptimizationSessions(): Promise<void> {
    setOptimizeRefreshing(true);
    setOptimizeError('');
    try {
      await refreshSessions();
    } catch (error) {
      setOptimizeError(error instanceof Error ? error.message : String(error));
    } finally {
      setOptimizeRefreshing(false);
    }
  }

  async function optimizeSelectedSession(): Promise<void> {
    const selected = sessions.filter((item) => optimizeSessionIds.includes(item.id));
    if (selected.length === 0) {
      setOptimizeError(tr('Choose at least one session first.', '请先选择至少一个 session。'));
      return;
    }
    setOptimizeError('');
    try {
      await onOptimizeSession(selected, optimizeUserGuidance);
    } catch (error) {
      setOptimizeError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleOptimizeSession(sessionId: string): void {
    setOptimizeSessionIds((current) => (
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId]
    ));
  }

  function setAllOptimizeSessions(selected: boolean): void {
    setOptimizeSessionIds(selected ? sessions.map((session) => session.id) : []);
  }

  return (
    <section className="page">
      <PageHeader
        title={tr('Skills', '技能')}
        subtitle={tr('Browse local skills and marketplace catalogs such as ClawHub and SkillHub.', '浏览本地技能与技能市场目录（如 ClawHub、SkillHub）。')}
        action={<button className="primary-button" onClick={openCreateEditor}>{tr('Create', '创建')}</button>}
      />
      <div className="card">
        <div className="skill-tabs">
          <button className={`skill-tab ${activeTab === 'installed' ? 'active' : ''}`} onClick={() => setActiveTab('installed')}>
            {tr('Installed skills', '已安装技能')}
          </button>
          <button className={`skill-tab ${activeTab === 'marketplace' ? 'active' : ''}`} onClick={() => setActiveTab('marketplace')}>
            {tr('Marketplace', '技能市场')}
          </button>
          <button className={`skill-tab ${activeTab === 'upload' ? 'active' : ''}`} onClick={() => setActiveTab('upload')}>
            {tr('Upload', '上传')}
          </button>
          <button className={`skill-tab ${activeTab === 'coach' ? 'active' : ''}`} onClick={() => setActiveTab('coach')}>
            {tr('Coach', '教练')}
          </button>
          <button className={`skill-tab ${activeTab === 'optimize' ? 'active' : ''}`} onClick={() => setActiveTab('optimize')}>
            {tr('Optimize', '技能优化')}
          </button>
        </div>
        {activeTab === 'installed' && (
          <>
            <h2>{tr('Installed skills', '已安装技能')}</h2>
            <div className="skills-grid">
              {skills.map((skill) => (
                <div key={`${skill.source}-${skill.name}`} className="skill-card">
                  <div className="skill-card-top"><strong>{skill.displayName || skill.name}</strong></div>
                  <p>{skill.description}</p>
                  <div className="skill-footer">
                    <span>{skill.displayCategory || skill.category}</span>
                    {skill.displayName && <span>{skill.name}</span>}
                    <span>{skill.marketplaceSourceId ?? skill.source}</span>
                  </div>
                  {skill.bundledPath && (
                    <div className="meta-row wrap upload-file-row">
                      <span className="soft-badge">{tr('Bundled version available', '有内置版本')}</span>
                      <label className="toggle-line overwrite-toggle">
                        <input
                          type="checkbox"
                          checked={overwriteSelected(`bundled:${skill.name}`)}
                          onChange={(event) => setOverwriteSelection(`bundled:${skill.name}`, event.target.checked)}
                        />
                        {tr('Overwrite existing skill', '覆盖现有技能')}
                      </label>
                    </div>
                  )}
                  <div className="button-row compact skill-actions">
                    <button className="ghost-button" onClick={() => void openInstalledSkill(skill.name)}>{tr('Open', '打开')}</button>
                    {skill.bundledPath && (
                      <button
                        className="ghost-button"
                        disabled={marketActionKey === `bundled:${skill.name}` || !overwriteSelected(`bundled:${skill.name}`)}
                        onClick={() => void installBundledVersion(skill)}
                      >
                        {marketActionKey === `bundled:${skill.name}` ? tr('Replacing...', '覆盖中...') : tr('Use Bundled', '用内置版本覆盖')}
                      </button>
                    )}
                    {!skill.readonly && <button className="danger-button" onClick={() => void uninstall(skill.name)}>{tr('Uninstall', '卸载')}</button>}
                  </div>
                </div>
              ))}
              {skills.length === 0 && <div className="tool-empty">{tr('No installed skills yet.', '暂无已安装技能。')}</div>}
            </div>
          </>
        )}
        {activeTab === 'marketplace' && (
          <>
            <h2>{tr('Marketplace', '技能市场')}</h2>
            <label>{tr('Search marketplace skills', '搜索市场技能')}</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('search ClawHub, SkillHub, and more', '搜索 ClawHub、SkillHub 等')} />
            {marketError && <div className="error-box market-error">{marketError}</div>}
            <div className="meta-row wrap">
              <span className="soft-badge">{tr('Results', '结果')}: {marketplace.skills.length}</span>
              {debouncedQuery && <span className="soft-badge">{tr('Query', '检索')}: {debouncedQuery}</span>}
              {marketplace.sources.filter((source) => source.enabled).map((source) => (
                <span key={source.id} className="soft-badge">{source.name}</span>
              ))}
            </div>
            <div className="marketplace-list">
              {marketplace.skills.map((skill) => (
                <div key={`${skill.sourceId}-${skill.id}`} className="marketplace-card">
                  {(() => {
                    const installActionKey = `install:${skill.sourceId}:${skill.id}`;
                    const uninstallActionKey = `uninstall:${skill.installedSkillName ?? ''}`;
                    const installBusy = marketActionKey === installActionKey;
                    const uninstallBusy = marketActionKey === uninstallActionKey;
                    const existing = marketplaceExistingSkill(skill);
                    const needsOverwrite = Boolean(existing && !skill.installed);
                    return (
                  <div className="marketplace-card-top">
                    <div>
                      <strong>{skill.name}</strong>
                      <div className="card-subtle">{skill.sourceName} | {skill.category} | v{skill.version}</div>
                      {needsOverwrite && (
                        <label className="toggle-line overwrite-toggle">
                          <input
                            type="checkbox"
                            checked={overwriteSelected(installActionKey)}
                            onChange={(event) => setOverwriteSelection(installActionKey, event.target.checked)}
                          />
                          {tr(`Overwrite existing skill ${existing?.name}`, `覆盖现有技能 ${existing?.name}`)}
                        </label>
                      )}
                    </div>
                    {skill.installed && skill.installedSkillName ? (
                      <button className="danger-button" disabled={uninstallBusy || marketActionKey !== null} onClick={() => void uninstall(skill.installedSkillName ?? '')}>
                        {uninstallBusy ? tr('Uninstalling...', '卸载中...') : tr('Uninstall', '卸载')}
                      </button>
                    ) : (
                      <button className="primary-button" disabled={installBusy || marketActionKey !== null || (needsOverwrite && !overwriteSelected(installActionKey))} onClick={() => void install(skill)}>
                        {installBusy ? tr('Installing...', '安装中...') : tr('Install', '安装')}
                      </button>
                    )}
                  </div>
                    );
                  })()}
                  <p>{skill.description}</p>
                  <pre className="code-block small">{skill.readme || skill.skillContent}</pre>
                </div>
              ))}
              {marketplace.skills.length === 0 && <div className="tool-empty">{tr('No marketplace skills matched the current search.', '当前搜索未匹配到市场技能。')}</div>}
            </div>
          </>
        )}
        {activeTab === 'upload' && (
          <>
            <h2>{tr('Upload Skill Package', '上传技能包')}</h2>
            <label>{tr('ZIP package', 'ZIP 文件')}</label>
            <input
              type="file"
              accept=".zip,.skill,application/zip"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setUploadFile(file);
                setUploadPackageSkillName('');
                setUploadOverwrite(false);
                if (file) {
                  setUploadName(suggestSkillNameFromFilename(file.name));
                  setUploadError('');
                  void inspectUploadPackage(file);
                }
              }}
            />
            <label>{tr('Skill name', '技能名')}</label>
            <input
              value={uploadName}
              onChange={(e) => {
                setUploadName(e.target.value);
                setUploadOverwrite(false);
              }}
              placeholder={tr('required, e.g. my-automation-skill', '必填，例如：my-automation-skill')}
            />
            <label>{tr('Category', '分类')}</label>
            <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
              {SKILL_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>{tr(category.en, category.zh)}</option>
              ))}
            </select>
            {existingSkillForDisplayName(uploadName, 'uploaded-skill') && (
              <label className="toggle-line overwrite-toggle">
                <input type="checkbox" checked={uploadOverwrite} onChange={(event) => setUploadOverwrite(event.target.checked)} />
                {tr(`Overwrite existing skill ${existingSkillForDisplayName(uploadName, 'uploaded-skill')?.name}`, `覆盖现有技能 ${existingSkillForDisplayName(uploadName, 'uploaded-skill')?.name}`)}
              </label>
            )}
            {uploadFile && (
              <div className="meta-row wrap upload-file-row">
                <span className="soft-badge">{tr('File', '文件')}: {uploadFile.name}</span>
                <span className="soft-badge">{tr('Size', '大小')}: {(uploadFile.size / 1024).toFixed(1)} KB</span>
                {uploadPackageSkillName && <span className="soft-badge">{tr('Package skill', '包内技能')}: {uploadPackageSkillName}</span>}
              </div>
            )}
            <div className="button-row">
              <button className="primary-button" disabled={uploadBusy || Boolean(existingSkillForDisplayName(uploadName, 'uploaded-skill') && !uploadOverwrite)} onClick={() => void uploadArchive()}>
                {uploadBusy ? tr('Uploading...', '上传中...') : tr('Upload and Install', '上传并安装')}
              </button>
            </div>
            {uploadError && <div className="error-box market-error">{uploadError}</div>}
            {uploadNotice && <div className="notice-box">{uploadNotice}</div>}
          </>
        )}
        {activeTab === 'coach' && (
          <>
            <h2>{tr('Browser Coach', '浏览器教练')}</h2>
            <div className="coach-layout">
              <div className="coach-controls">
                <label>{tr('Start URL', '起始网址')}</label>
                <input value={coachUrl} onChange={(event) => setCoachUrl(event.target.value)} placeholder="https://www.baidu.com" />
                <div className="button-row">
                  <button className="primary-button" disabled={coachBusy || coachRecording.active} onClick={() => void startCoach()}>
                    {coachRecording.active ? tr('Recording...', '记录中...') : tr('Start', '开始')}
                  </button>
                  <button className="ghost-button" disabled={coachBusy || !coachRecording.active} onClick={() => void stopCoach()}>
                    {tr('Stop', '停止')}
                  </button>
                  <span className={`soft-badge ${coachRecording.active ? 'badge-ok' : 'badge-muted'}`}>
                    {coachRecording.active ? tr('Recording', '记录中') : tr('Idle', '空闲')}
                  </span>
                  <span className="soft-badge">{tr('Events', '事件')}: {coachRecording.events.length}</span>
                </div>
                <label>{tr('Saved traces', '已有轨迹')}</label>
                <div className="coach-saved-trace-row">
                  <select
                    value={coachSelectedStoredSkill}
                    disabled={coachStoredBusy || coachStoredRecordings.length === 0}
                    onChange={(event) => setCoachSelectedStoredSkill(event.target.value)}
                  >
                    {coachStoredRecordings.length === 0 ? (
                      <option value="">{tr('No saved traces', '暂无已保存轨迹')}</option>
                    ) : (
                      coachStoredRecordings.map((recording) => (
                        <option key={recording.id} value={recording.id}>
                          {`${recording.displayName || recording.skillName} · ${recording.eventCount} ${tr('events', '条')}`}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    className="ghost-button"
                    disabled={coachStoredBusy || !coachSelectedStoredSkill}
                    onClick={() => void loadCoachStoredRecording(coachSelectedStoredSkill)}
                  >
                    {coachStoredBusy ? tr('Loading...', '载入中...') : tr('Load', '载入')}
                  </button>
                  <button className="mini-button" disabled={coachStoredBusy} onClick={() => void refreshCoachStoredRecordings()}>
                    {tr('Refresh', '刷新')}
                  </button>
                </div>
                <label>{tr('Skill name', '技能名')}</label>
                <input value={coachSkillName} onChange={(event) => setCoachSkillName(event.target.value)} placeholder="recorded-browser-workflow" />
                <label>{tr('Category', '分类')}</label>
                <select value={coachCategory} onChange={(event) => setCoachCategory(event.target.value)}>
                  {SKILL_CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>{tr(category.en, category.zh)}</option>
                  ))}
                </select>
                <label>{tr('Description', '描述')}</label>
                <input value={coachDescription} onChange={(event) => setCoachDescription(event.target.value)} placeholder={tr('optional skill trigger description', '可选，用于触发技能的描述')} />
                <label>{tr('Guidance prompt', '指导提示词')}</label>
                <textarea
                  value={coachUserGuidance}
                  onChange={(event) => setCoachUserGuidance(event.target.value)}
                  placeholder={tr('Optional instructions for how this skill should be generated or used.', '可选：说明这个技能生成或使用时需要遵循的要求。')}
                />
                <div className="button-row">
                  <button className="primary-button" disabled={coachBusy || coachRecording.events.length === 0} onClick={() => void generateCoachSkill()}>
                    {coachBusy ? tr('Working...', '处理中...') : tr('Generate Skill', '生成技能')}
                  </button>
                </div>
              </div>
              <div className="coach-trace">
                <div className="coach-trace-head">
                  <div className="coach-trace-title">
                    <strong>{tr('Recorded Browser Trace', '浏览器操作轨迹')}</strong>
                    <span>
                      {tr(`${coachRecording.events.length} events`, `${coachRecording.events.length} 个事件`)}
                      {coachRecordingSource === 'stored' ? tr(' · saved trace', ' · 已保存轨迹') : ''}
                      {coachTraceDirty ? tr(' · edited', ' · 已编辑') : ''}
                    </span>
                  </div>
                  <div className="coach-trace-head-actions">
                    {coachRecording.startedAt && <span>{prettyDate(coachRecording.startedAt)}</span>}
                    <button
                      className="mini-button"
                      disabled={coachBusy || coachRecording.events.length === 0}
                      onClick={() => void clearCoachTrace()}
                    >
                      {tr('Clear', '清除')}
                    </button>
                  </div>
                </div>
                {coachRecording.events.length === 0 ? (
                  <div className="tool-empty">{tr('Click Start, operate in the browser window, and actions will appear here.', '点击开始，在弹出的浏览器中操作，轨迹会显示在这里。')}</div>
                ) : (
                  <div className="coach-trace-list">
                    {displayedCoachEvents.map((event) => (
                      <div key={event.id || `${event.index}-${event.createdAt}`} className="coach-event">
                        <div className="coach-event-main">
                          <div className="coach-event-summary">
                            <strong>{formatCoachEvent(event)}</strong>
                            <span>{event.url}</span>
                          </div>
                          {coachEditingEventId === event.id && coachEventDraft && (
                            <div className="coach-event-editor">
                              <label>{tr('Action', '动作')}</label>
                              <select
                                value={coachEventDraft.type}
                                onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, type: changeEvent.target.value as BrowserCoachRecordedEvent['type'] } : draft)}
                              >
                                <option value="navigation">navigation</option>
                                <option value="click">click</option>
                                <option value="input">input</option>
                                <option value="change">change</option>
                                <option value="submit">submit</option>
                                <option value="keydown">keydown</option>
                                <option value="window_closed">window_closed</option>
                              </select>
                              <label>URL</label>
                              <input value={coachEventDraft.url} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, url: changeEvent.target.value } : draft)} />
                              <div className="coach-event-editor-grid">
                                <div>
                                  <label>{tr('Name', '名称')}</label>
                                  <input value={coachEventDraft.name} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, name: changeEvent.target.value } : draft)} />
                                </div>
                                <div>
                                  <label>{tr('Text', '文本')}</label>
                                  <input value={coachEventDraft.text} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, text: changeEvent.target.value } : draft)} />
                                </div>
                              </div>
                              <div className="coach-event-editor-grid">
                                <div>
                                  <label>{tr('Selector', '选择器')}</label>
                                  <input value={coachEventDraft.selector} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, selector: changeEvent.target.value } : draft)} />
                                </div>
                                <div>
                                  <label>{tr('Value', '值')}</label>
                                  <input value={coachEventDraft.value} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, value: changeEvent.target.value } : draft)} />
                                </div>
                              </div>
                              <div className="coach-event-editor-grid compact">
                                <div>
                                  <label>{tr('Title', '标题')}</label>
                                  <input value={coachEventDraft.title} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, title: changeEvent.target.value } : draft)} />
                                </div>
                                <div>
                                  <label>{tr('Tag', '标签')}</label>
                                  <input value={coachEventDraft.tag} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, tag: changeEvent.target.value } : draft)} />
                                </div>
                                <div>
                                  <label>{tr('Role', '角色')}</label>
                                  <input value={coachEventDraft.role} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, role: changeEvent.target.value } : draft)} />
                                </div>
                                <div>
                                  <label>{tr('Key', '按键')}</label>
                                  <input value={coachEventDraft.key} onChange={(changeEvent) => setCoachEventDraft((draft) => draft ? { ...draft, key: changeEvent.target.value } : draft)} />
                                </div>
                              </div>
                              <div className="button-row coach-event-editor-actions">
                                <button className="primary-button" onClick={() => saveEditCoachEvent(event.id)}>{tr('Save', '保存')}</button>
                                <button className="ghost-button" onClick={cancelEditCoachEvent}>{tr('Cancel', '取消')}</button>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="coach-event-side">
                          <time>{prettyDate(event.createdAt)}</time>
                          <div className="coach-event-actions">
                            <button className="mini-button" disabled={coachRecording.active} onClick={() => beginEditCoachEvent(event)}>
                              {tr('Edit', '修改')}
                            </button>
                            <button className="mini-button danger-mini-button" disabled={coachRecording.active} onClick={() => deleteCoachEvent(event.id)}>
                              {tr('Delete', '删除')}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {coachError && <div className="error-box market-error">{coachError}</div>}
            {coachNotice && <div className="notice-box">{coachNotice}</div>}
          </>
        )}
        {activeTab === 'optimize' && (
          <>
            <h2>{tr('Skill Optimization', '技能优化')}</h2>
            <p className="card-subtle">
              {tr(
                'Choose one or more previous sessions. Tasi will start a new agent run that compares their failures, maps them to one or more skills, and patches the affected skill instructions or scripts.',
                '选择一个或多个历史 session。系统会启动新的智能体任务，对比其中的失败问题，映射到一个或多个技能，并修改受影响的技能说明或脚本。'
              )}
            </p>
            <div className="coach-trace-head optimize-session-head">
              <strong>{tr('Sessions', 'Session')}</strong>
              <div className="coach-trace-head-actions">
                <span className="soft-badge">{tr('Selected', '已选')}: {optimizeSessionIds.length}</span>
                <button className="mini-button" disabled={optimizeBusy || optimizeRefreshing || sessions.length === 0} onClick={() => setAllOptimizeSessions(true)}>
                  {tr('Select all', '全选')}
                </button>
                <button className="mini-button" disabled={optimizeBusy || optimizeRefreshing || optimizeSessionIds.length === 0} onClick={() => setAllOptimizeSessions(false)}>
                  {tr('Clear', '清除')}
                </button>
              </div>
            </div>
            <div className="optimize-session-list">
              {sessions.map((session) => (
                <label key={session.id} className="optimize-session-item">
                  <input
                    type="checkbox"
                    checked={optimizeSessionIds.includes(session.id)}
                    disabled={optimizeBusy || optimizeRefreshing}
                    onChange={() => toggleOptimizeSession(session.id)}
                  />
                  <span>
                    <strong>{session.title || session.id}</strong>
                    <span>{prettyDate(session.updatedAt)} · {session.messageCount} {tr('messages', '条消息')}</span>
                    <code>{session.id}</code>
                  </span>
                </label>
              ))}
            </div>
            <label>{tr('Guidance prompt', '指导提示词')}</label>
            <textarea
              value={optimizeUserGuidance}
              onChange={(event) => setOptimizeUserGuidance(event.target.value)}
              disabled={optimizeBusy || optimizeRefreshing}
              placeholder={tr('Optional instructions for this optimization run.', '可选：本次技能优化需要遵循的要求。')}
            />
            <div className="button-row">
              <button className="primary-button" disabled={optimizeBusy || optimizeRefreshing || optimizeSessionIds.length === 0} onClick={() => void optimizeSelectedSession()}>
                {optimizeBusy ? tr('Optimizing...', '优化中...') : tr('Optimize Skills From Sessions', '从多个 Session 优化技能')}
              </button>
              <button className="ghost-button" disabled={optimizeBusy || optimizeRefreshing} onClick={() => void refreshOptimizationSessions()}>
                {optimizeRefreshing ? tr('Refreshing...', '刷新中...') : tr('Refresh Sessions', '刷新 Session')}
              </button>
            </div>
            {sessions.length === 0 && <div className="tool-empty">{tr('No sessions found.', '暂无 session。')}</div>}
            {optimizeError && <div className="error-box market-error">{optimizeError}</div>}
          </>
        )}
        {notice && <div className="notice-box">{notice}</div>}
      </div>
      {editorOpen && (
        <div className="modal-backdrop" onClick={closeEditor}>
          <div className="modal-card skill-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>{editorMode === 'create' ? tr('Create Skill', '创建技能') : tr('Edit Skill', '编辑技能')}</h2>
              <button className="ghost-button" onClick={closeEditor} disabled={editorSaving}>{tr('Close', '关闭')}</button>
            </div>
            <label>{tr('Skill name', '技能名')}</label>
            <input value={editorName} onChange={(e) => setEditorName(e.target.value)} disabled={editorReadonly || editorSaving} />
            <label>{tr('Category', '分类')}</label>
            <select value={editorCategory} onChange={(e) => setEditorCategory(e.target.value)} disabled={editorReadonly || editorSaving}>
              {SKILL_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>{tr(category.en, category.zh)}</option>
              ))}
            </select>
            <label>{tr('Skill content (SKILL.md)', '技能内容（SKILL.md）')}</label>
            <textarea
              className="skill-editor-textarea"
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              disabled={editorReadonly || editorSaving}
            />
            {editorReadonly && <div className="notice-box modal-note">{tr('This skill is read-only.', '该技能为只读。')}</div>}
            {editorError && <div className="error-box modal-error">{editorError}</div>}
            <div className="button-row modal-actions">
              {!editorReadonly && (
                <button className="primary-button" disabled={editorSaving} onClick={() => void saveEditor()}>
                  {editorSaving ? tr('Saving...', '保存中...') : tr('Save', '保存')}
                </button>
              )}
              <button className="ghost-button" disabled={editorSaving} onClick={closeEditor}>{tr('Cancel', '取消')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TasksPage(props: {
  tr: TranslateFn;
  tasks: ScheduledTask[];
  refreshTasks: () => Promise<void>;
  refreshSessions: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('Daily digest');
  const [prompt, setPrompt] = useState('Summarize today\'s important progress and blockers.');
  const [scheduleType, setScheduleType] = useState<ScheduledTask['scheduleType']>('daily');
  const [runAt, setRunAt] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [scheduleHour, setScheduleHour] = useState(9);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [scheduleWeekdays, setScheduleWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleMonthDaysText, setScheduleMonthDaysText] = useState('1');
  const [executionMode, setExecutionMode] = useState<'workspace' | 'sandbox'>('sandbox');
  const [notifyByEmail, setNotifyByEmail] = useState(true);
  const [notifyByWechat, setNotifyByWechat] = useState(false);
  const [notice, setNotice] = useState('');

  function toggleWeekday(day: number): void {
    setScheduleWeekdays((current) => {
      if (current.includes(day)) return current.filter((item) => item !== day);
      return [...current, day].sort((a, b) => weekdayOrderIndex(a) - weekdayOrderIndex(b));
    });
  }

  async function createTask(): Promise<void> {
    const scheduleMonthDays = parseMonthDaySelection(scheduleMonthDaysText);
    if (scheduleType === 'weekly' && scheduleWeekdays.length === 0) {
      setNotice(props.tr('Select at least one weekday.', '请至少选择一个周几。'));
      return;
    }
    if (scheduleType === 'monthly' && scheduleMonthDays.length === 0) {
      setNotice(props.tr('Enter at least one valid day of month.', '请至少输入一个有效的每月日期。'));
      return;
    }
    await window.tasiHarness.tasks.create({
      name,
      prompt,
      scheduleType,
      runAt: scheduleType === 'once' ? new Date(runAt || Date.now()).toISOString() : undefined,
      intervalMinutes: scheduleType === 'interval' ? intervalMinutes : undefined,
      scheduleHour: ['daily', 'weekly', 'monthly'].includes(scheduleType) ? scheduleHour : undefined,
      scheduleMinute: ['daily', 'weekly', 'monthly'].includes(scheduleType) ? scheduleMinute : undefined,
      scheduleWeekdays: scheduleType === 'weekly' ? scheduleWeekdays : undefined,
      scheduleMonthDays: scheduleType === 'monthly' ? scheduleMonthDays : undefined,
      executionMode,
      notifyByEmail,
      notifyByWechat
    });
    setNotice(props.tr('Scheduled task created.', '定时任务已创建。'));
    await props.refreshTasks();
  }

  async function toggleTask(task: ScheduledTask): Promise<void> {
    await window.tasiHarness.tasks.update({ id: task.id, enabled: !task.enabled });
    await props.refreshTasks();
  }

  async function runNow(id: string): Promise<void> {
    await window.tasiHarness.tasks.runNow(id);
    setNotice(props.tr('Task executed.', '任务已执行。'));
    await Promise.all([props.refreshTasks(), props.refreshSessions()]);
  }

  async function remove(id: string): Promise<void> {
    await window.tasiHarness.tasks.delete(id);
    await props.refreshTasks();
  }

  return (
    <section className="page">
      <PageHeader title={props.tr('Scheduled Tasks', '定时任务')} subtitle={props.tr('Add tasks, run them on a timer, and send completion notifications by email or WeChat.', '添加任务，按计划运行，并通过邮件或微信发送完成通知。')} />
      <div className="split-grid">
        <div className="card">
          <h2>{props.tr('Create task', '创建任务')}</h2>
          <label>{props.tr('Name', '名称')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{props.tr('Prompt', '提示词')}</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <label>{props.tr('Schedule', '调度')}</label>
          <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as ScheduledTask['scheduleType'])}>
            <option value="daily">{props.tr('Daily', '每日')}</option>
            <option value="weekly">{props.tr('Weekly', '每周')}</option>
            <option value="monthly">{props.tr('Monthly', '每月')}</option>
            <option value="interval">{props.tr('Repeat every N minutes', '每 N 分钟重复')}</option>
            <option value="once">{props.tr('Run once', '仅运行一次')}</option>
          </select>
          {scheduleType === 'once' ? (
            <>
              <label>{props.tr('Run at', '运行时间')}</label>
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </>
          ) : scheduleType === 'interval' ? (
            <>
              <label>{props.tr('Interval minutes', '间隔分钟')}</label>
              <input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
            </>
          ) : (
            <>
              {scheduleType === 'weekly' && (
                <>
                  <label>{props.tr('Weekdays', '周几')}</label>
                  <div className="check-grid">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <label key={day} className="check-tile">
                        <input type="checkbox" checked={scheduleWeekdays.includes(day)} onChange={() => toggleWeekday(day)} />
                        <span>{weekdayLabel(day, props.tr)}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              {scheduleType === 'monthly' && (
                <>
                  <label>{props.tr('Days of month', '每月日期')}</label>
                  <input value={scheduleMonthDaysText} placeholder={props.tr('1, 3, 5 or 1-5', '1、3、5 或 1-5')} onChange={(e) => setScheduleMonthDaysText(e.target.value)} />
                </>
              )}
              <label>{props.tr('Time', '时间')}</label>
              <div className="inline-fields">
                <input aria-label={props.tr('Hour', '小时')} type="number" min="0" max="23" value={scheduleHour} onChange={(e) => setScheduleHour(Number(e.target.value))} />
                <span>:</span>
                <input aria-label={props.tr('Minute', '分钟')} type="number" min="0" max="59" value={scheduleMinute} onChange={(e) => setScheduleMinute(Number(e.target.value))} />
              </div>
            </>
          )}
          <label>{props.tr('Execution mode', '执行模式')}</label>
          <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as 'workspace' | 'sandbox')}>
            <option value="workspace">{props.tr('Workspace', '工作区')}</option>
            <option value="sandbox">{props.tr('Sandbox', '沙箱')}</option>
          </select>
          <label className="toggle-line"><input type="checkbox" checked={notifyByEmail} onChange={(e) => setNotifyByEmail(e.target.checked)} /> {props.tr('Email notification', '邮件通知')}</label>
          <label className="toggle-line"><input type="checkbox" checked={notifyByWechat} onChange={(e) => setNotifyByWechat(e.target.checked)} /> {props.tr('WeChat notification', '微信通知')}</label>
          <div className="button-row">
            <button className="primary-button" onClick={() => void createTask()}>{props.tr('Create task', '创建任务')}</button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
        </div>
        <div className="card">
          <h2>{props.tr('Task list', '任务列表')}</h2>
          <div className="task-list">
            {props.tasks.map((task) => (
              <div key={task.id} className="task-card">
                <div className="task-card-top">
                  <div>
                    <strong>{task.name}</strong>
                    <div className="card-subtle">
                      {taskScheduleLabel(task, props.tr)}
                    </div>
                  </div>
                  <span className={`soft-badge ${task.enabled ? 'badge-ok' : 'badge-muted'}`}>{task.enabled ? props.tr('Enabled', '已启用') : props.tr('Paused', '已暂停')}</span>
                </div>
                <p>{task.prompt}</p>
                <div className="meta-row wrap">
                  <span className="soft-badge">{props.tr('Next', '下次')}: {prettyDate(task.nextRunAt)}</span>
                  <span className="soft-badge">{props.tr('Run in', '运行于')} {task.executionMode === 'workspace' ? props.tr('workspace', '工作区') : props.tr('sandbox', '沙箱')}</span>
                  {task.notifyByEmail && <span className="soft-badge">{props.tr('Email', '邮件')}</span>}
                  {task.notifyByWechat && <span className="soft-badge">{props.tr('WeChat', '微信')}</span>}
                  {typeof task.lastIterations === 'number' && <span className="soft-badge">{props.tr('Iterations', '迭代')} {task.lastIterations}</span>}
                  {typeof task.lastToolEventCount === 'number' && <span className="soft-badge">{props.tr('Tools', '工具')} {task.lastToolEventCount}</span>}
                </div>
                {(task.lastResult || task.lastError) && <pre className="code-block small">{task.lastError || task.lastResult}</pre>}
                {task.lastTrace && <pre className="code-block small">{task.lastTrace}</pre>}
                <div className="button-row">
                  <button className="ghost-button" disabled={task.isRunning} onClick={() => void toggleTask(task)}>{task.enabled ? props.tr('Pause', '暂停') : props.tr('Enable', '启用')}</button>
                  <button className="primary-button" disabled={task.isRunning} onClick={() => void runNow(task.id)}>{task.isRunning ? props.tr('Executing...', '执行中...') : props.tr('Run now', '立即运行')}</button>
                  <button className="danger-button" onClick={() => void remove(task.id)}>{props.tr('Delete', '删除')}</button>
                </div>
              </div>
            ))}
            {props.tasks.length === 0 && <div className="tool-empty">{props.tr('No scheduled tasks yet.', '暂无定时任务。')}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

type SessionHistoryCategory = MemoryDomain | 'all' | 'wechat-clawbot';

function isWechatClawBotSession(session: SessionSummary, wechatSessionId?: string): boolean {
  const configuredId = wechatSessionId?.trim();
  if (configuredId && session.id === configuredId) return true;
  const title = session.title.trim().toLowerCase();
  return title === 'wechat session' || title.startsWith('wechat clawbot') || title.startsWith('[wechat:');
}

function SessionsPage({
  tr,
  sessions,
  wechatSessionId,
  onOpen,
  refreshSessions
}: {
  tr: TranslateFn;
  sessions: SessionSummary[];
  wechatSessionId?: string;
  onOpen: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<SessionHistoryCategory>('all');
  const [deletingCategory, setDeletingCategory] = useState(false);
  const categoryCounts = useMemo(() => {
    const counts = new Map<SessionHistoryCategory, number>([
      ['all', sessions.length],
      ['wechat-clawbot', 0]
    ]);
    for (const session of sessions) {
      if (isWechatClawBotSession(session, wechatSessionId)) {
        counts.set('wechat-clawbot', (counts.get('wechat-clawbot') ?? 0) + 1);
        continue;
      }
      const domain = knownMemoryDomain(session.domain);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return counts;
  }, [sessions, wechatSessionId]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((s) => {
      const isWechat = isWechatClawBotSession(s, wechatSessionId);
      if (activeCategory === 'wechat-clawbot' && !isWechat) return false;
      if (activeCategory !== 'all' && activeCategory !== 'wechat-clawbot' && (isWechat || knownMemoryDomain(s.domain) !== activeCategory)) return false;
      if (!needle) return true;
      return s.title.toLowerCase().includes(needle);
    });
  }, [sessions, query, activeCategory, wechatSessionId]);
  const activeCategoryLabel = useMemo(() => {
    if (activeCategory === 'all') return tr('All', '全部');
    if (activeCategory === 'wechat-clawbot') return tr('WeChat', '微信');
    const domain = MEMORY_DOMAINS.find((item) => item.value === activeCategory);
    return domain ? tr(domain.labelEn, domain.labelZh) : activeCategory;
  }, [activeCategory, tr]);
  const activeCategoryDeleteCount = categoryCounts.get(activeCategory) ?? 0;

  async function remove(id: string): Promise<void> {
    await window.tasiHarness.sessions.delete(id);
    await refreshSessions();
  }

  async function removeActiveCategory(): Promise<void> {
    const targets = activeCategory === 'all'
      ? sessions
      : activeCategory === 'wechat-clawbot'
        ? sessions.filter((session) => isWechatClawBotSession(session, wechatSessionId))
        : sessions.filter((session) => !isWechatClawBotSession(session, wechatSessionId) && knownMemoryDomain(session.domain) === activeCategory);
    if (targets.length === 0 || deletingCategory) return;
    const confirmed = window.confirm(
      activeCategory === 'all'
        ? tr(
          `Delete all ${targets.length} sessions? This cannot be undone.`,
          `删除全部 ${targets.length} 个会话？此操作无法撤销。`
        )
        : tr(
          `Delete ${targets.length} sessions in category "${activeCategoryLabel}"? This cannot be undone.`,
          `删除“${activeCategoryLabel}”分类下的 ${targets.length} 个会话？此操作无法撤销。`
        )
    );
    if (!confirmed) return;
    setDeletingCategory(true);
    try {
      await Promise.all(targets.map((session) => window.tasiHarness.sessions.delete(session.id)));
      await refreshSessions();
    } finally {
      setDeletingCategory(false);
    }
  }

  return (
    <section className="page">
      <PageHeader title={tr('History', '历史')} subtitle={tr('Local JSON session history grouped by memory domain, with WeChat separated for quick access.', '本地 JSON 会话历史，按记忆分类展示，并单独列出微信，方便快速查找。')} />
      <div className="card">
        <input className="wide-input" placeholder={tr('Filter history', '筛选历史')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="history-actions">
          <div className="card-subtle">
            {tr('Current category', '当前分类')}: {activeCategoryLabel} · {activeCategoryDeleteCount} {tr('sessions', '个会话')}
          </div>
          <button className="danger-button" disabled={deletingCategory || activeCategoryDeleteCount === 0} onClick={() => void removeActiveCategory()}>
            {deletingCategory
              ? tr('Deleting...', '删除中...')
              : activeCategory === 'all'
                ? tr('Delete All Sessions', '删除全部会话')
                : tr('Delete This Category', '删除当前分类')}
          </button>
        </div>
        <div className="memory-browser session-browser">
          <div className="memory-category-list">
            <button className={`memory-category-item ${activeCategory === 'all' ? 'active' : ''}`} onClick={() => setActiveCategory('all')}>
              <span>{tr('All', '全部')}</span>
              <span className="soft-badge">{categoryCounts.get('all') ?? 0}</span>
            </button>
            <button className={`memory-category-item ${activeCategory === 'wechat-clawbot' ? 'active' : ''}`} onClick={() => setActiveCategory('wechat-clawbot')}>
              <span>{tr('WeChat', '微信')}</span>
              <span className="soft-badge">{categoryCounts.get('wechat-clawbot') ?? 0}</span>
            </button>
            {MEMORY_DOMAINS.map((category) => (
              <button
                key={category.value}
                className={`memory-category-item ${activeCategory === category.value ? 'active' : ''}`}
                onClick={() => setActiveCategory(category.value)}
              >
                <span>{tr(category.labelEn, category.labelZh)}</span>
                <span className="soft-badge">{categoryCounts.get(category.value) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="session-list">
            {filtered.map((s) => {
              const isWechat = isWechatClawBotSession(s, wechatSessionId);
              const domain = MEMORY_DOMAINS.find((item) => item.value === knownMemoryDomain(s.domain)) ?? MEMORY_DOMAINS.at(-1);
              return (
                <div className="session-card" key={s.id}>
                  <div className="session-card-main">
                    <strong>{s.title}</strong>
                    <p>{s.messageCount} {tr('messages', '条消息')} | {prettyDate(s.updatedAt)}</p>
                    <div className="session-card-badges">
                      {isWechat && <span className="soft-badge">{tr('WeChat', '微信')}</span>}
                      {domain && <span className="soft-badge">{tr(domain.labelEn, domain.labelZh)}</span>}
                    </div>
                  </div>
                  <div className="session-card-actions">
                    <button className="primary-button" onClick={() => void onOpen(s.id)}>{tr('Open', '打开')}</button>
                    <button className="danger-button" onClick={() => void remove(s.id)}>{tr('Delete', '删除')}</button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="tool-empty">
                {tr('No sessions matched this category or filter.', '没有匹配该分类或筛选条件的会话。')}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsPage({ tr, config, setConfig }: { tr: TranslateFn; config: PublicAppConfig; setConfig: (cfg: PublicAppConfig) => void }): ReactElement {
  const [draft, setDraft] = useState<SettingsDraft>({ ...config, apiKey: '', omniApiKey: '', emailNotifications: { ...config.emailNotifications, password: '' } });
  const [testResult, setTestResult] = useState('');
  const [subPage, setSubPage] = useState<'agent-model' | 'omni-model' | 'execution' | 'security' | 'channels' | 'theme' | 'branding' | 'markets'>('agent-model');
  const [channelSubPage, setChannelSubPage] = useState<'email' | 'wechat'>('email');
  const [clawbotQrDataUrl, setClawbotQrDataUrl] = useState('');
  const [clawbotQrSource, setClawbotQrSource] = useState<'ilink-api' | 'manual-bind-url'>('manual-bind-url');
  const [clawbotQrKey, setClawbotQrKey] = useState('');
  const [wechatLoginStatus, setWechatLoginStatus] = useState<'idle' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error' | 'unknown'>('idle');
  const wechatLoginPollRef = useRef<number | null>(null);
  const wechatLoginCheckingRef = useRef(false);
  const themeImportInputRef = useRef<HTMLInputElement | null>(null);
  const [dreamSkinSort, setDreamSkinSort] = useState<DreamSkinGallerySort>('recent');
  const [dreamSkinOffset, setDreamSkinOffset] = useState(0);
  const [dreamSkinGallery, setDreamSkinGallery] = useState<DreamSkinGalleryResult | null>(null);
  const [dreamSkinLoading, setDreamSkinLoading] = useState(false);
  const [dreamSkinError, setDreamSkinError] = useState('');
  const [dreamSkinInstallingId, setDreamSkinInstallingId] = useState('');

  useEffect(() => {
    setDraft({ ...config, apiKey: '', omniApiKey: '', emailNotifications: { ...config.emailNotifications, password: '' } });
    setWechatLoginStatus(config.wechatChannel.loginStatus ?? 'idle');
  }, [config]);

  useEffect(() => {
    if (subPage !== 'theme') return;
    let cancelled = false;
    setDreamSkinLoading(true);
    setDreamSkinError('');
    void window.tasiHarness.themes.listDreamSkinGallery({
      limit: 12,
      offset: dreamSkinOffset,
      sort: dreamSkinSort
    }).then((result) => {
      if (!cancelled) setDreamSkinGallery(result);
    }, (error) => {
      if (!cancelled) setDreamSkinError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setDreamSkinLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [subPage, dreamSkinOffset, dreamSkinSort]);

  useEffect(() => {
    if (subPage !== 'theme') applyDocumentTheme(config);
  }, [subPage, config]);

  const agentProviderPreset = providerPreset(draft.provider);
  const agentSuggestedModels = providerModelOptions(draft.provider);
  const selectedOmniProviderPreset = omniProviderPreset(draft.omniProvider);
  const omniSuggestedModels = omniProviderModelOptions(draft.omniProvider);

  function stopWechatLoginPolling(): void {
    if (wechatLoginPollRef.current == null) return;
    window.clearInterval(wechatLoginPollRef.current);
    wechatLoginPollRef.current = null;
    wechatLoginCheckingRef.current = false;
  }

  async function checkWechatLoginStatus(qrcodeKey: string): Promise<void> {
    if (!qrcodeKey.trim()) return;
    if (wechatLoginCheckingRef.current) return;
    wechatLoginCheckingRef.current = true;
    try {
      const status = await window.tasiHarness.config.wechatQrcodeStatus(qrcodeKey);
      setWechatLoginStatus(status.status);
      if (status.status === 'confirmed') {
        stopWechatLoginPolling();
        const next = await window.tasiHarness.config.get();
        setConfig(next);
        setTestResult(tr('WeChat channel connected. Incoming messages will sync to chat.', '微信通道已连接，手机消息会同步到对话。'));
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) return;
      setWechatLoginStatus('error');
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      wechatLoginCheckingRef.current = false;
    }
  }

  function startWechatLoginPolling(qrcodeKey: string): void {
    if (!qrcodeKey.trim()) return;
    stopWechatLoginPolling();
    void checkWechatLoginStatus(qrcodeKey);
    wechatLoginPollRef.current = window.setInterval(() => {
      void checkWechatLoginStatus(qrcodeKey);
    }, 2500);
  }

  async function refreshClawbotQrCode(): Promise<void> {
    const bindUrl = draft.wechatChannel.bindUrl.trim() || 'https://ilinkai.weixin.qq.com';
    try {
      const payload = await window.tasiHarness.config.wechatQrcode();
      const content = payload.qrcodeContent.trim() || bindUrl;
      const dataUrl = await QRCode.toDataURL(content, { width: 240, margin: 1 });
      setClawbotQrDataUrl(dataUrl);
      setClawbotQrSource(payload.source);
      setClawbotQrKey(payload.qrcodeKey ?? '');
      setWechatLoginStatus(payload.qrcodeKey ? 'wait' : 'unknown');
      if (payload.qrcodeKey) startWechatLoginPolling(payload.qrcodeKey);
      return;
    } catch {
      // fall through to local fallback
    }

    try {
      const dataUrl = await QRCode.toDataURL(bindUrl, { width: 240, margin: 1 });
      setClawbotQrDataUrl(dataUrl);
      setClawbotQrSource('manual-bind-url');
      setClawbotQrKey('');
      setWechatLoginStatus('unknown');
      stopWechatLoginPolling();
    } catch {
      setClawbotQrDataUrl('');
      setClawbotQrSource('manual-bind-url');
      setClawbotQrKey('');
      setWechatLoginStatus('error');
      stopWechatLoginPolling();
    }
  }

  useEffect(() => {
    if (subPage !== 'channels' || channelSubPage !== 'wechat') return;
    void refreshClawbotQrCode();
  }, [subPage, channelSubPage]);

  useEffect(() => () => stopWechatLoginPolling(), []);

  function applyAgentProviderPreset(nextProvider: PublicAppConfig['provider']): void {
    const nextPreset = providerPreset(nextProvider);
    setDraft((old) => ({
      ...old,
      provider: nextProvider,
      baseUrl: nextPreset.defaultBaseUrl,
      model: providerModelOptions(nextProvider).includes(old.model) ? old.model : nextPreset.defaultModel
    }));
    setTestResult('');
  }

  function applyOmniProviderPreset(nextProvider: PublicAppConfig['provider']): void {
    const nextPreset = omniProviderPreset(nextProvider);
    setDraft((old) => ({
      ...old,
      omniProvider: nextProvider,
      omniBaseUrl: nextPreset.defaultBaseUrl,
      omniModel: omniProviderModelOptions(nextProvider).includes(old.omniModel) ? old.omniModel : nextPreset.defaultModel
    }));
    setTestResult('');
  }

  async function save(): Promise<void> {
    const patch: Partial<PublicAppConfig> & { apiKey?: string; emailNotifications?: SettingsDraft['emailNotifications'] } = { ...draft };
    if (!draft.apiKey) delete patch.apiKey;
    if (!draft.omniApiKey) delete patch.omniApiKey;
    if (patch.emailNotifications && !draft.emailNotifications.password) delete patch.emailNotifications.password;
    const next = await window.tasiHarness.config.set(patch);
    setConfig(next);
    setTestResult(tr('Settings saved.', '设置已保存。'));
  }

  async function test(profile: 'agent' | 'omni'): Promise<void> {
    await save();
    const result = await window.tasiHarness.config.test(profile);
    const label = profile === 'omni' ? tr('Realtime WebSocket', 'Realtime WebSocket') : tr('Agent model', 'Agent 模型');
    setTestResult(`${label} ${result.ok ? 'OK' : 'FAIL'}: ${result.content}`);
  }

  async function chooseBrandLogo(): Promise<void> {
    const logoPath = await window.tasiHarness.app.selectBrandLogo();
    if (!logoPath) return;
    setDraft((old) => ({
      ...old,
      branding: {
        ...old.branding,
        logoPath,
        logoDataUrl: undefined
      }
    }));
  }

  async function importThemePackage(file: File): Promise<void> {
    try {
      const next = await window.tasiHarness.themes.importPackage({
        filename: file.name,
        contentBase64: await fileToBase64(file)
      });
      setConfig(next);
      setDraft({ ...next, apiKey: '', omniApiKey: '', emailNotifications: { ...next.emailNotifications, password: '' } });
      const theme = next.customThemes.find((item) => `custom:${item.id}` === next.theme);
      const themeName = theme?.name ?? file.name;
      setTestResult(tr(`Imported theme: ${themeName}`, `已导入主题：${themeName}`));
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      if (themeImportInputRef.current) themeImportInputRef.current.value = '';
    }
  }

  async function refreshDreamSkinGallery(): Promise<void> {
    setDreamSkinLoading(true);
    setDreamSkinError('');
    try {
      const result = await window.tasiHarness.themes.listDreamSkinGallery({
        limit: 12,
        offset: dreamSkinOffset,
        sort: dreamSkinSort
      });
      setDreamSkinGallery(result);
    } catch (error) {
      setDreamSkinError(error instanceof Error ? error.message : String(error));
    } finally {
      setDreamSkinLoading(false);
    }
  }

  async function installDreamSkinTheme(theme: DreamSkinGalleryTheme): Promise<void> {
    if (dreamSkinInstallingId) return;
    setDreamSkinInstallingId(theme.id);
    setDreamSkinError('');
    try {
      const next = await window.tasiHarness.themes.installDreamSkinTheme({
        themeVersionId: theme.id,
        name: theme.name
      });
      setConfig(next);
      setDraft({ ...next, apiKey: '', omniApiKey: '', emailNotifications: { ...next.emailNotifications, password: '' } });
      setTestResult(tr(`Installed DreamSkin theme: ${theme.name}`, `已安装 DreamSkin 主题：${theme.name}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDreamSkinError(message);
      setTestResult(message);
    } finally {
      setDreamSkinInstallingId('');
    }
  }

  function renderModelConfiguration(profile: 'agent' | 'omni'): ReactElement {
    const isOmni = profile === 'omni';
    const activeProvider = isOmni ? draft.omniProvider : draft.provider;
    const activeBaseUrl = isOmni ? draft.omniBaseUrl : draft.baseUrl;
    const activeApiKey = isOmni ? draft.omniApiKey : draft.apiKey;
    const activeModel = isOmni ? draft.omniModel : draft.model;
    const activePreset = isOmni ? selectedOmniProviderPreset : agentProviderPreset;
    const activeSuggestedModels = isOmni ? omniSuggestedModels : agentSuggestedModels;
    const activeApiKeyConfigured = isOmni ? config.omniApiKeyConfigured : config.apiKeyConfigured;
    const providerPresets = isOmni ? OMNI_PROVIDER_PRESETS : PROVIDER_PRESETS;

    return (
      <div className="card">
        <h2>{isOmni ? tr('Omni Model Configuration', 'Omni 模型配置') : tr('Agent Model Configuration', 'Agent 模型配置')}</h2>
        <label>{isOmni ? tr('Realtime provider', 'Realtime 服务商') : tr('Provider', '服务商')}</label>
        <select
          value={activeProvider}
          onChange={(e) => {
            const nextProvider = e.target.value as PublicAppConfig['provider'];
            if (isOmni) applyOmniProviderPreset(nextProvider);
            else applyAgentProviderPreset(nextProvider);
          }}
        >
          {providerPresets.map((preset) => (
            <option key={preset.kind} value={preset.kind}>{preset.label}</option>
          ))}
        </select>
        <label>{isOmni ? tr('WebSocket URL', 'WebSocket URL') : tr('Base URL', 'Base URL')}</label>
        <input
          value={activeBaseUrl}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((old) => isOmni ? { ...old, omniBaseUrl: value } : { ...old, baseUrl: value });
          }}
        />
        <div className="card-subtle">{isOmni ? tr('Default WebSocket endpoint:', '默认 WebSocket 端点：') : tr('Preset endpoint:', '预设端点：')} {activePreset.defaultBaseUrl}</div>
        <label>API Key {activeApiKeyConfigured ? tr('(configured)', '（已配置）') : ''}</label>
        <input
          type="password"
          value={activeApiKey || ''}
          disabled={!providerRequiresApiKey(activeProvider)}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((old) => isOmni ? { ...old, omniApiKey: value } : { ...old, apiKey: value });
          }}
          placeholder={providerRequiresApiKey(activeProvider) ? tr('leave blank to keep existing', '留空则保持不变') : tr('Not required for this provider', '该服务商不需要')}
        />
        <label>{isOmni ? tr('Realtime models', 'Realtime 模型') : tr('Suggested models', '推荐模型')}</label>
        <select
          value={activeSuggestedModels.includes(activeModel) ? activeModel : ''}
          onChange={(e) => {
            if (!e.target.value) return;
            const value = e.target.value;
            setDraft((old) => isOmni ? { ...old, omniModel: value } : { ...old, model: value });
          }}
        >
          <option value="">{tr('Custom model...', '自定义模型...')}</option>
          {activeSuggestedModels.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
        <label>{isOmni ? tr('Realtime model', 'Realtime 模型') : tr('Model', '模型')}</label>
        <input
          value={activeModel}
          onChange={(e) => {
            const value = e.target.value;
            setDraft((old) => isOmni ? { ...old, omniModel: value } : { ...old, model: value });
          }}
        />
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={() => {
              setDraft((old) => isOmni
                ? { ...old, omniBaseUrl: activePreset.defaultBaseUrl, omniModel: activePreset.defaultModel }
                : { ...old, baseUrl: activePreset.defaultBaseUrl, model: activePreset.defaultModel });
            }}
          >
            {tr('Reset preset', '重置预设')}
          </button>
          <button className="ghost-button" onClick={() => void test(profile)}>
            {isOmni ? tr('Save and test Realtime WebSocket', '保存并测试 Realtime WebSocket') : tr('Save and test Agent model', '保存并测试 Agent 模型')}
          </button>
        </div>
      </div>
    );
  }

  const selectedCustomTheme = getActiveCustomTheme(draft);
  const selectedThemeBackground = customThemeBackgroundStyle(selectedCustomTheme);

  function updateThemeDraft(patch: Partial<Pick<SettingsDraft, 'theme' | 'textBrightness'>>): void {
    const next = { ...draft, ...patch };
    setDraft(next);
    applyDocumentTheme(next);
  }

  return (
    <section className="page settings-page">
      <PageHeader
        title={tr('Settings', '设置')}
        subtitle={tr('Provider, channels, skill markets, security, and execution defaults.', '模型服务、通道、技能市场、安全与执行默认配置。')}
        action={
          <div className="button-row compact">
            <button className="primary-button" onClick={() => void save()}>{tr('Save', '保存')}</button>
          </div>
        }
      />
      <div className="skill-tabs">
        <button className={`skill-tab ${subPage === 'agent-model' ? 'active' : ''}`} onClick={() => setSubPage('agent-model')}>{tr('Agent Model', 'Agent 模型')}</button>
        <button className={`skill-tab ${subPage === 'omni-model' ? 'active' : ''}`} onClick={() => setSubPage('omni-model')}>{tr('Omni Model', 'Omni 模型')}</button>
        <button className={`skill-tab ${subPage === 'execution' ? 'active' : ''}`} onClick={() => setSubPage('execution')}>{tr('Execution', '执行')}</button>
        <button className={`skill-tab ${subPage === 'security' ? 'active' : ''}`} onClick={() => setSubPage('security')}>{tr('Security', '安全')}</button>
        <button className={`skill-tab ${subPage === 'channels' ? 'active' : ''}`} onClick={() => setSubPage('channels')}>{tr('Channels', '通道')}</button>
        <button className={`skill-tab ${subPage === 'markets' ? 'active' : ''}`} onClick={() => setSubPage('markets')}>{tr('Skill Markets', '技能市场')}</button>
        <button className={`skill-tab ${subPage === 'theme' ? 'active' : ''}`} onClick={() => setSubPage('theme')}>{tr('Theme', '主题')}</button>
        <button className={`skill-tab ${subPage === 'branding' ? 'active' : ''}`} onClick={() => setSubPage('branding')}>{tr('Branding', '品牌')}</button>
      </div>
      {subPage === 'agent-model' && renderModelConfiguration('agent')}
      {subPage === 'omni-model' && renderModelConfiguration('omni')}
      {subPage === 'execution' && (
        <div className="card">
          <h2>{tr('Execution', '执行')}</h2>
          <label>{tr('Temperature', '温度')}</label>
          <input type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(e) => setDraft((old) => ({ ...old, temperature: Number(e.target.value) }))} />
          <label>{tr('Max iterations', '最大迭代次数')}</label>
          <input type="number" min="1" max="200" value={draft.maxIterations} onChange={(e) => setDraft((old) => ({ ...old, maxIterations: Number(e.target.value) }))} />
          <label>{tr('Session document max docs', '对话文档最大数量')}</label>
          <input
            type="number"
            min="1"
            max="100"
            value={draft.sessionDocumentMaxDocs}
            onChange={(e) => setDraft((old) => ({ ...old, sessionDocumentMaxDocs: Number(e.target.value) }))}
          />
          <label>{tr('Workspace directory', '工作目录')}</label>
          <input value={draft.workspaceDir} onChange={(e) => setDraft((old) => ({ ...old, workspaceDir: e.target.value }))} />
          <label>{tr('Default execution mode', '默认执行模式')}</label>
          <select value={draft.defaultExecutionMode} onChange={(e) => setDraft((old) => ({ ...old, defaultExecutionMode: e.target.value as 'workspace' | 'sandbox' }))}>
            <option value="workspace">{tr('Workspace', '工作区')}</option>
            <option value="sandbox">{tr('Sandbox', '沙箱')}</option>
          </select>
          <label>{tr('Browser mode', '浏览器模式')}</label>
          <select value={draft.browserMode} onChange={(e) => setDraft((old) => ({ ...old, browserMode: e.target.value as PublicAppConfig['browserMode'] }))}>
            <option value="embedded">{tr('Built-in browser', '内置浏览器')}</option>
            <option value="external">{tr('External browser', '外部浏览器')}</option>
          </select>
          <label>{tr('External browser engine', '外部浏览器引擎')}</label>
          <select
            value={draft.externalBrowserEngine}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserEngine: e.target.value as PublicAppConfig['externalBrowserEngine'] }))}
          >
            <option value="auto">{tr('Auto (CDP first)', '自动（优先 CDP）')}</option>
            <option value="cdp">{tr('CDP only', '仅 CDP')}</option>
            <option value="webdriver-safari">{tr('Safari WebDriver only', '仅 Safari WebDriver')}</option>
          </select>
          <label>{tr('CDP endpoint', 'CDP 地址')}</label>
          <input
            value={draft.externalBrowserCdpEndpoint}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserCdpEndpoint: e.target.value }))}
            placeholder="http://127.0.0.1:9222"
          />
          <label>{tr('External browser profile', '外部浏览器配置')}</label>
          <select
            value={draft.externalBrowserProfileMode}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserProfileMode: e.target.value as PublicAppConfig['externalBrowserProfileMode'] }))}
          >
            <option value="isolated">{tr('Isolated (safe default)', '隔离模式（默认更安全）')}</option>
            <option value="system">{tr('System profile (reuse login)', '系统配置（复用登录态）')}</option>
          </select>
          <label className="toggle-line"><input type="checkbox" checked={draft.browserHeadless} onChange={(e) => setDraft((old) => ({ ...old, browserHeadless: e.target.checked }))} /> {tr('Run external CDP browser headless', '以无头模式运行外部 CDP 浏览器')}</label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.browserExecutionLoggingEnabled}
              onChange={(e) => setDraft((old) => ({ ...old, browserExecutionLoggingEnabled: e.target.checked }))}
            />
            {tr('Enable browser execution log', '启用浏览器执行日志')}
          </label>
          <div className="card-subtle">{tr('Log file:', '日志文件：')} ~/.tasi-harness/logs/browser-execution.log</div>
          <label>{tr('Persona', '系统角色提示词')}</label>
          <textarea value={draft.systemPersona} onChange={(e) => setDraft((old) => ({ ...old, systemPersona: e.target.value }))} />
          <label>{tr('Omni realtime prompt', 'Omni 实时提示词')}</label>
          <textarea
            value={draft.omniSystemPrompt}
            onChange={(e) => setDraft((old) => ({ ...old, omniSystemPrompt: e.target.value }))}
          />
          <div className="card-subtle">
            {tr(
              'Used only by realtime voice mode. Keep it concise and tell the Omni model when to queue background tasks.',
              '仅用于实时语音模式。建议保持简洁，并说明 Omni 模型何时把复杂工作加入后台任务队列。'
            )}
          </div>
        </div>
      )}
      {subPage === 'security' && (
        <div className="card">
          <h2>{tr('Security', '安全')}</h2>
          <label className="toggle-line"><input type="checkbox" checked={draft.allowShellTools} onChange={(e) => setDraft((old) => ({ ...old, allowShellTools: e.target.checked }))} /> {tr('Enable terminal tool', '启用终端工具')}</label>
          <label className="toggle-line"><input type="checkbox" checked={draft.enableNetworkTools} onChange={(e) => setDraft((old) => ({ ...old, enableNetworkTools: e.target.checked }))} /> {tr('Enable network tools', '启用网络工具')}</label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.safetyApproval.enabled}
              onChange={(e) => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, enabled: e.target.checked } }))}
            />
            {tr('Enable safety approval', '启用安全审批')}
          </label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.safetyApproval.approveRiskyTerminalCommands}
              onChange={(e) => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, approveRiskyTerminalCommands: e.target.checked } }))}
            />
            {tr('Approve risky terminal commands', '风险终端命令需要审批')}
          </label>
          <label>{tr('Approval timeout seconds', '审批超时秒数')}</label>
          <input
            type="number"
            min="5"
            max="300"
            value={Math.round(draft.safetyApproval.timeoutMs / 1000)}
            onChange={(e) => setDraft((old) => ({
              ...old,
              safetyApproval: {
                ...old.safetyApproval,
                timeoutMs: Math.max(5, Math.min(300, Number(e.target.value) || 60)) * 1000
              }
            }))}
          />
          <div className="card-subtle">
            {tr(
              'Rules: workspace deletes require approval; outside-workspace reads, writes, and deletes require approval; low-risk terminal commands do not.',
              '规则：工作区内仅删除需要审批；工作区外读取、写入、删除需要审批；低风险终端命令不需要审批。'
            )}
          </div>
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, neverAskAgainKeys: [] } }))}
              disabled={draft.safetyApproval.neverAskAgainKeys.length === 0}
            >
              {tr('Clear remembered approvals', '清空不再审批记录')}
            </button>
            <span className="soft-badge">{tr('Remembered', '已记住')} {draft.safetyApproval.neverAskAgainKeys.length}</span>
          </div>
        </div>
      )}
      {subPage === 'channels' && (
        <div className="card">
          <h2>{tr('Channels', '通道')}</h2>
          <div className="skill-tabs channel-tabs">
            <button className={`skill-tab ${channelSubPage === 'email' ? 'active' : ''}`} onClick={() => setChannelSubPage('email')}>{tr('Email', '邮件')}</button>
            <button className={`skill-tab ${channelSubPage === 'wechat' ? 'active' : ''}`} onClick={() => setChannelSubPage('wechat')}>{tr('WeChat', '微信')}</button>
          </div>
          {channelSubPage === 'email' && (
            <div className="channel-pane">
              <label className="toggle-line"><input type="checkbox" checked={draft.emailNotifications.enabled} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, enabled: e.target.checked } }))} /> {tr('Enable email notifications', '启用邮件通知')}</label>
              <label>{tr('Email host', '邮件服务器')}</label>
              <input value={draft.emailNotifications.host} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, host: e.target.value } }))} />
              <label>{tr('Email port', '邮件端口')}</label>
              <input type="number" value={draft.emailNotifications.port} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, port: Number(e.target.value) } }))} />
              <label>{tr('Email username', '邮件用户名')}</label>
              <input value={draft.emailNotifications.username} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, username: e.target.value } }))} />
              <label>{tr('Email password', '邮件密码')} {config.emailNotifications.passwordConfigured ? tr('(configured)', '（已配置）') : ''}</label>
              <input type="password" value={draft.emailNotifications.password || ''} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, password: e.target.value } }))} placeholder={tr('leave blank to keep existing', '留空则保持不变')} />
              <label>{tr('From address', '发件地址')}</label>
              <input value={draft.emailNotifications.from} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, from: e.target.value } }))} />
              <label>{tr('To address', '收件地址')}</label>
              <input value={draft.emailNotifications.to} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, to: e.target.value } }))} />
            </div>
          )}
          {channelSubPage === 'wechat' && (
            <div className="channel-pane">
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={draft.wechatChannel.enabled}
                  onChange={(e) => setDraft((old) => ({ ...old, wechatChannel: { ...old.wechatChannel, enabled: e.target.checked } }))}
                />
                {tr('Enable WeChat channel', '启用微信通道')}
              </label>
              <label>{tr('Plugin', '插件')}</label>
              <input value={draft.wechatChannel.pluginName} readOnly />
              <div className="card-subtle">{tr('WeChat channel uses the clawbot plugin.', '微信通道使用 clawbot 插件。')}</div>
              <label>{tr('ClawBot bind URL', 'ClawBot 绑定地址')}</label>
              <input
                value={draft.wechatChannel.bindUrl}
                onChange={(e) => setDraft((old) => ({ ...old, wechatChannel: { ...old.wechatChannel, bindUrl: e.target.value } }))}
                placeholder="https://ilinkai.weixin.qq.com"
              />
              <div className="channel-qr-wrap">
                {clawbotQrDataUrl
                  ? <img className="channel-qr-image" src={clawbotQrDataUrl} alt={tr('ClawBot QR Code', 'ClawBot 二维码')} />
                  : <div className="card-subtle">{tr('QR code failed to load.', '二维码加载失败。')}</div>}
                <div className="channel-qr-meta">
                  <strong>{tr('ClawBot QR', 'ClawBot 二维码')}</strong>
                  <p>{tr('Scan this QR code with WeChat to bind the clawbot plugin channel.', '请使用微信扫码绑定 clawbot 插件通道。')}</p>
                  <p className="card-subtle">
                    {tr('Login status:', '登录状态：')} {wechatLoginStatus}
                  </p>
                  <p className="card-subtle">
                    {clawbotQrSource === 'ilink-api'
                      ? tr('Source: iLink dynamic login QR (recommended).', '来源：iLink 动态登录二维码（推荐）。')
                      : tr('Source: manual bind URL fallback.', '来源：手动绑定链接回退。')}
                  </p>
                  <button className="ghost-button channel-open-link" onClick={() => void checkWechatLoginStatus(clawbotQrKey)} disabled={!clawbotQrKey}>
                    {tr('Check login status', '检查登录状态')}
                  </button>
                  <button className="ghost-button channel-open-link" onClick={() => void refreshClawbotQrCode()}>
                    {tr('Refresh QR code', '刷新二维码')}
                  </button>
                  <a className="ghost-button channel-open-link" href={draft.wechatChannel.bindUrl.trim() || 'https://ilinkai.weixin.qq.com'} target="_blank" rel="noreferrer">
                    {tr('Open bind URL', '打开绑定链接')}
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {subPage === 'theme' && (
        <div className="card">
          <h2>{tr('Theme', '主题')}</h2>
          <label>{tr('Theme', '主题')}</label>
          <select value={draft.theme} onChange={(e) => updateThemeDraft({ theme: e.target.value as PublicAppConfig['theme'] })}>
            <option value="dark">{tr('Dark', '深色')}</option>
            <option value="light">{tr('Light', '浅色')}</option>
            <option value="tech">{tr('Tech Glass', '科技蓝')}</option>
            {draft.customThemes.length > 0 && (
              <optgroup label={tr('Imported themes', '已导入主题')}>
                {draft.customThemes.map((theme) => (
                  <option key={theme.id} value={`custom:${theme.id}`}>
                    {theme.name} · {theme.source === 'dreamskin' ? 'DreamSkin' : 'Tasi'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="theme-adjust-row">
            <div>
              <label htmlFor="text-brightness">{tr('Text brightness', '字体亮度')}</label>
              <p>{tr('Adjusts primary, secondary, and muted text across the selected theme.', '调节当前主题里的主文字、次级文字和弱提示文字。')}</p>
            </div>
            <div className="theme-adjust-control">
              <input
                id="text-brightness"
                type="range"
                min="70"
                max="150"
                step="1"
                value={draft.textBrightness ?? 100}
                onChange={(event) => updateThemeDraft({ textBrightness: Number(event.currentTarget.value) })}
              />
              <span className="soft-badge">{draft.textBrightness ?? 100}%</span>
            </div>
          </div>
          {selectedCustomTheme && (
            <div className="theme-preview">
              {selectedThemeBackground
                ? <div className="theme-preview-image" style={selectedThemeBackground} />
                : <div className="theme-preview-empty">{tr('This theme package has no background image.', '这个主题包没有背景图。')}</div>}
              <div>
                <strong>{selectedCustomTheme.name}</strong>
                <p>{selectedCustomTheme.source === 'dreamskin' ? 'DreamSkin' : 'Tasi'}</p>
              </div>
            </div>
          )}
          <input
            ref={themeImportInputRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            className="hidden-file-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importThemePackage(file);
            }}
          />
          <div className="button-row">
            <button className="ghost-button" onClick={() => themeImportInputRef.current?.click()}>
              {tr('Import DreamSkin theme package', '导入 DreamSkin 主题包')}
            </button>
            <span className="soft-badge">{tr('Imported', '已导入')} {draft.customThemes.length}</span>
          </div>
          <div className="card-subtle">
            {tr(
              'Supports DreamSkin .zip packages with theme.json and background.webp/jpg/png, or Tasi JSON token themes. Safe CSS is limited to color variables.',
              '支持包含 theme.json 与 background.webp/jpg/png 的 DreamSkin .zip，也支持 Tasi JSON token 主题。Safe CSS 仅提取颜色变量。'
            )}
          </div>
          <div className="dreamskin-gallery-panel">
            <div className="dreamskin-gallery-head">
              <div>
                <h3>{tr('DreamSkin Gallery', 'DreamSkin 主题库')}</h3>
                <p>{tr('Browse themes from dreamskin.cc/gallery and install one with a single click.', '浏览 dreamskin.cc/gallery 的主题，并一键下载安装。')}</p>
              </div>
              <div className="button-row compact">
                <button
                  className={`ghost-button ${dreamSkinSort === 'recent' ? 'active' : ''}`}
                  onClick={() => {
                    setDreamSkinSort('recent');
                    setDreamSkinOffset(0);
                  }}
                >
                  {tr('Latest', '最新')}
                </button>
                <button
                  className={`ghost-button ${dreamSkinSort === 'popular' ? 'active' : ''}`}
                  onClick={() => {
                    setDreamSkinSort('popular');
                    setDreamSkinOffset(0);
                  }}
                >
                  {tr('Popular', '热门')}
                </button>
                <button className="ghost-button" disabled={dreamSkinLoading} onClick={() => void refreshDreamSkinGallery()}>
                  {dreamSkinLoading ? tr('Loading...', '加载中...') : tr('Refresh', '刷新')}
                </button>
                <a className="ghost-button" href="https://dreamskin.cc/gallery" target="_blank" rel="noreferrer">
                  {tr('Open Website', '打开网站')}
                </a>
              </div>
            </div>
            {dreamSkinError && <div className="notice-box error">{dreamSkinError}</div>}
            {dreamSkinLoading && !dreamSkinGallery && <div className="tool-empty">{tr('Loading DreamSkin themes...', '正在加载 DreamSkin 主题...')}</div>}
            {dreamSkinGallery && (
              <>
                <div className="dreamskin-gallery-meta">
                  <span>{tr('Total', '总数')}: {formatCount(dreamSkinGallery.total)}</span>
                  <span>{tr('Page', '页码')}: {Math.floor(dreamSkinGallery.offset / dreamSkinGallery.limit) + 1}</span>
                </div>
                <div className="dreamskin-theme-grid">
                  {dreamSkinGallery.items.map((theme) => {
                    const swatches = dreamSkinSwatches(theme);
                    const installing = dreamSkinInstallingId === theme.id;
                    return (
                      <div className="dreamskin-theme-card" key={theme.id}>
                        <div className="dreamskin-theme-thumb">
                          {theme.thumbnailDataUrl
                            ? <img src={theme.thumbnailDataUrl} alt="" />
                            : <div className="dreamskin-theme-thumb-fallback" aria-hidden="true">
                              {swatches.map((color, index) => <span key={`${theme.id}-${color}-${index}`} style={{ background: color }} />)}
                            </div>}
                        </div>
                        <div className="dreamskin-theme-body">
                          <div className="dreamskin-theme-title">
                            <strong>{theme.name}</strong>
                            <span>v{theme.version}</span>
                          </div>
                          <p>{theme.authorDisplayName}</p>
                          <div className="dreamskin-theme-swatches" aria-hidden="true">
                            {swatches.map((color, index) => <i key={`${theme.id}-swatch-${index}`} style={{ background: color }} />)}
                          </div>
                          <div className="dreamskin-theme-meta">
                            <span>{formatBytes(theme.packageBytes)}</span>
                            <span>{theme.license}</span>
                            <span>{tr('Downloads', '下载')} {formatCount(theme.downloadCount)}</span>
                          </div>
                          <button
                            className="primary-button"
                            disabled={Boolean(dreamSkinInstallingId)}
                            onClick={() => void installDreamSkinTheme(theme)}
                          >
                            {installing ? tr('Installing...', '安装中...') : tr('Install', '安装')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="dreamskin-gallery-pager">
                  <button className="ghost-button" disabled={dreamSkinLoading || dreamSkinGallery.offset <= 0} onClick={() => setDreamSkinOffset((value) => Math.max(0, value - (dreamSkinGallery.limit || 12)))}>
                    {tr('Previous', '上一页')}
                  </button>
                  <button
                    className="ghost-button"
                    disabled={dreamSkinLoading || dreamSkinGallery.offset + dreamSkinGallery.limit >= dreamSkinGallery.total}
                    onClick={() => setDreamSkinOffset((value) => value + (dreamSkinGallery.limit || 12))}
                  >
                    {tr('Next', '下一页')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {subPage === 'branding' && (
        <div className="card">
          <h2>{tr('Branding', '品牌')}</h2>
          <div className="branding-settings-preview">
            <BrandLogo branding={draft.branding} className="about-logo" />
            <div>
              <strong>{draft.branding.productName || 'Tasi Harness'}</strong>
              <p>{tr('Desktop Agent', '桌面智能体')}</p>
            </div>
          </div>
          <label>{tr('Product name', '产品名称')}</label>
          <input
            value={draft.branding.productName}
            onChange={(e) => setDraft((old) => ({ ...old, branding: { ...old.branding, productName: e.target.value } }))}
          />
          <label>{tr('Logo initials', 'Logo 缩写')}</label>
          <input
            value={draft.branding.logoInitials}
            onChange={(e) => setDraft((old) => ({ ...old, branding: { ...old.branding, logoInitials: e.target.value } }))}
          />
          <label>{tr('Logo file', 'Logo 文件')}</label>
          <div className="input-row">
            <input
              value={draft.branding.logoPath}
              onChange={(e) => setDraft((old) => ({ ...old, branding: { ...old.branding, logoPath: e.target.value, logoDataUrl: undefined } }))}
              placeholder={tr('Optional local image path', '可选本地图片路径')}
            />
            <button className="ghost-button" onClick={() => void chooseBrandLogo()}>{tr('Browse', '浏览')}</button>
            <button
              className="ghost-button"
              onClick={() => setDraft((old) => ({ ...old, branding: { ...old.branding, logoPath: '', logoDataUrl: undefined } }))}
              disabled={!draft.branding.logoPath}
            >
              {tr('Clear', '清除')}
            </button>
          </div>
          <div className="card-subtle">
            {tr('Supported: PNG, JPG, WebP, GIF, SVG, ICO. Images over 2 MB are ignored in the UI preview.', '支持 PNG、JPG、WebP、GIF、SVG、ICO。超过 2 MB 的图片不会在界面预览中加载。')}
          </div>
        </div>
      )}
      {subPage === 'markets' && (
        <div className="card">
          <h2>{tr('Skill Markets', '技能市场')}</h2>
          <div className="task-list">
            {draft.skillMarketSources.map((source) => (
              <div key={source.id} className="task-card">
                <div className="task-card-top">
                  <div>
                    <strong>{source.name}</strong>
                    <div className="card-subtle">{source.id}</div>
                  </div>
                  <label className="toggle-line">
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={(e) => {
                        setDraft((old) => ({
                          ...old,
                          skillMarketSources: old.skillMarketSources.map((item) => item.id === source.id ? { ...item, enabled: e.target.checked } : item)
                        }));
                      }}
                    />
                    {tr('Enabled', '启用')}
                  </label>
                </div>
                <p>{source.description}</p>
                <label>{tr('Catalog URL', '目录地址')}</label>
                <input
                  value={source.catalogUrl || ''}
                  onChange={(e) => {
                    setDraft((old) => ({
                      ...old,
                      skillMarketSources: old.skillMarketSources.map((item) => item.id === source.id ? { ...item, catalogUrl: e.target.value } : item)
                    }));
                  }}
                  placeholder={tr('optional remote catalog URL', '可选的远程目录 URL')}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {testResult && <div className="notice-box">{testResult}</div>}
    </section>
  );
}

function AboutPage({ tr, info, branding }: { tr: TranslateFn; info: AppInfo | null; branding: PublicAppConfig['branding'] }): ReactElement {
  return (
    <section className="page">
      <PageHeader title={tr('About', '关于')} subtitle={tr('A TypeScript Electron agent desktop app with local memory, skill markets, scheduled tasks, and sandboxed runs.', '基于 TypeScript 与 Electron 的桌面智能体应用，支持本地记忆、技能市场、定时任务与沙箱执行。')} />
      <div className="about-card">
        <BrandLogo branding={branding} className="about-logo" />
        <div>
          <h2>{branding.productName || info?.productName || 'Tasi Harness'}</h2>
          <p>{tr('Agent loop | tool registry | skill marketplace | scheduled tasks | email notifications | sandbox execution | realtime voice.', '智能体循环 | 工具注册 | 技能市场 | 定时任务 | 邮件通知 | 沙箱执行 | 实时语音')}</p>
          <p>{tr(`Version: ${info?.version ?? 'unknown'}`, `版本：${info?.version ?? '未知'}`)}</p>
        </div>
      </div>
    </section>
  );
}
