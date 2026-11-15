import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  THINK_SETTING_DEFINITIONS,
  type ThinkInboxConfiguration,
  type ThinkInboxStorePort,
  type ThinkSettingKey,
  type ThinkSettingsRecord,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

type Scope = Parameters<ThinkInboxStorePort["readSettings"]>[0];
type ThinkSettingUnit = (typeof THINK_SETTING_DEFINITIONS)[number]["unit"];

export interface ThinkSettingText {
  readonly "zh-CN": string;
  readonly en: string;
  readonly ja: string;
}

export const THINK_SETTING_TEXT: Readonly<
  Record<
    ThinkSettingKey,
    { readonly label: ThinkSettingText; readonly description: ThinkSettingText }
  >
> = Object.freeze({
  yesAtLeastPermille: {
    label: {
      "zh-CN": "判为值得想的最低把握",
      en: "Confidence needed to think it over",
      ja: "考える価値ありと判断する最低の確信度",
    },
    description: {
      "zh-CN": "Jev 判断一件新来的事值得想一想时，把握至少到这个数（千分比）才开始想。",
      en: "Jev's confidence that a new item is worth thinking over must reach this value, in per mille, before Himawari starts.",
      ja: "新しく届いた件を考える価値があると Jev が判断したとき、確信度がこの値（パーミル）以上なら考え始めます。",
    },
  },
  noAtMostPermille: {
    label: {
      "zh-CN": "判为不值得想的最高把握",
      en: "Confidence at or below which it is skipped",
      ja: "考えなくてよいと判断する上限の確信度",
    },
    description: {
      "zh-CN": "Jev 的把握不超过这个数（千分比）就直接跳过；介于两个数之间算拿不准，也不想。",
      en: "If Jev's confidence is at or below this value, in per mille, the item is skipped. Anything between the two values counts as unsure and is skipped too.",
      ja: "Jev の確信度がこの値（パーミル）以下なら見送ります。二つの値の間は判断がつかないものとして、これも考えません。",
    },
  },
  queueLimit: {
    label: { "zh-CN": "排队上限", en: "Queue limit", ja: "待ち行列の上限" },
    description: {
      "zh-CN": "最多同时排队等着想的事数（包括正在想的），满了新来的先不收。",
      en: "How many items can wait to be thought over at once, including the one in progress. New items are turned away while it is full.",
      ja: "考えるのを待てる件数の上限です（考えている最中の件を含む）。いっぱいの間は新しい件を受け付けません。",
    },
  },
  dailyLimit: {
    label: { "zh-CN": "每天接收上限", en: "Daily limit", ja: "1 日の受付上限" },
    description: {
      "zh-CN": "一天最多接收多少件要想的事，按你的时区算一天。",
      en: "How many items to accept per day, counted in your time zone.",
      ja: "1 日に受け付ける件数の上限です。1 日はあなたのタイムゾーンで数えます。",
    },
  },
  expiresAfterHours: {
    label: { "zh-CN": "排队过期时间", en: "Queue expiry", ja: "待ちの有効期限" },
    description: {
      "zh-CN": "排队超过这么多小时还没轮到，就不再想这件事。",
      en: "An item still waiting after this many hours is dropped.",
      ja: "この時間を過ぎても順番が来ない件は考えずに取り下げます。",
    },
  },
  stalledAfterMinutes: {
    label: { "zh-CN": "卡住判定时间", en: "Stalled after", ja: "停滞とみなす時間" },
    description: {
      "zh-CN": "一件事“在想”超过这么多分钟还没结束，就当它卡住，重新排队或记为失败。",
      en: "An item still in progress after this many minutes counts as stalled and is queued again or marked failed.",
      ja: "考え始めてからこの時間を過ぎても終わらない件は停滞とみなし、並び直すか失敗として記録します。",
    },
  },
  maxAttempts: {
    label: { "zh-CN": "最多尝试次数", en: "Maximum attempts", ja: "最大試行回数" },
    description: {
      "zh-CN":
        "一件事“在想”时卡住了会重新排队再想，连同第一次最多想这么多次，仍卡住就记为失败。因别的原因失败的不会再想。",
      en: "An item that stalls while in progress is queued again, up to this many tries in all, and is then marked failed. Items that fail for other reasons are not tried again.",
      ja: "考えている最中に停滞した件は並び直して考え直します。最初の 1 回を含めてこの回数まで試しても停滞したら失敗として記録します。ほかの理由で失敗した件は考え直しません。",
    },
  },
  summaryCharacters: {
    label: { "zh-CN": "摘要长度上限", en: "Summary length", ja: "要約の最大文字数" },
    description: {
      "zh-CN": "交给 Himawari 想的来源摘要最多这么多字，多出的部分不收。",
      en: "The longest source summary Himawari is given to think over, in characters.",
      ja: "Himawari に渡す元の内容の要約は、この文字数までです。",
    },
  },
  idleSeconds: {
    label: { "zh-CN": "空闲时查看间隔", en: "Idle check interval", ja: "待機中の確認間隔" },
    description: {
      "zh-CN": "没有事要想时，隔这么多秒再看一次有没有新来的事。",
      en: "When nothing is waiting, how many seconds to wait before checking again.",
      ja: "考える件がないとき、次に新しい件を確認するまでの秒数です。",
    },
  },
  runTimeoutMinutes: {
    label: { "zh-CN": "一次最长时间", en: "Time limit per run", ja: "1 回の最大時間" },
    description: {
      "zh-CN": "一次想一想超过这么多分钟还没结束，就停止这次运行，记为失败。",
      en: "A run still going after this many minutes is stopped and marked failed.",
      ja: "1 回の考え事がこの時間を過ぎても終わらなければ止めて、失敗として記録します。",
    },
  },
  threadRetentionDays: {
    label: {
      "zh-CN": "想一想记录保留天数",
      en: "Keep thinking records for",
      ja: "考え事の記録を残す日数",
    },
    description: {
      "zh-CN":
        "Himawari 自己想一想时开的对话不在你的列表里，结束后保留这么多天，然后自动删除。想出的提议照样留在提议箱里。",
      en: "Conversations Himawari opens to think something over stay out of your lists. They are kept this many days after they finish and then deleted automatically. Any proposal they produced stays in your proposals.",
      ja: "Himawari が考え事のために開いた会話は一覧に出ません。終わってからこの日数だけ残し、その後自動で削除します。出てきた提案は提案箱に残ります。",
    },
  },
});

export const THINK_SETTING_UNIT_TEXT: Readonly<Record<ThinkSettingUnit, ThinkSettingText>> =
  Object.freeze({
    permille: { "zh-CN": "千分比", en: "per mille", ja: "パーミル" },
    count: { "zh-CN": "件", en: "items", ja: "件" },
    times: { "zh-CN": "次", en: "times", ja: "回" },
    hours: { "zh-CN": "小时", en: "hours", ja: "時間" },
    minutes: { "zh-CN": "分钟", en: "minutes", ja: "分" },
    characters: { "zh-CN": "字", en: "characters", ja: "文字" },
    seconds: { "zh-CN": "秒", en: "seconds", ja: "秒" },
    days: { "zh-CN": "天", en: "days", ja: "日" },
  });

export const PRODUCTION_THINK_OPERATIONS = Object.freeze([
  "think.settings.read",
  "think.settings.change",
] as const);

export interface ThinkSettingView {
  readonly key: ThinkSettingKey;
  readonly value: number;
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: ThinkSettingUnit;
  readonly overridden: boolean;
  readonly label: ThinkSettingText;
  readonly description: ThinkSettingText;
  readonly unitLabel: ThinkSettingText;
}

function refuse(code: string): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, code);
}

export class ProductionThinkSettings {
  readonly #scope: Scope;
  readonly #store: Pick<ThinkInboxStorePort, "readSettings" | "changeSettings">;
  readonly #configuration: ThinkInboxConfiguration | undefined;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly scope: Scope;
    readonly store: Pick<ThinkInboxStorePort, "readSettings" | "changeSettings">;
    readonly configuration: ThinkInboxConfiguration | undefined;
    readonly clock: ClockPort;
  }) {
    this.#scope = options.scope;
    this.#store = options.store;
    this.#configuration = options.configuration;
    this.#clock = options.clock;
  }

  get enabled(): boolean {
    return this.#configuration?.worth !== undefined;
  }

  defaultValue(key: ThinkSettingKey): number {
    const configured =
      key === "yesAtLeastPermille" || key === "noAtMostPermille"
        ? this.#configuration?.worth?.[key]
        : this.#configuration?.[key];
    const definition = THINK_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) return refuse("THINK_SETTING_UNKNOWN");
    return configured ?? definition.defaultValue;
  }

  async overrides(): Promise<Readonly<Record<string, number>>> {
    return (await this.#store.readSettings(this.#scope)).overrides;
  }

  #views(record: ThinkSettingsRecord): readonly ThinkSettingView[] {
    return THINK_SETTING_DEFINITIONS.map((definition) => {
      const stored = record.overrides[definition.key];
      const defaultValue = this.defaultValue(definition.key);
      return Object.freeze({
        key: definition.key,
        value: stored ?? defaultValue,
        defaultValue,
        minimum: definition.minimum,
        maximum: definition.maximum,
        unit: definition.unit,
        overridden: stored !== undefined,
        label: THINK_SETTING_TEXT[definition.key].label,
        description: THINK_SETTING_TEXT[definition.key].description,
        unitLabel: THINK_SETTING_UNIT_TEXT[definition.unit],
      });
    });
  }

  async read(): Promise<{
    readonly revision: number;
    readonly enabled: boolean;
    readonly items: readonly ThinkSettingView[];
  }> {
    const record = await this.#store.readSettings(this.#scope);
    return { revision: record.revision, enabled: this.enabled, items: this.#views(record) };
  }

  async change(
    expectedRevision: number,
    key: string,
    value: number | null,
  ): Promise<ThinkSettingsRecord> {
    const definition = THINK_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) return refuse("THINK_SETTING_UNKNOWN");
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum)
    )
      return refuse("THINK_SETTING_OUT_OF_RANGE");
    const current = await this.#store.readSettings(this.#scope);
    if (current.revision !== expectedRevision)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "THINK_SETTINGS_CHANGED");
    const overrides: Record<string, number> = {};
    for (const known of THINK_SETTING_DEFINITIONS) {
      const stored = current.overrides[known.key];
      if (stored !== undefined) overrides[known.key] = stored;
    }
    if (value === null) delete overrides[definition.key];
    else overrides[definition.key] = value;
    return this.#store.changeSettings({
      ...this.#scope,
      expectedRevision,
      overrides,
      now: this.#clock.now(),
    });
  }
}

type ThinkCommand = Extract<GatewayV2Command, { type: "think.settings.change" }>;

export class ProductionThinkControl {
  readonly #settings: ProductionThinkSettings;
  readonly #scope: Scope;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly settings: ProductionThinkSettings;
    readonly scope: Scope;
    readonly clock: ClockPort;
  }) {
    this.#settings = options.settings;
    this.#scope = options.scope;
    this.#clock = options.clock;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "think.settings.read") throw new Error("THINK_OPERATION_NOT_INSTALLED");
    const current = await this.#settings.read();
    return {
      ...query,
      kind: "snapshot",
      type: "think.settings.snapshot",
      actor: { actorType: "system", actorId: "agent-service" },
      payload: {
        revision: current.revision,
        enabled: current.enabled,
        items: current.items.map((item) => ({ ...item })),
        generatedAt: this.#clock.now(),
      },
    } as GatewayV2Snapshot;
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== this.#scope.ownerId ||
      command.scope.agentId !== this.#scope.agentId
    )
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "THINK_OWNER_REQUIRED");
    if (command.type !== "think.settings.change") throw new Error("THINK_OPERATION_NOT_INSTALLED");
    const payload = (command as ThinkCommand).payload;
    const record = await this.#settings.change(
      payload.expectedRevision,
      payload.key,
      payload.value,
    );
    return { resultRef: `think-settings:${record.revision}`, replayed: false };
  }
}
