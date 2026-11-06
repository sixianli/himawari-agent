## 结论摘要

最高优先级问题：**新模型 ref 是 `magpie:<Magpie id>`，而测试里的真实 id 形如 `opencode-go/deepseek-v4-pro`，含 `/`；但网页提交消息用的契约、账号偏好写入、SQLite 偏好表、浏览器本地存储都只接受 `[A-Za-z0-9._:-]`，不接受 `/`。** 选这些模型后消息发不出去，选择也存不住。这正好对应 I-73 那类“清单里的 id 能通过后端校验吗”的问题。

另外，当前检出的 `docs/incidents-and-gates.md` 里没有 I-73（grep 无结果），我按你转述的教训核对；测试没有运行（工具限制），以下测试结论都来自读代码。

---

## 一、读代码证实的问题

### 1. 严重度：高 —— 新模型 ref 含 `/`，被后端契约和持久化校验拒绝

文件：`apps/agent-service/src/production-magpie-models.ts:111-112`、`apps/agent-service/test/production-magpie-models.unit.test.ts:153`

问题：新增模型用 Magpie 原始 id 生成 ref，id 里通常带 `/`。网页选择后原样作为 `modelRef` 提交；契约要求 `machineString`，不允许 `/`，请求在到达业务校验前就会被拒绝。

证据：

```ts
// production-magpie-models.ts:111-112
ref: `magpie:${entry.id}`,
model: entry.id,
```

```ts
// production-magpie-models.unit.test.ts:153
ref: "magpie:opencode-go/glm-5.3-flash",
```

```ts
// packages/gateway-contracts/src/thread-contracts-v3.ts:158
modelRef: machineString,
```

```ts
// packages/gateway-contracts/src/validation.ts:49-57
export const machineString: Schema<string> = {
  parse(input, path = "$") {
    if (
      typeof input !== "string" ||
      input.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
    ) {
```

同样的格式还被账号偏好链路拒绝：

```ts
// packages/gateway-contracts/src/contracts-v2.ts:470
modelRef: nullable(machineString),
```

```ts
// packages/persistence-sqlite/src/sqlite-owner-preferences-operations.ts:35
const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
```

```ts
// apps/control-center/src/browser-storage.ts:29
const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
```

浏览器本地保存时 `modelRef` 也必须通过这个模式（`browser-storage.ts:248`），否则重新加载就丢掉选择。

后果：选择任何新发现的、id 带 `/` 的模型后，`thread.message.submit_configured` 会被契约校验拒绝；账号偏好保存失败；刷新后选择回退。生产样例 id 已经带 `/`，所以这不是边缘情况。

建议：不要直接把 Magpie id 放进 ref。用满足现有机器字符串语法、可逆向或可稳定映射的 ref，例如 `magpie:sha256:<hex>` 或以 base64url 编码后裁到 128 字符以内，把原始 id 保留在 `model` 字段；或者统一放宽契约、DB、浏览器存储的 ref 语法（影响面更大）。补端到端测试：用清单生成 ref，走 `submitConfiguredThreadMessageSchema`、owner preferences schema、SQLite 写入和浏览器存储回读，不能只测 `model-picker` 的假 ref。

---

### 2. 严重度：中 —— 单个坏清单项能绕过“回退”，把服务启动搞失败

文件：`apps/agent-service/src/production-magpie-models.ts:63-67`、`:51-54`、`:109-132`；下游校验在 `packages/runtime-pi/src/configured-model-binding.ts:185-195`、`:231-237`、`:241-251`

问题：解析层只做很浅的检查。空字符串 id、首尾空白的 id、标价换算后变成 `Infinity`、过大的 `context_window` 都能通过解析并生成描述符；随后 `ConfiguredPiModelBindingPort` 才抛 `must be non-empty` / `must be non-negative finite`，或在计算准入成本时抛 `PI_MODEL_ADMISSION_ESTIMATE_UNSAFE`。这些错误发生在 `expandConfigurationWithMagpieModels` 成功返回之后，不在其 `try/catch` 回退范围内，因此不是“读不到就退回配置模型”，而是启动失败。

证据：

```ts
// production-magpie-models.ts:66
if (!entry || typeof id !== "string" || !contextWindow || !maxOutputTokens || seen.has(id))
  continue;
```

没有检查 `id.trim()` 非空、长度、字符集。

```ts
// production-magpie-models.ts:51-53
const perMillion = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
};
```

`Number.isFinite(parsed)` 在乘 `1_000_000` 之前检查；例如 `"1e308"` 有限，乘完是 `Infinity`。

下游会拒绝这些值：

```ts
// configured-model-binding.ts:185-195
for (const [name, value] of [
  ["ref", descriptor.ref],
  ["model", descriptor.model],
  ...
]) {
  assertNonEmpty(value, `${field}.${name}`);
}
```

```ts
// configured-model-binding.ts:235-237
for (const [name, value] of Object.entries(descriptor.cost)) {
  assertNonNegativeFinite(value, `${field}.cost.${name}`);
}
```

```ts
// configured-model-binding.ts:244-250
const estimatedCostMicros = Math.ceil(
  descriptor.contextWindow *
    Math.max(descriptor.cost.input, descriptor.cost.cacheRead, descriptor.cost.cacheWrite) +
    descriptor.maxTokens * descriptor.cost.output,
);
if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) {
  throw new TypeError("PI_MODEL_ADMISSION_ESTIMATE_UNSAFE");
}
```

同时清单条目数量、`label` 长度、返回体大小都没有上限（`response.json()` 整包读入、`data` 全量循环），坏或巨大的清单还会造成内存和 CPU 开销。

建议：把下游的校验前移到发现边界，逐个条目校验：id 去空白后非空且符合 ref 允许字符/长度、换算后的价格 `Number.isFinite` 且不溢出、`contextWindow` 有合理上限、label 有长度上限、清单条数有上限；坏条目跳过并写诊断，只有整个清单不可用时才回退。补“空 id / 空白 id / `1e308` 价格 / 超大 context”的启动测试，确认服务仍能启动。

---

### 3. 严重度：中 —— 价格档位算不出来时，价格本身也被隐藏

文件：`apps/agent-service/src/service-main.ts:1844-1851`、`apps/agent-service/src/production-magpie-models.ts:142`、`apps/control-center/src/components/model-picker.tsx:140-147`

问题：价格和档位被绑在一起发送，`priceTiers` 在少于 3 个不同总价时返回空 Map，于是 `price && tier` 为假，连 `price` 都不返回。结果是只有 1～2 个有标价模型、或所有模型同价时，网页完全不显示价格，和“每行显示价格和档位标签”不符；文案只承诺“少于三档不打档位标签”，没有说隐藏价格。

证据：

```ts
// service-main.ts:1845-1851
const modelCatalogTags = (ref: string) => {
  const price = magpieModels.prices.get(ref);
  const tier = tiers.get(ref);
  return {
    ...(magpieModels.automaticRefs.has(ref) ? { automatic: true } : {}),
    ...(price && tier ? { price, priceTier: tier } : {}),
  };
};
```

```ts
// production-magpie-models.ts:142
if (new Set(totals).size < 3) return new Map();
```

```tsx
// model-picker.tsx:140-147
) : item.price ? (
  <span className="model-option-price">
    {message("chat.priceLine", {
      input: `$${dollars(item.price.input)}`,
      output: `$${dollars(item.price.output)}`,
    })}
```

现有测试只断言 `priceTiers(...).size === 0`（测试文件 `:288`、`:390`），没有断言这种情形下目录仍应返回 `price`。

建议：改成 `...(price ? { price, ...(tier ? { priceTier: tier } : {}) } : {})`，并为“2 个有价模型”补一条目录级测试，而不只是测 `priceTiers`。

---

### 4. 严重度：低 —— 浏览器只校验旧字段，新字段畸形时界面会崩

文件：`apps/control-center/src/gateway-client.ts:221-238`、`:254`；`apps/control-center/src/components/model-picker.tsx:140-151`

问题：`availableModels` 的运行时校验只检查 `ref/model/name/provider/thinkingLevels`，新增的 `automatic`、`price`、`priceTier` 没有校验就强转成 `AvailableModel`。如果同源服务返回 `price: {}`、`price` 为字符串或 `priceTier: "cheap"`：

- `dollars(item.price.input)` 对 `undefined` 调 `toPrecision` 会抛错；
- `TIER_MESSAGES[item.priceTier]` 得到 `undefined`，再传给 `message()`。

证据：

```ts
// gateway-client.ts:222-235
!Array.isArray(availableModels) ||
!availableModels.every(
  (item) =>
    item &&
    typeof item === "object" &&
    ["ref", "model", "name", "provider"].every(
      (key) => typeof item[key] === "string" && item[key].length > 0,
    ) &&
    Array.isArray(item.thinkingLevels) &&
    ...
```

```ts
// gateway-client.ts:254
availableModels: Object.freeze(availableModels as AvailableModel[]),
```

建议：在同一处校验 `automatic` 为 boolean、`price.input/output` 为有限的非负数、`priceTier` 属于 `low|mid|high`；不合法就丢掉对应标签/价格，或者整体拒绝配置。

---

## 二、推测 / 未核实

- 作者说真实浏览器验证了“选 DeepSeek V4 Pro 后滑杆只有它的 3 档”。从代码看，这只验证了选择后的滑杆，没有证明能成功发送消息；按上面的 ref 问题，真正发送会失败。**推测**该浏览器验证没有覆盖提交。
- 生产 Magpie 清单是否一定包含 `reasoning: true`、`reasoning_levels` 是否只含 `minimal/low/medium/high/xhigh/max`、价格字段是否确实按 token 计价：**未核实**。测试夹具与作者说法一致，但没有生产响应原文。
- `priceTiers` 是否“平分三档”：代码对 4 个模型会分 2/1/1，对含重复价格的数据可能没有 `mid` 档。**证实**与“平分”不完全一致，但是否算缺陷取决于对文案的解释。
- 测试是否实际通过、反向用例去掉修复后是否一定失败：**未运行**，未核实。

---

## 三、侧重检查

- **错误路径**：HTTP 非 2xx、空响应、空密钥、超时、fetch 抛错、配置模型不在清单里，代码都有固定错误码并回退（`production-magpie-models.ts:169-200`），这部分成立。坏条目在下游抛错则不在回退范围（见问题 2）。
- **不合规范/不可信输入**：发现层没有校验 id 字符/长度、价格换算后是否溢出、label 和清单长度（见问题 2）；生成的 ref 又没有通过现有机器字符串校验（见问题 1）。
- **安全**：`redirect: "error"` 已设置，诊断只写固定错误码，密钥会被 `trim()` 且空密钥拒绝，未发现把密钥写日志的路径。`baseUrl` 在配置加载和 `configured-model-binding` 都要求 loopback，未发现新增把密钥发往任意外部地址的路径。
- **资源耗尽**：有 5 秒共享超时，但没有响应体大小、条目数量、label 长度上限；`prices` 里对每个条目用 `added.some` 是 O(n²)。当前只影响本机 Magpie，风险低，但清单异常时会放大（见问题 2）。
- **不可撤销操作**：本改动只有启动时读清单、生成内存描述符和 UI 展示，没有写外部系统、删除、发布或不可撤销操作。

---

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   静态看不会。diff 没有改系统提示、工具定义、历史消息或遮盖逻辑；新增目录只进入 `browserConfiguration.availableModels`，`thinkingLevels` 只影响 Pi 的推理参数。没有新增“每轮变化”的值，价格和档位只在启动时算一次。唯一变化是用户主动换模型会让该对话下一轮缓存 0 命中，作者已说明，这是换模型本身造成的。未运行 `check:prompt-prefix`，只能做静态核对。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新值没有写进模型请求；`priceTiers` 对价格总和排序，给定清单是确定的。Magpie 返回数组的顺序会影响描述符顺序、`priority` 和网页排序，但不会进入发给模型的文本字节。没有新增依赖前后文的遮盖。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有解析、上限、重复 id、空价格、超时、档位、UI 搜索等单测；但缺少最关键的“生成的 ref 能否通过提交消息契约/偏好存储”的端到端检查，也缺少“坏条目不能让启动失败”和“无档位时仍显示价格”的检查。由于不能运行测试，“反向用例去掉修复后是否失败”未核实；从代码看，现有反向用例不会覆盖上述三个缺口。

4. **改动产生或修改的每个值，两端的校验能对上吗？**
   - `ref = magpie:<id>`：**对不上**。生产/测试 id 含 `/`，而 gateway `machineString`、owner preferences schema、SQLite `MODEL_REF_PATTERN`、浏览器 `CURSOR_PATTERN` 都不允许 `/`（问题 1）。
   - `thinkingLevels`：解析时限定到六个值，浏览器校验也允许这六个加 `off`，Pi 映射能接受，**对得上**。
   - `maxTokens`：被 `Math.min(entry.maxOutputTokens, primary.maxTokens)` 限制，能通过下游 `<=32768`，**对得上**。
   - `contextWindow` / `cost`：解析层允许过大或换算后无限的值，下游要求安全整数/有限数，**对不上**（问题 2）。
   - `automatic`：服务端只产生 boolean，客户端只做 truthy 判断，**基本对得上**，但客户端没有运行时校验。
   - `price` / `priceTier`：服务端产生有限数字和三个字面量，客户端类型声明能接受；但客户端没有运行时校验，且服务端把价格与档位错误耦合，导致无档位时价格丢失（问题 3、4）。
