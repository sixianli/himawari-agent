import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  dockerCli,
} from "@himawari-agent/runtime-sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["HIMAWARI_CONTAINER_QUALIFICATION"] === "1";
const containerDescribe = enabled ? describe : describe.skip;
const dockerExecutable = process.env["HIMAWARI_CONTAINER_DOCKER_CLI"] ?? "docker";
const dockerHost = process.env["HIMAWARI_CONTAINER_DOCKER_HOST"] ?? "";
const evidencePath = process.env["HIMAWARI_CONTAINER_EVIDENCE_PATH"];
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

let stateDirectory: string;
let sequence = 0;
const argumentsByRef = new Map<string, { readonly argv: readonly string[] }>();

function backend(host = dockerHost) {
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
  });
  const port: ExecutionBackendPort = subject;
  return Object.assign(port, {
    readOutput: subject.readOutput.bind(subject),
    readEvidence: subject.readEvidence.bind(subject),
  });
}

function environment(deadlineSeconds = 600) {
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
        directories: [],
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
    stateDirectory = await mkdtemp(path.join(os.tmpdir(), "container-qualification-"));
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
});
