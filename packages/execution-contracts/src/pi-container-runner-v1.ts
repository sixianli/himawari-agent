import {
  ContractValidationError,
  enumeration,
  type InferSchema,
  integer,
  literal,
  machineString,
  object,
  type Schema,
  timestamp,
} from "./validation.ts";

export const PI_CONTAINER_RUNNER_V1 = "pi-container-runner.v1" as const;
export const PI_CONTAINER_WORKSPACE_ROOT = "/workspaces";

const parametersJson: Schema<string> = {
  parse(value, location = "$") {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 49152)
      throw new ContractValidationError(location, "invalid protected input");
    return value;
  },
};

const containerPath: Schema<string> = {
  parse(value, location = "$") {
    if (typeof value !== "string" || value.length > 4096)
      throw new ContractValidationError(location, "expected a container path");
    return value;
  },
};

const input = object({
  schemaVersion: literal(PI_CONTAINER_RUNNER_V1),
  tool: enumeration(["read", "write", "edit", "bash", "find", "grep", "ls"]),
  toolCallId: machineString,
  hostId: machineString,
  canonicalRootId: machineString,
  workspace: containerPath,
  grantRef: machineString,
  grantRevision: integer(1),
  authorizationRef: machineString,
  access: enumeration(["read", "write"]),
  expiresAt: timestamp,
  maxOutputBytes: integer(1, 16777216),
  parametersJson,
});
export type PiContainerRunnerInput = InferSchema<typeof input>;

/** Built by the Worker from the environment's approved directory; the model
 * supplies only the Pi parameters inside parametersJson. */
export const piContainerRunnerInputSchema: Schema<PiContainerRunnerInput> = {
  parse(value, location = "$") {
    const parsed = input.parse(value, location);
    if (parsed.workspace !== `${PI_CONTAINER_WORKSPACE_ROOT}/${parsed.canonicalRootId}`)
      throw new ContractValidationError(
        `${location}.workspace`,
        "expected the mounted directory of the approved root",
      );
    if ((parsed.tool === "write" || parsed.tool === "edit") && parsed.access !== "write")
      throw new ContractValidationError(`${location}.tool`, "writes need a write grant");
    return parsed;
  },
};
