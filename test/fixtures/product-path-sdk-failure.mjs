import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(process.argv[1]);
const { SandboxManager } = await import(
  pathToFileURL(require.resolve("@anthropic-ai/sandbox-runtime")).href
);
SandboxManager.initialize = async () => {
  throw Object.assign(new Error("private fixture preparation input"), { code: "EIO" });
};
