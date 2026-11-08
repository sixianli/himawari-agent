# 复核报告：PR 292（a9b19331，基准 34843f52）

先说明一个读取限制：`.agents/reviews/topic-review-control/` 下的 proposal.md、judgments.md、round 文件都读不到——git 替身按仓库自身规则拒绝一切含 `agents/reviews` 的参数（scripts/model-review/opencode-review.mjs:519、533-534，本环境实测 `git show` 返回 `REVIEW_GIT_REFUSED records-path`，该文件也只存在于 git 历史不在工作区）。所以「作者说法与 proposal.md 逐条一致」**未核实**；以下核对对象是代码本身、`.agents/instructions/model-review.md`、ADR 0178 和测试。「194 条测试通过」「npm run check 通过」「真实 Magpie 实测」也无法运行验证，标**未核实**。

## 发现（按严重度）

**中 | .agents/instructions/model-review.md:44（新文本）对照 scripts/model-review/opencode-review.mjs:1378-1431**
问题：新增原话「脚本验证不了原话是不是真是 Andy 说的，由线程负责、`--report` 列出每次覆盖供 Andy 抽查」——`--report` 并不列出每次覆盖。这是本次放松合并门槛后唯一的抽查出口，文档承诺与代码不符。
证据：`reviewReport` 输出只有 `REVIEW_RESULT` 各行、`REVIEW_SPENT_TOTAL`、`lowFixLines`、`gate.lines`、停的原因和免责句（1422-1430）；`gate.lines` 只在 `recorded` 找到时带一条 `REVIEW_OVERRIDE quote=…`（1345），且 `recorded` 只在 `overridable`（problems 非空）时才查（1291-1292）。覆盖记录被后续正常复核盖过（problems 为空，输出 `REVIEW_CURRENT`）后完全不再出现；账本里有多条 override 也最多显示一条。
建议：在 `reviewReport` 里遍历账本列出全部 `mode === "override"` 的记录（quote、head、problems），或把文档改成只承诺「抽查账本」。

**中（测试缺口 + 依赖未核实的外部行为）| scripts/model-review/opencode-review.mjs:2701-2707**
问题：本次的核心新行为「起来后的 `/models` 里没有某成员 → `live.stop()` → `addGroups()` 重建 → 再 `serve()`」没有任何测试。`review-gateway.test.mjs` 两个新用例分别覆盖的是「建组时 knows no model」（1013-1030，组命令报错，成员名不在声明清单）和「请求时故障转移」（refused port），都不进这条分支；`/models` 返回非 200 报 `GATEWAY_PREFLIGHT_FAILED models=`（2689）同样无用例。
推测（无法离线核实 Magpie 二进制语义）：这条分支和 `addGroups` 的重试循环（2675-2686）都会对同一个 Magpie **重复执行** `magpie group add`（组名固定 `review-<模型短名>`）。真实第 1 轮跑两个模型：若模型 1 的组建成功、模型 2 报 knows no model，重试会重发模型 1 的 group add——若 Magpie 不允许对已存在组重复 add，预检会整体失败而不是只去掉一家。测试里只用了单模型（`models: [deepseek]`），掩盖了这个顺序问题。
建议：补一条「假上游的 /models 缺某成员」用例走完 stop→re-add→serve 分支，并用两模型配置验证重复 group add 的行为。

**低 | scripts/model-review/opencode-review.mjs:1512-1518、2577-2579、2898**
问题：`parseUsage` 新增的 `gatewayDropped` 校验（必须是非空字符串数组）完全没有测试——两个测试文件里 grep `gatewayDropped` 零命中；账本写入 `gatewayDropped`（2898）和 `GATEWAY_USAGE` 行的 `dropped=`（2577-2579）也无测试，反向用例自然不存在。
建议：至少补一条反向用例（`gatewayDropped` 为字符串或含空串时 `USAGE_LEDGER_INVALID`）。

**低 | .agents/instructions/model-review.md:95 对照 opencode-review.mjs:93、743-744**
问题：第 95 行仍写「**只有**脚本自己发现的 `cost-unknown` 和追问时的 `wrap-up-tool-call` 保留脚本的判断」，未随 `GUARD_DEFERS_TO_PARENT` 加入 `owner-stopped` 更新。副作用：插件已因费用超限拦下（marker.reason=cost-limit）而 Andy 同时叫停时，outcome 记 `owner-stopped` 而非 `cost-limit`；费用不少记（809-816 取 marker 累计的较大值，987-996 对 inFlight 加保底），但「超限」被记成「叫停」。
建议：更新第 95 行那句，或把 `owner-stopped` 从 defer 名单里去掉。

**低 | opencode-review.mjs:2733-2737 与 `--self-check-only`**
问题：`--providers` 与 `--self-check-only` 同给时被静默忽略（main 校验 id 后，自检走自己的假网关，2823 在 `startLiveGateway` 之前 return）。与文档「多给的参数……不会悄悄忽略」的精神不一致，不危险。
建议：文档注明，或像 `--out` 一样拒绝。

**信息 | 叫停的花费与进程（重点核查项，读代码证实）**
- 记账：stop 后 `runOne` 照常执行，先读 `stableUsage()`（2895）再 append 账本（2906），guard marker 费用与 inFlight 保底都进账（809-816、987-996）；`REVIEW_SPENT_TOTAL` 在 `REVIEW_STOPPED`/130 之前打印（2954-2965）。
- 进程：子进程 stop() 先 SIGTERM、10 秒后 SIGKILL（723-728），finish 再补一次 SIGKILL（738）；cleanup 停掉所有 Magpie 并杀子进程、删副本（2789-2793），finally 必走（2967-2972）。第二信号立即 `cleanup()+exit`，可能丢掉尚未 append 的记录——文档 model-review.md:61 已明说，按设计不算缺陷。

## 侧重检查

走过的流程（两条）：
1. **Andy 说「停止复核」**：后台启动 → 首行 `REVIEW_PID`（2803，先于自检，符合文档「开跑后第一行」）→ `kill -INT` → `signalHandler` 首信号打印 `REVIEW_STOPPING` 并 `requestStop`（499-500）→ 杀子进程、读 marker、记账、`REVIEW_STOPPED owner-stopped` 退 130（2963-2966）；二次信号/30 秒强退（493-497、501-504，STOP_GRACE_MS=30000）。信号在自检或建网关阶段到达则立即清理退出（`modelsRunning=false`），此时未花钱、无账可漏。结论：流程与文档一致；**main 级端到端（REVIEW_PID→kill→账本落盘）只有单元级覆盖**（[owner stop] 两个用例测的是 `reviewModel`/`signalHandler`，不经过 main 的 runOne/账本写入段）。
2. **云端默认 `--gateway magpie` 的代码复核全流程**：parseArgs → 网关配置读入与 id 校验（2733-2737）→ 预算门槛 → 安装 opencode/Magpie → 副本+自检 → `startLiveGateway`（登录/积分底线/建组//models 预检）→ 双模型并行 → 记账 → 替补判断 → 汇总退出。结论：主流程各步都有既有测试；**无覆盖的路径**：上文「中」条列的 drop-and-restart 分支与 `GATEWAY_PREFLIGHT_FAILED models=` 分支、`gatewayDropped` 的写/校验/打印、main 级停止端到端。

## 必答问题

1. **不会改变请求开头。**改动不触碰 `buildPrompt`、`reviewQuestions`、`FOCUS_SENTENCE`、工具定义和遮盖；新文档一节在「每次都要问的问题」之后，有 `[owner control]` 测试双向证明节内内容进不了必问问题、问题数仍为 4。叫停/跳过路径只杀进程、写账本，不组装任何新模型请求——`stopRequested` 时追问（937）、重试（875）、替补（2915）全部关闭，反而少发请求。仍是末尾追加。
2. **不会。**新值 `gatewayDropped` 按 `gateway.json` 顺序生成（2715 `ids.filter`）后按数组序列化，不依赖 Set/对象遍历；override 记录的 `problems` 顺序由固定代码顺序和 git diff 输出决定；`at` 时间戳只进账本，不进模型请求。
3. **部分有。**参数解析（`ARG_PROVIDERS_NEED_GATEWAY`×3、`a,,b`、未知 id 经子进程实测退出码 2）、提示词规则双向用例、signalHandler 四种走向、叫停记账、合并门槛的各条拒绝（main-not-merged、ledger-differs-from-HEAD、three-rounds 含 owner-stopped 轮报 `REPORT_STOP_INCONSISTENT`）都有真实断言；缺口见上面「中」「低」两条（/models 缺成员分支、gatewayDropped 校验）。
4. **逐值核对：**`--providers` id 产生端由 main 对照 `gateway.json` 校验（2733-2737），消费端 `startLiveGateway` 只按它过滤（2605-2614），两端一致；`gatewayDropped` 产生端是配置 id、消费端 parseUsage 校验非空字符串数组（1516-1518），类型一致但无测试；`owner-stopped` 消费端 `coveragePoints` 只认 `ok`（1138，不上链）、`reviewReport` 三轮统计排除它（1395）、文档（model-review.md:91、61）一致；`REVIEW_OVERRIDE_WRITTEN` 的两步放行（写后退出码 5、提交后认出才 0，2726-2731）与文档和测试（2951-3011）一致。发现的不符是文档层的两条（--report 覆盖清单、第 95 行「只有」）。

**读代码证实的**：以上所有引用行。**推测/未核实**：Magpie 对重复 `group add` 和已停止实例重建组的语义；proposal.md 的内容；测试与 `npm run check` 的实际运行结果；作者的真实 Magpie 实测。
