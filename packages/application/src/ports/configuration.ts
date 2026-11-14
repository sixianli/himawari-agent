import type { AgentId, DemoLocale, DeploymentId, OwnerId } from "@himawari-agent/domain";
import type { ApplePushConfiguration } from "./apple-push.js";
import type { DataClassification } from "./common.js";
import type { DeviceConfiguration } from "./device-limits.js";
import type { PerceptionConfiguration } from "./perception.js";
import type { ModelProviderRouting } from "./intelligence.js";
import type { WebProviderId } from "./web-providers.js";

export interface SecretReferenceDescriptor {
  readonly ref: string;
  readonly version: string;
  readonly purpose: string;
  readonly scope: string;
}

export interface ModelCostDescriptor {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

interface ConfiguredModelDescriptorBase {
  readonly ref: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly disclosure: "local_only" | "trusted_remote" | "external_remote";
  readonly secretRef: string | null;
  readonly capabilities: readonly string[];
  readonly cost: ModelCostDescriptor;
  readonly providerRouting?: ModelProviderRouting;
}

interface ConfiguredGenerationModelDescriptorBase extends ConfiguredModelDescriptorBase {
  readonly role: "primary";
  readonly priority: number;
  readonly name: string;
}

export interface ConfiguredCompletionsGenerationModelDescriptor
  extends ConfiguredGenerationModelDescriptorBase {
  readonly api: "openai-completions";
  readonly reasoning: boolean;
  readonly reasoningRequired?: boolean;
  readonly thinkingLevels?: readonly string[];
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly baseUrl?: string;
}

export interface ConfiguredTypeSafeGenerationModelDescriptor
  extends Omit<ConfiguredGenerationModelDescriptorBase, "role"> {
  readonly role: "specialist";
  readonly api: "typesafe-systemone";
  readonly modelVersion?: string;
}

export type ConfiguredGenerationModelDescriptor =
  | ConfiguredCompletionsGenerationModelDescriptor
  | ConfiguredTypeSafeGenerationModelDescriptor;

export interface ConfiguredEmbeddingModelDescriptor extends ConfiguredModelDescriptorBase {
  readonly role: "embedding";
  readonly dimensions: number;
  readonly artifactSha256?: string;
}

export type ConfiguredModelDescriptor =
  | ConfiguredCompletionsGenerationModelDescriptor
  | ConfiguredTypeSafeGenerationModelDescriptor
  | ConfiguredEmbeddingModelDescriptor;

export interface ConfiguredMemoryDescriptor {
  readonly adapter: "himawari-sqlite";
  readonly version: string;
  readonly storagePath: string;
  readonly dimensions: number;
  readonly minimumSimilarity?: number;
  readonly retrieval?: ConfiguredMemoryRetrieval;
  readonly conversationReview?: ConfiguredConversationReview;
}

export interface ConfiguredConversationReview {
  readonly enabled?: boolean;
  readonly maximumSegmentsPerDay?: number;
  readonly maximumSourceCharacters?: number;
  readonly maximumRelatedMemories?: number;
  readonly maximumNewMemoriesPerDay?: number;
  readonly maximumOutputTokens?: number;
}

export interface ConfiguredMemoryRetrieval {
  readonly keywordWeight?: number;
  readonly entityWeight?: number;
  readonly cutoffMargin?: number;
  readonly dedupeSameSource?: boolean;
}

export interface ConcurrencyConfiguration {
  readonly totalRuns: number;
  readonly foregroundReserved: number;
  readonly perCategory: Readonly<Record<string, number>>;
}

export interface DeadlineConfiguration {
  readonly runMs: number;
  readonly workerRequestMs: number;
  readonly providerRequestMs: number;
  readonly commandWaitMs?: number;
  readonly backgroundCommandMs?: number;
}

export interface HttpConfiguration {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly staticRoot: string;
  readonly sessionCookieName: string;
  readonly maximumBodyBytes: number;
  readonly maximumStaticAssetBytes: number;
  readonly heartbeatMilliseconds: number;
  readonly previewOrigin?: string;
}

export interface RecentAuthenticationConfiguration {
  readonly maximumAgeMilliseconds: number;
  readonly clockSkewMilliseconds: number;
}

export interface IdentityBootstrapConfiguration {
  readonly enabled: boolean;
  readonly expiresAt: string;
  readonly tokenSecretRef: string | null;
}

export interface IdentityCsrfConfiguration {
  readonly keySecretRef: string;
  readonly ttlMilliseconds: number;
}

export interface CloudflareIdentityConfiguration {
  readonly kind?: "cloudflare-access";
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly jwksCacheMilliseconds: number;
  readonly jwksTimeoutMilliseconds: number;
  readonly jwksMaximumBodyBytes: number;
  readonly clockToleranceSeconds: number;
  readonly identityLookupTimeoutMilliseconds: number;
  readonly identityLookupMaximumBodyBytes: number;
  readonly recentAuthentication: RecentAuthenticationConfiguration;
  readonly bootstrap: IdentityBootstrapConfiguration;
  readonly csrf: IdentityCsrfConfiguration;
}

export interface BuiltInIdentityConfiguration {
  readonly kind: "built-in";
  readonly sessionIdleMilliseconds: number;
  readonly sessionAbsoluteMilliseconds: number;
  readonly recentAuthentication: RecentAuthenticationConfiguration;
  readonly csrf: IdentityCsrfConfiguration;
}

export type IdentityConfiguration = CloudflareIdentityConfiguration | BuiltInIdentityConfiguration;

export interface CapabilityDeploymentConfiguration {
  readonly snapshotPath: string;
  readonly sha256: string;
}

export interface TaskEnvironmentImageConfiguration {
  readonly reference: string;
  readonly digest: string;
  readonly pin: "registry-digest" | "image-id";
}

export interface TaskEnvironmentConfiguration {
  readonly backendRef: string;
  readonly dockerExecutable: string;
  readonly dockerHost: string | null;
  readonly image: TaskEnvironmentImageConfiguration;
  readonly egressImage: TaskEnvironmentImageConfiguration;
}

export interface FileReadRouteConfiguration {
  readonly hostId: string;
  readonly workerInstanceId: string;
  readonly grantId: string;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly maximumBytes: number;
}

export type PublicSearchRouteConfiguration = (
  | FileReadRouteConfiguration
  | (Omit<FileReadRouteConfiguration, "grantId"> & {
      readonly scopeSource: "private_temp";
    })
) &
  WebProviderRouteConfiguration;

export interface WebProviderRouteConfiguration {
  readonly providers?: readonly WebProviderId[];
  readonly providerSecrets?: Readonly<Partial<Record<WebProviderId, string>>>;
}

export type PublicFetchRouteConfiguration = Omit<FileReadRouteConfiguration, "grantId"> & {
  readonly scopeSource: "private_temp";
} & WebProviderRouteConfiguration;

export interface CodingRouteConfiguration extends FileReadRouteConfiguration {
  readonly enabledTools: readonly (
    | "read"
    | "write"
    | "edit"
    | "bash"
    | "find"
    | "grep"
    | "ls"
    | "move_directory"
    | "save_copy"
  )[];
  readonly approval?: "workspace_auto" | "ask";
}

export interface WebPushConfiguration {
  readonly secretRef: string;
  readonly subject: string;
}

export interface HomeFeedConfiguration {
  readonly awaitingLimit: number;
  readonly otherLimit: number;
  readonly sourceReadLimit: number;
  readonly deadlineLeadMinutes: number;
  readonly recentHours: number;
  readonly upcomingLimit: number;
  readonly upcomingDays: number;
}

export interface SearchAskConfiguration {
  readonly candidateLimit: number;
  readonly basisLimit: number;
  readonly askLimit: number;
  readonly answerCharacters: number;
  readonly minimumCoveragePercent: number;
}

export const DEFAULT_SEARCH_ASK: SearchAskConfiguration = Object.freeze({
  candidateLimit: 20,
  basisLimit: 1,
  askLimit: 0,
  answerCharacters: 2000,
  minimumCoveragePercent: 50,
});

export interface ProactiveGmailConfiguration {
  readonly clientId: string;
  readonly clientSecretRef: string;
}

export interface ProactiveConfiguration {
  readonly modelRef: string;
  readonly gmail?: ProactiveGmailConfiguration;
  readonly demoInbox?: DemoLocale;
  readonly intervalMs: number;
  readonly perCheckMs: number;
  readonly dailyCostMicros: number;
  readonly bodyCharactersPerMail: number;
  readonly bodyCharactersPerBatch: number;
  readonly relatedMailsPerMail: number;
  readonly relatedCharactersPerMail: number;
  readonly relatedCharactersPerRelatedMail: number;
  readonly relatedRequestsPerCheck: number;
  readonly wholeThreadMailsPerMail: number;
  readonly wholeThreadCharactersPerMail: number;
  readonly ruleReplayDays: number;
  readonly ruleReplayMailsPerOutcome: number;
  readonly memoryMinimumSimilarity?: number;
  readonly reviewBudgetSeconds: number;
  readonly reviewSecondsPerItem: number;
  readonly reviewSilentSharePermille: number;
  readonly reviewPrereview: ReviewPrereviewConfiguration;
  readonly reviewMemoryUnusedDays: number;
  readonly backoffThreshold: number;
}

export interface ReviewPrereviewConfiguration {
  readonly enabled: boolean;
  readonly dailyLimit: number;
  readonly dailyCostMicros: number;
  readonly perRun: number;
  readonly requestTimeoutMs: number;
  readonly historyDays: number;
  readonly historyMinimum: number;
  readonly reduction: {
    readonly enabled: boolean;
    readonly hiddenAgreementPermille: number;
    readonly confidencePermille: number;
    readonly auditPermille: number;
    readonly windowDays: number;
  };
}

export interface MuseIntakeConfiguration {
  readonly enabled: boolean;
  readonly secretRef: string;
  readonly gapExportSecretRef?: string;
}

export interface ImportDuplicateTuning {
  readonly yesAtLeastPermille: number;
  readonly noAtMostPermille: number;
  readonly existingPerRequest: number;
  readonly existingCharactersPerRequest: number;
  readonly candidatesPerRequest: number;
  readonly maximumExistingMemories: number;
  readonly maximumRequests: number;
  readonly dailyMaximumRequests: number;
  readonly requestTimeoutMs: number;
}

export interface ImportDuplicateConfiguration extends ImportDuplicateTuning {
  readonly model: string;
  readonly secretRef: string;
}

export const IMPORT_DUPLICATE_DEFAULTS: ImportDuplicateTuning = Object.freeze({
  yesAtLeastPermille: 700,
  noAtMostPermille: 300,
  existingPerRequest: 200,
  existingCharactersPerRequest: 30_000,
  candidatesPerRequest: 20,
  maximumExistingMemories: 1_000,
  maximumRequests: 150,
  dailyMaximumRequests: 1_500,
  requestTimeoutMs: 15_000,
});

export const IMPORT_DUPLICATE_RANGES: Readonly<
  Record<keyof ImportDuplicateTuning, readonly [number, number]>
> = Object.freeze({
  yesAtLeastPermille: [500, 1000],
  noAtMostPermille: [0, 500],
  existingPerRequest: [10, 500],
  existingCharactersPerRequest: [2_000, 100_000],
  candidatesPerRequest: [1, 50],
  maximumExistingMemories: [0, 5_000],
  maximumRequests: [1, 1_000],
  dailyMaximumRequests: [1, 100_000],
  requestTimeoutMs: [1_000, 60_000],
});

export const REAL_EVAL_MODES = ["off", "once", "weekly"] as const;
export type RealEvalMode = (typeof REAL_EVAL_MODES)[number];
export const REAL_EVAL_WEEKLY_CAP_MICROS_MAXIMUM = 500_000;

export interface RealEvalConfiguration {
  readonly mode: RealEvalMode;
  readonly modelRef: string;
  readonly weeklyCapMicros: number;
  readonly newMemoriesPerRun: number;
  readonly requestTimeoutMs: number;
}

export interface McpReadConfiguration {
  readonly audience: string;
  readonly proposals?: true;
}

export interface OwnerProposalConfiguration {
  readonly pendingLimit?: number;
  readonly expiresAfterDays?: number;
}

export interface ToolRefusalConfiguration {
  readonly consecutive: number;
  readonly total: number;
}

export const DEFAULT_TOOL_REFUSALS: ToolRefusalConfiguration = Object.freeze({
  consecutive: 3,
  total: 20,
});

export interface OwnerIntentCheckConfiguration {
  readonly enabled: boolean;
  readonly minConfidence: number;
  readonly timeoutMs: number;
  readonly model: string;
  readonly secretRef: string;
}

export interface RunPolicyConfiguration {
  readonly timeZone?: string;
  readonly ownerProposals?: OwnerProposalConfiguration;
  readonly approvalBodyPreviewCharacters?: number;
  readonly toolRefusals?: ToolRefusalConfiguration;
  readonly ownerIntentCheck?: OwnerIntentCheckConfiguration;
  readonly realEval?: RealEvalConfiguration;
  readonly museIntake?: MuseIntakeConfiguration;
  readonly importDuplicates?: ImportDuplicateConfiguration;
  readonly mcpRead?: McpReadConfiguration;
  readonly webPush?: WebPushConfiguration;
  readonly applePush?: ApplePushConfiguration;
  readonly device?: DeviceConfiguration;
  readonly homeFeed?: HomeFeedConfiguration;
  readonly searchAsk?: SearchAskConfiguration;
  readonly perception?: PerceptionConfiguration;
  readonly homeUrgency?: HomeUrgencyConfiguration;
  readonly proactive?: ProactiveConfiguration;
  readonly coding?: CodingRouteConfiguration;
  readonly publicSearch?: PublicSearchRouteConfiguration;
  readonly publicFetch?: PublicFetchRouteConfiguration;
  readonly fileRead?: FileReadRouteConfiguration;
  readonly automaticReview?: AutomaticReviewConfiguration;
  readonly version: string;
  readonly systemInstruction: string;
  readonly freezeThreadPrompts?: boolean;
  readonly memoryLimit: number;
  readonly maxSelectedMemories: number;
  readonly retiredKeys?: readonly string[];
}

export interface AutomaticReviewConfiguration {
  readonly delegationKey: string;
  readonly configurationVersion: string;
  readonly modelRef: string;
  readonly maximumWaitMs: number;
  readonly maxOutputBytes: number;
  readonly confidenceThreshold?: number;
}

export interface ProductConfiguration {
  readonly schemaVersion: string;
  readonly deploymentId: DeploymentId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly stateRoot: string;
  readonly runtimeDirectory: string;
  readonly cacheDirectory: string;
  readonly publicOrigin: string;
  readonly publicMode: boolean;
  readonly runPolicy?: RunPolicyConfiguration;
  readonly capabilityDeployment?: CapabilityDeploymentConfiguration;
  readonly taskEnvironments?: TaskEnvironmentConfiguration;
  readonly http?: HttpConfiguration;
  readonly identity?: IdentityConfiguration;
  readonly modelDescriptors: readonly ConfiguredModelDescriptor[];
  readonly memory: ConfiguredMemoryDescriptor;
  readonly repositoryAllowlistRefs: readonly string[];
  readonly secretReferences: readonly SecretReferenceDescriptor[];
  readonly concurrency: ConcurrencyConfiguration;
  readonly deadlines: DeadlineConfiguration;
  readonly loadedAt: string;
}

export interface ConfigurationPort {
  load(): Promise<ProductConfiguration>;
}

export interface HomeUrgencyConfiguration {
  readonly enabled: boolean;
  readonly modelRef?: string;
  readonly dailyLimit: number;
  readonly dailyCostMicros: number;
  readonly perCall: number;
  readonly referenceLimit: number;
  readonly requestTimeoutMs: number;
  readonly checkIntervalSeconds: number;
  readonly retryAfterHours: number;
  readonly affirmLabelMax: Readonly<Record<string, number>>;
}
