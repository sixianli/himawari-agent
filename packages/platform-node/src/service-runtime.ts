import process from "node:process";

export const SERVICE_RUNTIME_ERROR_CODES = Object.freeze({
  ARGUMENT_INVALID: "SERVICE_ARGUMENT_INVALID",
  PROFILE_FORBIDDEN: "SERVICE_PROFILE_FORBIDDEN",
  PUBLIC_MODE_INCOMPLETE: "SERVICE_PUBLIC_MODE_INCOMPLETE",
  STARTUP_FAILED: "SERVICE_STARTUP_FAILED",
} as const);

export interface ServiceArguments {
  readonly configurationPath: string;
  readonly workerTokenPath: string;
  readonly profile: "production";
}

export function parseServiceArguments(arguments_: readonly string[]): ServiceArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) {
      throw new Error(SERVICE_RUNTIME_ERROR_CODES.ARGUMENT_INVALID);
    }
    values.set(name, value);
  }
  if (
    values.size !== 3 ||
    !values.has("--config") ||
    !values.has("--worker-token-file") ||
    !values.has("--profile")
  ) {
    throw new Error(SERVICE_RUNTIME_ERROR_CODES.ARGUMENT_INVALID);
  }
  if (values.get("--profile") !== "production") {
    throw new Error(SERVICE_RUNTIME_ERROR_CODES.PROFILE_FORBIDDEN);
  }
  return Object.freeze({
    configurationPath: values.get("--config") as string,
    workerTokenPath: values.get("--worker-token-file") as string,
    profile: "production",
  });
}

export function stableErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)) {
    return error.message;
  }
  return SERVICE_RUNTIME_ERROR_CODES.STARTUP_FAILED;
}

export function writeServiceDiagnostic(
  output: NodeJS.WritableStream,
  diagnostic: Readonly<Record<string, string | number | boolean | readonly string[]>>,
): void {
  output.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic })}\n`);
}

export async function waitForTerminationSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const settle = (signal: "SIGINT" | "SIGTERM") => {
      clearInterval(keepAlive);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      resolve(signal);
    };
    const onInterrupt = () => settle("SIGINT");
    const onTerminate = () => settle("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}
