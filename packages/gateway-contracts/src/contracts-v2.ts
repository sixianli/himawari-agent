import {
  array,
  booleanValue,
  boundedString,
  codePointString,
  ContractValidationError,
  enumeration,
  gmailMessageId,
  type InferSchema,
  integer,
  literal,
  machineString,
  modelRefString,
  nullable,
  object,
  parseJson,
  proactiveSourceName,
  type Schema,
  timestamp,
} from "./validation.js";

export const MEMORY_SOURCE_REF_MAX_LENGTH = 512;
export const GATEWAY_V2_SCHEMA_VERSION = "gateway.v2" as const;
export const GATEWAY_V2_MESSAGE_TYPES = [
  "thread.message.submit",
  "approval.respond",
  "search.authorization.set",
  "search.authorization.read",
  "search.authorization.snapshot",
  "push.subscription.set",
  "push.kind.set",
  "push.test",
  "presence.heartbeat",
  "push.feedback.record",
  "push.status.read",
  "push.status.snapshot",
  "proactive.overview.read",
  "proactive.overview.snapshot",
  "proactive.settings.set",
  "proactive.pause",
  "proactive.insight.respond",
  "proactive.decision.rate",
  "proactive.audit.respond",
  "proactive.review.read",
  "proactive.review.snapshot",
  "proactive.review.rate",
  "proactive.review.checkup",
  "proactive.source.manage",
  "proactive.backoff.restore",
  "proactive.sources.read",
  "proactive.sources.snapshot",
  "proactive.source.settings.set",
  "proactive.source.switch_off",
  "muse.overview.read",
  "muse.overview.snapshot",
  "muse.item.rate",
  "muse.intake.set",
  "muse.data.clear",
  "proactive.weekly.read",
  "proactive.weekly.snapshot",
  "proactive.observation.start",
  "proactive.gapcase.mark",
  "owner.preferences.read",
  "owner.preferences.snapshot",
  "owner.preferences.set",
  "delivery_timing.settings.read",
  "delivery_timing.settings.snapshot",
  "delivery_timing.settings.change",
  "quiet_hours.read",
  "quiet_hours.snapshot",
  "quiet_hours.set",
  "proposals.read",
  "proposals.snapshot",
  "proposal.respond",
  "sensitive.interceptions.read",
  "sensitive.interceptions.snapshot",
  "sensitive.interceptions.clear",
  "memory.overview.read",
  "memory.overview.snapshot",
  "memory.basis.read",
  "memory.basis.snapshot",
  "memory.classify.read",
  "memory.classify.snapshot",
  "memory.import.duplicates.read",
  "memory.import.duplicates.snapshot",
  "decision.chain.read",
  "decision.chain.snapshot",
  "decision.email.read",
  "decision.email.snapshot",
  "memory.approval.respond",
  "memory.tidy.undo",
  "memory.conversationReview.undo",
  "memory.reminder.respond",
  "memory.reminder.create",
  "memory.rules.read",
  "memory.rules.snapshot",
  "memory.rule.respond",
  "memory.review.read",
  "memory.review.snapshot",
  "memory.review.respond",
  "memory.review.reportMissed",
  "memory.create",
  "memory.category.set",
  "memory.settings.set",
  "memory.page.viewed",
  "memory.person.respond",
  "memory.import.commit",
  "memory.import.undo",
  "memory.external.respond",
  "memory.external.undo",
  "memory.mcpSync.projectDecide",
  "memory.mcpSync.noteDecide",
  "memory.mcpSync.attentionResolve",
  "github.monitor.set_state",
  "memory.mutate",
  "grant.revoke",
  "capability.review",
  "capability.install.approve",
  "capability.update.respond",
  "capability.disable",
  "capability.rollback",
  "capability.reactivate",
  "host.file.prepare",
  "host.file.execute",
  "workspace.copy.create",
  "workspace.copy.prepare",
  "workspace.copy.select",
  "workspace.stage",
  "workspace.commit",
  "suggestion.respond",
  "reflection.configure",
  "improvement.review",
  "thread.list",
  "approval.list",
  "approval.detail",
  "capability.list",
  "capability.detail",
  "grant.list",
  "grant.detail",
  "host.directory.detail",
  "workspace.detail",
  "workspace.list",
  "suggestion.list",
  "suggestion.detail",
  "reflection.detail",
  "delegation.detail",
  "delegation.list",
  "improvement.list",
  "improvement.detail",
  "collection.snapshot",
  "approval.snapshot",
  "capability.snapshot",
  "grant.snapshot",
  "host.directory.snapshot",
  "workspace.snapshot",
  "suggestion.snapshot",
  "reflection.snapshot",
  "delegation.snapshot",
  "improvement.snapshot",
  "device.list.read",
  "device.list.snapshot",
  "device.pairing.start",
  "device.pairing.confirm",
  "device.rename",
  "device.revoke",
  "perception.status.read",
  "perception.status.snapshot",
  "perception.day.read",
  "perception.day.snapshot",
  "perception.episode.read",
  "perception.episode.snapshot",
  "perception.usage.read",
  "perception.usage.snapshot",
  "perception.settings.change",
  "think.settings.read",
  "think.settings.snapshot",
  "think.settings.change",
  "server.status.read",
  "server.status.snapshot",
  "home.read",
  "home.snapshot",
  "search.ask.read",
  "search.ask.snapshot",
  "data.export.start",
  "data.export.cancel",
  "data.export.status.read",
  "data.export.status.snapshot",
  "files.list.read",
  "files.list.snapshot",
  "login.devices.read",
  "login.devices.snapshot",
  "login.device.revoke",
  "mcp.connections.read",
  "mcp.connections.snapshot",
  "mcp.connection.create",
  "mcp.connection.change",
  "mcp.connection.rotate",
  "login.devices.revoke_others",
  "stream.event",
] as const;

export type GatewayV2MessageType = (typeof GATEWAY_V2_MESSAGE_TYPES)[number];

const classificationSchema = enumeration(["public", "private", "sensitive", "restricted"]);
const riskSchema = enumeration(["low", "medium", "high", "critical"]);
const actorSchema = object({
  actorType: enumeration(["owner", "client", "scheduler", "external_adapter", "system"]),
  actorId: machineString,
});
const scopeSchema = object({ ownerId: machineString, agentId: machineString });
const authoritySchema = object({
  deploymentId: machineString,
  authorityEpoch: integer(1),
  fencingToken: integer(1),
});

function envelope<const TKind extends string, const TType extends string>(
  kind: TKind,
  type: TType,
) {
  return {
    schemaVersion: literal(GATEWAY_V2_SCHEMA_VERSION),
    kind: literal(kind),
    type: literal(type),
    messageId: machineString,
    correlationId: machineString,
    causationId: nullable(machineString),
    dataClassification: classificationSchema,
    risk: riskSchema,
    authorizationRef: nullable(machineString),
    scope: scopeSchema,
    authority: authoritySchema,
    actor: actorSchema,
  } as const;
}

function commandEnvelope<const TType extends string>(type: TType) {
  return { ...envelope("command", type), idempotencyKey: machineString } as const;
}

export const submitThreadMessageCommandSchema = object({
  ...commandEnvelope("thread.message.submit"),
  payload: object({
    threadId: machineString,
    messageId: machineString,
    contentRef: machineString,
    clientCreatedAt: timestamp,
  }),
});

export const respondApprovalV2CommandSchema = object({
  ...commandEnvelope("approval.respond"),
  payload: object({
    approvalRequestId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["approved", "denied"]),
    semanticSnapshotHash: machineString,
    editedPayloadRef: nullable(machineString),
    recentAuthenticationRef: nullable(machineString),
  }),
});

const searchRecipientsSchema: Schema<readonly string[]> = {
  parse(input, path = "$") {
    const recipients = array(boundedString(512)).parse(input, path);
    if (
      recipients.length > 8 ||
      new Set(recipients).size !== recipients.length ||
      recipients.some((value) => !/^https:\/\/[a-z0-9.-]+$/.test(value))
    )
      throw new ContractValidationError(path, "expected distinct https origins");
    return recipients;
  },
};
const searchAuthorizationCommandSchema = object({
  ...commandEnvelope("search.authorization.set"),
  payload: object({
    expectedRevision: integer(0),
    enabled: booleanValue,
    recipients: searchRecipientsSchema,
  }),
});
const searchAuthorizationQuerySchema = object({
  ...envelope("query", "search.authorization.read"),
  payload: object({}),
});
const searchAuthorizationSnapshotSchema = object({
  ...envelope("snapshot", "search.authorization.snapshot"),
  payload: object({
    revision: integer(0),
    enabled: booleanValue,
    providersChanged: booleanValue,
    available: booleanValue,
    recipients: searchRecipientsSchema,
    generatedAt: timestamp,
  }),
});

const pushEndpointSchema: Schema<string> = {
  parse(input, path = "$") {
    const value = boundedString(2048).parse(input, path);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ContractValidationError(path, "expected an https push endpoint");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new ContractValidationError(path, "expected an https push endpoint");
    return value;
  },
};
const pushKeySchema: Schema<string> = {
  parse(input, path = "$") {
    const value = boundedString(256).parse(input, path);
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value))
      throw new ContractValidationError(path, "expected a base64url key");
    return value;
  },
};
const pushLocaleSchema = enumeration(["zh-CN", "en", "ja"]);
const pushKindSchema = enumeration(["reminder", "approval", "run"]);
const pushSubscriptionCommandSchema = object({
  ...commandEnvelope("push.subscription.set"),
  payload: object({
    action: enumeration(["subscribe", "unsubscribe"]),
    subscriptionId: nullable(machineString),
    endpoint: nullable(pushEndpointSchema),
    keys: nullable(object({ p256dh: pushKeySchema, auth: pushKeySchema })),
    locale: nullable(pushLocaleSchema),
    deviceLabel: nullable(boundedString(64)),
    kinds: nullable(array(pushKindSchema)),
  }),
});
const pushKindCommandSchema = object({
  ...commandEnvelope("push.kind.set"),
  payload: object({ kind: pushKindSchema, enabled: booleanValue }),
});
const pushTestCommandSchema = object({
  ...commandEnvelope("push.test"),
  payload: object({ subscriptionId: machineString }),
});
const presenceHeartbeatCommandSchema = object({
  ...commandEnvelope("presence.heartbeat"),
  payload: object({ clientId: machineString, visible: booleanValue }),
});
const pushFeedbackEventSchema = object({
  tag: pushKeySchema,
  reaction: enumeration(["opened", "dismissed"]),
  occurredAt: timestamp,
});
const pushFeedbackEventsSchema: Schema<readonly InferSchema<typeof pushFeedbackEventSchema>[]> = {
  parse(input, path = "$") {
    const events = array(pushFeedbackEventSchema).parse(input, path);
    if (events.length < 1 || events.length > 50)
      throw new ContractValidationError(path, "expected 1 to 50 feedback events");
    return events;
  },
};
const pushFeedbackCommandSchema = object({
  ...commandEnvelope("push.feedback.record"),
  payload: object({ events: pushFeedbackEventsSchema }),
});
const pushStatusQuerySchema = object({
  ...envelope("query", "push.status.read"),
  payload: object({}),
});
const pushStatusSnapshotSchema = object({
  ...envelope("snapshot", "push.status.snapshot"),
  payload: object({
    available: booleanValue,
    publicKey: nullable(pushKeySchema),
    kinds: array(pushKindSchema),
    subscriptions: array(
      object({
        subscriptionId: machineString,
        deviceLabel: boundedString(64),
        endpointHost: boundedString(256),
        locale: pushLocaleSchema,
        kinds: array(pushKindSchema),
        state: enumeration(["active", "paused"]),
        failureCode: nullable(machineString),
        createdAt: timestamp,
        lastDeliveredAt: nullable(timestamp),
      }),
    ),
    generatedAt: timestamp,
  }),
});

const proactiveTextSchema = (maximum: number): Schema<string> => ({
  parse(input, path = "$") {
    if (input === "") return "";
    return boundedString(maximum).parse(input, path);
  },
});
const proactiveClockSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input))
      throw new ContractValidationError(path, "expected an HH:MM clock time");
    return input;
  },
};
const proactiveDaysSchema: Schema<readonly number[]> = {
  parse(input, path = "$") {
    const days = array(integer(0, 6)).parse(input, path);
    if (days.length < 1 || new Set(days).size !== days.length)
      throw new ContractValidationError(path, "expected distinct weekdays");
    return days;
  },
};
const proactiveQuietPeriodSchema = object({
  days: proactiveDaysSchema,
  start: proactiveClockSchema,
  end: proactiveClockSchema,
});
const proactiveQuietHoursSchema: Schema<readonly InferSchema<typeof proactiveQuietPeriodSchema>[]> =
  {
    parse(input, path = "$") {
      const periods = array(proactiveQuietPeriodSchema).parse(input, path);
      if (periods.length > 8) throw new ContractValidationError(path, "expected at most 8 periods");
      if (periods.some(({ start, end }) => start === end))
        throw new ContractValidationError(path, "expected a period with different start and end");
      return periods;
    },
  };
const proactiveSendersSchema: Schema<readonly string[]> = {
  parse(input, path = "$") {
    const senders = array(boundedString(320)).parse(input, path);
    if (
      senders.length > 200 ||
      senders.some(
        (sender) =>
          sender.length > 254 ||
          /\p{Surrogate}/u.test(sender) ||
          !/^@?[^\s@]*@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(sender),
      )
    )
      throw new ContractValidationError(path, "expected at most 200 addresses or domains");
    return senders;
  },
};
const proactiveRatingSchema = enumeration(["useful", "unneeded", "missed"]);
const proactiveCountsSchema = object({
  fetched: integer(0),
  skipped: integer(0),
  judged: integer(0),
  act: integer(0),
  know: integer(0),
  check: integer(0),
  ignore: integer(0),
  floorRaised: integer(0),
  pushed: integer(0),
});
const proactiveOverviewQuerySchema = object({
  ...envelope("query", "proactive.overview.read"),
  payload: object({}),
});
const proactiveOverviewSnapshotSchema = object({
  ...envelope("snapshot", "proactive.overview.snapshot"),
  payload: object({
    source: proactiveSourceName,
    connection: object({
      status: enumeration(["disconnected", "connected", "needs_reconnect"]),
      account: nullable(boundedString(320)),
      connectedAt: nullable(timestamp),
    }),
    enabled: booleanValue,
    quietHours: proactiveQuietHoursSchema,
    importantSenders: proactiveSendersSchema,
    dailyLimitReached: booleanValue,
    backoff: array(
      object({
        classKey: boundedString(128),
        domain: boundedString(128),
        stage: integer(1, 2),
        ignoredCount: integer(0),
        changedAt: timestamp,
      }),
    ),
    insights: array(
      object({
        id: machineString,
        result: enumeration(["act", "know", "check"]),
        floorRaised: booleanValue,
        summary: proactiveTextSchema(500),
        reason: proactiveTextSchema(500),
        basis: enumeration(["model", "daily_limit"]),
        from: proactiveTextSchema(320),
        subject: proactiveTextSchema(500),
        link: proactiveTextSchema(512),
        dueAt: nullable(timestamp),
        priority: nullable(enumeration(["high", "medium", "low"])),
        status: enumeration(["open", "replied", "done", "muted"]),
        pushed: booleanValue,
        pushReaction: nullable(enumeration(["opened", "dismissed"])),
        rating: nullable(proactiveRatingSchema),
        updatedAt: timestamp,
      }),
    ),
    audit: object({
      active: booleanValue,
      since: timestamp,
      items: array(
        object({
          messageId: machineString,
          from: proactiveTextSchema(320),
          subject: proactiveTextSchema(500),
          link: proactiveTextSchema(512),
          rating: nullable(proactiveRatingSchema),
        }),
      ),
      pending: integer(0),
    }),
    decisions: array(
      object({
        id: machineString,
        checkedAt: timestamp,
        verdict: enumeration([
          "pushed",
          "silent",
          "deferred",
          "failed",
          "capped",
          "capped_daily",
          "needs_owner",
        ]),
        reasonCode: machineString,
        counts: proactiveCountsSchema,
        opened: booleanValue,
        rating: nullable(proactiveRatingSchema),
      }),
    ),
    metrics: object({
      spoke: integer(0),
      hits: integer(0),
      misfires: integer(0),
      missed: integer(0),
      reviewed: integer(0),
    }),
    generatedAt: timestamp,
  }),
});
const ownerPreferencesSchema = {
  name: nullable(boundedString(40)),
  locale: nullable(enumeration(["zh-CN", "en", "ja"])),
  accent: nullable(enumeration(["violet", "blue", "teal", "amber", "rose", "graphite"])),
  theme: nullable(enumeration(["light", "dark", "system"])),
  modelRef: nullable(modelRefString),
  thinkingLevel: nullable(enumeration(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
};
const ownerPreferencesQuerySchema = object({
  ...envelope("query", "owner.preferences.read"),
  payload: object({}),
});
const ownerPreferencesSnapshotSchema = object({
  ...envelope("snapshot", "owner.preferences.snapshot"),
  payload: object({
    ...ownerPreferencesSchema,
    revision: integer(0),
    updatedAt: nullable(timestamp),
  }),
});
const ownerPreferencesSetCommandSchema = object({
  ...commandEnvelope("owner.preferences.set"),
  payload: object({ ...ownerPreferencesSchema, expectedRevision: integer(0) }),
});
const deliveryTimingSettingsQuerySchema = object({
  ...envelope("query", "delivery_timing.settings.read"),
  payload: object({ locale: enumeration(["zh-CN", "en", "ja"]) }),
});
const settingValueKindSchema = enumeration(["ratio", "duration", "count"]);
const settingStorageUnitSchema = enumeration(["permille", "ms", "s", "min", "h", "d", "count"]);
const deliveryTimingSettingsSnapshotSchema = object({
  ...envelope("snapshot", "delivery_timing.settings.snapshot"),
  payload: object({
    items: array(
      object({
        key: machineString,
        label: boundedString(80),
        description: boundedString(240),
        unit: boundedString(16),
        kind: settingValueKindSchema,
        storageUnit: settingStorageUnitSchema,
        value: integer(0),
        defaultValue: integer(0),
        minimum: integer(0),
        maximum: integer(0),
        overridden: booleanValue,
      }),
    ),
    revision: integer(0),
    generatedAt: timestamp,
  }),
});
const deliveryTimingSettingsChangeCommandSchema = object({
  ...commandEnvelope("delivery_timing.settings.change"),
  payload: object({
    expectedRevision: integer(0),
    key: machineString,
    value: nullable(integer(0)),
  }),
});
const quietClock = proactiveClockSchema;
const quietHoursQuerySchema = object({
  ...envelope("query", "quiet_hours.read"),
  payload: object({}),
});
const quietHoursSnapshotSchema = object({
  ...envelope("snapshot", "quiet_hours.snapshot"),
  payload: object({
    version: boundedString(64),
    editable: booleanValue,
    enabled: booleanValue,
    start: nullable(quietClock),
    end: nullable(quietClock),
    classes: array(machineString),
    rules: array(object({ ruleId: boundedString(64), summary: boundedString(2000) })),
  }),
});
const quietHoursSetCommandSchema = object({
  ...commandEnvelope("quiet_hours.set"),
  payload: object({
    expectedVersion: boundedString(64),
    enabled: booleanValue,
    start: quietClock,
    end: quietClock,
  }),
});
export const DEVICE_KINDS = ["iphone", "watch", "mac"] as const;
export const DEVICE_STATUSES = ["pending", "active", "revoked"] as const;
export const DEVICE_LIMIT_KEYS = [
  "device.request.body_bytes",
  "device.upload.file_bytes",
  "device.upload.expanded_bytes",
  "device.perception.batch_records",
  "device.mirror.batch_items",
  "device.track.batch_points",
  "device.prefetch.cache.entries",
  "device.prefetch.cache.bytes",
  "perception.extract.max_chars",
  "device.nonce.retained",
] as const;
export const DEVICE_RELEASE_CHANNELS = ["direct", "testflight", "app_store", "mac_direct"] as const;
export const DEVICE_NAME_MAX_LENGTH = 64;
const deviceIdSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^dev_[A-Za-z0-9_-]{22}$/u.test(input))
      throw new ContractValidationError(path, "expected a device id");
    return input;
  },
};
const devicePairingCodeSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^[A-Za-z0-9_-]{21}[AQgw]$/u.test(input))
      throw new ContractValidationError(
        path,
        "expected the canonical unpadded base64url encoding of 16 bytes",
      );
    return input;
  },
};
const devicePairingNumberSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^[0-9]{6}$/u.test(input))
      throw new ContractValidationError(path, "expected a 6 digit pairing number");
    return input;
  },
};
function isHiddenNameCharacter(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}
const HIDDEN_NAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const deviceNameSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string")
      throw new ContractValidationError(path, "expected a device name");
    const trimmed = input.trim();
    const characters = [...trimmed];
    if (
      characters.length < 1 ||
      characters.length > DEVICE_NAME_MAX_LENGTH ||
      HIDDEN_NAME_CHARACTER.test(trimmed)
    )
      throw new ContractValidationError(
        path,
        `expected a 1-${DEVICE_NAME_MAX_LENGTH} character device name`,
      );
    return trimmed;
  },
};
export function normalizeDeviceName(input: unknown): string | null {
  try {
    return deviceNameSchema.parse(input);
  } catch {
    return null;
  }
}
const accessText = boundedString(256);
export function isDeviceAccessText(input: unknown): boolean {
  try {
    accessText.parse(input);
    return true;
  } catch {
    return false;
  }
}
const deviceAccessSchema = object({
  clientId: accessText,
  clientSecret: accessText,
});
const deviceListQuerySchema = object({
  ...envelope("query", "device.list.read"),
  payload: object({}),
});
const deviceListSnapshotSchema = object({
  ...envelope("snapshot", "device.list.snapshot"),
  payload: object({
    devices: array(
      object({
        id: deviceIdSchema,
        revision: integer(0),
        kind: enumeration(DEVICE_KINDS),
        name: deviceNameSchema,
        releaseChannel: enumeration(DEVICE_RELEASE_CHANNELS),
        status: enumeration(DEVICE_STATUSES),
        pairedAt: timestamp,
        lastSeenAt: nullable(timestamp),
        pairingNumber: nullable(devicePairingNumberSchema),
      }),
    ),
    limits: array(
      object({
        key: enumeration(DEVICE_LIMIT_KEYS),
        unit: boundedString(32),
        value: integer(0),
      }),
    ),
    pairing: nullable(
      object({
        expiresAt: timestamp,
        access: nullable(deviceAccessSchema),
      }),
    ),
    generatedAt: timestamp,
  }),
});
const devicePairingStartCommandSchema = object({
  ...commandEnvelope("device.pairing.start"),
  payload: object({ pairingCode: devicePairingCodeSchema }),
});
const deviceRevisionTargetShape = {
  deviceId: deviceIdSchema,
  expectedRevision: integer(0),
};
const devicePairingConfirmCommandSchema = object({
  ...commandEnvelope("device.pairing.confirm"),
  payload: object(deviceRevisionTargetShape),
});
const deviceRevokeCommandSchema = object({
  ...commandEnvelope("device.revoke"),
  payload: object(deviceRevisionTargetShape),
});
const deviceRenameCommandSchema = object({
  ...commandEnvelope("device.rename"),
  payload: object({ ...deviceRevisionTargetShape, name: deviceNameSchema }),
});
export const PERCEPTION_STATES = ["sensing", "paused", "off"] as const;
export const PERCEPTION_SETTINGS_CHANGE_KINDS = [
  "sense",
  "pause",
  "resume",
  "retention",
  "limit",
] as const;
export const PERCEPTION_ROW_KINDS = ["episode", "record"] as const;
export const PERCEPTION_SUMMARY_SOURCES = ["recorded", "model", "none"] as const;
export const USAGE_LIMIT_STATES = ["ok", "near", "stopped"] as const;
const perceptionDaySchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input))
      throw new ContractValidationError(path, "expected a calendar day");
    return input;
  },
};
const perceptionCursorSchema = boundedString(256);
const perceptionRecordViewSchema = object({
  id: machineString,
  type: machineString,
  sense: machineString,
  origin: machineString,
  captureSource: machineString,
  occurredAt: timestamp,
  deviceId: machineString,
  speakerKind: nullable(machineString),
  text: nullable(boundedString(32 * 1024)),
  textTruncated: booleanValue,
  evidence: array(object({ name: machineString, value: boundedString(512) })),
});
const perceptionEpisodeViewSchema = object({
  id: machineString,
  startedAt: timestamp,
  endedAt: timestamp,
  recordCount: integer(0),
  senses: array(machineString),
  types: array(machineString),
  deviceIds: array(machineString),
  preview: nullable(boundedString(32 * 1024)),
  previewTruncated: booleanValue,
  summary: nullable(boundedString(2048)),
  summarySource: enumeration(PERCEPTION_SUMMARY_SOURCES),
});
const perceptionStatusQuerySchema = object({
  ...envelope("query", "perception.status.read"),
  payload: object({}),
});
const perceptionStatusSnapshotSchema = object({
  ...envelope("snapshot", "perception.status.snapshot"),
  payload: object({
    state: enumeration(PERCEPTION_STATES),
    pausedUntil: nullable(timestamp),
    senses: array(machineString),
    day: perceptionDaySchema,
    todayCount: integer(0),
    availableSenses: array(machineString),
    retention: array(
      object({
        key: machineString,
        days: integer(1),
        defaultDays: integer(1),
        minDays: integer(1),
        maxDays: integer(1),
      }),
    ),
    pauseMaximumSeconds: integer(1),
    revision: integer(0),
    generatedAt: timestamp,
  }),
});
const perceptionDayQuerySchema = object({
  ...envelope("query", "perception.day.read"),
  payload: object({
    day: nullable(perceptionDaySchema),
    sense: nullable(machineString),
    types: nullable(array(machineString)),
    cursor: nullable(perceptionCursorSchema),
  }),
});
const perceptionDaySnapshotSchema = object({
  ...envelope("snapshot", "perception.day.snapshot"),
  payload: object({
    day: perceptionDaySchema,
    total: integer(0),
    senseCounts: array(object({ sense: machineString, count: integer(0) })),
    rows: array(
      object({
        kind: enumeration(PERCEPTION_ROW_KINDS),
        at: timestamp,
        episode: nullable(perceptionEpisodeViewSchema),
        record: nullable(perceptionRecordViewSchema),
      }),
    ),
    nextCursor: nullable(perceptionCursorSchema),
    generatedAt: timestamp,
  }),
});
const perceptionEpisodeQuerySchema = object({
  ...envelope("query", "perception.episode.read"),
  payload: object({ episodeId: machineString, cursor: nullable(perceptionCursorSchema) }),
});
const perceptionEpisodeSnapshotSchema = object({
  ...envelope("snapshot", "perception.episode.snapshot"),
  payload: object({
    episode: nullable(perceptionEpisodeViewSchema),
    records: array(perceptionRecordViewSchema),
    nextCursor: nullable(perceptionCursorSchema),
    generatedAt: timestamp,
  }),
});
const perceptionUsageQuerySchema = object({
  ...envelope("query", "perception.usage.read"),
  payload: object({}),
});
const perceptionUsageSnapshotSchema = object({
  ...envelope("snapshot", "perception.usage.snapshot"),
  payload: object({
    day: perceptionDaySchema,
    resetsAt: timestamp,
    warnPermille: integer(1, 999),
    limits: array(
      object({
        key: machineString,
        unit: machineString,
        limit: nullable(integer(0)),
        defaultLimit: nullable(integer(0)),
        minimum: integer(0),
        maximum: integer(0),
        adjustable: booleanValue,
        used: integer(0),
        devices: array(object({ deviceId: machineString, used: integer(0) })),
        resetsAt: timestamp,
        onReach: machineString,
        state: enumeration(USAGE_LIMIT_STATES),
      }),
    ),
    revision: integer(0),
    generatedAt: timestamp,
  }),
});
const perceptionSettingsChangeCommandSchema = object({
  ...commandEnvelope("perception.settings.change"),
  payload: object({
    expectedRevision: integer(0),
    kind: enumeration(PERCEPTION_SETTINGS_CHANGE_KINDS),
    sense: nullable(machineString),
    enabled: nullable(booleanValue),
    until: nullable(timestamp),
    key: nullable(machineString),
    value: nullable(integer(0)),
  }),
});
const thinkSettingsQuerySchema = object({
  ...envelope("query", "think.settings.read"),
  payload: object({}),
});
const thinkSettingTextSchema = object({
  "zh-CN": boundedString(400),
  en: boundedString(400),
  ja: boundedString(400),
});
const thinkSettingsSnapshotSchema = object({
  ...envelope("snapshot", "think.settings.snapshot"),
  payload: object({
    revision: integer(0),
    enabled: booleanValue,
    items: array(
      object({
        key: machineString,
        value: integer(0),
        defaultValue: integer(0),
        minimum: integer(0),
        maximum: integer(0),
        unit: machineString,
        kind: settingValueKindSchema,
        storageUnit: settingStorageUnitSchema,
        overridden: booleanValue,
        label: thinkSettingTextSchema,
        description: thinkSettingTextSchema,
        unitLabel: thinkSettingTextSchema,
      }),
    ),
    generatedAt: timestamp,
  }),
});
const thinkSettingsChangeCommandSchema = object({
  ...commandEnvelope("think.settings.change"),
  payload: object({
    expectedRevision: integer(0),
    key: machineString,
    value: nullable(integer(0)),
  }),
});
export const SERVER_STATUS_OVERALL = ["healthy", "degraded", "not_ready", "not_live"] as const;
export const SERVER_STATUS_DEPENDENCY = ["healthy", "degraded", "blocked", "unavailable"] as const;
export const HOME_KEY_MAXIMUM = 160;
export const HOME_BINDING_MAXIMUM = 2048;
export const HOME_ITEM_KINDS = [
  "heads_up",
  "approval",
  "memory_confirm",
  "done",
  "running",
  "problem",
] as const;
export const HOME_SENTENCE_BASES = ["recorded", "catalog", "model", "none"] as const;
export const HOME_RANKS = ["rule", "deadline", "unscored", "model", "recency"] as const;
export const HOME_TARGET_TYPES = [
  "mail",
  "memory",
  "thread",
  "approval",
  "memory_request",
  "external_proposal",
  "rule",
  "connection",
] as const;
export const HOME_ORIGIN_TYPES = [
  "mail",
  "memory",
  "conversation",
  "agent",
  "rule",
  "connection",
] as const;
export const HOME_SOURCE_NAMES = [
  "mail",
  "reminders",
  "approvals",
  "memory_requests",
  "external_proposals",
  "rules",
  "done",
  "runs",
  "upcoming",
] as const;
export const HOME_LOCALES = ["zh-CN", "en", "ja"] as const;
export const HOME_ACTIONS = [
  "done",
  "mute",
  "dismiss",
  "snooze",
  "cancel",
  "approved",
  "denied",
  "rejected",
  "keep",
  "reject",
  "reconfirm",
  "undo",
  "reconnect",
] as const;
export const HOME_LABEL_BASES = ["catalog", "model"] as const;
export const HOME_POLARITIES = ["positive", "negative", "neutral"] as const;
const homeQuerySchema = object({
  ...envelope("query", "home.read"),
  payload: object({ locale: enumeration(HOME_LOCALES) }),
});
const homeSnapshotSchema = object({
  ...envelope("snapshot", "home.snapshot"),
  payload: object({
    items: array(
      object({
        key: boundedString(HOME_KEY_MAXIMUM),
        kind: enumeration(HOME_ITEM_KINDS),
        awaitsOwner: booleanValue,
        sentence: nullable(boundedString(2000)),
        sentenceBasis: enumeration(HOME_SENTENCE_BASES),
        target: object({
          type: enumeration(HOME_TARGET_TYPES),
          id: nullable(machineString),
          threadId: nullable(machineString),
          link: nullable(boundedString(512)),
        }),
        source: object({
          type: enumeration(HOME_ORIGIN_TYPES),
          from: nullable(boundedString(320)),
          label: nullable(boundedString(500)),
          threadId: nullable(machineString),
          decisionId: nullable(machineString),
          at: timestamp,
        }),
        deadline: nullable(timestamp),
        createdAt: timestamp,
        actions: array(
          object({
            action: enumeration(HOME_ACTIONS),
            label: boundedString(64),
            labelBasis: enumeration(HOME_LABEL_BASES),
            polarity: enumeration(HOME_POLARITIES),
            ownerPresence: booleanValue,
            reviewLabel: nullable(boundedString(64)),
            binding: nullable(boundedString(HOME_BINDING_MAXIMUM)),
          }),
        ),
        rank: enumeration(HOME_RANKS),
        dataClassification: classificationSchema,
      }),
    ),
    awaitingCount: integer(0),
    awaitingTruncated: booleanValue,
    incompleteSources: array(enumeration(HOME_SOURCE_NAMES)),
    upcoming: array(
      object({
        reminderId: machineString,
        memoryId: machineString,
        text: boundedString(2000),
        dueAt: timestamp,
        repeat: enumeration(["none", "yearly"]),
        sourceThreadId: nullable(machineString),
        dataClassification: classificationSchema,
      }),
    ),
    revision: machineString,
    generatedAt: timestamp,
  }),
});
export const SEARCH_ASK_STATES = ["answered", "not_found", "suggestions"] as const;
export const SEARCH_BASIS_KINDS = ["memory", "conversation", "perception"] as const;
const searchAskQuerySchema = object({
  ...envelope("query", "search.ask.read"),
  payload: object({ query: nullable(boundedString(500)), locale: enumeration(HOME_LOCALES) }),
});
const searchAskSnapshotSchema = object({
  ...envelope("snapshot", "search.ask.snapshot"),
  payload: object({
    state: enumeration(SEARCH_ASK_STATES),
    query: nullable(boundedString(500)),
    answer: nullable(boundedString(2000)),
    notFoundText: nullable(boundedString(200)),
    basis: array(
      object({
        kind: enumeration(SEARCH_BASIS_KINDS),
        label: boundedString(200),
        recordId: nullable(machineString),
        memoryId: nullable(machineString),
        threadId: nullable(machineString),
        at: timestamp,
      }),
    ),
    asks: array(boundedString(500)),
    generatedAt: timestamp,
  }),
});
const serverStatusQuerySchema = object({
  ...envelope("query", "server.status.read"),
  payload: object({}),
});
const serverStatusSnapshotSchema = object({
  ...envelope("snapshot", "server.status.snapshot"),
  payload: object({
    live: booleanValue,
    ready: booleanValue,
    status: enumeration(SERVER_STATUS_OVERALL),
    dependencies: array(
      object({
        name: machineString,
        required: booleanValue,
        status: enumeration(SERVER_STATUS_DEPENDENCY),
        reasonCode: nullable(machineString),
      }),
    ),
    generatedAt: timestamp,
  }),
});
export const DATA_EXPORT_STATES = ["running", "ready", "failed", "cancelled", "expired"] as const;
const patternString = (pattern: RegExp, expected: string): Schema<string> => ({
  parse(input, path = "$") {
    if (typeof input !== "string" || !pattern.test(input))
      throw new ContractValidationError(path, expected);
    return input;
  },
});
export const DATA_EXPORT_ID_PATTERN = /^data-export:[A-Za-z0-9_-]{22}$/u;
const dataExportIdSchema = patternString(DATA_EXPORT_ID_PATTERN, "expected a data export id");
const dataExportStartCommandSchema = object({
  ...commandEnvelope("data.export.start"),
  payload: object({}),
});
const dataExportCancelCommandSchema = object({
  ...commandEnvelope("data.export.cancel"),
  payload: object({ exportId: dataExportIdSchema }),
});
const dataExportStatusQuerySchema = object({
  ...envelope("query", "data.export.status.read"),
  payload: object({ exportId: dataExportIdSchema }),
});
const dataExportStatusSnapshotObjectSchema = object({
  ...envelope("snapshot", "data.export.status.snapshot"),
  payload: object({
    exportId: dataExportIdSchema,
    state: enumeration(DATA_EXPORT_STATES),
    startedAt: nullable(timestamp),
    finishedAt: nullable(timestamp),
    failureCode: nullable(machineString),
    progress: nullable(
      object({
        textsRead: integer(0),
        textsTotal: integer(0),
      }),
    ),
    result: nullable(
      object({
        downloadPath: boundedString(256),
        fileName: boundedString(128),
        sizeBytes: integer(1),
        sha256: patternString(/^[0-9a-f]{64}$/u, "expected a SHA-256 hex digest"),
        memories: integer(0),
        rules: integer(0),
        withheld: integer(0),
        expiresAt: timestamp,
      }),
    ),
    generatedAt: timestamp,
  }),
});
const dataExportStatusSnapshotSchema: Schema<
  ReturnType<typeof dataExportStatusSnapshotObjectSchema.parse>
> = {
  parse(input, path = "$") {
    const snapshot = dataExportStatusSnapshotObjectSchema.parse(input, path);
    const progress = snapshot.payload.progress;
    if (progress) {
      if (snapshot.payload.state !== "running")
        throw new ContractValidationError(
          `${path}.payload.progress`,
          "expected progress only while the export is running",
        );
      if (progress.textsRead > progress.textsTotal)
        throw new ContractValidationError(
          `${path}.payload.progress.textsRead`,
          "expected texts read to be at most the total",
        );
    }
    const result = snapshot.payload.result;
    if (result) {
      const url = new URL(result.downloadPath, "http://localhost");
      if (
        !result.downloadPath.startsWith("/api/data-export/v1/archive?") ||
        url.origin !== "http://localhost" ||
        url.hash !== "" ||
        url.searchParams.getAll("exportId").join("\n") !== snapshot.payload.exportId
      )
        throw new ContractValidationError(
          `${path}.payload.result.downloadPath`,
          "expected the download path of this export",
        );
    }
    return snapshot;
  },
};
export const FILE_LIST_KINDS = [
  "document",
  "code",
  "web",
  "image",
  "pdf",
  "data",
  "other",
] as const;
export const FILE_LIST_ORIGINS = ["uploaded", "generated"] as const;
export const FILE_LIST_PAGE_LIMIT = 100;
const fileListCursorSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(input))
      throw new ContractValidationError(path, "expected a file list cursor");
    return input;
  },
};
const filesListQuerySchema = object({
  ...envelope("query", "files.list.read"),
  payload: object({
    kind: nullable(enumeration(FILE_LIST_KINDS)),
    origin: nullable(enumeration(FILE_LIST_ORIGINS)),
    before: nullable(fileListCursorSchema),
    limit: integer(1, FILE_LIST_PAGE_LIMIT),
  }),
});
const filesListSnapshotSchema = object({
  ...envelope("snapshot", "files.list.snapshot"),
  payload: object({
    files: array(
      object({
        fileId: machineString,
        threadId: machineString,
        threadTitle: nullable(boundedString(256)),
        name: boundedString(256),
        kind: enumeration(FILE_LIST_KINDS),
        origin: enumeration(FILE_LIST_ORIGINS),
        mediaType: boundedString(128),
        sizeBytes: integer(0),
        version: integer(1),
        createdAt: timestamp,
        deleted: booleanValue,
        contentPath: nullable(boundedString(512)),
      }),
    ),
    nextCursor: nullable(fileListCursorSchema),
    generatedAt: timestamp,
  }),
});
const loginDevicesQuerySchema = object({
  ...envelope("query", "login.devices.read"),
  payload: object({}),
});
const loginDevicesSnapshotSchema = object({
  ...envelope("snapshot", "login.devices.snapshot"),
  payload: object({
    devices: array(
      object({
        deviceId: machineString,
        label: boundedString(80),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        current: booleanValue,
      }),
    ),
    generatedAt: timestamp,
  }),
});
export const GATEWAY_ERROR_REASON_CODES = Object.freeze(["LOGIN_DEVICES_STILL_CHANGING"] as const);
export type GatewayErrorReasonCode = (typeof GATEWAY_ERROR_REASON_CODES)[number];
export const isGatewayErrorReasonCode = (value: string): value is GatewayErrorReasonCode =>
  (GATEWAY_ERROR_REASON_CODES as readonly string[]).includes(value);
const loginDevicesRevokeOthersCommandSchema = object({
  ...commandEnvelope("login.devices.revoke_others"),
  payload: object({ recentAuthenticationRef: nullable(machineString) }),
});
const loginDeviceRevokeCommandSchema = object({
  ...commandEnvelope("login.device.revoke"),
  payload: object({
    deviceId: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});
export const MCP_CONNECTION_STATUS_NAMES = ["active", "paused", "revoked"] as const;
export const MCP_CONNECTION_READ_CEILING_NAMES = ["public", "private", "sensitive"] as const;
export const MCP_CONNECTION_PUSH_POLICY_NAMES = ["ask", "direct"] as const;
export const MCP_CONNECTION_CAPABILITY_NAMES = ["command_hooks", "mcp", "scheduled_tasks"] as const;
export const MCP_CONNECTION_LIMIT_KEYS = [
  "mcp.connections",
  "mcp.connection.name_characters",
  "mcp.request.body_bytes",
  "mcp.reads_per_minute",
  "mcp.hook_reads_per_minute",
] as const;
export const MCP_CONNECTION_NAME_CHARACTERS = 64;
const mcpConnectionNameSchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string")
      throw new ContractValidationError(path, "expected a connection name");
    const trimmed = input.trim();
    const characters = [...trimmed];
    if (
      characters.length < 1 ||
      characters.length > MCP_CONNECTION_NAME_CHARACTERS ||
      characters.some((character) => isHiddenNameCharacter(character.codePointAt(0) ?? 0))
    )
      throw new ContractValidationError(
        path,
        `expected a 1-${MCP_CONNECTION_NAME_CHARACTERS} character connection name`,
      );
    return trimmed;
  },
};
const mcpConnectionCapabilitiesSchema: Schema<
  readonly (typeof MCP_CONNECTION_CAPABILITY_NAMES)[number][]
> = {
  parse(input, path = "$") {
    const values = array(enumeration(MCP_CONNECTION_CAPABILITY_NAMES)).parse(input, path);
    if (new Set(values).size !== values.length)
      throw new ContractValidationError(path, "expected each capability once");
    return values;
  },
};
const mcpUsageDaySchema = patternString(/^\d{4}-\d{2}-\d{2}$/u, "expected a YYYY-MM-DD day");
const mcpConnectionUsageSchema = object({
  reads: integer(0),
  readsByTool: array(object({ tool: boundedString(64), calls: integer(0) })),
  delivered: integer(0),
  empty: integer(0),
  autoReads: integer(0),
  autoDelivered: integer(0),
  modelReads: integer(0),
  memoryPushes: integer(0),
  ruleProposals: integer(0),
  ruleProposalsRateLimited: integer(0),
  failed: integer(0),
  rateLimited: integer(0),
});
const mcpConnectionsQuerySchema = object({
  ...envelope("query", "mcp.connections.read"),
  payload: object({}),
});
const mcpConnectionsSnapshotSchema = object({
  ...envelope("snapshot", "mcp.connections.snapshot"),
  payload: object({
    connections: array(
      object({
        id: machineString,
        name: mcpConnectionNameSchema,
        capabilities: mcpConnectionCapabilitiesSchema,
        readCeiling: enumeration(MCP_CONNECTION_READ_CEILING_NAMES),
        pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
        status: enumeration(MCP_CONNECTION_STATUS_NAMES),
        reportedClient: nullable(boundedString(64)),
        createdAt: timestamp,
        updatedAt: timestamp,
        secretRotatedAt: nullable(timestamp),
        lastSeenAt: nullable(timestamp),
        minute: object({ reads: integer(0), hookReads: integer(0) }),
        usage: mcpConnectionUsageSchema,
      }),
    ),
    window: object({ fromDay: mcpUsageDaySchema, toDay: mcpUsageDaySchema, days: integer(1) }),
    limits: array(
      object({
        key: enumeration(MCP_CONNECTION_LIMIT_KEYS),
        value: integer(0),
        used: nullable(integer(0)),
      }),
    ),
    addressPath: boundedString(256),
    generatedAt: timestamp,
  }),
});
const mcpConnectionCreateCommandSchema = object({
  ...commandEnvelope("mcp.connection.create"),
  payload: object({
    name: mcpConnectionNameSchema,
    capabilities: mcpConnectionCapabilitiesSchema,
    readCeiling: enumeration(MCP_CONNECTION_READ_CEILING_NAMES),
    pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
  }),
});
const mcpConnectionChangeCommandSchema = object({
  ...commandEnvelope("mcp.connection.change"),
  payload: object({
    connectionId: machineString,
    name: nullable(mcpConnectionNameSchema),
    capabilities: nullable(mcpConnectionCapabilitiesSchema),
    readCeiling: nullable(enumeration(MCP_CONNECTION_READ_CEILING_NAMES)),
    pushPolicy: nullable(enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES)),
    status: nullable(enumeration(MCP_CONNECTION_STATUS_NAMES)),
  }),
});
const mcpConnectionRotateCommandSchema = object({
  ...commandEnvelope("mcp.connection.rotate"),
  payload: object({ connectionId: machineString }),
});
const proactiveSettingsSetCommandSchema = object({
  ...commandEnvelope("proactive.settings.set"),
  payload: object({
    enabled: booleanValue,
    quietHours: proactiveQuietHoursSchema,
    importantSenders: proactiveSendersSchema,
  }),
});
const proactivePauseCommandSchema = object({
  ...commandEnvelope("proactive.pause"),
  payload: object({}),
});
const proactiveInsightRespondCommandSchema = object({
  ...commandEnvelope("proactive.insight.respond"),
  payload: object({
    insightId: machineString,
    action: enumeration(["done", "mute", "reopen", "rate"]),
    rating: nullable(proactiveRatingSchema),
  }),
});
const proactiveDecisionRateCommandSchema = object({
  ...commandEnvelope("proactive.decision.rate"),
  payload: object({ decisionId: machineString, rating: nullable(proactiveRatingSchema) }),
});
const proactiveMessageIdsSchema: Schema<readonly string[]> = {
  parse(input, path = "$") {
    const ids = array(machineString).parse(input, path);
    if (ids.length < 1 || ids.length > 500)
      throw new ContractValidationError(path, "expected 1 to 500 message ids");
    return ids;
  },
};
const proactiveAuditRespondCommandSchema = object({
  ...commandEnvelope("proactive.audit.respond"),
  payload: object({
    action: enumeration(["review", "rate"]),
    messageIds: proactiveMessageIdsSchema,
    rating: nullable(proactiveRatingSchema),
  }),
});
const proactiveReviewKinds = [
  "proactive",
  "memory_candidate",
  "consolidation",
  "context_truncation",
  "retrieval_degrade",
  "external_read",
  "rule_review",
  "memory_review",
  "mail",
  "checkup",
] as const;
export const MEMORY_CHECKUP_REASONS = [
  "conflict",
  "unused",
  "low_confidence",
  "source_unavailable",
] as const;
export const MEMORY_CHECKUP_ACTIONS = ["confirm", "delete", "merge"] as const;
const proactiveReviewCheckupSchema = object({
  reason: enumeration(MEMORY_CHECKUP_REASONS),
  action: nullable(enumeration(MEMORY_CHECKUP_ACTIONS)),
  memoryId: machineString,
  relatedMemoryId: nullable(machineString),
  relatedText: proactiveTextSchema(200),
  keptMemoryId: nullable(machineString),
});
const proactiveReviewItemSchema = object({
  key: machineString,
  source: enumeration(["ledger", "mail", "checkup"]),
  kind: enumeration(proactiveReviewKinds),
  outcome: machineString,
  decidedAt: timestamp,
  acted: booleanValue,
  rating: nullable(proactiveRatingSchema),
  text: proactiveTextSchema(200),
  textHidden: booleanValue,
  category: nullable(machineString),
  fetched: nullable(integer(0)),
  checkup: nullable(proactiveReviewCheckupSchema),
});
const proactiveReviewQuerySchema = object({
  ...envelope("query", "proactive.review.read"),
  payload: object({}),
});
const proactiveReviewSnapshotSchema = object({
  ...envelope("snapshot", "proactive.review.snapshot"),
  payload: object({
    day: timestamp,
    capacity: integer(1),
    sampled: integer(0),
    notSampled: integer(0),
    hiddenByModel: integer(0),
    items: array(proactiveReviewItemSchema),
    folded: object({ total: integer(0), items: array(proactiveReviewItemSchema) }),
    memoryUnusedDays: integer(1),
    generatedAt: timestamp,
  }),
});
const proactiveReviewRatingsSchema: Schema<
  readonly {
    readonly key: string;
    readonly rating: InferSchema<typeof proactiveRatingSchema> | null;
  }[]
> = {
  parse(input, path = "$") {
    const ratings = array(
      object({ key: machineString, rating: nullable(proactiveRatingSchema) }),
    ).parse(input, path);
    if (ratings.length < 1 || ratings.length > 50)
      throw new ContractValidationError(path, "expected 1 to 50 ratings");
    if (new Set(ratings.map(({ key }) => key)).size !== ratings.length)
      throw new ContractValidationError(path, "expected distinct review keys");
    return ratings;
  },
};
const proactiveReviewRateCommandSchema = object({
  ...commandEnvelope("proactive.review.rate"),
  payload: object({ ratings: proactiveReviewRatingsSchema }),
});
const proactiveReviewCheckupCommandSchema = object({
  ...commandEnvelope("proactive.review.checkup"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = object({
        key: machineString,
        action: enumeration([...MEMORY_CHECKUP_ACTIONS, "undo"]),
        keep: nullable(machineString),
      }).parse(input, path);
      if ((payload.action === "merge") !== (payload.keep !== null))
        throw new ContractValidationError(`${path}.keep`, "must be present only for a merge");
      return payload;
    },
  },
});
const proactiveSourceManageCommandSchema = object({
  ...commandEnvelope("proactive.source.manage"),
  payload: object({
    source: proactiveSourceName,
    action: enumeration(["disconnect", "clear_records"]),
  }),
});
const proactiveBackoffRestoreCommandSchema = object({
  ...commandEnvelope("proactive.backoff.restore"),
  payload: object({ classKey: nullable(boundedString(128)) }),
});
const proactiveSafetyLimitShape = {
  limit: integer(1),
  defaultLimit: integer(1),
  minimum: integer(1),
  maximum: integer(1),
};
const proactiveSourcesQuerySchema = object({
  ...envelope("query", "proactive.sources.read"),
  payload: object({}),
});
const proactiveSourcesSnapshotSchema = object({
  ...envelope("snapshot", "proactive.sources.snapshot"),
  payload: object({
    sources: array(
      object({
        source: proactiveSourceName,
        intake: enumeration(["reader", "written_by_program"]),
        trust: enumeration(["owner", "external"]),
        enabled: booleanValue,
        perDay: object({
          ...proactiveSafetyLimitShape,
          used: integer(0),
          resetsAt: timestamp,
          onReach: literal("hold_until_reset"),
        }),
        perCheck: object({
          ...proactiveSafetyLimitShape,
          onReach: literal("hold_until_next_check"),
        }),
        dailyLimitReached: booleanValue,
        updatedAt: nullable(timestamp),
      }),
    ),
    generatedAt: timestamp,
  }),
});
const proactiveSourceSettingsSetCommandSchema = object({
  ...commandEnvelope("proactive.source.settings.set"),
  payload: object({
    source: proactiveSourceName,
    enabled: booleanValue,
    perDay: integer(1),
    perCheck: integer(1),
  }),
});
const proactiveSourceSwitchOffCommandSchema = object({
  ...commandEnvelope("proactive.source.switch_off"),
  payload: object({ source: proactiveSourceName }),
});
const museOverviewQuerySchema = object({
  ...envelope("query", "muse.overview.read"),
  payload: object({}),
});
const museItemKindSchema = enumeration(["proactive", "scheduled"]);
const museOverviewSnapshotSchema = object({
  ...envelope("snapshot", "muse.overview.snapshot"),
  payload: object({
    channel: object({
      state: enumeration(["never", "ok", "stale", "down", "paused"]),
      lastBatchAt: nullable(timestamp),
      gapCount: integer(0),
    }),
    receivedWeek: integer(0),
    suppressedWeek: integer(0),
    pending: integer(0),
    delay: nullable(object({ medianMinutes: integer(0), samples: integer(10) })),
    items: array(
      object({
        kind: museItemKindSchema,
        naturalKey: machineString,
        occurredAt: timestamp,
        title: nullable(proactiveTextSchema(300)),
        text: nullable(proactiveTextSchema(500)),
        withheld: booleanValue,
        timingOk: nullable(booleanValue),
        contentOk: nullable(booleanValue),
      }),
    ),
    generatedAt: timestamp,
  }),
});
const museItemRateCommandSchema = object({
  ...commandEnvelope("muse.item.rate"),
  payload: object({
    kind: museItemKindSchema,
    naturalKey: machineString,
    timingOk: nullable(booleanValue),
    contentOk: nullable(booleanValue),
  }),
});
const museIntakeSetCommandSchema = object({
  ...commandEnvelope("muse.intake.set"),
  payload: object({ paused: booleanValue }),
});
const museDataClearCommandSchema = object({
  ...commandEnvelope("muse.data.clear"),
  payload: object({}),
});

const sensitiveInterceptionCursorSchema = object({
  firstSeenAt: timestamp,
  id: machineString,
});
const sensitiveInterceptionsQuerySchema = object({
  ...envelope("query", "sensitive.interceptions.read"),
  payload: object({ before: nullable(sensitiveInterceptionCursorSchema) }),
});
const sensitiveInterceptionsSnapshotSchema = object({
  ...envelope("snapshot", "sensitive.interceptions.snapshot"),
  payload: object({
    counts: object({ masked: integer(0), withheld: integer(0), notSaved: integer(0) }),
    items: array(
      object({
        id: machineString,
        threadId: nullable(machineString),
        source: enumeration([
          "chat",
          "background",
          "embedding",
          "tool_result",
          "mail",
          "memory_capture",
        ]),
        purpose: nullable(machineString),
        part: enumeration([
          "system",
          "owner_message",
          "assistant_message",
          "tool_call",
          "tool_result",
          "embedding_input",
          "file",
          "command_output",
          "web_page",
          "mail",
          "memory_candidate",
          "memory_source",
        ]),
        category: enumeration([
          "machine-secret",
          "password",
          "verification-code",
          "bank-card",
          "identity-number",
        ]),
        outcome: enumeration(["masked", "withheld", "not_saved"]),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        seenCount: integer(1),
      }),
    ),
    next: nullable(sensitiveInterceptionCursorSchema),
    generatedAt: timestamp,
  }),
});
const sensitiveInterceptionsClearCommandSchema = object({
  ...commandEnvelope("sensitive.interceptions.clear"),
  payload: object({}),
});

function numberInRange(minimum: number, maximum: number): Schema<number> {
  return {
    parse(input, path = "$") {
      if (
        typeof input !== "number" ||
        !Number.isFinite(input) ||
        input < minimum ||
        input > maximum
      )
        throw new ContractValidationError(path, `expected a number from ${minimum} to ${maximum}`);
      return input;
    },
  };
}
const jstDaySchema: Schema<string> = {
  parse(input, path = "$") {
    if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input))
      throw new ContractValidationError(path, "expected a YYYY-MM-DD day");
    const parsed = Date.parse(`${input}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== input)
      throw new ContractValidationError(path, "expected a real calendar day");
    return input;
  },
};
const observationFactsSchema: Schema<Readonly<Record<string, string | number | boolean | null>>> = {
  parse(input, path = "$") {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new ContractValidationError(path, "expected an object");
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 40) throw new ContractValidationError(path, "too many facts");
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of entries) {
      machineString.parse(key, `${path}.${key}`);
      if (
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        result[key] = value;
      else if (typeof value === "string" && value.length <= 256) result[key] = value;
      else throw new ContractValidationError(`${path}.${key}`, "expected a short fact");
    }
    return Object.freeze(result);
  },
};
const calibrationGroupSchema = enumeration([
  "proactive_pushed",
  "proactive_silent",
  "memory_skipped",
  "memory_kept",
  "consolidation",
  "memory_pending",
  "context_truncation",
  "retrieval_degrade",
  "external_read",
  "rule_review",
  "memory_capture_failed",
]);
const calibrationRateSchema = nullable(
  object({
    successes: integer(0),
    samples: integer(0),
    enough: booleanValue,
    value: nullable(numberInRange(0, 1)),
    low: nullable(numberInRange(0, 1)),
    high: nullable(numberInRange(0, 1)),
  }),
);
const observationCheckItemSchema = object({
  code: machineString,
  status: enumeration(["pass", "fail", "blocked", "pending", "not_applicable"]),
  reason: machineString,
  facts: observationFactsSchema,
});
const proactiveWeeklyQuerySchema = object({
  ...envelope("query", "proactive.weekly.read"),
  payload: object({ end: nullable(jstDaySchema) }),
});
const proactiveWeeklySnapshotSchema = object({
  ...envelope("snapshot", "proactive.weekly.snapshot"),
  payload: object({
    serviceRevision: machineString,
    observation: object({
      startDay: nullable(jstDaySchema),
      earliestStartDay: nullable(jstDaySchema),
      setAt: nullable(timestamp),
      startRevision: nullable(machineString),
      firstReportDay: nullable(jstDaySchema),
      passStreak: integer(0),
      streakSince: nullable(jstDaySchema),
      accepted: booleanValue,
      days: array(
        object({
          day: jstDaySchema,
          status: enumeration(["pass", "fail", "blocked", "pending", "no_check", "upcoming"]),
          checkedAt: nullable(timestamp),
          serviceRevision: nullable(machineString),
          checks: array(observationCheckItemSchema),
        }),
      ),
    }),
    report: object({
      start: timestamp,
      end: timestamp,
      startDay: jstDaySchema,
      endDay: jstDaySchema,
      complete: booleanValue,
      ratesWithheld: booleanValue,
      minimumSamples: integer(1),
      groups: array(
        object({
          group: calibrationGroupSchema,
          total: integer(0),
          rated: integer(0),
          useful: integer(0),
          unneeded: integer(0),
          missed: integer(0),
          applicable: array(proactiveRatingSchema),
          rates: object({
            useful: calibrationRateSchema,
            unneeded: calibrationRateSchema,
            missed: calibrationRateSchema,
          }),
        }),
      ),
      muse: object({
        entries: integer(0),
        reminded: integer(0),
        silent: integer(0),
        unpaired: integer(0),
        pairedMails: integer(0),
        timing: calibrationRateSchema,
        content: calibrationRateSchema,
        pairing: calibrationRateSchema,
        buckets: object({
          both: integer(0),
          museOnly: integer(0),
          himawariOnly: integer(0),
          bothSilent: integer(0),
          noHimawariRecord: integer(0),
        }),
      }),
      gapCases: array(
        object({
          id: machineString,
          messageId: nullable(gmailMessageId),
          museAt: timestamp,
          museTitle: nullable(proactiveTextSchema(300)),
          museText: nullable(proactiveTextSchema(500)),
          museTextWithheld: booleanValue,
          himawariOutcome: machineString,
          himawariReasonCode: machineString,
          himawariReason: nullable(proactiveTextSchema(500)),
          ownerRating: nullable(enumeration(["useful", "unneeded", "missed"])),
          attribution: enumeration([
            "notRemembered",
            "notRetrieved",
            "wrongJudgment",
            "notReadFully",
          ]),
          memoryHits: integer(0),
          relatedMessages: integer(0),
          decidedAt: timestamp,
          marked: booleanValue,
        }),
      ),
      gap: nullable(
        object({
          pairedMails: integer(0),
          ratedMails: integer(0),
          unratedMails: integer(0),
          lines: array(
            object({
              line: enumeration(["hitRate", "disturbanceRate"]),
              mails: integer(0),
              museReminded: integer(0),
              himawariReminded: integer(0),
              muse: calibrationRateSchema,
              himawari: calibrationRateSchema,
              difference: nullable(numberInRange(-1, 1)),
              low: nullable(numberInRange(-1, 1)),
              high: nullable(numberInRange(-1, 1)),
              verdict: enumeration(["insufficient", "inconclusive", "decided"]),
              direction: enumeration(["museHigher", "himawariHigher", "none"]),
            }),
          ),
        }),
      ),
      implicit: object({
        pushedDecisions: integer(0),
        otherDecisionEvents: integer(0),
        signals: array(
          object({
            signal: enumeration(["opened", "undone", "replied"]),
            decisions: integer(0),
            events: integer(0),
            medianDelayMs: nullable(integer(0)),
            rate: calibrationRateSchema,
          }),
        ),
      }),
      mcpConnections: nullable(
        object({
          fromDay: mcpUsageDaySchema,
          toDay: mcpUsageDaySchema,
          connections: array(
            object({
              id: machineString,
              name: mcpConnectionNameSchema,
              status: enumeration(MCP_CONNECTION_STATUS_NAMES),
              lastSeenAt: nullable(timestamp),
              usage: mcpConnectionUsageSchema,
            }),
          ),
        }),
      ),
      prereview: object({
        agreementPermille: integer(0, 1000),
        confidencePermille: integer(0, 1000),
        reductionEnabled: booleanValue,
        auditPermille: integer(0, 1000),
        minimumPairs: nullable(integer(1)),
        otherVersions: integer(0),
        groups: array(
          object({
            group: calibrationGroupSchema,
            prereviewed: integer(0),
            unsure: integer(0),
            paired: integer(0),
            agreement: calibrationRateSchema,
            kappa: nullable(numberInRange(-1, 1)),
            balancedAccuracy: nullable(numberInRange(0, 1)),
            ownerUseful: calibrationRateSchema,
            hidden: calibrationRateSchema,
            confusion: array(
              object({
                model: proactiveRatingSchema,
                owner: proactiveRatingSchema,
                count: integer(0),
              }),
            ),
            gate: nullable(
              object({
                open: booleanValue,
                reason: enumeration([
                  "open",
                  "insufficient",
                  "below_threshold",
                  "not_above_baseline",
                ]),
                requiredAgreement: nullable(numberInRange(0, 1)),
              }),
            ),
          }),
        ),
      }),
      correction: nullable(
        object({
          handled: integer(0),
          agreed: integer(0),
          missed: integer(0),
          openMemories: integer(0),
          openRules: integer(0),
          agreement: calibrationRateSchema,
        }),
      ),
    }),
    generatedAt: timestamp,
  }),
});
const proactiveGapCaseMarkCommandSchema = object({
  ...commandEnvelope("proactive.gapcase.mark"),
  payload: object({
    caseId: machineString,
    endDay: jstDaySchema,
    marked: booleanValue,
  }),
});
const proactiveObservationStartCommandSchema = object({
  ...commandEnvelope("proactive.observation.start"),
  payload: object({
    startDay: jstDaySchema,
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const MEMORY_SENSITIVE_TOPICS = [
  "health",
  "finance",
  "beliefs",
  "intimacy",
  "third_party",
  "location",
  "legal",
  "other",
] as const;
export const MEMORY_CATEGORY_NAMES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] as const;
export const MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"] as const;
export const MEMORY_EXTERNAL_CATEGORY_NAMES = MEMORY_CATEGORY_NAMES.filter(
  (category): category is Exclude<(typeof MEMORY_CATEGORY_NAMES)[number], "rule"> =>
    category !== "rule",
);
export const MEMORY_EXTERNAL_RESPOND_MAXIMUM = 500;
export const MCP_SYNC_NOTE_TEXT_MAXIMUM = 60_000;
export const MEMORY_HISTORY_KIND_NAMES = [
  "created",
  "updated",
  "reaffirmed",
  "edited",
  "restored",
] as const;
export const MEMORY_IMPORT_SOURCE_NAMES = ["codex", "assistant", "himawari"] as const;
const memoryLabelSchema = boundedString(32);
const memoryNameSchema = boundedString(64);
export const MEMORY_PROFILE_KINDS = [
  "rules",
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
] as const;
const memoryOverviewQuerySchema = object({
  ...envelope("query", "memory.overview.read"),
  payload: object({}),
});
const memoryBasisQuerySchema = object({
  ...envelope("query", "memory.basis.read"),
  payload: object({ memoryId: machineString }),
});
const memoryBasisSnapshotSchema = object({
  ...envelope("snapshot", "memory.basis.snapshot"),
  payload: object({
    memoryId: machineString,
    nodes: array(
      object({
        memoryId: machineString,
        changeId: nullable(machineString),
        action: nullable(enumeration(["merge", "supersede", "archive", "reflect", "hold"])),
        changedAt: nullable(timestamp),
        decisionRecordId: nullable(machineString),
        basisMemoryIds: array(machineString),
        repeated: booleanValue,
        truncated: booleanValue,
      }),
    ),
    complete: booleanValue,
  }),
});
export const MEMORY_CLASSIFY_MAXIMUM = 500;
const memoryClassifyRefsSchema = array(machineString);
const memoryClassifyQuerySchema = object({
  ...envelope("query", "memory.classify.read"),
  payload: object({
    contentRefs: {
      parse(input, path = "$.payload.contentRefs") {
        const refs = memoryClassifyRefsSchema.parse(input, path);
        if (refs.length < 1 || refs.length > MEMORY_CLASSIFY_MAXIMUM)
          throw new ContractValidationError(path, "must hold 1 to 500 refs");
        return refs;
      },
    },
  }),
});
const memoryClassifySnapshotSchema = object({
  ...envelope("snapshot", "memory.classify.snapshot"),
  payload: object({
    items: array(
      object({
        contentRef: machineString,
        category: enumeration(MEMORY_CATEGORY_NAMES),
        classification: enumeration(["private", "sensitive"]),
        topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
        failed: booleanValue,
      }),
    ),
  }),
});
export const MEMORY_IMPORT_DUPLICATES_MAXIMUM = 500;
const memoryImportDuplicatesQuerySchema = object({
  ...envelope("query", "memory.import.duplicates.read"),
  payload: object({
    contentRefs: {
      parse(input, path = "$.payload.contentRefs") {
        const refs = memoryClassifyRefsSchema.parse(input, path);
        if (refs.length < 1 || refs.length > MEMORY_IMPORT_DUPLICATES_MAXIMUM)
          throw new ContractValidationError(path, "must hold 1 to 500 refs");
        return refs;
      },
    },
  }),
});
const memoryImportDuplicatesSnapshotSchema = object({
  ...envelope("snapshot", "memory.import.duplicates.snapshot"),
  payload: object({
    items: array(
      object({
        contentRef: machineString,
        verdict: enumeration(["same", "unsure", "different", "skipped"]),
        memoryId: nullable(machineString),
      }),
    ),
  }),
});
const decisionChainQuerySchema = object({
  ...envelope("query", "decision.chain.read"),
  payload: object({ decisionId: machineString }),
});
const decisionChainSectionState = enumeration([
  "recorded",
  "none",
  "not_recorded",
  "not_applicable",
]);
const decisionChainReadState = enumeration(["off", "ok", "partial", "failed", "not_recorded"]);
const decisionChainSnapshotSchema = object({
  ...envelope("snapshot", "decision.chain.snapshot"),
  payload: object({
    decisionId: machineString,
    decision: object({
      kind: enumeration([
        "proactive",
        "memory_candidate",
        "consolidation",
        "context_truncation",
        "retrieval_degrade",
        "external_read",
        "rule_review",
        "web_push",
        "memory_review",
        "limit_change",
        "delivery_timing",
        "proposal",
        "device_action",
      ]),
      decidedAt: timestamp,
      outcome: boundedString(64),
      reasonCode: boundedString(64),
      rating: nullable(enumeration(["useful", "unneeded", "missed"])),
      ratedAt: nullable(timestamp),
    }),
    inputs: enumeration(["recorded", "not_recorded"]),
    rules: object({
      state: decisionChainSectionState,
      items: array(
        object({
          ruleId: boundedString(256),
          revision: nullable(integer(0)),
          current: booleanValue,
          kind: enumeration([
            "important_sender",
            "public_domain",
            "money_words",
            "quiet_hours",
            "amount_threshold",
            "mail_must_notify",
            "mail_read_whole_thread",
            "push_quiet_hours",
            "unknown",
          ]),
          origin: nullable(enumeration(["owner_setting", "built_in"])),
          source: nullable(boundedString(256)),
          status: nullable(enumeration(["active", "needs_review", "suspended", "retired"])),
          changedAt: nullable(timestamp),
          memory: nullable(
            object({
              memoryId: machineString,
              state: enumeration(["visible", "hidden", "missing"]),
              text: nullable(boundedString(2000)),
            }),
          ),
          wording: nullable(
            object({
              values: array(boundedString(256)),
              quietHours: array(
                object({
                  days: array(integer(0)),
                  start: boundedString(5),
                  end: boundedString(5),
                }),
              ),
              amount: nullable(object({ currency: boundedString(3), minor: integer(0) })),
            }),
          ),
          tests: object({
            state: enumeration(["passed", "failed", "none", "unavailable"]),
            total: integer(0),
            failedAt: nullable(integer(1)),
          }),
          mailCount: integer(0),
        }),
      ),
    }),
    mails: nullable(
      object({
        judged: nullable(integer(0)),
        related: nullable(integer(0)),
        relatedRead: decisionChainReadState,
        summaries: nullable(
          object({
            count: integer(0),
            read: enumeration(["off", "ok", "partial", "failed"]),
          }),
        ),
      }),
    ),
    memories: object({
      state: decisionChainSectionState,
      recall: nullable(decisionChainReadState),
      total: integer(0),
      truncated: booleanValue,
      items: array(
        object({
          memoryId: machineString,
          state: enumeration(["visible", "hidden", "missing"]),
          text: nullable(boundedString(2000)),
          status: nullable(enumeration(["active", "archived", "trashed"])),
          inference: booleanValue,
          tentative: booleanValue,
          usedByModel: booleanValue,
          changedSinceDecision: booleanValue,
          supersededBy: nullable(
            object({ memoryId: machineString, text: nullable(boundedString(2000)) }),
          ),
          source: object({
            threadId: nullable(machineString),
            messageId: nullable(machineString),
            quote: nullable(boundedString(2000)),
            refs: array(boundedString(MEMORY_SOURCE_REF_MAX_LENGTH)),
            importBatchId: nullable(machineString),
            firstSourceDeleted: booleanValue,
          }),
          basis: object({
            nodes: array(
              object({
                memoryId: machineString,
                text: nullable(boundedString(500)),
                action: nullable(enumeration(["merge", "supersede", "archive", "reflect", "hold"])),
                changedAt: nullable(timestamp),
                basisMemoryIds: array(machineString),
                repeated: booleanValue,
                truncated: booleanValue,
              }),
            ),
            complete: booleanValue,
          }),
        }),
      ),
    }),
  }),
});
const decisionEmailQuerySchema = object({
  ...envelope("query", "decision.email.read"),
  payload: object({ messageId: gmailMessageId }),
});
const decisionEmailSnapshotSchema = object({
  ...envelope("snapshot", "decision.email.snapshot"),
  payload: object({
    messageId: gmailMessageId,
    mail: nullable(
      object({
        decisionId: machineString,
        threadId: boundedString(256),
        outcome: enumeration(["act", "know", "check", "ignore", "skipped"]),
        skipReason: nullable(enumeration(["category", "sensitive", "own_mail"])),
        processedAt: timestamp,
        rating: nullable(enumeration(["useful", "unneeded", "missed"])),
        decidedAt: nullable(timestamp),
        ruleIds: nullable(array(boundedString(256))),
        memoryIds: nullable(array(boundedString(256))),
        relatedMessages: nullable(integer(0)),
      }),
    ),
    muse: object({
      entries: array(
        object({
          entryId: boundedString(128),
          museAt: timestamp,
          reminded: booleanValue,
          kind: nullable(enumeration(["proactive", "scheduled"])),
          state: nullable(enumeration(["delivered", "suppressed", "succeeded", "failed"])),
          title: nullable(proactiveTextSchema(300)),
          text: nullable(proactiveTextSchema(500)),
          textWithheld: booleanValue,
          timingOk: nullable(booleanValue),
          contentOk: nullable(booleanValue),
        }),
      ),
      truncated: booleanValue,
    }),
    comparison: enumeration([
      "both",
      "museOnly",
      "himawariOnly",
      "bothSilent",
      "noMuseEntry",
      "noHimawariRecord",
    ]),
  }),
});
const memoryOverviewSnapshotSchema = object({
  ...envelope("snapshot", "memory.overview.snapshot"),
  payload: object({
    memories: array(
      object({
        memoryId: machineString,
        revision: integer(1),
        text: boundedString(2000),
        dataClassification: classificationSchema,
        topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
        inference: booleanValue,
        sourceThreadId: nullable(machineString),
        sourceMessageId: nullable(machineString),
        sourceRefs: array(boundedString(MEMORY_SOURCE_REF_MAX_LENGTH)),
        updatedAt: timestamp,
        supersededBy: nullable(machineString),
        validTo: nullable(boundedString(32)),
        tentative: booleanValue,
        category: enumeration(MEMORY_CATEGORY_NAMES),
        subCategory: nullable(memoryLabelSchema),
        status: enumeration(["active", "archived", "trashed"]),
        recordedAt: timestamp,
        lastUsedAt: nullable(timestamp),
        importBatchId: nullable(machineString),
        importance: integer(0, 1000),
        profilePin: nullable(enumeration(["on", "off"])),
        stance: nullable(boundedString(16)),
        history: array(
          object({
            historyId: integer(1),
            kind: enumeration(MEMORY_HISTORY_KIND_NAMES),
            text: boundedString(2000),
            stance: nullable(boundedString(16)),
            quote: nullable(boundedString(2000)),
            sourceThreadId: nullable(machineString),
            sourceDeleted: booleanValue,
            at: timestamp,
          }),
        ),
      }),
    ),
    tidyUps: array(
      object({
        changeId: machineString,
        memoryId: machineString,
        action: enumeration(["merge", "supersede", "archive", "reflect", "hold"]),
        text: boundedString(2000),
        relatedText: nullable(boundedString(2000)),
        createdAt: timestamp,
        undone: booleanValue,
        undoable: booleanValue,
      }),
    ),
    conversationReviews: array(
      object({
        reviewId: machineString,
        finishedAt: timestamp,
        undone: booleanValue,
        undoable: booleanValue,
        changes: array(
          object({
            memoryId: machineString,
            action: enumeration(["created", "superseded", "confirmed"]),
          }),
        ),
      }),
    ),
    reminders: array(
      object({
        reminderId: machineString,
        text: boundedString(2000),
        dueAt: timestamp,
        remindAt: timestamp,
        sourceThreadId: nullable(machineString),
      }),
    ),
    upcoming: array(
      object({
        reminderId: machineString,
        memoryId: machineString,
        text: boundedString(2000),
        dueAt: timestamp,
        repeat: enumeration(["none", "yearly"]),
        sourceThreadId: nullable(machineString),
      }),
    ),
    people: array(
      object({
        personId: machineString,
        name: memoryNameSchema,
        aliases: array(memoryNameSchema),
        relation: nullable(memoryLabelSchema),
        reverseRelation: nullable(memoryLabelSchema),
        links: array(object({ personId: machineString, relation: memoryLabelSchema })),
        memoryIds: array(machineString),
      }),
    ),
    personSuggestions: array(
      object({
        suggestionId: machineString,
        personId: machineString,
        candidateId: machineString,
        createdAt: timestamp,
      }),
    ),
    imports: array(
      object({
        batchId: machineString,
        source: enumeration(MEMORY_IMPORT_SOURCE_NAMES),
        itemCount: integer(1),
        createdAt: timestamp,
        undone: booleanValue,
      }),
    ),
    capturePaused: booleanValue,
    manualAddReady: booleanValue,
    lastViewedAt: nullable(timestamp),
    profileUsage: object({
      used: integer(0),
      limit: integer(1),
      pinned: integer(0),
      queued: array(machineString),
    }),
    profile: array(
      object({
        kind: enumeration(MEMORY_PROFILE_KINDS),
        lines: array(
          object({
            memoryId: machineString,
            text: boundedString(2000),
            updatedAt: timestamp,
          }),
        ),
      }),
    ),
    pending: array(
      object({
        requestId: machineString,
        threadId: machineString,
        sourceRef: boundedString(512),
        text: boundedString(2000),
        topic: enumeration(MEMORY_SENSITIVE_TOPICS),
        requestedAt: timestamp,
      }),
    ),
    externalProposals: object({
      total: integer(0),
      items: array(
        object({
          proposalId: machineString,
          text: boundedString(2000),
          category: enumeration(MEMORY_EXTERNAL_CATEGORY_NAMES),
          dataClassification: enumeration(["private", "sensitive"]),
          client: boundedString(64),
          receivedAt: timestamp,
        }),
      ),
      batches: array(
        object({
          batchId: machineString,
          decidedAt: timestamp,
          committed: integer(0),
          rejected: integer(0),
        }),
      ),
    }),
    mcpSync: object({
      entriesTotal: integer(0),
      entries: array(
        object({
          entryId: machineString,
          connectionName: codePointString(64),
          projectName: nullable(codePointString(256)),
          category: codePointString(32),
          classification: enumeration(["private", "sensitive"]),
          state: enumeration(["awaiting_project_approval", "awaiting_confirmation", "refused"]),
          version: integer(1),
          text: codePointString(MCP_SYNC_NOTE_TEXT_MAXIMUM, { allowLineBreaks: true }),
          previousText: nullable(
            codePointString(MCP_SYNC_NOTE_TEXT_MAXIMUM, { allowLineBreaks: true }),
          ),
          sourceDeleted: booleanValue,
          lastSyncedAt: timestamp,
        }),
      ),
      projects: array(
        object({
          connectionId: machineString,
          projectId: machineString,
          connectionName: codePointString(64),
          projectName: nullable(codePointString(256)),
          approval: enumeration(["pending", "approved", "declined"]),
        }),
      ),
      attention: array(
        object({
          attentionId: machineString,
          connectionName: codePointString(64),
          projectName: nullable(codePointString(256)),
          heldEntries: integer(0),
          baseline: integer(0),
          createdAt: timestamp,
        }),
      ),
    }),
    generatedAt: timestamp,
  }),
});
const memoryTidyUndoCommandSchema = object({
  ...commandEnvelope("memory.tidy.undo"),
  payload: object({ changeId: machineString }),
});
const memoryConversationReviewUndoCommandSchema = object({
  ...commandEnvelope("memory.conversationReview.undo"),
  payload: object({ reviewId: machineString }),
});
const memoryReminderRespondCommandSchema = object({
  ...commandEnvelope("memory.reminder.respond"),
  payload: object({
    reminderId: machineString,
    action: enumeration(["dismiss", "snooze", "cancel"]),
  }),
});
const memoryReminderCreateCommandSchema = object({
  ...commandEnvelope("memory.reminder.create"),
  payload: object({
    contentRef: machineString,
    due: boundedString(16),
    repeat: enumeration(["none", "yearly"]),
  }),
});
export const OWNER_RULE_ACTIONS = [
  "undo",
  "confirm",
  "reconfirm",
  "ask_first",
  "allow_directly",
] as const;
export const BUILT_IN_ACTION_RULE_OUTCOMES = [
  "allow_preauthorized",
  "ask_owner",
  "refuse",
] as const;
export const PROPOSAL_ACTIONS = ["adopt", "reject", "undo"] as const;
export const PROPOSAL_ORIGINS = [
  "owner_said",
  "inferred",
  "external_agent",
  "external_content",
] as const;
const memoryRulesQuerySchema = object({
  ...envelope("query", "memory.rules.read"),
  payload: object({}),
});
const memoryRulesSnapshotSchema = object({
  ...envelope("snapshot", "memory.rules.snapshot"),
  payload: object({
    rules: array(
      object({
        ruleId: machineString,
        type: boundedString(64),
        summary: boundedString(200),
        status: enumeration(["active", "needs_review", "suspended"]),
        enforced: booleanValue,
        updatedAt: timestamp,
        quote: nullable(boundedString(500)),
        quoteSuperseded: booleanValue,
        quoteLatestMemoryId: nullable(machineString),
        changes: integer(0),
        lastUsed: nullable(
          object({ at: timestamp, kind: machineString, decisionId: machineString }),
        ),
      }),
    ),
    builtIn: array(
      object({
        ruleId: machineString,
        revision: integer(1),
        outcome: enumeration(BUILT_IN_ACTION_RULE_OUTCOMES),
        examplesHit: integer(0),
        examplesMiss: integer(0),
        askFirst: nullable(booleanValue),
      }),
    ),
    generatedAt: timestamp,
  }),
});
const proposalsQuerySchema = object({
  ...envelope("query", "proposals.read"),
  payload: object({
    open: nullable(
      object({
        proposalId: machineString,
        expectedVersion: integer(1),
        fingerprint: machineString,
      }),
    ),
  }),
});
const proposalsSnapshotSchema = object({
  ...envelope("snapshot", "proposals.snapshot"),
  payload: object({
    proposals: array(
      object({
        proposalId: machineString,
        version: integer(1),
        fingerprint: machineString,
        type: boundedString(64),
        summary: boundedString(200),
        effect: boundedString(200),
        origin: enumeration(PROPOSAL_ORIGINS),
        adoptable: booleanValue,
        requiresFullRead: booleanValue,
        requiresPresence: booleanValue,
        evidence: array(
          object({
            kind: boundedString(64),
            text: nullable(boundedString(500)),
            sources: array(object({ kind: boundedString(64), ref: boundedString(256) })),
            figures: array(
              object({
                name: boundedString(64),
                value: integer(Number.MIN_SAFE_INTEGER),
                definition: boundedString(200),
              }),
            ),
          }),
        ),
        proposedAt: timestamp,
        expiresAt: timestamp,
        refusedBefore: integer(0),
      }),
    ),
    pendingCount: integer(0),
    limit: integer(1),
    expiresAfterDays: integer(1),
    opened: nullable(
      object({ proposalId: machineString, fullReadToken: machineString, expiresAt: timestamp }),
    ),
    generatedAt: timestamp,
  }),
});
const proposalRespondCommandSchema = object({
  ...commandEnvelope("proposal.respond"),
  payload: object({
    proposalId: machineString,
    expectedVersion: integer(1),
    fingerprint: machineString,
    action: enumeration(PROPOSAL_ACTIONS),
    recentAuthenticationRef: nullable(machineString),
    fullReadToken: nullable(machineString),
  }),
});
const memoryRuleRespondCommandSchema = object({
  ...commandEnvelope("memory.rule.respond"),
  payload: object({
    target: machineString,
    action: enumeration(OWNER_RULE_ACTIONS),
  }),
});
export const MEMORY_REVIEW_REASONS = [
  "memory_edited",
  "memory_superseded",
  "memory_removed",
  "memory_restored",
  "memory_reclassified",
  "owner_reported",
] as const;
export const RULE_SUSPEND_REASONS = [
  "source_removed",
  "no_longer_standing",
  "parameters_changed",
] as const;
export const RULE_CONDITION_FIELDS = [
  "senderDomains",
  "senderAddresses",
  "phrases",
  "words",
  "excludePhrases",
] as const;
export const MEMORY_REVIEW_ACTIONS = ["dismiss", "adopt", "confirm_suspended", "restore"] as const;
const memoryReviewQuerySchema = object({
  ...envelope("query", "memory.review.read"),
  payload: object({}),
});
const memoryReviewSnapshotSchema = object({
  ...envelope("snapshot", "memory.review.snapshot"),
  payload: object({
    memories: array(
      object({
        memoryId: machineString,
        text: nullable(boundedString(200)),
        upstreamMemoryId: machineString,
        upstreamText: nullable(boundedString(200)),
        reason: enumeration(MEMORY_REVIEW_REASONS),
        depth: integer(1),
        truncated: booleanValue,
        flaggedAt: timestamp,
      }),
    ),
    rules: array(
      object({
        ruleId: machineString,
        revision: integer(1),
        status: enumeration(["needs_review", "suspended"]),
        summary: boundedString(200),
        suggestion: nullable(boundedString(200)),
        suggestionConditions: array(
          object({
            field: enumeration(RULE_CONDITION_FIELDS),
            values: array(boundedString(200)),
          }),
        ),
        suspendReason: nullable(enumeration(RULE_SUSPEND_REASONS)),
        rechecking: booleanValue,
        sourceMemoryId: nullable(machineString),
        updatedAt: timestamp,
      }),
    ),
    agreement: object({
      handled: integer(0),
      agreed: integer(0),
      missed: integer(0),
      openMemories: integer(0),
      openRules: integer(0),
    }),
    generatedAt: timestamp,
  }),
});
const memoryReviewRespondCommandSchema = object({
  ...commandEnvelope("memory.review.respond"),
  payload: object({
    target: machineString,
    action: enumeration(MEMORY_REVIEW_ACTIONS),
    expectedRevision: nullable(integer(1)),
  }),
});
const memoryReviewReportMissedCommandSchema = object({
  ...commandEnvelope("memory.review.reportMissed"),
  payload: object({
    memoryId: machineString,
    upstreamMemoryId: machineString,
  }),
});
const memoryCreateCommandSchema = object({
  ...commandEnvelope("memory.create"),
  payload: object({
    contentRef: machineString,
    category: enumeration(MEMORY_CATEGORY_NAMES),
    subCategory: nullable(memoryLabelSchema),
    topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
    pinned: booleanValue,
  }),
});
const memoryCategorySetCommandSchema = object({
  ...commandEnvelope("memory.category.set"),
  payload: object({
    memoryId: machineString,
    expectedRevision: integer(0),
    category: enumeration(MEMORY_CATEGORY_NAMES),
  }),
});
const memorySettingsSetCommandSchema = object({
  ...commandEnvelope("memory.settings.set"),
  payload: object({ capturePaused: booleanValue }),
});
const memoryPageViewedCommandSchema = object({
  ...commandEnvelope("memory.page.viewed"),
  payload: object({}),
});
const memoryPersonRespondCommandSchema = object({
  ...commandEnvelope("memory.person.respond"),
  payload: object({ suggestionId: machineString, merge: booleanValue }),
});
const memoryImportItemsSchema = array(
  object({
    contentRef: machineString,
    category: enumeration(MEMORY_CATEGORY_NAMES),
    subCategory: nullable(memoryLabelSchema),
    topic: nullable(enumeration(MEMORY_SENSITIVE_TOPICS)),
  }),
);
const memoryImportCommitCommandSchema = object({
  ...commandEnvelope("memory.import.commit"),
  payload: object({
    batchId: machineString,
    source: enumeration(MEMORY_IMPORT_SOURCE_NAMES),
    items: {
      parse(input, path = "$.payload.items") {
        const items = memoryImportItemsSchema.parse(input, path);
        if (items.length < 1 || items.length > 500)
          throw new ContractValidationError(path, "must hold 1 to 500 items");
        return items;
      },
    },
  }),
});
const memoryImportUndoCommandSchema = object({
  ...commandEnvelope("memory.import.undo"),
  payload: object({ batchId: machineString }),
});
export const EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000;
const memoryExternalRespondItemsSchema = array(
  object({
    proposalId: machineString,
    decision: enumeration(["keep", "reject"]),
    editedText: nullable(boundedString(EXTERNAL_PROPOSAL_TEXT_MAXIMUM)),
  }),
);
const memoryExternalRespondCommandSchema = object({
  ...commandEnvelope("memory.external.respond"),
  payload: object({
    items: {
      parse(input, path = "$.payload.items") {
        const items = memoryExternalRespondItemsSchema.parse(input, path);
        if (items.length < 1 || items.length > MEMORY_EXTERNAL_RESPOND_MAXIMUM)
          throw new ContractValidationError(path, "must hold 1 to 500 items");
        if (new Set(items.map(({ proposalId }) => proposalId)).size !== items.length)
          throw new ContractValidationError(path, "must not repeat a proposal");
        if (items.some(({ decision, editedText }) => decision === "reject" && editedText !== null))
          throw new ContractValidationError(path, "a rejected proposal cannot carry edited text");
        return items;
      },
    },
  }),
});
const memoryExternalUndoCommandSchema = object({
  ...commandEnvelope("memory.external.undo"),
  payload: object({ batchId: machineString }),
});
const memoryMcpSyncProjectDecideCommandSchema = object({
  ...commandEnvelope("memory.mcpSync.projectDecide"),
  payload: object({
    connectionId: machineString,
    projectId: machineString,
    decision: enumeration(["approve", "decline"]),
  }),
});
const memoryMcpSyncNoteDecideCommandSchema = object({
  ...commandEnvelope("memory.mcpSync.noteDecide"),
  payload: object({
    entryId: machineString,
    decision: enumeration(["confirm", "refuse", "restore"]),
  }),
});
const memoryMcpSyncAttentionResolveCommandSchema = object({
  ...commandEnvelope("memory.mcpSync.attentionResolve"),
  payload: object({
    attentionId: machineString,
    decision: enumeration(["release", "keep"]),
  }),
});
const memoryApprovalRespondCommandSchema = object({
  ...commandEnvelope("memory.approval.respond"),
  payload: object({
    requestId: machineString,
    resolution: enumeration(["approved", "edited", "rejected"]),
    editedText: nullable(boundedString(500)),
  }),
});

const githubRepositoryRefSchema: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > 256 ||
      [...input].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new ContractValidationError(
        path,
        "expected a 1-256 character repository reference without control characters",
      );
    }
    return input;
  },
};

const githubDisclosureSchema = object({
  confirmationRef: machineString,
  primaryModelRef: modelRefString,
  repositoryRef: githubRepositoryRefSchema,
  disclosedDataClassifications: array(classificationSchema),
  machineSecretsExcluded: literal(true),
});

const githubMonitorStatePayloadSchema = object({
  monitorId: machineString,
  action: enumeration(["enable", "pause", "revoke"]),
  expectedRevision: integer(0),
  historyPolicy: nullable(enumeration(["retain", "delete"])),
  disclosure: nullable(githubDisclosureSchema),
});

export const setGitHubMonitorStateCommandSchema = object({
  ...commandEnvelope("github.monitor.set_state"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = githubMonitorStatePayloadSchema.parse(input, path);
      if (payload.action === "enable" && payload.disclosure === null) {
        throw new ContractValidationError(`${path}.disclosure`, "is required when enabling");
      }
      if (payload.action !== "enable" && payload.disclosure !== null) {
        throw new ContractValidationError(`${path}.disclosure`, "is only allowed when enabling");
      }
      if (payload.action === "revoke" && payload.historyPolicy === null) {
        throw new ContractValidationError(`${path}.historyPolicy`, "is required when revoking");
      }
      if (payload.action !== "revoke" && payload.historyPolicy !== null) {
        throw new ContractValidationError(`${path}.historyPolicy`, "is only allowed when revoking");
      }
      if (
        payload.action === "enable" &&
        payload.disclosure !== null &&
        payload.disclosure.disclosedDataClassifications.length === 0
      ) {
        throw new ContractValidationError(
          `${path}.disclosure.disclosedDataClassifications`,
          "must contain at least one classification",
        );
      }
      return payload;
    },
  },
});

const memoryMutationPayloadSchema = object({
  memoryId: machineString,
  action: enumeration([
    "correct",
    "archive",
    "delete",
    "restore",
    "confirm",
    "recover",
    "pin",
    "unpin",
    "restore_version",
  ]),
  expectedRevision: integer(0),
  contentRef: nullable(machineString),
  historyId: nullable(integer(1)),
});

export const mutateMemoryCommandSchema = object({
  ...commandEnvelope("memory.mutate"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = memoryMutationPayloadSchema.parse(input, path);
      if (
        (payload.action === "correct" && payload.contentRef === null) ||
        (payload.action !== "correct" && payload.contentRef !== null)
      ) {
        throw new ContractValidationError(
          `${path}.contentRef`,
          "must be present only for a correction",
        );
      }
      if ((payload.action === "restore_version") !== (payload.historyId !== null)) {
        throw new ContractValidationError(
          `${path}.historyId`,
          "must be present only for restoring a version",
        );
      }
      return payload;
    },
  },
});

export const revokeGrantCommandSchema = object({
  ...commandEnvelope("grant.revoke"),
  payload: object({
    grantId: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
  }),
});

export const reviewCapabilityCommandSchema = object({
  ...commandEnvelope("capability.review"),
  payload: object({ capabilityRef: machineString, expectedRevision: integer(1) }),
});

export const approveCapabilityInstallationCommandSchema = object({
  ...commandEnvelope("capability.install.approve"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    approvalRef: machineString,
  }),
});

const capabilityUpdateResponsePayloadSchema = object({
  capabilityRef: machineString,
  expectedRevision: integer(1),
  decision: enumeration(["approved", "denied"]),
  approvalRef: nullable(machineString),
});

export const respondCapabilityUpdateCommandSchema = object({
  ...commandEnvelope("capability.update.respond"),
  payload: {
    parse(input, path = "$.payload") {
      const payload = capabilityUpdateResponsePayloadSchema.parse(input, path);
      if ((payload.decision === "approved") !== (payload.approvalRef !== null)) {
        throw new ContractValidationError(
          `${path}.approvalRef`,
          "must be present exactly when the update is approved",
        );
      }
      return payload;
    },
  },
});

export const disableCapabilityCommandSchema = object({
  ...commandEnvelope("capability.disable"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const rollbackCapabilityCommandSchema = object({
  ...commandEnvelope("capability.rollback"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const reactivateCapabilityCommandSchema = object({
  ...commandEnvelope("capability.reactivate"),
  payload: object({
    capabilityRef: machineString,
    expectedRevision: integer(1),
    reasonCode: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});

const hostFileOperationSchema = enumeration([
  "read",
  "create",
  "update",
  "move",
  "trash",
  "restore",
  "permanent_delete",
]);

export const prepareHostFileCommandSchema = object({
  ...commandEnvelope("host.file.prepare"),
  payload: object({
    grantId: machineString,
    expectedGrantRevision: integer(1),
    operation: hostFileOperationSchema,
    relativePathRef: machineString,
    destinationPathRef: nullable(machineString),
    candidatePayloadRef: nullable(machineString),
    redactedDiffRef: nullable(machineString),
    irreversibleScopeRef: nullable(machineString),
    expiresAt: timestamp,
  }),
});

export const executeHostFileCommandSchema = object({
  ...commandEnvelope("host.file.execute"),
  payload: object({
    operationPlanRef: machineString,
    expectedRevision: integer(1),
    operation: hostFileOperationSchema,
    canonicalHash: machineString,
    recentAuthenticationRef: nullable(machineString),
  }),
});

export const createWorkspaceCopyCommandSchema = object({
  ...commandEnvelope("workspace.copy.create"),
  payload: object({
    grantId: machineString,
    expectedGrantRevision: integer(1),
    inputPathRefs: array(machineString),
    allowedPathRefs: array(machineString),
    spaceBudgetBytes: integer(1),
  }),
});

export const selectWorkspaceCopyCommandSchema = object({
  ...commandEnvelope("workspace.copy.select"),
  payload: object({
    threadId: machineString,
    workspaceRef: nullable(machineString),
    expectedRevision: nullable(integer(1)),
  }),
});

export const prepareWorkspaceCopyCommandSchema = object({
  ...commandEnvelope("workspace.copy.prepare"),
  payload: object({
    workspaceRef: machineString,
    pathRefs: array(machineString),
    expiresAt: timestamp,
  }),
});

export const stageWorkspaceCommandSchema = object({
  ...commandEnvelope("workspace.stage"),
  payload: object({
    workspaceSnapshotId: machineString,
    expectedTaskChangeSetRevision: integer(1),
    taskPathRefs: array(machineString),
    validationResultRefs: array(machineString),
    commitMessageRef: machineString,
    expiresAt: timestamp,
  }),
});

export const commitWorkspaceCommandSchema = object({
  ...commandEnvelope("workspace.commit"),
  payload: object({
    commitPreviewId: machineString,
    expectedRevision: integer(1),
    semanticSnapshotHash: machineString,
    recentAuthenticationRef: machineString,
  }),
});

export const respondSuggestionCommandSchema = object({
  ...commandEnvelope("suggestion.respond"),
  payload: object({
    suggestionId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["approve", "reject"]),
  }),
});

export const configureReflectionCommandSchema = object({
  ...commandEnvelope("reflection.configure"),
  payload: object({
    expectedRevision: integer(0),
    schedule: boundedString(256),
    timezone: boundedString(128),
    dailySuggestionQuota: integer(1, 20),
    maximumContextItems: integer(1, 1000),
    maximumCostMicros: integer(0),
    timeoutMs: integer(1),
    maximumCandidates: integer(1, 20),
    enabled: booleanValue,
  }),
});

export const reviewImprovementCommandSchema = object({
  ...commandEnvelope("improvement.review"),
  payload: object({
    candidateId: machineString,
    expectedRevision: integer(1),
    decision: enumeration(["reject", "request_revision"]),
    reviewEvidenceRef: machineString,
  }),
});

const pagePayload = {
  afterCursor: nullable(machineString),
  limit: integer(1, 500),
} as const;

export const listThreadsQuerySchema = object({
  ...envelope("query", "thread.list"),
  payload: object(pagePayload),
});

export const listApprovalsQuerySchema = object({
  ...envelope("query", "approval.list"),
  payload: object({
    status: nullable(enumeration(["pending", "approved", "denied", "expired"])),
    ...pagePayload,
  }),
});

export const approvalDetailQuerySchema = object({
  ...envelope("query", "approval.detail"),
  payload: object({ approvalRequestId: machineString }),
});

export const capabilityListQuerySchema = object({
  ...envelope("query", "capability.list"),
  payload: object({
    lifecycle: nullable(
      enumeration([
        "discovered",
        "review_required",
        "installation_proposed",
        "installation_approved",
        "active",
        "update_proposed",
        "update_approved",
        "disabled",
        "revoked",
        "uninstalled",
      ]),
    ),
    ...pagePayload,
  }),
});

export const capabilityDetailQuerySchema = object({
  ...envelope("query", "capability.detail"),
  payload: object({ capabilityRef: machineString }),
});

export const grantListQuerySchema = object({
  ...envelope("query", "grant.list"),
  payload: object({ includeRevoked: booleanValue, ...pagePayload }),
});

export const grantDetailQuerySchema = object({
  ...envelope("query", "grant.detail"),
  payload: object({ grantId: machineString }),
});

export const hostDirectoryDetailQuerySchema = object({
  ...envelope("query", "host.directory.detail"),
  payload: object({ grantId: machineString }),
});

export const workspaceDetailQuerySchema = object({
  ...envelope("query", "workspace.detail"),
  payload: object({ workspaceId: machineString }),
});

export const workspaceListQuerySchema = object({
  ...envelope("query", "workspace.list"),
  payload: object({ ...pagePayload }),
});

export const suggestionListQuerySchema = object({
  ...envelope("query", "suggestion.list"),
  payload: object({
    status: nullable(
      enumeration(["candidate", "delivered", "approved", "rejected", "expired", "superseded"]),
    ),
    ...pagePayload,
  }),
});

export const suggestionDetailQuerySchema = object({
  ...envelope("query", "suggestion.detail"),
  payload: object({ suggestionId: machineString }),
});

export const reflectionDetailQuerySchema = object({
  ...envelope("query", "reflection.detail"),
  payload: object({ includeCheckpoints: booleanValue }),
});

export const delegationDetailQuerySchema = object({
  ...envelope("query", "delegation.detail"),
  payload: object({ delegationId: machineString }),
});

export const delegationListQuerySchema = object({
  ...envelope("query", "delegation.list"),
  payload: object({
    status: nullable(
      enumeration(["created", "running", "validating", "completed", "failed", "cancelled"]),
    ),
    ...pagePayload,
  }),
});

export const improvementListQuerySchema = object({
  ...envelope("query", "improvement.list"),
  payload: object({
    status: nullable(
      enumeration([
        "proposed",
        "patching",
        "validating",
        "rejected_by_validation",
        "security_failure",
        "review_required",
        "rejected",
        "revision_requested",
      ]),
    ),
    ...pagePayload,
  }),
});

export const improvementDetailQuerySchema = object({
  ...envelope("query", "improvement.detail"),
  payload: object({ candidateId: machineString }),
});

export const collectionSnapshotSchema = object({
  ...envelope("snapshot", "collection.snapshot"),
  payload: object({
    category: enumeration([
      "threads",
      "messages",
      "approvals",
      "tasks",
      "inbox",
      "memories",
      "trace",
      "sessions",
      "devices",
      "capabilities",
      "grants",
      "workspaces",
      "suggestions",
      "improvements",
      "delegations",
    ]),
    itemRefs: array(machineString),
    nextCursor: nullable(machineString),
    snapshotRef: machineString,
    generatedAt: timestamp,
  }),
});

const frequencySnapshotSchema = object({
  count: integer(1),
  intervalMs: nullable(integer(1)),
});

const approvalDisplayText = (maximum: number): Schema<string> => ({
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      [...input].length > maximum ||
      [...input].some((character) => {
        const code = character.charCodeAt(0);
        return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
      })
    )
      throw new ContractValidationError(
        path,
        `expected a 1-${maximum} character string without control characters other than tab, newline and carriage return`,
      );
    return input;
  },
});

export const APPROVAL_DISPLAY_BODY_MAX_CHARACTERS = 2001;

const approvalDisplaySchema = object({
  displayTitle: nullable(approvalDisplayText(301)),
  bodyPreview: nullable(approvalDisplayText(APPROVAL_DISPLAY_BODY_MAX_CHARACTERS)),
  askedBecause: object({
    kind: enumeration(["rule", "no_rule_allows"]),
    ruleId: nullable(machineString),
    ruleText: nullable(approvalDisplayText(2001)),
  }),
  origin: nullable(
    object({
      threadId: machineString,
      threadTitle: nullable(approvalDisplayText(121)),
    }),
  ),
});

export const approvalSnapshotSchema = object({
  ...envelope("snapshot", "approval.snapshot"),
  payload: object({
    approvalRequestId: machineString,
    revision: integer(1),
    status: enumeration(["pending", "approved", "denied", "expired"]),
    deliveryState: enumeration(["deliverable", "queued_no_ui"]),
    semanticSnapshotHash: machineString,
    finalRisk: riskSchema,
    recentAuthenticationRequired: booleanValue,
    recentAuthenticationRef: nullable(machineString),
    requestedAt: timestamp,
    expiresAt: timestamp,
    decidedAt: nullable(timestamp),
    grantId: nullable(machineString),
    display: nullable(approvalDisplaySchema),
    intent: object({
      intentId: machineString,
      threadId: machineString,
      runId: machineString,
      actionKind: enumeration([
        "READ",
        "CREATE_OR_UPDATE",
        "DELETE",
        "COMMUNICATE",
        "PURCHASE_OR_FUNDS",
        "CREDENTIAL_OR_ACCESS",
        "PRODUCTION_OR_RECOVERY",
        "PUBLICATION",
        "LEGAL_COMMITMENT",
        "PHYSICAL_SAFETY",
        "INSTALL_OR_EXECUTE_CODE",
      ]),
      capabilityRef: machineString,
      capabilityVersion: machineString,
      operation: machineString,
      targetRefs: array(boundedString()),
      resourceRefs: array(boundedString()),
      dataClassification: classificationSchema,
      disclosure: enumeration(["none", "same_owner", "named_recipients", "public"]),
      recipientRefs: array(boundedString(512)),
      sideEffect: enumeration(["none", "reversible", "irreversible"]),
      estimatedCostMicros: integer(0),
      frequency: frequencySnapshotSchema,
      credentialOrAccessChange: booleanValue,
      reversible: booleanValue,
      idempotencyKey: machineString,
      deterministicFactCodes: array(machineString),
      modelReasonCode: machineString,
      requestedAt: timestamp,
      expiresAt: timestamp,
    }),
    trueResultRef: nullable(machineString),
    generatedAt: timestamp,
  }),
});

const runtimeQualificationSnapshotSchema = object({
  platform: enumeration(["darwin", "linux", "other"]),
  runtimeIdentity: boundedString(512),
  productionSuitable: booleanValue,
  reasonCodes: array(machineString),
  checkedAt: timestamp,
});

const updateAssessmentSnapshotSchema = object({
  fromVersion: machineString,
  toVersion: machineString,
  disposition: enumeration(["automatic", "approval_required"]),
  risk: riskSchema,
  sourceIdentityChanged: booleanValue,
  integrityChanged: booleanValue,
  semanticMajorChanged: booleanValue,
  runtimeKindChanged: booleanValue,
  executableIdentityChanged: booleanValue,
  executableCodeChanged: booleanValue,
  expansions: array(boundedString(512)),
  contractions: array(boundedString(512)),
  compatibilityPreserved: booleanValue,
  reasonCodes: array(machineString),
});

export const capabilitySnapshotSchema = object({
  ...envelope("snapshot", "capability.snapshot"),
  payload: object({
    capabilityRef: machineString,
    revision: integer(1),
    lifecycle: enumeration([
      "discovered",
      "review_required",
      "installation_proposed",
      "installation_approved",
      "active",
      "update_proposed",
      "update_approved",
      "disabled",
      "revoked",
      "uninstalled",
    ]),
    displayName: boundedString(512),
    sourceType: enumeration([
      "builtin",
      "tool",
      "skill",
      "package",
      "mcp",
      "program",
      "remote_api",
      "adapter",
    ]),
    sourceLocator: boundedString(),
    sourceIdentity: boundedString(512),
    version: machineString,
    integrity: machineString,
    signatureStatus: enumeration(["verified", "not_applicable", "invalid", "unknown"]),
    signerRef: nullable(machineString),
    operations: array(machineString),
    permissionRefs: array(machineString),
    dataClassifications: array(classificationSchema),
    networkScopes: array(boundedString(512)),
    filesystemScopes: array(boundedString(2048)),
    secretRefs: array(machineString),
    isolation: enumeration(["trusted_process", "worker", "sandbox", "remote"]),
    currency: boundedString(16),
    maxMicrosPerInvocation: integer(0),
    healthStatus: enumeration(["healthy", "degraded", "unhealthy", "unknown"]),
    healthCheckedAt: nullable(timestamp),
    reviewedBy: nullable(machineString),
    reviewedAt: nullable(timestamp),
    approvalRefs: array(machineString),
    dependencyTaskRefs: array(machineString),
    runtimeQualification: nullable(runtimeQualificationSnapshotSchema),
    pendingVersion: nullable(machineString),
    updateAssessment: nullable(updateAssessmentSnapshotSchema),
    rollbackVersion: nullable(machineString),
    rollbackAvailable: booleanValue,
    lastInvalidation: nullable(
      object({
        lifecycle: enumeration(["disabled"]),
        cancelledScheduledJobs: integer(0),
        occurredAt: timestamp,
      }),
    ),
    lastTransition: nullable(
      object({
        fromVersion: machineString,
        toVersion: machineString,
        outcome: enumeration(["activated", "rolled_back", "rejected"]),
        occurredAt: timestamp,
        externalEffectsRolledBack: literal(false),
        productStateRolledBack: literal(false),
      }),
    ),
    generatedAt: timestamp,
  }),
});

const grantDetailLinesSchema = array(boundedString(300));
const grantDetailSchema = object({
  "zh-CN": grantDetailLinesSchema,
  en: grantDetailLinesSchema,
  ja: grantDetailLinesSchema,
});

export const grantSnapshotSchema = object({
  ...envelope("snapshot", "grant.snapshot"),
  payload: object({
    grantId: machineString,
    revision: integer(1),
    kind: enumeration(["one_time", "long_term"]),
    status: enumeration(["active", "exhausted", "expired", "revoked"]),
    capabilityRef: machineString,
    capabilityVersion: machineString,
    operations: array(machineString),
    exactResourceRef: nullable(boundedString()),
    resourceIdentities: array(boundedString()),
    resourcePrefixes: array(boundedString()),
    maxDataClassification: classificationSchema,
    disclosure: enumeration(["none", "same_owner", "named_recipients", "public"]),
    sideEffects: array(enumeration(["none", "reversible", "irreversible"])),
    recipientRefs: array(boundedString(512)),
    maxCostMicrosPerUse: integer(0),
    maxFrequency: frequencySnapshotSchema,
    validFrom: timestamp,
    expiresAt: timestamp,
    uses: integer(0),
    maxUses: integer(1),
    spentCostMicros: integer(0),
    maxTotalCostMicros: integer(0),
    sourceApprovalRequestId: machineString,
    revokedAt: nullable(timestamp),
    revocationReasonCode: nullable(machineString),
    affectedTaskRefs: array(machineString),
    label: nullable(approvalDisplayText(301)),
    detail: grantDetailSchema,
    generatedAt: timestamp,
  }),
});

export const hostDirectorySnapshotSchema = object({
  ...envelope("snapshot", "host.directory.snapshot"),
  payload: object({
    grantId: machineString,
    revision: integer(1),
    hostId: machineString,
    displayPath: boundedString(4096),
    operations: array(hostFileOperationSchema),
    pathPolicy: literal("same_filesystem_no_links"),
    mountPolicy: literal("fixed_device"),
    disclosure: enumeration(["none", "model", "worker", "external_approved"]),
    expiresAt: timestamp,
    revokedAt: nullable(timestamp),
    preparedOperationRefs: array(machineString),
    trashRecordRefs: array(machineString),
    recoveryRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const workspaceSnapshotV2Schema = object({
  ...envelope("snapshot", "workspace.snapshot"),
  payload: object({
    workspaceId: machineString,
    snapshotId: machineString,
    revision: integer(1),
    hostId: machineString,
    repositoryKind: enumeration(["git", "non_git"]),
    branch: nullable(boundedString(512)),
    head: nullable(machineString),
    upstreamObservation: nullable(boundedString(1024)),
    detached: booleanValue,
    unborn: booleanValue,
    taskChangeSetRevision: integer(1),
    ownerPathRefs: array(machineString),
    taskPathRefs: array(machineString),
    concurrentPathRefs: array(machineString),
    commandProfileRefs: array(machineString),
    commandObservationRefs: array(machineString),
    commitPreviewRef: nullable(machineString),
    recoveryRefs: array(machineString),
    directoryGrantRefs: array(machineString),
    generatedAt: timestamp,
  }),
});

export const suggestionSnapshotSchema = object({
  ...envelope("snapshot", "suggestion.snapshot"),
  payload: object({
    suggestionId: machineString,
    revision: integer(1),
    status: enumeration([
      "candidate",
      "delivered",
      "approved",
      "rejected",
      "expired",
      "superseded",
    ]),
    kind: machineString,
    titleRef: machineString,
    bodyRef: machineString,
    evidenceRefs: array(machineString),
    sourceWatermark: machineString,
    goalRef: nullable(machineString),
    commitmentRef: nullable(machineString),
    confidencePermille: integer(0, 1000),
    noveltyPermille: integer(0, 1000),
    semanticKey: machineString,
    estimatedCapabilityRefs: array(machineString),
    estimatedDataClassifications: array(classificationSchema),
    estimatedCostMicros: integer(0),
    deliveryRef: nullable(machineString),
    taskRef: nullable(machineString),
    createdAt: timestamp,
    expiresAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const reflectionSnapshotSchema = object({
  ...envelope("snapshot", "reflection.snapshot"),
  payload: object({
    revision: integer(1),
    schedule: boundedString(256),
    timezone: boundedString(128),
    dailySuggestionQuota: integer(1, 20),
    maximumContextItems: integer(1),
    maximumCostMicros: integer(0),
    timeoutMs: integer(1),
    maximumCandidates: integer(1, 20),
    enabled: booleanValue,
    latestInputWatermark: nullable(machineString),
    latestOutcome: nullable(
      enumeration(["running", "no_change", "candidates", "missed", "failed"]),
    ),
    latestErrorCode: nullable(machineString),
    generatedAt: timestamp,
  }),
});

export const delegationSnapshotSchema = object({
  ...envelope("snapshot", "delegation.snapshot"),
  payload: object({
    delegationId: machineString,
    revision: integer(1),
    parentRunId: machineString,
    workerRunId: machineString,
    traceRef: machineString,
    subtaskRef: machineString,
    outputSchemaRef: machineString,
    contextRefs: array(machineString),
    capabilityHandleRefs: array(machineString),
    allowedModelRefs: array(modelRefString),
    dataClassification: classificationSchema,
    maximumDurationMs: integer(1),
    maximumCostMicros: integer(0),
    maximumProgressEvents: integer(1),
    status: enumeration(["created", "running", "validating", "completed", "failed", "cancelled"]),
    resultRef: nullable(machineString),
    failureReasonCode: nullable(machineString),
    createdAt: timestamp,
    updatedAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const improvementSnapshotSchema = object({
  ...envelope("snapshot", "improvement.snapshot"),
  payload: object({
    candidateId: machineString,
    revision: integer(1),
    baseRevision: machineString,
    baseDigest: machineString,
    observableProblemRef: machineString,
    goalRef: machineString,
    invariantRefs: array(machineString),
    allowedPathRefs: array(machineString),
    patchRef: nullable(machineString),
    patchDigest: nullable(machineString),
    validationRefs: array(machineString),
    comparisonRef: nullable(machineString),
    artifactRef: nullable(machineString),
    artifactDigest: nullable(machineString),
    risk: riskSchema,
    protectedRootFacts: array(machineString),
    status: enumeration([
      "proposed",
      "patching",
      "validating",
      "rejected_by_validation",
      "security_failure",
      "review_required",
      "rejected",
      "revision_requested",
      "expired",
    ]),
    reviewRequired: literal(true),
    expiresAt: timestamp,
    generatedAt: timestamp,
  }),
});

export const streamEventV2Schema = object({
  ...envelope("event", "stream.event"),
  payload: object({
    cursor: machineString,
    retentionStartCursor: machineString,
    eventId: machineString,
    scopeKind: enumeration(["agent", "thread", "run", "job", "inbox", "memory", "identity"]),
    scopeId: machineString,
    sequence: integer(1),
    occurredAt: timestamp,
    eventType: machineString,
    payloadRef: nullable(machineString),
  }),
});

const schemasByType = {
  "thread.message.submit": submitThreadMessageCommandSchema,
  "approval.respond": respondApprovalV2CommandSchema,
  "search.authorization.set": searchAuthorizationCommandSchema,
  "search.authorization.read": searchAuthorizationQuerySchema,
  "search.authorization.snapshot": searchAuthorizationSnapshotSchema,
  "push.subscription.set": pushSubscriptionCommandSchema,
  "push.kind.set": pushKindCommandSchema,
  "push.test": pushTestCommandSchema,
  "presence.heartbeat": presenceHeartbeatCommandSchema,
  "push.feedback.record": pushFeedbackCommandSchema,
  "push.status.read": pushStatusQuerySchema,
  "push.status.snapshot": pushStatusSnapshotSchema,
  "proactive.overview.read": proactiveOverviewQuerySchema,
  "proactive.overview.snapshot": proactiveOverviewSnapshotSchema,
  "proactive.settings.set": proactiveSettingsSetCommandSchema,
  "proactive.pause": proactivePauseCommandSchema,
  "proactive.insight.respond": proactiveInsightRespondCommandSchema,
  "proactive.decision.rate": proactiveDecisionRateCommandSchema,
  "proactive.audit.respond": proactiveAuditRespondCommandSchema,
  "proactive.review.read": proactiveReviewQuerySchema,
  "proactive.review.snapshot": proactiveReviewSnapshotSchema,
  "proactive.review.rate": proactiveReviewRateCommandSchema,
  "proactive.review.checkup": proactiveReviewCheckupCommandSchema,
  "proactive.source.manage": proactiveSourceManageCommandSchema,
  "proactive.backoff.restore": proactiveBackoffRestoreCommandSchema,
  "proactive.sources.read": proactiveSourcesQuerySchema,
  "proactive.sources.snapshot": proactiveSourcesSnapshotSchema,
  "proactive.source.settings.set": proactiveSourceSettingsSetCommandSchema,
  "proactive.source.switch_off": proactiveSourceSwitchOffCommandSchema,
  "muse.overview.read": museOverviewQuerySchema,
  "muse.overview.snapshot": museOverviewSnapshotSchema,
  "muse.item.rate": museItemRateCommandSchema,
  "muse.intake.set": museIntakeSetCommandSchema,
  "muse.data.clear": museDataClearCommandSchema,
  "proactive.weekly.read": proactiveWeeklyQuerySchema,
  "proactive.weekly.snapshot": proactiveWeeklySnapshotSchema,
  "proactive.observation.start": proactiveObservationStartCommandSchema,
  "proactive.gapcase.mark": proactiveGapCaseMarkCommandSchema,
  "owner.preferences.read": ownerPreferencesQuerySchema,
  "owner.preferences.snapshot": ownerPreferencesSnapshotSchema,
  "owner.preferences.set": ownerPreferencesSetCommandSchema,
  "delivery_timing.settings.read": deliveryTimingSettingsQuerySchema,
  "delivery_timing.settings.snapshot": deliveryTimingSettingsSnapshotSchema,
  "delivery_timing.settings.change": deliveryTimingSettingsChangeCommandSchema,
  "quiet_hours.read": quietHoursQuerySchema,
  "quiet_hours.snapshot": quietHoursSnapshotSchema,
  "quiet_hours.set": quietHoursSetCommandSchema,
  "proposals.read": proposalsQuerySchema,
  "proposals.snapshot": proposalsSnapshotSchema,
  "proposal.respond": proposalRespondCommandSchema,
  "device.list.read": deviceListQuerySchema,
  "device.list.snapshot": deviceListSnapshotSchema,
  "device.pairing.start": devicePairingStartCommandSchema,
  "device.pairing.confirm": devicePairingConfirmCommandSchema,
  "device.rename": deviceRenameCommandSchema,
  "device.revoke": deviceRevokeCommandSchema,
  "perception.status.read": perceptionStatusQuerySchema,
  "perception.status.snapshot": perceptionStatusSnapshotSchema,
  "perception.day.read": perceptionDayQuerySchema,
  "perception.day.snapshot": perceptionDaySnapshotSchema,
  "perception.episode.read": perceptionEpisodeQuerySchema,
  "perception.episode.snapshot": perceptionEpisodeSnapshotSchema,
  "perception.usage.read": perceptionUsageQuerySchema,
  "perception.usage.snapshot": perceptionUsageSnapshotSchema,
  "perception.settings.change": perceptionSettingsChangeCommandSchema,
  "think.settings.read": thinkSettingsQuerySchema,
  "think.settings.snapshot": thinkSettingsSnapshotSchema,
  "think.settings.change": thinkSettingsChangeCommandSchema,
  "server.status.read": serverStatusQuerySchema,
  "server.status.snapshot": serverStatusSnapshotSchema,
  "home.read": homeQuerySchema,
  "home.snapshot": homeSnapshotSchema,
  "search.ask.read": searchAskQuerySchema,
  "search.ask.snapshot": searchAskSnapshotSchema,
  "data.export.start": dataExportStartCommandSchema,
  "data.export.cancel": dataExportCancelCommandSchema,
  "data.export.status.read": dataExportStatusQuerySchema,
  "data.export.status.snapshot": dataExportStatusSnapshotSchema,
  "files.list.read": filesListQuerySchema,
  "files.list.snapshot": filesListSnapshotSchema,
  "login.devices.read": loginDevicesQuerySchema,
  "login.devices.snapshot": loginDevicesSnapshotSchema,
  "login.device.revoke": loginDeviceRevokeCommandSchema,
  "mcp.connections.read": mcpConnectionsQuerySchema,
  "mcp.connections.snapshot": mcpConnectionsSnapshotSchema,
  "mcp.connection.create": mcpConnectionCreateCommandSchema,
  "mcp.connection.change": mcpConnectionChangeCommandSchema,
  "mcp.connection.rotate": mcpConnectionRotateCommandSchema,
  "login.devices.revoke_others": loginDevicesRevokeOthersCommandSchema,
  "sensitive.interceptions.read": sensitiveInterceptionsQuerySchema,
  "sensitive.interceptions.snapshot": sensitiveInterceptionsSnapshotSchema,
  "sensitive.interceptions.clear": sensitiveInterceptionsClearCommandSchema,
  "memory.overview.read": memoryOverviewQuerySchema,
  "memory.overview.snapshot": memoryOverviewSnapshotSchema,
  "memory.basis.read": memoryBasisQuerySchema,
  "memory.basis.snapshot": memoryBasisSnapshotSchema,
  "memory.classify.read": memoryClassifyQuerySchema,
  "memory.classify.snapshot": memoryClassifySnapshotSchema,
  "memory.import.duplicates.read": memoryImportDuplicatesQuerySchema,
  "memory.import.duplicates.snapshot": memoryImportDuplicatesSnapshotSchema,
  "decision.chain.read": decisionChainQuerySchema,
  "decision.chain.snapshot": decisionChainSnapshotSchema,
  "decision.email.read": decisionEmailQuerySchema,
  "decision.email.snapshot": decisionEmailSnapshotSchema,
  "memory.approval.respond": memoryApprovalRespondCommandSchema,
  "memory.tidy.undo": memoryTidyUndoCommandSchema,
  "memory.conversationReview.undo": memoryConversationReviewUndoCommandSchema,
  "memory.reminder.respond": memoryReminderRespondCommandSchema,
  "memory.reminder.create": memoryReminderCreateCommandSchema,
  "memory.rules.read": memoryRulesQuerySchema,
  "memory.rules.snapshot": memoryRulesSnapshotSchema,
  "memory.rule.respond": memoryRuleRespondCommandSchema,
  "memory.review.read": memoryReviewQuerySchema,
  "memory.review.snapshot": memoryReviewSnapshotSchema,
  "memory.review.respond": memoryReviewRespondCommandSchema,
  "memory.review.reportMissed": memoryReviewReportMissedCommandSchema,
  "memory.create": memoryCreateCommandSchema,
  "memory.category.set": memoryCategorySetCommandSchema,
  "memory.settings.set": memorySettingsSetCommandSchema,
  "memory.page.viewed": memoryPageViewedCommandSchema,
  "memory.person.respond": memoryPersonRespondCommandSchema,
  "memory.import.commit": memoryImportCommitCommandSchema,
  "memory.import.undo": memoryImportUndoCommandSchema,
  "memory.external.respond": memoryExternalRespondCommandSchema,
  "memory.external.undo": memoryExternalUndoCommandSchema,
  "memory.mcpSync.projectDecide": memoryMcpSyncProjectDecideCommandSchema,
  "memory.mcpSync.noteDecide": memoryMcpSyncNoteDecideCommandSchema,
  "memory.mcpSync.attentionResolve": memoryMcpSyncAttentionResolveCommandSchema,
  "github.monitor.set_state": setGitHubMonitorStateCommandSchema,
  "memory.mutate": mutateMemoryCommandSchema,
  "grant.revoke": revokeGrantCommandSchema,
  "capability.review": reviewCapabilityCommandSchema,
  "capability.install.approve": approveCapabilityInstallationCommandSchema,
  "capability.update.respond": respondCapabilityUpdateCommandSchema,
  "capability.disable": disableCapabilityCommandSchema,
  "capability.rollback": rollbackCapabilityCommandSchema,
  "capability.reactivate": reactivateCapabilityCommandSchema,
  "host.file.prepare": prepareHostFileCommandSchema,
  "host.file.execute": executeHostFileCommandSchema,
  "workspace.copy.create": createWorkspaceCopyCommandSchema,
  "workspace.copy.prepare": prepareWorkspaceCopyCommandSchema,
  "workspace.copy.select": selectWorkspaceCopyCommandSchema,
  "workspace.stage": stageWorkspaceCommandSchema,
  "workspace.commit": commitWorkspaceCommandSchema,
  "suggestion.respond": respondSuggestionCommandSchema,
  "reflection.configure": configureReflectionCommandSchema,
  "improvement.review": reviewImprovementCommandSchema,
  "thread.list": listThreadsQuerySchema,
  "approval.list": listApprovalsQuerySchema,
  "approval.detail": approvalDetailQuerySchema,
  "capability.list": capabilityListQuerySchema,
  "capability.detail": capabilityDetailQuerySchema,
  "grant.list": grantListQuerySchema,
  "grant.detail": grantDetailQuerySchema,
  "host.directory.detail": hostDirectoryDetailQuerySchema,
  "workspace.detail": workspaceDetailQuerySchema,
  "workspace.list": workspaceListQuerySchema,
  "suggestion.list": suggestionListQuerySchema,
  "suggestion.detail": suggestionDetailQuerySchema,
  "reflection.detail": reflectionDetailQuerySchema,
  "delegation.detail": delegationDetailQuerySchema,
  "delegation.list": delegationListQuerySchema,
  "improvement.list": improvementListQuerySchema,
  "improvement.detail": improvementDetailQuerySchema,
  "collection.snapshot": collectionSnapshotSchema,
  "approval.snapshot": approvalSnapshotSchema,
  "capability.snapshot": capabilitySnapshotSchema,
  "grant.snapshot": grantSnapshotSchema,
  "host.directory.snapshot": hostDirectorySnapshotSchema,
  "workspace.snapshot": workspaceSnapshotV2Schema,
  "suggestion.snapshot": suggestionSnapshotSchema,
  "reflection.snapshot": reflectionSnapshotSchema,
  "delegation.snapshot": delegationSnapshotSchema,
  "improvement.snapshot": improvementSnapshotSchema,
  "stream.event": streamEventV2Schema,
} as const satisfies Record<GatewayV2MessageType, Schema<unknown>>;

type SchemaByType = typeof schemasByType;

export type GatewayV2Message = InferSchema<SchemaByType[keyof SchemaByType]>;
export type GatewayV2Command = Extract<GatewayV2Message, { kind: "command" }>;
export type GatewayV2Query = Extract<GatewayV2Message, { kind: "query" }>;
export type GatewayV2Snapshot = Extract<GatewayV2Message, { kind: "snapshot" }>;
export type GatewayV2Event = Extract<GatewayV2Message, { kind: "event" }>;

function readType(input: unknown): GatewayV2MessageType {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError("$", "expected a Gateway v2 message object");
  }
  return enumeration(GATEWAY_V2_MESSAGE_TYPES).parse(
    (input as { readonly type?: unknown }).type,
    "$.type",
  );
}

function parseGatewayV2Message(input: unknown): GatewayV2Message {
  const parsed = schemasByType[readType(input)].parse(input, "$") as GatewayV2Message;
  if (
    parsed.kind === "command" &&
    (parsed.risk === "high" || parsed.risk === "critical") &&
    parsed.authorizationRef === null
  ) {
    throw new ContractValidationError(
      "$.authorizationRef",
      "high and critical risk commands require an authorization reference",
    );
  }
  if (
    parsed.type === "host.file.prepare" &&
    (parsed.payload.operation === "permanent_delete") !==
      (parsed.payload.irreversibleScopeRef !== null)
  ) {
    throw new ContractValidationError(
      "$.payload.irreversibleScopeRef",
      "only permanent deletion requires an irreversible scope reference",
    );
  }
  if (
    parsed.type === "host.file.prepare" &&
    ["create", "update"].includes(parsed.payload.operation) !==
      (parsed.payload.candidatePayloadRef !== null)
  ) {
    throw new ContractValidationError(
      "$.payload.candidatePayloadRef",
      "only create and update require a candidate payload",
    );
  }
  if (
    parsed.type === "host.file.execute" &&
    parsed.payload.operation === "permanent_delete" &&
    parsed.payload.recentAuthenticationRef === null
  ) {
    throw new ContractValidationError(
      "$.payload.recentAuthenticationRef",
      "permanent deletion requires recent authentication",
    );
  }
  if (parsed.type === "workspace.stage" && parsed.payload.taskPathRefs.length === 0) {
    throw new ContractValidationError(
      "$.payload.taskPathRefs",
      "workspace staging requires at least one task-owned path reference",
    );
  }
  return parsed;
}

export const gatewayV2MessageSchema = Object.freeze({
  schemaVersion: GATEWAY_V2_SCHEMA_VERSION,
  parse(input: unknown): GatewayV2Message {
    return parseGatewayV2Message(input);
  },
  parseJson(json: string): GatewayV2Message {
    return parseJson({ parse: parseGatewayV2Message }, json);
  },
  serialize(message: GatewayV2Message): string {
    return JSON.stringify(parseGatewayV2Message(message));
  },
});
