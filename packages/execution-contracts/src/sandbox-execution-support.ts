import {
  array,
  ContractValidationError,
  enumeration,
  type InferSchema,
  object,
  type Schema,
} from "./validation.ts";

const entry = object({
  schemaVersion: enumeration(["sandbox-execution.v1", "sandbox-execution.v2"]),
  mode: enumeration(["foreground", "background", "service"]),
});
const entries = array(entry);
export type SandboxExecutionSupport = InferSchema<typeof entries>;
/** Installed declarations are a compatibility boundary, never a grant or runtime proof. */
export const sandboxExecutionSupportSchema: Schema<SandboxExecutionSupport> = {
  parse(value, path = "$") {
    const parsed = entries.parse(value, path);
    if (
      parsed.length === 0 ||
      parsed.length > 6 ||
      new Set(parsed.map((item) => `${item.schemaVersion}:${item.mode}`)).size !== parsed.length ||
      parsed.some(
        (item) => item.schemaVersion === "sandbox-execution.v1" && item.mode !== "foreground",
      )
    )
      throw new ContractValidationError(path, "invalid or duplicate sandbox execution support");
    return parsed;
  },
};
/** Missing declarations may describe an old installation; they never imply v2 support. */
export function assertSandboxExecutionSupport(
  request: SandboxExecutionSupport[number],
  participants: readonly (SandboxExecutionSupport | undefined)[],
): void {
  const target = entry.parse(request);
  if (
    participants.length === 0 ||
    participants.some(
      (declaration) =>
        !declaration ||
        !sandboxExecutionSupportSchema
          .parse(declaration)
          .some((item) => item.schemaVersion === target.schemaVersion && item.mode === target.mode),
    )
  )
    throw new Error("SANDBOX_EXECUTION_VERSION_UNAVAILABLE");
}

export function withSandboxExecutionSupport<T extends object>(
  base: Schema<T>,
): Schema<T & { readonly supportedExecutions?: SandboxExecutionSupport }> {
  return {
    parse(value, path = "$") {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("supportedExecutions" in value)
      )
        return base.parse(value, path);
      const { supportedExecutions, ...rest } = value;
      return Object.freeze({
        ...base.parse(rest, path),
        supportedExecutions: sandboxExecutionSupportSchema.parse(
          supportedExecutions,
          `${path}.supportedExecutions`,
        ),
      });
    },
  };
}
