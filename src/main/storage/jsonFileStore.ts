import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './pathUtils.js';

export class JsonFileStore<T> {
  constructor(
    private readonly file: string,
    private readonly fallback: () => T
  ) {}

  read(): T {
    try {
      if (!existsSync(this.file)) return this.fallback();
      const raw = readFileSync(this.file, 'utf8');
      if (!raw.trim()) return this.fallback();
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback();
    }
  }

  write(value: T): void {
    ensureDir(dirname(this.file));
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}
