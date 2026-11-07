## 结论

本次增量（b9d90717..ddf64aaa）只改了 5 个文件：`PiModelTransport.#egressContextFor` 的取消赛跑、`productionEgressThreadOf` 抽取、service-main 接线、以及两处测试。**读代码未发现会导致运行时出错的缺陷**；只发现一处低严重度的测试覆盖缺口。以下按要求给出。

---

## 发现（按严重度从高到低）

### 低：新端到端测试没有覆盖 service-main 的接线

- 文件:行：`apps/agent-service/src/service-main.ts:300`；`apps/agent-service/test/production-model-composition.unit.test.ts:1863`
- 问题：作者说“生产接线没有端到端测试”，但新测试是直接调用 `createProductionModelComposition` 并手工传入 `productionEgressThreadOf(...)`，**没有经过 `service-main` 的 `createDefaultModelComposition`**。如果有人在 service-main 里去掉 `egressThreadOf: productionEgressThreadOf(repository, configuration)` 这一行，新测试仍然通过（组合层透传还在）。
- 证据（亲自读到）：
  - `service-main.ts:294-300` 里唯一的生产接线是：
    ```ts
    egressThreadOf: productionEgressThreadOf(repository, configuration),
    ```
  - 测试 `production-model-composition.unit.test.ts:1861-1867` 是自己构造：
    ```ts
    egressThreadOf: productionEgressThreadOf(repository, {
      ownerId: ownerId as never,
      agentId: agentId as never,
    }),
    ```
  - 全仓搜索 `productionEgressThreadOf|egressThreadOf` 只在该测试和源码出现，service-orchestration 测试没有断言这条接线。
- 建议：给 `createDefaultModelComposition`（或其工厂）加一条测试，断言构造出的组合确实把 `egressThreadOf` 传给动作复核 transport；或者让 service-main 的生产组装函数可注入并被该端到端测试使用。否则“生产接线”仍只能靠类型检查和人工保证。
- 性质：测试覆盖缺口，不是运行时错误。

### 观察（不是错误，供确认）

- `packages/runtime-pi/src/pi-model-transport.ts:258-262`：取消时只是停止等待，`threadOf` 代表的数据库读本身不会被中止。对当前 better-sqlite3 的同步读来说没有实际差别；如果将来换成异步/远程读，取消后仍会有一个后台读继续占用资源。这是“停止等待”，不是“取消 I/O”，作者说法与实际一致。
- `pi-model-transport.ts:262`：取消/查询失败时返回的是“原上下文”。在生产动作复核里原上下文 `threadId` 确实是 `null`（`production-model-composition.ts:330-336`）；如果将来有人给一个非空 `threadId` 的上下文同时配 `egressThreadOf`，失败路径会保留原来的非空 `threadId`，而不是 null。当前接线不受影响。

---

## 读代码证实的 / 推测的

**读代码证实：**

1. 取消赛跑的监听在 `finally` 移除：`pi-model-transport.ts:265-267`。
2. 没有 `signal` 时仍会正常查对话并返回：`pi-model-transport.ts:251` 只在 `context === undefined || threadOf === undefined || signal?.aborted` 时提前返回；`signal?.addEventListener` 和 `removeEventListener` 都是可选调用。
3. 查询同步抛错会被 `catch` 吞掉并返回原上下文：`pi-model-transport.ts:257-264`，`threadOf(request.runId)` 在 `try` 内同步求值。
4. 取消后不会继续发模型请求：`pi-model-transport.ts:360` 仍有 `request.signal?.throwIfAborted()`，它在 `egressContextFor` 之后、`stream()` 之前；失败会被 `408-418` 转成 `MODEL_REQUEST_CANCELLED`。
5. 新测试确实用真实 `createProductionModelEgress`、`productionSensitiveInterceptionRecorder`、`productionEgressThreadOf`、SQLite 仓库，并通过 `composition.model.invoke`（动作复核）发请求：`production-model-composition.unit.test.ts:1810-1954`。
6. 测试在 flush 前删除 run，记录仍要求 `threadId` 对应 `threads` 表中的行存在；`record` 校验的是 threads，不是 runs：`sqlite-sensitive-interception-operations.ts:120-143`；`threadOfRun` 查的是 runs：同文件 `229-236`。因此删除 run 后仍能记录到 `thread-review`，只有在“flush 时才解析对话”的实现下才会变成 null。
7. `productionEgressThreadOf` 只是把 `repository.sensitiveInterceptions().threadOfRun({ownerId, agentId, runId})` 包了一层：`production-model-egress.ts:46-58`，与原来 service-main 的内联实现等价。

**推测（未运行测试，无法核实）：**

- 作者声称的“反向用例会失败”从代码推导成立：旧实现下取消测试会在 1 秒后得到 `still waiting`；去掉组合层透传后记录 `threadId` 变 null。但我没有实际执行测试，故标「未核实」。
- 提交信息里“235 条测试全部通过”“npm run check 33 steps 通过”未核实。

---

## 侧重检查

- **错误路径：查询同步抛错 / 异步拒绝**：`#egressContextFor` 的整个 `threadOf(...)` 调用和 `Promise.race` 都在 `try` 内，`catch` 返回原上下文，`finally` 移除监听。结论：不会把查询错误暴露给上层，符合作者说法。
- **错误路径：请求已取消 / 查询途中取消**：已取消直接返回原上下文；途中取消由 `cancelled` promise 胜出返回原上下文，随后 `throwIfAborted` 结束调用。结论：不会发请求，不会写遮盖记录。
- **无 signal**：`cancelled` promise 永不 resolve，但 `signal?.addEventListener` 不挂监听，race 由查询结果胜出；`stop` 仍被赋值，`finally` 只是可选调用空操作。结论：正常。
- **监听泄漏**：唯一挂监听的分支在 `try/finally` 内，所有正常/异常/取消路径都会走到 `finally`。结论：未见遗漏。
- **资源耗尽**：取消只停止等待，不中止底层读；当前查询是同步 SQLite，风险有限。队列上限、批量写入是既有机制（`sensitive-interception-recorder.ts:13-15,125-133`），本次未改。
- **不可信输入**：`threadOfRun` 对 `ownerId/agentId/runId` 做长度与非空校验（`sqlite-sensitive-interception-operations.ts:229-236`）；记录时对 `threadId` 再做长度校验并要求 thread 存在（同文件 `45-58,120-143`）。结论：新增函数没有绕过这些校验。
- **安全 / 指纹**：指纹用 HMAC 输出 16 字节再转 32 位十六进制（`model-egress.ts:53-59,186-209`），原始秘密不落库；`sensitiveInterceptionDedupeKey` 也不含原文。结论：未引入明文泄漏。
- **不可撤销操作**：测试中的 `DELETE FROM runs` 只发生在临时 SQLite 测试库，不涉及生产数据；但要注意该测试反过来依赖“record 不校验 run 存在”，若未来 `record` 增加对 run 的校验，这个测试会失效/误报。结论：当前无生产风险。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。发给模型的内容装配点在 `pi-model-transport.ts:310` 的 `backgroundModelContext(prompt, Date.now())`，本次未动；系统提示、工具定义、历史都未改。`egressThreadId` 只进入 `ModelEgressContext`，而 `ModelEgressContext` 在 `model-egress.ts` 中只被 `#report` 用来记录（`126-134`），不参与遮盖和请求体序列化。取消路径根本不发请求。因此仍然只在末尾追加；每轮会变的时间仍在最后一条用户消息里。依据 `prompt-prefix.md#rules` 的判断成立。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。遮盖输出由 `tag: (kind, secret) => letters(sign(key, kind\0secret))` 决定（`model-egress.ts:189-194`），与 threadId、时间、取消无关；新增的 `report` 只在遮盖完成后读取结果并发通知，不改变返回文本。同一 key、同一内容，字节相同。既有 `known`（同一次请求内点名后向后续消息传播）和验证码关键字窗口是上一提交已有的机制，本次未改；它们不会因“后续请求”改变已发历史的字节（窗口限于被遮盖的单个字符串内）。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有。`packages/runtime-pi/test/pi-model-transport.unit.test.ts:1068` 的 `[SI-2] stops waiting...` 覆盖取消赛跑；`apps/agent-service/test/production-model-composition.unit.test.ts:1808` 的 `[SI-2] files what an action review masked...` 覆盖动作复核记录。按代码推导，旧实现会让前者在 1 秒后返回 `still waiting` 而失败，去掉组合层 `egressThreadOf` 透传会让后者的 `threadId` 变 null 而失败。**但 service-main 那一条接线没有被测试覆盖**（见上面“低”发现）；实际测试是否通过未运行，标「未核实」。

**4. 每个值两端都能接受吗？**

能。
- `productionEgressThreadOf` 产出 `Promise<ThreadId|null>`（`production-model-egress.ts:49-57`），与 `PiModelTransportOptions.egressThreadOf` 的返回类型 `Promise<ModelEgressContext["threadId"]>` 一致（`pi-model-transport.ts:119-122`）。
- 运行 ID 由 `threadOfRun` 校验为 1..256 字符（`sqlite-sensitive-interception-operations.ts:229-236`）；记录的 `threadId` 要求为 null 或 1..256 字符，并且必须存在于 `threads`（同文件 `45-58,120-143`）。测试插入了对应 thread，删 run 不影响这项校验。
- 测试期望的 `source: "background"`、`purpose: "action-review"`、`category: "verification-code"`、`outcome: "masked"` 均在 `SENSITIVE_INTERCEPTION_*` 允许集合内（`packages/application/src/ports/sensitive-interceptions.ts:3-35`），`purpose` 长度 < 64，`fingerprint` 为 32 位小写十六进制，满足 `/^[0-9a-f]{16,64}$/`（同文件 `49-58`）。
- 唯一需要留意的是：`record` 会静默 `skipped` 掉 thread 不存在的记录（`sqlite-sensitive-interception-operations.ts:137-143`），但生产动作复核的 run 必然挂在已有 thread 上，本次测试也构造了 thread；不属于本次改动引入的问题。

---

## 总评

两条采纳的改进在实现层面与作者描述一致：取消赛跑没有漏掉监听移除，无 signal 正常，已取消/途中取消都会按原上下文继续并由原有 `throwIfAborted` 收尾；新端到端测试确实走 `composition.model` 的动作复核路径，并且能防止组合层透传被删。唯一值得补的是 **service-main 接线本身的测试**：它才是“生产接线”最外层，当前删除那一行不会被任何测试发现。除此之外未发现“会出错”的问题。
