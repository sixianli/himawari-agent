export const DEVICE_HARD_LIMIT_KEYS = [
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

export type DeviceHardLimitKey = (typeof DEVICE_HARD_LIMIT_KEYS)[number];

export interface DeviceHardLimitDefinition {
  readonly key: DeviceHardLimitKey;
  readonly unit: "bytes" | "records" | "items" | "points" | "entries" | "characters" | "nonces";
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly onExceed:
    | "reject"
    | "stop_and_discard_file"
    | "reject_batch"
    | "drop_oldest"
    | "split_extraction"
    | "reject_device_requests_and_warn";
}

export const DEVICE_HARD_LIMITS: Readonly<Record<DeviceHardLimitKey, DeviceHardLimitDefinition>> =
  Object.freeze({
    "device.request.body_bytes": {
      key: "device.request.body_bytes",
      unit: "bytes",
      defaultValue: 1_048_576,
      minimum: 1024,
      maximum: 16_777_216,
      onExceed: "reject",
    },
    "device.upload.file_bytes": {
      key: "device.upload.file_bytes",
      unit: "bytes",
      defaultValue: 209_715_200,
      minimum: 1_048_576,
      maximum: 2_147_483_648,
      onExceed: "reject",
    },
    "device.upload.expanded_bytes": {
      key: "device.upload.expanded_bytes",
      unit: "bytes",
      defaultValue: 524_288_000,
      minimum: 1_048_576,
      maximum: 8_589_934_592,
      onExceed: "stop_and_discard_file",
    },
    "device.perception.batch_records": {
      key: "device.perception.batch_records",
      unit: "records",
      defaultValue: 500,
      minimum: 1,
      maximum: 10_000,
      onExceed: "reject_batch",
    },
    "device.mirror.batch_items": {
      key: "device.mirror.batch_items",
      unit: "items",
      defaultValue: 1000,
      minimum: 1,
      maximum: 20_000,
      onExceed: "reject_batch",
    },
    "device.track.batch_points": {
      key: "device.track.batch_points",
      unit: "points",
      defaultValue: 2000,
      minimum: 1,
      maximum: 50_000,
      onExceed: "reject_batch",
    },
    "device.prefetch.cache.entries": {
      key: "device.prefetch.cache.entries",
      unit: "entries",
      defaultValue: 20,
      minimum: 1,
      maximum: 500,
      onExceed: "drop_oldest",
    },
    "device.prefetch.cache.bytes": {
      key: "device.prefetch.cache.bytes",
      unit: "bytes",
      defaultValue: 204_800,
      minimum: 1024,
      maximum: 67_108_864,
      onExceed: "drop_oldest",
    },
    "perception.extract.max_chars": {
      key: "perception.extract.max_chars",
      unit: "characters",
      defaultValue: 60_000,
      minimum: 1000,
      maximum: 500_000,
      onExceed: "split_extraction",
    },
    "device.nonce.retained": {
      key: "device.nonce.retained",
      unit: "nonces",
      defaultValue: 10_000,
      minimum: 100,
      maximum: 1_000_000,
      onExceed: "reject_device_requests_and_warn",
    },
  });

export type DeviceHardLimits = Readonly<Record<DeviceHardLimitKey, number>>;

export interface DeviceConfiguration {
  readonly signatureToleranceSeconds: number;
  readonly heartbeatSeconds: number;
  readonly connectionMaxSeconds: number;
  readonly streamConnections: number;
  readonly prefetchSeconds: number;
  readonly limits: DeviceHardLimits;
}

export const DEVICE_CONFIGURATION_DEFAULTS = Object.freeze({
  signatureToleranceSeconds: 60,
  heartbeatSeconds: 20,
  connectionMaxSeconds: 3600,
  streamConnections: 4,
  prefetchSeconds: 60,
});

export function defaultDeviceHardLimits(): DeviceHardLimits {
  return Object.freeze(
    Object.fromEntries(
      DEVICE_HARD_LIMIT_KEYS.map((key) => [key, DEVICE_HARD_LIMITS[key].defaultValue]),
    ) as Record<DeviceHardLimitKey, number>,
  );
}
