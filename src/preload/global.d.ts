import type {
  AgentToolEventStream,
  AgentMessageDeltaStream,
  AgentMessageAttachment,
  AgentRunResult,
  AppInfo,
  AssistantMessageExportRequest,
  BrowserCoachGenerateSkillRequest,
  BrowserCoachGenerateSkillResult,
  BrowserCoachRecording,
  BrowserCoachStartRequest,
  BrowserCoachStoredRecording,
  ExternalSessionMessageRequest,
  LiveAgentTask,
  LiveAgentTaskCreateRequest,
  LiveAgentTaskUpdateEvent,
  LiveSessionAppendMessageRequest,
  LiveSessionCreateResult,
  LiveSessionRelation,
  LiveRealtimeClientEvent,
  LiveRealtimeEvent,
  LiveRealtimeStartRequest,
  LiveRealtimeStartResult,
  MemoryClearRequest,
  MemoryQueryOptions,
  MemoryState,
  PersonalKnowledgeDocument,
  PersonalKnowledgeFolderImportResult,
  PersonalKnowledgeState,
  PersonalKnowledgeUploadRequest,
  MarketplaceBrowseResult,
  MarketplaceSkill,
  PublicAppConfig,
  ScheduledTask,
  ScheduledTaskCreateRequest,
  ScheduledTaskPatchRequest,
  SessionDocumentContext,
  SessionDocumentUploadRequest,
  SessionDocumentUploadResult,
  SessionMessageContentRequest,
  SessionMessageContentResult,
  SkillArchiveUploadRequest,
  SkillInstallRequest,
  SessionRecord,
  SessionSummary,
  SessionToolEventContentRequest,
  SessionToolEventContentResult,
  SessionUpdateEvent,
  SkillDocument,
  SkillMetadata,
  SkillOptimizationRunRequest,
  SkillPatchRequest,
  ToolApprovalDecision,
  ToolApprovalRequest,
  DreamSkinGalleryQuery,
  DreamSkinGalleryResult,
  DreamSkinThemeInstallRequest,
  WechatChannelQrCodePayload,
  WechatChannelLoginStatusPayload,
  SkillWriteRequest,
  ToolDefinition,
  ToolExecutionResult,
  ToolRunRequest,
  ThemeImportRequest
} from '../shared/types';

declare global {
  interface Window {
    tasiHarness: {
      config: {
        get(): Promise<PublicAppConfig>;
        set(partial: Partial<PublicAppConfig> & { apiKey?: string; omniApiKey?: string; emailNotifications?: PublicAppConfig['emailNotifications'] & { password?: string } }): Promise<PublicAppConfig>;
        test(profile?: 'agent' | 'omni'): Promise<ToolExecutionResult>;
        wechatQrcode(): Promise<WechatChannelQrCodePayload>;
        wechatQrcodeStatus(qrcodeKey: string): Promise<WechatChannelLoginStatusPayload>;
      };
      themes: {
        importPackage(req: ThemeImportRequest): Promise<PublicAppConfig>;
        listDreamSkinGallery(req?: DreamSkinGalleryQuery): Promise<DreamSkinGalleryResult>;
        installDreamSkinTheme(req: DreamSkinThemeInstallRequest): Promise<PublicAppConfig>;
      };
      agent: {
        chat(input: string, sessionId?: string, executionMode?: 'workspace' | 'sandbox', usePersonalKnowledgeBase?: boolean, attachments?: AgentMessageAttachment[]): Promise<AgentRunResult>;
        optimizeSkills(req: SkillOptimizationRunRequest): Promise<AgentRunResult>;
        stop(): Promise<ToolExecutionResult>;
        onToolEvent(listener: (payload: AgentToolEventStream) => void): () => void;
        onMessageDelta(listener: (payload: AgentMessageDeltaStream) => void): () => void;
      };
      liveRealtime: {
        start(req?: LiveRealtimeStartRequest): Promise<LiveRealtimeStartResult>;
        send(event: LiveRealtimeClientEvent): Promise<ToolExecutionResult>;
        stop(): Promise<ToolExecutionResult>;
        onEvent(listener: (payload: LiveRealtimeEvent) => void): () => void;
      };
      liveTasks: {
        list(sessionId?: string): Promise<LiveAgentTask[]>;
        enqueue(req: LiveAgentTaskCreateRequest): Promise<LiveAgentTask>;
        stop(taskId: string): Promise<LiveAgentTask | null>;
        onUpdated(listener: (payload: LiveAgentTaskUpdateEvent) => void): () => void;
      };
      liveSessions: {
        create(): Promise<LiveSessionCreateResult>;
        read(sessionId: string): Promise<LiveSessionRelation | null>;
        appendMessage(req: LiveSessionAppendMessageRequest): Promise<SessionRecord>;
      };
      security: {
        onToolApprovalRequest(listener: (payload: ToolApprovalRequest) => void): () => void;
        resolveToolApproval(decision: ToolApprovalDecision): Promise<ToolApprovalDecision>;
      };
      sessions: {
        list(): Promise<SessionSummary[]>;
        read(id: string): Promise<SessionRecord | null>;
        readForDisplay(id: string): Promise<SessionRecord | null>;
        readMessageContent(req: SessionMessageContentRequest): Promise<SessionMessageContentResult>;
        readToolEventContent(req: SessionToolEventContentRequest): Promise<SessionToolEventContentResult>;
        delete(id: string): Promise<boolean>;
        rename(id: string, title: string): Promise<SessionSummary>;
        search(query: string): Promise<SessionSummary[]>;
        appendExternalMessage(req: ExternalSessionMessageRequest): Promise<SessionRecord>;
        onUpdated(listener: (payload: SessionUpdateEvent) => void): () => void;
      };
      memory: {
        get(query?: MemoryQueryOptions): Promise<MemoryState>;
        clear(request: MemoryClearRequest): Promise<MemoryState>;
      };
      knowledge: {
        list(): Promise<PersonalKnowledgeState>;
        addDocument(req: PersonalKnowledgeUploadRequest): Promise<PersonalKnowledgeDocument>;
        addFolder(): Promise<PersonalKnowledgeFolderImportResult>;
        deleteDocument(id: string): Promise<boolean>;
      };
      sessionDocs: {
        list(sessionId: string): Promise<SessionDocumentContext[]>;
        upload(req: SessionDocumentUploadRequest): Promise<SessionDocumentUploadResult>;
        deleteDocument(sessionId: string, id: string): Promise<boolean>;
      };
      skills: {
        list(): Promise<SkillMetadata[]>;
        read(name: string): Promise<SkillDocument | null>;
        create(req: SkillWriteRequest): Promise<SkillDocument>;
        patch(req: SkillPatchRequest): Promise<SkillDocument>;
        delete(name: string): Promise<boolean>;
        installBundled(name: string, overwrite?: boolean): Promise<SkillDocument>;
        uploadArchive(req: SkillArchiveUploadRequest): Promise<SkillDocument>;
        browseMarketplace(query?: string): Promise<MarketplaceBrowseResult>;
        installFromMarketplace(req: SkillInstallRequest): Promise<MarketplaceSkill>;
        uninstallMarketplaceSkill(name: string): Promise<boolean>;
      };
      browserCoach: {
        start(req?: BrowserCoachStartRequest): Promise<BrowserCoachRecording>;
        stop(): Promise<BrowserCoachRecording>;
        status(): Promise<BrowserCoachRecording>;
        clear(): Promise<BrowserCoachRecording>;
        listRecordings(): Promise<BrowserCoachStoredRecording[]>;
        loadRecording(skillName: string): Promise<BrowserCoachRecording | null>;
        deleteRecording(recordingId: string): Promise<boolean>;
        generateSkill(req: BrowserCoachGenerateSkillRequest): Promise<BrowserCoachGenerateSkillResult>;
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
        selectBrandLogo(): Promise<string>;
        exportAssistantMessage(req: AssistantMessageExportRequest): Promise<ToolExecutionResult>;
        openPath(path: string): Promise<ToolExecutionResult>;
        openExternalUrl(url: string, options?: { system?: boolean }): Promise<ToolExecutionResult>;
        closeExternalPreview(): Promise<ToolExecutionResult>;
        setEmbeddedPreviewWebContentsId(id: number | null): Promise<ToolExecutionResult>;
        setWindowTitleBarTheme(preview?: Pick<PublicAppConfig, 'theme' | 'customThemes' | 'textColor'> | null): Promise<boolean>;
        windowMinimize(): Promise<boolean>;
        windowToggleMaximize(): Promise<boolean>;
        windowClose(): Promise<boolean>;
      };
    };
  }
}
export {};
