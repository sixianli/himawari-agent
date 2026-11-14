## 发现（按严重度从高到低）

### 中 — 预检读的是工作区账本，合并前检查读的是 HEAD 里的账本
- 文件：`scripts/model-review/opencode-review.mjs:3234`、`1146-1149`、`1459-1461`、`2974`、`3263-3273`
- 问题：`previousProblem` 用的 `records` 来自工作区文件，而 `assertReviewed` 用的是 `HEAD:<ledger>/usage.jsonl`。两者不一致时，预检可能放行一次之后合并门仍会拒绝的复核（钱照花），也可能反过来误拒合法的 `--previous`。
- 证据：
  - `3234: const records = options.selfCheckOnly ? [] : readUsage(options.out);`
  - `1147: const path = join(out, "usage.jsonl");`
  - `1460: const shown = gitStatus(["show", \`HEAD:${ledgerPath}/usage.jsonl\`], repo);`
  - `2974: options.out = reviewDir(options.repo, options);`
- 具体风险：`--accept-low` 刚把 low-fix 记录追加到工作区但还没提交时，预检能看到它并放行 `use=--previous <low-fix head>`；合并门从 HEAD 看不到这条记录，链仍会断。反过来，HEAD 有记录而工作区没有（切分支、`--head` 指向未检出的分支）时会误拒。
- 建议：预检也从 `commits.head` 读账本（例如抽一个 `readUsageAt(repo, head, out)`），或在读工作区账本后强制核对它与 `HEAD` 版本一致，不一致就报明确的错误；至少不要把“本地账本”与“合并门会看到的账本”当成同一份。

### 中 — 预检完全跳过 low-fix 记录的重新校验
- 文件：`scripts/model-review/opencode-review.mjs:1375-1378`、`1476-1508`、`1510-1517`
- 问题：预检把 `lowFixCheck` 固定成 `() => []`，只检查 low-fix 的 `from`/`head` 连接关系，不检查 `files`、`findings`、`verdicts`、测试文件等。手写或不合格的 low-fix 记录会被当成已接受点，`use=--previous ${covered}` 给出的也可能是合并门根本不认的提交。
- 证据：
  - `1377: lowFixCheck: () => [],`
  - `1476-1478: const lowFixCheck = (point) => { const check = lowFixProblems({...`
  - `1512-1517: chainProblems = broken ? ... "low-fix-invalid" ...`
  - `docs/lessons.md:759` 已把它写成已知限制：“开跑前只信任账本里 low-fix 记录本身……手写的、不合格的 low-fix 记录仍要到合并前检查才被拒。”
- 影响：这类记录仍然会让预检放行、真正花钱，然后合并门报 `low-fix-invalid`，与 I-98 要解决的问题同类。
- 建议：把真正的 `lowFixCheck`（需要 `repo`、`ledgerPath`、`mainRef`、`skip`）传给 `previousProblem`；如果坚持“信任账本”，至少在预检里检测“存在未经合并门复算的 low-fix 记录”，提示先跑 `--assert-reviewed` 再花钱，并且不要把未复算的 low-fix head 说成“该传的提交”。

### 低 — `--round N` 只看 N 之前，和 `assertReviewed` 的全量 `coveragePoints` 不完全等价
- 文件：`scripts/model-review/opencode-review.mjs:1372`、`1320-1326`、`1857-1867`；测试 `test/tooling/opencode-review-merge-gate.test.mjs:1661`
- 问题：预检过滤掉本轮及之后的所有记录，但本轮已经存在的 `ok` 记录在 `assertReviewed` 里仍会参与 `coveragePoints`。如果同一轮已有其他模型的 `ok` 记录，而补跑模型传了不同（或未传）的 `previous`，合并门的 `previous` 会变成 `""`，判 `chain-broken`；预检却看不到这些同轮记录而放行。
- 证据：
  - `1372: const earlier = records.filter((record) => (record.round ?? 1) < round);`
  - `1320: const previous = [...new Set(covering.map((record) => record.previous ?? null))];`
  - `1326: points.push({ round, head: heads[0], previous: previous.length === 1 ? previous[0] : "", by });`
  - `1857-1867` 的 `roundForRun` 只拒绝“本次要跑的模型”已有 `ok` 结果，不拒绝同轮其他模型的 `ok`。
- 另外，测试 `1661: expect(ask(f.fixed, 2)).toBeNull();` 所用的记录里第 2 轮已经有 deepseek 的 `ok` 记录，真实运行时 `roundForRun` 会先报 `ROUND_ALREADY_HAS_RESULT`，所以这条用例并没有证明补跑路径真的可用。
- 建议：补跑时除“N 之前各轮”外，再核对本轮已有 `ok` 记录的 `previous` 是否一致；或在预检里模拟“加入本轮新记录后的完整 `coveragePoints`”。至少补一条“同轮已有 ok 记录且 previous 不同”的反向用例。

### 低 — 测试没覆盖 `head-not-after-accepted`，反向验证的说法也不够精确
- 文件：`scripts/model-review/opencode-review.mjs:1384-1385`；测试 `test/tooling/opencode-review-merge-gate.test.mjs:1617-1716`
- 问题：四条拒绝原因里，`head-not-after-accepted` 没有任何测试；入口用例只覆盖 `chain-broken`。此外，如果只撤掉 `main()` 里的调用（`3263-3273`），两个直接调用 `previousProblem` 的测试仍然会通过，所以“撤掉检查后三条都失败”只有在同时去掉/绕过函数逻辑时才成立。
- 证据：
  - `1385: return \`REVIEW_PREVIOUS_REFUSED head-not-after-accepted ${covered} head=${head} use=no-previous\`;`
  - 测试 `1628-1638` 覆盖 `chain-broken`，`1657-1661` 覆盖 `chain-already-broken`，入口 `1701-1709` 只测 `chain-broken`。
- 建议：补 `head-not-after-accepted`、经脚本入口的 `no-accepted-round`、以及“合法祖先 `--previous` 经入口也能通过”的用例；反向验证时明确记录撤掉的是“函数逻辑”还是“main 调用”。

### 低 — 文档里 `REVIEW_CURRENT … reviewed=` 的说法容易误解
- 文件：`.agents/instructions/model-review.md:59`；`scripts/model-review/opencode-review.mjs:1546-1549`、`1613-1615`
- 问题：文档说“传 `--assert-reviewed` 打印的 `REVIEW_CURRENT … reviewed=` 那个提交，也就是 low-fix 记录的 head”。但 `--accept-low` 当次调用打印的是 `REVIEW_LOW_FIX round=… head=…`；`REVIEW_CURRENT` 是在追加 low-fix 记录之前算好的，只有提交账本后再跑一次 `--assert-reviewed` 才会把它显示为 `reviewed=<low-fix head>`。
- 证据：
  - `1546-1549`：`REVIEW_CURRENT`/`REVIEW_NOT_CURRENT` 在 low-fix 处理之前构造。
  - `1613-1615`：`--accept-low` 当次打印 `REVIEW_LOW_FIX round=… from=… head=…`。
- 建议：把文档改成“提交账本后再跑 `--assert-reviewed` 的 `REVIEW_CURRENT reviewed=`，或 `--accept-low` 当次打印的 `REVIEW_LOW_FIX head=`”。

## 侧重检查

- 错误路径：`main().catch` 在 `3498-3501` 打印错误并以退出码 2 结束；`previousProblem` 的拒绝发生在 `opencodeBinary()`（`3274`）、`prepareCopy()`（`3298`）之前，作者“装 opencode、建副本、跑模型之前”的说法成立（已读代码证实）。
- 不合规范/不可信输入：生产路径里 `previous`/`head` 都经 `resolveCommits` + `git rev-parse --verify …^{commit}` 变成提交号；账本里的 `head`/`from` 由 `parseUsage` 的 `COMMIT_PATTERN` 校验（`1775-1789`、`1813-1826`），`round` 是正整数。错误信息里没有未经验证的自由文本，生产路径下不存在把换行/控制字符注入提示或日志的问题（直接调用导出函数的场景不受这些校验保护，但生产不使用）。
- 安全：预检前只有 `readUsage`、`git merge-base`、读取 brief/questions 等只读操作，没有写文件或装包；不会在拒绝时留下半截记录。
- 资源耗尽：`coveragePoints` 仍是按轮次多次扫描记录，`walkChain` 每个点可能启动一次 `git merge-base`；账本由本地线程维护，不是远程不可信输入，新增开销有限。
- 不可撤销操作：拒绝发生在任何模型调用、副本创建和账本追加之前；未发现新的不可撤销副作用。
- 规则/文档一致性：`prompt-prefix` 相关代码没有改动；I-98 描述的主流程与代码基本一致，但存在上面“工作区账本 vs HEAD 账本”“low-fix 不复算”“同轮补跑”三处不一致。三个 PR 分支的真实账本和“重放三次”的说法我无法在本仓库核实。

## 读代码证实的 vs 推测

读代码证实：

- `previousProblem` 的实现、调用位置和退出码路径（`1370-1387`、`3263-3273`、`3498-3501`）。
- 预检读工作区账本，`assertReviewed` 读 `HEAD` 账本（`3234`/`1146-1149` 对 `1460`）。
- 预检把 low-fix 校验固定为空，合并门会重新算 `lowFixProblems`（`1377` 对 `1476-1508`）。
- 同轮记录被 `< round` 过滤，`coveragePoints` 会用同轮所有 `ok` 记录合并 `previous`（`1372` 对 `1320-1326`）。
- `buildPrompt` 的固定部分与材料/`previous` 的位置没有变化（`345-374`）。
- 测试实际覆盖的拒绝原因，以及 `head-not-after-accepted` 没有测试（`1617-1716`）。

推测：

- “工作区账本与 HEAD 不一致”会导致真实场景中的误放行或误拒；具体是否常见取决于线程是否总在提交账本后再跑下一轮。
- “同轮已有其他模型 ok 记录”导致预检漏判的具体触发概率；我构造了机制，但没有用真实分支账本重放。
- 作者说的三个 PR 分支账本、历史提交号和“撤掉检查后三条都失败”的具体证据，未核实。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动只新增了 `previousProblem` 和 `main()` 里的预检，没有改 `buildPrompt`。固定部分仍在 `350-361`，资料块仍在 `362-374`，`previous` 只出现在资料块里的 `366-367`，属于最后一条用户消息。系统提示、工具定义、历史消息、遮盖结果都没有变化；拒绝时甚至不会发出请求。结论：仍然只在末尾追加，每轮会变的值仍在最后一条消息里。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响模型输入字节。新增的只是错误字符串（`REVIEW_PREVIOUS_REFUSED … use=…`），由账本里的提交号和轮次决定，没有时间字段、没有无序集合的序列化，也不会进入 prompt 或遮盖逻辑。需要注意的不是“字节不确定”，而是预检结果依赖工作区账本状态，同一命令在不同未提交状态下可能给出不同结论。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有测试，但不完整。`[I-98]` 覆盖了函数级 `chain-broken`、`no-accepted-round`、`chain-already-broken` 和脚本入口的 `chain-broken`；`head-not-after-accepted` 没有用例，入口也没测 `no-accepted-round` 和“合法祖先 previous”。反向验证只在“绕过/删除函数逻辑”时能保证三条都失败；如果只删除 `main()` 里的调用，只有入口用例会失败。建议补齐上述分支后再声称三条反向用例都覆盖了检查和接线。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   新增的值只有：
   - 错误前缀/原因：`REVIEW_PREVIOUS_REFUSED`、`chain-already-broken`、`no-accepted-round`、`head-not-after-accepted`、`chain-broken`，以及 `use=--previous <提交>` / `use=no-previous`。使用方只有文档、测试和人；没有机器解析器，退出码 2 与 `main().catch` 一致，能接受。
   - `previous`/`head`/`covered`：生产路径都是 git 解析出的完整提交号或 `parseUsage` 按 `COMMIT_PATTERN` 校验过的账本 `head`，放进错误信息安全；`round` 是正整数。
   - 没有新增账本字段、配置键或清单项，因此不存在 I-73 那种“清单 id 过不了后端校验”的新面。

   但语义上有三处使用方不能完全接受：预检的账本来源不是合并门的来源（发现 1）、low-fix 记录没有经过合并门同等的校验（发现 2）、补跑时同轮已有记录可能让 `use=--previous <covered>` 实际上仍接不上（发现 3）。
