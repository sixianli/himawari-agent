import { sandboxJobIdentitySchema } from "./sandbox-execution-v1.ts";
import {
  array,
  enumeration,
  type InferSchema,
  integer,
  literal,
  machineString,
  nullable,
  object,
  timestamp,
} from "./validation.ts";

/** A reservation records intent and occupancy, not a fabricated runtime observation. */
export const sandboxExecutionReservationSchema = object({
  schemaVersion: literal("sandbox-preparation.v1"),
  identity: sandboxJobIdentitySchema,
  environmentId: machineString,
  resourceRef: nullable(machineString),
  mode: enumeration(["foreground", "background", "service"]),
  workspaceConflictRefs: array(machineString),
  sequence: integer(1, 1),
  createdAt: timestamp,
});
export type SandboxExecutionReservation = InferSchema<typeof sandboxExecutionReservationSchema>;
