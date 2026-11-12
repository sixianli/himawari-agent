import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type LocaleFormat, useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import { ActionButton } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string | number>) => string;

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

type DeviceLimitKey = (typeof DEVICE_LIMIT_KEYS)[number];

export interface PairedDeviceView {
  readonly id: string;
  readonly revision: number;
  readonly kind: "iphone" | "watch" | "mac";
  readonly name: string;
  readonly status: "pending" | "active" | "revoked";
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly pairingNumber: string | null;
}

export interface DeviceLimitView {
  readonly key: DeviceLimitKey;
  readonly unit: string;
  readonly value: number;
}

interface Pairing {
  readonly uri: string;
  readonly expiresAt: string;
}

const limitLabels: Readonly<Record<DeviceLimitKey, MessageId>> = {
  "device.request.body_bytes": "devices.limit.requestBody",
  "device.upload.file_bytes": "devices.limit.uploadFile",
  "device.upload.expanded_bytes": "devices.limit.uploadExpanded",
  "device.perception.batch_records": "devices.limit.perceptionBatch",
  "device.mirror.batch_items": "devices.limit.mirrorBatch",
  "device.track.batch_points": "devices.limit.trackBatch",
  "device.prefetch.cache.entries": "devices.limit.prefetchEntries",
  "device.prefetch.cache.bytes": "devices.limit.prefetchBytes",
  "perception.extract.max_chars": "devices.limit.extractChars",
  "device.nonce.retained": "devices.limit.nonces",
};

const kindLabels: Readonly<Record<PairedDeviceView["kind"], MessageId>> = {
  iphone: "devices.kind.iphone",
  watch: "devices.kind.watch",
  mac: "devices.kind.mac",
};

const PENDING_POLL_MILLISECONDS = 3000;

async function deviceRequest(path: string, csrfToken: string, body: unknown = {}) {
  const response = await fetch(`/api/devices/v1/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`DEVICE_REQUEST_${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export function pairingQrPath(uri: string): { readonly size: number; readonly path: string } {
  const code = qrcode(0, "M");
  code.addData(uri);
  code.make();
  const size = code.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row += 1)
    for (let column = 0; column < size; column += 1)
      if (code.isDark(row, column)) cells.push(`M${column + 4} ${row + 4}h1v1h-1z`);
  return { size: size + 8, path: cells.join("") };
}

function formatLimit(limit: DeviceLimitView, format: LocaleFormat): string {
  if (limit.unit !== "bytes") return format.number(limit.value, {});
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = limit.value;
  let index = 0;
  while (value >= 1024 && index < units.length - 1 && value % 1024 === 0) {
    value /= 1024;
    index += 1;
  }
  return `${format.number(value, {})} ${units[index]}`;
}

function DeviceRow({
  device,
  busy,
  message,
  onConfirm,
  onRename,
  onRevoke,
}: {
  readonly device: PairedDeviceView;
  readonly busy: boolean;
  readonly message: Message;
  readonly onConfirm: () => void;
  readonly onRename: (name: string) => void;
  readonly onRevoke: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const kind = message(kindLabels[device.kind]);
  return (
    <li className="device-row" data-status={device.status} data-device-id={device.id}>
      {editing ? (
        <form
          className="device-rename"
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            onRename(name);
          }}
        >
          <input
            className="setting-input"
            aria-label={message("devices.name")}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <ActionButton type="submit" variant="secondary" disabled={busy || !name.trim()}>
            {message("devices.save")}
          </ActionButton>
        </form>
      ) : (
        <div className="device-identity">
          <strong>{device.name}</strong>
          <span className="device-detail">
            {device.status === "pending"
              ? message("devices.pendingNotice", { kind, name: device.name })
              : device.status === "revoked"
                ? message("devices.revoked", { kind })
                : kind}
          </span>
          {device.status === "pending" && device.pairingNumber ? (
            <span className="device-detail" data-pairing-number={device.pairingNumber}>
              {message("devices.pairingNumber", {
                number: `${device.pairingNumber.slice(0, 3)} ${device.pairingNumber.slice(3)}`,
              })}
            </span>
          ) : null}
        </div>
      )}
      {device.status === "revoked" ? null : (
        <div className="device-actions">
          {device.status === "pending" ? (
            <ActionButton variant="primary" disabled={busy} onClick={onConfirm}>
              {message("devices.confirm")}
            </ActionButton>
          ) : editing ? null : (
            <ActionButton variant="quiet" disabled={busy} onClick={() => setEditing(true)}>
              {message("devices.rename")}
            </ActionButton>
          )}
          <ActionButton variant="secondary" disabled={busy} onClick={onRevoke}>
            {message("devices.revoke")}
          </ActionButton>
        </div>
      )}
    </li>
  );
}

export function DeviceSettings({
  csrfToken,
  message,
}: {
  readonly csrfToken: string;
  readonly message: Message;
}) {
  const format = useLocaleFormat();
  const [devices, setDevices] = useState<readonly PairedDeviceView[] | null>(null);
  const [limits, setLimits] = useState<readonly DeviceLimitView[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const body = await deviceRequest("list", csrfToken);
    setDevices(body["devices"] as PairedDeviceView[]);
    setLimits(body["limits"] as DeviceLimitView[]);
  }, [csrfToken]);

  useEffect(() => {
    void load().catch(() => setFailed(true));
  }, [load]);

  const hasPending = devices?.some((device) => device.status === "pending") ?? false;
  useEffect(() => {
    if (!pairing && !hasPending) return;
    const timer = setInterval(() => void load().catch(() => undefined), PENDING_POLL_MILLISECONDS);
    return () => clearInterval(timer);
  }, [pairing, hasPending, load]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const qr = useMemo(() => (pairing ? pairingQrPath(pairing.uri) : null), [pairing]);
  const act = (path: string, device: PairedDeviceView, extra: Record<string, unknown> = {}) =>
    run(() =>
      deviceRequest(path, csrfToken, {
        deviceId: device.id,
        expectedRevision: device.revision,
        ...extra,
      }),
    );

  return (
    <div className="device-settings">
      <div className="setting-row">
        <span>{message("devices.help")}</span>
        <ActionButton
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const body = await deviceRequest("pairing-codes", csrfToken);
              setPairing({
                uri: body["pairingUri"] as string,
                expiresAt: body["expiresAt"] as string,
              });
            })
          }
        >
          {message("devices.add")}
        </ActionButton>
      </div>
      {pairing && qr ? (
        <figure className="device-pairing">
          <svg
            className="device-pairing-code"
            role="img"
            aria-label={message("devices.qrLabel")}
            data-pairing-uri={pairing.uri}
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            shapeRendering="crispEdges"
          >
            <rect width={qr.size} height={qr.size} fill="#fff" />
            <path d={qr.path} fill="#000" />
          </svg>
          <figcaption>
            {message("devices.qrHelp", {
              time: format.clockShort(pairing.expiresAt),
            })}
          </figcaption>
        </figure>
      ) : null}
      {devices === null ? null : devices.length === 0 ? (
        <p className="settings-note">{message("devices.empty")}</p>
      ) : (
        <ul className="device-list" aria-label={message("devices.listLabel")}>
          {devices.map((device) => (
            <DeviceRow
              key={`${device.id}:${device.revision}`}
              device={device}
              busy={busy}
              message={message}
              onConfirm={() => {
                setPairing(null);
                void act("confirm", device);
              }}
              onRename={(name) => void act("rename", device, { name })}
              onRevoke={() => void act("revoke", device)}
            />
          ))}
        </ul>
      )}
      {failed ? <p role="alert">{message("devices.failed")}</p> : null}
      {limits.length > 0 ? (
        <section className="device-limits" aria-label={message("devices.limitsLabel")}>
          <h3>{message("devices.limitsLabel")}</h3>
          <p className="settings-note">{message("devices.limitsHelp")}</p>
          <dl>
            {limits.map((limit) => (
              <div key={limit.key} data-limit-key={limit.key}>
                <dt>{message(limitLabels[limit.key])}</dt>
                <dd>{formatLimit(limit, format)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
