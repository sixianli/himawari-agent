import type { DependencyHealth, DeploymentHealthSnapshot } from "@himawari-agent/domain";
import { createHealthSnapshotId, evaluateDeploymentHealth } from "@himawari-agent/domain";

export const REQUIRED_HEALTH_DEPENDENCIES = Object.freeze([
  "authority",
  "schema",
  "sqlite",
  "payload-keyring",
  "worker",
  "memory-persistence",
  "recovery",
] as const);

export type RequiredHealthDependency = (typeof REQUIRED_HEALTH_DEPENDENCIES)[number];

export interface PublicHealthSnapshot {
  readonly live: boolean;
  readonly ready: boolean;
  readonly status: DeploymentHealthSnapshot["status"];
}

export class RuntimeHealthModel {
  readonly #dependencies = new Map<string, DependencyHealth>();
  readonly #publicMode: boolean;
  readonly #now: () => string;
  #live = false;
  #authorityActive = false;
  #sequence = 0;

  constructor(options: { readonly publicMode: boolean; readonly now?: () => string }) {
    this.#publicMode = options.publicMode;
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const name of REQUIRED_HEALTH_DEPENDENCIES) {
      this.#dependencies.set(
        name,
        Object.freeze({ name, required: true, status: "unavailable", reasonCode: "NOT_STARTED" }),
      );
    }
    if (this.#publicMode) {
      this.#dependencies.set(
        "identity-trust",
        Object.freeze({
          name: "identity-trust",
          required: true,
          status: "unavailable",
          reasonCode: "NOT_STARTED",
        }),
      );
    }
    this.#dependencies.set(
      "model-provider",
      Object.freeze({
        name: "model-provider",
        required: false,
        status: "unavailable",
        reasonCode: "NOT_CHECKED",
      }),
    );
  }

  setLive(live: boolean): void {
    this.#live = live;
  }

  setAuthorityActive(active: boolean): void {
    this.#authorityActive = active;
  }

  observe(dependency: DependencyHealth): void {
    const expected = this.#dependencies.get(dependency.name);
    if (!expected || expected.required !== dependency.required) {
      throw new TypeError(`Unexpected health dependency ${dependency.name}`);
    }
    if (dependency.reasonCode !== null && !/^[A-Z][A-Z0-9_]{0,127}$/.test(dependency.reasonCode)) {
      throw new TypeError("Health reason must be a stable machine code");
    }
    this.#dependencies.set(dependency.name, Object.freeze({ ...dependency }));
  }

  snapshot(): DeploymentHealthSnapshot {
    this.#sequence += 1;
    return evaluateDeploymentHealth({
      live: this.#live,
      authorityActive: this.#authorityActive,
      snapshotId: createHealthSnapshotId(`health-${this.#now()}-${this.#sequence}`),
      dependencies: Object.freeze([...this.#dependencies.values()]),
    });
  }

  publicSnapshot(): PublicHealthSnapshot {
    const snapshot = this.snapshot();
    return Object.freeze({ live: snapshot.live, ready: snapshot.ready, status: snapshot.status });
  }

  authenticatedSnapshot(authenticated: boolean): DeploymentHealthSnapshot {
    if (!authenticated) throw new Error("HEALTH_AUTHENTICATION_REQUIRED");
    return this.snapshot();
  }
}
