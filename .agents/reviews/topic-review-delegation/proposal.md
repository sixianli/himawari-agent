# 方案：Mac 线程把方案讨论和代码复核交给 himawari-cloud 里的云端线程（整合后，待 Andy 同意）

三方比较：线程方案、两个模型各自的方案（`round-1/`）、两个模型对线程方案的审核（`round-2/`）。逐条取舍见 `judgments.md`。

## 前提（每条附来源）

1. 合并前从当前提交的账本核对复核链：`.agents/instructions/model-review.md:43`“它从当前提交里读账本，按轮次顺序把复核串成一条链”。
2. 网关选择：`model-review.md:130`“云端环境 himawari-cloud 把这个变量设成 `magpie`……Mac 上没有出口代理代填凭证，不设这个变量，照旧直连”。
3. Mac 本地线程能用桌面应用的 `start_session` 开云端会话、指定环境（Andy 2026-11-08 转述 Mac 线程的说明，未见官方文档）。会话记录（本线程用会话工具核对）：`session_014uWGaGfYV17Jff9XTjUMFG` 落在 himawari-cloud，跑完复核并把结果推到分支（提交 849f495），说明云端线程有推送权限；`session_014uWGaHqCC5z8HR3KZ4ztCx` 落在 Default，第 0 步检查后停下；两次按 Claude 标价折算分别是 1.12、0.43 美元。
4. 云端线程能给发起它的 Mac 线程发消息（Andy 2026-11-08 确认）；Mac 发给运行中云端会话的消息能不能送到，未核实。
5. “会出错”意见由线程逐条判断：`AGENTS.md`“和 OpenCode 协作”一节、`model-review.md:25`。
6. 复核脚本的材料路径按当前目录解析：`scripts/model-review/opencode-review.mjs` 里 `options.brief = resolve(take())`，开跑时 `readFileSync(options.brief)` 从运行目录读，不从复核副本读。
7. 代理变量名单：同一文件的 `PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]`。

## 做法

### 1. 什么时候交出去

Mac 线程（没有 `HIMAWARI_REVIEW_GATEWAY=magpie` 的会话）做方案讨论或代码复核时，一律交给 himawari-cloud 里的云端线程；只有 Andy 说“直连 Go”才在 Mac 上直连。`model-review.md:130` 那句一并改写。云端线程自己要复核时照旧直接跑。

### 2. 交出前 Mac 线程做的事

1. 把要复核的代码、这件事的整个记录目录（含 `usage.jsonl` 和已有的逐条判断）都提交并推送。
2. 把材料提交进 `.agents/reviews/<目录>/briefs/<要复核的提交前 12 位>-<模式>.md` 并推送。这个提交只动记录目录，不影响合并前核对。此时的分支头叫“交出点”。
3. 预算和服务方：要不要 `--approved-usd`、`--providers`，按现行规则先问 Andy，写进命令。
4. 运行 `node scripts/model-review/delegate.mjs prompt …`（参数同复核脚本，另加 `--branch`、`--tip <交出点>`、`--reply-to <Mac 会话编号>`；分支名、提交号、会话编号都按固定格式校验），它打印任务说明。输出没有时间戳，参数顺序固定。
5. 用 `start_session`（target cloud、环境 himawari-cloud）交出，记下新会话编号。

### 3. 任务说明（脚本生成，云端线程照做）

- 第 0 步：`cd` 到仓库根目录，`git fetch`；分支头必须正好是交出点，否则停下回报。
- 第 1 步：原样运行给定命令。命令里一律带新参数 `--require-gateway`、材料用仓库根目录下的相对路径。
- 第 2 步：退出码非 0 也不重跑；只提交 `.agents/reviews/<目录>/` 下的文件，普通推送到同一分支（不强推）；推送被拒就停下。
- 第 3 步：开跑时先回一条 `REVIEW_DELEGATION_STARTED`，跑完回一行 JSON：`{"event":"REVIEW_DELEGATION_DONE","dir":…,"round":…,"tip":…,"commit":…,"exit":…}`；失败时 `event` 为 `REVIEW_DELEGATION_FAILED` 并带错误码。不改代码、不写逐条判断、不用 `--accept-low` 和 `--accept-unreviewed`、不合并、不发 PR 评论。
- Andy 在这个会话里说停止、换服务方时，按“Andy 怎样控制复核”一节做。

### 4. 复核脚本的硬检查 `--require-gateway`

最终不走 Magpie，或者 `PROXY_ENV` 里的代理变量都为空时，在读材料、安装和花钱之前以 `GATEWAY_REQUIRED` 停下（退出码 2）。开到 Default 环境时由脚本拒绝，不靠云端线程自觉。

### 5. 收回结果（Mac 线程）

- 收到消息后，Mac 线程在自己原来的工作区运行 `node scripts/model-review/delegate.mjs check --tip <交出点>`。它只 `git fetch`，不检出新提交，用的是 Mac 本地那份脚本，所以云端改过的脚本不会被执行。它核对：
  - 远端分支头是交出点的后续提交（没有被强推）；
  - 交出点之后只改了这次的记录目录；
  - `usage.jsonl` 只在末尾追加；
  - 新记录的 `mode`、`head`、`base`、`previous`、`round`、`models` 和交出时一致，经 Magpie，服务方在 `--providers` 允许的范围内；
  - 模型答案和提示词文件齐全。

  花费以账本为准，不信消息里转抄的数字。核对通过才拉取分支，接着逐条判断、修改、提交；不通过就不拉，告诉 Andy。
- 消息兜底：交出后 60 分钟还没收到“完成”，就跑一次 `check`；分支上还没结果，就把会话编号告诉 Andy，不再交出第二份。
- 等待期间 Mac 线程对这个分支不做任何提交（和“每个提交立即推送”不冲突：不提交，就没有要推送的）。

### 6. 测试

- `--require-gateway`：没走 Magpie、走了 Magpie 但没有代理、`--gateway direct` 都以 `GATEWAY_REQUIRED` 停下，且不读材料、不安装；走 Magpie 又有代理时放行；子命令带它报 `ARG_NOT_FOR_SUBCOMMAND`。
- `delegate.mjs prompt`：输出包含交出点、带 `--require-gateway` 的完整命令、材料路径、只提交记录目录、消息格式；两次输出逐字节相同；非法的分支名、提交号、会话编号被拒；把 `--require-gateway` 从模板里去掉时用例失败。
- `delegate.mjs check`：在临时 git 仓库里构造正常结果（通过）和四种坏结果：被强推、改了记录目录以外的文件、改写了账本旧行、账本记录的 `head` 或 `mode` 对不上（都拒绝）。

### 7. 规则文字

`model-review.md` 新增“Mac 线程把复核交给云端线程”一节（放在“怎么跑”之后，以锚点和二级标题起头），并改写第 130 行；`AGENTS.md` 那段补一句。

## 风险

- 云端线程是另一个 Claude，可能不照任务说明做：它推上来的东西都要先过 `check` 才会被采用，被强推时 Mac 本地还留着交出点，可以恢复；这和“防误操作，不防有意”是同一个取舍。
- 桌面应用读不到环境列表时会落到 Default：靠 `GATEWAY_REQUIRED` 兜住，代价是白开一个会话。
- 运行中的叫停：Andy 直接对那个云端会话说“停止复核”；单轮损失本来就被每个模型 0.2 美元封顶。
- 同一个 PR 同时交出两份（两个 Mac 线程）：不加锁；`check` 会因为账本或分支头对不上而拒绝，代价是白跑一份。

## 需要 Andy 定的

1. 云端会话本身的花费（按 Claude 标价折算，每次约 0.4 到 1.1 美元，算在 Claude 账号的周额度里，不进复核账本）：每次交出不另行先问，汇报里写明这次开了哪个会话。
2. Mac 线程默认一律交出（DeepSeek 建议默认仍直连 Go、只在需要时交出；线程建议一律交出，因为 Go 额度已经用完，而且 Mac 上不配密钥）。
