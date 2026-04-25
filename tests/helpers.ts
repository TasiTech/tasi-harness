import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'tasi-harness-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
