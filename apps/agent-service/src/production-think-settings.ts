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
  readonly unit: (typeof THINK_SETTING_DEFINITIONS)[number]["unit"];
  readonly overridden: boolean;
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
