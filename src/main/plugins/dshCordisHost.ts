import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  DshSidecarClientMount,
  DshSidecarClientMountPoint,
  DshSidecarChatRunRequest,
  DshSidecarChatRunResult,
  DshSidecarInputPart,
  DshSidecarPluginRecord,
  DshSidecarRuntimePlugin,
  DshSidecarRuntimeSkill,
  DshSidecarToolCallRequest,
  JsonSchema,
  ToolDefinition,
  ToolExecutionResult
} from '../../shared/types.js';

type JsonObject = Record<string, unknown>;
type Disposer = () => void;
type CordisHandler = (...args: unknown[]) => unknown;
type CordisPluginShape = CordisHandler | JsonObject;
type RpcHandler = (method: string, payload: unknown, signal?: AbortSignal) => unknown;
interface CordisLogger {
  (childName?: string): CordisLogger;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface DshToolLike extends JsonObject {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
  output?: unknown;
  execute?: unknown;
}

interface RegisteredCordisTool {
  pluginId: string;
  raw: DshToolLike;
  definition: ToolDefinition;
}

interface RegisteredCordisCommand {
  pluginId: string;
  name: string;
  handler?: CordisHandler;
  raw?: unknown;
}

interface RegisteredWebRoute {
  pluginId: string;
  kind: 'exact' | 'prefix';
  path: string;
  handler?: CordisHandler;
  raw: JsonObject;
}

interface RegisteredIndexTap {
  pluginId: string;
  handler: CordisHandler;
}

interface RegisteredSkillProvider {
  pluginId: string;
  name: string;
  raw: unknown;
}

interface RegisteredRuntimeSkill {
  pluginId: string;
  name: string;
  raw: JsonObject;
}

interface RegisteredSearchProvider {
  pluginId: string;
  id: string;
  raw: unknown;
}

interface HostLlmConfig {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

interface DshWorkspaceRecord extends JsonObject {
  workspaceId: string;
  id: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DshCordisHostPluginInput {
  record: DshSidecarPluginRecord;
  packageRoot?: string;
  patchPath?: string;
  moduleEntry?: string;
  config?: unknown;
}

export interface DshCordisHostPluginState {
  id: string;
  packageName: string;
  status: DshSidecarRuntimePlugin['status'];
  tools: string[];
  settingsEntries: string[];
  commands: string[];
  providedServices: string[];
  webRoutes: string[];
  clientMounts: DshSidecarClientMount[];
  missingServices: string[];
  lastError?: string;
}

interface DshCordisHostOptions {
  sidecarHome: string;
  profileName: string;
  clientBaseUrl?: string;
  mainRequest?: (method: string, params?: unknown) => Promise<unknown>;
}

export class DshCordisHost {
  private readonly tools = new Map<string, RegisteredCordisTool>();
  private readonly commands = new Map<string, RegisteredCordisCommand>();
  private readonly plugins = new Map<string, DshCordisHostPluginState>();
  private readonly gatewaySessions = new Map<string, JsonObject>();
  private readonly gatewayHistories = new Map<string, JsonObject[]>();
  private readonly gatewayRunningTurns = new Map<string, string>();
  private readonly rpcHandlers = new Map<string, { pluginId: string; handler: RpcHandler; options?: unknown }>();
  private readonly webRoutes = new Map<string, RegisteredWebRoute>();
  private readonly indexTaps = new Map<string, RegisteredIndexTap>();
  private readonly skillProviders = new Map<string, RegisteredSkillProvider>();
  private readonly runtimeSkills = new Map<string, RegisteredRuntimeSkill>();
  private readonly searchProviders = new Map<string, RegisteredSearchProvider>();
  private readonly services = new Map<string, unknown>();
  private readonly listeners = new Map<string, CordisHandler[]>();
  private readonly disposers: Disposer[] = [];
  private readonly activeAgents: JsonObject[] = [];
  private moduleLoadCounter = 0;
  private currentPluginId = '';

  constructor(private readonly options: DshCordisHostOptions) {
    this.installBaseServices();
  }

  runtimePlugin(id: string): DshCordisHostPluginState | undefined {
    return this.plugins.get(id);
  }

  runtimePlugins(): DshCordisHostPluginState[] {
    return [...this.plugins.values()];
  }

  toolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async skillDocuments(): Promise<DshSidecarRuntimeSkill[]> {
    const documents: DshSidecarRuntimeSkill[] = [];
    const seen = new Set<string>();
    for (const skill of this.runtimeSkills.values()) {
      const normalized = this.normalizeRuntimeSkill(skill.raw, skill.pluginId);
      if (!normalized || seen.has(normalized.name)) continue;
      seen.add(normalized.name);
      documents.push(normalized);
    }
    for (const provider of this.skillProviders.values()) {
      const providerObject = objectValue(provider.raw);
      const listed = await this.providerSkillCandidates(provider);
      for (const candidate of listed) {
        const candidateObject = objectValue(candidate);
        const skill = typeof providerObject.get === 'function'
          ? await (providerObject.get as CordisHandler)(candidate, {})
          : candidate;
        const normalized = this.normalizeRuntimeSkill({ ...candidateObject, ...objectValue(skill) }, provider.pluginId);
        if (!normalized || seen.has(normalized.name)) continue;
        seen.add(normalized.name);
        documents.push(normalized);
      }
    }
    return documents;
  }

  async handleWebRequest(pathname: string, req: unknown, res: unknown): Promise<boolean> {
    const route = [...this.webRoutes.values()]
      .filter((item) => item.kind === 'exact' ? pathname === item.path : pathname === item.path || pathname.startsWith(`${item.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!route) return false;
    if (typeof route.handler !== 'function') return false;
    await route.handler(req, res);
    return true;
  }

  async transformIndexHtml(html: string): Promise<string> {
    let next = html;
    for (const tap of this.indexTaps.values()) {
      const value = await tap.handler(next);
      if (typeof value === 'string') next = value;
    }
    return next;
  }

  async callConnectionRpc(channel: string, method: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    const name = channel.trim();
    const endpoint = method.trim();
    const registered = this.rpcHandlers.get(name);
    if (!registered) throw createGatewayError(`connection/${name}`, 'not-found', `No RPC handler registered for ${name}.`);
    return await registered.handler(endpoint, payload ?? {}, signal);
  }

  async callTool(params: DshSidecarToolCallRequest): Promise<ToolExecutionResult | undefined> {
    const registered = this.tools.get(params.name.trim());
    if (!registered) return undefined;
    const execute = registered.raw.execute;
    if (typeof execute !== 'function') {
      return { ok: false, content: `DSH Cordis tool has no execute function: ${params.name}` };
    }
    const controller = new AbortController();
    const agent = this.createAgent({
      sessionId: params.context.sessionId,
      workspaceDir: params.context.workspaceDir,
      llm: params.context.llm
    });
    const exec = {
      callId: params.context.requestId,
      rootCallId: params.context.requestId,
      name: params.name,
      arguments: params.args,
      signal: controller.signal,
      agent,
      deferContext() {},
      concludeTurn() {}
    };
    this.activeAgents.push(agent);
    try {
      const value = await execute.call(registered.raw, params.args ?? {}, exec);
      return normalizeToolResult(value, registered.raw, params.args ?? {});
    } catch (error) {
      return { ok: false, content: errorMessage(error) };
    } finally {
      if (this.activeAgents.at(-1) === agent) this.activeAgents.pop();
      else {
        const index = this.activeAgents.lastIndexOf(agent);
        if (index >= 0) this.activeAgents.splice(index, 1);
      }
    }
  }

  async runChat(request: DshSidecarChatRunRequest): Promise<DshSidecarChatRunResult> {
    const startedAt = Date.now();
    const plugin = this.resolveRuntimePlugin(request.pluginRef);
    if (!plugin) {
      return {
        ok: false,
        error: `Unknown DSH plugin reference: ${request.pluginRef}`,
        content: `Unknown DSH plugin reference: ${request.pluginRef}`,
        diagnostics: {
          plugin: request.pluginRef,
          runtime: 'missing',
          durationMs: Date.now() - startedAt
        }
      };
    }
    const text = textFromInputParts(request.input?.parts ?? []);
    const command = this.selectCommandForChat(plugin, text);
    if (command?.handler) {
      const replies: string[] = [];
      const followups: DshSidecarChatRunResult['messages'] = [];
      const rawInput = commandRawInput(plugin, command, text);
      const agent = this.createAgent({
        sessionId: request.sessionId,
        workspaceDir: request.workspaceDir,
        llm: request.context?.llm,
        followup: (value: unknown) => {
          const textValue = dshMessageToText(value).trim();
          if (textValue) followups?.push({ role: 'user', content: textValue, name: plugin.id });
        }
      });
      const commandContext = {
        plugin,
        input: text,
        rawInput,
        parts: request.input?.parts ?? [],
        sessionId: request.sessionId,
        workspaceDir: request.workspaceDir,
        agent,
        request,
        reply: (value: unknown) => {
          const textValue = contentToText(value).trim();
          if (textValue) replies.push(textValue);
        },
        write: (value: unknown) => {
          const textValue = contentToText(value).trim();
          if (textValue) replies.push(textValue);
        }
      };
      try {
        this.activeAgents.push(agent);
        const value = await command.handler(commandContext, request);
        const content = uniqueText([
          ...replies,
          contentToText(value).trim()
        ]).join('\n\n').trim() || `DSH sidecar command ${command.name} completed.`;
        return {
          ok: true,
          content,
          messages: followups,
          parts: [{ type: 'text', text: content }],
          diagnostics: {
            plugin: plugin.packageName,
            runtime: plugin.status,
            command: command.name,
            note: followups && followups.length > 0 ? 'queued-followup' : undefined,
            durationMs: Date.now() - startedAt
          }
        };
      } catch (error) {
        const message = errorMessage(error);
        return {
          ok: false,
          content: message,
          error: message,
          diagnostics: {
            plugin: plugin.packageName,
            runtime: plugin.status,
            command: command.name,
            durationMs: Date.now() - startedAt
          }
        };
      } finally {
        if (this.activeAgents.at(-1) === agent) this.activeAgents.pop();
        else {
          const index = this.activeAgents.lastIndexOf(agent);
          if (index >= 0) this.activeAgents.splice(index, 1);
        }
      }
    }
    const toolNames = [...this.tools.values()]
      .filter((tool) => tool.pluginId === plugin.id)
      .map((tool) => tool.definition.function.name);
    const message = [
      `${plugin.packageName} has no direct sidecar chat entrypoint.`,
      command ? `Command ${command.name} is registered, but this host cannot call its handler.` : 'The plugin did not register a sidecar chat command handler.',
      toolNames.length > 0 ? `Agent-callable plugin tools: ${toolNames.join(', ')}` : 'The plugin did not expose agent-callable tools.',
      'Skills-only plugins are loaded as skill providers and should not be routed as @plugin chat turns.',
      plugin.lastError ? `Runtime note: ${plugin.lastError}` : ''
    ].filter(Boolean).join('\n');
    return {
      ok: false,
      content: message,
      parts: [{ type: 'text', text: message }],
      diagnostics: {
        plugin: plugin.packageName,
        runtime: plugin.status,
        toolCalls: toolNames,
        durationMs: Date.now() - startedAt,
        note: command ? 'missing-command-handler' : 'missing-chat-handler'
      }
    };
  }

  async loadPlugin(input: DshCordisHostPluginInput): Promise<DshCordisHostPluginState> {
    const { record } = input;
    const base: DshCordisHostPluginState = {
      id: record.id,
      packageName: record.packageName,
      status: 'failed',
      tools: [],
      settingsEntries: [],
      commands: [],
      providedServices: [],
      webRoutes: [],
      clientMounts: [],
      missingServices: [],
      lastError: undefined
    };
    this.plugins.set(record.id, base);
    if (!input.packageRoot) return this.updatePlugin(record.id, { lastError: `Installed package is not resolvable: ${record.packageName}` });
    if (!input.patchPath) return this.updatePlugin(record.id, { lastError: `Bundle patch is missing for ${record.packageName}.` });
    if (!input.moduleEntry) return this.updatePlugin(record.id, { lastError: `Runtime module entry is missing for ${record.packageName}.` });
    const previousPluginId = this.currentPluginId;
    this.currentPluginId = record.id;
    try {
      const url = pathToFileURL(input.moduleEntry);
      url.searchParams.set('t', `${Date.now().toString(36)}-${this.moduleLoadCounter++}`);
      const mod = await import(url.href);
      const shape = selectCordisPluginShape(mod);
      const missingServices = injectedServices(shape).filter((name) => !this.services.has(name));
      const beforeTools = this.tools.size;
      if (missingServices.length > 0) base.missingServices = missingServices;
      await this.applyPluginShape(shape, input.config);
      const pluginTools = [...this.tools.values()]
        .filter((tool) => tool.pluginId === record.id)
        .map((tool) => tool.definition.function.name);
      return this.updatePlugin(record.id, {
        status: missingServices.length > 0 ? 'partial' : 'loaded',
        tools: pluginTools,
        missingServices,
        lastError: this.tools.size === beforeTools && pluginTools.length === 0
          ? undefined
          : undefined
      });
    } catch (error) {
      return this.updatePlugin(record.id, { status: 'failed', lastError: errorMessage(error) });
    } finally {
      this.currentPluginId = previousPluginId;
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // best-effort unload for plugin-owned disposers
      }
    }
  }

  private updatePlugin(id: string, patch: Partial<DshCordisHostPluginState>): DshCordisHostPluginState {
    const current = this.plugins.get(id);
    const next: DshCordisHostPluginState = {
      id,
      packageName: current?.packageName ?? id,
      status: current?.status ?? 'failed',
      tools: current?.tools ?? [],
      settingsEntries: current?.settingsEntries ?? [],
      commands: current?.commands ?? [],
      providedServices: current?.providedServices ?? [],
      webRoutes: current?.webRoutes ?? [],
      clientMounts: current?.clientMounts ?? [],
      missingServices: current?.missingServices ?? [],
      lastError: current?.lastError,
      ...patch
    };
    this.plugins.set(id, next);
    return next;
  }

  private async applyPluginShape(shape: CordisPluginShape, config: unknown): Promise<void> {
    const ctx = this.createContext();
    if (typeof shape === 'function') {
      await invokeCordisFunction(shape, ctx, config);
      return;
    }
    const apply = shape.apply;
    if (typeof apply === 'function') {
      await apply.call(shape, ctx, config);
    }
  }

  private createContext(): JsonObject {
    let ctx: JsonObject;
    const target: JsonObject = {
      root: undefined,
      events: {
        on: (name: string, handler: CordisHandler) => this.on(name, handler),
        emit: (name: string, ...args: unknown[]) => this.emit(name, ...args),
        dispatch: (_mode: string, args: unknown[]) => {
          const [, eventName, ...eventArgs] = args;
          return typeof eventName === 'string' ? this.listenersFor(eventName).map((handler) => () => handler(...eventArgs)) : [];
        }
      },
      provide: (name: string, value: unknown) => this.provide(name, value),
      get: (name: string) => this.services.get(name),
      on: (name: string, handler: CordisHandler) => this.on(name, handler),
      emit: (name: string, ...args: unknown[]) => this.emit(name, ...args),
      effect: (factory: () => unknown) => this.effect(factory),
      plugin: async (plugin: CordisPluginShape, config?: unknown) => {
        await this.applyPluginShape(plugin, config);
      },
      inject: (deps: unknown, callback?: CordisHandler) => {
        const names = normalizeInjectList(deps);
        const missing = names.filter((name) => !this.services.has(name));
        if (missing.length > 0 && this.currentPluginId) {
          const current = this.plugins.get(this.currentPluginId);
          this.updatePlugin(this.currentPluginId, {
            missingServices: [...new Set([...(current?.missingServices ?? []), ...missing])]
          });
        }
        if (typeof callback === 'function') return this.consumeEffectResult(callback(ctx));
        return ctx;
      },
      logger: this.createLogger('dsh-sidecar'),
      scope: () => ctx
    };
    ctx = new Proxy(target, {
      get: (obj, prop) => {
        if (prop === 'root') return ctx;
        if (typeof prop === 'string' && this.services.has(prop)) return this.services.get(prop);
        return typeof prop === 'string' ? obj[prop] : undefined;
      },
      set: (obj, prop, value) => {
        obj[prop as string] = value;
        return true;
      }
    });
    return ctx;
  }

  private installBaseServices(): void {
    this.services.set('logger', this.createLogger('dsh-sidecar'));
    this.services.set('connection', this.createConnectionService());
    this.services.set('credentials', this.createCredentialsService());
    this.services.set('apiProxy', this.createApiProxyService());
    this.services.set('typertGateway', this.createTypertGatewayService());
    this.services.set('sessionController', this.createCollectionService('sessionController'));
    this.services.set('workspaceController', this.createCollectionService('workspaceController'));
    this.services.set('tools', this.createToolsService());
    this.services.set('commands', this.createCommandsService());
    this.services.set('settings', this.createSettingsService());
    this.services.set('skills', this.createSkillsService());
    this.services.set('web', this.createWebService());
    this.services.set('attachments', this.createAttachmentsService());
    const storage = this.createStorageService();
    this.services.set('storage', storage);
    const storageDomain = this.createStorageDomainService(storage);
    this.services.set('storageDomain', storageDomain);
    this.services.set('llm', this.createLlmService());
    this.services.set('systemPrompt', this.createSystemPromptService());
    this.services.set('sessionProjections', this.createSessionProjectionsService());
    this.services.set('webServer', this.createWebServerService());
    this.services.set('jobs', this.createJobsService());
    this.services.set('sessions', { list: () => [], get: () => undefined });
    this.services.set('sessionTitle', { get: () => undefined });
    this.services.set('agents', { list: () => [], get: () => undefined });
    this.services.set('subagents', this.createSubagentsService());
    this.services.set('sessionPersistence', { read: () => undefined, write: () => undefined });
    const workspaceRegistry = this.createWorkspaceRegistryService();
    this.services.set('workspaceRegistry', workspaceRegistry);
    this.services.set('workspaces', workspaceRegistry);
    this.services.set('sandboxPolicy', this.createSandboxPolicyService());
    this.services.set('timer', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval
    });
    this.services.set('app', { home: this.options.sidecarHome, profileName: this.options.profileName });
    this.services.set('clientRuntime', this.createClientRuntimeService());
    this.services.set('locale', this.createLocaleService());
    this.services.set('slots', this.createSlotsService());
    const remote = this.createRemoteService();
    this.services.set('remote', remote);
    for (const namespace of [
      'agentPresets',
      'commands',
      'directoryPicker',
      'dynamicCordisRunner',
      'fileReferences',
      'goals',
      'llm',
      'messageFeedback',
      'pluginInventory',
      'session',
      'sessionReferenceResolver',
      'settings',
      'subagents',
      'workspace'
    ]) {
      this.services.set(`remote.${namespace}`, objectValue(remote)[namespace]);
    }
    this.services.set('uiConversation', this.createUiConversationService());
    this.services.set('uiWorkspace', this.createUiWorkspaceService());
    this.services.set('modelDirectories', this.createModelDirectoriesService());
    this.services.set('conversation', this.createConversationService());
    this.services.set('commandUi', this.createCommandUiService());
    this.services.set('uiSession', this.createUiSessionService());
    this.services.set('settingsScope', this.createSettingsScopeService());
  }

  private createConnectionService(): JsonObject {
    return {
      rpc: {
        handle: (channel: unknown, handler: unknown, options?: unknown) => {
          const name = stringValue(channel).trim();
          if (!name) throw new Error('connection.rpc.handle requires a channel name.');
          if (typeof handler !== 'function') throw new Error(`connection.rpc.handle requires a handler for ${name}.`);
          const registered = { pluginId: this.currentPluginId || 'unknown', handler: handler as RpcHandler, options };
          this.rpcHandlers.set(name, registered);
          this.recordPluginValue('providedServices', `rpc:${name}`);
          return () => {
            if (this.rpcHandlers.get(name) === registered) this.rpcHandlers.delete(name);
          };
        },
        call: async (channel: unknown, method: unknown, payload?: unknown, options?: { signal?: AbortSignal }) => {
          const name = stringValue(channel).trim();
          const endpoint = stringValue(method).trim();
          const registered = this.rpcHandlers.get(name);
          if (!registered) throw createGatewayError(`connection/${name}`, 'not-found', `No RPC handler registered for ${name}.`);
          return registered.handler(endpoint, payload ?? {}, options?.signal);
        },
        list: () => [...this.rpcHandlers.keys()]
      }
    };
  }

  private createCredentialsService(): JsonObject {
    const path = resolve(this.options.sidecarHome, 'profiles', this.options.profileName, 'credentials.json');
    const read = (): Record<string, string> => {
      if (!existsSync(path)) return {};
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!isJsonObject(parsed)) return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof key === 'string' && typeof value === 'string') out[key] = value;
        }
        return out;
      } catch {
        return {};
      }
    };
    const write = (values: Record<string, string>) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(values, null, 2), 'utf8');
    };
    return {
      resolve: async (ref: unknown) => {
        const key = credentialKey(ref);
        const value = read()[key];
        return typeof value === 'string' ? { ref: key, value } : undefined;
      },
      set: async (ref: unknown, value: unknown) => {
        const key = credentialKey(ref);
        const clean = typeof value === 'string' ? value : String(value ?? '');
        const values = read();
        values[key] = clean;
        write(values);
        return { ref: key };
      },
      unset: async (ref: unknown) => {
        const key = credentialKey(ref);
        const values = read();
        delete values[key];
        const remaining = Object.keys(values).length;
        if (remaining > 0) write(values);
        else if (existsSync(path)) rmSync(path, { force: true });
        return { ref: key };
      }
    };
  }

  private createApiProxyService(): JsonObject {
    const workspaceId = 'default';
    const workspacePath = resolve(process.cwd());
    const rpcResult = async (request: unknown, operation: () => unknown | Promise<unknown>) => {
      const rpcId = isJsonObject(request) && typeof request.rpcId === 'string' ? request.rpcId : `dsh-${Date.now().toString(36)}`;
      try {
        return { rpcId, result: { ok: true, value: await operation() } };
      } catch (error) {
        return { rpcId, result: { ok: false, error: gatewayFailure(error) } };
      }
    };
    const listSessions = () => ({
      items: [...this.gatewaySessions.values()].map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd ?? workspacePath,
        running: this.gatewayRunningTurns.has(stringValue(session.sessionId)),
        projections: { values: { title: session.title ?? null } }
      }))
    });
    return {
      host: {
        describe: (request: unknown) => rpcResult(request, () => ({ ready: true, transport: 'tasi-sidecar' }))
      },
      workspace: {
        list: (request: unknown) => rpcResult(request, () => ({
          items: [{ workspaceId, path: workspacePath, sessionIds: [...this.gatewaySessions.keys()] }],
          archivedSessionIds: []
        })),
        create: (request: unknown) => rpcResult(request, () => {
          const payload = isJsonObject(request) && isJsonObject(request.payload) ? request.payload : {};
          return { workspaceId: stringValue(payload.workspaceId, workspaceId), path: workspacePath };
        })
      },
      sessions: {
        list: (request: unknown) => rpcResult(request, listSessions),
        create: (request: unknown) => rpcResult(request, () => {
          const payload = isJsonObject(request) && isJsonObject(request.payload) ? request.payload : {};
          const sessionId = stringValue(payload.sessionId, `dsh-im-${Date.now().toString(36)}`);
          this.ensureGatewaySession(sessionId, { cwd: workspacePath });
          return { sessionId };
        }),
        history: (request: unknown) => rpcResult(request, () => {
          const payload = isJsonObject(request) && isJsonObject(request.payload) ? request.payload : {};
          return this.gatewayHistoryPage(stringValue(payload.sessionId), payload);
        }),
        prompt: (request: unknown) => rpcResult(request, () => this.forwardPromptToMain('apiProxy.sessions.prompt', request)),
        rename: (request: unknown) => rpcResult(request, () => ({})),
        cancel: (request: unknown) => rpcResult(request, () => ({ cancelled: false }))
      },
      llm: {
        models: (request: unknown) => rpcResult(request, () => ({ items: [] }))
      },
      events: {
        mux: (_request: unknown, signal?: AbortSignal) => emptyAsyncIterator(signal)
      }
    };
  }

  private createTypertGatewayService(): JsonObject {
    const workspaceId = 'default';
    const workspacePath = resolve(process.cwd());
    const invoke = async (request: unknown) => {
      if (!isJsonObject(request)) throw createGatewayError('unknown', 'bad-request', 'Typert gateway request must be an object.');
      const namespace = stringValue(request.namespace).trim();
      const method = stringValue(request.method).trim();
      const args = isJsonObject(request.args) ? request.args : {};
      const endpoint = `${namespace}/${method}`;
      if (namespace === 'workspace' && method === 'create') return { workspaceId, path: workspacePath };
      if (namespace === 'session' && method === 'list') {
        return {
          items: [...this.gatewaySessions.values()].map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd ?? workspacePath,
            running: this.gatewayRunningTurns.has(stringValue(session.sessionId)),
            projections: { values: { title: session.title ?? null } }
          }))
        };
      }
      if (namespace === 'session' && method === 'create') {
        const req = isJsonObject(args.request) ? args.request : {};
        const sessionId = stringValue(req.sessionId, `dsh-im-${Date.now().toString(36)}`);
        this.ensureGatewaySession(sessionId, { cwd: workspacePath });
        return { sessionId };
      }
      if (namespace === 'session' && method === 'page') {
        const req = isJsonObject(args.request) ? args.request : args;
        return this.gatewayHistoryPage(stringValue(req.sessionId), req);
      }
      if (namespace === 'session' && method === 'history') {
        const req = isJsonObject(args.request) ? args.request : args;
        return this.gatewayHistoryPage(stringValue(req.sessionId), req);
      }
      if (namespace === 'session' && method === 'modelCatalog') return {
        default: { provider: 'tasi', model: 'default' },
        routableProviders: ['tasi'],
        groups: [],
        failures: []
      };
      if (namespace === 'session' && method === 'prompt') {
        return await this.forwardPromptToMain(endpoint, args);
      }
      if (namespace === 'commands' && method === 'execute') {
        return await this.forwardPromptToMain(endpoint, args);
      }
      throw createGatewayError(endpoint, 'not-found', `Unsupported Typert gateway endpoint: ${endpoint}`);
    };
    const stream = async (request: unknown) => {
      if (!isJsonObject(request)) throw createGatewayError('unknown', 'bad-request', 'Typert gateway stream request must be an object.');
      const namespace = stringValue(request.namespace).trim();
      const method = stringValue(request.method).trim();
      if (namespace === 'workspace' && method === 'follow') {
        return singleAsyncIterator({
          type: 'baseline',
          value: {
            items: [{ workspaceId, path: workspacePath, sessionIds: [...this.gatewaySessions.keys()] }],
            archivedSessionIds: []
          }
        });
      }
      if (namespace === 'session' && method === 'follow') {
        return singleAsyncIterator({
          type: 'snapshot',
          cursor: 0,
          records: [],
          hasMore: false,
          projections: { values: {} }
        });
      }
      throw createGatewayError(`${namespace}/${method}`, 'not-found', `Unsupported Typert gateway stream: ${namespace}/${method}`);
    };
    return { invoke, stream };
  }

  private async forwardPromptToMain(endpoint: string, payload: unknown): Promise<JsonObject> {
    if (!this.options.mainRequest) {
      throw createGatewayError(endpoint, 'executor-unavailable', 'Tasi sidecar has no main agent loop bridge.');
    }
    const request = normalizeMainChatRunRequest(endpoint, payload);
    if (isQueuedPromptEndpoint(endpoint)) {
      this.enqueuePromptToMain(request);
      return {
        accepted: true,
        queued: true,
        sessionId: stringValue(request.sessionId),
        promptRpcId: stringValue(request.promptRpcId)
      };
    }
    const value = await this.options.mainRequest('main.chat.run', request);
    return normalizeMainChatRunResult(value);
  }

  private enqueuePromptToMain(request: JsonObject): void {
    const sessionId = stringValue(request.sessionId, `dsh-im-${Date.now().toString(36)}`);
    const promptRpcId = stringValue(request.promptRpcId, `dsh-${Date.now().toString(36)}`);
    const turn = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.ensureGatewaySession(sessionId, { cwd: stringValue(request.workspaceDir) || resolve(process.cwd()) });
    this.gatewayRunningTurns.set(sessionId, turn);
    this.appendGatewayEvent(sessionId, 'turn/start', { turn });
    this.appendGatewayEvent(sessionId, 'user/message', {
      turn,
      source: { rpcId: promptRpcId, kind: 'dsh-sidecar' },
      message: {
        role: 'user',
        content: [{ type: 'text', text: stringValue(request.input) }]
      }
    });
    void this.options.mainRequest?.('main.chat.run', request).then((value) => {
      const result = normalizeMainChatRunResult(value);
      const content = stringValue(result.content) || stringValue(result.finalResponse);
      if (content) {
        this.appendGatewayEvent(sessionId, 'assistant/message', {
          turn,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: content }]
          }
        });
      }
      this.appendGatewayEvent(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    }, (error) => {
      this.appendGatewayEvent(sessionId, 'assistant/message', {
        turn,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Tasi agent loop failed: ${errorMessage(error)}` }]
        }
      });
      this.appendGatewayEvent(sessionId, 'turn/end', { turn, reason: { kind: 'error', error: gatewayFailure(error) } });
    }).finally(() => {
      if (this.gatewayRunningTurns.get(sessionId) === turn) this.gatewayRunningTurns.delete(sessionId);
    });
  }

  private ensureGatewaySession(sessionId: string, patch?: JsonObject): JsonObject {
    const id = sessionId.trim() || `dsh-im-${Date.now().toString(36)}`;
    const current = this.gatewaySessions.get(id) ?? { sessionId: id, title: null, cwd: resolve(process.cwd()) };
    const next = { ...current, ...objectValue(patch), sessionId: id };
    this.gatewaySessions.set(id, next);
    return next;
  }

  private appendGatewayEvent(sessionId: string, type: string, data: JsonObject): JsonObject {
    const history = this.gatewayHistories.get(sessionId) ?? [];
    const event = {
      seq: history.length,
      type,
      data,
      time: Date.now()
    };
    history.push(event);
    if (history.length > 300) history.splice(0, history.length - 300);
    this.gatewayHistories.set(sessionId, history);
    return event;
  }

  private gatewayHistoryPage(sessionId: string, request: JsonObject): JsonObject {
    if (!sessionId.trim()) throw createGatewayError('session/history', 'session-not-found', 'Session id is required.');
    this.ensureGatewaySession(sessionId);
    const maxMessages = Math.max(1, Math.min(100, Math.floor(Number(request.maxMessages ?? request.limit) || 50)));
    const beforeSeq = Number.isSafeInteger(Number(request.beforeSeq)) ? Number(request.beforeSeq) : undefined;
    const history = this.gatewayHistories.get(sessionId) ?? [];
    const filtered = beforeSeq === undefined ? history : history.filter((event) => Number(event.seq) < beforeSeq);
    const events = filtered.slice(-maxMessages).map((event) => ({ event }));
    return { events, records: events, hasMore: filtered.length > maxMessages };
  }

  private createAgent(params: {
    sessionId: string;
    workspaceDir: string;
    llm?: HostLlmConfig;
    parentSession?: string;
    followup?: (value: unknown) => void;
  }): JsonObject {
    const config = this.normalizeLlmConfig(params.llm);
    const events: unknown[] = [];
    const header = {
      id: params.sessionId,
      cwd: params.workspaceDir,
      origin: params.parentSession ? 'subagent' : 'user',
      seedLength: 0,
      parentSession: params.parentSession,
      config
    };
    const session = {
      header,
      get id() {
        return params.sessionId;
      },
      get events() {
        return events;
      },
      get seq() {
        return events.length;
      },
      firstLiveSeq: 0,
      append: (type: string, data: unknown, opts?: unknown) => {
        const event = {
          id: `${params.sessionId}:${events.length + 1}`,
          seq: events.length + 1,
          type,
          data,
          opts,
          createdAt: new Date().toISOString()
        };
        events.push(event);
        return event;
      },
      requestHeader: () => ({ ...header }),
      requestContext: () => ({
        sessionId: params.sessionId,
        cwd: params.workspaceDir,
        config
      }),
      deriveMessages: () => [],
      deriveEventMessage: () => null
    };
    return {
      id: params.sessionId,
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      options: config,
      session,
      followup: params.followup ?? (() => undefined)
    };
  }

  private normalizeLlmConfig(input?: HostLlmConfig): Required<HostLlmConfig> {
    return {
      provider: input?.provider?.trim() || 'tasi',
      model: input?.model?.trim() || 'default',
      reasoningEffort: input?.reasoningEffort?.trim() || 'medium'
    };
  }

  private createLlmService(): JsonObject {
    return {
      listModels: async () => [],
      resolveCallConfig: async (config: unknown) => {
        const input = isJsonObject(config) ? config : {};
        return this.normalizeLlmConfig({
          provider: stringValue(input.provider, 'tasi'),
          model: stringValue(input.model, 'default'),
          reasoningEffort: stringValue(input.reasoningEffort, 'medium')
        });
      }
    };
  }

  private createToolsService(): JsonObject {
    return {
      register: (raw: DshToolLike) => {
        const definition = normalizeToolDefinition(raw);
        const registered: RegisteredCordisTool = { pluginId: this.currentPluginId || 'unknown', raw, definition };
        this.tools.set(definition.function.name, registered);
        this.emit('tools/change');
        return () => {
          if (this.tools.get(definition.function.name) === registered) this.tools.delete(definition.function.name);
          this.emit('tools/change');
        };
      },
      schemas: () => this.toolDefinitions(),
      execute: async (exec: { name?: unknown; arguments?: unknown; callId?: unknown }) => {
        const name = typeof exec.name === 'string' ? exec.name : '';
        const context = {
          sessionId: 'dsh-sidecar',
          workspaceDir: process.cwd(),
          requestId: typeof exec.callId === 'string' ? exec.callId : `dsh-${Date.now().toString(36)}`
        };
        const result = await this.callTool({ name, args: exec.arguments, context });
        if (!result) throw new Error(`Unknown DSH tool: ${name}`);
        return result;
      }
    };
  }

  private createCommandsService(): JsonObject {
    return {
      register: (nameOrDefinition: unknown, handler?: CordisHandler) => {
        const name = commandName(nameOrDefinition);
        this.registerCommand(name, nameOrDefinition, handler);
        this.recordPluginValue('commands', name);
        return noopDisposer(handler);
      },
      registerSlash: (nameOrDefinition: unknown, handler?: CordisHandler) => {
        const name = commandName(nameOrDefinition);
        const slashName = name.startsWith('/') ? name : `/${name}`;
        this.registerCommand(slashName, nameOrDefinition, handler);
        this.recordPluginValue('commands', slashName);
        return noopDisposer(handler);
      }
    };
  }

  private createSettingsService(): JsonObject {
    const values = new Map<string, unknown>();
    return {
      register: (namespace: string, _schema?: unknown, options?: { validate?: unknown }) => {
        this.recordPluginValue('settingsEntries', namespace);
        const initial = {};
        const validate = options?.validate;
        const value = typeof validate === 'function' ? validate(initial) : initial;
        values.set(namespace, value);
        return {
          get: () => values.get(namespace) ?? {},
          set: (next: unknown) => {
            values.set(namespace, next);
          },
          watch: (_listener: CordisHandler) => noopDisposer()
        };
      }
    };
  }

  private createSkillsService(): JsonObject {
    const materialize = (raw: unknown, controller: AbortController): unknown => {
      if (typeof raw !== 'function') return raw;
      return (raw as CordisHandler)({
        signal: controller.signal,
        invalidate: () => this.emit('skills/change')
      });
    };
    const providerName = (provider: unknown): string => {
      const name = stringValue(objectValue(provider).name).trim();
      return cleanMountId(name || `provider-${this.skillProviders.size + 1}`);
    };
    const providers = () => [...this.skillProviders.values()];
    const providerCandidates = async (registered: RegisteredSkillProvider, options?: unknown): Promise<unknown[]> => {
      return await this.providerSkillCandidates(registered, options);
    };
    const list = async (options?: unknown) => {
      const all: unknown[] = [...this.runtimeSkills.values()].map((skill) => skill.raw);
      for (const registered of providers()) all.push(...await providerCandidates(registered, options));
      return all;
    };
    return {
      registerProvider: (providerOrFactory: unknown) => {
        const controller = new AbortController();
        const provider = materialize(providerOrFactory, controller);
        const name = providerName(provider);
        const registered: RegisteredSkillProvider = {
          pluginId: this.currentPluginId || 'unknown',
          name,
          raw: provider
        };
        this.skillProviders.set(name, registered);
        this.recordPluginValue('providedServices', `skills:${name}`);
        this.emit('skills/change');
        return () => {
          if (this.skillProviders.get(name) === registered) this.skillProviders.delete(name);
          controller.abort(new Error(`skill provider "${name}" disposed`));
          this.emit('skills/change');
        };
      },
      register: (skill: unknown) => {
        const input = objectValue(skill);
        const name = stringValue(input.name).trim();
        if (!name) throw new Error('skills.register requires a skill name.');
        const definition = {
          ...input,
          invocation: objectValue(input.invocation).modelInvocable === undefined
            ? { modelInvocable: true, userInvocable: true }
            : input.invocation,
          provider: stringValue(input.provider, 'runtime') || 'runtime'
        };
        this.runtimeSkills.set(name, {
          pluginId: this.currentPluginId || 'unknown',
          name,
          raw: definition
        });
        this.recordPluginValue('providedServices', `skills:runtime:${name}`);
        this.emit('skills/change');
        return () => {
          if (this.runtimeSkills.get(name)?.raw === definition) this.runtimeSkills.delete(name);
          this.emit('skills/change');
        };
      },
      getProvider: (name: string) => this.skillProviders.get(name)?.raw,
      listProviders: () => providers().map((provider) => provider.name),
      list,
      snapshot: async (options?: unknown) => ({ skills: await list(options), complete: true }),
      get: async (candidate: unknown, options?: unknown) => {
        const requestedName = typeof candidate === 'string' ? candidate.trim() : stringValue(objectValue(candidate).name).trim();
        if (requestedName && this.runtimeSkills.has(requestedName)) return this.runtimeSkills.get(requestedName)?.raw;
        const requestedProvider = stringValue(objectValue(candidate).provider).trim();
        const search = requestedProvider
          ? providers().filter((provider) => provider.name === requestedProvider)
          : providers();
        for (const registered of search) {
          const provider = objectValue(registered.raw);
          if (typeof provider.get !== 'function') continue;
          const providerCandidate = typeof candidate === 'string'
            ? (await providerCandidates(registered, options)).find((item) => stringValue(objectValue(item).name) === requestedName)
            : candidate;
          if (providerCandidate === undefined) continue;
          const skill = await (provider.get as CordisHandler)(providerCandidate, options ?? {});
          if (skill !== undefined) return skill;
        }
        return undefined;
      },
      on: (name: string, handler: CordisHandler) => this.on(`skills/${name}`, handler)
    };
  }

  private createSystemPromptService(): JsonObject {
    const sections: unknown[] = [];
    const registerSection = (section: unknown) => {
      sections.push(section);
      return noopDisposer();
    };
    return {
      register: registerSection,
      append: registerSection,
      section: registerSection,
      context: registerSection,
      getContextOrder: (name: unknown) => {
        const orders: Record<string, number> = {
          SANDBOX_POLICY: 40,
          SKILLS: 60,
          TOOLS: 70
        };
        return orders[stringValue(name)] ?? 100;
      },
      sections: () => [...sections],
      contexts: () => [...sections]
    };
  }

  private createWebService(): JsonObject {
    return {
      registerSearchProvider: (provider: unknown) => {
        const input = objectValue(provider);
        const id = stringValue(input.id).trim() || `provider-${this.searchProviders.size + 1}`;
        const registered: RegisteredSearchProvider = {
          pluginId: this.currentPluginId || 'unknown',
          id,
          raw: provider
        };
        this.searchProviders.set(id, registered);
        this.recordPluginValue('providedServices', `web:searchProvider:${id}`);
        this.emit('web/search-providers/change');
        return () => {
          if (this.searchProviders.get(id) === registered) this.searchProviders.delete(id);
          this.emit('web/search-providers/change');
        };
      },
      listSearchProviders: () => [...this.searchProviders.values()].map((provider) => provider.id),
      getSearchProvider: (id: string) => this.searchProviders.get(id)?.raw,
      search: async (request: unknown, signal?: AbortSignal) => {
        const provider = [...this.searchProviders.values()][0];
        const raw = objectValue(provider?.raw);
        if (typeof raw.search !== 'function') throw new Error('No DSH web search provider is registered.');
        return await (raw.search as CordisHandler)(request, signal);
      }
    };
  }

  private createAttachmentsService(): JsonObject {
    return {
      readImage: async (attachment: unknown) => {
        const input = objectValue(attachment);
        const ref = objectValue(input.ref);
        const mediaType = stringValue(input.mediaType ?? input.mimeType ?? input.mime ?? ref.mediaType, 'image/png');
        const data = input.data;
        if (data instanceof Uint8Array) return { ref: { ...ref, mediaType }, data };
        if (Array.isArray(data)) return { ref: { ...ref, mediaType }, data: Uint8Array.from(data.map((item) => Number(item) || 0)) };
        if (typeof data === 'string' && data.trim()) return { ref: { ...ref, mediaType }, data: Buffer.from(data, 'base64') };
        const base64 = stringValue(input.base64 ?? input.contentBase64).trim();
        if (base64) return { ref: { ...ref, mediaType }, data: Buffer.from(base64, 'base64') };
        const path = stringValue(input.path ?? ref.path).trim();
        if (path && existsSync(path)) return { ref: { ...ref, mediaType, path }, data: readFileSync(path) };
        throw new Error('Attachment image bytes are unavailable in the Tasi sidecar host.');
      }
    };
  }

  private createStorageService(): JsonObject {
    const backends = new Map<string, unknown>();
    const forms = new Map<string, unknown>();
    const backendRegistry = {
      register: (nameOrBackend: unknown, backend?: unknown) => {
        const candidate = typeof nameOrBackend === 'string' ? backend : nameOrBackend;
        const name = typeof nameOrBackend === 'string'
          ? nameOrBackend.trim()
          : stringValue(objectValue(nameOrBackend).name).trim();
        if (!name) throw new Error('storage.backend.register requires a backend name.');
        backends.set(name, candidate);
        this.services.set(`storage.backend.${name}`, candidate);
        this.recordPluginValue('providedServices', `storage.backend.${name}`);
        return () => {
          if (backends.get(name) === candidate) backends.delete(name);
          if (this.services.get(`storage.backend.${name}`) === candidate) this.services.delete(`storage.backend.${name}`);
        };
      },
      get: (name: string) => {
        const backend = backends.get(name);
        if (backend === undefined) throw new Error(`storage backend '${name}' is not registered`);
        return backend;
      },
      has: (name: string) => backends.has(name),
      list: () => [...backends.keys()],
      entries: () => backends.entries()
    };
    const service: JsonObject = {
      backend: backendRegistry,
      mount: (form: unknown, facility: unknown) => {
        const name = stringValue(form).trim();
        if (!name) throw new Error('storage.mount requires a form name.');
        if (forms.has(name)) throw new Error(`storage form '${name}' is already mounted`);
        forms.set(name, facility);
        return () => {
          if (forms.get(name) === facility) forms.delete(name);
        };
      },
      form: (form: unknown) => {
        const name = stringValue(form).trim();
        if (!forms.has(name)) throw new Error(`storage form '${name}' is not mounted`);
        return forms.get(name);
      },
      get domain() {
        return forms.get('domain');
      }
    };
    const defaultBackend = {
      name: 'tasi-json',
      kv: {
        open: async (descriptor: unknown) => this.openStorageKvUnit(descriptor)
      }
    };
    backendRegistry.register('tasi-json', defaultBackend);
    backendRegistry.register('json', defaultBackend);
    backendRegistry.register('default', defaultBackend);
    return service;
  }

  private createStorageDomainService(storage: JsonObject): JsonObject {
    const domains = new Map<string, JsonObject>();
    const facility: JsonObject = {
      open: async (spec: unknown) => {
        const input = objectValue(spec);
        const name = stringValue(input.name, `domain-${domains.size + 1}`).trim();
        if (!name) throw new Error('storageDomain.open requires a domain name.');
        if (domains.has(name)) throw new Error(`domain '${name}' is already open`);
        const domain = this.openStorageDomain(input, name, () => {
          domains.delete(name);
        });
        domains.set(name, domain);
        return domain;
      },
      get: (name: string) => domains.get(name),
      closeAll: async () => {
        for (const domain of domains.values()) {
          const close = domain.close;
          if (typeof close === 'function') await close();
        }
        domains.clear();
      }
    };
    const mount = storage.mount;
    if (typeof mount === 'function') mount('domain', facility);
    return facility;
  }

  private openStorageKvUnit(descriptor: unknown): JsonObject {
    const input = objectValue(descriptor);
    const name = stringValue(input.name ?? input.unit ?? input.domain, 'default');
    const file = this.storageDomainFile(`kv-${name}`);
    const read = () => this.readJsonObject(file);
    const write = (state: JsonObject) => this.writeJsonObject(file, state);
    return {
      loadAll: async () => {
        const state = read();
        return {
          global: Object.prototype.hasOwnProperty.call(state, 'global') ? state.global : null,
          tables: objectValue(state.tables)
        };
      },
      saveAll: async (snapshot: unknown) => {
        const inputSnapshot = objectValue(snapshot);
        write({
          global: Object.prototype.hasOwnProperty.call(inputSnapshot, 'global') ? inputSnapshot.global : null,
          tables: objectValue(inputSnapshot.tables)
        });
      },
      close: async () => undefined
    };
  }

  private openStorageDomain(spec: JsonObject, name: string, onClose: () => void): JsonObject {
    const file = this.storageDomainFile(name);
    const read = () => {
      const state = this.readJsonObject(file);
      return {
        global: Object.prototype.hasOwnProperty.call(state, 'global') ? state.global : initialDomainGlobal(spec),
        tables: objectValue(state.tables)
      };
    };
    const write = (state: { global: unknown; tables: JsonObject }) => {
      this.writeJsonObject(file, state as unknown as JsonObject);
      this.emit('domain/changed', { domain: name });
    };
    const table = (tableName: unknown) => {
      const cleanName = stringValue(tableName).trim();
      if (!cleanName) throw new Error('domain.table requires a table name.');
      return this.openStorageDomainTable(read, write, cleanName);
    };
    const global = {
      get: () => read().global,
      set: async (value: unknown) => {
        const state = read();
        write({ ...state, global: value });
      },
      update: async (updater: unknown) => {
        if (typeof updater !== 'function') throw new Error('domain.global.update requires an updater function.');
        const state = read();
        const value = await (updater as CordisHandler)(state.global);
        write({ ...state, global: value });
        return value;
      }
    };
    return {
      name,
      spec,
      global,
      table,
      close: async () => {
        onClose();
      }
    };
  }

  private openStorageDomainTable(
    read: () => { global: unknown; tables: JsonObject },
    write: (state: { global: unknown; tables: JsonObject }) => void,
    tableName: string
  ): JsonObject {
    const records = () => objectValue(read().tables[tableName]);
    const commit = (nextRecords: JsonObject) => {
      const state = read();
      write({ ...state, tables: { ...state.tables, [tableName]: nextRecords } });
    };
    const table: JsonObject = {
      get size() {
        return Object.keys(records()).length;
      },
      get: (key: unknown) => records()[String(key)],
      has: (key: unknown) => Object.prototype.hasOwnProperty.call(records(), String(key)),
      put: async (key: unknown, value: unknown) => {
        commit({ ...records(), [String(key)]: value });
      },
      set: async (key: unknown, value: unknown) => {
        commit({ ...records(), [String(key)]: value });
      },
      update: async (key: unknown, updater: unknown) => {
        if (typeof updater !== 'function') throw new Error('domain table update requires an updater function.');
        const id = String(key);
        const value = await (updater as CordisHandler)(records()[id]);
        commit({ ...records(), [id]: value });
        return value;
      },
      delete: async (key: unknown) => {
        const next = { ...records() };
        const existed = Object.prototype.hasOwnProperty.call(next, String(key));
        delete next[String(key)];
        commit(next);
        return existed;
      },
      clear: async () => {
        commit({});
      },
      keys: () => Object.keys(records()).values(),
      values: () => Object.values(records()).values(),
      entries: () => Object.entries(records()).values(),
      toJSON: () => records(),
      [Symbol.iterator]: function* () {
        yield* Object.entries(records());
      }
    };
    return table;
  }

  private storageDomainFile(name: string): string {
    return resolve(this.options.sidecarHome, 'profiles', this.options.profileName, 'storage-domains', `${cleanMountId(name)}.json`);
  }

  private readJsonObject(file: string): JsonObject {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return objectValue(parsed);
    } catch {
      return {};
    }
  }

  private writeJsonObject(file: string, value: JsonObject): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  private createWebServerService(): JsonObject {
    return {
      register: (route: unknown) => {
        const routeObject = isJsonObject(route) ? route : {};
        const path = typeof routeObject.path === 'string' ? routeObject.path : '(unknown)';
        const kind = routeObject.kind === 'prefix' ? 'prefix' : 'exact';
        const handler = typeof routeObject.handler === 'function' ? routeObject.handler as CordisHandler : undefined;
        const key = `${this.currentPluginId || 'unknown'}:${kind}:${path}`;
        this.webRoutes.set(key, {
          pluginId: this.currentPluginId || 'unknown',
          kind,
          path,
          handler,
          raw: routeObject
        });
        this.recordPluginValue('webRoutes', path);
        return () => {
          this.webRoutes.delete(key);
        };
      },
      tapIndex: (handler: unknown) => {
        if (typeof handler !== 'function') throw new Error('webServer.tapIndex requires a handler function.');
        const pluginId = this.currentPluginId || 'unknown';
        const key = `${pluginId}:tapIndex:${this.indexTaps.size}`;
        this.indexTaps.set(key, { pluginId, handler: handler as CordisHandler });
        this.recordPluginValue('providedServices', 'webServer:tapIndex');
        return () => {
          this.indexTaps.delete(key);
        };
      }
    };
  }

  private createClientRuntimeService(): JsonObject {
    const entries: DshSidecarClientMount[] = [];
    const register = (entry: unknown, options?: unknown) => {
      const mount = this.normalizeClientMount(entry, options);
      entries.push(mount);
      this.updateCurrentClientMounts(entries);
      this.recordPluginValue('providedServices', `clientRuntime:${mount.mountPoint}:${mount.id}`);
      return () => {
        const index = entries.findIndex((item) => item.id === mount.id && item.pluginId === mount.pluginId);
        if (index >= 0) entries.splice(index, 1);
        this.updateCurrentClientMounts(entries);
      };
    };
    return {
      register,
      registerMount: register,
      registerPage: register,
      registerPanel: (entry: unknown, options?: unknown) => register({ ...objectValue(entry), mountPoint: 'right-panel' }, options),
      registerSidebar: (entry: unknown, options?: unknown) => register({ ...objectValue(entry), mountPoint: 'sidebar' }, options),
      registerSettings: (entry: unknown, options?: unknown) => register({ ...objectValue(entry), mountPoint: 'settings' }, options),
      registerFloating: (entry: unknown, options?: unknown) => register({ ...objectValue(entry), mountPoint: 'floating' }, options),
      registerDesktopCompanion: (entry: unknown, options?: unknown) => register({ ...objectValue(entry), mountPoint: 'desktop-companion' }, options),
      list: () => [...entries]
    };
  }

  private normalizeClientMount(entry: unknown, options?: unknown): DshSidecarClientMount {
    const input = objectValue(entry);
    const optionObject = objectValue(options);
    const pluginId = this.currentPluginId || 'unknown';
    const current = this.plugins.get(pluginId);
    const packageName = current?.packageName ?? pluginId;
    const id = cleanMountId(stringValue(input.id) || stringValue(input.name) || stringValue(input.key) || packageName);
    const title = stringValue(input.title) || stringValue(input.label) || stringValue(input.name) || packageName;
    const mountPoint = normalizeClientMountPoint(
      stringValue(input.mountPoint)
      || stringValue(input.slot)
      || stringValue(input.area)
      || stringValue(input.placement)
      || stringValue(optionObject.mountPoint)
    );
    const declaredUrl = stringValue(input.url) || stringValue(input.href) || stringValue(input.route) || stringValue(input.path);
    const url = clientMountUrl(this.options.clientBaseUrl, pluginId, id, declaredUrl);
    const rawPermissions = input.permissions ?? optionObject.permissions;
    return {
      id,
      pluginId,
      packageName,
      title,
      mountPoint,
      url,
      icon: stringValue(input.icon) || undefined,
      description: stringValue(input.description) || undefined,
      permissions: Array.isArray(rawPermissions) ? rawPermissions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : undefined
    };
  }

  private updateCurrentClientMounts(entries: DshSidecarClientMount[]): void {
    if (!this.currentPluginId) return;
    this.updatePlugin(this.currentPluginId, {
      clientMounts: entries.filter((entry) => entry.pluginId === this.currentPluginId)
    });
  }

  private createJobsService(): JsonObject {
    return {
      list: () => [],
      onJobDone: (handler: CordisHandler) => this.on('jobs/done', handler),
      on: (name: string, handler: CordisHandler) => this.on(`jobs/${name}`, handler)
    };
  }

  private createSessionProjectionsService(): JsonObject {
    const entries = new Map<string, JsonObject>();
    const initialState = (definition: JsonObject) => {
      const init = definition.init;
      if (typeof init === 'function') return init();
      return Object.prototype.hasOwnProperty.call(definition, 'initial') ? definition.initial : null;
    };
    const stateOf = (session: unknown, key: unknown) => {
      const name = stringValue(key).trim();
      const definition = entries.get(name);
      if (!definition) return undefined;
      let state = initialState(definition);
      const apply = definition.apply;
      const events = Array.isArray(objectValue(session).events) ? objectValue(session).events as unknown[] : [];
      if (typeof apply === 'function') {
        for (const event of events) state = apply(state, event);
      }
      return state;
    };
    const faceOf = (session: unknown, key: unknown) => ({
      getSnapshot: () => stateOf(session, key),
      subscribe: (handler: CordisHandler) => this.on(`sessionProjections/${stringValue(key)}`, handler)
    });
    return {
      register: (definition: unknown) => {
        const input = objectValue(definition);
        const key = stringValue(input.key ?? input.name).trim();
        if (!key) throw new Error('sessionProjections.register requires a key.');
        entries.set(key, input);
        this.recordPluginValue('providedServices', `sessionProjections:${key}`);
        this.emit(`sessionProjections/${key}`);
        return () => {
          if (entries.get(key) === input) entries.delete(key);
          this.emit(`sessionProjections/${key}`);
        };
      },
      list: () => [...entries.values()],
      stateOf,
      faceOf,
      registerContext: (definition: unknown) => {
        const context = objectValue(this.services.get('systemPrompt')).context;
        return typeof context === 'function' ? context(definition) : noopDisposer();
      }
    };
  }

  private createSubagentsService(): JsonObject {
    const providers = new Map<string, unknown>();
    const nativeSpawnProvider = this.createNativeSubagentSpawnProvider();
    if (nativeSpawnProvider) providers.set('spawn', nativeSpawnProvider);
    const continuableSetups = new Set<CordisHandler>();
    const unavailable = async () => {
      throw new Error('Tasi DSH sidecar loaded the plugin, but no upstream subagent executor is connected to this standalone host yet.');
    };
    return {
      registerProvider: (nameOrProvider: unknown, provider?: unknown) => {
        const providerName = typeof nameOrProvider === 'string'
          ? nameOrProvider
          : stringValue(isJsonObject(nameOrProvider) ? nameOrProvider.name : undefined);
        if (!providerName.trim()) throw new Error('subagents.registerProvider requires a provider name.');
        providers.set(providerName, provider ?? nameOrProvider);
        this.recordPluginValue('providedServices', `subagents:${providerName}`);
        this.emit('subagents/change');
        return () => {
          providers.delete(providerName);
          this.emit('subagents/change');
        };
      },
      registerContinuableSetup: (handler: CordisHandler) => {
        if (typeof handler !== 'function') throw new Error('subagents.registerContinuableSetup requires a function.');
        continuableSetups.add(handler);
        this.recordPluginValue('providedServices', `subagents:continuable-setup:${continuableSetups.size}`);
        return () => {
          continuableSetups.delete(handler);
        };
      },
      getProvider: (name: string) => providers.get(name),
      list: () => [...providers.keys()],
      setups: () => [...continuableSetups],
      startContinuable: unavailable,
      followup: unavailable,
      spawn: async (...values: unknown[]) => this.spawnNativeSubagent(values),
      interrupt: () => undefined
    };
  }

  private createNativeSubagentSpawnProvider(): JsonObject | undefined {
    if (!this.options.mainRequest) return undefined;
    const run = async (...values: unknown[]) => this.spawnNativeSubagent(values);
    return {
      name: 'spawn',
      provider: 'spawn',
      spawn: run,
      run,
      start: run,
      execute: run
    };
  }

  private async spawnNativeSubagent(values: unknown[]): Promise<JsonObject> {
    if (!this.options.mainRequest) {
      throw new Error('Tasi DSH sidecar loaded the plugin, but no upstream subagent executor is connected to this standalone host yet.');
    }
    const raw = values.length <= 1 ? values[0] : { request: values[0], options: values[1], args: values };
    const candidates = subagentPayloadCandidates(raw);
    const activeAgent = this.activeAgents.at(-1);
    const activeAgentOptions = objectValue(activeAgent?.options);
    const parts = normalizePromptParts(candidates);
    const name = firstStringField(candidates, ['name', 'agentName', 'agent_name', 'member', 'assignee']) ?? 'subagent';
    const role = firstStringField(candidates, ['role', 'title', 'persona', 'specialty']);
    const parentSession = firstStringField(candidates, ['parentSession', 'parentSessionId', 'parent_session', 'parent_session_id'])
      ?? stringValue(activeAgent?.sessionId)
      ?? 'dsh-sidecar';
    const sessionId = firstStringField(candidates, ['sessionId', 'session_id', 'childSessionId', 'child_session_id'])
      ?? nativeSubagentSessionId(parentSession, name);
    const input = subagentPromptText(candidates, parts, name, role, parentSession);
    if (!input.trim()) throw new Error('subagents.spawn requires a prompt, task, description, or input text.');
    const llm = this.normalizeLlmConfig({
      provider: firstStringField(candidates, ['provider'])
        ?? firstStringField(candidates.map((item) => objectValue(item.llm)), ['provider'])
        ?? stringValue(activeAgentOptions.provider),
      model: firstStringField(candidates, ['model'])
        ?? firstStringField(candidates.map((item) => objectValue(item.llm)), ['model'])
        ?? stringValue(activeAgentOptions.model),
      reasoningEffort: firstStringField(candidates, ['reasoningEffort', 'reasoning_effort'])
        ?? firstStringField(candidates.map((item) => objectValue(item.llm)), ['reasoningEffort', 'reasoning_effort'])
        ?? stringValue(activeAgentOptions.reasoningEffort)
    });
    const workspaceDir = firstStringField(candidates, ['workspaceDir', 'workspacePath', 'cwd', 'path', 'workingDirectory'])
      ?? stringValue(activeAgent?.workspaceDir)
      ?? resolve(process.cwd());
    const value = await this.options.mainRequest('main.chat.run', {
      source: 'dsh-subagent',
      sessionId,
      parentSession,
      workspaceDir,
      input,
      parts: parts.length > 0 ? parts : [{ type: 'text', text: input }],
      provider: llm.provider,
      model: llm.model,
      reasoningEffort: llm.reasoningEffort,
      llm,
      external: {
        provider: 'subagent',
        pluginId: firstStringField(candidates, ['pluginId', 'plugin_id']) ?? 'dsh-agent-teams',
        scope: 'private',
        externalConversationId: sessionId,
        senderId: name,
        senderName: name,
        displayName: role ? `${name} (${role})` : name
      },
      raw
    });
    const result = normalizeMainChatRunResult(value);
    const content = stringValue(result.content) || stringValue(result.finalResponse);
    return {
      ok: true,
      provider: 'spawn',
      name,
      role,
      sessionId: stringValue(result.sessionId, sessionId),
      parentSession,
      content,
      finalResponse: content,
      result: result.value ?? value
    };
  }

  private createWorkspaceRegistryService(): JsonObject {
    const workspaces = new Map<string, DshWorkspaceRecord>();
    const archivedSessionIds = new Set<string>();
    const workspaceView = (record: DshWorkspaceRecord): JsonObject => ({
      workspaceId: record.workspaceId,
      id: record.id,
      path: record.path,
      get title() {
        return workspaces.get(record.workspaceId)?.title ?? record.title;
      },
      get sessionIds() {
        return [...(workspaces.get(record.workspaceId)?.sessionIds ?? record.sessionIds)];
      },
      get createdAt() {
        return workspaces.get(record.workspaceId)?.createdAt ?? record.createdAt;
      },
      get updatedAt() {
        return workspaces.get(record.workspaceId)?.updatedAt ?? record.updatedAt;
      },
      rename: async (title: unknown) => {
        const next = { ...record, title: stringValue(title, record.title), updatedAt: new Date().toISOString() };
        record.title = next.title;
        record.updatedAt = next.updatedAt;
        workspaces.set(record.workspaceId, next);
        this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
        return workspaceView(next);
      },
      delete: async () => {
        workspaces.delete(record.workspaceId);
        this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
        return true;
      },
      insertSessionBefore: async (sessionId: unknown, beforeSessionId?: unknown) => {
        const id = stringValue(sessionId).trim();
        if (!id) return record.sessionIds;
        const without = record.sessionIds.filter((item) => item !== id);
        const before = stringValue(beforeSessionId).trim();
        const at = before ? without.indexOf(before) : -1;
        const sessionIds = at >= 0 ? [...without.slice(0, at), id, ...without.slice(at)] : [...without, id];
        const next = { ...record, sessionIds, updatedAt: new Date().toISOString() };
        record.sessionIds = sessionIds;
        record.updatedAt = next.updatedAt;
        workspaces.set(record.workspaceId, next);
        this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
        return sessionIds;
      }
    });
    const create = async (inputPath: unknown, title?: unknown) => {
      const path = resolve(stringValue(inputPath, process.cwd()));
      for (const existing of workspaces.values()) {
        if (existing.path === path) return workspaceView(existing);
      }
      const now = new Date().toISOString();
      const id = `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const record: DshWorkspaceRecord = {
        workspaceId: id,
        id,
        path,
        title: stringValue(title).trim() || basename(path) || path,
        sessionIds: [],
        createdAt: now,
        updatedAt: now
      };
      workspaces.set(id, record);
      this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
      return workspaceView(record);
    };
    const listSource = this.observableSource(() => this.workspaceSnapshot(workspaces, archivedSessionIds), 'workspaceRegistry/change');
    return {
      create,
      get: (id: unknown) => {
        const record = workspaces.get(stringValue(id));
        return record ? workspaceView(record) : undefined;
      },
      list: Object.assign(() => [...workspaces.values()].map(workspaceView), listSource),
      resolveByPath: async (inputPath: unknown) => {
        const path = resolve(stringValue(inputPath, process.cwd()));
        const record = [...workspaces.values()].find((item) => item.path === path);
        return record ? workspaceView(record) : undefined;
      },
      delete: async (id: unknown) => {
        const removed = workspaces.delete(stringValue(id));
        if (removed) this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
        return removed;
      },
      insertBefore: async (id: unknown, beforeId?: unknown) => {
        const target = stringValue(id);
        if (!workspaces.has(target)) throw new Error(`Unknown workspace: ${target}`);
        const before = stringValue(beforeId);
        const entries = [...workspaces.entries()].filter(([key]) => key !== target);
        const targetRecord = workspaces.get(target) as DshWorkspaceRecord;
        const at = before ? entries.findIndex(([key]) => key === before) : -1;
        const nextEntries = at >= 0 ? [...entries.slice(0, at), [target, targetRecord] as const, ...entries.slice(at)] : [...entries, [target, targetRecord] as const];
        workspaces.clear();
        for (const [key, value] of nextEntries) workspaces.set(key, value);
        this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
        return [...workspaces.keys()];
      },
      archiveSession: async (sessionId: unknown) => {
        const id = stringValue(sessionId).trim();
        if (id) archivedSessionIds.add(id);
        this.emit('workspaceRegistry/change', this.workspaceSnapshot(workspaces, archivedSessionIds));
      },
      get archivedSessionIds() {
        return [...archivedSessionIds];
      },
      subscribe: (handler: CordisHandler) => this.on('workspaceRegistry/change', handler),
      getSnapshot: () => this.workspaceSnapshot(workspaces, archivedSessionIds)
    };
  }

  private workspaceSnapshot(workspaces: Map<string, DshWorkspaceRecord>, archivedSessionIds: Set<string>): JsonObject {
    const items = [...workspaces.values()].map((workspace) => ({
      workspaceId: workspace.workspaceId,
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt
    }));
    return {
      phase: 'ready',
      items,
      byId: Object.fromEntries(items.map((item) => [item.workspaceId, item])),
      archivedSessionIds: [...archivedSessionIds]
    };
  }

  private createSandboxPolicyService(): JsonObject {
    const defaultMode = 'workspace-write';
    const workspaceRoot = resolve(process.cwd());
    const resolvePolicy = (request?: unknown) => {
      const input = objectValue(request);
      const session = objectValue(input.session);
      const header = objectValue(session.header);
      return {
        mode: stringValue(input.mode, defaultMode),
        workspaceRoot: resolve(stringValue(header.cwd, workspaceRoot)),
        sessionId: stringValue(session.id ?? header.id) || undefined
      };
    };
    return {
      defaultMode,
      workspaceRoot,
      resolve: resolvePolicy,
      overrideOf: () => undefined,
      mapError: (error: unknown) => error
    };
  }

  private createLocaleService(): JsonObject {
    const dictionaries = new Map<string, Map<string, Record<string, string>>>();
    let active = 'zh';
    let revision = 0;
    const languages = new Map<string, JsonObject>([
      ['zh', { id: 'zh', label: '中文', fallback: 'en' }],
      ['en', { id: 'en', label: 'English' }]
    ]);
    const notify = () => {
      revision += 1;
      this.emit('locale/change', snapshot());
    };
    const snapshot = () => ({
      active,
      locales: [...languages.values()],
      revision
    });
    const registerDictionary = (namespace: string, localeId: string, dict: Record<string, string>) => {
      const byLocale = dictionaries.get(namespace) ?? new Map<string, Record<string, string>>();
      byLocale.set(localeId, dict);
      dictionaries.set(namespace, byLocale);
      this.recordPluginValue('providedServices', `locale:${namespace}:${localeId}`);
      notify();
      return () => {
        byLocale.delete(localeId);
        notify();
      };
    };
    const translate = (namespace: string, key: string, params?: Record<string, unknown>) => {
      const byLocale = dictionaries.get(namespace);
      const dict = byLocale?.get(active) ?? byLocale?.get('en') ?? byLocale?.get('zh');
      return interpolateLocaleText(dict?.[key] ?? key, params);
    };
    return {
      register: (namespace: unknown, localeOrTable: unknown, maybeDict?: unknown) => {
        const ns = stringValue(namespace).trim();
        if (!ns) throw new Error('locale.register requires a namespace.');
        if (typeof localeOrTable === 'string') {
          return registerDictionary(ns, localeOrTable, stringRecord(maybeDict));
        }
        const table = objectValue(localeOrTable);
        const disposers = Object.entries(table).map(([localeId, dict]) => registerDictionary(ns, localeId, stringRecord(dict)));
        return () => {
          for (const dispose of disposers) dispose();
        };
      },
      bind: (namespace: unknown) => (key: unknown, params?: Record<string, unknown>) => translate(stringValue(namespace), stringValue(key), params),
      t: (namespace: unknown, key: unknown, params?: Record<string, unknown>) => translate(stringValue(namespace), stringValue(key), params),
      addLanguage: (language: unknown) => {
        const input = objectValue(language);
        const id = stringValue(input.id).trim();
        if (!id) throw new Error('locale.addLanguage requires an id.');
        languages.set(id, { ...input, id });
        notify();
        return () => {
          languages.delete(id);
          notify();
        };
      },
      getLocale: snapshot,
      getSnapshot: snapshot,
      setLocale: async (localeId: unknown) => {
        const id = stringValue(localeId).trim();
        if (id) active = id;
        notify();
        return snapshot();
      },
      subscribe: (handler: CordisHandler) => this.on('locale/change', handler)
    };
  }

  private createSlotsService(): JsonObject {
    const entries: JsonObject[] = [];
    const root: JsonObject = {};
    const scopes = new Map<string, unknown>();
    const notify = (name: string) => this.emit(`slots/${name}`, entries.filter((entry) => entry.name === name));
    return {
      register: (meta: unknown, component?: unknown) => {
        const input = objectValue(meta);
        const name = stringValue(input.name ?? input.id ?? input.slot).trim() || 'default';
        const entry = {
          ...input,
          id: stringValue(input.id).trim() || `${name}:${entries.length + 1}`,
          name,
          component
        };
        entries.push(entry);
        this.recordPluginValue('providedServices', `slots:${name}`);
        notify(name);
        return () => {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
          notify(name);
        };
      },
      inject: (_name: unknown, callback?: CordisHandler) => typeof callback === 'function' ? this.consumeEffectResult(callback()) : undefined,
      entries: (name?: unknown) => {
        const clean = stringValue(name).trim();
        return clean ? entries.filter((entry) => entry.name === clean) : [...entries];
      },
      subscribe: (name: unknown, handler: CordisHandler) => this.on(`slots/${stringValue(name)}`, handler),
      provideRoot: (value: unknown) => {
        Object.assign(root, objectValue(value));
        return noopDisposer();
      },
      root: () => ({ ...root }),
      installScope: (name: unknown, value: unknown) => {
        scopes.set(stringValue(name), value);
        return () => {
          if (scopes.get(stringValue(name)) === value) scopes.delete(stringValue(name));
        };
      },
      bindStoreScope: (value: unknown) => value,
      installLocale: (value: unknown) => {
        root.locale = value;
        return noopDisposer();
      },
      renderSlot: () => null,
      renderSlotChain: () => null
    };
  }

  private createRemoteService(): JsonObject {
    const mounted = new Map<string, unknown>();
    const namespace = (name: string): JsonObject => new Proxy({
      $name: name,
      $mounted: () => mounted.get(name)
    } as JsonObject, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        return async (...args: unknown[]) => this.invokeRemoteNamespace(name, prop, args);
      }
    });
    const target: JsonObject = {
      $host: {
        home: this.options.sidecarHome,
        profileName: this.options.profileName,
        isLoopback: true
      },
      $mount: async (contribution: unknown) => {
        const input = objectValue(contribution);
        const name = stringValue(input.namespace ?? input.name ?? input.id, `namespace-${mounted.size + 1}`);
        mounted.set(name, contribution);
        this.recordPluginValue('providedServices', `remote:${name}`);
        return async () => {
          if (mounted.get(name) === contribution) mounted.delete(name);
        };
      },
      $on: (event: unknown, handler: CordisHandler) => this.on(`remote/${stringValue(event)}`, handler),
      $emit: (event: unknown, ...args: unknown[]) => this.emit(`remote/${stringValue(event)}`, ...args)
    };
    return new Proxy(target, {
      get: (obj, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (prop in obj) return obj[prop];
        const existing = obj[prop];
        if (isJsonObject(existing)) return existing;
        const created = namespace(prop);
        obj[prop] = created;
        return created;
      }
    }) as JsonObject;
  }

  private async invokeRemoteNamespace(namespace: string, method: string, args: unknown[]): Promise<JsonObject> {
    if (namespace === 'directoryPicker' && method === 'list') {
      return { ok: true, value: { path: stringValue(args[0], process.cwd()), entries: [], breadcrumbs: [] } };
    }
    if (namespace === 'directoryPicker' && method === 'pick') return { ok: true, value: null };
    if (namespace === 'directoryPicker' && method === 'createDirectory') {
      const parent = stringValue(args[0], process.cwd());
      const name = cleanMountId(stringValue(args[1], 'new-folder'));
      const path = resolve(parent, name);
      mkdirSync(path, { recursive: true });
      return { ok: true, value: path };
    }
    if (this.options.mainRequest) {
      const value = await this.options.mainRequest(`remote.${namespace}.${method}`, { args });
      return isJsonObject(value) && typeof value.ok === 'boolean'
        ? value
        : { ok: true, value };
    }
    return {
      ok: false,
      error: {
        code: 'remote-unavailable',
        message: `Remote namespace ${namespace}.${method} is not connected in the Tasi DSH sidecar host.`
      }
    };
  }

  private createUiConversationService(): JsonObject {
    const eventDefinitions: unknown[] = [];
    const viewDefinitions: unknown[] = [];
    const change = () => this.emit('uiConversation/change');
    const registry = (values: unknown[]) => ({
      register: (definition: unknown) => {
        values.push(definition);
        change();
        return () => {
          const index = values.indexOf(definition);
          if (index >= 0) values.splice(index, 1);
          change();
        };
      },
      list: () => [...values],
      subscribe: (handler: CordisHandler) => this.on('uiConversation/change', handler)
    });
    return {
      events: registry(eventDefinitions),
      views: registry(viewDefinitions),
      binding: (sessionId: unknown) => ({
        sessionId: stringValue(sessionId),
        snapshot: this.observableSource(() => ({ views: {}, activeTargets: [] }), 'uiConversation/change'),
        target: () => this.observableSource(() => undefined, 'uiConversation/change')
      }),
      imageUrl: async (_sessionId: unknown, attachment: unknown) => stringValue(objectValue(attachment).url)
    };
  }

  private createUiWorkspaceService(): JsonObject {
    return {
      connectWorkspace: async (workspaceId: unknown) => stringValue(workspaceId, `session-${Date.now().toString(36)}`),
      startSession: (_workspaceId?: unknown) => undefined,
      archiveSession: async (sessionId: unknown) => {
        const registry = objectValue(this.services.get('workspaceRegistry'));
        const archive = registry.archiveSession;
        if (typeof archive === 'function') await archive(sessionId);
      },
      pickDirectory: async () => null,
      listDirectory: async (path?: unknown) => ({ path: stringValue(path, process.cwd()), entries: [], breadcrumbs: [] }),
      createDirectory: async (path: unknown, name: unknown) => {
        const dir = resolve(stringValue(path, process.cwd()), cleanMountId(stringValue(name, 'new-folder')));
        mkdirSync(dir, { recursive: true });
        return dir;
      }
    };
  }

  private createModelDirectoriesService(): JsonObject {
    const directories = new Map<string, JsonObject>();
    const makeDirectory = (sessionId: string): JsonObject => {
      const source = this.observableSource(() => ({
        phase: 'ready',
        sessionId,
        selected: this.normalizeLlmConfig(),
        routable: null,
        models: []
      }), `modelDirectories/${sessionId}`);
      return {
        store: source,
        load: async () => source.getSnapshot(),
        select: async (selection: unknown) => ({ ok: true, value: selection }),
        resetConnected: () => this.emit(`modelDirectories/${sessionId}`),
        resetGeneration: () => this.emit(`modelDirectories/${sessionId}`),
        dispose: () => directories.delete(sessionId)
      };
    };
    return {
      directoryFor: (sessionId: unknown) => {
        const id = stringValue(sessionId, 'dsh-sidecar');
        const existing = directories.get(id);
        if (existing) return existing;
        const directory = makeDirectory(id);
        directories.set(id, directory);
        return directory;
      },
      list: () => [...directories.values()]
    };
  }

  private createConversationService(): JsonObject {
    const blocks = new Map<string, unknown>();
    return {
      blocks: {
        set: (sessionId: unknown, value: unknown) => {
          blocks.set(stringValue(sessionId), value);
          this.emit('conversation/blocks/change');
        },
        get: (sessionId: unknown) => blocks.get(stringValue(sessionId)),
        subscribe: (handler: CordisHandler) => this.on('conversation/blocks/change', handler)
      }
    };
  }

  private createCommandUiService(): JsonObject {
    return {
      register: (_definition: unknown) => noopDisposer(),
      popupSelect: async () => undefined
    };
  }

  private createUiSessionService(): JsonObject {
    return {
      current: () => undefined,
      subscribe: (handler: CordisHandler) => this.on('uiSession/change', handler)
    };
  }

  private createSettingsScopeService(): JsonObject {
    const values = new Map<string, unknown>();
    return {
      get: (key?: unknown) => key === undefined ? Object.fromEntries(values) : values.get(stringValue(key)),
      set: async (key: unknown, value?: unknown) => {
        if (isJsonObject(key) && value === undefined) {
          for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
        } else {
          values.set(stringValue(key), value);
        }
        this.emit('settingsScope/change');
      },
      subscribe: (handler: CordisHandler) => this.on('settingsScope/change', handler)
    };
  }

  private observableSource<T>(getSnapshot: () => T, eventName: string): { getSnapshot: () => T; subscribe: (handler: CordisHandler) => Disposer } {
    return {
      getSnapshot,
      subscribe: (handler: CordisHandler) => this.on(eventName, handler)
    };
  }

  private createCollectionService(name: string): JsonObject {
    const entries: unknown[] = [];
    return {
      register: (entry: unknown) => {
        entries.push(entry);
        this.recordPluginValue('providedServices', `${name}:${entries.length}`);
        return noopDisposer();
      },
      list: () => [...entries]
    };
  }

  private createLogger(name: string): CordisLogger {
    const writer = (level: 'debug' | 'info' | 'warn' | 'error') => (...args: unknown[]) => {
      const message = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
      process.stderr.write(`[${name}] ${level}: ${message}\n`);
    };
    const logger = (childName?: string) => this.createLogger(childName ? `${name}:${childName}` : name);
    return Object.assign(logger, {
      debug: writer('debug'),
      info: writer('info'),
      warn: writer('warn'),
      error: writer('error')
    }) as CordisLogger;
  }

  private provide(name: string, value: unknown): Disposer {
    this.services.set(name, value);
    this.recordPluginValue('providedServices', name);
    return () => {
      if (this.services.get(name) === value) this.services.delete(name);
    };
  }

  private effect(factory: () => unknown): Disposer {
    const result = this.consumeEffectResult(factory());
    return typeof result === 'function' ? result as Disposer : noopDisposer();
  }

  private consumeEffectResult(value: unknown): unknown {
    if (!value) return value;
    if (typeof (value as Promise<unknown>).then === 'function') {
      void (value as Promise<unknown>).then((resolved) => {
        this.consumeEffectResult(resolved);
      }, (error) => {
        this.createLogger('dsh-sidecar').warn(`async effect failed: ${errorMessage(error)}`);
      });
      return value;
    }
    if (isAsyncIterable(value)) {
      void (async () => {
        try {
          for await (const item of value) this.consumeEffectResult(item);
        } catch (error) {
          this.createLogger('dsh-sidecar').warn(`async iterable effect failed: ${errorMessage(error)}`);
        }
      })();
      return value;
    }
    if (isIterable(value) && typeof value !== 'string') {
      try {
        let last: unknown;
        for (const item of value) last = this.consumeEffectResult(item);
        return last;
      } catch (error) {
        this.createLogger('dsh-sidecar').warn(`iterable effect failed: ${errorMessage(error)}`);
        return value;
      }
    }
    if (typeof value === 'function') this.disposers.push(value as Disposer);
    return value;
  }

  private on(name: string, handler: CordisHandler): Disposer {
    const next = [...this.listenersFor(name), handler];
    this.listeners.set(name, next);
    return () => {
      this.listeners.set(name, this.listenersFor(name).filter((item) => item !== handler));
    };
  }

  private emit(name: string, ...args: unknown[]): void {
    for (const handler of this.listenersFor(name)) {
      try {
        handler(...args);
      } catch (error) {
        this.createLogger('dsh-sidecar').warn(`event handler failed for ${name}: ${errorMessage(error)}`);
      }
    }
  }

  private listenersFor(name: string): CordisHandler[] {
    return this.listeners.get(name) ?? [];
  }

  private recordPluginValue(key: 'settingsEntries' | 'commands' | 'providedServices' | 'webRoutes', value: string): void {
    if (!this.currentPluginId || !value) return;
    const current = this.plugins.get(this.currentPluginId);
    const values = current?.[key] ?? [];
    this.updatePlugin(this.currentPluginId, { [key]: [...new Set([...values, value])] });
  }

  private registerCommand(name: string, raw: unknown, handler?: CordisHandler): void {
    if (!this.currentPluginId || !name) return;
    const normalized = name.trim();
    const command: RegisteredCordisCommand = {
      pluginId: this.currentPluginId,
      name: normalized,
      raw,
      handler: handler ?? commandHandler(raw)
    };
    this.commands.set(commandKey(this.currentPluginId, normalized), command);
  }

  private async providerSkillCandidates(registered: RegisteredSkillProvider, options?: unknown): Promise<unknown[]> {
    const provider = objectValue(registered.raw);
    if (typeof provider.list !== 'function') return [];
    const listed = await (provider.list as CordisHandler)(options ?? {});
    if (Array.isArray(listed)) return listed;
    const observation = objectValue(listed);
    return Array.isArray(observation.candidates) ? observation.candidates : [];
  }

  private normalizeRuntimeSkill(raw: JsonObject, pluginId: string): DshSidecarRuntimeSkill | null {
    const name = stringValue(raw.name).trim();
    if (!name) return null;
    const plugin = this.plugins.get(pluginId);
    const resourceBase = objectValue(raw.resourceBase);
    const resourcePath = stringValue(resourceBase.path).trim();
    const locator = raw.locator instanceof URL ? raw.locator.href : stringValue(raw.locator).trim();
    const content = stringValue(raw.content).trim();
    const path = resourcePath ? resolve(resourcePath, 'SKILL.md') : (locator.startsWith('file:') ? fileURLToPath(locator) : locator || undefined);
    return {
      name,
      description: stringValue(raw.description, `DSH runtime skill ${name}`),
      pluginId,
      packageName: plugin?.packageName ?? pluginId,
      provider: stringValue(raw.provider).trim() || undefined,
      path,
      content: content || undefined,
      category: stringValue(raw.category, 'dsh'),
      source: stringValue(raw.source).trim() || undefined,
      invocation: objectValue(raw.invocation),
      updatedAt: new Date().toISOString()
    };
  }

  private resolveRuntimePlugin(ref: string): DshCordisHostPluginState | undefined {
    const clean = ref.trim().replace(/^@/, '').toLowerCase();
    return [...this.plugins.values()].find((plugin) => pluginAliases(plugin).includes(clean));
  }

  private selectCommandForChat(plugin: DshCordisHostPluginState, input: string): RegisteredCordisCommand | undefined {
    const slash = input.trim().match(/^\/[a-zA-Z0-9_.-]+/)?.[0];
    const candidates = [
      slash,
      ...plugin.commands,
      ...plugin.commands.map((name) => name.startsWith('/') ? name.slice(1) : `/${name}`)
    ].filter((item): item is string => Boolean(item));
    for (const name of candidates) {
      const direct = this.commands.get(commandKey(plugin.id, name));
      if (direct) return direct;
      const alternate = name.startsWith('/') ? name.slice(1) : `/${name}`;
      const matched = this.commands.get(commandKey(plugin.id, alternate));
      if (matched) return matched;
    }
    return [...this.commands.values()].find((command) => command.pluginId === plugin.id);
  }
}

function selectCordisPluginShape(mod: unknown): CordisPluginShape {
  if (!isJsonObject(mod)) throw new Error('Cordis plugin module did not export an object.');
  const candidate = mod.default ?? mod;
  if (typeof candidate === 'function') return candidate as CordisHandler;
  if (isJsonObject(candidate) && typeof candidate.apply === 'function') return candidate;
  if (typeof mod.apply === 'function') return mod;
  throw new Error('Cordis plugin module has no default/function/apply export.');
}

async function invokeCordisFunction(fn: CordisHandler, ctx: JsonObject, config: unknown): Promise<void> {
  if (/^class\s/.test(Function.prototype.toString.call(fn))) {
    Reflect.construct(fn, [ctx, config]);
    return;
  }
  try {
    await fn(ctx, config);
  } catch (error) {
    if (error instanceof TypeError && /class constructor/i.test(error.message)) {
      Reflect.construct(fn, [ctx, config]);
      return;
    }
    throw error;
  }
}

function normalizeToolDefinition(raw: DshToolLike): ToolDefinition {
  const functionSchema = isJsonObject(raw.function) ? raw.function : undefined;
  const name = stringValue(functionSchema?.name ?? raw.name);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid DSH tool name: ${name || '(empty)'}`);
  return {
    type: 'function',
    function: {
      name,
      description: stringValue(functionSchema?.description ?? raw.description, `DSH plugin tool ${name}`),
      parameters: normalizeJsonSchema(functionSchema?.parameters ?? raw.parameters ?? raw.inputSchema)
    }
  };
}

function normalizeJsonSchema(value: unknown): JsonSchema {
  if (!isJsonObject(value)) return { type: 'object', properties: {} };
  if (value.type === 'object' || value.properties !== undefined) return value as JsonSchema;
  return { type: 'object', properties: value as Record<string, JsonSchema> };
}

function normalizeToolResult(value: unknown, raw: DshToolLike, args: unknown): ToolExecutionResult {
  if (isJsonObject(value) && typeof value.ok === 'boolean' && typeof value.content === 'string') {
    return { ok: value.ok, content: value.content, data: value.data };
  }
  if (isJsonObject(value) && typeof value.isError === 'boolean') {
    return { ok: !value.isError, content: contentToText(value.content), data: value.value ?? value.meta };
  }
  const output = isJsonObject(raw.output) ? raw.output : undefined;
  const render = output?.render;
  if (typeof render === 'function') {
    try {
      const rendered = render(args, value);
      return { ok: true, content: contentToText(rendered), data: value };
    } catch (error) {
      return { ok: false, content: errorMessage(error), data: value };
    }
  }
  return { ok: true, content: contentToText(value), data: value };
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isJsonObject(item) && typeof item.text === 'string') return item.text;
      return typeof item === 'string' ? item : JSON.stringify(item);
    }).join('\n');
  }
  if (isJsonObject(value) && typeof value.text === 'string') return value.text;
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function dshMessageToText(value: unknown): string {
  if (isJsonObject(value) && Array.isArray(value.content)) return contentToText(value.content);
  return contentToText(value);
}

function uniqueText(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function commandRawInput(plugin: DshCordisHostPluginState, command: RegisteredCordisCommand, input: string): string {
  const trimmed = input.trimStart();
  const slashName = command.name.startsWith('/') ? command.name : `/${command.name}`;
  const commandName = command.name.startsWith('/') ? command.name.slice(1) : command.name;
  if (trimmed === slashName || trimmed === commandName) return '';
  if (trimmed.startsWith(`${slashName} `)) return trimmed.slice(slashName.length);
  if (trimmed.startsWith(`${commandName} `)) return trimmed.slice(commandName.length);
  const mention = matchingPluginMention(plugin, trimmed);
  if (!mention) return input;
  const rest = trimmed.slice(mention.length).trimStart();
  return rest ? ` ${rest}` : '';
}

function matchingPluginMention(plugin: DshCordisHostPluginState, input: string): string | undefined {
  if (!input.startsWith('@')) return undefined;
  const token = input.match(/^@[^\s]+/)?.[0];
  if (!token) return undefined;
  const clean = token.slice(1).toLowerCase();
  return pluginAliases(plugin).includes(clean) ? token : undefined;
}

function injectedServices(shape: CordisPluginShape): string[] {
  return normalizeInjectList(injectProperty(shape));
}

function injectProperty(shape: CordisPluginShape): unknown {
  if (isJsonObject(shape)) return shape.inject;
  return (shape as CordisHandler & { inject?: unknown }).inject;
}

function normalizeInjectList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (isJsonObject(value)) return Object.keys(value).filter((key) => Boolean(value[key]));
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function commandName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isJsonObject(value) && typeof value.name === 'string') return value.name;
  if (isJsonObject(value) && typeof value.command === 'string') return value.command;
  return '(anonymous)';
}

function commandHandler(value: unknown): CordisHandler | undefined {
  if (!isJsonObject(value)) return undefined;
  for (const key of ['handler', 'run', 'execute', 'action']) {
    const candidate = value[key];
    if (typeof candidate === 'function') return candidate as CordisHandler;
  }
  return undefined;
}

function cleanMountId(value: string): string {
  const clean = value.trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || `mount-${Date.now().toString(36)}`;
}

function normalizeClientMountPoint(value: string): DshSidecarClientMountPoint {
  const clean = value.trim().toLowerCase().replace(/_/g, '-');
  if (clean === 'sidebar' || clean === 'side-bar' || clean === 'nav' || clean === 'navigation') return 'sidebar';
  if (clean === 'main' || clean === 'main-panel' || clean === 'workspace' || clean === 'page') return 'main-panel';
  if (clean === 'right' || clean === 'right-panel' || clean === 'panel' || clean === 'tool-panel') return 'right-panel';
  if (clean === 'settings' || clean === 'config' || clean === 'configuration') return 'settings';
  if (clean === 'floating' || clean === 'float' || clean === 'overlay') return 'floating';
  if (clean === 'desktop' || clean === 'desktop-companion' || clean === 'companion' || clean === 'pet') return 'desktop-companion';
  if (clean === 'command' || clean === 'command-palette' || clean === 'palette') return 'command-palette';
  if (clean === 'status' || clean === 'status-bar' || clean === 'tray') return 'status-bar';
  return 'right-panel';
}

function clientMountUrl(baseUrl: string | undefined, pluginId: string, mountId: string, declaredUrl: string): string {
  if (/^https?:\/\//i.test(declaredUrl)) return declaredUrl;
  const base = baseUrl?.replace(/\/+$/, '') || '';
  const encodedPlugin = encodeURIComponent(pluginId);
  const encodedMount = encodeURIComponent(mountId);
  if (!base) return `/client-mount/${encodedPlugin}/${encodedMount}/`;
  return `${base}/client-mount/${encodedPlugin}/${encodedMount}/`;
}

function commandKey(pluginId: string, name: string): string {
  return `${pluginId}:${name.trim().toLowerCase()}`;
}

function pluginAliases(plugin: Pick<DshCordisHostPluginState, 'id' | 'packageName' | 'commands'>): string[] {
  const aliases = new Set<string>();
  const add = (value?: string) => {
    const clean = value?.trim().replace(/^@/, '').replace(/^\//, '').toLowerCase();
    if (clean) aliases.add(clean);
  };
  add(plugin.id);
  add(plugin.packageName);
  const parts = plugin.packageName.replace(/^@/, '').split('/');
  if (parts.length > 1) {
    add(parts.join('/'));
    add(parts.at(-1));
  }
  for (const command of plugin.commands) add(command);
  return [...aliases];
}

function credentialKey(ref: unknown): string {
  const key = stringValue(ref).trim();
  if (!key) throw new Error('Credential reference is required.');
  return key;
}

function gatewayFailure(error: unknown): { code: string; message: string; details: JsonObject } {
  if (isJsonObject(error) && isJsonObject(error.failure)) {
    return {
      code: stringValue(error.failure.code, 'internal'),
      message: stringValue(error.failure.message, errorMessage(error)),
      details: isJsonObject(error.failure.details) ? error.failure.details : {}
    };
  }
  return {
    code: isJsonObject(error) ? stringValue(error.code, 'internal') : 'internal',
    message: errorMessage(error),
    details: {}
  };
}

function createGatewayError(endpoint: string, code: string, message: string): Error {
  const error = new Error(message) as Error & {
    code?: string;
    endpoint?: string;
    failure?: { code: string; message: string; details: JsonObject };
  };
  error.name = 'TypertGatewayError';
  error.code = code;
  error.endpoint = endpoint;
  error.failure = { code, message, details: { endpoint } };
  return error;
}

function normalizeMainChatRunRequest(endpoint: string, payload: unknown): JsonObject {
  const candidates = promptPayloadCandidates(payload);
  const parts = normalizePromptParts(candidates);
  const input = uniqueText([
    ...candidates.flatMap((item) => [
      stringValue(item.input),
      stringValue(item.prompt),
      stringValue(item.text),
      stringValue(item.content),
      stringValue(item.message),
      stringValue(item.query),
      stringValue(item.line),
      stringValue(item.rawInput)
    ]),
    textFromInputParts(parts)
  ]).join('\n\n').trim();
  if (!input && parts.length === 0) throw createGatewayError(endpoint, 'bad-request', 'Prompt payload did not include text or input parts.');
  const sessionId = firstStringField(candidates, ['sessionId', 'session_id', 'conversationId', 'conversation_id', 'threadId', 'thread_id', 'agentId', 'agent_id']);
  return {
    source: 'dsh-sidecar',
    endpoint,
    sessionId,
    promptRpcId: firstStringField(candidates, ['rpcId', 'rpc_id', 'promptRpcId', 'prompt_rpc_id']) ?? `dsh-${Date.now().toString(36)}`,
    workspaceDir: firstStringField(candidates, ['workspaceDir', 'workspacePath', 'cwd', 'path', 'workingDirectory']),
    input,
    parts: parts.length > 0 ? parts : [{ type: 'text', text: input }],
    raw: payload
  };
}

function isQueuedPromptEndpoint(endpoint: string): boolean {
  return endpoint === 'apiProxy.sessions.prompt' || endpoint === 'session/prompt';
}

function normalizeMainChatRunResult(value: unknown): JsonObject {
  const object = objectValue(value);
  const content = uniqueText([
    stringValue(object.finalResponse),
    stringValue(object.content),
    stringValue(object.message),
    Array.isArray(object.parts) ? contentToText(object.parts) : undefined
  ]).join('\n\n').trim();
  const sessionId = stringValue(object.sessionId);
  const record = {
    type: 'assistant',
    role: 'assistant',
    content,
    createdAt: new Date().toISOString()
  };
  return {
    ok: true,
    sessionId,
    content,
    message: content,
    finalResponse: content,
    records: content ? [record] : [],
    events: content ? [record] : [],
    value
  };
}

function promptPayloadCandidates(payload: unknown): JsonObject[] {
  const seen = new Set<JsonObject>();
  const candidates: JsonObject[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (!isJsonObject(value) || seen.has(value) || depth > 3) return;
    seen.add(value);
    candidates.push(value);
    for (const key of ['payload', 'request', 'args', 'input', 'message', 'data', 'body']) {
      visit(value[key], depth + 1);
    }
  };
  visit(payload);
  return candidates;
}

function subagentPayloadCandidates(payload: unknown): JsonObject[] {
  const seen = new Set<JsonObject>();
  const candidates: JsonObject[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isJsonObject(value) || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
    for (const key of ['payload', 'request', 'args', 'input', 'message', 'data', 'body', 'task', 'options', 'agent', 'member', 'llm']) {
      visit(value[key], depth + 1);
    }
  };
  visit(payload);
  return candidates;
}

function subagentPromptText(candidates: JsonObject[], parts: DshSidecarInputPart[], name: string, role?: string, parentSession?: string): string {
  const body = uniqueText([
    ...candidates.flatMap((item) => [
      stringValue(item.prompt),
      stringValue(item.instructions),
      stringValue(item.input),
      stringValue(item.text),
      stringValue(item.content),
      stringValue(item.description),
      stringValue(item.task),
      stringValue(item.goal),
      stringValue(item.objective),
      stringValue(item.query)
    ]),
    textFromInputParts(parts)
  ]).join('\n\n').trim();
  const header = [
    `You are running as a Tasi subagent spawned by DSH Agent Teams.`,
    `Subagent: ${name}`,
    role ? `Role: ${role}` : '',
    parentSession ? `Parent session: ${parentSession}` : ''
  ].filter(Boolean).join('\n');
  return uniqueText([header, body]).join('\n\n').trim();
}

function nativeSubagentSessionId(parentSession: string, name: string): string {
  const parent = safeSessionIdSegment(parentSession || 'parent').slice(0, 48);
  const agent = safeSessionIdSegment(name || 'subagent').slice(0, 32);
  const hash = createHash('sha256')
    .update(`${parentSession}\0${name}\0${Date.now()}\0${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `sub_${parent}_${agent}_${hash}`;
}

function safeSessionIdSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'subagent';
}

function normalizePromptParts(candidates: JsonObject[]): DshSidecarInputPart[] {
  for (const candidate of candidates) {
    const direct = Array.isArray(candidate.parts) ? candidate.parts : undefined;
    const content = Array.isArray(candidate.content) ? candidate.content : undefined;
    const values = direct ?? content;
    if (!values) continue;
    const parts = values.map(normalizePromptPart).filter((item): item is DshSidecarInputPart => Boolean(item));
    if (parts.length > 0) return parts;
  }
  return [];
}

function normalizePromptPart(value: unknown): DshSidecarInputPart | undefined {
  if (typeof value === 'string') return { type: 'text', text: value };
  if (!isJsonObject(value)) return undefined;
  const type = stringValue(value.type, 'text');
  if (type === 'text' || type === 'selection') {
    const text = stringValue(value.text ?? value.content ?? value.value);
    if (!text) return undefined;
    return type === 'selection'
      ? { type: 'selection', source: 'chat', text, metadata: objectValue(value.metadata) }
      : { type: 'text', text };
  }
  if (type === 'image' || type === 'audio' || type === 'video') {
    return {
      type,
      name: stringValue(value.name) || undefined,
      mime: stringValue(value.mime ?? value.mimeType, 'application/octet-stream'),
      data: stringValue(value.data ?? value.contentBase64) || undefined,
      path: stringValue(value.path) || undefined
    };
  }
  if (type === 'file') {
    const name = stringValue(value.name ?? value.filename ?? value.path, 'file');
    return {
      type: 'file',
      name,
      mime: stringValue(value.mime ?? value.mimeType) || undefined,
      data: stringValue(value.data ?? value.contentBase64) || undefined,
      path: stringValue(value.path) || undefined
    };
  }
  if (type === 'url') {
    const url = stringValue(value.url ?? value.href);
    return url ? { type: 'url', url, title: stringValue(value.title) || undefined } : undefined;
  }
  if (type === 'json') return { type: 'json', name: stringValue(value.name) || undefined, value: value.value ?? value };
  return undefined;
}

function firstStringField(candidates: JsonObject[], keys: string[]): string | undefined {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = stringValue(candidate[key]).trim();
      if (value) return value;
    }
  }
  return undefined;
}

async function* singleAsyncIterator<T>(value: T): AsyncIterable<T> {
  yield value;
}

async function* emptyAsyncIterator<T>(_signal?: AbortSignal): AsyncIterable<T> {
  return;
}

function textFromInputParts(parts: DshSidecarChatRunRequest['input']['parts']): string {
  return parts.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'selection') return part.text;
    if (part.type === 'url') return part.url;
    if ('name' in part && typeof part.name === 'string') return `[${part.type}: ${part.name}]`;
    if ('path' in part && typeof part.path === 'string') return `[${part.type}: ${part.path}]`;
    if (part.type === 'json') return JSON.stringify(part.value);
    return `[${part.type}]`;
  }).filter(Boolean).join('\n\n');
}

function noopDisposer(_handler?: unknown): Disposer {
  return () => {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isJsonObject(value) && typeof (value as Record<PropertyKey, unknown>)[Symbol.iterator] === 'function';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isJsonObject(value) && typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === 'function';
}

function objectValue(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function initialDomainGlobal(spec: JsonObject): unknown {
  const globalSpec = objectValue(spec.global);
  return Object.prototype.hasOwnProperty.call(globalSpec, 'initial') ? globalSpec.initial : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const input = objectValue(value);
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function interpolateLocaleText(text: string, params?: Record<string, unknown>): string {
  if (!params) return text;
  return text.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
