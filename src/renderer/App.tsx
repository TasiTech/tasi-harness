import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import type {
  AgentMessage,
  AppInfo,
  BrowserCoachRecordedEvent,
  BrowserCoachRecording,
  LlmUsage,
  MarketplaceBrowseResult,
  MarketplaceSkill,
  MemoryDomain,
  MemoryEntry,
  MemoryState,
  PersonalKnowledgeDocument,
  PersonalKnowledgeState,
  PublicAppConfig,
  ScheduledTask,
  SessionDocumentContext,
  SessionSummary,
  SkillDocument,
  SkillMetadata,
  ToolApprovalRequest,
  ToolEvent
} from '../shared/types.js';
import { EMBEDDED_BROWSER_PARTITION } from '../shared/browserConstants.js';
import {
  PROVIDER_PRESETS,
  providerDefaultBaseUrl,
  providerDefaultModel,
  providerModelOptions,
  providerPreset,
  providerRequiresApiKey
} from '../shared/providerCatalog.js';
import { extractCitationLinks, type CitationLink } from './citations.js';
import { normalizeMarkdownForRender, renderMarkdownToHtml } from './markdown.js';
import * as QRCode from 'qrcode';

type Page = 'chat' | 'knowledge' | 'memory' | 'skills' | 'tasks' | 'sessions' | 'settings' | 'about';
type UiLanguage = 'zh' | 'en';
type TranslateFn = (en: string, zh: string) => string;

const defaultConfig: PublicAppConfig = {
  provider: 'openai',
  baseUrl: providerDefaultBaseUrl('openai'),
  apiKeyConfigured: false,
  model: providerDefaultModel('openai'),
  temperature: 0.3,
  maxIterations: 100,
  sessionDocumentMaxDocs: 10,
  workspaceDir: '',
  allowShellTools: false,
  enableNetworkTools: false,
  safetyApproval: {
    enabled: true,
    approveRiskyTerminalCommands: true,
    timeoutMs: 60000,
    neverAskAgainKeys: []
  },
  browserMode: 'embedded',
  externalBrowserEngine: 'auto',
  externalBrowserCdpEndpoint: 'http://127.0.0.1:9222',
  externalBrowserProfileMode: 'isolated',
  browserHeadless: false,
  theme: 'dark',
  systemPersona: 'You are Tasi Harness, a desktop AI agent.',
  enabledToolNames: [],
  defaultExecutionMode: 'workspace',
  skillMarketSources: [],
  emailNotifications: {
    enabled: false,
    host: '',
    port: 465,
    secure: true,
    username: '',
    from: '',
    to: '',
    passwordConfigured: false
  },
  wechatChannel: {
    enabled: false,
    pluginName: 'clawbot',
    bindUrl: 'https://ilinkai.weixin.qq.com',
    loginStatus: 'idle'
  }
};
const WECHAT_PENDING_MARKER = '__TASI_WECHAT_PENDING__';

type SettingsDraft = PublicAppConfig & {
  apiKey?: string;
  emailNotifications: PublicAppConfig['emailNotifications'] & { password?: string };
};

function prettyDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function parseIsoMs(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function latestRoundToolEvents(messages: AgentMessage[], events: ToolEvent[]): ToolEvent[] {
  if (events.length === 0) return events;
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const cutoff = parseIsoMs(lastUser?.createdAt);
  if (cutoff == null) return events;
  const scoped = events.filter((event) => {
    const createdMs = parseIsoMs(event.createdAt);
    if (createdMs == null) return false;
    return createdMs >= cutoff;
  });
  return scoped;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function findFirstHttpUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'<>`)\]}]+/i);
  if (!match) return undefined;
  return match[0].replace(/[),.;!?]+$/, '');
}

function extractUrlFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (typeof value === 'string') return findFirstHttpUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractUrlFromValue(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const prioritizedKeys = ['url', 'href', 'link', 'pageUrl', 'page_url', 'targetUrl', 'target_url', 'website'];
  for (const key of prioritizedKeys) {
    if (!(key in record)) continue;
    const found = extractUrlFromValue(record[key], depth + 1);
    if (found) return found;
  }
  for (const [key, nested] of entries) {
    if (!/url|href|link|web|site|page/i.test(key)) continue;
    const found = extractUrlFromValue(nested, depth + 1);
    if (found) return found;
  }
  for (const [, nested] of entries) {
    const found = extractUrlFromValue(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function extractPreviewUrlMarker(text: string): string | undefined {
  const marker = text.match(/browser_preview_url:\s*(https?:\/\/[^\s"'<>`]+)/i);
  if (!marker?.[1]) return undefined;
  return marker[1].replace(/[),.;!?]+$/, '');
}

function previewSourceText(toolName: string, args: unknown, content: string): string {
  return `${toolName} ${safeJson(args)} ${content}`.toLowerCase();
}

function shouldFallbackOpenExternal(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (event.toolName.startsWith('browser_')) return false;
  if (combined.includes('browser_preview_url')) return true;
  return false;
}

function isWebPreviewEvent(event: ToolEvent): boolean {
  const combined = previewSourceText(event.toolName, event.args, event.content);
  if (event.toolName.startsWith('browser_')) return true;
  if (combined.includes('browser_preview_url')) return true;
  return event.toolName.toLowerCase().includes('open') && combined.includes('http');
}

function latestWebPreviewUrl(events: ToolEvent[], fallbackOnly = false): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isWebPreviewEvent(event)) continue;
    if (fallbackOnly && !shouldFallbackOpenExternal(event)) continue;
    const fromMarker = extractPreviewUrlMarker(event.content);
    if (fromMarker) return fromMarker;
    const fromArgs = extractUrlFromValue(event.args);
    if (fromArgs) return fromArgs;
    const fromContent = extractUrlFromValue(event.content);
    if (fromContent) return fromContent;
  }
  return undefined;
}

function useAsyncData<T>(loader: () => Promise<T>, fallback: T): [T, () => Promise<void>] {
  const [value, setValue] = useState<T>(fallback);
  const refresh = async () => setValue(await loader());
  useEffect(() => {
    void refresh();
  }, []);
  return [value, refresh];
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.split(',').at(1) ?? '';
      if (!data) reject(new Error('Failed to read file content.'));
      else resolve(data);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('Copy failed.');
}

function SidebarIcon(props: { kind: Page }): ReactElement {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };

  switch (props.kind) {
    case 'chat':
      return (
        <svg {...common}>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H10l-4.5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" />
        </svg>
      );
    case 'memory':
      return (
        <svg {...common}>
          <path d="M6.5 5.5h11v13h-11z" />
          <path d="M9 3.5v4" />
          <path d="M15 3.5v4" />
          <path d="M8.5 11h7" />
          <path d="M8.5 14.5h5" />
        </svg>
      );
    case 'knowledge':
      return (
        <svg {...common}>
          <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h10A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-10A2.5 2.5 0 0 1 5 17.5z" />
          <path d="M8.5 8.5h8" />
          <path d="M8.5 12h8" />
          <path d="M8.5 15.5h5" />
        </svg>
      );
    case 'skills':
      return (
        <svg {...common}>
          <path d="m14.5 4 5.5 5.5-8 8-5.5.5.5-5.5z" />
          <path d="m12.5 6 5.5 5.5" />
          <path d="M5 6h4" />
          <path d="M4 10h3" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="15" rx="2.5" />
          <path d="M8 3.5v3" />
          <path d="M16 3.5v3" />
          <path d="M4 9.5h16" />
          <path d="m9.5 14 1.5 1.5 3.5-3.5" />
        </svg>
      );
    case 'sessions':
      return (
        <svg {...common}>
          <path d="M12 5a7 7 0 1 0 7 7" />
          <path d="M12 8v4l2.5 2.5" />
          <path d="M17.5 4.5v4h-4" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12 3.5v3" />
          <path d="M12 17.5v3" />
          <path d="M4.6 7.6l2.1 2.1" />
          <path d="M17.3 14.3l2.1 2.1" />
          <path d="M3.5 12h3" />
          <path d="M17.5 12h3" />
          <path d="M4.6 16.4l2.1-2.1" />
          <path d="M17.3 9.7l2.1-2.1" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      );
    case 'about':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 10v5" />
          <path d="M12 7.5h.01" />
        </svg>
      );
  }
}

export function App(): ReactElement {
  const [page, setPage] = useState<Page>('chat');
  const [language, setLanguage] = useState<UiLanguage>(() => {
    const saved = globalThis.localStorage?.getItem('tasi_harness_ui_language');
    return saved === 'zh' ? 'zh' : 'en';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_sidebar_collapsed') === '1');
  const [config, setConfig] = useState<PublicAppConfig>(defaultConfig);
  const [sessions, refreshSessions] = useAsyncData<SessionSummary[]>(() => window.tasiHarness.sessions.list(), []);
  const [tasks, refreshTasks] = useAsyncData<ScheduledTask[]>(() => window.tasiHarness.tasks.list(), []);
  const [memory, refreshMemory] = useAsyncData<MemoryState>(() => window.tasiHarness.memory.get(), { entries: [], usage: [], domains: [], rendered: '' });
  const [knowledge, refreshKnowledge] = useAsyncData<PersonalKnowledgeState>(() => window.tasiHarness.knowledge.list(), {
    docs: [],
    totalDocs: 0,
    totalChunks: 0,
    totalChars: 0
  });
  const [skills, refreshSkills] = useAsyncData<SkillMetadata[]>(() => window.tasiHarness.skills.list(), []);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [lastUsage, setLastUsage] = useState<LlmUsage | undefined>();
  const [totalUsage, setTotalUsage] = useState<LlmUsage | undefined>();
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStopping, setChatStopping] = useState(false);
  const [executionMode, setExecutionMode] = useState<'workspace' | 'sandbox'>('workspace');
  const activeWechatSessionId = config.wechatChannel.sessionId?.trim() || '';
  const isWechatSessionActive = Boolean(sessionId && activeWechatSessionId && sessionId === activeWechatSessionId);
  const tr: TranslateFn = useMemo(() => (en: string, zh: string) => (language === 'zh' ? zh : en), [language]);

  function formatTokensM(value?: number): string {
    const tokens = Number(value ?? 0);
    if (!Number.isFinite(tokens)) return '0.000M';
    return `${(tokens / 1_000_000).toFixed(3)}M`;
  }

  function usageLabel(usage?: LlmUsage): string {
    if (!usage) return '-';
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const total = usage.totalTokens ?? prompt + completion;
    return `P:${formatTokensM(prompt)} C:${formatTokensM(completion)} T:${formatTokensM(total)}`;
  }
  const nav = useMemo<Array<{ page: Page; icon: ReactElement; label: string }>>(
    () => [
      { page: 'chat', icon: <SidebarIcon kind="chat" />, label: tr('Chat', '对话') },
      { page: 'memory', icon: <SidebarIcon kind="memory" />, label: tr('Memory', '记忆') },
      { page: 'skills', icon: <SidebarIcon kind="skills" />, label: tr('Skills', '技能') },
      { page: 'tasks', icon: <SidebarIcon kind="tasks" />, label: tr('Tasks', '任务') },
      { page: 'sessions', icon: <SidebarIcon kind="sessions" />, label: tr('History', '历史') },
      { page: 'settings', icon: <SidebarIcon kind="settings" />, label: tr('Settings', '设置') },
      { page: 'about', icon: <SidebarIcon kind="about" />, label: tr('About', '关于') }
    ],
    [tr]
  );
  const sidebarNav = useMemo<Array<{ page: Page; icon: ReactElement; label: string }>>(() => {
    if (nav.some((item) => item.page === 'knowledge')) return nav;
    return [
      nav[0] ?? { page: 'chat', icon: <SidebarIcon kind="chat" />, label: tr('Chat', '对话') },
      { page: 'knowledge', icon: <SidebarIcon kind="knowledge" />, label: tr('Knowledge', '知识库') },
      ...nav.slice(1)
    ];
  }, [nav, tr]);

  useEffect(() => {
    void window.tasiHarness.config.get().then((cfg) => {
      setConfig(cfg);
      setExecutionMode(cfg.defaultExecutionMode);
      document.documentElement.setAttribute('data-theme', cfg.theme || 'dark');
    });
    void window.tasiHarness.app.info().then(setInfo);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'dark');
  }, [config.theme]);

  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_ui_language', language);
    document.documentElement.setAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
  }, [language]);
  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refreshTasks]);

  useEffect(() => {
    const off = window.tasiHarness.sessions.onUpdated((payload) => {
      if (!sessionId || payload.sessionId !== sessionId) return;
      void window.tasiHarness.sessions.read(payload.sessionId).then((record) => {
        if (!record) return;
        setMessages(record.messages);
        setLastUsage(record.lastUsage);
        setTotalUsage(record.totalUsage);
        const events = record.toolEvents ?? [];
        if (isWechatSessionActive && payload.source === 'external') {
          setToolEvents(latestRoundToolEvents(record.messages, events));
        } else {
          setToolEvents(events);
        }
        setExecutionMode(record.lastExecution?.mode ?? config.defaultExecutionMode);
      });
    });
    return off;
  }, [sessionId, config.defaultExecutionMode, isWechatSessionActive]);

  useEffect(() => {
    const off = window.tasiHarness.security.onToolApprovalRequest((request) => {
      setApprovalRequest(request);
    });
    return off;
  }, []);

  async function resolveApproval(request: ToolApprovalRequest, approved: boolean, neverAskAgain = false): Promise<void> {
    setApprovalRequest((current) => (current?.id === request.id ? null : current));
    await window.tasiHarness.security.resolveToolApproval({ id: request.id, approved, neverAskAgain });
    if (approved && neverAskAgain) {
      const next = await window.tasiHarness.config.get();
      setConfig(next);
    }
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">TH</div>
          <div className="logo-copy">
            <div className="logo-head">
              <div className="logo-text">Tasi Harness</div>
              <button className="lang-toggle" onClick={() => setLanguage((current) => (current === 'zh' ? 'en' : 'zh'))}>
                {language === 'zh' ? 'EN' : '中文'}
              </button>
            </div>
            <div className="logo-sub">{tr('Desktop Agent', '桌面智能体')}</div>
          </div>
        </div>
        <div className="nav-section">
          <div className="nav-toolbar">
            <button
              className="sidebar-collapse-button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? tr('Expand workspace sidebar', '展开工作区侧栏') : tr('Collapse workspace sidebar', '收起工作区侧栏')}
              aria-label={sidebarCollapsed ? tr('Expand workspace sidebar', '展开工作区侧栏') : tr('Collapse workspace sidebar', '收起工作区侧栏')}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
          </div>
          {sidebarNav.map((item) => (
            <button key={item.page} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => setPage(item.page)}>
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="meta-row wrap">
            <span className="soft-badge">{tr('Last', '本次')}: {usageLabel(lastUsage)}</span>
            <span className="soft-badge">{tr('Total', '累计')}: {usageLabel(totalUsage)}</span>
          </div>
          <div className={`status-pill ${config.apiKeyConfigured || !providerRequiresApiKey(config.provider) ? 'ok' : 'warn'}`}>
            <span className="dot" /> {config.apiKeyConfigured || !providerRequiresApiKey(config.provider)
              ? `${tr('Model ready', '模型已就绪')} · ${config.model || tr('No model', '未配置模型')}`
              : tr('Configure model', '请配置模型')}
          </div>
        </div>
      </aside>
      <main className="main-pane">
        {page === 'chat' && (
          <ChatPage
            tr={tr}
            config={config}
            setConfig={setConfig}
            messages={messages}
            setMessages={setMessages}
            sessionId={sessionId}
            setSessionId={setSessionId}
            lastUsage={lastUsage}
            setLastUsage={setLastUsage}
            totalUsage={totalUsage}
            setTotalUsage={setTotalUsage}
            toolEvents={toolEvents}
            setToolEvents={setToolEvents}
            busy={chatBusy}
            setBusy={setChatBusy}
            stopping={chatStopping}
            setStopping={setChatStopping}
            executionMode={executionMode}
            setExecutionMode={setExecutionMode}
            refreshSessions={refreshSessions}
            personalKnowledgeDocCount={knowledge.totalDocs}
          />
        )}
        {page === 'knowledge' && <KnowledgePage tr={tr} knowledge={knowledge} refreshKnowledge={refreshKnowledge} />}
        {page === 'memory' && <MemoryPage tr={tr} memory={memory} sessionId={sessionId} />}
        {page === 'skills' && <SkillsPage tr={tr} skills={skills} refreshSkills={refreshSkills} />}
        {page === 'tasks' && <TasksPage tr={tr} tasks={tasks} refreshTasks={refreshTasks} refreshSessions={refreshSessions} />}
        {page === 'sessions' && (
          <SessionsPage
            tr={tr}
            sessions={sessions}
            onOpen={async (id) => {
              const record = await window.tasiHarness.sessions.read(id);
              if (record) {
                setSessionId(record.id);
                setMessages(record.messages);
                setLastUsage(record.lastUsage);
                setTotalUsage(record.totalUsage);
                const isWechat = Boolean(config.wechatChannel.sessionId?.trim() && record.id === config.wechatChannel.sessionId?.trim());
                const events = record.toolEvents ?? [];
                setToolEvents(isWechat ? latestRoundToolEvents(record.messages, events) : events);
                setExecutionMode(record.lastExecution?.mode ?? config.defaultExecutionMode);
                setPage('chat');
              }
            }}
            refreshSessions={refreshSessions}
          />
        )}
        {page === 'settings' && <SettingsPage tr={tr} config={config} setConfig={setConfig} />}
        {page === 'about' && <AboutPage tr={tr} info={info} />}
      </main>
      {approvalRequest && (
        <ToolApprovalModal
          tr={tr}
          request={approvalRequest}
          onApprove={() => void resolveApproval(approvalRequest, true)}
          onApproveNever={() => void resolveApproval(approvalRequest, true, true)}
          onDeny={() => void resolveApproval(approvalRequest, false)}
        />
      )}
    </div>
  );
}

function ToolApprovalModal(props: { tr: TranslateFn; request: ToolApprovalRequest; onApprove: () => void; onApproveNever: () => void; onDeny: () => void }): ReactElement {
  const [remainingMs, setRemainingMs] = useState(props.request.timeoutMs);
  useEffect(() => {
    setRemainingMs(props.request.timeoutMs);
    const started = Date.now();
    const timer = window.setInterval(() => {
      const next = Math.max(0, props.request.timeoutMs - (Date.now() - started));
      setRemainingMs(next);
      if (next <= 0) {
        window.clearInterval(timer);
        props.onDeny();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [props.request]);
  const riskLabel = props.request.risk === 'workspace-delete'
    ? props.tr('Workspace delete', '工作区删除')
    : props.request.risk === 'outside-read'
      ? props.tr('Outside read', '工作区外读取')
      : props.request.risk === 'outside-write'
        ? props.tr('Outside write', '工作区外写入')
        : props.request.risk === 'outside-delete'
          ? props.tr('Outside delete', '工作区外删除')
          : props.tr('Risky command', '风险命令');
  return (
    <div className="modal-backdrop approval-backdrop" onClick={props.onDeny}>
      <div className="modal-card approval-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{props.tr('Approval Required', '需要审批')}</h2>
            <div className="card-subtle">{props.tr('Review this action before Tasi Harness continues.', '请在继续前确认此操作。')}</div>
          </div>
          <span className="soft-badge">{riskLabel}</span>
        </div>
        <div className="approval-summary">{props.request.summary}</div>
        <div className="meta-row wrap">
          <span className="soft-badge">{props.tr('Tool', '工具')} {props.request.toolName}</span>
          <span className="soft-badge">{props.tr('Timeout', '超时')} {Math.ceil(remainingMs / 1000)}s</span>
        </div>
        <pre className="code-block small approval-args">{JSON.stringify(props.request.args, null, 2)}</pre>
        <div className="button-row modal-actions">
          <button className="ghost-button" onClick={props.onDeny}>{props.tr('Deny', '拒绝')}</button>
          <button className="ghost-button" onClick={props.onApproveNever}>{props.tr('Allow and do not ask again', '允许且不再需要审批')}</button>
          <button className="primary-button" onClick={props.onApprove}>{props.tr('Allow once', '允许一次')}</button>
        </div>
      </div>
    </div>
  );
}

function PageHeader(props: { title: string; subtitle: string; action?: ReactElement }): ReactElement {
  return (
    <div className="page-header">
      <div>
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </div>
      {props.action}
    </div>
  );
}

interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  getURL?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  loadURL?: (url: string) => Promise<void> | void;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  setZoomFactor?: (factor: number) => void;
  setZoomLevel?: (level: number) => void;
}

const PREVIEW_MIN_ZOOM_FACTOR = 0.08;
const PREVIEW_ZOOM_LEVEL_BASE = 1.2;

function normalizePreviewUrlInput(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function clampPreviewRect(rect: PreviewRect, containerWidth: number, containerHeight: number): PreviewRect {
  const minWidth = 360;
  const minHeight = 220;
  const maxWidth = Math.max(minWidth, containerWidth - 12);
  const maxHeight = Math.max(minHeight, containerHeight - 12);
  const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, minHeight), maxHeight);
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, containerWidth - width));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, containerHeight - height));
  return { x, y, width, height };
}

function buildDefaultPreviewRect(containerWidth: number, containerHeight: number): PreviewRect {
  const targetWidth = Math.round(containerWidth * 0.98);
  const targetHeight = Math.round(containerHeight * 0.94);
  const rect = clampPreviewRect(
    {
      x: Math.round((containerWidth - targetWidth) / 2),
      y: Math.round((containerHeight - targetHeight) / 2),
      width: targetWidth,
      height: targetHeight
    },
    containerWidth,
    containerHeight
  );
  return rect;
}

function ChatPage(props: {
  tr: TranslateFn;
  config: PublicAppConfig;
  setConfig: (cfg: PublicAppConfig) => void;
  messages: AgentMessage[];
  setMessages: (messages: AgentMessage[]) => void;
  sessionId?: string;
  setSessionId: (id?: string) => void;
  lastUsage?: LlmUsage;
  setLastUsage: (usage?: LlmUsage) => void;
  totalUsage?: LlmUsage;
  setTotalUsage: (usage?: LlmUsage) => void;
  toolEvents: ToolEvent[];
  setToolEvents: Dispatch<SetStateAction<ToolEvent[]>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  stopping: boolean;
  setStopping: Dispatch<SetStateAction<boolean>>;
  executionMode: 'workspace' | 'sandbox';
  setExecutionMode: (mode: 'workspace' | 'sandbox') => void;
  refreshSessions: () => Promise<void>;
  personalKnowledgeDocCount: number;
}): ReactElement {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>([]);
  const [sessionDocs, setSessionDocs] = useState<SessionDocumentContext[]>([]);
  const [sessionDocBusy, setSessionDocBusy] = useState(false);
  const [sessionDocError, setSessionDocError] = useState('');
  const [usePersonalKnowledgeBase, setUsePersonalKnowledgeBase] = useState<boolean>(() => globalThis.localStorage?.getItem('tasi_harness_use_personal_kb') === '1');
  const [toolPanelTab, setToolPanelTab] = useState<'tools' | 'sources'>('tools');
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false);
  const [webPreviewExpanded, setWebPreviewExpanded] = useState(false);
  const [webPreviewRect, setWebPreviewRect] = useState<PreviewRect | null>(null);
  const [previewAddress, setPreviewAddress] = useState('');
  const [previewCanGoBack, setPreviewCanGoBack] = useState(false);
  const [previewCanGoForward, setPreviewCanGoForward] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const chatContentGridRef = useRef<HTMLDivElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const previewWebviewRef = useRef<PreviewWebviewElement | null>(null);
  const uploadSessionDocInputRef = useRef<HTMLInputElement | null>(null);
  const previewZoomFactorRef = useRef(1);
  const previewZoomSyncIdRef = useRef(0);
  const previewContentMetricsRef = useRef<{ contentWidth: number; contentHeight: number } | null>(null);
  const previewMeasuredViewportRef = useRef<{ width: number; height: number } | null>(null);
  const previewNeedsMeasurementRef = useRef(true);
  const externalPreviewOpenUrlRef = useRef('');
  const dragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    originRect: PreviewRect;
    containerWidth: number;
    containerHeight: number;
  } | null>(null);
  const visibleMessages = useMemo(
    () => props.messages.filter((m) => {
      if (m.role === 'assistant' && m.content === WECHAT_PENDING_MARKER) return false;
      return m.role === 'user' || (m.role === 'assistant' && Boolean(m.content?.trim()));
    }),
    [props.messages]
  );
  const previewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents), [props.toolEvents]);
  const externalFallbackPreviewUrl = useMemo(() => latestWebPreviewUrl(props.toolEvents, true), [props.toolEvents]);
  const latestAssistantContent = useMemo(() => {
    const latest = [...visibleMessages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    return latest?.content ?? '';
  }, [visibleMessages]);
  const referencedPages = useMemo(() => extractCitationLinks(latestAssistantContent), [latestAssistantContent]);
  const showEmbeddedWebPreview = props.config.browserMode === 'embedded';
  const shouldShowWebPreview = showEmbeddedWebPreview && Boolean(previewUrl);
  const personalKnowledgeEnabled = usePersonalKnowledgeBase && props.personalKnowledgeDocCount > 0;
  const isWechatSession = Boolean(
    props.sessionId
      && props.config.wechatChannel.sessionId
      && props.sessionId === props.config.wechatChannel.sessionId
  );
  const wechatBusy = isWechatSession && props.messages.some((message) => message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER);
  const runBusy = props.busy || wechatBusy;
  useEffect(() => {
    globalThis.localStorage?.setItem('tasi_harness_use_personal_kb', usePersonalKnowledgeBase ? '1' : '0');
  }, [usePersonalKnowledgeBase]);
  useEffect(() => {
    if (props.personalKnowledgeDocCount > 0 || !usePersonalKnowledgeBase) return;
    setUsePersonalKnowledgeBase(false);
  }, [props.personalKnowledgeDocCount, usePersonalKnowledgeBase]);
  useEffect(() => {
    let cancelled = false;
    if (!props.sessionId) {
      setSessionDocs([]);
      setSessionDocError('');
      return () => {
        cancelled = true;
      };
    }
    void window.tasiHarness.sessionDocs.list(props.sessionId)
      .then((docs) => {
        if (cancelled) return;
        setSessionDocs(docs);
        setSessionDocError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setSessionDocError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [props.sessionId]);
  useEffect(() => {
    if (!shouldShowWebPreview) {
      setWebPreviewExpanded(false);
      setWebPreviewRect(null);
      setPreviewAddress('');
      setPreviewCanGoBack(false);
      setPreviewCanGoForward(false);
      setPreviewLoading(false);
      previewZoomFactorRef.current = 1;
      previewZoomSyncIdRef.current += 1;
      previewContentMetricsRef.current = null;
      previewMeasuredViewportRef.current = null;
      previewNeedsMeasurementRef.current = true;
    }
  }, [shouldShowWebPreview]);
  useEffect(() => {
    if (!previewUrl) return;
    setPreviewAddress(previewUrl);
  }, [previewUrl]);
  useEffect(() => {
    if (showEmbeddedWebPreview || !externalFallbackPreviewUrl || !props.busy) {
      externalPreviewOpenUrlRef.current = '';
      return;
    }
    if (externalPreviewOpenUrlRef.current === externalFallbackPreviewUrl) return;
    externalPreviewOpenUrlRef.current = externalFallbackPreviewUrl;
    void window.tasiHarness.app.openExternalUrl(externalFallbackPreviewUrl).then((result) => {
      if (!result.ok && /failed to open/i.test(result.content)) {
        setError(result.content);
      }
    }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [showEmbeddedWebPreview, externalFallbackPreviewUrl, props.busy]);
  useEffect(() => {
    if (!shouldShowWebPreview) return;
    previewContentMetricsRef.current = null;
    previewMeasuredViewportRef.current = null;
    previewNeedsMeasurementRef.current = true;
    previewZoomSyncIdRef.current += 1;
    setPreviewZoomFactor(1, true);
  }, [previewUrl, shouldShowWebPreview]);
  useEffect(() => {
    if (!webPreviewExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWebPreviewExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [webPreviewExpanded]);
  useEffect(() => {
    if (!webPreviewExpanded) return;
    const syncWithinBounds = () => {
      const container = chatContentGridRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      setWebPreviewRect((old) => clampPreviewRect(old ?? buildDefaultPreviewRect(bounds.width, bounds.height), bounds.width, bounds.height));
    };
    syncWithinBounds();
    window.addEventListener('resize', syncWithinBounds);
    return () => window.removeEventListener('resize', syncWithinBounds);
  }, [webPreviewExpanded]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [visibleMessages, props.toolEvents, runBusy]);
  useEffect(() => {
    const off = window.tasiHarness.agent.onToolEvent((payload) => {
      if (props.sessionId && payload.sessionId !== props.sessionId) return;
      props.setToolEvents((old) => [...old, payload.event]);
    });
    return off;
  }, [props.sessionId, props.setToolEvents]);
  useEffect(() => {
    if (!showEmbeddedWebPreview) {
      void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(null);
      return;
    }
    const webview = previewWebviewRef.current;
    if (!webview) return;
    const syncBinding = () => {
      try {
        const id = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return;
        void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(id);
      } catch {
        // Ignore transient webview readiness errors.
      }
    };
    webview.addEventListener('dom-ready', syncBinding as EventListener);
    syncBinding();
    return () => {
      webview.removeEventListener('dom-ready', syncBinding as EventListener);
      void window.tasiHarness.app.setEmbeddedPreviewWebContentsId(null);
    };
  }, [showEmbeddedWebPreview]);
  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    if (!webview) return;

    let rafId = 0;
    let disposed = false;
    const syncNavigationState = () => {
      if (disposed) return;
      try {
        const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
        if (currentUrl) setPreviewAddress(currentUrl);
        setPreviewCanGoBack(typeof webview.canGoBack === 'function' ? webview.canGoBack() : false);
        setPreviewCanGoForward(typeof webview.canGoForward === 'function' ? webview.canGoForward() : false);
      } catch {
        // Ignore transient navigation-state read failures.
      }
    };
    const scheduleNavigationStateSync = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncNavigationState);
    };

    const onStartLoading = () => setPreviewLoading(true);
    const onStopLoading = () => {
      setPreviewLoading(false);
      scheduleNavigationStateSync();
    };

    webview.addEventListener('dom-ready', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-navigate', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-navigate-in-page', scheduleNavigationStateSync as EventListener);
    webview.addEventListener('did-start-loading', onStartLoading as EventListener);
    webview.addEventListener('did-stop-loading', onStopLoading as EventListener);
    scheduleNavigationStateSync();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      webview.removeEventListener('dom-ready', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-navigate', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-navigate-in-page', scheduleNavigationStateSync as EventListener);
      webview.removeEventListener('did-start-loading', onStartLoading as EventListener);
      webview.removeEventListener('did-stop-loading', onStopLoading as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl]);

  function syncPreviewWebviewHostSize(): void {
    const webview = previewWebviewRef.current;
    const body = previewBodyRef.current;
    if (!webview || !body) return;

    try {
      const width = Math.max(1, Math.round(body.clientWidth));
      const height = Math.max(1, Math.round(body.clientHeight));
      if (width < 2 || height < 2) return;

      const nextWidth = `${width}px`;
      const nextHeight = `${height}px`;
      if (webview.style.display !== 'flex') webview.style.display = 'flex';
      if (webview.style.width !== nextWidth) webview.style.width = nextWidth;
      if (webview.style.height !== nextHeight) webview.style.height = nextHeight;
      if (webview.style.minWidth !== '0px') webview.style.minWidth = '0px';
      if (webview.style.minHeight !== '0px') webview.style.minHeight = '0px';
    } catch {
      // Ignore transient host sizing failures while layout is changing.
    }
  }

  function zoomLevelFromFactor(factor: number): number {
    if (!Number.isFinite(factor) || factor <= 0) return 0;
    return Math.log(factor) / Math.log(PREVIEW_ZOOM_LEVEL_BASE);
  }

  function setPreviewZoomFactor(factor: number, force = false): void {
    const webview = previewWebviewRef.current;
    if (!webview) return;
    const nextFactor = Math.min(1, Math.max(PREVIEW_MIN_ZOOM_FACTOR, factor));
    if (!force && Math.abs(previewZoomFactorRef.current - nextFactor) < 0.005) return;
    previewZoomFactorRef.current = nextFactor;
    try {
      webview.setZoomFactor?.(nextFactor);
      webview.setZoomLevel?.(zoomLevelFromFactor(nextFactor));
    } catch {
      // Ignore transient zoom update failures while page is changing.
    }
  }

  function applyPreviewContentZoom(force = false): void {
    const body = previewBodyRef.current;
    const metrics = previewContentMetricsRef.current;
    if (!body || !metrics) return;

    const viewportWidth = Math.max(1, Math.round(body.clientWidth));
    const viewportHeight = Math.max(1, Math.round(body.clientHeight));
    if (viewportWidth < 2 || viewportHeight < 2) return;

    const widthFactor = viewportWidth / Math.max(metrics.contentWidth, 1);
    const heightFactor = viewportHeight / Math.max(metrics.contentHeight, 1);
    setPreviewZoomFactor(Math.min(1, widthFactor, heightFactor), force);
  }

  function currentPreviewViewport(): { width: number; height: number } | null {
    const body = previewBodyRef.current;
    if (!body) return null;
    const width = Math.max(1, Math.round(body.clientWidth));
    const height = Math.max(1, Math.round(body.clientHeight));
    if (width < 2 || height < 2) return null;
    return { width, height };
  }

  function shouldRemeasurePreviewMetrics(): boolean {
    const viewport = currentPreviewViewport();
    if (!viewport) return false;
    if (!previewContentMetricsRef.current) return true;
    const measured = previewMeasuredViewportRef.current;
    if (!measured) return true;
    const widthRatio = viewport.width / Math.max(1, measured.width);
    const heightRatio = viewport.height / Math.max(1, measured.height);
    return (
      Math.abs(viewport.width - measured.width) >= 72 ||
      Math.abs(viewport.height - measured.height) >= 72 ||
      Math.abs(widthRatio - 1) >= 0.12 ||
      Math.abs(heightRatio - 1) >= 0.12
    );
  }

  async function readPreviewContentMetrics(syncId: number): Promise<{ contentWidth: number; contentHeight: number } | null> {
    const webview = previewWebviewRef.current;
    if (!webview) return null;

    try {
      const result = await webview.executeJavaScript?.(
        `new Promise((resolve) => {
          const collect = () => {
            const doc = document.documentElement;
            const body = document.body;
            const contentWidth = Math.max(
              doc ? doc.scrollWidth : 0,
              doc ? doc.offsetWidth : 0,
              doc ? doc.clientWidth : 0,
              body ? body.scrollWidth : 0,
              body ? body.offsetWidth : 0,
              body ? body.clientWidth : 0,
              window.innerWidth || 0
            );
            const contentHeight = Math.max(
              doc ? doc.scrollHeight : 0,
              doc ? doc.offsetHeight : 0,
              doc ? doc.clientHeight : 0,
              body ? body.scrollHeight : 0,
              body ? body.offsetHeight : 0,
              body ? body.clientHeight : 0,
              window.innerHeight || 0
            );
            resolve({ contentWidth, contentHeight });
          };
          requestAnimationFrame(() => requestAnimationFrame(collect));
        })`,
        true
      );
      if (syncId !== previewZoomSyncIdRef.current) return null;
      const metrics = result as { contentWidth?: unknown; contentHeight?: unknown } | undefined;
      const contentWidth = typeof metrics?.contentWidth === 'number' && Number.isFinite(metrics.contentWidth) ? metrics.contentWidth : 0;
      const contentHeight = typeof metrics?.contentHeight === 'number' && Number.isFinite(metrics.contentHeight) ? metrics.contentHeight : 0;
      return { contentWidth, contentHeight };
    } catch {
      return null;
    }
  }

  async function refreshPreviewNaturalMetrics(force = false): Promise<void> {
    if (!force && !previewNeedsMeasurementRef.current && !shouldRemeasurePreviewMetrics()) {
      applyPreviewContentZoom();
      return;
    }

    const syncId = previewZoomSyncIdRef.current + 1;
    previewZoomSyncIdRef.current = syncId;
    const metrics = await readPreviewContentMetrics(syncId);
    if (syncId !== previewZoomSyncIdRef.current || !metrics) return;
    if (metrics.contentWidth < 1 || metrics.contentHeight < 1) return;

    previewContentMetricsRef.current = metrics;
    previewMeasuredViewportRef.current = currentPreviewViewport();
    previewNeedsMeasurementRef.current = false;
    applyPreviewContentZoom(true);
  }

  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    const body = previewBodyRef.current;
    if (!webview || !body) return;
    let disposed = false;
    let rafId = 0;
    let measurementTimeoutId = 0;

    const syncHostSize = () => {
      if (disposed) return;
      syncPreviewWebviewHostSize();
    };

    const scheduleNaturalMeasurement = (delay = webPreviewExpanded ? 90 : 140) => {
      if (disposed) return;
      if (!shouldRemeasurePreviewMetrics()) return;
      previewNeedsMeasurementRef.current = true;
      if (measurementTimeoutId) window.clearTimeout(measurementTimeoutId);
      measurementTimeoutId = window.setTimeout(() => {
        measurementTimeoutId = 0;
        if (disposed) return;
        void refreshPreviewNaturalMetrics(true);
      }, delay);
    };

    const schedulePreviewSync = () => {
      if (disposed) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncHostSize();
        applyPreviewContentZoom();
        scheduleNaturalMeasurement();
      });
    };

    webview.addEventListener('dom-ready', schedulePreviewSync as EventListener);
    webview.addEventListener('did-stop-loading', schedulePreviewSync as EventListener);
    webview.addEventListener('did-navigate', schedulePreviewSync as EventListener);
    webview.addEventListener('did-navigate-in-page', schedulePreviewSync as EventListener);
    const resizeObserver = new ResizeObserver(() => schedulePreviewSync());
    resizeObserver.observe(body);
    schedulePreviewSync();
    const syncTimeouts = [80, 220].map((delay) => window.setTimeout(schedulePreviewSync, delay));

    return () => {
      disposed = true;
      for (const timeoutId of syncTimeouts) window.clearTimeout(timeoutId);
      if (measurementTimeoutId) window.clearTimeout(measurementTimeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      webview.removeEventListener('dom-ready', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-stop-loading', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-navigate', schedulePreviewSync as EventListener);
      webview.removeEventListener('did-navigate-in-page', schedulePreviewSync as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl, webPreviewExpanded, webPreviewRect?.width, webPreviewRect?.height]);

  useEffect(() => {
    if (!shouldShowWebPreview) return;
    const webview = previewWebviewRef.current;
    if (!webview) return;

    let disposed = false;
    let rafId = 0;
    const measurementTimeouts: number[] = [];

    const clearPreviewMeasurement = () => {
      previewContentMetricsRef.current = null;
      previewMeasuredViewportRef.current = null;
      previewNeedsMeasurementRef.current = true;
      previewZoomSyncIdRef.current += 1;
      setPreviewZoomFactor(1, true);
    };

    const scheduleMeasurement = (delay = 0) => {
      const run = () => {
        if (disposed) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          void refreshPreviewNaturalMetrics();
        });
      };
      if (delay <= 0) {
        run();
        return;
      }
      measurementTimeouts.push(window.setTimeout(run, delay));
    };

    const onStartLoading = () => clearPreviewMeasurement();
    const onReadyToMeasure = () => {
      if (!previewNeedsMeasurementRef.current) return;
      scheduleMeasurement();
      scheduleMeasurement(120);
      scheduleMeasurement(320);
    };

    webview.addEventListener('did-start-loading', onStartLoading as EventListener);
    webview.addEventListener('dom-ready', onReadyToMeasure as EventListener);
    webview.addEventListener('did-stop-loading', onReadyToMeasure as EventListener);
    webview.addEventListener('did-navigate', onReadyToMeasure as EventListener);
    webview.addEventListener('did-navigate-in-page', onReadyToMeasure as EventListener);
    onReadyToMeasure();

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      for (const timeoutId of measurementTimeouts) window.clearTimeout(timeoutId);
      webview.removeEventListener('did-start-loading', onStartLoading as EventListener);
      webview.removeEventListener('dom-ready', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-stop-loading', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-navigate', onReadyToMeasure as EventListener);
      webview.removeEventListener('did-navigate-in-page', onReadyToMeasure as EventListener);
    };
  }, [shouldShowWebPreview, previewUrl]);

  const connected = props.config.apiKeyConfigured || !providerRequiresApiKey(props.config.provider);

  function isStoppedByUserError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error.name === 'AbortError') return true;
    return /session stopped by user|operation was aborted|aborted/i.test(error.message);
  }

  async function setBridgeMode(mode: PublicAppConfig['browserMode']): Promise<void> {
    if (mode === props.config.browserMode) return;
    try {
      setError('');
      const next = await window.tasiHarness.config.set({ browserMode: mode });
      props.setConfig(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitMessage(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || props.busy) return;
    setInput('');
    setError('');
    props.setBusy(true);
    props.setStopping(false);
    setFollowUpQuestions([]);
    props.setToolEvents([]);
    props.setMessages([...props.messages, { role: 'user', content: text, createdAt: new Date().toISOString() }]);
    try {
      const result = await window.tasiHarness.agent.chat(text, props.sessionId, props.executionMode, personalKnowledgeEnabled);
      props.setSessionId(result.sessionId);
      props.setMessages(result.messages.filter((m) => m.role !== 'system'));
      props.setLastUsage(result.usage);
      props.setTotalUsage(result.totalUsage);
      props.setToolEvents(result.toolEvents);
      props.setExecutionMode(result.execution.mode);
      setFollowUpQuestions((result.followUpQuestions ?? []).filter((item) => item.trim()).slice(0, 4));
      await props.refreshSessions();
    } catch (e) {
      if (isStoppedByUserError(e)) {
        setError('');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (props.config.browserMode === 'external') {
        try {
          await window.tasiHarness.app.closeExternalPreview();
        } catch {
          // Ignore cleanup errors when closing external preview window.
        }
      }
      props.setStopping(false);
      props.setBusy(false);
    }
  }

  async function stopCurrentSession(): Promise<void> {
    if ((!props.busy && !wechatBusy) || props.stopping) return;
    props.setStopping(true);
    setError('');
    try {
      await window.tasiHarness.agent.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!props.busy) props.setStopping(false);
    }
  }

  async function send(): Promise<void> {
    await submitMessage(input);
  }

  function toggleWebPreviewExpanded(): void {
    if (!webPreviewExpanded) {
      const container = chatContentGridRef.current;
      if (container) {
        const bounds = container.getBoundingClientRect();
        setWebPreviewRect(clampPreviewRect(buildDefaultPreviewRect(bounds.width, bounds.height), bounds.width, bounds.height));
      }
      previewNeedsMeasurementRef.current = true;
      setWebPreviewExpanded(true);
      window.requestAnimationFrame(() => {
        const webview = previewWebviewRef.current;
        if (!webview) return;
        try {
          syncPreviewWebviewHostSize();
          void refreshPreviewNaturalMetrics(true);
        } catch {
          // Ignore transient readiness failures.
        }
      });
      return;
    }
    setWebPreviewExpanded(false);
  }

  function handlePreviewDragStart(event: React.MouseEvent<HTMLDivElement>): void {
    if (!webPreviewExpanded || !webPreviewRect) return;
    if (event.button !== 0) return;
    if ((event.target as Element).closest('button, a, input, textarea, select')) return;
    const container = chatContentGridRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    dragStateRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      originRect: webPreviewRect,
      containerWidth: bounds.width,
      containerHeight: bounds.height
    };
    const onMouseMove = (moveEvent: MouseEvent) => {
      const dragging = dragStateRef.current;
      if (!dragging) return;
      const deltaX = moveEvent.clientX - dragging.startClientX;
      const deltaY = moveEvent.clientY - dragging.startClientY;
      const next = clampPreviewRect(
        {
          x: dragging.originRect.x + deltaX,
          y: dragging.originRect.y + deltaY,
          width: dragging.originRect.width,
          height: dragging.originRect.height
        },
        dragging.containerWidth,
        dragging.containerHeight
      );
      setWebPreviewRect(next);
    };
    const onMouseUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  function syncPreviewNavigationState(): void {
    const webview = previewWebviewRef.current;
    if (!webview) return;
    try {
      const currentUrl = typeof webview.getURL === 'function' ? webview.getURL() : '';
      if (currentUrl) setPreviewAddress(currentUrl);
      setPreviewCanGoBack(typeof webview.canGoBack === 'function' ? webview.canGoBack() : false);
      setPreviewCanGoForward(typeof webview.canGoForward === 'function' ? webview.canGoForward() : false);
    } catch {
      // Ignore transient errors while page changes.
    }
  }

  function handlePreviewBack(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.goBack !== 'function') return;
    try {
      if (typeof webview.canGoBack === 'function' && !webview.canGoBack()) return;
      webview.goBack();
      window.setTimeout(syncPreviewNavigationState, 80);
    } catch {
      // Ignore transient navigation errors.
    }
  }

  function handlePreviewForward(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.goForward !== 'function') return;
    try {
      if (typeof webview.canGoForward === 'function' && !webview.canGoForward()) return;
      webview.goForward();
      window.setTimeout(syncPreviewNavigationState, 80);
    } catch {
      // Ignore transient navigation errors.
    }
  }

  function handlePreviewRefresh(): void {
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.reload !== 'function') return;
    try {
      webview.reload();
    } catch {
      // Ignore transient navigation errors.
    }
  }

  async function navigatePreviewToAddress(): Promise<void> {
    const normalized = normalizePreviewUrlInput(previewAddress);
    if (!normalized) {
      setError(props.tr('Invalid URL. Please input a valid http(s) address.', 'URL 无效，请输入有效的 http(s) 地址。'));
      return;
    }
    const webview = previewWebviewRef.current;
    if (!webview || typeof webview.loadURL !== 'function') return;
    setError('');
    setPreviewAddress(normalized);
    try {
      await webview.loadURL(normalized);
      syncPreviewNavigationState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function openSessionDocumentPicker(): void {
    if (runBusy || sessionDocBusy) return;
    if (!uploadSessionDocInputRef.current) return;
    uploadSessionDocInputRef.current.value = '';
    uploadSessionDocInputRef.current.click();
  }

  async function openWorkspaceDirectory(): Promise<void> {
    const workspaceDir = props.config.workspaceDir.trim();
    if (!workspaceDir) {
      setError(props.tr('Workspace directory is not configured.', '尚未配置工作区目录。'));
      return;
    }
    setError('');
    try {
      const result = await window.tasiHarness.app.openPath(workspaceDir);
      if (!result.ok) setError(result.content || props.tr('Failed to open workspace directory.', '打开工作区目录失败。'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadSessionDocuments(files: File[]): Promise<void> {
    if (files.length === 0) return;
    setSessionDocBusy(true);
    setSessionDocError('');
    try {
      let activeSessionId = props.sessionId;
      const failures: string[] = [];
      for (const file of files) {
        try {
          const contentBase64 = await fileToBase64(file);
          const result = await window.tasiHarness.sessionDocs.upload({
            sessionId: activeSessionId,
            filename: file.name,
            contentBase64
          });
          activeSessionId = result.sessionId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${file.name}: ${message}`);
        }
      }
      if (activeSessionId && props.sessionId !== activeSessionId) props.setSessionId(activeSessionId);
      if (!activeSessionId) return;
      const docs = await window.tasiHarness.sessionDocs.list(activeSessionId);
      setSessionDocs(docs);
      await props.refreshSessions();
      if (failures.length > 0) {
        setSessionDocError(
          props.tr(
            `Some files failed to upload:\n${failures.join('\n')}`,
            `部分文件上传失败：\n${failures.join('\n')}`
          )
        );
      }
    } catch (e) {
      setSessionDocError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionDocBusy(false);
    }
  }

  async function removeSessionDocument(id: string): Promise<void> {
    if (!props.sessionId) return;
    setSessionDocBusy(true);
    setSessionDocError('');
    try {
      await window.tasiHarness.sessionDocs.deleteDocument(props.sessionId, id);
      const docs = await window.tasiHarness.sessionDocs.list(props.sessionId);
      setSessionDocs(docs);
    } catch (e) {
      setSessionDocError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionDocBusy(false);
    }
  }

  return (
    <section className="page chat-page">
      <div className="chat-header">
        <div className="chat-session-title">{props.tr('Assistant Chat', '助手对话')}</div>
        <div className="chat-actions">
          <label
            className="toggle-line chat-control chat-toggle"
            title={
              props.personalKnowledgeDocCount > 0
                ? props.tr('Use your converted personal documents as extra context for this chat.', '在当前对话中使用已转换的个人文档作为额外上下文。')
                : props.tr('Add documents on the Knowledge page first.', '请先在知识库页面添加文档。')
            }
          >
            <input
              type="checkbox"
              checked={personalKnowledgeEnabled}
              disabled={runBusy || props.personalKnowledgeDocCount === 0}
              onChange={(event) => setUsePersonalKnowledgeBase(event.target.checked)}
            />
            <span>{props.tr('Personal KB', '个人知识库')}</span>
            <span className="soft-badge">{props.personalKnowledgeDocCount}</span>
          </label>
          <select value={props.executionMode} onChange={(e) => props.setExecutionMode(e.target.value as 'workspace' | 'sandbox')}>
            <option value="workspace">{props.tr('Workspace', '工作区')}</option>
            <option value="sandbox">{props.tr('Sandbox', '沙箱')}</option>
          </select>
          <select value={props.config.browserMode} onChange={(e) => void setBridgeMode(e.target.value as PublicAppConfig['browserMode'])}>
            <option value="embedded">{props.tr('Built-in browser', '内部浏览器')}</option>
            <option value="external">{props.tr('External browser', '外部浏览器')}</option>
          </select>
          <button
            className="ghost-button"
            onClick={() => {
              props.setMessages([]);
              props.setSessionId(undefined);
              props.setLastUsage(undefined);
              props.setTotalUsage(undefined);
              props.setToolEvents([]);
              props.setExecutionMode(props.config.defaultExecutionMode);
              setFollowUpQuestions([]);
              setSessionDocs([]);
              setSessionDocError('');
            }}
          >
            {props.tr('New session', '新会话')}
          </button>
          <button className="ghost-button" onClick={() => void openWorkspaceDirectory()}>
            {props.tr('Open workspace', '打开工作区')}
          </button>
        </div>
      </div>
      <div className={`chat-content-grid ${toolPanelCollapsed ? 'tool-panel-collapsed' : ''}`} ref={chatContentGridRef}>
        <div className="chat-messages">
          {visibleMessages.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">AI</div>
              <div className="empty-title">{props.tr('Start a local agent session', '开始一个本地智能体会话')}</div>
              <div className="empty-desc">{props.tr('Main chat only shows your messages and the final assistant replies. Tool calls and tool outputs now stream in the side panel.', '主聊天区仅展示你的消息和助手最终回复，工具调用与输出会显示在右侧面板。')}</div>
            </div>
          )}
          {visibleMessages.map((m, idx) => <MessageBubble key={`${m.id ?? idx}-${idx}`} message={m} tr={props.tr} />)}
          {runBusy && <div className="typing-indicator"><span /> <span /> <span /></div>}
          {followUpQuestions.length > 0 && !runBusy && (
            <div className="follow-up-panel">
              <div className="follow-up-label">{props.tr('Suggested next questions', '建议继续追问')}</div>
              <div className="follow-up-list">
                {followUpQuestions.map((question, index) => (
                  <button key={`${question}-${index}`} className="follow-up-chip" onClick={() => void submitMessage(question)}>
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className={`tool-panel ${toolPanelCollapsed ? 'collapsed' : ''}`}>
          {toolPanelCollapsed ? (
            <button
              className="tool-panel-expand-button"
              onClick={() => setToolPanelCollapsed(false)}
              title={props.tr('Expand side panel', '展开侧边栏')}
              aria-label={props.tr('Expand side panel', '展开侧边栏')}
            >
              <span>‹</span>
              <strong>{props.tr('Trace', '轨迹')}</strong>
            </button>
          ) : (
            <>
          <div className="tool-panel-header">
            <button
              className="tool-panel-collapse-button"
              onClick={() => setToolPanelCollapsed(true)}
              title={props.tr('Collapse side panel', '收起侧边栏')}
              aria-label={props.tr('Collapse side panel', '收起侧边栏')}
            >
              ›
            </button>
            <div className="tool-panel-tabs" role="tablist" aria-label={props.tr('Side panel', '侧边栏')}>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'tools' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'tools'}
                onClick={() => setToolPanelTab('tools')}
              >
                {props.tr('Tool Trace', '工具轨迹')}
                <span>{props.toolEvents.length}</span>
              </button>
              <button
                className={`tool-panel-tab ${toolPanelTab === 'sources' ? 'active' : ''}`}
                role="tab"
                aria-selected={toolPanelTab === 'sources'}
                onClick={() => setToolPanelTab('sources')}
              >
                {props.tr('Referenced Pages', '引用网页')}
                <span>{referencedPages.length}</span>
              </button>
            </div>
          </div>
          <div className="tool-panel-body">
            {toolPanelTab === 'sources' ? (
              referencedPages.length === 0 ? (
                <div className="tool-empty">{props.tr('Referenced webpages from the latest answer will appear here.', '最新回复中的引用网页会显示在这里。')}</div>
              ) : (
                <div className="reference-panel">
                  <div className="reference-summary">
                    <strong>{props.tr(`Read ${referencedPages.length} webpages`, `已引用 ${referencedPages.length} 个网页`)}</strong>
                    <div className="reference-favicons">
                      {referencedPages.slice(0, 5).map((page) => (
                        <ReferenceFavicon key={page.href} page={page} compact />
                      ))}
                    </div>
                  </div>
                  {referencedPages.map((page) => (
                    <button key={`${page.label}-${page.href}`} className="reference-card" onClick={() => void window.tasiHarness.app.openExternalUrl(page.href, { system: true })}>
                      <div className="reference-card-top">
                        <span className="reference-index">{page.label}</span>
                        <ReferenceFavicon page={page} />
                        <strong>{page.host}</strong>
                      </div>
                      {page.excerpt && <p>{page.excerpt}</p>}
                      <span>{page.href}</span>
                    </button>
                  ))}
                </div>
              )
            ) : props.toolEvents.length === 0 ? (
              <div className="tool-empty">{props.tr('Tool requests and results will appear here in a separate scrollable pane.', '工具请求和结果会显示在这里。')}</div>
            ) : (
              props.toolEvents.map((event) => (
                <div key={event.id} className={`tool-event-card ${event.ok ? 'ok' : 'fail'}`}>
                  <div className="tool-event-top">
                    <strong>{event.toolName}</strong>
                    <span>{prettyDate(event.createdAt)}</span>
                  </div>
                  <pre className="code-block small">{JSON.stringify(event.args, null, 2)}</pre>
                  <pre className="code-block small">{event.content}</pre>
                </div>
              ))
            )}
          </div>
          {false && (
            <div className="tool-web-preview tool-web-preview-external">
              <div className="tool-web-preview-head">
                <strong>{props.tr('External Browser', '外部浏览器')}</strong>
              </div>
              <div className="tool-web-preview-toolbar">
                <input
                  className="tool-web-preview-address"
                  value={previewUrl ?? ''}
                  readOnly
                  placeholder={props.tr('Waiting for a browsable page URL...', '等待可打开的网页地址...')}
                />
                <button className="mini-button tool-web-preview-open" onClick={() => void window.tasiHarness.app.openExternalUrl(previewUrl ?? '')} disabled={!previewUrl}>
                  {props.tr('Open', '打开')}
                </button>
              </div>
              <div className="tool-web-preview-empty">
                {previewUrl
                  ? props.tr(
                      'The latest browsable page has been detected. If your system browser did not appear automatically, use Open to launch it again.',
                      '已经识别到最新网页地址；如果系统浏览器没有自动弹出，可以点上面的“打开”重新拉起。'
                    )
                  : props.tr(
                      'External browser mode is active. A manual open button will appear here after the agent reaches a webpage.',
                      '当前使用外部浏览器模式。等智能体拿到网页地址后，这里会出现可手动打开的入口。'
                    )}
              </div>
            </div>
          )}
          {showEmbeddedWebPreview && (
            <div
              className={`tool-web-preview ${shouldShowWebPreview ? '' : 'hidden'} ${webPreviewExpanded ? 'expanded' : ''}`}
              style={webPreviewExpanded && webPreviewRect ? { left: webPreviewRect.x, top: webPreviewRect.y, width: webPreviewRect.width, height: webPreviewRect.height } : undefined}
            >
              <div className={`tool-web-preview-head ${webPreviewExpanded ? 'draggable' : ''}`} onMouseDown={handlePreviewDragStart}>
                <strong>{props.tr('Web Preview', '网页预览')}</strong>
                {shouldShowWebPreview && (
                  <button className="mini-button" onClick={toggleWebPreviewExpanded}>
                    {webPreviewExpanded ? props.tr('Collapse', '收起') : props.tr('Pop out', '弹出')}
                  </button>
                )}
              </div>
              <div className="tool-web-preview-toolbar">
                <button className="mini-button" onClick={handlePreviewBack} disabled={!previewCanGoBack} title={props.tr('Back', '后退')}>
                  Back
                </button>
                <button className="mini-button" onClick={handlePreviewForward} disabled={!previewCanGoForward} title={props.tr('Forward', '前进')}>
                  Forward
                </button>
                <button className="mini-button" onClick={handlePreviewRefresh} title={props.tr('Refresh', '刷新')}>
                  {previewLoading ? '...' : 'Refresh'}
                </button>
                <input
                  className="tool-web-preview-address"
                  value={previewAddress}
                  onChange={(event) => setPreviewAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void navigatePreviewToAddress();
                    }
                  }}
                  placeholder={props.tr('Enter URL and press Enter', '输入网址后按回车')}
                />
                <a className="mini-button tool-web-preview-open" href={previewAddress || previewUrl || 'about:blank'} target="_blank" rel="noreferrer">
                  {props.tr('Open', '打开')}
                </a>
              </div>
              <div className="tool-web-preview-body" ref={previewBodyRef}>
                <webview
                  ref={previewWebviewRef}
                  className="tool-web-preview-frame"
                  src={previewUrl || 'about:blank'}
                  partition={EMBEDDED_BROWSER_PARTITION}
                />
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {sessionDocError && <div className="error-box">{sessionDocError}</div>}
      <div className="chat-input-area">
        <div className="chat-input-main">
          <input
            ref={uploadSessionDocInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            accept=".docx,.pptx,.xlsx,.pdf,.ofd,.xml,.txt,.md,.markdown,.json,.csv,.log,.text"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length === 0) return;
              void uploadSessionDocuments(files);
            }}
          />
          <div className="chat-session-doc-row">
            {sessionDocs.map((doc) => (
              <span key={doc.id} className="chat-session-doc-chip" title={doc.filename}>
                <span className="chat-session-doc-name">{doc.filename}</span>
                <span className="chat-session-doc-meta">{props.tr(`${doc.commentCount} comments`, `${doc.commentCount} comments`)}</span>
                <button
                  className="chat-session-doc-remove"
                  onClick={() => void removeSessionDocument(doc.id)}
                  disabled={sessionDocBusy}
                  title={props.tr('Remove document', 'Remove document')}
                  aria-label={props.tr('Remove document', 'Remove document')}
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <div className="chat-textarea-wrap">
          <textarea
            className="chat-textarea"
          placeholder={connected ? props.tr('Message Tasi Harness. Enter sends, Shift+Enter line break.', '发送给 Tasi Harness，回车发送，Shift+Enter 换行。') : props.tr('Configure your provider in Settings first.', '请先在设置中配置模型提供方。')}
            value={input}
            disabled={runBusy || !connected}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
            <button
              className="chat-attach-button"
              onClick={openSessionDocumentPicker}
              disabled={runBusy || sessionDocBusy || !connected}
              title={sessionDocBusy ? props.tr('Uploading...', 'Uploading...') : props.tr('Upload document', 'Upload document')}
              aria-label={sessionDocBusy ? props.tr('Uploading...', 'Uploading...') : props.tr('Upload document', 'Upload document')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M21 11.5 12.2 20.3a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 0 1-2.8-2.8l8.4-8.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        <button
          className={`send-btn${runBusy ? ' stop' : ''}`}
          disabled={runBusy ? props.stopping : !input.trim() || !connected}
          title={runBusy ? props.tr('Stop current session', '停止当前会话') : props.tr('Send message', '发送消息')}
          onClick={() => {
            if (runBusy) {
              void stopCurrentSession();
              return;
            }
            void send();
          }}
        >
          {runBusy ? (props.stopping ? '...' : <span className="send-stop-icon" aria-hidden="true" />) : props.tr('->', '->')}
        </button>
      </div>
    </section>
  );
}

function renderMarkdownContent(content: string, keyPrefix: string): ReactElement {
  const normalized = normalizeMarkdownForRender(content);
  const handleLinkClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as Element | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    void window.tasiHarness.app.openExternalUrl(href, { system: true });
  };
  return (
    <div
      key={`${keyPrefix}-md`}
      className="msg-markdown"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(normalized) }}
    />
  );
}

function CitationLinkStrip({ citations }: { citations: CitationLink[] }): ReactElement | null {
  if (citations.length === 0) return null;
  return (
    <div className="msg-citation-strip" aria-label="Referenced webpages">
      {citations.map((citation) => (
        <button
          key={`${citation.label}-${citation.href}`}
          className="msg-citation-chip"
          title={[`${citation.label}. ${citation.host}`, citation.excerpt].filter(Boolean).join(' - ')}
          aria-label={[`${citation.label}. ${citation.host}`, citation.excerpt].filter(Boolean).join(' - ')}
          onClick={() => void window.tasiHarness.app.openExternalUrl(citation.href, { system: true })}
        >
          <span className="msg-citation-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
              <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
            </svg>
          </span>
          <span>{citation.label}</span>
          <span className="msg-citation-host">{citation.host}</span>
        </button>
      ))}
    </div>
  );
}

function faviconCandidates(page: CitationLink): string[] {
  const candidates: string[] = [];
  try {
    const url = new URL(page.href);
    candidates.push(`${url.origin}/favicon.ico`);
    candidates.push(`https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(page.href)}&sz=32`);
  } catch {
    // Fall back to host-based services below.
  }
  if (page.host) {
    candidates.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(page.host)}&sz=32`);
    candidates.push(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(page.host)}.ico`);
  }
  return [...new Set(candidates)];
}

function ReferenceFavicon({ page, compact = false }: { page: CitationLink; compact?: boolean }): ReactElement {
  const candidates = useMemo(() => faviconCandidates(page), [page]);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  const fallbackText = (page.host || page.label || '?').replace(/^www\./, '').slice(0, 1).toUpperCase();

  useEffect(() => {
    setIndex(0);
  }, [page.href]);

  if (!src) {
    return <span className={`reference-favicon-fallback ${compact ? 'compact' : ''}`}>{fallbackText}</span>;
  }

  return (
    <img
      className="reference-favicon"
      src={src}
      alt=""
      onError={() => setIndex((old) => old + 1)}
    />
  );
}

function assistantExportTitle(content: string): string {
  const lines = normalizeMarkdownForRender(content).split('\n');
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line.trim()))?.replace(/^#{1,6}\s+/, '').trim();
  if (heading) return heading.slice(0, 80);
  const firstText = lines.find((line) => line.trim() && !/^```/.test(line.trim()))?.trim() ?? 'Assistant Reply';
  return firstText.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1').slice(0, 80);
}

function LegacyMessageBubble({ message }: { message: AgentMessage }): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  return (
    <div className={`msg-row ${role}`}>
      <div className="msg-avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
      <div className="msg-bubble-wrap">
        <div className="msg-bubble">{renderMarkdownContent(message.content, `msg-${message.id ?? 'x'}`)}</div>
        <div className="msg-time">{prettyDate(message.createdAt)}</div>
      </div>
    </div>
  );
}

function MessageBubble({ message, tr }: { message: AgentMessage; tr: TranslateFn }): ReactElement {
  const role = message.role === 'assistant' ? 'ai' : message.role;
  const isWechatPending = message.role === 'assistant' && message.content === WECHAT_PENDING_MARKER;
  const citations = message.role === 'assistant' ? extractCitationLinks(message.content) : [];
  const [copied, setCopied] = useState(false);
  const [exportBusy, setExportBusy] = useState<'pdf' | 'docx' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  async function handleCopy(): Promise<void> {
    try {
      await copyTextToClipboard(message.content || '');
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleExport(format: 'pdf' | 'docx'): Promise<void> {
    if (message.role !== 'assistant' || exportBusy) return;
    const exportAssistantMessage = window.tasiHarness.app.exportAssistantMessage;
    if (typeof exportAssistantMessage !== 'function') {
      window.alert(tr('Export is not available in this window yet. Please restart Tasi Harness once so the updated preload API is loaded.', '当前窗口尚未加载导出接口。请重启一次 Tasi Harness，让新的 preload API 生效。'));
      return;
    }
    setExportBusy(format);
    try {
      const normalized = normalizeMarkdownForRender(message.content);
      const html = renderMarkdownToHtml(normalized);
      const result = await exportAssistantMessage({
        format,
        title: assistantExportTitle(message.content),
        content: normalized,
        html
      });
      if (!result.ok) window.alert(result.content);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setExportBusy(null);
    }
  }

  return (
    <div className={`msg-row ${role}`}>
      <div className="msg-avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
      <div className="msg-bubble-wrap">
        <div className="msg-bubble">
          {isWechatPending ? (
            <div>
              <div className="card-subtle">{tr('WeChat message is being processed...', '微信消息处理中...')}</div>
              <div className="typing-indicator"><span /> <span /> <span /></div>
            </div>
          ) : (
            <>
              <CitationLinkStrip citations={citations} />
              {renderMarkdownContent(message.content, `msg-${message.id ?? 'x'}`)}
              <div className="msg-bubble-actions">
                {message.role === 'assistant' && (
                  <>
                    <button
                      className="msg-export-button"
                      onClick={() => void handleExport('pdf')}
                      disabled={exportBusy != null}
                      title={tr('Export as PDF', '导出为 PDF')}
                      aria-label={tr('Export as PDF', '导出为 PDF')}
                    >
                      {exportBusy === 'pdf' ? '...' : 'P'}
                    </button>
                    <button
                      className="msg-export-button"
                      onClick={() => void handleExport('docx')}
                      disabled={exportBusy != null}
                      title={tr('Export as Word', '导出为 Word')}
                      aria-label={tr('Export as Word', '导出为 Word')}
                    >
                      {exportBusy === 'docx' ? '...' : 'W'}
                    </button>
                  </>
                )}
                <button
                  className={`msg-icon-button ${copied ? 'copied' : ''}`}
                  onClick={() => void handleCopy()}
                  title={copied ? tr('Copied', '已复制') : tr('Copy message', '复制消息')}
                  aria-label={copied ? tr('Copied', '已复制') : tr('Copy message', '复制消息')}
                >
                  {copied ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12.5 9.2 16.7 19 7.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="9" y="9" width="10" height="10" rx="2" />
                      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                    </svg>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
        <div className="msg-time">{prettyDate(message.createdAt)}</div>
      </div>
    </div>
  );
}

const MEMORY_DOMAINS: Array<{ value: MemoryDomain; labelEn: string; labelZh: string }> = [
  { value: 'finance', labelEn: 'Finance', labelZh: '财经' },
  { value: 'daily_life', labelEn: 'Daily Life', labelZh: '日常' },
  { value: 'work', labelEn: 'Work', labelZh: '工作' },
  { value: 'travel', labelEn: 'Travel', labelZh: '旅行' },
  { value: 'reading', labelEn: 'Reading', labelZh: '阅读' },
  { value: 'education', labelEn: 'Education', labelZh: '教育' },
  { value: 'health', labelEn: 'Health', labelZh: '健康' },
  { value: 'other', labelEn: 'Other', labelZh: '其他' }
];

function knownMemoryDomain(value?: string): MemoryDomain {
  return MEMORY_DOMAINS.some((item) => item.value === value) ? (value as MemoryDomain) : 'other';
}

function KnowledgePage(props: { tr: TranslateFn; knowledge: PersonalKnowledgeState; refreshKnowledge: () => Promise<void> }): ReactElement {
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [folderImportBusy, setFolderImportBusy] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function openStoredPath(path: string): Promise<void> {
    try {
      setError('');
      const result = await window.tasiHarness.app.openPath(path);
      if (!result.ok) {
        setError(result.content || props.tr('Failed to open the selected file.', '打开所选文件失败。'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function addDocument(): Promise<void> {
    if (!uploadFile) {
      setError(props.tr('Choose a document first.', '请先选择一个文档。'));
      return;
    }
    setUploadBusy(true);
    setError('');
    setNotice('');
    try {
      const contentBase64 = await fileToBase64(uploadFile);
      const doc = await window.tasiHarness.knowledge.addDocument({
        filename: uploadFile.name,
        contentBase64
      });
      setNotice(props.tr(`Added ${doc.filename} to your personal knowledge base.`, `已将 ${doc.filename} 添加到个人知识库。`));
      setUploadFile(null);
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploadBusy(false);
    }
  }

  async function addFolder(): Promise<void> {
    setFolderImportBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.tasiHarness.knowledge.addFolder();
      if (!result.folderPath) {
        setNotice(props.tr('Folder import canceled.', '已取消文件夹导入。'));
        return;
      }
      const failedCount = result.failed.length;
      setNotice(
        props.tr(
          `Folder import complete: ${result.imported} imported, ${result.skipped} skipped, ${failedCount} failed (scanned ${result.discovered} files).`,
          `文件夹导入完成：成功 ${result.imported}，跳过 ${result.skipped}，失败 ${failedCount}（共扫描 ${result.discovered} 个文件）。`
        )
      );
      if (failedCount > 0) {
        const preview = result.failed
          .slice(0, 5)
          .map((item) => `- ${item.filePath}: ${item.error}`)
          .join('\n');
        const rest = failedCount > 5 ? props.tr(`\n...and ${failedCount - 5} more failures.`, `\n...以及另外 ${failedCount - 5} 个失败项。`) : '';
        setError(props.tr(`Some files failed to import:\n${preview}${rest}`, `部分文件导入失败：\n${preview}${rest}`));
      }
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderImportBusy(false);
    }
  }

  async function deleteDocument(doc: PersonalKnowledgeDocument): Promise<void> {
    const confirmed = globalThis.confirm(
      props.tr(
        `Delete ${doc.filename} and its generated markdown from your personal knowledge base?`,
        `确认从个人知识库删除 ${doc.filename} 及其生成的 Markdown 吗？`
      )
    );
    if (!confirmed) return;
    setDeletingDocId(doc.id);
    setError('');
    setNotice('');
    try {
      const removed = await window.tasiHarness.knowledge.deleteDocument(doc.id);
      if (!removed) throw new Error(props.tr('The document no longer exists.', '该文档已不存在。'));
      setNotice(props.tr(`Removed ${doc.filename}.`, `已删除 ${doc.filename}。`));
      await props.refreshKnowledge();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingDocId(null);
    }
  }

  return (
    <section className="page">
      <PageHeader
        title={props.tr('Personal Knowledge', '个人知识库')}
        subtitle={props.tr(
          'Convert local Office and text documents into Markdown, store them locally, and optionally inject relevant excerpts into chat.',
          '将本地 Office 和文本文件转换成 Markdown，本地保存，并可在对话时按需注入相关片段。'
        )}
        action={<button className="mini-button" onClick={() => void props.refreshKnowledge()}>{props.tr('Refresh', '刷新')}</button>}
      />
      <div className="split-grid knowledge-layout">
        <div className="card">
          <h2>{props.tr('Add Document', '添加文档')}</h2>
          <p>{props.tr('Supported formats: Markdown, TXT, JSON, CSV, DOCX, XLSX, PPTX, PDF, OFD.', '支持格式：Markdown、TXT、JSON、CSV、DOCX、XLSX、PPTX、PDF、OFD。')}</p>
          <label>{props.tr('Source document', '源文档')}</label>
          <input
            type="file"
            accept=".md,.markdown,.txt,.text,.log,.json,.csv,.docx,.xlsx,.pptx,.pdf,.ofd"
            disabled={uploadBusy || folderImportBusy}
            onChange={(event) => {
              setUploadFile(event.target.files?.[0] ?? null);
              setError('');
            }}
          />
          {uploadFile && (
            <div className="meta-row wrap upload-file-row">
              <span className="soft-badge">{props.tr('File', '文件')}: {uploadFile.name}</span>
              <span className="soft-badge">{props.tr('Size', '大小')}: {(uploadFile.size / 1024).toFixed(1)} KB</span>
            </div>
          )}
          <div className="button-row">
            <button className="primary-button" disabled={!uploadFile || uploadBusy || folderImportBusy} onClick={() => void addDocument()}>
              {uploadBusy ? '...' : props.tr('Add to Knowledge Base', '加入知识库')}
            </button>
            <button className="ghost-button" disabled={uploadBusy || folderImportBusy} onClick={() => void addFolder()}>
              {folderImportBusy ? '...' : props.tr('Import Folder', '导入文件夹')}
            </button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
          {error && <div className="error-box knowledge-error">{error}</div>}
        </div>
        <div className="card">
          <h2>{props.tr('Overview', '概览')}</h2>
          <p>{props.tr('Each document is converted into Markdown and chunked for lexical retrieval. Chat can then pull the most relevant excerpts when the toggle is enabled.', '每个文档会被转换成 Markdown 并切分为检索片段；在聊天中打开开关后，会自动拉取最相关的片段。')}</p>
          <div className="knowledge-stats">
            <span className="soft-badge">{props.tr('Documents', '文档')}: {props.knowledge.totalDocs}</span>
            <span className="soft-badge">{props.tr('Chunks', '分块')}: {props.knowledge.totalChunks}</span>
            <span className="soft-badge">{props.tr('Chars', '字符')}: {props.knowledge.totalChars}</span>
          </div>
        </div>
      </div>
      <div className="card knowledge-library">
        <div className="marketplace-card-top">
          <div>
            <h2>{props.tr('Document Library', '文档列表')}</h2>
            <div className="card-subtle">{props.tr('Open the generated Markdown or delete documents you no longer want to use.', '可以打开生成后的 Markdown，也可以删除不再需要的文档。')}</div>
          </div>
        </div>
        <div className="marketplace-list knowledge-list">
          {props.knowledge.docs.map((doc) => (
            <div key={doc.id} className="marketplace-card">
              <div className="marketplace-card-top">
                <div>
                  <strong>{doc.title}</strong>
                  <div className="card-subtle">{doc.filename}</div>
                </div>
                <div className="button-row compact knowledge-actions">
                  <button className="ghost-button" onClick={() => void openStoredPath(doc.markdownPath)}>
                    {props.tr('Open Markdown', '打开 Markdown')}
                  </button>
                  <button className="ghost-button" onClick={() => void openStoredPath(doc.sourcePath)}>
                    {props.tr('Open Source', '打开源文件')}
                  </button>
                  <button className="danger-button" disabled={deletingDocId === doc.id} onClick={() => void deleteDocument(doc)}>
                    {deletingDocId === doc.id ? '...' : props.tr('Delete', '删除')}
                  </button>
                </div>
              </div>
              <p className="knowledge-card-text">{doc.excerpt || props.tr('No excerpt available.', '暂无摘要。')}</p>
              <div className="meta-row wrap">
                <span className="soft-badge">{props.tr('Chunks', '分块')}: {doc.chunkCount}</span>
                <span className="soft-badge">{props.tr('Chars', '字符')}: {doc.charCount}</span>
                <span className="soft-badge">{props.tr('Updated', '更新时间')}: {prettyDate(doc.updatedAt)}</span>
                {doc.imagesDir && <span className="soft-badge">{props.tr('Images extracted', '已提取图片')}</span>}
              </div>
            </div>
          ))}
          {props.knowledge.docs.length === 0 && (
            <div className="tool-empty">{props.tr('No personal knowledge documents yet.', '暂时还没有个人知识库文档。')}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function MemoryPage(props: { tr: TranslateFn; memory: MemoryState; sessionId?: string }): ReactElement {
  const [notice, setNotice] = useState('');
  const [searchIntent, setSearchIntent] = useState('');
  const [searchDomain, setSearchDomain] = useState<MemoryDomain | 'all'>('all');
  const [searchSessionId, setSearchSessionId] = useState(props.sessionId ?? '');
  const [activeCategory, setActiveCategory] = useState<MemoryDomain | 'all'>('all');
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<MemoryEntry | null>(null);
  const [retrieved, setRetrieved] = useState<MemoryState>({
    ...props.memory,
    entries: props.memory.entries.filter((entry) => entry.target === 'memory'),
    usage: props.memory.usage.filter((u) => u.target === 'memory')
  });

  useEffect(() => {
    setRetrieved({
      ...props.memory,
      entries: props.memory.entries.filter((entry) => entry.target === 'memory'),
      usage: props.memory.usage.filter((u) => u.target === 'memory')
    });
    if (props.sessionId && !searchSessionId) setSearchSessionId(props.sessionId);
  }, [props.memory, props.sessionId]);

  async function refreshRetrieved(): Promise<void> {
    const next = await window.tasiHarness.memory.get({
      target: 'memory',
      sessionId: searchSessionId.trim() || undefined,
      domain: searchDomain === 'all' ? undefined : searchDomain,
      intent: searchIntent.trim() || undefined,
      includeGlobal: true,
      limit: 200
    });
    setRetrieved({
      ...next,
      entries: next.entries.filter((entry) => entry.target === 'memory'),
      usage: next.usage.filter((u) => u.target === 'memory')
    });
  }

  async function retrieve(): Promise<void> {
    try {
      await refreshRetrieved();
      setNotice(props.tr('Memory retrieval updated.', '记忆检索已更新。'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const categorizedEntries = useMemo(() => {
    const byDomain = new Map<MemoryDomain, MemoryEntry[]>();
    for (const item of MEMORY_DOMAINS) byDomain.set(item.value, []);
    const allSorted = [...retrieved.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const entry of allSorted) {
      const domain = knownMemoryDomain(entry.domain);
      byDomain.get(domain)?.push(entry);
    }
    return { allSorted, byDomain };
  }, [retrieved.entries]);

  const categories = useMemo(
    () => [
      { value: 'all' as const, label: props.tr('All categories', '所有类别'), count: categorizedEntries.allSorted.length },
      ...MEMORY_DOMAINS.map((item) => ({
        value: item.value,
        label: props.tr(item.labelEn, item.labelZh),
        count: categorizedEntries.byDomain.get(item.value)?.length ?? 0
      }))
    ],
    [categorizedEntries, props.tr]
  );

  const visibleEntries = useMemo(() => {
    if (activeCategory === 'all') return categorizedEntries.allSorted;
    return categorizedEntries.byDomain.get(activeCategory) ?? [];
  }, [activeCategory, categorizedEntries]);

  useEffect(() => {
    if (activeEntryId && !visibleEntries.some((entry) => entry.id === activeEntryId)) {
      setActiveEntryId(null);
    }
    if (previewEntry && !retrieved.entries.some((entry) => entry.id === previewEntry.id)) {
      setPreviewEntry(null);
    }
  }, [visibleEntries, activeEntryId, previewEntry, retrieved.entries]);

  function entryTitle(content: string): string {
    const line = content.split('\n')[0]?.trim() ?? '';
    if (!line) return '(empty)';
    return line.length > 60 ? `${line.slice(0, 60)}...` : line;
  }

  return (
    <>
      <section className="page">
      <PageHeader title={props.tr('Memory', '记忆')} subtitle={props.tr('Display and retrieval only. Memory is committed after one chat run or one scheduled task run completes.', '仅展示和检索。Memory 会在一次对话或定时任务完成后统一存储。')} />
      <div className="split-grid memory-layout">
        <div className="card">
          <h2>{props.tr('Search Filters', '检索条件')}</h2>
          <label>{props.tr('Intent query', '意图查询')}</label>
          <input value={searchIntent} onChange={(e) => setSearchIntent(e.target.value)} placeholder={props.tr('e.g. stock analysis, study plan, health reminders', '比如：股票分析、学习计划、健康提醒')} />
          <label>{props.tr('Domain filter', '分类筛选')}</label>
          <select value={searchDomain} onChange={(e) => setSearchDomain(e.target.value as MemoryDomain | 'all')}>
            <option value="all">{props.tr('all domains', '全部分类')}</option>
            {MEMORY_DOMAINS.map((item) => (
              <option key={item.value} value={item.value}>{props.tr(item.labelEn, item.labelZh)}</option>
            ))}
          </select>
          <label>{props.tr('Session ID (optional)', '会话 ID（可选）')}</label>
          <input value={searchSessionId} onChange={(e) => setSearchSessionId(e.target.value)} placeholder={props.tr('limit retrieval to one session', '限定检索到某个会话')} />
          <div className="button-row">
            <button className="primary-button" onClick={() => void retrieve()}>{props.tr('Retrieve', '检索')}</button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
          <h2>{props.tr('Memory usage', '记忆用量')}</h2>
          {retrieved.usage.map((u) => (
            <div className="usage-row" key={u.target}>
              <span>{u.target}</span>
              <progress value={u.used} max={u.limit} />
              <span>{u.used}/{u.limit}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>{props.tr('Categories', '分类展示')}</h2>
          <div className="memory-browser">
            <div className="memory-category-list">
              {categories.map((category) => (
                <button
                  key={category.value}
                  className={`memory-category-item ${activeCategory === category.value ? 'active' : ''}`}
                  onClick={() => setActiveCategory(category.value)}
                >
                  <span>{category.label}</span>
                  <span>{category.count}</span>
                </button>
              ))}
            </div>
            <div className="memory-entry-list">
              {visibleEntries.length === 0 ? (
                <div className="tool-empty">{props.tr('No memory entries in this category.', '该分类下暂无条目。')}</div>
              ) : (
                visibleEntries.map((entry) => (
                  <button
                    key={entry.id}
                    className={`memory-entry-item ${activeEntryId === entry.id ? 'active' : ''}`}
                    onClick={() => {
                      setActiveEntryId(entry.id);
                      setPreviewEntry(entry);
                    }}
                  >
                    <div className="memory-entry-title">{entryTitle(entry.content)}</div>
                    <div className="memory-entry-meta">{entry.scope === 'session' ? `session:${entry.sessionId ?? 'unknown'}` : 'global'}</div>
                  </button>
                ))
              )}
            </div>
          </div>
          {retrieved.entries.length === 0 && <div className="tool-empty">{props.tr('No memory entries matched this retrieval.', '没有匹配本次检索的记忆条目。')}</div>}
        </div>
      </div>
      </section>
      {previewEntry && (
        <div className="modal-backdrop" onClick={() => setPreviewEntry(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>{props.tr('Memory Entry', '记忆条目')}</h2>
              <button className="ghost-button" onClick={() => setPreviewEntry(null)}>{props.tr('Close', '关闭')}</button>
            </div>
            <div className="meta-row wrap">
              <span className="soft-badge">{previewEntry.domain}</span>
              <span className="soft-badge">{previewEntry.scope === 'session' ? `session:${previewEntry.sessionId ?? 'unknown'}` : 'global'}</span>
              <span className="soft-badge">{prettyDate(previewEntry.updatedAt)}</span>
            </div>
            <pre className="code-block">{previewEntry.content}</pre>
          </div>
        </div>
      )}
    </>
  );
}
function createSkillTemplate(name: string, category: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: A reusable local workflow created from the desktop UI.`,
    `category: ${category}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Use this skill when the user asks for this workflow.',
    '',
    '## Steps',
    '',
    '1. Clarify inputs.',
    '2. Inspect relevant files.',
    '3. Apply the smallest safe change.',
    '4. Run tests and summarize results.',
    ''
  ].join('\n');
}

function normalizeSkillContent(content: string, name: string, category: string): string {
  const safeName = name.trim() || 'my-workflow';
  const safeCategory = category.trim() || 'local';
  const trimmed = content.trim();
  const frontmatterMatch = trimmed.match(/^---\n([\s\S]*?)\n---\n?/);
  if (frontmatterMatch) {
    const existingLines = frontmatterMatch[1]
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    const keptLines = existingLines.filter((line) => {
      const key = line.split(':', 1)[0]?.trim().toLowerCase();
      return key !== 'name' && key !== 'category';
    });
    const hasDescription = keptLines.some((line) => line.split(':', 1)[0]?.trim().toLowerCase() === 'description');
    const body = trimmed.slice(frontmatterMatch[0].length).trim();
    const lines = ['---', `name: ${safeName}`];
    if (!hasDescription) lines.push(`description: Skill ${safeName}.`);
    lines.push(`category: ${safeCategory}`, ...keptLines, '---', '', body, '');
    return lines.join('\n');
  }
  const body = trimmed || `# ${safeName}\n\nDescribe what this skill does.`;
  return ['---', `name: ${safeName}`, `description: Skill ${safeName}.`, `category: ${safeCategory}`, '---', '', body, ''].join('\n');
}

const emptyCoachRecording: BrowserCoachRecording = {
  id: '',
  startUrl: '',
  startedAt: '',
  active: false,
  events: []
};

function formatCoachEvent(event: BrowserCoachRecordedEvent): string {
  const target = event.name || event.text || event.selector || event.tag || '';
  const detail = event.value ? ` = ${event.value}` : event.key ? ` key=${event.key}` : '';
  return `${event.index}. ${event.type}${target ? ` | ${target}` : ''}${detail}`;
}

function SkillsPage({ tr, skills, refreshSkills }: { tr: TranslateFn; skills: SkillMetadata[]; refreshSkills: () => Promise<void> }): ReactElement {
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace' | 'upload' | 'coach'>('installed');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [marketplace, setMarketplace] = useState<MarketplaceBrowseResult>({ sources: [], skills: [] });
  const [marketError, setMarketError] = useState('');
  const [marketActionKey, setMarketActionKey] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('uploaded-skill');
  const [uploadCategory, setUploadCategory] = useState('local');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadNotice, setUploadNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [coachUrl, setCoachUrl] = useState('https://www.baidu.com');
  const [coachRecording, setCoachRecording] = useState<BrowserCoachRecording>(emptyCoachRecording);
  const [coachSkillName, setCoachSkillName] = useState('recorded-browser-workflow');
  const [coachCategory, setCoachCategory] = useState('browser');
  const [coachDescription, setCoachDescription] = useState('');
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachNotice, setCoachNotice] = useState('');
  const [coachError, setCoachError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editorName, setEditorName] = useState('my-workflow');
  const [editorCategory, setEditorCategory] = useState('local');
  const [editorContent, setEditorContent] = useState(createSkillTemplate('my-workflow', 'local'));
  const [editorReadonly, setEditorReadonly] = useState(false);
  const [editorOriginalName, setEditorOriginalName] = useState<string | null>(null);
  const [editorOriginalContent, setEditorOriginalContent] = useState('');
  const [editorError, setEditorError] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 240);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    void window.tasiHarness.skills
      .browseMarketplace(debouncedQuery)
      .then((result) => {
        setMarketplace(result);
        setMarketError('');
      })
      .catch((error) => {
        setMarketplace({ sources: [], skills: [] });
        setMarketError(error instanceof Error ? error.message : String(error));
      });
  }, [debouncedQuery, skills, activeTab]);

  useEffect(() => {
    if (activeTab !== 'coach') return;
    let canceled = false;
    const refresh = () => {
      void window.tasiHarness.browserCoach.status()
        .then((recording) => {
          if (!canceled) setCoachRecording(recording);
        })
        .catch((error) => {
          if (!canceled) setCoachError(error instanceof Error ? error.message : String(error));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 900);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [activeTab]);

  function closeEditor(): void {
    if (editorSaving) return;
    setEditorOpen(false);
    setEditorError('');
  }

  function openCreateEditor(): void {
    const initialName = 'my-workflow';
    setEditorMode('create');
    setEditorName(initialName);
    setEditorCategory('local');
    setEditorContent(createSkillTemplate(initialName, 'local'));
    setEditorReadonly(false);
    setEditorOriginalName(null);
    setEditorOriginalContent('');
    setEditorError('');
    setEditorOpen(true);
    setActiveTab('installed');
  }

  async function openInstalledSkill(name: string): Promise<void> {
    const doc = await window.tasiHarness.skills.read(name);
    if (!doc) {
      setNotice(`Unable to open ${name}.`);
      return;
    }
    setEditorMode('edit');
    setEditorName(doc.name);
    setEditorCategory(doc.category);
    setEditorContent(doc.content);
    setEditorReadonly(doc.readonly);
    setEditorOriginalName(doc.name);
    setEditorOriginalContent(doc.content);
    setEditorError('');
    setEditorOpen(true);
    setActiveTab('installed');
  }

  async function refreshMarketplaceSnapshot(): Promise<void> {
    try {
      const latest = await window.tasiHarness.skills.browseMarketplace(debouncedQuery);
      setMarketplace(latest);
      setMarketError('');
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    }
  }

  function suggestSkillNameFromFilename(filename: string): string {
    const base = filename.replace(/\.[^./\\]+$/, '').toLowerCase();
    const normalized = base
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
    return normalized || 'uploaded-skill';
  }

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const data = result.split(',').at(1) ?? '';
        if (!data) reject(new Error('Failed to read file content.'));
        else resolve(data);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }

  async function saveEditor(): Promise<void> {
    const name = editorName.trim();
    const category = editorCategory.trim() || 'local';
    if (!name) {
      setEditorError('Skill name is required.');
      return;
    }
    if (!editorContent.trim()) {
      setEditorError('Skill content cannot be empty.');
      return;
    }
    const content = normalizeSkillContent(editorContent, name, category);
    setEditorSaving(true);
    setEditorError('');
    try {
      if (editorMode === 'create') {
        await window.tasiHarness.skills.create({ name, category, content });
        setNotice(`Created ${name}.`);
      } else {
        if (editorReadonly) throw new Error('This skill is read-only and cannot be edited.');
        if (!editorOriginalName) throw new Error('Missing original skill name.');
        if (name === editorOriginalName) {
          await window.tasiHarness.skills.patch({
            name: editorOriginalName,
            oldString: editorOriginalContent,
            newString: content
          });
          setNotice(`Saved ${name}.`);
        } else {
          await window.tasiHarness.skills.create({ name, category, content });
          const removed = await window.tasiHarness.skills.delete(editorOriginalName);
          if (!removed) throw new Error(`Renamed ${name}, but failed to remove old skill ${editorOriginalName}.`);
          setNotice(`Renamed ${editorOriginalName} to ${name}.`);
        }
      }
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      setEditorOpen(false);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setEditorSaving(false);
    }
  }

  async function install(skill: MarketplaceSkill): Promise<void> {
    const { sourceId, id: skillId } = skill;
    const actionKey = `install:${sourceId}:${skillId}`;
    setMarketActionKey(actionKey);
    setMarketError('');
    try {
      const installed = await window.tasiHarness.skills.installFromMarketplace({
        sourceId,
        skillId,
        skill: {
          id: skill.id,
          sourceId: skill.sourceId,
          sourceName: skill.sourceName,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          version: skill.version,
          readme: skill.readme,
          skillContent: skill.skillContent,
          supportingFiles: skill.supportingFiles,
          homepage: skill.homepage,
          remoteVersionId: skill.remoteVersionId,
          installCommand: skill.installCommand
        }
      });
      setNotice(`Marketplace skill installed: ${installed.installedSkillName ?? installed.name}.`);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      await openInstalledSkill(installed.installedSkillName ?? installed.name);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketActionKey(null);
    }
  }

  async function uninstall(name: string): Promise<void> {
    if (!name) return;
    const actionKey = `uninstall:${name}`;
    setMarketActionKey(actionKey);
    setMarketError('');
    try {
      await window.tasiHarness.skills.uninstallMarketplaceSkill(name);
      setNotice(`Removed ${name}.`);
      if (editorOpen && editorOriginalName === name) setEditorOpen(false);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : String(error));
    } finally {
      setMarketActionKey(null);
    }
  }

  async function uploadArchive(): Promise<void> {
    setUploadError('');
    setUploadNotice('');
    if (!uploadFile) {
      setUploadError('Please choose a ZIP package first.');
      return;
    }
    const skillName = uploadName.trim();
    if (!skillName) {
      setUploadError('Please fill in a skill name.');
      return;
    }
    setUploadBusy(true);
    try {
      const contentBase64 = await fileToBase64(uploadFile);
      const created = await window.tasiHarness.skills.uploadArchive({
        filename: uploadFile.name,
        contentBase64,
        name: skillName,
        category: uploadCategory.trim() || 'local'
      });
      setUploadNotice(`Uploaded and installed ${created.name}.`);
      setNotice(`Uploaded and installed ${created.name}.`);
      await refreshSkills();
      await refreshMarketplaceSnapshot();
      setActiveTab('installed');
      await openInstalledSkill(created.name);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadBusy(false);
    }
  }

  async function startCoach(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      const recording = await window.tasiHarness.browserCoach.start({ url: coachUrl });
      setCoachRecording(recording);
      setCoachNotice(tr('Browser coach started. Operate in the opened browser window.', '教练已开始。请在弹出的浏览器窗口中操作。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function stopCoach(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    try {
      setCoachRecording(await window.tasiHarness.browserCoach.stop());
      setCoachNotice(tr('Browser coach stopped.', '教练已停止。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function clearCoachTrace(): Promise<void> {
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      setCoachRecording(await window.tasiHarness.browserCoach.clear());
      setCoachNotice(tr('Browser trace cleared.', '浏览器操作轨迹已清除。'));
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  async function generateCoachSkill(): Promise<void> {
    const name = coachSkillName.trim();
    const category = coachCategory.trim() || 'browser';
    if (!name) {
      setCoachError(tr('Skill name is required.', '请填写技能名称。'));
      return;
    }
    if (coachRecording.events.length === 0) {
      setCoachError(tr('Record at least one browser action before generating a skill.', '请至少记录一个浏览器操作后再生成技能。'));
      return;
    }
    setCoachBusy(true);
    setCoachError('');
    setCoachNotice('');
    try {
      const result = await window.tasiHarness.browserCoach.generateSkill({
        name,
        category,
        description: coachDescription.trim() || undefined
      });
      setNotice(tr(`Generated skill ${result.skill.name}.`, `已生成技能 ${result.skill.name}。`));
      setCoachNotice(tr(`Generated skill ${result.skill.name}; recording saved to ${result.recordingReferencePath}.`, `已生成技能 ${result.skill.name}；轨迹已保存到 ${result.recordingReferencePath}。`));
      await refreshSkills();
      await openInstalledSkill(result.skill.name);
    } catch (error) {
      setCoachError(error instanceof Error ? error.message : String(error));
    } finally {
      setCoachBusy(false);
    }
  }

  return (
    <section className="page">
      <PageHeader
        title={tr('Skills', '技能')}
        subtitle={tr('Browse local skills and marketplace catalogs such as ClawHub and SkillHub.', '浏览本地技能与技能市场目录（如 ClawHub、SkillHub）。')}
        action={<button className="primary-button" onClick={openCreateEditor}>{tr('Create', '创建')}</button>}
      />
      <div className="card">
        <div className="skill-tabs">
          <button className={`skill-tab ${activeTab === 'installed' ? 'active' : ''}`} onClick={() => setActiveTab('installed')}>
            {tr('Installed skills', '已安装技能')}
          </button>
          <button className={`skill-tab ${activeTab === 'marketplace' ? 'active' : ''}`} onClick={() => setActiveTab('marketplace')}>
            {tr('Marketplace', '技能市场')}
          </button>
          <button className={`skill-tab ${activeTab === 'upload' ? 'active' : ''}`} onClick={() => setActiveTab('upload')}>
            {tr('Upload', '上传')}
          </button>
          <button className={`skill-tab ${activeTab === 'coach' ? 'active' : ''}`} onClick={() => setActiveTab('coach')}>
            {tr('Coach', '教练')}
          </button>
        </div>
        {activeTab === 'installed' && (
          <>
            <h2>{tr('Installed skills', '已安装技能')}</h2>
            <div className="skills-grid">
              {skills.map((skill) => (
                <div key={`${skill.source}-${skill.name}`} className="skill-card">
                  <div className="skill-card-top"><strong>{skill.name}</strong></div>
                  <p>{skill.description}</p>
                  <div className="skill-footer">
                    <span>{skill.category}</span>
                    <span>{skill.marketplaceSourceId ?? skill.source}</span>
                  </div>
                  <div className="button-row compact skill-actions">
                    <button className="ghost-button" onClick={() => void openInstalledSkill(skill.name)}>{tr('Open', '打开')}</button>
                    {!skill.readonly && <button className="danger-button" onClick={() => void uninstall(skill.name)}>{tr('Uninstall', '卸载')}</button>}
                  </div>
                </div>
              ))}
              {skills.length === 0 && <div className="tool-empty">{tr('No installed skills yet.', '暂无已安装技能。')}</div>}
            </div>
          </>
        )}
        {activeTab === 'marketplace' && (
          <>
            <h2>{tr('Marketplace', '技能市场')}</h2>
            <label>{tr('Search marketplace skills', '搜索市场技能')}</label>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('search ClawHub, SkillHub, and more', '搜索 ClawHub、SkillHub 等')} />
            {marketError && <div className="error-box market-error">{marketError}</div>}
            <div className="meta-row wrap">
              <span className="soft-badge">{tr('Results', '结果')}: {marketplace.skills.length}</span>
              {debouncedQuery && <span className="soft-badge">{tr('Query', '检索')}: {debouncedQuery}</span>}
              {marketplace.sources.filter((source) => source.enabled).map((source) => (
                <span key={source.id} className="soft-badge">{source.name}</span>
              ))}
            </div>
            <div className="marketplace-list">
              {marketplace.skills.map((skill) => (
                <div key={`${skill.sourceId}-${skill.id}`} className="marketplace-card">
                  {(() => {
                    const installActionKey = `install:${skill.sourceId}:${skill.id}`;
                    const uninstallActionKey = `uninstall:${skill.installedSkillName ?? ''}`;
                    const installBusy = marketActionKey === installActionKey;
                    const uninstallBusy = marketActionKey === uninstallActionKey;
                    return (
                  <div className="marketplace-card-top">
                    <div>
                      <strong>{skill.name}</strong>
                      <div className="card-subtle">{skill.sourceName} | {skill.category} | v{skill.version}</div>
                    </div>
                    {skill.installed && skill.installedSkillName ? (
                      <button className="danger-button" disabled={uninstallBusy || marketActionKey !== null} onClick={() => void uninstall(skill.installedSkillName ?? '')}>
                        {uninstallBusy ? tr('Uninstalling...', '卸载中...') : tr('Uninstall', '卸载')}
                      </button>
                    ) : (
                      <button className="primary-button" disabled={installBusy || marketActionKey !== null} onClick={() => void install(skill)}>
                        {installBusy ? tr('Installing...', '安装中...') : tr('Install', '安装')}
                      </button>
                    )}
                  </div>
                    );
                  })()}
                  <p>{skill.description}</p>
                  <pre className="code-block small">{skill.readme || skill.skillContent}</pre>
                </div>
              ))}
              {marketplace.skills.length === 0 && <div className="tool-empty">{tr('No marketplace skills matched the current search.', '当前搜索未匹配到市场技能。')}</div>}
            </div>
          </>
        )}
        {activeTab === 'upload' && (
          <>
            <h2>{tr('Upload Skill Package', '上传技能包')}</h2>
            <label>{tr('ZIP package', 'ZIP 文件')}</label>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setUploadFile(file);
                if (file) {
                  setUploadName(suggestSkillNameFromFilename(file.name));
                  setUploadError('');
                }
              }}
            />
            <label>{tr('Skill name', '技能名')}</label>
            <input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder={tr('required, e.g. my-automation-skill', '必填，例如：my-automation-skill')} />
            <label>{tr('Category', '分类')}</label>
            <input value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)} placeholder="local" />
            {uploadFile && (
              <div className="meta-row wrap upload-file-row">
                <span className="soft-badge">{tr('File', '文件')}: {uploadFile.name}</span>
                <span className="soft-badge">{tr('Size', '大小')}: {(uploadFile.size / 1024).toFixed(1)} KB</span>
              </div>
            )}
            <div className="button-row">
              <button className="primary-button" disabled={uploadBusy} onClick={() => void uploadArchive()}>
                {uploadBusy ? tr('Uploading...', '上传中...') : tr('Upload and Install', '上传并安装')}
              </button>
            </div>
            {uploadError && <div className="error-box market-error">{uploadError}</div>}
            {uploadNotice && <div className="notice-box">{uploadNotice}</div>}
          </>
        )}
        {activeTab === 'coach' && (
          <>
            <h2>{tr('Browser Coach', '浏览器教练')}</h2>
            <div className="coach-layout">
              <div className="coach-controls">
                <label>{tr('Start URL', '起始网址')}</label>
                <input value={coachUrl} onChange={(event) => setCoachUrl(event.target.value)} placeholder="https://www.baidu.com" />
                <div className="button-row">
                  <button className="primary-button" disabled={coachBusy || coachRecording.active} onClick={() => void startCoach()}>
                    {coachRecording.active ? tr('Recording...', '记录中...') : tr('Start', '开始')}
                  </button>
                  <button className="ghost-button" disabled={coachBusy || !coachRecording.active} onClick={() => void stopCoach()}>
                    {tr('Stop', '停止')}
                  </button>
                  <span className={`soft-badge ${coachRecording.active ? 'badge-ok' : 'badge-muted'}`}>
                    {coachRecording.active ? tr('Recording', '记录中') : tr('Idle', '空闲')}
                  </span>
                  <span className="soft-badge">{tr('Events', '事件')}: {coachRecording.events.length}</span>
                </div>
                <label>{tr('Skill name', '技能名')}</label>
                <input value={coachSkillName} onChange={(event) => setCoachSkillName(event.target.value)} placeholder="recorded-browser-workflow" />
                <label>{tr('Category', '分类')}</label>
                <input value={coachCategory} onChange={(event) => setCoachCategory(event.target.value)} placeholder="browser" />
                <label>{tr('Description', '描述')}</label>
                <input value={coachDescription} onChange={(event) => setCoachDescription(event.target.value)} placeholder={tr('optional skill trigger description', '可选，用于触发技能的描述')} />
                <div className="button-row">
                  <button className="primary-button" disabled={coachBusy || coachRecording.events.length === 0} onClick={() => void generateCoachSkill()}>
                    {coachBusy ? tr('Working...', '处理中...') : tr('Generate Skill', '生成技能')}
                  </button>
                </div>
              </div>
              <div className="coach-trace">
                <div className="coach-trace-head">
                  <strong>{tr('Recorded Browser Trace', '浏览器操作轨迹')}</strong>
                  <div className="coach-trace-head-actions">
                    {coachRecording.startedAt && <span>{prettyDate(coachRecording.startedAt)}</span>}
                    <button
                      className="mini-button"
                      disabled={coachBusy || coachRecording.events.length === 0}
                      onClick={() => void clearCoachTrace()}
                    >
                      {tr('Clear', '清除')}
                    </button>
                  </div>
                </div>
                {coachRecording.events.length === 0 ? (
                  <div className="tool-empty">{tr('Click Start, operate in the browser window, and actions will appear here.', '点击开始，在弹出的浏览器中操作，轨迹会显示在这里。')}</div>
                ) : (
                  <div className="coach-trace-list">
                    {coachRecording.events.slice(-120).map((event) => (
                      <div key={event.id || `${event.index}-${event.createdAt}`} className="coach-event">
                        <div>
                          <strong>{formatCoachEvent(event)}</strong>
                          <span>{event.url}</span>
                        </div>
                        <time>{prettyDate(event.createdAt)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {coachError && <div className="error-box market-error">{coachError}</div>}
            {coachNotice && <div className="notice-box">{coachNotice}</div>}
          </>
        )}
        {notice && <div className="notice-box">{notice}</div>}
      </div>
      {editorOpen && (
        <div className="modal-backdrop" onClick={closeEditor}>
          <div className="modal-card skill-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>{editorMode === 'create' ? tr('Create Skill', '创建技能') : tr('Edit Skill', '编辑技能')}</h2>
              <button className="ghost-button" onClick={closeEditor} disabled={editorSaving}>{tr('Close', '关闭')}</button>
            </div>
            <label>{tr('Skill name', '技能名')}</label>
            <input value={editorName} onChange={(e) => setEditorName(e.target.value)} disabled={editorReadonly || editorSaving} />
            <label>{tr('Category', '分类')}</label>
            <input value={editorCategory} onChange={(e) => setEditorCategory(e.target.value)} disabled={editorReadonly || editorSaving} />
            <label>{tr('Skill content (SKILL.md)', '技能内容（SKILL.md）')}</label>
            <textarea
              className="skill-editor-textarea"
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              disabled={editorReadonly || editorSaving}
            />
            {editorReadonly && <div className="notice-box modal-note">{tr('This skill is read-only.', '该技能为只读。')}</div>}
            {editorError && <div className="error-box modal-error">{editorError}</div>}
            <div className="button-row modal-actions">
              {!editorReadonly && (
                <button className="primary-button" disabled={editorSaving} onClick={() => void saveEditor()}>
                  {editorSaving ? tr('Saving...', '保存中...') : tr('Save', '保存')}
                </button>
              )}
              <button className="ghost-button" disabled={editorSaving} onClick={closeEditor}>{tr('Cancel', '取消')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TasksPage(props: {
  tr: TranslateFn;
  tasks: ScheduledTask[];
  refreshTasks: () => Promise<void>;
  refreshSessions: () => Promise<void>;
}): ReactElement {
  const [name, setName] = useState('Daily digest');
  const [prompt, setPrompt] = useState('Summarize today\'s important progress and blockers.');
  const [scheduleType, setScheduleType] = useState<'once' | 'interval'>('interval');
  const [runAt, setRunAt] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [executionMode, setExecutionMode] = useState<'workspace' | 'sandbox'>('sandbox');
  const [notifyByEmail, setNotifyByEmail] = useState(true);
  const [notifyByWechat, setNotifyByWechat] = useState(false);
  const [notice, setNotice] = useState('');

  async function createTask(): Promise<void> {
    await window.tasiHarness.tasks.create({
      name,
      prompt,
      scheduleType,
      runAt: scheduleType === 'once' ? new Date(runAt || Date.now()).toISOString() : undefined,
      intervalMinutes: scheduleType === 'interval' ? intervalMinutes : undefined,
      executionMode,
      notifyByEmail,
      notifyByWechat
    });
    setNotice(props.tr('Scheduled task created.', '定时任务已创建。'));
    await props.refreshTasks();
  }

  async function toggleTask(task: ScheduledTask): Promise<void> {
    await window.tasiHarness.tasks.update({ id: task.id, enabled: !task.enabled });
    await props.refreshTasks();
  }

  async function runNow(id: string): Promise<void> {
    await window.tasiHarness.tasks.runNow(id);
    setNotice(props.tr('Task executed.', '任务已执行。'));
    await Promise.all([props.refreshTasks(), props.refreshSessions()]);
  }

  async function remove(id: string): Promise<void> {
    await window.tasiHarness.tasks.delete(id);
    await props.refreshTasks();
  }

  return (
    <section className="page">
      <PageHeader title={props.tr('Scheduled Tasks', '定时任务')} subtitle={props.tr('Add tasks, run them on a timer, and send completion notifications by email or WeChat.', '添加任务，按计划运行，并通过邮件或微信发送完成通知。')} />
      <div className="split-grid">
        <div className="card">
          <h2>{props.tr('Create task', '创建任务')}</h2>
          <label>{props.tr('Name', '名称')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{props.tr('Prompt', '提示词')}</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <label>{props.tr('Schedule', '调度')}</label>
          <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value as 'once' | 'interval')}>
            <option value="interval">{props.tr('Repeat every N minutes', '每 N 分钟重复')}</option>
            <option value="once">{props.tr('Run once', '仅运行一次')}</option>
          </select>
          {scheduleType === 'once' ? (
            <>
              <label>{props.tr('Run at', '运行时间')}</label>
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </>
          ) : (
            <>
              <label>{props.tr('Interval minutes', '间隔分钟')}</label>
              <input type="number" min="1" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
            </>
          )}
          <label>{props.tr('Execution mode', '执行模式')}</label>
          <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as 'workspace' | 'sandbox')}>
            <option value="workspace">{props.tr('Workspace', '工作区')}</option>
            <option value="sandbox">{props.tr('Sandbox', '沙箱')}</option>
          </select>
          <label className="toggle-line"><input type="checkbox" checked={notifyByEmail} onChange={(e) => setNotifyByEmail(e.target.checked)} /> {props.tr('Email notification', '邮件通知')}</label>
          <label className="toggle-line"><input type="checkbox" checked={notifyByWechat} onChange={(e) => setNotifyByWechat(e.target.checked)} /> {props.tr('WeChat notification', '微信通知')}</label>
          <div className="button-row">
            <button className="primary-button" onClick={() => void createTask()}>{props.tr('Create task', '创建任务')}</button>
          </div>
          {notice && <div className="notice-box">{notice}</div>}
        </div>
        <div className="card">
          <h2>{props.tr('Task list', '任务列表')}</h2>
          <div className="task-list">
            {props.tasks.map((task) => (
              <div key={task.id} className="task-card">
                <div className="task-card-top">
                  <div>
                    <strong>{task.name}</strong>
                    <div className="card-subtle">
                      {task.scheduleType === 'interval'
                        ? props.tr(`Every ${task.intervalMinutes} minutes`, `每 ${task.intervalMinutes} 分钟`)
                        : props.tr(`Once at ${prettyDate(task.runAt)}`, `执行时间：${prettyDate(task.runAt)}`)}
                    </div>
                  </div>
                  <span className={`soft-badge ${task.enabled ? 'badge-ok' : 'badge-muted'}`}>{task.enabled ? props.tr('Enabled', '已启用') : props.tr('Paused', '已暂停')}</span>
                </div>
                <p>{task.prompt}</p>
                <div className="meta-row wrap">
                  <span className="soft-badge">{props.tr('Next', '下次')}: {prettyDate(task.nextRunAt)}</span>
                  <span className="soft-badge">{props.tr('Run in', '运行于')} {task.executionMode === 'workspace' ? props.tr('workspace', '工作区') : props.tr('sandbox', '沙箱')}</span>
                  {task.notifyByEmail && <span className="soft-badge">{props.tr('Email', '邮件')}</span>}
                  {task.notifyByWechat && <span className="soft-badge">{props.tr('WeChat', '微信')}</span>}
                  {typeof task.lastIterations === 'number' && <span className="soft-badge">{props.tr('Iterations', '迭代')} {task.lastIterations}</span>}
                  {typeof task.lastToolEventCount === 'number' && <span className="soft-badge">{props.tr('Tools', '工具')} {task.lastToolEventCount}</span>}
                </div>
                {(task.lastResult || task.lastError) && <pre className="code-block small">{task.lastError || task.lastResult}</pre>}
                {task.lastTrace && <pre className="code-block small">{task.lastTrace}</pre>}
                <div className="button-row">
                  <button className="ghost-button" disabled={task.isRunning} onClick={() => void toggleTask(task)}>{task.enabled ? props.tr('Pause', '暂停') : props.tr('Enable', '启用')}</button>
                  <button className="primary-button" disabled={task.isRunning} onClick={() => void runNow(task.id)}>{task.isRunning ? props.tr('Executing...', '执行中...') : props.tr('Run now', '立即运行')}</button>
                  <button className="danger-button" onClick={() => void remove(task.id)}>{props.tr('Delete', '删除')}</button>
                </div>
              </div>
            ))}
            {props.tasks.length === 0 && <div className="tool-empty">{props.tr('No scheduled tasks yet.', '暂无定时任务。')}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function SessionsPage({ tr, sessions, onOpen, refreshSessions }: { tr: TranslateFn; sessions: SessionSummary[]; onOpen: (id: string) => Promise<void>; refreshSessions: () => Promise<void> }): ReactElement {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<MemoryDomain | 'all'>('all');
  const categoryCounts = useMemo(() => {
    const counts = new Map<MemoryDomain | 'all', number>([['all', sessions.length]]);
    for (const session of sessions) {
      const domain = knownMemoryDomain(session.domain);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (activeCategory !== 'all' && knownMemoryDomain(s.domain) !== activeCategory) return false;
      if (!needle) return true;
      return s.title.toLowerCase().includes(needle);
    });
  }, [sessions, query, activeCategory]);

  async function remove(id: string): Promise<void> {
    await window.tasiHarness.sessions.delete(id);
    await refreshSessions();
  }

  return (
    <section className="page">
      <PageHeader title={tr('History', '历史')} subtitle={tr('Local JSON session history grouped by the same domains as memory.', '本地 JSON 会话历史，按记忆相同分类展示。')} />
      <div className="card">
        <input className="wide-input" placeholder={tr('Filter history', '筛选历史')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="memory-browser session-browser">
          <div className="memory-category-list">
            <button className={`memory-category-item ${activeCategory === 'all' ? 'active' : ''}`} onClick={() => setActiveCategory('all')}>
              <span>{tr('All', '全部')}</span>
              <span className="soft-badge">{categoryCounts.get('all') ?? 0}</span>
            </button>
            {MEMORY_DOMAINS.map((category) => (
              <button
                key={category.value}
                className={`memory-category-item ${activeCategory === category.value ? 'active' : ''}`}
                onClick={() => setActiveCategory(category.value)}
              >
                <span>{tr(category.labelEn, category.labelZh)}</span>
                <span className="soft-badge">{categoryCounts.get(category.value) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="session-list">
            {filtered.map((s) => {
              const domain = MEMORY_DOMAINS.find((item) => item.value === knownMemoryDomain(s.domain)) ?? MEMORY_DOMAINS.at(-1);
              return (
                <div className="session-card" key={s.id}>
                  <div>
                    <strong>{s.title}</strong>
                    <p>{s.messageCount} {tr('messages', '条消息')} | {prettyDate(s.updatedAt)}</p>
                    {domain && <span className="soft-badge">{tr(domain.labelEn, domain.labelZh)}</span>}
                  </div>
                  <div className="button-row compact">
                    <button className="primary-button" onClick={() => void onOpen(s.id)}>{tr('Open', '打开')}</button>
                    <button className="danger-button" onClick={() => void remove(s.id)}>{tr('Delete', '删除')}</button>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="tool-empty">
                {tr('No sessions matched this category or filter.', '没有匹配该分类或筛选条件的会话。')}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsPage({ tr, config, setConfig }: { tr: TranslateFn; config: PublicAppConfig; setConfig: (cfg: PublicAppConfig) => void }): ReactElement {
  const [draft, setDraft] = useState<SettingsDraft>({ ...config, apiKey: '', emailNotifications: { ...config.emailNotifications, password: '' } });
  const [testResult, setTestResult] = useState('');
  const [subPage, setSubPage] = useState<'model' | 'execution' | 'security' | 'channels' | 'theme' | 'markets'>('model');
  const [channelSubPage, setChannelSubPage] = useState<'email' | 'wechat'>('email');
  const [clawbotQrDataUrl, setClawbotQrDataUrl] = useState('');
  const [clawbotQrSource, setClawbotQrSource] = useState<'ilink-api' | 'manual-bind-url'>('manual-bind-url');
  const [clawbotQrKey, setClawbotQrKey] = useState('');
  const [wechatLoginStatus, setWechatLoginStatus] = useState<'idle' | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error' | 'unknown'>('idle');
  const wechatLoginPollRef = useRef<number | null>(null);
  const wechatLoginCheckingRef = useRef(false);

  useEffect(() => {
    setDraft({ ...config, apiKey: '', emailNotifications: { ...config.emailNotifications, password: '' } });
    setWechatLoginStatus(config.wechatChannel.loginStatus ?? 'idle');
  }, [config]);

  const selectedProviderPreset = providerPreset(draft.provider);
  const suggestedModels = providerModelOptions(draft.provider);

  function stopWechatLoginPolling(): void {
    if (wechatLoginPollRef.current == null) return;
    window.clearInterval(wechatLoginPollRef.current);
    wechatLoginPollRef.current = null;
    wechatLoginCheckingRef.current = false;
  }

  async function checkWechatLoginStatus(qrcodeKey: string): Promise<void> {
    if (!qrcodeKey.trim()) return;
    if (wechatLoginCheckingRef.current) return;
    wechatLoginCheckingRef.current = true;
    try {
      const status = await window.tasiHarness.config.wechatQrcodeStatus(qrcodeKey);
      setWechatLoginStatus(status.status);
      if (status.status === 'confirmed') {
        stopWechatLoginPolling();
        const next = await window.tasiHarness.config.get();
        setConfig(next);
        setTestResult(tr('WeChat channel connected. Incoming messages will sync to chat.', '微信通道已连接，手机消息会同步到对话。'));
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) return;
      setWechatLoginStatus('error');
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      wechatLoginCheckingRef.current = false;
    }
  }

  function startWechatLoginPolling(qrcodeKey: string): void {
    if (!qrcodeKey.trim()) return;
    stopWechatLoginPolling();
    void checkWechatLoginStatus(qrcodeKey);
    wechatLoginPollRef.current = window.setInterval(() => {
      void checkWechatLoginStatus(qrcodeKey);
    }, 2500);
  }

  async function refreshClawbotQrCode(): Promise<void> {
    const bindUrl = draft.wechatChannel.bindUrl.trim() || 'https://ilinkai.weixin.qq.com';
    try {
      const payload = await window.tasiHarness.config.wechatQrcode();
      const content = payload.qrcodeContent.trim() || bindUrl;
      const dataUrl = await QRCode.toDataURL(content, { width: 240, margin: 1 });
      setClawbotQrDataUrl(dataUrl);
      setClawbotQrSource(payload.source);
      setClawbotQrKey(payload.qrcodeKey ?? '');
      setWechatLoginStatus(payload.qrcodeKey ? 'wait' : 'unknown');
      if (payload.qrcodeKey) startWechatLoginPolling(payload.qrcodeKey);
      return;
    } catch {
      // fall through to local fallback
    }

    try {
      const dataUrl = await QRCode.toDataURL(bindUrl, { width: 240, margin: 1 });
      setClawbotQrDataUrl(dataUrl);
      setClawbotQrSource('manual-bind-url');
      setClawbotQrKey('');
      setWechatLoginStatus('unknown');
      stopWechatLoginPolling();
    } catch {
      setClawbotQrDataUrl('');
      setClawbotQrSource('manual-bind-url');
      setClawbotQrKey('');
      setWechatLoginStatus('error');
      stopWechatLoginPolling();
    }
  }

  useEffect(() => {
    if (subPage !== 'channels' || channelSubPage !== 'wechat') return;
    void refreshClawbotQrCode();
  }, [subPage, channelSubPage]);

  useEffect(() => () => stopWechatLoginPolling(), []);

  function applyProviderPreset(nextProvider: PublicAppConfig['provider']): void {
    const nextPreset = providerPreset(nextProvider);
    setDraft((old) => ({
      ...old,
      provider: nextProvider,
      baseUrl: nextPreset.defaultBaseUrl,
      model: providerModelOptions(nextProvider).includes(old.model) ? old.model : nextPreset.defaultModel
    }));
    setTestResult('');
  }

  async function save(): Promise<void> {
    const patch: Partial<PublicAppConfig> & { apiKey?: string; emailNotifications?: SettingsDraft['emailNotifications'] } = { ...draft };
    if (!draft.apiKey) delete patch.apiKey;
    if (patch.emailNotifications && !draft.emailNotifications.password) delete patch.emailNotifications.password;
    const next = await window.tasiHarness.config.set(patch);
    setConfig(next);
    setTestResult(tr('Settings saved.', '设置已保存。'));
  }

  async function test(): Promise<void> {
    await save();
    const result = await window.tasiHarness.config.test();
    setTestResult(`${result.ok ? 'OK' : 'FAIL'}: ${result.content}`);
  }

  return (
    <section className="page settings-page">
      <PageHeader
        title={tr('Settings', '设置')}
        subtitle={tr('Provider, channels, skill markets, security, and execution defaults.', '模型服务、通道、技能市场、安全与执行默认配置。')}
        action={
          <div className="button-row compact">
            <button className="primary-button" onClick={() => void save()}>{tr('Save', '保存')}</button>
          </div>
        }
      />
      <div className="skill-tabs">
        <button className={`skill-tab ${subPage === 'model' ? 'active' : ''}`} onClick={() => setSubPage('model')}>{tr('Model', '模型')}</button>
        <button className={`skill-tab ${subPage === 'execution' ? 'active' : ''}`} onClick={() => setSubPage('execution')}>{tr('Execution', '执行')}</button>
        <button className={`skill-tab ${subPage === 'security' ? 'active' : ''}`} onClick={() => setSubPage('security')}>{tr('Security', '安全')}</button>
        <button className={`skill-tab ${subPage === 'channels' ? 'active' : ''}`} onClick={() => setSubPage('channels')}>{tr('Channels', '通道')}</button>
        <button className={`skill-tab ${subPage === 'theme' ? 'active' : ''}`} onClick={() => setSubPage('theme')}>{tr('Theme', '主题')}</button>
        <button className={`skill-tab ${subPage === 'markets' ? 'active' : ''}`} onClick={() => setSubPage('markets')}>{tr('Skill Markets', '技能市场')}</button>
      </div>
      {subPage === 'model' && (
        <div className="card">
          <h2>{tr('Model Configuration', '模型配置')}</h2>
          <label>{tr('Provider', '服务商')}</label>
          <select value={draft.provider} onChange={(e) => applyProviderPreset(e.target.value as PublicAppConfig['provider'])}>
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.kind} value={preset.kind}>{preset.label}</option>
            ))}
          </select>
          <label>{tr('Base URL', 'Base URL')}</label>
          <input value={draft.baseUrl} onChange={(e) => setDraft((old) => ({ ...old, baseUrl: e.target.value }))} />
          <div className="card-subtle">{tr('Preset endpoint:', '预设端点：')} {selectedProviderPreset.defaultBaseUrl}</div>
          <label>API Key {config.apiKeyConfigured ? tr('(configured)', '（已配置）') : ''}</label>
          <input
            type="password"
            value={draft.apiKey || ''}
            disabled={!providerRequiresApiKey(draft.provider)}
            onChange={(e) => setDraft((old) => ({ ...old, apiKey: e.target.value }))}
            placeholder={providerRequiresApiKey(draft.provider) ? tr('leave blank to keep existing', '留空则保持不变') : tr('Not required for this provider', '该服务商不需要')}
          />
          <label>{tr('Suggested models', '推荐模型')}</label>
          <select
            value={suggestedModels.includes(draft.model) ? draft.model : ''}
            onChange={(e) => {
              if (!e.target.value) return;
              setDraft((old) => ({ ...old, model: e.target.value }));
            }}
          >
            <option value="">{tr('Custom model...', '自定义模型...')}</option>
            {suggestedModels.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
          <label>{tr('Model', '模型')}</label>
          <input value={draft.model} onChange={(e) => setDraft((old) => ({ ...old, model: e.target.value }))} />
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => setDraft((old) => ({ ...old, baseUrl: selectedProviderPreset.defaultBaseUrl, model: selectedProviderPreset.defaultModel }))}
            >
              {tr('Reset preset', '重置预设')}
            </button>
            <button className="ghost-button" onClick={() => void test()}>{tr('Save and test model', '保存并测试模型')}</button>
          </div>
        </div>
      )}
      {subPage === 'execution' && (
        <div className="card">
          <h2>{tr('Execution', '执行')}</h2>
          <label>{tr('Temperature', '温度')}</label>
          <input type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={(e) => setDraft((old) => ({ ...old, temperature: Number(e.target.value) }))} />
          <label>{tr('Max iterations', '最大迭代次数')}</label>
          <input type="number" min="1" max="100" value={draft.maxIterations} onChange={(e) => setDraft((old) => ({ ...old, maxIterations: Number(e.target.value) }))} />
          <label>{tr('Session document max docs', '对话文档最大数量')}</label>
          <input
            type="number"
            min="1"
            max="100"
            value={draft.sessionDocumentMaxDocs}
            onChange={(e) => setDraft((old) => ({ ...old, sessionDocumentMaxDocs: Number(e.target.value) }))}
          />
          <label>{tr('Workspace directory', '工作目录')}</label>
          <input value={draft.workspaceDir} onChange={(e) => setDraft((old) => ({ ...old, workspaceDir: e.target.value }))} />
          <label>{tr('Default execution mode', '默认执行模式')}</label>
          <select value={draft.defaultExecutionMode} onChange={(e) => setDraft((old) => ({ ...old, defaultExecutionMode: e.target.value as 'workspace' | 'sandbox' }))}>
            <option value="workspace">{tr('Workspace', '工作区')}</option>
            <option value="sandbox">{tr('Sandbox', '沙箱')}</option>
          </select>
          <label>{tr('Browser mode', '浏览器模式')}</label>
          <select value={draft.browserMode} onChange={(e) => setDraft((old) => ({ ...old, browserMode: e.target.value as PublicAppConfig['browserMode'] }))}>
            <option value="embedded">{tr('Built-in browser', '内置浏览器')}</option>
            <option value="external">{tr('External browser', '外部浏览器')}</option>
          </select>
          <label>{tr('External browser engine', '外部浏览器引擎')}</label>
          <select
            value={draft.externalBrowserEngine}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserEngine: e.target.value as PublicAppConfig['externalBrowserEngine'] }))}
          >
            <option value="auto">{tr('Auto (CDP first)', '自动（优先 CDP）')}</option>
            <option value="cdp">{tr('CDP only', '仅 CDP')}</option>
            <option value="webdriver-safari">{tr('Safari WebDriver only', '仅 Safari WebDriver')}</option>
          </select>
          <label>{tr('CDP endpoint', 'CDP 地址')}</label>
          <input
            value={draft.externalBrowserCdpEndpoint}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserCdpEndpoint: e.target.value }))}
            placeholder="http://127.0.0.1:9222"
          />
          <label>{tr('External browser profile', '外部浏览器配置')}</label>
          <select
            value={draft.externalBrowserProfileMode}
            onChange={(e) => setDraft((old) => ({ ...old, externalBrowserProfileMode: e.target.value as PublicAppConfig['externalBrowserProfileMode'] }))}
          >
            <option value="isolated">{tr('Isolated (safe default)', '隔离模式（默认更安全）')}</option>
            <option value="system">{tr('System profile (reuse login)', '系统配置（复用登录态）')}</option>
          </select>
          <label className="toggle-line"><input type="checkbox" checked={draft.browserHeadless} onChange={(e) => setDraft((old) => ({ ...old, browserHeadless: e.target.checked }))} /> {tr('Run external CDP browser headless', '以无头模式运行外部 CDP 浏览器')}</label>
          <label>{tr('Persona', '系统角色提示词')}</label>
          <textarea value={draft.systemPersona} onChange={(e) => setDraft((old) => ({ ...old, systemPersona: e.target.value }))} />
        </div>
      )}
      {subPage === 'security' && (
        <div className="card">
          <h2>{tr('Security', '安全')}</h2>
          <label className="toggle-line"><input type="checkbox" checked={draft.allowShellTools} onChange={(e) => setDraft((old) => ({ ...old, allowShellTools: e.target.checked }))} /> {tr('Enable terminal tool', '启用终端工具')}</label>
          <label className="toggle-line"><input type="checkbox" checked={draft.enableNetworkTools} onChange={(e) => setDraft((old) => ({ ...old, enableNetworkTools: e.target.checked }))} /> {tr('Enable network tools', '启用网络工具')}</label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.safetyApproval.enabled}
              onChange={(e) => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, enabled: e.target.checked } }))}
            />
            {tr('Enable safety approval', '启用安全审批')}
          </label>
          <label className="toggle-line">
            <input
              type="checkbox"
              checked={draft.safetyApproval.approveRiskyTerminalCommands}
              onChange={(e) => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, approveRiskyTerminalCommands: e.target.checked } }))}
            />
            {tr('Approve risky terminal commands', '风险终端命令需要审批')}
          </label>
          <label>{tr('Approval timeout seconds', '审批超时秒数')}</label>
          <input
            type="number"
            min="5"
            max="300"
            value={Math.round(draft.safetyApproval.timeoutMs / 1000)}
            onChange={(e) => setDraft((old) => ({
              ...old,
              safetyApproval: {
                ...old.safetyApproval,
                timeoutMs: Math.max(5, Math.min(300, Number(e.target.value) || 60)) * 1000
              }
            }))}
          />
          <div className="card-subtle">
            {tr(
              'Rules: workspace deletes require approval; outside-workspace reads, writes, and deletes require approval; low-risk terminal commands do not.',
              '规则：工作区内仅删除需要审批；工作区外读取、写入、删除需要审批；低风险终端命令不需要审批。'
            )}
          </div>
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => setDraft((old) => ({ ...old, safetyApproval: { ...old.safetyApproval, neverAskAgainKeys: [] } }))}
              disabled={draft.safetyApproval.neverAskAgainKeys.length === 0}
            >
              {tr('Clear remembered approvals', '清空不再审批记录')}
            </button>
            <span className="soft-badge">{tr('Remembered', '已记住')} {draft.safetyApproval.neverAskAgainKeys.length}</span>
          </div>
        </div>
      )}
      {subPage === 'channels' && (
        <div className="card">
          <h2>{tr('Channels', '通道')}</h2>
          <div className="skill-tabs channel-tabs">
            <button className={`skill-tab ${channelSubPage === 'email' ? 'active' : ''}`} onClick={() => setChannelSubPage('email')}>{tr('Email', '邮件')}</button>
            <button className={`skill-tab ${channelSubPage === 'wechat' ? 'active' : ''}`} onClick={() => setChannelSubPage('wechat')}>{tr('WeChat', '微信')}</button>
          </div>
          {channelSubPage === 'email' && (
            <div className="channel-pane">
              <label className="toggle-line"><input type="checkbox" checked={draft.emailNotifications.enabled} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, enabled: e.target.checked } }))} /> {tr('Enable email notifications', '启用邮件通知')}</label>
              <label>{tr('Email host', '邮件服务器')}</label>
              <input value={draft.emailNotifications.host} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, host: e.target.value } }))} />
              <label>{tr('Email port', '邮件端口')}</label>
              <input type="number" value={draft.emailNotifications.port} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, port: Number(e.target.value) } }))} />
              <label>{tr('Email username', '邮件用户名')}</label>
              <input value={draft.emailNotifications.username} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, username: e.target.value } }))} />
              <label>{tr('Email password', '邮件密码')} {config.emailNotifications.passwordConfigured ? tr('(configured)', '（已配置）') : ''}</label>
              <input type="password" value={draft.emailNotifications.password || ''} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, password: e.target.value } }))} placeholder={tr('leave blank to keep existing', '留空则保持不变')} />
              <label>{tr('From address', '发件地址')}</label>
              <input value={draft.emailNotifications.from} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, from: e.target.value } }))} />
              <label>{tr('To address', '收件地址')}</label>
              <input value={draft.emailNotifications.to} onChange={(e) => setDraft((old) => ({ ...old, emailNotifications: { ...old.emailNotifications, to: e.target.value } }))} />
            </div>
          )}
          {channelSubPage === 'wechat' && (
            <div className="channel-pane">
              <label className="toggle-line">
                <input
                  type="checkbox"
                  checked={draft.wechatChannel.enabled}
                  onChange={(e) => setDraft((old) => ({ ...old, wechatChannel: { ...old.wechatChannel, enabled: e.target.checked } }))}
                />
                {tr('Enable WeChat channel', '启用微信通道')}
              </label>
              <label>{tr('Plugin', '插件')}</label>
              <input value={draft.wechatChannel.pluginName} readOnly />
              <div className="card-subtle">{tr('WeChat channel uses the clawbot plugin.', '微信通道使用 clawbot 插件。')}</div>
              <label>{tr('ClawBot bind URL', 'ClawBot 绑定地址')}</label>
              <input
                value={draft.wechatChannel.bindUrl}
                onChange={(e) => setDraft((old) => ({ ...old, wechatChannel: { ...old.wechatChannel, bindUrl: e.target.value } }))}
                placeholder="https://ilinkai.weixin.qq.com"
              />
              <div className="channel-qr-wrap">
                {clawbotQrDataUrl
                  ? <img className="channel-qr-image" src={clawbotQrDataUrl} alt={tr('ClawBot QR Code', 'ClawBot 二维码')} />
                  : <div className="card-subtle">{tr('QR code failed to load.', '二维码加载失败。')}</div>}
                <div className="channel-qr-meta">
                  <strong>{tr('ClawBot QR', 'ClawBot 二维码')}</strong>
                  <p>{tr('Scan this QR code with WeChat to bind the clawbot plugin channel.', '请使用微信扫码绑定 clawbot 插件通道。')}</p>
                  <p className="card-subtle">
                    {tr('Login status:', '登录状态：')} {wechatLoginStatus}
                  </p>
                  <p className="card-subtle">
                    {clawbotQrSource === 'ilink-api'
                      ? tr('Source: iLink dynamic login QR (recommended).', '来源：iLink 动态登录二维码（推荐）。')
                      : tr('Source: manual bind URL fallback.', '来源：手动绑定链接回退。')}
                  </p>
                  <button className="ghost-button channel-open-link" onClick={() => void checkWechatLoginStatus(clawbotQrKey)} disabled={!clawbotQrKey}>
                    {tr('Check login status', '检查登录状态')}
                  </button>
                  <button className="ghost-button channel-open-link" onClick={() => void refreshClawbotQrCode()}>
                    {tr('Refresh QR code', '刷新二维码')}
                  </button>
                  <a className="ghost-button channel-open-link" href={draft.wechatChannel.bindUrl.trim() || 'https://ilinkai.weixin.qq.com'} target="_blank" rel="noreferrer">
                    {tr('Open bind URL', '打开绑定链接')}
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {subPage === 'theme' && (
        <div className="card">
          <h2>{tr('Theme', '主题')}</h2>
          <label>{tr('Theme', '主题')}</label>
          <select value={draft.theme} onChange={(e) => setDraft((old) => ({ ...old, theme: e.target.value as PublicAppConfig['theme'] }))}>
            <option value="dark">{tr('Dark', '深色')}</option>
            <option value="light">{tr('Light', '浅色')}</option>
          </select>
        </div>
      )}
      {subPage === 'markets' && (
        <div className="card">
          <h2>{tr('Skill Markets', '技能市场')}</h2>
          <div className="task-list">
            {draft.skillMarketSources.map((source) => (
              <div key={source.id} className="task-card">
                <div className="task-card-top">
                  <div>
                    <strong>{source.name}</strong>
                    <div className="card-subtle">{source.id}</div>
                  </div>
                  <label className="toggle-line">
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={(e) => {
                        setDraft((old) => ({
                          ...old,
                          skillMarketSources: old.skillMarketSources.map((item) => item.id === source.id ? { ...item, enabled: e.target.checked } : item)
                        }));
                      }}
                    />
                    {tr('Enabled', '启用')}
                  </label>
                </div>
                <p>{source.description}</p>
                <label>{tr('Catalog URL', '目录地址')}</label>
                <input
                  value={source.catalogUrl || ''}
                  onChange={(e) => {
                    setDraft((old) => ({
                      ...old,
                      skillMarketSources: old.skillMarketSources.map((item) => item.id === source.id ? { ...item, catalogUrl: e.target.value } : item)
                    }));
                  }}
                  placeholder={tr('optional remote catalog URL', '可选的远程目录 URL')}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {testResult && <div className="notice-box">{testResult}</div>}
    </section>
  );
}

function AboutPage({ tr, info }: { tr: TranslateFn; info: AppInfo | null }): ReactElement {
  return (
    <section className="page">
      <PageHeader title={tr('About', '关于')} subtitle={tr('A TypeScript Electron agent desktop app with local memory, skill markets, scheduled tasks, and sandboxed runs.', '基于 TypeScript 与 Electron 的桌面智能体应用，支持本地记忆、技能市场、定时任务与沙箱执行。')} />
      <div className="about-card">
        <div className="about-logo">TH</div>
        <div>
          <h2>Tasi Harness</h2>
          <p>{tr('Agent loop | tool registry | skill marketplace | scheduled tasks | email notifications | sandbox execution.', '智能体循环 | 工具注册 | 技能市场 | 定时任务 | 邮件通知 | 沙箱执行')}</p>
          <p>{tr(`Version: ${info?.version ?? 'unknown'}`, `版本：${info?.version ?? '未知'}`)}</p>
        </div>
      </div>
    </section>
  );
}
