import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AppConfig, ToolExecutionResult } from '../../shared/types.js';
import type { BrowserExecutionLogger } from './browserExecutionLogger.js';

type ExternalRuntimeEngine = 'cdp' | 'webdriver-safari';

interface CdpVersionPayload {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpConnectionInfo {
  endpoint: string;
  browserName: string;
  browserWsUrl: string;
}

interface WebDriverSessionCreated {
  sessionId: string;
}

interface ExternalBrowserBridgeOptions {
  runtimeDir?: string;
  strictCdpEndpoint?: boolean;
  logger?: BrowserExecutionLogger;
}

interface CdpLaunchProfile {
  mode: 'isolated' | 'system';
  userDataDir: string;
  profileDir?: string;
  autoLaunchState?: string;
}

function withScheme(url: string, fallbackScheme: 'http' | 'ws'): string {
  const value = url.trim();
  if (!value) return fallbackScheme === 'http' ? 'http://127.0.0.1:9222' : '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value.replace(/\/+$/, '');
  return `${fallbackScheme}://${value}`.replace(/\/+$/, '');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMessageData(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data ?? '');
}

export class ExternalBrowserBridge {
  private readonly logPrefix = '[browser][external]';
  private readonly logVersion = 'v2-auto-launch';
  private readonly runtimeDir: string;
  private readonly strictCdpEndpoint: boolean;
  private readonly logger?: BrowserExecutionLogger;
  private cdpOpenedTargetIds = new Set<string>();
  private cdpEndpoint = '';
  private cdpBrowserName = '';
  private cdpMessageId = 0;
  private cdpManagedProcess: ChildProcess | null = null;
  private cdpManagedEndpoint = '';
  private cdpManagedBrowser = '';
  private cdpManagedProfileDir = '';
  private cdpAutoLaunchState = 'idle';
  private cdpLaunchCooldownUntil = 0;
  private cdpLastLaunchFailureState = '';

  private safariProcess: ChildProcess | null = null;
  private safariPort: number | null = null;
  private safariSessionId: string | null = null;
  private safariAvailability: 'unknown' | 'available' | 'unavailable' = 'unknown';

  constructor(options: ExternalBrowserBridgeOptions = {}) {
    this.runtimeDir = options.runtimeDir?.trim() || join(tmpdir(), 'tasi-harness', 'external-browser');
    this.strictCdpEndpoint = options.strictCdpEndpoint === true;
    this.logger = options.logger;
    this.log('bridge.init', { runtimeDir: this.runtimeDir, strictCdpEndpoint: this.strictCdpEndpoint });
  }

  activeCdpTargetId(): string | null {
    const ids = [...this.cdpOpenedTargetIds];
    return ids.length > 0 ? ids[ids.length - 1] : null;
  }

  cdpEndpointHint(config: AppConfig): string {
    return this.cdpEndpoint || this.cdpManagedEndpoint || config.externalBrowserCdpEndpoint || 'http://127.0.0.1:9222';
  }

  async open(url: string, config: AppConfig): Promise<ToolExecutionResult> {
    if (!url.trim()) return { ok: false, content: 'No external URL provided.' };
    const attempts = this.resolveEngineAttempts(config);
    this.log('bridge.open.start', {
      url,
      engine: config.externalBrowserEngine,
      requestedEndpoint: config.externalBrowserCdpEndpoint,
      profileMode: config.externalBrowserProfileMode,
      headless: config.browserHeadless,
      attempts
    });
    console.info(`${this.logPrefix} ${this.logVersion} open start url=${url} engine=${config.externalBrowserEngine} attempts=${attempts.join('->')}`);
    const errors: string[] = [];
    for (const engine of attempts) {
      try {
        console.info(`${this.logPrefix} trying engine=${engine} url=${url}`);
        const result = engine === 'cdp' ? await this.openViaCdp(url, config) : await this.openViaSafariWebDriver(url);
        if (result.ok) {
          this.log('bridge.open.done', { url, engine, ok: true });
          return result;
        }
        console.warn(`${this.logPrefix} engine=${engine} reported failure: ${result.content}`);
        errors.push(`[${engine}] ${result.content}`);
      } catch (error) {
        const message = formatError(error);
        console.warn(`${this.logPrefix} ${engine} open failed: ${message}`);
        errors.push(`[${engine}] ${message}`);
      }
    }
    console.warn(`${this.logPrefix} no managed engine succeeded for ${url}: ${errors.join(' | ')}`);
    this.log('bridge.open.done', { url, ok: false, errors });
    return { ok: false, content: `No external engine succeeded: ${errors.join(' | ')}` };
  }

  async close(): Promise<ToolExecutionResult> {
    this.log('bridge.close.start', {
      cdpTargets: this.cdpOpenedTargetIds.size,
      managedEndpoint: this.cdpManagedEndpoint,
      managedProfileDir: this.cdpManagedProfileDir,
      safariSessionId: this.safariSessionId
    });
    const parts: string[] = [];
    const cdpClosed = await this.closeCdpTargets();
    if (cdpClosed > 0) parts.push(`closed ${cdpClosed} CDP target(s)`);
    const cdpStopped = this.stopManagedCdpBrowser();
    if (cdpStopped) parts.push('stopped managed CDP browser process');
    const safariClosed = await this.closeSafariSession();
    if (safariClosed) parts.push('closed Safari WebDriver session');
    if (parts.length === 0) {
      console.debug(`${this.logPrefix} close requested: no managed session active.`);
      return { ok: true, content: 'No managed external browser session was active.' };
    }
    const content = parts.join(' and ') + '.';
    console.info(`${this.logPrefix} close completed: ${content}`);
    this.log('bridge.close.done', { content });
    return { ok: true, content };
  }

  private resolveEngineAttempts(config: AppConfig): ExternalRuntimeEngine[] {
    if (config.externalBrowserEngine === 'cdp') return ['cdp'];
    if (config.externalBrowserEngine === 'webdriver-safari') return ['webdriver-safari'];
    const attempts: ExternalRuntimeEngine[] = ['cdp'];
    if (process.platform === 'darwin') attempts.push('webdriver-safari');
    return attempts;
  }

  private async openViaCdp(url: string, config: AppConfig): Promise<ToolExecutionResult> {
    const connection = await this.resolveCdpConnectionWithAutoDetect(config, config.externalBrowserCdpEndpoint, true);
    this.log('cdp.open.resolved', {
      url,
      endpoint: connection.endpoint,
      browserName: connection.browserName,
      browserWsUrlPresent: Boolean(connection.browserWsUrl)
    });
    const result = await this.sendCdpCommand(connection.browserWsUrl, 'Target.createTarget', {
      url,
      background: false
    });
    const targetId = typeof result?.targetId === 'string' ? result.targetId : '';
    if (!targetId) return { ok: false, content: 'CDP did not return a target id.' };
    await this.sendCdpCommand(connection.browserWsUrl, 'Target.activateTarget', { targetId }).catch((error) => {
      console.warn(`${this.logPrefix} failed to activate CDP target ${targetId}: ${formatError(error)}`);
    });
    this.cdpOpenedTargetIds.add(targetId);
    this.cdpEndpoint = connection.endpoint;
    this.cdpBrowserName = connection.browserName;
    console.info(`${this.logPrefix} engine=cdp browser=${connection.browserName} endpoint=${connection.endpoint} target=${targetId}`);
    this.log('cdp.open.target', { url, endpoint: connection.endpoint, browserName: connection.browserName, targetId });
    return {
      ok: true,
      content: `Opened ${url} via CDP (${connection.browserName}) and tracked target ${targetId} for auto-close.`
    };
  }

  private async resolveCdpConnectionWithAutoDetect(config: AppConfig, rawEndpoint: string, autoDetect: boolean): Promise<CdpConnectionInfo> {
    const probeWithAutoCandidates = autoDetect && config.externalBrowserProfileMode !== 'system';
    this.log('cdp.resolve.start', {
      rawEndpoint,
      autoDetect,
      probeWithAutoCandidates,
      profileMode: config.externalBrowserProfileMode,
      strictCdpEndpoint: this.strictCdpEndpoint
    });
    const first = await this.tryResolveCdpConnection(rawEndpoint, probeWithAutoCandidates);
    if (first.connection) {
      this.log('cdp.resolve.done', { endpoint: first.connection.endpoint, browserName: first.connection.browserName, via: 'existing' });
      return first.connection;
    }
    if (!autoDetect) {
      throw new Error(`CDP endpoint probe failed: ${first.errors.join(' | ')}`);
    }

    const started = await this.ensureManagedCdpBrowser(config, rawEndpoint, first.errors);
    if (!started) {
      throw new Error(`CDP endpoint probe failed: ${first.errors.join(' | ')} | auto-launch=${this.cdpAutoLaunchState}`);
    }

    const secondEndpoint = this.cdpManagedEndpoint || rawEndpoint;
    const second = await this.tryResolveCdpConnection(secondEndpoint, probeWithAutoCandidates || Boolean(this.cdpManagedEndpoint));
    if (second.connection) {
      this.log('cdp.resolve.done', { endpoint: second.connection.endpoint, browserName: second.connection.browserName, via: 'auto-launch' });
      return second.connection;
    }
    throw new Error(`CDP endpoint probe failed after auto-launch: ${[...first.errors, ...second.errors].join(' | ')}`);
  }

  private resolveCdpEndpointCandidates(rawEndpoint: string, autoDetect: boolean): string[] {
    const primary = withScheme(rawEndpoint, 'http');
    if (!autoDetect) return [primary];
    if (this.strictCdpEndpoint) {
      const list = [primary, this.cdpManagedEndpoint].filter((item): item is string => Boolean(item));
      return [...new Set(list.map((item) => withScheme(item, 'http')))];
    }
    const defaults = ['http://127.0.0.1:9222', 'http://127.0.0.1:9223', 'http://127.0.0.1:9333', 'http://localhost:9222'];
    if (this.cdpManagedEndpoint) defaults.unshift(this.cdpManagedEndpoint);
    const list = [primary, ...defaults];
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of list) {
      const normalized = withScheme(item, 'http');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(normalized);
    }
    return unique;
  }

  private async tryResolveCdpConnection(
    rawEndpoint: string,
    autoDetect: boolean
  ): Promise<{ connection: CdpConnectionInfo | null; errors: string[] }> {
    const candidates = this.resolveCdpEndpointCandidates(rawEndpoint, autoDetect);
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const connection = await this.resolveCdpConnection(candidate);
        if (candidate !== rawEndpoint) {
          console.info(`${this.logPrefix} CDP endpoint selected=${connection.endpoint} (requested=${rawEndpoint || 'default'})`);
        }
        return { connection, errors };
      } catch (error) {
        const message = formatError(error);
        errors.push(`${candidate}: ${message}`);
      }
    }
    return { connection: null, errors };
  }

  private async ensureManagedCdpBrowser(config: AppConfig, rawEndpoint: string, priorErrors: string[]): Promise<boolean> {
    const now = Date.now();
    if (this.cdpLaunchCooldownUntil > now) {
      const remaining = Math.max(1, Math.ceil((this.cdpLaunchCooldownUntil - now) / 1000));
      this.cdpAutoLaunchState = `cooldown:${remaining}s:${this.cdpLastLaunchFailureState || 'previous-failure'}`;
      return false;
    }
    if (this.cdpManagedProcess && this.cdpManagedEndpoint) {
      const ready = await this.waitForCdpEndpoint(this.cdpManagedEndpoint, 1000);
      if (ready) {
        this.cdpAutoLaunchState = `reused-existing@${this.cdpManagedEndpoint}`;
        return true;
      }
      this.stopManagedCdpBrowser();
    }
    const executable = this.detectSystemChromiumExecutable();
    if (!executable) {
      this.cdpAutoLaunchState = 'skipped:no-chromium-executable';
      this.cdpLastLaunchFailureState = this.cdpAutoLaunchState;
      this.cdpLaunchCooldownUntil = Date.now() + 10000;
      console.warn(`${this.logPrefix} CDP auto-launch skipped: no local Chromium/Chrome/Edge executable found.`);
      this.log('cdp.launch.skipped', { reason: 'no-chromium-executable', priorErrors });
      return false;
    }
    let skipSystemProfileLaunch = false;
    if (config.externalBrowserProfileMode === 'system' && this.isBrowserProcessLikelyRunning(executable)) {
      this.log('cdp.launch.systemProfileInUse', { executable });
      const takeoverOk = this.forceTakeoverSystemProfile(executable);
      if (!takeoverOk) {
        skipSystemProfileLaunch = true;
        this.cdpAutoLaunchState = `system-profile-in-use:fallback-isolated@${executable}`;
        this.log('cdp.launch.systemProfileFallback', {
          executable,
          reason: 'system-profile-force-close-failed'
        });
      }
    }
    const attempts = this.resolveCdpLaunchAttempts(config, executable, rawEndpoint, skipSystemProfileLaunch);
    mkdirSync(this.runtimeDir, { recursive: true });
    for (const attempt of attempts) {
      const { port, launchProfile } = attempt;
      const endpoint = `http://127.0.0.1:${port}`;
      mkdirSync(launchProfile.userDataDir, { recursive: true });
      const args = [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        ...(config.browserHeadless ? ['--headless=new', '--disable-gpu'] : []),
        `--user-data-dir=${launchProfile.userDataDir}`,
        ...(launchProfile.profileDir ? [`--profile-directory=${launchProfile.profileDir}`] : []),
        ...(launchProfile.mode === 'isolated' ? ['--disable-sync', '--disable-features=msEdgeSigninPrompt'] : [])
      ];
      if (launchProfile.autoLaunchState) this.cdpAutoLaunchState = launchProfile.autoLaunchState;
      console.info(
        `${this.logPrefix} launching managed CDP browser executable=${executable} port=${port} profile=${launchProfile.userDataDir} mode=${launchProfile.mode} after probe errors=${priorErrors.join(' | ')}`
      );
      this.log('cdp.launch.start', {
        executable,
        port,
        endpoint,
        mode: launchProfile.mode,
        userDataDir: launchProfile.userDataDir,
        profileDir: launchProfile.profileDir,
        headless: config.browserHeadless,
        priorErrors
      });
      const child = spawn(executable, args, { stdio: 'ignore' });
      let exited = false;
      child.once('exit', () => {
        exited = true;
        if (this.cdpManagedProcess?.pid === child.pid) {
          this.cdpManagedProcess = null;
          this.cdpManagedEndpoint = '';
          this.cdpManagedBrowser = '';
          this.cdpManagedProfileDir = '';
        }
      });
      const ready = await this.waitForCdpEndpoint(endpoint, 5000);
      if (ready) {
        this.cdpManagedProcess = child;
        this.cdpManagedEndpoint = endpoint;
        this.cdpManagedBrowser = executable;
        this.cdpManagedProfileDir = launchProfile.userDataDir;
        this.cdpAutoLaunchState = `ready:${executable}@${endpoint}`;
        this.cdpLastLaunchFailureState = '';
        this.cdpLaunchCooldownUntil = 0;
        console.info(`${this.logPrefix} managed CDP browser ready executable=${executable} endpoint=${endpoint}`);
        this.log('cdp.launch.ready', {
          executable,
          endpoint,
          mode: launchProfile.mode,
          userDataDir: launchProfile.userDataDir,
          profileDir: launchProfile.profileDir,
          pid: child.pid
        });
        return true;
      }
      if (!exited) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore child cleanup errors for failed startup attempts.
        }
      }
      if (launchProfile.mode === 'system') {
        this.cdpAutoLaunchState = `system-launch-failed:fallback-isolated@${executable}`;
        this.log('cdp.launch.systemProfileFallback', {
          executable,
          endpoint,
          reason: 'system-profile-cdp-timeout'
        });
      }
    }
    const requestedMode = config.externalBrowserProfileMode;
    this.cdpAutoLaunchState = `failed:${requestedMode}${requestedMode === 'system' ? '+isolated' : ''}@${executable}`;
    this.cdpLastLaunchFailureState = this.cdpAutoLaunchState;
    this.cdpLaunchCooldownUntil = Date.now() + (requestedMode === 'system' ? 20000 : 8000);
    console.warn(`${this.logPrefix} managed CDP browser launch failed for executable=${executable}.`);
    this.log('cdp.launch.failed', { executable, requestedMode, state: this.cdpAutoLaunchState });
    return false;
  }

  private resolveCdpAutoLaunchPorts(rawEndpoint: string, singlePort = false): number[] {
    const fromCandidates = this.resolveCdpEndpointCandidates(rawEndpoint, true)
      .map((endpoint) => this.tryParseEndpointPort(endpoint))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const defaults = [9222, 9223, 9333, 9444];
    const ports = [...fromCandidates, ...defaults];
    const seen = new Set<number>();
    const unique: number[] = [];
    for (const port of ports) {
      if (seen.has(port)) continue;
      seen.add(port);
      unique.push(port);
    }
    if (singlePort) return unique.slice(0, 1);
    return unique;
  }

  private resolveCdpLaunchAttempts(
    config: AppConfig,
    executable: string,
    rawEndpoint: string,
    skipSystemProfileLaunch: boolean
  ): Array<{ port: number; launchProfile: CdpLaunchProfile }> {
    const allPorts = this.resolveCdpAutoLaunchPorts(rawEndpoint, false);
    if (config.externalBrowserProfileMode !== 'system') {
      return allPorts.map((port) => ({ port, launchProfile: this.resolveCdpLaunchProfile(config, executable, port) }));
    }

    const attempts: Array<{ port: number; launchProfile: CdpLaunchProfile }> = [];
    const primaryPort = this.resolveCdpAutoLaunchPorts(rawEndpoint, true)[0] ?? 9222;
    if (!skipSystemProfileLaunch) {
      attempts.push({ port: primaryPort, launchProfile: this.resolveCdpLaunchProfile(config, executable, primaryPort) });
    }

    for (const port of allPorts) {
      attempts.push({
        port,
        launchProfile: {
          mode: 'isolated',
          userDataDir: join(this.runtimeDir, `cdp-profile-${port}`),
          autoLaunchState: `fallback-isolated@${executable}`
        }
      });
    }

    const seen = new Set<string>();
    return attempts.filter((attempt) => {
      const key = `${attempt.launchProfile.mode}:${attempt.port}:${attempt.launchProfile.userDataDir}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private resolveCdpLaunchProfile(config: AppConfig, executable: string, port: number): CdpLaunchProfile {
    if (config.externalBrowserProfileMode !== 'system') {
      const userDataDir = join(this.runtimeDir, `cdp-profile-${port}`);
      return { mode: 'isolated', userDataDir };
    }

    const systemUserDataDir = this.resolveSystemUserDataDirForExecutable(executable);
    if (systemUserDataDir) {
      return { mode: 'system', userDataDir: systemUserDataDir, profileDir: 'Default' };
    }

    const fallbackDir = join(this.runtimeDir, `cdp-profile-${port}`);
    return {
      mode: 'isolated',
      userDataDir: fallbackDir,
      autoLaunchState: `system-profile-unresolved:fallback-isolated@${executable}`
    };
  }

  private resolveSystemUserDataDirForExecutable(executable: string): string | null {
    const exe = executable.toLowerCase();
    const localAppData = process.env.LOCALAPPDATA || '';
    const home = homedir();

    if (process.platform === 'win32') {
      if (exe.includes('msedge')) {
        const dir = join(localAppData, 'Microsoft', 'Edge', 'User Data');
        return existsSync(dir) ? dir : null;
      }
      if (exe.includes('chrome')) {
        const dir = join(localAppData, 'Google', 'Chrome', 'User Data');
        return existsSync(dir) ? dir : null;
      }
      if (exe.includes('chromium')) {
        const dir = join(localAppData, 'Chromium', 'User Data');
        return existsSync(dir) ? dir : null;
      }
    }

    if (process.platform === 'darwin') {
      if (exe.includes('microsoft edge')) {
        const dir = join(home, 'Library', 'Application Support', 'Microsoft Edge');
        return existsSync(dir) ? dir : null;
      }
      if (exe.includes('google chrome')) {
        const dir = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
        return existsSync(dir) ? dir : null;
      }
      if (exe.includes('chromium')) {
        const dir = join(home, 'Library', 'Application Support', 'Chromium');
        return existsSync(dir) ? dir : null;
      }
    }

    if (process.platform === 'linux') {
      if (exe.includes('google-chrome') || exe.includes('chrome')) {
        const dir = join(home, '.config', 'google-chrome');
        return existsSync(dir) ? dir : null;
      }
      if (exe.includes('chromium')) {
        const dir = join(home, '.config', 'chromium');
        return existsSync(dir) ? dir : null;
      }
    }

    return null;
  }

  private tryParseEndpointPort(endpoint: string): number | null {
    try {
      const parsed = new URL(withScheme(endpoint, 'http'));
      if (!/^https?:$/i.test(parsed.protocol)) return null;
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      return Number.isFinite(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  }

  private async waitForCdpEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        await this.resolveCdpConnection(endpoint);
        return true;
      } catch {
        // Continue polling until timeout.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  private stopManagedCdpBrowser(): boolean {
    const child = this.cdpManagedProcess;
    if (!child) return false;
    const browser = this.cdpManagedBrowser || 'chromium';
    const endpoint = this.cdpManagedEndpoint || 'unknown';
    const profileDir = this.cdpManagedProfileDir || 'unknown';
    this.cdpManagedProcess = null;
    this.cdpManagedEndpoint = '';
    this.cdpManagedBrowser = '';
    this.cdpManagedProfileDir = '';
    console.info(`${this.logPrefix} stopping managed CDP browser executable=${browser} endpoint=${endpoint} profile=${profileDir}`);
    this.log('cdp.launch.stop', { browser, endpoint, profileDir });
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore termination errors during bridge shutdown.
    }
    return true;
  }

  private detectSystemChromiumExecutable(): string | null {
    const envPath = process.env.CHROME_PATH?.trim();
    if (envPath && existsSync(envPath)) return envPath;
    const platformCandidates =
      process.platform === 'win32'
        ? this.windowsChromiumCandidates()
        : process.platform === 'darwin'
          ? [
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
              '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
              '/Applications/Chromium.app/Contents/MacOS/Chromium'
            ]
          : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'];
    for (const candidate of platformCandidates) {
      if (candidate && existsSync(candidate)) {
        this.log('cdp.executable.detected', { executable: candidate, source: 'well-known-path' });
        return candidate;
      }
    }
    if (process.platform === 'win32') {
      const fromRegistry = this.lookupWindowsExecutableFromRegistry(['msedge.exe', 'chrome.exe']);
      if (fromRegistry) return fromRegistry;
    }
    const pathLookup = process.platform === 'win32'
      ? this.lookupExecutableFromPath(['msedge.exe', 'chrome.exe', 'chromium.exe'], 'where')
      : this.lookupExecutableFromPath(['google-chrome', 'chromium-browser', 'chromium'], 'which');
    if (pathLookup) {
      this.log('cdp.executable.detected', { executable: pathLookup, source: 'path' });
      return pathLookup;
    }
    return null;
  }

  private windowsChromiumCandidates(): string[] {
    const programFiles = process.env.PROGRAMFILES || '';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
  }

  private lookupExecutableFromPath(candidates: string[], command: 'where' | 'which'): string | null {
    for (const candidate of candidates) {
      const probe = spawnSync(command, [candidate], { encoding: 'utf8' });
      if (probe.status !== 0) continue;
      const lines = String(probe.stdout || '')
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
      const found = lines.find((line) => existsSync(line));
      if (found) return found;
    }
    return null;
  }

  private lookupWindowsExecutableFromRegistry(executables: string[]): string | null {
    const hives = ['HKLM', 'HKCU'];
    for (const executable of executables) {
      for (const hive of hives) {
        const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`;
        const probe = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
        if (probe.status !== 0) continue;
        const lines = String(probe.stdout || '')
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (!line.includes('REG_SZ')) continue;
          const value = line.slice(line.indexOf('REG_SZ') + 'REG_SZ'.length).trim().replace(/^"|"$/g, '');
          if (value && existsSync(value)) return value;
        }
      }
    }
    return null;
  }

  private isBrowserProcessLikelyRunning(executable: string): boolean {
    const image = basename(executable).trim();
    if (!image) return false;
    try {
      if (process.platform === 'win32') {
        const probe = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        if (probe.status !== 0) return false;
        const output = String(probe.stdout || '').toLowerCase();
        if (!output || output.includes('no tasks are running')) return false;
        const token = image.toLowerCase().replace(/\.exe$/i, '');
        return output.includes(token);
      }
      const probe = spawnSync('pgrep', ['-f', image], { encoding: 'utf8' });
      return probe.status === 0 && String(probe.stdout || '').trim().length > 0;
    } catch {
      return false;
    }
  }

  private forceTakeoverSystemProfile(executable: string): boolean {
    const image = basename(executable).trim();
    if (!image) return false;
    console.warn(`${this.logPrefix} system profile is in use by ${image}; forcing takeover by terminating existing browser processes.`);
    this.log('cdp.systemProfile.takeover.start', { executable, image });
    try {
      if (process.platform === 'win32') {
        const stop = spawnSync('taskkill', ['/IM', image, '/F', '/T'], { encoding: 'utf8' });
        if (stop.status !== 0) {
          const detail = String(stop.stderr || stop.stdout || '').trim() || `exit=${stop.status}`;
          console.warn(`${this.logPrefix} taskkill failed for ${image}: ${detail}`);
        }
      } else if (process.platform === 'darwin') {
        spawnSync('pkill', ['-f', image.replace(/\.exe$/i, '')], { encoding: 'utf8' });
      } else {
        spawnSync('pkill', ['-f', image.replace(/\.exe$/i, '')], { encoding: 'utf8' });
      }
    } catch (error) {
      console.warn(`${this.logPrefix} failed to terminate ${image}: ${formatError(error)}`);
    }

    const stillRunning = this.isBrowserProcessLikelyRunning(executable);
    if (stillRunning) {
      console.warn(`${this.logPrefix} takeover failed; ${image} is still running and locks system profile.`);
      this.log('cdp.systemProfile.takeover.done', { executable, image, ok: false });
      return false;
    }
    console.info(`${this.logPrefix} takeover succeeded; ${image} processes were stopped.`);
    this.log('cdp.systemProfile.takeover.done', { executable, image, ok: true });
    return true;
  }

  private async closeCdpTargets(): Promise<number> {
    const ids = [...this.cdpOpenedTargetIds];
    if (ids.length === 0) return 0;
    const endpoint = this.cdpEndpoint || 'http://127.0.0.1:9222';
    try {
      const connection = await this.resolveCdpConnection(endpoint);
      let closed = 0;
      for (const targetId of ids) {
        try {
          await this.sendCdpCommand(connection.browserWsUrl, 'Target.closeTarget', { targetId });
          closed += 1;
        } catch (error) {
          console.warn(`${this.logPrefix} failed to close CDP target ${targetId}: ${formatError(error)}`);
        }
      }
      this.cdpOpenedTargetIds.clear();
      return closed;
    } catch (error) {
      console.warn(`${this.logPrefix} failed to reconnect CDP for close: ${formatError(error)}`);
      this.cdpOpenedTargetIds.clear();
      return 0;
    }
  }

  private async resolveCdpConnection(rawEndpoint: string): Promise<CdpConnectionInfo> {
    const endpoint = withScheme(rawEndpoint, 'http');
    if (/^wss?:\/\//i.test(endpoint)) {
      return {
        endpoint,
        browserName: this.cdpBrowserName || 'CDP browser',
        browserWsUrl: endpoint
      };
    }
    const versionUrl = endpoint.endsWith('/json/version') ? endpoint : `${endpoint}/json/version`;
    const response = await fetch(versionUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`CDP version endpoint unavailable (${response.status}) at ${versionUrl}`);
    }
    const json = (await response.json()) as CdpVersionPayload;
    const ws = (json.webSocketDebuggerUrl || '').trim();
    if (!ws) {
      throw new Error(`CDP endpoint ${versionUrl} did not return webSocketDebuggerUrl.`);
    }
    const browserName = (json.Browser || 'Chromium-family browser').trim();
    this.log('cdp.version', {
      endpoint,
      browserName,
      webSocketDebuggerUrlPresent: Boolean(ws)
    });
    return {
      endpoint,
      browserName,
      browserWsUrl: ws
    };
  }

  private async sendCdpCommand(wsUrl: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.cdpMessageId;
      const started = Date.now();
      this.log('cdp.command.start', { id, method, params: this.sanitizeCdpParams(method, params) });
      let settled = false;
      const ws = new WebSocket(withScheme(wsUrl, 'ws'));
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore socket close errors during failure handling.
        }
        this.log('cdp.command.done', { id, method, ok: false, durationMs: Date.now() - started, message });
        reject(new Error(message));
      };
      const done = (result: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Ignore socket close errors during success handling.
        }
        this.log('cdp.command.done', { id, method, ok: true, durationMs: Date.now() - started, result: this.sanitizeCdpResult(method, result) });
        resolve(result);
      };

      const timeout = setTimeout(() => fail(`CDP timeout for ${method} on ${wsUrl}`), 5000);
      ws.addEventListener('open', () => {
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timeout);
          fail(`CDP send failed: ${formatError(error)}`);
        }
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timeout);
        fail(`CDP socket error: ${String((event as unknown as { message?: string }).message || 'unknown')}`);
      });
      ws.addEventListener('message', (event) => {
        void (async () => {
          const text = await readMessageData((event as MessageEvent).data);
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(text) as Record<string, unknown>;
          } catch {
            return;
          }
          if (payload.id !== id) return;
          clearTimeout(timeout);
          if (payload.error) {
            const error = payload.error as { message?: string } | undefined;
            fail(error?.message ? `CDP ${method} failed: ${error.message}` : `CDP ${method} failed.`);
            return;
          }
          done((payload.result as Record<string, unknown>) || {});
        })();
      });
      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (!settled) fail(`CDP socket closed before response for ${method}.`);
      });
    });
  }

  private log(event: string, details: Record<string, unknown> = {}): void {
    this.logger?.log(event, details);
  }

  private sanitizeCdpParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (method === 'Network.setCookie') return { ...params, value: params.value ? '[redacted]' : params.value };
    return params;
  }

  private sanitizeCdpResult(method: string, result: Record<string, unknown>): Record<string, unknown> {
    if (method === 'Network.getCookies') {
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      return {
        cookieCount: cookies.length,
        cookieNames: cookies.map((cookie: any) => ({
          name: typeof cookie?.name === 'string' ? cookie.name : '',
          domain: typeof cookie?.domain === 'string' ? cookie.domain : '',
          session: Boolean(cookie?.session)
        }))
      };
    }
    if (method === 'Runtime.evaluate') return { resultType: (result.result as any)?.type, hasExceptionDetails: Boolean(result.exceptionDetails) };
    if (method === 'Page.captureScreenshot' || method === 'Page.printToPDF') return { data: result.data ? '[base64]' : undefined };
    return result;
  }

  private async openViaSafariWebDriver(url: string): Promise<ToolExecutionResult> {
    if (process.platform !== 'darwin') {
      return { ok: false, content: 'Safari WebDriver is only available on macOS.' };
    }
    if (!(await this.ensureSafariDriverAvailable())) {
      return { ok: false, content: 'safaridriver is unavailable. Enable it with `safaridriver --enable`.' };
    }
    await this.ensureSafariServer();
    const session = await this.ensureSafariSession();
    await this.requestWebDriver('POST', `/session/${session.sessionId}/url`, { url });
    console.info(`${this.logPrefix} engine=webdriver-safari port=${this.safariPort} session=${session.sessionId}`);
    return {
      ok: true,
      content: `Opened ${url} via Safari WebDriver session ${session.sessionId}.`
    };
  }

  private async ensureSafariDriverAvailable(): Promise<boolean> {
    if (this.safariAvailability === 'available') return true;
    if (this.safariAvailability === 'unavailable') return false;
    const probe = spawnSync('safaridriver', ['--version'], { stdio: 'ignore' });
    this.safariAvailability = probe.status === 0 ? 'available' : 'unavailable';
    return this.safariAvailability === 'available';
  }

  private async ensureSafariServer(): Promise<void> {
    if (this.safariProcess && this.safariPort && (await this.isSafariServerReady(this.safariPort))) return;
    await this.closeSafariSession();
    const candidatePorts = [5555, 5556, 5557, 5558];
    for (const port of candidatePorts) {
      const child = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore' });
      this.safariProcess = child;
      this.safariPort = port;
      child.once('exit', () => {
        if (this.safariProcess?.pid === child.pid) this.safariProcess = null;
        if (this.safariPort === port) this.safariPort = null;
        this.safariSessionId = null;
      });
      if (await this.waitForSafariServerReady(port, 3000)) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore process kill errors for failed startup attempts.
      }
      this.safariProcess = null;
      this.safariPort = null;
    }
    throw new Error('Unable to start safaridriver on available local ports.');
  }

  private async ensureSafariSession(): Promise<WebDriverSessionCreated> {
    if (this.safariSessionId) return { sessionId: this.safariSessionId };
    const payload = {
      capabilities: {
        alwaysMatch: {
          browserName: 'safari'
        },
        firstMatch: [{}]
      }
    };
    const response = await this.requestWebDriver('POST', '/session', payload);
    const sessionId = response?.value?.sessionId || response?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      const message = response?.value?.message || 'Safari WebDriver did not return a session id.';
      throw new Error(String(message));
    }
    this.safariSessionId = sessionId;
    return { sessionId };
  }

  private async closeSafariSession(): Promise<boolean> {
    let closed = false;
    if (this.safariSessionId) {
      try {
        await this.requestWebDriver('DELETE', `/session/${this.safariSessionId}`);
        closed = true;
      } catch (error) {
        console.warn(`${this.logPrefix} failed to delete Safari WebDriver session ${this.safariSessionId}: ${formatError(error)}`);
      }
    }
    this.safariSessionId = null;
    if (this.safariProcess) {
      try {
        this.safariProcess.kill('SIGTERM');
      } catch {
        // Ignore safaridriver shutdown errors.
      }
      this.safariProcess = null;
      this.safariPort = null;
      closed = true;
    }
    return closed;
  }

  private async waitForSafariServerReady(port: number, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.isSafariServerReady(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  private async isSafariServerReady(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { method: 'GET' });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async requestWebDriver(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    if (!this.safariPort) throw new Error('Safari WebDriver port is not initialized.');
    const url = `http://127.0.0.1:${this.safariPort}${path}`;
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (!response.ok) {
      const message = payload?.value?.message || payload?.error || `HTTP ${response.status}`;
      throw new Error(`WebDriver ${method} ${path} failed: ${String(message)}`);
    }
    if (payload?.value?.error) {
      const message = payload?.value?.message || payload.value.error;
      throw new Error(`WebDriver ${method} ${path} error: ${String(message)}`);
    }
    return payload;
  }
}
