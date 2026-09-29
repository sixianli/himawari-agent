export interface TestWorkerLimits {
  readonly maximum: number;
  readonly cpusPerWorker: number;
  readonly memoryMiBPerWorker: number;
}

export const integrationWorkerLimits: Readonly<TestWorkerLimits>;

export function testWorkerCount(
  project: {
    readonly fileParallelism?: boolean;
    readonly workerLimits?: TestWorkerLimits;
  },
  resources?: { readonly availableCpus?: number; readonly memoryBytes?: number },
): number;
