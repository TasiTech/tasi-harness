export type ProviderKind =
  | 'openai'
  | 'openai-compatible'
  | 'vllm'
  | 'deepseek'
  | 'qwen-bailian'
  | 'soildapi'
  | 'minimax'
  | 'kimi'
  | 'anthropic'
  | 'anthropic-compatible'
  | 'ollama'
  | 'mock';
export type ReasoningEffort = 'auto' | 'none' | 'low' | 'medium' | 'xhigh';
export type BrowserMode = 'embedded' | 'external';
export type ExternalBrowserEngine = 'auto' | 'cdp' | 'webdriver-safari';
export type ExternalBrowserProfileMode = 'isolated' | 'system';

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface AgentMessage {
  id?: string;
  role: AgentRole;
  content: string;
  external?: ExternalConversationMetadata;
  hidden?: boolean;
  contentOmitted?: boolean;
  contentLength?: number;
  attachments?: AgentMessageAttachment[];
  reasoning_content?: string;
  reasoningOmitted?: boolean;
  reasoningLength?: number;
  reasoning_parts?: string[];
  content_parts?: string[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  artifacts?: AgentArtifactRef[];
  createdAt?: string;
}

export type AgentArtifactKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'model3d'
  | 'media'
  | 'office'
  | 'archive'
  | 'executable'
  | 'database'
  | 'unknown';

export type AgentArtifactPreviewMode = 'text' | 'code' | 'markdown' | 'image' | 'pdf' | 'model3d' | 'media' | 'office' | 'external' | 'none';

export interface AgentArtifactRef {
  id: string;
  name: string;
  path: string;
  absPath: string;
  ext: string;
  kind: AgentArtifactKind;
  previewMode: AgentArtifactPreviewMode;
  mimeType?: string;
  sizeBytes?: number;
  source: 'file_write' | 'terminal' | 'dsh-sidecar' | 'assistant-link';
  createdAt?: string;
}

export type AgentMessageAttachmentKind = 'image' | 'video' | 'audio';

export interface AgentMessageAttachment {
  id?: string;
  kind: AgentMessageAttachmentKind;
  filename: string;
  mimeType: string;
  contentBase64: string;
  sizeBytes?: number;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  required?: string[];
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ToolExecutionContext {
  sessionId: string;
  workspaceDir: string;
  requestId: string;
  safetyApproval?: SafetyApprovalSettings;
  requestToolApproval?: ToolApprovalRequester;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  data?: unknown;
  approval?: ToolApprovalRecord;
}

export type ToolExecutor = (args: unknown, context: ToolExecutionContext) => Promise<ToolExecutionResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
  safety: 'read-only' | 'writes-workspace' | 'executes-command' | 'network' | 'stateful';
}

export type ToolSafety = RegisteredTool['safety'];
export type ToolApprovalRisk = 'workspace-delete' | 'outside-read' | 'outside-write' | 'outside-delete' | 'terminal-risk';
export type ToolApprovalStatus = 'not_required' | 'approved' | 'denied' | 'unavailable' | 'remembered' | 'blocked';

export interface SafetyApprovalSettings {
  enabled: boolean;
  approveRiskyTerminalCommands: boolean;
  timeoutMs: number;
  neverAskAgainKeys: string[];
}

export interface ToolApprovalRequest {
  id: string;
  key: string;
  toolName: string;
  safety: ToolSafety;
  risk: ToolApprovalRisk;
  summary: string;
  args: unknown;
  workspaceDir: string;
  sessionId: string;
  requestId: string;
  createdAt: string;
  timeoutMs: number;
  allowNeverAskAgain: boolean;
}

export interface ToolApprovalDecision {
  id: string;
  approved: boolean;
  neverAskAgain?: boolean;
}

export interface ToolApprovalRecord {
  status: ToolApprovalStatus;
  key?: string;
  risk?: ToolApprovalRisk;
  summary?: string;
  requestId?: string;
}

export type ToolApprovalRequester = (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmCompletion {
  message: AgentMessage;
  usage?: LlmUsage;
  log_probs?: unknown;
  raw?: unknown;
}

export interface LlmRequestMetadata {
  session?: string;
  turn_type?: string;
  session_done?: boolean;
  context_compression?: 'turn_boundary' | 'iteration' | 'provider_retry';
}

export interface LlmRequest {
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  logProbs?: boolean;
  topLogProbs?: number;
  metadata?: LlmRequestMetadata;
  signal?: AbortSignal;
}

export interface AppBrandingSettings {
  productName: string;
  logoPath: string;
  logoInitials: string;
}

export type AppTheme = 'dark' | 'light' | 'tech' | `custom:${string}`;

export interface CustomThemeTokens {
  bgPrimary?: string;
  bgSecondary?: string;
  bgTertiary?: string;
  bgCard?: string;
  bgCardHover?: string;
  accent?: string;
  accentDim?: string;
  accent2?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  border?: string;
  borderActive?: string;
  ok?: string;
  warn?: string;
  danger?: string;
  shadow?: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  source: 'tasi' | 'dreamskin';
  tokens: CustomThemeTokens;
  backgroundPath?: string;
  backgroundDataUrl?: string;
  backgroundFocusX?: number;
  backgroundFocusY?: number;
  createdAt: string;
}

export interface ThemeImportRequest {
  filename: string;
  contentBase64: string;
}

export type DreamSkinGallerySort = 'recent' | 'popular';

export interface DreamSkinGalleryQuery {
  limit?: number;
  offset?: number;
  sort?: DreamSkinGallerySort;
}

export interface DreamSkinGalleryTheme {
  id: string;
  themeId: string;
  slug: string;
  name: string;
  authorDisplayName: string;
  version: string;
  license: string;
  packageBytes: number;
  downloadCount: number;
  reviewedAt?: string;
  submittedAt?: string;
  thumbnailDataUrl?: string;
  displayMeta?: {
    appearance?: 'auto' | 'light' | 'dark';
    colors?: Record<string, string>;
    art?: {
      focusX?: number;
      focusY?: number;
      safeArea?: string;
      taskMode?: string;
    };
  };
}

export interface DreamSkinGalleryResult {
  items: DreamSkinGalleryTheme[];
  total: number;
  limit: number;
  offset: number;
}

export interface DreamSkinThemeInstallRequest {
  themeVersionId: string;
  name?: string;
}

export interface PublicAppBrandingSettings extends AppBrandingSettings {
  logoDataUrl?: string;
}

export interface AppConfig {
  branding: AppBrandingSettings;
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  omniProvider: ProviderKind;
  omniBaseUrl: string;
  omniApiKey: string;
  omniModel: string;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  maxIterations: number;
  sessionDocumentMaxDocs: number;
  workspaceDir: string;
  allowShellTools: boolean;
  enableNetworkTools: boolean;
  safetyApproval: SafetyApprovalSettings;
  browserMode: BrowserMode;
  externalBrowserEngine: ExternalBrowserEngine;
  externalBrowserCdpEndpoint: string;
  externalBrowserProfileMode: ExternalBrowserProfileMode;
  browserHeadless: boolean;
  browserExecutionLoggingEnabled: boolean;
  theme: AppTheme;
  textBrightness: number;
  textColor: string;
  customThemes: CustomTheme[];
  systemPersona: string;
  omniSystemPrompt: string;
  enabledToolNames: string[];
  defaultExecutionMode: ExecutionMode;
  skillMarketSources: SkillMarketplaceSource[];
  emailNotifications: EmailNotificationSettings;
  wechatChannel: WechatChannelSettings;
}

export interface PublicEmailNotificationSettings extends Omit<EmailNotificationSettings, 'password'> {
  passwordConfigured: boolean;
  password?: string;
}

export interface PublicAppConfig extends Omit<AppConfig, 'apiKey' | 'omniApiKey' | 'emailNotifications' | 'branding'> {
  branding: PublicAppBrandingSettings;
  apiKeyConfigured: boolean;
  apiKey?: string;
  omniApiKeyConfigured: boolean;
  omniApiKey?: string;
  emailNotifications: PublicEmailNotificationSettings;
}

export type MemoryTarget = 'memory' | 'user';
export type MemoryScope = 'global' | 'session';
export type MemoryDomain = 'finance' | 'daily_life' | 'work' | 'reading' | 'education' | 'health' | 'travel' | 'other';

export interface MemoryMutationOptions {
  scope?: MemoryScope;
  sessionId?: string;
  domain?: MemoryDomain | string;
  entryId?: string;
}

export interface MemoryQueryOptions {
  target?: MemoryTarget;
  sessionId?: string;
  domain?: MemoryDomain | string;
  intent?: string;
  limit?: number;
  includeGlobal?: boolean;
}

export interface MemoryClearRequest {
  target?: MemoryTarget;
  mode: 'entry' | 'domain' | 'all';
  entryId?: string;
  domain?: MemoryDomain | string;
  sessionId?: string;
}

export interface MemoryDomainUsage {
  domain: string;
  count: number;
}

export interface MemoryEntry {
  id: string;
  target: MemoryTarget;
  scope: MemoryScope;
  sessionId?: string;
  domain?: MemoryDomain | string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUsage {
  target: MemoryTarget;
  limit: number;
  used: number;
  percent: number;
}

export interface MemoryState {
  entries: MemoryEntry[];
  usage: MemoryUsage[];
  domains: MemoryDomainUsage[];
  query?: MemoryQueryOptions;
  rendered: string;
}

export interface SkillMetadata {
  name: string;
  displayName?: string;
  description: string;
  category: string;
  displayCategory?: string;
  path: string;
  readonly: boolean;
  source: 'bundled' | 'local' | 'dsh';
  updatedAt?: string;
  bundledPath?: string;
  bundledUpdatedAt?: string;
  marketplaceSourceId?: string;
  marketplaceSkillId?: string;
  version?: string;
}

export interface SkillDocument extends SkillMetadata {
  content: string;
  frontmatter: Record<string, string | string[] | boolean | number>;
}

export interface DshSidecarRuntimeSkill {
  name: string;
  description: string;
  pluginId: string;
  packageName: string;
  provider?: string;
  path?: string;
  content?: string;
  category?: string;
  source?: string;
  invocation?: {
    modelInvocable?: boolean;
    userInvocable?: boolean;
  };
  updatedAt?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  domain?: MemoryDomain | string;
  origin?: 'desktop' | 'external-im';
  external?: ExternalConversationMetadata;
}

export type SessionHistoryCategory = MemoryDomain | 'all' | 'wechat-clawbot' | 'external-im';

export interface SessionListPageRequest {
  page?: number;
  pageSize?: number;
  query?: string;
  category?: SessionHistoryCategory;
  wechatSessionId?: string;
}

export interface SessionListPageResult {
  sessions: SessionSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  categoryCounts: Partial<Record<SessionHistoryCategory, number>>;
}

export interface SessionSystemPromptRecord {
  prompt: string;
  createdAt: string;
}

export interface SessionRecord extends SessionSummary {
  systemPrompt?: string;
  systemPromptHistory?: SessionSystemPromptRecord[];
  messages: AgentMessage[];
  toolEvents: ToolEvent[];
  lastExecution?: AgentExecutionDetails;
  lastUsage?: LlmUsage;
  totalUsage?: LlmUsage;
}

export interface ExternalConversationMetadata {
  provider: string;
  pluginId?: string;
  botId?: string;
  scope?: 'private' | 'group' | 'channel' | 'unknown';
  externalConversationId?: string;
  senderId?: string;
  senderName?: string;
  displayName?: string;
}

export interface SessionOptimizationContextRequest {
  sessionIds: string[];
  maxCharsPerSession?: number;
  maxTotalChars?: number;
}

export interface SessionOptimizationContextResult {
  sessionIds: string[];
  missingIds: string[];
  context: string;
  truncated: boolean;
  totalChars: number;
}

export interface SessionMessageContentRequest {
  sessionId: string;
  messageId: string;
}

export interface SessionMessageContentResult {
  content: string;
  reasoning_content?: string;
  content_parts?: string[];
  attachments?: AgentMessageAttachment[];
}

export interface SessionToolEventContentRequest {
  sessionId: string;
  toolEventId: string;
}

export interface SessionToolEventContentResult {
  content: string;
  args: unknown;
}

export interface ArtifactPathRequest {
  path: string;
  absPath?: string;
  sessionId?: string;
}

export interface ArtifactPreviewRequest extends ArtifactPathRequest {
  maxBytes?: number;
}

export interface ArtifactPreviewResult {
  artifact: AgentArtifactRef;
  content?: string;
  dataBase64?: string;
}

export interface SessionUpdateEvent {
  sessionId: string;
  source: 'chat' | 'scheduled' | 'external';
  updatedAt: string;
}

export interface ExternalSessionMessageRequest {
  sessionId?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  title?: string;
}

export interface AgentRunOptions {
  sessionId?: string;
  userInput: string;
  attachments?: AgentMessageAttachment[];
  executionMode?: ExecutionMode;
  workspaceDir?: string;
  usePersonalKnowledgeBase?: boolean;
  useMemory?: boolean;
  memoryDomains?: MemoryDomain[];
  useSkills?: boolean;
  enabledSkillNames?: string[];
  enabledToolNames?: string[];
  logProbs?: boolean;
  topLogProbs?: number;
  turnType?: string;
  sessionDone?: boolean;
  origin?: 'chat' | 'scheduled';
  scheduledTaskId?: string;
  stream?: boolean;
}

export interface AgentRunResult {
  sessionId: string;
  finalResponse: string;
  messages: AgentMessage[];
  toolEvents: ToolEvent[];
  followUpQuestions?: string[];
  usage?: LlmUsage;
  totalUsage?: LlmUsage;
  log_probs?: unknown;
  iterations: number;
  execution: AgentExecutionDetails;
}

export interface SkillOptimizationRunRequest {
  prompt: string;
  sessionIds: string[];
  executionMode?: ExecutionMode;
}

export interface ToolEvent {
  id: string;
  toolName: string;
  args: unknown;
  argsOmitted?: boolean;
  argsLength?: number;
  ok: boolean;
  content: string;
  contentOmitted?: boolean;
  contentLength?: number;
  approval?: ToolApprovalRecord;
  createdAt: string;
}

export interface AgentToolEventStream {
  sessionId: string;
  event: ToolEvent;
}

export interface AgentMessageDeltaStream {
  sessionId: string;
  messageId: string;
  role: 'assistant';
  type: 'content' | 'reasoning_content' | 'done';
  delta?: string;
  content?: string;
  contentOmitted?: boolean;
  contentLength?: number;
  reasoning_content?: string;
  reasoningOmitted?: boolean;
  reasoningLength?: number;
  reasoning_parts?: string[];
  content_parts?: string[];
  createdAt?: string;
}

export type ExecutionMode = 'workspace' | 'sandbox';

export type LiveAgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface LiveAgentTaskTrace {
  id: string;
  taskId: string;
  title: string;
  label: 'Reasoning' | 'Text' | 'Tool Call' | 'Tool Result' | 'Tool Error' | 'Result' | 'Status';
  content: string;
  createdAt: string;
}

export interface LiveAgentTask {
  id: string;
  name: string;
  prompt: string;
  status: LiveAgentTaskStatus;
  /**
   * Realtime conversation session id. Background execution is stored separately
   * in backendSessionId.
   */
  sessionId: string;
  backendSessionId?: string;
  executionMode: ExecutionMode;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  trace: LiveAgentTaskTrace[];
}

export interface LiveAgentTaskCreateRequest {
  prompt: string;
  name?: string;
  sessionId?: string;
  executionMode?: ExecutionMode;
}

export interface LiveAgentTaskUpdateEvent {
  task: LiveAgentTask;
}

export interface LiveSessionTaskLink {
  taskId: string;
  backendSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveSessionRelation {
  sessionId: string;
  backendSessions: LiveSessionTaskLink[];
  tasks: LiveAgentTask[];
  createdAt: string;
  updatedAt: string;
}

export interface LiveSessionCreateResult {
  sessionId: string;
  relation: LiveSessionRelation;
}

export interface LiveSessionAppendMessageRequest {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AgentMessageAttachment[];
  createdAt?: string;
}

export type LiveRealtimeStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface LiveRealtimeStartRequest {
  instructions?: string;
  voice?: string;
  sessionId?: string;
}

export interface LiveRealtimeStartResult {
  sessionId: string;
  provider: ProviderKind;
  model: string;
  status: LiveRealtimeStatus;
}

export interface LiveRealtimeClientEvent {
  type: string;
  [key: string]: unknown;
}

export interface LiveRealtimeEvent {
  sessionId: string;
  status?: LiveRealtimeStatus;
  event?: LiveRealtimeClientEvent;
  message?: string;
  createdAt: string;
}

export interface AgentExecutionDetails {
  mode: ExecutionMode;
  workspaceDir: string;
  sandboxId?: string;
}

export interface SkillMarketplaceSource {
  id: string;
  name: string;
  description: string;
  catalogUrl?: string;
  enabled: boolean;
}

export interface SkillSupportingFile {
  path: string;
  content?: string;
  contentBase64?: string;
}

export interface MarketplaceSkill {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  description: string;
  category: string;
  version: string;
  readme: string;
  skillContent: string;
  supportingFiles?: SkillSupportingFile[];
  homepage?: string;
  remoteVersionId?: string;
  installCommand?: string;
  installed: boolean;
  installedSkillName?: string;
}

export interface MarketplaceBrowseRequest {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface MarketplaceBrowseResult {
  sources: SkillMarketplaceSource[];
  skills: MarketplaceSkill[];
  page?: number;
  pageSize?: number;
  total?: number;
  loaded?: number;
  hasMore?: boolean;
}

export interface MarketplaceSkillSnapshot {
  id: string;
  sourceId: string;
  sourceName: string;
  name: string;
  description: string;
  category: string;
  version: string;
  readme: string;
  skillContent: string;
  supportingFiles?: SkillSupportingFile[];
  homepage?: string;
  remoteVersionId?: string;
  installCommand?: string;
}

export interface SkillInstallRequest {
  sourceId: string;
  skillId: string;
  skill?: MarketplaceSkillSnapshot;
  overwrite?: boolean;
}

export interface EmailNotificationSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  to: string;
}

export interface WechatChannelSettings {
  enabled: boolean;
  pluginName: 'clawbot';
  bindUrl: string;
  botToken?: string;
  botId?: string;
  userId?: string;
  baseUrl?: string;
  cursor?: string;
  sessionId?: string;
  loginStatus?: 'idle' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  lastError?: string;
  lastQrcodeKey?: string;
  lastInboundUserId?: string;
  lastContextToken?: string;
}

export interface WechatChannelQrCodePayload {
  qrcodeContent: string;
  qrcodeKey?: string;
  source: 'ilink-api' | 'manual-bind-url';
  fetchedAt: string;
}

export interface WechatChannelLoginStatusPayload {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'unknown';
  botToken?: string;
  botId?: string;
  userId?: string;
  baseUrl?: string;
  fetchedAt: string;
}

export type DshSidecarPluginStatus = 'installed' | 'enabled' | 'disabled' | 'failed' | 'incompatible' | 'uninstalled';

export interface DshSidecarPluginRecord {
  id: string;
  packageName: string;
  source: string;
  version?: string;
  enabled: boolean;
  status: DshSidecarPluginStatus;
  dshBundlePatch?: string;
  profileName: string;
  installedAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface DshSidecarStatus {
  available: boolean;
  running: boolean;
  pid?: number;
  protocolVersion: number;
  home: string;
  profileName: string;
  profileDir: string;
  nodeVersion?: string;
  lastError?: string;
}

export interface DshSidecarPluginInstallRequest {
  source: string;
  packageName?: string;
  profileName?: string;
  packageManager?: 'pnpm';
}

export interface DshSidecarPluginUploadRequest {
  filename: string;
  contentBase64: string;
  packageName?: string;
  profileName?: string;
  enable?: boolean;
}

export interface DshSidecarPluginActionRequest {
  id: string;
  packageName?: string;
  source?: string;
  profileName?: string;
}

export interface DshSidecarPluginListResult {
  status: DshSidecarStatus;
  plugins: DshSidecarPluginRecord[];
}

export type DshSidecarClientMountPoint =
  | 'sidebar'
  | 'main-panel'
  | 'right-panel'
  | 'settings'
  | 'floating'
  | 'desktop-companion'
  | 'command-palette'
  | 'status-bar';

export interface DshSidecarClientMount {
  id: string;
  pluginId: string;
  packageName: string;
  title: string;
  mountPoint: DshSidecarClientMountPoint;
  url: string;
  icon?: string;
  description?: string;
  permissions?: string[];
}

export interface DshSidecarClientMountOpenRequest {
  id: string;
  pluginId?: string;
  mode?: 'panel' | 'window' | 'desktop-companion';
}

export interface DshSidecarRuntimePlugin {
  id: string;
  packageName: string;
  version?: string;
  enabled: boolean;
  status: 'loaded' | 'partial' | 'failed' | 'skipped';
  packageRoot?: string;
  patchPath?: string;
  moduleEntry?: string;
  tools: string[];
  skills?: string[];
  settingsEntries?: string[];
  commands?: string[];
  webRoutes?: string[];
  clientMounts?: DshSidecarClientMount[];
  lastError?: string;
}

export interface DshSidecarRuntimeStatus {
  status: DshSidecarStatus;
  plugins: DshSidecarRuntimePlugin[];
  tools: ToolDefinition[];
  skills?: DshSidecarRuntimeSkill[];
  clientMounts?: DshSidecarClientMount[];
}

export type DshSidecarInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; name?: string; mime: string; data?: string; path?: string }
  | { type: 'video'; name?: string; mime: string; data?: string; path?: string }
  | { type: 'audio'; name?: string; mime: string; data?: string; path?: string }
  | { type: 'file'; name: string; mime?: string; data?: string; path?: string }
  | { type: 'directory'; name?: string; path: string }
  | { type: 'selection'; source: 'editor' | 'chat' | 'browser' | 'file'; text: string; metadata?: Record<string, unknown> }
  | { type: 'url'; url: string; title?: string }
  | { type: 'json'; name?: string; value: unknown };

export type DshSidecarOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; name: string; path: string; mime: string }
  | { type: 'file'; name: string; path: string; mime?: string }
  | { type: 'json'; name?: string; value: unknown };

export interface DshSidecarChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface DshSidecarChatRunRequest {
  pluginRef: string;
  sessionId: string;
  workspaceDir: string;
  input: {
    parts: DshSidecarInputPart[];
  };
  context?: {
    historySummary?: string;
    recentMessages?: DshSidecarChatMessage[];
    allowedRoots?: string[];
    locale?: string;
    timezone?: string;
    llm?: {
      provider?: string;
      model?: string;
      reasoningEffort?: string;
    };
  };
  options?: {
    stream?: boolean;
    timeoutMs?: number;
  };
}

export interface DshSidecarChatRunResult {
  ok: boolean;
  content?: string;
  messages?: DshSidecarChatMessage[];
  parts?: DshSidecarOutputPart[];
  artifacts?: Array<{
    name: string;
    path: string;
    mime?: string;
  }>;
  diagnostics?: {
    plugin: string;
    runtime: DshSidecarRuntimePlugin['status'] | 'missing';
    command?: string;
    toolCalls?: string[];
    agents?: string[];
    durationMs?: number;
    note?: string;
  };
  error?: string;
}

export interface DshSidecarToolCallRequest {
  name: string;
  args?: unknown;
  context: {
    sessionId: string;
    workspaceDir: string;
    requestId: string;
    llm?: {
      provider?: string;
      model?: string;
      reasoningEffort?: string;
    };
  };
}

export interface DshMarketplacePlugin {
  id: string;
  sourceId: 'skillhub';
  owner?: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  homepage: string;
  packageName?: string;
  installSource: string;
  readme?: string;
  tags?: string[];
  downloads?: number;
  installed: boolean;
  installedPluginId?: string;
  enabled?: boolean;
  status?: DshSidecarPluginStatus;
}

export interface DshMarketplacePluginVersion {
  version: string;
  createdAt?: string;
  yanked?: boolean;
}

export interface DshMarketplacePluginDetail extends DshMarketplacePlugin {
  versions: DshMarketplacePluginVersion[];
  manifestPreview?: string;
  mcpPreview?: string;
}

export interface DshMarketplaceBrowseRequest {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface DshMarketplaceBrowseResult {
  source: {
    id: 'skillhub';
    name: string;
    homepage: string;
  };
  plugins: DshMarketplacePlugin[];
  page?: number;
  pageSize?: number;
  total?: number;
  loaded?: number;
  hasMore?: boolean;
}

export interface DshMarketplacePluginInstallRequest {
  plugin: DshMarketplacePlugin;
  version?: string;
  enable?: boolean;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  scheduleType: 'once' | 'interval' | 'daily' | 'weekly' | 'monthly';
  runAt?: string;
  intervalMinutes?: number;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleWeekday?: number;
  scheduleWeekdays?: number[];
  scheduleMonthDay?: number;
  scheduleMonthDays?: number[];
  nextRunAt: string;
  enabled: boolean;
  isRunning?: boolean;
  runStartedAt?: string;
  executionMode: ExecutionMode;
  notifyByEmail: boolean;
  notifyByWechat: boolean;
  sessionId?: string;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  lastIterations?: number;
  lastToolEventCount?: number;
  lastTrace?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskCreateRequest {
  name: string;
  prompt: string;
  scheduleType: 'once' | 'interval' | 'daily' | 'weekly' | 'monthly';
  runAt?: string;
  intervalMinutes?: number;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleWeekday?: number;
  scheduleWeekdays?: number[];
  scheduleMonthDay?: number;
  scheduleMonthDays?: number[];
  executionMode: ExecutionMode;
  notifyByEmail: boolean;
  notifyByWechat?: boolean;
}

export interface ScheduledTaskPatchRequest {
  id: string;
  name?: string;
  prompt?: string;
  scheduleType?: 'once' | 'interval' | 'daily' | 'weekly' | 'monthly';
  runAt?: string;
  intervalMinutes?: number;
  scheduleHour?: number;
  scheduleMinute?: number;
  scheduleWeekday?: number;
  scheduleWeekdays?: number[];
  scheduleMonthDay?: number;
  scheduleMonthDays?: number[];
  executionMode?: ExecutionMode;
  notifyByEmail?: boolean;
  notifyByWechat?: boolean;
  enabled?: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  node: string;
  harnessHome: string;
  productName: string;
}

export interface AssistantMessageExportRequest {
  format: 'pdf' | 'docx';
  title?: string;
  content: string;
  html?: string;
}

export interface SkillWriteRequest {
  name: string;
  content: string;
  category?: string;
  displayName?: string;
  displayCategory?: string;
  overwrite?: boolean;
}

export interface SkillPatchRequest {
  name: string;
  oldString: string;
  newString: string;
}

export interface SkillArchiveUploadRequest {
  filename: string;
  contentBase64: string;
  name?: string;
  category?: string;
  displayName?: string;
  displayCategory?: string;
  overwrite?: boolean;
}

export type BrowserCoachEventType = 'navigation' | 'click' | 'input' | 'change' | 'submit' | 'keydown' | 'window_closed';

export interface BrowserCoachRecordedEvent {
  id: string;
  index: number;
  type: BrowserCoachEventType;
  url: string;
  title?: string;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  key?: string;
  createdAt: string;
}

export interface BrowserCoachRecording {
  id: string;
  startUrl: string;
  startedAt: string;
  endedAt?: string;
  active: boolean;
  events: BrowserCoachRecordedEvent[];
}

export interface BrowserCoachStartRequest {
  url?: string;
}

export interface BrowserCoachGenerateSkillRequest {
  name: string;
  category: string;
  description?: string;
  userGuidance?: string;
  overwrite?: boolean;
  recording?: BrowserCoachRecording;
  displayName?: string;
  displayCategory?: string;
}

export interface BrowserCoachGenerateSkillResult {
  skill: SkillDocument;
  recording: BrowserCoachRecording;
  recordingReferencePath: string;
}

export interface BrowserCoachStoredRecording {
  id: string;
  source: 'recording' | 'skill';
  skillName: string;
  displayName?: string;
  category: string;
  displayCategory?: string;
  path: string;
  startUrl: string;
  startedAt?: string;
  updatedAt?: string;
  eventCount: number;
}

export interface PersonalKnowledgeUploadRequest {
  filename: string;
  contentBase64: string;
}

export interface PersonalKnowledgeFolderImportFailure {
  filePath: string;
  error: string;
}

export interface PersonalKnowledgeFolderImportResult {
  folderPath: string;
  discovered: number;
  imported: number;
  skipped: number;
  failed: PersonalKnowledgeFolderImportFailure[];
}

export interface SessionDocumentUploadRequest {
  sessionId?: string;
  filename: string;
  contentBase64: string;
}

export interface SessionDocumentContext {
  id: string;
  sessionId: string;
  filename: string;
  sourceExt: string;
  xmlPath: string;
  workspaceCopyPath?: string;
  commentCount: number;
  charCount: number;
  excerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDocumentUploadResult {
  sessionId: string;
  document: SessionDocumentContext;
}

export interface PersonalKnowledgeDocument {
  id: string;
  title: string;
  filename: string;
  sourceExt: string;
  sourcePath: string;
  markdownPath: string;
  imagesDir?: string;
  chunkCount: number;
  charCount: number;
  excerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalKnowledgeState {
  docs: PersonalKnowledgeDocument[];
  totalDocs: number;
  totalChunks: number;
  totalChars: number;
}

export interface ToolRunRequest {
  name: string;
  args: unknown;
  sessionId?: string;
  executionMode?: ExecutionMode;
}

export interface SearchResult<T> {
  item: T;
  score: number;
  highlights: string[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix = 'id'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
