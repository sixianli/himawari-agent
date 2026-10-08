import { Worker } from "node:worker_threads";
import type { SandboxDependencyCheck, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { SANDBOX_HOST_FAILURE_CODES } from "@himawari-agent/execution-contracts";
import { JOB_HOST_SYSTEM_CODES } from "./job-host-protocol.ts";

type SandboxSdkOperation =
  | { readonly method: "checkDependenciesAsync"; readonly args: readonly [] }
  | { readonly method: "initialize"; readonly args: readonly [SandboxRuntimeConfig] }
  | { readonly method: "wrapWithSandboxArgv"; readonly args: readonly [string, string] }
  | { readonly method: "cleanupAfterCommand" | "reset"; readonly args: readonly [] };
export type SandboxSdkRequest = SandboxSdkOperation & { readonly id: number };
export interface SandboxSdk {
  checkDependenciesAsync(): Promise<SandboxDependencyCheck>;
  isSupportedPlatform(): boolean;
  initialize(
    configuration: SandboxRuntimeConfig,
    callback?: undefined,
    monitor?: false,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    shell: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): Promise<void>;
  reset(): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function sandboxSdkFailure(value: unknown): Error & { code: string } {
  const fields = object(value) ? value : {};
  const message =
    SANDBOX_HOST_FAILURE_CODES.find((code) => code === fields["message"]) ?? "UNKNOWN";
  const code = JOB_HOST_SYSTEM_CODES.find((code) => code === fields["code"]) ?? "UNKNOWN";
  return Object.assign(new Error(message), { code });
}
function resultValue(method: SandboxSdkOperation["method"], value: unknown): unknown {
  if (method === "checkDependenciesAsync") {
    if (
      !object(value) ||
      ![value["errors"], value["warnings"]].every(
        (items) => Array.isArray(items) && items.every((item: unknown) => typeof item === "string"),
      )
    )
      throw sandboxSdkFailure(undefined);
    return { errors: value["errors"], warnings: value["warnings"] };
  }
  if (method === "wrapWithSandboxArgv") {
    if (
      !object(value) ||
      !Array.isArray(value["argv"]) ||
      value["argv"].length === 0 ||
      !value["argv"].every((item: unknown) => typeof item === "string") ||
      !object(value["env"]) ||
      !Object.values(value["env"]).every((item) => item === undefined || typeof item === "string")
    )
      throw sandboxSdkFailure(undefined);
    return { argv: [...value["argv"]], env: { ...value["env"] } };
  }
  if (value !== undefined) throw sandboxSdkFailure(undefined);
  return undefined;
}

export async function createSandboxSdk(onFailure: () => void): Promise<SandboxSdk> {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const thread = new Worker(new URL(`./sandbox-sdk-worker.${extension}`, import.meta.url), {
    execArgv: [],
    env: { ...process.env },
  });
  type Pending = {
    readonly request: SandboxSdkRequest;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  };
  let supported = false;
  let ready = false;
  let closed = false;
  let exited = false;
  let failure: Error | undefined;
  let nextId = 0;
  let active: Pending | undefined;
  const queued: Pending[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const initialization = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resetRequested = false;
  let resetAcknowledged = false;
  let resetPromise: Promise<void> | undefined;
  let resolveReset: (() => void) | undefined;
  let rejectReset: ((error: Error) => void) | undefined;
  const fail = (error: Error, terminate = true) => {
    if (failure || closed) return;
    failure = error;
    rejectReady(error);
    active?.reject(error);
    active = undefined;
    for (const pending of queued.splice(0)) pending.reject(error);
    rejectReset?.(error);
    if (terminate && !exited) void thread.terminate().catch(() => {});
    try {
      onFailure();
    } catch {}
  };
  const dispatch = () => {
    if (active || failure || closed) return;
    active = queued.shift();
    if (!active) return;
    try {
      thread.postMessage(active.request);
    } catch (error) {
      fail(sandboxSdkFailure(error));
    }
  };
  const operation = (value: SandboxSdkOperation): Promise<unknown> => {
    if (failure || closed || (resetRequested && value.method !== "reset"))
      return Promise.reject(failure ?? sandboxSdkFailure(undefined));
    return new Promise((resolve, reject) => {
      queued.push({ request: { ...value, id: ++nextId }, resolve, reject });
      dispatch();
    });
  };
  thread.on("error", (error: Error) => fail(sandboxSdkFailure(error)));
  thread.on("messageerror", (error: Error) => fail(sandboxSdkFailure(error)));
  thread.on("exit", (code: number) => {
    exited = true;
    if (!failure && resetRequested && resetAcknowledged && code === 0) {
      closed = true;
      resolveReset?.();
    } else fail(sandboxSdkFailure(undefined), false);
  });
  thread.on("message", (value: unknown) => {
    if (failure || closed) return;
    if (!object(value)) {
      fail(sandboxSdkFailure(undefined));
      return;
    }
    if (!ready) {
      if (value["type"] === "initialization_failed") {
        fail(sandboxSdkFailure(value["error"]));
        return;
      }
      if (value["type"] !== "ready" || typeof value["supported"] !== "boolean") {
        fail(sandboxSdkFailure(undefined));
        return;
      }
      supported = value["supported"];
      ready = true;
      resolveReady();
      return;
    }
    if (
      value["type"] !== "result" ||
      !active ||
      value["id"] !== active.request.id ||
      typeof value["ok"] !== "boolean"
    ) {
      fail(sandboxSdkFailure(undefined));
      return;
    }
    const pending = active;
    if (!value["ok"]) {
      active = undefined;
      pending.reject(sandboxSdkFailure(value["error"]));
      dispatch();
      return;
    }
    let result: unknown;
    try {
      result = resultValue(pending.request.method, value["value"]);
    } catch (error) {
      fail(sandboxSdkFailure(error));
      return;
    }
    active = undefined;
    if (pending.request.method === "reset") resetAcknowledged = true;
    pending.resolve(result);
    dispatch();
  });
  await initialization;
  if (failure) throw failure;
  return {
    checkDependenciesAsync: async () =>
      (await operation({ method: "checkDependenciesAsync", args: [] })) as SandboxDependencyCheck,
    isSupportedPlatform: () => supported,
    initialize: async (configuration) => {
      await operation({ method: "initialize", args: [configuration] });
    },
    wrapWithSandboxArgv: async (command, shell) =>
      (await operation({ method: "wrapWithSandboxArgv", args: [command, shell] })) as {
        argv: string[];
        env: NodeJS.ProcessEnv;
      },
    cleanupAfterCommand: async () => {
      await operation({ method: "cleanupAfterCommand", args: [] });
    },
    reset: () => {
      if (resetPromise) return resetPromise;
      if (failure || closed) return Promise.reject(failure ?? sandboxSdkFailure(undefined));
      resetRequested = true;
      resetPromise = new Promise<void>((resolve, reject) => {
        resolveReset = resolve;
        rejectReset = reject;
      });
      void operation({ method: "reset", args: [] }).catch((error: unknown) =>
        fail(sandboxSdkFailure(error)),
      );
      return resetPromise;
    },
  };
}
