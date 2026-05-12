import { app } from 'electron';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, RegisteredTool } from '../shared/types.js';
import { AgentLoop } from './agent/agentLoop.js';
import { createLlmClient } from './agent/llmClient.js';
import { PromptBuilder } from './agent/promptBuilder.js';
import { SkillManager } from './skills/skillManager.js';
import { MarketplaceManager } from './skills/marketplaceManager.js';
import { ConfigStore } from './storage/configStore.js';
import { MemoryStore } from './storage/memoryStore.js';
import { SessionStore } from './storage/sessionStore.js';
import { ScheduledTaskStore } from './storage/scheduledTaskStore.js';
import { DEFAULT_HOME, ensureDir } from './storage/pathUtils.js';
import { createBuiltinTools } from './tools/builtinTools.js';
import { ToolRegistry } from './tools/toolRegistry.js';
import { McpConfigStore } from './mcp/mcpConfig.js';
import { SandboxManager } from './sandbox/sandboxManager.js';
import { EmailNotifier } from './notifications/emailNotifier.js';
import { TaskScheduler } from './scheduler/taskScheduler.js';
import { BrowserAutomationRouter } from './browser/browserAutomationRouter.js';
import { EmbeddedBrowserAutomation } from './browser/embeddedBrowserAutomation.js';
import { ExternalBrowserAutomation } from './browser/externalBrowserAutomation.js';
import { ExternalBrowserBridge } from './browser/externalBrowserBridge.js';
import { BrowserExecutionLogger } from './browser/browserExecutionLogger.js';
import { PersonalKnowledgeBase } from './knowledge/personalKnowledgeBase.js';
import { createPersonalKnowledgeKeywordExtractor } from './knowledge/keywordExtractor.js';
import { SessionDocumentContextStore } from './knowledge/sessionDocumentContextStore.js';
import type { BrowserAutomation } from './tools/browserAutomation.js';

function findBundledSkillsRoot(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'resources', 'skills'),
    resolve(here, '..', '..', 'resources', 'skills'),
    resolve(app.getAppPath(), 'resources', 'skills'),
    resolve(process.resourcesPath ?? '', 'skills')
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function findResourcesRoot(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'resources'),
    resolve(app.getAppPath(), 'resources'),
    resolve(process.cwd(), 'resources'),
    resolve(process.resourcesPath ?? '', 'resources')
  ];
  const withMarkets = candidates.find((candidate) => candidate && existsSync(join(candidate, 'markets')));
  if (withMarkets) return withMarkets;
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? resolve(process.cwd(), 'resources');
}

function consumeInstallerSkillOverwriteChoice(harnessHome: string): { overwriteExisting?: boolean; overwriteSkillNames?: string[] } {
  const marker = join(harnessHome, 'runtime', 'installer-skill-overwrite.json');
  if (!existsSync(marker)) return {};
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { overwriteBundledSkills?: unknown; overwriteSkillNames?: unknown };
    const overwriteSkillNames = Array.isArray(parsed.overwriteSkillNames)
      ? parsed.overwriteSkillNames.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return {
      overwriteExisting: parsed.overwriteBundledSkills === true,
      overwriteSkillNames
    };
  } catch {
    return {};
  } finally {
    try {
      unlinkSync(marker);
    } catch {
      // Best-effort cleanup. A stale marker should not block startup.
    }
  }
}

export class AppContext {
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
  readonly emailNotifier: EmailNotifier;
  readonly taskScheduler: TaskScheduler;
  readonly embeddedBrowserAutomation: EmbeddedBrowserAutomation;
  readonly externalBrowserBridge: ExternalBrowserBridge;
  readonly externalBrowserAutomation: ExternalBrowserAutomation;
  readonly browserAutomation: BrowserAutomation;
  readonly browserExecutionLogger: BrowserExecutionLogger;
  readonly personalKnowledgeBase: PersonalKnowledgeBase;
  readonly sessionDocumentContextStore: SessionDocumentContextStore;

  constructor(home = process.env.TASI_HARNESS_HOME || DEFAULT_HOME) {
    this.harnessHome = ensureDir(home);
    this.configStore = new ConfigStore(this.harnessHome);
    this.memoryStore = new MemoryStore(this.harnessHome);
    this.sessionStore = new SessionStore(this.harnessHome);
    this.syncMemoryFromExistingSessions();
    this.scheduledTaskStore = new ScheduledTaskStore(this.harnessHome);
    this.skillManager = new SkillManager(this.harnessHome, findBundledSkillsRoot());
    this.skillManager.seedBundledSkills(consumeInstallerSkillOverwriteChoice(this.harnessHome));
    this.mcpConfigStore = new McpConfigStore(this.harnessHome);
    this.sandboxManager = new SandboxManager(this.harnessHome);
    this.emailNotifier = new EmailNotifier();
    this.embeddedBrowserAutomation = new EmbeddedBrowserAutomation();
    this.browserExecutionLogger = new BrowserExecutionLogger(
      join(this.harnessHome, 'logs', 'browser-execution.log'),
      () => this.getConfig().browserExecutionLoggingEnabled
    );
    this.externalBrowserBridge = new ExternalBrowserBridge({
      runtimeDir: join(this.harnessHome, 'runtime', 'external-browser'),
      logger: this.browserExecutionLogger
    });
    this.externalBrowserAutomation = new ExternalBrowserAutomation(this.externalBrowserBridge, () => this.getConfig(), this.browserExecutionLogger);
    this.browserAutomation = new BrowserAutomationRouter(() => this.getConfig(), this.embeddedBrowserAutomation, this.externalBrowserAutomation);
    this.personalKnowledgeBase = new PersonalKnowledgeBase(this.harnessHome, {
      keywordExtractor: createPersonalKnowledgeKeywordExtractor(() => this.getConfig())
    });
    this.sessionDocumentContextStore = new SessionDocumentContextStore(this.harnessHome);
    const resourcesRoot = findResourcesRoot();
    this.marketplaceManager = new MarketplaceManager(resourcesRoot, this.skillManager, () => this.getConfig().skillMarketSources);
    this.toolRegistry = new ToolRegistry();
    for (const tool of this.createTools()) this.toolRegistry.register(tool);
    this.promptBuilder = new PromptBuilder(
      this.memoryStore,
      this.skillManager,
      this.personalKnowledgeBase,
      (config) => this.describeExternalBrowserBridge(config),
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
    this.taskScheduler = new TaskScheduler({
      taskStore: this.scheduledTaskStore,
      agentLoop: this.agentLoop,
      configStore: this.configStore,
      emailNotifier: this.emailNotifier,
      sessionStore: this.sessionStore
    });
    this.taskScheduler.start();
  }

  getConfig(): AppConfig {
    return this.configStore.get();
  }

  private syncMemoryFromExistingSessions(): void {
    const records = this.sessionStore
      .list()
      .map((summary) => this.sessionStore.read(summary.id))
      .filter((record): record is NonNullable<typeof record> => Boolean(record));
    if (records.length === 0) return;
    this.memoryStore.syncSessionMemories(records);
  }

  private describeExternalBrowserBridge(config: AppConfig): string {
    if (config.browserMode !== 'external') return '';
    const strategy =
      config.externalBrowserEngine === 'auto'
        ? process.platform === 'darwin'
          ? 'browser_* tools attach to CDP targets; preview fallback can use webdriver-safari or shell.openExternal'
          : 'browser_* tools attach to CDP targets; preview fallback can use shell.openExternal'
        : config.externalBrowserEngine === 'cdp'
          ? 'browser_* tools attach to CDP targets; preview fallback can use shell.openExternal'
          : 'webdriver-safari preview only; browser_* tools require CDP for external-page automation';
    return `- External browser bridge snapshot: engine=${config.externalBrowserEngine}; cdpEndpoint=${config.externalBrowserCdpEndpoint}; profileMode=${config.externalBrowserProfileMode}; headless=${config.browserHeadless ? 'on' : 'off'}; strategy=${strategy}; log=${join(this.harnessHome, 'logs', 'browser-execution.log')}.`;
  }

  private createTools(): RegisteredTool[] {
    return createBuiltinTools({
      getConfig: () => this.getConfig(),
      memoryStore: this.memoryStore,
      sessionStore: this.sessionStore,
      skillManager: this.skillManager,
      browserAutomation: this.browserAutomation
    });
  }
}
