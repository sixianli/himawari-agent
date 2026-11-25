// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BuiltInActionRulesSection,
  OwnerAllowancesSection,
  OwnerRulesSection,
  RuleReceiptCard,
} from "../src/components/rule-receipt.tsx";
import type { ControlCenterRuntimeConfiguration, GatewayClient } from "../src/gateway-client.ts";
import type { MessageId } from "../src/i18n/message-ids.ts";
import { messages } from "../src/i18n/resources/zh-CN.ts";
import {
  type BuiltInActionRule,
  type OwnerAllowance,
  type OwnerRule,
  useMemory,
} from "../src/memory.ts";

const intl = createIntl({ locale: "zh-CN", messages });
const message = (id: MessageId, values?: Record<string, string | number>) =>
  intl.formatMessage({ id }, values);
const configuration: ControlCenterRuntimeConfiguration = {
  ownerId: "owner",
  agentId: "agent",
  deploymentId: "deployment",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner",
  csrfToken: "csrf-fixture",
  installedGatewayV2Operations: [
    "memory.overview.read",
    "memory.rules.read",
    "memory.rule.respond",
  ],
};
const query = vi.fn(),
  mutate = vi.fn();
const client = { query, mutate, protectText: vi.fn() } as unknown as GatewayClient;
let container: HTMLDivElement, root: Root;

const active = {
  status: "active",
  ruleId: "owner:0123456789abcdef01234567",
  proposalId: null,
  memoryId: "memory:rule:k",
  type: "mail_must_notify",
  summary: "日本入管局相关的邮件一律提醒",
  quote: "日本入管局相关的邮件以后必须通知我",
  trials: [
    { from: "info@mail.isa.go.jp", subject: "Hello", hit: true },
    { from: "nobody@unmatched.example", subject: "Lunch on Friday", hit: false },
  ],
  replay: {
    days: 30,
    mailsChecked: 120,
    mailsHit: 3,
    changed: 2,
    usefulChanged: [
      {
        messageId: "m1",
        decidedAt: "2026-11-01T00:00:00.000Z",
        from: "入管 <no-reply@isa.go.jp>",
        subject: "在留カード",
        before: "ignore",
        after: "check",
        rating: "useful",
      },
    ],
    headersOnly: 80,
    truncated: false,
  },
  replayed: false,
};

const rule = (change: Partial<OwnerRule> = {}): OwnerRule => ({
  ruleId: "owner:0123456789abcdef01234567",
  type: "mail_read_whole_thread",
  summary: "涉及退款的邮件先读完整个邮件串",
  status: "active",
  enforced: true,
  updatedAt: "2026-11-11T00:00:00.000Z",
  quote: null,
  quoteSuperseded: false,
  quoteLatestMemoryId: null,
  changes: 0,
  lastUsed: null,
  ...change,
});

const allowance = (change: Partial<OwnerAllowance> = {}): OwnerAllowance => ({
  allowanceId: "allowance:0123456789abcdef",
  allowFor: "days",
  title: "回复 张三：周四下午 3 点可以",
  operation: "send",
  recipients: ["zhangsan@example.com"],
  threadId: null,
  threadTitle: null,
  expiresAt: "2026-11-18T00:00:00.000Z",
  createdAt: "2026-11-11T00:00:00.000Z",
  ...change,
});
const builtIn = (change: Partial<BuiltInActionRule> = {}): BuiltInActionRule => ({
  ruleId: "action_preauthorize_owner_data",
  revision: 1,
  outcome: "allow_preauthorized",
  examplesHit: 2,
  examplesMiss: 6,
  askFirst: false,
  ...change,
});

async function show(node: ReturnType<typeof h>) {
  await act(async () => root.render(node));
  await act(async () => {});
}

const buttons = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent);

async function press(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  await act(async () => found.click());
  await act(async () => {});
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[P2-3] standing rules on the web page", () => {
  it("shows the receipt of a new rule with its trial run, replay numbers and an undo that works once", async () => {
    const respondRule = vi.fn(async () => true);
    await show(
      h(RuleReceiptCard, {
        output: JSON.stringify(active),
        memory: { respondRule, busy: false },
        message,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("已立为长期规则");
    expect(text).toContain("日本入管局相关的邮件一律提醒");
    expect(text).toContain("会命中：info@mail.isa.go.jp · Hello");
    expect(text).toContain("不会命中：nobody@unmatched.example · Lunch on Friday");
    expect(text).toContain("重算了 120 封");
    expect(text).toContain("现在会改成要你看");
    expect(text).toContain("规则命中 3 封");
    expect(text).toContain("你评过“有用”的有 1 封");
    expect(text).toContain("在留カード");
    expect(text).toContain("可能偏多也可能偏少");
    await press("撤销");
    expect(respondRule).toHaveBeenCalledWith("owner:0123456789abcdef01234567", "undo");
    expect(container.textContent).toContain("已撤销");
    expect(buttons()).toEqual([]);
  });

  it("offers Apply only on a proposal, and shows nothing for a rule she still has to ask about or a failed call", async () => {
    const respondRule = vi.fn(async () => true);
    await show(
      h(RuleReceiptCard, {
        output: JSON.stringify({
          ...active,
          status: "proposed",
          ruleId: null,
          proposalId: "rule-proposal:0123456789abcdef0123456789abcdef",
          replay: null,
        }),
        memory: { respondRule, busy: false },
        message,
      }),
    );
    expect(container.textContent).toContain("点“生效”才执行");
    expect(container.textContent).toContain("这次没能做历史回放");
    expect(buttons()).toEqual(["生效"]);
    await press("生效");
    expect(respondRule).toHaveBeenCalledWith(
      "rule-proposal:0123456789abcdef0123456789abcdef",
      "confirm",
    );
    await show(
      h(RuleReceiptCard, {
        key: "ask",
        output: JSON.stringify({ ...active, status: "ask_owner", ruleId: null, proposalId: null }),
        memory: { respondRule, busy: false },
        message,
      }),
    );
    expect(container.textContent).toBe("");
    await show(
      h(RuleReceiptCard, {
        key: "soft",
        output: JSON.stringify({ ...active, status: "soft", ruleId: null, trials: [] }),
        memory: { respondRule, busy: false },
        message,
      }),
    );
    expect(container.textContent).toContain("程序不强制执行");
    expect(container.textContent).not.toContain("试算");
    expect(buttons()).toEqual([]);
    await show(
      h(RuleReceiptCard, {
        key: "failed",
        output: "这次没有记成规则",
        memory: { respondRule, busy: false },
        message,
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("says a whole-thread rule reads the thread first instead of claiming every hit now asks you", async () => {
    await show(
      h(RuleReceiptCard, {
        output: JSON.stringify({ ...active, type: "mail_read_whole_thread" }),
        memory: { respondRule: vi.fn(async () => true), busy: false },
        message,
      }),
    );
    expect(container.textContent).toContain("以后会先读完整个邮件串再判断");
    expect(container.textContent).not.toContain("现在会改成要你看");
  });

  it("lists rules with a review mark and reconfirm only where the source memory changed", async () => {
    const respondRule = vi.fn(async () => true);
    await show(
      h(OwnerRulesSection, {
        memory: {
          rules: [
            rule(),
            rule({ ruleId: "owner:b", status: "needs_review", summary: "入管局的邮件一律提醒" }),
            rule({ ruleId: "owner:c", enforced: false, summary: "读不懂的规则" }),
          ],
          respondRule,
          busy: false,
        },
        message,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("长期规则 · 3 条");
    expect(text).toContain("先读完整个邮件串");
    expect(text.match(/待重新确认/gu)).toHaveLength(1);
    expect(text).toContain("暂时没有执行");
    expect(buttons().filter((label) => label === "重新确认")).toHaveLength(1);
    await press("重新确认");
    expect(respondRule).toHaveBeenCalledWith("owner:b", "reconfirm");
  });

  it("REVERSE: shows no rules section when there are no rules", async () => {
    await show(
      h(OwnerRulesSection, {
        memory: { rules: [], respondRule: vi.fn(), busy: false },
        message,
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("reads the rule list and sends the rule command through the gateway", async () => {
    query.mockImplementation(async (request: { type: string }) =>
      request.type === "memory.rules.read"
        ? {
            ...request,
            kind: "snapshot",
            type: "memory.rules.snapshot",
            payload: {
              rules: [rule()],
              builtIn: [builtIn()],
              allowances: [allowance()],
              generatedAt: "2026-11-11T00:00:00.000Z",
            },
          }
        : { ...request, kind: "snapshot", type: "memory.other" },
    );
    mutate.mockResolvedValue({ resultRef: "r", replayed: false, status: "accepted" });
    const seen: { model: ReturnType<typeof useMemory> } = { model: null };
    function Probe() {
      seen.model = useMemory({ client, configuration, connected: true, refreshSignal: 0 });
      return null;
    }
    await show(h(Probe));
    expect(seen.model?.rules.map(({ ruleId }) => ruleId)).toEqual([
      "owner:0123456789abcdef01234567",
    ]);
    expect(seen.model?.builtInRules).toEqual([builtIn()]);
    expect(seen.model?.allowances).toEqual([allowance()]);
    await act(async () => {
      await seen.model?.respondRule("owner:0123456789abcdef01234567", "undo");
    });
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "memory.rule.respond",
      payload: { target: "owner:0123456789abcdef01234567", action: "undo" },
    });
    await act(async () => {
      await seen.model?.revokeAllowance("allowance:0123456789abcdef");
    });
    expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "approval.allowance.revoke",
      risk: "low",
      payload: { allowanceId: "allowance:0123456789abcdef" },
    });
  });

  it("[ADR-0257] lists the built-in action rules with their examples and a switch only on the just-do-it ones", async () => {
    const respondRule = vi.fn(async () => true);
    await show(
      h(BuiltInActionRulesSection, {
        memory: {
          builtInRules: [
            builtIn(),
            builtIn({
              ruleId: "action_ask_after_external_content",
              outcome: "ask_owner",
              examplesHit: 2,
              examplesMiss: 3,
              askFirst: null,
            }),
            builtIn({
              ruleId: "action_refuse_background_after_external_content",
              outcome: "refuse",
              askFirst: null,
            }),
          ],
          respondRule,
          busy: false,
        },
        message,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("内置规则 · 3 条");
    expect(text).toContain("改你自己的数据：直接做");
    expect(text).toContain("读过外来内容后要做事：先问你");
    expect(text).toContain("后台读过外来内容后要做事：不做");
    expect(text).toContain("例子：2 个该命中，6 个不该命中");
    const switches = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')];
    expect(switches).toHaveLength(1);
    expect(switches[0]?.checked).toBe(false);
    expect(switches[0]?.closest("[data-built-in-rule]")?.getAttribute("data-built-in-rule")).toBe(
      "action_preauthorize_owner_data",
    );
    await act(async () => switches[0]?.click());
    expect(respondRule).toHaveBeenCalledWith("action_preauthorize_owner_data", "ask_first");
  });

  it("[ADR-0257] REVERSE: a switched-on rule switches back with allow_directly, and nothing renders without built-in rules", async () => {
    const respondRule = vi.fn(async () => true);
    await show(
      h(BuiltInActionRulesSection, {
        memory: { builtInRules: [builtIn({ askFirst: true })], respondRule, busy: false },
        message,
      }),
    );
    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(toggle?.checked).toBe(true);
    await act(async () => toggle?.click());
    expect(respondRule).toHaveBeenCalledWith("action_preauthorize_owner_data", "allow_directly");
    await show(
      h(BuiltInActionRulesSection, {
        memory: { builtInRules: [], respondRule, busy: false },
        message,
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("[ADR-0285] lists the permissions the owner gave with their scope and task name, and takes one back", async () => {
    const revokeAllowance = vi.fn(async () => true);
    await show(
      h(OwnerAllowancesSection, {
        memory: {
          allowances: [
            allowance(),
            allowance({
              allowanceId: "allowance:fedcba9876543210",
              allowFor: "this_task",
              title: "改日历",
              threadId: "thread-1",
              expiresAt: null,
            }),
            allowance({
              allowanceId: "allowance:aaaaaaaaaaaaaaaa",
              allowFor: "this_task",
              title: "订大阪的酒店",
              threadId: "thread-2",
              threadTitle: "订酒店",
              expiresAt: null,
            }),
          ],
          revokeAllowance,
          busy: false,
          allowanceDays: null,
          setAllowanceDays: vi.fn(async () => true),
        },
        message,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("你给过的同意 · 3 条");
    expect(text).toContain("只在“订酒店”这件事里");
    expect(text).toContain("回复 张三：周四下午 3 点可以");
    expect(text).toContain("到 ");
    expect(text).toContain("只在那件事里");
    const revoke = [...container.querySelectorAll("button")].find(
      (button) =>
        button.closest("[data-allowance]")?.getAttribute("data-allowance") ===
        "allowance:fedcba9876543210",
    );
    await act(async () => revoke?.click());
    expect(revokeAllowance).toHaveBeenCalledWith("allowance:fedcba9876543210");
  });

  it("[ADR-0285] REVERSE: nothing renders when no permission was given and the day count is unknown", async () => {
    await show(
      h(OwnerAllowancesSection, {
        memory: {
          allowances: [],
          revokeAllowance: vi.fn(async () => true),
          busy: false,
          allowanceDays: null,
          setAllowanceDays: vi.fn(async () => true),
        },
        message,
      }),
    );
    expect(container.textContent).toBe("");
  });

  it("[ADR-0285] the owner changes how many days “N 天内都行” lasts, within 1 to 90", async () => {
    const setAllowanceDays = vi.fn(async () => true);
    await show(
      h(OwnerAllowancesSection, {
        memory: {
          allowances: [],
          revokeAllowance: vi.fn(async () => true),
          busy: false,
          allowanceDays: 7,
          setAllowanceDays,
        },
        message,
      }),
    );
    const input = container.querySelector<HTMLInputElement>(".allowance-days input");
    const save = container.querySelector<HTMLButtonElement>(".allowance-days button");
    expect(input?.value).toBe("7");
    expect(save?.disabled).toBe(true);
    const type = async (value: string) =>
      act(async () => {
        if (!input) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("91");
    expect(save?.disabled).toBe(true);
    await type("0");
    expect(save?.disabled).toBe(true);
    await type("14");
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    expect(setAllowanceDays).toHaveBeenCalledWith(14);
    expect(setAllowanceDays).toHaveBeenCalledTimes(1);
  });
});
