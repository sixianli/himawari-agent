import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxExecutionRecord } from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, expect, it } from "vitest";
import { createProductionSandboxOutput } from "../../apps/agent-service/src/production-sandbox-output.ts";
import { createProductionSandboxStream } from "../../apps/agent-service/src/production-sandbox-stream.ts";
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
    savedArtifacts: () => {
      const database = openQualifiedDatabase(path.join(f.resource.stateRoot, "product.sqlite"));
      try {
        return database
          .prepare(
            "SELECT operation_key AS operationKey, payload_ref AS ref FROM run_payload_artifacts WHERE purpose='trace'",
          )
          .all() as Array<{ operationKey: string; ref: string }>;
      } finally {
        database.close();
      }
    },
    corruptArtifact: async (
      operationKey: string,
      corruption: "missing" | "digest" | "offset" | "length",
    ) => {
      const artifact = await outputOptions()
        .artifacts()
        .lookup({ runId: createRunId(record.plan.identity.runId), purpose: "trace", operationKey });
      if (!artifact) throw new Error("missing fixture artifact");
      let replacement: typeof payload | undefined;
      if (corruption === "offset" || corruption === "length") {
        const value = JSON.parse((await read(artifact.payloadRef)).toString());
        if (corruption === "offset") value.offset++;
        else value.bytesBase64 = "";
        replacement = await f.protector.protect({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          ref: `corrupt-${++next}`,
          dataClassification: "restricted",
          contentType: "application/json",
          plaintext: Buffer.from(JSON.stringify(value)),
          createdAt: T1,
        });
        await payloads.put(replacement);
      }
      const database = openQualifiedDatabase(path.join(f.resource.stateRoot, "product.sqlite"));
      try {
        if (corruption === "missing")
          database
            .prepare("DELETE FROM run_payload_artifacts WHERE operation_key=?")
            .run(operationKey);
        else if (corruption === "digest")
          database
            .prepare("UPDATE run_payload_artifacts SET content_digest=? WHERE operation_key=?")
            .run(`sha256:${"0".repeat(64)}`, operationKey);
        else if (replacement)
          database
            .prepare(
              "UPDATE run_payload_artifacts SET payload_ref=?, content_digest=? WHERE operation_key=?",
            )
            .run(replacement.ref, replacement.contentDigest, operationKey);
      } finally {
        database.close();
      }
    },
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

it("rejects substituting an encrypted stream end artifact for the original output Payload", async () => {
  const f = await fixture("original-first-original-second");
  const record = { ...f.record, plan: { ...f.record.plan, mode: "background" as const } };
  const first = Buffer.from("original-first-");
  const second = Buffer.from("original-second");
  await f.stream().append(record, {
    index: 0,
    offset: 0,
    bytesBase64: first.toString("base64"),
    end: false,
  });
  await f.stream().append(record, {
    index: 1,
    offset: first.length,
    bytesBase64: second.toString("base64"),
    end: true,
    termination: { exitCode: 0, reasonCode: "exited", taskProcessExited: true },
  });
  await f.reopen();
  const terminal = f
    .savedArtifacts()
    .find((artifact) => artifact.operationKey.startsWith("sandbox-stream-end:"));
  expect(terminal).toBeDefined();
  if (!terminal) throw new Error("missing stream end");
  const plaintext = await f.read(terminal.ref);
  expect(plaintext).not.toEqual(f.bytes);
  expect(JSON.parse(plaintext.toString())).toMatchObject({
    bytesBase64: second.toString("base64"),
    offset: first.length,
    end: true,
  });
  const result = f.record.facts.result;
  if (!result || result.kind !== "result") throw new Error("missing original result");
  await expect(
    f.reader()(
      {
        ...record,
        facts: {
          ...record.facts,
          result: { ...result, output: { ...result.output, ref: terminal.ref } },
        },
      },
      { resourceRef: "task-fixture", cursor: null, limit: 32768 },
    ),
  ).rejects.toThrow("SANDBOX_OUTPUT_CHANGED");
});

it.each([
  { name: "empty", text: "" },
  { name: "multibyte", text: "x".repeat(32767) + "向日葵🌻".repeat(5000) },
])(
  "recovers the original foreground bytes across protected chunk boundaries: $name",
  async ({ text }) => {
    const f = await fixture(text);
    const record = {
      ...f.record,
      plan: {
        ...f.record.plan,
        resourceCeiling: {
          ...f.record.plan.resourceCeiling,
          maxOutputBytes: Math.max(1, f.bytes.length),
        },
      },
      facts: { ...f.record.facts, result: null },
    };
    const termination = { exitCode: 0, reasonCode: "exited", taskProcessExited: true };
    let index = 0;
    for (let offset = 0; offset < f.bytes.length; offset += 32768) {
      const chunk = f.bytes.subarray(offset, offset + 32768);
      await f.stream().append(record, {
        index: index++,
        offset,
        bytesBase64: chunk.toString("base64"),
        end: false,
      });
    }
    await f.stream().append(record, {
      index,
      offset: f.bytes.length,
      bytesBase64: "",
      end: true,
      termination,
    });
    await f.reopen();
    const recovered = await f.stream().recover(record);
    expect(recovered?.bytes).toEqual(f.bytes);
    expect(recovered?.termination).toEqual(termination);
    expect(record.facts.resource.resourceRef).toBeNull();
    expect(
      await f.stream().recover({
        ...record,
        plan: { ...record.plan, identity: { ...record.plan.identity, attemptId: "foreign" } },
      }),
    ).toBeNull();
  },
);

it.each(["missing", "digest", "offset", "length"] as const)(
  "rejects corrupted foreground recovery chunks: %s",
  async (corruption) => {
    const f = await fixture("original");
    const record = { ...f.record, facts: { ...f.record.facts, result: null } };
    await f
      .stream()
      .append(record, { index: 0, offset: 0, bytesBase64: f.bytes.toString("base64"), end: false });
    expect(await f.stream().recover(record)).toBeNull();
    await f.stream().append(record, {
      index: 1,
      offset: f.bytes.length,
      bytesBase64: "",
      end: true,
      termination: { exitCode: 0, reasonCode: "exited", taskProcessExited: true },
    });
    const source = (await f.stream().recover(record))?.source;
    if (!source?.artifacts[0]) throw new Error("missing fixture source");
    await f.corruptArtifact(source.artifacts[0].operationKey, corruption);
    await expect(f.stream().recover(record)).rejects.toThrow(/^SANDBOX_STREAM_/);
  },
);
