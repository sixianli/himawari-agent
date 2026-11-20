import { useEffect, useId, useState } from "react";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../gateway-client.js";
import { useLocaleFormat } from "../i18n/locale-format.js";
import type { MessageId } from "../i18n/message-ids.js";
import {
  changeMcpConnection,
  createMcpConnection,
  MCP_LOGPUSH_FIELDS_URL,
  type McpConnectionDraft,
  type McpConnectionItem,
  type McpConnectionsSnapshot,
  readMcpConnections,
  rotateMcpConnection,
  takeMcpConnectionAddress,
  withinNameLimit,
} from "../mcp-connections.js";
import { ActionButton, Dropdown } from "./primitives.js";

type Message = (id: MessageId, values?: Record<string, string>) => string;

const CAPABILITIES = ["mcp", "command_hooks", "scheduled_tasks"] as const;
const CEILINGS = ["public", "private", "sensitive"] as const;
const PUSH_POLICIES = ["direct", "ask"] as const;

export function McpUsageLines({
  usage,
  message,
}: {
  usage: McpConnectionItem["usage"];
  message: Message;
}) {
  const n = (value: number) => String(value);
  return (
    <ul className="mcp-usage">
      <li>
        {message("agents.stat.reads", { n: n(usage.reads) })}
        {usage.reads > 0
          ? ` (${usage.readsByTool
              .filter(({ calls }) => calls > 0)
              .map(({ tool, calls }) => message("agents.stat.byTool", { tool, n: n(calls) }))
              .join(" · ")})`
          : ""}
      </li>
      <li>{message("agents.stat.delivered", { n: n(usage.delivered) })}</li>
      <li>{message("agents.stat.empty", { n: n(usage.empty) })}</li>
      <li>
        {message("agents.stat.auto", {
          n: n(usage.autoReads),
          delivered: n(usage.autoDelivered),
        })}
      </li>
      <li>{message("agents.stat.model", { n: n(usage.modelReads) })}</li>
      <li>{message("agents.stat.pushes", { n: n(usage.memoryPushes) })}</li>
      <li>
        {message("agents.stat.rules", {
          n: n(usage.ruleProposals),
          limited: n(usage.ruleProposalsRateLimited),
        })}
      </li>
      <li>{message("agents.stat.failed", { n: n(usage.failed) })}</li>
      <li>{message("agents.stat.limited", { n: n(usage.rateLimited) })}</li>
    </ul>
  );
}

function AddressReveal({ address, message }: { address: string; message: Message }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="mcp-address" aria-label={message("agents.address.title")}>
      <strong>{message("agents.address.title")}</strong>
      <code data-testid="mcp-address">{address}</code>
      <ActionButton
        onClick={() =>
          void navigator.clipboard
            ?.writeText(address)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {message(copied ? "agents.copied" : "agents.copy")}
      </ActionButton>
      <small className="setting-description">{message("agents.address.hint")}</small>
    </section>
  );
}

function ConnectionRow({
  item,
  busy,
  address,
  message,
  onChange,
  onRotate,
}: {
  item: McpConnectionItem;
  busy: boolean;
  address: string | null;
  message: Message;
  onChange: (edit: Parameters<typeof changeMcpConnection>[3]) => void;
  onRotate: () => void;
}) {
  const format = useLocaleFormat();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"revoke" | "rotate" | null>(null);
  const revoked = item.status === "revoked";
  return (
    <li className="mcp-connection" data-status={item.status}>
      <div className="setting-row">
        <span>
          {renaming === null ? (
            <strong>{item.name}</strong>
          ) : (
            <input
              className="setting-input"
              aria-label={message("agents.name")}
              value={renaming}
              onChange={(event) => setRenaming(withinNameLimit(event.target.value))}
            />
          )}{" "}
          <span className="mcp-status">{message(`agents.status.${item.status}`)}</span>
          {item.reportedClient ? (
            <small className="setting-description">
              {message("agents.reported", { client: item.reportedClient })}
            </small>
          ) : null}
          <small className="setting-description">
            {item.lastSeenAt
              ? message("agents.lastSeen", { time: format.moment(item.lastSeenAt) })
              : message("agents.neverSeen")}
          </small>
        </span>
        {revoked ? null : (
          <>
            <Dropdown
              label={message("agents.ceiling")}
              value={item.readCeiling}
              options={CEILINGS.map((value) => ({
                value,
                label: message(`agents.ceiling.${value}`),
              }))}
              onChange={(readCeiling) => onChange({ readCeiling })}
            />
            <Dropdown
              label={message("agents.push")}
              value={item.pushPolicy}
              options={PUSH_POLICIES.map((value) => ({
                value,
                label: message(`agents.push.${value}`),
              }))}
              onChange={(pushPolicy) => onChange({ pushPolicy })}
            />
          </>
        )}
      </div>
      <McpUsageLines usage={item.usage} message={message} />
      {address ? <AddressReveal address={address} message={message} /> : null}
      {revoked ? null : (
        <div className="mcp-actions">
          {renaming === null ? (
            <ActionButton disabled={busy} onClick={() => setRenaming(item.name)}>
              {message("agents.rename")}
            </ActionButton>
          ) : (
            <>
              <ActionButton
                disabled={busy || renaming.trim().length === 0}
                onClick={() => {
                  onChange({ name: renaming });
                  setRenaming(null);
                }}
              >
                {message("agents.save")}
              </ActionButton>
              <ActionButton variant="quiet" onClick={() => setRenaming(null)}>
                {message("agents.cancel")}
              </ActionButton>
            </>
          )}
          <ActionButton
            disabled={busy}
            onClick={() => onChange({ status: item.status === "paused" ? "active" : "paused" })}
          >
            {message(item.status === "paused" ? "agents.resume" : "agents.pause")}
          </ActionButton>
          <ActionButton disabled={busy} onClick={() => setConfirm("rotate")}>
            {message("agents.rotate")}
          </ActionButton>
          <ActionButton variant="danger" disabled={busy} onClick={() => setConfirm("revoke")}>
            {message("agents.revoke")}
          </ActionButton>
        </div>
      )}
      {confirm ? (
        <div className="mcp-confirm" role="alertdialog" aria-label={message(`agents.${confirm}`)}>
          <span>
            {message(confirm === "revoke" ? "agents.revokeConfirm" : "agents.rotateConfirm")}
          </span>
          <ActionButton
            disabled={busy}
            onClick={() => {
              if (confirm === "revoke") onChange({ status: "revoked" });
              else onRotate();
              setConfirm(null);
            }}
          >
            {message(confirm === "revoke" ? "agents.revokeYes" : "agents.rotateYes")}
          </ActionButton>
          <ActionButton variant="quiet" onClick={() => setConfirm(null)}>
            {message("agents.cancel")}
          </ActionButton>
        </div>
      ) : null}
    </li>
  );
}

export function McpConnectionsSettings({
  client,
  configuration,
  connected,
  message,
  origin = typeof window === "undefined" ? "" : window.location.origin,
}: {
  client: GatewayClient;
  configuration: ControlCenterRuntimeConfiguration;
  connected: boolean;
  message: Message;
  origin?: string;
}) {
  const nameId = useId();
  const [snapshot, setSnapshot] = useState<McpConnectionsSnapshot | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [addresses, setAddresses] = useState<Readonly<Record<string, string>>>({});
  const [draft, setDraft] = useState<McpConnectionDraft>({
    name: "",
    capabilities: ["mcp"],
    readCeiling: "private",
    pushPolicy: "direct",
  });
  useEffect(() => {
    let disposed = false;
    void reload;
    if (connected)
      void readMcpConnections(client, configuration)
        .then((payload) => {
          if (!disposed) setSnapshot(payload);
        })
        .catch(() => {
          if (!disposed) setError(true);
        });
    return () => {
      disposed = true;
    };
  }, [client, configuration, connected, reload]);
  const run = async (work: () => Promise<string | null>) => {
    if (busy || !snapshot) return;
    setBusy(true);
    setError(false);
    try {
      const reveal = await work();
      if (reveal) {
        const address = await takeMcpConnectionAddress(snapshot.addressPath, reveal, origin);
        setAddresses((current) => ({ ...current, [reveal]: address }));
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setReload((value) => value + 1);
    }
  };
  const limit = (key: string) => snapshot?.limits.find((entry) => entry.key === key);
  const connections = snapshot?.connections ?? [];
  const live = connections.filter(({ status }) => status !== "revoked");
  const gone = connections.filter(({ status }) => status === "revoked");
  const limitLine = (key: string, id: MessageId) => {
    const entry = limit(key);
    return entry ? (
      <li key={key}>
        {message(id, { value: String(entry.value), used: String(entry.used ?? 0) })}
      </li>
    ) : null;
  };
  return (
    <section className="mcp-connections" aria-label={message("agents.title")}>
      <p className="setting-description">{message("agents.intro")}</p>
      <p className="setting-description">
        {message("agents.rotateHint")}{" "}
        <a href={MCP_LOGPUSH_FIELDS_URL} target="_blank" rel="noreferrer">
          {message("agents.rotateHintLink")}
        </a>
      </p>
      <form
        className="mcp-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim().length === 0) return;
          void run(async () => {
            const id = await createMcpConnection(client, configuration, draft);
            setDraft({ ...draft, name: "" });
            return id;
          });
        }}
      >
        <label className="setting-row" htmlFor={nameId}>
          <span>{message("agents.name")}</span>
          <input
            id={nameId}
            className="setting-input"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: withinNameLimit(event.target.value) })}
          />
        </label>
        <fieldset className="setting-row">
          <legend>{message("agents.capabilities")}</legend>
          {CAPABILITIES.map((capability) => (
            <label key={capability}>
              <input
                type="checkbox"
                checked={draft.capabilities.includes(capability)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    capabilities: event.target.checked
                      ? CAPABILITIES.filter(
                          (value) => value === capability || draft.capabilities.includes(value),
                        )
                      : draft.capabilities.filter((value) => value !== capability),
                  })
                }
              />
              {message(`agents.capability.${capability}`)}
            </label>
          ))}
        </fieldset>
        <div className="setting-row">
          <span>{message("agents.ceiling")}</span>
          <Dropdown
            label={message("agents.ceiling")}
            value={draft.readCeiling}
            options={CEILINGS.map((value) => ({
              value,
              label: message(`agents.ceiling.${value}`),
            }))}
            onChange={(readCeiling) => setDraft({ ...draft, readCeiling })}
          />
        </div>
        <div className="setting-row">
          <span>{message("agents.push")}</span>
          <Dropdown
            label={message("agents.push")}
            value={draft.pushPolicy}
            options={PUSH_POLICIES.map((value) => ({
              value,
              label: message(`agents.push.${value}`),
            }))}
            onChange={(pushPolicy) => setDraft({ ...draft, pushPolicy })}
          />
        </div>
        <ActionButton
          type="submit"
          disabled={!connected || busy || !snapshot || draft.name.trim().length === 0}
        >
          {message("agents.create")}
        </ActionButton>
      </form>
      {snapshot ? (
        <p className="setting-description">
          {message("agents.window", {
            days: String(snapshot.window.days),
            from: snapshot.window.fromDay,
            to: snapshot.window.toDay,
          })}
        </p>
      ) : null}
      <details className="settings-details">
        <summary>{message("agents.definitions")}</summary>
        <p>{message("agents.definitionsText")}</p>
      </details>
      {snapshot && live.length === 0 ? <p>{message("agents.empty")}</p> : null}
      <ul className="mcp-connection-list">
        {[...live, ...gone].map((item) => (
          <ConnectionRow
            key={item.id}
            item={item}
            busy={busy || !connected}
            address={addresses[item.id] ?? null}
            message={message}
            onChange={(edit) =>
              void run(async () => {
                await changeMcpConnection(client, configuration, item.id, edit);
                if (edit.status === "revoked")
                  setAddresses(({ [item.id]: _dropped, ...rest }) => rest);
                return null;
              })
            }
            onRotate={() =>
              void run(async () => {
                await rotateMcpConnection(client, configuration, item.id);
                return item.id;
              })
            }
          />
        ))}
      </ul>
      {snapshot ? (
        <section className="mcp-limits" aria-label={message("agents.limits")}>
          <strong>{message("agents.limits")}</strong>
          <ul>
            {limitLine("mcp.connections", "agents.limit.connections")}
            {limitLine("mcp.connection.name_characters", "agents.limit.name")}
            {limitLine("mcp.request.body_bytes", "agents.limit.body")}
            {limitLine("mcp.reads_per_minute", "agents.limit.reads")}
            {limitLine("mcp.hook_reads_per_minute", "agents.limit.hook")}
          </ul>
        </section>
      ) : null}
      {error ? (
        <div role="alert">
          {message("agents.error")}
          <ActionButton
            disabled={!connected || busy}
            onClick={() => setReload((value) => value + 1)}
          >
            {message("common.refresh")}
          </ActionButton>
        </div>
      ) : null}
    </section>
  );
}
