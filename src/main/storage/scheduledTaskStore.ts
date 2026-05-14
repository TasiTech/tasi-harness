import { join } from 'node:path';
import type { ScheduledTask, ScheduledTaskCreateRequest, ScheduledTaskPatchRequest } from '../../shared/types.js';
import { createId, nowIso } from '../../shared/types.js';
import { JsonFileStore } from './jsonFileStore.js';

type ScheduleFields = Pick<
  ScheduledTask,
  | 'scheduleType'
  | 'runAt'
  | 'intervalMinutes'
  | 'scheduleHour'
  | 'scheduleMinute'
  | 'scheduleWeekday'
  | 'scheduleWeekdays'
  | 'scheduleMonthDay'
  | 'scheduleMonthDays'
>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeNumberList(value: unknown, min: number, max: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Math.trunc(Number(item))).filter((item) => Number.isFinite(item) && item >= min && item <= max))]
    .sort((a, b) => a - b);
}

function taskWeekdays(task: ScheduleFields): number[] {
  const weekdays = normalizeNumberList(task.scheduleWeekdays, 0, 6);
  if (weekdays.length > 0) return weekdays;
  return [clampInt(task.scheduleWeekday, 0, 6, 1)];
}

function taskMonthDays(task: ScheduleFields): number[] {
  const days = normalizeNumberList(task.scheduleMonthDays, 1, 31);
  if (days.length > 0) return days;
  return [clampInt(task.scheduleMonthDay, 1, 31, 1)];
}

function nextDailyRun(task: ScheduleFields, from: Date): Date {
  const hour = clampInt(task.scheduleHour, 0, 23, 9);
  const minute = clampInt(task.scheduleMinute, 0, 59, 0);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function nextWeeklyRun(task: ScheduleFields, from: Date): Date {
  const hour = clampInt(task.scheduleHour, 0, 23, 9);
  const minute = clampInt(task.scheduleMinute, 0, 59, 0);
  return taskWeekdays(task)
    .map((weekday) => {
      const next = new Date(from);
      next.setSeconds(0, 0);
      next.setHours(hour, minute, 0, 0);
      const daysUntil = (weekday - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + daysUntil);
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7);
      return next;
    })
    .sort((a, b) => a.getTime() - b.getTime())[0];
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function nextMonthlyRun(task: ScheduleFields, from: Date): Date {
  const days = taskMonthDays(task);
  const hour = clampInt(task.scheduleHour, 0, 23, 9);
  const minute = clampInt(task.scheduleMinute, 0, 59, 0);
  for (let offset = 0; offset < 36; offset += 1) {
    const year = from.getFullYear();
    const month = from.getMonth() + offset;
    const candidates = days
      .map((day) => {
        const candidate = new Date(year, month, 1, hour, minute, 0, 0);
        if (day > daysInMonth(candidate.getFullYear(), candidate.getMonth())) return null;
        candidate.setDate(day);
        return candidate;
      })
      .filter((candidate): candidate is Date => Boolean(candidate))
      .filter((candidate) => candidate.getTime() > from.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    if (candidates[0]) return candidates[0];
  }
  const fallback = new Date(from);
  fallback.setDate(fallback.getDate() + 1);
  fallback.setSeconds(0, 0);
  return fallback;
}

function computeNextRunAt(task: ScheduleFields, fromIso = nowIso()): string {
  const from = new Date(fromIso);
  if (task.scheduleType === 'interval') {
    const minutes = Math.max(1, Number(task.intervalMinutes) || 60);
    return new Date(Date.parse(fromIso) + minutes * 60_000).toISOString();
  }
  if (task.scheduleType === 'daily') return nextDailyRun(task, from).toISOString();
  if (task.scheduleType === 'weekly') return nextWeeklyRun(task, from).toISOString();
  if (task.scheduleType === 'monthly') return nextMonthlyRun(task, from).toISOString();
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
      scheduleHour: req.scheduleHour,
      scheduleMinute: req.scheduleMinute,
      scheduleWeekday: req.scheduleWeekday,
      scheduleWeekdays: normalizeNumberList(req.scheduleWeekdays, 0, 6),
      scheduleMonthDay: req.scheduleMonthDay,
      scheduleMonthDays: normalizeNumberList(req.scheduleMonthDays, 1, 31),
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
    if (req.scheduleWeekdays !== undefined) nextTask.scheduleWeekdays = normalizeNumberList(req.scheduleWeekdays, 0, 6);
    if (req.scheduleMonthDays !== undefined) nextTask.scheduleMonthDays = normalizeNumberList(req.scheduleMonthDays, 1, 31);
    if (
      req.scheduleType ||
      req.runAt ||
      req.intervalMinutes ||
      req.scheduleHour !== undefined ||
      req.scheduleMinute !== undefined ||
      req.scheduleWeekday !== undefined ||
      req.scheduleWeekdays !== undefined ||
      req.scheduleMonthDay !== undefined ||
      req.scheduleMonthDays !== undefined
    ) {
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
      nextRunAt: current.scheduleType === 'once' ? ts : computeNextRunAt(current, ts),
      enabled: current.scheduleType === 'once' ? false : current.enabled,
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
