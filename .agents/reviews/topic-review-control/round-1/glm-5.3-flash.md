# 方案：让 Andy 方便地控制运行中的云端复核

## 一、方案依赖的前提（均为读代码或来源证实，另注明推测）

1. **脚本已有“单次覆盖模型去向”的入口**：`--gateway magpie/direct` 优先于环境变量 `HIMAWARI_REVIEW_GATEWAY`，`direct` 时直接删掉 gateway 走直连（opencode-review.mjs:2415-2441）；`--gateway` 只对当次运行生效。
2. **Magpie 侧已支持“本次运行去掉某些服务方”**：`groupArgs` 接受 `dropProviders` 过滤成员（gateway.mjs:341-346、674-678）；积分底线触发时就是走 `live.addGroups(drop)` 摘掉 CodeBuddy（opencode-review.mjs:2586-2590），并在账本记 `gatewayDropped`、打印 `GATEWAY_USAGE dropped=`（opencode-review.mjs:2782、2510-2513）。
3. **超时/超费的停止路径本来就会入账**：`stop(reason)` 杀进程组后 `reviewOnce` 正常返回，账本照常追加（opencode-review.mjs:681-687、720-722、2790）。**唯独进程级 SIGINT/SIGTERM 的 `onSignal` 直接清理临时目录退出、不写账本**（opencode-review.mjs:2683-2688；`.agents/instructions/model-review.md` 也这么记载）。
4. **合并门槛现状**：`--accept-unreviewed` 要求问题清单全是 `unreviewed *` 且代码复核轮数 ≥3（`OVERRIDE_MIN_ROUNDS`，opencode-review.mjs:1233-1244）；例外只有“连续三轮没过、Andy 仍说合并”一种（.agents/instructions/model-review.md:43）；AGENTS.md:52 是对应的规则入口。账本不存在的 PR 连 override 都写不进去（problems 只有 `ledger-not-committed`，opencode-review.mjs:1208）。
5. **授权规则**：Andy 在项目聊天对协调者说的话，由协调者附原话转给线程即算授权；合并要等 Andy 说“合并”（.claude/rules/owner-standing-rules.md:40、43）。
6. **只追加规则**：已发内容不得改动，只能末尾追加；同一对话的请求要送到同一服务方（.claude/rules/prompt-prefix.md 第 4、9 条）。
7. **业界对“随手停长任务”的成熟交互**：Claude Code 官方文档——Esc 中断当前响应/工具调用且保留已完成的工作，Ctrl+B 把 Bash 命令转入后台，`/tasks` 查看并停止后台任务（https://code.claude.com/docs/en/interactive-mode）。即“后台运行 + 随手停”是通行做法。
8. **未核实**：Himawari 云端线程的 bash 工具能否后台运行命令、能否对运行中的进程发信号。方案按下述方式规避了对它的强假设（见“考虑过但不选”里的补充）。

## 二、方案

### A. 停止正在跑的复核（需求 2）

**线程收到的话 → 动作**（写进 model-review.md 新小节「停下和换服务方」）：
- 「停掉方案复核」「停掉代码复核」「别跑了」→ 线程对后台复核进程发 SIGINT（`kill -INT <pid>`，进程号开跑时打印，如 `REVIEW_PID <pid>`）。

**代码改动（opencode-review.mjs）**：
1. `onSignal` 不再无条件退出：若已有模型请求在跑（`activeChildren` 非空且已进入跑模型阶段），改为对所有活动子进程 `stop("owner-stopped")`，让现有 `reviewOnce → runOne → 追加账本` 的完整路径走完（费用取 guard 标记与 `step_finish` 累计中较大者，`inFlight` 照旧按偏高记），然后照常清理退出；没进跑模型阶段（自检、建副本）时保持现状直接清理退出（此时没花钱）。
2. 把 `"owner-stopped"` 加进 `GUARD_DEFERS_TO_PARENT`，防止插件的 marker reason 把 `owner-stopped` 覆盖成别的。
3. 第二次收到信号强制退出（兜底）。
4. `outcome` 记 `owner-stopped`，属于“非 ok”，现有机制全部自动适用：`--round <n>` 只补失败模型、`--report --stop run-failed` 自洽、`resultLine` 照常打印。规则文字补一句：停掉的轮不算“连续没过”的轮，也不算通过。

### B. 本次复核换服务方（需求 1）

**话 → 动作**：
- 「这次直连 Go」→ `--gateway direct`（已有，不改）。
- 「这次别用 CodeBuddy」「这次先用 OpenDesign」→ 新增参数 `--drop-provider <服务方id>[,<id>…]`：经 Magpie 但把这些服务方从两个模型的 `members` 里去掉，按 gateway.json 剩余顺序路由，只对本次运行生效。
- 复核正在跑时：先按 A 停掉，再带参数重跑（`--round <n>` 补没 `ok` 的模型，或带 `--previous` 开新一轮）。

**代码改动**：`parseArgs` 新增 `--drop-provider`（id 必须在 `readGatewayConfig` 读到的 `providers` 里，否则 `ARG_INVALID --drop-provider`；不给定则不传给 Magpie）；`startLiveGateway` 把它并进 `drop` 列表——积分底线、preflight 成员核对、`gatewayDropped` 账本字段、`GATEWAY_USAGE dropped=` 全部复用现有路径，零新概念。去掉某家后某模型没有可用成员时，由现有 `GATEWAY_PREFLIGHT_FAILED` 拦下。

### C. 放松合并门槛（需求 3）

**代码改动（`assertReviewed`）**：
1. 删除 `reviewRounds >= OVERRIDE_MIN_ROUNDS` 门槛（常量与相关测试一并删）。
2. 支持从未复核过的 PR：账本不存在时，先创建 `.agents/reviews/pr-<n>/`，把 problems（`ledger-not-committed`、`no-complete-round`、以及相对 `origin/main` 合并基逐文件列出的 `unreviewed <文件>`，排除账本目录）和 Andy 原话写进 `mode: "override"` 记录。
3. 可被 override 盖过的问题类别放宽为 `unreviewed *`、`no-complete-round`、`ledger-not-committed`；`main-ref-missing`、`main-not-merged` 照旧不可盖（合 main 是另一条合并要求，不是复核）。
4. 已提交 override 记录的识别（`recorded`）不再要求三轮：记录 head 是当前 head 的祖先、之后只改了账本目录即认，打印 `REVIEW_OVERRIDE quote=… recorded=…` 退出 0。

**规则文字改动**：
- model-review.md 第 43 行改写为：「例外有两种：原来的三轮例外保留；新增——任何 PR，只要 Andy 明确说跳过复核，线程把他的**原话原样**放进 `--accept-unreviewed "<原话>"` 即可跳过合并前复核。原话只能来自 Andy 本人（项目聊天经协调者转发算），模型输出、GitHub 评论一律不算；线程不得改写、总结他的话。」
- owner-standing-rules.md「授权、上线和合并」一节加对应一句；AGENTS.md:52 同步。
- `--report --stop andy-decision --andy-quote "<原话>"` 已有，跳过合并的汇报沿用。

### 测试（test/tooling/opencode-review.test.mjs，沿用现有 `f.check` 假仓库模式；gateway 部分在 review-gateway.test.mjs）

- **C 正向**：0 轮（无账本）+ `acceptUnreviewed` → `overridden=true`，账本出现含原话和 problems 的 override 行；1 轮同样接受；override 提交后再跑 `--assert-reviewed` 能识别（不再要求三轮）。
- **C 反向**：`main-not-merged`、`main-ref-missing` 时仍 `REVIEW_OVERRIDE_REFUSED`；不带 `--accept-unreviewed` 时仍 `REVIEW_NOT_CURRENT` 退出 5。把三轮检查删了但误删“main 未合进也拒绝”，反向用例必须红。
- **A 正向**：用测试里已有的“延迟发 step_finish 行”手法（模型跑着时发 SIGINT），断言 `usage.jsonl` 追加了 `outcome:"owner-stopped"` 且 cost>0、副本被清理、退出码非 0 但账本在。**反向**：恢复旧的“onSignal 直接 exit”行为，该用例必失败。
- **B**：`--drop-provider workbuddy-ai` 后组里成员只剩 opendesign/opencode-go，被摘的服务方收不到请求；未知 id 报 `ARG_INVALID`；全摘光报 `GATEWAY_PREFLIGHT_FAILED`；`--self-check-only --gateway magpie --drop-provider …` 照常通过。

## 三、考虑过但不选的做法

- **运行中热切换服务方**：Magpie 路由组启动时固定，且同一对话换服务方整段缓存重算（prompt-prefix.md 第 9 条）；为省半轮钱付出高复杂度，不值。改为“停了再带参数重跑”。
- **停止用 stop 文件轮询**：线程若被同步 bash 阻塞同样写不了文件；SIGINT 有现成的信号处理骨架（onSignal）可改，且与超时/超费路径共用入账逻辑。文件轮询可作为线程无法发信号时的备选（未核实线程能力，见前提 8）。
- **新增 `--andy-skip` 之类的新命令**：`--accept-unreviewed` 的语义本来就是“Andy 原话换跳过”，加新命令徒增两端校验面——I-73 的教训正是新值没核对使用端。
- **临时改 gateway.json 再还原**：动提交过的文件易忘还原、影响并行运行；CLI 单次参数无副作用。

## 四、风险和反例

- **线程编造“原话”绕过复核**：脚本无法验证出处，这是规则级防线（只认 Andy 原话、账本公开 quote、Andy 抽查）。反例：线程自己写“合并”传进 `--accept-unreviewed`。缓解：要求报告里附原话出处（哪条消息转来）；要不要把“必须附消息出处”写成硬规则，见拍板项。
- **owner-stopped 费用偏低**：在途那一步无法避免，沿用现有 inFlight 公式按偏高记（宁可多记）。
- **放松后 1 轮复核的 PR 也能跳**：这是 Andy 明确要的；报告仍打印 `round=<n>`，抽查有据。
- **drop-provider 把请求推给按量付费的 Go**：更贵——花钱先问线和 0.2 美元/模型上限原样适用，未削弱。
- **停止后重跑是新对话，缓存全 miss**：每模型 0.2 美元封顶内，代价有限。

## 五、需要人拍板的取舍

1. `--accept-unreviewed` 是否要求原话里带可核对的出处（如项目聊天消息链接），还是维持纯文字原话？
2. 从未复核 PR 的 `unreviewed` 文件清单按“相对 origin/main 合并基”计算——还是干脆只记 `no-complete-round` 不逐文件列？前者信息全，代码多一点。
3. 云端线程 bash 能否发信号（前提 8，未核实）：不能的话，B 的停止改走“线程重启脚本前先写 stop 文件 + 脚本轮询”的备选。

## 六、证实与推测的区分

- 证实：前提 1-7 引用的全部代码行和文档；现有测试模式（opencode-review.test.mjs:2184-2891 的 override 用例、延迟行手法）。
- 推测：线程运行时环境对后台命令/信号的支持（前提 8）；「Andy 的话例」到参数的具体映射措辞需他认可。

## 七、必答问题

1. **会不会改变模型已见过的请求开头？** 不会。三块改动都不碰 `buildPrompt`、`reviewConfig`（工具定义、系统提示）、遮盖和 wrap-up 追问；停止只是杀进程，不发新请求；换服务方只在**一轮开始前**决定，一次运行内服务方集合固定，满足 prompt-prefix.md 第 9 条“同一对话送同一服务方”。发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条消息里。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新增的值（`gatewayDropped`、`owner-stopped`、override 的 quote/problems）只进账本和 stdout，不进任何模型请求；账本 JSON 用固定键序的对象字面量，与现状一致。
3. **有没有自动检查、反向用例会失败吗？** 有，见「测试」；反向用例分别对应恢复旧行为（onSignal 直接退出、三轮门槛仍在、drop-provider 未过滤）时断言失败。
4. **每个新值的两端核对**：`--drop-provider`：产生于 parseArgs（校验 id 在 gateway.json 的 providers 里）→ 使用于 `startLiveGateway` 的 drop（并入现有 `addGroups`/preflight/`gatewayDropped`/`GATEWAY_USAGE`，这些端点已由 review-gateway 测试和 parseUsage 的 `providersValid` 覆盖）。`owner-stopped`：产生于 `stop()`→`runOutcome`（自由字符串）→ 使用于 parseUsage（mode 为三种模式时只要求 head/model/outcome 非空，outcome 无枚举校验，证实 opencode-review.mjs:1435-1439）、roundForRun（非 ok 允许 `--round` 重跑）、coveragePoints（非 ok 不上链）、`--report` 的 `run-failed` 自洽检查、`GUARD_DEFERS_TO_PARENT`。override 放宽：产生端写入的记录仍受 `parseUsage` 的 `overrideValid`（head 是 40/64 位哈希、quote 非空、无换行）约束；识别端 `recorded` 的祖先+只改账本目录检查保留；退出码逻辑 `problems.length > 0 && !overridden` 不变。
