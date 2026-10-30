import type { GatewayV2Snapshot } from "@himawari-agent/gateway-contracts";
import type { ControlCenterUiLocale } from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "./gateway-client.js";
import { commandMessage, queryMessage } from "./messages.js";

export const WEB_PUSH_KINDS = ["reminder", "approval", "run"] as const;
export type WebPushKind = (typeof WEB_PUSH_KINDS)[number];
export type PushStatus = Extract<GatewayV2Snapshot, { type: "push.status.snapshot" }>["payload"];
export const PRESENCE_INTERVAL_MS = 30_000;

export interface PushBrowser {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly standalone: boolean;
  readonly notification: {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  } | null;
  readonly serviceWorker: {
    register(url: string, options: RegistrationOptions): Promise<unknown>;
    getRegistration(scope: string): Promise<{ readonly pushManager: PushManager } | undefined>;
    readonly ready: Promise<{ readonly pushManager: PushManager }>;
  } | null;
}

export function currentPushBrowser(): PushBrowser {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { readonly standalone?: boolean }).standalone === true;
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
    notification: typeof Notification === "undefined" ? null : Notification,
    serviceWorker:
      "serviceWorker" in navigator && typeof PushManager !== "undefined"
        ? navigator.serviceWorker
        : null,
  };
}

export function pushPlatform(browser: Pick<PushBrowser, "userAgent" | "maxTouchPoints">) {
  const agent = browser.userAgent;
  if (/iPhone|iPod/.test(agent)) return "iPhone";
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && browser.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh|Mac OS X/.test(agent)) return "Mac";
  if (/Windows/.test(agent)) return "Windows";
  return "Linux";
}

export type PushSupport = "supported" | "install-first" | "unsupported";

export function pushSupport(browser: PushBrowser): PushSupport {
  const platform = pushPlatform(browser);
  if ((platform === "iPhone" || platform === "iPad") && !browser.standalone) return "install-first";
  return browser.notification && browser.serviceWorker ? "supported" : "unsupported";
}

export async function webPushSubscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0"));
  return `web-push-${hex.join("").slice(0, 24)}`;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const key = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) key[index] = binary.charCodeAt(index);
  return key;
}

function subscriptionKeys(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const p256dh = json.keys?.["p256dh"];
  const auth = json.keys?.["auth"];
  if (!json.endpoint || !p256dh || !auth) throw new Error("WEB_PUSH_SUBSCRIPTION_INCOMPLETE");
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

export class PushController {
  readonly #client: Pick<GatewayClient, "query" | "mutate">;
  readonly #configuration: ControlCenterRuntimeConfiguration;
  readonly #browser: PushBrowser;

  constructor(
    client: Pick<GatewayClient, "query" | "mutate">,
    configuration: ControlCenterRuntimeConfiguration,
    browser: PushBrowser,
  ) {
    this.#client = client;
    this.#configuration = configuration;
    this.#browser = browser;
  }

  get permission(): NotificationPermission {
    return this.#browser.notification?.permission ?? "denied";
  }

  #options() {
    return this.#configuration.authorizationRef
      ? { authorizationRef: this.#configuration.authorizationRef }
      : {};
  }

  async status(): Promise<PushStatus> {
    const snapshot = await this.#client.query(
      queryMessage(this.#configuration, "push.status.read", {}),
    );
    if (snapshot.type !== "push.status.snapshot") throw new Error("WEB_PUSH_STATUS_INVALID");
    return snapshot.payload;
  }

  async currentSubscription(): Promise<PushSubscription | null> {
    if (!this.#browser.serviceWorker || this.permission !== "granted") return null;
    const registration = await this.#browser.serviceWorker.getRegistration("/");
    return registration ? registration.pushManager.getSubscription() : null;
  }

  async currentSubscriptionId(): Promise<string | null> {
    const subscription = await this.currentSubscription();
    return subscription ? webPushSubscriptionId(subscription.endpoint) : null;
  }

  async enable(input: {
    readonly publicKey: string;
    readonly locale: ControlCenterUiLocale;
    readonly deviceLabel: string;
    readonly kinds: readonly WebPushKind[];
    readonly sendTest: boolean;
  }): Promise<"enabled" | "denied"> {
    const { notification, serviceWorker } = this.#browser;
    if (!notification || !serviceWorker) throw new Error("WEB_PUSH_UNSUPPORTED");
    const permission =
      notification.permission === "granted" ? "granted" : await notification.requestPermission();
    if (permission !== "granted") return "denied";
    await serviceWorker.register("/sw.js", { scope: "/" });
    const { pushManager } = await serviceWorker.ready;
    const subscription =
      (await pushManager.getSubscription()) ??
      (await pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(input.publicKey),
      }));
    const result = await this.#client.mutate(
      commandMessage(
        this.#configuration,
        "push.subscription.set",
        {
          action: "subscribe",
          subscriptionId: null,
          ...subscriptionKeys(subscription),
          locale: input.locale,
          deviceLabel: input.deviceLabel,
          kinds: [...input.kinds],
        },
        this.#options(),
      ),
    );
    if (input.sendTest)
      await this.#client.mutate(
        commandMessage(
          this.#configuration,
          "push.test",
          { subscriptionId: result.resultRef },
          this.#options(),
        ),
      );
    return "enabled";
  }

  async remove(subscriptionId: string): Promise<void> {
    const current = await this.currentSubscription();
    if (current && (await webPushSubscriptionId(current.endpoint)) === subscriptionId)
      await current.unsubscribe();
    await this.#client.mutate(
      commandMessage(
        this.#configuration,
        "push.subscription.set",
        {
          action: "unsubscribe",
          subscriptionId,
          endpoint: null,
          keys: null,
          locale: null,
          deviceLabel: null,
          kinds: null,
        },
        this.#options(),
      ),
    );
  }

  async test(subscriptionId: string): Promise<void> {
    await this.#client.mutate(
      commandMessage(this.#configuration, "push.test", { subscriptionId }, this.#options()),
    );
  }
}

export function startPresenceHeartbeat(input: {
  readonly client: Pick<GatewayClient, "mutate">;
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly setInterval: (handler: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}): () => void {
  const clientId = `tab-${crypto.randomUUID()}`;
  const beat = () =>
    void input.client
      .mutate(
        commandMessage(
          input.configuration,
          "presence.heartbeat",
          { clientId, visible: input.document.visibilityState === "visible" },
          input.configuration.authorizationRef
            ? { authorizationRef: input.configuration.authorizationRef }
            : {},
        ),
      )
      .catch(() => undefined);
  const onVisibility = () => beat();
  input.document.addEventListener("visibilitychange", onVisibility);
  const handle = input.setInterval(() => {
    if (input.document.visibilityState === "visible") beat();
  }, PRESENCE_INTERVAL_MS);
  if (input.document.visibilityState === "visible") beat();
  return () => {
    input.clearInterval(handle);
    input.document.removeEventListener("visibilitychange", onVisibility);
  };
}

export const PUSH_FEEDBACK_CACHE = "himawari-push-feedback";
const PUSH_TAG = /^[A-Za-z0-9_-]{1,64}$/;

interface PushFeedbackEvent {
  readonly tag: string;
  readonly reaction: "opened" | "dismissed";
  readonly occurredAt: string;
}

function feedbackEvent(value: unknown): PushFeedbackEvent | null {
  if (!value || typeof value !== "object") return null;
  const { tag, reaction, occurredAt } = value as Record<string, unknown>;
  if (typeof tag !== "string" || !PUSH_TAG.test(tag)) return null;
  if (reaction !== "opened" && reaction !== "dismissed") return null;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) return null;
  return { tag, reaction, occurredAt: new Date(occurredAt).toISOString() };
}

export async function reportPushFeedback(input: {
  readonly client: Pick<GatewayClient, "mutate">;
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly location: Pick<Location, "href">;
  readonly history: Pick<History, "replaceState" | "state">;
  readonly caches: Pick<CacheStorage, "open"> | undefined;
  readonly now: () => Date;
}): Promise<void> {
  const url = new URL(input.location.href);
  const opened = url.searchParams.get("push");
  const events: PushFeedbackEvent[] = [];
  if (opened !== null) {
    url.searchParams.delete("push");
    input.history.replaceState(input.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (PUSH_TAG.test(opened))
      events.push({ tag: opened, reaction: "opened", occurredAt: input.now().toISOString() });
  }
  const cache = await input.caches?.open(PUSH_FEEDBACK_CACHE).catch(() => undefined);
  const stored = cache ? await cache.keys().catch(() => [] as readonly Request[]) : [];
  for (const request of stored.slice(0, 50 - events.length)) {
    const event = feedbackEvent(await (await cache?.match(request))?.json().catch(() => null));
    if (event) events.push(event);
    else await cache?.delete(request);
  }
  if (events.length === 0) return;
  await input.client.mutate(
    commandMessage(
      input.configuration,
      "push.feedback.record",
      { events },
      input.configuration.authorizationRef
        ? { authorizationRef: input.configuration.authorizationRef }
        : {},
    ),
  );
  await Promise.all(stored.slice(0, 50).map((request) => cache?.delete(request)));
}
