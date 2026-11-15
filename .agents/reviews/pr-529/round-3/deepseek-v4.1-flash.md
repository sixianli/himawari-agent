本轮查过的范围：`git diff e991dc144614d12c17e6711999bd712e447ed853..c608045b09a99cbcad309ae45dd7e3e3645f31fe` 涉及的 `production-apple-push.ts`、`home-urgency.ts`、两个测试、ADR 0255；并沿证据追到 `production-home.ts`、`strict-configuration.ts`、`production-web-push.ts`、`service-main.ts`、设计规格第 11 节与 ADR 0089。第 2 轮复核文件在稀疏检出中不存在，未读到原文；测试和 lint 均未运行，相关结果标未核实。

## 侧重检查

- 错误路径：`approvalCopy` 抛错、返回 `null`、空白、只有 Cf、只有非 Cf 不可见字符，逐条对照了推送边界和 home 读取口。前四种已处理，第五种仍未拦住（见意见 1）。
- 不可信输入：按钮文字来自模型、内容可被外部邮件影响。home 侧还校验了换行、控制字符、双向控制符、长度和否定按钮同文；推送边界只新增了“去掉 Cf 后为空”这一项，其余仍依赖 home 侧（见必答 4）。
- 安全与锁屏：确认推送正文仍取对话标题，模型的 `sentence` 不会进入 `body`（`production-web-push.ts:653-660`）；但 ADR 0255 第 9 条的“只有几个字”在配置成 64 时并不成立（见意见 2）。
- 资源耗尽：本轮未改长度上限、批量、超时或重试；标签仍受 `affirmLabelMax`（1 到 64）约束，推送载荷路径未变。
- 不可撤销操作：审批按钮的凭据、版本和内容指纹绑定未在本轮改变；本轮只影响显示文字，不改变按钮语义或凭据。
- 文档一致性：ADR 0255 第 8 条没有记录本轮新增的“无可见字符”拒绝条件，与代码不一致（见意见 3）；第 9 条与设计规格第 11 节的“锁屏例外”表述基本对得上。
- 未核实：`.agents/reviews/pr-529/round-2/deepseek-v4.1-flash.md` 不存在，无法核对上一轮原文；`prompt-prefix.md` 不在稀疏检出中，无法读规则原文。

## 上一轮意见核对

- 上一轮意见 1 的“只有零宽/格式字符（Cf）”路径确实改好了：`acceptsHomeAffirmLabel` 和推送边界都以去掉 `\p{Cf}` 后的内容判空，两个反向用例在修复前会分别把 `\u200B` 和 `\u2060\u200D` 当成合法标签，现在会拒绝；家庭 emoji 仍通过。但“no visible character”这个更宽的说法没有完全实现，见意见 1。
- 作者说“ADR 0255 第 9 条写明按钮文字是锁屏规则的例外及理由”，属实；设计规格第 11 节第 495 行也确实写了普通审批的同意按钮用模型文字。但“只有几个字”与可配置到 64 的上限不完全一致，见意见 2。
- 作者说“测试补‘正文不含句子’断言”，断言存在，但没有实际覆盖到模型句子，见意见 4。

### 1. 中 — 只去掉 `\p{Cf}`，其他不可见字符仍能让“同意”按钮显示为空

文件: `packages/application/src/services/home-urgency.ts:138-144`、`apps/agent-service/src/production-apple-push.ts:317-319`

问题：修复只把 Unicode 类别 `Cf`（格式字符）去掉后再判空。变体选择符（如 U+FE0F，类别 Mn）、组合附加符、Hangul Filler（U+3164，类别 Lo）、盲文空白（U+2800，类别 So）等都不是 `Cf`，也都绕过现有的 `UNSAFE_LINE_CHARACTERS`。模型如果只写这类字符，标签仍然通过，锁屏上的“同意”按钮仍可能看起来是空的。

证据（读代码证实）：
```ts
// home-urgency.ts:127
const UNSAFE_LINE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
// home-urgency.ts:138-144
    UNSAFE_LINE_CHARACTERS.test(label) ||
    label.replace(/\p{Cf}/gu, "").trim().length === 0
```
```ts
// production-apple-push.ts:317-319
      const label = copy.affirmLabel?.trim() ?? "";
      if (label.replace(/\p{Cf}/gu, "").trim() === "") return null;
      return label === "" ? null : label;
```
测试名和提交说明写的是 “rejects a label that has no visible character”，但代码只认 `Cf`。

推测/未运行：具体哪些码点在目标 iOS 字体下真的完全不可见，我没有运行或真机验证；按 Unicode 类别判断，U+2800、U+3164、U+FE0F 都不在 `Cf` 里，也不会被现有正则拦下。

建议：把“可见内容”定义成一个共用函数，至少同时去掉 `\p{Cf}`、`\p{Mn}`、`\p{Me}` 和 `\p{Default_Ignorable_Code_Point}`，再由 home 读取口和推送边界共同调用，避免两处规则继续分叉。若接受不了这种扩大，至少把测试名和提交说明改成“去掉 Cf 后为空”，不要宣称已覆盖所有不可见字符。

### 2. 低 — ADR 说按钮文字“只有几个字”，但 `affirmLabelMax` 允许配置到 64 个字形

文件: `docs/adr/0255-model-scores-urgency-of-home-items.md:65`、`packages/platform-node/src/strict-configuration.ts:1626`

问题：第 9 条用“只有几个字、受 `affirmLabelMax` 限制”论证按钮文字可以作为锁屏规则的例外。默认值确实是中文 6、日文 8、英文 16，但启动校验允许把每种语言的上限配到 64；64 个字形足以写出收件人、金额或具体操作，与 ADR 0089 第 5 条“审批的具体操作不上锁屏”的意图有明显张力。

证据（读代码证实）：
```ts
// docs/adr/0255-model-scores-urgency-of-home-items.md:65
按钮文字是锁屏规则里的一个例外：只有几个字、受 `affirmLabelMax` 限制、由设计规格 11 节明确允许……
```
```ts
// strict-configuration.ts:1626
          integer(limit, `${field}.affirmLabelMax.${locale}`, 1, 64),
```

推测：生产配置目前大概不会用到 64，所以现网风险取决于实际配置；这是设计取舍，不是本轮引入的代码错误。

建议：既然作者已把“是否再限制数字、收件人”留给 Andy，至少把 ADR 的措辞改成“默认只有几个字，上限可配到 64”，或在配置校验里把上限压到更小的值，避免文档承诺比实际保证更强。

### 3. 低 — ADR 0255 第 8 条没有记录代码新增的“无可见字符”拒绝条件

文件: `docs/adr/0255-model-scores-urgency-of-home-items.md:64`、`packages/application/src/services/home-urgency.ts:142`

问题：ADR 第 8 条把读取时逐项核对的拒绝原因列成清单，但没有“去掉格式字符后没有可见内容”这一项。按文档，只有零宽字符的标签应当通过（它不是换行、控制字符或双向控制符，也没超长），代码却会拒绝。规则文件和代码对不上。

证据（读代码证实）：
```md
// ADR 0255:64
……读取时逐项核对，不合格就退回目录里的通用文字“同意”并标 `catalog`：……
含换行、控制字符或改变文字方向的字符（例如 U+202E），这类字符能让按钮看起来写的是另一件事。
```
```ts
// home-urgency.ts:141-142
    UNSAFE_LINE_CHARACTERS.test(label) ||
    label.replace(/\p{Cf}/gu, "").trim().length === 0
```

建议：在第 8 条的拒绝清单里补一句“去掉零宽/格式字符后没有可见字符”，与代码和测试名保持一致。

### 4. 低 — “正文不含句子”的新断言是空断言，不能拦住句子进锁屏

文件: `test/integration/push-channels.test.ts:987-990`、`test/integration/push-channels.test.ts:1015`

问题：这条测试的 `approvalCopy` 只返回 `{ affirmLabel: "发出去" }`，没有返回任何句子；整个测试文件里“张三”只出现在断言这一行。即使推送代码以后开始把模型句子放进正文，这个断言也不会失败，除非那句句子恰好包含“张三”。

证据（读代码证实）：
```ts
// push-channels.test.ts:987-990
        approvalCopy: async ({ approvalRequestId }) => {
          asked.push(approvalRequestId);
          return { affirmLabel: "发出去" };
        },
```
```ts
// push-channels.test.ts:1015
    expect((plain.json["aps"] as { alert: { body: string } }).alert.body).not.toContain("张三");
```
另外，`ProductionApplePush` 的 `approvalCopy` 选项类型本身只声明了 `affirmLabel`（`production-apple-push.ts:139-143`），推送正文实际来自 `content.build(locale)`，审批正文是对话标题（`production-web-push.ts:653-660`）。所以目前代码路径确实是安全的，只是这条断言没有证明它。

建议：让测试夹具给出一个含姓名或金额的句子，并断言它不出现在 `aps.alert.body`；或者直接断言审批推送正文等于目录里的标题/提示文字。这样将来正文构建改错时测试才会失败。

## 必答问题

1. **是否改变模型已经见过的请求开头：不涉及。** 本轮只改推送侧标签校验、ADR 和测试；`homeUrgencyPrompt` 的固定文字、参照、新条目和最后一行 `now/timeZone/language/affirmMax` 都没有变（`home-urgency.ts:183-201`）。发给模型的内容仍是固定文字在前、会变的值在最后一行，没有改系统提示、工具定义、历史消息或遮盖逻辑。规则文件 `prompt-prefix.md` 原文未核实（稀疏检出中不存在），结论来自代码。

2. **同一段文字会不会变成不同字节：不涉及。** 新增判断只依赖单个字符串本身，不依赖前后文、时间或集合顺序；`\p{Cf}` 替换和 `trim` 都是确定性的。

3. **自动检查和反向用例：部分足够。** 单元测试和推送集成测试各有一个零宽反向用例；按修复前代码阅读，它们确实会失败（`\u200B` 会被 `trim` 保留、长度非零、不命中 `UNSAFE_LINE_CHARACTERS`）。但没有覆盖非 `Cf` 的不可见字符；“正文不含句子”的断言是空断言。测试实际运行结果未核实。

4. **每个改动值的所有使用端：没有发现两端校验冲突。** `acceptsHomeAffirmLabel` 的返回值只被 `home-urgency.approvalCopy`（`home-urgency.ts:321`）转成 `string | null`，再经 `production-home.approvalCopy`、`service-main.ts:2768` 传给推送；`production-home.ts:620` 的 `modelLabel` 和 `production-apple-push.ts:347-348` 的 `affirmLabel ?? text.approve` 都接受 `null`，分别退回首页目录文字和推送目录文字。本轮没有新增标识、配置键、字段或序列化格式。需要留意：推送边界只重复了“去掉 Cf 后非空”这一项，没有重复长度、双向控制符和否定按钮同文校验；当前生产路径仍先经过 home 侧完整校验，所以没有失配，但如果以后替换 `approvalCopy` 提供方，这个边界不会拦住超长或含双向控制符的标签。
