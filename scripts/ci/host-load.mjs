import os from "node:os";

export function startHostLoad({
  intervalMs = 15000,
  loadAverage = () => os.loadavg()[0],
  freeMemory = () => os.freemem(),
  totalMemory = () => os.totalmem(),
  cpuCount = () => os.availableParallelism(),
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const loads = [];
  let peakUsedBytes = 0;
  const sample = () => {
    loads.push(loadAverage());
    peakUsedBytes = Math.max(peakUsedBytes, totalMemory() - freeMemory());
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    sample();
    const cpus = cpuCount();
    const mean = loads.reduce((sum, value) => sum + value, 0) / loads.length;
    const MiB = 1024 ** 2;
    return [
      "CI_HOST_LOAD",
      `cpus=${cpus}`,
      `loadAvg1Mean=${mean.toFixed(2)}`,
      `loadAvg1Peak=${Math.max(...loads).toFixed(2)}`,
      `loadPerCpuMean=${(mean / cpus).toFixed(2)}`,
      `memUsedPeakMiB=${Math.round(peakUsedBytes / MiB)}`,
      `memTotalMiB=${Math.round(totalMemory() / MiB)}`,
      `samples=${loads.length}`,
      `seconds=${Math.round((now() - startedAt) / 1000)}`,
    ].join(" ");
  };
}
