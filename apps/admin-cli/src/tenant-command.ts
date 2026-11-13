import { access, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMigrations,
  assertTenantIdentifiers,
  initializeProductIdentity,
  loadBundledMigrations,
  openQualifiedDatabase,
  ROSTER_FILE_NAME,
  RosterStore,
  type TenantIdentifiers,
  type TenantRecord,
} from "@himawari-agent/persistence-sqlite";
import {
  differingConfigurationFields,
  JsonFileConfigurationPort,
  parseProductConfiguration,
  synthesizeTenantConfiguration,
} from "@himawari-agent/platform-node";

export const TENANT_COMMAND_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "TENANT_ARGUMENT_INVALID",
  ROSTER_MISSING: "TENANT_ROSTER_MISSING",
  ROSTER_UNSAFE: "TENANT_ROSTER_UNSAFE",
  NOT_FOUND: "TENANT_NOT_FOUND",
  NOT_PROVISIONED: "TENANT_NOT_PROVISIONED",
  CONFIGURATION_MISMATCH: "TENANT_CONFIGURATION_MISMATCH",
} as const);

const TENANT_FLAG = "--tenant";
const SHARED_ROOT_FLAG = "--shared-root";
const COMMANDS_WITHOUT_TENANT_TARGET = new Set(["init", "tenant"]);

export function tenantHostLayout(sharedRoot: string) {
  return Object.freeze({
    sharedRoot,
    rosterPath: path.join(sharedRoot, ROSTER_FILE_NAME),
    tenantsRoot: path.join(sharedRoot, "tenants"),
  });
}

export function tenantStateRoot(sharedRoot: string, tenantId: string): string {
  return path.join(tenantHostLayout(sharedRoot).tenantsRoot, tenantId);
}

function absolutePathArgument(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value)
    throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  return value;
}

async function openExistingRoster(sharedRoot: string): Promise<RosterStore> {
  const { rosterPath } = tenantHostLayout(sharedRoot);
  const info = await lstat(rosterPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(TENANT_COMMAND_ERROR_CODES.ROSTER_MISSING);
    throw error;
  });
  if (
    !info.isFile() ||
    (info.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new Error(TENANT_COMMAND_ERROR_CODES.ROSTER_UNSAFE);
  return RosterStore.open(rosterPath);
}

async function requireTenant(sharedRoot: string, tenantId: string): Promise<TenantRecord> {
  const roster = await openExistingRoster(sharedRoot);
  try {
    const tenant = roster.findByTenantId(tenantId);
    if (!tenant) throw new Error(TENANT_COMMAND_ERROR_CODES.NOT_FOUND);
    return tenant;
  } finally {
    roster.close();
  }
}

async function tenantConfigurationPath(sharedRoot: string, tenant: TenantRecord): Promise<string> {
  const stateRoot = tenantStateRoot(sharedRoot, tenant.tenantId);
  const configurationPath = path.join(stateRoot, "configuration.json");
  await access(configurationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(TENANT_COMMAND_ERROR_CODES.NOT_PROVISIONED);
    throw error;
  });
  const stored = await new JsonFileConfigurationPort(configurationPath).load();
  if (
    stored.stateRoot !== stateRoot ||
    stored.ownerId !== tenant.ownerId ||
    stored.agentId !== tenant.agentId ||
    stored.deploymentId !== tenant.deploymentId
  )
    throw new Error(TENANT_COMMAND_ERROR_CODES.CONFIGURATION_MISMATCH);
  return configurationPath;
}

export async function resolveTenantArguments(
  arguments_: readonly string[],
): Promise<readonly string[]> {
  const tenantIndex = arguments_.indexOf(TENANT_FLAG);
  if (tenantIndex < 0 || COMMANDS_WITHOUT_TENANT_TARGET.has(arguments_[0] ?? "")) return arguments_;
  const rootIndex = arguments_.indexOf(SHARED_ROOT_FLAG);
  if (
    arguments_.includes("--config") ||
    rootIndex < 0 ||
    arguments_.lastIndexOf(TENANT_FLAG) !== tenantIndex ||
    arguments_.lastIndexOf(SHARED_ROOT_FLAG) !== rootIndex ||
    Math.abs(rootIndex - tenantIndex) < 2
  )
    throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const tenantId = arguments_[tenantIndex + 1];
  const sharedRoot = absolutePathArgument(arguments_[rootIndex + 1]);
  if (!tenantId || tenantId.startsWith("--"))
    throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const tenant = await requireTenant(sharedRoot, tenantId);
  const configurationPath = await tenantConfigurationPath(sharedRoot, tenant);
  const result: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (index === tenantIndex) {
      result.push("--config", configurationPath);
      index += 1;
    } else if (index === rootIndex) {
      index += 1;
    } else {
      result.push(arguments_[index] as string);
    }
  }
  return result;
}

export async function verifyTenantIdentifiersOnRealDatabase(
  identifiers: TenantIdentifiers,
): Promise<void> {
  assertTenantIdentifiers(identifiers);
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-tenant-identity-"));
  try {
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      applyMigrations(database, await loadBundledMigrations());
      initializeProductIdentity(database, { ...identifiers, now: new Date().toISOString() });
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseOptions(
  arguments_: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 2; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name || !allowed.includes(name) || !value || value.startsWith("--") || values.has(name))
      throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    values.set(name, value);
  }
  return values;
}

export async function runTenantCommand(arguments_: readonly string[]): Promise<unknown> {
  if (arguments_[1] === "list") {
    const values = parseOptions(arguments_, [SHARED_ROOT_FLAG]);
    const sharedRoot = absolutePathArgument(values.get(SHARED_ROOT_FLAG));
    const roster = await openExistingRoster(sharedRoot);
    try {
      return Object.freeze({
        schemaVersion: 1,
        command: "tenant.list",
        revision: roster.revision(),
        tenants: roster.list().map(({ externalSubjectRef, ...tenant }) => ({
          ...tenant,
          bound: externalSubjectRef !== null,
        })),
      });
    } finally {
      roster.close();
    }
  }
  if (arguments_[1] === "check") {
    const values = parseOptions(arguments_, [SHARED_ROOT_FLAG, TENANT_FLAG, "--base-config"]);
    const sharedRoot = absolutePathArgument(values.get(SHARED_ROOT_FLAG));
    const basePath = absolutePathArgument(values.get("--base-config"));
    const tenantId = values.get(TENANT_FLAG);
    if (!tenantId) throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    const roster = await openExistingRoster(sharedRoot);
    let tenant: TenantRecord | undefined;
    let others: readonly TenantRecord[];
    try {
      tenant = roster.findByTenantId(tenantId);
      others = roster.list().filter((entry) => entry.tenantId !== tenantId);
    } finally {
      roster.close();
    }
    if (!tenant) throw new Error(TENANT_COMMAND_ERROR_CODES.NOT_FOUND);
    await new JsonFileConfigurationPort(basePath).load();
    const now = new Date().toISOString();
    const synthesized = synthesizeTenantConfiguration({
      base: JSON.parse(await readFile(basePath, "utf8")),
      tenant,
      tenantsRoot: tenantHostLayout(sharedRoot).tenantsRoot,
      otherStateRoots: others.map((entry) => tenantStateRoot(sharedRoot, entry.tenantId)),
      now,
    });
    await verifyTenantIdentifiersOnRealDatabase(tenant);
    const storedPath = path.join(synthesized.configuration.stateRoot, "configuration.json");
    const stored = await readFile(storedPath, "utf8").then(
      (text) => JSON.parse(text) as unknown,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    return Object.freeze({
      schemaVersion: 1,
      command: "tenant.check",
      tenantId,
      stateRoot: synthesized.configuration.stateRoot,
      perTenantSecrets: synthesized.secrets.perTenant.map(
        ({ ref, version }) => `${ref}.${version}`,
      ),
      sharedSecrets: synthesized.secrets.shared.map(({ ref, version }) => `${ref}.${version}`),
      storedConfiguration:
        stored === undefined
          ? { present: false }
          : {
              present: true,
              differingFields: differingConfigurationFields(
                synthesized.configuration,
                parseProductConfiguration(stored, now),
              ),
            },
    });
  }
  throw new Error(TENANT_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
}
