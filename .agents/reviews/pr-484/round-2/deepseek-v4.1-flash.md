## 本轮查过的范围

`48cbf60..02e98` 中与 PR 484 直接相关的只有 `81c42c36c`（第 1 轮修复）和 `02e98f890`（ADR 只删了行号）；同一区间里其余大量改动来自 main 合并（PR 520/521/524/443/435 等），没有按 PR 484 重读。我读了 `voice-addressee.ts`、`voice-addressee-decision.ts`、`voice-command.ts`、`device-api-routes.ts` 的语音部分、`production-voice-addressee.ts`、`production-http-composition.ts` 的 `voiceAddressee`、`strict-configuration.ts` 的语音配置、提示词目录与 egress 登记、ADR 0264，以及客户端 `SpokenCommand/NameCall/UtteranceFlow/ListeningController/ListeningSession` 和 `device-voice-command.test.ts`、`device-api-harness.ts`。

## 侧重检查

- **错误路径**：模型失败、超时、非法回答、响应过大 → `#judge` 捕获后返回 `null` → 409 `addressed_unsure`；`reserve` 抛异常 → 直接抛到路由，见意见 3。
- **不可信输入**：`heardName`/`text` 在路由和 judge 两处校验；Jev 回答校验了 `model`、唯一 predicate、name、概率范围。`heardName` 两端规则不一致，见意见 1。
- **安全**：请求带 `zeroDataRetention: true` 和 Bearer key，外发前对名字和整句调用 `redactForExternalText`，并在 `check-egress-redaction.mjs` 登记；提示词明确要求把句子当数据。
- **资源耗尽**：响应上限 64KB、每设备每分钟 20 次、缓存每设备 64 条；超限响应分支未取消响应体，见意见 4；超限测试不能证明流式限长，见意见 2。
- **不可撤销操作**：只有判定为 `addressed` 才提交对话；`not_addressed`、`addressed_unsure`、`addressed_budget` 都在提交前返回 409。`hands_on` 不经判断是既定行为。
- **规则/文档一致性**：ADR 0264 的 0.7/0.3、1.5 秒、20 次/分、64 条、1024 字与代码默认值一致；“不放进任何对话”与代码一致。`heardName` 的 64 字上限在客户端按字形、服务端按码点，和“客户端与服务端应一致”不符。

## 意见

### 1、中低、客户端按字形计数、服务端按码点校验，上一轮第 8 条并没有改好

**文件:行**：`clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:23`、`:31`；`packages/platform-node/src/device-api-routes.ts:186-194`；`packages/application/src/services/voice-command.ts:22`。

**问题**：客户端用 Swift `String.prefix(64)` 截断，算的是扩展字形簇；服务端用 `[...value].length`，算的是 Unicode 码点，并且额外拒绝 `Cc`/`Cf`。`81c42c36c` 没有改这两个文件，上一轮意见第 8 条仍未解决。

**证据**：
- 客户端：`self.heardName = ... heardName.map { String($0.prefix(Self.heardNameMaximumCharacters)) } ...`
- 服务端：`const length = [...value].length; return (length >= 1 && length <= VOICE_HEARD_NAME_MAXIMUM_CHARACTERS && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value));`

一个由 64 个旗帜 emoji（每个 2 个码点）组成的名字，客户端认为正好 64 字，服务端会看到 128 个码点而返回 400；含 ZWJ（`Cf`）的 emoji 名字即使很短也会被服务端拒绝。客户端也不检查 `Cc`/`Cf` 和首尾空白。结果是这些名字的口头指令在 `/messages` 直接 400，根本到不了 Jev。

**建议**：两端用同一套计数规则（例如客户端按 `unicodeScalars.count` 截断）和同一套禁止字符；把 64 这个上限放到共享契约或 `runPolicy.voiceAddressee`，至少不要在两处各写一份。补一条含旗帜/ZWJ emoji 和 65 码点名字的用例。

[读代码证实]

### 2、低、超限响应测试在旧代码上也会通过，不能防止退回“先整段读入”

**文件:行**：`test/integration/device-voice-command.test.ts:345-356`；`packages/platform-node/src/voice-addressee-decision.ts:111-128`。

**问题**：新增测试只断言最终得到 `addressed_unsure`。修复前的代码是 `await response.text()` 后再检查大小并抛错，`#judge` 同样会把它转成 `addressed_unsure`，所以这条测试在旧实现上也会通过，不能守住“边读边限长”这个安全属性；也没有用例覆盖 `content-length` 超限分支。

**证据**：`81c42c36c` 删除的旧代码是 `const text = await response.text(); if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw ...`；测试只断言 `refused.body` 和 `commands(h)`。新代码的流式检查在 `voice-addressee-decision.ts:118-127`。

**建议**：让测试桩发送超过上限且迟迟不结束的响应，断言请求在读完 64KB 前就返回/取消；再补一条带 `content-length` 超过上限的用例。否则把实现改回 `response.text()` 测试仍会绿。

[读代码证实]

### 3、低、`reserve` 抛异常时直接变成 500，没有落到约定的 `addressed_unsure`

**文件:行**：`packages/application/src/services/voice-addressee.ts:122-128`；`packages/platform-node/src/device-api-routes.ts:981-992`；`clients/apple/Sources/HimawariCore/Listening/SpokenCommand.swift:111-118`。

**问题**：本轮新加的 `try/catch` 在 `reserve` 失败时选择 `throw error`。路由没有捕获，客户端只把 409 + `VOICE_COMMAND_UNCONFIRMED` 转成“先问主人”，其他错误会直接抛出。数据库或预算预留出错时，用户看到的是 500/未知错误，而不是约定的 409 `addressed_unsure`。

**证据**：
- `} catch (error) { if (device.get(key)?.judged === judged) device.delete(key); throw error; }`
- 路由：`const addressed = options.addressee ? await options.addressee({...}) : "addressed_unsure";`，没有 try/catch。
- 客户端只匹配 `status == 409 && code == voiceCommandUnconfirmedCode`。

这不是本轮新引入的行为（修改前 `reserve` 也直接抛出），但本轮新写的 catch 本可以顺手改成失败闭合。**建议**：把 `reserve` 异常也映射成 `addressed_unsure`（或在路由层统一映射），并补一条预留失败的用例。

[读代码证实；客户端最终表现按代码路径推断]

### 4、低、`Content-Length` 超限分支没有取消响应体，可能占用连接

**文件:行**：`packages/platform-node/src/voice-addressee-decision.ts:111-115`。

**问题**：声明长度超过上限时直接抛错，既没有读也没有 `cancel()` 响应体；流式分支超限时才会 `await reader.cancel()`。如果上游反复返回超大的 `Content-Length`，连接可能不能及时释放。

**证据**：
```ts
const declared = Number(response.headers.get("content-length") ?? 0);
if (declared > MAX_RESPONSE_BYTES)
  throw new VoiceAddresseeDecisionFailure("VOICE_ADDRESSEE_RESPONSE_TOO_LARGE");
const reader = response.body?.getReader();
```
这里没有对 `response.body` 做任何处理。

**建议**：抛错前 `await response.body?.cancel()`；`!response.ok` 的分支也可以同样处理。

[推测：具体连接保留行为取决于 undici，未实测]

### 5、低、缺 `addressee` 的 fail-closed 分支没有测试，而且会连带拒绝 `hands_on`

**文件:行**：`packages/platform-node/src/device-api-routes.ts:981-992`；`test/fixtures/device-api-harness.ts:417-428`、`:509`；`apps/agent-service/src/production-http-composition.ts:1707-1709`。

**问题**：第 4 条上一轮意见的代码已改成 `"addressed_unsure"`，读代码确认不再是 fail-open。但没有任何测试构造“没有 `addressee`”的路由；harness 总是注入 `addresseeRoute`。生产装配 `voiceAddressee()` 也总会返回一个函数，所以 `!options.addressee` 在生产不可达。回归成 `"addressed"` 不会被测试发现。另外该默认值对 `hands_on` 也生效：如果某处漏装 `addressee`，连按着手机说话的指令也会被 409 拒绝。

**证据**：harness `const addresseeRoute = voiceAddressee(...)` 后传入 `addressee: addresseeRoute`；路由的默认值是 `: "addressed_unsure"`；生产 fallback 是 `request.trigger === "hands_on" ? "addressed" : "addressed_unsure"`。

**建议**：加一条不传 `addressee` 的路由测试，断言名字调用 409 `addressed_unsure` 且不调用模型；若要保留 `hands_on` 可用，默认值应按触发方式区分，或只对名字调用 fail-closed。

[读代码证实]

## 与作者说法不一致或未核实的地方

- **“同一句只判一次”**：代码只合并相同 `utteranceId` 的并发请求（`voice-addressee.ts:105-110`），新增测试也复用了同一个 `utteranceId`（`device-voice-command.test.ts:334`）。同一段文字、不同 `utteranceId` 仍会各问一次。ADR 0264 第 72 行明确写了“设备 + 这句话的编号 + …”，所以这是设计，不是缺陷；但作者的措辞比代码宽。
- **“不新增写死的值”**：本批仍有 `MAX_RESPONSE_BYTES = 65_536`（`voice-addressee-decision.ts:7`）和 `VOICE_HEARD_NAME_MAXIMUM_CHARACTERS = 64`（`voice-command.ts:22`，客户端也有一份 64）。前者不在本轮增量里；后者正是意见 1 的根因。
- **“已合入含 PR 451 的最新 main”**：`git log` 可见 `f6997c3b0 Merge pull request #451`，本分支也合入了 main，属实。
- **“没有这项配置时服务器不调用 Jev，认出名字的指令一律 addressed_unsure”**：读代码属实，`productionVoiceAddressee` 无路由时返回 `undefined`，`voiceAddressee` fallback 对非 `hands_on` 返回 `addressed_unsure`。
- **“tsc 通过、60 个测试文件 1354 条、9 条 Jev 集成测试”**：未核实（本轮不能运行测试）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 这个改动本身不进入任何对话：ADR 0264 明确写“这条调用不进任何对话”，代码也是独立请求，没有系统提示、工具和历史。判断请求里只有一条 `input` 用户消息；本轮的增量把固定的 `model`、`questions` 放到了可变的 `input` 前面，变量 `assistantName`/`heardSentence` 只在这唯一一条消息里；`providerOptions` 在其后但固定不变。因此对会话请求开头无影响，判断请求内部也没有“每轮会变的值出现在最后一条消息之前”。唯一未核实的是 Vercel 端如何把 `questions`/`input` 拼成模型提示（外部服务行为，仓库内看不到）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 读代码未见：`redactForExternalText` 每次新建 `known` 和 `sequentialPlaceholderTag`，同样输入得到同样占位符；请求体没有时间、日期或随机字段，JSON 键顺序固定；`questions` 是单元素固定数组。`providerOptions` 固定。相同 `heardName` + 相同句子会产生相同字节；不同名字导致不同字节是输入本身不同。未核实 Vercel 的序列化。

3. **有没有自动检查，反向用例真的会失败吗？** 部分有：
   - 并发合并：新增测试在旧代码上会失败（旧代码先 `await reserve` 再写缓存，两个请求都会调用模型），有效。
   - 固定问题在前：`Object.keys` 断言在旧顺序上会失败，有效；但它只验证 HTTP JSON 键顺序，不验证 Vercel 实际拼出的模型提示。
   - 超限响应：测试在旧代码上也会通过，不能证明流式限长，见意见 2。
   - 缺 `addressee` fail-closed：代码已改，但没有对应测试，且生产分支不可达，见意见 5。
   - `heardName` 计数/禁止字符：没有测试，且仍未改好，见意见 1。
   - Jev 回答解析有 `prompt-output-contracts.unit.test.ts` 覆盖；外发登记有 `check-egress-redaction.mjs` 覆盖。

4. **改动产生或修改的每个值，使用端都能接受吗？** 逐个核对如下：
   - `"addressed_unsure"` 默认值：路由写入 409 `reason`；客户端 `SpokenCommandRefusal.addressedUnsure` 能解析，`VOICE_ADDRESSEE_REFUSALS` 也包含，接受；但无测试。
   - `"addressed_budget"`：`#reserveAndJudge` 产生，`decide` 删除缓存并返回，路由 409，客户端 `.addressedBudget` 接受。
   - `questions` 在 `input` 前的 JSON 顺序：Vercel 决策接口按 JSON 对象解析，顺序无关；新增测试按新顺序断言，接受。
   - `VOICE_ADDRESSEE_RESPONSE_TOO_LARGE` / `VOICE_ADDRESSEE_RESPONSE_INVALID`：只在本文件抛出，`#judge` 全捕获转 `null`，不会漏到外部。
   - `heardName` 的 64 字契约：客户端产生的值不一定能通过服务端 `isHeardName`，见意见 1，这一端不能接受。
   - 缓存键 `utteranceId/trigger/heardName/sameWords(text)`：路由先用 `UTTERANCE_ID_PATTERN` 校验 `utteranceId`，judge 内部接受。
   - egress 清单项：`voice-addressee-decision.ts` 同时出现在允许出口和必须遮盖清单里，`check-egress-redaction.mjs` 接受；本轮去掉了重复项，没有改变语义。
   - 本轮没有新增或修改 `runPolicy` 配置键。
