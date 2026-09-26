type SignalGroup = (pid: number, signal: NodeJS.Signals | 0) => void;

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

export async function stopProcessGroup(
  groupId: number,
  options: { readonly timeoutMs: number; readonly intervalMs: number; readonly kill: SignalGroup },
): Promise<boolean> {
  if (!Number.isSafeInteger(groupId) || groupId <= 1) return false;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    for (const signal of [0, "SIGKILL"] as const) {
      try {
        options.kill(-groupId, signal);
      } catch (error) {
        return errorCode(error) === "ESRCH";
      }
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
