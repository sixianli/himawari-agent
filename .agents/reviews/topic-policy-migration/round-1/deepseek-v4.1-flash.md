I'll start by reading the key files and docs mentioned to understand the current implementation.
# 方案：用“Owner 签名的最终 head commit”授权精确政策变更，取代一次性迁移

## 结论先说

`policy` 检查现在把“当前规则应是多少”写死在代码里，又用 PR 里的新代码去校验目标分支上的旧政策，所以任何合法规则变更都会在自己的 PR 上失败；合并后第一次 `main` 推送又拿 `payload.before` 当基线，于是再失败一次。正确方向不是继续为每种旧值写迁移，而是把两件事分开：

1. **结构校验**只检查政策自洽、DAG、权限、超时字段范围等稳定不变量；
2. **规则变更本身**由 Andy 用一个不在代理线程手里的签名密钥，对**精确的最终 head commit** 签名授权；CI 从目标分支读取公钥并验签。

这样，普通功能 PR 不签名就不能改政策；合法的政策 PR 被签名后，`policy` 检查和合并后第一次 `main` 运行都使用新政策，不再需要 `upgradeHostedRunnerPolicy` 之类的一次性代码。

---

## 一、方案依赖的前提

### 已读代码或一手来源证实的

**P1. 当前失败链条确实存在。**
- `scripts/ci/check-policy.mjs:43-46` 把超时写死：
  ```js
  export function timeoutMinutesFor(checkId) {
    if (checkId === "required") return 15;
    return ["build", "test", "node-floor", "browser"].includes(checkId) ? 90 : 60;
  }
  ```
- `scripts/ci/check-policy.mjs:169` 要求政策值精确等于代码常量：
  > `assert(check.timeoutMinutes === timeoutMinutesFor(check.id), \`Unexpected timeout: ${check.id}\`);`
- `scripts/ci/check-policy.mjs:307` 要求 workflow 的 `timeout-minutes` 精确等于政策值。
- `scripts/ci/check-policy.mjs:1125-1132` 先从 `base` 读已接受政策，再用它校验 PR 的 workflow：
  > `const source = resolvePolicySource({ root, base: args["--base"] ?? "HEAD" });`
  > `validateWorkflow(source.policy, readFileSync(workflow, "utf8"), lock);`

**P2. 合并后第一次 main 运行取的是推送前的 main。**
- `scripts/ci/context.mjs:109-111`：
  > `baseSha = commit(/^0{40}$/u.test(payload.before ?? "") ? base : payload.before);`
- `scripts/ci/main-evidence.mjs:59-71` 规定：合并中 `.github`、`ci`、`scripts/ci` 有变化时不能走轻量确认，必须跑完整 CI：
  > `"MAIN_VALIDATION_CHANGED"`
  因此政策变更后的第一次 main 推送会进入完整 CI，而完整 CI 仍用 `before` 当 base。

**P3. 现有设计确实要求“目标分支接受的政策 + Owner 单独授权”。**
- `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:115`：
  > “普通功能 PR 使用目标分支已经接受的阈值和例外。确需修正规则或接纳新例外时，提交只包含政策及其验证材料的独立变更……若旧规则本身阻止合法政策修复，必须由 Owner 单独授权临时规则维护，记录准确变更、对照证据和恢复结果，再重新证明强制门禁生效。不得在功能 PR 中利用这一入口降低自己的失败条件。”
- 同文件 `:225`：
  > “基线和例外默认读取目标分支受保护版本；同一 PR 不能自行降低阈值使自身通过。”
- 同文件 `:242` 描述现有安全审批入口：
  > “检查通过固定 GitHub HTTPS API 读取评论，核验仓库所有者的数字身份与登录名、仓库和 PR、被审核源码提交、清单原始字节摘要、批准决定与最长 30 天的有效期。”

**P4. 现有安全审批入口只证明了 GitHub 账号，不能证明是 Andy 本人。**
- `scripts/ci/security-owner-review.mjs:162-171` 校验的是评论作者的 GitHub 数字身份：
  > `comment.user?.id === owner.id && comment.user?.login === owner.login && comment.user?.type === "User" ...`
- 这和题目给出的约束一致：Andy 的代理线程也用他的账号推送和评论。

**P5. 合并目前不等 CI，规则集也还没要求 `ci/required`。**
- `.agents/instructions/delivery-mode.md:27`：
  > “GitHub 合并门槛：合并进 `main` 不等待 `ci/required`。……结果只供参考……”
- 所以方案不能依赖“PR 的 `ci/required` 阻止合并”，只能在 PR 检查和 main 首次运行中如实失败，并让授权证据可核验。

**P6. 仓库使用 merge commit，PR head 会作为 merge commit 的第二父提交保留。**
- `scripts/ci/main-evidence.mjs:57-58`：
  > `const parents = git(root, ["show", "-s", "--format=%P", event.after]).split(" ");`
  > `assert(parents.length === 2 && parents[0] === event.before, "MAIN_SINGLE_MERGE_REQUIRED");`
- 这使“签名 PR head，main 首次运行再验第二父提交”可行。若以后改用 squash/rebase，签名会丢失，必须另行设计。

**P7. 业界一手依据支持“用签名证明人授权”，而不是只信账号。**
- GitHub 官方《About commit signature verification》：
  > “Using GPG, SSH, or S/MIME, you can sign tags and commits locally. These tags or commits are marked as verified on GitHub so other people can be confident that the changes come from a trusted source.”
  <https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification>
- Git 官方 `git-verify-commit`：
  > “Validates the GPG signature created by `git commit -S` on the commit objects given on the command line.”
  <https://git-scm.com/docs/git-verify-commit>
- GitHub 官方 `pull_request_target` 安全用法：
  > “The workflow, and any subsequent `actions/checkout` call that does not specify a `ref`, is taken from the base repository's default branch, not from the pull request. Because only trusted code from the default branch runs, it is safe to grant secrets and a read/write token. No code from the fork is executed by default.”
  > “You must ensure the checked-out code is only ever inspected as data and never executed before using a `pull_request_target` event.”
  <https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target>
- GitHub 官方环境审批：
  > “Only one of the required reviewers needs to approve the job for it to proceed.”
  > “You also have the option to prevent self-reviews ... This ensures that deployments to protected environments are always reviewed by more than one person.”
  <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>
- GitHub 官方 CODEOWNERS：
  > “The people you choose as code owners must have write permissions for the repository.”
  > “For code owners to receive review requests, the CODEOWNERS file must be on the base branch of the pull request.”
  <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners>
- GitHub 官方 rulesets：
  > “Ruleset workflows can be configured at the organization or enterprise level to require workflows to pass before merging pull requests.”
  > “This rule is not available on user-owned repositories as they do not contain teams.”
  <https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
  这说明组织级 required workflows 和“按文件要求团队批准”不适用于当前个人仓库，也不能区分共享账号里的“人”。

### 推测或未核实的

- **未核实**：Hermes runner 上的 Git 是否 ≥ 2.34、`ssh-keygen -Y` 是否可用。SSH 验签依赖这些版本；若不可用，改用 GPG 或先升级固定工具链。
- **未核实**：Andy 是否愿意把签名私钥放在硬件令牌（YubiKey 等）上，且代理线程无法调用。这是本方案成立的关键前提，不能靠代码补。
- **推测**：如果签名密钥和 GitHub 账号认证密钥是同一把，且 Hermes/代理可访问，则“代理用 Andy 账号”的问题仍然存在。必须使用**专用签名密钥**，私钥只在 Andy 本人设备/硬件令牌上。
- **未核实**：是否所有政策变更都能保持“只改政策及其验证材料”的独立 PR。若把产品代码和政策变更混在一起，签名会覆盖整棵树，Andy 可能无意中批准了别的内容；需要额外限制路径（见下）。

---

## 二、方案本身

### 2.1 核心：签名最终 head commit，而不是签名评论或清单文件

在 `main` 上新增信任锚 `ci/policy-allowed-signers`，内容类似：

```text
andy-policy ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

它只在**目标分支（base）**读取，绝不在 PR head 读取。原因是 PR 不能自己替换验签公钥。

Andy 对政策变更的**最终 head commit** 签名。可以在政策提交本身上 `git commit -S`，也可以在它上面再做一个签名的空提交；最终 head 必须是签过名的那一个。提交消息带机器可读尾注：

```text
Policy-Approval: v1
Policy-Base-Sha256: <base 的 ci/policy.json 原始字节 SHA-256>
Policy-Head-Sha256: <head 的 ci/policy.json 原始字节 SHA-256>
Policy-Reason: 调整 Hermes 任务时限；见 ADR 0168
```

验签逻辑：

1. 从 `base` 取出 `ci/policy-allowed-signers`；不存在就失败（`CI_POLICY_TRUST_ANCHOR_MISSING`）。
2. 用这个信任锚运行 `git -c gpg.ssh.allowedSignersFile=<base 文件> verify-commit <head>`；失败则 `CI_POLICY_SIGNATURE_INVALID`。
3. 解析 head 提交消息中的 `Policy-Approval: v1` 和两个摘要。
4. 重新计算 `git show base:ci/policy.json` 和 `git show head:ci/policy.json` 的 SHA-256，必须与尾注一致。
5. 要求 `head` 就是本次 PR 的 head（PR 事件取 `payload.pull_request.head.sha`；push 事件取 merge commit 的第二父提交），不接受任意祖先。
6. 不设过期时间。签名绑定的是不可变 commit SHA，本身不会重放到别的变更；这样也避免把“当前时间”引入判定，保证同一 commit 每次验签结果相同。

这解决了“评论作者是仓库所有者”不能证明本人的问题：**签名与 GitHub 账号无关，私钥不在代理手里就无法伪造**。GitHub 的 “Verified” 徽章本身不够，因为 GitHub 是按“加到账号上的公钥”验签；如果代理能给账号加 key，徽章就不能作为人证。所以我们固定 `ci/policy-allowed-signers` 里的公钥指纹，而不是只查 GitHub API 的 `verified`。

### 2.2 政策读取：accepted / tested / head 三份，effective 只能来自 tested

新增/改造 `resolvePolicySource({ root, base, tested, head })`：

- `accepted`：`base` 上的 `ci/policy.json`，用**base 同一提交里的 schema**校验。这样旧政策不会被新 schema 或新常量判死。
- `tested`：实际运行提交（PR 的 merge commit，或 push 的 merge commit）上的政策。它是这次真正要执行的政策。
- `head`：PR head；只用于验签和确认签名内容与实际执行内容一致。
- `proposed = tested`。不要用 PR 分支的 head 政策代替 merge 结果：如果 main 已经前进、PR 分支还没 rebase，head 上的政策可能只是旧值；此时 merge 结果里的政策才是实际要运行的。
- `delta = accepted` 与 `proposed` 语义不同。
- 如果 `delta` 为空：不需要授权，`effective = proposed = accepted`，普通 PR 行为不变。
- 如果 `delta` 非空：
  - 必须验签成功；
  - 必须 `head` 上的政策与 `proposed`（tested）一致，否则 `CI_POLICY_MERGE_MISMATCH`，要求 rebase 后重新签名；
  - `effective = proposed`。
- 如果 `delta` 非空但验签失败：`CI_POLICY_CHANGE_UNAUTHORIZED`，列出变更路径和需要签名的摘要。

这样：
- **功能 PR 改政策但不签名** → 直接失败，不能自己放宽规则。
- **合法政策 PR 签名** → `effective` 使用新政策，自己的 `policy` 检查通过。
- **合并后 main 第一次运行** → `base = payload.before`（旧政策），`tested = merge commit`，`head = parents[1]`（已签名 PR head）；验签通过后 `effective = 新政策`，不再出现 `Unexpected timeout: policy`。

### 2.3 去掉一次性迁移，改成结构校验 + 授权差异

要删除的现有代码：

- `check-policy.mjs:43-46` 的 `timeoutMinutesFor`
- `:48-51` 的 `hostedTimeoutMinutesFor`
- `:53-72` 的 `upgradeHostedRunnerPolicy`
- `:76-84` 的 `allowLegacyCoverage`
- `:124-142` 的 `allowLegacyIntegration` 特例
- `resolvePolicySource` 里 `:985-1002` 的 integration worker limits、coverage projects 专用迁移

替换为“稳定不变量”校验：

- 校验政策时使用**该提交自己的 schema**：base 用 `git show base:ci/policy.schema.json`，head/tested 用工作区 schema。
- `validatePolicy` 只检查：
  - check ID 唯一；必须存在 `policy` 和 `required`；
  - `required.needs` 恰好是其他所有 check；`policy.needs` 为空；DAG 无环且引用存在；
  - member key 唯一、非空；`paused` 只允许 macOS；每个 check 至少一个未暂停成员；
  - platform 字段与 runner/os/arch 一致；
  - `projects`、`outputs` 不重复，`projects` 引用已声明测试项目；
  - 具体超时值只受 schema 的 `1..120` 约束，不再由代码常量决定。
- 具体“当前应该是什么值”不再写死在代码里；它由 `accepted` 与 `proposed` 的差异 + Owner 签名来保护。这正好把“防篡改”交给授权，把“结构合法”留给代码。
- 对 `checks` 的 `minItems: 9`（`ci/policy.schema.json:104`）如果确实要支持删除检查项，应放宽到至少包含 `policy` 和 `required`，并由不变量校验保证结构；新增**全新执行逻辑**的检查仍然需要执行器代码，但不再需要为旧值写兼容迁移。

### 2.4 所有消费方统一使用 effective 政策摘要

这是最容易出 I-73 类问题的地方：`policySha256` 从“目标分支政策摘要”变成“实际执行的政策摘要”后，每一个产生和使用它的地方都必须同步。

需要一起改并核对的地方：

- `scripts/ci/context.mjs:130-145`：调用 `resolvePolicySource({base, tested: testedSha, head: headSha})`，`policySha256` 写 effective。
- `scripts/ci/run.mjs:86`：同样传三个 SHA；`policy` 子进程增加 `--head context.headSha`。
- `scripts/ci/check-policy.mjs:1122-1140`：`main` 接受 `--head`；不再调用 `validateWorkflow(source.policy)` 去校验 base 政策；改为只校验 `effective` 政策与 workflow 自洽；如果 `delta` 非空且未授权，直接报 `CI_POLICY_CHANGE_UNAUTHORIZED`。
- `scripts/ci/aggregate.mjs:285-290`、`check-coverage.mjs:523-528`、`required.mjs`、`security-exceptions.mjs:198`、`export-evidence.mjs:113-115`、`test.mjs:27`：全部用同一组 `{base, tested, head}`，并比较同一个 `policySha256`。
- `scripts/ci/main-evidence.mjs:164`：轻量确认仍比较当前 main 上的政策摘要。由于政策变更时 `MAIN_VALIDATION_CHANGED` 已经强制走完整 CI，轻量路径不会遇到“刚改政策”的情况；普通 PR 的 effective 等于目标分支政策，比较仍成立。
- `scripts/ci/coverage-model.mjs:evaluateCoverage`：把“Owner 已授权本次差异”传进去，替代 `approvedThresholdTransition` 里写死的 80/70 特例；授权变更时允许使用 proposed 阈值，但仍要求 accepted baseline 存在、仍要求相同策略的可比测量。
- `scripts/ci/main-evidence.mjs:59-71`：如果受保护路径扩大到 `vitest.workspace.ts` 等，`MAIN_VALIDATION_CHANGED` 的路径集合也要同步扩大，否则 main 可能错误走轻量确认。

### 2.5 main 第一次运行为什么会好

以 PR 259 类的变更为例：

1. PR 运行：`base = 当前 main`（旧 30/45），`tested = PR merge commit`（新 60/90），`head = PR head`（Andy 已签名）。
2. `resolvePolicySource` 看到 `delta` 非空，验签成功，`effective = 新政策`。
3. `validateWorkflow(effective, ci.yml)` 自洽通过；不再拿旧政策去要求新 workflow。
4. 合并后 `push`：`base = payload.before`（旧政策），`tested = merge commit`，`head = parents[1]`（同一个已签名 PR head）。
5. 同样验签成功，`effective = 新政策`，第一次 main 运行通过。

如果未签名就合并，第一次 main 运行会明确失败 `CI_POLICY_CHANGE_UNAUTHORIZED`。这比“必然因为旧值失败”更准确：失败原因就是“这次政策变更没有 Owner 授权”。

### 2.6 可选加固：把授权检查放到 base 定义的工作流

上面的方案仍然有一个题目已点明的边界：PR 可以修改 `check-policy.mjs` 或 `ci.yml` 本身；签名能证明 Andy 批准了这棵树，但**未签名 PR 仍可把验签代码改成永远通过**。完整设计文档 `:280` 已经承认这个边界：

> “同仓库 writer 及外部 PR 都能提议修改 workflow、政策和汇总器，绑定 GitHub Actions 来源不能证明执行逻辑未被修改。当前采用可信 Owner 审阅这一边界……需要独立可信 CI 控制面时另立设计，不能在本方案中假称已实现。”

建议分阶段：

- **第一阶段（本方案）**：在当前 `ci.yml` 内完成签名验证，解决“合法规则变更自己的 PR 和 main 首次运行失败”，并让普通功能 PR 无法在诚实代码下偷偷改政策。
- **第二阶段（等规则集要求 `ci/required` 时）**：新增一个由默认分支定义的 `pull_request_target` 工作流 `policy-authorization.yml`，只读取 PR 数据（不 checkout、不执行 PR 代码），验证签名后发布独立的 `ci/policy-authorization` 状态；把该状态加入 ruleset。这样即使 PR 修改了自己的 `ci.yml`，也无法绕过 base 定义的授权检查。GitHub 官方明确允许这种“只把 PR 代码当数据、不执行”的 `pull_request_target` 用法（见 P7 引文）。
- 同一套签名验证也应逐步替换现有 `.github/security-review-manifest.json` + 评论的“Owner 身份”检查：保留清单摘要和有效期校验，但把“是不是 Andy 本人”改为“清单是否被 Andy 的签名密钥签过”。否则共享账号问题仍然存在。

---

## 三、考虑过但不选的做法

1. **继续为每种旧值写迁移（现有做法）**
   不选。每次规则调整都要在 `resolvePolicySource` 里加一段只认旧写法的代码，正是题目要消除的维护负担；而且迁移代码本身也是新代码，仍可能被功能 PR 利用。

2. **所有检查都直接读 PR 分支的政策**
   不选。功能 PR 可以自己降低超时、阈值或删检查，直接违反设计文档 `:115` / `:225`。

3. **只靠 Owner 的 GitHub 评论批准（照搬 security-review）**
   不选为唯一证明。评论作者是账号所有人，而代理线程也使用同一账号；这不能证明是 Andy 本人。签名可以；评论只能作为辅助审计。

4. **CODEOWNERS + “Require review from Code Owners”**
   不选为唯一证明。CODEOWNERS 最终仍落到有写权限的账号；代理用同一账号批准即可。而且个人仓库无法使用 rulesets 里“按文件要求团队批准”的规则（P7 引文）。

5. **GitHub Environment 的 required reviewers**
   不选为唯一证明。官方说明“只需一名 required reviewer 批准”，且“防止自我批准”要求至少两个人；当前仓库只有 Andy 一个人类。代理若能触发并批准，仍无法区分。

6. **组织级 required workflows / 中央仓库工作流**
   不选为当前主方案。GitHub 文档说明该能力在组织或企业级配置；当前是个人仓库。即便有组织，它也只解决“运行哪份工作流”，不解决“这次政策变更由谁授权、用哪一版政策”。

7. **保留硬编码常量，只加签名授权**
   不选。签名能让旧 base 政策“不被新代码判死”，但每次改时限仍要改 `timeoutMinutesFor`，而且政策文件与代码常量重复。把具体值变成政策数据、把差异交给签名，才真正消除一次性迁移。

8. **在 main 失败后自动回滚或自动重试**
   不选。合并已发生，回滚/重试不能证明变更被 Owner 授权；正确做法是让未授权变更在 main 首次运行就明确失败。

9. **签名一个独立清单文件或 PR 评论**
   考虑过。清单/评论需要额外处理“签名后提交又改变 head”的鸡生蛋问题；直接签最终 head commit 更简单，签名天然覆盖整棵树，且可用 Git/OpenSSH 标准工具验签。若 Andy 的签名设备不适合做 commit，可退化为“对清单字节做 Ed25519 分离签名 + 清单绑定 head SHA”，验签思路相同。

---

## 四、风险、反例和验证方法

### 风险与反例

1. **私钥被代理拿到**
   这是本方案唯一的根本前提。若签名私钥在 Hermes、Mac 代理目录、CI secret 或共享 ssh-agent 中，代理可以代替 Andy 签名，方案退化为“账号审批”。必须使用专用签名密钥 + 硬件令牌/PIN/touch，且不放在任何代理可访问的位置。

2. **信任锚首次引入无法自证**
   第一次把 `ci/policy-allowed-signers` 放进仓库时，新的验签机制还没有被目标分支接受。这一笔必须由 Andy 直接用 owner 权限完成（或线下核对公钥指纹），作为一次性 bootstrap，并在 ADR 记录指纹。不能做成“PR 自己引入公钥并自签就通过”。

3. **未签名 PR 修改验签代码**
   第一阶段无法完全阻止能改 CI 代码的 writer；这与设计文档 `:280` 的既有边界一致。缓解是第二阶段的 base 定义 `pull_request_target` 检查，或外部 CI 控制面。不要在本方案里宣称已经解决。

4. **squash/rebase 合并**
   会丢掉已签名的 PR head，main 首次运行无法验签。当前 `main-evidence` 已要求两父 merge commit（P6）。需要明确：政策变更 PR 只能 merge commit；若使用 squash/rebase，必须重新在 main 上签名或以 break-glass 处理。

5. **main 在政策 PR 合并前又落了另一个政策变更**
   签名尾注里的 `Policy-Base-Sha256` 会与新的目标分支政策不一致，验签失败。这是正确的 fail-closed；处理方式是 rebase 后重新签名，不要放宽成“忽略 base 差异”。

6. **政策 PR 夹带产品代码**
   签名覆盖整棵树，Andy 可能在签名时无意批准产品变更。建议同时要求：带 `Policy-Approval` 的提交，其 base..head 差异只能落在治理路径（`ci/**`、`.github/workflows/**`、`scripts/ci/**`、`vitest.workspace.ts`、ADR/计划/工具测试等），否则拒绝。这是“独立政策变更”规则的机器化。

7. **摘要语义漂移（最像 I-73 的风险）**
   `policySha256` 从 accepted 变成 effective 后，如果只改 `context.mjs` 而漏掉 `aggregate`、`check-coverage`、`required`、`export-evidence`、`main-evidence`，会出现“报告身份看起来一致、实际政策不同”的问题。必须做端到端测试，而不只是单测 `resolvePolicySource`。

8. **Hermes 工具版本**
   SSH 验签需要 Git ≥ 2.34 和 `ssh-keygen -Y`；当前工具链锁文件未证明包含这个最低版本。上线前在 Hermes 上实际执行 `git --version`、`ssh-keygen -Y` 验证；不满足就改用 GPG 或升级固定工具。

### 自动检查与反向用例

新增/修改测试，放在 `test/tooling/`（属于 `tooling` project，会进 `policy` 检查）：

- 新增 `test/tooling/policy-approval.test.mjs`
  - 合法签名：base 旧时限（30/45）→ head 新时限（60/90），head 用测试密钥签名；`policyMain` 通过，`effective` 是新政策。
  - **反向用例（旧代码必失败）**：同样的 fixture 不加签名或删掉授权代码，必须报 `CI_POLICY_CHANGE_UNAUTHORIZED`；在改动前的 `check-policy.mjs` 上运行同一测试会报 `Unexpected timeout: policy`，证明旧实现确实失败。
  - 错误密钥、head 被替换、签名后追加未签名提交、尾注摘要不符、base 政策已变化：逐项失败。
  - PR 修改 `ci/policy-allowed-signers` 自签：失败（因为信任锚从 base 读取）。
- 修改 `test/tooling/context.test.mjs`
  - 构造 `push`：`before` 是旧政策，merge commit 第二父是已签名 head；`createContext` 的 `policySha256` 等于新政策摘要。
  - 不加签名：`createContext` 失败 `CI_POLICY_CHANGE_UNAUTHORIZED`。
  - **反向用例**：改动前的 `context.mjs` 在同一 fixture 上会因旧 base 政策报超时/政策不符，证明 main 首次运行问题真实存在。
- 修改 `test/tooling/policy.test.mjs`
  - 删除或更新现有 `upgradeHostedRunnerPolicy` 测试（`policy.test.mjs:675-726` 等）。
  - 新增：授权变更超时、增删检查项、改变矩阵/项目；未授权对应变更失败。
  - 新增：base 旧 schema / head 新 schema 不再需要迁移代码即可读取。
- 修改 `test/tooling/ci-optimization.test.mjs`
  - 保留“旧值被拒绝”的反向断言（当前是 90→45），改为验证未授权变更被拒、授权变更通过。
- 端到端身份测试
  - 用 `runCheck`/`aggregate`/`check-coverage`/`required` 的真实路径构造一个授权 PR 的 context，确认所有消费者都接受同一个 `policySha256`；再故意篡改一个消费者使用的 context，必须失败。
- 负向路径覆盖测试
  - 授权后 main 前进导致 `Policy-Base-Sha256` 不符；squash 合并导致 head 不是第二父；未签名 head；签名密钥从 head 读取（应失败）。
- 反向验证记录
  - 在 ADR 中明确记录：把新增验证代码临时移除后，上述“合法变更”用例会失败；恢复后通过。不能只写“测试通过”。

### 需要人拍板的取舍

1. **Andy 是否接受“每个政策变更签一次最终 head commit”的操作成本**，以及签名私钥是否放在硬件令牌上。若不接受，只能退化为“签名清单 + 评论”，但仍需要一个人工持有的密钥，不能回到账号审批。
2. **受保护路径的范围**：只覆盖 `ci/policy.json`、coverage 政策、两个 workflow，还是也覆盖 `scripts/ci/**`、`ci/*.schema.json`、`vitest.workspace.ts`？范围越宽越安全，但普通 CI 工具改动也需要签名。
3. **是否现在就做第二阶段的 base 定义 `pull_request_target` 授权检查**，还是等规则集真正要求 `ci/required` 时再做。后者更省事，但在那之前无法防“未签名 PR 直接改验签代码”。
4. **是否同时改造现有 security-review 审批入口**：保留评论作为审计，但把“作者是 owner”换成一个对清单字节的签名。否则共享账号问题仍然存在。
5. **是否强制政策变更 PR 只包含治理路径**，以及是否禁止 squash/rebase 合并政策 PR。若不强制，签名的整棵树可能包含未审查的产品代码。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 这次改动只涉及 CI 政策读取、Git 验签和 CI 报告字段，不触及系统提示、工具定义、历史消息、遮盖结果或模型请求组装。

依据：
- `.claude/rules/prompt-prefix.md:16-19` 要求“已经发给过模型的内容，不得改动、不得重排、不得删除，只能在末尾追加”“每轮都会变的内容放在最末尾”。
- 代码层面，`check-policy.mjs`、`context.mjs`、`aggregate.mjs` 等只被 `scripts/ci/*` 和 `test/tooling/*` 引用（对 `.mjs` 的检索结果），没有进入模型请求构造路径。
- 新增的 commit SHA、`Policy-Approval` 尾注、`policySha256` 都是 CI 内部证据，不会作为系统提示或工具定义发给模型。

所以“发给模型的内容仍然只在末尾追加、每轮变化的值都在最后一条消息里”这一性质不受影响；本次改动不需要按 prompt-prefix 规则重新出方案。若未来要把授权结果展示给模型，它属于每轮变化的数据，必须只放在最后一条用户消息里。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会影响模型请求；CI 内部也保持确定性。** 新方案不引入“当前时间”“过期判定”“随机 ID”或“依赖前后文的遮盖”来决定政策是否有效：
- 授权绑定不可变 commit SHA 和 `ci/policy.json` 的原始字节 SHA-256；同一 commit、同一 base 每次计算结果相同。
- 不设置有效期，避免“同一变更今天有效、明天失效”的时间依赖。
- 变更路径列表、检查 ID 列表在输出前排序，避免集合顺序造成字节差异。
- 遮盖逻辑 `security-redaction.mjs` 不修改。

唯一会变化的是 CI 运行身份里的 `runId`/`attempt`，这是现有 `Context` 已有字段，只写入 CI 报告，不进入模型请求。结论：模型看到的字节不变；CI 侧新值是可复现的。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，而且反向用例必须证明旧实现失败。** 具体检查见上文“自动检查与反向用例”：
- 合法授权变更：旧 base 政策 + 新 head 政策，签名后 `policyMain` 通过。
- 反向用例一：同一 fixture **不加签名**，必须报 `CI_POLICY_CHANGE_UNAUTHORIZED`；在改动前的 `check-policy.mjs` 上会报 `Unexpected timeout: policy`，证明旧代码确实失败。
- 反向用例二：`push` 首次运行，`base=payload.before` 旧政策、`tested=merge commit` 新政策、`head=第二父` 已签名，`createContext` 通过；不加签名则失败。改动前的 `context.mjs` 在同一 fixture 上会失败，证明 main 首次运行问题真实存在。
- 反向用例三：签名后追加提交、换 key、改 `ci/policy-allowed-signers` 自签、尾注摘要不符、main 前进导致 base 政策 hash 不符，逐项必须失败。
- 端到端用例：把授权 PR 的 context 喂给 `aggregate`、`check-coverage`、`required`、`export-evidence`，确认 `policySha256` 一致；故意混用不同 base/head 的 context 必须失败。
- 测试入口：`tooling` project（`test/tooling/**/*.test.mjs`）已经由 `policy` 检查执行；新增测试会自动进入 `ci/required` 的证据链。

### 4. 每个新值/修改值，产生它的地方和使用它的地方都能接受吗？

按 I-73 的教训，逐个列出“产生 → 消费 → 两端校验”：

| 值/字段 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `Policy-Approval: v1`、`Policy-Base-Sha256`、`Policy-Head-Sha256` | Andy 签名的最终 head commit 消息 | 新 `policy-authorization.mjs` | 验签用 base 的 `ci/policy-allowed-signers`；重新计算 base/head 政策字节摘要；head 必须等于 context.headSha；不符即失败 |
| `ci/policy-allowed-signers` | Owner 在 base 提交（首次 bootstrap 或旧 key 签名的轮换） | 验签器 | 只从 base 读取，不从 head 读取；缺失失败；格式由 `git verify-commit`/`ssh-keygen` 校验；测试自签/替换 key 必须失败 |
| `--head` CLI 参数 | `run.mjs` 从 `context.headSha` 传入 | `check-policy.mjs main` | 两边都校验 40 位十六进制；缺失时本地模式回退 `HEAD`；CI 模式必须显式传入；测试 head 不匹配 |
| `policySha256`（语义改为 effective） | `resolvePolicySource` | `context.mjs`、`run.mjs`、`aggregate.mjs`、`check-coverage.mjs`、`required.mjs`、`export-evidence.mjs`、`main-evidence.mjs`、`ci/result.schema.json`、`ci/evidence.schema.json` | 所有消费者必须传同一组 `{base, tested, head}`；schema 仍只要求 64 位 hex；端到端混用 context 测试必须失败 |
| `coverage` accepted vs effective | `resolvePolicySource({base, tested, head})` | `check-coverage.mjs`、`run.mjs` 的 comparison、`coverage-comparison.mjs` | authorized 时允许 proposed 阈值但仍要求 accepted baseline；未授权阈值变更失败；专利迁移 `approvedThresholdTransition` 删除后由授权替代 |
| 删除的 `timeoutMinutesFor`、`upgradeHostedRunnerPolicy` | 旧 `check-policy.mjs` | 仅 `test/tooling/policy.test.mjs` | 更新 import 和测试；运行 `npm run check:ci-policy` 与 tooling 全量确认没有悬空引用 |
| `checks.minItems` 若从 9 放宽 | `ci/policy.schema.json` | `validateRecord("CheckPolicy")`、`validatePolicy`、`validateWorkflow`、`aggregate`、`main-evidence` | 新增/删除检查项的测试必须让这些消费者都能接受；`required.needs` 仍由不变量校验 |
| `MAIN_VALIDATION_CHANGED` 的路径集合若扩大 | `main-evidence.mjs` | main 的 `plan` 路径选择 | 受保护路径（如 `vitest.workspace.ts`）变化时必须走完整 CI；测试该文件变化不能走轻量确认 |
| 新错误码 `CI_POLICY_CHANGE_UNAUTHORIZED`、`CI_POLICY_SIGNATURE_INVALID`、`CI_POLICY_MERGE_MISMATCH`、`CI_POLICY_TRUST_ANCHOR_MISSING` | 验签/政策读取 | 测试、CI 日志、失败诊断 | 只作为错误输出，不写入 `Context`/`GateSummary`；不需要 schema 变更；测试断言错误码 |

为了减少 I-73 类风险，本方案**不新增 `Context` 或 `GateSummary` 字段**：授权审计就是那个已签名的 commit 本身；CI 报告继续使用现有 `policySha256`，只是它的语义从“base 政策”改成“实际执行的 effective 政策”。这样不会把一个新 ID 塞进后端或汇总器的闭集 schema 而忘记同步校验。
