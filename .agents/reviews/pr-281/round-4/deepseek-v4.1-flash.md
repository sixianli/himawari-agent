## 侧重检查

我按错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致性逐项查了：

- **Magpie 启动失败**：`startGateway` 加了 `child.on("error")`，`waitForGateway` 轮询，失败时 `stop()` 并报 `GATEWAY_START_FAILED`；`startLiveGateway` 再包成 `GATEWAY_PREFLIGHT_FAILED`。测试覆盖了 spawn 失败和成员缺失。结论：正常路径成立。但 `waitForGateway` 只看 `child.exitCode`，不看 `signalCode`，被信号杀死时会白等满 60 秒（低）。
- **插件登录失败**：带 CodeBuddy 启动失败会退回只用 Go，并打印 `GATEWAY_CREDIT_FLOOR … start-failed`；只用 Go 也失败才报 `GATEWAY_PREFLIGHT_FAILED`。结论：降级逻辑成立；但任何非 CodeBuddy 原因的首次启动失败也会被标成 `start-failed`（低，误导性日志）。
- **查积分失败**：`quota` 捕获异常返回 null，`floorDecision` 返回 `credits-unknown`，随后去掉 CodeBuddy。结论：安全降级成立。
- **用量记录缺失/损坏**：`readGatewayUsage` 任何读错误返回 null；`readStableUsage` 等两次条数一致，最多 2 秒；`gatewayRecordFields` 出错或不合格记 `costUnknown`。结论：多数情况保守。但失败请求允许没有用量，且 `requested` 只看 `steps > 0`，存在漏记（见问题 3）。
- **Magpie 中途退出**：OpenCode 看到 api-error，记录仍写；`stableUsage` 读多少算多少；`cleanup` 会停进程。结论：进程不会残留，但花费可能少记（见问题 1、3）。
- **中断信号**：`cleanup` 停 Magpie 并删除整个 `workRoot`，被中断的运行没有账本记录，Magpie 的 `usage.jsonl` 也被删掉。结论：漏记花费且不可恢复（见问题 5）。
- **安全**：占位密钥只允许回环地址；二进制按 SHA-256、插件按 npm integrity；Magpie 环境变量走允许清单；真实凭证不在容器。结论：主路径成立。但 `gateway.json` 的 provider id/URL 没有约束（自定义 provider 可指向任意地址），配置本身仍是信任边界；插件只在安装时核对（文档已写明）。
- **资源耗尽**：`magpie` 有 180 秒超时和 64MB 缓冲；`getJson/postJson` 没有响应体上限，但只连本机 Magpie，且 failover 探针只请求 16 token；`stableUsage` 有上限；OpenCode 的 stdout 本来无上限（既有行为）。
- **不可撤销操作**：安装会删除并替换缓存里的 Magpie/插件；`stopAllGateways` 用 SIGKILL；中断时删除整个临时目录（含唯一的花费证据）。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 第 35 行仍写“例外只有三种”，ADR 0178 新增了第四种受控例外；`docs/kv-cache-guide.md` 的维护规矩要求改缓存行为时同步更新“改动记录”，本 PR 没有更新。详见问题 8。

---

## 读代码证实的问题

### 1. 中：账本总花费只认 OpenCode 的 `record.cost`，不认 Magpie 的 `providers.usd/credits`，Magpie 重试/故障转移会少记

`scripts/model-review/opencode-review.mjs:938-947`：

```js
export function spentOf(records) {
  return records.reduce(
    (total, record) =>
      total +
      (record.costUnknown || record.inFlight
        ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
        : record.cost),
    0,
  );
}
```

`scripts/model-review/opencode-review.mjs:2750-2756` 只把 `providers` 写进账本：

```js
...gatewayRecordFields(await liveGateway.live.stableUsage(), gateway.config, model, {
  requested: summary.usage.steps > 0,
}),
...(liveGateway.drop.length ? { gatewayDropped: liveGateway.drop } : {}),
```

`record.cost` 来自 OpenCode 的 `step_finish`，是 OpenCode 看到的最终响应费用。Magpie 在内部把同一请求转给多家（ADR 里实测“CodeBuddy 断开一次，5 次请求转给 Go”）时，OpenCode 只看到一次最终响应；`providers` 里的 `usd`/`credits` 只用于打印 `GATEWAY_USAGE`，不进入 `spentOf`、`REVIEW_SPENT_TOTAL` 或下一次 `budgetCheck`。如果失败的尝试实际消耗了 token/积分，或者同一请求被上游成功处理两次，账本会少记，0.2 美元上限也可能被突破。

建议：把 `providers.usd` 纳入保守花费（例如取 `max(record.cost, sum(usd))`，CodeBuddy 的 credits 按 `creditsPerUsd` 折算）；或至少当 `sum(providers.requests) > record.steps`、或某服务方 `failed > 0` 时记 `costUnknown`。需要反向用例：一个请求被 Magpie 转给两家、`providers` 合计高于 `record.cost`。

### 2. 中：`creditsLeft` 仍保留“单窗口任意名字”的回退，和第 4 轮“只认 Total credits”的说法不符

`scripts/model-review/gateway.mjs:333-335`：

```js
const window =
  windows.find((item) => item?.name === "Total credits" && item?.unit === "credits") ??
  (windows.length === 1 && windows[0]?.unit === "credits" ? windows[0] : undefined);
```

第 4 轮作者说“`creditsLeft` 只认 `name === "Total credits"` 且 `unit === "credits"` 的窗口”。但代码在只有一个窗口时，会接受任意名字的 credits 窗口。如果 Magpie 某次只返回 “Extra credits” 一个窗口（例如 Total 卡片缺失），`left` 会用 Extra 的额度算，可能把已经低于底线的 CodeBuddy 留下来。

测试 `[gateway] reads the credits left from Magpie's real quota output` 用的是三个窗口的真实输出，没有覆盖“只有一个非 Total 窗口”的反向用例。

建议：删掉单窗口回退，或要求 `name === "Total credits"`；补一条“只有一个 `name: "Extra credits"` 窗口时必须返回 null”的测试。

### 3. 中：文档说“OpenCode 发过请求但用量记录里没有这个模型的行”记 `costUnknown`，代码实际用 `steps > 0`

`.agents/instructions/model-review.md:124`：

> “……或者 OpenCode 发过请求但用量记录里没有这个模型的行，都记 `costUnknown`”

`scripts/model-review/opencode-review.mjs:2752-2753`：

```js
...gatewayRecordFields(await liveGateway.live.stableUsage(), gateway.config, model, {
  requested: summary.usage.steps > 0,
}),
```

`summary.usage.steps` 只统计 `step_finish` 事件。如果 OpenCode 发出了请求但在第一个 `step_finish` 之前就失败（api-error、Magpie 中途退出、连接断开），`steps` 仍是 0，而用量记录里也没有该模型的行；此时不会记 `costUnknown`，`record.cost` 为 0，`spentOf` 按 0 计。文档和代码不一致，且可能少记花费。

建议：用更直接的信号，例如 `review.runs.some((run) => (run.guard?.allowed ?? 0) > 0)`，或 `summary.usage.steps > 0 || review.outcome === "api-error"`；并补一条“请求在 step_finish 前失败且无用量行时记 costUnknown”的测试。

### 4. 中（测试缺口，行为未核实）：代码复核模式没有经 Magpie 的自检用例，且 `OPENCODE_ENABLE_EXA=1` 对所有模式无条件设置

`scripts/model-review/opencode-review.mjs:147-151`：

```js
export function gatewayOpencodeEnv(env = process.env) {
  const list = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").filter(Boolean);
  const merged = [...new Set([...list, ...LOOPBACK_NO_PROXY.split(",")])].join(",");
  return { NO_PROXY: merged, no_proxy: merged, OPENCODE_ENABLE_EXA: "1" };
}
```

`test/tooling/review-gateway.test.mjs:892-913` 的唯一真实自检用例只跑了 `--mode plan`：

```js
"scripts/model-review/opencode-review.mjs",
"--self-check-only",
"--mode",
"plan",
...
"--gateway",
"magpie",
```

`.agents/instructions/model-review.md:122` 只说 EXA 是“否则方案讨论没有网页搜索工具”，但代码对 code-review 也设置了。若 `OPENCODE_ENABLE_EXA=1` 会让 OpenCode 在 code-review 的请求里带上 `websearch`/`webfetch` 工具，`checkProbeRequests` 期望的 `["bash","glob","grep","read"]` 就会失败，主用途（代码复核）会卡在自检。权限 `deny` 可能已经把工具过滤掉，所以这不是已证实的 bug；但当前没有 code-review 经 Magpie 的自动用例，无法证明。

建议：补一条 `--mode code-review --gateway magpie --self-check-only` 的测试（可参考现有自检用例，必要时注入假上游）；并考虑只在 plan/plan-review 设置 `OPENCODE_ENABLE_EXA`，或在文档里写明 code-review 也设置且权限会过滤。

### 5. 中/低：中断时删除 Magpie 用量记录，且被中断的运行不写账本，花费无法核对

`scripts/model-review/opencode-review.mjs:2651-2661`：

```js
const cleanup = () => {
  stopAllGateways();
  for (const child of activeChildren) killProcessGroup(child, "SIGKILL");
  rmSync(workRoot, { recursive: true, force: true });
};
const onSignal = (signal) => {
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
};
```

`usage.jsonl` 在 `workRoot/…/config/magpie/usage.jsonl`。收到 SIGINT/SIGTERM 时，`cleanup` 先停 Magpie 再删 `workRoot`；此时 `runOne` 还没返回，账本记录还没写，唯一的实际用量证据被删掉。直接模式本来也不写中断记录，但 Magpie 模式多了一个可保留的用量文件，删掉后无法事后补账，也不会进入下一次预算。

建议：中断时先尽量读一次 `usage` 并写一条 `costUnknown`/部分记录，或把 Magpie 的 `usage.jsonl` 复制到 `options.out`（或打印 `GATEWAY_USAGE`）后再删；至少要留下可核对的证据。

### 6. 低：外部命令缺失时，错误路径会抛 `TypeError` 而不是约定的错误码

`scripts/model-review/gateway.mjs:170-176`：

```js
function curlDownload(url, target) {
  const result = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", target, url], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`GATEWAY_DOWNLOAD_FAILED ${url} ${result.stderr.trim()}`);
}
```

`gateway.mjs:189-193` 的 `extractTarball` 同样直接 `result.stderr.trim()`；`gateway.mjs:680-689` 的 `upgrade` 直接 `feedText.stderr.trim()`，并在 `npm view` 缺失时 `JSON.parse(null)` 后访问 `info.version`。

`spawnSync` 找不到命令时 `status` 为 null、`stderr` 为 null，`.trim()` 会抛 `TypeError`。这会让运维看到 “Cannot read properties of null”，而不是 `GATEWAY_DOWNLOAD_FAILED` / `GATEWAY_FEED_FAILED`。

建议：统一用 `(result.stderr ?? "").trim()`，并对 `view.stdout` 做非空/JSON 校验。

### 7. 低：`gatewayConfigProblems` 没有拦住与内部保留名冲突的 provider id，也没有限制 `signIn` 只能出现在 plugin 上

`scripts/model-review/gateway.mjs:84-97` 只校验 id 是非空字符串、唯一，`creditProvider` 是 plugin 且有 `signIn`；没有禁止 id 为 `"unknown"` / `"none"`，也没有禁止非 plugin 的 provider 带 `signIn`。

`scripts/model-review/gateway.mjs:394`：

```js
const provider = known.has(line.provider) ? line.provider : line.provider ? "unknown" : "none";
```

如果配置里真的有一个 provider 叫 `unknown`，用量行里的未知服务方会被误认成它；如果叫 `none`，空服务方的失败请求会被当成已知 provider。配置是可信文件，所以严重度低，但这是“生产/消费两端校验”没有对齐的例子。

建议：在 `gatewayConfigProblems` 拒绝 `unknown`/`none` 保留名；要求 `signIn` 只出现在 `kind === "plugin"`；对 id 增加控制字符/前导 `-`/逗号的限制。

### 8. 低：规则文件和缓存指南没有记录 ADR 0178 的受控例外

`.claude/rules/prompt-prefix.md:35` 仍写：

> “例外只有三种：第 6 条列出的换新；第 7 条……；第 12 条……”

ADR 0178 新增了“CodeBuddy 插件在 11128 拒绝时改写系统提示”的第四种例外，但规则文件没有更新；`docs/kv-cache-guide.md` 的“怎么维护这份文档”要求改缓存行为时在同一个 PR 更新“现状/已知差距/改动记录”，本 PR 也没有改。模型复核脚本确实是“发给模型的内容”的组装者，未来读规则的人不会知道这个例外。

建议：在规则文件第 4 条加一条指向 ADR 0178 的例外，或在 `docs/kv-cache-guide.md` 的改动记录里补一行；至少让两处互相链接。

### 9. 低：`startLiveGateway` 为所有 `REVIEW_MODELS` 建组，未请求的模型也可能让预检失败

`scripts/model-review/opencode-review.mjs:2514-2522` 的 `startOnce` 固定传 `models: REVIEW_MODELS`；`gateway.mjs:629-636` 的 `addGroups` 会遍历全部模型，`groupArgs` 在成员被全部 drop 时抛 `GATEWAY_NO_MEMBERS`。第 1 轮 D8 说“预检本来只看本次要跑的模型”，但建组阶段仍会碰到未请求的模型。当前 `gateway.json` 的 GLM 有 Go 成员，所以不会触发；如果以后 GLM 只剩 CodeBuddy 而 CodeBuddy 被 drop，只跑 DeepSeek 的复核会因 GLM 建组失败而整体 `GATEWAY_PREFLIGHT_FAILED`。

建议：把 `startGateway` 的 `models` 改成“本次请求的模型 + 可能的替补模型”（`reserveFor`），或只对请求的模型检查/建组。

### 10. 低：live-start 测试用了不稳定的 `live.usage()`，生产路径用 `stableUsage()`

`test/tooling/review-gateway.test.mjs:824`：

```js
const fields = gatewayRecordFields(live.usage(), gatewayConfig, deepseek);
```

生产路径 `opencode-review.mjs:2752` 已经改成 `stableUsage()`，但这条测试仍立即读文件；Magpie 异步落盘时可能读到空/半行，导致 `costUnknown` 使断言偶发失败。建议测试也改用 `await live.stableUsage()`。

### 11. 低：`summarizeGatewayUsage` 把 JSON 数组行当对象静默忽略，文档说“不是 JSON 对象的行”都算读不懂

`scripts/model-review/gateway.mjs:386-388`：

```js
if (!line || typeof line !== "object") {
  unreadable += 1;
  continue;
}
```

数组的 `typeof` 也是 `"object"`，会走到 `line.req` 为 undefined 后 `continue`，不计入 `unreadable`。如果只有这一行且 `requested` 为 false，就不会记 `costUnknown`。文档 `model-review.md:124` 说“记录里有不是 JSON 对象的行”都记，数组也算不是有效对象。建议加 `Array.isArray(line)` 判断，或文档改成“不是 JSON 对象的行（数组除外）”。

---

## 推测 / 未核实

- **`gateway.json` 的 Go 单价**：`scripts/model-review/gateway.json:17,24` 写的是 DeepSeek `input 0.15 / output 0.6 / cache_read 0.003`，GLM `0.15 / 0.5 / 0.03`。仓库里没有测试把这些数字和 OpenCode 内置目录或官方价格对照，我也无法上网或读取 OpenCode 的模型目录。若实际价格更高，0.2 美元上限和 `creditsPerUsd` 预留都会偏低；若更低则偏保守。作者“按 Go 单价写”这一条未核实。
- **`OPENCODE_ENABLE_EXA=1` 对 code-review 工具集的影响**：我没有 OpenCode 1.19.5 源码，无法确认权限 `deny` 是否会把 `websearch`/`webfetch` 从工具列表里过滤掉。plan 模式自检通过只能证明 plan 模式；code-review 是主用途但没有经 Magpie 的自动自检。
- **真实 CodeBuddy 插件路径**：自动化 live 测试用的是 `accountUid: () => null`（直接 drop CodeBuddy）或自定义 `probe` provider；没有测试真实的 `plugin add` + `plugin login` + `quota`。真实成员 id（`workbuddy-ai/deepseek-v4.1-flash-sg` 等）只靠运行时预检兜底，预检失败是 fail-closed，但配置拼错不会被自动测试发现。作者说的 smoke test 在 `.agents/reviews/topic-gateway-smoke-test/`，本环境是稀疏检出，且 `git show` 被记录路径守卫拒绝，我没读到。
- **“19 条测试”**：`test/tooling/review-gateway.test.mjs` 现在有 35 个 `it`，不是 19 个；这个数字应是旧轮次的，实测说法已过期。
- **“四处保护去掉后对应用例都失败”**：我没有运行测试，不能确认。从断言看，去掉 `stableUsage`、未知 provider 计数、preflight、spawn error 监听等保护，对应测试会失败；但单窗口回退、失败请求/重试计费、code-review 经 Magpie 自检没有反向用例。

---

## 作者说法逐条核对

1. **关着时配置逐字节相同、I-76 直连成立、Magpie 占位密钥只和回环地址一起出现**：成立。`reviewConfig` 的直连分支未改；快照测试锁住六种配置；`gatewayProvider` 拒绝非回环；`opencode-review.test.mjs` 的 I-76 用例仍覆盖直连。
2. **经 Magpie 时费用插件仍在请求前拦，`cost` 不为 0，自检 guardProbe 验证第 4 次被拦**：guardProbe 和 `GATEWAY_COST_NOT_COUNTED` 成立；但“按 Go 单价”未核实（见上）。另外 Magpie 内部重试/故障转移可能超过 OpenCode 的每请求 0.2 美元上限（问题 1）。
3. **账本多 `gateway`/`providers`，`parseUsage` 只对带 `gateway` 的行要求 `providers`，读不到时记 `costUnknown`**：成立；但“OpenCode 发过请求”用 `steps > 0` 判断，和文档不一致（问题 3）；失败请求允许没有用量，可能少记（问题 1）。
4. **积分底线公式和“查不到就 drop”**：公式成立；`creditsLeft` 的单窗口回退和“只认 Total credits”的说法不一致（问题 2）。
5. **安装按 lock 校验 SHA-256/npm integrity，不符删除并报错，运行前后核对程序摘要**：成立；插件只在安装时核对，文档已写明。缺外部工具时错误路径不够干净（问题 6）。
6. **临时目录、跑完删除、中断时停 Magpie**：正常结束成立；中断时用量记录被删且不写账本（问题 5）。
7. **透传探针只比较第一条带工具的请求，只还原系统消息里的模型名**：代码成立；只覆盖 DeepSeek 和第一条请求，不覆盖 CodeBuddy 插件（ADR 已写明）；code-review 模式没有自检（问题 4）。

第 2/3/4 轮的修改大部分与代码一致；明确的偏差是：`creditsLeft` 单窗口回退、“OpenCode 发过请求”与 `steps > 0`、“19 条测试”过期。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- **`--gateway` 关着时**：不会。`reviewConfig` 的直连输出和改动前逐字节相同，快照测试锁住；没有新增系统提示、工具定义、历史或遮盖。
- **`--gateway` 开着时**：这是一次新的运行/新的会话。系统提示里的模型名会从 `opencode-go/…` 变成 `magpie/group/review-…`，`-m` 也变；这是新配置本身，不是对已有请求的改写。同一次运行内模型名固定，没有新增每轮变化的值；提示词仍只在末尾追加一条用户消息。
- **运行中唯一会改请求开头的路径**是 ADR 0178 写明的 CodeBuddy 插件在 11128 拒绝时改写系统提示/挪进第一条用户消息；这是 Andy 同意的受控例外，规则文件尚未记录（问题 8）。
- **故障转移**会换服务方，但不改变字节；违反的是“同一对话同一服务方”的缓存规则（第 9 条允许故障切换，ADR 已说明）。
- **透传探针只验证第一条带工具的请求**，不验证后续请求；`stays=session` 的稳定性也没有自动测试。
- **未核实**：`OPENCODE_ENABLE_EXA=1` 是否会让 code-review 的工具集变化；若会，请求开头会变，自检会失败（问题 4）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- 脚本自己组装的提示词是确定的：没有时间戳，commit/brief/问题清单固定，`gatewayProvider` 按 `REVIEW_MODELS` 固定顺序建模型表，`gatewayOpencodeEnv` 只影响进程环境、不影响提示词。账本里 `providers` 的键顺序可能随用量行顺序变化，但账本不是发给模型的内容。
- 真正的风险是**遮盖**：代码没有显式关闭 Magpie 的敏感信息遮盖，只依赖“默认就关”；透传探针只检查一个假邮箱，其他遮盖（密钥、路径、名称）没有覆盖。若默认改变或被打开，同一段文字可能在不同请求里遮成不同字节。ADR 已把这个假设写出来，但代码没有强制。
- CodeBuddy 插件的 11128 改写是确定性的（同一插件进程、同一提示），但它依赖服务方行为，且不在透传探针覆盖范围内。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

- **有**：直连配置快照（六种配置的 SHA-256）、配置校验、底线非数字、积分卡片不一致、用量异常、未知 provider、稳定读取、透传 changed/masked/tools、二进制/插件 integrity、live preflight、spawn 失败、stopAll、真实 plan 模式自检。
- **反向用例看起来是有效的**：例如去掉 `stableUsage` 的等待会读到 1 行而不是 2 行；去掉未知 provider 计数会少 `unreadable`；去掉 preflight 会 resolve 而不是 reject；去掉 spawn error 监听会触发未处理的 `error`。但我没有运行测试，不能确认“四处保护去掉后都失败”。
- **缺口**：没有 code-review 经 Magpie 的自检；没有 `creditsLeft` 单窗口回退的反向用例；没有失败请求/重试计费的用例；真实 CodeBuddy 插件登录和真实成员 id 没有自动用例；透传只测 DeepSeek 第一条请求。当前测试文件是 35 条，不是作者说的 19 条。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

逐项核对结果：

- `--gateway`：`parseArgs` 只接受 `magpie`，子命令拒绝；消费方 `main` 按开关走直连/网关。**接受。**
- `gateway.json` 的 `routing/stays/creditFloor/defaultCreditsPerUsd/providers/creditProvider/models`：`gatewayConfigProblems` 校验，`gatewayProvider`/`groupArgs`/`startGateway`/`creditsLeft`/`creditReserve` 消费。**基本接受**；但 provider id 为 `unknown`/`none` 会与内部保留名冲突，非 plugin 的 `signIn` 没被拒绝（问题 7）。
- `gateway-lock.json` 的版本/URL/SHA-256/integrity：`installGateway` 消费；格式测试覆盖。**接受。**
- 账本 `gateway`/`providers`：`parseUsage` 要求 `gateway` 属于 `GATEWAYS` 且 `providers` 通过 `providersValid`；旧账本无这两个字段仍可读。**接受。**
- 账本 `gatewayDropped`：没有进 `parseUsage` 校验，只在 `gatewayUsageLine` 里 `.length`/`.join`；生产只对刚写出的数组调用，**低风险**。
- `providers.usd/credits`：`gatewayUsageLine` 消费；但 `spentOf`/预算不消费，导致问题 1。
- `creditsLeft` 的“Total credits”窗口：代码还接受单窗口任意名字，和作者说法不一致（问题 2）。
- `requested`：文档说“发过请求”，代码用 `steps > 0`（问题 3）。
- `OPENCODE_ENABLE_EXA`：文档只解释 plan 模式，代码对所有模式设置；code-review 没有自检（问题 4）。
- `REVIEW_MODELS` 身份：账本 `model`、提示词文件名、`--models` 都仍用完整名，**未改**。**接受。**
- 规则文件/缓存指南：ADR 0178 的受控例外没有同步到 `.claude/rules/prompt-prefix.md` 和 `docs/kv-cache-guide.md`（问题 8）。

总体：默认关闭时是安全的、直连配置和旧账本都没被破坏；打开网关后，最需要补的是**把 Magpie 的实际用量纳入总花费**、**收紧 `creditsLeft` 的窗口选择**、**用更直接的“是否发过请求”信号**，以及**补 code-review 经 Magpie 的自检**。
