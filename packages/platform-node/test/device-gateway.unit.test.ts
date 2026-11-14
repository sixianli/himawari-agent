import type {
  AgentGatewayV2Port,
  AuditLedgerPort,
  AuditRecord,
  GatewayAuthenticationContext,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  classifyDeviceGatewayRequest,
  type DeviceGatewayAuditFailure,
  dispatchDeviceGatewayRequest,
} from "../src/device-gateway.ts";

const authentication: GatewayAuthenticationContext = {
  subjectId: "subject-1",
  ownerId: "owner-1",
  deviceId: "device-1",
  authenticatedAt: "2026-11-12T00:00:00.000Z",
  authenticationRef: "auth-ref-1",
};
const authority = {
  agentId: "agent-1",
  deploymentId: "deployment-1",
  authorityEpoch: 1,
  fencingToken: 1,
};

function ledger(failAfter: number) {
  const records: AuditRecord[] = [];
  const audit: AuditLedgerPort = {
    async append(record) {
      if (records.length >= failAfter) throw new Error("audit store unavailable");
      if (records.some((existing) => existing.id === record.id)) throw new Error("PORT_DUPLICATE");
      records.push(record);
    },
    async listByAgent() {
      return records;
    },
  };
  return { audit, records };
}

function pause() {
  return classifyDeviceGatewayRequest({
    gateway: "v2",
    type: "proactive.pause",
    messageId: "device-message-1",
    idempotencyKey: "device-key-1",
    dataClassification: "private",
    risk: "low",
    payload: {},
  });
}

function dispatch(
  audit: AuditLedgerPort,
  v2: AgentGatewayV2Port,
  onAuditFailed?: (failure: DeviceGatewayAuditFailure) => void,
) {
  return dispatchDeviceGatewayRequest({
    request: pause(),
    confirmed: false,
    pairedDeviceId: "paired-1",
    authentication,
    authority,
    gateways: { v2 },
    audit,
    ...(onAuditFailed ? { onAuditFailed } : {}),
    now: () => new Date("2026-11-12T00:00:00.000Z"),
  });
}

const succeeding = { request: async () => ({ ok: true }) } as unknown as AgentGatewayV2Port;
const failing = {
  request: async () => {
    throw new Error("downstream failed");
  },
} as unknown as AgentGatewayV2Port;

describe("[第11批] 设备网关审计", () => {
  it.each([
    ["completed", succeeding],
    ["failed", failing],
  ] as const)("同一次请求的审计共用一个前缀，同一毫秒内受理排在%s之前", async (outcome, v2) => {
    const { audit, records } = ledger(Number.POSITIVE_INFINITY);
    await dispatch(audit, v2).catch(() => undefined);
    expect(records.map((record) => record.outcome)).toEqual(["accepted", outcome]);
    const [accepted, finished] = records.map((record) => record.id);
    const prefix = accepted?.slice(0, -":accepted".length);
    expect(accepted).toMatch(/^audit:device-gateway:[0-9a-f-]{36}:accepted$/u);
    expect(finished).toBe(`${prefix}:${outcome}`);
    expect([...records].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.outcome)).toEqual([
      "accepted",
      outcome,
    ]);
  });

  it.each([
    ["completed", succeeding],
    ["failed", failing],
  ] as const)("记%s失败时报给服务器日志，结果和错误照常返回", async (outcome, v2) => {
    const { audit, records } = ledger(1);
    const failures: DeviceGatewayAuditFailure[] = [];
    const settled = await dispatch(audit, v2, (failure) => failures.push(failure)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(settled).toEqual(
      outcome === "completed" ? { value: { ok: true } } : { error: new Error("downstream failed") },
    );
    expect(records.map((record) => record.outcome)).toEqual(["accepted"]);
    expect(failures).toEqual([
      {
        action: "device.gateway.tighten",
        targetRef: "paired-1:v2:proactive.pause",
        outcome,
        error: new Error("audit store unavailable"),
      },
    ]);
  });

  it.each([
    ["completed", succeeding],
    ["failed", failing],
  ] as const)("报日志的回调自己出错时，记%s的结果和错误照常返回", async (outcome, v2) => {
    const { audit } = ledger(1);
    const settled = dispatch(audit, v2, () => {
      throw new Error("diagnostic sink failed");
    });
    if (outcome === "completed") await expect(settled).resolves.toEqual({ ok: true });
    else await expect(settled).rejects.toThrow("downstream failed");
  });

  it("执行后记完成失败时，已执行的结果照常返回，受理记录还在", async () => {
    const { audit, records } = ledger(1);
    await expect(dispatch(audit, succeeding)).resolves.toEqual({ ok: true });
    expect(records.map((record) => record.outcome)).toEqual(["accepted"]);
  });

  it("执行失败且记失败也失败时，抛出的是执行的错误", async () => {
    const { audit, records } = ledger(1);
    await expect(dispatch(audit, failing)).rejects.toThrow("downstream failed");
    expect(records.map((record) => record.outcome)).toEqual(["accepted"]);
  });

  it("记受理失败时不执行", async () => {
    const { audit } = ledger(0);
    let called = false;
    const watched = {
      request: async () => {
        called = true;
        return {};
      },
    } as unknown as AgentGatewayV2Port;
    await expect(dispatch(audit, watched)).rejects.toThrow("audit store unavailable");
    expect(called).toBe(false);
  });
});
