# PR 296：合并前本地 gitleaks 门槛

## 问题
gitleaks（扫描提交和文件里像密钥的字符串的工具）的误报三次进了 main：PR 248、273、274 合入后，main 和所有 PR 的 CI security 检查都变红，每次都要事后补白名单。按 ADR 0176，合并不等 CI 结果；本地必过的 `npm run check` 不含 gitleaks，所以误报第一次出现就是在合并后 main 的 CI 上。

## 目标（Andy 2026-11-08 同意的方案）
在合并前必须跑的本地检查里，加一步用锁定版本的 gitleaks 扫描，扫描规则和 CI 用同一份白名单，误报在合并前就被拦下。

## 改动
- `scripts/check-gitleaks.mjs`（新，`npm run check:gitleaks`，接在 `check:secrets` 后面进 `npm run check`）：按 `ci/toolchain-lock.json` 只下载 gitleaks 一个工具并核对 sha256，解出可执行文件、核对版本；缓存目录默认 `~/.cache/himawari/gitleaks/<版本>/<平台>`，可用 `HIMAWARI_GITLEAKS_CACHE` 改；基准是 `git merge-base HEAD origin/main`，可用 `HIMAWARI_GITLEAKS_BASE` 改。退出码：通过 0，有发现 1，出错 2。
- `scripts/ci/check-security.mjs`：新增 `runGitleaksGate`，复用 CI 的 `verifyContext`、`verifyRuleFiles`、`snapshotCurrent`、`scanGitleaks`、`applySecurityExceptions`；`gitleaksHistoryScope` 新增 `head` 参数，本地扫当前提交的全部祖先而不是 `--all`；例外只用 `synthetic-secret` 一类（`applySecurityExceptions` 要求每条例外都被用上，别的类型 gitleaks 扫不到）。CI 的 `runSecurityChecks` 只做了等价的抽取（`semgrepRuleIds`、`reviewedExceptions`），行为不应改变。
- `scripts/ci/security-owner-review.mjs`：把清单读取（`readOwnerManifest`）和例外构造（`ownerReviewExceptions`）从 `loadOwnerReview` 里拆出来；新增 `loadOwnerReviewManifest`，本地门槛离线读清单，不联网读 GitHub 评论（本机和测试主机没有 GitHub 令牌，联网读会 404）。CI 仍用 `loadOwnerReview`，照旧核对店主批准、到期时间和 PR 事件。
- 测试：`test/tooling/check-gitleaks.test.mjs`（新）、`security-process.test.mjs`、`security-review.test.mjs`。
- 文档：`docs/incidents-and-gates.md` 加 I-83；`.agents/instructions/delivery-mode.md` 加上这一步。

## 约束
- 不改 CI 的 security 作业行为和放行条件。
- 不调高任何测试超时；不往测试主机放 GitHub 令牌。
- 本地门槛只是提前报警，安全边界仍是 CI。

## 作者的说法（请核对，不要当成事实）
- 拆分 `loadOwnerReview` 后，CI 路径的校验一条没少，返回值和以前相同。
- 本地离线读清单不会让 CI 会拦下的 gitleaks 发现在本地被放过（反过来，本地比 CI 严或一样严）。已知差异：本地不核对店主批准是否到期。
- 下载和解包不会把被篡改的文件当成 gitleaks 运行（sha256 核对在解包前）。并发跑两次不会互相写坏缓存。
- Hermes 上：main（d413e9a0）被拦 6 条；加上 03f47b61 的白名单后通过；放一个假 GitHub 令牌又被拦；`npm run check` 42 步和 `npm run build` 通过。
