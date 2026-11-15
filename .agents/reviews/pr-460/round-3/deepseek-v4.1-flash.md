## 结论

本轮增量 `d6500211c` 只改了 `test/tooling/prod-read.test.mjs` 和 `test/tooling/review-gateway.test.mjs` 两个测试文件，未改动被测脚本、产品代码、提示词或工具定义。**未发现高、中严重度问题**；只有两处低严重度的测试保真度/对象形状问题。

## 发现（按严重度）

### 低 1：手写的 install 对象不符合 `installGateway()` 的完整返回形状

- 文件:行：`test/tooling/review-gateway.test.mjs:1025-1030`
- 问题：`installGateway()` 返回 5 个字段，新测试手写的对象只有 4 个，缺 `binarySha256`。当前失败路径不用它，所以测试能过；但对象不是合法的 install，将来若在 spawn 前加完整性校验，这个用例会因错误原因失败或绕过校验。
- 证据：
  - 生产者 `scripts/model-review/gateway.mjs:351`：`return { binary, binarySha256: asset.sha256, pluginDir, cacheDir, version: lock.magpie.version };`
  - 消费者 `scripts/model-review/gateway.mjs:706、709、757、777` 分别用 `install.cacheDir`、`install.pluginDir`、`install.binary`、`install.version`；`binaryProblem()` 在 `354-357` 才用 `install.binarySha256`，而本用例不调用它。
  - 新测试对象只有 `binary/pluginDir/cacheDir/version`（`1025-1030`）。
- 建议：补一个任意 `binarySha256` 值，或用统一的 `fakeInstall({ binary })` 帮助函数构造完整对象，避免以后加校验时测试假通过。

### 低 2：测试库不是生产使用的 WAL 模式，只读脚本的 WAL 路径未被覆盖

- 文件:行：`test/tooling/prod-read.test.mjs:43`
- 问题：测试库显式设为 `journal_mode = MEMORY`；生产写库是 WAL。被测脚本用 `{ readOnly: true }` 打开生产库（`scripts/operations/prod-read.sh:50`），WAL/`-shm` 下的只读打开语义没有被这条测试复现。这是改动前就存在的覆盖缺口（原测试库是默认 rollback journal，也不是 WAL），不是 `d6500211c` 引入的回归。
- 证据：
  - `test/tooling/prod-read.test.mjs:43`：`database.exec("PRAGMA synchronous = OFF; PRAGMA journal_mode = MEMORY");`
  - `scripts/operations/prod-read.sh:50`：`new DatabaseSync("$PROD_DATABASE", { readOnly: true })`
  - `packages/persistence-sqlite/src/sqlite-worker.ts:123`：`database.pragma("journal_mode = WAL");`；`packages/persistence-sqlite/src/migration-engine.ts:1057` 同样。
- 建议：至少保留一条 WAL 模式的只读用例（或加一个 WAL 变体），验证 `readOnly: true` 在 WAL/`-shm` 存在的真实布局下能读到数据；现有两条继续用 MEMORY 做快速用例即可。

## 读代码证实的

- `migratedDatabase()` 会先把库写成文件，测试在 `spawnSync` 子进程前都调用了 `database.close()`（`test/tooling/prod-read.test.mjs:234、282`）。`journal_mode=MEMORY` 不会留下 `-journal`/`-wal` 热日志，提交的数据在数据库文件里，子进程的 `readOnly: true` 能读到；不会因为“不落盘”而读不到。
- 501 条批量插入确实被包在一个事务里（`228-233`），只有 `m1/m2` 在事务外；`gmail-decisions` 的 4 条插入没有事务，但只有 4 条，不影响正确性。
- `synchronous=OFF` 在 `journal_mode=MEMORY` 下基本不起作用（SQLite 在 MEMORY/OFF 日志模式下忽略 synchronous），真正的加速来自 MEMORY journal 和单事务；作者的说法不算错，但归因略宽。
- `memory_records` 相关触发器只有 `AFTER UPDATE`/`BEFORE DELETE`（`0087_rule_book_memory_link.sql:301、363`、`0094_memory_conversation_review.sql:46`），批量 INSERT 放进事务不会触发额外行为差异。
- `startGateway()` 的失败路径只依赖 `binary`、`pluginDir`、`cacheDir`、`version`；`version` 只在成功启动后写日志（`gateway.mjs:777`），本次测试不会走到。手写对象缺 `binarySha256` 当前不致命。
- `runningGatewayCount()` 的清理是可靠的：失败时 `stop()` 调 `killGateway()`，后者先从集合删除再 kill（`gateway.mjs:678-683`），所以 `1037` 的断言成立。
- 四个调用方改用 `resolveReadOnlyToolchainPaths` 的清单与原来一致；`mac-sandbox-deployment.ts` 用 `{ dedupe: false }` 保持原样（`test/fixtures/mac-sandbox-deployment.ts:159`），与 ADR 0253:64 的描述一致。
- `scripts/platform-assumptions.json` 新增的两项计数与扫描正则相符：`read-only-toolchain.mjs` 里 `/lib64` 出现 1 次，单测文件 8 行里有一行出现 2 次，共 9 次（`scripts/check-platform-assumptions.mjs:53` 的正则）。
- `packages/testing/package.json:9-12` 新增的 `./read-only-toolchain` 导出名、类型文件和实现文件都存在，四个调用方的 `@himawari-agent/testing/read-only-toolchain` 能解析。

## 推测/未核实

- 作者给出的 x64 耗时 `1499→381ms、896→275ms` 和 ARM runner 上的 CI 验证结果，未运行、未查到 CI 记录，**未核实**。
- 若未来 `startGateway()` 在 spawn 前加入 `binaryProblem()` 一类完整性检查，低 1 的手写对象会改变这个用例的失败原因；目前代码没有这条路径，属于推测。
- 生产 WAL 下 `readOnly: true` 的实际行为未在本仓库测试中实测，只按 SQLite 语义推断现有 MEMORY 测试库可读。

## 侧重检查

- **错误路径**：核对了不存在 binary 的 `spawn` ENOENT → `error` 事件 → `waitForGateway` 失败 → `GATEWAY_START_FAILED` → `stop()` 清集合（`gateway.mjs:636-644、756-783`）。测试断言与清理匹配，无泄漏。
- **不合规范/不可信输入**：本轮没有新增外部输入；prod-read 脚本的输入校验未改，测试仍断言拒绝用例（`prod-read.test.mjs:93-115`）。
- **安全**：只读属性仍被断言（`prod-read.test.mjs:219、252`）；配置权限/属主、软链、悬空链接的安全用例未受本次改动影响。
- **资源耗尽**：固定 501 次插入，无新增无界循环；失败时子进程被 kill；临时目录在 `afterEach`/`finally` 清理（`prod-read.test.mjs:33-36`、`review-gateway.test.mjs:1038-1040`）。
- **不可撤销操作**：无，全部在 `mkdtempSync` 临时目录内。
- **规则/文档/代码一致**：ADR 0253 关于去重开关、四个调用方、ARM 工具链锁的说明与代码一致；`platform-assumptions.json` 计数与扫描器一致；`.claude/rules/prompt-prefix.md` 相关代码未被本次改动触碰。

## 作者说法核对

- “两条 prod-read 用例、94 个迁移、501 次插入”：属实。`0001`–`0094` 共 94 个 SQL 文件；501 条只出现在 `rule-memories` 用例，`gmail-decisions` 是 4 条插入，作者表述略有合并。
- “用了 `synchronous=OFF`、`journal_mode=MEMORY`、批量插入一个事务”：属实（`prod-read.test.mjs:43、228-233`）。
- “review-gateway 改为直接构造 install，binary 指向不存在路径”：属实，但对象还补了 `pluginDir/cacheDir/version`，同时漏了 `binarySha256`。
- “被测脚本和断言不变、没有加大时限”：对 `d6500211c` 属实（`git show d6500211c --stat` 只含这两个测试文件；无 vitest 配置或 timeout 改动）。`reserveModels` 那处断言循环来自 `def579833e`，不是本提交。
- “CI 已带进 PR 464、ARM runner 验证”：未核实。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。`d6500211c` 只改测试；整个 `c44b8396..4f8bd600` 的改动文件列表里没有系统提示、工具定义、历史消息或出口遮盖代码。仍是“只在末尾追加”，也没有把会变的值塞进请求开头；没有新增每轮变化的值。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。本轮没有改序列化、遮盖或集合顺序。新增的 `resolveReadOnlyToolchainPaths` 也保持输入顺序、`Promise.all` 保序、`Set` 去重保序，且只用于沙箱/测试夹具，不进入模型请求。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有：这两个测试本身就是检查。prod-read 若只读打开失败、数据未持久化、`LIMIT`/`ORDER BY` 被改，`child.status` 或 `rows` 断言会失败（`prod-read.test.mjs:240-245、288-300`）；review-gateway 若 `serve()` 不抛 `GATEWAY_START_FAILED` 或残留子进程，`rejects.toThrow`/`runningGatewayCount()` 会失败（`review-gateway.test.mjs:1036-1037`）。但没有新增针对“测试库不落盘”这一设置本身的反向用例，也没有覆盖 WAL 只读路径；这一块属于覆盖不足而非断言失效。
4. **每个新值的产生处和使用处都能接受吗？** 逐个核对：
   - 测试库文件路径：产生于 `migratedDatabase()`（`prod-read.test.mjs:39-41`），通过 `result.input.replace(...)` 交给子进程（`235、283`），子进程以 `readOnly: true` 打开；两端路径一致，数据在 `close()` 前已提交，能接受。
   - `journal_mode/synchronous`：只作用于测试写连接，读连接不受影响，能接受；与生产 WAL 不一致属于覆盖缺口，不是接口不匹配。
   - 手写 install：`binary`、`cacheDir`、`pluginDir`、`version` 都被 `startGateway()` 按预期消费；缺 `binarySha256` 当前无消费者，能接受但不完整，建议补齐。
   - 新增导出 `@himawari-agent/testing/read-only-toolchain`、`OPTIONAL_TOOLCHAIN_PATHS`、`resolveReadOnlyToolchainPaths`：四个调用方与单测都能解析，类型文件存在，能接受。
   - `platform-assumptions.json` 新条目：扫描器要求的“类别 → 文件 → 正整数次数”格式和实际出现次数都匹配，能接受。
