import type { JsonObject } from "@himawari-agent/application";

export const APP_CODE_RUNNER_ARGV = Object.freeze([
  "node",
  "--input-type=module",
  "--eval",
  [
    'import { writeSync } from "node:fs";',
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    'const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));',
    "const logs = [];",
    "let logged = 0;",
    "const show = (part) => {",
    '  if (typeof part === "string") return part;',
    "  try { return JSON.stringify(part) ?? String(part); } catch { return String(part); }",
    "};",
    "const log = (...parts) => {",
    "  if (logged >= request.logLimit) return;",
    '  const line = parts.map(show).join(" ").slice(0, request.logLimit - logged);',
    "  logs.push(line);",
    "  logged += line.length + 1;",
    "};",
    "const output = { log, info: log, warn: log, error: log, debug: log };",
    "const answer = (value) => {",
    "  writeSync(1, JSON.stringify({ ...value, logs }));",
    "  process.exit(0);",
    "};",
    "const canonical = (value) => JSON.stringify(value, (_key, item) =>",
    '  item !== null && typeof item === "object" && !Array.isArray(item)',
    "    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))",
    "    : item);",
    'const failure = (error) => (error?.name ?? "Error") + ": " + (error?.message ?? String(error));',
    "let sequence = 0;",
    "const call = (app, tool, input) => {",
    "  const seq = sequence++;",
    "  const given = input === undefined ? {} : input;",
    '  if (given === null || typeof given !== "object" || Array.isArray(given))',
    '    return Promise.reject(new TypeError("apps." + app + "." + tool + " takes one object of arguments"));',
    "  const args = JSON.parse(JSON.stringify(given));",
    "  const done = request.calls[seq];",
    '  if (done === undefined) answer({ status: "call", seq, app, tool, arguments: args });',
    "  if (done.app !== app || done.tool !== tool || canonical(done.arguments) !== canonical(args))",
    '    answer({ status: "not_repeatable", seq });',
    '  if (typeof done.error === "string") return Promise.reject(new Error(done.error));',
    "  return Promise.resolve(done.text);",
    "};",
    "const member = (read) => new Proxy({}, {",
    '  get: (_target, key) => (typeof key !== "string" || key === "then" ? undefined : read(key)),',
    "});",
    "const apps = member((app) => member((tool) => (input) => call(app, tool, input)));",
    "const AsyncFunction = (async () => undefined).constructor;",
    "let run;",
    "try {",
    '  run = new AsyncFunction("apps", "console", request.code);',
    "} catch (error) {",
    '  answer({ status: "error", message: failure(error) });',
    "}",
    "try {",
    "  const value = await run(apps, output);",
    "  let kept = null;",
    "  try { kept = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { kept = String(value); }",
    '  answer({ status: "done", value: kept });',
    "} catch (error) {",
    '  answer({ status: "error", message: failure(error) });',
    "}",
  ].join("\n"),
]);

export interface AppCodeRecordedCall {
  readonly app: string;
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly text?: string;
  readonly error?: string;
}

export interface AppCodeRunnerRequest {
  readonly code: string;
  readonly calls: readonly AppCodeRecordedCall[];
  readonly logLimit: number;
}

export type AppCodeRunnerAnswer =
  | {
      readonly status: "call";
      readonly seq: number;
      readonly app: string;
      readonly tool: string;
      readonly arguments: JsonObject;
      readonly logs: readonly string[];
    }
  | { readonly status: "done"; readonly value: unknown; readonly logs: readonly string[] }
  | { readonly status: "error"; readonly message: string; readonly logs: readonly string[] }
  | { readonly status: "not_repeatable"; readonly seq: number; readonly logs: readonly string[] };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function member(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function typeOf(schema: unknown, depth: number): string {
  if (schema === null || typeof schema !== "object" || depth > 3) return "unknown";
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node["enum"]) && node["enum"].length > 0)
    return node["enum"].map((value) => JSON.stringify(value)).join(" | ");
  const kinds = Array.isArray(node["type"]) ? node["type"] : [node["type"]];
  const parts = kinds.map((kind) => {
    switch (kind) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `${typeOf(node["items"], depth + 1)}[]`;
      case "object":
        return objectType(node, depth + 1);
      default:
        return node["properties"] === undefined ? "unknown" : objectType(node, depth + 1);
    }
  });
  return [...new Set(parts)].join(" | ");
}

function objectType(node: Record<string, unknown>, depth: number): string {
  const properties = node["properties"];
  if (properties === null || typeof properties !== "object") return "Record<string, unknown>";
  const required = new Set(
    Array.isArray(node["required"])
      ? node["required"].filter((key) => typeof key === "string")
      : [],
  );
  const fields = Object.entries(properties as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, value]) =>
        `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${typeOf(value, depth)}`,
    );
  return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
}

export function appToolSignature(app: string, tool: string, inputSchema: unknown): string {
  return `apps${member(app)}${member(tool)}(input: ${typeOf(inputSchema, 0)}): Promise<string>`;
}

export function parseRunnerAnswer(text: string): AppCodeRunnerAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const answer = value as Record<string, unknown>;
  const logs = Array.isArray(answer["logs"])
    ? answer["logs"].filter((line): line is string => typeof line === "string")
    : [];
  switch (answer["status"]) {
    case "call": {
      const args = answer["arguments"];
      if (
        typeof answer["seq"] !== "number" ||
        typeof answer["app"] !== "string" ||
        typeof answer["tool"] !== "string" ||
        args === null ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        return undefined;
      return {
        status: "call",
        seq: answer["seq"],
        app: answer["app"],
        tool: answer["tool"],
        arguments: args as JsonObject,
        logs,
      };
    }
    case "done":
      return { status: "done", value: answer["value"] ?? null, logs };
    case "error":
      return typeof answer["message"] === "string"
        ? { status: "error", message: answer["message"], logs }
        : undefined;
    case "not_repeatable":
      return typeof answer["seq"] === "number"
        ? { status: "not_repeatable", seq: answer["seq"], logs }
        : undefined;
    default:
      return undefined;
  }
}
