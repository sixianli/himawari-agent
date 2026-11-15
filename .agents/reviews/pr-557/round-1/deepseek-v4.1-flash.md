我先看仓库结构和这次改动。
### 1. 高：1.5 秒静默并不等于历史已加载完，基线仍可能偏小
文件:行：`test/integration/product-path-browser.test.ts:6024-6038`

问题：`answersBefore` 只是某个瞬间的 DOM 计数；循环退出后还要 `fill`、等发送按钮可用（最多 20 秒）才真正点击。历史详情或消息正文在这段时间内完成加载时，发送后的总数仍会大于 `answersBefore + 1`，原来的失败模式会复现。

证据：

```ts
6024        const answers = phone.getByText(PLAIN_ANSWER);
6025        let answersBefore = await answers.count();
6026        for (let steady = 0; steady < 3; ) {
6027          await phone.waitForTimeout(500);
6028          const current = await answers.count();
6029          steady = current === answersBefore ? steady + 1 : 0;
6030          answersBefore = current;
6031        }
6032        await draft.fill(text);
6033        await uiExpect(target(phone, UI.send)).toBeEnabled({ timeout: 20_000 });
6034        await target(phone, UI.send).click();
6036        await uiExpect(phone.getByText(PLAIN_ANSWER)).toHaveCount(answersBefore + 1, {
```

读代码证实：`thread-control-center.tsx:683` 先 `setDetail(current)`，随后 `:687` 才异步 `loadPayloads`；每条消息的正文要等 `readText` 完成才从占位符变成文本（`chat-history.tsx:269` 使用 `contentByRef[...] ?? ...`）。因此详情加载完成后，历史正文仍可能陆续出现，间隔取决于网络和服务，没有 1.5 秒上限。`ThreadLoadingSkeleton` 只在 `!detail` 时显示（`thread-control-center.tsx:1789-1790`），也不能代表正文 payload 已全部读完。

推测：Hermes 上可能正是详情或某次正文读取超过 1.5 秒，所以这次修复不一定能修好作者观察到的失败。

建议：不要用固定静默窗口当同步点。优先把断言限定到新发送的这一轮：点击后按用户文本定位新的 `.chat-turn`，只在该 turn 内断言出现一条 `PLAIN_ANSWER`。如果确实要保留全局计数，应等待明确的加载完成信号（例如 `UI.conversationLoading` 消失，并等 `thread.detail` 和所有正文读取结束，或先从服务端拿到历史消息数），再把基线计数紧贴在点击前采集。

---

### 2. 中：作者“共享会话历史”的根因与仓库的路由/线程选择代码不一致
文件:行：`test/integration/product-path-browser.test.ts:6020`，`apps/control-center/src/app/router.ts:42-53`，`apps/control-center/src/thread-control-center.tsx:355,632-635`

问题：作者说手机页加载的是“共享会话的历史”，但按当前代码，`phone.goto(`${installation.origin}/`)` 打开的是根路由，没有 `selected` 参数；路由把 `objectId` 设为 `null`，线程组件随即 `setDetail(undefined)`，没有自动选中历史线程的代码。按这条路径，发送前不应存在历史 `PLAIN_ANSWER`，旧断言本应是 `0 → 1`，而不是 `0 → 7`。

证据：

```ts
6020        await phone.goto(`${installation.origin}/`);
```

```ts
42    if (url.pathname === "/") {
43      return {
44        kind: "matched",
45        state: {
46          afterCursor: valueOrNull(url.searchParams.get("cursor"), MACHINE_VALUE),
47          objectId: valueOrNull(url.searchParams.get("selected"), MACHINE_VALUE),
```

```ts
355   const selectedThreadId = route.objectId ?? null;
...
632         if (!selectedThreadId) {
633           setDetail(undefined);
634           succeeded();
635           return;
636         }
```

读代码证实：根路径不会被自动改写为某个历史线程；线程控制中心只在 `selectedThreadId` 非空时拉 `thread.detail`。未发现根路径自动选中“最后一段会话”的代码。

推测：作者在 Hermes 上看到“发送后 7 条”可能是别的构建、别的页面状态或另一条数据路径造成的；仅凭这句描述无法确认这次改动修的是真实根因。若真要在手机页验证共享历史，应显式打开目标线程 URL（例如带线程 id），并在 trace 里确认加载的是哪个线程。

建议：先用 Hermes 的 trace/network 记录确认手机页实际请求的 `thread.detail` 是哪个 thread、为什么根路径会显示历史；确认后再决定是修测试还是修路由/数据。若目标本来就是空白会话，不应把“共享历史”写进原因，也不应依赖历史数量做基线。

---

### 3. 中：稳定循环没有上界，计数持续变化时会耗尽整个场景超时
文件:行：`test/integration/product-path-browser.test.ts:6026-6031`，`:5669`

问题：`for (let steady = 0; steady < 3; )` 没有最大迭代次数或截止时间。只要 `answers.count()` 持续变化（历史正文分批出现、后台刷新不断追加、某轮仍在流式输出或重复插入消息），循环就永远不满足退出条件，直到外层 `productDescribe` 的 900 秒超时把整个用例杀掉，`accept-after-restart` 等后续场景也不会执行。

证据：

```ts
6026        for (let steady = 0; steady < 3; ) {
6027          await phone.waitForTimeout(500);
6028          const current = await answers.count();
6029          steady = current === answersBefore ? steady + 1 : 0;
6030          answersBefore = current;
6031        }
```

```ts
5669  productDescribe("product path: release acceptance in a real browser", { timeout: 900_000 }, () => {
```

读代码证实：循环唯一的终止条件是“连续三次计数相同”；计数持续变化时没有本地 deadline，也没有失败信息。

推测：正常历史加载最终会收敛，所以多数情况不会跑满 900 秒；但这属于依赖环境时序的偶发长等待，不是有保证的终止。

建议：用带超时的 `uiExpect.poll` 或自建 deadline（例如最多 10 秒）统计稳定值；超时后输出当前计数和页面状态，直接失败而不是吃掉整个验收用例的预算。更根本的做法仍是按新 turn 断言，见第 1 条。

---

### 4. 中：没有针对“历史晚于 1.5 秒到达”的反向自动检查
文件:行：`scripts/delivery-mode/browser-acceptance-gate.py:50-52`，`test/tooling/release-walkthrough-coverage.test.mjs:91-99`，`test/integration/product-path-browser.test.ts:6024-6038`

问题：现有自动检查只确认 `accept-phone-send` 这个场景存在并最终状态为 `passed`，没有检查基线等待逻辑本身。若把这段稳定循环删掉，在历史加载很快的环境里验收仍会通过；也没有一个用例故意把历史或正文延迟到 1.5 秒之后，去证明旧写法失败、新写法通过。提交说明写的是 `Layer-0-tests: none`（只改测试时允许），但这也意味着没有定向回归测试。

证据：

```python
50      for scenario in REQUIRED_SCENARIOS:
51          if statuses.get(scenario) != ['passed']:
52              found.append('BROWSER_ACCEPTANCE_NOT_PASSED ' + scenario + ' ' + json.dumps(statuses.get(scenario)))
```

```js
91  it("has a scenario body for every listed scenario name", () => {
...
96    const missing = releaseScenarios().filter(
97      (name) => !source.includes(`await scenario("${name}"`),
```

读代码证实：覆盖测试只检查场景名和函数体字符串，不检查里面的等待逻辑；验收门只检查场景状态。

推测：作者所说“Hermes 上真实重跑”是唯一能暴露问题的验证方式，但不是仓库内的自动检查，不能防止以后再改坏。

建议：增加确定性的浏览器用例或工具函数测试，用 `page.route` 把 `thread.detail` 或正文读取延迟到 1.5 秒以后，断言修复后的基线/新 turn 断言仍然正确；同时保留一个“旧写法会失败”的反向夹具，证明这段等待确实必要。

---

### 5. 低：快速模式提交缺少 `Fast-mode-checks:` 声明
文件:行：`DELIVERY_MODE:1`，`.agents/instructions/delivery-mode.md:32`，提交 `1b3c672b9`

问题：仓库当前是 `fast` 模式，规则要求提交说明用一行 `Fast-mode-checks:` 列出实际运行过的基本检查和主机/版本；`1b3c672b9` 的提交说明只有 `Layer-0-tests: none`，没有 `Fast-mode-checks:`。

证据：

```text
DELIVERY_MODE
fast
```

```text
以下规则在快速模式下仍然有效：`Layer-0-tests:` 提交说明行以及检查它们的仓库钩子；提交说明还要在一行 `Fast-mode-checks:` 中列出实际运行过的基本检查、在哪台主机和哪个版本上运行；...
```

读代码证实：提交消息是本文开头 `git show` 读到的完整消息，确实没有该行。

推测：可能实际跑过检查但漏写；也可能因为作者在云端无法运行而没跑。无论哪种，评审无法从提交记录确认基本检查执行情况。

建议：补上真实的 `Fast-mode-checks:` 行，写明 `npm run check`/`npm run build` 等实际执行位置和版本；如果没跑，应明确写出原因并走对应豁免流程，而不是留空。

---

## 侧重检查

- **稳定循环是否可能永不结束**：可能。计数只要一直变化，`for (steady < 3)` 就不会退出；唯一外层边界是 `productDescribe` 的 900 秒，因此表现为整个用例超时，而不是这条场景单独快速失败。
- **历史分批渲染、间隔超过 1.5 秒**：可能。`thread.detail` 完成后才 `setDetail`，正文由 `loadPayloads` 异步逐条读取并每 40ms flush（`thread-control-center.tsx:148-149,683-691`）；任何一次详情或正文读取超过 1.5 秒，基线就可能偏小。代码里详情不是逐页 `setDetail`，但正文确实是在详情显示后才陆续出现。
- **基线偏大**：读代码未找到当前路径下会让基线偏大的机制。同一线程的 `refresh` 会把 `previousDetail` 的消息与新消息按 `messageId` 去重合并，计数应单调不减；根路径发送前应为空会话。若将来根路由自动选中旧线程，或发送后切换到另一个线程，基线偏大才可能造成误失败，这次没有证据。标记为“未核实/推测”。
- **错误路径**：如果历史加载失败，`detail` 始终为空，循环会把 0 当成稳定值；随后发送按钮可能一直禁用，测试在 `toBeEnabled` 处失败。循环本身不区分“历史为空”和“历史加载失败”。
- **不可信输入/安全**：改动只涉及测试内的 DOM 计数，没有新增服务端输入、标识、配置键或密钥；没有不可撤销的生产操作。
- **资源耗尽**：除上述最多 900 秒的空转外，没有新的内存/文件/网络资源消耗。
- **规则与文档一致性**：`Fast-mode-checks:` 缺失；作者说“不涉及模型请求”不准确，这个场景本身会走 `releaseAcceptanceScript` 的模型请求，只是这次 diff 不改变请求内容；“共享会话历史”的根因描述与当前路由/线程选择代码不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 `git diff` 只改 `test/integration/product-path-browser.test.ts` 和复核简报，没有改生产端的提示词、工具定义、历史存储或遮盖代码。发给模型的内容仍应遵守“固定的在前、会变的在后、已发内容只追加”的规则（`.agents/instructions/prompt-prefix.md:27-36`）；每轮会变的值仍应只在最后一条消息里。需要说明的是，作者说“不涉及模型请求”并不准确：场景会通过本地模型脚本触发请求，只是这次改动不影响请求构造。实际 Hermes 请求字节未核实。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会由这次 diff 引入。改动没有新增时间字段、无序集合、遮盖逻辑或序列化格式；`answersBefore` 只是浏览器 DOM 计数，不会被写进模型请求。变化的只是测试等待时序，不是模型请求的字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 只有一个发布验收场景级别的检查：`browser-acceptance-gate.py` 要求 `accept-phone-send` 状态为 `passed`，覆盖测试只确认场景名和场景体存在。没有专门验证这次等待逻辑的测试，也没有“把历史延迟到 1.5 秒后仍能正确取基线”的反向用例；删掉这段循环在快速环境下仍可能通过。因此不能仅凭门禁证明旧失败会复现、新逻辑有效。`Layer-0-tests: none` 对只改测试是允许的，但也说明没有定向回归测试。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？** 新值只有 `answersBefore`（以及循环变量 `steady`）。`answersBefore` 在 `test/integration/product-path-browser.test.ts:6025,6030` 由 `answers.count()` 产生，在 `:6036` 作为 `toHaveCount(answersBefore + 1)` 的期望值消费；两端都是非负整数，Playwright 接受，没有跨接口的 schema/配置/清单校验问题，也没有新增标识或序列化格式。但语义上的两端没有对齐：产生端不校验“基线就是完整历史”，消费端却要求“之后只会多一条”。如果历史在基线后继续加载，消费端会收到错误的期望值。这是本条最值得按 I-73 教训补上的地方：要么把断言限定到新 turn，要么用明确的加载完成信号产生基线。
