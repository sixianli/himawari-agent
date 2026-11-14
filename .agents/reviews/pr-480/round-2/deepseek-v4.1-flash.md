## 结论概览
核心逻辑（`assertReviewed` 抽出 `lowFixChecker`、开跑前接入 `previousProblem`）我没有发现会改变模型请求或导致错误放行的高严重度问题；主要问题集中在反向测试没有覆盖 `main()` 的接线、错误提示的先后顺序，以及说明文档和代码不一致。

## 读代码证实的问题

### 1. 中 — 开跑前的 low-fix 重核在入口层没有被反向测试覆盖
- 文件:行：`test/tooling/opencode-review-merge-gate.test.mjs:1615`、`scripts/model-review/opencode-review.mjs:3301`
- 问题：新增用例都是自己创建 `lowFixChecker` 后直接调用 `previousProblem`，入口用例只验证“错误 `--previous` 会被拒”。如果 `main()` 把 `lowFixCheck` 换回 `() => []`（即重新信任 low-fix 记录），现有测试仍会全绿，但本轮最重要的修复就悄悄失效了。
- 证据：
  - `test/tooling/opencode-review-merge-gate.test.mjs:1615` `const lowFixCheck = lowFixChecker({...})`
  - `test/tooling/opencode-review-merge-gate.test.mjs:1622` `previousProblem({ records, round, head, previous, isAncestor, lowFixCheck })`
  - `test/tooling/opencode-review-merge-gate.test.mjs:1733-1741` 入口用例只测了 `f.ledgerCommit`，该场景无论 low-fix 是否重核都会报 `chain-broken`。
  - `scripts/model-review/opencode-review.mjs:3301-3306` 是 `main()` 真正的接线处。
- 建议：加一条入口级反向用例：把 low-fix 记录的 `findings` 改成 `["V9"]`，运行 `--previous <low-fix head>`，断言退出码 2、stderr 含 `chain-already-broken ... findings-differ`、stdout 不含 `REVIEW_PID`。这样把 `main()` 改成信任 low-fix 时测试会失败。`docs/incidents-and-gates.md:133` 里“把 low-fix 重核换成直接信任……用例失败”的说法目前只对函数级用例成立。

### 2. 低 — `round-previous-differs` 排在整条链检查之前，给出的 `use=` 可能自相矛盾
- 文件:行：`scripts/model-review/opencode-review.mjs:1409-1424`（同轮检查）与 `1425-1433`（链检查）
- 问题：如果更早的 low-fix 记录不合格（链已断），而当前轮已经有一条 `ok` 记录用了 `previous=X`，那么：
  - 不传 `--previous` → 先命中 `round-previous-differs ... use=--previous X`；
  - 照做传 `X` → 再命中 `chain-already-broken ... use=no-previous`；
  - 再改传 `no-previous` → 又命中 `round-previous-differs`。
  同一个轮次无法按提示通过，只能新开一轮。提示会让人来回试。
- 证据：`1409-1423` 的同轮判断在 `1425` 的 `walkChain` 之前无条件执行；`1424` 的 `if (!previous) return null` 也在其后。
- 建议：先确认“更早的链是否可接受”，再决定是否用同轮 `previous` 约束；或在检测到 `walkChain` 已断时直接优先返回 `use=no-previous`，并提示需要换新轮次。

### 3. 低 — 说明文档里“替补后手工重跑 DeepSeek”的命令仍然不带 `--previous`
- 文件:行：`.agents/instructions/model-review.md:60`
- 问题：文档给出的命令是 `--round <这一轮> --models deepseek-v4.1-flash --approved-usd <美元>`。但替补记录带着原来的 `previous`，`main()` 现在会以 `round-previous-differs` 拒绝不带 `--previous` 的补跑；即使绕过这一步，`roundForRun` 的 prompt 摘要检查（`scripts/model-review/opencode-review.mjs:1889-1910`）也会因 `previous` 变了而报 `ROUND_PROMPT_MISMATCH`。
- 证据：
  - `.agents/instructions/model-review.md:60` 的命令没有 `--previous`。
  - `scripts/model-review/opencode-review.mjs:1410-1423` 要求同轮 `--previous` 一致。
  - `scripts/model-review/opencode-review.mjs:1889-1910` 对 prompt 摘要做一致性校验。
- 建议：把命令补成 `--round <这一轮> --previous <这一轮已有结果用的 previous> --models deepseek-v4.1-flash --approved-usd <美元>`，并说明替补记录也受同轮一致性约束。注意这行不是本轮改的，属于本轮新增约束暴露出来的旧文档问题。

### 4. 低 — `claimsProblems` 在每次代码复核前都完整跑一遍，且结果只取 `files`、丢弃 `problems`
- 文件:行：`scripts/model-review/opencode-review.mjs:3282-3293`、`scripts/model-review/plan-claims.mjs:207-226`
- 问题：对于不新增 ADR 的 PR，`claimsProblems` 只做一次 `merge-base` 和一次 `git diff --name-only --diff-filter=A -- docs/adr`，开销可忽略；但只要 PR 新增了 ADR，它就会把合并门前整套 claims 校验（遍历 `topic-*/usage.jsonl`、读答案 blob、解析 claims 和 claims-verdicts）在花钱之前再跑一遍，并且 `problems` 被直接丢弃——既慢又不会在这里给出有用的失败原因。正常输入下它不容易抛错（`addedAdrs` 在 `merge-base` 失败时返回 `[]`，解析错误都被 `try/catch` 吞掉），但这是一次重复劳动。
- 证据：`3284-3293` 只使用 `.files`；`plan-claims.mjs:208-211` 在无 ADR 时提前返回，`213-226` 会读取全部 topic 账本。
- 建议：只有在“确实需要重核某条 low-fix 点”时才计算 `skip`，例如先算出 `coveragePoints(records)` 中是否存在 low-fix 点；或单独抽一个只返回 `claimsProblems.files` 的轻量函数，避免在预检阶段重复完整校验。

### 5. 低 — 开跑前与合并门的低修复重核不在完全相同的上下文里（遮盖与 `mainRef`）
- 文件:行：`scripts/model-review/opencode-review.mjs:1372-1406`、`2746-2752`、`3204-3210`、`3220`、`3288/3304`、`1509`
- 问题：
  - `lowFixChecker` 用 `maskSecretLike` 比较文件名和 verdict id，而 `maskSecretLike` 依赖模块全局 `registeredTestValues`。正常复核路径在 `3220` 先调用 `registerTestValuesFromRefs`；`--assert-reviewed` 在 `3204-3210` 提前返回，从未注册。因此同一条 low-fix 记录可能在开跑前和合并门被不同地遮盖后再比较。
  - `main()` 的预检把 `mainRef` 固定为 `origin/main`，而 `assertReviewed` 可以通过 `--main-ref` 改。代码复核不接受 `--main-ref`，但 `--assert-reviewed --main-ref X` 可以，此时两边重核用的 `mainRef` 不同。
- 证据：`3220` 注册测试值；`3204-3210` 提前返回；`3288`、`3304` 硬编码 `"origin/main"`；`1509` 的 `assertReviewed` 接受 `mainRef`。
- 建议：让两侧使用同一份上下文（例如在 `assertReviewed` 里也按同一组 ref 注册测试值，或让 `lowFixChecker` 显式接收遮盖所需的注册值）；合并门和预检对 `mainRef` 至少要有明确约定并在文档里写清差异。实际触发需要文件名或 verdict id 恰好命中 gitleaks 白名单字面量，概率很低。

## 推测 / 未核实

### V1（工作区账本 vs HEAD 账本）的判词无法核对
- 仓库是 sparse checkout，`.agents/reviews/` 被排除，且记录路径的 `git show` 被环境拒绝，读不到 `round-1/judgments.md`，所以作者“判不成立”的理由**未核实**。
- 从代码看差异确实存在：预检用工作区账本 `readUsage(options.out)`（`scripts/model-review/opencode-review.mjs:3253`），合并门用 `HEAD:` 里的账本（`1512-1513`）。如果刚用 `--accept-low` 追加的 low-fix 记录没有提交，预检会看到它并通过，而合并门在 HEAD 里看不到它，链会断；钱已经花掉，正是本轮想避免的情形。
- 我的看法：这个差异本身是真实的，但工作区账本可能是为了支持“刚写完 low-fix、还没提交就要跑下一轮”的流程。如果作者的理由是“提交账本后两边一致、预检只是尽力而为”，可以接受；但代码并没有强制“工作区账本 == HEAD 账本”。建议至少在预检时检测工作区账本和 HEAD 不一致就拒绝并提示先提交，或明确把它写成已知限制。

## 侧重检查
- 错误路径：`previousProblem` 在 `opencodeBinary`/`installGateway`/`prepareCopy` 之前调用（`3282` 早于 `3310`、`3316`、`3334`），拒绝时不花钱，退出码由 `main().catch` 设为 2，符合文档。`lowFixProblems` 在 `git diff` 失败时会抛 `GIT_FAILED`，不是 `REVIEW_PREVIOUS_REFUSED`，但仍发生在花钱之前；这是可控但不够友好的错误路径。
- 不合规范/不可信输入：`parseUsage` 对 low-fix 记录强制 `from` 是 commit、`head` 是 commit、`files`/`findings` 是非空字符串数组（`1798-1808`），所以 `sameList` 不会碰到 `undefined`；`previous` 没有格式校验，但只用于 `git merge-base` 参数和错误提示，`singleLine` 会拒绝换行（`1831`），不会造成日志多行注入。整体是“失败关闭”，没有发现可利用的写入或花钱绕过。
- 安全：本轮没有新增写文件、网络或不可逆操作；`claimsProblems` 和低修复重核都是只读 git 操作。
- 资源：`claimsProblems` 的重复开销见问题 4；`lowFixChecker` 对每个 low-fix 点会重复执行 `git diff` 和逐文件 `unreviewedFiles`，low-fix 点很多时会变慢，但规模受账本限制，未见无界循环。
- 规则/文档一致性：步骤 3 的新措辞与代码一致（`REVIEW_LOW_FIX … head=` / `REVIEW_CURRENT … reviewed=` 都能得到 low-fix 的 `head`）；不一致的是问题 3 的替补重跑命令，以及问题 1 中 I-98 对“入口接线”的反向证据描述。

## 必答问题
1. **不会改变模型已经见过的请求开头。** 本改动只碰 `lowFixChecker`、`previousProblem` 和 `main()` 的前置拒绝；`buildPrompt`（`scripts/model-review/opencode-review.mjs:345-367`）没有改。拒绝路径不会发请求；正常路径下模型收到的仍是与 18d0756 相同的单次 prompt，`previous` 本来就在同一条 prompt 里。该脚本没有多轮历史，所以“只在末尾追加、每轮变化值在最后一条消息”这条规则不受影响（本次未涉及）。
2. **不会让模型可见的同一段文字变成不同字节。** 新增输出只有 stderr 的 `REVIEW_PREVIOUS_REFUSED` 和内部比较结果，不进入模型请求。内部确实存在上下文依赖的遮盖（`lowFixChecker` 依赖全局 `registeredTestValues`，预检注册、合并门不注册）以及 `mainRef` 固定值差异，见问题 5；它只影响文件名/verdict id 的比较，且需要命中 gitleaks 白名单字面量才可能触发。
3. **有自动检查，但覆盖不完整。** 现有五条 `[I-98]` 用例；我逐条推演确认：去掉同轮检查时“同轮补跑”用例会失败，把 low-fix 重核换成信任时“链已断或 low-fix 不合格”的函数用例会失败，去掉 `main()` 调用时入口用例会失败。但入口层没有覆盖“`main()` 是否真的传入 `lowFixChecker`”，所以把 `main()` 改成信任 low-fix 时所有测试仍会通过（问题 1）。另外，同轮检查与链已断的先后顺序、替补/失败记录路径也没有专门用例。
4. **新增和修改的值逐项核对：**
   - `round-previous-differs`、`use=...`：只被测试和文档使用，未发现机器解析方；现有期望字符串已同步。
   - `chain-already-broken` 末尾新增 `${broken.problems.join(",")}`：前缀不变，测试已更新，没有其他消费者。
   - `previousProblem` 新增必填参数 `lowFixCheck`：仓库内两个调用点（`main` 和测试）都已传；没有外部调用者，但按旧签名调用会在遇到 low-fix 点时抛错。
   - `skip` 来自 `claimsProblems().files`：两边都用 `Set` 接收，类型一致；预检与合并门在 `mainRef` 和遮盖上下文上不完全一致（问题 5）。
   - `--previous` 的取值来自 `resolveCommits` 的完整 SHA，写入账本也是完整 SHA，`sameRound` 的比较两端格式一致；手写的短 SHA 记录会被判为不同，但这类记录本来就不受信任。
