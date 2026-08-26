export const STARTUP_PHASES = Object.freeze([
  "configuration",
  "secret-references",
  "deployment-lock",
  "authority",
  "sqlite-migrations",
  "payload-keyring",
  "repositories-recovery",
  "models-memory",
  "worker",
  "scheduler-recovery",
  "http-readiness",
] as const);

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export const DRAIN_PHASES = Object.freeze([
  "revoke-readiness-admission",
  "stop-scheduler-publisher",
  "settle-inflight-runs",
  "close-memory-sqlite-socket",
  "release-authority-lock",
] as const);

export type DrainPhase = (typeof DRAIN_PHASES)[number];

export interface LifecycleStep {
  start(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DrainStep {
  run(): Promise<void>;
}

export type StartupStepMap = Readonly<Record<StartupPhase, LifecycleStep>>;
export type DrainStepMap = Readonly<Record<DrainPhase, DrainStep>>;

export type ServiceLifecycleState = "stopped" | "starting" | "ready" | "draining" | "failed";

export class ServiceLifecycleError extends Error {
  readonly code: string;
  readonly phase: StartupPhase | DrainPhase;
  readonly rollbackFailures: readonly string[];

  constructor(
    code: string,
    phase: StartupPhase | DrainPhase,
    rollbackFailures: readonly string[] = [],
  ) {
    super("Service lifecycle transition failed");
    this.name = "ServiceLifecycleError";
    this.code = code;
    this.phase = phase;
    this.rollbackFailures = Object.freeze([...rollbackFailures]);
  }
}

function code(prefix: "STARTUP" | "DRAIN" | "ROLLBACK", phase: string): string {
  return `${prefix}_${phase.toUpperCase().replaceAll("-", "_")}_FAILED`;
}

export class StartupDrainCoordinator {
  readonly #startup: StartupStepMap;
  readonly #drain: DrainStepMap;
  readonly #completed: StartupPhase[] = [];
  #state: ServiceLifecycleState = "stopped";

  constructor(options: { readonly startup: StartupStepMap; readonly drain: DrainStepMap }) {
    this.#startup = options.startup;
    this.#drain = options.drain;
  }

  get state(): ServiceLifecycleState {
    return this.#state;
  }

  get ready(): boolean {
    return this.#state === "ready";
  }

  async start(): Promise<void> {
    if (this.#state !== "stopped" && this.#state !== "failed") {
      throw new ServiceLifecycleError("STARTUP_STATE_CONFLICT", "configuration");
    }
    this.#state = "starting";
    this.#completed.length = 0;
    for (const phase of STARTUP_PHASES) {
      try {
        await this.#startup[phase].start();
        this.#completed.push(phase);
      } catch {
        const rollbackFailures: string[] = [];
        for (const completed of [...this.#completed].reverse()) {
          try {
            await this.#startup[completed].rollback();
          } catch {
            rollbackFailures.push(code("ROLLBACK", completed));
          }
        }
        this.#completed.length = 0;
        this.#state = "failed";
        throw new ServiceLifecycleError(code("STARTUP", phase), phase, rollbackFailures);
      }
    }
    this.#state = "ready";
  }

  async drain(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "draining";
    const failures: string[] = [];
    let firstFailed: DrainPhase | undefined;
    for (const phase of DRAIN_PHASES) {
      try {
        await this.#drain[phase].run();
      } catch {
        firstFailed ??= phase;
        failures.push(code("DRAIN", phase));
      }
    }
    this.#completed.length = 0;
    if (firstFailed) {
      this.#state = "failed";
      throw new ServiceLifecycleError(code("DRAIN", firstFailed), firstFailed, failures.slice(1));
    }
    this.#state = "stopped";
  }
}
