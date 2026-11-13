import { randomBytes } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { ProductConfiguration } from "@himawari-agent/application";
import { assertReferencePart } from "./host-secret-source.js";
import { parseProductConfiguration } from "./strict-configuration.js";

export const TENANT_CONFIGURATION_ERROR_CODES = Object.freeze({
  PURPOSE_UNCLASSIFIED: "TENANT_SECRET_PURPOSE_UNCLASSIFIED",
  PURPOSE_CONFLICT: "TENANT_SECRET_PURPOSE_CONFLICT",
  PAYLOAD_KEY_COUNT: "TENANT_PAYLOAD_KEY_COUNT_INVALID",
  STATE_ROOT_INVALID: "TENANT_STATE_ROOT_INVALID",
  STATE_ROOT_NESTED: "TENANT_STATE_ROOT_NESTED",
  BASE_VALUE_LEAKED: "TENANT_BASE_VALUE_LEAKED",
  SECRET_DIRECTORY_UNSAFE: "TENANT_SECRET_DIRECTORY_UNSAFE",
} as const);

export class TenantConfigurationError extends Error {
  readonly code: (typeof TENANT_CONFIGURATION_ERROR_CODES)[keyof typeof TENANT_CONFIGURATION_ERROR_CODES];

  constructor(code: TenantConfigurationError["code"], message: string) {
    super(message);
    this.name = "TenantConfigurationError";
    this.code = code;
  }
}

export type TenantSecretClass = "per-tenant" | "shared";

export const TENANT_SECRET_PURPOSE_CLASSES: Readonly<Record<string, TenantSecretClass>> =
  Object.freeze({
    "payload-encryption": "per-tenant",
    "identity-csrf": "per-tenant",
    "identity-bootstrap": "per-tenant",
    "web-push": "per-tenant",
    "muse-intake": "per-tenant",
    "gap-export": "per-tenant",
    "backup-encryption": "per-tenant",
    "transfer-recipient": "per-tenant",
    "model-provider": "shared",
    "model-provider-auth": "shared",
    "embedding-provider-auth": "shared",
    "web-provider": "shared",
    "google-oauth-client": "shared",
  });

export const TENANT_RANDOM_KEY_PURPOSES: readonly string[] = Object.freeze([
  "payload-encryption",
  "identity-csrf",
]);

export interface TenantConfigurationIdentity {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly deploymentId: string;
}

export interface TenantConfigurationInput {
  readonly base: unknown;
  readonly tenant: TenantConfigurationIdentity;
  readonly tenantsRoot: string;
  readonly stateRoot?: string;
  readonly otherStateRoots?: readonly string[];
  readonly now?: string;
}

export interface SecretClassification {
  readonly perTenant: readonly { readonly ref: string; readonly version: string }[];
  readonly shared: readonly { readonly ref: string; readonly version: string }[];
}

export interface SynthesizedTenantConfiguration {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly configuration: ProductConfiguration;
  readonly secrets: SecretClassification;
}

export function classifySecretReferences(
  configuration: ProductConfiguration,
): SecretClassification {
  const modelSecretRefs = new Set(
    configuration.modelDescriptors.flatMap(({ secretRef }) =>
      secretRef === null ? [] : [secretRef],
    ),
  );
  const perTenant: { ref: string; version: string }[] = [];
  const shared: { ref: string; version: string }[] = [];
  for (const { ref, version, purpose } of configuration.secretReferences) {
    const secretClass = TENANT_SECRET_PURPOSE_CLASSES[purpose];
    if (secretClass === undefined)
      throw new TenantConfigurationError(
        TENANT_CONFIGURATION_ERROR_CODES.PURPOSE_UNCLASSIFIED,
        `Secret purpose ${purpose} is not classified as per-tenant or shared`,
      );
    if (modelSecretRefs.has(ref) && secretClass !== "shared")
      throw new TenantConfigurationError(
        TENANT_CONFIGURATION_ERROR_CODES.PURPOSE_CONFLICT,
        `Secret ${ref} is a per-tenant purpose but a model uses it`,
      );
    (secretClass === "shared" ? shared : perTenant).push({ ref, version });
  }
  return Object.freeze({ perTenant: Object.freeze(perTenant), shared: Object.freeze(shared) });
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierPattern(value: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeForPattern(value)}(?![A-Za-z0-9._-])`, "g");
}

function rewriteString(
  value: string,
  rules: {
    readonly baseStateRoot: string;
    readonly stateRoot: string;
    readonly pairs: readonly (readonly [RegExp, string])[];
  },
): string {
  let result = value;
  if (result === rules.baseStateRoot) result = rules.stateRoot;
  else if (result.startsWith(`${rules.baseStateRoot}${path.sep}`))
    result = `${rules.stateRoot}${result.slice(rules.baseStateRoot.length)}`;
  for (const [pattern, replacement] of rules.pairs) result = result.replace(pattern, replacement);
  return result;
}

function rewriteValue(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, rewrite));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        rewriteValue(entry, rewrite),
      ]),
    );
  return value;
}

function assertStateRootUsable(stateRoot: string, others: readonly string[]): void {
  if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot || stateRoot === "/")
    throw new TenantConfigurationError(
      TENANT_CONFIGURATION_ERROR_CODES.STATE_ROOT_INVALID,
      "A tenant state root must be a normalized absolute path",
    );
  for (const other of others) {
    const resolved = path.resolve(other);
    if (
      stateRoot === resolved ||
      stateRoot.startsWith(`${resolved}${path.sep}`) ||
      resolved.startsWith(`${stateRoot}${path.sep}`)
    )
      throw new TenantConfigurationError(
        TENANT_CONFIGURATION_ERROR_CODES.STATE_ROOT_NESTED,
        "A tenant state root must not be, contain or sit inside another tenant state root",
      );
  }
}

export function synthesizeTenantConfiguration(
  input: TenantConfigurationInput,
): SynthesizedTenantConfiguration {
  const now = input.now ?? new Date().toISOString();
  const base = parseProductConfiguration(input.base, now);
  classifySecretReferences(base);
  const stateRoot = input.stateRoot ?? path.join(input.tenantsRoot, input.tenant.tenantId);
  assertStateRootUsable(stateRoot, input.otherStateRoots ?? []);

  const sharedRefKeys = new Set(
    classifySecretReferences(base).shared.map(({ ref, version }) => `${ref}@${version}`),
  );
  const rules = {
    baseStateRoot: base.stateRoot,
    stateRoot,
    pairs: [
      [identifierPattern(base.deploymentId), input.tenant.deploymentId],
      [identifierPattern(base.ownerId), input.tenant.ownerId],
      [identifierPattern(base.agentId), input.tenant.agentId],
    ] as const,
  };
  const rewrite = (text: string) => rewriteString(text, rules);
  const source = structuredClone(input.base) as Record<string, unknown>;
  const rewritten = rewriteValue(
    Object.fromEntries(Object.entries(source).filter(([key]) => key !== "secretReferences")),
    rewrite,
  ) as Record<string, unknown>;
  const secretReferences = (source["secretReferences"] as Record<string, unknown>[]).map((entry) =>
    sharedRefKeys.has(`${String(entry["ref"])}@${String(entry["version"])}`)
      ? entry
      : (rewriteValue(entry, rewrite) as Record<string, unknown>),
  );
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(source))
    raw[key] = key === "secretReferences" ? secretReferences : rewritten[key];

  const configuration = parseProductConfiguration(raw, now);
  if (
    configuration.deploymentId !== input.tenant.deploymentId ||
    configuration.ownerId !== input.tenant.ownerId ||
    configuration.agentId !== input.tenant.agentId ||
    configuration.stateRoot !== stateRoot
  )
    throw new TenantConfigurationError(
      TENANT_CONFIGURATION_ERROR_CODES.BASE_VALUE_LEAKED,
      "The synthesized configuration does not carry the tenant identity",
    );
  const nonSharedText = JSON.stringify({
    ...raw,
    secretReferences: secretReferences.filter(
      (entry) => !sharedRefKeys.has(`${String(entry["ref"])}@${String(entry["version"])}`),
    ),
  });
  for (const [baseValue, tenantValue] of [
    [base.deploymentId, input.tenant.deploymentId],
    [base.ownerId, input.tenant.ownerId],
    [base.agentId, input.tenant.agentId],
    [base.stateRoot, stateRoot],
  ] as const)
    if (baseValue !== tenantValue && nonSharedText.includes(JSON.stringify(baseValue).slice(1, -1)))
      throw new TenantConfigurationError(
        TENANT_CONFIGURATION_ERROR_CODES.BASE_VALUE_LEAKED,
        "A value from the shared base configuration is still present",
      );
  const secrets = classifySecretReferences(configuration);
  const payloadKeys = configuration.secretReferences.filter(
    ({ purpose }) => purpose === "payload-encryption",
  );
  if (payloadKeys.length !== 1)
    throw new TenantConfigurationError(
      TENANT_CONFIGURATION_ERROR_CODES.PAYLOAD_KEY_COUNT,
      "A tenant configuration needs exactly one payload-encryption secret",
    );
  return Object.freeze({ raw: Object.freeze(raw), configuration, secrets });
}

export function listConfigurationKeyPaths(value: unknown, prefix = ""): readonly string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => listConfigurationKeyPaths(entry, `${prefix}[${index}]`));
  if (value !== null && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      `${prefix}.${key}`,
      ...listConfigurationKeyPaths(entry, `${prefix}.${key}`),
    ]);
  return [];
}

export function differingConfigurationFields(left: unknown, right: unknown): readonly string[] {
  const leftFlat = flattenLeaves(left);
  const rightFlat = flattenLeaves(right);
  return [...new Set([...leftFlat.keys(), ...rightFlat.keys()])]
    .filter((key) => leftFlat.get(key) !== rightFlat.get(key))
    .sort();
}

function flattenLeaves(value: unknown, prefix = "$", out = new Map<string, string>()) {
  if (Array.isArray(value))
    for (const [index, entry] of value.entries()) flattenLeaves(entry, `${prefix}[${index}]`, out);
  else if (value !== null && typeof value === "object")
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      flattenLeaves(entry, `${prefix}.${key}`, out);
  else out.set(prefix, JSON.stringify(value));
  return out;
}

export interface ProvisionedTenantKeys {
  readonly written: readonly string[];
  readonly kept: readonly string[];
  readonly needsProvisioning: readonly string[];
}

export async function provisionTenantKeyFiles(input: {
  readonly stateRoot: string;
  readonly configuration: ProductConfiguration;
}): Promise<ProvisionedTenantKeys> {
  const directory = path.join(input.stateRoot, "secrets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new TenantConfigurationError(
      TENANT_CONFIGURATION_ERROR_CODES.SECRET_DIRECTORY_UNSAFE,
      "The tenant secret directory must be private to the service account",
    );
  const classification = classifySecretReferences(input.configuration);
  const purposeByRef = new Map(
    input.configuration.secretReferences.map(({ ref, version, purpose }) => [
      `${ref}@${version}`,
      purpose,
    ]),
  );
  for (const { ref, version } of classification.perTenant) {
    assertReferencePart(ref, "reference");
    assertReferencePart(version, "version");
  }
  const written: string[] = [];
  const kept: string[] = [];
  const needsProvisioning: string[] = [];
  for (const { ref, version } of classification.perTenant) {
    const purpose = purposeByRef.get(`${ref}@${version}`) ?? "";
    if (!TENANT_RANDOM_KEY_PURPOSES.includes(purpose)) {
      needsProvisioning.push(`${ref}.${version}`);
      continue;
    }
    const target = path.join(directory, `${ref}.${version}`);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (
        !existing.isFile() ||
        (existing.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && existing.uid !== process.getuid())
      )
        throw new TenantConfigurationError(
          TENANT_CONFIGURATION_ERROR_CODES.SECRET_DIRECTORY_UNSAFE,
          "An existing tenant key file is not a private regular file",
        );
      kept.push(`${ref}.${version}`);
      continue;
    }
    const file = await open(target, "wx", 0o600);
    try {
      await file.writeFile(`${randomBytes(32).toString("base64")}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    written.push(`${ref}.${version}`);
  }
  return Object.freeze({ written, kept, needsProvisioning });
}
