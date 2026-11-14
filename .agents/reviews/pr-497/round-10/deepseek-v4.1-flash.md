这一轮查过：`8fd3096..b7ffc73` 的增量（`scripts/model-review/plan-claims.mjs`、`test/tooling/plan-claims-gate.test.mjs`、`.agents/instructions/delivery-mode.md`、第 9 轮记录），并跟到使用端：`scripts/ci/merge-queue.mjs`、`.github/workflows/merge-queue.yml`、`.github/workflows/main.yml`、`.claude/rules/owner-standing-rules.md`、`.agents/instructions/model-review.md`、`scripts/model-review/opencode-review.mjs` 的 `buildPrompt`/`assertReviewed`。**未核实**：第 9 轮记录内容（稀疏检出且工具拒绝 records-path）、已提交的 plan-claims 答案、实际测试运行结果。

### 1、中：临时例外说“合并不等 PR CI”，但合并队列的入口和候选推进仍强制要求 `ci/required` 成功

- 文件:行：`.agents/instructions/delivery-mode.md:27`、`scripts/ci/merge-queue.mjs:500-507`、`scripts/ci/merge-queue.mjs:522-525`、`.claude/rules/owner-standing-rules.md:43`、`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:68`
- 问题：新规则要求“在 Andy 重新打开 CI 门禁前，合并不等 PR 上的 CI”，并说“排队的 PR 一个一个合”；但队列在入队检查时要求 PR 头的 `ci/required` 必须是 success，在候选推进时也要求候选运行和 `ci/required` 作业都 success。
- 证据（读代码证实）：
  - `merge-queue.mjs:522-525`：`const check = await github.requiredCheck(head); if (check.state === "pending" || check.state === "missing") return { skip: true }; if (check.state !== "success") return { eject: \`PR 最新提交上的 ci/required 没过：${check.url}\` };`
  - `merge-queue.mjs:500-507`：`const required = await github.requiredJobConclusion(run); const passed = run.conclusion === "success" && required === "success"; ... if (passed) return mergeCandidate(...); return failCandidate(...);`
  - `owner-standing-rules.md:43`：`线程执行合并的方式是给 PR 加 merge-queue 标签，由合并队列完整测过后合进 main`。
  - `ADR 0268:68`：`加标签前的条件不变：复核已到最新提交、PR 上 ci/required 成功。`
- 建议：二选一并在文档里写死：要么给队列加一个只在例外期使用的显式旁路/标签（并说明旁路时用什么替代完整测试），要么明确“例外期不走 merge-queue，线程直接调用合并接口”，同时修改 owner 规则和 ADR 0268 的入口条件。现在的文字无法按现行代码执行。

### 2、低：文档说合并后由 `Main confirmation` 跑全量测试，但队列用 `GITHUB_TOKEN` 合并不会触发 `main.yml`

- 文件:行：`.agents/instructions/delivery-mode.md:27`、`.github/workflows/main.yml:1-3`、`.github/workflows/merge-queue.yml:41`、`docs/adr/0268-merge-queue-and-related-tests-on-prs.md:101`
- 问题：新规则承诺“合进 `main` 后由 `Main confirmation` 工作流跑全量测试”。这只在人手用用户令牌合并、产生 `push` 事件时成立；队列合并用的是 `${{ github.token }}`，而 ADR 0268 已写明队列合入的提交不跑 `main.yml`。
- 证据（读代码证实）：
  - `main.yml:1-3`：`on: push: branches: [main]`。
  - `merge-queue.yml:41`：`HIMAWARI_CI_GITHUB_TOKEN: ${{ github.token }}`。
  - `ADR 0268:101`：`队列合入的提交不跑 main.yml（前提 2），人手合并的仍然跑。`
- 建议：区分两条合并路径，明确例外期到底走哪条；如果仍用队列，不要声称 Main confirmation 会兜底，或补一个不依赖 `GITHUB_TOKEN` push 的合并后全量测试触发方式。

### 3、低：`model-review.md` 仍按旧规则描述引文，未同步“同一个被引文件”和“最多 8 个位置”

- 文件:行：`.agents/instructions/model-review.md:39`、`scripts/model-review/plan-claims.mjs:186`、`scripts/model-review/plan-claims.mjs:197-200`
- 问题：新代码要求一条 CLAIM 的代码引文必须整体（或按顺序的各段）出现在**其中一个**被引文件里，且位置数最多 8 个；但 `model-review.md` 仍说“把文件里真有的几段拼在一起的引文仍能通过”，没有写“同一个被引文件”，也没有写 `too-many-places`。
- 证据（读代码证实）：
  - `plan-claims.mjs:186`：`if (places.length > MAX_EVIDENCE_PLACES) return "too-many-places";`
  - `plan-claims.mjs:197-200`：`! [...texts.values()].some((text) => quoteInText(claim.code, text))`
  - `model-review.md:39`：`把文件里真有的几段拼在一起的引文仍能通过（用 \`…\` 省略中间时不查先后）`。
- 建议：把这一条改成“引文必须落在同一个被引文件里；用全角分号、换行或 ` / ` 拆开的各段还要按顺序；用 `…` 时分段不查先后；一条 CLAIM 最多 8 个位置，超过报 `too-many-places`”，并补上 `too-many-places` 这个原因。

### 4、低：`REVIEW_CURRENT` 只表示复核记录链完整，不表示“没有中、高意见”

- 文件:行：`.agents/instructions/delivery-mode.md:27`、`scripts/model-review/opencode-review.mjs:1447-1542`、`scripts/model-review/opencode-review.mjs:1536-1539`、`.agents/instructions/model-review.md:75`
- 问题：新例外把“复核没有中、高意见”和“`--assert-reviewed` 输出 `REVIEW_CURRENT`”写在同一组括号里，容易被读成后者能证明前者。实际上 `assertReviewed` 只检查账本、复核链、未复核文件、claims 和密钥遮盖，不读模型意见的严重度。
- 证据（读代码证实）：
  - `opencode-review.mjs:1536-1539`：`problems.length === 0 ? [\`REVIEW_CURRENT ${summary}\`, ...chain] : [\`REVIEW_NOT_CURRENT ...\`]`；`problems` 的来源中没有严重度检查。
  - `model-review.md:75` 说明“没有中、高严重度的‘会出错’意见”是线程的判断，`--report --stop no-error` 只核对最后一轮在链上和合并门通过。
- 建议：改成“复核没有中、高意见（由线程按 `model-review.md` 判断），且 `--assert-reviewed` 输出 `REVIEW_CURRENT`”，避免线程把记录完整误当成意见已清零。

### 5、低：位置数上限在完整拆分 `location` 之后才检查，不能限制解析阶段的分配

- 文件:行：`scripts/model-review/plan-claims.mjs:167-179`、`scripts/model-review/plan-claims.mjs:183-186`
- 问题：`locationsOf` 先把整个 `location` 按逗号拆开并逐项解析，之后 `claimEvidenceProblem` 才检查 `places.length > MAX_EVIDENCE_PLACES`。因此上限只限制了后面的 `git show` 文件读取，不能限制超长 `location` 字段在 `split`/数组上的分配。
- 证据（读代码证实）：`locationsOf` 中 `for (const part of location.trim().split(/[,，]\s*/u))` 没有长度或数量上限；`claimEvidenceProblem` 的 `if (places.length > MAX_EVIDENCE_PLACES)` 在 `locationsOf` 返回之后。
- 推测：影响有限，答案文件本身由 PR 提交、已经受仓库和模型输出长度限制；但复核门会在 CI/线程机器上处理它，超长字段仍可造成不必要的 CPU/内存消耗。
- 建议：在 `locationsOf` 的循环里一旦超过 8 就提前返回一个可识别的“超限”结果，或在拆分前限制 `location` 长度。若不想改返回值，可在 `claimEvidenceProblem` 先用一个便宜的逗号计数做上限判断。

## 侧重检查

- **错误路径和不可信输入**：查了 `locationOf`/`validEvidencePath`（拒绝绝对路径、`..`、前导 `-`、`.agents/reviews/`、空白和冒号），`locationsOf` 对尾部坏位置改为整体返回 `[]`，`claimEvidenceProblem` 的缺文件、行号越界、`找不到` 零位置分支。结论：新增校验更严格；`git show` 使用 `spawnSync` 数组参数，没有 shell 注入面；路径不能以 `-` 开头，不会被当成 git 选项。未发现新的路径穿越或注入问题。
- **安全**：改动是只读的 `git show` 和本地字符串匹配，没有写入、删除、网络或不可撤销操作；没有新增日志或序列化秘密的路径。
- **资源耗尽**：最多读取 8 个被引文件，且上限检查在读取文件之前，这是改进；残留问题是 finding 5 的“先完整拆分再限数”。`blobAt` 的 `maxBuffer` 仍是 256 MiB，属于原有行为。
- **规则、说明文档和代码一致性**：finding 1（临时例外 vs 合并队列）、finding 2（Main confirmation vs 队列合并）、finding 3（`model-review.md` vs 新引文规则）、finding 4（`REVIEW_CURRENT` vs 中高意见）均为读代码确认；另外，`.agents/instructions/model-review.md:39` 没有提到新的 8 个位置上限。
- **未核实**：第 9 轮记录（`.agents/reviews/pr-497/round-9/`）在当前稀疏检出中不存在，`git show` 也被环境拒绝 records-path；已提交的 plan-claims 答案无法读取，因此不能确认其中没有超过 8 个位置或跨文件拼接的旧引文；没有实际运行测试。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变本 PR 所涉及的产品/复核请求的请求开头。`plan-claims.mjs` 是模型回答之后的离线检查器，不参与 `buildPrompt`；`buildPrompt` 的固定部分、系统提示、工具定义和历史没有被这次增量修改，`head/base/previous` 仍然只出现在材料（请求末尾）里。`delivery-mode.md` 是给执行代理看的操作说明，不在 `buildPrompt` 里，复核探针还明确检查项目指令不会被加载进复核模型请求（`opencode-review.mjs:2503-2509`）。即使某个代理把该说明文件当作新会话的系统提示，按 `.claude/rules/prompt-prefix.md` 第 6 条也只影响新对话，不会改写已经发出的历史。结论：仍然只在末尾追加，每轮变化的值仍在最后一条消息里。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   没有新增这种来源。新逻辑没有时间、日期、随机数、哈希或服务方信息；`texts` 的遍历顺序由 `location` 中的位置顺序决定，输入相同则输出相同；`too-many-places` 等错误字符串也是确定的。`delivery-mode.md` 新增的是静态文字（含固定日期），不会按请求变化；第 9 轮记录里的 `at` 时间戳是账本数据，不进入请求。没有发现遮盖规则、集合顺序或序列化格式的新不确定性。

3. **有没有对应的自动检查，反向用例在旧代码上真的会失败吗？**
   有。`test/tooling/plan-claims-gate.test.mjs` 新增了经 `assertReviewed` 的端到端用例和 `locationsOf`/`quoteInText` 用例。按旧代码（8fd3096）逐条核对：
   - `locationsOf("a.mjs:3,/etc/passwd:1")`、`locationsOf("a.mjs:3,../x.mjs:1")`：旧代码在尾部坏位置时返回已解析的部分 `[{ path: "a.mjs", line: 3 }]`，新用例要求 `[]`，会失败，是真反向用例。
   - 跨文件拼接：旧代码把 `[...texts.values()].join("\n")` 后匹配，`${REDACTION}:3,code.txt:1` 的 `CODE_LINE / feature` 会被接受；新用例要求 `code-quote-not-in-file`，会失败，是真反向用例。
   - 9 个位置：旧代码没有 `MAX_EVIDENCE_PLACES`，会接受并通过；新用例要求 `too-many-places`，会失败，是真反向用例。
   - 第二个文件不存在、行号越界：旧代码本来也会拒绝，这些用例在旧代码上通过，不是新行为的反向用例，只是回归保护。
   - `quoteInText("foo();；bar();", ...)` 两段各 6 个字符：旧代码已经用 `>= 8` 判定，返回值也是 `false`，所以它在旧代码上**通过**，不是反向用例，只是防止把 `EVIDENCE_MIN_CHARS` 降到 8 以下的守卫。另外，`quoteInText` 的 `…` 分支对每段只要求 `>= 4`，两段 6 字符用 `…` 连接仍会被接受；这与 `model-review.md` 写的“每段至少 4 个字符”一致，但如果作者想表达“任何两段 6 字符都应失败”，测试和实现都没有覆盖 `…` 路径。
   - 未测试：恰好 8 个位置仍应通过；测试未实际运行（工具限制），以上结论来自逐行对照新旧实现。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `too-many-places`：产生于 `plan-claims.mjs:186`，只被拼进 `claims-evidence <ADR> <模型> <序号> <原因>`，再由 `assertReviewed` 的通用 `problems` 列表输出为 `REVIEW_NOT_CURRENT`/退出码 5（`opencode-review.mjs:1519-1539`）。没有发现按固定原因枚举解析的下游，测试也按字符串精确匹配，使用端能接受。
   - `MAX_EVIDENCE_PLACES`：模块内常量，只在 `claimEvidenceProblem` 使用，没有外部使用端。
   - `EVIDENCE_MIN_CHARS`：在 `plan-claims.mjs:144`、`:163`、`:345` 使用，三处语义一致（至少 8 字符）；这次只是替换了硬编码的 `8`，行为不变。
   - `locationsOf` 的返回值语义：使用端只有 `claimEvidenceProblem` 和测试；新增“任一位置坏就返回 `[]`”后，非 `找不到` 的 CLAIM 会得到 `location-missing`，仍会被拒绝；`找不到` 且零位置本来就允许，所以没有被绕过。
   - 文件/文档这一侧：`model-review.md` 没有接受新语义（finding 3）；`delivery-mode.md` 的临时例外没有被 `merge-queue.mjs` 接受（finding 1），并且“Main confirmation 兜底”对队列合并不成立（finding 2）。这些不是同一个值的类型问题，而是规则与使用端不一致。
   - 未核实：本 PR 自己的历史 plan-claims 答案是否包含超过 8 个位置或跨文件引文。新规则会把它们报成 `too-many-places`/`code-quote-not-in-file`（不会静默放行），但可能让这个 PR 自己的 `--assert-reviewed` 被旧答案挡住；当前稀疏检出无法读到这些答案。
