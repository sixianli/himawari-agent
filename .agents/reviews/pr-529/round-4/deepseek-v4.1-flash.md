本轮复核范围：`c608045b0..c92d35204` 的增量，即 `ed47ae3f6` 修改的 5 个业务/文档/测试文件，以及 merge `c92d35204` 的三处冲突解决（`production-apple-push.ts`、`push-channels.test.ts`、苹果端计划文档）。此外我顺着 `approvalCopy` 的产生端和使用端核对了 `production-home.ts`、`home-urgency.ts`、`service-main.ts`、`production-http-composition.ts`、`production-web-push.ts`。合并 main 带来的其余约 580 个文件属于别的 PR，本轮没有重读。

上一轮四条意见的核对结果：
- 第 1 条（不可见字符）已真正改好：推送边界和首页共用 `hasVisibleText`，反向用例覆盖 U+200B、U+2060/U+200D、U+3164、U+2800、U+FE0F。
- 第 2 条（ADR 说“只有几个字”而配置可到 64）已改好：ADR 现在写明“默认中文 6、日文 8、英文 16，最多可配到 64”，与 `strict-configuration.ts:1666-1671` 的 1..64 一致。
- 第 3 条（ADR 未记录“无可见字符”拒绝条件）只修好了一半，文档对“去掉哪些字符”的描述仍和代码不一致，见意见 1。
- 第 4 条（正文不含句子断言）改成了精确断言，但仍然没有真正喂入一句模型句子，见意见 3。

作者关于合并的说法经代码核对成立：`production-apple-push.ts` 同时保留了 main 的 `quiet: built.quiet === true`、静音/角标/优先级逻辑和本 PR 的 `actions: await this.#actions(entry, now, locale, approval, affirmLabel)`；`push-channels.test.ts` 对 main 只有新增、没有删除，quiet 提议用例都还在；计划文档同时保留了 main 的提议措辞和“已接上 approvalCopy”。quiet 提议是 `kind: "reminder"`（`production-web-push.ts:651-670`），不会进入 `item.kind === "approval"` 分支，因此不读 `approvalCopy`、不带按钮。

### 1. 低 — ADR 0255 第 8 条没有记录代码实际会去掉的不可见字符，照文档实现会放过 U+3164/U+2800

文件:行：`docs/adr/0255-model-scores-urgency-of-home-items.md:64`、`packages/application/src/services/home-urgency.ts:127-132`、`packages/application/test/home-urgency.unit.test.ts:207-208`

问题：ADR 说“去掉空白、格式字符和组合符之后没有任何可见的字、数字、标点或符号”，但代码实际还去掉了 `\p{Default_Ignorable_Code_Point}` 和 U+2800。U+3164（Hangul Filler）属于 `\p{Lo}`，U+2800（盲文空白）属于 `\p{So}`；如果按 ADR 的字面描述实现，它们会被当成“字”或“符号”而放行，和单位测试期望的 `false` 不一致。

证据：
- `home-urgency.ts:127`：`const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2800\s]/gu;`
- `home-urgency.ts:128`：`const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{P}\p{S}]/u;`
- `home-urgency.unit.test.ts:207-208`：`expect(accept("\u3164", "zh-CN")).toBe(false);`、`expect(accept("\u2800", "zh-CN")).toBe(false);`

建议：把 ADR 改成“去掉所有不可见字符（Unicode 的 Default_Ignorable、格式字符、组合符、各类空白，以及 U+2800 盲文空白）之后……”，或在文档里直接写“没有可见的字/数字/标点/符号，且不是纯填充字符”。这是读代码证实的不一致，不是推测。

### 2. 低 — 推送边只做可见性检查，U+202E 等方向控制符仍能穿过推送边界

文件:行：`apps/agent-service/src/production-apple-push.ts:324-325`、`packages/application/src/services/home-urgency.ts:145-152`

问题：`#approvalCopy` 在推送边界只用 `hasVisibleText` 重新校验，没有复用 `acceptsHomeAffirmLabel` 的长度上限、`UNSAFE_LINE_CHARACTERS`、与否定文字相同等检查。比如 `"同意\u202E"` 会在 `hasVisibleText` 里去掉 `\u202E` 后看到“同意”而通过，返回的标签仍然带着 U+202E。当前生产路径的提供方 `ProductionHomeControl.approvalCopy` 已经用 `acceptsHomeAffirmLabel` 拒掉了这种输入，所以目前不会真的发生；但 `approvalCopy` 是构造器上可注入的公开选项，这层防御并不等价。

证据：
- `production-apple-push.ts:324-325`：`const label = copy.affirmLabel?.trim() ?? ""; return hasVisibleText(label) ? label : null;`
- `home-urgency.ts:145-152`：`acceptsHomeAffirmLabel` 还检查 `UNSAFE_LINE_CHARACTERS.test(label)`、`graphemes(label) > limit`、与否定文字相同等。

建议：把“可见且安全”的校验抽成一个共享函数（例如在 `hasVisibleText` 之外导出完整校验），推送边调用同一套规则；或者让 `approvalCopy` 只返回已经过完整校验的标签，并在类型/构造器注释里写明“提供方必须自行完成全部校验”。后果目前是推测，代码事实是两端校验强度不同。

### 3. 低 — “正文不含句子”的断言仍没有真正放进一句模型句子

文件:行：`test/integration/push-channels.test.ts:1160-1163`、`test/integration/push-channels.test.ts:1188`、`apps/agent-service/src/production-web-push.ts:733-738`

问题：新的断言 `expect(alert.body).toBe("查下周东京天气")` 比原来的空断言强，但测试的 `approvalCopy` stub 只返回 `{ affirmLabel: "发出去" }`，从来没有提供 `sentence`。因此它只能证明“正文等于当前固定的会话标题”，不能证明“模型句子被拦在锁屏之外”。如果将来代码扩展现有 option 把 `sentence` 带进正文，这个测试不一定能失败。

证据：
- `push-channels.test.ts:1160-1163`：`approvalCopy: async ({ approvalRequestId }) => { asked.push(approvalRequestId); return { affirmLabel: "发出去" }; }`
- `production-web-push.ts:733-738`：审批正文是 `body: title ?? WEB_PUSH_TEXT[locale].untitled`，即会话标题，不是模型句子。

建议：用一个返回固定 `sentence`（例如 `"给张三转账 100 元"`）的 stub，或走真实 `HomeControl.approvalCopy` 写入密封句子，然后断言正文既不是该句子、也不包含该句子。这样反向用例才真的能拦住“句子进锁屏”。

### 4. 低 — 没有反向用例证明 quiet 提议不读 approvalCopy

文件:行：`test/integration/push-channels.test.ts:985-1002`、`apps/agent-service/src/production-apple-push.ts:400-407`

问题：作者特别提到合并后要确认“提议（quiet）通知仍不读 approvalCopy、不带按钮”。现有 quiet 用例只断言 `actions` 为空，并且 `setup` 完全没有传 `approvalCopy`；即使代码误调用 `approvalCopy`，测试也看不到。代码本身目前是正确的（提议是 `kind: "reminder"`，`approval` 为 `undefined`，不会进 `#approvalCopy`），缺的是能防回归的检查。

证据：
- `push-channels.test.ts:987` 附近只传了 `proposals.listReady`，没有 `approvalCopy` spy。
- `production-apple-push.ts:400-407`：只有 `item.kind === "approval"` 且 `approval` 存在且不要求本人在场时才调用 `#approvalCopy`。

建议：在 quiet 提议用例里注入一个会记录调用的 `approvalCopy`，断言调用次数为 0；同时保留 `actions` 为空的断言。

**侧重检查**

- 错误路径：`#approvalCopy` 的读取失败（reject）会 `catch`、调用 `onFailure` 并退回 `catalog`；集成反向用例 `test/integration/push-channels.test.ts:1192-1219` 覆盖了 throw、null、空白、零宽字符、U+3164，且 `failureCount` 分别断言 1/0。读代码证实。
- 不合规范/不可信输入：零宽字符、ZWJ、U+3164、U+2800、U+FE0F、emoji 家庭组合、控制符/方向控制符都过了一遍；`hasVisibleText` 的行为符合预期，但推送边界没有完整复用 `acceptsHomeAffirmLabel`（意见 2）。
- 安全/不可逆操作：普通审批的 approve 动作仍绑定审批编号、版本、内容指纹的一次性 token；要求本人在场时仍用固定“看内容再定”且不读模型文字；审核路径没有被增量改坏。残留风险是模型写的锁屏按钮文字本身是任意可见短文本，理论上可能带出收件人/金额等短信息；ADR 0255 把它当作锁屏规则的已批准例外，本次增量没有新增这一风险，我把它记为设计残留风险而不是新缺陷。
- 资源耗尽：标签在解析时最多 64 个 UTF-16 码元（`HOME_URGENCY_LABEL_STORE_MAX = 64`），默认语言上限 6/8/16；`hasVisibleText` 是线性扫描，没有发现新的无界循环或集合。
- 文档与代码一致：ADR 0255 第 9 条与 plan 文档对“普通审批读模型文字、需要本人在场不读、句子不进推送”的描述和代码一致；第 8 条的字符清除描述和代码不一致（意见 1）。
- 合并冲突：逐行对比 `049370462(main)..c92` 和 `ed47ae3f6..c92`，确认 quiet 逻辑和 approvalCopy 逻辑都在，main 的 quiet 测试没有被删掉。读代码证实。

**必答问题**

1. 不涉及。本 PR 改动的文件里没有提示词目录或请求组装代码；`hasVisibleText` 只有 `home-urgency.ts` 和 `production-apple-push.ts` 两处使用，都在读取/推送路径，不写模型输入。因此没有改变模型已经见过的请求开头，也不存在“每轮会变的值放到最后一条消息”的问题。合并 main 带进来的提示词相关改动属于其他 PR，本轮只确认了冲突解决没有把它们丢掉。

2. 不涉及模型请求的字节。`hasVisibleText` 是纯函数，只依赖传入字符串；没有时间、随机数、对象遍历顺序或无序集合。推送标签在同一份存储内容和配置下确定；如果同一审批在打分结果写入前先推过一次、失败重试时打分结果已写入，推送标签可能从 `catalog` 变成 `model`，但这是推送重试路径，不是模型请求，也不是本次增量新增的行为。

3. 有自动检查。`packages/application/test/home-urgency.unit.test.ts:204-211` 和 `test/integration/push-channels.test.ts:1192-1219` 是本次新增的反向用例；如果去掉 `hasVisibleText`，U+200B、U+3164、U+2800、U+FE0F 的期望值会变成 `true`，用例会真的失败。不足的是“正文不含句子”没有真正喂入句子（意见 3），quiet 提议也没有 `approvalCopy` 未被调用的反向断言（意见 4）。

4. 逐个核对结果：
   - `hasVisibleText`：产生于 `home-urgency.ts:130`，使用于 `home-urgency.ts:149` 和 `production-apple-push.ts:325`，两端都接受 `string`、返回 `boolean`，类型一致。
   - `approvalCopy` 选项：提供端是 `service-main.ts:2797-2799`，消费端是 `production-apple-push.ts:315-330`；`WebPushLocale` 和 `HomeLocale` 都是 `"zh-CN" | "en" | "ja"`，`http.home` 在 `production-http-composition.ts:329` 和 `:1682` 处就是 `ProductionHomeControl`，有 `approvalCopy`，两端签名兼容；`http` 尚未赋值时可选链会返回 `null`，消费端按“退回 catalog”处理。
   - `labelBasis: "model"`：`ApplePushAction` 的联合类型本来就有 `"catalog" | "model"`（`production-apple-push.ts:69`），没有后端/客户端校验会拒绝这个值。
   - `affirmLabelMax` 最多 64：`strict-configuration.ts:1666-1671` 明确限制 1..64，和 ADR 0255 第 9 条一致。
   - 唯一对不上的值是 ADR 第 8 条对“去掉哪些不可见字符”的描述，见意见 1。
