import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteProductStateRepository } from "@himawari-agent/persistence-sqlite";
import {
  createAccountFactors,
  EnvelopePayloadProtector,
  hashAccountPassword,
  JsonFileConfigurationPort,
  MacOsKeychainSecretSource,
  normalizeAccountUsername,
  readAuthorityFile,
  RestrictedSecretFileSource,
} from "@himawari-agent/platform-node";

const invalid = () => new Error("ADMIN_ACCOUNT_INPUT_INVALID");

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw invalid();
}

/** Credentials and enrolment material travel through private files, never argv or diagnostics. */
export async function runAccountCommand(arguments_: readonly string[]): Promise<unknown> {
  const action = arguments_[1];
  if (action !== "create" && action !== "recover") throw invalid();
  const values = new Map<string, string>();
  for (let index = 2; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !key ||
      !value ||
      !["--config", "--input", "--output", "--secret-dir", "--confirm"].includes(key) ||
      values.has(key)
    )
      throw invalid();
    values.set(key, value);
  }
  const configPath = values.get("--config");
  const inputPath = values.get("--input");
  const outputPath = values.get("--output");
  if (
    !configPath ||
    !inputPath ||
    !outputPath ||
    !path.isAbsolute(inputPath) ||
    !path.isAbsolute(outputPath) ||
    inputPath === outputPath
  )
    throw invalid();
  const configuration = await new JsonFileConfigurationPort(configPath).load();
  if (configuration.identity?.kind !== "built-in") throw invalid();
  if (
    action === "recover" &&
    values.get("--confirm") !== `RECOVER_ACCOUNT_${configuration.ownerId}`
  )
    throw new Error("ADMIN_CONFIRMATION_REQUIRED");
  const layout = {
    root: configuration.stateRoot,
    data: path.join(configuration.stateRoot, "data"),
    runtime: configuration.runtimeDirectory,
    cache: configuration.cacheDirectory,
    payloadCiphertext: path.join(configuration.stateRoot, "data", "payload-ciphertext"),
    authorityFile: path.join(configuration.stateRoot, "authority.json"),
    agentServiceBootBindingFile: path.join(
      configuration.runtimeDirectory,
      "agent-service.boot.json",
    ),
  };
  const authority = await readAuthorityFile(layout);
  if (
    authority.id !== configuration.deploymentId ||
    authority.ownerId !== configuration.ownerId ||
    authority.agentId !== configuration.agentId ||
    authority.status !== "active"
  )
    throw invalid();
  await assertPrivateDirectory(path.dirname(inputPath));
  await assertPrivateDirectory(path.dirname(outputPath));
  const input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credentials: { username: string; password: string };
  try {
    const info = await input.stat();
    if (
      !info.isFile() ||
      info.size > 4096 ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw invalid();
    const parsed: unknown = JSON.parse(await input.readFile("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => !["username", "password"].includes(key)) ||
      !("username" in parsed) ||
      typeof parsed.username !== "string" ||
      !("password" in parsed) ||
      typeof parsed.password !== "string"
    )
      throw invalid();
    credentials = {
      username: normalizeAccountUsername(parsed.username),
      password: parsed.password,
    };
  } finally {
    await input.close();
  }
  const secretDirectory = values.get("--secret-dir");
  const keys = secretDirectory
    ? new RestrictedSecretFileSource(secretDirectory)
    : process.platform === "darwin"
      ? new MacOsKeychainSecretSource({
          servicePrefix: "himawari-payload",
          account: "himawari-agent",
        })
      : undefined;
  const key = configuration.secretReferences.filter(
    (entry) => entry.purpose === "payload-encryption",
  );
  if (!keys || key.length !== 1 || !key[0]) throw invalid();
  const protector = new EnvelopePayloadProtector({
    keys,
    activeKey: { keyRef: key[0].ref, kekVersion: key[0].version, dekVersion: "dek-v1" },
  });
  // Opening the repository obtains the same exclusive state-root lock as the service.
  const repo = await SqliteProductStateRepository.open({
    stateRoot: configuration.stateRoot,
    databasePath: path.join(configuration.stateRoot, "data", "product.sqlite"),
  });
  try {
    const state = repo.builtInIdentityState(configuration.ownerId, configuration.agentId);
    const previous = await state.readAccount();
    if ((action === "create" && previous) || (action === "recover" && !previous)) throw invalid();
    const persistedAuthority = await repo
      .deploymentAuthorityPort()
      .read(configuration.deploymentId);
    if (
      !persistedAuthority ||
      persistedAuthority.status !== "active" ||
      persistedAuthority.authorityEpoch !== authority.authorityEpoch ||
      persistedAuthority.fencingToken !== authority.fencingToken
    )
      throw invalid();
    const passwordHash = await hashAccountPassword(credentials.password);
    credentials.password = "";
    const factors = createAccountFactors(credentials.username);
    const now = new Date().toISOString();
    const payload = await protector.protect({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      ref: `identity-factor-${randomUUID()}`,
      plaintext: factors.secret,
      dataClassification: "restricted",
      contentType: "application/vnd.himawari.identity-factor",
      createdAt: now,
    });
    factors.secret.fill(0);
    const output = await open(
      outputPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await output.writeFile(
        JSON.stringify(
          {
            username: credentials.username,
            otpUri: factors.uri,
            recoveryCodes: factors.recoveryCodes,
          },
          null,
          2,
        ),
      );
      await output.sync();
      await repo.payloadStore(configuration.ownerId, configuration.agentId).put(payload);
      await state.provision({
        account: {
          username: credentials.username,
          passwordHash,
          factorPayloadRef: payload.ref,
          recoveryDigests: factors.recoveryDigests,
        },
        expectedRevision: previous?.revision ?? null,
        now,
      });
    } finally {
      await output.close();
    }
    return {
      schemaVersion: 1,
      command: `account.${action}`,
      ownerId: configuration.ownerId,
      enrollmentFile: outputPath,
      previousSessionsRevoked: Boolean(previous),
    };
  } finally {
    credentials.password = "";
    await repo.close();
  }
}
