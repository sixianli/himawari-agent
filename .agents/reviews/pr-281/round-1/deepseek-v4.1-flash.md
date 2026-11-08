## 侧重检查

按你的侧重先查了这些路径，结论如下：

- **Magpie 启动失败**：`serve()` 等不到 `/v1/models` 时 `stop()` 后抛出 `GATEWAY_START_FAILED`（`gateway.mjs:517-539`）；`startLiveGateway` 在 `serve`/预检失败时会 `live.stop()` 后抛错（`opencode-review.mjs:2520-2535`），复核不会在无网关的情况下继续。**失败关闭**。
- **插件登录失败**：`startLiveGateway` 捕获 `start(withCredit)` 的异常后去掉 CodeBuddy 重试（`opencode-review.mjs:2490-2499`）；但捕获范围是“所有异常”，错误原因会被打印成 `sign-in-failed`，可能误报。
- **查积分失败**：`quota()` 捕获异常返回 `null`（`gateway.mjs:498-507`），随后 `floorDecision` 返回 `credits-unknown` 并去掉 CodeBuddy（`gateway.mjs:296-303`、`opencode-review.mjs:2501-2518`）。**失败关闭**；但 `creditsLeft` 对返回格式的假设见下面第 4 条。
- **用量记录缺失**：`readGatewayUsage` 返回 `null` 时记 `costUnknown`，按 `spentOf` 的保守公式记账（`gateway.mjs:338-351`、`opencode-review.mjs:2457-2459`、`937-945`）。但“记录存在但内容异常”时会走到漏记账本/毒化账本的问题，见第 2 条。
- **Magpie 中途退出**：代码没有运行中监控或重启；复核会失败关闭，但中断请求可能已经消耗 CodeBuddy 积分而 `usage.jsonl` 只留下部分记录，账本可能少记。属于可接受的残余风险，建议至少在 `usage()` 读取不到本次组记录时记 `costUnknown`。
- **中断信号**：**会漏停 Magpie**，见第 1 条。
- **安全/不可信输入**：`summarizeGatewayUsage` 直接使用 Magpie 用量文件里的 `provider`/token 字段，存在写入 `NaN` 和原型污染风险，见第 2、6 条。
- **资源耗尽**：`curlDownload`、`npmPack` 没有超时（`gateway.mjs:100-116`），网络卡住会在复核前无限等待；`readGatewayUsage` 一次读完整文件。前者更值得修。
- **文档与代码一致性**：见第 7 条。

## 主要发现（按严重度）

### 1. 中：中断时 Magpie 可能漏停，且自检的网关完全不受 `stopGateway` 管理
文件:行：`scripts/model-review/gateway.mjs:517-539`、`scripts/model-review/opencode-review.mjs:2013-2021`、`2077-2081`、`2605-2616`、`2637-2646`

问题：作者说法 6“脚本收到中断信号时会停掉 Magpie（`cleanup` 里的 `stopGateway`）”不完全成立。`stopGateway` 要等 `startLiveGateway` 返回后才赋值；自检里的 `probeGateway` 网关则从未登记到 `stopGateway`。信号处理直接 `process.exit()`，会跳过 `finally`。

证据：

```js
// gateway.mjs
const child = spawn(install.binary, ["serve"], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
  detached: true,
});
```

```js
// opencode-review.mjs
const cleanup = () => {
  stopGateway();
  ...
  rmSync(workRoot, { recursive: true, force: true });
};
const onSignal = (signal) => {
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
};
```

```js
// opencode-review.mjs
liveGateway = await startLiveGateway(...);
stopGateway = () => liveGateway.live.stop();
```

自检里的网关（`selfCheck` 的 `live`、`guardProbe`/`passthroughProbe`/`failoverProbe` 的 `live`）都没有赋给 `stopGateway`。因此 Ctrl-C 发生在自检期间，或发生在 `startLiveGateway` 的 `serve()`/预检期间，Magpie 子进程会继续运行；`cleanup` 还会把它的临时 HOME 删掉。

建议：在 `startGateway` 里把每个 Magpie 子进程登记到一个模块级集合，`cleanup` 遍历全部停掉；或在 `startGateway` 返回前就把 `stop` 交给调用方登记。`onSignal` 应同步停掉所有已登记子进程后再退出。补一个用假 Magpie 脚本发 SIGINT、断言进程组消失的测试。

### 2. 中：用量记录处理抛错会让整条账本记录不写；异常 provider 名还会污染 `providers`/内置对象
文件:行：`scripts/model-review/opencode-review.mjs:2705-2713`、`scripts/model-review/gateway.mjs:310-336`、`scripts/model-review/opencode-review.mjs:1399-1413`

问题：`runOne` 在写账本前调用 `gatewayRecordFields` → `summarizeGatewayUsage`，但没有任何 `try/catch` 或字段清洗：

```js
...（gatewayRecordFields(liveGateway.live.usage(), gateway.config, model)）
...
appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
```

`summarizeGatewayUsage` 里：

```js
const price = priceOf(config, model);
const usd =
  ((line.in ?? 0) * price.input + ... ) / 1e6;
```

只要出现以下任一情况，就会在 `appendFileSync` 之前抛错，**这次复核已经花掉的钱不会写进账本**：
- 用量文件某一行解析成 `null`（`line.req` 直接抛）；
- `gateway.json` 某模型缺 `cost`（`price.input` 抛）；
- token 字段不是数字，算出 `NaN`，随后写进账本；下次 `parseUsage` 的 `providersValid` 会拒绝整份账本，导致后续复核全部无法读取。

另外 `byModel[model][provider] ??= ...` 里的 `provider` 来自用量文件；如果它是 `"__proto__"` 或 `"constructor"`，会读写 `Object.prototype`/内置对象，而不是创建一个普通字段（`gateway.mjs:317-320`）。

建议：对 `summarizeGatewayUsage` 的输入逐字段校验，非有限数字按 `costUnknown`/0 处理并限制 `credits >= 0`；在 `appendFileSync` 前用 `providersValid` 验证，失败则退回 `{ gateway: "magpie", providers: {}, costUnknown: true }`；用 `Object.create(null)` 或 `Map` 存 provider。补“用量文件含 `null`、缺 `cost`、`provider="__proto__"`、`NaN` token”的反向用例。

### 3. 中：`gateway.json` 没有校验，配置键拼错会让积分底线静默失效
文件:行：`scripts/model-review/gateway.mjs:66-68`、`296-303`、`238-244`，`scripts/model-review/opencode-review.mjs:2489-2518`

问题：`readGatewayConfig` 只是 `JSON.parse`，没有检查 `creditProvider`、`creditFloor`、`defaultCreditsPerUsd`、`routing`、`stays`、`models[].members` 之间的关系。两个直接失效路径：

```js
export function floorDecision({ left, reserve, floor }) {
  if (left === null || left === undefined) return { use: false, reason: "credits-unknown" };
  if (left - reserve < floor)
```

如果 `creditFloor` 缺失/为 `NaN`，`left - reserve < undefined` 为 `false`，于是返回 `{ use: true }`，CodeBuddy 不会被去掉。若 `defaultCreditsPerUsd` 缺失/非法，`reserve` 为 `NaN`，同样绕过判断。

如果 `creditProvider` 拼错，`drop = [config.creditProvider]` 后，`groupArgs` 按 `member.split("/")[0]` 过滤（`gateway.mjs:241-243`），没有任何成员被去掉，也**不会报错**，CodeBuddy 仍留在路由组里。

建议：在 `readGatewayConfig` 后加显式校验：`creditFloor`/`defaultCreditsPerUsd` 是有限非负数；`creditProvider` 必须出现在 `providers[].id` 且至少出现在一个 `models[].members` 前缀里；每个 `REVIEW_MODELS` 都有 `members/cost/context/output`；`routing/stays` 只接受已知值。校验失败直接报错，不要落到 `floorDecision` 的 fail-open。补“缺 `creditFloor`、`creditProvider` 拼错”的反向测试。

### 4. 中（推测，实际格式未核实）：`creditsLeft` 假定 `remaining` 是百分比，可能把剩余积分放大 `limit/100` 倍
文件:行：`scripts/model-review/gateway.mjs:268-278`、`test/tooling/review-gateway.test.mjs:240-245`

证据：

```js
const { limit, remaining } = window;
if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit < 0) return null;
return (limit * remaining) / 100;
```

测试夹具使用 `remaining: 95.488, limit: 250`，断言结果 `238.72`，即明确假设 `remaining` 是百分数。如果 Magpie 实际返回的是“剩余绝对积分”，那么 95.488 会被算成 238.72，可能让本应触发底线的运行继续使用 CodeBuddy。即便实际是百分比，测试也只是自造夹具，没有固定真实 Magpie 输出。由于无法读取 `.agents/reviews/` 的实测记录（被 `records-path` 拦截），这一条标为**推测/未核实**。

建议：用一次真实 `magpie quota workbuddy-ai --json` 的输出做夹具，并在代码里显式区分 `remaining` 与 `used`/绝对积分；格式不识别时返回 `null`（去掉 CodeBuddy），而不是猜一个乘数。补“绝对剩余积分”格式的反向用例。

### 5. 中低（推测）：自检只验证了请求数上限，没有验证经 Magpie 时 `step_finish.cost` 真的非零
文件:行：`scripts/model-review/opencode-review.mjs:2148-2187`、`713-719`、`gateway.mjs` 的 `gatewayProvider` cost（`opencode-review.mjs:132`）

`guardProbe` 配置的是：

```js
guard: { totalUsd: GUARD_PROBE_OPEN_USD, stopAfterRequests: GUARD_PROBE_REQUESTS },
```

它验证的是第 4 次请求被请求数上限拦住，而不是费用线。`runOpencode` 只有在 `step_finish` 的 `part.cost` 是有效数字时才累计费用：

```js
const stepCost = event.part?.cost;
if (!validCost(stepCost)) { ... stop("cost-unknown"); }
else cost += stepCost;
```

如果 OpenCode 1.19.5 对自定义 `@ai-sdk/openai-compatible` 服务方没有按配置里的 `cost` 计算费用（作者说法 2 依赖这一点），`part.cost` 可能一直是 0：费用插件会认为花费为 0，费用上限永远不会触发，只剩时间上限。现有测试没有覆盖这个组合；真实自检也无断言 `part.cost > 0`。作者说的云端真实运行可能证明了这一点，但我无法读取那份账本，因此标为**推测**。

建议：在 `--gateway magpie` 自检里加一条费用线探针（例如 `totalUsd` 很小、但不设 `stopAfterRequests`），或者用真实 OpenCode 经 Magpie 发一次带 token 的请求，断言 `step_finish.cost > 0` 且 guard 的 `totalCostUsd > 0`。

### 6. 低（安全/健壮性）：`summarizeGatewayUsage` 的 `provider` 键未白名单化，存在原型污染面
文件:行：`scripts/model-review/gateway.mjs:317-320`

```js
const provider = String(line.provider || "none");
byModel[model] ??= {};
byModel[model][provider] ??= { requests: 0, failed: 0 };
const slot = byModel[model][provider];
```

`provider` 来自用量文件。若值为 `"__proto__"`，`byModel[model][provider]` 读到的是 `Object.prototype`（非空），随后 `slot.requests += 1` 会写到内置对象上；`"constructor"` 同理。虽然 Magpie 是锁定摘要的本机程序，恶意/异常输出仍不应能改写全局对象。

建议：用 `Map` 或 `Object.create(null)`，并在写入前把 provider 限制为 `config.providers`/`config.creditProvider` 中的已知 id；未知 provider 归到 `"none"` 或直接记 `costUnknown`。

### 7. 低：测试没有真正锁住“直连配置与改动前逐字节相同”，也缺错误路径用例
文件:行：`test/tooling/review-gateway.test.mjs:68-73`、`435-460`

```js
it("[gateway] leaves the direct configuration exactly as it was when the gateway is off", () => {
  for (const mode of ["code-review", "plan", "plan-review"]) {
    expect(reviewConfig({ mode, gateway: undefined })).toEqual(reviewConfig({ mode }));
    expect(reviewConfig({ mode }).provider).toEqual({ "opencode-go": {} });
  }
});
```

第一条断言是当前实现和当前实现比较，**没有和改动前的配置快照比较**；它只能发现 `gateway: undefined` 与省略参数的分支不同，不能发现其他字段被改。现有 `[OpenCode 401]` 测试也检查了 `provider` 和 `apiKey`，但同样不是完整字节快照。

另外，`435-460` 的真实自检用例直接启动脚本，会通过 `installGateway()` 从 GitHub/npm 下载 Magpie 和插件，写入 `~/.cache`，依赖外网，不是 hermetic 测试；工具项目会包含这个文件，离线 CI 会失败。

缺少的负向/错误路径用例：
- 直连配置与旧版本快照逐字节比较；
- 配额返回绝对值/未知格式；
- 用量文件含 `null`、缺 `cost`、非数字 token；
- 插件登录失败、Magpie 启动失败、`serve` 后崩溃；
- SIGINT 后 Magpie 进程组消失；
- 经 Magpie 时费用上限（而不是请求数上限）真正生效。

建议：补直连配置的固定快照/哈希；把真实自检标成可选集成测试或注入假 `magpie` 程序；为 `startLiveGateway` 和 `summarizeGatewayUsage` 抽可注入依赖的错误路径测试。

### 8. 低：`startLiveGateway` 收到 `models` 参数，却仍对两个模型建组和预检
文件:行：`scripts/model-review/opencode-review.mjs:2470-2487`、`2501-2529`

`startLiveGateway({ ..., models })` 用 `models` 做预留计算，但 `startGateway` 收到的是 `models: REVIEW_MODELS`，预检也遍历 `models`（这里传入的 `models` 是完整两个模型）。因此 `--models deepseek-v4.1-flash` 只跑一个模型时，仍要求 GLM 的成员在 Magpie 模型清单里；GLM 服务方不可用会让只跑 DeepSeek 的运行以 `GATEWAY_PREFLIGHT_FAILED` 失败。建议传 `models` 给 `startGateway` 和预检，只配置/检查本次要跑的模型。

### 9. 低：说明文档有和代码不一致的残留说法
文件:行：`.agents/instructions/model-review.md:71`、`121`、`125`

- 第 71 行仍说“密钥不写进脚本生成的配置……只有自检连本机假服务器时才写假密钥”。开 `--gateway` 时，正式复核配置也会写 `apiKey: CLIENT_KEY`（`opencode-review.mjs:141`）；虽然新章节解释了这是回环地址上的假密钥，但这句话本身已经和代码不一致。
- 第 121 行说“复核脚本发现没装时自己调用它”，代码实际是直接调用导入的 `installGateway()`，并没有执行 `gateway.mjs install`，因此不会跑 `warmPluginRuntime`。
- 第 125 行说透传探针“逐字节相同”，代码只比较 `JSON.stringify(messages)` 和 `tools`，且都经过 `JSON.parse`/`JSON.stringify`，不是完整请求体的原始字节；遮盖检查也只验证了一条假邮箱。
- ADR 0178 说“透传探针会发现遮盖被打开”，但如果 Magpie 的遮盖规则不碰 `probe-owner@example.com`，探针不会失败。建议至少增加一个会被通用规则命中的假 secret，或直接读取 Magpie 配置断言遮盖关闭。

## 作者说法逐条核对

1. **部分符合**：直连分支代码确实仍走 `{ "opencode-go": provider }`（`opencode-review.mjs:174-176`），但“测试锁住逐字节相同”不成立，测试是当前实现自比。I-76 的 `apiKey` 约束在直连方式下成立；经 Magpie 时 `apiKey` 只和回环地址一起出现这一点由 `gatewayProvider` 的 `isLoopbackURL` 保证（`117-144`）。
2. **部分符合/未自动验证**：配置里确实写了 `cost`（`gateway.json`、`gatewayProvider:132`），guardProbe 也验证了第 4 次请求被请求数上限拦住；但没有自动检查“经 Magpie 时每步 `cost` 非零”。
3. **基本符合**：`gateway`/`providers` 字段和 `parseUsage` 的条件校验都在（`opencode-review.mjs:1458-1460`）；`usage === null` 时记 `costUnknown`（`2457-2459`）。但“读不到”的判定只覆盖文件缺失/整行 JSON 解析失败，不覆盖“记录存在但summary抛错”。
4. **基本符合，但配置未校验**：算法与代码一致；但 `creditFloor`/`defaultCreditsPerUsd`/`creditProvider` 缺失或拼错时可能静默放行，见第 3 条。
5. **符合**：安装时校验 Magpie SHA-256 和插件 npm integrity，不符报 `GATEWAY_INTEGRITY_MISMATCH`（`gateway.mjs:145-215`）；运行前后检查 Magpie 二进制摘要（`binaryProblem`）。未覆盖“安装后插件目录被改”的摘要复核。
6. **部分不符合**：临时目录和正常跑完删除成立；但信号路径不能保证停掉自检的网关和 `startLiveGateway` 启动窗口内的网关，见第 1 条。
7. **部分符合**：透传探针会比较第一条带工具请求的 `messages`/`tools`，并把模型名换回直连写法；但不是完整请求的原始字节，也只验证了一条假邮箱的遮盖，见第 7、9 条。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

就本脚本自己组装的内容而言，没有：它没有改提示词、系统提示、工具定义或历史拼装；账本里的 `gateway`/`providers`/`costUnknown` 不会发给模型。同一个模型在同一次运行里使用固定的 `magpie/group/review-*` 模型名，`NO_PROXY`/`OPENCODE_ENABLE_EXA` 只设置一次，OpenCode 的每轮请求仍在末尾追加。需要如实说明的例外有两个：

- CodeBuddy 插件在 11128 拒绝时会给系统提示加逗号或挪进第一条用户消息（`model-review.md:126`、ADR 0178 的受控例外），这是唯一会改变已发出前缀的路径，且是服务方/上下文相关行为。
- 从直连切到 `--gateway` 会改变系统提示里的模型名，方案模式下 `OPENCODE_ENABLE_EXA=1` 还可能改变工具集合；这是两次运行之间的变化，不适用于“运行中追加”。若把同一条对话从直连继续到网关，会换开头。复核脚本每次是新会话，所以本轮实际影响有限。

每轮会变的值（积分、用量、余额、端口、时间）都只进临时配置、日志或账本，没有进入消息。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

没有新增这类逻辑：没有依赖前后文的遮盖（Magpie 遮盖保持关闭），`desktopSignIn` 的过期时间、用量统计、provider 顺序都不进提示词；`REVIEW_MODELS`、`config.models` 的遍历顺序来自固定字符串/JSON 插入顺序。两个例外：

- CodeBuddy 的 11128 重写路径，可能让同一段系统提示在不同请求里以不同位置/字节出现；这是 ADR 0178 明确接受的例外，但没有被透传探针覆盖。
- 故障转移到另一家服务方不会改变字节，但会让缓存整段重算（规则第 9 条允许）。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有一些，但覆盖不均：

- 有反向用例：`parseUsage` 对 `gateway` 缺 `providers`、负 `credits`、未知 `gateway` 都拒绝（`review-gateway.test.mjs:163-186`）；安装摘要不符、插件 integrity 不符会失败（`346-425`）；非回环地址的 `apiKey` 会抛错（`94-102`）；透传改动/遮盖/工具丢失会失败（`306-320`）；`--gateway` 未知值会拒绝（`119-125`）。
- 但 `[gateway] leaves the direct configuration...` 不是与旧版本比较，而是当前实现自比，不能证明“逐字节相同”。
- 没有覆盖：真实 Magpie 配额格式、`creditsLeft` 绝对值格式、用量文件含 `null`/缺 `cost`/`NaN`、插件登录失败、启动失败、中途退出、SIGINT 漏停、经 Magpie 时费用线（而非请求数线）真正生效。
- “四处保护去掉后对应用例都失败”我无法独立验证（本环境不允许运行测试），只能确认代码里存在上述部分反向用例。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

逐个核对如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `gateway: "magpie"` | `gatewayRecordFields` 2457-2459 | `parseUsage` 1458-1460、`gatewayUsageLine` 2751、`creditsPerUsd` 282 | 一致 |
| `providers` | `summarizeGatewayUsage` 310-335 | `providersValid` 1399-1413、`gatewayUsageLine` 2462-2467、`creditsPerUsd` 287 | 形状校验存在，但写账本前未校验，可能写入 `NaN`/负值/原型键 |
| `costUnknown` | `gatewayRecordFields` 2458 | `spentOf` 937-945 | 一致，保守 |
| `gatewayDropped` | `opencode-review.mjs:2708` | 无消费者、无校验 | 目前是死字段；若以后加消费者需先定义格式 |
| `gateway.json` 的 `creditProvider` | 配置 | 配额查询、`drop`、`summarizeGatewayUsage`、`creditsPerUsd` | 未校验它是否属于 `providers[].id`/`members` 前缀；拼错会 fail-open |
| `creditFloor`/`defaultCreditsPerUsd` | 配置 | `floorDecision`/`creditsPerUsd` | 未校验；缺失/NaN 会让底线失效 |
| `routing`/`stays` | 配置 | `groupArgs` 拼到 CLI 参数 | 未校验，只会在 Magpie 命令失败时暴露 |
| `members` | 配置 | `groupArgs`、预检 2525-2529 | 预检能拦住成员缺失，但 `startLiveGateway` 对两个模型都预检 |
| `gateway-lock.json` 的 `sha256`/`integrity` | 锁文件 | `installGateway` | 安装时能失败关闭；`installGateway` 本身不校验格式，`lockFromRelease` 才校验 |
| `--gateway` | `parseArgs` 2405-2407 | `main` 2596-2602 | `GATEWAYS` 白名单一致 |

结论：账本里新增的 `gateway`/`providers`/`costUnknown` 的已知消费者都能接受；问题在**生产端没有做和消费者相同强度的校验**（第 2、3 条），以及 `gatewayDropped` 没有消费者/校验。

**未核实**：由于本环境不允许运行测试，且 `.agents/reviews/` 被 `records-path` 拦截，我无法核实真实 Magpie 的 `quota --json`、`usage.jsonl` 字段名/路径、`/v1/models` 的 id 形式、OpenCode 对自定义 provider `cost` 的实际计算，以及作者实测的账本内容。上述相关结论已分别标为“推测/未核实”。
