`.agents/reviews/topic-policy-migration/round-1/` 在本检出中不存在（glob 与代码索引均未找到），这一点标记为未核实。下面用一手来源核对方案第 4 节里关于网页端签名提交的推断。
# 审核结论

以下按严重度排列。「证据」里行号都已在本检出（3b41b0e）逐处读过。先给一句总评：**方案的主方向（规则值进文件、代码只查结构、照抄安全审批做授权入口）是对的，且各引用基本核实无误；但 push/main 路径上有一个方案完全没提到的失败机制，导致“合并后不再失败一次”这条核心承诺不成立。**

---

## 证实的

### 高 1：main 上第一次运行还是会红——`main-evidence.mjs` 的保险丝不在方案改动范围内
问题：方案 §2.4 承诺“核验通过就按新规则跑，不再失败”，合并后 push 到 main 时，`main-confirm.mjs:31-34` 的流程是 `verifyMainEvidence(["verify"])` → `if (decision.mode !== "light") throw "MAIN_EVIDENCE_NO_LONGER_VALID"`。而 verify 走到 `main-evidence.mjs:57-71` 的 `pushIdentity`，它先于清单核验执行：
```js
assert(parents.length === 2 && parents[0] === event.before, "MAIN_SINGLE_MERGE_REQUIRED");
assert(!git(root, ["diff","--name-only",event.before,event.after,"--",".github","ci","scripts/ci"]),"MAIN_VALIDATION_CHANGED");
```
凡改了 `ci/policy.json`，`ci/` 目录必变 → `MAIN_VALIDATION_CHANGED` 抛出 → `main-evidence.mjs:228-233` 兜底成 `mode:"full"` → `confirmMain` 直接判 `MAIN_EVIDENCE_NO_LONGER_VALID` 失败。**这段断言在每个改规则的合并上都会先于任何授权核验触发**；方案 §2.5 的文件清单（context/run/aggregate/check-coverage/required/export-evidence/test/security-exceptions）不含 `main-evidence.mjs` 和 `main-confirm.mjs`，§2.4 只写了“取第二个父提交核验清单”。结论：照方案实施，main 第一次运行照红，只是错误码不同。
建议：把 push 路径的失败机制逐个列进改动清单——`main-evidence.mjs:59-71`（`MAIN_VALIDATION_CHANGED` 改为“有授权清单覆盖的变化即放行，其余照拒”）、`main-evidence.mjs:159/164`（verifyGate 对 PR run 记录的 `context.policySha256` 与合并树字节的比对，语义要同步）、`main-confirm.mjs:34`。反向用例要覆盖“无授权时 main 上仍红”和“有授权时 confirm 走通”。

### 高 2：“清单 + 一条评论”抄漏了安全审批的一半——没有评论定位文件，也没有继承语义
问题：方案 §3 说“新增 `.github/policy-change-manifest.json`……配一条 PR 评论”，但没写 comment id 放哪。现有安全审批是**两个文件**：`security-owner-review.mjs:120-126` 用 `.github/security-review-manifest.json` 加 `.github/security-review-comment.json`（只存 commentId），本地文件里的批准声明不算授权（设计文档 :242 也有原文）。少这个第二文件，commentId 就无处可查或被写进清单形成自我引用，核验退化。同样缺失的是继承语义：`security-owner-review.mjs:148-159` 用“清单字节与 base 相同 → 继承；不同 → 必须匹配本次事件编号和 head”来处理清单合入 main 后的后续 PR；方案未说明新清单合入后留不留、下一个改规则的 PR 如何替换它、旧清单会不会误授权。靠“改前/改后摘要必须与实际两份完全一致”能把多数错位挡住，但**push 侧的“改后”必须在合并提交树上重算**（手工解冲突可以让合并树的 policy.json 不等于 PR head 的那份），方案没写。
建议：明确抄全：两文件结构、`SECURITY_REVIEW_*` 类似的一套错误码、合入后按字节相等继承、PR 事件绑定（事件号 + head）、push 时在合并提交重算前后摘要、清单一生效一次（旧摘要对不上即拒绝并要求新清单）。

### 中 3：授权范围“只管 ci/policy.json”可被改 `ci/policy.schema.json` 绕过结构校验（I-73 同型问题）
问题：结构校验不是只靠代码——`contracts.mjs:25-28` 从**被测提交的工作树**读 `ci/policy.schema.json` 编译成 Ajv 校验器（`CheckPolicy` 等所有记录校验都走它）。一个 PR 可以只改 schema（例如把 `timeoutMinutes` 的 maximum 从 120 提到 480，或放宽成员/worker 约束）而不动 `ci/policy.json`，字节比对看不到任何“规则变化”，结构校验却已放宽。这正是 I-73 的教训原文：“清单里的 id 能通过后端校验吗”/“双模型复核只看了 diff，没问两端校验”（docs/incidents-and-gates.md#incidents，I-73）。
建议：三选一并写明：(a) 把 `ci/policy.schema.json` 直接纳入本次授权范围；(b) 把结构判据全部内化为代码、schema 文件降级为纯声明（并在 CI 里校验它与代码判据等价——像 `check:prompt-prefix` 那样有反向样例）；(c) 至少：schema 变化也触发清单要求。方案 §5.2 留给 Andy 的范围问题里没有提到 schema，这是漏的。

### 中 4：§2.1 的“结构检查”清单比现状少一大半，删什么留什么没写清
问题：`validatePolicy` 里除了方案列的六条，还有大段代码固化的规则值：`:91-97`"Policy must declare exactly nine required jobs"（`jobIds`）、`:149-159` `expectedNeeds`（逐检查写死的 DAG 边）、`:170-179` 每检查的固定 project 选择、`:180-189` 每检查固定 matrix key、`validateToolchain:1025-1030` 的 node 身份比对、`mainProjects` 六项。如果这些全部删除，得先说清“unauthorized 的普通 PR 反正动不了 policy.json（字节门禁）”这一前提在 authorized 变更下也成立（Owner 看 diff）——这个推导是自洽的，但 §2.1 列表本身会误导实施者以为现状里只有那六条值得留/删。另外“代码只查结构”和 §2.2 的“用那个提交自己的 schema 读旧规则”是两套互斥的机制：若结构校验版本无关，就不需要去旧提交里拉 schema；两套都要实现则引入“base 需要可执行的旧评验器”这种复杂度。§1 前提 3 里那三段一次性迁移的病根正是旧值判据进代码，别再复制一遍。
建议：§2.1 逐条列出 validateToolchain / expectedNeeded / fixed ids / project 选择等现状断言的去向（删、或改造成“文件↔文件比对”如 workflow↔policy、toolchain-lock↔policy）；§2.2 砍掉“旧提交的 schema”，统一为“结构只读代码 + 字节摘要对比”，这与 §1 的最大收益方向一致。

### 中 5：`context.policySha256` 语义改变，消费清单漏了 `main-evidence.mjs`
问题：方案把“已接受的规则”换成“生效的规则”，`context.policySha256` 会从 base 摘要变成被测提交摘要。消费方里 `main-evidence.mjs:164` 的 `context.policySha256 === hash(policy.bytes)`（用合并树上的 `ci/policy.json` 原字节，`main-evidence.mjs:218` 读的）、`verifyGate:159` 的 `context.baseSha === identity.before` 都直接依赖这个语义；方案 §2.5 自称“这是最容易漏改出错的地方”，但它自己的清单正好漏了这一处。改动后的新语义对这些断言反而是自洽的（authorized PR 的 run 记录新摘要，合并树上也是新字节），前提是 §2.4 里的授权与 §2.5 的统一在一批落地——方案应把这两处合并写成一个用例。
建议：在 §2.5 清单补 `main-evidence.mjs`，并加一条端到端测试：authorized PR 的 gate 上下文（policySha256/baseSha/headSha）与合并后 main 上 `verifyGate` 的断言逐字段一致。

### 低 6：对现有测试的破坏量被低估
证据：`test/tooling/policy.test.mjs:700-725` 直接锁死 `upgradeHostedRunnerPolicy` 的行为（7 个断言，删除该函数后必失败）；`:317-320` 锁死"exactly nine jobs"；`test/tooling/runner.test.mjs:52-53`、`test/tooling/pipeline.test.mjs:25` mock 了 `resolvePolicySource`。§3 只说“现有 policy.test.mjs 全部照样通过”，实际方案 §2.1 动了断言所锁的代码。建议在 §3 列出将被改写/删除的具体测试组。

### 低 7：错误文本“列出变化”未要求确定性输出
建议：`CI_POLICY_CHANGE_UNAUTHORIZED` 的差异列表排序后输出，同一 commit 永远同一字符串（便于证据比对和截图对账）。不涉及模型请求。

---

## 推测 / 未核实

- **[推测]** §5.4 的论断“代理通过 GitHub 接口建的提交带同样签名，证明不了是本人”。部分证实：GitHub 官方文档确认网页端提交自动由 GitHub 用 web-flow 密钥签名——“GitHub will automatically use GPG to sign commits you make using the web interface.”（https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification）；同一页还说明 REST Commits API 的提交不获仿冒签名。因此“网页签名 ≠ 本人在场”成立，方案选 B（本人硬件密钥签）作为更强证明的方向合理；但“通过 GitHub 接口建的提交也会带同样签名”这句以未核实收口是对的，建议在方案里把 A/B 的表述改成官方文档支持的原话。
- **[未核实]** PR 259 的报错和运行 id 42080372382（需访问该 run 页面，未查）；ADR 0168:98 已用文字证实“PR 失败 + main 第一次运行失败一次”的现象本身（docs/adr/0168-longer-ci-job-limits-on-hermes.md:98），且我在 `main-confirm.mjs`/`main-evidence.mjs` 找到了与之吻合的失败路径。
- **[未核实]** “两个模型已各自独立出方案（记录在 `.agents/reviews/topic-policy-migration/round-1/`……0.161 美元）”：本检出中该目录不存在（glob 全树无 `reviews/`）。可能是未提交的本地目录；若这是“模型审核这一步已经做过”的依据，应先把记录提交进仓库或注明在哪。
- **[未核实]** 其余未读处：`check-policy.mjs` 的 validateWorkflow 全文（约 :200-800）、`quality.mjs`、`aggregate.mjs` 全文、`local.mjs`——均不影响上述结论，但若按 §2.5 全面重接“生效规则”，这几个文件的实际读法应在实施前再核对一遍。

---

## 侧重检查：一条普通流程的走查

流程：Andy 在一个 PR 里把 test 成员的 `timeoutMinutes` 90 → 120（并发走另一路复核的优先选择）。

1. 本地：`npm run check:ci-policy`（package.json:76）用工作树新 policy + base=`HEAD`（check-policy.mjs:1125 默认）→ 本地自洽，通过；pre-push 层 0 hook 要求声明相关测试（lessons.md:663-665）。
2. GitHub `pull_request` → 9 个检查。`policy` 检查（ci.yml:66 `run.mjs --check policy`）里 `runCheck` 先用**旧** policy 取超时预算（run.mjs:86-88，旧值 60 分钟，够用），随后跑 check-policy main：`main()` 在 check-policy.mjs:1132 `validateWorkflow(source.policy=旧, 新 workflow)` 处报 `Unexpected timeout: policy`，与方案 §1.1 一致。
3. **该失败组合没有现有自动检查**：`test/tooling/policy.test.mjs` 覆盖了 `resolvePolicySource` 的单点行为，但没有“PR 改 policy.json → base 判 workflow”这条组合的反向用例（1067 行未逐行读过全文，标注未逐行核实；grep 无 `Unexpected timeout` 相关用例）——这正是 ADR 0168:98 里被认定为“预期必然失败”却没拦下的原因。方案 §3 补的正是这块，是对的。
4. 合并：fast 模式合并不等 CI（AGENTS.md:7、delivery-mode.md:27）。
5. push main：`plan` job（main.yml:35 `main-evidence.mjs discover`）在 `pushIdentity` 的 `MAIN_VALIDATION_CHANGED` 已断；`confirm` job（main.yml:107）在 `main-confirm.mjs:34` 失败——**main 红一次，错误来自方案没列的文件**（高 1）。
6. 无覆盖路径汇总：第 2 步的组合场景（改动前）无测试；第 5 步的 push 授权路径整条属于本次新增，方案写了用例但没写实现位置（高 1）；`main-evidence/main-confirm` 是方案宣称“最容易漏”却自己漏掉的路径。

文档一致性：ADR 0160:69（一次性升级“合入后不再生效但一直留着”）引用属实；方案落地后需同步改动的文档还有 ADR 0168:98（把“必然失败一次”从已知行为改成修复记录）、设计文档 §2（:115 的“临时规则维护”入口最终落地）、`docs/architecture-v0.1.md:613`（check-policy 的描述）——方案没列文档更新项。

---

## 必答问题

1. **请求前缀**：不会。改动面是 `.github/`、`ci/policy.json`、`scripts/ci/*`、`test/tooling/*`，全部是 CI 侧；运行时给模型组装请求（系统提示、工具定义、历史、出口遮盖）在 `packages/` 与 `apps/agent-service`，不桥接这些文件。规则（.claude/rules/prompt-prefix.md）维持满足：无任何已发内容被改写，每轮变化的值也不新增。
2. **字节确定性**：无模型请求相关输出。CI 侧需注意两点：`CI_POLICY_CHANGE_UNAUTHORIZED` 的差异列表要排序（低 7）；清单/评论摘要都是内容 SHA-256，确定性成立；30 天有效期是时间判定，不进任何请求字节。
3. **自动检查**：会新增，且基建已在（`fixtureRepository` 支持不同 base 的仓库夹具，policy.test.mjs:314/644；安全审批的 API mock 先例在 test/tooling/security-review.test.mjs）。但反向矩阵缺三个：现有 734 行附近断言组的同步改写（低 6）、push/main 路径的“无授权仍红/有授权走通”（高 1）、schema 被改的反向用例（中 3）。设计文档 :227 本身要求授权机制“必须有对应的负向行为测试”，方案 §3 大体对齐，需补齐上述三块才算真“反向会失败”。
4. **逐值两端核对**（I-73 方法）：新清单文件与评论引用文件——缺共同设计（高 2）；`context.policySha256` 语义——“生效规则”消费清单漏 `main-evidence.mjs:218/164`（中 5）；schema 1–120——被被测提交自带 schema 覆盖软化的可能（中 3）；变化列表输出——需排序（低 7）；错误码 `CI_POLICY_CHANGE_UNAUTHORIZED`——纯日志，无下游 schema 消费，可接受；删除 `timeoutMinutesFor`——除测试外无其他消费方（已 grep 核实）。

## 如果由我来定

保留方案 §1–2 的总框架（这确实是比“第三次写一次性迁移”更好的方案），但按四点修改：(1) 把 push/main 路径（`main-evidence.mjs`、`main-confirm.mjs`）纳入第一批改动，写清每个 `MAIN_*` 断言的去向；(2) 照抄安全审批要抄全两个文件、继承和事件绑定；(3) 授权范围把 `ci/policy.schema.json` 连进来，或把结构判据内化进代码并删掉“旧提交自己的 schema”这个中间方案；(4) 实施前先把 §2.1 的结构清单与 `validatePolicy`/`validateToolchain` 现状逐行对账成一张表。§5 的三个待定问题维持原样提交 Andy，但建议 §5.1 明确写：A 只证到设计文档 :280 已接受的边界，B 的收益要用 GitHub web-flow 文档原话支撑。
