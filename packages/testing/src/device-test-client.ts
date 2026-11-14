import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

export interface DeviceTestKeyPair {
  readonly privateKey: KeyObject;
  readonly publicKeySpkiBase64: string;
}

export function generateDeviceTestKeyPair(): DeviceTestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export interface DeviceTestRequestInput {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly query?: string;
  readonly body?: Uint8Array | string;
  readonly contentType?: string;
  readonly deviceId: string;
  readonly deviceKey: KeyObject;
  readonly confirmKey?: KeyObject;
  readonly createdAtSeconds?: number;
  readonly nonce?: string;
  readonly signedAuthority?: string;
  readonly signedPath?: string;
  readonly signedQuery?: string;
  readonly signedBody?: Uint8Array | string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface DeviceTestRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | undefined;
  readonly nonce: string;
}

export function buildDeviceTestRequest(input: DeviceTestRequestInput): DeviceTestRequest {
  const url = new URL(input.path + (input.query ? `?${input.query}` : ""), input.origin);
  const body = input.body === undefined ? undefined : Buffer.from(input.body);
  const signedBody =
    input.signedBody === undefined ? body : Buffer.from(input.signedBody as Uint8Array);
  const contentType = body ? (input.contentType ?? "application/json") : undefined;
  const digest = (value: Buffer | undefined) =>
    value ? `sha-256=:${createHash("sha256").update(value).digest("base64")}:` : undefined;
  const created = input.createdAtSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  const components = ["@method", "@authority", "@path", "@query"].concat(
    signedBody ? ["content-digest", "content-type"] : [],
  );
  const params = `(${components.map((value) => `"${value}"`).join(" ")});created=${created};nonce="${nonce}";keyid="${input.deviceId}";alg="ecdsa-p256-sha256";tag="himawari-device-v1"`;
  const values: Record<string, string> = {
    "@method": input.method,
    "@authority": input.signedAuthority ?? url.host,
    "@path": input.signedPath ?? url.pathname,
    "@query": `?${(input.signedQuery ?? url.search.slice(1)) as string}`,
    "content-digest": digest(signedBody) ?? "",
    "content-type": contentType ?? "",
  };
  const base = [
    ...components.map((component) => `"${component}": ${values[component]}`),
    `"@signature-params": ${params}`,
  ].join("\n");
  const sign1 = (key: KeyObject) =>
    sign("sha256", Buffer.from(base), { key, dsaEncoding: "ieee-p1363" }).toString("base64");
  const labels: (readonly [string, KeyObject])[] = [["device", input.deviceKey]];
  if (input.confirmKey) labels.push(["confirm", input.confirmKey]);
  const headers: Record<string, string> = {
    host: url.host,
    "signature-input": labels.map(([label]) => `${label}=${params}`).join(", "),
    signature: labels.map(([label, key]) => `${label}=:${sign1(key)}:`).join(", "),
    ...(body
      ? {
          "content-type": contentType as string,
          "content-digest": digest(body) as string,
        }
      : {}),
    ...input.extraHeaders,
  };
  return { method: input.method, url: url.toString(), headers, body, nonce };
}
