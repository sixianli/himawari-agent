以下结论基于我亲自读到的代码和文档；测试没有运行（本轮只能读文件和执行 git 只读命令），涉及真实 Magpie/CodeBuddy 返回格式的地方标为「推测/未核实」。

## 一、读代码证实的问题

### 1. 中高：缺失的 token/积分字段被当成 0，既不记 `costUnknown`，也会让美元折算和积分预留偏低

- 文件:行：`scripts/model-review/gateway.mjs:375`、`scripts/model-review/gateway.mjs:397-409`
- 问题：`tokens()` 把 `undefined` 直接当 0；积分分支同样把缺失的 `credits` 当 0。这样 Magpie 用量记录里只要没有 `in/out/reasoning/cache_read/credits`，就不会增加 `unreadable`，`gatewayRecordFields` 也不会记 `costUnknown`。这和文档「不是数字的 token 和积分时，记 `costUnknown`」不一致。
- 证据：
  ```js
  const tokens = (value) => (value === undefined ? 0 : nonNegative(value) ? value : Number.NaN);
  ...
  const credits = tokens(line.credits);
  if (Number.isNaN(credits)) unreadable += 1;
  else slot.credits = (slot.credits ?? 0) + credits;
  ...
  const usd =
    (tokens(line.in) * price.input +
      (tokens(line.out) + tokens(line.reasoning)) * price.output +
      tokens(line.cache_read) * price.cache_read) / 1e6;
  ```
  `.agents/instructions/model-review.md:124` 写的是：「不是数字的 token 和积分时，记 `costUnknown`」。
- 影响：美元 `usd` 和 CodeBuddy `credits` 可能被静默记成 0；`creditsPerUsd` 的换算比可能偏低，积分预留变小，积分底线更容易被穿过。USD 花费上限仍主要靠 OpenCode 自己算的 `record.cost` 和自检的 `GATEWAY_COST_NOT_COUNTED`，所以不是直接的预算绕过，但账本和积分底线会偏低。
- 建议：区分「请求失败没有 usage」和「成功请求缺少 usage 字段」。对 2xx 请求，缺失 `in/out/credits` 应计为 `unreadable`/`costUnknown`；补一条「成功请求缺 token 字段」的反向用例。

### 2. 中：`live.usage()` 抛异常时，整条账本记录不会写，属于错误路径漏记花费

- 文件:行：`scripts/model-review/opencode-review.mjs:2722-2727`、`scripts/model-review/gateway.mjs:418-431`
- 问题：`gatewayRecordFields` 内部只包住了 `summarizeGatewayUsage`，但调用参数 `liveGateway.live.usage()` 在进入函数前就会执行。`readGatewayUsage` 在 `existsSync` 为真、`readFileSync` 失败（EACCES、EISDIR 等）时会直接抛出，导致 `runOne` 在写 `usage.jsonl` 之前中断。
- 证据：
  ```js
  ...(liveGateway
    ? {
        ...gatewayRecordFields(liveGateway.live.usage(), gateway.config, model),
        ...(liveGateway.drop.length ? { gatewayDropped: liveGateway.drop } : {}),
      }
    : {}),
  ```
  ```js
  export function readGatewayUsage(root) {
    const path = join(root, "config", "magpie", "usage.jsonl");
    if (!existsSync(path)) return null;
    const lines = [];
    for (const text of readFileSync(path, "utf8").split("\n")) {
  ```
- 影响：这与作者说的「读不到用量记录时记 `costUnknown`，账本这一行照样写」不符。一个模型读取用量失败会让 `Promise.all` 拒绝，另一个模型即使已经花了钱也可能来不及写账本。
- 建议：让 `readGatewayUsage` 捕获所有读取错误并返回 `null`，或在 `runOne` 里把 `live.usage()` 也包进 try/catch；补一条「用量文件读失败仍写 `costUnknown` 账本行」的用例。

### 3. 中：`startGateway` 没有监听子进程 `error`，启动失败可能以未捕获异常崩溃并跳过清理

- 文件:行：`scripts/model-review/gateway.mjs:614-628`
- 问题：`spawn()` 之后只挂了 `stderr`，没有 `child.on("error", ...)`。如果二进制无法执行（noexec 挂载、错误的执行格式等），Node 会发出未处理的 `error` 事件，通常直接以未捕获异常退出，`GATEWAY_START_FAILED` 和 `stop()` 都不会按预期执行。
- 证据：
  ```js
  child = spawn(install.binary, ["serve"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  runningGateways.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
  ```
  对照 `runOpencode` 有：
  ```js
  child.on("error", (error) => finish({ code: null, signal: null, spawnError: error.message }));
  ```
- 影响：错误路径不是清晰的 `GATEWAY_START_FAILED`，而且 `main` 的 `finally` 清理可能不执行，临时目录/已启动的子进程会残留。
- 建议：给 Magpie 子进程加 `error` 监听，记录错误并走 `stop()`/拒绝；`waitForGateway` 同时检查 `spawnError`。

### 4. 中：配置校验允许 `creditFloor: 0`，也允许把非登录插件服务方设为 `creditProvider`，积分底线仍可能被静默关掉

- 文件:行：`scripts/model-review/gateway.mjs:78`、`scripts/model-review/gateway.mjs:94`
- 问题：`creditFloor` 只要求非负，`0` 会通过校验并等价于关掉底线；`creditProvider` 只要求 id 存在，不要求它是 `kind: "plugin"` 且带 `signIn`。若误写成 `opencode-go`，`startLiveGateway` 会把它当积分服务方，低积分时反而把 Go 去掉，CodeBuddy 继续用，积分底线失效。
- 证据：
  ```js
  if (!nonNegative(config.creditFloor)) problems.push("creditFloor");
  ...
  if (!ids.includes(config.creditProvider)) problems.push("creditProvider");
  ```
  文档 `.agents/instructions/model-review.md:119` 说「不会让积分底线悄悄失效」。
- 建议：要求 `creditFloor > 0`（或明确文档化 0 表示关闭）；要求 `creditProvider` 必须是 `kind: "plugin"` 且有 `signIn`；补 `creditFloor: 0`、`creditProvider: "opencode-go"` 的反向用例。

### 5. 中低：Magpie 用量文件存在但为空时，不会记 `costUnknown`

- 文件:行：`scripts/model-review/gateway.mjs:418-431`、`scripts/model-review/opencode-review.mjs:2459-2468`
- 问题：文件缺失返回 `null`，会记 `costUnknown`；但空文件返回 `[]`，`byModel` 为空，`providers` 为 `{}`，`providersValid({})` 为真，于是返回 `{ gateway: "magpie", providers: {} }`，没有 `costUnknown`。如果 Magpie 没有写出用量记录（或写延迟），这次运行的 gateway 花费会被静默当作没有。
- 证据：
  ```js
  if (!existsSync(path)) return null;
  ...
  return lines;
  ```
  ```js
  const providers = byModel[model] ?? {};
  if (!providersValid(providers)) return unknown;
  return unreadable > 0 ? { ...unknown, providers } : { gateway: "magpie", providers };
  ```
- 建议：当本次确实有请求但 `providers` 为空时也记 `costUnknown`，或让 `parseUsage`/`gatewayRecordFields` 要求 gateway 记录至少有一个 provider（除非有明确的「零请求」记录）。

### 6. 低中：预检只看本次 `--models`，但所有 `REVIEW_MODELS` 的组都会建，替补模型的成员没有被预检

- 文件:行：`scripts/model-review/opencode-review.mjs:2501`、`2538-2546`、`2739-2763`
- 问题：`startGateway` 固定传 `models: REVIEW_MODELS`，`addGroups` 会给两个模型都建组；但 `missing` 只遍历 `models`（`options.models`）。当只跑 DeepSeek 时，GLM 作为失败替补不会被预检，可能到真正替补时才失败。
- 证据：
  ```js
  models: REVIEW_MODELS,
  ...
  const missing = models.flatMap((model) =>
    config.models[model].members.filter(...),
  );
  ```
  替补逻辑：
  ```js
  const { record } = await runOne(substitute.model, substitutePrompt, {
  ```
- 影响：不直接影响费用上限，但「DeepSeek 失败时 GLM 顶上」的可靠性没有预检兜住。
- 建议：预检时把可能替补的模型也纳入（至少 code-review + `--models` 单模型时），或者只给本次要跑的模型建组。

### 7. 低：文档说「每步费用必须大于 0」，代码只检查总费用大于 0

- 文件:行：`scripts/model-review/opencode-review.mjs:2188`、`.agents/instructions/model-review.md:125`
- 问题：`GATEWAY_COST_NOT_COUNTED` 用的是 `summarizeEvents(run.stdout).usage.cost > 0`，是整次运行的总费用；某一步为 0、其他步大于 0 时仍会通过。
- 证据：
  ```js
  if (gateway && !(summarizeEvents(run.stdout).usage.cost > 0))
    problems.push("GATEWAY_COST_NOT_COUNTED");
  ```
- 建议：要么按 `step_finish` 逐步检查，要么把文档改成「总费用必须大于 0」。

### 8. 低：初始 `start()` 失败没有包装成 `GATEWAY_PREFLIGHT_FAILED`，且 `uid` 存在时任何启动错误都会退化成「去掉 CodeBuddy」

- 文件:行：`scripts/model-review/opencode-review.mjs:2507-2517`、`2537-2553`
- 问题：只有 `addGroups`/`serve`/`/models` 预检阶段的失败会包成 `GATEWAY_PREFLIGHT_FAILED`；第一次 `start(withCredit)` 的失败会原样抛出。若 `uid` 存在但失败原因不是登录（例如 Go provider 配置或 Magpie 启动问题），代码也会去掉 `creditProvider` 再起一次，可能掩盖真正错误。
- 证据：
  ```js
  try {
    live = await start(withCredit, join(workRoot, "gateway-live"));
  } catch (error) {
    if (!uid) throw error;
    console.log(`GATEWAY_CREDIT_FLOOR ${config.creditProvider} sign-in-failed ${error.message}`);
    drop = [config.creditProvider];
    live = await start(withCredit.filter(...), ...);
  }
  ```
  文档 `.agents/instructions/model-review.md:123` 说「建组失败或成员缺失都以 `GATEWAY_PREFLIGHT_FAILED` 停下」。
- 建议：区分「登录失败」和其他启动失败；其他失败直接报 `GATEWAY_PREFLIGHT_FAILED`，不要静默去掉 CodeBuddy。

### 9. 低：透传探针的 `asDirect` 会全局替换模型名字符串，可能掩盖用户内容里的真实差异

- 文件:行：`scripts/model-review/opencode-review.mjs:1742-1751`
- 问题：`asDirect(JSON.stringify(via.messages))` 是对整个序列化后的 messages 做字符串替换。如果网关真的改了某段用户内容，而那段内容恰好包含 `magpie/group/review-...` 或 `group/review-...`，替换后可能看起来和直连一致；探针也只比较 `messages`/`tools`，不比较其他请求字段。
- 证据：
  ```js
  if (JSON.stringify(direct.messages) !== asDirect(JSON.stringify(via.messages), model))
    problems.push("GATEWAY_PASSTHROUGH_MESSAGES_CHANGED");
  ```
- 建议：只对已知的系统提示文本或解析后的字段做归一化，而不是对整段 JSON 字符串做全局替换；或至少把探针提示设计成不含这些字符串。

### 10. 低：未知服务方名会被当成 Go 按美元计价，可能让 CodeBuddy 的积分统计和预留失效

- 文件:行：`scripts/model-review/gateway.mjs:390`、`401-409`
- 问题：`provider` 不在配置 id 里时统一记成 `"unknown"`，然后走非 CodeBuddy 分支按 Go 单价折算美元。如果 Magpie 实际返回的服务方名和 `gateway.json` 不完全一致（例如插件名、大小写差异），CodeBuddy 的请求会被记成 `unknown` 的美元，而不是 `credits`，`creditsPerUsd` 也不会统计到它。
- 证据：
  ```js
  const provider = known.has(line.provider) ? line.provider : line.provider ? "unknown" : "none";
  ...
  const usd = (tokens(line.in) * price.input + ... ) / 1e6;
  ```
- 建议：未知服务方应记为 `unreadable`/`costUnknown`，或至少不要按 Go 价格静默折算；补一条「服务方名不在配置里」的用例，明确期望是 `costUnknown` 而不是美元。

### 11. 低：`gatewayDropped` 写进账本但没有消费方，文档也没提

- 文件:行：`scripts/model-review/opencode-review.mjs:2725`
- 问题：`gatewayDropped` 会写进 `usage.jsonl`，但 `parseUsage` 不校验、`spentOf`/`creditsPerUsd` 不读、`gatewayUsageLine` 不打印。它不影响正确性，但属于「产生了一个值，所有使用它的地方都能接受吗」的未闭环项。
- 证据：
  ```js
  ...(liveGateway.drop.length ? { gatewayDropped: liveGateway.drop } : {}),
  ```
- 建议：要么在报告/打印里使用它，要么删掉；如果保留，补 `parseUsage` 的接受测试和文档说明。

### 12. 低：现有自动测试没有覆盖「缺失 token/积分字段」和真实 CodeBuddy 的 credits/美元折算

- 文件:行：`test/tooling/review-gateway.test.mjs:621-624`
- 问题：真实 Magpie 的 live 用例只断言 `requests`/`failed`，没有断言 `usd` 或 `credits` 大于 0，也没有覆盖成功请求缺少 token 字段的情况；合成用例只覆盖了 `in: NaN`、`credits: "lots"`，没有覆盖 `in/out/credits` 完全缺失。因此问题 1 的行为不会被现有测试挡住。
- 证据：
  ```js
  const fields = gatewayRecordFields(live.usage(), gatewayConfig, deepseek);
  expect(fields.costUnknown).toBeUndefined();
  expect(fields.providers.probe).toMatchObject({ requests: 1, failed: 0 });
  ```
- 建议：增加「成功请求缺 `in/out/credits` 必须 `costUnknown`」和「真实 Magpie 记录至少产生非零 `usd`/`credits`」的断言；最好用一次真实 CodeBuddy 用量记录做夹具。

## 二、推测/未核实

1. **`creditsLeft` 对 Magpie 返回格式的假设**：`gateway.mjs:327-341` 假设 `remaining` 是 0 到 100 的百分比、`limit` 是总额、`amount` 是已用积分，并优先找名为 `"Total credits"` 的窗口。如果真实返回的 `remaining` 是绝对剩余积分，代码会返回 `null`，从而永远去掉 CodeBuddy。这个方向是安全的（不会超用），但会误伤；我未能读到真实 quota 响应，标为未核实。
2. **Magpie 用量字段名**：`in/out/reasoning/cache_read`、`req`、`provider` 这些字段名只在我读到的合成测试和 live 假服务方用例里出现。真实 CodeBuddy 用量记录是否同名、`req` 是否是 `group/review-*`、`provider` 是否等于 `gateway.json` 的 id，我未能核实；`.agents/reviews/topic-gateway-smoke-test/usage.jsonl` 被 git 守卫拒绝读取。
3. **Magpie 是否在每次请求后立即落盘用量**：代码在运行中调用 `live.usage()`，之后用 SIGKILL 停 Magpie。live 假服务方用例能读到 1 条记录，说明至少该版本是及时落盘的；但真实 CodeBuddy 路径是否也会在 SIGKILL 前完整落盘，未核实。
4. **`freePort()` 到 `serve` 之间的端口 TOCTOU**：`gateway.mjs:433-442` 先监听再关闭，随后 `serve` 重新绑定同一端口。容器内风险低，但理论上另一个本地进程可以先占用该端口，`waitForGateway` 可能误连到别的服务。未做实际复现。
5. **直接配置快照测试的 `process.cwd()` 归一化**：`test/tooling/review-gateway.test.mjs:444-462` 只把 `process.cwd()` 替换成 `<ROOT>`；如果测试不是从仓库根目录运行，或仓库路径经过符号链接，哈希可能对不上。作者说云端通过，我未运行。

## 三、侧重检查

- **错误路径**：
  - Magpie 启动/预检失败：`startLiveGateway` 的 `addGroups`/`serve`/`/models` 失败会包成 `GATEWAY_PREFLIGHT_FAILED` 并 `live.stop()`（`opencode-review.mjs:2537-2553`）；但初始 `start()` 失败未包装，且 `uid` 存在时任何启动错误都会退化成去掉 CodeBuddy（问题 8）。
  - `spawn` 失败：缺少 `child.on("error")`，可能未捕获崩溃并跳过清理（问题 3）。
  - 插件登录失败：有 fallback，去掉 CodeBuddy 只走 Go（安全）。
  - 查积分失败：`quota` 返回 `null` → `floorDecision` 返回 `credits-unknown` → 去掉 CodeBuddy（安全）。
  - 用量记录缺失：文件缺失 → `costUnknown`；文件为空 → 不记 `costUnknown`（问题 5）；读取抛异常 → 不写账本（问题 2）。
  - Magpie 中途退出：OpenCode 侧会得到 API 错误并写账本；用量可能不完整，但现有逻辑最多是 `costUnknown` 或偏低的 `providers`，没有让 USD 上限失效的直接路径；未做真实故障注入。
  - 费用上限：`spend-guard.mjs` 和 `reviewOnce` 的 guard 逻辑未被改动；自检 `guardProbe` 仍要求 `GUARD_PROBE_REQUESTS` 和 `GATEWAY_COST_NOT_COUNTED`。这部分没有被削弱。
- **不合规范/不可信输入**：`gatewayConfigProblems` 校验了 routing/stays/creditFloor/defaultCreditsPerUsd/providers id/kind/custom url/models、members 前缀、模型上限和单价（`gateway.mjs:73-120`）。缺口是 `creditFloor: 0` 和 `creditProvider` 的 kind/signIn（问题 4）；provider id 未检查控制字符（低风险，配置是仓库内文件）。
- **安全**：`gatewayProvider` 拒绝非回环 `baseURL`（`opencode-review.mjs:118-119`），`apiKey` 只和回环地址一起出现；`installGateway` 校验 SHA-256 和 npm integrity（`gateway.mjs:192-244`）；运行前后 `binaryProblem` 校验二进制（`gateway.mjs:246-250`）；临时目录按运行创建，`cleanup` 删除；没有发现新的密钥写入配置或日志。`freePort` TOCTOU 见「推测」。
- **资源耗尽**：自检按顺序启动/停止多个 Magpie，`stopAllGateways` 在 `cleanup` 和信号处理里调用（`opencode-review.mjs:2624-2634`）；`getJson`/`postJson`/`magpie` 都有超时；`waitForGateway` 最多 60 秒。未发现无界循环或未限制的并发 Magpie。
- **不可撤销操作**：`installGateway` 在摘要不符时会删除已下载的二进制/插件目录（`gateway.mjs:203-240`），这是设计内行为；`gateway.mjs upgrade` 会改写锁文件，但不在复核运行路径里。
- **文档/规则一致性**：
  - `.agents/instructions/model-review.md:124` 与 `summarizeGatewayUsage` 对「缺失 token/积分」的处理不一致（问题 1）。
  - `.agents/instructions/model-review.md:125` 的「每步费用必须大于 0」与只检查总费用不一致（问题 7）。
  - `.agents/instructions/model-review.md:119` 的「不会让积分底线悄悄失效」与 `creditFloor: 0`/错误 `creditProvider` 可通过校验不一致（问题 4）。
  - `.agents/instructions/model-review.md:123` 的「建组失败或成员缺失都以 `GATEWAY_PREFLIGHT_FAILED`」与初始 `start()` 失败未包装不一致（问题 8）。
  - `.agents/instructions/model-review.md:124` 未提 `gatewayDropped`（问题 11）。
  - 请求开头相关：`reviewConfig` 直连路径未改，`buildPrompt` 未改，新增的只是模型名/服务方标识；与 `.claude/rules/prompt-prefix.md` 第 4、6、8、9 条一致，CodeBuddy 11128 例外已在 ADR 0178 写明。

## 四、作者说法逐条核对

1. **基本成立**：`reviewConfig` 直连输出未改，`test/tooling/review-gateway.test.mjs:444-462` 锁了六种直连配置的 SHA-256；`gatewayProvider` 用 `isLoopbackURL` 拒绝非回环地址（`opencode-review.mjs:105-119`），I-76 的直连门槛不受影响。唯一补充：快照测试依赖从仓库根目录运行（见「推测」）。
2. **部分成立**：配置里确实按 Go 单价写了 `cost`（`opencode-review.mjs:126-134`），`guardProbe` 也确实检查了 `summarizeEvents(...).usage.cost > 0`（`opencode-review.mjs:2188`），`GUARD_PROBE_REQUESTS=3` 对应第 4 次被拦。但文档说「每步」而代码只检查总费用（问题 7）；另外 Magpie 侧的美元/积分折算缺失字段会偏低（问题 1），费用插件本身仍靠 OpenCode 的 `cost`，没有被削弱。
3. **部分不成立**：`gateway`/`providers` 字段和 `parseUsage` 的校验成立（`opencode-review.mjs:1459-1461`）；但「读不到 Magpie 的用量记录时记 `costUnknown`」在读取抛异常和空文件时并不成立（问题 2、5）；「不是数字的 token 和积分」中的「缺失」被当成 0，不记 `costUnknown`（问题 1）。`spentOf` 对 `costUnknown` 的保守公式确实存在（`opencode-review.mjs:938-947`）。
4. **基本成立，但有校验缺口**：`creditReserve`/`floorDecision` 的公式和「查不到就去掉 CodeBuddy」成立（`gateway.mjs:343-369`）；但 `creditFloor: 0` 和错误 `creditProvider` 能通过校验，不能完全保证「不会悄悄失效」（问题 4）。
5. **成立**：`installGateway` 按锁文件校验 SHA-256 和 npm integrity，不符删除并报 `GATEWAY_INTEGRITY_MISMATCH`（`gateway.mjs:192-244`）；运行前后 `binaryProblem` 检查（`opencode-review.mjs:2618-2621`、`2770-2775`）。补充：`binaryProblem` 只查二进制，不查插件文件内容（与现有 opencode 安装说明一致，但文档没在 gateway 一节重复说明）。
6. **基本成立**：配置/用量/登录都在临时目录（`gatewayEnv`，`gateway.mjs:252-268`），`cleanup` 调用 `stopAllGateways`，信号处理也调用 `cleanup`（`opencode-review.mjs:2624-2634`）。作者说的 `stopGateway` 实际已改成 `stopAllGateways`，不是问题。
7. **基本成立**：`passthroughProblems` 比较第一条带工具请求的 `messages`（归一化两个模型名后）和 `tools`（`opencode-review.mjs:1742-1751`），并检查假邮箱未被遮盖。补充：`asDirect` 是全局字符串替换，理论上可能掩盖用户内容里的真实差异（问题 9）；探针也不比较其他请求字段。

## 五、必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 直连方式：不会。`reviewConfig` 的直连输出与改动前逐字节相同（快照测试锁住），`buildPrompt` 未改。
   - 经 Magpie 方式：会改变 OpenCode 自动生成的系统提示里的模型名（`magpie/group/review-...` 代替 `opencode-go/...`），这是切换模型/服务方带来的头部变化；在同一个 `--gateway` 模式下，模型名和配置固定，不会每轮变化，也没有把时间、额度等每轮会变的值加进系统提示或工具定义。每轮会变的内容仍然只在最后一条用户消息里（`buildPrompt` 的 `material` 部分）。因此符合「同一模式内只追加」；直连↔Magpie 切换属于模型/服务方变化，规则允许重建，CodeBuddy 11128 是 ADR 0178 写明的例外。
2. **会不会让同一段文字在不同请求里变成不同的字节？**
   - 发给模型的内容：没有发现新的非确定性。gateway 的模型 id、`cost`、`variants`、`models` 顺序都由固定配置和 `REVIEW_MODELS` 顺序决定；`providers` 的键顺序取决于用量记录顺序，但账本不发给模型。
   - 账本：`summarizeGatewayUsage` 用 Map/`Object.fromEntries`，`providers` 的键顺序可能随用量记录顺序变化，导致同样的账本行字节顺序不同；这不影响模型请求，也不影响 `parseUsage`/`spentOf`，但如果要求账本逐字节可复现，需要固定 provider 顺序。
   - `desktopSignIn` 含 `expiresAt` 时间，但只写进 Magpie 的登录文件，不进入模型请求。
3. **有没有对应的自动检查，反向用例是否真的会失败？**
   - 有：`test/tooling/review-gateway.test.mjs` 覆盖直连配置快照、配置校验、积分底线非数字、积分卡片不一致、用量异常、安装摘要、live 启动、预检失败、停掉全部 Magpie、真实自检经 Magpie。
   - 已覆盖的反向用例（去掉保护后应对应失败）：配置字段缺失/拼错、`creditFloor` 非数字、`creditProvider` 未知、`stays` 非法、members 前缀错误、cost 缺失、积分卡片百分比/已用不一致、用量行不可读、安装摘要不符、预检成员缺失、Magpie 未停。
   - 未覆盖/不会失败的点：成功请求缺 `in/out/credits`（问题 1、12）；`live.usage()` 读失败（问题 2）；`startGateway` 子进程 `error`（问题 3）；`creditFloor: 0` 和 `creditProvider` kind 错误（问题 4）；空用量文件（问题 5）；真实 CodeBuddy 的 `credits`/`usd` 非零（问题 12）。另外这个测试属于 CI 的 `tooling` project（`ci/policy.json`），不在 `npm run check` 的 `check:steps` 里；作者说单独跑过，但 `npm run check` 本身不会跑它。
4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `gateway: "magpie"`：由 `gatewayRecordFields` 产生，`parseUsage` 用 `GATEWAYS` 校验，`creditsPerUsd` 用 `record.gateway === "magpie"` 过滤；两端一致。
   - `providers`：由 `summarizeGatewayUsage` 产生，值都是安全的整数/非负有限数；`parseUsage` 的 `providersValid` 接受，`gatewayUsageLine` 和 `creditsPerUsd` 按 `requests/failed/credits/usd` 使用；两端一致。空对象 `{}` 也被 `providersValid` 接受，导致问题 5。
   - `costUnknown`：由 `gatewayRecordFields` 产生，`spentOf` 消费；一致。但缺失字段/空文件时没有产生它（问题 1、5）。
   - `gatewayDropped`：产生后没有消费方，`parseUsage` 忽略、文档未提；不是错误，但未闭环（问题 11）。
   - 配置里的 `routing/stays/creditFloor/defaultCreditsPerUsd/providers/models/members/cost/output`：`gatewayConfigProblems` 校验，`groupArgs`/`gatewayProvider`/`outputBounds`/`summarizeGatewayUsage` 使用；大体一致。缺口是 `creditFloor: 0` 和 `creditProvider` 的 kind/signIn（问题 4），以及未知 provider 名的计价（问题 10）。
   - `gateway-lock.json` 的 `version/assets/sha256/plugin.integrity`：`installGateway` 消费，`gatewayInstallDir`/`lockFromRelease` 产生；两端一致。
   - 结论：主要的 I-73 类风险不在「格式过不了校验」，而在「缺失字段/空用量时没有把不确定性传播成 `costUnknown`」，以及「配置校验没有覆盖会让积分底线失效的取值」。
