import { BrowserWindow, type IpcMainEvent } from 'electron';
import type {
  BrowserCoachGenerateSkillRequest,
  BrowserCoachGenerateSkillResult,
  BrowserCoachRecordedEvent,
  BrowserCoachRecording,
  BrowserCoachStartRequest
} from '../../shared/types.js';
import { createId } from '../../shared/types.js';
import type { SkillManager } from '../skills/skillManager.js';
import { buildBrowserCoachSkillContent } from './browserCoachSkill.js';

type BrowserCoachIncomingEvent = Omit<BrowserCoachRecordedEvent, 'id' | 'index' | 'createdAt'>;

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

export class BrowserCoachRecorder {
  private window: BrowserWindow | null = null;
  private recording: BrowserCoachRecording | null = null;

  constructor(private readonly preloadPath: string) {}

  start(req: BrowserCoachStartRequest = {}): BrowserCoachRecording {
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

  stop(): BrowserCoachRecording {
    if (this.recording?.active) {
      this.recording.active = false;
      this.recording.endedAt = new Date().toISOString();
    }
    if (this.window && !this.window.isDestroyed()) this.window.close();
    return cloneRecording(this.recording);
  }

  status(): BrowserCoachRecording {
    return cloneRecording(this.recording);
  }

  clear(): BrowserCoachRecording {
    if (!this.recording) return cloneRecording(null);
    if (!this.recording.active) {
      this.recording = null;
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
    if (!this.recording || this.recording.events.length === 0) {
      throw new Error('No browser coach recording is available.');
    }
    if (!req.name?.trim()) throw new Error('Skill name is required.');
    const recording = cloneRecording(this.recording);
    const content = contentBuilder ? await contentBuilder(req, recording) : buildBrowserCoachSkillContent(req, recording);
    const skill = skillManager.create({
      name: req.name,
      category: req.category || 'browser',
      content
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
