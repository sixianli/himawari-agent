import { createPrivateKey, type KeyObject, randomUUID, sign } from "node:crypto";
import { type ClientHttp2Session, connect, constants } from "node:http2";
import type {
  ApplePushEnvironment,
  ApplePushSenderPort,
  ApplePushSendRequest,
  ApplePushSendResult,
} from "@himawari-agent/application";

export const APPLE_PUSH_ORIGINS: Readonly<Record<ApplePushEnvironment, string>> = Object.freeze({
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
});

export const APPLE_PUSH_PAYLOAD_MAXIMUM_BYTES = 4_096;
export const APPLE_PUSH_PROVIDER_TOKEN_REFRESH_SECONDS = 50 * 60;
const PROVIDER_TOKEN_MINIMUM_AGE_SECONDS = 20 * 60;

const TOKEN_GONE_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
  "Unregistered",
]);

export function applePushTopic(
  bundleId: string,
  pushType: ApplePushSendRequest["pushType"],
): string {
  if (pushType === "widgets") return `${bundleId}.push-type.widgets`;
  if (pushType === "liveactivity") return `${bundleId}.push-type.liveactivity`;
  return bundleId;
}

export function classifyApplePushResponse(status: number, reason: string): ApplePushSendResult {
  const code = `APNS_${status}${reason ? `_${reason}` : ""}`.slice(0, 64);
  if (status === 200) return { kind: "sent" };
  if (status === 410 || TOKEN_GONE_REASONS.has(reason)) return { kind: "gone", code };
  if (status === 413) return { kind: "too_large", code };
  if (status === 429) return { kind: "rate_limited", code };
  if (status === 403 && reason === "ExpiredProviderToken") return { kind: "retry", code };
  if (status >= 400 && status < 500) return { kind: "rejected", code };
  return { kind: "retry", code };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createApplePushProviderToken(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly key: KeyObject;
  readonly issuedAtSeconds: number;
}): string {
  const head = `${base64url(JSON.stringify({ alg: "ES256", kid: input.keyId }))}.${base64url(
    JSON.stringify({ iss: input.teamId, iat: input.issuedAtSeconds }),
  )}`;
  const signature = sign("sha256", Buffer.from(head), {
    key: input.key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${base64url(signature)}`;
}

export function createApplePushSender(options: {
  readonly teamId: string;
  readonly keyId: string;
  readonly signingKey: Uint8Array;
  readonly requestTimeoutSeconds: number;
  readonly origins?: Readonly<Record<ApplePushEnvironment, string>>;
  readonly now?: () => number;
}): ApplePushSenderPort & { close(): void } {
  const key = createPrivateKey({ key: Buffer.from(options.signingKey), format: "pem" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("APPLE_PUSH_SIGNING_KEY_INVALID");
  const origins = options.origins ?? APPLE_PUSH_ORIGINS;
  const now = options.now ?? Date.now;
  const sessions = new Map<ApplePushEnvironment, ClientHttp2Session>();
  let provider: { readonly token: string; readonly issuedAtSeconds: number } | undefined;
  let providerRejectedAtSeconds: number | undefined;

  const providerToken = (): string => {
    const seconds = Math.floor(now() / 1_000);
    const age = provider ? seconds - provider.issuedAtSeconds : Number.POSITIVE_INFINITY;
    const rejected =
      provider !== undefined &&
      providerRejectedAtSeconds !== undefined &&
      providerRejectedAtSeconds >= provider.issuedAtSeconds &&
      age >= PROVIDER_TOKEN_MINIMUM_AGE_SECONDS;
    if (!provider || age >= APPLE_PUSH_PROVIDER_TOKEN_REFRESH_SECONDS || age < 0 || rejected)
      provider = {
        token: createApplePushProviderToken({
          teamId: options.teamId,
          keyId: options.keyId,
          key,
          issuedAtSeconds: seconds,
        }),
        issuedAtSeconds: seconds,
      };
    return provider.token;
  };

  const session = (environment: ApplePushEnvironment): ClientHttp2Session => {
    const open = sessions.get(environment);
    if (open && !open.closed && !open.destroyed) return open;
    const created = connect(origins[environment]);
    const forget = () => {
      if (sessions.get(environment) === created) sessions.delete(environment);
    };
    created.on("error", forget);
    created.on("close", forget);
    created.on("goaway", () => {
      forget();
      created.close();
    });
    created.unref();
    sessions.set(environment, created);
    return created;
  };

  return Object.freeze({
    close(): void {
      for (const open of sessions.values()) open.close();
      sessions.clear();
    },
    send(request: ApplePushSendRequest): Promise<ApplePushSendResult> {
      if (Buffer.byteLength(request.payload, "utf8") > APPLE_PUSH_PAYLOAD_MAXIMUM_BYTES)
        return Promise.resolve({ kind: "too_large", code: "APNS_PAYLOAD_TOO_LARGE" });
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: ApplePushSendResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        let stream: ReturnType<ClientHttp2Session["request"]>;
        try {
          stream = session(request.environment).request({
            [constants.HTTP2_HEADER_METHOD]: "POST",
            [constants.HTTP2_HEADER_PATH]: `/3/device/${request.token}`,
            authorization: `bearer ${providerToken()}`,
            "apns-id": randomUUID(),
            "apns-push-type": request.pushType,
            "apns-topic": applePushTopic(request.topic, request.pushType),
            "apns-priority": String(request.priority),
            "apns-expiration": String(request.expiresAtSeconds),
            ...(request.collapseId === null ? {} : { "apns-collapse-id": request.collapseId }),
            "content-type": "application/json",
          });
        } catch {
          settle({ kind: "retry", code: "APNS_CONNECTION" });
          return;
        }
        let status = 0;
        const chunks: Buffer[] = [];
        stream.setTimeout(options.requestTimeoutSeconds * 1_000, () => {
          stream.close(constants.NGHTTP2_CANCEL);
          settle({ kind: "retry", code: "APNS_TIMEOUT" });
        });
        stream.on("response", (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        stream.on("data", (chunk: Buffer) => {
          if (chunks.reduce((total, part) => total + part.length, 0) < 4_096) chunks.push(chunk);
        });
        stream.on("error", () => settle({ kind: "retry", code: "APNS_CONNECTION" }));
        stream.on("close", () => {
          if (status === 0) return settle({ kind: "retry", code: "APNS_CONNECTION" });
          let reason = "";
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: unknown;
            };
            if (typeof body.reason === "string" && /^[A-Za-z]{1,48}$/u.test(body.reason))
              reason = body.reason;
          } catch {}
          if (status === 403 && reason === "ExpiredProviderToken")
            providerRejectedAtSeconds = Math.floor(now() / 1_000);
          settle(classifyApplePushResponse(status, reason));
        });
        stream.end(request.payload);
      });
    },
  });
}
