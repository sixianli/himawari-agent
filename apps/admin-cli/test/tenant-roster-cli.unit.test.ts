import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  deriveTenantIdentifiers,
  RosterStore,
  type TenantIdentifiers,
} from "@himawari-agent/persistence-sqlite";
import {
  differingConfigurationFields,
  EnvelopePayloadProtector,
  listConfigurationKeyPaths,
  parseProductConfiguration,
  provisionTenantKeyFiles,
  RestrictedSecretFileSource,
  synthesizeTenantConfiguration,
} from "@himawari-agent/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdminCli } from "../src/index.js";
import { verifyTenantIdentifiersOnRealDatabase } from "../src/tenant-command.js";

const NOW = "2026-11-13T00:00:00.000Z";

async function baseConfiguration(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../../scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, read: () => text };
}

async function admin(arguments_: readonly string[]) {
  const stdout = capture();
  const stderr = capture();
  const code = await runAdminCli(arguments_, stdout.stream, stderr.stream);
  return {
    code,
    output: stdout.read() ? JSON.parse(stdout.read()) : undefined,
    error: stderr.read() ? JSON.parse(stderr.read()) : undefined,
  };
}

let root: string;
let sharedRoot: string;
let tenantsRoot: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "himawari-tenant-cli-")));
  sharedRoot = path.join(root, "shared");
  tenantsRoot = path.join(sharedRoot, "tenants");
  await mkdir(tenantsRoot, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function provision(identifiers: TenantIdentifiers, others: readonly string[] = []) {
  const synthesized = synthesizeTenantConfiguration({
    base: await baseConfiguration(),
    tenant: identifiers,
    tenantsRoot,
    otherStateRoots: others.map((slug) => path.join(tenantsRoot, slug)),
    now: NOW,
  });
  const input = path.join(root, `${identifiers.tenantId}.input.json`);
  await writeFile(input, JSON.stringify(synthesized.raw), { mode: 0o600 });
  const initialized = await admin(["init", "--config", input]);
  expect(initialized.error).toBeUndefined();
  const keys = await provisionTenantKeyFiles({
    stateRoot: synthesized.configuration.stateRoot,
    configuration: synthesized.configuration,
  });
  return { synthesized, keys };
}

describe("check 7: configuration synthesis", () => {
  it("adds no configuration key and rewrites every tenant-bound value", async () => {
    const base = await baseConfiguration();
    const tenant = deriveTenantIdentifiers("alice");
    const { raw, configuration, secrets } = synthesizeTenantConfiguration({
      base,
      tenant,
      tenantsRoot,
      now: NOW,
    });
    expect(listConfigurationKeyPaths(raw)).toEqual(listConfigurationKeyPaths(base));
    expect(parseProductConfiguration(raw, NOW)).toEqual(configuration);
    const stateRoot = path.join(tenantsRoot, "alice");
    expect(configuration).toMatchObject({
      deploymentId: "deployment:alice",
      ownerId: "owner:alice",
      agentId: "agent:alice",
      stateRoot,
      runtimeDirectory: path.join(stateRoot, "runtime"),
      cacheDirectory: path.join(stateRoot, "cache"),
      memory: { storagePath: path.join(stateRoot, "data", "memory") },
      capabilityDeployment: {
        snapshotPath: path.join(stateRoot, "deployment", "capability-deployment.json"),
      },
      runPolicy: { coding: { workerInstanceId: "execution-worker:deployment:alice" } },
    });
    expect(JSON.stringify(raw)).not.toContain("/var/lib/himawari/state");
    expect(secrets.shared).toEqual([{ ref: "vercel-gateway", version: "v1" }]);
    expect(secrets.perTenant).toEqual([
      { ref: "payload-key", version: "v1" },
      { ref: "identity-csrf", version: "v1" },
    ]);
    const scopes = Object.fromEntries(
      configuration.secretReferences.map(({ ref, scope }) => [ref, scope]),
    );
    expect(scopes).toEqual({
      "vercel-gateway": "himawari-prod-deployment",
      "payload-key": "deployment:alice",
      "identity-csrf": "deployment:alice",
    });
  });

  it("reproduces the existing configuration field by field for the owner's own identity", async () => {
    const base = await baseConfiguration();
    const { raw } = synthesizeTenantConfiguration({
      base,
      tenant: {
        tenantId: "andy",
        ownerId: String(base["ownerId"]),
        agentId: String(base["agentId"]),
        deploymentId: String(base["deploymentId"]),
      },
      tenantsRoot,
      stateRoot: String(base["stateRoot"]),
      now: NOW,
    });
    expect(differingConfigurationFields(raw, base)).toEqual([]);
    const drifted = structuredClone(base) as { http: { listenPort: number } };
    drifted.http.listenPort += 1;
    expect(differingConfigurationFields(raw, drifted)).toEqual(["$.http.listenPort"]);
  });

  it("refuses a secret purpose that is neither per-tenant nor shared", async () => {
    const base = await baseConfiguration();
    (base["secretReferences"] as unknown[]).push({
      ref: "something",
      version: "v1",
      purpose: "brand-new-purpose",
      scope: "himawari-prod-deployment",
    });
    expect(() =>
      synthesizeTenantConfiguration({
        base,
        tenant: deriveTenantIdentifiers("alice"),
        tenantsRoot,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "TENANT_SECRET_PURPOSE_UNCLASSIFIED" }));
  });

  it("refuses an unclassified purpose even when a model uses it", async () => {
    const base = await baseConfiguration();
    for (const entry of base["secretReferences"] as { ref: string; purpose: string }[])
      if (entry.ref === "vercel-gateway") entry.purpose = "brand-new-model-purpose";
    expect(() =>
      synthesizeTenantConfiguration({
        base,
        tenant: deriveTenantIdentifiers("alice"),
        tenantsRoot,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "TENANT_SECRET_PURPOSE_UNCLASSIFIED" }));
  });

  it("refuses a per-tenant purpose that a model would share", async () => {
    const base = await baseConfiguration();
    const [primary] = base["modelDescriptors"] as { secretRef: string }[];
    if (!primary) throw new Error("template has no model");
    primary.secretRef = "payload-key";
    expect(() =>
      synthesizeTenantConfiguration({
        base,
        tenant: deriveTenantIdentifiers("alice"),
        tenantsRoot,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "TENANT_SECRET_PURPOSE_CONFLICT" }));
  });

  it("refuses a base configuration without exactly one payload key", async () => {
    const base = await baseConfiguration();
    base["secretReferences"] = (base["secretReferences"] as { purpose: string }[]).filter(
      ({ purpose }) => purpose !== "payload-encryption",
    );
    expect(() =>
      synthesizeTenantConfiguration({
        base,
        tenant: deriveTenantIdentifiers("alice"),
        tenantsRoot,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: "TENANT_PAYLOAD_KEY_COUNT_INVALID" }));
  });
});

describe("check 8: directories and keys", () => {
  it("gives each person private directories and different keys that cannot open each other's data", async () => {
    const alice = await provision(deriveTenantIdentifiers("alice"));
    const bob = await provision(deriveTenantIdentifiers("bob"), ["alice"]);
    for (const tenant of [alice, bob]) {
      const stateRoot = tenant.synthesized.configuration.stateRoot;
      expect((await lstat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(stateRoot, "secrets"))).mode & 0o777).toBe(0o700);
      for (const name of await readdir(path.join(stateRoot, "secrets")))
        expect((await lstat(path.join(stateRoot, "secrets", name))).mode & 0o777).toBe(0o600);
      expect(tenant.keys.written).toEqual(["payload-key.v1", "identity-csrf.v1"]);
    }
    for (const name of ["payload-key.v1", "identity-csrf.v1"]) {
      const aliceKey = await readFile(
        path.join(alice.synthesized.configuration.stateRoot, "secrets", name),
      );
      const bobKey = await readFile(
        path.join(bob.synthesized.configuration.stateRoot, "secrets", name),
      );
      expect(aliceKey.equals(bobKey)).toBe(false);
    }
    const protector = (stateRoot: string) =>
      new EnvelopePayloadProtector({
        keys: new RestrictedSecretFileSource(path.join(stateRoot, "secrets")),
        activeKey: { keyRef: "payload-key", kekVersion: "v1", dekVersion: "dek-v1" },
      });
    const { ownerId, agentId } = alice.synthesized.configuration;
    const scope = { ownerId, agentId };
    const aliceProtector = protector(alice.synthesized.configuration.stateRoot);
    const payload = await aliceProtector.protect({
      ...scope,
      ref: "payload:check-8",
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("alice only"),
      createdAt: NOW,
    });
    expect(new TextDecoder().decode(await aliceProtector.unprotect({ ...scope, payload }))).toBe(
      "alice only",
    );
    await expect(
      protector(bob.synthesized.configuration.stateRoot).unprotect({ ...scope, payload }),
    ).rejects.toThrow();
  });

  it("keeps existing keys, fills only the missing ones and refuses unsafe names", async () => {
    const alice = await provision(deriveTenantIdentifiers("alice"));
    const secrets = path.join(alice.synthesized.configuration.stateRoot, "secrets");
    const payloadKey = await readFile(path.join(secrets, "payload-key.v1"));
    await rm(path.join(secrets, "identity-csrf.v1"));
    const retried = await provisionTenantKeyFiles({
      stateRoot: alice.synthesized.configuration.stateRoot,
      configuration: alice.synthesized.configuration,
    });
    expect(retried).toMatchObject({ written: ["identity-csrf.v1"], kept: ["payload-key.v1"] });
    expect((await readFile(path.join(secrets, "payload-key.v1"))).equals(payloadKey)).toBe(true);
    for (const ref of ["nested/key", "user@key"]) {
      const base = await baseConfiguration();
      for (const entry of base["secretReferences"] as { ref: string; purpose: string }[])
        if (entry.purpose === "identity-csrf") entry.ref = ref;
      (base["identity"] as { csrf: { keySecretRef: string } }).csrf.keySecretRef = ref;
      const { configuration } = synthesizeTenantConfiguration({
        base,
        tenant: deriveTenantIdentifiers("carol"),
        tenantsRoot,
        now: NOW,
      });
      await expect(
        provisionTenantKeyFiles({ stateRoot: configuration.stateRoot, configuration }),
      ).rejects.toThrow(expect.objectContaining({ code: "HOST_SECRET_INVALID_REFERENCE" }));
    }
    expect(await readdir(path.join(tenantsRoot, "carol", "secrets"))).toEqual([]);
  });
});

describe("check 11: generated values pass every validator", () => {
  it("accepts the longest slug through parser, identifiers, contract strings and a real database", async () => {
    const identifiers = deriveTenantIdentifiers("a".repeat(32));
    await verifyTenantIdentifiersOnRealDatabase(identifiers);
    const { synthesized } = await provision(identifiers);
    expect(synthesized.configuration.deploymentId).toBe(`deployment:${"a".repeat(32)}`);
    const authority = JSON.parse(
      await readFile(path.join(synthesized.configuration.stateRoot, "authority.json"), "utf8"),
    );
    expect(authority).toMatchObject({ id: identifiers.deploymentId, status: "active" });
  });

  it("rejects an at sign before any file is written", async () => {
    await expect(
      verifyTenantIdentifiersOnRealDatabase({
        tenantId: "amy",
        ownerId: "owner:amy@example.com",
        agentId: "agent:amy",
        deploymentId: "deployment:amy",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "TENANT_IDENTIFIER_INVALID" }));
    expect(() => deriveTenantIdentifiers("amy@example.com")).toThrow();
    expect(await readdir(tenantsRoot)).toEqual([]);
  });

  it("rejects a state root nested in another person's before any file is written", async () => {
    const base = await baseConfiguration();
    for (const stateRoot of [
      path.join(tenantsRoot, "alice", "data", "bob"),
      path.join(tenantsRoot, "alice"),
      tenantsRoot,
    ])
      expect(() =>
        synthesizeTenantConfiguration({
          base,
          tenant: deriveTenantIdentifiers("bob"),
          tenantsRoot,
          stateRoot,
          otherStateRoots: [path.join(tenantsRoot, "alice")],
          now: NOW,
        }),
      ).toThrow(expect.objectContaining({ code: "TENANT_STATE_ROOT_NESTED" }));
    expect(await readdir(tenantsRoot)).toEqual([]);
  });
});

describe("admin commands for one named person", () => {
  async function rosterWith(...slugs: string[]) {
    const roster = RosterStore.open(path.join(sharedRoot, "roster.sqlite"));
    try {
      for (const slug of slugs)
        roster.add(
          {
            identifiers: deriveTenantIdentifiers(slug),
            email: `${slug}@example.com`,
            kind: "member",
            status: "active",
          },
          { actor: "owner:andy", now: NOW },
        );
    } finally {
      roster.close();
    }
  }

  it("runs an existing command against the named person's own data", async () => {
    await rosterWith("alice", "bob");
    await provision(deriveTenantIdentifiers("alice"));
    await provision(deriveTenantIdentifiers("bob"), ["alice"]);
    for (const slug of ["alice", "bob"]) {
      const status = await admin(["db", "status", "--tenant", slug, "--shared-root", sharedRoot]);
      expect(status.error).toBeUndefined();
      expect(status.output).toMatchObject({
        command: "db.status",
        deploymentId: `deployment:${slug}`,
      });
    }
    const listed = await admin(["tenant", "list", "--shared-root", sharedRoot]);
    expect(listed.output.tenants.map((tenant: { tenantId: string }) => tenant.tenantId)).toEqual([
      "alice",
      "bob",
    ]);
    const base = path.join(root, "base.json");
    await writeFile(base, JSON.stringify(await baseConfiguration()), { mode: 0o600 });
    const checked = await admin([
      "tenant",
      "check",
      "--shared-root",
      sharedRoot,
      "--tenant",
      "alice",
      "--base-config",
      base,
    ]);
    expect(checked.error).toBeUndefined();
    expect(checked.output).toMatchObject({
      tenantId: "alice",
      sharedSecrets: ["vercel-gateway.v1"],
      perTenantSecrets: ["payload-key.v1", "identity-csrf.v1"],
      storedConfiguration: { present: true, differingFields: [] },
    });
  });

  it("refuses unknown people, missing setup, mixed targets and tampered configuration", async () => {
    expect(
      (await admin(["db", "status", "--tenant", "alice", "--shared-root", sharedRoot])).error,
    ).toEqual({ error: { code: "TENANT_ROSTER_MISSING" } });
    await rosterWith("alice", "bob");
    expect(
      (await admin(["db", "status", "--tenant", "carol", "--shared-root", sharedRoot])).error,
    ).toEqual({ error: { code: "TENANT_NOT_FOUND" } });
    expect(
      (await admin(["db", "status", "--tenant", "alice", "--shared-root", sharedRoot])).error,
    ).toEqual({ error: { code: "TENANT_NOT_PROVISIONED" } });
    const { synthesized } = await provision(deriveTenantIdentifiers("alice"));
    expect(
      (
        await admin([
          "db",
          "status",
          "--tenant",
          "alice",
          "--shared-root",
          sharedRoot,
          "--config",
          "/x.json",
        ])
      ).error,
    ).toEqual({ error: { code: "TENANT_ARGUMENT_INVALID" } });
    expect((await admin(["db", "status", "--tenant", "alice"])).error).toEqual({
      error: { code: "TENANT_ARGUMENT_INVALID" },
    });
    const storedPath = path.join(synthesized.configuration.stateRoot, "configuration.json");
    const stored = JSON.parse(await readFile(storedPath, "utf8"));
    await rm(storedPath);
    await writeFile(storedPath, JSON.stringify({ ...stored, ownerId: "owner:bob" }), {
      mode: 0o600,
    });
    expect(
      (await admin(["db", "status", "--tenant", "alice", "--shared-root", sharedRoot])).error,
    ).toEqual({ error: { code: "TENANT_CONFIGURATION_MISMATCH" } });
    const listed = await admin([
      "sandbox",
      "list-unconfirmed",
      "--tenant",
      "bob",
      "--shared-root",
      sharedRoot,
    ]);
    expect(listed.error).toEqual({ error: { code: "TENANT_NOT_PROVISIONED" } });
    const rosterPath = path.join(sharedRoot, "roster.sqlite");
    await chmod(rosterPath, 0o620);
    expect((await admin(["tenant", "list", "--shared-root", sharedRoot])).error).toEqual({
      error: { code: "TENANT_ROSTER_UNSAFE" },
    });
    await chmod(rosterPath, 0o600);
    await rename(rosterPath, `${rosterPath}.real`);
    await symlink(`${rosterPath}.real`, rosterPath);
    expect((await admin(["tenant", "list", "--shared-root", sharedRoot])).error).toEqual({
      error: { code: "TENANT_ROSTER_UNSAFE" },
    });
  });

  it("runs commands that read --config by position for the named person", async () => {
    await rosterWith("alice");
    await provision(deriveTenantIdentifiers("alice"));
    const listed = await admin([
      "sandbox",
      "list-unconfirmed",
      "--tenant",
      "alice",
      "--shared-root",
      sharedRoot,
    ]);
    expect(listed.error).toBeUndefined();
    expect(listed.output).toMatchObject({ command: "sandbox.list-unconfirmed" });
  });
});
