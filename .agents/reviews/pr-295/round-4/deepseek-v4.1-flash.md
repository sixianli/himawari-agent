# 代码复核：95408b0（PA-2 原话必须与记忆相关）

## 一、发现（按严重度）

### 1. 高：`unchanged` 的相关性校验把模型可控、且对本决策被丢弃的 `text` 计入，门禁可被绕过

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:345-347`
- 问题：相关判断用的是 `[text, tentativeTexts.get(existing)]`，其中 `text` 是模型本次输出、尚未与既有记忆核对的候选文字。而 `unchanged` 分支根本不用 `text`（只按 `existingMemoryId` 确认原记忆）。所以模型只要把不相关的原话抄进 `text`，就能让 `quoteRelatesToMemory` 通过，把一条不相干的待确认记忆转正——这正是本次要防的“拿无关的话当证据”。
- 证据：
  - `production-memory-capture.ts:347`：`!quoteRelatesToMemory(quote, [text, input.tentativeTexts?.get(existing) ?? ""])`
  - `packages/application/src/services/automatic-memory-service.ts:452-467`：`unchanged` 只把 `memoryId`、`quoteRef`、`sourceThreadId` 交给 `applyProposal`，`text` 没被使用。
  - `packages/application/src/services/durable-memory-service.ts:112-113`：`unchanged` 对 `tentative === true` 的条目执行 `confirm(...)`，即清掉待确认标记（不可逆，除非人工改）。
  - 构造（按代码推导，未运行）：待确认记忆 `主人喜欢喝咖啡`；主人消息与 quote、text 都为 `明天下午开会`；`quoteFromOwnerMessage` 通过，`relevanceTokens(quote)` 与 `relevanceTokens(text)` 完全相同 → 门禁通过 → 记忆被转正。现实里模型把“本轮抽到的新事实”填进 `text` 也很自然，未必是刻意绕过。
- 建议：`unchanged` 只允许用 `tentativeTexts.get(existing)` 做相关判断（或额外要求 `text` 与既有记忆文字相同/等价）：
  `decision === "unchanged" ? [tentativeText] : [text, tentativeText]`。并补一条“text 与无关原话相同、但记忆文字无关”的反向用例。

### 2. 中：单元反向用例实际上没走到新逻辑，删掉 `quoteRelatesToMemory` 也照样通过

- 文件:行：`apps/agent-service/test/production-memory-evidence.unit.test.ts:135-158`
- 问题：该用例 quote 是 `明天下午开会`（6 个字符），而 `quoteFromOwnerMessage` 要求至少 `MINIMUM_QUOTE_CHARACTERS = 8`（owner 消息更长时取 8）。所以 `evidenceVerified` 本来就是 false，候选被“原话未核实”拒掉，跟相关性判断无关；把 `!quoteRelatesToMemory(...)` 整段删掉，这个用例仍然通过。
- 证据：
  - `production-memory-capture.ts:69`：`const MINIMUM_QUOTE_CHARACTERS = 8;`
  - `production-memory-capture.ts:128-131`：`minimum = Math.min(8, [...normalizedMessage].length)`，`quote.length >= Math.max(1, minimum)`。
  - 测试 `:146` quote=`明天下午开会`（6 字），`:154` ownerMessage=`明天下午开会，顺便买点咖啡豆`。
  - 该用例里 `text` 还等于待确认记忆文字（`:143`/`:153`），也没有覆盖第 1 条的绕过路径。
- 建议：把 quote 换成足够长且确实在消息里的原话（例如直接整句 `明天下午开会，顺便买点咖啡豆`），并分别断言 `rejectedCandidates[0].attributes.evidenceVerified === true`（确认是“相关性”拒的，而不是“原话未核实”）。另加 `text` 与 quote 相同、待确认记忆无关的用例。
- 说明：`test/integration/production-memory-capture.test.ts:757-758` 的 `run-pa2-unrelated` 是有效反向用例（quote 8 字、能过 evidence 校验，删掉相关性判断就会转正、`toBe(true)` 失败）。所以集成层有拦截，问题在单元层给了假信心。

### 3. 中：通用词表覆盖不足，常见二字词会让无关原话“漏拦”

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:135-136`
- 问题：只过滤了 `主人/用户/喜欢/偏好/…/今天/现在` 和一批单字，但 `明天、下午、开会、公司、工作、时候、东西、朋友…` 这类高频词不在表内。只要共享其中任意一个二字片段就算“相关”，与“必须和那条记忆相关”的目标相反。
- 证据：
  - `GENERIC_TERMS` 全文见 `:135-136`，无 `明天/下午/开会/公司` 等。
  - 例（按代码推导）：待确认记忆 `主人下周要去大阪开会` → 去词后片段含 `开会`；主人消息和 quote 为 `明天下午三点开会` → 也含 `开会`，于是本不相关的话也能通过（而这句正好就是测试里选的“无关”例子）。
- 建议：如果确实要按字面判断，至少把时间/高频功能词补进通用词表，或改成要求共享的二字片段不在“停用二字表”里；更稳妥的是只在 `update/merge` 用候选文字，`unchanged` 只比记忆文字（见第 1 条）。

### 4. 低：中英混排相邻时整段被当成一个 token，共享的英文词反而判不相关（误拦）

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:146-153`
- 问题：只有“整段全是汉字/假名”才做二字切分；含 Latin 的混排 run 会整体作为一个 token。于是 `换iPhone` 与 `用iPhone` 都被当成不同的整段，尽管共享 `iphone`。会漏掉合法转正（属于 ADR 已接受的“误拦”方向，但对双语用户更常见）。
- 证据：`:146` 的正则 `^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$`，`:151-152` 的 `else if ([...run].length >= 2) tokens.add(run)`。
- 建议：混排 run 里对 Han 与 Latin 分别切分（Han 连续段取二字片段，Latin 段按词取），或先按字符类型再分段。

### 5. 低：过滤后只剩单字/空 token 的记忆永远无法转正

- 文件:行：`apps/agent-service/src/production-memory-capture.ts:146-153`
- 问题：单个汉字 run 不会产生任何 token（`index + 1 < chars.length` 不成立），若记忆文字被通用词过滤后只剩 1 个字（如 `主人是猫` → `猫`），`relevanceTokens` 为空集，任何原话都判不相关，永远转正不了。属“误拦”，但会造成长期无法转正。
- 建议：对单字 Han run 也加入单字 token（与二字并存），或对极短记忆放宽。
- 说明：同样属于 ADR 声明的“误拦代价”，是否修由产品决定。

### 已核查但未发现问题的点

- 性能：每个候选最多对 2 段文本做一次 `relevanceTokens`，记忆文本有 500 字上限；未见明显热点。模型给的 `quote` 在切词前没有长度上限，但受模型输出 token 限制，实际风险低（未发现可利用的资源耗尽）。
- 无正则回溯风险：`GENERIC_TERMS` 是固定选择分支，无嵌套量词。
- 侧信道/序列化：本改动不改变任何序列化格式或提示词字节（见必答问题 1/2）。

---

## 二、侧重检查

- **不可信输入 / 模型输出**：`quote`、`text` 都是模型输出。`quote` 先过 `quoteFromOwnerMessage`（必须逐字出自主人消息），这部分可信；但相关性判断又依赖模型可控的 `text`，形成绕过（第 1 条）。`tentativeTexts` 来自产品状态、`#readText` 读回，可信。
- **错误路径**：`existing` 为空、`tentativeTexts` 缺失、quote 为空/过短时，`confirmsTentative` 为 false 或 `evidenceVerified` 为 false，均落到“拒掉”，方向安全。`tentativeTexts.get(existing) ?? ""` 处理了缺键。
- **不可逆操作**：`unchanged` 转正会清掉 `tentative`（`durable-memory-service.ts:112-113`），只能靠人工再改；第 1 条的绕过因此后果偏重。
- **资源耗尽**：见上，未发现实际问题。
- **规则/文档/代码一致**：ADR 0179 第 6 条与代码行为基本一致（包括“或模型给的候选文字”），但正因把候选文字写进规则，`unchanged` 路径的目标没被真正保证；建议同时修正 ADR 措辞，明确 `unchanged` 不使用候选文字。`tentativeIds` → `tentativeTexts` 的接口替换在全仓库无残留调用（`grep` 未发现 `tentativeIds`）。
- **eval 覆盖**：`scripts/evals/memory-capture-live.eval.ts:120-128` 与 `apps/agent-service/test/prompt-output-contracts.unit.test.ts:22-28` 不传 `tentativeTexts`，所以这些路径根本不会触发新门禁（仅影响评测/契约测试，不影响生产）。

---

## 三、必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在后台抽取的解析阶段（`parseMemoryCandidates`）与 `tentativeTexts` 构造，`memoryCapturePrompt`（`:166-191`）未改，提示词、工具定义、历史、遮盖都没有新增/修改字段；`tentativeTexts` 也不进入提示词。新增内容仍只在后台调用的末尾数据部分。符合“只追加、会变的值放最后”的规则。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。`relevanceTokens` 只做 NFKC、小写、正则替换与切分，结果只取决于输入文本，不依赖时间、随机数、哈希或数据库返回顺序；`Set` 的迭代顺序也是确定性的。判定结果会随“记忆是否相关”变化，但不会改变任何已发送文本的字节。

3. **有没有对应的自动检查，反向用例真会失败吗？** 部分有。
   - 有效：集成用例 `test/integration/production-memory-capture.test.ts:757-758` 的反向场景在删掉相关性判断后确实会失败（quote 8 字可通过 evidence 校验，随后会转正，`toBe(true)` 失败）。
   - 无效：单元反向用例 `production-memory-evidence.unit.test.ts:135-158` 因 quote 只有 6 字、先被 `MINIMUM_QUOTE_CHARACTERS=8` 拦成“原话未核实”，删掉新逻辑也通过。
   - 缺失：没有“候选 `text` 与无关原话相同”的用例，因此第 1 条绕过不会被任何测试发现。

4. **改动产生/修改的值，每个使用处都能接受吗？** `tentativeIds` 改为 `tentativeTexts` 后，生产端唯一构造点在 `production-memory-capture.ts:828-830`，消费点在 `:338`、`:347`，键都是同一批 `ExistingMemoryText.id`（`MemoryId`），类型一致；全仓库无残留的 `tentativeIds` 调用（已用 grep 核对）。测试与 ADR 均已同步。唯一“能接受但不理想”的是 eval/契约测试不传该字段，导致它们无法覆盖新门禁；以及上文第 1 条——`parseMemoryCandidates` 把 `text` 当作相关判断依据，但 `unchanged` 下游并不消费它，两端语义不一致。
