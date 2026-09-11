import { join } from 'node:path';
import type {
  DshSidecarClientMount,
  DshSidecarPluginActionRequest,
  DshSidecarChatRunRequest,
  DshSidecarChatRunResult,
  DshSidecarPluginInstallRequest,
  DshSidecarPluginListResult,
  DshSidecarPluginRecord,
  DshSidecarRuntimeStatus,
  DshSidecarRuntimeSkill,
  DshSidecarToolCallRequest,
  DshSidecarPluginUploadRequest,
  DshSidecarStatus,
  ToolDefinition,
  ToolExecutionResult
} from '../../shared/types.js';
import { ensureDir } from '../storage/pathUtils.js';
import { DshSidecarRpcClient, type DshSidecarMainRequestHandler } from './dshSidecarRpcClient.js';
import { DshSidecarStore } from './dshSidecarStore.js';

const DEFAULT_PROFILE = 'default';

export class DshSidecarManager {
  readonly sidecarHome: string;
  readonly profileName: string;
  private readonly store: DshSidecarStore;
  private readonly rpc: DshSidecarRpcClient;

  constructor(harnessHome: string, profileName = DEFAULT_PROFILE) {
    this.sidecarHome = ensureDir(join(harnessHome, 'dsh-sidecar'));
    this.profileName = profileName;
    this.store = new DshSidecarStore(this.sidecarHome);
    this.rpc = new DshSidecarRpcClient({
      home: this.sidecarHome,
      profileName: this.profileName
    });
  }

  status(): DshSidecarStatus {
    return this.rpc.statusSnapshot();
  }

  setMainRequestHandler(handler?: DshSidecarMainRequestHandler): void {
    this.rpc.setMainRequestHandler(handler);
  }

  async start(): Promise<DshSidecarStatus> {
    await this.rpc.start();
    return await this.rpc.call<DshSidecarStatus>('status');
  }

  async stop(): Promise<DshSidecarStatus> {
    await this.rpc.stop();
    return this.status();
  }

  async list(): Promise<DshSidecarPluginListResult> {
    const status = this.status();
    if (!status.running) return { status, plugins: this.store.list() };
    try {
      return {
        status: await this.rpc.call<DshSidecarStatus>('status'),
        plugins: await this.rpc.call<DshSidecarPluginRecord[]>('plugin.list')
      };
    } catch (error) {
      return {
        status: { ...this.status(), lastError: error instanceof Error ? error.message : String(error) },
        plugins: this.store.list()
      };
    }
  }

  async runtimeStatus(): Promise<DshSidecarRuntimeStatus> {
    return await this.rpc.call<DshSidecarRuntimeStatus>('runtime.status');
  }

  async listClientMounts(): Promise<DshSidecarClientMount[]> {
    return await this.rpc.call<DshSidecarClientMount[]>('client.mounts');
  }

  async runtimeTools(): Promise<ToolDefinition[]> {
    return await this.rpc.call<ToolDefinition[]>('runtime.tools');
  }

  async runtimeSkills(): Promise<DshSidecarRuntimeSkill[]> {
    return await this.rpc.call<DshSidecarRuntimeSkill[]>('runtime.skills');
  }

  async callRuntimeTool(req: DshSidecarToolCallRequest): Promise<ToolExecutionResult> {
    return await this.rpc.call<ToolExecutionResult>('runtime.tool.call', req);
  }

  async chatRun(req: DshSidecarChatRunRequest): Promise<DshSidecarChatRunResult> {
    return await this.rpc.call<DshSidecarChatRunResult>('chat.run', req, req.options?.timeoutMs ?? 10 * 60_000);
  }

  async install(req: DshSidecarPluginInstallRequest): Promise<DshSidecarPluginRecord> {
    const record = await this.rpc.call<DshSidecarPluginRecord>('plugin.install', {
      ...req,
      profileName: req.profileName ?? this.profileName
    }, 10 * 60_000);
    this.store.upsert(record);
    return record;
  }

  async upload(req: DshSidecarPluginUploadRequest): Promise<DshSidecarPluginRecord> {
    const record = await this.rpc.call<DshSidecarPluginRecord>('plugin.upload', {
      ...req,
      profileName: req.profileName ?? this.profileName
    }, 10 * 60_000);
    this.store.upsert(record);
    if (req.enable && record.status !== 'failed' && record.status !== 'incompatible') {
      return await this.enable({ id: record.id, profileName: record.profileName });
    }
    return record;
  }

  async enable(req: DshSidecarPluginActionRequest): Promise<DshSidecarPluginRecord> {
    const record = await this.rpc.call<DshSidecarPluginRecord>('plugin.enable', {
      ...req,
      profileName: req.profileName ?? this.profileName
    });
    this.store.upsert(record);
    return record;
  }

  async disable(req: DshSidecarPluginActionRequest): Promise<DshSidecarPluginRecord> {
    const record = await this.rpc.call<DshSidecarPluginRecord>('plugin.disable', {
      ...req,
      profileName: req.profileName ?? this.profileName
    });
    this.store.upsert(record);
    return record;
  }

  async uninstall(req: DshSidecarPluginActionRequest): Promise<boolean> {
    const ok = await this.rpc.call<boolean>('plugin.uninstall', {
      ...req,
      profileName: req.profileName ?? this.profileName
    }, 10 * 60_000);
    if (ok) this.store.removeBy(req);
    return ok;
  }
}
