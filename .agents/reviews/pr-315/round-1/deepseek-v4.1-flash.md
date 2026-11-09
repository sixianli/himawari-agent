# 复核结论（63ddef5 对比 d6b3a96）

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档与代码一致性）

| 检查项 | 结论 |
|---|---|
| 正则回溯/资源耗尽 | 两条新规则只有字符类上的 `*`/`{6,}`，`(?!\[)` 和 `(?=...[^\s,，;；]*\d)` 都被空白/逗号边界限制在同一个 token 内，没有嵌套量词；模块级 `g` 正则只用于 `replace`（会重置 lastIndex），`NOT_A_PASSWORD_VALUE` 无 `g` 且只用于 `test`。按代码看不出明显 ReDoS。但捕获值可任意长，会原样进入 `known`/`table`（见下）。 |
| 不可信输入 | 规则全部是常量拼出的正则，用户输入不进入正则源码（`escapeRegExp` 只用于 named-earlier 的已知值），无注入。 |
| 遮盖与机器密钥标记 | 先跑 machine-secret，再跑密码；三条规则都有 `(?!\[)` 或 `value.startsWith("[")` 保护，不会把 `[密钥]` 再遮一次。 |
| trusted 固定文字 | 固定文字被替换成不含数字的单字符填充，新规则都要求含数字，因此不会碰填充字符，也就不会触发 trusted 复原失败/整段回退。 |
| 不可逆遮盖 | `pi-output-export.ts:47` 和 `gmail-body.ts:198` 用不带 `table` 的遮盖直接写出/截断，误遮是不可撤销的；新规则偏宽会放大这个代价。 |
| 文档与代码 | ADR 0188 的“只取决于这段文字自己”“日期和版本号不算”与代码不完全一致（见下）。 |
| 消费端校验 | `ruleId` 在 DB 只做 `boundedText(…,128)`（`sqlite-sensitive-interception-operations.ts:52`），category 有白名单；没有发现新值过不了校验。 |
| 未核实 | 无法运行测试（环境只放行 git 命令），下文所有具体正则是“按代码/正则推演”，没有实际执行。 |

---

## 问题清单（严重度从高到低）

### 1. 中：没有分隔符的规则会把中文/技术句子里“关键词后的第一个短语”当成密码，既误遮又会给出“已保护”的错觉
文件：`packages/sensitive-capture/src/redaction.ts:83-86`、`335-342`

证据（我读到的新规则）：
```ts
const PASSWORD_BARE_VALUE = new RegExp(
  `((?:${PASSWORD_KEYWORDS})\\s+)(?!\\[)(?=${PASSWORD_VALUE}*\\d)(${PASSWORD_VALUE}{6,})`,
  "giu",
);
const PASSWORD_VALUE = "[^\\s,，;；]";
```
`PASSWORD_VALUE` 把汉字、假名、韩文、`-`、`。`、`:` 等都算作“值”，所以“值”实际上可以是整个中文短语。按正则推演：

- `密码 我已经用了3年` → 命中，`我已经用了3年` 被替换为 `[密码]`，并被 `classificationWithIdentifiers` 标成 `sensitive`；ADR 0185 写明 `sensitive` 记忆不进全文/实体索引，普通记忆会因此检索不到。
- `密码设为8位以上` → 命中 `8位以上`，普通密码策略说明被遮。
- `密码 is` 之外，`密码 我已经设了3次 abc12345` 会先命中 `我已经设了3次` 并遮掉它，真正的 `abc12345` 仍原样保留。改动前这种写法本来就漏（ADR 已承认“关键词与值之间隔着别的词”），但现在会额外产生一条 `password` finding，看起来像已经处理过。

英文关键词也没有词边界（`password` 会匹配 `1Password`、`notpassword` 的内部），例如 `1Password hunter22` 会把 `hunter22` 当密码遮掉。

建议：给“没有分隔符”这条规则收窄值的字符集（例如只允许 ASCII 可见字符/URI token，或要求“至少一个字母和一个数字”，排除 CJK 与句读），并给英文关键词加 `(?<![\p{L}\p{N}_])`/`(?![\p{L}\p{N}_])` 边界；同时补“中文短语含数字不遮”“5 字符含数字不遮”的反向用例。

### 2. 中：ADR 说“遮盖只取决于这段文字自己”，代码里还会取决于前面已点名的值
文件：`docs/adr/0188-recognize-passwords-without-a-separator.md:52`；`redaction.ts:390-404`；`packages/application/src/services/model-egress.ts:129,219-226`

证据：
```ts
// redaction.ts
if (known !== undefined && known.size > 0) {
  for (const [value, placeholder] of known) {
    if (!text.includes(value)) continue;
    ...
```
```ts
// model-egress.ts：同一次请求内共享 #known
readonly #known = new Map<string, string>();
...
known: this.#known,
```
测试也明确写着 `it("is a function of its own text and the earlier values only" ...)`（`redaction.unit.test.ts:196`）。所以同一句 “abc12345 已经记下” 在“前面有 `密码 abc12345`”的请求里会被 `named-earlier` 遮掉，在孤立请求里不会。它仍然不依赖**后文**，满足前缀只追加，但 ADR 的“只取决于这段文字自己”是错的，应写成“取决于自己和前面已点名的值”。

### 3. 中低：“日期和版本号不算”只覆盖了很窄的格式，常见日期会被当密码遮掉
文件：`redaction.ts:88`；ADR 同页第 32 行附近的决定

证据：
```ts
const NOT_A_PASSWORD_VALUE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|v?\d+(?:\.\d+)+)$/iu;
```
按正则推演，`密码 2026年11月8日`、`password is 2026-11-08T10:30`、`密码 11/08/2026`、`密码 2026-11-08.` 都不匹配排除规则，会被遮；而 ADR 写的是“日期（2026-11-08）和版本号（v2.0.1）不算”，语义上是“日期/版本号这一类”。建议要么扩正则以覆盖 ISO 时间、中文年月日、美式日期与尾随标点，要么把 ADR 改成“只排除 `YYYY-MM-DD`/`vX.Y.Z` 这两种字面格式”。

### 4. 低：严格规则不吃 `NOT_A_PASSWORD_VALUE`，同一个日期加不加分隔符结果不同
文件：`redaction.ts:330-342` 与 `88`

证据：严格规则的替换没有调用 `NOT_A_PASSWORD_VALUE`：
```ts
text = text.replace(PASSWORD_ASSIGNMENT, (_match, lead: string, value: string) =>
  value === MACHINE_SECRET_PLACEHOLDER || value.startsWith("[") ? `${lead}${value}` : maskPassword(lead, value),
);
```
于是 `密码 2026-11-08` 不遮，`密码：2026-11-08` 遮。这不是本 PR 引入（严格规则语义未变），但与新规则的“位置/顺序不影响语义”的预期相冲突；如果希望一致，应把排除条件也用到严格规则，或在 ADR 明说两者不同。

### 5. 低：测试的反向用例没有真正覆盖 6 字符长度门槛和部分分支
文件：`packages/sensitive-capture/test/redaction.unit.test.ts:78-84`、`redaction.ts:78-86`

- `密码 abc 很短` 同时被“必须含数字”和“至少 6 字符”挡住。把 `{6,}` 改成 `{1,}` 后它仍然通过，所以长度门槛没有独立反向用例。
- 没有 `are`/`was` 的正例，也没有“带词规则遇到日期/版本号”的正反例。
- 没有针对新写法的 `check:prompt-prefix` 用例；现有 prefix 测试只用了验证码/卡号（`redaction.unit.test.ts:117-127`）。
- 可以确认会失败的反向用例：删掉数字守卫会让 `the password is required`、`密码改成每月一次`、`密码管理器 1Password 很好用` 失败；删掉 `NOT_A_PASSWORD_VALUE` 会让 `密码 2026-11-08 更新`、`password v2.0.1 发布` 失败。

### 6. 低：三套规则复用一个 ruleId，且捕获值会把尾随标点一起记入 known/table
文件：`redaction.ts:325-329`、`34-43`；`model-egress.ts:129`

证据：新规则都走 `maskPassword` → `see("password", "password-keyword", value)`；`EGRESS_REDACTION_RULE_IDS` 没有新增条目。功能上消费端接受（DB 任意 bounded 字符串），但统计/拦截记录无法区分“严格/带词/无分隔符”。另外 `value` 含尾随句读（`PASSWORD_VALUE` 不排除 `。！？`），`mask(..., rememberValue=true)` 会把 `abc12345。` 整体存进 `known`，之后消息里单独出现的 `abc12345` 不会被 `named-earlier` 遮住。这是既有机制，但新规则更常产生这种值；建议捕获后剥离尾随标点再记入 `known`，并补重复值用例。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 会，但只影响“历史里刚好含新写法”的对话：出口遮盖在每次发送时对原始历史重新计算，部署后这些历史消息从第一条命中处起字节变化一次（`model-egress.ts:219-226` 对每个字段重新 `redactForEgress`）。代码没有重排消息，之后每轮仍然只追加最后一条；本改动没有引入时间字段或轮次相关的值，占位符是 `HMAC(kind,value)`（`placeholderTag`），稳定。遮盖对“后文”没有依赖（列表按顺序处理，`known` 只保留前面的值），所以前缀一旦重算完就稳定。注意 ADR 说“只取决于这段文字自己”不准确，正确说法是“取决于自己和前面的内容”（见问题 2）。

2. **同一段文字会不会在不同请求里变成不同字节？** 会，但只由“前面已点名的值”造成，不依赖时间或无序集合：`#known` 在一次请求内跨字段共享（`model-egress.ts:129,220-226`），后面的消息里同一值即使没有关键词也会被 `named-earlier` 遮掉（`redaction.ts:390-404`）；同一段文字在孤立请求和“前面出现过该密码”的请求里字节不同。这符合 `.claude/rules/prompt-prefix.md` 的“自己 + 前面的内容”，但直接反驳 ADR 0188 第 52 行的绝对说法。没有发现依赖后文、时间戳或集合遍历顺序的新字节来源。

3. **有没有对应自动检查，反向用例真的会失败吗？** 有正/负例和确定性/幂等测试（`redaction.unit.test.ts:88-115`），`identifiers` 也加了正/负例（`identifiers.unit.test.ts:89-96`）。数字守卫和日期/版本排除的反向用例是真的会失败；但 `{6,}` 长度门槛没有独立反向用例（`密码 abc 很短` 已被数字守卫挡住），`are/was`、带词日期分支、以及新写法的 prefix 专门用例都缺（详见问题 5）。无法实际运行测试，以上是按测试代码与正则推演。

4. **每个产生/修改的值，使用它的地方都能接受吗？** 逐个核对：`findings.kind` 仍是白名单中的 `password`；`sighting.ruleId` 仍是合法字符串（DB `boundedText(…,128)`，category 走白名单）；占位符格式与 `EGRESS_PLACEHOLDER_PATTERN`、`LOCATED_PLACEHOLDER`、`placeholderTable`/`restorePlaceholders`、流式还原器（缓冲上限 48 字符，新占位符长度相同）一致；没有新增配置键、清单项或序列化格式。唯一值得改的是复用 `password-keyword` 导致三套规则不可区分（问题 6）；另外 `known`/`table` 会接收尾随标点的值（问题 6），SQLite/UI 能接受但后续精确匹配会变弱。
