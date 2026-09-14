import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GovernedCodingOperationsPort } from "@himawari-agent/application/runtime-port";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGovernedPiCodingTools,
  createPiOperationsFromGovernedHostPort,
} from "../src/index.js";

const run = promisify(execFile);

// Compatibility experiment only: no SRT, production authority, or durable ledger.
// The broker accepts one exact command, never evaluates shell syntax, and never
// falls back to a privileged shell. Arbitrary shell isolation needs separate tests.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "himawari-pi-git-"));
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const home = join(root, "home");
  const source = join(root, "source");
  const transport = join(root, "transport.git");
  const remote = join(root, "allowed.git");
  const other = join(root, "other.git");
  const hooks = join(root, "empty-hooks");
  mkdirSync(home);
  mkdirSync(hooks);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const localGit = (...args: string[]) =>
    execFileSync(git, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  localGit("init", "-b", "main", source);
  localGit("-C", source, "config", "user.name", "Compatibility Fixture");
  localGit("-C", source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "note.txt"), "approved content\n");
  localGit("-C", source, "add", "note.txt");
  localGit("-C", source, "commit", "-m", "approved fixture");
  const oid = localGit("-C", source, "rev-parse", "HEAD");
  const bundle = join(root, "approved.bundle");
  // Export without credentials. This fixture has a trusted, fixed bundle; it
  // does not qualify production snapshot creation from hostile repositories.
  localGit("-C", source, "bundle", "create", bundle, "HEAD");
  for (const path of [transport, remote, other]) localGit("init", "--bare", path);
  localGit("--git-dir", transport, "fetch", bundle, "HEAD:refs/heads/snapshot");
  localGit("--git-dir", remote, "config", "http.receivepack", "true");

  // Random dummy credential, used only by loopback Git HTTP transport.
  const secret = randomBytes(24).toString("hex");
  const authorization = `Basic ${Buffer.from(`fixture:${secret}`).toString("base64")}`;
  let requests = 0;
  let authenticated = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      res.end();
      return;
    }
    authenticated++;
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (!url.pathname.startsWith("/allowed.git/")) {
      res.writeHead(403);
      res.end();
      return;
    }
    const child = spawn(git, ["http-backend"], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "fixture",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      res.writeHead(500);
      res.end();
    });
    child.on("close", (code) => {
      const output = Buffer.concat(chunks);
      const boundary = output.indexOf("\r\n\r\n");
      if (code !== 0 || boundary < 0) {
        if (!res.writableEnded) res.writeHead(500).end();
        return;
      }
      for (const line of output.subarray(0, boundary).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") res.statusCode = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.end(output.subarray(boundary + 4));
    });
    req.pipe(child.stdin);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const target = `http://127.0.0.1:${address.port}/allowed.git`;
  localGit("-C", source, "remote", "add", "origin", target);
  const command = `git push origin ${oid}:refs/heads/review`;
  let approved = true;
  let disclosed = true;
  let credentialUses = 0;
  const reject = async () => {
    throw new Error("FIXTURE_OPERATION_DENIED");
  };
  const port: GovernedCodingOperationsPort = {
    access: reject,
    readFile: reject,
    writeFile: reject,
    makeDirectory: reject,
    async executeCommand(input) {
      if (!approved || !disclosed) throw new Error("FIXTURE_AUTHORITY_DENIED");
      if (input.signal?.aborted) throw new Error("aborted");
      if (input.command !== command || input.cwd !== source)
        throw new Error("FIXTURE_INTENT_DENIED");
      credentialUses++;
      // Ignore caller environment and source config. Only the trusted Git
      // subprocess receives the dummy secret; no credential helper is exposed.
      // This is NOT proof of process isolation against a same-user attacker.
      try {
        await run(
          git,
          [
            "--git-dir",
            transport,
            "-c",
            `core.hooksPath=${hooks}`,
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
            "push",
            "--porcelain",
            target,
            `${oid}:refs/heads/review`,
          ],
          {
            env: {
              ...env,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.extraHeader",
              GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
            },
            ...(input.signal ? { signal: input.signal } : {}),
            timeout: input.timeoutMs ?? 10_000,
            maxBuffer: 64 * 1024,
          },
        );
      } catch {
        // Never serialize execFile's error object, argv, or child diagnostics.
        throw new Error("FIXTURE_GIT_TRANSPORT_FAILED");
      }
      if (localGit("--git-dir", remote, "rev-parse", "refs/heads/review") !== oid)
        throw new Error("FIXTURE_RESULT_UNCONFIRMED");
      input.onData(Buffer.from(`pushed approved commit ${oid}\n`));
      return { exitCode: 0 };
    },
  };
  const [definition] = createGovernedPiCodingTools({
    cwd: source,
    enabled: ["bash"],
    operationsForCall: ({ toolCallId }) => {
      if (toolCallId !== "fixture-call") throw new Error("FIXTURE_CALL_BINDING_DENIED");
      return createPiOperationsFromGovernedHostPort(port);
    },
  });
  const tool = definition as ReturnType<typeof createBashToolDefinition>;
  // Only session metadata is consumed by Pi bash; no AgentSession/model runs here.
  const context = {
    sessionManager: {
      getSessionId: () => "fixture-session",
      getSessionFile: () => undefined,
    },
  } as Parameters<typeof tool.execute>[4];
  return {
    target,
    root,
    source,
    remote,
    other,
    oid,
    secret,
    authorization,
    command,
    port,
    localGit,
    deny: () => {
      approved = false;
    },
    denyDisclosure: () => {
      disclosed = false;
    },
    counts: () => ({ requests, authenticated, credentialUses }),
    execute: (value = command, signal?: AbortSignal) =>
      tool.execute("fixture-call", { command: value, timeout: 10 }, signal, undefined, context),
    async close() {
      await new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("Pi bash to controlled standard Git transport (local compatibility only)", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f?.close();
  });

  it("pushes the pinned commit over authenticated HTTP and returns safe Pi output", async () => {
    writeFileSync(join(f.source, "note.txt"), "uncommitted user edit\n");
    const before = f.localGit("-C", f.source, "status", "--porcelain");
    const result = await f.execute();
    expect(f.counts().authenticated).toBeGreaterThan(0);
    expect(f.counts().credentialUses).toBe(1);
    expect(f.localGit("--git-dir", f.remote, "show", "review:note.txt")).toBe("approved content");
    expect(f.localGit("--git-dir", f.remote, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/review",
    );
    expect(f.localGit("-C", f.source, "status", "--porcelain")).toBe(before);
    expect(JSON.stringify(result)).toContain(f.oid);
    expect(JSON.stringify(result)).not.toContain(f.secret);
    expect(JSON.stringify(result)).not.toContain(f.authorization);
  });

  it("requires authentication at the actual loopback remote", async () => {
    const response = await fetch(`${f.target}/info/refs?service=git-receive-pack`);
    await response.arrayBuffer();
    expect(response.status).toBe(401);
    expect(f.counts().authenticated).toBe(0);
    expect(f.localGit("--git-dir", f.remote, "for-each-ref")).toBe("");
  });

  it("preserves a newer remote tip and returns a safe error on non-fast-forward", async () => {
    f.localGit("-C", f.source, "commit", "--allow-empty", "-m", "newer remote commit");
    const newer = f.localGit("-C", f.source, "rev-parse", "HEAD");
    f.localGit("-C", f.source, "push", f.remote, "HEAD:refs/heads/review");
    await expect(f.execute()).rejects.toThrow("FIXTURE_GIT_TRANSPORT_FAILED");
    expect(f.localGit("--git-dir", f.remote, "rev-parse", "review")).toBe(newer);
  });

  it.each(["authority", "disclosure", "cancel"])(
    "denies %s before credential use or network",
    async (kind) => {
      const controller = new AbortController();
      if (kind === "authority") f.deny();
      if (kind === "disclosure") f.denyDisclosure();
      if (kind === "cancel") controller.abort();
      await expect(f.execute(f.command, controller.signal)).rejects.toThrow();
      expect(f.counts()).toEqual({ requests: 0, authenticated: 0, credentialUses: 0 });
    },
  );

  it.each([
    "git credential fill",
    "env",
    "cat ~/.git-credentials",
    "git push origin HEAD:refs/heads/review",
    "git push --mirror origin",
    "git -c credential.helper=evil push origin HEAD",
    "/usr/bin/git push origin HEAD",
    "git push https://example.invalid/other HEAD:main",
  ])("rejects unsupported intent without privileged fallback: %s", async (command) => {
    await expect(f.execute(command)).rejects.toThrow("FIXTURE_INTENT_DENIED");
    expect(f.counts().requests).toBe(0);
    expect(f.counts().credentialUses).toBe(0);
  });

  it("rejects shell chaining, branch replacement and force refspecs", async () => {
    for (const command of [
      `${f.command}; env`,
      `${f.command} && git credential fill`,
      f.command.replace("refs/heads/review", "refs/heads/main"),
      f.command.replace(f.oid, `+${f.oid}`),
    ])
      await expect(f.execute(command)).rejects.toThrow("FIXTURE_INTENT_DENIED");
    expect(f.counts().credentialUses).toBe(0);
  });

  it("ignores mutated origin, advancing HEAD, source hooks and injected environment", async () => {
    const marker = join(f.root, "hook-executed");
    writeFileSync(join(f.source, ".git/hooks/pre-push"), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o700,
    });
    f.localGit("-C", f.source, "remote", "set-url", "origin", f.other);
    f.localGit("-C", f.source, "config", "url.file:///forbidden/.insteadOf", "http://");
    writeFileSync(join(f.source, "later.txt"), "not approved\n");
    f.localGit("-C", f.source, "add", "later.txt");
    f.localGit("-C", f.source, "commit", "-m", "unapproved later commit");
    const later = f.localGit("-C", f.source, "rev-parse", "HEAD");
    await f.port.executeCommand({
      command: f.command,
      cwd: f.source,
      onData: () => undefined,
      environment: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: join(f.source, ".git/hooks"),
      },
    });
    expect(f.localGit("--git-dir", f.remote, "rev-parse", "review")).toBe(f.oid);
    expect(f.localGit("--git-dir", f.other, "for-each-ref")).toBe("");
    expect(f.localGit("-C", f.source, "rev-parse", "HEAD")).toBe(later);
    expect(existsSync(marker)).toBe(false);
  });
});
