import type { BrowserWindow as ElectronBrowserWindow, IpcMainEvent } from 'electron';
import { createRequire } from 'node:module';
import type {
  BrowserCoachGenerateSkillRequest,
  BrowserCoachGenerateSkillResult,
  BrowserCoachRecordedEvent,
  BrowserCoachRecording,
  BrowserCoachStartRequest
} from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import type { SkillManager } from '../skills/skillManager.js';
import { buildBrowserCoachSkillContent, normalizeBrowserCoachSkillRequest } from './browserCoachSkill.js';

const electronRequire = createRequire(import.meta.url);
const { BrowserWindow } = electronRequire('electron/main') as typeof import('electron/main');

type BrowserCoachIncomingEvent = Omit<BrowserCoachRecordedEvent, 'id' | 'index' | 'createdAt'>;

interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface CdpEventMessage {
  method?: string;
  params?: Record<string, any>;
}

function normalizeStartUrl(input: string | undefined): string {
  const trimmed = input?.trim() || 'https://www.baidu.com';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function cloneRecording(recording: BrowserCoachRecording | null): BrowserCoachRecording {
  if (!recording) {
    return {
      id: '',
      startUrl: '',
      startedAt: '',
      active: false,
      events: []
    };
  }
  return {
    ...recording,
    events: recording.events.map((event) => ({ ...event }))
  };
}

function endpointRoot(endpoint: string): string {
  const value = endpoint.trim() || 'http://127.0.0.1:9222';
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `http://${value}`;
  return withProtocol.endsWith('/json/version') ? withProtocol.slice(0, -'/json/version'.length) : withProtocol.replace(/\/+$/, '');
}

function withWsScheme(url: string): string {
  const value = url.trim();
  if (/^wss?:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/^http/i, 'ws');
  return `ws://${value}`;
}

async function readMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data ?? '');
}

function externalCoachInjectionScript(): string {
  return `
    (() => {
      if (window.__tasiBrowserCoachInstalled) return true;
      window.__tasiBrowserCoachInstalled = true;
      const clip = (input, max = 160) => {
        const text = String(input || '').replace(/\\s+/g, ' ').trim();
        return text.length > max ? text.slice(0, max - 3) + '...' : text;
      };
      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
        return String(value).replace(/["\\\\]/g, '\\\\$&');
      };
      const elementSelector = (element) => {
        const id = element.getAttribute('id');
        if (id) return '#' + cssEscape(id);
        const testId = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy');
        if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
        const name = element.getAttribute('name');
        if (name) return element.tagName.toLowerCase() + '[name="' + cssEscape(name) + '"]';
        const aria = element.getAttribute('aria-label');
        if (aria) return element.tagName.toLowerCase() + '[aria-label="' + cssEscape(aria) + '"]';
        const parts = [];
        let current = element;
        while (current && current !== document.body && parts.length < 4) {
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
          const index = siblings.indexOf(current);
          parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (index + 1) + ')' : tag);
          current = parent;
        }
        return parts.join(' > ') || element.tagName.toLowerCase();
      };
      const elementName = (element) => {
        const direct = element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          element.getAttribute('placeholder') ||
          element.getAttribute('alt') ||
          element.getAttribute('name');
        if (direct) return clip(direct, 120);
        const id = element.getAttribute('id');
        if (id) {
          const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
          if (label && label.textContent) return clip(label.textContent, 120);
        }
        return clip(element.textContent || '', 120);
      };
      const elementValue = (element) => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return undefined;
        if (element instanceof HTMLInputElement && element.type === 'password') return '[masked]';
        return clip(element.value, 180);
      };
      const payloadFor = (type, element, extra = {}) => ({
        type,
        url: location.href,
        title: document.title,
        selector: elementSelector(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || undefined,
        name: elementName(element) || undefined,
        text: clip(element.textContent || '', 160) || undefined,
        value: elementValue(element),
        ...extra
      });
      const send = (payload) => {
        try {
          if (typeof window.tasiBrowserCoachRecord === 'function') {
            window.tasiBrowserCoachRecord(JSON.stringify(payload));
          }
        } catch {}
      };
      const inputTimers = new Map();
      window.addEventListener('click', (event) => {
        const element = event.target instanceof Element ? event.target.closest('a,button,input,textarea,select,[role],label,[tabindex]') || event.target : null;
        if (!element) return;
        send(payloadFor('click', element));
      }, true);
      window.addEventListener('input', (event) => {
        const element = event.target instanceof Element ? event.target : null;
        if (!element) return;
        const selector = elementSelector(element);
        const existing = inputTimers.get(selector);
        if (existing) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          inputTimers.delete(selector);
          send(payloadFor('input', element));
        }, 600);
        inputTimers.set(selector, timer);
      }, true);
      window.addEventListener('change', (event) => {
        const element = event.target instanceof Element ? event.target : null;
        if (!element) return;
        send(payloadFor('change', element));
      }, true);
      window.addEventListener('submit', (event) => {
        const element = event.target instanceof Element ? event.target : document.body;
        send(payloadFor('submit', element));
      }, true);
      window.addEventListener('keydown', (event) => {
        if (!['Enter', 'Tab', 'Escape'].includes(event.key)) return;
        const element = event.target instanceof Element ? event.target : document.body;
        send(payloadFor('keydown', element, { key: event.key }));
      }, true);
      send({ type: 'navigation', url: location.href, title: document.title });
      return true;
    })();
  `;
}

export class BrowserCoachRecorder {
  private window: ElectronBrowserWindow | null = null;
  private recording: BrowserCoachRecording | null = null;
  private externalSocket: WebSocket | null = null;
  private cdpMessageId = 0;

  constructor(
    private readonly preloadPath: string,
    private readonly onRecordingFinished?: (recording: BrowserCoachRecording) => void
  ) {}

  start(req: BrowserCoachStartRequest = {}): BrowserCoachRecording {
    this.stopExternalSocket();
    const startUrl = normalizeStartUrl(req.url);
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.recording = {
      id: createId('browser_coach'),
      startUrl,
      startedAt: new Date().toISOString(),
      active: true,
      events: []
    };
    this.window = new BrowserWindow({
      width: 1180,
      height: 860,
      title: 'Browser Coach',
      show: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: 'persist:tasi-harness-browser-coach'
      }
    });
    this.window.on('closed', () => {
      this.recordWindowClosed();
      this.window = null;
    });
    this.window.webContents.on('did-navigate', (_event, url) => this.recordNavigation(url));
    this.window.webContents.on('did-navigate-in-page', (_event, url) => this.recordNavigation(url));
    void this.window.loadURL(startUrl);
    return cloneRecording(this.recording);
  }

  async startExternalCdp(req: BrowserCoachStartRequest = {}, options: { endpoint: string; targetId?: string | null }): Promise<BrowserCoachRecording> {
    const startUrl = normalizeStartUrl(req.url);
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.stopExternalSocket();
    this.recording = {
      id: createId('browser_coach'),
      startUrl,
      startedAt: new Date().toISOString(),
      active: true,
      events: []
    };
    const target = await this.resolveCdpTarget(options.endpoint, options.targetId);
    if (target.url) this.pushEvent({ type: 'navigation', url: target.url, title: target.title });
    await this.attachExternalTarget(target);
    return cloneRecording(this.recording);
  }

  stop(): BrowserCoachRecording {
    if (this.recording?.active) {
      this.recording.active = false;
      this.recording.endedAt = new Date().toISOString();
    }
    const stopped = cloneRecording(this.recording);
    if (stopped.events.length > 0) this.onRecordingFinished?.(stopped);
    this.stopExternalSocket();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    return stopped;
  }

  status(): BrowserCoachRecording {
    return cloneRecording(this.recording);
  }

  clear(): BrowserCoachRecording {
    if (!this.recording) return cloneRecording(null);
    if (!this.recording.active) {
      this.recording = null;
      this.stopExternalSocket();
      return cloneRecording(null);
    }
    const currentUrl = this.window && !this.window.isDestroyed() ? this.window.webContents.getURL() : this.recording.startUrl;
    this.recording = {
      id: createId('browser_coach'),
      startUrl: currentUrl || this.recording.startUrl,
      startedAt: new Date().toISOString(),
      active: true,
      events: []
    };
    return cloneRecording(this.recording);
  }

  acceptEvent(event: IpcMainEvent, payload: BrowserCoachIncomingEvent): void {
    if (!this.recording?.active) return;
    if (!this.window || this.window.isDestroyed()) return;
    if (event.sender.id !== this.window.webContents.id) return;
    this.pushEvent(payload);
  }

  async generateSkill(
    req: BrowserCoachGenerateSkillRequest,
    skillManager: SkillManager,
    contentBuilder?: (req: BrowserCoachGenerateSkillRequest, recording: BrowserCoachRecording) => Promise<string>
  ): Promise<BrowserCoachGenerateSkillResult> {
    const sourceRecording = req.recording?.events.length ? req.recording : this.recording;
    if (!sourceRecording || sourceRecording.events.length === 0) {
      throw new Error('No browser coach recording is available.');
    }
    if (!req.name?.trim()) throw new Error('Skill name is required.');
    const recording = cloneRecording(sourceRecording);
    const normalizedReq = normalizeBrowserCoachSkillRequest(req, recording);
    const createReq = {
      ...normalizedReq,
      name: req.overwrite ? normalizedReq.name : skillManager.nextAvailableName(normalizedReq.name, normalizedReq.category)
    };
    const content = contentBuilder ? await contentBuilder(createReq, recording) : buildBrowserCoachSkillContent(createReq, recording);
    const skill = skillManager.create({
      name: createReq.name,
      category: createReq.category,
      content,
      overwrite: req.overwrite
    });
    const recordingReferencePath = skillManager.writeSupportingFile(
      skill.name,
      'references/recording.json',
      `${JSON.stringify(recording, null, 2)}\n`
    );
    return {
      skill,
      recording,
      recordingReferencePath
    };
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
    this.stopExternalSocket();
  }

  private async resolveCdpTarget(endpoint: string, targetId?: string | null): Promise<CdpTargetInfo> {
    const root = endpointRoot(endpoint);
    const response = await fetch(`${root}/json/list`, { method: 'GET' });
    if (!response.ok) throw new Error(`CDP target list unavailable (${response.status}) at ${root}/json/list`);
    const targets = (await response.json()) as CdpTargetInfo[];
    const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    const target = (targetId ? pages.find((item) => item.id === targetId) : undefined)
      ?? pages.find((item) => item.url && item.url !== 'about:blank')
      ?? pages[0];
    if (!target?.webSocketDebuggerUrl) throw new Error('No attachable CDP page target is available for browser coach recording.');
    return target;
  }

  private async attachExternalTarget(target: CdpTargetInfo): Promise<void> {
    this.stopExternalSocket();
    const ws = new WebSocket(withWsScheme(target.webSocketDebuggerUrl ?? ''));
    this.externalSocket = ws;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out while attaching to external browser target.')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timeout);
        reject(new Error(`CDP socket error: ${String((event as unknown as { message?: string }).message || 'unknown')}`));
      });
    });
    ws.addEventListener('message', (event) => {
      void this.handleExternalCdpMessage((event as MessageEvent).data);
    });
    ws.addEventListener('close', () => {
      if (this.externalSocket === ws) this.externalSocket = null;
    });
    await this.sendExternalCdpCommand('Runtime.enable', {});
    await this.sendExternalCdpCommand('Page.enable', {});
    await this.sendExternalCdpCommand('Runtime.addBinding', { name: 'tasiBrowserCoachRecord' });
    const source = externalCoachInjectionScript();
    await this.sendExternalCdpCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    await this.sendExternalCdpCommand('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true });
  }

  private async handleExternalCdpMessage(data: unknown): Promise<void> {
    const text = await readMessageData(data);
    let payload: CdpEventMessage;
    try {
      payload = JSON.parse(text) as CdpEventMessage;
    } catch {
      return;
    }
    if (payload.method === 'Runtime.bindingCalled' && payload.params?.name === 'tasiBrowserCoachRecord') {
      try {
        const event = JSON.parse(String(payload.params.payload || '{}')) as BrowserCoachIncomingEvent;
        this.pushEvent(event);
      } catch {
        // Ignore malformed page payloads.
      }
      return;
    }
    if (payload.method === 'Page.frameNavigated') {
      const frame = payload.params?.frame as { parentId?: string; url?: string; name?: string } | undefined;
      if (frame && !frame.parentId && frame.url) this.pushEvent({ type: 'navigation', url: frame.url, title: frame.name || '' });
    }
  }

  private async sendExternalCdpCommand(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const ws = this.externalSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('External browser coach CDP socket is not connected.');
    const id = ++this.cdpMessageId;
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', listener);
        reject(new Error(`CDP timeout for ${method}.`));
      }, 8000);
      const listener = (event: MessageEvent) => {
        void (async () => {
          const text = await readMessageData(event.data);
          let payload: Record<string, any>;
          try {
            payload = JSON.parse(text) as Record<string, any>;
          } catch {
            return;
          }
          if (payload.id !== id) return;
          clearTimeout(timeout);
          ws.removeEventListener('message', listener);
          if (payload.error) {
            const error = payload.error as { message?: string } | undefined;
            reject(new Error(error?.message ? `CDP ${method} failed: ${error.message}` : `CDP ${method} failed.`));
            return;
          }
          resolve((payload.result as Record<string, any>) || {});
        })();
      };
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private stopExternalSocket(): void {
    const ws = this.externalSocket;
    this.externalSocket = null;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // Ignore CDP socket cleanup errors.
    }
  }

  private recordNavigation(url: string): void {
    if (!this.recording?.active) return;
    const title = this.window && !this.window.isDestroyed() ? this.window.webContents.getTitle() : '';
    this.pushEvent({ type: 'navigation', url, title });
  }

  private recordWindowClosed(): void {
    if (!this.recording?.active) return;
    const url = this.window && !this.window.isDestroyed() ? this.window.webContents.getURL() : this.recording.startUrl;
    const title = this.window && !this.window.isDestroyed() ? this.window.webContents.getTitle() : '';
    this.pushEvent({ type: 'window_closed', url, title });
    this.recording.active = false;
    this.recording.endedAt = new Date().toISOString();
    this.onRecordingFinished?.(cloneRecording(this.recording));
  }

  private pushEvent(input: BrowserCoachIncomingEvent): void {
    if (!this.recording) return;
    const last = this.recording.events[this.recording.events.length - 1];
    const isDuplicate =
      last &&
      last.type === input.type &&
      last.url === input.url &&
      last.selector === input.selector &&
      last.value === input.value &&
      Date.now() - Date.parse(last.createdAt) < 350;
    if (isDuplicate) return;
    const event: BrowserCoachRecordedEvent = {
      id: createId('coach_event'),
      index: this.recording.events.length + 1,
      createdAt: new Date().toISOString(),
      type: input.type,
      url: input.url || this.recording.startUrl,
      title: input.title,
      selector: input.selector,
      tag: input.tag,
      role: input.role,
      name: input.name,
      text: input.text,
      value: input.value,
      key: input.key
    };
    this.recording.events.push(event);
    while (this.recording.events.length > 600) this.recording.events.shift();
    this.recording.events.forEach((item, index) => {
      item.index = index + 1;
    });
  }
}
