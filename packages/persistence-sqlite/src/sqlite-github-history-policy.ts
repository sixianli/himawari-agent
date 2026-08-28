import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type DurableGitHubMonitorHistoryPolicyPort,
  type GitHubMonitorHistoryPolicyOperation,
} from "@himawari-agent/application";
import type { JobId } from "@himawari-agent/domain";
import type { SqliteDurableAdapterContext } from "./durable-adapters.js";
import type { SqliteGitHubHistoryApplyResult } from "./sqlite-durable-operations.js";

export class SqliteGitHubMonitorHistoryPolicyAdapter
  implements DurableGitHubMonitorHistoryPolicyPort
{
  private readonly context: SqliteDurableAdapterContext;
  private readonly ciphertextRoot: string;

  constructor(input: {
    readonly context: SqliteDurableAdapterContext;
    readonly stateRoot: string;
  }) {
    this.context = input.context;
    this.ciphertextRoot = path.resolve(input.stateRoot, "data", "payload-ciphertext");
  }

  async apply(input: Parameters<DurableGitHubMonitorHistoryPolicyPort["apply"]>[0]): Promise<void> {
    const result = await this.context.write<SqliteGitHubHistoryApplyResult>(
      "github.history.apply",
      input,
    );
    await this.finishPayloadFiles(result, input.occurredAt);
  }

  inspect(monitorId: JobId): Promise<GitHubMonitorHistoryPolicyOperation | undefined> {
    return this.context.read("github.history.inspect", { monitorId });
  }

  async retry(monitorId: JobId, occurredAt: string): Promise<void> {
    const result = await this.context.write<SqliteGitHubHistoryApplyResult>(
      "github.history.retry",
      { monitorId, occurredAt },
    );
    await this.finishPayloadFiles(result, occurredAt);
  }

  listRetryable(limit: number): Promise<readonly GitHubMonitorHistoryPolicyOperation[]> {
    return this.context.read("github.history.listRetryable", { limit });
  }

  private async finishPayloadFiles(
    result: SqliteGitHubHistoryApplyResult,
    occurredAt: string,
  ): Promise<void> {
    if (result.pendingPayloadFiles.length === 0) return;
    try {
      for (const relativePath of result.pendingPayloadFiles) {
        const target = this.safeTarget(relativePath);
        const information = await lstat(target).catch(() => undefined);
        if (information?.isDirectory()) {
          throw new Error("payload deletion target became a directory");
        }
        if (information) await unlink(target);
      }
      await this.context.write("github.history.finalize", {
        monitorId: result.operation.monitorId,
        occurredAt,
      });
    } catch {
      await this.context.write("github.history.fail", {
        monitorId: result.operation.monitorId,
        occurredAt,
        errorCode: "payload_file_delete_failed",
      });
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "GitHub history payload cleanup requires retry",
        { monitorId: result.operation.monitorId },
      );
    }
  }

  private safeTarget(relativePath: string): string {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.split("/").includes("..")
    ) {
      throw new Error("payload ciphertext path escapes its managed root");
    }
    const target = path.resolve(this.ciphertextRoot, relativePath);
    if (!target.startsWith(`${this.ciphertextRoot}${path.sep}`)) {
      throw new Error("payload ciphertext path escapes its managed root");
    }
    return target;
  }
}
