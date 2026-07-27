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
  contentOmitted?: boolean;
  contentLength?: number;
  attachments?: AgentMessageAttachment[];
  reasoning_content?: string;
  reasoningOmitted?: boolean;
  reasoningLength?: number;
  reasoning_parts?: string[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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

export interface PublicAppBrandingSettings extends AppBrandingSettings {
  logoDataUrl?: string;
}

export interface AppConfig {
  branding: AppBrandingSettings;
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
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
  theme: 'dark' | 'light';
  systemPersona: string;
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

export interface PublicAppConfig extends Omit<AppConfig, 'apiKey' | 'emailNotifications' | 'branding'> {
  branding: PublicAppBrandingSettings;
  apiKeyConfigured: boolean;
  apiKey?: string;
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
  source: 'bundled' | 'local';
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

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  domain?: MemoryDomain | string;
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
  reasoning_content?: string;
  reasoning_parts?: string[];
  createdAt?: string;
}

export type ExecutionMode = 'workspace' | 'sandbox';

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

export interface MarketplaceBrowseResult {
  sources: SkillMarketplaceSource[];
  skills: MarketplaceSkill[];
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
