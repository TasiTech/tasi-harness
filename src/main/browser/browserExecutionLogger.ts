import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BrowserExecutionLogger {
  constructor(
    private readonly file: string,
    private readonly enabled: () => boolean = () => true
  ) {}

  log(event: string, details: Record<string, unknown> = {}): void {
    if (!this.enabled()) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details
    });
    appendFileSync(this.file, `${line}\n`, 'utf8');
  }
}
