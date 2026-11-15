## 侧重检查

- 测试输入：`readFileSync` 读的是仓库内固定路径 `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs`（测试 550-556 行），不来自外部或用户输入；文件缺失会直接抛错使测试失败，不会静默通过。
- 正则构造：`new RegExp(String(pattern?.[1])...)` 的来源是同仓库脚本文本，不是不可信输入，没有注入面；无网络、无子进程、无写文件、无不可逆操作，资源消耗只有一次文件读取。
- 失败路径：`pattern`/`nonFatal` 为 `null` 时先被 `not.toBeNull()` 拒绝，不会继续 `JSON.parse(undefined)`；源码数组格式坏掉时 `JSON.parse` 会显式抛错，不会静默放过。
- 规则一致性：提交只写了 `packages/platform-node/test/protected-runtime.unit.test.ts` 一行 `Layer-0-tests:`；该文件被 `ci/policy.json` 的 `packages/**/*.unit.test.ts` 收集，`check-layer0-tests.py:313-328` 在“只改测试、无产品源码变更”时允许这种额外声明，不会报 `L0_RELATED_TESTS_UNKNOWN`。
- 生产端/消费端契约：事件名只做了消费端核对，生产端没有被自动检查锁住，见下面第 1 条。

## 意见

### 1. 中：测试只核对了消费端正则，没有核对生产端真的发出这两个事件名

- 文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:549-571`；生产端 `packages/platform-node/src/capabilities/protected-runtime.ts:449-455`
- 问题：用例名说“logs a failed deferred audit under an event name that the deploy start-up readback treats as a failure”，但用例只是把 `sandbox_runtime.content_audit_failed` / `sandbox_runtime.content_audit_retryable` 当成字面量，去验证 `S7-startup-readback.mjs` 的正则和 `nonFatal`；它没有调用 `verifyProtectedRuntime` 去确认真实日志里确实出现这两个字符串。生产端改名后，这个测试仍然会绿。
- 证据（读代码证实）：
  - 生产端映射在 `protected-runtime.ts:449-455`：`event: outcome.ok ? "sandbox_runtime.content_audit_completed" : outcome.superseded ? "sandbox_runtime.content_audit_superseded" : outcome.transient ? "sandbox_runtime.content_audit_retryable" : "sandbox_runtime.content_audit_failed"`。
  - 测试端 `protected-runtime.unit.test.ts:568-571` 只对抽取出的 `failureEvents` 断言字面量：`expect(failureEvents.test("sandbox_runtime.content_audit_failed")).toBe(true)`、`...retryable..."`。
  - 全仓库搜索 `content_audit` 只在这几处出现：生产端、该测试、S7 脚本、`test_make_packet.py` / `verify-startup-readiness-fixtures.mjs`；没有任何测试对 `verifyProtectedRuntime` 的 `console.error` 输出做断言。
- 推测：若以后把生产端事件改成不含 `failed`/`retryable` 的名字（例如 `sandbox_runtime.content_audit_bad`），S7 读回会把这次审计失败当成启动健康，而现有测试不会失败。
- 建议：加一条行为测试，用失败的 `readBytes` 调 `verifyProtectedRuntime`（`deferContentAudit: true`），用 spy 收 `console.error` 的 JSON，取出真实 `event` 再喂给从 S7 抽出的 `startupFailureEvents`/正则；或让生产端与 S7 共享常量。这样才符合 I-73 那类“两端都要核对”的要求。

### 2. 低：用例依赖脚本源码的单行文本形状，并从源码重新编译正则，格式变化会误报

- 文件:行：`packages/platform-node/test/protected-runtime.unit.test.ts:557-568`；被读脚本 `scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:66`
- 问题：测试不是执行 `startupFailureEvents`，而是用正则去匹配源码里一整行的写法：`records.filter((item) => !nonFatal.has(item.event) && (\/.+\/i)\.test(String(item.event)))`。只要以后把第 66 行换行、改空格、给正则加 `g` 标志，或把 `nonFatal` 改名，测试就失败；而且 `slice(1, -2)` 只适用于“恰好一个字符的 `i` 标志”，换成 `gi` 会取出错误的模式串。它验证的是文本形状，不是行为。
- 证据（读代码证实）：测试 557-559 行的抽取正则要求上述精确子串；568 行 `const failureEvents = new RegExp(String(pattern?.[1]).slice(1, -2), "i");`；脚本 66 行确实是单行，且仓库已有 `verify-startup-readiness-fixtures.mjs:55-71` 用 `new Function` 真正执行 `startupFailureEvents`，并已覆盖 `content_audit_retryable`。
- 建议：复用 `verify-startup-readiness-fixtures.mjs` 的执行方式（或直接在该 fixture 里补 `content_audit_failed` 用例），断言函数输出；若保留当前文本测试，至少按正则字面量整体解析，避免 `slice(1, -2)` 的隐含单标志假设。另可顺手断言 `nonFatal` 仍包含 `memory.embedding_catch_up_failed`，把允许名单两个方向都钉住。

## 作者说法核对

- “只改一个测试”：属实。`git show --stat` 只有 `packages/platform-node/test/protected-runtime.unit.test.ts`，10 增 1 删。
- “PR 571 把失败事件判断改成 `records.filter(... !nonFatal.has(...) && /.../i.test(...))`”：基本属实，且 PR 571 的合并提交是 `a4ef1ccd5`。精确地说，`startupFailureEvents` 与 `nonFatal` 是同一 PR 的 `8de0a1697` 引入，`281835ded` 只是去掉了 `!Object.hasOwn(item, "retryInMs")` 这一项豁免；最终形态与作者描述一致。
- “旧用例按 `assert(!records.some(...))` 取正则失效”：属实。旧测试（基线版本 549-571 行）匹配的是 `assert\(!records\.some\(...`，而当前脚本第 215 行已改为 `assert.deepEqual(startupFailureEvents(records), [], ...)`，第 66 行也不再含该片段，旧正则必然得到 `null`。
- “新用例按新写法取正则，核对 nonFatal 不含两个审计失败事件，保留原三条断言”：属实。564-571 行分别断言两个审计事件不在 `nonFatal` 数组里，并保留 failed/retryable 为真、completed 为假三条断言。
- “反向验证：加入 `content_audit_failed` 后失败，恢复后通过；整个文件 40 个用例通过”：未核实（本次不能运行测试）。按代码推理，加入该字符串会使 564 行 `not.toContain` 失败；去掉 `!nonFatal.has(item.event)` 会使 pattern 为 `null`、561 行失败。
- “不会改变模型已经见过的请求开头”：与该 diff 一致，见下面第 1 条。

## 必答问题

1. 不会。这个 diff 只改 `packages/platform-node/test/protected-runtime.unit.test.ts`，没有碰提示词组装、工具定义、历史存储、出口遮盖或任何生产请求路径；测试只是在测试进程里读一个部署脚本。发给模型的内容仍然按既有规则只在末尾追加，这个改动没有新增任何每轮会变的值，也没有把这些值挪进系统提示或历史。
2. 不会。被修改的值都是测试内部的字面量、正则和对固定源码数组的 `JSON.parse`，不进入发给模型的序列化内容；没有时间字段，没有依赖遍历顺序的集合，同一源码每次解析结果相同。生产脚本里原有的 `new Date().toISOString()` 不在本 diff 范围，也不在模型请求里。
3. 有自动检查，但反向覆盖不完整。自动检查就是本用例本身；仓库还有 `verify-startup-readiness-fixtures.mjs` 和 `test_make_packet.py` 的 `StartupFailureEventTest` 会真正执行 `startupFailureEvents`。按代码，往 `nonFatal` 加审计失败事件、或删掉 `!nonFatal.has`，本用例会失败；但作者描述的“反向验证”是手工改脚本，没有提交成自动反向用例，“40 个用例通过”也无法在本次环境核实。更重要的是：生产端事件改名这一反向场景没有测试会失败（见意见 1）。
4. 逐个核对：
   - `sandbox_runtime.content_audit_failed` / `retryable`：生产端 `protected-runtime.ts:449-455` → 消费端 `S7-startup-readback.mjs:66` 的正则会命中两者，且 `nonFatal` 不排除它们；测试 564-571 也接受。两端当前一致，但生产端没有被自动锁住（意见 1）。
   - `nonFatal = ["memory.embedding_catch_up_failed"]`：产生于 `S7-startup-readback.mjs:65`，使用于同文件 66 行 `Set.has` 和测试 562-567 的 `JSON.parse`；数组是合法 JSON，测试接受。测试没有断言它仍包含 embedding 那条，但 `verify-startup-readiness-fixtures.mjs:59-63` 覆盖了该行为。
   - 正则字面量及 `i` 标志：测试从脚本源码抽出后用 `new RegExp(..., "i")` 重建，当前脚本标志为 `i`，可以接受；标志一旦变化，`slice(1, -2)` 的假设会失效（意见 2）。
   - `Layer-0-tests` 声明的路径：`ci/policy.json` 的 `unit` 项目包含 `packages/**/*.unit.test.ts`，`check-layer0-tests.py` 的 `unknown` 检查会接受该路径；本次没有产品源码变更，这行不是必需但不会触发钩子错误。
   - 本 diff 没有产生或修改配置键、清单项、对外序列化格式；没有需要后端校验的新标识。
