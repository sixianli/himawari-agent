import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxSdk, type SandboxSdk } from "../src/sandbox-sdk.ts";

const boundary = vi.hoisted(() => ({ Worker: vi.fn<new (...args: unknown[]) => Thread>() }));
vi.mock("node:worker_threads", () => ({ Worker: boundary.Worker }));

type Request = { id: number; method: string; args: unknown[] };
type Thread = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};
let threads: Thread[];
beforeEach(() => {
  threads = [];
  boundary.Worker.mockReset();
  boundary.Worker.mockImplementation(function (this: Thread) {
    Object.setPrototypeOf(this, EventEmitter.prototype);
    Object.assign(this, new EventEmitter(), {
      postMessage: vi.fn(),
      terminate: vi.fn(async () => 1),
    });
    threads.push(this);
  });
});
afterEach(() => vi.restoreAllMocks());

async function open(supported = true) {
  const failed = vi.fn();
  const creating = createSandboxSdk(failed);
  const thread = threads[0];
  if (!thread) throw new Error("SDK thread was not created");
  thread.emit("message", { type: "ready", supported });
  return { sdk: await creating, thread, failed };
}
function request(thread: Thread, index = thread.postMessage.mock.calls.length - 1): Request {
  const value = thread.postMessage.mock.calls[index]?.[0] as Request | undefined;
  if (!value) throw new Error("SDK operation was not sent");
  return value;
}
function respond(thread: Thread, value?: unknown) {
  thread.emit("message", { type: "result", id: request(thread).id, ok: true, value });
}
async function close(sdk: SandboxSdk, thread: Thread) {
  const resetting = sdk.reset();
  respond(thread);
  thread.emit("exit", 0);
  await resetting;
}

describe("sandbox SDK thread boundary", () => {
  it.each([true, false])(
    "copies the private environment and caches platform support: %s",
    async (supported) => {
      const { sdk, thread, failed } = await open(supported);
      const [entry, options] = boundary.Worker.mock.calls[0] as [
        URL,
        { execArgv: string[]; env: NodeJS.ProcessEnv },
      ];
      expect(entry.pathname).toMatch(/\/sandbox-sdk-worker\.ts$/);
      expect(options.execArgv).toEqual([]);
      expect(options.env).toEqual(process.env);
      expect(options.env).not.toBe(process.env);
      expect(sdk.isSupportedPlatform()).toBe(supported);
      expect(thread.postMessage).not.toHaveBeenCalled();
      await close(sdk, thread);
      expect(failed).not.toHaveBeenCalled();
      expect(thread.terminate).not.toHaveBeenCalled();
    },
  );

  it("serializes dependency, initialization and wrapping operations", async () => {
    const { sdk, thread } = await open();
    const configuration = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
    };
    const dependencies = sdk.checkDependenciesAsync();
    const initialized = sdk.initialize(configuration, undefined, false);
    const wrapped = sdk.wrapWithSandboxArgv("synthetic command", "/bin/bash");
    expect(thread.postMessage).toHaveBeenCalledTimes(1);
    expect(request(thread)).toMatchObject({ method: "checkDependenciesAsync", args: [] });
    respond(thread, { errors: [], warnings: [] });
    expect(await dependencies).toEqual({ errors: [], warnings: [] });
    await Promise.resolve();
    expect(thread.postMessage).toHaveBeenCalledTimes(2);
    expect(request(thread)).toMatchObject({ method: "initialize", args: [configuration] });
    respond(thread);
    await initialized;
    await Promise.resolve();
    expect(thread.postMessage).toHaveBeenCalledTimes(3);
    expect(request(thread)).toMatchObject({
      method: "wrapWithSandboxArgv",
      args: ["synthetic command", "/bin/bash"],
    });
    respond(thread, {
      argv: ["/bin/bash", "-c", "synthetic command"],
      env: { HOME: "/private-job" },
    });
    expect(await wrapped).toEqual({
      argv: ["/bin/bash", "-c", "synthetic command"],
      env: { HOME: "/private-job" },
    });
    await close(sdk, thread);
  });

  it.each([
    {
      error: { code: "EIO", message: "JOB_HOST_JAVA_AGENT_INVALID" },
      code: "EIO",
      message: "JOB_HOST_JAVA_AGENT_INVALID",
    },
    {
      error: { code: "EACCES", message: "private SDK error /secret/path" },
      code: "EACCES",
      message: "UNKNOWN",
    },
    {
      error: { code: "private-code", message: "private SDK error /secret/path" },
      code: "UNKNOWN",
      message: "UNKNOWN",
    },
  ])("keeps only bounded failure fields: $code / $message", async ({ error, code, message }) => {
    const { sdk, thread, failed } = await open();
    const initialized = sdk.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
      },
      undefined,
      false,
    );
    const rejected = expect(initialized).rejects.toMatchObject({ code, message });
    thread.emit("message", { type: "result", id: request(thread).id, ok: false, error });
    await rejected;
    expect(failed).not.toHaveBeenCalled();
    await close(sdk, thread);
  });

  it("rejects an import failure and closes the uninitialized thread", async () => {
    const failed = vi.fn();
    const creating = createSandboxSdk(failed);
    const rejected = expect(creating).rejects.toMatchObject({ code: "EIO", message: "UNKNOWN" });
    const thread = threads[0];
    if (!thread) throw new Error("SDK thread was not created");
    thread.emit("message", {
      type: "initialization_failed",
      error: { code: "EIO", message: "/private/import/path" },
    });
    thread.emit("exit", 1);
    await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "missing platform support", message: { type: "ready" } },
    {
      name: "non-boolean platform support",
      message: { type: "ready", supported: "false" },
    },
    {
      name: "an operation result before ready",
      message: { type: "result", id: 1, ok: true, value: { errors: [], warnings: [] } },
    },
  ])("rejects $name during startup before issuing SDK operations", async ({ message }) => {
    const failed = vi.fn();
    const creating = createSandboxSdk(failed);
    const rejected = expect(creating).rejects.toMatchObject({
      code: "UNKNOWN",
      message: "UNKNOWN",
    });
    const thread = threads[0];
    if (!thread) throw new Error("SDK thread was not created");
    thread.emit("message", message);
    await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(thread.postMessage).not.toHaveBeenCalled();
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    thread.emit("exit", 1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "exit"] as const)(
    "rejects startup when ready is followed by %s before the factory resumes",
    async (event) => {
      const failed = vi.fn();
      const creating = createSandboxSdk(failed);
      const rejected = expect(creating).rejects.toMatchObject({
        code: "UNKNOWN",
        message: "UNKNOWN",
      });
      const thread = threads[0];
      if (!thread) throw new Error("SDK thread was not created");
      thread.emit("message", { type: "ready", supported: true });
      if (event === "error") thread.emit("error", new Error("private thread failure"));
      else thread.emit("exit", 0);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(thread.postMessage).not.toHaveBeenCalled();
      await rejected;
    },
  );

  it.each(["error", "messageerror", "exit"] as const)(
    "rejects active and queued operations after unexpected %s",
    async (event) => {
      const { sdk, thread, failed } = await open();
      const active = expect(sdk.checkDependenciesAsync()).rejects.toThrow();
      const queued = expect(sdk.wrapWithSandboxArgv("synthetic", "/bin/bash")).rejects.toThrow();
      if (event !== "exit") thread.emit(event, new Error("private thread failure"));
      else thread.emit("exit", 0);
      await Promise.all([active, queued]);
      expect(failed).toHaveBeenCalledTimes(1);
      await expect(sdk.reset()).rejects.toThrow();
      thread.emit("exit", 1);
      expect(failed).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when posting an operation throws", async () => {
    const { sdk, thread, failed } = await open();
    thread.postMessage.mockImplementation(() => {
      throw new Error("private clone failure");
    });
    await expect(sdk.checkDependenciesAsync()).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    await expect(sdk.reset()).rejects.toThrow();
  });

  it.each([
    {
      name: "wrong operation identity",
      response: { type: "result", id: 2, ok: true, value: { errors: [], warnings: [] } },
    },
    {
      name: "malformed dependencies",
      response: { type: "result", id: 1, ok: true, value: { errors: [], warnings: "private" } },
    },
    { name: "unknown message", response: { type: "private", id: 1 } },
  ])("rejects $name without accepting a late successful answer", async ({ response }) => {
    const { sdk, thread, failed } = await open();
    const pending = expect(sdk.checkDependenciesAsync()).rejects.toThrow();
    thread.emit("message", response);
    await pending;
    thread.emit("message", {
      type: "result",
      id: 1,
      ok: true,
      value: { errors: [], warnings: [] },
    });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    await expect(sdk.checkDependenciesAsync()).rejects.toThrow();
  });

  it("requires both reset acknowledgement and orderly thread exit", async () => {
    const { sdk, thread, failed } = await open();
    const cleanup = sdk.cleanupAfterCommand();
    expect(request(thread)).toMatchObject({ method: "cleanupAfterCommand", args: [] });
    respond(thread);
    await cleanup;
    const resetting = sdk.reset();
    const repeated = sdk.reset();
    let settled = false;
    void resetting.then(() => {
      settled = true;
    });
    expect(request(thread)).toMatchObject({ method: "reset", args: [] });
    await expect(sdk.wrapWithSandboxArgv("late", "/bin/bash")).rejects.toThrow();
    respond(thread);
    await Promise.resolve();
    expect(settled).toBe(false);
    thread.emit("exit", 0);
    await Promise.all([resetting, repeated]);
    expect(settled).toBe(true);
    expect(thread.postMessage.mock.calls.map(([value]) => (value as Request).method)).toEqual([
      "cleanupAfterCommand",
      "reset",
    ]);
    expect(thread.terminate).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    await expect(sdk.wrapWithSandboxArgv("late", "/bin/bash")).rejects.toThrow();
  });

  it.each([
    { name: "missing reset acknowledgement", acknowledge: false, exitCode: 0 },
    { name: "failed thread exit", acknowledge: true, exitCode: 1 },
  ])("does not report reset success after $name", async ({ acknowledge, exitCode }) => {
    const { sdk, thread, failed } = await open();
    const resetting = expect(sdk.reset()).rejects.toThrow();
    if (acknowledge) respond(thread);
    thread.emit("exit", exitCode);
    await resetting;
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
