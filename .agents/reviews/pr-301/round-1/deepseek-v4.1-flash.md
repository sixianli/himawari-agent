## 发现（按严重度）

### 中-1【读代码证实】新分支没有截止时间条件；“截止时间之前不收尾”不是由这段 SQL 保证的

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:60-66`
- 问题：新增的第三分支只看诊断码、沙箱记录数和未决模型调用，**完全不比较 `@resourceNow` 与运行截止时间**。因此 `RUN_EXPIRED_RECONCILIATION_SQL` 本身在截止时间之前就会为真，名字里的 “EXPIRED” 不再成立。
- 证据：

```60:66:packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts
    OR (c.diagnostic_code='RUN_EXECUTION_DEADLINE_EXCEEDED'
      AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records any_record
        WHERE any_record.owner_id=r.owner_id AND any_record.agent_id=r.agent_id AND any_record.run_id=r.id)
      AND NOT EXISTS (
        SELECT 1 FROM model_invocation_identities model
        WHERE model.owner_id=r.owner_id AND model.agent_id=r.agent_id AND model.run_id=r.id
          AND model.status IN ('reserved','started','unknown')))
```

真正阻止“截止时间前收尾”的是另外两处：

```425:425:packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
          AND (c.diagnostic_code='RUNTIME_TOOL_RESULT_UNKNOWN' OR @deadlineAt<=@resourceNow)
```

```72:73:apps/agent-service/src/production-run-expiry.ts
    if (at < frozen.deadlineAt && saved.checkpoint.diagnosticCode !== "RUNTIME_TOOL_RESULT_UNKNOWN")
      return false;
```

- 影响：`listReconciliationRequired` 用的也是同一条 SQL（`sqlite-run-dispatch-operations.ts:358`），所以在这种“诊断码已是 deadline、但时间还早”的状态下，它会提前把运行列为待对账。生产上暂时不会提前收尾，因为 `settleExpired` 的 ready 查询（第 425 行）和 `production-run-expiry` 第 72 行会挡住；但“这个行为由 SQL 的哪个条件保证”的答案应是“**没有**，由调用层的另一个条件保证”。另外，`deadline-code-before-deadline` 没有进入会调用 `listReconciliationRequired` 的场景列表（`test/integration/sqlite-sandbox-execution-v2.test.ts:1298-1307` 不含它），所以它既没测新 SQL 的行为，也在没有本改动时同样通过。
- 建议：要么让分支带上截止时间谓词（零记录时只能依赖冻结输入里的 deadline，需要把该值作为参数传入），要么在注释和事故记录里明确“deadline 拦截在 `settleExpired`/`production-run-expiry`”，并增加一条测试：截止时间之前 `listReconciliationRequired` 不返回该运行。

### 中-2【读代码证实】硬性安全约束“未决模型调用必须留给对账”没有反向测试

- 文件:行：`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:63-66`、`docs/incidents-and-gates.md:122`
- 问题：新增分支最关键的安全护栏之一是排除 `reserved/started/unknown` 的模型调用。但新测试只造了“零模型调用”的状态；把这三行 `NOT EXISTS` 整个删掉，现有测试仍会通过。
- 证据：模型状态确实包含这三个值（`packages/persistence-sqlite/src/migrations/0023_model_invocation_identities.sql:42`）：

```42:42:packages/persistence-sqlite/src/migrations/0023_model_invocation_identities.sql
  status TEXT NOT NULL CHECK (status IN ('reserved', 'started', 'unknown', 'settled', 'released')),
```

而新场景本身没有插入任何 `model_invocation_identities` 行，`deadline-code-no-records` 的期望是直接收尾：

```1306:1306:test/integration/sqlite-sandbox-execution-v2.test.ts
          "deadline-code-no-records",
```

同理，“存在沙箱记录时不能走新分支”也没有测试；现有反向场景用的是 `RUNTIME_TOOL_RESULT_UNKNOWN` 诊断码，不覆盖 `RUN_EXECUTION_DEADLINE_EXCEEDED` + 有记录的组合。

- 影响：事故记录写“已落门槛”，但这条门槛没有保护事故自己写明的“unknown 必须留给对账”约束。作者承认“有未决模型调用的场景没有单独测试”是**确实存在的缺口**；此外还漏报了“有沙箱记录”这个反向缺口。
- 建议：至少加两个 `deadline-code-*` 反向场景：一，诊断码为 deadline、零沙箱记录、但存在 `model_invocation_identities.status='unknown'`，断言不收尾；二，诊断码为 deadline、存在一条未到期或 `originalDeadlineAt` 为 NULL 的沙箱记录，断言不收尾。把它们加进 `settleExpired` 的拒绝断言，并用变异验证（删掉对应条件必须失败）。

### 低-1【读代码证实】测试夹具与生产状态不完全一致

- 文件:行：`test/integration/sqlite-sandbox-execution-v2.test.ts:1173-1177`
- 问题：测试用关闭外键直接删掉所有沙箱记录和准入队列：

```1173:1177:test/integration/sqlite-sandbox-execution-v2.test.ts
      if (["absent-before-deadline", "deadline-code-no-records", "deadline-code-before-deadline"].includes(scenario)) {
        f.database.pragma("foreign_keys = OFF");
        f.database.prepare("DELETE FROM sandbox_execution_records").run();
        f.database.prepare("DELETE FROM sandbox_admission_queue").run();
      }
```

但事故描述的是“只有沙箱预热，没有沙箱命令记录”，更接近“从未创建 `sandbox_execution_records`，但存在预热产生的 `execution_environments`”。测试没有创建预热环境，也没有验证 `RUN_RESOURCES_RELEASED_SQL` 里 `execution_environments` 的释放条件（`packages/persistence-sqlite/src/sqlite-run-resource-guard.ts:43-50`）。同时 `foreign_keys=OFF` 留下的孤立 `sandbox_execution_intents`/observations/occupancy 等行，不是正常删除路径能产生的状态。
- 影响：对“零记录”这个谓词本身够用，但无法证明真实事故状态（可能有预热环境、可能资源尚未释放）也会被正确收尾或正确拦住。
- 建议：用“只创建预热环境、不创建沙箱执行记录”的夹具复现，并分别断言：预热环境已释放时收尾、未释放时不收尾。

### 低-2【读代码证实 + 推测】零记录分支把截止时间的可信度交给了调用方

- 文件:行：`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts:420-448`、`packages/application/src/ports/run-dispatch.ts:181-192`
- 问题：`settleExpired` 的 `originalDeadlineAt` 是调用方传入的参数；ready 查询只用它和 `at` 比较（第 425 行），而它对沙箱记录做的一致性检查（第 427-431 行要求记录里的 `originalDeadlineAt` 等于传入值）在**零记录**时完全空转。生产包装层 `production-run-expiry` 会先解密并校验冻结输入里的 deadline（第 55-73 行），所以当前生产调用是安全的；但端口本身没有把 `@deadlineAt` 与冻结输入 payload 的内容绑定，新增分支让“零记录 + 伪造更早 deadline”第一次变得可收尾。
- 证据：

```427:431:packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
          AND NOT EXISTS (SELECT 1 FROM sandbox_execution_records plan
            WHERE plan.owner_id=r.owner_id AND plan.agent_id=r.agent_id AND plan.run_id=r.id
              AND json_extract(plan.plan_json,'$.originalDeadlineAt')<>@deadlineAt
              AND NOT (json_extract(plan.plan_json,'$.operation')='bash'
                AND json_extract(plan.plan_json,'$.originalDeadlineAt')>@deadlineAt))
```

- 影响：当前没有发现错误调用方，属于纵深防御问题；若以后离线收尾命令或其他内部调用方直接调用 `settleExpired` 并传错 deadline，新分支会让原本“永远不满足”的零记录 deadline 运行被提前判失败。
- 建议：在 `settleExpired` 内校验传入 `originalDeadlineAt` 与冻结输入 payload 的 `deadlineAt` 一致，或至少在端口契约和离线命令里明确这一前提，并补一条“零记录 + deadline 不匹配”的反向测试。

### 低-3【推测 + 文档核对】事故记录与代码表述不完全一致，且诊断码来源仍需确认

- 文件:行：`docs/incidents-and-gates.md:122`
- 问题：
  - 记录写“这一轮跑了约 5 分钟后以 `failed` 结束”，但同一句又说运行停在 `reconciling_external_result`。按代码，`RUN_EXECUTION_DEADLINE_EXCEEDED` 作为 checkpoint 诊断码出现在 `reconciling_external_result` 状态，主要来自 deadline 打断后 `reconcileLeaseFailure` → `quarantine`（`production-run-dispatcher.ts:595-597`、`541-552`、`769-780`，最终写诊断码在 `sqlite-run-dispatch-operations.ts:593-615`），而不是“运行状态 failed”。
  - 记录写“只有沙箱预热，没有沙箱命令记录”，但新 SQL 要求的是“**没有任何 `sandbox_execution_records`**”。这两个不是同一件事；如果生产行有任何一条沙箱记录（哪怕是 reserved/预热相关），新分支不会命中。
  - 同一条 SQL 之外，`RUN_EXECUTION_FAILED_WITHOUT_RESULT`、`SERVICE_STOPPING` 等诊断码同样可能形成“reconciling + 零沙箱记录”而无人收尾。如果生产行的诊断码不是 deadline，本 PR 不会解决它。
- 证据：`quarantine` 会把非特殊 reasonCode 原样写成 checkpoint 诊断码：

```598:615:packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
          .prepare(`INSERT INTO run_coordination_checkpoints
        ...
        ON CONFLICT(run_id) DO UPDATE SET revision = revision + 1,
        phase = 'reconciling_external_result', diagnostic_code = CASE
          ...
          ELSE excluded.diagnostic_code END,
        updated_at = excluded.updated_at`)
```

- 影响：作者已标注“诊断码和模型调用状态要在收尾前用只读查询确认”，这是诚实的；但当前 PR 已合入，事故记录却仍以未确认的生产诊断码为前提。
- 建议：在事故记录里写清“零 `sandbox_execution_records`”而不是“零命令记录”，并记录实际只读查询结果；如果实际诊断码不是 `RUN_EXECUTION_DEADLINE_EXCEEDED`，需要重新评估这第三种分支是否覆盖该生产行。

### 低-4【读代码证实】提交说明未登记“未覆盖的关键路径”

- 文件:行：`docs/incidents-and-gates.md:122`、提交 `76ffd95`
- 问题：提交信息只有 `Layer-0-tests:`，没有 `Untested-critical-path:` 行；而事故记录明确写了“有未决模型调用的场景没有单独测试”。`scripts/delivery-mode/untested-claims.py` 只拒绝提交说明里出现“未覆盖/没有测试”等字样却没有结构化声明的情况，不会扫描事故表，因此这次没有被门槛发现。
- 影响：这是 I-59 想避免的“未覆盖只写在文档里、没有机器约束”的同类情况。
- 建议：按 I-59 的约定在提交说明里补 `Untested-critical-path:` 与 `Real-env-proof:`/`Waiver:`，或直接补上反向测试。

---

## 侧重检查

- **错误路径**：截止时间之前直接调用 `settleExpired` 会因 `sqlite-run-dispatch-operations.ts:425` 失败并抛 `PORT_CONFLICT`（测试 `deadline-code-before-deadline` 断言的正是 `rejects.toThrow()`）；生产包装层在 `production-run-expiry.ts:72` 更早返回 `false`。未发现生产路径会提前收尾。
- **不合规范/不可信输入**：新 SQL 使用绑定参数 `@resourceNow` 和固定字面量，没有拼接外部输入。主要信任缺口是零记录时 `originalDeadlineAt` 完全来自调用方（见低-2）。
- **安全**：改动不涉及模型内容、密钥或新外部接口。收尾仍是不可逆操作（`runs.status='failed'`、写 receipt、`run.failed` 事件），前置的 authority/revision/冻结输入校验（`sqlite-run-dispatch-operations.ts:408-448`）未变；资源释放条件仍由 `RUN_RESOURCES_RELEASED_SQL` 追加（`sqlite-sandbox-tool-result-recovery.ts:67`）。
- **资源耗尽**：没有新增无界查询；`listReconciliationRequired` 有 `LIMIT`。唯一的新副作用是截止时间前的 deadline 诊断运行可能被反复列入待对账，但生产状态通常不会在截止前出现该诊断码。
- **不可撤销操作**：资源未释放不会收尾（`RUN_RESOURCES_RELEASED_SQL` 仍在末尾）；但“未决模型调用”护栏没有测试，属于最需要补强的不可逆风险点。
- **规则/文档/代码一致性**：`RUN_EXPIRED_RECONCILIATION_SQL` 新增分支与事故记录描述的三种条件一致；但“截止时间前不收尾由 SQL 保证”“没有沙箱命令记录等于没有沙箱记录”两处表述与代码不一致。`check-incident-gates.mjs` 会接受 I-88（门槛列的两个路径都存在，状态合法）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。改动只涉及 `docs/incidents-and-gates.md`、`packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts` 和测试夹具，没有碰系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加，每轮会变的值仍由既有机制放在最后一条消息里，符合 `.claude/rules/prompt-prefix.md` 第 28、35 条。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。新 SQL 是静态模板，只有绑定参数，没有时间戳、随机值或无序集合注入模型内容；测试和文档不参与模型请求。收尾时写入的 `updated_at`/事件时间是数据库元数据，且是改动前就有的行为。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**

只有一半。
- 正向：`deadline-code-no-records` 在改前失败、改后通过，作者说的 worker/direct 各一条失败与 `describe.each` 结构一致。
- 反向上限：“截止时间之前”的场景并不是这次改动的反向用例——它在没有本改动时也会通过，因为拦截来自 `sqlite-run-dispatch-operations.ts:425` 和 `production-run-expiry.ts:72`。
- 真正的反向缺口：删除新分支里的 `NOT EXISTS model_invocation_identities`（未决模型调用）或 `NOT EXISTS sandbox_execution_records`（有沙箱记录）都不会让任何测试失败。作者承认前者是缺口，后者未被提及。

**4. 新产生/修改的值，产生处和使用处两端都能接受吗？**

没有产生新标识、配置键或序列化格式；新增使用的是既有诊断码 `RUN_EXECUTION_DEADLINE_EXCEEDED`。
- 产生处：`packages/application/src/services/run-coordinator.ts:259`（审批等待到期）以及 deadline 打断后 `quarantine` 写 checkpoint（`SQLite.../sqlite-run-dispatch-operations.ts:593-615`，由 `production-run-dispatcher.ts:595-597` 传入）。
- 使用处：新 SQL 分支（`sqlite-sandbox-tool-result-recovery.ts:60`）；`thread-execution-state.ts:279/288/340` 把它当作 deadline 结束原因；`execution-view.ts:373` 有对应显示映射。`diagnostic_code` 没有枚举约束，上述使用处都能接受该字符串。
- 未核实的一端：事故记录提到的“停服窗口离线收尾命令”和 `TWENTYNINTH_MAINTENANCE_NON_TERMINAL_RUNS` 不在本仓库 diff 中，无法确认它们对新分支/该诊断码的校验；事故记录本身也要求“收尾前用只读查询确认诊断码和模型调用状态”，该确认没有在本次材料中体现。

**总体结论**：主逻辑方向正确，生产路径不会提前收尾；但事故记录对“截止时间前不收尾”的归因不准确，且最关键的两条安全护栏（未决模型调用、已有沙箱记录）没有反向测试。建议补测试并修正文档表述后再视为“已落门槛”。
