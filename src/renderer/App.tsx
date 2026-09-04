import { memo, startTransition, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactElement, type SetStateAction } from 'react';
import type { CSSProperties } from 'react';
import type { ClipboardEvent as ReactClipboardEvent } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';
import type {
  AgentMessage,
  AgentArtifactRef,
  AgentMessageDeltaStream,
  AgentMessageAttachment,
  ArtifactPreviewResult,
  AppInfo,
  BrowserCoachRecordedEvent,
  BrowserCoachRecording,
  BrowserCoachStoredRecording,
  CustomTheme,
  DreamSkinGalleryResult,
  DreamSkinGallerySort,
  DreamSkinGalleryTheme,
  DshMarketplaceBrowseResult,
  DshMarketplacePlugin,
  DshMarketplacePluginDetail,
  DshSidecarClientMount,
  DshSidecarPluginRecord,
  DshSidecarRuntimePlugin,
  DshSidecarRuntimeStatus,
  DshSidecarStatus,
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
  SessionListPageResult,
  SessionSummary,
  SkillDocument,
  SkillMetadata,
  ToolApprovalRequest,
  ToolEvent
} from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browserConstants.js';
import { DEFAULT_OMNI_SYSTEM_PROMPT } from '../shared/defaultPrompts.js';
import { CONTENT_STREAM_PREVIEW_CHARS, REASONING_STREAM_PREVIEW_CHARS, prepareReasoningDeltaForDisplay, reasoningPanelText } from '../shared/reasoningPreview.js';
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
import { ARTIFACT_EXTENSIONS, previewModeForArtifact } from '../shared/artifacts.js';
import * as QRCode from 'qrcode';
import JSZip from 'jszip';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

type Page = 'chat' | 'knowledge' | 'memory' | 'skills' | 'plugins' | 'tasks' | 'sessions' | 'settings' | 'about';
type UiLanguage = 'zh' | 'en';
type TranslateFn = (en: string, zh: string) => string;
const MARKET_PAGE_SIZE = 24;
const HISTORY_PAGE_SIZE = 24;
const PLUGIN_MENTION_STATUS_CACHE_MS = 60_000;
const ARTIFACT_SELECTION_CONTEXT_MAX_CHARS = 6000;
let pluginMentionRuntimeStatusCache: { status: DshSidecarRuntimeStatus; loadedAt: number } | null = null;
let pluginMentionRuntimeStatusPromise: Promise<DshSidecarRuntimeStatus> | null = null;

interface PluginMentionTrigger {
  start: number;
  end: number;
  query: string;
}

interface PluginMentionItem {
  plugin: DshSidecarRuntimePlugin;
  token: string;
  label: string;
  detail: string;
  status: string;
  aliases: string[];
}

function findPluginMentionTrigger(value: string, cursor: number): PluginMentionTrigger | null {
  const beforeCursor = value.slice(0, Math.max(0, cursor));
  const match = /(^|[\s,，;；。！？!?])@([a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]*)?)$/.exec(beforeCursor);
  if (!match) return null;
  const query = match[2] ?? '';
  const start = beforeCursor.length - query.length - 1;
  return { start, end: cursor, query };
}

function dshPluginAliases(plugin: DshSidecarRuntimePlugin): string[] {
  const aliases = new Set<string>();
  const add = (value?: string) => {
    const clean = value?.trim().replace(/^@/, '').toLowerCase();
    if (clean) aliases.add(clean);
  };
  add(plugin.id);
  add(plugin.packageName);
  const packageParts = plugin.packageName.replace(/^@/, '').split('/');
  if (packageParts.length > 1) {
    add(packageParts.join('/'));
    add(packageParts.at(-1));
  }
  for (const command of plugin.commands ?? []) add(command.replace(/^\//, ''));
  return [...aliases];
}

function pluginMentionToken(plugin: DshSidecarRuntimePlugin): string {
  const packageName = plugin.packageName.trim();
  if (packageName.startsWith('@')) return packageName.slice(1);
  return packageName || plugin.id;
}

function pluginMentionItems(status: DshSidecarRuntimeStatus | null, query = ''): PluginMentionItem[] {
  const cleanQuery = query.trim().replace(/^@/, '').toLowerCase();
  if (!status) return [];
  return status.plugins
    .filter((plugin) => plugin.enabled && (plugin.status === 'loaded' || plugin.status === 'partial'))
    .map((plugin): PluginMentionItem => {
      const aliases = dshPluginAliases(plugin);
      const capabilities = [
        plugin.tools.length > 0 ? `${plugin.tools.length} tools` : '',
        (plugin.commands ?? []).length > 0 ? `${(plugin.commands ?? []).length} commands` : ''
      ].filter(Boolean);
      return {
        plugin,
        token: pluginMentionToken(plugin),
        label: plugin.packageName,
        detail: [plugin.id, plugin.version ?? 'unknown', capabilities.join(', ') || 'skill provider'].join(' | '),
        status: plugin.enabled ? plugin.status : 'disabled',
        aliases
      };
    })
    .filter((item) => !cleanQuery || item.aliases.some((alias) => alias.includes(cleanQuery)))
    .sort((left, right) => {
      const leftReady = left.plugin.enabled && (left.plugin.status === 'loaded' || left.plugin.status === 'partial');
      const rightReady = right.plugin.enabled && (right.plugin.status === 'loaded' || right.plugin.status === 'partial');
      if (leftReady !== rightReady) return leftReady ? -1 : 1;
      return left.label.localeCompare(right.label);
    })
    .slice(0, 8);
}

type ArtifactTextSelection = {
  artifact: AgentArtifactRef;
  text: string;
  x: number;
  y: number;
};

function normalizeArtifactSelectionText(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (clean.length <= ARTIFACT_SELECTION_CONTEXT_MAX_CHARS) return clean;
  return `${clean.slice(0, ARTIFACT_SELECTION_CONTEXT_MAX_CHARS).trimEnd()}\n\n[selection truncated]`;
}

function artifactLabelForPrompt(artifact: AgentArtifactRef): string {
  return artifact.name || artifact.path || artifact.absPath || 'artifact';
}

function artifactSelectionQuestionPrompt(artifact: AgentArtifactRef, text: string): string {
  const path = artifact.absPath || artifact.path || artifact.name;
  return [
    '请基于下面选中的文件内容回答我的问题。',
    '',
    `文件：${artifactLabelForPrompt(artifact)}`,
    path ? `路径：${path}` : undefined,
    '',
    '选中内容：',
    '```text',
    normalizeArtifactSelectionText(text),
    '```',
    '',
    '问题：'
  ].filter((line): line is string => line !== undefined).join('\n');
}

function artifactSelectionContextPrompt(artifact: AgentArtifactRef, text: string): string {
  const path = artifact.absPath || artifact.path || artifact.name;
  return [
    '下面是我从文件预览中选中的内容，请作为上下文参考：',
    '',
    `文件：${artifactLabelForPrompt(artifact)}`,
    path ? `路径：${path}` : undefined,
    '',
    '```text',
    normalizeArtifactSelectionText(text),
    '```'
  ].filter((line): line is string => line !== undefined).join('\n');
}

function cachedPluginMentionRuntimeStatus(force = false): Promise<DshSidecarRuntimeStatus> {
  const now = Date.now();
  if (!force && pluginMentionRuntimeStatusCache && now - pluginMentionRuntimeStatusCache.loadedAt < PLUGIN_MENTION_STATUS_CACHE_MS) {
    return Promise.resolve(pluginMentionRuntimeStatusCache.status);
  }
  if (!force && pluginMentionRuntimeStatusPromise) return pluginMentionRuntimeStatusPromise;
  pluginMentionRuntimeStatusPromise = window.tasiHarness.dshSidecar.runtimeStatus()
    .then((status) => {
      pluginMentionRuntimeStatusCache = { status, loadedAt: Date.now() };
      return status;
    })
    .finally(() => {
      pluginMentionRuntimeStatusPromise = null;
    });
  return pluginMentionRuntimeStatusPromise;
}

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
  reasoningEffort: 'auto',
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
  textColor: '',
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
const ARTIFACT_PREVIEW_MAX_BYTES = 256 * 1024 * 1024;
const MESSAGE_DELTA_FLUSH_MS = 33;
const REASONING_DELTA_FLUSH_MS = 180;
const UI_INTERACTION_MESSAGE_DELTA_FLUSH_MS = 450;
const TOOL_EVENT_FLUSH_MS = 220;
const MAX_LIVE_RENDERED_TOOL_EVENTS = 60;
const LIVE_CONTENT_ITEM_CHARS = 2_000;
const EMPTY_STRING_ARRAY: string[] = [];

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

function appendPreviewText(current: string | undefined, delta: string | undefined, maxChars: number): string | undefined {
  if (typeof delta !== 'string') return current;
  const combined = `${current ?? ''}${delta}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return combined.length > maxChars ? combined.slice(-maxChars).trimStart() : combined;
}

const PERCENT_ENCODED_UTF8_RUN = /(?:%[0-9A-Fa-f]{2}){2,}/g;
const CJK_TEXT = /[\u3400-\u9fff\uf900-\ufaff]/;

function decodeLikelyPercentEncodedChineseText(content: string): string {
  if (!content.includes('%')) return content;
  let decodedAny = false;
  const decoded = content.replace(PERCENT_ENCODED_UTF8_RUN, (match) => {
    try {
      const value = decodeURIComponent(match);
      if (!CJK_TEXT.test(value)) return match;
      decodedAny = true;
      return value;
    } catch {
      return match;
    }
  });
  return decodedAny ? decoded : content;
}

function mergeMessageDelta(messages: AgentMessage[], payload: AgentMessageDeltaStream): AgentMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === payload.messageId);
  if (existingIndex < 0) {
    if (payload.type === 'done') {
      const payloadContent = (payload.content ?? '').trim();
      const payloadReasoning = (payload.reasoning_content ?? '').trim();
      const coalesceIndex = [...messages]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find(({ message }) => (
          message.role === 'assistant'
          && message.hidden !== true
          && payloadContent.length > 0
          && (message.content ?? '').trim() === payloadContent
          && (!payloadReasoning || (message.reasoning_content ?? '').trim() === payloadReasoning)
        ))?.index;
      if (coalesceIndex !== undefined) {
        return [
          ...messages.slice(0, coalesceIndex),
          {
            ...messages[coalesceIndex],
            content: payload.content ?? messages[coalesceIndex].content,
            contentOmitted: payload.contentOmitted !== undefined ? payload.contentOmitted : messages[coalesceIndex].contentOmitted,
            contentLength: payload.contentLength !== undefined ? payload.contentLength : messages[coalesceIndex].contentLength,
            reasoning_content: payload.reasoning_content ?? messages[coalesceIndex].reasoning_content,
            reasoningOmitted: payload.reasoningOmitted !== undefined ? payload.reasoningOmitted : messages[coalesceIndex].reasoningOmitted,
            reasoningLength: payload.reasoningLength !== undefined ? payload.reasoningLength : messages[coalesceIndex].reasoningLength,
            reasoning_parts: payload.reasoning_parts ?? messages[coalesceIndex].reasoning_parts,
            content_parts: payload.content_parts ?? messages[coalesceIndex].content_parts,
            createdAt: messages[coalesceIndex].createdAt ?? payload.createdAt
          },
          ...messages.slice(coalesceIndex + 1)
        ];
      }
    }
    const content = payload.content ?? (payload.type === 'content' ? appendPreviewText('', payload.delta, CONTENT_STREAM_PREVIEW_CHARS) ?? '' : '');
    return [
      ...messages,
      {
        id: payload.messageId,
        role: 'assistant',
        content,
        contentOmitted: payload.contentOmitted,
        contentLength: payload.contentLength,
        reasoning_content: payload.reasoning_content ?? (payload.type === 'reasoning_content' ? appendPreviewText('', payload.delta, REASONING_STREAM_PREVIEW_CHARS) : undefined),
        reasoningOmitted: payload.reasoningOmitted,
        reasoningLength: payload.reasoningLength,
        reasoning_parts: payload.reasoning_parts,
        content_parts: payload.content_parts,
        createdAt: payload.createdAt
      }
    ];
  }

  const message = messages[existingIndex];
  const next = [
    ...messages.slice(0, existingIndex),
    {
      ...message,
      content: payload.content ?? (payload.type === 'content' ? appendPreviewText(message.content, payload.delta, CONTENT_STREAM_PREVIEW_CHARS) ?? message.content : message.content),
      contentOmitted: payload.contentOmitted !== undefined ? payload.contentOmitted : message.contentOmitted,
      contentLength: payload.contentLength !== undefined ? payload.contentLength : (payload.contentOmitted === false ? undefined : message.contentLength),
      reasoning_content: payload.reasoning_content ?? (payload.type === 'reasoning_content' ? appendPreviewText(message.reasoning_content, payload.delta, REASONING_STREAM_PREVIEW_CHARS) : message.reasoning_content),
      reasoningOmitted: payload.reasoningOmitted !== undefined ? payload.reasoningOmitted : message.reasoningOmitted,
      reasoningLength: payload.reasoningLength !== undefined ? payload.reasoningLength : (payload.reasoningOmitted === false ? undefined : message.reasoningLength),
      reasoning_parts: payload.reasoning_parts ?? message.reasoning_parts,
      content_parts: payload.content_parts ?? message.content_parts,
      createdAt: message.createdAt ?? payload.createdAt
    },
    ...messages.slice(existingIndex + 1)
  ];
  return next;
}

function mergeBufferedMessageDelta(
  current: AgentMessageDeltaStream | undefined,
  incoming: AgentMessageDeltaStream
): AgentMessageDeltaStream {
  if (!current) return incoming;
  const currentContent = current.content ?? (current.type === 'content' ? current.delta : undefined);
  const currentReasoningContent = current.reasoning_content ?? (current.type === 'reasoning_content' ? current.delta : undefined);
  const content = incoming.content !== undefined
    ? incoming.content
    : incoming.type === 'content'
      ? appendPreviewText(currentContent, incoming.delta, CONTENT_STREAM_PREVIEW_CHARS)
      : currentContent;
  const reasoningContent = incoming.reasoning_content !== undefined
    ? incoming.reasoning_content
    : incoming.type === 'reasoning_content'
      ? appendPreviewText(currentReasoningContent, incoming.delta, REASONING_STREAM_PREVIEW_CHARS)
      : currentReasoningContent;
  return {
    ...current,
    ...incoming,
    type: incoming.type,
    delta: incoming.delta,
    content,
    contentOmitted: incoming.contentOmitted !== undefined ? incoming.contentOmitted : current.contentOmitted,
    contentLength: incoming.contentLength !== undefined ? incoming.contentLength : (incoming.contentOmitted === false ? undefined : current.contentLength),
    reasoning_content: reasoningContent,
    reasoningOmitted: incoming.reasoningOmitted !== undefined ? incoming.reasoningOmitted : current.reasoningOmitted,
    reasoningLength: incoming.reasoningLength !== undefined ? incoming.reasoningLength : (incoming.reasoningOmitted === false ? undefined : current.reasoningLength),
    reasoning_parts: incoming.reasoning_parts !== undefined ? incoming.reasoning_parts : current.reasoning_parts,
    content_parts: incoming.content_parts !== undefined ? incoming.content_parts : current.content_parts,
    createdAt: current.createdAt ?? incoming.createdAt
  };
}

function isVisibleChatMessage(message: AgentMessage): boolean {
  if (message.hidden === true) return false;
  if (message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER) return false;
  const isIntermediateToolAssistant = message.role === 'assistant'
    && !message.content?.trim()
    && (message.tool_calls?.length ?? 0) > 0;
  if (isIntermediateToolAssistant) return false;
  return message.role === 'user' || (message.role === 'assistant' && Boolean(
    message.content?.trim()
    || message.reasoning_content?.trim()
    || (message.content_parts?.some((part) => part.trim()) ?? false)
  ));
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

const BUILTIN_BACKGROUND_TOKENS: Record<'dark' | 'light' | 'tech', string> = {
  dark: '#0a0a0f',
  light: '#f5f6fb',
  tech: '#06111f'
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

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const normalized = Math.max(0, Math.min(255, value)) / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function themeBackgroundColor(config: Pick<PublicAppConfig, 'theme' | 'customThemes'>): string {
  const customId = customThemeId(config.theme);
  if (customId) {
    const theme = config.customThemes.find((item) => item.id === customId);
    return theme?.tokens.bgPrimary || BUILTIN_BACKGROUND_TOKENS.dark;
  }
  if (config.theme === 'light' || config.theme === 'tech') return BUILTIN_BACKGROUND_TOKENS[config.theme];
  return BUILTIN_BACKGROUND_TOKENS.dark;
}

function themeAccentColor(config: Pick<PublicAppConfig, 'theme' | 'customThemes'>): string {
  const customId = customThemeId(config.theme);
  if (customId) {
    const theme = config.customThemes.find((item) => item.id === customId);
    return theme?.tokens.accent || theme?.tokens.accent2 || theme?.tokens.borderActive || '#00d4aa';
  }
  if (config.theme === 'tech') return '#18f0cf';
  if (config.theme === 'light') return '#00aa88';
  return '#00d4aa';
}

function automaticTextBrightness(config: Pick<PublicAppConfig, 'theme' | 'customThemes'>): number {
  const background = parseCssColor(themeBackgroundColor(config));
  if (!background) return config.theme === 'light' ? 70 : 130;
  const luminance = relativeLuminance(background);
  return Math.round(Math.max(70, Math.min(150, 150 - luminance * 80)));
}

function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function colorToHex(value: string | undefined): string {
  const color = value ? parseCssColor(value) : undefined;
  if (!color) return '#ffffff';
  const part = (channel: number) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

function ensureTextContrast(value: string, backgroundValue: string, minRatio: number, preserveHue = false): string {
  const color = parseCssColor(value);
  const background = parseCssColor(backgroundValue);
  if (!color || !background) return value;
  if (contrastRatio(color, background) >= minRatio) return value;
  if (preserveHue) {
    const towardWhite = contrastRatio({ r: 255, g: 255, b: 255 }, background) >= contrastRatio({ r: 0, g: 0, b: 0 }, background);
    const target = towardWhite ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
    for (let step = 0.08; step <= 1; step += 0.04) {
      const candidate = mixColor(color, target, step);
      const parsed = parseCssColor(candidate);
      if (parsed && contrastRatio(parsed, background) >= minRatio) return candidate;
    }
    return towardWhite ? '#ffffff' : '#111111';
  }
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  const target = contrastRatio(white, background) >= contrastRatio(black, background) ? white : black;
  for (let step = 0.15; step <= 1; step += 0.05) {
    const candidate = mixColor(color, target, step);
    const parsed = parseCssColor(candidate);
    if (parsed && contrastRatio(parsed, background) >= minRatio) return candidate;
  }
  return target === white ? '#ffffff' : '#111111';
}

function automaticTextColor(config: Pick<PublicAppConfig, 'theme' | 'customThemes'>): string {
  const background = parseCssColor(themeBackgroundColor(config));
  const accent = parseCssColor(themeAccentColor(config));
  if (!background) return config.theme === 'light' ? '#111827' : '#f8fafc';
  const candidates = ['#ffffff', '#f8fafc', '#eef9ff', '#1a1a2e', '#111827', '#05070a'];
  const scored = candidates.map((candidate) => {
    const color = parseCssColor(candidate);
    if (!color) return { candidate, score: 0 };
    const backgroundScore = contrastRatio(color, background);
    const accentScore = accent ? Math.min(contrastRatio(color, accent), 7) : 7;
    return { candidate, score: backgroundScore * 1.8 + accentScore };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate ?? '#f8fafc';
}

function textTokensFromPrimaryColor(primary: string, background: string): Required<Pick<CustomTheme['tokens'], 'textPrimary' | 'textSecondary' | 'textMuted'>> {
  const textPrimary = ensureTextContrast(primary, background, 4.5, true);
  const primaryColor = parseCssColor(textPrimary);
  const backgroundColor = parseCssColor(background);
  if (!primaryColor || !backgroundColor) {
    return {
      textPrimary,
      textSecondary: textPrimary,
      textMuted: textPrimary
    };
  }
  return {
    textPrimary,
    textSecondary: ensureTextContrast(mixColor(primaryColor, backgroundColor, 0.26), background, 3.2),
    textMuted: ensureTextContrast(mixColor(primaryColor, backgroundColor, 0.44), background, 2.4)
  };
}

function adjustTextColor(value: string, brightness: number): string | undefined {
  const color = parseCssColor(value);
  if (!color) return undefined;
  if (brightness === 100) return value;
  if (brightness > 100) return mixColor(color, { r: 255, g: 255, b: 255 }, Math.min(0.8, (brightness - 100) / 70));
  return mixColor(color, { r: 0, g: 0, b: 0 }, Math.min(0.65, (100 - brightness) / 80));
}

function baseTextTokens(config: PublicAppConfig, theme?: CustomTheme): Required<Pick<CustomTheme['tokens'], 'textPrimary' | 'textSecondary' | 'textMuted'>> {
  const manualTextColor = config.textColor?.trim();
  if (manualTextColor) return textTokensFromPrimaryColor(manualTextColor, themeBackgroundColor(config));
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
  const manualTextColor = Boolean(config.textColor?.trim());
  const tokens = baseTextTokens(config, theme);
  const background = themeBackgroundColor(config);
  const targets = [
    ['--text-primary', tokens.textPrimary, 4.5],
    ['--text-secondary', tokens.textSecondary, 3.2],
    ['--text-muted', tokens.textMuted, 2.4]
  ] as const;
  for (const [cssKey, base, minRatio] of targets) {
    const adjusted = manualTextColor ? base : adjustTextColor(base, brightness);
    root.style.setProperty(cssKey, ensureTextContrast(adjusted || base, background, minRatio, manualTextColor));
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

function imageExtensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/bmp') return 'bmp';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/tiff') return 'tiff';
  return 'png';
}

function pastedImageFilename(index: number, mimeType: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `pasted-image-${stamp}${index > 0 ? `-${index + 1}` : ''}.${imageExtensionFromMimeType(mimeType)}`;
}

function normalizePastedImageFile(file: File, index: number): File {
  if (file.name.trim()) return file;
  return new File([file], pastedImageFilename(index, file.type), {
    type: file.type || 'image/png',
    lastModified: file.lastModified || Date.now()
  });
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
    case 'plugins':
      return (
        <svg {...common}>
          <path d="M8.5 4.5h7v4h4v7h-4v4h-7v-4h-4v-7h4z" />
          <path d="M8.5 8.5h7v7h-7z" />
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

function BrowserToolbarIcon(props: { kind: 'back' | 'forward' | 'refresh' | 'open' }): ReactElement {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };
  if (props.kind === 'back') {
    return (
      <svg {...common}>
        <path d="M15 18l-6-6 6-6" />
      </svg>
    );
  }
  if (props.kind === 'forward') {
    return (
      <svg {...common}>
        <path d="M9 6l6 6-6 6" />
      </svg>
    );
  }
  if (props.kind === 'refresh') {
    return (
      <svg {...common}>
        <path d="M20 6v5h-5" />
        <path d="M4 18v-5h5" />
        <path d="M18.4 9A7 7 0 0 0 6.1 7.5L4 11" />
        <path d="M5.6 15A7 7 0 0 0 17.9 16.5L20 13" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

export function App(): ReactElement {
  const [page, setPage] = useState<Page>('chat');
  const [language, setLanguage] = useState<UiLanguage>(() => {
    const saved = globalThis.localStorage?.getItem('tasi_harness_ui_language');
    return saved === 'zh' ? 'zh' : 'en';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_sidebar_collapsed') === '1');
  const [config, setConfig] = useState<PublicAppConfig>(defaultConfig);
  const [themePreviewConfig, setThemePreviewConfig] = useState<PublicAppConfig | null>(null);
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
  const [, setLastUsage] = useState<LlmUsage | undefined>();
  const [, setTotalUsage] = useState<LlmUsage | undefined>();
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStopping, setChatStopping] = useState(false);
  const [chatLiveModeActive, setChatLiveModeActive] = useState(false);
  const [executionMode, setExecutionMode] = useState<'workspace' | 'sandbox'>('workspace');
  const activeWechatSessionId = config.wechatChannel.sessionId?.trim() || '';
  const isWechatSessionActive = Boolean(sessionId && activeWechatSessionId && sessionId === activeWechatSessionId);
  const tr: TranslateFn = useMemo(() => (en: string, zh: string) => (language === 'zh' ? zh : en), [language]);

  const nav = useMemo<Array<{ page: Page; icon: ReactElement; label: string }>>(
    () => [
      { page: 'chat', icon: <SidebarIcon kind="chat" />, label: tr('Chat', '对话') },
      { page: 'memory', icon: <SidebarIcon kind="memory" />, label: tr('Memory', '记忆') },
      { page: 'skills', icon: <SidebarIcon kind="skills" />, label: tr('Skills', '技能') },
      { page: 'plugins', icon: <SidebarIcon kind="plugins" />, label: tr('Plugins', '插件') },
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
    applyDocumentTheme(themePreviewConfig ?? config);
  }, [config, themePreviewConfig]);

  useEffect(() => {
    const source = themePreviewConfig ?? config;
    void window.tasiHarness.app.setWindowTitleBarTheme({
      theme: source.theme,
      textColor: source.textColor,
      customThemes: source.customThemes
    });
  }, [config.theme, config.textColor, config.customThemes, themePreviewConfig]);

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
      setMessages(result.messages.filter((m) => m.role !== 'system' && m.hidden !== true));
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

  const activeCustomTheme = getActiveCustomTheme(themePreviewConfig ?? config);
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
      </aside>
      <main className="main-pane">
        {page === 'chat' && (
          <ChatPage
            tr={tr}
            config={config}
            setConfig={setConfig}
            language={language}
            setLanguage={setLanguage}
            messages={messages}
            setMessages={setMessages}
            sessionId={sessionId}
            setSessionId={setSessionId}
            restoreLiveSession={restoreLiveSession}
            setLastUsage={setLastUsage}
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
        {page === 'plugins' && (
          <PluginsPage tr={tr} />
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
        {page === 'settings' && <SettingsPage tr={tr} config={config} setConfig={setConfig} onThemePreviewChange={setThemePreviewConfig} />}
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

interface PreviewBounds {
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
  setVisualZoomLevelLimits?: (minimumLevel: number, maximumLevel: number) => Promise<void>;
}

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

function clampPreviewRect(rect: PreviewRect, bounds: PreviewBounds): PreviewRect {
  const minWidth = 360;
  const minHeight = 220;
  const maxWidth = Math.max(minWidth, bounds.width - 12);
  const maxHeight = Math.max(minHeight, bounds.height - 12);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, minHeight), maxHeight);
  const x = Math.min(Math.max(rect.x, bounds.x), bounds.x + Math.max(0, bounds.width - width));
  const y = Math.min(Math.max(rect.y, bounds.y), bounds.y + Math.max(0, bounds.height - height));
  return { x, y, width, height };
}

function buildDefaultPreviewRect(bounds: PreviewBounds): PreviewRect {
  const targetWidth = Math.round(bounds.width * 0.9);
  const targetHeight = Math.round(bounds.height * 0.82);
  const rect = clampPreviewRect(
    {
      x: bounds.x + Math.round((bounds.width - targetWidth) / 2),
      y: bounds.y + Math.round((bounds.height - targetHeight) / 2),
      width: targetWidth,
      height: targetHeight
    },
    bounds
  );
  return rect;
}

function previewViewportBounds(): PreviewBounds {
  const mainPane = document.querySelector('.main-pane') as HTMLElement | null;
  const rect = mainPane?.getBoundingClientRect();
  if (rect && rect.width >= 420 && rect.height >= 320) {
    return {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  return {
    x: 0,
    y: 0,
    width: Math.max(420, window.innerWidth || document.documentElement.clientWidth || 420),
    height: Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320)
  };
}

function ChatPage(props: {
  tr: TranslateFn;
  config: PublicAppConfig;
  setConfig: (cfg: PublicAppConfig) => void;
  language: UiLanguage;
  setLanguage: Dispatch<SetStateAction<UiLanguage>>;
  messages: AgentMessage[];
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  sessionId?: string;
  setSessionId: (id?: string) => void;
  restoreLiveSession?: { sessionId: string; token: number } | null;
  setLastUsage: (usage?: LlmUsage) => void;
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
  const [pluginMentionStatus, setPluginMentionStatus] = useState<DshSidecarRuntimeStatus | null>(() => pluginMentionRuntimeStatusCache?.status ?? null);
  const [pluginMentionTrigger, setPluginMentionTrigger] = useState<PluginMentionTrigger | null>(null);
  const [pluginMentionActiveIndex, setPluginMentionActiveIndex] = useState(0);
  const [pluginMentionLoading, setPluginMentionLoading] = useState(false);
  const [pluginMentionError, setPluginMentionError] = useState('');
  const [wechatChipClearedAt, setWechatChipClearedAt] = useState(() => new Date().toISOString());
  const [usePersonalKnowledgeBase, setUsePersonalKnowledgeBase] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_use_personal_kb') === '1');
  const [toolPanelTab, setToolPanelTab] = useState<'artifacts' | 'browser' | 'tools'>('tools');
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false);
  const [chatSplitPercent, setChatSplitPercent] = useState(33.333);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreviewResult | null>(null);
  const [artifactTextSelection, setArtifactTextSelection] = useState<ArtifactTextSelection | null>(null);
  const [webPreviewExpanded, setWebPreviewExpanded] = useState(false);
  const [webPreviewRect, setWebPreviewRect] = useState<PreviewRect | null>(null);
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [previewAddress, setPreviewAddress] = useState('');
  const [previewCanGoBack, setPreviewCanGoBack] = useState(false);
  const [previewCanGoForward, setPreviewCanGoForward] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const chatMessagesRef = useRef<HTMLDivElement | null>(null);
  const toolPanelBodyRef = useRef<HTMLDivElement | null>(null);
  const chatContentGridRef = useRef<HTMLDivElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const previewWebviewRef = useRef<PreviewWebviewElement | null>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const uploadSessionDocInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMultimediaInputRef = useRef<HTMLInputElement | null>(null);
  const previewZoomSyncIdRef = useRef(0);
  const externalPreviewOpenUrlRef = useRef('');
  const messageDeltaBufferRef = useRef<Map<string, AgentMessageDeltaStream>>(new Map());
  const messageDeltaFlushTimerRef = useRef<number | null>(null);
  const messageDeltaFlushDueAtRef = useRef(0);
  const messageDeltaUrgentFlushRef = useRef(false);
  const messageDeltaWorkerRef = useRef<Worker | null>(null);
  const messageDeltaWorkerSeqRef = useRef(0);
  const toolEventBufferRef = useRef<ToolEvent[]>([]);
  const toolEventFlushTimerRef = useRef<number | null>(null);
  const previousWechatBusyRef = useRef(false);
  const activeSessionIdRef = useRef(props.sessionId);
  const previewDraggingRef = useRef(false);
  const previewDragRafRef = useRef<number | null>(null);
  const previewDragNextRectRef = useRef<PreviewRect | null>(null);

  const uiInteractionActiveRef = useRef(false);
  const uiInteractionReleaseTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    originRect: PreviewRect;
    bounds: PreviewBounds;
  } | null>(null);
  const [previewDragging, setPreviewDragging] = useState(false);
  const visibleMessages = useMemo(() => props.messages.filter(isVisibleChatMessage), [props.messages]);
  const latestVisibleMessage = visibleMessages[visibleMessages.length - 1];
  const latestToolPreviewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents), [props.toolEvents]);
  const latestBrowserToolEventId = useMemo(() => {
    for (let i = props.toolEvents.length - 1; i >= 0; i--) {
      const event = props.toolEvents[i];
      if (event.toolName.startsWith('browser_')) return event.id;
    }
    return '';
  }, [props.toolEvents]);
  const previewUrl = activePreviewUrl || latestToolPreviewUrl;
  const externalFallbackPreviewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents, true), [props.toolEvents]);
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
  const chatGridStyle = useMemo(() => ({
    '--chat-history-width': `${chatSplitPercent}%`
  }) as CSSProperties, [chatSplitPercent]);
  const visibleToolEvents = useMemo(
    () => runBusy ? props.toolEvents.slice(-MAX_LIVE_RENDERED_TOOL_EVENTS) : props.toolEvents,
    [props.toolEvents, runBusy]
  );
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
  const pluginMentionOptions = useMemo(
    () => pluginMentionItems(pluginMentionStatus, pluginMentionTrigger?.query ?? ''),
    [pluginMentionStatus, pluginMentionTrigger?.query]
  );
  const showPluginMentionMenu = Boolean(pluginMentionTrigger) && (pluginMentionLoading || pluginMentionError || Boolean(pluginMentionStatus));

  function updatePluginMentionForTextarea(text: string, cursor: number): void {
    const trigger = findPluginMentionTrigger(text, cursor);
    setPluginMentionTrigger(trigger);
    setPluginMentionActiveIndex(0);
    if (!trigger) setPluginMentionError('');
  }

  function insertPluginMention(item: PluginMentionItem): void {
    const textarea = chatTextareaRef.current;
    const trigger = pluginMentionTrigger;
    if (!trigger) return;
    const replacement = `@${item.token} `;
    const next = `${input.slice(0, trigger.start)}${replacement}${input.slice(trigger.end)}`;
    const cursor = trigger.start + replacement.length;
    setInput(next);
    setPluginMentionTrigger(null);
    setPluginMentionActiveIndex(0);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  }

  useEffect(() => {
    if (pluginMentionStatus) return;
    let cancelled = false;
    setPluginMentionLoading(true);
    cachedPluginMentionRuntimeStatus()
      .then((status) => {
        if (!cancelled) setPluginMentionStatus(status);
      })
      .catch(() => {
        // Keep background prefetch quiet; the explicit @ flow reports errors.
      })
      .finally(() => {
        if (!cancelled) setPluginMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginMentionStatus]);

  useEffect(() => {
    if (!pluginMentionTrigger || pluginMentionStatus || pluginMentionLoading) return;
    let cancelled = false;
    setPluginMentionLoading(true);
    setPluginMentionError('');
    cachedPluginMentionRuntimeStatus()
      .then((status) => {
        if (!cancelled) setPluginMentionStatus(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPluginMentionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setPluginMentionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginMentionTrigger, pluginMentionStatus, pluginMentionLoading]);

  useEffect(() => {
    if (pluginMentionActiveIndex >= pluginMentionOptions.length) setPluginMentionActiveIndex(0);
  }, [pluginMentionActiveIndex, pluginMentionOptions.length]);

  useEffect(() => {
    previewDraggingRef.current = previewDragging;
    if (!previewDragging) {
      flushMessageDeltas();
      flushToolEvents();
    }
  }, [previewDragging]);

  useEffect(() => {
    activeSessionIdRef.current = props.sessionId;
  }, [props.sessionId]);

  useEffect(() => {
    if (typeof Worker === 'undefined') return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./reasoningPreviewWorker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn('[renderer] reasoning preview worker unavailable:', error);
      return;
    }

    messageDeltaWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ id: number; payload: AgentMessageDeltaStream }>) => {
      processPreparedMessageDelta(event.data.payload);
    };
    worker.onerror = (event) => {
      console.warn('[renderer] reasoning preview worker failed:', event.message);
      if (messageDeltaWorkerRef.current === worker) messageDeltaWorkerRef.current = null;
      worker.terminate();
    };

    return () => {
      if (messageDeltaWorkerRef.current === worker) messageDeltaWorkerRef.current = null;
      worker.terminate();
    };
  }, []);

  useEffect(() => {
    const markActive = () => {
      uiInteractionActiveRef.current = true;
      if (uiInteractionReleaseTimerRef.current != null) {
        window.clearTimeout(uiInteractionReleaseTimerRef.current);
        uiInteractionReleaseTimerRef.current = null;
      }
    };
    const releaseSoon = () => {
      if (uiInteractionReleaseTimerRef.current != null) {
        window.clearTimeout(uiInteractionReleaseTimerRef.current);
      }
      uiInteractionReleaseTimerRef.current = window.setTimeout(() => {
        uiInteractionActiveRef.current = false;
        uiInteractionReleaseTimerRef.current = null;
        flushMessageDeltas();
        flushToolEvents();
      }, UI_INTERACTION_MESSAGE_DELTA_FLUSH_MS);
    };

    window.addEventListener('pointerdown', markActive, true);
    window.addEventListener('pointerup', releaseSoon, true);
    window.addEventListener('pointercancel', releaseSoon, true);
    window.addEventListener('blur', releaseSoon);
    return () => {
      window.removeEventListener('pointerdown', markActive, true);
      window.removeEventListener('pointerup', releaseSoon, true);
      window.removeEventListener('pointercancel', releaseSoon, true);
      window.removeEventListener('blur', releaseSoon);
      if (uiInteractionReleaseTimerRef.current != null) {
        window.clearTimeout(uiInteractionReleaseTimerRef.current);
        uiInteractionReleaseTimerRef.current = null;
      }
      uiInteractionActiveRef.current = false;
    };
  }, []);

  function flushMessageDeltas(forceUrgent = false): void {
    if (messageDeltaFlushTimerRef.current != null) {
      window.clearTimeout(messageDeltaFlushTimerRef.current);
      messageDeltaFlushTimerRef.current = null;
    }
    messageDeltaFlushDueAtRef.current = 0;
    if (previewDraggingRef.current) return;
    if (uiInteractionActiveRef.current) {
      scheduleMessageDeltaFlush(UI_INTERACTION_MESSAGE_DELTA_FLUSH_MS, messageDeltaUrgentFlushRef.current || forceUrgent);
      return;
    }
    const pending = [...messageDeltaBufferRef.current.values()];
    messageDeltaBufferRef.current.clear();
    if (pending.length === 0) return;
    const urgent = forceUrgent || messageDeltaUrgentFlushRef.current || pending.some((payload) => payload.type === 'content' || payload.type === 'done');
    messageDeltaUrgentFlushRef.current = false;
    const applyDeltas = () => {
      props.setMessages((old) => pending.reduce((next, payload) => mergeMessageDelta(next, payload), old));
    };
    if (urgent) {
      applyDeltas();
    } else {
      startTransition(applyDeltas);
    }
  }

  function clearPendingMessageDeltas(): void {
    if (messageDeltaFlushTimerRef.current != null) {
      window.clearTimeout(messageDeltaFlushTimerRef.current);
      messageDeltaFlushTimerRef.current = null;
    }
    messageDeltaFlushDueAtRef.current = 0;
    messageDeltaUrgentFlushRef.current = false;
    messageDeltaBufferRef.current.clear();
  }

  function flushToolEvents(): void {
    if (toolEventFlushTimerRef.current != null) {
      window.clearTimeout(toolEventFlushTimerRef.current);
      toolEventFlushTimerRef.current = null;
    }
    if (previewDraggingRef.current) return;
    if (uiInteractionActiveRef.current) {
      scheduleToolEventFlush();
      return;
    }
    const pending = toolEventBufferRef.current;
    toolEventBufferRef.current = [];
    if (pending.length === 0) return;
    startTransition(() => {
      props.setToolEvents((old) => [...old, ...pending]);
    });
  }

  function clearPendingToolEvents(): void {
    if (toolEventFlushTimerRef.current != null) {
      window.clearTimeout(toolEventFlushTimerRef.current);
      toolEventFlushTimerRef.current = null;
    }
    toolEventBufferRef.current = [];
  }

  function scheduleMessageDeltaFlush(delayMs = MESSAGE_DELTA_FLUSH_MS, urgent = false): void {
    if (previewDraggingRef.current) return;
    if (urgent) messageDeltaUrgentFlushRef.current = true;
    const interactionDelayMs = uiInteractionActiveRef.current ? UI_INTERACTION_MESSAGE_DELTA_FLUSH_MS : 0;
    const nextDelayMs = Math.max(delayMs, interactionDelayMs);
    const nextDueAt = Date.now() + nextDelayMs;
    if (messageDeltaFlushTimerRef.current != null && messageDeltaFlushDueAtRef.current <= nextDueAt) return;
    if (messageDeltaFlushTimerRef.current != null) {
      window.clearTimeout(messageDeltaFlushTimerRef.current);
      messageDeltaFlushTimerRef.current = null;
    }
    messageDeltaFlushDueAtRef.current = nextDueAt;
    messageDeltaFlushTimerRef.current = window.setTimeout(flushMessageDeltas, nextDelayMs);
  }

  function scheduleToolEventFlush(delayMs = TOOL_EVENT_FLUSH_MS): void {
    if (previewDraggingRef.current) return;
    if (toolEventFlushTimerRef.current != null) return;
    const interactionDelayMs = uiInteractionActiveRef.current ? UI_INTERACTION_MESSAGE_DELTA_FLUSH_MS : 0;
    const nextDelayMs = Math.max(delayMs, interactionDelayMs);
    toolEventFlushTimerRef.current = window.setTimeout(flushToolEvents, nextDelayMs);
  }

  function enqueueToolEvent(event: ToolEvent): void {
    toolEventBufferRef.current = [...toolEventBufferRef.current, event];
    scheduleToolEventFlush();
  }

  function processPreparedMessageDelta(payload: AgentMessageDeltaStream): void {
    if (activeSessionIdRef.current && payload.sessionId !== activeSessionIdRef.current) return;
    messageDeltaBufferRef.current.set(
      payload.messageId,
      mergeBufferedMessageDelta(messageDeltaBufferRef.current.get(payload.messageId), payload)
    );
    if (previewDraggingRef.current) return;
    if (uiInteractionActiveRef.current) {
      scheduleMessageDeltaFlush(payload.type === 'reasoning_content' ? REASONING_DELTA_FLUSH_MS : MESSAGE_DELTA_FLUSH_MS, payload.type === 'content');
      return;
    }
    if (payload.type === 'done') {
      flushMessageDeltas(true);
      return;
    }
    scheduleMessageDeltaFlush(payload.type === 'reasoning_content' ? REASONING_DELTA_FLUSH_MS : MESSAGE_DELTA_FLUSH_MS, payload.type === 'content');
  }

  function enqueueMessageDelta(payload: AgentMessageDeltaStream): void {
    const isLightContentDelta = payload.type === 'content'
      && payload.content === undefined
      && payload.reasoning_content === undefined
      && payload.reasoning_parts === undefined
      && payload.content_parts === undefined;
    if (isLightContentDelta) {
      processPreparedMessageDelta(payload);
      return;
    }
    const worker = messageDeltaWorkerRef.current;
    if (!worker) {
      processPreparedMessageDelta(prepareReasoningDeltaForDisplay(payload));
      return;
    }
    const id = messageDeltaWorkerSeqRef.current + 1;
    messageDeltaWorkerSeqRef.current = id;
    worker.postMessage({
      id,
      payload
    });
  }

  useEffect(() => {
    setWechatChipClearedAt(new Date().toISOString());
    previousWechatBusyRef.current = false;
    clearPendingToolEvents();
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
      setPreviewCanGoBack(false);
      setPreviewCanGoForward(false);
      setPreviewLoading(false);
      previewZoomSyncIdRef.current += 1;
    }
  }, [shouldShowWebPreview]);
  useEffect(() => {
    if (!latestToolPreviewUrl) return;
    setActivePreviewUrl(latestToolPreviewUrl);
    setPreviewAddress(latestToolPreviewUrl);
  }, [latestToolPreviewUrl]);
  useEffect(() => {
    if (!latestBrowserToolEventId || props.config.browserMode !== 'embedded') return;
    setToolPanelCollapsed(false);
    setToolPanelTab('browser');
  }, [latestBrowserToolEventId, props.config.browserMode]);
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
    previewZoomSyncIdRef.current += 1;
    resetPreviewWebviewZoom(true);
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
      const bounds = previewViewportBounds();
      setWebPreviewRect((old) => clampPreviewRect(old ?? buildDefaultPreviewRect(bounds), bounds));
    };
    syncWithinBounds();
    window.addEventListener('resize', syncWithinBounds);
    return () => window.removeEventListener('resize', syncWithinBounds);
  }, [webPreviewExpanded]);

  useEffect(() => {
    if (previewDragging) return;
    const panel = chatMessagesRef.current;
    if (!panel) return;
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    if (distanceFromBottom > 260) return;
    const rafId = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: runBusy ? 'auto' : 'smooth', block: 'end' });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [visibleMessages.length, latestVisibleMessage?.id, latestVisibleMessage?.content, latestVisibleMessage?.reasoning_content, runBusy, previewDragging]);
  useEffect(() => {
    if (toolPanelCollapsed || toolPanelTab !== 'tools') return;
    const panel = toolPanelBodyRef.current;
    if (!panel) return;
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    if (distanceFromBottom > 260) return;
    const rafId = window.requestAnimationFrame(() => {
      panel.scrollTo({ top: panel.scrollHeight, behavior: runBusy ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [visibleToolEvents.length, toolPanelCollapsed, toolPanelTab, runBusy]);
	  useEffect(() => {
	    const off = window.tasiHarness.agent.onToolEvent((payload) => {
	      if (isExternalImSessionId(payload.sessionId) && props.sessionId !== payload.sessionId) return;
	      if (props.sessionId && payload.sessionId !== props.sessionId) return;
	      enqueueToolEvent(payload.event);
	    });
    return () => {
      off();
      clearPendingToolEvents();
    };
  }, [props.sessionId, props.setToolEvents]);
	  useEffect(() => {
	    const off = window.tasiHarness.agent.onMessageDelta((payload) => {
	      if (isExternalImSessionId(payload.sessionId) && props.sessionId !== payload.sessionId) return;
	      if (props.sessionId && payload.sessionId !== props.sessionId) return;
	      enqueueMessageDelta(payload);
	    });
    return () => {
      off();
      clearPendingMessageDeltas();
    };
  }, [props.sessionId, props.setMessages]);
  useEffect(() => {
    if (!showEmbeddedWebPreview || !shouldShowWebPreview) {
      void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(null);
      return;
    }
    const webview = previewWebviewRef.current;
    if (!webview) return;
    const syncBinding = () => {
      try {
        const id = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return;
        resetPreviewWebviewZoom(true);
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
  }, [showEmbeddedWebPreview, shouldShowWebPreview, previewUrl]);
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

  function resetPreviewWebviewZoom(force = false): void {
    const webview = previewWebviewRef.current;
    if (!webview) return;
    if (!force && previewZoomSyncIdRef.current > 0) return;
    try {
      webview.style.zoom = '1';
      webview.setZoomFactor?.(1);
      webview.setZoomLevel?.(0);
      void webview.setVisualZoomLevelLimits?.(1, 1);
    } catch {
      // Ignore transient zoom update failures while page is changing.
    }
  }

  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    const body = previewBodyRef.current;
    if (!webview || !body) return;
    let disposed = false;
    let rafId = 0;

    const syncHostSize = () => {
      if (disposed) return;
      syncPreviewWebviewHostSize();
      resetPreviewWebviewZoom(true);
    };

    const schedulePreviewSync = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncHostSize();
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
    const reset = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => resetPreviewWebviewZoom(true));
    };

    webview.addEventListener('did-start-loading', reset as EventListener);
    webview.addEventListener('dom-ready', reset as EventListener);
    webview.addEventListener('did-stop-loading', reset as EventListener);
    webview.addEventListener('did-navigate', reset as EventListener);
    webview.addEventListener('did-navigate-in-page', reset as EventListener);
    reset();
    const resetTimeouts = [60, 180, 420, 900].map((delay) => window.setTimeout(reset, delay));

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      for (const timeoutId of resetTimeouts) window.clearTimeout(timeoutId);
      webview.removeEventListener('did-start-loading', reset as EventListener);
      webview.removeEventListener('dom-ready', reset as EventListener);
      webview.removeEventListener('did-stop-loading', reset as EventListener);
      webview.removeEventListener('did-navigate', reset as EventListener);
      webview.removeEventListener('did-navigate-in-page', reset as EventListener);
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
    const text = decodeLikelyPercentEncodedChineseText(rawText).trim();
    const outgoingAttachments = multimediaAttachments;
    if ((!text && outgoingAttachments.length === 0) || props.busy) return;
    setInput('');
    setArtifactTextSelection(null);
    setPluginMentionTrigger(null);
    setError('');
    setMultimediaError('');
    setMultimediaAttachments([]);
    props.setBusy(true);
    props.setStopping(false);
    setFollowUpQuestions([]);
    clearPendingToolEvents();
    props.setToolEvents([]);
    clearPendingMessageDeltas();
    props.setMessages([...props.messages, { role: 'user', content: text, attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined, createdAt: new Date().toISOString() }]);
    try {
      const result = await window.tasiHarness.agent.chat(text, props.sessionId, props.executionMode, personalKnowledgeEnabled, outgoingAttachments);
      clearPendingMessageDeltas();
      clearPendingToolEvents();
      props.setSessionId(result.sessionId);
      props.setMessages(result.messages.filter((m) => m.role !== 'system' && m.hidden !== true));
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
    const text = decodeLikelyPercentEncodedChineseText(rawText).trim();
    const outgoingAttachments = multimediaAttachments;
    const outgoingDocuments = activeSessionDocs;
    if ((!text && outgoingAttachments.length === 0 && outgoingDocuments.length === 0) || !liveInputReady) return;
    setInput('');
    setArtifactTextSelection(null);
    setPluginMentionTrigger(null);
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
      await Promise.race([
        window.tasiHarness.agent.stop(),
        new Promise((resolve) => window.setTimeout(resolve, 1800))
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearPendingMessageDeltas();
      clearPendingToolEvents();
      props.setStopping(false);
      props.setBusy(false);
      props.setMessages((old) => old.filter((message) => !(message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER)));
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
      const bounds = previewViewportBounds();
      setWebPreviewRect(clampPreviewRect(buildDefaultPreviewRect(bounds), bounds));
      setWebPreviewExpanded(true);
      window.requestAnimationFrame(() => {
        const webview = previewWebviewRef.current;
        if (!webview) return;
        try {
          syncPreviewWebviewHostSize();
          resetPreviewWebviewZoom(true);
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
    const bounds = previewViewportBounds();
    dragStateRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect: webPreviewRect,
      bounds
    };
    setPreviewDragging(true);
    event.preventDefault();
    const applyPendingDragRect = () => {
      previewDragRafRef.current = null;
      const next = previewDragNextRectRef.current;
      previewDragNextRectRef.current = null;
      if (!next || !dragStateRef.current) return;
      setWebPreviewRect(next);
    };
    const onMouseMove = (moveEvent: MouseEvent) => {
      const dragging = dragStateRef.current;
      if (!dragging) return;
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - dragging.startClientX;
      const deltaY = moveEvent.clientY - dragging.startClientY;
      const next = clampPreviewRect(
        {
          x: dragging.originRect.x + deltaX,
          y: dragging.originRect.y + deltaY,
          width: dragging.originRect.width,
          height: dragging.originRect.height
        },
        dragging.bounds
      );
      previewDragNextRectRef.current = next;
      if (previewDragRafRef.current == null) {
        previewDragRafRef.current = window.requestAnimationFrame(applyPendingDragRect);
      }
    };
    const endDrag = () => {
      dragStateRef.current = null;
      if (previewDragRafRef.current != null) {
        window.cancelAnimationFrame(previewDragRafRef.current);
        previewDragRafRef.current = null;
      }
      const finalRect = previewDragNextRectRef.current;
      previewDragNextRectRef.current = null;
      if (finalRect) setWebPreviewRect(finalRect);
      setPreviewDragging(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('blur', endDrag);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
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
    setError('');
    setToolPanelTab('browser');
    setActivePreviewUrl(normalized);
    setPreviewAddress(normalized);
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.loadURL !== 'function') return;
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

  function handleTextareaPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const clipboard = event.clipboardData;
    const imageFiles: File[] = [];
    const seen = new Set<string>();
    const addImageFile = (file: File | null) => {
      if (!file || !file.type.startsWith('image/')) return;
      const key = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      imageFiles.push(normalizePastedImageFile(file, imageFiles.length));
    };

    for (const item of Array.from(clipboard.items ?? [])) {
      if (item.kind !== 'file') continue;
      addImageFile(item.getAsFile());
    }
    for (const file of Array.from(clipboard.files ?? [])) addImageFile(file);
    if (imageFiles.length === 0) return;

    const pastedText = clipboard.getData('text/plain');
    event.preventDefault();
    if (pastedText) {
      const textarea = event.currentTarget;
      const start = textarea.selectionStart ?? input.length;
      const end = textarea.selectionEnd ?? start;
      const nextInput = `${input.slice(0, start)}${pastedText}${input.slice(end)}`;
      const cursor = start + pastedText.length;
      setInput(nextInput);
      updatePluginMentionForTextarea(nextInput, cursor);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(cursor, cursor);
      });
    }
    void addMultimediaAttachments(imageFiles);
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

  function showArtifactPreview(preview: ArtifactPreviewResult): void {
    setArtifactPreview(preview);
    setArtifactTextSelection(null);
    setToolPanelCollapsed(false);
    setToolPanelTab('artifacts');
  }

  function appendArtifactSelectionToComposer(value: string): void {
    const insert = value.trim();
    if (!insert) return;
    setInput((old) => old.trim() ? `${old.trimEnd()}\n\n${insert}` : insert);
    setPluginMentionTrigger(null);
    setArtifactTextSelection(null);
    window.requestAnimationFrame(() => {
      const textarea = chatTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }

  function askAboutArtifactSelection(selection: ArtifactTextSelection): void {
    appendArtifactSelectionToComposer(artifactSelectionQuestionPrompt(selection.artifact, selection.text));
  }

  function addArtifactSelectionContext(selection: ArtifactTextSelection): void {
    appendArtifactSelectionToComposer(artifactSelectionContextPrompt(selection.artifact, selection.text));
  }

  function startChatSplitResize(event: {
    clientX: number;
    pointerId: number;
    currentTarget: HTMLDivElement;
    preventDefault: () => void;
  }): void {
    if (toolPanelCollapsed) return;
    const grid = chatContentGridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    if (rect.width <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const updateSplit = (clientX: number): void => {
      const next = ((clientX - rect.left) / rect.width) * 100;
      setChatSplitPercent(Math.min(72, Math.max(22, next)));
    };
    updateSplit(event.clientX);
    const handlePointerMove = (moveEvent: PointerEvent): void => {
      updateSplit(moveEvent.clientX);
    };
    const stopResize = (): void => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  return (
    <section className="page chat-page">
      <div className="chat-header">
        <div className="chat-session-title">{props.tr('Assistant Chat', '助手对话')}</div>
        <div className="chat-actions">
          <button
            className="lang-toggle chat-lang-toggle"
            onClick={() => props.setLanguage((current) => (current === 'zh' ? 'en' : 'zh'))}
          >
            {props.language === 'zh' ? 'EN' : '中文'}
          </button>
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
      <div className={`chat-content-grid ${toolPanelCollapsed ? 'tool-panel-collapsed' : ''}`} ref={chatContentGridRef} style={chatGridStyle}>
        <div className="chat-messages" ref={chatMessagesRef}>
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
              liveContentPreview={runBusy && m.role === 'assistant' && idx === visibleMessages.length - 1 && m.content.trim().length > 0}
              liveReasoningPreview={runBusy && m.role === 'assistant' && idx === visibleMessages.length - 1 && Boolean(m.reasoning_content?.trim())}
              onPreviewArtifact={showArtifactPreview}
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
        {!toolPanelCollapsed && (
          <div
            className="chat-split-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={props.tr('Resize chat and side panel', '调整对话和右侧面板宽度')}
            title={props.tr('Drag to resize chat and side panel', '拖动调整对话和右侧面板宽度')}
            onPointerDown={startChatSplitResize}
          />
        )}
        <div className={`tool-panel ${toolPanelCollapsed ? 'collapsed' : ''} ${webPreviewExpanded ? 'web-preview-floating' : ''}`}>
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
                className={`tool-panel-tab ${toolPanelTab === 'artifacts' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'artifacts'}
                onClick={() => setToolPanelTab('artifacts')}
              >
                <span className="tool-panel-tab-icon" aria-hidden="true">□</span>
                <span className="tool-panel-tab-label">{props.tr('File Preview', '文件预览')}</span>
                <span className="tool-panel-tab-count">{artifactPreview ? 1 : 0}</span>
              </button>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'browser' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'browser'}
                onClick={() => setToolPanelTab('browser')}
              >
                <span className="tool-panel-tab-icon" aria-hidden="true">⌂</span>
                <span className="tool-panel-tab-label">{props.tr('Browser', '内部浏览器')}</span>
                <span className="tool-panel-tab-count">{shouldShowWebPreview ? 1 : 0}</span>
              </button>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'tools' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'tools'}
                onClick={() => setToolPanelTab('tools')}
              >
                <span className="tool-panel-tab-icon" aria-hidden="true">⚙</span>
                <span className="tool-panel-tab-label">{props.tr('Tool Trace', '工具轨迹')}</span>
                <span className="tool-panel-tab-count">{props.toolEvents.length}</span>
              </button>
            </div>
          </div>
          <div className={`tool-panel-body ${toolPanelTab === 'browser' ? 'browser-preview-body' : ''} ${toolPanelTab === 'artifacts' ? 'artifact-preview-body' : ''}`} ref={toolPanelBodyRef}>
            {toolPanelTab === 'artifacts' ? (
              artifactPreview ? (
                <div className="artifact-side-preview">
                  <div className="artifact-side-preview-head">
                    <div>
                      <strong>{artifactPreview.artifact.name}</strong>
                      <p>{artifactPreview.artifact.kind} | {formatBytes(artifactPreview.artifact.sizeBytes)}</p>
                    </div>
                    <div className="artifact-side-preview-actions">
                      <button className="mini-button" onClick={() => void window.tasiHarness.app.openArtifact({ path: artifactPreview.artifact.path, absPath: artifactPreview.artifact.absPath })}>
                        {props.tr('Open', '打开')}
                      </button>
                      <button className="mini-button" onClick={() => void window.tasiHarness.app.revealArtifact({ path: artifactPreview.artifact.path, absPath: artifactPreview.artifact.absPath })}>
                        {props.tr('Folder', '目录')}
                      </button>
                    </div>
                  </div>
                  <ArtifactPreviewContent preview={artifactPreview} onTextSelection={setArtifactTextSelection} />
                  {artifactTextSelection && artifactTextSelection.artifact.id === artifactPreview.artifact.id && (
                    <div
                      className="artifact-selection-toolbar"
                      style={{ left: artifactTextSelection.x, top: artifactTextSelection.y }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <button type="button" className="mini-button" onClick={() => askAboutArtifactSelection(artifactTextSelection)}>
                        {props.tr('Ask', '提问')}
                      </button>
                      <button type="button" className="mini-button" onClick={() => addArtifactSelectionContext(artifactTextSelection)}>
                        {props.tr('Add', '加入')}
                      </button>
                      <button type="button" className="mini-button" onClick={() => setArtifactTextSelection(null)}>
                        x
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="tool-empty">{props.tr('Previewable files from assistant replies will appear here after you click Preview.', '点击回复中文件的“预览”后，会在这里显示可预览文件。')}</div>
              )
            ) : toolPanelTab === 'browser' ? (
              showEmbeddedWebPreview ? (
                <div
                  className={`tool-web-preview ${webPreviewExpanded ? 'expanded' : ''} ${previewDragging ? 'dragging' : ''}`}
                  style={webPreviewExpanded && webPreviewRect ? {
                    left: 0,
                    top: 0,
                    width: webPreviewRect.width,
                    height: webPreviewRect.height,
                    transform: `translate3d(${webPreviewRect.x}px, ${webPreviewRect.y}px, 0)`
                  } : undefined}
                >
                  <div className="tool-web-preview-toolbar">
                    <button
                      className="mini-button tool-web-preview-icon-button"
                      onClick={handlePreviewBack}
                      disabled={!previewCanGoBack}
                      title={props.tr('Back', '后退')}
                      aria-label={props.tr('Back', '后退')}
                    >
                      <BrowserToolbarIcon kind="back" />
                    </button>
                    <button
                      className="mini-button tool-web-preview-icon-button"
                      onClick={handlePreviewForward}
                      disabled={!previewCanGoForward}
                      title={props.tr('Forward', '前进')}
                      aria-label={props.tr('Forward', '前进')}
                    >
                      <BrowserToolbarIcon kind="forward" />
                    </button>
                    <button
                      className={`mini-button tool-web-preview-icon-button ${previewLoading ? 'loading' : ''}`}
                      onClick={handlePreviewRefresh}
                      title={props.tr('Refresh', '刷新')}
                      aria-label={props.tr('Refresh', '刷新')}
                    >
                      <BrowserToolbarIcon kind="refresh" />
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
                    <button
                      type="button"
                      className="mini-button tool-web-preview-open tool-web-preview-icon-button"
                      onClick={() => void navigatePreviewToAddress()}
                      title={props.tr('Go to address', '进入地址')}
                      aria-label={props.tr('Go to address', '进入地址')}
                    >
                      <BrowserToolbarIcon kind="open" />
                    </button>
                  </div>
                  {shouldShowWebPreview ? (
                    <div className="tool-web-preview-body" ref={previewBodyRef}>
                      <webview
                        ref={previewWebviewRef}
                        key={`${EMBEDDED_BROWSER_PARTITION}:${previewUrl || 'blank'}`}
                        className="tool-web-preview-frame"
                        src={previewUrl || 'about:blank'}
                        partition={EMBEDDED_BROWSER_PARTITION}
                        webpreferences="zoomFactor=1"
                      />
                    </div>
                  ) : (
                    <div className="tool-web-preview-empty">
                      {props.tr('Browser pages opened by tools will appear here.', '工具打开的网页会显示在这里。')}
                    </div>
                  )}
                </div>
              ) : (
                <div className="tool-empty">{props.tr('Built-in browser mode is disabled. Switch Browser Mode to Built-in browser to preview pages here.', '内部浏览器模式未启用。将浏览器模式切换为“内部浏览器”后，网页会在这里预览。')}</div>
              )
            ) : props.toolEvents.length === 0 ? (
              <div className="tool-empty">{props.tr('Tool requests and results will appear here in a separate scrollable pane.', '工具请求和结果会显示在这里。')}</div>
            ) : (
              visibleToolEvents.map((event) => (
                <ToolEventCard key={event.id} event={event} sessionId={props.sessionId} tr={props.tr} />
              ))
            )}
          </div>
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
              ref={chatTextareaRef}
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
              onChange={(e) => {
                setInput(e.target.value);
                updatePluginMentionForTextarea(e.target.value, e.target.selectionStart);
              }}
              onClick={(e) => updatePluginMentionForTextarea(e.currentTarget.value, e.currentTarget.selectionStart)}
              onSelect={(e) => updatePluginMentionForTextarea(e.currentTarget.value, e.currentTarget.selectionStart)}
              onPaste={handleTextareaPaste}
              onKeyDown={(e) => {
                if (pluginMentionTrigger) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setPluginMentionActiveIndex((index) => (index + 1) % Math.max(1, pluginMentionOptions.length));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setPluginMentionActiveIndex((index) => (index - 1 + Math.max(1, pluginMentionOptions.length)) % Math.max(1, pluginMentionOptions.length));
                    return;
                  }
                  if ((e.key === 'Enter' || e.key === 'Tab') && pluginMentionOptions.length > 0) {
                    e.preventDefault();
                    insertPluginMention(pluginMentionOptions[pluginMentionActiveIndex] ?? pluginMentionOptions[0]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setPluginMentionTrigger(null);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {showPluginMentionMenu && (
              <div className="plugin-mention-menu" role="listbox" aria-label={props.tr('Plugin mentions', '插件引用')}>
                <div className="plugin-mention-header">{props.tr('Plugins', '插件')}</div>
                {pluginMentionLoading && <div className="plugin-mention-empty">{props.tr('Loading plugins...', '正在加载插件...')}</div>}
                {!pluginMentionLoading && pluginMentionError && <div className="plugin-mention-empty">{pluginMentionError}</div>}
                {!pluginMentionLoading && !pluginMentionError && pluginMentionOptions.length === 0 && (
                  <div className="plugin-mention-empty">{props.tr('No installed plugins matched.', '未匹配到已安装插件。')}</div>
                )}
                {!pluginMentionLoading && !pluginMentionError && pluginMentionOptions.map((item, index) => (
                  <button
                    key={item.plugin.id}
                    type="button"
                    className={`plugin-mention-item ${index === pluginMentionActiveIndex ? 'active' : ''}`}
                    role="option"
                    aria-selected={index === pluginMentionActiveIndex}
                    onMouseEnter={() => setPluginMentionActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertPluginMention(item);
                    }}
                  >
                    <span className="plugin-mention-name">{item.label}</span>
                    <span className={`plugin-mention-status ${item.status}`}>{item.status}</span>
                    <span className="plugin-mention-detail">{item.detail}</span>
                  </button>
                ))}
              </div>
            )}
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

function artifactFileName(value: string): string {
  return value.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? value.trim();
}

function normalizeArtifactClickText(value: string): string {
  return decodeLikelyPercentEncodedChineseText(value)
    .trim()
    .replace(/^['"`<(\[]+/, '')
    .replace(/['"`>)\].,;:，。；：]+$/, '');
}

function findClickedArtifact(value: string, artifacts?: AgentArtifactRef[]): AgentArtifactRef | null {
  const candidate = normalizeArtifactClickText(value);
  if (!candidate || !artifacts || artifacts.length === 0) return null;
  const candidateName = artifactFileName(candidate).toLocaleLowerCase();
  const candidateLower = candidate.toLocaleLowerCase();
  return artifacts.find((artifact) => {
    const values = [artifact.name, artifact.path, artifact.absPath ?? ''].filter(Boolean);
    return values.some((item) => {
      const normalized = normalizeArtifactClickText(item).toLocaleLowerCase();
      return normalized === candidateLower || artifactFileName(normalized) === candidateName;
    });
  }) ?? null;
}

function artifactPathExtension(value: string): string {
  const clean = normalizeArtifactClickText(value).replace(/[?#].*$/, '');
  const filename = artifactFileName(clean);
  const match = filename.match(/(\.[A-Za-z0-9]{1,12})$/);
  return match?.[1]?.toLowerCase() ?? '';
}

function isFullArtifactPath(value: string): boolean {
  const candidate = normalizeArtifactClickText(value);
  if (!candidate) return false;
  const hasAbsolutePrefix = /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(candidate) || candidate.startsWith('/');
  return hasAbsolutePrefix && ARTIFACT_EXTENSIONS.has(artifactPathExtension(candidate));
}

function isWorkspaceArtifactPath(value: string): boolean {
  const candidate = normalizeArtifactClickText(value);
  if (!candidate || isFullArtifactPath(candidate)) return false;
  if (/^https?:\/\//i.test(candidate) || /^file:/i.test(candidate)) return false;
  return ARTIFACT_EXTENSIONS.has(artifactPathExtension(candidate));
}

function isClickableArtifactReference(value: string, artifacts?: AgentArtifactRef[]): boolean {
  return Boolean(findClickedArtifact(value, artifacts)) || isFullArtifactPath(value) || isWorkspaceArtifactPath(value);
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function markClickableArtifactCodes(html: string, artifacts?: AgentArtifactRef[]): string {
  const codeBlocks: string[] = [];
  const withoutCodeBlocks = html.replace(/<pre class="msg-code-block">[\s\S]*?<\/pre>/g, (match) => {
    const index = codeBlocks.push(match) - 1;
    return `@@ARTIFACT_CODE_BLOCK_${index}@@`;
  });
  return withoutCodeBlocks
    .replace(/<code>([\s\S]*?)<\/code>/g, (match, encodedText: string) => {
      const text = decodeHtmlText(encodedText);
      if (!isClickableArtifactReference(text, artifacts)) return match;
      return `<code class="artifact-link-code" data-artifact-ref="1" title="Open file">${encodedText}</code>`;
    })
    .replace(/@@ARTIFACT_CODE_BLOCK_(\d+)@@/g, (_match, indexText: string) => codeBlocks[Number(indexText)] ?? '');
}

function renderMarkdownContent(
  content: string,
  keyPrefix: string,
  options?: {
    artifacts?: AgentArtifactRef[];
    sessionId?: string;
    onPreviewArtifact?: (preview: ArtifactPreviewResult) => void;
  }
): ReactElement {
  const normalized = normalizeMarkdownForRender(content);
  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    const code = target?.closest('code[data-artifact-ref]') as HTMLElement | null;
    const artifactText = anchor?.getAttribute('href') || code?.textContent || '';
    const clickedArtifact = findClickedArtifact(artifactText, options?.artifacts);
    if ((clickedArtifact || isFullArtifactPath(artifactText) || isWorkspaceArtifactPath(artifactText)) && options?.onPreviewArtifact) {
      event.preventDefault();
      event.stopPropagation();
      const requestPath = clickedArtifact?.path ?? normalizeArtifactClickText(artifactText);
      const requestAbsPath = clickedArtifact?.absPath;
      void window.tasiHarness.app
        .artifactPreview({ path: requestPath, absPath: requestAbsPath, sessionId: options.sessionId, maxBytes: ARTIFACT_PREVIEW_MAX_BYTES })
        .then((preview) => {
          if (preview.artifact.previewMode === 'external' || preview.artifact.previewMode === 'none') {
            return window.tasiHarness.app.openArtifact({ path: requestPath, absPath: requestAbsPath, sessionId: options.sessionId }).then((result) => {
              if (!result.ok) window.alert(result.content);
            });
          }
          options.onPreviewArtifact?.(preview);
          return undefined;
        })
        .catch((cause) => window.alert(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
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
      dangerouslySetInnerHTML={{ __html: markClickableArtifactCodes(renderMarkdownToHtml(normalized), options?.artifacts) }}
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

function ReasoningListComponent({ content, parts, livePreview, tr }: { content: string; parts?: string[]; livePreview: boolean; tr: TranslateFn }): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const view = useMemo(() => reasoningPanelText(content, parts, livePreview), [content, parts, livePreview]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'auto' });
  }, [view.text, livePreview]);
  if (!view.text) return null;
  return (
    <div className="msg-reasoning">
      <div className="msg-reasoning-title">{tr('Reasoning', '推理过程')}</div>
      <div className="msg-reasoning-list" ref={panelRef}>
        {livePreview && view.clippedText && (
          <div className="msg-reasoning-live-note">
            {tr('Showing the latest reasoning text while streaming.', '实时输出中仅显示最新推理文本。')}
          </div>
        )}
        <pre className="msg-reasoning-body">{view.text}</pre>
      </div>
    </div>
  );
}

const ReasoningList = memo(ReasoningListComponent);

function assistantContentListView(content: string, livePreview = false): { items: string[]; clipped: boolean } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const clipped = livePreview && normalized.length > CONTENT_STREAM_PREVIEW_CHARS;
  const preview = !clipped
    ? normalized
    : normalized.slice(-CONTENT_STREAM_PREVIEW_CHARS).trimStart();

  const blocks: string[] = [];
  const current: string[] = [];
  let fenceChar = '';
  let fenceLength = 0;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current.length = 0;
  };

  for (const line of preview.split('\n')) {
    const fence = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        fenceChar = '';
        fenceLength = 0;
      }
      current.push(line);
      continue;
    }
    if (!fenceChar && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  const items = blocks.flatMap((block) => {
    if (block.length <= LIVE_CONTENT_ITEM_CHARS) return [block];
    const chunks: string[] = [];
    for (let index = 0; index < block.length; index += LIVE_CONTENT_ITEM_CHARS) {
      const chunk = block.slice(index, index + LIVE_CONTENT_ITEM_CHARS).trim();
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  });

  return { items, clipped };
}

function assistantContentPartsView(contents: string[], livePreview = false): { items: string[]; clipped: boolean } {
  const normalized = contents.map((item) => item.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()).filter(Boolean);
  const joined = normalized.join('\n\n');
  const clipped = livePreview && joined.length > CONTENT_STREAM_PREVIEW_CHARS;
  const sourceItems = !clipped
    ? normalized
    : [joined.slice(-CONTENT_STREAM_PREVIEW_CHARS).trimStart()];
  const items = sourceItems.flatMap((block) => {
    if (block.length <= LIVE_CONTENT_ITEM_CHARS) return [block];
    const chunks: string[] = [];
    for (let index = 0; index < block.length; index += LIVE_CONTENT_ITEM_CHARS) {
      const chunk = block.slice(index, index + LIVE_CONTENT_ITEM_CHARS).trim();
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  });
  return { items, clipped };
}

function assistantLiveContentPreviewText(content: string, items?: string[]): { text: string; clipped: boolean } {
  const source = items && items.length > 0
    ? items.map((item) => item.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()).filter(Boolean).join('\n\n')
    : content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const clipped = source.length > CONTENT_STREAM_PREVIEW_CHARS;
  const text = (clipped ? source.slice(-CONTENT_STREAM_PREVIEW_CHARS).trimStart() : source).trim();
  return { text, clipped };
}

function MessageContentListComponent({
  content,
  items: explicitItems,
  livePreview,
  tr,
  title,
  artifacts,
  sessionId,
  onPreviewArtifact
}: {
  content: string;
  items?: string[];
  livePreview: boolean;
  tr: TranslateFn;
  title?: string;
  artifacts?: AgentArtifactRef[];
  sessionId?: string;
  onPreviewArtifact?: (preview: ArtifactPreviewResult) => void;
}): ReactElement | null {
  const liveView = useMemo(
    () => livePreview ? assistantLiveContentPreviewText(content, explicitItems) : undefined,
    [content, explicitItems, livePreview]
  );
  const view = useMemo(
    () => livePreview ? undefined : (explicitItems ? assistantContentPartsView(explicitItems) : assistantContentListView(content)),
    [content, explicitItems, livePreview]
  );
  if (livePreview) {
    if (!liveView?.text) return null;
    return (
      <div className="msg-content-panel live">
        <div className="msg-content-title">
          <span>{title ?? tr('Assistant content', '回复内容')}</span>
          <span>1</span>
        </div>
        <div className="msg-content-list">
          {liveView.clipped && (
            <div className="msg-content-live-note">
              {tr('Showing the latest assistant text while streaming.', '实时输出中仅显示最新回复文本。')}
            </div>
          )}
          <pre className="msg-content-pre">{liveView.text}</pre>
        </div>
      </div>
    );
  }

  if (!view) return null;
  const items = view.items;
  if (items.length === 0) return null;
  return (
    <div className="msg-content-panel final">
      <div className="msg-content-title">
        <span>{title ?? tr('Assistant content', '回复内容')}</span>
        <span>{items.length}</span>
      </div>
      <div className="msg-content-list">
        {items.map((item, index) => (
          <div className="msg-content-item" key={`${index}-${item.length}`}>
            {renderMarkdownContent(item, `msg-content-${index}-${item.length}`, { artifacts, sessionId, onPreviewArtifact })}
          </div>
        ))}
      </div>
    </div>
  );
}

const MessageContentList = memo(MessageContentListComponent);

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

function assistantExportTitle(content: string): string {
  const lines = normalizeMarkdownForRender(content).split('\n');
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line.trim()))?.replace(/^#{1,6}\s+/, '').trim();
  if (heading) return heading.slice(0, 80);
  const firstText = lines.find((line) => line.trim() && !/^```/.test(line.trim()))?.trim() ?? 'Assistant Reply';
  return firstText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1').slice(0, 80);
}

function LegacyMessageBubble({ message }: { message: AgentMessage }): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  const content = message.role === 'user' ? decodeLikelyPercentEncodedChineseText(message.content) : message.content;
  const avatar = message.role === 'assistant' ? 'AI' : (message.external?.provider?.toUpperCase() || 'You');
  return (
    <div className={`msg-row ${role}`}>
      <div className="msg-avatar">{avatar}</div>
      <div className="msg-bubble-wrap">
        <div className="msg-bubble">{renderMarkdownContent(content, `msg-${message.id ?? 'x'}`)}</div>
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

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const PYTHON_BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'bytes', 'dict', 'dir', 'enumerate', 'filter',
  'float', 'format', 'getattr', 'hasattr', 'int', 'isinstance', 'len', 'list',
  'map', 'max', 'min', 'open', 'print', 'range', 'repr', 'reversed', 'round',
  'set', 'sorted', 'str', 'sum', 'super', 'tuple', 'type', 'zip'
]);

function highlightedPythonCode(content: string): Array<string | ReactElement> {
  const tokens: Array<string | ReactElement> = [];
  let index = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (typeof last === 'string') tokens[tokens.length - 1] = `${last}${value}`;
    else tokens.push(value);
  };
  const pushSpan = (className: string, value: string) => {
    if (value) tokens.push(<span key={tokens.length} className={className}>{value}</span>);
  };

  while (index < content.length) {
    const rest = content.slice(index);
    const char = content[index];
    if (char === '#') {
      const end = content.indexOf('\n', index);
      const next = end < 0 ? content.length : end;
      pushSpan('syntax-comment', content.slice(index, next));
      index = next;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const isTriple = content.slice(index, index + 3) === quote.repeat(3);
      let next = index + (isTriple ? 3 : 1);
      while (next < content.length) {
        if (!isTriple && content[next] === '\\') {
          next += 2;
          continue;
        }
        if (isTriple && content.slice(next, next + 3) === quote.repeat(3)) {
          next += 3;
          break;
        }
        if (!isTriple && content[next] === quote) {
          next += 1;
          break;
        }
        if (!isTriple && content[next] === '\n') break;
        next += 1;
      }
      pushSpan('syntax-string', content.slice(index, next));
      index = next;
      continue;
    }
    const decorator = /^@[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (decorator) {
      pushSpan('syntax-decorator', decorator[0]);
      index += decorator[0].length;
      continue;
    }
    const number = /^\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?j?)\b/.exec(rest);
    if (number) {
      pushSpan('syntax-number', number[0]);
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      const word = identifier[0];
      if (PYTHON_KEYWORDS.has(word)) pushSpan('syntax-keyword', word);
      else if (PYTHON_BUILTINS.has(word)) pushSpan('syntax-builtin', word);
      else if (word === 'self' || word === 'cls') pushSpan('syntax-variable', word);
      else pushText(word);
      index += word.length;
      continue;
    }
    pushText(char);
    index += 1;
  }
  return tokens;
}

function selectionAnchorFromRange(range: Range, frameRect?: DOMRect): { x: number; y: number } {
  const rect = range.getBoundingClientRect();
  const offsetX = frameRect?.left ?? 0;
  const offsetY = frameRect?.top ?? 0;
  const x = offsetX + rect.left + Math.max(12, rect.width / 2);
  const y = offsetY + rect.top - 10;
  return {
    x: Math.min(window.innerWidth - 12, Math.max(12, x)),
    y: Math.min(window.innerHeight - 12, Math.max(12, y))
  };
}

function reportArtifactSelection(
  artifact: AgentArtifactRef,
  selection: Selection | null,
  onTextSelection?: (selection: ArtifactTextSelection | null) => void,
  container?: HTMLElement,
  frameRect?: DOMRect
): void {
  if (!onTextSelection) return;
  const text = normalizeArtifactSelectionText(selection?.toString() ?? '');
  if (!selection || selection.rangeCount === 0 || !text) {
    onTextSelection(null);
    return;
  }
  const range = selection.getRangeAt(0);
  if (container && !container.contains(range.commonAncestorContainer)) {
    onTextSelection(null);
    return;
  }
  const anchor = selectionAnchorFromRange(range, frameRect);
  onTextSelection({ artifact, text, x: anchor.x, y: anchor.y });
}

function HtmlArtifactPreview(props: {
  artifact: AgentArtifactRef;
  content: string;
  onTextSelection?: (selection: ArtifactTextSelection | null) => void;
}): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    if (!iframe || !doc || !win) return;
    const capture = () => {
      window.setTimeout(() => {
        reportArtifactSelection(props.artifact, win.getSelection(), props.onTextSelection, undefined, iframe.getBoundingClientRect());
      }, 0);
    };
    doc.addEventListener('mouseup', capture);
    doc.addEventListener('keyup', capture);
    doc.addEventListener('selectionchange', capture);
    return () => {
      doc.removeEventListener('mouseup', capture);
      doc.removeEventListener('keyup', capture);
      doc.removeEventListener('selectionchange', capture);
    };
  }, [loadTick, props.artifact, props.onTextSelection]);

  return (
    <iframe
      ref={iframeRef}
      className="artifact-html-preview"
      srcDoc={props.content}
      title={props.artifact.name}
      sandbox="allow-same-origin allow-scripts"
      onLoad={() => setLoadTick((value) => value + 1)}
    />
  );
}

function ArtifactPreviewContent({ preview, onTextSelection }: {
  preview: ArtifactPreviewResult;
  onTextSelection?: (selection: ArtifactTextSelection | null) => void;
}): ReactElement {
  const artifact = preview.artifact;
  const dataUrl = preview.dataBase64 ? `data:${artifact.mimeType || 'application/octet-stream'};base64,${preview.dataBase64}` : '';
  const isHtmlPreview = ['.html', '.htm'].includes(artifactPathExtension(artifact.name || artifact.path || artifact.absPath));
  const handleSelection = (event: ReactMouseEvent<HTMLDivElement> | ReactKeyboardEvent<HTMLDivElement>) => {
    reportArtifactSelection(artifact, window.getSelection(), onTextSelection, event.currentTarget);
  };
  return (
    <div className="artifact-preview-content" onMouseUp={handleSelection} onKeyUp={handleSelection}>
      {isHtmlPreview && (
        <HtmlArtifactPreview artifact={artifact} content={preview.content ?? ''} onTextSelection={onTextSelection} />
      )}
      {artifact.previewMode === 'markdown' && (
        <div className="artifact-text-preview">{renderMarkdownContent(preview.content ?? '', `artifact-${artifact.id}`)}</div>
      )}
      {artifact.previewMode === 'code' && !isHtmlPreview && (
        <CodeArtifactPreview name={artifact.name || artifact.path} content={preview.content ?? ''} />
      )}
      {artifact.previewMode === 'office' && (
        <OfficePreviewContent artifact={artifact} dataBase64={preview.dataBase64 ?? ''} />
      )}
      {artifact.previewMode === 'text' && !isHtmlPreview && (
        <pre className="artifact-text-preview">{preview.content ?? ''}</pre>
      )}
      {artifact.previewMode === 'image' && (
        <img className="artifact-image-preview" src={dataUrl} alt={artifact.name} />
      )}
      {artifact.previewMode === 'pdf' && (
        <PdfPreviewContent dataBase64={preview.dataBase64 ?? ''} name={artifact.name} mimeType={artifact.mimeType || 'application/pdf'} />
      )}
      {artifact.previewMode === 'media' && artifact.mimeType?.startsWith('audio/') && (
        <audio className="artifact-media-preview" controls src={dataUrl} />
      )}
      {artifact.previewMode === 'media' && !artifact.mimeType?.startsWith('audio/') && (
        <video className="artifact-media-preview" controls src={dataUrl} />
      )}
      {artifact.previewMode === 'model3d' && (
        <StlPreviewCanvas dataBase64={preview.dataBase64 ?? ''} name={artifact.name} />
      )}
    </div>
  );
}

function codeLanguageFromFilename(name: string): string {
  switch (artifactPathExtension(name).toLowerCase()) {
    case '.py': return 'python';
    case '.js': return 'javascript';
    case '.jsx': return 'jsx';
    case '.ts': return 'typescript';
    case '.tsx': return 'tsx';
    case '.json': return 'json';
    case '.html':
    case '.htm': return 'html';
    case '.css': return 'css';
    case '.xml': return 'xml';
    case '.yaml':
    case '.yml': return 'yaml';
    case '.java': return 'java';
    case '.go': return 'go';
    case '.rs': return 'rust';
    case '.c': return 'c';
    case '.cpp':
    case '.hpp': return 'cpp';
    case '.h': return 'c/c++ header';
    case '.cs': return 'csharp';
    case '.php': return 'php';
    case '.rb': return 'ruby';
    case '.sh': return 'shell';
    case '.sql': return 'sql';
    case '.toml': return 'toml';
    case '.ini': return 'ini';
    case '.env': return 'env';
    default: return 'code';
  }
}

function CodeArtifactPreview({ name, content }: { name: string; content: string }): ReactElement {
  const language = codeLanguageFromFilename(name);
  const renderedContent = language === 'python' ? highlightedPythonCode(content) : content;
  return (
    <div className="artifact-code-preview">
      <div className="artifact-code-preview-head">
        <strong>{name}</strong>
        <span>{language}</span>
      </div>
      <pre className="artifact-code-block">
        <code className={`language-${language.replace(/[^a-z0-9_-]+/gi, '-')}`}>{renderedContent}</code>
      </pre>
    </div>
  );
}

function ArtifactPreviewModal({ preview, tr, onClose }: { preview: ArtifactPreviewResult; tr: TranslateFn; onClose: () => void }): ReactElement {
  const artifact = preview.artifact;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card artifact-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{artifact.name}</strong>
            <p>{artifact.kind} | {formatBytes(artifact.sizeBytes)}</p>
          </div>
          <button className="mini-button" onClick={onClose}>{tr('Close', '关闭')}</button>
        </div>
        <ArtifactPreviewContent preview={preview} />
      </div>
    </div>
  );
}

type PdfOutlineItem = {
  title: string;
  page?: number;
  items: PdfOutlineItem[];
};

type PdfDocumentHandle = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<unknown>;
  getOutline: () => Promise<unknown[] | null>;
  getDestination: (dest: string) => Promise<unknown>;
  getPageIndex: (ref: unknown) => Promise<number>;
  destroy: () => Promise<void>;
};

type PdfPageHandle = {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<unknown>;
  render: (params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { cancel: () => void; promise: Promise<unknown> };
};

type PdfTextLayerHandle = {
  cancel: () => void;
  render: () => Promise<unknown>;
};

function PdfPreviewContent({ dataBase64, name }: { dataBase64: string; name: string; mimeType: string }): ReactElement {
  const pageHostRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PdfDocumentHandle | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
  const textLayerTaskRef = useRef<PdfTextLayerHandle | null>(null);
  const wheelPageTurnAtRef = useRef(0);
  const pendingScrollAnchorRef = useRef<'top' | 'bottom'>('top');
  const manualScaleRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.15);
  const [outline, setOutline] = useState<PdfOutlineItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setPageCount(0);
    setCurrentPage(1);
    setOutline([]);

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const loadingTask = pdfjs.getDocument({ data: base64ToUint8Array(dataBase64) });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        pdfRef.current = pdf as PdfDocumentHandle;
        setPageCount(pdf.numPages);
        setOutline(await buildPdfOutline(pdf as PdfDocumentHandle));
        setLoading(false);
        manualScaleRef.current = false;
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerTaskRef.current?.cancel();
      textLayerTaskRef.current = null;
      const pdf = pdfRef.current;
      pdfRef.current = null;
      void pdf?.destroy();
    };
  }, [dataBase64]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const pageHost = pageHostRef.current;
    if (!pdf || !pageHost || loading || pageCount <= 0 || manualScaleRef.current) return;
    const pdfHandle = pdf;
    const hostElement = pageHost;
    let cancelled = false;

    async function fitPageToHost(): Promise<void> {
      const page = await pdfHandle.getPage(currentPage) as PdfPageHandle;
      if (cancelled) return;
      const viewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(240, hostElement.clientWidth - 36);
      const availableHeight = Math.max(240, hostElement.clientHeight - 36);
      const nextScale = Math.max(0.25, Math.min(2.4, Math.min(availableWidth / viewport.width, availableHeight / viewport.height)));
      setScale(Number(nextScale.toFixed(2)));
    }

    void fitPageToHost().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });

    const observer = new ResizeObserver(() => {
      void fitPageToHost();
    });
    observer.observe(hostElement);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [currentPage, loading, pageCount]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const host = canvasHostRef.current;
    if (!pdf || !host || loading || pageCount <= 0) return;
    let cancelled = false;
    setRendering(true);
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    textLayerTaskRef.current?.cancel();
    textLayerTaskRef.current = null;
    host.innerHTML = '';

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const page = await pdf.getPage(currentPage) as PdfPageHandle;
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const pageLayer = document.createElement('div');
        pageLayer.className = 'artifact-pdf-page-layer';
        pageLayer.style.width = `${Math.floor(viewport.width)}px`;
        pageLayer.style.height = `${Math.floor(viewport.height)}px`;
        pageLayer.style.setProperty('--total-scale-factor', String(scale));
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot create PDF canvas context.');
        const deviceScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
        pageLayer.appendChild(canvas);
        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer artifact-pdf-text-layer';
        pageLayer.appendChild(textLayer);
        host.appendChild(pageLayer);
        const renderTask = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = renderTask;
        const textContent = await page.getTextContent();
        if (cancelled) return;
        const PdfTextLayer = pdfjs.TextLayer as unknown as new (params: {
          textContentSource: unknown;
          container: HTMLElement;
          viewport: unknown;
        }) => PdfTextLayerHandle;
        const textLayerTask = new PdfTextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport
        }) as PdfTextLayerHandle;
        textLayerTaskRef.current = textLayerTask;
        await Promise.all([renderTask.promise, textLayerTask.render()]);
        const pageHost = pageHostRef.current;
        if (pageHost && !cancelled) {
          const top = pendingScrollAnchorRef.current === 'bottom' ? pageHost.scrollHeight : 0;
          pageHost.scrollTo({ top, left: 0 });
          pendingScrollAnchorRef.current = 'top';
        }
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerTaskRef.current?.cancel();
      textLayerTaskRef.current = null;
    };
  }, [currentPage, loading, pageCount, scale]);

  function goToPage(page: number, scrollAnchor: 'top' | 'bottom' = 'top'): void {
    if (pageCount <= 0) return;
    pendingScrollAnchorRef.current = scrollAnchor;
    setCurrentPage(Math.min(pageCount, Math.max(1, page)));
  }

  function zoomBy(delta: number): void {
    manualScaleRef.current = true;
    setScale((old) => Math.min(2.8, Math.max(0.25, Number((old + delta).toFixed(2)))));
  }

  function handlePageWheel(event: ReactWheelEvent<HTMLDivElement>): void {
    if (loading || rendering || pageCount <= 1 || Math.abs(event.deltaY) < 8) return;
    const host = pageHostRef.current;
    if (!host) return;
    const now = Date.now();
    if (now - wheelPageTurnAtRef.current < 360) return;
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    const atTop = host.scrollTop <= 2;
    const atBottom = host.scrollTop >= maxScrollTop - 2;
    const canTurnForward = event.deltaY > 0 && atBottom && currentPage < pageCount;
    const canTurnBackward = event.deltaY < 0 && atTop && currentPage > 1;
    if (!canTurnForward && !canTurnBackward) return;
    if (event.cancelable) event.preventDefault();
    wheelPageTurnAtRef.current = now;
    goToPage(currentPage + (canTurnForward ? 1 : -1), canTurnForward ? 'top' : 'bottom');
  }

  const pdf = pdfRef.current;

  return (
    <div className="artifact-pdf-native" aria-label={name}>
      <div className="artifact-office-toolbar">
        <button className="mini-button" disabled={loading || currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{'<'}</button>
        <span>{loading ? 'Loading...' : `${currentPage} / ${pageCount}`}</span>
        <button className="mini-button" disabled={loading || currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{'>'}</button>
        <button className="mini-button" disabled={scale <= 0.3} onClick={() => zoomBy(-0.15)}>-</button>
        <button className="mini-button" disabled={scale >= 2.6} onClick={() => zoomBy(0.15)}>+</button>
      </div>
      {error && <div className="tool-empty">{error}</div>}
      <div className="artifact-pdf-body">
        {!loading && pdf && pageCount > 0 && (
          <PdfThumbnailSidebar pdf={pdf} pageCount={pageCount} currentPage={currentPage} outline={outline} onGoToPage={goToPage} />
        )}
        <div ref={pageHostRef} className="artifact-pdf-page-host" onWheel={handlePageWheel}>
          {loading && <div className="tool-empty">Loading PDF preview...</div>}
          {rendering && !loading && <div className="artifact-pdf-rendering">Rendering page...</div>}
          <div ref={canvasHostRef} className="artifact-pdf-canvas-host" />
        </div>
      </div>
    </div>
  );
}

function PdfThumbnailSidebar({
  pdf,
  pageCount,
  currentPage,
  outline,
  onGoToPage
}: {
  pdf: PdfDocumentHandle;
  pageCount: number;
  currentPage: number;
  outline: PdfOutlineItem[];
  onGoToPage: (page: number) => void;
}): ReactElement {
  return (
    <aside className="artifact-pdf-sidebar">
      <div className="artifact-pdf-thumbnail-list">
        {Array.from({ length: pageCount }, (_unused, index) => {
          const pageNumber = index + 1;
          return (
            <PdfPageThumbnail
              key={pageNumber}
              pdf={pdf}
              pageNumber={pageNumber}
              active={pageNumber === currentPage}
              onClick={() => onGoToPage(pageNumber)}
            />
          );
        })}
      </div>
      {outline.length > 0 && (
        <div className="artifact-pdf-outline">
          <strong>Outline</strong>
          {renderPdfOutline(outline, onGoToPage)}
        </div>
      )}
    </aside>
  );
}

function PdfPageThumbnail({
  pdf,
  pageNumber,
  active,
  onClick
}: {
  pdf: PdfDocumentHandle;
  pageNumber: number;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  const itemRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const item = itemRef.current;
    if (!item) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(item);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active) itemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visible || error) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber) as PdfPageHandle;
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const targetWidth = 58;
        const viewport = page.getViewport({ scale: targetWidth / Math.max(1, baseViewport.width) });
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Cannot create thumbnail canvas context.');
        const deviceScale = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          setError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [error, pageNumber, pdf, visible]);

  return (
    <button ref={itemRef} className={`artifact-pdf-thumbnail ${active ? 'active' : ''}`} onClick={onClick} title={`Page ${pageNumber}`}>
      <span>{pageNumber}</span>
      <canvas ref={canvasRef} aria-hidden="true" />
    </button>
  );
}

async function buildPdfOutline(pdf: PdfDocumentHandle): Promise<PdfOutlineItem[]> {
  const rawOutline = await pdf.getOutline().catch(() => null);
  async function mapItems(items: unknown[] | null): Promise<PdfOutlineItem[]> {
    const mapped: PdfOutlineItem[] = [];
    for (const item of items ?? []) {
      const record = item as { title?: string; dest?: unknown; items?: unknown[] };
      let page: number | undefined;
      try {
        const dest = typeof record.dest === 'string' ? await pdf.getDestination(record.dest) : record.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref) page = (await pdf.getPageIndex(ref)) + 1;
      } catch {
        page = undefined;
      }
      mapped.push({
        title: record.title?.trim() || `Page ${page ?? '?'}`,
        page,
        items: await mapItems(record.items ?? [])
      });
    }
    return mapped;
  }
  return mapItems(rawOutline);
}

function renderPdfOutline(items: PdfOutlineItem[], goToPage: (page: number) => void): ReactElement {
  return (
    <div className="artifact-pdf-outline-list">
      {items.map((item, index) => (
        <div key={`${item.title}-${item.page ?? 'x'}-${index}`} className="artifact-pdf-outline-item">
          <button disabled={!item.page} onClick={() => item.page && goToPage(item.page)} title={item.title}>
            {item.title}
          </button>
          {item.items.length > 0 && renderPdfOutline(item.items, goToPage)}
        </div>
      ))}
    </div>
  );
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function OfficePreviewContent({ artifact, dataBase64 }: { artifact: AgentArtifactRef; dataBase64: string }): ReactElement {
  const ext = artifactPathExtension(artifact.name || artifact.path);
  if (!dataBase64) return <div className="tool-empty">Office preview data is empty.</div>;
  if (artifact.mimeType === 'application/pdf') return <PdfPreviewContent dataBase64={dataBase64} name={artifact.name} mimeType="application/pdf" />;
  if (ext === '.docx') return <DocxOfficePreview dataBase64={dataBase64} name={artifact.name} />;
  if (ext === '.xlsx') return <XlsxOfficePreview dataBase64={dataBase64} />;
  if (ext === '.pptx') return <PptxOfficePreview dataBase64={dataBase64} />;
  return <div className="tool-empty">This Office format is not supported by the built-in previewer.</div>;
}

function DocxOfficePreview({ dataBase64, name }: { dataBase64: string; name: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    container.innerHTML = '';
    setError('');

    void (async () => {
      try {
        const docx = await import('docx-preview');
        if (cancelled) return;
        await docx.renderAsync(arrayBufferFromBytes(base64ToUint8Array(dataBase64)), container, container, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true
        });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [dataBase64]);

  return (
    <div className="artifact-office-native artifact-docx-native" aria-label={name}>
      {error && <div className="tool-empty">{error}</div>}
      <div ref={containerRef} className="artifact-docx-container" />
    </div>
  );
}

function XlsxOfficePreview({ dataBase64 }: { dataBase64: string }): ReactElement {
  const [state, setState] = useState<{ loading: boolean; error: string; sheetNames: string[]; htmlBySheet: Record<string, string> }>({
    loading: true,
    error: '',
    sheetNames: [],
    htmlBySheet: {}
  });
  const [activeSheet, setActiveSheet] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', sheetNames: [], htmlBySheet: {} });
    setActiveSheet('');

    void (async () => {
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(base64ToUint8Array(dataBase64), { type: 'array', cellDates: true, cellStyles: true });
        const htmlBySheet: Record<string, string> = {};
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) continue;
          htmlBySheet[sheetName] = XLSX.utils.sheet_to_html(sheet, { id: `sheet-${sheetName.replace(/[^a-z0-9_-]+/gi, '-')}` });
        }
        if (!cancelled) {
          setState({ loading: false, error: '', sheetNames: workbook.SheetNames, htmlBySheet });
          setActiveSheet(workbook.SheetNames[0] ?? '');
        }
      } catch (cause) {
        if (!cancelled) setState({ loading: false, error: cause instanceof Error ? cause.message : String(cause), sheetNames: [], htmlBySheet: {} });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataBase64]);

  if (state.loading) return <div className="tool-empty">Loading spreadsheet preview...</div>;
  if (state.error) return <div className="tool-empty">{state.error}</div>;
  if (state.sheetNames.length === 0) return <div className="tool-empty">No worksheet found.</div>;

  const activeHtml = state.htmlBySheet[activeSheet] ?? '';
  return (
    <div className="artifact-office-native artifact-xlsx-native">
      <div className="artifact-sheet-tabs">
        {state.sheetNames.map((sheetName) => (
          <button
            key={sheetName}
            className={`artifact-sheet-tab ${sheetName === activeSheet ? 'active' : ''}`}
            onClick={() => setActiveSheet(sheetName)}
            title={sheetName}
          >
            {sheetName}
          </button>
        ))}
      </div>
      <div className="artifact-xlsx-grid" dangerouslySetInnerHTML={{ __html: activeHtml }} />
    </div>
  );
}

function PptxOfficePreview({ dataBase64 }: { dataBase64: string }): ReactElement {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ReturnType<(typeof import('pptx-preview'))['init']> | null>(null);
  const [width, setWidth] = useState(960);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideCount, setSlideCount] = useState(0);
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (nextWidth > 0) setWidth(nextWidth);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let viewer: ReturnType<(typeof import('pptx-preview'))['init']> | null = null;
    viewerRef.current?.destroy?.();
    viewerRef.current = null;
    container.innerHTML = '';
    setLoading(true);
    setError('');
    setSlideCount(0);
    setCurrentSlide(0);

    void (async () => {
      try {
        const pptx = await import('pptx-preview');
        if (cancelled) return;
        const viewportWidth = Math.max(360, width - 20);
        viewer = pptx.init(container, { width: viewportWidth, height: Math.round((viewportWidth * 9) / 16), mode: 'slide' });
        viewerRef.current = viewer;
        await viewer.load(arrayBufferFromBytes(base64ToUint8Array(dataBase64)));
        if (cancelled) return;
        const count = Number(viewer.slideCount) || 0;
        setSlideCount(count);
        if (count > 0) {
          viewer.renderSingleSlide(0);
          setCurrentSlide(0);
        }
        setLoading(false);
      } catch (cause) {
        if (!cancelled) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
      viewer?.destroy?.();
      if (viewerRef.current === viewer) viewerRef.current = null;
      container.innerHTML = '';
    };
  }, [dataBase64, width]);

  function goToSlide(nextSlide: number): void {
    const viewer = viewerRef.current;
    if (!viewer || slideCount <= 0) return;
    const normalized = (nextSlide + slideCount) % slideCount;
    viewer.renderSingleSlide(normalized);
    setCurrentSlide(normalized);
  }

  return (
    <div ref={shellRef} className="artifact-office-native artifact-pptx-native">
      <div className="artifact-office-toolbar">
        <button className="mini-button" disabled={loading || slideCount <= 1} onClick={() => goToSlide(currentSlide - 1)}>{'<'}</button>
        <span>{loading ? 'Loading...' : `${slideCount > 0 ? currentSlide + 1 : 0} / ${slideCount}`}</span>
        <button className="mini-button" disabled={loading || slideCount <= 1} onClick={() => goToSlide(currentSlide + 1)}>{'>'}</button>
      </div>
      {error && <div className="tool-empty">{error}</div>}
      <div ref={containerRef} className="artifact-pptx-container" />
    </div>
  );
}

function StlPreviewCanvas({ dataBase64, name }: { dataBase64: string; name: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !dataBase64) return;
    setError('');

    let animationId = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let geometry: THREE.BufferGeometry | null = null;
    let material: THREE.MeshStandardMaterial | null = null;
    let edgeGeometry: THREE.EdgesGeometry | null = null;
    let edgeMaterial: THREE.LineBasicMaterial | null = null;
    const scene = new THREE.Scene();

    try {
      const bytes = base64ToUint8Array(dataBase64);
      const sourceBuffer = new Uint8Array(bytes).buffer;
      geometry = new STLLoader().parse(sourceBuffer);
      geometry.computeBoundingBox();
      geometry.computeVertexNormals();
      const box = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      geometry.translate(-center.x, -center.y, -center.z);

      const width = Math.max(320, container.clientWidth || 640);
      const height = Math.max(320, container.clientHeight || 520);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const distance = (maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(45) / 2))) * 1.65;
      const camera = new THREE.PerspectiveCamera(45, width / height, Math.max(0.01, maxDim / 1000), distance * 8);
      camera.position.set(distance, -distance * 1.15, distance * 0.65);
      camera.up.set(0, 0, 1);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setClearColor(0x071018, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      renderer.domElement.className = 'artifact-model-canvas';
      container.replaceChildren(renderer.domElement);

      const ambient = new THREE.HemisphereLight(0xd8f3ff, 0x24313f, 1.4);
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
      keyLight.position.set(distance, -distance, distance * 1.6);
      const fillLight = new THREE.DirectionalLight(0x66ccff, 0.8);
      fillLight.position.set(-distance, distance, distance * 0.5);
      scene.add(ambient, keyLight, fillLight);

      material = new THREE.MeshStandardMaterial({
        color: 0x83d9ff,
        roughness: 0.48,
        metalness: 0.12,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      const vertexCount = geometry.getAttribute('position')?.count ?? 0;
      if (vertexCount < 180_000) {
        edgeGeometry = new THREE.EdgesGeometry(geometry, 28);
        edgeMaterial = new THREE.LineBasicMaterial({ color: 0x133241, transparent: true, opacity: 0.32 });
        scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
      }

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;
      controls.target.set(0, 0, 0);
      controls.minDistance = Math.max(0.01, distance * 0.08);
      controls.maxDistance = distance * 5;
      controls.update();

      const resize = (): void => {
        if (!renderer) return;
        const nextWidth = Math.max(320, container.clientWidth || width);
        const nextHeight = Math.max(320, container.clientHeight || height);
        camera.aspect = nextWidth / nextHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(nextWidth, nextHeight, false);
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);

      const render = (): void => {
        if (!renderer || !controls) return;
        controls.update();
        renderer.render(scene, camera);
        animationId = window.requestAnimationFrame(render);
      };
      render();

      return () => {
        resizeObserver.disconnect();
        window.cancelAnimationFrame(animationId);
        controls?.dispose();
        geometry?.dispose();
        material?.dispose();
        edgeGeometry?.dispose();
        edgeMaterial?.dispose();
        renderer?.dispose();
        renderer?.domElement.remove();
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return () => {
        window.cancelAnimationFrame(animationId);
        controls?.dispose();
        geometry?.dispose();
        material?.dispose();
        edgeGeometry?.dispose();
        edgeMaterial?.dispose();
        renderer?.dispose();
        renderer?.domElement.remove();
      };
    }
  }, [dataBase64]);

  return (
    <div ref={containerRef} className="artifact-model-preview" aria-label={name}>
      {error && <div className="tool-empty">{error}</div>}
    </div>
  );
}

function base64ToUint8Array(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function MessageArtifactsComponent({ artifacts, sessionId, tr, onPreviewArtifact }: { artifacts?: AgentArtifactRef[]; sessionId?: string; tr: TranslateFn; onPreviewArtifact?: (preview: ArtifactPreviewResult) => void }): ReactElement | null {
  const [preview, setPreview] = useState<ArtifactPreviewResult | null>(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  if (!artifacts || artifacts.length === 0) return null;

  async function openArtifact(artifact: AgentArtifactRef): Promise<void> {
    setBusyId(`open:${artifact.id}`);
    setError('');
    try {
      const result = await window.tasiHarness.app.openArtifact({ path: artifact.path, absPath: artifact.absPath, sessionId });
      if (!result.ok) setError(result.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId('');
    }
  }

  async function revealArtifact(artifact: AgentArtifactRef): Promise<void> {
    setBusyId(`reveal:${artifact.id}`);
    setError('');
    try {
      const result = await window.tasiHarness.app.revealArtifact({ path: artifact.path, absPath: artifact.absPath, sessionId });
      if (!result.ok) setError(result.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId('');
    }
  }

  async function previewArtifact(artifact: AgentArtifactRef): Promise<void> {
    setBusyId(`preview:${artifact.id}`);
    setError('');
    try {
      const result = await window.tasiHarness.app.artifactPreview({ path: artifact.path, absPath: artifact.absPath, sessionId, maxBytes: ARTIFACT_PREVIEW_MAX_BYTES });
      if (result.artifact.previewMode === 'external' || result.artifact.previewMode === 'none') {
        const opened = await window.tasiHarness.app.openArtifact({ path: artifact.path, absPath: artifact.absPath, sessionId });
        if (!opened.ok) setError(opened.content);
      } else if (onPreviewArtifact) {
        onPreviewArtifact(result);
      } else {
        setPreview(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId('');
    }
  }

  function canPreviewArtifact(artifact: AgentArtifactRef): boolean {
    const ext = artifact.ext || artifactPathExtension(artifact.name || artifact.path);
    const mode = previewModeForArtifact(ext);
    return mode !== 'external' && mode !== 'none';
  }

  return (
    <>
      <div className="artifact-list">
        {artifacts.map((artifact) => (
            <div className="artifact-card" key={artifact.id}>
              <div className="artifact-main">
              <button
                className="artifact-name-button"
                disabled={busyId === `preview:${artifact.id}` || busyId === `open:${artifact.id}`}
                onClick={() => void previewArtifact(artifact)}
                title={tr('Preview file', '预览文件')}
              >
                {artifact.name}
              </button>
              <span>{artifact.kind} | {formatBytes(artifact.sizeBytes)}</span>
              <code>{artifact.path}</code>
            </div>
            <div className="artifact-actions">
              {canPreviewArtifact(artifact) && (
                <button className="mini-button" disabled={busyId === `preview:${artifact.id}`} onClick={() => void previewArtifact(artifact)}>
                  {tr('Preview', '预览')}
                </button>
              )}
              <button className="mini-button" disabled={busyId === `open:${artifact.id}`} onClick={() => void openArtifact(artifact)}>
                {tr('Open', '打开')}
              </button>
              <button className="mini-button" disabled={busyId === `reveal:${artifact.id}`} onClick={() => void revealArtifact(artifact)}>
                {tr('Folder', '目录')}
              </button>
              <button className="mini-button" onClick={() => void copyTextToClipboard(artifact.absPath || artifact.path)}>
                {tr('Copy', '复制')}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="error-box">{error}</div>}
      {preview && <ArtifactPreviewModal preview={preview} tr={tr} onClose={() => setPreview(null)} />}
    </>
  );
}

const MessageArtifacts = memo(MessageArtifactsComponent);

function MessageBubbleComponent({
  message,
  sessionId,
  tr,
  productName,
  liveContentPreview,
  liveReasoningPreview,
  onPreviewArtifact
}: {
  message: AgentMessage;
  sessionId?: string;
  tr: TranslateFn;
  productName: string;
  liveContentPreview: boolean;
  liveReasoningPreview: boolean;
  onPreviewArtifact?: (preview: ArtifactPreviewResult) => void;
}): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  const isWechatPending = message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER;
  const avatar = message.role === 'assistant' ? 'AI' : (message.external?.provider?.toUpperCase() || 'You');
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [fullReasoning, setFullReasoning] = useState<string | undefined>();
  const [fullContentParts, setFullContentParts] = useState<string[] | undefined>();
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState('');
  const rawContent = fullContent ?? message.content;
  const content = message.role === 'user' ? decodeLikelyPercentEncodedChineseText(rawContent) : rawContent;
  const reasoningContent = fullReasoning ?? message.reasoning_content;
  const contentParts = fullContentParts ?? message.content_parts ?? EMPTY_STRING_ARRAY;
  const shouldUseLiveContentPreview = message.role === 'assistant' && liveContentPreview && fullContent === null;
  const completedAssistantItems = useMemo(
    () => message.role === 'assistant' ? contentParts.filter((item) => item.trim()) : EMPTY_STRING_ARRAY,
    [message.role, contentParts]
  );
  const completedAssistantContent = useMemo(
    () => message.role === 'assistant' ? completedAssistantItems.join('\n\n') : '',
    [message.role, completedAssistantItems]
  );
  const currentLiveAssistantContent = message.role === 'assistant' && shouldUseLiveContentPreview ? content : '';
  const finalAssistantContent = message.role === 'assistant' && !shouldUseLiveContentPreview ? content : '';
  const actionContent = content;
  const isLivePreviewing = shouldUseLiveContentPreview || liveReasoningPreview;
  const citations = useMemo(
    () => {
      if (message.role !== 'assistant' || isLivePreviewing) return [];
      const source = [...contentParts, content].filter((item) => item.trim()).join('\n\n');
      return extractCitationLinks(source);
    },
    [message.role, contentParts, content, isLivePreviewing]
  );
  const renderedMarkdown = useMemo(
    () => {
      const markdownContent = message.role === 'assistant' ? finalAssistantContent : content;
      return markdownContent.trim() ? renderMarkdownContent(markdownContent, `msg-${message.id ?? 'x'}`, {
        artifacts: message.artifacts,
        sessionId,
        onPreviewArtifact
      }) : null;
    },
    [content, finalAssistantContent, message.artifacts, message.id, message.role, onPreviewArtifact]
  );
  const [copied, setCopied] = useState(false);
  const [exportBusy, setExportBusy] = useState<'pdf' | 'docx' | null>(null);
  const canLoadFull = Boolean(sessionId && message.id && !isLivePreviewing && (message.contentOmitted || message.reasoningOmitted) && fullContent === null);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function handleCopy(): Promise<void> {
    try {
      await copyTextToClipboard(actionContent || '');
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
      setFullContentParts(result.content_parts);
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
      const normalized = normalizeMarkdownForRender(actionContent);
      const html = renderMarkdownToHtml(normalized);
      const result = await exportAssistantMessage({
        format,
        title: assistantExportTitle(actionContent),
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
      <div className="msg-avatar">{avatar}</div>
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
              <MessageArtifacts artifacts={message.artifacts} sessionId={sessionId} tr={tr} onPreviewArtifact={onPreviewArtifact} />
              {completedAssistantContent.trim()
                ? <MessageContentList content={completedAssistantContent} items={completedAssistantItems} livePreview={false} tr={tr} title={tr('Assistant content', '回复内容')} artifacts={message.artifacts} sessionId={sessionId} onPreviewArtifact={onPreviewArtifact} />
                : null}
              {message.role === 'assistant' && reasoningContent?.trim()
                ? <ReasoningList content={reasoningContent} parts={message.reasoning_parts} livePreview={liveReasoningPreview} tr={tr} />
                : null}
              {currentLiveAssistantContent.trim()
                ? <MessageContentList content={currentLiveAssistantContent} livePreview={true} tr={tr} title={tr('Current reply', '当前回复')} artifacts={message.artifacts} sessionId={sessionId} onPreviewArtifact={onPreviewArtifact} />
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

function PaginationControls(props: {
  tr: TranslateFn;
  page: number;
  pageSize: number;
  total?: number;
  loaded?: number;
  hasMore?: boolean;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}): ReactElement {
  const pageCount = props.total !== undefined ? Math.max(1, Math.ceil(props.total / props.pageSize)) : undefined;
  const hasPrevious = props.page > 1;
  const hasNext = pageCount !== undefined ? props.page < pageCount : Boolean(props.hasMore ?? ((props.loaded ?? 0) >= props.pageSize));
  const pageLabel = pageCount
    ? props.tr(`Page ${props.page} / ${pageCount}`, `第 ${props.page} / ${pageCount} 页`)
    : props.tr(`Page ${props.page}`, `第 ${props.page} 页`);
  return (
    <div className="pagination-controls">
      <button className="ghost-button compact-button" disabled={props.disabled || !hasPrevious} onClick={() => props.onPageChange(Math.max(1, props.page - 1))}>
        {props.tr('Previous', '上一页')}
      </button>
      <span className="soft-badge">{pageLabel}</span>
      <span className="soft-badge">
        {props.tr('Page size', '每页')}: {props.pageSize}
      </span>
      <button className="ghost-button compact-button" disabled={props.disabled || !hasNext} onClick={() => props.onPageChange(props.page + 1)}>
        {props.tr('Next', '下一页')}
      </button>
    </div>
  );
}

function pluginErrorMessage(error: unknown, tr: TranslateFn): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/No handler registered for ['"]plugins:market:browse['"]|No handler registered for ['"]dsh-sidecar:plugins:upload['"]/i.test(message)) {
    return tr(
      'The current main process has not loaded the plugin handlers yet. Restart Tasi Harness once, then open Plugins again.',
      '当前主进程尚未加载插件处理器。请重启一次 Tasi Harness，然后重新打开插件页。'
    );
  }
  return message;
}

function isFloatingClientMount(mount: DshSidecarClientMount): boolean {
  return mount.mountPoint === 'desktop-companion' || mount.mountPoint === 'floating';
}

function isVisibleClientMount(mount: DshSidecarClientMount): boolean {
  if (!mount.url.trim()) return false;
  return mount.mountPoint === 'sidebar'
    || mount.mountPoint === 'main-panel'
    || mount.mountPoint === 'right-panel'
    || mount.mountPoint === 'settings'
    || mount.mountPoint === 'floating'
    || mount.mountPoint === 'desktop-companion';
}

function visiblePluginClientMounts(mounts: DshSidecarClientMount[]): DshSidecarClientMount[] {
  return mounts.filter(isVisibleClientMount);
}

function primaryPluginClientMount(mounts: DshSidecarClientMount[]): DshSidecarClientMount | undefined {
  const priority = new Map<string, number>([
    ['desktop-companion', 0],
    ['floating', 1],
    ['main-panel', 2],
    ['right-panel', 3],
    ['sidebar', 4],
    ['settings', 5]
  ]);
  return [...mounts]
    .filter(isVisibleClientMount)
    .sort((left, right) => (priority.get(left.mountPoint) ?? 99) - (priority.get(right.mountPoint) ?? 99))[0];
}

function PluginsPage({ tr }: { tr: TranslateFn }): ReactElement {
  const [activeTab, setActiveTab] = useState<'marketplace' | 'installed' | 'upload'>('marketplace');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [marketPage, setMarketPage] = useState(1);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketplace, setMarketplace] = useState<DshMarketplaceBrowseResult>({
    source: { id: 'skillhub', name: 'SkillHub', homepage: 'https://skillhub.cn/plugins' },
    plugins: [],
    page: 1,
    pageSize: MARKET_PAGE_SIZE
  });
  const [installed, setInstalled] = useState<DshSidecarPluginRecord[]>([]);
  const [sidecarStatus, setSidecarStatus] = useState<DshSidecarStatus | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<DshSidecarRuntimeStatus | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<DshMarketplacePluginDetail | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPackageName, setUploadPackageName] = useState('');
  const [uploadEnable, setUploadEnable] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setMarketPage(1);
  }, [debouncedQuery]);

  async function refreshInstalled(): Promise<void> {
    const result = await window.tasiHarness.dshSidecar.listPlugins();
    setSidecarStatus(result.status);
    setInstalled(result.plugins);
    try {
      const runtime = await window.tasiHarness.dshSidecar.runtimeStatus();
      setRuntimeStatus(runtime);
      const repaired = await window.tasiHarness.dshSidecar.listPlugins();
      setSidecarStatus(repaired.status);
      setInstalled(repaired.plugins);
    } catch {
      setRuntimeStatus(null);
    }
  }

  async function refreshMarketplace(): Promise<void> {
    try {
      setError('');
      setMarketLoading(true);
      const result = await window.tasiHarness.plugins.browseMarketplace({ query: debouncedQuery, page: marketPage, pageSize: MARKET_PAGE_SIZE });
      setMarketplace(result);
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
      setMarketplace({
        source: { id: 'skillhub', name: 'SkillHub', homepage: 'https://skillhub.cn/plugins' },
        plugins: [],
        page: marketPage,
        pageSize: MARKET_PAGE_SIZE
      });
    } finally {
      setMarketLoading(false);
    }
  }

  useEffect(() => {
    void refreshInstalled();
  }, []);

  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    void refreshMarketplace();
  }, [activeTab, debouncedQuery, marketPage]);

  async function openDetail(plugin: DshMarketplacePlugin): Promise<void> {
    setBusyKey(`detail:${plugin.id}`);
    setError('');
    try {
      setSelectedDetail(await window.tasiHarness.plugins.readMarketplacePlugin(plugin.id));
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
      setSelectedDetail({
        ...plugin,
        versions: [],
        manifestPreview: undefined,
        mcpPreview: undefined
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function installPlugin(plugin: DshMarketplacePlugin): Promise<void> {
    setBusyKey(`install:${plugin.id}`);
    setError('');
    setNotice('');
    try {
      const record = await window.tasiHarness.plugins.installFromMarketplace({ plugin, enable: true });
      setNotice(record.status === 'enabled'
        ? tr(`Installed and enabled ${record.packageName}.`, `已安装并启用 ${record.packageName}。`)
        : tr(`Installed ${record.packageName}: ${record.status}.`, `已安装 ${record.packageName}：${record.status}。`));
      await refreshInstalled();
      await refreshMarketplace();
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
    } finally {
      setBusyKey(null);
    }
  }

  async function setPluginEnabled(plugin: DshSidecarPluginRecord, enabled: boolean): Promise<void> {
    setBusyKey(`${enabled ? 'enable' : 'disable'}:${plugin.id}`);
    setError('');
    setNotice('');
    try {
      const record = enabled
        ? await window.tasiHarness.dshSidecar.enablePlugin({ id: plugin.id, packageName: plugin.packageName, source: plugin.source })
        : await window.tasiHarness.dshSidecar.disablePlugin({ id: plugin.id, packageName: plugin.packageName, source: plugin.source });
      setNotice(enabled
        ? tr(`Enabled ${record.packageName}.`, `已启用 ${record.packageName}。`)
        : tr(`Disabled ${record.packageName}.`, `已禁用 ${record.packageName}。`));
      await refreshInstalled();
      await refreshMarketplace();
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
    } finally {
      setBusyKey(null);
    }
  }

  async function uninstallPlugin(plugin: DshSidecarPluginRecord): Promise<void> {
    setBusyKey(`uninstall:${plugin.id}`);
    setError('');
    setNotice('');
    try {
      const ok = await window.tasiHarness.dshSidecar.uninstallPlugin({ id: plugin.id, packageName: plugin.packageName, source: plugin.source });
      setNotice(ok
        ? tr(`Uninstalled ${plugin.packageName}.`, `已卸载 ${plugin.packageName}。`)
        : tr(`Plugin was not installed: ${plugin.packageName}.`, `插件未安装：${plugin.packageName}。`));
      await refreshInstalled();
      await refreshMarketplace();
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
    } finally {
      setBusyKey(null);
    }
  }

  async function uploadPlugin(): Promise<void> {
    if (!uploadFile) {
      setError(tr('Choose a plugin ZIP package first.', '请先选择插件 ZIP 包。'));
      return;
    }
    setBusyKey('upload');
    setError('');
    setNotice('');
    try {
      const contentBase64 = await fileToBase64(uploadFile);
      const record = await window.tasiHarness.dshSidecar.uploadPlugin({
        filename: uploadFile.name,
        contentBase64,
        packageName: uploadPackageName.trim() || undefined,
        enable: uploadEnable
      });
      setNotice(record.enabled
        ? tr(`Uploaded, installed, and enabled ${record.packageName}.`, `已上传、安装并启用 ${record.packageName}。`)
        : tr(`Uploaded and installed ${record.packageName}: ${record.status}.`, `已上传并安装 ${record.packageName}：${record.status}。`));
      setUploadFile(null);
      setUploadPackageName('');
      await refreshInstalled();
      await refreshMarketplace();
      setActiveTab('installed');
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
    } finally {
      setBusyKey(null);
    }
  }

  async function openClientMount(mount: DshSidecarClientMount): Promise<void> {
    setBusyKey(`client:${mount.pluginId}:${mount.id}`);
    setError('');
    setNotice('');
    try {
      const opened = await window.tasiHarness.dshSidecar.openClientMount({
        id: mount.id,
        pluginId: mount.pluginId,
        mode: isFloatingClientMount(mount) ? 'desktop-companion' : 'window'
      });
      setNotice(tr(`Showing ${opened.title}.`, `已显示 ${opened.title}。`));
    } catch (err) {
      setError(pluginErrorMessage(err, tr));
    } finally {
      setBusyKey(null);
    }
  }

  const statusText = sidecarStatus?.running ? tr('Sidecar running', 'Sidecar 运行中') : tr('Sidecar idle', 'Sidecar 未启动');

  return (
    <section className="page">
      <PageHeader
        title={tr('Plugins', '插件')}
        subtitle={tr('Browse SkillHub DSH plugins, preview metadata, and manage the local sidecar install state.', '浏览 SkillHub DSH 插件，预览元数据，并管理本机 sidecar 安装状态。')}
        action={<button className="ghost-button" onClick={() => void refreshInstalled()}>{tr('Refresh', '刷新')}</button>}
      />
      <div className="card">
        <div className="skill-tabs">
          <button className={`skill-tab ${activeTab === 'marketplace' ? 'active' : ''}`} onClick={() => setActiveTab('marketplace')}>
            {tr('Marketplace', '插件市场')}
          </button>
          <button className={`skill-tab ${activeTab === 'installed' ? 'active' : ''}`} onClick={() => setActiveTab('installed')}>
            {tr('Installed', '已安装')}
          </button>
          <button className={`skill-tab ${activeTab === 'upload' ? 'active' : ''}`} onClick={() => setActiveTab('upload')}>
            {tr('Upload', '上传')}
          </button>
        </div>
        <div className="meta-row wrap">
          <span className="soft-badge">{marketplace.source.name}</span>
          <span className="soft-badge">{statusText}</span>
          <span className="soft-badge">{tr('Installed', '已安装')}: {installed.length}</span>
          {runtimeStatus && <span className="soft-badge">{tr('Runtime tools', '运行工具')}: {runtimeStatus.tools.length}</span>}
        </div>
        {notice && <div className="notice-box">{notice}</div>}
        {error && <div className="error-box market-error">{error}</div>}

        {activeTab === 'marketplace' && (
          <>
            <label>{tr('Search SkillHub plugins', '搜索 SkillHub 插件')}</label>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr('plugin name, owner/slug, or SkillHub plugin URL', '插件名、owner/slug，或 SkillHub 插件 URL')}
            />
            <div className="meta-row wrap">
              <span className="soft-badge">
                {tr('Results', '结果')}: {marketplace.loaded ?? marketplace.plugins.length}{marketplace.total ? ` / ${marketplace.total}` : ''}
              </span>
              {marketLoading && <span className="soft-badge">{tr('Loading', '加载中')}</span>}
              {debouncedQuery && <span className="soft-badge">{tr('Query', '检索')}: {debouncedQuery}</span>}
              <button className="ghost-button compact-button" onClick={() => void window.tasiHarness.app.openExternalUrl(marketplace.source.homepage, { system: true })}>
                {tr('Open SkillHub', '打开 SkillHub')}
              </button>
            </div>
            <PaginationControls
              tr={tr}
              page={marketplace.page ?? marketPage}
              pageSize={marketplace.pageSize ?? MARKET_PAGE_SIZE}
              total={marketplace.total}
              loaded={marketplace.loaded ?? marketplace.plugins.length}
              hasMore={marketplace.hasMore}
              disabled={busyKey !== null || marketLoading}
              onPageChange={setMarketPage}
            />
            <div className="marketplace-list">
              {marketplace.plugins.map((plugin) => {
                const installKey = `install:${plugin.id}`;
                const detailKey = `detail:${plugin.id}`;
                return (
                  <div key={plugin.id} className="marketplace-card">
                    <div className="marketplace-card-top">
                      <div>
                        <strong>{plugin.name}</strong>
                        <div className="card-subtle">{plugin.owner ? `${plugin.owner} / ` : ''}{plugin.slug} | v{plugin.version}</div>
                      </div>
                      <div className="button-row compact">
                        <button className="ghost-button" disabled={busyKey === detailKey} onClick={() => void openDetail(plugin)}>
                          {busyKey === detailKey ? tr('Loading...', '加载中...') : tr('Preview', '预览')}
                        </button>
                        {plugin.installed ? (
                          <span className={`soft-badge ${plugin.enabled ? 'ok' : ''}`}>{plugin.enabled ? tr('Enabled', '已启用') : tr('Installed', '已安装')}</span>
                        ) : (
                          <button className="primary-button" disabled={busyKey !== null} onClick={() => void installPlugin(plugin)}>
                            {busyKey === installKey ? tr('Installing...', '安装中...') : tr('Install', '安装')}
                          </button>
                        )}
                      </div>
                    </div>
                    <p>{plugin.description}</p>
                    <div className="plugin-meta-grid">
                      <span>{tr('Source', '来源')}: {plugin.installSource}</span>
                      {plugin.packageName && <span>{tr('Package', '包名')}: {plugin.packageName}</span>}
                      {plugin.status && <span>{tr('Status', '状态')}: {plugin.status}</span>}
                    </div>
                  </div>
                );
              })}
              {marketplace.plugins.length === 0 && <div className="tool-empty">{tr('No SkillHub plugins matched. Paste a plugin URL such as https://skillhub.cn/plugins/owner/slug to install directly.', '未匹配到 SkillHub 插件。可粘贴类似 https://skillhub.cn/plugins/owner/slug 的插件 URL 直接安装。')}</div>}
            </div>
          </>
        )}

        {activeTab === 'installed' && (
          <div className="marketplace-list">
            {installed.map((plugin) => {
              const runtimePlugin = runtimeStatus?.plugins.find((item) => item.id === plugin.id);
              const visibleError = runtimePlugin ? runtimePlugin.lastError : plugin.lastError;
              const uiClientMounts = visiblePluginClientMounts(runtimePlugin?.clientMounts ?? []);
              const canShowClientUi = plugin.enabled && runtimePlugin !== undefined && (runtimePlugin.status === 'loaded' || runtimePlugin.status === 'partial');
              const primaryClientMount = canShowClientUi ? primaryPluginClientMount(uiClientMounts) : undefined;
              return (
                <div key={plugin.id} className="marketplace-card">
                  <div className="marketplace-card-top">
                    <div>
                      <strong>{plugin.packageName}</strong>
                      <div className="card-subtle">{plugin.id} | {plugin.version ?? 'unknown'} | {plugin.status}</div>
                    </div>
                    <div className="button-row compact">
                      {primaryClientMount && (
                        <button
                          className="ghost-button"
                          disabled={busyKey !== null}
                          onClick={() => void openClientMount(primaryClientMount)}
                          title={primaryClientMount.title}
                        >
                          {busyKey === `client:${primaryClientMount.pluginId}:${primaryClientMount.id}` ? tr('Opening...', '打开中...') : tr('Show', '显示')}
                        </button>
                      )}
                      <button className="ghost-button" disabled={busyKey !== null || plugin.status === 'incompatible'} onClick={() => void setPluginEnabled(plugin, !plugin.enabled)}>
                        {busyKey === `enable:${plugin.id}` || busyKey === `disable:${plugin.id}`
                          ? tr('Updating...', '更新中...')
                          : plugin.enabled ? tr('Disable', '禁用') : tr('Enable', '启用')}
                      </button>
                      <button className="danger-button" disabled={busyKey !== null} onClick={() => void uninstallPlugin(plugin)}>
                        {busyKey === `uninstall:${plugin.id}` ? tr('Uninstalling...', '卸载中...') : tr('Uninstall', '卸载')}
                      </button>
                    </div>
                  </div>
                  <p>{plugin.source}</p>
                  <div className="plugin-meta-grid">
                    <span>{tr('Profile', 'Profile')}: {plugin.profileName}</span>
                    <span>{tr('Bundle patch', 'Bundle patch')}: {plugin.dshBundlePatch ?? tr('missing', '缺失')}</span>
                    <span>{tr('Updated', '更新时间')}: {plugin.updatedAt}</span>
                    {runtimePlugin && <span>{tr('Runtime', '运行时')}: {runtimePlugin.status}</span>}
                    {runtimePlugin && runtimePlugin.tools.length > 0 && <span>{tr('Tools', '工具')}: {runtimePlugin.tools.join(', ')}</span>}
                    {runtimePlugin?.commands && runtimePlugin.commands.length > 0 && <span>{tr('Commands', '命令')}: {runtimePlugin.commands.join(', ')}</span>}
                    {uiClientMounts.length > 0 && <span>{tr('Client UI', '客户端 UI')}: {uiClientMounts.map((mount) => mount.mountPoint).join(', ')}</span>}
                  </div>
                  {visibleError && <pre className="code-block small">{visibleError}</pre>}
                </div>
              );
            })}
            {installed.length === 0 && <div className="tool-empty">{tr('No DSH sidecar plugins installed yet.', '暂无已安装的 DSH sidecar 插件。')}</div>}
          </div>
        )}

        {activeTab === 'upload' && (
          <>
            <h2>{tr('Upload Plugin ZIP', '上传插件 ZIP')}</h2>
            <label>{tr('Plugin ZIP package', '插件 ZIP 包')}</label>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                setUploadFile(event.target.files?.[0] ?? null);
                setError('');
                setNotice('');
              }}
            />
            <label>{tr('Package name override', '包名覆盖')}</label>
            <input
              value={uploadPackageName}
              onChange={(event) => setUploadPackageName(event.target.value)}
              placeholder={tr('optional, e.g. @owner/plugin-name', '可选，例如 @owner/plugin-name')}
            />
            <label className="toggle-line overwrite-toggle">
              <input type="checkbox" checked={uploadEnable} onChange={(event) => setUploadEnable(event.target.checked)} />
              {tr('Enable immediately after install', '安装后立即启用')}
            </label>
            <div className="meta-row wrap">
              {uploadFile && <span className="soft-badge">{uploadFile.name}</span>}
              <span className="soft-badge">{tr('Requires package.json with dsh.bundle.patch', '需要 package.json 声明 dsh.bundle.patch')}</span>
            </div>
            <div className="button-row">
              <button className="primary-button" disabled={busyKey !== null || !uploadFile} onClick={() => void uploadPlugin()}>
                {busyKey === 'upload' ? tr('Installing...', '安装中...') : tr('Upload and Install', '上传并安装')}
              </button>
            </div>
          </>
        )}
      </div>

      {selectedDetail && (
        <div className="modal-backdrop" onClick={() => setSelectedDetail(null)}>
          <div className="modal-card plugin-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>{selectedDetail.name}</h2>
                <p>{selectedDetail.homepage}</p>
              </div>
              <button className="ghost-button" onClick={() => setSelectedDetail(null)}>{tr('Close', '关闭')}</button>
            </div>
            <p>{selectedDetail.description}</p>
            <div className="plugin-meta-grid">
              <span>{tr('Install source', '安装源')}: {selectedDetail.installSource}</span>
              <span>{tr('Package', '包名')}: {selectedDetail.packageName ?? selectedDetail.slug}</span>
              <span>{tr('Versions', '版本')}: {selectedDetail.versions.map((version) => version.version).slice(0, 6).join(', ') || selectedDetail.version}</span>
            </div>
            {selectedDetail.readme && <pre className="code-block small">{selectedDetail.readme}</pre>}
            {selectedDetail.manifestPreview && <pre className="code-block small">{selectedDetail.manifestPreview}</pre>}
            {selectedDetail.mcpPreview && <pre className="code-block small">{selectedDetail.mcpPreview}</pre>}
            <div className="button-row">
              <button className="ghost-button" onClick={() => void window.tasiHarness.app.openExternalUrl(selectedDetail.homepage, { system: true })}>{tr('Open Source Page', '打开来源页')}</button>
              {!selectedDetail.installed && (
                <button className="primary-button" disabled={busyKey !== null} onClick={() => void installPlugin(selectedDetail)}>
                  {tr('Install and Enable', '安装并启用')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
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
  const [marketPage, setMarketPage] = useState(1);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketplace, setMarketplace] = useState<MarketplaceBrowseResult>({ sources: [], skills: [], page: 1, pageSize: MARKET_PAGE_SIZE });
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
    setMarketPage(1);
  }, [debouncedQuery]);

  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    setMarketLoading(true);
    void window.tasiHarness.skills
      .browseMarketplace({ query: debouncedQuery, page: marketPage, pageSize: MARKET_PAGE_SIZE })
      .then((result) => {
        setMarketplace(result);
        setMarketError('');
      })
      .catch((error) => {
        setMarketplace({ sources: [], skills: [], page: marketPage, pageSize: MARKET_PAGE_SIZE });
        setMarketError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setMarketLoading(false);
      });
  }, [debouncedQuery, skills, activeTab, marketPage]);

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
      const latest = await window.tasiHarness.skills.browseMarketplace({ query: debouncedQuery, page: marketPage, pageSize: MARKET_PAGE_SIZE });
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
              <span className="soft-badge">
                {tr('Results', '结果')}: {marketplace.loaded ?? marketplace.skills.length}{marketplace.total ? ` / ${marketplace.total}` : ''}
              </span>
              {marketLoading && <span className="soft-badge">{tr('Loading', '加载中')}</span>}
              {debouncedQuery && <span className="soft-badge">{tr('Query', '检索')}: {debouncedQuery}</span>}
              {marketplace.sources.filter((source) => source.enabled).map((source) => (
                <span key={source.id} className="soft-badge">{source.name}</span>
              ))}
            </div>
            <PaginationControls
              tr={tr}
              page={marketplace.page ?? marketPage}
              pageSize={marketplace.pageSize ?? MARKET_PAGE_SIZE}
              total={marketplace.total}
              loaded={marketplace.loaded ?? marketplace.skills.length}
              hasMore={marketplace.hasMore}
              disabled={marketActionKey !== null || marketLoading}
              onPageChange={setMarketPage}
            />
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
                    <strong>{decodeLikelyPercentEncodedChineseText(session.title || session.id)}</strong>
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

type SessionHistoryCategory = MemoryDomain | 'all' | 'wechat-clawbot' | 'external-im';

function isWechatClawBotSession(session: SessionSummary, wechatSessionId?: string): boolean {
  const configuredId = wechatSessionId?.trim();
  if (configuredId && session.id === configuredId) return true;
  const title = session.title.trim().toLowerCase();
  return title === 'wechat session' || title.startsWith('wechat clawbot') || title.startsWith('[wechat:');
}

function isExternalImSession(session: SessionSummary): boolean {
  return session.origin === 'external-im' || isExternalImSessionId(session.id);
}

function isExternalImSessionId(sessionId?: string): boolean {
  return Boolean(sessionId && (sessionId.startsWith('im_') || sessionId.startsWith('dsh-im-')));
}

function externalImLabel(session: SessionSummary, tr: TranslateFn): string {
  const provider = session.external?.provider?.trim();
  if (provider) return provider.toUpperCase();
  if (session.id.startsWith('im_')) return session.id.split('_')[1]?.toUpperCase() || tr('IM', 'IM');
  return tr('IM', 'IM');
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
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyLoadSeq = useRef(0);
  const [historyResult, setHistoryResult] = useState<SessionListPageResult>({
    sessions: [],
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    total: 0,
    totalPages: 1,
    categoryCounts: { all: 0, 'wechat-clawbot': 0, 'external-im': 0 }
  });
  const categoryCounts = historyResult.categoryCounts;
  const activeCategoryLabel = useMemo(() => {
    if (activeCategory === 'all') return tr('All', '全部');
    if (activeCategory === 'external-im') return tr('External IM', '外接 IM');
    if (activeCategory === 'wechat-clawbot') return tr('WeChat', '微信');
    const domain = MEMORY_DOMAINS.find((item) => item.value === activeCategory);
    return domain ? tr(domain.labelEn, domain.labelZh) : activeCategory;
  }, [activeCategory, tr]);
  const activeCategoryDeleteCount = categoryCounts[activeCategory] ?? 0;

  async function loadHistoryPage(pageNumber = historyPage): Promise<void> {
    const seq = historyLoadSeq.current + 1;
    historyLoadSeq.current = seq;
    setHistoryLoading(true);
    try {
      const result = await window.tasiHarness.sessions.listPage({
        page: pageNumber,
        pageSize: HISTORY_PAGE_SIZE,
        query,
        category: activeCategory,
        wechatSessionId
      });
      if (seq !== historyLoadSeq.current) return;
      setHistoryResult(result);
      setHistoryPage(result.page);
    } finally {
      if (seq === historyLoadSeq.current) setHistoryLoading(false);
    }
  }

  useEffect(() => {
    setHistoryPage(1);
  }, [query, activeCategory, wechatSessionId]);

  useEffect(() => {
    void loadHistoryPage(historyPage);
  }, [historyPage, query, activeCategory, wechatSessionId]);

  async function remove(id: string): Promise<void> {
    await window.tasiHarness.sessions.delete(id);
    await loadHistoryPage(historyPage);
    await refreshSessions();
  }

  async function removeActiveCategory(): Promise<void> {
    const allSessions = sessions.length > 0 ? sessions : await window.tasiHarness.sessions.list();
    const targets = activeCategory === 'all'
      ? allSessions
      : activeCategory === 'wechat-clawbot'
        ? allSessions.filter((session) => isWechatClawBotSession(session, wechatSessionId))
        : activeCategory === 'external-im'
          ? allSessions.filter((session) => isExternalImSession(session))
          : allSessions.filter((session) => !isWechatClawBotSession(session, wechatSessionId) && !isExternalImSession(session) && knownMemoryDomain(session.domain) === activeCategory);
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
      await loadHistoryPage(1);
      await refreshSessions();
    } finally {
      setDeletingCategory(false);
    }
  }

  return (
    <section className="page">
      <PageHeader title={tr('History', '历史')} subtitle={tr('Local JSON session history grouped by memory domain, with external IM separated for quick access.', '本地 JSON 会话历史，按记忆分类展示，并单独列出外接 IM，方便快速查找。')} />
      <div className="card">
        <input className="wide-input" placeholder={tr('Filter history', '筛选历史')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="history-actions">
          <div className="card-subtle">
            {tr('Current category', '当前分类')}: {activeCategoryLabel} · {historyResult.total} / {activeCategoryDeleteCount} {tr('sessions', '个会话')}
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
              <span className="soft-badge">{categoryCounts.all ?? 0}</span>
            </button>
            <button className={`memory-category-item ${activeCategory === 'wechat-clawbot' ? 'active' : ''}`} onClick={() => setActiveCategory('wechat-clawbot')}>
              <span>{tr('WeChat', '微信')}</span>
              <span className="soft-badge">{categoryCounts['wechat-clawbot'] ?? 0}</span>
            </button>
            <button className={`memory-category-item ${activeCategory === 'external-im' ? 'active' : ''}`} onClick={() => setActiveCategory('external-im')}>
              <span>{tr('External IM', '外接 IM')}</span>
              <span className="soft-badge">{categoryCounts['external-im'] ?? 0}</span>
            </button>
            {MEMORY_DOMAINS.map((category) => (
              <button
                key={category.value}
                className={`memory-category-item ${activeCategory === category.value ? 'active' : ''}`}
                onClick={() => setActiveCategory(category.value)}
              >
                <span>{tr(category.labelEn, category.labelZh)}</span>
                <span className="soft-badge">{categoryCounts[category.value] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="session-list">
            <div className="history-pager">
              <span>{tr('Page', '页码')}: {historyResult.page} / {historyResult.totalPages}</span>
              <span>{tr('Per page', '每页')}: {historyResult.pageSize}</span>
              <button className="mini-button" disabled={historyLoading || historyResult.page <= 1} onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}>
                {tr('Previous', '上一页')}
              </button>
              <button className="mini-button" disabled={historyLoading || historyResult.page >= historyResult.totalPages} onClick={() => setHistoryPage((page) => page + 1)}>
                {tr('Next', '下一页')}
              </button>
            </div>
            {historyLoading && <div className="tool-empty">{tr('Loading sessions...', '正在加载会话...')}</div>}
            {!historyLoading && historyResult.sessions.map((s) => {
              const isWechat = isWechatClawBotSession(s, wechatSessionId);
              const isExternal = isExternalImSession(s);
              const domain = MEMORY_DOMAINS.find((item) => item.value === knownMemoryDomain(s.domain)) ?? MEMORY_DOMAINS.at(-1);
              return (
                <div className="session-card" key={s.id}>
                  <div className="session-card-main">
                    <strong>{decodeLikelyPercentEncodedChineseText(s.title)}</strong>
                    <p>{s.messageCount} {tr('messages', '条消息')} | {prettyDate(s.updatedAt)}</p>
                    <div className="session-card-badges">
                      {isExternal && <span className="soft-badge">{externalImLabel(s, tr)}</span>}
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
            {!historyLoading && historyResult.sessions.length === 0 && (
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

function SettingsPage({
  tr,
  config,
  setConfig,
  onThemePreviewChange
}: {
  tr: TranslateFn;
  config: PublicAppConfig;
  setConfig: (cfg: PublicAppConfig) => void;
  onThemePreviewChange: (cfg: PublicAppConfig | null) => void;
}): ReactElement {
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
    if (subPage === 'theme') {
      onThemePreviewChange(draft);
      return () => onThemePreviewChange(null);
    }
    onThemePreviewChange(null);
  }, [subPage, draft.theme, draft.customThemes, draft.textBrightness, draft.textColor, onThemePreviewChange]);

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
      const adjusted = await window.tasiHarness.config.set({
        textBrightness: automaticTextBrightness(next),
        textColor: automaticTextColor(next)
      });
      setConfig(adjusted);
      setDraft({ ...adjusted, apiKey: '', omniApiKey: '', emailNotifications: { ...adjusted.emailNotifications, password: '' } });
      const theme = adjusted.customThemes.find((item) => `custom:${item.id}` === adjusted.theme);
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
      const adjusted = await window.tasiHarness.config.set({
        textBrightness: automaticTextBrightness(next),
        textColor: automaticTextColor(next)
      });
      setConfig(adjusted);
      setDraft({ ...adjusted, apiKey: '', omniApiKey: '', emailNotifications: { ...adjusted.emailNotifications, password: '' } });
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
        {!isOmni && activeProvider === 'vllm' && (
          <>
            <label>{tr('Reasoning effort', '推理强度')}</label>
            <select
              value={draft.reasoningEffort}
              onChange={(e) => setDraft((old) => ({ ...old, reasoningEffort: e.target.value as PublicAppConfig['reasoningEffort'] }))}
            >
              <option value="auto">{tr('Auto / server default', '自动 / 服务端默认')}</option>
              <option value="none">{tr('Off', '关闭')}</option>
              <option value="low">{tr('Low', '低')}</option>
              <option value="medium">{tr('Medium', '中')}</option>
              <option value="xhigh">{tr('Extra high', '超高')}</option>
            </select>
            <div className="card-subtle">
              {tr(
                'For vLLM reasoning models, auto keeps the server default and requests visible reasoning; effort values are passed through as reasoning_effort.',
                '对 vLLM 推理模型，自动会保留服务端默认强度并请求显示推理；其它强度会作为 reasoning_effort 传递。'
              )}
            </div>
          </>
        )}
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

  function updateThemeDraft(patch: Partial<Pick<SettingsDraft, 'theme' | 'textBrightness' | 'textColor'>>): void {
    const next = {
      ...draft,
      ...patch
    };
    if (patch.theme && patch.textBrightness === undefined) {
      next.textBrightness = automaticTextBrightness(next);
    }
    if (patch.theme && patch.textColor === undefined) {
      next.textColor = automaticTextColor(next);
    }
    setDraft(next);
    onThemePreviewChange(next);
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
          <div className="theme-adjust-row">
            <div>
              <label htmlFor="text-color">{tr('Text color', '字体颜色')}</label>
              <p>{tr('Manual text color with contrast protection against the current theme color.', '手动设置字体颜色，并按当前主题色做对比度保护。')}</p>
            </div>
            <div className="theme-adjust-control theme-color-control">
              <input
                className="theme-color-swatch"
                type="color"
                value={colorToHex(draft.textColor || automaticTextColor(draft))}
                onChange={(event) => updateThemeDraft({ textColor: event.currentTarget.value })}
                aria-label={tr('Pick text color', '选择字体颜色')}
              />
              <input
                id="text-color"
                value={draft.textColor || ''}
                onChange={(event) => updateThemeDraft({ textColor: event.currentTarget.value })}
                placeholder={automaticTextColor(draft)}
              />
              <button
                className="ghost-button"
                onClick={() => updateThemeDraft({ textColor: automaticTextColor(draft), textBrightness: automaticTextBrightness(draft) })}
              >
                {tr('Auto contrast', '自动对比')}
              </button>
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
