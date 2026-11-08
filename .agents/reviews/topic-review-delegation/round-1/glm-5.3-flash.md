我先读关键文件弄清现状。
继续读剩余部分和相关规则文件。
再核对脚本里环境变量、账本校验和测试的现状。
再核实一个点：脚本从哪里读 `--brief`（副本还是原仓库），这决定交接时 brief 放哪。
材料已足够，下面写出方案。

---

# 方案：Mac 本地线程把方案讨论/代码复核交给 himawari-cloud 云端线程

## 一、方案依赖的前提

**读代码或来源证实的：**

1. **网关选择顺序是「命令行 > 环境变量 > 直连」，环境变量不设就直连 Go。**
   `scripts/model-review/opencode-review.mjs:2527-2532`：`if (options.gateway === undefined && defaultGateway) { ... options.gateway = defaultGateway } ... if (options.gateway === "direct") delete options.gateway;`；`.agents/instructions/model-review.md:130`：「命令行的 `--gateway magpie` 或 `--gateway direct`……没写时看环境变量 `HIMAWARI_REVIEW_GATEWAY`……都没有就直连 Go」。→ 现状下没有任何机制能表达「必须经 Magpie，否则拒绝开跑」。

2. **复核记录必须提交在 PR 分支上，`--assert-reviewed` 从当前提交读账本。**
   `.agents/instructions/model-review.md:100`：「记录目录固定在仓库里……线程在合并前把记录目录随 PR 一起提交」；`model-review.md:43`：「它从当前提交里读账本，按轮次顺序把复核串成一条链」。

3. **意见分类由线程做，脚本只核对账本自洽。**
   `model-review.md:25`：「分类由线程做，不由模型做。线程对每一条意见逐条核对……」；`verdicts.jsonl` 由线程写（`model-review.md:32`）。

4. **花钱上限是脚本硬门槛，超线时以 `BUDGET_NEEDS_APPROVAL` 拒绝开跑，`--approved-usd` 是唯一放行方式。**
   `model-review.md:105`：「开跑前脚本把 `usage.jsonl` 里已花的加上这一轮最多会花的……代码复核超过 1 美元、方案讨论超过 0.5 美元，就以 `BUDGET_NEEDS_APPROVAL` 拒绝开跑」。

5. **复核的提交接不上链就报 `chain-broken`/`REVIEW_NOT_CURRENT`，拦下合并。**
   `model-review.md:43`：「接不上的一点报 `chain-broken`……输出 `REVIEW_NOT_CURRENT`（退出码 5）就对列出的改动再复核一轮」。

6. **账本记录已含时间戳字段 `at`（既有行为，非本次引入）。**
   `scripts/model-review/opencode-review.mjs:1342`、`:2922`：`at: new Date().toISOString()`。

7. **账本校验只核对已知字段，但本次方案不新增任何账本字段（约束要求格式不变）。**
   `opencode-review.mjs:1537-1557`：`gatewayValid` 等逐字段校验，多余字段不报错——但为守「复核记录和合并前核对的格式不变」，方案不新增字段。

8. **门槛必须是可执行逻辑，文档提醒不算门槛。**
   `.claude/rules/incident-gates.md:15`：「门槛是指自己会运行、失败时会拦下的检查……文档、案例库案例、记忆笔记或提醒都不是门槛」。→ 07:42 那次靠任务说明第 0 步的文字检查拦下，不是门槛，要挪进脚本。

9. **`--brief` 是脚本用 `readFileSync` 从脚本运行目录直接读的文件。**
   `opencode-review.mjs:2446`（`options.brief = resolve(take())`）、`:2787`（`readFileSync(options.brief, "utf8")`）。而复核副本用 sparse checkout 去掉整个 `.agents/reviews/`（`model-review.md:101`）→ brief 必须放在记录目录之外、且必须存在于云端克隆里。

10. **每个模型的 0.2 美元上限由费用插件在请求发出前拦，Magpie 线路照旧生效。**
    `model-review.md:141`：「OpenCode 配置里按 Go 的单价写模型价格，现有的费用插件照旧在请求发出前拦，每个模型 0.2 美元、先问线都照旧」。

**仓库外事实（来源是本次材料，仓库里未核实）：**

11. Mac 线程的 `start_session` 可开云端会话（target=cloud、title、background、prompt、可指定环境）；新会话克隆 `sixianli/himawari-agent`，prompt 是第一条消息，看不到主线程对话；跑完能给发起线程回消息。（Andy 2026-11-08 转述；05:11 与 07:42 两次实测。）
12. himawari-cloud 环境设了 `HIMAWARI_REVIEW_GATEWAY=magpie`，凭证在网络密钥里；Default 环境没有。（`model-review.md:130,137` 侧证 + 07:42 实测：Default 环境下该变量不是 `magpie`。）
13. Mac→云端方向的**运行中**消息是否可达未核实（材料只证实云端→Mac 跑完后的回信）。

---

## 二、方案本身

### 总体形状

一次复核 = Mac 线程（有上下文的「写代码线程」）准备材料并冻结分支 → 开一个 himawari-cloud 云端会话只做「跑脚本 + 提交原始记录」 → 云端会话回信 → Mac 线程解冻、取回记录、自己逐条判断（verdicts）。**判断留在 Mac 线程**，云端线程是纯机械执行者，所以规则里「分类由线程做」「会出错意见由写代码的线程逐条判断」一字不改。

### 1. 交接怎么做（任务说明模板）

任务说明（`start_session` 的 prompt）固定为一段模板，写进 `model-review.md` 新节，Mac 线程照填：

```
在 himawari-cloud 环境开这个会话（背景运行）。
仓库：sixianli/himawari-agent，分支：<分支名>。
第 1 步：git checkout <分支名>，git pull --ff-only。
第 2 步：原样运行（不要增删参数）：
  node scripts/model-review/opencode-review.mjs --mode <模式> \
    --base <分叉点提交> --head <提交或分支名> [--previous <上一轮提交>] \
    --pr <编号> | --topic <短名> \
    --brief <已提交在分支上的 brief 文件路径> \
    --gateway-required magpie \
    [--approved-usd <Mac 线程问过 Andy 后填的数>] [--providers <…>]
第 3 步：无论脚本以什么退出码结束：把记录目录（.agents/reviews/… 下的
  round-<n>/ 和 usage.jsonl）commit 到 <分支名> 并 push（不许 force-push，
  push 被拒就停下不要重试）。
第 4 步：给发起线程回一条消息，固定格式：
  成功：REVIEW_HANDOFF_DONE mode=… pr|topic=… round=… head=<提交> spent=<REVIEW_SPENT_TOTAL 的数值>
  失败：REVIEW_HANDOFF_FAILED reason=<脚本打印的错误码或最后一段输出> spent=<数值或 unknown>
不得做其他任何事：不改代码、不写 verdicts、不用 --accept-unreviewed/--accept-low、
不开新一轮。脚本退出码非 0 时不要重跑，直接按第 4 步报告。
```

要点：

- **brief 先提交进分支**。材料里的 brief 不能塞在 prompt 里再让云端线程写文件——那样每次交接要保证逐字节一致，容易在重跑（`ROUND_PROMPT_MISMATCH`，`model-review.md:103`）时对不上。改为：Mac 线程把 brief 提交到分支上记录目录**之外**的路径（如 `.agents/briefs/pr-<编号>-round-<n>.md`；不能放 `.agents/reviews/` 下，那里被副本 sparse checkout 删掉，前提 9）。提交了 brief 才开云端会话，这也顺便完成了「开跑前分支已定格」。
- **`--gateway-required magpie` 是新脚本参数**，把「环境不对不花钱」从任务说明的文字检查变成脚本硬门槛（前提 8）。它放在命令行里由模板携带，即使会话落错环境，脚本在**任何安装、Magpie 预检、发请求之前**就以 `GATEWAY_REQUIRED_UNMET <要求> <实际>` 退出 2。
- **`--approved-usd` 在开跑前问清**。云端线程问不了 Andy；凡预计超过先问线（代码复核 1 美元、方案讨论 0.5 美元）或账本累计已超线的，Mac 线程先按现行规则问 Andy，把数填进模板。脚本自己会再核一遍（前提 4），云端线程填不上就不用跑、原样报 `BUDGET_NEEDS_APPROVAL` 回来。

### 2. 两个线程的分工

| | Mac 本地线程（写代码线程） | 云端线程（himawari-cloud） |
|---|---|---|
| 写 brief、提交进分支 | ✓ | |
| 问 Andy 要预算、定服务方 | ✓ | |
| 开云端会话、填模板 | ✓ | |
| 跑脚本（只这一条命令） | | ✓ |
| 提交并推送记录目录（模型答案、prompt 文件、usage.jsonl） | | ✓ |
| **写 verdicts.jsonl / judgments.md、逐条判断** | ✓（取回记录后） | |
| 「会出错」修改、再开下一轮交接 | ✓ | |
| `--accept-low` / `--accept-unreviewed` / 合并 | ✓（Andy 原话只认 Mac 线程里的字，现行规则不变） | 禁止 |

推送纪律（防冲突）：

- **交接期间分支冻结**：Mac 线程从开出云端会话到收到回信（或确认记录已推送）之间，不向该分支推送任何提交。
- 云端线程只准 fast-forward push，被拒（说明 Mac 线程违约推过东西）就停下报告，**永不 rebase 强推**。
- Mac 线程恢复工作前先 `git fetch` 并确认云端线程的记录提交在分支上，自己的新提交叠加在它之后。若 Mac 线程在复核运行期间确实改了被复核的代码（不该发生，发生了就是违约），那些改动使复核提交不再是最新——按现行规则对改动再复核一轮（`model-review.md:43` 的 `REVIEW_NOT_CURRENT` 路径），浪费的钱记入违约教训，不另设机制。

### 3. 规则文字和脚本要改什么

**脚本（`scripts/model-review/opencode-review.mjs`）——唯一一处：**

- 新参数 `--gateway-required <magpie|direct>`：只属于普通复核模式（不进 `ASSERT_OPTIONS`/`REPORT_OPTIONS`，给了就按既有 `ARG_NOT_FOR_SUBCOMMAND` 拒，`opencode-review.mjs:2516-2525`）；在网关解析完（命令行 > 环境变量 > direct，`:2527-2532`）之后、Magpie 安装/预检之前核对，不一致抛 `GATEWAY_REQUIRED_UNMET`。
- `--gateway-required magpie` + `--gateway direct` 显式矛盾：同样 `GATEWAY_REQUIRED_UNMET`。
- 账本**零新增字段**：交接这件事不需要进账本，账本照旧记 `gateway`/`providers`，`--assert-reviewed`、`--report`、`--accept-low` 全部不动（守约束）。

**规则文字：**

- `model-review.md` 新一节「Mac 线程把复核交给云端线程跑」：上面的任务模板、分工表、冻结纪律、失败处理；并写明云端线程的权限边界（第 2 节末行）。
- `AGENTS.md`「和 OpenCode 协作」一节加一句指向新节（AGENTS.md:74 允许这类文件单独提交）。
- 现行各节（Andy 控制、先问门槛、只读沙箱）一字不改——云端线程跑的就是同一个脚本，所有既有保护自动生效（前提 4、10）。

### 4. 出错怎么办

| 故障 | 处理 |
|---|---|
| 落错环境（Default，变量不是 magpie） | 脚本 `GATEWAY_REQUIRED_UNMET` 退出，未安装、未联网、未花钱；云端线程按模板报 `REVIEW_HANDOFF_FAILED`；Mac 线程让 Andy 在 claude.ai 里把该会话改到 himawari-cloud 或重开会话 |
| 脚本失败（`BUDGET_NEEDS_APPROVAL`、`GATEWAY_PREFLIGHT_FAILED`、`api-error` 等） | 云端线程不重试，推上已写出的记录和报错文件，回信带错误码；Mac 线程按现行规则处置（问 Andy 补 `--approved-usd`、用 `--round` 补跑等，`model-review.md:35,103`） |
| 云端线程失败/会话死掉，回信没到 | **记录在 git 里，回信只是通知**：Mac 线程超时（例如 30 分钟）后 `git fetch` 查分支上有没有新的记录提交；有就当成功继续，没有就请 Andy 在 claude.ai 里看该会话的最后输出，再决定重开（重开按模板，`--round` 语义照旧接得上） |
| 分支冲突（push 被拒 / Mac 违约推过） | 云端线程不 force-push、停下报告；Mac 线程确认自己推了什么：只是记录目录冲突就由 Mac 线程在本地合并后推；被复核代码变了就接受浪费、按 `REVIEW_NOT_CURRENT` 再复核一轮 |
| Andy 要中途叫停 | Mac 线程把「叫停」作为消息发给云端会话（**若运行中消息不可达，见风险 3**）；即使叫停传不到，单轮损失被既有上限封顶：每模型 0.2 美元插件硬拦（前提 10）；之后的轮次不会再开，因为新一轮要 Mac 线程发起 |

### 5. 怎么测试

1. **`--gateway-required` 反向用例**（`test/tooling/opencode-review.test.mjs`，仿 `review-gateway.test.mjs:143-152` 的现成写法）：
   - 环境无 `HIMAWARI_REVIEW_GATEWAY` + `--gateway-required magpie` → 退出 2、stderr 含 `GATEWAY_REQUIRED_UNMET magpie direct`，且**不创建 Magpie 安装目录、无任何网络调用**（断言缓存目录不存在）；
   - `--gateway magpie --gateway-required direct` 矛盾 → 同样拒绝；
   - 环境变量=`magpie` + `--gateway-required magpie --self-check-only` → 走到既有自检路径（正向）；
   - `--assert-reviewed --gateway-required …` → `ARG_NOT_FOR_SUBCOMMAND`（反向）。
2. **他在环境里冒烟**：先跑 `--gateway-required magpie --self-check-only`（自检用本机假服务方，不花钱，`model-review.md:142`），过了再拿一个真实小复核（如 PR 296 第 1 轮重跑）走完整交接验证一次，提交说明写明两层都实测过。
3. **链完整性反向用例不新增**：分支被重写的后果已由既有 `chain-broken`/`REVIEW_NOT_CURRENT` 覆盖（前提 5）。
4. 交接模板本身不可自动化——正因如此，「环境对不对」才必须从模板文字下沉为脚本参数（前提 8）。

---

## 三、考虑过但不选的做法

1. **Mac 上装 Magpie + 把三家的真密钥配到 Mac**：直接违反「Mac 上不配任何模型密钥」，且凭证扩散面变大。不选。
2. **云端线程做完整复核含逐条判断（verdicts 也由它写）**：判断依赖 PR 的来龙去脉，云端会话是全新克隆、看不到主线程对话（前提 11），判出来的「会出错/可以更好」质量差，Mac 线程还得重新核一遍，等于判断做了两遍而上下文只有一边有。不选；这也让规则「分类由线程做」的「线程」指代不变（前提 3）。
3. **记录推到独立分支再由 Mac 合并**：`--assert-reviewed` 只认当前提交里的账本（前提 2），多一个合并步骤就多一个「忘了合」的失败点；直接推 PR 分支 + 冻结纪律更简单。不选。
4. **用 CI/自托管 runner 跑复核**：改造大、凭证要新通路、云端会话现成可用；不是本次问题的最小正确解。不选。
5. **在 himawari-cloud 再加环境变量 `HIMAWARI_REVIEW_GATEWAY_REQUIRED` 做环境侧硬门槛**：比命令行参数更防「云端线程抄漏模板参数」，但要 Andy 去环境设置里加变量、且 Default 环境没有该变量时脚本不知道「这里本该被要求」。作为可选项留给 Andy 拍板（见下），首版只用命令行参数。

---

## 四、风险和反例

1. **反例：云端线程不照模板跑**（漏掉 `--gateway-required`、擅自重跑、动了别的文件）。落错环境时漏参数的后果是直连失败、不花钱但白跑一次（会话本身约 0.4 美元级）；重跑/多跑被「模板只准跑一条命令 + 退出码非 0 不重试」约束，但这是文字约束，**不是门槛**——真正的硬保护仍只有脚本内的每模型 0.2 美元和先问线（前提 4、10）。危害上界：单轮 ≤0.4 美元 + 会话成本。
2. **反例：两个线程同时推**。云端线程 push 被拒即停、不 force-push（规则）；即使 Mac 线程违约推了改代码的提交，链检查会拦合并（前提 5），损失是已花的复核费，不是错误合并。
3. **运行中叫停传不到**：Mac→云端运行中消息未证实（前提 13）。接受上界 ≤0.4 美元/轮，或在 claude.ai 界面停会话（容器终止、进程死掉，**账本尾部和原始文件可能丢失**，等于被 SIGKILL——`model-review.md:83` 已写明这种情况下删不掉副本、费用只能靠宁可多记）。需要 Andy 拍板要不要更好的通路。
4. **判断前置时间变长**：Mac 线程要等云端跑完才能写 verdicts；后台运行 + 回信缓解，但一轮复核的墙钟时间变长。
5. **信任面变化**：现在提交模型答案和账本的是云端线程而不是写代码线程。「防误操作不防有意」的既有取舍（`model-review.md:36`）原样适用于新提交者——云端线程同样是本项目线程，信任级别不变，但 Andy 抽查的对象多了一类。
6. **brief 放错位置**（放进 `.agents/reviews/` 下）：副本 sparse checkout 会删掉它，脚本读不到就 `ENOENT` 失败——失败是显式的、不花钱，属于会被首次冒烟立刻暴露的低危风险；规则里写明路径要求即可。

---

## 五、需要人拍板的取舍

1. **云端会话本身的花费（Claude 侧，实测 1.12 / 0.43 美元）算不算进现行先问线**（复核 1 美元 / 方案讨论 0.5 美元）？它不进复核账本，脚本管不到。若算，Mac 线程开云端会话前要先问；若不算，需要一条新的线。
2. **要不要环境侧第二道硬门槛**（himawari-cloud 加 `HIMAWARI_REVIEW_GATEWAY_REQUIRED=magpie`，脚本同时认参数和环境变量）：更硬，但要 Andy 动环境设置。
3. **运行中叫停要不要专门通路**（验证 Mac→云端运行中消息，或接受 ≤0.4 美元/轮上界 + 界面停会话丢尾部账本的现状）。
4. **判断留在 Mac 线程（本方案）还是交给云端线程**：影响每轮的人工等待结构和规则改动幅度。

---

## 六、证实与推测的分界

- **证实**：前提 1-10 全部出自本仓库文件（附行号）；07:42 落错环境、05:11 成功、回信可达三项出自本次材料的实测记录。
- **推测**：`start_session` 各参数的精确语义（材料只给了一句话描述）；Mac→云端运行中消息不可达（只证实了不可证实的部分，标「未核实」）；云端会话成本量级（按 Andy 折算的两个实测数外推）；brief 放 `.agents/briefs/` 的具体路径是本方案的新约定，无先例。

## 七、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？——不会。**
复核脚本发给复核模型的提示词组装代码一行不动（`buildPrompt`，`opencode-review.mjs:277-301`）；每轮仍是一次性 `opencode run`，固定说明在前、brief 和会变的内容在后，收尾追问仍只在末尾追加一句（`model-review.md:92`），CodeBuddy 11128 的受控例外照旧（`model-review.md:143`）。新增的模型输入只有云端线程收到的任务说明，它是一个**全新对话的第一条消息**，不存在「已经发过的开头」，也不和任何既有对话共享前缀；每轮会变的值（PR 号、提交哈希、预算）都在这条消息里。`--gateway-required` 不进提示词，只进参数解析。

**2. 会不会让同一段文字在不同请求里变成不同的字节？——不会。**
新增值全部是静态字符串（参数名、模板文字）或 git 里的固定字节（brief 提交进分支，云端克隆读到的和 Mac 上逐字节相同，前提 9）；不引入遮盖、不引入无序集合、不引入依赖前后文的内容。账本里的 `at` 时间戳是既有行为（前提 6），本次改动没有新增任何带时间或顺序不稳的字段——这也是方案坚持「账本零新增字段」的原因之一。

**3. 有没有对应的自动检查，反向用例会不会真的失败？——有，且已列明失败方式。**
「跑在错的环境里不能花钱」从任务说明的文字下沉为脚本参数 `--gateway-required`：反向用例（环境变量缺失、显式 `--gateway direct`、`--assert-reviewed` 误用）分别以 `GATEWAY_REQUIRED_UNMET`、`ARG_NOT_FOR_SUBCOMMAND` 退出 2，其中环境用例断言在 Magpie 安装和网络调用之前就停下；正向用例（环境=magpie + self-check-only）走到既有自检。分支冲突的反向后果由既有 `chain-broken`/`REVIEW_NOT_CURRENT` 拦截，不新增机制。交接模板和冻结纪律本身不是门槛（前提 8），所以能下沉的都下沉了，剩下的是流程约束并已写明各自的上界。

**4. 每个产生/修改的值，两端都核对过吗？——逐个核对如下。**
- `--gateway-required`：产生处=任务模板（新节）+ 脚本参数表；使用处=参数解析新校验、四条测试。与既有参数矩阵核对过：不得进 `ASSERT_OPTIONS`/`REPORT_OPTIONS`（否则被 `ARG_NOT_FOR_SUBCOMMAND` 拒，`:2516-2525`）、与 `--providers`/`--self-check-only` 的组合要定并测（方案：self-check-only 允许、providers 不受影响）。
- 账本格式：**零新增字段**，`USAGE_LEDGER_INVALID`（`:1545-1557`）、`--assert-reviewed`、`--report`、`--accept-low` 的全部校验原样通过——这正是约束「格式不变」的落实。
- brief 文件路径：产生处=Mac 线程提交进分支；使用处=`readFileSync(options.brief)`（`:2787`，在副本运行前从脚本目录读）+ 重跑时的 `ROUND_PROMPT_MISMATCH` 字节比较（`model-review.md:103`）——git 来源保证两端字节一致，比较可复现；位置必须避开被 sparse checkout 删掉的 `.agents/reviews/`（前提 9），已在模板和风险 6 写明。
- 回信字段（`REVIEW_HANDOFF_*`）：只被人读，不进任何校验；事实来源始终是 git 里的记录和账本，回信丢了不产生假状态。
- 分支推送：产生处=云端线程 fast-forward push；使用处=`--assert-reviewed` 的祖先链与「当前提交」检查（前提 2、5）——记录提交必须落在 Mac 线程后续提交之前，冻结纪律保证这一点，违反时链检查失败而不是静默通过。
