import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
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
import {
  ContainerQualification,
  DISK_GUARD,
  direct,
  dockerHost,
  EGRESS_IMAGE_DIGEST,
  EGRESS_IMAGE_REFERENCE,
  grant,
  IMAGE_DIGEST,
  IMAGE_REFERENCE,
  lines,
  RESOURCES,
  stopAndProve,
} from "./container-qualification-support.ts";

const enabled = process.env["HIMAWARI_CONTAINER_QUALIFICATION"] === "1";
const containerDescribe = enabled ? describe : describe.skip;
const qualification = new ContainerQualification();
const { runId, observations, argumentsByRef, approved } = qualification;
const backend = qualification.backend.bind(qualification);
const environment = qualification.environment.bind(qualification);
const run = qualification.run.bind(qualification);

let stateDirectory: string;
let hostRoot: string;

async function approve(canonicalRootId: string, directory: string) {
  const info = await lstat(directory);
  approved.set(canonicalRootId, {
    canonicalPath: directory,
    device: String(info.dev),
    inode: String(info.ino),
  });
  return directory;
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

containerDescribe("container execution backend on a real runtime", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await qualification.setup();
    stateDirectory = qualification.stateDirectory;
    hostRoot = qualification.hostRoot;
  });
  afterAll(async () => {
    if (enabled) await qualification.cleanup();
  });

  it("declares capabilities only for the reachable runtime holding the pinned image", async () => {
    const capabilities = await backend().capabilities();
    observations["capabilities"] = capabilities;
    expect(capabilities.guarantees).toContain("task-egress-policy.v1");
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

  it(
    "routes only approved public targets through the task egress and blocks every bypass",
    { timeout: 120_000 },
    async () => {
      const connectionsSeen: string[] = [];
      const listener = createServer((socket) => {
        connectionsSeen.push(String(socket.remoteAddress));
        socket.destroy();
      });
      await new Promise<void>((resolve) => listener.listen(0, "0.0.0.0", resolve));
      const hostPort = (listener.address() as { port: number }).port;
      const hostAddress =
        Object.values(os.networkInterfaces())
          .flat()
          .find((item) => item && item.family === "IPv4" && !item.internal)?.address ?? "";
      try {
        const subject = backend();
        const target = environment(600, [], ["example.com:80", "example.com:443", "localhost:80"]);
        const locator = await subject.create(target.create);
        const [network] = (
          await direct(
            "network",
            "ls",
            "--format",
            "{{.Name}}",
            "--filter",
            `label=io.himawari.environment.id=${target.identity.environmentId}`,
          )
        ).stdout
          .split("\n")
          .filter(Boolean);
        const networkInfo = JSON.parse(
          (await direct("network", "inspect", "--format", "{{json .}}", network ?? "")).stdout,
        );
        const subnet = String(networkInfo.IPAM?.Config?.[0]?.Subnet ?? "");
        const subnetPrefix = `${subnet.slice(0, subnet.lastIndexOf("."))}.`;
        const hostAddresses = (
          await direct(
            "container",
            "run",
            "--rm",
            "--network",
            "host",
            "--label",
            `io.himawari.environment.run=${runId}`,
            `${IMAGE_REFERENCE}@sha256:${IMAGE_DIGEST}`,
            "ip",
            "-4",
            "-o",
            "addr",
          )
        ).stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[3] ?? "")
          .filter(Boolean);
        const facts = lines(
          (
            await run(
              subject,
              target,
              locator,
              [
                'TOKEN=$(echo "$HTTPS_PROXY" | sed "s#^http://job:\\([a-f0-9]*\\)@.*#\\1#"); AUTH=$(printf "job:%s" "$TOKEN" | base64 | tr -d "\\n")',
                'connect() { printf "CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n%b\\r\\n" "$1" "$1" "$2" | nc -w 10 himawari-egress 3128 2>/dev/null | head -1 | tr -d "\\r"; }',
                'echo "proxy_variable=$(echo "$HTTP_PROXY" | sed "s/job:[a-f0-9]*@/job:TOKEN@/")"',
                'echo "allowed_http=$(wget -q -T 15 -O - http://example.com/ 2>/dev/null | grep -c "Example Domain")"',
                'echo "allowed_connect=$(connect example.com:443 "Proxy-Authorization: Basic $AUTH\\r\\n")"',
                'echo "unapproved_host=$(connect example.org:443 "Proxy-Authorization: Basic $AUTH\\r\\n")"',
                'echo "unapproved_port=$(connect example.com:8443 "Proxy-Authorization: Basic $AUTH\\r\\n")"',
                'echo "private_answer=$( (printf "GET http://localhost/ HTTP/1.1\\r\\nHost: localhost\\r\\nProxy-Authorization: Basic %s\\r\\nConnection: close\\r\\n\\r\\n" "$AUTH"; sleep 3) | nc -w 10 himawari-egress 3128 2>/dev/null | tr -d "\\r" | grep -E "^HTTP/|^X-Himawari-Egress-Error" | tr "\\n" "|")"',
                'echo "missing_auth=$(connect example.com:443 "")"',
                'echo "direct_ipv4=$(nc -w 3 1.1.1.1 80 </dev/null >/dev/null 2>&1 && echo open || echo blocked)"',
                'echo "direct_ipv6=$(nc -w 3 2606:4700:4700::1111 80 </dev/null >/dev/null 2>&1 && echo open || echo blocked)"',
                'echo "direct_udp=$( (echo x | nc -u -w 2 8.8.8.8 53) >/dev/null 2>&1 && echo sent || echo blocked)"',
                'echo "dns_external=$(nslookup -timeout=3 example.com 2>/dev/null | grep -c "^Address: [0-9]")"',
                'echo "dns_direct=$(nslookup -timeout=3 example.com 8.8.8.8 >/dev/null 2>&1 && echo open || echo blocked)"',
                'echo "metadata=$(nc -w 3 169.254.169.254 80 </dev/null >/dev/null 2>&1 && echo open || echo blocked)"',
                `echo "host_address=$(nc -w 3 ${hostAddress} ${hostPort} </dev/null >/dev/null 2>&1 && echo open || echo blocked)"`,
                `echo "host_docker_internal=$(nc -w 3 host.docker.internal ${hostPort} </dev/null >/dev/null 2>&1 && echo open || echo blocked)"`,
                `echo "orbstack_host=$(nc -w 3 0.250.250.254 ${hostPort} </dev/null >/dev/null 2>&1 && echo open || echo blocked)"`,
              ].join("; "),
            )
          ).stdout,
        );
        const report: Record<string, unknown> = {
          network: {
            name: network,
            internal: networkInfo.Internal,
            options: networkInfo.Options,
            subnet,
          },
          runtimeHostAddresses: hostAddresses,
          hostAddressTested: hostAddress,
          hostPort,
          facts,
        };
        observations["egress"] = report;
        expect(hostAddresses.length).toBeGreaterThan(0);
        expect(hostAddresses.filter((address) => address.startsWith(subnetPrefix))).toEqual([]);
        expect(networkInfo).toMatchObject({
          Internal: true,
          EnableIPv6: false,
          Options: { "com.docker.network.bridge.inhibit_ipv4": "true" },
        });
        expect(facts).toMatchObject({
          proxy_variable: "http://job:TOKEN@himawari-egress:3128",
          allowed_http: "1",
          allowed_connect: "HTTP/1.1 200 Connection Established",
          unapproved_host: "HTTP/1.1 403 Forbidden",
          unapproved_port: "HTTP/1.1 403 Forbidden",
          private_answer: "HTTP/1.1 403 Forbidden|X-Himawari-Egress-Error: target-denied|",
          missing_auth: "HTTP/1.1 407 Proxy Authentication Required",
          direct_ipv4: "blocked",
          direct_ipv6: "blocked",
          direct_udp: "blocked",
          dns_external: "0",
          dns_direct: "blocked",
          metadata: "blocked",
          host_address: "blocked",
          host_docker_internal: "blocked",
          orbstack_host: "blocked",
        });
        report["hostListenerConnections"] = [...connectionsSeen];
        expect(connectionsSeen).toEqual([]);

        const proof = await stopAndProve(subject, target, locator);
        const evidence = JSON.parse(await subject.readEvidence(proof.evidence[0]?.ref ?? ""));
        report["proofEgress"] = { Name: evidence.egress?.Name, State: evidence.egress?.State };
        expect(evidence.egress?.State).toMatchObject({ Running: false });
        await subject.destroy({ ...target, locator });
        const remaining = await direct("network", "inspect", network ?? "");
        report["networkRemovedByDestroy"] = remaining.exitCode !== 0;
        expect(remaining.exitCode).not.toBe(0);
      } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    },
  );

  it("keeps each task's egress unreachable from other tasks", { timeout: 120_000 }, async () => {
    const subject = backend();
    const first = environment(600, [], ["example.com:80"]);
    const second = environment(600, [], ["example.com:80"]);
    const firstLocator = await subject.create(first.create);
    const secondLocator = await subject.create(second.create);
    const proxyOf = async (environmentId: string) => {
      const [id] = (
        await direct(
          "container",
          "ls",
          "--quiet",
          "--filter",
          `label=io.himawari.environment.id=${environmentId}`,
          "--filter",
          "label=io.himawari.environment.part=egress-proxy",
        )
      ).stdout
        .split("\n")
        .filter(Boolean);
      const networks = JSON.parse(
        (
          await direct(
            "container",
            "inspect",
            "--format",
            "{{json .NetworkSettings.Networks}}",
            id ?? "",
          )
        ).stdout,
      ) as Record<string, { IPAddress: string }>;
      return Object.entries(networks).find(([name]) => name.startsWith("himawari-net-"))?.[1]
        .IPAddress;
    };
    const secondProxy = await proxyOf(second.identity.environmentId);
    const firstProxy = await proxyOf(first.identity.environmentId);
    const facts = lines(
      (
        await run(
          subject,
          first,
          firstLocator,
          [
            `echo "own_proxy=$(nslookup himawari-egress 2>/dev/null | grep -c "Address: ${firstProxy}")"`,
            `echo "other_proxy=$(nc -w 3 ${secondProxy} 3128 </dev/null >/dev/null 2>&1 && echo open || echo blocked)"`,
          ].join("; "),
        )
      ).stdout,
    );
    observations["egressIsolation"] = { firstProxy, secondProxy, facts };
    expect(facts).toEqual({ own_proxy: "1", other_proxy: "blocked" });
    await stopAndProve(subject, first, firstLocator);
    await stopAndProve(subject, second, secondLocator);
  });

  it(
    "gives a temporary credential only to the first call of a fresh environment and makes every copy fail once revoked",
    { timeout: 120_000 },
    async () => {
      const registryRoot = await mkdtemp(path.join(hostRoot, "registry-"));
      await chmod(registryRoot, 0o755);
      await writeFile(
        path.join(registryRoot, "server.mjs"),
        [
          'import { createHash } from "node:crypto";',
          'import { readFileSync } from "node:fs";',
          'import { createServer } from "node:http";',
          "createServer((request, response) => {",
          '  const tokens = JSON.parse(readFileSync("/registry/tokens.json", "utf8"));',
          '  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");',
          "  const entry = tokens[token];",
          '  const ok = request.url === "/pkg" && entry !== undefined && Date.parse(entry.expiresAt) > Date.now();',
          '  console.log(`${ok ? 200 : 401} ${createHash("sha256").update(token).digest("hex").slice(0, 16)}`);',
          '  response.writeHead(ok ? 200 : 401).end(ok ? "package-ok\\n" : "denied\\n");',
          '}).listen(8080, "0.0.0.0");',
        ].join("\n"),
        { mode: 0o644 },
      );
      const tokens: Record<string, { credentialId: string; expiresAt: string }> = {};
      const revoked = new Set<string>();
      const issuedTokens = new Map<string, string>();
      const saveTokens = async () => {
        const file = path.join(registryRoot, "tokens.json");
        await writeFile(`${file}.tmp`, JSON.stringify(tokens), { mode: 0o644 });
        await rename(`${file}.tmp`, file);
      };
      await saveTokens();
      const credentialIssuer: NonNullable<ContainerExecutionBackendOptions["credentialIssuer"]> = {
        issue: async (request) => {
          if (revoked.has(request.credentialId)) throw new Error("revoked identifier");
          const token = issuedTokens.get(request.credentialId) ?? randomBytes(24).toString("hex");
          issuedTokens.set(request.credentialId, token);
          tokens[token] = { credentialId: request.credentialId, expiresAt: request.expiresAt };
          await saveTokens();
          return { environment: { REGISTRY_TOKEN: token }, expiresAt: request.expiresAt };
        },
        revoke: async (credentialId) => {
          revoked.add(credentialId);
          const token = issuedTokens.get(credentialId);
          if (token) delete tokens[token];
          await saveTokens();
        },
        isRevoked: async (credentialId) =>
          revoked.has(credentialId) &&
          !Object.values(tokens).some((entry) => entry.credentialId === credentialId),
      };
      const subject = backend(dockerHost, { credentialIssuer });
      const target = environment(600, [], ["example.com:443"]);
      const locator = await subject.create(target.create);
      const network = String(
        JSON.parse(
          (
            await direct(
              "container",
              "inspect",
              "--format",
              "{{json .}}",
              locator.runtimeEnvironmentId,
            )
          ).stdout,
        ).HostConfig.NetworkMode,
      );
      const registryName = `himawari-q-registry-${runId}`;
      const registry = await direct(
        "container",
        "run",
        "--detach",
        "--name",
        registryName,
        "--label",
        `io.himawari.environment.run=${runId}`,
        "--network",
        network,
        "--network-alias",
        "registry.test",
        "--user",
        "65533:65533",
        "--read-only",
        "--mount",
        `type=bind,source=${registryRoot},target=/registry,readonly`,
        `${EGRESS_IMAGE_REFERENCE}@sha256:${EGRESS_IMAGE_DIGEST}`,
        "node",
        "/registry/server.mjs",
      );
      expect(registry.exitCode, registry.stderr).toBe(0);
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt++) {
        const probe = await direct(
          "container",
          "exec",
          registryName,
          "node",
          "-e",
          "fetch('http://127.0.0.1:8080/pkg').then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))",
        );
        ready = probe.exitCode === 0;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);

      const request = (token: string) =>
        `wget -Y off -q -O - --header "Authorization: Bearer ${token}" http://registry.test:8080/pkg 2>/dev/null || echo refused`;
      const credentialCall = async (invocationId: string) => {
        argumentsByRef.set(invocationId, {
          argv: [
            "sh",
            "-c",
            [
              `echo "during=$(${request("$REGISTRY_TOKEN")})"`,
              'printf %s "$REGISTRY_TOKEN" > /tmp/copied-token',
              `(while [ ! -e /tmp/go ]; do sleep 0.2; done; echo "background=$(${request("$REGISTRY_TOKEN")})" > /tmp/background.txt) >/dev/null 2>&1 &`,
              'echo "argv_has_token=$(grep -c "$REGISTRY_TOKEN" /proc/$$/cmdline || true)"',
            ].join("\n"),
          ],
        });
        return subject.execute({
          identity: target.identity,
          createIntentId: target.createIntentId,
          locator,
          stopFence: 0,
          invocationId,
          argumentsRef: invocationId,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          credential: { secretRef: "secret-registry", approvalRef: "approval-q" },
        });
      };
      const first = await subject.readOutput(
        (await credentialCall("invocation-credential-1")).outputRef,
      );
      const [credentialId] = [...issuedTokens.keys()];
      const token = issuedTokens.get(credentialId ?? "") ?? "";
      const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
      expect(lines(first.stdout)).toEqual({ during: "package-ok", argv_has_token: "0" });
      expect(revoked.has(credentialId ?? "")).toBe(true);

      const after = await run(
        subject,
        target,
        locator,
        [
          'echo "inherited=${REGISTRY_TOKEN:-absent}"',
          `echo "copied=$(${request("$(cat /tmp/copied-token)")})"`,
          "touch /tmp/go",
          "for i in $(seq 1 50); do [ -s /tmp/background.txt ] && break; sleep 0.2; done",
          "cat /tmp/background.txt",
        ].join("\n"),
      );
      expect(lines(after.stdout)).toEqual({
        inherited: "absent",
        copied: "refused",
        background: "refused",
      });
      await expect(credentialCall("invocation-credential-2")).rejects.toMatchObject({
        code: "CONTAINER_CREDENTIAL_REFUSED",
      });
      expect(issuedTokens.size).toBe(1);

      const registryLog = (await direct("container", "logs", registryName)).stdout
        .trim()
        .split("\n")
        .filter((line) => line.endsWith(tokenHash));
      expect(registryLog).toEqual([`200 ${tokenHash}`, `401 ${tokenHash}`, `401 ${tokenHash}`]);
      const inspected = (
        await direct("container", "inspect", "--format", "{{json .}}", locator.runtimeEnvironmentId)
      ).stdout;
      expect(inspected).not.toContain(token);
      const stateFiles = (await readdir(stateDirectory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name));
      for (const file of stateFiles) expect(await readFile(file, "utf8")).not.toContain(token);

      const proof = await stopAndProve(subject, target, locator);
      const saved = JSON.parse(await subject.readEvidence(proof.evidence[0]?.ref ?? ""));
      expect(saved.credential).toMatchObject({ credentialId });
      await direct("container", "rm", "--force", registryName);
      observations["temporaryCredential"] = {
        firstCall: lines(first.stdout),
        afterRevocation: lines(after.stdout),
        registryLog,
        secondCredentialCall: "CONTAINER_CREDENTIAL_REFUSED",
        tokenAbsentFromInspectAndState: true,
        stateFilesChecked: stateFiles.length,
        proofCredential: saved.credential,
      };
    },
  );

  it(
    "ends the egress proxy with the environment at its deadline",
    { timeout: 60_000 },
    async () => {
      const subject = backend();
      const target = environment(10, [], ["example.com:80"]);
      const started = Date.now();
      const locator = await subject.create(target.create);
      let state = "running";
      while (state === "running" && Date.now() - started < 40_000) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        state = (await subject.inspect({ ...target, locator })).state;
      }
      const elapsedMs = Date.now() - started;
      observations["egressDeadline"] = { deadlineSeconds: 10, elapsedMs, state };
      expect(state).toBe("stopped");
      expect(elapsedMs).toBeLessThan(20_000);
      expect((await stopAndProve(subject, target, locator)).basis).toBe("verified_stopped");
    },
  );
});
