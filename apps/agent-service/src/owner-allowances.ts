import { createHash } from "node:crypto";
import {
  ApplicationPortError,
  type AuthorityFence,
  type AuthorizationStorePort,
  type ClockPort,
  type GovernedActionIntent,
  type GovernedApprovalRequest,
  type IdempotentAgentCommand,
  type JsonObject,
  POLICY_FACT_CODES,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import {
  APPROVAL_ALLOWANCE_INTENT_PREFIX,
  type GatewayV2Command,
} from "@himawari-agent/gateway-contracts";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { isConflict } from "./context-external-content.js";

export const OWNER_ALLOWANCE_SCOPES = ["this_task", "days", "always"] as const;
export type OwnerAllowanceScope = (typeof OWNER_ALLOWANCE_SCOPES)[number];

export const OWNER_ALLOWANCE_DEFAULT_DAYS = 7;
export const OWNER_ALLOWANCE_MAXIMUM_DAYS = 90;

const KEY_PREFIX = "owner-allowance:";
const INDEX_KEY = "owner-allowances:index";
const ID_PREFIX = "allowance:";
const DAY_MS = 86_400_000;
const TITLE_LIMIT = 120;
const WRITE_ATTEMPTS = 3;

export interface OwnerAllowanceView {
  readonly allowanceId: string;
  readonly allowFor: OwnerAllowanceScope;
  readonly title: string;
  readonly operation: string;
  readonly recipients: readonly string[];
  readonly threadId: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

interface AllowanceValue {
  readonly enabled: boolean;
  readonly allowFor: OwnerAllowanceScope;
  readonly scopeKey: string;
  readonly title: string;
  readonly operation: string;
  readonly recipients: readonly string[];
  readonly threadId: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly approvalRequestId: string;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function factCodes(intent: GovernedActionIntent): readonly string[] {
  return (intent.deterministicFacts ?? []).map(({ code }) => code);
}

function actionScope(intent: GovernedActionIntent): string {
  return digest([
    intent.capabilityRef,
    intent.operation,
    intent.actionKind,
    intent.disclosure,
    intent.sideEffect,
    [...intent.recipients].sort(),
    intent.targets
      .filter(({ type }) => type !== "input-digest")
      .map(({ type, ref }) => `${type}\u0000${ref}`)
      .sort(),
  ]);
}

function allowanceId(scopeKey: string, threadId: string | null): string {
  return `${ID_PREFIX}${digest([scopeKey, threadId]).slice(0, 48)}`;
}

export function allowanceNotOffered(intent: GovernedActionIntent): string | null {
  if (intent.estimatedCostMicros > 0 || intent.actionKind === "PURCHASE_OR_FUNDS")
    return "ALLOWANCE_SPENDING_ONCE_ONLY";
  if (intent.credentialOrAccessChange) return "ALLOWANCE_CREDENTIAL_ONCE_ONLY";
  if (factCodes(intent).includes(POLICY_FACT_CODES.ownerPresenceRequired))
    return "ALLOWANCE_OWNER_PRESENCE_ONCE_ONLY";
  if (!intent.id?.startsWith(APPROVAL_ALLOWANCE_INTENT_PREFIX))
    return "ALLOWANCE_ACTION_ASKS_EVERY_TIME";
  return null;
}

export class OwnerAllowances {
  readonly #configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly #state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
  readonly #store: Pick<AuthorizationStorePort, "getApproval">;
  readonly #authority: () => AuthorityFence;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
    readonly state: Pick<SqliteProductStateRepository, "readScopedState" | "commitStateAndEvents">;
    readonly store: Pick<AuthorizationStorePort, "getApproval">;
    readonly authority: () => AuthorityFence;
    readonly clock: ClockPort;
  }) {
    this.#configuration = options.configuration;
    this.#state = options.state;
    this.#store = options.store;
    this.#authority = options.authority;
    this.#clock = options.clock;
  }

  #read(key: string) {
    const { ownerId, agentId } = this.#configuration;
    return this.#state.readScopedState(ownerId, agentId, key);
  }

  async #commit(
    key: string,
    expectedRevision: number | null,
    value: JsonObject,
    commandType: string,
  ): Promise<void> {
    const { ownerId, agentId } = this.#configuration;
    await this.#state.commitStateAndEvents({
      command: {
        ownerId,
        agentId,
        commandType,
        idempotencyKey:
          `${key}:${expectedRevision ?? 0}:${digest(value).slice(0, 16)}` as IdempotentAgentCommand["idempotencyKey"],
        commandFingerprint: digest([expectedRevision, value]),
        authority: this.#authority(),
      },
      state: { key, expectedRevision, value },
      events: [],
      resultRef: key,
      committedAt: this.#clock.now(),
    });
  }

  async #retry(write: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await write();
        return;
      } catch (error) {
        if (!isConflict(error) || attempt >= WRITE_ATTEMPTS - 1) throw error;
      }
    }
  }

  async #index(change: (keys: readonly string[]) => readonly string[]): Promise<void> {
    await this.#retry(async () => {
      const record = await this.#read(INDEX_KEY);
      const current = Array.isArray(record?.value["keys"])
        ? (record.value["keys"] as unknown[]).filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      const next = [...new Set(change(current))].sort();
      if (next.length === current.length && next.every((key, index) => key === current[index]))
        return;
      await this.#commit(
        INDEX_KEY,
        record?.revision ?? null,
        { keys: next },
        "authorization.owner_allowance.index",
      );
    });
  }

  async set(input: {
    readonly approvalRequestId: string;
    readonly allowFor: OwnerAllowanceScope;
    readonly days: number | null;
  }): Promise<string> {
    const { ownerId, agentId } = this.#configuration;
    const approval = (await this.#store.getApproval(input.approvalRequestId)) as
      | GovernedApprovalRequest
      | undefined;
    if (
      !approval ||
      approval.ownerId !== ownerId ||
      approval.agentId !== agentId ||
      !("contractVersion" in approval.intentSnapshot)
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "ALLOWANCE_APPROVAL_NOT_FOUND");
    if (approval.status !== "approved" || approval.policyAuthorization)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "ALLOWANCE_APPROVAL_NOT_OWNER_APPROVED",
      );
    const intent = approval.intentSnapshot;
    const refused = allowanceNotOffered(intent);
    if (refused) throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, refused);
    const days = input.allowFor === "days" ? (input.days ?? OWNER_ALLOWANCE_DEFAULT_DAYS) : null;
    if (
      days !== null &&
      (!Number.isSafeInteger(days) || days < 1 || days > OWNER_ALLOWANCE_MAXIMUM_DAYS)
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "ALLOWANCE_DAYS_INVALID");
    if (input.allowFor !== "days" && input.days !== null)
      throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, "ALLOWANCE_DAYS_INVALID");
    const threadId = input.allowFor === "this_task" ? intent.threadId : null;
    if (input.allowFor === "this_task" && !threadId)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "ALLOWANCE_TASK_UNAVAILABLE",
      );
    const now = this.#clock.now();
    const scopeKey = actionScope(intent);
    const id = allowanceId(scopeKey, threadId);
    const key = `${KEY_PREFIX}${id}`;
    const value: AllowanceValue = {
      enabled: true,
      allowFor: input.allowFor,
      scopeKey,
      title: (approval.display?.displayTitle ?? intent.operation).slice(0, TITLE_LIMIT),
      operation: intent.operation,
      recipients: [...intent.recipients].sort(),
      threadId,
      expiresAt: days === null ? null : new Date(Date.parse(now) + days * DAY_MS).toISOString(),
      createdAt: now,
      approvalRequestId: approval.id,
    };
    await this.#index((keys) => [...keys, key]);
    await this.#retry(async () => {
      const record = await this.#read(key);
      if (
        record?.value["enabled"] === true &&
        record.value["approvalRequestId"] === approval.id &&
        record.value["allowFor"] === input.allowFor
      )
        return;
      await this.#commit(
        key,
        record?.revision ?? null,
        { ...value, recipients: [...value.recipients] },
        "authorization.owner_allowance.set",
      );
    });
    return id;
  }

  handles(
    command: GatewayV2Command,
  ): command is Extract<GatewayV2Command, { readonly type: "approval.allowance.set" }> {
    return command.type === "approval.allowance.set";
  }

  async execute(
    command: Extract<GatewayV2Command, { readonly type: "approval.allowance.set" }>,
  ): Promise<{ readonly resultRef: string; readonly replayed: false }> {
    return { resultRef: await this.set(command.payload), replayed: false };
  }

  async revoke(id: string): Promise<void> {
    if (!id.startsWith(ID_PREFIX))
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "ALLOWANCE_NOT_FOUND");
    const key = `${KEY_PREFIX}${id}`;
    await this.#retry(async () => {
      const record = await this.#read(key);
      if (!record)
        throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "ALLOWANCE_NOT_FOUND");
      if (record.value["enabled"] !== true) return;
      await this.#commit(
        key,
        record.revision,
        { ...record.value, enabled: false, revokedAt: this.#clock.now() },
        "authorization.owner_allowance.revoke",
      );
    });
    await this.#index((keys) => keys.filter((existing) => existing !== key));
  }

  async list(): Promise<readonly OwnerAllowanceView[]> {
    const index = await this.#read(INDEX_KEY);
    const keys = Array.isArray(index?.value["keys"])
      ? (index.value["keys"] as unknown[]).filter((key): key is string => typeof key === "string")
      : [];
    const now = this.#clock.now();
    const views: OwnerAllowanceView[] = [];
    for (const key of keys) {
      const record = await this.#read(key);
      const value = record?.value as Partial<AllowanceValue> | undefined;
      if (!value || value.enabled !== true) continue;
      if (typeof value.expiresAt === "string" && value.expiresAt <= now) continue;
      views.push({
        allowanceId: key.slice(KEY_PREFIX.length),
        allowFor: value.allowFor as OwnerAllowanceScope,
        title: String(value.title ?? ""),
        operation: String(value.operation ?? ""),
        recipients: Array.isArray(value.recipients) ? [...value.recipients] : [],
        threadId: typeof value.threadId === "string" ? value.threadId : null,
        expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
        createdAt: String(value.createdAt ?? ""),
      });
    }
    return views.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.allowanceId.localeCompare(right.allowanceId),
    );
  }

  async match(
    intent: GovernedActionIntent,
  ): Promise<{ readonly key: string; readonly revision: number } | undefined> {
    if (allowanceNotOffered(intent)) return undefined;
    const scopeKey = actionScope(intent);
    const external = factCodes(intent).includes(POLICY_FACT_CODES.contextExternalContent);
    const now = this.#clock.now();
    const threads = [...(intent.threadId ? [intent.threadId] : []), ...(external ? [] : [null])];
    for (const threadId of threads) {
      const key = `${KEY_PREFIX}${allowanceId(scopeKey, threadId)}`;
      const record = await this.#read(key);
      const value = record?.value as Partial<AllowanceValue> | undefined;
      if (!record || !value || value.enabled !== true || value.scopeKey !== scopeKey) continue;
      if ((value.allowFor === "this_task") !== (threadId !== null)) continue;
      if (typeof value.expiresAt === "string" && value.expiresAt <= now) continue;
      return { key, revision: record.revision };
    }
    return undefined;
  }
}
