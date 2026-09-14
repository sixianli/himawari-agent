export interface ProductionServiceResource {
  readonly name: string;
  /** Stop accepting new work before any dependency is closed. */
  stopAccepting?(): void | Promise<void>;
  /** Settle or durably interrupt accepted work before closing dependencies. */
  drain?(): void | Promise<void>;
  close(): void | Promise<void>;
}

export class ProductionServiceLifecycle {
  readonly #resources: ProductionServiceResource[] = [];
  #shutdown: Promise<void> | undefined;
  #state: "starting" | "ready" | "stopping" | "stopped" = "starting";

  get state() {
    return this.#state;
  }

  register(resource: ProductionServiceResource): void {
    if (this.#state !== "starting") throw new Error("SERVICE_LIFECYCLE_REGISTRATION_CLOSED");
    if (this.#resources.some(({ name }) => name === resource.name))
      throw new Error("SERVICE_LIFECYCLE_DUPLICATE_RESOURCE");
    this.#resources.push(resource);
  }

  ready(): void {
    if (this.#state !== "starting") throw new Error("SERVICE_LIFECYCLE_NOT_STARTING");
    this.#state = "ready";
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#state = "stopping";
    this.#shutdown = Promise.resolve().then(() => this.#stop());
    return this.#shutdown;
  }

  async #stop(): Promise<void> {
    const failures: unknown[] = [];
    const resources = [...this.#resources].reverse();
    for (const phase of ["stopAccepting", "drain", "close"] as const) {
      for (const resource of resources) {
        try {
          await resource[phase]?.();
        } catch (error) {
          failures.push(
            new Error(`SERVICE_RESOURCE_${phase.toUpperCase()}_FAILED:${resource.name}`, {
              cause: error,
            }),
          );
        }
      }
    }
    this.#state = "stopped";
    if (failures.length) throw new AggregateError(failures, "SERVICE_SHUTDOWN_FAILED");
  }
}
