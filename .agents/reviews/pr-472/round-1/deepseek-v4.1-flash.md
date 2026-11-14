结论：未发现高、中严重度缺陷；两处修复方向都正确，但文档与测试存在两个低严重度问题，另有一个错误路径上的清理健壮性问题。

## 发现的问题（按严重度）

### 低：设计文档仍写 `proactive.modelRef` 只要求允许 private，与新启动校验不一致

- 文件:行：`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:299`
- 问题：文档说 `modelRef`“用哪个模型，必须允许私密数据”，但改动后代码还要求 `api === "openai-completions"`。运维若照文档给 `proactive.modelRef` 配 TypeSafe specialist，启动会被拒。
- 证据（已读文档原文）：“`modelRef`（用哪个模型，必须允许私密数据）”。
- 证据（已读代码）：
  ```ts
  descriptor.api !== "openai-completions" ||
  !descriptor.allowedDataClassifications.includes("private")
  ...
  "must name a configured openai-completions generation model that accepts private data"
  ```
  `packages/platform-node/src/strict-configuration.ts:1731-1736`
- 建议：把该行改成“必须允许私密数据且 `api` 为 `openai-completions`（不能是 TypeSafe specialist）”，或指向新的配置说明。

### 低：名为“including a failed one”的用例并未覆盖真正的模型失败路径

- 文件:行：`test/integration/review-prereview-production.test.ts:331`
- 问题：用例标题和作者说法称覆盖“failed one”，但 `broken reply` 的模型调用是成功的，只是输出无法解析成评分（`MODEL_OUTPUT_INVALID`）。真正会走 `model.failed`、`model.invoke` 抛错、`readOutput` 抛错的分支没有用例。
- 证据（已读）：
  ```ts
  if (data.text.includes("broken")) return { output: "not a rating", costMicros: 700 };
  ```
  `test/integration/review-prereview-production.test.ts:52`
  ```ts
  expect(await h.service().prereview()).toMatchObject({ attempted: 2, recorded: 1 });
  ```
  `test/integration/review-prereview-production.test.ts:336`
- 建议：增加一个 `yield { type: "model.failed", ... }` 或让 `invoke` / `readOutput` 抛错的用例，断言 `in-*` 仍被释放。当前 `finally` 逻辑看起来能覆盖，但没有自动验证。

### 低（错误路径，推测）：清理失败会被静默吞掉，且顺序删除时第一个失败会跳过后续 payload

- 文件:行：`packages/application/src/services/review-prereview.ts:397`
- 问题：`model.release([...]).catch(() => undefined)` 吞掉所有清理错误；而生产实现是逐个 `await delete`，一旦删除 `inputRef` 失败，后面的 `out-*` 不会被尝试删除，仍然留下 payload。这次把 `inputRef` 放在列表第一项，放大了这个错误路径的影响。
- 证据（已读）：
  ```ts
  await model.release([authority.inputRef, ...outputs]).catch(() => undefined);
  ```
  `packages/application/src/services/review-prereview.ts:397`
  ```ts
  async release(payloadRefs: readonly string[]): Promise<void> {
    for (const ref of payloadRefs) await this.#payloads.delete(ref);
  }
  ```
  `packages/runtime-pi/src/pi-model-transport.ts:96-98`
- 建议：在边界层改成每个 ref 独立尝试（`Promise.allSettled` 或逐个 `catch`），至少保证一个 ref 删除失败不影响其余 ref；是否上报清理失败可另行决定。若保持 best-effort，也应记录一次诊断。

## 侧重检查

- **错误路径**：`prepare` 成功后 `invoke` 抛错/中止，`finally` 仍会释放 `inputRef` 和已产生的 outputs（`review-prereview.ts:395-398`）；`prepare` 内部写 payload 后拿不到 secret handle 时，生产实现会自行释放 `inputRef`（`production-model-composition.ts:553-555`）。均符合预期。
- **不可信配置输入**：新增校验在 `parseProductConfiguration` 内执行，TypeSafe specialist 会在启动时被拒；测试构造的 specialist 确实带 `api: "typesafe-systemone"`，老代码会接受，新代码会拒绝。
- **资源耗尽/不可撤销操作**：删除的是加密后的提示 payload，属于有意的数据最小化，不涉及表结构或模型请求内容；但清理失败是静默的，见上。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 不需要改，因为请求内容没有变化；但执行设计文档的 `proactive.modelRef` 描述已落后于代码。
- **邮件检查的 inputRef 保留**：已读代码确认 `trace.payloads` 记录 `model_input`/`model_output` 并通过 `decision_ledger_payloads` 持久化（`proactive-mail-check-service.ts:1399、1425、1807`；`sqlite-proactive-operations.ts:783-789`），后续也有按该表收集/删除的路径（`sqlite-proactive-operations.ts:476-498`）。作者“由检查记录负责”的说法基本成立；完整的保留期/删除策略未继续追踪，标“未核实”。

## 读代码证实的

- `authority.release()` 在生产实现中只吊销 secret handle：
  ```ts
  release: async () => {
    if (handle) await options.handles.revokeHandle(handle.ref, options.clock.now());
  },
  ```
  `apps/agent-service/src/production-model-composition.ts:562-564`
- `prepare` 确实把 prompt 写成 `inputRef` 指向的加密 payload：`production-model-composition.ts:534-540`。
- `production-real-eval.ts` 原本就把 `authority.inputRef` 放进释放列表：`production-real-eval.ts:319、360-365`。
- 老代码只释放 outputs，新增代码释放 `[authority.inputRef, ...outputs]`；diff 只有这一行行为变化（除配置校验和测试）。
- 新启动校验与 `proactiveModel` 的检查一致：
  ```ts
  descriptor?.api !== "openai-completions" ||
  !descriptor.allowedDataClassifications.includes("private")
  ```
  `production-model-composition.ts:509-513`
- 改动没有新增表、字段、清单项或序列化格式；没有改 `prereviewPrompt`、系统提示、工具定义、历史消息或遮盖逻辑。

## 推测/未核实

- 测试和 `npm run check` 未实际运行（当前只能使用 git 和只读工具）；“旧代码下失败”是按旧代码逻辑推断：旧的 `model.release(outputs)` 不会包含 `in-*`，旧的配置校验会接受 specialist。
- 删除失败后的实际行为（是否真的会留下 payload）未通过故障注入验证，属于错误路径推断。
- 邮件检查 payload 的最终保留/删除周期只看到收集和删除入口，未核对其完整触发策略。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在调用结束后删除本地加密 payload，以及启动时收紧配置校验；`prereviewPrompt` 仍是固定目录文字在前、本条数据在最后（`review-prereview.ts:64-76`），没有改系统提示、工具定义、历史消息或遮盖结果。发给模型的内容仍然只在末尾追加，会变的值仍只在末尾数据里。规则文件无需更新。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。没有新增时间字段、无序集合或依赖前后文的遮盖；`prereviewPrompt` 的 `JSON.stringify` 字段顺序未变，释放操作只删存储、不参与序列化，配置校验也不影响提示字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有两条针对性回归：
   - `review-prereview-production.test.ts:331` 断言每次调用都释放 `in-*` 和 `out-*`；按旧代码只释放 outputs，应失败。
   - `startup-configuration.unit.test.ts:1572` 断言 TypeSafe specialist 作为 proactive 模型会被拒；按旧代码会通过，应失败。

   另有既有的 `review-prereview.unit.test.ts` 覆盖提示词确定性和遮盖，`model-payload-cleanup.unit.test.ts` 覆盖生产 boundary 的释放语义。缺口是：所谓“failed one”只覆盖输出解析失败，不覆盖 `model.failed`/异常；也没有端到端断言真实 SQLite `payloads` 行被删除。测试执行结果未实际运行验证。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `authority.inputRef`：由 `proactiveModel.prepare` 写入并返回（`production-model-composition.ts:534-540`），由 `model.release` 按 `readonly string[]` 接收（`review-prereview.ts:397`），最终进入 `payloadBoundary.release` → `payloads.delete`（`production-model-composition.ts:568`、`pi-model-transport.ts:96-98`）。两端都是字符串 ref，没有格式校验冲突。
   - 新配置值 `"openai-completions"`：由 `parseModel` 产出（`strict-configuration.ts:430-457`），启动校验和 `proactiveModel` 都按完全相同的字面量比较（`strict-configuration.ts:1731`、`production-model-composition.ts:510`），两端一致。
   - 新错误文案只用于报错，不被其他逻辑消费。
   - 没有新增模型标识、清单项、数据库字段或序列化格式，因此不存在 I-73 式“清单 id 过不了后端校验”的另一端问题。唯一跨文件不一致是上面的设计文档描述。
