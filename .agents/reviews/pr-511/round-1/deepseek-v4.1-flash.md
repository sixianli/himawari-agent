## 结论

本次改动只改了 `docs/adr/0237-model-pre-rates-waiting-decisions.md:51` 一行，没有改代码。逐条核对后，作者关于「24 小时清理（`PREREVIEW_FAILURE_BACKOFF_MS = DAY_MS`）、重启清空（实例字段）、模型放开级别后表项失效」的说法与 `packages/application/src/services/review-prereview.ts` 的实现一致。没有发现高或中严重度问题，以下是低严重度的改进点。

### 1（低）「模型放开级别后下一次检查就会评它」没有写出仍受 perRun、每日次数和失败退避限制

- 文件:行：`docs/adr/0237-model-pre-rates-waiting-decisions.md:51`
- 问题：这句话读起来像是无条件的。实际上循环在检查分类缓存之前就可能因 `perRun` 用尽而 `break`，或因 `dailyLimit` 用尽而提前返回；`pending` 还会排除已完成和最近失败的条目。预算或退避不满足时，下一次检查不会评它。
- 证据：`packages/application/src/services/review-prereview.ts:234-246`：
  ```ts
  for (const { source, ref } of pending) {
    if (attempted >= settings.perRun) break;
    if (attempts >= settings.dailyLimit)
      return { attempted, recorded, failures, skippedClassification, stoppedBy: "daily_limit" };
    ...
    const knownSkip = this.#classificationSkipped.get(source.key);
    if (knownSkip !== undefined) {
      if (!allowedClassifications.includes(knownSkip.classification)) {
        skippedClassification += 1;
        continue;
      }
      this.#classificationSkipped.delete(source.key);
    }
  ```
  以及同文件 `:216-222` 的 `pending` 过滤：`!done.has(...) && !failedRecently.has(...) && !this.#storeFailedAt.has(...)`。
- 建议：改成「在下一次检查还有 `perRun` 和每日次数余额、且该条目仍在待评列表时评它」，或把这半句和前面的上限说明合并。
- 读代码证实。

### 2（低）新增的「24 小时」和「不占每日次数」没有直接对应的自动检查

- 文件:行：`test/integration/review-prereview-production.test.ts:411-429`
- 问题：现有测试覆盖了立即重跑不重新 build、不占 `perRun`、模型放开后重评，但没有测试 24 小时过期，也没有直接测试分类跳过不消耗 `dailyLimit`。本次文档改动本身也没有内容校验：`check:docs-links` 和 `check:adr-numbers` 都会跳过外部 URL。
- 证据：`test/integration/review-prereview-production.test.ts:425-428`：
  ```ts
  const reads = () => h.reads.filter((ref) => ref === "memory-a-secret").length;
  expect(reads()).toBe(1);
  expect(await service.prereview()).toMatchObject({ attempted: 0, skippedClassification: 1 });
  expect(reads()).toBe(1);
  ```
  这里只是紧接着的第二次运行，没有 `h.clock.advance(DAY_MS)`；同文件里推进一天的 `:455`、`:482` 分别属于每日上限和失败退避用例。`scripts/check-docs-links.mjs:108` 对带 scheme 的 URL 直接 `continue`；`scripts/check-adr-numbers.mjs:79`、`:93` 也跳过外部 URL。
- 建议：补一条推进 `DAY_MS` 后确认会重新读取并再次跳过（或不跳过）的测试，以及一条 `dailyLimit` 不被分类跳过消耗的测试；至少把 ADR 的「验证」一节补上这个行为。反向用例 `:431` 能防「允许的条目被错误跳过」，但不能单独证明「不允许的条目不会被评」。
- 读代码证实；未运行测试。

### 3（低）直接改写已接受 ADR 的决定段，和文档治理的「不改写旧 ADR」规则需要确认

- 文件:行：`docs/adr/0237-model-pre-rates-waiting-decisions.md:51`、`.agents/instructions/document-governance.md:18`、`:55`
- 问题：`0237` 的 frontmatter 是 `decision_status: accepted`、`amends: ""`，本 PR 直接往「决定」第 3 点追加内容。治理规则写「决定改变时……绝不改写先前 ADR 的决定内容」以及「用新 ADR 取代旧 ADR，而不是改写旧 ADR」。
- 证据：`docs/adr/0237-model-pre-rates-waiting-decisions.md:2-7`：
  ```yaml
  status: active
  decision_status: accepted
  supersedes: ""
  amends: ""
  superseded_by: ""
  ```
  `.agents/instructions/document-governance.md:55`：「用新 ADR 取代旧 ADR，而不是改写旧 ADR」。
- 建议：如果团队认为这只是把 PR 501 已实现的行为补写成澄清，可以在交付说明和 ADR 中明确「这是补充说明，不是改变决定」；如果按严格治理执行，应新建 ADR 并在新 ADR 的 `amends` 中指向 `docs/adr/0237-...`，而不是改原决定段。
- 读代码和规则文件证实；「是否算决定变更」属推测，取决于治理技能里 ADR Supersession 的具体解释（该技能未加载，未核实内部细节）。

## 侧重检查

- 错误路径：分类跳过路径不会调用 `store.recordFailure`，符合「不落失败行」；`source.build()` 失败在 `review-prereview.ts:247-248` 被静默 `continue`，既不计数也没有退避，会每个 tick 重试。这是既有路径，不在本次文档改动范围内，但和新句子容易混淆，值得留意。
- 不可信输入：`DailyReviewSubject.dataClassification` 由 `daily-review.ts:551-558` 过滤，`null`/隐藏/空文本不会成为预评题目；模型输出由 `parsePrereview` 在 `review-prereview.ts:78-98` 校验评分和 0..1000 的把握。
- 安全：分类检查在 `review-prereview.ts:249-256` 发生在组装提示 `:257` 和 `model.prepare` `:389` 之前，不允许级别的文字不会外发。代码仍会在首次遇到时 `source.build()` 读取原文，这是本地读取，不是外发；文档说的是「不重复读取」，与代码一致。
- 资源耗尽：分类跳过不增加 `attempted`/`attempts`，不消耗 `perRun` 和每日次数；缓存按 `PREREVIEW_FAILURE_BACKOFF_MS` 清理，且题目池有上限（`DAILY_REVIEW_POOL_LIMIT = 500`，`daily-review.ts:25`）。没有新增无界资源操作。
- 不可撤销操作：无。
- 规则、说明文档和代码一致性：`perRun` 在 `strict-configuration.ts:1207,1247` 产生并校验（1..50），在 `review-prereview.ts:235` 使用；`dailyLimit` 在 `strict-configuration.ts:1205,1238` 产生并校验（1..500），在 `review-prereview.ts:184,236` 使用；`skippedClassification` 在 `review-prereview.ts:143-148,233,315` 产生，在 `service-main.ts:2159,2164` 和测试中使用，都是 number，诊断日志可接受。PR 501 在 git 历史中有合并提交 `c0cc2cc19`，仓库名与其他文档一致。
- 未核实：没有运行测试；没有联网核实 PR 501 页面内容，只核对了 git 历史中的合并提交；没有加载 `document-governance` 技能包，因此未核实技能内部 ADR Supersession 的精确流程。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次 diff 只改 ADR 文字；仓库的 `packages/`、`apps/` 中没有运行时读取 `docs/adr/` 的代码。预评请求仍是 `review-prereview.ts:64-76` 的固定目录文字加本条数据，单次请求没有历史消息，因此不涉及「只在末尾追加」。请求里没有新增每轮变化的值。

2. **不会让同一段文字在不同请求里变成不同字节。** 文档不参与序列化；现有 `prereviewPrompt` 对同一题目生成相同字节（`packages/application/test/review-prereview.unit.test.ts:25-27`），`PREREVIEW_GROUPS` 和 `prereviewOptions` 的顺序固定，请求里没有时间字段。本次改动不碰这些代码。

3. **部分有自动检查。** 行为测试在 `test/integration/review-prereview-production.test.ts:380-440`，覆盖跳过、不发送、不落失败行、不占 `perRun`、模型放开后重评；`:431` 的反向用例覆盖「允许的条目不会被跳过」。缺 24 小时过期和 `dailyLimit` 不被分类跳过消耗的直接用例，且文档改动本身没有被内容校验（外部 URL 会被链接检查跳过）。未运行测试，因此「反向用例真的会失败」只能从断言判断，未实测。

4. **逐个核对后没有发现两端不匹配。** `perRun`：`packages/platform-node/src/strict-configuration.ts:1207,1247` 产生并校验 1..50，`packages/application/src/services/review-prereview.ts:235` 使用。`dailyLimit`：`strict-configuration.ts:1205,1238` 产生并校验 1..500，`review-prereview.ts:184,236` 使用。`skippedClassification`：`review-prereview.ts:143-148,233,315` 产生，`apps/agent-service/src/service-main.ts:2159,2164` 和测试使用，类型为 number，诊断日志可接受。PR 501：git 历史中存在合并提交 `c0cc2cc19`，PR 编号与仓库名一致；URL 本身未联网核实。没有新增清单 id 或序列化格式。
