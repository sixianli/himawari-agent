核对范围：`git show 7cf19d3c`（实际改动 7 个文件）与 `git diff 505509e6..7cf19d3c -- apps packages test`。确认 `7cf19d3c..dc0daf3e`（两次合并 main）没有改动本 PR 这 7 个文件；合并只带进 `service-main.ts` 的沙箱内存上限等无关改动，未破坏本 PR 逻辑。

## 读代码证实的问题（按严重度）

### 1. 中高：审批通过后，按号码判出的 sensitive 会被降回 private，推送正文会露出
- 文件:行：`packages/application/src/services/automatic-memory-service.ts:326-330`、`apps/agent-service/src/production-web-push.ts:486-498`
- 问题：本轮把卡号/证件号文字放进“需要主人批准”的 sensitive 分支；但审批通过时 `resolveSensitive` 会把 `sensitive` 改成 `private`（源码是 public/private 时）。之后推送只按 `dataClassification` 判断是否隐藏正文，于是审批过的卡号提醒会显示原文。作者说的“分类至少是 sensitive”“推送通知不显示正文”只在待审批阶段成立，审批后不成立。
- 证据：
  ```ts
  // automatic-memory-service.ts:326-330
  dataClassification:
    candidate.dataClassification === "sensitive" &&
    (request.sourceClassification === "public" || request.sourceClassification === "private")
      ? "private"
      : candidate.dataClassification,
  ```
  ```ts
  // production-web-push.ts:486-490
  const hidden =
    memory.dataClassification === "sensitive" || memory.dataClassification === "restricted";
  const text = hidden
    ? undefined
    : (await this.#options.readMemoryText(memory))?.replace(/\s+/gu, " ").trim();
  ```
  注：降级是更早的 `63bebc12` 有意做的（“审批通过的 sensitive 存成 private，保留 sensitiveTopic，供 profile/embedding 使用”）。因此这未必是错误，但与本轮说法“至少是 sensitive、推送不显示正文”直接不一致；且 `sensitiveTopic` 保留会让记忆页仍显示“敏感”，而推送按 private 显示正文，同一记录两套表现。
- 建议：明确产品意图后二选一：①对“按内容/号码判出的 sensitive”在审批通过后仍保留 sensitive；或②推送判断同时看 `sensitiveTopic`。并补一条“审批 pending 之后 resolve，再断言分类与推送正文”的用例。

### 2. 中：审批门槛依赖模型自报的 `explicit`，代码没有独立确认主人是否真的说“记住”
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:473-475`、`packages/application/src/services/automatic-memory-service.ts:144-146`
- 问题：新逻辑的承诺是“敏感号码默认要主人批准，只有主人明说记住才直接存”。但代码只信模型返回的 `explicit: true`。只要模型把一句普通提及标成 `explicit: true`，并且 `quote` 是主人消息的子串（`quoteFromOwnerMessage` 只校验子串，不校验“记住”），卡号就会绕过审批直接存。新增的“asks the Owner first”用例只覆盖了 `explicit: false`。
- 证据：
  ```ts
  // production-memory-capture.ts:473-475
  if (value["explicit"] === true && explicitOrdinal === null && !inference)
    explicitOrdinal = candidates.length;
  ```
  ```ts
  // automatic-memory-service.ts:144-146
  const explicitlyApproved = input.explicitRememberCandidateOrdinal === candidateOrdinal;
  if (isSensitive(candidate) && !explicitlyApproved) {
    const request = await this.requestApproval(input, candidate, candidateOrdinal);
  ```
  以及 `quoteFromOwnerMessage` 只做 `normalizedMessage.includes(normalizedQuote)`（`production-memory-capture.ts:127-135`）。
- 建议：对“按号码判成 sensitive”的候选，不要仅凭模型 `explicit` 绕过审批；或额外要求主人消息里出现明确的“记住/不要忘”等意图，并补一条 `explicit:true` 但原话没要求记住的反向用例。这是“不可信模型输出”的边界，非本轮独有，但本轮承诺依赖它。

### 3. 中低：号码判定实现有漏判，也有拼接误判
- 文件:行：`packages/sensitive-capture/src/identifiers.ts:1-6`
- 问题：实现先 `text.replace(/[\s-]/gu, "")` 再匹配 `[0-9]{16,19}` 或 18 位身份证样式。因此：
  - 漏判：只去 ASCII 空白和 `-`；小数点、斜杠、下划线、全角连字符 `－`、零宽字符等不会去掉，号码被拆开就匹配不到；也没有做 NFKC，全角数字 `６２２２…` 匹配不到。
  - 漏判：15 位卡（如 Amex）和 15 位旧身份证不在范围内（`[0-9]{16,19}` + 18 位身份证）。
  - 误判（方向安全，但会误触审批）：去掉所有空白/`-` 会把“日期 + 另一段数字”拼起来，例如 `2026-11-05 订单 12345678` → `2026110512345678`（16 位）会被判成敏感。16–19 位的纯订单号/追踪号也会被判敏感。
  - 与出口遮盖不一致：`redaction.ts:327-333` 的银行卡识别还要求 Luhn 和卡组织前缀，本函数都要求，因此会出现“存储判敏感、出口不遮盖”或相反的组合。
- 证据：
  ```ts
  const RESTRICTED_IDENTIFIER =
    /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]|[0-9]{16,19})(?![0-9])/u;

  export function containsRestrictedIdentifier(text: string): boolean {
    return RESTRICTED_IDENTIFIER.test(text.replace(/[\s-]/gu, ""));
  }
  ```
- 建议：先 `normalize("NFKC")`，统一去掉常见分隔符和零宽字符；明确 15 位卡/身份证是否要覆盖；对“日期+号码”的拼接做标记或按原串分组匹配，减少误判。现有测试只覆盖了 5 位订单号、11 位电话、8 位日期，没有 16 位边界、点/斜杠/全角分隔符和全角数字。

### 4. 低：服务端 `memory.create` 不校验“sensitive 不能置顶”，网页提示也会说错
- 文件:行：`apps/agent-service/src/production-memory-control.ts:589-605`、`apps/control-center/src/memory.ts:164-173`、`apps/control-center/src/components/memory-page.tsx:2057-2066`
- 问题：
  - 客户端在 `memory.ts` 里把卡片文字判成 sensitive 后发送 `pinned: false`，所以浏览器路径不会置顶；但服务端 `#create` 只要收到 `pinned: true` 就直接 `setProfilePin`，没有像 `memory.mutate pin` 那样检查分类（`production-memory-control.ts:873-879` 只允许 public/private）。直接调命令的客户端仍可给 sensitive 记忆置顶。
  - 网页添加框的 `pinnable` 只看分类和 `sensitive` 布尔（`memory-page.tsx:2057-2059`），不会用号码检测；用户选“身份”等可置顶分类并输入卡号时，开关可点，实际 `memory.ts` 又把 pin 去掉，但成功提示仍用旧的 `pinned && pinnable`，会显示“以后每次对话都会带上”，与实际不符（`memory-page.tsx:2064-2067`）。
- 证据：
  ```ts
  // memory.ts:164-173
  const classification = sensitive
    ? "sensitive"
    : classificationWithIdentifiers(text, "private");
  return send("memory.create", async () => ({
    contentRef: await client.protectText(text, classification),
    ...
    pinned: pinned && classification !== "sensitive",
  }));
  ```
  ```ts
  // production-memory-control.ts:599-605
  if (pinned)
    await this.options.book.setProfilePin({ ...this.#scope(), memoryId: saved.id, pinned: true, ... });
  ```
- 建议：把“public/private 才可置顶”统一放到 `#create`/`setProfilePin` 的入口校验；网页提示使用服务端实际结果或与 `memory.ts` 用同一判定函数。

### 5. 低：分类只看候选正文，没看 `quote`；编辑/导入路径也没覆盖
- 文件:行：`apps/agent-service/src/production-memory-capture.ts:304,338,454-456`、`packages/application/src/services/automatic-memory-service.ts:403-413`、`apps/control-center/src/memory.ts:141`、`apps/control-center/src/memory-import.ts:167`
- 问题：
  - 自动整理的 `dataClassification` 只由 `text` 计算；`quote` 可能包含主人原话里的卡号，却按同一（private）分类存储（`commitCandidate` 用 `candidate.dataClassification` 存 quote）。如果模型把正文改写成不含号码的摘要、`quote` 保留原号码，卡号就落在 private 的 quote payload 里。原文消息本身也是 private，所以泄漏面有限，但“存储分类”与内容不一致。
  - 网页“编辑/修正”仍用 `item.dataClassification`（`memory.ts:141`），把卡号加进已有 private 记忆不会重新判敏感；从导出文件导入时 `sensitive` 字段直接取自导出数据（`memory-import.ts:167`），也不会调用新函数。除非明确不覆盖这些入口，否则“分类一致”只覆盖了新增和提醒两条路径。
- 证据：
  ```ts
  // production-memory-capture.ts
  const text = ... restore(value["text"].trim()) : "";
  ...
  const requested = classificationWithIdentifiers(text, ...);
  ...
  const quote = typeof value["quote"] === "string" ? restore(value["quote"]) : "";
  ...
  ...(evidenceVerified && dataClassification !== "restricted" ? { quote: ... } : {}),
  ```
- 建议：若“存储里的号码至少敏感”是目标，应把 `quote` 一起纳入判定（或对 quote 单独定级）；编辑和导入也走同一分类函数。

### 6. 低：新增测试的反向用例大部分有效，但有一条是空断言
- 文件:行：`apps/control-center/test/memory-interactions.unit.test.ts:999-1015`、`apps/control-center/src/components/memory-page.tsx:68-75,2057-2059`
- 问题：`[mask-not-block]` 用例输入“我的卡号是 6222…”，`guessCategory` 会归到 `other`，而 `PINNABLE` 不含 `other`，所以 `pinnable` 本来就是 false，`memory.create` 收到的 `pinned` 参数总是 false。即使撤掉 `memory.ts` 里 `pinned && classification !== "sensitive"` 这半句，`payload: { pinned: false }` 仍会通过。真正会因撤掉分类而失败的是同一用例里的 `protectText(..., "sensitive")` 断言。另缺“审批 resolve 后仍为 sensitive”的用例，也没测 16 位边界、点/斜杠/全角分隔符、`public` 分类、`restricted` 无号码。
- 证据：
  ```ts
  const PINNABLE = new Set(["identity", "preference", "relationship", "goal", "project", "rule"]);
  ...
  const sensitive = category === "health" || category === "finance";
  const pinnable = PINNABLE.has(category) && !sensitive;
  ```
  ```ts
  // 测试
  await type(`${memoryAdd} textarea`, "我的卡号是 6222020200112233445");
  ...
  expect(lastCommand()).toMatchObject({ type: "memory.create", payload: { pinned: false } });
  ```
- 建议：把测试数据改成可置顶分类（例如选择 `identity`）再断言 pin 被抑制；补审批 resolve、边界号码和分隔符用例。由于本环境只能读代码、不能执行测试，“撤掉后是否失败”是按断言逻辑推断，未实跑。

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）
- 错误路径/非法输入：模型 JSON 非法、候选缺字段、空正文等仍走原有校验，本轮只多了一次纯函数分类；未发现新增异常路径。`classificationWithIdentifiers` 对未知字符串原样返回，调用方只传 `private/sensitive/restricted` 字面量，未发现越界值。
- 不可信输入：主要风险是模型自报 `explicit`（见问题 2）和模型正文/quote 不一致（问题 5）；号码检测本身不参与安全边界，只是审批分流。
- 安全：原始内容按设计仍存原文；出口遮盖逻辑未被本轮改动。审批后降级导致推送正文可见（问题 1）是实际隐私风险；服务端 sensitive 可被直接命令置顶（问题 4）属于防线不一致，但 profile 只收 public/private，暂未发现因此进入模型上下文。
- 资源耗尽：正则无嵌套回溯，输入有长度上限（记忆/提醒），未发现 ReDoS 或明显内存放大；`replace` 只做一次线性拷贝。
- 不可逆操作：本轮没有新增删除/覆盖类操作；自动整理仍是先建审批请求，显式路径直接写入属于既有设计。
- 文档/代码一致性：作者称“服务端没改（改了会因分类不一致报错）”——代码确实没改，且 `sqlite-memory-operations.ts:691` 有 payload/记忆分类一致校验，说法成立。作者称“分类至少 sensitive、推送不显示正文”——只在审批前成立，审批后与代码不一致（问题 1）。
- 未核实：本轮无法运行测试；第 1-3 轮复核记录目录在工作树中不存在，未复核历史意见是否已覆盖上述点；真实生产推送/审批流程未跑。

## 必答问题
1. **会不会改变模型已经见过的请求开头？** 不会。本轮没有改系统提示、工具定义、历史、遮盖或请求组装代码；`git show 7cf19d3c` 只动存储分类、提醒写入、网页调用和测试。分类变化可能影响“本轮是否/如何选入记忆、profile 块”，但这些块仍在最后一轮 `turnPrompt` 里随最后一条用户消息发送（`packages/runtime-pi/src/pi-runtime-adapter.ts:598-616`：`<himawari-context>` + `projection.prompt.content` 拼成当前轮提示），不是已发出的前缀。发给模型的内容仍然只在末尾追加，每轮变化的值仍在最后一条用户消息。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会由本轮引入。`classificationWithIdentifiers` 只依赖 `text` 和传入分类，是确定性的；没有时间、随机数、无序集合。唯一的条件分支是审批 resolve 时看 `sourceClassification`，对同一个审批请求是固定的；出口遮盖函数没有改。注意：号码分类会影响后续记忆是否进入 per-turn 记忆/profile 块，但这是确定性的内容选择，不是遮盖字节漂移。
3. **有没有对应自动检查，反向用例真会失败吗？** 有：`identifiers.unit.test.ts`、`production-memory-capture.test.ts`、`memory-interactions.unit.test.ts`。按断言逻辑，撤掉分类函数/判定后：身份证用例会得到 private、卡号待审批用例会变成直接入库、提醒用例会得到 private、网页用例会以 private 调 `protectText`，这些都会失败。但网页用例里 `pinned:false` 的断言是空断言（分类归到不可置顶的 `other`，见问题 6）；且没有“审批通过后仍为 sensitive”“16 位边界/分隔符/全角数字/`public`/`restricted` 无号码”的用例。未实跑，仅读代码判断。
4. **每个新值的使用方能接受吗？**
   - `"sensitive"`：产生于 `classificationWithIdentifiers`；消费方 `client.protectText`、`protector.protect`、记忆 `dataClassification` 都接受四档分类。每条最终落库路径里，记忆记录与内容 payload 取同一个值：`production-reminder-writer.ts:213-220` 直接用 `payload.dataClassification`；`production-memory-control.ts:561-562` 也直接用 payload；`sqlite-memory-operations.ts:691` 要求两者相等，当前实现满足。审批 resolve 路径会降级，但内容与记忆同时降级，校验仍通过（问题 1 是语义/展示问题，不是不一致报错）。
   - `pinned`：网关契约接受 boolean；客户端新值 `pinned && classification !== "sensitive"` 合法。但服务端 `#create` 不按分类再校验（问题 4），仅靠客户端约束，两端校验不对等。
   - 新导出函数：`packages/sensitive-capture/src/index.ts` 已 `export * from "./identifiers.js"`，agent-service 与 control-center 都已有该包依赖，未见接线问题。
   - 没有新增配置键、清单项或序列化格式；`sensitiveTopic` 仍是既有字段。
   - `quote` 的分类也走“记忆与 quote 分类必须相等”的校验（`sqlite-memory-operations.ts:832`），当前自动整理用同一个 `candidate.dataClassification` 存 quote，能通过；但检测没看 quote，属于覆盖缺口（问题 5）。
