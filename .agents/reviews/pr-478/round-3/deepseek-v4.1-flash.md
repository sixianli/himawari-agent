> 说明：本轮只用了 read/grep/git，没有运行测试（工具权限只允许上述读取，且现已被停用）。因此涉及“测试是否会失败”的结论都是**通过读代码推演**得出的，不是实际运行结果；`1305/1318`、`已做反向验证` 等作者说法标「未核实」。

# 一、发现的问题（按严重度）

## 1. 中：网关端的 `claim` / `block` / `prepare` 不响应调用方断开或超时，可能“已落盘但调用方没收到确认”

- 文件：`packages/runtime-sandbox/src/job-host-gateway.ts:124-141`、`packages/runtime-sandbox/src/job-host-gateway-control.ts:64-97`、`packages/runtime-sandbox/src/job-host-control-access.ts:176-192`
- 问题：调用方断开时，网关只把 `aborted.signal` 交给 `answerJobHostControlFrame`，而该函数只把 signal 用于 `query`；`prepare`、`evidence`、`launch`（read/claim/block）完全不看 signal。客户端在 10s 超时后会 `socket.destroy()` 并返回 `JOB_HOST_GATEWAY_CONTROL_TIMEOUT`，但网关侧的 `decideJobHostLaunch` 仍会继续执行并发布 `launch-decision.json`。`claimLaunch` 是否成功又取决于 `published === true`，因此同一 binding 的下一次重试看到已存在的 `launch` 决策会返回 `false`，worker 可能一直停在 unknown。
- 证据（亲自读到）：
  - `job-host-gateway.ts:126` `socket.once("close", () => aborted.abort());`
  - `job-host-gateway.ts:131` `answerJobHostControlFrame(root, frame, aborted.signal)`
  - `job-host-gateway-control.ts:64-75` 只有 `op === "query"` 把 `signal` 传进去；`launch` 的 `claim/block` 在 `:88-96` 直接 `await decideJobHostLaunch(...)`
  - `job-host-control-access.ts:178` 客户端超时后 `fail("JOB_HOST_GATEWAY_CONTROL_TIMEOUT")`，`:173` `socket.destroy()`
  - `job-host-launch-decision.ts:249-251` `launchClaimed` 要求 `result.published && ...`
- 建议：在网关写决策前检查 `signal.aborted`，或把取消传进 `decideJobHostLaunch`；更彻底的做法是让“同一 binding 的既有 `launch` 决策”返回 `published: true`（同 binding 的 `sessionId/token` 相同，`bindingDigest` 相同，不同 attempt 会因 digest 不同被 `verifyJobHostLaunchEvidence` 拒绝），从而消除“已发布但丢失确认”的卡死窗口。
- 注：这是**读代码可以确认**的机制；但“什么时候会超过 10s 或网关恰好崩溃”属于**推测**，概率低。

## 2. 低-中：证据读取 `open` 缺 `O_NONBLOCK`，FIFO 可阻塞网关线程

- 文件：`packages/runtime-sandbox/src/job-host-control.ts:147-165`
- 问题：`readJobHostControlEvidenceBytes` 用 `O_RDONLY | O_NOFOLLOW` 打开 `final.json`/`started.json`，先 `open` 再 `handle.stat()` 判断 `isFile()`。如果该路径是 FIFO（或设备文件），`open(O_RDONLY)` 会在 `stat` 之前阻塞。网关现在以执行账号长期运行，并读取该账号拥有的控制目录；一个在控制目录里放入 FIFO 的执行账号进程/逃逸后的任务可以卡住网关的 libuv 线程。`readJobHostLaunchDecision` 已经用了 `O_NONBLOCK`，证据读取没有。
- 证据（亲自读到）：
  - `job-host-control.ts:153` `const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);`
  - `job-host-control.ts:156` `if (!metadata.isFile() || ...)`
  - 对照 `job-host-launch-decision.ts:138` `constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK`
- 建议：证据读取也加 `O_NONBLOCK`（打开后再用 `fstat` 校验 regular file）；这样非普通文件会在 `stat` 处被 `JOB_HOST_CONTROL_EVIDENCE_INVALID` 拒绝，而不是阻塞。
- 注：这是**既有代码**的问题（拆函数前就存在），但本 PR 把它接到网关执行账号路径上，因此更值得修；任务本身在 SRT 下通常访问不到该目录，所以实际可利用性标「未完全核实」。

## 3. 低：新网关错误码没有进入 `sandboxReconciliationFailureReason`，且带下划线的系统错误码不会“原样带回”

- 文件：`packages/application/src/services/sandbox-execution-reconciliation.ts:36-79`、`packages/runtime-sandbox/src/job-host-control-access.ts:145-155,191-192`
- 问题：
  - `JOB_HOST_GATEWAY_UNAVAILABLE` / `JOB_HOST_GATEWAY_CONTROL_TIMEOUT` 既不在消息白名单里，也没有 `code`，因此会被归类为 `SANDBOX_RECONCILIATION_UNCONFIRMED`；本机路径同样的故障会得到 `SANDBOX_SUPERVISOR_UNAVAILABLE` / `SANDBOX_CONTROL_TIMED_OUT`。这不至于把网关不可用误判成“从未开始”（值得肯定），但诊断和上层处理会比本机更模糊。
  - 作者说“系统错误码（如 ENOENT）原样带回”，实际转发正则 `^E[A-Z0-9]{1,20}$` 不接受下划线，Node 的 `ERR_INVALID_ARG_VALUE` 一类不会转发。
- 证据（亲自读到）：
  - `job-host-control-access.ts:191-192` `socket.on("error", () => fail("JOB_HOST_GATEWAY_UNAVAILABLE")); socket.on("close", () => fail("JOB_HOST_GATEWAY_UNAVAILABLE"));`
  - `job-host-control-access.ts:153` `if (typeof systemCode === "string" && /^E[A-Z0-9]{1,20}$/.test(systemCode))`
  - `sandbox-execution-reconciliation.ts:62-76` 只识别 `JOB_HOST_CONTROL_TIMEOUT` 和 `ENOENT/ECONNREFUSED/...` 等 code
- 建议：在 `sandboxReconciliationFailureReason` 中把 `JOB_HOST_GATEWAY_UNAVAILABLE` 映射为 `SANDBOX_SUPERVISOR_UNAVAILABLE`、`JOB_HOST_GATEWAY_CONTROL_TIMEOUT` 映射为 `SANDBOX_CONTROL_TIMED_OUT`，并补正反用例；若确实要“系统错误码原样带回”，把正则放宽到允许数字/下划线（并保持客户端的长度上限）。

## 4. 低：worker 的根不一致检查发生在网关已经建目录之后，且测试没有锁定具体错误码

- 文件：`apps/execution-worker/src/production-sandbox-execution-v2.ts:421-427`、`test/integration/sandbox-v2-worker-lifecycle.test.ts:729-735`
- 问题：`prepareDirectory` 已经成功在网关的 `controlRoot` 下创建目录，worker 随后才比较路径并抛 `SANDBOX_CONTROL_ROOT_MISMATCH`。如果 `launcher`/`control` 被错误地配对到另一个人的网关，这会在**另一个人的 privateRoot** 里留下一个空控制目录，worker 不清理。测试只断言 `stage: "prepare"` / `reasonCode`，没有断言 `SANDBOX_CONTROL_ROOT_MISMATCH`，也没有断言错误目录未被创建/已被清理。
- 证据（亲自读到）：
  - `production-sandbox-execution-v2.ts:424` `const preparedDirectory = await controlAccess.prepareDirectory(controlName);`
  - `:425-426` `if (preparedDirectory.directory !== path.join(binding.privateRoot, controlName)) throw new Error("SANDBOX_CONTROL_ROOT_MISMATCH");`
  - `sandbox-v2-worker-lifecycle.test.ts:730-735` 只检查 outcome、stage、`controlCalls`、`mocks.prepare`
- 建议：让 `prepare` 带上期望根（或先 `describe` 根），在创建前核对；至少在 mismatch 时删除刚建的目录。测试补断言具体错误码（systemCode 若仍为 UNKNOWN 可接受），并断言错误根下没有落盘。
- 注：这主要是配置错配时的清理/测试精确度问题，不是数据安全洞；`mocks.prepare` 未调用、`controlCalls === ["prepare"]` 能证明流程没进入启动。

## 5. 信息：`--control-root` 变成必填是 CLI 不兼容变更，仓库外启动器与文档未核实

- 文件：`packages/runtime-sandbox/src/job-host-gateway.ts:193-233`、`packages/runtime-sandbox/src/job-host-gateway-main.ts:5-19`
- 问题：`parseJobHostGatewayArgs` 现在缺少 `--control-root` 直接抛 `JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID`；main 在 realpath/目录检查失败时 `process.exit(1)`，不建套接字。仓库里没有生产启动器会传这个参数（grep 只找到测试和 `job-host-gateway-host.mjs`，后者用 `serveJobHostGateway` 不经过 parse）。作者声明“生产暂不接网关”，所以仓库内没有破坏，但**仓库外的启动器和文档**是否同步标「未核实」；commit 也写了 `Docs: deferred (fast mode)`。
- 建议：PR③ 接生产前，确保启动器成对传入 canonical 的 `--control-root`，并在 ADR/运行手册里记下这个必填参数和退出码。

## 6. 已核对、不构成缺陷的点

- 网关路径限制未发现绕过：`job-host-gateway-control.ts:25-33` 用 `path.resolve(directory) === directory`、`path.dirname(directory) === controlRoot`、basename 必须是 `control-[a-f0-9]{20}`，尾斜杠、`..`、`//`、绝对根外都会被拒；`prepare` 的 name 也先过正则。
- 符号链接目录不是绕过：`describeJobHostControlDirectory` 的 `canonical` 用 `realpath` 比较，`directory` 用 `lstat().isDirectory() && !isSymbolicLink()`；`validateJobHostControlBinding` 也要求 `realpath(binding.directory) === binding.directory`。
- 本机路径**不是**逐行等价：`describeDirectory` 比原来多一次 `realpath` 并把 realpath 失败当作 `canonical:false`；worker 在 `mkdir` 后立刻 `lstat` 取 device/inode（原来在 register RPC 之后才取）。作者在第 2 轮已承认，行为更严格，未发现安全性回退。
- `register` 里两次 `describeDirectory` 仍是“先 canonical 再 metadata”，两次调用之间的 TOCTOU 是改动前就有的（旧代码也是先 `realpath` 再 `lstat`），不是本 PR 新增。
- 主服务可用的 `./control` 入口只导出 `JobHostRiskControl`（`blockLaunch/readLaunchDecision/...`，不含 `prepareDirectory/claimLaunch`）；`test/integration/workspace/workspace-boundaries.test.ts:132-146` 的导出清单已更新，边界仍成立。

# 二、读代码证实的 vs 推测

**读代码证实：**
- 网关只对 `query` 传取消信号，`claim/block/prepare/evidence` 不响应断开（finding 1）。
- 客户端 socket error/close 统一映射为 `JOB_HOST_GATEWAY_UNAVAILABLE`，且不带 `code`；因此不会把网关不可用误判成 ENOENT（作者这个设计目标成立）。
- 网关转发 `ENOENT` 等 Linux errno 时会带 `systemCode`，客户端还原成 `.code`。
- 证据读取用 `O_NOFOLLOW` 但没有 `O_NONBLOCK`（finding 2）。
- 新错误码未被 `sandboxReconciliationFailureReason` 识别（finding 3）。
- worker 的不一致检查在创建目录之后（finding 4）。
- 路径限制、名字正则、frame 键名/响应键名两端一致。
- `controlName` 由 sha256 前 20 位小写十六进制组成，符合 `^control-[a-f0-9]{20}$`。
- device/inode 两端都用 `String(lstat.dev/ino)`，`validateContext` 也按字符串比较；`^\d+$` 客户端校验可接受。
- 生产代码没有接 `jobHostAccount`（grep 只命中测试），所以新分支当前不跑在生产。

**推测 / 未核实：**
- finding 1 中“超时后决策已发布、重试卡死”的具体触发概率和后果。
- finding 2 中 FIFO 是否真能被任务进程放到控制目录里（受 SRT allowRead/allowWrite 限制，正常情况下访问不到）。
- 测试实际运行结果、13 条失败是否真的与改动无关（未运行）。
- 仓库外生产启动器是否会传 `--control-root`。

# 三、侧重检查

- **错误路径**：`query`/`evidence` 的 ENOENT 与“网关不可用”已区分；`socket error/close` 一律无 `code`，不会触发 `host_never_started` 误判。`request` 的超时/abort 会清理定时器和监听器，没有明显 FD 泄漏。取消只覆盖 `query`，见 finding 1。
- **不合规范/不可信输入**：控制帧来自主服务（可信度较高），但网关仍校验了 `op`、`name`、`directory`、`command`、`timeoutMs`、`stopRequestedAt`、binding 目录、plan schema；`readGatewayFrames` 有 64MB 上限。未发现可直接越权读取根外路径的输入。
- **安全**：控制根内一层、名字正则、canonical 检查共同限制了路径；`O_NOFOLLOW` 防 symlink 证据文件；签名由调用方再验，网关伪造属已知且作者已论证。未发现新的提权路径。
- **资源耗尽**：`prepare` 可无限建目录（主服务可信）；控制连接没有每连接上限，但 `connections` 会阻止 idle exit 直到关闭；非 `query` 操作没有服务端超时/取消（finding 1）。FIFO 阻塞见 finding 2。
- **不可撤销操作**：`claim`/`block` 会落盘决定，且调用方超时不会阻止落盘（finding 1）。
- **规则/文档一致性**：`prompt-prefix.md` 与本改动无关；作者“本机逐行等价”已由作者自己在第 2 轮修正，代码确认不等价但更严格；“系统错误码原样带回”不完全准确（finding 3）；`--control-root` 必填未在文档中体现（finding 5）。ADR 0234 第 4、11 条与代码不冲突。

# 四、必答问题

## 1. 会不会改变模型已经见过的请求开头？

不会。改动只涉及沙箱控制目录、网关帧、证据读取和 worker/agent-service 的控制路径，没有任何系统提示、工具定义、历史消息、遮盖逻辑或提示词目录的改动（diff 文件清单可证）。发给模型的内容仍然只在末尾追加；每轮会变的值（device/inode、observation 的 `observedAt/sequence`、`stopRequestedAt`、控制目录名等）都只出现在控制帧、诊断或新追加的工具结果里，没有被放进系统提示/工具定义。若这些错误码/诊断文本最终作为工具结果回给模型，那也是**新追加的一条**，属于规则允许的“只在末尾追加”。

依据：`.claude/rules/prompt-prefix.md:27-29`（固定的在前、会变的在后、新情况追加消息）与 `:35`（已发内容只能追加）。本改动没有触碰这些组装点。

## 2. 会不会让同一段文字在不同请求里变成不同字节？

对模型可见内容：不会。本改动不序列化模型文本；控制目录名是 `sha256(JSON.stringify(plan.identity))` 的确定前缀，帧的键顺序由对象字面量固定（`{type:"control", ...}`、`{...value, type:"result", ok:true}`），证据是原样字节转发并由调用方验签，`bindingDigest` 由固定键序对象构造，均不依赖时间/对象遍历顺序。

唯一的“会变的值”是本来就存在的观测时间/序号和文件 device/inode；它们不在请求头、也不参与遮盖。因此没有新增“同一段文字每次变成不同字节”的路径。作者说的“不改发给模型的内容”与代码一致。

## 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，覆盖较全；以下是我**读代码推演**的“去掉实现后测试会失败”：

- 去掉 `controlDirectory` 的根限制：`test/integration/job-host-gateway.test.ts:592-612` 的 `JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT`（含尾斜杠、根外 describe/evidence/block）会失败。
- 去掉客户端验签：`:656-679` 的伪造签名用例会失败（`access.query` 会 resolve）。
- 把网关 socket 缺失误带上 `ENOENT` code：`:676-679` 的 `expect(failure).not.toHaveProperty("code")` 会失败。
- 去掉“调用方断开→中止 Job Host 查询”：`:681-712` 的 `closed === 1` 在 2s 内等不到，会失败。
- 去掉 main 的 canonical/存在性检查：`:490-524` 的退出码 1、无 socket 断言会失败。
- 去掉 worker 的根不一致检查：`sandbox-v2-worker-lifecycle.test.ts:729-735` 的 stage 会变成 `register_preparation_control`，断言失败。
- 本机/网关双跑：`sandbox-control-evidence.test.ts` 有 5 个 `it.each(["local","gateway"])`；`sandbox-preparation-control.test.ts:469-582` 的 R2-L8 和 `:604-675` 的 block 用例也都双跑。

测试缺口（不影响“代码正确”，但影响“测试能否锁住行为”）：
- `prepare` 的服务端名字校验没有被直接测到：`job-host-gateway.test.ts:588` 的 `../control` 先在客户端 `validateJobHostControlDirectoryName` 抛错，不会发到网关。要证明网关自身拒绝，需要一个绕过客户端、直接写原始帧的用例。
- worker 的 mismatch 测试只断言 stage/reason，不断言 `SANDBOX_CONTROL_ROOT_MISMATCH`，也不断言错误根下没有目录；`controlCalls` 里 `"prepare"` 是在调用网关前 push 的（`sandbox-v2-worker-lifecycle.test.ts:663-666`），所以它只证明“调用了”，不证明“创建成功了”。
- 未运行测试，「1305/1318」「每处都做过反向验证」标未核实。

## 4. 新产生/修改的每个值，两端都能接受吗？

逐项核对（读代码）：

- **控制目录名**：worker 生成 `control-` + sha256 前 20 位小写十六进制（`production-sandbox-execution-v2.ts:423`）；网关 `validateJobHostControlDirectoryName` 正则 `^control-[a-f0-9]{20}$` 接受；`controlDirectory` 的 basename 校验也接受。
- **`directory` 路径**：网关 `prepare` 用 `path.join(controlRoot, name)` 返回；worker 用 `path.join(binding.privateRoot, controlName)` 比较（`privateRoot` 在 host 校验中要求 canonical：`sandbox-host-verifier.ts:146-153,246`）；agent-service 的 `sandboxJobControlBindingSchema` 的 `controlDirectory` 要求绝对、无尾斜杠/`//`/`.`/`..`，`path.join` 结果满足；`within(binding.privateRoot, control.directory)` 也成立。
- **`device` / `inode`**：prepare 和 describe 两端都由 `String(lstat.dev/ino)` 产生，客户端 `^\d+$` 接受；`validateContext` 用 `String(directory.dev/ino)` 比较，匹配；agent-service 存储与 `readControl`/`readPreparationControl` 的比较也匹配。本机老的 `String(metadata.dev/ino)` 与新格式一致。
- **帧格式**：五种 op 的请求键（`op/name/directory/binding/command/timeoutMs/action/context/stopRequestedAt`）与网关读取的键一一对应；成功响应的 `encoded`、`directory/device/inode`、`canonical/directory/private/device/inode`、`published/evidence` 与客户端读取一致；失败响应的 `error/systemCode` 与 `gatewayError` 一致。
- **错误码**：Linux errno（ENOENT/EACCES/...）能通过 `^E[A-Z0-9]{1,20}$` 原样带回；`ERR_*` 带下划线的不能（finding 3）。新网关错误码客户端正则 `^[A-Z][A-Z0-9_]{0,79}$` 接受；但 `sandboxReconciliationFailureReason` 不认识它们（finding 3）。
- **`--control-root` 配置键**：`parseJobHostGatewayArgs` 产出、`serveJobHostGateway` 接受、main 使用；但仓库外的启动器是否传入标「未核实」。`serveJobHostGateway` 的 `controlRoot` 仍是可选，测试可用；main 路径必填，符合作者说法。
- **`jobHostAccount`**：仅 worker 新选项，`launcher`/`control` 成对注入；生产未接线（grep 证实），所以没有“生产只配一半”的现存问题；但接口本身不校验两者来自同一个网关/根，这点留给 PR③ 的组合根保证。

**总评**：没有发现可让主服务访问控制根外路径、或把“网关不可用”误判为“没有证据/从未开始”的实现错误；路径和签名校验两端基本对齐。主要值得修的是 finding 1（不可撤销决策的取消/幂等）和 finding 2（证据读取阻塞加固），以及 finding 3 的错误分类与测试精确度。
