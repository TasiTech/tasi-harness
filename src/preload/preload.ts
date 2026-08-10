import { createRequire } from 'node:module';
import type {
  AgentToolEventStream,
  AgentMessageDeltaStream,
  AgentMessageAttachment,
  AssistantMessageExportRequest,
  BrowserCoachGenerateSkillRequest,
  BrowserCoachGenerateSkillResult,
  BrowserCoachRecording,
  BrowserCoachStartRequest,
  BrowserCoachStoredRecording,
  ExternalSessionMessageRequest,
  LiveAgentTaskCreateRequest,
  LiveAgentTaskUpdateEvent,
  LiveSessionAppendMessageRequest,
  LiveRealtimeClientEvent,
  LiveRealtimeEvent,
  LiveRealtimeStartRequest,
  MemoryClearRequest,
  MemoryQueryOptions,
  PersonalKnowledgeFolderImportResult,
  PersonalKnowledgeUploadRequest,
  PublicAppConfig,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SessionDocumentUploadRequest,
  SessionMessageContentRequest,
  SessionToolEventContentRequest,
  SkillOptimizationRunRequest,
  SessionUpdateEvent,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SkillPatchRequest,
  SkillWriteRequest,
  DreamSkinGalleryQuery,
  DreamSkinGalleryResult,
  DreamSkinThemeInstallRequest,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ThemeImportRequest,
  WechatChannelQrCodePayload,
  WechatChannelLoginStatusPayload,
  ToolRunRequest
} from '../shared/types.js';

const electronRequire = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = electronRequire('electron/renderer') as typeof import('electron/renderer');

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<PublicAppConfig>,
    set: (partial: Partial<PublicAppConfig> & { apiKey?: string; omniApiKey?: string; emailNotifications?: PublicAppConfig['emailNotifications'] & { password?: string } }) => ipcRenderer.invoke('config:set', partial) as Promise<PublicAppConfig>,
    test: (profile?: 'agent' | 'omni') => ipcRenderer.invoke('config:test', profile),
    wechatQrcode: () => ipcRenderer.invoke('config:wechatQrcode') as Promise<WechatChannelQrCodePayload>,
    wechatQrcodeStatus: (qrcodeKey: string) => ipcRenderer.invoke('config:wechatQrcodeStatus', qrcodeKey) as Promise<WechatChannelLoginStatusPayload>
  },
  themes: {
    importPackage: (req: ThemeImportRequest) => ipcRenderer.invoke('themes:import', req),
    listDreamSkinGallery: (req?: DreamSkinGalleryQuery) => ipcRenderer.invoke('themes:dreamskin:list', req) as Promise<DreamSkinGalleryResult>,
    installDreamSkinTheme: (req: DreamSkinThemeInstallRequest) => ipcRenderer.invoke('themes:dreamskin:install', req) as Promise<PublicAppConfig>
  },
  agent: {
    chat: (input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean, attachments?: AgentMessageAttachment[]) =>
      ipcRenderer.invoke('agent:chat', input, sessionId, executionMode, usePersonalKnowledgeBase, attachments),
    optimizeSkills: (req: SkillOptimizationRunRequest) => ipcRenderer.invoke('agent:optimizeSkills', req),
    stop: () => ipcRenderer.invoke('agent:stop'),
    onToolEvent: (listener: (payload: AgentToolEventStream) => void) => {
      const channel = 'agent:tool-event';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentToolEventStream) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    onMessageDelta: (listener: (payload: AgentMessageDeltaStream) => void) => {
      const channel = 'agent:message-delta';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentMessageDeltaStream) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  liveRealtime: {
    start: (req?: LiveRealtimeStartRequest) => ipcRenderer.invoke('liveRealtime:start', req),
    send: (event: LiveRealtimeClientEvent) => ipcRenderer.invoke('liveRealtime:send', event),
    stop: () => ipcRenderer.invoke('liveRealtime:stop'),
    onEvent: (listener: (payload: LiveRealtimeEvent) => void) => {
      const channel = 'live-realtime:event';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: LiveRealtimeEvent) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  liveTasks: {
    list: (sessionId?: string) => ipcRenderer.invoke('liveTasks:list', sessionId),
    enqueue: (req: LiveAgentTaskCreateRequest) => ipcRenderer.invoke('liveTasks:enqueue', req),
    stop: (taskId: string) => ipcRenderer.invoke('liveTasks:stop', taskId),
    onUpdated: (listener: (payload: LiveAgentTaskUpdateEvent) => void) => {
      const channel = 'live-tasks:updated';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: LiveAgentTaskUpdateEvent) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  liveSessions: {
    create: () => ipcRenderer.invoke('liveSessions:create'),
    read: (sessionId: string) => ipcRenderer.invoke('liveSessions:read', sessionId),
    appendMessage: (req: LiveSessionAppendMessageRequest) => ipcRenderer.invoke('liveSessions:appendMessage', req)
  },
  security: {
    onToolApprovalRequest: (listener: (payload: ToolApprovalRequest) => void) => {
      const channel = 'tool-approval:request';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: ToolApprovalRequest) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
    resolveToolApproval: (decision: ToolApprovalDecision) => ipcRenderer.invoke('tool-approval:decision', decision) as Promise<ToolApprovalDecision>
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    read: (id: string) => ipcRenderer.invoke('sessions:read', id),
    readForDisplay: (id: string) => ipcRenderer.invoke('sessions:readForDisplay', id),
    readMessageContent: (req: SessionMessageContentRequest) => ipcRenderer.invoke('sessions:readMessageContent', req),
    readToolEventContent: (req: SessionToolEventContentRequest) => ipcRenderer.invoke('sessions:readToolEventContent', req),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    search: (query: string) => ipcRenderer.invoke('sessions:search', query),
    appendExternalMessage: (req: ExternalSessionMessageRequest) => ipcRenderer.invoke('sessions:appendExternalMessage', req),
    onUpdated: (listener: (payload: SessionUpdateEvent) => void) => {
      const channel = 'sessions:updated';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: SessionUpdateEvent) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  memory: {
    get: (query?: MemoryQueryOptions) => ipcRenderer.invoke('memory:get', query),
    clear: (request: MemoryClearRequest) => ipcRenderer.invoke('memory:clear', request)
  },
  knowledge: {
    list: () => ipcRenderer.invoke('knowledge:list'),
    addDocument: (req: PersonalKnowledgeUploadRequest) => ipcRenderer.invoke('knowledge:addDocument', req),
    addFolder: () => ipcRenderer.invoke('knowledge:addFolder') as Promise<PersonalKnowledgeFolderImportResult>,
    deleteDocument: (id: string) => ipcRenderer.invoke('knowledge:deleteDocument', id)
  },
  sessionDocs: {
    list: (sessionId: string) => ipcRenderer.invoke('session-docs:list', sessionId),
    upload: (req: SessionDocumentUploadRequest) => ipcRenderer.invoke('session-docs:upload', req),
    deleteDocument: (sessionId: string, id: string) => ipcRenderer.invoke('session-docs:delete', sessionId, id)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    read: (name: string) => ipcRenderer.invoke('skills:read', name),
    create: (req: SkillWriteRequest) => ipcRenderer.invoke('skills:create', req),
    patch: (req: SkillPatchRequest) => ipcRenderer.invoke('skills:patch', req),
    delete: (name: string) => ipcRenderer.invoke('skills:delete', name),
    installBundled: (name: string, overwrite?: boolean) => ipcRenderer.invoke('skills:installBundled', name, overwrite),
    uploadArchive: (req: SkillArchiveUploadRequest) => ipcRenderer.invoke('skills:uploadArchive', req),
    browseMarketplace: (query?: string) => ipcRenderer.invoke('skills:market:browse', query),
    installFromMarketplace: (req: SkillInstallRequest) => ipcRenderer.invoke('skills:market:install', req),
    uninstallMarketplaceSkill: (name: string) => ipcRenderer.invoke('skills:market:uninstall', name)
  },
  browserCoach: {
    start: (req?: BrowserCoachStartRequest) => ipcRenderer.invoke('browser-coach:start', req) as Promise<BrowserCoachRecording>,
    stop: () => ipcRenderer.invoke('browser-coach:stop') as Promise<BrowserCoachRecording>,
    status: () => ipcRenderer.invoke('browser-coach:status') as Promise<BrowserCoachRecording>,
    clear: () => ipcRenderer.invoke('browser-coach:clear') as Promise<BrowserCoachRecording>,
    listRecordings: () => ipcRenderer.invoke('browser-coach:listRecordings') as Promise<BrowserCoachStoredRecording[]>,
    loadRecording: (skillName: string) => ipcRenderer.invoke('browser-coach:loadRecording', skillName) as Promise<BrowserCoachRecording | null>,
    deleteRecording: (recordingId: string) => ipcRenderer.invoke('browser-coach:deleteRecording', recordingId) as Promise<boolean>,
    generateSkill: (req: BrowserCoachGenerateSkillRequest) => ipcRenderer.invoke('browser-coach:generateSkill', req) as Promise<BrowserCoachGenerateSkillResult>
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (req: ScheduledTaskCreateRequest) => ipcRenderer.invoke('tasks:create', req),
    update: (req: ScheduledTaskPatchRequest) => ipcRenderer.invoke('tasks:update', req),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    runNow: (id: string) => ipcRenderer.invoke('tasks:runNow', id)
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    run: (req: ToolRunRequest) => ipcRenderer.invoke('tools:run', req)
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    selectBrandLogo: () => ipcRenderer.invoke('app:selectBrandLogo') as Promise<string>,
    exportAssistantMessage: (req: AssistantMessageExportRequest) => ipcRenderer.invoke('app:exportAssistantMessage', req),
    openPath: (path: string) => ipcRenderer.invoke('app:openPath', path),
    openExternalUrl: (url: string, options?: { system?: boolean }) => ipcRenderer.invoke('app:openExternalUrl', url, options),
    closeExternalPreview: () => ipcRenderer.invoke('app:closeExternalPreview'),
    setEmbeddedPreviewWebContentsId: (id: number | null) => ipcRenderer.invoke('app:setEmbeddedPreviewWebContentsId', id),
    setWindowTitleBarTheme: (preview?: Pick<PublicAppConfig, 'theme' | 'customThemes' | 'textColor'> | null) => ipcRenderer.invoke('app:setWindowTitleBarTheme', preview) as Promise<boolean>,
    windowMinimize: () => ipcRenderer.invoke('app:windowMinimize') as Promise<boolean>,
    windowToggleMaximize: () => ipcRenderer.invoke('app:windowToggleMaximize') as Promise<boolean>,
    windowClose: () => ipcRenderer.invoke('app:windowClose') as Promise<boolean>
  }
};

contextBridge.exposeInMainWorld('tasiHarness', api);
