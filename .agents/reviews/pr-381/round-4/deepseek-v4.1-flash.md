## 读代码证实的问题

### 1. 【高】坏条目仍会挡住候选窗口后面的好条目，只是窗口从 3 变成了 `limit+3`

- 文件：`packages/memory-engine/src/episodes.ts:344`、`:348-376`；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1499-1501`
- 问题：每页只列 `limit+3` 条，且这些坏条目不会被标记、下次仍按 `created_at,id` 排在最前。若前 4 条（`limit=1` 的每日摘要路径）或前 100 条（`limit=100` 的 catch-up 路径）全部失败，`embedded===0` 会直接抛错，后面的好条目永远轮不到。不是死循环，但会长期无进展。
- 证据：
  - `episodes.ts:344`：`limit: Math.min(100, input.limit + EPISODES_LISTED_PAST_LIMIT)`
  - `episodes.ts:362-364`：失败只 `failure ??= { error }; continue;`，不推进游标
  - `episodes.ts:376`：`if (failure && embedded === 0) throw failure.error;`
  - `sqlite-memory-operations.ts:1501`：`ORDER BY e.created_at, e.id LIMIT @limit`
  - ADR 写的是“坏条目不会挡住同一批里后面的好条目”（`docs/adr/0224-memory-embedding-runs-on-the-host.md:57`），只在候选窗口内成立。
- 建议：不要用固定 `+3`；改成带游标的分页，或记录失败次数/退避，遇到整页失败时跳过该页继续找后面的好条目；加“4 条连续坏条目后面才有好条目”和“整页失败后下一页有好条目”的反向用例。

### 2. 【中】catch-up 只尝试一次，任何失败后永久不重试

- 文件：`apps/agent-service/src/service-main.ts:1531-1548`、`:1565-1573`
- 问题：`caughtUp = true` 在调用前设置；`catchUpLocalVectors()` 抛错时只写诊断，之后没有重试或复位。一次瞬时存储/嵌入失败，就让“本机模型 ready 后补算全部旧向量”永久停在半途，直到进程重启。
- 证据：
  - `:1565-1567`：`if (!ready || caughtUp) return; caughtUp = true;`
  - `:1567-1573`：`void catchUpLocalVectors().catch(...)` 只写 `memory.embedding_catch_up_failed`
- 建议：成功后才置 `caughtUp`；失败按退避重试，或把未完成状态暴露给健康检查并允许后续触发。

### 3. 【中】诊断写入失败时，原错误会被诊断错误替换

- 文件：`apps/agent-service/src/production-run-memory.ts:373-383`
- 问题：`releaseReserved()` 失败的 catch 里直接调用 `options.diagnostic?.(...)`；若诊断回调自身抛错，`throw error` 不会执行，调用方拿到的是诊断错误而不是原始的 `releaseReserved` 错误。这与作者“仍抛原错误”的说法不完全一致。
- 证据：
  ```
  catch (release) {
    options.diagnostic?.({ event: "memory.embedding_release_failed", ... });
  }
  throw error;
  ```
  `markUnknownKeepingError` 里的诊断也是同样写法（`:341-347`）。
- 建议：诊断调用再包一层 `try/catch`，或统一用不会抛错的 `safeDiagnostic()`；补“诊断抛错时仍抛原错误”的用例。

### 4. 【中】去掉失败上限后，单页最多可做 `limit+3` 次失败重试，每次都有完整 deadline

- 文件：`packages/memory-engine/src/episodes.ts:344-365`；`apps/agent-service/src/service-main.ts:1536-1545`
- 问题：原来失败 3 条就停，现在一页最多 100 条（`limit=100`）都会尝试；catch-up 的 `within` 对每条都重新给一个 `providerRequestMs` 截止时间。大量超长/持续失败的 episode 会让后台补算放大到数百次模型请求和数小时等待。
- 证据：`:1539-1541` 每条调用都 `Date.parse(clock.now()) + configuration.deadlines.providerRequestMs`。
- 建议：给整轮补算一个总预算，或保留“连续失败上限”，同时用游标越过失败条目；不要用取消失败上限来换取前向进展。

### 5. 【低】出包脚本对恶意/畸形的大整数费用会抛裸异常，而不是给出明确的拒绝原因

- 文件：`scripts/delivery-mode/make-packet.py:286`
- 问题：`math.isfinite(value)` 会对任意 `int` 求值；JSON 可以解析超大整数，CPython 把超大整数转 float 时会抛 `OverflowError`，这里没有被 `refuse()` 包住，结果是 traceback 而不是 `PACKET_EMBEDDING_TARGET_INVALID`。未运行验证，按 CPython 语义判断。
- 证据：`any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in cost.values())`
- 建议：只对 float 做有限性检查，例如 `isinstance(value, float) and not math.isfinite(value)`，或把整段校验包进 `try/except (OverflowError, TypeError)`；补超大整数用例。

补充一个较早代码的同类畸形输入问题（不是本轮引入）：`make-packet.py:290` 在检查元素类型前先 `set(classifications)`，若 JSON 里分类元素是列表/对象会抛 `TypeError`，也不是干净拒绝。可顺手把 `all(isinstance(...))` 放到 `set()` 前。

## 推测 / 未核实

- **遮盖密钥轮换后向量身份不会失效**（推测为运维风险）：`embeddingIdentityFor` 的哈希只含 `EGRESS_RULESET_CURRENT`（`packages/application/src/embedding-profiles.ts:165-179`），而出口遮盖的占位符字节取决于签名 key（`packages/application/src/services/model-egress.ts:121-126`）。key 轮换后同一段文字遮出的字节变了，但向量身份不变，旧向量不会重算。是否构成实际问题取决于 key 是否允许在不重建索引的情况下轮换，未查到明确约束。
- ADR 里 jina 的 `artifactSha256 = dcf556...`（`docs/adr/0224-memory-embedding-runs-on-the-host.md:55`）没有对应构建产物可核对，**未核实**。
- 本次没有运行测试，以下“反向用例会失败”的判断来自阅读断言逻辑。

## 侧重检查

- **错误路径**：检查了 `releaseReserved()` 失败、诊断失败、catch-up 失败、模型加载失败。前两者见问题 3；catch-up 一次性见问题 2。模型加载失败会把状态置 `failed`，但没有重试，只能重启，属于可接受但需知悉的降级。
- **畸形/不可信输入**：检查了 `TARGET_EMBEDDING_JSON`、`artifactSha256`、model 名、manifest 文件清单。`embedding-artifact-check.py` 用 `SAFE_NAME` 限定文件名、拒绝符号链接、逐文件校验哈希；`local-onnx-embedding.ts` 也限制 manifest 只允许固定文件，路径穿越被挡住。出包目标见问题 5。
- **安全**：`deploy-preflight.py:152` 把目标字段交给远端脚本前用了 `shlex.quote`；`make-packet.py:300-303` 拒绝目标 JSON 中的单引号和反斜杠，避免注入 `json.loads('...')` / JS 字面量。未发现命令注入路径。`deploy-preflight.py:118` 只做类型检查，空模型名或格式错误的哈希会传到远端，但远端 `embedding-artifact-check.py` 会判 `target-invalid`，且参数已 quote，因此不是最终放行，只是错误信息不够早、不够明确。
- **资源耗尽**：本机嵌入队列有上限 64（`local-onnx-embedding.ts:340-346`），输入限制 8192 token（`:437-438`）；但补算的失败重试放大见问题 4。
- **不可撤销操作**：本轮改动只涉及补算、记账释放和出包校验，没有新增删除/覆盖数据路径；`releaseReserved` 失败不回滚已写数据，只影响预算记录。
- **规则/文档与代码一致性**：ADR 0224 第 6 条“坏条目不会挡住后面的好条目”表述过强，见问题 1；第 7 条的费用/重复校验与代码一致；第 5 条的 jina 哈希未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   没有证据表明会。现有 `MEMORY_EMBEDDING_QUERY_INSTRUCTION.text` 未改，新增的嵌入前缀都在 `embedding` 层（`packages/prompt-catalog/src/memory.ts:45-93`），且新文本片段都短于 24 字符，不会进入 `TRUSTED_PROMPT_TEXTS`（`entry.ts:68`）；现有 prompt golden 快照没有被改写。嵌入变化只影响向量和检索结果，检索结果仍渲染在 `turnPrompt` 的最后一条用户消息里（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`），系统提示、工具定义、历史没有新增改写。每轮变化的记忆/时间仍在最后一条消息，整体仍是末尾追加。

2. **同一段文字会不会在不同请求里变成不同字节？**
   就本次新增的嵌入文本和身份而言，未发现新增的不确定来源：`renderPrompt` 按固定 segments 拼接，`embeddingIdentityFor` 用固定顺序的 JSON 数组和固定 recipe，无时间字段、无无序集合。
   例外/风险：出口遮盖的占位符依赖签名 key（`model-egress.ts:121-126`），而身份哈希不含 key。key 轮换后同一明文会遮成不同字节，但身份不变，旧向量不会自动重算（推测性风险，见上）。

3. **有没有对应自动检查，反向用例真的会失败？**
   有，但覆盖不均匀：
   - 补算：`episode-backfill.unit.test.ts:109-119` 的“3 条坏 + 1 条好”会让旧的“失败满 3 条就停”实现失败，反向有效；但没有覆盖 4 条以上连续坏、整页失败后下一页有好条目、catch-up 重试。
   - `releaseReserved`：`production-model-composition.unit.test.ts:942-961、1000-1031` 会让“release 错误替换原错误”的实现失败（release 错误不在 `leaseLost` 中，`recorded[0]` 会变 true），间接覆盖了“仍抛原错误”；但没有断言 `memory.embedding_release_failed` 诊断，也没有诊断抛错的用例。
   - 出包：`test_make_packet.py:584-585` 覆盖重复能力/分类、`inf`、带空格能力；移除新校验会失败。大整数溢出未覆盖。
   - 上线检查：`test_deploy.py:224-240` 覆盖缺模型名/哈希/维度时 `SystemExit`，移除新检查会失败。

4. **每个新值的使用方都能接受吗？**
   逐个核对后，主要链路一致：
   - `artifactSha256`：类型定义 `configuration.ts:65`、严格解析 `strict-configuration.ts:368-389`、出包 `make-packet.py:280,296`、上线检查 `deploy-preflight.py:118`、本机加载 `local-onnx-embedding.ts:111-124`，格式都是 64 位小写十六进制且非全 0。
   - `dimensions`：`make-packet.py:265-270` 的档案表与运行时 `embedding-profiles.ts` 一致，`test_make_packet.py:590-600` 还有交叉检查。
   - `memoryMinimumSimilarity` 变为可选后，服务启动用档案默认值（`service-main.ts:1698-1700`），切换/维护脚本会删旧覆盖值（`maintenance-common.mjs:351`、`S7-switch-start-readback.py:170`），使用方一致。
   - 新身份 `model#hash` 被存为 `embedding_model`，索引查询按精确 model 过滤（`sqlite-memory-operations.ts:1260,1428,1499`），请求校验仍比对档案 model 而非 identity（`production-run-memory.ts:169`），两端一致。
   - 出包格式：`TARGET_EMBEDDING_JSON` 拒绝单引号和反斜杠后写入 JS/Python 字面量，消费方 `json.loads` / `Object.freeze` 可接受。

   不一致/风险只剩：`deploy-preflight.py` 对 model/hash 只做类型检查而非格式检查；`make-packet.py` 对超大整数和不可哈希分类元素会异常退出。两者都不等于“服务启动能接受的合法目标被错误拒绝”；反过来说，正常合法目标不会被新规则拒绝。
