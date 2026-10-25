import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const classifications = new Set(["public", "private", "sensitive", "restricted"]);
const evidenceFields = new Set([
  "status",
  "responseType",
  "threadId",
  "runId",
  "revision",
  "displayPhase",
  "reasonCode",
  "approvalRequestId",
  "replayed",
  "approvedCount",
  "command",
]);

export class ProbeHttpError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ProbeHttpError";
    this.code = code;
    this.details = Object.freeze({ ...details });
    if (Number.isInteger(details.status)) this.status = details.status;
  }
}

function fail(code, details) {
  throw new ProbeHttpError(code, details);
}

function record(evidence, operation, fields = {}) {
  const retained = { operation, at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (evidenceFields.has(key) && ["string", "number", "boolean"].includes(typeof value))
      retained[key] = value;
  }
  const entry = Object.freeze(retained);
  if (Array.isArray(evidence)) evidence.push(entry);
  else if (typeof evidence === "function") evidence(entry);
}

function duration(value) {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) fail("PROBE_TIMEOUT_INVALID");
  return value;
}

function localOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    fail("PROBE_ORIGIN_INVALID");
  }
  if (
    origin.origin !== value ||
    origin.protocol !== "http:" ||
    origin.username ||
    origin.password ||
    !["127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    fail("PROBE_ORIGIN_INVALID");
  return origin;
}

function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value)
    fail("PROBE_PATH_INVALID");
  return value;
}

function within(root, filename) {
  absolute(filename);
  const relative = path.relative(root, filename);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    fail("PROBE_PATH_OUTSIDE_TEMPORARY_ROOT");
  return filename;
}

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  )
    fail("PROBE_PRIVATE_DIRECTORY_UNSAFE");
}

async function temporaryDirectory(root) {
  absolute(root);
  if (typeof process.getuid !== "function" || process.getuid() === 0)
    fail("PROBE_ORDINARY_ACCOUNT_REQUIRED");
  if (!/^\/tmp\/h[A-Za-z0-9]{4}$/.test(root)) fail("PROBE_TEMPORARY_ROOT_INVALID");
  await privateDirectory(root);
}

async function privateJson(filename, root, maximumBytes = 65_536) {
  within(root, filename);
  await privateDirectory(path.dirname(filename));
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > maximumBytes
    )
      fail("PROBE_PRIVATE_FILE_UNSAFE");
    try {
      return JSON.parse(await file.readFile("utf8"));
    } catch {
      fail("PROBE_PRIVATE_JSON_INVALID");
    }
  } finally {
    await file.close();
  }
}

async function createPrivateJson(filename, root, value) {
  within(root, filename);
  await privateDirectory(path.dirname(filename));
  const file = await open(
    filename,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

function safeMachineCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : fallback;
}

async function cliJson({
  cli,
  arguments_,
  temporaryRoot,
  environment,
  timeout,
  evidence,
  command,
}) {
  let output;
  try {
    output = await execFile(absolute(cli), arguments_, {
      cwd: temporaryRoot,
      env: { ...environment, NODE_OPTIONS: "", NODE_PATH: "", TMPDIR: temporaryRoot },
      timeout: duration(timeout),
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    let code = "PROBE_CLI_FAILED";
    try {
      code = safeMachineCode(JSON.parse(error.stderr).error?.code, code);
    } catch {}
    record(evidence, "cli", { command, reasonCode: code });
    fail(code, { command, exitCode: Number.isInteger(error.code) ? error.code : null });
  }
  let value;
  try {
    value = JSON.parse(output.stdout);
  } catch {
    fail("PROBE_CLI_JSON_INVALID", { command });
  }
  if (!value || value.schemaVersion !== 1 || value.command !== command)
    fail("PROBE_CLI_CONTRACT_INVALID", { command });
  record(evidence, "cli", { command, status: "accepted" });
  return value;
}

export function buildProbeIdentityConfiguration({ configuration, origin, identityPolicy }) {
  const address = localOrigin(origin);
  const policy =
    identityPolicy ?? (configuration.identity?.kind === "built-in" ? configuration.identity : null);
  if (!policy || !configuration.http) fail("PROBE_IDENTITY_POLICY_REQUIRED");
  const candidate = structuredClone(configuration);
  candidate.publicOrigin = origin;
  candidate.publicMode = false;
  candidate.http.listenHost = address.hostname === "[::1]" ? "::1" : "127.0.0.1";
  candidate.http.listenPort = Number(address.port || "80");
  candidate.identity = {
    kind: "built-in",
    sessionIdleMilliseconds: policy.sessionIdleMilliseconds,
    sessionAbsoluteMilliseconds: policy.sessionAbsoluteMilliseconds,
    recentAuthentication: structuredClone(policy.recentAuthentication),
    csrf: structuredClone(policy.csrf),
  };
  return candidate;
}

export async function writeProbeConfiguration({
  temporaryRoot,
  configurationPath,
  configuration,
  origin,
  identityPolicy,
}) {
  await temporaryDirectory(temporaryRoot);
  const candidate = buildProbeIdentityConfiguration({ configuration, origin, identityPolicy });
  within(temporaryRoot, candidate.stateRoot);
  await createPrivateJson(configurationPath, temporaryRoot, candidate);
  return configurationPath;
}

export async function initializeProbeAccount({
  cli,
  runtimeRoot,
  configurationPath,
  stateRoot,
  secretDirectory,
  temporaryRoot,
  environment,
  username = `probe-${randomUUID()}`,
  password: supplied,
  commandTimeoutMs,
  evidence,
}) {
  await temporaryDirectory(temporaryRoot);
  absolute(runtimeRoot);
  within(temporaryRoot, stateRoot);
  within(temporaryRoot, secretDirectory);
  await privateDirectory(secretDirectory);
  const configuration = await privateJson(configurationPath, temporaryRoot);
  if (
    configuration.stateRoot !== stateRoot ||
    configuration.identity?.kind !== "built-in" ||
    configuration.publicMode !== false
  )
    fail("PROBE_CONFIGURATION_SCOPE_INVALID");
  localOrigin(configuration.publicOrigin);
  const initialized = await cliJson({
    cli,
    arguments_: ["init", "--config", configurationPath],
    temporaryRoot,
    environment,
    timeout: commandTimeoutMs,
    evidence,
    command: "init",
  });
  if (
    initialized.stateRoot !== stateRoot ||
    initialized.ownerId !== configuration.ownerId ||
    initialized.agentId !== configuration.agentId ||
    initialized.accountReady !== false ||
    initialized.configurationPath !== path.join(stateRoot, "configuration.json")
  )
    fail("PROBE_INITIALIZATION_CONTRACT_INVALID");
  const accountDirectory = path.join(temporaryRoot, `auth-${randomUUID()}`);
  await mkdir(accountDirectory, { mode: 0o700 });
  const inputPath = path.join(accountDirectory, "input.json");
  const enrollmentPath = path.join(accountDirectory, "enrollment.json");
  let password = supplied ?? randomBytes(32).toString("base64url");
  await createPrivateJson(inputPath, temporaryRoot, { username, password });
  let created;
  try {
    created = await cliJson({
      cli,
      arguments_: [
        "account",
        "create",
        "--config",
        initialized.configurationPath,
        "--input",
        inputPath,
        "--output",
        enrollmentPath,
        "--secret-dir",
        secretDirectory,
      ],
      temporaryRoot,
      environment,
      timeout: commandTimeoutMs,
      evidence,
      command: "account.create",
    });
  } finally {
    await unlink(inputPath);
  }
  if (
    created.ownerId !== initialized.ownerId ||
    created.enrollmentFile !== enrollmentPath ||
    created.previousSessionsRevoked !== false
  )
    fail("PROBE_ACCOUNT_CONTRACT_INVALID");
  const normalizedUsername = String(username).trim().toLowerCase();
  return Object.freeze({
    configurationPath: initialized.configurationPath,
    enrollmentPath,
    username: normalizedUsername,
    async login(client, deviceLabel = "R2-L6 standalone probe") {
      if (!password) fail("PROBE_ACCOUNT_CREDENTIALS_CLEARED");
      return client.login({
        username: normalizedUsername,
        password,
        enrollmentPath,
        temporaryRoot,
        deviceLabel,
      });
    },
    clearCredentials() {
      password = "";
    },
  });
}

export async function createProbeHttpClient({
  runtimeRoot,
  origin,
  requestTimeoutMs,
  evidence,
  sessionCookieName,
  signal,
}) {
  const address = localOrigin(origin);
  const timeout = duration(requestTimeoutMs);
  absolute(runtimeRoot);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sessionCookieName ?? ""))
    fail("PROBE_SESSION_COOKIE_NAME_REQUIRED");
  const contractsPath = path.join(
    runtimeRoot,
    "node_modules",
    "@himawari-agent",
    "gateway-contracts",
    "dist",
    "index.js",
  );
  let contracts;
  let otp;
  try {
    contracts = await import(pathToFileURL(contractsPath).href);
    const requireInstalled = createRequire(
      path.join(runtimeRoot, "node_modules", "@himawari-agent", "platform-node", "package.json"),
    );
    otp = requireInstalled("otpauth");
  } catch {
    fail("PROBE_INSTALLED_DEPENDENCY_UNAVAILABLE");
  }
  if (
    !contracts.threadGatewayMessageSchema?.parse ||
    !contracts.gatewayV2MessageSchema?.parse ||
    !otp.URI?.parse
  )
    fail("PROBE_INSTALLED_DEPENDENCY_CONTRACT_INVALID");
  const cookies = new Map();
  const ownThreads = new Set();
  const ownRuns = new Map();
  const pendingApprovalKeys = new Map();
  let configuration;

  async function request(
    method,
    pathname,
    body,
    { csrf = false, idempotencyKey, expectedStatus = 200 } = {},
  ) {
    if (!pathname.startsWith("/api/") || pathname.includes("?") || pathname.includes("#"))
      fail("PROBE_HTTP_PATH_INVALID");
    if (signal?.aborted) fail("PROBE_HTTP_ABORTED");
    if (csrf && !configuration?.csrfToken) fail("PROBE_AUTHENTICATION_REQUIRED");
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: address.host, accept: "application/json" };
    if (method === "POST") {
      headers.origin = origin;
      headers["sec-fetch-site"] = "same-origin";
      headers["content-type"] = "application/json";
      headers["content-length"] = String(data?.length ?? 0);
    }
    if (cookies.size)
      headers.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (csrf) headers["x-csrf-token"] = configuration.csrfToken;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          protocol: "http:",
          hostname: address.hostname === "[::1]" ? "::1" : address.hostname,
          port: address.port || "80",
          path: pathname,
          method,
          headers,
          agent: false,
          signal,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              req.destroy(new ProbeHttpError("PROBE_HTTP_RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          res.once("error", () => reject(new ProbeHttpError("PROBE_HTTP_RESPONSE_FAILED")));
          res.once("end", () =>
            resolve({
              status: res.statusCode,
              setCookies: res.headers["set-cookie"] ?? [],
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new ProbeHttpError("PROBE_HTTP_TIMEOUT")),
        timeout,
      );
      req.once("close", () => clearTimeout(timer));
      req.once("error", (error) =>
        reject(
          error instanceof ProbeHttpError
            ? error
            : new ProbeHttpError(
                signal?.aborted ? "PROBE_HTTP_ABORTED" : "PROBE_HTTP_CONNECTION_FAILED",
              ),
        ),
      );
      req.end(data);
    });
    let value;
    try {
      value = JSON.parse(response.body);
    } catch {
      fail("PROBE_HTTP_JSON_INVALID", { status: response.status });
    }
    if (response.status !== expectedStatus) {
      const code = safeMachineCode(value?.error?.code ?? value?.error, "PROBE_HTTP_REJECTED");
      record(evidence, pathname, { status: response.status, reasonCode: code });
      fail(code, { status: response.status });
    }
    for (const header of response.setCookies) {
      const first = header.split(";", 1)[0];
      const equals = first.indexOf("=");
      const name = first.slice(0, equals);
      const value = first.slice(equals + 1);
      if (![sessionCookieName, `${sessionCookieName}_challenge`].includes(name))
        fail("PROBE_HTTP_COOKIE_UNEXPECTED");
      if (!value) cookies.delete(name);
      else cookies.set(name, value);
    }
    record(evidence, pathname, { status: response.status });
    return value;
  }

  function publicConfiguration() {
    return Object.freeze({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      deploymentId: configuration.deploymentId,
      authorityEpoch: configuration.authorityEpoch,
      fencingToken: configuration.fencingToken,
      actorId: configuration.actorId,
      sessionId: configuration.sessionId,
      installedGatewayV2Operations: [...configuration.installedGatewayV2Operations],
      executionStateAvailable: configuration.executionStateAvailable,
      canCancelRun: configuration.canCancelRun,
    });
  }

  async function refreshConfiguration() {
    const fresh = await request("GET", "/api/control-center/v1/config");
    for (const key of ["ownerId", "agentId", "deploymentId", "actorId", "sessionId", "csrfToken"])
      if (typeof fresh?.[key] !== "string" || !fresh[key]) fail("PROBE_HTTP_CONFIGURATION_INVALID");
    for (const key of ["authorityEpoch", "fencingToken"])
      if (!Number.isInteger(fresh[key]) || fresh[key] < 1) fail("PROBE_HTTP_CONFIGURATION_INVALID");
    if (!Array.isArray(fresh.installedGatewayV2Operations))
      fail("PROBE_HTTP_CONFIGURATION_INVALID");
    if (configuration) {
      for (const key of ["ownerId", "agentId", "deploymentId", "actorId", "sessionId"])
        if (fresh[key] !== configuration[key]) fail("PROBE_AUTHENTICATION_SCOPE_CHANGED");
    }
    configuration = fresh;
    return publicConfiguration();
  }

  function base(kind, type, schemaVersion) {
    if (!configuration) fail("PROBE_AUTHENTICATION_REQUIRED");
    return {
      schemaVersion,
      kind,
      type,
      messageId: `message:${randomUUID()}`,
      correlationId: `correlation:${randomUUID()}`,
      causationId: null,
      scope: { ownerId: configuration.ownerId, agentId: configuration.agentId },
      authority: {
        deploymentId: configuration.deploymentId,
        authorityEpoch: configuration.authorityEpoch,
        fencingToken: configuration.fencingToken,
      },
      actor: { actorType: "owner", actorId: configuration.actorId },
    };
  }

  async function threadMessage(kind, type, payload) {
    const command = kind === "command";
    let message;
    try {
      message = contracts.threadGatewayMessageSchema.parse({
        ...base(kind, type, "gateway.thread.v3"),
        ...(command ? { idempotencyKey: `idempotency:${randomUUID()}` } : {}),
        payload,
      });
    } catch (error) {
      if (error instanceof ProbeHttpError) throw error;
      fail("PROBE_THREAD_REQUEST_CONTRACT_INVALID");
    }
    const value = await request(
      "POST",
      `/api/gateway/thread/v3/${command ? "commands" : "queries"}`,
      message,
      { csrf: command, idempotencyKey: message.idempotencyKey },
    );
    let response;
    try {
      response = contracts.threadGatewayMessageSchema.parse(value);
    } catch {
      fail("PROBE_THREAD_RESPONSE_CONTRACT_INVALID");
    }
    if (response.kind === "conflict") fail("PROBE_THREAD_REVISION_CONFLICT");
    if (response.kind !== (command ? "result" : "snapshot"))
      fail("PROBE_THREAD_RESPONSE_KIND_INVALID");
    if (
      response.scope.ownerId !== configuration.ownerId ||
      response.scope.agentId !== configuration.agentId
    )
      fail("PROBE_THREAD_RESPONSE_SCOPE_CHANGED");
    if (
      command &&
      (response.type !== "thread.command_result" ||
        response.payload.commandType !== type ||
        response.causationId !== message.messageId ||
        response.correlationId !== message.correlationId ||
        response.payload.threadId !== payload.threadId ||
        response.payload.resultRef !== payload.resultRef)
    )
      fail("PROBE_THREAD_COMMAND_RECEIPT_INVALID");
    record(evidence, type, {
      responseType: response.type,
      threadId: payload.threadId,
      runId: payload.runId,
    });
    return response;
  }

  async function queryV2(type, payload) {
    if (!["approval.list", "approval.detail"].includes(type)) fail("PROBE_V2_QUERY_NOT_ALLOWED");
    if (!configuration?.installedGatewayV2Operations.includes(type))
      fail("PROBE_V2_OPERATION_UNAVAILABLE");
    let message;
    try {
      message = contracts.gatewayV2MessageSchema.parse({
        ...base("query", type, "gateway.v2"),
        dataClassification: "private",
        risk: "low",
        authorizationRef: null,
        payload,
      });
    } catch (error) {
      if (error instanceof ProbeHttpError) throw error;
      fail("PROBE_V2_REQUEST_CONTRACT_INVALID");
    }
    const value = await request("POST", "/api/gateway/v2/queries", message);
    let response;
    try {
      response = contracts.gatewayV2MessageSchema.parse(value);
    } catch {
      fail("PROBE_V2_RESPONSE_CONTRACT_INVALID");
    }
    if (
      response.kind !== "snapshot" ||
      response.scope.ownerId !== configuration.ownerId ||
      response.scope.agentId !== configuration.agentId
    )
      fail("PROBE_V2_RESPONSE_SCOPE_CHANGED");
    return response;
  }

  function requireThread(threadId) {
    if (!ownThreads.has(threadId)) fail("PROBE_THREAD_NOT_OWNED");
  }

  function requireRun(runId) {
    const threadId = ownRuns.get(runId);
    if (!threadId) fail("PROBE_RUN_NOT_OWNED");
    return threadId;
  }

  async function protectText(content, dataClassification = "private") {
    if (
      typeof content !== "string" ||
      !content.length ||
      content.length > 65_536 ||
      !classifications.has(dataClassification)
    )
      fail("PROBE_PROTECTED_TEXT_INVALID");
    const value = await request(
      "POST",
      "/api/payload/v1/text",
      { content, dataClassification },
      { csrf: true, idempotencyKey: `payload:${randomUUID()}`, expectedStatus: 201 },
    );
    if (typeof value?.payloadRef !== "string" || !value.payloadRef)
      fail("PROBE_PROTECTED_TEXT_RESPONSE_INVALID");
    return value.payloadRef;
  }

  async function threadDetail(threadId) {
    requireThread(threadId);
    const response = await threadMessage("query", "thread.detail", {
      threadId,
      afterSequence: 0,
      limit: 100,
    });
    if (response.type !== "thread.detail_snapshot" || response.payload.thread.threadId !== threadId)
      fail("PROBE_THREAD_DETAIL_INVALID");
    return response;
  }

  async function executionState(runId) {
    const threadId = requireRun(runId);
    const response = await threadMessage("query", "thread.execution_state", { threadId, runId });
    if (
      response.type !== "thread.execution_state_snapshot" ||
      response.payload.threadId !== threadId ||
      response.payload.runId !== runId
    )
      fail("PROBE_EXECUTION_STATE_INVALID");
    record(evidence, "execution.state", {
      threadId,
      runId,
      revision: response.payload.state.runRevision,
      displayPhase: response.payload.state.displayPhase,
      reasonCode: response.payload.state.reasonCode,
    });
    return response;
  }

  async function approvePendingRun(runId) {
    const threadId = requireRun(runId);
    await refreshConfiguration();
    const pending = [];
    const seen = new Set();
    let afterCursor = null;
    do {
      const page = await queryV2("approval.list", { status: "pending", afterCursor, limit: 100 });
      if (page.type !== "collection.snapshot" || page.payload.category !== "approvals")
        fail("PROBE_APPROVAL_LIST_INVALID");
      for (const approvalRequestId of page.payload.itemRefs) {
        const snapshot = await queryV2("approval.detail", { approvalRequestId });
        if (
          snapshot.type !== "approval.snapshot" ||
          snapshot.payload.approvalRequestId !== approvalRequestId
        )
          fail("PROBE_APPROVAL_DETAIL_INVALID");
        const approval = snapshot.payload;
        if (approval.status === "pending" && approval.intent.runId === runId) {
          if (approval.intent.threadId !== threadId) fail("PROBE_APPROVAL_THREAD_CHANGED");
          pending.push(snapshot);
        }
      }
      afterCursor = page.payload.nextCursor;
      if (afterCursor && seen.has(afterCursor)) fail("PROBE_APPROVAL_CURSOR_REPEATED");
      if (afterCursor) seen.add(afterCursor);
    } while (afterCursor);
    const approved = [];
    for (const snapshot of pending) {
      const approval = snapshot.payload;
      if (!configuration.installedGatewayV2Operations.includes("approval.respond"))
        fail("PROBE_V2_OPERATION_UNAVAILABLE");
      if (!configuration.authorizationRef) fail("PROBE_APPROVAL_AUTHORIZATION_REQUIRED");
      if (approval.recentAuthenticationRequired && !configuration.recentAuthenticationRef)
        fail("PROBE_APPROVAL_RECENT_AUTHENTICATION_REQUIRED");
      const operationKey =
        `approval.approve:${approval.approvalRequestId}:${approval.revision}`.slice(0, 128);
      const idempotencyKey = pendingApprovalKeys.get(operationKey) ?? `governance:${randomUUID()}`;
      pendingApprovalKeys.set(operationKey, idempotencyKey);
      let message;
      try {
        message = contracts.gatewayV2MessageSchema.parse({
          ...base("command", "approval.respond", "gateway.v2"),
          dataClassification: "private",
          risk: approval.finalRisk,
          authorizationRef: configuration.authorizationRef,
          idempotencyKey,
          payload: {
            approvalRequestId: approval.approvalRequestId,
            expectedRevision: approval.revision,
            decision: "approved",
            semanticSnapshotHash: approval.semanticSnapshotHash,
            editedPayloadRef: null,
            recentAuthenticationRef: approval.recentAuthenticationRequired
              ? configuration.recentAuthenticationRef
              : null,
          },
        });
      } catch (error) {
        if (error instanceof ProbeHttpError) throw error;
        fail("PROBE_APPROVAL_COMMAND_CONTRACT_INVALID");
      }
      let result;
      try {
        result = await request("POST", "/api/gateway/v2/commands", message, {
          csrf: true,
          idempotencyKey,
        });
      } catch (error) {
        if (error.status === 409) pendingApprovalKeys.delete(operationKey);
        throw error;
      }
      if (typeof result?.resultRef !== "string" || typeof result?.replayed !== "boolean")
        fail("PROBE_APPROVAL_RESPONSE_INVALID");
      pendingApprovalKeys.delete(operationKey);
      const readback = await queryV2("approval.detail", {
        approvalRequestId: approval.approvalRequestId,
      });
      if (
        readback.type !== "approval.snapshot" ||
        readback.payload.status !== "approved" ||
        readback.payload.approvalRequestId !== approval.approvalRequestId ||
        readback.payload.intent.runId !== runId ||
        readback.payload.intent.threadId !== threadId ||
        readback.payload.semanticSnapshotHash !== approval.semanticSnapshotHash
      )
        fail("PROBE_APPROVAL_READBACK_INVALID");
      const retained = Object.freeze({
        approvalRequestId: approval.approvalRequestId,
        revision: readback.payload.revision,
        runId,
        status: readback.payload.status,
        replayed: result.replayed,
      });
      approved.push(retained);
      record(evidence, "approval.respond", retained);
    }
    record(evidence, "approval.pending_run", { runId, approvedCount: approved.length });
    return Object.freeze(approved);
  }

  return Object.freeze({
    async login({ username, password, enrollmentPath, temporaryRoot, deviceLabel }) {
      await temporaryDirectory(temporaryRoot);
      const enrollment = await privateJson(enrollmentPath, temporaryRoot);
      if (enrollment.username !== username || typeof enrollment.otpUri !== "string")
        fail("PROBE_ENROLLMENT_INVALID");
      const challenge = await request(
        "POST",
        "/api/identity/v1/password",
        { username, password, deviceLabel },
        { expectedStatus: 202 },
      );
      if (challenge?.step !== "second-factor" || !cookies.has(`${sessionCookieName}_challenge`))
        fail("PROBE_AUTHENTICATION_CHALLENGE_INVALID");
      let code;
      try {
        code = otp.URI.parse(enrollment.otpUri).generate({ timestamp: Date.now() });
      } catch {
        fail("PROBE_ENROLLMENT_TOTP_INVALID");
      }
      const verified = await request(
        "POST",
        "/api/identity/v1/verify",
        { code },
        { expectedStatus: 201 },
      );
      if (verified?.authenticated !== true || !cookies.has(sessionCookieName))
        fail("PROBE_AUTHENTICATION_RESPONSE_INVALID");
      return refreshConfiguration();
    },
    refreshConfiguration,
    protectText,
    threadDetail,
    executionState,
    approvePendingRun,
    async createThread({ answerLocale = "zh-CN" } = {}) {
      const threadId = `thread:${randomUUID()}`;
      const resultRef = await protectText("R2-L6 thread creation");
      const response = await threadMessage("command", "thread.create", {
        threadId,
        answerLocale,
        resultRef,
      });
      ownThreads.add(threadId);
      const detail = await threadDetail(threadId);
      return Object.freeze({
        threadId,
        revision: detail.payload.thread.revision,
        response,
        detail,
      });
    },
    async submitRun({
      threadId,
      content,
      dataClassification = "private",
      modelRef,
      thinkingLevel,
    }) {
      requireThread(threadId);
      if ((modelRef === undefined) !== (thinkingLevel === undefined))
        fail("PROBE_MODEL_SELECTION_INVALID");
      const detail = await threadDetail(threadId);
      const runId = `run:${randomUUID()}`;
      const payload = {
        threadId,
        expectedRevision: detail.payload.thread.revision,
        messageId: `message:${randomUUID()}`,
        turnId: `turn:${randomUUID()}`,
        runId,
        sessionId: configuration.sessionId,
        contentRef: await protectText(content, dataClassification),
        sourceProofRef: `http-probe:${configuration.actorId}`.slice(0, 128),
        dataClassification,
        occurredAt: new Date().toISOString(),
        resultRef: await protectText("R2-L6 root Run submission"),
      };
      const response = await threadMessage(
        "command",
        modelRef === undefined ? "thread.message.submit" : "thread.message.submit_configured",
        modelRef === undefined ? payload : { ...payload, modelRef, thinkingLevel },
      );
      ownRuns.set(runId, threadId);
      record(evidence, "run.submit", { threadId, runId });
      return Object.freeze({ threadId, runId, response });
    },
    async cancelRun(runId) {
      const threadId = requireRun(runId);
      const snapshot = await executionState(runId);
      const resultRef = await protectText("R2-L6 owner requested stop");
      const response = await threadMessage("command", "thread.run.cancel", {
        threadId,
        runId,
        expectedRunRevision: snapshot.payload.state.runRevision,
        resultRef,
      });
      return Object.freeze({ threadId, runId, response });
    },
    async executionDetail(runId, { afterSequence = 0, limit = 100 } = {}) {
      const threadId = requireRun(runId);
      const response = await threadMessage("query", "thread.execution", {
        threadId,
        runId,
        afterSequence,
        limit,
      });
      if (
        response.type !== "thread.execution_snapshot" ||
        response.payload.threadId !== threadId ||
        response.payload.runId !== runId
      )
        fail("PROBE_EXECUTION_DETAIL_INVALID");
      return response;
    },
    clearSession() {
      cookies.clear();
      configuration = undefined;
      pendingApprovalKeys.clear();
    },
  });
}
