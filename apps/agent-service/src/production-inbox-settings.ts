import {
  ApplicationPortError,
  type ClockPort,
  PORT_ERROR_CODES,
  INBOX_SETTING_DEFINITIONS,
  type InboxConfiguration,
  type InboxSettingKey,
  type InboxSettingsRecord,
  type InboxStorePort,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";

type Scope = Parameters<InboxStorePort["readSettings"]>[0];
type InboxSettingUnit = (typeof INBOX_SETTING_DEFINITIONS)[number]["unit"];

export interface InboxSettingText {
  readonly "zh-CN": string;
  readonly en: string;
  readonly ja: string;
}

export const INBOX_SETTING_TEXT: Readonly<
  Record<
    InboxSettingKey,
    { readonly label: InboxSettingText; readonly description: InboxSettingText }
  >
> = Object.freeze({
  eventsPerRun: {
    label: { "zh-CN": "一次运行最多几件", en: "Events per run", ja: "1 回の実行で扱う件数" },
    description: {
      "zh-CN":
        "同一个对话里攒着的事，一次运行最多带这么多件，按到达先后取；多出来的不丢，留给下一次运行。",
      en: "How many waiting events from one conversation a single run takes, oldest first. The rest are kept for the next run, never dropped.",
      ja: "同じ会話にたまった件を、1 回の実行で届いた順にこの件数まで扱います。残りは捨てずに次の実行に回します。",
    },
  },
  stalledAfterMinutes: {
    label: { "zh-CN": "卡住判定时间", en: "Stalled after", ja: "停滞とみなす時間" },
    description: {
      "zh-CN": "一件事交给运行后超过这么多分钟还没结束，就当它卡住，重新排队或记为失败。",
      en: "An event still being handled after this many minutes counts as stalled and is queued again or marked failed.",
      ja: "実行に渡してからこの時間を過ぎても終わらない件は停滞とみなし、並び直すか失敗として記録します。",
    },
  },
  maxAttempts: {
    label: { "zh-CN": "最多尝试次数", en: "Maximum attempts", ja: "最大試行回数" },
    description: {
      "zh-CN": "一件事处理失败或卡住会重新排队，连同第一次最多试这么多次，仍不成功就记为失败。",
      en: "An event whose run fails or stalls is queued again, up to this many tries in all, and is then marked failed.",
      ja: "実行が失敗または停滞した件は並び直します。最初の 1 回を含めてこの回数まで試してもだめなら失敗として記録します。",
    },
  },
  summaryCharacters: {
    label: { "zh-CN": "摘要长度上限", en: "Summary length", ja: "要約の最大文字数" },
    description: {
      "zh-CN": "每件事放进对话的简要最多这么多字，全文她用工具按需打开。",
      en: "The longest short summary of an event put into the conversation, in characters. Himawari opens the full text with a tool when she needs it.",
      ja: "会話に入れる各件の要約はこの文字数までです。全文は必要なときに Himawari が道具で開きます。",
    },
  },
  idleSeconds: {
    label: { "zh-CN": "空闲时查看间隔", en: "Idle check interval", ja: "待機中の確認間隔" },
    description: {
      "zh-CN": "新事情一进收件箱就会马上处理；这一项只是兜底，没有事时隔这么多秒再检查一次。",
      en: "New events are handled as soon as they arrive. As a fallback, when nothing is waiting, check again after this many seconds.",
      ja: "新しい件は届いたらすぐ扱います。これは念のための設定で、件がないときはこの秒数ごとに確認し直します。",
    },
  },
  runTimeoutMinutes: {
    label: { "zh-CN": "一次最长时间", en: "Time limit per run", ja: "1 回の最大時間" },
    description: {
      "zh-CN": "一次运行超过这么多分钟还没结束，就停下，这批事回到收件箱重试。",
      en: "A run still going after this many minutes is stopped and its events go back to the inbox to be tried again.",
      ja: "1 回の実行がこの時間を過ぎても終わらなければ止め、その件は受信箱に戻して試し直します。",
    },
  },
});

export const INBOX_SETTING_UNIT_TEXT: Readonly<Record<InboxSettingUnit, InboxSettingText>> =
  Object.freeze({
    count: { "zh-CN": "件", en: "items", ja: "件" },
    times: { "zh-CN": "次", en: "times", ja: "回" },
    minutes: { "zh-CN": "分钟", en: "minutes", ja: "分" },
    characters: { "zh-CN": "字", en: "characters", ja: "文字" },
    seconds: { "zh-CN": "秒", en: "seconds", ja: "秒" },
  });

export const INBOX_SETTING_UNIT_VALUE: Readonly<
  Record<
    InboxSettingUnit,
    {
      readonly kind: "ratio" | "duration" | "count";
      readonly storageUnit: "permille" | "s" | "min" | "h" | "d" | "count";
    }
  >
> = Object.freeze({
  count: { kind: "count", storageUnit: "count" },
  times: { kind: "count", storageUnit: "count" },
  minutes: { kind: "duration", storageUnit: "min" },
  characters: { kind: "count", storageUnit: "count" },
  seconds: { kind: "duration", storageUnit: "s" },
});

export const PRODUCTION_INBOX_OPERATIONS = Object.freeze([
  "think.settings.read",
  "think.settings.change",
] as const);

export interface InboxSettingView {
  readonly key: InboxSettingKey;
  readonly value: number;
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: InboxSettingUnit;
  readonly kind: "ratio" | "duration" | "count";
  readonly storageUnit: "permille" | "s" | "min" | "h" | "d" | "count";
  readonly overridden: boolean;
  readonly label: InboxSettingText;
  readonly description: InboxSettingText;
  readonly unitLabel: InboxSettingText;
}

function refuse(code: string): never {
  throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, code);
}

export class ProductionInboxSettings {
  readonly #scope: Scope;
  readonly #store: Pick<InboxStorePort, "readSettings" | "changeSettings">;
  readonly #configuration: InboxConfiguration | undefined;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly scope: Scope;
    readonly store: Pick<InboxStorePort, "readSettings" | "changeSettings">;
    readonly configuration: InboxConfiguration | undefined;
    readonly clock: ClockPort;
    readonly enabled: boolean;
  }) {
    this.#scope = options.scope;
    this.#store = options.store;
    this.#configuration = options.configuration;
    this.#clock = options.clock;
    this.enabled = options.enabled;
  }

  readonly enabled: boolean;

  defaultValue(key: InboxSettingKey): number {
    const configured = this.#configuration?.[key];
    const definition = INBOX_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) return refuse("INBOX_SETTING_UNKNOWN");
    return configured ?? definition.defaultValue;
  }

  async overrides(): Promise<Readonly<Record<string, number>>> {
    return (await this.#store.readSettings(this.#scope)).overrides;
  }

  #views(record: InboxSettingsRecord): readonly InboxSettingView[] {
    return INBOX_SETTING_DEFINITIONS.map((definition) => {
      const stored = record.overrides[definition.key];
      const defaultValue = this.defaultValue(definition.key);
      return Object.freeze({
        key: definition.key,
        value: stored ?? defaultValue,
        defaultValue,
        minimum: definition.minimum,
        maximum: definition.maximum,
        unit: definition.unit,
        kind: INBOX_SETTING_UNIT_VALUE[definition.unit].kind,
        storageUnit: INBOX_SETTING_UNIT_VALUE[definition.unit].storageUnit,
        overridden: stored !== undefined,
        label: INBOX_SETTING_TEXT[definition.key].label,
        description: INBOX_SETTING_TEXT[definition.key].description,
        unitLabel: INBOX_SETTING_UNIT_TEXT[definition.unit],
      });
    });
  }

  async read(): Promise<{
    readonly revision: number;
    readonly enabled: boolean;
    readonly items: readonly InboxSettingView[];
  }> {
    const record = await this.#store.readSettings(this.#scope);
    return { revision: record.revision, enabled: this.enabled, items: this.#views(record) };
  }

  async change(
    expectedRevision: number,
    key: string,
    value: number | null,
  ): Promise<InboxSettingsRecord> {
    const definition = INBOX_SETTING_DEFINITIONS.find((item) => item.key === key);
    if (!definition) return refuse("INBOX_SETTING_UNKNOWN");
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum)
    )
      return refuse("INBOX_SETTING_OUT_OF_RANGE");
    const current = await this.#store.readSettings(this.#scope);
    if (current.revision !== expectedRevision)
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "INBOX_SETTINGS_CHANGED");
    const overrides: Record<string, number> = {};
    for (const known of INBOX_SETTING_DEFINITIONS) {
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

type InboxSettingsCommand = Extract<GatewayV2Command, { type: "think.settings.change" }>;

export class ProductionInboxControl {
  readonly #settings: ProductionInboxSettings;
  readonly #scope: Scope;
  readonly #clock: ClockPort;

  constructor(options: {
    readonly settings: ProductionInboxSettings;
    readonly scope: Scope;
    readonly clock: ClockPort;
  }) {
    this.#settings = options.settings;
    this.#scope = options.scope;
    this.#clock = options.clock;
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    if (query.type !== "think.settings.read") throw new Error("INBOX_OPERATION_NOT_INSTALLED");
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
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, "INBOX_OWNER_REQUIRED");
    if (command.type !== "think.settings.change") throw new Error("INBOX_OPERATION_NOT_INSTALLED");
    const payload = (command as InboxSettingsCommand).payload;
    const record = await this.#settings.change(
      payload.expectedRevision,
      payload.key,
      payload.value,
    );
    return { resultRef: `inbox-settings:${record.revision}`, replayed: false };
  }
}
