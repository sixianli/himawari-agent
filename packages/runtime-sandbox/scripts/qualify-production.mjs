// Source integration qualification with controlled test identity and temporary data.
// Existing component probes separately verify the packaged Job Host entry.

import { Console } from "node:console";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createLogger, createServer } from "vite";

const installed = process.env.HIMAWARI_QUALIFY_INSTALLED_RUNTIME
  ? await realpath(process.env.HIMAWARI_QUALIFY_INSTALLED_RUNTIME)
  : null;
const installedRequire = installed ? createRequire(path.join(installed, "package.json")) : null;
const resolvedModules = new Set();

if (
  process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1" ||
  !["darwin", "linux"].includes(process.platform)
)
  throw new Error("SANDBOX_PROBE_OPT_IN_REQUIRED");
const server = await createServer({
  configFile: false,
  // Qualification consumers parse all stdout as JSON, including on a cold cache.
  customLogger: createLogger("info", {
    console: new Console({ stdout: process.stderr, stderr: process.stderr }),
    allowClearScreen: false,
  }),
  server: { middlewareMode: true },
  appType: "custom",
  plugins: installed
    ? [
        {
          name: "qualify-installed-product-modules",
          enforce: "pre",
          resolveId(source, importer) {
            if (
              source.startsWith("@himawari-agent/") &&
              !source.startsWith("@himawari-agent/testing")
            ) {
              const id = installedRequire.resolve(source);
              resolvedModules.add(id);
              return { id, external: true };
            }
            if (source.startsWith(".") && importer) {
              const absolute = path.resolve(path.dirname(importer), source);
              const match = /\/(?:apps|packages)\/([^/]+)\/src\/(.+)$/.exec(absolute);
              if (match && match[1] !== "testing") {
                const id = path.join(
                  installed,
                  "node_modules/@himawari-agent",
                  match[1],
                  "dist",
                  match[2].replace(/\.ts$/, ".js"),
                );
                resolvedModules.add(id);
                return { id, external: true };
              }
            }
          },
        },
      ]
    : [],
});
try {
  const { qualifyProductionSandbox } = await server.ssrLoadModule(
    "/test/qualification/sandbox-production-mac-probe.ts",
  );
  process.stdout.write(
    `${JSON.stringify({ ...(await qualifyProductionSandbox(process.argv.includes("--v2"), process.argv.includes("--revoke-network"))), installedRuntime: installed, installedModules: [...resolvedModules].sort() })}\n`,
  );
} finally {
  await server.close();
}
