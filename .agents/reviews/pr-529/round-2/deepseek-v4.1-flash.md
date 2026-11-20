**这一轮查过的范围**

增量 `f5215039..e991dc14`（代码 + 测试 + 三份文档），并沿证据追到未改动的旧代码：`production-apple-push.ts`、`service-main.ts`（2725–2784）、`production-home.ts`（590–633、750–808）、`home-urgency.ts`（40–160、292–325）、`production-web-push.ts`（448–507、630–680）、`push-channels.test.ts`（58–382、955–1044）、`home-urgency.test.ts`（193–233、779–844）、`contracts-v2.ts`（892、905–935）、ADR 0089/0255、设计规格与计划、`prompt-prefix.md`、`incidents-and-gates.md` 的 I-73，以及 `clients/apple` 里对推送字段的消费端。未运行任何测试/tsc（不允许），作者关于“24 条通过、tsc 通过”的说法标为未核实。

**上一轮意见的核对结果（读代码证实）**

- 第 1 条（句子进正文）：已改好。`production-apple-push.ts:409-411` 现在 `body: built.body`；审批的 `built.body` 来自 `production-web-push.ts:653-660`，是对话标题或“新对话”，不含模型句子。
- 第 2 条（锁屏模型按钮）：仍按设计保留，见下方“侧重检查”。
- 第 3 条（旧文档说法）：已改好。ADR 0255 第 9 条、设计规格第 11 节、计划第 164 行都已更新，全仓 `grep` 未再找到“还没有推送调用 approvalCopy”“这一批都是通用文字”等旧说法。
- 第 4 条（测试）：只部分改好，见第 3 条意见。
- 第 5 条（启动窗口回落）：未被改动，仍为安全默认。
- 第 6 条（空白绕过）：只部分改好，见第 1 条意见。

### 1. 中 — 推送边界和标签校验都拦不住“只有零宽/格式字符”的按钮文字，锁屏“同意”按钮可能显示为空

文件:行：`apps/agent-service/src/production-apple-push.ts:317-318`；`packages/application/src/services/home-urgency.ts:127-145`；`test/integration/push-channels.test.ts:1021`

问题：本轮的修复是 `trim()` 后非空才采用。但 ECMAScript 的 `trim()` 只去掉空白和行终止符，U+200B（零宽空格）、U+200C、U+200D、U+2060、U+180E 这类 `Cf`（格式）字符不会被去掉；生产端的 `UNSAFE_LINE_CHARACTERS` 只列了 `\p{Cc}\p{Zl}\p{Zp}` 和部分双向控制符，也没有覆盖一般 `Cf`。因此模型写一个 `"\u200B"` 会通过：长度 1、`label === input.label`、字符上限按 1 个 grapheme 通过、也不等于否定按钮文字；推到推送侧 `trim()` 后仍是 `"\u200B"`，非空，于是 `labelBasis: "model"`，锁屏上的肯定按钮渲染成空白。否定按钮固定为“不同意”，用户可能直接点这个看不见的按钮去批准一个不可撤销的动作（按钮凭据会真的生效）。新增的反向用例只用 ASCII 空格 `"   "`，抓不到这个情况。

证据（我亲自读到）：
```ts
// production-apple-push.ts:317-318
const label = copy.affirmLabel?.trim() ?? "";
return label === "" ? null : label;
// home-urgency.ts:127-138
const UNSAFE_LINE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
...
const label = input.label.trim();
if (label.length === 0 || label !== input.label || UNSAFE_LINE_CHARACTERS.test(label)) return false;
```

建议：在两端都按“可见内容”判断，而不是只 `trim()`，例如 `const visible = label.replace(/\p{Cf}/gu, "").trim(); if (visible.length === 0) reject;`。这样保留现有 `发出去👨‍👩‍👧` 用例（去掉 ZWJ 后仍有可见字），同时拒绝纯零宽。补反向用例：`accept("\u200B", "zh-CN") === false` 和推送侧 `{ affirmLabel: "\u200B" }` 回落“同意”。不要简单地对所有 `Cf` 一律拒绝，否则会破坏现有 emoji ZWJ 用例。

### 2. 低 — “一句话不上锁屏”与“同意按钮用模型文字”的文档理由不一致，按钮文字同样可能带收件人、金额

文件:行：`docs/adr/0255-model-scores-urgency-of-home-items.md:65`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:493-495`；`apps/agent-service/src/production-apple-push.ts:346-347`

问题：ADR 第 9 条删掉句子的理由是“它可能带收件人、金额”；但 `affirmLabel` 同样是模型自由写的文字（中文最多 6 个 grapheme），完全可能写出“发给田中”“转 5000”这类具体操作并显示在锁屏按钮上。设计规格第 493 行仍写“只放标题这一级的内容”，第 495 行又允许普通审批的同意按钮用模型文字；ADR 0089 第 5 条还写明“审批的具体操作不上锁屏”。作者说第 1 轮第 2 条按设计规格保留，但文档没有说明按钮文字是对该锁屏规则的**有意例外**、也没写限制条件。这是规则文件与代码/新说法的字面不一致，不是本轮引入的新代码错误。

证据：
```md
// ADR 0255:65
...一句话不放进推送，因为它可能带收件人、金额，锁屏规则不让审批的具体内容上锁屏。
// 设计规格:495
...（`catalog` 通用文字或 `model` 模型写的；普通审批的“同意”按钮用模型写的文字...
```
```ts
// production-apple-push.ts:346-347
label: ownerPresence ? text.approveInApp : (affirmLabel ?? text.approve),
labelBasis: !ownerPresence && affirmLabel !== null ? "model" : "catalog",
```

建议：要么在 ADR/规格里明确写出“按钮文字是锁屏规则的例外”及限制（例如只许短肯定动词，禁止数字、收件人名，或不可撤销/高风险审批一律用固定文字），要么承认按钮也可能带敏感信息并给出对应风险说明；目前“删句子保按钮”的理由自相矛盾。若确实接受，也建议加一条用例把“允许带金额的按钮文字”这一行为固定下来。

### 3. 低 — 上轮第 4 条只补了一半：production 装配和“正文不含句子”没有测试

文件:行：`test/integration/push-channels.test.ts:981-1016、1018-1043`；`apps/agent-service/src/service-main.ts:2767-2769`

问题：测试把 `approvalCopy` 直接注入 `ProductionApplePush`，所以真正的生产装配 `(await http?.home.approvalCopy(input))?.affirmLabel ?? null` 从未被执行；如果有人把这里错接成 `sentence` 或接错字段，现有测试不会失败。其次，标题写着“keeps the sentence off the lock screen”，但用例既不提供句子，也没有对 `aps.alert.body` 做任何断言，句子的缺席只靠类型保证。第三，`it.each` 里的 “read throws” 和 “no label was written” 两行在修复前的 f521 代码上本来也会回落到“同意”（旧代码是 `copy?.affirmLabel ?? text.approve`），只有 “blank” 一行能区分本轮修复；它们锁住了行为，但证明不了这次改动。

证据：
```ts
// push-channels.test.ts:987-990 —— 直接注入，不经过 service-main
approvalCopy: async ({ approvalRequestId }) => {
  asked.push(approvalRequestId);
  return { affirmLabel: "发出去" };
},
// :1018-1021 —— 三种回落
["the read throws", async () => Promise.reject(...), 1],
["no label was written", async () => ({ affirmLabel: null }), 0],
["the label is blank", async () => ({ affirmLabel: "   " }), 0],
```
```ts
// service-main.ts:2767-2769 —— 没有任何测试覆盖
approvalCopy: async (input) => ({
  affirmLabel: (await http?.home.approvalCopy(input))?.affirmLabel ?? null,
}),
```

建议：加一条装配层测试（service-orchestration 或直接单测这个闭包），让假 `home.approvalCopy` 返回带 `sentence` 和 `affirmLabel` 的对象，断言 APNs 负载里只有按钮文字、正文是对话标题；在推送用例里补 `expect((plain.json["aps"] as ...).alert.body).toBe("查下周东京天气")`（或至少 `not.toBe("要把周报发给张三")`）。这属于测试缺口，不是线上行为错误。

**侧重检查**

- 错误路径：`#approvalCopy` 捕获所有异常、调用 `onFailure` 并返回 `null`，`#actions` 回落目录文字；`ProductionWebPush` 外层 `.catch(onFailure)` 不会重复记账。读代码与 `throw` 用例一致。
- 不可信/不合规输入：生产端 `acceptsHomeAffirmLabel` 已覆盖长度、首尾空白、与否定文字相同、未知语言、`Cc/Zl/Zp`、主要双向控制符；缺口是纯 `Cf`/零宽（第 1 条）。推送边界只 `trim`，完全信任生产端；目前唯一生产调用经过 `production-home` 的二次校验，但接口是导出的，其他装配可以绕过。
- 安全/锁屏：句子确实不再进正文；正文是对话标题（ADR 0089 第 5 条允许），但模型按钮文字仍可能携带具体操作信息（第 2 条），且空白按钮可导致误点不可撤销的批准（第 1 条）。
- 资源耗尽：`approvalCopy` 按“每条待发审批 × 每台登记设备”调用，位于 `SEND_BATCH = 50` 的批次内；每次生产端调用都会 `listScores` 并尝试 `seal.open` 解密句子，而推送已经不需要句子，属于可避免的重复解密/读库。数量有界，不构成新的耗尽路径，但可考虑给推送单独一个只取按钮文字的读取口。
- 不可撤销操作：按钮凭据绑定 `requestId/revision/snapshotHash`，标签只是显示文字，不参与凭据校验；但被误导/看不见的标签仍能触发真实批准。
- 规则/文档一致性：三处旧说法已修正；ADR 0089 已被 0229 取代但设计规格仍引用其第 5 条，属可接受的引用；第 2 条指出的理由不一致仍存在。

**逐条回答必答问题**

1. **会不会改变模型已经见过的请求开头？** 不涉及。增量（以及整个 `854d..e991`）只改 APNs 推送、对应测试和文档，没有碰系统提示、工具定义、历史消息或遮盖结果；发给模型的内容没有变化。依据的“只追加/每轮变化值只在最后一条消息”在这里没有适用点。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型请求。对推送值而言，`affirmLabel.trim()` 是只依赖输入字符串的纯函数，不依赖前后文、时间或集合顺序；增量没有引入带时间字段或无序集合。`randomBytes` 生成的按钮凭据是既有行为，与文字不相关。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 有新增：1 条正向（`labelBasis: "model"`、要本人在场时 `catalog`、不读 presence 审批）+ 3 条 `it.each` 回落。但覆盖不完整：只有 `blank` 一行能在旧的 f521 代码上失败；`throw`/`null` 两行旧代码也会通过；没有 service-main 装配测试；没有对 `aps.alert.body` 的断言；零宽空白未覆盖。测试是否全部通过无法在本轮运行核实。另外 `it.each` 的行没有 `as const` 或显式元组类型，按 TypeScript 对异构数组的常见推断，回调参数可能被推成 `string | 函数 | number` 的联合（推测，未核实；作者称 tsc 通过，本环境无 node_modules/tsc 可验证）。
4. **每个值的直接使用端都能接受吗？** 逐个查过：`ProductionApplePushOptions.approvalCopy` 的返回值只被 `#approvalCopy` 使用（`production-apple-push.ts:308-322`），生产端唯一装配在 `service-main.ts:2767-2769`；生产者 `ProductionHomeControl.approvalCopy`（`production-home.ts:797-808`）→ `HomeUrgencyService.approvalCopy`（`home-urgency.ts:292-325`）返回已校验的 `{sentence, affirmLabel}`；`affirmLabel` 只进入 `ApplePushAction.label`，再进 APNs JSON，iOS 侧不解析 `labelBasis`；`labelBasis` 的 `"model"` 与本地联合类型及 `HOME_LABEL_BASES`（`contracts-v2.ts:892`）一致；`HomeLocale` 与 `WebPushLocale` 都是 `zh-CN/en/ja`，类型兼容。两端的唯一不一致是校验位置：推送边界只做 `trim`，把长度/控制字符/双向字符的校验完全留给生产端，其他调用方可以绕过（与第 1 条同根）。未发现 id、字段名或序列化格式对不上的使用端。
