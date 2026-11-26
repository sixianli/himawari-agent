import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ClockPort } from "@himawari-agent/application";
import { AdmissionWindows } from "./bearer-admission.js";
import {
  type AuthorizeErrorReason,
  MCP_AUTH_PREFIX,
  type ProductionMcpAuthorization,
} from "./production-mcp-authorization.js";

export const MCP_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const MCP_AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const MCP_AUTH_FORM_BODY_LIMIT = 8_192;
export const MCP_AUTH_JSON_BODY_LIMIT = 16_384;
export const MCP_AUTH_REQUESTS_PER_MINUTE = 60;
export const MCP_AUTH_POLLS_PER_MINUTE = 120;

type Locale = "zh-CN" | "en" | "ja";

const PAGE_TEXT = {
  "zh-CN": {
    title: "接入 Himawari",
    waiting: "请在 iPhone 上批准",
    asks: (name: string, host: string) => `「${name}」（${host}）想接入你的 Himawari。`,
    how: "打开 iPhone 上 Himawari 的通知，用面容 ID 批准或拒绝。批准后这个页面会自动回到那个应用。",
    errorTitle: "没能接入",
    client_unknown: "这个应用没有正确登记，无法接入。请回到那个应用重新连接。",
    client_unavailable: "暂时读不到这个应用的说明文件，请稍后在那个应用里重试。",
    redirect_invalid: "这个应用给的回跳地址和它登记的不一致，为了安全已拒绝。",
    busy: "等你批准的请求太多了，请先在 iPhone 上处理完再试。",
  },
  en: {
    title: "Connect to Himawari",
    waiting: "Approve on your iPhone",
    asks: (name: string, host: string) => `“${name}” (${host}) wants to connect to your Himawari.`,
    how: "Open the Himawari notification on your iPhone and approve or decline with Face ID. This page returns to the app once you approve.",
    errorTitle: "Couldn’t connect",
    client_unknown: "This app isn’t registered correctly. Go back to the app and connect again.",
    client_unavailable:
      "The app’s description couldn’t be read right now. Try again from the app later.",
    redirect_invalid:
      "The app asked to return to an address it didn’t register, so this was refused.",
    busy: "Too many requests are waiting for you. Handle them on your iPhone, then try again.",
  },
  ja: {
    title: "Himawari に接続",
    waiting: "iPhone で承認してください",
    asks: (name: string, host: string) =>
      `「${name}」（${host}）が Himawari への接続を求めています。`,
    how: "iPhone の Himawari の通知を開き、Face ID で承認または拒否してください。承認するとこのページはアプリに戻ります。",
    errorTitle: "接続できませんでした",
    client_unknown: "このアプリは正しく登録されていません。アプリに戻って接続し直してください。",
    client_unavailable: "アプリの説明ファイルを今は読めません。後でアプリから再試行してください。",
    redirect_invalid: "登録されていない戻り先が指定されたため、拒否しました。",
    busy: "承認待ちのリクエストが多すぎます。iPhone で処理してから再試行してください。",
  },
} as const satisfies Record<Locale, unknown>;

const PAGE_SCRIPT = `(() => {
  const grant = document.body.dataset.grant;
  if (!grant) return;
  const poll = async () => {
    try {
      const response = await fetch("${MCP_AUTH_PREFIX}/authorize/status?grant=" + encodeURIComponent(grant), { cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        if (body.state !== "pending" && typeof body.location === "string") {
          window.location.replace(body.location);
          return;
        }
      }
    } catch {}
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
})();
`;

const PAGE_STYLE = `:root{color-scheme:light dark;--text:#1d1d1f;--muted:#6e6e73;--back:#f5f5f7;--card:#fff;--accent:#c98a00}
@media (prefers-color-scheme:dark){:root{--text:#f5f5f7;--muted:#a1a1a6;--back:#000;--card:#1c1c1e;--accent:#f2b705}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--back);color:var(--text);font:17px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans",system-ui,sans-serif}
main{box-sizing:border-box;width:min(100% - 32px,440px);padding:28px 24px;border-radius:16px;background:var(--card)}
h1{margin:0 0 12px;font-size:22px;font-weight:600}
p{margin:0 0 10px}
.muted{color:var(--muted);font-size:15px}
.mark{display:block;width:12px;height:12px;margin-bottom:16px;border-radius:50%;background:var(--accent)}
`;

function locale(request: FastifyRequest): Locale {
  const header = request.headers["accept-language"];
  const wanted = (typeof header === "string" ? header : "")
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim().toLowerCase() ?? "");
  for (const tag of wanted) {
    if (tag.startsWith("zh")) return "zh-CN";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "zh-CN";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(
  language: Locale,
  heading: string,
  lines: readonly { readonly text: string; readonly muted?: boolean }[],
  grantId?: string,
): string {
  const text = PAGE_TEXT[language];
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(text.title)}</title><link rel="stylesheet" href="${MCP_AUTH_PREFIX}/authorize.css"></head><body${grantId ? ` data-grant="${escapeHtml(grantId)}"` : ""}><main><span class="mark"></span><h1>${escapeHtml(heading)}</h1>${lines
    .map((line) => `<p${line.muted ? ' class="muted"' : ""}>${escapeHtml(line.text)}</p>`)
    .join(
      "",
    )}</main>${grantId ? `<script src="${MCP_AUTH_PREFIX}/authorize.js" defer></script>` : ""}</body></html>`;
}

function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .type("text/html; charset=utf-8")
    .send(html);
}

function sendOAuth(
  reply: FastifyReply,
  result: { readonly status: number; readonly body: Record<string, unknown> },
): FastifyReply {
  return reply
    .code(result.status)
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("access-control-allow-origin", "*")
    .type("application/json; charset=utf-8")
    .send(result.body);
}

function sendDocument(reply: FastifyReply, body: Record<string, unknown>): FastifyReply {
  return reply
    .code(200)
    .header("cache-control", "max-age=300")
    .header("access-control-allow-origin", "*")
    .type("application/json; charset=utf-8")
    .send(body);
}

function formOf(body: unknown): Record<string, string> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, string>;
}

function parseForm(text: string): Record<string, string> | null {
  const parameters = new URLSearchParams(text);
  const form: Record<string, string> = {};
  for (const key of new Set(parameters.keys())) {
    if (parameters.getAll(key).length !== 1) return null;
    form[key] = parameters.get(key) ?? "";
  }
  return form;
}

export interface McpAuthorizationRouteOptions {
  readonly clock: ClockPort;
  readonly onFailure: (error: unknown) => void;
}

export function registerMcpAuthorizationRoutes(
  app: FastifyInstance,
  authorization: ProductionMcpAuthorization,
  options: McpAuthorizationRouteOptions,
): void {
  const requests = new AdmissionWindows(options.clock, MCP_AUTH_REQUESTS_PER_MINUTE);
  const polls = new AdmissionWindows(options.clock, MCP_AUTH_POLLS_PER_MINUTE);
  const resourcePath = new URL(authorization.resource).pathname;
  app.get(MCP_PROTECTED_RESOURCE_PATH, { logLevel: "silent" }, async (_request, reply) =>
    sendDocument(reply, authorization.protectedResourceMetadata()),
  );
  app.get(
    `${MCP_PROTECTED_RESOURCE_PATH}${resourcePath}`,
    { logLevel: "silent" },
    async (_request, reply) => sendDocument(reply, authorization.protectedResourceMetadata()),
  );
  app.get(MCP_AUTHORIZATION_SERVER_PATH, { logLevel: "silent" }, async (_request, reply) =>
    sendDocument(reply, authorization.authorizationServerMetadata()),
  );
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: MCP_AUTH_FORM_BODY_LIMIT },
      (_request, body, done) => {
        const form = parseForm(body as string);
        if (form === null) {
          const error = new Error("MCP_AUTH_FORM_REPEATED") as Error & { statusCode: number };
          error.statusCode = 400;
          done(error, undefined);
          return;
        }
        done(null, form);
      },
    );
    scope.setErrorHandler((error, _request, reply) => {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error.statusCode as number)
          : 500;
      if (status >= 500) options.onFailure(error);
      return sendOAuth(
        reply,
        status === 400 || status === 413 || status === 415
          ? { status: 400, body: { error: "invalid_request" } }
          : { status: 500, body: { error: "server_error" } },
      );
    });
    scope.addHook("onRequest", async (request, reply) => {
      const windows = request.url.startsWith(`${MCP_AUTH_PREFIX}/authorize/status`)
        ? polls
        : requests;
      if (windows.admit(true) === "rate_limited")
        return sendOAuth(reply, { status: 429, body: { error: "temporarily_unavailable" } });
    });
    scope.get(`${MCP_AUTH_PREFIX}/authorize.js`, { logLevel: "silent" }, async (_request, reply) =>
      reply
        .header("cache-control", "max-age=300")
        .type("text/javascript; charset=utf-8")
        .send(PAGE_SCRIPT),
    );
    scope.get(`${MCP_AUTH_PREFIX}/authorize.css`, { logLevel: "silent" }, async (_request, reply) =>
      reply.header("cache-control", "max-age=300").type("text/css; charset=utf-8").send(PAGE_STYLE),
    );
    scope.get(`${MCP_AUTH_PREFIX}/authorize`, { logLevel: "silent" }, async (request, reply) => {
      const language = locale(request);
      const text = PAGE_TEXT[language];
      const query = new URLSearchParams(request.url.split("?")[1] ?? "");
      const outcome = await authorization.authorize(query);
      if (outcome.kind === "redirect")
        return reply
          .code(302)
          .header("cache-control", "no-store")
          .header("location", outcome.location)
          .send();
      if (outcome.kind === "error") {
        const reason: AuthorizeErrorReason = outcome.reason;
        return sendPage(
          reply,
          reason === "client_unavailable" ? 503 : reason === "busy" ? 429 : 400,
          page(language, text.errorTitle, [{ text: text[reason] }]),
        );
      }
      return sendPage(
        reply,
        200,
        page(
          language,
          text.waiting,
          [
            { text: text.asks(outcome.clientName, outcome.clientHost) },
            { text: text.how, muted: true },
          ],
          outcome.grantId,
        ),
      );
    });
    scope.get(
      `${MCP_AUTH_PREFIX}/authorize/status`,
      { logLevel: "silent" },
      async (request, reply) => {
        const grant = new URLSearchParams(request.url.split("?")[1] ?? "").get("grant") ?? "";
        const status = authorization.status(grant);
        if (!status)
          return reply.code(404).header("cache-control", "no-store").send({ state: "unknown" });
        return reply
          .code(200)
          .header("cache-control", "no-store")
          .send({ state: status.state, location: status.location });
      },
    );
    scope.options(`${MCP_AUTH_PREFIX}/*`, async (_request, reply) =>
      reply
        .code(204)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "content-type, authorization, mcp-protocol-version")
        .header("access-control-max-age", "600")
        .send(),
    );
    scope.post(
      `${MCP_AUTH_PREFIX}/register`,
      { logLevel: "silent", bodyLimit: MCP_AUTH_JSON_BODY_LIMIT },
      async (request, reply) => sendOAuth(reply, await authorization.register(request.body)),
    );
    scope.post(`${MCP_AUTH_PREFIX}/token`, { logLevel: "silent" }, async (request, reply) => {
      const form = formOf(request.body);
      if (
        !form ||
        request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") !== true
      )
        return sendOAuth(reply, { status: 400, body: { error: "invalid_request" } });
      return sendOAuth(reply, await authorization.token(form));
    });
    scope.post(`${MCP_AUTH_PREFIX}/revoke`, { logLevel: "silent" }, async (request, reply) => {
      const form = formOf(request.body);
      if (
        !form ||
        request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") !== true
      )
        return sendOAuth(reply, { status: 400, body: { error: "invalid_request" } });
      await authorization.revoke(form);
      return reply
        .code(200)
        .header("cache-control", "no-store")
        .header("access-control-allow-origin", "*")
        .send();
    });
  });
}
