import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserCoachRecording } from '../src/shared/types.js';
import { BrowserCoachRecorder } from '../src/main/browser/browserCoachRecorder.js';
import { SkillManager } from '../src/main/skills/skillManager.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  cleanup();
  cleanup = () => {};
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

class MockCdpWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = MockCdpWebSocket.OPEN;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? new Set();
    list.add(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    const payload = JSON.parse(raw) as { id: number };
    queueMicrotask(() => {
      this.emit('message', { data: JSON.stringify({ id: payload.id, result: {} }) });
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function sampleRecording(): BrowserCoachRecording {
  return {
    id: 'rec_1',
    startUrl: 'https://example.com/search',
    startedAt: '2026-05-06T00:00:00.000Z',
    active: false,
    events: [
      {
        id: 'evt_1',
        index: 1,
        type: 'navigation',
        url: 'https://example.com/search',
        title: 'Search',
        createdAt: '2026-05-06T00:00:01.000Z'
      }
    ]
  };
}

function recorderWithRecording(recording: BrowserCoachRecording): BrowserCoachRecorder {
  const recorder = new BrowserCoachRecorder('');
  (recorder as unknown as { recording: BrowserCoachRecording }).recording = recording;
  return recorder;
}

describe('BrowserCoachRecorder skill generation', () => {
  it('creates a unique skill when the default browser workflow name already exists', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const manager = new SkillManager(env.home);
    manager.create({
      name: 'recorded-browser-workflow',
      category: 'browser',
      content: '---\nname: recorded-browser-workflow\ndescription: Existing skill\ncategory: browser\n---\n\nExisting.'
    });
    const recorder = recorderWithRecording(sampleRecording());

    const result = await recorder.generateSkill(
      { name: 'recorded-browser-workflow', category: 'browser' },
      manager
    );

    expect(result.skill.name).toBe('recorded-browser-workflow-2');
    expect(existsSync(join(env.home, 'skills', 'browser', 'recorded-browser-workflow-2', 'references', 'recording.json'))).toBe(true);
  });

  it('falls back to an ASCII host-based skill name for non-ASCII-only names', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const manager = new SkillManager(env.home);
    const recorder = recorderWithRecording(sampleRecording());

    const result = await recorder.generateSkill(
      { name: '浏览器流程', category: '浏览器' },
      manager
    );

    expect(result.skill.name).toBe('example.com-browser-workflow');
    expect(result.skill.category).toBe('browser');
  });

  it('uses the edited recording supplied with the generate request', async () => {
    const env = tempHome();
    cleanup = env.cleanup;
    const manager = new SkillManager(env.home);
    const recorder = recorderWithRecording(sampleRecording());
    const editedRecording = {
      ...sampleRecording(),
      events: [
        {
          ...sampleRecording().events[0],
          id: 'evt_edited',
          url: 'https://edited.example.com/result',
          title: 'Edited result'
        }
      ]
    };
    let capturedUrl = '';

    await recorder.generateSkill(
      { name: 'edited-flow', category: 'browser', recording: editedRecording },
      manager,
      async (_req, recording) => {
        capturedUrl = recording.events[0]?.url ?? '';
        return '---\nname: edited-flow\ndescription: Edited flow\ncategory: browser\n---\n\nEdited.'
      }
    );

    expect(capturedUrl).toBe('https://edited.example.com/result');
  });
});

describe('BrowserCoachRecorder external CDP recording', () => {
  it('records events sent from an attached system browser target', async () => {
    const sockets: MockCdpWebSocket[] = [];
    globalThis.fetch = (async (url) => {
      expect(String(url)).toBe('http://127.0.0.1:9222/json/list');
      return new Response(JSON.stringify([
        {
          id: 'target-1',
          type: 'page',
          url: 'https://example.com',
          title: 'Example',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-1'
        }
      ]), { status: 200 });
    }) as typeof fetch;
    globalThis.WebSocket = class extends MockCdpWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const recorder = new BrowserCoachRecorder('');
    const started = await recorder.startExternalCdp(
      { url: 'example.com' },
      { endpoint: 'http://127.0.0.1:9222', targetId: 'target-1' }
    );
    expect(started.active).toBe(true);
    expect(started.events[0]?.type).toBe('navigation');

    sockets[0].emit('message', {
      data: JSON.stringify({
        method: 'Runtime.bindingCalled',
        params: {
          name: 'tasiBrowserCoachRecord',
          payload: JSON.stringify({
            type: 'click',
            url: 'https://example.com',
            title: 'Example',
            selector: 'button',
            tag: 'button',
            name: 'Continue'
          })
        }
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = recorder.status();
    expect(status.events.map((event) => event.type)).toEqual(['navigation', 'click']);
    expect(status.events[1]?.selector).toBe('button');
  });
});
