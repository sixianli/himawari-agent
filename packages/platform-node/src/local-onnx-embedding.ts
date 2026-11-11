import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ApplicationPortError,
  EMBEDDING_PRIORITY_HEADER,
  type EmbeddingPriority,
  type EmbeddingProfile,
  LOCAL_ONNX_EMBEDDING_PROVIDER,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";

export const LOCAL_ONNX_MANIFEST_FILE = "manifest.json" as const;
export const LOCAL_ONNX_MANIFEST_SCHEMA = "himawari-embedding-artifact.v1" as const;
export const LOCAL_ONNX_REQUIRED_FILES = Object.freeze([
  "model.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
]);
const OPTIONAL_FILES = Object.freeze(["model.onnx_data"]);
const MAXIMUM_INPUT_TOKENS = 8192;
const DEFAULT_MAXIMUM_PENDING = 64;

export interface LocalOnnxManifest {
  readonly schema: typeof LOCAL_ONNX_MANIFEST_SCHEMA;
  readonly model: string;
  readonly dimensions: number;
  readonly files: Readonly<Record<string, string>>;
}

export interface LocalOnnxModel {
  tokenize(text: string): readonly number[];
  run(ids: readonly number[]): Promise<Float32Array>;
  close(): Promise<void>;
}

export type LocalOnnxLoader = (input: {
  readonly directory: string;
  readonly profile: EmbeddingProfile;
  readonly dimensions: number;
  readonly threads: number;
}) => Promise<LocalOnnxModel>;

export type LocalOnnxState = "idle" | "loading" | "ready" | "failed" | "closed";

export function localOnnxArtifactDirectory(
  stateRoot: string,
  model: string,
  artifactSha256: string,
): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(model)) throw new TypeError("EMBEDDING_MODEL_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(artifactSha256)) throw new TypeError("EMBEDDING_ARTIFACT_INVALID");
  return path.join(stateRoot, "models", model, artifactSha256);
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function assertPlainEntry(entry: string, kind: "directory" | "file"): Promise<void> {
  const stats = await lstat(entry).catch(() => null);
  if (!stats) throw new Error(`EMBEDDING_ARTIFACT_MISSING ${path.basename(entry)}`);
  if (stats.isSymbolicLink()) throw new Error("EMBEDDING_ARTIFACT_SYMLINK");
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile())
    throw new Error(`EMBEDDING_ARTIFACT_NOT_${kind.toUpperCase()}`);
}

function parsedManifest(bytes: Buffer): LocalOnnxManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("EMBEDDING_ARTIFACT_MANIFEST_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("EMBEDDING_ARTIFACT_MANIFEST_INVALID");
  const manifest = value as Record<string, unknown>;
  const files = manifest["files"];
  if (
    manifest["schema"] !== LOCAL_ONNX_MANIFEST_SCHEMA ||
    typeof manifest["model"] !== "string" ||
    !Number.isSafeInteger(manifest["dimensions"]) ||
    files === null ||
    typeof files !== "object" ||
    Array.isArray(files)
  )
    throw new Error("EMBEDDING_ARTIFACT_MANIFEST_INVALID");
  const names = Object.keys(files);
  if (
    !LOCAL_ONNX_REQUIRED_FILES.every((name) => names.includes(name)) ||
    names.some(
      (name) => !LOCAL_ONNX_REQUIRED_FILES.includes(name) && !OPTIONAL_FILES.includes(name),
    )
  )
    throw new Error("EMBEDDING_ARTIFACT_FILES_INVALID");
  for (const digest of Object.values(files))
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("EMBEDDING_ARTIFACT_FILES_INVALID");
  return manifest as unknown as LocalOnnxManifest;
}

export async function verifyLocalOnnxArtifact(input: {
  readonly stateRoot: string;
  readonly model: string;
  readonly dimensions: number;
  readonly artifactSha256: string;
}): Promise<{ readonly directory: string; readonly manifest: LocalOnnxManifest }> {
  const directory = localOnnxArtifactDirectory(input.stateRoot, input.model, input.artifactSha256);
  let current = path.join(input.stateRoot, "models");
  await assertPlainEntry(current, "directory");
  for (const part of [input.model, input.artifactSha256]) {
    current = path.join(current, part);
    await assertPlainEntry(current, "directory");
  }
  const manifestPath = path.join(directory, LOCAL_ONNX_MANIFEST_FILE);
  await assertPlainEntry(manifestPath, "file");
  const bytes = await readFile(manifestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== input.artifactSha256)
    throw new Error("EMBEDDING_ARTIFACT_MANIFEST_DIGEST_MISMATCH");
  const manifest = parsedManifest(bytes);
  if (manifest.model !== input.model || manifest.dimensions !== input.dimensions)
    throw new Error("EMBEDDING_ARTIFACT_PROFILE_MISMATCH");
  for (const [name, digest] of Object.entries(manifest.files).sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const file = path.join(directory, name);
    await assertPlainEntry(file, "file");
    if ((await fileSha256(file)) !== digest)
      throw new Error(`EMBEDDING_ARTIFACT_DIGEST_MISMATCH ${name}`);
  }
  return Object.freeze({ directory, manifest });
}

export const loadOnnxRuntimeModel: LocalOnnxLoader = async ({
  directory,
  profile,
  dimensions,
  threads,
}) => {
  const [ort, { Tokenizer }] = await Promise.all([
    import("onnxruntime-node"),
    import("@huggingface/tokenizers"),
  ]);
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(path.join(directory, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(path.join(directory, "tokenizer_config.json"), "utf8")),
  );
  const session = await ort.InferenceSession.create(path.join(directory, "model.onnx"), {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  });
  const output =
    profile.pooling === "last_token" ? "last_hidden_state" : ("sentence_embedding" as const);
  if (!session.outputNames.includes(output)) throw new Error("EMBEDDING_MODEL_OUTPUT_MISSING");
  return {
    tokenize: (text) => tokenizer.encode(text).ids,
    async run(ids) {
      const length = ids.length;
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {};
      for (const name of session.inputNames) {
        const values =
          name === "input_ids"
            ? ids
            : name === "attention_mask"
              ? ids.map(() => 1)
              : name === "position_ids"
                ? ids.map((_, index) => index)
                : null;
        if (values === null) throw new Error("EMBEDDING_MODEL_INPUT_UNSUPPORTED");
        feeds[name] = new ort.Tensor("int64", BigInt64Array.from(values, BigInt), [1, length]);
      }
      const result = await session.run(feeds, [output]);
      const tensor = result[output];
      if (!tensor || !(tensor.data instanceof Float32Array))
        throw new Error("EMBEDDING_MODEL_OUTPUT_INVALID");
      const width = tensor.dims.at(-1);
      if (width !== dimensions) throw new Error("EMBEDDING_MODEL_DIMENSIONS_MISMATCH");
      const offset = profile.pooling === "last_token" ? (length - 1) * dimensions : 0;
      return tensor.data.slice(offset, offset + dimensions);
    },
    close: () => session.release(),
  };
};

interface PendingEmbedding {
  readonly input: string;
  readonly priority: EmbeddingPriority;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: { vector: Float32Array; tokens: number }) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export interface LocalOnnxEmbeddingRuntimeOptions {
  readonly stateRoot: string;
  readonly profile: EmbeddingProfile;
  readonly dimensions: number;
  readonly artifactSha256: string;
  readonly threads?: number;
  readonly maximumPending?: number;
  readonly load?: LocalOnnxLoader;
}

export type LocalOnnxStateListener = (state: LocalOnnxState, reasonCode: string | null) => void;

function failure(code: string): ApplicationPortError {
  return new ApplicationPortError(PORT_ERROR_CODES.PROVIDER_FAILURE, code);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, type: string): Response {
  return jsonResponse(status, { error: { type, message: type } });
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function base64Vector(vector: Float32Array): string {
  const bytes = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (const [index, value] of vector.entries()) bytes.writeFloatLE(value, index * 4);
  return bytes.toString("base64");
}

export class LocalOnnxEmbeddingRuntime {
  readonly #options: LocalOnnxEmbeddingRuntimeOptions;
  readonly #pending: PendingEmbedding[] = [];
  readonly #listeners = new Set<LocalOnnxStateListener>();
  #state: LocalOnnxState = "idle";
  #reasonCode: string | null = null;
  #model: LocalOnnxModel | undefined;
  #loading: Promise<void> | undefined;
  #draining = false;

  constructor(options: LocalOnnxEmbeddingRuntimeOptions) {
    if (options.profile.provider !== LOCAL_ONNX_EMBEDDING_PROVIDER)
      throw new TypeError("EMBEDDING_PROFILE_NOT_LOCAL");
    if (!options.profile.dimensions.includes(options.dimensions))
      throw new TypeError("EMBEDDING_PROFILE_DIMENSIONS_UNSUPPORTED");
    this.#options = options;
  }

  get state(): LocalOnnxState {
    return this.#state;
  }

  get pending(): number {
    return this.#pending.length;
  }

  observe(listener: LocalOnnxStateListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state, this.#reasonCode);
    return () => this.#listeners.delete(listener);
  }

  start(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  assertAccepting(priority: EmbeddingPriority): void {
    if (this.#state !== "ready") throw failure("EMBEDDING_LOCAL_NOT_READY");
    if (this.#saturated(priority)) throw failure("EMBEDDING_LOCAL_QUEUE_FULL");
  }

  readonly fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    if (!new URL(href).pathname.endsWith("/embeddings") || init?.method !== "POST")
      return errorResponse(404, "local_route_unknown");
    if (typeof init.body !== "string") return errorResponse(400, "local_body_invalid");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (
      body["model"] !== this.#options.profile.model ||
      body["dimensions"] !== this.#options.dimensions ||
      typeof body["input"] !== "string"
    )
      return errorResponse(400, "local_request_invalid");
    const priority =
      headerValue(init.headers, EMBEDDING_PRIORITY_HEADER) === "interactive"
        ? "interactive"
        : "background";
    if (this.#state !== "ready") return errorResponse(503, "local_model_not_ready");
    if (this.#saturated(priority)) return errorResponse(503, "local_queue_full");
    const { vector, tokens } = await this.#enqueue(
      body["input"],
      priority,
      init.signal ?? undefined,
    );
    return jsonResponse(200, {
      object: "list",
      model: this.#options.profile.model,
      data: [{ object: "embedding", index: 0, embedding: base64Vector(vector) }],
      usage: { prompt_tokens: tokens, total_tokens: tokens, cost: 0 },
      providerMetadata: { local: { runtime: "onnxruntime-node" } },
    });
  };

  async close(): Promise<void> {
    this.#setState("closed", null);
    for (const item of this.#pending.splice(0)) {
      item.signal?.removeEventListener("abort", item.onAbort);
      item.reject(failure("EMBEDDING_LOCAL_CLOSED"));
    }
    const model = this.#model;
    this.#model = undefined;
    await model?.close();
  }

  #saturated(priority: EmbeddingPriority): boolean {
    const limit = this.#options.maximumPending ?? DEFAULT_MAXIMUM_PENDING;
    const background = this.#pending.filter((item) => item.priority === "background").length;
    return priority === "interactive"
      ? this.#pending.length - background >= limit
      : background >= limit;
  }

  #setState(state: LocalOnnxState, reasonCode: string | null): void {
    this.#state = state;
    this.#reasonCode = reasonCode;
    for (const listener of [...this.#listeners]) listener(state, reasonCode);
  }

  async #load(): Promise<void> {
    this.#setState("loading", null);
    try {
      const { directory } = await verifyLocalOnnxArtifact({
        stateRoot: this.#options.stateRoot,
        model: this.#options.profile.model,
        dimensions: this.#options.dimensions,
        artifactSha256: this.#options.artifactSha256,
      });
      const model = await (this.#options.load ?? loadOnnxRuntimeModel)({
        directory,
        profile: this.#options.profile,
        dimensions: this.#options.dimensions,
        threads: this.#options.threads ?? 2,
      });
      if (this.#state === "closed") {
        await model.close();
        return;
      }
      this.#model = model;
      this.#setState("ready", null);
    } catch (error) {
      if (this.#state === "closed") return;
      const code =
        error instanceof Error
          ? (error.message.split(" ")[0] ?? "")
          : "EMBEDDING_LOCAL_LOAD_FAILED";
      this.#setState(
        "failed",
        /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : "EMBEDDING_LOCAL_LOAD_FAILED",
      );
    }
  }

  #enqueue(
    input: string,
    priority: EmbeddingPriority,
    signal: AbortSignal | undefined,
  ): Promise<{ vector: Float32Array; tokens: number }> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item: PendingEmbedding = {
        input,
        priority,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#pending.indexOf(item);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(signal?.reason);
        },
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });
      const firstBackground = this.#pending.findIndex((entry) => entry.priority === "background");
      if (priority === "interactive" && firstBackground >= 0)
        this.#pending.splice(firstBackground, 0, item);
      else this.#pending.push(item);
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let item = this.#pending.shift(); item; item = this.#pending.shift()) {
        item.signal?.removeEventListener("abort", item.onAbort);
        if (item.signal?.aborted) {
          item.reject(item.signal.reason);
          continue;
        }
        const model = this.#model;
        if (!model) {
          item.reject(failure("EMBEDDING_LOCAL_NOT_READY"));
          continue;
        }
        try {
          const ids = model.tokenize(item.input);
          if (ids.length === 0 || ids.length > MAXIMUM_INPUT_TOKENS)
            throw failure("EMBEDDING_LOCAL_INPUT_LENGTH");
          const vector = await model.run(ids);
          if (vector.length !== this.#options.dimensions || !vector.every(Number.isFinite))
            throw failure("EMBEDDING_VECTOR_INVALID");
          item.resolve({ vector, tokens: ids.length });
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
