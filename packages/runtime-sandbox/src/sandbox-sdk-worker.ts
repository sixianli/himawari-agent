import { parentPort } from "node:worker_threads";
import { sandboxSdkFailure, type SandboxSdkRequest } from "./sandbox-sdk.ts";

if (!parentPort) throw sandboxSdkFailure(undefined);
const port = parentPort;
try {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  let nextId = 1;
  let active = false;
  const execute = async (request: SandboxSdkRequest) => {
    try {
      let value: unknown;
      switch (request.method) {
        case "checkDependenciesAsync":
          value = await SandboxManager.checkDependenciesAsync();
          break;
        case "initialize":
          await SandboxManager.initialize(request.args[0], undefined, false);
          break;
        case "wrapWithSandboxArgv": {
          const launch = await SandboxManager.wrapWithSandboxArgv(...request.args);
          value = { argv: launch.argv, env: { ...launch.env } };
          break;
        }
        case "cleanupAfterCommand":
          SandboxManager.cleanupAfterCommand();
          break;
        case "reset":
          await SandboxManager.reset();
          break;
      }
      port.postMessage({ type: "result", id: request.id, ok: true, value });
      if (request.method === "reset") port.close();
    } catch (error) {
      const failure = sandboxSdkFailure(error);
      port.postMessage({
        type: "result",
        id: request.id,
        ok: false,
        error: { code: failure.code, message: failure.message },
      });
    } finally {
      active = false;
    }
  };
  port.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw sandboxSdkFailure(undefined);
    const request = value as SandboxSdkRequest;
    const argumentCount =
      request.method === "initialize"
        ? 1
        : request.method === "wrapWithSandboxArgv"
          ? 2
          : ["checkDependenciesAsync", "cleanupAfterCommand", "reset"].includes(request.method)
            ? 0
            : -1;
    if (
      active ||
      request.id !== nextId ||
      !Array.isArray(request.args) ||
      request.args.length !== argumentCount
    )
      throw sandboxSdkFailure(undefined);
    nextId++;
    active = true;
    void execute(request);
  });
  port.postMessage({ type: "ready", supported: SandboxManager.isSupportedPlatform() });
} catch (error) {
  const failure = sandboxSdkFailure(error);
  port.postMessage({
    type: "initialization_failed",
    error: { code: failure.code, message: failure.message },
  });
  process.exitCode = 1;
  port.close();
}
