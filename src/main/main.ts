import type { BrowserWindow as ElectronBrowserWindow, ContextMenuParams, MenuItemConstructorOptions, Rectangle, WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { AppContext } from './appContext.js';
import { generateFollowUpQuestions } from './agent/followUpQuestions.js';
import { createLlmClient, testLlmConnection } from './agent/llmClient.js';
import type {
  AgentToolEventStream,
  AgentArtifactRef,
  AgentMessage,
  AgentMessageAttachment,
  AgentRunResult,
  AssistantMessageExportRequest,
  AppConfig,
  ArtifactPathRequest,
  ArtifactPreviewRequest,
  ArtifactPreviewResult,
  BrowserCoachGenerateSkillRequest,
  BrowserCoachRecording,
  BrowserCoachStartRequest,
  BrowserCoachStoredRecording,
  ExternalSessionMessageRequest,
  MemoryClearRequest,
  ToolEvent,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolExecutionResult,
  MemoryQueryOptions,
  LiveAgentTaskCreateRequest,
  LiveAgentTaskUpdateEvent,
  LiveSessionAppendMessageRequest,
  LiveRealtimeClientEvent,
  LiveRealtimeEvent,
  LiveRealtimeStartRequest,
  PersonalKnowledgeUploadRequest,
  RegisteredTool,
  SessionDocumentUploadRequest,
  SessionListPageRequest,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SessionRecord,
  SessionUpdateEvent,
  SkillArchiveUploadRequest,
  MarketplaceBrowseRequest,
  SkillInstallRequest,
  SkillOptimizationRunRequest,
  SkillPatchRequest,
  SkillWriteRequest,
  CustomThemeTokens,
  DreamSkinGalleryQuery,
  DreamSkinThemeInstallRequest,
  DshMarketplaceBrowseRequest,
  DshMarketplacePluginInstallRequest,
  DshSidecarClientMount,
  DshSidecarClientMountOpenRequest,
  DshSidecarChatRunRequest,
  DshSidecarChatRunResult,
  DshSidecarInputPart,
  DshSidecarPluginActionRequest,
  DshSidecarPluginInstallRequest,
  DshSidecarPluginUploadRequest,
  DshSidecarRuntimePlugin,
  ExternalConversationMetadata,
  ThemeImportRequest,
  ToolRunRequest,
  WechatChannelLoginStatusPayload,
  WechatChannelQrCodePayload
} from '../shared/types.js';
import { createId, nowIso } from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION, EMBEDDED_BROWSER_PREVIEW_PARTITION } from '../shared/browserConstants.js';
import { classifyArtifactKind, isArtifactExtension, mimeTypeForArtifact, previewModeForArtifact } from '../shared/artifacts.js';
import { applyBrandDockIcon, applyPlatformAppIdentity, resolveBrandWindowIconPath } from './appIcon.js';
import { normalizeArtifactRequestPath, resolveArtifactRequestPath as resolveArtifactRequestPathWithContext, type ArtifactResolutionSession } from './artifactRequests.js';
import { buildAssistantMessageDocx, buildAssistantMessageExportHtml, safeExportBasename } from './export/messageExport.js';
import { BrowserCoachRecorder } from './browser/browserCoachRecorder.js';
import { buildBrowserCoachSkillContentWithModel } from './browser/browserCoachSkill.js';
import { isPathInside, objectArgs, resolveToolPath, stringArg } from './tools/toolRegistry.js';
import { LiveTaskQueue } from './live/liveTaskQueue.js';
import { LiveSessionStore } from './live/liveSessionStore.js';
import { RealtimeSessionManager } from './live/realtimeSessionManager.js';
import { importThemePackage } from './storage/themeImporter.js';
import { installDreamSkinTheme, listDreamSkinGallery } from './storage/dreamSkinGallery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronRequire = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, webContents } = electronRequire('electron/main') as typeof import('electron/main');
const { shell, clipboard } = electronRequire('electron/common') as typeof import('electron/common');
let mainWindow: ElectronBrowserWindow | null = null;
let devToolsWindow: ElectronBrowserWindow | null = null;
const pluginClientWindows = new Map<string, ElectronBrowserWindow>();
const context = new AppContext();
context.dshSidecarManager.setMainRequestHandler(handleDshSidecarMainRequest);
const browserCoachRecorder = new BrowserCoachRecorder(
  join(__dirname, '..', 'preload', 'browserCoachPreload.js'),
  (recording) => {
    saveStoppedBrowserCoachRecording(recording);
  }
);
let embeddedPreviewWebContentsId: number | null = null;
let isAppQuitting = false;
let lastExternalBrowserOpen: { url: string; at: number } | null = null;
const externalFallbackUrls = new Set<string>();
const activeChatControllers = new Map<number, AbortController>();
const activeWechatRuns = new Map<string, AbortController>();
let wechatPollerAbortController: AbortController | null = null;
let wechatPollerFingerprint = '';
let embeddedPreviewResetCleanup: (() => void) | null = null;
const seenWechatMessageIds: string[] = [];
const seenWechatMessageIdSet = new Set<string>();
const WECHAT_PENDING_MARKER = '__TASI_WECHAT_PENDING__';
const EXTERNAL_IM_MAX_CONCURRENT_RUNS = 1;
let activeExternalImRuns = 0;
const externalImSlotWaiters: Array<() => void> = [];
const externalImSessionQueues = new Map<string, Promise<unknown>>();
const KNOWLEDGE_IMPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.log', '.json', '.csv', '.docx', '.xlsx', '.pptx', '.pdf', '.ofd']);
const WECHAT_DOCUMENT_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx', '.pdf', '.ofd', '.xml', '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.text']);
const MAX_WECHAT_MULTIMEDIA_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_WECHAT_DOCUMENT_BYTES = 32 * 1024 * 1024;
const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const BUILTIN_TITLE_BAR_THEME_TOKENS: Record<'dark' | 'light' | 'tech', Pick<CustomThemeTokens, 'bgPrimary' | 'textPrimary'>> = {
  dark: {
    bgPrimary: '#0a0a0f',
    textPrimary: '#f0f0f5'
  },
  light: {
    bgPrimary: '#f5f6fb',
    textPrimary: '#1a1a2e'
  },
  tech: {
    bgPrimary: '#081f3a',
    textPrimary: '#eef9ff'
  }
};
const TITLE_BAR_TRANSPARENT_COLOR = 'rgba(0, 0, 0, 0)';
type TitleBarThemeConfig = Pick<AppConfig, 'theme' | 'customThemes' | 'textColor'>;
type TitleBarThemeTokens = Pick<CustomThemeTokens, 'bgPrimary' | 'textPrimary'>;
const pendingToolApprovals = new Map<string, {
  senderId: number;
  request: ToolApprovalRequest;
  resolve: (decision: ToolApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

function logAgentChatError(details: {
  error: unknown;
  input?: string;
  sessionId?: string;
  executionMode?: 'workspace' | 'sandbox';
  attachments?: AgentMessageAttachment[];
}): void {
  const cfg = context.getConfig();
  const file = join(context.harnessHome, 'logs', 'agent-errors.log');
  const error = details.error;
  const record = {
    at: new Date().toISOString(),
    event: 'agent.chat.error',
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    sessionId: details.sessionId,
    executionMode: details.executionMode,
    inputLength: details.input?.length ?? 0,
    attachments: (details.attachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    })),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (logError) {
    console.warn(`[agent] failed to write error log: ${logError instanceof Error ? logError.message : String(logError)}`);
  }
}

function firstDshPluginMention(input: string): string | undefined {
  const match = input.match(/(^|[\s,;.!?\u3001\u3002\uff0c\uff1b\uff01\uff1f])@([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/);
  return match?.[2]?.trim().replace(/^@/, '');
}

function dshRuntimePluginAliases(plugin: DshSidecarRuntimePlugin): string[] {
  const aliases = new Set<string>();
  const add = (value?: string) => {
    const clean = value?.trim().replace(/^@/, '').replace(/^\//, '').toLowerCase();
    if (clean) aliases.add(clean);
  };
  add(plugin.id);
  add(plugin.packageName);
  const packageParts = plugin.packageName.replace(/^@/, '').split('/');
  if (packageParts.length > 1) {
    add(packageParts.join('/'));
    add(packageParts.at(-1));
  }
  for (const command of plugin.commands ?? []) add(command);
  return [...aliases];
}

function resolveDshRuntimePluginMention(ref: string, plugins: DshSidecarRuntimePlugin[]): DshSidecarRuntimePlugin | undefined {
  const clean = ref.trim().replace(/^@/, '').toLowerCase();
  return plugins.find((plugin) => dshRuntimePluginAliases(plugin).includes(clean));
}

function canHandleDirectDshSidecarChat(plugin: DshSidecarRuntimePlugin): boolean {
  if (!plugin.enabled || (plugin.status !== 'loaded' && plugin.status !== 'partial')) return false;
  return (plugin.commands ?? []).length > 0;
}

function dshInputParts(input: string, attachments?: AgentMessageAttachment[]): DshSidecarInputPart[] {
  const parts: DshSidecarInputPart[] = [];
  if (input.trim()) parts.push({ type: 'text', text: input });
  for (const attachment of attachments ?? []) {
    const base = {
      name: attachment.filename,
      mime: attachment.mimeType,
      data: attachment.contentBase64
    };
    if (attachment.kind === 'image') parts.push({ type: 'image', ...base });
    else if (attachment.kind === 'audio') parts.push({ type: 'audio', ...base });
    else if (attachment.kind === 'video') parts.push({ type: 'video', ...base });
  }
  return parts;
}

function recentSidecarMessages(sessionId?: string): NonNullable<DshSidecarChatRunRequest['context']>['recentMessages'] {
  if (!sessionId) return [];
  const record = context.sessionStore.read(sessionId);
  if (!record) return [];
  return record.messages
    .filter((message) => message.hidden !== true && message.content.trim())
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name
    }));
}

function sidecarResultContent(result: DshSidecarChatRunResult): string {
  const textParts = (result.parts ?? [])
    .filter((part): part is Extract<NonNullable<DshSidecarChatRunResult['parts']>[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text.trim())
    .filter(Boolean);
  const artifactLines = (result.artifacts ?? [])
    .map((artifact) => `Artifact: ${artifact.name} (${artifact.path})`);
  const seen = new Set<string>();
  const chunks = [
    result.content?.trim(),
    ...textParts,
    ...artifactLines
  ].filter((chunk): chunk is string => Boolean(chunk));
  const body = chunks.filter((chunk) => {
    if (seen.has(chunk)) return false;
    seen.add(chunk);
    return true;
  }).join('\n\n').trim();
  if (body) return body;
  if (result.error) return result.error;
  return result.ok ? 'DSH sidecar completed without textual output.' : 'DSH sidecar failed without an error message.';
}

function dshSidecarToolMessage(event: ToolEvent): AgentMessage {
  return {
    id: event.id,
    role: 'tool',
    name: event.toolName,
    hidden: true,
    content: event.content,
    createdAt: event.createdAt
  };
}

function artifactResolutionSession(record: SessionRecord): ArtifactResolutionSession {
  return {
    id: record.id,
    updatedAt: record.updatedAt,
    workspaceDir: record.lastExecution?.workspaceDir,
    artifacts: record.messages.flatMap((message) => message.artifacts ?? [])
  };
}

function artifactResolutionSessions(preferredSessionId?: string): ArtifactResolutionSession[] {
  const sessions: ArtifactResolutionSession[] = [];
  const seen = new Set<string>();
  const addRecord = (record: SessionRecord | null) => {
    if (!record || seen.has(record.id)) return;
    seen.add(record.id);
    sessions.push(artifactResolutionSession(record));
  };
  const preferred = preferredSessionId?.trim();
  if (preferred) addRecord(context.sessionStore.read(preferred));
  for (const summary of context.sessionStore.list().slice(0, 48)) addRecord(context.sessionStore.read(summary.id));
  return sessions;
}

function resolveArtifactRequestPath(req: ArtifactPathRequest): string {
  return resolveArtifactRequestPathWithContext(req, {
    workspaceDir: context.getConfig().workspaceDir,
    harnessHome: context.harnessHome,
    sessions: artifactResolutionSessions(req.sessionId)
  });
}

function artifactRefFromPath(path: string, source: AgentArtifactRef['source'] = 'assistant-link'): AgentArtifactRef {
  const stat = statSync(path);
  const ext = extname(path).toLowerCase();
  return {
    id: createId('artifact'),
    name: basename(path),
    path: isPathInside(context.getConfig().workspaceDir, path) ? relative(context.getConfig().workspaceDir, path) : path,
    absPath: path,
    ext,
    kind: classifyArtifactKind(ext),
    previewMode: previewModeForArtifact(ext),
    mimeType: mimeTypeForArtifact(ext),
    sizeBytes: stat.size,
    source,
    createdAt: nowIso()
  };
}

function dshSidecarArtifacts(result: DshSidecarChatRunResult, workspaceDir: string): AgentArtifactRef[] {
  const out: AgentArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of result.artifacts ?? []) {
    const raw = artifact.path?.trim();
    if (!raw) continue;
    const normalizedRaw = normalizeArtifactRequestPath(raw);
    const target = isAbsolute(normalizedRaw) ? resolve(normalizedRaw) : resolve(workspaceDir, normalizedRaw);
    if (seen.has(target) || !existsSync(target)) continue;
    const stat = statSync(target);
    if (!stat.isFile()) continue;
    const ext = extname(target).toLowerCase();
    if (!isArtifactExtension(ext)) continue;
    seen.add(target);
    out.push({
      id: createId('artifact'),
      name: artifact.name?.trim() || basename(target),
      path: isPathInside(workspaceDir, target) ? relative(workspaceDir, target) : target,
      absPath: target,
      ext,
      kind: classifyArtifactKind(ext),
      previewMode: previewModeForArtifact(ext),
      mimeType: artifact.mime || mimeTypeForArtifact(ext),
      sizeBytes: stat.size,
      source: 'dsh-sidecar',
      createdAt: nowIso()
    });
  }
  return out;
}

function execFileText(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([error.message, stderr].filter(Boolean).join('\n')));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function exportOfficeArtifactToPdf(target: string, artifact: AgentArtifactRef): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null;
  if (!['.docx', '.pptx', '.xlsx'].includes(artifact.ext)) return null;
  const sourceStat = statSync(target);
  const cacheKey = createHash('sha256')
    .update(`${target}\n${sourceStat.size}\n${sourceStat.mtimeMs}`)
    .digest('hex');
  const safeName = basename(target).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const previewDir = join(context.harnessHome, 'artifact-previews', 'office-pdf');
  mkdirSync(previewDir, { recursive: true });
  const pdfPath = join(previewDir, `${cacheKey}-${safeName}.pdf`);
  if (existsSync(pdfPath) && statSync(pdfPath).isFile() && statSync(pdfPath).size > 0) {
    return readFileSync(pdfPath);
  }

  const scriptPath = join(previewDir, 'export-office-preview.ps1');
  const script = `
param(
  [Parameter(Mandatory = $true)][string]$inputPath,
  [Parameter(Mandatory = $true)][string]$outputPath
)
$ErrorActionPreference = 'Stop'
$ext = [System.IO.Path]::GetExtension($inputPath).ToLowerInvariant()
$outDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
function Release-Com($value) {
  if ($null -ne $value) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($value)
  }
}
switch ($ext) {
  '.docx' {
    $app = $null
    $doc = $null
    try {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $doc = $app.Documents.Open($inputPath, $false, $true, $false)
      $doc.ExportAsFixedFormat($outputPath, 17)
    } finally {
      if ($null -ne $doc) { $doc.Close($false); Release-Com $doc }
      if ($null -ne $app) { $app.Quit(); Release-Com $app }
    }
  }
  '.pptx' {
    $app = $null
    $presentation = $null
    try {
      $app = New-Object -ComObject PowerPoint.Application
      $presentation = $app.Presentations.Open($inputPath, $true, $true, $false)
      $presentation.SaveAs($outputPath, 32)
    } finally {
      if ($null -ne $presentation) { $presentation.Close(); Release-Com $presentation }
      if ($null -ne $app) { $app.Quit(); Release-Com $app }
    }
  }
  '.xlsx' {
    $app = $null
    $workbook = $null
    try {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $workbook = $app.Workbooks.Open($inputPath, 3, $true)
      $workbook.ExportAsFixedFormat(0, $outputPath)
    } finally {
      if ($null -ne $workbook) { $workbook.Close($false); Release-Com $workbook }
      if ($null -ne $app) { $app.Quit(); Release-Com $app }
    }
  }
  default { throw "Unsupported Office preview extension: $ext" }
}
if (!(Test-Path -LiteralPath $outputPath)) { throw "Office did not create a PDF preview." }
`;
  writeFileSync(scriptPath, script, 'utf8');

  try {
    await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, target, pdfPath], 180_000);
    if (!existsSync(pdfPath) || statSync(pdfPath).size === 0) return null;
    return readFileSync(pdfPath);
  } catch (cause) {
    try {
      if (existsSync(pdfPath)) rmSync(pdfPath, { force: true });
    } catch {
      // Ignore cleanup failures for preview cache files.
    }
    console.warn('[artifactPreview] Office PDF export failed, using browser preview fallback:', cause);
    return null;
  }
}

async function artifactPreview(req: ArtifactPreviewRequest): Promise<ArtifactPreviewResult> {
  const target = resolveArtifactRequestPath(req);
  const artifact = artifactRefFromPath(target);
  const defaultMaxBytes = ['pdf', 'model3d', 'office'].includes(artifact.previewMode) ? 256 * 1024 * 1024 : 8 * 1024 * 1024;
  const maxBytes = Math.max(1, Math.min(256 * 1024 * 1024, Math.floor(Number(req.maxBytes) || defaultMaxBytes)));
  const size = artifact.sizeBytes ?? 0;
  if (size > maxBytes && artifact.previewMode !== 'external') {
    throw new Error(`Artifact is too large to preview (${size} bytes). Use Open instead.`);
  }
  if (artifact.previewMode === 'text' || artifact.previewMode === 'code' || artifact.previewMode === 'markdown') {
    return { artifact, content: readFileSync(target, 'utf8') };
  }
  if (artifact.previewMode === 'office') {
    const exportedPdf = await exportOfficeArtifactToPdf(target, artifact);
    if (exportedPdf) {
      return {
        artifact: { ...artifact, mimeType: 'application/pdf' },
        dataBase64: exportedPdf.toString('base64'),
        content: 'office-pdf-preview'
      };
    }
    return { artifact, dataBase64: readFileSync(target).toString('base64') };
  }
  if (artifact.previewMode === 'image' || artifact.previewMode === 'pdf' || artifact.previewMode === 'model3d' || artifact.previewMode === 'media') {
    return { artifact, dataBase64: readFileSync(target).toString('base64') };
  }
  return { artifact };
}

async function maybeRunDshSidecarChatTurn(params: {
  sender: WebContents;
  input: string;
  sessionId?: string;
  executionMode?: 'workspace' | 'sandbox';
  attachments?: AgentMessageAttachment[];
  controller: AbortController;
}): Promise<AgentRunResult | null> {
  const pluginRef = firstDshPluginMention(params.input);
  if (!pluginRef) return null;
  let runtimePlugin: DshSidecarRuntimePlugin | undefined;
  try {
    const runtimeStatus = await context.dshSidecarManager.runtimeStatus();
    runtimePlugin = resolveDshRuntimePluginMention(pluginRef, runtimeStatus.plugins);
  } catch {
    runtimePlugin = undefined;
  }
  if (!runtimePlugin || !canHandleDirectDshSidecarChat(runtimePlugin)) return null;
  const cfg = context.getConfig();
  const requestId = createId('run');
  const execution = context.sandboxManager.prepare(params.executionMode ?? cfg.defaultExecutionMode, cfg.workspaceDir, requestId);
  const session = params.sessionId
    ? context.sessionStore.read(params.sessionId) ?? context.sessionStore.create('New session', params.sessionId)
    : context.sessionStore.create();
  const attachments = Array.isArray(params.attachments) ? params.attachments : undefined;
  const userMessage: AgentMessage = {
    id: createId('msg'),
    role: 'user',
    content: params.input,
    attachments: attachments?.length ? attachments : undefined,
    createdAt: nowIso()
  };
  const userUpdated = context.sessionStore.appendMessages(session.id, [userMessage], [], execution);
  broadcastSessionUpdated({ sessionId: userUpdated.id, source: 'chat', updatedAt: userUpdated.updatedAt });
  if (params.controller.signal.aborted) throw chatAbortError(params.controller);
  const sidecarResult = await context.dshSidecarManager.chatRun({
    pluginRef,
    sessionId: session.id,
    workspaceDir: execution.workspaceDir,
    input: {
      parts: dshInputParts(params.input, attachments)
    },
    context: {
      recentMessages: recentSidecarMessages(params.sessionId),
      allowedRoots: [execution.workspaceDir],
      locale: app.getLocale(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      llm: {
        provider: cfg.provider,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort
      }
    },
    options: {
      stream: false,
      timeoutMs: 10 * 60_000
    }
  });
  if (params.controller.signal.aborted) throw chatAbortError(params.controller);
  const queuedFollowups = (sidecarResult.messages ?? [])
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (queuedFollowups.length > 0) {
    const sync = await context.dshSidecarRuntimeBridge.sync();
    const followupInput = queuedFollowups.join('\n\n');
    const event: ToolEvent = {
      id: createId('toolevent'),
      toolName: 'dsh_sidecar_chat',
      args: {
        pluginRef,
        queuedFollowups: queuedFollowups.length,
        partTypes: dshInputParts(params.input, attachments).map((part) => part.type)
      },
      ok: sidecarResult.ok,
      content: JSON.stringify({
        ...(sidecarResult.diagnostics ?? { plugin: pluginRef }),
        runtimeTools: sync.toolNames,
        syncError: sync.error
      }, null, 2),
      createdAt: nowIso()
    };
    const eventUpdated = context.sessionStore.appendMessages(session.id, [dshSidecarToolMessage(event)], [event], execution);
    broadcastSessionUpdated({ sessionId: eventUpdated.id, source: 'chat', updatedAt: eventUpdated.updatedAt });
    safeSend(params.sender, 'agent:tool-event', { sessionId: session.id, event: context.sessionStore.toolEventForDisplay(event) } satisfies AgentToolEventStream);
    const result = await context.agentLoop.run({
      userInput: followupInput,
      sessionId: session.id,
      executionMode: params.executionMode,
      origin: 'chat',
      signal: params.controller.signal,
      persistUserMessage: false,
      omitHistoryMessageIds: userMessage.id ? [userMessage.id] : undefined,
      enabledToolNames: [...new Set([...context.getConfig().enabledToolNames, ...sync.toolNames])],
      requestToolApproval: (request) => requestInteractiveToolApproval(params.sender, request),
      onToolEvent: (eventSessionId, toolEvent) => {
        const payload: AgentToolEventStream = { sessionId: eventSessionId, event: context.sessionStore.toolEventForDisplay(toolEvent) };
        safeSend(params.sender, 'agent:tool-event', payload);
      },
      onMessageDelta: (_eventSessionId, messageDelta) => {
        safeSend(params.sender, 'agent:message-delta', messageDelta);
      },
      onSessionUpdated: (record) => {
        broadcastSessionUpdated({
          sessionId: record.id,
          source: 'chat',
          updatedAt: record.updatedAt
        });
      }
    });
    const displayRecord = context.sessionStore.readForDisplay(session.id);
    return {
      ...result,
      messages: displayRecord?.messages ?? result.messages.filter((message) => message.hidden !== true),
      toolEvents: displayRecord?.toolEvents ?? result.toolEvents
    };
  }
  const finalResponse = sidecarResultContent(sidecarResult);
  const artifacts = dshSidecarArtifacts(sidecarResult, execution.workspaceDir);
  const assistantMessage: AgentMessage = {
    id: createId('msg'),
    role: 'assistant',
    content: finalResponse,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    createdAt: nowIso()
  };
  const event: ToolEvent = {
    id: createId('toolevent'),
    toolName: 'dsh_sidecar_chat',
    args: {
      pluginRef,
      partTypes: dshInputParts(params.input, attachments).map((part) => part.type)
    },
    ok: sidecarResult.ok,
    content: JSON.stringify(sidecarResult.diagnostics ?? { plugin: pluginRef }, null, 2),
    createdAt: nowIso()
  };
  const updated = context.sessionStore.appendMessages(session.id, [dshSidecarToolMessage(event), assistantMessage], [event], execution);
  safeSend(params.sender, 'agent:tool-event', { sessionId: session.id, event: context.sessionStore.toolEventForDisplay(event) } satisfies AgentToolEventStream);
  safeSend(params.sender, 'agent:message-delta', {
    sessionId: session.id,
    messageId: assistantMessage.id!,
    role: 'assistant',
    type: 'done',
    content: finalResponse,
    createdAt: assistantMessage.createdAt
  });
  broadcastSessionUpdated({ sessionId: updated.id, source: 'chat', updatedAt: updated.updatedAt });
  return {
    sessionId: session.id,
    finalResponse,
    messages: context.sessionStore.readForDisplay(session.id)?.messages ?? updated.messages,
    toolEvents: context.sessionStore.readForDisplay(session.id)?.toolEvents ?? updated.toolEvents,
    iterations: 1,
    execution
  };
}

async function handleDshSidecarMainRequest(method: string, params: unknown): Promise<unknown> {
  if (method === 'main.chat.run') return await runDshSidecarMainChat(params);
  throw new Error(`Unknown Tasi main request from DSH sidecar: ${method}`);
}

async function runDshSidecarMainChat(params: unknown): Promise<AgentRunResult & { ok: true; content: string }> {
  const request = normalizeDshMainChatRequest(params);
  return await enqueueExternalImRun(request.sessionId, () => executeDshSidecarMainChat(request));
}

async function executeDshSidecarMainChat(request: DshMainChatRequest): Promise<AgentRunResult & { ok: true; content: string }> {
  const cfg = context.getConfig();
  const requestId = createId('run');
  const executionMode = cfg.defaultExecutionMode;
  const workspaceDir = request.workspaceDir ?? externalImWorkspaceDir(request.sessionId);
  const execution = context.sandboxManager.prepare(executionMode, workspaceDir, requestId);
  const session = context.sessionStore.read(request.sessionId) ?? context.sessionStore.create(
    externalImSessionTitle(request.external, request.input),
    request.sessionId,
    { origin: 'external-im', external: request.external }
  );
  const userMessage: AgentMessage = {
    id: createId('msg'),
    role: 'user',
    content: request.input,
    external: request.external,
    attachments: request.attachments.length > 0 ? request.attachments : undefined,
    createdAt: nowIso()
  };
  const updated = context.sessionStore.appendMessages(session.id, [userMessage], [], execution);
  broadcastSessionUpdated({ sessionId: updated.id, source: 'external', updatedAt: updated.updatedAt });
  const sync = await context.dshSidecarRuntimeBridge.sync().catch((error) => ({
    toolNames: [] as string[],
    error: error instanceof Error ? error.message : String(error)
  }));
  const result = await context.agentLoop.run({
    userInput: request.input,
    attachments: request.attachments.length > 0 ? request.attachments : undefined,
    sessionId: session.id,
    executionMode,
    workspaceDir,
    origin: 'scheduled',
    persistUserMessage: false,
    omitHistoryMessageIds: userMessage.id ? [userMessage.id] : undefined,
    enabledToolNames: [...new Set([...cfg.enabledToolNames, ...sync.toolNames])],
    signal: request.controller.signal,
    onToolEvent: (eventSessionId, toolEvent) => {
      broadcastAgentToolEvent({ sessionId: eventSessionId, event: context.sessionStore.toolEventForDisplay(toolEvent) });
    },
    onMessageDelta: (_eventSessionId, messageDelta) => {
      for (const win of BrowserWindow.getAllWindows()) {
        safeSend(win.webContents, 'agent:message-delta', messageDelta);
      }
    },
    onSessionUpdated: (record) => {
      broadcastSessionUpdated({
        sessionId: record.id,
        source: 'external',
        updatedAt: record.updatedAt
      });
    }
  });
  const displayRecord = context.sessionStore.readForDisplay(result.sessionId);
  return {
    ...result,
    ok: true,
    content: result.finalResponse,
    messages: displayRecord?.messages ?? result.messages,
    toolEvents: displayRecord?.toolEvents ?? result.toolEvents
  };
}

interface DshMainChatRequest {
  input: string;
  sessionId: string;
  workspaceDir?: string;
  attachments: AgentMessageAttachment[];
  controller: AbortController;
  external: ExternalConversationMetadata;
}

function normalizeDshMainChatRequest(params: unknown): DshMainChatRequest {
  const record = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const parts = Array.isArray(record.parts) ? normalizeDshMainInputParts(record.parts) : [];
  const directInput = typeof record.input === 'string' ? record.input.trim() : '';
  const input = directInput || dshMainInputText(parts) || 'Message from DSH plugin';
  const external = dshMainExternalMetadata(record);
  return {
    input,
    sessionId: dshMainSessionId(external),
    workspaceDir: dshMainWorkspaceDir(typeof record.workspaceDir === 'string' ? record.workspaceDir : undefined),
    attachments: dshMainAttachments(parts),
    controller: new AbortController(),
    external
  };
}

function normalizeDshMainInputParts(values: unknown[]): DshSidecarInputPart[] {
  const parts: DshSidecarInputPart[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      if (value.trim()) parts.push({ type: 'text', text: value });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : 'text';
    if (type === 'text' || type === 'selection') {
      const text = typeof item.text === 'string' ? item.text : (typeof item.content === 'string' ? item.content : '');
      if (!text.trim()) continue;
      parts.push(type === 'selection' ? { type: 'selection', source: 'chat', text } : { type: 'text', text });
      continue;
    }
    if (type === 'image' || type === 'audio' || type === 'video') {
      parts.push({
        type,
        name: typeof item.name === 'string' ? item.name : undefined,
        mime: typeof item.mime === 'string' ? item.mime : (typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream'),
        data: typeof item.data === 'string' ? item.data : (typeof item.contentBase64 === 'string' ? item.contentBase64 : undefined),
        path: typeof item.path === 'string' ? item.path : undefined
      });
      continue;
    }
    if (type === 'file') {
      const name = typeof item.name === 'string' ? item.name : (typeof item.path === 'string' ? basename(item.path) : 'file');
      parts.push({
        type: 'file',
        name,
        mime: typeof item.mime === 'string' ? item.mime : (typeof item.mimeType === 'string' ? item.mimeType : undefined),
        data: typeof item.data === 'string' ? item.data : (typeof item.contentBase64 === 'string' ? item.contentBase64 : undefined),
        path: typeof item.path === 'string' ? item.path : undefined
      });
      continue;
    }
    if (type === 'url' && typeof item.url === 'string') parts.push({ type: 'url', url: item.url, title: typeof item.title === 'string' ? item.title : undefined });
    else if (type === 'json') parts.push({ type: 'json', name: typeof item.name === 'string' ? item.name : undefined, value: item.value ?? item });
  }
  return parts;
}

function dshMainInputText(parts: DshSidecarInputPart[]): string {
  return parts.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'selection') return part.text;
    if (part.type === 'url') return part.url;
    if (part.type === 'json') return JSON.stringify(part.value);
    if ('path' in part && part.path) return `[${part.type}: ${part.path}]`;
    if ('name' in part && part.name) return `[${part.type}: ${part.name}]`;
    return `[${part.type}]`;
  }).filter(Boolean).join('\n\n').trim();
}

function dshMainAttachments(parts: DshSidecarInputPart[]): AgentMessageAttachment[] {
  return parts.flatMap((part) => {
    if (part.type !== 'image' && part.type !== 'audio' && part.type !== 'video') return [];
    if (!part.data) return [];
    return [{
      id: createId('att'),
      kind: part.type,
      filename: part.name || `${part.type}.${part.mime.split('/').pop() || 'bin'}`,
      mimeType: part.mime,
      contentBase64: part.data
    }];
  });
}

function dshMainSessionId(external: ExternalConversationMetadata): string {
  const provider = safeExternalSegment(external.provider || 'im');
  const key = [
    external.pluginId,
    external.provider,
    external.botId,
    external.scope,
    external.externalConversationId
  ].filter(Boolean).join('\0') || `${provider}:${new Date().toISOString().slice(0, 10)}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `im_${provider}_${hash}`;
}

function dshMainExternalMetadata(record: Record<string, unknown>): ExternalConversationMetadata {
  const candidates = dshMainObjectCandidates(record);
  const provider = firstDshString(candidates, ['provider', 'channel', 'channelId', 'platform', 'platformId']) || 'dsh-im';
  const botId = firstDshString(candidates, ['botId', 'bot_id', 'agentId', 'agent_id', 'robotId', 'robot_id']);
  const conversationId = firstDshString(candidates, [
    'externalConversationId',
    'conversationId',
    'conversation_id',
    'threadId',
    'thread_id',
    'chatId',
    'chat_id',
    'groupId',
    'group_id',
    'sessionId',
    'session_id',
    'agentId',
    'agent_id'
  ]);
  const senderId = firstDshString(candidates, ['senderId', 'sender_id', 'userId', 'user_id', 'fromUserId', 'from_user_id', 'openid', 'openId']);
  const senderName = firstDshString(candidates, ['senderName', 'sender_name', 'userName', 'user_name', 'nickname', 'name']);
  const displayName = firstDshString(candidates, ['displayName', 'display_name', 'title', 'conversationName', 'groupName']) || senderName;
  return {
    provider,
    pluginId: firstDshString(candidates, ['pluginId', 'plugin_id']) || '@xmanrui/dsh-im',
    botId,
    scope: dshMainScope(candidates),
    externalConversationId: conversationId || senderId || botId || 'default',
    senderId,
    senderName,
    displayName
  };
}

function dshMainObjectCandidates(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || seen.has(item) || depth > 4) return;
    seen.add(item);
    const record = item as Record<string, unknown>;
    out.push(record);
    for (const key of ['raw', 'payload', 'request', 'args', 'message', 'data', 'body', 'event', 'sender', 'conversation']) {
      visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
  return out;
}

function firstDshString(candidates: Array<Record<string, unknown>>, keys: string[]): string | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function dshMainScope(candidates: Array<Record<string, unknown>>): ExternalConversationMetadata['scope'] {
  const explicit = firstDshString(candidates, ['scope', 'chatType', 'conversationType', 'type'])?.toLowerCase();
  if (explicit === 'private' || explicit === 'group' || explicit === 'channel') return explicit;
  if (firstDshString(candidates, ['groupId', 'group_id', 'guildId', 'guild_id', 'channelId', 'channel_id'])) return 'group';
  return 'unknown';
}

function safeExternalSegment(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'im';
}

function externalProviderTitle(provider: string): string {
  const clean = provider.trim();
  const lower = clean.toLowerCase().replace(/^@/, '');
  if (!lower || lower === 'dsh-im' || lower === 'xmanrui/dsh-im' || lower === 'xmanrui-dsh-im') return 'IM';
  if (lower === 'wechat' || lower === 'weixin' || lower === 'wx') return 'WeChat';
  if (lower === 'lark' || lower === 'feishu') return 'Feishu';
  if (lower === 'dingding' || lower === 'dingtalk') return 'DingTalk';
  if (lower === 'qq') return 'QQ';
  return clean
    .split(/[-_\s/]+/g)
    .filter(Boolean)
    .map((part) => /^[a-z0-9]+$/i.test(part) ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part)
    .join(' ') || 'IM';
}

function externalImSessionTitle(external: ExternalConversationMetadata, input: string): string {
  const provider = externalProviderTitle(external.provider);
  const scope = external.scope && external.scope !== 'unknown' ? ` ${external.scope}` : '';
  const name = external.displayName || external.senderName || external.externalConversationId || 'conversation';
  const preview = input.trim().slice(0, 36);
  return `${provider}${scope} / ${name}${preview ? ` - ${preview}` : ''}`.slice(0, 96);
}

function externalImWorkspaceDir(sessionId: string): string {
  const dir = join(context.harnessHome, 'im-artifacts', safeExternalSegment(sessionId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function enqueueExternalImRun<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = externalImSessionQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    await acquireExternalImSlot();
    try {
      return await task();
    } finally {
      releaseExternalImSlot();
    }
  });
  const stored = run.catch(() => undefined);
  externalImSessionQueues.set(sessionId, stored);
  stored.finally(() => {
    if (externalImSessionQueues.get(sessionId) === stored) externalImSessionQueues.delete(sessionId);
  });
  return await run;
}

async function acquireExternalImSlot(): Promise<void> {
  while (activeExternalImRuns >= EXTERNAL_IM_MAX_CONCURRENT_RUNS) {
    await new Promise<void>((resolveWaiter) => {
      externalImSlotWaiters.push(resolveWaiter);
    });
  }
  activeExternalImRuns += 1;
}

function releaseExternalImSlot(): void {
  activeExternalImRuns = Math.max(0, activeExternalImRuns - 1);
  externalImSlotWaiters.shift()?.();
}

function dshMainWorkspaceDir(source?: string): string | undefined {
  const clean = source?.trim();
  if (!clean || !isAbsolute(clean)) return undefined;
  try {
    const target = resolve(clean);
    return existsSync(target) && statSync(target).isDirectory() ? target : undefined;
  } catch {
    return undefined;
  }
}

function logRealtimeEvent(event: string, details?: Record<string, unknown>): void {
  const file = join(context.harnessHome, 'logs', 'realtime.log');
  const record = {
    at: new Date().toISOString(),
    event,
    ...details
  };
  const text = JSON.stringify(record);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text}\n`, 'utf8');
  } catch (logError) {
    console.warn(`[realtime] failed to write log: ${logError instanceof Error ? logError.message : String(logError)}`);
  }
  const important = /error|reject|failed|close|timeout|response/i.test(event);
  const line = `[realtime] ${event} ${details ? JSON.stringify(details) : ''}`.trim();
  if (important) console.warn(line);
  else console.info(line);
}

function isDisposedWebContentsSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Render frame was disposed|WebContents was destroyed|Object has been destroyed/i.test(message);
}

function safeSend(contents: WebContents | undefined | null, channel: string, payload: unknown): boolean {
  if (!contents || contents.isDestroyed()) return false;
  try {
    contents.send(channel, payload);
    return true;
  } catch (error) {
    if (isDisposedWebContentsSendError(error)) return false;
    console.warn(`[ipc] failed to send ${channel}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function broadcastSessionUpdated(event: SessionUpdateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, 'sessions:updated', event);
  }
}

function broadcastAgentToolEvent(payload: AgentToolEventStream): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, 'agent:tool-event', payload);
  }
}

function broadcastLiveTaskUpdate(task: LiveAgentTaskUpdateEvent['task']): void {
  const payload: LiveAgentTaskUpdateEvent = { task };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, 'live-tasks:updated', payload);
  }
}

function broadcastLiveRealtimeEvent(payload: LiveRealtimeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, 'live-realtime:event', payload);
  }
}

const liveRealtimeManager = new RealtimeSessionManager({
  getConfig: () => context.getConfig(),
  onEvent: broadcastLiveRealtimeEvent,
  log: logRealtimeEvent
});
const liveSessionStore = new LiveSessionStore(context.harnessHome);
const liveTaskQueue = new LiveTaskQueue({
  agentLoop: context.agentLoop,
  concurrency: 2,
  defaultExecutionMode: () => context.getConfig().defaultExecutionMode,
  requestToolApproval: (sender, request) => requestInteractiveToolApproval(sender, request),
  onTaskUpdate: broadcastLiveTaskUpdate,
  liveSessionStore
});

function rememberToolApproval(key: string): void {
  const cfg = context.getConfig();
  if (cfg.safetyApproval.neverAskAgainKeys.includes(key)) return;
  context.configStore.update({
    safetyApproval: {
      ...cfg.safetyApproval,
      neverAskAgainKeys: [...cfg.safetyApproval.neverAskAgainKeys, key]
    }
  });
}

function requestInteractiveToolApproval(sender: WebContents, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  if (sender.isDestroyed()) return Promise.resolve({ id: request.id, approved: false });
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingToolApprovals.delete(request.id);
      resolve({ id: request.id, approved: false });
    }, request.timeoutMs);
    pendingToolApprovals.set(request.id, { senderId: sender.id, request, resolve, timeout });
    if (!safeSend(sender, 'tool-approval:request', request)) {
      clearTimeout(timeout);
      pendingToolApprovals.delete(request.id);
      resolve({ id: request.id, approved: false });
    }
  });
}

function requestMainWindowToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
  const target = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.webContents
    : BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())?.webContents;
  if (!target || target.isDestroyed()) return Promise.resolve({ id: request.id, approved: false });
  return requestInteractiveToolApproval(target, request);
}

function resolveToolApproval(senderId: number, decision: ToolApprovalDecision): ToolApprovalDecision {
  const pending = pendingToolApprovals.get(decision.id);
  if (!pending || pending.senderId !== senderId) return { id: decision.id, approved: false };
  clearTimeout(pending.timeout);
  pendingToolApprovals.delete(decision.id);
  const normalized = { id: decision.id, approved: decision.approved === true, neverAskAgain: decision.neverAskAgain === true };
  if (normalized.approved && normalized.neverAskAgain) rememberToolApproval(pending.request.key);
  pending.resolve(normalized);
  return normalized;
}

function denyPendingToolApprovals(): void {
  for (const [id, pending] of pendingToolApprovals) {
    clearTimeout(pending.timeout);
    pending.resolve({ id, approved: false });
  }
  pendingToolApprovals.clear();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function titleBarCssColor(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text;
  if (/^rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(text)) return text;
  if (/^hsla?\(\s*\d+(?:\.\d+)?(?:deg)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(text)) return text;
  return undefined;
}

function resolveTitleBarThemeTokens(config: TitleBarThemeConfig): TitleBarThemeTokens {
  const textColor = titleBarCssColor(config.textColor);
  if (config.theme === 'light' || config.theme === 'tech') {
    return {
      ...BUILTIN_TITLE_BAR_THEME_TOKENS[config.theme],
      textPrimary: textColor || BUILTIN_TITLE_BAR_THEME_TOKENS[config.theme].textPrimary
    };
  }
  if (config.theme.startsWith('custom:')) {
    const themeId = config.theme.slice('custom:'.length);
    const theme = config.customThemes.find((item) => item.id === themeId);
    return {
      bgPrimary: titleBarCssColor(theme?.tokens.bgPrimary) || BUILTIN_TITLE_BAR_THEME_TOKENS.dark.bgPrimary,
      textPrimary: textColor || titleBarCssColor(theme?.tokens.textPrimary) || BUILTIN_TITLE_BAR_THEME_TOKENS.dark.textPrimary
    };
  }
  return {
    ...BUILTIN_TITLE_BAR_THEME_TOKENS.dark,
    textPrimary: textColor || BUILTIN_TITLE_BAR_THEME_TOKENS.dark.textPrimary
  };
}

function mainWindowTitleBarOverlay(config: TitleBarThemeConfig): Electron.TitleBarOverlayOptions {
  const tokens = resolveTitleBarThemeTokens(config);
  return {
    color: TITLE_BAR_TRANSPARENT_COLOR,
    symbolColor: titleBarCssColor(tokens.textPrimary) || BUILTIN_TITLE_BAR_THEME_TOKENS.dark.textPrimary,
    height: 48
  };
}

function titleBarThemeConfigFromPayload(payload: unknown): TitleBarThemeConfig {
  const current = context.getConfig();
  const raw = payload && typeof payload === 'object' ? payload as Partial<TitleBarThemeConfig> : {};
  const theme = raw.theme === 'dark' || raw.theme === 'light' || raw.theme === 'tech' || (typeof raw.theme === 'string' && raw.theme.startsWith('custom:'))
    ? raw.theme
    : current.theme;
  return {
    theme,
    textColor: titleBarCssColor(raw.textColor) || current.textColor,
    customThemes: Array.isArray(raw.customThemes) ? raw.customThemes : current.customThemes
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return /operation was aborted|session stopped by user|aborted/i.test(error.message);
}

function abortReasonText(controller: AbortController): string {
  const reason = controller.signal.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return 'unknown';
}

function abortChatController(controller: AbortController, reason: string): void {
  try {
    controller.abort(reason);
  } catch {
    controller.abort();
  }
}

function chatAbortError(controller: AbortController): Error {
  const reason = abortReasonText(controller);
  if (reason === 'agent:stop') return new Error('Session stopped by user.');
  if (reason === 'app:before-quit') return new Error('Session stopped because the app is quitting.');
  if (reason === 'web-contents-destroyed') return new Error('Session stopped because the chat window was closed or reloaded.');
  return new Error(`Session stopped by harness abort signal (${reason}).`);
}

const LIVE_TASK_INTERIM_PATTERNS = [
  /\b(background\s+task|task)\b.{0,40}\b(queued|submitted|created|started|running)\b/i,
  /\b(queued|submitted|created|started)\b.{0,40}\b(background\s+task|task)\b/i,
  /[\u4efb\u52a1].{0,16}(\u5df2|\u5df2\u7ecf).{0,16}(\u63d0\u4ea4|\u521b\u5efa|\u52a0\u5165|\u6392\u961f|\u5f00\u59cb)/,
  /(\u67e5\u8be2|\u8bf7\u6c42).{0,8}[\u4efb\u52a1].{0,16}(\u5df2|\u5df2\u7ecf)/,
  /(\u8bf7\u7a0d\u7b49|\u7a0d\u7b49|\u7b49\u4e00\u4e0b)/,
  /\u5e2e\u4f60.{0,12}(\u67e5|\u770b|\u5904\u7406|\u641c)/,
  /\b(please wait|one moment|hold on|let me check|i'?ll check|i will check)\b/i
];

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function isLiveTaskInterimAssistantContent(content: unknown): boolean {
  const text = textValue(content).replace(/\s+/g, ' ').trim();
  if (!text || text.length > 220) return false;
  return LIVE_TASK_INTERIM_PATTERNS.some((pattern) => pattern.test(text));
}

function hasRecentLiveTaskForSession(sessionId: string): boolean {
  const now = Date.now();
  const tasks = liveSessionStore.read(sessionId)?.tasks ?? [];
  return tasks.some((task) => {
    if (task.status === 'queued' || task.status === 'running') return true;
    const createdMs = Date.parse(task.createdAt);
    const updatedMs = Date.parse(task.updatedAt);
    return (Number.isFinite(createdMs) && now - createdMs < 20000)
      || (Number.isFinite(updatedMs) && now - updatedMs < 20000);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function escapeHtmlText(input: unknown): string {
  return textValue(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function getHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value?.trim() || undefined;
}

function extForMimeType(mimeType: string, fallback = ''): string {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'text/csv': '.csv',
    'application/xml': '.xml',
    'text/xml': '.xml'
  };
  return map[normalized] ?? fallback;
}

function mimeTypeForFilename(filename: string, fallback = 'application/octet-stream'): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.text': 'text/plain',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.ofd': 'application/octet-stream'
  };
  return map[ext] ?? fallback;
}

function multimediaKindFromMime(mimeType: string): AgentMessageAttachment['kind'] | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function firstStringByKeyDeep(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstStringByKeyDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  for (const [key, raw] of Object.entries(record)) {
    if (!normalizedKeys.includes(key.toLowerCase())) continue;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  for (const nested of Object.values(record)) {
    const found = firstStringByKeyDeep(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function firstNumberByKeyDeep(value: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNumberByKeyDeep(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  for (const [key, raw] of Object.entries(record)) {
    if (!normalizedKeys.includes(key.toLowerCase())) continue;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) return value;
  }
  for (const nested of Object.values(record)) {
    const found = firstNumberByKeyDeep(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function firstHttpUrlDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'string') {
    const match = value.match(/https?:\/\/[^\s"'<>`)\]}]+/i);
    return match?.[0]?.replace(/[),.;!?]+$/, '');
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpUrlDeep(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const prioritized = ['url', 'download_url', 'downloadUrl', 'file_url', 'fileUrl', 'media_url', 'mediaUrl', 'cdn_url', 'cdnUrl'];
  for (const key of prioritized) {
    const found = firstHttpUrlDeep(record[key], depth + 1);
    if (found) return found;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (!/url|href|download|media|file|cdn/i.test(key)) continue;
    const found = firstHttpUrlDeep(nested, depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    const found = firstHttpUrlDeep(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function buildWechatConversationKey(sessionId: string, fromUserId: string, contextToken?: string): string {
  const user = fromUserId.trim();
  const token = contextToken?.trim() ?? '';
  const scope = token || user || 'unknown';
  return `${sessionId}::${scope}`;
}

function clearWechatRunController(conversationKey: string, controller: AbortController): void {
  const active = activeWechatRuns.get(conversationKey);
  if (active !== controller) return;
  activeWechatRuns.delete(conversationKey);
}

function listFilesRecursively(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

function browserCoachRecordingsDir(): string {
  const dir = join(context.harnessHome, 'coach records');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRecordingFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'recording';
}

function normalizeBrowserCoachStartUrl(input: string | undefined): string {
  const trimmed = input?.trim() || 'https://www.baidu.com';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseBrowserCoachRecording(raw: string): BrowserCoachRecording | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserCoachRecording>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) return null;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : '',
      startUrl: typeof parsed.startUrl === 'string' ? parsed.startUrl : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      endedAt: typeof parsed.endedAt === 'string' ? parsed.endedAt : undefined,
      active: Boolean(parsed.active),
      events: parsed.events
    } as BrowserCoachRecording;
  } catch {
    return null;
  }
}

function saveStoppedBrowserCoachRecording(recording: BrowserCoachRecording): string | null {
  if (recording.events.length === 0) return null;
  const stamp = safeRecordingFilePart(recording.startedAt || nowIso());
  const id = safeRecordingFilePart(recording.id || createId('browser_coach'));
  const file = join(browserCoachRecordingsDir(), `${stamp}-${id}.json`);
  writeFileSync(file, `${JSON.stringify({ ...recording, active: false }, null, 2)}\n`, 'utf8');
  return file;
}

function standaloneBrowserCoachRecordingSummary(file: string): BrowserCoachStoredRecording | null {
  const recording = parseBrowserCoachRecording(readFileSync(file, 'utf8'));
  if (!recording) return null;
  const stat = statSync(file);
  const fileId = basename(file, '.json');
  return {
    id: `recording:${fileId}`,
    source: 'recording',
    skillName: fileId,
    displayName: `Recorded trace ${recording.startedAt || fileId}`,
    category: 'browser',
    displayCategory: 'Browser',
    path: file,
    startUrl: recording.startUrl,
    startedAt: recording.startedAt,
    updatedAt: stat.mtime.toISOString(),
    eventCount: recording.events.length
  };
}

function listStandaloneBrowserCoachRecordings(): BrowserCoachStoredRecording[] {
  return readdirSync(browserCoachRecordingsDir())
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => standaloneBrowserCoachRecordingSummary(join(browserCoachRecordingsDir(), name)))
    .filter((item): item is BrowserCoachStoredRecording => Boolean(item));
}

function readStandaloneBrowserCoachRecording(recordingId: string): BrowserCoachRecording | null {
  const fileId = safeRecordingFilePart(recordingId.replace(/^recording:/, ''));
  const file = join(browserCoachRecordingsDir(), `${fileId}.json`);
  if (!existsSync(file)) return null;
  return parseBrowserCoachRecording(readFileSync(file, 'utf8'));
}

function deleteStandaloneBrowserCoachRecording(recordingId: string): boolean {
  const fileId = safeRecordingFilePart(recordingId.replace(/^recording:/, ''));
  const file = join(browserCoachRecordingsDir(), `${fileId}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

async function importKnowledgeBuffer(
  filename: string,
  content: Buffer
): Promise<{ imported: number; skipped: number; failed: Array<{ filePath: string; error: string }> }> {
  const ext = extname(filename).toLowerCase();
  if (ext === '.zip') {
    try {
      const zip = await JSZip.loadAsync(content);
      const entries = Object.keys(zip.files)
        .filter((path) => !zip.files[path]?.dir)
        .sort((left, right) => left.localeCompare(right));
      let imported = 0;
      let skipped = 0;
      const failed: Array<{ filePath: string; error: string }> = [];
      for (const entryPath of entries) {
        const file = zip.file(entryPath);
        if (!file) continue;
        const entryBuffer = await file.async('nodebuffer');
        const nestedName = `${basename(filename, '.zip')}/${entryPath}`.replace(/\\/g, '/');
        const nested = await importKnowledgeBuffer(nestedName, entryBuffer);
        imported += nested.imported;
        skipped += nested.skipped;
        failed.push(...nested.failed);
      }
      return { imported, skipped, failed };
    } catch (error) {
      return {
        imported: 0,
        skipped: 0,
        failed: [{ filePath: filename, error: error instanceof Error ? error.message : String(error) }]
      };
    }
  }
  if (!KNOWLEDGE_IMPORT_EXTENSIONS.has(ext)) return { imported: 0, skipped: 1, failed: [] };
  try {
    await context.personalKnowledgeBase.addDocument({
      filename,
      contentBase64: content.toString('base64')
    });
    return { imported: 1, skipped: 0, failed: [] };
  } catch (error) {
    return {
      imported: 0,
      skipped: 0,
      failed: [{ filePath: filename, error: error instanceof Error ? error.message : String(error) }]
    };
  }
}

function readOptionalUtf8(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function buildBuiltinSkillCreatorGuide(): string {
  const skill = context.skillManager.readBundled('skill-creator') ?? context.skillManager.read('skill-creator');
  if (!skill?.content.trim()) return '';
  const root = dirname(skill.path);
  const references = [
    ['references/workflows.md', join(root, 'references', 'workflows.md')],
    ['references/output-patterns.md', join(root, 'references', 'output-patterns.md')]
  ]
    .map(([label, filePath]) => {
      const content = readOptionalUtf8(filePath);
      return content.trim() ? `# ${label}\n${content.trim()}` : '';
    })
    .filter(Boolean);
  return [
    '# skill-creator/SKILL.md',
    skill.content.trim(),
    ...references
  ].join('\n\n');
}

function buildTaskTrace(result: { iterations: number; execution: { mode: 'workspace' | 'sandbox' }; toolEvents: Array<{ toolName: string; ok: boolean; content?: string; createdAt?: string }> }): string {
  const lines = [
    `Iterations: ${result.iterations}`,
    `Execution mode: ${result.execution.mode}`,
    `Tool events: ${result.toolEvents.length}`
  ];
  for (const event of result.toolEvents) {
    const preview = textValue(event.content).replace(/\s+/g, ' ').slice(0, 140);
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

interface WechatIncomingMedia {
  itemType: number;
  filename: string;
  mimeType: string;
  content: Buffer;
}

interface WechatPreparedPayload {
  text: string;
  attachments: AgentMessageAttachment[];
  uploadedDocuments: string[];
  failures: string[];
}

function extractWechatItemList(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  if (!record) return [];
  const items = Array.isArray(record.item_list) ? record.item_list : [];
  return items.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
}

function extractWechatTextPayload(value: unknown): string {
  const items = extractWechatItemList(value);
  const chunks: string[] = [];
  for (const item of items) {
    const type = getNumberField(item, ['type']);
    if (type === 1) {
      const textItem = asRecord(item.text_item);
      const text = textItem && typeof textItem.text === 'string' ? textItem.text.trim() : '';
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n').trim();
}

function isWechatSessionTitle(title: string): boolean {
  const lower = title.trim().toLowerCase();
  return lower === 'wechat session' || lower.startsWith('wechat clawbot') || lower.startsWith('[wechat:');
}

function filenameFromWechatItem(item: Record<string, unknown>, itemType: number, mimeType: string, url?: string): string {
  const direct = firstStringByKeyDeep(item, [
    'filename',
    'fileName',
    'file_name',
    'name',
    'title',
    'display_name',
    'displayName'
  ]);
  const fromUrl = url
    ? safeDecodeURIComponent(url.split('?')[0]?.split('/').filter(Boolean).at(-1) ?? '')
    : '';
  const fallbackBase = itemType === 2
    ? 'wechat-image'
    : itemType === 3
      ? 'wechat-audio'
      : itemType === 5
        ? 'wechat-video'
        : 'wechat-file';
  const raw = (direct || fromUrl || fallbackBase).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim();
  const ext = extname(raw);
  if (ext) return raw;
  return `${raw}${extForMimeType(mimeType, itemType === 2 ? '.jpg' : itemType === 3 ? '.mp3' : itemType === 5 ? '.mp4' : '.bin')}`;
}

function base64FromWechatItem(item: Record<string, unknown>): string | undefined {
  const raw = firstStringByKeyDeep(item, [
    'contentBase64',
    'content_base64',
    'fileBase64',
    'file_base64',
    'mediaBase64',
    'media_base64',
    'base64'
  ]);
  if (!raw) return undefined;
  const dataUrl = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  return (dataUrl?.[2] ?? raw).replace(/\s+/g, '');
}

function wechatDownloadUrlFromItem(item: Record<string, unknown>): string | undefined {
  const directUrl = firstHttpUrlDeep(item);
  if (directUrl) return directUrl;
  const encryptedParam = firstStringByKeyDeep(item, [
    'encrypted_query_param',
    'encryptedQueryParam',
    'download_param',
    'downloadParam',
    'download_url_param',
    'downloadUrlParam'
  ]);
  if (!encryptedParam) return undefined;
  return `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(encryptedParam)}`;
}

function decodeWechatAesKey(rawKey?: string): Buffer | null {
  const clean = rawKey?.trim();
  if (!clean) return null;
  if (/^[0-9a-f]{32}$/i.test(clean)) return Buffer.from(clean, 'hex');
  try {
    const decoded = Buffer.from(clean, 'base64');
    if (decoded.length === 16) return decoded;
    const decodedText = decoded.toString('utf8').trim();
    if (/^[0-9a-f]{32}$/i.test(decodedText)) return Buffer.from(decodedText, 'hex');
  } catch {
    return null;
  }
  return null;
}

function decryptWechatMedia(content: Buffer, rawKey?: string): Buffer {
  const key = decodeWechatAesKey(rawKey);
  if (!key) return content;
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(content), decipher.final()]);
}

function encryptWechatMedia(content: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(content), cipher.final()]);
}

async function fetchWechatMediaBuffer(url: string, botToken: string, maxBytes: number): Promise<{ content: Buffer; mimeType?: string; filename?: string }> {
  async function attempt(withAuth: boolean): Promise<Response> {
    return fetch(url, {
      method: 'GET',
      headers: withAuth ? buildWechatAuthHeaders(botToken) : undefined
    });
  }
  let response = await attempt(true);
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    response = await attempt(false);
  }
  if (!response.ok) throw new Error(`download HTTP ${response.status}`);
  const length = Number(getHeader(response.headers, 'content-length') ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) throw new Error(`file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  const disposition = getHeader(response.headers, 'content-disposition') ?? '';
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const filename = filenameMatch?.[1] ? safeDecodeURIComponent(filenameMatch[1]) : undefined;
  return {
    content: Buffer.from(arrayBuffer),
    mimeType: getHeader(response.headers, 'content-type')?.split(';')[0]?.trim(),
    filename
  };
}

async function resolveWechatMediaItem(item: Record<string, unknown>, botToken: string): Promise<WechatIncomingMedia | null> {
  const itemType = getNumberField(item, ['type']) ?? 0;
  if (![2, 3, 4, 5].includes(itemType)) return null;
  const url = wechatDownloadUrlFromItem(item);
  const aesKey = firstStringByKeyDeep(item, ['aeskey', 'aes_key', 'aesKey']);
  const mimeFromPayload = firstStringByKeyDeep(item, ['mimeType', 'mime_type', 'contentType', 'content_type', 'mediaType', 'media_type']) ?? '';
  const base64 = base64FromWechatItem(item);
  const sizeHint = firstNumberByKeyDeep(item, ['sizeBytes', 'size_bytes', 'fileSize', 'file_size', 'size']);
  const fallbackMime = itemType === 2 ? 'image/jpeg' : itemType === 3 ? 'audio/mpeg' : itemType === 5 ? 'video/mp4' : 'application/octet-stream';
  const initialMime = mimeFromPayload || fallbackMime;
  const initialFilename = filenameFromWechatItem(item, itemType, initialMime, url);
  const maxBytes = itemType === 4 ? MAX_WECHAT_DOCUMENT_BYTES : MAX_WECHAT_MULTIMEDIA_ATTACHMENT_BYTES;
  if (sizeHint && sizeHint > maxBytes) throw new Error(`${initialFilename}: file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  if (base64) {
    const content = decryptWechatMedia(Buffer.from(base64, 'base64'), aesKey);
    if (content.length > maxBytes) throw new Error(`${initialFilename}: file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    return {
      itemType,
      filename: initialFilename,
      mimeType: mimeFromPayload || mimeTypeForFilename(initialFilename, fallbackMime),
      content
    };
  }
  if (!url) return null;
  const downloaded = await fetchWechatMediaBuffer(url, botToken, maxBytes);
  const content = decryptWechatMedia(downloaded.content, aesKey);
  if (content.length > maxBytes) throw new Error(`${initialFilename}: file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  const mimeType = downloaded.mimeType || mimeFromPayload || mimeTypeForFilename(downloaded.filename || initialFilename, fallbackMime);
  return {
    itemType,
    filename: downloaded.filename || filenameFromWechatItem(item, itemType, mimeType, url),
    mimeType,
    content
  };
}

async function prepareWechatIncomingPayload(msg: Record<string, unknown>, sessionId: string, botToken: string): Promise<WechatPreparedPayload> {
  const items = extractWechatItemList(msg);
  const textChunks = [extractWechatTextPayload(msg)].filter(Boolean);
  const attachments: AgentMessageAttachment[] = [];
  const uploadedDocuments: string[] = [];
  const failures: string[] = [];

  for (const item of items) {
    const itemType = getNumberField(item, ['type']) ?? 0;
    if (![2, 3, 4, 5].includes(itemType)) continue;
    try {
      const media = await resolveWechatMediaItem(item, botToken);
      if (!media) {
        textChunks.push(itemType === 2 ? '[image]' : itemType === 3 ? '[audio]' : itemType === 5 ? '[video]' : '[file]');
        continue;
      }
      const ext = extname(media.filename).toLowerCase();
      const mediaKind = multimediaKindFromMime(media.mimeType);
      if (itemType === 4 && WECHAT_DOCUMENT_EXTENSIONS.has(ext)) {
        await context.sessionDocumentContextStore.addDocument({
          sessionId,
          filename: media.filename,
          contentBase64: media.content.toString('base64'),
          workspaceDir: context.getConfig().workspaceDir
        });
        uploadedDocuments.push(media.filename);
        textChunks.push(`[document: ${media.filename}]`);
        continue;
      }
      if (mediaKind) {
        if (media.content.length > MAX_WECHAT_MULTIMEDIA_ATTACHMENT_BYTES) {
          throw new Error(`${media.filename}: file is larger than ${Math.round(MAX_WECHAT_MULTIMEDIA_ATTACHMENT_BYTES / (1024 * 1024))} MB`);
        }
        attachments.push({
          id: createId('wx_media'),
          kind: mediaKind,
          filename: media.filename,
          mimeType: media.mimeType,
          contentBase64: media.content.toString('base64'),
          sizeBytes: media.content.length
        });
        textChunks.push(`[${mediaKind}: ${media.filename}]`);
        continue;
      }
      failures.push(`${media.filename}: unsupported WeChat file type`);
      textChunks.push(`[file: ${media.filename}]`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      textChunks.push(`[WeChat attachment failed: ${message}]`);
    }
  }

  return {
    text: textChunks.join('\n').trim(),
    attachments,
    uploadedDocuments,
    failures
  };
}

function ensureWechatSessionId(): string {
  const current = context.getConfig().wechatChannel;
  const configured = current.sessionId?.trim();
  if (configured && context.sessionStore.read(configured)) return configured;
  let existingId = '';
  try {
    existingId = context.sessionStore.list().find((session) => isWechatSessionTitle(session.title))?.id ?? '';
  } catch {
    existingId = '';
  }
  if (existingId) {
    context.configStore.update({
      wechatChannel: {
        ...current,
        sessionId: existingId
      }
    });
    return existingId;
  }
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

async function postWechatJson<T = Record<string, unknown>>(baseUrl: string, botToken: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: buildWechatAuthHeaders(botToken),
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  const parsed = await response.json() as unknown;
  const record = asRecord(parsed);
  if (!record) throw new Error(`Invalid ${path} response.`);
  const errcode = getNumberField(record, ['errcode']);
  if (typeof errcode === 'number' && errcode !== 0) {
    throw new Error(typeof record.errmsg === 'string' ? record.errmsg : `errcode=${errcode}`);
  }
  const ret = getNumberField(record, ['ret']);
  if (typeof ret === 'number' && ret !== 0) {
    throw new Error(typeof record.errmsg === 'string' ? record.errmsg : `ret=${ret}`);
  }
  return record as T;
}

async function uploadWechatMediaFile(baseUrl: string, botToken: string, toUserId: string, filePath: string, mediaType: 1 | 2 | 3): Promise<{
  aeskeyHex: string;
  downloadEncryptedQueryParam: string;
  fileSize: number;
  fileSizeCiphertext: number;
}> {
  const plaintext = readFileSync(filePath);
  const aeskey = randomBytes(16);
  const ciphertext = encryptWechatMedia(plaintext, aeskey);
  const filekey = randomBytes(16).toString('hex');
  const uploadUrlResp = await postWechatJson<Record<string, unknown>>(baseUrl, botToken, '/ilink/bot/getuploadurl', {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
    base_info: { channel_version: '1.0.0' }
  });
  const uploadParam = typeof uploadUrlResp.upload_param === 'string' ? uploadUrlResp.upload_param : '';
  if (!uploadParam) throw new Error(`getuploadurl returned no upload_param: ${JSON.stringify(uploadUrlResp)}`);
  const uploadUrl = `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext)
  });
  if (response.status !== 200) {
    const message = response.headers.get('x-error-message') ?? await response.text();
    throw new Error(`CDN upload failed ${response.status}: ${message}`);
  }
  const downloadEncryptedQueryParam = response.headers.get('x-encrypted-param') ?? '';
  if (!downloadEncryptedQueryParam) throw new Error('CDN upload response missing x-encrypted-param header.');
  return {
    aeskeyHex: aeskey.toString('hex'),
    downloadEncryptedQueryParam,
    fileSize: plaintext.length,
    fileSizeCiphertext: ciphertext.length
  };
}

async function sendWechatFile(baseUrl: string, botToken: string, payload: {
  toUserId: string;
  contextToken: string;
  filePath: string;
  caption?: string;
  fromUserId?: string;
}): Promise<void> {
  const filename = basename(payload.filePath);
  const mimeType = mimeTypeForFilename(filename);
  const mediaType: 1 | 2 | 3 = mimeType.startsWith('image/') ? 1 : mimeType.startsWith('video/') ? 2 : 3;
  const uploaded = await uploadWechatMediaFile(baseUrl, botToken, payload.toUserId, payload.filePath, mediaType);
  if (payload.caption?.trim()) {
    await sendWechatText(baseUrl, botToken, {
      toUserId: payload.toUserId,
      contextToken: payload.contextToken,
      text: payload.caption.trim(),
      fromUserId: payload.fromUserId
    });
  }
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'),
    encrypt_type: 1
  };
  const item = mediaType === 1
    ? { type: 2, image_item: { media, mid_size: uploaded.fileSizeCiphertext } }
    : mediaType === 2
      ? { type: 5, video_item: { media, video_size: uploaded.fileSizeCiphertext } }
      : { type: 4, file_item: { media, file_name: filename, len: String(uploaded.fileSize) } };
  await postWechatJson(baseUrl, botToken, '/ilink/bot/sendmessage', {
    msg: {
      from_user_id: payload.fromUserId ?? '',
      to_user_id: payload.toUserId,
      client_id: `tasi-${createId('wxfile')}`,
      message_type: 2,
      message_state: 2,
      context_token: payload.contextToken,
      item_list: [item]
    },
    base_info: { channel_version: '1.0.0' }
  });
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
          context.configStore.update({
            wechatChannel: {
              ...context.getConfig().wechatChannel,
              lastInboundUserId: fromUser,
              lastContextToken: contextToken || context.getConfig().wechatChannel.lastContextToken
            }
          });
          const rawMessageId = getStringField(msg, ['message_id']) ?? String(getNumberField(msg, ['message_id']) ?? '');
          if (rawMessageId && markWechatMessageSeen(rawMessageId)) continue;
          const incoming = await prepareWechatIncomingPayload(msg, sessionId, token);
          if (!incoming.text && incoming.attachments.length === 0 && incoming.uploadedDocuments.length === 0) continue;
          const text = incoming.text || '[WeChat attachment]';
          const hasMediaItems = extractWechatItemList(msg).some((item) => [2, 3, 4, 5].includes(getNumberField(item, ['type']) ?? 0));
          const ts = getNumberField(msg, ['create_time_ms']);
          const createdAt = typeof ts === 'number' ? new Date(ts).toISOString() : new Date().toISOString();
          if (hasMediaItems) {
            const shadowUserId = createId('wx_shadow_user');
            const updatedInbound = context.sessionStore.appendMessages(sessionId, [
              {
                id: shadowUserId,
                role: 'user',
                content: `[WeChat:${fromUser}] ${text}`,
                attachments: incoming.attachments.length > 0 ? incoming.attachments : undefined,
                createdAt
              }
            ], []);
            broadcastSessionUpdated({
              sessionId: updatedInbound.id,
              source: 'external',
              updatedAt: updatedInbound.updatedAt
            });
            continue;
          }
          const pendingAssistantId = createId('wx_pending');
          const conversationKey = buildWechatConversationKey(sessionId, fromUser, contextToken);
          const previousController = activeWechatRuns.get(conversationKey);
          if (previousController) {
            previousController.abort();
            activeWechatRuns.delete(conversationKey);
          }
          const updatedInbound = context.sessionStore.appendMessages(sessionId, [
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

          const runController = new AbortController();
          activeWechatRuns.set(conversationKey, runController);
          try {
            const runResult = await context.agentLoop.run({
              userInput: text,
              sessionId,
              executionMode: context.getConfig().defaultExecutionMode,
              origin: 'scheduled',
              attachments: incoming.attachments,
              signal: runController.signal,
              requestToolApproval: (request) => requestMainWindowToolApproval(request),
              onToolEvent: (eventSessionId, toolEvent) => {
                const payload: AgentToolEventStream = { sessionId: eventSessionId, event: toolEvent };
                broadcastAgentToolEvent(payload);
                const previewUrl = latestWebPreviewUrlFromSource(toolEvent.toolName, toolEvent.args, toolEvent.content, true);
                if (!previewUrl) return;
                void maybeOpenExternalBrowser(previewUrl).catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  console.warn(`[wechat] failed to open external browser preview: ${message}`);
                });
              },
              onSessionUpdated: (record) => {
                broadcastSessionUpdated({
                  sessionId: record.id,
                  source: 'external',
                  updatedAt: record.updatedAt
                });
              }
            });
            const postRunRecord = context.sessionStore.read(sessionId);
            if (postRunRecord) {
              const cleaned = postRunRecord.messages.filter((item) => item.id !== pendingAssistantId);
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
            if (runController.signal.aborted || isAbortLikeError(error)) {
              const fallbackRecord = context.sessionStore.read(sessionId);
              if (fallbackRecord) {
                const cleaned = fallbackRecord.messages.filter((item) => item.id !== pendingAssistantId);
                context.sessionStore.replaceMessages(sessionId, cleaned);
                broadcastSessionUpdated({
                  sessionId,
                  source: 'external',
                  updatedAt: new Date().toISOString()
                });
              }
              continue;
            }
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
          } finally {
            clearWechatRunController(conversationKey, runController);
            if (context.getConfig().browserMode === 'external' && activeChatControllers.size === 0) {
              await closeExternalBrowserPreview();
            }
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

function getDevToolsWindowMetrics(parent: ElectronBrowserWindow): { bounds: Rectangle; minWidth: number; minHeight: number } {
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

function ensureDevToolsWindow(parent: ElectronBrowserWindow): ElectronBrowserWindow {
  const layout = getDevToolsWindowMetrics(parent);
  const cfg = context.getConfig();
  const appIconPath = resolveBrandWindowIconPath(cfg.branding.logoPath);

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
    title: `${cfg.branding.productName} DevTools`
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

function openMainWindowDevTools(win: ElectronBrowserWindow): void {
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
  win.webContents.openDevTools({ mode: 'detach', title: `${context.getConfig().branding.productName} DevTools` });
}

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function copyTextToSystemClipboard(text: string): void {
  if (!text) return;
  clipboard.writeText(text);
}

function appendContextSeparator(template: MenuItemConstructorOptions[]): void {
  const last = template[template.length - 1];
  if (!last || last.type === 'separator') return;
  template.push({ type: 'separator' });
}

function trimContextSeparators(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  while (template[0]?.type === 'separator') template.shift();
  while (template[template.length - 1]?.type === 'separator') template.pop();
  return template;
}

function buildNativeContextMenuTemplate(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags;
  const selectionText = params.selectionText?.trim() ?? '';
  const linkUrl = params.linkURL?.trim() ?? '';
  const srcUrl = params.srcURL?.trim() ?? '';
  const selectedUrl = selectionText ? findFirstHttpUrl(selectionText) ?? '' : '';

  if (linkUrl) {
    if (isExternalUrl(linkUrl)) {
      template.push({
        label: '打开链接',
        click: () => void shell.openExternal(linkUrl)
      });
    }
    template.push({
      label: '复制链接地址',
      click: () => copyTextToSystemClipboard(linkUrl)
    });
    appendContextSeparator(template);
  } else if (selectedUrl && isExternalUrl(selectedUrl)) {
    template.push({
      label: '打开选中链接',
      click: () => void shell.openExternal(selectedUrl)
    });
    template.push({
      label: '复制选中链接',
      click: () => copyTextToSystemClipboard(selectedUrl)
    });
    appendContextSeparator(template);
  }

  if (srcUrl && (params.mediaType === 'image' || params.mediaType === 'video' || params.mediaType === 'audio')) {
    if (params.mediaType === 'image') {
      template.push({
        label: '复制图片',
        click: () => contents.copyImageAt(params.x, params.y)
      });
    }
    template.push({
      label: params.mediaType === 'image' ? '复制图片地址' : '复制媒体地址',
      click: () => copyTextToSystemClipboard(srcUrl)
    });
    if (isExternalUrl(srcUrl) || srcUrl.startsWith('data:')) {
      template.push({
        label: params.mediaType === 'image' ? '图片另存为...' : '媒体另存为...',
        click: () => contents.downloadURL(srcUrl)
      });
    }
    appendContextSeparator(template);
  }

  if (params.isEditable) {
    template.push(
      { label: '撤销', role: 'undo', enabled: flags.canUndo },
      { label: '重做', role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: flags.canCut },
      { label: '复制', role: 'copy', enabled: flags.canCopy },
      { label: '粘贴', role: 'paste', enabled: flags.canPaste },
      { label: '删除', role: 'delete', enabled: flags.canDelete },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', enabled: flags.canSelectAll }
    );
  } else {
    if (selectionText) {
      template.push({
        label: '复制',
        role: 'copy',
        enabled: flags.canCopy
      });
      appendContextSeparator(template);
    }
    template.push({
      label: '全选',
      role: 'selectAll',
      enabled: flags.canSelectAll
    });
  }

  return trimContextSeparators(template).filter((item, index, list) => !(item.type === 'separator' && list[index - 1]?.type === 'separator'));
}

function registerNativeContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    if (contents.isDestroyed()) return;
    const template = buildNativeContextMenuTemplate(contents, params);
    if (template.length === 0) return;
    const win = BrowserWindow.fromWebContents(contents) ?? mainWindow ?? undefined;
    Menu.buildFromTemplate(template).popup(win ? { window: win } : undefined);
  });
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

function clearEmbeddedPreviewWebContentsBinding(): void {
  embeddedPreviewWebContentsId = null;
  embeddedPreviewResetCleanup?.();
  embeddedPreviewResetCleanup = null;
}

function bindEmbeddedPreviewWebContents(target: WebContents): void {
  clearEmbeddedPreviewWebContentsBinding();
  embeddedPreviewWebContentsId = target.id;
  const reset = () => resetEmbeddedPreviewWebContentsState(target);
  reset();
  target.on('dom-ready', reset);
  target.on('did-navigate', reset);
  target.on('did-navigate-in-page', reset);
  target.on('did-stop-loading', reset);
  target.once('destroyed', clearEmbeddedPreviewWebContentsBinding);
  embeddedPreviewResetCleanup = () => {
    target.off('dom-ready', reset);
    target.off('did-navigate', reset);
    target.off('did-navigate-in-page', reset);
    target.off('did-stop-loading', reset);
    target.off('destroyed', clearEmbeddedPreviewWebContentsBinding);
  };
}

function resolveEmbeddedPreviewWebContents(): WebContents | null {
  if (!embeddedPreviewWebContentsId) return null;
  const target = webContents.fromId(embeddedPreviewWebContentsId);
  if (!target || target.isDestroyed()) return null;
  if (!isAllowedEmbeddedPreviewPartition(sessionPartition(target))) return null;
  return target;
}

function isAllowedEmbeddedPreviewPartition(partition: string): boolean {
  return partition === EMBEDDED_BROWSER_PARTITION || partition === EMBEDDED_BROWSER_PREVIEW_PARTITION;
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
  if (toolName.startsWith('browser_')) return false;
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

function eventArgsObject(event: ToolEvent): Record<string, unknown> {
  return typeof event.args === 'object' && event.args !== null && !Array.isArray(event.args)
    ? event.args as Record<string, unknown>
    : {};
}

function browserPolicyFromToolEvents(events: ToolEvent[]): 'auto_close' | 'keep_open' | undefined {
  for (const event of [...events].reverse()) {
    if (event.toolName !== 'browser_close_policy' || !event.ok) continue;
    const policy = eventArgsObject(event).policy;
    return policy === 'keep_open' ? 'keep_open' : 'auto_close';
  }
  return undefined;
}

function isBrowserFormMutationEvent(event: ToolEvent): boolean {
  if (!event.ok) return false;
  if (['browser_type', 'browser_select', 'browser_check'].includes(event.toolName)) return true;
  if (event.toolName === 'browser_find') {
    const action = String(eventArgsObject(event).action ?? '').toLowerCase();
    if (['type', 'fill', 'select', 'check', 'uncheck'].includes(action)) return true;
  }
  if (event.toolName === 'browser_click' || event.toolName === 'browser_find') {
    const combined = previewSourceText(event.toolName, event.args, event.content);
    return /\b(submit|sign in|login|log in|confirm|continue|authorize|approve|save|apply|send|next)\b/i.test(combined);
  }
  return false;
}

function isBrowserManualUserWaitEvent(event: ToolEvent): boolean {
  if (!event.ok || event.toolName !== 'browser_wait') return false;
  const args = eventArgsObject(event);
  if (args.wait_for_user === true || args.until_logged_in === true) return true;
  return /waiting for user input|credentials|captcha|mfa/i.test(event.content);
}

function isBrowserCredentialPromptEvent(event: ToolEvent): boolean {
  if (!event.ok || !isWebPreviewEvent(event)) return false;
  const combined = previewSourceText(event.toolName, event.args, event.content);
  const hasCredentialInput = /\b(password|passwd|pwd|captcha|mfa|otp)\b|input\[type=["']?password|#?i_pass\b|#?i_code\b/i.test(combined);
  const hasLoginContext = /\b(login|log in|sign in|signin|auth|sso|cas|oauth|account|username|user)\b|id\.tsinghua|#?i_user\b/i.test(combined);
  return hasCredentialInput && hasLoginContext;
}

function isBrowserDataExtractionEvent(event: ToolEvent): boolean {
  return event.ok && ['browser_extract', 'browser_pdf', 'browser_screenshot'].includes(event.toolName);
}

function inferKeepBrowserOpenFromEvents(events: ToolEvent[]): boolean {
  let lastMutationIndex = -1;
  let lastCredentialPromptIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (isBrowserFormMutationEvent(events[index])) lastMutationIndex = index;
    if (isBrowserManualUserWaitEvent(events[index]) || isBrowserCredentialPromptEvent(events[index])) {
      lastCredentialPromptIndex = index;
    }
  }
  if (lastCredentialPromptIndex >= 0) return true;
  if (lastMutationIndex < 0) return false;
  const extractedAfterMutation = events.slice(lastMutationIndex + 1).some(isBrowserDataExtractionEvent);
  return !extractedAfterMutation;
}

function shouldKeepExternalBrowserOpen(sessionId: string | undefined, events: ToolEvent[]): boolean {
  const explicit = browserPolicyFromToolEvents(events);
  const stored = sessionId ? context.consumeBrowserClosePolicy(sessionId) : undefined;
  if (explicit) return explicit === 'keep_open';
  if (stored) return stored.policy === 'keep_open';
  return inferKeepBrowserOpenFromEvents(events);
}

async function closeExternalBrowserPreviewAfterRun(sessionId: string | undefined, events: ToolEvent[]): Promise<ToolExecutionResult> {
  if (shouldKeepExternalBrowserOpen(sessionId, events)) {
    lastExternalBrowserOpen = null;
    return { ok: true, content: 'External browser kept open for form/submission workflow.' };
  }
  return closeExternalBrowserPreview();
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
  const managed = await context.externalBrowserBridge.open(url, config);
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
  const managedResult = await context.externalBrowserBridge.close();
  const fallbackCount = externalFallbackUrls.size;
  externalFallbackUrls.clear();
  lastExternalBrowserOpen = null;
  if (fallbackCount <= 0) return managedResult;
  return {
    ok: managedResult.ok,
    content: `${managedResult.content} ${fallbackCount} fallback URL(s) were opened via shell.openExternal and cannot be auto-closed.`
  };
}

async function renderHtmlToPdfBuffer(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: {
        marginType: 'custom',
        top: 0.35,
        bottom: 0.35,
        left: 0.35,
        right: 0.35
      }
    });
    return Buffer.from(data);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function isLockedExportWriteError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function nextExportFallbackPath(filePath: string, index: number): string {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  return join(dirname(filePath), `${base} (${index})${ext}`);
}

function writeExportFileWithFallback(filePath: string, data: Buffer): { filePath: string; fallback: boolean } {
  try {
    writeFileSync(filePath, data);
    return { filePath, fallback: false };
  } catch (error) {
    if (!isLockedExportWriteError(error)) throw error;
    for (let index = 1; index <= 99; index += 1) {
      const candidate = nextExportFallbackPath(filePath, index);
      if (existsSync(candidate)) continue;
      writeFileSync(candidate, data);
      return { filePath: candidate, fallback: true };
    }
    throw error;
  }
}

async function exportAssistantMessage(req: AssistantMessageExportRequest): Promise<ToolExecutionResult> {
  const format = req.format;
  if (format !== 'pdf' && format !== 'docx') {
    return { ok: false, content: `Unsupported export format: ${String(format)}` };
  }
  const content = req.content?.trim() ?? '';
  if (!content) return { ok: false, content: 'Nothing to export.' };

  const title = req.title?.trim() || 'Assistant Reply';
  const ext = format === 'pdf' ? 'pdf' : 'docx';
  const filters = format === 'pdf'
    ? [{ name: 'PDF Document', extensions: ['pdf'] }]
    : [{ name: 'Word Document', extensions: ['docx'] }];
  const saveOptions = {
    title: `Export assistant reply as ${ext.toUpperCase()}`,
    defaultPath: `${safeExportBasename(title)}.${ext}`,
    filters
  };
  const picked = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (picked.canceled || !picked.filePath) {
    return { ok: true, content: 'Export canceled.' };
  }

  let saved: { filePath: string; fallback: boolean };
  if (format === 'pdf') {
    const html = buildAssistantMessageExportHtml(title, req.html?.trim() || `<pre>${escapeHtmlText(content)}</pre>`);
    saved = writeExportFileWithFallback(picked.filePath, await renderHtmlToPdfBuffer(html));
  } else {
    saved = writeExportFileWithFallback(picked.filePath, await buildAssistantMessageDocx(title, content, req.html));
  }
  return {
    ok: true,
    content: saved.fallback
      ? `Exported ${saved.filePath} (original file was busy or locked)`
      : `Exported ${saved.filePath}`
  };
}

async function createWindow(): Promise<void> {
  const cfg = context.getConfig();
  const appIconPath = resolveBrandWindowIconPath(cfg.branding.logoPath);
  const titleBarOverlay = mainWindowTitleBarOverlay(cfg);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: cfg.branding.productName,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay
        }
      : {}),
    autoHideMenuBar: true,
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
  mainWindow.setMenu(null);
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
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

function pluginClientWindowKey(mount: DshSidecarClientMount): string {
  return `${mount.pluginId}:${mount.id}:${mount.mountPoint}`;
}

function shouldOpenPluginClientWindow(req: DshSidecarClientMountOpenRequest, mount: DshSidecarClientMount): boolean {
  return req.mode === 'window'
    || req.mode === 'desktop-companion'
    || mount.mountPoint === 'desktop-companion'
    || mount.mountPoint === 'floating';
}

function openPluginClientWindow(mount: DshSidecarClientMount): void {
  const key = pluginClientWindowKey(mount);
  const existing = pluginClientWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const display = screen.getPrimaryDisplay().workArea;
  const isCompanion = mount.mountPoint === 'desktop-companion' || mount.mountPoint === 'floating';
  const isSettings = mount.mountPoint === 'settings';
  const width = isCompanion ? 360 : isSettings ? 1120 : 960;
  const height = isCompanion ? 460 : isSettings ? 760 : 720;
  const appIconPath = resolveBrandWindowIconPath(context.getConfig().branding.logoPath);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: isCompanion ? 220 : isSettings ? 900 : 520,
    minHeight: isCompanion ? 220 : isSettings ? 620 : 360,
    x: isCompanion ? Math.max(display.x, display.x + display.width - width - 32) : undefined,
    y: isCompanion ? Math.max(display.y, display.y + display.height - height - 48) : undefined,
    title: mount.title,
    ...(appIconPath ? { icon: appIconPath } : {}),
    frame: !isCompanion,
    transparent: isCompanion,
    alwaysOnTop: isCompanion,
    skipTaskbar: isCompanion,
    resizable: true,
    backgroundColor: isCompanion ? TITLE_BAR_TRANSPARENT_COLOR : '#111418',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });
  pluginClientWindows.set(key, win);
  if (isCompanion) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        win.close();
      }
    });
  }
  win.on('closed', () => {
    if (pluginClientWindows.get(key) === win) pluginClientWindows.delete(key);
  });
  void win.loadURL(mount.url);
}

async function openDshClientMount(req: DshSidecarClientMountOpenRequest): Promise<DshSidecarClientMount> {
  const mounts = await context.dshSidecarManager.listClientMounts();
  const cleanId = req.id.trim();
  const mount = mounts.find((item) => item.id === cleanId && (!req.pluginId || item.pluginId === req.pluginId))
    ?? mounts.find((item) => item.id === cleanId || item.pluginId === req.pluginId);
  if (!mount) throw new Error(`Unknown DSH client mount: ${req.pluginId ? `${req.pluginId}/` : ''}${req.id}`);
  if (shouldOpenPluginClientWindow(req, mount)) openPluginClientWindow(mount);
  return mount;
}

function applyMainWindowBranding(): void {
  const cfg = context.getConfig();
  app.setName(cfg.branding.productName);
  applyBrandDockIcon(cfg.branding.logoPath);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(cfg.branding.productName);
  applyMainWindowTitleBarOverlay(cfg);
  const appIconPath = resolveBrandWindowIconPath(cfg.branding.logoPath);
  if (!appIconPath) return;
  try {
    mainWindow.setIcon(appIconPath);
  } catch {
    // Some platforms ignore runtime icon updates.
  }
}

function applyMainWindowTitleBarOverlay(config: TitleBarThemeConfig = context.getConfig()): void {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay(mainWindowTitleBarOverlay(config));
}

function registerWechatTools(): void {
  if (context.toolRegistry.has('wechat_send_file')) return;
  const tool: RegisteredTool = {
    safety: 'network',
    definition: {
      type: 'function',
      function: {
        name: 'wechat_send_file',
        description: 'Send a file from the workspace back to the active WeChat conversation. Use only when the WeChat user explicitly asks to receive, download, or send a specific file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path to the file to send.' },
            caption: { type: 'string', description: 'Optional short caption to send before the file.' }
          },
          required: ['path']
        }
      }
    },
    async execute(args, contextArg) {
      const cfg = context.getConfig();
      const wechatSessionId = cfg.wechatChannel.sessionId?.trim();
      if (!wechatSessionId || contextArg.sessionId !== wechatSessionId) {
        return { ok: false, content: 'wechat_send_file is only available inside the configured WeChat session.' };
      }
      const token = cfg.wechatChannel.botToken?.trim();
      const toUserId = cfg.wechatChannel.lastInboundUserId?.trim();
      const contextToken = cfg.wechatChannel.lastContextToken?.trim();
      if (!cfg.wechatChannel.enabled || !token || !toUserId || !contextToken) {
        return { ok: false, content: 'WeChat channel is not ready. It needs an enabled channel, bot token, latest user id, and context token.' };
      }
      const obj = objectArgs(args);
      const target = resolveToolPath(contextArg.workspaceDir, stringArg(obj, 'path'));
      const workspaceRoot = resolve(contextArg.workspaceDir);
      if (!isPathInside(workspaceRoot, target)) return { ok: false, content: 'Only workspace files can be sent to WeChat.' };
      if (!existsSync(target)) return { ok: false, content: 'File not found.' };
      if (!statSync(target).isFile()) return { ok: false, content: 'Path is not a file.' };
      const baseUrl = (cfg.wechatChannel.baseUrl?.trim() || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
      await sendWechatFile(baseUrl, token, {
        toUserId,
        contextToken,
        filePath: target,
        caption: stringArg(obj, 'caption', ''),
        fromUserId: cfg.wechatChannel.botId?.trim() || undefined
      });
      return {
        ok: true,
        content: `Sent ${relative(workspaceRoot, target)} to WeChat.`
      };
    }
  };
  context.toolRegistry.register(tool);
}

function realtimeWebSocketUrl(baseUrl: string, model: string): URL {
  const raw = (baseUrl.trim() || 'wss://api.openai.com/v1/realtime').replace(/\/+$/, '');
  const url = new URL(raw);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'wss:') throw new Error('Realtime WebSocket URL must start with wss://.');
  if (!url.searchParams.has('model')) url.searchParams.set('model', model.trim());
  return url;
}

function qwenWorkspaceIdFromRealtimeUrl(url: URL): string {
  const explicit = url.searchParams.get('workspaceId') || url.searchParams.get('workspace_id') || '';
  if (explicit.trim()) return explicit.trim();
  const match = /^([^.]+)\.cn-beijing\.maas\.aliyuncs\.com$/i.exec(url.hostname);
  return match?.[1] || '';
}

function realtimeConnectionPath(config: AppConfig, url: URL): string {
  if (config.omniProvider !== 'qwen-bailian') return `${url.pathname}${url.search}`;
  const next = new URL(url.toString());
  next.searchParams.delete('workspaceId');
  next.searchParams.delete('workspace_id');
  return `${next.pathname}${next.search}`;
}

function usesOpenAIRealtimeProtocol(config: AppConfig): boolean {
  return config.omniProvider === 'openai' || config.omniProvider === 'soildapi';
}

async function testRealtimeConnection(config: AppConfig): Promise<{ ok: boolean; content: string }> {
  if (!usesOpenAIRealtimeProtocol(config) && config.omniProvider !== 'qwen-bailian') {
    return { ok: false, content: 'Only OpenAI-compatible Realtime and Qwen Realtime WebSocket providers are supported for Omni.' };
  }
  if (!config.omniApiKey) return { ok: false, content: 'API key is empty.' };
  if (!config.omniBaseUrl) return { ok: false, content: 'Realtime WebSocket URL is empty.' };
  if (!config.omniModel) return { ok: false, content: 'Realtime model is empty.' };
  if (config.omniBaseUrl.includes('{WorkspaceId}')) {
    return { ok: false, content: 'Replace {WorkspaceId} with your Bailian workspace ID before testing Qwen Realtime.' };
  }

  let url: URL;
  try {
    url = realtimeWebSocketUrl(config.omniBaseUrl, config.omniModel);
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }

  const qwenWorkspaceId = config.omniProvider === 'qwen-bailian' ? qwenWorkspaceIdFromRealtimeUrl(url) : '';
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; content: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: realtimeConnectionPath(config, url),
      method: 'GET',
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${config.omniApiKey}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'tasi-harness-realtime/1.0',
        ...(qwenWorkspaceId ? { 'X-DashScope-WorkSpace': qwenWorkspaceId } : {}),
        ...(usesOpenAIRealtimeProtocol(config) ? { 'OpenAI-Beta': 'realtime=v1' } : {})
      }
    });

    req.on('upgrade', (res, socket) => {
      socket.destroy();
      settle({ ok: true, content: `Realtime WebSocket connected (${res.statusCode ?? 101}).` });
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        if (chunks.reduce((sum, item) => sum + item.length, 0) < 4096) chunks.push(Buffer.from(chunk));
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').trim();
        settle({ ok: false, content: `${res.statusCode ?? 'HTTP'} ${res.statusMessage ?? ''}${body ? `: ${body}` : ''}`.trim() });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Realtime WebSocket connection timed out.'));
    });
    req.on('error', (error) => {
      settle({ ok: false, content: error.message });
    });
    req.end();
  });
}

function registerIpc(): void {
  ipcMain.on('browser-coach:event', (event, payload) => browserCoachRecorder.acceptEvent(event, payload));
  ipcMain.handle('config:get', () => context.configStore.publicConfig(false));
  ipcMain.handle('config:set', async (_event, partial: Partial<AppConfig>) => {
    const sanitized = { ...partial };
    if (typeof sanitized.apiKey !== 'string') delete sanitized.apiKey;
    if (typeof sanitized.omniApiKey !== 'string') delete sanitized.omniApiKey;
    const next = context.configStore.update(sanitized);
    applyMainWindowBranding();
    startWechatPoller();
    if (next.browserMode !== 'external') await closeExternalBrowserPreview();
    return { ...context.configStore.publicConfig(false), apiKeyConfigured: Boolean(next.apiKey) };
  });
  ipcMain.handle('config:test', async (_event, profile?: 'agent' | 'omni') => {
    const config = context.getConfig();
    return profile === 'omni' ? testRealtimeConnection(config) : testLlmConnection(config);
  });
  ipcMain.handle('themes:import', async (_event, req: ThemeImportRequest) => {
    const theme = await importThemePackage(context.harnessHome, req);
    const config = context.getConfig();
    const next = context.configStore.update({
      customThemes: [
        theme,
        ...config.customThemes.filter((item) => item.id !== theme.id)
      ],
      theme: `custom:${theme.id}`
    });
    applyMainWindowTitleBarOverlay(next);
    return { ...context.configStore.publicConfig(false), apiKeyConfigured: Boolean(next.apiKey) };
  });
  ipcMain.handle('themes:dreamskin:list', async (_event, req?: DreamSkinGalleryQuery) => listDreamSkinGallery(req ?? {}));
  ipcMain.handle('themes:dreamskin:install', async (_event, req: DreamSkinThemeInstallRequest) => {
    const next = await installDreamSkinTheme(context.harnessHome, context.configStore, req);
    applyMainWindowTitleBarOverlay();
    return next;
  });
  ipcMain.handle('liveRealtime:start', async (_event, req?: LiveRealtimeStartRequest) => liveRealtimeManager.start(req ?? {}));
  ipcMain.handle('liveRealtime:send', async (_event, event: LiveRealtimeClientEvent) => {
    liveRealtimeManager.send(event);
    return { ok: true, content: 'Realtime event sent.' };
  });
  ipcMain.handle('liveRealtime:stop', async () => {
    liveRealtimeManager.stop();
    return { ok: true, content: 'Realtime session stopped.' };
  });
  ipcMain.handle('liveSessions:create', () => {
    const session = context.sessionStore.create('New session');
    const relation = liveSessionStore.create(session.id);
    broadcastSessionUpdated({
      sessionId: session.id,
      source: 'external',
      updatedAt: session.updatedAt
    });
    return { sessionId: session.id, relation };
  });
  ipcMain.handle('liveSessions:read', (_event, sessionId: string) => {
    const id = sessionId?.trim();
    return id ? liveSessionStore.read(id) : null;
  });
  ipcMain.handle('liveSessions:appendMessage', (_event, req: LiveSessionAppendMessageRequest) => {
    const sessionId = req.sessionId?.trim();
    const content = req.content?.trim();
    if (!sessionId) throw new Error('sessionId is required.');
    if (!content) throw new Error('content is required.');
    if (!context.sessionStore.read(sessionId)) {
      context.sessionStore.create('New session', sessionId);
    }
    liveSessionStore.create(sessionId);
    const message: AgentMessage = {
      role: req.role === 'assistant' ? 'assistant' : 'user',
      content,
      attachments: Array.isArray(req.attachments) && req.attachments.length > 0 ? req.attachments : undefined,
      createdAt: req.createdAt
    };
    const current = context.sessionStore.read(sessionId);
    const existingMessages = current?.messages ?? [];
    const lastMessage = existingMessages.at(-1);
    const incomingInterim = message.role === 'assistant' && isLiveTaskInterimAssistantContent(message.content);
    const lastInterim = lastMessage?.role === 'assistant' && isLiveTaskInterimAssistantContent(lastMessage.content);
    const updated = incomingInterim && hasRecentLiveTaskForSession(sessionId)
      ? (current ?? context.sessionStore.read(sessionId) ?? context.sessionStore.create('New session', sessionId))
      : lastInterim && message.role === 'assistant' && !incomingInterim
        ? context.sessionStore.replaceMessages(sessionId, [...existingMessages.slice(0, -1), message])
        : context.sessionStore.appendMessages(sessionId, [message], []);
    broadcastSessionUpdated({
      sessionId: updated.id,
      source: 'external',
      updatedAt: updated.updatedAt
    });
    return updated;
  });
  ipcMain.handle('liveTasks:list', (_event, sessionId?: string) => liveTaskQueue.list(sessionId));
  ipcMain.handle('liveTasks:enqueue', (_event, req: LiveAgentTaskCreateRequest) => liveTaskQueue.enqueue(req, _event.sender));
  ipcMain.handle('liveTasks:stop', (_event, taskId: string) => liveTaskQueue.stop(taskId));
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

  ipcMain.handle('tool-approval:decision', (_event, decision: ToolApprovalDecision) => {
    return resolveToolApproval(_event.sender.id, decision);
  });

  ipcMain.handle('agent:chat', async (
    _event,
    input: string,
    sessionId?: string,
    executionMode?: 'workspace' | 'sandbox',
    usePersonalKnowledgeBase?: boolean,
    attachments?: AgentMessageAttachment[]
  ) => {
    if ((!input || !input.trim()) && (!Array.isArray(attachments) || attachments.length === 0)) throw new Error('Message cannot be empty.');
    const senderId = _event.sender.id;
    if (activeChatControllers.has(senderId)) throw new Error('A chat session is already running.');
    const controller = new AbortController();
    activeChatControllers.set(senderId, controller);
    let completedSessionId: string | undefined;
    let completedToolEvents: ToolEvent[] = [];
    try {
      const sidecarResult = await maybeRunDshSidecarChatTurn({
        sender: _event.sender,
        input,
        sessionId,
        executionMode,
        attachments: Array.isArray(attachments) ? attachments : undefined,
        controller
      });
      if (sidecarResult) {
        completedSessionId = sidecarResult.sessionId;
        completedToolEvents = sidecarResult.toolEvents;
        return sidecarResult;
      }
      const sync = await context.dshSidecarRuntimeBridge.sync().catch((error) => ({
        toolNames: [] as string[],
        error: error instanceof Error ? error.message : String(error)
      }));
      const result = await context.agentLoop.run({
        userInput: input,
        attachments: Array.isArray(attachments) ? attachments : undefined,
        sessionId,
        executionMode,
        usePersonalKnowledgeBase: usePersonalKnowledgeBase === true,
        enabledToolNames: [...new Set([...context.getConfig().enabledToolNames, ...sync.toolNames])],
        origin: 'chat',
        signal: controller.signal,
        requestToolApproval: (request) => requestInteractiveToolApproval(_event.sender, request),
        onToolEvent: (eventSessionId, toolEvent) => {
          const payload: AgentToolEventStream = { sessionId: eventSessionId, event: context.sessionStore.toolEventForDisplay(toolEvent) };
          safeSend(_event.sender, 'agent:tool-event', payload);
        },
        onMessageDelta: (_eventSessionId, messageDelta) => {
          safeSend(_event.sender, 'agent:message-delta', messageDelta);
        },
        onSessionUpdated: (record) => {
          broadcastSessionUpdated({
            sessionId: record.id,
            source: 'chat',
            updatedAt: record.updatedAt
          });
        }
      });
      completedSessionId = result.sessionId;
      completedToolEvents = result.toolEvents;
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
      const displayRecord = context.sessionStore.readForDisplay(result.sessionId);
      return {
        ...result,
        messages: displayRecord?.messages ?? result.messages,
        toolEvents: displayRecord?.toolEvents ?? result.toolEvents,
        followUpQuestions,
        totalUsage: usageRecord.totalUsage
      };
    } catch (error) {
      if (controller.signal.aborted) throw chatAbortError(controller);
      logAgentChatError({
        error,
        input,
        sessionId,
        executionMode,
        attachments: Array.isArray(attachments) ? attachments : undefined
      });
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const active = activeChatControllers.get(senderId);
      if (active === controller) activeChatControllers.delete(senderId);
      if (context.getConfig().browserMode === 'external') await closeExternalBrowserPreviewAfterRun(completedSessionId, completedToolEvents);
    }
  });

  ipcMain.handle('agent:optimizeSkills', async (_event, req: SkillOptimizationRunRequest) => {
    const prompt = req?.prompt?.trim();
    const sessionIds = Array.isArray(req?.sessionIds) ? req.sessionIds.map((id) => id.trim()).filter(Boolean) : [];
    if (!prompt) throw new Error('Message cannot be empty.');
    if (sessionIds.length === 0) throw new Error('Select at least one session to optimize from.');
    const senderId = _event.sender.id;
    if (activeChatControllers.has(senderId)) throw new Error('A chat session is already running.');
    const controller = new AbortController();
    activeChatControllers.set(senderId, controller);
    let completedSessionId: string | undefined;
    let completedToolEvents: ToolEvent[] = [];
    const selectedContext = context.sessionStore.buildOptimizationContext({ sessionIds });
    const input = [
      prompt,
      'Selected session context:',
      selectedContext.context,
      [
        'Skill optimization scope rules:',
        `- Only use the selected sessions listed above: ${selectedContext.sessionIds.join(', ')}.`,
        '- Do not search the whole session directory.',
        '- The session_search tool is disabled for this optimization run to prevent unrelated or recursive session history from entering the model request.',
        '- If the compact context is not enough, make a narrow skill improvement from the visible failure signals instead of broadening the session scope.'
      ].join('\n')
    ].join('\n\n');
    try {
      const cfg = context.getConfig();
      const enabledToolNames = cfg.enabledToolNames.filter((name) => name !== 'session_search');
      const result = await context.agentLoop.run({
        userInput: input,
        executionMode: req.executionMode,
        usePersonalKnowledgeBase: false,
        origin: 'chat',
        signal: controller.signal,
        enabledToolNames,
        requestToolApproval: (request) => requestInteractiveToolApproval(_event.sender, request),
        onToolEvent: (eventSessionId, toolEvent) => {
          const payload: AgentToolEventStream = { sessionId: eventSessionId, event: context.sessionStore.toolEventForDisplay(toolEvent) };
          safeSend(_event.sender, 'agent:tool-event', payload);
        },
        onMessageDelta: (_eventSessionId, messageDelta) => {
          safeSend(_event.sender, 'agent:message-delta', messageDelta);
        },
        onSessionUpdated: (record) => {
          broadcastSessionUpdated({
            sessionId: record.id,
            source: 'chat',
            updatedAt: record.updatedAt
          });
        }
      });
      completedSessionId = result.sessionId;
      completedToolEvents = result.toolEvents;
      const usageRecord = context.sessionStore.recordUsage(result.sessionId, result.usage);
      broadcastSessionUpdated({
        sessionId: result.sessionId,
        source: 'chat',
        updatedAt: new Date().toISOString()
      });
      const displayRecord = context.sessionStore.readForDisplay(result.sessionId);
      return {
        ...result,
        messages: displayRecord?.messages ?? result.messages,
        toolEvents: displayRecord?.toolEvents ?? result.toolEvents,
        totalUsage: usageRecord.totalUsage
      };
    } catch (error) {
      if (controller.signal.aborted) throw chatAbortError(controller);
      logAgentChatError({
        error,
        input,
        executionMode: req.executionMode,
        attachments: []
      });
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      const active = activeChatControllers.get(senderId);
      if (active === controller) activeChatControllers.delete(senderId);
      if (context.getConfig().browserMode === 'external') await closeExternalBrowserPreviewAfterRun(completedSessionId, completedToolEvents);
    }
  });

  ipcMain.handle('agent:stop', async (_event) => {
    const senderId = _event.sender.id;
    const controller = activeChatControllers.get(senderId);
    let stoppedChat = 0;
    if (controller) {
      abortChatController(controller, 'agent:stop');
      stoppedChat = 1;
    }
    const wechatControllers = [...activeWechatRuns.values()];
    activeWechatRuns.clear();
    for (const wechatController of wechatControllers) {
      try {
        wechatController.abort();
      } catch {
        // Ignore abort failures from stale controllers.
      }
    }
    const stoppedWechat = wechatControllers.length;
    const wechatSessionId = context.getConfig().wechatChannel.sessionId?.trim();
    if (wechatSessionId) {
      const record = context.sessionStore.read(wechatSessionId);
      if (record) {
        const cleaned = record.messages.filter((message) => !(message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER));
        if (cleaned.length !== record.messages.length) {
          context.sessionStore.replaceMessages(wechatSessionId, cleaned);
          broadcastSessionUpdated({
            sessionId: wechatSessionId,
            source: 'external',
            updatedAt: new Date().toISOString()
          });
        }
      }
    }
    if (context.getConfig().browserMode === 'external') {
      void closeExternalBrowserPreview().catch((error) => {
        console.warn(`[browser] Failed to close external preview after stop: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (stoppedChat === 0 && stoppedWechat === 0) {
      return { ok: true, content: 'No active session to stop.' };
    }
    return { ok: true, content: `Stop signal sent. chat=${stoppedChat}, wechat=${stoppedWechat}` };
  });

  ipcMain.handle('sessions:list', () => context.sessionStore.list());
  ipcMain.handle('sessions:listPage', (_event, req: SessionListPageRequest) => context.sessionStore.listPage(req));
  ipcMain.handle('sessions:read', (_event, id: string) => context.sessionStore.read(id));
  ipcMain.handle('sessions:readForDisplay', (_event, id: string) => context.sessionStore.readForDisplay(id));
  ipcMain.handle('sessions:readMessageContent', (_event, req: { sessionId: string; messageId: string }) => {
    const result = context.sessionStore.readMessageContent(req.sessionId, req.messageId);
    if (!result) throw new Error(`Message not found: ${req.messageId}`);
    return result;
  });
  ipcMain.handle('sessions:readToolEventContent', (_event, req: { sessionId: string; toolEventId: string }) => {
    const result = context.sessionStore.readToolEventContent(req.sessionId, req.toolEventId);
    if (!result) throw new Error(`Tool event not found: ${req.toolEventId}`);
    return result;
  });
  ipcMain.handle('sessions:delete', (_event, id: string) => context.sessionStore.delete(id));
  ipcMain.handle('sessions:rename', (_event, id: string, title: string) => context.sessionStore.rename(id, title));
  ipcMain.handle('sessions:search', (_event, query: string) => context.sessionStore.search(query).map((r) => r.item));
  ipcMain.handle('sessions:appendExternalMessage', (_event, req: ExternalSessionMessageRequest) => {
    const content = req.content?.trim();
    if (!content) throw new Error('content is required.');
    const role = req.role === 'assistant' ? 'assistant' : 'user';
    const requestedSessionId = req.sessionId?.trim();
    const existing = requestedSessionId ? context.sessionStore.read(requestedSessionId) : null;
    const title = req.title?.trim() || 'WeChat session';
    const shouldUseWechatSession = !existing && isWechatSessionTitle(title);
    const session = existing ?? (
      shouldUseWechatSession
        ? context.sessionStore.read(ensureWechatSessionId()) ?? context.sessionStore.create('WeChat ClawBot')
        : context.sessionStore.create(title)
    );
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
  ipcMain.handle('knowledge:addFolder', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Select folder to import into Personal Knowledge',
      properties: ['openDirectory']
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { folderPath: '', discovered: 0, imported: 0, skipped: 0, failed: [] };
    }
    const folderPath = picked.filePaths[0];
    const allFiles = listFilesRecursively(folderPath);
    let imported = 0;
    let skipped = 0;
    const failed: Array<{ filePath: string; error: string }> = [];
    for (const filePath of allFiles) {
      const relName = relative(folderPath, filePath).replace(/\\/g, '/');
      const content = readFileSync(filePath);
      const result = await importKnowledgeBuffer(relName || basename(filePath), content);
      imported += result.imported;
      skipped += result.skipped;
      for (const item of result.failed) {
        failed.push({
          filePath: item.filePath.includes('/') ? item.filePath : filePath,
          error: item.error
        });
      }
    }
    return {
      folderPath,
      discovered: allFiles.length,
      imported,
      skipped,
      failed
    };
  });
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
  ipcMain.handle('skills:installBundled', (_event, name: string, overwrite?: boolean) => context.skillManager.installBundled(name, Boolean(overwrite)));
  ipcMain.handle('skills:uploadArchive', (_event, req: SkillArchiveUploadRequest) => context.skillManager.uploadArchive(req));
  ipcMain.handle('skills:market:browse', (_event, req?: string | MarketplaceBrowseRequest) => context.marketplaceManager.browse(req));
  ipcMain.handle('skills:market:install', (_event, req: SkillInstallRequest) => context.marketplaceManager.install(req));
  ipcMain.handle('skills:market:uninstall', (_event, name: string) => context.marketplaceManager.uninstall(name));
  ipcMain.handle('dsh-sidecar:status', () => context.dshSidecarManager.status());
  ipcMain.handle('dsh-sidecar:start', () => context.dshSidecarManager.start());
  ipcMain.handle('dsh-sidecar:stop', () => context.dshSidecarManager.stop());
  ipcMain.handle('dsh-sidecar:plugins:list', () => context.dshSidecarManager.list());
  ipcMain.handle('dsh-sidecar:runtime:status', () => context.dshSidecarManager.runtimeStatus());
  ipcMain.handle('dsh-sidecar:runtime:sync', () => context.dshSidecarRuntimeBridge.sync());
  ipcMain.handle('dsh-sidecar:client-mounts:list', () => context.dshSidecarManager.listClientMounts());
  ipcMain.handle('dsh-sidecar:client-mounts:open', async (_event, req: DshSidecarClientMountOpenRequest) => {
    return await openDshClientMount(req);
  });
  ipcMain.handle('dsh-sidecar:chat:run', (_event, req: DshSidecarChatRunRequest) => context.dshSidecarManager.chatRun(req));
  ipcMain.handle('dsh-sidecar:plugins:install', async (_event, req: DshSidecarPluginInstallRequest) => {
    return await context.dshSidecarManager.install(req);
  });
  ipcMain.handle('dsh-sidecar:plugins:upload', async (_event, req: DshSidecarPluginUploadRequest) => {
    return await context.dshSidecarManager.upload(req);
  });
  ipcMain.handle('dsh-sidecar:plugins:enable', async (_event, req: DshSidecarPluginActionRequest) => {
    return await context.dshSidecarManager.enable(req);
  });
  ipcMain.handle('dsh-sidecar:plugins:disable', async (_event, req: DshSidecarPluginActionRequest) => {
    return await context.dshSidecarManager.disable(req);
  });
  ipcMain.handle('dsh-sidecar:plugins:uninstall', async (_event, req: DshSidecarPluginActionRequest) => {
    return await context.dshSidecarManager.uninstall(req);
  });
  ipcMain.handle('plugins:market:browse', (_event, req?: string | DshMarketplaceBrowseRequest) => context.dshPluginMarketplaceManager.browse(req));
  ipcMain.handle('plugins:market:detail', (_event, id: string) => context.dshPluginMarketplaceManager.detail(id));
  ipcMain.handle('plugins:market:install', async (_event, req: DshMarketplacePluginInstallRequest) => {
    return await context.dshPluginMarketplaceManager.install(req);
  });
  ipcMain.handle('browser-coach:start', async (_event, req?: BrowserCoachStartRequest) => {
    const config = context.getConfig();
    if (config.browserMode === 'external') {
      const url = normalizeBrowserCoachStartUrl(req?.url);
      const result = await context.externalBrowserBridge.open(url, { ...config, externalBrowserEngine: 'cdp' });
      if (!result.ok) throw new Error(result.content);
      return browserCoachRecorder.startExternalCdp(req, {
        endpoint: context.externalBrowserBridge.cdpEndpointHint(config),
        targetId: context.externalBrowserBridge.activeCdpTargetId()
      });
    }
    return browserCoachRecorder.start(req);
  });
  ipcMain.handle('browser-coach:stop', () => {
    const recording = browserCoachRecorder.stop();
    return recording;
  });
  ipcMain.handle('browser-coach:status', () => browserCoachRecorder.status());
  ipcMain.handle('browser-coach:clear', () => browserCoachRecorder.clear());
  ipcMain.handle('browser-coach:listRecordings', () => [
    ...listStandaloneBrowserCoachRecordings()
  ].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
  ipcMain.handle('browser-coach:loadRecording', (_event, recordingId: string) => (
    readStandaloneBrowserCoachRecording(recordingId)
  ));
  ipcMain.handle('browser-coach:deleteRecording', (_event, recordingId: string) => (
    deleteStandaloneBrowserCoachRecording(recordingId)
  ));
  ipcMain.handle('browser-coach:generateSkill', async (_event, req: BrowserCoachGenerateSkillRequest) => browserCoachRecorder.generateSkill(
    req,
    context.skillManager,
    (request, recording) => buildBrowserCoachSkillContentWithModel(
      request,
      recording,
      createLlmClient(context.getConfig()),
      buildBuiltinSkillCreatorGuide()
    )
  ));

  ipcMain.handle('tasks:list', () => context.scheduledTaskStore.list());
  ipcMain.handle('tasks:create', (_event, req: ScheduledTaskCreateRequest) => context.scheduledTaskStore.create(req));
  ipcMain.handle('tasks:update', (_event, req: ScheduledTaskPatchRequest) => context.scheduledTaskStore.update(req));
  ipcMain.handle('tasks:delete', (_event, id: string) => context.scheduledTaskStore.delete(id));
  ipcMain.handle('tasks:runNow', async (_event, id: string) => {
    const task = context.scheduledTaskStore.list().find((item) => item.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    context.scheduledTaskStore.setRunning(id, true);
    let completedSessionId: string | undefined;
    let completedToolEvents: ToolEvent[] = [];
    try {
      const result = await context.agentLoop.run({
        userInput: task.prompt,
        sessionId: task.sessionId,
        executionMode: task.executionMode,
        origin: 'scheduled',
        scheduledTaskId: task.id
      });
      completedSessionId = result.sessionId;
      completedToolEvents = result.toolEvents;
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
          `[${context.getConfig().branding.productName}] ${updated.name}`,
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
      if (context.getConfig().browserMode === 'external') await closeExternalBrowserPreviewAfterRun(completedSessionId, completedToolEvents);
    }
  });

  ipcMain.handle('tools:list', () => context.toolRegistry.definitions(context.getConfig().enabledToolNames));
  ipcMain.handle('tools:run', async (_event, req: ToolRunRequest) => {
    const cfg = context.getConfig();
    const result = await context.toolRegistry.execute(req.name, req.args, {
      sessionId: req.sessionId || 'manual',
      workspaceDir: req.executionMode === 'sandbox' ? context.sandboxManager.prepare('sandbox', cfg.workspaceDir, createId('manual-run')).workspaceDir : cfg.workspaceDir,
      requestId: createId('manual'),
      safetyApproval: context.getConfig().safetyApproval,
      requestToolApproval: (request) => requestInteractiveToolApproval(_event.sender, request)
    });
    await maybeOpenExternalBrowser(latestWebPreviewUrlFromSource(req.name, req.args, result.content, true));
    return result;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    harnessHome: context.harnessHome,
    productName: context.getConfig().branding.productName
  }));
  ipcMain.handle('app:selectBrandLogo', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Select brand logo',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico'] }
      ]
    });
    return picked.canceled || picked.filePaths.length === 0 ? '' : picked.filePaths[0];
  });
  ipcMain.handle('app:exportAssistantMessage', async (_event, req: AssistantMessageExportRequest) => exportAssistantMessage(req));
  ipcMain.handle('app:artifactPreview', async (_event, req: ArtifactPreviewRequest) => artifactPreview(req));
  ipcMain.handle('app:openArtifact', async (_event, req: ArtifactPathRequest) => {
    const target = resolveArtifactRequestPath(req);
    const err = await shell.openPath(target);
    return { ok: !err, content: err || 'Opened.' };
  });
  ipcMain.handle('app:revealArtifact', async (_event, req: ArtifactPathRequest) => {
    const target = resolveArtifactRequestPath(req);
    shell.showItemInFolder(target);
    return { ok: true, content: 'Revealed.' };
  });
  ipcMain.handle('app:openPath', async (_event, path: string) => {
    const err = await shell.openPath(path);
    return { ok: !err, content: err || 'Opened.' };
  });
  ipcMain.handle('app:openExternalUrl', async (_event, url: string, options?: { system?: boolean }) => {
    if (options?.system) {
      try {
        await shell.openExternal(url);
        return { ok: true, content: `Opened ${url} in the system browser.` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, content: `Failed to open ${url}: ${message}` };
      }
    }
    return maybeOpenExternalBrowser(url);
  });
  ipcMain.handle('app:closeExternalPreview', async () => closeExternalBrowserPreview());
  ipcMain.handle('app:setEmbeddedPreviewWebContentsId', (_event, id: number | null) => {
    if (id == null) {
      clearEmbeddedPreviewWebContentsBinding();
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
    if (!isAllowedEmbeddedPreviewPartition(sessionPartition(target))) {
      return { ok: false, content: `webContents ${id} is not in an allowed embedded browser partition.` };
    }
    bindEmbeddedPreviewWebContents(target);
    return { ok: true, content: `Bound embedded preview webContents id=${target.id}.` };
  });
  ipcMain.handle('app:setWindowTitleBarTheme', (_event, preview?: unknown) => {
    applyMainWindowTitleBarOverlay(preview ? titleBarThemeConfigFromPayload(preview) : context.getConfig());
    return true;
  });
  ipcMain.handle('app:windowMinimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) win.minimize();
    return true;
  });
  ipcMain.handle('app:windowToggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('app:windowClose', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) win.close();
    return true;
  });
}

app.on('before-quit', () => {
  isAppQuitting = true;
  liveRealtimeManager.stop();
  denyPendingToolApprovals();
  browserCoachRecorder.close();
  for (const controller of activeChatControllers.values()) abortChatController(controller, 'app:before-quit');
  activeChatControllers.clear();
  stopWechatPoller();
  void context.dshSidecarManager.stop();
  void closeExternalBrowserPreview();
});

app.whenReady().then(() => {
  applyPlatformAppIdentity();
  Menu.setApplicationMenu(null);
  app.setName(context.getConfig().branding.productName);
  applyBrandDockIcon(context.getConfig().branding.logoPath);
  registerWechatTools();
  app.on('web-contents-created', (_event, contents) => {
    registerNativeContextMenu(contents);
    contents.once('destroyed', () => {
      if (contents.id === embeddedPreviewWebContentsId) embeddedPreviewWebContentsId = null;
      const controller = activeChatControllers.get(contents.id);
      if (controller) {
        abortChatController(controller, 'web-contents-destroyed');
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
