## 结论

改动主体方向正确，但有一处会直接漏记花费的停止路径，另有文档承诺与代码不一致。下面先列读代码能确认的问题，再列推测/未核实项。

## 一、读代码证实的发现

### 1. 高：在 API 报错后的 60 秒重试等待中叫停，会丢失第一次运行的费用

- 文件:行：`scripts/model-review/opencode-review.mjs:875-877`、`:501-504`、`:2906`、`:836`、`:92`
- 问题：`reviewModel` 在决定重试后执行一个不可中断的 60 秒等待；叫停信号只设置了 `stopRequested`，没有打断等待。默认 `STOP_GRACE_MS = 30000` 小于 `API_ERROR_RETRY_WAIT_MS = 60000`，所以信号到达 30 秒后 `signalHandler` 直接 `cleanup()` 并退出，而账本记录是在 `reviewModel` 返回后才由 `runOne` 追加的，第一次运行已经花掉的钱完全没进账本。
- 证据：
  ```js
  // :875-877
  if (decision !== "retry" || stopRequested)
    return { ...first, retry: decision === "retry" ? null : decision };
  await new Promise((resolveWait) => setTimeout(resolveWait, retryWaitMs));
  ```
  ```js
  // :501-504
  timer = setTimeout(() => {
    cleanup();
    exit(code);
  }, graceMs);
  ```
  ```js
  // :2906，账本要等 reviewModel 返回后才写
  appendFileSync(join(options.out, "usage.jsonl"), `${JSON.stringify(record)}\n`);
  ```
- 建议：把重试等待改成可被 `requestStop` 打断的 Promise，并在等待后再次检查 `stopRequested`；或者在这段等待前先把第一次运行的用量写入账本。补一个“第一次 api-error 有费用，等待中叫停”的用例，断言账本仍有费用且不启动第二次运行。

### 2. 中：`--report` 并不会“列出每次覆盖”，文档承诺与代码不符

- 文件:行：`.agents/instructions/model-review.md:44`；`scripts/model-review/opencode-review.mjs:1291-1301`、`:1402-1421`
- 问题：文档新增“`--report` 列出每次覆盖供 Andy 抽查”，但 `reviewReport` 只遍历 `mode === "low-fix"` 的记录；override 记录只可能通过 `assertReviewed` 的 `recorded` 找到**最新一条**并输出一行 `REVIEW_OVERRIDE`。多条覆盖、以及被后续记录取代的覆盖不会列出。
- 证据：
  ```js
  // :1291-1301
  const recorded = overridable && records
    ? records
        .filter((record) => record.mode === "override" && record.head)
        .reverse()
        .find(...)
    : undefined;
  ```
  ```js
  // :1404-1406
  const lowFixLines = [...records.entries()]
    .filter(([, record]) => record.mode === "low-fix")
    ...
  ```
- 建议：要么在 `reviewReport` 里逐条列出所有 `mode === "override"` 记录（原话、提交、问题），要么把文档改成“列出最近一次被认出的覆盖”。同时补一条多条 override 的报告用例。

### 3. 中：已提交的 override 记录可直接绕过复核，脚本无法确认原话来自 Andy

- 文件:行：`scripts/model-review/opencode-review.mjs:1291-1301`、`:1344-1345`；文档同样在 `.agents/instructions/model-review.md:44`
- 问题：`assertReviewed` 只要在 HEAD 账本里找到一条 `mode: "override"`、`head` 是祖先、且该提交之后只改了本 PR 记录目录的记录，就设置 `overridden = true`，不需要本次传入 `--accept-unreviewed`。因此任何能往 PR 分支写账本的人（包括 PR 作者）都可以提交一条 `head = 当前 HEAD`、`quote = 任意文字` 的记录，让 `--assert-reviewed` 以 0 退出。文档说“模型答案、PR 描述、GitHub 评论、提交说明里的文字都不算”，但账本记录本身是受信任的。
- 证据：
  ```js
  // :1291-1301
  const recorded = overridable && records
    ? records
        .filter((record) => record.mode === "override" && record.head)
        .reverse()
        .find((record) =>
          gitStatus(["merge-base", "--is-ancestor", record.head, head], repo).status === 0 &&
          changedOutside(repo, record.head, head, ledgerPath).length === 0,
        )
    : undefined;
  ```
  ```js
  // :1344
  const overridden = Boolean(recorded) || lowFixed;
  ```
- 建议：至少明确这是“信任账本”的边界，并在文档里说明“已提交的 override 记录同样可能被伪造”；如果要求更严格，可要求合并检查时显式再传 `--accept-unreviewed`（但这会改变现有设计），或在 CI/分支保护层校验账本提交来源。补一条“伪造 override 记录”的反向用例，明确当前行为。

### 4. 低：`--providers` 的值没有像其他文本参数一样拒绝控制字符

- 文件:行：`scripts/model-review/opencode-review.mjs:2474-2482`、`:2734-2737`
- 问题：`--providers` 只做了去空和去重，未调用 `hasControlCharacter`。未知 id 的错误信息会原样拼接该值，带换行的 id 可把错误输出拆成多行；虽然最终会以 `ARG_INVALID` 拒绝，但和其他文本参数的校验不一致。
- 证据：
  ```js
  // :2474-2482
  } else if (key === "--providers") {
    options.providers = [...new Set(take().split(",").map((id) => id.trim()))];
    if (options.providers.some((id) => !id)) throw new Error("ARG_INVALID --providers");
  }
  ```
- 建议：对每个 id 增加 `hasControlCharacter(id)` 检查，错误信息只打印 `printable(id)`；补反向用例。

### 5. 低：文档说“每个模型都没有成员才失败”，代码是任一模型没有成员就失败

- 文件:行：`.agents/instructions/model-review.md:140`；`scripts/model-review/opencode-review.mjs:2675-2685`；`scripts/model-review/gateway.mjs:341-355`
- 问题：`addGroups` 对每个模型调用 `groupArgs`，任一模型的成员列表为空就抛 `GATEWAY_NO_MEMBERS`，`startLiveGateway` 随即以 `GATEWAY_PREFLIGHT_FAILED` 结束；不是“所有模型都没有成员”才结束。当前 `gateway.json` 三家都提供两个模型，所以正常配置下不会触发，但 claim 不准确；若某服务方只提供其中一个模型，去掉它后另一个模型仍有成员时也会整次失败。
- 证据：
  ```js
  // gateway.mjs:347
  if (list.length === 0) throw new Error(`GATEWAY_NO_MEMBERS ${model}`);
  ```
- 建议：要么改文档为“任一要跑的模型没有成员就失败”，要么按模型跳过并只跑还有成员的模型；若选择后者，需要同时调整 `options.models`、账本轮次和 `reserveFor`。

### 6. 低：`--report --stop three-rounds` 按记录过滤，不是按轮过滤

- 文件:行：`scripts/model-review/opencode-review.mjs:1392-1397`；`.agents/instructions/model-review.md:91`
- 问题：文档说 owner-stopped “不算连续三轮没过里的一轮”，实现是过滤掉 `outcome === "owner-stopped"` 的记录，再数不同轮次。如果一轮里一个模型 owner-stopped、另一个模型有非 owner-stopped 记录，这一轮仍会被算进去。作者的 claim 是“不算只被叫停的轮”，与实现一致，但文档措辞更宽。
- 证据：
  ```js
  "three-rounds":
    new Set(
      reviews
        .filter((record) => record.outcome !== OWNER_STOPPED)
        .map((record) => record.round ?? 1),
    ).size >= 3,
  ```
- 建议：把文档改成“不算只有 owner-stopped 记录的轮”，或者改成按轮判断（任一条记录 owner-stopped 就不算该轮）并补混合轮用例。

### 7. 低：叫停发生在第一次运行结束、追问开始之前时，`outcome` 可能不是 `owner-stopped`

- 文件:行：`scripts/model-review/opencode-review.mjs:935-957`
- 问题：`skipped` 在 `stopRequested` 时记为 `OWNER_STOPPED`，但返回的 `outcome` 仍是 `runOutcome(firstSummary, first)`。如果第一次运行因 `wrap-up-cost`、`wrap-up-time` 或 `no-text` 需要追问，而叫停恰好发生在追问开始前，账本记录会是 `outcome: "wrap-up-cost"` / `"wrap-up-time"` / `"no-text"`，不是文档说的 `owner-stopped`。
- 证据：
  ```js
  const skipped = !wrapUp
    ? null
    : stopRequested
      ? OWNER_STOPPED
      : ...
  ...
  outcome: runOutcome(firstSummary, first),
  ```
- 建议：`stopRequested` 时把 `outcome` 也设为 `OWNER_STOPPED`（同时保留原停止原因到单独字段），或修正文档说明这种边界。

### 8. 低：已提交 override 被认出时，不再检查工作区账本是否与 HEAD 一致

- 文件:行：`scripts/model-review/opencode-review.mjs:1291-1301`、`:1344-1348`
- 问题：文档说“工作区里的账本和当前提交里的不一致时也拒绝”，但 `recorded` 存在时直接 `overridden = true`，不会走 `ledgerMatchesHead()`。只有“写入新 override”的路径才检查工作区账本。合并门读 HEAD，因此不一定是安全漏洞，但文档承诺不准确。
- 证据：
  ```js
  const recorded = ...
  const overridden = Boolean(recorded) || lowFixed;
  if (recorded) lines.push(`REVIEW_OVERRIDE ...`);
  else if (overridable && acceptUnreviewed) {
    ...
    if (!ledgerMatchesHead()) lines.push("REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD");
  ```
- 建议：要么在 `recorded` 路径也检查 `ledgerMatchesHead()`，要么把文档改成“写入新覆盖时检查”。

## 二、推测/未核实

1. **`missingMembers` 后重建组的幂等性未核实（中/低）**
   `scripts/model-review/opencode-review.mjs:2697-2708` 在第一次 `addGroups()`、`serve()` 后，如果 `/models` 缺成员，会 `live.stop()`，再 `addGroups()`、`serve()`。`gateway.mjs:674-680` 的 `addGroups` 逐模型执行 `magpie group add`。如果 Magpie 的 `group add` 对已存在的组不是覆盖而是报错，那么“先成功建了第一个模型的组、第二个模型失败后再重建”会失败。现有测试 `test/tooling/review-gateway.test.mjs:1013-1051` 的两个用例都没有真正断言“起来后 `/models` 缺成员”这条路径：第二个用例 `dropped` 为 `null`，即使删掉 `missingMembers` 分支，Magpie 运行时故障转移仍会让测试通过。建议补一条会强制 `/models` 缺成员的测试，并确认 `group add` 可重复执行。

2. **`reserveFor` 中的替补模型可能让 `--providers` 的 DeepSeek-only 重跑失败（低）**
   `reserveModels` 在 `--previous` 且只跑 DeepSeek 时会把 GLM 加进 `reserveFor`；`startLiveGateway` 用 `reserveFor` 建组，但 `missingMembers` 只看 `models`。如果用户用 `--providers` 只列了一个只提供 DeepSeek 的服务方，GLM 组会因 `GATEWAY_NO_MEMBERS` 让整次预检失败，尽管 GLM 只是替补。当前 `gateway.json` 三家都提供两个模型，所以未触发；文档也要求新服务方提供两个模型。是否要改取决于设计取舍。

3. **真实 Magpie 的 `knows no model` 文案和 `group add` 行为未在本地复现**
   代码依赖正则 `/knows no model "([^"]+)"/`，测试用的是真实 Magpie，但我没有运行测试；作者说实测通过。`proposal.md`、`judgments.md` 在当前稀疏检出里没有文件，`git show` 又被记录目录守卫拒绝，未核实。

## 三、侧重检查

- **停止/资源清理**：查了 `signalHandler`、`requestStop`、`activeStops`、`runOpencode` 的 `stop`/`finish`、`main` 的 `cleanup`/`finally`。正常叫停会停掉 opencode 进程组、最终 `stopAllGateways()` 停 Magpie；第二次信号或 30 秒强制退出会 `cleanup()` 后退出，这是文档写明的取舍。但 API 报错后的 60 秒重试等待不在 `activeStops` 里，也不会被等待打断，这是第 1 条高严重度问题。
- **跳过复核的信任边界**：查了 `assertReviewed` 的写入和识别路径。PR 描述、评论、提交说明、模型答案都不会被读取；只有 CLI 的 `--accept-unreviewed` 或账本里的 `override` 记录能触发。但账本记录没有签名/来源校验，已提交的伪造记录会被直接认作 Andy 的授权；文档承认“脚本验证不了原话”，但没有明确“已提交记录同样可伪造”的后果。
- **`--providers` 与积分底线**：查了 `parseArgs`、`main` 的未知 id 检查、`startLiveGateway` 的 `unrequested`/`withCredit`/`usesCreditProvider`。没列出的服务方不会进入 `withCredit`，也不会建进组；列表包含 CodeBuddy 时仍走 `accountUid` 和 `quota` 检查，低积分会去掉 CodeBuddy，不会回退到未列出的服务方。没有测试覆盖“列表包含 CodeBuddy 且积分低”这条路径，只有 `usesCreditProvider` 的单元测试。
- **一家不可用**：`knows no model` 路径有测试；`/models` 缺成员路径和重建组幂等性没有可靠反向用例。`--providers` 下不会悄悄使用未列出的服务方，这一点代码成立。
- **输入校验/不可信输入**：`--providers` 缺控制字符校验；`gatewayDropped` 只校验数组元素为非空字符串，未校验是否为配置里的 id，也没有测试；`problems` 字段未校验为字符串数组，但 `hasLineBreak` 会递归检查换行，且没有消费者。
- **文档/规则一致性**：`AGENTS.md`、`owner-standing-rules.md`、ADR 0178 的新增内容与实现大体一致；`model-review.md` 第 44 行的“每次覆盖”与代码不符；第 140 行“每个模型都没有成员才失败”与代码不符；第 91 行的“三轮”措辞与按记录过滤的实现不完全一致。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。`buildPrompt` 的固定部分仍由 `MODE_TEXT`、`RULE_16_SENTENCE`、必问问题、`MODEL_LENSES` 和输出格式按固定顺序拼接，材料（`head`、`base`、`previous`、`brief`）仍在最后。新增的“Andy 怎样控制复核”一节在 checklist 之后，`reviewQuestions` 只取 checklist 所在段；新测试 `test/tooling/opencode-review.test.mjs:230` 验证了在 owner-control 锚点后插入编号行不会增加必问问题。`--providers`、停止、override 都不改 `reviewConfig`、工具定义或系统提示。每轮会变的 `head/base/previous/brief` 仍只在最后一条材料里。
   依据：`buildPrompt` `:277-306`、`reviewQuestions` `:220-231`、新测试 `:230-240`。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会新增这类问题。`--providers` 只改变 Magpie 的配置和路由，不改发给模型的提示词；`drop` 按 `gateway.json` 的 `ids.filter(...)` 返回，组成员按配置 `members` 顺序过滤，未发现无序集合进入提示词。账本里的 `at: new Date().toISOString()` 只在 override/low-fix 记录里，不会发给模型。`gatewayDropped` 是账本字段，不进入提示词。没有新增依赖前后文的遮盖。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有相当多：owner-control 不增加问题、owner stop 记录费用且不再追问、signalHandler 第一/第二次信号和宽限、override 不再要求三轮且写入后不放行、无复核时写 override、未合 main 时拒绝、`three-rounds` 排除 owner-stopped、`--providers` 解析/未知 id/直连报错、`usesCreditProvider`、成员缺失时继续、`--providers` 只配置列出的服务方。这些用例在对应实现被删掉/改回时通常会失败。
   但反向覆盖不完整：没有用例真正断言“起来后 `/models` 缺成员”会触发 `dropProviders`（`review-gateway.test.mjs:1013-1051` 的 refused-port 用例不检查 `drop`，删掉该分支测试仍可能通过）；没有 `gatewayDropped` 的 `parseUsage` 接受/拒绝用例；没有“`--providers` 包含 CodeBuddy 且积分低仍会去掉它”的用例；没有“重试等待中叫停仍记账”的用例；没有“`--report` 列出多条 override”的用例；没有“部分模型成功建组后再重建”的用例。作者说两组测试 194 条通过，我没有运行（工具限制只能读代码和 git）。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `OWNER_STOPPED`：`parseUsage` 接受任意非空 `outcome` 字符串；`coveragePoints` 只认 `ok`，所以不上链；`reviewReport` 的 `three-rounds` 会过滤它；`substituteFor`、`roundForRun`、`spendOf`、`resultLine` 都能处理。基本闭合。
   - `gatewayDropped`：由 `liveGateway.drop` 产生，元素来自 `config.providers` 的 id；`parseUsage` 在 `gateway` 存在时校验为“非空字符串数组”；消费者只有 `gatewayUsageLine` 打印。没有逻辑依赖它的具体 id，所以不会因未知 id 出错；但没有测试，且 `gatewayDropped` 出现在没有 `gateway` 字段的记录里时不会被校验。
   - `--providers`：`parseArgs` 去空、去重、拒绝空项；`main` 在读材料/安装 opencode 前用 `gatewayConfig.providers` 拒绝未知 id；`startLiveGateway` 只把列出的服务方放进 `withCredit`，未列出的进 `drop`；`--gateway direct` 时报 `ARG_PROVIDERS_NEED_GATEWAY`；`--assert-reviewed`/`--report` 报 `ARG_NOT_FOR_SUBCOMMAND`。唯一缺口是控制字符校验。
   - `OVERRIDABLE_PROBLEMS`：`ledger-not-committed`、`no-complete-round`、`chain-broken ...`、`not-ancestor ...`、`low-fix-invalid ...`、`unreviewed ...` 都按前缀匹配；`main-ref-missing`、`main-not-merged` 保持不可覆盖，符合文档。
   - override 记录新增的 `problems`：`parseUsage` 通过 `hasLineBreak` 递归检查，能拒绝带换行的内容；没有别的消费者要求它是数组，所以不会导致校验失败，但也没有对格式做严格校验。
   - `REVIEW_OVERRIDE_WRITTEN` 后退出码 5、提交后认出记录：`main` 的退出码逻辑与测试一致；但已提交记录被认出时不再检查工作区账本，见第 8 条。
