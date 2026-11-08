# 复核报告：PR 305（fa3708b，基准 2995d53）

## 侧重检查（走过的一条普通流程）

**流程 A：CI 任务装工具**：工作流步骤 → `install-tools.mjs` CLI 入口（`scripts/ci/install-tools.mjs:580-608`）→ `runnerCacheDirectory()`（`verified-download.mjs:31-35`，显式 env 优先，否则 `GITHUB_ACTIONS=true` + 绝对 `HOME` 时用 `$HOME/.cache/himawari-ci/downloads`）→ `installTools` → `downloadArtifact`（`install-tools.mjs:267-291`）→ `downloadVerified`：先 `cacheRead` 复验摘要（`verified-download.mjs:44-67`），未命中才 fetch，重试预算 15 分钟，成功后 `cacheWrite` 原子写（`:69-84`）→ CLI 成功后 `pruneCache`。**无测试覆盖的代码路径**：CLI 入口 599-602 的接线（设 env、调 pruneCache）没有任何测试；`pruneCache` 只在 CLI 成功后运行，`installTools` 抛错时不清理（轻微）。
**流程 B：测试里装真 Magpie**：`run.mjs` `runCheck` 构建 env（`scripts/ci/run.mjs:135-162`，新变量在 155-157）→ vitest tooling 项目（`vitest.workspace.ts:47`）→ `review-gateway.test.mjs:692` `installRealGateway()` → `installGateway` 默认 `cacheDirectory = explicitCacheDirectory()`（`gateway.mjs:291`）→ 命中则写 `partial` 后再 `sha256File` 复验（`gateway.mjs:297-312`）。**无测试覆盖**：run.mjs 把 `HIMAWARI_CI_CACHE_DIR` 传给子进程这一步本身（见发现 3）。
**缓存目录归属**：`clean-old.sh:21-22` 只清 `$RUNNER_ROOT/runner/_work` 和 `_diag`，不清 home；`gh-runner.service.in:19,34` `HOME=@ROOT@/home` 且 `ReadWritePaths` 含它；`install-runner.sh:61` home-dir 同路径——ADR「不被每日清理、在服务可写路径内」的说法与代码一致。

## 发现（按严重度从高到低）

**1. 中｜`scripts/ci/verified-download.mjs:86-111`（连带 `gateway.mjs:236-247`）｜`Retry-After: 0` 或已过期的 Retry-After 日期会让重试预算失效，变成实际上无限的重试循环**
证据：`parseRetryAfter` 对 `"0"` 返回 `0`、对过去日期 `Math.max(0, at - now)` 返回 0（`:89,91`）；`retryDelayMs` 对 `retryAfterMs !== null` 直接 `Math.min(retryAfterMs, longestDelayMs)` 即 0（`:95`）；`nextRetryDelay` 里 `waitedMs + 0 > budgetMs` 永假，返回 0 而不是 null（`:109-110`）；调用方 `waited += delay` 永远加 0（`downloadVerified` 内，`:160` 附近），预算永不耗尽，循环只能靠服务器改行为或作业级超时终止。`curlDownload` 经同一个 `nextRetryDelay` 有同样问题，且每次迭代还同步 `sleep(0)`。测试只覆盖了 `retry-after: 7`（`verified-download.test.mjs:190-198`），没有 0 反向用例。
建议：给 delay 设下限（例如不小于 `firstDelayMs`），或 `nextRetryDelay` 里同时限制尝试次数。

**2. 低｜`scripts/model-review/gateway.mjs:233-243`｜curl 已收到 200 响应头但传输中断时不再重试，比旧 `--retry 2` 收窄**
证据：`const status = Number((result.stdout ?? "").trim().slice(-3))` 在 curl 以退出码 18/28（传输中断/超时）失败但已打印 `%{http_code}` 为 200 时，`status = 200`；`const network = result.status !== 0 && !status` 为 false（`:235`），`retryableStatus(200)` 为 false → 立即抛 `GATEWAY_DOWNLOAD_FAILED`，不重试。旧实现 `curl --retry 2` 会把超时（退出码 28）当作可重试。对照 `downloadVerified` 把 fetch 异常一律视为可重试（`verified-download.mjs:148-151`），两条路径行为不一致。Magpie 二进制小，触发概率低。
建议：curl 退出码非 0 且 status 是 2xx 时按网络失败重试。

**3. 低｜`scripts/ci/run.mjs:155-157`、`scripts/ci/install-tools.mjs:599-602`｜两处「接线」没有自动检查**
证据：test/tooling 里对 `HIMAWARI_CI_CACHE_DIR` 的断言只有 `verified-download.test.mjs:231-237` 对 `runnerCacheDirectory` 纯函数的测试；没有任何测试断言 run.mjs 子进程 env 里有这个变量、或 CLI 入口会设置它并调 `pruneCache`。把 run.mjs:155-157 的 spread 删掉，全部测试照过——事故 I-89 的真实修复点恰恰是这两处接线。I-89 门槛行（`docs/incidents-and-gates.md:122`）列出的测试也不含它们。
建议：加一条用受控 env 跑 `runCheck` 断言子进程 env 含 `HIMAWARI_CI_CACHE_DIR` 的用例（类似 `test-timeout-entry.test.mjs` 的做法）。

**4. 信息｜`test/tooling/gitleaks-config.test.mjs:73`、`scripts/model-review/opencode-review.mjs:2828`、`gateway.mjs:831`｜这三个调用点未显式传 `cacheDirectory`，CI 上会隐式读写 runner 真实缓存**
证据：`downloadArtifact`/`installGateway` 默认参 `explicitCacheDirectory()`（`install-tools.mjs:272`、`gateway.mjs:291`）读该 env。这是 ADR 第 2 点的意图，且使用前都有摘要复验，无安全问题；其余断言网络行为的测试已显式传 `cacheDirectory: null`（`toolchain.test.mjs:161,189`、`review-gateway.test.mjs:486-540` 共 5 处），`verified-download.test.mjs` 全用临时目录，`vitest.workspace.ts:6-14,47` 把 tooling 进程的 `GITHUB_*` 清空且 `GITHUB_ACTIONS="false"`，兜底路径不会在测试进程触发。没有现有测试会在热缓存上失败。gitleaks 测试与其它网络断言类测试的处理不一致，属可接受的隐式依赖，建议在 ADR 或注释里点名。

**文档一致性（读代码证实）**：ADR 0181 决定 1-7 逐条与代码相符（目录选择、内容寻址复验、`.tmp-` 原子写、10s 起步翻倍封顶 300s、0.5-1.5 抖动、408/429/5xx 重试、30 天/1 GB/1 天 `.tmp-` 清理、插件不缓存）；I-89 行所列测试文件都存在且断言相符。作者说法里未发现与代码相悖之处；「两个 runner 缓存各一份」与 ADR「放弃的做法」一致。已知限制（缓存冷 + GitHub 故障仍失败，且各工具独立预算 15 分钟可能撞上 policy/security 类作业 15 分钟总时限）属实。

## 必答问题

1. **不会。** diff 只触及 `.agents/reviews`、`docs`、`scripts/ci`、`scripts/model-review`（安装/下载路径）、`test/tooling`；没有 `packages/`、prompt-catalog、遮盖或请求组装代码。`gateway.mjs` 的改动仅在 `curlDownload`/`installGateway`，`PASSTHROUGH_PROMPT` 等未动。发给模型的内容不受影响，追加规则成立。
2. **不会。** 新增的非确定值——`utimesSync` 时间戳（`verified-download.mjs:60-62`）、`pid`+`randomBytes` 临时名（`:71`）、抖动 `random`（`:97`）——全部只落在文件系统和 CI 日志，不进入任何模型请求；请求序列化代码零改动。
3. **有，但有两个洞。** 新增 `verified-download.test.mjs`（402 行，13+ 个用例）并更新 toolchain/review-gateway 测试；反向用例（毒化缓存被拒删、摘要不符不入缓存、404 不重试、预算耗尽、symlink 不读、installGateway 毒化缓存抛 `GATEWAY_INTEGRITY_MISMATCH`）按断言逻辑读会失败——但我无法运行测试，此点未经执行验证。洞：发现 1 的 `retry-after: 0` 无反向用例；发现 3 的两处接线无任何测试。
4. **逐个核对过，都能接受。** `HIMAWARI_CI_CACHE_DIR`：产生于 `run.mjs:155-157` 与 `install-tools.mjs:599-600`（都只给绝对路径），消费于 `explicitCacheDirectory` → `downloadArtifact`/`installGateway` 默认参（`install-tools.mjs:272`、`gateway.mjs:291`）及 `quality.mjs:181`、`opencode-review.mjs:2828`；内容侧有 `digestPattern` 校验 + 每次读取复验摘要 + `installGateway` 写后 `sha256File` 再验，符合事故 I-73 的教训（问了「清单里的 id 能通过后端校验吗」这一类两端核对）。缓存文件名（64 位十六进制）：读端 `digestPattern` 拦截、`pruneCache` 按同规则识别，非摘要名被清理。共享的 `retryableStatus`/`parseRetryAfter`/`nextRetryDelay` 两端语义一致。`sha256Of` 替换 `install-tools` 本地实现为同一函数。「不放 token、不放宽超时、不用假替身」在 diff 中核实成立。

**推测（未核实）**：测试能否通过运行验证（工具受限未执行）；`curl` 在 `--max-time` 触发时是否总打印 `%{http_code}` 为 `000`（按 curl 文档推断，未实测）；`.agents/reviews/topic-ci-504-downloads/` 下的复核记录内容（二进制文件，未读）。
