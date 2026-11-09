# PR 301 第 5 轮复核（增量 `6d13d446..676119ef`，分支提交到 `b15f13db`）

## 结论摘要

核心改动本身在代码层面成立：`unknown` 在 Pi 适配器里是**本地终止状态**，收尾时不会出现“请求还在途却被结算”的双写；`settleExpired` 只写 run/checkpoint/租约/回执，不改模型调用和预算账户。没有发现会改变模型请求开头或产生不确定字节的问题。

但有两个值得记录的风险：一是 `started` 在崩溃/写失败时仍会让同类运行永久卡死（本改动未覆盖，非本改动引入）；二是新分支的 `diagnostic_code` 守卫缺少反向用例。下面按严重度排列。

---

## 问题列表（按严重度从高到低）

### 1. 【中低｜残余卡死风险】`started` 仍可能永久挡住收尾，且没有后台清理

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:63`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1028`、`:1080`
- 问题：本改动只放行 `unknown`，仍把 `reserved`、`started` 视为未决。但 `markStarted()` 与 `markUnknown()` 之间存在窗口：进程在两者之间崩溃，或 `markUnknown` 写库失败（适配器里是 `catch` 后继续），模型调用会永久停在 `started`，而这类“没有任何沙箱记录”的运行正好只能走第三分支，于是又回到 I-88 的卡死状态，继续让 `TWENTYNINTH_MAINTENANCE_NON_TERMINAL_RUNS` 拦住上线。
- 证据（亲自读到）：
  - 第三分支只挡两种状态：
    ```ts
    AND NOT EXISTS (
      SELECT 1 FROM model_invocation_identities model
      WHERE ...
        AND model.status IN ('reserved','started')))
    ```
    `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:63-66`
  - `markStarted` 之后到 `markUnknown` 之前没有原子性：
    ```ts
    await permit.markStarted();
    started = true;
    if (options?.signal?.aborted) {
      await permit.markUnknown("cancel_unresolved");
    ```
    `packages/runtime-pi/src/pi-runtime-adapter.ts:1028-1032`
  - 异常路径的 `markUnknown` 失败会被吞掉，行保持 `started`：
    ```ts
    if (started && permit !== undefined) {
      await permit.markUnknown("transport_unresolved").catch(() => undefined);
    ```
    `packages/runtime-pi/src/pi-runtime-adapter.ts:1080-1081`
  - 第一、二分支都救不了它：第一分支要求诊断码 `RUNTIME_TOOL_RESULT_UNKNOWN`（`:48`），第二分支要求存在已过期沙箱记录（`:53-59`），本类运行两者都不满足。
- 建议：为“无沙箱记录”的情况增加对 `started` 的兜底（例如超过原期限后允许把无法再确认的 `started` 也按未确认处理，或在启动/巡检里把长期 `started` 标成 `unknown`），并补一条反向/正向测试；若暂不处理，至少在 I-88 中写明“本改动只覆盖 `unknown`，不覆盖崩溃留下的 `started`”。

### 2. 【低｜测试覆盖缺口】新分支的 `diagnostic_code` 守卫没有反向用例

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60`；`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:425`
- 问题：现有测试能覆盖“去掉 `reserved/started` 条件”“把 `unknown` 加回去”“去掉无沙箱记录条件”三种回退，但没有用例覆盖“去掉 `c.diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'`”。一旦这个条件被误删，`RUNTIME_TOOL_RESULT_UNKNOWN` + 没有沙箱记录 + 有 `unknown` 模型调用的运行会在**截止时间之前**被立即收尾，因为收尾的时限门在诊断码是 `RUNTIME_TOOL_RESULT_UNKNOWN` 时会直接放行。
- 证据（亲自读到）：
  - 新分支的诊断码条件是 `OR (c.diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'`（`sqlite-sandbox-tool-result-recovery.ts:60`）。
  - 收尾的时限门旁路：
    ```sql
    AND (c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow)
    ```
    `sqlite-run-dispatch-operations.ts:425`
  - 测试场景清单里只有 `deadline-code-*`（`test/integration/sqlite-sandbox-execution-v2.test.ts:1058-1070`），没有 `RUNTIME_TOOL_RESULT_UNKNOWN + 无记录 + unknown 模型` 的组合。
- 建议：新增一个反向场景（诊断码 `RUNTIME_TOOL_RESULT_UNKNOWN`、无沙箱记录、模型 `unknown`、`now < deadline`），断言既不进候选也不收尾；这样删掉诊断码条件时会真失败。

### 3. 【低｜文档一致性】I-88 的“`unknown` 不挡收尾”容易被读成全局规则

- 文件:行：`docs/incidents-and-gates.md:122`
- 问题：代码里只有第三分支放行 `unknown`；第一分支（`RUNTIME_TOOL_RESULT_UNKNOWN`）仍然把任何 `unknown` 当未决（`sqlite-sandbox-tool-result-recovery.ts:36-41`）。I-88 的句子处在第三分支描述中，字面“`unknown`……不挡收尾”如果被泛化，会让人误以为所有到期/结果未知的收尾都放行。另外文档没有说明“收尾后原进程若真的迟到结算，持久层仍可能接受”，读者可能误以为租约释放后一定写不进去。
- 证据（亲自读到）：
  - 第一分支仍然挡 `unknown`：`model.status IN ('reserved','started','unknown')`（`sqlite-sandbox-tool-result-recovery.ts:39`）。
  - I-88 原文：`...没有 reserved、started 的模型调用；unknown（...）不挡收尾...`（`docs/incidents-and-gates.md:122`）。
- 建议：把“只对第三种情况生效”写进同一句；如需要，补一句“迟到结算是否成功取决于当时的权限租约，见 `settleWithinTransaction` 的校验范围”。

---

## 读代码证实的 / 推测的

**读代码证实**

- `unknown` 是适配器里的本地终止状态：`relayAdmittedPiStream` / `trusted-model-provider` 在写完 `unknown` 后立即 `return`/`break`，不会再对同一 `permit` 调 `settle`（`pi-runtime-adapter.ts:789-890`、`trusted-model-provider.ts:223-293`）。
- `settleExpired` 不碰模型调用和预算：事务内只更新 `runs`、`run_coordination_checkpoints`、`run_execution_leases`，另写 command/reliable event（`sqlite-run-dispatch-operations.ts:486-538`）。
- 迟到结算在持久层**可以被接受**，即使执行租约已过期/被替换：`settleWithinTransaction` 只校验 `assertCurrentAuthority`（权限租约）和调用行里冻结的租约声明，不校验当前 run 租约或 run 状态（`sqlite-model-invocation-operations.ts:643-647`、`:828-834`；应用层测试 `model-invocation-admission-service.unit.test.ts:487-513` 明确称 “allows late settlement ... without reviving an expired lease”）。因此迟到结算会补记费用而不是报错；只有权限租约也失效时才失败，费用则永久停在 `unknown`。
- 收尾路径不写 `thread_messages`，只写 command/reliable event、线程 revision 和 `thread_gateway_events`（`sqlite-run-lifecycle-operations.ts:270-325`）。
- 上线维护门只统计沙箱未释放预约和“非终态 run”，不统计 `reconcile_required` 的模型预算（`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:37-51`、`:92`；`run-maintenance.mjs:24-25`）。所以把 run 收尾为 `failed` 确实能解除 `S3_COPY51` 的 `NON_TERMINAL_RUNS`，而留下的 `reconcile_required` 预算不会再次拦住它。
- `unknown` 的原因码在数据库层只允许三种：`provider_unresolved`、`transport_unresolved`、`cancel_unresolved`（`migrations/0023_model_invocation_identities.sql:51-53`），I-88 的枚举完整。
- UI 已有“到期且无沙箱资源”的展示分支，会把这种运行显示为 `failed`，不提供 `retry_cleanup`（`packages/application/src/services/thread-execution-state.ts:282-311`）。

**推测 / 未核实**

- 第 1 条残余卡死在生产上的可达性取决于崩溃或 `markUnknown` 写库失败的时机；未核实实际发生频率。
- 收尾后某个非收尾路径是否会把 `thread_gateway_events` 再投影成模型可见的历史，未完整追踪；但收尾本身不写 `thread_messages`。
- 作者给出的 86 条、967 条通过数字无法在本复核中运行验证，属未核实。
- I-88 中生产库 `run:17a4102d…` 的具体行状态（7 次调用、6 次结清、`cancel_unresolved`、`reconcile_required`）无法访问生产库核实。

---

## 侧重检查

- **错误路径（未决/未知调用）**：确认 `unknown` 写完后适配器不会再结算；`reserved/started` 仍挡第三分支；迟到结算在持久层会被接受而非报错/重复（见上）。结论：本改动不会让“真正在途的调用”被收尾，因为 `started` 仍挡；`unknown` 只会在本地放弃后写入。
- **不可信 / 不合规输入**：`settleExpired` 的生产入口 `production-run-expiry.ts` 校验冻结输入的版本、摘要、权限快照、deadline/startedAt 关系（`production-run-expiry.ts:56-73`），SQL 里也再次校验冻结输入摘要（`sqlite-run-dispatch-operations.ts:432-437`）。新分支本身没有引入新的外部输入。唯一可被内部调用方伪造的是 `originalDeadlineAt`；对“无沙箱记录”的运行，`@deadlineAt<=@resourceNow` 之外没有记录级对照（`:427-431` 对空集恒真），但生产调用方从冻结负载取值，不是外部可控。
- **安全**：改动不涉及密钥、遮盖、出口内容；没有新的日志泄露面。
- **资源耗尽 / 不可撤销操作**：收尾是单事务、不可逆地把 run 置为 `failed`；新放行的场景仍要求资源释放、无终态、无输出、无 `reserved/started`，因此不会在资源仍占用时收尾。收尾后预算留下 `reserved_cost_micros`（有意为之），但没有跨 run 的父账户会因此被拖住。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 与本改动无关；I-88 措辞与代码基本一致，仅第 3 条的“只对第三分支生效”需要点明。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。该改动只改到期收尾 SQL、对应集成测试和事故文档；没有触碰系统提示、工具定义、历史序列化、遮盖规则。收尾写的是 `command_results`、`reliable_events`、`thread_gateway_events` 和线程 revision，不写 `thread_messages`（`sqlite-run-lifecycle-operations.ts:270-325`），模型侧历史仍来自冻结输入/既有消息，新信息只能追加，不能改写已发内容。每轮会变的值（如时间）没有被搬进系统提示或工具定义。**结论：仍然只追加，每轮变化值不在请求头。**（收尾事件之后如何被其它投影消费，未完整追踪；收尾路径本身已核实不写消息。）

### 2. 同一段文字会不会在不同请求里变成不同字节？

不会。该改动没有新增任何序列化、遮盖、集合顺序或时间字段进入模型请求。收尾写出的标识是确定性的：`settlementIdentity = sha256([ownerId, agentId, runId, deadlineAt])`，幂等键据此生成（`sqlite-run-dispatch-operations.ts:515-527`），重复调用不会生成不同结果；`occurred_at` 只在持久事件里写一次，不进入提示词。模型调用和预算行在收尾时完全不动。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有。`test/integration/sqlite-sandbox-execution-v2.test.ts` 新增了正向场景 `deadline-code-model-unknown-cancel/provider/transport`（`:1062-1064`）和反向场景 `deadline-code-model-reserved/started`（`:1060-1061`），另有 `future-record`/`null-record`/`environment-unreleased`。按测试结构推断：

- 恢复旧条件（只放行 `cancel_unresolved`）时，`unknown-provider/transport` 正例会因“不收尾”失败；
- 去掉模型状态条件时，`reserved/started` 反例会因“错误收尾”失败；
- 去掉“无沙箱记录”条件时，`future-record`/`null-record` 会失败；
- 但**没有**用例覆盖“去掉 `diagnostic_code` 条件”这一回退（见问题 2），这是测试缺口。

测试里还只断言了 `model_invocation_identities` 和 `model_budget_accounts`（`:1385-1394`），没有断言 `model_budget_allocations` 不变；代码确实不碰 allocations，但断言可以更完整。作者给的 86/967 通过数字本复核未运行，未核实。

### 4. 改动产生/修改的每个值，使用它的一端都能接受吗？

本改动没有新增标识、字段、配置键或清单项，只改了既有值的判定：

- `model.status IN ('reserved','started')`：`reserved/started` 是 `model_invocation_identities` 的合法状态（`migrations/0023_model_invocation_identities.sql:42`）。
- `unknown` 的原因码：数据库只允许 `cancel_unresolved/provider_unresolved/transport_unresolved`（`0023:51-53`），I-88 的枚举与之一致。
- `RUN_EXECUTION_DEADLINE_EXCEEDED`：由 `settleExpired`/隔离路径写入（`sqlite-run-dispatch-operations.ts:492`、`run-coordinator.ts:259`），使用方包括收尾 SQL（`sqlite-sandbox-tool-result-recovery.ts:60`）、UI（`thread-execution-state.ts:279/288/340`）和维护门（维护门只看 run 是否终态，`read-s0-db.mjs:92`），都接受。
- 留下的预算账户 `reconcile_required`：`listReconciliationRequired` 会把它当作候选条件（`sqlite-run-dispatch-operations.ts:351-356`），但 run 已 `failed`，不会再被该查询命中；`assertRunBudgetDispatchable` 会拒绝认领（`:1084-1094`），而 `failed` run 本来就不会被认领；上线维护门不统计模型预算（`read-s0-db.mjs:37-51`、`:92`）。没有发现“留下 `reconcile_required` 会导致别处校验失败”的消费方。

**结论：每个值的两端校验一致；没有发现 I-73 式的“清单值过不了后端校验”。**
