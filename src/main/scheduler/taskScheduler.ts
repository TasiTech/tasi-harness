import type { AgentLoop } from '../agent/agentLoop.js';
import type { ConfigStore } from '../storage/configStore.js';
import type { ScheduledTaskStore } from '../storage/scheduledTaskStore.js';
import type { SessionStore } from '../storage/sessionStore.js';
import { EmailNotifier } from '../notifications/emailNotifier.js';
import { createId } from '../../shared/types.js';

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

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningTaskIds = new Set<string>();

  constructor(
    private readonly deps: {
      taskStore: ScheduledTaskStore;
      agentLoop: AgentLoop;
      configStore: ConfigStore;
      emailNotifier: EmailNotifier;
      sessionStore: SessionStore;
    }
  ) {}

  private buildWechatAuthHeaders(botToken: string): Record<string, string> {
    const randomUin = Math.floor(Math.random() * 0xffffffff).toString(10);
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${botToken}`,
      'X-WECHAT-UIN': Buffer.from(randomUin).toString('base64')
    };
  }

  private async sendWechatNotification(taskName: string, runAtIso: string, executionMode: 'workspace' | 'sandbox', content: string): Promise<void> {
    const cfg = this.deps.configStore.get();
    const channel = cfg.wechatChannel;
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
    const response = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: this.buildWechatAuthHeaders(token),
      body: JSON.stringify({
        msg: {
          from_user_id: channel.botId?.trim() || '',
          to_user_id: toUserId,
          client_id: `tasi-${createId('taskwx')}`,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [
            {
              type: 1,
              text_item: { text }
            }
          ]
        },
        base_info: { channel_version: '1.0.0' }
      })
    });
    if (!response.ok) throw new Error(`sendmessage HTTP ${response.status}`);
    const payload = await response.json() as unknown as { errcode?: number; errmsg?: string; ret?: number };
    if (typeof payload.errcode === 'number' && payload.errcode !== 0) throw new Error(payload.errmsg || `errcode=${payload.errcode}`);
    if (typeof payload.ret === 'number' && payload.ret !== 0) throw new Error(payload.errmsg || `ret=${payload.ret}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    const due = this.deps.taskStore.list().filter((task) => task.enabled && Date.parse(task.nextRunAt) <= now.getTime());
    for (const task of due) {
      if (this.runningTaskIds.has(task.id)) continue;
      this.runningTaskIds.add(task.id);
      this.deps.taskStore.setRunning(task.id, true);
      try {
        const result = await this.deps.agentLoop.run({
          userInput: task.prompt,
          sessionId: task.sessionId,
          executionMode: task.executionMode,
          origin: 'scheduled',
          scheduledTaskId: task.id
        });
        this.deps.sessionStore.recordUsage(result.sessionId, result.usage);
        const updated = this.deps.taskStore.markRun(task.id, {
          sessionId: result.sessionId,
          output: result.finalResponse,
          iterations: result.iterations,
          toolEventCount: result.toolEvents.length,
          trace: buildTaskTrace(result)
        });
        const cfg = this.deps.configStore.get();
        if (updated.notifyByEmail) {
          await this.deps.emailNotifier.send(
            cfg.emailNotifications,
            `[Tasi Harness] ${updated.name}`,
            [
              `Task: ${updated.name}`,
              `Run at: ${updated.lastRunAt ?? updated.updatedAt}`,
              `Execution: ${result.execution.mode}`,
              '',
              result.finalResponse
            ].join('\n')
          );
        }
        if (updated.notifyByWechat) {
          try {
            await this.sendWechatNotification(
              updated.name,
              updated.lastRunAt ?? updated.updatedAt,
              result.execution.mode,
              result.finalResponse
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const cfg2 = this.deps.configStore.get();
            const shouldResetContext = /ret=-2|parameter/i.test(message);
            this.deps.configStore.update({
              wechatChannel: {
                ...cfg2.wechatChannel,
                lastError: `[task-wechat-notify] ${message}`,
                lastContextToken: shouldResetContext ? '' : cfg2.wechatChannel.lastContextToken
              }
            });
          }
        }
      } catch (error) {
        this.deps.taskStore.markRun(task.id, {
          error: error instanceof Error ? error.message : String(error),
          trace: error instanceof Error ? error.stack || error.message : String(error)
        });
      } finally {
        this.runningTaskIds.delete(task.id);
      }
    }
  }
}
