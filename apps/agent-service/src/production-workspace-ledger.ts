import { createHash } from "node:crypto";
import { isSandboxRuntimeWorkspaceMountPath } from "@himawari-agent/execution-contracts";
import {
  diffWorkspaceSnapshots,
  type HostDirectoryGrant,
  type HostReadOnlyPort,
  type HostWorkspaceSnapshot,
  type HostWorkspaceSnapshotPort,
  summarizeWorkspaceChanges,
  type WorkspaceChangeKind,
} from "@himawari-agent/application";

export const WORKSPACE_LEDGER_MAXIMUM_ENTRIES = 50_000;
export const WORKSPACE_LEDGER_HASH_LIMIT_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_LEDGER_SLOW_SCAN_MS = 200;

export interface WorkspaceFingerprint {
  readonly size: string;
  readonly modifiedAtNs: string;
  readonly sha256?: string | null;
}

export interface WorkspaceLedgerChange {
  readonly path: string;
  readonly kind: string;
  readonly change: WorkspaceChangeKind;
  readonly before: WorkspaceFingerprint | null;
  readonly after: WorkspaceFingerprint | null;
}

export interface WorkspaceLedgerRecord {
  readonly version: "workspace-changes.v1";
  readonly complete: boolean;
  readonly beforeScanMs: number;
  readonly afterScanMs: number;
  readonly changes: readonly WorkspaceLedgerChange[];
  readonly summary: string;
}

export interface WorkspaceLedgerBaseline {
  readonly snapshot: HostWorkspaceSnapshot;
  readonly scanMs: number;
}

export interface ProductionWorkspaceLedger {
  baseline(grant: HostDirectoryGrant): Promise<WorkspaceLedgerBaseline>;
  record(
    grant: HostDirectoryGrant,
    baseline: WorkspaceLedgerBaseline,
  ): Promise<WorkspaceLedgerRecord>;
}

export function createProductionWorkspaceLedger(options: {
  readonly port: HostReadOnlyPort & HostWorkspaceSnapshotPort;
  readonly now?: () => number;
  readonly warn?: (event: Record<string, unknown>) => void;
}): ProductionWorkspaceLedger {
  const now = options.now ?? (() => performance.now());
  const warn =
    options.warn ?? ((event: Record<string, unknown>) => console.error(JSON.stringify(event)));
  const scan = async (grant: HostDirectoryGrant): Promise<WorkspaceLedgerBaseline> => {
    const started = now();
    const snapshot = await options.port.snapshotWorkspace({
      grant,
      maximumEntries: WORKSPACE_LEDGER_MAXIMUM_ENTRIES,
    });
    const scanMs = Math.round(now() - started);
    if (scanMs > WORKSPACE_LEDGER_SLOW_SCAN_MS || !snapshot.complete)
      warn({
        event: "workspace.ledger.scan",
        grantId: grant.id,
        entries: snapshot.entries.length,
        complete: snapshot.complete,
        durationMs: scanMs,
        at: new Date().toISOString(),
      });
    return { snapshot, scanMs };
  };
  const digest = async (grant: HostDirectoryGrant, path: string): Promise<string | null> => {
    try {
      const bytes = await options.port.readFile({
        grant,
        relativePath: path,
        maximumBytes: WORKSPACE_LEDGER_HASH_LIMIT_BYTES,
      });
      return createHash("sha256").update(bytes).digest("hex");
    } catch {
      return null;
    }
  };
  return {
    baseline: scan,
    async record(grant, baseline) {
      const after = await scan(grant);
      const observed = diffWorkspaceSnapshots(baseline.snapshot, after.snapshot);
      const changeSet = Object.freeze({
        complete: observed.complete,
        changes: Object.freeze(
          observed.changes.filter((change) => !isSandboxRuntimeWorkspaceMountPath(change.path)),
        ),
      });
      const changes: WorkspaceLedgerChange[] = [];
      for (const change of changeSet.changes) {
        const entry = change.after ?? change.before;
        changes.push(
          Object.freeze({
            path: change.path,
            kind: entry?.kind ?? "other",
            change: change.change,
            before: change.before
              ? { size: change.before.size, modifiedAtNs: change.before.modifiedAtNs }
              : null,
            after: change.after
              ? {
                  size: change.after.size,
                  modifiedAtNs: change.after.modifiedAtNs,
                  sha256: change.after.kind === "file" ? await digest(grant, change.path) : null,
                }
              : null,
          }),
        );
      }
      return Object.freeze({
        version: "workspace-changes.v1",
        complete: changeSet.complete,
        beforeScanMs: baseline.scanMs,
        afterScanMs: after.scanMs,
        changes: Object.freeze(changes),
        summary: summarizeWorkspaceChanges(changeSet),
      });
    },
  };
}
