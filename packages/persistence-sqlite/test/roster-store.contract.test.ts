import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveTenantIdentifiers,
  normalizeTenantEmail,
  RosterStore,
  tenantSubjectReference,
} from "../src/index.js";

let directory: string;
let rosterPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "himawari-roster-"));
  rosterPath = path.join(directory, "roster.sqlite");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const context = (now: string) => ({ actor: "owner:andy", now });

describe("roster store", () => {
  it("opens with WAL and busy timeout and keeps its own migration ledger", () => {
    const roster = RosterStore.open(rosterPath);
    roster.close();
    const database = new BetterSqlite3(rosterPath, { readonly: true });
    try {
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.prepare("SELECT sequence, name FROM schema_migration_ledger").all()).toEqual([
        { sequence: 1, name: "initial_roster_schema" },
      ]);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .pluck()
          .all(),
      ).toEqual(expect.arrayContaining(["audit", "limits", "meta", "tenants", "usage_monthly"]));
    } finally {
      database.close();
    }
    const reopened = RosterStore.open(rosterPath);
    expect(reopened.revision()).toBe(0);
    reopened.close();
  });

  it("orders tenants by creation time then id and bumps the revision on every admin change", () => {
    const roster = RosterStore.open(rosterPath);
    try {
      roster.add(
        { identifiers: deriveTenantIdentifiers("zed"), email: "z@example.com", kind: "member" },
        context("2026-11-13T00:00:00.000Z"),
      );
      roster.add(
        { identifiers: deriveTenantIdentifiers("amy"), email: "a@example.com", kind: "member" },
        context("2026-11-13T00:00:00.000Z"),
      );
      roster.add(
        { identifiers: deriveTenantIdentifiers("bob"), email: "b@example.com", kind: "trial" },
        context("2026-11-12T00:00:00.000Z"),
      );
      expect(roster.list().map(({ tenantId }) => tenantId)).toEqual(["bob", "amy", "zed"]);
      expect(roster.revision()).toBe(3);
      roster.setStatus("bob", "active", context("2026-11-13T01:00:00.000Z"));
      roster.setLimit(
        { scopeKind: "others_total", tenantId: null, metric: "calls", monthlyLimit: null },
        context("2026-11-13T01:00:00.000Z"),
      );
      expect(roster.revision()).toBe(5);
      expect(roster.listAudit().map(({ action }) => action)).toEqual([
        "tenant.added",
        "tenant.added",
        "tenant.added",
        "tenant.status_changed",
        "limit.changed",
      ]);
    } finally {
      roster.close();
    }
  });

  it("does not bump the revision when usage counters are written", () => {
    RosterStore.open(rosterPath).close();
    const roster = RosterStore.open(rosterPath);
    roster.add(
      { identifiers: deriveTenantIdentifiers("amy"), email: "a@example.com", kind: "member" },
      context("2026-11-13T00:00:00.000Z"),
    );
    const before = roster.revision();
    roster.close();
    const database = new BetterSqlite3(rosterPath);
    try {
      database
        .prepare("INSERT INTO usage_monthly (tenant_id, month, calls) VALUES ('amy', '2026-11', 1)")
        .run();
    } finally {
      database.close();
    }
    const reopened = RosterStore.open(rosterPath);
    expect(reopened.revision()).toBe(before);
    reopened.close();
  });

  it("rejects duplicate emails after normalization and duplicate login subjects", () => {
    const roster = RosterStore.open(rosterPath);
    try {
      const now = context("2026-11-13T00:00:00.000Z");
      roster.add(
        { identifiers: deriveTenantIdentifiers("amy"), email: "Amy@Example.com", kind: "member" },
        now,
      );
      expect(roster.findByEmail("ＡＭＹ@example.com")?.tenantId).toBe("amy");
      expect(() =>
        roster.add(
          {
            identifiers: deriveTenantIdentifiers("amy2"),
            email: " amy@EXAMPLE.com ",
            kind: "member",
          },
          now,
        ),
      ).toThrow(expect.objectContaining({ code: "ROSTER_EMAIL_TAKEN" }));
      expect(() =>
        roster.add(
          {
            identifiers: deriveTenantIdentifiers("amy"),
            email: "other@example.com",
            kind: "member",
          },
          now,
        ),
      ).toThrow(expect.objectContaining({ code: "ROSTER_TENANT_EXISTS" }));
      roster.add(
        { identifiers: deriveTenantIdentifiers("bob"), email: "bob@example.com", kind: "member" },
        now,
      );
      const subject = tenantSubjectReference("https://team.example", "sub-1");
      roster.bindSubject("amy", subject, now);
      expect(roster.findBySubjectReference(subject)?.tenantId).toBe("amy");
      expect(() => roster.bindSubject("bob", subject, now)).toThrow(
        expect.objectContaining({ code: "ROSTER_SUBJECT_TAKEN" }),
      );
      expect(() =>
        roster.bindSubject("amy", tenantSubjectReference("https://team.example", "sub-2"), now),
      ).toThrow(expect.objectContaining({ code: "ROSTER_SUBJECT_ALREADY_BOUND" }));
      const rebound = roster.rebindSubject(
        "amy",
        tenantSubjectReference("https://team.example", "sub-2"),
        now,
      );
      expect(rebound.externalSubjectRef).not.toBe(subject);
    } finally {
      roster.close();
    }
  });

  it("enforces limit and status rules in the database itself", () => {
    RosterStore.open(rosterPath).close();
    const database = new BetterSqlite3(rosterPath);
    database.pragma("foreign_keys = ON");
    try {
      const insertLimit = database.prepare(
        "INSERT INTO limits (scope_kind, tenant_id, metric, monthly_limit, updated_by, updated_at) VALUES (?, ?, ?, ?, 'x', 'now')",
      );
      expect(() => insertLimit.run("others_total", null, "dollars", 1)).toThrow(/CHECK/);
      expect(() => insertLimit.run("tenant", null, "calls", 1)).toThrow(/CHECK/);
      expect(() => insertLimit.run("default_new", null, "calls", -1)).toThrow(/CHECK/);
      insertLimit.run("default_new", null, "calls", null);
      expect(() => insertLimit.run("default_new", null, "calls", 3)).toThrow(/UNIQUE/);
      const insertTenant = database.prepare(
        "INSERT INTO tenants (tenant_id, email, owner_id, agent_id, deployment_id, kind, status, created_at) VALUES (?, ?, 'o', 'a', 'd', 'member', ?, 'now')",
      );
      expect(() => insertTenant.run("Amy", "a@x", "active")).toThrow(/CHECK/);
      expect(() => insertTenant.run("a@b", "a@x", "active")).toThrow(/CHECK/);
      expect(() => insertTenant.run("amy", "a@x", "deleted")).toThrow(/CHECK/);
    } finally {
      database.close();
    }
  });
});

describe("tenant identifiers", () => {
  it("derives identifiers for the longest slug that pass every validator", () => {
    const slug = "a".repeat(32);
    expect(deriveTenantIdentifiers(slug)).toEqual({
      tenantId: slug,
      ownerId: `owner:${slug}`,
      agentId: `agent:${slug}`,
      deploymentId: `deployment:${slug}`,
    });
  });

  it.each(["", "a".repeat(33), "Amy", "amy@example.com", "-amy", "amy-", "a/b", "a.b", "a_b"])(
    "rejects the slug %j",
    (slug) => {
      expect(() => deriveTenantIdentifiers(slug)).toThrow(
        expect.objectContaining({ code: "TENANT_SLUG_INVALID" }),
      );
    },
  );

  it("normalizes emails with NFKC and lower case and rejects malformed ones", () => {
    expect(normalizeTenantEmail(" Ａmy@Example.COM ")).toBe("amy@example.com");
    expect(normalizeTenantEmail("amy+news@example.com")).toBe("amy+news@example.com");
    for (const bad of ["amy", "@example.com", "amy@", "a@b@c", "a b@c"])
      expect(() => normalizeTenantEmail(bad)).toThrow(
        expect.objectContaining({ code: "TENANT_EMAIL_INVALID" }),
      );
  });

  it("hashes issuer and subject with a separator so the parts cannot be shifted", () => {
    expect(tenantSubjectReference("ab", "c")).not.toBe(tenantSubjectReference("a", "bc"));
    expect(tenantSubjectReference("https://team.example", "s")).toMatch(/^[0-9a-f]{64}$/);
    expect(() => tenantSubjectReference("https://team.example", "")).toThrow(
      expect.objectContaining({ code: "TENANT_SUBJECT_INVALID" }),
    );
  });
});
