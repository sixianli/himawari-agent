import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReviewed,
  budgetCheck,
  buildPrompt,
  COST_LIMIT_PER_MODEL_USD,
  clearStopRequest,
  installGitGuard,
  isTestFile,
  keepEarlierAttempt,
  LOW_FIX_MAX_FILES,
  LOW_FIX_MAX_LINES_PER_FILE,
  ledgerLine,
  maskedRecordText,
  maskSecretLike,
  nextRound,
  OWNER_STOPPED,
  parseArgs,
  parseUsage,
  lowFixChecker,
  parseVerdicts,
  previousProblem,
  proxyCredentialProblems,
  RAW_FILE_SUFFIXES,
  RECORD_SECRET_RULES,
  DEFAULT_REVIEW_MODELS,
  REVIEW_MODELS,
  REVIEW_REPORT_DISCLAIMER,
  REVIEWS_DIR,
  readUsage,
  recordSecretProblems,
  requestStop,
  resultLine,
  reviewModel,
  reviewQuestions,
  reviewReport,
  roundForRun,
  roundsOnDisk,
  secretLikeRules,
  loadRegisteredTestValues,
  registerTestValuesFromRefs,
  registeredTestValuesFromToml,
  setRegisteredTestValues,
  signalHandler,
  spentOf,
  WRAP_UP_MIN_USD,
  WRAP_UP_RESERVE_USD,
  waitUnlessStopped,
} from "../../scripts/model-review/opencode-review.mjs";
import {
  completedCount,
  effectiveCost,
  guardDecision,
  ledgerTotal,
  noteCost,
  SpendGuard,
} from "../../scripts/model-review/spend-guard.mjs";
import {
  authorizationSent,
  fakeOpenAiKey,
  instructions,
  isWrapUp,
  slowStepFinishBinary,
  withScriptedReview,
} from "./opencode-review.fixtures.mjs";

describe("opencode review wrap-up", () => {
  const killedWithMarker = async (marker, timeoutMs = 3000) => {
    const root = mkdtempSync(join(tmpdir(), "opencode-inflight-"));
    try {
      const binary = join(root, "fake-opencode");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'if (process.argv.includes("--session")) process.exit(0);',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          `fs.writeFileSync(limits.markerPath, JSON.stringify(${JSON.stringify({ loaded: true, reason: null, totalCostUsd: 0.01, allowed: 2, completed: 1, at: 0, ...marker })}));`,
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.01 } }));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      return await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard: installGitGuard(root),
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("[I-77] counts a request still in flight when the parent has to kill the run", async () => {
    const result = await killedWithMarker({});
    expect(result.runs[0].stopReason).toBe("wrap-up-time");
    expect(result.runs[0].inFlight).toBe(true);
    expect(result.summary.usage.inFlight).toBe(true);
    expect(spentOf([{ cost: 0.01, inFlight: true }])).toBe(COST_LIMIT_PER_MODEL_USD);
    expect(spentOf([{ cost: 0.19, inFlight: true }])).toBeCloseTo(0.19 + WRAP_UP_RESERVE_USD);
  }, 60000);

  it("[owner stop] a stop request ends the running model, records what it spent and opens no follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-owner-stop-"));
    const ready = join(root, "ready");
    try {
      const binary = join(root, "fake-opencode");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          `fs.writeFileSync(limits.markerPath, JSON.stringify(${JSON.stringify({ loaded: true, reason: null, totalCostUsd: 0.03, allowed: 2, completed: 1, at: 0 })}));`,
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.03 } }));',
          `fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const gitGuard = installGitGuard(root);
      const running = reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      while (!existsSync(ready)) await new Promise((wait) => setTimeout(wait, 50));
      requestStop();
      const result = await running;
      expect(result.outcome).toBe(OWNER_STOPPED);
      expect(result.runs).toHaveLength(1);
      expect(result.summary.usage.cost).toBeCloseTo(0.03);
      expect(result.summary.usage.inFlight).toBe(true);
      const late = await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard,
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      expect(late.outcome).toBe(OWNER_STOPPED);
    } finally {
      clearStopRequest();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("[owner stop] a stop request cuts short the wait before an API-error retry", async () => {
    try {
      const started = Date.now();
      const waiting = waitUnlessStopped(60000);
      setTimeout(() => requestStop(), 50);
      await waiting;
      expect(Date.now() - started).toBeLessThan(5000);
      const after = Date.now();
      await waitUnlessStopped(60000);
      expect(Date.now() - after).toBeLessThan(1000);
    } finally {
      clearStopRequest();
    }
  });

  it("[owner stop] the first signal asks the models to stop, the second one or the grace period forces the exit", async () => {
    const calls = [];
    const make = (running, graceMs = 60000) =>
      signalHandler({
        running: () => running,
        requestStop: (reason) => calls.push(`stop ${reason}`),
        cleanup: () => calls.push("cleanup"),
        exit: (code) => calls.push(`exit ${code}`),
        graceMs,
      });
    make(false)("SIGTERM");
    expect(calls).toEqual(["cleanup", "exit 143"]);
    calls.length = 0;
    const handler = make(true);
    handler("SIGINT");
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`]);
    handler("SIGINT");
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`, "cleanup", "exit 130"]);
    calls.length = 0;
    const slow = make(true, 20);
    slow("SIGTERM");
    await new Promise((wait) => setTimeout(wait, 100));
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`, "cleanup", "exit 143"]);
    calls.length = 0;
    const settled = make(true, 20);
    settled("SIGTERM");
    settled.dispose();
    await new Promise((wait) => setTimeout(wait, 100));
    expect(calls).toEqual([`stop ${OWNER_STOPPED}`]);
  });

  it("[I-77] hands the first run's recorded cost to the resumed run as its starting point", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-start-"));
    try {
      const binary = join(root, "fake-opencode");
      const startFile = join(root, "starting.txt");
      writeFileSync(
        binary,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const limits = JSON.parse(fs.readFileSync(process.env.HIMAWARI_SPEND_GUARD, "utf8"));',
          'if (process.argv.includes("--session")) {',
          `  fs.writeFileSync(${JSON.stringify(startFile)}, String(limits.startingUsd));`,
          '  console.log(JSON.stringify({ type: "text", sessionID: "ses_x", part: { text: "ANSWER" } }));',
          '  console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "stop", tokens: {}, cost: 0.001 } }));',
          "  process.exit(0);",
          "}",
          'console.log(JSON.stringify({ type: "step_finish", sessionID: "ses_x", part: { reason: "tool-calls", tokens: {}, cost: 0.16 } }));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      chmodSync(binary, 0o755);
      const result = await reviewModel({
        binary,
        cwd: root,
        configPath: join(root, "unused.json"),
        wrapUpConfigPath: join(root, "unused.json"),
        gitGuard: installGitGuard(root),
        model: "opencode-go/deepseek-v4.1-flash",
        prompt: "REVIEW_TASK",
        timeoutMs: 60000,
      });
      expect(result.runs).toHaveLength(2);
      expect(Number(readFileSync(startFile, "utf8"))).toBeCloseTo(0.16);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("[I-77] keeps the reason the guard wrote even when the parent's timer fires before the process exits", async () => {
    const result = await killedWithMarker({ reason: "wrap-up-cost", allowed: 1, completed: 1 });
    expect(result.runs[0].stopReason).toBe("wrap-up-cost");
    expect(result.runs[0].inFlight).toBe(false);
  }, 60000);

  it("[I-77] lets the single wrap-up request through even though the money line was already crossed", async () => {
    await withScriptedReview(
      (request) =>
        isWrapUp(request) ? { text: "COST_WRAPPED" } : { tool: true, promptTokens: 120000 },
      async ({ review, requests }) => {
        const result = await review();
        expect(result.runs).toHaveLength(2);
        expect(requests.filter(isWrapUp)).toHaveLength(1);
        expect(result.outcome).toBe("ok");
        expect(result.runs[1].guard.totalCostUsd).toBeGreaterThanOrEqual(
          result.runs[0].guard.totalCostUsd,
        );
        expect(result.runs[1].guard.completed).toBeLessThanOrEqual(result.runs[1].guard.allowed);
      },
    );
  }, 120000);

  it("[I-77] still loads the guard when the environment asks opencode to skip external plugins", async () => {
    const saved = process.env.OPENCODE_PURE;
    process.env.OPENCODE_PURE = "1";
    try {
      await withScriptedReview(
        () => ({ text: "FIRST_ANSWER" }),
        async ({ review }) => {
          const result = await review();
          expect(result.runs[0].guard.loaded).toBe(true);
          expect(result.runs[0].guard.allowed).toBe(1);
        },
      );
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_PURE;
      else process.env.OPENCODE_PURE = saved;
    }
  }, 120000);

  it("stops the wrap-up turn at its first tool call instead of letting it keep reading", async () => {
    const slow = mkdtempSync(join(tmpdir(), "opencode-slow-"));
    try {
      await withScriptedReview(
        (_request, index) =>
          index === 1 ? { thinking: "THOUGHT_ONLY" } : { tool: true, promptTokens: 100000 },
        async ({ review, requests }) => {
          const result = await review({ binary: slowStepFinishBinary(slow) });
          expect(result.wrapUp).toBe("no-text");
          expect(result.outcome).toBe("wrap-up-tool-call");
          expect(requests.filter(isWrapUp)).toHaveLength(1);
          expect(result.summary.usage.cost).toBeGreaterThan(0.01);
          const wrapUpCall = result.summary.toolCalls.at(-1);
          expect(wrapUpCall.status).toBe("error");
          expect(wrapUpCall.output).toContain("rejected permission");
          const stepFinishes = result.stdout
            .split("\n")
            .filter((line) => line.includes('"step_finish"')).length;
          expect(stepFinishes).toBeGreaterThanOrEqual(2);
          expect(readFileSync(join(slow, "delayed"), "utf8")).toHaveLength(stepFinishes);
        },
      );
    } finally {
      rmSync(slow, { recursive: true, force: true });
    }
  }, 120000);

  it("records cost-limit when the wrap-up step that calls a tool also runs past the remaining money", async () => {
    await withScriptedReview(
      (request, index) =>
        index === 1
          ? { thinking: "THOUGHT_ONLY" }
          : { tool: true, promptTokens: isWrapUp(request) ? 4000000 : 1 },
      async ({ review }) => {
        const result = await review();
        expect(result.wrapUp).toBe("no-text");
        expect(result.summary.toolCalls.length).toBeGreaterThan(0);
        expect(result.outcome).toBe("cost-limit");
      },
    );
  }, 120000);

  it("skips the wrap-up turn when too little money is left for it, and says why", async () => {
    await withScriptedReview(
      () => ({ thinking: "THOUGHT_ONLY", promptTokens: 10000 }),
      async ({ review, requests }) => {
        const result = await review({ costLimit: WRAP_UP_MIN_USD + 0.001 });
        expect(result.wrapUp).toBe("cost");
        expect(result.wrapUpSkipped).toBe("no-budget");
        expect(result.outcome).toBe("wrap-up-cost");
        expect(requests.filter(isWrapUp)).toHaveLength(0);
      },
    );
  }, 120000);

  it("[api error] waits and runs the review again after the service stays busy, and adds up both costs", async () => {
    await withScriptedReview(
      (_request, index) =>
        index <= 6 ? { status: 429, retryAfter: 1 } : { text: "AFTER_RETRY", promptTokens: 1000 },
      async ({ review, requests }) => {
        const started = Date.now();
        const result = await review({ retryWaitMs: 3000 });
        expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
        expect(result.outcome).toBe("ok");
        expect(result.retry).toBe("retried");
        expect(result.retriedAfter).toContain("BUSY_CELL");
        expect(result.summary.text).toBe("AFTER_RETRY");
        expect(result.summary.apiError).toBeNull();
        expect(result.runs).toHaveLength(2);
        expect(requests).toHaveLength(7);
        expect(requests[6].messages).toEqual(requests[0].messages);
      },
    );
  }, 120000);

  it("[api error] retries only once and records the service error when it is still busy", async () => {
    await withScriptedReview(
      () => ({ status: 429, retryAfter: 1 }),
      async ({ review, requests }) => {
        const result = await review({ retryWaitMs: 1000 });
        expect(result.outcome).toBe("api-error");
        expect(result.retry).toBe("retried");
        expect(result.summary.apiError).toMatchObject({ statusCode: 429, retryable: true });
        expect(result.runs).toHaveLength(2);
        expect(requests).toHaveLength(12);
      },
    );
  }, 120000);

  it("[owner stop] a stop during the wait before an API-error retry ends it at once and does not retry", async () => {
    await withScriptedReview(
      () => ({ status: 429, retryAfter: 1 }),
      async ({ review, requests }) => {
        try {
          const started = Date.now();
          const running = review({ retryWaitMs: 60000, timeoutMs: 300000 });
          while (requests.length < 6) await new Promise((wait) => setTimeout(wait, 50));
          await new Promise((wait) => setTimeout(wait, 1000));
          requestStop();
          const result = await running;
          expect(Date.now() - started).toBeLessThan(45000);
          expect(result.outcome).toBe(OWNER_STOPPED);
          expect(result.retry).toBe(OWNER_STOPPED);
          expect(result.runs).toHaveLength(1);
          expect(requests).toHaveLength(6);
        } finally {
          clearStopRequest();
        }
      },
    );
  }, 120000);

  it("[api error] does not retry a refusal the service marks as final", async () => {
    await withScriptedReview(
      () => ({ status: 401 }),
      async ({ review }) => {
        const result = await review({ retryWaitMs: 1000 });
        expect(result.outcome).toBe("api-error");
        expect(result.summary.apiError).toMatchObject({ statusCode: 401, retryable: false });
        expect(result.retry).toBeNull();
        expect(result.runs).toHaveLength(1);
      },
    );
  }, 120000);

  it("does not ask again when the first answer is already there", async () => {
    await withScriptedReview(
      () => ({ text: "FIRST_ANSWER" }),
      async ({ review, requests }) => {
        const result = await review();
        expect(result.wrapUp).toBeNull();
        expect(result.summary.text).toBe("FIRST_ANSWER");
        expect(requests).toHaveLength(1);
      },
    );
  }, 120000);
});

describe("opencode review credentials", () => {
  it("[OpenCode 401] sends the key saved by opencode auth login, not a placeholder", async () => {
    const savedKey = `saved-${randomBytes(6).toString("hex")}`;
    const headers = await authorizationSent({ savedKey });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBe(`Bearer ${savedKey}`);
  }, 120000);

  it("[OpenCode 401] prefers the key saved by opencode auth login over OPENCODE_API_KEY", async () => {
    const savedKey = `saved-${randomBytes(6).toString("hex")}`;
    const headers = await authorizationSent({
      savedKey,
      environmentKey: `environment-${randomBytes(6).toString("hex")}`,
    });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBe(`Bearer ${savedKey}`);
  }, 120000);

  it("[OpenCode 401] sends no key of its own when none is saved, so the cloud proxy can add one", async () => {
    const headers = await authorizationSent({ savedKey: null });
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBeNull();
  }, 120000);
});

describe("opencode review record masking", () => {
  it("masks text the machine-secret scan would report, rule by rule", () => {
    const samples = {
      "openai-api-key": fakeOpenAiKey,
      "github-token": ["gh", "p_", "A".repeat(24)].join(""),
      "aws-access-key": ["AKIA", "B".repeat(16)].join(""),
      "jwt-token": ["eyJ", "a".repeat(10), ".", "b".repeat(10), ".", "c".repeat(10)].join(""),
      "authorization-bearer": ["Bearer", "x".repeat(16)].join(" "),
      "credential-assignment": ["pass", "word: ", "y".repeat(14)].join(""),
      "private-key-any-block": [
        ["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" "),
        "z".repeat(40),
        ["-----END", "ENCRYPTED PRIVATE KEY-----"].join(" "),
      ].join("\n"),
      "private-key-header": `说明 ${["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" ")} 后面只有文字`,
      "private-key-block": [
        ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
        "z".repeat(20),
        ["-----END", "PRIVATE KEY-----"].join(" "),
      ].join("\n"),
    };
    expect(Object.keys(samples).sort()).toEqual(RECORD_SECRET_RULES.map(([id]) => id).sort());
    for (const [id, sample] of Object.entries(samples)) {
      expect(secretLikeRules(`说明 ${sample} 结束`)).toContain(id);
      const masked = maskSecretLike(`说明 ${sample} 结束`);
      expect(masked).toContain(`[已遮盖:${id}]`);
      expect(masked).not.toContain(sample);
      expect(secretLikeRules(masked)).toEqual([]);
    }
  });

  it("[round-2 R2-1] masks private-key headers of any case and prefix, as gitleaks does", () => {
    for (const label of [
      "OPENSSH PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "pgp private key block",
      "FOO_BAR-BAZ PRIVATE KEY",
    ]) {
      const text = `x -----BEGIN ${label}----- y`;
      expect(secretLikeRules(text)).toContain("private-key-header");
      expect(maskSecretLike(text)).toBe("x [已遮盖:private-key-header] y");
    }
    expect(secretLikeRules("-----BEGIN CERTIFICATE-----")).toEqual([]);
  });

  it("[round-3 R3-1] masks the body of non-RSA private key blocks, not only the header", () => {
    const body = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(3);
    for (const label of ["ENCRYPTED PRIVATE KEY", "DSA PRIVATE KEY", "pgp private key block"]) {
      const text = `a -----BEGIN ${label}-----\n${body}\n-----END ${label}----- b`;
      const masked = maskSecretLike(text);
      expect(masked).not.toContain(body);
      expect(secretLikeRules(masked)).toEqual([]);
    }
    const lone = `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")} ${"说明".repeat(5000)}`;
    expect(maskSecretLike(lone)).toContain("说明说明");
  });

  it("[round-2 R2-2] a ledger line stays valid JSON when a field ends in secret-like text", () => {
    const tail = ["pass", "word: ", "y".repeat(14)].join("");
    const record = {
      mode: "override",
      quote: tail,
      problems: [tail, "ok"],
      nested: { files: [tail] },
      cost: 0,
    };
    const line = ledgerLine(record);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.quote).toBe("[已遮盖:credential-assignment]");
    expect(parsed.problems).toEqual(["[已遮盖:credential-assignment]", "ok"]);
    expect(parsed.nested.files).toEqual(["[已遮盖:credential-assignment]"]);
    expect(parsed.cost).toBe(0);
    expect(secretLikeRules(line)).toEqual([]);
  });

  it("[round-2 R2-3] every ledger writer goes through ledgerLine, none stringifies and masks afterwards", () => {
    const source = readFileSync(
      new URL("../../scripts/model-review/opencode-review.mjs", import.meta.url),
      "utf8",
    );
    const appends = [
      ...source.matchAll(
        /appendFileSync\(\s*(?:ledgerFile|join\(options\.out, "usage\.jsonl"\)),([\s\S]*?)\)\s*;\s*\n/g,
      ),
    ];
    expect(appends.length).toBe(3);
    for (const [, body] of appends) {
      expect(body).toContain("ledgerLine(");
      expect(body).not.toContain("JSON.stringify");
      expect(body).not.toContain("maskSecretLike(");
    }
  });

  it("leaves ordinary review prose alone, including short sk- words and key names", () => {
    const prose = "- 低度：sk-short 太短不算；apiKey 这个字段名没有值；Bearer 后面没有令牌";
    expect(secretLikeRules(prose)).toEqual([]);
    expect(maskedRecordText(prose)).toBe(`${prose}\n`);
  });

  it("uses exactly the rules of scripts/scan-machine-secrets.mjs, so the two cannot drift apart", () => {
    const scan = readFileSync(
      new URL("../../scripts/scan-machine-secrets.mjs", import.meta.url),
      "utf8",
    );
    for (const [id, pattern] of RECORD_SECRET_RULES) {
      if (id === "private-key-header" || id === "private-key-any-block") continue;
      expect(scan).toContain(`"${id}"`);
      expect(scan).toContain(pattern.toString());
    }
    const scanIds = [...scan.matchAll(/^\s*\[?\s*"([a-z-]+)",/gm)].map((match) => match[1]);
    const recordOnly = RECORD_SECRET_RULES.map(([id]) => id).filter((id) => !scanIds.includes(id));
    expect(recordOnly).toEqual(["private-key-any-block", "private-key-header"]);
    expect(scanIds.sort()).toEqual(
      RECORD_SECRET_RULES.map(([id]) => id)
        .filter((id) => !recordOnly.includes(id))
        .sort(),
    );
  });
});

describe("opencode review merge gate", () => {
  const [deepseek, glm] = REVIEW_MODELS;
  const ok = (round, head, model, extra = {}) => ({
    at: "t",
    cost: 0.05,
    round,
    mode: "code-review",
    model,
    head,
    outcome: "ok",
    steps: 3,
    input: 10,
    cacheRead: 5,
    output: 2,
    reasoning: 1,
    ...extra,
  });
  const fixture = (baseText = "base\n", featureText = "feature\n", rules = "") => {
    const root = mkdtempSync(join(tmpdir(), "opencode-merge-gate-"));
    const repo = join(root, "repo");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
    const commit = (files, message) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const ledger = `${REVIEWS_DIR}/pr-7/usage.jsonl`;
    const writeLedger = (records) =>
      commit({ [ledger]: records.map((r) => `${JSON.stringify(r)}\n`).join("") }, "records");
    const main = commit({ "code.txt": baseText, "ci/rules/gitleaks.toml": rules }, "base");
    git("update-ref", "refs/remotes/origin/main", main);
    git("checkout", "--quiet", "-b", "feature");
    const reviewed = commit({ "code.txt": featureText }, "feature");
    const check = (extra = {}) => assertReviewed({ repo, pr: 7, mainRef: "origin/main", ...extra });
    return { root, repo, git, commit, writeLedger, main, reviewed, check, ledger };
  };

  it("[merge gate] passes when only the PR's own records changed after the last complete round", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const result = f.check();
      expect(result.problems).toEqual([]);
      expect(result.lines[0]).toMatch(
        new RegExp(`^REVIEW_CURRENT pr=7 round=1 reviewed=${f.reviewed} head=[0-9a-f]{40}$`),
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] refuses records that carry secret-like text and accepts the masked form", () => {
    const f = fixture();
    try {
      const note = `${fakeOpenAiKey} is a split fake value\n`;
      f.commit({ [`${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md`]: note }, "raw record");
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      expect(f.check().problems).toEqual([
        `record-secret-like ${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md openai-api-key`,
      ]);
      f.commit(
        { [`${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md`]: maskedRecordText(note) },
        "masked record",
      );
      expect(f.check().problems).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] leaves registered test values to gitleaks and does not refuse a record that carries one", () => {
    const quote = "'''";
    const value = ["abcdef", "123456"].join("");
    const f = fixture(undefined, undefined, `regexes = [${quote}^${value}$${quote}]\n`);
    try {
      const path = `${REVIEWS_DIR}/pr-7/round-1/deepseek-v4.1-flash.md`;
      f.commit(
        { [path]: `- 命中 token=${value}\n` },
        "record from before the value was registered",
      );
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      expect(f.check().problems).toEqual([]);
      for (const args of [["--assert-reviewed"]]) {
        const run = spawnSync(
          process.execPath,
          ["scripts/model-review/opencode-review.mjs", ...args, "--pr", "7", "--repo", f.repo],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
        expect(run.stdout).toMatch(/REVIEW_CURRENT pr=7 /);
        expect(run.stdout).not.toContain("record-secret-like");
      }
      setRegisteredTestValues(
        registeredTestValuesFromToml(`regexes = [${quote}^${value}$${quote}]\n`),
      );
      expect(maskedRecordText(`token=${value}`)).toBe("token=[已遮盖:registered-test-value]\n");
    } finally {
      setRegisteredTestValues([]);
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] refuses a lone private-key header in a record that cannot be waived", () => {
    const f = fixture();
    try {
      const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
      f.commit(
        { [`${REVIEWS_DIR}/pr-7/round-1/glm-5.3-flash.md`]: `只有开头 ${header} 后面是文字\n` },
        "lone header",
      );
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const problems = f.check({ acceptUnreviewed: "Andy 说跳过" }).problems;
      expect(problems).toContain(
        `record-secret-like ${REVIEWS_DIR}/pr-7/round-1/glm-5.3-flash.md private-key-header`,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[round-3 R3-2] a secret-like change to another PR's records is refused even with --accept-unreviewed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit(
        { [`${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md`]: `${fakeOpenAiKey}\n` },
        "other pr record",
      );
      const result = f.check({ acceptUnreviewed: "Andy 说跳过" });
      expect(result.problems).toContain(
        `record-secret-like ${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md openai-api-key`,
      );
      expect(result.overridden).toBeFalsy();
      f.commit(
        {
          [`${REVIEWS_DIR}/pr-9/round-1/deepseek-v4.1-flash.md`]: maskedRecordText(
            `${fakeOpenAiKey}\n`,
          ),
        },
        "masked",
      );
      expect(f.check().problems.filter((p) => p.startsWith("record-"))).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] reports record-unreadable when the records cannot be listed", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    try {
      expect(recordSecretProblems({ repo: notARepo, ledgerPath: `${REVIEWS_DIR}/pr-7` })).toEqual([
        `record-unreadable ${REVIEWS_DIR}/pr-7`,
      ]);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("[merge gate] fails on any change after the review that is not just main arriving", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "docs/rule.md": "tightened\n" }, "small fix after review");
      expect(f.check().problems).toEqual(["unreviewed docs/rule.md"]);
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      expect(f.check().problems).toEqual([
        "unreviewed docs/rule.md",
        "main-not-merged origin/main",
      ]);
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "--no-edit",
        "origin/main",
      );
      expect(f.check().problems).toEqual(["unreviewed docs/rule.md"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  const mergeMain = (f) =>
    f.git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "merge",
      "--quiet",
      "--no-edit",
      "origin/main",
    );
  const moveMain = (f, files) => {
    f.git("checkout", "--quiet", "main");
    const ahead = f.commit(files, "main moved");
    f.git("update-ref", "refs/remotes/origin/main", ahead);
    f.git("checkout", "--quiet", "feature");
  };
  const lines = (...edits) => {
    const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    for (const [index, text] of edits) base[index] = text;
    return `${base.join("\n")}\n`;
  };

  it("[merge gate] a clean merge of main does not need another review round", () => {
    const f = fixture(lines(), lines([0, "feature"]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n", "code.txt": lines([11, "main edit"]) });
      expect(f.check().problems).toEqual(["main-not-merged origin/main"]);
      mergeMain(f);
      const result = f.check();
      expect(result.problems).toEqual([]);
      expect(result.lines[0]).toMatch(/^REVIEW_CURRENT /);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] a merge that adds a hand edit, or a PR change after the merge, is still unreviewed", () => {
    const f = fixture(lines(), lines([0, "feature"]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": lines([0, "feature"], [5, "hand edit"]) }, "hand edit");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] whitespace-only, mode-only and binary changes after the review are unreviewed", () => {
    const f = fixture(lines(), lines([0, "feature"]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": lines([0, "feature "]) }, "trailing space");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
      f.commit({ "code.txt": lines([0, "feature"]) }, "revert");
      expect(f.check().problems).toEqual([]);
      f.git("update-index", "--chmod=+x", "code.txt");
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "chmod");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] a binary file changed after the review is unreviewed", () => {
    const f = fixture("base\0one\n", "feature\0one\n");
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": "feature\0two\n" }, "binary changed");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] a change between two invalid UTF-8 byte values is unreviewed", () => {
    const f = fixture(lines(), Buffer.from([0x61, 0xff, 0x0a]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": Buffer.from([0x61, 0x80, 0x0a]) }, "other invalid byte");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] falls back to every changed file when the merge base cannot be found", () => {
    const f = fixture(lines(), lines([0, "feature"]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      expect(f.check().problems).toEqual([]);
      expect(f.check({ mainRef: "refs/none" }).problems).toContain("unreviewed other.txt");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] resolving a conflict with a different result is unreviewed", () => {
    const f = fixture(lines(), lines([0, "feature"]));
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      moveMain(f, { "code.txt": lines([0, "main version"]) });
      expect(() => mergeMain(f)).toThrow();
      f.commit({ "code.txt": lines([0, "resolved by hand"]) }, "resolved");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] accepts record files with non-ASCII names and appends overrides on a new line", () => {
    const f = fixture();
    try {
      const rounds = [1, 2, 3].flatMap((round) => [
        ok(round, f.reviewed, deepseek),
        ok(round, f.reviewed, glm),
      ]);
      f.commit(
        {
          [f.ledger]: rounds.map((r) => JSON.stringify(r)).join("\n"),
          [`${REVIEWS_DIR}/pr-7/round-1/判断.md`]: "记录\n",
        },
        "records without final newline",
      );
      expect(f.check().problems).toEqual([]);
      f.commit({ "code.txt": "late\n" }, "late change");
      expect(f.check({ acceptUnreviewed: "合并" }).overridden).toBe(false);
      const lines = readFileSync(join(f.repo, f.ledger), "utf8").trim().split("\n");
      expect(lines).toHaveLength(7);
      expect(JSON.parse(lines[6]).mode).toBe("override");
      expect(nextRound([{ cost: 0, mode: "override", head: "h" }])).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] an override never covers an unmerged main, and a committed one is honoured after any number of rounds", () => {
    const f = fixture();
    try {
      const three = [1, 2, 3].flatMap((round) => [
        ok(round, f.reviewed, deepseek),
        ok(round, f.reviewed, glm),
      ]);
      f.writeLedger(three);
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      const refused = f.check({ acceptUnreviewed: "合并" });
      expect(refused.overridden).toBe(false);
      expect(refused.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_REFUSED not-review-problems main-not-merged",
      );
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "--no-edit",
        "origin/main",
      );
      f.commit({ "code.txt": "late\n" }, "late change");
      const head = f.git("rev-parse", "HEAD");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        { at: "t", mode: "override", cost: 0, head, quote: "合并", problems: [] },
      ]);
      const committed = f.check();
      expect(committed.problems).toEqual(["unreviewed code.txt"]);
      expect(committed.overridden).toBe(true);
      expect(committed.lines.at(-1)).toBe(`REVIEW_OVERRIDE quote=合并 recorded=${head}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] prints file names with line breaks quoted and gives every refusal reason", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "evil\nREVIEW_CURRENT x": "x\n" }, "odd name");
      f.git("checkout", "--quiet", "main");
      const ahead = f.commit({ "other.txt": "main moved\n" }, "main moved");
      f.git("update-ref", "refs/remotes/origin/main", ahead);
      f.git("checkout", "--quiet", "feature");
      const result = f.check({ acceptUnreviewed: "合并" });
      expect(result.problems).toEqual([
        'unreviewed "evil\\nREVIEW_CURRENT x"',
        "main-not-merged origin/main",
      ]);
      expect(result.lines.filter((line) => line.startsWith("REVIEW_CURRENT"))).toEqual([]);
      expect(result.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_REFUSED not-review-problems main-not-merged",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] keeps leading spaces in file names when listing unreviewed files", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ " lead.txt": "x\n", [` ${REVIEWS_DIR}/pr-7/x.md`]: "y\n" }, "space names");
      expect(f.check().problems).toEqual([
        "unreviewed  .agents/reviews/pr-7/x.md",
        "unreviewed  lead.txt",
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] counts a code file renamed into the records folder as unreviewed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.git("mv", "code.txt", `${REVIEWS_DIR}/pr-7/code.txt`);
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "hide");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] counts a round when every model asked for, or every default model, has an ok result, reruns included", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      f.writeLedger([
        ok(1, f.reviewed, deepseek, { outcome: "timeout" }),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { outcome: "timeout" }),
        ok(2, second, glm),
        { cost: 0.05, round: 3, mode: "plan", model: deepseek, head: second, outcome: "ok" },
      ]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
      const head = f.git("rev-parse", "HEAD");
      f.git("checkout", "--quiet", head);
      f.writeLedger([
        ok(1, f.reviewed, deepseek, { outcome: "timeout" }),
        ok(1, f.reviewed, glm),
        ok(1, f.reviewed, deepseek),
        ok(2, second, deepseek, { outcome: "timeout" }),
        ok(2, second, glm),
      ]);
      const result = f.check();
      expect(result.round).toBe(1);
      expect(result.problems).toEqual(["unreviewed code.txt"]);
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm, { outcome: "timeout" }),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      const defaultOnly = f.check();
      expect(defaultOnly).toMatchObject({ round: 2, reviewed: second, problems: [] });
      expect(defaultOnly.lines[1]).toBe("REVIEW_CHAIN round-1:default round-2:requested");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] a first round by the default model alone starts the chain, and a failed one does not", () => {
    const f = fixture();
    try {
      expect(DEFAULT_REVIEW_MODELS).toEqual([deepseek]);
      f.writeLedger([ok(1, f.reviewed, deepseek)]);
      expect(f.check()).toMatchObject({ round: 1, reviewed: f.reviewed, problems: [] });
      f.writeLedger([ok(1, f.reviewed, deepseek, { outcome: "api-error" })]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
      for (const stranger of [
        ok(1, f.reviewed, "nobody/model"),
        ok(1, f.reviewed, glm, { substitute: "true", substituteFor: deepseek }),
        ok(1, f.reviewed, deepseek, { substitute: false }),
      ]) {
        f.writeLedger([stranger]);
        expect(f.check().problems).toEqual(["no-complete-round"]);
      }
      f.writeLedger([ok(1, f.reviewed, glm, { substitute: true, substituteFor: deepseek })]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
      f.writeLedger([
        ok(1, f.reviewed, deepseek, { outcome: "api-error" }),
        ok(2, f.reviewed, glm, { substitute: true, substituteFor: deepseek }),
      ]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
      f.writeLedger([
        ok(1, f.reviewed, deepseek, { outcome: "api-error" }),
        ok(1, f.reviewed, glm, { substitute: true, substituteFor: deepseek }),
      ]);
      expect(f.check()).toMatchObject({ round: 1, reviewed: f.reviewed, problems: [] });
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.main, deepseek, { substitute: false }),
        ok(1, f.main, glm, { substitute: "true", substituteFor: deepseek }),
      ]);
      expect(f.check()).toMatchObject({ round: 1, reviewed: f.reviewed, problems: [] });
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 2, reviewed: second, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:requested round-2:requested");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] a DeepSeek round after a full round covers the later commit", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 2, reviewed: second, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:requested round-2:requested");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] refuses a single-model round whose previous commit skips unreviewed work", () => {
    const f = fixture();
    try {
      const unreviewed = f.commit({ "code.txt": "unreviewed\n" }, "unreviewed");
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, ok(2, unreviewed, deepseek, { previous: unreviewed })]);
      expect(f.check().problems).toEqual([`chain-broken round=2 ${unreviewed}`]);
      for (const extra of [{}, { previous: null }]) {
        f.writeLedger([...first, ok(2, unreviewed, deepseek, extra)]);
        expect(f.check()).toMatchObject({ round: 2, reviewed: unreviewed, problems: [] });
      }
      f.writeLedger([...first, ok(2, unreviewed, deepseek, { previous: f.main })]);
      expect(f.check()).toMatchObject({ round: 2, problems: [] });
      const third = f.commit({ "code.txt": "third\n" }, "third");
      f.writeLedger([
        ...first,
        ok(2, unreviewed, deepseek, { previous: f.reviewed }),
        ok(3, third, deepseek, { previous: unreviewed }),
        ok(3, third, glm, { previous: unreviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 3, problems: [] });
      expect(result.lines[1]).toBe(
        "REVIEW_CHAIN round-1:requested round-2:requested round-3:requested",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] counts GLM beside a failed DeepSeek only when it stood in for DeepSeek", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      const failed = ok(2, second, deepseek, { outcome: "api-error", previous: f.reviewed });
      f.writeLedger([...first, failed, ok(2, second, glm, { previous: f.reviewed })]);
      expect(f.check()).toMatchObject({ round: 1, problems: ["unreviewed code.txt"] });
      f.writeLedger([...first, ok(2, second, glm, { substitute: true, substituteFor: glm })]);
      expect(f.check()).toMatchObject({ round: 1, problems: ["unreviewed code.txt"] });
      f.writeLedger([...first, ok(2, second, glm, { previous: f.reviewed })]);
      const named = f.check();
      expect(named).toMatchObject({ round: 2, problems: [] });
      expect(named.lines[1]).toBe("REVIEW_CHAIN round-1:requested round-2:requested");
      f.writeLedger([
        ...first,
        ok(2, second, deepseek, { outcome: "api-error", previous: f.reviewed }),
        ok(2, second, glm, { substitute: true, substituteFor: deepseek, previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result).toMatchObject({ round: 2, problems: [] });
      expect(result.lines[1]).toBe("REVIEW_CHAIN round-1:requested round-2:substitute");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] refuses a DeepSeek round on a commit the full round never led to", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "-b", "side", f.main);
      const rewritten = f.commit({ "code.txt": "rewritten\n" }, "rewritten");
      f.git("checkout", "--quiet", "feature");
      f.git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "merge",
        "--quiet",
        "-s",
        "ours",
        "-m",
        "take side",
        "side",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, rewritten, deepseek, { previous: f.reviewed }),
      ]);
      const result = f.check();
      expect(result.problems).toEqual([`chain-broken round=2 ${rewritten}`]);
      const broken = f.check({ acceptUnreviewed: "合并" });
      expect(broken.overridden).toBe(false);
      expect(broken.lines.at(-1)).toBe("REVIEW_OVERRIDE_WRITTEN quote=合并 commit-and-rerun");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review chain] the report accepts a DeepSeek-only last round and flags a failed one", () => {
    const f = fixture();
    try {
      const second = f.commit({ "code.txt": "fixed\n" }, "fix");
      const report = (stop) => reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop });
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, ok(2, second, deepseek, { previous: f.reviewed })]);
      expect(report("no-error").at(-2)).toBe("停下的原因：没有“会出错”的意见");
      expect(() => report("run-failed")).toThrow("REPORT_STOP_INCONSISTENT run-failed");
      f.writeLedger([
        ...first,
        ok(2, second, deepseek, { outcome: "timeout", previous: f.reviewed }),
      ]);
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
      expect(report("run-failed").at(-2)).toBe("停下的原因：有模型没跑完（outcome 不是 ok）");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  const answer = "严重度：低。tools.mjs:3 少了一个空行检查。";
  const verdict = (extra = {}) => ({
    id: "V1",
    model: deepseek,
    quote: "tools.mjs:3 少了一个空行检查",
    valid: true,
    class: "error",
    severity: "low",
    trigger: "输入为空行",
    consequence: "多打印一行空白",
    modelSeverity: "低",
    ...extra,
  });
  const lowFixFixture = (verdicts = [verdict()]) => {
    const f = fixture();
    const roundDir = `${REVIEWS_DIR}/pr-7/round-1`;
    f.commit(
      {
        [`${roundDir}/deepseek-v4.1-flash.md`]: `${answer}\n`,
        [`${roundDir}/verdicts.jsonl`]: verdicts.map((v) => `${JSON.stringify(v)}\n`).join(""),
      },
      "verdicts",
    );
    f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
    const commitLedgerOnDisk = () =>
      f.commit({ [f.ledger]: readFileSync(join(f.repo, f.ledger), "utf8") }, "low-fix record");
    return { ...f, commitLedgerOnDisk };
  };

  it("[low fix] accepts a small fix with a test change for a round whose errors are all low", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      const accepted = f.check({ acceptLow: 1 });
      expect(accepted.overridden).toBe(true);
      expect(accepted.lines.at(-1)).toMatch(
        /^REVIEW_LOW_FIX round=1 from=[0-9a-f]{40} head=[0-9a-f]{40} files=code\.txt,test\/code\.test\.mjs$/,
      );
      const records = parseUsage(readFileSync(join(f.repo, f.ledger), "utf8"), "ledger");
      expect(records.at(-1)).toMatchObject({
        mode: "low-fix",
        cost: 0,
        round: 1,
        from: f.reviewed,
        files: ["code.txt", "test/code.test.mjs"],
        findings: ["V1"],
      });
      expect(nextRound(records)).toBe(2);
      f.commitLedgerOnDisk();
      const after = f.check();
      expect(after.problems).toEqual([]);
      expect(after.lines[1]).toBe("REVIEW_CHAIN round-1:requested round-1:low-fix");
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain("低严重度已改、未复核：");
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      f.commit({ "code.txt": "again\n" }, "later change");
      expect(f.check().problems).toEqual(["unreviewed code.txt"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] counts only the PR's own files when main was merged after the review", () => {
    const f = lowFixFixture();
    try {
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      const accepted = f.check({ acceptLow: 1 });
      expect(accepted.overridden).toBe(true);
      expect(accepted.lines.at(-1)).toMatch(/ files=code\.txt,test\/code\.test\.mjs$/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] still accepts a record written before main-only files were left out", () => {
    const f = lowFixFixture();
    try {
      moveMain(f, { "other.txt": "main moved\n" });
      mergeMain(f);
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      expect(f.check({ acceptLow: 1 }).overridden).toBe(true);
      const edit = (extra) => {
        const lines = readFileSync(join(f.repo, f.ledger), "utf8").trimEnd().split("\n");
        const record = JSON.parse(lines.pop());
        record.files = [...record.files, extra];
        writeFileSync(join(f.repo, f.ledger), `${[...lines, JSON.stringify(record)].join("\n")}\n`);
        f.commitLedgerOnDisk();
      };
      edit("other.txt");
      expect(f.check().problems).toEqual([]);
      edit("bogus.txt");
      expect(f.check().problems).toEqual(["low-fix-invalid round=1 files-differ"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] allows one low-fix per round and reports the quotes from the record's own commit", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      expect(f.check({ acceptLow: 1 }).overridden).toBe(true);
      const firstFix = f.commitLedgerOnDisk();
      f.commit(
        {
          [`${REVIEWS_DIR}/pr-7/round-1/verdicts.jsonl`]: `${JSON.stringify(verdict({ quote: "改过的原话" }))}\n`,
        },
        "edit verdicts after acceptance",
      );
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      f.commit(
        { "code.txt": "fixed again\n", "test/code.test.mjs": "check again\n" },
        "second fix",
      );
      expect(f.check({ acceptLow: 1 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED already-low-fixed round=1",
      );
      const ledger = readFileSync(join(f.repo, f.ledger), "utf8");
      const head = f.git("rev-parse", "HEAD");
      const lowFix = JSON.parse(ledger.trim().split("\n").at(-1));
      f.commit(
        {
          [f.ledger]: `${ledger}${JSON.stringify({ ...lowFix, head, from: lowFix.head })}\n`,
        },
        "hand-written second low-fix",
      );
      expect(f.check().problems).toEqual(["low-fix-invalid round=1 second-low-fix"]);
      expect(firstFix).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] needs a test file with added lines and refuses file names with line breaks", () => {
    const refusal = (prepare) => {
      const f = lowFixFixture();
      try {
        prepare(f);
        return f.check({ acceptLow: 1 }).lines.at(-1);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    };
    expect(
      refusal((f) => f.commit({ "code.txt": "fixed\n", "test/README.md": "notes\n" }, "fix")),
    ).toBe("REVIEW_LOW_FIX_REFUSED no-test-change");
    expect(
      refusal((f) => {
        f.commit({ "test/old.test.mjs": "old\n" }, "add a test");
        f.writeLedger([
          ok(1, f.git("rev-parse", "HEAD"), deepseek),
          ok(1, f.git("rev-parse", "HEAD"), glm),
        ]);
        f.git("rm", "-q", "test/old.test.mjs");
        f.commit({ "code.txt": "fixed\n" }, "delete the test");
      }),
    ).toBe("REVIEW_LOW_FIX_REFUSED no-test-change");
    expect(
      refusal((f) =>
        f.commit({ "code.txt": "fixed\n", "test/odd\nname.test.mjs": "check\n" }, "fix"),
      ),
    ).toBe('REVIEW_LOW_FIX_REFUSED file-name-has-line-break "test/odd\\nname.test.mjs"');
  });

  it("[low fix] the report lists only low-fix records on the chain and marks the rest", () => {
    const f = lowFixFixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const record = {
        at: "t",
        mode: "low-fix",
        cost: 0,
        round: 1,
        head: fixed,
        from: f.reviewed,
        files: ["code.txt", "test/code.test.mjs"],
        findings: ["V1"],
      };
      const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)];
      f.writeLedger([...first, record, { ...record, round: 99 }]);
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "no-error",
      });
      expect(report).toContain(`  V1 deepseek-v4.1-flash：${verdict().quote}`);
      expect(report).toContain(
        `REVIEW_LOW_FIX_NOT_IN_CHAIN round=99 head=${fixed} files=code.txt,test/code.test.mjs`,
      );
      expect(report.filter((line) => line.startsWith("REVIEW_LOW_FIX "))).toHaveLength(1);
      f.writeLedger([...first, record, { ...record, findings: ["V9"] }]);
      const duplicated = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "看一下",
      });
      expect(duplicated.filter((line) => line.startsWith("REVIEW_LOW_FIX "))).toHaveLength(1);
      expect(duplicated).toContain(
        `REVIEW_LOW_FIX_NOT_IN_CHAIN round=1 head=${fixed} files=code.txt,test/code.test.mjs`,
      );
      expect(duplicated.join("\n")).not.toContain("V9 ");
      f.git("rm", "-q", `${REVIEWS_DIR}/pr-7/round-1/verdicts.jsonl`);
      const dropped = f.commit({ "other.txt": "x\n" }, "drop verdicts");
      f.writeLedger([...first, { ...record, head: dropped }]);
      const missing = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "看一下",
      });
      expect(missing).toContain(
        "REVIEW_LOW_FIX_NOT_IN_CHAIN round=1 head=" +
          dropped +
          " files=code.txt,test/code.test.mjs",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] lets a docs-only fix through without a test change", () => {
    const f = lowFixFixture();
    try {
      f.commit({ "docs/rule.md": "wording\n" }, "doc fix");
      expect(f.check({ acceptLow: 1 }).overridden).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] refuses medium or high errors, missing tests, oversized fixes and unproven quotes", () => {
    const refusal = (verdicts, files) => {
      const f = lowFixFixture(verdicts);
      try {
        if (files) f.commit(files, "fix");
        const result = f.check({ acceptLow: 1 });
        expect(result.overridden).toBe(false);
        expect(existsSync(join(f.repo, f.ledger))).toBe(true);
        expect(readFileSync(join(f.repo, f.ledger), "utf8")).not.toContain("low-fix");
        return result.lines.find((line) => line.startsWith("REVIEW_LOW_FIX_REFUSED"));
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    };
    const small = { "code.txt": "fixed\n", "test/code.test.mjs": "check\n" };
    expect(refusal([verdict({ severity: "medium-high", modelSeverity: "高" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED not-low V1",
    );
    expect(refusal([verdict()], { "code.txt": "fixed\n" })).toBe(
      "REVIEW_LOW_FIX_REFUSED no-test-change",
    );
    const many = Object.fromEntries(
      Array.from({ length: LOW_FIX_MAX_FILES + 1 }, (_, index) => [
        `test/f${index}.test.mjs`,
        "x\n",
      ]),
    );
    expect(refusal([verdict()], many)).toBe(
      `REVIEW_LOW_FIX_REFUSED too-many-files ${LOW_FIX_MAX_FILES + 1} max=${LOW_FIX_MAX_FILES}`,
    );
    const long = "x\n".repeat(LOW_FIX_MAX_LINES_PER_FILE + 1);
    expect(refusal([verdict()], { "test/code.test.mjs": long })).toBe(
      `REVIEW_LOW_FIX_REFUSED too-many-lines test/code.test.mjs ${LOW_FIX_MAX_LINES_PER_FILE + 1} max=${LOW_FIX_MAX_LINES_PER_FILE}`,
    );
    expect(refusal([verdict({ quote: "模型没说过这句" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED quote-not-found V1",
    );
    expect(refusal([verdict({ class: "better" })], small)).toBe(
      "REVIEW_LOW_FIX_REFUSED no-low-errors",
    );
    expect(refusal([verdict()])).toBe("REVIEW_LOW_FIX_REFUSED nothing-unreviewed");
  }, 60000);

  it("[low fix] refuses a round that is not the last one covered and a round without verdicts", () => {
    const f = lowFixFixture();
    try {
      const second = f.commit({ "code.txt": "second\n" }, "second");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, second, deepseek, { previous: f.reviewed }),
      ]);
      f.commit({ "test/code.test.mjs": "check\n" }, "fix");
      expect(f.check({ acceptLow: 1 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED not-last-round last=2",
      );
      expect(f.check({ acceptLow: 2 }).lines.at(-1)).toBe(
        "REVIEW_LOW_FIX_REFUSED verdicts-not-committed round-2",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] checks a low-fix record against the evidence at its own commit and its own lists", () => {
    const record = (head, extra = {}) => ({
      at: "t",
      mode: "low-fix",
      cost: 0,
      round: 1,
      head,
      files: ["code.txt", "test/code.test.mjs"],
      findings: ["V1"],
      ...extra,
    });
    const f = fixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const roundDir = `${REVIEWS_DIR}/pr-7/round-1`;
      f.commit(
        {
          [`${roundDir}/deepseek-v4.1-flash.md`]: `${answer}\n`,
          [`${roundDir}/verdicts.jsonl`]: `${JSON.stringify(verdict())}\n`,
        },
        "evidence added after the fix",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        record(fixed, { from: f.reviewed }),
      ]);
      expect(f.check().problems).toEqual([
        "low-fix-invalid round=1 verdicts-not-committed round-1",
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
    const g = lowFixFixture();
    try {
      const fixed = g.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
      const first = [ok(1, g.reviewed, deepseek), ok(1, g.reviewed, glm)];
      g.writeLedger([...first, record(fixed, { from: g.reviewed, files: ["test/code.test.mjs"] })]);
      expect(g.check().problems).toEqual(["low-fix-invalid round=1 files-differ"]);
      g.writeLedger([...first, record(fixed, { from: g.reviewed, findings: ["V9"] })]);
      expect(g.check().problems).toEqual(["low-fix-invalid round=1 findings-differ"]);
      g.writeLedger([...first, record(fixed, { from: g.reviewed })]);
      expect(g.check().problems).toEqual([]);
    } finally {
      rmSync(g.root, { recursive: true, force: true });
    }
  });

  const lowFixedChain = () => {
    const f = lowFixFixture();
    const fixed = f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "fix");
    const lowFix = {
      at: "t",
      mode: "low-fix",
      cost: 0,
      round: 1,
      head: fixed,
      from: f.reviewed,
      files: ["code.txt", "test/code.test.mjs"],
      findings: ["V1"],
    };
    const first = [ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm), lowFix];
    const ledgerCommit = f.writeLedger(first);
    const isAncestor = (from, to) =>
      spawnSync("git", ["merge-base", "--is-ancestor", from, to], { cwd: f.repo }).status === 0;
    const lowFixCheck = lowFixChecker({
      repo: f.repo,
      ledgerPath: `${REVIEWS_DIR}/pr-7`,
      mainRef: "origin/main",
      skip: new Set(),
    });
    const ask = (previous, { records = first, round = 2, head = ledgerCommit } = {}) =>
      previousProblem({ records, round, head, previous, isAncestor, lowFixCheck });
    return { ...f, fixed, first, ledgerCommit, ask };
  };

  it("[I-98] refuses a --previous that skips the accepted low-fix head and names the right one", () => {
    const f = lowFixedChain();
    try {
      expect(f.ask(f.ledgerCommit)).toBe(
        `REVIEW_PREVIOUS_REFUSED chain-broken previous=${f.ledgerCommit} use=--previous ${f.fixed}`,
      );
      expect(f.ask(f.fixed)).toBeNull();
      expect(f.ask(f.reviewed)).toBeNull();
      expect(f.ask(undefined)).toBeNull();
      expect(f.ask(f.fixed, { records: [] })).toBe(
        "REVIEW_PREVIOUS_REFUSED no-accepted-round use=no-previous",
      );
      f.writeLedger([...f.first, ok(2, f.ledgerCommit, deepseek, { previous: f.ledgerCommit })]);
      expect(f.check().problems).toEqual([`chain-broken round=2 ${f.ledgerCommit}`]);
      f.writeLedger([...f.first, ok(2, f.ledgerCommit, deepseek, { previous: f.fixed })]);
      expect(f.check()).toMatchObject({ round: 2, reviewed: f.ledgerCommit, problems: [] });
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[I-98] refuses any --previous once an earlier round already broke the chain", () => {
    const f = lowFixedChain();
    try {
      const broken = [...f.first, ok(2, f.ledgerCommit, deepseek, { previous: f.ledgerCommit })];
      const later = f.commit({ "code.txt": "later\n" }, "later");
      const ask = (previous) => f.ask(previous, { records: broken, round: 3, head: later });
      expect(ask(f.ledgerCommit)).toBe(
        `REVIEW_PREVIOUS_REFUSED chain-already-broken round=2 ${f.ledgerCommit} chain-broken use=no-previous`,
      );
      expect(ask(undefined)).toBeNull();
      const invalid = [...f.first.slice(0, 2), { ...f.first[2], findings: ["V9"] }];
      expect(f.ask(f.fixed, { records: invalid })).toBe(
        `REVIEW_PREVIOUS_REFUSED chain-already-broken round=1 ${f.fixed} findings-differ use=no-previous`,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[I-98] a rerun of a round must pass the --previous the round already used", () => {
    const f = lowFixedChain();
    try {
      const done = [...f.first, ok(2, f.ledgerCommit, deepseek, { previous: f.fixed })];
      expect(f.ask(f.fixed, { records: done })).toBeNull();
      expect(f.ask(f.reviewed, { records: done })).toBe(
        `REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=--previous ${f.fixed}`,
      );
      expect(f.ask(undefined, { records: done })).toBe(
        `REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=--previous ${f.fixed}`,
      );
      const fresh = [...f.first, ok(2, f.ledgerCommit, deepseek)];
      expect(f.ask(f.fixed, { records: fresh })).toBe(
        "REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=no-previous",
      );
      const invalid = [...f.first.slice(0, 2), { ...f.first[2], findings: ["V9"] }];
      const stuck = [...invalid, ok(2, f.ledgerCommit, deepseek, { previous: f.fixed })];
      expect(f.ask(undefined, { records: stuck })).toBe(
        "REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=new-round",
      );
      const split = [...done, ok(2, f.ledgerCommit, glm, { previous: f.reviewed })];
      expect(f.ask(f.fixed, { records: split })).toBe(
        "REVIEW_PREVIOUS_REFUSED round-previous-differs round=2 use=new-round",
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[I-98] refuses a --previous when the head does not contain the accepted point", () => {
    const f = lowFixedChain();
    try {
      f.git("checkout", "--quiet", "-b", "side", f.main);
      const side = f.commit({ "code.txt": "side\n" }, "side");
      expect(f.ask(f.reviewed, { head: side })).toBe(
        `REVIEW_PREVIOUS_REFUSED head-not-after-accepted ${f.fixed} head=${side} use=no-previous`,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[I-98] the script refuses a wrong --previous before installing opencode or spending", () => {
    const f = lowFixedChain();
    try {
      const questions = readFileSync(".agents/instructions/model-review.md", "utf8");
      const head = f.commit({ ".agents/instructions/model-review.md": questions }, "questions");
      const brief = join(f.root, "brief.md");
      writeFileSync(brief, "brief\n");
      const run = (previous) =>
        spawnSync(
          process.execPath,
          [
            "scripts/model-review/opencode-review.mjs",
            "--mode",
            "code-review",
            "--pr",
            "7",
            "--repo",
            f.repo,
            "--head",
            head,
            "--base",
            f.main,
            "--previous",
            previous,
            "--questions-ref",
            head,
            "--brief",
            brief,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
      const wrong = run(f.ledgerCommit);
      expect(wrong.status).toBe(2);
      expect(wrong.stderr.trim()).toBe(
        `REVIEW_PREVIOUS_REFUSED chain-broken previous=${f.ledgerCommit} use=--previous ${f.fixed}`,
      );
      expect(wrong.stdout).not.toContain("REVIEW_PID");
      const right = run(f.fixed);
      expect(right.stderr).not.toContain("REVIEW_PREVIOUS_REFUSED");
      expect(right.stdout).toContain("REVIEW_PID");
      expect(readFileSync(join(f.repo, f.ledger), "utf8")).toBe(
        f.first.map((r) => `${JSON.stringify(r)}\n`).join(""),
      );
      const invalid = [...f.first.slice(0, 2), { ...f.first[2], findings: ["V9"] }];
      writeFileSync(join(f.repo, f.ledger), invalid.map((r) => `${JSON.stringify(r)}\n`).join(""));
      const untrusted = run(f.fixed);
      expect(untrusted.status).toBe(2);
      expect(untrusted.stderr.trim()).toBe(
        `REVIEW_PREVIOUS_REFUSED chain-already-broken round=1 ${f.fixed} findings-differ use=no-previous`,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);

  it("[low fix] a refused --accept-low exits non-zero even when nothing is unreviewed", () => {
    const f = lowFixFixture();
    try {
      const run = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--assert-reviewed",
          "--pr",
          "7",
          "--repo",
          f.repo,
          "--accept-low",
          "1",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(run.stdout).toContain("REVIEW_LOW_FIX_REFUSED nothing-unreviewed");
      expect(run.status).toBe(5);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);

  it("[ADR-0268] a malformed review ledger in the PR exits with the not-covered code, not a crash", () => {
    const f = lowFixFixture();
    try {
      f.commit({ [f.ledger]: "{not json\n" }, "broken ledger");
      const run = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--assert-reviewed",
          "--pr",
          "7",
          "--repo",
          f.repo,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(run.stdout).toMatch(/^REVIEW_RECORD_INVALID USAGE_LEDGER_INVALID /m);
      expect(run.status).toBe(5);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);

  it("[ADR-0268] malformed verdicts at a low-fix check are a problem, not a crash", () => {
    const f = lowFixFixture();
    try {
      f.commit({ [`${REVIEWS_DIR}/pr-7/round-1/verdicts.jsonl`]: "{bad\n" }, "bad verdicts");
      f.commit({ "code.txt": "fixed\n", "test/code.test.mjs": "check\n" }, "low fix");
      const checked = f.check({ acceptLow: 1 });
      expect(checked.overridden).toBe(false);
      expect(checked.lines.join("\n")).toContain("VERDICTS_INVALID");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[low fix] checks a hand-written low-fix record again at the gate", () => {
    const f = lowFixFixture();
    try {
      const fixed = f.commit({ "code.txt": "fixed\n" }, "fix without test");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        {
          at: "t",
          mode: "low-fix",
          cost: 0,
          round: 1,
          head: fixed,
          from: f.reviewed,
          files: ["code.txt"],
          findings: ["V1"],
        },
      ]);
      expect(f.check().problems).toEqual(["low-fix-invalid round=1 no-test-change"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] reads the committed ledger, not the working tree", () => {
    const f = fixture();
    try {
      expect(f.check().problems).toEqual(["ledger-not-committed"]);
      mkdirSync(join(f.repo, REVIEWS_DIR, "pr-7"), { recursive: true });
      writeFileSync(
        join(f.repo, f.ledger),
        `${JSON.stringify(ok(1, f.reviewed, deepseek))}\n${JSON.stringify(ok(1, f.reviewed, glm))}\n`,
      );
      expect(f.check().problems).toEqual(["ledger-not-committed"]);
      f.writeLedger([ok(1, f.reviewed, deepseek, { outcome: "timeout" })]);
      expect(f.check().problems).toEqual(["no-complete-round"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] fails when the reviewed commit is not in the branch any more", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "main");
      f.git("checkout", "--quiet", "-b", "rewritten");
      f.commit({ "code.txt": "other\n" }, "rewritten");
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      expect(f.check().problems[0]).toBe(`not-ancestor ${f.reviewed}`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] records Andy's words after one round and passes only once the record is committed", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      f.commit({ "code.txt": "after one round\n" }, "early fix");
      const result = f.check({ acceptUnreviewed: "合并" });
      expect(result.problems).toEqual(["unreviewed code.txt"]);
      expect(result.overridden).toBe(false);
      expect(result.lines.at(-1)).toBe("REVIEW_OVERRIDE_WRITTEN quote=合并 commit-and-rerun");
      const written = readFileSync(join(f.repo, f.ledger), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(written.at(-1)).toMatchObject({
        mode: "override",
        cost: 0,
        quote: "合并",
        problems: ["unreviewed code.txt"],
      });
      f.git("add", ".");
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "override");
      const later = f.check();
      expect(later.overridden).toBe(true);
      expect(later.lines.at(-1)).toBe(`REVIEW_OVERRIDE quote=合并 recorded=${written.at(-1).head}`);
      f.commit({ "code.txt": "changed again\n" }, "after override");
      expect(f.check().overridden).toBe(false);
      writeFileSync(join(f.repo, f.ledger), "{}\n");
      const dirty = f.check({ acceptUnreviewed: "合并" });
      expect(dirty.overridden).toBe(false);
      expect(dirty.lines.at(-1)).toBe("REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] Andy can skip review on a PR with no review at all, once his words are committed", () => {
    const f = fixture();
    try {
      const bare = f.check();
      expect(bare.problems).toEqual(["ledger-not-committed"]);
      const written = f.check({ acceptUnreviewed: "跳过复核，合并" });
      expect(written.overridden).toBe(false);
      expect(written.lines.at(-1)).toBe(
        "REVIEW_OVERRIDE_WRITTEN quote=跳过复核，合并 commit-and-rerun",
      );
      expect(JSON.parse(readFileSync(join(f.repo, f.ledger), "utf8"))).toMatchObject({
        mode: "override",
        quote: "跳过复核，合并",
        head: f.reviewed,
        problems: ["ledger-not-committed"],
      });
      f.git("add", ".");
      f.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "override");
      const later = f.check();
      expect(later.problems).toEqual(["no-complete-round"]);
      expect(later.overridden).toBe(true);
      expect(later.lines.at(-1)).toBe(
        `REVIEW_OVERRIDE quote=跳过复核，合并 recorded=${f.reviewed}`,
      );
      const report = reviewReport({
        repo: f.repo,
        pr: 7,
        mainRef: "origin/main",
        stop: "andy-decision",
        andyQuote: "跳过复核，合并",
      });
      expect(report).toContain(
        `REVIEW_OVERRIDE_RECORD head=${f.reviewed} quote=跳过复核，合并 problems=ledger-not-committed`,
      );
      const odd = {
        at: "t",
        mode: "override",
        cost: 0,
        head: f.reviewed,
        quote: "x",
        problems: "y",
      };
      for (const problems of ["y", [3]]) {
        f.writeLedger([{ ...odd, problems }]);
        expect(() => f.check()).toThrow("USAGE_LEDGER_INVALID");
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[merge gate] the script answers before installing opencode or spending", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "scripts/model-review/opencode-review.mjs",
            "--assert-reviewed",
            "--pr",
            "7",
            "--repo",
            f.repo,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
      const pass = run();
      expect(pass.status).toBe(0);
      expect(pass.stdout).toMatch(/^REVIEW_CURRENT pr=7 round=1 /);
      f.commit({ "code.txt": "unreviewed\n" }, "late change");
      const fail = run();
      expect(fail.status).toBe(5);
      expect(fail.stdout).toMatch(/^REVIEW_NOT_CURRENT pr=7 /);
      expect(fail.stdout).toContain("unreviewed code.txt");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);
  it("[review report] prints the fixed lines from the committed ledger", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const lines = reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop: "no-error" });
      expect(lines[0]).toBe("REVIEW_REPORT pr=7");
      expect(lines[1]).toBe(resultLine(ok(1, f.reviewed, deepseek)));
      expect(lines[2]).toBe(resultLine(ok(1, f.reviewed, glm)));
      expect(lines[3]).toBe("REVIEW_SPENT_TOTAL 0.1000");
      expect(lines[4]).toMatch(/^REVIEW_CURRENT pr=7 round=1 /);
      expect(lines.at(-2)).toBe("停下的原因：没有“会出错”的意见");
      expect(lines.at(-1)).toBe(REVIEW_REPORT_DISCLAIMER);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review report] refuses a stop reason the ledger does not support", () => {
    const f = fixture();
    try {
      const report = (stop, extra = {}) =>
        reviewReport({ repo: f.repo, pr: 7, mainRef: "origin/main", stop, ...extra });
      f.writeLedger([ok(1, f.reviewed, deepseek, { outcome: "timeout" }), ok(1, f.reviewed, glm)]);
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
      expect(report("run-failed").at(-2)).toBe("停下的原因：有模型没跑完（outcome 不是 ok）");
      expect(() => report("three-rounds")).toThrow("REPORT_STOP_INCONSISTENT three-rounds");
      expect(() => report("andy-decision")).toThrow("REPORT_STOP_INCONSISTENT andy-decision");
      expect(report("andy-decision", { andyQuote: "这条不改" }).at(-2)).toBe(
        "停下的原因：Andy 裁定：这条不改",
      );
      expect(() => report("whatever")).toThrow("ARG_INVALID --stop");
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(1, f.reviewed, glm),
        ok(2, f.reviewed, deepseek),
        ok(2, f.reviewed, glm),
        ok(3, f.reviewed, deepseek),
        ok(3, f.reviewed, glm),
      ]);
      expect(() => report("run-failed")).toThrow("REPORT_STOP_INCONSISTENT run-failed");
      expect(report("three-rounds").at(-2)).toBe(
        "停下的原因：连续三轮没过，按规则停下等 Andy 决定",
      );
      f.writeLedger([
        ok(1, f.reviewed, deepseek),
        ok(2, f.reviewed, deepseek),
        ok(3, f.reviewed, deepseek, { outcome: OWNER_STOPPED }),
      ]);
      expect(() => report("three-rounds")).toThrow("REPORT_STOP_INCONSISTENT three-rounds");
      f.commit({ "code.txt": "late\n" }, "late change");
      expect(() => report("no-error")).toThrow("REPORT_STOP_INCONSISTENT no-error");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("[review report] the script prints the report and fails on an inconsistent stop reason", () => {
    const f = fixture();
    try {
      f.writeLedger([ok(1, f.reviewed, deepseek), ok(1, f.reviewed, glm)]);
      const run = (stop) =>
        spawnSync(
          process.execPath,
          [
            "scripts/model-review/opencode-review.mjs",
            "--report",
            "--pr",
            "7",
            "--repo",
            f.repo,
            "--stop",
            stop,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
          },
        );
      const good = run("no-error");
      expect(good.status).toBe(0);
      expect(good.stdout.trim().split("\n").at(-1)).toBe(REVIEW_REPORT_DISCLAIMER);
      const bad = run("run-failed");
      expect(bad.status).toBe(2);
      expect(bad.stderr.trim()).toBe("REPORT_STOP_INCONSISTENT run-failed");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 60000);
});

describe("opencode review spending", () => {
  const record = (cost, round = 1) => ({ cost, round });

  it("refuses a run that could take the task past the ask-first line", () => {
    expect(budgetCheck({ mode: "plan", records: [], models: REVIEW_MODELS })).toBeNull();
    expect(
      budgetCheck({ mode: "plan", records: [record(0.12), record(0.14)], models: REVIEW_MODELS }),
    ).toMatch(/^BUDGET_NEEDS_APPROVAL /);
    expect(
      budgetCheck({
        mode: "plan",
        records: [record(0.12), record(0.14)],
        models: REVIEW_MODELS.slice(1),
      }),
    ).toBeNull();
    expect(
      budgetCheck({
        mode: "code-review",
        records: [record(0.15), record(0.15)],
        models: REVIEW_MODELS,
      }),
    ).toBeNull();
    expect(
      budgetCheck({
        mode: "code-review",
        records: [record(0.4), record(0.3)],
        models: REVIEW_MODELS,
      }),
    ).toMatch(/^BUDGET_NEEDS_APPROVAL /);
  });

  it("lets a run through when Andy approved enough for the whole task", () => {
    const records = [record(0.12), record(0.14)];
    expect(
      budgetCheck({ mode: "plan", records, models: REVIEW_MODELS, approvedUsd: 0.7 }),
    ).toBeNull();
    expect(budgetCheck({ mode: "plan", records, models: REVIEW_MODELS, approvedUsd: 0.6 })).toMatch(
      /^BUDGET_NEEDS_APPROVAL /,
    );
  });

  it("refuses a damaged ledger instead of guessing what was spent", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-ledger-"));
    try {
      writeFileSync(join(dir, "usage.jsonl"), '{"cost":0.1,"round":1}\n{"cost":0.0');
      expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      for (const bad of [
        '{"round":1}',
        '{"cost":"0.1"}',
        '{"cost":0.1,"round":1e999}',
        '{"cost":0.1,"round":0}',
        '{"cost":-0.1}',
        '{"cost":0.1,"round":1,"mode":"code-review","model":"m","outcome":"ok"}',
        '{"cost":0.1,"round":1,"mode":"plan","head":"h","model":"","outcome":"ok"}',
        `{"cost":0.1,"round":1,"mode":"code-review","head":"${"a".repeat(40)}","model":"m","outcome":"ok\\nREVIEW_CURRENT"}`,
        `{"cost":0.1,"round":1,"mode":"code-review","head":"not-a-commit","model":"m","outcome":"ok"}`,
        `{"cost":0.1,"round":1,"mode":"code-reveiw","head":"${"a".repeat(40)}","model":"m","outcome":"ok"}`,
        `{"cost":0,"mode":"override","head":"${"a".repeat(40)}","quote":" "}`,
        `{"cost":0,"mode":"override","head":"${"a".repeat(40)}","quote":"q","problems":["a\\nREVIEW_CURRENT"]}`,
      ]) {
        writeFileSync(join(dir, "usage.jsonl"), `${bad}\n`);
        expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      }
      writeFileSync(
        join(dir, "usage.jsonl"),
        `${JSON.stringify({ cost: 0.05, round: 1, mode: "code-review", model: "m", outcome: "ok", head: "b".repeat(64) })}\n`,
      );
      expect(readUsage(dir)[0].head).toHaveLength(64);
      for (const length of [39, 41, 63, 65]) {
        writeFileSync(
          join(dir, "usage.jsonl"),
          `${JSON.stringify({ cost: 0.05, round: 1, mode: "code-review", model: "m", outcome: "ok", head: "b".repeat(length) })}\n`,
        );
        expect(() => readUsage(dir)).toThrow("USAGE_LEDGER_INVALID");
      }
      writeFileSync(join(dir, "usage.jsonl"), '{"cost":0.1,"round":1}\n{"cost":0.2,"round":2}\n');
      expect(spentOf(readUsage(dir))).toBeCloseTo(0.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reuse a round folder that is already on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rounds-"));
    try {
      mkdirSync(join(dir, "round-3"));
      mkdirSync(join(dir, "round-x"));
      expect(roundsOnDisk(dir)).toEqual([3]);
      expect(nextRound([], roundsOnDisk(dir))).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[rerun round] puts a single-model rerun back into the round it belongs to", () => {
    const [deepseek, glm] = REVIEW_MODELS;
    const records = [
      { cost: 0.1, round: 1, model: deepseek, head: "h1", outcome: "ok" },
      { cost: 0.1, round: 1, model: glm, head: "h1", outcome: "ok" },
      { cost: 0.1, round: 2, model: deepseek, head: "h2", outcome: "ok" },
      { cost: 0.1, round: 2, model: glm, head: "h2", outcome: "timeout" },
    ];
    const run = (overrides) =>
      roundForRun({
        records,
        rounds: [1, 2],
        models: [glm],
        head: "h2",
        prompts: { [glm]: "P", [deepseek]: "D" },
        promptsOnDisk: { [glm]: "P", [deepseek]: "D" },
        ...overrides,
      });
    expect(run({ requested: undefined })).toBe(3);
    expect(run({ requested: 2 })).toBe(2);
    expect(() => run({ requested: 2, models: [deepseek] })).toThrow(
      `ROUND_ALREADY_HAS_RESULT 2 ${deepseek}`,
    );
    expect(() => run({ requested: 1 })).toThrow(`ROUND_ALREADY_HAS_RESULT 1 ${glm}`);
    expect(() => run({ requested: 3 })).toThrow("ROUND_NOT_FOUND 3");
    expect(() => run({ requested: 2, head: "h3" })).toThrow("ROUND_HEAD_MISMATCH 2 h2 h3");
    expect(() => run({ requested: 2, prompts: { [glm]: "other brief" } })).toThrow(
      `ROUND_PROMPT_MISMATCH 2 ${glm}`,
    );
    expect(() => run({ requested: 2, promptsOnDisk: {} })).toThrow(`ROUND_CANNOT_VERIFY 2 ${glm}`);
    expect(run({ requested: 2, prompts: { [glm]: "P", [deepseek]: "changed" } })).toBe(2);
    expect(
      parseArgs(["--head", "a", "--brief", "b", "--topic", "t", "--mode", "plan", "--round", "2"])
        .round,
    ).toBe(2);
    for (const bad of ["0", "-1", "1.5", "x"])
      expect(() =>
        parseArgs([
          "--head",
          "a",
          "--brief",
          "b",
          "--topic",
          "t",
          "--mode",
          "plan",
          "--round",
          bad,
        ]),
      ).toThrow("ARG_INVALID --round");
  });

  it("refuses a prompt over the size limit before spending or writing records", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-large-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "x".repeat(100001));
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--topic",
          "prompt-too-large-probe",
          "--brief",
          brief,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe("PROMPT_TOO_LARGE");
      expect(existsSync(join(REVIEWS_DIR, "topic-prompt-too-large-probe"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("[rerun round] falls back to the ledger's prompt digest when the prompt file is gone", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    const records = [
      { cost: 0.1, round: 1, model: glm, head: "h", outcome: "timeout", promptSha256: digest },
    ];
    const run = (prompt) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: {},
      });
    expect(run("P")).toBe(1);
    expect(() => run("other brief")).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
  });

  it("[rerun round] still accepts a prompt file written before the value was registered", () => {
    const [, glm] = REVIEW_MODELS;
    const value = ["abcdef", "123456"].join("");
    const prompt = `问题里引用了 token=${value} 这个值\n`;
    const digest = createHash("sha256").update(prompt).digest("hex");
    const records = [
      { cost: 0.1, round: 1, model: glm, head: "h", outcome: "timeout", promptSha256: digest },
    ];
    const run = (onDisk) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: { [glm]: onDisk },
      });
    const writtenBefore = maskSecretLike(prompt);
    setRegisteredTestValues([value]);
    try {
      expect(maskSecretLike(prompt)).not.toBe(writtenBefore);
      expect(run(writtenBefore)).toBe(1);
      expect(run(maskSecretLike(prompt))).toBe(1);
      expect(() => run(`${writtenBefore}\n`)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
    } finally {
      setRegisteredTestValues([]);
    }
  });

  it("[rerun round] accepts a prompt file whose digest the ledger recorded, even if the list of values changed since", () => {
    const [, glm] = REVIEW_MODELS;
    const first = ["abcdef", "123456"].join("");
    const second = ["second-registered", "value"].join("-");
    const prompt = `引用了 ${first} 和 ${second}\n`;
    setRegisteredTestValues([first]);
    const writtenThen = maskSecretLike(prompt);
    const records = [
      {
        cost: 0.1,
        round: 1,
        model: glm,
        head: "h",
        outcome: "timeout",
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
        promptFileSha256: createHash("sha256").update(writtenThen).digest("hex"),
      },
    ];
    const run = (onDisk) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: { [glm]: onDisk },
      });
    try {
      setRegisteredTestValues([second]);
      expect(run(writtenThen)).toBe(1);
      expect(() => run(`${writtenThen}\n`)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
    } finally {
      setRegisteredTestValues([]);
    }
  });

  it("[rerun round] accepts the masked prompt file that the run itself wrote, and refuses a changed one", () => {
    const [, glm] = REVIEW_MODELS;
    const prompt = `问题里引用了 ${fakeOpenAiKey} 这个值\n`;
    const digest = createHash("sha256").update(prompt).digest("hex");
    const records = [
      { cost: 0.1, round: 1, model: glm, head: "h", outcome: "timeout", promptSha256: digest },
    ];
    const run = (onDisk) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: prompt },
        promptsOnDisk: { [glm]: onDisk },
      });
    expect(maskSecretLike(prompt)).not.toBe(prompt);
    expect(run(maskSecretLike(prompt))).toBe(1);
    expect(() => run(prompt)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
    expect(() => run(`${maskSecretLike(prompt)}\n`)).toThrow(`ROUND_PROMPT_MISMATCH 1 ${glm}`);
  });

  it("[rerun round] refuses a round whose records have no commit to compare", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    expect(() =>
      roundForRun({
        records: [{ cost: 0.1, round: 1, model: glm, outcome: "timeout", promptSha256: digest }],
        rounds: [1],
        requested: 1,
        models: [glm],
        head: "h",
        prompts: { [glm]: "P" },
        promptsOnDisk: {},
      }),
    ).toThrow("ROUND_CANNOT_VERIFY 1 head");
  });

  it("[rerun round] refuses another mode's round and ignores override records", () => {
    const [, glm] = REVIEW_MODELS;
    const digest = createHash("sha256").update("P").digest("hex");
    const base = {
      cost: 0.1,
      round: 1,
      model: glm,
      head: "h",
      outcome: "timeout",
      promptSha256: digest,
    };
    const run = (records, mode) =>
      roundForRun({
        records,
        rounds: [1],
        requested: 1,
        mode,
        models: [glm],
        head: "h",
        prompts: { [glm]: "P" },
        promptsOnDisk: {},
      });
    expect(() => run([{ ...base, mode: "plan" }], "plan-review")).toThrow(
      "ROUND_MODE_MISMATCH 1 plan plan-review",
    );
    expect(run([{ ...base, mode: "plan" }], "plan")).toBe(1);
    expect(
      run(
        [
          { ...base, mode: "code-review" },
          { cost: 0, mode: "override", head: "other" },
        ],
        "code-review",
      ),
    ).toBe(1);
  });

  it("[review env] refuses to start when a proxy address carries a user name or password", () => {
    expect(
      proxyCredentialProblems({
        HTTPS_PROXY: "http://127.0.0.1:8080",
        http_proxy: "http://u:p@proxy:3128",
      }),
    ).toEqual(["http_proxy"]);
    expect(proxyCredentialProblems({ HTTPS_PROXY: "https://token@proxy" })).toEqual([
      "HTTPS_PROXY",
    ]);
    expect(proxyCredentialProblems({ NO_PROXY: "a@b" })).toEqual([]);
    expect(proxyCredentialProblems({ HTTP_PROXY: " http://u:p@proxy:3128" })).toEqual([
      "HTTP_PROXY",
    ]);
    expect(proxyCredentialProblems({ https_proxy: "u:p@proxy:3128" })).toEqual(["https_proxy"]);
    expect(proxyCredentialProblems({ http_proxy: "//u:p@proxy:3128" })).toEqual(["http_proxy"]);
    expect(
      proxyCredentialProblems({ https_proxy: "proxy:3128", HTTP_PROXY: "http://proxy/a@b" }),
    ).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "opencode-proxy-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "material\n");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--topic",
          "proxy-probe",
          "--brief",
          brief,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HTTPS_PROXY: "http://user:secret@proxy:3128",
            HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode",
          },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe("PROXY_HAS_CREDENTIALS HTTPS_PROXY");
      expect(result.stderr).not.toContain("secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("[rerun round] keeps the failed attempt's files next to the new ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-attempt-"));
    try {
      expect(keepEarlierAttempt(join(dir, "missing"), "glm-5.3-flash")).toBeNull();
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBeNull();
      writeFileSync(join(dir, "glm-5.3-flash.prompt.md"), "prompt");
      writeFileSync(join(dir, "glm-5.3-flash.md"), "first");
      writeFileSync(join(dir, "glm-5.3-flash.stderr.txt"), "first err");
      writeFileSync(join(dir, "deepseek-v4.1-flash.md"), "other model");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBe(1);
      writeFileSync(join(dir, "glm-5.3-flash.md"), "second");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash")).toBe(2);
      writeFileSync(join(dir, "glm-5.3-flash.jsonl"), "raw");
      writeFileSync(join(dir, "glm-5.3-flash.magpie-usage.jsonl"), "usage");
      expect(keepEarlierAttempt(dir, "glm-5.3-flash", RAW_FILE_SUFFIXES)).toBe(1);
      expect(readdirSync(dir).sort()).toEqual([
        "deepseek-v4.1-flash.md",
        "glm-5.3-flash.attempt-1.jsonl",
        "glm-5.3-flash.attempt-1.magpie-usage.jsonl",
        "glm-5.3-flash.attempt-1.md",
        "glm-5.3-flash.attempt-1.prompt.md",
        "glm-5.3-flash.attempt-1.stderr.txt",
        "glm-5.3-flash.attempt-2.md",
      ]);
      expect(readFileSync(join(dir, "glm-5.3-flash.attempt-1.md"), "utf8")).toBe("first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[rerun round] the script refuses a rerun into a round that already has the result, before spending", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-rerun-"));
    try {
      const brief = join(dir, "brief.md");
      writeFileSync(brief, "material\n");
      const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const repo = join(dir, "repo");
      execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${process.cwd()}`, repo]);
      const out = join(repo, ".agents", "reviews", "topic-rerun");
      mkdirSync(join(out, "round-1"), { recursive: true });
      writeFileSync(
        join(out, "usage.jsonl"),
        `${JSON.stringify({ cost: 0.1, round: 1, model: REVIEW_MODELS[1], head, outcome: "ok" })}\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--mode",
          "plan",
          "--head",
          head,
          "--brief",
          brief,
          "--repo",
          repo,
          "--topic",
          "rerun",
          "--models",
          "glm-5.3-flash",
          "--round",
          "1",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" },
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr.trim()).toBe(`ROUND_ALREADY_HAS_RESULT 1 ${REVIEW_MODELS[1]}`);
      expect(readdirSync(join(out, "round-1"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("numbers rounds from what the folder already holds", () => {
    expect(nextRound([])).toBe(1);
    expect(nextRound([record(0.1, 1), record(0.1, 1), record(0.1, 2)])).toBe(3);
    expect(nextRound([{ cost: 0.1 }])).toBe(2);
  });

  it("[review chain] runs the configured default models in every mode and round unless --models names others", () => {
    const base = ["--head", "a", "--base", "b", "--brief", "b.md", "--pr", "7"];
    expect(DEFAULT_REVIEW_MODELS).toEqual([REVIEW_MODELS[0]]);
    expect(parseArgs(base).models).toEqual(DEFAULT_REVIEW_MODELS);
    expect(parseArgs([...base, "--models", "deepseek-v4.1-flash"]).models).toEqual([
      REVIEW_MODELS[0],
    ]);
    expect(parseArgs([...base, "--models", "glm-5.3-flash"]).models).toEqual([REVIEW_MODELS[1]]);
    expect(parseArgs([...base, "--models", "deepseek-v4.1-flash,glm-5.3-flash"]).models).toEqual(
      REVIEW_MODELS,
    );
    expect(parseArgs([...base, "--models", "glm-5.3-flash", "--round", "1"]).models).toEqual([
      REVIEW_MODELS[1],
    ]);
    expect(parseArgs([...base, "--previous", "c"]).models).toEqual(DEFAULT_REVIEW_MODELS);
    expect(
      parseArgs([...base, "--previous", "c", "--models", "deepseek-v4.1-flash,glm-5.3-flash"])
        .models,
    ).toEqual(REVIEW_MODELS);
    const plan = ["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t"];
    expect(parseArgs(plan).models).toEqual(DEFAULT_REVIEW_MODELS);
    expect(parseArgs(["--mode", "plan-review", ...plan.slice(2)]).models).toEqual(
      DEFAULT_REVIEW_MODELS,
    );
    expect(parseArgs([...plan, "--models", "glm-5.3-flash"]).models).toEqual([REVIEW_MODELS[1]]);
    expect(
      parseArgs([
        "--mode",
        "plan-review",
        "--head",
        "a",
        "--brief",
        "b.md",
        "--topic",
        "t",
        "--models",
        "deepseek-v4.1-flash",
      ]).models,
    ).toEqual([REVIEW_MODELS[0]]);
  });

  it("[review chain] gives DeepSeek the same fixed prompt with or without a previous round", () => {
    const questions = reviewQuestions(instructions);
    const common = { mode: "code-review", model: REVIEW_MODELS[0], questions, base: "b" };
    const first = buildPrompt({ ...common, head: "h1", brief: "第一轮" });
    const later = buildPrompt({ ...common, head: "h2", previous: "h1", brief: "第二轮" });
    const fixedEnd = first.indexOf("---- 本次材料 ----");
    expect(later.slice(0, fixedEnd)).toBe(first.slice(0, fixedEnd));
    expect(first.slice(0, fixedEnd)).toContain("规则文件、说明文档和代码是否一致");
  });

  it("[low fix] reads verdict lines strictly and needs a reason when the thread lowers the model's severity", () => {
    const line = (extra = {}) =>
      JSON.stringify({
        id: "V1",
        model: REVIEW_MODELS[0],
        quote: "原话",
        valid: true,
        class: "error",
        severity: "low",
        trigger: "触发",
        consequence: "后果",
        modelSeverity: "低",
        ...extra,
      });
    expect(parseVerdicts(`${line()}\n\n`, "v")).toHaveLength(1);
    expect(
      parseVerdicts(line({ valid: false, severity: undefined, trigger: "" }), "v"),
    ).toHaveLength(1);
    expect(parseVerdicts(line({ class: "better", severity: undefined }), "v")).toHaveLength(1);
    expect(
      parseVerdicts(line({ modelSeverity: "中", reason: "只在手动调试时出现" }), "v"),
    ).toHaveLength(1);
    for (const bad of [
      line({ modelSeverity: "中" }),
      line({ trigger: " " }),
      line({ consequence: undefined }),
      line({ severity: "medium" }),
      line({ model: "x/other" }),
      line({ class: "nit" }),
      line({ quote: "第一行\n第二行" }),
      line({ valid: "yes" }),
      "not json",
    ])
      expect(() => parseVerdicts(bad, "v")).toThrow("VERDICTS_INVALID v:1");
    expect(() => parseVerdicts(`${line()}\n${line({ quote: "另一句" })}\n`, "v")).toThrow(
      "VERDICTS_INVALID v:2",
    );
    expect(parseVerdicts(`${line()}\n${line({ id: "V2" })}\n`, "v")).toHaveLength(2);
  });

  it("[low fix] tells test files apart from code", () => {
    for (const path of [
      "test/a.mjs",
      "packages/x/test/a.ts",
      "src/a.test.ts",
      "a.spec.mjs",
      "x/__tests__/b.js",
    ])
      expect(isTestFile(path)).toBe(true);
    for (const path of [
      "src/a.ts",
      "testing/a.ts",
      "docs/test.md",
      "latest/a.mjs",
      "test/README.md",
      "test/README.MD",
    ])
      expect(isTestFile(path)).toBe(false);
  });

  it("[low fix] keeps low-fix records out of round numbers and rejects malformed ones", () => {
    const commit = "a".repeat(40);
    const good = {
      at: "t",
      mode: "low-fix",
      cost: 0,
      round: 1,
      head: commit,
      from: commit,
      files: ["a"],
      findings: ["V1"],
    };
    expect(nextRound(parseUsage(JSON.stringify(good), "l"))).toBe(1);
    for (const bad of [
      { ...good, from: undefined },
      { ...good, cost: 0.1 },
      { ...good, files: [] },
      { ...good, findings: [""] },
      { ...good, round: undefined },
    ])
      expect(() => parseUsage(JSON.stringify(bad), "l")).toThrow("USAGE_LEDGER_INVALID l:1");
    const base = ["--head", "a", "--base", "b", "--brief", "b.md", "--pr", "7"];
    expect(() => parseArgs([...base, "--accept-low", "1"])).toThrow(
      "ARG_ACCEPT_LOW_ONLY_WITH_ASSERT",
    );
    expect(parseArgs(["--assert-reviewed", "--pr", "7", "--accept-low", "2"]).acceptLow).toBe(2);
    expect(() => parseArgs(["--assert-reviewed", "--pr", "7", "--accept-low", "0"])).toThrow(
      "ARG_INVALID --accept-low",
    );
    expect(() =>
      parseArgs([
        "--assert-reviewed",
        "--pr",
        "7",
        "--accept-low",
        "1",
        "--accept-unreviewed",
        "x",
      ]),
    ).toThrow("ARG_ACCEPT_LOW_AND_UNREVIEWED");
    expect(() =>
      parseArgs(["--report", "--pr", "7", "--stop", "no-error", "--accept-low", "1"]),
    ).toThrow("ARG_NOT_FOR_SUBCOMMAND --accept-low");
  });

  it("reruns only the models asked for", () => {
    const base = ["--mode", "plan", "--head", "a", "--brief", "b.md", "--topic", "t"];
    expect(parseArgs(base).models).toEqual(DEFAULT_REVIEW_MODELS);
    expect(parseArgs([...base, "--models", "deepseek-v4.1-flash"]).models).toEqual([
      "opencode-go/deepseek-v4.1-flash",
    ]);
    expect(() => parseArgs([...base, "--models", "kimi-k3"])).toThrow("ARG_INVALID --models");
    expect(
      parseArgs([...base, "--models", " glm-5.3-flash , opencode-go/deepseek-v4.1-flash"]).models,
    ).toEqual(["opencode-go/glm-5.3-flash", "opencode-go/deepseek-v4.1-flash"]);
    for (const bad of ["glm-5.3-flash,", "glm-5.3-flash,glm-5.3-flash", ""])
      expect(() => parseArgs([...base, "--models", bad])).toThrow("ARG_INVALID --models");
    expect(parseArgs([...base, "--approved-usd", "0.7"]).approvedUsd).toBe(0.7);
    expect(() => parseArgs([...base, "--approved-usd", "x"])).toThrow("ARG_INVALID --approved-usd");
  });
});

describe("spend guard decisions", () => {
  const limits = { totalUsd: 0.2, stopAtUsd: 0.15, deadlineAt: 2000, wrapUpAt: 1000 };

  it("[I-77] stops in the same order the parent does", () => {
    expect(guardDecision(limits, { cost: 0.01, allowed: 1 }, 0)).toBeNull();
    expect(guardDecision(limits, { cost: 0.01, allowed: 1, unknown: true }, 0)).toBe(
      "cost-unknown",
    );
    expect(guardDecision(limits, { cost: 0.15, allowed: 1 }, 0)).toBe("wrap-up-cost");
    expect(guardDecision(limits, { cost: 0.21, allowed: 1 }, 0)).toBe("cost-limit");
    expect(guardDecision(limits, { cost: 0, allowed: 1 }, 1000)).toBe("wrap-up-time");
    expect(guardDecision(limits, { cost: 0, allowed: 1 }, 2000)).toBe("timeout");
    expect(guardDecision({ totalUsd: 1, stopAfterRequests: 2 }, { cost: 0, allowed: 2 }, 0)).toBe(
      "request-limit",
    );
  });

  it("[I-77] lets the wrap-up turn through with only a total line", () => {
    const wrapUpLimits = { totalUsd: 0.2, deadlineAt: 2000 };
    expect(guardDecision(wrapUpLimits, { cost: 0.16, allowed: 0 }, 1500)).toBeNull();
  });

  it("[I-77] keeps earlier costs when compaction drops those messages from later requests", () => {
    const ledger = new Map();
    noteCost(ledger, { role: "assistant", id: "a", cost: 0.05 });
    noteCost(ledger, { role: "assistant", id: "b", cost: 0.04 });
    noteCost(ledger, { role: "assistant", id: "b", cost: 0.06 });
    noteCost(ledger, { role: "assistant", id: "c", cost: -1 });
    noteCost(ledger, { role: "assistant", id: "d", cost: Number.NaN });
    noteCost(ledger, { role: "user", id: "e", cost: 9 });
    expect(ledgerTotal(ledger)).toBeCloseTo(0.11);
    noteCost(ledger, { role: "assistant", id: "a", cost: 0.05, time: { completed: 1 } });
    expect(completedCount(ledger)).toBe(1);
  });

  it("[I-77] counts only this process's own steps as completed, and treats an unreadable cost as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-guard-unit-"));
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    try {
      const markerPath = join(dir, "marker.json");
      writeFileSync(
        join(dir, "limits.json"),
        JSON.stringify({ markerPath, totalUsd: 1, deadlineAt: Date.now() + 60000 }),
      );
      process.env.HIMAWARI_SPEND_GUARD = join(dir, "limits.json");
      const guard = await SpendGuard();
      const done = (id, cost) => ({
        info: { role: "assistant", id, cost, time: { completed: 1 } },
        parts: [],
      });
      await guard["experimental.chat.messages.transform"](
        {},
        { messages: [done("a", 0.1), done("b", 0.1)] },
      );
      await guard["chat.params"]({ agent: "build" });
      const read = () => JSON.parse(readFileSync(markerPath, "utf8"));
      expect(read()).toMatchObject({ allowed: 1, completed: 0, totalCostUsd: 0.2 });
      await guard.event({
        event: { type: "message.updated", properties: { info: done("c", 0.01).info } },
      });
      expect(read()).toMatchObject({ allowed: 1, completed: 1 });
      await guard["experimental.chat.messages.transform"](
        {},
        { messages: [done("d", Number.NaN)] },
      );
      await expect(guard["chat.params"]({ agent: "build" })).rejects.toThrow("cost-unknown");
      expect(read().reason).toBe("cost-unknown");
    } finally {
      if (saved === undefined) delete process.env.HIMAWARI_SPEND_GUARD;
      else process.env.HIMAWARI_SPEND_GUARD = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[I-77] adds the money the parent already counted when the resumed history no longer shows it", () => {
    const limits = { startingUsd: 0.16 };
    expect(effectiveCost(limits, { baselineCost: 0.05 }, 0.05)).toBe(0.16);
    expect(effectiveCost(limits, { baselineCost: 0.05 }, 0.07)).toBeCloseTo(0.18);
    expect(effectiveCost({}, { baselineCost: 0.05 }, 0.07)).toBe(0.07);
    expect(effectiveCost(limits, { baselineCost: 0.2 }, 0.2)).toBe(0.2);
  });

  it("[I-77] starts the guard's count at the money the parent already recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-guard-start-"));
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    try {
      const run = async (startingUsd) => {
        const markerPath = join(dir, `marker-${startingUsd}.json`);
        writeFileSync(
          join(dir, "limits.json"),
          JSON.stringify({
            markerPath,
            totalUsd: 0.2,
            startingUsd,
            deadlineAt: Date.now() + 60000,
          }),
        );
        process.env.HIMAWARI_SPEND_GUARD = join(dir, "limits.json");
        const guard = await SpendGuard();
        await guard["experimental.chat.messages.transform"]({}, { messages: [] });
        const verdict = guard["chat.params"]({ agent: "build" });
        return { verdict, read: () => JSON.parse(readFileSync(markerPath, "utf8")) };
      };
      const open = await run(0.1);
      await open.verdict;
      expect(open.read()).toMatchObject({ allowed: 1, totalCostUsd: 0.1 });
      const over = await run(0.21);
      await expect(over.verdict).rejects.toThrow("cost-limit");
      expect(over.read()).toMatchObject({ allowed: 0, reason: "cost-limit" });
    } finally {
      if (saved === undefined) delete process.env.HIMAWARI_SPEND_GUARD;
      else process.env.HIMAWARI_SPEND_GUARD = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[I-77] does nothing without limits, so a missing plugin file is caught by the self-check", async () => {
    const saved = process.env.HIMAWARI_SPEND_GUARD;
    delete process.env.HIMAWARI_SPEND_GUARD;
    try {
      expect(await SpendGuard()).toEqual({});
    } finally {
      if (saved !== undefined) process.env.HIMAWARI_SPEND_GUARD = saved;
    }
  });
});

describe("[registered test values] records never carry the fixture values gitleaks already allows", () => {
  const fakeValue = ["abcdef", "123456"].join("");
  const nearMiss = ["abcdef", "123457"].join("");
  const quote = "'''";
  const toml = [
    "[[allowlists]]",
    `regexes = [${quote}^${fakeValue}$${quote}]`,
    "[[allowlists]]",
    `regexes = [${quote}^short$${quote}]`,
    "[[allowlists]]",
    `regexes = [${quote}^MIIEvR2T14TAILBO[A-Z]$${quote}]`,
    "[[allowlists]]",
    `regexes = [${quote}^sensitive-interceptions-clear-01$${quote}]`,
    "[[allowlists]]",
    `regexes = [${quote}^-----BEGIN PRIVATE KEY----- is used \\.\\.\\.\`${quote}]`,
    "[[allowlists]]",
    `regexes = [${quote}^0123456789abcdef\\.0123456789abcdef$${quote}]`,
    "",
  ].join("\n");

  afterEach(() => setRegisteredTestValues([]));

  it("reads only literal exact values of a safe length from the allowlist file", () => {
    expect(registeredTestValuesFromToml(toml).sort()).toEqual(
      [fakeValue, "0123456789abcdef.0123456789abcdef", "sensitive-interceptions-clear-01"].sort(),
    );
  });

  it("masks the registered value in records, but not near misses or unregistered text, and the merge gate does not report it", () => {
    setRegisteredTestValues(registeredTestValuesFromToml(toml));
    const text = `- 命中 \`token=${fakeValue}\`，另一个 token=${nearMiss}，还有 ${fakeValue} 两次`;
    expect(secretLikeRules(text)).toEqual([]);
    const masked = maskedRecordText(text);
    expect(masked).not.toContain(fakeValue);
    expect(masked).toContain("token=[已遮盖:registered-test-value]");
    expect(masked).toContain(`token=${nearMiss}`);
    expect(secretLikeRules(masked)).toEqual([]);
    expect(secretLikeRules(`token=${nearMiss} 普通文字`)).toEqual([]);
  });

  it("does nothing when no value is registered, and keeps masking real secret shapes", () => {
    expect(maskSecretLike(`token=${fakeValue}`)).toBe(`token=${fakeValue}`);
    setRegisteredTestValues(registeredTestValuesFromToml(toml));
    const real = ["gh", "p_", "A".repeat(24)].join("");
    expect(maskSecretLike(real)).toBe("[已遮盖:github-token]");
  });

  it("gives the same bytes for the same text whatever order the values were registered in", () => {
    const text = `a ${fakeValue} b ${fakeValue}`;
    const expected = "a [已遮盖:registered-test-value] b [已遮盖:registered-test-value]";
    setRegisteredTestValues(registeredTestValuesFromToml(toml));
    expect(maskSecretLike(text)).toBe(expected);
    setRegisteredTestValues([...registeredTestValuesFromToml(toml)].reverse());
    expect(maskSecretLike(text)).toBe(expected);
  });

  it("reads the list from the given commit of the repository, and refuses when it cannot", () => {
    const root = mkdtempSync(join(tmpdir(), "registered-values-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "--quiet", "-b", "main", root]);
      mkdirSync(join(root, "ci/rules"), { recursive: true });
      writeFileSync(join(root, "ci/rules/gitleaks.toml"), toml);
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "rules");
      writeFileSync(join(root, "ci/rules/gitleaks.toml"), "");
      expect(loadRegisteredTestValues(root, "HEAD")).toContain(fakeValue);
      expect(() => loadRegisteredTestValues(root, "no-such-ref")).toThrow(
        "REGISTERED_VALUES_UNREADABLE no-such-ref",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unions the lists of several commits, skips a commit that does not exist, and refuses one without the file", () => {
    const root = mkdtempSync(join(tmpdir(), "registered-values-refs-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "--quiet", "-b", "main", root]);
      mkdirSync(join(root, "ci/rules"), { recursive: true });
      const second = "second-registered-value";
      const commit = (rules, message) => {
        writeFileSync(join(root, "ci/rules/gitleaks.toml"), rules);
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
        return git("rev-parse", "HEAD");
      };
      const older = commit(toml, "old");
      const newer = commit(`regexes = [${quote}^${second}$${quote}]\n`, "new");
      registerTestValuesFromRefs(root, [older, "no-such-ref", newer]);
      expect(maskSecretLike(`${fakeValue} ${second}`)).toBe(
        "[已遮盖:registered-test-value] [已遮盖:registered-test-value]",
      );
      registerTestValuesFromRefs(root, ["no-such-ref"]);
      expect(maskSecretLike(`${fakeValue}`)).toBe(fakeValue);
      git("rm", "--quiet", "ci/rules/gitleaks.toml");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "drop");
      expect(() => registerTestValuesFromRefs(root, ["HEAD"])).toThrow(
        "REGISTERED_VALUES_UNREADABLE HEAD",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("masks the longer of two overlapping registered values whole, whatever order they come in", () => {
    const longer = `${fakeValue}-longer-suffix`;
    for (const order of [
      [fakeValue, longer],
      [longer, fakeValue],
    ]) {
      setRegisteredTestValues(order);
      expect(maskSecretLike(`a ${longer} b ${fakeValue}`)).toBe(
        "a [已遮盖:registered-test-value] b [已遮盖:registered-test-value]",
      );
    }
  });

  it("masks real secret shapes first, so a registered value inside a real token cannot hide the rest", () => {
    const real = ["gh", "p_", "A".repeat(24)].join("");
    setRegisteredTestValues([real.slice(0, 16)]);
    expect(maskSecretLike(`x ${real} y`)).toBe("x [已遮盖:github-token] y");
  });

  it("masks in one pass, so a registered value inside the replacement text cannot corrupt it", () => {
    setRegisteredTestValues(["registered-te", fakeValue]);
    expect(maskSecretLike(`x registered-te y ${fakeValue}`)).toBe(
      "x [已遮盖:registered-test-value] y [已遮盖:registered-test-value]",
    );
  });

  it("finds the values the repository's own allowlist registers", () => {
    const registered = loadRegisteredTestValues(process.cwd(), "HEAD");
    expect(registered).toContain(fakeValue);
    expect(registered).toContain(["MIIEvR2T14", "TAILBODY"].join(""));
    expect(registered.every((value) => value.length >= 12)).toBe(true);
  });
});
