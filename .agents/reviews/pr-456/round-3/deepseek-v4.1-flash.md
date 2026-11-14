## 读代码证实的问题

### 中｜新诊断记录只写不读，`diagnose run` 看不到
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:666-670`；`packages/persistence-sqlite/src/sqlite-run-diagnostics.ts:4-6`、`:122`
- 问题：统一出口出错时写入的 `owner-scope-diagnostic:` 记录，没有任何读取方。`readRunDiagnostics` 只匹配 `runtime-tool-diagnostic:%`、`sandbox-control:*:diagnostic:*`、`sandbox-control:*:observation:*`，所以 `apps/admin-cli/src/diagnose-command.ts:50` 遍历 `snapshot.diagnosticPayloads` 时永远拿不到这条记录。ADR 说“存一条诊断记录”，实际是只写不读的 dead data，运维排查时看不到。
- 证据：
  ```ts
  // production-runtime-tools.ts:666-670
  await this.#writeJson(
    invocation,
    `owner-scope-diagnostic:${digest([invocation.runId, invocation.toolCallId, cause])}`,
    { stage: "not_dispatched", reasonCode: "authorization_component_error", cause },
  ).catch(() => undefined);
  ```
  ```sql
  -- sqlite-run-diagnostics.ts:4-6
  const DIAGNOSTIC_OPERATION_KEYS = `(a.operation_key LIKE 'runtime-tool-diagnostic:%'
    OR a.operation_key GLOB 'sandbox-control:*:diagnostic:*'
    OR a.operation_key GLOB 'sandbox-control:*:observation:*')`;
  ```
- 建议：在 `DIAGNOSTIC_OPERATION_KEYS` 加上 `a.operation_key LIKE 'owner-scope-diagnostic:%'`，并给 `test/integration/admin-diagnose-run.test.ts` 加一条读取用例；或者复用 `runtime-tool-diagnostic:` 前缀。若确实只想内部留存，应在 ADR 里写明“不通过 diagnose run 暴露”，否则与“诊断记录”的用途不符。

### 低｜诊断里的“原因”对普通 Error 只剩 `"Error"`
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:660-665`
- 问题：作者说记录“错误代码”，但只有 `ApplicationPortError` 才记 `error.code`；普通 `Error` 记的是 `error.name`，通常就是 `"Error"`，原始信息完全丢失。新增测试里的 `new Error("state store unavailable")` 实际只会存下 `cause: "Error"`。
- 证据：
  ```ts
  const cause =
    error instanceof ApplicationPortError
      ? error.code
      : error instanceof Error
        ? error.name
        : "unknown";
  ```
  ```ts
  // production-runtime-tools.unit.test.ts:1927
  .mockRejectedValueOnce(new Error("state store unavailable"))
  ```
- 建议：把 `errorCode`（PortErrorCode）与一个经过截断/脱敏的 `errorName` 分开存；如确需保留原因，可存有长度上限的 `error.message`，但要先按数据分级确认不会带出秘密。同时把 ADR/材料里的“内容是错误代码”改成与实现一致。

### 低｜ADR 新值清单漏列新诊断键，和 ADR 自己的要求冲突
- 文件:行：`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:198`、`:272`
- 问题：ADR 明确写“每个新出现的值，写明谁产生、谁使用、两端怎样校验、哪道检查守着”，但这一轮新增的 `owner-scope-diagnostic:` 键只出现在“后果”一节，没进“新值清单”。如果当时按清单核对“使用处”，就会直接暴露上面“没有读取方”的问题。
- 证据：第 198 行：“每个新出现的值，写明谁产生、谁使用、两端怎样校验、哪道检查守着。”第 272 行才出现 `owner-scope-diagnostic:`，表格里没有对应行。
- 建议：给 `owner-scope-diagnostic:` 补一行，明确“产生处、使用处（应为 `readRunDiagnostics`/`diagnose run`）、两端校验、自动检查”。

### 低｜反向用例没覆盖“写不进去就忽略”和“停止/取消时不写诊断”
- 文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:1958-1994`
- 问题：作者声称“存不进去时忽略”，但没有任何用例让诊断记录的 `commit` 失败来验证 `.catch(() => undefined)`；如果以后去掉这个 catch，现有测试仍全绿。新增的“throws instead of reporting...”用例只断言抛出和 `run` 未调用，没有断言 `owner-scope-diagnostic:` **不存在**；如果以后把写诊断挪到 `assertRunActive`/`throwIfAborted` 之前，这个用例也不会失败。
- 证据：
  ```ts
  // production-runtime-tools.unit.test.ts:1992-1993
  await expect(tools.execute({ ...set, toolCallId: "stopped" })).rejects.toThrow("RUN_STOPPED");
  expect(run).not.toHaveBeenCalled();
  ```
  没有对 `f.artifacts.keys()` 的否定断言；测试 fixture 的 `commit` 也没有被注入失败。
- 建议：在这两个停止/取消场景后加 `expect([...f.artifacts.keys()].some(k => k.startsWith("owner-scope-diagnostic:"))).toBe(false);`；再加一个 fixture，让诊断键的 `artifacts.commit` 抛错，断言 `execute` 仍返回 `authorization_component_error` 且 `modelContent` 不带该错误。

### 低｜诊断写入期间到达的取消不会被再次检查
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:659`、`:666-679`
- 问题：第 659 行检查取消后，第 666 行又 `await` 一次写盘；如果取消或运行停止发生在这段写盘期间，后面不会再次 `throwIfAborted()` 或 `assertRunActive`，最终返回 `DENY` 的失败结果而不是抛出 `AbortError`。与“调用已取消，执行抛出”的说明不完全一致。由于结果仍是“未执行”的拒绝，属于 fail-closed，影响有限。
- 证据：
  ```ts
  signal?.throwIfAborted();          // 659
  ...
  await this.#writeJson(...);        // 666
  ...
  permission = { decision: "DENY", ... };
  ```
- 建议：在写诊断之后、返回 DENY 之前再调用一次 `signal?.throwIfAborted()`（必要时再 `assertRunActive`），或者先决定返回结果、把诊断写成不阻塞的旁路。

### 低（潜在）｜测试辅助代码没把同一个 registry 传给两个组件
- 文件:行：`test/integration/tool-action-registry.test.ts:63`、`:73`、`:81-90`
- 问题：`ownerScope` 用的是可注入的 `registry`，但 `ProductionRuntimeTools` 没有传 `toolActions`，会自己 `new` 一个默认表。当前没有测试同时注入自定义 registry 并走 `tools.execute`，所以没暴露；但将来若这样用，“出工具/查清单”两端会不一致（I-73 同类问题）。生产 wiring 是对的：`service-main.ts:1507` 建一次 `toolActions`，`:1528` 给 ownerScope、`:1537` 给 tools。
- 证据：
  ```ts
  const registry = options.registry ?? productionToolActionRegistry(); // 63
  const ownerScope = new OwnerScopeAuthorization({ ..., registry, ... }); // 73
  const tools = new ProductionRuntimeTools({ ...f.options, ..., ownerScope, clock }); // 81-90
  ```
- 建议：测试 helper 里加 `toolActions: registry`；或在 `ProductionRuntimeTools`/`OwnerScopeAuthorization` 之间加一个“同一个 registry 实例”的断言/工厂，避免生产接线靠人工保证。

## 推测 / 未核实

- **`ask_owner` 结果的分派**（推测，当前不可达）：`OwnerScopeAuthorization.decide` 只特判 `refuse` 和 `allow_preauthorized`；`ask_owner` 直接落到 `policy.evaluate`。如果以后某条规则命中 `ask_owner`，而同一 intent 已有有效 grant/approval，`policy.evaluate` 可能直接 `ALLOW`，不一定强制“问主人”。目前唯一内置动作规则从不返回 `ask_owner`，所以现在没有问题；新增该结果值时应补一个“命中 ask_owner 时强制 ASK”的用例和分派。
- **ADR “不重新组”措辞**（静态读代码）：`authorize` 每次仍会计算一份 `proposed`（含 `requestedAt: clock.now()`、重新计算的 `expiresAt`），只是 freeze 命中已有记录后丢弃它、用读回的 intent 判断。实质决定确实按存下的事实走，但“不重新组”字面上不准确；不影响本次结论。
- 我没有运行任何测试（只能读文件和 git），以上测试覆盖判断来自代码与用例内容，未实际执行。

## 侧重检查

- **错误路径**：检查了 `#ownerScopeGate` 的 catch 顺序（先 `assertRunActive`、再 `throwIfAborted`、再写诊断、最后 DENY）；停止/取消不会写诊断；写诊断失败被 `.catch` 吞掉；发现“写盘期间取消”的二次检查缺口（上一条低）。
- **不合规范/不可信输入**：`invocation.arguments` 只参与 `digest` 和下游工具，不直接进规则表达式；`ToolActionRegistry.assertRow` 校验家族、授权路径、后果、可撤销、设备列；`assertPolicyFactCodes` 拒绝未登记、重复、未排序的事实；`RuleJudge` 只接受本闸门字段。未发现新的注入面。
- **安全**：诊断只存 `stage/reasonCode/cause`，不存 `error.message`，不给模型看；没有发现秘密外泄。但“只写不读”使安全排查价值打折。
- **资源耗尽**：诊断键是固定长度 digest，不随 toolCallId 长度增长；失败重试同键 replay，不会无限堆积；`#inFlight` 在 settle 后删除。未发现新的无界增长。
- **不可撤销操作**：本步接入的 owner-scope 行全部登记为可撤销（`reminder_set/cancel`、`rule_set/undo`），任务取消仍走原有 `TASK_RESOURCE_AUTHORITY_REQUIRED`，没有把不可撤销动作误接到自动预授权。`reminder_cancel`/`rule_undo` 归类为可撤销是 ADR 的明确决定，未重复质疑。
- **规则/文档/代码一致**：核对了 ADR 前提 1、2、6、8、14、31、34、35 的行号和引文，均对得上；`check:rule-registry` 已包含新的 policy fact 测试和 registry 集成测试。发现“新值清单漏列诊断键”（上一条）。
- **发给模型的请求开头**：核对 `listAuthorized` 的 `offer` 过滤、工具名清单、`createHash` 快照断言；未发现当前生产工具定义字节变化。参见必答问题 1。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
当前生产配置下不会。系统提示没改；工具定义由 `listAuthorized` 生成，新增的 `this.#registry.offer(descriptors)` 只做 `filter`，保持原顺序和原对象，而当前所有可给模型的工具都在 `PRODUCTION_TOOL_ACTION_ROWS` 里；`[ADR-0257] offers every tool...` 用例还断言了名字顺序和定义哈希。历史、遮盖都没改；新增的只有工具结果文本（`操作未执行：authorization_component_error` 等），在末尾追加。每轮会变的值（`owner-scope-intent` 的 `requestedAt/expiresAt`、诊断的 `createdAt`、诊断键）都只在 trace artifact 里，不进入发给模型的内容。

需要保留两点：`offer` 会**有意丢弃**没登记的工具（测试里有反向用例），所以它是“工具集合变化”的入口；另有一个潜在接线风险——如果 `ProductionRuntimeTools` 和 `OwnerScopeAuthorization` 拿到不同的 registry（见上一条低），出工具的一端可能和查清单的一端不一致。

**2. 同一段文字会不会在不同请求里变成不同字节？**
模型可见内容不会。`actionGateFacts` 对事实代码 `.sort()`，`runtimePolicyFacts` 去重后排序，`decideActionRules` 取最严结果；intent id、idempotency key、诊断键都用固定数组的 sha256，不依赖对象遍历顺序。没有把时间字段写进 `modelContent`。存下的 `requestedAt/expiresAt/createdAt` 会随调用变化，但不发给模型；诊断的 `cause` 可能因错误类型不同而不同，也只进 trace artifact，不影响请求字节。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
大部分有：工具定义名字/哈希与“未登记工具不给模型”的反向用例、policy fact 的未登记/重复/未排序反向用例、规则例子翻转/表达式替换的反向用例、owner-scope 集成测试。对**本轮新增的诊断**，只有正例（键存在）；缺少“写入失败被忽略”和“停止/取消不写诊断”的反向断言，所以这两条声称的行为目前没有检查守着（见上文低）。另外，由于诊断没有读取方，也没有测试能发现 `diagnose run` 看不到它。

**4. 每个新值/修改值，产生处和使用处两端都能接受吗？**
逐项核对结果：

- `owner-scope-diagnostic:` 键：产生处 `production-runtime-tools.ts:666-670`；使用处没有（`sqlite-run-diagnostics.ts:4-6` 不匹配）——**这里不一致**，见上文“中”。
- 诊断内容 `{stage, reasonCode, cause}`：产生处同上；使用处没有；若以后加进 `diagnose run`，该命令只是 `JSON.parse` 后原样输出（`diagnose-command.ts:57-60`），不校验 schema。`cause` 对普通 Error 会退化成 `"Error"`。
- `authorization_component_error`：产生处 `production-runtime-tools.ts:671-675`；使用处 `runtimeToolAuthorizationResult` 把任意 `reasonCode` 拼进 `modelContent`（`runtime-tool-authorization.ts:31-37`），没有枚举限制，能接受。
- `action-rule:<ruleId>` 状态键与 `{enabled, ruleRevision, actorId}`：产生处 `owner-scope-authorization.ts:223-247`；后端消费处 `sqlite-durable-operations.ts:2091-2103` 检查 `revision` 相等且 `JSON.parse(valueJson).enabled === true`，`durable-adapters.ts:365-369` 的 `isPolicyAuthorizationCurrent` 也同样检查。生产值 `{enabled:true,...}` 能通过，**两端一致**。
- 新的事实代码 `run_source_*`、`owner_presence_required`、`standing_rule_change`：产生处 `owner-scope-authorization.ts:121-123,158`；消费处 `assertPolicyFactCodes`（登记、唯一、排序）、`RuleJudge`、审批快照/gateway 的 `deterministicFactCodes`。所有代码都在 `POLICY_FACT_REGISTRY`，且 `machineString` 的 1–128 字符规则能接受这些短代码。
- 动作闸门 `action` 及字段：产生处 `field-catalog.ts:9,79-117`；消费处 `rule-expression.ts:43-45` 自动从 `RULE_GATES` 建环境、`rule-book.ts:446` 限定结果值、`actionGateFacts` 提供全部字段。两端一致。
- `action-rule` 的 intent id / idempotency key：`owner-scope:<64 hex>` 约 76 字符，`machineString` 上限 128，字符集允许 `:`、`.`、`_`、`-`，能通过审批快照/gateway 校验。
- `ToolActionRow.executor/targetType`：`#builtinExecutor` 用裸字符串 `"owner_scoped"` 和 `"owner-memory/reminder/rule"` 匹配（`production-runtime-tools.ts:622-628`），目前和 `production-tool-actions.ts` 一致；但两端都没有类型约束，拼错会静默变成 `reject()`，建议改成共享常量或类型化。
- `BUILT_IN_CAPABILITY_VERSION` `"1.0.0"`：`builtInCapabilityFacts` 和 `OwnerScopeAuthorization` 的 intent 都用同一常量，`ActionPolicyService.capabilityDenial` 比对版本/操作/数据范围，两端一致。
