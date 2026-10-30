import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import {
  ControlCenterBrowserStorage,
  SHARED_OWNER_PREFERENCE_FIELDS,
} from "../../apps/control-center/src/browser-storage.ts";

const SOURCE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/control-center/src",
);

const DEVICE_ONLY_KEYS = [
  "draft.",
  "lastCursor",
  "threadLastCursor",
  "mutation.",
  "submission.",
  "governanceMutation.",
  "preferencesUnsynced",
  "preferencesRevision",
];
const SERVER_COPY_CACHE_KEYS = ["preferences", "locale"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as Storage;
}

describe("[I-16] every owner setting lives on the server", () => {
  it("reaches browser storage only through the storage class", () => {
    const users = sourceFiles(SOURCE_ROOT)
      .filter((file) =>
        /\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(SOURCE_ROOT, file));
    expect(users).toEqual(["app.tsx"]);
  });

  it("keeps in the browser only device state and caches of the server copy", () => {
    const source = readFileSync(path.join(SOURCE_ROOT, "browser-storage.ts"), "utf8");
    const keys = [...source.matchAll(/\$\{KEY_PREFIX\}\.([A-Za-z]+\.?)/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(
      [...new Set(keys)].filter(
        (key) =>
          !DEVICE_ONLY_KEYS.includes(key as string) &&
          !SERVER_COPY_CACHE_KEYS.includes(key as string),
      ),
    ).toEqual([]);
  });

  it("sends every page setting to the server and the server keeps every one", () => {
    const storage = new ControlCenterBrowserStorage(memoryStorage());
    storage.savePreferences({
      theme: "light",
      accent: "teal",
      name: "Andy",
      modelRef: "model-second",
      thinkingLevel: "high",
    });
    const pageFields = [...Object.keys(storage.readPreferences()), "locale"];
    expect(
      pageFields.filter((field) => !SHARED_OWNER_PREFERENCE_FIELDS.includes(field as never)),
    ).toEqual([]);
    const envelope = {
      schemaVersion: "gateway.v2",
      kind: "snapshot",
      type: "owner.preferences.snapshot",
      messageId: "message-settings",
      correlationId: "correlation-settings",
      causationId: null,
      dataClassification: "private",
      risk: "medium",
      authorizationRef: null,
      scope: { ownerId: "owner", agentId: "agent" },
      authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "system", actorId: "agent-service" },
    };
    const payload = {
      name: "Andy",
      locale: "ja",
      accent: "teal",
      theme: "light",
      modelRef: "model-second",
      thinkingLevel: "high",
      revision: 1,
      updatedAt: "2026-10-30T00:00:00.000Z",
    };
    expect(Object.keys(payload).sort()).toEqual(
      [...SHARED_OWNER_PREFERENCE_FIELDS, "revision", "updatedAt"].sort(),
    );
    expect(() => gatewayV2MessageSchema.parse({ ...envelope, payload })).not.toThrow();
    for (const field of SHARED_OWNER_PREFERENCE_FIELDS) {
      const { [field]: _missing, ...without } = payload;
      expect(() => gatewayV2MessageSchema.parse({ ...envelope, payload: without })).toThrow();
    }
  });
});
