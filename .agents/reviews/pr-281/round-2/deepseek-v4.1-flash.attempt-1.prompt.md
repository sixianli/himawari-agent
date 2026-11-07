你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 f872aaaa74f55b67ac9ed43cc3f6061eb20096d6。
对比基准是 7b549e3e024f75b55ccaddba1d83d821a939fc5a，先运行 git diff 7b549e3e024f75b55ccaddba1d83d821a939fc5a..f872aaaa74f55b67ac9ed43cc3f6061eb20096d6 看改动。
上一轮复核到 bcdc31410f7c236c9a9f0142e42209e601015c36，先看 git diff bcdc31410f7c236c9a9f0142e42209e601015c36..f872aaaa74f55b67ac9ed43cc3f6061eb20096d6 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 281：复核模型调用可经每次运行自起的本机 Magpie

## 问题和目标

复核脚本 `scripts/model-review/opencode-review.mjs` 原来把服务方写死为 OpenCode Go，而这个套餐的额度快用完了。Andy 要求：Claude Code 和 OpenCode 只关心“哪个模型、什么推理强度”，服务方交给 Magpie（开源本机模型网关）去选；Magpie 和 OpenCode 都跑在云端容器里，不连生产服务器。决定写在 `docs/adr/0178-review-model-calls-through-a-local-magpie.md`。

## 约束

- 新开关 `--gateway magpie` 默认关；关着时生成的 OpenCode 配置必须和改动前逐字节相同。
- 现有的只读限制（git 替身、受限 bash）、费用插件 `spend-guard.mjs` 在请求发出前拦、每模型 0.2 美元、先问线、`usage.jsonl` 账本校验、开跑前自检，都不能被削弱。
- 旧账本必须照常能读；模型全名（`REVIEW_MODELS`）是账本和逐条判断记录的身份，不能改。
- 发给模型的内容只追加（`.claude/rules/prompt-prefix.md`）；例外只有 ADR 0178 里写明的 CodeBuddy 插件在 11128 拒绝时改写系统提示。
- 不写代码注释；新增行为要有测试和反向用例。

## 作者的说法（请逐条核对）

1. `--gateway` 关着时，`reviewConfig()` 的输出和改动前相同；I-76 的门槛（正式复核配置不得有 `apiKey`）在直连方式下照旧成立，经 Magpie 时 `apiKey` 只会和回环地址一起出现（`gatewayProvider` 拒绝非回环地址）。
2. 经 Magpie 时费用插件仍在请求发出前拦：OpenCode 配置里按 Go 单价写了模型 `cost`，所以每步费用不是 0；自检的 guardProbe 经 Magpie 也验证了第 4 次请求被拦。
3. 账本：经 Magpie 的记录多 `gateway` 和 `providers` 字段，`parseUsage` 只对带 `gateway` 的行要求 `providers`；读不到 Magpie 的用量记录时记 `costUnknown`，按现有保守公式记账。
4. 积分底线：剩余积分减去预留（模型数 × 0.2 美元 × 历史最大积分/美元换算比，不低于 `defaultCreditsPerUsd`）低于 20，或查不到，就从路由组里去掉 CodeBuddy。
5. 安装按 `gateway-lock.json` 校验 SHA-256 和 npm integrity，不符就删掉并报错；运行前后核对 Magpie 程序摘要。
6. 每次运行的 Magpie 配置和用量记录都在临时目录里，跑完删除；脚本收到中断信号时会停掉 Magpie（`cleanup` 里的 `stopGateway`）。
7. 透传探针比较直连和经 Magpie 的第一条带工具的请求，只把 OpenCode 写进系统提示的两个模型名换回直连写法后逐字节比较。

## 实测

云端容器里：`test/tooling/review-gateway.test.mjs` 19 条通过（含真实自检经 Magpie）；四处保护去掉后对应用例都失败；`npm run check` 41 步通过；一次真实的小规模方案讨论经 Magpie 两个模型都由 CodeBuddy 完成，记录在 `.agents/reviews/topic-gateway-smoke-test/`。

请重点查：错误路径（Magpie 启动失败、插件登录失败、查积分失败、用量记录缺失、Magpie 中途退出）时会不会漏记花费、漏停进程、或者让复核在没有费用上限的情况下继续；`summarizeGatewayUsage` 的美元折算会不会偏低；`creditsLeft` 对 Magpie 返回格式的假设；以及文档 `.agents/instructions/model-review.md` 新增一节和代码是否一致。

## 第 2 轮：按第 1 轮意见做的修改（请核对这些修改本身对不对、有没有引入新问题）

- 用量汇总 `summarizeGatewayUsage` 现在返回 `{ byModel, unreadable }`：跳过读不懂的行并计数，积分和 token 不是非负数字时不累加并计数，服务方名只认配置里的 id（其余记 `unknown`，空的记 `none`），内部用 Map。`gatewayRecordFields` 出错、结果不合格或有读不懂的行时记 `costUnknown`，账本这一行照样写。
- `gatewayConfigProblems` + `readGatewayConfig(path, requiredModels)`：逐项校验 routing、stays、creditFloor、defaultCreditsPerUsd、providers、creditProvider、models 的成员前缀、上限和单价；主流程要求两个复核模型都在配置里。`floorDecision` 遇到非数字返回 `floor-invalid`，不用 CodeBuddy。
- gateway.mjs 登记每个 `magpie serve` 子进程，`stopAllGateways()` 在 cleanup（结束和中断信号）里调用。
- `creditsLeft`：remaining 必须在 0 到 100 之间；有 amount 时，`limit × remaining / 100` 和 `limit − amount` 相差超过 0.5 就返回 null。
- 自检经 Magpie 时，guardProbe 那次运行的费用必须大于 0，否则 `GATEWAY_COST_NOT_COUNTED`。
- `startLiveGateway` 已导出，账号编号查询可注入；建组或预检的任何失败都报 `GATEWAY_PREFLIGHT_FAILED` 并停掉 Magpie。
- 第 1 轮 D8 没采纳：预检本来只看本次要跑的模型；两个模型都建组，是因为 DeepSeek 失败时 GLM 要顶上。
- 新测试：直连配置快照（改动前提交的六种配置，安装路径换成占位后的 SHA-256）、配置校验、底线非数字、积分卡片不一致、用量异常、startLiveGateway 两条真实用例、停掉全部 Magpie。
