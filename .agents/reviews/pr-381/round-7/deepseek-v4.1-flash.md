已核对 `586a7171..17649f37` 的增量，并回读了这些值在产生端和使用端的代码。结论是：主要目标方向正确，但失败分类有两处与作者说法/ADR 不一致，白名单改动还缺规则要求的真实 gitleaks 校验。

## 发现（按严重度）

### 1. 高：普通 `Error` 形式的 `EMBEDDING_VECTOR_INVALID` 会中断整次补算，单条坏向量可能永远挡住后面的条目

- 文件:行：`packages/memory-engine/src/episodes.ts:39-46`；`packages/memory-engine/src/embedding.ts:91,134,155-160,245-248`；`apps/agent-service/src/production-run-memory.ts:326-335`
- 问题：`failsOnlyThisSummary` 先要求 `error instanceof ApplicationPortError`。但“向量不合法”有多条抛出路径是普通 `Error`，不会被当成“这一条算不出来”，而是直接 `throw error`，不记等待、也不跳过。只要某一条 episode 的向量始终不合法，每次补算都会停在这一条，后面的好条目永远轮不到。
- 证据（读代码证实）：
  - `episodes.ts:40`：`if (!(error instanceof ApplicationPortError)) return false;`
  - `embedding.ts:160`：`if (!Number.isFinite(norm) || norm === 0) throw new Error("EMBEDDING_VECTOR_INVALID");`
  - `embedding.ts:246-247`：`if (!embedding || embedding.length !== this.dimensions) throw new Error("EMBEDDING_VECTOR_INVALID");`
  - `embedding.ts:91` 和 `:134`：网关/本机 usage 校验同样抛 `new Error("EMBEDDING_VECTOR_INVALID")`。
  - 只有本地运行时那一处是 `ApplicationPortError`：`local-onnx-embedding.ts:211-213` 的 `failure()`，以及 `:442` 的 `throw failure("EMBEDDING_VECTOR_INVALID")`。
  - `production-run-memory.ts:326-335` 调用 `embeddingUsageFor(...)` 后只做诊断再 `throw error`，不转换错误类型。
- 建议：要么让 `failsOnlyThisSummary` 按错误信息识别普通 `Error`（例如 `error instanceof Error && SUMMARY_EMBEDDING_FAILURES.has(error.message)`），要么把 `EgressEmbedder`、`normalizedVector`、`localEmbeddingUsage`/`gatewayEmbeddingUsage` 的这些错误统一包成 `ApplicationPortError`。并补一条反向用例：让 `embedDocument` 抛普通 `Error("EMBEDDING_VECTOR_INVALID")`，断言后续好条目仍被补算、该条进入等待。

### 2. 中：任何 HTTP 400 都记到当前条目上，模型名错误这类整体失败会造成大面积等待

- 文件:行：`packages/memory-engine/src/episodes.ts:37,42-45`；`packages/memory-engine/src/embedding.ts:279-283,299-309`
- 问题：`SUMMARY_REJECTION_STATUSES` 包含 `"400"`，而 `EMBEDDING_HTTP_FAILURE` 只保存了 `status`，没有用 `gatewayErrorType`/`gatewayErrorMessage` 区分“这条输入不合法”和“模型名/请求格式/账号配置整体不对”。网关因模型名错误返回 400 时，每个 episode 都会被记一次“这一条算不出来”，进入 1 小时起、逐次加倍的等待；配置修好后仍要等退避时间，和 ADR 说的“确属这一条内容的问题”不一致。
- 证据（读代码证实）：`episodes.ts:37` `const SUMMARY_REJECTION_STATUSES = new Set(["400", "413", "422"]);`；`episodes.ts:42-45` 只按 `status` 判断；`embedding.ts:279-283` 生产端是 `status: String(response.status)`，`gatewayErrorDetails` 的 `type`/`message` 被存下来但没有参与分类。
- 建议：用 `gatewayErrorType`/`gatewayErrorMessage` 区分模型错误与输入错误；或在一次 pass 内先暂存失败，只有至少成功补算一条后才把失败写入等待表，否则整体报错不记等待；也可在首次 400 时用固定短输入做一次探测。补“模型名错误 400 不记等待”和“单条输入 400 记等待”的对照用例，并补 413/422 用例。

### 3. 中：新 gitleaks 白名单用了 ADR 0177 明确禁止的字符类形状，且没有同步改 ADR

- 文件:行：`ci/rules/gitleaks.toml:150-156`；`docs/adr/0177-gitleaks-exact-value-allowlist.md:65-71`
- 问题：新块是 `regexTarget = "secret"` + `^[0-9a-f]{64}$`，即“任意 64 位小写十六进制都放行”，不是已审阅的精确值。ADR 0177 第 2 条明确写着“用 `^…$` 锚定那一个精确值（不得写成字符类，例如‘任意 32 位十六进制’）”。作者说仓库主人已同意，但本轮没有 ADR 修改或补充记录，规则文件、说明文档和代码不一致。实际效果是：只要在 `build-artifact.py` 里出现任意 64 位小写十六进制，包括将来误入的真密钥，都会被放行。
- 证据（读代码证实）：
  - `ci/rules/gitleaks.toml:155-156`：`regexTarget = "secret"`；`regexes = ['''^[0-9a-f]{64}$''']`
  - ADR 0177:68：`regexes` 只有一个正则，用 `^…$` 锚定那一个精确值（不得写成字符类，例如“任意 32 位十六进制”）；
- 建议：如果确实批准了按形状放行，应在 ADR 0177 或新 ADR 里记录批准、范围和残余风险；否则改用 `regexTarget = "line"` 匹配新的 `("digest", "文件名")` 行形状，或者逐个列出摘要值。按 ADR 第 2 条，最稳妥的是把具体摘要列为精确值。

### 4. 中：新白名单没有 ADR 0177 第 4 条要求的真实 gitleaks 正反样例，条数测试和反向样例也不一致

- 文件:行：`test/tooling/gitleaks-allowlist.test.mjs:63-72,91-119`；`test/tooling/gitleaks-config.test.mjs:66-92,233-294`；`docs/adr/0177-gitleaks-exact-value-allowlist.md:71`
- 问题：`scoped` 的条数改成了 16，但下面“改一个字符不放行”的样例列表仍只有 15 个，最后新加/改动的 `build-artifact.py` 块不在覆盖范围内。`gitleaks-config.test.mjs` 的 fixture 和放宽清单里也没有 `scripts/embedding-models/build-artifact.py`。ADR 0177 第 4 条要求“新加或改动的块，还要在 `gitleaks-config.test.mjs` 里加样例，用锁定版本的真实 Gitleaks 核对放行的文件不再报、同一个值出现在别的文件里照报”。所以这块白名单的真实效果没有自动检查；如果把 `{64}` 改成 `+` 或把路径放宽，现有测试不一定失败。
- 证据（读代码证实）：
  - `gitleaks-allowlist.test.mjs:64`：`expect(scoped).toHaveLength(16);`
  - 同文件 `:91-119` 的样例数组只有 15 项，索引只覆盖 `scoped[0]` 到 `scoped[14]`。
  - `gitleaks-config.test.mjs:66-92` 的 `FIXTURES`、`:233-294` 的 `it.each` 放宽清单都没有 build-artifact 相关样例。
  - ADR 0177:71：`新加或改动的块，还要在 test/tooling/gitleaks-config.test.mjs 里加样例，用锁定版本的真实 Gitleaks 核对放行的文件不再报、同一个值出现在别的文件里照报。`
- 建议：在 `gitleaks-config.test.mjs` 加一个 `scripts/embedding-models/build-artifact.py` fixture（真实的 `("digest", "文件名")` 行），并加另一个文件含同一摘要的 fixture，断言前者不报、后者照报；在 `gitleaks-allowlist.test.mjs` 给新块加专用反向（大写、63/65 位、改一个字符）并确保真实 gitleaks 验证通过。

### 5. 低：字节长度超限走的是整体错误码，不在逐条失败集合里

- 文件:行：`apps/agent-service/src/production-run-memory.ts:174-184`；`packages/memory-engine/src/episodes.ts:33-46`
- 问题：本地 token 超限抛 `EMBEDDING_LOCAL_INPUT_LENGTH`，会被逐条处理；但服务层先按 `Buffer.byteLength(request.input, "utf8") > 16384` 预检，抛的是 `EMBEDDING_REQUEST_OUTSIDE_POLICY`，不在逐条集合里。若某条摘要超过 16 KB（遗留/损坏数据或未来改大摘要上限），它会整体抛出，卡在同一条。正常摘要被截到 1200 字符，所以常规路径基本不会触发，但与 ADR“超长按条跳过”的描述不完全一致。
- 证据（读代码证实）：`production-run-memory.ts:178` 的字节预检，`:181-184` 抛 `EMBEDDING_REQUEST_OUTSIDE_POLICY`；`episodes.ts:33-36` 只列了 `EMBEDDING_LOCAL_INPUT_LENGTH` 和 `EMBEDDING_VECTOR_INVALID`。`episodes.ts:279` 正常摘要会 `.slice(0, MAXIMUM_SUMMARY_CHARACTERS)`，上限 1200。
- 建议：把“输入过长”拆成独立错误码并加入逐条集合，或让引擎在发送前按同一规则判断并跳过；补一条超长 episode 不挡住后续条目的用例。

## 未核实 / 推测

- **未核实**：锁定版 gitleaks 在真实 `build-artifact.py` 上是否已经不报。无法运行 gitleaks；而且本轮没有加对应 fixture，所以缺少自动证据。作者说的“只按值 `^[0-9a-f]{64}$`、只对那一个文件”从配置文本看成立，但“实际能放行”未核实。
- **未核实**：`ci/toolchain-lock.json` 里 `ci/rules/gitleaks.toml` 的新 sha256 是否与文件一致。无法运行 sha256；不过 `scripts/ci/install-tools.mjs` 的 `verifyRuleFiles` 会校验，若值错 CI 会失败。
- **推测**：网关对错误模型名返回 400。代码对所有 400 一视同仁是证实的；具体状态由服务方决定，未在代码里核实。
- **推测**：零向量/远端坏向量出现的频率。机制是证实的：本地运行时先检查有限值，之后的 `normalizedVector` 仍可能因零范数抛普通 `Error`；网关路径则在 usage 校验处就抛普通 `Error`。
- **推测**：大量在等条目时，每次补算会一直翻页到末尾（等待条目只 `continue`、不提前结束），可能带来额外 DB 查询；代码路径成立，未实测性能影响。

## 侧重检查

- **错误路径**：逐条失败与整体失败的分界线是 `failsOnlyThisSummary`。整体类错误（`EMBEDDING_LOCAL_NOT_READY`、`EMBEDDING_LOCAL_QUEUE_FULL`、超时、`NOT_AUTHORITATIVE`、429/5xx）确实不会被记等待；但普通 `Error` 的向量错误和 400 的语义问题见上面第 1、2 条。重试时间 1 小时起、加倍、24 小时上限，以及时钟回拨超过 24 小时立即重试，代码与 ADR 一致（`episodes.ts:384-386,407-413`）。
- **不合规范/不可信输入**：`after` 在 `sqlite-memory-operations.ts:1491-1503` 做了类型校验，SQL 用绑定参数（`:1512-1522`），无注入风险；引擎产生端和 SQLite 使用端形状一致，集成测试覆盖 worker/direct 两条路径。校验只检查字符串、不检查时间格式；由于是内部端口、生产端来自数据库行，实际可接受。
- **安全**：新 gitleaks 块路径锚定到 `scripts/embedding-models/build-artifact.py`，值只匹配 64 位小写十六进制，不会放到别的文件；但值形状从“已审阅摘要”扩成“任意 64 位十六进制”，且与 ADR 0177 不一致，见第 3 条。`build-artifact.py` 的下载摘要校验、符号链接拒绝和工具版本检查是既有逻辑，本轮只改字典构造，没有放宽。
- **资源耗尽**：`#embeddingRetries` 有 1 万条上限并在插入时淘汰最旧条目（`episodes.ts:414-417`），内存有界；`#embeddingsInFlight` 在 `finally` 删除（`:429-431`）。上限淘汰本身没有测试。大量等待条目会反复翻页，见“未核实/推测”。
- **不可撤销操作**：本轮没有新增删除、清理、发送或持久化不可逆操作；只改后台补算、分页读取、出包脚本和 gitleaks 规则。
- **规则/说明/代码一致**：ADR 0224 对 1 小时起、加倍、24 小时、1 万条、时钟回拨的描述与代码一致；但“只有确属这一条内容的问题（向量不合法、400/413/422、超过 token）”与代码的分类不完全一致（第 1、2、5 条）。ADR 0177 第 2、4 条与新白名单/测试不一致（第 3、4 条）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮增量只改后台向量补算、SQLite 分页、出包脚本和 gitleaks 规则，没有改系统提示、工具定义、历史消息或遮盖结果。整个 PR 新增的 embedding 前缀只用于向量模型的输入，是固定文本，不进入聊天请求；聊天侧仍然是“固定的在前、会变的在后”，每轮变化的时间/记忆/资料仍在最后一条消息。本轮我没有重新运行 `check:prompt-prefix`，但 diff 里没有触碰该检查覆盖的提示组装路径。

2. **不会让同一段文字在不同请求里变成不同字节。** embedding 的 query/document 前缀按档案固定，episode 文本取自已存摘要，补算重试表、`after` 分页值都不会进入模型输入；`build-artifact.py` 的映射顺序也保持原顺序，且 manifest 用 `sort_keys=True`。需要说明的是，本 PR 相对改动前给本机模型的输入加了固定前缀（例如 `Document: `、`Query: `），这是版本级变化，由向量身份里的配方哈希负责重算；改动之后，同一段文字每次仍是相同字节。遮盖不依赖后面的消息。

3. **有自动检查，但不完整。** 已覆盖：400、`EMBEDDING_LOCAL_INPUT_LENGTH`、`EMBEDDING_LOCAL_NOT_READY`、退避/24 小时/时钟回拨、整体错误不记等待、`after` 形状（worker/direct）。未覆盖且正是缺口的有：普通 `Error("EMBEDDING_VECTOR_INVALID")`（第 1 条）、413/422、模型名错误导致的全局 400（第 2 条）、1 万条淘汰、字节超长（第 5 条）、新 gitleaks 块的真实放行和值形状反向（第 3、4 条）。因此：对已有路径，反向用例会真的失败；但对本轮新加的错误分类路径和新白名单，反向用例不会失败，因为根本没有覆盖。

4. **逐个值核对：**
   - `after`：产生端 `episodes.ts:366,379` 从数据库行取字符串；端口在 `packages/application/src/ports/memory-episodes.ts:57-65` 声明；SQLite 分发在 `sqlite-memory-operations.ts:457-466` 带上 `after`，校验在 `:1491-1503`，SQL 绑定在 `:1512-1522`。两端都能接受，集成测试覆盖 worker/direct，未发现 I-73 式的清单 id 过不了后端校验。
   - `EPISODES_LISTED_PAST_LIMIT`、`REMEMBERED_EMBEDDING_FAILURES`、重试表键：仅内部使用，没有外部消费者；键包含 owner/agent/model/dimensions/episode id，随向量身份变化。
   - `SUMMARY_EMBEDDING_FAILURES`：`EMBEDDING_LOCAL_INPUT_LENGTH` 与本地运行时产生端一致；`EMBEDDING_VECTOR_INVALID` 只与本地运行时的 `ApplicationPortError` 一致，与 `embedding.ts` 的普通 `Error` 不一致，见第 1 条。
   - `SUMMARY_REJECTION_STATUSES`：产生端 `embedding.ts:281` 用 `String(response.status)`，字符串形状能匹配；但 400 的语义过宽，见第 2 条。
   - `build-artifact.py` 的 `(digest, name)` 元组：生成结果仍是 `name -> digest`，使用端在 `:129-132` 按 `relative, expected` 遍历、`:157-161` 写入 manifest，键值与原映射相同；可以接受。
   - gitleaks 的路径/正则/测试条数：路径只指向 `build-artifact.py`，值只匹配 64 位小写十六进制；但值和测试的规则一致性问题见第 3、4 条。`ci/toolchain-lock.json` 的 sha256 有 `verifyRuleFiles` 使用，值是否正确未核实。
   - ADR 0224：退避、1 万条、24 小时、时钟回拨与代码一致；失败分类的表述与代码不一致，见第 1、2、5 条。
