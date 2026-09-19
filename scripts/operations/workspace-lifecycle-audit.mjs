import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const sections = ["executions", "legacy", "queue"];
function assertArgument(condition) {
  if (!condition) throw new Error("WORKSPACE_AUDIT_ARGUMENT_INVALID");
}
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 512;

/** Read-only inventory, never a release decision. Receipt presence does not prove
 * its authenticity or that a former process / delayed dispatch cannot write.
 * Each bounded page is one SQLite snapshot; later pages may observe later state. */
export function auditWorkspaceLifecycle({
  databasePath,
  ownerId,
  agentId,
  section = "executions",
  afterId = "",
  limit = 100,
}) {
  assertArgument(text(databasePath) && path.isAbsolute(databasePath));
  assertArgument(text(ownerId) && text(agentId) && sections.includes(section));
  assertArgument(typeof afterId === "string" && afterId.length <= 512);
  assertArgument(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      const ledger = db
        .prepare("SELECT count(*) AS count, max(sequence) AS sequence FROM schema_migration_ledger")
        .get();
      const version = ledger.sequence;
      if (
        !Number.isSafeInteger(version) ||
        version < 28 ||
        version > 37 ||
        ledger.count !== version
      )
        throw new Error("WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED");
      let rows;
      if (section === "executions") {
        rows = db
          .prepare(`SELECT r.job_id AS jobId, r.run_id AS runId, r.sequence,
          r.operation_revision AS operationRevision, u.status AS runStatus,
          ${version >= 29 ? "r.preparation_state" : "'legacy_bound'"} AS preparation,
          json_extract(r.facts_json,'$.resource.supervision') AS supervision,
          json_extract(r.facts_json,'$.resource.cleanup') AS cleanup,
          json_extract(r.facts_json,'$.effect.kind') AS effect,
          json_extract(r.facts_json,'$.result.kind') AS result,
          (SELECT count(*) FROM sandbox_workspace_occupancy o WHERE o.job_id=r.job_id AND o.released_at IS NULL) AS activeClaims,
          ${version >= 33 ? "EXISTS(SELECT 1 FROM sandbox_release_receipts x WHERE x.job_id=r.job_id)" : "0"} AS releaseReceiptPresent,
          ${version >= 33 ? "(SELECT count(*) FROM sandbox_workspace_barriers b WHERE b.job_id=r.job_id AND b.resolved_at IS NULL)" : "0"} AS activeBarriers,
          (SELECT count(*) FROM sandbox_execution_intents i WHERE i.job_id=r.job_id AND i.kind='continue' AND i.dispatched_at IS NOT NULL AND i.acknowledged_at IS NULL) AS pendingControl,
          (SELECT count(*) FROM sandbox_execution_intents i WHERE i.job_id=r.job_id AND i.kind='tool_result' AND i.dispatched_at IS NOT NULL AND i.acknowledged_at IS NULL) AS pendingDelivery
          FROM sandbox_execution_records r JOIN runs u ON u.id=r.run_id AND u.owner_id=r.owner_id AND u.agent_id=r.agent_id
          WHERE r.owner_id=? AND r.agent_id=? AND r.job_id>? ORDER BY r.job_id LIMIT ?`)
          .all(ownerId, agentId, afterId, limit)
          .map((row) => {
            const reasons = [];
            const requiredEvidence = [];
            const released = row.supervision === "released";
            if (!released) reasons.push("RESOURCE_RELEASE_UNCONFIRMED");
            if (released && row.activeClaims) reasons.push("RELEASED_WITH_ACTIVE_CLAIMS");
            if (released && !row.releaseReceiptPresent) reasons.push("RELEASE_RECEIPT_MISSING");
            if (
              ["completed", "failed", "cancelled"].includes(row.runStatus) &&
              (!released || row.activeClaims || row.activeBarriers)
            )
              reasons.push("TERMINAL_RUN_HAS_RESOURCE_OBLIGATION");
            if (row.activeBarriers) reasons.push("WORKSPACE_PROTECTION_ACTIVE");
            if (row.pendingControl) reasons.push("CONTROL_ACK_PENDING");
            if (row.pendingDelivery) reasons.push("RESULT_DELIVERY_PENDING");
            if (row.result === null || row.result === "unknown") reasons.push("RESULT_UNRESOLVED");
            if (row.effect === "unknown") reasons.push("EFFECT_UNRESOLVED");
            if (
              !released ||
              row.activeClaims ||
              row.activeBarriers ||
              row.pendingControl ||
              !row.releaseReceiptPresent
            )
              requiredEvidence.push(
                "ORIGINAL_PROCESS_IDENTITY",
                "LATE_DISPATCH_FENCED",
                "FRESH_HOST_RELEASE_PROOF",
              );
            if (row.result === null || row.result === "unknown" || row.effect === "unknown")
              requiredEvidence.push("ORIGINAL_OPERATION_EFFECT_PROOF");
            if (row.pendingDelivery) requiredEvidence.push("CURRENT_DISCLOSURE_AUTHORITY");
            return {
              ...row,
              releaseReceiptPresent: Boolean(row.releaseReceiptPresent),
              reasons,
              requiredEvidence,
            };
          });
      } else if (section === "legacy") {
        rows = db
          .prepare(`SELECT j.job_id AS jobId, j.run_id AS runId,
          json_extract(j.observation_json,'$.state') AS state,
          json_extract(j.observation_json,'$.cleanup') AS cleanup
          FROM sandbox_jobs j JOIN sandbox_legacy_occupancy o ON o.job_id=j.job_id
          WHERE j.owner_id=? AND j.agent_id=? AND j.job_id>? AND o.released_at IS NULL ORDER BY j.job_id LIMIT ?`)
          .all(ownerId, agentId, afterId, limit)
          .map((row) => ({
            ...row,
            reasons: ["LEGACY_WORKSPACE_PROTECTION_ACTIVE"],
            requiredEvidence: [
              "ORIGINAL_PROCESS_IDENTITY",
              "LATE_DISPATCH_FENCED",
              "FRESH_HOST_RELEASE_PROOF",
            ],
          }));
      } else {
        rows =
          version < 35
            ? []
            : db
                .prepare(`SELECT q.job_id AS jobId, q.run_id AS runId, q.sequence, q.status,
          q.deadline_at AS deadlineAt,
          EXISTS(SELECT 1 FROM sandbox_execution_records r WHERE r.job_id=q.job_id) AS admissionPresent,
          EXISTS(SELECT 1 FROM capability_invocation_receipts c WHERE c.owner_id=q.owner_id AND c.agent_id=q.agent_id AND c.run_id=q.run_id AND c.invocation_id=json_extract(q.request_json,'$.plan.identity.invocationId')) AS invocationReceiptPresent
          FROM sandbox_admission_queue q WHERE q.owner_id=? AND q.agent_id=? AND q.job_id>? ORDER BY q.job_id LIMIT ?`)
                .all(ownerId, agentId, afterId, limit)
                .map((row) => ({
                  ...row,
                  admissionPresent: Boolean(row.admissionPresent),
                  invocationReceiptPresent: Boolean(row.invocationReceiptPresent),
                  reasons: [
                    !row.admissionPresent &&
                    !row.invocationReceiptPresent &&
                    row.status === "cancelled"
                      ? "QUEUE_CANCELLED"
                      : row.status === "admitted" &&
                          row.admissionPresent &&
                          row.invocationReceiptPresent
                        ? "QUEUE_ADMITTED"
                        : row.status === "queued" &&
                            !row.admissionPresent &&
                            !row.invocationReceiptPresent
                          ? "QUEUED_WITHOUT_DISPATCH_COMMIT"
                          : "QUEUE_ADMISSION_REQUIRES_RECONCILIATION",
                  ],
                  requiredEvidence: ["CURRENT_AUTHORITY_AND_TARGET", "ORIGINAL_REQUEST_BINDING"],
                }));
      }
      return {
        schemaVersion: "workspace-lifecycle-audit.v1",
        mode: "read_only",
        schemaSequence: version,
        ownerId,
        agentId,
        section,
        liveHostVerified: false,
        repairEligible: false,
        rows,
        nextAfterId: rows.length === limit ? rows.at(-1).jobId : null,
      };
    })();
  } finally {
    db.close();
  }
}

export function workspaceLifecycleAuditMain(
  argv,
  stdout = process.stdout,
  stderr = process.stderr,
) {
  try {
    const allowed = new Set([
      "--database",
      "--owner",
      "--agent",
      "--section",
      "--after",
      "--limit",
    ]);
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index],
        value = argv[index + 1];
      assertArgument(
        allowed.has(key) && !args.has(key) && value !== undefined && !value.startsWith("--"),
      );
      args.set(key, value);
    }
    const result = auditWorkspaceLifecycle({
      databasePath: args.get("--database"),
      ownerId: args.get("--owner"),
      agentId: args.get("--agent"),
      section: args.get("--section"),
      afterId: args.get("--after"),
      limit: args.has("--limit") ? Number(args.get("--limit")) : undefined,
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const reason = /^WORKSPACE_AUDIT_[A-Z_]+$/.test(error.message)
      ? error.message
      : "WORKSPACE_AUDIT_READ_FAILED";
    stderr.write(`${reason}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = workspaceLifecycleAuditMain(process.argv.slice(2));
