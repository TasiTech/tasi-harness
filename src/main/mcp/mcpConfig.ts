import { join } from 'node:path';
import { JsonFileStore } from '../storage/jsonFileStore.js';
import { ensureDir } from '../storage/pathUtils.js';

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowedTools?: string[];
}

export class McpConfigStore {
  private readonly store: JsonFileStore<McpServerConfig[]>;

  constructor(harnessHome: string) {
    ensureDir(harnessHome);
    this.store = new JsonFileStore<McpServerConfig[]>(join(harnessHome, 'mcp-servers.json'), () => []);
  }

  list(): McpServerConfig[] {
    return this.store.read();
  }

  upsert(config: McpServerConfig): McpServerConfig[] {
    const next = this.list().filter((item) => item.name !== config.name);
    next.push({ ...config, enabled: config.enabled ?? true });
    this.store.write(next.sort((a, b) => a.name.localeCompare(b.name)));
    return this.list();
  }

  remove(name: string): boolean {
    const before = this.list();
    const after = before.filter((item) => item.name !== name);
    this.store.write(after);
    return after.length !== before.length;
  }
}
