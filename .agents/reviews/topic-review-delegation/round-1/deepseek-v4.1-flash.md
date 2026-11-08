# 方案：Mac 线程只准备任务，himawari-cloud 线程只执行，结果经独立分支交回

## 一、方案依赖的前提

| # | 前提 | 来源和原话 |
|---|---|---|
| P1 | 复核记录必须留在仓库，账本格式和 `--assert-reviewed` 不能变 | `.agents/instructions/model-review.md:100`：“记录目录固定在仓库里……线程在合并前把记录目录随 PR 一起提交。”`:43`：“它从当前提交里读账本……输出 `REVIEW_CURRENT` 才能合并。” |
| P2 | 云端有 Magpie 凭证，Mac 没有出口代理、不配密钥 | `model-review.md:130`：“云端环境 himawari-cloud 把这个变量设成 `magpie`，所以云端线程不用加参数；Mac 上没有出口代理代填凭证，不设这个变量，照旧直连。”`:137`：“真凭证都在云端环境（himawari-cloud）的网络密钥里，由出口代理补上……所以这个开关现在只适用于云端会话；Mac 上要用还得另做登录。” |
| P3 | 复核脚本自己负责只读沙箱、费用封顶、账本、记录目录 | `model-review.md:71`：“模型自己读代码：只开读文件……改文件、别的命令、派子代理、仓库外的路径全部禁止。”`:83`：“在 PR 最新提交的一次性副本里运行。”`:105`：“开跑前脚本把 `usage.jsonl` 里已花的加上这一轮最多会花的……以 `BUDGET_NEEDS_APPROVAL` 拒绝开跑。” |
| P4 | 发给模型的内容只追加，每轮会变的值只在最后一条消息，字节必须确定 | `.claude/rules/prompt-prefix.md:6`：“匹配是逐字节的：开头任何一处变了，从那里往后全部按全价重算。”`:28`：“每轮都会变的内容只放在最后一条用户消息里。”`:35`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”`:51`：“同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定。” |
| P5 | 大改动先出方案；花钱先问 | `.claude/rules/owner-standing-rules.md:24`：“大改动先出方案、讨论后再动工。”`:16`：“预计要花 Andy 的钱超过 0.5 美元时……等 Andy 明确同意再开跑……合并前用 OpenCode 做代码复核……超过 1 美元。” |
| P6 | Andy 可以随时叫停、指定服务方、跳过复核 | `model-review.md:61`：“线程对复核进程发 `kill -INT <REVIEW_PID>`。”`:63`：“下一条复核命令加 `--providers`。”`AGENTS.md:52`：“Andy 明确说跳过复核时……用 `--accept-unreviewed` 记下他的原话后合并。” |
| P7 | 只读沙箱防误操作，不防故意 | `model-review.md:76`：“这套限制防的是复核模型误操作……不防有人故意在 PR 里埋恶意代码。” |
| P8 | 现有记录目录、轮次、账本字段不能改 | `model-review.md:100`、`:102`、`:91`；`opencode-review.mjs:1491-1560` 的 `parseUsage`、`:2373-2384` 的 `reviewKey`。 |
| P9 | `--assert-reviewed` 按轮次串链，并要求最后一点的提交是当前提交的祖先、两者之间只改记录目录 | `model-review.md:43`；`opencode-review.mjs:1231-1235` 的 `changedOutside`、`:1282-1283`。 |
| P10 | 每个新产生的值都要核对“产生它的地方”和“使用它的地方” | `docs/incidents-and-gates.md:112`（I-73）：“双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』。” |
| P11 | 云端线程克隆 `sixianli/himawari-agent`，`start_session` 可指定环境，prompt 是第一条消息；跑完可给 Mac 线程发消息 | 本次材料“背景（已核对的事实）”。这是用户提供的事实，仓库内无法核实。 |
| P12 | 云端会话是独立上下文，父线程只传 prompt；子会话可隔离工作区、可跨会话发消息 | Anthropic 官方文档：https://code.claude.com/docs/en/sub-agents （“Each subagent starts with a fresh, isolated context window. It doesn't see your conversation history…”；`isolation: worktree`）；https://code.claude.com/docs/en/agent-sdk/subagents （“The only content you pass from parent to subagent is the Agent tool's prompt string…”）；https://code.claude.com/docs/en/agents （“Claude can pass findings with cross-session messaging between sessions you run yourself…”）。 |
| P13 | 测试不能在 MacBook 上跑 | `.agents/instructions/test-and-production-hosts.md:8`：“绝不在用户的 MacBook 上运行 Himawari 测试：不做构建，不跑 `npm run check`、`npm test`、任何 Vitest 项目……” |
| P14 | 必答问题由脚本从 `model-review.md` 的 `<a id="checklist"></a>` 段解析；不能把新章节插进这一段 | `opencode-review.mjs:220-231`：`reviewQuestions` 从 `<a id="checklist"></a>` 开始，按 `<a id=` 或 `## ` 切段取前两段。 |
| P15 | 复核模型提示词的固定部分 + 本次材料由 `buildPrompt` 拼成，材料在最后 | `opencode-review.mjs:277-306`：`fixed` 后拼 `---- 本次材料 ----`、`head`、`base`、`previous`、`brief`。 |

---

## 二、方案本身

### 1. 总览：用 git 引用做交接，Mac 和云端各写各的引用

新增四条 `refs/heads` 下的引用，互不重叠：

- `review/task/<记录键>/<taskId>`：Mac 写，任务清单和简报。
- `review/result/<记录键>/<taskId>`：云端写，复核记录和结果清单。
- `review/lock/<记录键>/<taskId>`：云端用 CAS 抢占，防同一任务被跑两次。
- `review/stop/<记录键>/<taskId>`：Mac 写，云端轮询到就发 `SIGINT`，实现 Andy 随时叫停。

`<记录键>` 就是现有 `reviewKey` 的结果：`pr-291` 或 `topic-<短名>`。PR 分支只有 Mac 线程写；云端只写 task/result/lock/stop，绝不推 PR 分支。

### 2. 任务说明写什么

Mac 用新脚本 `scripts/model-review/handoff.mjs prepare` 生成一个提交，提交内容是：

```
.agents/reviews/<记录键>/tasks/<taskId>/task.json
.agents/reviews/<记录键>/tasks/<taskId>/brief.md
.agents/reviews/<记录键>/tasks/<taskId>/README.md
```

`task.json` 是机器可读的唯一来源，建议字段：

```json
{
  "schema": "himawari-review-task.v1",
  "taskId": "<32位小写hex>",
  "inputHash": "<64位小写hex>",
  "nonce": "<16位小写hex>",
  "createdAt": "<ISO时间，仅供审计>",
  "environment": "himawari-cloud",
  "repo": "sixianli/himawari-agent",
  "sourceBranch": "claude/foo",
  "review": {
    "mode": "code-review",
    "pr": 291,
    "topic": null,
    "head": "<40/64位提交>",
    "base": "<40/64位提交>",
    "previous": null,
    "round": null,
    "models": ["opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3-flash"],
    "providers": ["workbuddy-ai", "opendesign", "opencode-go"],
    "approvedUsd": 1.5,
    "questionsRef": null,
    "briefPath": ".agents/reviews/pr-291/tasks/<taskId>/brief.md",
    "briefSha256": "<64位小写hex>",
    "ledgerPath": ".agents/reviews/pr-291"
  },
  "result": {
    "taskBranch": "review/task/pr-291/<taskId>",
    "resultBranch": "review/result/pr-291/<taskId>",
    "stopBranch": "review/stop/pr-291/<taskId>",
    "lockBranch": "review/lock/pr-291/<taskId>",
    "recordPath": ".agents/reviews/pr-291"
  }
}
```

关键点：

- `taskId = sha256(inputHash + "\n" + nonce)` 前 32 位；`inputHash` 只由复核输入和简报摘要算，不含 `createdAt`。同一任务重试同一 id，提示词字节不变；新任务换 `nonce`。
- `models` 按 `REVIEW_MODELS` 的顺序归一化；`providers` 去重后排序。这样清单和提示词不依赖对象遍历顺序。
- `ledgerPath` 必须等于 `reviewKey({pr,topic})`；`briefPath` 必须是 `ledgerPath/tasks/<taskId>/brief.md`，防止路径穿越。
- `README.md` 是给人/云端代理看的固定模板，包含：环境检查、`claim` 命令、结果格式、禁止推 PR 分支、禁止改代码、禁止自己加预算、失败时的通知格式。`claim` 不读 README，只读 `task.json`，所以 README 里即使有诱导文字也改不了实际命令。

Mac 用 `prepare` 打印的 JSON 调 `start_session`：

```json
{
  "target": "cloud",
  "environment": "himawari-cloud",
  "title": "复核 pr-291 task <taskId>",
  "background": true,
  "prompt": "你是 himawari-agent 的复核执行线程（不是作者线程）。任务 id：<taskId>。\n\n先运行：\ngit fetch origin refs/heads/review/task/pr-291/<taskId>:refs/remotes/origin/review/task/pr-291/<taskId>\ngit checkout --detach refs/remotes/origin/review/task/pr-291/<taskId>\n\n再读 .agents/reviews/pr-291/tasks/<taskId>/README.md，并运行：\nnode scripts/model-review/handoff.mjs claim --task <taskId>\n\n不要改代码，不要推 PR 分支，不要合并，不要自己加 --approved-usd 或 --gateway direct。\n完成后给发起线程发消息，第一行必须是：\nREVIEW_HANDOFF_DONE task=<taskId> status=ok|failed result=<提交或none> branch=review/result/pr-291/<taskId> spent=<美元或unknown> [reason=<错误码>]\n"
}
```

这个 prompt 不含时间、随机数、环境路径；重试同一任务时字节相同。它只让云端线程做一件事：运行 `claim`。

### 3. 交接怎么做

**Mac 侧 `prepare`：**

1. 用现有 `parseArgs` 校验参数，确保清单和脚本对 CLI 的理解一致。
2. `git fetch origin`；把 `head`、`base`、`previous` 解析成完整提交哈希。
3. 代码复核要求 `origin/<sourceBranch> == head`；建议同时要求 `origin/main` 已在 `head` 里（这样复核的就是最终可合并提交，也保证 `handoff.mjs` 在任务分支上存在）。
4. 检查 `head:scripts/model-review/handoff.mjs` 存在；不存在就要求先合 main，避免云端没有执行器。
5. 用临时 worktree 在 `head` 上写任务文件并提交，推到 `review/task/...`；不动 Mac 的工作区。
6. 检查同一记录键下没有在途任务；有就要求先 `status`/`collect`/`cleanup`，或 `--supersede <旧taskId>`（旧任务必须已失败或锁已过期）。
7. 打印 `start_session` 参数和 `REVIEW_HANDOFF_TASK` 行。

**云端侧 `claim`：**

1. **先查环境，不查就停**：要求 `HIMAWARI_REVIEW_GATEWAY === "magpie"`；建议同时要求新增的 `HIMAWARI_REVIEW_ENV === "himawari-cloud"`。不满足就打印 `REVIEW_HANDOFF_FAILED reason=ENV_MISMATCH` 并退出，不安装、不登录、不调模型。
2. 取 `review/task/...`，读 `task.json`；核对 schema、`taskId`、`inputHash`、`repo`、`environment`、`sourceBranch`、`head`、`briefSha256`、`ledgerPath`。
3. 若 `review/result/...` 已存在且 `result.json` 是 `ok`，直接打印已有结果并退出，不重复跑、不重复花钱。
4. 用 `review/lock/...` 的 `--force-with-lease`（期望不存在）抢占；抢不到就检查结果，没有结果就报 `REVIEW_HANDOFF_LOCKED`。
5. 安装 pre-push hook：只允许推 `review/result/...` 和 `review/lock/...`，其他 ref 一律 `REVIEW_HANDOFF_PUSH_REFUSED`。这是防误操作，不防故意（与 P7 同一取舍）。
6. 启动 stop 轮询：每 10 秒 `git ls-remote origin refs/heads/review/stop/...`；出现就向复核子进程组发 `SIGINT`。
7. 用 `task.json` 的字段构造 argv，先交给现有 `parseArgs` 再核一遍，然后运行 `node scripts/model-review/opencode-review.mjs ...`。只传清单里的参数；`--gateway magpie` 显式传；`--brief` 用校验过摘要的临时文件，不用清单里的路径。
8. 复核结束后检查 `git status --porcelain`：只允许 `ledgerPath/` 下的改动；其他改动报 `REVIEW_HANDOFF_DIRTY_WORKTREE`，不提交、不推送。
9. 写 `tasks/<taskId>/result.json` 和 `claim.log`，提交到 `review/result/...`，推送，删 lock，打印固定结果行。

**Mac 侧 `collect`：**

1. 取 `review/result/...`，读 `task.json` 和 `result.json`。
2. 校验结果分支从 `head` 到 result tip 的改动全部在 `ledgerPath/` 下；否则拒绝。
3. 校验新增的 `usage.jsonl` 记录：`mode`、`head`、`model`、`round`、`previous` 和清单一致；模型答案文件存在。这是 I-73 要求的“两端核对”，不只看 diff。
4. 校验当前 PR 分支 `HEAD == head` 且 `origin/<sourceBranch> == head`；不相等就报 `REVIEW_HANDOFF_STALE`，不合并、不丢提交。
5. `git merge --ff-only <result tip>`，把任务文件、`result.json`、模型答案、账本一起带进 PR 分支。
6. 运行 `node scripts/model-review/opencode-review.mjs --assert-reviewed --pr <n>`；`REVIEW_CURRENT` 才继续。若只是 `main-not-merged`，按现有规则合 main 后再复核一轮。
7. 打印 `REVIEW_HANDOFF_COLLECTED`；Mac 线程再按正常规则推送、判断意见、写 `verdicts.jsonl`、跑 `--accept-low` 或 `--accept-unreviewed`。

**`status` / `stop` / `cleanup`：**

- `status --pr <n>`：列出每个 task 的 head、task/result/lock/stop 引用、结果状态、是否已 collect。消息没到时用它，不靠猜。
- `stop --task <id>`：推 `review/stop/...`；云端轮询到就 `SIGINT`，复核脚本记 `owner-stopped`。不依赖 Mac→云端消息能否中途送达。
- `cleanup --pr <n>`：只删除已经 collect（result tip 是 PR 分支祖先）或明确放弃且锁已过期的任务引用；不删在途任务。

### 4. 结果怎么交回、跑完怎么通知

- **权威结果**是 `review/result/...` 分支上的 `result.json` 和 `usage.jsonl`、`round-<n>/`。消息只是提醒。
- 云端跑完给 Mac 发一条消息，第一行固定：

```
REVIEW_HANDOFF_DONE task=<taskId> status=ok|failed result=<40/64位提交或none> branch=review/result/pr-291/<taskId> spent=<美元或unknown> [reason=<错误码>]
```

- 后面附 `REVIEW_SPENT_TOTAL`、`REVIEW_RESULT` 和失败原因。
- Mac 收到消息后 `collect`；消息没到就 `status` 轮询。超过脚本超时（默认 25 分钟）加 10 分钟仍无结果，报告 Andy，不自动重跑。

### 5. 两个线程的分工

| 事项 | Mac 本地线程 | himawari-cloud 云端线程 |
|---|---|---|
| 决定复核什么、写问题/目标/约束/作者说明 | 是 | 否 |
| 向 Andy 报预计费用、拿 `--approved-usd` | 是 | 否，且不得自行加预算 |
| 生成任务清单、推 task 引用、调 `start_session` | 是 | 否 |
| 检查环境、运行 `opencode-review.mjs` | 否 | 是，且只通过 `claim` |
| 读模型答案、逐条判断、写 `verdicts.jsonl` | 是（作者线程） | 否 |
| 提交复核记录到 PR 分支 | 是（`collect`） | 否，只写 result 引用 |
| `--assert-reviewed`、`--accept-low`、`--accept-unreviewed` | 是 | 否 |
| 合并 PR | 是，Andy 说“合并”后 | 否 |
| 推送 PR 分支 | 是，唯一写者 | 否 |

这保持了现有规则“分类由线程做”（`model-review.md:25`），云端只负责跑模型，不替作者线程判断。

### 6. 规则文字和脚本要改什么

**规则文字：**

- `AGENTS.md`“和 OpenCode 协作”一节：加一句“Mac 本地线程不得在本机直接跑 `opencode-review.mjs`；复核经 `handoff.mjs prepare` 交给 himawari-cloud 的云端线程，Mac 只做 `collect`、判断和合并。”
- `.agents/instructions/model-review.md`：新增一节“从 Mac 本地线程交给云端线程跑”，放在“怎么跑”之后、“经 Magpie 调用模型”之前；**绝不能放进 `<a id="checklist"></a>` 段**（P14）。内容写：task/result/lock/stop 引用、`prepare`/`claim`/`collect`/`status`/`stop`/`cleanup`、环境检查、通知格式、失败处理、费用先问、Andy 叫停。
- `model-review.md`“怎么跑”补一句：实际执行命令由云端 `claim` 构造；Mac 不运行模型。
- `model-review.md`“Andy 怎样控制复核”补一句：叫停优先用 `stop` 引用（不依赖消息），`SIGINT` 后账本记 `owner-stopped`；服务方仍用 `--providers`，由 Mac 写进任务清单。
- 新增 ADR（编号按 `npm run check:adr-numbers` 取下一个）：记录“复核执行交给云端线程、任务/结果用独立引用、PR 分支单写者”的决定、替代方案和风险。
- 不需要改 `owner-standing-rules.md` 的授权规则；Mac 线程仍是发起线程，云端不获得额外授权。

**脚本：**

- 新增 `scripts/model-review/handoff.mjs`，导出 `prepareTask`、`claimTask`、`collectTask`、`statusTasks`、`stopTask`、`cleanupTasks`，并带 CLI。内部复用 `opencode-review.mjs` 的 `parseArgs`、`budgetCheck`、`reviewQuestions`、`reviewKey`、`COMMIT_PATTERN`、`parseUsage`、`TOPIC_PATTERN`，避免两套校验。
- `opencode-review.mjs` **不改账本、不改记录格式、不改模型提示词**。只允许增加导出或很小的辅助函数；`buildPrompt`、`parseUsage`、`assertReviewed`、`reviewReport` 的行为不变。
- `package.json`：可加 `check:review-handoff`（如果测试足够快，放进 `check:steps`；否则留在 `test:tooling`）。
- `vitest.workspace.ts` 不用改，`test/tooling/` 会自动收新测试。

### 7. 出错怎么办

| 情况 | 处理 |
|---|---|
| 环境不对（Default、无 `magpie`、`direct`） | `claim` 在花钱前拒绝；云端回 `status=failed reason=ENV_MISMATCH`；Mac 报告 Andy，修好环境再重试；绝不改直连、绝不配置密钥。 |
| 云端线程失败（脚本报错、超时、API 错误） | `claim` 写 `result.json status=failed`，有账本记录就推 result 分支；Mac `collect` 把失败记录带进 PR，按现有 `--report --stop run-failed` 报告；不自动重跑，花钱后重跑先问 Andy。 |
| 消息没到 | `status`/`git fetch` 查 result 分支；有结果就 `collect`；超时仍无结果就报告，不重跑。 |
| 分支冲突/过期 | `collect` 要求 PR 分支 `HEAD == head`；不相等报 `REVIEW_HANDOFF_STALE`，不合并。云端只推 result 分支，PR 分支只有 Mac 写，不会丢提交。 |
| 同一 PR 并发复核 | `prepare` 检查同记录键的在途任务；`claim` 用 lock CAS；第二个任务报 `REVIEW_HANDOFF_LOCKED`。 |
| Andy 叫停 | Mac 推 `review/stop/...`；云端轮询到发 `SIGINT`；脚本记 `owner-stopped`。即使轮询失效，每模型 0.2 美元和 25 分钟超时仍兜底。 |
| 云端崩溃/锁残留 | `status` 显示锁和结果；锁超过 2 倍超时视为过期，`cleanup --force` 清理；不把无结果的任务当成已复核。 |
| main 没合进分支 | `collect` 照常应用记录；`--assert-reviewed` 报 `main-not-merged`；Mac 合 main 后按现有规则再复核一轮。 |
| 结果提交改了记录目录以外的文件 | `claim` 在提交前拒绝；`collect` 再核对一次 diff，拒绝应用。 |

### 8. 怎么测试

新增 `test/tooling/review-handoff.test.mjs`，并在 `test/tooling/opencode-review.test.mjs` 补回归用例。

| 测试 | 正向 | 反向（去掉守卫必须失败） |
|---|---|---|
| `prepare` 清单 | 同一输入两次生成同 `inputHash`/同 prompt 字节；models/providers 顺序固定 | 改 brief 一个字节，`briefSha256` 变；不排序时两次清单字节不同 |
| `prepare` 校验 | 合法 code-review/plan/plan-review | 短哈希、非祖先 base/previous、topic 含斜杠、首轮只给一个模型、未知 provider、`--gateway direct`、brief 为空、brief 路径穿越、head 不在 sourceBranch、缺 `handoff.mjs` |
| `prepare` 预算 | 未超先问线生成任务 | 超线且无 `--approved-usd` 时拒绝，不推 task 分支 |
| `claim` 环境 | `HIMAWARI_REVIEW_GATEWAY=magpie` + `HIMAWARI_REVIEW_ENV=himawari-cloud` 运行假复核 | 缺变量、`direct`、`himawari-cloud` 拼错：拒绝且假复核调用次数为 0 |
| `claim` 清单 | 构造 argv 后 `parseArgs` 结果与清单一致 | 改 `ledgerPath`、`head`、`models`、`round`、`briefSha256`：拒绝，不运行 |
| `claim` 幂等 | result 已存在 `ok`：不跑、不花钱 | 去掉幂等检查时假复核被调用两次 |
| `claim` 锁 | 第一个 claim 成功 | 第二个 claim 抢锁失败，假复核只调用一次 |
| `claim` 脏工作区 | 只改 `ledgerPath` 时提交成功 | 改 `src/a.ts` 时拒绝，不推 result |
| `claim` 结果分支 | result tip 的父链包含 head，改动全在 `ledgerPath` | 结果分支改 `src/a.ts`：`collect` 拒绝 |
| `collect` 记录核对 | 新账本记录 `head/mode/model/round/previous` 与清单一致 | 假复核写错 `head`：`collect` 拒绝；写错 model：拒绝 |
| `collect` 过期 | PR 分支仍等于 head 时 ff 成功 | PR 分支前进后：`REVIEW_HANDOFF_STALE`，不合并 |
| `collect` 任务文件 | `tasks/<id>/result.json` 在 `ledgerPath` 下，`--assert-reviewed` 仍 `REVIEW_CURRENT` | 把 `result.json` 放到 `ledgerPath` 外时，`changedOutside` 报 `unreviewed`，测试失败 |
| 通知解析 | 合法 ok/failed 行 | 缺 taskId、状态未知、result 非哈希、spent 非数字：`REVIEW_HANDOFF_MESSAGE_INVALID` |
| 停止引用 | 假复核运行时推 stop，收到 SIGINT，账本 `owner-stopped` | 去掉轮询时假复核跑完，账本没有 `owner-stopped` |
| pre-push hook | 允许 result/lock | 推 `refs/heads/main` 被拒；去掉 hook 时测试失败 |
| 必答问题回归 | `reviewQuestions` 仍返回同样 4 条 | 把交接章节插进 checklist 段时，问题数量/内容变化，测试失败 |

另外跑：

- `npm run check:instruction-links`（新增链接和路径）。
- `npm run check:adr-numbers`（新 ADR）。
- `npm run check:prompt-prefix`（确认没碰产品提示词）。
- `test/tooling/opencode-review.test.mjs` 全量（确认账本、链、报告、低意见流程没回归）。
- 新测试在 Hermes/云端跑，不在 Mac 跑（P13）。

---

## 三、考虑过但不选的做法及原因

| 做法 | 不选原因 |
|---|---|
| 把完整 brief 写进 `start_session` prompt，云端直接拼 `opencode-review.mjs` 命令 | prompt 不可审计、易抄错；没有环境硬门；没有幂等；云端代理可能自己加参数导致花钱。 |
| 云端直接提交到 PR 分支 | 两个线程写同一分支，会冲突/丢提交，直接违反约束。 |
| 云端线程同时做逐条判断和合并 | 违反“分类由线程做”；云端会拿到 PR 分支写权限，冲突风险更大。 |
| 用 GitHub Actions/CI 跑复核 | 当前 CI 只供参考，runner 暂停；还要把模型凭证放进 CI，和“花钱先问、只读沙箱”不一致。 |
| 在 Mac 上起本机 Magpie 并配密钥 | 直接违反“Mac 不配任何模型密钥”。 |
| 结果只靠消息带回（贴模型答案/patch） | 消息会丢、会截断；账本和答案应留在 git 里，`--assert-reviewed` 才能读。 |
| 把 `handoff.mjs` 和 `opencode-review.mjs` 复制进任务提交来兼容旧 PR | 会跑“复制来的”脚本而不是被复核提交里的脚本；启动复杂。改为要求先合 main，让执行器出现在 head 里。 |
| 失败后自动重跑 | 会重复花钱；规则要求先报告 Andy。 |
| 在 `usage.jsonl` 里加 `taskId` | 会改账本格式；`parseUsage` 虽容忍未知字段，但没必要。任务和结果的关联放在 `tasks/<id>/` 和 `result.json`。 |
| 用自定义 ref 命名空间（`refs/himawari/...`） | 普通分支更容易查看、清理和受现有工具支持；用 `review/...` 前缀即可。 |

---

## 四、风险和反例

1. **云端代理绕过 `claim`**：它有写权限，理论上可手推 PR 分支或改 hook。`pre-push` hook 和 prompt 只防误操作，不防故意（P7）。反例：云端代理执行 `git push origin HEAD:main`，如果它用 `--no-verify` 就绕过 hook。取舍：复核模型仍是硬沙箱；云端代理是受信线程，和现在让云端线程直接跑脚本是同一信任级别。
2. **同一任务被跑两次**：`claim` 先查 result、再抢 lock；如果两个 claim 在 result 不存在时同时抢 lock，CAS 只让一个成功。反例：lock 引用被手动删除且 result 未生成，第二个 claim 可能重跑；`status` 会发现并报告。
3. **消息丢失/延迟**：result 分支是权威，`status` 可补；反例：云端在推 result 前崩溃，既无结果也无消息，Mac 只能超时报告，不能自动重跑。
4. **PR 分支在复核期间前进**：`collect` 要求 `HEAD == head`，会报 stale；反例：Mac 线程在等复核时改了代码并推送，这轮复核作废，要重新 prepare。
5. **环境变量被误设**：只靠 `HIMAWARI_REVIEW_GATEWAY=magpie` 时，某个非 himawari-cloud 环境也可能设它。建议加 `HIMAWARI_REVIEW_ENV=himawari-cloud`；反例：Default 环境没有该变量，`claim` 拒绝，不花钱。
6. **云端线程自身的 token 费用不在复核账本里**：账本只记复核模型费用；05:11 的 1.12 美元和 07:42 的 0.43 美元包含 Claude 标价。`claim` 很薄，能减少但不消除这部分；1 美元先问线无法从脚本里强制覆盖它。反例：复核模型只花 0.3 美元，云端代理读文件花 0.8 美元，账本仍显示 0.3。需要 Andy 决定是否把桌面应用显示的云端用量也纳入汇报。
7. **任务/结果引用里的旧结论泄露给复核模型**：任务和结果提交都在 `.agents/reviews` 下，`prepareCopy` 的 sparse checkout 和 `-diff` 会排除；`git` 替身拒绝带 `agents/reviews` 的参数。反例：模型若知道对象哈希并 `git show <hash>`，理论上能读到；现有文档已承认“知道哈希仍能读到”。新引用不新增可达路径，因为 `prepareCopy` 会删除所有非 `refs/review/*` 引用。
8. **任务分支被篡改**：有 push 权限的人可以改 `task.json` 和 brief 并保持一致。`claim` 只能核对摘要，不能证明作者。和“能往分支写账本的人都能写覆盖记录”是同一信任模型。
9. **结果提交的签名/身份**：云端提交的作者是云端身份；如果仓库以后要求签名提交，`collect` 需要改成 cherry-pick 后由 Mac 重新提交。当前没有这个要求，未核实。
10. **`--assert-reviewed` 的 `changedOutside` 把任务文件算成未复核**：这是最像 I-73 的反例。方案把任务文件放在 `ledgerPath/tasks/<id>/` 下，`changedOutside`（`opencode-review.mjs:1231-1235`）和 `lowFixProblems`（`:1121`）都按 `ledgerPath/` 前缀排除；`roundsOnDisk`（`:1562-1567`）只认 `round-<n>`；`reviewReport` 只读 `usage.jsonl`。测试必须证明这一点，否则会把 `result.json` 当成 `unreviewed`。

---

## 五、需要人拍板的取舍

1. **是否新增 `HIMAWARI_REVIEW_ENV=himawari-cloud`**：推荐加，作为 `claim` 的第二道环境门；不加就只靠 `HIMAWARI_REVIEW_GATEWAY=magpie`，残余风险见风险 5。
2. **是否要求代码复核前先把 `origin/main` 合进分支**：推荐要求，避免复核后再合 main 触发一轮；代价是 prepare 前多一个合并提交。
3. **云端线程是否只跑模型、不做判断**：推荐只跑。若让云端也判断，会违反“分类由线程做”，并需要给云端 PR 分支写权限。
4. **失败后是否允许自动重试**：推荐不自动；由 Mac 报告 Andy，花钱后重试先问。若允许自动重试，必须限制次数和总预算。
5. **任务/结果引用是否在 collect 后删除**：推荐删除，审计留在 PR 分支的 `tasks/<id>/` 和 `result.json`；保留会积累引用。
6. **是否把 `check:review-handoff` 放进 `npm run check`**：测试快就放，慢就只放 `test:tooling`；这决定它是不是每次提交的硬门槛。
7. **云端代理自身费用是否纳入 1 美元先问线**：账本测不到；需要 Andy 决定是“只看复核模型账本”还是“桌面应用显示的云端用量也算”。
8. **Mac 是否能给已开的云端会话中途发消息**：本方案用 stop 引用不依赖它；如果确认能发，可再加一层消息叫停。未核实。

---

## 六、读代码或来源证实的 / 推测的

**已由代码或来源证实：**

- 现有脚本在本地运行、写 `.agents/reviews`、账本格式、`--assert-reviewed` 链、`--report`、`--accept-low`、`--accept-unreviewed`：`opencode-review.mjs` 和 `model-review.md` 对应段落。
- 云端通过 `HIMAWARI_REVIEW_GATEWAY=magpie` 走 Magpie，Mac 不设变量直连：`model-review.md:130`、`:137`。
- 复核模型只读、一次性副本、费用上限、积分底线、记录目录：`model-review.md:71-105`。
- 复核提示词的固定部分和材料位置：`opencode-review.mjs:277-306`。
- 必答问题从 `model-review.md` 的 checklist 段解析：`opencode-review.mjs:220-231`。
- `changedOutside`/`lowFixProblems`/`roundsOnDisk`/`reviewReport` 对 `ledgerPath` 下额外文件的处理：`opencode-review.mjs:1121`、`:1231-1235`、`:1562-1567`、`:1398-1399`。
- 云端会话是独立上下文、只传 prompt、可用 worktree 隔离、可跨会话消息：Anthropic 官方文档（P12）。
- 不在 Mac 上跑测试：`test-and-production-hosts.md:8`。

**推测或未核实：**

- Mac 线程能否在云端会话运行中途给它发消息；本方案用 stop 引用规避，未核实消息通道。
- `start_session` 的返回值是否包含实际落地的环境；如果包含，Mac 应在调用后核对，不包含就只能靠 `claim` 的环境检查。
- 桌面应用能否稳定选中 himawari-cloud；07:42 的事实说明它可能退回 Default。
- 云端环境是否允许新增 `HIMAWARI_REVIEW_ENV`。
- 云端代理是否有权限推 `review/result/...` 这种自定义分支；05:11 的事实证明它能推“分支”，但具体 ref 命名未核实。
- 云端代理能否运行 `git ls-remote` 轮询 stop 引用；它既然能 push，大概率能 fetch，未单独核实。
- 云端代理自身的 token 用量是否能在桌面应用里导出并计入汇报；未核实。
- 结果提交是否需要签名；当前仓库规则没有要求，未核实未来是否会加。

---

## 七、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变复核模型已经见过的请求开头。**

- 复核模型的提示词仍由 `buildPrompt` 生成：固定部分（角色、工具、任务、侧重、必答问题、输出格式）在前，`---- 本次材料 ----`、`head`、`base`、`previous`、`brief` 在最后（`opencode-review.mjs:277-306`）。交接只改变“谁在哪个机器上运行这个脚本”，不改变 `buildPrompt` 的输入和顺序。
- 任务清单、README、`result.json` 都放在 `.agents/reviews/<记录键>/tasks/<taskId>/` 下；复核副本用 sparse checkout 排除整个 `.agents/reviews`（`model-review.md:83`、`opencode-review.mjs:2353`），所以它们不会进入系统提示、工具定义、历史或资料块。
- 每轮会变的值（`head`、`base`、`previous`、`brief`）仍然只在最后一条用户消息的材料段；固定部分不含时间、路径、服务商、额度、哈希。
- 交接章节加到 `model-review.md` 时，必须放在 `<a id="checklist"></a>` 段之外。`reviewQuestions` 只解析 checklist 段（`opencode-review.mjs:220-231`），所以必答问题逐字不变，复核提示词前缀不变。测试要锁住这一点。
- 云端线程自己的第一条消息是一个新对话的第一条消息，不是任何已有对话的中间插入；它不改变任何已发请求的字节。重试同一任务时，`prepare` 生成的 prompt 不含时间/随机数，字节相同。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**复核模型这一侧不会；交接元数据这一侧通过规范化避免。**

- `task.json` 用固定键顺序、固定数组顺序生成；`models` 按 `REVIEW_MODELS` 归一化，`providers` 去重排序；`inputHash`/`taskId` 用规范化 JSON 计算。
- 复核提示词只使用 `head`/`base`/`previous`/`brief`，这些来自提交哈希和简报字节；`createdAt`、`nonce`、`taskId` 只出现在任务清单和云端代理的上下文里，不进入复核模型提示词。
- `usage.jsonl` 里的 `at`、`cost` 等是账本字段，本来就不发给模型（`opencode-review.mjs:2921-2953`），不改变模型请求字节。
- 简报按原始字节保存和哈希；`claim` 用摘要校验后才交给 `--brief`，不会因为云端工作区不同而读到不同内容。
- 没有依赖前后文的遮盖、带时间的字段、无序集合进入模型请求。任务/结果的 git 引用顺序也不影响提示词。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有。见“8. 怎么测试”的表。每个守卫都有反向用例，并且要求“去掉守卫时测试失败”：

- 去掉 `claim` 的环境检查 → 缺变量用例仍会运行假复核，测试失败。
- 去掉 `claim` 的清单/摘要/`parseArgs` 复核 → 篡改用例仍会运行，测试失败。
- 去掉 `claim` 的 result 幂等检查 → 同一任务假复核被调用两次，测试失败。
- 去掉 lock CAS → 两个 claim 都运行，测试失败。
- 去掉 `collect` 的 `HEAD == head` 检查 → 过期结果被合并，测试失败。
- 去掉 `collect` 的“只改 ledgerPath”检查 → 改代码的结果被应用，测试失败。
- 去掉 `collect` 的新账本记录核对 → 错 head/错 model 的记录被应用，`--assert-reviewed` 失败或测试失败。
- 去掉任务文件在 `ledgerPath` 内的设计 → `changedOutside` 报 `unreviewed`，测试失败（I-73 反例）。
- 去掉 stop 轮询 → 账本没有 `owner-stopped`，测试失败。
- 去掉 pre-push hook → 推 main 成功，测试失败。
- 把交接章节插进 checklist 段 → 必答问题变化，测试失败。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下（产生 → 使用 → 两端校验）：

| 值 | 产生 | 使用 | 两端校验 |
|---|---|---|---|
| `taskId` | `prepare` | 分支名、`task.json`、prompt、`result.json`、`status`/`cleanup` | `^[0-9a-f]{32}$`；`claim` 重算 `sha256(inputHash+nonce)`；分支名用同一值 |
| `inputHash` | `prepare` | 清单、重复检查 | `^[0-9a-f]{64}$`；`claim` 从清单字段重算 |
| `nonce` | `prepare` | 计算 `taskId` | 16 位 hex；不进入复核提示词 |
| `mode` | `prepare`（复用 `parseArgs`） | 清单、`claim` 构造 argv、脚本 `MODES`、账本 `mode`、`--assert-reviewed` | `parseArgs` 和 `MODES` 都只接受三种；`prepare` 再校验一次 |
| `pr` / `topic` | `prepare` | `reviewKey`、`ledgerPath`、分支名、`--pr`/`--topic` | `pr` 正整数；`topic` 匹配 `TOPIC_PATTERN`；`claim` 校验 `ledgerPath === reviewKey(...)` |
| `head` / `base` / `previous` | `prepare` 用 `git rev-parse` 解析 | 清单、`claim`、脚本 `resolveCommits`、`buildPrompt`、账本 `head`、链 | `COMMIT_PATTERN` 40/64 位；`base`/`previous` 是 `head` 祖先；`claim` 再 `git cat-file -e` |
| `models` | `prepare`（复用 `parseArgs` 归一化） | 清单、`--models`、账本 `model`、`parseVerdicts`、链 | 必须是 `REVIEW_MODELS` 子集、非空、无重复、顺序固定；首轮两个模型规则由 `parseArgs` 检查 |
| `providers` | `prepare` | 清单、`--providers`、`gateway.json`、脚本 `startLiveGateway` | 必须是 `gateway.json` 里的 id、无重复、排序；`claim` 再读 `gateway.json` 校验；`--providers` 必须和 `--gateway magpie` 一起 |
| `approvedUsd` | Mac 从 Andy 的授权 | 清单、`--approved-usd`、`budgetCheck` | 正有限数；`prepare` 和脚本都用 `budgetCheck`；`claim` 不改值 |
| `questionsRef` | `prepare` | 清单、`--questions-ref`、`questionsSource` | 40/64 位提交或空；不以 `-` 开头、无控制字符（`parseArgs` 已检查） |
| `briefPath` / `briefSha256` | `prepare` | 清单、`claim` 读 blob、`--brief` | 路径必须是 `ledgerPath/tasks/<taskId>/brief.md`；摘要 64 位 hex；`claim` 重算 |
| `ledgerPath` / `recordPath` | `prepare` 用 `reviewKey` | 清单、脚本 `reviewDir`、`assertReviewed`、`lowFixProblems`、`changedOutside` | 必须等于 `reviewKey({pr,topic})`；`claim`/`collect` 都核对 |
| `taskBranch` / `resultBranch` / `stopBranch` / `lockBranch` | `prepare` | 清单、`git fetch/push`、pre-push hook、`status`/`cleanup` | 固定前缀 + 记录键 + `taskId`；`git check-ref-format`；hook 只放行 result/lock |
| `result.json` 的 `status` / `head` / `spent` / `round` / `error` | `claim` | `collect`、`status`、通知 | `status` ∈ {ok,failed}；`head` 是提交；`spent` 非负数或 null；`round` 正整数或 null；`error` 单行 |
| 通知首行 | `claim`/云端 | Mac 解析 | 固定前缀、字段齐全、taskId 匹配、status 枚举、result 是提交或 none、spent 是数字或 unknown；不合格只告警，result 分支仍权威 |
| `ledgerPath/tasks/<taskId>/` 下的文件 | `prepare`/`claim` | 脚本 sparse checkout、`changedOutside`、`lowFixProblems`、`roundsOnDisk`、`reviewReport`、`parseUsage` | sparse checkout 排除 `.agents/reviews`；`changedOutside` 和 `lowFixProblems` 按 `ledgerPath/` 前缀排除；`roundsOnDisk` 只认 `round-<n>`；`reviewReport`/`parseUsage` 只读 `usage.jsonl`。测试必须证明 `--assert-reviewed` 仍 `REVIEW_CURRENT` |
| pre-push hook 的允许引用 | `claim` | 云端 `git push` | 只允许 `review/result/...`、`review/lock/...`；其他 ref 退出 1。防误操作，不防 `--no-verify`（P7） |

**结论：** 账本 `usage.jsonl` 的字段和格式完全不变；新增文件都在 `ledgerPath` 下，现有所有读取方都会忽略它们；新产生的引用和清单值都有两端的格式/语义校验。唯一需要特别测试的是 `changedOutside`/`lowFixProblems` 对 `tasks/` 的忽略，这正是 I-73 提醒的那类“只看改动本身不够”的问题。
