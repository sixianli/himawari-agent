import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  notaryToken,
  outcomeOf,
  submissionStatus,
} from "../../clients/apple/scripts/notary-status.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ format: "pem", type: "pkcs8" });
const id = "2efe2717-52ef-43a5-96dc-0797e4ca1041";
const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

const stub = (routes) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => route };
  };
  return { fetchImpl, seen };
};

describe("苹果公证状态查询", () => {
  it("用 App Store Connect 密钥签出 ES256 令牌，苹果的公钥能验过", () => {
    const token = notaryToken({
      keyId: "KEY123",
      issuerId: "issuer-1",
      privateKey: pem,
      now: 1000,
    });
    const [header, payload, signature] = token.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(decode(payload)).toEqual({
      iss: "issuer-1",
      iat: 1000,
      exp: 1900,
      aud: "appstoreconnect-v1",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
  it.each([
    ["Accepted", "accepted"],
    ["In Progress", "waiting"],
    ["Invalid", "rejected"],
    ["Rejected", "rejected"],
  ])("苹果说 %s 时结论是 %s", (status, outcome) => {
    expect(outcomeOf(status)).toBe(outcome);
  });
  it("不认识的状态直接报错，不当成通过或等待", () => {
    expect(() => outcomeOf("Accepted ")).toThrow("NOTARY_UNKNOWN_STATUS");
    expect(() => outcomeOf(undefined)).toThrow("NOTARY_UNKNOWN_STATUS");
  });
  it("查到通过时只问一次状态，带上令牌", async () => {
    const base = `https://notary.test/notary/v2/submissions/${id}`;
    const { fetchImpl, seen } = stub({ [base]: { data: { attributes: { status: "Accepted" } } } });
    const result = await submissionStatus({
      id,
      token: "t",
      origin: "https://notary.test",
      fetchImpl,
    });
    expect(result).toEqual({ status: "Accepted", outcome: "accepted" });
    expect(seen).toEqual([{ url: base, authorization: "Bearer t" }]);
  });
  it("被拒时再取一次日志地址，方便看原因", async () => {
    const base = `https://notary.test/notary/v2/submissions/${id}`;
    const { fetchImpl, seen } = stub({
      [base]: { data: { attributes: { status: "Invalid" } } },
      [`${base}/logs`]: { data: { attributes: { developerLogUrl: "https://logs.test/1" } } },
    });
    const result = await submissionStatus({
      id,
      token: "t",
      origin: "https://notary.test",
      fetchImpl,
    });
    expect(result).toEqual({ status: "Invalid", outcome: "rejected", log: "https://logs.test/1" });
    expect(seen.map((entry) => entry.url)).toEqual([base, `${base}/logs`]);
  });
  it("苹果返回错误码或编号不像公证编号时失败，不当成还在等", async () => {
    const { fetchImpl } = stub({});
    await expect(
      submissionStatus({ id, token: "t", origin: "https://notary.test", fetchImpl }),
    ).rejects.toThrow("NOTARY_HTTP_404");
    await expect(
      submissionStatus({ id: "../x", token: "t", origin: "https://notary.test", fetchImpl }),
    ).rejects.toThrow("NOTARY_BAD_SUBMISSION_ID");
  });
});
