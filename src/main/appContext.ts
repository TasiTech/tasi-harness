import { app } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { EmbeddedBrowserAutomation } from './browser/embeddedBrowserAutomation.js';
import { PersonalKnowledgeBase } from './knowledge/personalKnowledgeBase.js';
import { createPersonalKnowledgeKeywordExtractor } from './knowledge/keywordExtractor.js';

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

function findManifestInDirectory(path: string): string | null {
  if (!existsSync(path)) return null;
  if (statSync(path).isFile() && path.toLowerCase().endsWith('manifest.json')) return dirname(path);
  const direct = resolve(path, 'manifest.json');
  if (existsSync(direct)) return resolve(path);
  if (!statSync(path).isDirectory()) return null;
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (!existsSync(child) || !statSync(child).isDirectory()) continue;
    if (existsSync(resolve(child, 'manifest.json'))) return child;
  }
  return null;
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
  readonly personalKnowledgeBase: PersonalKnowledgeBase;

  constructor(home = process.env.TASI_HARNESS_HOME || DEFAULT_HOME) {
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
    this.emailNotifier = new EmailNotifier();
    this.embeddedBrowserAutomation = new EmbeddedBrowserAutomation();
    this.personalKnowledgeBase = new PersonalKnowledgeBase(this.harnessHome, {
      keywordExtractor: createPersonalKnowledgeKeywordExtractor(() => this.getConfig())
    });
    const resourcesRoot = findResourcesRoot();
    this.marketplaceManager = new MarketplaceManager(resourcesRoot, this.skillManager, () => this.getConfig().skillMarketSources);
    this.toolRegistry = new ToolRegistry();
    for (const tool of this.createTools()) this.toolRegistry.register(tool);
    this.promptBuilder = new PromptBuilder(
      this.memoryStore,
      this.skillManager,
      this.personalKnowledgeBase,
      (config) => this.describeExternalBrowserBridge(config)
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
      emailNotifier: this.emailNotifier
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
    if (config.opencliBridgeMode !== 'external') return '';
    const explicit = config.opencliExtensionPath?.trim();
    const candidates = [
      explicit || '',
      resolve(this.harnessHome, 'extensions', 'opencli-extension'),
      resolve(process.cwd(), 'resources', 'opencli-extension'),
      resolve(app.getAppPath(), 'resources', 'opencli-extension'),
      resolve(process.resourcesPath ?? '', 'opencli-extension')
    ].filter(Boolean);
    const openCliDetected = candidates.some((candidate) => Boolean(findManifestInDirectory(candidate)));
    if (openCliDetected) {
      return '- External browser bridge snapshot: OpenCLI extension files were detected locally. Prefer Agent Browser or OpenCLI flows when they are responsive, but if the bridge is disconnected or the command fails, immediately fall back to browser_* tools and let the harness open the resulting page in the user browser.';
    }
    return '- External browser bridge snapshot: no OpenCLI bridge installation was detected automatically. Agent Browser availability is not auto-detected here, so do not assume any external bridge exists. Use browser_* tools by default and let the harness open resulting pages in the user browser.';
  }

  private createTools(): RegisteredTool[] {
    return createBuiltinTools({
      getConfig: () => this.getConfig(),
      memoryStore: this.memoryStore,
      sessionStore: this.sessionStore,
      skillManager: this.skillManager,
      browserAutomation: this.embeddedBrowserAutomation
    });
  }
}
