#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const notaryOrigin = "https://appstoreconnect.apple.com";
const tokenLifetimeSeconds = 15 * 60;

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function notaryToken({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + tokenLifetimeSeconds,
    aud: "appstoreconnect-v1",
  };
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

export function outcomeOf(status) {
  if (status === "Accepted") return "accepted";
  if (status === "In Progress") return "waiting";
  if (status === "Invalid" || status === "Rejected") return "rejected";
  throw new Error(`NOTARY_UNKNOWN_STATUS ${status}`);
}

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`NOTARY_HTTP_${response.status} ${url}`);
  return response.json();
}

export async function submissionStatus({ id, token, origin = notaryOrigin, fetchImpl = fetch }) {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error(`NOTARY_BAD_SUBMISSION_ID ${id}`);
  const base = `${origin}/notary/v2/submissions/${id}`;
  const body = await getJson(base, token, fetchImpl);
  const status = body?.data?.attributes?.status;
  const outcome = outcomeOf(status);
  if (outcome !== "rejected") return { status, outcome };
  const logs = await getJson(`${base}/logs`, token, fetchImpl);
  return { status, outcome, log: logs?.data?.attributes?.developerLogUrl ?? null };
}

async function main() {
  const required = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "SUBMISSION_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`NOTARY_MISSING ${missing.join(" ")}`);
    process.exit(2);
  }
  const token = notaryToken({
    keyId: process.env.ASC_KEY_ID,
    issuerId: process.env.ASC_ISSUER_ID,
    privateKey: process.env.ASC_KEY_P8,
  });
  const result = await submissionStatus({ id: process.env.SUBMISSION_ID, token });
  console.log(`NOTARY_STATUS ${process.env.SUBMISSION_ID} ${result.status}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${result.outcome}\n`);
  }
  if (result.outcome === "rejected") {
    console.error(`NOTARY_REJECTED log: ${result.log ?? "none"}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
