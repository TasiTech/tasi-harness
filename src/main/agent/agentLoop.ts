import type { AgentArtifactRef, AgentMessage, AgentMessageDeltaStream, AgentRunOptions, AgentRunResult, AppConfig, DshSidecarRuntimePlugin, DshSidecarRuntimeStatus, LlmCompletion, LlmRequestMetadata, SessionRecord, ToolApprovalRequester, ToolEvent } from '../../shared/types.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import type { LlmClient } from './llmClient.js';
import { createId, nowIso } from '../../shared/types.js';
import { CONTENT_STREAM_PREVIEW_CHARS, REASONING_STREAM_PREVIEW_CHARS, prepareMessageDeltaForDisplay } from '../../shared/reasoningPreview.js';
import { ARTIFACT_EXTENSIONS, classifyArtifactKind, isArtifactExtension, mimeTypeForArtifact, previewModeForArtifact } from '../../shared/artifacts.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { SessionStore } from '../storage/sessionStore.js';
import { PromptBuilder } from './promptBuilder.js';

const REPEATED_TOOL_RESULT_LIMIT = 3;
const REPEATED_REASONING_PATTERN_LIMIT = 5;
const REPEATED_REASONING_MAX_BLOCK_LINES = 24;
const REASONING_WITHOUT_CONTENT_CHAR_LIMIT = 12000;
const REASONING_TOTAL_CHAR_LIMIT = 32000;
const REASONING_ONLY_CONTINUE_LIMIT = 3;
const SKILL_DELIVERY_VALIDATION_REPAIR_LIMIT = 3;
const DOCUMENT_OUTPUT_EXTENSIONS = new Set(['.md', '.markdown', '.docx', '.doc', '.pdf', '.pptx', '.ppt', '.xlsx', '.xls']);
const ARTIFACT_EXTENSION_PATTERN = [...ARTIFACT_EXTENSIONS]
  .map((ext) => ext.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const TEXT_DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown']);
const OFFICE_ZIP_DOCUMENT_EXTENSIONS = new Set(['.docx', '.pptx', '.xlsx']);
const DOCUMENT_TASK_PATTERN = new RegExp([
  String.raw`\b(?:write|draft|create|generate|prepare|assemble|produce|export|deliver|revise|polish)\b.{0,40}\b(?:document|docx|word|report|proposal|solution|bid|tender|quotation|contract|ppt|presentation|pdf|excel|spreadsheet|markdown)\b`,
  String.raw`\b(?:document|docx|word|report|proposal|solution|bid|tender|quotation|contract|ppt|presentation|pdf|excel|spreadsheet|markdown)\b.{0,40}\b(?:write|draft|create|generate|prepare|assemble|produce|export|deliver|revise|polish)\b`,
  String.raw`\u5199(?:\u4e00\u4efd|\u4e00\u4e2a|\u51fa)?(?:\u6587\u6863|\u62a5\u544a|\u65b9\u6848|\u6807\u4e66|\u6295\u6807\u6587\u4ef6|\u62db\u6807\u54cd\u5e94|\u62a5\u4ef7\u6587\u4ef6|\u5408\u540c|\u8bba\u6587|\u7b80\u5386)`,
  String.raw`\u751f\u6210(?:\u6587\u6863|\u62a5\u544a|\u65b9\u6848|\u6807\u4e66|\u6295\u6807\u6587\u4ef6|Word|DOCX|PPT|PDF|Excel|Markdown)`,
  String.raw`\u5236\u4f5c(?:\u6587\u6863|\u62a5\u544a|\u65b9\u6848|\u6807\u4e66|\u6295\u6807\u6587\u4ef6|PPT)`,
  String.raw`\u5bfc\u51fa(?:\u6587\u6863|Word|DOCX|PPT|PDF|Excel|Markdown)`,
  String.raw`(?:\u6295\u6807\u6587\u4ef6|\u6807\u4e66|\u62db\u6807\u54cd\u5e94|\u62a5\u4ef7\u6587\u4ef6|\u6280\u672f\u65b9\u6848|\u5546\u52a1\u54cd\u5e94|\u5b9e\u65bd\u65b9\u6848|\u9a8c\u6536\u65b9\u6848|\u552e\u540e\u65b9\u6848).{0,16}(?:\u5199|\u64b0\u5199|\u7f16\u5199|\u751f\u6210|\u5236\u4f5c|\u5bfc\u51fa)`
].join('|'), 'i');
const DOCUMENT_FILE_REQUEST_PATTERN = new RegExp([
  String.raw`\b(?:docx|word|pdf|pptx|ppt|excel|xlsx|markdown|md|document file|saved file|export)\b`,
  String.raw`(?:Word|DOCX|PPT|PDF|Excel|Markdown|\u6587\u4ef6|\u5bfc\u51fa|\u4fdd\u5b58|\u751f\u6210\u6587\u6863|\u751f\u6210\u62a5\u544a|\u751f\u6210\u65b9\u6848|\u751f\u6210\u6807\u4e66|\u751f\u6210\u6295\u6807\u6587\u4ef6)`
].join('|'), 'i');
const DOCUMENT_SKILL_PATTERN = /^(?:docx|document|solution-writer|bid-writer|bid-evaluation|bid-comparison-evaluation|pptx|pdf|xlsx|article-writer|alarm-report-generator)$/i;
const FULL_BID_PATTERN = new RegExp([
  String.raw`full bid|complete bid`,
  String.raw`\u5b8c\u6574.*(?:\u6295\u6807|\u6807\u4e66)`,
  String.raw`\u5168\u5957.*(?:\u6295\u6807|\u6807\u4e66)`,
  String.raw`\u6295\u6807\u6587\u4ef6|\u6807\u4e66|\u62db\u6807\u54cd\u5e94|\u62a5\u4ef7\u6587\u4ef6`
].join('|'), 'i');
const DELIVERY_STATUS_PATTERN = /\b(?:Final delivery|Draft delivery|Blocked)\b|\u6700\u7ec8\u4ea4\u4ed8|\u8349\u7a3f\u4ea4\u4ed8|\u963b\u585e|\u53d7\u963b/i;
const DEGRADED_DELIVERY_PATTERN = /\b(?:Draft delivery|Blocked|draft|partial|degraded|blocked)\b|\u8349\u7a3f\u4ea4\u4ed8|\u963b\u585e|\u53d7\u963b|\u521d\u7a3f|\u8349\u7a3f|\u5f85\u8865\u5145|\u65e0\u6cd5\u6700\u7ec8|\u4e0d\u80fd\u4f5c\u4e3a|\u4e0d\u4f5c\u4e3a\u6b63\u5f0f|\u9700\u4eba\u5de5\u8865\u5145/i;
const FINAL_DELIVERY_PATTERN = /\b(?:Final delivery|final|complete|completed|done|ready|finished)\b|\u6700\u7ec8\u4ea4\u4ed8|\u6b63\u5f0f\u4ea4\u4ed8|\u5df2\u5b8c\u6210|\u53ef\u4ea4\u4ed8|\u5b8c\u6210|\u5df2\u751f\u6210|\u4ea4\u4ed8\u5b8c\u6210/i;
const UNRESOLVED_MARKER_PATTERN = /\[(?:\u5f85\u8865\u5145|TODO|TBD)|TODO|TBD|\u5f85\u586b\u5199|\u5f85\u786e\u8ba4|\u5f85\u5b9a|\u5360\u4f4d|placeholder|\u672a\u8865\u5145|\u5f85\u5b8c\u5584|xxxx/i;
const REQUIRED_FULL_BID_SCRIPTS = [
  'inventory_materials.py',
  'extract_tender_text.py',
  'create_bid_checkpoint.py',
  'validate_bid_package.py'
];
const STREAM_REASONING_EMIT_MS = 650;
const STREAM_CONTENT_EMIT_MS = 45;
const STREAM_SNAPSHOT_PERSIST_MS = 2000;
const STREAM_SNAPSHOT_PERSIST_CHARS = 4096;
const RECOVERABLE_LLM_INTERRUPTION_PATTERN = /Invalid LLM (?:JSON )?stream event|LLM stream response did not include a readable body|fetch failed|terminated|socket hang up|ECONNRESET|EPIPE|UND_ERR|network/i;
const ITERATION_LIMIT_MESSAGE_PATTERN = /^\u672c\u8f6e\u5df2\u8fbe\u5230\u6700\u5927(?:\u6a21\u578b\u8fed\u4ee3\u8f6e\u6b21|\u6267\u884c\u6b65\u6570)\uff08\d+\uff09\uff0c\u6211\u5148\u505c\u5728\u8fd9\u91cc\uff0c\u907f\u514d\u7ee7\u7eed\u6d88\u8017\u65e0\u6548(?:\u8bf7\u6c42|\u6b65\u9aa4)\u3002/;

interface SkillDeliveryValidation {
  ok: boolean;
  issues: string[];
  requiredActions: string[];
  raw: string;
}

interface DocumentDeliveryContext {
  needed: boolean;
  documentIntent: boolean;
  fileRequested: boolean;
  fullBid: boolean;
  loadedSkills: string[];
  artifacts: string[];
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : (value == null ? '' : String(value));
}

function parseToolArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  const trimmed = textValue(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? item.trim() : stableStringify(item)).filter(Boolean).slice(0, 20);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function compactBlock(content: unknown, maxLength: number): string {
  const text = textValue(content).trim();
  if (text.length <= maxLength) return text;
  const head = text.slice(0, Math.floor(maxLength * 0.65)).trimEnd();
  const tail = text.slice(-Math.floor(maxLength * 0.25)).trimStart();
  return `${head}\n...[omitted for validation prompt]...\n${tail}`;
}

function withRuntimeContext(message: AgentMessage, runtimeContext: string): AgentMessage {
  const context = runtimeContext.trim();
  if (!context) return message;
  return {
    ...message,
    content: [
      message.content,
      '',
      context
    ].join('\n')
  };
}

function toolArgsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function stringArgValue(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value.trim() : '';
}

function isDocumentArtifactPath(path: string, documentIntent: boolean): boolean {
  const ext = extname(path).toLowerCase();
  return DOCUMENT_OUTPUT_EXTENSIONS.has(ext) || (documentIntent && ext === '.html');
}

function isGeneratedArtifactPath(path: string): boolean {
  return isArtifactExtension(extname(path).toLowerCase());
}

interface PluginMentionResolution {
  runtimeContext: string;
  enabledToolNames: string[];
}

function pluginMentionTokens(input: string): string[] {
  const tokens = new Set<string>();
  const pattern = /(^|[\s,，;；。！？!?])@([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/g;
  for (const match of input.matchAll(pattern)) {
    const token = match[2]?.trim();
    if (token) tokens.add(token.toLowerCase());
  }
  return [...tokens];
}

function pluginAliases(plugin: DshSidecarRuntimePlugin): string[] {
  const aliases = new Set<string>();
  const add = (value?: string) => {
    const clean = value?.trim().replace(/^@/, '').toLowerCase();
    if (clean) aliases.add(clean);
  };
  add(plugin.id);
  add(plugin.packageName);
  const packageParts = plugin.packageName.replace(/^@/, '').split('/');
  if (packageParts.length > 1) {
    add(packageParts.join('/'));
    add(packageParts.at(-1));
  }
  for (const command of plugin.commands ?? []) add(command.replace(/^\//, ''));
  return [...aliases];
}

function resolvePluginMention(token: string, plugins: DshSidecarRuntimePlugin[]): DshSidecarRuntimePlugin | undefined {
  const clean = token.replace(/^@/, '').toLowerCase();
  return plugins.find((plugin) => pluginAliases(plugin).includes(clean));
}

function pluginMentionStatusText(plugin: DshSidecarRuntimePlugin): string {
  if (!plugin.enabled) return 'disabled';
  return plugin.status;
}

async function resolvePluginMentions(
  userInput: string,
  getDshRuntimeStatus?: () => Promise<DshSidecarRuntimeStatus>
): Promise<PluginMentionResolution> {
  const mentions = pluginMentionTokens(userInput);
  if (mentions.length === 0 || !getDshRuntimeStatus) return { runtimeContext: '', enabledToolNames: [] };
  let status: DshSidecarRuntimeStatus;
  try {
    status = await getDshRuntimeStatus();
  } catch (error) {
    return {
      runtimeContext: [
        '## DSH Plugin References',
        `- Requested: ${mentions.map((mention) => `@${mention}`).join(', ')}`,
        `- Runtime status unavailable: ${error instanceof Error ? error.message : String(error)}`
      ].join('\n'),
      enabledToolNames: []
    };
  }
  const resolved: Array<{ mention: string; plugin: DshSidecarRuntimePlugin }> = [];
  const missing: string[] = [];
  for (const mention of mentions) {
    const plugin = resolvePluginMention(mention, status.plugins);
    if (plugin) resolved.push({ mention, plugin });
    else missing.push(mention);
  }
  if (resolved.length === 0 && missing.length === 0) return { runtimeContext: '', enabledToolNames: [] };
  const enabledToolNames = resolved
    .filter(({ plugin }) => plugin.enabled && (plugin.status === 'loaded' || plugin.status === 'partial'))
    .flatMap(({ plugin }) => plugin.tools);
  const lines = [
    '## DSH Plugin References',
    'The user referenced plugin(s) with @ syntax. Prefer the referenced plugin tools when they fit the task. If a referenced plugin exposes Skills, call skill_view for the relevant listed skill before other task work so the plugin workflow is actually applied. If a referenced plugin is disabled, failed, or exposes no agent-callable tools or skills, state that limitation plainly.',
    'If the same user message includes an http:// or https:// URL, open or inspect that exact URL instead of reusing an older browser page from prior turns.'
  ];
  for (const { mention, plugin } of resolved) {
    lines.push(`- @${mention} -> ${plugin.packageName} (${pluginMentionStatusText(plugin)})`);
    if (plugin.tools.length > 0) lines.push(`  Tools: ${plugin.tools.join(', ')}`);
    if ((plugin.skills ?? []).length > 0) lines.push(`  Skills: ${(plugin.skills ?? []).join(', ')}`);
    if ((plugin.commands ?? []).length > 0) lines.push(`  Commands: ${(plugin.commands ?? []).join(', ')}`);
    if ((plugin.settingsEntries ?? []).length > 0) lines.push(`  Settings: ${(plugin.settingsEntries ?? []).join(', ')}`);
    if (plugin.lastError) lines.push(`  Runtime note: ${plugin.lastError}`);
  }
  if (missing.length > 0) lines.push(`- Unmatched plugin references: ${missing.map((mention) => `@${mention}`).join(', ')}`);
  return { runtimeContext: lines.join('\n'), enabledToolNames: [...new Set(enabledToolNames)] };
}

function normalizeArtifactCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.,;，。；]+$/g, '')
    .trim();
}

function isInvalidArtifactCandidate(path: string): boolean {
  if (!path) return true;
  if (/[*?]/.test(path)) return true;
  if (/\uFFFD/.test(path)) return true;
  if (/https?:[\\/]/i.test(path)) return true;
  if (/[[\]()]/.test(path)) return true;
  if (/(^|[\\/])SKILL\.md$/i.test(path)) return true;
  return false;
}

function addDocumentArtifact(artifacts: Set<string>, candidate: string, documentIntent: boolean): void {
  const path = normalizeArtifactCandidate(candidate);
  if (isInvalidArtifactCandidate(path)) return;
  if (isDocumentArtifactPath(path, documentIntent)) artifacts.add(path);
}

function addGeneratedArtifact(artifacts: Set<string>, candidate: string): void {
  const path = normalizeArtifactCandidate(candidate);
  if (isInvalidArtifactCandidate(path)) return;
  if (isGeneratedArtifactPath(path)) artifacts.add(path);
}

function artifactPathPattern(): RegExp {
  return new RegExp(`"([^"]+\\.(${ARTIFACT_EXTENSION_PATTERN}))"|'([^']+\\.(${ARTIFACT_EXTENSION_PATTERN}))'|([^\\s"'<>]+\\.(${ARTIFACT_EXTENSION_PATTERN}))`, 'gi');
}

function collectTerminalCommandOutputArtifacts(command: string, artifacts: Set<string>, documentIntent: boolean): void {
  const docExts = 'md|markdown|docx|doc|pdf|pptx|ppt|xlsx|xls|html';
  const outputArgPattern = new RegExp(`(?:^|\\s)(?:--output(?:-file)?|--out|--outfile|--dest(?:ination)?|-o)\\s+(?:"([^"]+\\.(?:${docExts}))"|'([^']+\\.(?:${docExts}))'|([^\\s"'<>]+\\.(?:${docExts})))`, 'gi');
  const redirectPattern = new RegExp(`(?:^|\\s)(?:1?>|>>)\\s*(?:"([^"]+\\.(?:${docExts}))"|'([^']+\\.(?:${docExts}))'|([^\\s"'<>]+\\.(?:${docExts})))`, 'gi');
  for (const pattern of [outputArgPattern, redirectPattern]) {
    for (const match of command.matchAll(pattern)) {
      addDocumentArtifact(artifacts, match[1] || match[2] || match[3] || '', documentIntent);
    }
  }
}

function collectTerminalOutputArtifacts(content: string, artifacts: Set<string>, documentIntent: boolean): void {
  const generatedLinePattern = /^(?:wrote|written|generated|created|saved|exported|converted|output(?:\s+(?:file|path|document))?|\u751f\u6210|\u5df2\u751f\u6210|\u5df2\u5199\u5165|\u5199\u5165|\u521b\u5efa|\u5df2\u521b\u5efa|\u4fdd\u5b58|\u5df2\u4fdd\u5b58|\u5bfc\u51fa|\u5df2\u5bfc\u51fa|\u8f93\u51fa)\s*[:\uff1a]?\s*(.+)$/i;
  const pathPattern = new RegExp(`"([^"]+\\.(?:md|markdown|docx|doc|pdf|pptx|ppt|xlsx|xls|html))"|'([^']+\\.(?:md|markdown|docx|doc|pdf|pptx|ppt|xlsx|xls|html))'|([^\\s"'<>]+\\.(?:md|markdown|docx|doc|pdf|pptx|ppt|xlsx|xls|html))`, 'gi');
  for (const rawLine of content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const generated = generatedLinePattern.exec(line);
    if (!generated?.[1]) continue;
    for (const match of generated[1].matchAll(pathPattern)) {
      addDocumentArtifact(artifacts, match[1] || match[2] || match[3] || '', documentIntent);
    }
  }
}

function collectGeneratedArtifactPaths(toolEvents: ToolEvent[]): string[] {
  const artifacts = new Set<string>();
  for (const event of toolEvents) {
    const args = toolArgsRecord(event.args);
    const explicitPath = stringArgValue(args, 'path');
    if (event.toolName === 'file_write' && explicitPath) addGeneratedArtifact(artifacts, explicitPath);
    if (event.toolName === 'terminal') {
      const command = stringArgValue(args, 'command');
      for (const source of [command, event.content]) {
        for (const match of source.matchAll(artifactPathPattern())) {
          addGeneratedArtifact(artifacts, match[1] || match[3] || match[5] || '');
        }
      }
    }
  }
  return [...artifacts].slice(0, 20);
}

function buildArtifactRefs(paths: string[], workspaceDir: string, source: AgentArtifactRef['source']): AgentArtifactRef[] {
  const seen = new Set<string>();
  const artifacts: AgentArtifactRef[] = [];
  for (const rawPath of paths) {
    const cleanPath = normalizeArtifactCandidate(rawPath);
    if (isInvalidArtifactCandidate(cleanPath)) continue;
    const absPath = resolveWorkspaceArtifact(workspaceDir, cleanPath);
    if (!absPath || seen.has(absPath) || !existsSync(absPath)) continue;
    const stat = statSync(absPath);
    if (!stat.isFile()) continue;
    const ext = extname(absPath).toLowerCase();
    if (!isArtifactExtension(ext)) continue;
    seen.add(absPath);
    artifacts.push({
      id: createId('artifact'),
      name: basename(absPath),
      path: isPathInside(workspaceDir, absPath) ? relative(workspaceDir, absPath) : absPath,
      absPath,
      ext,
      kind: classifyArtifactKind(ext),
      previewMode: previewModeForArtifact(ext),
      mimeType: mimeTypeForArtifact(ext),
      sizeBytes: stat.size,
      source,
      createdAt: nowIso()
    });
  }
  return artifacts;
}

function collectDocumentArtifacts(toolEvents: ToolEvent[], documentIntent: boolean): string[] {
  const artifacts = new Set<string>();
  for (const event of toolEvents) {
    const args = toolArgsRecord(event.args);
    const explicitPath = stringArgValue(args, 'path');
    if (event.toolName === 'file_write' && explicitPath) addDocumentArtifact(artifacts, explicitPath, documentIntent);
    const command = stringArgValue(args, 'command');
    if (event.toolName === 'terminal') {
      if (command) collectTerminalCommandOutputArtifacts(command, artifacts, documentIntent);
      collectTerminalOutputArtifacts(event.content, artifacts, documentIntent);
    }
  }
  return [...artifacts].slice(0, 20);
}

function documentDeliveryContext(userInput: string, toolEvents: ToolEvent[]): DocumentDeliveryContext {
  const documentIntent = DOCUMENT_TASK_PATTERN.test(userInput);
  const loadedSkills = toolEvents
    .filter((event) => event.toolName === 'skill_view' && event.ok)
    .map((event) => stringArgValue(toolArgsRecord(event.args), 'name'))
    .filter(Boolean);
  const documentSkillUsed = loadedSkills.some((name) => DOCUMENT_SKILL_PATTERN.test(name));
  const artifacts = collectDocumentArtifacts(toolEvents, documentIntent || documentSkillUsed);
  const fullBid = FULL_BID_PATTERN.test(userInput) || (loadedSkills.some((name) => /^bid-writer$/i.test(name)) && FULL_BID_PATTERN.test(userInput));
  return {
    needed: toolEvents.some((event) => event.toolName === 'skill_view' && event.ok) || documentIntent || documentSkillUsed || artifacts.length > 0,
    documentIntent,
    fileRequested: DOCUMENT_FILE_REQUEST_PATTERN.test(userInput) || artifacts.length > 0 || fullBid,
    fullBid,
    loadedSkills,
    artifacts
  };
}

function isDeliveryValidationNeeded(userInput: string, toolEvents: ToolEvent[]): boolean {
  return documentDeliveryContext(userInput, toolEvents).needed;
}

function summarizeSkillDeliveryToolEvents(toolEvents: ToolEvent[]): string {
  const relevant = toolEvents.filter((event) => (
    event.toolName === 'skill_view'
    || event.toolName === 'file_read'
    || event.toolName === 'file_write'
    || event.toolName === 'skill_manage'
    || event.toolName === 'terminal'
    || event.toolName === 'apply_patch'
  ));
  return relevant.slice(-24).map((event, index) => {
    const status = event.ok ? 'ok' : 'failed';
    return [
      `#${index + 1} ${event.toolName} ${status}`,
      `args: ${stableStringify(event.args)}`,
      `result: ${compactBlock(event.content, event.toolName === 'skill_view' ? 6000 : 1200)}`
    ].join('\n');
  }).join('\n\n');
}

function resolveWorkspaceArtifact(workspaceDir: string, artifactPath: string): string | null {
  if (!artifactPath.trim()) return null;
  const workspace = resolve(workspaceDir);
  const target = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(workspace, artifactPath);
  return target;
}

function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedTarget = resolve(target).replace(/\\/g, '/');
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function deliveredAsDegraded(candidateFinalResponse: string): boolean {
  return DEGRADED_DELIVERY_PATTERN.test(candidateFinalResponse);
}

function claimsFinalDelivery(candidateFinalResponse: string): boolean {
  return FINAL_DELIVERY_PATTERN.test(candidateFinalResponse);
}

function hasUnresolvedMarkers(text: string): boolean {
  return UNRESOLVED_MARKER_PATTERN.test(text);
}

function terminalCommandNames(toolEvents: ToolEvent[]): Set<string> {
  const commands = new Set<string>();
  for (const event of toolEvents) {
    if (event.toolName !== 'terminal') continue;
    const args = toolArgsRecord(event.args);
    const command = stringArgValue(args, 'command');
    for (const script of REQUIRED_FULL_BID_SCRIPTS) {
      if (command.includes(script) || event.content.includes(script)) commands.add(script);
    }
  }
  return commands;
}

async function validateDocxArtifact(path: string, context: DocumentDeliveryContext, candidateFinalResponse: string): Promise<string[]> {
  const issues: string[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(readFileSync(path));
  } catch (error) {
    return [`DOCX artifact is not a readable Office ZIP package: ${path} (${error instanceof Error ? error.message : String(error)})`];
  }
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) return [`DOCX artifact is missing word/document.xml: ${path}`];
  const documentXml = await documentXmlFile.async('string');
  const plainText = documentXml.replace(/<[^>]+>/g, '');
  if (plainText.trim().length < 20) issues.push(`DOCX artifact has too little readable body text: ${path}`);
  if (hasUnresolvedMarkers(plainText) && !deliveredAsDegraded(candidateFinalResponse)) {
    issues.push(`DOCX artifact contains unresolved placeholders but the delivery was not downgraded: ${path}`);
  }
  if (context.fullBid && claimsFinalDelivery(candidateFinalResponse)) {
    if (!/TOC\s+\\|TOC\\|<w:instrText[^>]*>[^<]*TOC/i.test(documentXml)) {
      issues.push(`Full-bid DOCX final delivery is missing a real Word TOC field: ${path}`);
    }
    if (!/<w:pStyle\b[^>]*w:val="Heading/i.test(documentXml)) {
      issues.push(`Full-bid DOCX final delivery is missing real Word Heading styles: ${path}`);
    }
  }
  return issues;
}

async function validateOfficeZipArtifact(path: string, ext: string): Promise<string[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(readFileSync(path));
  } catch (error) {
    return [`Office artifact is not a readable ZIP package: ${path} (${error instanceof Error ? error.message : String(error)})`];
  }
  const expectedEntry = ext === '.pptx' ? 'ppt/presentation.xml' : ext === '.xlsx' ? 'xl/workbook.xml' : '';
  if (expectedEntry && !zip.file(expectedEntry)) return [`Office artifact is missing ${expectedEntry}: ${path}`];
  return [];
}

async function validateDocumentArtifact(path: string, context: DocumentDeliveryContext, candidateFinalResponse: string): Promise<string[]> {
  const ext = extname(path).toLowerCase();
  const issues: string[] = [];
  if (!existsSync(path)) return [`Document artifact was referenced but does not exist: ${path}`];
  const stat = statSync(path);
  if (!stat.isFile()) return [`Document artifact path is not a file: ${path}`];
  if (stat.size === 0) return [`Document artifact is empty: ${path}`];
  if (TEXT_DOCUMENT_EXTENSIONS.has(ext) || ext === '.html') {
    const text = readFileSync(path, 'utf8');
    if (text.trim().length < 20) issues.push(`Document artifact has too little content: ${path}`);
    if (hasUnresolvedMarkers(text) && !deliveredAsDegraded(candidateFinalResponse)) {
      issues.push(`Document artifact contains unresolved placeholders but the delivery was not downgraded: ${path}`);
    }
  } else if (ext === '.docx') {
    issues.push(...await validateDocxArtifact(path, context, candidateFinalResponse));
  } else if (OFFICE_ZIP_DOCUMENT_EXTENSIONS.has(ext)) {
    issues.push(...await validateOfficeZipArtifact(path, ext));
  } else if (ext === '.pdf') {
    const header = readFileSync(path).subarray(0, 4).toString('utf8');
    if (header !== '%PDF') issues.push(`PDF artifact does not have a PDF header: ${path}`);
  }
  return issues;
}

async function hardValidateDocumentDelivery(
  candidateFinalResponse: string,
  toolEvents: ToolEvent[],
  userInput: string,
  workspaceDir: string
): Promise<SkillDeliveryValidation> {
  const context = documentDeliveryContext(userInput, toolEvents);
  if (!context.needed) return { ok: true, issues: [], requiredActions: [], raw: '' };
  const issues: string[] = [];
  const requiredActions: string[] = [];
  const degraded = deliveredAsDegraded(candidateFinalResponse);
  const finalClaim = claimsFinalDelivery(candidateFinalResponse);

  if (hasUnresolvedMarkers(candidateFinalResponse) && !degraded) {
    issues.push('Final answer contains unresolved placeholders but does not clearly label the result as Draft delivery or Blocked.');
    requiredActions.push('Replace unresolved placeholders, or explicitly downgrade the delivery status and list the remaining blockers.');
  }

  if (context.fullBid && !DELIVERY_STATUS_PATTERN.test(candidateFinalResponse)) {
    issues.push('Full bid delivery is missing an explicit status: Final delivery, Draft delivery, or Blocked.');
    requiredActions.push('State the bid delivery status exactly as Final delivery, Draft delivery, or Blocked.');
  }

  if (context.fullBid && finalClaim) {
    const scriptsRun = terminalCommandNames(toolEvents);
    const missingScripts = REQUIRED_FULL_BID_SCRIPTS.filter((script) => !scriptsRun.has(script));
    if (missingScripts.length > 0) {
      issues.push(`Full bid final delivery is missing required helper script evidence: ${missingScripts.join(', ')}.`);
      requiredActions.push('Run the missing bid-writer helper scripts or downgrade the result to Draft delivery/Blocked with the exact reason.');
    }
  }

  if (context.fullBid && context.fileRequested && context.artifacts.length === 0 && finalClaim) {
    issues.push('Full bid final delivery claims completion but no durable document artifact was recorded.');
    requiredActions.push('Create the required bid document artifact, or downgrade the result to Draft delivery/Blocked.');
  }

  for (const artifact of context.artifacts) {
    const resolved = resolveWorkspaceArtifact(workspaceDir, artifact);
    if (!resolved) {
      issues.push(`Document artifact resolves outside the active workspace and cannot be hard-validated: ${artifact}`);
      requiredActions.push('Keep generated document artifacts inside the active workspace before final delivery.');
      continue;
    }
    const artifactIssues = await validateDocumentArtifact(resolved, context, candidateFinalResponse);
    issues.push(...artifactIssues);
    if (artifactIssues.length > 0) requiredActions.push(`Repair or explicitly downgrade artifact: ${artifact}`);
  }

  if (issues.length === 0) return { ok: true, issues: [], requiredActions: [], raw: 'deterministic document delivery gate passed' };
  return {
    ok: false,
    issues: [...new Set(issues)].slice(0, 20),
    requiredActions: [...new Set(requiredActions)].slice(0, 20),
    raw: 'deterministic document delivery gate failed'
  };
}

function parseSkillDeliveryValidation(content: unknown): SkillDeliveryValidation {
  const raw = textValue(content);
  const parsed = parseJsonObject(content);
  if (!parsed) {
    if (/"?ok"?\s*[:=]\s*true\b/i.test(raw) || /\b(pass(?:ed)?|satisf(?:y|ies|ied)|no issues?|valid)\b/i.test(raw) || /\u9a8c\u8bc1\u901a\u8fc7|\u53ef\u4ee5\u4ea4\u4ed8|\u6ee1\u8db3\u8981\u6c42/.test(raw)) {
      return { ok: true, issues: [], requiredActions: [], raw };
    }
    if (/"?ok"?\s*[:=]\s*false\b/i.test(raw) || /\b(fail(?:ed)?|missing|required|must|issue|problem|blocker)\b/i.test(raw) || /\u672a\u901a\u8fc7|\u4e0d\u901a\u8fc7|\u7f3a\u5c11|\u5fc5\u987b|\u9700\u8981\u4fee\u590d|\u95ee\u9898|\u963b\u585e/.test(raw)) {
      return {
        ok: false,
        issues: [compactBlock(raw, 800) || 'Skill delivery validation did not pass.'],
        requiredActions: ['Fix the validation findings, or explicitly report a blocker/degraded result if they cannot be fixed.'],
        raw
      };
    }
    return {
      ok: true,
      issues: [],
      requiredActions: [],
      raw
    };
  }
  const ok = parsed.ok === true;
  const issues = stringList(parsed.issues);
  const requiredActions = stringList(parsed.required_actions ?? parsed.requiredActions);
  return {
    ok,
    issues: ok ? [] : (issues.length > 0 ? issues : ['Skill delivery validation did not pass.']),
    requiredActions: ok ? [] : requiredActions,
    raw
  };
}

function validationRepairPrompt(validation: SkillDeliveryValidation, attempt: number, limit: number): string {
  const issues = validation.issues.map((issue) => `- ${issue}`).join('\n') || '- No concrete issue was reported.';
  const actions = validation.requiredActions.map((action) => `- ${action}`).join('\n') || '- Complete the missing skill, evidence, artifact, validation, or degraded-status step.';
  return [
    `Skill delivery validation failed (${attempt}/${limit}). Continue the same task and fix the deliverable before finalizing.`,
    validation.raw ? `Validator: ${validation.raw}` : '',
    '',
    'Issues:',
    issues,
    '',
    'Required actions:',
    actions,
    '',
    'Do not present the prior answer as complete. Use tools if the validation says evidence, files, or generated artifacts are missing. If the issue cannot be fixed, explicitly report the blocker/degraded result.'
  ].join('\n');
}

function validationFailureResponse(validation: SkillDeliveryValidation, limit: number): string {
  const issues = validation.issues.map((issue) => `- ${issue}`).join('\n') || '- No concrete issue was reported.';
  const actions = validation.requiredActions.map((action) => `- ${action}`).join('\n') || '- Manual review or another repair turn is required.';
  return [
    `Delivery validation still failed after ${limit} repair attempt(s), so I cannot mark the current result as complete.`,
    '',
    'Failed checks:',
    issues,
    '',
    'Recommended next steps:',
    actions
  ].join('\n');
}

function repeatedToolDiagnostic(toolName: string, args: unknown, ok: boolean, content: string, limit: number): string {
  const resultLabel = ok ? 'ok' : 'fail';
  return [
    `Stopped because the same tool call repeated ${limit} times with the same result.`,
    `Tool: ${toolName}`,
    `Args: ${stableStringify(args)}`,
    `Result: ${resultLabel} - ${content || '(empty)'}`
  ].join('\n');
}

interface ReasoningLoopDetection {
  repeats: number;
  block: string[];
}

class ReasoningLoopAbort extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = 'ReasoningLoopAbort';
  }
}

function normalizeReasoningNewlines(content: unknown): string {
  return textValue(content)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\r\\n|\\n|\\r/g, '\n');
}

function normalizeReasoningLines(content: string): string[] {
  return normalizeReasoningNewlines(content)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\s+/g, ' '))
    .filter(Boolean);
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function detectRepeatedReasoningLoop(content: string): ReasoningLoopDetection | null {
  const lines = normalizeReasoningLines(content);
  const maxBlockLines = Math.min(REPEATED_REASONING_MAX_BLOCK_LINES, Math.floor(lines.length / REPEATED_REASONING_PATTERN_LIMIT));
  for (let blockSize = 1; blockSize <= maxBlockLines; blockSize += 1) {
    const block = lines.slice(lines.length - blockSize);
    let repeats = 1;
    for (let offset = lines.length - blockSize * 2; offset >= 0; offset -= blockSize) {
      if (!arraysEqual(lines.slice(offset, offset + blockSize), block)) break;
      repeats += 1;
    }
    if (repeats >= REPEATED_REASONING_PATTERN_LIMIT) return { repeats, block };
  }
  return null;
}

function repeatedReasoningDiagnostic(detection: ReasoningLoopDetection): string {
  const preview = detection.block.slice(0, 12).map((line) => `- ${line}`);
  if (detection.block.length > preview.length) preview.push(`- ... (${detection.block.length - preview.length} more lines)`);
  return [
    `Stopped because the model reasoning repeated the same planning pattern ${detection.repeats} times.`,
    'This usually indicates the model is stuck in a planning loop, so the run was stopped before more context was consumed.',
    '',
    'Repeated reasoning block:',
    ...preview
  ].join('\n');
}

function reasoningOverrunDiagnostic(reasoning: string, reason: 'without-content' | 'total-limit'): string {
  const lineCount = normalizeReasoningLines(reasoning).length;
  const lead = reason === 'without-content'
    ? 'Stopped because the model produced a long reasoning stream without any visible answer or tool call.'
    : 'Stopped because the model reasoning exceeded the safety limit for one run.';
  return [
    lead,
    `Reasoning length: ${reasoning.length} chars, ${lineCount} non-empty lines.`,
    'This usually means the model is stuck planning instead of making progress. Try continuing with a narrower next step, or use a tool/file-backed workflow for the blocking operation.'
  ].join('\n');
}

function reasoningOverrunReason(reasoning: string, visibleContent: string): 'without-content' | 'total-limit' | null {
  if (reasoning.length >= REASONING_TOTAL_CHAR_LIMIT) return 'total-limit';
  if (!visibleContent.trim() && reasoning.length >= REASONING_WITHOUT_CONTENT_CHAR_LIMIT) return 'without-content';
  return null;
}

function compactToolText(content: unknown, maxLength = 160): string {
  const text = textValue(content).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function iterationLimitResponse(maxIterations: number, toolEvents: ToolEvent[]): string {
  const recentEvents = toolEvents.slice(-5);
  const lines = [
    `\u672c\u8f6e\u5df2\u8fbe\u5230\u6700\u5927\u6a21\u578b\u8fed\u4ee3\u8f6e\u6b21\uff08${maxIterations}\uff09\uff0c\u6211\u5148\u505c\u5728\u8fd9\u91cc\uff0c\u907f\u514d\u7ee7\u7eed\u6d88\u8017\u65e0\u6548\u8bf7\u6c42\u3002`,
    '',
    `\u672c\u8f6e\u5b9e\u9645\u5de5\u5177\u8c03\u7528\u6b21\u6570\uff1a${toolEvents.length}\u3002`
  ];
  if (recentEvents.length > 0) {
    lines.push('', '\u6700\u8fd1\u5b8c\u6210\u7684\u64cd\u4f5c\uff1a');
    for (const event of recentEvents) {
      const status = event.ok ? '\u6210\u529f' : '\u5931\u8d25';
      const detail = compactToolText(event.content);
      lines.push(`- ${event.toolName}\uff1a${status}${detail ? `\uff1a${detail}` : ''}`);
    }
  }
  lines.push('', '\u5f53\u524d\u9875\u9762\u548c\u4f1a\u8bdd\u72b6\u6001\u5df2\u4fdd\u7559\uff0c\u53ef\u4ee5\u7ee7\u7eed\u8ba9\u6211\u4ece\u5f53\u524d\u72b6\u6001\u63a5\u7740\u505a\u3002');
  return lines.join('\n');
}

function emptyAssistantResponse(): string {
  return [
    '\u6a21\u578b\u672c\u8f6e\u8fd4\u56de\u4e86\u7a7a\u56de\u590d\uff0c\u4e14\u6ca1\u6709\u8bf7\u6c42\u65b0\u7684\u5de5\u5177\u8c03\u7528\uff1b\u6211\u5148\u505c\u5728\u8fd9\u91cc\uff0c\u907f\u514d\u7ee7\u7eed\u7a7a\u8f6c\u3002',
    '',
    '\u5f53\u524d\u9875\u9762\u548c\u4f1a\u8bdd\u72b6\u6001\u5df2\u4fdd\u7559\uff0c\u53ef\u4ee5\u7ee7\u7eed\u8ba9\u6211\u4ece\u5f53\u524d\u72b6\u6001\u63a5\u7740\u505a\u3002'
  ].join('\n');
}

function isRecoverableLlmInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/LLM request failed \((?:400|401|403|404|422)\)/i.test(message)) return false;
  return RECOVERABLE_LLM_INTERRUPTION_PATTERN.test(message);
}

function isIterationLimitMessage(message: AgentMessage): boolean {
  return message.role === 'assistant' && ITERATION_LIMIT_MESSAGE_PATTERN.test(message.content.trim());
}

function isInvisibleEmptyAssistantMessage(message: AgentMessage): boolean {
  return message.role === 'assistant'
    && message.hidden === true
    && !message.content.trim()
    && !message.reasoning_content?.trim()
    && (message.tool_calls?.length ?? 0) === 0;
}

function sessionVisibleAssistantMessage(message: AgentMessage, toolCallCount: number): AgentMessage {
  if (toolCallCount === 0) return message;
  return {
    ...message,
    hidden: true
  };
}

interface AgentLoopRuntimeOptions extends AgentRunOptions {
  onToolEvent?: (sessionId: string, event: ToolEvent) => void;
  onMessageDelta?: (sessionId: string, event: AgentMessageDeltaStream) => void;
  onSessionUpdated?: (session: SessionRecord) => void;
  requestToolApproval?: ToolApprovalRequester;
  signal?: AbortSignal;
  userMessageHidden?: boolean;
  persistUserMessage?: boolean;
  omitHistoryMessageIds?: string[];
}

function createAbortError(): Error {
  const error = new Error('Session stopped by user.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function splitReasoningParts(content: string): string[] {
  const normalized = normalizeReasoningNewlines(content).trim();
  if (!normalized) return [];
  const lineItems = normalized
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter(Boolean);
  if (lineItems.length > 1) return lineItems;
  const sentenceItems = normalized.match(/[^\u3002\uff01\uff1f!?]+[\u3002\uff01\uff1f!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
  return sentenceItems.length > 0 ? sentenceItems : [normalized];
}

export class AgentLoop {
  constructor(
    private readonly deps: {
      getConfig: () => AppConfig;
      createClient: () => LlmClient;
      toolRegistry: ToolRegistry;
      sessions: SessionStore;
      promptBuilder: PromptBuilder;
      prepareExecution: (mode: AgentRunOptions['executionMode'], runId: string, workspaceDir?: string) => AgentRunResult['execution'];
      beginDeferredMemory: (sessionId: string) => void;
      commitDeferredMemory: (sessionId: string) => void;
      discardDeferredMemory: (sessionId: string) => void;
      syncSessionMemory: (session: SessionRecord) => void;
      getDshRuntimeStatus?: () => Promise<DshSidecarRuntimeStatus>;
    }
  ) {}

  async run(options: AgentLoopRuntimeOptions): Promise<AgentRunResult> {
    throwIfAborted(options.signal);
    const cfg = this.deps.getConfig();
    const memoryEnabled = options.useMemory !== false;
    const skillsEnabled = options.useSkills !== false;
    const requestId = createId('run');
    const execution = this.deps.prepareExecution(options.executionMode ?? cfg.defaultExecutionMode, requestId, options.workspaceDir);
    const session = options.sessionId
      ? this.deps.sessions.read(options.sessionId) ?? this.deps.sessions.create('New session', options.sessionId)
      : this.deps.sessions.create();
    if (memoryEnabled) this.deps.beginDeferredMemory(session.id);
    const userMessage: AgentMessage = {
      id: createId('msg'),
      role: 'user',
      content: options.userInput,
      hidden: options.userMessageHidden === true ? true : undefined,
      attachments: options.attachments?.length ? options.attachments : undefined,
      createdAt: nowIso()
    };
    try {
      const omitHistoryMessageIds = new Set(options.omitHistoryMessageIds ?? []);
      const previousHistory = session.messages.filter((message) => (
        message.hidden !== true
        && !omitHistoryMessageIds.has(message.id ?? '')
        && !isIterationLimitMessage(message)
        && !isInvisibleEmptyAssistantMessage(message)
      ));
      const prompt = await this.deps.promptBuilder.buildForMessages(cfg, {
        sessionId: session.id,
        userInput: options.userInput,
        usePersonalKnowledgeBase: options.usePersonalKnowledgeBase,
        useMemory: options.useMemory,
        memoryDomains: options.memoryDomains,
        useSkills: options.useSkills,
        enabledSkillNames: options.enabledSkillNames
      });
      const pluginMentions = await resolvePluginMentions(options.userInput, this.deps.getDshRuntimeStatus);
      this.deps.sessions.setSystemPrompt(session.id, prompt.systemPrompt);
      const messages: AgentMessage[] = [
        { role: 'system', content: prompt.systemPrompt },
        ...previousHistory,
        withRuntimeContext(userMessage, [prompt.runtimeContext, pluginMentions.runtimeContext].filter(Boolean).join('\n\n'))
      ];
      const requestMetadata: LlmRequestMetadata = { session: session.id };
      if (options.turnType !== undefined) requestMetadata.turn_type = options.turnType;
      if (options.sessionDone !== undefined) requestMetadata.session_done = options.sessionDone;
      const client = this.deps.createClient();
      const configuredToolNames = options.enabledToolNames ?? cfg.enabledToolNames;
      const enabledToolNames = [...new Set([...configuredToolNames, ...pluginMentions.enabledToolNames])].filter((name) => {
        if (!memoryEnabled && name === 'memory') return false;
        if (!skillsEnabled && (name === 'skill_view' || name === 'skill_manage')) return false;
        return true;
      });
      const tools = this.deps.toolRegistry.definitions(enabledToolNames);
      const toolEvents: ToolEvent[] = [];
      let usage = undefined as AgentRunResult['usage'];
      let log_probs: AgentRunResult['log_probs'];
      let finalResponse = '';
      let stopReason: 'final' | 'empty' | 'repeated-tool' | 'reasoning-loop' | 'iteration-limit' | undefined;
      let iterations = 0;
      let skillDeliveryRepairCount = 0;
      let updatedSession = session;
      if (options.persistUserMessage !== false) {
        updatedSession = this.deps.sessions.appendMessages(session.id, [userMessage], [], execution);
        options.onSessionUpdated?.(updatedSession);
      }
      const visibleAssistantId = createId('msg');
      const visibleAssistantCreatedAt = nowIso();
      let accumulatedReasoning = '';
      const accumulatedReasoningParts: string[] = [];
      let latestIterationReasoning = '';
      let latestIterationReasoningParts: string[] = [];
      const visibleContentParts: string[] = [];
      let reasoningOnlyContinuationCount = 0;
      let lastStreamPersistedAt = 0;
      let lastStreamPersistedLength = 0;
      let lastToolResultSignature = '';
      let repeatedToolResultCount = 0;
      let lastMessageDeltaEmittedAt = 0;
      let pendingMessageDelta: AgentMessageDeltaStream | undefined;
      let messageDeltaFlushTimer: ReturnType<typeof setTimeout> | undefined;

      const joinReasoning = (parts: string[]): string => parts.map((part) => part.trim()).filter(Boolean).join('\n');
      const joinReasoningParts = (parts: string[]): string[] => parts.map((part) => part.trim()).filter(Boolean);
      const persistMessages = (messagesToPersist: AgentMessage[], events: ToolEvent[] = []): SessionRecord => {
        updatedSession = this.deps.sessions.upsertMessages(session.id, messagesToPersist, events, execution);
        options.onSessionUpdated?.(updatedSession);
        return updatedSession;
      };
      const persistStreamSnapshot = (messageId: string, createdAt: string, content: string, reasoning: string | undefined, force = false, contentParts: string[] = []): void => {
        const persistedReasoning = force ? reasoning : undefined;
        if (!content && !persistedReasoning) return;
        const now = Date.now();
        if (!force && now - lastStreamPersistedAt < STREAM_SNAPSHOT_PERSIST_MS && content.length - lastStreamPersistedLength < STREAM_SNAPSHOT_PERSIST_CHARS) return;
        lastStreamPersistedAt = now;
        lastStreamPersistedLength = content.length;
        persistMessages([{
          id: messageId,
          role: 'assistant',
          content,
          reasoning_content: persistedReasoning,
          content_parts: contentParts.length > 0 ? [...contentParts] : undefined,
          createdAt
        }]);
      };
      const emitDoneDelta = (content: string, reasoning?: string, reasoningParts?: string[], contentParts: string[] = []): void => {
        if (options.stream === false || typeof options.onMessageDelta !== 'function') return;
        flushMessageDelta();
        options.onMessageDelta(session.id, {
          ...prepareMessageDeltaForDisplay({
            sessionId: session.id,
            messageId: visibleAssistantId,
            role: 'assistant',
            type: 'done',
            content,
            reasoning_content: reasoning,
            reasoning_parts: reasoningParts,
            content_parts: contentParts.length > 0 ? [...contentParts] : undefined,
            createdAt: visibleAssistantCreatedAt
          })
        });
      };
      const messageDeltaDelay = (type: AgentMessageDeltaStream['type']): number => (
        type === 'reasoning_content' ? STREAM_REASONING_EMIT_MS : STREAM_CONTENT_EMIT_MS
      );
      const sendMessageDelta = (payload: AgentMessageDeltaStream): void => {
        if (options.stream === false || typeof options.onMessageDelta !== 'function') return;
        if (messageDeltaFlushTimer) {
          clearTimeout(messageDeltaFlushTimer);
          messageDeltaFlushTimer = undefined;
        }
        options.onMessageDelta(session.id, prepareMessageDeltaForDisplay(payload));
        lastMessageDeltaEmittedAt = Date.now();
      };
      const schedulePendingMessageDeltaFlush = (delayMs: number): void => {
        if (messageDeltaFlushTimer || delayMs <= 0) return;
        messageDeltaFlushTimer = setTimeout(() => {
          messageDeltaFlushTimer = undefined;
          flushMessageDelta();
        }, delayMs);
      };
      const mergePendingMessageDelta = (current: AgentMessageDeltaStream | undefined, incoming: AgentMessageDeltaStream): AgentMessageDeltaStream => {
        if (!current) return incoming;
        if (current.messageId !== incoming.messageId || current.type !== incoming.type) {
          flushMessageDelta();
          return incoming;
        }
        return {
          ...current,
          ...incoming,
          delta: `${current.delta ?? ''}${incoming.delta ?? ''}`,
          content: incoming.content !== undefined ? incoming.content : current.content,
          reasoning_content: incoming.reasoning_content !== undefined ? incoming.reasoning_content : current.reasoning_content,
          reasoning_parts: incoming.reasoning_parts !== undefined ? incoming.reasoning_parts : current.reasoning_parts,
          content_parts: incoming.content_parts !== undefined ? incoming.content_parts : current.content_parts,
          createdAt: current.createdAt ?? incoming.createdAt
        };
      };
      const emitMessageDelta = (payload: AgentMessageDeltaStream, force = false): void => {
        if (options.stream === false || typeof options.onMessageDelta !== 'function') return;
        pendingMessageDelta = mergePendingMessageDelta(pendingMessageDelta, payload);
        const now = Date.now();
        const delayMs = messageDeltaDelay(payload.type);
        if (!force && lastMessageDeltaEmittedAt > 0 && now - lastMessageDeltaEmittedAt < delayMs) {
          schedulePendingMessageDeltaFlush(delayMs - (now - lastMessageDeltaEmittedAt));
          return;
        }
        const next = pendingMessageDelta;
        pendingMessageDelta = undefined;
        sendMessageDelta(next);
      };
      const flushMessageDelta = (): void => {
        if (messageDeltaFlushTimer) {
          clearTimeout(messageDeltaFlushTimer);
          messageDeltaFlushTimer = undefined;
        }
        if (!pendingMessageDelta) return;
        const next = pendingMessageDelta;
        pendingMessageDelta = undefined;
        sendMessageDelta(next);
      };
      const currentReasoningPayload = (reasoning: string): { text: string; parts: string[] } => {
        const parts = joinReasoningParts(splitReasoningParts(reasoning));
        return { text: joinReasoning(parts), parts };
      };
      const validateSkillDelivery = async (candidateFinalResponse: string): Promise<SkillDeliveryValidation> => {
        const hardGate = await hardValidateDocumentDelivery(candidateFinalResponse, toolEvents, options.userInput, execution.workspaceDir);
        if (!hardGate.ok) return hardGate;
        const toolSummary = summarizeSkillDeliveryToolEvents(toolEvents);
        const deliveryContext = documentDeliveryContext(options.userInput, toolEvents);
        const validationPrompt = [
          'Validate the candidate final answer against only the task, loaded skill instructions/references, deterministic document gate context, and tool evidence below.',
          'Return JSON only with this shape: {"ok": boolean, "issues": string[], "required_actions": string[]}.',
          'Treat loaded skill instructions and references as the delivery contract for this task.',
          'For document-writing tasks, treat generated files, validation reports, unresolved placeholders, and explicit delivery status as delivery evidence.',
          'Mark ok=true only when the candidate satisfies the mandatory completion criteria declared by the relevant skill or by the document task itself.',
          'Mark ok=false when required source files, reference files, evidence-gathering, artifact validation, document artifact verification, or explicit degraded/blocker reporting is missing.',
          'If the candidate claims completion/final delivery but also reports unresolved items that the loaded skill treats as blockers, mark ok=false unless the candidate clearly downgrades the result to a draft, partial delivery, or blocker report.',
          'Do not apply domain rules that are not present in the loaded skill, user task, or tool evidence.',
          'Do not require unrelated optional skill steps.',
          '',
          `User task:\n${compactBlock(options.userInput, 3000)}`,
          '',
          `Candidate final answer:\n${compactBlock(candidateFinalResponse, 6000)}`,
          '',
          `Deterministic document delivery context:\n${stableStringify(deliveryContext)}`,
          '',
          `Relevant tool and skill evidence:\n${toolSummary || '(no relevant tool evidence recorded)'}`
        ].join('\n');
        const validation = await client.complete({
          messages: [
            {
              role: 'system',
              content: 'You are a strict delivery validator for a local agent harness. You do not solve the task; you only check whether the candidate can be safely presented as complete.'
            },
            { role: 'user', content: validationPrompt }
          ],
          temperature: 0,
          maxTokens: 1200,
          metadata: { ...requestMetadata, turn_type: 'skill_delivery_validation', context_compression: 'iteration' },
          signal: options.signal
        });
        return parseSkillDeliveryValidation(validation.message.content);
      };

      for (; iterations < cfg.maxIterations;) {
        iterations += 1;
        throwIfAborted(options.signal);
        const streamPersistId = createId('msg');
        const streamPersistCreatedAt = nowIso();
        lastStreamPersistedAt = 0;
        lastStreamPersistedLength = 0;
        let streamedContent = '';
        let streamedReasoning = '';
        const streamComplete = typeof client.streamComplete === 'function' ? client.streamComplete.bind(client) : undefined;
        const canStream = options.stream !== false && Boolean(streamComplete) && typeof options.onMessageDelta === 'function';
        if (canStream && iterations > 1) {
          emitMessageDelta({
            sessionId: session.id,
            messageId: visibleAssistantId,
            role: 'assistant',
            type: 'reasoning_content',
            delta: '',
            content: '',
            reasoning_content: '',
            reasoning_parts: [],
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: visibleAssistantCreatedAt
          }, true);
        }
        let completion: LlmCompletion;
        const iterationRequestMetadata: LlmRequestMetadata = {
          ...requestMetadata,
          context_compression: iterations === 1 ? 'turn_boundary' : 'iteration'
        };
        try {
          completion = canStream
            ? await streamComplete!({ messages, tools, temperature: cfg.temperature, metadata: iterationRequestMetadata, signal: options.signal }, (delta) => {
              if (delta.reasoning_content) {
                streamedReasoning += delta.reasoning_content;
                const reasoningLoop = detectRepeatedReasoningLoop([accumulatedReasoning, streamedReasoning].filter(Boolean).join('\n'));
                if (reasoningLoop) throw new ReasoningLoopAbort(repeatedReasoningDiagnostic(reasoningLoop));
                const overrunReason = reasoningOverrunReason(streamedReasoning, streamedContent);
                if (overrunReason) throw new ReasoningLoopAbort(reasoningOverrunDiagnostic(streamedReasoning, overrunReason));
                emitMessageDelta({
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'reasoning_content',
                  delta: delta.reasoning_content,
                  reasoningOmitted: streamedReasoning.length > REASONING_STREAM_PREVIEW_CHARS,
                  reasoningLength: streamedReasoning.length > REASONING_STREAM_PREVIEW_CHARS ? streamedReasoning.length : undefined,
                  contentOmitted: streamedContent.length > CONTENT_STREAM_PREVIEW_CHARS,
                  contentLength: streamedContent.length > CONTENT_STREAM_PREVIEW_CHARS ? streamedContent.length : undefined,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, streamedReasoning || undefined, false, visibleContentParts);
              }
              if (delta.content) {
                streamedContent += delta.content;
                emitMessageDelta({
                  sessionId: session.id,
                  messageId: visibleAssistantId,
                  role: 'assistant',
                  type: 'content',
                  delta: delta.content,
                  contentOmitted: streamedContent.length > CONTENT_STREAM_PREVIEW_CHARS,
                  contentLength: streamedContent.length > CONTENT_STREAM_PREVIEW_CHARS ? streamedContent.length : undefined,
                  reasoningOmitted: streamedReasoning.length > REASONING_STREAM_PREVIEW_CHARS,
                  reasoningLength: streamedReasoning.length > REASONING_STREAM_PREVIEW_CHARS ? streamedReasoning.length : undefined,
                  createdAt: visibleAssistantCreatedAt
                });
                persistStreamSnapshot(streamPersistId, streamPersistCreatedAt, streamedContent, streamedReasoning || undefined, false, visibleContentParts);
              }
            })
            : await client.complete({
              messages,
              tools,
              temperature: cfg.temperature,
              logProbs: options.logProbs,
              topLogProbs: options.topLogProbs,
              metadata: iterationRequestMetadata,
              signal: options.signal
            });
        } catch (error) {
          if (error instanceof ReasoningLoopAbort) {
            finalResponse = error.diagnostic;
            stopReason = 'reasoning-loop';
            const diagnosticMessage: AgentMessage = {
              id: streamPersistId,
              role: 'assistant',
              content: finalResponse,
              content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
              createdAt: streamPersistCreatedAt
            };
            messages.push(diagnosticMessage);
            persistMessages([diagnosticMessage]);
            const visibleReasoning = currentReasoningPayload(streamedReasoning);
            if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
            break;
          }
          if (!canStream || !isRecoverableLlmInterruption(error) || options.signal?.aborted) throw error;
          console.warn(`[agent] streaming LLM call interrupted; retrying once without streaming: ${error instanceof Error ? error.message : String(error)}`);
          streamedContent = '';
          streamedReasoning = '';
          flushMessageDelta();
          emitMessageDelta({
            sessionId: session.id,
            messageId: visibleAssistantId,
            role: 'assistant',
            type: 'reasoning_content',
            delta: '',
            content: '',
            reasoning_content: '',
            reasoning_parts: [],
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: visibleAssistantCreatedAt
          }, true);
          completion = await client.complete({
            messages,
            tools,
            temperature: cfg.temperature,
            logProbs: options.logProbs,
            topLogProbs: options.topLogProbs,
            metadata: iterationRequestMetadata,
            signal: options.signal
          });
        }
        const toolCalls = completion.message.tool_calls ?? [];
        const assistant = {
          ...completion.message,
          id: streamPersistId,
          createdAt: streamPersistCreatedAt
        };
        const currentReasoning = assistant.reasoning_content || streamedReasoning;
        const reasoningOverrun = currentReasoning.trim() ? reasoningOverrunReason(currentReasoning, assistant.content ?? streamedContent) : null;
        if (reasoningOverrun) {
          usage = completion.usage ?? usage;
          log_probs = completion.log_probs ?? log_probs;
          finalResponse = reasoningOverrunDiagnostic(currentReasoning, reasoningOverrun);
          stopReason = 'reasoning-loop';
          const diagnosticMessage: AgentMessage = {
            id: streamPersistId,
            role: 'assistant',
            content: finalResponse,
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: streamPersistCreatedAt
          };
          messages.push(diagnosticMessage);
          persistMessages([diagnosticMessage]);
          const visibleReasoning = currentReasoningPayload(currentReasoning);
          if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
          break;
        }
        const reasoningLoop = currentReasoning.trim()
          ? detectRepeatedReasoningLoop([accumulatedReasoning, currentReasoning].filter(Boolean).join('\n'))
          : null;
        if (reasoningLoop) {
          usage = completion.usage ?? usage;
          log_probs = completion.log_probs ?? log_probs;
          finalResponse = repeatedReasoningDiagnostic(reasoningLoop);
          stopReason = 'reasoning-loop';
          const diagnosticMessage: AgentMessage = {
            id: streamPersistId,
            role: 'assistant',
            content: finalResponse,
            content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
            createdAt: streamPersistCreatedAt
          };
          messages.push(diagnosticMessage);
          persistMessages([diagnosticMessage]);
          const visibleReasoning = currentReasoningPayload(currentReasoning);
          if (canStream) emitDoneDelta(finalResponse, visibleReasoning.text, visibleReasoning.parts, visibleContentParts);
          break;
        }
        if (currentReasoning.trim()) {
          const currentParts = splitReasoningParts(currentReasoning);
          latestIterationReasoningParts = currentParts;
          latestIterationReasoning = joinReasoning(currentParts);
          accumulatedReasoningParts.push(...currentParts);
          accumulatedReasoning = joinReasoning(accumulatedReasoningParts);
          assistant.reasoning_parts = currentParts.length > 0 ? currentParts : undefined;
          assistant.reasoning_content = latestIterationReasoning || currentReasoning;
        } else {
          latestIterationReasoning = '';
          latestIterationReasoningParts = [];
          delete assistant.reasoning_content;
          delete assistant.reasoning_parts;
        }
        usage = completion.usage ?? usage;
        log_probs = completion.log_probs ?? log_probs;
        messages.push(assistant);

        if (toolCalls.length === 0) {
          const assistantContent = assistant.content ?? '';
          const hasCurrentReasoning = currentReasoning.trim().length > 0;
          if (!assistantContent.trim() && hasCurrentReasoning && iterations < cfg.maxIterations && reasoningOnlyContinuationCount < REASONING_ONLY_CONTINUE_LIMIT) {
            reasoningOnlyContinuationCount += 1;
            persistMessages([{
              id: streamPersistId,
              role: 'assistant',
              hidden: true,
              content: '',
              reasoning_content: undefined,
              reasoning_parts: undefined,
              createdAt: streamPersistCreatedAt
            }]);
            continue;
          }
          finalResponse = assistantContent.trim() ? assistantContent : '';
          stopReason = finalResponse ? 'final' : 'empty';
          if (stopReason === 'empty') {
            finalResponse = emptyAssistantResponse();
            assistant.content = finalResponse;
          }
          assistant.content_parts = visibleContentParts.length > 0 ? [...visibleContentParts] : undefined;
          if (assistant.hidden !== true) {
            const artifacts = buildArtifactRefs(collectGeneratedArtifactPaths(toolEvents), execution.workspaceDir, 'terminal');
            assistant.artifacts = artifacts.length > 0 ? artifacts : undefined;
          }
          if (stopReason === 'final' && isDeliveryValidationNeeded(options.userInput, toolEvents)) {
            const validation = await validateSkillDelivery(finalResponse);
            if (!validation.ok) {
              if (skillDeliveryRepairCount >= SKILL_DELIVERY_VALIDATION_REPAIR_LIMIT) {
                finalResponse = validationFailureResponse(validation, SKILL_DELIVERY_VALIDATION_REPAIR_LIMIT);
                assistant.content = finalResponse;
                assistant.reasoning_content = undefined;
                assistant.reasoning_parts = undefined;
              } else {
                skillDeliveryRepairCount += 1;
                assistant.hidden = true;
                assistant.content = finalResponse;
                const validationMessage: AgentMessage = {
                  id: createId('msg'),
                  role: 'user',
                  hidden: true,
                  content: validationRepairPrompt(validation, skillDeliveryRepairCount, SKILL_DELIVERY_VALIDATION_REPAIR_LIMIT),
                  createdAt: nowIso()
                };
                messages.push(validationMessage);
                persistMessages([assistant, validationMessage]);
                finalResponse = '';
                stopReason = undefined;
                continue;
              }
            }
          }
          if (canStream) emitDoneDelta(finalResponse, assistant.reasoning_content, assistant.reasoning_parts, visibleContentParts);
          persistMessages([assistant]);
          break;
        }

        reasoningOnlyContinuationCount = 0;
        if (assistant.content?.trim()) {
          visibleContentParts.push(assistant.content.trim());
        }
        assistant.content_parts = visibleContentParts.length > 0 ? [...visibleContentParts] : undefined;
        persistMessages([sessionVisibleAssistantMessage(assistant, toolCalls.length)]);

        for (const call of toolCalls) {
          throwIfAborted(options.signal);
          const args = parseToolArgs(call.function.arguments);
          const result = await this.deps.toolRegistry.execute(call.function.name, args, {
            sessionId: session.id,
            workspaceDir: execution.workspaceDir,
            requestId: call.id,
            safetyApproval: this.deps.getConfig().safetyApproval,
            requestToolApproval: options.requestToolApproval
          });
          throwIfAborted(options.signal);
          const event: ToolEvent = {
            id: createId('toolevent'),
            toolName: call.function.name,
            args,
            ok: result.ok,
            content: result.content,
            approval: result.approval,
            createdAt: nowIso()
          };
          toolEvents.push(event);
          options.onToolEvent?.(session.id, event);
          const toolMessage: AgentMessage = {
            id: createId('msg'),
            role: 'tool',
            name: call.function.name,
            tool_call_id: call.id,
            content: result.content,
            createdAt: nowIso()
          };
          messages.push(toolMessage);
          persistMessages([toolMessage], [event]);

          const toolResultSignature = stableStringify({
            toolName: call.function.name,
            args,
            ok: result.ok,
            content: result.content
          });
          repeatedToolResultCount = toolResultSignature === lastToolResultSignature ? repeatedToolResultCount + 1 : 1;
          lastToolResultSignature = toolResultSignature;
          if (repeatedToolResultCount >= REPEATED_TOOL_RESULT_LIMIT) {
            finalResponse = repeatedToolDiagnostic(call.function.name, args, result.ok, result.content, REPEATED_TOOL_RESULT_LIMIT);
            stopReason = 'repeated-tool';
            const diagnosticMessage: AgentMessage = {
              id: createId('msg'),
              role: 'assistant',
              content: finalResponse,
              content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
              createdAt: nowIso()
            };
            messages.push(diagnosticMessage);
            persistMessages([diagnosticMessage]);
            if (canStream) emitDoneDelta(finalResponse, latestIterationReasoning, latestIterationReasoningParts, visibleContentParts);
            break;
          }
        }
        if (finalResponse) break;
      }

      if (!stopReason && iterations >= cfg.maxIterations) {
        stopReason = 'iteration-limit';
      }

      if (!finalResponse && stopReason === 'iteration-limit') {
        finalResponse = iterationLimitResponse(cfg.maxIterations, toolEvents);
        const limitMessage: AgentMessage = {
          id: createId('msg'),
          role: 'assistant',
          content: finalResponse,
          content_parts: visibleContentParts.length > 0 ? [...visibleContentParts] : undefined,
          createdAt: nowIso()
        };
        persistMessages([limitMessage]);
        emitDoneDelta(finalResponse, latestIterationReasoning, latestIterationReasoningParts, visibleContentParts);
      }

      if (memoryEnabled) {
        this.deps.commitDeferredMemory(session.id);
        this.deps.syncSessionMemory(updatedSession);
      }
      return {
        sessionId: session.id,
        finalResponse,
        messages: updatedSession.messages,
        toolEvents,
        usage,
        log_probs,
        iterations,
        execution
      };
    } catch (error) {
      if (memoryEnabled) this.deps.discardDeferredMemory(session.id);
      throw error;
    }
  }
}
