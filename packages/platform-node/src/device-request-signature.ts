import { createHash, createPublicKey, type KeyObject, timingSafeEqual, verify } from "node:crypto";

export const DEVICE_SIGNATURE_TAG = "himawari-device-v1" as const;
export const DEVICE_SIGNATURE_ALGORITHM = "ecdsa-p256-sha256" as const;
export const DEVICE_SIGNATURE_LABELS = Object.freeze({ device: "device", confirm: "confirm" });

export const DEVICE_SIGNATURE_ERROR_CODES = Object.freeze({
  SIGNATURE_MISSING: "DEVICE_SIGNATURE_MISSING",
  SIGNATURE_MALFORMED: "DEVICE_SIGNATURE_MALFORMED",
  COMPONENTS_INVALID: "DEVICE_SIGNATURE_COMPONENTS_INVALID",
  PARAMETERS_INVALID: "DEVICE_SIGNATURE_PARAMETERS_INVALID",
  CLOCK_SKEW: "DEVICE_SIGNATURE_CLOCK_SKEW",
  DIGEST_MISMATCH: "DEVICE_SIGNATURE_DIGEST_MISMATCH",
  HOST_MISMATCH: "DEVICE_SIGNATURE_HOST_MISMATCH",
  KEY_UNKNOWN: "DEVICE_SIGNATURE_KEY_UNKNOWN",
  SIGNATURE_INVALID: "DEVICE_SIGNATURE_INVALID",
  CONFIRM_REQUIRED: "DEVICE_SIGNATURE_CONFIRM_REQUIRED",
} as const);

export type DeviceSignatureErrorCode =
  (typeof DEVICE_SIGNATURE_ERROR_CODES)[keyof typeof DEVICE_SIGNATURE_ERROR_CODES];

export class DeviceSignatureError extends Error {
  readonly code: DeviceSignatureErrorCode;
  readonly serverTime: string | undefined;

  constructor(code: DeviceSignatureErrorCode, serverTime?: string) {
    super(code);
    this.name = "DeviceSignatureError";
    this.code = code;
    this.serverTime = serverTime;
  }
}

export interface DeviceSignedRequest {
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  readonly rawQuery: string;
  readonly signatureInput: string | undefined;
  readonly signature: string | undefined;
  readonly contentDigest: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Uint8Array;
}

export interface DeviceKeyLookup {
  readonly device: KeyObject | undefined;
  readonly confirm: KeyObject | undefined;
}

export interface VerifiedDeviceRequest {
  readonly deviceId: string;
  readonly createdAtSeconds: number;
  readonly nonce: string;
  readonly confirmed: boolean;
}

export interface VerifyDeviceRequestInput {
  readonly request: DeviceSignedRequest;
  readonly expectedAuthority: string;
  readonly toleranceSeconds: number;
  readonly now: Date;
  readonly lookupKeys: (deviceId: string) => Promise<DeviceKeyLookup | undefined>;
  readonly requireConfirm?: boolean;
}

const BASE_COMPONENTS = ["@method", "@authority", "@path", "@query"] as const;
const BODY_COMPONENTS = ["content-digest", "content-type"] as const;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export function contentDigestHeader(body: Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

interface ParsedMember {
  readonly label: string;
  readonly components: readonly string[];
  readonly created: number;
  readonly nonce: string;
  readonly keyid: string;
  readonly paramsText: string;
}

function splitMembers(header: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")") depth -= 1;
    else if (!quoted && depth === 0 && char === ",") {
      members.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  members.push(header.slice(start).trim());
  return members;
}

function parseInputMember(member: string): ParsedMember {
  const match =
    /^([a-z][a-z0-9_-]*)=\(((?:"[a-z@-]+"(?: "[a-z@-]+")*)?)\)((?:;[a-z]+=(?:"[^"\\]*"|[0-9]+))*)$/u.exec(
      member,
    );
  if (!match) throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MALFORMED);
  const label = match[1] as string;
  const components = (match[2] as string)
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part.slice(1, -1));
  const paramsText = match[3] as string;
  const params = new Map<string, string>();
  for (const part of paramsText.split(";").filter((value) => value.length > 0)) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator);
    if (params.has(name))
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.PARAMETERS_INVALID);
    params.set(name, part.slice(separator + 1));
  }
  const names = [...params.keys()].sort().join(",");
  if (names !== "alg,created,keyid,nonce,tag")
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.PARAMETERS_INVALID);
  const unquote = (value: string) =>
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : undefined;
  const alg = unquote(params.get("alg") as string);
  const tag = unquote(params.get("tag") as string);
  const nonce = unquote(params.get("nonce") as string);
  const keyid = unquote(params.get("keyid") as string);
  const createdText = params.get("created") as string;
  if (
    alg !== DEVICE_SIGNATURE_ALGORITHM ||
    tag !== DEVICE_SIGNATURE_TAG ||
    nonce === undefined ||
    !NONCE_PATTERN.test(nonce) ||
    keyid === undefined ||
    !DEVICE_ID_PATTERN.test(keyid) ||
    !/^[0-9]{1,12}$/u.test(createdText)
  )
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.PARAMETERS_INVALID);
  return { label, components, created: Number(createdText), nonce, keyid, paramsText };
}

function parseSignatureMember(member: string): { label: string; value: Buffer } {
  const match = /^([a-z][a-z0-9_-]*)=:([A-Za-z0-9+/]+={0,2}):$/u.exec(member);
  if (!match) throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MALFORMED);
  return { label: match[1] as string, value: Buffer.from(match[2] as string, "base64") };
}

function requiredComponents(hasBody: boolean): readonly string[] {
  return hasBody ? [...BASE_COMPONENTS, ...BODY_COMPONENTS] : [...BASE_COMPONENTS];
}

export function signatureBase(input: {
  readonly components: readonly string[];
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  readonly rawQuery: string;
  readonly contentDigest: string | undefined;
  readonly contentType: string | undefined;
  readonly signatureParams: string;
}): string {
  const lines: string[] = [];
  for (const component of input.components) {
    switch (component) {
      case "@method":
        lines.push(`"@method": ${input.method}`);
        break;
      case "@authority":
        lines.push(`"@authority": ${input.authority}`);
        break;
      case "@path":
        lines.push(`"@path": ${input.path}`);
        break;
      case "@query":
        lines.push(`"@query": ?${input.rawQuery}`);
        break;
      case "content-digest":
        lines.push(`"content-digest": ${input.contentDigest ?? ""}`);
        break;
      case "content-type":
        lines.push(`"content-type": ${input.contentType ?? ""}`);
        break;
      default:
        throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.COMPONENTS_INVALID);
    }
  }
  lines.push(`"@signature-params": ${input.signatureParams}`);
  return lines.join("\n");
}

function sameBytes(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicKeyFromSpkiBase64(value: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1")
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.KEY_UNKNOWN);
  return key;
}

export async function verifyDeviceRequest(
  input: VerifyDeviceRequestInput,
): Promise<VerifiedDeviceRequest> {
  const { request } = input;
  if (request.signatureInput === undefined || request.signature === undefined)
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MISSING);
  if (request.authority !== input.expectedAuthority)
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.HOST_MISMATCH);

  const members = splitMembers(request.signatureInput).map(parseInputMember);
  const signatures = new Map(
    splitMembers(request.signature)
      .map(parseSignatureMember)
      .map((entry) => [entry.label, entry.value] as const),
  );
  const labels = new Set(members.map((member) => member.label));
  if (labels.size !== members.length)
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MALFORMED);
  const deviceMember = members.find((member) => member.label === DEVICE_SIGNATURE_LABELS.device);
  const confirmMember = members.find((member) => member.label === DEVICE_SIGNATURE_LABELS.confirm);
  if (
    !deviceMember ||
    members.some(
      (member) => !(Object.values(DEVICE_SIGNATURE_LABELS) as string[]).includes(member.label),
    )
  )
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_MISSING);
  if (input.requireConfirm && !confirmMember)
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.CONFIRM_REQUIRED);

  const hasBody = request.body.length > 0;
  const expected = requiredComponents(hasBody);
  for (const member of members) {
    if (
      member.components.length !== expected.length ||
      member.components.some((component, index) => component !== expected[index])
    )
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.COMPONENTS_INVALID);
    if (member.keyid !== deviceMember.keyid || member.created !== deviceMember.created)
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.PARAMETERS_INVALID);
  }

  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - deviceMember.created) > input.toleranceSeconds)
    throw new DeviceSignatureError(
      DEVICE_SIGNATURE_ERROR_CODES.CLOCK_SKEW,
      input.now.toISOString(),
    );

  if (hasBody) {
    if (
      request.contentDigest === undefined ||
      request.contentType === undefined ||
      !sameBytes(request.contentDigest, contentDigestHeader(request.body))
    )
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.DIGEST_MISMATCH);
  }

  const keys = await input.lookupKeys(deviceMember.keyid);
  if (!keys?.device) throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.KEY_UNKNOWN);

  const check = (member: ParsedMember, key: KeyObject): boolean => {
    const signature = signatures.get(member.label);
    if (signature?.length !== 64) return false;
    const base = signatureBase({
      components: member.components,
      method: request.method,
      authority: request.authority,
      path: request.path,
      rawQuery: request.rawQuery,
      contentDigest: request.contentDigest,
      contentType: request.contentType,
      signatureParams: `(${member.components.map((component) => `"${component}"`).join(" ")})${member.paramsText}`,
    });
    return verify("sha256", Buffer.from(base), { key, dsaEncoding: "ieee-p1363" }, signature);
  };

  if (!check(deviceMember, keys.device))
    throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID);
  let confirmed = false;
  if (confirmMember) {
    if (!keys.confirm || !check(confirmMember, keys.confirm))
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.SIGNATURE_INVALID);
    if (confirmMember.nonce !== deviceMember.nonce)
      throw new DeviceSignatureError(DEVICE_SIGNATURE_ERROR_CODES.PARAMETERS_INVALID);
    confirmed = true;
  }
  return {
    deviceId: deviceMember.keyid,
    createdAtSeconds: deviceMember.created,
    nonce: deviceMember.nonce,
    confirmed,
  };
}
