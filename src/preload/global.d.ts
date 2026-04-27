import type {
  AgentToolEventStream,
  AgentRunResult,
  AppInfo,
  MemoryClearRequest,
  MemoryQueryOptions,
  MemoryState,
  PersonalKnowledgeDocument,
  PersonalKnowledgeState,
  PersonalKnowledgeUploadRequest,
  MarketplaceBrowseResult,
  MarketplaceSkill,
  PublicAppConfig,
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SessionRecord,
  SessionSummary,
  SkillDocument,
  SkillMetadata,
  SkillPatchRequest,
  SkillWriteRequest,
  ToolDefinition,
  ToolExecutionResult,
  ToolRunRequest
} from '../shared/types';

declare global {
  interface Window {
    tasiHarness: {
      config: {
        get(): Promise<PublicAppConfig>;
        set(partial: Partial<PublicAppConfig> & { apiKey?: string; emailNotifications?: PublicAppConfig['emailNotifications'] & { password?: string } }): Promise<PublicAppConfig>;
        test(): Promise<ToolExecutionResult>;
      };
      agent: {
        chat(input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean): Promise<AgentRunResult>;
        stop(): Promise<ToolExecutionResult>;
        onToolEvent(listener: (payload: AgentToolEventStream) => void): () => void;
      };
      sessions: {
        list(): Promise<SessionSummary[]>;
        read(id: string): Promise<SessionRecord | null>;
        delete(id: string): Promise<boolean>;
        rename(id: string, title: string): Promise<SessionSummary>;
        search(query: string): Promise<SessionSummary[]>;
      };
      memory: {
        get(query?: MemoryQueryOptions): Promise<MemoryState>;
        clear(request: MemoryClearRequest): Promise<MemoryState>;
      };
      knowledge: {
        list(): Promise<PersonalKnowledgeState>;
        addDocument(req: PersonalKnowledgeUploadRequest): Promise<PersonalKnowledgeDocument>;
        deleteDocument(id: string): Promise<boolean>;
      };
      skills: {
        list(): Promise<SkillMetadata[]>;
        read(name: string): Promise<SkillDocument | null>;
        create(req: SkillWriteRequest): Promise<SkillDocument>;
        patch(req: SkillPatchRequest): Promise<SkillDocument>;
        delete(name: string): Promise<boolean>;
        uploadArchive(req: SkillArchiveUploadRequest): Promise<SkillDocument>;
        browseMarketplace(query?: string): Promise<MarketplaceBrowseResult>;
        installFromMarketplace(req: SkillInstallRequest): Promise<MarketplaceSkill>;
        uninstallMarketplaceSkill(name: string): Promise<boolean>;
      };
      tasks: {
        list(): Promise<ScheduledTask[]>;
        create(req: ScheduledTaskCreateRequest): Promise<ScheduledTask>;
        update(req: ScheduledTaskPatchRequest): Promise<ScheduledTask>;
        delete(id: string): Promise<boolean>;
        runNow(id: string): Promise<AgentRunResult>;
      };
      tools: {
        list(): Promise<ToolDefinition[]>;
        run(req: ToolRunRequest): Promise<ToolExecutionResult>;
      };
      app: {
        info(): Promise<AppInfo>;
        openPath(path: string): Promise<ToolExecutionResult>;
        openExternalUrl(url: string): Promise<ToolExecutionResult>;
        closeExternalPreview(): Promise<ToolExecutionResult>;
        setEmbeddedPreviewWebContentsId(id: number | null): Promise<ToolExecutionResult>;
      };
    };
  }
}
export {};
