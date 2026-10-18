const MACHINE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const SQLITE_CODE = /^SQLITE_/;
const RECORD_SCOPED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "SANDBOX_CONTROL_BINDING_UNAVAILABLE",
  "SANDBOX_CONTROL_BINDING_CHANGED",
  "SANDBOX_CONTROL_DIRECTORY_CHANGED",
  "SANDBOX_CONTROL_IDENTITY_CHANGED",
  "SANDBOX_STREAM_ARTIFACT_CHANGED",
  "SANDBOX_STREAM_ARTIFACT_INVALID",
  "SANDBOX_STREAM_CHUNK_MISSING",
  "SANDBOX_STREAM_SEQUENCE_INVALID",
  "SANDBOX_STREAM_TERMINATION_INVALID",
  "SANDBOX_RECOVERY_OUTPUT_CHANGED",
  "SANDBOX_RECOVERY_RESOURCE_CHANGED",
  "SANDBOX_TOOL_RESULT_BINDING_CHANGED",
  "SANDBOX_RECONCILIATION_BINDING_INVALID",
  "SANDBOX_RECONCILIATION_EVIDENCE_CHANGED",
  "SANDBOX_TASK_ENVIRONMENT_BINDING_CHANGED",
  "SANDBOX_TASK_ENVIRONMENT_EVIDENCE_CHANGED",
  "TOOL_RESULT_RECOVERY_PAYLOAD_MISSING",
  "TOOL_RESULT_RECOVERY_RECORD_INVALID",
  "TOOL_RESULT_RECOVERY_TRACE_LIMIT",
  "TOOL_RESULT_RECOVERY_TRACE_ORDER",
]);

export function machineFailureCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string" && MACHINE_CODE.test(error.code))
    return error.code;
  if (error instanceof Error && MACHINE_CODE.test(error.message)) return error.message;
  return undefined;
}

function carriesSqliteCode(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("details" in error)) return false;
  const details = (error as { details?: unknown }).details;
  if (details === null || typeof details !== "object") return false;
  return Object.values(details).some(
    (value) => typeof value === "string" && SQLITE_CODE.test(value),
  );
}

export function isGlobalServiceFailure(error: unknown): boolean {
  if (carriesSqliteCode(error)) return true;
  const code = machineFailureCode(error);
  if (code === undefined) return true;
  return !RECORD_SCOPED_FAILURE_CODES.has(code);
}
