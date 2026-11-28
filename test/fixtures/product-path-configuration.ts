import path from "node:path";

export const PRODUCT_PATH_AUDIENCE = "access-audience-product-path";
export const PRODUCT_PATH_CODING_TOOLS = [
  "read",
  "write",
  "edit",
  "ls",
  "find",
  "grep",
  "bash",
] as const;

export interface ProductPathConfigurationInput {
  readonly deploymentId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly stateRoot: string;
  readonly runtimeDirectory: string;
  readonly publicOrigin: string;
  readonly staticRoot: string;
  readonly issuer: string;
  readonly hostId: string;
  readonly workerInstanceId: string;
  readonly grantId: string;
  readonly capabilityDeployment: unknown;
  readonly approval?: "workspace_auto" | "ask" | undefined;
  readonly webSearch?: boolean | undefined;
  readonly modelCatalogUrl?: string | undefined;
}

export function buildProductPathConfiguration(input: ProductPathConfigurationInput) {
  const {
    deploymentId,
    ownerId,
    agentId,
    stateRoot,
    publicOrigin,
    staticRoot,
    hostId,
    workerInstanceId,
    grantId,
    capabilityDeployment,
  } = input;
  const audience = PRODUCT_PATH_AUDIENCE;
  const codingTools = PRODUCT_PATH_CODING_TOOLS;
  const issuer = () => input.issuer;
  const options = { approval: input.approval, webSearch: input.webSearch };

  const model = (role: string, ref: string, priority: number) => ({
    ref,
    role,
    provider: "vercel-ai-gateway",
    model: "deepseek/deepseek-v4.1-flash",
    version: "v1",
    allowedDataClassifications: ["public", "private"],
    disclosure: "trusted_remote",
    secretRef: "vercel-ai-gateway-api-key",
    capabilities: ["text", "tools"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priority,
    name: `Product path ${role}`,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 2048,
    providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
  });
  const webRoute = (capabilityRef: string, maximumBytes: number) => ({
    scopeSource: "private_temp",
    hostId,
    workerInstanceId,
    capabilityRef,
    capabilityVersion: "1.0.0",
    maximumBytes,
    providers: ["exa-public"],
  });
  return {
    schemaVersion: "himawari.configuration.v1",
    deploymentId,
    ownerId,
    agentId,
    stateRoot,
    runtimeDirectory: input.runtimeDirectory,
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin,
    publicMode: true,
    http: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      staticRoot,
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 256 * 1024,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 5_000,
    },
    identity: {
      issuer: issuer(),
      audience,
      jwksUrl: `${issuer()}/cdn-cgi/access/certs`,
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: { maximumAgeMilliseconds: 900_000, clockSkewMilliseconds: 30_000 },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
    },
    modelDescriptors: [
      input.modelCatalogUrl !== undefined
        ? (({ providerRouting: _routing, ...rest }) => ({
            ...rest,
            provider: "magpie",
            baseUrl: input.modelCatalogUrl,
          }))(model("primary", "model-primary", 1))
        : model("primary", "model-primary", 1),
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "vercel-ai-gateway",
        model: "alibaba/qwen3-embedding-8b",
        version: "v1",
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "trusted_remote",
        secretRef: "vercel-ai-gateway-api-key",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 4096,
      },
    ],
    memory: {
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 4096,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
      {
        ref: "vercel-ai-gateway-api-key",
        version: "v1",
        purpose: "model-provider-auth",
        scope: "agent",
      },
      {
        ref: "worker-process-token",
        version: "v1",
        purpose: "worker-auth",
        scope: "local-services",
      },
    ],
    concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
    deadlines: { runMs: 900_000, workerRequestMs: 300_000, providerRequestMs: 120_000 },
    capabilityDeployment,
    runPolicy: {
      version: "product-path-v1",
      systemInstruction: "请用中文回答。文件工具使用工作目录内的相对路径。",
      memoryLimit: 5,
      coding: {
        hostId,
        workerInstanceId,
        grantId,
        capabilityRef: "himawari.pi-coding",
        capabilityVersion: "1.0.0",
        maximumBytes: 49152,
        enabledTools: [...codingTools],
        approval: options.approval ?? "workspace_auto",
      },
      ...(options.webSearch
        ? {
            publicSearch: webRoute("himawari.public-search", 4096),
            publicFetch: webRoute("himawari.public-fetch", 102400),
          }
        : {}),
      timeZone: "Asia/Tokyo",
    },
  };
}
