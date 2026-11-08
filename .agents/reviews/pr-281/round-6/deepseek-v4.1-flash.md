## 读代码证实的问题（按严重度从高到低）

### 1. 中高 — 失败请求没有用量时被当成 0，且不记 `costUnknown`

文件：`scripts/model-review/gateway.mjs:427-445`、`scripts/model-review/opencode-review.mjs:2473-2475`

证据：

```js
const answered = line.status >= 200 && line.status < 300;
if (!answered) slot.failed += 1;
const count = answered ? required : tokens;
```

`tokens` 对 `undefined` 返回 0（`gateway.mjs:405`）。所以 5xx/断流请求即使缺 `in`、`out`、`credits`，也按 0 计价，且不会增加 `unreadable`。`gatewayRecordFields` 只比较请求条数：

```js
const recorded = Object.values(providers).reduce((total, slot) => total + slot.requests, 0);
const missing = recorded < Number(requested);
```

测试 `test/tooling/review-gateway.test.mjs:784-790` 还明确断言：502 且没有 `credits` 的 CodeBuddy 行不记 `costUnknown`。

问题：CodeBuddy 断开、Go 在读完提示词后报错等失败请求可能已经消耗 token/积分；账本记 0 且不标未知，事后 `spentOf`/`budgetCheck` 会偏低。请求前的 0.2 美元拦截本身没被改坏，但“不会漏记花费”的保证在这个错误路径上不成立。

建议：失败请求缺用量时也计入 `unreadable`（至少对非积分服务方），或给每次失败记一个保守下限；补一条“5xx 且无用量 → costUnknown”的反向用例。

### 2. 中 — `creditsPerUsd` 把 `none`/`unknown` 占位当成别的服务方，历史最大换算比可能偏低

文件：`scripts/model-review/gateway.mjs:373-383`、`scripts/model-review/gateway.mjs:421-431`

证据：

```js
const used = Object.keys(record.providers ?? {});
return used.length === 1 && used[0] === provider;
```

而空服务方会被记成 `none`：

```js
const provider = known.has(line.provider) ? line.provider : line.provider ? "unknown" : "none";
```

测试 `test/tooling/review-gateway.test.mjs:228` 也显示空服务方的失败请求会进入 `{ none: { requests: 1, failed: 1 } }`。

问题：一条实际只花了 CodeBuddy 积分、但夹着一条空服务方失败记录的账本，会因为 `used.length !== 1` 被排除在“历史最大换算比”之外。代码取最大值，排除记录只会让换算比偏低，预留变小，可能在剩余积分已经不够时仍保留 CodeBuddy，违背积分底线 20 的目的。这与文档“账本里只用了 CodeBuddy 的运行中最大的那个”不一致。

建议：判断“只用了 CodeBuddy”时过滤掉 `none`/`unknown` 占位，或改为“没有其他已配置的非积分服务方”；补一条带 `none` 槽位的换算比测试。

### 3. 中 — `gatewayRequested` 只按“至少 1 次”算，缺失用量可能漏判

文件：`scripts/model-review/opencode-review.mjs:2493-2496`

证据：

```js
const allowed = review.runs.reduce((total, run) => total + (run.guard?.allowed ?? 0), 0);
return Math.max(review.summary.usage.steps > 0 ? 1 : 0, allowed);
```

测试 `test/tooling/review-gateway.test.mjs:612-615` 把 `gatewayRequested(review(2, 0))` 断言为 1。

问题：如果费用插件的 marker 丢失/读不到（例如插件没加载、marker 写失败），`allowed` 为 0，而本次实际跑了 2 步以上，`requested` 仍只有 1。此时 Magpie 只要记下 1 条用量，`recorded < requested` 就不成立，缺失的用量不会被标成 `costUnknown`。这正是“费用插件没有生效”的错误路径。

建议：`steps` 本来就是请求数的下界，改用 `Math.max(review.summary.usage.steps, allowed)`；把测试改成 `review(2, 0) → 2`，并补“steps=2、allowed=0、只有 1 条用量 → costUnknown”的反向用例。

### 4. 低-中 — 预检失败不会退回只用 Go

文件：`scripts/model-review/opencode-review.mjs:2552-2562`、`scripts/model-review/opencode-review.mjs:2582-2599`

证据：退回只用 Go 的 `catch` 只包住 `start(...)`：

```js
try {
  live = await start(withCredit, join(workRoot, "gateway-live"));
} catch (error) {
  ...
  live = await start(
    withCredit.filter((provider) => provider.id !== config.creditProvider),
    ...
  );
}
```

后面的建组、`serve`、`/models` 预检失败则直接抛：

```js
} catch (error) {
  live.stop();
  throw error.message.startsWith("GATEWAY_PREFLIGHT_FAILED")
    ? error
    : new Error(`GATEWAY_PREFLIGHT_FAILED ${error.message}`);
}
```

问题：如果 CodeBuddy 插件能启动、登录也成功，但它的模型没有出现在 Magpie 的 `/models` 里（插件半坏），整轮复核会以 `GATEWAY_PREFLIGHT_FAILED` 停下，即使 Go 完全可用。这与 ADR“一家用不了就换下一家”的目标有张力；文档 `.agents/instructions/model-review.md` 又明确写“建组失败或成员缺失以 `GATEWAY_PREFLIGHT_FAILED` 停下”，所以这是设计/文档之间的取舍，不是纯代码错误。

建议：预检失败且 CodeBuddy 仍在组里时，重试一次 `drop = [creditProvider]`；如果坚持不重试，就在文档里写明“只有启动/登录失败才降级，预检失败必须整体停下”及原因。

### 5. 低 — `docs/kv-cache-guide.md` 仍写“例外三种”

文件：`docs/kv-cache-guide.md:59`、`docs/kv-cache-guide.md:110`

证据：

```md
| 4 | 已发内容不改、不重排、不删，只追加 | ... | 做到...；例外三种，见规则第 4 条 |
```

同文件改动记录却写：

```md
| 2026-11-07 | 第 4 条加入第四种例外：... |
```

问题：规则文件已经改成“四种”，指南总表仍是“三种”，文档自相矛盾。

建议：把第 59 行改成“例外四种”。

### 6. 低 — `npmPack` 外部命令缺失时没有带上 `error.message`

文件：`scripts/model-review/gateway.mjs:197-206`

证据：

```js
if (result.status !== 0) throw new Error(`GATEWAY_PLUGIN_DOWNLOAD_FAILED ${spec}`);
```

对比 `curlDownload`（`:191-194`）和 `extractTarball`（`:214-217`）都会带 `result.stderr ?? result.error?.message`。

问题：环境里没有 `npm` 时只报 `GATEWAY_PLUGIN_DOWNLOAD_FAILED @...`，看不到真正原因；“外部命令缺失时用 `error.message` 兜底”的说法对 npm 不成立。

建议：把 `result.stderr ?? result.error?.message` 拼进错误信息。

### 7. 低 — `gateway.mjs upgrade` 的 curl/npm 没有超时

文件：`scripts/model-review/gateway.mjs:709-727`

证据：

```js
const feedText = spawnSync("curl", ["-fsSL", GATEWAY_FEED_URL], { encoding: "utf8" });
...
const view = spawnSync("npm", ["view", name, "version", "dist.integrity", "--json"], {
  encoding: "utf8",
});
```

问题：手动升级时网络或 npm 挂起会一直卡住；复核主路径的下载/打包/解压都有 300 秒超时，这里没有。

建议：给这两个 `spawnSync` 加 `timeout`。

### 8. 低 — 新测试没有进入 `npm run check`

文件：`package.json:27`、`test/tooling/review-gateway.test.mjs`

证据：`check:steps` 中没有 `review-gateway`；CI 的 `policy` job 会跑 `tooling` 项目（`ci/policy.json` 的 `policy.projects = ["tooling"]`），所以 CI 有覆盖，但作者说的“`npm run check` 41 步通过”并没有运行这个新测试。

建议：如果希望本地门槛覆盖，加一个 `check:review-gateway` 或把 tooling 测试纳入 `check:steps`。

---

## 推测 / 未核实

- **中低 — Go 的美元折算可能偏低。** `gateway.mjs:405-406` 把缺失的 `reasoning`、`cache_read` 当 0；`gateway.mjs:437-444` 的公式是 `in*input + (out+reasoning)*output + cache_read*cache_read价`。如果 Magpie 的 `out` 不包含 reasoning token，缺字段时就会少算；测试 `review-gateway.test.mjs:781-783` 明确接受缺 `reasoning`/`cache_read` 的成功 Go 请求。未核实 Magpie 的字段语义，建议用真实 usage 核对，或把缺字段的成功请求记为读不懂。
- **中低 — `gateway.json` 的 `cost` 没有 `cache_write`。** `gateway.json:17,24` 只有 `input/output/cache_read`；`gatewayConfigProblems` 只校验这三个（`gateway.mjs:135`）；`gatewayProvider` 原样复制（`opencode-review.mjs:133`）。如果 OpenCode 对 cache write 按输入价计费而缺省为 0，0.2 美元上限会少算。未核实 OpenCode 的缺省行为，建议补 `cache_write` 或加一条 cache-write 步骤费用大于 0 的自检。
- **低-中 — CI 里并发安装 OpenCode。** 新的真实自检测试会启动子进程调用 `opencodeBinary()`（`review-gateway.test.mjs:968-1006`），`opencode-review.test.mjs` 也在 `:1441`、`:2051` 调用；`npmCi` 会先 `rmSync(prefix)` 再安装（`opencode-review.mjs:418-433`）。tooling 项目是 `fileParallelism: true`，两个文件并行时可能互相删缓存。建议测试用独立的 `HIMAWARI_OPENCODE_BIN` 或加锁。未实际跑并发，属推测。
- **低 — `gatewayDropped`/`costFromProviders` 没有在 `parseUsage` 里校验。** 它们只由本进程生成，`gatewayUsageLine` 只用于内存中的记录，所以目前不会从旧账本触发崩溃；但账本格式校验不完整。建议补上数组/数字校验。
- **低 — 作者说法 6 写“cleanup 里的 stopGateway”。** 代码实际调用的是 `stopAllGateways`（`opencode-review.mjs:2669-2672`），行为正确，只是命名不准确。

---

## 侧重检查

- **Magpie 启动失败**：`startGateway.serve` 的 `waitForGateway` 失败会 `stop()` 并抛 `GATEWAY_START_FAILED`（`gateway.mjs:682-687`）；`startLiveGateway` 包成 `GATEWAY_PREFLIGHT_FAILED`；`cleanup` 调 `stopAllGateways`。测试 `review-gateway.test.mjs:837-853` 覆盖“二进制无法启动且不残留进程”。
- **插件登录失败**：`magpie plugin login` 失败会让 `start()` 抛错，`startLiveGateway` 退回只用 Go；只有 Go 也失败才 `GATEWAY_PREFLIGHT_FAILED`。代码路径存在，但没有看到模拟真实 `plugin login` 失败的用例（现有 live-start 用例用的是 `accountUid: () => null`），未核实。
- **查积分失败**：`quota` 内部 catch 返回 `null`（`gateway.mjs:648-657`），`floorDecision` 返回 `credits-unknown`，随后 `drop = [creditProvider]`；`creditsLeft` 对格式不符/百分比与 amount 不符返回 `null`。单元测试覆盖 `creditsLeft`/`floorDecision`，但 `startLiveGateway` 里 quota 失败后的端到端路径没有单独用例。
- **用量记录缺失**：`readGatewayUsage` 读不到/坏行返回 `null`，`gatewayRecordFields` 在 `requested` 为真时记 `costUnknown`；但失败请求缺用量不记（见问题 1）。
- **Magpie 中途退出**：没有看到专门模拟“serve 中途被杀”的测试；代码上依赖 OpenCode 报 api-error + 用量缺失记 `costUnknown`，失败请求仍可能漏记（见问题 1）。
- **漏停进程**：`stopAllGateways` 在 `cleanup` 和中断信号里调用；测试 `review-gateway.test.mjs:941-965` 检查两个 Magpie 都被杀。结论：正常结束/中断路径已覆盖；`SIGKILL` 无法覆盖（文档已说明）。
- **资源耗尽**：安装 curl/npm pack/tar 300 秒、`workbuddyAccountUid` 30 秒、`getJson` 5 秒、`postJson` 60 秒、`magpie` CLI 180 秒、`waitForGateway` 60 秒；`upgrade` 无超时（见问题 7）。
- **不可撤销操作**：删除只发生在 `mkdtempSync` 的 `workRoot` 和 `~/.cache/himawari-magpie-*`；`stopAllGateways` 只杀登记过的子进程组。没有发现会碰生产目录的路径。
- **安全 / 不可信输入**：`isLoopbackURL` 只允许 `http://127.0.0.1`/`localhost`，占位 `apiKey` 只和回环地址一起出现；`desktopSignIn` 只写假 token `proxy-injected`；`summarizeGatewayUsage` 用 Map，非对象/数组/未知服务方/`__proto__` 都按读不懂处理；`gatewayConfigProblems` 校验 provider id、保留字、signIn、成员、上限、单价。未发现新的密钥泄露路径。
- **规则/文档与代码一致性**：`.claude/rules/prompt-prefix.md:35` 与 ADR 0178 的第四种例外一致；`.agents/instructions/model-review.md` 与代码大体一致；`docs/kv-cache-guide.md:59` 的“例外三种”不一致（问题 5）。作者说法 6 的 `stopGateway` 命名不准确。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

- 直连方式：`reviewConfig` 的输出与改动前逐字节相同（`reviewConfig` 只把 provider 行改成条件分支，`gateway` 未传时仍走原来的 `{ "opencode-go": provider }`）。测试 `review-gateway.test.mjs:82-87` 和快照测试 `:451-469` 锁住这一点。
- 经 Magpie：OpenCode 写进系统提示的模型名会从 `opencode-go/deepseek-v4.1-flash` 变成 `magpie/group/review-deepseek-v4.1-flash`。这是**系统提示里唯一已知的差异**，在一次复核运行内保持不变；每轮会变的 `head`/`base`/`previous`/`brief` 仍在 `buildPrompt` 的最后一条用户消息里（`opencode-review.mjs:290-299`）。透传探针只在系统消息里把模型名换回直连写法，用户消息和工具逐字节比较（`opencode-review.mjs:1742-1757`），能证明 Magpie 没有改用户消息/工具，但不能证明系统提示模型名差异不存在。
- 因此：**一次运行内仍然是只在末尾追加，每轮会变的值仍在最后一条消息里**；但“直连 ↔ 经 Magpie”跨轮切换时，系统提示前缀会因模型名不同而变，KV 缓存会整段失效。规则第 4 条的第四种例外只覆盖 CodeBuddy 11128 的改写，没有覆盖这个模型名差异；ADR 0178 把它当作路由本身的差异处理。如果要求跨轮严格逐字节相同，这个改动不满足。
- CodeBuddy 以 11128 拒绝后改写系统提示，是规则和 ADR 明确写出的例外；透传探针不覆盖插件，ADR 已说明。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- 复核提示本身：没有新增每请求变化的值。`at` 时间戳只进账本；`providers` 是账本字段，且 `summarizeGatewayUsage` 用 Map，顺序由 usage 文件决定；Magpie 的端口只进 OpenCode 配置的 `baseURL`，不进提示；模型名在一次运行内固定。
- 遮盖：Magpie 的敏感信息遮盖按文档保持关闭；透传探针用假邮箱检查未被遮盖。
- 已知例外：CodeBuddy 11128 后的插件改写会改变已发请求开头；服务方故障转移时 `stays=session` 保证不来回切，但换到新服务方时缓存要整段重算。这两点 ADR 已写明，不是本次新增的隐藏行为。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

- 有：`test/tooling/review-gateway.test.mjs` 覆盖配置快照、loopback 占位密钥、账本校验、积分卡片、配置校验、用量异常、透传、故障转移、预检失败、`stopAllGateways` 和真实自检。
- 运行位置：CI 的 `policy` job 跑 `tooling` 项目（`ci/policy.json`），所以会自动运行；本地 `npm run check` 的 41 步**不包含**它（见问题 8）。
- 反向用例：单元级断言是直接的（例如去掉 `providersValid` 后 `parseUsage` 用例会失败；去掉 `floor-invalid` 后 `floorDecision` 用例会失败）。但我没有实际运行，无法确认“去掉四处保护后对应用例都失败”的实测结论，标为未核实。
- 覆盖缺口：`creditsPerUsd` 没有带 `none`/`unknown` 的用例；`gatewayRequested` 的测试把“steps=2、allowed=0 → 1”固化成期望；失败请求无用量的用例反而断言不记 `costUnknown`。这些正是上面问题 1-3 的缺口。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

- `--gateway`：`parseArgs` 校验 `GATEWAYS`，子命令禁止使用；`main` 消费。OK。
- 账本 `gateway`：由 `gatewayRecordFields` 产生；`parseUsage` 要求它是 `GATEWAYS` 之一且 `providers` 合法；`creditsPerUsd`、`withProviderMoney`、`gatewayUsageLine` 消费。OK。
- 账本 `providers`：由 `summarizeGatewayUsage` 产生，`providersValid` 校验 `requests`/`failed`/`credits`/`usd`；`creditsPerUsd`、`providerMoneyUsd`、`gatewayUsageLine` 消费。**问题：`creditsPerUsd` 不能接受 `none`/`unknown` 占位（见问题 2）。**
- `costFromProviders`：由 `withProviderMoney` 产生，写入账本；`parseUsage` 不校验，当前没有消费者；不会破坏读取，但格式校验不完整。
- `gatewayDropped`：由 `main` 产生，写入账本；`gatewayUsageLine` 消费；`parseUsage` 不校验；只在内存记录上使用，目前安全，但账本格式校验不完整。
- 路由组名 `review-<短名>`：由 `groupName` 统一产生，`gatewayProvider`、`launchModel`、`groupArgs`、`summarizeGatewayUsage`、`asDirect` 都使用同一函数。一致。
- `gateway.json` 的 provider id：`gatewayConfigProblems` 用 `^[a-z][a-z0-9-]*$` 和保留字校验；`startGateway`、`groupArgs`、`creditsLeft`、`creditsPerUsd` 消费。OK。
- `creditProvider`：要求 `kind: "plugin"` 且带 `signIn`；`startLiveGateway`、`creditsLeft`、`creditsPerUsd`、`groupArgs` 消费。OK。
- `cost`：`gatewayProvider` 原样写进 OpenCode 配置，`summarizeGatewayUsage` 用它折算 Go 美元；`gatewayConfigProblems` 只校验 `input/output/cache_read`。**`cache_write` 未校验/未配置，可能让 0.2 美元上限少算（未核实）。**
- `gateway-lock.json`：`installGateway` 消费 `magpie.assets[platform].sha256`、`plugin.integrity`；`lockFromRelease` 只在 upgrade 时校验完整 feed；安装时逐项校验 SHA/integrity。OK。
- `REVIEW_MODELS`：没有改，账本 `model`、提示词文件名、`--models`、逐条判断仍用原全名；`launchModel` 只影响发给 OpenCode 的 `-m` 参数。OK。
- I-73 教训：新的 `magpie/group/review-*` 必须同时被 OpenCode 的 `provider/model` 解析和 Magpie 的 `group/<name>` 解析接受。代码里只有 `launchModel` 字符串拼接，没有单元级校验；证据是真实自检和 `.agents/reviews/topic-gateway-smoke-test/` 的实测。按 I-73 的标准，这一点目前靠端到端实测，不靠独立契约检查。
