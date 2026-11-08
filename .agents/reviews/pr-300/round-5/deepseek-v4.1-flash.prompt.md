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
仓库就是当前目录，已检出 838f1ec6c4c9372d811126b22cb46a8950af310d。
对比基准是 ab4421d1a0fbfd497c4bfb7d1a0c8174fab72c19，先运行 git diff ab4421d1a0fbfd497c4bfb7d1a0c8174fab72c19..838f1ec6c4c9372d811126b22cb46a8950af310d 看改动。
上一轮复核到 eb341ee6ad3c27eed41b64587d21dcf5b471dc9b，先看 git diff eb341ee6ad3c27eed41b64587d21dcf5b471dc9b..838f1ec6c4c9372d811126b22cb46a8950af310d 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 300：Mac 线程把复核交给 himawari-cloud 里的云端线程

## 问题和目标

Andy 的 Mac 本地线程做方案讨论和代码复核时，OpenCode Go 周额度已用完，Mac 上又不想配别家模型的密钥。决定（Andy 2026-11-08）：Mac 线程不在本机跑复核，用桌面应用的 `start_session` 开一个跑在 himawari-cloud 环境里的云端线程去跑，结果推回同一个分支，Mac 线程核对后再逐条判断。方案经两个模型各自出方案和审核，整合后的版本在 `.agents/reviews/topic-review-delegation/proposal.md`。

## 约束

- 花钱上限、积分底线、账本、只读沙箱不能削弱；落在错的环境里不能花钱。
- 复核记录和合并前核对（`--assert-reviewed`）的格式不变。
- 云端线程是另一个 Claude，它推回来的东西不能直接信。
- 发给模型的内容只追加；不写代码注释；新增行为有测试和反向用例。

## 作者的说法（请逐条核对）

1. `--require-gateway`：`parseArgs` 里最终不经 Magpie 报 `GATEWAY_REQUIRED not-magpie`；`main` 里没有 `PROXY_ENV` 代理变量报 `GATEWAY_REQUIRED no-proxy`，都在读材料、读网关配置、安装之前；自检模式不查代理；子命令带它报 `ARG_NOT_FOR_SUBCOMMAND`。
2. `delegate.mjs prompt`：所有字段按固定格式校验，复核命令用 `reviewArgv`（再交给 `parseArgs` 校验），输出不含时间；材料路径必须是 `.agents/reviews/<目录>/briefs/<提交前 12 位>-<模式>.md`；补跑规则只在非补跑时出现。
3. `delegate.mjs check`：先 `git fetch` 把远端分支更新到 `refs/remotes/origin/<分支>`，不检出；依次核对 交出点是远端分支头的祖先、交出点之后只改了这次的记录目录、`usage.jsonl` 在交出点那份的基础上只追加、新记录的 `mode`/`head`/`base`/`previous`/模型/`gateway`/服务方对得上、答案和提示词文件存在。`--apply` 要求本地 HEAD 正好是交出点才 `merge --ff-only`。
4. `delegate.mjs wait`：用 `git ls-remote` 每 2 分钟查一次分支，分支头变了就结束，90 分钟没变以 3 结束。
5. 文档：`model-review.md` 新一节、两处旧说法、`AGENTS.md`、ADR 0178 后续与代码一致。

## 实测

三个测试文件共 210 条通过（含 13 条新的 delegate 测试，用临时 git 仓库构造了正常和各种坏的结果）；`npm run check` 通过；九处关键逻辑逐个改坏，对应用例都失败。

请重点查：`check` 能不能被一个恶意或出错的云端线程骗过（强推、改代码、改旧账本、伪造记录、符号链接、路径技巧）；`prompt` 的输入能不能在任务说明里注入额外指令；`--require-gateway` 能不能被绕过；`wait`/`check` 在 git 命令失败时的行为；文档和代码是否一致。

## 第 2 轮：按第 1 轮意见做的修改（请核对这些修改本身对不对、有没有引入新问题）

- `checkResult`：交出点之后不许有合并提交；每个提交（`git log --name-only`）和最终差异（`git diff --raw`）都只能碰这次的记录目录；不许删文件，新文件模式必须是 `100644`（挡符号链接）；除 `usage.jsonl` 外，改动的文件必须是预期那一轮 `round-<n>/` 下、文件名以新记录对应模型的短名开头的 `.md` / `.stderr.txt`；新记录的 `round` 必须等于 `task.round ?? nextRound(交出点账本)`；预期模型（`parseArgs(reviewArgv(task)).models`）每个都要有一条非替补记录；提示词文件的 sha256 必须等于记录的 `promptSha256`；`outcome` 不是 `ok` 时仍返回 ok 但带 `notOk`，命令行打印 `DELEGATION_RESULT_INCOMPLETE` 并以 4 退出。
- `merge-base --is-ancestor` 只有返回 1 才算 `DELEGATION_REWRITTEN`，其他非 0 当 git 出错。
- `waitForBranch`：校验分钟数（有限、大于 0、至多 600）和间隔（有限、至少 1 秒）；轮询次数 `ceil(分钟*60/间隔)+1`；`lsRemote` 抛错连续 3 次才向外抛；`remoteHead` 在 git 失败时抛错。
- `gatewayRequiredProblem`：先要求 `HIMAWARI_REVIEW_GATEWAY === "magpie"`（否则 `not-cloud`），再要求代理变量。
- `validateTask`：providers 必须非空、在 `gateway.json` 里；models 非空。`parseTask`：每个子命令只收自己的参数（`DELEGATE_NOT_FOR_COMMAND`），未知子命令 `DELEGATE_USAGE`。
- 第 1 轮不改的：D6（gitleaks 脚本来自被复核分支，项目一贯前提，已在文档写明）、G6（`none` 服务方豁免，真实账本里会有）。

## 第 3 轮：按第 2 轮意见做的修改（请核对这些修改本身对不对、有没有引入新问题）

- `checkResult`：服务方允许名单是 `task.providers ?? gateway.json 的服务方`，账本里的 `none`、`unknown` 占位照收；预期轮次是 `task.round ?? nextRound(交出点账本, 交出点里已有的 round-N 目录)`；新记录里任何字符串或键带控制字符就整条拒绝（`DELEGATION_CONTROL_CHARACTER`）；花费用 `spentOf(added)`，带 `costUnknown`/`inFlight` 的记录让汇总行加 `estimated=true`。
- `showFile`：先 `git ls-tree` 判断路径在不在（git 出错就抛），在才 `git show`。
- 删除文件的判断：`.stderr.txt` 被删除且同一次差异里新增了同前缀的 `.attempt-*.stderr.txt` 时放行（补跑把旧报错文件改名）；其他删除仍拒绝；非 `100644` 模式的新增或修改仍拒绝。
- `applyResult(task, { repo, remote })`：合并 `check` 返回的提交号，不是可变的远端引用。
- `waitForBranch`：间隔不能大于 `minutes * 60`。
- 第 2 轮不改的：R2-D9（替补记录与 `absent=`：原模型自己的记录先写进账本，不会误报）。

## 第 5 轮：按第 4 轮意见做的修改（请核对这些修改本身对不对、有没有引入新问题）

第 4 轮复核的提交是 eb341ee6，之后只有一个提交 838f1ec6，改动在 `scripts/model-review/delegate.mjs`、`test/tooling/review-delegate.test.mjs`、`.agents/instructions/model-review.md` 和复核记录。请只看这个增量（`git diff eb341ee6 838f1ec6`）。

- `notOk`：某个模型这一轮里只要有一条 `outcome` 为 `ok` 的记录（本模型的，或替补它的）就不算不完整，所以同一轮先超时、补跑成功不再报 `not-ok`、不再以 4 退出。
- 文件名白名单：每个新增记录的模型，只允许 `<模型>.md`、`<模型>.prompt.md`、`<模型>.stderr.txt`，以及 `<模型>.attempt-<数字>.` 加这三种后缀；用字符串比较，不再把模型名拼进正则（之前带特殊字符的模型名会让 check 崩溃）。
- 新记录里的控制字符检查改为同时拒绝 Unicode 的 Cc 和 Cf 类字符。
- 追加的账本行不能和交出点账本里已有的某一行完全相同（`DELEGATION_LEDGER_DUPLICATE`）。
- 允许的服务方名单：`task.providers`，没有就读交出点提交里的 `scripts/model-review/gateway.json`，读不到则 `DELEGATION_NO_GATEWAY_CONFIG`。
- 所有 git 子进程加 2 分钟超时。
- 文档把 `check:gitleaks`（目前不存在）、删除条件、文件名规则、重复行、格式字符、服务方来源、git 超时写准。

## 实测

三个测试文件共 227 条通过（含 3 条新用例：格式字符、同轮补跑成功、重复账本行）；去掉重复行检查、去掉格式字符拒绝，对应用例失败。`npm run check` 41 步中 40 步通过，`check:layout`（网页界面版面审计）失败，本 PR 没碰网页文件。
