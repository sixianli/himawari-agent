// biome-ignore-all lint/complexity/useLiteralKeys: untrusted JSON stays index-signature typed until validated
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertMachineSecretFree,
  type ConfigurationPort,
  type ConfiguredEmbeddingModelDescriptor,
  type ConfiguredGenerationModelDescriptor,
  type ConfiguredModelDescriptor,
  type DataClassification,
  type ModelCostDescriptor,
  type ModelProviderRouting,
  type ProductConfiguration,
} from "@himawari-agent/application";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";

export const CONFIGURATION_SCHEMA_VERSION = "himawari.configuration.v1" as const;

export const CONFIGURATION_ERROR_CODES = Object.freeze({
  FILE_UNSAFE: "CONFIGURATION_FILE_UNSAFE",
  INVALID_JSON: "CONFIGURATION_INVALID_JSON",
  UNKNOWN_FIELD: "CONFIGURATION_UNKNOWN_FIELD",
  INVALID_VALUE: "CONFIGURATION_INVALID_VALUE",
  SECRET_MATERIAL: "CONFIGURATION_SECRET_MATERIAL",
} as const);

export type ConfigurationErrorCode =
  (typeof CONFIGURATION_ERROR_CODES)[keyof typeof CONFIGURATION_ERROR_CODES];

export class StrictConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ConfigurationErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "StrictConfigurationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, "must be an object");
  }
  return value as JsonRecord;
}

function rejectUnknown(value: JsonRecord, allowed: readonly string[], field: string): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) {
    throw new StrictConfigurationError(
      CONFIGURATION_ERROR_CODES.UNKNOWN_FIELD,
      "Configuration contains an unknown field",
      { field: `${field}.${unknown.sort()[0]}` },
    );
  }
}

function invalid(field: string, reason: string): StrictConfigurationError {
  return new StrictConfigurationError(
    CONFIGURATION_ERROR_CODES.INVALID_VALUE,
    "Configuration value is invalid",
    { field, reason },
  );
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(field, "must be non-empty");
  return value;
}

function safeReference(value: unknown, field: string): string {
  const result = string(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(result)) {
    throw invalid(field, "must be a stable reference");
  }
  return result;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, "must be boolean");
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(field, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(field, "must be a non-negative finite number");
  }
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const candidate = string(value, field);
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    throw invalid(field, "must be a normalized absolute path");
  }
  return candidate;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw invalid(field, "must be an array");
  const result = value.map((entry, index) => safeReference(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
  return Object.freeze(result);
}

const CLASSIFICATIONS = Object.freeze(["public", "private", "sensitive", "restricted"] as const);

function classifications(value: unknown, field: string): readonly DataClassification[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid(field, "must be non-empty");
  const result = value.map((entry, index) => {
    if (!CLASSIFICATIONS.includes(entry as DataClassification)) {
      throw invalid(`${field}[${index}]`, "is not a supported classification");
    }
    return entry as DataClassification;
  });
  if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
  return Object.freeze(result);
}

function providerRouting(value: unknown, field: string): ModelProviderRouting {
  const input = record(value, field);
  rejectUnknown(
    input,
    ["order", "allow_fallbacks", "require_parameters", "data_collection", "zdr"],
    field,
  );
  let order: readonly string[] | undefined;
  if (input["order"] !== undefined) {
    if (!Array.isArray(input["order"]) || input["order"].length === 0) {
      throw invalid(`${field}.order`, "must be a non-empty array");
    }
    const values = input["order"].map((entry, index) =>
      safeReference(entry, `${field}.order[${index}]`),
    );
    if (new Set(values).size !== values.length) {
      throw invalid(`${field}.order`, "must not contain duplicates");
    }
    order = Object.freeze(values);
  }
  const dataCollection = input["data_collection"];
  if (dataCollection !== undefined && dataCollection !== "allow" && dataCollection !== "deny") {
    throw invalid(`${field}.data_collection`, "must be allow or deny");
  }
  return Object.freeze({
    ...(order === undefined ? {} : { order }),
    ...(input["allow_fallbacks"] === undefined
      ? {}
      : { allow_fallbacks: boolean(input["allow_fallbacks"], `${field}.allow_fallbacks`) }),
    ...(input["require_parameters"] === undefined
      ? {}
      : {
          require_parameters: boolean(input["require_parameters"], `${field}.require_parameters`),
        }),
    ...(dataCollection === undefined ? {} : { data_collection: dataCollection }),
    ...(input["zdr"] === undefined ? {} : { zdr: boolean(input["zdr"], `${field}.zdr`) }),
  });
}

function modelCost(value: unknown, field: string): ModelCostDescriptor {
  const input = record(value, field);
  rejectUnknown(input, ["input", "output", "cacheRead", "cacheWrite"], field);
  return Object.freeze({
    input: nonNegativeNumber(input["input"], `${field}.input`),
    output: nonNegativeNumber(input["output"], `${field}.output`),
    cacheRead: nonNegativeNumber(input["cacheRead"], `${field}.cacheRead`),
    cacheWrite: nonNegativeNumber(input["cacheWrite"], `${field}.cacheWrite`),
  });
}

function inputModalities(value: unknown, field: string): readonly ("text" | "image")[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(field, "must be a non-empty array");
  }
  const result = value.map((entry, index) => {
    if (entry !== "text" && entry !== "image") {
      throw invalid(`${field}[${index}]`, "must be text or image");
    }
    return entry;
  });
  if (!result.includes("text")) throw invalid(field, "must include text");
  if (new Set(result).size !== result.length) throw invalid(field, "must not contain duplicates");
  return Object.freeze(result);
}

function parseModel(value: unknown, index: number): ConfiguredModelDescriptor {
  const field = `modelDescriptors[${index}]`;
  const input = record(value, field);
  const role = string(input["role"], `${field}.role`);
  if (!(["primary", "fallback", "embedding"] as const).includes(role as never)) {
    throw invalid(`${field}.role`, "is not a supported role");
  }
  const generation = role !== "embedding";
  rejectUnknown(
    input,
    [
      "ref",
      "role",
      "provider",
      "model",
      "version",
      "allowedDataClassifications",
      "disclosure",
      "secretRef",
      "capabilities",
      "cost",
      ...(generation
        ? [
            "priority",
            "name",
            "api",
            "reasoning",
            "input",
            "contextWindow",
            "maxTokens",
            "providerRouting",
          ]
        : ["dimensions"]),
    ],
    field,
  );
  const disclosure = string(input["disclosure"], `${field}.disclosure`);
  if (
    !(["local_only", "trusted_remote", "external_remote"] as const).includes(disclosure as never)
  ) {
    throw invalid(`${field}.disclosure`, "is not a supported disclosure boundary");
  }
  const capabilities = stringArray(input["capabilities"], `${field}.capabilities`);
  if (generation && !capabilities.includes("text")) {
    throw invalid(`${field}.capabilities`, "generation models must include text");
  }
  if (!generation && !capabilities.includes("embedding")) {
    throw invalid(`${field}.capabilities`, "embedding models must include embedding");
  }
  const base = {
    ref: safeReference(input["ref"], `${field}.ref`),
    provider: safeReference(input["provider"], `${field}.provider`),
    model: safeReference(input["model"], `${field}.model`),
    version: safeReference(input["version"], `${field}.version`),
    allowedDataClassifications: classifications(
      input["allowedDataClassifications"],
      `${field}.allowedDataClassifications`,
    ),
    disclosure: disclosure as ConfiguredModelDescriptor["disclosure"],
    secretRef:
      input["secretRef"] === null ? null : safeReference(input["secretRef"], `${field}.secretRef`),
    capabilities,
    cost: modelCost(input["cost"], `${field}.cost`),
  };
  if (!generation) {
    const descriptor: ConfiguredEmbeddingModelDescriptor = {
      ...base,
      role: "embedding",
      dimensions: integer(input["dimensions"], `${field}.dimensions`, 1, 65_536),
    };
    return Object.freeze(descriptor);
  }
  const api = string(input["api"], `${field}.api`);
  if (api !== "openai-completions") throw invalid(`${field}.api`, "is unsupported");
  const descriptor: ConfiguredGenerationModelDescriptor = {
    ...base,
    role: role as "primary" | "fallback",
    priority: integer(input["priority"], `${field}.priority`, 1, 10_000),
    name: string(input["name"], `${field}.name`),
    api: "openai-completions",
    reasoning: boolean(input["reasoning"], `${field}.reasoning`),
    input: inputModalities(input["input"], `${field}.input`),
    contextWindow: integer(
      input["contextWindow"],
      `${field}.contextWindow`,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxTokens: integer(input["maxTokens"], `${field}.maxTokens`, 1, Number.MAX_SAFE_INTEGER),
    ...(input["providerRouting"] === undefined
      ? {}
      : { providerRouting: providerRouting(input["providerRouting"], `${field}.providerRouting`) }),
  };
  if (role === "fallback") {
    if (
      descriptor.allowedDataClassifications.length !== 1 ||
      descriptor.allowedDataClassifications[0] !== "private"
    ) {
      throw invalid(
        `${field}.allowedDataClassifications`,
        "fallback must allow exactly the private classification",
      );
    }
  }
  return Object.freeze(descriptor);
}

function parseCostMap(value: unknown) {
  const input = record(value, "budgets.perClassificationCostMicros");
  rejectUnknown(input, CLASSIFICATIONS, "budgets.perClassificationCostMicros");
  return Object.freeze(
    Object.fromEntries(
      CLASSIFICATIONS.map((classification) => [
        classification,
        integer(
          input[classification],
          `budgets.perClassificationCostMicros.${classification}`,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      ]),
    ) as Record<DataClassification, number>,
  );
}

function parseNumberMap(value: unknown, field: string): Readonly<Record<string, number>> {
  const input = record(value, field);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) throw invalid(`${field}.${key}`, "has unsafe key");
    result[key] = integer(entry, `${field}.${key}`, 0, 10_000);
  }
  return Object.freeze(result);
}

export function parseProductConfiguration(value: unknown, loadedAt: string): ProductConfiguration {
  const input = record(value, "configuration");
  rejectUnknown(
    input,
    [
      "schemaVersion",
      "deploymentId",
      "ownerId",
      "agentId",
      "stateRoot",
      "runtimeDirectory",
      "cacheDirectory",
      "publicOrigin",
      "publicMode",
      "modelDescriptors",
      "memory",
      "repositoryAllowlistRefs",
      "secretReferences",
      "budgets",
      "concurrency",
      "deadlines",
    ],
    "configuration",
  );
  if (input["schemaVersion"] !== CONFIGURATION_SCHEMA_VERSION) {
    throw invalid("configuration.schemaVersion", "is unsupported");
  }
  try {
    assertMachineSecretFree(JSON.stringify(input));
  } catch {
    throw new StrictConfigurationError(
      CONFIGURATION_ERROR_CODES.SECRET_MATERIAL,
      "Configuration must contain only secret references",
    );
  }

  const stateRoot = absolutePath(input["stateRoot"], "configuration.stateRoot");
  const runtimeDirectory = absolutePath(
    input["runtimeDirectory"],
    "configuration.runtimeDirectory",
  );
  const cacheDirectory = absolutePath(input["cacheDirectory"], "configuration.cacheDirectory");
  if (runtimeDirectory !== path.join(stateRoot, "runtime")) {
    throw invalid("configuration.runtimeDirectory", "must be the state-root runtime partition");
  }
  if (cacheDirectory !== path.join(stateRoot, "cache")) {
    throw invalid("configuration.cacheDirectory", "must be the state-root cache partition");
  }

  const publicMode = boolean(input["publicMode"], "configuration.publicMode");
  const publicOrigin = string(input["publicOrigin"], "configuration.publicOrigin");
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw invalid("configuration.publicOrigin", "must be an absolute URL origin");
  }
  if (origin.origin !== publicOrigin || origin.username || origin.password) {
    throw invalid("configuration.publicOrigin", "must contain only an origin");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  const transportAllowed =
    origin.protocol === "https:" || (!publicMode && origin.protocol === "http:" && loopback);
  if (!transportAllowed) {
    throw invalid("configuration.publicOrigin", "does not meet transport security policy");
  }

  if (!Array.isArray(input["modelDescriptors"])) {
    throw invalid("configuration.modelDescriptors", "must be an array");
  }
  const modelDescriptors = Object.freeze(input["modelDescriptors"].map(parseModel));
  if (new Set(modelDescriptors.map(({ ref }) => ref)).size !== modelDescriptors.length) {
    throw invalid("configuration.modelDescriptors", "must not contain duplicate refs");
  }
  for (const role of ["primary", "fallback", "embedding"] as const) {
    if (modelDescriptors.filter((descriptor) => descriptor.role === role).length !== 1) {
      throw invalid("configuration.modelDescriptors", `must contain exactly one ${role}`);
    }
  }

  const memory = record(input["memory"], "configuration.memory");
  rejectUnknown(
    memory,
    ["adapter", "version", "storagePath", "dimensions"],
    "configuration.memory",
  );
  if (memory["adapter"] !== "mem0-oss")
    throw invalid("configuration.memory.adapter", "is unsupported");
  const memoryPath = absolutePath(memory["storagePath"], "configuration.memory.storagePath");
  if (!memoryPath.startsWith(`${stateRoot}${path.sep}`)) {
    throw invalid("configuration.memory.storagePath", "must be under the state root");
  }
  const memoryDimensions = integer(
    memory["dimensions"],
    "configuration.memory.dimensions",
    1,
    65_536,
  );
  const embeddingDescriptor = modelDescriptors.find(
    (descriptor): descriptor is Extract<ConfiguredModelDescriptor, { role: "embedding" }> =>
      descriptor.role === "embedding",
  );
  if (!embeddingDescriptor || embeddingDescriptor.dimensions !== memoryDimensions) {
    throw invalid(
      "configuration.memory.dimensions",
      "must equal modelDescriptors.embedding.dimensions",
    );
  }

  const secretReferencesInput = input["secretReferences"];
  if (!Array.isArray(secretReferencesInput)) {
    throw invalid("configuration.secretReferences", "must be an array");
  }
  const secretReferences = Object.freeze(
    secretReferencesInput.map((entry, index) => {
      const field = `configuration.secretReferences[${index}]`;
      const descriptor = record(entry, field);
      rejectUnknown(descriptor, ["ref", "version", "purpose", "scope"], field);
      return Object.freeze({
        ref: safeReference(descriptor["ref"], `${field}.ref`),
        version: safeReference(descriptor["version"], `${field}.version`),
        purpose: safeReference(descriptor["purpose"], `${field}.purpose`),
        scope: safeReference(descriptor["scope"], `${field}.scope`),
      });
    }),
  );
  if (
    new Set(secretReferences.map(({ ref, version }) => `${ref}@${version}`)).size !==
    secretReferences.length
  ) {
    throw invalid("configuration.secretReferences", "must not contain duplicate ref/version pairs");
  }
  const secretReferenceNames = new Set(secretReferences.map(({ ref }) => ref));
  for (const descriptor of modelDescriptors) {
    if (descriptor.secretRef !== null && !secretReferenceNames.has(descriptor.secretRef)) {
      throw invalid(
        "configuration.modelDescriptors",
        `model ${descriptor.ref} references an undeclared secret`,
      );
    }
    if (
      descriptor.secretRef !== null &&
      secretReferences.filter(({ ref }) => ref === descriptor.secretRef).length !== 1
    ) {
      throw invalid(
        "configuration.secretReferences",
        `model ${descriptor.ref} must resolve exactly one secret version`,
      );
    }
  }

  const budgets = record(input["budgets"], "configuration.budgets");
  rejectUnknown(
    budgets,
    ["globalCostMicros", "perRunCostMicros", "perClassificationCostMicros"],
    "configuration.budgets",
  );
  const concurrency = record(input["concurrency"], "configuration.concurrency");
  rejectUnknown(
    concurrency,
    ["totalRuns", "foregroundReserved", "perCategory"],
    "configuration.concurrency",
  );
  const totalRuns = integer(
    concurrency["totalRuns"],
    "configuration.concurrency.totalRuns",
    1,
    10_000,
  );
  const foregroundReserved = integer(
    concurrency["foregroundReserved"],
    "configuration.concurrency.foregroundReserved",
    0,
    totalRuns,
  );
  const deadlines = record(input["deadlines"], "configuration.deadlines");
  rejectUnknown(
    deadlines,
    ["runMs", "workerRequestMs", "providerRequestMs"],
    "configuration.deadlines",
  );

  return Object.freeze({
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: createDeploymentId(
      safeReference(input["deploymentId"], "configuration.deploymentId"),
    ),
    ownerId: createOwnerId(safeReference(input["ownerId"], "configuration.ownerId")),
    agentId: createAgentId(safeReference(input["agentId"], "configuration.agentId")),
    stateRoot,
    runtimeDirectory,
    cacheDirectory,
    publicOrigin,
    publicMode,
    modelDescriptors,
    memory: Object.freeze({
      adapter: "mem0-oss" as const,
      version: safeReference(memory["version"], "configuration.memory.version"),
      storagePath: memoryPath,
      dimensions: memoryDimensions,
    }),
    repositoryAllowlistRefs: stringArray(
      input["repositoryAllowlistRefs"],
      "configuration.repositoryAllowlistRefs",
    ),
    secretReferences,
    budgets: Object.freeze({
      globalCostMicros: integer(
        budgets["globalCostMicros"],
        "configuration.budgets.globalCostMicros",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      perRunCostMicros: integer(
        budgets["perRunCostMicros"],
        "configuration.budgets.perRunCostMicros",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      perClassificationCostMicros: parseCostMap(budgets["perClassificationCostMicros"]),
    }),
    concurrency: Object.freeze({
      totalRuns,
      foregroundReserved,
      perCategory: parseNumberMap(
        concurrency["perCategory"],
        "configuration.concurrency.perCategory",
      ),
    }),
    deadlines: Object.freeze({
      runMs: integer(deadlines["runMs"], "configuration.deadlines.runMs", 100, 86_400_000),
      workerRequestMs: integer(
        deadlines["workerRequestMs"],
        "configuration.deadlines.workerRequestMs",
        100,
        86_400_000,
      ),
      providerRequestMs: integer(
        deadlines["providerRequestMs"],
        "configuration.deadlines.providerRequestMs",
        100,
        86_400_000,
      ),
    }),
    loadedAt,
  });
}

export class JsonFileConfigurationPort implements ConfigurationPort {
  readonly #configurationPath: string;
  readonly #now: () => string;

  constructor(configurationPath: string, now: () => string = () => new Date().toISOString()) {
    if (!path.isAbsolute(configurationPath)) {
      throw new StrictConfigurationError(
        CONFIGURATION_ERROR_CODES.FILE_UNSAFE,
        "Configuration path must be absolute",
      );
    }
    this.#configurationPath = path.resolve(configurationPath);
    this.#now = now;
  }

  async load(): Promise<ProductConfiguration> {
    const info = await lstat(this.#configurationPath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
      throw new StrictConfigurationError(
        CONFIGURATION_ERROR_CODES.FILE_UNSAFE,
        "Configuration file is missing, writable by another account, or not a regular file",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#configurationPath, "utf8"));
    } catch {
      throw new StrictConfigurationError(
        CONFIGURATION_ERROR_CODES.INVALID_JSON,
        "Configuration file is not valid JSON",
      );
    }
    return parseProductConfiguration(value, this.#now());
  }
}
