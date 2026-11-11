# PR 381 第 6 轮复核

下面先给按严重度排列的发现，再单列「侧重检查」，最后逐条回答必答问题。每条都标注是【读代码证实】还是【推测/推理】。

## 发现（按严重度从高到低）

### 中-1　把“暂时性/全局性”嵌入失败也当成单条坏摘要，退避 1 小时起、最长 24 小时
**文件:行** `packages/memory-engine/src/episodes.ts:379-397`

**问题**：`catch (error)` 捕获的是 `embedDocument` 的**所有**异常，不区分错误种类。生产上接入的 `within` 会把 `EMBEDDING_DEADLINE_EXCEEDED`、`EMBEDDING_LOCAL_NOT_READY`、`EMBEDDING_LOCAL_QUEUE_FULL`、租约/预算/准入错误都从这里拒掉（`production-run-memory.ts:153-184`、`259-305`；`local-onnx-embedding.ts:279-282`、`312-313`）。这些错误被记成“这条摘要算不出来”，于是这条摘要要等 `1h,2h,4h…24h` 才再试。本机模型短暂不可用/队列满/请求超时一次，就会让被扫到的条目在恢复后仍被压住一小时以上。

**证据（亲自读到）**：
```ts
// episodes.ts:383-395
} catch (error) {
  failure ??= { error };
  failed += 1;
  const failures = (retry?.failures ?? 0) + 1;
  this.#embeddingRetries.set(key, {
    failures,
    notBefore:
      Date.parse(this.#options.now()) +
      Math.min(FIRST_EMBEDDING_RETRY_MS * 2 ** (failures - 1),
               LONGEST_EMBEDDING_RETRY_MS),
  });
```
ADR 里的口径是“某一条算不出来（例如超长）”，见 `docs/adr/0224-memory-embedding-runs-on-the-host.md:57`，但代码没有把“超长/输入非法”与“模型暂时没就绪/超时/队列满”分开。

**建议**：按错误码分类。只对确属单条内容问题的错误（例如 `EMBEDDING_LOCAL_INPUT_LENGTH`、长度/维度不符）写长期退避；对 `NOT_READY`、`QUEUE_FULL`、`DEADLINE_EXCEEDED`、`NOT_AUTHORITATIVE`、`EMBEDDING_*_CONFLICT` 等暂时/全局错误直接抛出、不写退避，或在模型恢复 ready 时清空这些退避记录。

---

### 中-2　连续“新失败”条目仍会挡住后面的好条目；全量补算可能被指数退避拖很久
**文件:行** `packages/memory-engine/src/episodes.ts:396`、`416`；`apps/agent-service/src/service-main.ts:1552-1568`；`apps/agent-service/src/local-vector-catch-up.ts:29-35`

**问题**：一次补算试到第 3 个失败就 `break pages` 并抛错；下一次全量补算仍从页首开始，跳过已进入等待的 3 条后，再试接下来的 3 条坏条目，然后又抛错。`local-vector-catch-up` 对这个抛错按 1 分钟、2 分钟、4 分钟……最长 1 小时退避。于是如果前面有 N 条连续坏条目，全量补算要经过约 N/3 轮、且轮间隔逐渐涨到 1 小时，后面的好条目才能被扫到。ADR 第 57 行“坏条目再多也挡不住后面的好条目”只在“坏条目已经进入等待”时成立；对一轮里新遇到的连续坏条目并不成立。

**证据（亲自读到）**：
```ts
// episodes.ts:396-397, 414-416
if (failed >= FAILED_EMBEDDINGS_PER_BACKFILL) break pages;
...
if (episodes.length < pageSize) break;
...
if (failure && embedded === 0) throw failure.error;
```
```ts
// service-main.ts:1552-1568
for (;;) {
  const embedded = await memoryEpisodes.backfillEmbeddings({ ... limit: 100 ... });
  if (embedded === 0) break;
}
```
```ts
// local-vector-catch-up.ts:29-35
const retryInMs = Math.min(FIRST_RETRY_MS * 2 ** failures, LONGEST_RETRY_MS);
...
schedule(() => { state = "waiting"; start(); }, retryInMs);
```

**严重度说明（推测）**：上面“N/3 轮、每轮最长 1 小时”的耗时是按代码行为推导出来的，未实际构造 N 很大的数据运行。单次 `backfillEmbeddings` 的 `embedded===0` 抛错和退避逻辑是读代码证实的。

**建议**：把“每轮最多试 3 条”与“是否继续翻页”解耦。例如达到 3 条失败预算后，把刚失败的 3 条视作已等待，继续往后翻页只为寻找可成功的好条目；只有整轮一条都没补上且还有未检查的页时才抛错，或对“还有未检查页”不触发 `local-vector-catch-up` 的指数退避。也可以直接把等待集合做成可跳过区间/定时器队列，避免每轮从页首重扫。

---

### 中-3　`#embeddingRetries` 没有淘汰机制，长驻进程里会持续增长
**文件:行** `packages/memory-engine/src/episodes.ts:114-117`、`386-395`、`407`

**问题**：只有嵌入成功才 `delete`。以下记录会永久留在 Map 里：
- 永远失败的条目（例如模型对某类输入稳定报错）；
- 已被删除/重建但 id 相同的旧条目（id 由线程和 sequence 派生，重复 `summarize` 会复用 id）；
- 切换嵌入模型/规则集后旧 `position` 下的全部记录。

ADR 只写了“记在服务内存里，重启后清空”，但没限制单进程生命周期内的增长。对长时间运行的个人助理服务，这属于无界的资源占用。

**证据（亲自读到）**：
```ts
// episodes.ts:114-118
readonly #embeddingRetries = new Map<string, { notBefore: number; failures: number }>();
readonly #embeddingsInFlight = new Set<string>();
```
```ts
// episodes.ts:407
this.#embeddingRetries.delete(key);   // 只有成功路径删除
```

**建议**：给 Map 设上限或 TTL；切换嵌入身份时清空/重建；在完整补算结束时清掉本轮未再遇到的键；或在 `memory reindex`/模型切换时清空。

---

### 低-4　“在等”用墙钟判断，时钟回拨会把等待时间拉长
**文件:行** `packages/memory-engine/src/episodes.ts:369`、`389-394`

**问题**：`notBefore = Date.parse(now()) + delay`，之后用 `retry.notBefore > Date.parse(now())` 判断。NTP 校正导致时钟回拨时，`notBefore` 相对新的 `now()` 会更远，等待时间被拉长（最多拉长约等于回拨量）；若 `now()` 返回不可解析的值，`Date.parse` 得到 `NaN`，比较恒为 false，退避直接失效。

**证据（亲自读到）**：
```ts
// episodes.ts:369
if (retry && retry.notBefore > Date.parse(this.#options.now())) continue;
// episodes.ts:389-394
notBefore: Date.parse(this.#options.now()) + Math.min(...)
```

**建议**：退避状态改用定时器或单调时钟（`performance.now()` 一类），或者在读取 `now()` 时对 `NaN`/回拨做保护（例如把 `notBefore` 限制在“当前时间 + 上限”内）。

---

### 低-5　`readText` / `attachEmbedding` 的失败没有被“跳过坏条目”覆盖，仍会卡住整轮补算
**文件:行** `packages/memory-engine/src/episodes.ts:371-377`、`399-406`

**问题**：内层 `try/catch` 只包住 `embedDocument`。`readText` 抛错、`attachEmbedding` 抛错都会直接冲出 `backfillEmbeddings`，不前移 `after`、不记退避。只要最早的一条载荷读不出或写入持续失败，每次补算都会停在同一处，后面的好条目永远轮不到（全量补算和每轮前的 `backfillEmbeddings` 都一样）。这跟 ADR “某一条算不出来就跳过它、接着往后翻页”的宽泛表述不一致。该行为在旧代码里也存在，不是本轮新引入，但本轮新的“等待”机制没有覆盖它。

**证据（亲自读到）**：
```ts
// episodes.ts:372-377
const text = await this.#options.readText({ ... });
if (!text) continue;
let vector: Float32Array;
try {
  vector = await (input.within ?? ...)(episode, () => embedder.embedDocument(...));
} catch (error) { ... }
// episodes.ts:399-406
await this.#options.store.attachEmbedding({ ... });
```

**建议**：把 `readText` 和 `attachEmbedding` 也纳入单条失败分类（至少记录并 `continue`），或在读失败时仍然推进 `after` 以便扫到后面的好条目。若决定维持现状，应把 ADR 的表述收窄为“嵌入失败才跳过”。

---

### 低-6　ADR 与代码对“等待条目何时再试”的描述不一致
**文件:行** `docs/adr/0224-memory-embedding-runs-on-the-host.md:57`；`apps/agent-service/src/production-memory-episodes.ts:76-89`

**问题**：ADR 说等待条目“由每轮结束时的补算再试”。实际代码是在每个运行开始时先调用 `backfillEmbeddings({limit:1})`，再 `dueSegments`/`summarize`；没有独立定时器。如果服务长时间没有新运行，等待条目直到下一次运行或进程重启才会再试。文字和代码不一致，也影响对“最长 24 小时的退避是否真的会按时间触发”的理解。

**证据（亲自读到）**：
```ts
// production-memory-episodes.ts:77-89
await this.#options.service.backfillEmbeddings({ ... limit: 1 ... }).catch(...);
const segments = await this.#options.service.dueSegments({ ... });
```
```ts
// ADR 0224:57
...那些条目到时间后由每轮结束时的补算再试。
```

**建议**：改 ADR 为“下一次运行开始时”；或者如果确实希望按时间自动重试，给等待条目加定时器/调度，而不是依赖用户产生新运行。

---

### 低-7　`after` 已加入 port 和 SQL，但 worker 分发的内联类型没有同步，且后端完全不校验 `after`
**文件:行** `packages/persistence-sqlite/src/sqlite-memory-operations.ts:457-466`、`1483-1513`；`packages/application/src/ports/memory-episodes.ts:57-64`

**问题**：`listUnembedded` 的私有方法和 port 都加了 `after?: {createdAt,id}`，但 `case "memoryEpisode.listUnembedded"` 里的 `payload as {...}` 类型没写 `after`。目前只是类型断言，运行时 `after` 仍会传到私有方法，所以不是现网 bug；但这是“产生值的一端加了字段、分发端点没同步”的隐患。另外 SQL 端只校验 `limit`，完全没校验 `after.createdAt`/`after.id`，与相邻方法的严格校验风格不一致。

**证据（亲自读到）**：
```ts
// sqlite-memory-operations.ts:457-466
case "memoryEpisode.listUnembedded":
  return this.listUnembedded(
    payload as { ownerId: OwnerId; agentId: AgentId; model: string; dimensions: number; limit: number; },
  );
```
```ts
// sqlite-memory-operations.ts:1491-1503
if (!Number.isSafeInteger(input.limit) ...) this.fail(...);
... AND (@afterCreatedAt IS NULL OR (e.created_at, e.id) > (@afterCreatedAt, @afterId))
```

**建议**：把 `after` 补进分发处的内部类型；给 `after` 加时间格式/非空字符串校验，避免将来别处传入畸形游标时静默得到错误结果。

---

### 低-8　测试覆盖缺了本轮重点关心的几类路径
**文件:行** `packages/memory-engine/test/episode-backfill.unit.test.ts:73-144`；`test/integration/memory-episodes.test.ts:370-407`

**问题**：现有测试覆盖了“等待/退避/3 条失败预算”和 `after` 游标，但没有覆盖：
- 时钟回拨（`now()` 变小）；
- `#embeddingRetries` 增长/清理；
- 全局性错误（`NOT_READY`/`QUEUE_FULL`/`DEADLINE_EXCEEDED`）是否应长期退避；
- `readText`/`attachEmbedding` 抛错时后面的好条目是否还能被处理；
- 全量补算在只剩等待条目时确实结束（目前只在单测 mock 里覆盖，没有真实 SQLite 的端到端用例）；
- 两条 `createdAt` 完全相同的摘要的 SQL id 兜底：集成测试里两条摘要的创建时间相差 1 分钟（`memory-episodes.test.ts:380-383`），只通过伪造 `after.id` 的 `""`/`"\uffff"` 间接测了 id 分支。

**建议**：补一条真实 SQLite 的“同 createdAt、不同 id”用例；补时钟回拨和全局错误不写长期退避的用例；补“只剩等待条目时全量补算返回 0 且能结束”的端到端用例。

---

## 侧重检查

- **错误路径/暂时性失败**：发现中-1、低-5。嵌入失败被一律当成单条内容问题；`readText`/`attachEmbedding` 未被单条隔离。
- **不可信/不规范输入**：`after` 游标来自数据库自身（`MemoryEpisode.createdAt/id`），生产端格式有效；但 SQL 端不校验 `after`（低-7）。模型文件校验我另行读了 `local-onnx-embedding.ts:63-135`：目录/文件逐层 `lstat`、拒绝符号链接，manifest 文件名白名单、逐文件 sha256、manifest 自身 sha256 与 `artifactSha256` 对照，模型名和哈希有正则限制；与 ADR 的“逐个核对哈希、拒绝符号链接”一致。
- **安全**：本轮没有新增外部输入进入提示或 SQL 拼接（`after` 是参数绑定）。记忆内容仍走既有出口遮盖；本轮变化不绕过遮盖。
- **资源耗尽**：发现中-2（连续坏条目拖慢全量补算）和中-3（`#embeddingRetries` 无淘汰）；另外“每次从头翻页”在大量等待条目前置时会让每次请求的 `backfillEmbeddings({limit:1})` 多扫很多页（读代码可见，未跑基准）。
- **不可撤销操作**：本轮没有删除/覆盖用户数据的不可撤销操作；`attachEmbedding` 只写向量列，`memory reindex` 不在本轮改动。
- **规则/文档与代码一致性**：发现低-6；另外 `docs/agent-rulebook-inventory.md:184` 已改成“缺省取嵌入档案门槛”，与 `service-main.ts:1720-1722` 一致；合并冲突处的 `memoryMinimumSimilarity` 可选、`artifactSha256` 可选/本机必填，与 `strict-configuration.ts`、`production-memory-composition.ts` 两端一致。
- **`local-vector-catch-up` 的诊断写入**：`apps/agent-service/src/local-vector-catch-up.ts:32-40` 确实先 `schedule` 再 `failed`，并 `try/catch` 吞掉诊断异常；行为符合作者说法。代价是诊断写入失败被静默吞掉，原始错误可能完全丢失（低风险，未单列）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加、每轮会变的值都在最后一条消息？**
不会。【读代码证实】本轮改动只碰嵌入补算和 catch-up；`packages/prompt-catalog` 的唯一变化是 `layer: "embedding"` 的查询/文档前缀，`usedBy` 只指向 `packages/application/src/embedding-profiles.ts`，不进入生成请求。没有改系统提示、工具定义、历史或遮盖。按 `.claude/rules/prompt-prefix.md:27-29` 的顺序，本轮涉及的检索结果变化只可能影响最后一条用户消息的内容，不影响请求开头。注：我没有逐行重读记忆注入组装点（这一部分未核实），但本次 diff 没有改它。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会由本轮改动造成。【读代码证实】嵌入输入是 `${episode.day}\n${text}` 加上档案固定前缀（`episodes.ts:381`；`embedding-profiles.ts:embeddingDocumentText`），不包含时间、随机数或数据库返回顺序。`now()` 只控制“是否跳过该条”，不进入任何文本/嵌入输入。`embeddingIdentityFor` 的输入（profile 数组、dimensions、artifactSha256、规则集版本）也是固定顺序。唯一不确定的是 ONNX 运行时本身是否数值确定，但那不是文本字节问题（推测/未核实）。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有。【读代码证实】`episode-backfill.unit.test.ts:73-144` 覆盖等待、翻倍退避、每次 3 条失败预算；`local-vector-catch-up.unit.test.ts:5-46` 覆盖 `failed` 抛错后仍按 60s/120s 重试；`test/integration/memory-episodes.test.ts:370-407` 覆盖真实 SQLite 的 `after` 游标。
反向用例：【推理，未实际运行】旧 `episodes.ts` 在新单测第 132-133 行会失败（旧代码带“记住位置 + 回绕”时会把 `i-fine` 的 1 次成功算进整轮的 `embedded`，返回 1 而不是 0）；旧的 catch-up 因在 `schedule` 前调用会抛错的 `failed`，会少排一次重试并产生未处理拒绝；SQL 只按 id 比较会在 `id:"\uffff"` 用例失败，只按 createdAt 比较会在 `id:""` 用例失败。
缺口见低-8：同 `createdAt` 的 SQL 兜底、时钟回拨、Map 增长、全局错误退避、`readText`/`attachEmbedding` 失败、全量补算只剩等待条目时的真实端到端，都没有自动检查。

**4. 改动产生/修改的每个值，所有使用它的地方都能接受吗？两端校验核对了吗？**
- `after`：产生于 `episodes.ts:364`（`episode.createdAt/id`，数据库值）；使用于 port `memory-episodes.ts:62` 和 SQL `sqlite-memory-operations.ts:1502`。SQL 端接受这个形状，且用行值比较 `(created_at,id) > (afterCreatedAt,afterId)`；但 SQL 端不校验 `after`，分发处的内联类型也没写 `after`（低-7）。worker 与 direct 两条路径由 `sqlite-contract-execution.fixture.ts` 覆盖，现有测试会经过真实 worker 传输。
- 退避键 `${position}\u0000${episode.id}`、`notBefore`、`failures`：只在 `episodes.ts` 内部产生和使用，没有外部校验面。
- `memoryMinimumSimilarity` 改为可选：生产于 `strict-configuration.ts:1122-1128`（缺省省略）；使用于 `service-main.ts:1720-1722`（`?? profile.proactiveMinimumSimilarity`）和规则清单文档，两端接受。`production-memory-composition.ts:138-139` 的聊天门槛同理。
- `artifactSha256` 可选：生产于 `strict-configuration.ts:365-389`（本机必填、网关禁止）；使用于 `embeddingIdentityFor`（`?? null`）和 `production-memory-composition.ts:92-99`（本机必须存在才构造运行时），两端一致。
- 新增的嵌入提示词清单项（`memory.embedding-query/document.*`）：清单已登记，`usedBy` 指向 `embedding-profiles.ts`；我没有重新计算清单里的 sha256 是否与实际模板文字一致（未核实），但这属于现有清单检查脚本的职责，建议以 `npm run check` 的清单检查为准。
