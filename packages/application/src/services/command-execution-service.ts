import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CommandObservation,
  type CommandOutputPort,
  type CommandProfile,
  type CommandSandboxPort,
  type CommandSecretBinding,
} from "../ports/index.js";
import type { ClockPort } from "../ports/system.js";
import type { CommandProfileService } from "./command-profile-service.js";

/**
 * Executes a frozen CommandProfile only through a qualified sandbox. The
 * sandbox owns secret resolution and literal redaction; this service persists
 * only protected, already-redacted stream payloads.
 */
export class CommandExecutionService {
  readonly #profiles: CommandProfileService;
  readonly #sandbox: CommandSandboxPort;
  readonly #output: CommandOutputPort;
  readonly #clock: ClockPort;

  constructor(input: {
    readonly profiles: CommandProfileService;
    readonly sandbox: CommandSandboxPort;
    readonly output: CommandOutputPort;
    readonly clock: ClockPort;
  }) {
    this.#profiles = input.profiles;
    this.#sandbox = input.sandbox;
    this.#output = input.output;
    this.#clock = input.clock;
  }

  async execute(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly scriptDigest: string | null;
    readonly secretBindings: readonly CommandSecretBinding[];
    readonly signal?: AbortSignal;
  }): Promise<CommandObservation> {
    const environmentNames = input.secretBindings.map(({ environmentName }) => environmentName);
    if (
      new Set(environmentNames).size !== environmentNames.length ||
      input.secretBindings.some(
        ({ environmentName, handleRef }) => environmentName.length === 0 || handleRef.length === 0,
      )
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Command secret bindings are incomplete or duplicated",
      );
    }
    this.#profiles.authorize({
      profile: input.profile,
      argv: input.argv,
      workdir: input.profile.workdir,
      environmentNames,
      scriptDigest: input.scriptDigest,
      now: this.#clock.now(),
    });
    const result = await this.#sandbox.execute({
      profile: input.profile,
      argv: input.argv,
      secretBindings: input.secretBindings,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!result.redactionApplied)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Sandbox returned output without mandatory redaction",
      );
    const [stdoutRef, stderrRef] = await Promise.all([
      this.#output.protect({
        commandProfileId: input.profile.id,
        stream: "stdout",
        bytes: result.stdout,
      }),
      this.#output.protect({
        commandProfileId: input.profile.id,
        stream: "stderr",
        bytes: result.stderr,
      }),
    ]);
    return Object.freeze({
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdoutRef,
      stderrRef,
      fileObservationRefs: Object.freeze([...result.fileObservationRefs]),
      networkObservationRefs: Object.freeze([...result.networkObservationRefs]),
      resourceObservation: Object.freeze({
        wallTimeMs: result.wallTimeMs,
        outputBytes: result.stdout.byteLength + result.stderr.byteLength,
        outputLimitExceeded: result.outputLimitExceeded,
        sandboxRuntimeIdentity: result.sandboxRuntimeIdentity,
        resourceCeilingEnforced: result.resourceCeilingEnforced,
        maximumCpuTimeMs: input.profile.resources.maxCpuTimeMs,
        maximumMemoryBytes: input.profile.resources.maxMemoryBytes,
        maximumProcesses: input.profile.resources.maxProcesses,
      }),
      cancellationReconciled: result.cancellationReconciled,
    });
  }
}
