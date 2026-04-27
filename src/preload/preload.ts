import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentToolEventStream,
  MemoryClearRequest,
  MemoryQueryOptions,
  PersonalKnowledgeUploadRequest,
  PublicAppConfig,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SkillPatchRequest,
  SkillWriteRequest,
  ToolRunRequest
} from '../shared/types.js';

const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<PublicAppConfig>,
    set: (partial: Partial<PublicAppConfig> & { apiKey?: string; emailNotifications?: PublicAppConfig['emailNotifications'] & { password?: string } }) => ipcRenderer.invoke('config:set', partial) as Promise<PublicAppConfig>,
    test: () => ipcRenderer.invoke('config:test')
  },
  agent: {
    chat: (input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean) =>
      ipcRenderer.invoke('agent:chat', input, sessionId, executionMode, usePersonalKnowledgeBase),
    stop: () => ipcRenderer.invoke('agent:stop'),
    onToolEvent: (listener: (payload: AgentToolEventStream) => void) => {
      const channel = 'agent:tool-event';
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentToolEventStream) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    read: (id: string) => ipcRenderer.invoke('sessions:read', id),
    delete: (id: string) => ipcRenderer.invoke('sessions:delete', id),
    rename: (id: string, title: string) => ipcRenderer.invoke('sessions:rename', id, title),
    search: (query: string) => ipcRenderer.invoke('sessions:search', query)
  },
  memory: {
    get: (query?: MemoryQueryOptions) => ipcRenderer.invoke('memory:get', query),
    clear: (request: MemoryClearRequest) => ipcRenderer.invoke('memory:clear', request)
  },
  knowledge: {
    list: () => ipcRenderer.invoke('knowledge:list'),
    addDocument: (req: PersonalKnowledgeUploadRequest) => ipcRenderer.invoke('knowledge:addDocument', req),
    deleteDocument: (id: string) => ipcRenderer.invoke('knowledge:deleteDocument', id)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    read: (name: string) => ipcRenderer.invoke('skills:read', name),
    create: (req: SkillWriteRequest) => ipcRenderer.invoke('skills:create', req),
    patch: (req: SkillPatchRequest) => ipcRenderer.invoke('skills:patch', req),
    delete: (name: string) => ipcRenderer.invoke('skills:delete', name),
    uploadArchive: (req: SkillArchiveUploadRequest) => ipcRenderer.invoke('skills:uploadArchive', req),
    browseMarketplace: (query?: string) => ipcRenderer.invoke('skills:market:browse', query),
    installFromMarketplace: (req: SkillInstallRequest) => ipcRenderer.invoke('skills:market:install', req),
    uninstallMarketplaceSkill: (name: string) => ipcRenderer.invoke('skills:market:uninstall', name)
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
    openPath: (path: string) => ipcRenderer.invoke('app:openPath', path),
    openExternalUrl: (url: string) => ipcRenderer.invoke('app:openExternalUrl', url),
    closeExternalPreview: () => ipcRenderer.invoke('app:closeExternalPreview'),
    setEmbeddedPreviewWebContentsId: (id: number | null) => ipcRenderer.invoke('app:setEmbeddedPreviewWebContentsId', id)
  }
};

contextBridge.exposeInMainWorld('tasiHarness', api);
