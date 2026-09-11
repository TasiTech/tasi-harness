import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import type { AgentLoop } from '../src/main/agent/agentLoop.js';
import type { LiveAgentTask } from '../src/shared/types.js';
import { LiveTaskQueue } from '../src/main/live/liveTaskQueue.js';

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 1000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for task state.'));
      }
    }, 10);
  });
}

describe('LiveTaskQueue', () => {
  it('runs queued tasks through the shared AgentLoop and emits trace updates', async () => {
    const updates: LiveAgentTask[] = [];
    const agentLoop = {
      run: async (options: {
        onMessageDelta?: (sessionId: string, event: { type: 'content' | 'reasoning_content' | 'done'; delta?: string }) => void;
        onToolEvent?: (sessionId: string, event: { toolName: string; ok: boolean; content: string; args: unknown }) => void;
      }) => {
        options.onMessageDelta?.('session_live', { type: 'reasoning_content', delta: 'thinking' });
        options.onToolEvent?.('session_live', { toolName: 'shell', ok: true, content: 'done', args: {} });
        return {
          sessionId: 'session_live',
          finalResponse: 'finished',
          messages: [],
          toolEvents: [],
          iterations: 1,
          execution: { mode: 'workspace', workspaceDir: '' }
        };
      }
    } as unknown as AgentLoop;
    const queue = new LiveTaskQueue({
      agentLoop,
      concurrency: 1,
      defaultExecutionMode: () => 'workspace',
      requestToolApproval: async (_sender, request) => ({ id: request.id, approved: true }),
      onTaskUpdate: (task) => updates.push(task)
    });

    const task = queue.enqueue({ prompt: 'research this' }, {} as WebContents);
    await waitFor(() => updates.some((item) => item.id === task.id && item.status === 'completed'));

    const completed = queue.list().find((item) => item.id === task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toBe('finished');
    expect(completed?.trace.some((entry) => entry.label === 'Reasoning' && entry.content === 'thinking')).toBe(true);
    expect(completed?.trace.some((entry) => entry.label === 'Tool Result' && entry.content === 'done')).toBe(true);
    expect(completed?.trace.some((entry) => entry.label === 'Result' && entry.content === 'finished')).toBe(true);
  });

  it('reuses a recent identical task in the same live session', async () => {
    let runs = 0;
    const agentLoop = {
      run: async () => {
        runs += 1;
        return {
          sessionId: 'session_live',
          finalResponse: 'finished',
          messages: [],
          toolEvents: [],
          iterations: 1,
          execution: { mode: 'workspace', workspaceDir: '' }
        };
      }
    } as unknown as AgentLoop;
    const queue = new LiveTaskQueue({
      agentLoop,
      concurrency: 1,
      defaultExecutionMode: () => 'workspace',
      requestToolApproval: async (_sender, request) => ({ id: request.id, approved: true }),
      onTaskUpdate: () => undefined
    });

    const first = queue.enqueue({ prompt: 'Check Beijing weather', sessionId: 'live_session' }, {} as WebContents);
    const second = queue.enqueue({ prompt: '  check   Beijing weather  ', sessionId: 'live_session' }, {} as WebContents);
    await waitFor(() => queue.list('live_session').some((item) => item.id === first.id && item.status === 'completed'));

    expect(second.id).toBe(first.id);
    expect(queue.list('live_session')).toHaveLength(1);
    expect(runs).toBe(1);
  });
});
