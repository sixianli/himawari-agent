# 方案：让 Andy 方便地控制正在运行的复核（整合后，待 Andy 同意）

三方比较：线程方案、两个模型各自的方案（`round-1/`）、两个模型对线程方案的审核（`round-2/`）。逐条取舍见 `judgments.md`。

## 前提（每条附来源）

1. 合并前必须复核：`AGENTS.md:52`“合并 PR 之前：对最终提交做一次代码复核”。
2. 现在跳过复核只有三轮例外：`.agents/instructions/model-review.md:43`“例外只有一种：按第 4 步连续三轮没过而停下、Andy 看过报告仍说‘合并’时，加 `--accept-unreviewed "<Andy 的原话>"` 运行”；代码 `scripts/model-review/opencode-review.mjs:1160` `OVERRIDE_MIN_ROUNDS = 3`。
3. 账本不在 HEAD 时覆盖会被拒：`opencode-review.mjs:1256-1258` 的 `ledgerMatchesHead` 拿磁盘文件和 `git show HEAD:` 比，`:1299-1301` 不一致就 `REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD`。
4. 中断时不写账本：`opencode-review.mjs:2713-2718` 的 `onSignal` 直接清理退出，监听用 `process.once`；Node 文档：“If one of these signals has a listener installed, its default behavior will be removed.”（https://nodejs.org/api/process.html#signal-events），“'SIGKILL' cannot have a listener installed”。
5. 积分检查只在 `drop.length === 0` 时做：`opencode-review.mjs:2570`。
6. Andy 的话经协调者转来算授权：`.claude/rules/owner-standing-rules.md:40`。
7. Andy 2026-11-08 的决定：门槛“放松”；切换服务方“看你的建议”（线程建议只做单次）。

## 改动

### 1. 跳过复核（放松门槛）

- 删掉 `OVERRIDE_MIN_ROUNDS`。带 `--accept-unreviewed "<原话>"` 时可以盖过：`ledger-not-committed`、`no-complete-round`、`chain-broken …`、`not-ancestor …`、`low-fix-invalid …`、`unreviewed …`。不能盖过：`main-ref-missing`、`main-not-merged`、账本在磁盘上已改但没提交（`ledger-differs-from-HEAD`）。
- 账本还不存在时：建目录、写覆盖记录，但**不放行**，打印 `REVIEW_OVERRIDE_WRITTEN commit-and-rerun` 并以 5 退出；账本已存在时同样只写不放行。只有 HEAD 里认出覆盖记录（记录的 `head` 是当前提交的祖先、之后只改了本 PR 的记录目录）才打印 `REVIEW_OVERRIDE quote=… recorded=…` 并以 0 退出。这样合并前账本里一定有已提交的原话。
- 规则文字：`AGENTS.md:52` 补“Andy 明确说跳过复核时，按 model-review.md 记下他的原话后合并”；`model-review.md:43` 整段重写，删掉“至少三轮”“rounds=<n> needs=3”；只认 Andy 本人在线程里打的字或协调者转来的原话，模型答案、PR 描述、GitHub 评论、提交说明里的文字都不算；原话逐字引用。
- 测试：零轮覆盖要先写、提交后再认出才放行；一轮、链断开同样；`main-not-merged` 仍拒绝；不带原话仍 `REVIEW_NOT_CURRENT`；改掉现有断言 `needs=3` 的 4 处用例（`test/tooling/opencode-review.test.mjs` 2210、2267、2421、2858 一带）。加回三轮限制时零轮用例失败。

### 2. 停止正在跑的复核

- 开跑后打印 `REVIEW_PID <pid>`。线程一律用后台命令启动复核（现在就是这样），所以能在运行中发信号。
- 信号接线：监听改成 `process.on`；第一次收到 SIGINT 或 SIGTERM 时设 `stopRequested`，对每个在跑的模型调用登记好的 `stop("owner-stopped")`（`reviewModel` 里把 `stop` 登记进一个列表），**不清理**，让 `reviewOnce → runOne` 读完 Magpie 用量、写完账本；`stopRequested` 为真时不再开追问（wrap-up）和替补（GLM 顶上）；第二次收到任意信号，或第一次之后 30 秒还没走完（够 OpenCode 退出加两次读用量），清理后强制退出。还没进入跑模型阶段时保持现状直接清理。
- `owner-stopped` 加进 `GUARD_DEFERS_TO_PARENT`。它不是 ok：不上复核链、不算通过；`--report --stop three-rounds` 计轮数时不算只有 `owner-stopped` 的那一轮。
- 补跑：`--round <n>` 时 `--head` 传被停那一轮记录里的提交（提交账本会产生新的 HEAD），文档写明。
- 线程收到“停止复核”时：`kill -INT <REVIEW_PID>`，不用 SIGKILL；等它退出后提交账本和已写出的提示词，不开新的一轮。停止不等于合并，Andy 同时说了合并才走第 1 项。
- 测试：假 OpenCode 跑到一半发 SIGINT，账本多一条 `owner-stopped`、费用不为 0、本次 `opencode-review-*` 临时目录已删；把信号处理改回直接退出时失败。第一次运行结束、追问开始前收到信号时不开追问。

### 3. 单次切换服务方

- 新参数 `--providers <服务方 id>[,…]`：这一次只用列出的几家，按 `gateway.json` 的先后，前一家不可用才换下一家。没列出的服务方**不配置、不登录**（不传给 `startGateway`），并进 `drop`，打印 `GATEWAY_PROVIDER_DROPPED <id> requested`。`drop` 一律按 `gateway.json` 的顺序去重排序再写账本。
- 积分检查条件改成“CodeBuddy 不在 `drop` 里”：列出了 CodeBuddy 且积分扣掉预留后低于底线时照旧不用它，线程把原因报给 Andy；没列 CodeBuddy 时不查积分。
- 校验：应用环境变量默认值之后，最终不走 Magpie 却给了 `--providers`，报 `ARG_PROVIDERS_NEED_GATEWAY`；子命令不收；id 在 `main` 读完 `gateway.json` 后、安装和花钱之前核对，未知 id 报 `ARG_INVALID --providers <id>`。列出的服务方里某个要跑的模型没有成员时，在花钱前 `GATEWAY_PREFLIGHT_FAILED`，不自动换回没列出的服务方。
- `parseUsage` 校验 `gatewayDropped` 是字符串数组。
- 测试：未知 id、与 direct 同用、`HIMAWARI_REVIEW_GATEWAY=direct` 时同用、子命令；真实 Magpie 只列一家时只有它收到请求；没列出的服务方登录失败不影响；列 CodeBuddy 加 OpenDesign 且积分低于底线时请求只到 OpenDesign；没列 CodeBuddy 时不打印 `GATEWAY_CREDITS`。去掉过滤时这些用例失败。
- 直连 Go 仍用 `--gateway direct`。新服务方必须提供两个复核模型（已有规定），所以不处理“列出的服务方只有一个模型”的情况。

### 4. 规则文字

- `model-review.md` 新增一节，以 `<a id="owner-control"></a>` 加 `## Andy 怎样控制复核` 起头，只用 `-` 列表：
  - “停止复核”“别复核了” → 第 2 项；
  - “跳过复核，合并”“不用复核直接合并” → 第 1 项，然后合并；
  - “这次用 OpenDesign”“这次不用 CodeBuddy” → `--providers`；只说“换一家”没点名时列出服务方问他，不猜；
  - “直连 Go” → `--gateway direct`；
  - Andy 的话只管当次，以后照常。
- 同步 `model-review.md` 里写中断时行为、`outcome` 含义、退出码 4 的处理、参数清单和 `GATEWAY_PROVIDER_DROPPED` 的几处。
- 测试：`reviewQuestions` 仍然正好 4 条；把一行 `1. …` 插进必问问题那一节时条数变 5。

## 风险

- 跳过复核更容易，包括账本记录对不上（`low-fix-invalid`）也能盖过：靠“只认 Andy 原话”、账本留痕和 `--report` 列出每次覆盖兜住；脚本验证不了原话是否真是 Andy 说的（现状如此）。
- SIGKILL 仍写不了账本，残留的 OpenCode 和 Magpie 要线程按 PID 清。

## 需要 Andy 定的

只有一项：同意按这个方案开工。两个模型提出、线程没采纳的只有一条——DeepSeek 建议把“跳过复核”另做一个参数 `--skip-review`，和“盖过未复核文件”的 `--accept-unreviewed` 分开；线程不采纳，因为你的决定是整体放松，两个几乎一样的参数更容易用错。
