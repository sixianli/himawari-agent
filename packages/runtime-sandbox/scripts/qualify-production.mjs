// Source integration qualification with controlled test identity and temporary data.
// Existing component probes separately verify the packaged Job Host entry.
import { createServer } from "vite";
if (process.env.HIMAWARI_LIVE_SANDBOX_PROBE !== "1" || process.platform !== "darwin")
  throw new Error("MAC_SANDBOX_PROBE_OPT_IN_REQUIRED");
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { qualifyProductionSandboxMac } = await server.ssrLoadModule(
    "/test/qualification/sandbox-production-mac-probe.ts",
  );
  process.stdout.write(
    `${JSON.stringify(await qualifyProductionSandboxMac(process.argv.includes("--v2")))}\n`,
  );
} finally {
  await server.close();
}
