import { createHash } from "node:crypto";
import { hostDirectoryGrantStateKey } from "@himawari-agent/application";
import { createIdempotencyKey } from "@himawari-agent/domain";
import type { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { AGENT_ID, OWNER_ID, SERVICE_AUTHORITY } from "./sqlite-capability-invocation-fixture.ts";

/** Withdraw only this synthetic directory Grant through the production state CAS.
 * Does not revoke the action Grant or manufacture any resource/event outcome. */
export async function revokeFixtureDirectoryGrant(
  repository: SqliteProductStateRepository,
  id: string,
  revokedAt: string,
) {
  const key = hostDirectoryGrantStateKey(id);
  const stored = await repository.readScopedState(OWNER_ID, AGENT_ID, key);
  if (!stored) throw new Error("FIXTURE_DIRECTORY_GRANT_MISSING");
  await repository.commitStateAndEvents({
    command: {
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      idempotencyKey: createIdempotencyKey(`test-revoke:${id}`),
      commandType: "qualification.directory.revoke",
      commandFingerprint: createHash("sha256").update(key).digest("hex"),
      authority: SERVICE_AUTHORITY.lease,
    },
    state: {
      key,
      expectedRevision: stored.revision,
      value: { ...stored.value, revision: stored.revision + 1, revokedAt },
    },
    events: [],
    resultRef: "test-directory-revoked",
    committedAt: revokedAt,
  });
  return repository.readScopedState(OWNER_ID, AGENT_ID, key);
}
