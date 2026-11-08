## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档/代码一致性逐项查了：

- **错误路径**：零轮/无账本覆盖（`opencode-review.mjs:1171-1172,1256-1258,1299-1301`）、`--round` 补跑（`:1518-1522`）、`--providers` 预检（`:2539-2637`）、SIGINT 两条路径（`:2708-2718`）。
- **不可信输入**：`--accept-unreviewed` 原话只查控制字符（`:2389-2392`），内容无法验证；`--providers` id 来自命令行（方案未写校验位置）；账本字段 `gatewayDropped` 没有校验（`:1460-1462`）。
- **安全/花钱**：`--providers` 与 CodeBuddy 积分底线（`:2558,2570`）；覆盖记录未提交就返回 0（`:1297-1309,2651`）；`--accept-unreviewed` 可覆盖零轮。
- **资源耗尽**：第二次 SIGINT 用 `process.once`（`:2717-2718`），Node 文档明确“If one of these signals has a listener installed, its default behavior will be removed.”（https://nodejs.org/api/process.html#signal-events ），第一次后监听被移除，第二次直接终止，detached 的 opencode/Magpie 可能残留。
- **不可撤销**：覆盖记录、跳过复核、合并。`main-not-merged`、`main-ref-missing` 保持不可覆盖是对的。
- **规则/文档/代码一致**：`model-review.md:43` 的“至少三轮”与删掉 `OVERRIDE_MIN_ROUNDS` 冲突；`:110`、`:129` 没写 `--providers`；`reviewQuestions` 的切片方式（`:221-226`）与方案的反向用例要求不一致。

---

## 证实的（按严重度从高到低）

### 高

**1. `--providers` 会绕过 CodeBuddy 积分底线，花钱保护失效**

- 证据：`scripts/model-review/opencode-review.mjs:2558` `let drop = uid ? [] : [config.creditProvider];`；`:2570` `if (drop.length === 0) { ... 积分检查 ... }`。方案说“没列出的并进 drop”。只要列了 CodeBuddy、同时没列其他任何一家（例如 `--providers workbuddy-ai,opendesign` 把 `opencode-go` 放进 drop），`drop.length` 就非 0，整段积分检查被跳过，CodeBuddy 低于底线也会被用。方案原文承诺“列出了 CodeBuddy 但积分扣掉预留后低于底线时，照旧不用它（不绕过底线）”。
- 建议：条件改成 `if (!drop.includes(config.creditProvider))`；加用例：列 CodeBuddy+OpenDesign、不列 Go、CodeBuddy 积分低于底线，断言 CodeBuddy 不在组里、请求只到 OpenDesign。依据 `owner-standing-rules.md:16-19` 的先问门槛和套餐优先。

**2. 零轮覆盖：`ledgerMatchesHead` 会拒绝新建账本；即使写成功，也会在提交前返回 0**

- 证据：`:1256-1258` `ledgerMatchesHead = (existsSync(ledgerFile) ? readFileSync(...) : null) === shown.stdout`；`shown` 来自 `git show HEAD:.../usage.jsonl`（`:1171`）。账本不在 HEAD 时 `shown.status !== 0`、`shown.stdout` 为空字符串，`existsSync` 为 false 时左边是 `null`，`null === ""` 为 false。`:1299-1301` 在 `!ledgerMatchesHead()` 时直接打印 `REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD`，不会创建文件。方案“账本还不存在时写进新建的 usage.jsonl”与这段代码冲突。
- 另外，`:1297-1309` 写成功会立刻置 `overridden=true`，`:2651` 因 `problems.length > 0 && !overridden` 为 false 而以 0 退出。线程若直接合并，账本还没提交，审计记录不存在。方案说“线程提交后再跑一次……才算通过”，但脚本第一次已经返回成功，没有强制。
- 建议：把“账本不存在”和“账本存在但未提交”分开：前者创建目录和空账本、写覆盖记录，但**不**置 `overridden`，以非零（如 5）退出并打印“commit the ledger and rerun”；后者仍拒绝。只有 HEAD 里能读到覆盖记录时才返回 0。加反向用例：不提交账本就合并必须失败。

### 中

**3. 第二次 SIGINT/SIGTERM 不会清理，detached 的 OpenCode/Magpie 可能残留**

- 证据：`:2717-2718` 用 `process.once("SIGINT", onSignal)` / `process.once("SIGTERM", onSignal)`。Node 文档：“If one of these signals has a listener installed, its default behavior will be removed.”（https://nodejs.org/api/process.html#signal-events ）`once` 第一次触发后移除监听，第二次恢复默认行为，进程直接终止，`cleanup()`（`:2708-2712`）不跑；opencode 是 `detached: true`（`:676`），Magpie 也是 detached（`gateway.mjs:688`），会继续跑。先 SIGINT 再 SIGTERM 时 SIGTERM 的监听还在，第二次也不会强制退出。
- 建议：改用 `process.on` + `stopping` 标志；第一次设标志、调用各模型的 `stop("owner-stopped")`、启动 30 秒强制计时；第二次（任意信号）`cleanup()` 后 `process.exit`；`finally` 清除计时器。

**4. `--providers` 只限制了路由组成员，没有限制 `startGateway` 配置的服务方**

- 证据：`:2560` `live = await start(withCredit, ...)` 把全部服务方传给 `startGateway`；`gateway.mjs:634-663` 会对每个 provider 执行 `plugin add`、`provider add`、`plugin login`。方案的 drop 只影响 `groupArgs`（`gateway.mjs:341-356`）的成员过滤，不会阻止未列出的服务方被安装/登录。若 Andy 因为 CodeBuddy 坏了而说“这次不用 CodeBuddy”，脚本仍会尝试配置 CodeBuddy，失败就 `GATEWAY_PREFLIGHT_FAILED`。
- 建议：在 `startLiveGateway` 里把 `providers` 参数过滤成 `withCredit.filter(p => requested.includes(p.id))`，或在 `startGateway` 里跳过 `drop` 中的 provider。加用例：未列出的服务方插件登录失败时，复核仍用列出的服务方成功。

**5. `owner-stopped` 会被 `--report --stop three-rounds` 当成一轮**

- 证据：`:1337-1338` `const reviews = records.filter(record => record.mode === "code-review"); const rounds = [...new Set(reviews.map(record => record.round ?? 1))];`；`:1345` `"three-rounds": rounds.length >= 3`。这里不看 `outcome`。两轮真失败 + 一轮 owner-stopped 也会满足 `rounds.length >= 3`。方案说“owner-stopped……不算‘连续三轮没过’的一轮”，但脚本不这么算。`no-error`/`run-failed`（`:1344,1347`）也只按 `accepted` 链，可能把“另一个模型 ok、这个模型被停止”的轮次当成完整轮次。
- 建议：`rounds` 只计 `outcome === "ok"` 的轮次，或为 `three-rounds` 增加“每轮至少有一个非 owner-stopped 的完整结果”条件；加用例：2 轮真失败 + 1 轮 owner-stopped 时 `--report --stop three-rounds` 必须拒绝。

**6. 停止后先提交账本，再用 `--round <n>` 补跑会撞上 `ROUND_HEAD_MISMATCH`**

- 证据：`:1518-1522`：`inRound` 里所有记录的 `head` 必须等于这次 `--head`，否则 `ROUND_HEAD_MISMATCH`。方案的停止流程是“等它退出后提交账本和已经写出的提示词”，提交账本会产生新的 HEAD；owner-stopped 记录的 `head` 是代码提交。线程若按常规传 `--head HEAD`，新 HEAD 是账本提交，必然不匹配。
- 建议：明确补跑时 `--head` 传 owner-stopped 记录里的代码提交；或让 `roundForRun` 允许“记录之后只改了本 PR 记录目录”的 HEAD 差异（用 `changedOutside` 判断）。加用例覆盖“先提交账本再补跑”。这是 I-73 同类问题：`head` 的生成方和使用方没有对齐。

**7. 新一节的“反向用例”在 `##` 标题下不会失败**

- 证据：`:221-226`：`reviewQuestions` 从 `<a id="checklist"></a>` 开始，按 `\n(?=<a id=|## )` 切分，取前两段，再用 `/^\d+\.\s+(.+)$/gm` 抽问题。如果新一节是 `## Andy 怎样控制复核`（或带 `<a id>`），它会被切开，`1.` 行根本不会被抽到，插一行 `1.` 不会让“正好 4 条”的用例失败。只有当新一节是 `###`/无标题、落在 checklist 的切片里时，插 `1.` 才会改变条数。方案一边说“放在必问问题那一节之后”，一边要求反向用例失败，二者取决于标题级别，方案没写清。
- 建议：明确用 `##`（或 `<a id>` + `##`）把新一节切开；反向用例改成“把 `1.` 插进 checklist 的 4 条之间/之后、仍在同一 `##` 段内，条数必须变成 5”；再补一条“新一节里的 `1.` 不影响 `reviewQuestions`”的用例。

**8. `model-review.md:43` 的“至少三轮”没有在方案里明确删除**

- 证据：`model-review.md:43` 原文“已提交的例外记录被认出时同样要求至少三轮”“账本里的代码复核少于三轮时，脚本不接受这个例外……`rounds=<n> needs=3`”。方案说删掉 `OVERRIDE_MIN_ROUNDS`、把例外改成“Andy 明确说跳过复核”，但没有逐句说明删除这些“三轮”表述。改完代码后规则文件和代码会矛盾。
- 建议：明确删除/改写 line 43 的“至少三轮”“rounds=<n> needs=3”“已提交的例外记录被认出时同样要求至少三轮”；`AGENTS.md:52` 的“连续三轮没过”要说明这是“停下报告”的条件，不是覆盖的条件。加文档/代码一致性检查（例如 grep `needs=3` 不再出现）。

**9. `--providers` 的文档没有跟上**

- 证据：`model-review.md:110` 的用法行只列了 `--gateway`、`--models`、`--round`、`--questions-ref`、`--approved-usd`；`:129` 只写了 `GATEWAY_PROVIDER_DROPPED <服务方> missing=<成员>`。方案的 item 3 没有说更新这两处。`AGENTS.md:54` 要求步骤和材料写法以 `model-review.md` 为准。
- 建议：在 `:110` 加 `--providers`，在 `:129` 写清 `requested` 和 `missing` 两种打印、以及“列出的服务方缺模型时 `GATEWAY_PREFLIGHT_FAILED`”。

### 低

**10. 停止请求落在 wrap-up 或 substitute 的启动窗口时不会生效**

- 证据：`:854-937` 的 `reviewOnce` 在第一次运行结束后会决定是否启动 wrap-up；`:2826-2855` 在主模型结束后会启动 substitute。方案只对“正在跑的模型”调用 `stop`，没有在启动 wrap-up/substitute 前检查“已经收到停止请求”的标志。信号若恰好落在两次 `runOpencode` 之间，注册表为空，新的运行会照常开始。
- 建议：加 `stopRequested` 标志，`reviewOnce` 在启动第二次运行前、`main` 在启动 substitute 前检查；已请求停止就跳过并记 `owner-stopped`。加用例覆盖“第一次运行结束后、wrap-up 开始前收到 SIGINT”。

**11. 临时目录清理的断言可能指错目录**

- 证据：`:2706-2712` 的 `cleanup` 只删 `workRoot`；`:2305-2308` 的 raw 目录在 `tmpdir()/himawari-review-raw/...`，脚本从不删除。方案测试说“临时目录已删”，如果指 raw 目录会失败；如果指 `workRoot`，测试需要能拿到它。
- 建议：测试明确断言 `workRoot`（`opencode-review-*`）已删，不要断言 raw 目录；或明确在 `cleanup` 里也清理本次 raw 目录（但现有文档说 raw 目录留给排查）。

**12. `--providers` 与 `--gateway direct` / 环境变量的组合校验**

- 证据：`:2415-2417` 解析 `--gateway`，`:2441` `if (options.gateway === "direct") delete options.gateway;`。`--providers` 如果只在 `parseArgs` 里检查 `options.gateway`，会漏掉 `--gateway direct`（已被删除）和 `HIMAWARI_REVIEW_GATEWAY=direct`（`:2436-2440` 才应用）。方案说“和 `--gateway direct` 同用报 `ARG_PROVIDERS_NEED_GATEWAY`”，但没写怎么区分“显式 direct”和“默认直连”。
- 建议：在应用环境变量默认值之后再校验：如果 `--providers` 存在且最终没有 Magpie（`options.gateway !== "magpie"`），报 `ARG_PROVIDERS_NEED_GATEWAY`。加 `--gateway direct --providers ...` 和 `HIMAWARI_REVIEW_GATEWAY=direct --providers ...` 两条用例。

**13. `gatewayDropped` 没有校验**

- 证据：`:1460-1462` 的 `gatewayValid` 只校验 `record.gateway` 和 `record.providers`，不校验 `gatewayDropped`；`:2510-2511` 直接 `record.gatewayDropped.join(",")`。方案新增 `--providers` 会往这里写值。虽然值来自受校验的 `config.providers` id，但账本可手写；`join` 对非数组会抛错。
- 建议：在 `parseUsage` 里把 `gatewayDropped` 校验为非空字符串数组（可选），并在 `gatewayUsageLine` 里防御非数组。加 `USAGE_LEDGER_INVALID` 用例。

**14. `--providers` 的 id 校验时机**

- 证据：`parseArgs`（`:2343-2471`）不读 `gateway.json`；`readGatewayConfig` 在 `main`（`:2700`）才读。方案说未知 id 报 `ARG_INVALID --providers`，但 parse 阶段无法知道。若在 `main` 里校验，错误码可以是 `ARG_INVALID --providers`，但要确保在花钱/安装前。
- 建议：在 `main` 读完 `gateway.json` 后、`budgetCheck`/安装前校验；错误信息用 `ARG_INVALID --providers <id>`，并加“未知 id 不安装、不花钱”的用例。

**15. `REVIEW_PID` 的可用性依赖线程能后台运行命令（未核实）**

- 证据：方案说“开跑时打印 `REVIEW_PID`”，线程“kill -INT”。但 `opencode-review.mjs` 是长命令；如果线程在同一个 Bash 工具调用里前台等待，它在命令结束前拿不到 PID，也无法并发执行 kill。仓库的 `delivery-mode.md` 有后台命令的概念，但方案没有说明用后台方式启动和捕获 PID。
- 建议：在方案里写明“线程用后台命令启动复核，读第一行 `REVIEW_PID`，把它和运行编号记在任务里”；如果线程环境不支持后台命令，改用停止文件 + `fs.watch`（或 Unix socket），不要假设能并发 kill。加一条端到端演练证明线程能在复核运行时发 SIGINT。

**16. `reserveModels` 会把替补模型加进 `startGateway` 的组，`--providers` 只覆盖 DeepSeek 时可能预检失败（当前配置不触发）**

- 证据：`:2516-2521` `reserveModels` 在 `code-review && previous && models.length === 1` 时返回 `[...models, substitute]`；`:2746` 用它做 `reserveFor`；`startLiveGateway` 把 `reserveFor` 传给 `startGateway({models: reserveFor})`（`:2544`），`gateway.mjs:674-681` 为每个 model 建组。若列出的服务方只覆盖 DeepSeek、不覆盖 GLM，GLM 组会 `GATEWAY_NO_MEMBERS`，整次复核 `GATEWAY_PREFLIGHT_FAILED`，即使 GLM 只是替补。当前 `gateway.json` 三家都覆盖两个模型，所以现在不触发。
- 建议：`--providers` 时只把真正要跑的模型放进 `startGateway` 的组，替补模型等到真要用时再建组；或在文档里要求列出的服务方必须覆盖两个模型。加一条“只覆盖 DeepSeek 的服务方 + 只跑 DeepSeek 的轮次”用例。

---

## 推测 / 未核实

- 我没有运行测试；“反向用例会不会失败”的判断来自读测试和源码，不是实际运行。
- `REVIEW_PID` 在云端线程的后台命令里是否可见、线程能否并发执行 kill，取决于线程运行时；未核实。
- 真实 Magpie 在 `--providers` 下“只列一家时只有它收到请求”的行为，方案有测试计划，但我没有真实 Magpie 环境，未核实。
- `git show` 在路径不存在时 stdout 为空字符串，是 Node `spawnSync` 的标准行为；读代码确认，但没有在这个仓库实际跑一条失败命令。
- `gateway.json` 未来是否会出现只覆盖一个模型的服务方：当前配置不会；方案 `model-review.md:125` 说新服务方必须提供同样的两个模型，若坚持这条，第 16 条只是理论风险。

---

## 如果由我来定

1. **把“跳过复核”和“覆盖未复核文件”拆成两件事。** `--accept-unreviewed` 继续只盖 `unreviewed`（轮数可以按 Andy 的“放松”去掉三轮下限），另加显式的 `--skip-review "<原话>"` 处理零轮/`no-complete-round`/`chain-broken`/`not-ancestor`/`low-fix-invalid`。两种记录都要求**先提交账本再返回 0**：账本不存在时创建并写记录，但返回非零并提示“commit and rerun”；只有 HEAD 里读到记录才放行。`main-not-merged`、`main-ref-missing`、`ledger-differs-from-HEAD` 保持硬失败。
2. **停止用 `process.on` + 计数 + `stopRequested` 标志。** 第一次信号优雅停；第二次任意信号 `cleanup()` 后强退；30 秒兜底；启动 wrap-up/substitute 前检查标志。加 fake opencode 的就绪文件和 guard marker，确保测试不靠 sleep 猜时机。
3. **`--providers` 真正只配置列出的服务方。** 过滤传给 `startGateway` 的 `providers`；积分检查改成 `!drop.includes(creditProvider)`；读完 `gateway.json` 后校验 id；`requested` 和 `missing` 分开打印；处理替补模型的组。
4. **新一节用 `##` + 锚点，不含行首编号。** 正向测试断言新文件 `reviewQuestions` 仍是 4 条；反向测试把 `1.` 插进 checklist 的同一 `##` 段内，断言条数变化。更新 `model-review.md:110`、`:129`，删掉 line 43 的“至少三轮”。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会，前提是新一节用 `##`/锚点切开且不含行首编号。复核提示词的固定部分由 `MODE_TEXT`、`reviewQuestions`、`MODEL_LENSES` 组成（`opencode-review.mjs:275-304`）；本方案改的是 `AGENTS.md`、`model-review.md:43` 和新一节，前两者不在 `reviewQuestions` 的切片里（`:221-226` 只取 checklist 段），新一节若被切开也不在。材料仍然只在末尾追加（`buildPrompt` 的 `fixed\n\nmaterial`，`:303`）。但方案给的反向用例在 `##` 标题下不会失败，见第 7 条；这一点必须先修正，否则“不会改变”没有可靠的自动检查。依据：`.claude/rules/prompt-prefix.md:27-29,35`；Anthropic 也明确缓存按 tools→system→messages 的完整前缀匹配（https://platform.claude.com/docs/en/build-with-claude/prompt-caching ）。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

不会改变发给模型的字节。`--providers`、`owner-stopped`、`REVIEW_PID` 都是运行时/账本字段，不进入提示词；复核副本还排除了 `.agents/reviews/`（`:2272-2274`），账本对模型不可见。账本里确实有 `at: new Date().toISOString()`（`:1305`、`:2789`）和 `gatewayDropped` 的顺序，但那是账本，不是模型输入；若要账本字节确定，`gatewayDropped` 应按 `config.providers` 的固定顺序生成，不要按 `missing` 的遍历顺序。模型侧仍只在末尾追加，每轮变化的值仍在最后一条消息里。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

部分有，部分不够：
- 覆盖门槛：方案的反向用例（去掉放宽代码后失败）成立，但“零轮新建账本”用例会先被 `ledgerMatchesHead` 拒绝（第 2 条），必须先改代码。
- 中断：用 fake OpenCode + guard marker 的用例可行（参考 `test/tooling/opencode-review.test.mjs:1767-1807` 的 `killedWithMarker`），但方案说“延迟发 step_finish”，若 SIGINT 发生在延迟期间、fake 又没写 marker，费用会是 0，`inFlight` 也不成立；需要 fake 先写 marker/发一次 `step_finish`，并加就绪文件避免竞态。
- `--providers`：真实 Magpie 的“只列一家只有它收到请求”可行（参考 `test/tooling/review-gateway.test.mjs:978-1016`），但缺少第 1 条（积分底线）、第 4 条（未列出服务方仍被配置）、第 16 条（替补模型组）的用例。
- 必问问题：现有 `test/tooling/opencode-review.test.mjs:223-227` 已断言 4 条；方案的反向用例在 `##` 标题下不会失败（第 7 条）。
- 缺少：第二次 SIGINT 的用例、`owner-stopped` 与 `three-rounds` 的用例、先提交账本再 `--round` 补跑的用例、`--providers` 与 `HIMAWARI_REVIEW_GATEWAY=direct` 的用例。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐个核对：
- `--providers`：产生于 `parseArgs`；使用于 `readGatewayConfig`/`startLiveGateway`/`startGateway`/`groupArgs`/`creditReserve`。问题：积分检查用 `drop.length === 0`（`:2570`）不接受“其他服务方被 drop”的情况；`startGateway` 仍配置未列出的 provider（`:2560`、`gateway.mjs:634-663`）；`reserveModels` 的替补模型可能让 `groupArgs` 报 `GATEWAY_NO_MEMBERS`（`:2516-2521,2746`）。这三处必须改。
- `gatewayDropped`：产生于 `startLiveGateway`；使用于 `usage.jsonl`（`:2812`）和 `gatewayUsageLine`（`:2510-2511`）。`parseUsage` 不校验它（`:1460-1462`），建议补校验。
- `owner-stopped`：产生于 `runOutcome`（`:1560-1567`）；使用于 `coveragePoints`（`:1084-1125`，只看 `ok`，接受）、`reviewReport` 的 `rounds`（`:1337-1338`，**不接受**“不算一轮”的语义）、`resultLine`（`:966-967`，接受）、退出码（`:2869-2875`，接受）。`reviewReport` 必须改。
- `REVIEW_PID`：产生于脚本 stdout；使用于线程的 `kill -INT`。脚本不解析它；关键是线程能否后台运行并捕获（第 15 条，未核实）。
- 新一节：产生于 `model-review.md`；使用于 `reviewQuestions`（`:218-229`）。标题级别决定是否被切片，见第 7 条。
- 覆盖记录的 `head`：产生于停止/覆盖时的代码提交；使用于 `--round` 的 `ROUND_HEAD_MISMATCH`（`:1518-1522`）。先提交账本再补跑会不匹配，见第 6 条。
- 删除 `OVERRIDE_MIN_ROUNDS`：只在 `:1160,1236,1239-1240` 和测试中使用；删除后要同步改测试和 `model-review.md:43`（第 8 条）。
- 这正是 I-73 的教训：双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。这里对应的是“`--providers` 的 id 能通过积分检查和 `startGateway` 的配置吗”“`owner-stopped` 能通过 `reviewReport` 的轮次统计吗”。依据：`docs/incidents-and-gates.md` 的 I-73 行。
