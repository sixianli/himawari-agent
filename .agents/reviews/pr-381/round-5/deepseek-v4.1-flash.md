## 读代码证实的问题（按严重度）

### 1. 中：连续 3 条算不出来就中止整次翻页，后面的好条目要等重试（并被文档说成“挡不住”）
- 文件:行：`packages/memory-engine/src/episodes.ts:372-376`、`packages/memory-engine/src/episodes.ts:397`、`apps/agent-service/src/service-main.ts:1548-1549`
- 问题：`failed` 到 3 就把整个 `pages` 循环 `break` 掉，即使同一页后面紧跟着能算的好条目也不再尝试；若本次 `embedded === 0` 还会抛错。启动补算因此失败并进入 1 分钟起、最长 1 小时的重试，紧挨着坏条目的好条目要等下一轮才可能被嵌入。
- 证据：
  ```ts
  } catch (error) {
    failure ??= { error };
    failed += 1;
    if (failed >= FAILED_EMBEDDINGS_PER_BACKFILL) break pages;
    continue;
  }
  ...
  if (failure && embedded === 0) throw failure.error;
  ```
  以及 `service-main.ts`：
  ```ts
  const embedded = await memoryEpisodes.backfillEmbeddings({ ... limit: 100 ... });
  if (embedded === 0) break;
  ```
- 文档不一致：`docs/adr/0224-memory-embedding-runs-on-the-host.md:57` 写“所以坏条目再多也挡不住后面的好条目；每次最多试 3 条算不出来的”。实际上 3 条坏条目就会让这次调用停下，后面的好条目至少延迟一次重试。
- 建议：达到 3 次失败后不要中止扫描，只停止再调用嵌入、继续推进游标把后面的条目翻完；或让 `backfillEmbeddings` 返回“是否还有未扫到的候选/是否仅剩坏条目”，让补算能区分“没活干了”和“这次预算用完”，避免无谓退避。

### 2. 中：永久坏条目会让全量补算永远失败、无限重试，文档说“直到补完”不成立
- 文件:行：`packages/memory-engine/src/episodes.ts:397`、`apps/agent-service/src/local-vector-catch-up.ts:28-36`、`apps/agent-service/src/service-main.ts:1551-1559`
- 问题：只要库里长期存在 3 条以上永远算不出来的条目，每次全量补算最终都会走到“只有坏条目”的一页，`embedded === 0` 就抛错；`createLocalVectorCatchUp` 于是永远重试，永远到不了 `state = "done"`。这会持续做 DB 扫描/嵌入尝试并周期性写 `memory.embedding_catch_up_failed`。
- 证据：
  ```ts
  if (failure && embedded === 0) throw failure.error;
  ```
  ```ts
  state = "retrying";
  input.failed(error, retryInMs);
  schedule(() => { state = "waiting"; start(); }, retryInMs);
  ```
  ADR 原文：“本机模型第一次就绪后的全量补算失败时，按 1 分钟起、每次加倍、最长 1 小时的间隔重试，直到补完。”
- 建议：把“某条永久算不出来”和“整体不可用/暂时失败”区分开（例如记录每条失败次数、超过阈值就固化跳过，或返回“只剩已知坏条目”状态让补算正常完成）；如果要保留无限重试，文档要明确说明永不完成的条件和运维含义。

### 3. 中：诊断回调抛异常会直接吃掉重试，甚至造成未处理 Promise 拒绝
- 文件:行：`apps/agent-service/src/local-vector-catch-up.ts:28-37`
- 问题：失败分支先调用 `input.failed(...)`，再`schedule(...)`。`failed` 抛异常时，后半段不会执行，重试定时器永远不建立；该异常发生在 `.then` 的拒绝处理器里，还会形成未处理的 Promise 拒绝。生产传的是 `writeServiceDiagnostic`（内部有 `output.write`），本轮又在 `production-run-memory.ts` 专门加了 try/catch 的 `diagnose`，说明日志出口确实可能抛。
- 证据：
  ```ts
  state = "retrying";
  input.failed(error, retryInMs);
  schedule(() => {
    state = "waiting";
    start();
  }, retryInMs);
  ```
  对比同一提交里的防护：
  ```ts
  const diagnose = (event: Readonly<Record<string, string>>) => {
    try {
      options.diagnostic?.(event);
    } catch {
      return;
    }
  };
  ```
- 建议：把 `input.failed(...)` 包在 try/catch 里（或用与 `diagnose` 相同的封装），并先保证 `schedule` 一定执行；加一条 `failed` 抛异常时仍能重试的测试。

### 4. 低：同一次调用里，绕回后可能把同一条坏条目再试一次
- 文件:行：`packages/memory-engine/src/episodes.ts:344-345`、`packages/memory-engine/src/episodes.ts:358-359`、`packages/memory-engine/src/episodes.ts:389-393`
- 问题：从记住的游标开始翻到底会绕回开头；绕回后没有排除本轮已经试过的 id。某条坏条目若位于原游标之后，第一遍试过一次，绕回后第二遍可能再次试到，消耗 3 次失败预算，和“每次最多试 3 条算不出来的”按“条”理解不一致。
- 证据：
  ```ts
  let after = this.#backfillResumesAfter.get(position);
  let wrapped = after === undefined;
  ...
  after = { createdAt: episode.createdAt, id: episode.id };
  ...
  if (episodes.length < pageSize) {
    after = undefined;
    if (wrapped) break;
    wrapped = true;
  }
  ```
  例：游标在 `good1` 之后，剩余 `[badB, good2]`，第一遍 `badB` 失败、`good2` 成功，到底绕回，第二遍会再次尝试 `badB`。
- 建议：本轮维护一个已尝试失败 id 集合，绕回时跳过；或绕回只扫描原游标之前的区间。

### 5. 低：新增游标是可变共享状态，全量补算和每轮补算可能并发互相覆盖
- 文件:行：`packages/memory-engine/src/episodes.ts:112`、`packages/memory-engine/src/episodes.ts:344-345`、`packages/memory-engine/src/episodes.ts:395-396`、`apps/agent-service/src/production-memory-episodes.ts:77-88`
- 问题：`#backfillResumesAfter` 是同一 `MemoryEpisodeService` 实例上的 Map。启动时 `service-main.ts:1533` 用 `limit: 100` 做全量补算，而每次运行 `ProductionMemoryEpisodes` 又用同一个 service 调 `limit: 1`（`service-main.ts:2071-2074` 传入同一个 `memoryEpisodes`）。两者可重叠：各自开头读取同一个游标，结束时后完成者覆盖先完成者，游标可能回退，造成重复扫描和重复试坏条目。不会永久漏条目（游标只会写到本次真正看过的位置），但会放大坏条目的重试和资源消耗。
- 证据：
  ```ts
  readonly #backfillResumesAfter = new Map<string, { createdAt: string; id: string }>();
  ...
  let after = this.#backfillResumesAfter.get(position);
  ...
  if (after) this.#backfillResumesAfter.set(position, after);
  else this.#backfillResumesAfter.delete(position);
  ```
  没有互斥或“本次起始游标”版本校验。
- 建议：按 `position` 串行化 `backfillEmbeddings`，或把游标交给调用方持有/返回；至少加版本比较，只有本次基于的起始游标仍是最新时才写回。

### 6. 低：`after` 的 SQL 反向用例覆盖不足
- 文件:行：`test/integration/memory-episodes.test.ts:389-404`
- 问题：新集成测试只有一条 pending 记录，验证 `after` 相同 id 返回空、id 为 `""` 返回该条。这只能证明 `>` 和 `id` 参与比较；如果把条件误写成只比较 `id`（忽略 `created_at`），这些断言仍会通过。没有多行、不同 `created_at`、同一时间并列 id 的分页用例。
- 证据：
  ```ts
  const [pending] = await ...listUnembedded(unembedded);
  ...
  after: { createdAt: pending.createdAt, id: pending.id }
  ...
  after: { createdAt: pending.createdAt, id: "" }
  ```
- 建议：增加两条以上不同 `created_at` 的 episode，断言从第一条的游标之后只返回后一条、且顺序与不用 `after` 时的 `ORDER BY created_at, id` 一致；再加一条“只按 id 比较会失败”的用例。

## 推测 / 未核实

- 我没有运行测试（工具限制只有只读 git 与读文件），第 3 题中“反向用例是否会失败”只能按代码推断。
- `.agents` 复核记录在稀疏检出的工作区里不存在，`git show` 也被环境拒绝，所以上一轮 `round-4/judgments.md` 未读到，只能按作者摘要核对。
- 本轮增量之外的本机模型产物校验（`local-onnx-embedding.ts` / `build-artifact.py`）没有重新审计，标为未核实。
- 服务关闭时 `LocalOnnxEmbeddingRuntime.close()` 会触发 `observe(false)`（`local-onnx-embedding.ts:328-352`）。当前补算进行中的 `run` 不在 `runs.memoryEpisodes.stop()` 的等待范围；关闭后若该次 `run` 失败，还会排一个 60 秒起的 `unref` 定时器，下一次触发时因 `ready=false` 不再运行。结论：不会在关闭后无限跑，但会留下一次延迟定时器，并可能在关闭过程中继续写诊断/继续访问已关闭资源——这是“错路径”上的现实风险，但没看到永久泄漏。

## 侧重检查

- 错误路径：诊断出口抛异常（问题 3）；关闭/模型不可用（上一节）；永久坏条目导致无限重试（问题 2）。
- 不合规范/不可信输入：`make-packet.py:273-299` 的新校验确实更稳。`10 ** 400` 走 `float()` 抛 `OverflowError` 被捕获；分类列表先做 `all(isinstance(value, str))` 再做 `set()`，嵌套 list 不会再以 `TypeError` 崩掉。反向用例已加入 `test_make_packet.py:578-589`。
- 安全：`after` 通过绑定参数进入 SQL（`sqlite-memory-operations.ts:1495-1513`），没有字符串拼接，不存在注入面；`after` 只在内部调用链使用。
- 资源耗尽：`#backfillResumesAfter` 的键包含固定 owner/agent，服务实例是单 owner/agent，Map 规模有界；单页上限 100；主要资源风险是问题 2 的永久重试和问题 1 的反复退避。
- 不可撤销操作：本增量没有删除/覆盖类不可逆操作，只有 `attachEmbedding` 覆写向量和游标 Map 更新。
- 规则/文档/代码一致性：ADR 0224 第 6 条与代码在“1 分钟起、加倍、最长 1 小时”“按 owner/agent/模型/维度分开”“最多绕回一次”上一致；但“坏条目再多也挡不住后面的好条目”“直到补完”与实现有偏差（问题 1、2）。
- SQL 排序一致性：`memory_episodes.created_at`、`id` 均为 `TEXT`（`0053_memory_episodes.sql:6,18`），默认 BINARY；`ORDER BY e.created_at, e.id` 与 `(e.created_at, e.id) > (@afterCreatedAt, @afterId)` 使用同一套列排序规则，比较结果和排序一致。`id` 有 UNIQUE 约束，游标可严格前进，不会因并列游标卡住。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。本增量只改后台 `memory_episodes.embedding` 的补算、补算游标、重试诊断和出包校验，没有改请求组装、系统提示、工具定义、历史写入或遮盖代码。补算结果只影响“哪些 episode 已有向量”，进而影响当前轮的检索结果；检索结果按现有规则属于每轮会变的内容，应出现在最后一条消息/回忆工具结果里，不是在请求开头重写历史。此结论基于本增量未改搜索/渲染路径；具体注入渲染行本轮未逐行核实。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会由本改动引入。嵌入输入仍是 `episode.day + "\n" + text`，游标只决定扫描顺序；`make-packet.py` 输出仍用 `sort_keys=True` 的确定性 JSON，新增校验不参与输出排序。需要说明的是，后台补算进度会让“当前轮能检索到哪些记忆”随时间不同，但那是每轮动态内容（最后一条消息），不是稳定文本被改写。
3. **有没有自动检查，反向用例会不会真的失败？** 有：`apps/agent-service/test/local-vector-catch-up.unit.test.ts` 覆盖重试间隔增长、成功后不再跑、模型不可用时暂不跑；`packages/memory-engine/test/episode-backfill.unit.test.ts:73-133` 覆盖最多 3 条失败、绕回、游标续翻；`test/integration/memory-episodes.test.ts:389-404` 覆盖 SQL `after`；`scripts/delivery-mode/test_make_packet.py:578-589` 覆盖超大整数费用和分类夹非字符串。反向用例方面：make-packet 两条新用例在去掉防护后确实会失败（无穷大整数会触发 `OverflowError`，嵌套 list 会触发 `TypeError`）；但 SQL `after` 的用例不足以证明 `created_at` 被参与比较（问题 6），补算用例也没覆盖“诊断抛异常”“并发共享游标”“永久坏条目无限重试”，这些是覆盖缺口。测试未实际运行。
4. **每个新值/字段的两端都能接受吗？** 基本能。`after?: {createdAt,id}` 由 `episodes.ts` 产生，`MemoryEpisodeStorePort` 声明，`durable-adapters.ts:1137` 原样传给 `context.read`，`sqlite-worker` 用 `postMessage` 结构化克隆保留嵌套对象，最终 `sqlite-memory-operations.ts:1510-1511` 读取两个字段；两端名字和字符串类型一致。一个小的类型层问题是 `sqlite-memory-operations.ts:457-466` 的 dispatch 临时类型没有写 `after`，运行时不会丢字段，但建议补上以免以后重构时丢参数。`retryInMs` 被转成 `String`，符合 `writeServiceDiagnostic` 的 `Record<string, string | number | ...>`；`memory.embedding_catch_up_failed` 的新字段没有额外 schema 校验，日志消费端只按普通字段读取。`finite_non_negative` 只用于 `embedding_target` 的 cost，四个 `cost` 键逐一校验，和后续 `any(value != 0)` 的本地模型零费用检查相容。
