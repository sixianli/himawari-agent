import { ApplicationPortError, PORT_ERROR_CODES, type CommandProfile } from "../ports/index.js";

const FORBIDDEN_EXECUTABLES = new Set(["curl", "wget", "ssh", "scp", "gh", "sudo", "su"]);

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
    if (
      profile.revokedAt ||
      profile.expiresAt <= input.now ||
      input.workdir !== profile.workdir ||
      input.argv.length !== profile.argvPattern.length ||
      input.argv.some((value, index) => value !== profile.argvPattern[index]) ||
      input.environmentNames.some((name) => !profile.environmentNames.includes(name)) ||
      profile.scriptDigest !== input.scriptDigest ||
      FORBIDDEN_EXECUTABLES.has(input.argv[0] ?? "") ||
      (input.argv[0] === "git" && input.argv.includes("push"))
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
  }
}
