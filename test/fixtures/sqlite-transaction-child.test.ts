import type { CommitStateAndEventsInput } from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createIdempotencyKey,
  createOwnerId,
} from "@himawari-agent/domain";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { describe, it } from "vitest";

describe("SQLite transaction crash fixture", () => {
  it("terminates its process after the selected in-transaction worker crash", async () => {
    const {
      HIMAWARI_SQLITE_CRASH_DATABASE: databasePath,
      HIMAWARI_SQLITE_CRASH_STATE_ROOT: stateRoot,
      HIMAWARI_SQLITE_CRASH_AT: crashAt,
    } = process.env;
    if (!databasePath || !stateRoot) throw new Error("Crash fixture paths are required");
    if (
      crashAt !== "after_state" &&
      crashAt !== "after_result" &&
      crashAt !== "after_event" &&
      crashAt !== "after_commit"
    ) {
      throw new Error("A supported crash checkpoint is required");
    }

    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath,
      minimumFreeBytes: 0,
      warningFreeBytes: 0,
      qualification: { crashAt },
    });
    const input: CommitStateAndEventsInput = {
      command: {
        ownerId: createOwnerId("owner-sqlite-crash"),
        agentId: createAgentId("agent-sqlite-crash"),
        idempotencyKey: createIdempotencyKey("command-sqlite-crash"),
        commandType: "run.transition",
        commandFingerprint: "run.transition:crash-matrix",
        authority: {
          leaseId: createAuthorityLeaseId("lease-sqlite-crash"),
          fencingToken: 1,
        },
      },
      state: {
        key: "run:sqlite-crash",
        expectedRevision: null,
        value: { status: "accepted" },
      },
      events: [
        {
          id: "event-sqlite-crash",
          idempotencyKey: createIdempotencyKey("command-sqlite-crash"),
          topic: "run.accepted",
          payloadRef: "payload-sqlite-crash",
          occurredAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      resultRef: "run:sqlite-crash",
      committedAt: "2026-08-26T00:00:00.000Z",
    };

    try {
      await repository.commitStateAndEvents(input);
      throw new Error("The crash checkpoint was not reached");
    } catch {
      process.kill(process.pid, "SIGKILL");
    }
  });
});
