import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  CapabilityDescriptor,
  CapabilityInvocationEvent,
  CapabilityInvocationRequest,
  CapabilityManifest,
  CapabilityPort,
  ClockPort,
  PayloadProtectorPort,
  PayloadStorePort,
  SecretPort,
} from "@himawari-agent/application";
import {
  type CapabilityEndpointBinding,
  type CapabilityRuntimeBindingPort,
  type SandboxedProcessIsolationBackend,
  type SandboxedProcessLaunch,
  runSandboxedProcess,
} from "./isolation.js";

export const NODE_CAPABILITY_RUNTIME_ERROR_CODES = Object.freeze({
  CAPABILITY_NOT_ACTIVE: "CAPABILITY_RUNTIME_NOT_ACTIVE",
  CAPABILITY_OPERATION_UNSUPPORTED: "CAPABILITY_RUNTIME_OPERATION_UNSUPPORTED",
  CAPABILITY_INPUT_MISSING: "CAPABILITY_RUNTIME_INPUT_MISSING",
  CAPABILITY_INPUT_INVALID: "CAPABILITY_RUNTIME_INPUT_INVALID",
  CAPABILITY_SECRET_INVALID: "CAPABILITY_RUNTIME_SECRET_INVALID",
  CAPABILITY_RESOURCE_CEILING_MISSING: "CAPABILITY_RUNTIME_RESOURCE_CEILING_MISSING",
  CAPABILITY_PROCESS_FAILED: "CAPABILITY_RUNTIME_PROCESS_FAILED",
  CAPABILITY_PROCESS_TIMEOUT: "CAPABILITY_RUNTIME_PROCESS_TIMEOUT",
  CAPABILITY_OUTPUT_LIMIT: "CAPABILITY_RUNTIME_OUTPUT_LIMIT",
  CAPABILITY_MCP_IDENTITY_MISMATCH: "CAPABILITY_RUNTIME_MCP_IDENTITY_MISMATCH",
  CAPABILITY_MCP_MAPPING_MISMATCH: "CAPABILITY_RUNTIME_MCP_MAPPING_MISMATCH",
  CAPABILITY_MCP_FAILED: "CAPABILITY_RUNTIME_MCP_FAILED",
  CAPABILITY_ENDPOINT_UNAVAILABLE: "CAPABILITY_RUNTIME_ENDPOINT_UNAVAILABLE",
  CAPABILITY_ENDPOINT_REJECTED: "CAPABILITY_RUNTIME_ENDPOINT_REJECTED",
  CAPABILITY_ENDPOINT_RESULT_UNKNOWN: "CAPABILITY_RUNTIME_ENDPOINT_RESULT_UNKNOWN",
} as const);

export interface ActiveCapabilityManifestPort {
  listActive(): Promise<readonly CapabilityManifest[]>;
}

export interface CapabilityPayloadBoundary {
  store(ownerId: string, agentId: string): PayloadStorePort;
  readonly protector: PayloadProtectorPort;
  nextResultRef(request: CapabilityInvocationRequest): string;
}

export interface CapabilitySecretMaterialSource {
  resolve(secretRef: string, secretVersion: string): Promise<string>;
}

export interface NodeCapabilityRuntimeOptions {
  readonly manifests: ActiveCapabilityManifestPort;
  readonly bindings: CapabilityRuntimeBindingPort;
  readonly isolation: SandboxedProcessIsolationBackend;
  readonly payloads: CapabilityPayloadBoundary;
  readonly secretHandles: SecretPort;
  readonly secretSource: CapabilitySecretMaterialSource;
  readonly clock: ClockPort;
  readonly fetch?: typeof globalThis.fetch;
}

function descriptor(manifest: CapabilityManifest): CapabilityDescriptor {
  return Object.freeze({
    ref: manifest.ref,
    version: manifest.version,
    integrity: manifest.integrity,
    lifecycle: "active" as const,
    permissionRefs: Object.freeze([...manifest.permissionRefs]),
    isolation: manifest.isolation,
  });
}

function failed(
  request: CapabilityInvocationRequest,
  errorCode: string,
  occurredAt: string,
): CapabilityInvocationEvent {
  return Object.freeze({
    type: "capability.failed",
    invocationId: request.invocationId,
    errorCode,
    occurredAt,
  });
}

function safeHeaderName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value);
}

function sideEffecting(method: string): boolean {
  return method !== "GET";
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > maximumBytes) throw new Error("output-limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) throw new Error("output-limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class NodeCapabilityRuntimePort implements CapabilityPort {
  readonly #options: NodeCapabilityRuntimeOptions;
  readonly #cancellations = new Map<string, AbortController>();

  constructor(options: NodeCapabilityRuntimeOptions) {
    this.#options = options;
  }

  async list(): Promise<readonly CapabilityDescriptor[]> {
    const manifests = await this.#options.manifests.listActive();
    return Object.freeze(manifests.map(descriptor));
  }

  async *invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent> {
    const abort = new AbortController();
    if (this.#cancellations.has(request.invocationId))
      throw new Error("CAPABILITY_INVOCATION_ALREADY_RUNNING");
    this.#cancellations.set(request.invocationId, abort);
    try {
      const manifest = (await this.#options.manifests.listActive()).find(
        ({ ref }) => ref === request.capabilityRef,
      );
      if (!manifest || manifest.health.status !== "healthy") {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_NOT_ACTIVE,
          this.#options.clock.now(),
        );
        return;
      }
      if (!manifest.operations.includes(request.operation)) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_OPERATION_UNSUPPORTED,
          this.#options.clock.now(),
        );
        return;
      }
      if (!request.resourceCeiling) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_RESOURCE_CEILING_MISSING,
          this.#options.clock.now(),
        );
        return;
      }
      abort.signal.throwIfAborted();
      const input = await this.readInput(request);
      abort.signal.throwIfAborted();
      if (manifest.runtime.kind === "program") {
        yield* this.invokeProgram(manifest, request, input, abort.signal);
      } else if (manifest.runtime.kind === "mcp") {
        yield* this.invokeMcp(manifest, request, input, abort.signal);
      } else if (manifest.runtime.kind === "remote_api" || manifest.runtime.kind === "adapter") {
        yield* this.invokeEndpoint(manifest, request, input, abort.signal);
      } else {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_OPERATION_UNSUPPORTED,
          this.#options.clock.now(),
        );
      }
    } catch {
      if (abort.signal.aborted)
        yield {
          type: "capability.cancelled",
          invocationId: request.invocationId,
          reasonCode: "CANCELLED",
          occurredAt: this.#options.clock.now(),
        };
      else
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_INPUT_INVALID,
          this.#options.clock.now(),
        );
    } finally {
      this.#cancellations.delete(request.invocationId);
    }
  }

  async cancel(invocationId: string, _reasonCode: string): Promise<void> {
    this.#cancellations.get(invocationId)?.abort();
  }

  private async readInput(request: CapabilityInvocationRequest): Promise<Uint8Array> {
    const store = this.#options.payloads.store(request.ownerId, request.agentId);
    const payload = await store.get(request.inputRef);
    if (!payload) throw new Error(NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_INPUT_MISSING);
    return this.#options.payloads.protector.unprotect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      payload,
    });
  }

  private async storeOutput(
    request: CapabilityInvocationRequest,
    plaintext: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const ref = this.#options.payloads.nextResultRef(request);
    const payload = await this.#options.payloads.protector.protect({
      ownerId: request.ownerId,
      agentId: request.agentId,
      ref,
      dataClassification: request.dataClassification,
      contentType,
      plaintext,
      createdAt: this.#options.clock.now(),
    });
    await this.#options.payloads.store(request.ownerId, request.agentId).put(payload);
    return ref;
  }

  private async *invokeProgram(
    manifest: CapabilityManifest,
    request: CapabilityInvocationRequest,
    input: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityInvocationEvent> {
    if (manifest.runtime.kind !== "program" || !request.resourceCeiling) return;
    let launch: SandboxedProcessLaunch;
    try {
      launch = await this.#options.isolation.createLaunch(manifest, request.resourceCeiling);
    } catch {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_PROCESS_FAILED,
        this.#options.clock.now(),
      );
      return;
    }
    yield Object.freeze({
      type: "capability.progress" as const,
      invocationId: request.invocationId,
      sequence: 1,
      stage: "isolated_process_started",
      progressPermille: 100,
      payloadRef: null,
      occurredAt: this.#options.clock.now(),
    });
    const result = await runSandboxedProcess(
      launch,
      manifest.runtime.stdin === "protected_payload" ? input : null,
      signal,
    );
    if (result.outputLimitExceeded) {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_OUTPUT_LIMIT,
        this.#options.clock.now(),
      );
      return;
    }
    if (result.timedOut || signal.aborted) {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_PROCESS_TIMEOUT,
        this.#options.clock.now(),
      );
      return;
    }
    if (result.exitCode !== 0 || manifest.runtime.stdout === "none") {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_PROCESS_FAILED,
        this.#options.clock.now(),
      );
      return;
    }
    const resultRef = await this.storeOutput(request, result.stdout, "application/octet-stream");
    yield Object.freeze({
      type: "capability.completed" as const,
      invocationId: request.invocationId,
      resultRef,
      occurredAt: this.#options.clock.now(),
    });
  }

  private async *invokeMcp(
    manifest: CapabilityManifest,
    request: CapabilityInvocationRequest,
    input: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityInvocationEvent> {
    if (manifest.runtime.kind !== "mcp" || !request.resourceCeiling) return;
    const binding = await this.#options.bindings.resolveProcess(manifest);
    if (
      !binding ||
      binding.capabilityRef !== manifest.ref ||
      binding.capabilityVersion !== manifest.version ||
      binding.artifactDigest !== manifest.integrity ||
      binding.mcpServerIdentity !== manifest.runtime.serverIdentity ||
      !binding.mcpServerName ||
      !binding.mcpServerVersion
    ) {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_MAPPING_MISMATCH,
        this.#options.clock.now(),
      );
      return;
    }
    let launch: SandboxedProcessLaunch;
    try {
      launch = await this.#options.isolation.createLaunch(manifest, request.resourceCeiling);
    } catch {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_FAILED,
        this.#options.clock.now(),
      );
      return;
    }
    signal.throwIfAborted();
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      cwd: launch.cwd,
      env: { ...launch.environment },
      stderr: "pipe",
      maxBufferSize: request.resourceCeiling.maxOutputBytes,
    });
    const client = new Client(
      { name: "himawari-agent", version: "0.2.0" },
      {
        enforceStrictCapabilities: true,
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    let stderrBytes = 0;
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > (request.resourceCeiling?.maxOutputBytes ?? 0)) void client.close();
    });
    try {
      await client.connect(transport, {
        signal,
        timeout: request.resourceCeiling.maxWallTimeMs,
        maxTotalTimeout: request.resourceCeiling.maxWallTimeMs,
      });
      const server = client.getServerVersion();
      if (server?.name !== binding.mcpServerName || server.version !== binding.mcpServerVersion) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_IDENTITY_MISMATCH,
          this.#options.clock.now(),
        );
        return;
      }
      const toolName = binding.mcpOperationMap[request.operation];
      const tools = await client.listTools(undefined, {
        signal,
        timeout: request.resourceCeiling.maxWallTimeMs,
        maxTotalTimeout: request.resourceCeiling.maxWallTimeMs,
        cacheMode: "bypass",
      });
      if (
        !toolName ||
        !manifest.runtime.mappedResources.includes(`tool:${toolName}`) ||
        !tools.tools.some(({ name }) => name === toolName)
      ) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_MAPPING_MISMATCH,
          this.#options.clock.now(),
        );
        return;
      }
      const parsed = JSON.parse(new TextDecoder().decode(input)) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("MCP input must be an object");
      }
      const result = await client.callTool(
        { name: toolName, arguments: parsed as Record<string, unknown> },
        {
          signal,
          timeout: request.resourceCeiling.maxWallTimeMs,
          maxTotalTimeout: request.resourceCeiling.maxWallTimeMs,
        },
      );
      if (result.isError) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_FAILED,
          this.#options.clock.now(),
        );
        return;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(result));
      if (bytes.byteLength > request.resourceCeiling.maxOutputBytes) {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_OUTPUT_LIMIT,
          this.#options.clock.now(),
        );
        return;
      }
      const resultRef = await this.storeOutput(request, bytes, "application/json");
      yield Object.freeze({
        type: "capability.completed" as const,
        invocationId: request.invocationId,
        resultRef,
        occurredAt: this.#options.clock.now(),
      });
    } catch {
      yield failed(
        request,
        signal.aborted
          ? NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_PROCESS_TIMEOUT
          : NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_MCP_FAILED,
        this.#options.clock.now(),
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async *invokeEndpoint(
    manifest: CapabilityManifest,
    request: CapabilityInvocationRequest,
    input: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<CapabilityInvocationEvent> {
    if (
      (manifest.runtime.kind !== "remote_api" && manifest.runtime.kind !== "adapter") ||
      !request.resourceCeiling
    )
      return;
    const binding = await this.#options.bindings.resolveEndpoint(manifest);
    const operation = binding?.operations[request.operation];
    if (
      !binding ||
      !operation ||
      binding.endpointIdentity !== manifest.runtime.endpointIdentity ||
      binding.artifactDigest !== manifest.integrity ||
      !binding.productionSuitable ||
      !binding.allowedMethods.includes(operation.method) ||
      !operation.path.startsWith("/") ||
      operation.path.startsWith("//") ||
      Object.keys(operation.secretHeaders).some(
        (secretRef) => !manifest.scopes.secrets.includes(secretRef),
      )
    ) {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_UNAVAILABLE,
        this.#options.clock.now(),
      );
      return;
    }
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": request.invocationId,
    });
    try {
      await this.injectEndpointSecrets(manifest, binding, request, headers);
    } catch {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_SECRET_INVALID,
        this.#options.clock.now(),
      );
      return;
    }
    let base: URL;
    let endpoint: URL;
    try {
      base = new URL(binding.url);
      endpoint = new URL(operation.path, base);
    } catch {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_REJECTED,
        this.#options.clock.now(),
      );
      return;
    }
    const loopback = base.hostname === "127.0.0.1" || base.hostname === "localhost";
    const transportSafe =
      base.protocol === "https:" ||
      (base.protocol === "http:" && loopback && binding.allowLoopbackQualification);
    if (!transportSafe || endpoint.origin !== base.origin) {
      yield failed(
        request,
        NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_REJECTED,
        this.#options.clock.now(),
      );
      return;
    }
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(request.resourceCeiling.maxWallTimeMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await (this.#options.fetch ?? globalThis.fetch)(endpoint, {
        method: operation.method,
        headers,
        ...(operation.method === "GET" ? {} : { body: Buffer.from(input) }),
        redirect: "error",
        signal: combined,
      });
    } catch {
      if (sideEffecting(operation.method)) {
        yield Object.freeze({
          type: "capability.result_unknown" as const,
          invocationId: request.invocationId,
          externalActionId: `external:${request.invocationId}`,
          occurredAt: this.#options.clock.now(),
        });
      } else {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_UNAVAILABLE,
          this.#options.clock.now(),
        );
      }
      return;
    }
    if (!response.ok) {
      if (sideEffecting(operation.method)) {
        yield Object.freeze({
          type: "capability.result_unknown" as const,
          invocationId: request.invocationId,
          externalActionId: `external:${request.invocationId}`,
          occurredAt: this.#options.clock.now(),
        });
      } else {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_REJECTED,
          this.#options.clock.now(),
        );
      }
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBody(response, request.resourceCeiling.maxOutputBytes);
    } catch {
      if (sideEffecting(operation.method)) {
        yield Object.freeze({
          type: "capability.result_unknown" as const,
          invocationId: request.invocationId,
          externalActionId: `external:${request.invocationId}`,
          occurredAt: this.#options.clock.now(),
        });
      } else {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_OUTPUT_LIMIT,
          this.#options.clock.now(),
        );
      }
      return;
    }
    let resultRef: string;
    try {
      resultRef = await this.storeOutput(
        request,
        bytes,
        response.headers.get("content-type") ?? "application/octet-stream",
      );
    } catch {
      if (sideEffecting(operation.method)) {
        yield Object.freeze({
          type: "capability.result_unknown" as const,
          invocationId: request.invocationId,
          externalActionId: `external:${request.invocationId}`,
          occurredAt: this.#options.clock.now(),
        });
      } else {
        yield failed(
          request,
          NODE_CAPABILITY_RUNTIME_ERROR_CODES.CAPABILITY_ENDPOINT_UNAVAILABLE,
          this.#options.clock.now(),
        );
      }
      return;
    }
    yield Object.freeze({
      type: "capability.completed" as const,
      invocationId: request.invocationId,
      resultRef,
      occurredAt: this.#options.clock.now(),
    });
  }

  private async injectEndpointSecrets(
    manifest: CapabilityManifest,
    binding: CapabilityEndpointBinding,
    request: CapabilityInvocationRequest,
    headers: Headers,
  ): Promise<void> {
    const operation = binding.operations[request.operation];
    if (!operation) throw new Error("operation-not-bound");
    const required = Object.keys(operation.secretHeaders).sort();
    const resolved = new Set<string>();
    for (const handleRef of request.secretHandleRefs) {
      const handle = await this.#options.secretHandles.inspectHandle(handleRef);
      if (
        !handle ||
        handle.ownerId !== request.ownerId ||
        handle.agentId !== request.agentId ||
        handle.runId !== request.runId ||
        handle.scopeRef !== request.invocationId ||
        handle.revokedAt !== null ||
        this.#options.clock.now() >= handle.expiresAt ||
        !manifest.scopes.secrets.includes(handle.secretRef)
      ) {
        throw new Error("secret-handle-invalid");
      }
      const headerName = operation.secretHeaders[handle.secretRef];
      if (!headerName || !safeHeaderName(headerName) || resolved.has(handle.secretRef)) {
        throw new Error("secret-binding-invalid");
      }
      const secret = await this.#options.secretSource.resolve(
        handle.secretRef,
        handle.secretVersion,
      );
      headers.set(headerName, secret);
      resolved.add(handle.secretRef);
    }
    if (required.some((secretRef) => !resolved.has(secretRef))) {
      throw new Error("secret-required");
    }
  }
}
