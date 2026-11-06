## 总体结论

方向是对的：用“已接受规则 vs 本次规则”的授权入口替代每次写一次性迁移，比继续加迁移代码好。但这份方案目前有三个会直接破坏目标的点：**授权只绑 `ci/policy.json`，PR 仍可改执行检查的脚本/workflow 绕过；把“所有读规则的地方”统一成一份生效规则，会让 coverage 等 accepted baseline 变成 PR 自己的值；`push` 改 `headSha` 与现有 `check-coverage`/`main-evidence` 直接冲突。** 另外，测试计划里“现有 policy 测试全部照样通过”不成立。

---

## 证实的发现（按严重度）

### 1. 严重度高：授权只绑 `ci/policy.json`，控制面可被同一个 PR 改掉

**问题：** 方案 §5.2 建议先只管 `ci/policy.json`。但 PR 实际执行的检查代码、workflow、schema 和依赖都来自 PR checkout，且都不在授权清单里。攻击者/功能 PR 可以不改 `ci/policy.json`，只改 `scripts/ci/check-policy.mjs`、`scripts/ci/contracts.mjs`、`ci/policy.schema.json` 或 `.github/workflows/ci.yml`，让检查永远通过；也可以改 `package-lock.json` 换掉校验器依赖。

**证据：**
- `.github/workflows/ci.yml:66` 执行的是 PR checkout 里的 `scripts/ci/run.mjs`；`:62-64` 先执行 PR 里的 `install-tools.mjs`/`install-dependencies.mjs`。
- `scripts/ci/contracts.mjs:25-32` 在模块加载时从工作树读 `ci/policy.schema.json`，PR 可改。
- `scripts/ci/check-policy.mjs:299-370` 只校验 workflow 的结构，除 coverage 外不校验各 job 的 `run` 内容；`validatePolicy` 也不校验脚本本身。
- 设计文档自己承认这个边界：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:280`：“同仓库 writer 及外部 PR 都能提议修改 workflow、政策和汇总器……当前采用可信 Owner 审阅这一边界”。
- GitHub 官方文档也明确 self-hosted runner 不应跑公开仓库的不可信 PR：<https://docs.github.com/en/actions/reference/security/secure-use>。原文：“self-hosted runners should almost never be used for public repositories ... any user can open pull requests against the repository and compromise the environment.”

**建议：** 二选一：
- (a) 把授权绑定到完整控制面：至少 `.github/**`、`ci/**`、`scripts/ci/**`、`vitest.workspace.ts`、`package.json`、`package-lock.json`、`ci/toolchain-lock.json`，用 Merkle root/逐文件摘要，任何一处变化都要 Owner 授权；
- (b) 把授权/校验放到 base 分支的可信 job 里，PR 文件只当数据读，不执行 PR 的脚本。

如果仍只绑 `ci/policy.json`，请在方案里明确：它只是“防误操作”，不是安全边界，不能实现标题里的“授权入口”。

---

### 2. 严重度高：把所有读取统一成“生效规则”会让 PR 自己降低门槛

**问题：** §2.5 说 `check-coverage.mjs`、`security-exceptions.mjs` 等都按 `context.baseSha` 读规则，全部改成读同一份生效规则。但 coverage 现在同时读两份：`policy`（工作树里的候选）和 `source.coverage`（base 上的已接受基线）。如果 source 变成被测提交，`evaluateCoverage` 的 accepted 和 proposed 就是同一份，PR 可以自己降低阈值。`check-policy.mjs` 里“用旧策略检查新 workflow/vitest”的校验也会变成自检。

**证据：**
- `scripts/ci/check-coverage.mjs:522-528`：`policy` 从工作树读，`source` 从 base 读；`:553` `acceptedPolicy: source.coverage`；`:563` 传给 `evaluateCoverage`。
- `scripts/ci/check-policy.mjs:1132` `validateWorkflow(source.policy, ...)`、`:1140` `validateVitestProjects(source.policy, ...)`。
- `scripts/ci/check-security.mjs:447`、`scripts/ci/security-exceptions.mjs:198-207`、`scripts/ci/check-policy.mjs:1155` 的已接受例外/卫生基线都依赖 base。
- 设计文档 `:225`：“基线和例外默认读取目标分支受保护版本；同一 PR 不能自行降低阈值使自身通过。”

**建议：** 明确拆成 `accepted`（base）和 `effective`（本次运行）两套：
- 执行路径（跑哪些 check、用哪个 timeout/project 列表）用 effective；
- coverage 基线、security exceptions、test hygiene、toolchain 基线继续用 base。
为每个消费者列一张表，写清楚用哪一套。不要用一个 `resolvePolicySource` 同时承担两种语义。

---

### 3. 严重度高中：只有一个 `policySha256`，无法同时表达“已接受”和“生效”

**问题：** 现在 `Context`、`CheckResult`、`GateSummary` 只有一个 `policySha256`，语义是 base 上已接受的策略。方案要让运行按新策略跑，却没有设计 accepted/effective 两个摘要。改成一个会丢掉授权比较的对象；保留 base 又会让按 effective 选择检查的下游与摘要不符。

**证据：**
- `scripts/ci/contracts.mjs:8-19` `identityFields` 只有一个 `policySha256`。
- `scripts/ci/context.mjs:130-142` 从 base 的 `resolvePolicySource` 取值。
- `scripts/ci/aggregate.mjs:285-290`、`scripts/ci/check-coverage.mjs:523-528`、`scripts/ci/export-evidence.mjs:113-116` 都断言 `source.policySha256 === context.policySha256`。
- `ci/result.schema.json:399-453` 和 `ci/evidence.schema.json:29-44` 的 `Context` 都是 `additionalProperties:false`，只允许一个 `policySha256`。
- `scripts/ci/main-evidence.mjs:164` 把它和被测提交的 `ci/policy.json` 字节比较。

**建议：** 增加 `acceptedPolicySha256` 和 `effectivePolicySha256`（或保留 `policySha256` 为 effective，再加 `acceptedPolicySha256`），同步更新 `contracts.identityFields`、两个 schema、`publish.mjs` 白名单、`aggregate`/`required`/`check-coverage`/`export-evidence`/`main-evidence` 和测试。授权记录里也要绑定这两个摘要。

---

### 4. 严重度中高：push 时把第二父提交当 `headSha` 会直接撞上现有断言

**问题：** §2.4 说 push 时“取合并提交的第二个父提交当 PR head”。但 `headSha` 在 push 上现在等于 `testedSha`，而且有代码显式断言。直接改会破坏 coverage 的基线计算和 main-evidence 的身份校验；不改又无法复用安全审批的 `context.headSha`。

**证据：**
- `scripts/ci/context.mjs:94-111`：push 时 `headSha = testedSha`。
- `scripts/ci/check-coverage.mjs:253-254`：`if (context.event === "push") assert(context.headSha === context.testedSha, "push must test its after SHA")`。
- `scripts/ci/main-evidence.mjs:159-160`：light path 要求 `context.headSha === identity.head`；`:57-71` 的 `MAIN_VALIDATION_CHANGED` 让任何 `ci`/`.github`/`scripts/ci` 变化都走 full。
- `scripts/ci/main-evidence.mjs:57-58` 与设计文档 `:288-289` 都要求“第一父提交恰好是 push.before，第二父提交是 PR head”。

**建议：** 保留 `headSha=testedSha`，新增 `pullRequestHeadSha`/`authorizationSourceSha` 字段只给授权校验用；如果坚持改 `headSha`，必须同时改 `check-coverage`、`main-evidence`、`security-owner-review`、`result.schema`/`evidence.schema`/`publish` 白名单和测试。push 的授权最好通过 GitHub API 确认“这个 merge commit 的 PR、head、merge_commit_sha”，而不是只看第二父提交。

---

### 5. 严重度中高：`check-policy.mjs` 拿不到 PR 身份，且把授权塞进 `resolvePolicySource` 会重复调 API

**问题：** `check-policy.mjs` 现在只接收 `--base`，拿不到 PR 编号、事件和 head；`context.mjs` 又反过来 import `resolvePolicySource`，如果把授权检查塞进 `resolvePolicySource`，会形成循环依赖，并且每个调用它的地方都会重复调 GitHub API。policy job 也没有 token。

**证据：**
- `scripts/ci/run.mjs:235-240` 只传 `--base`。
- `scripts/ci/context.mjs:12` import `resolvePolicySource`；`:130` 调用；`:151` `verifyContext` 再调用 `createContext`。
- `resolvePolicySource` 被 8 个文件调用：`context.mjs:130`、`run.mjs:86`、`aggregate.mjs:285`、`check-coverage.mjs:523`、`required.mjs:20`、`test.mjs:27`、`security-exceptions.mjs:198`、`export-evidence.mjs:113`。
- `.github/workflows/ci.yml:61-70` policy job 没有 `HIMAWARI_CI_GITHUB_TOKEN`；security job 只在 check step 设置（`:565-567`）。

**建议：** 在 policy job 里只解析/校验一次，把授权结论、manifest 摘要、accepted/effective 摘要写进 context artifact；下游只校验摘要，不再访问 GitHub。PR 编号/head 从 `GITHUB_EVENT_PATH` 或 context 文件传入，避免 import 循环。需要 token 时只给验证步骤，不要给 job 级别，尤其在 `install-tools`/`install-dependencies` 运行 PR 代码之前。

---

### 6. 严重度中：删掉三段迁移会让现有测试直接失败，“全部照样通过”不成立

**问题：** 方案说删掉 `upgradeHostedRunnerPolicy` 等三段迁移、现有 `test/tooling/policy.test.mjs` 全部照样通过。实际这个文件直接 import `upgradeHostedRunnerPolicy`，还有多组迁移用例；删函数/删 `allowLegacy*` 分支会让测试文件失败。

**证据：**
- `test/tooling/policy.test.mjs:15` import `upgradeHostedRunnerPolicy`。
- `:675-725` 托管 runner 升级；`:727-749` 旧 coverage 迁移；`:750-819` 旧 integration worker 限额迁移。
- `scripts/ci/check-policy.mjs:76-84,130,156` 的 `allowLegacy*` 分支。

**建议：** 把测试迁移算进工作量：删除或重写这些用例，新增“旧 base 策略在新代码下可读/不可读”的边界测试。或者保留迁移直到替代机制完全落地。不要用“现有测试全过”作为方案成立的前提。

---

### 7. 严重度中：“代码只查结构、规则值写在文件里”没有做到

**问题：** 方案只删 `timeoutMinutesFor`，但 `validatePolicy` 仍写死九个 job、六个 project、DAG、矩阵 key、runner/os/arch；schema 还写死 minItems。未来改 check 集合、矩阵或 runner，仍然会失败两次。

**证据：**
- `scripts/ci/check-policy.mjs:30-41`、`:91-108`、`:149-159`、`:180-191`、`:193-206`。
- `ci/policy.schema.json:20-22`（events 枚举/minItems）、`:104`（checks minItems 9）、`:148`（testProjects minItems 6）。
- `scripts/ci/main-workflow.mjs:48` 仍写死 `hermes-home` 和 `plan=15/其他=90`。

**建议：** 先给“规则值”分类：超时/runner/矩阵属于可运营值，check 集合/DAG/required 属于门槛值。只把可运营值移出代码；门槛值如果要动态化，必须同时改 schema、DAG 校验、workflow 校验和 main-workflow。否则把方案范围收窄成“只解决 timeout”，并在文档里写明其他规则变更仍需代码迁移。

---

### 8. 严重度中：“用那个提交自己的 schema 读”没有实现路径

**问题：** `contracts.mjs` 在模块加载时固定读工作树的 schema；`resolvePolicySource` 永远用当前 `validatePolicy` + 迁移。要读旧提交的 schema/validator，需要显式版本化；直接执行 base 的代码又和“快照/可复现”冲突。

**证据：** `scripts/ci/contracts.mjs:25-32`；`scripts/ci/check-policy.mjs:978-984`。

**建议：** 授权比较只比原始字节，不需要解析旧策略。对确实要读的 accepted 基线（coverage、exceptions、timeouts），按 `schemaVersion` 选一个固定的版本化解析器，只读取需要的字段并严格校验；未知版本 fail closed。不要执行 base 的 JS。这样既能读旧数据，又不会把旧代码带进新运行。

---

### 9. 严重度中：首次初始化没有处理

**问题：** base 上没有 policy 时 `resolvePolicySource` 返回 `initialization:true`，没有“改前字节”可比较；方案说“不同就要求授权”会把初始化也卡住，或错误地要求一个不存在的 before hash。

**证据：** `scripts/ci/check-policy.mjs:972-980`、`:1012`；设计文档 `:113` 的一次性初始化流程。

**建议：** 明确分支：base 无 policy → 走初始化流程（按设计文档，不要求 before hash，但仍要禁止“只缺一个文件”时重新初始化）；base 有 policy → 才比较和授权。加测试。

---

### 10. 严重度中：授权记录的绑定不够严，且缺少评论定位文件

**问题：** 安全审批不是只有 manifest：还需要 `.github/security-review-comment.json` 存 commentId；方案的清单只提到 `.github/policy-change-manifest.json`。安全审批在 push/旧清单继承时的校验也不是“精确等于本 PR head”，方案没有说明怎么避免重放。

**证据：**
- `scripts/ci/security-owner-review.mjs:120-127` 同时读 `security-review-manifest.json` 和 `security-review-comment.json`。
- `:153-159` 只在 PR 事件且非继承时检查 `event.number`/`event.pull_request.head.sha`。
- `:202-210` 只要求 `manifest.sourceHead` 是 `context.headSha` 的祖先，不是相等。
- `:190-200` 的 30 天有效期和 `expiresAt` 格式。

**建议：** 复制安全审批的两个文件；manifest schema 用 `additionalProperties:false` 并校验 repo/PR/sourceHead/两个 hash 的类型和长度；PR 上要求 `manifest.pullRequest === event.number` 且 `manifest.sourceHead === context.headSha`；push 上用 GitHub API 验证 `merge_commit_sha === testedSha` 且 `head.sha === sourceHead`；策略变化时拒绝继承旧 manifest；考虑 nonce/一次性。Option B 则签 manifest 本身（包含 repo/PR/sourceHead/before/after/tree），不只签提交。

---

### 11. 严重度中：合并目前不等 CI，授权不是合并前门槛

**问题：** “未授权就在 main 上报错”发生在不可撤销的合并之后。授权不是合并前门槛，无法阻止功能 PR 先合入再变红。

**证据：** `.agents/instructions/delivery-mode.md:27`：“合并进 `main` 不等待 `ci/required`”；设计文档 `:115` 要求不得在功能 PR 中利用入口降低失败条件；`scripts/ci/context.mjs:109-111` 用 `payload.before` 当 push 基线。

**建议：** 在 Andy 决定前，把这条写进方案的局限；如果要真正阻止，需让规则集要求 `ci/required`（或专门的 policy check）覆盖 `ci/**`、`.github/**`、`scripts/ci/**` 的改动。否则只能做事后回滚/事故记录。

---

### 12. 严重度中：新错误码在结构化结果里会丢失

**问题：** `check-policy.mjs` 只在 stderr 打印固定错误码，`run.mjs` 的 `command()` 抛的是 `CI_COMMAND_FAILED:policy`；`aggregate` 只会看到这个泛化原因。方案说“报固定的错误码”，但 gate summary 里看不到。

**证据：** `scripts/ci/check-policy.mjs:1168-1174`；`scripts/ci/run.mjs:182-186`；`run.mjs:488-489`；`scripts/ci/aggregate.mjs:70,225-241`。

**建议：** 让 `check-policy.mjs` 输出机器可读的失败记录（例如 `{code, acceptedSha256, effectiveSha256, changes}`），`run.mjs` 解析并只在白名单内传播；`aggregate`/`required` 保留固定码。加测试断言 gate summary 含 `CI_POLICY_CHANGE_UNAUTHORIZED`。

---

### 13. 严重度低：GitHub 网页端提交签名不能证明是 Andy 本人

**问题：** GLM 的“网页端提交自带的签名证明是 Andy 本人”不成立。GitHub 网页界面提交由 GitHub 自动用 GPG 签名（web-flow），不是用户自己的密钥；`Verified` 只证明签名可验证，不证明作者身份。

**证据：** GitHub 官方文档 <https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification>。原文：“GitHub will automatically use GPG to sign commits you make using the web interface. Commits signed by GitHub will have a verified status. You can verify the signature locally using the public key available at https://github.com/web-flow.gpg.”

**建议：** 如果选 B，用 Andy 的硬件密钥签一个规范化 manifest（repo、PR、sourceHead、before/after/tree 摘要），公钥固定在 base；CI 用 `git verify-commit`/`ssh-keygen -Y verify` 或 `gpg --verify` 验签。注意 rebase/squash 合并会丢签名（官方文档），仓库已经要求 merge commit，保持即可。

---

### 14. 严重度低：字节比较和消费者清单不完整

**问题：** manifest 里的 before/after hash 如果一处用 `git show`、一处用 `readFileSync`，在 CRLF/autocrlf/过滤器下会不同；方案列的“所有读规则的地方”还漏了 Layer-0 检查脚本和 Hermes runner 脚本。

**证据：**
- `scripts/ci/check-policy.mjs:978-980` 用 `git show`；`scripts/ci/main-evidence.mjs:218` 用 `readFileSync`。
- `scripts/layer0-tests/check-layer0-tests.py:94-143` 读 `ci/policy.json` 的 `testProjects`。
- `scripts/operations/hermes-runner/mac-runners.sh:92-96` 和 `pause-runners.sh:9` 从 `ci/policy.json` 解析 `timeoutMinutes`。

**建议：** before/after 都用 `git cat-file blob <sha>:ci/policy.json`，并像 `context.mjs:123-124` 那样核对 checkout 字节；把这些消费者加入清单或明确排除。若要“语义相同就不要求授权”，用规范化 JSON（排序键、固定空白）计算摘要，并写清楚。

---

## 推测 / 未核实

- 方案说 Andy 的代理线程用同一 GitHub 账号，所以评论作者证明不了本人。这是方案自述，我没有独立核实账号是否共享。若属实，Option A 只能证明“这个账号”，不能证明“Andy 本人按了硬件键”。
- PR 259 / run 42080372382 的实际报错我没有联网核实（当前环境不能访问 GitHub）；从代码看 `check-policy.mjs:169` 会产生该错误，逻辑一致。
- 仓库是否公开、Actions 是否设置 `all_external_contributors` 审批：设计文档 `:248,:266,:280` 说是公开并需审批，但我没有读取 live settings。
- 硬件密钥（Option B）的操作成本、Andy 是否愿意每次签名，未核实。
- 我没有穷举所有可能读取 `ci/policy.json` 的脚本；只按 grep 找到了上述消费者。其他语言/生成脚本可能还有，标记未核实。
- “30 天有效期”是否足够、是否需要更短，取决于团队流程，未核实。

---

## 侧重检查

**错误路径：**
- 缺少 manifest/comment、API 不可用、评论过期、评论作者错误、hash 不符：方案说要失败，但未给出统一的 fail-closed 错误码和测试；安全审批的 `SECURITY_REVIEW_*` 模式可以照抄。
- base 没有 policy（初始化）：未处理，见发现 9。
- 未授权 push / 合并后 main：能报错，但发生在不可撤销的合并之后，见发现 11。
- 新错误码传播：会在 `run.mjs` 被泛化成 `CI_COMMAND_FAILED:policy`，见发现 12。
- push `headSha`：会撞 `check-coverage.mjs:254` 和 `main-evidence.mjs:160`，见发现 4。

**不合规范或不可信输入：**
- manifest/comment 字段（PR 编号、sourceHead、两个 hash）目前没有 schema；必须 `additionalProperties:false`、类型/长度/仓库/PR 精确校验，见发现 10。
- GitHub API 响应要限制大小和超时；安全审批已有 `--max-filesize 1048576`、`maxBuffer`、超时，方案应照抄。
- 旧 manifest/旧评论可重放：只要求 sourceHead 是祖先不够，见发现 10。
- `ci/policy.json` 本身可能很大；现有代码已直接 JSON.parse，建议加大小上限并保留现有错误处理。

**安全：**
- 最大问题是控制面绕过：只绑 `ci/policy.json` 不是安全边界，见发现 1。
- 既有风险：公开仓库 + self-hosted runner；这不是本方案引入，但决定了授权检查不能依赖 PR 自己的代码。GitHub 官方文档明确警告：<https://docs.github.com/en/actions/reference/security/secure-use>。
- token 暴露：如果为了调 GitHub API 给 policy job 加 `HIMAWARI_CI_GITHUB_TOKEN`，不能让前面的 PR 安装脚本看到；应只给验证步骤，见发现 5。
- 账号共享：Option A 只证明账号，不证明本人；Option B 要签 manifest 而不是只签提交，见发现 13。

**资源耗尽：**
- 把 timeout 上限放到 120 分钟本身是授权后的决定；未授权策略在 `policy` job 就会失败，不会先跑昂贵 job，这一点现有 `needs: policy` 是好的。
- 但如果在 `resolvePolicySource` 里做 GitHub API 校验，8 个调用点 + `verifyContext` 会重复请求，可能触发 rate limit；应只验证一次，见发现 5。
- manifest/comment/policy 文件都要有大小上限和超时；安全审批的 curl 参数可复用。

**不可撤销的操作：**
- 合并进 main 是追加历史，撤销只能再开 PR；当前合并不等 CI，所以“未授权”只能在合并后报。建议把 `ci/required` 或专门的 policy check 设为 `ci/**`/`.github/**`/`scripts/ci/**` 改动的必需检查，见发现 11。
- Option B 的硬件签名是不可撤销的授权记录；要设计过期/撤销/更换公钥的流程，否则旧签名在有效期内可重放。

---

## 如果由我来定，我会怎样改这份方案

1. **先把问题拆开，不要把所有规则值混成一个授权入口。**
   - 运营值：`timeoutMinutes`、runner 标签、矩阵成员、paused。它们不直接决定“测试是否通过”，只决定资源和平台。做法：schema 限制 1–120/枚举，workflow 与 policy 保持一致，不需要 Owner 评论授权。
   - 门槛值：check 集合、DAG、required 依赖、coverage 阈值、security exceptions、test hygiene 基线。它们能降低失败条件。做法：继续用 base 上的已接受值比较，必要时加 Owner 授权。

2. **先做最小修复，立刻止住“合法 timeout 修改失败两次”。**
   - 删除 `check-policy.mjs:169` 的 `timeoutMinutes === timeoutMinutesFor(...)` 断言，保留 schema 1–120 和 `validateWorkflow` 的 `timeout-minutes === check.timeoutMinutes`。
   - 保留三段迁移，直到第 4 步的双摘要机制和测试完全落地。
   - 这样不需要评论/manifest 就能解决当前最常见的失败，风险也小。

3. **引入 `acceptedPolicy` 和 `effectivePolicy` 两套解析。**
   - `accepted`：base 上的 `ci/policy.json`/`ci/coverage-policy.json`，用于基线、例外、卫生、授权比较。
   - `effective`：本次运行真正使用的策略（PR 授权后为 tested；push 授权后为 merge），用于选择 check、timeout、project。
   - 新增 `acceptedPolicySha256`/`effectivePolicySha256`，更新所有 schema/白名单/消费者。不要用 `context.baseSha` 一个值承担两种语义。

4. **只把执行路径切到 effective，baseline 保持 base。**
   - `run.mjs`/`test.mjs`/`aggregate.mjs`/`required.mjs` 用 effective。
   - `check-coverage.mjs` 的 `acceptedPolicy`/`source.coverage`、`security-exceptions` 的已接受例外、`check-policy` 的 test hygiene 继续用 base。
   - 加端到端测试：即使 policy 授权通过，coverage/exception 自降仍然失败。

5. **如果仍要做 Owner 授权，绑定完整控制面或放到可信 job。**
   - 绑定 `.github/**`、`ci/**`、`scripts/ci/**`、`vitest.workspace.ts`、`package.json`、`package-lock.json`、`ci/toolchain-lock.json` 的 Merkle root；或者
   - 在 base 分支的独立 job 里运行验证器，PR 文件只当数据读。
   - 只绑 `ci/policy.json` 就明确写成“防误操作”，不要写成安全授权。

6. **授权记录照抄安全审批，但补上缺失的绑定。**
   - 两个文件：manifest + comment reference（commentId）。
   - manifest schema：`additionalProperties:false`，repo/PR/sourceHead/before/after 严格校验。
   - PR：`manifest.pullRequest === event.number`、`manifest.sourceHead === context.headSha`。
   - push：GitHub API 验证 `merge_commit_sha === testedSha`、`head.sha === sourceHead`。
   - 30 天上限；拒绝继承的旧 manifest；考虑 nonce/一次性。
   - Option B：签 manifest 本身；公钥固定在 base；不要依赖网页端签名。

7. **只验证一次，下游验摘要。**
   - policy job 产出 `{acceptedPolicySha256, effectivePolicySha256, authorizationDigest, decision}`，写进 context artifact。
   - 下游只校验 artifact/摘要，不重复调 GitHub API。
   - token 只给验证步骤，且不要在该步骤之前让 PR 安装脚本拿到。

8. **push/main 不要改 `headSha`。**
   - 保留 `MAIN_VALIDATION_CHANGED` 的 full CI 回退；在 full CI 的 policy job 用 `payload.before` vs merge 比较。
   - 新增 `pullRequestHeadSha`/`authorizationSourceSha`，不要覆盖 `headSha`；如要覆盖，必须同步 `check-coverage`、`main-evidence`、schema、publish 白名单和测试。

9. **错误码进结构化结果。**
   - `check-policy.mjs` 输出机器可读失败；`run.mjs`/`aggregate` 传播固定码；测试 gate summary 里能看到 `CI_POLICY_CHANGE_UNAUTHORIZED`。

10. **测试先红后绿。**
    - 新代码 + 关闭授权 → 必须报 `CI_POLICY_CHANGE_UNAUTHORIZED`。
    - 控制面绕过：只改 `scripts/ci`/workflow → 必须失败或需要授权。
    - baseline：授权改 policy 后，coverage/exception 自降仍然失败。
    - push：第二父提交、`headSha`、`MAIN_VALIDATION_CHANGED` 都有测试。
    - manifest：缺字段/多字段/错 PR/错 head/过期/未来/重放/API 失败。
    - 更新迁移测试，不要声称“现有测试全过”。

11. **分阶段落地。** 先 timeout 最小修复；再双摘要；再授权；最后才删迁移。不要在一个 PR 里同时删三段迁移、引入评论授权、改所有读者和改 push 语义。

---

## 必答问题逐条回答

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本方案只改 `scripts/ci/**`、`.github/**`、`ci/**`，没有触碰 `packages/runtime-pi`、`packages/prompt-catalog`、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加；每轮会变的时间、记忆、资料块仍然只在最后一条用户消息里。依据：`.claude/rules/prompt-prefix.md:16-17`；`AGENTS.md:41-43`。这个方案没有改变现状，也没有引入系统提示/工具定义里的新字节。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求不会。** 方案新增的 `expiresAt`/`created_at` 等时间字段只用于 CI 授权记录，不会进入模型请求；如果以后要把它们放进提示词，它们属于每轮变化的值，只能放最后一条消息。
**但在 CI 内部要注意：** manifest 的 before/after hash 必须始终从同一个字节源计算（建议 `git cat-file blob <sha>:ci/policy.json`），不要一处 `git show`、一处 `readFileSync`；否则 CRLF/autocrlf 会让同一份 JSON 变成不同摘要。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有测试计划，但不够，而且有一处说法不成立。**
- 方案说“同一用例在旧代码上报 `Unexpected timeout: policy`”不是新授权逻辑的红测试：旧代码是因为 `check-policy.mjs:169` 的硬编码 timeout 失败，不是因为没有授权。正确的红测试应是：新代码 + 关闭授权 → 报 `CI_POLICY_CHANGE_UNAUTHORIZED`。
- 方案说“现有 `test/tooling/policy.test.mjs` 全部照样通过”，但删 `upgradeHostedRunnerPolicy`/`allowLegacy*` 会让该文件 import 和多个迁移用例失败（`test/tooling/policy.test.mjs:15,675-819`）。
- 缺少反向用例：控制面绕过（只改 `scripts/ci`/workflow）、coverage/exception 自降、push `headSha`、manifest 重放、API 失败、初始化、错误码传播、schema 两端校验。
- 建议把“旧代码失败”改成“新代码关闭授权失败”，并为上面每条加固定错误码断言。

### 4. 每个新值/修改值，生产它的地方和使用它的地方都能接受吗？

按 I-73 的教训（`docs/incidents-and-gates.md:112`：“双模型复核只看了 diff，没问‘清单里的 id 能通过后端校验吗’”），逐个核对：

| 值 | 产生处 | 使用处 | 两端校验/缺口 |
| --- | --- | --- | --- |
| manifest 的 `pullRequest`、`sourceHead`、`beforeSha256`、`afterSha256` | PR 作者写 `.github/policy-change-manifest.json` | 新授权校验器、GitHub 评论比对、push 校验 | 目前没有 schema；必须 `additionalProperties:false`、类型/长度/repo/PR/head 精确校验；否则可伪造/重放 |
| 评论里的 `manifestSha256`、`expiresAt` | Owner 评论 | 授权校验器 | 照抄 `security-owner-review.mjs:160-201`；还要精确绑定 PR/head，见发现 10 |
| `commentId` | 需要新增 comment reference 文件 | GitHub API | 方案只提 manifest，漏了 comment 定位文件；安全审批用两个文件（`:120-127`） |
| `acceptedPolicySha256`/`effectivePolicySha256`（若新增） | `context.mjs` | `contracts.identityFields`、`result.schema.json` Context、`evidence.schema.json` context、`publish.mjs` 白名单、`aggregate`、`check-coverage`、`export-evidence`、`main-evidence`、测试 | 两个 schema 都是 `additionalProperties:false`，不加就会拒绝；`main-evidence.mjs:164` 也要决定比哪一个 |
| push 的 `headSha`（若改成第二父提交） | `context.mjs` | `check-coverage.mjs:254`、`main-evidence.mjs:160`、`security-owner-review.mjs`、schema/publish | 直接冲突；建议新增字段而不是改 `headSha` |
| `CI_POLICY_CHANGE_UNAUTHORIZED` | `check-policy.mjs` | `run.mjs` 的 `details.failures`、`aggregate` 的 reasons、`required`、`publish` | `run.mjs:182-186` 会变成 `CI_COMMAND_FAILED:policy`；需要机器可读输出和传播测试 |
| `timeoutMinutes`（从代码移到文件） | `ci/policy.json` | `validatePolicy`、`validateWorkflow:307`、`test.mjs:29`、`run.mjs:172/432/441`、`mac-runners.sh:92-96` | 所有写死的副本都要删；schema 1–120；workflow 必须一致；runner 脚本的 grep 解析要保留或改写 |

**结论：** 目前最危险的是只改 `context.policySha256`/`headSha` 而不改 `result.schema.json`/`evidence.schema.json` 的 `additionalProperties:false` 和 `publish.mjs` 白名单，这会直接重演 I-73；其次是新错误码和 manifest 字段没有两端校验。
