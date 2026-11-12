# 复核报告：多人块 1 任务 A（PR 406，a4d82f6）

## 侧重检查

我按「最普通的使用流程」从入口走到结束（单人、TCP 模式）：

1. `runAgentService` 外壳（service-main.ts:577-632）：解析参数 → 读配置 → 展开 Magpie → `startTenantRuntime` → 等信号/授权丢失 → `service.draining` → `stop()` → `service.stopped` → 返回 0/1。
2. `startTenantRuntime`（service-main.ts:634-2937）：lifecycle 注册（706-803）→ repository.open（850-856）→ `ensureStarted`（982）→ 读 worker token（983）→ boot binding（984）→ 连接 worker → 沙箱服务 → 两个定时器（1068-1078、1199-1206）→ http 组合（2683 起）→ listen（2818-2826）→ `service.ready`（2870-2909）→ 返回 handle（2911-2932）；失败时 catch 里 `lifecycle.shutdown()` 后重抛（2933-2936）。

结论（读代码证实）：逐段与旧代码对齐，没有漏搬监听或停止步骤；退出码（信号 0、授权丢失/失败 1）与旧一致，现有测试仍逐条断言（service-orchestration.unit.test.ts:440-1140 共 20 余处 `expect(await exit)`）。这条流程上没有测试覆盖的代码路径：① seal 失败后套接字文件残留（见问题 2）；② `stop(timeoutMs)` 超时后 shutdown 最终完成或失败的收尾；③ shutdown 抛 AggregateError 时 `service.failed` 的日志顺序（旧代码同路径，非本次引入）。「[PG-12] 老失败与本改动无关」未核实（不能运行测试）。

## 按严重度排列的问题

**1. 中** · packages/platform-node/src/authenticated-uds-transport.ts:202-203
问题：`prepareUnixSocketPath` 无条件 `mkdir(recursive, 0700)` 后再 `chmod(父目录, 0o700)`。unix 套接字路径（`listenUnixSocketPath`）是配置项，若指向一个已存在且被其他进程共享的目录（例如配置成 `/tmp/web.sock` 会把 `/tmp` 改成 0700），会改变整个目录的权限、影响同机其他进程。原 `AuthenticatedUdsServer` 的目录是本服务专用的 `runtimeDirectory`，没有这个暴露面；抽成共用函数并被任意配置路径使用后，风险新出现。两端校验（production-http-composition.ts:711-716）只查绝对路径、规范化和长度，不要求路径落在服务自建的专用子目录里。
证据：202-203 行 `await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 }); await chmod(path.dirname(socketPath), 0o700);`。
建议：要么拒绝父目录不是本服务刚创建的路径，要么只对本次新建的目录设 0700（已存在目录不动权限）。

**2. 中（低概率）** · apps/agent-service/src/production-http-composition.ts:1235-1236、1243
问题：`app.listen({path})` 成功后、`sealUnixSocket` 的 chmod/lstat 完成前若失败（或进程在此间隙崩溃），套接字文件残留；`close()` 里 `unixSocketIdentity !== undefined`（1243）不成立就跳过删除。残留的是一个「活套接字」，同 UID 的下一次启动会被 `prepareUnixSocketPath` 的 `socketAcceptsConnections` 检查以 SOCKET_EXISTS 拒绝，起不来。目录 0700 缓解了跨用户访问，但同用户场景仍在。
证据：1235-1236 `await app.listen({ path: unixSocketPath }); unixSocketIdentity = await sealUnixSocket(unixSocketPath);`；1243 `if (unixSocketPath !== undefined && unixSocketIdentity !== undefined)`。
建议：seal 失败时在 listen 内部清理；或 unix 模式下 close 无条件尝试删除（删除前按 identity 比对已经足够安全，identity 缺失时可退化为「不是活套接字才删」）。

**3. 低** · apps/agent-service/src/service-main.ts:2916-2927
问题：`stop(timeoutMs)` 超时返回后 shutdown 仍在后台继续；之后再调 `stop()` 拿到的是不带期限的同一个 shutdown promise，永远等不到超时保护。`timeoutMs <= 0` 时会立即超时，即使 shutdown 马上就能完成。测试只覆盖「永不完成」一种（service-orchestration.unit.test.ts:1267-1278）。
证据：`stopping ??= lifecycle.shutdown(); … Promise.race([shutdown, deadline])`。
建议：把超时包装与 shutdown promise 一并缓存，或文档写明「仅首次 stop 的超时生效」。

**4. 低** · apps/agent-service/src/service-main.ts:2929-2931
问题：`onAuthorityLost` 的 handler 若抛错，`void authorityLoss.then(() => handler(...))` 没有 catch，成为未处理 rejection，可能按进程策略直接崩掉服务。外壳自带的 handler 只是 resolve，不受影响；风险在未来多人调用方。
证据：`void authorityLoss.then(() => handler(authorityLossError));`。
建议：包一层 try/catch 并写诊断日志。

**5. 低（说法核对）** · 作者说法「现有测试不改一行」不完全准确
证据：`git diff` 显示 apps/agent-service/test/service-orchestration.unit.test.ts:1-10 和 test/production-http-composition.unit.test.ts:1-6 的 import 行被修改（新增 `startTenantRuntime`、`lstat` 等，2 处删除行）。现有测试正文未改。
建议：无实质影响，说法改为「未改现有用例正文」即可。

读代码证实但没有发现问题的核对项（作者请特别核对的三项）：Unix 套接字旧文件/被替换/关闭顺序与 `AuthenticatedUdsServer` 原逻辑逐行等价（diff 为机械抽取，errorCodes 透传）；读线程预算在启动失败（product-state-repository.ts:739 release）、关闭时正在启动（732-734 release）、关闭（703-706 补 release）三条路径都成对，且 `close()` 先 `await Promise.all(this.readStarts)`（700）再释放，无丢失窗口；单人外壳退出码、日志顺序、授权丢失行为与旧版一致（上面侧重检查已列证据）。

## 必答问题

1. **不会改变模型已见过的请求开头（读代码证实）。** 改动文件清单（git diff --stat）只有 service-main.ts、production-http-composition.ts、authenticated-uds-transport.ts、product-state-repository.ts 和 4 个测试文件；提示组装相关的 packages/runtime-pi、packages/prompt-catalog、packages/application 一行未动。单人外壳不传 `listen`/`shared`/`executionWorker`，所有新分支都是关闭的（service-main.ts:853-856 仅在 `readThreadBudget` 存在时展开、1085-1086 判空返回、982 可选调用、2683 仅 unix 时传选项）。发给模型的内容仍然只在末尾追加、每轮变化值仍在最后一条消息——因为这条链路本身未被触碰。`check:prompt-prefix` 我不能运行（工具受限），「通过」属推测；脚本存在（package.json:57），规则文件描述的检查逻辑未受影响。

2. **不会（读代码证实）。** 本次新增的值都不进入模型请求：`listenPath`/`listenPort` 只出现在 stdout 诊断日志（service-main.ts:2879-2880）和 handle 字段；遮盖、序列化、历史存储代码未改动；没有新增带时间或依赖前后文的字段。

3. **有，反向用例按断言结构会真失败（读代码推断，未实际运行）。** 套接字：platform-node 契约测试（unix-socket-listen.contract.test.ts，活套接字拒启、超长路径、非套接字文件、残留清理）+ composition 两条 [MU-A]（路径超限断言 `/exceeds/`，不实现校验则失败）+ orchestration 六条（unix/tcp 接线、关闭、资源释放）。预算注入：test/integration/sqlite-product-state.test.ts [MU-A] 的 `expect(peak).toBe(1)` 是反向断言——仓储不接预算时永不去取，peak 停在 0，必失败；`held` 回零断言守释放配对。定时器清理：service-orchestration.unit.test.ts:1286 `expect(vi.getTimerCount()).toBe(0)`，不清理则每轮留 2 个 fake timer，3 轮后必失败。stop 超时、启动失败释放、ensureStarted 顺序均有专门用例。

4. **逐值核对通过（读代码证实），除问题 1/2 的边缘外无两端校验缺口。** ① `SqliteReadThreadBudget`：产生于 packages/persistence-sqlite/src/product-state-repository.ts:113-117/129，消费于 :284-286（open）、:719-746（取/还）、:703-706（close 补还）；契约只有 `tryAcquire/release`，service-main.ts:853-856 仅转发，两端一致。② 共享 Pi 池：service-main.ts:1085-1086 返回 `sharedPool.prepare`——池的 prepare 是闭包、不依赖 `this`（packages/runtime-pi/src/pi-file-preparation-pool.ts:116），绑定安全；共享池不进本运行时的 lifecycle close（:742 只关本地池），所有权归注入方，测试断言 `shared.close` 未被调用。③ `listenUnixSocketPath`：service-main.ts:2683 产生 → production-http-composition.ts:711-716 校验（非绝对/未规范化抛 CONFIGURATION_INCOMPLETE，超长抛 TypeError）、1234-1238 使用，两端都有校验；注：unix 模式下配置里的 `listenHost/listenPort` 被静默忽略，无提示，低风险。④ `TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT`：573-575 定义、2923 使用、测试消费，纯增量。⑤ `service.ready` 新增 `listenPath` 字段：纯日志字段，无消费者做校验。
