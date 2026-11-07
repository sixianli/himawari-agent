import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binaryProblem,
  creditReserve,
  creditsLeft,
  creditsPerUsd,
  desktopSignIn,
  floorDecision,
  gatewayConfigProblems,
  CLIENT_KEY,
  GATEWAY_PLATFORMS,
  groupArgs,
  installGateway,
  lockFromRelease,
  npmIntegrity,
  PLACEHOLDER,
  readGatewayConfig,
  readGatewayLock,
  installGateway as installRealGateway,
  postJson,
  runningGatewayCount,
  sha256File,
  startGateway,
  stopAllGateways,
  summarizeGatewayUsage,
} from "../../scripts/model-review/gateway.mjs";
import {
  asDirect,
  COST_LIMIT_PER_MODEL_USD,
  gatewayOpencodeEnv,
  gatewayProvider,
  gatewayRecordFields,
  launchModel,
  outputBounds,
  parseArgs,
  parseUsage,
  passthroughProblems,
  PASSTHROUGH_PROMPT,
  REVIEW_MODELS,
  reviewConfig,
  startLiveGateway,
} from "../../scripts/model-review/opencode-review.mjs";

const config = readGatewayConfig();
const routed = { baseURL: "http://127.0.0.1:43125/v1", config };
const [deepseek, glm] = REVIEW_MODELS;

const ledgerLine = (extra = {}) =>
  JSON.stringify({
    at: "2026-11-07T00:00:00.000Z",
    round: 1,
    mode: "plan",
    model: deepseek,
    head: "a".repeat(40),
    outcome: "ok",
    cost: 0.01,
    ...extra,
  });

describe("review gateway configuration", () => {
  it("[gateway] leaves the direct configuration exactly as it was when the gateway is off", () => {
    for (const mode of ["code-review", "plan", "plan-review"]) {
      expect(reviewConfig({ mode, gateway: undefined })).toEqual(reviewConfig({ mode }));
      expect(reviewConfig({ mode }).provider).toEqual({ "opencode-go": {} });
    }
  });

  it("[gateway] routes every review model to its own prefixed group with the declared limit and price", () => {
    const provider = reviewConfig({ mode: "code-review", gateway: routed }).provider;
    expect(Object.keys(provider)).toEqual(["magpie"]);
    expect(provider.magpie.options).toEqual({
      baseURL: routed.baseURL,
      apiKey: CLIENT_KEY,
    });
    expect(Object.keys(provider.magpie.models).sort()).toEqual([
      "group/review-deepseek-v4.1-flash",
      "group/review-glm-5.3-flash",
    ]);
    const declared = provider.magpie.models["group/review-glm-5.3-flash"];
    expect(declared.limit.output).toBe(config.models[glm].output);
    expect(declared.cost).toEqual(config.models[glm].cost);
    expect(declared.variants).toEqual({ high: { reasoningEffort: "high" } });
    expect(launchModel(deepseek, routed)).toBe("magpie/group/review-deepseek-v4.1-flash");
    expect(launchModel(deepseek, undefined)).toBe(deepseek);
  });

  it("[gateway] puts the placeholder key only next to a loopback address", () => {
    for (const baseURL of [
      "http://10.0.0.5:3425/v1",
      "https://127.0.0.1:3425/v1",
      "http://example.com/v1",
    ])
      expect(() => gatewayProvider({ baseURL, config })).toThrow("GATEWAY_NOT_LOOPBACK");
    expect(JSON.stringify(reviewConfig({ mode: "plan", gateway: routed }))).toContain(CLIENT_KEY);
  });

  it("[gateway] sends OpenCode straight to the local gateway and keeps web search for plan modes", () => {
    const env = gatewayOpencodeEnv({ NO_PROXY: "example.com,127.0.0.1" });
    expect(env.NO_PROXY.split(",").sort()).toEqual(["127.0.0.1", "example.com", "localhost"]);
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(env.OPENCODE_ENABLE_EXA).toBe("1");
    expect(gatewayOpencodeEnv({}).NO_PROXY).toBe("127.0.0.1,localhost");
  });

  it("[gateway] checks the exact declared output limit through the gateway and the old minimum without it", () => {
    expect(outputBounds("glm-5.3-flash", routed)).toEqual({ min: 32000, max: 32000 });
    expect(outputBounds("deepseek-v4.1-flash", routed)).toEqual({ min: 128000, max: 128000 });
    expect(outputBounds("glm-5.3-flash", undefined)).toEqual({ min: 100000, max: 131072 });
    expect(outputBounds("unknown-model", routed)).toBeNull();
  });

  it("[gateway] accepts only the known gateway on the command line", () => {
    const base = ["--mode", "plan", "--head", "HEAD", "--brief", "b.md", "--topic", "x"];
    expect(parseArgs([...base, "--gateway", "magpie"]).gateway).toBe("magpie");
    expect(parseArgs(base).gateway).toBeUndefined();
    expect(() => parseArgs([...base, "--gateway", "litellm"])).toThrow("ARG_INVALID --gateway");
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", "--gateway", "magpie"])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND",
    );
  });

  it("[gateway] builds groups in the configured order and drops the credit provider when asked", () => {
    expect(groupArgs(config, deepseek)).toEqual([
      "group",
      "add",
      "review-deepseek-v4.1-flash",
      `models=${config.models[deepseek].members.join(",")}`,
      "routing=order",
      "stays=session",
    ]);
    expect(groupArgs(config, glm, { dropProviders: ["workbuddy-ai"] })[3]).toBe(
      "models=opencode-go/glm-5.3-flash",
    );
    expect(() =>
      groupArgs(config, glm, { dropProviders: ["workbuddy-ai", "opencode-go"] }),
    ).toThrow("GATEWAY_NO_MEMBERS");
  });

  it("[gateway] signs in with a placeholder that the egress proxy replaces, never a real token", () => {
    const file = desktopSignIn({ uid: "user-1", now: 0 });
    expect(file.auth.accessToken).toBe(PLACEHOLDER);
    expect(file.auth.refreshToken).toBe("");
    expect(file.account.uid).toBe("user-1");
    expect(file.auth.expiresAt).toBeGreaterThan(0);
  });
});

describe("review gateway ledger", () => {
  it("[gateway] still reads every committed ledger written before the gateway existed", () => {
    for (const dir of ["pr-273", "topic-review-gateway-magpie"]) {
      const path = join(".agents", "reviews", dir, "usage.jsonl");
      expect(parseUsage(readFileSync(path, "utf8"), path).length).toBeGreaterThan(0);
    }
  });

  it("[gateway] requires per-provider usage on every gateway line", () => {
    expect(() => parseUsage(ledgerLine({ gateway: "magpie" }), "u")).toThrow(
      "USAGE_LEDGER_INVALID",
    );
    expect(() =>
      parseUsage(
        ledgerLine({
          gateway: "magpie",
          providers: { "workbuddy-ai": { requests: 2, failed: 0, credits: -1 } },
        }),
        "u",
      ),
    ).toThrow("USAGE_LEDGER_INVALID");
    expect(() => parseUsage(ledgerLine({ gateway: "litellm", providers: {} }), "u")).toThrow(
      "USAGE_LEDGER_INVALID",
    );
    const ok = ledgerLine({
      gateway: "magpie",
      providers: {
        "workbuddy-ai": { requests: 3, failed: 1, credits: 0.4 },
        "opencode-go": { requests: 1, failed: 0, usd: 0.002 },
      },
    });
    expect(parseUsage(ok, "u")[0].providers["workbuddy-ai"].credits).toBe(0.4);
  });

  it("[gateway] counts usage per review model and provider, credits for CodeBuddy and dollars for Go", () => {
    const lines = [
      {
        req: "group/review-deepseek-v4.1-flash",
        provider: "workbuddy-ai",
        status: 200,
        credits: 0.3,
        in: 100,
        out: 10,
      },
      {
        req: "group/review-deepseek-v4.1-flash",
        provider: "workbuddy-ai",
        status: 502,
        credits: 0,
      },
      {
        req: "group/review-deepseek-v4.1-flash",
        provider: "opencode-go",
        status: 200,
        in: 1e6,
        out: 0,
        reasoning: 0,
        cache_read: 1e6,
      },
      { req: "group/review-glm-5.3-flash", provider: "", status: 404 },
      { req: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", status: 200, in: 5 },
    ];
    const { byModel: summary, unreadable } = summarizeGatewayUsage(lines, config);
    expect(unreadable).toBe(0);
    expect(summary[deepseek]["workbuddy-ai"]).toEqual({ requests: 2, failed: 1, credits: 0.3 });
    expect(summary[deepseek]["opencode-go"].usd).toBeCloseTo(0.15 + 0.003, 10);
    expect(summary[glm]).toEqual({ none: { requests: 1, failed: 1, usd: 0 } });
    expect(gatewayRecordFields(null, config, deepseek)).toEqual({
      gateway: "magpie",
      providers: {},
      costUnknown: true,
    });
  });
});

describe("review gateway credit floor", () => {
  const quota = [
    {
      provider: "workbuddy-ai",
      windows: [
        { name: "Credits", remaining: 100, limit: 100, unit: "credits" },
        { name: "Total credits", remaining: 95.488, limit: 250, unit: "credits" },
      ],
    },
  ];

  it("[gateway] reads what is left from the total credits card", () => {
    expect(creditsLeft(quota, "workbuddy-ai")).toBeCloseTo(238.72, 6);
    expect(creditsLeft(quota, "opencode-go")).toBeNull();
    expect(creditsLeft([{ provider: "workbuddy-ai", windows: [] }], "workbuddy-ai")).toBeNull();
    expect(creditsLeft("not a list", "workbuddy-ai")).toBeNull();
  });

  it("[gateway] reserves the dollar cap at the highest credits-per-dollar seen, never below the measured default", () => {
    const fallback = config.defaultCreditsPerUsd;
    expect(
      creditReserve({
        records: [],
        models: REVIEW_MODELS,
        costLimitUsd: COST_LIMIT_PER_MODEL_USD,
        provider: "workbuddy-ai",
        fallback,
      }),
    ).toBeCloseTo(2 * COST_LIMIT_PER_MODEL_USD * fallback, 6);
    const records = [
      {
        gateway: "magpie",
        cost: 0.002,
        providers: { "workbuddy-ai": { requests: 7, failed: 0, credits: 0.2 } },
      },
      {
        gateway: "magpie",
        cost: 0.01,
        providers: { "workbuddy-ai": { credits: 5 }, "opencode-go": { usd: 0.01 } },
      },
      { cost: 0.08 },
    ];
    expect(creditsPerUsd(records, "workbuddy-ai", fallback)).toBeCloseTo(100, 6);
  });

  it("[gateway] keeps CodeBuddy only while the credits left after the reserve stay at or above the floor", () => {
    expect(floorDecision({ left: 45, reserve: 21.6, floor: 20 }).use).toBe(true);
    expect(floorDecision({ left: 41.6, reserve: 21.6, floor: 20 }).use).toBe(true);
    expect(floorDecision({ left: 41, reserve: 21.6, floor: 20 })).toMatchObject({ use: false });
    expect(floorDecision({ left: 19, reserve: 0, floor: 20 }).use).toBe(false);
    expect(floorDecision({ left: null, reserve: 0, floor: 20 })).toEqual({
      use: false,
      reason: "credits-unknown",
    });
  });
});

describe("review gateway passthrough", () => {
  const request = (text) => ({
    messages: [
      { role: "system", content: `You are powered by the model named ${text}.` },
      { role: "user", content: PASSTHROUGH_PROMPT },
    ],
    tools: [{ type: "function", function: { name: "read" } }],
  });

  it("[gateway] passes when only OpenCode's own model name differs", () => {
    const direct = request(
      "deepseek-v4.1-flash. The exact model ID is opencode-go/deepseek-v4.1-flash",
    );
    const via = request(
      "group/review-deepseek-v4.1-flash. The exact model ID is magpie/group/review-deepseek-v4.1-flash",
    );
    expect(asDirect(JSON.stringify(via.messages), deepseek)).toBe(JSON.stringify(direct.messages));
    expect(passthroughProblems(direct, via, deepseek)).toEqual([]);
  });

  it("[gateway] fails when the gateway changed, masked or dropped what OpenCode sent", () => {
    const direct = request("deepseek-v4.1-flash");
    const masked = {
      ...direct,
      messages: [
        direct.messages[0],
        {
          role: "user",
          content: PASSTHROUGH_PROMPT.replace("probe-owner@example.com", "{{EMAIL_1}}"),
        },
      ],
    };
    expect(passthroughProblems(direct, masked, deepseek)).toEqual([
      "GATEWAY_PASSTHROUGH_MESSAGES_CHANGED",
      "GATEWAY_PASSTHROUGH_PROMPT_MASKED",
    ]);
    expect(passthroughProblems(direct, { ...direct, tools: [] }, deepseek)).toEqual([
      "GATEWAY_PASSTHROUGH_TOOLS_CHANGED",
    ]);
    expect(passthroughProblems(direct, undefined, deepseek)).toEqual([
      "GATEWAY_PASSTHROUGH_NO_REQUEST",
    ]);
  });
});

describe("review gateway install", () => {
  const feed = {
    version: "0.1.9",
    assets: Object.fromEntries(
      GATEWAY_PLATFORMS.map((key) => [
        `magpie-cli-${key}`,
        { url: `https://example.invalid/${key}`, sha256: "a".repeat(64) },
      ]),
    ),
  };
  const plugin = { name: "@x/plugin", version: "1.0.0", integrity: "sha512-abc" };

  it("[gateway lock] pins every supported platform and the plugin, and refuses an incomplete feed", () => {
    const lock = lockFromRelease({ feed, plugin });
    expect(Object.keys(lock.magpie.assets)).toEqual(GATEWAY_PLATFORMS);
    const partial = { ...feed, assets: { ...feed.assets } };
    delete partial.assets["magpie-cli-darwin-arm64"];
    expect(() => lockFromRelease({ feed: partial, plugin })).toThrow("GATEWAY_FEED_INCOMPLETE");
    expect(() => lockFromRelease({ feed, plugin: { ...plugin, integrity: "md5-x" } })).toThrow(
      "GATEWAY_PLUGIN_INCOMPLETE",
    );
    const committed = readGatewayLock();
    expect(Object.keys(committed.magpie.assets)).toEqual(GATEWAY_PLATFORMS);
    for (const asset of Object.values(committed.magpie.assets))
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(committed.plugin.integrity).toMatch(/^sha512-/);
  });

  it("[gateway lock] installs only a binary and plugin whose digests match the lock, and notices a changed binary", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-install-"));
    try {
      const good = Buffer.from("magpie binary");
      const source = join(root, "plugin-src", "package");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "package.json"), '{"name":"@x/plugin","version":"1.0.0"}');
      const tarball = join(root, "plugin.tgz");
      expect(
        spawnSync("tar", ["-czf", tarball, "-C", join(root, "plugin-src"), "package"]).status,
      ).toBe(0);
      const lock = {
        magpie: {
          version: "0.1.9",
          assets: { "linux-amd64": { url: "u", sha256: sha256Of(good) } },
        },
        plugin: { ...plugin, integrity: npmIntegrity(tarball) },
      };
      let downloads = 0;
      const download = (_url, target) => {
        downloads += 1;
        writeFileSync(target, good);
      };
      const pack = (_spec, destination) => {
        const copy = join(destination, "p.tgz");
        writeFileSync(copy, readFileSync(tarball));
        return copy;
      };
      const prefix = join(root, "install");
      const install = installGateway({ lock, prefix, platform: "linux-amd64", download, pack });
      expect(sha256File(install.binary)).toBe(lock.magpie.assets["linux-amd64"].sha256);
      expect(statSync(install.binary).mode & 0o777).toBe(0o555);
      expect(existsSync(join(install.pluginDir, "package.json"))).toBe(true);
      installGateway({ lock, prefix, platform: "linux-amd64", download, pack });
      expect(downloads).toBe(1);
      expect(binaryProblem(install)).toBeNull();
      chmodSync(install.binary, 0o755);
      writeFileSync(install.binary, "replaced by an update");
      expect(binaryProblem(install)).toMatch(/^GATEWAY_BINARY_CHANGED/);

      const badPrefix = join(root, "bad");
      expect(() =>
        installGateway({
          lock,
          prefix: badPrefix,
          platform: "linux-amd64",
          download: (_url, target) => writeFileSync(target, "tampered"),
          pack,
        }),
      ).toThrow("GATEWAY_INTEGRITY_MISMATCH magpie");
      expect(existsSync(join(badPrefix, "magpie"))).toBe(false);
      expect(() =>
        installGateway({
          lock: { ...lock, plugin: { ...lock.plugin, integrity: "sha512-wrong" } },
          prefix: join(root, "bad-plugin"),
          platform: "linux-amd64",
          download,
          pack,
        }),
      ).toThrow("GATEWAY_INTEGRITY_MISMATCH plugin");
      expect(() =>
        installGateway({
          lock,
          prefix: join(root, "x"),
          platform: "windows-amd64",
          download,
          pack,
        }),
      ).toThrow("GATEWAY_PLATFORM_UNSUPPORTED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("review gateway hardening", () => {
  it("[gateway] matches the direct configuration of the commit before the gateway, byte for byte", () => {
    const before = {
      "code-review": "220dd623ff95b44bfd27c1ecf80287ec7a1690fd0d1348bc2674b885ead9f9b6",
      "code-review+wrapUp": "b6dd6cd61b2508da483d3f1687f8c2a85c3f39643f82f2a134a13fbdfb61e7c6",
      plan: "93f1ae700b04b0d266eb847f2f9be9e1759c9d6ea13943870be0d0e4c4514de1",
      "plan+wrapUp": "3fba1c65bd37e8dc1e3b1da3bece28823eeefa84841e0647ca2c6536319c3e87",
      "plan-review": "93f1ae700b04b0d266eb847f2f9be9e1759c9d6ea13943870be0d0e4c4514de1",
      "plan-review+wrapUp": "3fba1c65bd37e8dc1e3b1da3bece28823eeefa84841e0647ca2c6536319c3e87",
    };
    for (const mode of ["code-review", "plan", "plan-review"])
      for (const wrapUp of [false, true]) {
        const text = JSON.stringify(reviewConfig({ mode, wrapUp }))
          .split(process.cwd())
          .join("<ROOT>");
        expect(createHash("sha256").update(text).digest("hex")).toBe(
          before[`${mode}${wrapUp ? "+wrapUp" : ""}`],
        );
      }
  });

  it("[gateway] refuses a gateway configuration that would silently turn the credit floor off", () => {
    expect(gatewayConfigProblems(config, REVIEW_MODELS)).toEqual([]);
    const broken = (change) =>
      gatewayConfigProblems({ ...structuredClone(config), ...change }, REVIEW_MODELS);
    expect(broken({ creditFloor: undefined })).toContain("creditFloor");
    expect(broken({ defaultCreditsPerUsd: Number.NaN })).toContain("defaultCreditsPerUsd");
    expect(broken({ creditProvider: "workbuddy" })).toContain("creditProvider");
    expect(broken({ stays: "forever" })).toContain("stays");
    const models = structuredClone(config.models);
    models[deepseek].members = ["codebuddy/deepseek-v4.1-flash-sg"];
    delete models[glm].cost.output;
    expect(broken({ models })).toEqual([`models.${deepseek}.members`, `models.${glm}.cost`]);
    const { [glm]: _dropped, ...onlyDeepseek } = config.models;
    expect(broken({ models: onlyDeepseek })).toEqual([`models.${glm}`]);
    expect(() => readGatewayConfig(join(tmpdir(), "missing-gateway.json"))).toThrow();
  });

  it("[gateway] keeps CodeBuddy out when the floor numbers are not numbers", () => {
    expect(floorDecision({ left: 200, reserve: Number.NaN, floor: 20 })).toEqual({
      use: false,
      reason: "floor-invalid",
    });
    expect(floorDecision({ left: 200, reserve: 10, floor: undefined })).toEqual({
      use: false,
      reason: "floor-invalid",
    });
  });

  it("[gateway] refuses a credits card whose percent and used amount disagree", () => {
    const card = (window) => [
      {
        provider: "workbuddy-ai",
        windows: [{ name: "Total credits", unit: "credits", ...window }],
      },
    ];
    expect(
      creditsLeft(card({ remaining: 95.488, limit: 250, amount: 11.28 }), "workbuddy-ai"),
    ).toBeCloseTo(238.72, 6);
    expect(
      creditsLeft(card({ remaining: 238.72, limit: 250, amount: 11.28 }), "workbuddy-ai"),
    ).toBeNull();
    expect(
      creditsLeft(card({ remaining: 90, limit: 250, amount: 11.28 }), "workbuddy-ai"),
    ).toBeNull();
    expect(creditsLeft(card({ remaining: 50, limit: 100 }), "workbuddy-ai")).toBe(50);
  });

  it("[gateway] writes a ledger line even when Magpie's usage record is malformed, marking the cost unknown", () => {
    const polluted = [
      null,
      { req: "group/review-deepseek-v4.1-flash", provider: "__proto__", status: 200, in: 1 },
      {
        req: "group/review-deepseek-v4.1-flash",
        provider: "workbuddy-ai",
        status: 200,
        credits: "lots",
      },
      { req: "group/review-glm-5.3-flash", provider: "opencode-go", status: 200, in: Number.NaN },
      { req: { toString: () => "group/review-glm-5.3-flash" }, provider: "opencode-go" },
    ];
    const { byModel, unreadable } = summarizeGatewayUsage(polluted, config);
    expect(unreadable).toBe(3);
    expect({}.requests).toBeUndefined();
    expect(Object.keys(byModel[deepseek]).sort()).toEqual(["unknown", "workbuddy-ai"]);
    const fields = gatewayRecordFields(polluted, config, deepseek);
    expect(fields.costUnknown).toBe(true);
    expect(parseUsage(ledgerLine(fields), "u")).toHaveLength(1);
    const noPrices = {
      ...config,
      models: { [deepseek]: { ...config.models[deepseek], cost: undefined } },
    };
    expect(
      gatewayRecordFields(
        [{ req: "group/review-deepseek-v4.1-flash", provider: "opencode-go", status: 200 }],
        noPrices,
        deepseek,
      ),
    ).toEqual({ gateway: "magpie", providers: {}, costUnknown: true });
  });
});

function probeServer() {
  let hits = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: REVIEW_MODELS.map((model) => ({ id: model.split("/").pop() })),
          }),
        );
        return;
      }
      hits += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "p", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveStart) =>
    server.listen(0, "127.0.0.1", () =>
      resolveStart({ server, port: server.address().port, hits: () => hits }),
    ),
  );
}

describe("review gateway live start", () => {
  const install = () => installRealGateway();
  const liveConfig = (port, members) => ({
    ...structuredClone(config),
    providers: [
      { id: "workbuddy-ai", kind: "plugin", signIn: "desktop" },
      {
        id: "probe",
        kind: "custom",
        url: `http://127.0.0.1:${port}/v1`,
        models: REVIEW_MODELS.map((model) => model.split("/").pop()),
      },
    ],
    models: Object.fromEntries(
      REVIEW_MODELS.map((model) => [
        model,
        { ...config.models[model], members: members(model.split("/").pop()) },
      ]),
    ),
  });

  it("[gateway] goes without CodeBuddy when its sign-in is unavailable, serves the review and records usage per provider", async () => {
    const upstream = await probeServer();
    const root = mkdtempSync(join(tmpdir(), "gateway-live-"));
    try {
      const gatewayConfig = liveConfig(upstream.port, (short) => [
        `workbuddy-ai/${short}`,
        `probe/${short}`,
      ]);
      expect(gatewayConfigProblems(gatewayConfig, REVIEW_MODELS)).toEqual([]);
      const { live, drop } = await startLiveGateway({
        gateway: { install: install(), config: gatewayConfig },
        workRoot: root,
        records: [],
        models: [deepseek],
        accountUid: () => null,
      });
      try {
        expect(drop).toEqual(["workbuddy-ai"]);
        const answer = await postJson(`${live.baseURL}/chat/completions`, {
          model: "group/review-deepseek-v4.1-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });
        expect(answer.status).toBe(200);
        expect(upstream.hits()).toBe(1);
        const fields = gatewayRecordFields(live.usage(), gatewayConfig, deepseek);
        expect(fields.costUnknown).toBeUndefined();
        expect(fields.providers.probe).toMatchObject({ requests: 1, failed: 0 });
        expect(fields.providers["workbuddy-ai"]).toBeUndefined();
      } finally {
        live.stop();
      }
    } finally {
      upstream.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);

  it("[gateway] stops before any model call when a group member is not served, and leaves no Magpie running", async () => {
    const upstream = await probeServer();
    const root = mkdtempSync(join(tmpdir(), "gateway-preflight-"));
    try {
      await expect(
        startLiveGateway({
          gateway: {
            install: install(),
            config: liveConfig(upstream.port, (short) => [
              `probe/${short}`,
              `probe/${short}-missing`,
            ]),
          },
          workRoot: root,
          records: [],
          models: REVIEW_MODELS,
          accountUid: () => null,
        }),
      ).rejects.toThrow("GATEWAY_PREFLIGHT_FAILED");
      expect(upstream.hits()).toBe(0);
      expect(runningGatewayCount()).toBe(0);
    } finally {
      upstream.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);

  it("[gateway] stops every Magpie it started, including ones nobody kept a handle to", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-stop-all-"));
    try {
      const gateways = [];
      for (const name of ["a", "b"]) {
        const live = await startGateway({
          install: install(),
          config,
          root: join(root, name),
          models: [],
          providers: [],
        });
        await live.serve();
        gateways.push(live.child().pid);
      }
      expect(runningGatewayCount()).toBe(2);
      stopAllGateways();
      expect(runningGatewayCount()).toBe(0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      for (const pid of gateways) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      stopAllGateways();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});

describe("review gateway self-check", () => {
  it("[gateway] passes the real self-check through a local Magpie, including passthrough, failover and the spend guard", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-selfcheck-"));
    try {
      const brief = join(root, "brief.md");
      writeFileSync(brief, "self-check\n");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/model-review/opencode-review.mjs",
          "--self-check-only",
          "--mode",
          "plan",
          "--head",
          "HEAD",
          "--brief",
          brief,
          "--out",
          join(root, "out"),
          "--gateway",
          "magpie",
        ],
        { encoding: "utf8", timeout: 540000 },
      );
      const text = result.stdout + result.stderr;
      expect(text).toContain("SELF_CHECK_OK");
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600000);
});

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
