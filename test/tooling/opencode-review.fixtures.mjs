import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  installGitGuard,
  opencodeBinary,
  reviewConfig,
  reviewModel,
  WRAP_UP_PROMPT,
} from "../../scripts/model-review/opencode-review.mjs";

export function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export const instructions = readFileSync(
  new URL("../../.agents/instructions/model-review.md", import.meta.url),
  "utf8",
);

export function toolRequest(names, overrides = {}) {
  return {
    model: "deepseek-v4.1-flash",
    max_tokens: 200000,
    reasoning_effort: "high",
    tools: names.map((name) => ({ type: "function", function: { name } })),
    ...overrides,
  };
}

export function processState(
  pid,
  { platform = process.platform, read = readFileSync, signal = process.kill } = {},
) {
  try {
    if (platform !== "linux") {
      signal(pid, 0);
      return "alive";
    }
    return read(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
  } catch (error) {
    const goneCodes = platform === "linux" ? ["ENOENT", "ESRCH"] : ["ESRCH"];
    if (goneCodes.includes(error.code)) return "gone";
    throw error;
  }
}

export function startScriptedModel(reply, record = (parsed) => parsed) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      const parsed = JSON.parse(body);
      const main =
        (Array.isArray(parsed.tools) && parsed.tools.length > 0) ||
        JSON.stringify(parsed.messages ?? []).includes(WRAP_UP_PROMPT);
      if (main) requests.push(record(parsed));
      const send = (payload) =>
        response.write(
          `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: parsed.model, ...payload })}\n\n`,
        );
      const step = main ? reply(parsed, requests.length) : { text: "title" };
      const callId = `call-${requests.length}`;
      if (step.status) {
        response.writeHead(step.status, {
          "content-type": "application/json",
          ...(step.retryAfter ? { "retry-after": String(step.retryAfter) } : {}),
        });
        response.end(JSON.stringify({ error: { type: "server_error", message: "BUSY_CELL" } }));
        return;
      }
      const answer = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const delta = { role: "assistant" };
        if (step.thinking) delta.reasoning_content = step.thinking;
        if (step.text) delta.content = step.text;
        if (step.tool)
          delta.tool_calls = [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ filePath: "AGENTS.md" }) },
            },
          ];
        send({ choices: [{ index: 0, delta, finish_reason: null }] });
        send({
          choices: [{ index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens: step.promptTokens ?? 1,
            completion_tokens: 1,
            total_tokens: (step.promptTokens ?? 1) + 1,
          },
        });
        response.end("data: [DONE]\n\n");
      };
      const holdMs = (step.holdUntil ?? 0) - Date.now();
      if (holdMs > 0) setTimeout(answer, holdMs);
      else answer();
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, requests, port: server.address().port }),
    ),
  );
}

export async function withScriptedReview(reply, run, { record } = {}) {
  const root = mkdtempSync(join(tmpdir(), "opencode-wrap-"));
  const { server, requests, port } = await startScriptedModel(reply, record);
  try {
    const copy = join(root, "repo");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${process.cwd()}`, copy]);
    const gitGuard = installGitGuard(root);
    const baseURL = `http://127.0.0.1:${port}/v1`;
    const configPath = join(root, "review.json");
    const wrapUpConfigPath = join(root, "wrap-up.json");
    writeFileSync(configPath, JSON.stringify(reviewConfig({ mode: "plan", baseURL })));
    writeFileSync(
      wrapUpConfigPath,
      JSON.stringify(reviewConfig({ mode: "plan", baseURL, wrapUp: true })),
    );
    const review = (options = {}) =>
      reviewModel({
        binary: opencodeBinary(),
        cwd: copy,
        configPath,
        wrapUpConfigPath,
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 120000,
        ...options,
      });
    return await run({ review, requests, port });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

export function slowStepFinishBinary(dir) {
  const path = join(dir, "slow-opencode.sh");
  writeFileSync(
    path,
    [
      "#!/bin/bash",
      "set -o pipefail",
      `${JSON.stringify(opencodeBinary())} "$@" | while IFS= read -r line; do`,
      `  case "$line" in *'"step_finish"'*) sleep 1; printf 'x' >> ${JSON.stringify(join(dir, "delayed"))};; esac`,
      `  printf '%s\\n' "$line"`,
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return path;
}

export function isWrapUp(request) {
  return JSON.stringify(request.messages ?? []).includes(WRAP_UP_PROMPT);
}

export function firstChangedMessage(earlier, later) {
  const index = earlier.messages.findIndex(
    (message, position) => JSON.stringify(message) !== JSON.stringify(later.messages[position]),
  );
  if (index < 0) return "";
  const before = JSON.stringify(earlier.messages[index] ?? null);
  const after = JSON.stringify(later.messages[index] ?? null);
  let at = 0;
  while (at < before.length && before[at] === after[at]) at += 1;
  const start = Math.max(0, at - 300);
  const shown = (text) => `${start > 0 ? "…" : ""}${text.slice(start, at + 1200)}`;
  return [
    `message ${index} of ${earlier.messages.length} changed (later request has ${later.messages.length}); first difference at character ${at} of ${before.length} (later ${after.length})`,
    `earlier: ${shown(before)}`,
    `later:   ${shown(after)}`,
  ].join("\n");
}

export function expectAppendedTo(earlier, later) {
  expect(later.tools).toEqual(earlier.tools);
  expect(
    later.messages.slice(0, earlier.messages.length),
    firstChangedMessage(earlier, later),
  ).toEqual(earlier.messages);
  expect(later.messages.length).toBeGreaterThan(earlier.messages.length);
}

export async function authorizationSent({ savedKey, environmentKey }) {
  const root = mkdtempSync(join(tmpdir(), "opencode-credential-"));
  const headers = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method === "POST") headers.push(request.headers.authorization ?? null);
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"credential probe"}}');
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const dataHome = join(root, "data");
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  if (savedKey) {
    writeFileSync(
      join(dataHome, "opencode", "auth.json"),
      JSON.stringify({ "opencode-go": { type: "api", key: savedKey } }),
    );
  }
  const isolated = {
    XDG_DATA_HOME: dataHome,
    OPENCODE_API_KEY: environmentKey,
    OPENCODE_AUTH_CONTENT: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(isolated).map((name) => [name, process.env[name]]),
  );
  const setEnv = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  setEnv(isolated);
  try {
    const copy = join(root, "repo");
    mkdirSync(copy);
    execFileSync("git", ["init", "--quiet"], { cwd: copy });
    const review = reviewConfig({ mode: "code-review" });
    const provider = review.provider["opencode-go"];
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    const configPath = join(root, "review.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...review,
        provider: { "opencode-go": { ...provider, options: { ...provider.options, baseURL } } },
      }),
    );
    await reviewModel({
      binary: opencodeBinary(),
      cwd: copy,
      configPath,
      wrapUpConfigPath: configPath,
      gitGuard: installGitGuard(root),
      model: "opencode-go/deepseek-v4.1-flash",
      prompt: "REVIEW_TASK",
      timeoutMs: 60000,
    });
    return headers;
  } finally {
    setEnv(previous);
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

export const fakeOpenAiKey = ["sk", "abcdefghijklmnopqrstuv"].join("-");
