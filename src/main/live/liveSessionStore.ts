import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveAgentTask, LiveSessionRelation } from '../../shared/types.js';
import { nowIso } from '../../shared/types.js';
import { ensureDir, safeJoin } from '../storage/pathUtils.js';

export class LiveSessionStore {
  private readonly dir: string;

  constructor(harnessHome: string) {
    this.dir = join(harnessHome, 'live-sessions');
    ensureDir(this.dir);
  }

  create(sessionId: string): LiveSessionRelation {
    const existing = this.read(sessionId);
    if (existing) return existing;
    const ts = nowIso();
    const relation: LiveSessionRelation = {
      sessionId,
      backendSessions: [],
      tasks: [],
      createdAt: ts,
      updatedAt: ts
    };
    this.write(relation);
    return relation;
  }

  read(sessionId: string): LiveSessionRelation | null {
    const file = this.fileFor(sessionId);
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LiveSessionRelation>;
    const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter((task): task is LiveAgentTask => Boolean(task?.id)) : [];
    const backendSessions = Array.isArray(raw.backendSessions) ? raw.backendSessions.filter((link) => Boolean(link?.taskId && link?.backendSessionId)) : [];
    return {
      sessionId,
      backendSessions,
      tasks,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso()
    };
  }

  list(): LiveSessionRelation[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((relation): relation is LiveSessionRelation => Boolean(relation))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertTask(sessionId: string, task: LiveAgentTask): LiveSessionRelation {
    const relation = this.create(sessionId);
    const ts = nowIso();
    const backendSessionId = task.backendSessionId || '';
    const backendSessions = backendSessionId
      ? [
          ...relation.backendSessions.filter((link) => link.taskId !== task.id),
          {
            taskId: task.id,
            backendSessionId,
            createdAt: task.createdAt,
            updatedAt: ts
          }
        ]
      : relation.backendSessions;
    const next: LiveSessionRelation = {
      ...relation,
      backendSessions,
      tasks: [task, ...relation.tasks.filter((item) => item.id !== task.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      updatedAt: ts
    };
    this.write(next);
    return next;
  }

  private write(relation: LiveSessionRelation): void {
    ensureDir(this.dir);
    writeFileSync(this.fileFor(relation.sessionId), `${JSON.stringify(relation, null, 2)}\n`, 'utf8');
  }

  private fileFor(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe) throw new Error('Invalid live session id.');
    return safeJoin(this.dir, `${safe}.json`);
  }
}
