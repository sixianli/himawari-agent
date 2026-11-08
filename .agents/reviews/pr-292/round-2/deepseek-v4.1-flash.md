## 结论摘要

改动的主要机制是对的：`--providers` 只配置列出的服务方、CodeBuddy 在列内时仍走账号编号和积分底线；`--accept-unreviewed` 写入后仍以退出码 5 结束，提交账本后才放行；SIGINT、重试等待、替补三条叫停路径都接上了。但有几处和文档/作者说法不一致，其中「读不到 Magpie 用量时没有 `costUnknownWhy`」是作者第 2 轮明确声称已修、实际没修的地方。

我按工具限制只读了代码、测试文件和 git 差异，**没有运行测试**，所以「194 条通过」「`npm run check` 通过」「真实 Magpie 实测」均标为未核实。

---

## 读代码证实的问题（按严重度）

### 1. 中：读不到 Magpie 用量记录时，没有 `costUnknownWhy`，也不会打印 `GATEWAY_COST_UNKNOWN`、不会存原始用量

- 文件:行：`scripts/model-review/opencode-review.mjs:2565-2566`、`2938-2944`
- 问题：作者第 2 轮说「标“花费未知”时记 `costUnknownWhy`；`runOne` 这时打印 `GATEWAY_COST_UNKNOWN` 并把 Magpie 用量记录存到原始目录」。但 `usage === null` 这个最常见失败路径直接返回没有 `costUnknownWhy` 的 `unknown`；`runOne` 只在 `record.costUnknownWhy` 存在时才打印和存档。
- 证据：

```js
// 2565-2566
const unknown = { gateway: "magpie", providers: {}, costUnknown: true };
if (usage === null) return requested ? unknown : { gateway: "magpie", providers: {} };
```

```js
// 2938-2944
if (record.costUnknownWhy) {
  console.log(`GATEWAY_COST_UNKNOWN ${model} ${record.costUnknownWhy}`);
  writeFileSync(join(roundRawDir, `${name}.magpie-usage.jsonl`), ...);
}
```

而 `model-review.md:141` 明确把「读不到 Magpie 的用量记录」列为「都记 `costUnknown`，并记 `costUnknownWhy`」的情形。测试 `review-gateway.test.mjs` 里 `unknown(null, 1)` 只断言了 `costUnknown === true`，没有断言 why，所以这条缺口没有被测出来。

- 影响：钱的上限没有被削弱（`spentOf` 仍按 `costUnknown` 记 0.2 美元），但最需要排查的「用量文件根本读不到」场景反而没有原因、没有原始记录，和文档承诺不一致。
- 建议：`usage === null && requested` 时也返回 `costUnknownWhy: "usage-unreadable"`（或类似原因）；`catch` 和 `providersValid` 失败路径按文档统一补上原因，或者把文档改成「只有能读出用量时才记 why」。同时加一条断言 why 的测试。

### 2. 中低：API 报错后等待重试时叫停，账本 `outcome` 记 `api-error` 而不是 `owner-stopped`

- 文件:行：`scripts/model-review/opencode-review.mjs:888-891`；测试 `test/tooling/opencode-review.test.mjs:2109`
- 问题：作者第 2 轮说「返回第一次运行的结果（`retry: null`）」，测试也断言 `result.outcome` 是 `api-error`。但 `model-review.md:141` 说「Andy 叫停的记 `outcome: "owner-stopped"`：不上复核链、不算通过，也只有 `owner-stopped` 记录的那一轮不算“连续三轮没过”里的一轮」。这条路径叫停后账本记的是 `api-error`，会被算进「连续三轮没过」。
- 证据：

```js
// 888-891
if (decision !== "retry" || stopRequested)
  return { ...first, retry: decision === "retry" ? null : decision };
await waitUnlessStopped(retryWaitMs);
if (stopRequested) return { ...first, retry: null };
```

```js
// 测试 2109
expect(result.outcome).toBe("api-error");
```

- 影响：行为本身可以解释（第一次运行确实已经 `api-error`，叫停只是不重试），但和文档的笼统表述冲突；如果 Andy 连续在重试等待里叫停，`--report --stop three-rounds` 会把它们当成三轮失败。
- 建议：二选一，明确下来：要么在 `stopRequested` 时把 outcome 改成 `OWNER_STOPPED` 并在文档里说明「第一次运行的费用照记、但不计入三轮」；要么把文档改成「第一次运行已 `api-error` 时记 `api-error`，不记 `owner-stopped`」，并让 `three-rounds` 的语义与之一致。

### 3. 中低（边缘配置）：组是按 `reserveFor`（含替补模型）建的，缺成员检查却只看 `models`（本次要跑的模型）

- 文件:行：`scripts/model-review/opencode-review.mjs:2653`、`2718-2727`、`2862`
- 问题：`startLiveGateway` 用 `models: reserveFor` 建组，`reserveFor` 可能包含替补 GLM；但 `missingMembers()` 只遍历 `models`（本次要跑的模型）。如果某个不可用的服务方只服务替补模型，`missingMembers` 不会发现，随后 `addGroups()` 为替补模型建组时 `groupArgs` 抛 `GATEWAY_NO_MEMBERS`，整个复核以 `GATEWAY_PREFLIGHT_FAILED` 停下——即使本次要跑的 DeepSeek 还有可用成员。
- 证据：

```js
// 2653
models: reserveFor,
```

```js
// 2718-2727
const missingMembers = async () => {
  ...
  return models.flatMap((model) =>
    config.models[model].members.filter(
      (member) => !drop.includes(member.split("/")[0]) && !ids.has(member),
    ),
  );
};
```

```js
// 2862
reserveFor: reserveModels(options),
```

- 影响：和「一家服务方不可用不能让复核停下」的目标有张力。当前 `gateway.json` 里三家都同时提供两个模型，所以现在不触发；但 `gatewayConfigProblems` 并没有强制「每个服务方都必须有两个模型」，文档只是写了这条限制。
- 建议：建组只针对本次要跑的 `models`；替补组在真正需要替补时再建（或单独检查、不可用就跳过替补并打印 `REVIEW_SUBSTITUTE_SKIPPED`），而不是让替补模型把整轮预检拖垮。或者在 `gatewayConfigProblems` 里强制每个服务方都覆盖两个模型，把这个前提变成硬校验。

### 4. 低：`--report` 对伪造/损坏的 override 记录 `problems` 字段没有防御

- 文件:行：`scripts/model-review/opencode-review.mjs:1440`、`1528-1532`
- 问题：`parseUsage` 的 `overrideValid` 只校验 `head` 和 `quote`，不校验 `problems`。`reviewReport` 直接 `(record.problems ?? []).map(printable)`；如果账本里有一条手写的 override 记录把 `problems` 写成字符串或对象，`.map` 会抛异常，`--report` 直接崩掉。
- 证据：

```js
// 1440
`REVIEW_OVERRIDE_RECORD head=${record.head} quote=${printable(record.quote)} problems=${(record.problems ?? []).map(printable).join(",") || "none"}`
```

```js
// 1528-1532
const overrideValid =
  record?.mode !== "override" ||
  (COMMIT_PATTERN.test(record.head ?? "") &&
    typeof record.quote === "string" &&
    record.quote.trim() !== "");
```

- 影响：脚本本来就不防「有意伪造账本」，但这里连误写/旧格式都会让报告崩掉；文档又要求 `--report` 给 Andy 抽查用。
- 建议：在 `parseUsage` 里要求 override 的 `problems` 必须是字符串数组（允许缺省），或在 `reviewReport` 里先 `Array.isArray` 再 `map`，非数组时打印 `problems=invalid`。

### 5. 低：先写 Magpie 原始用量、再写账本；诊断写失败会丢这一条的账

- 文件:行：`scripts/model-review/opencode-review.mjs:2938-2945`
- 问题：`writeFileSync` 写 `<模型>.magpie-usage.jsonl` 在 `appendFileSync` 写 `usage.jsonl` 之前。磁盘满、权限问题等导致诊断文件写失败时，异常会抛出，这一轮的账本记录就不会写，和「宁可多记」相反。
- 证据：

```js
// 2938-2945
if (record.costUnknownWhy) {
  console.log(...);
  writeFileSync(join(roundRawDir, `${name}.magpie-usage.jsonl`), ...);
}
appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
```

- 建议：先 `appendFileSync` 记账，再写诊断文件；或者把诊断写入包在 `try/catch` 里，失败只打印警告，不影响记账。

### 6. 低：叫停重试等待时 `retry: null` 不会写进账本

- 文件:行：`scripts/model-review/opencode-review.mjs:2923`
- 问题：作者说「返回第一次运行的结果（`retry: null`）」，但 `runOne` 用真值判断展开 `retry`，`null` 会被省略。账本里既没有 `retry: null`，也没有 `owner-stopped`，只有 `outcome: api-error`，事后看不出是「被叫停所以没重试」还是「预算/时间不够没重试」。
- 证据：

```js
// 2923
...(review.retry ? { retry: review.retry } : {}),
```

- 建议：如果确实希望账本记下这次不重试的原因，显式写 `retry: null` 或写一个新的原因（例如 `retry: "owner-stopped"`）；否则把作者说法和文档改成「省略 `retry`」。

### 7. 低：ADR 和作者说法「所有成员都不可用才停下」与代码「任一模型无成员即失败」不一致

- 文件:行：`docs/adr/0178-review-model-calls-through-a-local-magpie.md:108`、`scripts/model-review/opencode-review.mjs:2706-2716`、`gateway.mjs:341-347`
- 问题：作者第 1 条说「每个模型都没有成员才 `GATEWAY_PREFLIGHT_FAILED`」，ADR 说「所有成员都不可用才停下」。代码实际是：`dropProviders` 去掉不可用服务方后，`groupArgs` 对任一没有成员的模型抛 `GATEWAY_NO_MEMBERS`，外层包成 `GATEWAY_PREFLIGHT_FAILED`。`model-review.md:140` 写的是「任何一个要跑的模型没有成员可用时」，这一句和代码一致。
- 证据：

```js
// gateway.mjs:341-347
const list = (members ?? entry.members).filter(...);
if (list.length === 0) throw new Error(`GATEWAY_NO_MEMBERS ${model}`);
```

- 影响：只是文档/说法不一致，不影响当前配置下的行为。
- 建议：把 ADR 和作者说法改成「任一要跑的模型没有可用成员就停下」，与 `model-review.md` 和代码一致。

---

## 推测（未证实）

- **叫停与重试的窄竞态**：`reviewModel` 在 `await waitUnlessStopped` 之后检查 `stopRequested`，如果信号正好落在这个检查和第二次 `reviewOnce` 的 `runOpencode` 注册之间，会真的 spawn 一次重试再立刻被 `stop` 掉，账本可能记 `retry: "retried"`、outcome 却是 `owner-stopped`。窗口很小，未复现，仅从代码顺序推测。
- **`hasControlCharacter` 不覆盖 U+2028/U+2029**：`--accept-unreviewed` 的原话如果包含 Unicode 行分隔符，会通过控制字符检查；`printable` 也不会 JSON 转义它，`--report` 打印时可能破坏报告行结构。这是既有缺口，但本 PR 新增的 `REVIEW_OVERRIDE_RECORD` 让它更容易被看到。属推测，未构造输入验证。
- **真实 Magpie 的 `knows no model "..."` 消息格式**：代码用正则 `knows no model "([^"]+)"` 提取成员名；如果真实 Magpie 的消息没有引号，就不会走「去掉这一家」而是直接 `GATEWAY_PREFLIGHT_FAILED`。作者说实测过，我没有真实 Magpie，未核实。
- **测试结果**：作者说两组 194 条通过、`npm run check` 通过、真实 Magpie 下 OpenDesign 地址不可达时由 CodeBuddy 回答，均未运行核实。

---

## 侧重检查

我按你的额外侧重查了这些路径：

- **错误路径**：`startLiveGateway` 的 `addGroups`/`missingMembers`/`serve` 失败、`getJson` 非 200、`GATEWAY_NO_MEMBERS`、CodeBuddy 启动失败回退、`stableUsage` 读不到。结论：会以 `GATEWAY_PREFLIGHT_FAILED` 停下或按预期回退；读不到用量时 `costUnknown` 生效，但缺 `costUnknownWhy`（见问题 1）。
- **不合规范/不可信输入**：`--providers` 的控制字符、空 id、未知 id、与 `--self-check-only`/`--gateway direct` 组合；`parseUsage` 的 `gatewayDropped`、override 的 `head`/`quote`/`problems`；Magpie 用量行的非对象、未知服务方、`__proto__`、非数字 token/积分。结论：主要路径有校验，`--providers` 未知 id 在读材料和安装前失败；`problems` 未校验（问题 4）。
- **安全**：跳过复核只能由 `--accept-unreviewed` 参数或已提交的 override 记录触发；脚本验证不了原话来源，已提交记录被信任，这一点文档已承认。没有发现「PR 描述/模型答案自动触发」的代码路径。
- **资源耗尽**：`--providers` 不改变每模型 0.2 美元上限和总预算检查；叫停时 `inFlight` 走「已记费用 + 0.05」和「0.2」取大，方向是宁可多记。诊断文件先于账本写入是一个小的丢账风险（问题 5）。
- **不可撤销的操作**：override 写入是追加，写入后本轮仍以 5 退出，要求提交后重跑才放行；工作区账本与 HEAD 不一致时拒绝写入。符合文档。
- **规则/文档与代码一致**：发现三处不一致：`costUnknownWhy` 的适用范围（问题 1）、叫停重试等待的 `outcome`（问题 2）、ADR「所有成员都不可用」的措辞（问题 7）。其余 `--providers`、积分底线、override 流程与 `model-review.md` 基本一致。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本次改动没有动 `buildPrompt`、`reviewQuestions`、`MODEL_LENSES` 或 `reviewConfig` 的提示词部分。新增的「Andy 怎样控制复核」一节位于 `<a id="checklist"></a>` 之后、另一个 `##` 标题下；`reviewQuestions()` 只截取 checklist 到下一个 `<a id="...">`/`##` 之间的内容，所以这一节不会变成必问问题，也不会进入提示词。`buildPrompt` 仍然是「固定说明 + 本次材料」拼成一个用户提示；每轮变化的 `head`、`base`、`previous` 和 `brief` 都在末尾的「本次材料」里。叫停、`--providers`、用量统计都不改提示词字节。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会（就模型请求而言）。** 改动没有引入时间戳、随机值或依赖上下文的遮盖到提示词里；`--providers` 只改变由哪家服务方回答，不改变提示词。新增的 `at` 时间戳、`costUnknownWhy`、`GATEWAY_PROVIDER_DROPPED` 日志都只进账本/日志，不进模型请求。`summarizeGatewayUsage` 的输出是确定性的（Map/Set/对象遍历顺序固定），也不面向模型。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有对应测试，但覆盖不完整。我读到的、看起来是真正反向用例的有：

- `waitUnlessStopped`：叫停后第二次调用应立即返回；如果不检查 `stopRequested`，测试会等 60 秒，超时失败。
- API 报错等待重试时叫停：如果不改用 `waitUnlessStopped`，测试会等 60 秒，超时失败。
- `--providers` 控制字符、空 id：不校验就不会抛 `ARG_INVALID --providers`。
- `--providers` + `--self-check-only`：不校验就不会抛 `ARG_PROVIDERS_NOT_FOR_SELF_CHECK`。
- `parseUsage` 的 `gatewayDropped`：不校验时 `[""]`/`[3]` 不会抛 `USAGE_LEDGER_INVALID`。
- `--report` 的 override 记录列出：不实现就不会出现 `REVIEW_OVERRIDE_RECORD`。
- 按模型区分读不懂行：不实现时 `glm` 的缺失 token 不会只让 `glm` 变成 `costUnknown`。

缺口：

- 没有测试断言 `usage === null && requested` 时必须有 `costUnknownWhy`、`GATEWAY_COST_UNKNOWN` 和原始用量文件；现有测试只断言 `costUnknown === true`。
- 没有端到端测试「向主进程发 SIGINT，确认账本写了 `owner-stopped`、Magpie/OpenCode 都被停掉」；现有测试只测了 `signalHandler` 和 `reviewModel` 两层。
- 没有测试 `--providers` 与积分底线的组合（列出 CodeBuddy 但积分低/查不到时是否真的去掉它）。
- 没有测试 `reserveFor`（替补模型）在缺成员时的预检行为。
- 没有测试叫停重试等待后账本里 `retry` 字段和 `outcome` 的实际序列化结果。

另外，我**没有运行**测试，所以「194 条通过」「`npm run check` 通过」未核实。

### 4. 每个新值/改动值，使用它的地方都能接受吗？

逐个核对结果：

- **`owner-stopped`**：`GUARD_DEFERS_TO_PARENT` 用它保留父进程判断；`reviewReport` 用它把这一轮排除出 `three-rounds`；账本 `outcome` 只要求非空字符串，能接受。问题在重试等待叫停时实际写的是 `api-error`（见问题 2）。
- **`costUnknownWhy`**：`runOne` 只在存在时打印和存档；`parseUsage` 不校验它（只靠 `hasLineBreak` 挡换行），没有消费者依赖它的格式。缺口是 `usage === null` 等路径不产生它（见问题 1）。
- **`gatewayDropped`**：生产端是 `liveGateway.drop`（配置里的 provider id，按 `gateway.json` 顺序）；消费端 `parseUsage` 新增了「非空字符串数组」校验，`gatewayUsageLine` 只读 `.length` 和 `.join`，能接受。
- **`--providers` 的 id**：解析时去重、拒绝空 id 和控制字符；`main` 在读取材料、安装 opencode/Magpie 之前对照 `gateway.json` 校验未知 id；`startLiveGateway` 用它计算 `unrequested`，并同时用于配置服务方和过滤组成员。两端能接受。
- **`unattributed` / `unreadableByModel`**：`summarizeGatewayUsage` 的返回字段；`gatewayRecordFields` 用 `unattributed + unreadableByModel[model]`，key 是 `config.models` 的完整模型名，和调用方传入的完整模型名一致。能接受。
- **`OVERRIDABLE_PROBLEMS`**：前缀列表与 `problems` 的实际字符串（`unreviewed `、`ledger-not-committed`、`no-complete-round`、`chain-broken `、`not-ancestor `、`low-fix-invalid `）匹配；`main-ref-missing`、`main-not-merged` 不在列表，仍会阻塞。能接受。
- **override 记录的 `problems`**：写入端是 `printable(file)` 生成的字符串数组；读取端 `parseUsage` 不校验，`reviewReport` 直接 `.map`，伪造记录会崩（见问题 4）。
- **`retry: null`**：函数返回值有，但 `runOne` 用真值判断展开，账本里被省略（见问题 6）。

---

## 作者说法逐条核对

1. **`startLiveGateway`**：`only` 过滤服务方、`usesCreditProvider(drop, creditProvider)`、`drop` 按 `gateway.json` 顺序返回、CodeBuddy 启动失败回退、`/models` 缺成员去掉一家，均与代码一致。**不一致**：作者说「每个模型都没有成员才 `GATEWAY_PREFLIGHT_FAILED`」，代码是「任一要跑的模型没有成员就失败」（与 `model-review.md` 一致，见问题 7）；另外 `reserveFor` 建组会带来边缘预检失败（问题 3）。
2. **`assertReviewed`**：`OVERRIDE_MIN_ROUNDS` 已删；`OVERRIDABLE_PROBLEMS` 与文档列出的六类一致；账本缺失时 `mkdirSync` + 追加；写入后 `overridden` 仍为 false、退出码 5；提交后能认出记录并退出 0。**核对通过**。
3. **叫停**：`signalHandler`、`requestStop`、`activeStops`、`GUARD_DEFERS_TO_PARENT` 都接上了；`stopRequested` 时不开追问/重试/替补；`--report` 的 `three-rounds` 排除了 `owner-stopped` 记录。**部分不一致**：重试等待里叫停记 `api-error` 而非 `owner-stopped`（问题 2），`retry: null` 不落账本（问题 6）。
4. **`--providers`**：解析、`ARG_PROVIDERS_NEED_GATEWAY`、未知 id 在读材料和安装前报错、`parseUsage` 校验 `gatewayDropped`，均核对通过；控制字符和 `ARG_PROVIDERS_NOT_FOR_SELF_CHECK` 也在。**核对通过**。
5. **文档**：`model-review.md` 的控制复核一节、第 6 步例外、`AGENTS.md`、`owner-standing-rules.md`、ADR 0178 后续都已更新，方向一致；**不一致**集中在 `costUnknownWhy`（问题 1）、重试等待叫停的 outcome（问题 2）、ADR 的「所有成员都不可用」措辞（问题 7）。
