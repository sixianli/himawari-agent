## 结论摘要

改动本身没有触碰模型请求组装，因此不会改变已发前缀；但“辅助调用共用 thread-title 账户”只修了一半：**episode/consolidation 的 embedding 调用仍走 run 账户**，同类 `PORT_CONFLICT` 仍可能出现。`site` 日志有覆盖缺口，且实现是原样输出 `PORT_` 错误的 message，需要收紧。

---

## 读代码证实的问题（按严重度）

### 高：同类拒绝仍存在于 run 账户及辅助 embedding 路径

文件：`apps/agent-service/src/production-run-memory.ts:161-165`、`:283-298`；`apps/agent-service/src/production-memory-episodes.ts:98-107`；`apps/agent-service/src/production-run-composition.ts:532-535`、`:545-546`；`packages/application/src/services/model-invocation-admission-service.ts:410`；`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:494-498`

问题：这次只让 `thread-title` 账户的分级可升。片段总结/整理自己的模型生成走 `thread-title`，但它们的 **embedding** 通过 `embedWithin` 进入 `createProductionRunMemory`，在非 projection/mail/maintenance 分支里调用 `gate.begin` 时没有传 `budgetAccount`，于是默认落到 `run` 账户；传入的分类来自片段/记忆自身。

证据：

```ts
// production-memory-episodes.ts:98-107
const scoped = { ...request, dataClassification: segment.dataClassification };
await this.#within(scoped, `memory-episode-embed-${index}`, () =>
  this.#options.service.summarize(segment, (prompt, dataClassification) =>
    this.#options.generate(
      { ...request, dataClassification },
      ...
```

```ts
// production-run-memory.ts:282-298
const admitted = await whileHeld(
  gate.begin({
    modelRef: descriptor.ref,
    ...
    dataClassification: classification,
    ...
  }),
);
```

```ts
// model-invocation-admission-service.ts:410
budgetAccount: input.budgetAccount ?? "run",
```

```ts
// sqlite-model-budget-operations.ts:494-498
if (input.parent.kind === "thread-title") {
  account = this.raiseAuxiliaryAccountClassification(account, input.dataClassification);
} else {
  this.assertAccountClassification(account, input.dataClassification);
}
```

因此：主对话 run 账户初始为 private，而旧 episode/consolidation 的 embedding 是 sensitive/restricted 时，仍会报同一句 `Budget account classification is immutable`。另外主对话后续流在 `packages/runtime-pi/src/pi-runtime-adapter.ts:1670` 使用 `#visibleOf(request)`，而 `:2209-2210` 会因工具结果提高可见分级；这也会把更高的分级带到 run 账户的 `gate.begin`（`pi-runtime-adapter.ts:1076-1087` 同样没有传 `budgetAccount`）。

建议：给辅助 embedding 单独账户，或让 episode/consolidation 的 embedding 明确使用 `thread-title`；如果确认账户分级不是安全/披露边界，也可以考虑对 run 账户采用同样的“只升不降”。至少要新增“主对话账户已 private，episode/consolidation embedding 为 sensitive”的集成测试；按当前代码它会失败。

### 中：`site` 字段只有 helper 单测，日志接线没有自动检查

文件：`packages/platform-node/test/service-failure-reason.unit.test.ts:30-50`；`apps/agent-service/src/service-main.ts:2597-2603`、`:2627-2633`、`:2660-2666`

问题：[I-94] 的单元测试只验证 `portErrorSite()` 本身，没有验证 `memory-capture.failed`、`memory-episode.failed`、`memory-consolidation.failed` 真的带上了 `site`。把 `service-main.ts` 里的 `...siteField(error)` 删掉，这个测试仍然通过。

证据：

```ts
// service-failure-reason.unit.test.ts:31-37
it("returns the refusing check's message for a PORT_ error", () => {
  const error = Object.assign(new Error("Budget account classification is immutable"), {
    code: "PORT_CONFLICT",
  });
  expect(portErrorSite(error)).toBe("Budget account classification is immutable");
});
```

建议：增加一个捕获 `writeServiceDiagnostic` 输出的测试，直接驱动这三个失败回调，断言日志里有 `site`；否则文档里的“测试覆盖了 site”是 overstated。

另外 `thread-title.failed` 仍然只写 `code`（`service-main.ts:2577-2582`）。标题调用和记忆调用共用同一个 thread-title 账户；如果被拒的是标题调用，仍然看不出是哪一处拒绝。

### 低：`portErrorSite` 原样输出 `PORT_` 错误的 message，缺少脱敏/白名单

文件：`packages/platform-node/src/service-runtime.ts:61-73`、`:81-87`

问题：`portErrorSite` 只要 `code.startsWith("PORT_")` 就把 `error.message` 原样截 200 字符写入日志；`writeServiceDiagnostic` 只做 `redactMachineSecrets`，不做通用脱敏。当前内存链路里我看到的 `PORT_` 消息多为固定文案或机器标识（例如 `trusted-model-provider.ts:130-133`、`:148-151`，SQLite 操作的 `PORT_NOT_FOUND` 多为 ID/ref），**未发现当前会写入模型或用户正文**。但这是一个开放通道：将来任何把路径、URL、供应商文本放进 `PORT_` message 的地方都会进日志。

证据：

```ts
// service-runtime.ts:66-72
!error.code.startsWith("PORT_") ||
...
return error.message.slice(0, 200);
```

```ts
// service-runtime.ts:85-86
const serialized = JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic });
output.write(`${redactMachineSecrets(serialized)}\n`);
```

建议：对 `site` 使用已知错误码到固定说明的映射，或至少对 message 做与日志一致的脱敏；补一个“PORT_ 错误 message 含密钥样式文本时必须被遮盖”的测试。

### 低：I-94 文档对“共用 thread-title 账户”的描述不完整

文件：`docs/incidents-and-gates.md:128`

问题：文档说“同一轮里标题、记忆保存、片段总结、整理共用一个预算账户（`thread-title:<runId>`）”。这对这些流程的 **模型生成** 成立，但对片段总结/整理过程里的 **embedding** 不成立；它们走 run 账户。文档没有提到这个残留路径，也没有说明新的集成测试只在 CI 的 `coverage` 项目里跑，不在本地 `npm run check` 中。

建议：在 I-94 的门槛/根因里补充 embedding 路径，并明确测试所在 CI 阶段；如果按 ADR 0176 合并不等 CI，本地合并前不会跑这条集成测试。

---

## 推测 / 未核实

- **未核实**：生产 09:13 JST 的三条 `PORT_CONFLICT` 是否确实全部来自 `Budget account classification is immutable`。作者自己说明生产日志只有错误码，按代码推断；我未看到生产日志。
- **未核实**：生产配置是否真的会为片段总结/整理执行远程 embedding；代码路径存在，但需要运行配置才能确认实际会走到 `production-run-memory.ts` 的 run 账户分支。
- **未核实**：账户 `data_classification` 是否被仓库外的报表、导出或审计工具消费。仓库内我只找到 `budget.read`/测试读取它，没有发现按账户分级做模型路由、披露或导出过滤的消费者。
- **推测**：如果 run 账户上确实会出现 `#visibleOf` 提升后的分类，这很可能是一个既有缺陷，不是本 diff 引入；但它与 I-94 是同一类问题，且本 PR 没有覆盖。

---

## 侧重检查

- **错误路径**：`portErrorSite` 对非对象、无 `code`/`message`、非 `PORT_` 错误返回 `undefined`，不会抛异常；但 `site` 只存在于这三个 memory 失败日志，标题失败仍没有。
- **不可信输入**：`dataClassification` 在 `parseReserve`/`parseBegin` 中经过 `classification()` 白名单校验，SQL 全部参数化；`raiseAuxiliaryAccountClassification` 的 UPDATE 也只绑定已校验的值，没有 SQL 注入新增面。
- **安全/披露**：账户分级只升不降不会让“账户分级低于调用”；每笔 allocation 仍写入自己的 `input.dataClassification`（`sqlite-model-budget-operations.ts:526-535`）。仓库内没有发现把 `account.dataClassification` 用于模型披露决策的代码，因此我没有发现直接披露问题；但未来若有消费者把它当作每笔 allocation 的分级，会表现偏保守。
- **资源耗尽**：每次预留只多一次单行 UPDATE，O(1)，没有新的循环、递归或无界集合。
- **不可撤销操作**：改动只更新一行账户分级，没有破坏性迁移；但“只升不降”没有降级路径，错误的高分级会永久留在账户上（偏保守，不是泄露）。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的追加规则没有被本 diff 触碰；I-94 的描述与实际 embedding 账户路径不一致，测试覆盖描述也偏乐观。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个 diff 只改预算账户分级和失败日志，没有改系统提示、工具定义、历史消息、资料块或遮盖规则。发给模型的内容仍然只在末尾追加，每轮会变的值仍应在最后一条消息里；依据 `.claude/rules/prompt-prefix.md:27-35`。账户分级和 `site` 都不是模型输入。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响模型请求。预算账户的 `data_classification` 更新不参与请求序列化；`site` 只进日志，且时间戳本来就让日志逐行不同。没有新增依赖前后文的遮盖、无序集合或模型可见的时间字段。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但覆盖不完整。`test/integration/sqlite-model-budget-operations.test.ts:2131-2171` 的 `[I-94]` 按改前代码会在第二次 `begin` 触发 `Budget account classification is immutable`，所以它是有效的回归用例；它位于 CI 的 `integration`/`coverage` 项目。`packages/platform-node/test/service-failure-reason.unit.test.ts:30-50` 只测 helper，不测 `service-main` 的日志接线。按工具约束我没有实际运行测试，以上是根据代码推断。另：本地 `npm run check` 的 `check:steps` 不包含 integration 项目。

4. **改动产生/修改的每个值，两端都能接受吗？**
   - `model_budget_accounts.data_classification`：产生方是 `raiseAuxiliaryAccountClassification`；使用方是 `readAccount`、`toAccount`、`budget.read`。数据库 CHECK 只接受四个枚举值，`readAccount` 又用 `classification()` 校验；仓库内除测试外没有发现其他消费者，接受。
   - 每笔 allocation 的 `data_classification`：未改，仍由调用方传入并原样写入，`model-invocation-operations.ts:496-506` 会核对返回的 allocation 与输入一致，接受。
   - `site`：产生方是 `portErrorSite`，使用方是 `writeServiceDiagnostic` 的 `Record<string, string | ...>` 和 `redactMachineSecrets`；类型接受，但缺少对日志接线的测试，且有原样输出 message 的风险。
   - `[I-94]` 清单项/测试名：`check-incident-gates.mjs` 只检查文档中引用的路径存在，不检查测试是否真的会失败；路径存在，但“改前失败”的声明只能靠人复核。
   - 没有新增配置键、清单 id 或序列化格式需要跨端校验。
