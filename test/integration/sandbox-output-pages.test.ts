import { createHash } from "node:crypto";
import type { SandboxExecutionRecord } from "@himawari-agent/application";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { afterEach, expect, it } from "vitest";
import { createProductionSandboxStream } from "../../apps/agent-service/src/production-sandbox-stream.ts";
import { createProductionSandboxOutput } from "../../apps/agent-service/src/production-sandbox-output.ts";
import { sandboxV2Admission } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(text = "first\u0000second\nlast") {
  const f = await openSandboxJournal();
  cleanups.push(f.close);
  const admission = sandboxV2Admission(f);
  f.database.close();
  let repository = await SqliteProductStateRepository.open({
    stateRoot: f.resource.stateRoot,
    minimumFreeBytes: 0,
    now: () => T1,
  });
  cleanups.push(() => repository.close());
  let payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
  const bytes = Buffer.from(text);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const payload = await f.protector.protect({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    ref: "original-output",
    contentType: "text/plain",
    dataClassification: "private",
    plaintext: bytes,
    createdAt: T1,
  });
  await payloads.put(payload);
  const record: SandboxExecutionRecord = {
    plan: { ...admission.plan, semanticFingerprint: "f".repeat(64) },
    facts: {
      ...admission.facts,
      environment: { ...admission.facts.environment, resourceRef: "task-fixture" },
      result: {
        schemaVersion: "sandbox-execution.v2",
        kind: "result",
        identity: admission.plan.identity,
        environmentId: admission.plan.environmentId,
        policyDigest: admission.facts.environment.policyDigest,
        contract: admission.plan.operationContract,
        occurredAt: T1,
        output: { ref: payload.ref, digest, byteLength: bytes.byteLength },
        completion: { type: "value" },
      },
    },
    workspaces: admission.workspaces,
    startedAt: T1,
    operationRevision: 1,
  };
  let next = 0;
  const outputOptions = () => ({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    payloads,
    protector: f.protector,
    artifacts: () => repository.runPayloadArtifactPort(OWNER_ID, AGENT_ID, SERVICE_AUTHORITY),
    ids: { next: () => `page:${++next}` },
    clock: { now: () => T1 },
  });
  const reader = () => createProductionSandboxOutput(outputOptions());
  const stream = () => createProductionSandboxStream(outputOptions());
  const read = async (ref: string) => {
    const saved = await payloads.get(ref);
    if (!saved) throw new Error("missing output");
    return Buffer.from(
      await f.protector.unprotect({ ownerId: OWNER_ID, agentId: AGENT_ID, payload: saved }),
    );
  };
  return {
    reader,
    stream,
    record,
    read,
    bytes,
    payloads,
    payload,
    reopen: async () => {
      await repository.close();
      repository = await SqliteProductStateRepository.open({
        stateRoot: f.resource.stateRoot,
        minimumFreeBytes: 0,
        now: () => T1,
      });
      payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    },
  };
}
it("persists bounded pages and resumes issued cursors without losing binary bytes", async () => {
  const f = await fixture();
  const query = { resourceRef: "task-fixture", cursor: null, limit: 5 };
  const first = await f.reader()(f.record, query);
  expect(first?.end).toBe(false);
  expect(await f.reader()(f.record, query)).toEqual(first);
  if (!first) throw new Error("missing page");
  const chunks = [await f.read(first.output.ref)];
  let cursor = first.nextCursor;
  await f.reopen();
  while (cursor) {
    const page = await f.reader()(f.record, { ...query, cursor });
    if (!page) throw new Error("missing page");
    expect(page.output.byteLength).toBeLessThanOrEqual(5);
    chunks.push(await f.read(page.output.ref));
    cursor = page.nextCursor;
  }
  expect(Buffer.concat(chunks)).toEqual(f.bytes);
});
it("rejects unissued, foreign-resource, foreign-invocation and changed-output cursors", async () => {
  const f = await fixture();
  const query = { resourceRef: "task-fixture", cursor: null, limit: 5 };
  const first = await f.reader()(f.record, query);
  if (!first?.nextCursor) throw new Error("missing cursor");
  await expect(
    f.reader()(f.record, { ...query, cursor: `sandbox-output-cursor:${"0".repeat(64)}` }),
  ).rejects.toThrow();
  await expect(
    f.reader()(f.record, { ...query, resourceRef: "other-task", cursor: first.nextCursor }),
  ).rejects.toThrow();
  await expect(
    f.reader()(
      { ...f.record, plan: { ...f.record.plan, semanticFingerprint: "e".repeat(64) } },
      { ...query, cursor: first.nextCursor },
    ),
  ).rejects.toThrow();
  await f.payloads.delete(f.payload.ref);
  await expect(f.reader()(f.record, { ...query, cursor: first.nextCursor })).rejects.toThrow();
});
it("distinguishes empty confirmed output from unavailable output", async () => {
  const f = await fixture("");
  const query = { resourceRef: "task-fixture", cursor: null, limit: 5 };
  expect(await f.reader()(f.record, query)).toMatchObject({
    end: true,
    nextCursor: null,
    output: { byteLength: 0 },
  });
  expect(
    await f.reader()({ ...f.record, facts: { ...f.record.facts, result: null } }, query),
  ).toBeNull();
});

it("persists a live output stream, polls issued positions and reads after restart and exit", async () => {
  const f = await fixture();
  const record = { ...f.record, plan: { ...f.record.plan, mode: "background" as const } };
  const query = { resourceRef: "task-fixture", cursor: null, limit: 2 };
  const waiting = await f.stream().output(record, query);
  expect(waiting).toMatchObject({ end: false, output: { byteLength: 0 } });
  const chunk = {
    index: 0,
    offset: 0,
    bytesBase64: Buffer.from("abCD").toString("base64"),
    end: false,
  };
  await f.stream().append(record, chunk);
  await f.stream().append(record, chunk);
  await expect(
    f.stream().append(record, { ...chunk, bytesBase64: Buffer.from("evil").toString("base64") }),
  ).rejects.toThrow();
  const first = await f.stream().output(record, { ...query, cursor: waiting.nextCursor });
  expect((await f.read(first.output.ref)).toString()).toBe("ab");
  expect(await f.stream().output(record, { ...query, cursor: waiting.nextCursor })).toEqual(first);
  await f.reopen();
  const second = await f.stream().output(record, { ...query, cursor: first.nextCursor });
  expect((await f.read(second.output.ref)).toString()).toBe("CD");
  const pending = await f.stream().output(record, { ...query, cursor: second.nextCursor });
  expect(pending).toMatchObject({ end: false, output: { byteLength: 0 } });
  const termination = { exitCode: 7, reasonCode: "exited", taskProcessExited: true };
  await f.stream().append(record, { index: 1, offset: 4, bytesBase64: "", end: true, termination });
  expect(await f.stream().termination(record)).toEqual(termination);
  const final = await f.stream().output(record, { ...query, cursor: second.nextCursor });
  expect(final).toMatchObject({
    end: true,
    nextCursor: null,
    output: { byteLength: 0 },
    termination,
  });
  await expect(
    f.stream().append(record, { index: 2, offset: 4, bytesBase64: "eA==", end: false }),
  ).rejects.toThrow();
  await expect(
    f.stream().output(record, { ...query, cursor: `sandbox-stream-cursor:${"0".repeat(64)}` }),
  ).rejects.toThrow();
  await expect(
    f.stream().output(
      {
        ...record,
        plan: { ...record.plan, identity: { ...record.plan.identity, runId: "other-run" } },
      },
      { ...query, cursor: first.nextCursor },
    ),
  ).rejects.toThrow();
});
it("rejects output holes, noncanonical encoding, empty nonterminal chunks and flood", async () => {
  const f = await fixture();
  const record = {
    ...f.record,
    plan: {
      ...f.record.plan,
      mode: "background" as const,
      resourceCeiling: { ...f.record.plan.resourceCeiling, maxOutputBytes: 3 },
    },
  };
  for (const chunk of [
    { index: 1, offset: 0, bytesBase64: "eA==", end: false },
    { index: 0, offset: 1, bytesBase64: "eA==", end: false },
    { index: 0, offset: 0, bytesBase64: "eB==", end: false },
    { index: 0, offset: 0, bytesBase64: "", end: false },
    { index: 0, offset: 0, bytesBase64: "YWJjZA==", end: false },
  ])
    await expect(f.stream().append(record, chunk)).rejects.toThrow();
});
