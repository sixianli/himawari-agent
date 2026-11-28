import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionApprovalGateway } from "../../apps/agent-service/src/production-approval-gateway.ts";
import {
  ProductionObservation,
  readServiceRevision,
} from "../../apps/agent-service/src/production-observation.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-observation");
const AGENT_ID = createAgentId("agent-observation");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const FIRST_BOOT = "2026-11-05T03:00:00.000Z";

function message(kind: "command" | "query", type: string, payload: unknown) {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: kind === "command" ? "authorization-01" : null,
    scope,
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${Math.random()}` } : {}),
    payload,
  });
}

describe.each(["worker", "direct"] as const)(
  "[P0-8] observation service through %s",
  (execution) => {
    useSqliteContractExecution(execution);
    const directories: string[] = [];

    afterEach(async () => {
      await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { recursive: true })),
      );
    });

    async function fixture() {
      const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-observation-service-"));
      directories.push(stateRoot);
      const file = path.join(stateRoot, "product.sqlite");
      const database = openQualifiedDatabase(file);
      applyMigrations(database, await loadBundledMigrations());
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(AGENT_ID, OWNER_ID);
      database.close();
      let now = FIRST_BOOT;
      const repository = await SqliteProductStateRepository.open({
        stateRoot,
        minimumFreeBytes: 0,
        now: () => now,
      });
      const service = new ProductionObservation({
        scope,
        observation: repository.ledgerObservation(),
        ledger: repository.decisionLedger(),
        clock: { now: () => now },
        schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
        serviceRevision: "41a6ce3",
      });
      return {
        repository,
        service,
        raw: () => openQualifiedDatabase(file),
        setNow: (value: string) => {
          now = value;
        },
      };
    }

    const start = (day: string) =>
      message("command", "proactive.observation.start", {
        startDay: day,
        recentAuthenticationRef: null,
      }) as GatewayV2Command;
    const weekly = (end: string | null = null) =>
      message("query", "proactive.weekly.read", { end }) as GatewayV2Query;

    it("[P5-B] adds each connection's numbers for the report week, from the same counts the page uses", async () => {
      const { repository, setNow } = await fixture();
      try {
        const store = repository.mcpConnections();
        const service = new ProductionObservation({
          scope,
          observation: repository.ledgerObservation(),
          ledger: repository.decisionLedger(),
          mcpConnections: store,
          clock: { now: () => "2026-11-13T03:00:00.000Z" },
          schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
          serviceRevision: "41a6ce3",
        });
        setNow("2026-11-13T03:00:00.000Z");
        await repository.mcpOAuth().bindGrant({
          ...scope,
          clientId: "client-weekly",
          registration: "dynamic",
          clientName: "Claude Code",
          redirectUris: ["http://127.0.0.1/callback"],
          newConnection: {
            id: "conn-weekly",
            name: "Claude Code",
            pushPolicy: "ask",
          },
          now: "2026-11-05T03:00:00.000Z",
        });
        const add = (day: string, counts: Record<string, number>, auto = false) =>
          store.addUsage({
            ...scope,
            connectionId: "conn-weekly",
            day,
            tool: "find_memories",
            entry: "oauth",
            auto,
            counts,
          });
        await add("2026-11-06", { calls: 2, delivered: 1, empty: 1 }, true);
        await add("2026-11-12", { calls: 1, failed: 1 });
        await add("2026-11-05", { calls: 50 });
        await add("2026-11-13", { calls: 70 });
        const snapshot = await service.query(
          message("query", "proactive.weekly.read", { end: "2026-11-13" }) as GatewayV2Query,
        );
        gatewayV2MessageSchema.parse(snapshot);
        const report = (snapshot as Extract<typeof snapshot, { type: "proactive.weekly.snapshot" }>)
          .payload.report;
        expect(report.mcpConnections).toMatchObject({
          fromDay: "2026-11-06",
          toDay: "2026-11-12",
          connections: [
            {
              id: "conn-weekly",
              name: "Claude Code",
              status: "active",
              usage: { reads: 3, autoReads: 2, delivered: 1, empty: 1, failed: 1, modelReads: 1 },
            },
          ],
        });
        const without = await new ProductionObservation({
          scope,
          observation: repository.ledgerObservation(),
          ledger: repository.decisionLedger(),
          clock: { now: () => "2026-11-13T03:00:00.000Z" },
          schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
          serviceRevision: "41a6ce3",
        }).query(
          message("query", "proactive.weekly.read", { end: "2026-11-13" }) as GatewayV2Query,
        );
        expect(
          (without as Extract<typeof without, { type: "proactive.weekly.snapshot" }>).payload.report
            .mcpConnections,
        ).toBeNull();
      } finally {
        await repository.close();
      }
    });

    it("only lets the owner start from the day after the first start, once", async () => {
      const { repository, service, setNow } = await fixture();
      try {
        await expect(service.execute(start("2026-11-06"))).rejects.toThrow(/OBSERVATION_NOT_READY/);
        await service.tick();
        setNow("2026-11-05T06:00:00.000Z");
        await expect(service.execute(start("2026-11-05"))).rejects.toThrow(
          /OBSERVATION_START_TOO_EARLY/,
        );
        await expect(service.execute(start("2026-12-20"))).rejects.toThrow(
          /OBSERVATION_START_TOO_LATE/,
        );
        await expect(service.execute(start("2026-11-06"))).resolves.toEqual({
          resultRef: "observation-start:2026-11-06",
          replayed: false,
        });
        await expect(service.execute(start("2026-11-07"))).rejects.toThrow(
          /LEDGER_OBSERVATION_START_ALREADY_SET/,
        );
        expect(await repository.ledgerObservation().readStart(scope)).toMatchObject({
          startDay: "2026-11-06",
          serviceRevision: "41a6ce3",
          firstBootAt: FIRST_BOOT,
        });
      } finally {
        await repository.close();
      }
    });

    it("writes one check per ended day, catches up after downtime and serves a snapshot the contract accepts", async () => {
      const { repository, service, setNow, raw } = await fixture();
      try {
        await service.tick();
        await service.execute(start("2026-11-06"));
        const observation = repository.ledgerObservation();
        for (let hour = 0; hour < 24; hour += 1)
          await observation.beat({
            ...scope,
            at: new Date(Date.parse("2026-11-05T15:05:00.000Z") + hour * 3_600_000).toISOString(),
            serviceRevision: "41a6ce3",
          });
        const database = raw();
        try {
          const insert = database.prepare(
            `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
            cost_micros, duration_ms, owner_rating, rated_at
          ) VALUES (?, ?, ?, 'memory_candidate', ?, '{}', 'kept', 'fixture', '{}', 0, 0, ?, ?)`,
          );
          for (let index = 0; index < 6; index += 1)
            insert.run(
              `m${index}`,
              OWNER_ID,
              AGENT_ID,
              `2026-11-06T0${index}:00:00.000Z`,
              index < 5 ? "useful" : "unneeded",
              "2026-11-06T09:00:00.000Z",
            );
        } finally {
          database.close();
        }
        setNow("2026-11-08T16:30:00.000Z");
        expect(await service.checkDueDays()).toBe(3);
        expect(await service.checkDueDays()).toBe(0);
        const checks = await observation.listChecks(scope);
        expect(checks.map(({ day, status }) => [day, status])).toEqual([
          ["2026-11-06", "blocked"],
          ["2026-11-07", "fail"],
          ["2026-11-08", "fail"],
        ]);
        expect(checks[0]?.counts).toEqual({ memory_candidate: 6 });
        expect(checks[1]?.checks.find(({ code }) => code === "service_running")).toMatchObject({
          status: "fail",
          reason: "hours_missing",
        });

        const early = await service.query(weekly());
        const parsed = gatewayV2MessageSchema.parse(early);
        expect(parsed.type).toBe("proactive.weekly.snapshot");
        const payload = (early as Extract<typeof early, { type: "proactive.weekly.snapshot" }>)
          .payload;
        expect(payload.observation).toMatchObject({
          startDay: "2026-11-06",
          earliestStartDay: "2026-11-06",
          firstReportDay: "2026-11-13",
          passStreak: 0,
          accepted: false,
        });
        expect(payload.observation.days.map(({ status }) => status)).toEqual([
          "blocked",
          "fail",
          "fail",
          "upcoming",
          "upcoming",
          "upcoming",
          "upcoming",
        ]);
        expect(payload.report).toMatchObject({
          startDay: "2026-11-06",
          endDay: "2026-11-13",
          complete: false,
          ratesWithheld: true,
        });
        expect(payload.report.groups).toEqual([
          expect.objectContaining({
            group: "memory_kept",
            total: 6,
            rated: 6,
            rates: { useful: null, unneeded: null, missed: null },
          }),
        ]);

        setNow("2026-11-13T03:00:00.000Z");
        const done = await service.query(weekly());
        gatewayV2MessageSchema.parse(done);
        const finished = (done as Extract<typeof done, { type: "proactive.weekly.snapshot" }>)
          .payload;
        expect(finished.report).toMatchObject({ complete: true, ratesWithheld: false });
        expect(finished.report.groups[0]?.rates.useful).toMatchObject({
          successes: 5,
          samples: 6,
          enough: true,
        });
        expect(finished.report.groups[0]?.rates.missed).toBeNull();
        expect(finished.observation.days.slice(3).map(({ status }) => status)).toEqual([
          "no_check",
          "no_check",
          "no_check",
          "no_check",
        ]);
      } finally {
        await repository.close();
      }
    });

    it("sees a tidy-up failure that was recorded after the day ended but before the check", async () => {
      const { repository, service, setNow, raw } = await fixture();
      try {
        await service.tick();
        await service.execute(start("2026-11-06"));
        const observation = repository.ledgerObservation();
        const database = raw();
        try {
          database
            .prepare(
              `INSERT INTO observation_events (id, owner_id, agent_id, kind, occurred_at, sequence, detail)
               VALUES ('late-failure', ?, ?, 'consolidation_failed', '2026-11-06T15:10:00.000Z',
                 (SELECT coalesce(max(sequence), 0) + 1 FROM observation_events),
                 json_object('day', '2026-11-06', 'errorCode', 'MODEL_TIMEOUT'))`,
            )
            .run(OWNER_ID, AGENT_ID);
        } finally {
          database.close();
        }
        setNow("2026-11-06T16:30:00.000Z");
        await service.checkDueDays();
        const [check] = await observation.listChecks(scope);
        expect(check?.checks.find(({ code }) => code === "consolidation_recorded")).toMatchObject({
          status: "fail",
          reason: "run_failed",
        });
      } finally {
        await repository.close();
      }
    });

    it("refuses to serve a weekly snapshot the contract would reject", async () => {
      const { repository } = await fixture();
      try {
        const observation = repository.ledgerObservation();
        const broken = new ProductionObservation({
          scope,
          observation: {
            ...observation,
            readStart: async () => ({
              ...scope,
              startDay: "2026-11-06",
              setAt: FIRST_BOOT,
              serviceRevision: "41a6ce3",
              firstBootAt: FIRST_BOOT,
            }),
            firstHeartbeat: async () => FIRST_BOOT,
            listChecks: async () => [
              {
                id: "c",
                ...scope,
                day: "2026-11-06",
                checkedAt: "2026-11-06T16:00:00.000Z",
                serviceRevision: "41a6ce3",
                status: "great" as never,
                checks: [],
                counts: {},
              },
            ],
          },
          ledger: repository.decisionLedger(),
          clock: { now: () => "2026-11-07T03:00:00.000Z" },
          schedule: { configured: false, intervalMs: 0, perCheckMs: 0 },
          serviceRevision: "41a6ce3",
        });
        await expect(broken.query(weekly())).rejects.toThrow(/status/);
      } finally {
        await repository.close();
      }
    });

    it("reads the service version from the build file and falls back when it is missing", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "himawari-build-info-"));
      directories.push(directory);
      const file = path.join(directory, "build-info.json");
      await writeFile(file, JSON.stringify({ revision: "41a6ce3", date: "2026-11-03" }));
      expect(readServiceRevision(pathToFileURL(file))).toBe("41a6ce3");
      await writeFile(file, JSON.stringify({ revision: "bad revision!" }));
      expect(readServiceRevision(pathToFileURL(file))).toBe("development");
      expect(readServiceRevision(pathToFileURL(path.join(directory, "missing.json")))).toBe(
        "development",
      );
    });

    it("refuses to set the start day through the gateway without a fresh identity check", async () => {
      const { repository } = await fixture();
      try {
        const executed: GatewayV2Command[] = [];
        let recent = false;
        const fence = { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 };
        const gateway = createProductionApprovalGateway({
          configuration: { ownerId: OWNER_ID, agentId: AGENT_ID },
          repository,
          authority: () => fence as never,
          executionAuthority: () => fence as never,
          clock: { now: () => FIRST_BOOT },
          access: { authorize: async () => ({ allowed: true, reasonCode: "TEST_OWNER" }) },
          recentAuthentication: {
            assertRecentAuthentication: async () => {
              if (!recent) throw new Error("RECENT_AUTH_REQUIRED");
              return {} as never;
            },
          },
          observationControl: {
            query: async () => {
              throw new Error("unused");
            },
            execute: async (command) => {
              executed.push(command);
              return { resultRef: "observation-start:2026-11-06", replayed: false };
            },
          },
        });
        const authentication = {
          ownerId: OWNER_ID,
          subjectId: "owner-subject",
          deviceId: "device-01",
          authenticatedAt: FIRST_BOOT,
          authenticationRef: "auth-01",
        };
        const command = message("command", "proactive.observation.start", {
          startDay: "2026-11-06",
          recentAuthenticationRef: "auth-01",
        }) as GatewayV2Command;
        await expect(gateway.request(authentication as never, command)).rejects.toThrow(
          /RECENT_AUTH_REQUIRED/,
        );
        expect(executed).toHaveLength(0);
        recent = true;
        await expect(gateway.request(authentication as never, command)).resolves.toMatchObject({
          resultRef: "observation-start:2026-11-06",
        });
        expect(executed).toHaveLength(1);
      } finally {
        await repository.close();
      }
    });
  },
);
