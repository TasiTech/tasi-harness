import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTaskStore } from '../src/main/storage/scheduledTaskStore.js';
import { tempHome } from './helpers.js';

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScheduledTaskStore recurring schedules', () => {
  it('creates a daily task at the next requested time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:30:00+08:00'));
    const env = tempHome();
    cleanup = env.cleanup;

    const store = new ScheduledTaskStore(env.home);
    const task = store.create({
      name: 'Daily',
      prompt: 'Run daily',
      scheduleType: 'daily',
      scheduleHour: 9,
      scheduleMinute: 15,
      executionMode: 'sandbox',
      notifyByEmail: false
    });

    expect(task.nextRunAt).toBe(new Date('2026-05-14T09:15:00+08:00').toISOString());
  });

  it('creates a weekly task for the selected weekday and time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:30:00+08:00'));
    const env = tempHome();
    cleanup = env.cleanup;

    const store = new ScheduledTaskStore(env.home);
    const task = store.create({
      name: 'Weekly',
      prompt: 'Run weekly',
      scheduleType: 'weekly',
      scheduleWeekday: 5,
      scheduleHour: 8,
      scheduleMinute: 0,
      executionMode: 'workspace',
      notifyByEmail: false
    });

    expect(task.nextRunAt).toBe(new Date('2026-05-15T08:00:00+08:00').toISOString());
  });

  it('creates a weekly task for the nearest selected weekday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:30:00+08:00'));
    const env = tempHome();
    cleanup = env.cleanup;

    const store = new ScheduledTaskStore(env.home);
    const task = store.create({
      name: 'Weekdays',
      prompt: 'Run on workdays',
      scheduleType: 'weekly',
      scheduleWeekdays: [1, 2, 3, 4, 5],
      scheduleHour: 8,
      scheduleMinute: 0,
      executionMode: 'workspace',
      notifyByEmail: false
    });

    expect(task.nextRunAt).toBe(new Date('2026-05-14T08:00:00+08:00').toISOString());
  });

  it('creates a monthly task for the next valid month day and time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T10:30:00+08:00'));
    const env = tempHome();
    cleanup = env.cleanup;

    const store = new ScheduledTaskStore(env.home);
    const task = store.create({
      name: 'Monthly',
      prompt: 'Run monthly',
      scheduleType: 'monthly',
      scheduleMonthDay: 31,
      scheduleHour: 9,
      scheduleMinute: 0,
      executionMode: 'sandbox',
      notifyByEmail: false
    });

    expect(task.nextRunAt).toBe(new Date('2026-07-31T09:00:00+08:00').toISOString());
  });

  it('creates a monthly task for the nearest selected month day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T10:30:00+08:00'));
    const env = tempHome();
    cleanup = env.cleanup;

    const store = new ScheduledTaskStore(env.home);
    const task = store.create({
      name: 'Month days',
      prompt: 'Run on selected month days',
      scheduleType: 'monthly',
      scheduleMonthDays: [1, 3, 15],
      scheduleHour: 9,
      scheduleMinute: 0,
      executionMode: 'sandbox',
      notifyByEmail: false
    });

    expect(task.nextRunAt).toBe(new Date('2026-05-15T09:00:00+08:00').toISOString());
  });
});
