## 结论

改动方向正确。我逐行读了 `delegate.mjs`、`opencode-review.mjs` 的相关部分和测试。**没有发现能让 `check` 接受代码改动、强推、删除旧文件或非普通文件的高危漏洞**：这些路径都有成对的检查和反向用例。发现的主要问题是 1 个中低的一致性缺陷，以及若干低风险/文档问题。测试未运行（本环境只能执行 git 命令），所以「210 条通过、`npm run check` 通过、九处改坏都失败」未核实。

## 发现（按严重度）

### 1. 中低：替补成功时 `check` 仍报 `not-ok` 并以 4 退出，与复核脚本自己的判定矛盾
- 文件:行：`scripts/model-review/delegate.mjs:326`、`delegate.mjs:477-480`；对照 `scripts/model-review/opencode-review.mjs:3021-3027`
- 证据（证实）：
  - `delegate.mjs:326`：`const notOk = added.filter((record) => record.outcome !== "ok").map((record) => record.model);`
  - `delegate.mjs:477-480`：只要 `notOk.length > 0` 就打印 `DELEGATION_RESULT_INCOMPLETE … not-ok=…` 并 `process.exitCode = 4`。
  - 复核脚本自己的口径 `opencode-review.mjs:3021-3027`：`const covered = results.some((record) => record.substitute && record.outcome === "ok");`，然后对第一个模型的失败记录**豁免**退出 4。
- 问题：走 `substituteFor` 路径时（`opencode-review.mjs:856-864`：`mode==="code-review"`、有 `previous`、单模型、DeepSeek api-error 后重试仍是可重试错误），脚本会先写 DeepSeek 的 `api-error` 记录，再写 GLM 的 `substitute:true` 成功记录。`check` 的 `expectedModels` 仍只有 DeepSeek（有 `previous` 且未给 `--models` 时 `parseArgs` 默认只为 DeepSeek），`absent=` 能过（DeepSeek 非替补记录存在），但 `notOk` 会把 DeepSeek 算进去 → `check` 以 4 退出。于是一次「已被替补覆盖、复核脚本自己认为完整」的复核，会被 Mac 线程误判为不完整，可能触发多余补跑/花钱。
- 建议：`notOk` 复用复核脚本的 `covered` 逻辑（当存在成功的 `substituteFor === 首个预期模型` 的替补记录时，不再把该模型的失败算作 incomplete），或在输出里明确标注 `covered-by=<替补模型>`。

### 2. 低：文档说 `check` 用「交出时的同一组参数」，但 `check` 不接受 `--reply-to`
- 文件:行：`delegate.mjs:375-390`（`prompt` 含 `--reply-to`）对比 `delegate.mjs:392-407`（`check` 不含）；`.agents/instructions/model-review.md:133`（prompt 签名含 `[--reply-to …]`）、`model-review.md:136`（「check 加交出时的同一组参数」）
- 证据（证实）：`parseTask` 在 `delegate.mjs:449-450` 对不在该子命令清单里的参数抛 `DELEGATE_NOT_FOR_COMMAND`；`check` 的清单（`392-407`）没有 `--reply-to`。
- 问题：Mac 线程照文档「同一组参数」把 `--reply-to` 也传给 `check`，会以 2 退出，不是干净的 `DELEGATION_*` 结果。
- 建议：给 `check` 的 `COMMAND_OPTIONS` 也加 `--reply-to`（`checkResult` 反正会忽略它），或把文档改成「check 去掉 `--reply-to` 后的同一组参数」。

### 3. 低：不可信的 `record.model` 在「模型是否合法」判定生效前就被用来拼 git 路径
- 文件:行：`delegate.mjs:296-309`
- 证据（证实）：
  - `delegate.mjs:296-298`：模型不合法只是 `problems.push(...)`，**没有 `continue`**；
  - `delegate.mjs:303-305`：接着 `const name = shortModel(record.model);` 并用它拼 `${recordsDir}round-${round}/${name}.md`、`.prompt.md`，交给 `showFile`；
  - `showFile`（`delegate.mjs:192-195`）先用 `git ls-tree <commit> -- <path>`、再 `git show <commit>:<path>`，且都是非 `allowFail`，出错就抛。
- 问题：`record.model` 只被 `parseUsage` 要求是「非空字符串」，`hasControlText` 只挡控制字符。像 `*`、`[` 之类的名字会在 `ls-tree` 里被当 pathspec 通配，随后 `git show` 用字面路径失败，把本应干净的 `DELEGATION_RECORD_MISMATCH`（退出 5）变成 `DELEGATE_GIT_FAILED`（退出 2）。我未发现能借此读出仓库外内容：`shortModel` 取 `/` 最后一段，路径前有固定 `.agents/reviews/<key>/round-N/` 前缀，且最终文件模式被限为 `100644`。
- 建议：模型不在 `REVIEW_MODELS` 时直接 `continue`（跳过 showFile），或用 `git show` 前先对路径做白名单确认。

### 4. 低：文档「没有删除文件」与代码允许 `.stderr.txt` 改名删除不一致；且未提到 `.attempt-N.md` / `.attempt-N.prompt.md` 也是合法新增
- 文件:行：`model-review.md:136`；`delegate.mjs:253-266`、`delegate.mjs:29`（`ROUND_FILE_PATTERN`）、`delegate.mjs:314-321`
- 证据（证实）：`renamedAway` 明确放行 `*.stderr.txt` 的删除；同一条文档后面虽补了「补跑把旧的报错文件改名成 `.attempt-N.stderr.txt` 时…允许」，但前半句「没有删除文件」仍与之字面冲突；而且真实脚本 `keepEarlierAttempt`（`opencode-review.mjs:1621-1639`）会把 **`.md`、`.prompt.md`、`.stderr.txt` 三种**旧文件都改名成 `.attempt-N.*`，文档只提了报错文件。
- 建议：文档改成「除补跑改名外不删除文件」，并说明 `.attempt-N.md/.prompt.md/.stderr.txt` 都属于允许的改名产物。

### 5. 低（推测影响）：服务方允许名单取自工作区 `gateway.json`，而不是交出点提交
- 文件:行：`delegate.mjs:285-286`
- 证据（证实代码）：`const allowedProviders = task.providers ?? readGatewayConfig(undefined, REVIEW_MODELS).providers.map(...)`，`readGatewayConfig` 读的是脚本所在仓库的当前文件，不是 `task.tip` 提交。
- 影响（推测）：正常情况下 Mac 工作区就在 `task.tip`，二者一致；但若 Mac 有未提交的 `gateway.json` 改动或 HEAD 不在 tip（`check` 不像 `apply` 那样强制 HEAD==tip），可能误拒合法服务方或放过已从配置删除的服务方。
- 建议：以 `task.tip` 里的 `gateway.json` 为准，或至少要求 `check` 时 HEAD 也是交出点。

### 6. 低（推测影响）：`applyResult` 只校验 `HEAD==tip`，不校验当前分支就是 `task.branch`
- 文件:行：`delegate.mjs:330-335`
- 证据（证实代码）：`const head = git(["rev-parse", "HEAD"])…; if (head !== task.tip) fail(…); git(["merge", "--ff-only", remote…])`
- 影响（推测）：若 Mac 仓库处于 detached HEAD，或另一分支恰好也指向交出点，`merge --ff-only` 会把**当前**分支快进，而不是 `task.branch`。这是既有行为，本次只是把远端引用换成固定提交，未新增风险，但值得补一道 `git symbolic-ref --short HEAD === task.branch` 校验。

### 7. 低（推测）：新增的控制字符整条拒绝可能误拒合法记录
- 文件:行：`delegate.mjs:281`、`delegate.mjs:205-211`；记录字段来源 `opencode-review.mjs:2944`（`lastReason` 未清洗）
- 证据（证实代码）：`hasControlText(added)` 会递归检查所有字符串/键，`code < 32 || code === 127` 即拒绝；`parseUsage` 只挡 `\r\n`，不挡 tab 等。`apiError` 已被 `apiErrorOf` 清洗（`opencode-review.mjs:315-321`），但 `lastReason` 直接来自事件。
- 影响（推测）：若某次 `lastReason` 含 tab/其他控制字符，复核会被整条判为 `DELEGATION_CONTROL_CHARACTER`，属合法结果被拒。概率低。

### 8. 设计局限（文档已承认，不算新漏洞）：账本/答案/提示词可由云端伪造
- 文件:行：`delegate.mjs:304-309`、`324-327`；`model-review.md:136`「账本记录本身仍被信任（防误操作，不防有意）」
- 证据（证实）：`promptSha256` 只是「记录里写的哈希 == 云端提交的提示词文件哈希」，云端可以自己算；`answer` 文件没有任何可信哈希；brief 在 `task.tip` 的内容也没有和 prompt 绑定——云端用另一份 brief 跑出的 prompt/答案同样能过 `check`。
- 结论：`check` 能挡误操作和范围外改动，挡不住有意伪造；这与文档一致。若要加强，可把 `task.tip` 里 brief 的 sha256 也写进记录并由 `check` 校验。

### 9. 低（推测）：资源/失败路径
- `git()` 的 `maxBuffer` 是 256MiB（`delegate.mjs:170`），超大账本/历史会以 `DELEGATE_GIT_FAILED` 结束；`wait` 在远端分支被删除时 `ls-remote` 退出 0、sha 为空，会一直轮询到超时（`delegate.mjs:364`），不区分「分支不存在」。

## 侧重检查（错误路径、不可信输入、安全、资源、不可撤销、文档一致）

- 错误路径：`merge-base` 只有 status 1 才判 `DELEGATION_REWRITTEN`，其余非 0 抛 git 失败（`delegate.mjs:233-238`）；`showFile` 改为 `ls-tree` 失败即抛（`192-195`）；`wait` 连续 3 次 git 失败才抛、否则重置（`354-363`）；`remoteHead` 用非 `allowFail` 的 `git`，失败即抛（`370-373`）。这些与作者说法一致。
- 不可信输入/注入：`validateTask`（`delegate.mjs:45-101`）用固定正则校验 branch/tip/head/base/previous/replyTo/mode/round/providers/models，`brief` 必须精确等于 `briefPathFor`；`reviewArgv`（`103-124`）各值都是安全字符集或数字，拼进 shell 命令不会越界。**没有发现任务说明注入**。
- 安全/范围：逐提交 `git log --name-only` + 最终 `git diff --raw --no-renames` 双重限制只能碰记录目录；拒绝合并提交、删除（除 stderr 改名）、非 `100644`（符号链接/gitlink/可执行）；账本必须 `after.startsWith(before)`。测试覆盖了符号链接、删除、改了又还原、合并、账本改写。恶意伪造账本属文档已承认的信任边界。
- 不可撤销：`--apply` 合并的是 `check` 返回的固定提交（`delegate.mjs:474`、`330-335`），不是可变的 `refs/remotes`，并有 `DELEGATION_LOCAL_MOVED` 保护；测试 `review-delegate.test.mjs:209-212` 明确构造了「check 后远端又前进，仍只合并核对过的提交」的反向用例。
- 文档一致：`--require-gateway` 的三个错误码、`wait` 的 2 分钟/90 分钟、`check` 的规则与代码基本一致；发现上面第 2、4 条文档偏差。
- 未核实：三个测试文件的 210 条、`npm run check`、九处改坏反向验证——本环境只能跑 git，未运行测试。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。发给复核模型的请求由 `buildPrompt` 生成（`opencode-review.mjs:277-306`），本次改动没有碰它；新增的只是 `--require-gateway` 参数解析（`2424-2428`、`2540-2541`、`2788-2789`）和新的 `delegate.mjs`（它不生成复核提示词，只生成一次性的云端任务说明）。`--gateway magpie --require-gateway` 也不进入 `buildPrompt`。因此发给模型的内容仍然只在末尾追加，每轮变化的材料仍在最后。新增的 `delegationPrompt` 是给一个新会话的第一条消息，不涉及「已发内容被改写」。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会（复核请求层面）。`delegate.mjs` 里没有 `Date`/随机数/`process.env` 进入 `delegationPrompt`（我通读了全文），输出只由 `task` 字段按固定顺序 `join` 而成，同样的参数逐字节相同。账本 `usage.jsonl` 里的 `at` 时间戳只写进账本，不进模型请求；新增的 `estimated`/`spent` 只用于命令行汇总。没有引入依赖前后文的遮盖或无序集合序列化到提示词。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，且覆盖较全：`review-delegate.test.mjs` 覆盖了 pending/ok/rewritten/out-of-records/ledger-rewritten/record-mismatch/missing/merge/symlink/delete/unexpected-file/prompt-hash/round/models/apply-pinned/providers-none-unknown/control-char/round-dir/attempt-rename/estimated/wait 边界与 ls-remote 失败；`review-gateway.test.mjs:204-248` 覆盖 `--require-gateway`（not-magpie、not-cloud、no-proxy、子命令拒绝）。多数用例是「改坏后必须失败」的形式（例如 `209-212` 的 apply-pinned、`692-694` 的删除 attempt 报错文件、`730-741` 的 interval）。**未核实**它们实际全部通过，因为不能运行测试。较薄的覆盖：`record.model` 非法时的 git 失败路径、控制字符出现在 *键* 上、`showFile` 的 git 错误路径、`--reply-to` 被 `check` 拒绝这几点没有专门用例。

**4. 每个值的生产者/使用者两端校验是否一致？**
- 服务方 id：生产于 `gateway.json`（`workbuddy-ai/opendesign/opencode-go`，另有 `gateway.mjs:69` 的 `RESERVED_PROVIDER_IDS` `none/unknown`）。`validateTask`（`delegate.mjs:78-86`）只认配置里的 id；`check` 的 `allowedProviders`（`285-286`）同源并额外放行 `none/unknown`（`301`）；运行侧 `main` 还会用 `gatewayConfig.providers` 再校验 `--providers`（`opencode-review.mjs:2791-2794`）。两端一致。
- 模型短名：`validateTask` 用 `shortModel` 对照 `REVIEW_MODELS`；`reviewArgv` 交给 `parseArgs` 再解析成完整模型（`opencode-review.mjs:2485-2498`）；`check` 用 `expectedModels`（`delegate.mjs:284`）核对记录。一致，但非法模型会触发上面第 3 条的路径问题。
- `round`：`parseUsage` 保证是安全正整数或省略；`check` 期望 `task.round ?? nextRound(earlier, roundDirectories(tip))`（`282-283`），与复核脚本的 `roundForRun`/`roundsOnDisk`（`1570-1618`）同源。基本一致（唯一差异：`roundsOnDisk` 会把名为 `round-N` 的**文件**也算作轮次，而 `ls-tree -d` 只算目录，属极端误拒）。
- `brief` 路径：`briefPathFor` 生成、`validateTask` 精确比对、命令里作为 `--brief`；两端一致。但 `check` 没有把 tip 里 brief 的内容与 prompt 绑定（见第 8 条）。
- `remote`/`tip`：`check` 解析固定的远端提交并传给 `applyResult`，`applyResult` 只做 `--ff-only`，两端一致。
- `estimated`/`notOk`：`estimated` 由 `costUnknown||inFlight` 产生并被命令行使用，一致；`notOk` 的语义与复核脚本的退出码语义不一致（第 1 条）。
- 文档/代码：`--require-gateway` 三个错误码、`wait` 时长、`check` 主要检查项一致；`--reply-to` 与「没有删除文件」两处不一致（第 2、4 条）。

## 作者说法逐条核对

1. `--require-gateway`：基本属实。`parseArgs` 在 `2540-2541` 抛 `GATEWAY_REQUIRED not-magpie`（包括 `--gateway direct`，因为 `2539` 先删掉了 `direct`）；`main` 在 `2788-2789` 用 `gatewayRequiredProblem` 在 `readGatewayConfig`（2790）、读材料（2796-2798）、`opencodeBinary()` 安装（2838）之前检查 `not-cloud/no-proxy`；自检模式只跳过代理检查（`2425`）；子命令带它会被 `ARG_NOT_FOR_SUBCOMMAND`（测试 `review-gateway.test.mjs:213`）。注意：带 `--self-check-only` 时 `parseArgs` 仍要求 `magpie`，这与「自检不查代理」不矛盾。
2. `delegate.mjs prompt`：属实。字段按固定正则校验；`reviewArgv` 会调用 `parseArgs` 再校验（`delegate.mjs:122`）；输出无时间；brief 路径必须恰好是 `briefPathFor`；补跑文案只在 `task.round === undefined` 时出现（`131-134`）。
3. `delegate.mjs check`：描述的检查项都实现了（`213-327`）；`--apply` 用 `check` 返回的固定提交（`474`）。**但**「outcome 不是 ok 就以 4 退出」没有考虑替补成功的情况，见第 1 条；另外 `check` 不接受 `--reply-to`，见第 2 条。
4. `delegate.mjs wait`：属实（`337-368`、`484-502`）；默认 2 分钟、90 分钟、超时退出 3。补充：分支被删除时会空等到超时，且总时长可因 `ceil` 比 `minutes` 多出不到一个间隔。
5. 文档：`model-review.md` 新节、两处旧说法、`AGENTS.md`、ADR 0178 的改动与代码总体一致；偏差见第 2、4 条（「同一组参数」与 `--reply-to`、「没有删除文件」与 stderr 改名、未提 `.attempt-N.md/.prompt.md`）。
6. 「210 条通过 / `npm run check` / 九处改坏都失败」：**未核实**（本环境只能运行 git 命令）。从代码看每类新逻辑都有对应用例，但上述几处薄弱点（非法 model、键上的控制字符、`--reply-to`、`showFile` 的 git 错误）没有专门反向用例。
