import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startScriptedModel } from "./opencode-review.fixtures.mjs";

const repositoryRoot = join(import.meta.dirname, "../..");
const DATA_HANDLER =
  /\.on\(\s*["']data["']\s*,[\s\S]{0,200}?\+=\s*(?:chunk(?![\w.])|String\(\s*chunk\s*\)|chunk\.toString\()/gu;

const GATE_FILES = new Set([
  "test/integration/request-body-decoding.test.ts",
  "test/tooling/request-body-decoding.test.mjs",
]);

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.mts", "*.mjs", "*.js"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "" && !path.includes("node_modules/") && !GATE_FILES.has(path));
}

const isRequestHandler = (source, offset) =>
  /\b(?:request|req|incoming)\s*$/u.test(source.slice(Math.max(0, offset - 20), offset));

describe("[I-82] request bodies are decoded once, after every byte has arrived", () => {
  it("no tracked server appends request chunks to a string", () => {
    const offenders = [];
    for (const path of trackedSources()) {
      const source = readFileSync(join(repositoryRoot, path), "utf8");
      for (const match of source.matchAll(DATA_HANDLER)) {
        if (isRequestHandler(source, match.index))
          offenders.push(`${path}:${source.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("REVERSE: the scan flags the old fake model server and its renamed variants", () => {
    const flagged = (text) =>
      [...text.matchAll(DATA_HANDLER)].filter((match) => isRequestHandler(text, match.index))
        .length;
    expect(flagged('request.on("data", (chunk) => {\n  body += chunk;\n});')).toBe(1);
    expect(flagged("req.on('data', (chunk) => { raw += chunk.toString(\"utf8\") })")).toBe(1);
    expect(flagged('incoming.on("data", (chunk) => { text += String(chunk); });')).toBe(1);
    expect(flagged('request.on("data", (chunk) => { byteLength += chunk.length; });')).toBe(0);
    expect(flagged('child.stdout.on("data", (chunk) => { output += chunk; });')).toBe(0);
  });

  it("the scripted model keeps a character that arrives split across two chunks", async () => {
    const filler = "设".repeat(20);
    const message = `${filler}设计`;
    const scripted = await startScriptedModel(() => ({ text: "ok" }));
    try {
      const bytes = Buffer.from(
        JSON.stringify({
          model: "m",
          tools: [{ type: "function" }],
          messages: [{ role: "user", content: message }],
        }),
        "utf8",
      );
      const cut = bytes.indexOf(Buffer.from("计", "utf8")) + 1;
      await new Promise((resolve, reject) => {
        const outgoing = http.request(
          {
            host: "127.0.0.1",
            port: scripted.port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "transfer-encoding": "chunked", "content-type": "application/json" },
          },
          (response) => {
            response.resume();
            response.on("end", resolve);
          },
        );
        outgoing.on("error", reject);
        outgoing.write(bytes.subarray(0, cut));
        setTimeout(() => outgoing.end(bytes.subarray(cut)), 50);
      });
      expect(scripted.requests).toHaveLength(1);
      expect(scripted.requests[0].messages[0].content).toBe(message);
    } finally {
      await new Promise((resolve) => scripted.server.close(resolve));
    }
  });
});
