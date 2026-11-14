import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

const output = process.argv[2];
if (!output) {
  process.stderr.write("usage: node make-signature-fixture.mjs <output.json>\n");
  process.exit(2);
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    privateKey,
    scalar: Buffer.from(jwk.d, "base64url").toString("base64"),
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function digest(body) {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

function signedCase(device, input) {
  const url = new URL(input.path + (input.query ? `?${input.query}` : ""), input.origin);
  const body = input.body === undefined ? undefined : Buffer.from(input.body);
  const contentType = body ? "application/json" : undefined;
  const components = ["@method", "@authority", "@path", "@query"].concat(
    body ? ["content-digest", "content-type"] : [],
  );
  const params = `(${components.map((value) => `"${value}"`).join(" ")});created=${input.created};nonce="${input.nonce}";keyid="${input.deviceId}";alg="ecdsa-p256-sha256";tag="himawari-device-v1"`;
  const values = {
    "@method": input.method,
    "@authority": url.host,
    "@path": url.pathname,
    "@query": `?${url.search.slice(1)}`,
    "content-digest": body ? digest(body) : "",
    "content-type": contentType ?? "",
  };
  const base = [
    ...components.map((component) => `"${component}": ${values[component]}`),
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = sign("sha256", Buffer.from(base), {
    key: createPrivateKey(device.privateKey.export({ format: "pem", type: "pkcs8" })),
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
  return {
    method: input.method,
    authority: url.host,
    path: url.pathname,
    rawQuery: url.search.slice(1),
    body: input.body ?? null,
    contentType: contentType ?? null,
    deviceId: input.deviceId,
    created: input.created,
    nonce: input.nonce,
    signatureBase: base,
    signatureInput: `device=${params}`,
    signature,
    contentDigest: body ? digest(body) : null,
  };
}

const device = keyPair();
const confirm = keyPair();
const deviceId = "dev_AAAAAAAAAAAAAAAAAAAAAA";
const pairingDigest = createHash("sha256")
  .update(
    Buffer.concat([
      Buffer.from("himawari-pairing-v1", "utf8"),
      Buffer.from(device.spki, "base64"),
      Buffer.from(confirm.spki, "base64"),
    ]),
  )
  .digest();
const pairingNumber = String(pairingDigest.readUInt32BE(0) % 1_000_000).padStart(6, "0");

const fixture = {
  device: { scalar: device.scalar, spki: device.spki },
  confirm: { scalar: confirm.scalar, spki: confirm.spki },
  pairingNumber,
  cases: [
    signedCase(device, {
      method: "GET",
      origin: "https://himawari.example.test",
      path: "/api/device/v1/threads",
      query: "after=cursor_1",
      deviceId,
      created: 1_800_000_000,
      nonce: "bm9uY2Utbm9uY2Utbm9uY2U",
    }),
    signedCase(device, {
      method: "POST",
      origin: "https://himawari.example.test:8443",
      path: "/api/device/v1/messages",
      body: JSON.stringify({
        messageId: "msg_0123456789abcdef",
        threadId: "thread_1",
        expectedRevision: 3,
        text: "周五去大阪",
      }),
      deviceId,
      created: 1_800_000_060,
      nonce: "c2Vjb25kLW5vbmNlLXZhbHVl",
    }),
  ],
};
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
