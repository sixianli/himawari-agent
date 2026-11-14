## 总体结论

没有发现「高」严重度问题。网关的路径限制（`controlDirectory`）在当前代码里没有被字符串绕过；证据与 query 的字节由调用方用 HMAC 再验一遍；错误帧把 `ENOENT` 与「网关不可用」分得开。主要问题集中在**配置值两端没有共同来源/启动校验**、**若干测试缺口**，以及少量 TOCTOU/额外往返。测试未实际运行（工具限制），只读代码核对。

---

## 一、读代码证实的问题（按严重度）

### 1. 中：`--control-root` 与 `binding.privateRoot` 是两个独立产生的值，没有一致性校验
- 文件:行：`apps/execution-worker/src/production-sandbox-execution-v2.ts:421-425`；`apps/agent-service/src/production-sandbox-control.ts:876-877`；`packages/runtime-sandbox/src/job-host-gateway-main.ts:6-9`
- 问题：Worker 只把 `name` 交给网关，网关用自己启动参数里的 `controlRoot` 拼接目录；主服务随后用 `binding.privateRoot` 做 `within` 范围检查。两个根必须逐字节相等，但代码里没有任何地方比较它们，也没有共同的配置来源。若部署时网关的 `--control-root` 与 host 绑定的 `privateRoot` 不同（或一个有符号链接、一个没有），所有控制操作会在运行时以 `JOB_HOST_GATEWAY_CONTROL_OUTSIDE_ROOT` / `SANDBOX_CONTROL_SCOPE_INVALID` 失败，而不是启动时直接报错。这正是 I-73 那类「产生处和使用处两端没有一起核对」的问题。
- 证据：
  ```ts
  // execution-v2.ts:421-425
  const controlAccess =
    this.options.jobHostAccount?.control ?? localJobHostControlAccess(binding.privateRoot);
  const preparedDirectory = await controlAccess.prepareDirectory(
    `control-${...}`,
  );
  ```
  ```ts
  // production-sandbox-control.ts:876-877
  !(await access.describeDirectory(control.directory)).canonical ||
  !within(binding.privateRoot, control.directory)
  ```
- 建议：让 `prepareDirectory` 接收并返回「相对于约定根的名字」，由主服务用 `binding.privateRoot` 拼接；或启动时把网关的 `controlRoot` 与 Worker 的 `privateRoot` 做一次显式一致性校验（最好来自同一配置字段），并加一条两端不一致时必须启动失败的测试。

### 2. 低：`controlRoot` 只做词法校验，不检查存在性/realpath；符号链接根会让所有控制操作在运行时失败
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway.ts:34-39`、`:218-224`；`packages/runtime-sandbox/src/job-host-control.ts:64-65`
- 问题：启动只接受 `path.isAbsolute` 且 `path.resolve` 不变的字符串，不检查它是不是目录、是否存在、realpath 是否等于自身。但真正读写时 `validateJobHostControlBinding` 要求 `realpath(binding.directory) === binding.directory`。若 `--control-root` 本身是一个符号链接（例如 `/var/lib/himawari` 指向真实目录），`prepare` 创建出的目录永远过不了后续的 binding 校验，控制功能整体不可用，且错误码是容易误导的 `JOB_HOST_CONTROL_BINDING_INVALID`。当前测试都先 `realpath(root)`，不会暴露这个场景。
- 证据：
  ```ts
  // job-host-gateway.ts:34-39
  if (
    options.controlRoot !== undefined &&
    (!path.isAbsolute(options.controlRoot) ||
      path.resolve(options.controlRoot) !== options.controlRoot)
  )
    throw new Error("JOB_HOST_GATEWAY_CONTROL_ROOT_INVALID");
  ```
  ```ts
  // job-host-control.ts:64-65
  !path.isAbsolute(binding.directory) ||
  (await realpath(binding.directory)) !== binding.directory
  ```
- 建议：启动时对 `controlRoot` 做 `realpath`/`lstat`，要求 realpath 相等且为目录；或统一把配置值解析成 realpath 后再使用。补一条「controlRoot 是符号链接」的启动/端到端测试。

### 3. 低：`register`/`registerPreparation` 对同一目录发起两次 `describeDirectory`，canonical 与 device/inode 不是同一次快照
- 文件:行：`apps/agent-service/src/production-sandbox-control.ts:876`、`:899`；`:931`、`:953`
- 问题：第一次调用只取 `.canonical`，丢弃 device/inode；第二次重新连接网关取 device/inode。两次之间目录若被替换，canonical 校验针对旧 inode，而最终存下的是新 inode，存在 TOCTOU 窗口；网关模式下还多一次 IPC 往返。旧的本机实现也是 `realpath` 后 `lstat` 两次系统调用，因此不是新引入的语义回归，但新接口完全可以在一次 `describe` 中同时拿到这些值。
- 证据：
  ```ts
  // :876 / :899
  !(await access.describeDirectory(control.directory)).canonical || ...
  const metadata = await access.describeDirectory(control.directory);
  ```
- 建议：只调用一次 `describeDirectory`，同时使用 `canonical`、`directory`、`private`、`device`、`inode`；删掉第二次调用。这样也减少网关连接数和超时面。

### 4. 低：调用方断开只中止 `query`；`prepare`/`claim`/`block` 仍可能在调用方放弃后落地
- 文件:行：`packages/runtime-sandbox/src/job-host-gateway.ts:124-141`；`packages/runtime-sandbox/src/job-host-gateway-control.ts:64-75`
- 问题：`aborted` 只通过 `answerJobHostControlFrame` 传给 `queryJobHostControlBytes`。`prepare` 的 mkdir、`launch` 的 `decideJobHostLaunch` 都不接收 signal。客户端超时或断开后，网关仍可能完成并发布 block/claim。block 是降风险操作；claim 落地后 Worker 端已判定失败，重试时 `decide` 返回 `published: false`，`launchClaimed` 为 false，Worker 返回 `result_unknown`。这不会导致重复启动（后续会走 reconciliation），但状态语义是「已放弃的调用仍可能成功」。
- 证据：
  ```ts
  // gateway.ts:124-131
  const answerControl = (frame: Record<string, unknown>) => {
    const aborted = new AbortController();
    socket.once("close", () => aborted.abort());
    ...
    answerJobHostControlFrame(root, frame, aborted.signal)
  ```
  ```ts
  // gateway-control.ts:64-75：只有 query 使用 signal
  await queryJobHostControlBytes(binding, command, timeoutMs, signal)
  ```
- 建议：在 `answerJobHostControlFrame` 的 `launch` 分支、`prepare` 前后检查 `signal.aborted`；`decideJobHostLaunch` 接受可选 signal 并在写临时文件/发布前后检查。若有意允许 block/claim 完成后才断开，至少在注释和测试里写清楚。

### 5. 低：测试缺口——三个关键反向场景没有覆盖
- 文件:行：`packages/runtime-sandbox/src/job-host-control-access.ts:191-192`、`:289`；`test/integration/job-host-gateway.test.ts:607-620`；`packages/runtime-sandbox/scripts/qualify-job-host-gateway-accounts.mjs:9-14`
- 问题：
  1. **query 的验签没有反向用例**。测试只篡改了 `final.json` 的签名（607-620），`access.query` 返回的 `encoded` 是否被调用方验签没有被反向证明；删掉 `:289` 的 `verifyJobHostControlEnvelope` 现有测试仍会通过。
  2. **「网关不可用不能变成 ENOENT」没有用例**。代码正确地丢弃了 socket 的原始 `error`（`:191-192`，统一成无 `code` 的 `JOB_HOST_GATEWAY_UNAVAILABLE`），但正是作者点名担心的路径，值得有一条「socket 不存在/ECONNREFUSED 时上层不把它当无证据」的断言。
  3. **跨账号没有真正跑过**。`job-host-gateway.test.ts` 的控制用例和 Worker 生命周期里的 gateway 用例都是同一进程/同一 uid；以 root 跑、`setpriv` 切 uid 的 `qualify-job-host-gateway-accounts.mjs` 调用 `serveJobHostGateway` 时没有传 `controlRoot`（fixture 第 9-14 行），所以控制帧一律 `JOB_HOST_GATEWAY_CONTROL_UNAVAILABLE`，没有验证「网关账号能建目录、能读证据，主服务账号不能」。
- 建议：增加一个假网关返回未签名/错误签名的 query 响应；增加 ECONNREFUSED/缺失 socket 的映射用例；把 qualification 脚本扩展为先建控制帧通过、再以不同 uid 验证 prepare/query/evidence，并传入 `controlRoot`。

---

## 二、推测 / 未核实

- 「相关 50 个测试文件 1318 条中 1305 条通过」以及「去掉 query/claim/取消传递对应用例失败」均**未实际运行验证**，只是从测试结构推断方向正确。
- `claim`/`block` 在客户端断开后继续执行这一点，从代码看是确定的；但其在真实超时/重试下具体产生多少次 `result_unknown`，以及是否影响既有恢复策略，未做端到端验证。
- 生产环境网关如何拿到 `--control-root`、其与 `binding.privateRoot` 是否真的一致，仓库内没有生产侧启动代码可核对（作者也说明 PR③ 才接生产），标为**未核实**。

---

## 三、侧重检查

**错误路径与错误码**
- 已确认 `gatewayError` 只在 `systemCode` 匹配 `^E[A-Z0-9]{1,20}$` 时挂 `code`（`job-host-control-access.ts:145-155`）；连接层失败统一成无 `code` 的 `JOB_HOST_GATEWAY_UNAVAILABLE`（`:191-192`），不会伪装成 `ENOENT`。
- 已确认服务端只转发系统错误码，非系统错误统一成 `JOB_HOST_GATEWAY_CONTROL_FAILED`（`job-host-gateway-control.ts:102-113`），不会把内部路径/异常文本直接回给主服务。
- `JOB_HOST_CONTROL_TIMEOUT`、`JOB_HOST_CONTROL_TOO_LARGE`、`ABORTED` 这些大写码在网关路径保持原样，现有测试的断言仍能成立。

**不可信/不合规输入**
- 路径全部被限制为 `controlRoot` 直接子级且名字必须是 `control-[a-f0-9]{20}`；`path.resolve(directory) !== directory` 同时挡住了尾斜杠、`.`、`..`、重复斜杠（`job-host-gateway-control.ts:26-35`）。
- `command` 只允许 `inspect|stop`，`timeoutMs` 为 1..30000 的安全整数，`stopRequestedAt` 走 `instant()`，`evidence` 文件名白名单，`launchContext` 至少校验了 `control.directory`（`:49-99`）。其余 launch 字段由 `validateContext` 的 Zod 计划 schema、`validateJobHostControlBinding` 和 device/inode 校验兜底；我核对了 `job-host-launch-decision.ts:38-55`，这些字段不会成为新的文件路径，因此「只校验 `control.directory`、其余交给 `validateContext`」在路径封闭性上足够。唯一需要知道的信任事实是：网关用调用方带来的 token 给决定签名，它是「签名服务」而不是身份认证；这符合作者声明的「网关和 Job Host 同账号，可伪造签名不算新增风险」。

**安全**
- 符号链接：`describe` 用 `lstat` 并返回 `directory=false`；`query/evidence/launch` 走 `validateJobHostControlBinding` 的 `realpath(binding.directory) === binding.directory`；`readJobHostControlEvidenceBytes` 用 `O_NOFOLLOW` 打开证据文件。未发现通过 symlink 读取控制根外路径的路径。
- 硬链接/挂载：目录不能硬链接；bind mount 需要额外权限，且 device/inode 校验会发现替换。未发现普通用户可利用的绕过。
- 网关控制帧接受 `prepare` 和 `claim`，而 R2-S4 只约束了 `./control` 的**导入**。如果未来把主服务账号视为敌对，socket 协议本身没有区分「降风险操作」和「完整操作」；当前同账号信任模型下不构成新增提权，但这是需要写清楚的边界。

**资源耗尽 / 不可撤销操作**
- 控制帧上限 64MB（`job-host-gateway-frames.ts:3`），`launch` 的 `plan` 会进入 Zod parse，最坏是一次 64MB JSON 的内存/CPU 消耗；连接方与 Worker 同账号，风险有限。
- 每个控制操作新建一条连接；`prepare` 可被反复调用创建目录（第二次在正常重试时是 EEXIST），属于同账号可做的资源消耗，未发现跨账号放大。
- `block`、`claim` 是不可撤销的发布；网关路径校验和 context 校验都在发布前完成。`block` 的 `stopRequestedAt` 在客户端和网关两端都校验格式。

**规则文件、说明文档与代码一致性**
- 本 diff 没有改动 `.claude/rules/prompt-prefix.md`、提示词目录、工具定义或模型请求组装代码。
- 作者「默认本机路径行为不变」基本成立，但有一处细节：`readControl`/`readPreparationControl` 现在多了一次被吞掉异常的 `realpath`；`register`/`registerPreparation` 在 realpath 失败时错误码可能从系统错误变成 `SANDBOX_CONTROL_SCOPE_INVALID`。这不是安全回归，但「逐行等价」不准确；作者已在第 2 轮说明中部分承认。
- `job-host-gateway-main` 新增必填 `--control-root`，但仓库里只有测试和资格脚本与它相关；资格脚本直接调用 `serveJobHostGateway` 且没有 `controlRoot`，所以不会因 CLI 校验失败，但也因此没有覆盖控制功能。

---

## 四、逐条回答必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只在 `packages/runtime-sandbox`、`apps/agent-service`、`apps/execution-worker` 的沙箱控制和测试中，没有触碰系统提示、工具定义、历史消息或遮盖实现；也没有把新的每轮变化值插入请求头部。按规则，发给模型的内容仍应按「工具定义 → 系统提示 → 历史 → 最后一条用户消息」排列，且只能追加（`.claude/rules/prompt-prefix.md:27-29`、`:35`）。本轮新增的 `device/inode/canonical/private` 等值只是控制目录元数据和证据搬运，不会进入模型请求开头。**结论：不改变请求开头，仍只在末尾追加。** 但「整条模型请求路径」本次未跨仓库全量核对，标为未核实。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会由本改动引入。网关帧里的 `device/inode`、`canonical/directory/private`、错误码都是稳定的序列化值；`launch` 证据虽然被重新序列化，但调用方验证的是 `bindingDigest` + HMAC，重新计算后与原始决定一致（`job-host-launch-decision.ts:96-128`）。改动没有引入依赖前后文的遮盖、带时间的模型字段或无序集合；JSON 键顺序只影响内部 socket 帧，不影响模型内容。

**3. 有没有对应的自动检查，反向用例会真的失败吗？**
有：`job-host-gateway.test.ts` 新增控制根边界、证据转发与调用方验签、取消传递、无控制根、多帧拒绝；`sandbox-control-evidence.test.ts` 的五条用例分本机/网关；`sandbox-preparation-control.test.ts` 的 [R2-L8] 和新的「未 claim 的 launch 被拦下」分本机/网关；Worker 生命周期加了 gateway normal 和 gateway [R2-D4]。从代码推断：
- 删掉 `path.resolve(directory) !== directory`，尾斜杠用例会失败（`path.dirname('/r/control-x/')` 仍是 `/r`）；
- 删掉 `launchContext` 的 binding 校验，根外 launch 用例会得到别的错误而不是 `OUTSIDE_ROOT`，会失败；
- 删掉取消传递，`stops asking the Job Host when the caller gives up` 会超时失败；
- 删掉 gateway claim，Worker gateway 用例的 `controlCalls` 不会出现 `claim`，会失败。
但仍有第 5 条列出的三个缺口（query 验签反向、网关不可用 vs ENOENT、跨 uid 端到端），这些目前**不会因为对应代码被删而失败**。测试实际执行结果未核实。

**4. 每个产生/修改的值，使用它的人都能接受吗？**
逐个核对结果：
- `control-[a-f0-9]{20}` 目录名：本地 `prepareJobHostControlDirectory`、网关 `controlDirectory`、客户端 `prepareDirectory` 三处都校验同一正则；Worker 生成的就是 20 位小写十六进制，兼容。
- `device/inode` 字符串：本地/网关都返回十进制字符串；客户端校验 `/^\d+$/`；存储后与 `describeDirectory` 的字符串严格比较；两端一致。
- `canonical/directory/private` 布尔：网关返回前校验类型；`readControl`/`readPreparationControl`/`register`/`registerPreparation` 都只读取这几个字段，类型匹配。
- `--control-root` 配置键：`parseJobHostGatewayArgs` 要求必填且词法规范；`job-host-gateway-main` 正确传入；但和 `binding.privateRoot` 没有共同来源/一致性校验——这是第 1 条问题。
- 新导出 `gatewayJobHostRiskControl`、`localJobHostRiskControl`：`./control` 入口和 `workspace-boundaries.test.ts` 的导出清单已同步；`JobHostRiskControl` 不包含 `prepareDirectory`/`claimLaunch`，符合 R2-S4 的导入边界。
- 网关帧字段 `op/name/directory/binding/context/command/timeoutMs/action/stopRequestedAt`：服务端逐项校验；响应字段 `encoded/evidence/published/device/inode/...` 客户端逐项校验；未发现两端规则不一致。
- 错误码 `OUTSIDE_ROOT/UNAVAILABLE/INVALID/FAILED/TIMEOUT/ABORTED`：仅作为消息/协议码使用，没有下游 schema 要求它们属于某个白名单；调用方只特殊处理 `ENOENT`，不会被新错误码误判。

**总结**：路径限制、签名再验、错误码分流本身是正确的；上线前最值得补的是第 1 条的配置一致性校验和第 5 条的三个测试缺口。
