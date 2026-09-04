import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DshSidecarStatus } from '../../shared/types.js';

interface RpcResponse {
  id: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

export type DshSidecarMainRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class DshSidecarRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = '';
  private readonly pending = new Map<string, PendingCall>();
  private lastError = '';
  private mainRequestHandler?: DshSidecarMainRequestHandler;

  constructor(
    private readonly options: {
      home: string;
      profileName: string;
    }
  ) {}

  get running(): boolean {
    return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  statusSnapshot(): DshSidecarStatus {
    const profileDir = `${this.options.home}/profiles/${this.options.profileName}`;
    return {
      available: existsSync(this.scriptPath()),
      running: this.running,
      pid: this.pid,
      protocolVersion: 1,
      home: this.options.home,
      profileName: this.options.profileName,
      profileDir,
      nodeVersion: process.version,
      lastError: this.lastError || undefined
    };
  }

  setMainRequestHandler(handler?: DshSidecarMainRequestHandler): void {
    this.mainRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const script = this.scriptPath();
    if (!existsSync(script)) throw new Error(`DSH sidecar script is missing: ${script}`);
    this.lastError = '';
    this.child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TASI_DSH_SIDECAR_HOME: this.options.home,
        TASI_DSH_PROFILE_NAME: this.options.profileName
      },
      stdio: 'pipe',
      windowsHide: true
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.lastError = `${this.lastError}${chunk}`.slice(-4000);
    });
    this.child.on('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.rejectAll(new Error(`DSH sidecar exited with ${suffix}.`));
      this.child = undefined;
    });
    await this.call('status', undefined, 10_000);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.call('shutdown', undefined, 5000);
    } catch {
      // The process may exit before it can send the shutdown acknowledgement.
    }
    this.child?.kill();
    this.child = undefined;
  }

  async call<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    await this.ensureStartedForCall(method);
    const child = this.child;
    if (!child) throw new Error('DSH sidecar is not running.');
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params });
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH sidecar request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      child.stdin.write(`${payload}\n`, 'utf8', (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private async ensureStartedForCall(method: string): Promise<void> {
    if (this.running) return;
    if (method === 'shutdown') return;
    await this.start();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      this.lastError = `Invalid sidecar JSON: ${line}`;
      return;
    }
    if (typeof response.method === 'string') {
      void this.handleSidecarRequest(response.id, response.method, response.params);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleSidecarRequest(id: string, method: string, params: unknown): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    const send = (payload: { result?: unknown; error?: { message: string } }) => {
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, 'utf8');
    };
    try {
      if (!this.mainRequestHandler) throw new Error(`No main request handler registered for DSH sidecar method: ${method}`);
      send({ result: await this.mainRequestHandler(method, params) });
    } catch (error) {
      send({ error: { message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scriptPath(): string {
    return fileURLToPath(new URL('./dshSidecarProcess.js', import.meta.url));
  }
}
