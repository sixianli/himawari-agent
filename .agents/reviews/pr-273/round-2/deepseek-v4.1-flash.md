# PR 273 第 2 轮复核结论

先说明：本次复核在读代码阶段到达了工具调用上限，以下结论全部基于**已亲自读到的内容**；未能读到的部分明确标为「未核实」。我不再调用任何工具。

## 一、读代码证实的结论

### 高：`npm run check` 根本不会执行这个新测试

- `package.json:26`：`"check": "node scripts/run-all-checks.mjs"`；`scripts/run-all-checks.mjs:32` 只展开 `check:steps` 里的步骤。
- `package.json:27` 的 39 步中没有 `test`，也没有任何会加载 `test/tooling/security-review.test.mjs` 的步骤（`check:ci-policy` 是 `scripts/ci/check-policy.mjs` 的 policy 静态校验；`check:check-runner` 只跑 `test/tooling/run-all-checks.test.mjs`）。
- 该测试只会在 `npm test`（`package.json:69`，`scripts/ci/local.mjs --check test`）或直接 `vitest` 时执行。
- 影响：第 1 轮意见是「本地检查不会发现」。如果「本地检查」指 `npm run check`，这次修改**没有**把回归测试接进去；作者说法第 3 条「`npm run check` 39 步全过」本身成立，但恰好说明这 39 步不含新测试，不能证明该测试在本地门禁里跑过。
- 建议：把 `security-review.test.mjs` 加入某个 `check:*` 步骤（或让 `check:ci-policy`/新增 `check:security-review` 运行它）并更新 `check:steps`；否则至少明确「本地检查」= `npm test`。

### 中：第二个用例只复现「重复已进入 base/HEAD」的状态，没覆盖 PR 引入路径

- `scripts/ci/context.mjs:97-108`：PR 事件下 `headSha = payload.pull_request.head.sha`，`baseSha = parents[0]`（目标分支侧第一个父提交），不是 PR head。
- `scripts/ci/security-exceptions.mjs:201-207`：`available`/`bytes` 取自 `context.baseSha`；`204` 的 `candidate` 读工作区文件；`209` 只对 `bytes`（base）单独校验；`218` 的 `combined` 是 `[...bytes 的 exceptions, ...ownerReview.exceptions]`，**不包含 candidate**。
- 因此：在一个 PR 里把复核清单已覆盖的条目加进 `ci/security-exceptions.json` 时，`candidate` 内部不重复、`bytes`（base）里没有、`combined` 也不含它，**该 PR 的 security 检查不会报 DUPLICATE**；要等它合入成为后续 PR 的 base（或 push 后的下一次 base）才会报。
- 新测试第二个用例在临时克隆里提交后 `committedReview(root)` 把 `baseSha = head`（新提交），模拟的是「已经进入 HEAD」这一状态，所以它能通过；但它不是 PR 场景。作者说法第 2 条只说「加回例外清单并提交，断言报 DUPLICATE」，字面属实；但若把它当作「能拦下 PR 引入重复」，不成立。
- 依据对应问题：这正是 I-73 的教训——只看改动本身，没有核对「清单/文件在真实调用点的两端口径」。
- 建议：加一个 `baseSha != headSha` 的用例，工作区 candidate 含重复、base 不含，断言实际调用点（`check-security` 的 PR 口径）是否报错；若确实不报，这就是检查逻辑缺口，应在 `loadReviewedExceptions` 中把 candidate 也纳入 `combined`（作者说「不改检查逻辑」，那就要在 PR 描述里承认这是遗留缺口，而不是宣称已修复）。

### 中：`reviewedAt` 回退到提交时间会产生「假通过」

- `test/tooling/security-review.test.mjs:308-312`：`reviewedAt = proposal.proposedAt ?? git log -1 --format=%cI HEAD -- ci/security-exceptions.json`。
- `validateSecurityExceptions`（`scripts/ci/security-exceptions.mjs:113-142`）用传入的 `now` 判断过期；测试把 `now` 设成 `reviewedAt`（`options.now`），而不是真实当前时间。
- 后果：现在是 2026-11-04 之后，文件里的例外 2026-12-04 到期；一旦 propos 被删掉，回退到提交时间（可能早于今天），测试仍会通过，即使真实 CI 的 security 检查早已因 `SECURITY_EXCEPTION_EXPIRED` 失败。测试因此不能反映真实时效。
- 关于「回退是否不稳定」：`expiresAt = reviewedAt + 2d` 再截到当天 `T00:00:00Z`，对任意时刻仍严格大于 `reviewedAt`（最多损失不到 1 天，仍余 >1 天），所以不会出现 `expires <= now` 的抖动；但请注意 `%cI` 是**提交者时间**且带时区、可被本地环境/`GIT_AUTHOR_DATE` 影响，在极端未来/过去提交上会改变结果。属于「测试数据随环境变化」，建议固定 `now` 与 `reviewedAt`，或改用 `proposal.proposedAt` 并在缺失时显式失败/跳过，而不是静默回退。
- 建议：测试要么固定一个常量时间，要么用真实 `new Date()` 并同步接受「到期就会红」；回退分支至少加断言，避免掩盖 proposal 被删。

### 中：临时克隆依赖源仓库 HEAD 与 git 配置，存在脆弱点

- `test/tooling/security-review.test.mjs:352-356`：`git clone -q --shared --no-checkout resolve(".") root`，随后 `read-tree HEAD`、`checkout HEAD -- ci .github`。
- 可证实的风险：
  - `resolve(".")` 是进程 cwd；`scripts/ci/test.mjs:64-90` 里 vitest 的 `cwd` 是 `root`，CI 中可用；但直接 `vitest` 从子目录或打包后的无 `.git` 目录运行时，`git` 命令会失败。`test.mjs:43-52` 用 `git ls-files` 说明测试运行目录假定是带 `.git` 的仓库；本用例把这一假定进一步扩大到「HEAD 存在、远端默认分支可解析、manifest.sourceHead 在本地历史中」。
  - `--shared` 克隆会引用源仓库的 alternates；若源仓库是 shallow（CI 已 `fetch-depth: 0`，`.github/workflows/ci.yml:43` 等，故 CI 没问题），或测试被放进不含历史的工作树，`loadOwnerReview` 的 `git merge-base --is-ancestor manifest.sourceHead HEAD`（`security-owner-review.mjs:203-210`）会因对象缺失而报 `SECURITY_REVIEW_SOURCE_UNRELATED`——失败原因会被误读成审批范围问题。
  - `run("read-tree","HEAD")` 之后工作区只有 `ci` 与 `.github`；`committedReview` 又依赖 `package-lock.json`、`ci/rules/semgrep.yml`、`ci/security-exceptions.json` 的 `git show`，这些在 clone 中都有，故不构成失败；但这是隐式耦合。
- 建议：用 `git -C <root> worktree` 或直接 `git clone --no-local` 并显式 `git fetch` 所需对象；在用例开头断言 `git rev-parse HEAD`、`manifest.sourceHead` 可达（`merge-base --is-ancestor`）并在失败时给出「环境不满足」而不是安全错误；或者不依赖克隆，用 `git show` 的纯只读方式构造临时目录（避免 `commit` 依赖 git 身份/配置）。

### 低：作者说法第 1 条的「字节一致」有条件成立

- `committedReview` 的 `manifestSha256 = digest(manifestBytes)` 来自 `git show HEAD:.github/security-review-manifest.json`（`test/...:302-306`）；而 `loadOwnerReview` 的 `sha256(bytes)` 来自**工作区** `readFileSync(path)`（`security-owner-review.mjs:124,187`）。
- 两者相等的前提：工作区文件与 HEAD blob 逐字节一致，且没有换行/编码过滤。仓库根目录**没有 `.gitattributes`**（`git show HEAD:.gitattributes` 报不存在），因此在 Linux/macOS + `core.autocrlf=false` 的 CI 中通常相等；在 Windows 或本地 `core.autocrlf=true`、或测试运行前有未提交的 `.github` 修改时，会报 `SECURITY_REVIEW_SCOPE_MISMATCH`，与作者「一致」的说法只在干净 checkout 上成立。
- 建议：显式用 `git show` 的字节做 `inherited` 判定或在测试里先校验 `readFileSync === git show`，失败时给出明确的环境提示。

### 低：第一个用例的断言偏弱，删除的 10 条是否「被完全覆盖」没有逐条验证

- `test/...:344-349`：只断言 `approvalBasis === "owner_pr_comment"`、`exceptions.length > committed.length`，没有断言「被删的 10 条 identity 都出现在复核清单派生条目里」。
- 我亲自核对了 `bc380a6e..4b2fbbc2` 的删除内容与 `.github/security-review-manifest.json` 的 `kind:"secret", scope:"current"` 条目：10 个 path（production-payload-broker-client、production-worker-composition、service-main、execution-admission-uds-transport、payload-uds-transport、production-sandbox-scope、production-http-composition-process、sandbox-v2-payload-broker、sqlite-capability-invocations、sandbox-production-mac-probe）与 manifest 的 10 个 current 条目一一对应，id 都是 `generic-api-key`、digest 都是 `3eb1bd43…`，count（2/2/2/2/2/2/2/2/3/2）与 `1 + history.length` 一致。**这一点作者说法成立**。
- 但测试本身不保证这一点；以后有人再删一条未被 manifest 覆盖的例外，第一个用例仍会通过（只比较数量）。建议断言「committed 中每条 identity 都能在 reviewed 的 owner 派生集合里找到」，或直接断言 `reviewed.exceptions.length === committed.length + ownerDerived.length` 且被删条目集合匹配。

### 低：`proposal.reviewEvidence` 不参与去重，但会改变整文件摘要

- `security-exceptions.mjs:176-183` 的 identity 只含 `kind/id/path/package/version/digest`，`proposal` 不参与 → 作者说法第 4 条前半成立。
- `security-exceptions.mjs:232` 返回 `sha256(`${sha256(bytes)}:${ownerReview.sha256}`)`；`reviewEvidence` 追加会改变 `bytes` → 改变这个返回值。我已搜索到 `test/qualification/evidence/workspace-authorization-lifecycle/**` 多处把 `ci/security-exceptions.json` 的 sha256 固化为 `af0beef3…`（例如 `p1-incidents-01/frozen-inputs.json:215`）。**这些文件是否被某个 check 重新核验、是否会因本次改动而失败，我未核实**（只确认它们存在，gitleaks 白名单会忽略该目录，`gitleaks.toml:10`）。这属于 Q4「值的使用方」需要确认的项；建议作者确认这些历史冻结证据是否只作留档、不参与当前校验，否则本次改动会破坏它们。
- 另：`proposal.reviewEvidence` 无 `maxLength`（`ci/security-exceptions.schema.json:312-315` 只有 `minLength`），追加一句不会触发 schema 上限；`proposal` 的 `additionalProperties:false` 也不受影响。作者说「只在末尾追加、exceptions 数组没变」相对 `4b2fbbc2` 成立；相对 `bc380a6e` 则是删了 10 条，表述需区分基线。

## 二、推测（未完全核实）

- 推测：`git clone --shared` 在源仓库 `HEAD` 为 detached（actions/checkout 常见）时，克隆的 `HEAD` 会指向同一提交，用例可运行；但若源仓库默认分支与工作区 HEAD 不同，`rev-parse HEAD` 取的是克隆后的 HEAD，可能不是被测提交——这与 `resolve(".")` 的 checkout 状态相关，未实测。
- 推测：`loadOwnerReview` 的 `inherited` 分支（`security-owner-review.mjs:148-159`）在测试中因 `baseSha === head` 恒为 true，从而**跳过** `context.event === "pull_request"` 的 `SECURITY_REVIEW_PR_MISMATCH` 校验；新测试没有覆盖这条路径（已有旧用例 `:283-287` 覆盖，故不算回归，但作者「走过每一项校验」的表述不准确：PR 事件校验没走）。
- 推测：`git show HEAD:ci/security-exceptions.json` 返回的是 blob 原始字节（不经 smudge），与工作区在无 `.gitattributes` 时一致；若未来加入 eol 规则，测试会红。

## 三、侧重检查（错误路径/恶意输入/资源/不可逆/文档一致性）

- 错误路径：测试用 `execFileSync` 调 git，`committedReview` 的 `run` 未设 `maxBuffer`（默认 1MB），但输入是仓库内小文件，风险低；`security-exceptions.mjs` 的 `git()` 有 16MB 上限与 `PATH=/usr/bin:/bin`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`（`:24-29`），测试的 `run` **没有**这些隔离，本地全局 git 配置（如 `core.hooksPath`、`commit.gpgsign`、`core.autocrlf`）会影响临时克隆里的 `git commit`。这是可证实的差异：生产 `git` 封装有隔离，测试的 `run` 没有。
- 不可信输入：测试把 `manifest` 与 `comment.json` 当可信输入直接 `JSON.parse`，若仓库文件被篡改，会抛原生异常而非稳定错误码；作为测试可接受，但不是「按 `loadOwnerReview` 校验条件构造」的完整模拟（例如 manifest 的 `entries` 结构未在测试侧校验）。
- 资源耗尽：`git clone --shared` 会创建临时目录，`afterEach`（`:87-90`）用 `roots.splice(0)` 清理；但 `committedReview` 第一个用例用 `resolve(".")` 不加入 `roots`，不会清理（无需清理）。第二个用例 push 进 `roots`，正常。若测试中途抛异常，`afterEach` 仍执行，OK。
- 不可逆操作：只在临时目录 `git commit`，不改主仓库；没有 `push`/`reset`。安全。
- 规则/文档一致性：`docs/incidents-and-gates.md` 的 I-73 与 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:242-246` 要求「清单里的 id 能通过后端校验」与「候选分支不能自行替换例外」；新测试把 owner 派生条目写回例外文件时**确实**通过 schema（`additionalProperties:false`、`reviewReference`/`reason`/`provenance` 均被允许），这一点我核对过，没问题。但 `README.md:71` 与设计文档说「清单内容变化后需要新的明确批准」——测试用合成批准而不是真实评论，属于离线回归夹具，不违反（作者也声明 `readReviewComment` 注入、不联网）。
- 关于 Q2「同一段文字在不同请求里变成不同字节」：本改动是 CI/测试与 JSON 证据，**不进入模型请求**；`reviewEvidence` 是仓库里的固定字符串，不含时间/无序集合，不会因请求变化。唯一「随环境变」的是测试里的 `%cI` 回退与 git 配置，属于测试数据，不是发给模型的内容。

## 四、逐条回答必答问题

**1. 会不会改变模型已见过的请求开头？**
不会。改动文件是 `ci/security-exceptions.json`（CI 安全例外）与 `test/tooling/security-review.test.mjs`（测试），不被任何 prompt 组装路径读取。`reviewEvidence` 只在 schema 与文件本身出现（grep 结果仅 schema/JSON/测试/文档）。发给模型的内容是否仍只在末尾追加、每轮变化值是否只在最后一条消息——这属于 `prompt-prefix.md` 的约束，本次改动**完全没触碰** prompt 相关代码；我未读到该规则文件正文（工具上限，标「未核实」其具体条文），但从改动面看没有引入任何新的模型可见前缀。结论：不改变。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会产生「请求间字节漂移」。`reviewEvidence` 是静态字符串；例外条目是固定 JSON。唯一随时间/环境变化的是测试内部的 `reviewedAt`/`expiresAt` 计算与 `git` 配置影响，这些只影响测试的输入数据，不影响发给模型的内容。若担心仓库证据摘要，`ci/security-exceptions.json` 的 sha256 会因追加文字而变，但这只影响本地/CI 校验，不影响模型请求。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有新增两个用例，但覆盖不完整：
- 正向：`test/...:344-349` 用真实 `loadReviewedExceptions` 校验当前 HEAD 合起来不重复，属于有效回归。
- 反向：`test/...:351-380` 在临时克隆里加回一条 manifest 派生的 synthetic-secret 并 commit，确实会触发 `SECURITY_EXCEPTION_DUPLICATE`（我核对了 `validateSecurityExceptions:176-186` 的 identity 与 `loadReviewedExceptions:217-222` 的 combined 校验，路径成立）。
- **缺口**：反向用例只在 `baseSha === headSha` 下成立；真实 PR 的 `baseSha = parents[0]`（`context.mjs:108`），candidate 不进入 combined，PR 引入重复时不会报。等于说「反向用例会失败」只在「重复已在 HEAD」时成立，不能证明「PR 阶段能拦下」。
- **缺口**：`npm run check` 不执行该测试（见上），所以「本地检查」若指 `npm run check`，仍然不会发现；只有 `npm test` 会。
- 作者说法第 3 条「旧 main 27e1d332 上跑会报 DUPLICATE」：旧 main 的 `ci/security-exceptions.json` 有 10 条重复，`baseSha=/=head` 时 `bytes` 含重复，`combined` 会报 DUPLICATE，**这个具体实验成立**；但同样只证明「旧状态会红」，不证明「新 PR 引入会红」。

**4. 改动产生/修改的每个值，每个使用它的地方都能接受吗？**
- `reviewEvidence` 追加：schema 只要求 `minLength:20`，`additionalProperties:false` 也不影响；`proposal` 不参与 identity（`security-exceptions.mjs:176-183`），所以不破坏去重。**但**整文件 sha256 变化会被 `test/qualification/evidence/workspace-authorization-lifecycle/**` 中固化的 `af0beef3…` 引用；这些冻结证据是否被当前 check 重新核验，**未核实**。这是本次唯一需要作者确认的「使用方」。
- 删除的 10 条例外：每个 path/id/digest/count 都能在 `.github/security-review-manifest.json` 的 current secret 条目中找到对应，`loadOwnerReview` 会重新派生（`security-owner-review.mjs:234-268`），且 `validateSecurityExceptions` 会合并校验；我已逐条核对，**能接受**。
- 测试里写入临时例外文件的条目：来自 `loadOwnerReview` 派生结构，字段 `kind/id/path/digest/count/provenance/owner/reviewReference/expiresAt/reason` 均被 schema 允许（`ci/security-exceptions.schema.json:13-130`，`additionalProperties:false` 但字段齐全），**能通过校验**；这与 I-73 的「清单 id 能否通过后端校验」一致，没有踩坑。
- 新增的 `parse` from `yaml`、`enumerateLockDependencies` 导入：`yaml@2.8.3` 在 `package.json:105` 的 devDependencies，`enumerateLockDependencies` 在 `security-exceptions.mjs:76` 导出，**能接受**。

## 五、对作者说法的逐条核对

1. 「按 `loadOwnerReview` 校验条件构造审批、摘要按 `git show` 原始字节算、和读工作区字节一致」——**大部分成立**，但「一致」依赖工作区等于 HEAD 且无 eol 过滤（仓库无 `.gitattributes`），Windows/脏工作区会破；且 `inherited` 为 true 时跳过了 PR 事件校验，不是「走过每一项」。标记为**有条件成立**。
2. 「第一个用例断言合起来不重复、来源 `owner_pr_comment`、条目数比例外清单多」——**字面成立**，但断言弱，不验证被删 10 条是否真被覆盖（我另行核对才知道覆盖正确）。
3. 「新测试 26 用例全过；旧 main 报 DUPLICATE；npm run check 39 步全过」——**未核实**（无法运行）。但可证：`npm run check` 不含该测试，所以「39 步全过」不能作为该测试的验证；旧 main 的实验结论在 `baseSha=head` 口径下合理。
4. 「`reviewEvidence` 只追加一句、exceptions 数组没变、proposal 不参与身份去重」——**相对 `4b2fbbc2` 成立**；相对整个 PR `bc380a6e..HEAD` 则删了 10 条、exceptions 变了，两种基线要分清。`proposal` 不参与 identity **成立**。
5. 「第 1 轮 GLM 第 1 条（完整扫描没跑）没验证」——**未核实**，属于流程事实，代码无法证伪。

## 六、建议（按优先级）

1. 把 `security-review.test.mjs` 接进 `check:steps`（或新增独立 check），否则「本地检查」缺口仍在。
2. 增加 `baseSha != headSha` 的 PR 口径反向用例；若确认 `loadReviewedExceptions` 在 PR 阶段不报，应修检查逻辑（把 candidate 并入 combined）或在 PR 描述里明确「本 PR 不修此缺口」。
3. 让测试的 `reviewedAt/now` 确定化，不要静默回退到提交时间；proposal 缺失时显式失败。
4. 让 `committedReview` 的 git 调用使用与生产一致的隔离环境（`GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=/dev/null`），并在用例开头断言 `manifest.sourceHead` 可达，避免环境错误伪装成安全错误。
5. 确认 `test/qualification/evidence/**` 里 `af0beef3…` 是否参与当前校验；若是，本次改写 `security-exceptions.json` 会使这些证据失效，需要更新或说明只作留档。
6. 加强第一个用例断言：验证「被删条目集合」正好等于「复核清单 current secret 派生集合」，而不只是数量比较。
