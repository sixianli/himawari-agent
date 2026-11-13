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
  CLIENT_KEY,
  creditReserve,
  creditsLeft,
  creditsPerUsd,
  desktopSignIn,
  floorDecision,
  GATEWAY_PLATFORMS,
  gatewayConfigProblems,
  groupArgs,
  installGateway,
  installGateway as installRealGateway,
  lockFromRelease,
  npmIntegrity,
  PLACEHOLDER,
  postJson,
  readGatewayConfig,
  readGatewayLock,
  readGatewayUsage,
  readStableUsage,
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
  gatewayRequested,
  gatewayRequiredProblem,
  launchModel,
  outputBounds,
  PASSTHROUGH_PROMPT,
  parseArgs,
  parseUsage,
  passthroughProblems,
  providerMoneyUsd,
  REVIEW_MODELS,
  reserveModels,
  reviewConfig,
  startLiveGateway,
  usesCreditProvider,
  withProviderMoney,
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
    const wired = spawnSync(
      process.execPath,
      ["scripts/model-review/opencode-review.mjs", ...base],
      {
        encoding: "utf8",
        env: { ...process.env, HIMAWARI_REVIEW_GATEWAY: "litellm" },
      },
    );
    expect([wired.status, wired.stderr.trim()]).toEqual([2, "ARG_INVALID HIMAWARI_REVIEW_GATEWAY"]);
    expect(parseArgs(base, { defaultGateway: "magpie" }).gateway).toBe("magpie");
    expect(parseArgs([...base, "--gateway", "direct"], { defaultGateway: "magpie" }).gateway).toBe(
      undefined,
    );
    expect(() => parseArgs(base, { defaultGateway: "litellm" })).toThrow(
      "ARG_INVALID HIMAWARI_REVIEW_GATEWAY",
    );
    expect(
      parseArgs(["--assert-reviewed", "--pr", "1"], { defaultGateway: "magpie" }).gateway,
    ).toBeUndefined();
    expect(() => parseArgs([...base, "--gateway", "litellm"])).toThrow("ARG_INVALID --gateway");
    const only = ["--providers", "opendesign,opencode-go,opendesign"];
    expect(parseArgs([...base, "--gateway", "magpie", ...only]).providers).toEqual([
      "opendesign",
      "opencode-go",
    ]);
    expect(parseArgs([...base, ...only], { defaultGateway: "magpie" }).gateway).toBe("magpie");
    expect(() => parseArgs([...base, "--gateway", "direct", ...only])).toThrow(
      "ARG_PROVIDERS_NEED_GATEWAY",
    );
    expect(() => parseArgs([...base, ...only], { defaultGateway: "direct" })).toThrow(
      "ARG_PROVIDERS_NEED_GATEWAY",
    );
    expect(() => parseArgs([...base, ...only])).toThrow("ARG_PROVIDERS_NEED_GATEWAY");
    expect(() => parseArgs([...base, "--gateway", "magpie", "--providers", "a,,b"])).toThrow(
      "ARG_INVALID --providers",
    );
    expect(() =>
      parseArgs([...base, "--gateway", "magpie", "--providers", "opendesign\nREVIEW_CURRENT"]),
    ).toThrow("ARG_INVALID --providers");
    expect(() =>
      parseArgs([...base, "--self-check-only", "--out", "o", "--gateway", "magpie", ...only]),
    ).toThrow("ARG_PROVIDERS_NOT_FOR_SELF_CHECK");
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", ...only])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND",
    );
    const unknown = spawnSync(
      process.execPath,
      [
        "scripts/model-review/opencode-review.mjs",
        ...base,
        "--gateway",
        "magpie",
        "--providers",
        "nope",
      ],
      { encoding: "utf8", env: { ...process.env, HIMAWARI_OPENCODE_BIN: "/nonexistent/opencode" } },
    );
    expect([unknown.status, unknown.stderr.trim()]).toEqual([2, "ARG_INVALID --providers nope"]);
    expect(usesCreditProvider(["opencode-go"], "workbuddy-ai")).toBe(true);
    expect(usesCreditProvider(["opencode-go", "workbuddy-ai"], "workbuddy-ai")).toBe(false);
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", "--gateway", "magpie"])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND",
    );
  });

  it("[gateway] --require-gateway refuses to run anywhere but through Magpie with a proxy, before reading or spending anything", () => {
    const base = ["--mode", "plan", "--head", "HEAD", "--brief", "b.md", "--topic", "x"];
    const need = [...base, "--require-gateway"];
    expect(() => parseArgs(need)).toThrow("GATEWAY_REQUIRED not-magpie");
    expect(() => parseArgs([...need, "--gateway", "direct"], { defaultGateway: "magpie" })).toThrow(
      "GATEWAY_REQUIRED not-magpie",
    );
    expect(parseArgs([...need, "--gateway", "magpie"]).requireGateway).toBe(true);
    expect(parseArgs(need, { defaultGateway: "magpie" }).requireGateway).toBe(true);
    expect(() => parseArgs(["--assert-reviewed", "--pr", "1", "--require-gateway"])).toThrow(
      "ARG_NOT_FOR_SUBCOMMAND",
    );
    const options = { requireGateway: true };
    const cloud = { HIMAWARI_REVIEW_GATEWAY: "magpie" };
    expect(gatewayRequiredProblem(options, {})).toBe("not-cloud");
    expect(gatewayRequiredProblem(options, { HTTPS_PROXY: "http://127.0.0.1:1" })).toBe(
      "not-cloud",
    );
    expect(gatewayRequiredProblem(options, cloud)).toBe("no-proxy");
    expect(gatewayRequiredProblem(options, { ...cloud, HTTPS_PROXY: "  " })).toBe("no-proxy");
    expect(
      gatewayRequiredProblem(options, { ...cloud, https_proxy: "http://127.0.0.1:1" }),
    ).toBeNull();
    expect(gatewayRequiredProblem({}, {})).toBeNull();
    expect(gatewayRequiredProblem({ ...options, selfCheckOnly: true }, {})).toBeNull();
    const refused = spawnSync(
      process.execPath,
      ["scripts/model-review/opencode-review.mjs", ...need, "--gateway", "magpie"],
      { encoding: "utf8", env: { PATH: process.env.PATH, HIMAWARI_OPENCODE_BIN: "/nonexistent" } },
    );
    expect([refused.status, refused.stderr.trim()]).toEqual([2, "GATEWAY_REQUIRED not-cloud"]);
    const noProxy = spawnSync(
      process.execPath,
      ["scripts/model-review/opencode-review.mjs", ...need, "--gateway", "magpie"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HIMAWARI_REVIEW_GATEWAY: "magpie",
          HIMAWARI_OPENCODE_BIN: "/nonexistent",
        },
      },
    );
    expect([noProxy.status, noProxy.stderr.trim()]).toEqual([2, "GATEWAY_REQUIRED no-proxy"]);
  });

  it("[gateway] builds groups in the configured order and drops the credit provider when asked", () => {
    expect(groupArgs(config, deepseek)).toEqual([
      "group",
      "add",
      "review-deepseek-v4.1-flash",
      "models=workbuddy-ai/deepseek-v4.1-flash-sg,opendesign/deepseek-v4.1-flash,opencode-go/deepseek-v4.1-flash",
      "routing=order",
      "stays=session",
    ]);
    expect(groupArgs(config, glm, { dropProviders: ["workbuddy-ai"] })[3]).toBe(
      "models=opendesign/glm-5.3-flash,opencode-go/glm-5.3-flash",
    );
    expect(groupArgs(config, glm, { dropProviders: ["workbuddy-ai", "opendesign"] })[3]).toBe(
      "models=opencode-go/glm-5.3-flash",
    );
    expect(() =>
      groupArgs(config, glm, { dropProviders: ["workbuddy-ai", "opendesign", "opencode-go"] }),
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
    const dropped = (gatewayDropped) =>
      ledgerLine({ gateway: "magpie", providers: {}, gatewayDropped });
    expect(parseUsage(dropped(["opendesign"]), "u")[0].gatewayDropped).toEqual(["opendesign"]);
    for (const bad of ["opendesign", [""], [3]])
      expect(() => parseUsage(dropped(bad), "u")).toThrow("USAGE_LEDGER_INVALID");
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
    expect(summary[glm]).toEqual({ none: { requests: 1, failed: 1 } });
    const unknown = (usage, requested) =>
      gatewayRecordFields(usage, config, deepseek, { requested }).costUnknown;
    expect(unknown(lines, 4)).toBe(true);
    expect(unknown(lines, 3)).toBeUndefined();
    expect(unknown(null, 1)).toBe(true);
    expect(gatewayRecordFields(null, config, deepseek, { requested: 1 }).costUnknownWhy).toBe(
      "usage-unreadable",
    );
    const lopsided = structuredClone(config.models);
    lopsided[glm].members = lopsided[glm].members.filter((m) => !m.startsWith("opendesign/"));
    expect(gatewayConfigProblems({ ...config, models: lopsided }, REVIEW_MODELS)).toContain(
      "models.providers-differ",
    );
    expect(unknown(null, 0)).toBeUndefined();
    const goFailed = { req: lines[0].req, provider: "opencode-go", status: 502 };
    expect(unknown([...lines, goFailed], 0)).toBe(true);
    expect(unknown([...lines, { ...goFailed, in: 9, out: 0 }], 0)).toBeUndefined();
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
    records[0].providers.none = { requests: 1, failed: 1 };
    records[0].providers["workbuddy-ai"].credits = 0.4;
    expect(creditsPerUsd(records, "workbuddy-ai", fallback)).toBeCloseTo(200, 6);
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
      const install = installGateway({
        lock,
        prefix,
        platform: "linux-amd64",
        download,
        pack,
        cacheDirectory: null,
      });
      expect(sha256File(install.binary)).toBe(lock.magpie.assets["linux-amd64"].sha256);
      expect(statSync(install.binary).mode & 0o777).toBe(0o555);
      expect(existsSync(join(install.pluginDir, "package.json"))).toBe(true);
      installGateway({
        lock,
        prefix,
        platform: "linux-amd64",
        download,
        pack,
        cacheDirectory: null,
      });
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
          cacheDirectory: null,
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
          cacheDirectory: null,
        }),
      ).toThrow("GATEWAY_INTEGRITY_MISMATCH plugin");
      expect(() =>
        installGateway({
          lock,
          prefix: join(root, "x"),
          platform: "windows-amd64",
          download,
          pack,
          cacheDirectory: null,
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
    expect(broken({ creditProvider: "opencode-go" })).toContain("creditProvider");
    expect(broken({ creditFloor: 0 })).toContain("creditFloor");
    expect(broken({ stays: "forever" })).toContain("stays");
    const models = structuredClone(config.models);
    models[deepseek].members = ["codebuddy/deepseek-v4.1-flash-sg"];
    delete models[glm].cost.output;
    expect(broken({ models })).toEqual([
      "models.providers-differ",
      `models.${deepseek}.members`,
      `models.${glm}.cost`,
    ]);
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
    expect(unreadable).toBe(4);
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
    ).toEqual({
      gateway: "magpie",
      providers: {},
      costUnknown: true,
      costUnknownWhy: "usage-invalid",
    });
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

const install = () => installRealGateway();

describe("review gateway round 4 fixes", () => {
  it("[gateway] records Go's real spending when it exceeds what OpenCode counted", () => {
    const providers = {
      "workbuddy-ai": { requests: 30, failed: 1, credits: 9.9 },
      "opencode-go": { requests: 6, failed: 1, usd: 0.031 },
      none: { requests: 1, failed: 1 },
    };
    expect(providerMoneyUsd(providers, "workbuddy-ai")).toBeCloseTo(0.031, 10);
    expect(providerMoneyUsd({}, "workbuddy-ai")).toBe(0);
    const record = { gateway: "magpie", cost: 0.02, providers };
    expect(withProviderMoney(record, "workbuddy-ai")).toMatchObject({
      cost: 0.031,
      costFromProviders: 0.02,
    });
    expect(withProviderMoney({ ...record, cost: 0.05 }, "workbuddy-ai")).toEqual({
      ...record,
      cost: 0.05,
    });
    expect(withProviderMoney({ cost: 0.01 }, "workbuddy-ai")).toEqual({ cost: 0.01 });
  });

  it("[gateway] counts a run as having made requests when the spend guard let one through, even with no finished step", () => {
    const review = (steps, allowed) => ({
      summary: { usage: { steps } },
      runs: [{ guard: allowed === undefined ? null : { allowed } }],
    });
    expect(gatewayRequested(review(0, 3))).toBe(3);
    expect(gatewayRequested(review(2, 0))).toBe(2);
    expect(gatewayRequested(review(0, 0))).toBe(0);
    expect(gatewayRequested(review(0))).toBe(0);
  });

  it("[gateway] reads a lone credits window only when it is the plan's own Credits card", () => {
    const one = (name) => [
      { provider: "workbuddy-ai", windows: [{ name, remaining: 40, limit: 100, unit: "credits" }] },
    ];
    expect(creditsLeft(one("Credits"), "workbuddy-ai")).toBe(40);
    expect(creditsLeft(one("Extra credits"), "workbuddy-ai")).toBeNull();
  });

  it("[gateway] refuses provider ids that clash with the usage placeholders and sign-ins on non-plugins", () => {
    const withProviders = (providers) =>
      gatewayConfigProblems({ ...structuredClone(config), providers }, REVIEW_MODELS);
    const base = structuredClone(config.providers);
    expect(withProviders([...base, { id: "none", kind: "preset" }])).toContain("providers.id");
    const models = structuredClone(config.models);
    models[deepseek].members = ["workbuddy-ai/deepseek-v4.1-flash-sg"];
    models["x/deepseek-v4.1-flash"] = models[glm];
    expect(gatewayConfigProblems({ ...config, models }, REVIEW_MODELS)).toEqual(
      expect.arrayContaining([`models.${deepseek}.fallback`, "models.groups"]),
    );
    expect(withProviders([...base, { id: "Bad Id", kind: "preset" }])).toContain("providers.id");
    const emptyCustom = base.map((provider) =>
      provider.id === "opendesign" ? { ...provider, models: [""] } : provider,
    );
    expect(withProviders(emptyCustom)).toContain("providers.opendesign.custom");
    const typo = structuredClone(config.models);
    typo[glm].members[1] = "opendesign/glm-5.3-flash-typo";
    expect(gatewayConfigProblems({ ...config, models: typo }, REVIEW_MODELS)).toContain(
      `models.${glm}.custom`,
    );
    expect(
      withProviders(
        base.map((provider) =>
          provider.id === "opencode-go" ? { ...provider, signIn: "desktop" } : provider,
        ),
      ),
    ).toContain("providers.opencode-go.signIn");
  });

  it("[gateway] counts a usage line that is a JSON array as unreadable", () => {
    expect(summarizeGatewayUsage([["group/review-deepseek-v4.1-flash"]], config).unreadable).toBe(
      1,
    );
  });
});

describe("review gateway round 3 fixes", () => {
  it("[gateway] reserves credits for GLM too when it may stand in for DeepSeek", () => {
    for (const previous of ["abc", undefined])
      expect(reserveModels({ mode: "code-review", previous, models: [deepseek] })).toEqual([
        deepseek,
        glm,
      ]);
    expect(
      reserveModels({ mode: "code-review", previous: undefined, models: REVIEW_MODELS }),
    ).toEqual(REVIEW_MODELS);
    expect(reserveModels({ mode: "code-review", previous: "abc", models: [glm] })).toEqual([glm]);
    expect(reserveModels({ mode: "plan", previous: undefined, models: [deepseek] })).toEqual([
      deepseek,
    ]);
    const reserve = (models) =>
      creditReserve({
        records: [],
        models,
        costLimitUsd: COST_LIMIT_PER_MODEL_USD,
        provider: "workbuddy-ai",
        fallback: 54,
      });
    const left = 35;
    expect(floorDecision({ left, reserve: reserve([deepseek]), floor: 20 }).use).toBe(true);
    expect(
      floorDecision({
        left,
        reserve: reserve(
          reserveModels({ mode: "code-review", previous: "abc", models: [deepseek] }),
        ),
        floor: 20,
      }).use,
    ).toBe(false);
  });

  it("[gateway] reads the credits left from Magpie's real quota output", () => {
    const real = [
      {
        provider: "workbuddy-ai",
        name: "WorkBuddy AI",
        kind: "subscription",
        plan: "Free plan",
        windows: [
          {
            name: "Credits",
            used: 0,
            remaining: 100,
            resetsAt: "2026-11-30T15:59:59Z",
            display: "0 / 100",
            limit: 100,
            unit: "credits",
          },
          {
            name: "Extra credits",
            used: 7.519999993333334,
            remaining: 92.48000000666667,
            display: "11.28 / 150",
            amount: 11.27999999,
            limit: 150,
            unit: "credits",
            runsOutAt: "2026-11-21T03:36:19Z",
            runsOut: 18.72000001,
          },
          {
            name: "Total credits",
            used: 4.511999996,
            remaining: 95.488000004,
            resetsAt: "2026-11-30T15:59:59Z",
            display: "11.28 / 250",
            amount: 11.27999999,
            limit: 250,
            unit: "credits",
            runsOutAt: "2026-11-21T03:36:19Z",
            runsOut: 18.72000001,
            holdsWhy: "low",
          },
        ],
        readAt: "2026-11-07T11:16:00.857632349Z",
      },
      {
        provider: "opencode-go",
        name: "OpenCode Go",
        kind: "plan",
        windows: [],
        error: "OpenCode didn't take this key (401 Unauthorized: Unauthorized)",
      },
    ];
    expect(creditsLeft(real, "workbuddy-ai")).toBeCloseTo(238.72, 4);
    const wrongUnit = structuredClone(real);
    wrongUnit[0].windows[2].unit = "tokens";
    expect(creditsLeft(wrongUnit, "workbuddy-ai")).toBeNull();
  });

  it("[gateway] waits until Magpie's usage file stops growing before reading it", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-stable-"));
    try {
      const file = join(root, "config", "magpie", "usage.jsonl");
      mkdirSync(join(root, "config", "magpie"), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ req: "group/review-deepseek-v4.1-flash" })}\n{"req":"gro`,
      );
      expect(readGatewayUsage(root)).toHaveLength(1);
      writeFileSync(file, `${JSON.stringify({ req: "group/review-deepseek-v4.1-flash" })}\n`);
      setTimeout(
        () =>
          writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ req: "late" })}\n`),
        100,
      );
      expect(await readStableUsage(root, { waitMs: 200, tries: 4 })).toHaveLength(2);
      expect(await readStableUsage(join(root, "absent"), { waitMs: 10, tries: 2 })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("review gateway usage gaps", () => {
  it("[gateway] marks the cost unknown when an answered request lacks its tokens or credits, or names an unknown provider", () => {
    const answered = (line) => [{ req: "group/review-deepseek-v4.1-flash", status: 200, ...line }];
    for (const line of [
      { provider: "workbuddy-ai" },
      { provider: "opencode-go", out: 3 },
      { provider: "opencode-go", in: 3 },
      { provider: "codebuddy", in: 3, out: 1, credits: 0.1 },
    ])
      expect(gatewayRecordFields(answered(line), config, deepseek).costUnknown).toBe(true);
    expect(
      gatewayRecordFields(answered({ provider: "opencode-go", in: 3, out: 1 }), config, deepseek)
        .costUnknown,
    ).toBeUndefined();
    expect(
      gatewayRecordFields(
        [{ req: "group/review-deepseek-v4.1-flash", provider: "workbuddy-ai", status: 502 }],
        config,
        deepseek,
      ).costUnknown,
    ).toBeUndefined();
  });

  it("[gateway] marks the cost unknown when OpenCode made requests but Magpie recorded none for the model", () => {
    expect(gatewayRecordFields([], config, deepseek, { requested: true })).toEqual({
      gateway: "magpie",
      providers: {},
      costUnknown: true,
      costUnknownWhy: "unreadable=0 recorded=0 requested=1",
    });
    const glmLine = { req: "group/review-glm-5.3-flash", provider: "opendesign", status: 200 };
    const deepseekLine = {
      req: "group/review-deepseek-v4.1-flash",
      provider: "workbuddy-ai",
      status: 200,
      credits: 1,
    };
    const both = [glmLine, deepseekLine];
    expect(
      gatewayRecordFields(both, config, deepseek, { requested: 1 }).costUnknown,
    ).toBeUndefined();
    expect(gatewayRecordFields(both, config, glm, { requested: 1 })).toMatchObject({
      costUnknown: true,
      costUnknownWhy: "unreadable=1 recorded=1 requested=1",
    });
    expect(
      gatewayRecordFields([...both, "garbage"], config, deepseek, { requested: 1 }).costUnknown,
    ).toBe(true);
    expect(gatewayRecordFields([], config, deepseek)).toEqual({ gateway: "magpie", providers: {} });
  });

  it("[gateway] reads a usage file it cannot open as unknown instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-usage-"));
    try {
      mkdirSync(join(root, "config", "magpie", "usage.jsonl"), { recursive: true });
      expect(readGatewayUsage(root)).toBeNull();
      expect(readGatewayUsage(join(root, "absent"))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[gateway] compares user messages exactly and normalizes model names only in the system message", () => {
    const direct = {
      messages: [
        { role: "system", content: "named deepseek-v4.1-flash" },
        { role: "user", content: "about deepseek-v4.1-flash" },
      ],
      tools: [],
    };
    const via = {
      messages: [
        { role: "system", content: "named group/review-deepseek-v4.1-flash" },
        { role: "user", content: "about group/review-deepseek-v4.1-flash" },
      ],
      tools: [],
    };
    expect(passthroughProblems(direct, via, deepseek)).toContain(
      "GATEWAY_PASSTHROUGH_MESSAGES_CHANGED",
    );
    via.messages[1].content = "about deepseek-v4.1-flash";
    expect(passthroughProblems(direct, via, deepseek)).not.toContain(
      "GATEWAY_PASSTHROUGH_MESSAGES_CHANGED",
    );
  });

  it("[gateway] reports a Magpie binary that cannot start instead of crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-spawn-"));
    try {
      const live = await startGateway({
        install: {
          binary: join(root, "no-such-magpie"),
          pluginDir: join(root, "plugin"),
          cacheDir: join(root, "cache"),
          version: readGatewayLock().magpie.version,
        },
        config,
        root: join(root, "run"),
        models: [],
        providers: [],
      });
      await expect(live.serve()).rejects.toThrow("GATEWAY_START_FAILED");
      expect(runningGatewayCount()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("review gateway live start", () => {
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
        const fields = gatewayRecordFields(await live.stableUsage(), gatewayConfig, deepseek);
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

  it.each([
    ["is not served by its provider", (port) => `http://localhost:${port}/v1`, ["down"]],
    ["sits behind a refused port", () => "http://127.0.0.1:9/v1", null],
  ])(
    "[gateway] keeps the review on the other providers when a member %s",
    async (_label, url, dropped) => {
      const upstream = await probeServer();
      const root = mkdtempSync(join(tmpdir(), "gateway-drop-"));
      try {
        const member = dropped ? (short) => `down/${short}-gone` : (short) => `down/${short}`;
        const base = liveConfig(upstream.port, (short) => [member(short), `probe/${short}`]);
        const down = { ...base.providers[1], id: "down", url: url(upstream.port) };
        const gatewayConfig = { ...base, providers: [...base.providers, down] };
        const { live, drop } = await startLiveGateway({
          gateway: { install: install(), config: gatewayConfig },
          workRoot: root,
          records: [],
          models: REVIEW_MODELS,
          accountUid: () => null,
        });
        try {
          if (dropped) expect(drop).toEqual(["workbuddy-ai", ...dropped]);
          const answer = await postJson(`${live.baseURL}/chat/completions`, {
            model: "group/review-deepseek-v4.1-flash",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          });
          expect(answer.status).toBe(200);
          expect(upstream.hits()).toBeGreaterThan(0);
        } finally {
          live.stop();
        }
      } finally {
        upstream.server.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );

  it("[gateway] with a list of providers, only those are set up and serve the review", async () => {
    const upstream = await probeServer();
    const root = mkdtempSync(join(tmpdir(), "gateway-only-"));
    try {
      const base = liveConfig(upstream.port, (short) => [`down/${short}`, `probe/${short}`]);
      const down = { ...base.providers[1], id: "down" };
      const gatewayConfig = { ...base, providers: [...base.providers, down] };
      const { live, drop } = await startLiveGateway({
        gateway: { install: install(), config: gatewayConfig },
        workRoot: root,
        records: [],
        models: [deepseek],
        accountUid: () => {
          throw new Error("credit provider asked although not listed");
        },
        only: ["probe"],
      });
      try {
        expect(drop).toEqual(["workbuddy-ai", "down"]);
        const answer = await postJson(`${live.baseURL}/chat/completions`, {
          model: "group/review-deepseek-v4.1-flash",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });
        expect([answer.status, upstream.hits()]).toEqual([200, 1]);
      } finally {
        live.stop();
      }
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
  it.each([
    ["plan", []],
    ["code-review", ["--base", "HEAD~1"]],
  ])(
    "[gateway] passes the real %s self-check through a local Magpie, including passthrough, failover and the spend guard",
    (mode, extra) => {
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
            mode,
            ...extra,
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
    },
    600000,
  );
});

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
