## 侧重检查（先写这部分）

我走的流程（GLM 侧重：测试覆盖、文档与代码一致，走一遍普通流程）：

1. **普通流程“线程合并一个 PR”**：`--mode code-review` 跑第 1 轮（opencode-review.mjs:2826 两个模型并行，runOne 2767-2825 写提示词、答案、追加账本 2820）→ 修改后传 `--previous` 补轮 → `--accept-low` 记低意见（assertReviewed 1261-1296）→ 提交记录目录 → `--assert-reviewed` 核链（1168-1321）→ `REVIEW_CURRENT` 才合并。改动新增的分支是“Andy 说跳过 → `--accept-unreviewed` → （零轮时新建账本）→ 提交 → 再 `--assert-reviewed` 认出”。结论：**零轮覆盖这一段在现有代码下走不通，见问题 1**；流程其余段落的消费端我都逐一核对过（见必答问题 4）。
2. **测试覆盖**：方案声称的手法（假 OpenCode、延迟发 `step_finish`）在 `test/tooling/opencode-review.test.mjs:1471` 已有先例，可行。但方案测试节漏了三个必须动的既有用例（问题 2）和一个流程后半段用例（问题 7）。
3. **文档一致性**：`AGENTS.md:52`、`model-review.md:43` 方案已覆盖；但 `model-review.md`「怎么跑」节（第 72 行“脚本收到中断或结束信号时也会删”副本、第 80 行 outcome 语义、第 88 行退出码 4 的处理）描述的行为被第 2 项改掉，方案没列这几处要改。

## 证实的问题（按严重度）

**1.【高】零轮覆盖会被脚本自己拒绝，方案原文照抄实现必然失败。**
证据：`opencode-review.mjs:1257-1258` `ledgerMatchesHead()` 把磁盘文件内容和 `shown.stdout` 比较；账本不在 HEAD 时 `git show` 失败、`shown.stdout` 为 `""`（1172），磁盘上也没有文件时 `existsSync` 为假、得 `null`，`null !== ""` → 1301 打印 `REVIEW_OVERRIDE_REFUSED ledger-differs-from-HEAD`。而且 1303 的 `appendFileSync(ledgerFile, …)` 在 `.agents/reviews/pr-<编号>/` 目录不存在时直接抛 ENOENT。方案第 1 项说“覆盖记录写进新建的 usage.jsonl”，却没提这两处要改。
建议：方案明确两条：`records === null` 且磁盘账本不存在（或为空）时放行新建；写记录前 `mkdirSync(dirname(ledgerFile), { recursive: true })`。测试已有零轮用例，会暴露前者，但方案应写明原因是这两行代码。

**2.【高】方案测试节漏掉断言旧规则、必须同步修改的既有测试。**
证据：`test/tooling/opencode-review.test.mjs:2210` 用例名"an override covers only unreviewed files and needs three rounds even when already committed"；`:2267`、`:2421` 断言 `"REVIEW_OVERRIDE_REFUSED rounds=… needs=3 only-unreviewed-files"`；`:2858` 断言 `"rounds=1 needs=3"`。删掉 `OVERRIDE_MIN_ROUNDS`（1160）后这些全部失败。方案只列了新用例的失败条件，没列这些要改的旧用例——照方案实施会出现一批“计划外的失败”。
建议：把它们补进方案测试节，逐个写明改成什么（例如 2210 改成“零轮 + 原话可覆盖、main 未合仍拒绝”）。

**3.【中】第 2 项的接线细节缺三处，其中“第二次信号”的行为现有代码不成立。**
证据：(a) `stop(reason)` 是 `reviewModel` 闭包内的局部函数（681-687），`onSignal`（2713-2716）拿不到，需要每个在跑模型把 stop 注册进一个列表；(b) `cleanup()`（2708-2712）会 SIGKILL 所有 child 并 `stopAllGateways()`——而 `runOne` 要在模型退出**之后**才读 `liveGateway.live.stableUsage()`（2809）写账本，所以信号路径绝不能碰 cleanup，Magpie 必须活到账本写完；(c) 监听用的是 `process.once`（2717-2718），第一次触发后监听器即被移除，第二个 SIGINT 走默认处理立即终止、**不做任何清理**——方案说“第二次收到信号……照旧清理后强制退出”，得改成 `process.on` 加计数（或处理函数内重注册）。
建议：方案补一节“信号接线”：登记停止意图、不清理；`process.on` + 信号计数；30 秒兜底定时器从第一个信号算起。

**4.【中】文档同步范围不足（规则与代码一致性的缺口）。**
证据：第 2 项改变了中断行为——`model-review.md:72` 现在写“脚本收到中断或结束信号（SIGINT、SIGTERM）时也会删”副本，改动后跑模型阶段收到信号会先记账再清理退出；`:80` 的 outcome 语义、`:88` 的“退出码为 4，按 usage.jsonl 里的 outcome 处理”需要补 `owner-stopped` 的含义和“用 `--round` 补跑”；`:43` 的例外规则要按第 1 项全文重写（方案已列）。`AGENTS.md:52` 方案已列。
建议：把 `model-review.md` 72、80、88 行列入文档改动清单；新章节遵守方案自己定的“只用 `-` 列表”之外，**必须以 `## ` 标题或 `<a id=` 锚点起头**——`reviewQuestions` 按 `\n(?=<a id=|## )` 切节（218-229），不起头的新节会并进必答问题那一节的文本块，虽然 `-` 列表不产生 `^\d+\.` 匹配，但这个前提方案没写出来。

**5.【低】`--providers` 的规格缺口（三小条）。**
(a) 只定义了与 `--gateway direct` 同用的 `ARG_PROVIDERS_NEED_GATEWAY`，没定义“没传 `--gateway`（Mac 上默认直连）”时报什么——建议同一错误码；(b) `parseArgs` 现在不读 `gateway.json`（配置在 main 2700 才经 `readGatewayConfig` 读入），“id 必须在 gateway.json 里否则 `ARG_INVALID --providers`”要么把校验挪到 main、要么让 parseArgs 读配置，方案应写明用哪一份配置做校验（须和 2700 同源）；(c) `--providers` 的反向用例没写（必答问题 3 要求反向用例真的会失败）。

**6.【低】确定性：drop 列表顺序没有规定。**
证据：`dropProviders`（2589-2596）按 missing 成员的出现顺序追加 drop；`--providers` 又会注入“没列出的”一批。`gatewayDropped` 逐字进账本（2812）和 `GATEWAY_USAGE`（2510-2513）。账本不发给模型、不影响缓存，但方案自己在必答问题 2 的标准下应规定：drop 按_gateway.json_ 的服务方顺序排序后写账本。
建议：加一句“drop 一律按 gateway.json 顺序去重排序”。

**7.【低】零轮覆盖的测试缺后半段。**
方案正文写了“线程提交后再跑一次 `--assert-reviewed`，认出已提交的覆盖记录才算通过”，测试节只有“能覆盖并写记录”。我核对了认出逻辑在零轮场景成立：记录里 `head` 是当时的 HEAD（含全部代码改动），之后只提交账本目录 → `changedOutside`（1253）为空 → `recorded` 命中。但这依赖第 1 项的修改落地，且这个二次识别正是零轮场景的验收点，应补进测试节。

**8.【低】把 `low-fix-invalid` 纳入可覆盖集合比 `unreviewed` 更激进，风险节应点名。**
`low-fix-invalid`（`files-differ`、`findings-differ`、`second-low-fix`，1128-1154、1200-1206）表示账本记录与重算不一致。项目既定取舍是“这套限制防误操作，不防有意”（model-review.md:35），所以可接受，但方案风险节只提了“跳过复核更容易”，应把这一条单列。

## 推测（未核实）

- 前提 7（Andy 2026-11-08 的原话和“看你的建议”）是外部对话，我无从核对，只能信任方案作者的转述。按 `owner-standing-rules.md:40`，协调者附原话转达即算授权——机制成立，但**原话本身是否真说过**未核实。
- 前提 6 我核对过：`.claude/rules/owner-standing-rules.md:40` 确有此句。
- 30 秒宽限与现有 grace 取法（timeout 的十五分之一，model-review.md:85）是否需要一致的推导，方案没说；推测 30 秒是拍脑袋值，建议写明依据（例如不小于 opencode 退出 + stableUsage 两次读取的最坏耗时）。

## 如果由我来定

整体方向（授权留痕代替轮数门槛、软停写账本、单次 `--providers`）我认可，尤其 `--providers` “不自动换回没列出的服务方”这条比“尽力而为”更符合可预期性。我会这样改方案：

1. 第 1 项补三句：改 `ledgerMatchesHead` 放行“账本不存在”的新建场景；写记录前建目录；列出 4 个要改的既有测试（2210/2267/2421/2858）。
2. 第 2 项补“信号接线”一节（stop 注册表、不碰 cleanup、Magpie 存活到 stableUsage 读完、`process.on` + 信号计数、30 秒依据）；把 `model-review.md` 72/80/88 行列入文档改动。
3. 第 3 项补：无 `--gateway` 时的错误码、配置校验同源、反向用例、drop 排序规则。
4. 测试节补：零轮“提交后再认出”用例、“没列 CodeBuddy 不查积分”用例（断言不打印 `GATEWAY_CREDITS`）。
5. 第 4 项补一句：新章节必须以 `## ` 或 `<a id=` 起头（现有测试会兜底，但方案应写明原因）。

### 必答问题逐条

1. **不会。**复核每次运行都是全新对话，提示词由 `buildPrompt`（275-304）现拼，本次改动不碰它；必答问题只从提交过的 checklist 节读（2657、model-review.md:67），`reviewQuestions`（218-229）只认 `^\d+\.` 行且只取 checklist 一节，方案为防污染加的测试方向正确。每轮会变的值（head、previous、brief）本来就在末尾“本次材料”段。新增的 `REVIEW_PID`、`gatewayDropped`、`owner-stopped` 都只进控制台和账本，不进模型请求。唯一注意点见问题 4（新章节的节起头）。
2. **不会引入模型请求内的不确定性。**`--providers` 只改路由不改请求字节，与 `GATEWAY_PASSTHROUGH_*` 透传探针（model-review.md:131）兼容。账本侧新增字段是确定性的，但 drop 列表顺序需按方案第 6 条固定；`at` 时间戳是既有模式，不算新问题。
3. **部分有。**第 1 项、中断、新章节都有反向用例且失败条件明确（分别对应删放宽代码、恢复直接退出、插编号行）；`owner-stopped` 用例的“假 OpenCode + 延迟 step_finish”手法在 `opencode-review.test.mjs:1471` 有先例。缺口：既有 4 个 needs=3 用例必须同步改否则失败（问题 2）；`--providers` 没有反向用例（问题 5c）。另外第 1 项的正向用例按问题 1 的分析会在现有代码下失败——这正是反向验证想要的，但方案须知道原因（问题 1）。
4. **逐个核对过，两端都能接受，但有两个前提要写进方案。**`owner-stopped`：产生端 `runOutcome`（1560-1566，stopReason 直接透传，无需映射表）；消费端 `coveragePoints:1090`（非 ok 不上链，符合“不上复核链”）、`roundForRun:1515`（只挡 ok，`--round` 可补跑）、替代逻辑 802-809（只替 api-error，不误替补）、退出码 4（2871-2875）、`parseUsage:1437`（只要求非空字符串）、`GUARD_DEFERS_TO_PARENT:91/698`（防插件原因覆盖，方案正确）、`--report` 的 `run-failed:1328`。`--providers` id：校验端 `gateway.json`（model-review.md:121 已有逐项校验），消费端 `groupArgs`（gateway.mjs:341-345）过滤成员、`gatewayDropped` → `gatewayUsageLine:2510`、`GATEWAY_PREFLIGHT_FAILED` 复用 2552-2554/2629。两个前提：校验用配置须与 main:2700 同源（问题 5b）；零轮覆盖必须连 `ledgerMatchesHead` 和建目录一起改（问题 1），否则方案声称支持的第一个场景就是坏的。
