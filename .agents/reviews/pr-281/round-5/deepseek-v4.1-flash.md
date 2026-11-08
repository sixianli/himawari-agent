## 读代码证实的问题（按严重度从高到低）

### 1. 中：Magpie 中途退出时，在途请求可能漏记花费且不记 `costUnknown`

- 文件:行：`scripts/model-review/opencode-review.mjs:695-699`、`:763-769`、`:938-947`
- 问题：`inFlight` 被 `stopReason &&` 限制。Magpie 自己死掉、OpenCode 随之非正常退出时，`stopReason` 往往仍是 `null`，于是 `allowed > completed`（有请求已放行但未完成）被判成 `inFlight=false`；`spentOf` 就不会用 `max(cost+reserve, 0.2)` 的保守公式。
- 证据：
  ```js
  const marker = guardFiles ? readGuardMarker(guardFiles.markerPath) : null;
  const inFlight = Boolean(stopReason && marker && marker.allowed > marker.completed);
  ```
  ```js
  if (inFlight) usage.inFlight = true;
  ```
  ```js
  (record.costUnknown || record.inFlight
    ? Math.max(record.cost + WRAP_UP_RESERVE_USD, COST_LIMIT_PER_MODEL_USD)
    : record.cost)
  ```
- 补充：`gatewayRecordFields` 只有在 `requested && Object.keys(providers).length === 0` 时才补 `costUnknown`（`opencode-review.mjs:2473`）。如果 Magpie 死前已经写了几行用量、最后一笔在途请求没写，`providers` 非空，就既不记 `costUnknown` 也不计那笔花费。
- 建议：`inFlight` 去掉 `stopReason` 条件，直接按 `marker.allowed > marker.completed` 判断；或在 `gatewayRecordFields` 里把“放行次数 > Magpie 记录的请求数”也视为 `costUnknown`。这一行是既有代码，但本 PR 新增了“Magpie 子进程可能先死”的路径，正好踩中。

### 2. 中：0.2 美元/模型上限只管住 OpenCode 看到的花费，Magpie 内部重发/故障转移的真实花费不受它约束

- 文件:行：`scripts/model-review/spend-guard.mjs:82-101`、`scripts/model-review/opencode-review.mjs:2486-2490`、`:2776-2778`
- 问题：`withProviderMoney` 是**跑完之后**把账本 `cost` 提高到 Magpie 记录的 Go 实际花费；`spend-guard` 在请求发出前用的是 OpenCode 每个 `message.updated` 的 `info.cost`。Magpie 在同一笔 OpenCode 请求里先发给 CodeBuddy、断开后再转 Go 时，OpenCode 只看到一次完成的 step，guard 不会为被重发的那一段提前拦。
- 证据：
  ```js
  const guardCost = Math.max(0, ...runs.map((run) => run.guard?.totalCostUsd ?? 0));
  ...
  if (guardCost > usage.cost) usage.cost = guardCost;
  ```
  ```js
  export function withProviderMoney(record, creditProvider) {
    if (!record.gateway) return record;
    const money = providerMoneyUsd(record.providers, creditProvider);
    return money > record.cost ? { ...record, cost: money, costFromProviders: record.cost } : record;
  }
  ```
- 结论：`.agents/instructions/model-review.md:124` 的“花费上限不变……在请求发出前拦，每个模型 0.2 美元”在“OpenCode 可见费用”意义上成立；在“真实服务方花费”意义上不成立。账本事后能纠正，但不能阻止这次运行超花。
- 建议：文档明确这是“账本事后纠正，不是网关层硬上限”；若要硬上限，需要在 Magpie 侧或按放行次数估算转发开销。

### 3. 中：新增测试没有进入 `npm run check`，且真实 Magpie 用例依赖外网和下载真实二进制

- 文件:行：`package.json:27`（`check:steps`）、`ci/policy.json:19`、`:243`、`test/tooling/review-gateway.test.mjs:583`、`:825`、`:844`、`:956`
- 问题：
  - `npm run check` 的 41 步里没有任何一步执行 `test/tooling/review-gateway.test.mjs`；`check:ci-policy` 只做静态盘点/卫生检查，不执行它。作者说“npm run check 41 步通过”并不能证明这些用例通过。
  - 该文件会由 hosted CI 的 `policy` job 通过 `tooling` 项目执行（`scripts/ci/run.mjs:235-242`），但 `startGateway`/`startLiveGateway` 用例和自检用例调用 `install()` → `installGateway()` 下载真实 Magpie（`:583`），自检用例还会经 `opencodeBinary()` 安装 OpenCode；这要求 GitHub/npm/Bun 下载全部可用。`run.mjs:231` 对 `skipped` 也会报 `CI_TEST_INCOMPLETE`，所以这些用例不能被跳过。
- 建议：把该测试加入一个 `check:*` 步骤；把需要真实二进制/外网的用例注册成 qualification 或 `skipIf` 离线环境；其余用注入式 fake binary 覆盖。
- 反向用例本身：`withProviderMoney`、`gatewayRequested`、`creditsLeft`、`gatewayConfigProblems`、`summarizeGatewayUsage` 的单测是有的，但都只测函数，没有断言 `main` 真的调用了 `withProviderMoney`/`gatewayRequested`；删掉 `main` 里的调用不会被现有测试发现。

### 4. 低：`readStableUsage` 在并发/半行场景会误报 `costUnknown`（偏保守，不会漏记）

- 文件:行：`scripts/model-review/gateway.mjs:445-474`
- 问题：`readGatewayUsage` 对任何一行 `JSON.parse` 失败就整体返回 `null`；两个模型并发时，A 结束时 B 还在写，A 读到 B 的半行就会得到 `null`，`readStableUsage` 反复重试仍可能返回 `null`，A 被记 `costUnknown`。方向是保守（多记 0.2 美元），不是漏记，但会虚增后续预算。
- 证据：
  ```js
  try { lines.push(JSON.parse(entry)); } catch { return null; }
  ```
  ```js
  if (previous !== null && current !== null && current.length === previous.length) return current;
  ```
- 建议：忽略末尾不完整的一行（等下次），或按模型分别判断；`stableUsage` 可以只要求“本模型的最后一行稳定”。

### 5. 低：没有请求时 `gatewayRecordFields(null)` 也记 `costUnknown`

- 文件:行：`scripts/model-review/opencode-review.mjs:2466-2468`
- 问题：`usage === null` 直接返回 `unknown`，不看 `requested`。如果某次运行 OpenCode 根本没发出模型请求、Magpie 也没建 usage 文件，账本仍记 `costUnknown`，`spentOf` 会按 0.2 美元计，后续预算被虚增。
- 建议：`usage === null && !requested` 时返回 `{ gateway: "magpie", providers: {} }`。

### 6. 低：文档说 `GATEWAY_USAGE` 含 `dropped=`，代码只在真被丢弃时打印

- 文件:行：`scripts/model-review/opencode-review.mjs:2501-2504`、`.agents/instructions/model-review.md:124`
- 证据：
  ```js
  const dropped = record.gatewayDropped?.length
    ? ` dropped=${record.gatewayDropped.join(",")}`
    : "";
  return `GATEWAY_USAGE ${record.model} ${...}${dropped}`;
  ```
- 问题：文档“运行结束打印 `GATEWAY_USAGE`（含 `dropped=`）”与“第 3 轮：`GATEWAY_USAGE` 打印 `dropped=`”都暗示总是打印，实际没有 drop 时不出现。也没有测试覆盖 `gatewayUsageLine`。
- 建议：要么始终打印 `dropped=none`，要么把文档改成“有丢弃时含 `dropped=`”，并补一条单测。

### 7. 低：安装路径的 `curl`/`npm pack`/`tar` 没有超时

- 文件:行：`scripts/model-review/gateway.mjs:182-210`
- 问题：`curlDownload`、`npmPack`、`extractTarball` 都用 `spawnSync` 且未设 `timeout`；网络卡住时 `--gateway magpie` 会在安装阶段无限等待（`magpie` 子命令有 180s 超时，安装路径没有）。这是资源耗尽/可用性问题。
- 建议：给这三个命令加 `timeout`，失败时报 `GATEWAY_*_FAILED`。

### 8. 低：配置校验没覆盖组名唯一性和“去掉积分服务方后仍有成员”

- 文件:行：`scripts/model-review/gateway.mjs:309-315`、`:74-135`、`:320-323`
- 问题：`groupName(model) = review-${groupId(model)}`，`gatewayConfigProblems` 不检查两个模型短名是否相同；若以后加一个同短名的模型，`gatewayProvider` 的 `models` 会互相覆盖，`summarizeGatewayUsage` 的 `find` 也会只认第一个。另外校验不保证每个模型在 `dropProviders=[creditProvider]` 后还有成员；配置一旦改成只有 CodeBuddy 成员，积分低时不是“只走 Go”，而是 `GATEWAY_NO_MEMBERS` → `GATEWAY_PREFLIGHT_FAILED`。
- 建议：校验 `groupName` 唯一；校验每个模型至少有一个非 `creditProvider` 成员（或明确允许失败并写进文档）。

## 推测 / 未核实

- **美元折算偏低**：`gateway.mjs:421-437` 假设 `in` 不含 `cache_read`、`out` 不含 `reasoning`，缺 `cache_read` 时按 0。如果 Magpie 的 `in` 已含缓存 token，这里会**偏高**；如果 `in` 不含缓存且 Magpie 不写 `cache_read`，则会**偏低**。我没有 Magpie 真实 usage 行可核对，标未核实。建议用一次真实运行核对字段含义。
- **失败请求允许没有用量**：`summarizeGatewayUsage` 对非 2xx 用 `tokens`（缺省 0），所以失败请求若实际消耗了 token/积分但 Magpie 没记，会静默漏记。作者在第 3 轮明确这样选，属于已知取舍，不是代码错误。
- **`req` 字段格式**：所有汇总都要求 `req` 以 `group/` 开头且等于 `groupName(model)`。若 Magpie 在故障转移时把 `req` 记成上游模型名，这些行会被 `continue` 跳过，且不计 `unreadable`；只有在“该模型一行都没有”时才会 `costUnknown`。未核实真实格式。
- **`OPENCODE_ENABLE_EXA=1` 对 code-review 工具表的影响**：文档说“网页工具照样被权限禁止，自检会核对工具表”，但这是对 OpenCode 行为的假设；我没有运行验证。若 EXA 在 denied 权限下仍把 `websearch`/`webfetch` 加进工具表，自检会失败（作者称 code-review 自检已真实通过，故推测没问题）。
- **`creditsLeft` 对 Magpie 返回格式的假设**：第 4/5 轮已按 2026-11-07 真实 `magpie quota --json` 输出修过，`remaining` 按百分比解释、`amount` 做一致性校验；若某天 Magpie 把 `remaining` 改成绝对积分，代码会因 `remaining > 100` 返回 `null`（安全地不用 CodeBuddy），不是错误，但会误降级。

## 侧重检查

- **错误路径**：
  - Magpie 启动失败：`startGateway` 的 `serve` 失败会 `stop()` 并抛 `GATEWAY_START_FAILED`；`startLiveGateway` 带 CodeBuddy 时退回只用 Go，只用 Go 也失败才 `GATEWAY_PREFLIGHT_FAILED`；`probeGateway`/`selfCheck` 有 `finally` 停进程。结论：不会漏停。
  - 插件登录失败：在 `startGateway` 的 provider 循环里抛错，被 `startLiveGateway` 捕获并退回 Go；`startGateway` 此时还没 spawn `serve`，不会留下子进程。结论：不会漏停。
  - 查积分失败：`quota` 内部 catch 返回 `null`，`floorDecision` → `credits-unknown` → 去掉 CodeBuddy。结论：安全降级。
  - 用量记录缺失：`readStableUsage`/`readGatewayUsage` 返回 `null` → `costUnknown`，账本照写。结论：不漏写。
  - Magpie 中途退出：见问题 1，**可能漏记一个在途请求的花费且不标 `costUnknown`**。
  - 费用上限：见问题 2，guard 仍加载并在请求前拦，但不是网关侧硬上限。

- **不合规范或不可信的输入**：
  - `gateway.json`/`gateway-lock.json` 是仓库内提交文件，不是 PR 副本里的文件；`gatewayConfigProblems` 校验 routing/stays/creditFloor/creditProvider/providers.id/成员前缀/上限/单价，provider id 有正则和保留字限制，`signIn` 只允许 plugin。未发现可利用的命令注入（所有外部命令都用 `spawnSync` 数组参数，无 shell）。
  - Magpie 的 usage 行按不可信输入处理：非对象、数组、缺字段、非数字、未知服务方都计入 `unreadable` 或跳过；`__proto__` 不会污染原型（测试也断言了 `{}.requests` 未定义）。

- **安全**：
  - `gatewayProvider` 用 `isLoopbackURL` 拒绝非回环地址，占位密钥 `CLIENT_KEY` 只随回环地址出现；真凭证只在出口代理补，容器里是 `proxy-injected`。与 I-76 的直连门槛不冲突。
  - Magpie 程序按锁文件 SHA-256 校验，插件按 npm integrity 校验；每次运行前后校验程序摘要。插件安装后不再逐次校验，文档已写明。
  - `upgrade` 信任 `https://usemagpie.ai/api/latest` 的 SHA-256 并写进锁文件，没有独立签名；锁文件仍需人工复核。属已知设计，不是本 PR 新引入。

- **资源耗尽**：
  - 每次运行起多个 Magpie（自检 4 个左右 + live 1 个），都在临时目录、结束后 `stopAllGateways`。测试里最多同时 2 个。
  - 安装路径的 `curl`/`npm`/`tar` 无超时，见问题 7。
  - `readStableUsage` 最多等 2 秒，不会无限等。

- **不可撤销的操作**：
  - `installGateway` 只在 `~/.cache` 安装目录内 `rmSync` 程序/插件/临时下载；`cleanup` 只删本次 `workRoot`；`stopAllGateways` 只杀本进程登记的子进程。没有发现越界删除或误杀。
  - `cleanup` 在 `finally` 和信号处理里都会执行，重复执行是幂等的。

- **规则/文档与代码一致性**：
  - `.claude/rules/prompt-prefix.md` 第 4 条新增第四种例外，链接锚点 `#prompt-prefix-exception` 在 ADR 0178 存在。
  - `docs/kv-cache-guide.md` 改动记录已加。
  - `model-review.md` 与代码基本一致，唯一明确不一致是 `GATEWAY_USAGE` 的 `dropped=`（问题 6）。
  - `docs/incidents-and-gates.md` I-76 提到的 `test/tooling/review-gateway.test.mjs` 存在，`check:incident-gates` 的路径检查能通过。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - `--gateway` 关：不会。`reviewConfig` 在 `gateway` 为假时仍生成 `provider: { "opencode-go": {} }`，快照测试锁了六种直连配置的 SHA-256（`test/tooling/review-gateway.test.mjs:450-468`）。
   - `--gateway` 开：系统提示里的模型 id 从 `opencode-go/deepseek-v4.1-flash` 变成 `magpie/group/review-deepseek-v4.1-flash`，但每次复核轮次是新的 OpenCode 会话，单次会话内该值固定；`stays=session` 固定账号。每轮会变的积分/用量/时间只写日志和账本，不进入请求。
   - 唯一改变“已发出内容”的路径是 CodeBuddy 11128 插件改写系统提示，已在 ADR 0178 和规则第 4 条列为受控例外。
   - 结论：除该受控例外外，仍然只在末尾追加；没有把每轮会变的值放进系统提示或工具定义。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - 网关配置、模型 id、工具定义在单次会话内固定；Magpie 遮盖默认关闭；没有时间字段进入模型内容。
   - `stays=session` 只影响服务方选择，不改变发出去的字节；换服务方会让缓存整段重算，规则第 9 条允许。
   - 透传探针只比较“第一条带工具的请求”，且只归一化系统消息里的模型名；用户消息逐字比较。它不覆盖 CodeBuddy 插件改写，ADR 已写明。
   - 结论：没有发现新的不确定性来源；CodeBuddy 11128 改写是唯一已声明的例外。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - 有单测和反向用例（直连配置快照、配置校验、底线非数字、积分卡不一致、用量异常、`withProviderMoney`、`gatewayRequested`、`reserveModels`、真实自检 plan/code-review）。
   - 但新增测试文件**不在 `npm run check`** 里；只有 hosted CI 的 `policy` job 通过 `tooling` 项目执行它，其中 5 条依赖真实 Magpie 下载/OpenCode 安装/外网。`main` 对 `withProviderMoney`/`gatewayRequested` 的调用点没有集成测试。
   - 结论：有检查，但“npm run check 通过”不能证明这些用例通过；自动化覆盖不完整，见问题 3。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `gateway`、`providers`、`costUnknown`、`gatewayDropped`、`costFromProviders`：`parseUsage` 接受未知字段；`providers` 经 `providersValid` 校验；`gateway` 经 `GATEWAYS` 校验。
   - `gateway.json` 的每个键都被 `gatewayConfigProblems` 校验，并被 `gatewayProvider`/`groupArgs`/`priceOf`/`outputBounds`/`summarizeGatewayUsage` 使用；`gateway-lock.json` 被 `installGateway`/`gatewayInstallDir` 使用。
   - 两端校验基本对齐；发现两处不一致：`GATEWAY_USAGE` 的 `dropped=` 文档/代码（问题 6），以及 `inFlight` 的判定（问题 1，导致账本值偏低且不标 `costUnknown`）。
   - 另外 `costFromProviders`/`gatewayDropped` 没有专门的 schema 校验，但作为额外字段被 `parseUsage` 允许，暂不影响读取。
