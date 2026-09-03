import {
  redactMachineSecrets,
  type CommandProfile,
  type CommandSandboxPort,
  type CommandSecretBinding,
} from "@himawari-agent/application";

export const MAC_SEATBELT_XPC_ERROR_CODES = Object.freeze({
  PLATFORM_UNSUPPORTED: "COMMAND_MAC_SEATBELT_PLATFORM_UNSUPPORTED",
  PROFILE_NOT_LOW_RISK: "COMMAND_MAC_SEATBELT_PROFILE_NOT_LOW_RISK",
  HELPER_NOT_QUALIFIED: "COMMAND_MAC_SEATBELT_HELPER_NOT_QUALIFIED",
} as const);

export interface MacSeatbeltXpcQualification {
  readonly protocolIdentity: "himawari.mac-command.v1";
  readonly runtimeIdentity: string;
  readonly codeSignatureValid: boolean;
  readonly appSandboxEntitled: boolean;
  readonly xpcServiceSandboxInherited: boolean;
  readonly workspaceReadOnlyEnforced: boolean;
  readonly networkClientEntitled: boolean;
}

export interface MacSeatbeltXpcClient {
  qualify(): Promise<MacSeatbeltXpcQualification>;
  execute(input: {
    readonly operation: "diff" | "log" | "rev-parse" | "show" | "status";
    readonly arguments: readonly string[];
    readonly workspaceRoot: string;
    readonly authorizationRef: string;
    readonly ceiling: {
      readonly maxWallTimeMs: number;
      readonly maxCpuTimeMs: number;
      readonly maxMemoryBytes: number;
      readonly maxOutputBytes: number;
      readonly maxProcesses: number;
    };
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly outputLimitExceeded: boolean;
    readonly wallTimeMs: number;
    readonly fileObservationRefs: readonly string[];
    readonly cancellationReconciled: boolean;
    readonly resourceCeilingEnforced: true;
  }>;
}

const READ_ONLY_GIT_OPERATIONS = new Set(["diff", "log", "rev-parse", "show", "status"]);

/** Trusted adapter for the signed, read-only App Sandbox/XPC helper. */
export class MacSeatbeltXpcCommandSandbox implements CommandSandboxPort {
  readonly #client: MacSeatbeltXpcClient;
  readonly #expectedRuntimeIdentity: string;
  readonly #platform: NodeJS.Platform;

  constructor(input: {
    readonly client: MacSeatbeltXpcClient;
    readonly expectedRuntimeIdentity: string;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#client = input.client;
    this.#expectedRuntimeIdentity = input.expectedRuntimeIdentity;
    this.#platform = input.platform ?? process.platform;
  }

  async execute(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly secretBindings: readonly CommandSecretBinding[];
    readonly signal?: AbortSignal;
  }) {
    if (this.#platform !== "darwin")
      throw new Error(MAC_SEATBELT_XPC_ERROR_CODES.PLATFORM_UNSUPPORTED);
    const operation = input.argv[1] ?? "";
    if (
      input.profile.sandboxTier !== "native-low-risk" ||
      input.argv[0] !== "git" ||
      !READ_ONLY_GIT_OPERATIONS.has(operation) ||
      input.profile.network !== "none" ||
      input.profile.environmentNames.length > 0 ||
      input.profile.scriptDigest !== null ||
      input.secretBindings.length > 0 ||
      input.profile.fileScopes.length !== 1 ||
      input.profile.fileScopes[0] !== input.profile.workdir
    ) {
      throw new Error(MAC_SEATBELT_XPC_ERROR_CODES.PROFILE_NOT_LOW_RISK);
    }
    const qualification = await this.#client.qualify();
    if (
      qualification.protocolIdentity !== "himawari.mac-command.v1" ||
      qualification.runtimeIdentity !== this.#expectedRuntimeIdentity ||
      qualification.runtimeIdentity !== input.profile.sandboxRuntimeIdentity ||
      !qualification.codeSignatureValid ||
      !qualification.appSandboxEntitled ||
      !qualification.xpcServiceSandboxInherited ||
      !qualification.workspaceReadOnlyEnforced ||
      qualification.networkClientEntitled
    ) {
      throw new Error(MAC_SEATBELT_XPC_ERROR_CODES.HELPER_NOT_QUALIFIED);
    }
    const result = await this.#client.execute({
      operation: operation as "diff" | "log" | "rev-parse" | "show" | "status",
      arguments: Object.freeze(input.argv.slice(2)),
      workspaceRoot: input.profile.workdir,
      authorizationRef: input.profile.authorizationRef,
      ceiling: Object.freeze({
        maxWallTimeMs: input.profile.timeoutMs,
        maxCpuTimeMs: input.profile.resources.maxCpuTimeMs,
        maxMemoryBytes: input.profile.resources.maxMemoryBytes,
        maxOutputBytes: input.profile.maxOutputBytes,
        maxProcesses: input.profile.resources.maxProcesses,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const redact = (bytes: Uint8Array) =>
      new TextEncoder().encode(redactMachineSecrets(new TextDecoder().decode(bytes)));
    return Object.freeze({
      ...result,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
      networkObservationRefs: Object.freeze(["command-network:none:app-sandbox-entitlement"]),
      redactionApplied: true as const,
      sandboxRuntimeIdentity: qualification.runtimeIdentity,
    });
  }
}
