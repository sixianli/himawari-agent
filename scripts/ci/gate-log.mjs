import { createHash } from "node:crypto";

export const GATE_BEGIN = "HIMAWARI_GATE_BEGIN v1";
export const GATE_END = "HIMAWARI_GATE_END";
export const GATE_LIMIT_BYTES = 256 * 1024;
const CHUNK = 1000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /u;

const assert = (value, code) => {
  if (!value) throw new Error(code);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function encodeGate({ context, summary }) {
  const json = JSON.stringify({ context, summary });
  const bytes = Buffer.from(json, "utf8");
  assert(bytes.length <= GATE_LIMIT_BYTES, "CI_GATE_LOG_TOO_LARGE");
  const encoded = bytes.toString("base64");
  const lines = [];
  for (let i = 0; i < encoded.length; i += CHUNK) lines.push(encoded.slice(i, i + CHUNK));
  return [`${GATE_BEGIN} ${sha256(bytes)}`, ...lines, GATE_END, ""].join("\n");
}

export function decodeGate(log) {
  assert(typeof log === "string" && log.length <= 20_000_000, "MAIN_GATE_LOG_LIMIT");
  const lines = log
    .replace(/^﻿/u, "")
    .split(/\r?\n/u)
    .map((line) => line.replace(TIMESTAMP, ""));
  const begins = lines.flatMap((line, index) => (line.startsWith(`${GATE_BEGIN} `) ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === GATE_END ? [index] : []));
  assert(begins.length === 1 && ends.length === 1 && ends[0] > begins[0], "MAIN_GATE_LOG_MISSING");
  const digest = lines[begins[0]].slice(GATE_BEGIN.length + 1);
  assert(/^[a-f0-9]{64}$/u.test(digest), "MAIN_GATE_LOG_MISSING");
  const body = lines.slice(begins[0] + 1, ends[0]);
  assert(
    body.length > 0 && body.every((line) => /^[A-Za-z0-9+/]+={0,2}$/u.test(line)),
    "MAIN_GATE_LOG_CORRUPT",
  );
  const bytes = Buffer.from(body.join(""), "base64");
  assert(
    bytes.length <= GATE_LIMIT_BYTES && bytes.toString("base64") === body.join(""),
    "MAIN_GATE_LOG_CORRUPT",
  );
  assert(sha256(bytes) === digest, "MAIN_GATE_LOG_DIGEST");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("MAIN_GATE_LOG_CORRUPT");
  }
  assert(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === "context,summary" &&
      value.context !== null &&
      typeof value.context === "object" &&
      value.summary !== null &&
      typeof value.summary === "object",
    "MAIN_GATE_LOG_CORRUPT",
  );
  return value;
}
