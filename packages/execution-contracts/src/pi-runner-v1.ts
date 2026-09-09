import { sandboxScopeSchema } from "./sandbox-scope-v1.ts";
import {
  ContractValidationError,
  enumeration,
  type InferSchema,
  integer,
  literal,
  machineString,
  object,
  type Schema,
} from "./validation.ts";

export const PI_RUNNER_CONTRACT = Object.freeze({ ref: "pi-coding-tool", version: "1" });
export const piCodingToolNameSchema = enumeration([
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
]);
const absolutePath: Schema<string> = {
  parse(value, location = "$") {
    if (
      typeof value !== "string" ||
      !value.startsWith("/") ||
      value === "/" ||
      value.length > 4096 ||
      value.endsWith("/") ||
      value.includes("//") ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.split("/").some((part) => part === ".." || part === ".")
    )
      throw new ContractValidationError(location, "expected absolute host path");
    return value;
  },
};
const text: Schema<string> = {
  parse(value, location = "$") {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 49152)
      throw new ContractValidationError(location, "invalid protected input");
    return value;
  },
};
/** Constructed by the Worker from the resolved scope and frozen input. These
 * fields are never accepted as model parameters or a new authority source. */
export const piRunnerInputSchema = object({
  schemaVersion: literal("pi-runner.v1"),
  workerInstanceId: machineString,
  tool: piCodingToolNameSchema,
  scope: sandboxScopeSchema,
  workspace: absolutePath,
  runtimeRoot: absolutePath,
  privateDirectory: absolutePath,
  maxOutputBytes: integer(1, 16777216),
  parametersJson: text,
});
export type PiRunnerInput = InferSchema<typeof piRunnerInputSchema>;
