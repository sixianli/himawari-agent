import {
  array,
  ContractValidationError,
  integer,
  literal,
  machineString,
  object,
  type InferSchema,
  type Schema,
} from "./validation.ts";
const socketName: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,20}\.sock$/.test(value))
      throw new ContractValidationError(path, "expected a private socket basename");
    return value;
  },
};
const probePath: Schema<string> = {
  parse(value, path = "$") {
    if (typeof value !== "string" || !/^\/[a-zA-Z0-9/_-]{0,127}$/.test(value))
      throw new ContractValidationError(path, "expected a literal HTTP probe path");
    return value;
  },
};
export const sandboxReadinessProbeSchema = object({
  kind: literal("unix_http"),
  ref: machineString,
  socketName,
  path: probePath,
  expectedStatus: integer(200, 299),
  timeoutMs: integer(100, 30000),
});
export type SandboxReadinessProbe = InferSchema<typeof sandboxReadinessProbeSchema>;
export function withSandboxReadiness<T extends object>(
  base: Schema<T>,
): Schema<T & { readonly readinessProbes?: readonly SandboxReadinessProbe[] }> {
  return {
    parse(value, path = "$") {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("readinessProbes" in value)
      )
        return base.parse(value, path);
      const { readinessProbes, ...rest } = value;
      const probes = array(sandboxReadinessProbeSchema).parse(readinessProbes, path);
      if (probes.length > 16 || new Set(probes.map((p) => p.ref)).size !== probes.length)
        throw new ContractValidationError(path, "invalid readiness probe inventory");
      return { ...base.parse(rest, path), readinessProbes: probes };
    },
  };
}
