import type { ClockPort, IdGeneratorPort } from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";

export interface FailureScheduler {
  checkpoint(point: string): void;
}

export class ManualClock implements ClockPort {
  private current: string;

  constructor(initial = "2026-08-25T00:00:00.000Z") {
    this.current = initial;
  }

  now(): string {
    return this.current;
  }

  set(now: string): void {
    this.current = new Date(now).toISOString();
  }

  advance(milliseconds: number): void {
    this.current = new Date(new Date(this.current).valueOf() + milliseconds).toISOString();
  }
}

export class DeterministicIdGenerator implements IdGeneratorPort {
  private readonly counters = new Map<string, number>();

  next(namespace: string): string {
    const next = (this.counters.get(namespace) ?? 0) + 1;
    this.counters.set(namespace, next);
    return `${namespace}-${String(next).padStart(4, "0")}`;
  }
}

export class DeterministicFailureScheduler implements FailureScheduler {
  private readonly attempts = new Map<string, number>();
  private readonly scheduled = new Map<string, Set<number>>();

  failOn(point: string, ...attempts: readonly number[]): void {
    this.scheduled.set(point, new Set(attempts));
  }

  checkpoint(point: string): void {
    const attempt = (this.attempts.get(point) ?? 0) + 1;
    this.attempts.set(point, attempt);
    if (this.scheduled.get(point)?.has(attempt)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INJECTED_FAILURE,
        `Injected failure at ${point} attempt ${attempt}`,
        { point, attempt: String(attempt) },
      );
    }
  }

  attemptsAt(point: string): number {
    return this.attempts.get(point) ?? 0;
  }
}

export const NO_FAILURES: FailureScheduler = Object.freeze({
  checkpoint(): void {},
});
