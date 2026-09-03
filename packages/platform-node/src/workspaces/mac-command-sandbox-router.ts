import type {
  CommandProfile,
  CommandSandboxPort,
  CommandSecretBinding,
} from "@himawari-agent/application";

export const MAC_COMMAND_SANDBOX_ROUTER_ERROR_CODES = Object.freeze({
  NATIVE_SECRETS_FORBIDDEN: "COMMAND_NATIVE_LOW_RISK_SECRETS_FORBIDDEN",
  TIER_UNSUPPORTED: "COMMAND_SANDBOX_TIER_UNSUPPORTED",
} as const);

/**
 * Routes a frozen Mac command to a signed App Sandbox/XPC helper or Apple
 * container. A failed tier is never retried through the weaker tier.
 */
export class MacCommandSandboxRouter implements CommandSandboxPort {
  readonly #nativeLowRisk: CommandSandboxPort;
  readonly #isolatedHighRisk: CommandSandboxPort;

  constructor(input: {
    readonly nativeLowRisk: CommandSandboxPort;
    readonly isolatedHighRisk: CommandSandboxPort;
  }) {
    this.#nativeLowRisk = input.nativeLowRisk;
    this.#isolatedHighRisk = input.isolatedHighRisk;
  }

  async execute(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly secretBindings: readonly CommandSecretBinding[];
    readonly signal?: AbortSignal;
  }) {
    switch (input.profile.sandboxTier) {
      case "native-low-risk":
        if (input.secretBindings.length > 0) {
          throw new Error(MAC_COMMAND_SANDBOX_ROUTER_ERROR_CODES.NATIVE_SECRETS_FORBIDDEN);
        }
        return this.#nativeLowRisk.execute(input);
      case "isolated-high-risk":
        return this.#isolatedHighRisk.execute(input);
      default:
        throw new Error(MAC_COMMAND_SANDBOX_ROUTER_ERROR_CODES.TIER_UNSUPPORTED);
    }
  }
}
