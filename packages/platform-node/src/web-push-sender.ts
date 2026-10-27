import { createECDH } from "node:crypto";
import type {
  WebPushSenderPort,
  WebPushSendRequest,
  WebPushSendResult,
} from "@himawari-agent/application";
import webPush from "web-push";

const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function webPushPublicKey(privateKey: Uint8Array): string {
  if (privateKey.byteLength !== 32) throw new Error("WEB_PUSH_PRIVATE_KEY_INVALID");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey));
  return ecdh.getPublicKey().toString("base64url");
}

function retryAfterSeconds(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1_000)) : null;
}

export function classifyWebPushResponse(
  status: number,
  retryAfter: string | null,
  now = Date.now(),
): WebPushSendResult {
  const code = `WEB_PUSH_HTTP_${status}`;
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 404 || status === 410) return { kind: "gone", code };
  if (status === 413) return { kind: "too_large", code };
  if (status === 429)
    return { kind: "rate_limited", code, retryAfterSeconds: retryAfterSeconds(retryAfter, now) };
  if (status === 400 || status === 401 || status === 403) return { kind: "rejected", code };
  return { kind: "retry", code };
}

export function createWebPushSender(options: {
  readonly privateKey: Uint8Array;
  readonly subject: string;
  readonly fetch?: Fetch;
}): WebPushSenderPort {
  const publicKey = webPushPublicKey(options.privateKey);
  const privateKey = Buffer.from(options.privateKey).toString("base64url");
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  return Object.freeze({
    publicKey,
    async send(request: WebPushSendRequest): Promise<WebPushSendResult> {
      const details = webPush.generateRequestDetails(
        { endpoint: request.endpoint, keys: { p256dh: request.p256dh, auth: request.auth } },
        request.payload,
        {
          vapidDetails: { subject: options.subject, publicKey, privateKey },
          TTL: request.ttlSeconds,
          urgency: request.urgency,
          topic: request.topic,
          contentEncoding: "aes128gcm",
        },
      );
      const headers = Object.fromEntries(
        Object.entries(details.headers)
          .filter(([name]) => name.toLowerCase() !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      );
      const response = await send(details.endpoint, {
        method: details.method,
        headers,
        body: details.body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      return classifyWebPushResponse(response.status, response.headers.get("retry-after"));
    },
  });
}
