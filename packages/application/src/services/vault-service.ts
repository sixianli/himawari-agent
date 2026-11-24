import {
  VAULT_LIMITS,
  VAULT_PHONE_ONLY_FIELDS,
  type VaultCryptoPort,
  type VaultEphemeralKey,
  type VaultItemInput,
  type VaultItemKind,
  type VaultItemRecord,
  type VaultManifestRecord,
  type VaultNotifierPort,
  type VaultReleaseRequestRecord,
  type VaultScope,
  type VaultStorePort,
  type VaultUsageListed,
} from "../ports/vault.js";
import {
  VAULT_PATTERNS,
  vaultBase64,
  vaultFieldAad,
  vaultFieldsValid,
  vaultKind,
  vaultName,
  vaultOrigin,
  vaultReleaseAad,
  vaultTextHasHiddenCharacter,
  vaultVersion,
} from "./vault-contract.js";

export const VAULT_ERROR_CODES = Object.freeze({
  INPUT_INVALID: "VAULT_INPUT_INVALID",
  ITEM_NOT_FOUND: "VAULT_ITEM_NOT_FOUND",
  ORIGIN_NOT_ALLOWED: "VAULT_ORIGIN_NOT_ALLOWED",
  BACKGROUND_NOT_ALLOWED: "VAULT_BACKGROUND_NOT_ALLOWED",
  MANIFEST_CONFLICT: "VAULT_MANIFEST_CONFLICT",
  VERSION_NOT_NEWER: "VAULT_VERSION_NOT_NEWER",
  TOO_MANY_ITEMS: "VAULT_TOO_MANY_ITEMS",
  REQUEST_NOT_FOUND: "VAULT_REQUEST_NOT_FOUND",
  REQUEST_MISMATCH: "VAULT_REQUEST_MISMATCH",
  REQUEST_CLOSED: "VAULT_REQUEST_CLOSED",
  CONFIRMATION_REQUIRED: "VAULT_CONFIRMATION_REQUIRED",
  RELEASE_UNREADABLE: "VAULT_RELEASE_UNREADABLE",
} as const);

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[keyof typeof VAULT_ERROR_CODES];

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly status: number;
  constructor(code: VaultErrorCode, status: number) {
    super(code);
    this.name = "VaultError";
    this.code = code;
    this.status = status;
  }
}

export interface VaultListedItem {
  readonly id: string;
  readonly name: string;
  readonly kind: VaultItemKind;
  readonly sites: readonly string[];
}

export interface VaultTotpCode {
  readonly at: number;
  readonly code: string;
}

export interface ReleasedVaultItem {
  readonly itemId: string;
  readonly fields: ReadonlyMap<string, Buffer>;
  readonly totp: readonly VaultTotpCode[];
}

export interface ReleasedVaultSecrets {
  readonly requestId: string;
  readonly origin: string;
  readonly items: readonly ReleasedVaultItem[];
  wipe(): void;
}

export type VaultReleaseOutcome =
  | { readonly kind: "approved"; readonly secrets: ReleasedVaultSecrets }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" };

export interface VaultServiceOptions {
  readonly store: VaultStorePort;
  readonly crypto: VaultCryptoPort;
  readonly notifier: VaultNotifierPort;
  readonly now: () => Date;
  readonly setTimer?: (callback: () => void, milliseconds: number) => { cancel(): void };
}

interface Waiter {
  readonly scope: VaultScope;
  readonly ephemeral: VaultEphemeralKey;
  readonly resolve: (outcome: VaultReleaseOutcome) => void;
  readonly timer: { cancel(): void };
}

function invalid(): never {
  throw new VaultError(VAULT_ERROR_CODES.INPUT_INVALID, 400);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !(key in value)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}

function stringArray(value: unknown, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string")
  )
    invalid();
  return value as string[];
}

function sameList(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseItem(value: unknown): VaultItemInput {
  const item = record(value);
  exactKeys(item, [
    "id",
    "name",
    "kind",
    "origins",
    "fields",
    "version",
    "backgroundAllowed",
    "wrappedKey",
    "ciphertexts",
  ]);
  const id =
    typeof item["id"] === "string" && VAULT_PATTERNS.itemId.test(item["id"])
      ? item["id"]
      : invalid();
  const name = vaultName(item["name"]) ?? invalid();
  const kind = vaultKind(item["kind"]) ?? invalid();
  const originsInput = stringArray(item["origins"], VAULT_LIMITS.originsPerItem);
  const origins = originsInput.map((origin) => vaultOrigin(origin) ?? invalid());
  if (origins.length === 0 || new Set(origins).size !== origins.length) invalid();
  const fields = stringArray(item["fields"], 8);
  if (!vaultFieldsValid(kind, fields)) invalid();
  const version = vaultVersion(item["version"]) ?? invalid();
  if (typeof item["backgroundAllowed"] !== "boolean") invalid();
  const wrappedKey = vaultBase64(item["wrappedKey"], 60, 60) ?? invalid();
  const ciphertextsInput = record(item["ciphertexts"]);
  exactKeys(ciphertextsInput, fields);
  const ciphertexts: Record<string, string> = {};
  for (const field of fields)
    ciphertexts[field] =
      vaultBase64(ciphertextsInput[field], 29, VAULT_LIMITS.ciphertextBytes) ?? invalid();
  return Object.freeze({
    id,
    name,
    kind,
    origins: Object.freeze([...origins].sort()),
    fields: Object.freeze([...fields].sort()),
    version,
    backgroundAllowed: item["backgroundAllowed"],
    wrappedKey,
    ciphertexts: Object.freeze(ciphertexts),
  });
}

export function listedVaultItems(items: readonly VaultItemRecord[]): readonly VaultListedItem[] {
  return Object.freeze(
    [...items]
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1,
      )
      .map((item) =>
        Object.freeze({
          id: item.id,
          name: item.name,
          kind: item.kind,
          sites: Object.freeze([...item.origins]),
        }),
      ),
  );
}

export class VaultService {
  readonly #options: VaultServiceOptions;
  readonly #waiters = new Map<string, Waiter>();

  constructor(options: VaultServiceOptions) {
    this.#options = options;
  }

  #now(): Date {
    return this.#options.now();
  }

  #timer(callback: () => void, milliseconds: number): { cancel(): void } {
    if (this.#options.setTimer) return this.#options.setTimer(callback, milliseconds);
    const handle = setTimeout(callback, milliseconds);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }

  async listForModel(scope: VaultScope): Promise<readonly VaultListedItem[]> {
    return listedVaultItems(await this.#options.store.listItems(scope));
  }

  async snapshot(scope: VaultScope): Promise<{
    readonly manifest: VaultManifestRecord | null;
    readonly items: readonly VaultItemRecord[];
    readonly pending: readonly VaultReleaseRequestRecord[];
  }> {
    await this.#expireOverdue(scope);
    const [manifest, items, pending] = await Promise.all([
      this.#options.store.readManifest(scope),
      this.#options.store.listItems(scope),
      this.#options.store.listPendingRequests({ ...scope, now: this.#now().toISOString() }),
    ]);
    return { manifest, items, pending };
  }

  async usage(scope: VaultScope, itemId: string | null): Promise<readonly VaultUsageListed[]> {
    if (itemId !== null && !VAULT_PATTERNS.itemId.test(itemId)) invalid();
    await this.#expireOverdue(scope);
    return this.#options.store.listUsage({ ...scope, itemId, limit: VAULT_LIMITS.usageListed });
  }

  async applyDeviceChange(scope: VaultScope, body: unknown): Promise<VaultManifestRecord> {
    const input = record(body);
    exactKeys(input, ["expectedManifestVersion", "manifest", "upserts", "deletes", "rotation"]);
    const expected = input["expectedManifestVersion"];
    if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) invalid();
    const manifestInput = record(input["manifest"]);
    exactKeys(manifestInput, ["version", "signature"]);
    const manifestVersion = vaultVersion(manifestInput["version"]) ?? invalid();
    if (manifestVersion !== expected + 1) invalid();
    const signature = vaultBase64(manifestInput["signature"], 32, 32) ?? invalid();
    if (!Array.isArray(input["upserts"]) || input["upserts"].length > VAULT_LIMITS.items) invalid();
    const upserts = input["upserts"].map(parseItem);
    const deletes = stringArray(input["deletes"], VAULT_LIMITS.items);
    if (deletes.some((id) => !VAULT_PATTERNS.itemId.test(id))) invalid();
    const touched = [...upserts.map((item) => item.id), ...deletes];
    if (new Set(touched).size !== touched.length) invalid();
    if (typeof input["rotation"] !== "boolean") invalid();
    const result = await this.#options.store.applyChange({
      ...scope,
      expectedManifestVersion: expected,
      manifest: { version: manifestVersion, signature },
      upserts,
      deletes,
      rotation: input["rotation"],
      maximumItems: VAULT_LIMITS.items,
      now: this.#now().toISOString(),
    });
    switch (result.kind) {
      case "applied":
        if (input["rotation"] || deletes.length > 0) this.#closeAll(scope);
        return result.manifest;
      case "manifest_conflict":
        throw new VaultError(VAULT_ERROR_CODES.MANIFEST_CONFLICT, 409);
      case "version_not_newer":
        throw new VaultError(VAULT_ERROR_CODES.VERSION_NOT_NEWER, 409);
      case "unknown_item":
        throw new VaultError(VAULT_ERROR_CODES.ITEM_NOT_FOUND, 404);
      case "too_many_items":
        throw new VaultError(VAULT_ERROR_CODES.TOO_MANY_ITEMS, 409);
    }
  }

  async requestRelease(
    input: VaultScope & {
      readonly runId: string | null;
      readonly itemIds: readonly string[];
      readonly origin: string;
      readonly pageVersion: string | null;
      readonly purpose: string;
      readonly background: boolean;
    },
  ): Promise<VaultReleaseOutcome> {
    const scope: VaultScope = { ownerId: input.ownerId, agentId: input.agentId };
    const origin = vaultOrigin(input.origin) ?? invalid();
    if (input.itemIds.length === 0 || input.itemIds.length > VAULT_LIMITS.itemsPerRequest)
      invalid();
    if (new Set(input.itemIds).size !== input.itemIds.length) invalid();
    if (input.pageVersion !== null && !VAULT_PATTERNS.pageVersion.test(input.pageVersion))
      invalid();
    if (input.runId !== null && !VAULT_PATTERNS.runId.test(input.runId)) invalid();
    const purpose = [...input.purpose].slice(0, VAULT_LIMITS.purposeCharacters).join("");
    if (vaultTextHasHiddenCharacter(purpose)) invalid();
    const items = new Map(
      (await this.#options.store.listItems(scope)).map((item) => [item.id, item]),
    );
    const chosen = input.itemIds.map((id) => {
      const item = items.get(id);
      if (!item) throw new VaultError(VAULT_ERROR_CODES.ITEM_NOT_FOUND, 404);
      if (!item.origins.includes(origin))
        throw new VaultError(VAULT_ERROR_CODES.ORIGIN_NOT_ALLOWED, 403);
      if (input.background && !item.backgroundAllowed)
        throw new VaultError(VAULT_ERROR_CODES.BACKGROUND_NOT_ALLOWED, 403);
      return item;
    });
    const now = this.#now();
    const id = `vr_${this.#options.crypto.randomToken(16)}`;
    const nonce = this.#options.crypto.randomToken(32);
    const ephemeral = await this.#options.crypto.createEphemeral();
    const expiresAt = new Date(now.getTime() + VAULT_LIMITS.requestTtlSeconds * 1000).toISOString();
    try {
      await this.#options.store.createRequest({
        ...scope,
        id,
        runId: input.runId,
        purpose,
        itemIds: chosen.map((item) => item.id),
        itemVersions: chosen.map((item) => item.version),
        origin,
        pageVersion: input.pageVersion,
        ephemeralPublicKey: ephemeral.publicKey,
        nonce,
        createdAt: now.toISOString(),
        expiresAt,
      });
    } catch (error) {
      ephemeral.dispose();
      throw error;
    }
    const outcome = new Promise<VaultReleaseOutcome>((resolve) => {
      const timer = this.#timer(() => {
        void this.#expire(scope, id, nonce);
      }, VAULT_LIMITS.requestTtlSeconds * 1000);
      this.#waiters.set(id, { scope, ephemeral, resolve, timer });
    });
    await this.#options.notifier.approvalNeeded({ ...scope, requestId: id, expiresAt });
    return outcome;
  }

  async #expire(scope: VaultScope, id: string, nonce: string): Promise<void> {
    if (!this.#waiters.has(id)) return;
    const closed = await this.#options.store
      .decideRequest({
        ...scope,
        id,
        nonce,
        status: "expired",
        deviceId: null,
        now: this.#now().toISOString(),
        usage: "expired",
      })
      .then(
        (record) => record !== null,
        () => true,
      );
    if (closed) this.#settle(id, { kind: "expired" });
  }

  async #expireOverdue(scope: VaultScope): Promise<void> {
    const expired = await this.#options.store.expireOverdue({
      ...scope,
      now: this.#now().toISOString(),
    });
    for (const id of expired) this.#settle(id, { kind: "expired" });
  }

  #settle(id: string, outcome: VaultReleaseOutcome): void {
    const waiter = this.#waiters.get(id);
    if (!waiter) return;
    this.#waiters.delete(id);
    waiter.timer.cancel();
    waiter.ephemeral.dispose();
    waiter.resolve(outcome);
  }

  #closeAll(scope: VaultScope): void {
    for (const [id, waiter] of this.#waiters)
      if (waiter.scope.ownerId === scope.ownerId && waiter.scope.agentId === scope.agentId)
        this.#settle(id, { kind: "denied" });
  }

  async deny(scope: VaultScope, body: unknown): Promise<void> {
    const input = record(body);
    exactKeys(input, ["requestId", "nonce"]);
    const id =
      typeof input["requestId"] === "string" && VAULT_PATTERNS.requestId.test(input["requestId"])
        ? input["requestId"]
        : invalid();
    const nonce =
      typeof input["nonce"] === "string" && VAULT_PATTERNS.nonce.test(input["nonce"])
        ? input["nonce"]
        : invalid();
    const now = this.#now().toISOString();
    const closed = await this.#options.store.decideRequest({
      ...scope,
      id,
      nonce,
      status: "denied",
      deviceId: null,
      now,
      usage: "denied",
    });
    if (!closed) throw new VaultError(VAULT_ERROR_CODES.REQUEST_CLOSED, 410);
    this.#settle(id, { kind: "denied" });
  }

  async approve(
    scope: VaultScope,
    device: { readonly deviceId: string; readonly confirmed: boolean },
    body: unknown,
  ): Promise<void> {
    if (!device.confirmed) throw new VaultError(VAULT_ERROR_CODES.CONFIRMATION_REQUIRED, 401);
    const input = record(body);
    exactKeys(input, [
      "requestId",
      "nonce",
      "deviceId",
      "itemIds",
      "itemVersions",
      "origin",
      "pageVersion",
      "ephemeralPublicKey",
      "expiresAt",
      "sealed",
    ]);
    const id =
      typeof input["requestId"] === "string" && VAULT_PATTERNS.requestId.test(input["requestId"])
        ? input["requestId"]
        : invalid();
    const stored = await this.#options.store.readRequest({ ...scope, id });
    if (!stored) throw new VaultError(VAULT_ERROR_CODES.REQUEST_NOT_FOUND, 404);
    const itemVersions = input["itemVersions"];
    if (
      input["nonce"] !== stored.nonce ||
      input["deviceId"] !== device.deviceId ||
      !Array.isArray(input["itemIds"]) ||
      !sameList(input["itemIds"], stored.itemIds) ||
      !Array.isArray(itemVersions) ||
      !sameList(itemVersions, stored.itemVersions) ||
      input["origin"] !== stored.origin ||
      input["pageVersion"] !== stored.pageVersion ||
      input["ephemeralPublicKey"] !== stored.ephemeralPublicKey ||
      input["expiresAt"] !== stored.expiresAt
    )
      throw new VaultError(VAULT_ERROR_CODES.REQUEST_MISMATCH, 409);
    if (!Array.isArray(input["sealed"]) || input["sealed"].length !== stored.itemIds.length)
      invalid();
    const sealed = input["sealed"].map((entry, index) => {
      const value = record(entry);
      exactKeys(value, ["itemId", "enc", "ciphertext"]);
      if (value["itemId"] !== stored.itemIds[index])
        throw new VaultError(VAULT_ERROR_CODES.REQUEST_MISMATCH, 409);
      return {
        itemId: stored.itemIds[index] as string,
        version: stored.itemVersions[index] as number,
        enc: vaultBase64(value["enc"], 65, 65) ?? invalid(),
        ciphertext: vaultBase64(value["ciphertext"], 17, 4_096) ?? invalid(),
      };
    });
    const waiter = this.#waiters.get(id);
    if (!waiter) throw new VaultError(VAULT_ERROR_CODES.REQUEST_CLOSED, 410);
    this.#waiters.delete(id);
    waiter.timer.cancel();
    const now = this.#now().toISOString();
    const deliver = (outcome: VaultReleaseOutcome) => {
      waiter.ephemeral.dispose();
      waiter.resolve(outcome);
    };
    const released: ReleasedVaultItem[] = [];
    const wipeAll = () => {
      for (const item of released) for (const value of item.fields.values()) value.fill(0);
    };
    const decide = (status: "approved" | "denied", usage: "approved" | "failed") =>
      this.#options.store.decideRequest({
        ...scope,
        id,
        nonce: stored.nonce,
        status,
        deviceId: device.deviceId,
        now,
        usage,
      });
    let decrypted = false;
    let decided: VaultReleaseRequestRecord | null;
    try {
      const items = new Map(
        (await this.#options.store.listItems(scope)).map((item) => [item.id, item]),
      );
      for (const entry of sealed) {
        const item = items.get(entry.itemId);
        if (!item || item.version !== entry.version)
          throw new VaultError(VAULT_ERROR_CODES.REQUEST_MISMATCH, 409);
        const opened = Buffer.from(
          await waiter.ephemeral.open(
            { enc: entry.enc, ciphertext: entry.ciphertext },
            vaultReleaseAad(id, entry.itemId, entry.version),
          ),
        );
        let itemKey: Buffer | undefined;
        let totp: VaultTotpCode[] = [];
        try {
          const parsed = record(JSON.parse(opened.toString("utf8")));
          exactKeys(parsed, ["itemKey"], ["totp"]);
          const key = vaultBase64(parsed["itemKey"], 32, 32) ?? invalid();
          if (parsed["totp"] !== undefined) totp = parseTotp(parsed["totp"]);
          itemKey = Buffer.from(key, "base64");
        } finally {
          opened.fill(0);
        }
        const fields = new Map<string, Buffer>();
        try {
          for (const field of item.fields) {
            if (VAULT_PHONE_ONLY_FIELDS.includes(field)) continue;
            const ciphertext = item.ciphertexts[field];
            if (ciphertext === undefined)
              throw new VaultError(VAULT_ERROR_CODES.RELEASE_UNREADABLE, 422);
            const plain = this.#options.crypto.decryptField(
              itemKey,
              ciphertext,
              vaultFieldAad(item.id, field, item.version),
            );
            fields.set(field, Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength));
          }
        } catch (error) {
          for (const value of fields.values()) value.fill(0);
          throw error;
        } finally {
          itemKey.fill(0);
        }
        released.push(Object.freeze({ itemId: item.id, fields, totp: Object.freeze(totp) }));
      }
      decrypted = true;
      decided = await decide("approved", "approved");
    } catch (error) {
      wipeAll();
      try {
        await decide("denied", "failed");
      } finally {
        deliver({ kind: "denied" });
      }
      if (error instanceof VaultError || decrypted) throw error;
      throw new VaultError(VAULT_ERROR_CODES.RELEASE_UNREADABLE, 422);
    }
    if (!decided) {
      wipeAll();
      let outcome: VaultReleaseOutcome = { kind: "expired" };
      try {
        await this.#expireOverdue(scope);
        const closed = await this.#options.store.readRequest({ ...scope, id });
        if (closed?.status === "denied") outcome = { kind: "denied" };
      } finally {
        deliver(outcome);
      }
      throw new VaultError(VAULT_ERROR_CODES.REQUEST_CLOSED, 410);
    }
    deliver({
      kind: "approved",
      secrets: Object.freeze({
        requestId: id,
        origin: stored.origin,
        items: Object.freeze(released),
        wipe: wipeAll,
      }),
    });
  }

  async recordFill(
    scope: VaultScope,
    secrets: ReleasedVaultSecrets,
    outcome: "filled" | "failed",
  ): Promise<void> {
    const at = this.#now().toISOString();
    await this.#options.store.recordUsage({
      ...scope,
      entries: secrets.items.map((item) => ({
        requestId: secrets.requestId,
        itemId: item.itemId,
        origin: secrets.origin,
        outcome,
        at,
      })),
    });
  }
}

function parseTotp(value: unknown): VaultTotpCode[] {
  if (!Array.isArray(value) || value.length > VAULT_LIMITS.totpCodes) invalid();
  return value.map((entry) => {
    const code = record(entry);
    exactKeys(code, ["at", "code"]);
    const at = code["at"];
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) invalid();
    if (typeof code["code"] !== "string" || !/^[0-9]{6,8}$/u.test(code["code"])) invalid();
    return Object.freeze({ at, code: code["code"] });
  });
}
