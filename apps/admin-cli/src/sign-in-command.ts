import {
  displaySetupCode,
  generateSetupCode,
  JsonFileConfigurationPort,
  SETUP_CODE_DEFAULT_MINUTES,
  SETUP_CODE_MAXIMUM_MINUTES,
  writeSetupCode,
} from "@himawari-agent/platform-node";

export const SIGN_IN_COMMAND_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "ADMIN_SIGN_IN_ARGUMENT_INVALID",
} as const);

const OPTIONS = ["--config", "--minutes"] as const;

export async function runSignInCommand(
  arguments_: readonly string[],
  now: () => Date = () => new Date(),
): Promise<unknown> {
  if (arguments_[0] !== "sign-in" || arguments_[1] !== "setup-code")
    throw new Error(SIGN_IN_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const values = new Map<string, string>();
  for (let index = 2; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !name ||
      !value ||
      !(OPTIONS as readonly string[]).includes(name) ||
      value.startsWith("--") ||
      values.has(name)
    )
      throw new Error(SIGN_IN_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
    values.set(name, value);
  }
  const configurationPath = values.get("--config");
  const minutesText = values.get("--minutes") ?? String(SETUP_CODE_DEFAULT_MINUTES);
  const minutes = Number(minutesText);
  if (
    !configurationPath ||
    !/^[0-9]{1,4}$/u.test(minutesText) ||
    minutes < 1 ||
    minutes > SETUP_CODE_MAXIMUM_MINUTES
  )
    throw new Error(SIGN_IN_COMMAND_ERROR_CODES.ARGUMENT_INVALID);
  const configuration = await new JsonFileConfigurationPort(configurationPath).load();
  const code = generateSetupCode();
  const record = await writeSetupCode({
    stateRoot: configuration.stateRoot,
    scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
    code,
    now: now(),
    minutes,
  });
  return Object.freeze({
    outputSchemaVersion: 1,
    command: "sign-in.setup-code",
    setupCode: displaySetupCode(code),
    expiresAt: record.expiresAt,
  });
}
