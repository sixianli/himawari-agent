// Controlled authentication/browser fixture. No model, Worker or production qualification.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const runtime = path.join(repositoryRoot, "dist/node-runtime/node_modules/@himawari-agent");
const {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} = await import(pathToFileURL(path.join(runtime, "persistence-sqlite/dist/index.js")).href);
const {
  initializeStateRoot,
  parseProductConfiguration,
  hashAccountPassword,
  createAccountFactors,
  RestrictedSecretFileSource,
  RestrictedProviderSecretSource,
} = await import(pathToFileURL(path.join(runtime, "platform-node/dist/index.js")).href);
const { createProductionHttpComposition } = await import(
  pathToFileURL(path.join(runtime, "agent-service/dist/production-http-composition.js")).href
);
const root = await mkdtemp(path.join(tmpdir(), "himawari-native-browser-"));
const layout = await initializeStateRoot(root);
const source = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "test/integration/fixtures/file-summary/configuration.json"),
    "utf8",
  ),
);
const port = 4185;
const configuration = parseProductConfiguration(
  {
    ...source,
    publicOrigin: `http://127.0.0.1:${port}`,
    publicMode: false,
    stateRoot: root,
    runtimeDirectory: layout.runtime,
    cacheDirectory: layout.cache,
    memory: { ...source.memory, storagePath: path.join(layout.data, "memory") },
    http: {
      listenHost: "127.0.0.1",
      listenPort: port,
      staticRoot: path.join(repositoryRoot, "apps/control-center/dist"),
      sessionCookieName: "himawari_auth_qa",
      maximumBodyBytes: 262144,
      maximumStaticAssetBytes: 8388608,
      heartbeatMilliseconds: 1000,
    },
    identity: {
      kind: "built-in",
      sessionIdleMilliseconds: 86400000,
      sessionAbsoluteMilliseconds: 604800000,
      recentAuthentication: { maximumAgeMilliseconds: 900000, clockSkewMilliseconds: 30000 },
      csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1800000 },
    },
    secretReferences: [
      ...source.secretReferences.filter(
        (v) => !["payload-encryption", "identity-csrf"].includes(v.purpose),
      ),
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    ],
  },
  new Date().toISOString(),
);
const dbPath = path.join(layout.data, "product.sqlite");
const db = openQualifiedDatabase(dbPath);
applyMigrations(db, await loadBundledMigrations());
db.prepare("INSERT INTO owners VALUES (?, 0)").run(configuration.ownerId);
db.prepare("INSERT INTO agents VALUES (?, ?, 0)").run(configuration.agentId, configuration.ownerId);
db.prepare("INSERT INTO deployments VALUES (?, ?, ?, 1, 'active', 1, 1, NULL)").run(
  configuration.deploymentId,
  configuration.ownerId,
  configuration.agentId,
);
db.close();
const repo = await SqliteProductStateRepository.open({
  stateRoot: root,
  databasePath: dbPath,
  minimumFreeBytes: 0,
});
const key = randomBytes(32);
await writeFile(path.join(root, "payload-kek.v1"), key.toString("hex"), { mode: 0o600 });
await writeFile(path.join(root, "identity-csrf.v1"), randomBytes(32).toString("hex"), {
  mode: 0o600,
});
const composition = await createProductionHttpComposition({
  configuration,
  repository: repo,
  authority: () => ({
    deploymentId: configuration.deploymentId,
    authorityEpoch: 1,
    fencingToken: 1,
  }),
  // Inject only the host-secret boundary in this controlled fixture.
  secretSources: {
    keys: new RestrictedSecretFileSource(root),
    provider: new RestrictedProviderSecretSource(root),
  },
});
const username = "auth-qa";
const password = randomBytes(24).toString("base64url");
const factors = createAccountFactors(username);
const payload = await composition.payloadProtector.protect({
  ownerId: configuration.ownerId,
  agentId: configuration.agentId,
  ref: "identity-factor-browser-qa",
  plaintext: factors.secret,
  dataClassification: "restricted",
  contentType: "application/vnd.himawari.identity-factor",
  createdAt: new Date().toISOString(),
});
await repo.payloadStore(configuration.ownerId, configuration.agentId).put(payload);
await repo.builtInIdentityState(configuration.ownerId, configuration.agentId).provision({
  account: {
    username,
    passwordHash: await hashAccountPassword(password),
    factorPayloadRef: payload.ref,
    recoveryDigests: factors.recoveryDigests,
  },
  expectedRevision: null,
  now: new Date().toISOString(),
});
await writeFile(
  path.join(root, "browser-credentials.json"),
  JSON.stringify({ username, password, otpUri: factors.uri, recoveryCodes: factors.recoveryCodes }),
  { mode: 0o600 },
);
await composition.assertIdentityReady();
console.log(
  JSON.stringify({
    root,
    url: await composition.listen(),
    mode: "controlled-authentication-fixture",
    modelsEnabled: false,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await composition.close();
    await repo.close();
    process.exit(0);
  });
