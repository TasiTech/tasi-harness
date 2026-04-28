import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from '../src/main/scheduler/taskScheduler.js';
import { ScheduledTaskStore } from '../src/main/storage/scheduledTaskStore.js';
import { ConfigStore } from '../src/main/storage/configStore.js';
import { SessionStore } from '../src/main/storage/sessionStore.js';
import { tempHome } from './helpers.js';
import type { AgentLoop } from '../src/main/agent/agentLoop.js';
import type { EmailNotifier } from '../src/main/notifications/emailNotifier.js';

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TaskScheduler', () => {
  it('runs due tasks and sends email + wechat notifications when enabled', async () => {
    const env = tempHome();
    cleanup = env.cleanup;

    const taskStore = new ScheduledTaskStore(env.home);
    const configStore = new ConfigStore(env.home);
    const sessionStore = new SessionStore(env.home);

    configStore.update({
      wechatChannel: {
        enabled: true,
        pluginName: 'clawbot',
        bindUrl: 'https://ilinkai.weixin.qq.com',
        botToken: 'bot-token',
        botId: 'bot-id',
        lastInboundUserId: 'user-001',
        lastContextToken: 'ctx-001',
        baseUrl: 'https://ilinkai.weixin.qq.com'
      }
    });

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    taskStore.create({
      name: 'Daily summary',
      prompt: 'Summarize today',
      scheduleType: 'once',
      runAt: dueAt,
      executionMode: 'workspace',
      notifyByEmail: true,
      notifyByWechat: true
    });

    const agentLoop = {
      run: vi.fn().mockResolvedValue({
        sessionId: sessionStore.create('sched').id,
        finalResponse: 'Task completed',
        iterations: 2,
        toolEvents: [],
        execution: { mode: 'workspace', workspaceDir: env.home },
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }
      })
    } as unknown as AgentLoop;

    const emailSend = vi.fn().mockResolvedValue(undefined);
    const emailNotifier = { send: emailSend } as unknown as EmailNotifier;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ret: 0, errcode: 0 })
    });
    vi.stubGlobal('fetch', fetchMock);

    const scheduler = new TaskScheduler({
      taskStore,
      agentLoop,
      configStore,
      emailNotifier,
      sessionStore
    });

    await scheduler.tick(new Date());

    expect(agentLoop.run).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/ilink/bot/sendmessage');
    expect(String(init.body ?? '')).toContain('Task completed');

    const [task] = taskStore.list();
    expect(task.lastResult).toBe('Task completed');
    expect(task.enabled).toBe(false);
    expect(task.isRunning).toBe(false);
    expect(task.lastError).toBeUndefined();
  });

  it('captures wechat ret=-2 and clears stale context token', async () => {
    const env = tempHome();
    cleanup = env.cleanup;

    const taskStore = new ScheduledTaskStore(env.home);
    const configStore = new ConfigStore(env.home);
    const sessionStore = new SessionStore(env.home);

    configStore.update({
      wechatChannel: {
        enabled: true,
        pluginName: 'clawbot',
        bindUrl: 'https://ilinkai.weixin.qq.com',
        botToken: 'bot-token',
        botId: 'bot-id',
        lastInboundUserId: 'user-001',
        lastContextToken: 'ctx-will-reset',
        baseUrl: 'https://ilinkai.weixin.qq.com'
      }
    });

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    taskStore.create({
      name: 'Retry notify',
      prompt: 'Run',
      scheduleType: 'once',
      runAt: dueAt,
      executionMode: 'workspace',
      notifyByEmail: false,
      notifyByWechat: true
    });

    const agentLoop = {
      run: vi.fn().mockResolvedValue({
        sessionId: sessionStore.create('sched').id,
        finalResponse: 'ok',
        iterations: 1,
        toolEvents: [],
        execution: { mode: 'workspace', workspaceDir: env.home },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      })
    } as unknown as AgentLoop;

    const emailNotifier = { send: vi.fn() } as unknown as EmailNotifier;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ret: -2 })
      })
    );

    const scheduler = new TaskScheduler({
      taskStore,
      agentLoop,
      configStore,
      emailNotifier,
      sessionStore
    });

    await scheduler.tick(new Date());

    const cfg = configStore.get();
    expect(cfg.wechatChannel.lastContextToken).toBe('');
    expect(cfg.wechatChannel.lastError ?? '').toContain('ret=-2');
  });
});
