import { join } from 'node:path';
import type { ScheduledTask, ScheduledTaskCreateRequest, ScheduledTaskPatchRequest } from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { JsonFileStore } from './jsonFileStore.js';

function computeNextRunAt(task: Pick<ScheduledTask, 'scheduleType' | 'runAt' | 'intervalMinutes'>, fromIso = nowIso()): string {
  if (task.scheduleType === 'interval') {
    const minutes = Math.max(1, Number(task.intervalMinutes) || 60);
    return new Date(Date.parse(fromIso) + minutes * 60_000).toISOString();
  }
  const runAt = task.runAt ? new Date(task.runAt).toISOString() : fromIso;
  return runAt;
}

export class ScheduledTaskStore {
  private readonly store: JsonFileStore<ScheduledTask[]>;

  constructor(harnessHome: string) {
    this.store = new JsonFileStore<ScheduledTask[]>(join(harnessHome, 'scheduled-tasks.json'), () => []);
  }

  list(): ScheduledTask[] {
    return this.store.read()
      .map((task) => ({ ...task, notifyByWechat: Boolean(task.notifyByWechat), isRunning: Boolean(task.isRunning) }))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  create(req: ScheduledTaskCreateRequest): ScheduledTask {
    const createdAt = nowIso();
    const task: ScheduledTask = {
      id: createId('task'),
      name: req.name.trim() || 'Scheduled task',
      prompt: req.prompt.trim(),
      scheduleType: req.scheduleType,
      runAt: req.runAt,
      intervalMinutes: req.intervalMinutes,
      nextRunAt: computeNextRunAt(req, createdAt),
      enabled: true,
      isRunning: false,
      executionMode: req.executionMode,
      notifyByEmail: req.notifyByEmail,
      notifyByWechat: req.notifyByWechat ?? false,
      createdAt,
      updatedAt: createdAt
    };
    const next = [...this.list(), task];
    this.store.write(next);
    return task;
  }

  update(req: ScheduledTaskPatchRequest): ScheduledTask {
    const tasks = this.list();
    const current = tasks.find((task) => task.id === req.id);
    if (!current) throw new Error(`Scheduled task not found: ${req.id}`);
    const updatedAt = nowIso();
    const nextTask: ScheduledTask = {
      ...current,
      ...req,
      updatedAt
    };
    if (req.scheduleType || req.runAt || req.intervalMinutes) {
      nextTask.nextRunAt = computeNextRunAt(nextTask, updatedAt);
    }
    const next = tasks.map((task) => (task.id === req.id ? nextTask : task));
    this.store.write(next);
    return nextTask;
  }

  delete(id: string): boolean {
    const tasks = this.list();
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) return false;
    this.store.write(next);
    return true;
  }

  markRun(id: string, result: {
    sessionId?: string;
    output?: string;
    error?: string;
    iterations?: number;
    toolEventCount?: number;
    trace?: string;
  }): ScheduledTask {
    const current = this.list().find((task) => task.id === id);
    if (!current) throw new Error(`Scheduled task not found: ${id}`);
    const ts = nowIso();
    const nextTask: ScheduledTask = {
      ...current,
      sessionId: result.sessionId ?? current.sessionId,
      lastRunAt: ts,
      lastResult: result.output ?? current.lastResult,
      lastError: result.error,
      lastIterations: result.iterations ?? current.lastIterations,
      lastToolEventCount: result.toolEventCount ?? current.lastToolEventCount,
      lastTrace: result.trace ?? current.lastTrace,
      nextRunAt: current.scheduleType === 'interval' ? computeNextRunAt(current, ts) : ts,
      enabled: current.scheduleType === 'interval' ? current.enabled : false,
      isRunning: false,
      runStartedAt: undefined,
      updatedAt: ts
    };
    const next = this.list().map((task) => (task.id === id ? nextTask : task));
    this.store.write(next);
    return nextTask;
  }

  setRunning(id: string, running: boolean): ScheduledTask {
    const tasks = this.list();
    const current = tasks.find((task) => task.id === id);
    if (!current) throw new Error(`Scheduled task not found: ${id}`);
    const ts = nowIso();
    const nextTask: ScheduledTask = {
      ...current,
      isRunning: running,
      runStartedAt: running ? ts : undefined,
      updatedAt: ts
    };
    const next = tasks.map((task) => (task.id === id ? nextTask : task));
    this.store.write(next);
    return nextTask;
  }
}
