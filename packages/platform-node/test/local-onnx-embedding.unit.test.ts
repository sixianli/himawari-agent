import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMBEDDING_PRIORITY_HEADER,
  EMBEDDING_PROFILES,
  JINA_V5_SMALL_INT8_PROFILE,
} from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_ONNX_MANIFEST_SCHEMA,
  LocalOnnxEmbeddingRuntime,
  type LocalOnnxLoader,
  type LocalOnnxModel,
  localOnnxArtifactDirectory,
} from "../src/local-onnx-embedding.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/local-onnx-embedding",
);
const MODEL = JINA_V5_SMALL_INT8_PROFILE.model;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function installFixture(
  options: { readonly corrupt?: boolean; readonly manifestModel?: string } = {},
): Promise<{ stateRoot: string; artifactSha256: string }> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-local-onnx-"));
  roots.push(stateRoot);
  const staging = path.join(stateRoot, "staging");
  await mkdir(staging, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of ["model.onnx", "tokenizer.json", "tokenizer_config.json"]) {
    await copyFile(path.join(FIXTURE, name), path.join(staging, name));
    files[name] = sha256(await readFile(path.join(staging, name)));
  }
  const manifest = `${JSON.stringify({
    schema: LOCAL_ONNX_MANIFEST_SCHEMA,
    model: options.manifestModel ?? MODEL,
    dimensions: 1024,
    files,
  })}\n`;
  await writeFile(path.join(staging, "manifest.json"), manifest);
  const artifactSha256 = sha256(manifest);
  const directory = localOnnxArtifactDirectory(stateRoot, MODEL, artifactSha256);
  await mkdir(path.dirname(directory), { recursive: true });
  await rename(staging, directory);
  if (options.corrupt) await writeFile(path.join(directory, "tokenizer_config.json"), "{}\n");
  return { stateRoot, artifactSha256 };
}

function runtimeFor(
  installed: { stateRoot: string; artifactSha256: string },
  options: {
    readonly load?: LocalOnnxLoader;
    readonly maximumPending?: number;
  } = {},
) {
  return new LocalOnnxEmbeddingRuntime({
    stateRoot: installed.stateRoot,
    profile: JINA_V5_SMALL_INT8_PROFILE,
    dimensions: 1024,
    artifactSha256: installed.artifactSha256,
    ...options,
  });
}

const request = (input: string, priority: "interactive" | "background" = "interactive") => ({
  method: "POST",
  headers: { "content-type": "application/json", [EMBEDDING_PRIORITY_HEADER]: priority },
  body: JSON.stringify({ model: MODEL, input, dimensions: 1024, encoding_format: "base64" }),
});

describe("local ONNX embedding runtime", () => {
  it("[P3-1] loads the pinned model files and answers an embeddings request without the network", async () => {
    const runtime = runtimeFor(await installFixture());
    const states: string[] = [];
    runtime.observe((state) => states.push(state));
    await runtime.start();
    expect(states).toEqual(["idle", "loading", "ready"]);
    const response = await runtime.fetch(
      "http://local-onnx.invalid/v1/embeddings",
      request("你好"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      model: string;
      data: { embedding: string }[];
      usage: { prompt_tokens: number; cost: number };
      providerMetadata: unknown;
    };
    expect(body.model).toBe(MODEL);
    expect(Buffer.from(body.data[0]?.embedding ?? "", "base64").byteLength).toBe(1024 * 4);
    expect(body.usage).toMatchObject({ prompt_tokens: 6, cost: 0 });
    expect(body.providerMetadata).toEqual({ local: { runtime: "onnxruntime-node" } });
    await runtime.close();
  });

  it("[P3-1] REVERSE: refuses to load when a model file no longer matches its pinned digest", async () => {
    const runtime = runtimeFor(await installFixture({ corrupt: true }));
    const reasons: (string | null)[] = [];
    runtime.observe((_state, reason) => reasons.push(reason));
    await runtime.start();
    expect(runtime.state).toBe("failed");
    expect(reasons.at(-1)).toBe("EMBEDDING_ARTIFACT_DIGEST_MISMATCH");
    expect(() => runtime.assertAccepting("interactive")).toThrow("EMBEDDING_LOCAL_NOT_READY");
    const response = await runtime.fetch(
      "http://local-onnx.invalid/v1/embeddings",
      request("你好"),
    );
    expect(response.status).toBe(503);
  });

  it("[P3-1] REVERSE: refuses a manifest whose digest is not the configured one, or that names another model", async () => {
    const installed = await installFixture();
    const wrongDigest = runtimeFor({ ...installed, artifactSha256: "b".repeat(64) });
    await wrongDigest.start();
    expect(wrongDigest.state).toBe("failed");
    const otherModel = runtimeFor(
      await installFixture({ manifestModel: "qwen3-embedding-0.6b-int8" }),
    );
    const reasons: (string | null)[] = [];
    otherModel.observe((_state, reason) => reasons.push(reason));
    await otherModel.start();
    expect(reasons.at(-1)).toBe("EMBEDDING_ARTIFACT_PROFILE_MISMATCH");
  });

  it("[P3-1] REVERSE: refuses a model directory reached through a symbolic link", async () => {
    const installed = await installFixture();
    const linked = await mkdtemp(path.join(tmpdir(), "himawari-local-onnx-link-"));
    roots.push(linked);
    await symlink(path.join(installed.stateRoot, "models"), path.join(linked, "models"));
    const runtime = runtimeFor({ ...installed, stateRoot: linked });
    const reasons: (string | null)[] = [];
    runtime.observe((_state, reason) => reasons.push(reason));
    await runtime.start();
    expect(reasons.at(-1)).toBe("EMBEDDING_ARTIFACT_SYMLINK");
  });

  it("[P3-1] answers chat queries before queued background work and refuses work beyond the queue limit", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: LocalOnnxModel = {
      tokenize: (text) => [...text].map((character) => character.codePointAt(0) ?? 0),
      run: async (ids) => {
        const text = String.fromCodePoint(...ids);
        if (text === "first") await gate;
        order.push(text);
        return new Float32Array(1024).fill(1);
      },
      close: async () => {},
    };
    const runtime = runtimeFor(await installFixture(), {
      load: async () => model,
      maximumPending: 2,
    });
    await runtime.start();
    const url = "http://local-onnx.invalid/v1/embeddings";
    const first = runtime.fetch(url, request("first", "background"));
    await Promise.resolve();
    const second = runtime.fetch(url, request("second", "background"));
    const third = runtime.fetch(url, request("third", "background"));
    expect(() => runtime.assertAccepting("background")).toThrow("EMBEDDING_LOCAL_QUEUE_FULL");
    expect((await runtime.fetch(url, request("fourth", "background"))).status).toBe(503);
    expect(() => runtime.assertAccepting("interactive")).not.toThrow();
    const query = runtime.fetch(url, request("query", "interactive"));
    release();
    await Promise.all([first, second, third, query]);
    expect(order).toEqual(["first", "query", "second", "third"]);
  });

  it("[P3-1] drops a queued request whose caller gave up", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ran: string[] = [];
    const runtime = runtimeFor(await installFixture(), {
      load: async () => ({
        tokenize: (text) => [...text].map((character) => character.codePointAt(0) ?? 0),
        run: async (ids) => {
          const text = String.fromCodePoint(...ids);
          if (text === "busy") await gate;
          ran.push(text);
          return new Float32Array(1024).fill(1);
        },
        close: async () => {},
      }),
    });
    await runtime.start();
    const url = "http://local-onnx.invalid/v1/embeddings";
    const busy = runtime.fetch(url, request("busy"));
    await Promise.resolve();
    const controller = new AbortController();
    const abandoned = runtime.fetch(url, { ...request("abandoned"), signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(abandoned).rejects.toThrow("caller gave up");
    release();
    await busy;
    expect(ran).toEqual(["busy"]);
    expect(runtime.pending).toBe(0);
  });

  it("[P3-1] closing waits for the inference in flight, and a caller who gave up during it gets no vector", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const runtime = runtimeFor(await installFixture(), {
      load: async () => ({
        tokenize: (text) => [...text].map((character) => character.codePointAt(0) ?? 0),
        run: async () => {
          events.push("run-started");
          await gate;
          events.push("run-finished");
          return new Float32Array(1024).fill(1);
        },
        close: async () => {
          events.push("model-closed");
        },
      }),
    });
    await runtime.start();
    const controller = new AbortController();
    const running = runtime.fetch("http://local-onnx.invalid/v1/embeddings", {
      ...request("busy"),
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("caller gave up"));
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual(["run-started"]);
    release();
    await expect(running).rejects.toThrow("caller gave up");
    await closing;
    expect(events).toEqual(["run-started", "run-finished", "model-closed"]);
  });

  it("[P3-1] REVERSE: answers a malformed request with an error response and refuses an input beyond 8192 tokens", async () => {
    const runtime = runtimeFor(await installFixture(), {
      load: async () => ({
        tokenize: (text) => [...text].map((character) => character.codePointAt(0) ?? 0),
        run: async () => new Float32Array(1024).fill(1),
        close: async () => {},
      }),
    });
    await runtime.start();
    const url = "http://local-onnx.invalid/v1/embeddings";
    const bad = await runtime.fetch(url, {
      ...request("x"),
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { type: "local_body_invalid" },
    });
    const nullBody = await runtime.fetch(url, {
      ...request("x"),
      body: "null",
    });
    expect(nullBody.status).toBe(400);
    expect((await runtime.fetch("not a url", request("x"))).status).toBe(404);
    await expect(runtime.fetch(url, request("a".repeat(8193)))).rejects.toThrow(
      "EMBEDDING_LOCAL_INPUT_LENGTH",
    );
    expect((await runtime.fetch(url, request("a".repeat(8192)))).status).toBe(200);
  });

  it("[P3-1] the artifact build script pins the same upstream files as each local profile", () => {
    const script = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../scripts/embedding-models/build-artifact.py",
    );
    const sources = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-c",
          "import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1], run_name='build_artifact_sources')['SOURCES']))",
          script,
        ],
        { encoding: "utf8", timeout: 30_000 },
      ),
    ) as Record<
      string,
      {
        repository: string;
        revision: string;
        dimensions: number;
        model: string;
        externalData: string[];
        quantization: string;
        files: Record<string, string>;
      }
    >;
    const local = EMBEDDING_PROFILES.filter((profile) => profile.provider === "local-onnx");
    expect(Object.keys(sources).sort()).toEqual(local.map((profile) => profile.model).sort());
    for (const profile of local) {
      const source = sources[profile.model];
      expect({
        repository: source?.repository,
        revision: source?.revision,
        dimensions: [source?.dimensions],
        file: source?.model,
        externalData: source?.externalData,
        quantization: source?.quantization,
      }).toEqual({
        repository: profile.source?.repository,
        revision: profile.source?.revision,
        dimensions: [...profile.dimensions],
        file: profile.source?.file,
        externalData: [...(profile.source?.externalData ?? [])],
        quantization: profile.source?.quantization,
      });
      const files = source?.files ?? {};
      expect(Object.keys(files)).toEqual(
        expect.arrayContaining([source?.model, ...(source?.externalData ?? [])]),
      );
      for (const digest of Object.values(files)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
