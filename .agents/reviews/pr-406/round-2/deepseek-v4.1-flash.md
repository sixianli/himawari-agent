## 结论摘要

读代码确认：本次被审的 `6b7641e1` 相对 `a4d82f60` **没有任何代码增量**，只有 `.agents/reviews` 记录；作者说明里的第 2 轮改动基本都不在当前代码里。当前代码最危险的问题是：网页服务可传入任意绝对套接字路径，`prepareUnixSocketPath` 会无条件对该路径的父目录执行 `chmod 0700`。

---

## 问题（按严重度从高到低）

### 1. 严重（阻断）：作者声称的第 2 轮改动不在被审提交里

- 文件:行：`packages/platform-node/src/authenticated-uds-transport.ts:197-203`；提交 `6b7641e1`
- 问题：`6b7641e1` 只新增了 7 个复核记录文件，没有改任何代码；`a4d82f60..6b7641e1` 的代码 diff 为空。说明中的 `adoptExistingDirectory`、预算改名、seal 失败清理、`onAuthorityLost` 异常诊断、`STOP_TIMEOUT` 带 `code`、以及那几项新测试，在当前代码中均不存在。
- 证据：

```text
$ git show --stat --oneline 6b7641e1
6b7641e1 fix(agent-service): ...
 .agents/reviews/pr-406/round-1/deepseek-v4.1-flash.md   | Bin 0 -> 15757 bytes
 ... 共 7 个文件，全部在 .agents/reviews/pr-406 或 .agents/reviews/pr-406/usage.jsonl
```

```text
$ git diff a4d82f60..6b7641e1 -- \
    packages/platform-node/src/authenticated-uds-transport.ts \
    apps/agent-service/src/production-http-composition.ts \
    apps/agent-service/src/service-main.ts \
    packages/persistence-sqlite/src/product-state-repository.ts
(无输出)
```

```text
grep adoptExistingDirectory → 0 处
```

当前函数签名仍为：

```ts
197 export async function prepareUnixSocketPath(
198   socketPath: string,
199   errorCodes?: AuthenticatedUdsErrorCodeOverrides,
200 ): Promise<void> {
```

- 建议：先把声称的改动真正提交进来，再按本轮说明复核；否则这份说明不能作为评审依据。若改动在别的提交或分支，应在材料中给出实际提交号。

### 2. 高（安全 / 不可撤销副作用）：任意绝对路径的父目录被强制 `chmod 0700`

- 文件:行：`packages/platform-node/src/authenticated-uds-transport.ts:197-203`；`apps/agent-service/src/production-http-composition.ts:711-716`
- 问题：`prepareUnixSocketPath` 对 `path.dirname(socketPath)` 无条件 `mkdir` 后 `chmod 0700`，既没有检查该目录是否已存在、是否属于本进程、是否含有组/其他位权限，也没有区分“专用目录”和“共享目录”。网页服务只校验绝对、规范化和长度，因此 `"/"`、`"/x.sock"`、`"/etc/xxx.sock"` 都能走到 `chmod`。
- 证据：

```ts
197 export async function prepareUnixSocketPath(
198   socketPath: string,
199   errorCodes?: AuthenticatedUdsErrorCodeOverrides,
200 ): Promise<void> {
201   assertUnixSocketPathLength(socketPath);
202   await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
203   await chmod(path.dirname(socketPath), 0o700);
```

```ts
713   if (unixSocketPath !== undefined) {
714     if (!path.isAbsolute(unixSocketPath) || path.normalize(unixSocketPath) !== unixSocketPath)
715       compositionError(PRODUCTION_HTTP_COMPOSITION_ERROR_CODES.CONFIGURATION_INCOMPLETE);
716     assertUnixSocketPathLength(unixSocketPath);
717   }
```

`path.normalize("/") === "/"`，所以根目录会通过校验，随后 `path.dirname("/")` 仍是 `"/"`。另外，第 205-217 行的“已有 socket 检查”发生在 `chmod` 之后，因此即使因为已有活跃套接字而启动失败，父目录权限也已经被改掉。

- 建议：把“新建目录”和“接管已有目录”分开；已存在目录必须校验属主和权限，不满足就拒绝且不改权限。明确拒绝 `/` 以及不适合作为租户运行目录的路径；最好要求套接字目录位于本服务专用根目录下，并用 `realpath`/`lstat` 处理符号链接，至少避免对共享目录（`/tmp`、`/run`、`/etc`）做 `chmod`。作者说明中“网页服务传 false、不改权限”的描述与代码相反。

### 3. 中高：读线程预算 `release()` 抛错会跳过锁释放并泄漏读上下文

- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:696-707`、`726-741`
- 问题：`close()` 的 `finally` 里先循环调用外部注入的 `release()`，再 `await this.lock.release()`。只要 `release()` 抛错，循环中断，`extraReadThreads` 不会继续递减，`this.lock.release()` 也不会执行，状态根锁被永久占住。另一个路径里，`this.closed` 为真时先 `release()` 再 `started.close()`；`release()` 抛错会跳过 `started.close()`，新启动的读上下文不会被关闭，而且错误被后面的 `.catch(() => undefined)` 吞掉。
- 证据：

```ts
703     } finally {
704       for (; this.extraReadThreads > 0; this.extraReadThreads -= 1)
705         this.readThreadBudget?.release();
706       await this.lock.release();
707     }
```

```ts
729       const starting: Promise<void> = this.startReadContext()
730         .then(
731           (started) => {
732             if (this.closed) {
733               release();
734               return started.close();
735             }
736             this.readContexts.push(started);
737             if (budget) this.extraReadThreads += 1;
738           },
739           () => release(),
740         )
741         .catch(() => undefined)
```

- 建议：用嵌套 `finally` 保证 `lock.release()` 一定执行；对每一次 `release()` 单独 `try/catch`，并保证即使 `release()` 抛错也执行 `started.close()`。若预算实现不允许抛错，应在接口契约里写明并在调用处防御。

### 4. 中：seal 失败后不关闭、不清理刚创建的套接字；`app.close()` 抛错也会跳过删除

- 文件:行：`apps/agent-service/src/production-http-composition.ts:1234-1249`
- 问题：`app.listen()` 成功后 `sealUnixSocket()` 若失败，`unixSocketIdentity` 仍是 `undefined`，`listen()` 直接抛出；之后 `close()` 因为 `unixSocketIdentity === undefined` 不会删除套接字文件。`close()` 中 `await app.close()` 也没有 `try/finally`，一旦 `app.close()` 抛错，后面的删除同样不会执行。
- 证据：

```ts
1234       await prepareUnixSocketPath(unixSocketPath);
1235       await app.listen({ path: unixSocketPath });
1236       unixSocketIdentity = await sealUnixSocket(unixSocketPath);
1237       searchIndexer.start();
1238       return unixSocketPath;
```

```ts
1240     close: async () => {
1241       searchIndexer.stop();
1242       await app.close();
1243       if (unixSocketPath !== undefined && unixSocketIdentity !== undefined) {
1244         const identity = unixSocketIdentity;
1245         unixSocketIdentity = undefined;
1246         const current = await lstat(unixSocketPath).catch(() => undefined);
1247         if (current && current.dev === identity.dev && current.ino === identity.ino)
1248           await removeUnixSocketFile(unixSocketPath);
1249       }
1250     },
```

- 建议：`listen()` 中包住 `sealUnixSocket`，失败时先 `app.close()`，再按“刚创建的文件”删除；`close()` 用 `try/finally` 保证删除阶段一定执行。

### 5. 中：`onAuthorityLost` handler 抛错会变成未处理的 Promise 拒绝

- 文件:行：`apps/agent-service/src/service-main.ts:2929-2931`
- 问题：handler 在 `.then` 回调里直接调用，没有 `try/catch` 或 `.catch`。handler 一旦抛错，返回的 Promise 被 `void` 丢弃，Node 默认会把它报成 `unhandledRejection`，可能导致进程退出；也没有作者声称的诊断日志。
- 证据：

```ts
2929       onAuthorityLost: (handler: (error: unknown) => void) => {
2930         void authorityLoss.then(() => handler(authorityLossError));
2931       },
```

- 建议：对每个 handler 单独 `try/catch`，失败时写 `writeServiceDiagnostic(errorOutput, { event: "authority_lost.handler_failed", code: stableErrorCode(error) })`，不要让一个订阅者的异常影响其他订阅者或进程。

### 6. 中低：`STOP_TIMEOUT` 只有 message，没有 `.code` 属性；且单租户主路径不使用超时

- 文件:行：`apps/agent-service/src/service-main.ts:573-575`、`2921-2925`、`616`
- 问题：错误对象是普通 `new Error("TENANT_RUNTIME_STOP_TIMEOUT")`，没有 `code` 字段。`stableErrorCode()` 能从 message 反推出这个码，但任何直接读 `error.code` 的消费者都拿不到。作者说明的“错误带 code”与代码不符。另外 `runAgentService()` 在真实服务路径里调用的是 `await started.stop()`，没有传超时，因此停止流程挂住时这个 `STOP_TIMEOUT` 不会被使用。
- 证据：

```ts
573 export const TENANT_RUNTIME_ERROR_CODES = Object.freeze({
574   STOP_TIMEOUT: "TENANT_RUNTIME_STOP_TIMEOUT",
575 } as const);
```

```ts
2921         const deadline = new Promise<never>((_, reject) => {
2922           timer = setTimeout(
2923             () => reject(new Error(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT)),
2924             timeoutMs,
2925           );
2926         });
```

```ts
616     await started.stop();
```

- 建议：定义带 `readonly code` 的错误类；若希望保护单租户停服，`runAgentService()` 也应在合理超时下调用 `stop()`，并在超时后记录诊断。

### 7. 中：作者声称的反向测试大多不存在

- 文件:行：`apps/agent-service/test/production-http-composition.unit.test.ts:1300-1332`；`apps/agent-service/test/service-orchestration.unit.test.ts:1267-1274`；`test/integration/sqlite-product-state.test.ts:390-416`
- 问题：现有测试覆盖了“新目录 0700 / 文件 0600 / 重启后清理”“超长路径拒绝”“预算上限与 close 归还”“stop 超时拒绝”，但没有作者声称的这些反向用例：
  - 相对路径、非规范化路径的拒绝；
  - 已存在开放权限目录不被改权限；
  - 关闭时正在启动的读线程归还预算；
  - 预算 `release()` 抛错后锁仍释放；
  - 超时后再次 `stop()` 不会重复关闭；
  - seal 失败清理、handler 抛错诊断。
- 证据：`production-http-composition.unit.test.ts` 的新增用例只断言：

```ts
1314         expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
1315         expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
...
1330     await expect(create()).rejects.toThrow(/exceeds/u);
```

`service-orchestration.unit.test.ts` 只验证超时本身：

```ts
1270     const stopping = handle.stop(500);
1271     const outcome = expect(stopping).rejects.toThrow(TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT);
```

- 建议：至少补上第 2、3、4 条发现对应的反向用例；这些用例在当前实现下应当失败，修好后再转绿。未能运行测试（本次只允许读工具），以上为读代码判断。

### 8. 低：预算命名与作者说明不一致

- 文件:行：`packages/persistence-sqlite/src/product-state-repository.ts:113-116`、`129`、`181`；`apps/agent-service/src/service-main.ts:539`
- 问题：代码仍叫 `SqliteReadThreadBudget` / `readThreadBudget`，说明称改成了 `SqliteExtraReadThreadBudget` / `extraReadThreadBudget`。语义上基础上下文确实不计入预算（`this.readContexts = [input.readContext]` 是初始上下文），但命名与说明不符。
- 证据：

```ts
113 export interface SqliteReadThreadBudget {
...
129   readonly readThreadBudget?: SqliteReadThreadBudget;
```

- 建议：要么改名，要么修正说明；这不是功能阻断，但会误导后续复核者。

---

## 推测 / 未核实

- 【推测】若服务以 root 运行且配置 `listenUnixSocketPath: "/x.sock"`，会把根目录改成 0700，影响全机；若以普通用户运行且父目录不属于自己，则会在 `chmod` 处得到 `EACCES`。未在真实部署上验证调用方会传什么路径。
- 【推测】父目录是符号链接时 `chmod` 会跟随到目标目录；结合“任意绝对路径”可能放大影响。未验证实际部署路径是否可能包含符号链接。
- 【推测】`lstat` 校验与 `unlink` 之间仍有 TOCTOU 窗口；这在旧 `AuthenticatedUdsServer` 路径里已存在，不是本次新增，但被新的公共 helper 复用后暴露面变大。
- 【已核实】仓库内只有 `runAgentService()` 调用 `startTenantRuntime()`，且不传 `listen` 或 `shared`；因此 Unix 套接字监听和共享读线程预算目前只在单测里被执行，生产路径还没有接线。
- 【未核实】`.agents/reviews/pr-406/round-1/judgments.md` 和 `verdicts.jsonl` 在当前稀疏检出的工作区不可读，`git show` 也被记录路径规则拒绝，因此没有逐条核对第 1 轮意见原文。
- 【未核实】没有运行测试或类型检查，以上测试覆盖结论来自读代码。

---

## 侧重检查

查过的错误路径、不可信输入、安全、资源耗尽、不可撤销操作和文档一致性：

- **套接字路径输入**：绝对性、规范化、长度有校验；但 `"/"` 能通过，且所有权、权限、符号链接、是否专用目录都没有校验。结论：高危。
- **目录权限副作用**：`mkdir`/`chmod` 发生在已有 socket 校验之前；失败路径也会改权限；没有“已存在目录只校验不修改”的分支。结论：与作者说明相反，且可能破坏共享目录。
- **seal / 监听失败**：`sealUnixSocket` 失败后没有主动关闭和删除；`close()` 依赖 `unixSocketIdentity` 且没有 `try/finally`。结论：会留下失效套接字，清理依赖下一次启动。
- **读线程预算**：`tryAcquire` 在启动前调用，成功启动后计入 `extraReadThreads`；正常 close 会归还。但 `release()` 抛错会跳过锁释放、跳过 `started.close()`，存在锁泄漏和上下文泄漏。
- **关闭与超时**：`stop()` 缓存同一个 `stopping` Promise，重复调用不会重复关闭；超时用 `Promise.race` 且清理 timer。问题是没有 `.code` 属性，且主服务路径没有使用超时。
- **权威丢失回调**：支持早注册和晚注册，但 handler 异常没有隔离和诊断，可能触发未处理拒绝。
- **不可撤销操作**：对已存在共享目录执行 `chmod`、对旧 socket 文件执行 `unlink`；后者有同 uid 和存活探测，前者没有保护。
- **文档 / 说明一致性**：作者说明与代码存在多处不一致（第 1、2、3、4 条），已在上面逐条列出；`prompt-prefix` 规则本身未被改动。
- **清单 / 新值消费端**：`listenPath`、`STOP_TIMEOUT`、`listenUnixSocketPath` 目前基本只有测试消费；没有发现后端 schema 会拒绝它们，但也没有生产消费方验证。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍然只在末尾追加？

**不会。** 本次 diff 只涉及服务生命周期、Unix 套接字监听、SQLite 读线程预算及其测试，没有触碰系统提示、工具定义、历史消息、出口遮盖或 prompt 组装代码。新增的 `listenPath`、套接字路径只进入服务诊断日志和 `TenantRuntimeHandle`；`writeServiceDiagnostic` 的 `timestamp` 是日志字段，不进入模型请求。因此发给模型的内容仍然只在末尾追加，本轮会变的值没有进入请求开头或最后一条用户消息之外的模型内容。依据 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules)。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** 改动没有引入依赖前后文的遮盖、带时间的模型字段或无序集合进入模型内容。`writeServiceDiagnostic` 会写 ISO 时间，但只写日志；`runtimeTimers` 的 Set 顺序只影响清理，不影响序列化；套接字路径和租户标识不参与模型请求。没有发现同一段文字因本改动被编码成不同字节。

### 3. 改动有没有对应的自动检查？反向用例是否真的会失败？

有一部分，但作者声称的那些大部分没有：

- 已有：平台层 Unix socket helper 契约测试（创建 0700/0600、超长拒绝、活跃 socket 拒绝、普通文件拒绝、缺失文件删除）；生产 HTTP 组合测试（unix 监听、重启后清理、超长拒绝）；SQLite 预算上限与 close 归还；`stop` 超时拒绝。
- 缺失：相对/非规范化路径拒绝、开放权限已有目录不被改权限、关闭时启动中的读线程归还预算、`release()` 抛错仍释放锁、超时后再次 `stop()`、seal 失败清理、`onAuthorityLost` handler 抛错诊断。
- 因此对于第 2、3、4 条发现，当前没有反向用例；按代码逻辑，补上这些用例应当失败。未实际运行测试（本次工具限制）。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐项核对结果：

- `listenUnixSocketPath`：由 `service-main.ts:2683` 从 `input.listen.path` 产生，`production-http-composition.ts:711-716` 消费并校验绝对、规范化、长度。两端能对上，但校验不足以阻止 `/`、`/etc` 这类危险父目录。当前生产路径没有调用方传入该值。
- `listenPath`：由 `service-main.ts:2880` 写入 `service.ready` 诊断、`2913` 放入返回句柄；目前只有测试消费，没有发现 schema 拒绝。若将来有消费者强制要求 `listenPort`，unix 模式下会缺失，需要消费端明确支持。
- `TENANT_RUNTIME_ERROR_CODES.STOP_TIMEOUT`：在 `service-main.ts:2923` 产生，测试 `service-orchestration.unit.test.ts:1271` 按 message 断言。没有 `.code` 属性；任何按 `.code` 读取的消费者都不能接受。主服务路径也没有使用带超时的 `stop()`。
- `SqliteReadThreadBudget` / `readThreadBudget`：`service-main.ts:539` 与 `product-state-repository.ts:113-129` 两端类型一致；仓库内部按 `tryAcquire`/`release` 使用。名称与作者说明不一致；`release()` 异常路径会破坏锁释放。
- `UnixSocketIdentity`、`maximumUnixSocketPathBytes`、`assertUnixSocketPathLength`、`prepareUnixSocketPath`、`sealUnixSocket`、`removeUnixSocketFile`：导出与调用处类型一致，没有发现编译层面的两端不接受。
- `adoptExistingDirectory`：全仓库不存在，没有产生方也没有消费方；作者说明中的这一项无法核对，因为代码里没有。

按 [I-73](../../docs/incidents-and-gates.md#incidents) 的教训，新值不能只检查“改动本身能跑”；这里至少 `STOP_TIMEOUT` 的 `.code` 和 `listenPath` 的生产消费方仍需要补验证。
