export async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  void work.catch(() => undefined);
  if (performance.now() >= deadline) throw new Error("WORKER_DEADLINE_EXCEEDED");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("WORKER_DEADLINE_EXCEEDED")),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
