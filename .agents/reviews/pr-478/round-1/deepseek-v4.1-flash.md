## 一、发现的问题（按严重度从高到低）

### 1. [中] 新增的 `ProductionSandboxExecutionV2.jobHostAccount` 分支没有任何自动测试
- 文件:行：`apps/execution-worker/src/production-sandbox-execution-v2.ts:134-137`、`:421-425`、`:498-504`、`:815`、`:842`
- 问题：这次给 execution-worker 新增了“经网关建目录 / claim / 读最终证据”的生产代码路径，但仓库里没有任何测试构造 `jobHostAccount`。已有的网关用例都在测 `createProductionSandboxControl` 或直接调 `prepareSandboxJobHost`，没有覆盖 worker 这个新分支。
- 证据：`grep jobHostAccount` 只命中 `production-sandbox-execution-v2.ts` 自身，测试目录零命中；新分支代码为：
  ```ts
  const controlAccess =
    this.options.jobHostAccount?.control ?? localJobHostControlAccess(binding.privateRoot);
  const preparedDirectory = await controlAccess.prepareDirectory(...)
  ```
- 建议：把 `sandbox-v2-worker-lifecycle.test.ts` 的至少一个正常路径和 `[R2-D4] preparation-ack-blocked` 路径参数化成 local/gateway，断言 `prepareDirectory`、`claimLaunch`、`readFinalEvidence` 都走了注入的 access。
- 性质：读代码证实（测试缺失是事实；风险判断属推测）。

### 2. [低] 网关的 `read launch` 和“成功发布 block”没有正向用例，反向验证也就不完整
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-control.ts:84-92`；`test/integration/sandbox-preparation-control.test.ts:540-548`、`:579-582`
- 问题：`[R2-L8]` 先 `claimLaunch`，随后 `stopPreparation` 的 `block` 看到已有 launch 决定会返回 `published:false`，于是 `if (await access.blockLaunch(...))` 为假，后面的 `access.readLaunchDecision` 也不会执行。因此网关的 `op:"launch" action:"read"` 和“block 真正落盘并返回 published:true”这两条路径没有被测试。
- 证据：
  ```ts
  if (action === "read") return { evidence: (await readJobHostLaunchDecision(context)) ?? null };
  if (action === "claim") return { ...(await decideJobHostLaunch(context, { kind: "launch" })) };
  ```
  测试里先 `await access.claimLaunch(...)`，之后才 `stopPreparation`。
- 建议：新增一个未 claim 过的目录，经网关 `blockLaunch` 得到 `true`，再经网关 `readLaunchDecision` 读回并断言签名/stopRequestedAt；另外加一条 context 的 `control.directory` 在 root 外的反向用例（目前只测了 evidence 的越界）。
- 性质：读代码证实（用例未覆盖是事实）。

### 3. [低] 调用方断开只中止 `query`；`prepare`/`claim`/`block`/`evidence` 会在调用方超时后继续执行
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-control.ts:60-71`、`:81-92`；`packages/runtime-sandbox/src/job-host-gateway.ts:124-142`、`:155`
- 问题：`answerControl` 在 socket 关闭时触发 `AbortController`，但只有 `query` 把 `signal` 传进了 `queryJobHostControlBytes`。`claim`/`block` 完全不看 `signal`，所以调用方超时或发第二帧被断开后，网关仍可能把 `launch-decision.json` 写盘。对 `block` 是保守方向；对 `claim` 会留下调用方不知道的“已 claim”事实（调用方可能已按 unknown 处理）。
- 证据：
  ```ts
  return { encoded: await queryJobHostControlBytes(binding(...), command, timeoutMs as number, signal) };
  ...
  if (action === "claim") return { ...(await decideJobHostLaunch(context, { kind: "launch" })) };
  ```
  `decideJobHostLaunch` 的参数里没有 signal。
- 建议：至少在 `claim`/`block` 的发布前后检查 `signal.aborted`；或明确文档化“claim/block 不可取消，靠幂等重试收敛”，并加用例断言断开后的落盘行为。
- 性质：读代码证实；是否可接受取决于产品取舍（推测）。

### 4. [低] `/control` 只是导入边界，不是运行时授权；任何能连网关套接字的人都能发 `prepare`/`claim`
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-control.ts:51-54`、`:81-92`；`packages/runtime-sandbox/src/job-host-control-access.ts:82-86`
- 问题：作者说“主服务只能拿到降低风险的操作”，代码层面只做到“`/control` 入口不导出 prepare/claim 包装”。网关协议本身仍接受 `op:"prepare"` 和 `op:"launch" action:"claim"/"block"`，不区分调用者。如果网关套接字能到达不受信进程，导入边界挡不住它。
- 证据：
  ```ts
  if (op === "prepare") { ... return { ...(await prepareJobHostControlDirectory(controlRoot, name)) }; }
  ...
  if (action === "claim") return { ...(await decideJobHostLaunch(context, { kind: "launch" })) };
  ```
- 建议：把“导入边界”明确说成编译期约束；若确实需要运行时授权，给网关增加按连接的 operation allowlist，或在文档里承认“能连套接字即等价于可 launch/claim”。
- 性质：读代码证实（边界确实是编译期）；威胁是否现实取决于 0600 套接字配置（见“未核实”）。

### 5. [低] `describe` 对尾斜杠 + 符号链接会跟随到 root 外目标；`--control-root` 未做 realpath
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-control.ts:26-30`；`packages/runtime-sandbox/src/job-host-control-access.ts:110-126`；`packages/runtime-sandbox/src/job-host-control.ts:64-67`
- 问题：`controlDirectory` 只用 `path.dirname(directory) === controlRoot` 和 basename 正则。`/root/control-<20hex>/` 能通过（`dirname` 会去掉尾斜杠），而 `lstat("/root/control-.../")` 会跟随该名字上的符号链接；`describeJobHostControlDirectory` 于是可能返回 root 外目标的 `isDirectory/private/dev/ino`。`evidence`/`query`/`launch` 不受影响，因为它们随后会走 `validateJobHostControlBinding` 的 `realpath(directory) === directory` 校验；但 `describe` 本身泄露 root 外目标的元数据（不含内容）。另外 `--control-root` 只校验绝对路径和 `path.resolve` 相等，不 realpath；若根是符号链接，`prepare` 会在链接目标下建目录，而后续 evidence/query 会因 realpath 不相等而全部报 `JOB_HOST_CONTROL_BINDING_INVALID`。
- 证据：
  ```ts
  if (typeof directory !== "string" || path.dirname(directory) !== controlRoot)
    throw new Error("JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT");
  validateJobHostControlDirectoryName(path.basename(directory));
  ```
  ```ts
  const canonical = await realpath(directory).then((resolved) => resolved === directory, () => false);
  ```
  ```ts
  (await realpath(binding.directory)) !== binding.directory
  ```
- 建议：`controlDirectory` 拒绝以分隔符结尾或含空段/`.`/`..` 的路径；启动时对 `controlRoot` 做 `realpath` 并统一使用规范化路径；给 `describe` 加“尾斜杠符号链接”与“符号链接根”的用例。
- 性质：读代码证实（依赖 Node `path.dirname`/`lstat` 语义）；实际能否利用取决于 control root 的写权限（推测）。

### 6. [低] 作者的说法与代码不完全一致：签名验证并非“一律在调用方”，本机路径也不是严格逐行等价
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway-control.ts:84-92`；`packages/runtime-sandbox/src/job-host-control-access.ts:203-214`、`:303`；`packages/runtime-sandbox/src/job-host-control-access.ts:102`
- 问题：
  - `read`/`claim`/`block` 在网关端已经调用 `readJobHostLaunchDecision`/`decideJobHostLaunch` 做过验证，并且由网关生成签名；调用方又验一遍。说“网关只回原始的签名字节或决定证据、验证一律在调用方做”不准确（对 query/evidence 成立，对 launch 决定不成立）。
  - “本机实现改动前逐行等价”不严格成立：worker 里原来的 `lstat(controlDirectory)` 在 `register_preparation_control` 之前，现在 `prepareJobHostControlDirectory` 在 `mkdir` 后立刻 `lstat`（`job-host-control-access.ts:102`），设备号/inode 的采样时机提前；`describeJobHostControlDirectory` 还把 `realpath` 的所有错误吞成 `canonical:false`，旧代码在 `register`/`registerPreparation` 里会原样抛出。安全性上这更严格（目录被替换时会在 claim 阶段失败），但不是“逐行等价”。
- 证据：
  ```ts
  if (action === "read") return { evidence: (await readJobHostLaunchDecision(context)) ?? null };
  if (action === "claim") return { ...(await decideJobHostLaunch(context, { kind: "launch" })) };
  ```
  对比：
  ```ts
  const metadata = await lstat(directory);
  const canonical = await realpath(directory).then((resolved) => resolved === directory, () => false);
  ```
- 建议：把 PR 文字改成“网关对 launch 决定自行验证并签发，调用方再验；query/evidence 由调用方验证”；若确实要求本机行为逐位不变，保留原来 `lstat` 的采样点；否则在 PR 里写明这个更严格的时序变化。
- 性质：读代码证实。

### 7. [未核实]
- “13 条失败改动前同样失败”：本次环境不能运行测试，未核实。
- 生产网关套接字确实 0600、且生产启动处会补 `--control-root`：仓库里没有生产调用 `job-host-gateway-main` 的地方，只有测试；未核实 PR③ 的接线。
- 跨账号真实环境（执行账号 vs 主服务账号）下的 `describe.private`、证据文件 uid 校验：测试里网关是进程内同 uid，跨账号未核实。
- 作者说“相关 50 个测试文件 1318 条中 1305 条通过”：未核实。

---

## 二、侧重检查

- **错误路径 / ENOENT 误判**：查了 `production-sandbox-control.ts:301、368、391、429、806` 五处 `errorCode(...) === "ENOENT"`。网关不可用时客户端 `request` 的失败码是 `JOB_HOST_GATEWAY_UNAVAILABLE`/`JOB_HOST_GATEWAY_CONTROL_TIMEOUT`/`JOB_HOST_GATEWAY_PROTOCOL_INVALID`，都没有 `code`，不会变成 ENOENT；只有网关实际把 `lstat/open/connect` 的 ENOENT 放进 `systemCode` 才会被识别为“没有证据”。这些 ENOENT 都对应文件/套接字确实不存在，方向和本机一致；`ENOTDIR/EACCES/ELOOP` 不会被误当成不存在。结论：没有发现“网关不可用被当成从未开始/已经退出”的路径。
- **本机等价性**：`readPreparationControl` 仍把 `describeDirectory` 的 ENOENT 映射成 `SANDBOX_CONTROL_DIRECTORY_CHANGED`；`register`/`registerPreparation` 仍是“先 canonical 检查、后 query、最后再取一次 metadata 写入”的顺序。差异见问题 6（lstat 时机、realpath 错误吞掉），没有发现校验被放宽。
- **不可信输入 / 路径**：`op`、`name`、`directory`、`command`、`timeoutMs`、`stopRequestedAt` 都有校验；`plan` 走 `sandboxExecutionPlanV2Schema.parse`；全路径只有 `control-<20hex>` 一层，`..`/多段路径会被 `path.dirname` 拒绝。绕过点见问题 5（尾斜杠 + 符号链接只影响 describe）。
- **安全 / 令牌**：控制令牌随每个 query/evidence/launch 帧经过网关；作者把网关和 Job Host 视为同一账号同一信任域，因此“网关能伪造签名”在其模型内不是新增风险。但若网关套接字权限不是 0600，令牌和证据会泄露；未核实创建点。
- **资源耗尽 / 半开连接**：每个控制操作一条短连接，不 fork 子进程；query/evidence 响应上限 16KB；帧上限 64MB 是既有逻辑。`writeGatewayFrame` 会检查 `socket.destroyed || !socket.writable`，失败回调可忽略；`settle` 会清定时器和 abort 监听；网关 `close` 处理会从 `connections` 删除。没有发现写失败/半开导致的明显泄漏。但控制连接没有服务端读超时，空闲连接可阻止 idle exit（与既有 launch 连接相同，非本次新增）。
- **不可撤销操作**：`claim`/`block` 会 `write + fsync + link`；调用方断开不会取消（问题 3）。`block` 是保守方向；`claim` 可能留下调用方未观察到的决定，建议补测试或文档。
- **规则/文档一致性**：`prompt-prefix.md` 的要求没有被本 diff 触碰；文档与代码的不一致见问题 6。

---

## 三、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。这个 diff 只改了 `packages/runtime-sandbox` 的控制/网关代码、`apps/execution-worker` 和 `apps/agent-service` 的沙箱控制接线，以及测试；没有触碰系统提示、工具定义、历史存储、遮盖或提示词目录。发给模型的内容仍由原来的请求组装路径决定，本改动不参与，因此“只在末尾追加、每轮会变的值在最后一条消息”这两条不受影响。新增的 `observedAt`、`device/inode`、`stopRequestedAt` 等只进入控制证据，不进入模型请求。全仓库其他路径未核实。

**2. 同一段文字会不会在不同请求里变成不同字节？**
对模型请求不会：本 diff 不产生模型输入。控制协议内部，`query`/`evidence` 返回的是 Job Host 原始签名字节，网关不重新序列化；`launch` 决定的签名用固定键序的 `JSON.stringify({version,bindingDigest,decision})`，不依赖对象遍历顺序。控制证据里的时间字段每次不同，但那是观测值，不是模型内容。没有发现前后文相关遮盖或无序集合进入模型请求。

**3. 有没有对应的自动检查？反向用例会失败吗？**
有，但不完整：
- `sandbox-control-evidence.test.ts` 五条关键用例和 `[R2-L8]` 都做了 local/gateway 双跑，`job-host-gateway.test.ts` 覆盖了 root 边界、证据转发与调用方验签、取消传递、无 control root、第二帧断开。
- 反向验证：去掉 query/claim 处理或取消传递，确实有对应用例会失败（query 用例、`[R2-L8]` 的 claim、`stops asking...`）。
- 缺口：`op:"launch" action:"read"` 和“block 成功落盘”没有正向用例；`ProductionSandboxExecutionV2.jobHostAccount` 分支没有测试（问题 1、2）。本次环境不能运行测试，实际失败情况未核实。

**4. 每个新值两端都能接受吗？**
逐个核对了主要值，结论是代码层面一致：
- `control-<20hex>`：产生于 `production-sandbox-execution-v2.ts:424`，网关 `validateJobHostControlDirectoryName` 的 `/^control-[a-f0-9]{20}$/` 能接受；测试也用同格式。
- `JobHostControlDirectory{directory,device,inode}`：产生于 `job-host-control-access.ts:95-107`；网关客户端在 `:243-249` 校验绝对路径、basename、数字串；worker 在 `:498-503` 用于 `claimLaunch`，`validateContext` 在 `job-host-launch-decision.ts:49-54` 用 `lstat` 的 `String(dev/ino)` 对比，格式一致。
- `describe` 的 `canonical/directory/private/device/inode`：网关客户端在 `:260-267` 校验布尔和数字串；agent-service 在 `production-sandbox-control.ts:276-282、304-310、899-910、930-963` 按布尔/字符串使用，格式一致。
- `--control-root`：`parseJobHostGatewayArgs` 要求必填、绝对、`path.resolve` 相等；`serveJobHostGateway` 再校验一次；消费端 `controlDirectory` 要求 `path.dirname(directory) === controlRoot`。一致（符号链接根的 caveat 见问题 5）。
- 错误帧 `error/systemCode`：生产端 `jobHost-control-access.ts:149-154` 与网关端 `job-host-gateway-control.ts:107-108` 使用同一套正则；`ENOENT` 等系统码能通过两端，调用方用 `error.code` 识别。
- `JobHostLaunchOutcome{published,evidence}`：网关返回 `published` 布尔和 evidence；客户端 `:227-229` 检查布尔并重新 `verifyJobHostLaunchEvidence`；`launchClaimed/launchBlocked` 的语义与本地一致。
- `readLaunchDecision` 的 `null`/evidence：网关 `:84` 把“无决定”转成 `null`，客户端 `:301-303` 按 `null` 当 `undefined`，其余重新验签；一致。
- `/control` 导出清单：`workspace-boundaries.test.ts:132-146` 已同步加入 `gatewayJobHostRiskControl`、`localJobHostRiskControl`，类型层面只暴露 `JobHostRiskControl`。
唯一需要跨进程保证的是：worker 的 `prepareDirectory` 与 agent-service 的 `describeDirectory` 必须指向同一个 control root/同一文件系统，否则 device/inode 或 `within(binding.privateRoot, ...)` 会不一致；这属于 PR③ 接线约束，当前 diff 没有自动化验证。
