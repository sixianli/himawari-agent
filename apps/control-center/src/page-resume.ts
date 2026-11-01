const LONG_ABSENCE_MILLISECONDS = 15_000;

let hiddenAt: number | undefined;

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else
      setTimeout(() => {
        hiddenAt = undefined;
      }, 0);
  });
}

export function resumedAfterLongAbsence(now = Date.now()): boolean {
  return hiddenAt !== undefined && now - hiddenAt >= LONG_ABSENCE_MILLISECONDS;
}
