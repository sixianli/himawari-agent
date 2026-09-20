import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxExecutionAdmissionRecord } from "@himawari-agent/application";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxV2Admission, sandboxV2Call } from "../fixtures/sandbox-execution-v2-fixture.ts";
import {
  AGENT_ID,
  OWNER_ID,
  openSandboxJournal,
  operationsForDatabase,
  SERVICE_AUTHORITY,
  T1,
} from "../fixtures/sqlite-capability-invocation-fixture.ts";

type AuditInput = {
  databasePath: string;
  ownerId: string;
  agentId: string;
  section?: string;
  afterId?: string | null;
  limit?: number;
};
interface AuditRow {
  jobId: string;
  status?: string;
  reasons: string[];
  requiredEvidence: string[];
}
function executeAudit(argv: string[]) {
  return spawnSync(
    process.execPath,
    [path.resolve("scripts/operations/workspace-lifecycle-audit.mjs"), ...argv],
    { encoding: "utf8", timeout: 10000 },
  );
}
function auditWorkspaceLifecycle(input: AuditInput): {
  rows: AuditRow[];
  nextAfterId: string | null;
} {
  const flags = {
    databasePath: "--database",
    ownerId: "--owner",
    agentId: "--agent",
    section: "--section",
    afterId: "--after",
    limit: "--limit",
  };
  const args = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([key, value]) => [flags[key as keyof typeof flags], String(value)]);
  const result = executeAudit(args);
  if (result.status !== 0) throw new Error(result.stderr || "AUDIT_PROCESS_FAILED");
  return JSON.parse(result.stdout);
}
function workspaceLifecycleAuditMain(
  argv: string[],
  stdout: { write: (text: string) => unknown },
  stderr: { write: (text: string) => unknown },
) {
  const result = executeAudit(argv);
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result.status;
}

const close: (() => Promise<void>)[] = [];
async function fixture() {
  const f = await openSandboxJournal();
  close.push(f.close);
  const databasePath = path.join(f.resource.stateRoot, "product.sqlite");
  const input = {
    databasePath,
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    section: "executions",
    limit: 10,
  };
  sandboxV2Call(f, "admit", sandboxV2Admission(f));
  return { ...f, input, databasePath };
}
afterEach(async () => {
  for (const cleanup of close.splice(0)) await cleanup();
});

it("reports queued action and next attempt without changing the database", async () => {
  const f = await fixture();
  const identity = sandboxV2Admission(f).plan.identity;
  f.database.prepare("UPDATE runs SET status='completed' WHERE id=?").run(identity.runId);
  operationsForDatabase(f.database).execute("capabilityInvocation.sandboxV2.scheduleRecovery", {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    input: {
      identity,
      authority: SERVICE_AUTHORITY,
      now: T1,
      expectedSequence: 1,
      expectedRecoveryRevision: 0,
    },
  });
  const before = f.database.serialize();
  expect(auditWorkspaceLifecycle(f.input).rows[0]).toMatchObject({
    recoveryStatus: "scheduled",
    recoveryAction: "stop",
    recoveryNextAttemptAt: T1,
    recoveryFinishedAt: null,
    activeClaims: 1,
    releaseReceiptPresent: false,
  });
  expect(f.database.serialize()).toEqual(before);
});

describe("workspace lifecycle read-only audit", () => {
  it.each([false, true])(
    "audits stopped unbound reservations with release receipt: %s",
    async (released) => {
      const f = await openSandboxJournal();
      close.push(f.close);
      const { plan, invocation, workspaces } = sandboxV2Admission(f);
      const call = (operation: string, input: unknown) =>
        operationsForDatabase(f.database).execute(`capabilityInvocation.sandboxV2.${operation}`, {
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          input,
        });
      call("reserve", {
        plan,
        invocation,
        workspaces,
        reservation: {
          schemaVersion: "sandbox-preparation.v1",
          identity: plan.identity,
          environmentId: plan.environmentId,
          resourceRef: null,
          mode: plan.mode,
          workspaceConflictRefs: workspaces.map((x) => x.ref),
          sequence: 1,
          createdAt: plan.requestedAt,
        },
      });
      const stopped = call("interruptReservation", {
        identity: plan.identity,
        authority: SERVICE_AUTHORITY,
        now: T1,
        reasonCode: "SANDBOX_UNBOUND_ENVIRONMENT_UNKNOWN",
      }) as { admission: SandboxExecutionAdmissionRecord };
      if (stopped.admission.phase !== "reserved") throw new Error("expected reservation");
      if (released)
        call("releaseReservation", {
          identity: plan.identity,
          authority: SERVICE_AUTHORITY,
          now: T1,
          verification: {
            schemaVersion: "sandbox-reservation-release.v1",
            basis: "host_never_started",
            identity: plan.identity,
            environmentId: plan.environmentId,
            semanticFingerprint: stopped.admission.plan.semanticFingerprint,
            stopRequestedAt: T1,
            checkedAt: T1,
            validUntil: new Date(Date.parse(T1) + 1000).toISOString(),
            processIdentityRef: "job-host-process:original-host",
            controlSessionId: "11111111-1111-1111-1111-111111111111",
            evidence: { ref: "protected-release-proof", digest: "a".repeat(64) },
          },
        });
      const before = f.database.serialize();
      const result = auditWorkspaceLifecycle({
        databasePath: path.join(f.resource.stateRoot, "product.sqlite"),
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
      });
      expect(result.rows[0]).toMatchObject({
        preparation: "reserved",
        stopRequestedAt: T1,
        recoveryStatus: released ? "resolved" : "unresolved",
        recoveryFinishedAt: T1,
        releaseReceiptPresent: false,
        reservationReleaseReceiptPresent: released,
        activeClaims: released ? 0 : 1,
      });
      expect(result.rows[0]?.reasons).toContain("UNBOUND_RESERVATION_STOPPED");
      expect(result.rows[0]?.reasons.includes("RESOURCE_RELEASE_UNCONFIRMED")).toBe(!released);
      expect(result.rows[0]?.requiredEvidence.includes("FRESH_HOST_RELEASE_PROOF")).toBe(!released);
      if (released) expect(result.rows[0]?.requiredEvidence).toEqual([]);
      expect(f.database.serialize()).toEqual(before);
    },
  );

  it("reports held resources without creating release proof or changing database bytes", async () => {
    const f = await fixture();
    f.database.pragma("wal_checkpoint(TRUNCATE)");
    const before = await readFile(f.databasePath);
    const logicalBefore = f.database.serialize();
    const result = auditWorkspaceLifecycle(f.input);
    expect(result).toMatchObject({
      mode: "read_only",
      schemaSequence: 45,
      liveHostVerified: false,
      repairEligible: false,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      jobId: "job",
      activeClaims: 1,
      releaseReceiptPresent: false,
    });
    expect(result.rows[0]?.reasons).toContain("RESOURCE_RELEASE_UNCONFIRMED");
    expect(await readFile(f.databasePath)).toEqual(before);
    expect(f.database.serialize()).toEqual(logicalBefore);
    expect(f.database.prepare("SELECT count(*) AS n FROM sandbox_release_receipts").get()).toEqual({
      n: 0,
    });
  });

  it("reports resource incidents without disclosing their protected evidence", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "INSERT INTO sandbox_workspace_barriers(job_id,barrier_id,kind,reason_code,created_at,verification_json,authority_json) VALUES('job','risk','resource_contradiction','SANDBOX_RELEASE_CONTRADICTED',?, ?, ?)",
      )
      .run(
        T1,
        JSON.stringify({ privateDiagnostic: "must-not-leak" }),
        JSON.stringify(SERVICE_AUTHORITY),
      );
    const before = f.database.serialize();
    const result = auditWorkspaceLifecycle(f.input);
    expect(result.rows[0]).toMatchObject({ resourceIncidents: 1 });
    expect(result.rows[0]?.reasons).toContain("SANDBOX_RELEASE_CONTRADICTED");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(f.database.serialize()).toEqual(before);
  });

  it("finds historical released claims without treating a state label as release authority", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "UPDATE sandbox_execution_records SET facts_json=json_set(facts_json,'$.resource.supervision','released','$.resource.cleanup','confirmed')",
      )
      .run();
    const row = auditWorkspaceLifecycle(f.input).rows[0];
    expect(row?.reasons).toContain("RELEASED_WITH_ACTIVE_CLAIMS");
    expect(row?.reasons).toContain("RELEASE_RECEIPT_MISSING");
    expect(row?.requiredEvidence).toContain("FRESH_HOST_RELEASE_PROOF");
    expect(f.database.prepare("SELECT released_at FROM sandbox_workspace_occupancy").get()).toEqual(
      { released_at: null },
    );
  });

  it("reports delivery independently from control and never exposes protected facts", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "UPDATE sandbox_execution_records SET facts_json=json_set(facts_json,'$.result.kind','result','$.result.output.ref','private-result-marker')",
      )
      .run();
    for (const kind of ["tool_result", "continue"])
      f.database
        .prepare(
          "INSERT INTO sandbox_execution_intents(intent_id,job_id,kind,sequence,operation_revision,authority_json,created_at,dispatched_at) VALUES(?, 'job', ?, 1, 0, '{}', '2026-09-19T00:00:00.000Z', '2026-09-19T00:00:00.000Z')",
        )
        .run(kind, kind);
    const result = auditWorkspaceLifecycle(f.input);
    expect(result.rows[0]?.reasons).toEqual(
      expect.arrayContaining(["RESULT_DELIVERY_PENDING", "CONTROL_ACK_PENDING"]),
    );
    expect(JSON.stringify(result)).not.toContain("private-result-marker");
    expect(result.rows[0]?.requiredEvidence).toContain("LATE_DISPATCH_FENCED");
  });

  it("scopes every section to the requested owner and agent", async () => {
    const f = await fixture();
    for (const section of ["executions", "legacy", "queue"])
      expect(
        auditWorkspaceLifecycle({ ...f.input, ownerId: "another-owner", section }).rows,
      ).toEqual([]);
  });

  it("distinguishes a queued request without a dispatch commit from cancellation", async () => {
    const f = await fixture();
    const insert = f.database.prepare(
      "INSERT INTO sandbox_admission_queue(job_id,owner_id,agent_id,run_id,host_id,handle_ref,deadline_at,status,request_json,claims_json) VALUES(?,?,?,?,?,?,? ,?,?,'[]')",
    );
    for (const status of ["queued", "cancelled"])
      insert.run(
        `queue-${status}`,
        OWNER_ID,
        AGENT_ID,
        f.plan.identity.runId,
        f.plan.identity.hostId,
        f.plan.handleRef,
        f.plan.effectiveDeadlineAt,
        status,
        JSON.stringify({ plan: { identity: { invocationId: `queue-${status}` } } }),
      );
    const rows = auditWorkspaceLifecycle({ ...f.input, section: "queue" }).rows;
    expect(rows.find((row) => row.status === "queued")).toMatchObject({
      admissionPresent: false,
      invocationReceiptPresent: false,
      reasons: ["QUEUED_WITHOUT_DISPATCH_COMMIT"],
    });
    expect(rows.find((row) => row.status === "cancelled")?.reasons).toEqual(["QUEUE_CANCELLED"]);
    expect(f.database.prepare("SELECT count(*) AS n FROM sandbox_admission_queue").get()).toEqual({
      n: 2,
    });
  });

  it("inventories legacy obligations without consuming another invocation", async () => {
    const f = await openSandboxJournal();
    close.push(f.close);
    f.prepare();
    const result = auditWorkspaceLifecycle({
      databasePath: path.join(f.resource.stateRoot, "product.sqlite"),
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      section: "legacy",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.reasons).toEqual(["LEGACY_WORKSPACE_PROTECTION_ACTIVE"]);
    expect(
      f.database.prepare("SELECT count(*) AS n FROM capability_invocation_receipts").get(),
    ).toEqual({ n: 1 });
  });

  it.each([28, 40, 43])(
    "reads schema %s using its actual migrations, without installing newer tables",
    async (schemaSequence) => {
      const f = await fixture();
      const databasePath = path.join(f.resource.stateRoot, "historical.sqlite");
      const historical = openQualifiedDatabase(databasePath);
      try {
        applyMigrations(
          historical,
          (await loadBundledMigrations()).filter((item) => item.sequence <= schemaSequence),
        );
      } finally {
        historical.close();
      }
      const before = await readFile(databasePath);
      for (const section of ["executions", "legacy", "queue"])
        expect(auditWorkspaceLifecycle({ ...f.input, databasePath, section })).toMatchObject({
          schemaSequence,
          rows: [],
        });
      expect(await readFile(databasePath)).toEqual(before);
    },
  );

  it("rejects mutation flags and keeps failed CLI output free of database paths", () => {
    const stdout = { write: vi.fn() },
      stderr = { write: vi.fn() };
    expect(workspaceLifecycleAuditMain(["--repair", "yes"], stdout, stderr)).toBe(1);
    expect(stderr.write).toHaveBeenLastCalledWith("WORKSPACE_AUDIT_ARGUMENT_INVALID\n");
    expect(
      workspaceLifecycleAuditMain(
        [
          "--database",
          "/private/missing-sensitive-location.sqlite",
          "--owner",
          "owner",
          "--agent",
          "agent",
        ],
        stdout,
        stderr,
      ),
    ).toBe(1);
    expect(stderr.write).toHaveBeenLastCalledWith("WORKSPACE_AUDIT_READ_FAILED\n");
    expect(stdout.write).not.toHaveBeenCalled();
  });

  it("uses a stable job cursor and bounds each read", async () => {
    const f = await fixture();
    const first = auditWorkspaceLifecycle({ ...f.input, limit: 1 });
    expect(first.nextAfterId).toBe("job");
    expect(auditWorkspaceLifecycle({ ...f.input, afterId: first.nextAfterId }).rows).toEqual([]);
    for (const limit of [0, 1001, 1.5])
      expect(() => auditWorkspaceLifecycle({ ...f.input, limit })).toThrow(
        "WORKSPACE_AUDIT_ARGUMENT_INVALID",
      );
  });

  it("rejects unknown schemas without migrating or creating missing databases", async () => {
    const f = await fixture();
    f.database
      .prepare(
        "INSERT INTO schema_migration_ledger SELECT MAX(sequence)+1,'future','expand','digest','2026-09-19T00:00:00.000Z' FROM schema_migration_ledger",
      )
      .run();
    expect(() => auditWorkspaceLifecycle(f.input)).toThrow("WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED");
    expect(() =>
      auditWorkspaceLifecycle({
        ...f.input,
        databasePath: path.join(f.resource.stateRoot, "absent.sqlite"),
      }),
    ).toThrow();
  });
});
