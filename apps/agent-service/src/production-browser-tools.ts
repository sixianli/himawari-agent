import type {
  ApprovalDisplayInput,
  ProductConfiguration,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
} from "@himawari-agent/application";
import {
  TOOL_BROWSER,
  TOOL_BROWSER_ACTION,
  TOOL_BROWSER_HOSTS,
  TOOL_BROWSER_KEY,
  TOOL_BROWSER_REF,
  TOOL_BROWSER_SUBMIT,
  TOOL_BROWSER_TEXT,
  TOOL_BROWSER_URL,
  TOOL_RESULT_BROWSER_NO_PAGE,
  TOOL_RESULT_BROWSER_SCREENSHOT_TEXT_ONLY,
  TOOL_RESULT_BROWSER_SITE_NOT_ALLOWED,
  TOOL_RESULT_BROWSER_UNAVAILABLE,
} from "@himawari-agent/prompt-catalog";
import { UserComputerClient } from "@himawari-agent/runtime-sandbox/computers";

export const BROWSER_CAPABILITY_REF = "browser.use";
export const BROWSER_PROGRAM = "himawari-browser";
export const BROWSER_SITE_TARGET = "browser-site";

const MODEL_ACTIONS = ["open", "read", "click", "type", "press", "back", "screenshot"] as const;
type ModelAction = (typeof MODEL_ACTIONS)[number];
const OFFLINE_ACTIONS: readonly ModelAction[] = ["read", "screenshot"];
const ARGUMENTS: Readonly<Record<ModelAction, readonly string[]>> = Object.freeze({
  open: ["action", "url", "hosts"],
  read: ["action"],
  click: ["action", "ref"],
  type: ["action", "ref", "text", "submit"],
  press: ["action", "key"],
  back: ["action"],
  screenshot: ["action"],
});
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DEFAULT_PORTS = ["443", "80"] as const;

export type BrowserLocale = "zh-CN" | "en" | "ja";

export interface BrowserComputerExecInput {
  readonly ownerId: string;
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly allowedDomains: readonly string[];
  readonly deadlineAt: string;
  readonly maxOutputBytes: number;
}

export interface BrowserComputerExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
}

export interface BrowserComputer {
  exec(input: BrowserComputerExecInput): Promise<BrowserComputerExecResult>;
}

export interface BrowserToolHooks {
  readonly authorizeSites: (
    sites: readonly string[],
    display: () => Promise<ApprovalDisplayInput>,
  ) => Promise<void>;
  readonly markExternalContent: () => Promise<void>;
}

export interface BrowserToolResult {
  readonly value: unknown;
  readonly images?: readonly { readonly mimeType: string; readonly data: string }[];
}

export interface ProductionBrowserToolsOptions {
  readonly ownerId: string;
  readonly computer: BrowserComputer;
  readonly maxOutputBytes: number;
  readonly maxTextChars: number;
  readonly responseReserveMs: number;
  readonly acceptsImages: (modelRef: string) => boolean | Promise<boolean>;
  readonly now: () => number;
  readonly readLocale?: () => Promise<BrowserLocale | null>;
}

export class BrowserToolError extends Error {
  readonly code: string;
  readonly note: string;
  constructor(code: string, note: string, detail?: string) {
    super(code);
    this.code = code;
    this.note = detail ? `${note}（${detail.slice(0, 200)}）` : note;
  }
}

const invalid = (detail: string) =>
  new BrowserToolError("BROWSER_INPUT_INVALID", TOOL_RESULT_BROWSER_UNAVAILABLE.text, detail);

export function browserToolDescriptors(): readonly RuntimeToolDescriptor[] {
  return [
    {
      name: "browser",
      capabilityRef: BROWSER_CAPABILITY_REF,
      capabilityHandleRef: null,
      description: TOOL_BROWSER.text,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...MODEL_ACTIONS],
            description: TOOL_BROWSER_ACTION.text,
          },
          url: { type: "string", description: TOOL_BROWSER_URL.text },
          ref: { type: "string", description: TOOL_BROWSER_REF.text },
          text: { type: "string", description: TOOL_BROWSER_TEXT.text },
          submit: { type: "boolean", description: TOOL_BROWSER_SUBMIT.text },
          key: { type: "string", description: TOOL_BROWSER_KEY.text },
          hosts: {
            type: "array",
            items: { type: "string" },
            description: TOOL_BROWSER_HOSTS.text,
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  ];
}

function siteOf(raw: unknown): { readonly host: string; readonly port: string | null } | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!HOST_NAME.test(host)) return null;
  return { host, port: url.port || null };
}

function hostName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase();
  return HOST_NAME.test(host) ? host : null;
}

export function browserAllowedDomains(
  sites: readonly string[],
  extraPorts: readonly string[] = [],
): readonly string[] {
  const ports = [...new Set([...DEFAULT_PORTS, ...extraPorts])];
  return [...new Set(sites.flatMap((host) => ports.map((port) => `${host}:${port}`)))].sort();
}

const TITLES: Readonly<Record<BrowserLocale, (sites: string) => string>> = Object.freeze({
  "zh-CN": (sites: string) => `用浏览器访问 ${sites}`,
  en: (sites: string) => `Use the browser on ${sites}`,
  ja: (sites: string) => `ブラウザで ${sites} を使う`,
});

const BODIES: Readonly<Record<ModelAction, Readonly<Record<BrowserLocale, string>>>> =
  Object.freeze({
    open: { "zh-CN": "打开", en: "Open", ja: "開く" },
    read: { "zh-CN": "读页面", en: "Read the page", ja: "ページを読む" },
    click: { "zh-CN": "点击", en: "Click", ja: "クリック" },
    type: { "zh-CN": "输入", en: "Type", ja: "入力" },
    press: { "zh-CN": "按键", en: "Press a key", ja: "キーを押す" },
    back: { "zh-CN": "后退", en: "Go back", ja: "戻る" },
    screenshot: { "zh-CN": "截图", en: "Screenshot", ja: "スクリーンショット" },
  });

interface ProgramResponse {
  readonly ok: boolean;
  readonly page?: { readonly url: string; readonly title: string };
  readonly text?: string;
  readonly truncated?: boolean;
  readonly blockedHosts?: readonly string[];
  readonly screenshot?: { readonly mimeType: string; readonly data: string };
  readonly error?: { readonly code: string; readonly detail?: string };
}

export class ProductionBrowserTools {
  readonly #options: ProductionBrowserToolsOptions;
  #site: string | null = null;

  constructor(options: ProductionBrowserToolsOptions) {
    if (
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 1 ||
      !Number.isSafeInteger(options.maxTextChars) ||
      options.maxTextChars < 1 ||
      !Number.isSafeInteger(options.responseReserveMs) ||
      options.responseReserveMs < 0
    )
      throw new Error("BROWSER_TOOL_LIMITS_INVALID");
    this.#options = options;
  }

  async run(
    invocation: RuntimeToolInvocation,
    hooks: BrowserToolHooks,
  ): Promise<BrowserToolResult> {
    if (invocation.capabilityRef !== BROWSER_CAPABILITY_REF) throw invalid("capability");
    const args = invocation.arguments;
    const action = args["action"] as ModelAction;
    if (!(MODEL_ACTIONS as readonly unknown[]).includes(action)) throw invalid("action");
    if (Object.keys(args).some((name) => !ARGUMENTS[action].includes(name)))
      throw invalid("arguments");
    const request = this.#request(action, args);
    const deadline = invocation.executionDeadlineAt;
    const deadlineMs = deadline === undefined ? Number.NaN : Date.parse(deadline);
    if (!deadline || !Number.isFinite(deadlineMs)) throw invalid("deadline");
    let sites: readonly string[] = [];
    let extraPorts: readonly string[] = [];
    if (action === "open") {
      const target = siteOf(args["url"]);
      if (!target) throw invalid("url");
      const extra = args["hosts"];
      if (extra !== undefined && !Array.isArray(extra)) throw invalid("hosts");
      const hosts = (extra ?? []).map(hostName);
      if (hosts.some((host) => host === null)) throw invalid("hosts");
      sites = [...new Set([target.host, ...(hosts as string[])])].sort();
      extraPorts = target.port ? [target.port] : [];
    } else if (!OFFLINE_ACTIONS.includes(action)) {
      const current = this.#site ?? (await this.#currentSite(deadline));
      sites = current ? [current] : [];
    }
    if (sites.length > 0) await hooks.authorizeSites(sites, this.#display(action, sites));
    const remaining = deadlineMs - this.#options.now() - this.#options.responseReserveMs;
    if (remaining < 1)
      throw new BrowserToolError("BROWSER_DEADLINE_PASSED", TOOL_RESULT_BROWSER_UNAVAILABLE.text);
    const response = await this.#exec(
      { ...request, timeoutMs: remaining, maxTextChars: this.#options.maxTextChars },
      browserAllowedDomains(sites, extraPorts),
      deadline,
    );
    this.#site = response.page ? (siteOf(response.page.url)?.host ?? null) : this.#site;
    if (response.text !== undefined) await hooks.markExternalContent();
    const value: Record<string, unknown> = {
      page: response.page,
      ...(response.text === undefined
        ? {}
        : { text: response.text, truncated: response.truncated }),
      blockedHosts: response.blockedHosts ?? [],
    };
    if (action !== "screenshot" || !response.screenshot) return { value };
    if (!(await this.#options.acceptsImages(invocation.context?.modelRef ?? "")))
      return { value: { ...value, note: TOOL_RESULT_BROWSER_SCREENSHOT_TEXT_ONLY.text } };
    return {
      value,
      images: [{ mimeType: response.screenshot.mimeType, data: response.screenshot.data }],
    };
  }

  #request(action: ModelAction, args: RuntimeToolInvocation["arguments"]) {
    const ref = args["ref"];
    const text = args["text"];
    const submit = args["submit"];
    const key = args["key"];
    switch (action) {
      case "open":
        if (typeof args["url"] !== "string") throw invalid("url");
        return { action, url: args["url"] };
      case "click":
        if (typeof ref !== "string") throw invalid("ref");
        return { action, ref };
      case "type":
        if (typeof ref !== "string" || typeof text !== "string") throw invalid("ref/text");
        if (submit !== undefined && typeof submit !== "boolean") throw invalid("submit");
        return { action, ref, text, ...(submit === undefined ? {} : { submit }) };
      case "press":
        if (typeof key !== "string") throw invalid("key");
        return { action, key };
      default:
        return { action };
    }
  }

  async #currentSite(deadline: string): Promise<string | null> {
    const remaining = Date.parse(deadline) - this.#options.now() - this.#options.responseReserveMs;
    if (remaining < 1)
      throw new BrowserToolError("BROWSER_DEADLINE_PASSED", TOOL_RESULT_BROWSER_UNAVAILABLE.text);
    const response = await this.#exec(
      { action: "status", timeoutMs: remaining, maxTextChars: this.#options.maxTextChars },
      [],
      deadline,
    );
    return response.page ? (siteOf(response.page.url)?.host ?? null) : null;
  }

  #display(action: ModelAction, sites: readonly string[]) {
    return async (): Promise<ApprovalDisplayInput> => {
      const locale = (await this.#options.readLocale?.()) ?? "zh-CN";
      return {
        displayTitle: TITLES[locale](sites.join("、")),
        bodyPreview: BODIES[action][locale],
        origin: null,
      };
    };
  }

  async #exec(
    request: Record<string, unknown>,
    allowedDomains: readonly string[],
    deadlineAt: string,
  ): Promise<ProgramResponse> {
    let result: BrowserComputerExecResult;
    try {
      result = await this.#options.computer.exec({
        ownerId: this.#options.ownerId,
        argv: [BROWSER_PROGRAM],
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        allowedDomains,
        deadlineAt,
        maxOutputBytes: this.#options.maxOutputBytes,
      });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "BROWSER_COMPUTER_UNAVAILABLE";
      const detail =
        error instanceof Error && "detail" in error && typeof error.detail === "string"
          ? error.detail
          : undefined;
      throw new BrowserToolError(code, TOOL_RESULT_BROWSER_UNAVAILABLE.text, detail);
    }
    if (result.truncated)
      throw new BrowserToolError("BROWSER_OUTPUT_TOO_LARGE", TOOL_RESULT_BROWSER_UNAVAILABLE.text);
    let response: ProgramResponse;
    try {
      response = JSON.parse(new TextDecoder().decode(result.stdout)) as ProgramResponse;
    } catch {
      const stderr = new TextDecoder().decode(result.stderr).split("\n")[0] ?? "";
      throw new BrowserToolError("BROWSER_FAILED", TOOL_RESULT_BROWSER_UNAVAILABLE.text, stderr);
    }
    if (response.ok) return response;
    const code = response.error?.code ?? "BROWSER_FAILED";
    const detail = response.error?.detail;
    if (code === "BROWSER_SITE_NOT_ALLOWED")
      throw new BrowserToolError(code, TOOL_RESULT_BROWSER_SITE_NOT_ALLOWED.text, detail);
    if (code === "BROWSER_NO_PAGE")
      throw new BrowserToolError(code, TOOL_RESULT_BROWSER_NO_PAGE.text);
    throw new BrowserToolError(code, TOOL_RESULT_BROWSER_UNAVAILABLE.text, detail);
  }
}

export function createConfiguredBrowserTools(
  configuration: Pick<ProductConfiguration, "ownerId" | "runPolicy">,
  options: Pick<ProductionBrowserToolsOptions, "acceptsImages" | "now" | "readLocale">,
): ProductionBrowserTools | undefined {
  const computers = configuration.runPolicy?.userComputers;
  const browser = configuration.runPolicy?.browser;
  if (!computers || !browser) return undefined;
  return new ProductionBrowserTools({
    ownerId: configuration.ownerId,
    computer: new UserComputerClient(computers.socketPath),
    maxOutputBytes: browser.maxOutputBytes,
    maxTextChars: browser.maxTextChars,
    responseReserveMs: browser.responseReserveMs,
    ...options,
  });
}
