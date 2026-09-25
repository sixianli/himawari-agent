import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExecutionBackendPort } from "@himawari-agent/application";
import {
  EXECUTION_ENVELOPE_V1,
  EXECUTION_ENVIRONMENT_V1,
  type ExecutionEnvironmentIdentity,
  type ExecutionEnvironmentLocator,
  executionEnvironmentStopProofSchema,
} from "@himawari-agent/execution-contracts";
import {
  CONTAINER_RUNNER_DIGEST,
  ContainerExecutionBackend,
  type ContainerExecutionBackendOptions,
  dockerCli,
  type HostDirectoryIdentity,
  hostFreeBytes,
} from "@himawari-agent/runtime-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["HIMAWARI_CONTAINER_QUALIFICATION"] === "1";
const containerDescribe = enabled ? describe : describe.skip;
const dockerExecutable = process.env["HIMAWARI_CONTAINER_DOCKER_CLI"] ?? "docker";
const dockerHost = process.env["HIMAWARI_CONTAINER_DOCKER_HOST"] ?? "";
const evidencePath = process.env["HIMAWARI_CONTAINER_EVIDENCE_PATH"];
const workRoot = process.env["HIMAWARI_CONTAINER_WORK_ROOT"] ?? os.tmpdir();
const IMAGE_REFERENCE = "docker.io/library/busybox";
const IMAGE_DIGEST = "bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
const RESOURCES = {
  cpuMillicores: 500,
  memoryBytes: 128 * 1024 * 1024,
  maxProcesses: 64,
  privateStorageBytes: 16 * 1024 * 1024,
};
const runId = `run-q-${randomUUID().slice(0, 8)}`;
const observations: Record<string, unknown> = {};

const docker = dockerCli(dockerExecutable, dockerHost ? ["--host", dockerHost] : []);
const direct = async (...args: string[]) =>
  docker(args, { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });

const DISK_GUARD = {
  minFreeBytes: 1024 * 1024 * 1024,
  maxGrowthBytes: 256 * 1024 * 1024,
  intervalMs: 1000,
};

let stateDirectory: string;
let hostRoot: string;
let sequence = 0;
const argumentsByRef = new Map<string, { readonly argv: readonly string[] }>();
const approved = new Map<string, HostDirectoryIdentity>();

function backend(host = dockerHost, overrides: Partial<ContainerExecutionBackendOptions> = {}) {
  const subject = new ContainerExecutionBackend({
    backendRef: "container-docker:qualification",
    docker: dockerCli(dockerExecutable, host ? ["--host", host] : []),
    image: { reference: IMAGE_REFERENCE, digest: IMAGE_DIGEST },
    initUser: "65532:65532",
    taskUser: "65534:65534",
    stateDirectory,
    commandTimeoutMs: 30_000,
    stopGraceSeconds: 1,
    proofValidityMs: 60_000,
    maxOutputBytes: 64 * 1024,
    now: () => new Date(Math.floor(Date.now())),
    readArguments: async (ref) => {
      const value = argumentsByRef.get(ref);
      if (!value) throw new Error("unknown arguments");
      return value;
    },
    resolveDirectory: async (directory) => approved.get(directory.canonicalRootId) ?? null,
    hostDirectories: { maxScannedEntries: 20_000, maxProtectedEntries: 256 },
    diskGuard: { ...DISK_GUARD, freeBytes: hostFreeBytes },
    ...overrides,
  });
  const port: ExecutionBackendPort = subject;
  return Object.assign(port, {
    readOutput: subject.readOutput.bind(subject),
    readEvidence: subject.readEvidence.bind(subject),
    diskGuardBreach: subject.diskGuardBreach.bind(subject),
  });
}

async function approve(canonicalRootId: string, directory: string) {
  const info = await lstat(directory);
  approved.set(canonicalRootId, {
    canonicalPath: directory,
    device: String(info.dev),
    inode: String(info.ino),
  });
  return directory;
}

function grant(canonicalRootId: string, access: "read" | "write") {
  return {
    hostId: "host-q",
    grantRef: `grant-${canonicalRootId}`,
    canonicalRootId,
    access,
    source: {
      authorizationRef: `authorization-${canonicalRootId}`,
      decidedBy: "user" as const,
      delegationListRef: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
}

async function tree(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=q", "-c", "user.email=q@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function listening(file: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, resolve);
  });
  return server;
}

async function caseInsensitive(directory: string) {
  await writeFile(path.join(directory, "case-probe"), "");
  const insensitive = await lstat(path.join(directory, "CASE-PROBE")).then(
    () => true,
    () => false,
  );
  await rm(path.join(directory, "case-probe"));
  return insensitive;
}

async function containersOfRun() {
  const listed = await direct(
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=io.himawari.environment.run=${runId}`,
  );
  return listed.stdout.split("\n").filter(Boolean);
}

function environment(deadlineSeconds = 600, directories: ReturnType<typeof grant>[] = []) {
  sequence += 1;
  const identity: ExecutionEnvironmentIdentity = {
    schemaVersion: EXECUTION_ENVIRONMENT_V1,
    ownerId: "owner-q",
    agentId: "agent-q",
    runId,
    hostId: "host-q",
    executionJobId: `job-${sequence}`,
    environmentId: `${runId}-environment-${sequence}`,
    environmentGeneration: 1,
    role: "primary",
  };
  const createIntentId = `create-${sequence}`;
  const deadlineAt = new Date(Date.now() + deadlineSeconds * 1000).toISOString();
  return {
    identity,
    createIntentId,
    deadlineAt,
    create: {
      identity,
      createIntentId,
      envelope: {
        schemaVersion: EXECUTION_ENVELOPE_V1,
        directories,
        network: [],
        resources: RESOURCES,
      },
      policyDigest: "b".repeat(64),
      imageDigest: IMAGE_DIGEST,
      runnerDigest: CONTAINER_RUNNER_DIGEST,
      deadlineAt,
    },
  };
}

async function run(
  subject: ReturnType<typeof backend>,
  target: { identity: ExecutionEnvironmentIdentity; createIntentId: string },
  locator: ExecutionEnvironmentLocator,
  script: string,
) {
  const ref = `arguments-${randomUUID()}`;
  argumentsByRef.set(ref, { argv: ["sh", "-c", script] });
  const { outputRef } = await subject.execute({
    identity: target.identity,
    createIntentId: target.createIntentId,
    locator,
    stopFence: 0,
    invocationId: `invocation-${randomUUID()}`,
    argumentsRef: ref,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return subject.readOutput(outputRef);
}

function lines(stdout: string) {
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

async function stopAndProve(
  subject: ReturnType<typeof backend>,
  target: { identity: ExecutionEnvironmentIdentity; createIntentId: string },
  locator: ExecutionEnvironmentLocator,
  stopIntentId = "stop-1",
) {
  const request = { ...target, locator, stopIntentId, stopFence: 1 };
  await subject.stop(request);
  return executionEnvironmentStopProofSchema.parse(await subject.verifyStopped(request));
}

containerDescribe("container execution backend on a real runtime", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const root = await realpath(workRoot);
    stateDirectory = await mkdtemp(path.join(root, "container-qualification-"));
    hostRoot = await mkdtemp(path.join(root, "container-host-"));
  });
  afterAll(async () => {
    if (!enabled) return;
    const listed = await direct(
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=io.himawari.environment.run=${runId}`,
    );
    const ids = listed.stdout.split("\n").filter(Boolean);
    if (ids.length) await direct("container", "rm", "--force", ...ids);
    observations["leftoverContainersRemoved"] = ids.length;
    if (evidencePath)
      await writeFile(evidencePath, `${JSON.stringify({ runId, observations }, null, 2)}\n`);
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(hostRoot, { recursive: true, force: true });
  });

  it("declares capabilities only for the reachable runtime holding the pinned image", async () => {
    const capabilities = await backend().capabilities();
    observations["capabilities"] = capabilities;
    expect(capabilities.guarantees).not.toContain("task-egress-policy.v1");
    expect(capabilities.guarantees).toContain("protected-init-wall-clock-deadline.v1");
    const unreachable = backend("unix:///nonexistent-himawari.sock");
    await expect(unreachable.capabilities()).rejects.toMatchObject({
      code: "CONTAINER_RUNTIME_UNAVAILABLE",
    });
  });

  it("runs tasks without privileges, network or host sockets, inside enforced limits", async () => {
    const subject = backend();
    const target = environment();
    const locator = await subject.create(target.create);
    const probe = await run(
      subject,
      target,
      locator,
      [
        'echo "uid=$(id -u)"',
        "echo \"cap_eff=$(awk '/^CapEff/{print $2}' /proc/self/status)\"",
        "echo \"no_new_privs=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)\"",
        "echo \"seccomp=$(awk '/^Seccomp:/{print $2}' /proc/self/status)\"",
        'echo "root_write=$(touch /etc/himawari 2>/dev/null && echo allowed || echo denied)"',
        'echo "docker_socket=$(ls /var/run/docker.sock /run/docker.sock 2>/dev/null | wc -l)"',
        "echo \"interfaces=$(awk 'NR>2{sub(\":\",\"\",$1); print $1}' /proc/net/dev | sort | tr '\\n' ',')\"",
        'echo "egress=$(wget -q -T 3 -O /dev/null http://1.1.1.1 2>/dev/null && echo open || echo blocked)"',
        'echo "home=$HOME"',
      ].join("; "),
    );
    const facts = lines(probe.stdout);
    observations["privileges"] = facts;
    expect(facts).toMatchObject({
      uid: "65534",
      cap_eff: "0000000000000000",
      no_new_privs: "1",
      seccomp: "2",
      root_write: "denied",
      docker_socket: "0",
      interfaces: "lo,",
      egress: "blocked",
      home: "/tmp",
    });

    const storage = await run(
      subject,
      target,
      locator,
      'dd if=/dev/zero of=/tmp/fill bs=1048576 count=64 2>/dev/null; echo "bytes=$(wc -c < /tmp/fill)"; rm -f /tmp/fill',
    );
    const written = Number(lines(storage.stdout)["bytes"]);
    observations["privateStorageBytesWritten"] = written;
    expect(written).toBeLessThanOrEqual(RESOURCES.privateStorageBytes);

    const processes = await run(
      subject,
      target,
      locator,
      'i=0; while [ $i -lt 200 ]; do sleep 3 & i=$((i+1)); done; echo "attempted=$i"',
    );
    const top = await direct("container", "top", locator.runtimeEnvironmentId);
    const running = top.stdout.trim().split("\n").length - 1;
    observations["processLimit"] = {
      exitCode: processes.exitCode,
      stderr: processes.stderr.trim(),
      processesSeenByHost: running,
    };
    expect(processes.stderr).toContain("can't fork");
    expect(running).toBeLessThanOrEqual(RESOURCES.maxProcesses);
    const drained = Date.now();
    while (Date.now() - drained < 15_000) {
      const current = await direct("container", "top", locator.runtimeEnvironmentId);
      if (current.stdout.trim().split("\n").length <= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const memory = await run(
      subject,
      target,
      locator,
      "awk 'BEGIN { s = \"x\"; while (1) s = s s }'",
    );
    observations["memoryExhaustionExitCode"] = memory.exitCode;
    expect(memory.exitCode).toBe(137);

    const attacks = await run(
      subject,
      target,
      locator,
      [
        'kill -KILL 1 2>/dev/null; echo "kill_kill=$?"',
        'kill -TERM 1 2>/dev/null; echo "kill_term=$?"',
        'echo "read_init_memory=$(head -c 1 /proc/1/mem >/dev/null 2>&1 && echo allowed || echo denied)"',
        'echo "replace_init=$(echo x 2>/dev/null > /bin/sh && echo allowed || echo denied)"',
        'before=$(date +%s); echo "set_clock_error=$(date -s 2000-01-01 2>&1 >/dev/null)"; [ "$(date +%s)" -ge "$before" ] && echo "clock_moved_back=no" || echo "clock_moved_back=yes"',
        'echo "init_user=$(stat -c %u /proc/1)"',
      ].join("; "),
    );
    const attackFacts = lines(attacks.stdout);
    observations["initAttacks"] = attackFacts;
    expect(attackFacts).toMatchObject({
      kill_kill: "1",
      kill_term: "1",
      read_init_memory: "denied",
      replace_init: "denied",
      set_clock_error: "date: can't set date: Operation not permitted",
      clock_moved_back: "no",
      init_user: "65532",
    });
    expect((await subject.inspect({ ...target, locator })).state).toBe("running");

    const inspected = JSON.parse(
      (
        await direct(
          "container",
          "inspect",
          "--format",
          "{{json .HostConfig}}",
          locator.runtimeEnvironmentId,
        )
      ).stdout,
    );
    observations["hostConfig"] = inspected;
    expect(inspected).toMatchObject({
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: "none",
      RestartPolicy: { Name: "no" },
    });
    await stopAndProve(subject, target, locator);
  });

  it("stops detached, double-forked and daemonized programs with the whole environment", async () => {
    const subject = backend();
    const target = environment();
    const locator = await subject.create(target.create);
    await run(
      subject,
      target,
      locator,
      [
        "setsid sh -c 'while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &",
        "sh -c '(sh -c \"while :; do sleep 1; done\" </dev/null >/dev/null 2>&1 &) &'",
        "nohup sh -c 'exec sleep 3600' </dev/null >/dev/null 2>&1 &",
      ].join(" "),
    );
    const before = await direct(
      "container",
      "top",
      locator.runtimeEnvironmentId,
      "-o",
      "pid,user,args",
    );
    const survivors = before.stdout.split("\n").filter((line) => line.includes("sleep"));
    observations["detachedBeforeStop"] = before.stdout.trim().split("\n");
    expect(survivors.length).toBeGreaterThanOrEqual(3);

    const proof = await stopAndProve(subject, target, locator);
    observations["detachedStopProof"] = proof;
    expect(proof.basis).toBe("verified_stopped");
    const after = await direct("container", "top", locator.runtimeEnvironmentId);
    observations["topAfterStop"] = after.stderr.trim();
    expect(after.exitCode).not.toBe(0);
    await expect(run(subject, target, locator, "true")).rejects.toMatchObject({
      code: "CONTAINER_EXECUTION_CLOSED",
    });

    await subject.destroy({ ...target, locator });
    const gone = await direct("container", "inspect", locator.runtimeEnvironmentId);
    expect(gone.exitCode).not.toBe(0);
    const again = executionEnvironmentStopProofSchema.parse(
      await subject.verifyStopped({ ...target, locator, stopIntentId: "stop-1", stopFence: 1 }),
    );
    expect(again.basis).toBe("verified_stopped");
    expect(JSON.parse(await subject.readEvidence(again.evidence[0]?.ref ?? ""))).toMatchObject({
      destroyed: true,
    });
  });

  it("ends the whole environment at the wall-clock deadline without a controller and never restarts it", async () => {
    const subject = backend();
    const target = environment(8);
    const started = Date.now();
    const locator = await subject.create(target.create);
    await run(
      subject,
      target,
      locator,
      "setsid sh -c 'while :; do sleep 1; done' </dev/null >/dev/null 2>&1 &",
    );
    let state = "running";
    while (state === "running" && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = (await subject.inspect({ ...target, locator })).state;
    }
    const elapsedMs = Date.now() - started;
    observations["deadline"] = { deadlineSeconds: 8, elapsedMs, state };
    expect(state).toBe("stopped");
    expect(elapsedMs).toBeGreaterThanOrEqual(7_000);
    expect(elapsedMs).toBeLessThan(15_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const restarted = JSON.parse(
      (await direct("container", "inspect", "--format", "{{json .}}", locator.runtimeEnvironmentId))
        .stdout,
    );
    observations["afterDeadline"] = {
      State: restarted.State,
      RestartCount: restarted.RestartCount,
    };
    expect(restarted.State.Running).toBe(false);
    expect(restarted.RestartCount).toBe(0);
    await expect(run(subject, target, locator, "true")).rejects.toMatchObject({
      code: "CONTAINER_NOT_RUNNING",
    });
    expect((await stopAndProve(subject, target, locator)).basis).toBe("verified_stopped");
  });

  it("does not report paused, restarted, removed or foreign-runtime containers as stopped", async () => {
    const subject = backend();
    const paused = environment();
    const pausedLocator = await subject.create(paused.create);
    await direct("container", "pause", pausedLocator.runtimeEnvironmentId);
    const pausedState = (await subject.inspect({ ...paused, locator: pausedLocator })).state;
    const foreign = (
      await subject.inspect({
        ...paused,
        locator: { ...pausedLocator, runtimeInstanceId: "another-runtime" },
      })
    ).state;
    await direct("container", "unpause", pausedLocator.runtimeEnvironmentId);
    observations["paused"] = pausedState;
    observations["foreignRuntime"] = foreign;
    expect(pausedState).toBe("running");
    expect(foreign).toBe("unknown");

    await stopAndProve(subject, paused, pausedLocator);
    await direct("container", "start", pausedLocator.runtimeEnvironmentId);
    const restartedState = (await subject.inspect({ ...paused, locator: pausedLocator })).state;
    await direct("container", "stop", "--time", "1", pausedLocator.runtimeEnvironmentId);
    observations["restartedAfterProof"] = restartedState;
    expect(restartedState).toBe("unknown");
    await expect(
      subject.verifyStopped({
        ...paused,
        locator: pausedLocator,
        stopIntentId: "stop-1",
        stopFence: 1,
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_RESTARTED" });

    const removed = environment();
    const removedLocator = await subject.create(removed.create);
    await direct("container", "rm", "--force", removedLocator.runtimeEnvironmentId);
    const removedState = (await subject.inspect({ ...removed, locator: removedLocator })).state;
    observations["removedOutsideBackend"] = removedState;
    expect(removedState).toBe("not_found");
    await subject.stop({
      ...removed,
      locator: removedLocator,
      stopIntentId: "stop-1",
      stopFence: 1,
    });
    await expect(
      subject.verifyStopped({
        ...removed,
        locator: removedLocator,
        stopIntentId: "stop-1",
        stopFence: 1,
      }),
    ).rejects.toMatchObject({ code: "CONTAINER_STOP_UNVERIFIED" });
  });

  it("mounts only approved directories, masks existing protected entries and writes back to the host", async () => {
    const parent = await mkdtemp(path.join(hostRoot, "mount-"));
    await tree(path.join(parent, "sibling-repo"), { "secret.txt": "SIBLING" });
    const repo = await tree(path.join(parent, "repo"), {
      "tracked.txt": "v1\n",
      "src/app.txt": "APP",
    });
    git(repo, "init", "-q");
    git(repo, "add", "tracked.txt", "src/app.txt");
    git(repo, "commit", "-q", "-m", "init");
    await writeFile(path.join(repo, "tracked.txt"), "user-edit\n");
    await symlink(path.join(parent, "sibling-repo", "secret.txt"), path.join(repo, "abs-link"));
    await symlink("../sibling-repo/secret.txt", path.join(repo, "rel-link"));
    const docs = await tree(path.join(parent, "docs"), { "readme.md": "DOCS" });
    const protectedFiles = {
      ".env": "SECRET-ENV",
      ".env.production": "SECRET-PROD",
      ".ssh/id_ed25519": "SECRET-SSH",
      "config/tls.key": "SECRET-KEY",
      ".docker/config.json": "SECRET-DOCKER",
      ".himawari-trash/deleted.txt": "SECRET-TRASH",
    };
    await tree(repo, protectedFiles);
    await mkdir(path.join(repo, "run"));
    execFileSync("mkfifo", [path.join(repo, "run", "pipe")]);
    const socketPath = path.join(repo, "run", "app.sock");
    const server: Server | null =
      Buffer.byteLength(socketPath) < 100 ? await listening(socketPath) : null;
    await approve("repo", repo);
    await approve("docs", docs);
    const owner = await lstat(repo);
    const insensitive = await caseInsensitive(parent);
    const subject = backend();
    const target = environment(600, [grant("repo", "write"), grant("docs", "read")]);
    const report: Record<string, unknown> = {
      caseInsensitiveHost: insensitive,
      socketMasked: server !== null,
    };
    observations["originalDirectory"] = report;
    try {
      if (insensitive) {
        const before = (await containersOfRun()).length;
        await expect(subject.create(target.create)).rejects.toMatchObject({
          code: "CONTAINER_PROTECTED_FILE_UNMASKABLE",
        });
        expect((await containersOfRun()).length).toBe(before);
        const empty = path.join(parent, "empty");
        await writeFile(empty, "");
        const probe = await direct(
          "container",
          "run",
          "--rm",
          "--network",
          "none",
          "--user",
          `${owner.uid}:${owner.gid}`,
          "--label",
          `io.himawari.environment.run=${runId}`,
          "--mount",
          `type=bind,source=${repo},target=/w,readonly`,
          "--mount",
          `type=bind,source=${empty},target=/w/.env,readonly`,
          `${IMAGE_REFERENCE}@sha256:${IMAGE_DIGEST}`,
          "sh",
          "-c",
          'echo "masked=[$(cat /w/.env)]"; echo "alias=[$(cat /w/.ENV 2>/dev/null)]"',
        );
        report["caseAliasProbe"] = lines(probe.stdout);
        expect(lines(probe.stdout)).toMatchObject({ masked: "[]", alias: "[SECRET-ENV]" });
        for (const entry of [
          ".env",
          ".env.production",
          ".ssh",
          "config",
          ".docker",
          ".himawari-trash",
          "run",
        ])
          await rm(path.join(repo, entry), { recursive: true, force: true });
      }
      const locator = await subject.create(target.create);
      const masked = insensitive
        ? []
        : [
            'echo "env=[$(cat /workspaces/repo/.env)]"',
            'echo "env_production=[$(cat /workspaces/repo/.env.production)]"',
            'echo "ssh=$(ls -A /workspaces/repo/.ssh | wc -l | tr -d " ")"',
            'echo "tls=[$(cat /workspaces/repo/config/tls.key)]"',
            'echo "docker_config=[$(cat /workspaces/repo/.docker/config.json)]"',
            'echo "trash=$(ls -A /workspaces/repo/.himawari-trash | wc -l | tr -d " ")"',
            'echo "pipe=$(test -p /workspaces/repo/run/pipe && echo fifo || echo masked)"',
            'echo "socket=$(test -S /workspaces/repo/run/app.sock && echo socket || echo masked)"',
            'echo "remove_env=$(rm -f /workspaces/repo/.env 2>/dev/null && echo removed || echo refused)"',
            'echo "upper_env=[$(cat /workspaces/repo/.ENV 2>/dev/null)]"',
          ];
      const facts = lines(
        (
          await run(
            subject,
            target,
            locator,
            [
              'echo "uid=$(id -u)"',
              'echo "workspaces=$(ls /workspaces | tr "\\n" ",")"',
              'echo "parent=$(ls /workspaces/repo/.. | tr "\\n" ",")"',
              'echo "app=$(cat /workspaces/repo/src/app.txt)"',
              'echo "tracked=$(cat /workspaces/repo/tracked.txt)"',
              'echo "abs_link=$(cat /workspaces/repo/abs-link 2>/dev/null || echo unreadable)"',
              'echo "rel_link=$(cat /workspaces/repo/rel-link 2>/dev/null || echo unreadable)"',
              'echo "git_dir=$(test -d /workspaces/repo/.git && echo visible || echo hidden)"',
              'echo "write=$(echo from-task 2>/dev/null > /workspaces/repo/src/new.txt && echo ok || echo denied)"',
              'echo "docs=$(cat /workspaces/docs/readme.md)"',
              'echo "docs_write=$(echo x 2>/dev/null > /workspaces/docs/new.txt && echo allowed || echo denied)"',
              ...masked,
            ].join("; "),
          )
        ).stdout,
      );
      report["facts"] = facts;
      expect(facts).toMatchObject({
        uid: String(owner.uid),
        workspaces: "docs,repo,",
        parent: "docs,repo,",
        app: "APP",
        tracked: "user-edit",
        abs_link: "unreadable",
        rel_link: "unreadable",
        git_dir: "visible",
        write: "ok",
        docs: "DOCS",
        docs_write: "denied",
      });
      if (!insensitive)
        expect(facts).toMatchObject({
          env: "[]",
          env_production: "[]",
          ssh: "0",
          tls: "[]",
          docker_config: "[]",
          trash: "0",
          pipe: "masked",
          socket: server ? "masked" : "socket",
          remove_env: "refused",
          upper_env: "[]",
        });
      await stopAndProve(subject, target, locator);
      await subject.destroy({ ...target, locator });
      const written = path.join(repo, "src", "new.txt");
      const hostAfter = {
        newFile: await readFile(written, "utf8"),
        newFileOwner: (await lstat(written)).uid,
        tracked: await readFile(path.join(repo, "tracked.txt"), "utf8"),
        gitStatus: git(repo, "status", "--porcelain", "--untracked-files=all")
          .split("\n")
          .filter((line) => line.includes("tracked.txt") || line.includes("src/")),
        env: insensitive ? null : await readFile(path.join(repo, ".env"), "utf8"),
        docsNewFile: await lstat(path.join(docs, "new.txt")).then(
          () => true,
          () => false,
        ),
      };
      report["hostAfter"] = hostAfter;
      expect(hostAfter).toMatchObject({
        newFile: "from-task\n",
        newFileOwner: owner.uid,
        tracked: "user-edit\n",
        gitStatus: [" M tracked.txt", "?? src/new.txt"],
        env: insensitive ? null : "SECRET-ENV",
        docsNewFile: false,
      });
    } finally {
      server?.close();
    }
  });

  it("refuses directories whose protected files or Git metadata could escape, and disks it cannot watch", async () => {
    const parent = await mkdtemp(path.join(hostRoot, "refuse-"));
    const hard = await tree(path.join(parent, "hard"), { "notes.txt": "SECRET" });
    await link(path.join(hard, "notes.txt"), path.join(hard, ".env"));
    const main = await tree(path.join(parent, "main"), { "a.txt": "a" });
    git(main, "init", "-q");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "init");
    git(main, "worktree", "add", "-q", path.join(parent, "worktree"));
    const writable = await tree(path.join(parent, "writable"), { "a.txt": "a" });
    await approve("hard", hard);
    await approve("worktree", path.join(parent, "worktree"));
    await approve("writable", writable);
    const before = (await containersOfRun()).length;
    const attempt = (subject: ReturnType<typeof backend>, grants: ReturnType<typeof grant>[]) =>
      subject.create(environment(600, grants).create).then(
        () => "created",
        (error: { code?: string }) => error.code ?? String(error),
      );
    const freeBytes = await hostFreeBytes(writable);
    const results = {
      hardLinkedEnv: await attempt(backend(), [grant("hard", "write")]),
      externalWorktree: await attempt(backend(), [grant("worktree", "write")]),
      belowFloor: await attempt(
        backend(dockerHost, {
          diskGuard: { ...DISK_GUARD, minFreeBytes: freeBytes + 2 ** 40, freeBytes: hostFreeBytes },
        }),
        [grant("writable", "write")],
      ),
      unobservable: await attempt(
        backend(dockerHost, {
          diskGuard: {
            ...DISK_GUARD,
            freeBytes: async () => {
              throw new Error("statfs unavailable");
            },
          },
        }),
        [grant("writable", "write")],
      ),
    };
    observations["refusals"] = { ...results, freeBytes };
    expect(results).toEqual({
      hardLinkedEnv: "CONTAINER_PROTECTED_FILE_UNMASKABLE",
      externalWorktree: "CONTAINER_GIT_METADATA_OUTSIDE",
      belowFloor: "CONTAINER_DISK_FLOOR",
      unobservable: "CONTAINER_DISK_GUARD_UNAVAILABLE",
    });
    expect((await containersOfRun()).length).toBe(before);
  });

  it(
    "kills the whole environment once the host sees writes grow past the threshold",
    { timeout: 180_000 },
    async () => {
      const fill = await mkdtemp(path.join(hostRoot, "fill-"));
      await approve("fill", fill);
      const subject = backend();
      const target = environment(600, [grant("fill", "write")]);
      const baselineFreeBytes = await hostFreeBytes(fill);
      const locator = await subject.create(target.create);
      const ref = `arguments-${randomUUID()}`;
      argumentsByRef.set(ref, {
        argv: [
          "sh",
          "-c",
          "dd if=/dev/zero of=/workspaces/fill/big bs=1048576 count=4096 2>&1; echo dd_exit=$?",
        ],
      });
      const started = Date.now();
      const outcome = await subject
        .execute({
          identity: target.identity,
          createIntentId: target.createIntentId,
          locator,
          stopFence: 0,
          invocationId: `invocation-${randomUUID()}`,
          argumentsRef: ref,
          deadlineAt: new Date(Date.now() + 150_000).toISOString(),
        })
        .then(
          async ({ outputRef }) => subject.readOutput(outputRef),
          (error: { code?: string }) => ({ code: error.code ?? String(error) }),
        );
      const elapsedMs = Date.now() - started;
      const breach = await subject.diskGuardBreach({ ...target, locator });
      const writtenBytes = (await stat(path.join(fill, "big"))).size;
      const state = (await subject.inspect({ ...target, locator })).state;
      observations["diskGuard"] = {
        settings: DISK_GUARD,
        baselineFreeBytes,
        breach,
        writtenBytes,
        overshootBytes: writtenBytes - DISK_GUARD.maxGrowthBytes,
        elapsedMs,
        outcome,
        state,
      };
      expect(breach).toMatchObject({ reason: "growth" });
      expect(state).toBe("stopped");
      expect(writtenBytes).toBeLessThan(4096 * 1024 * 1024);
      await expect(run(subject, target, locator, "true")).rejects.toMatchObject({
        code: "CONTAINER_DISK_GUARD_TRIPPED",
      });
      expect((await stopAndProve(subject, target, locator)).basis).toBe("verified_stopped");
      await rm(path.join(fill, "big"));
    },
  );

  it("refuses a directory owned by root", async () => {
    const parent = await mkdtemp(path.join(hostRoot, "owner-"));
    const image = `${IMAGE_REFERENCE}@sha256:${IMAGE_DIGEST}`;
    const asRoot = (...command: string[]) =>
      direct(
        "container",
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--label",
        `io.himawari.environment.run=${runId}`,
        "--mount",
        `type=bind,source=${parent},target=/p`,
        image,
        ...command,
      );
    expect((await asRoot("mkdir", "/p/root-owned")).exitCode).toBe(0);
    try {
      const owned = path.join(parent, "root-owned");
      const hostUid = (await lstat(owned)).uid;
      await approve("root-owned", owned);
      const subject = backend();
      const target = environment(600, [grant("root-owned", "read")]);
      const result = await subject.create(target.create).then(
        async (locator) => {
          await stopAndProve(subject, target, locator);
          return "created";
        },
        (error: { code?: string }) => error.code ?? String(error),
      );
      observations["rootOwned"] = { hostUid, result };
      expect(result).toBe(hostUid === 0 ? "CONTAINER_DIRECTORY_OWNER_UNSUPPORTED" : "created");
    } finally {
      await asRoot("rm", "-rf", "/p/root-owned");
    }
  });
});
