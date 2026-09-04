import { join } from 'node:path';
import type { DshSidecarPluginRecord } from '../../shared/types.js';
import { JsonFileStore } from '../storage/jsonFileStore.js';

interface DshSidecarPluginState {
  version: 1;
  plugins: DshSidecarPluginRecord[];
}

function fallbackState(): DshSidecarPluginState {
  return { version: 1, plugins: [] };
}

function normalizeState(value: DshSidecarPluginState): DshSidecarPluginState {
  return {
    version: 1,
    plugins: Array.isArray(value.plugins) ? value.plugins : []
  };
}

export class DshSidecarStore {
  private readonly store: JsonFileStore<DshSidecarPluginState>;

  constructor(private readonly sidecarHome: string) {
    this.store = new JsonFileStore(join(this.sidecarHome, 'plugins.json'), fallbackState);
  }

  list(): DshSidecarPluginRecord[] {
    return normalizeState(this.store.read()).plugins;
  }

  get(id: string): DshSidecarPluginRecord | undefined {
    return this.find({ id });
  }

  find(match: { id?: string; packageName?: string; source?: string }): DshSidecarPluginRecord | undefined {
    const id = normalizeKey(match.id);
    const packageName = normalizeKey(match.packageName);
    const source = normalizeKey(match.source);
    return this.list().find((plugin) => (
      (id && normalizeKey(plugin.id) === id) ||
      (packageName && normalizeKey(plugin.packageName) === packageName) ||
      (source && normalizeKey(plugin.source) === source)
    ));
  }

  upsert(record: DshSidecarPluginRecord): DshSidecarPluginRecord {
    const state = normalizeState(this.store.read());
    const index = state.plugins.findIndex((plugin) => plugin.id === record.id);
    if (index >= 0) {
      state.plugins[index] = record;
    } else {
      state.plugins.push(record);
    }
    state.plugins.sort((left, right) => left.packageName.localeCompare(right.packageName));
    this.store.write(state);
    return record;
  }

  remove(id: string): boolean {
    return this.removeBy({ id });
  }

  removeBy(match: { id?: string; packageName?: string; source?: string }): boolean {
    const state = normalizeState(this.store.read());
    const id = normalizeKey(match.id);
    const packageName = normalizeKey(match.packageName);
    const source = normalizeKey(match.source);
    const next = state.plugins.filter((plugin) => !(
      (id && normalizeKey(plugin.id) === id) ||
      (packageName && normalizeKey(plugin.packageName) === packageName) ||
      (source && normalizeKey(plugin.source) === source)
    ));
    if (next.length === state.plugins.length) return false;
    this.store.write({ version: 1, plugins: next });
    return true;
  }
}

function normalizeKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}
