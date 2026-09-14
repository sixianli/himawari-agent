import { sandboxOperationContractSchema } from "./sandbox-execution-v2.ts";
import {
  array,
  ContractValidationError,
  enumeration,
  type InferSchema,
  machineString,
  object,
  type Schema,
} from "./validation.ts";

const item = object({
  operation: machineString,
  mode: enumeration(["foreground", "background", "service"]),
  contract: sandboxOperationContractSchema,
  backendRef: machineString,
  scopeSource: enumeration(["file_workflow", "grant_targets"]),
  directoryOperations: array(
    enumeration(["read", "create", "update", "move", "trash", "restore", "permanent_delete"]),
  ),
  network: enumeration(["disabled", "grant_targets"]),
});
export type SandboxOperationBinding = InferSchema<typeof item>;
const items = array(item);
export const sandboxOperationBindingsSchema: Schema<readonly SandboxOperationBinding[]> = {
  parse(value, path = "$") {
    const parsed = items.parse(value, path);
    if (
      parsed.length === 0 ||
      parsed.length > 64 ||
      new Set(parsed.map((item) => item.operation)).size !== parsed.length ||
      parsed.some(
        (item) =>
          item.directoryOperations.length === 0 ||
          new Set(item.directoryOperations).size !== item.directoryOperations.length ||
          (item.contract.kind === "fixed_read" &&
            item.directoryOperations.some((op) => op !== "read")) ||
          (item.contract.kind === "task_start") !== (item.mode === "background") ||
          (item.contract.kind === "service_start" && item.mode !== "service") ||
          (item.scopeSource === "file_workflow" &&
            (item.mode !== "foreground" || item.contract.kind !== "fixed_read")),
      )
    )
      throw new ContractValidationError(path, "invalid sandbox operation binding");
    return parsed;
  },
};
export function withSandboxOperationBindings<T extends object>(
  base: Schema<T>,
): Schema<T & { readonly operationBindings?: readonly SandboxOperationBinding[] }> {
  return {
    parse(value, path = "$") {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("operationBindings" in value)
      )
        return base.parse(value, path);
      const { operationBindings, ...rest } = value;
      return Object.freeze({
        ...base.parse(rest, path),
        operationBindings: sandboxOperationBindingsSchema.parse(operationBindings, path),
      });
    },
  };
}
