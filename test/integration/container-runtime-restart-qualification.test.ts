import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerQualification, direct, stopAndProve } from "./container-qualification-support.ts";

const enabled = process.env["HIMAWARI_CONTAINER_RESTART_QUALIFICATION"] === "1";
const restartDescribe = enabled ? describe : describe.skip;
const qualification = new ContainerQualification();

interface ContainerState {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly status: string;
  readonly startedAt: string;
  readonly restartCount: number;
  readonly restartPolicy: string;
}

async function containersOfRun(): Promise<ContainerState[]> {
  const ids = (
    await direct(
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=io.himawari.environment.run=${qualification.runId}`,
    )
  ).stdout
    .split("\n")
    .filter(Boolean);
  const states: ContainerState[] = [];
  for (const id of ids) {
    const container = JSON.parse(
      (await direct("container", "inspect", "--format", "{{json .}}", id)).stdout,
    );
    states.push({
      id: container.Id,
      name: container.Name,
      running: container.State.Running,
      status: container.State.Status,
      startedAt: container.State.StartedAt,
      restartCount: container.RestartCount,
      restartPolicy: container.HostConfig.RestartPolicy.Name,
    });
  }
  return states.sort((a, b) => a.name.localeCompare(b.name));
}

async function waitForRuntime(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await direct("system", "info", "--format", "{{.ID}}").catch(() => null);
    if (info?.exitCode === 0 && info.stdout.trim()) return info.stdout.trim();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("runtime did not come back");
}

restartDescribe("container environments across a runtime restart", () => {
  beforeAll(async () => {
    await qualification.setup();
  });
  afterAll(async () => {
    if (enabled) await qualification.cleanup();
  });

  it(
    "keeps running and already proven environments stopped and provable after the runtime restarts",
    { timeout: 30 * 60_000 },
    async () => {
      const restartCommand = JSON.parse(
        process.env["HIMAWARI_CONTAINER_RESTART_COMMAND"] ?? "null",
      ) as string[] | null;
      expect(Array.isArray(restartCommand) && restartCommand.length > 0).toBe(true);
      const [executable, ...args] = restartCommand ?? [];

      const subject = qualification.backend();
      const running = qualification.environment(3600, [], ["example.com:443"]);
      const runningLocator = await subject.create(running.create);
      const background = await qualification.run(
        subject,
        running,
        runningLocator,
        "nohup sh -c 'while true; do sleep 1; done' >/dev/null 2>&1 & echo started=yes",
      );
      expect(background.stdout.trim()).toBe("started=yes");
      const proven = qualification.environment(3600);
      const provenLocator = await subject.create(proven.create);
      const provenBefore = await stopAndProve(subject, proven, provenLocator);
      expect(provenBefore.basis).toBe("verified_stopped");
      const runtimeBefore = (await subject.capabilities()).runtimeInstanceId;
      const before = await containersOfRun();
      expect(before).toHaveLength(3);
      expect(before.filter((item) => item.running)).toHaveLength(2);
      expect(before.every((item) => item.restartPolicy === "no")).toBe(true);

      const restartStarted = Date.now();
      execFileSync(executable ?? "", args, {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 25 * 60_000,
      });
      const runtimeAfter = await waitForRuntime(5 * 60_000);
      const restartSeconds = Math.round((Date.now() - restartStarted) / 1000);
      const after = await containersOfRun();

      expect(runtimeAfter).toBe(runtimeBefore);
      expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
      for (const [index, container] of after.entries()) {
        expect(container.running).toBe(false);
        expect(container.restartCount).toBe(0);
        expect(container.startedAt).toBe(before[index]?.startedAt);
      }
      const runningTarget = { ...running, locator: runningLocator };
      expect((await subject.inspect(runningTarget)).state).toBe("stopped");
      await expect(
        qualification.run(subject, running, runningLocator, "echo late"),
      ).rejects.toMatchObject({ code: "CONTAINER_NOT_RUNNING" });
      const runningProof = await stopAndProve(subject, running, runningLocator);
      expect(runningProof.basis).toBe("verified_stopped");
      const provenAfter = await stopAndProve(subject, proven, provenLocator);
      expect(provenAfter.basis).toBe("verified_stopped");
      const settled = await containersOfRun();
      expect(settled.every((item) => !item.running && item.restartCount === 0)).toBe(true);

      qualification.observations["runtimeRestart"] = {
        restartCommand,
        restartSeconds,
        runtimeInstanceUnchanged: runtimeAfter === runtimeBefore,
        before,
        after,
        runningEnvironmentState: "stopped",
        lateExecute: "CONTAINER_NOT_RUNNING",
        runningProof: { basis: runningProof.basis, evidence: runningProof.evidence },
        provenBefore: { basis: provenBefore.basis, evidence: provenBefore.evidence },
        provenAfter: { basis: provenAfter.basis, evidence: provenAfter.evidence },
      };
    },
  );
});
