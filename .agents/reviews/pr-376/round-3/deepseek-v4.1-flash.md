## 结论摘要

PR-376 第 3 轮的错误路径基本收紧了，但「current 新语义」在控制中心的两个单元测试夹具里仍是旧值，且控制字符只在决策链做了显示侧清洗，`proactive.overview` 仍会因同一份遗留数据违反契约。以下按严重度排列，先列读代码证实的内容，再列推测。

## 读代码证实的问题

### 中：遗留控制字符发件人会让 `proactive.overview.read` 违反契约

- 文件:行：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:258-264`、`packages/application/src/services/proactive-overview.ts:280`、`apps/agent-service/src/production-proactive.ts:369`、`packages/gateway-contracts/src/contracts-v2.ts:353-366`
- 问题：`writeSettings` 现在拒绝 `\p{Cc}`，但读取侧 `readSettings` 只过滤 `\p{Surrogate}`，overview 又把发件人原样送出；契约 `proactiveSendersSchema` 用 `boundedString(320)`，会拒绝 `<0x20`/`0x7f`。第 3 轮新增集成测试正是用 `["bank\n.example"]` 直接写库来证明决策链能读，但同一份数据去读主动提醒总览会失败。这是「遗漏的读者」。
- 证据：

```ts
// sqlite-proactive-operations.ts:258-262
importantSenders: Object.freeze(
  senders
    ? (JSON.parse(senders.parameters) as { senders: string[] }).senders.filter(
        (sender) => !/\p{Surrogate}/u.test(sender),
      )
    : [],
),
```

```ts
// proactive-overview.ts:280
importantSenders: settings.importantSenders,
```

```ts
// production-proactive.ts:369
importantSenders: [...overview.importantSenders],
```

```ts
// contracts-v2.ts:355-356
const senders = array(boundedString(320)).parse(input, path);
...
sender.length > 254 ||
```

`boundedString` 的拒绝条件在 `validation.ts:96-99`：`code < 0x20 || code === 0x7f`。

- 建议：读取设置或 overview 输出时统一按契约做一次清洗/过滤（例如复用 `displayRuleId` 或拒绝并丢弃该条），并补一条「库里有 `\n` 发件人时 `proactive.overview.read` 仍能通过契约」的用例；或在 `writeSettings` 之外统一在读取层做兼容。

### 中：控制中心两个单元测试夹具仍把未知裸 id 写成 `current: true`，与新语义矛盾

- 文件:行：`apps/control-center/test/proactive-interactions.unit.test.ts:994-1007`（断言在 `:1093`）、`apps/control-center/test/weekly-report.unit.test.ts:1226-1239`
- 问题：第 3 轮把 `current` 改为「`ref.revision === null` 且真的重建出版本」。`floor_unknown` / `floor_other` 的 `kind` 是 `unknown`，`rebuild()` 对 unknown 永远返回 `undefined`，服务端不可能再产出 `revision: null, current: true`。这两个夹具没跟着改，`proactive-interactions` 还断言这种不可能状态要显示「只记了规则名，显示的是现在的版本」，等于把矛盾 UX（同时显示「现在的版本」和「这一版的规则内容查不到」）固化进测试。
- 证据：

```ts
// proactive-interactions.unit.test.ts:994-1007
{
  ruleId: "floor_unknown",
  revision: null,
  current: true,
  kind: "unknown",
  ...
  wording: null,
  tests: { state: "unavailable", total: 0, failedAt: null },
```

```ts
// proactive-interactions.unit.test.ts:1093
expect(drawer).toContain("只记了规则名，显示的是现在的版本");
```

```ts
// rule-version.ts:171-176
const revision = ref.revision ?? stored?.revision ?? (builtIn ? 1 : null);
const rebuilt = revision === null ? undefined : rebuild(kind, revision, stored);
...
current: ref.revision === null && rebuilt !== undefined,
```

- 建议：把这两个夹具改成 `current: false`（或改成真正可重建的裸 id 版本，如裸 `quiet_hours` + 存储行），并把「现在的版本」断言移到那个有效夹具上。这样 UI 测试才真正覆盖第 3 轮的语义。

### 低：`ruleRef` 的 240 上限与存储/契约的 256 不一致，且抛错路径无降级

- 文件:行：`packages/application/src/rules/rule-ref.ts:6-8`、`packages/application/src/services/proactive-rules.ts:44,65,87`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:657-661`、`packages/gateway-contracts/src/contracts-v2.ts:1036,1149`
- 问题：`ruleRef` 对 `length > 240` 直接抛 `RangeError`，但决策记录校验仍允许 1–256 的 rule id，契约也允许 256。`floorHitRefs` 本来设计了「规则不在手册里就写裸 id」的降级，但规则在手册里且 id 为 241–256 时会先调用 `ruleRef` 抛错；`suppressPushHits` / `quietHitRefs` 更是无条件 `ruleRef`。这个异常在邮件检查 `#finish` 里没有被捕获，会中断整次检查而不写决策记录。
- 证据：

```ts
// rule-ref.ts:6-8
export function ruleRef(ruleId: string, revision: number): string {
  if (ruleId.length > 240) throw new RangeError("Rule id is longer than 240 characters");
  return `${ruleId}@${revision}`;
}
```

```ts
// proactive-rules.ts:78-88
for (const id of new Set(Object.values(floorHits).flat())) {
  const rule = rules.find(...);
  refs.add(rule ? ruleRef(rule.id, rule.revision) : id);
}
```

```ts
// sqlite-proactive-operations.ts:657-661
const ids = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256) &&
  new Set(value).size === value.length;
```

- 现存数据下会不会失败：**不会**。生产 `rules` 来自 `ruleBookFor(settings)`，id 都是 `RULE_IDS` 常量；`ownerRules` 只在测试里注入（`production-proactive.ts:161` 构造时没有传）。所以这是约束不一致造成的潜在雷，不是当前线上数据会触发的问题。
- 建议：把上限统一（要么规则创建处保证 ≤240，要么存储/契约也改成 240），或让 `floorHitRefs` / `suppressPushHits` / `quietHitRefs` 在超长时降级写裸 id 并记录告警，而不是让整次检查失败；补一条 241–256 id 在邮件检查路径上的用例。

### 低：`readRuleVersions` 对损坏参数无保护，且用普通对象接收任意 ref 键

- 文件:行：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:364,382-384`
- 问题：一处 `rule_book_rules.parameters` 不是合法 JSON 时，`JSON.parse` 会直接把整个决策链读取抛掉，而 `describeRuleVersion`/`rebuild` 本来是能优雅降级成 `unavailable` 的。另外 `versions` 是 `{}`，ref 来自记录里的任意字符串（校验只限 1–256 字符），`ref === "__proto__"` 会触发原型 setter，虽然影响范围仅限该局部对象，但和项目其他地方（如 `Object.hasOwn`）的谨慎程度不一致。
- 证据：

```ts
// sqlite-decision-ledger-operations.ts:364
const versions: Record<string, RuleBookVersion> = {};
...
versions[ref] = Object.freeze({
  ...found,
  parameters: Object.freeze(JSON.parse(found.parameters) as Record<string, unknown>),
});
```

- 建议：`JSON.parse` 包 try/catch 降级，`versions` 用 `Object.create(null)` 或 `Map`。

## 推测

- 若将来把 `ownerRules` 接成动态规则（例如从库中加载用户自定义 id），240 的限制会让邮件检查在 `#finish` 直接失败且不写记录，而不是只丢一条规则引用。当前代码未见这条接线路，故列为推测。
- 旧数据里若有 C1 控制字符（`U+0080`–`U+009F`），`displayRuleId` 不会替换（只处理 `<0x20` 与 `0x7f`），但契约 `boundedString` 也不拒绝 C1，所以决策链仍能通过；真正会受影响的是 `writeSettings` 的 `\p{Cc}` 拒绝：`completeAuthorization` 在首次连接时会把读到的旧设置原样再写一次（`production-proactive.ts` 的 `store.writeSettings({ ...settings, enabled: true, now })`），旧 C1 值会导致授权完成失败。这个路径是否需要兼容旧数据，取决于线上是否存在这种数据，未核实。

## 侧重检查

- **错误路径**：`ruleRef` 抛出的 `RangeError` 在邮件检查 `#finish` 无捕获（见上）；`readRuleVersions` 的 `JSON.parse` 无保护（见上）；决策链对未知/缺失版本会降级为 `current: false`、`wording: null`、`tests: unavailable`，这条路径读代码确认是对的。
- **不合规范/不可信输入**：`ruleIds` 只校验长度 1–256，链读取时用 `displayRuleId` 把 C0/DEL 换成空格后才交给契约，方向和 `boundedString` 一致；C1 不在 `displayRuleId` 范围，但契约也不拒绝，故不会因此读不出。`wording.values` 另外截 256。`readRuleVersions` 的普通对象键是唯一明显的不严谨点。
- **安全**：本次改动不涉及密钥、出口遮盖或权限判定；`displayRuleId` 只做字符替换，不引入 HTML 注入（React 也会转义）。没有新增不可信网络输入。
- **资源耗尽**：新增的例子生成长度有界（最多 3 个发件人、8 个静默时段），没有无界循环；`readRuleVersions` 对每次链读取按 `ruleIds`（上限 500）逐条查询，数量有界但会随记录规模线性增长，未发现放大器。
- **不可撤销操作**：本次没有删除/迁移/覆盖类操作；`writeSettings` 只是新增拒绝条件，减少写入。
- **规则/文档/代码一致性**：ADR 0215 与写入约定第 3 轮的改动和 `current`、`floorHitRefs` 裸 id 行为一致；抽屉 i18n 三种语言都有 `ruleCurrent` / `ruleWordingMissing`。不一致的是上面两个控制中心单元测试夹具，以及 overview 这个遗漏的读取者。
- **未核实**：`.agents/reviews/pr-376/round-2/judgments.md` 在当前 sparse checkout 中不存在，未能读到第 2 轮判断；未运行测试（工具限制），测试是否真跑过、是否全绿未验证；合并 `origin/main` 带入的 PR-368 校准/阈值改动不属于 PR-376，未逐行复核。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。PR-376 第 3 轮的改动全部在决策记录读取/显示、规则校验和测试夹具上，没有改 `packages/prompt-catalog`、工具定义或会话历史。`proactivePrompt` 仍然把每轮变化的时间放在末尾：`proactive-mail-check-service.ts:391-412` 里 `renderPrompt(MAIL_JUDGMENT_NOW, { now, timeZone, today })` 是最后一段；`rule.examples` / `BUILT_IN_RULE_VALUES` 只被 `runRuleExamples`、`assertRuleExamples`、`describeRuleVersion` 使用，不进入模型请求。因此仍然是「只在末尾追加，每轮会变的值在最后一条消息里」。合并带入的 `automatic-memory-service` 阈值改动也不改提示词字节。

2. **同一段文字会不会在不同请求里变成不同字节？** 模型请求不会。显示侧 `displayRuleId` 是纯函数，不依赖前后文；`wording.values` 的截断固定；决策链的规则顺序由 `sortedUnique` 固定；`readRuleVersions` 的对象遍历不决定输出顺序（链按排序后的 `inputs.ruleIds` 输出）。`current`/`wording` 取决于数据库当前状态，但那是记录展示，不是模型可见内容。唯一可注意的点是 `displayRuleId` 会把不同原始 id 折叠成相同显示串（如 `a\nb` 与 `a b`），这是确定性的，不会因请求而变。

3. **有没有自动检查，反向用例会不会真的失败？** 有：
   - `check:rule-registry` 已加入 `test/integration/decision-email.test.ts`（`package.json:58`）。
   - `decision-chain.test.ts` 新用例：`writeSettings` 含 `\n` 必须 reject；库里直接塞 `\n` 时链仍能读且 `wording.values` 为 `["bank .example"]`。`chainOf` 会走 `gatewayV2MessageSchema.parse`（`:250`），所以去掉 `displayRuleId` 会让 `\n` 触发 `boundedString` 失败，反向成立。
   - `rule-version.unit.test.ts`：241 字符必须抛 `RangeError`，去掉抛错会失败。
   - `current`：单元测试 unknown 裸 id 期望 false、集成 `gmail-1` 期望 false、`gmail-defaults` 裸 `quiet_hours` 期望 false；回退第 3 轮的修改会失败。
   - 缺口：`\p{Cc}` 只想测试了 `\n`（C0），没有单独覆盖 DEL/C1；没有测试 241–256 id 进入邮件检查路径；没有浏览器用例覆盖 `current: true`；控制中心两个夹具反而把不可能状态写死了。

4. **每个新值/字段/格式的两端是否都能接受？** 逐项核对：
   - `ruleIds` 的 `id@revision`：生产端 `floorHitRefs`/`suppressPushHits`/`quietHitRefs`；消费端 proactive 写入校验 1–256、`parseRuleRef` 接受 0–999999999 的修订号、决策链契约 `ruleId: boundedString(256)`。240 上限与 256 的差异见上面的低严重度项；修订号 ≥1e9 时 `parseRuleRef` 会退化成裸 id，但不常见。
   - `ruleHits` 合并进邮件详情 `ruleIds`：生产端 `production-observation.ts` 先 `parseRuleRef(...).ruleId` 再 `displayRuleId`，契约 `decision.email` 的 `ruleIds` 是 `boundedString(256)`，可接受。
   - `ruleVersions` 新字段：以原始 ref 为键，`describeRuleVersion` 用同一 ref 取，匹配；但普通对象键/无保护 `JSON.parse` 见上。
   - `current`：契约是 `booleanValue`、抽屉按布尔渲染；语义两端一致，但两个控制中心单元测试夹具没有同步，见上。
   - `wording.values`：生产端来自内置词表或存储的发件人（写入上限 254），显示前 `displayRuleId` 再 `slice(0,256)`，契约 `boundedString(256)` 可接受。
   - `writeSettings` 的 `\p{Cc}`：新数据比契约更严，不会产生契约不接受的链数据；但读取侧 overview 仍是契约校验的薄弱点，见上。
   - `importantSenderExamples` / `quietHoursExamples`：只被示例运行和链的 `tests` 使用，契约通过 `tests.total/failedAt` 数字输出，没有不合规值泄漏。
   - 「找不到规则写裸 id」：`floorHitRefs:87` 与写入约定一致；裸 id 最长 256 也能通过存储校验。
