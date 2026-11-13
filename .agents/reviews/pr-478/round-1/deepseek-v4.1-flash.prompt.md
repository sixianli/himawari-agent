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
仓库就是当前目录，已检出 3726dbdb1f04ce4cb2f597d5913e54be6ad416b6。
对比基准是 2b1e2d2e5a189ac909239ba825af2407172d44b2，先运行 git diff 2b1e2d2e5a189ac909239ba825af2407172d44b2..3726dbdb1f04ce4cb2f597d5913e54be6ad416b6 看改动。
作者的说法（可能有错，请核对）：
# 多人 2 PR②b：控制目录和证据经网关跨账号读写

## 背景
多人方案（ADR 0234 第 4 条）让每人的命令在专属 Linux 账号下运行。PR 463 已经让 Job Host 经每人一个网关（以该人的执行账号运行，主服务经 0600 套接字连）启动。但 Job Host 的控制目录（`control.sock`、`started.json`、`final.json`、`launch-decision.json`）要求属主就是本进程账号、权限 0700；以后控制目录属执行账号，主服务账号（Worker 和主服务都在这个账号下）进不去，所以控制、证据和“开始/拦下”决定也要经网关。

## 改了什么
- `packages/runtime-sandbox/src/job-host-control-access.ts`（新）：`JobHostControlAccess` 合同：建控制目录、查目录状态（是否规范路径、是否目录、是否只有本账号能进、设备号和 inode）、inspect/stop、读开始和结束证据、读/抢/拦“开始还是拦下”决定。本机实现 `localJobHostControlAccess(root)` 直接调原来的函数；网关实现 `gatewayJobHostControlAccess(socketPath)` 每个操作开一个连接、发一帧 `control`、收一帧 `result`。签名验证一律在调用方做：网关只回原始的签名字节或决定证据，调用方用原来的 `verifyJobHostControlEnvelope`、`verifyJobHostLaunchEvidence` 再验一遍。另有只含降低风险操作的 `JobHostRiskControl`（不含建目录和抢“开始”），只有它从主服务可用的 `./control` 入口导出。
- `job-host-gateway-control.ts`（新）：网关端处理控制帧。所有路径必须是 `--control-root` 下一层、名字符合 `control-<20 位十六进制>`；错误以固定错误码回给调用方，系统错误码（如 ENOENT）原样带回，调用方据此区分“没有证据”。调用方断开时网关中止转发给 Job Host 的查询。
- `job-host-gateway.ts`、`job-host-gateway-main.ts`：连接第一帧可以是 `control`；网关参数新增必填的 `--control-root`；控制连接上的第二帧直接断开。
- `job-host-control.ts`、`job-host-launch-decision.ts`：把“读字节”和“验签名”拆开，导出给网关和调用方分别用；本机路径行为不变。
- `apps/execution-worker/src/production-sandbox-execution-v2.ts`：新增可选 `jobHostAccount: { launcher, control }`；没有时仍用本机 fork 和本机目录（生产不变）。
- `apps/agent-service/src/production-sandbox-control.ts`：所有对控制目录的 `lstat`、`realpath`、查询、读证据、拦下决定改经 `jobHostControl`（默认本机）。
- 测试：`test/integration/sandbox-control-evidence.test.ts` 五条关键用例和 `test/integration/sandbox-preparation-control.test.ts` 的 [R2-L8] 端到端用例（真实 Job Host 准备失败、拦下、证明从未开始）都分本机和网关各跑一遍；`test/integration/job-host-gateway.test.ts` 新增控制根边界、证据转发与调用方验签、取消传到 Job Host、无控制根和多帧拒绝。

## 目标和约束
- 默认路径（本机）行为不变；生产暂不接网关（PR③ 开通工具接上）。
- 网关和 Job Host 同账号，Job Host 本来就持有控制令牌，所以网关能伪造签名不算新增风险；但网关不能让主服务访问控制根以外的路径。
- 主服务只能拿到降低风险的操作（[R2-S4] 导入边界）。
- 不改发给模型的内容。

## 已核对
- 相关 50 个测试文件 1318 条中 1305 条通过；13 条失败都在 `sandbox-preparation-control.test.ts`，改动前同样失败（容器里没有 SRT 环境）。
- 每处网关路径都做过反向验证：去掉网关的 query、claim 处理或取消传递，对应用例失败。

## 请特别看
- 网关端路径限制（`controlDirectory`）有没有绕过办法；`launchContext` 只校验了 `control.directory`，其余字段交给原来的 `validateContext`，是否足够。
- 错误码和系统错误码的转发是否会让主服务把“网关不可用”误当成“没有证据”（ENOENT），从而错误地判定 Job Host 从未开始或已经退出。
- 本机实现是否和改动前逐行等价（尤其 `readPreparationControl` 的 ENOENT 处理、`register` 里两次查目录的顺序）。
- 调用方断开时网关中止查询；网关回复写失败、连接半开时会不会卡住或泄漏连接。
