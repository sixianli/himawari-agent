import type {
  ClockPort,
  GapCaseMarkPort,
  ProactiveScope,
  ProactiveSealPort,
} from "@himawari-agent/application";
import { redactForEgress } from "@himawari-agent/sensitive-capture";
import type { FastifyInstance } from "fastify";
import { BearerGate } from "./bearer-admission.js";
import type { GapCase } from "./production-gap-cases.js";

export const GAP_EXPORT_PATH = "/api/gap-cases/v1/export";
export const GAP_EXPORT_SCHEMA = "himawari-gap-cases.v1";
const JST_OFFSET_MS = 9 * 3_600_000;

export interface GapCaseSnapshot extends GapCase {
  readonly weekStart: string;
  readonly weekEnd: string;
}

export interface GapBacklogPrefill {
  readonly title: string;
  readonly summary: string;
  readonly why: string;
  readonly origin: string;
}

export const GAP_ATTRIBUTION_TEXT = Object.freeze({
  notRemembered: "没记住",
  notRetrieved: "没取到",
  wrongJudgment: "判断错",
  notReadFully: "没读全",
} as const);

const jstDay = (iso: string) =>
  new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);

function outcomeText(outcome: string): string {
  if (outcome === "skipped") return "跳过了这封邮件、没有判断";
  return "判断为不用管、没有提醒";
}

function clip(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}

const isText = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isInstant = (value: unknown): value is string =>
  isText(value) && !Number.isNaN(Date.parse(value));

export function isGapCaseSnapshot(value: unknown): value is GapCaseSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    isText(item["id"]) &&
    isInstant(item["museAt"]) &&
    isInstant(item["weekStart"]) &&
    isInstant(item["weekEnd"]) &&
    isText(item["attribution"]) &&
    Object.hasOwn(GAP_ATTRIBUTION_TEXT, item["attribution"]) &&
    isText(item["himawariOutcome"]) &&
    isCount(item["memoryHits"]) &&
    isCount(item["relatedMessages"]) &&
    (item["museTitle"] === null || isText(item["museTitle"])) &&
    (item["himawariReason"] === null || isText(item["himawariReason"])) &&
    (item["ownerRating"] === null || isText(item["ownerRating"]))
  );
}

export function gapBacklogPrefill(snapshot: GapCaseSnapshot): GapBacklogPrefill {
  const subject = mask(snapshot.museTitle ?? "（Muse 的文字没有留存）");
  const reason = snapshot.himawariReason === null ? null : mask(snapshot.himawariReason);
  const attribution = GAP_ATTRIBUTION_TEXT[snapshot.attribution];
  const rating =
    snapshot.ownerRating === "missed" ? "你评了“该做没做”" : "Muse 的时机和内容你都评了对";
  return {
    title: clip(`让 Himawari 也能提醒 Muse 提醒过的这类邮件：${subject}`, 120),
    summary: clip(
      `${jstDay(snapshot.museAt)}（日本时间）Muse 提醒了「${subject}」，Himawari 当时${outcomeText(snapshot.himawariOutcome)}。${rating}。归因：${attribution}。取回这封邮件的相关记忆 ${snapshot.memoryHits} 条，读到的相关往来邮件 ${snapshot.relatedMessages} 封。${reason ? `Himawari 当时给的理由：${reason}` : ""}`,
      900,
    ),
    why: "追平 Muse 靠数据指出，不靠猜：这是校准周报“Muse 做对而 Himawari 没做到”的案例，补上这一类才能让命中率差缩小。",
    origin: `Himawari 校准周报案例 ${snapshot.id}（${jstDay(snapshot.weekStart)} 至 ${jstDay(new Date(Date.parse(snapshot.weekEnd) - 1).toISOString())}）`,
  };
}

function mask(text: string): string {
  return redactForEgress(text).text;
}

export interface GapExportCase {
  readonly id: string;
  readonly markedAt: string;
  readonly week: { readonly start: string; readonly end: string };
  readonly attribution: keyof typeof GAP_ATTRIBUTION_TEXT;
  readonly prefill: GapBacklogPrefill;
}

export interface GapExportBody {
  readonly schema: typeof GAP_EXPORT_SCHEMA;
  readonly generatedAt: string;
  readonly skipped: number;
  readonly cases: readonly GapExportCase[];
}

export class ProductionGapExport {
  readonly #scope: ProactiveScope;
  readonly #marks: GapCaseMarkPort;
  readonly #seal: ProactiveSealPort;
  readonly #clock: ClockPort;
  readonly #gate: BearerGate;

  constructor(options: {
    readonly scope: ProactiveScope;
    readonly marks: GapCaseMarkPort;
    readonly seal: ProactiveSealPort;
    readonly clock: ClockPort;
    readonly secret: string;
  }) {
    this.#scope = options.scope;
    this.#marks = options.marks;
    this.#seal = options.seal;
    this.#clock = options.clock;
    this.#gate = new BearerGate(options.clock, options.secret, 32, "GAP_EXPORT_SECRET_TOO_SHORT");
  }

  admit(authorization: string | undefined) {
    return this.#gate.admit(authorization);
  }

  async export(): Promise<GapExportBody> {
    const marks = await this.#marks.list(this.#scope);
    const cases: GapExportCase[] = [];
    let skipped = 0;
    for (const mark of marks) {
      try {
        const text = await this.#seal.open({ ...this.#scope, ref: mark.snapshotRef });
        if (text === undefined) {
          skipped += 1;
          continue;
        }
        const parsed: unknown = JSON.parse(text);
        if (!isGapCaseSnapshot(parsed)) {
          skipped += 1;
          continue;
        }
        const snapshot = parsed;
        const prefill = gapBacklogPrefill(snapshot);
        cases.push({
          id: mark.caseId,
          markedAt: mark.markedAt,
          week: { start: snapshot.weekStart, end: snapshot.weekEnd },
          attribution: snapshot.attribution,
          prefill: {
            title: mask(prefill.title),
            summary: mask(prefill.summary),
            why: mask(prefill.why),
            origin: mask(prefill.origin),
          },
        });
      } catch {
        skipped += 1;
      }
    }
    if (marks.length > 0 && cases.length === 0 && skipped === marks.length)
      throw new Error("GAP_EXPORT_ALL_SNAPSHOTS_UNREADABLE");
    return { schema: GAP_EXPORT_SCHEMA, generatedAt: this.#clock.now(), skipped, cases };
  }
}

export function registerGapExportRoute(app: FastifyInstance, gapExport: ProductionGapExport): void {
  void app.register(async (scope) => {
    scope.setErrorHandler(async (_error, _request, reply) =>
      reply.code(500).header("cache-control", "no-store").send(),
    );
    scope.get(
      GAP_EXPORT_PATH,
      {
        onRequest: async (request, reply) => {
          const gate = gapExport.admit(request.headers.authorization);
          if (gate === "ok") return;
          return reply
            .code(gate === "unauthorized" ? 401 : 429)
            .header("cache-control", "no-store")
            .send();
        },
      },
      async (_request, reply) =>
        reply
          .code(200)
          .header("cache-control", "no-store")
          .send(await gapExport.export()),
    );
  });
}
