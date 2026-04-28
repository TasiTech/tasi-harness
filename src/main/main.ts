import { app, BrowserWindow, ipcMain, screen, shell, webContents, type Rectangle, type WebContents } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppContext } from './appContext.js';
import { generateFollowUpQuestions } from './agent/followUpQuestions.js';
import { createLlmClient, testLlmConnection } from './agent/llmClient.js';
import type {
  AgentToolEventStream,
  AppConfig,
  ExternalSessionMessageRequest,
  MemoryClearRequest,
  ToolEvent,
  ToolExecutionResult,
  MemoryQueryOptions,
  PersonalKnowledgeUploadRequest,
  SessionDocumentUploadRequest,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SessionUpdateEvent,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SkillPatchRequest,
  SkillWriteRequest,
  ToolRunRequest,
  WechatChannelLoginStatusPayload,
  WechatChannelQrCodePayload
} from '../shared/types.js';
import { createId, nowIso } from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browserConstants.js';
import { applyAppDockIcon, applyPlatformAppIdentity, resolveAppWindowIconPath } from './appIcon.js';
import { ExternalBrowserBridge } from './browser/externalBrowserBridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let devToolsWindow: BrowserWindow | null = null;
const context = new AppContext();
let embeddedPreviewWebContentsId: number | null = null;
let isAppQuitting = false;
let lastExternalBrowserOpen: { url: string; at: number } | null = null;
const externalBrowserBridge = new ExternalBrowserBridge({ runtimeDir: join(context.harnessHome, 'runtime', 'external-browser') });
const externalFallbackUrls = new Set<string>();
const activeChatControllers = new Map<number, AbortController>();
let wechatPollerAbortController: AbortController | null = null;
let wechatPollerFingerprint = '';
const seenWechatMessageIds: string[] = [];
const seenWechatMessageIdSet = new Set<string>();
const WECHAT_PENDING_MARKER = '__TASI_WECHAT_PENDING__';

function broadcastSessionUpdated(event: SessionUpdateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('sessions:updated', event);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return /operation was aborted|session stopped by user|aborted/i.test(error.message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function buildTaskTrace(result: { iterations: number; execution: { mode: 'workspace' | 'sandbox' }; toolEvents: Array<{ toolName: string; ok: boolean; content: string; createdAt?: string }> }): string {
  const lines = [
    `Iterations: ${result.iterations}`,
    `Execution mode: ${result.execution.mode}`,
    `Tool events: ${result.toolEvents.length}`
  ];
  for (const event of result.toolEvents) {
    const preview = event.content.replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`- [${event.ok ? 'ok' : 'fail'}] ${event.toolName}${event.createdAt ? ` @ ${event.createdAt}` : ''} :: ${preview}`);
  }
  return lines.join('\n');
}

function buildWechatAuthHeaders(botToken: string): Record<string, string> {
  const randomUin = Math.floor(Math.random() * 0xffffffff).toString(10);
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': Buffer.from(randomUin).toString('base64')
  };
}

function extractWechatTextPayload(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '';
  const items = Array.isArray(record.item_list) ? record.item_list : [];
  const chunks: string[] = [];
  for (const itemRaw of items) {
    const item = asRecord(itemRaw);
    if (!item) continue;
    const type = getNumberField(item, ['type']);
    if (type === 1) {
      const textItem = asRecord(item.text_item);
      const text = textItem && typeof textItem.text === 'string' ? textItem.text.trim() : '';
      if (text) chunks.push(text);
      continue;
    }
    if (type === 2) chunks.push('[image]');
    else if (type === 3) chunks.push('[voice]');
    else if (type === 4) chunks.push('[file]');
    else if (type === 5) chunks.push('[video]');
  }
  return chunks.join('\n').trim();
}

function ensureWechatSessionId(): string {
  const current = context.getConfig().wechatChannel;
  const configured = current.sessionId?.trim();
  if (configured) return configured;
  const created = context.sessionStore.create('WeChat ClawBot');
  context.configStore.update({
    wechatChannel: {
      ...current,
      sessionId: created.id
    }
  });
  return created.id;
}

function markWechatMessageSeen(messageId: string): boolean {
  const id = messageId.trim();
  if (!id) return false;
  if (seenWechatMessageIdSet.has(id)) return true;
  seenWechatMessageIdSet.add(id);
  seenWechatMessageIds.push(id);
  while (seenWechatMessageIds.length > 2000) {
    const removed = seenWechatMessageIds.shift();
    if (removed) seenWechatMessageIdSet.delete(removed);
  }
  return false;
}

async function sendWechatText(
  baseUrl: string,
  botToken: string,
  payload: { toUserId: string; contextToken: string; text: string; fromUserId?: string }
): Promise<void> {
  const response = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: buildWechatAuthHeaders(botToken),
    body: JSON.stringify({
      msg: {
        from_user_id: payload.fromUserId ?? '',
        to_user_id: payload.toUserId,
        client_id: `tasi-${createId('wx')}`,
        message_type: 2,
        message_state: 2,
        context_token: payload.contextToken,
        item_list: [
          {
            type: 1,
            text_item: { text: payload.text }
          }
        ]
      },
      base_info: { channel_version: '1.0.0' }
    })
  });
  if (!response.ok) throw new Error(`sendmessage HTTP ${response.status}`);
  const body = await response.json() as unknown;
  const record = asRecord(body);
  if (!record) throw new Error('Invalid sendmessage response.');
  const errcode = getNumberField(record, ['errcode']);
  if (typeof errcode === 'number' && errcode !== 0) {
    const errMsg = typeof record.errmsg === 'string' ? record.errmsg : `errcode=${errcode}`;
    throw new Error(errMsg);
  }
  const ret = getNumberField(record, ['ret']);
  if (typeof ret === 'number' && ret !== 0) {
    const errMsg = typeof record.errmsg === 'string' ? record.errmsg : `ret=${ret}`;
    throw new Error(errMsg);
  }
}

async function sendWechatTaskNotification(taskName: string, runAtIso: string, executionMode: 'workspace' | 'sandbox', content: string): Promise<void> {
  const channel = context.getConfig().wechatChannel;
  const token = channel.botToken?.trim();
  const toUserId = channel.lastInboundUserId?.trim();
  const contextToken = channel.lastContextToken?.trim();
  if (!channel.enabled || !token || !toUserId || !contextToken) return;
  const baseUrl = (channel.baseUrl?.trim() || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
  const body = [
    `[Task] ${taskName}`,
    `Run at: ${runAtIso}`,
    `Execution: ${executionMode}`,
    '',
    content.trim()
  ].join('\n');
  const text = body.length > 1800 ? `${body.slice(0, 1797)}...` : body;
  await sendWechatText(baseUrl, token, {
    toUserId,
    contextToken,
    text,
    fromUserId: channel.botId?.trim() || undefined
  });
}

async function fetchWechatQrcodeStatus(qrcodeKey: string): Promise<WechatChannelLoginStatusPayload> {
  const clean = qrcodeKey.trim();
  if (!clean) throw new Error('qrcodeKey is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(clean)}`, {
      method: 'GET',
      headers: {
        'iLink-App-ClientVersion': '1'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as unknown;
    const record = asRecord(body);
    if (!record) throw new Error('Invalid iLink status response.');
    const statusRaw = getStringField(record, ['status']) ?? 'unknown';
    const status = ['wait', 'scaned', 'confirmed', 'expired'].includes(statusRaw) ? statusRaw as WechatChannelLoginStatusPayload['status'] : 'unknown';
    return {
      status,
      botToken: getStringField(record, ['bot_token']),
      botId: getStringField(record, ['ilink_bot_id']),
      userId: getStringField(record, ['ilink_user_id']),
      baseUrl: getStringField(record, ['baseurl']),
      fetchedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function stopWechatPoller(): void {
  if (!wechatPollerAbortController) return;
  wechatPollerAbortController.abort();
  wechatPollerAbortController = null;
  wechatPollerFingerprint = '';
}

function startWechatPoller(): void {
  const cfg = context.getConfig().wechatChannel;
  if (!cfg.enabled || !cfg.botToken?.trim()) {
    stopWechatPoller();
    return;
  }
  const token = cfg.botToken.trim();
  const baseUrl = (cfg.baseUrl?.trim() || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
  const fingerprint = `${token.slice(0, 8)}:${baseUrl}`;
  if (wechatPollerAbortController && wechatPollerFingerprint === fingerprint) return;
  stopWechatPoller();
  const controller = new AbortController();
  wechatPollerAbortController = controller;
  wechatPollerFingerprint = fingerprint;

  void (async () => {
    let cursor = cfg.cursor ?? '';
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${baseUrl}/ilink/bot/getupdates`, {
          method: 'POST',
          headers: buildWechatAuthHeaders(token),
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: '1.0.0' }
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as unknown;
        const record = asRecord(body);
        if (!record) throw new Error('Invalid getupdates response.');
        const errcode = getNumberField(record, ['errcode']);
        if (errcode === -14) {
          context.configStore.update({
            wechatChannel: {
              ...context.getConfig().wechatChannel,
              enabled: false,
              loginStatus: 'expired',
              lastError: 'WeChat session expired. Please scan a new QR code.'
            }
          });
          stopWechatPoller();
          return;
        }
        const ret = getNumberField(record, ['ret']);
        if (typeof ret === 'number' && ret !== 0) {
          throw new Error(typeof record.errmsg === 'string' ? record.errmsg : `ret=${ret}`);
        }
        const nextCursor = getStringField(record, ['get_updates_buf', 'sync_buf']) ?? cursor;
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          context.configStore.update({
            wechatChannel: {
              ...context.getConfig().wechatChannel,
              cursor
            }
          });
        }
        const msgs = Array.isArray(record.msgs) ? record.msgs : [];
        if (msgs.length === 0) continue;
        const sessionId = ensureWechatSessionId();
        const botId = context.getConfig().wechatChannel.botId?.trim() || undefined;
        for (const msgRaw of msgs) {
          const msg = asRecord(msgRaw);
          if (!msg) continue;
          const messageType = getNumberField(msg, ['message_type']);
          const messageState = getNumberField(msg, ['message_state']);
          if (typeof messageType === 'number' && messageType !== 1) continue;
          if (typeof messageState === 'number' && messageState !== 2) continue;
          const fromUser = getStringField(msg, ['from_user_id']) ?? '';
          if (!fromUser || fromUser.endsWith('@im.bot')) continue;
          const contextToken = getStringField(msg, ['context_token']) ?? '';
          const text = extractWechatTextPayload(msg);
          if (!text) continue;
          context.configStore.update({
            wechatChannel: {
              ...context.getConfig().wechatChannel,
              lastInboundUserId: fromUser,
              lastContextToken: contextToken || context.getConfig().wechatChannel.lastContextToken
            }
          });
          const rawMessageId = getStringField(msg, ['message_id']) ?? String(getNumberField(msg, ['message_id']) ?? '');
          if (rawMessageId && markWechatMessageSeen(rawMessageId)) continue;
          const ts = getNumberField(msg, ['create_time_ms']);
          const createdAt = typeof ts === 'number' ? new Date(ts).toISOString() : new Date().toISOString();
          const shadowUserId = createId('wx_shadow_user');
          const pendingAssistantId = createId('wx_pending');
          const updatedInbound = context.sessionStore.appendMessages(sessionId, [
            {
              id: shadowUserId,
              role: 'user',
              content: `[WeChat:${fromUser}] ${text}`,
              createdAt
            },
            {
              id: pendingAssistantId,
              role: 'assistant',
              content: WECHAT_PENDING_MARKER,
              createdAt: nowIso()
            }
          ], []);
          broadcastSessionUpdated({
            sessionId: updatedInbound.id,
            source: 'external',
            updatedAt: updatedInbound.updatedAt
          });

          try {
            const runResult = await context.agentLoop.run({
              userInput: text,
              sessionId,
              executionMode: context.getConfig().defaultExecutionMode,
              origin: 'scheduled'
            });
            const postRunRecord = context.sessionStore.read(sessionId);
            if (postRunRecord) {
              const cleaned = postRunRecord.messages.filter((item) => item.id !== shadowUserId && item.id !== pendingAssistantId);
              context.sessionStore.replaceMessages(sessionId, cleaned);
            }
            const reply = runResult.finalResponse.trim();
            broadcastSessionUpdated({
              sessionId: runResult.sessionId,
              source: 'external',
              updatedAt: new Date().toISOString()
            });
            if (!reply) continue;
            if (!contextToken) continue;
            const outboundText = reply.length > 1800 ? `${reply.slice(0, 1797)}...` : reply;
            await sendWechatText(baseUrl, token, {
              toUserId: fromUser,
              contextToken,
              text: outboundText,
              fromUserId: botId
            });
          } catch (error) {
            const fallbackRecord = context.sessionStore.read(sessionId);
            if (fallbackRecord) {
              const replaced = fallbackRecord.messages.map((item) => (
                item.id === pendingAssistantId
                  ? { ...item, content: `[WeChat error] ${error instanceof Error ? error.message : String(error)}` }
                  : item
              ));
              context.sessionStore.replaceMessages(sessionId, replaced);
            }
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[wechat] auto-reply failed: ${message}`);
            context.configStore.update({
              wechatChannel: {
                ...context.getConfig().wechatChannel,
                lastError: `[auto-reply] ${message}`,
                loginStatus: 'error'
              }
            });
          }
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortLikeError(error)) return;
        const message = error instanceof Error ? error.message : String(error);
        context.configStore.update({
          wechatChannel: {
            ...context.getConfig().wechatChannel,
            lastError: message,
            loginStatus: 'error'
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
}

async function fetchWechatChannelQrCode(fallbackBindUrl: string): Promise<WechatChannelQrCodePayload> {
  const fallback = fallbackBindUrl.trim() || 'https://ilinkai.weixin.qq.com';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3', {
      method: 'GET',
      headers: {
        'iLink-App-ClientVersion': '1'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as unknown;
    const record = asRecord(body);
    if (!record) throw new Error('Invalid iLink response.');
    if (typeof record.ret === 'number' && record.ret !== 0) {
      const errMsg = typeof record.errmsg === 'string' ? record.errmsg : `ret=${record.ret}`;
      throw new Error(errMsg);
    }
    if (typeof record.errcode === 'number' && record.errcode !== 0) {
      const errMsg = typeof record.errmsg === 'string' ? record.errmsg : `errcode=${record.errcode}`;
      throw new Error(errMsg);
    }
    const qrcodeContent = getStringField(record, ['qrcode_img_content', 'qrcodeUrl', 'qrcode_url', 'qrcode']);
    if (!qrcodeContent) throw new Error('Missing qrcode content.');
    const qrcodeKey = getStringField(record, ['qrcode']);
    return {
      qrcodeContent,
      qrcodeKey,
      source: 'ilink-api',
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[wechat] Failed to fetch iLink qrcode, fallback to configured bind URL: ${message}`);
    return {
      qrcodeContent: fallback,
      source: 'manual-bind-url',
      fetchedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getDevToolsWindowMetrics(parent: BrowserWindow): { bounds: Rectangle; minWidth: number; minHeight: number } {
  const parentBounds = parent.getBounds();
  const workArea = screen.getDisplayMatching(parentBounds).workArea;
  const horizontalMargin = 24;
  const verticalMargin = 24;
  const availableWidth = Math.max(420, workArea.width - horizontalMargin * 2);
  const availableHeight = Math.max(320, workArea.height - verticalMargin * 2);
  const minWidth = Math.min(960, availableWidth);
  const minHeight = Math.min(640, availableHeight);
  const width = clamp(Math.round(Math.min(1400, workArea.width * 0.72)), minWidth, availableWidth);
  const height = clamp(Math.round(Math.min(980, workArea.height * 0.82)), minHeight, availableHeight);
  const sideBySideX = parentBounds.x + parentBounds.width + 16;
  const preferredX = sideBySideX + width <= workArea.x + workArea.width - horizontalMargin
    ? sideBySideX
    : parentBounds.x + Math.round((parentBounds.width - width) / 2);
  const preferredY = parentBounds.y + 20;

  return {
    bounds: {
      x: clamp(preferredX, workArea.x + horizontalMargin, workArea.x + workArea.width - width - horizontalMargin),
      y: clamp(preferredY, workArea.y + verticalMargin, workArea.y + workArea.height - height - verticalMargin),
      width,
      height
    },
    minWidth,
    minHeight
  };
}

function ensureDevToolsWindow(parent: BrowserWindow): BrowserWindow {
  const layout = getDevToolsWindowMetrics(parent);
  const appIconPath = resolveAppWindowIconPath();

  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    devToolsWindow.setMinimumSize(layout.minWidth, layout.minHeight);
    devToolsWindow.setBounds(layout.bounds);
    return devToolsWindow;
  }

  const win = new BrowserWindow({
    ...layout.bounds,
    ...(appIconPath ? { icon: appIconPath } : {}),
    show: false,
    minWidth: layout.minWidth,
    minHeight: layout.minHeight,
    autoHideMenuBar: true,
    backgroundColor: '#111118',
    title: 'Tasi Harness DevTools'
  });

  win.on('close', (event) => {
    if (isAppQuitting) return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    }
    win.hide();
  });
  win.on('closed', () => {
    if (devToolsWindow === win) devToolsWindow = null;
  });

  devToolsWindow = win;
  return win;
}

function openMainWindowDevTools(win: BrowserWindow): void {
  const devtools = ensureDevToolsWindow(win);
  win.webContents.setDevToolsWebContents(devtools.webContents);
  win.webContents.on('devtools-opened', () => {
    if (devtools.isDestroyed()) return;
    const layout = getDevToolsWindowMetrics(win);
    devtools.setMinimumSize(layout.minWidth, layout.minHeight);
    devtools.setBounds(layout.bounds);
    if (devtools.isMinimized()) devtools.restore();
    devtools.show();
    devtools.focus();
  });
  win.webContents.on('devtools-closed', () => {
    if (devtools.isDestroyed()) return;
    devtools.hide();
  });
  win.on('closed', () => {
    if (devToolsWindow && !devToolsWindow.isDestroyed()) devToolsWindow.destroy();
    devToolsWindow = null;
  });
  win.webContents.openDevTools({ mode: 'detach', title: 'Tasi Harness DevTools' });
}

function resetEmbeddedPreviewWebContentsState(target: WebContents): void {
  try {
    target.setZoomFactor(1);
  } catch {
    // Ignore zoom factor reset failures for transient guest states.
  }
  try {
    target.setZoomLevel(0);
  } catch {
    // Ignore zoom level reset failures for transient guest states.
  }
  void target.setVisualZoomLevelLimits(1, 1).catch(() => {
    // Ignore visual zoom reset failures when guest is not ready yet.
  });
}

function resolveEmbeddedPreviewWebContents(): WebContents | null {
  if (!embeddedPreviewWebContentsId) return null;
  const target = webContents.fromId(embeddedPreviewWebContentsId);
  if (!target || target.isDestroyed()) return null;
  if (sessionPartition(target) !== EMBEDDED_BROWSER_PARTITION) return null;
  return target;
}

context.embeddedBrowserAutomation.setSharedWebContentsResolver(() => resolveEmbeddedPreviewWebContents());

function sessionPartition(target: WebContents): string {
  const sessionLike = target.session as unknown as { getPartition?: () => string; partition?: string };
  if (typeof sessionLike.getPartition === 'function') return sessionLike.getPartition();
  if (typeof sessionLike.partition === 'string') return sessionLike.partition;
  return '';
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
  let argsText = '';
  try {
    argsText = JSON.stringify(args);
  } catch {
    argsText = String(args);
  }
  return `${toolName} ${argsText} ${content}`.toLowerCase();
}

function shouldFallbackOpenExternal(toolName: string, args: unknown, content: string): boolean {
  const combined = previewSourceText(toolName, args, content);
  if (toolName.startsWith('browser_')) return true;
  if (combined.includes('browser_preview_url')) return true;
  return false;
}

function isWebPreviewEvent(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (event.toolName.startsWith('browser_')) return true;
  if (combined.includes('browser_preview_url')) return true;
  return event.toolName.toLowerCase().includes('open') && combined.includes('http');
}

function latestWebPreviewUrlFromSource(toolName: string, args: unknown, content: string, fallbackOnly = false): string | undefined {
  if (fallbackOnly && !shouldFallbackOpenExternal(toolName, args, content)) return undefined;
  const fromMarker = extractPreviewUrlMarker(content || '');
  if (fromMarker) return fromMarker;
  const fromArgs = extractUrlFromValue(args);
  if (fromArgs) return fromArgs;
  return extractUrlFromValue(content);
}

function latestWebPreviewUrlFromEvents(events: ToolEvent[], fallbackOnly = false): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (!isWebPreviewEvent(event)) continue;
    const next = latestWebPreviewUrlFromSource(event.toolName, event.args, event.content, fallbackOnly);
    if (next) latest = next;
  }
  return latest;
}

async function maybeOpenExternalBrowser(url?: string): Promise<ToolExecutionResult> {
  if (!url) return { ok: false, content: 'No preview URL available to open.' };
  const config = context.getConfig();
  if (config.browserMode !== 'external') {
    return { ok: false, content: 'External browser mode is not active.' };
  }
  const now = Date.now();
  if (lastExternalBrowserOpen && lastExternalBrowserOpen.url === url && now - lastExternalBrowserOpen.at < 1500) {
    return { ok: true, content: `External browser already opened recently for ${url}.` };
  }
  const managed = await externalBrowserBridge.open(url, config);
  if (managed.ok) {
    lastExternalBrowserOpen = { url, at: now };
    return managed;
  }
  console.warn(`[browser][external] managed open failed for ${url}; fallback=shell.openExternal; reason=${managed.content}`);
  try {
    await shell.openExternal(url);
    externalFallbackUrls.add(url);
    lastExternalBrowserOpen = { url, at: now };
    return {
      ok: true,
      content: `Managed external open failed (${managed.content}); fell back to shell.openExternal for ${url}.`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[browser] failed to open system default browser for ${url}: ${message}`);
    return {
      ok: false,
      content: `Failed both managed and fallback open for ${url}. managed=${managed.content}; fallback=${message}`
    };
  }
}

async function closeExternalBrowserPreview(): Promise<ToolExecutionResult> {
  const managedResult = await externalBrowserBridge.close();
  const fallbackCount = externalFallbackUrls.size;
  externalFallbackUrls.clear();
  lastExternalBrowserOpen = null;
  if (fallbackCount <= 0) return managedResult;
  return {
    ok: managedResult.ok,
    content: `${managedResult.content} ${fallbackCount} fallback URL(s) were opened via shell.openExternal and cannot be auto-closed.`
  };
}

async function createWindow(): Promise<void> {
  const appIconPath = resolveAppWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: 'Tasi Harness',
    backgroundColor: '#0a0a0f',
    ...(appIconPath ? { icon: appIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      openMainWindowDevTools(mainWindow);
    });
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => context.configStore.publicConfig(false));
  ipcMain.handle('config:set', async (_event, partial: Partial<AppConfig>) => {
    const sanitized = { ...partial };
    if (typeof sanitized.apiKey !== 'string') delete sanitized.apiKey;
    const next = context.configStore.update(sanitized);
    startWechatPoller();
    if (next.browserMode !== 'external') await closeExternalBrowserPreview();
    return { ...context.configStore.publicConfig(false), apiKeyConfigured: Boolean(next.apiKey) };
  });
  ipcMain.handle('config:test', async () => testLlmConnection(context.getConfig()));
  ipcMain.handle('config:wechatQrcode', async () => {
    const payload = await fetchWechatChannelQrCode(context.getConfig().wechatChannel.bindUrl);
    if (payload.qrcodeKey) {
      context.configStore.update({
        wechatChannel: {
          ...context.getConfig().wechatChannel,
          lastQrcodeKey: payload.qrcodeKey,
          loginStatus: 'wait',
          lastError: ''
        }
      });
    }
    return payload;
  });
  ipcMain.handle('config:wechatQrcodeStatus', async (_event, qrcodeKey: string) => {
    try {
      const status = await fetchWechatQrcodeStatus(qrcodeKey);
      const current = context.getConfig().wechatChannel;
      if (status.status === 'confirmed' && status.botToken) {
        context.configStore.update({
          wechatChannel: {
            ...current,
            enabled: true,
            botToken: status.botToken,
            botId: status.botId,
            userId: status.userId,
            baseUrl: status.baseUrl || current.baseUrl || 'https://ilinkai.weixin.qq.com',
            cursor: '',
            loginStatus: 'confirmed',
            lastError: ''
          }
        });
        startWechatPoller();
      } else {
        context.configStore.update({
          wechatChannel: {
            ...current,
            loginStatus: status.status === 'unknown' ? 'error' : status.status
          }
        });
      }
      return status;
    } catch (error) {
      if (isAbortLikeError(error)) {
        return { status: 'unknown', fetchedAt: new Date().toISOString() };
      }
      throw error;
    }
  });

  ipcMain.handle('agent:chat', async (_event, input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean) => {
    if (!input || !input.trim()) throw new Error('Message cannot be empty.');
    const senderId = _event.sender.id;
    if (activeChatControllers.has(senderId)) throw new Error('A chat session is already running.');
    const controller = new AbortController();
    activeChatControllers.set(senderId, controller);
    try {
      const result = await context.agentLoop.run({
        userInput: input,
        sessionId,
        executionMode,
        usePersonalKnowledgeBase: usePersonalKnowledgeBase === true,
        origin: 'chat',
        signal: controller.signal,
        onToolEvent: (eventSessionId, toolEvent) => {
          const payload: AgentToolEventStream = { sessionId: eventSessionId, event: toolEvent };
          _event.sender.send('agent:tool-event', payload);
        }
      });
      const followUpQuestions = await generateFollowUpQuestions(
        () => createLlmClient(context.getConfig()),
        context.getConfig(),
        { userInput: input, finalResponse: result.finalResponse }
      );
      const usageRecord = context.sessionStore.recordUsage(result.sessionId, result.usage);
      broadcastSessionUpdated({
        sessionId: result.sessionId,
        source: 'chat',
        updatedAt: new Date().toISOString()
      });
      return { ...result, followUpQuestions, totalUsage: usageRecord.totalUsage };
    } catch (error) {
      if (controller.signal.aborted || isAbortLikeError(error)) throw new Error('Session stopped by user.');
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const active = activeChatControllers.get(senderId);
      if (active === controller) activeChatControllers.delete(senderId);
      if (context.getConfig().browserMode === 'external') await closeExternalBrowserPreview();
    }
  });

  ipcMain.handle('agent:stop', async (_event) => {
    const senderId = _event.sender.id;
    const controller = activeChatControllers.get(senderId);
    if (!controller) return { ok: true, content: 'No active chat session to stop.' };
    controller.abort();
    if (context.getConfig().browserMode === 'external') {
      await closeExternalBrowserPreview();
    }
    return { ok: true, content: 'Stop signal sent.' };
  });

  ipcMain.handle('sessions:list', () => context.sessionStore.list());
  ipcMain.handle('sessions:read', (_event, id: string) => context.sessionStore.read(id));
  ipcMain.handle('sessions:delete', (_event, id: string) => context.sessionStore.delete(id));
  ipcMain.handle('sessions:rename', (_event, id: string, title: string) => context.sessionStore.rename(id, title));
  ipcMain.handle('sessions:search', (_event, query: string) => context.sessionStore.search(query).map((r) => r.item));
  ipcMain.handle('sessions:appendExternalMessage', (_event, req: ExternalSessionMessageRequest) => {
    const content = req.content?.trim();
    if (!content) throw new Error('content is required.');
    const role = req.role === 'assistant' ? 'assistant' : 'user';
    const existing = req.sessionId?.trim() ? context.sessionStore.read(req.sessionId.trim()) : null;
    const session = existing ?? context.sessionStore.create(req.title?.trim() || 'WeChat session');
    const updated = context.sessionStore.appendMessages(session.id, [{
      role,
      content,
      createdAt: req.createdAt
    }], []);
    broadcastSessionUpdated({
      sessionId: updated.id,
      source: 'external',
      updatedAt: updated.updatedAt
    });
    return updated;
  });

  ipcMain.handle('memory:get', (_event, query?: MemoryQueryOptions) => context.memoryStore.getState(query));
  ipcMain.handle('memory:clear', (_event, request: MemoryClearRequest) => context.memoryStore.clear(request));
  ipcMain.handle('knowledge:list', () => context.personalKnowledgeBase.getState());
  ipcMain.handle('knowledge:addDocument', (_event, req: PersonalKnowledgeUploadRequest) => context.personalKnowledgeBase.addDocument(req));
  ipcMain.handle('knowledge:deleteDocument', (_event, id: string) => context.personalKnowledgeBase.deleteDocument(id));
  ipcMain.handle('session-docs:list', (_event, sessionId: string) => context.sessionDocumentContextStore.list(sessionId));
  ipcMain.handle('session-docs:upload', async (_event, req: SessionDocumentUploadRequest) => {
    const session = req.sessionId
      ? context.sessionStore.read(req.sessionId) ?? context.sessionStore.create()
      : context.sessionStore.create();
    const document = await context.sessionDocumentContextStore.addDocument({
      ...req,
      sessionId: session.id,
      workspaceDir: context.getConfig().workspaceDir
    });
    return { sessionId: session.id, document };
  });
  ipcMain.handle('session-docs:delete', (_event, sessionId: string, id: string) => context.sessionDocumentContextStore.deleteDocument(sessionId, id));

  ipcMain.handle('skills:list', () => context.skillManager.list());
  ipcMain.handle('skills:read', (_event, name: string) => context.skillManager.read(name));
  ipcMain.handle('skills:create', (_event, req: SkillWriteRequest) => context.skillManager.create(req));
  ipcMain.handle('skills:patch', (_event, req: SkillPatchRequest) => context.skillManager.patch(req));
  ipcMain.handle('skills:delete', (_event, name: string) => context.skillManager.delete(name));
  ipcMain.handle('skills:uploadArchive', (_event, req: SkillArchiveUploadRequest) => context.skillManager.uploadArchive(req));
  ipcMain.handle('skills:market:browse', (_event, query?: string) => context.marketplaceManager.browse(query));
  ipcMain.handle('skills:market:install', (_event, req: SkillInstallRequest) => context.marketplaceManager.install(req));
  ipcMain.handle('skills:market:uninstall', (_event, name: string) => context.marketplaceManager.uninstall(name));

  ipcMain.handle('tasks:list', () => context.scheduledTaskStore.list());
  ipcMain.handle('tasks:create', (_event, req: ScheduledTaskCreateRequest) => context.scheduledTaskStore.create(req));
  ipcMain.handle('tasks:update', (_event, req: ScheduledTaskPatchRequest) => context.scheduledTaskStore.update(req));
  ipcMain.handle('tasks:delete', (_event, id: string) => context.scheduledTaskStore.delete(id));
  ipcMain.handle('tasks:runNow', async (_event, id: string) => {
    const task = context.scheduledTaskStore.list().find((item) => item.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    context.scheduledTaskStore.setRunning(id, true);
    try {
      const result = await context.agentLoop.run({
        userInput: task.prompt,
        sessionId: task.sessionId,
        executionMode: task.executionMode,
        origin: 'scheduled',
        scheduledTaskId: task.id
      });
      const usageRecord = context.sessionStore.recordUsage(result.sessionId, result.usage);
      const updated = context.scheduledTaskStore.markRun(id, {
        sessionId: result.sessionId,
        output: result.finalResponse,
        iterations: result.iterations,
        toolEventCount: result.toolEvents.length,
        trace: buildTaskTrace(result)
      });
      if (updated.notifyByEmail) {
        await context.emailNotifier.send(
          context.getConfig().emailNotifications,
          `[Tasi Harness] ${updated.name}`,
          [`Task: ${updated.name}`, `Run at: ${updated.lastRunAt ?? updated.updatedAt}`, '', result.finalResponse].join('\n')
        );
      }
      if (updated.notifyByWechat) {
        try {
          await sendWechatTaskNotification(
            updated.name,
            updated.lastRunAt ?? updated.updatedAt,
            result.execution.mode,
            result.finalResponse
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const cfg = context.getConfig();
          const shouldResetContext = /ret=-2|parameter/i.test(message);
          context.configStore.update({
            wechatChannel: {
              ...cfg.wechatChannel,
              lastError: `[runNow-wechat-notify] ${message}`,
              lastContextToken: shouldResetContext ? '' : cfg.wechatChannel.lastContextToken
            }
          });
        }
      }
      broadcastSessionUpdated({
        sessionId: result.sessionId,
        source: 'scheduled',
        updatedAt: new Date().toISOString()
      });
      return { ...result, totalUsage: usageRecord.totalUsage };
    } catch (error) {
      context.scheduledTaskStore.markRun(id, {
        error: error instanceof Error ? error.message : String(error),
        trace: error instanceof Error ? error.stack || error.message : String(error)
      });
      throw error;
    } finally {
      if (context.getConfig().browserMode === 'external') await closeExternalBrowserPreview();
    }
  });

  ipcMain.handle('tools:list', () => context.toolRegistry.definitions(context.getConfig().enabledToolNames));
  ipcMain.handle('tools:run', async (_event, req: ToolRunRequest) => {
    const cfg = context.getConfig();
    const result = await context.toolRegistry.execute(req.name, req.args, {
      sessionId: req.sessionId || 'manual',
      workspaceDir: req.executionMode === 'sandbox' ? context.sandboxManager.prepare('sandbox', cfg.workspaceDir, createId('manual-run')).workspaceDir : cfg.workspaceDir,
      requestId: createId('manual')
    });
    await maybeOpenExternalBrowser(latestWebPreviewUrlFromSource(req.name, req.args, result.content, true));
    return result;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    harnessHome: context.harnessHome
  }));
  ipcMain.handle('app:openPath', async (_event, path: string) => {
    const err = await shell.openPath(path);
    return { ok: !err, content: err || 'Opened.' };
  });
  ipcMain.handle('app:openExternalUrl', async (_event, url: string) => maybeOpenExternalBrowser(url));
  ipcMain.handle('app:closeExternalPreview', async () => closeExternalBrowserPreview());
  ipcMain.handle('app:setEmbeddedPreviewWebContentsId', (_event, id: number | null) => {
    if (id == null) {
      embeddedPreviewWebContentsId = null;
      return { ok: true, content: 'Cleared embedded preview webContents binding.' };
    }
    const numeric = Number(id);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { ok: false, content: `Invalid webContents id: ${id}` };
    }
    const target = webContents.fromId(Math.trunc(numeric));
    if (!target || target.isDestroyed()) {
      return { ok: false, content: `webContents not found: ${id}` };
    }
    if (sessionPartition(target) !== EMBEDDED_BROWSER_PARTITION) {
      return { ok: false, content: `webContents ${id} is not in embedded browser partition ${EMBEDDED_BROWSER_PARTITION}.` };
    }
    embeddedPreviewWebContentsId = target.id;
    resetEmbeddedPreviewWebContentsState(target);
    target.once('did-stop-loading', () => resetEmbeddedPreviewWebContentsState(target));
    return { ok: true, content: `Bound embedded preview webContents id=${target.id}.` };
  });
}

app.on('before-quit', () => {
  isAppQuitting = true;
  for (const controller of activeChatControllers.values()) controller.abort();
  activeChatControllers.clear();
  stopWechatPoller();
  void closeExternalBrowserPreview();
});

app.whenReady().then(() => {
  applyPlatformAppIdentity();
  applyAppDockIcon();
  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      if (contents.id === embeddedPreviewWebContentsId) embeddedPreviewWebContentsId = null;
      const controller = activeChatControllers.get(contents.id);
      if (controller) {
        controller.abort();
        activeChatControllers.delete(contents.id);
      }
    });
  });
  registerIpc();
  startWechatPoller();
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
