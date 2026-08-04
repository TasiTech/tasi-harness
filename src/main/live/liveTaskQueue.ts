import type { WebContents } from 'electron';
import type { AgentLoop } from '../agent/agentLoop.js';
import type { LiveSessionStore } from './liveSessionStore.js';
import type {
  ExecutionMode,
  LiveAgentTask,
  LiveAgentTaskCreateRequest,
  LiveAgentTaskTrace,
  ToolApprovalDecision,
  ToolApprovalRequest
} from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';

type TaskUpdateListener = (task: LiveAgentTask) => void;
const LIVE_TASK_DEDUPE_WINDOW_MS = 20_000;

function normalizeTaskPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().toLowerCase();
}

export class LiveTaskQueue {
  private readonly tasks = new Map<string, LiveAgentTask>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;

  constructor(
    private readonly deps: {
      agentLoop: AgentLoop;
      concurrency: number;
      defaultExecutionMode: () => ExecutionMode;
      requestToolApproval: (sender: WebContents, request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
      onTaskUpdate: TaskUpdateListener;
      liveSessionStore?: LiveSessionStore;
    }
  ) {}

  list(sessionId?: string): LiveAgentTask[] {
    const inMemory = [...this.tasks.values()];
    const persisted = sessionId?.trim()
      ? this.deps.liveSessionStore?.read(sessionId.trim())?.tasks ?? []
      : this.deps.liveSessionStore?.list().flatMap((relation) => relation.tasks) ?? [];
    const merged = new Map<string, LiveAgentTask>();
    for (const task of persisted) merged.set(task.id, task);
    for (const task of inMemory) merged.set(task.id, task);
    const tasks = [...merged.values()];
    const filtered = sessionId?.trim() ? tasks.filter((task) => task.sessionId === sessionId.trim()) : tasks;
    return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  enqueue(req: LiveAgentTaskCreateRequest, sender: WebContents): LiveAgentTask {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error('Live task prompt cannot be empty.');
    const frontendSessionId = req.sessionId?.trim() || createId('session');
    const executionMode = req.executionMode ?? this.deps.defaultExecutionMode();
    const duplicate = this.findRecentDuplicate(frontendSessionId, prompt, executionMode);
    if (duplicate) return duplicate;
    const id = createId('livetask');
    const createdAt = nowIso();
    const backendSessionId = createId('backend_session');
    const task: LiveAgentTask = {
      id,
      name: req.name?.trim() || prompt.slice(0, 48) || 'Live task',
      prompt,
      status: 'queued',
      sessionId: frontendSessionId,
      backendSessionId,
      executionMode,
      createdAt,
      updatedAt: createdAt,
      trace: [
        {
          id: createId('livetrace'),
          taskId: id,
          title: 'Live Agent',
          label: 'Status',
          content: 'Queued from realtime conversation.',
          createdAt
        }
      ]
    };
    this.tasks.set(id, task);
    this.deps.liveSessionStore?.upsertTask(task.sessionId, task);
    this.queue.push(id);
    this.deps.onTaskUpdate(task);
    this.pump(sender);
    return task;
  }

  stop(taskId: string): LiveAgentTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status === 'queued') {
      const index = this.queue.indexOf(taskId);
      if (index >= 0) this.queue.splice(index, 1);
      return this.patch(taskId, { status: 'cancelled', finishedAt: nowIso(), error: 'Cancelled before start.' });
    }
    const controller = this.controllers.get(taskId);
    controller?.abort();
    return this.patch(taskId, { status: 'cancelled', finishedAt: nowIso(), error: 'Cancellation requested.' });
  }

  private pump(sender: WebContents): void {
    while (this.running < Math.max(1, this.deps.concurrency) && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'queued') continue;
      this.running += 1;
      void this.runTask(task, sender).finally(() => {
        this.running = Math.max(0, this.running - 1);
        this.controllers.delete(task.id);
        this.pump(sender);
      });
    }
  }

  private findRecentDuplicate(sessionId: string, prompt: string, executionMode: ExecutionMode): LiveAgentTask | null {
    const promptKey = normalizeTaskPrompt(prompt);
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      if (task.executionMode !== executionMode) continue;
      if (task.status === 'failed' || task.status === 'cancelled') continue;
      if (normalizeTaskPrompt(task.prompt) !== promptKey) continue;
      const createdMs = Date.parse(task.createdAt);
      if (!Number.isFinite(createdMs) || now - createdMs > LIVE_TASK_DEDUPE_WINDOW_MS) continue;
      return task;
    }
    return null;
  }

  private async runTask(task: LiveAgentTask, sender: WebContents): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.patch(task.id, {
      status: 'running',
      startedAt: nowIso()
    }, {
      title: 'Live Agent',
      label: 'Status',
      content: 'Background AgentLoop started.'
    });

    try {
      const result = await this.deps.agentLoop.run({
        userInput: task.prompt,
        sessionId: task.backendSessionId || task.sessionId,
        executionMode: task.executionMode,
        origin: 'chat',
        signal: controller.signal,
        requestToolApproval: (request) => this.deps.requestToolApproval(sender, request),
        onToolEvent: (_sessionId, event) => {
          this.patch(task.id, {}, {
            title: event.toolName,
            label: event.ok ? 'Tool Result' : 'Tool Error',
            content: event.content || JSON.stringify(event.args, null, 2)
          });
        },
        onMessageDelta: (_sessionId, delta) => {
          if (!delta.delta || delta.type === 'done') return;
          this.patch(task.id, {}, {
            title: 'AgentLoop',
            label: delta.type === 'reasoning_content' ? 'Reasoning' : 'Text',
            content: delta.delta
          });
        }
      });
      if (controller.signal.aborted) return;
      this.patch(task.id, {
        status: 'completed',
        result: result.finalResponse,
        finishedAt: nowIso()
      }, {
        title: 'AgentLoop',
        label: 'Status',
        content: 'Completed.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = controller.signal.aborted || /aborted|stopped|cancel/i.test(message);
      this.patch(task.id, {
        status: isAbort ? 'cancelled' : 'failed',
        error: message,
        finishedAt: nowIso()
      }, {
        title: 'AgentLoop',
        label: isAbort ? 'Status' : 'Tool Error',
        content: message
      });
    }
  }

  private patch(taskId: string, partial: Partial<LiveAgentTask>, trace?: Omit<LiveAgentTaskTrace, 'id' | 'taskId' | 'createdAt'>): LiveAgentTask | null {
    const current = this.tasks.get(taskId);
    if (!current) return null;
    const updatedAt = nowIso();
    const nextTrace = trace
      ? [
          ...current.trace,
          {
            id: createId('livetrace'),
            taskId,
            createdAt: updatedAt,
            ...trace
          }
        ]
      : current.trace;
    const next: LiveAgentTask = {
      ...current,
      ...partial,
      trace: nextTrace,
      updatedAt
    };
    this.tasks.set(taskId, next);
    this.deps.liveSessionStore?.upsertTask(next.sessionId, next);
    this.deps.onTaskUpdate(next);
    return next;
  }
}
