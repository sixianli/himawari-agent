# PR 273 第 4 轮复核结论

没有发现会出错（高/中严重度）的问题。以下按严重度排列，先列读代码证实的内容，再列推测。

## 读代码证实的问题

### 低：新增回归测试伪造 Owner 批准，`check:security-review` 不能替代真实审批检查
- 文件：`test/tooling/security-review.test.mjs:317-341`（`committedReview`）
- 问题：测试用工作区里的 `manifest` 现算 `manifestSha256: digest(manifestBytes)`，并让 `readReviewComment` 返回自造的批准正文。也就是说，若有人在本 PR 里改动 `.github/security-review-manifest.json`，该测试仍会通过，它只验证“重复登记会报错”，不验证提交的批准是否真实对应某条评论。
- 证据：
  - `const manifestBytes = readFileSync(join(root, ".github/security-review-manifest.json"));`
  - `manifestSha256: digest(manifestBytes),`
  - `readReviewComment: () => ({ ... body: ...JSON.stringify(approval)... })`
- 建议：在说明里明确这条用例只覆盖“重复登记”，不要让它看起来覆盖了审批真实性；如要覆盖，应使用固定的已批准清单与固定的评论记录，或额外断言真实批准文件未被改动。

### 低：新用例从工作区读取 `.github/*`，在 sparse checkout 下会直接失败
- 文件：`test/tooling/security-review.test.mjs:305-309`
- 问题：`committedReview` 用 `readFileSync` 读工作区 `.github/security-review-manifest.json` 和 `.github/security-review-comment.json`，而例外清单却用 `git show HEAD:` 读。当前复核环境是 sparse checkout（`git status` 报 “96% of tracked files present”），`glob` 找不到 `.github/security-review*`，这类环境下测试会失败。
- 证据：`git show HEAD:.github/security-review-manifest.json` 有内容，但工作区文件不存在；`git status` 输出 `You are in a sparse checkout with 96% of tracked files present.`
- 建议：统一从 `HEAD` 读取（`git show HEAD:.github/...`）而不是读工作区，或显式依赖完整检出。
- 未核实：作者所用 OVH/Hermes CI 是否总是完整检出；若完整检出则不受影响。

### 低：`run-all-checks.test.mjs` 只断言“包含”特定步骤，不保证 main 的步骤一条没丢
- 文件：`test/tooling/run-all-checks.test.mjs:54-72`
- 问题：新断言只 `toContain("check:probe-sources")`、`toContain("check:security-review")`，并未逐条核对 main 的全部步骤。合并冲突若误删别的 main 步骤，这条测试发现不了。
- 证据：`expect(names).toContain("check:probe-sources"); ... expect(names).toContain("check:security-review");`
- 建议（可选）：把 main 的期望步骤列表整体比对，或至少断言 `check:steps` 的长度/集合。

## 读代码证实“没有问题”的关键点（作为核对依据）

- 合并没有丢掉 main 的改动：`git diff 4a35f6e4..b9bd66e9 -- package.json` 只有 `check:security-review` 及其脚本的新增，main 的 `check:probe-sources` 仍在；最终 `check:steps` 共 41 步（手工计数），与作者说法一致。
- 两个新步骤的断言都在：`run-all-checks.test.mjs:54`（`check:probe-sources`）与 `:69`（`check:security-review`）。
- 删除的 10 条例外与 Owner 复核清单的 10 条 `current` 完全对应：kind（`synthetic-secret`）、id（`generic-api-key`）、path、digest 一致，count 也一致（`sqlite-capability-invocations` 为 3，其余为 2）。
- 消费端确实合并：`scripts/ci/security-exceptions.mjs:217-222` 把 `exceptions` 与 `ownerReview.exceptions` 合并后再查重，`scripts/ci/check-security.mjs:675` 使用合并结果，所以删除重复项后仍由复核清单覆盖。
- 抽查清单来源行号在 `manifest.sourceHead = e2a792f` 下确实命中合成 token：
  - `git blame -L 22,22 e2a792f -- apps/execution-worker/test/production-worker-composition.unit.test.ts` → `tokenValue: "0123456789abcdef0123456789abcdef"`
  - `service-main.unit.test.ts:144`、`sqlite-capability-invocations.test.ts:1629` 同样命中。
- `manifest.sourceHead` 是 HEAD 的祖先（`git log --ancestry-path e2a792f..b9bd66e9` 有输出），`loadOwnerReview` 的 `merge-base --is-ancestor` 不会误报 `SECURITY_REVIEW_SOURCE_UNRELATED`。
- 摘除的 5 条同摘要例外（`execution-uds-transport`、`installable-node-services`、`product-path-harness`、`queued-live-worker`、`production-invocation-authority`）不在复核清单的 10 个路径里，不会再次触发重复。
- `reviewEvidence` 只是字符串，schema 只有 `minLength: 20`，无 `maxLength`（`ci/security-exceptions.schema.json:312-315`），新增文字不会触发校验失败；`proposal` 的 `proposedAt`/`expiresAt`/`owner` 仍满足 30 天与 owner 约束。

## 推测 / 未核实

- 「去掉继承环境后 git 仍能正常运行（不需要 HOME）」：未执行任何代码，无法实证。代码上 `GIT_CONFIG_NOSYSTEM=1` + `GIT_CONFIG_GLOBAL=/dev/null` 已覆盖系统/全局配置，`git init/config/commit` 只写仓库本地配置，`git clone` 是本地路径，按 git 文档应不需要 HOME；但若 `process.env.PATH` 在某些执行环境为空，`env: { PATH: undefined }` 可能导致找不到 `git`。属可移植性风险，未核实。
- 作者说法 3（OVH VPS 上 31 个用例全过、`npm run check` 41 步全过、旧 main 27e1d332 仍报 `SECURITY_EXCEPTION_DUPLICATE`）：无法运行，未核实。可核对的是用例数量：`security-review.test.mjs` 26 个（含 `it.each` 展开）+ `run-all-checks.test.mjs` 5 个 = 31，与说法一致。
- 生产扫描（gitleaks/semgrep）对复核清单 10 条来源行的完整验证：`check:security-review` 只调用 `loadReviewedExceptions`，不调用 `verifySyntheticProvenance`/`applySecurityExceptions`，所以这条测试覆盖不到来源行校验；我只抽查了 3 条，其余未逐条核实。

## 侧重检查

- 错误路径：重复登记（`SECURITY_EXCEPTION_DUPLICATE`）、proposal 范围、过期时间、来源无关、PR 不匹配等分支都有测试；新增反向用例的路径正确——`loadReviewedExceptions` 在合并后调用 `validateSecurityExceptions`，重复身份在 `security-exceptions.mjs:176-185` 抛出，理论上会失败。
- 不可信输入：新用例的 `git clone --shared` 来自本地仓库，不联网；工作区清单未做签名校验是测试局限，不是生产路径。
- 安全：`isolatedGit` 收紧环境是正向改动；但未设 `GIT_TERMINAL_PROMPT=0` 等，仅本地操作，影响很小。
- 资源耗尽/不可撤销操作：临时目录由 `afterEach` 删除，clone 用 `--shared` 较省空间；没有对真实仓库的破坏性命令。
- 规则/文档/代码一致性：`docs/incidents-and-gates.md` 的 I-79/I-80 与 `check:probe-sources`、`--preflight` 对应（来自 main 合并），`package.json` 已包含；`reviewEvidence` 写“删除 10 条”，代码 diff 正好删除 10 条，一致。

## 必答问题

1. **是否改变模型已见过的请求开头？**
   没有。本次改动只涉及 `package.json`、`ci/security-exceptions.json`、`docs/incidents-and-gates.md`、`scripts/check-*.mjs`（检查脚本）、`test/tooling/*` 与 `.agents/reviews/*`，没有系统提示、工具定义、历史消息或遮盖逻辑的修改；发给模型的内容仍只在末尾追加，每轮变化的值不在这条链路上。依据 diff 文件清单核对。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。改动的值是静态文件内容和测试内的确定性计算；新增测试用 `proposal.proposedAt`（固定日期）推导时间，不使用当前时钟；删除/保留的例外是静态 JSON。没有依赖前后文的遮盖、带时间的请求字段或无序集合进入模型输入。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有：`check:security-review` 已接入 `check:steps`（`package.json`）并由 `run-all-checks.test.mjs:69-72` 断言接线；重复登记的反向用例（`security-review.test.mjs:354-386`）会把复核清单条目再写进例外清单并提交，按代码逻辑应在合并校验时抛 `SECURITY_EXCEPTION_DUPLICATE`。未实际运行，运行结果未核实。另有两处未覆盖：来源行校验（`verifySyntheticProvenance`）未被该测试执行；`check:steps` 未整体断言 main 步骤一条不少。

4. **每个产生/修改的值，所有使用端都能接受吗？**
   - `check:security-review`：`package.json` 产生，`check:steps` 与 `run-all-checks.test.mjs:69-72` 使用，字符串完全一致。
   - `check:probe-sources`：来自 main，`check:steps` 与 `run-all-checks.test.mjs:54-57` 使用，命令字符串一致。
   - 删除的 10 条例外：使用端 `loadReviewedExceptions` 会把例外清单与 Owner 复核清单合并，复核清单产生同 kind/id/path/digest、同 count 的条目；路径、计数已逐条核对一致，抽查来源行在 `manifest.sourceHead` 下确实命中 tokenValue，验收通过。
   - `reviewEvidence`：仅受 schema `minLength` 约束，新增文字合法；proposal 日期/owner 仍满足校验。
   - `isolatedGit` 的 `PATH`/`GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` 是 git 认识的键；缺少 `HOME` 是否在所有环境可接受，未核实（推测正常）。
