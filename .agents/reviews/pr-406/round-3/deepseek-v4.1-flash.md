## 读代码证实的问题

### 1.【中】`release()` 抛错会跳过刚启动的读线程的 `close()`，读线程泄漏
- 文件：`packages/persistence-sqlite/src/product-state-repository.ts:734-749`
- 问题：`startReadContext()` 已经成功返回 `started`，此时若仓库已关闭，代码先调用 `release()`，再 `return started.close()`。`release()` 一旦抛错，`started.close()` 不会执行；异常又被外层 `.catch(() => undefined)` 吞掉，读线程/连接泄漏。作者说这是“已知并接受”的第 2 轮意见 3 后半，**读代码确认该路径仍然成立**。
- 证据：
```ts
736:          (started) => {
737:            if (this.closed) {
738:              release();
739:              return started.close();
740:            }
...
746:        .catch(() => undefined)
```
- 建议：保证 `close()` 一定执行，例如
```ts
if (this.closed) {
  try { await started.close(); } finally { release(); }
  return;
}
```
或 `return started.close().finally(release)`。

### 2.【中】`close()` 归还预算时一个 `release()` 抛错会中止后续归还，且计数不递减
- 文件：`packages/persistence-sqlite/src/product-state-repository.ts:706-711`
- 问题：`this.extraReadThreads -= 1` 写在 `for` 的更新表达式里，循环体 `release()` 抛错时递减不会执行，循环立即中止，剩余线程预算不再归还；`closed` 已置为 `true`，再调用 `close()` 会直接返回，无法重试。锁确实释放了（作者这一半说法成立），但共享预算可能被永久占用，影响其他租户。
- 证据：
```ts
706:      try {
707:        for (; this.extraReadThreads > 0; this.extraReadThreads -= 1)
708:          this.extraReadThreadBudget?.release();
709:      } finally {
710:        await this.lock.release();
711:      }
```
- 建议：每次归还放进 `try/finally` 保证递减，并继续归还剩余预算；收集各次错误，最后再抛 `AggregateError`。对应测试 `test/integration/sqlite-product-state.test.ts:455` 只断言 `close()` 抛错和能重新打开，未检查 `release()` 被调用次数或计数清零。

### 3.【低】`app.close()` 抛错时套接字文件不会被删除
- 文件：`apps/agent-service/src/production-http-composition.ts:1246-1256`
- 问题：`close()` 先 `await app.close()`，再比较 inode 并删除套接字。若服务器关闭抛错，删除逻辑被跳过，套接字文件残留。下次启动的 `prepareUnixSocketPath` 会把它当陈旧套接字清理，因此影响有限。
- 证据：
```ts
1246:    close: async () => {
1247:      searchIndexer.stop();
1248:      await app.close();
1249:      if (unixSocketPath !== undefined && unixSocketIdentity !== undefined) {
...
1253:        if (current && current.dev === identity.dev && current.ino === identity.ino)
1254:          await removeUnixSocketFile(unixSocketPath);
```
- 建议：把“关闭服务器”和“按 identity 删除套接字”放进 `try/finally`，删除失败也不要掩盖原始关闭错误。

### 4.【低】`STOP_TIMEOUT` 新增的 `code` 没有反向用例
- 文件：`apps/agent-service/src/service-main.ts:2921-2932`；测试 `apps/agent-service/test/service-orchestration.unit.test.ts:1277`
- 问题：测试只写 `rejects.toThrow(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT)`，匹配的是错误 message；把 `Object.assign(..., { code })` 删掉测试仍然通过，不能防住 `.code` 回退。
- 证据：
```ts
2924:              reject(
2925:                Object.assign(new Error(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT), {
2926:                  code: TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT,
```
```ts
1277:    const outcome = expect(stopping).rejects.toThrow(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT);
```
- 建议：改为捕获错误后断言 `error.code === TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT`，或 `rejects.toMatchObject({ code: ... })`。

### 5.【低】`onAuthorityLost` handler 抛错写诊断的路径没有测试
- 文件：`apps/agent-service/src/service-main.ts:2934-2945`
- 问题：代码已捕获 handler 异常并写 `authority.lost_handler_failed`，但现有测试只注册不抛错的 `vi.fn()`，没有覆盖“抛错后进程不崩且诊断出现”。
- 证据：
```ts
2934:      onAuthorityLost: (handler: (error: unknown) => void) => {
2935:        void authorityLoss.then(() => {
2936:          try {
2937:            handler(authorityLossError);
2938:          } catch (error) {
2939:            writeServiceDiagnostic(errorOutput, {
...
2941:              event: "authority.lost_handler_failed",
```
- 建议：新增用例，让 handler 抛错，断言 `errors` 中出现该事件且不会产生未处理拒绝/进程退出。

### 6.【低】seal 失败清理套接字没有测试
- 文件：`apps/agent-service/src/production-http-composition.ts:1236-1242`
- 问题：新增了 seal 失败时 `app.close()` + `removeUnixSocketFile()` 的清理，但仓库里没有任何测试让 `sealUnixSocket` 失败；`grep sealUnixSocket` 只命中正常路径测试。把清理代码删掉，现有测试仍会通过。
- 证据：
```ts
1236:      try {
1237:        unixSocketIdentity = await sealUnixSocket(unixSocketPath);
1238:      } catch (error) {
1239:        await app.close().catch(() => undefined);
1240:        await removeUnixSocketFile(unixSocketPath).catch(() => undefined);
1241:        throw error;
1242:      }
```
- 建议：用可注入的 seal 步骤或 mock `sealUnixSocket` 使其抛错，断言 `listen()` 拒绝、套接字文件不存在、后续 `close()` 不二次出错。

## 推测 / 未核实

- 【低，推测】`adoptExistingDirectory: false` 只对最终目录做 `lstat`，未检查父目录，也未使用 `openat`/`O_NOFOLLOW`；在校验与实际 `listen()` 之间存在 TOCTOU。若父目录可被他人改写，仍可能替换目录或套接字。证据：`packages/platform-node/src/authenticated-uds-transport.ts:211-236`。实际生产 state root 通常由服务独占，风险取决于部署方式。
- 【低，推测】`startTenantRuntime` 在 `webEnabled === false` 时会忽略 `input.listen.kind === "unix"`，既不校验路径也不报告 `listenPath`（`apps/agent-service/src/service-main.ts:2819-2826`）。调用方若误以为已请求 UDS，会静默退回无网页监听。未找到实际调用方，未核实是否为预期契约。
- 【低，既有问题，非本次引入】`AuthenticatedUdsServer.start()` 在 `server.listen()` 成功后才把 `this.server = server`，若 `sealUnixSocket()` 抛错，服务器仍在监听但 `stop()` 会因 `this.server === null` 直接返回，套接字也不会清理（`packages/platform-node/src/authenticated-uds-transport.ts:315-330`）。本次把 seal 抽成公共函数并只给网页服务加了清理，未同步修这里。
- 未核实：受工具限制没有运行任何测试；作者“相关测试通过”的说法未独立验证。

## 侧重检查

- 不可信/不合规范路径：`prepareUnixSocketPath` 现在拒绝相对路径、非规范化路径和超长路径（`authenticated-uds-transport.ts:207-209`），并有对应测试；网页组合入口在创建时也校验（`production-http-composition.ts:713-717`）。结论：覆盖到位。
- 目录权限/属主：`adoptExistingDirectory: false` 检查 `isDirectory`、uid、`mode & 0o077`，且不 chmod（`authenticated-uds-transport.ts:212-222`）；测试验证 0755 被拒且权限不变。结论：与作者说法一致；残余父目录/TOCTOU 风险如“推测”所述。
- 陈旧/存活/被替换套接字：沿用原有实现，先确认不是存活套接字、再比较 inode 后删除（`authenticated-uds-transport.ts:223-240`）。作者“目录校验之后才检查旧套接字”的说法成立。
- 错误路径与资源：seal 失败清理有代码但无测试；`close()` 在服务器关闭失败时跳过套接字删除；预算 `release()` 两条异常路径（启动中、关闭中）都有实际缺口。结论：前者低风险，后两者需要修。
- 不可撤销/破坏性操作：删除套接字前比较 `dev/ino`（`production-http-composition.ts:1252-1254`），比旧代码更谨慎；没有发现新增的宽泛删除。
- 规则/文档一致性：本次改动不涉及 `packages/prompt-catalog`、`packages/runtime-pi`、遮盖或历史序列化，未发现与 `.claude/rules/prompt-prefix.md` 冲突。生产 runbook 仍只写 `listenPort`，但 `runAgentService` 目前不启用 UDS，暂不构成矛盾。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动的文件只有 `production-http-composition.ts`、`service-main.ts`、`product-state-repository.ts`、`authenticated-uds-transport.ts` 及测试；没有系统提示、工具定义、历史消息、遮盖逻辑或提示词目录的改动。发给模型的内容仍然只在末尾追加；新增的 `listenPath`、`extraReadThreadBudget`、`STOP_TIMEOUT`、`authority.lost_handler_failed` 都不进入模型请求，`listenPath` 是每租户稳定的服务路径而非每轮变化值。依据：`.claude/rules/prompt-prefix.md` 第 2、4 条。

2. **不会让同一段模型文字在不同请求里变成不同字节。** 改动中没有依赖前后文的遮盖、随机量或无序集合进入模型输入。诊断日志确实带 `new Date().toISOString()`（`packages/platform-node/src/service-runtime.ts:71`），但那是服务日志，不是模型请求；新增的 `listenPath` 对同一租户固定，不是每请求变化值。依据：规则第 10、11 条。

3. **有自动检查，但有三处反向用例缺口。**
   - 真能挡住回退的：开放权限目录、相对/非规范化路径、超长路径、陈旧/存活套接字、关闭时正在启动的预算归还、预算归还抛错后仍释放锁；这些测试若删除对应实现会失败（读代码推断）。
   - 挡不住的：`STOP_TIMEOUT` 的 `.code`（只匹配 message）、seal 失败清理、`onAuthorityLost` handler 抛错诊断；另外 `close()` 中止剩余预算归还也没有断言。建议补第 4、5、6 条中的测试。

4. **逐个核对产生方与使用方：**
   - `listenUnixSocketPath`：由 `startTenantRuntime` 在 `input.listen.kind === "unix"` 时产生，`createProductionHttpComposition` 创建时校验绝对/规范化/长度（`production-http-composition.ts:713-717`），`prepareUnixSocketPath` 再校验一次并消费。两端一致。
   - `TenantRuntimeHandle.listenPath` 与 `service.ready` 的 `listenPath`：由已校验路径产生，只被本次测试消费；仓库内没有严格 schema 或旧消费者，新增字段是兼容的。生产 runbook 仍以 `listenPort` 判断 TCP 启动，当前 `runAgentService` 不传 unix 路径，无冲突。
   - `SqliteExtraReadThreadBudget` / `extraReadThreadBudget`：旧名 `readThreadBudget` 在仓库内已无残留引用，`persistence-sqlite/src/index.ts` 通过 `export *` 导出，service 与测试均已更新。两端一致。
   - `TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT` 的 `.code`：产生于 `stop()` 超时，仓库内没有其他消费者；新增属性是兼容的，但缺少测试守住。
   - `authority.lost_handler_failed`：自由格式诊断事件，未找到按事件名做严格校验的消费者；兼容。
   - `prepareUnixSocketPath` 的第二参数从位置参数改为 options：仓库内只有 `AuthenticatedUdsServer.start()` 和新测试调用，均已更新；`AuthenticatedUdsServer` 未传 `adoptExistingDirectory`，继续走 chmod 旧行为。
   - 新增导出 `UnixSocketIdentity`、`maximumUnixSocketPathBytes`、`assertUnixSocketPathLength` 等通过 `export *` 暴露，未发现重名冲突。
