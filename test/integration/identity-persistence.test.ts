import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeviceId, createOwnerId, createSessionId } from "@himawari-agent/domain";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import { describe, expect, it } from "vitest";

const T0 = "2026-08-27T00:00:00.000Z";
const T1 = "2026-08-27T00:01:00.000Z";

describe("persistent Owner identity, session and device state", () => {
  it("atomically consumes bootstrap and preserves revocation across restart", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-identity-"));
    const ownerId = createOwnerId("owner-identity-01");
    const deviceId = createDeviceId("device-identity-01");
    const sessionId = createSessionId("session-identity-01");
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const identities = repository.ownerIdentityState();
    const sessions = repository.sessionDeviceState();
    expect(
      await identities.bindFirstOwner({
        ownerId,
        externalSubjectRef: "sha256:subject-01",
        boundAt: T0,
      }),
    ).toMatchObject({ ownerId, status: "active" });
    await expect(
      identities.bindFirstOwner({
        ownerId,
        externalSubjectRef: "sha256:subject-01",
        boundAt: T0,
      }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });

    const device = await sessions.saveDevice(
      {
        id: deviceId,
        ownerId,
        label: "MacBook",
        status: "active",
        firstSeenAt: T0,
        lastSeenAt: T0,
      },
      null,
    );
    const session = await sessions.saveSession(
      {
        id: sessionId,
        ownerId,
        deviceId,
        authenticationRef: "sha256:session-secret",
        status: "active",
        firstAuthenticatedAt: T0,
        lastActiveAt: T0,
        recentAuthenticatedAt: T0,
        revokedAt: null,
      },
      null,
    );
    expect(await sessions.findSessionByAuthenticationRef(session.authenticationRef)).toEqual(
      session,
    );
    await sessions.revokeDevice(deviceId, device.revision, T1);
    expect(await sessions.readSession(sessionId)).toMatchObject({
      status: "revoked",
      revokedAt: T1,
    });
    await repository.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T1,
    });
    expect(await reopened.ownerIdentityState().readBySubject("sha256:subject-01")).toMatchObject({
      ownerId,
    });
    expect(await reopened.sessionDeviceState().listDevices(ownerId, false)).toEqual([]);
    expect(await reopened.sessionDeviceState().listSessions(ownerId, true)).toHaveLength(1);
    await reopened.close();
    await rm(stateRoot, { recursive: true });
  });
});
