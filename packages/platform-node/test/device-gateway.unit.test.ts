import type {
  AgentGatewayV2Port,
  AuditLedgerPort,
  AuditRecord,
  GatewayAuthenticationContext,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import {
  classifyDeviceGatewayRequest,
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

function dispatch(audit: AuditLedgerPort, v2: AgentGatewayV2Port) {
  return dispatchDeviceGatewayRequest({
    request: pause(),
    confirmed: false,
    pairedDeviceId: "paired-1",
    authentication,
    authority,
    gateways: { v2 },
    audit,
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
  it("同一毫秒内受理排在完成之前", async () => {
    const { audit, records } = ledger(Number.POSITIVE_INFINITY);
    await dispatch(audit, succeeding);
    expect(records.map((record) => record.outcome)).toEqual(["accepted", "completed"]);
    expect([...records].sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.outcome)).toEqual([
      "accepted",
      "completed",
    ]);
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
