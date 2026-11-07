## 结论

改动本身很小，而且我逐项核对后确认：删除的 10 条与 Owner 复核清单的路径、摘要、次数（current+history）都对得上，合并后合并清单确实不再重复（65 条）。但作者对“检查读哪份清单”的描述不准确，导致选了一条**引入该改动的提交自己永远过不了 security 门禁**的修复路径；合并后的第一个 main push 也会再失败一次。详见下面第 1 条。

## 发现（按严重度）

### 1（高）删除基准文件不能使“引入删除的提交”通过门禁，合并后的首个 main push 也会失败

文件:行：`scripts/ci/security-exceptions.mjs:207-222`、`scripts/ci/context.mjs:109-111`、`.github/workflows/ci.yml:437-499`、`.github/workflows/main.yml:61-68`

问题：`loadReviewedExceptions` 的合并清单来自**基准提交**的 `ci/security-exceptions.json`，只有 Owner 复核清单来自工作树：

```js
// scripts/ci/security-exceptions.mjs:207
const bytes = available ? git(root, ["show", `${context.baseSha}:${exceptionPath}`]) : candidate;
...
// :218
const combined = [...exceptions, ...ownerReview.exceptions];
validateSecurityExceptions({ schemaVersion: 1, exceptions: combined }, ...);
```

所以：
- PR 运行时 `context.baseSha = parents[0]`，即 main 旧提交 `bc380a6e`，它仍含这 10 条；候选项里的删除**不参与**合并，合并后仍与复核清单重复 → `SECURITY_EXCEPTION_DUPLICATE`（`security-exceptions.mjs:184`）。作者第 3 条只说“本 PR 自己会失败”，属实。
- 合并后 push 到 main 时，`context.mjs:109-111` 用 `payload.before` 当基准，即**删除前的 main**；工作树里的复核清单仍是旧的 10 条 → 同样重复。于是 main 的 `main.yml` 无论走 `full`（复用 `ci.yml`，push 事件）还是 `confirm`（`main-confirm.mjs:35` → `createContext` 仍取 `payload.before`），security 都会失败；`ci.yml` 的 `ci/required` 又 `needs: security`（`:491-499`）。
- 只有当下一次提交把这次删除作为基准时（`base = 4b2fbbc`）才会通过。作者第 4 条“本提交为基准时通过（65 条）”在数据上成立，但这**不是任何一次真实门禁运行的基准**。

也就是说，作者第 3 条“合并后其他 PR 才通过”是真的，但漏掉了“合并提交自己的 main 确认会失败、main 会红一次”，且本 PR 必须在 security 红灯下被合并。若 `ci/required` 是分支保护必需检查，本 PR 只能靠绕过门禁合并（branch protection 不在仓库内，未能核实）。

建议（按可行性）：
- 若 Owner 能重新签发：**不要改 `ci/security-exceptions.json`，改 `.github/security-review-manifest.json`**——去掉这 21 条（10 current + 11 history），并让 `.github/security-review-comment.json` 指向本 PR 上 Owner 签发的新审批评论（`security-owner-review.mjs:120-201` 读取的是**工作树**的 manifest/comment，`manifestSha256` 绑定新 manifest 字节）。这样 base 的 10 条保留覆盖到 2026-12-04，PR 与 main push 都能同时通过。
- 若 manifest 确定不能改：在 `loadReviewedExceptions` 中实现“覆盖转移”规则——候选项删除的 base 身份，只有在 Owner 复核清单里存在**完全一致**（id/path/digest/count/历史提交一致）的条目时才允许去除，否则仍报错。并补测试。单纯删 base 文件无法解决引入提交的门禁问题。
- 说明：作者“复核清单不能改”的前提过于绝对。代码并不把 manifest 视为不可变，只要求新 manifest 有新 Owner 评论的 `manifestSha256` 签名（`security-owner-review.mjs:181-201`）。

### 2（中）这次数据改动没有真实数据回归测试，相关反向用例只覆盖合成夹具

文件:行：`test/tooling/security.test.mjs:418-425`、`test/tooling/security-review.test.mjs:14-82`、`test/tooling/security-published.test.mjs:282-287`

问题：现有“重复记录拒绝”用例用的是本地构造的 `exception()`：

```js
it("重复记录拒绝", () => {
  expect(() => validateSecurityExceptions(
    { schemaVersion: 1, exceptions: [exception(), exception()] }, ...
  )).toThrow("SECURITY_EXCEPTION_DUPLICATE");
});
```

没有任何测试加载真实的 `ci/security-exceptions.json` + `.github/security-review-manifest.json`（并用 mock 的 `readReviewComment`）来断言：合并后 65 条、无重复、且被删的 10 条仍被复核清单覆盖。作者第 4 条的 CI VPS 验证是手工的，没有落成仓库检查；因此若删错一条（例如删了清单里没有的路径），只有等实际门禁（恰是当前坏掉的那道）发现。反向用例“重复时必须失败”本身存在，但针对本次改动的反向用例“漏删/多删/覆盖丢失必须失败”不存在。

建议：加一条 tooling 测试，复制真实 `ci/` 与 `.github/`，mock 审批正文，调用 `loadReviewedExceptions`，断言 `65`、无重复；再反向断言：把任一被删条目加回 base 会抛 `SECURITY_EXCEPTION_DUPLICATE`，或删掉一条仍被 base 依赖的条目会因覆盖丢失而失败。

### 3（中低）这 10 个位置从“base+复核双源覆盖”变为只依赖外部 GitHub 审批评论，且到期提前一天

文件:行：`scripts/ci/security-owner-review.mjs:190-201,214`、`docs/backlog/BL-20261003-001-ci-安-全-例-外-到-期-后.md:66`

复核生成的例外统一使用评论的到期日：

```js
expiresAt: approval.expiresAt,
```

文档记录该审批为 `2026-12-03T00:00:00Z`，而被删的 10 条 base 条目是 `2026-12-04`。由于 `loadOwnerReview` 只要两个 `.github` 文件存在就会强制校验评论（缺失/过期/网络失败直接抛错），整份检查本来就会在 2026-12-03 失败，所以这不算新增的独立失败模式；但“这 10 条还有 base 兜底”的独立性没有了。作者第 2 条“到期后整份复核本来就要续”属实（审批正文在 GitHub，仓库内只能由文档佐证，未直接核实）。

建议：PR 描述或续期计划里明确写出“这 10 条现在完全依赖 PR 4 审批评论”；如要保留双源兜底，采用第 1 条中“改 manifest、留 base”的方案。

### 4（低/信息）冻结证据文件里的旧摘要已过期，但确实不参与检查；proposal 说明文字未更新

文件:行：`ci/security-exceptions.json:7`、`test/qualification/evidence/.../frozen-inputs.json:205` 等

- 作者第 5 条基本属实：这些 `af0beef3…` 摘要是静态证据，grep 未发现任何脚本/测试把它们与当前文件比对，故不影响检查。但当前文件摘要已变，未来若有人按“冻结输入”重新核验会不一致。
- 文件顶部 `proposal.reviewEvidence` 仍写着“同日新增 13 条 synthetic-boot-token 例外”，删掉 10 条后 base 里只剩 5 条 3eb1bd 条目（另外 10 条移到复核清单）。这是历史叙述，不等于当前事实，但读者容易误读；本次改动本身也未在文件内留下“去重”的说明。

## 侧重检查

- 错误路径：重复检测（`security-exceptions.mjs:176-185`）、到期（`:136-142`）、复核缺失/PR 不匹配（`security-owner-review.mjs:153-159,176-201`）。结论：删除后 `base=本提交` 的重复错误消失；但引入提交的 PR/ main push 仍会走进重复错误路径。
- 不可信输入：manifest/评论仍来自解析后的 JSON 与 GitHub API，改动没有新增输入面；错误码化、大小限制、身份校验均未变。
- 安全：没有新增真实凭据豁免；10 条都是 `synthetic-boot-token`（`tokenValue` + 16 字节重复十六进制），清单行我逐条核对命中。主要安全风险是“在 security 红灯下合并、绕过第 1 条所述门禁”，以及这 10 条失去 base 兜底。
- 资源耗尽：无新增循环/分配/网络重试；不涉及。
- 不可撤销操作：文件删除可由 revert 恢复；真正不可逆的是“绕过必需检查合并”这一操作记录。
- 规则/文档一致性：`prompt-prefix` 规则不适用于本改动（见必答 1）。`docs/incidents-and-gates.md:112`（I-73）强调“清单里的 id 能否通过后端校验”，这里对应的是“被删的值每个消费方能否接受”，已逐项核对。设计文档说常规例外从目标分支读取、候选分支不能替换（`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:242`），代码与之一致；作者对“检查读基准清单”的描述则与代码不一致（base 的 exceptions 是，但 Owner manifest 是工作树）。

## 读代码证实的 / 推测

**读代码证实的**
- diff 只有一个文件、265 行删除、正好 10 个 `synthetic-secret/generic-api-key` 块（`git diff`）。
- 被删 10 条与 `.github/security-review-manifest.json:38-218` 的 id/path/digest/history commit 与次数一致；10 条的 current 行号我逐条用 `git blame e2a792f -L` 核对，全部是含 `tokenValue: "0123456789abcdef0123456789abcdef"` 的行；history 行号与删除前 base 条目完全一致。
- 剩余 base 的 16 条 synthetic + 38 条 published 与复核清单（10 synthetic + 1 published）无身份重叠；合计 65 条（16+38+10+1）。
- 合并来源是 base 的 `ci/security-exceptions.json` + 工作树的 Owner manifest；重复即抛 `SECURITY_EXCEPTION_DUPLICATE`（`security-exceptions.mjs:207-222,184`）。
- PR 的 base 是 merge commit 第一父；push 的 base 是 `payload.before`（`context.mjs:97-111`），security 是 `ci/required` 的依赖（`ci.yml:491-499`）。
- 仓库测试没有加载真实 `ci/security-exceptions.json` 的用例；冻结证据摘要没有被任何脚本读取。

**推测/未核实**
- `ci/required` 是否被设为分支保护必需检查（仓库内看不到设置）。
- 团队是否打算用管理员权限在 security 红灯下合并本 PR（作者第 3 条只说明会失败）。
- 作者第 4 条中 `27e1d332` 为基准时抛重复、以及 CI VPS 上“65 条通过”的实跑结果（工具限制，未运行脚本）。
- 审批评论的 `expiresAt=2026-12-03` 只由 `docs/backlog/...:66` 佐证，评论正文不在仓库。

## 必答问题

1. **是否改变模型已见过的请求开头？** 不会。`ci/security-exceptions.json` 只被 `scripts/ci/*`、文档和 tooling 测试引用，`apps/`、`packages/` 下没有任何引用（grep 已核）；它不参与系统提示、工具定义、历史或遮盖。发给模型的内容仍只在末尾追加；本次也没有新增“每轮会变的值”。（对照 `.claude/rules/prompt-prefix.md:27-28,35`；该规则适用于提示词/请求组装，本次改动不在其中。）security 报告里的 `scannedAt/completedAt`（`check-security.mjs:725-726`）是 CI 产物，不是模型请求，且改动前已存在。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。改动是静态 JSON 的固定删除；合并顺序固定为 `[...baseExceptions, ...ownerReview.exceptions]`，哈希是同样的字节计算（`security-exceptions.mjs:218,232`）；没有引入时间、随机数、对象遍历顺序或依赖后文的遮盖。`now` 只影响“接受/拒绝”，不改变被序列化的数据字节。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有通用重复检测的自动用例（`security.test.mjs:418-425`、`security-published.test.mjs:282-287`），这些反向用例确实会失败（抛 `SECURITY_EXCEPTION_DUPLICATE`）。但**没有针对本次真实数据的自动检查**：没有测试加载真实 base + 真实 manifest 断言“无重复且被删的 10 条仍被覆盖”；作者的真实校验是手工的。因此“删错/漏删”的反向场景不会被仓库测试捕获。
4. **改动产生/修改的每个值，所有使用方都能接受吗？**
   - 产生方：被删的 10 个身份来自 `ci/security-exceptions.json`（已删）；替代值是 `.github/security-review-manifest.json:38-218` 经 `loadOwnerReview` 生成的 10 条 `synthetic-secret`（count 2/2/2/2/2/2/2/2/3/2）与 1 条 published，合计与 base 相同。
   - 使用方：`validateSecurityExceptions`（身份去重、count=current+history 求和、history commit 不重复）接受；`applySecurityExceptions`/`verifySyntheticProvenance`（按 id/path/digest 匹配，逐 scope 限额，重建字面量）接受——10 条的 manifest current 行我在 `e2a792f` 上逐条确认能重建 token；`security-published-fixtures.mjs` 只消费 published，不受影响；schema 只要求数组非空、单项字段合法，无固定条数，接受；测试不读取真实文件，接受。
   - 需要注意的差异：被删条目的 `expiresAt` 是 2026-12-04，复核生成的是 2026-12-03（提前一天）；`reviewReference` 从 commit URL 变为 PR 4 评论 URL，schema 正则接受。所有消费方都能接受这两个变化，但覆盖的独立性下降（见发现 3）。
   - 唯一“不接受”的消费方是**引入提交自己的 CI 门禁**：它读 base 的旧清单，仍会拒绝（见发现 1）。这正是 I-73 要求的“逐个找到产生它的地方和使用它的地方”的核心结论——数据两端一致，但门禁读取的时序不一致。
