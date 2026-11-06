现有事实我已经读够了。接下来查几个业界一手来源，然后写方案。
# 方案：把「政策修订」从逐次迁移代码改成一次性的、可核验的字节级授权记录

## 一、前提（先读代码/文档证实，后标注）

**已核实的前提**

1. **报错机理**：`scripts/ci/check-policy.mjs:43-51` 里 `timeoutMinutesFor` 把期望时限写死在代码里；`validatePolicy` 第 169 行断言 `check.timeoutMinutes === timeoutMinutesFor(check.id)`。`main()` 第 1125-1132 行先用 base（目标分支）的政策 bytes 构造 `source.policy`，再用 PR 里的新代码去 `validateWorkflow(source.policy, …)`（内部第 227 行会先 `validatePolicy`），于是 timed-out 的旧政策被新代码拒绝，报的正是材料里的 `Unexpected timeout: policy`。只要 PR 改动时限，这条检查在旧政策上必然失败；新增/删减检查、改变成员同样会撞上 `Incomplete matrix`/`Unexpected policy DAG` 等断言。
2. **合并后第一次 main 运行的失败点**：`scripts/ci/context.mjs:109-111`，`push` 事件的 `baseSha = commit(payload.before)`；且 `run.mjs:86`、`test.mjs:27`、`aggregate.mjs:285`、`required.mjs:20`、`export-evidence.mjs:113`、`security-exceptions.mjs:198`、`check-coverage.mjs:523` 全部以 `context.baseSha` 读「已接受政策」。合并一次规则修改后，整个 main 首次运行都在用「昨天的规则」跑「今天的代码」。
3. **原设计意图**：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:115`（原话已列）；`:225`「基线和例外默认读取目标分支受保护版本；同一 PR 不能自行降低阈值使自身通过」——防放宽靠的是「和 base 的比较」，靠的不是「用新代码校验旧政策」；`:242` 已存在一个成熟的「Owner 精确清单审批」先例（`.github/security-review-manifest.json` + PR 评论 + GitHub API 核对所有者身份/PR/head/清单字节摘要/≤30 天有效期），实现在 `scripts/ci/security-owner-review.mjs:113-307`。
4. **信任边界的自认限制**：spec 第 280 行：「同仓库 writer 及外部 PR 都能提议修改 workflow、政策和汇总器，绑定 GitHub Actions 来源不能证明执行逻辑未被修改。当前采用可信 Owner 审阅这一边界」。即：**门禁 保护的是“未经 Owner 记录的放宽”，不保护“Owner 本人账号做的事”**——这是 Andy 已接受的边界，不是我新加的。
5. **合并今日不等 CI**：`AGENTS.md:7`「在 Andy 决定规则集要求 `ci/required` 之前，合并不等 CI 结果」。所以本方案的现实强制力=本地快速检查 + AI 线程约束， писать 补充回忆：方案必须让「快速检查」阶段就能发现非法政策修改（不是等到 required）。
6. **三次迁移是结构性教训**：`resolvePolicySource` 里的 `upgradeHostedRunnerPolicy`（`check-policy.mjs:53-72`，被 `981` 行调用）、`integrationWorkerLimits` 升级（986-996）、coverage 旧值兼容（`allowLegacyCoverage`，78-84、156、173-174，由 `982-983` 行传参）；ADR 0160 决定 6 承认这段代码「合入后不会再生效，但会一直留着」。设计文档第 142 行也承认这类一次性迁移是既有做法的一部分。
7. **业界核对（一手来源）**：
   - GitHub 官方《Troubleshooting required status checks》：required 检查必须对最新 commit 通过、必须由 `pull_request`/`push` 等「有 check 语义的事件」产生——与本方案改动「事件语义」无关，兼容。https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks
   - GitHub 官方《About commit signature verification》：网页端提交会被 GitHub 用 web-flow 公钥（`github.com/web-flow.gpg`）自动 GPG 签名并标 `Verified`，API 也核实 `verification` 字段——这是「授权命令是否真的是 Andy 本人所下」目前唯一便宜可靠的独立因子。https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
   - GitHub 官方《Secure use reference》：`pull_request_target`/`workflow_run` 若 checkout 未审 PR 代码/挂写权限是仓接管型漏洞，「Good practices: Avoid using pull_request_target」。https://docs.github.com/en/actions/reference/security/secure-use 和 https://securitylab.github.com/research/github-actions-preventing-pwn-requests/
8. **测试基建已在**：`test/tooling/policy.test.mjs` 有真 git 仓库夹具（213-229 行）和负向样例风格（`it.each` 拒绝用例），能覆盖本方案的正反验证；`test/tooling/security-review.test.mjs` 已有评论审批负向样例先例。

**推测/未核实的标注**

- `evaluateCoverage`（`check-coverage.mjs:562` 附近）对 proposed vs accepted 的具体放宽判定逻辑未逐行读，后面实现时需核校（见风险 R6）。
- `main-evidence` 的轻量确认聚合逻辑具体在 merge 后如何比 base/head/testedSha（`:159` 只是定位点）未全读；我按「identity 不动」的设计回避它，实作时仍需验证。
- GitHub 现行 Rulesets/required-workflows 细节未查（与方案无依赖）；CODEOWNERS 结论按通用认知（单人仓库同账号不可分身），未查专门页，标注为推定性判断而非引用来源。

## 二、方案本身

### 核心思想一句话

**把「哪份政策在管这次运行」从「base 分支的旧政策」改成逐事件语义明确的两份读取，并用一条字节级、只对那一次.firebaseapp 精确改动的 Owner 授权记录，取代所有一次性迁移代码。**

（以下用「治理政策」=本次运行实际执行检查用的政策；「对比基线」=防放宽的比较来源。）

1. **治理政策**：
   - `pull_request`：若 checkout（head/merge）里 `ci/policy.json` 字节与 base 相同 → 治理=base 政策（照旧语义）；字节不同 → **必须存在 Owner 授权记录**（见 2），治理=PR 里的新政策（用现有 `validatePolicy` 严格校验）。
   - `push`（main）：head=`after`；同样公式。合并进 main 的 PR 已经把授权记录带进 main，故首推即自洽；**直接对 main 推送的政策修改、或 legacy base 遇到跨结构代码**同样适用本公式——统一逻辑而不是补丁。
   - 新增未被任何已存在政策定义的 job 的情形（比如以后加 `scale` job）也在这个公式下统一：授权记录 + 治理=PR 政策。
2. **Owner 授权记录（可核验、精确到字节）**：
   - 新文件 `.github/policy-change-manifest.json`（提交在候选分支里）：`schemaVersion`、`repository`、`pullRequest`、`sourceHead`、**逐文件条目 `[{path, fromSha256, toSha256}]`（强制按路径排序、去重——仿 `parseTestHygieneBaseline`：`check-policy.mjs:816-821`）**、`reason`、`expiresAt`。
   - 新文件 `.github/policy-change-comment.json`（只存评论 id，仿 `.github/security-review-comment.json`）。
   - 校验完全复用 `security-owner-review.mjs` 的既有合同：固定 HTTPS API 读评论、Coach Andy 数字身份 (id 30715326)、评论内固定 v1 JSON 块绑定 `pullRequest`+`sourceHead`+`manifestSha256`、`expiresAt ≤ 30 天`、`sourceHead` 是 head 的祖先、`pull_request` 事件数与 head 必须匹配（security-owner-review.mjs:148-159, 162-201, 对应经验证逻辑）。**Entries 必须恰好等于「治理文件中 from≠to 的那些字节变化」，一模一样；多一条/少一条都拒绝**（对齐 `applyMachineReview` 的精确数量原则，security-owner-review.mjs:310-329）。治理受控文件集合初期=`ci/policy.json`；是否包含 `ci/coverage-policy.json` 见根问题 4 的拍板项。
3. **取消所有「用新代码校验旧政策」的线性残留**（这不仅是 PR 259 的偶发问题，也是 `source.policy` 与 `validateWorkflow`、`validateVitestProjects`（check-policy.mjs:1132、1140）那种「跨时代混合」的通病）：
   - 删掉 `resolvePolicySource` 里对 base 政策的整段 `validatePolicy(upgradeHostedRunnerPolicy(...))`、integration 升级块、coverage 兼容分支，以及 `upgradeHostedRunnerPolicy`、`allowLegacyCoverage`、`allowLegacyIntegration`、`hostedTimeoutMinutesFor`。
   - base 政策**只作为身份与对比基线**：`policySha256`、test-hygiene baseline、coverage accepted、security exceptions——这些语义本来就「和 base 比」，保留原样；`context.policySha256` 继续只算 base bytes 的哈希，`check-coverage.mjs:524-527` 的 `assert` 不动。
   - 所有「结构性」消费者（`run.mjs` 的 selectCheck/event、`test.mjs`、`aggregate`、`required`、`export-evidence`、`policy` 的完整 `check-policy main()`）从治理政策读。
4. **顺手的结构修正**：时限值不再写死在 `check-policy.mjs` 里，改由 `ci/policy.json` 自带（validator 只校验「workflow 字节与 member/check 值一致」——这条 `check-policy.mjs:306-309` 已具备，只是把期望值改从政策数据取）。这样 PR 259 这类改动只需要动 `ci/policy.json`+`ci.yml`+`main.yml` 三个文件，不再碰 check-policy.mjs 本身。`main.yml` 的 plan/confirm 时限（`main-workflow.mjs:48`，15/90）是另一组独立 job，不属于政策受控值，不动。
5. **时效与记录**：授权评论过期后（>30 天）main push 已合入，`base` 政策就是新政策，治理公式（bytes 相等 → base）自动无需证据继续工作——过期只影响「Delay in 合并之前」的窗口，与安全审批物同一时间语义。
6. **错误码而非注释**：新负向情况全部用稳定错误码（如 `POLICY_CHANGE_UNAUTHORIZED` / `POLICY_CHANGE_SCOPE_MISMATCH` / `POLICY_CHANGECEPTION_EXPIRED` 沿用既有命名风格：现有代码风格一致），满足「不写代码注释」的约束。

### 实施测试一览（含正反用例）

| 用例 | 预期 |
|---|---|
| 合法改时限 + 有效批准评论（使用 `loadOwnerReview` 同款可注入 `readComment` 的测试夹具，甚至复用本地 HTTP 夹具） | 通过。**这也是反向证明旧代码必败的用例：旧代码上同一测试死于 `Unexpected timeout: policy`**（与 PR 259 实际现象吻合） |
| 改政策、无批准/错误评论/错误 head 来源/过期/读取失败 | 分别失败，逐个错误码断言 |
| scope 精确性：manifest 少含一条变更、多含一条无关变更、`fromSha256` 指向其他 base bytes | 失败 |
| 功能 PR 未动政策 | 与现状完全一致（保证无回归）：现有全部 test/tooling/policy.test.mjs 负向样例必须仍通过 |
| main push 直接改政策、无批准记录（绕过 PR 的反例） | 失败——证明 push 公式不因事件差异而疏漏 |
| `upgradeHostedRunnerPolicy` 删除后，旧形状政策只在作为 base 政策被 hash，不再作为治理被捕抓校验 | 正向用例：可用旧时限政策 base+新 checkout 通过构造测试验证不再报 `Unexpected timeout` |

## 三、考虑过但不选的做法

1. **继续加一次性迁移写法（现状/Andy 之前的选择）**：三例证明这条路每改一条字段就要写一段升级/兼容代码，且每次仍会失败一次（PR 259 谁也逃不掉）。ADR 0160 决定 6 也明示了代价。
2. **只删 check-policy.mjs:1132 和:1140 两行（最小 diff）**：能立即缓解，但 run.mjs:86/required/aggregate 的同类问题还在——加一个 job 的话，所有 job 里的 `selectCheck(source.policy=base)` 都查不到；且无授权入口，谁都可以改 `ci/policy.json` 放松自己 → 违反 spec 115/225。部分可取：错误合入面是「cross-era validation」删除是必须的一部分。
3. **改用 `pull_request_target`/`workflow_run` 或把 `context.baseSha` 直接换成 `after`**：前者违反 spec 268 的单人信任边界之外还有 GitHub 官方明确反对的 untrusted-checkout（见前提 7 第三条）；后者对**未带授权记录的直接 push 政策修改放行**，防自放宽的底线没了。
4. **CODEOWNERS + 分支保护要求 Owner review**：单人仓库，唯一 owner 账号同时是代理线程账号，机器上无法区分谁点的 Approve；且 CI 检查仍需要挂载规则集才能阻止——已合并不等 CI（AGENTS.md:7）。不新增保护力，纯摩擦。*.github 相似做法未核实，按现仓库单事例述*。
5. **"逐字段放宽比较器"（自动判断所改动字段是宽不是严）**：正是三次迁移代码的老路；不选。
6. **政策变更按事件用 sha 外的 patch 语义比较**：字节 hash 精确但换一次换行即变一串；本方案已定 entries 逐 equal 路径+hash，兼容 JSON 的写法稳定性需求纳入 manifest 校验（见 Q2）。

## 四、风险与反例

- **R1 无授权的政策改动被拒**——这是预期；错误代码必须Clearly「在 PR 下贴 Owner 批准评论 + 更新引用文件」，避免对用户（Andy 或代理线程）造成困惑。泄给 PR 询问页面的负向用例已在测试表。
- **R2**：使用者若在新政策 merged 后 30 天内再把老政策回换（治好回到 base）会被 base 公式自动允许（bytes 相等）；这走的是「无策略后回重设」，不依赖是否还在期，无新增风险。
- **R3**：**代码边界仍在**——`scripts/ci/check-policy.mjs` 本身也是一个文件；谁都能改它（包括把新增的治理逻辑删掉）后让 gate 跳过。这是 spec 第 280 行已接受的边界（Owner 审阅），本次方案不假装突破它，但 web 流提交作为加强选项（见拍板项）。
- **R4 主推线重报：未影响 identity 语义**——`policySha256` 保留 base-identity 语义，PR/main 两端 524-527 一致性不被打破；轻量确认路径未新增破坏面。
- **R5 治理文件集合隔离有限**：若有人把需要治理的规则放进 `.github/spec-fork`. 或新一处（如把 CI 跟踪规则迁移到别的新文件）而治理列表没同步，新字段里的新文件属于普通代码变更。**需要写进 spec**：治理目录即 `ci/policy.json`（fixed 一个常量数组），新增有其之一就要经本授权。
- **R6 需要实现时核实的点**（我未读到全部细节）：`evaluateCoverage`（proposed vs accepted 的具体放宽/字段语义）、`aggregate.mjs` 在 PR vs push 事件下 report 对齐的精确含义。**未核实**这两处是否需要在治理切换时加特别对齐；实现时按合同读全再动。

## 五、需要人拍板的取舍

1. **授权身份强度**：推荐先沿用评论作者身份（与已有安全审批同账号风险），是否**再加入 web-flow 签名门槛**（Admin 评论约定的 manifest 由网页端由 Andy 本人提交、GitHub 用 `github.com/web-flow.gpg` 自动签名，代理无法伪造）——要 Andy 愿意在真浏览器/网页上为准一次。
2. **是否为「确定性放宽」的白名单**（如「只放宽超时」）走免授权快速通道：推荐不加（每改一次都重定义越界，是三次迁移的老路）；但遵循 spec 115 字面放行、只在触发「门禁自身阻塞」时出（PR-流程 的）「推翻/恢复」条款，则需要；两者都必须写进 spec 才能dő不错乱。
3. **治理文件集合是否扩大到 `ci/coverage-policy.json`**（关键字段有自检，但合并后首推较敏感）。

## 六、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。本改动全部落在 CI 门禁脚本（`scripts/ci/*`）、`ci/policy.json`、`.github/workflows/*` 与新的 `.github/policy-change-*.json` 上，不触碰发给模型的任一要素：系统提示、工具定义、历史消息、遮盖结果的一条字节都不被产出或修改。按 `.claude/rules/prompt-prefix.md` 硬规则1-3，发给模型的内容仍然只在末尾追加；没有任何「每轮会变的值」被本方案引入（CI 侧也不接模型上下文）。既改变 Vet/村庄。结论：**与规则 I-66 完全无冲突，无需任何遮盖或追加语义变更**。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。改动引入的所有新值都是字节级可复现的：`policy.json`、manifest 的 `sha256` 都是对文件字节计算，无时间/顺序依赖；manifest entries 强制按路径排序去重（仿 `check-policy.mjs:816-821` 的先排序后比对断言），避免了「无序集合"每次序列化不同」；`expiresAt` 是作者手写的固定日期字段，校验按固定 schema（`^\d{4}-\d{2}-\d{2}T00:00:00Z$` + ≤30 天，同 `security-owner-review.mjs:199`），不是运行时注入时间。没有引入新的遮盖（遮盖逻辑在本方案路径里不存在，模型侧不涉及）。同一段「评论正文 + manifest bytes」对任何人都解析出同一份 paths/摘要。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
有，全部落 `test/tooling/policy.test.mjs`（已有真 git 夹具与负向样例风格）：
- 正向：合法政策修改 + 有效批准 →通过（同时作为反向证明：同一用例在旧代码上死于 `Unexpected timeout: policy`，错误路径已在 check-policy.mjs:169，材料里也是 PR 259 的真实报错）；
- 反向（会失败）：政策 bytes 改动无批准记录；from/to hash 前后端两端都不能沿用范围内的旧值；scope 不精确（多/少一条）；过期；错误作者；push 直接改政策。反向用例写法同 `parseTestHygieneBaseline` 有严格 schema（ refuse-编码），每-negative-件具报特定 `POLICY_CHANGE_*` 错误码，不合格样例均被拒绝。
都跑在 `policy` 检查内（`run.mjs:242` `vitest(check.projects)` tooling project），属于 `npm run check` 全链路。

**4. 改动产生或修改的每个值，产生处与使用处都能接受吗？**
逐项（双边都核对过，不是只看 diff）：

| 产生/修改的值 | 产生处 | 使用处 | 两端一致吗 |
|---|---|---|---|
| 治理文件的判断（`ci/policy.json` 字节是否与 base 不同） | context/startup（治理计算） | run.mjs:86-87、test.mjs、aggregate、required、export-evidence、check-policy:1125 | 这些消费方都从 `resolvePolicySource` 同机处拿治理政策，无一处拿旧数值 |
| `context.policySha256` | context.mjs（语义不变，仍 base bytes） | check-coverage.mjs:524-527 的 assert、aggregate report 一致、main-evidence | 语义未改，原 assert 不动 |
| manifest entries `[{path, fromSha256, toSha256}]` | 提 PR 的线程写 `.github/policy-change-manifest.json` | `resolvePolicySource` 校验（基于既有 manifestSha256 模式，security-owner-review.mjs:187） | 提交侧 schema 与校验侧都取 bytes hash 之名I-73 教训；负向测试里端到端排空 |
| `expiresAt` | Owner 评论块 | 手写日期 + `security-owner-review.mjs:199` 既有正则/窗口，双端共用 |  |
| `timeoutMinutes` 值移出 `check-policy.mjs` 常量，进入 `ci/policy.json` data 字段 | PR 改 `ci/policy.json` | `validateWorkflow`（`check-policy.mjs:306-309`） +（policy 不变时在 `validateWorkflow` 检查） workflow 文件 | 原硬编码点只有两处 (`timeoutMinutesFor`/`hostedTimeoutMinutesFor`)，迁移后无遗漏；`main-workflow.mjs:48` 的 15/90 是 main.yml 自身 job，独立不受影响 |

回答完处理完材料里要求核对的 I-73 教训（「清单里的 id 能通过后端校验吗」）——本方案的等价问题翻成：「manifest 里每一条 `path`/`hash`**经治理计算的签名 bytes**——生成端（Approval 一次只会写当前 PR head 与 base）」与「校验端（`resolvePolicySource` 双向比较 base/head 里的部+原 bytes）」是不是同一种**文件字节级**数据的 hash——已明确是；entries 严格双向精确，不发生「清单声明的 id」与「gate 后端读取的 id」不一致。
