import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxOperationBinding } from "@himawari-agent/execution-contracts";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { parseProductConfiguration } from "@himawari-agent/platform-node";
import { afterEach, expect, it, vi } from "vitest";
import { createProductionFileReadServices } from "../../apps/agent-service/src/production-file-read-services.ts";
import { productionSandboxScope } from "../fixtures/production-sandbox-scope.ts";
import {
  AGENT_ID,
  OWNER_ID,
  SERVICE_AUTHORITY,
  T1,
  T2,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const descriptor = {
  operation: "search",
  mode: "foreground",
  contract: { ref: "network-search", version: "1", kind: "network_only" },
  backendRef: "srt",
  scopeSource: "private_temp",
  directoryOperations: [],
  network: "grant_targets",
} satisfies SandboxOperationBinding;

it("admits a pure network grant with no directory lookup or shared workspace claim", async () => {
  const f = await productionSandboxScope(descriptor, (intent) => ({
    ...intent,
    targets: intent.targets.filter(
      (target) => !["directory-grant", "directory-path", "file-path"].includes(target.type),
    ),
  }));
  cleanups.push(f.close);
  const read = vi.spyOn(f.repository, "readScopedState");
  const prepared = await f.services.runtime.prepare(f.input, f.call);
  if (!("reservation" in prepared)) throw new Error("expected v2");
  expect(prepared.workspaces).toEqual([]);
  expect(prepared.reservation.workspaceConflictRefs).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  const admission = await f.services.brokerV2.preparations.reserve({
    ...prepared,
    invocation: f.input,
  });
  expect(admission.applied).toBe(true);
  if (admission.admission.phase !== "reserved") throw new Error("expected reserved");
  const send = await f.connect(admission.admission.plan.identity);
  const resolved = (await send({ kind: "resolve" })).resolvedScope;
  expect(resolved).toMatchObject({
    scope: { schemaVersion: "sandbox-scope.v2", directoryGrant: null },
    allowedDomains: ["example.com:443"],
  });
  expect(
    (await f.services.brokerV2.preparations.reserve({ ...prepared, invocation: f.input })).applied,
  ).toBe(false);
  await f.repository.authorizationStore().revokeGrant(f.input.authorizationRef ?? "", T1, "test");
  await expect(send({ kind: "resolve" })).rejects.toThrow();
});

it("keeps directory-scoped requests out of the private network contract", async () => {
  const f = await productionSandboxScope(descriptor);
  cleanups.push(f.close);
  const before = await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID);
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
  expect(await f.repository.authorizationStore().listGrants(OWNER_ID, AGENT_ID)).toEqual(before);
  f.setNow(T2);
  await expect(f.services.runtime.prepare(f.input, f.call)).rejects.toThrow();
});

it("resolves the production public search route without consulting directory state", async () => {
  const f = await productionSandboxScope(descriptor, (intent) => ({
    ...intent,
    targets: intent.targets.filter((target) => target.type !== "directory-grant"),
  }));
  cleanups.push(f.close);
  const config = parseProductConfiguration(
    JSON.parse(
      await readFile(
        new URL("./fixtures/file-summary/configuration.json", import.meta.url),
        "utf8",
      ),
    ),
    T1,
  );
  if (!config.runPolicy) throw new Error("fixture policy missing");
  const route = {
    scopeSource: "private_temp" as const,
    hostId: f.host.binding.hostId,
    workerInstanceId: SERVICE_AUTHORITY.workerInstanceId,
    capabilityRef: "search",
    capabilityVersion: "1",
    maximumBytes: 4096,
  };
  const services = createProductionFileReadServices({
    configuration: {
      ...config,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      modelDescriptors: [f.model],
      runPolicy: { ...config.runPolicy, publicSearch: route },
    },
    repository: f.repository,
    authority: () => SERVICE_AUTHORITY,
    clock: { now: () => T1 },
    ids: { next: (prefix) => `${prefix}:search-binding` },
  });
  const read = vi.spyOn(f.repository, "readScopedState");
  const database = openQualifiedDatabase(path.join(f.f.resource.stateRoot, "product.sqlite"));
  try {
    database
      .prepare(
        `INSERT INTO thread_messages (id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref, classification, committed_at, run_id) VALUES ('fixture-source', ?, ?, 'thread-capability-invocation', 0, 1, 'owner', 'payload-capability-invocation-trigger', 'private', ?, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, T1, f.call.runId);
  } finally {
    database.close();
  }
  expect(await services.binding({ ...f.call, capabilityRef: "search.web_search" })).toMatchObject({
    grant: null,
    hostId: route.hostId,
    modelRef: f.model.ref,
  });
  expect(read).not.toHaveBeenCalled();
});
