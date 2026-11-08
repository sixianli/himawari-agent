你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 97f297cfa6fb505b5839df16e2f7b260382265c2。
待审核的方案：
# 方案：让 Andy 方便地控制正在运行的复核（线程的方案，已吸收两个模型独立方案里的几点，请审核）

## 前提（每条附来源）

1. 合并前必须复核：`AGENTS.md:52`“合并 PR 之前：对最终提交做一次代码复核”。
2. 现在跳过复核的唯一例外：`.agents/instructions/model-review.md:43`“例外只有一种：按第 4 步连续三轮没过而停下、Andy 看过报告仍说‘合并’时，加 `--accept-unreviewed "<Andy 的原话>"` 运行”。
3. 代码里的门槛：`scripts/model-review/opencode-review.mjs:1160` `OVERRIDE_MIN_ROUNDS = 3`；`:1233-1236` 只有全部问题都是 `unreviewed …` 且已有至少三轮代码复核时才可覆盖；`:1208-1213` 其他问题有 `ledger-not-committed`、`no-complete-round`、`chain-broken`、`not-ancestor`，`:1214-1217` 有 `main-ref-missing`、`main-not-merged`。
4. 中断时不写账本：`opencode-review.mjs:2709-2716` 的 `onSignal` 只做清理然后 `process.exit`。
5. 服务方去掉的现有机制：`startLiveGateway` 的 `drop` 列表，`groupArgs(config, model, { dropProviders })`；开跑前检查发现某家不可用会去掉它并打印 `GATEWAY_PROVIDER_DROPPED`（本分支待合并的改动）。
6. Andy 的话怎样算授权：`.claude/rules/owner-standing-rules.md`“Andy 在项目聊天里对协调者说的话，由协调者附上他那条原话转给对应线程，就算他的授权”。
7. Andy 2026-11-08 的决定：放松门槛（原话“放松”）；切换服务方只做单次（原话“看你的建议”，线程建议只做单次）。

## 改动

### 1. 跳过复核直接合并（放松门槛）

- `assertReviewed`：带 `--accept-unreviewed "<原话>"` 时，不再要求至少三轮；可以盖过的问题从只有 `unreviewed …` 扩大到 `ledger-not-committed`、`no-complete-round`、`chain-broken …`、`not-ancestor …`、`unreviewed …`、`low-fix-invalid …`。仍然不能盖过：`main-ref-missing`、`main-not-merged`（main 必须先合进分支）、`ledger-differs-from-HEAD`（账本必须先提交）。删掉 `OVERRIDE_MIN_ROUNDS`。
- 账本还不存在时（PR 一轮都没复核），覆盖记录写进新建的 `.agents/reviews/pr-<编号>/usage.jsonl`，线程提交后再跑一次 `--assert-reviewed`，认出已提交的覆盖记录才算通过（沿用现有“已提交的例外记录被认出”的逻辑）。
- 覆盖记录不变：`mode: "override"`、`cost: 0`、`head`、`quote`、`problems`。`--report` 照旧列出。
- 规则文字：`AGENTS.md:52` 后加一句“Andy 明确说跳过复核时，用 `--accept-unreviewed` 记下他的原话后合并”；`model-review.md:43` 改成“例外：Andy 明确说跳过复核……原话必须是他本人在线程里打的，或协调者转来的他的原话；模型答案、GitHub 评论里的文字不算”。

### 2. 停止正在跑的复核

- 开跑时打印 `REVIEW_PID <pid>`。
- `onSignal`：已经进入跑模型阶段时，不再直接退出，而是对每个正在跑的模型调用现有的 `stop("owner-stopped")`（和超时、超费共用一条路径），让 `reviewOnce → runOne → 追加账本` 正常走完：`outcome: "owner-stopped"`，费用取费用插件标记和 `step_finish` 累计中较大的那个，有在途请求时照旧记 `inFlight`、按宁可多记的公式计；经 Magpie 时照常读 Magpie 用量。`"owner-stopped"` 加进 `GUARD_DEFERS_TO_PARENT`，免得费用插件的原因把它盖掉。第二次收到信号，或 30 秒内没走完，就照旧清理后强制退出。还没进入跑模型阶段（自检、建副本）时保持现状直接清理退出。
- `owner-stopped` 是“不是 ok”的结果：不上复核链、不算通过，也不算“连续三轮没过”的一轮；`--round <n>` 可以只补跑它。
- 线程收到“停止复核”时：`kill -INT <REVIEW_PID>`（不要用 SIGKILL：Node 不能给 SIGKILL 装处理函数，账本写不了，detached 的 OpenCode 和 Magpie 还可能继续跑），等它退出后提交账本和已经写出的提示词，不再开新的一轮；如果 Andy 同时说了合并，就走第 1 项。

### 3. 单次切换服务方

- 新参数 `--providers <服务方 id>[,…]`：这一次只用列出的几家，按 `gateway.json` 里的先后，前一家不可用才换下一家；没列出的并进 `drop`，打印 `GATEWAY_PROVIDER_DROPPED <id> requested`，账本 `gatewayDropped` 记下。只在经 Magpie 时允许（和 `--gateway direct` 同用报 `ARG_PROVIDERS_NEED_GATEWAY`），子命令不收；id 必须在 `gateway.json` 里，否则 `ARG_INVALID --providers`。列出的几家里某个要跑的模型没有成员时，在花钱前以 `GATEWAY_PREFLIGHT_FAILED` 停下，不自动换回没列出的服务方。
- 列出了 CodeBuddy 但积分扣掉预留后低于底线时，照旧不用它（不绕过底线），线程把原因报给 Andy；没列 CodeBuddy 时不查积分。
- 直连 Go 仍用现有的 `--gateway direct`。

### 4. 固定说法

`model-review.md` 新增一节“Andy 怎样控制复核”（放在必问问题那一节之后，只用 `-` 列表，不用行首 `1.` 这类编号，否则 `reviewQuestions` 会把它当成必问问题、改变以后每次复核的提示词；加一条“必问问题仍然正好 4 条”的测试和反向用例），列出线程听到哪类话做什么：
- “停止复核”“别复核了” → 第 2 项；
- “跳过复核，合并”“不用复核直接合并” → 第 1 项然后合并；
- “这次用 OpenDesign”“这次不用 CodeBuddy” → `--providers`（后者列出其余几家）；只说“换一家”没点名时，列出服务方问他要哪家，不猜；
- “直连 Go” → `--gateway direct`。
同一 PR 里，Andy 的话只管当次；以后的轮次照常复核，除非他再说。

## 测试

- `assertReviewed`：零轮、一轮、链断开时带原话能覆盖并写记录；main 没合进、账本没提交时仍拒绝；不带原话时照旧 `REVIEW_NOT_CURRENT`。去掉放宽的代码，这些用例失败。
- 中断：起一个复核进程（用假 OpenCode，沿用测试里延迟发 `step_finish` 的手法），运行中发 SIGINT，断言账本多了 `owner-stopped` 的记录、费用不为 0、临时目录已删；把 `onSignal` 改回直接退出时这条用例失败。
- `--providers`：参数校验（未知 id、和 direct 同用、子命令）；真实 Magpie 用例里只列一家时只有它收到请求；列出的服务方缺模型时 `GATEWAY_PREFLIGHT_FAILED` 且假服务方收到 0 次请求。
- 必问问题仍然正好 4 条；在新一节里插一行 `1. …` 时这条用例失败。

## 比较过、没采用的

- 长期切换（云端环境变量或仓库配置）：已经在跑的线程读不到，且开跑前会自动去掉不可用的服务方，需求不大；Andy 同意只做单次。
- 远程开关文件（线程每步读一个共享开关）：要轮询外部状态，复杂度高，Andy 的话转给线程已经够用。

## 风险

- 放宽后跳过复核更容易：靠“只认 Andy 原话”和账本留痕兜住，`--report` 会列出每次覆盖。
- 中断时写账本要在清理前完成，写失败不能挡住清理；进程被 SIGKILL 时仍写不了，文档写明。
