import {
  redactMachineSecrets,
  type ClockPort,
  type CommandProfile,
  type CommandSandboxPort,
  type CommandSecretBinding,
} from "@himawari-agent/application";
import { runSandboxedProcess, type SandboxedProcessLaunch } from "../capabilities/isolation.js";

export interface CommandSandboxLaunchProvider {
  qualify(profile: CommandProfile): Promise<{
    readonly productionSuitable: boolean;
    readonly runtimeIdentity: string;
    readonly reasonCodes: readonly string[];
  }>;
  createLaunch(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<SandboxedProcessLaunch>;
  observeFiles(profile: CommandProfile): Promise<readonly string[]>;
}

export interface CommandSecretValueResolver {
  resolve(handleRef: string): Promise<{
    readonly value: string;
    readonly scopeRef: string;
    readonly expiresAt: string;
    readonly revokedAt: string | null;
  }>;
}

/**
 * Trusted host boundary for command-secret material. Secret values exist only
 * while constructing the child environment and while redacting the completed
 * byte streams; neither value nor environment is returned to application code.
 */
export class QualifiedCommandSandbox implements CommandSandboxPort {
  readonly #launches: CommandSandboxLaunchProvider;
  readonly #secrets: CommandSecretValueResolver;
  readonly #clock: ClockPort;

  constructor(input: {
    readonly launches: CommandSandboxLaunchProvider;
    readonly secrets: CommandSecretValueResolver;
    readonly clock: ClockPort;
  }) {
    this.#launches = input.launches;
    this.#secrets = input.secrets;
    this.#clock = input.clock;
  }

  async execute(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly secretBindings: readonly CommandSecretBinding[];
    readonly signal?: AbortSignal;
  }) {
    const qualification = await this.#launches.qualify(input.profile);
    if (
      !qualification.productionSuitable ||
      qualification.runtimeIdentity !== input.profile.sandboxRuntimeIdentity
    ) {
      throw new Error(qualification.reasonCodes[0] ?? "COMMAND_SANDBOX_NOT_QUALIFIED");
    }
    const environment: Record<string, string> = {};
    const sensitiveLiterals: string[] = [];
    for (const binding of input.secretBindings) {
      const secret = await this.#secrets.resolve(binding.handleRef);
      if (
        secret.revokedAt ||
        secret.expiresAt <= this.#clock.now() ||
        secret.scopeRef !== input.profile.id ||
        !input.profile.environmentNames.includes(binding.environmentName) ||
        input.argv.some((argument) => argument.includes(secret.value))
      ) {
        throw new Error("COMMAND_SECRET_HANDLE_INVALID");
      }
      environment[binding.environmentName] = secret.value;
      sensitiveLiterals.push(secret.value);
    }
    const before = await this.#launches.observeFiles(input.profile);
    const launch = await this.#launches.createLaunch({
      profile: input.profile,
      argv: input.argv,
      environment: Object.freeze(environment),
    });
    const startedAt = performance.now();
    const result = await runSandboxedProcess(launch, null, input.signal);
    const after = await this.#launches.observeFiles(input.profile);
    const redact = (bytes: Uint8Array): Uint8Array => {
      let value = redactMachineSecrets(new TextDecoder().decode(bytes));
      for (const literal of sensitiveLiterals)
        value = value.split(literal).join("[SECRET_REDACTED]");
      return new TextEncoder().encode(value);
    };
    return Object.freeze({
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      outputLimitExceeded: result.outputLimitExceeded,
      wallTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      fileObservationRefs: Object.freeze([
        `command-files:before:${before.join(",")}`,
        `command-files:after:${after.join(",")}`,
      ]),
      networkObservationRefs: Object.freeze(["command-network:none:enforced"]),
      redactionApplied: true as const,
      cancellationReconciled: input.signal?.aborted ? result.signal !== null : true,
      sandboxRuntimeIdentity: qualification.runtimeIdentity,
      resourceCeilingEnforced: true as const,
    });
  }
}
