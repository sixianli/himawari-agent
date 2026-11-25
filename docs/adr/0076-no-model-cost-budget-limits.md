---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-25"
covers: ""
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0076：模型调用不设费用上限，预算账本只记账

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [生产配置怎么改](#production-config)
- [后续](#follow-up)

<a id="context"></a>

## 背景

产品配置的 `budgets` 有三种费用上限：全局累计 `globalCostMicros`（生产 1 美元）、按数据等级累计 `perClassificationCostMicros`（生产“私密”类 0.1 美元）、单个 Run 的 `perRunCostMicros`（生产 0.1 美元）。前两种是从第一次调用起的累计总额，永不清零，用满后所有对话、标题和记忆嵌入调用都会被拒绝。另外还有一个隐性限制：某次调用的实际花费超过预估，整个 Run 账户就变成 `over_budget`，同一 Run 里之后的调用全部被拒。

2026-10-25 16:26 Andy 说：“全局 1 美元和私密类 0.1 美元这两个上限是累计总额、永不清零，把这个限制删掉。我不想再用这个作为限制了。”同一时间在上线线程里说“以后这个项目不再设置预算限制”，项目指令也写明不再设置任何模型调用和嵌入的费用预算上限。

第九次上线要把 DeepSeek 的上下文窗口改成真实值 1048576，按现有估算每次调用预留约 53 万微美元，远超每 Run 10 万的上限，不删上限所有对话都会被拦。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **删除配置里的整个 `budgets` 段。** `ProductConfiguration` 不再有 `budgets`，严格配置校验把它当未知字段拒绝启动（`UNKNOWN_FIELD`，字段 `configuration.budgets`），不留不起作用的摆设字段。
2. **准入不再按费用拒绝任何调用。** 前台 Run、会话标题、记忆嵌入和后台 occurrence 的预留都不再比较全局、数据等级、单 Run 或单次估算上限；后台 occurrence 的子调用超出预留时把账户预留扩大到实际需要的数额；实际花费超过预估不再把账户置为 `over_budget`，也不再把后台任务判为 [RUN_BUDGET_EXCEEDED](https://github.com/sixianli/himawari-agent/blob/d7b90f79ece72e74564edb7c4ad3d3b607daa28f/packages/application/src/ports/durability.ts)。
3. **保留预算账本作为用量统计和恢复门禁。** `model_budget_accounts`、`model_budget_allocations` 和模型调用身份照旧记录每次调用的预估、实际花费和 `reserved → started → settled | unknown | released` 状态。结果未知时账户仍置为 `reconcile_required`，阻止同一调用被重复发出；这是防止重复外部副作用的门禁，不是费用限制。
4. **不改数据库结构。** 旧数据里的 `over_budget` 账户和 `budget_blocked` occurrence 仍然合法：前者可以继续分配、下一次结算后回到 `active`，后者可以被重新接纳。

本 ADR 不涉及 Grant 的单次/累计费用、Worker 委派的 `maxCostMicros`、Reflection 的 `maximumCostMicros`；这些是各自功能的范围约束，目前都没有接进生产链路。真实联网测试（`openrouter-*-live`、`file-summary` 探针）里的花费上限是测试脚本自己的保护，也不在本次范围内。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **把三个上限调成很大的数（例如 1e15）**：不采用作为长期方案。字段还在、代码还在比较，一旦有人照旧样例写回 1 美元又会全部卡住，Andy 也不想要“看着像限制其实不起作用”的配置。第九次上线如果赶不上本次改动，可以临时这样设置，见[生产配置怎么改](#production-config)。
- **整套删除预算账本和相关表**：不采用。账本同时承担调用身份、未知结果对账和重启后不重复发请求的职责，删掉要改迁移和恢复流程，风险大且没有收益；用量记录本身也有用。
- **新代码继续接受旧 `budgets` 段但忽略它**：不采用。忽略的字段就是摆设；上线时删掉字段只是一条 `jq` 命令，回滚时恢复备份配置即可。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 模型调用和嵌入调用的花费不再有任何产品内的上限，花费只受 Vercel AI Gateway 等供应商账户本身的额度限制。账本照常记录每次调用的花费，可以随时查。
- 带本次改动的版本启动时，配置里不能有 `budgets`。生产机、Hermes 和测试账号的配置都要在同一次上线时删掉这一段。
- 后台任务的 `budget_blocked` 状态和 [GLOBAL_BUDGET_EXHAUSTED](https://github.com/sixianli/himawari-agent/blob/d7b90f79ece72e74564edb7c4ad3d3b607daa28f/packages/application/src/ports/durability.ts)、[CLASSIFICATION_BUDGET_EXHAUSTED](https://github.com/sixianli/himawari-agent/blob/d7b90f79ece72e74564edb7c4ad3d3b607daa28f/packages/application/src/ports/durability.ts)、[RUN_BUDGET_EXCEEDED](https://github.com/sixianli/himawari-agent/blob/d7b90f79ece72e74564edb7c4ad3d3b607daa28f/packages/application/src/ports/durability.ts) 原因码不会再产生。

[↑ 返回阅读导航](#contents)

<a id="production-config"></a>

## 生产配置怎么改

带本次改动上线时，在切换新版本之前（停服后、启动前）删掉 `/etc/himawari/config.json` 里整个 `budgets` 对象，其他字段不动：

```sh
cp /etc/himawari/config.json /etc/himawari/config.json.before-remove-budgets-$(date -u +%Y%m%dT%H%M%SZ)
jq 'del(.budgets)' /etc/himawari/config.json > /etc/himawari/config.json.new
jq -e 'has("budgets") | not' /etc/himawari/config.json.new
install -m "$(stat -c %a /etc/himawari/config.json)" -o "$(stat -c %u /etc/himawari/config.json)" -g "$(stat -c %g /etc/himawari/config.json)" /etc/himawari/config.json.new /etc/himawari/config.json
```

回滚到旧版本时必须同时恢复带 `budgets` 的备份配置，因为旧版本要求这一段存在；一键回滚脚本恢复的就是上线前的配置备份。

如果某次上线还是旧代码、但要先放开限制（例如第九次上线赶不上本次改动），把 `globalCostMicros`、`perRunCostMicros` 和 `perClassificationCostMicros` 下的 `public`、`private`、`sensitive`、`restricted` 都设成 `1000000000000000`；只改 `public` 和 `private` 的话，`sensitive`、`restricted` 两类仍会被拦。之后本次改动上线时再按上面的命令删掉整段。

[↑ 返回阅读导航](#contents)

<a id="follow-up"></a>

## 后续

- 2026-10-30：[ADR 0124](0124-unknown-model-call-blocks-only-its-own-resend.md) 修改本 ADR 第 3 条：调用结果不确定时账户照样置为 `reconcile_required`，但不再拒绝同一轮里其他调用的预留和开始；阻止同一调用重发改由调用记录按调用位置完成。整轮的重新派发和后台任务恢复仍被挡。原做法让找记忆的向量请求出一次不确定，同一轮主对话也失败（事故 I-37）。
- 2026-11-11：多人使用时，[ADR 0234](0234-one-program-per-person-database-file.md) 对本 ADR 决定 2 加一个例外：只对 Andy 以外的人，准入前按人按月核对用量，超过上限就拒绝；上限数值由 Andy 在管理页配置，代码里不写固定数字。Andy 本人仍默认不设上限，产品内仍不设累计总额上限，其余决定不变。

[↑ 返回阅读导航](#contents)
