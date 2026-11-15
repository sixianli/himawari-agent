## 意见

### 1. 高 — 在冻结的 gateway.v2 快照里新增必填字段，旧严格客户端会拒收

文件: `packages/gateway-contracts/src/contracts-v2.ts:878-900`、`packages/gateway-contracts/src/validation.ts:186-196`、`apps/control-center/src/gateway-client.ts:271-275`、`docs/architecture-v0.1.md:239,243,688`

问题（读代码证实）：`gateway.v2` 的 `think.settings.snapshot` 原来只有 `key/value/defaultValue/minimum/maximum/unit/overridden`，本改动把 `label`、`description`、`unitLabel` 加成了必填字段，但 `schemaVersion` 仍是 `gateway.v2`。旧客户端用旧版 schema 解析时，`object()` 对未知字段直接报 `unknown field`；反过来，新客户端解析旧服务端快照会报 `missing required field`。所以“查询参数不变，旧客户端照常能用”只在“旧客户端完全不解析这个快照”时成立；任何用旧版 `gateway-contracts` 严格解析该快照的客户端都会失败。仓库内控制中心就是这种严格解析器；Apple 端用 `JSONDecoder` 解具体结构，默认忽略未知字段，可能不受影响，但仓库内没有找到 App 的想一想设置页解码代码，线上是否已有旧客户端调用 `think.settings.read` 未核实。

证据：

```ts
const thinkSettingTextSchema = object({
  "zh-CN": boundedString(400),
  en: boundedString(400),
  ja: boundedString(400),
});
...
        label: thinkSettingTextSchema,
        description: thinkSettingTextSchema,
        unitLabel: thinkSettingTextSchema,
```

`packages/gateway-contracts/src/validation.ts:187-189`：

```ts
for (const key of Object.keys(record)) {
  if (!expectedKeySet.has(key)) fail(`${path}.${key}`, "unknown field");
}
```

`apps/control-center/src/gateway-client.ts:271-275`：

```ts
function parsedResponseBody(value: unknown): GatewayV2Snapshot {
  const parsed = gatewayV2MessageSchema.parse(value);
  if (parsed.kind !== "snapshot") throw new Error("CONTROL_CENTER_RESPONSE_INVALID");
  return parsed;
}
```

`docs/architecture-v0.1.md:243` 也写明“未知字段……一律 fail closed”，`:688` 写明 `gateway.v2` 是冻结的产品契约。

建议：如果必须兼容旧客户端，不要把新字段直接加进现有 snapshot；改用新的查询/消息类型（例如单独的 `think.settings.text.read`）或明确升到新 schema 版本。若接受破坏性变更，就要写明上线顺序（服务端先上、客户端后上）、回滚限制，并删掉“旧客户端照常能用”的说法。更好的做法是把界面文案放到单独的文本目录，而不是塞进每轮的 settings 快照。

### 2. 中 — `maxAttempts` 的单位和“重试”文案与代码实际行为不一致

文件: `apps/agent-service/src/production-think-settings.ts:88-95,122-130`、`packages/application/src/ports/configuration.ts:417-421`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:258-296`、`apps/agent-service/src/production-think-worker.ts:76-116`

问题（读代码证实）：`maxAttempts` 的 `unit` 是 `count`，而 `THINK_SETTING_UNIT_TEXT.count` 是“件 / items / 件”，所以设置页会显示“最多重试次数：3 件”（英文是 “Maximum attempts: 3 items”）。但它是尝试次数，不是条目数。`queueLimit`、`dailyLimit` 用 `count` 配“件”是对的，`maxAttempts` 不应共用这个单位。另外，文案说“一件事最多想几次，次数用完还没成就记为失败 / How many times one item may be tried before it is marked failed”，听起来普通失败也会重试；实际只有 `recoverStalled` 会把 `thinking` 且 `attempts < maxAttempts` 的条目重新排队，普通失败由 `finish` 直接置为 `failed`，不会重试。作者说“文字描述和代码实际行为一致”在这一项上不成立。

证据：

```ts
maxAttempts: {
  label: { "zh-CN": "最多重试次数", en: "Maximum attempts", ja: "最大試行回数" },
  description: {
    "zh-CN": "一件事最多想几次，次数用完还没成就记为失败。",
    ...
```

`configuration.ts:421`：

```ts
{ key: "maxAttempts", unit: "count", minimum: 1, maximum: 20, defaultValue: 3 },
```

`production-think-settings.ts:125`：

```ts
count: { "zh-CN": "件", en: "items", ja: "件" },
```

`sqlite-think-inbox-operations.ts:280-293`：

```sql
UPDATE think_inbox SET status = 'failed', reason_code = 'stalled', ...
 WHERE ... AND status = 'thinking' AND updated_at <= ? AND attempts >= ?
...
UPDATE think_inbox SET status = 'queued', ...
 WHERE ... AND status = 'thinking' AND updated_at <= ? AND attempts < ?
```

`production-think-worker.ts:98,109` 对普通失败直接 `settle("failed", ...)`。

建议：给 `maxAttempts` 单独的单位（如 `times` / “次” / “回”），或把 `unitLabel` 改为按 setting key 而不是按 unit 查；把说明改成“卡住后最多重新排队几次；普通失败直接记为失败”。补一条测试断言 `maxAttempts` 的 `unitLabel` 和三语言说明。

### 3. 中 — 新文案缺少端到端契约、长度和词表检查

文件: `test/integration/think-settings.test.ts:242-252`、`packages/gateway-contracts/test/gateway-v2.fixture.ts:642-664`、`apps/agent-service/src/production-think-settings.ts:266-280`、`packages/gateway-contracts/src/validation.ts:102-119`、`scripts/check-glossary.mjs:11-16,90`、`scripts/check-control-center-locale.mjs:7-9`

问题（读代码证实）：生产快照没有经过 `gatewayV2MessageSchema.parse`；集成测试只检查三语言键名和 `queueLimit` 的 `label`/`unitLabel`，不检查长度、空串、其他设置文案。若某条翻译超过 400、为空或含控制字符，现有测试仍会通过，直到客户端解析失败。作者说“400 字够用、不会让快照校验失败”当前成立（我读到的文字最长英文说明约 150 字符，远小于 400），但没有自动门槛，未来改文案很容易破坏契约。`check:glossary` 和 `check:locale` 只扫描控制中心的 i18n 目录，不扫描 `apps/agent-service/src/production-think-settings.ts`，所以新界面文案也不在词表和三语检查范围内。

证据：

```ts
for (const item of snapshot.payload.items as unknown as {...}[])
  for (const text of [item.label, item.description, item.unitLabel])
    expect(Object.keys(text).sort()).toEqual(["en", "ja", "zh-CN"]);
expect(snapshot.payload.items[2]).toMatchObject({
  label: { "zh-CN": "排队上限", en: "Queue limit", ja: "待ち行列の上限" },
  unitLabel: { "zh-CN": "件", en: "items", ja: "件" },
});
```

生产查询直接返回原始对象并断言为 `GatewayV2Snapshot`：

```ts
return {
  ...query,
  kind: "snapshot",
  type: "think.settings.snapshot",
  ...
  payload: {
    revision: current.revision,
    enabled: current.enabled,
    items: current.items.map((item) => ({ ...item })),
    generatedAt: this.#clock.now(),
  },
} as GatewayV2Snapshot;
```

`validation.ts:102-119` 的 `boundedString` 会拒绝空串、超过 400 和大部分控制字符，但这条规则只在客户端/测试解析 fixture 时生效，没有在生产快照上执行。

`check-glossary.mjs:11-16`：

```js
const SCANNED_DIRECTORIES = [
  ...
  { directory: "apps/control-center/src/i18n/resources", extensions: [".ts"] },
  { directory: "docs", extensions: [".md"] },
];
```

`check-control-center-locale.mjs:7-9` 也只覆盖 `apps/control-center/src` 和它的 i18n 资源。

建议：在集成测试里把真实快照交给 `gatewayV2MessageSchema.parse`（或 `parseJson`），并断言每个文案非空、长度不超过 400；补反向用例：缺一种语言、空字符串、401 字符。把新文案所在文件纳入 glossary/locale 扫描，或把文案放回受检查的共享目录。

### 4. 低 — 文案对象只冻结了外层，内层文本仍是共享可变引用（推测）

文件: `apps/agent-service/src/production-think-settings.ts:31,123,190-207,277`

问题（推测，无现有触发路径）：`Object.freeze` 只冻结最外层对象；`label`、`description`、`unitLabel` 里的 `{ "zh-CN": ..., en: ..., ja: ... }` 没有冻结，而且所有条目、所有请求共享同一批对象。`#views` 直接返回这些引用，`query` 又只做 `{ ...item }` 浅拷贝。如果将来有任何同进程调用者修改某个 `label.en`，后续请求和其他共用同一单位的条目都会跟着变，破坏“同一段文字每次字节相同”。目前没有找到这样的修改者，所以只是潜伏风险。

证据：

```ts
export const THINK_SETTING_TEXT: Readonly<Record<...>> = Object.freeze({
  ...
});
...
label: THINK_SETTING_TEXT[definition.key].label,
description: THINK_SETTING_TEXT[definition.key].description,
unitLabel: THINK_SETTING_UNIT_TEXT[definition.unit],
```

建议：深度冻结嵌套对象，或每次返回新拷贝；如果只是网关序列化，至少不要把共享引用直接交给调用者。

## 侧重检查

- 错误路径：新增字段全部来自服务端常量，没有接受新的用户输入；唯一新增失败点是文案为空、超过 400 或含控制字符时，服务端不校验，靠客户端 `boundedString` 才拒绝。这个路径没有测试覆盖，见发现 3。
- 不合规范/不可信输入：没有新增解析外部内容、命令、URL 或文件的路径；`THINK_SETTING_TEXT` 是静态文字，风险低。
- 安全：没有新增秘密、凭据、外部内容或 HTML/命令拼接；快照只返回给已认证的 owner/agent。没有新的权限或授权变更。
- 资源耗尽：固定 10 项、每项 3 个文本、每种 3 种语言，快照增量只有几 KB，没有无上限输入。
- 不可撤销操作：本改动没有新增写操作、删除、外部副作用或需要回滚的状态。
- 规则/文档一致性：`docs/architecture-v0.1.md:438` 关于“文字在 `THINK_SETTING_TEXT`/`THINK_SETTING_UNIT_TEXT`、少一项编译不过”的描述与代码基本一致；但 `gateway.v2` 是冻结契约且未知字段 fail closed，直接加必填字段与这条规则冲突（发现 1）；词表/三语检查不覆盖新位置（发现 3）。
- 未核实：Apple/App 端实际是否已经读取并按 `zh-CN`、`en`、`ja` 显示这些字段；线上是否还有旧客户端调用 `think.settings.read`；我没有运行测试，只做了只读代码核对。

## 对作者说法的核对

- 说法 1：“文字描述和代码实际行为一致。”部分成立。排队上限确实包括 `thinking`（`sqlite-think-inbox-operations.ts:189-200`）；两个门槛之间确实返回 `unsure` 并记为跳过（`think-worth-answer.ts:80-82`、`production-think-worker.ts:100-101`）；超时确实取消并记为失败（`production-think-composition.ts:190`、`production-think-runner.ts:219-226`、`production-think-worker.ts:110-116`）。但 `maxAttempts` 的单位显示为“件/items”，且普通失败不会重试，见发现 2。
- 说法 2：“400 字够用且不会让快照校验失败。”当前文字确实都低于 400，且没有空串/控制字符，所以现在不会失败；但没有自动检查守着，未来文案一长就会到客户端才失败，见发现 3。
- 说法 3：“不涉及发给模型的内容。”成立。`THINK_SETTING_TEXT` 只在 `production-think-settings.ts` 里使用，没有进入系统提示、工具定义、历史或遮盖路径；`generatedAt` 是既有的网关快照字段，也不是模型输入。
- 作者另说“查询参数不变，旧客户端照常能用”：查询参数确实没变，但响应形状变了；对旧版严格解析该 snapshot 的客户端不成立，见发现 1。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这个改动只改 `gateway.v2` 的 `think.settings.snapshot`；我在仓库里只找到 `THINK_SETTING_TEXT` 被 `production-think-settings.ts` 使用，没有进入 `production-think-runner.ts`、提示词目录、工具定义、历史或遮盖。发给模型的内容仍然只在末尾追加；每轮会变的 `generatedAt` 只在网关快照里，不是模型请求内容。依据 `prompt-prefix.md:27-28,36`，本改动没有触碰这些规则。

2. **会不会让同一段文字在不同请求里变成不同字节？** 新增文字不会：它们是常量，`items` 顺序由 `THINK_SETTING_DEFINITIONS` 固定，`zh-CN`/`en`/`ja` 的键顺序也固定，没有依赖前后文、时间或无序集合。整个快照的 `generatedAt` 仍每请求变化，但那是既有字段，且不是模型内容。唯一潜在变化源是发现 4 的浅冻结共享对象，目前没有修改者。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有部分：TypeScript 的 `Record<ThinkSettingKey, ...>` 和 `Record<ThinkSettingUnit, ...>` 会在缺 key/单位时编译失败；集成测试检查每项三语言键名和 `queueLimit` 的文案；contract fixture 的 roundtrip 会检查 fixture 里的新字段。反向用例方面，缺字段、缺语言、多语言键会被集成测试或编译挡住；但超过 400、空字符串、其他设置文案错误不会被现有测试发现，因为生产快照没有交给 `gatewayV2MessageSchema`，fixture 也是手写的短文案。所以“400 不会失败”当前没有门槛。

4. **每个新值，使用它的地方都能接受吗？** 逐个核对如下：
   - `label`、`description`、`unitLabel`：生产者是 `production-think-settings.ts:190-207`；新 schema `contracts-v2.ts:878-900` 接受当前值（非空、无控制字符、均小于 400）；fixture 已补；集成测试会读到。
   - `zh-CN`、`en`、`ja`：schema 精确要求这三个键；控制中心 locale 资源也叫 `zh-CN`、`en`、`ja`，名称一致。Apple 端实际解码未核实。
   - `unit` 值：仍来自 `THINK_SETTING_DEFINITIONS`，六种单位在 `THINK_SETTING_UNIT_TEXT` 里都有，编译期完整。
   - 旧严格客户端：不接受新增的未知字段（发现 1），所以作者“旧客户端照常能用”不成立。
   - 新客户端配旧服务端：新 schema 把三个字段当必填，旧服务端快照会缺字段；需要明确服务端先上线，或把字段做成可选。
   - `maxAttempts` 的 `unitLabel`：生产者按 `count` 取到“件/items”，但语义是次数，使用方显示会错（发现 2）。
   - 文档与检查：`docs/architecture-v0.1.md:438` 已更新；但新文案不在 `check:glossary`/`check:locale` 的扫描范围内（发现 3）。这正是 I-73 那类“生产端产生的值没有在每个使用端核对”的问题。
