## 这一轮查过的范围

- 增量：`git diff 4cda11b3f..4dc70130b`。这 143 个文件里绝大部分是合入 main 带来的无关改动；与 PR 484 相关、由作者本轮真正改动的只有 `clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift` 和 `clients/apple/Tests/HimawariCoreTests/ListeningTests.swift`（`git show 4dc70130b` 确认）。
- 用定向 `git diff` 核对过 PR 484 的服务端与提示词文件（`voice-addressee*.ts`、`device-api-routes.ts`、`production-voice-addressee.ts`、`prompt-catalog`、ADR 0264）：本轮没有改动。
- 合入 main 带来的 `strict-configuration.ts`（`ownerIntentCheck` 字段改名）和 `prompt-manifest.json`（owner-intent 条目）不属于 PR 484，只影响 owner-intent，未按本次增量审查。
- 上一轮复核记录在当前 sparse checkout 里不存在（`glob .agents/reviews/pr-484/**` 无文件），因此只能从提交内容判断上一轮改了什么，无法逐条对照上一轮意见。

## 发现的问题

### 1、中：新增测试没有真正覆盖“按码点截 64”，退回到按字形截断时测试不会失败

- 文件:行：`clients/apple/Tests/HimawariCoreTests/ListeningTests.swift:10-12`；实现 `clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:36-43`
- 问题：`"あ"` 每个都是单码点，`unicodeScalars.count` 与 `Character` 个数相同。测试里“超长截断”这条断言，对“先去掉不可见字符、再按 Character 截 64”这种错误实现仍然会通过，测不出本次提交声称修好的“字形 vs 码点”差异。真正能区分的用例在上一轮 `4cda11b3f` 被删掉了，本轮没有恢复。
- 证据：
  - 读代码证实，当前测试只用了单码点字符：
    ```swift
    let long = String(repeating: "あ", count: 80)
    let trimmed = VoiceEvidence(trigger: .ambientName, heardName: long).heardName
    #expect(trimmed?.unicodeScalars.count == VoiceEvidence.heardNameMaximumCharacters)
    ```
  - 读 `git show 4cda11b3f` 证实，被删掉的正是多码点字形的反向用例：
    ```swift
    - #expect(VoiceEvidence(trigger: .ambientName, heardName: String(repeating: "\u{1F1EF}\u{1F1F5}", count: 40)).heardName?.unicodeScalars.count == VoiceEvidence.heardNameMaximumCharacters)
    - #expect(VoiceEvidence(trigger: .ambientName, heardName: "Hima\u{200D}wari").heardName == "Himawari")
    ```
  - 另一条旧断言 `ListeningTests.swift:109` 用的是 `.count`（Character 数），同样区分不了码点和字形。
- 建议：恢复国旗/家庭 emoji 这类多码点字形的用例，断言 `unicodeScalars.count == 64` 且结果不含 `Cc`/`Cf`；最好保留一条“同一输入在旧的字形截断实现下必然失败”的用例。

### 2、低：`normalizedHeardName` 没有按服务器的首尾空白校验处理，提交信息“和服务器的校验一致”不成立

- 文件:行：`clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:36-43`；服务器 `packages/platform-node/src/device-api-routes.ts:186-194`
- 问题：客户端只去掉 `Cc`/`Cf` 并按码点截断；服务器还要求 `value.trim() === value`。像 `" Himawari"` 这样的名字客户端会原样发出，服务器回 400。作者说“和服务器的校验一致”只对长度、控制/格式字符成立，对首尾空白不成立。
- 证据：
  - 读代码证实客户端没有 trim：
    ```swift
    for scalar in value.unicodeScalars where scalar.properties.generalCategory != .control && scalar.properties.generalCategory != .format {
        if scalars.count >= heardNameMaximumCharacters { break }
        scalars.append(scalar)
    }
    return String(scalars)
    ```
  - 读代码证实服务器多一条 trim 条件：
    ```ts
    length <= VOICE_HEARD_NAME_MAXIMUM_CHARACTERS &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
    ```
  - 读集成测试 `test/integration/device-voice-command.test.ts:163` 证实服务器确实把 `{ trigger: "ambient_name", heardName: " Himawari" }` 判为 400。
  - 推测：生产主路径目前不会触发这个问题——`NameCall.init` 在 `NameCall.swift:15` 已经 `trimmingCharacters(in: .whitespacesAndNewlines)`，`UtteranceFlow` 发出的 `heardName` 用的是这串已 trim 的 `spellings`。但 `VoiceEvidence` 的 public 初始化器、评测和以后新增的调用方都可能直接传未 trim 的名字，届时会得到 400。
- 建议：在过滤 `Cc`/`Cf` 之后再按服务器的口径做一次首尾空白裁剪（裁剪后再判空），并补一条 `" Himawari"` / `"Himawari "` 的客户端用例。

## 侧重检查

- 不可信输入/错误路径：核对了 `parseVoiceEvidence` 对未知键、`trigger`、`hands_on` 带名字、`heardName` 类型/长度/trim/`Cc`+`Cf` 的校验（`device-api-routes.ts:163-195`）；客户端对空串、纯不可见字符、超长、控制字符的处理（`SpokenCommand.swift:31-43`）。发现上面的 trim 不一致。
- 响应与资源耗尽：`voice-addressee-decision.ts:109-131` 在非 2xx、声明长度超限、流式读取超限时都会取消响应体；`MAX_RESPONSE_BYTES` 为 65536（第 7 行），本轮未改。客户端 `normalizedHeardName` 的循环最多收集 64 个可见码点，但输入全是 `Cc`/`Cf` 时会扫完整串；调用方来自本地配置名，风险低。
- 安全与外部出口：`voice-addressee-decision.ts:67-68` 在发往 Jev 前对 `heardName` 和整句调用 `redactForExternalText`；`scripts/check-egress-redaction.mjs` 已登记 `voice-addressee-decision.ts`。本轮增量没有新增外部出口。
- 不可撤销操作/数据库：本轮增量没有写库、删除、提交对话或审批类操作。
- 规则与文档一致性：ADR 0264 的默认 0.7/0.3、1.5 秒、1024 字、每设备 64 条缓存、20 次/分钟、无配置时 `hands_on` 放行/名字调用 `addressed_unsure`，与 `voice-addressee.ts:21-29`、`production-http-composition.ts:1707-1709` 一致。提交信息里“和服务器的校验一致”与代码不一致，见问题 2。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本次增量只改客户端把 `VoiceEvidence.heardName` 写进设备请求体前的规范化；addressee 判断是独立的一次性后台调用，固定指令在 `questions`，会变的 `assistantName`/`heardSentence` 在唯一的 `input` 用户消息里（`voice-addressee-decision.ts:55-75`），不追加到任何对话的系统提示、工具或历史。不过这次增量本身与请求开头无关。
2. **不会让同一段文字在不同请求里变成不同字节。** 新规范化只依赖传入字符串本身，不依赖时间、前后文或无序集合；同一输入在同一 Swift 运行时下输出确定。与本次增量无关的遮盖逻辑每次请求新建 `known`/`sequentialPlaceholderTag`，但输入相同则输出相同。
3. **有自动检查，但反向用例没有真正覆盖本次修复。** 新增了 `heardNameIsTrimmedByCodePointsAndDropsInvisibleCharacters`，其中零宽空格/BEL 的断言在旧实现下会失败；但“按码点截断”本身没有能被字形截断实现触发的反向用例（见问题 1）。trim 不一致也没有客户端用例。作者说“9 条通过”无法在当前环境运行验证，标为未核实。
4. **增量产生/修改的值的直接使用端。** `normalizedHeardName` 是内部函数，唯一使用端是 `SpokenCommand.swift:31`；`heardNameMaximumCharacters` 只被 `SpokenCommand.swift:39` 和测试使用。真正的跨端值是序列化后的 `heardName` 字段：产生端是 `SpokenCommand.swift:31-43`，接收端是 `device-api-routes.ts:175/186-195` 的 `parseVoiceEvidence`/`isHeardName`。两端在 64 码点、`Cc`/`Cf` 上一致，在首尾空白上不一致（见问题 2）。本次增量没有新增或修改配置键、数据库字段或其他序列化格式。

## 作者的其余说法

- “同一句只判一次（缓存 + 进行中的请求合并），失败的不缓存；每台设备每分钟最多 20 次”：读 `voice-addressee.ts:98-134` 证实缓存 key、进行中合并、失败/预算删除缓存、`#admit` 每分钟 20 次均与说法一致。本轮增量未触及。
- “没有这项配置时服务器不调用 Jev，认出名字的指令一律 addressed_unsure”：读 `production-http-composition.ts:1707-1709` 证实无模型或无配置时 `hands_on` 放行，其余返回 `addressed_unsure`。
- “tsc 通过、60 个相关测试文件 1354 条通过、其中 9 条 Jev 集成测试”：当前环境不能运行，未核实。
