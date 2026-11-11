## 结论

这轮改动本身没有发现会改变已有对话请求开头的路径；新增的预评调用是独立后台调用，固定指令在前、本条数据在后。不过有几处“值产生端与使用端对不上”的问题：整条预评/缩减链路没有生产接线，`memory_skipped` 没有分级来源，失败成本没有进入日预算，而且存了 `textDigest` 却从不校验。DS-1 的“抽检条目算进会被藏部分一致率”按代码看不构成统计污染，作者判“不成立”基本站得住。

---

## 按严重度排列的问题

### 1. 中：整条预评/缩减链路没有生产调用点，配置和 `hiddenByModel` 实际不生效

- 严重度：中（若本 PR 声称 reduction 已交付，则为高）
- 文件:行：`apps/agent-service/src/production-proactive.ts:308`、`packages/application/src/services/review-prereview.ts:169`、`packages/application/src/services/daily-review.ts:466`
- 问题：`ReviewPrereviewService` 只被定义和导出，仓库内没有任何实例化；`readDailyReview` 的调用点没有传 `hideByModel`；`ReviewPrereviewStorePort` 也没有实现。因此 `reviewPrereview.*` 配置、`hiddenByModel`、`readDailyReviewSubjects` 都是死代码，开启 `reduction.enabled` 不会有任何效果。
- 证据（亲自读到）：
  - `production-proactive.ts:309-314`：
    ```ts
    return readDailyReview({
      ...
      readMemoryText: this.#options.readMemoryText,
      ...(this.#options.readMemory ? { readMemory: this.#options.readMemory } : {}),
    ```
    没有 `hideByModel`、没有 `readMemoryClassification`。
  - `daily-review.ts:466`：
    ```ts
    const hidden = options.hideByModel
      ? await options.hideByModel([...candidates.values()].map(({ candidate }) => candidate))
      : undefined;
    ```
  - 全仓 grep `ReviewPrereviewService` 只命中定义处；grep `listPrereviewed|listPairs` 在 `packages/platform-node` 无实现。
- 建议：要么在本 PR 中补上 service 构造、store 实现和 `hideByModel` 注入，并在集成测试里证明“启用后确实少展示”；要么在配置/文档里明确标注“尚未生效”，并让测试守住“未接线时不得宣称已启用”。

### 2. 中：失败调用不落库，日成本上限可被绕过；内存 backoff 重启即失效

- 严重度：中
- 文件:行：`packages/application/src/services/review-prereview.ts:167`、`:187`、`:217`、`:236`
- 问题：`#failedAt` 只在进程内存里；失败调用的 `costMicros` 只累加到本次 run 的局部变量，只有成功时才 `store.record`。`store.countSince` 只能统计已记录的成功条目，因此跨轮/跨进程重启后，失败调用已产生的费用不计入 `dailyCostMicros`，日预算可被反复失败绕过。作者“24 小时内不再尝试”的表述只在同一实例生命周期内成立。
- 证据：
  - `:167`：`export const PREREVIEW_FAILURE_BACKOFF_MS = DAY_MS;`
  - `:171`：`readonly #failedAt = new Map<string, number>();`（纯内存）
  - `:187`：`const spent = await store.countSince({ ...scope, since: dayStart });`
  - `:217-227`：失败分支只做 `this.#failedAt.set(...)` 和 `failures.push(...)`，没有持久化成本。
  - `:236-251`：只有成功回复才 `store.record(...)`。
- 建议：把失败尝试也记入一个可统计的尝试/成本记录（至少记录 `costMicros`），并让 `countSince` 把它算进日预算；如果要求“24 小时”跨重启成立，需要持久化失败时间，或把 key 的失败状态写入 store。

### 3. 中：`memory_skipped` 在生产没有分级来源，实际永远不会被预评

- 严重度：中
- 文件:行：`apps/agent-service/src/production-proactive.ts:127`、`:139`、`:309`；`packages/application/src/services/daily-review.ts:334`
- 问题：被丢弃记忆走 `readMemoryText` + `readMemoryClassification`，但 `ProductionProactiveOptions` 根本没有 `readMemoryClassification`，`review()` 也不传。结果 `visibleClassification([undefined])` 返回 `null`，所有 `memory_skipped` 条目都被跳过。作者说的“已存记忆按自己的分级”只覆盖 `memory_kept`/`consolidation`，没有覆盖“没存下的记忆”。
- 证据：
  - `production-proactive.ts:139-140`：
    ```ts
    readonly readMemoryText: (ref: string) => Promise<string | undefined>;
    readonly readMemory?: (memoryId: string) => Promise<DailyReviewMemoryText | undefined>;
    ```
  - `production-proactive.ts:313-314` 只传 `readMemoryText` 和 `readMemory`。
  - `daily-review.ts:334-340`：
    ```ts
    if (entry.kind === "memory_candidate" && entry.outcome === "discarded") {
      if (entry.contentRef !== null) {
        const ref = entry.contentRef;
        text = clip((await options.readMemoryText(ref).catch(() => undefined)) ?? "");
        dataClassification = visibleClassification([
          await options.readMemoryClassification?.(ref).catch(() => undefined),
        ]);
      }
    }
    ```
- 建议：在生产接线时为历史 payload 提供可信的分级来源（或在写入 ledger 时把当时的 `dataClassification` 存进条目），否则 `memory_skipped` 这一主群体的预评/一致率永远为空。

### 4. 中：`textDigest` 存了却从不校验，可能按旧文字隐藏当前条目

- 严重度：中
- 文件:行：`packages/application/src/services/review-prereview.ts:93`、`:246`、`:294`
- 问题：预评记录保存了 `textDigest`，但 `hiddenByModel` 只看 `key` 和 `group`，不比较当前条目的文字摘要。若同一 ledger 条目对应的记忆/文字后来变化，模型会基于旧文字做出的判断继续隐藏当前条目。`DailyReviewCandidate` 只有 `key` 和 `group`，连校验所需的摘要都没有。
- 证据：
  - `:246`：`textDigest: this.#options.digest(subject.text),`
  - `:294-297`：
    ```ts
    for (const candidate of reducible) {
      const record = prereviewed.get(candidate.key);
      if (record === undefined || record.group !== candidate.group) continue;
      if (prereviewAuditPicked(seed, candidate.key, reduction.auditPermille)) continue;
    ```
    没有 `record.textDigest === digest(candidate.text)`。
  - `daily-review.ts:148-151`：
    ```ts
    export interface DailyReviewCandidate {
      readonly key: string;
      readonly group: CalibrationGroup | null;
    }
    ```
- 建议：把当前文字摘要放进 `DailyReviewCandidate`，`hiddenByModel` 必须校验摘要一致才允许隐藏；或者在 key 中加入内容版本，让文字变化自然产生新 key。

### 5. 低：`hiddenByModel` 没有进入 review snapshot，隐藏条数对前端不可见

- 严重度：低
- 文件:行：`packages/application/src/services/daily-review.ts:134`、`apps/agent-service/src/production-proactive.ts:335`
- 问题：`selectDailyReview` 把隐藏条目从 `shown` 去掉，`sampled` 变成 `shown.length`，但 `hiddenByModel` 没有出现在 `proactive.review.snapshot` 的 payload 里。将来接线后，用户只会看到条数变少，既不算在 `sampled`，也不算在 `notSampled`，也没有“被模型隐藏 N 条”的解释。
- 证据：
  - `daily-review.ts:133-136`：
    ```ts
    shown: Object.freeze(shown.map(({ key }) => key)),
    hiddenByModel: taken.length - shown.length,
    sampled: shown.length,
    ```
  - `production-proactive.ts:335-342` payload 只有 `day/capacity/sampled/notSampled/items/folded/generatedAt`。
- 建议：把 `hiddenByModel` 加入 snapshot 和前端类型/文案，或明确产品上不展示但记录诊断日志。

### 6. 低：`#invoke` 的 `finally` 释放顺序可能泄漏 payload，并让成本统计失真

- 严重度：低
- 文件:行：`packages/application/src/services/review-prereview.ts:368`
- 问题：`authority.release()` 抛错时，后面的 `model.release(outputs)` 不会执行，已产生的输出 payload 不会释放；同时外层新加的 `.catch` 会吞掉该异常并把 `costMicros` 记为 0。
- 证据：
  - `:368-370`：
    ```ts
    } finally {
      await authority.release();
      await model.release(outputs).catch(() => undefined);
    }
    ```
  - `:217-222` catch 分支返回 `costMicros: 0`。
- 建议：把两个 release 分别包在自己的 `try/catch` 里，保证输出释放总执行；成本统计与释放错误解耦。

### 7. 低：预评候选一次性构建全部文字，未先按 `perRun` 截断

- 严重度：低
- 文件:行：`packages/application/src/services/daily-review.ts:429`、`packages/application/src/services/review-prereview.ts:188`、`:210`
- 问题：`run()` 先 `await this.#options.subjects()` 构建所有候选（最多 500 条 ledger + audit），对每条可见记忆解密/读取文字，之后才 `pending.slice(0, settings.perRun)`。这会造成不必要的解密和内存占用，且每个 tick 都可能重复做。
- 证据：
  - `:188`：`const subjects = await this.#options.subjects();`
  - `:210`：`for (const subject of pending.slice(0, settings.perRun)) {`
  - `daily-review.ts:434-446` 对每个候选执行 `await build()`。
- 建议：先按 ledger 元数据排序/过滤，再只为将要预评的少量条目读取文字；或增加缓存/上限。

### 8. 低：异常隔离只覆盖模型调用，store 异常仍会中断整轮

- 严重度：低
- 文件:行：`packages/application/src/services/review-prereview.ts:230`、`:236`
- 问题：作者说“单条抛错不中断整轮”，但 `.catch` 只包住 `#invoke`。`store.ownerHistory`、`store.record` 单条失败会直接 reject 整个 `run()`，后续条目不再处理。
- 证据：
  - `:230`：`const history = await store.ownerHistory({...})`（无 try/catch）
  - `:236`：`await store.record({...})`（无 try/catch）
- 建议：对单条 `ownerHistory`/`record` 也做隔离并记录失败；如果 store 失败应中止整轮，就在注释/返回类型里明确，别声称“单条抛错不中断整轮”。

---

## 侧重检查

- 错误路径：模型调用异常、`prepare` 异常已被 `.catch` 隔离；但 store 写入/历史读取、`authority.release()` 仍有中断或泄漏路径（见 6、8）。`subjects()` 本身也可能因 ledger/overview 失败整体 reject。
- 不合规范或不可信的输入：模型输出只接受合法 `rating` 和 0–1000 整数 `confidence`，输出总字节有 4096 上限；提示词明确把条目文字标为不可信数据，降低提示注入影响。`parsePrereview` 用首尾大括号截取，模型在 JSON 后追加 `}` 会解析失败并进入 24h 退避，属于可接受的保守失败。
- 安全与隐私：`prereviewPrompt` 只取 `group/options/category/text`，不把 `ownerRating` 发给模型（有反向测试）；文字先 `clip` 再 `maskSensitiveText`。`prepare` 携带条目的 `dataClassification`，生产模型组合会再次检查 `allowedDataClassifications`。`readDailyReviewSubjects` 只对 main groups 构建，不会读 `memory_pending` 等非预评组。
- 资源耗尽：有 `perRun`、`dailyLimit`、`dailyCostMicros`、`requestTimeoutMs`、输出 4096 字节上限；但失败成本不入账、候选全量解密（见 2、7）。
- 不可撤销操作：本改动没有删除或覆盖记忆；隐藏只影响每日回顾展示，配置可回退。但隐藏后用户看不到条目，也没有撤销入口/隐藏计数（见 5），建议接线前补上。
- 规则/文档/代码一致：新增后台提示词符合 `prompt-prefix` 的“固定在前、会变数据在后”（第 15 条）；未见往历史中间插入内容。新增 `reviewPrereview` 配置没有 docs/ADR 说明，`prompt-manifest.json` 的新 sha 本次无法运行校验命令，标记未核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- 已有主对话：没有代码路径改动系统提示、工具定义、历史消息或遮盖结果；`service-main` 的 `readMemory` 只是多返回一个 `dataClassification`，而 `readDailyReview` 目前不使用它，且每日回顾数据不进模型对话。因此已有请求开头不受影响。
- 新增预评调用：是独立后台调用，`REVIEW_PREREVIEW.text` 固定在前，本条 `group/options/category/text` JSON 追加在最后；没有历史拼接，没有“在中间插入”。每个会变的值都在唯一一条用户消息末尾的数据块里。符合 `.claude/rules/prompt-prefix.md` 第 15 条的后台调用要求。
- 注意：如果后续把预评结果或隐藏结果插入主对话历史，就会违反只追加规则；当前代码没有这种插入。

### 2. 同一段文字会不会在不同请求里变成不同字节？

- 读代码看不会：`prereviewPrompt` 用固定顺序的对象字面量做 `JSON.stringify`，`prereviewOptions` 来自固定常量数组，提示词里没有时间、随机数、路径或哈希字段；`maskSensitiveText` 是纯函数，只依赖输入文字。
- `prereviewAuditPicked`/`reviewHash` 也是确定的，虽然不进入模型提示。
- 唯一会让字节变化的是条目文字本身或提示词目录文字被修改；这是内容变化，不是序列化不确定性。

### 3. 有没有对应自动检查？反向用例真的会失败吗？

- 有覆盖：`packages/application/test/review-prereview.unit.test.ts` 覆盖固定前缀、同输入同字节、不泄漏 `ownerRating`、卡号遮盖、非法输出拒绝、抽检确定性；`daily-review.unit.test.ts:466-634` 覆盖隐藏不补位、已评分不隐藏、受限/无分级跳过、已存记忆使用自身分级、提醒类无文字；`packages/calibration/test/prereview.unit.test.ts` 覆盖门槛和一致率。
- 现有反向用例大多确实会失败：例如把已评分条目也隐藏、把 restricted 条目纳入、把 `ownerRating` 写进提示，都会让对应断言失败。
- 关键缺口：本轮新增的 `run()` 退避、`AbortSignal.timeout`、单条失败继续、失败成本记账都没有测试；`service-main` 给 `readMemory` 加 `dataClassification` 也没有测试（`readDailyReview` 忽略该字段，删掉它现有测试仍全绿）。因此这些改动目前没有自动检查兜底。

### 4. 每个产生/修改的值，使用端都能接受吗？

逐项核对：

- `hiddenAgreementPermille`：产生于默认值、`strict-configuration` 解析和测试；使用于 `review-prereview.ts:277` 映射到校准库的 `agreementPermille`。两端类型/范围一致（配置 500–1000，校准门槛接受 number），旧键 `agreementPermille` 已无外部引用；这一项正确。
- `dataClassification`（`DailyReviewMemoryText`）：`service-main:1603` 产生的是经过 `reviewMemoryVisible` 校验的 `ProductDataClassification`，与 `DataClassification` 是同一字符串联合；`visibleClassification` 能接受。但 `memory_skipped` 的 `readMemoryClassification` 在生产没有产生端，导致该组永远跳过（见问题 3）。
- `DailyReview.hiddenByModel`：`selectDailyReview` 产生，`readDailyReview` 透传，但 gateway snapshot 和前端都没有使用/展示（见问题 5）。
- `PrereviewRecord.textDigest`：`run()` 产生并存储，`hiddenByModel` 使用记录时却不校验它（见问题 4），这是两端校验不一致。
- `PrereviewRecord.dataClassification`、`PrereviewRecord.costMicros`、`ReviewPrereviewStorePort` 全部没有生产实现，当前只有类型层使用。
- `reviewPrereview` 配置本身被完整解析和校验，但没有生产消费者，属于“配置接受了、没人用”（见问题 1）。

---

## DS-1：抽检条目算进会被藏部分的一致率，这个理由是否成立？

按代码看，作者判“不成立”基本站得住。

- 一致率里 `hidden` 的样本来自 `rated` 中满足 `wouldHide` 的 pair（`packages/calibration/src/prereview.ts:180-186`）。
- 一旦 gate 打开，`wouldHide` 条目默认不展示，用户无法评分；只有被 `prereviewAuditPicked` 抽中的条目才会展示并可被评分（`review-prereview.ts:297-308`）。
- 因此“会被藏的部分”能拿到主人评价的，本来就只能是抽检样本（以及 gate 打开前已展示的历史样本）。抽检用 `reviewHash(seed|key) % 1000` 均匀抽取，不依赖模型评分，作为该总体的估计是合理的。若把抽检条目排除，反而没有任何样本可用来衡量隐藏部分的一致率。
- 所以 DS-1 若主张“抽检条目计入导致一致率被污染”，前提不成立；作者判“不成立”有代码依据。
- 但有一个相关风险值得单独记录：`auditPermille` 允许低到 1，且 gate 只看累计窗口样本；gate 打开后新增审计样本会很少，模型质量下降可能长时间无法被 gate 发现。这不是 DS-1 的“抽检污染”问题，而是低抽检率下的监控滞后问题。

---

## 未核实

- `.agents/reviews/pr-373/judgments.md` 和第 1 轮复核原文受 records-path 保护，`git show` 被拒绝，工作区也读不到；因此无法逐字核对 DS-1 的原始表述，以上是按“抽检条目被算进隐藏部分一致率”这一层意思从代码反推。
- 未运行测试、lint、typecheck 和 `prompt-manifest.json` 的 sha 校验；本次只能做静态阅读。
- `prompt-manifest.json` 中 `review.prereview` 的 sha256 是否与新增文字一致，未核实。
