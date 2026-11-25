import { describe, expect, it, vi } from "vitest";
import { ThreadDeletionRetry } from "../src/production-thread-deletion-retry.ts";

const verified = { lifecycle: "deleted_verified" };
const pending = { lifecycle: "deletion_pending" };

describe("thread deletion retry", () => {
  it("removes old conversations in batches until none are left, then retries unfinished deletions", async () => {
    const batches = [Array(50).fill(verified), [verified, verified]];
    const deleteLegacyThreads = vi.fn(async () => batches.shift() ?? []);
    const retryIncompleteThreadDeletions = vi.fn(async () => [pending]);
    const diagnostics: Record<string, string>[] = [];
    const retry = new ThreadDeletionRetry({
      deletion: { deleteLegacyThreads, retryIncompleteThreadDeletions },
      onDiagnostic: (event) => diagnostics.push(event),
    });
    expect(await retry.runOnce()).toBe(53);
    expect(deleteLegacyThreads).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([
      { code: "thread_deletion.legacy_deleted", count: "52" },
      { code: "thread_deletion.retry_incomplete", count: "1" },
    ]);
  });

  it("stops asking for old conversations when a full batch makes no progress", async () => {
    const deleteLegacyThreads = vi.fn(async () => Array(50).fill(pending));
    const retry = new ThreadDeletionRetry({
      deletion: { deleteLegacyThreads, retryIncompleteThreadDeletions: async () => [] },
    });
    expect(await retry.runOnce()).toBe(0);
    expect(deleteLegacyThreads).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when there is nothing to remove", async () => {
    const onDiagnostic = vi.fn();
    const retry = new ThreadDeletionRetry({
      deletion: {
        deleteLegacyThreads: async () => [],
        retryIncompleteThreadDeletions: async () => [],
      },
      onDiagnostic,
    });
    expect(await retry.runOnce()).toBe(0);
    expect(onDiagnostic).not.toHaveBeenCalled();
  });
});
