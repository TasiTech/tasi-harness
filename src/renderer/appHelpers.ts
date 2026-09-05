import type {
  AgentArtifactRef,
  AgentMessage,
  AgentMessageDeltaStream,
  DshSidecarRuntimePlugin,
  DshSidecarRuntimeStatus,
  ExternalConversationMetadata,
  ToolEvent
} from '../shared/types.js';
import { CONTENT_STREAM_PREVIEW_CHARS, REASONING_STREAM_PREVIEW_CHARS } from '../shared/reasoningPreview.js';

const ARTIFACT_SELECTION_CONTEXT_MAX_CHARS = 6000;
const LIVE_CONTENT_ITEM_CHARS = 2_000;
const WECHAT_PENDING_MARKER = '__TASI_WECHAT_PENDING__';
const PERCENT_ENCODED_UTF8_RUN = /(?:%[0-9A-Fa-f]{2}){2,}/g;
const CJK_TEXT = /[\u3400-\u9fff\uf900-\ufaff]/;

export interface PluginMentionTrigger {
  start: number;
  end: number;
  query: string;
}

export interface PluginMentionItem {
  plugin: DshSidecarRuntimePlugin;
  token: string;
  label: string;
  detail: string;
  status: string;
  aliases: string[];
}

export interface ExternalMessageDisplay {
  channelLabel: string;
  senderLabel: string;
  avatarLabel: string;
}

export function findPluginMentionTrigger(value: string, cursor: number): PluginMentionTrigger | null {
  const beforeCursor = value.slice(0, Math.max(0, cursor));
  const match = /(^|[\s,，;；。！？!?])@([a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]*)?)$/.exec(beforeCursor);
  if (!match) return null;
  const query = match[2] ?? '';
  const start = beforeCursor.length - query.length - 1;
  return { start, end: cursor, query };
}

function cleanDisplayText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, ' ') ?? '';
}

export function externalChannelLabel(external?: Pick<ExternalConversationMetadata, 'provider'>): string {
  const provider = cleanDisplayText(external?.provider);
  const lower = provider.toLowerCase().replace(/^@/, '');
  if (!lower || lower === 'dsh-im' || lower === 'xmanrui/dsh-im' || lower === 'xmanrui-dsh-im') return 'IM';
  if (lower === 'wechat' || lower === 'weixin' || lower === 'wx') return 'WeChat';
  if (lower === 'lark' || lower === 'feishu') return 'Feishu';
  if (lower === 'qq') return 'QQ';
  if (lower === 'dingding' || lower === 'dingtalk') return 'DingTalk';
  return provider
    .split(/[-_\s/]+/g)
    .filter(Boolean)
    .map((part) => /^[a-z0-9]+$/i.test(part) ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function avatarFromLabel(value: string): string {
  const text = cleanDisplayText(value);
  if (!text) return 'You';
  const cjk = [...text].filter((char) => /[\u3400-\u9fff\uf900-\ufaff]/.test(char)).slice(0, 2).join('');
  if (cjk) return cjk;
  const words = text.split(/[\s_\-/]+/g).filter(Boolean);
  const initials = words.length > 1
    ? words.map((word) => word[0]).join('')
    : text.replace(/[^a-z0-9]/gi, '');
  return (initials || text).slice(0, 3).toUpperCase();
}

export function externalMessageDisplay(external?: ExternalConversationMetadata): ExternalMessageDisplay {
  if (!external) return { channelLabel: 'You', senderLabel: 'You', avatarLabel: 'You' };
  const channelLabel = externalChannelLabel(external);
  const sender = cleanDisplayText(external.senderName);
  const display = cleanDisplayText(external.displayName);
  const conversation = cleanDisplayText(external.externalConversationId);
  const actor = sender || display || conversation || channelLabel;
  const hasConversationContext = Boolean(sender && display && sender !== display);
  const senderLabel = hasConversationContext
    ? `${channelLabel} / ${display} / ${sender}`
    : actor === channelLabel ? channelLabel : `${channelLabel} / ${actor}`;
  return {
    channelLabel,
    senderLabel,
    avatarLabel: avatarFromLabel(sender || display || channelLabel)
  };
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

export function pluginMentionToken(plugin: DshSidecarRuntimePlugin): string {
  const packageName = plugin.packageName.trim();
  if (packageName.startsWith('@')) return packageName.slice(1);
  return packageName || plugin.id;
}

export function pluginMentionItems(status: DshSidecarRuntimeStatus | null, query = ''): PluginMentionItem[] {
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

function normalizeArtifactSelectionText(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (clean.length <= ARTIFACT_SELECTION_CONTEXT_MAX_CHARS) return clean;
  return `${clean.slice(0, ARTIFACT_SELECTION_CONTEXT_MAX_CHARS).trimEnd()}\n\n[selection truncated]`;
}

function artifactLabelForPrompt(artifact: AgentArtifactRef): string {
  return artifact.name || artifact.path || artifact.absPath || 'artifact';
}

export function artifactSelectionQuestionPrompt(artifact: AgentArtifactRef, text: string): string {
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

export function artifactSelectionContextPrompt(artifact: AgentArtifactRef, text: string): string {
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

function appendPreviewText(current: string | undefined, delta: string | undefined, maxChars: number): string | undefined {
  if (typeof delta !== 'string') return current;
  const combined = `${current ?? ''}${delta}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return combined.length > maxChars ? combined.slice(-maxChars).trimStart() : combined;
}

export function decodeLikelyPercentEncodedChineseText(content: string): string {
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

export function mergeMessageDelta(messages: AgentMessage[], payload: AgentMessageDeltaStream): AgentMessage[] {
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
  return [
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
}

export function isVisibleChatMessage(message: AgentMessage): boolean {
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

function eventTimeMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function assignToolEventsToVisibleMessages(
  messages: AgentMessage[],
  toolEvents: ToolEvent[],
  running = false,
  maxLiveEvents = Number.POSITIVE_INFINITY
): ToolEvent[][] {
  const groups = messages.map((): ToolEvent[] => []);
  const assistantIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'assistant')
    .map(({ index }) => index);
  if (assistantIndexes.length === 0 || toolEvents.length === 0) return groups;

  const renderedToolEvents = running && Number.isFinite(maxLiveEvents)
    ? toolEvents.slice(-Math.max(0, maxLiveEvents))
    : toolEvents;
  const fallbackIndex = assistantIndexes[assistantIndexes.length - 1];

  for (const event of renderedToolEvents) {
    const eventTime = eventTimeMs(event.createdAt);
    let targetIndex = -1;
    if (Number.isFinite(eventTime)) {
      for (const assistantIndex of assistantIndexes) {
        const assistantTime = eventTimeMs(messages[assistantIndex].createdAt);
        if (Number.isFinite(assistantTime) && assistantTime >= eventTime) {
          targetIndex = assistantIndex;
          break;
        }
      }
    }
    groups[targetIndex >= 0 ? targetIndex : fallbackIndex].push(event);
  }

  return groups;
}

export function currentTurnPendingToolEvents(
  messages: AgentMessage[],
  toolEvents: ToolEvent[],
  running = false,
  maxLiveEvents = Number.POSITIVE_INFINITY
): ToolEvent[] {
  if (!running || toolEvents.length === 0) return [];
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const role = messages[index].role;
    if (role === 'user') latestUserIndex = index;
    if (role === 'assistant') latestAssistantIndex = index;
  }
  if (latestUserIndex < 0 || latestAssistantIndex > latestUserIndex) return [];
  const userTime = eventTimeMs(messages[latestUserIndex].createdAt);
  const currentTurnEvents = Number.isFinite(userTime)
    ? toolEvents.filter((event) => {
      const toolTime = eventTimeMs(event.createdAt);
      return !Number.isFinite(toolTime) || toolTime >= userTime;
    })
    : toolEvents;
  return Number.isFinite(maxLiveEvents)
    ? currentTurnEvents.slice(-Math.max(0, maxLiveEvents))
    : currentTurnEvents;
}

export function assistantContentListView(content: string, livePreview = false): { items: string[]; clipped: boolean } {
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

export function assistantLiveContentPreviewText(content: string, items?: string[]): { text: string; clipped: boolean } {
  const source = items && items.length > 0
    ? items.map((item) => item.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()).filter(Boolean).join('\n\n')
    : content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const clipped = source.length > CONTENT_STREAM_PREVIEW_CHARS;
  const text = (clipped ? source.slice(-CONTENT_STREAM_PREVIEW_CHARS).trimStart() : source).trim();
  return { text, clipped };
}
