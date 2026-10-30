import { type CaseTraceRecord, type ClearMemoryScope, type ClearMemoryResult, type DreamRunResult, type DreamRollbackResult, type HeartbeatStats, HeartbeatIndexer, type IndexingSettings, LlmMemoryExtractor, type MemoryActionRequest, type MemoryActionResult, type MemoryExportBundle, type MemoryImportResult, type MemoryImportableBundle, type MemoryMaintenanceMode, type MemoryMessage, type MemoryRecordType, type PresentationMemorySnapshot, type MemoryUiSnapshot, MemoryRepository, type RetrievalResult, ReasoningRetriever } from "./core/index.js";
import { type TranscriptMessageInfo } from "./message-utils.js";
type LoggerLike = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
export type EdgeClawMemoryApiType = "openai-responses" | "responses" | "openai-completions" | "anthropic" | "google";
export interface EdgeClawMemoryLlmOptions {
    provider?: string;
    model?: string;
    modelRef?: string;
    apiType?: EdgeClawMemoryApiType;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
}
export interface EdgeClawMemoryServiceOptions {
    workspaceDir: string;
    rootDir?: string;
    dbPath?: string;
    memoryDir?: string;
    captureStrategy?: "last_turn" | "full_session";
    includeAssistant?: boolean;
    maxMessageChars?: number;
    heartbeatBatchSize?: number;
    defaultIndexingSettings?: Partial<IndexingSettings>;
    /** PilotDeck uses one global configuration; standalone consumers may retain project settings. */
    settingsSource?: "global" | "project";
    source?: string;
    llm?: EdgeClawMemoryLlmOptions;
    runtime?: Record<string, unknown>;
    logger?: LoggerLike;
    /** Selects the prompt archive: "general_medicine" | "war_trauma". Defaults to "general_medicine". */
    projectType?: string;
}
export interface CaptureTurnResult {
    captured: boolean;
    normalizedMessages: MemoryMessage[];
    sessionKey: string;
}
export interface RetrieveContextResult extends RetrievalResult {
    systemContext: string;
}
export interface MemoryListOptions {
    kinds?: MemoryRecordType[];
    query?: string;
    limit?: number;
    offset?: number;
    scope?: "global" | "project";
    includeDeprecated?: boolean;
}
export declare function buildMemoryRecallSystemContext(evidenceBlock: string): string;
export declare function buildEdgeClawMemoryPromptSection(options?: {
    availableTools?: Iterable<string>;
    citationsMode?: "off" | "on";
}): string | null;
export declare class EdgeClawMemoryService {
    readonly workspaceDir: string;
    readonly dataDir: string;
    readonly dbPath: string;
    readonly memoryDir: string;
    readonly defaultIndexingSettings: IndexingSettings;
    readonly repository: MemoryRepository;
    readonly extractor: LlmMemoryExtractor;
    readonly indexer: HeartbeatIndexer;
    readonly retriever: ReasoningRetriever;
    private readonly globalProfileLock;
    private readonly settingsSource;
    private activeMaintenance;
    private closeRequested;
    private closed;
    private readonly logger?;
    private readonly captureStrategy;
    private readonly includeAssistant;
    private readonly maxMessageChars;
    private readonly source;
    constructor(options: EdgeClawMemoryServiceOptions);
    close(): void;
    private withMaintenance;
    getSettings(): IndexingSettings;
    saveSettings(partial: Partial<IndexingSettings>): IndexingSettings;
    overview(): {
        maintenanceMode: MemoryMaintenanceMode;
        pendingSessions: number;
        workspaceMode?: import("./core/types.js").WorkspaceMemoryMode;
        projectMetaPresent?: boolean;
        projectMemoryCount?: number;
        feedbackMemoryCount?: number;
        currentProjectCount?: number;
        userProfileCount?: number;
        recentRecallTraceCount?: number;
        recentIndexTraceCount?: number;
        recentDreamTraceCount?: number;
        lastIndexedAt?: string;
        lastDreamAt?: string;
        lastDreamStatus?: import("./core/types.js").DreamPipelineStatus;
        lastDreamSummary?: string;
        lastDreamSnapshot?: import("./core/types.js").LastDreamSnapshotOverview;
        dashboardStatus?: import("./core/types.js").DashboardStatus;
        dashboardWarning?: string | null;
        dashboardDiagnostics?: import("./core/types.js").DashboardDiagnostics | null;
        changedFilesSinceLastDream?: number;
        lastCapturedAt?: string;
        lastDreamFailureReason?: string;
        dreamConsecutiveFailures?: number;
        maintenanceDowngrade?: {
            from: MemoryMaintenanceMode;
            to: MemoryMaintenanceMode;
            at: string;
            reason: string;
        } | null;
    };
    private getPipelineTimestamp;
    private setPipelineTimestamp;
    private reconcileAutoIndexAnchor;
    private reconcileAutoDreamAnchor;
    snapshot(limit?: number): MemoryUiSnapshot;
    captureTurn(rawMessages: readonly unknown[], input: {
        sessionKey: string;
        timestamp?: string;
        source?: string;
    }): CaptureTurnResult;
    flush(options?: {
        batchSize?: number;
        sessionKeys?: string[];
        reason?: string;
    }): Promise<HeartbeatStats>;
    private flushInternal;
    dream(trigger?: "manual" | "scheduled"): Promise<DreamRunResult>;
    private dreamInternal;
    private incrementDreamFailureCount;
    rollbackLastDream(): DreamRollbackResult;
    retrieve(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
        retrievalMode?: "auto" | "explicit";
    }): Promise<RetrievalResult>;
    retrieveContext(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
        retrievalMode?: "auto" | "explicit";
    }): Promise<RetrieveContextResult>;
    runDueScheduledMaintenance(reason?: string): Promise<{
        indexRan: boolean;
        dreamRan: boolean;
        indexStats?: HeartbeatStats;
        dreamResult?: DreamRunResult;
    }>;
    private runDueMaintenanceInternal;
    search(query: string, options?: {
        recentMessages?: MemoryMessage[];
        workspaceHint?: string;
    }): Promise<RetrievalResult>;
    list(options?: MemoryListOptions): import("./core/types.js").MemoryManifestEntry[];
    get(ids: string[], maxLines?: number): import("./core/types.js").MemoryFileRecord[];
    getUserSummary(): import("./core/types.js").MemoryUserSummary;
    readPresentationMemory(options?: {
        feedbackLimit?: number;
    }): PresentationMemorySnapshot;
    getProjectMeta(): import("./core/types.js").ProjectMetaRecord | undefined;
    getWorkspaceMode(): import("./core/types.js").WorkspaceMemoryMode;
    listReadableProjectCatalog(): import("./core/types.js").ReadableProjectCatalogEntry[];
    getReadableProject(logicalProjectId: string): import("./core/types.js").ReadableProjectCatalogEntry | undefined;
    listReadableProjectEntries(logicalProjectId: string, options?: {
        kinds?: Array<"project" | "feedback">;
        includeDeprecated?: boolean;
        query?: string;
        includeExternal?: boolean;
    }): import("./core/types.js").MemoryManifestEntry[];
    updateProjectMeta(input: {
        projectId?: string;
        projectName: string;
        description: string;
        status: string;
    }): import("./core/types.js").ProjectMetaRecord;
    getSnapshotVersion(): string;
    listCaseTraces(limit?: number): CaseTraceRecord[];
    saveCaseTrace(record: Omit<CaseTraceRecord, "caseId"> & {
        caseId?: string;
    }): void;
    getCaseTrace(caseId: string): CaseTraceRecord | undefined;
    listIndexTraces(limit?: number): import("./core/types.js").IndexTraceRecord[];
    getIndexTrace(indexTraceId: string): import("./core/types.js").IndexTraceRecord | undefined;
    listDreamTraces(limit?: number): import("./core/types.js").DreamTraceRecord[];
    getDreamTrace(dreamTraceId: string): import("./core/types.js").DreamTraceRecord | undefined;
    exportBundle(): MemoryExportBundle;
    importBundle(bundle: MemoryImportableBundle): MemoryImportResult;
    clear(scope?: ClearMemoryScope): ClearMemoryResult;
    act(input: MemoryActionRequest): MemoryActionResult;
}
export declare function summarizeTranscriptMessage(raw: unknown): TranscriptMessageInfo;
export {};
