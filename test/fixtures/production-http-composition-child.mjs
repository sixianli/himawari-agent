import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing child environment value: ${name}`);
  return value;
}

async function runtimePackage(runtimeRoot, packageName) {
  return import(
    pathToFileURL(
      path.join(runtimeRoot, "node_modules", ...packageName.split("/"), "dist", "index.js"),
    ).href
  );
}

const runtimeRoot = required("HIMAWARI_TEST_RUNTIME_ROOT");
const configurationPath = required("HIMAWARI_TEST_CONFIGURATION");
const stateRoot = required("HIMAWARI_TEST_STATE_ROOT");
const databasePath = required("HIMAWARI_TEST_DATABASE");
const staticRoot = required("HIMAWARI_TEST_STATIC_ROOT");
const secretDirectory = required("HIMAWARI_TEST_SECRET_DIRECTORY");
const authority = JSON.parse(required("HIMAWARI_TEST_AUTHORITY"));

try {
  const [agentService, persistence, platform] = await Promise.all([
    runtimePackage(runtimeRoot, "@himawari-agent/agent-service"),
    runtimePackage(runtimeRoot, "@himawari-agent/persistence-sqlite"),
    runtimePackage(runtimeRoot, "@himawari-agent/platform-node"),
  ]);
  const configuration = platform.parseProductConfiguration(
    JSON.parse(await readFile(configurationPath, "utf8")),
    new Date().toISOString(),
  );
  if (
    configuration.stateRoot !== stateRoot ||
    configuration.http?.staticRoot !== staticRoot ||
    configuration.publicMode !== true
  ) {
    throw new Error("Child configuration did not retain the expected production paths");
  }

  const repository = await persistence.SqliteProductStateRepository.open({
    stateRoot,
    databasePath,
    minimumFreeBytes: 0,
    now: () => new Date().toISOString(),
  });
  const provider = new platform.RestrictedProviderSecretSource(secretDirectory);
  const keys = new platform.RestrictedSecretFileSource(secretDirectory);
  const composition = await agentService.createProductionHttpComposition({
    configuration,
    repository,
    authority: () => authority,
    secretSources: { provider, keys },
  });
  let closing = false;
  const close = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    try {
      await composition.close();
      await repository.close();
    } finally {
      process.exitCode = exitCode;
    }
  };
  process.once("SIGTERM", () => {
    void close(0).catch((error) => {
      process.stderr.write(
        `HIMAWARI_PRODUCTION_HTTP_CLOSE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    void close(0).catch((error) => {
      process.stderr.write(
        `HIMAWARI_PRODUCTION_HTTP_CLOSE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
  });
  const address = await composition.listen();
  process.stdout.write(`HIMAWARI_PRODUCTION_HTTP_READY ${JSON.stringify({ address })}\n`);
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(
    `HIMAWARI_PRODUCTION_HTTP_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
