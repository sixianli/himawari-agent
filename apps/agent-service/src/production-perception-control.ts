import {
  ApplicationPortError,
  type ClockPort,
  PERCEPTION_CONFIGURATION_RANGES,
  PERCEPTION_RECORD_TYPES,
  PERCEPTION_RETENTION_CONFIGURATION,
  PERCEPTION_RETENTION_KEYS,
  PERCEPTION_SENSES,
  type PerceptionConfiguration,
  type PerceptionEpisode,
  type PerceptionEpisodeOverview,
  type PerceptionRecord,
  type PerceptionScope,
  PORT_ERROR_CODES,
  type ProductConfiguration,
} from "@himawari-agent/application";
import type {
  GatewayV2Command,
  GatewayV2Query,
  GatewayV2Snapshot,
} from "@himawari-agent/gateway-contracts";
import {
  PairedDeviceError,
  type PerceptionService,
  type PerceptionSettingsChange,
} from "@himawari-agent/platform-node";

export const PRODUCTION_PERCEPTION_OPERATIONS = Object.freeze([
  "perception.status.read",
  "perception.day.read",
  "perception.episode.read",
  "perception.usage.read",
  "perception.settings.change",
] as const);

export interface ProductionPerceptionControlOptions {
  readonly configuration: Pick<ProductConfiguration, "ownerId" | "agentId">;
  readonly perception: PerceptionService;
  readonly perceptionConfiguration: () => PerceptionConfiguration;
  readonly readText: (contentRef: string) => Promise<string | undefined>;
  readonly clock: ClockPort;
}

type PerceptionCommand = Extract<GatewayV2Command, { type: "perception.settings.change" }>;

function pairs(values: Readonly<Record<string, string | number | boolean>>) {
  return Object.entries(values).map(([name, value]) => ({ name, value: String(value) }));
}

function settingsChange(payload: PerceptionCommand["payload"]): PerceptionSettingsChange {
  const refuse = (): never => {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.INVALID_OPERATION,
      "PERCEPTION_SETTINGS_CHANGE_INVALID",
    );
  };
  switch (payload.kind) {
    case "sense": {
      const sense = PERCEPTION_SENSES.find((candidate) => candidate === payload.sense);
      if (sense === undefined || payload.enabled === null) return refuse();
      return { kind: "sense", sense, enabled: payload.enabled };
    }
    case "pause":
      return payload.until === null ? refuse() : { kind: "pause", until: payload.until };
    case "resume":
      return { kind: "resume" };
    case "retention": {
      const key = PERCEPTION_RETENTION_KEYS.find((candidate) => candidate === payload.key);
      return key === undefined ? refuse() : { kind: "retention", key, days: payload.value };
    }
    case "limit":
      return payload.key === null
        ? refuse()
        : { kind: "limit", key: payload.key, value: payload.value };
  }
}

export class ProductionPerceptionControl {
  readonly #options: ProductionPerceptionControlOptions;

  constructor(options: ProductionPerceptionControlOptions) {
    this.#options = options;
  }

  #scope(): PerceptionScope {
    const { ownerId, agentId } = this.#options.configuration;
    return { ownerId, agentId };
  }

  async #recordView(record: PerceptionRecord, clip: boolean) {
    const full =
      record.contentRef === null ? undefined : await this.#options.readText(record.contentRef);
    const limit = this.#options.perceptionConfiguration().previewCharacters;
    const characters = full === undefined ? [] : [...full];
    const truncated = clip && characters.length > limit;
    return {
      id: record.id,
      type: record.type,
      sense: PERCEPTION_RECORD_TYPES[record.type].sense,
      origin: record.origin,
      captureSource: record.captureSource,
      occurredAt: new Date(record.occurredAtMs).toISOString(),
      deviceId: record.deviceId,
      speakerKind: record.speakerKind,
      text: full === undefined ? null : truncated ? characters.slice(0, limit).join("") : full,
      textTruncated: truncated,
      evidence: pairs(record.evidence),
    };
  }

  async #episodeView(episode: PerceptionEpisode, overview: PerceptionEpisodeOverview) {
    const lead = overview.lead === null ? null : await this.#recordView(overview.lead, true);
    const senses = new Set(overview.types.map((type) => PERCEPTION_RECORD_TYPES[type].sense));
    return {
      id: episode.id,
      startedAt: new Date(episode.startedAtMs).toISOString(),
      endedAt: new Date(episode.endedAtMs).toISOString(),
      recordCount: episode.recordCount,
      senses: PERCEPTION_SENSES.filter((sense) => senses.has(sense)),
      types: overview.types,
      deviceIds: overview.deviceIds,
      preview: lead?.text ?? null,
      previewTruncated: lead?.textTruncated ?? false,
      summary: null,
      summarySource: "none" as const,
    };
  }

  async query(query: GatewayV2Query): Promise<GatewayV2Snapshot> {
    const scope = this.#scope();
    const service = this.#options.perception;
    const head = {
      ...query,
      kind: "snapshot" as const,
      actor: { actorType: "system" as const, actorId: "agent-service" },
    };
    const generatedAt = this.#options.clock.now();
    switch (query.type) {
      case "perception.status.read": {
        const [status, settings] = await Promise.all([
          service.status(scope),
          service.settings(scope),
        ]);
        const configuration = this.#options.perceptionConfiguration();
        const days = service.retentionDays(settings);
        return {
          ...head,
          type: "perception.status.snapshot",
          payload: {
            state: status.state,
            pausedUntil: status.pausedUntil,
            senses: status.senses,
            day: status.day,
            todayCount: status.todayCount,
            availableSenses: PERCEPTION_SENSES,
            retention: PERCEPTION_RETENTION_KEYS.map((key) => {
              const configurationKey = PERCEPTION_RETENTION_CONFIGURATION[key];
              const [minDays, maxDays] = PERCEPTION_CONFIGURATION_RANGES[configurationKey];
              return {
                key,
                days: days[key],
                defaultDays: configuration[configurationKey],
                minDays,
                maxDays,
              };
            }),
            pauseMaximumSeconds: configuration.pauseMaximumSeconds,
            revision: settings.revision,
            generatedAt,
          },
        };
      }
      case "perception.day.read": {
        const page = await service.listDay({ scope, ...query.payload });
        return {
          ...head,
          type: "perception.day.snapshot",
          payload: {
            day: page.day,
            total: page.total,
            senseCounts: await service.countDayBySense(scope, page.day),
            rows: await Promise.all(
              page.rows.map(async (row) => ({
                kind: row.kind,
                at: new Date(row.atMs).toISOString(),
                episode:
                  row.kind === "episode"
                    ? await this.#episodeView(row.episode, row.overview)
                    : null,
                record: row.kind === "record" ? await this.#recordView(row.record, true) : null,
              })),
            ),
            nextCursor: page.nextCursor,
            generatedAt,
          },
        };
      }
      case "perception.episode.read": {
        const found = await service.readEpisode({ scope, ...query.payload });
        return {
          ...head,
          type: "perception.episode.snapshot",
          payload: {
            episode: found ? await this.#episodeView(found.episode, found.overview) : null,
            records: found
              ? await Promise.all(found.records.map((record) => this.#recordView(record, false)))
              : [],
            nextCursor: found?.nextCursor ?? null,
            generatedAt,
          },
        };
      }
      case "perception.usage.read": {
        const [usage, settings] = await Promise.all([
          service.usage(scope),
          service.settings(scope),
        ]);
        return {
          ...head,
          type: "perception.usage.snapshot",
          payload: { ...usage, revision: settings.revision, generatedAt },
        };
      }
      default:
        throw new Error("PERCEPTION_OPERATION_NOT_INSTALLED");
    }
  }

  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
    const scope = this.#scope();
    if (
      command.actor.actorType !== "owner" ||
      command.scope.ownerId !== scope.ownerId ||
      command.scope.agentId !== scope.agentId
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "PERCEPTION_OWNER_REQUIRED",
      );
    switch (command.type) {
      case "perception.settings.change": {
        const settings = await this.#options.perception
          .changeSettings(scope, command.payload.expectedRevision, settingsChange(command.payload))
          .catch((error: unknown) => {
            if (error instanceof PairedDeviceError)
              throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, error.code);
            throw error;
          });
        return { resultRef: `perception-settings:${settings.revision}`, replayed: false };
      }
      default:
        throw new Error("PERCEPTION_OPERATION_NOT_INSTALLED");
    }
  }
}
