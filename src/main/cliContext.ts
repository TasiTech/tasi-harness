import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRunOptions, AgentRunResult, AppConfig, RegisteredTool, ToolApprovalRequester } from '../shared/types.js';
import { AgentLoop } from './agent/agentLoop.js';
import { createLlmClient } from './agent/llmClient.js';
import { PromptBuilder } from './agent/promptBuilder.js';
import { ExternalBrowserAutomation } from './browser/externalBrowserAutomation.js';
import { ExternalBrowserBridge } from './browser/externalBrowserBridge.js';
import { BrowserExecutionLogger } from './browser/browserExecutionLogger.js';
import { createPersonalKnowledgeKeywordExtractor } from './knowledge/keywordExtractor.js';
import { PersonalKnowledgeBase } from './knowledge/personalKnowledgeBase.js';
import { SessionDocumentContextStore } from './knowledge/sessionDocumentContextStore.js';
import { McpConfigStore } from './mcp/mcpConfig.js';
import { SandboxManager } from './sandbox/sandboxManager.js';
import { MarketplaceManager } from './skills/marketplaceManager.js';
import { SkillManager } from './skills/skillManager.js';
import { ConfigStore } from './storage/configStore.js';
import { MemoryStore } from './storage/memoryStore.js';
import { DEFAULT_HOME, ensureDir } from './storage/pathUtils.js';
import { ScheduledTaskStore } from './storage/scheduledTaskStore.js';
import { SessionStore } from './storage/sessionStore.js';
import { createBuiltinTools } from './tools/builtinTools.js';
import { ToolRegistry } from './tools/toolRegistry.js';

const CLI_UNAVAILABLE_TOOLS = new Set<string>();

function findBundledSkillsRoot(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    resolve(process.cwd(), 'resources', 'skills'),
    resolve(here, '..', '..', 'resources', 'skills'),
    resolve(resourcesPath, 'skills'),
    resolve(resourcesPath, 'app.asar', 'resources', 'skills'),
    resolve(resourcesPath, 'app', 'resources', 'skills')
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function findResourcesRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const candidates = [
    resolve(process.cwd(), 'resources'),
    resolve(here, '..', '..', 'resources'),
    resolve(resourcesPath, 'resources'),
    resolve(resourcesPath, 'app.asar', 'resources'),
    resolve(resourcesPath, 'app', 'resources')
  ];
  const withMarkets = candidates.find((candidate) => candidate && existsSync(join(candidate, 'markets')));
  if (withMarkets) return withMarkets;
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? resolve(process.cwd(), 'resources');
}

function isCliAvailableTool(tool: RegisteredTool): boolean {
  const name = tool.definition.function.name;
  return !CLI_UNAVAILABLE_TOOLS.has(name);
}

function createCliRuntimeId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${process.pid}-${Date.now().toString(36)}-${random}`;
}

function createCliCdpEndpoint(runtimeId: string): string {
  const hash = [...runtimeId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const randomOffset = Math.floor(Math.random() * 3000);
  const port = 30000 + ((process.pid + hash + randomOffset) % 20000);
  return `http://127.0.0.1:${port}`;
}

function cliConfig(config: AppConfig, cdpEndpoint: string): AppConfig {
  const isolated = config.externalBrowserProfileMode !== 'system';
  return {
    ...config,
    browserMode: 'external',
    externalBrowserEngine: config.externalBrowserEngine === 'webdriver-safari' ? 'auto' : config.externalBrowserEngine,
    externalBrowserCdpEndpoint: isolated ? cdpEndpoint : config.externalBrowserCdpEndpoint,
    externalBrowserProfileMode: config.externalBrowserProfileMode,
    enabledToolNames: config.enabledToolNames.filter((name) => !CLI_UNAVAILABLE_TOOLS.has(name))
  };
}

export class CliContext {
  readonly harnessHome: string;
  readonly configStore: ConfigStore;
  readonly memoryStore: MemoryStore;
  readonly sessionStore: SessionStore;
  readonly scheduledTaskStore: ScheduledTaskStore;
  readonly skillManager: SkillManager;
  readonly marketplaceManager: MarketplaceManager;
  readonly toolRegistry: ToolRegistry;
  readonly promptBuilder: PromptBuilder;
  readonly agentLoop: AgentLoop;
  readonly mcpConfigStore: McpConfigStore;
  readonly sandboxManager: SandboxManager;
  readonly externalBrowserBridge: ExternalBrowserBridge;
  readonly externalBrowserAutomation: ExternalBrowserAutomation;
  readonly browserExecutionLogger: BrowserExecutionLogger;
  readonly personalKnowledgeBase: PersonalKnowledgeBase;
  readonly sessionDocumentContextStore: SessionDocumentContextStore;
  private readonly cliRuntimeId: string;
  private readonly cliCdpEndpoint: string;

  constructor(home = process.env.TASI_HARNESS_HOME || DEFAULT_HOME) {
    this.cliRuntimeId = createCliRuntimeId();
    this.cliCdpEndpoint = createCliCdpEndpoint(this.cliRuntimeId);
    this.harnessHome = ensureDir(home);
    this.configStore = new ConfigStore(this.harnessHome);
    this.memoryStore = new MemoryStore(this.harnessHome);
    this.sessionStore = new SessionStore(this.harnessHome);
    this.syncMemoryFromExistingSessions();
    this.scheduledTaskStore = new ScheduledTaskStore(this.harnessHome);
    this.skillManager = new SkillManager(this.harnessHome, findBundledSkillsRoot());
    this.skillManager.seedBundledSkills();
    this.mcpConfigStore = new McpConfigStore(this.harnessHome);
    this.sandboxManager = new SandboxManager(this.harnessHome);
    this.browserExecutionLogger = new BrowserExecutionLogger(
      join(this.harnessHome, 'logs', 'browser-execution.log'),
      () => this.getConfig().browserExecutionLoggingEnabled
    );
    this.externalBrowserBridge = new ExternalBrowserBridge({
      runtimeDir: join(this.harnessHome, 'runtime', 'external-browser-cli', this.cliRuntimeId),
      strictCdpEndpoint: true,
      logger: this.browserExecutionLogger
    });
    this.externalBrowserAutomation = new ExternalBrowserAutomation(this.externalBrowserBridge, () => this.getConfig(), this.browserExecutionLogger);
    this.personalKnowledgeBase = new PersonalKnowledgeBase(this.harnessHome, {
      keywordExtractor: createPersonalKnowledgeKeywordExtractor(() => this.getConfig())
    });
    this.sessionDocumentContextStore = new SessionDocumentContextStore(this.harnessHome);
    this.marketplaceManager = new MarketplaceManager(findResourcesRoot(), this.skillManager, () => this.getConfig().skillMarketSources);
    this.toolRegistry = new ToolRegistry();
    for (const tool of this.createTools()) this.toolRegistry.register(tool);
    this.promptBuilder = new PromptBuilder(
      this.memoryStore,
      this.skillManager,
      this.personalKnowledgeBase,
      (config) => this.describeCliBrowserAutomation(config),
      this.sessionDocumentContextStore
    );
    this.agentLoop = new AgentLoop({
      getConfig: () => this.getConfig(),
      createClient: () => createLlmClient(this.getConfig()),
      toolRegistry: this.toolRegistry,
      sessions: this.sessionStore,
      promptBuilder: this.promptBuilder,
      prepareExecution: (mode, runId) => this.sandboxManager.prepare(mode ?? this.getConfig().defaultExecutionMode, this.getConfig().workspaceDir, runId),
      beginDeferredMemory: (sessionId) => this.memoryStore.beginDeferredSession(sessionId),
      commitDeferredMemory: (sessionId) => {
        const result = this.memoryStore.commitDeferredSession(sessionId);
        if (result.errors.length > 0) {
          console.warn(`[memory] failed to commit deferred changes for ${sessionId}: ${result.errors.join(' | ')}`);
        }
      },
      discardDeferredMemory: (sessionId) => this.memoryStore.discardDeferredSession(sessionId),
      syncSessionMemory: (session) => {
        if (!this.memoryStore.syncSessionMemory(session)) return;
      }
    });
  }

  getConfig(): AppConfig {
    return cliConfig(this.configStore.get(), this.cliCdpEndpoint);
  }

  async runChat(
    options: AgentRunOptions,
    runtime?: {
      requestToolApproval?: ToolApprovalRequester;
      onToolEvent?: Parameters<AgentLoop['run']>[0]['onToolEvent'];
      onMessageDelta?: Parameters<AgentLoop['run']>[0]['onMessageDelta'];
      signal?: AbortSignal;
      browserLogEnabled?: boolean;
    }
  ): Promise<AgentRunResult> {
    return this.withBrowserLogging(runtime?.browserLogEnabled === true, async () => {
      const result = await this.agentLoop.run({
        ...options,
        origin: 'chat',
        requestToolApproval: runtime?.requestToolApproval,
        onToolEvent: runtime?.onToolEvent,
        onMessageDelta: runtime?.onMessageDelta,
        signal: runtime?.signal
      });
      const usageRecord = this.sessionStore.recordUsage(result.sessionId, result.usage);
      return { ...result, totalUsage: usageRecord.totalUsage };
    });
  }

  async close(options?: { browserLogEnabled?: boolean }): Promise<void> {
    await this.withBrowserLogging(options?.browserLogEnabled === true, async () => this.externalBrowserBridge.close()).catch((error) => {
      console.warn(`[cli] failed to close browser automation: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private syncMemoryFromExistingSessions(): void {
    const records = this.sessionStore
      .list()
      .map((summary) => this.sessionStore.read(summary.id))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    if (records.length === 0) return;
    this.memoryStore.syncSessionMemories(records);
  }

  private createTools(): RegisteredTool[] {
    return createBuiltinTools({
      getConfig: () => this.getConfig(),
      memoryStore: this.memoryStore,
      sessionStore: this.sessionStore,
      skillManager: this.skillManager,
      browserAutomation: this.externalBrowserAutomation
    }).filter(isCliAvailableTool);
  }

  private describeCliBrowserAutomation(config: AppConfig): string {
    return [
      '- CLI browser automation is available through the browser_* tools using external Chromium/Edge CDP.',
      `- CLI browser settings: cdpEndpoint=${config.externalBrowserCdpEndpoint}; profileMode=${config.externalBrowserProfileMode}; headless=${config.browserHeadless ? 'on' : 'off'}.`,
      '- CLI browser automation uses the configured external browser profile mode. Use system mode to reuse existing login state, or isolated mode for a separate temporary profile.',
      '- In isolated mode, each CLI process uses its own CDP port and browser profile, so login state is not shared with the system browser.',
      `- Browser execution diagnostics are written to ${join(this.harnessHome, 'logs', 'browser-execution.log')}.`,
      '- In CLI mode, use browser_open/browser_extract/browser_snapshot for live web lookups when the user asks to browse or verify current information.'
    ].join('\n');
  }

  private async withBrowserLogging<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
    if (enabled) return run();
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    const shouldSuppress = (args: unknown[]): boolean => typeof args[0] === 'string' && args[0].startsWith('[browser][external]');
    console.info = (...args: unknown[]) => {
      if (!shouldSuppress(args)) originalInfo(...args);
    };
    console.warn = (...args: unknown[]) => {
      if (!shouldSuppress(args)) originalWarn(...args);
    };
    console.debug = (...args: unknown[]) => {
      if (!shouldSuppress(args)) originalDebug(...args);
    };
    try {
      return await run();
    } finally {
      console.info = originalInfo;
      console.warn = originalWarn;
      console.debug = originalDebug;
    }
  }
}
