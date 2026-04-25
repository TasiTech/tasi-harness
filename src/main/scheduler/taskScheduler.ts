import type { AgentLoop } from '../agent/agentLoop.js';
import type { ConfigStore } from '../storage/configStore.js';
import type { ScheduledTaskStore } from '../storage/scheduledTaskStore.js';
import { EmailNotifier } from '../notifications/emailNotifier.js';

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningTaskIds = new Set<string>();

  constructor(
    private readonly deps: {
      taskStore: ScheduledTaskStore;
      agentLoop: AgentLoop;
      configStore: ConfigStore;
      emailNotifier: EmailNotifier;
    }
  ) {}

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
      try {
        const result = await this.deps.agentLoop.run({
          userInput: task.prompt,
          sessionId: task.sessionId,
          executionMode: task.executionMode,
          origin: 'scheduled',
          scheduledTaskId: task.id
        });
        const updated = this.deps.taskStore.markRun(task.id, {
          sessionId: result.sessionId,
          output: result.finalResponse
        });
        if (updated.notifyByEmail) {
          const cfg = this.deps.configStore.get();
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
      } catch (error) {
        this.deps.taskStore.markRun(task.id, {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.runningTaskIds.delete(task.id);
      }
    }
  }
}
