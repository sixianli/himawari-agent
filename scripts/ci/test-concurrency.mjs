import { availableParallelism, totalmem } from "node:os";

export const integrationWorkerLimits = Object.freeze({
  maximum: 4,
  cpusPerWorker: 2,
  memoryMiBPerWorker: 2048,
});

export function testWorkerCount(
  project,
  { availableCpus = availableParallelism(), memoryBytes = totalmem() } = {},
) {
  if (!project.fileParallelism || !project.workerLimits) return 1;
  const { maximum, cpusPerWorker, memoryMiBPerWorker } = project.workerLimits;
  if (
    ![maximum, cpusPerWorker, memoryMiBPerWorker, availableCpus, memoryBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("CI_TEST_WORKER_BUDGET_INVALID");
  return Math.max(
    1,
    Math.min(
      maximum,
      Math.floor(availableCpus / cpusPerWorker),
      Math.floor(memoryBytes / (memoryMiBPerWorker * 1024 ** 2)),
    ),
  );
}
