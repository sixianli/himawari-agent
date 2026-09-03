import { ApplicationPortError, PORT_ERROR_CODES, type CommandProfile } from "../ports/index.js";

const ALLOWED_EXECUTABLES = new Set(["git", "node", "npm"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["diff", "log", "rev-parse", "show", "status"]);
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
]);

export class CommandProfileService {
  authorize(input: {
    readonly profile: CommandProfile;
    readonly argv: readonly string[];
    readonly workdir: string;
    readonly environmentNames: readonly string[];
    readonly scriptDigest: string | null;
    readonly now: string;
  }): void {
    const { profile } = input;
    const nativeLowRisk =
      input.argv[0] === "git" &&
      READ_ONLY_GIT_SUBCOMMANDS.has(input.argv[1] ?? "") &&
      input.environmentNames.length === 0 &&
      input.scriptDigest === null &&
      profile.network === "none";
    if (
      profile.revokedAt ||
      profile.expiresAt <= input.now ||
      input.workdir !== profile.workdir ||
      input.argv.length !== profile.argvPattern.length ||
      input.argv.some((value, index) => value !== profile.argvPattern[index]) ||
      input.environmentNames.some((name) => !profile.environmentNames.includes(name)) ||
      input.environmentNames.some((name) => FORBIDDEN_ENVIRONMENT_NAMES.has(name)) ||
      profile.scriptDigest !== input.scriptDigest ||
      !ALLOWED_EXECUTABLES.has(input.argv[0] ?? "") ||
      (input.argv[0] === "git" && !READ_ONLY_GIT_SUBCOMMANDS.has(input.argv[1] ?? "")) ||
      (input.argv[0] === "npm" && !["run", "test"].includes(input.argv[1] ?? ""))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Command is outside the frozen CommandProfile",
      );
    }
    if (profile.network !== "none")
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Networked commands require a new ActionIntent",
      );
    if (profile.sandboxTier === "native-low-risk" && !nativeLowRisk) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Command does not match the frozen sandbox tier",
      );
    }
  }
}
