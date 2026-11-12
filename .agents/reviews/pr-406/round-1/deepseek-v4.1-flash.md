## 结论概览

改动主体是忠实搬运：单人外壳与 `startTenantRuntime` 的拆分、Unix 套接字选项、读线程预算注入、Pi 池注入、`ensureStarted` 接口，基本都在 diff 里能对上。**没有发现会让单人主路径启动/停止/退出码发生直接回归的硬错误**；较值得注意的是读线程预算只限制“额外线程”、Unix 套接字路径可导致对任意父目录 `chmod 0700`，以及若干反向用例缺口。

---

## 读代码证实的问题（按严重度）

### 1. [中] 读线程预算没有计入每个仓库的初始读线程，达不到“总上限”的语义

- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:275`、`:719`、`:704`
- 问题：`SqliteReadThreadBudget` 只在启动“额外”读线程时获取，初始读线程无条件创建；关闭时也只归还 `extraReadThreads`。因此 N 个租户共享一个预算时，实际读线程数至少是 N（基础线程）+ 预算数，而不是预算值本身。作者材料称“读线程上限”，ADR 0234 也把目标写成“全程序总上限”，两者与实现不一致。
- 证据：

```ts
// :275 初始读线程，未经过 tryAcquire
const readContext = await startReadContext().catch(async (error) => {
  await context.close();
  throw error;
});

// :719 只有“加额外线程”这一支才获取预算
if (
  chosen.pendingCount > 0 &&
  !this.closed &&
  this.readContexts.length + this.readStarts.size < READ_WORKER_COUNT &&
  (this.readThreadBudget?.tryAcquire() ?? true)
) {

// :704 只归还额外线程
for (; this.extraReadThreads > 0; this.extraReadThreads -= 1)
  this.readThreadBudget?.release();
```

- 建议：要么在 `open()` 创建初始 `readContext` 时也 `tryAcquire()`（失败则拒绝打开或按约定处理），要么把接口改名为“额外读线程预算”并在类型/文档里写明基础线程不受限；补一个“两个仓库共享一个预算”的测试，断言总线程数不超过预算。

### 2. [中] `listenUnixSocketPath` 允许任意绝对路径，公共辅助函数会对已存在的父目录 `chmod 0700`

- 文件:行：`packages/platform-node/src/authenticated-uds-transport.ts:202`、`apps/agent-service/src/production-http-composition.ts:713`、`apps/agent-service/src/service-main.ts:2683`
- 问题：`prepareUnixSocketPath` 无条件 `mkdir` 并 `chmod` 父目录；调用方只检查“绝对、已 normalize、长度不超限”，不检查是否位于租户目录、是否指向 `/`、父目录是否属于当前进程或是否为符号链接。`listenUnixSocketPath: "/web.sock"` 会尝试把 `/` 改成 0700；父目录是符号链接时会改到链接目标。这是不可撤销的权限变更。该辅助函数还从包入口导出，本身不校验绝对路径，传相对路径会 `chmod` 当前工作目录。
- 证据：

```ts
// authenticated-uds-transport.ts:201-203
assertUnixSocketPathLength(socketPath);
await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
await chmod(path.dirname(socketPath), 0o700);

// production-http-composition.ts:713-716
if (unixSocketPath !== undefined) {
  if (!path.isAbsolute(unixSocketPath) || path.normalize(unixSocketPath) !== unixSocketPath)
    compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
  assertUnixSocketPathLength(unixSocketPath);
}
```

- 建议：在 `startTenantRuntime`/HTTP 组合层要求套接字路径位于该租户的专用目录下（例如 `stateRoot` 下），拒绝 `/`、拒绝父目录为符号链接，校验父目录属主；只对“本次新建”的目录设置权限，避免对已有目录无条件 `chmod`。为 `/web.sock`、相对路径、符号链接父目录补反向用例。

### 3. [低-中] 新增校验分支和“关闭时正在启动”路径没有自动反向用例

- 文件:行：`apps/agent-service/src/production-http-composition.ts:713`、`apps/agent-service/test/production-http-composition.unit.test.ts:1325`、`test/integration/sqlite-product-state.test.ts:390`
- 问题：新增的“绝对路径且已 normalize”拒绝分支没有测试，删除该分支不会有测试失败；读线程预算只测了正常关闭，作者特别要求核对的“关闭时正在启动”没有用例；生产 HTTP 关闭时“套接字被替换”也没有直接用例（只有 `AuthenticatedUdsServer` 的旧用例间接覆盖辅助函数）。
- 证据：新增测试只覆盖超长路径和正常监听/关闭：

```ts
it("[MU-A] rejects a unix socket path over the platform limit before binding", async () => {
  const socketPath = path.join(tmpdir(), "x".repeat(120), "web.sock");
  ...
  await expect(create()).rejects.toThrow(/exceeds/u);
});
```

- 建议：补 `listenUnixSocketPath` 非绝对、含 `..`/`//`、尾斜杠的拒绝用例；补“`startReadContext` 未完成时 close，预算被归还且不泄漏”的集成用例；补生产 HTTP 关闭前替换套接字文件、确认不删除替换文件的用例。

### 4. [低] 注入的预算 `release()` 抛错会跳过后面的 `lock.release()`，可能永久占用 state root 锁

- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:703`
- 问题：`close()` 的 `finally` 中先循环调用外部注入的 `readThreadBudget.release()`，再 `await this.lock.release()`。如果注入对象的 `release()` 抛错，`lock.release()` 不会执行，后续同一 state root 的启动会一直报锁被占用。预算对象来自外部注入，属于不完全可信的输入。
- 证据：

```ts
} finally {
  for (; this.extraReadThreads > 0; this.extraReadThreads -= 1)
    this.readThreadBudget?.release();
  await this.lock.release();
}
```

- 建议：把预算归还包在独立 `try/catch` 中（或放在 `lock.release()` 之后的最后一层 `finally`），确保锁一定释放；必要时把预算释放失败作为聚合错误上报。

### 5. [低] `STOP_TIMEOUT` 只放在错误消息里，没有 `code` 字段；超时也不取消底层关闭

- 文件:行：`apps/agent-service/src/service-main.ts:2921`
- 问题：新公开的 `TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT` 被放进 `new Error(...)` 的 message，但错误对象没有 `.code`。调用方若按仓库常见的 `error.code` 约定匹配会失败，只能比字符串。另一个语义问题是超时后 `lifecycle.shutdown()` 仍在继续，句柄仍可能持有监听套接字/数据库，调用方若立刻在同一路径启动新运行时，可能遇到“套接字仍在使用”。
- 证据：

```ts
timer = setTimeout(
  () => reject(new Error(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT)),
  timeoutMs,
);
...
return Promise.race([shutdown, deadline]).finally(() => clearTimeout(timer));
```

- 建议：给错误对象加 `code` 字段；在接口文档里写明“超时只放弃等待，不中断关闭”，或让调用方在超时后等待 `stop()` 原 Promise 收尾再复用路径。

### 6. [低] 句柄身份值只回显输入，没有和配置做一致性校验；`listenPath` 也没有采用实际监听结果

- 文件:行：`apps/agent-service/src/service-main.ts:2911`、`:2819`、`:597`
- 问题：`tenantId` 直接返回 `input.tenantId`，没有校验它等于 `configuration.ownerId`；`listenPath` 直接使用 `input.listen.path`，而不是 `http.listen()` 的返回值。当前单人外壳传入的值是一致的，生产 HTTP 也返回同一路径，所以现在不出错；但这是多租户身份/路由值的产生端和使用端之间缺少校验，未来调用方传错会得到一个“标签正确、实际运行时属于别人”的句柄。
- 证据：

```ts
// runAgentService 里传入的是 ownerId
tenantId: magpieModels.configuration.ownerId,
...
// handle 返回的是 input.tenantId
return Object.freeze({
  tenantId: input.tenantId,
  listenPath: boundListenPath,
...
// boundListenPath 直接回显输入
if (input.listen?.kind === "unix") {
  boundListenPath = input.listen.path;
}
```

- 建议：`tenantId` 由 `configuration.ownerId` 派生，或断言二者一致；`listenPath`/`listenPort` 尽量以 `http.listen()`/`server.address()` 的实际结果为准。

### 7. [低] 新合同测试在断言失败时可能留下子进程，拖住测试进程

- 文件:行：`packages/platform-node/test/unix-socket-listen.contract.test.ts:57`
- 问题：测试先 `spawn` 子进程，再断言活套接字被拒绝，最后才 `child.kill("SIGKILL")`。如果第一个断言失败，子进程不会被清理；`afterEach` 只关闭 `servers` 和删除目录，不杀子进程，可能导致 Vitest 挂住。
- 证据：

```ts
const child = spawn(process.execPath, [...], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise((resolve) => child.stdout.once("data", resolve));
await expect(prepareUnixSocketPath(socketPath)).rejects.toMatchObject({
  message: AUTHENTICATED_UDS_ERROR_CODES.SOCKET_EXISTS,
});
...
child.kill("SIGKILL");
```

- 建议：用 `try/finally` 确保 `child.kill()`，或在 `afterEach` 里统一清理所有 spawn 的子进程。

---

## 推测 / 未核实

- **未运行任何测试或 `npm run check:prompt-prefix`**：环境只允许读和 git 命令，所以“测试会通过/反向用例会真的失败”是按代码推理，不是实测。
- **多租户下 Unix 套接字路径的跨租户风险目前仍是推测**：本 PR 的单人外壳不传 `listen`，现有生产路径不会走到 Unix 套接字；但如果后续把租户目录/名字拼进 `listenUnixSocketPath`，同 uid 下“删除别人的陈旧套接字、改别人目录权限”的风险才会实际出现。
- **`prepareUnixSocketPath` 的“检查后 unlink”存在 TOCTOU**：`lstat` 比较 dev/ino 后再 `unlink`，中间路径可被替换。这个逻辑是从旧 `AuthenticatedUdsServer` 原样搬来的，不是本 PR 新引入，我未进一步验证攻击面。
- **`AuthenticatedUdsServer` 行为是否逐字节不变**：结构上等价（新 `start()` 仍先 `mkdir/chmod`，再调用同一段旧逻辑），但我没有运行该包的旧/新对照测试，标“未核实”。

---

## 侧重检查

- **错误路径**：`startTenantRuntime` 启动失败时 `lifecycle.shutdown()` 后抛错，外层 `runAgentService` 再写 `service.failed`，与旧代码顺序一致（`service-main.ts:2933`、`:622`）；`stop(timeoutMs)` 的超时只放弃等待，底层关闭继续；授权丢失通过 `authorityLoss.then` 注册，晚注册也能收到（`:2929`）。未发现漏掉一个停止步骤。
- **不合规范/不可信输入**：Unix 套接字路径只做了绝对、normalize、长度校验，没有目录归属/路径包含校验；`readThreadBudget` 对象没有运行时校验；`tenantId` 未与配置核对。详见问题 1、2、6。
- **安全**：套接字文件 0600、目录 0700、检查 uid、拒绝活套接字、关闭时比较 dev/ino 不删除替换文件，这些都在；风险集中在“对任意父目录 `chmod 0700`”和“同一 uid 下的多租户隔离不足”。详见问题 2。
- **资源耗尽**：两个定时器已纳入 `runtimeTimers` 并在停止时 `clearTimeout/clearInterval`；读线程预算的“额外线程”获取/释放在启动失败、关闭时正在启动、正常关闭三种路径上成对；但基础读线程不计预算，且 `release()` 抛错会跳过锁释放。详见问题 1、4。
- **不可撤销操作**：陈旧套接字 `unlink` 有类型、属主、存活检查和 dev/ino 复核；父目录 `chmod` 没有等价防护。
- **规则和文档一致性**：`.claude/rules/prompt-prefix.md` 未被改动；本改动不触碰提示词、工具定义、历史、遮盖。ADR 0234 的“全程序读线程总上限”与当前“只限制额外线程”不完全一致。

---

## 作者说法核对

- 第 1 条：**属实**。`startTenantRuntime` 返回 `{tenantId, listenPath, listenPort, health, stop, onAuthorityLost}`；启动失败在内部 `lifecycle.shutdown()` 后抛错；单人外壳写 `service.failed` 返回 1。
- 第 2 条：**属实**。`listenUnixSocketPath`、辅助函数抽取、`AuthenticatedUdsServer` 行为结构上不变；但公共辅助函数本身缺少绝对路径/目录归属校验（问题 2）。
- 第 3 条：**部分属实**。Pi 池注入、不传时行为不变属实；读线程预算实际只限制“额外读线程”，不是作者字面所称的“读线程上限”（问题 1）。
- 第 4 条：**属实**。`ensureStarted()` 在读取执行进程握手文件之前调用，单人外壳不传。
- 第 5 条：**属实**。产物清理和命令静默检查两个定时器已纳入统一清理。
- 第 6 条：**属实**。组装逻辑仍在 `service-main.ts`。
- “现有测试不改一行”：**字面上不成立**，两个现有测试文件修改了 import 并追加了用例；但原有断言没有被改动，作为“现有断言未改”理解属实。
- “单人路径行为不变”：**基本属实**，唯一有意变化是定时器在停止时被清理（这本身是修复）。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   **不会。** 本次 diff 只改服务编排、Unix 套接字、SQLite 读线程预算和测试；没有触碰系统提示、工具定义、历史、遮盖或模型请求序列化。发给模型的内容仍然只在末尾追加，每轮变化的时间/记忆/资料仍在最后一条用户消息里。依据是 diff 范围，而不是我运行了 `check:prompt-prefix`（未运行，标“未核实”）。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   **不会。** 没有新增依赖前后文的遮盖、时间字段或无序集合；新增的 `listenPath`、`tenantId`、读线程预算只影响内部编排和日志，不进入模型请求。读线程预算只改变查询并发，不改变单条查询的返回顺序或序列化格式。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   **有新增检查**：Unix 套接字监听/重启/超长路径、读线程预算上限与归还、`ensureStarted` 调用顺序、句柄幂等停止、授权丢失通知、超时停止、定时器清零。按代码推理，去掉对应实现后多数用例会失败。但有三处缺口：`listenUnixSocketPath` 的“非绝对/未 normalize”拒绝分支没有反向用例；读线程“关闭时正在启动”没有用例；生产 HTTP 关闭时“套接字被替换”没有直接用例。且我无法运行测试，实际是否会失败标“未核实”。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `listenUnixSocketPath`：产生于租户监听输入，HTTP 组合层校验绝对/normalize/长度，`prepareUnixSocketPath` 再校验长度并处理旧套接字，`app.listen` 接受字符串路径——格式上两端兼容；但缺少路径归属/包含校验（问题 2）。
   - `readThreadBudget`：`SqliteProductStateRepository.open` 接受该接口并传给实例，额外线程获取/关闭归还成对；但基础线程不计入预算，且 `release()` 抛错会跳过锁释放（问题 1、4）。
   - `listenPath`：写入 `service.ready` 和句柄，现有日志消费者只读 `listenPort`，新字段不会破坏它们；值来自输入而非实际监听结果（问题 6）。
   - `tenantId`：作为句柄身份回显，未与 `configuration.ownerId` 核对（问题 6）。
   - `TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT`：只在错误 message 中使用，没有 `.code` 字段，按错误码匹配的调用方不能直接接受（问题 5）。
   - `SqliteReadThreadBudget` 类型和 Unix 辅助函数都通过包入口导出，编译端可接受；运行时校验薄弱处已在问题 2、4 说明。
