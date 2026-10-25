import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(repositoryRoot, "test/fixtures/memory-evaluation");
const BASE_URL = "https://ai-gateway.vercel.sh/v1";
const MODEL = "alibaba/qwen3-embedding-8b";
const KEYCHAIN_SERVICE = "himawari-provider.vercel-ai-gateway-api-key.v1";
const KEYCHAIN_ACCOUNT = "himawari-agent";
const CONCURRENCY = 4;
const QUERY_INSTRUCTION =
  "Given a question from the owner of a personal assistant, retrieve the remembered facts about the owner that help answer it";

async function apiKey() {
  const fromEnvironment = process.env["AI_GATEWAY_API_KEY"];
  if (fromEnvironment && fromEnvironment.trim().length > 0) return fromEnvironment.trim();
  if (process.platform !== "darwin") throw new Error("AI_GATEWAY_API_KEY_REQUIRED");
  const { stdout } = await promisify(execFile)("/usr/bin/security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  const key = stdout.trim();
  if (key.length === 0) throw new Error("AI_GATEWAY_API_KEY_EMPTY");
  return key;
}

function float16(value) {
  const floats = new Float32Array([value]);
  const bits = new Uint32Array(floats.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const shifted = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((shifted + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  const rounded = (exponent << 10) | (mantissa >>> 13);
  return sign | (rounded + ((mantissa >>> 12) & 1));
}

function encode(vector) {
  const norm = Math.hypot(...vector) || 1;
  const halves = new Uint16Array(vector.length);
  vector.forEach((value, index) => {
    halves[index] = float16(value / norm);
  });
  return Buffer.from(halves.buffer).toString("base64");
}

async function embed(key, text, dimensions) {
  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text, dimensions, encoding_format: "float" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`EMBEDDING_HTTP_${response.status}`);
  const body = await response.json();
  const vector = body?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== dimensions)
    throw new Error(`EMBEDDING_DIMENSIONS_MISMATCH:${Array.isArray(vector) ? vector.length : 0}`);
  return { vector, cost: Number(body?.providerMetadata?.gateway?.cost ?? body?.usage?.cost ?? 0) };
}

async function main() {
  const dimensionsList = process.argv
    .slice(2)
    .map(Number)
    .filter((value) => value === 4096 || value === 1024);
  if (dimensionsList.length === 0) dimensionsList.push(4096, 1024);
  const dataset = JSON.parse(await readFile(path.join(fixtureRoot, "dataset.json"), "utf8"));
  const texts = [
    ...new Set([
      ...dataset.memories.map(({ text }) => text),
      ...dataset.questions.map(({ query }) => query),
      ...dataset.questions.map(({ query }) => `Instruct: ${QUERY_INSTRUCTION}\nQuery:${query}`),
    ]),
  ];
  const key = await apiKey();
  for (const dimensions of dimensionsList) {
    const vectors = {};
    let cost = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < texts.length) {
          const text = texts[next++];
          const result = await embed(key, text, dimensions);
          vectors[text] = encode(result.vector);
          cost += Number.isFinite(result.cost) ? result.cost : 0;
        }
      }),
    );
    const ordered = Object.fromEntries(texts.map((text) => [text, vectors[text]]));
    await writeFile(
      path.join(fixtureRoot, `embeddings-${dimensions}.json`),
      `${JSON.stringify({ model: MODEL, dimensions, encoding: "float16-base64", vectors: ordered })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ dimensions, texts: texts.length, costUsd: Number(cost.toFixed(6)) })}\n`,
    );
  }
}

await main();
