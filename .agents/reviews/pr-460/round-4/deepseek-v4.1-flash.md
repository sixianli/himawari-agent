## 结论

本轮新增代码只有 `d6500211c`（`git show d6500211c --stat` 证实只改 `test/tooling/prod-read.test.mjs` 和 `test/tooling/review-gateway.test.mjs`）。没有发现高、中严重度问题；作者最担心的两点（只读脚本读不到数据、install 对象缺字段）从代码看都不成立。以下按严重度列出低严重度观察，随后是侧重检查、作者说法核对和必答问题。

## 发现（按严重度）

### 低 1：手写 install 少了 `binarySha256`，当前路径不用，但形状已与 `installGateway` 不完全一致

- 文件:行：`test/tooling/review-gateway.test.mjs:1025-1030`
- 问题：手工构造的 install 对象只有 `binary/pluginDir/cacheDir/version`，缺少 `installGateway()` 返回的 `binarySha256`。当前用例的失败路径不校验二进制摘要，所以不会失败；但以后若 `startGateway` 在启动或失败路径调用 `binaryProblem()`，这个用例会先抛 `TypeError`，而不是走到被断言的 `GATEWAY_START_FAILED`，测试会以错误原因失败或失去原有覆盖面。
- 证据（读代码证实）：
  - `scripts/model-review/gateway.mjs:351`：`return { binary, binarySha256: asset.sha256, pluginDir, cacheDir, version: lock.magpie.version };`
  - `test/tooling/review-gateway.test.mjs:1025-1030` 的对象没有 `binarySha256`。
  - `scripts/model-review/gateway.mjs:706` 只用 `install.cacheDir`；`:709/:757` 用 `install.binary`；`:709` 用 `install.pluginDir`；`:777` 用 `install.version`。`startGateway` 内未调用 `binaryProblem`（该函数只定义在 `:354`，调用点在 `scripts/model-review/opencode-review.mjs`）。
- 建议：补 `binarySha256`，或抽一个与 `installGateway` 同源的 `fakeInstall({ binary, ... })` 工厂，避免字段形状靠人工同步。

### 低 2（信息级）：测试库用 MEMORY 日志，与生产 WAL 不同，但当前只读查询不受影响

- 文件:行：`test/tooling/prod-read.test.mjs:43`
- 问题：新 helper 显式 `PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY`，而生产写库使用 WAL。该测试因此不会覆盖“只读连接打开 WAL 库”的场景。不过这不是本次改动引入的：改动前 helper 用默认 DELETE 日志，同样不是 WAL；且被测查询只做 SELECT，数据在写入连接 `close()` 后才被子进程读取。
- 证据（读代码证实）：
  - `test/tooling/prod-read.test.mjs:43`：`database.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY");`
  - `test/tooling/prod-read.test.mjs:234`：`database.close();` 在 spawn 子进程之前。
  - `scripts/operations/prod-read.sh:50`：`const database = new DatabaseSync("$PROD_DATABASE", { readOnly: true });`；`:87-107` 只有 SELECT。
  - `packages/persistence-sqlite/src/sqlite-worker.ts:123`：`database.pragma("journal_mode = WAL");`
  - `scripts/operations/prod-read.sh:4`：脚本以 `root@...` 执行，只读打开 WAL 库在权限上通常不构成问题（这一点未上生产核实）。
- 建议：若想提高保真度，可在 helper 里先设 WAL，checkpoint 并 close 后再让子进程只读打开；如果只要覆盖 SQL 结果，则保持现状即可。

## 侧重检查

- 错误路径：伪造的 `binary` 指向不存在的路径，`spawn` 触发 error，`waitForGateway` 因 `spawnError !== null` 返回 false，`serve` 调用 `stop()` 后抛 `GATEWAY_START_FAILED`；`stop()` 经 `killGateway` 从集合移除子进程，因此 `runningGatewayCount() === 0` 成立（`gateway.mjs:756-783`、`:678-690`）。此路径不需要 `binarySha256`。
- 不合规范/不可信输入：d650 没有新增外部输入；测试路径来自 `mkdtemp`，SQL 数据是固定字面量；`migratedDatabase()` 对迁移文件名排序后再执行，顺序确定。
- 安全/秘密：`prod-read.test.mjs:245` 仍断言 `child.stdout` 不含 `secret-ref`；伪装的 binary 不会被执行；没有新增密钥或日志。
- 资源耗尽：501 条插入被包进一个事务（`:228-233`），日志放内存，临时目录仍由 `directories` 在 `afterEach` 清理（`:33-36`），没有新的无界增长。
- 不可撤销操作：只在 `mkdtemp` 创建的临时目录内建库/删目录，没有生产写入或删除。
- 规则/文档/代码一致性：commit message 所说的 pragma、事务、伪造 install、断言不变、未加大时限，均与代码一致；“不落盘”措辞不准确（仍是磁盘文件，只有回滚日志在内存）。

## 作者说法核对

- “d650 只改两条测试”：证实（`git show d6500211c --stat` 恰为这两个文件）。
- “抽出 `migratedDatabase()`，synchronous=OFF、journal_mode=MEMORY，批量插入一个事务”：证实（`prod-read.test.mjs:38-50`、`:228-233`）。
- “review-gateway 改为直接构造 install 对象，binary 指向不存在路径”：证实（`review-gateway.test.mjs:1024-1035`）。
- “被测脚本和断言不变，没有加大时限”：证实（`git diff c44b..4f8bd` 对这两文件的差异与 d650 相同，断言与超时行未动）。
- “x64 1499→381ms、896→275ms、1106→271ms”和“ARM runner 已验证”：未核实（本轮只允许 git 命令，不能跑测试，也不能访问 CI）。
- “合入 main 带进 PR 459”：与 `git log c44b..4f8bd`（仅本分支提交）及 `c44b` 为 PR 459 合并提交相符；注意 `4456a13..4f8bd` 的原始增量还包含 round-2 快照之后合入的大量 main 历史，核对时应以 `c44b..4f8bd` 为 PR 变更集。

## 必答问题

1. **不改变模型已见过的请求开头。** d650 只改两个 tooling 测试文件，不涉及系统提示、工具定义、历史消息、遮盖结果或请求序列化。伪造 install 的 `version` 只出现在成功启动后的日志（`gateway.mjs:777`），不会进入模型请求；`prod-read` 测试只生成只读 SQL 并比对输出。发给模型的内容仍只在末尾追加，每轮变化的值没有被移入请求前部。
2. **不会让同一段文字在不同请求里变成不同字节。** 没有改动任何模型请求内容；测试内部也保持确定性：迁移文件显式 `.sort()`（`prod-read.test.mjs:44-46`），插入值与预期值都是固定字面量，`prod-read.sh:120` 的 `JSON.stringify(result, null, 1)` 顺序由 SQL 的 `ORDER BY` 固定。
3. **有自动检查，反向用例逻辑成立，但本轮未运行验证。** 两个被改用例本身就是检查：若只读脚本读不到库，`expect(child.status).toBe(0)` 或行数/内容断言会失败（`prod-read.test.mjs:240-245`、`:288-300`）；若 install 缺了失败路径要用的字段，`startGateway` 会抛错或抛出的不是 `GATEWAY_START_FAILED`，从而 `rejects.toThrow("GATEWAY_START_FAILED")` 失败（`review-gateway.test.mjs:1036-1037`）。目前没有专门针对 helper 或 install 形状的额外测试；由于工具限制未执行测试，运行时“确实会失败”只是代码推理。
4. **每个值两端核对通过。**（a）`{file, database}` 只在两个用例中使用，分别用于 `prepare/run/close` 和替换 SQL 里的数据库路径，两端都接受（`:222-235`、`:254-282`）；（b）PRAGMA 由 SQLite 消费，合法；（c）`BEGIN/COMMIT` 合法，前两条插入在 `BEGIN` 前自动提交，不影响结果；（d）伪造 install：`binary` 供 `spawn`/`magpie`，`cacheDir` 供 `gatewayEnv`，`pluginDir` 只在 plugin provider 时使用（本用例 `providers: []` 不用），`version` 只在成功日志使用；缺失的 `binarySha256` 在本路径没有消费者，因此当前两端都接受。没有新增清单 id、配置键或序列化格式。
