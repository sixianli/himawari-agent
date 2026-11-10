说明：本复核代理的步数已到上限，工具已停用。以下是已读内容基础上的完整结论；凡因环境限制（`node_modules` 不可读、无法运行命令/测试）没有读到的一律标「未核实」。

## 已核实范围声明

读代码证实的：PR 的完整 diff（4 个提交）、`pi-runtime-adapter.ts` 相关行、`runtime-environment-block.ts`、两处测试 diff、ADR 0206 与 `pi-development-guide.md` 的 diff、`package.json` 的 check 脚本清单。
未核实的：Pi 1.5.0 包内源码（`node_modules/@earendil-works/pi-coding-agent` 在本检出中不可读，glob/grep 均失败），因此作者说明第 1、2 条的全部行号引用（agent-session.js 1875–1880、1503、1577、1989–2000、696–698、1972–1974，settings-defaults.d.ts、cache-warmer.js、sdk.js）均未核实；`configured-model-binding.ts` 的 `providerModelConfig` 实现未核实；`.claude/rules/prompt-prefix.md` 与 `scripts/check-prompt-prefix.mjs` 未核实；任何测试的实际运行结果未核实（无权运行命令）。

## 侧重检查（先写，结论在后）

我走的最普通流程：用户请求 → `produce()` → `createSession`（`SettingsManager.inMemory` 含 `cacheWarming: "streaming"`，pi-runtime-adapter.ts:1405-1413）→ 运行 → 压缩 → 压缩后补发运行环境说明（:1701-1705，改动点）→ 三处失败回调改 `session.abort()`（:1390、:1660、:1692，改动点）→ `#continueForSteeredNotices`（:1232-1241，保留）→ `cancel()`（:1225-1230）。

结论：改动点本身在 adapter 侧只有 mock 级断言（压缩补发用例把 `sendCustomMessage` 换成了记录器）；ADR 声称存历史失败路径有两条真实 Pi 用例覆盖（未核实，未读到这两个用例的现文件）；「Pi 是否接受没有 `role` 字段的 environment 对象」这条路径没有任何真实 Pi 用例走到（见下面第 2 条），是本流程中最大的覆盖缺口。

## 发现的问题（按严重度从高到低）

1. **中** | `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts`（diff 中 `[D7]` settings 用例）| **settings 侧的 `[D7]` 用例在当前 Pi 1.5.0 上反向不会失败，不是回归测试**。ADR 0206 前提 7 自己写明「`cacheWarming` 1.5.0 默认 `"streaming"`」；也就是说把 `pi-runtime-adapter.ts:1409` 的 `cacheWarming: "streaming"` 删掉，`expect(modes).toEqual(["streaming"])` 在 1.5.0 下仍然通过（读到的前提陈述，Pi 默认值本身未核实）。它只在升到 1.5.1（默认 `"idle"`）后才起作用。| 证据：diff 中该用例仅断言 `modes` 等于 `["streaming"]`；ADR 前提 7 原文。| 建议：作者说法「用例锁住」应改述为「锁住升级后的默认值漂移」，ADR 决定第 5 条的措辞相应收窄；或在测试里临时 monkey-patch 默认值来真正反向验证。
2. **中** | `packages/runtime-pi/src/pi-runtime-adapter.ts:1701-1705` | **补发的 environment 消息丢了 `role: "custom"` 和 `timestamp`，Pi 端如何处理未核实**。旧代码 `session.agent.steer({ role: "custom", ...environment, timestamp: Date.now() })` 显式加 `role` 和时间戳；新代码直接传 `environment`。而 `runtimeEnvironmentMessage()`（runtime-environment-block.ts:114-121）返回 `{ customType, content, display, details }`，**没有 `role` 字段**。`session.sendCustomMessage` 是否会自行补 `role`/时间戳、是否校验字段，Pi 源码不可读，未核实；新测试只断言 mock 记到的 `{ customType, display }` 和 `{ deliverAs: "steer" }`，不验证 Pi 真实接受后的形状。| 证据：runtime-environment-block.ts:114-121 无 role；diff 中旧/新两行；测试断言体。| 建议：补一个真实 Pi 会话的用例，断言压缩后补发的消息最终进入会话历史时的完整形状（role、customType、时间戳），这是 I-73 式的「两端核对」缺口。
3. **低** | `packages/runtime-pi/test/configured-model-binding.compat.test.ts`（diff 中 `[D7]` binding 用例）| 反向用例方向正确（描述符带 `promptCache: { short: 300 }`，断言解析出的模型没有该属性），但 `as ConfiguredPiModelDescriptor` 强转关闭了对这个注入字段的类型检查；且「`providerModelConfig` 是否真的剥掉 `promptCache`」的实现未核实——若透传，此用例会失败，方向是对的。| 证据：diff 中 `promptCache: { short: 300 } } as ConfiguredPiModelDescriptor`。| 建议：可接受；若想更硬，断言应改为对 Pi 端实际请求体的观察而非模型属性。
4. **低** | 作者说明第 1、2 条 | 全部 Pi 内部行号引用未核实（node_modules 不可读）。因此「`sendCustomMessage(steer)` 等同 `agent.steer`」「压缩只在会话开的轮次发生」「`session.abort()` 多标记 `_agentRunAbortRequested`」这些**关键前提目前只依赖作者转述**；如果转述有误，改动点 1701-1705 的时机保证和 abort 语义都会失效。typecheck 能证明 `session.abort`/`sendCustomMessage` 方法存在，但证明不了行为。| 证据：工具对 node_modules 的 glob/grep 均失败。| 建议：在有依赖安装的环境里核对 agent-session.js 对应行，或用真实 Pi 用例（而非 mock）覆盖三处 abort 行为。

## 读代码证实的与推测的分开

**读代码证实**：保留清单与代码一致——`agent.continue()` 在 pi-runtime-adapter.ts:1238、:1788；`agent.steer` 在 :1392；`#continueForSteeredNotices` 在 :1232-1241；工具内部 `agent.abort()` 仍在 :1576、:1597、:1609。`cacheWarming: "streaming"` 确实加在 :1409。`check:prompt-prefix` 存在（package.json:55）且在 `check:steps`（:27）里。文档（guide 偏离表 D5/D7 行、设置一节）与代码状态一致。

**推测**（基于读到的前提转述，未核实）：`sendCustomMessage` 在运行中走 steer 队列、请求仍只追加；`session.abort()` 不死锁；binding 测试反向会失败。

## 必答问题逐条回答

1. **是否改变模型已见过的请求开头**：adapter 侧读到的改动都只影响「往队尾追加的 steered 消息」和「失败时中止」，未见触碰系统提示、工具定义、历史回放或遮盖结果；`runtimeEnvironmentAfterCompaction` 的触发条件（:130 与上一条环境相同则不发）未变。但「追加后 Pi 如何把它放进下一次请求、是否补 role/时间戳」依赖 Pi 内部——**未核实**，无法完全背书「只追加」。
2. **同一段文字是否变成不同字节**：新代码**删掉了** `timestamp: Date.now()`（旧 :1701 处），方向上是减少了非确定字节；但保留的 `agent.steer` 分支（:1392-1396）仍带 `timestamp: Date.now()`（既有，非本次引入）。`sendCustomMessage` 内部是否自己盖时间戳——未核实。未见新引入依赖前后文的遮盖或无序集合。
3. **自动检查与反向用例**：settings 侧 `[D7]` 反向在当前版本**不会失败**（问题 1）；binding 侧 `[D7]` 方向正确但实现未核实；`[D5-NOTICE]` 是真实 Pi 用例但未运行验证；三处 `.catch(() => session.abort())` 行为本身没有直接的 mock/真实断言，仅 ADR 声称存历史失败路径有两条既有真实 Pi 用例覆盖（未核实）。`check:prompt-prefix` 在 check:steps 中照常跑，但本次未核实其规则文件内容。
4. **每个值的两端核对**：`cacheWarming: "streaming"`——生产端 :1409，消费端 Pi 的 `settingsManager.getCacheWarmingMode()`（测试读取处）；键名/取值是否被 Pi 1.5.0 接受未核实，若测试真实通过则两端吻合。`session.abort()` / `sendCustomMessage`——方法存在于 `AgentSession` 类型应由 typecheck 保证（未运行）。**最大缺口**：`environment` 对象（无 `role`）交给 `sendCustomMessage` 后在 Pi 端的校验/规范化（问题 2）——这正是「只看改动本身、没问消费端是否接受」的 I-73 型风险，建议补真实 Pi 用例闭环。
