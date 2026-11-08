## 第 3 轮修改核对（先说结论）

我逐条对照了第 3 轮的四类修改：`creditFloor > 0`、`creditProvider` 必须是带 `signIn` 的 plugin、`summarizeGatewayUsage` 对成功/失败请求分别要求 `credits` 或 `in/out`、`gatewayRecordFields` 的 `requested`、`readGatewayUsage` 的读错误兜底、`startGateway` 的 `error` 监听、`startLiveGateway` 的失败包装与回退、`systemAsDirect` 只归一化系统消息、`GATEWAY_USAGE dropped=`。这些实现本身与作者第 3 轮的说法基本一致，没有发现会直接破坏预算上限或进程清理的新问题。但下面 1、2、4、5 条是这次修改仍然留下的实质问题，其中第 1 条是我认为最需要先修的。

---

## 读代码证实的问题

### 1. [中] 积分预留少算“替补模型”，单模型复核仍可能突破 20 分底线

- 文件:行：`scripts/model-review/opencode-review.mjs:2448`、`:2539-2545`、`:797-805`；`scripts/model-review/gateway.mjs:358-360`
- 问题：代码-review 传 `--previous` 且不写 `--models` 时，`options.models` 被缩成 `[REVIEW_MODELS[0]]`（DeepSeek）；但 `substituteFor()` 允许 DeepSeek 连续 api-error 后让 GLM 顶替。`startLiveGateway()` 把 `models: options.models` 原样传给 `creditReserve()`，预留只按 1 个模型算（`1 × 0.2 × 换算比`），而实际最多可能跑 2 个模型（0.4 美元）。
- 证据：
  - `opencode-review.mjs:2448`：`if (options.previous && !given.has("--models")) options.models = [REVIEW_MODELS[0]];`
  - `opencode-review.mjs:797-805`：`substituteFor()` 在 `mode === "code-review" && previous && models.length === 1` 时返回 GLM 替补。
  - `opencode-review.mjs:2539-2545`：`creditReserve({ records, models, costLimitUsd: COST_LIMIT_PER_MODEL_USD, ... })`。
  - `gateway.mjs:358-360`：`return models.length * costLimitUsd * creditsPerUsd(...)`。
- 后果：若剩余积分在“1 个模型够、2 个模型不够”的区间（例如换算比 54 时，剩余约 30.8～41.6 分），脚本会保留 CodeBuddy；DeepSeek 花掉接近 10.8 分后 GLM 替补再花接近 10.8 分，最后可能低于 20 分。作者第 3 轮明确说 D8（替补预检）不采纳，但预留也应该把“可能发生的替补”算进去。
- 建议：`creditReserve` 的 `models` 用“本次可能跑的模型数”，即 `options.models.length + (substituteFor 可能成立 ? 1 : 0)`；或者统一按 `REVIEW_MODELS.length` 预留。补一条“单模型 + 替补”的预留测试。

### 2. [中] 文档说“启动/建组/成员失败都以 GATEWAY_PREFLIGHT_FAILED 停下”，代码却会回退到只用 Go

- 文件:行：`.agents/instructions/model-review.md:123`；`scripts/model-review/opencode-review.mjs:2526-2535`
- 问题：文档写“启动 Magpie、建组失败或成员缺失都以 `GATEWAY_PREFLIGHT_FAILED` 停下，不发任何模型请求”，但代码在第一次 `start(withCredit)` 失败且 `uid` 存在时，会打印 `GATEWAY_CREDIT_FLOOR … sign-in-failed`，去掉 CodeBuddy 后用新临时目录重试；只有重试也失败才抛 `GATEWAY_PREFLIGHT_FAILED`。作者第 3 轮说这是有意降级，但文档和 ADR 都没有写这个例外。
- 证据：
  - `model-review.md:123`：`...启动 Magpie、建组失败或成员缺失都以 GATEWAY_PREFLIGHT_FAILED 停下，不发任何模型请求。`
  - `opencode-review.mjs:2526-2535`：`try { live = await start(withCredit, ...) } catch (error) { if (!uid) throw error; console.log(... sign-in-failed ...); drop = [config.creditProvider]; live = await start(withCredit.filter(...), ...) }`
- 建议：在 `model-review.md` 和 ADR 0178 明确写“只有 CodeBuddy 登录/启动失败才降级为只用 Go，其余失败仍以 GATEWAY_PREFLIGHT_FAILED 停下”；如果只想对登录失败降级，应把 catch 收窄到可识别的登录错误，而不是所有第一次启动错误。

### 3. [中] `creditsLeft` 把 `remaining` 当 0～100 的百分比，实际 Magpie 配额格式没有自动测试锁定

- 文件:行：`scripts/model-review/gateway.mjs:330-344`；`test/tooling/review-gateway.test.mjs:240-255`、`:686-701`
- 问题：`creditsLeft()` 用 `limit * remaining / 100` 计算剩余积分，并拒绝 `remaining > 100`。测试里的 `quota` 是手写夹具（`remaining: 95.488, limit: 250`），不是 `magpie quota --json` 的真实输出；`startLiveGateway` 的两条真实用例都传 `accountUid: () => null`，`drop` 一开始就非空，`live.quota()`/`floorDecision` 分支根本不会执行。真实自检也不查积分。也就是说，**“Magpie 返回的 `remaining` 是百分比、`limit` 是总额、`amount` 是已用”这个关键假设没有自动化证据**。
- 证据：
  - `gateway.mjs:337-343`：`const { limit, remaining, amount } = window; ... if (remaining < 0 || remaining > 100) return null; const left = (limit * remaining) / 100;`
  - `review-gateway.test.mjs:240-248`：夹具为 `{ name: "Total credits", remaining: 95.488, limit: 250, unit: "credits" }`。
  - `review-gateway.test.mjs:695-701`：`startLiveGateway({ ..., models: [deepseek], accountUid: () => null })`，因此不会进入 quota/floor。
- 后果：如果真实 Magpie 的 `remaining` 是**绝对积分且 ≤100**（例如 `limit: 250, remaining: 30`），代码会算成 `75`；按 54 的换算比、预留 21.6，代码认为 `75-21.6=53.4 ≥ 20` 而保留 CodeBuddy，实际只剩 `30-21.6=8.4`，直接突破 20 分底线。如果真实 `remaining` 是绝对积分且 >100，代码返回 null、去掉 CodeBuddy，反而是安全的。所以风险集中在“绝对值恰好 ≤100”的格式。
- 建议：用一次真实 `magpie quota <provider> --json` 的输出（或从云端 smoke test 里脱敏后的固定夹具）补一条集成测试；在 `creditsLeft` 里同时校验 `window.unit === "credits"`，并明确拒绝无法判断百分比的格式。至少应在文档里把“实测格式”写清楚。

### 4. [中] CodeBuddy 登录、配额、底线成功路径和登录失败回退都没有自动测试

- 文件:行：`test/tooling/review-gateway.test.mjs:686-701`、`:724-750`；`scripts/model-review/opencode-review.mjs:2526-2535`
- 问题：两条 `startLiveGateway` 真实用例都使用 `accountUid: () => null` 和自定义 `probe` provider，只覆盖“没有账号编号 → 去掉 CodeBuddy”和“成员缺失 → 预检失败”。没有一条测试覆盖：
  - `uid` 存在、`magpie plugin login` 成功、`live.quota()` 返回数字、`floorDecision` 决定保留 CodeBuddy；
  - `magpie plugin login` 失败 → `catch` 回退到只用 Go；
  - `quota` 返回 null → `credits-unknown` 去掉 CodeBuddy；
  - 真实的 `magpie quota` 输出格式。
- 证据：
  - `review-gateway.test.mjs:695-701`：`accountUid: () => null`，因此 `drop = [config.creditProvider]`，`if (drop.length === 0)` 的 quota/floor 分支被跳过。
  - `review-gateway.test.mjs:724-750`：另一条真实用例同样 `accountUid: () => null`。
  - `opencode-review.mjs:2526-2535`：回退分支没有对应测试。
- 建议：把 `startGateway`/`live.quota` 做成可注入（或在测试里用假 `magpie` 脚本/假 quota 输出），至少覆盖登录成功、登录失败回退、quota 失败、quota 数字触发 floor 四条路径；真实 `magpie quota` 格式单独用录制夹具锁定。

### 5. [中低] 运行前后只核对 Magpie 二进制摘要，安装目录里的插件文件被改后不会被发现

- 文件:行：`scripts/model-review/gateway.mjs:219-243`、`:249-253`；`scripts/model-review/opencode-review.mjs:2637-2639`、`:2791-2797`；`.agents/instructions/model-review.md:121`
- 问题：`installGateway()` 只在安装时校验插件 tarball 的 npm integrity，并把 integrity 写进 `plugin.integrity` 标记文件；之后如果标记内容仍匹配，就跳过重新解包。`binaryProblem()` 只计算 `install.binary` 的 SHA-256；主流程前后也只调用 `binaryProblem()`。因此有人或某个升级过程改了 `install.pluginDir` 里的 JS、但保留 `plugin.integrity` 标记时，复核会加载被改的插件而不报错。文档写“每次运行前后都核对 Magpie 程序的摘要”，容易被理解成插件也在核对范围内。
- 证据：
  - `gateway.mjs:221-224`：`const marker = join(prefix, "plugin.integrity"); const installedIntegrity = ...; if (installedIntegrity !== lock.plugin.integrity || !existsSync(join(pluginDir, "package.json"))) { ... }`
  - `gateway.mjs:249-253`：`binaryProblem` 只对 `install.binary` 做 `sha256File`。
  - `opencode-review.mjs:2637-2639`、`:2791-2797`：前后检查都只调用 `binaryProblem(gateway.install)`。
- 建议：安装时把插件目录的文件清单和逐文件摘要写进标记（或对目录算一个确定性摘要），每次运行前重新核对；如果暂时不做，至少在文档里明确“只核对 Magpie 二进制，插件只在安装时核对 tarball integrity”，避免过度承诺。

### 6. [低中] 复核结束后立刻读 Magpie `usage.jsonl`，可能和 Magpie 落盘竞争；预算不受影响，但积分换算比可能被低估

- 文件:行：`scripts/model-review/opencode-review.mjs:2741-2748`；`scripts/model-review/gateway.mjs:426-444`、`:346-356`；`test/tooling/review-gateway.test.mjs:711-714`
- 问题：`runOne()` 在 `reviewModel()` 返回后立刻调用 `gatewayRecordFields(liveGateway.live.usage(), ...)`，没有等待或重试 Magpie 把最后一行用量写完。`readGatewayUsage()` 遇到半行会返回 null（保守），但如果文件里已有前面步骤的完整行、最后一步还没落盘，`providers` 非空且 `requested` 为真，`costUnknown` 不会被置位，`providers.credits` 会少算最后一步。`creditsPerUsd()` 用 `providers.credits / record.cost` 算换算比，少算 credits 会低估换算比，从而低估预留，削弱积分底线。测试 `review-gateway.test.mjs:711` 也是立刻读，可能间歇性失败。
- 证据：
  - `opencode-review.mjs:2741-2748`：`...gatewayRecordFields(liveGateway.live.usage(), gateway.config, model, { requested: summary.usage.steps > 0 })...`
  - `gateway.mjs:426-444`：`readGatewayUsage()` 读文件，遇到无法解析的行返回 null，但没有“等写完”的逻辑。
  - `gateway.mjs:346-356`：`creditsPerUsd()` 用 `record.providers[provider].credits / record.cost`。
- 建议：读完用量后做一次短轮询/稳定检查（文件大小和 mtime 连续两次不变，或解析行数稳定）再记账；或者让 Magpie 提供一个 flush/usage 查询接口。测试里也应在读取前等待文件稳定。

### 7. [低] 文档说“记录里有读不懂的行都记 costUnknown”，但 `summarizeGatewayUsage` 会静默跳过 `req` 不是 `group/` 字符串的行

- 文件:行：`scripts/model-review/gateway.mjs:385-393`；`.agents/instructions/model-review.md:124`
- 问题：`summarizeGatewayUsage()` 对非对象行计 `unreadable`，但对 `{req: 123}` 或 `{req: "opencode-go/..."}` 这类“能解析 JSON 但 `req` 不是 review group”的行直接 `continue`，不计数。文档却写“记录里有读不懂的行……都记 costUnknown”。
- 证据：
  - `gateway.mjs:390-391`：`const requested = typeof line.req === "string" ? line.req : ""; if (!requested.startsWith("group/")) continue;`
  - `model-review.md:124`：`...记录里有读不懂的行...都记 costUnknown...`
- 后果：多数情况下这些行可能是别的 group 的正常记录，跳过是对的；但“读不懂”的边界与文档不一致。若某条 review 请求的 `req` 字段被 Magpie 写成非 `group/` 形式，会被静默跳过，只有在该模型完全没有其他行时才会由 `requested` 兜底成 `costUnknown`；如果同模型还有其他行，就不会标 `costUnknown`。
- 建议：区分“其他 group 的合法行”和“形状可疑的行”；对 `req` 不是字符串、或 `req` 以 review 组前缀开头但解析不出的行计 `unreadable`，或者把文档改成更精确的描述。

### 8. [低] `creditsPerUsd` 取历史最大比值，单条异常小 `cost` 会把预留放大到永久去掉 CodeBuddy

- 文件:行：`scripts/model-review/gateway.mjs:346-356`；`docs/adr/0178-review-model-calls-through-a-local-magpie.md:56`
- 问题：`Math.max(fallback, ...ratios)` 对 `record.cost > 0` 的所有 CodeBuddy-only 记录取最大比值。如果某条记录 `cost` 很小（例如 0.001）但 `credits` 是正常量级（例如 4.37），比值会到 4370，预留变成 `2 × 0.2 × 4370 = 1748`，账号积分不够就永远去掉 CodeBuddy。这是“保守但不可用”的失败模式。
- 证据：
  - `gateway.mjs:347-355`：`records.filter(record => record.gateway === "magpie" && record.cost > 0)...map(record => record.providers[provider].credits / record.cost)...return Math.max(fallback, ...ratios);`
  - ADR 0178:56：`换算比取账本里只用了 CodeBuddy 的运行中最大的那个...不用中位数，因为预留要的是一次运行最多会用多少。`
- 建议：对参与换算比的记录加最小成本/最小 token 门槛，或对换算比设上限；也可以用“最大 credits / 对应最大 cost”或高分位数，避免被单条噪声记录永久锁死。

### 9. [低] 透传探针只比较第一条请求，且用的是自定义 provider，不能证明 CodeBuddy 插件在“未被拒绝”时也不改内容

- 文件:行：`scripts/model-review/opencode-review.mjs:1760-1813`、`:1702-1709`；`docs/adr/0178-review-model-calls-through-a-local-magpie.md:65`
- 问题：`passthroughProbe()` 用 `probeUpstream("probe", port)`（kind: custom）起 Magpie，`main(requests)` 只找第一条带 `tools` 的请求；`systemAsDirect()` 只归一化系统消息里的模型名。ADR 写“透传探针保证没有被拒时 Magpie 不改动任何内容”，但真正可能在 11128 之外改写系统提示的是 CodeBuddy 插件，探针完全没有走插件路径；也没有比较后续多轮请求（工具结果、历史追加后的请求）。
- 证据：
  - `opencode-review.mjs:1702-1709`：`probeUpstream` 固定 `kind: "custom"`。
  - `opencode-review.mjs:1784-1785`：`const main = (list) => list.find((request) => Array.isArray(request.tools) && request.tools.length > 0);`
  - `opencode-review.mjs:1786-1808`：只跑一次 DeepSeek 的直接和经 Magpie 请求。
  - ADR 0178:65：`...透传探针保证没有被拒时 Magpie 不改动任何内容。`
- 建议：把文档收窄为“验证 Magpie 核心转发和自定义 provider 的透传”；如果要在自动检查里覆盖 CodeBuddy 插件，需要另做插件路径的探针（可以用假上游/假插件登录），并至少比较第二条请求（带工具结果的历史）是否只追加。

### 10. [低] `startLiveGateway` 把所有第一次启动失败都记成 `sign-in-failed`，日志会误导

- 文件:行：`scripts/model-review/opencode-review.mjs:2528-2531`
- 问题：`catch (error)` 不区分错误类型，只要第一次 `start(withCredit)` 失败且 `uid` 存在，就打印 `GATEWAY_CREDIT_FLOOR ... sign-in-failed <error>`。如果是 Go preset 配置错误、Magpie 二进制问题或插件解包问题，日志会说是登录失败，然后重试（通常也失败）。
- 证据：`opencode-review.mjs:2528-2531`：`console.log(\`GATEWAY_CREDIT_FLOOR ${config.creditProvider} sign-in-failed ${error.message}\`);`
- 建议：只对可识别的 CodeBuddy 登录/插件错误使用 `sign-in-failed`，其他错误用 `first-start-failed` 或直接抛 `GATEWAY_PREFLIGHT_FAILED`。

---

## 推测 / 未核实

1. **Magpie 用量记录字段名**：代码假设 `req`、`provider`、`status`、`credits`、`in`、`out`、`reasoning`、`cache_read`（`gateway.mjs:381-418`）。测试夹具是手写的。如果真实字段是 `model`/`prompt_tokens`/`completion_tokens`，所有成功请求都会变成 `costUnknown`（预算仍保守），但 `providers` 和 `GATEWAY_USAGE` 会一直为空。`.agents/reviews/topic-gateway-smoke-test/usage.jsonl` 和 `topic-review-gateway-magpie/usage.jsonl` 被 git 替身拒绝读取，我**未核实**真实格式。
2. **Magpie `/models` 的 id 格式**：`startLiveGateway` 用 `ids.has(member)`（`opencode-review.mjs:2560-2565`）比较 `provider/model`。如果 Magpie 返回短名或另一种分隔符，预检会失败（安全，但功能不可用）。真实自检是否通过只能依赖作者说法，**未核实**。
3. **`x-magpie-provider` 响应头**：`failoverProbe` 要求它等于 `"probe"`（`opencode-review.mjs:1835-1836`）。如果 Magpie 用别的头，自检会失败（安全），但**未核实**。
4. **`reasoning`/`cache_read` 缺省为 0 是否偏低**：`summarizeGatewayUsage` 对成功请求只强制 `in`/`out`，`reasoning`/`cache_read` 缺失按 0（`gateway.mjs:378-379`、`:410-415`）。如果 Magpie 对某些成功请求省略这些字段，`providers.usd` 会低于实际。**但预算上限用的是 OpenCode 的 `record.cost`，不是 `providers.usd`**，所以这不会削弱 0.2 美元拦截；它只影响 `GATEWAY_USAGE` 和未来若有人拿 `providers.usd` 对账。作者的说法“Go 按单价折算 usd”在字段齐全时成立，在字段缺失时是下限。
5. **Magpie 中途退出时漏记最后一笔花费**：`requested` 用 `summary.usage.steps > 0`（`opencode-review.mjs:2744`）。如果 Magpie 在第一个请求尚未产生 `step_finish` 时退出，`steps === 0`，用量文件可能为空，`gatewayRecordFields` 不会标 `costUnknown`，记录 `cost=0`。通常失败请求不产生上游费用，且 `inFlight` 在超时/费用停止时能兜底；但“Magpie 崩溃导致上游已计费、OpenCode 没收到 `step_finish`”这条路径没有测试，属于**推测的漏记风险**。
6. **`installGateway` 的 tar 解包路径**：tarball 的 integrity 已按 lock 校验，但 `tar -xzf` 没有额外限制解包路径（`gateway.mjs:189-193`）。lock 是仓库内受信任文件，威胁模型也写明“防误操作，不防恶意 PR”，所以**低风险**；若想再加固，可校验解包后文件都在 `pluginRoot` 下。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **Magpie 启动失败**：`startGateway.serve()` 有 `error` 监听，`waitForGateway` 检查 `child.exitCode` 和 `spawnError`；失败时 `stop()` 杀进程组并抛 `GATEWAY_START_FAILED`；`startLiveGateway` 包成 `GATEWAY_PREFLIGHT_FAILED`。测试 `review-gateway.test.mjs:647-661` 覆盖。结论：不会静默继续，不会留下活着的 Magpie。
- **插件登录失败**：`startGateway` 在 `magpie plugin login` 非零时抛错；`startLiveGateway` 在 `uid` 存在时去掉 CodeBuddy 重试。结论：会降级为 Go-only，不会让复核在没有 CodeBuddy 的情况下继续假装用了 CodeBuddy；但该分支**没有自动测试**（第 4 条），且日志把所有错误叫 `sign-in-failed`（第 10 条）。
- **查积分失败**：`quota()` 内部 `try/catch` 返回 null；`floorDecision({left:null})` 返回 `credits-unknown`，`drop=[creditProvider]`。结论：安全降级。格式假设见第 3 条。
- **用量记录缺失/读不懂**：`readGatewayUsage` 读错误返回 null；`gatewayRecordFields` 返回 `costUnknown`；`spentOf` 用 `max(cost + 0.05, 0.2)`。结论：预算上限仍保守。成功请求缺 token/积分、未知 provider、OpenCode 有 step 但无该模型行，都会 `costUnknown`（测试覆盖）。
- **Magpie 中途退出**：OpenCode 侧变成 api-error，记录仍写；用量可能部分缺失，`costUnknown`/`inFlight` 能兜住大部分，但“首个请求已计费但无 step_finish”是残余风险（推测 5）。
- **中断信号**：`main` 注册 `SIGINT`/`SIGTERM`，`cleanup()` 调用 `stopAllGateways()`、杀 OpenCode 子进程、删临时目录；`finally` 再 cleanup。结论：会停掉自检和正式复核启动的所有 Magpie（测试 `review-gateway.test.mjs:752-777`）。极小窗口：信号在 `process.once` 注册前到达时不会 cleanup，但那时通常还没有 Magpie。
- **不可信输入**：`gatewayConfigProblems` 校验 routing/stays/creditFloor/defaultCreditsPerUsd/providers/creditProvider/models 成员前缀/上限/单价；`readGatewayConfig` 抛 `GATEWAY_CONFIG_INVALID`。`summarizeGatewayUsage` 对 null、非对象、`__proto__` provider、字符串/NaN/负数 token 都有处理（测试覆盖）。`isLoopbackURL` 把 `apiKey` 限制在 `http://127.0.0.1|localhost`。结论：输入校验整体扎实。缺口：`creditProvider.signIn` 只要求真值，不校验登录方式（`gatewayConfigProblems` 第 95-97 行），而 `startGateway` 固定用 `DESKTOP_SIGN_IN_METHOD`；配置写错登录方式时不会报 `GATEWAY_CONFIG_INVALID`，只会登录失败后降级。
- **安全/凭据**：仓库里的 `gateway.json` 不含密钥；`desktopSignIn` 只写 `proxy-injected` 占位符，文件 0600；`magpie`/`curl`/`npm` 都用参数数组、不经过 shell；错误日志不打印真实 token。结论：好。插件解包后的完整性见第 5 条。
- **资源耗尽**：Magpie 子进程登记在 `runningGateways`，`stopAllGateways` 统一杀；`magpie` CLI 有 180s 超时，`workbuddyAccountUid` curl 30s，HTTP 读有超时；`readGatewayUsage`/`summarizeGatewayUsage` 线性。`installGateway` 的 `curlDownload`/`npmPack` 没有超时（安装路径），属于低风险。
- **不可逆操作**：复核只读，Magpie/OpenCode 都在临时目录，跑完删除；没有生产写入。结论：无新增不可逆操作。
- **文档/规则一致性**：`model-review.md:123` 的“任何启动失败都停”与代码回退不一致（第 2 条）；`model-review.md:124` 的“读不懂的行都 costUnknown”与 `summarizeGatewayUsage` 跳过非 group 行不一致（第 7 条）；ADR 0178:65 的“透传探针保证没有被拒时 Magpie 不改动任何内容”强于探针实际覆盖范围（第 9 条）。其余新增说明（`gateway.json` 校验、积分预留、`gatewayDropped`、`GATEWAY_USAGE`、自检四项、停 Magpie）与代码基本一致。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**在一次复核运行内：不会。** 发给模型的内容仍然只在末尾追加；Magpie 核心转发不注入每轮会变的值；`gatewayOpencodeEnv()` 只改 `NO_PROXY`/`OPENCODE_ENABLE_EXA`，不进入提示词；`desktopSignIn` 的 `expiresAt`、临时端口、`reviewConfig` 的 `cost`/`limit` 都是客户端配置，不在系统提示/工具定义/历史里。`reviewConfig()` 的 `permission`、`tools`、`prompt` 组装没有变；`gatewayProvider` 只是把模型 id 从 `opencode-go/...` 换成 `magpie/group/review-...`，系统提示里的模型名在**同一次运行内固定**。

**但有两个例外/边界：**
- CodeBuddy 插件在 11128 拒绝时改写系统提示（ADR 0178 已写成受控例外）；透传探针用自定义 provider，**没有覆盖插件路径**（第 9 条）。
- 直连方式和经 Magpie 方式对同一个模型会生成不同的系统提示模型名（`opencode-go/deepseek...` vs `group/review-deepseek...`）。如果同一段对话先直连、后经 Magpie，前缀会变；脚本没有在同一个 OpenCode 会话里混用两种方式，每轮都是新会话，所以不构成“已经见过的开头被改”。换服务方（CodeBuddy 故障转 Go）会换上游、缓存整段重算，但不改字节，属于规则第 9 条的缓存亲和取舍。

**结论：** 在单次运行内满足“只追加、每轮变化的值不在头部”；系统提示相对直连有模型名差异，但按运行冻结。**未核实**：多轮后续请求是否也只追加（探针只测第一条带工具的请求）；CodeBuddy 插件未拒绝时是否真的不改写（探针没走插件）。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**模型可见内容：没有发现新增的不确定来源。** 没有新增遮盖；`desktopSignIn` 的时间字段只在登录文件里；`gatewayUsageLine`/`summarizeGatewayUsage` 的 Map/对象顺序只影响账本和日志；`reviewConfig`/`gatewayProvider` 的键顺序是固定的；`groupArgs` 的成员顺序来自 `gateway.json`；`gatewayOpencodeEnv` 的 NO_PROXY 合并只影响网络。同一段文本在同一个 provider 下逐字节相同。

**例外：** 故障转移会换服务方（缓存命中率会掉，但字节不变）；CodeBuddy 11128 例外会改写系统提示。账本/日志里的 `at` 时间戳、临时端口、`expiresAt` 不是模型输入。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有。** `test/tooling/review-gateway.test.mjs` 覆盖了：直连配置快照（六个硬编码 SHA-256）、`gatewayProvider` 只接受回环、`gatewayConfigProblems` 的 `creditFloor`/`creditProvider`/`models` 校验、`floorDecision` 非数字、`creditsLeft` 百分比与已用积分不一致、`summarizeGatewayUsage` 的异常行/缺 token/未知 provider、`gatewayRecordFields` 的 `requested`、`readGatewayUsage` 读错误、`systemAsDirect` 只归一化系统消息、`startGateway` 不能启动、`stopAllGateways`、两条 `startLiveGateway`、真实自检经 Magpie。我逐个读了这些用例：如果去掉对应保护，断言会失败（例如去掉回环检查，`gatewayProvider` 不再抛 `GATEWAY_NOT_LOOPBACK`；去掉 `creditFloor > 0`，`broken({creditFloor:0})` 不再包含 `creditFloor`；去掉 `requested`，空用量用例不再返回 `costUnknown`）。**未运行**，所以“真的会失败”是基于代码阅读的判断。

**缺口：** CodeBuddy 登录/配额/底线成功路径与登录失败回退没有测试（第 4 条）；真实 `magpie quota` 格式没有测试（第 3 条）；插件解包后篡改没有测试（第 5 条）；用量落盘竞争没有测试（第 6 条）；透传探针只测第一条请求、不走 CodeBuddy 插件（第 9 条）。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

我按“产生端 → 使用端”逐项核对了：

- `gateway: "magpie"`：`gatewayRecordFields` 产生；`parseUsage` 的 `GATEWAYS.includes`、`creditsPerUsd` 的 `record.gateway === "magpie"`、`gatewayUsageLine` 消费。两端一致。
- `providers`：`summarizeGatewayUsage` 产生 `{requests, failed, credits?, usd?}`；`providersValid`、`parseUsage`、`gatewayUsageLine`、`creditsPerUsd` 消费。`requests`/`failed` 是非负安全整数，`credits`/`usd` 是非负有限数；两端一致。`unknown`/`none` 键也能通过 `providersValid`。
- `costUnknown`：`gatewayRecordFields`/`summarizeEvents` 产生；`spentOf`、`retryAfterApiError`、`wrapUpReason` 消费。`parseUsage` 不校验它，但没有地方把它当数字用；安全。
- `gatewayDropped`：`main` 产生；`gatewayUsageLine` 和 `parseUsage` 的 `hasLineBreak` 消费。`parseUsage` 不校验它是数组，但不会把它当数字用；安全。
- `gateway.json` 的 `routing`/`stays`：`gatewayConfigProblems` 校验；`groupArgs` 消费。一致。
- `creditProvider`：`gatewayConfigProblems` 要求存在、kind=plugin、signIn 真值；`startLiveGateway` 用它做 `quota`/`drop`；`summarizeGatewayUsage` 用它区分 credits；`creditsPerUsd` 用它。一致。**但** `signIn` 只校验真值，不校验方法名；`startGateway` 固定用 desktop 方法（低风险）。
- `creditFloor`/`defaultCreditsPerUsd`：`gatewayConfigProblems` 校验有限且 >0；`floorDecision`/`creditReserve` 消费。一致。
- `providers[].id`：`gatewayConfigProblems` 校验唯一非空字符串；`groupArgs` 成员前缀、`startGateway` provider add、`summarizeGatewayUsage` known 集合、`creditsPerUsd` 消费。一致。**但** 如果配置里出现 id `"none"`/`"unknown"`，会与空 provider 的占位名冲突，造成错误归因（低风险）。
- `models` 的键/成员/`name`/`context`/`output`/`cost`：`gatewayConfigProblems` 校验；`gatewayProvider`、`outputBounds`、`groupArgs`、`summarizeGatewayUsage` 消费。一致。
- `gateway-lock.json` 的 `magpie.assets[].sha256`：`lockFromRelease` 校验 64 位十六进制；`installGateway` 用 `sha256File` 比较；一致。`plugin.integrity`：`lockFromRelease` 校验 `sha512-`；`installGateway` 用 `npmIntegrity` 比较；一致。
- `--gateway`：`parseArgs` 只接受 `GATEWAYS`；`main` 真值判断；`assert/report` 子命令拒绝；一致。
- `GATEWAY_PROVIDER_ID`/`CLIENT_KEY`/`PLACEHOLDER`/`DESKTOP_SIGN_IN_METHOD`/`WORKBUDDY_DESKTOP_FILE`：产生端和 Magpie/插件消费端的格式假设无法完全从代码核实（插件是外部包）；登录失败会降级，属于安全失败。

**不一致/缺口：** 文档“任何启动失败都停” vs 代码回退（第 2 条）；文档“读不懂的行都 costUnknown” vs 跳过非 group 行（第 7 条）；`creditProvider.signIn` 只校验真值（低）；`"none"`/`"unknown"` 作为 provider id 会冲突（低）；插件解包后完整性不在每次运行核对范围（第 5 条）；`creditReserve` 的“模型数”没有算可能替补的模型（第 1 条）。
