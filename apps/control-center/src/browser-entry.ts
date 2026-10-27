import { createBrowserSession } from "./gateway-client.js";

export type BrowserEntry =
  | { readonly kind: "reload" }
  | { readonly kind: "built-in-login" }
  | { readonly kind: "access-expired" }
  | { readonly kind: "unreachable"; readonly automatic: boolean };

type Gate = "access-blocked" | "unreachable" | "built-in" | "cloudflare-access";

const statusOf = (error: unknown): number | undefined =>
  error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;

const transient = (status: number | undefined) =>
  status === undefined || status === 429 || status >= 500;

async function readGate(fetchImplementation: typeof globalThis.fetch): Promise<Gate> {
  try {
    const response = await fetchImplementation("/api/identity/v1/method", {
      credentials: "same-origin",
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403)
      return "access-blocked";
    if (!response.ok) return "unreachable";
    const body: unknown = await response.json().catch(() => null);
    const method = body && typeof body === "object" && "method" in body ? body.method : undefined;
    return method === "built-in" || method === "cloudflare-access" ? method : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function recoverBrowserEntry({
  fetch: fetchImplementation,
  deviceLabel,
  failure,
  exchanged,
}: {
  readonly fetch: typeof globalThis.fetch;
  readonly deviceLabel: string;
  readonly failure: unknown;
  readonly exchanged: boolean;
}): Promise<BrowserEntry> {
  const gate = await readGate(fetchImplementation);
  if (gate === "access-blocked") return { kind: "access-expired" };
  if (gate === "unreachable") return { kind: "unreachable", automatic: true };
  const status = statusOf(failure);
  if (status !== 401 && status !== 403)
    return { kind: "unreachable", automatic: transient(status) };
  if (gate === "built-in") return { kind: "built-in-login" };
  if (exchanged) return { kind: "unreachable", automatic: false };
  try {
    await createBrowserSession(fetchImplementation, deviceLabel);
    return { kind: "reload" };
  } catch (error) {
    return { kind: "unreachable", automatic: transient(statusOf(error)) };
  }
}
