import { app, BrowserWindow, ipcMain, screen, shell, webContents, type Rectangle, type WebContents } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppContext } from './appContext.js';
import { generateFollowUpQuestions } from './agent/followUpQuestions.js';
import { createLlmClient, testLlmConnection } from './agent/llmClient.js';
import type {
  AgentToolEventStream,
  AppConfig,
  MemoryClearRequest,
  OpenCliExtensionStatus,
  ToolEvent,
  ToolExecutionResult,
  MemoryQueryOptions,
  PersonalKnowledgeUploadRequest,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SkillPatchRequest,
  SkillWriteRequest,
  ToolRunRequest
} from '../shared/types.js';
import { createId } from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browserConstants.js';
import { applyAppDockIcon, applyPlatformAppIdentity, resolveAppWindowIconPath } from './appIcon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let devToolsWindow: BrowserWindow | null = null;
const context = new AppContext();
let loadedOpenCliExtensionDir: string | null = null;
let embeddedPreviewWebContentsId: number | null = null;
let isAppQuitting = false;
const OPENCLI_ELECTRON_UNSUPPORTED_PERMISSIONS = new Set(['debugger', 'cookies']);
const warnedOpenCliMessages = new Set<string>();
let lastExternalBrowserOpen: { url: string; at: number } | null = null;

function warnOpenCliOnce(message: string): void {
  if (warnedOpenCliMessages.has(message)) return;
  warnedOpenCliMessages.add(message);
  console.warn(message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function extractWebPreviewUrls(content: string): string[] {
  const urls: string[] = [];
  const pattern = /(?:opencli_preview_url|browser_preview_url):\s*(https?:\/\/[^\s"'<>`]+)/gi;
  for (const match of content.matchAll(pattern)) {
    const raw = (match[1] ?? '').trim();
    if (!raw) continue;
    urls.push(raw.replace(/[),.;!?]+$/, ''));
  }
  return urls;
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
  const marker = text.match(/(?:opencli_preview_url|browser_preview_url):\s*(https?:\/\/[^\s"'<>`]+)/i);
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
  if (!combined.includes('opencli_preview_url')) return false;
  return /bridge is disconnected|showing fallback|extension not connected/i.test(combined);
}

function isWebPreviewEvent(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (combined.includes('opencli')) return true;
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
  if (context.getConfig().opencliBridgeMode !== 'external') {
    return { ok: false, content: 'External browser mode is not active.' };
  }
  const now = Date.now();
  if (lastExternalBrowserOpen && lastExternalBrowserOpen.url === url && now - lastExternalBrowserOpen.at < 1500) {
    return { ok: true, content: `External browser already opened recently for ${url}.` };
  }
  try {
    await shell.openExternal(
      url,
      process.platform === 'win32'
        ? {
            workingDirectory: context.harnessHome,
            logUsage: true
          }
        : undefined
    );
    lastExternalBrowserOpen = { url, at: now };
    return { ok: true, content: `Opened ${url} in the external browser.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[opencli] failed to open external browser for ${url}: ${message}`);
    return { ok: false, content: `Failed to open ${url} in the external browser: ${message}` };
  }
}

function openCliExtensionCandidates(cfg: AppConfig): string[] {
  const explicit = cfg.opencliExtensionPath?.trim();
  const candidates = [
    explicit || '',
    resolve(context.harnessHome, 'extensions', 'opencli-extension'),
    resolve(process.cwd(), 'resources', 'opencli-extension'),
    resolve(app.getAppPath(), 'resources', 'opencli-extension'),
    resolve(process.resourcesPath ?? '', 'opencli-extension')
  ].filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of candidates) {
    const normalized = resolve(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function findManifestInDirectory(path: string): string | null {
  if (!existsSync(path)) return null;
  const direct = resolve(path, 'manifest.json');
  if (existsSync(direct)) return resolve(path);
  if (!statSync(path).isDirectory()) return null;
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (!existsSync(child) || !statSync(child).isDirectory()) continue;
    if (existsSync(resolve(child, 'manifest.json'))) return child;
  }
  return null;
}

function readExtensionManifest(extensionDir: string): { permissions: string[] } | null {
  const manifestPath = resolve(extensionDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: unknown };
    const permissions = Array.isArray(parsed.permissions) ? parsed.permissions.filter((item): item is string => typeof item === 'string') : [];
    return { permissions };
  } catch {
    return null;
  }
}

function detectOpenCliElectronCompatibility(extensionDir: string): { compatible: boolean; message?: string } {
  const manifest = readExtensionManifest(extensionDir);
  if (!manifest) {
    return { compatible: false, message: `Cannot read manifest.json from ${extensionDir}.` };
  }
  const unsupported = manifest.permissions.filter((permission) => OPENCLI_ELECTRON_UNSUPPORTED_PERMISSIONS.has(permission));
  if (unsupported.length === 0) return { compatible: true };
  return {
    compatible: false,
    message: `OpenCLI extension requests unsupported Electron APIs (${unsupported.join(', ')}). Use external browser mode for full bridge support.`
  };
}

async function loadExtensionCompat(extensionDir: string): Promise<void> {
  if (!mainWindow) throw new Error('Main window is not ready yet.');
  const currentSession = mainWindow.webContents.session as unknown as {
    loadExtension?: (path: string, options?: { allowFileAccess?: boolean }) => Promise<unknown>;
    extensions?: { loadExtension?: (path: string, options?: { allowFileAccess?: boolean }) => Promise<unknown> };
  };
  if (currentSession.extensions?.loadExtension) {
    await currentSession.extensions.loadExtension(extensionDir, { allowFileAccess: true });
    return;
  }
  if (currentSession.loadExtension) {
    await currentSession.loadExtension(extensionDir, { allowFileAccess: true });
    return;
  }
  throw new Error('No extension loader API found on current Electron session.');
}

function findOpenCliExtensionDir(cfg: AppConfig): string | null {
  for (const candidate of openCliExtensionCandidates(cfg)) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isFile() && candidate.toLowerCase().endsWith('manifest.json')) return dirname(candidate);
    const found = findManifestInDirectory(candidate);
    if (found) return found;
  }
  return null;
}

async function ensureOpenCliExtensionLoaded(): Promise<void> {
  if (!mainWindow) return;
  const cfg = context.getConfig();
  if (cfg.opencliBridgeMode !== 'embedded') return;
  const extensionDir = findOpenCliExtensionDir(cfg);
  if (!extensionDir) {
    if (cfg.opencliExtensionPath?.trim()) {
      warnOpenCliOnce(`[opencli] extension manifest not found under: ${cfg.opencliExtensionPath}`);
    }
    return;
  }
  const compatibility = detectOpenCliElectronCompatibility(extensionDir);
  if (!compatibility.compatible) {
    warnOpenCliOnce(`[opencli] skipped loading extension from ${extensionDir}: ${compatibility.message}`);
    return;
  }
  if (loadedOpenCliExtensionDir === extensionDir) return;
  try {
    await loadExtensionCompat(extensionDir);
    loadedOpenCliExtensionDir = extensionDir;
    console.info(`[opencli] loaded browser bridge extension from ${extensionDir}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/already loaded/i.test(msg)) {
      loadedOpenCliExtensionDir = extensionDir;
      return;
    }
    console.warn(`[opencli] failed to load browser bridge extension from ${extensionDir}: ${msg}`);
  }
}

function openCliExtensionStatus(): OpenCliExtensionStatus {
  const cfg = context.getConfig();
  const detected = findOpenCliExtensionDir(cfg);
  const compatibility = detected ? detectOpenCliElectronCompatibility(detected) : { compatible: false as const };
  const loadedPath = loadedOpenCliExtensionDir ? resolve(loadedOpenCliExtensionDir) : '';
  const detectedPath = detected ? resolve(detected) : '';
  const loaded = Boolean(loadedPath) && (!detectedPath || loadedPath === detectedPath);
  const available = Boolean(detectedPath);
  if (cfg.opencliBridgeMode === 'external') {
    return {
      mode: cfg.opencliBridgeMode,
      loaded,
      available,
      detectedPath: detectedPath || undefined,
      loadedPath: loadedPath || undefined,
      message: 'External browser mode is active. Extension status is optional in this mode.'
    };
  }
  if (available && !compatibility.compatible) {
    return {
      mode: cfg.opencliBridgeMode,
      loaded: false,
      available,
      detectedPath: detectedPath || undefined,
      loadedPath: loadedPath || undefined,
      message: compatibility.message || 'OpenCLI extension is not compatible with Electron embedded mode.'
    };
  }
  if (loaded) {
    return {
      mode: cfg.opencliBridgeMode,
      loaded,
      available,
      detectedPath: detectedPath || undefined,
      loadedPath: loadedPath || undefined,
      message: `OpenCLI extension is loaded${loadedPath ? ` from ${loadedPath}` : ''}.`
    };
  }
  if (available) {
    return {
      mode: cfg.opencliBridgeMode,
      loaded,
      available,
      detectedPath: detectedPath || undefined,
      loadedPath: loadedPath || undefined,
      message: `Extension files were detected at ${detectedPath}, but are not loaded yet.`
    };
  }
  return {
    mode: cfg.opencliBridgeMode,
    loaded,
    available,
    detectedPath: undefined,
    loadedPath: loadedPath || undefined,
    message: 'OpenCLI extension files were not found.'
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
  await ensureOpenCliExtensionLoaded();

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
    await ensureOpenCliExtensionLoaded();
    return { ...context.configStore.publicConfig(false), apiKeyConfigured: Boolean(next.apiKey) };
  });
  ipcMain.handle('config:test', async () => testLlmConnection(context.getConfig()));

  ipcMain.handle('agent:chat', async (_event, input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean) => {
    if (!input || !input.trim()) throw new Error('Message cannot be empty.');
    try {
      const result = await context.agentLoop.run({
        userInput: input,
        sessionId,
        executionMode,
      usePersonalKnowledgeBase: usePersonalKnowledgeBase === true,
      origin: 'chat',
      onToolEvent: (eventSessionId, toolEvent) => {
        void maybeOpenExternalBrowser(latestWebPreviewUrlFromEvents([toolEvent], true));
        const payload: AgentToolEventStream = { sessionId: eventSessionId, event: toolEvent };
        _event.sender.send('agent:tool-event', payload);
      }
    });
      const followUpQuestions = await generateFollowUpQuestions(
        () => createLlmClient(context.getConfig()),
        context.getConfig(),
        { userInput: input, finalResponse: result.finalResponse }
      );
      await maybeOpenExternalBrowser(latestWebPreviewUrlFromEvents(result.toolEvents, true));
      return { ...result, followUpQuestions };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  });

  ipcMain.handle('sessions:list', () => context.sessionStore.list());
  ipcMain.handle('sessions:read', (_event, id: string) => context.sessionStore.read(id));
  ipcMain.handle('sessions:delete', (_event, id: string) => context.sessionStore.delete(id));
  ipcMain.handle('sessions:rename', (_event, id: string, title: string) => context.sessionStore.rename(id, title));
  ipcMain.handle('sessions:search', (_event, query: string) => context.sessionStore.search(query).map((r) => r.item));

  ipcMain.handle('memory:get', (_event, query?: MemoryQueryOptions) => context.memoryStore.getState(query));
  ipcMain.handle('memory:clear', (_event, request: MemoryClearRequest) => context.memoryStore.clear(request));
  ipcMain.handle('knowledge:list', () => context.personalKnowledgeBase.getState());
  ipcMain.handle('knowledge:addDocument', (_event, req: PersonalKnowledgeUploadRequest) => context.personalKnowledgeBase.addDocument(req));
  ipcMain.handle('knowledge:deleteDocument', (_event, id: string) => context.personalKnowledgeBase.deleteDocument(id));

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
    const result = await context.agentLoop.run({
      userInput: task.prompt,
      sessionId: task.sessionId,
      executionMode: task.executionMode,
      origin: 'scheduled',
      scheduledTaskId: task.id
    });
    const updated = context.scheduledTaskStore.markRun(id, { sessionId: result.sessionId, output: result.finalResponse });
    if (updated.notifyByEmail) {
      await context.emailNotifier.send(
        context.getConfig().emailNotifications,
        `[Tasi Harness] ${updated.name}`,
        [`Task: ${updated.name}`, `Run at: ${updated.lastRunAt ?? updated.updatedAt}`, '', result.finalResponse].join('\n')
      );
    }
    return result;
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
  ipcMain.handle('app:openCliExtensionStatus', () => openCliExtensionStatus());
}

app.on('before-quit', () => {
  isAppQuitting = true;
});

app.whenReady().then(() => {
  applyPlatformAppIdentity();
  applyAppDockIcon();
  app.on('web-contents-created', (_event, contents) => {
    contents.once('destroyed', () => {
      if (contents.id === embeddedPreviewWebContentsId) embeddedPreviewWebContentsId = null;
    });
  });
  registerIpc();
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
