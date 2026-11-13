## 读代码证实的问题

### 1. 高 — 第 1 轮替补在 Magpie 网关模式下没有预留/注册 GLM，ADR 说的“第 1 轮也生效”实际不成立

**文件:行**：`scripts/model-review/opencode-review.mjs:3008-3012`（配合 `:3287`、`:3055`、`scripts/model-review/gateway.mjs:747-753`）

**问题**：`substituteFor` 已去掉 `previous` 限制，但同一套替补逻辑的另一个入口 `reserveModels` 仍然要求 `previous`。第 1 轮没有 `--previous`，`models=[deepseek]` 时返回 `[deepseek]`，于是 `startLiveGateway` 只让 Magpie 建 DeepSeek 的组；随后 DeepSeek 失败、脚本真正去跑 GLM 替补时，请求的是 `opencode-go/group/glm-5.3-flash`，而网关里没有这个组，替补请求会失败。信用额度预留也少算了 GLM 那一份。

**证据**：

```js
// opencode-review.mjs:3008
export function reserveModels({ mode, previous, models }) {
  const substitute = SUBSTITUTES[models[0]];
  if (mode === "code-review" && previous && models.length === 1 && substitute)
    return [...models, substitute];
  return models;
}
```

```js
// opencode-review.mjs:3287
reserveFor: reserveModels(options),
// :3055
models: reserveFor,
```

```js
// gateway.mjs:747-753
const addGroups = (drop) => {
  for (const model of models)
    magpie(install.binary, groupArgs(config, model, ...), env);
};
```

而 `launchModel` 会按网关组名发请求：

```js
// opencode-review.mjs:178-180
export function launchModel(model, gateway) {
  return gateway ? `${GATEWAY_PROVIDER_ID}/group/${groupName(model)}` : model;
}
```

这与 ADR 和规则文字直接矛盾：

- `docs/adr/0255-review-models-default-to-deepseek.md:50`：“第 1 轮也一样”。
- `.agents/instructions/model-review.md:60`：“只跑一个模型的代码复核（第 1 轮也算）……就让 GLM 跑这一轮”。

**建议**：把 `reserveModels` 的条件改成与 `substituteFor` 一致，去掉 `previous &&`；并补反向用例：

```js
expect(reserveModels({ mode: "code-review", previous: undefined, models: [deepseek] }))
  .toEqual([deepseek, glm]);
```

另外可考虑让 `startLiveGateway` 的成员检查也覆盖 `reserveFor`，否则 GLM 服务方不可用时也不会在开跑前发现。

---

### 2. 高 — 合并门把账本里任意 `model` 名当成“这一轮要跑的模型”，未知模型也能满足完整复核

**文件:行**：`scripts/model-review/opencode-review.mjs:1290-1301`（配合 `:1743-1747`）

**问题**：新逻辑从账本记录直接构造 `requested`，没有把它限制在 `REVIEW_MODELS`（即 `allowed`）里；而 `parseUsage` 对普通代码复核记录只要求 `model` 是非空字符串，不要求它在模型清单内。于是只要账本里有一行：

```json
{"mode":"code-review","model":"anything/x","head":"<提交>","outcome":"ok","cost":0}
```

`requested=[anything/x]`、`direct("anything/x")` 为真、`complete(requested)` 为真，这一轮就会被算成完整复核，`walkChain` 还会把它当作链起点。改动前这里用 `REVIEW_MODELS.every(...)`，未知模型不可能满足条件；这是本次改动引入的新口子。正常脚本不会写出这种记录，但它正是合并门要校验的“不可信账本输入”，而且 `delegate.mjs` 对同一字段是校验的：

```js
// delegate.mjs:320-325
if (!REVIEW_MODELS.includes(record.model)) {
  problems.push(`model=${record.model}`);
  continue;
}
if (!expectedModels.includes(record.model) && !record.substitute)
  problems.push(`model=${record.model}`);
```

**证据**：

```js
// opencode-review.mjs:1290-1301
const requested = [
  ...new Set(
    inRound.filter((record) => record.substitute !== true).map((record) => record.model),
  ),
];
const complete = (models) =>
  models.length > 0 && models.every((model) => direct(model) || stoodIn(model));
const needed = complete(requested)
  ? requested
  : complete(DEFAULT_REVIEW_MODELS)
    ? DEFAULT_REVIEW_MODELS
    : [];
```

```js
// opencode-review.mjs:1743-1747
const fieldsValid =
  !MODES.includes(record?.mode) ||
  ["head", "model", "outcome"].every(
    (field) => typeof record[field] === "string" && record[field] !== "",
  );
```

同类问题还有 `substitute` 字段没有类型校验：字符串 `"true"` 不等于布尔 `true`，会被当成“非替补”记录，从而把其 `model` 计入 `requested`。这同样只有手写/损坏账本才会触发，但合并门不应该接受。

**建议**：`requested` 只取 `REVIEW_MODELS.includes(record.model)` 的记录；或在 `parseUsage` 中对代码复核记录的 `model` 做白名单校验（同时明确旧账本里已从 `allowed` 移除的模型怎么处理）。补一条反向用例：账本里只有 `ok(1, reviewed, "nobody/model")` 时必须报 `no-complete-round`，不能通过。

---

### 3. 低 — `review-models.json` 的校验放过运行时仍会被其他代码拒绝的 `allowed`

**文件:行**：`scripts/model-review/opencode-review.mjs:57-80`（配合 `:331-343`、`:184-208`、`scripts/model-review/gateway.mjs:125-126`）

**问题**：`reviewModelsProblems` 只校验 `allowed` 是“provider/model”形状、非空、短名不重复。但 `allowed` 里每个模型还必须能被 `lensFor`（代码复核/方案审核）和 `MODEL_OUTPUT_LIMITS`、`gateway.json` 支持。一个能通过 `reviewModelsProblems` 的配置（例如 `allowed: ["a/one","a/two"]`）在真正跑代码复核时会以 `LENS_UNKNOWN` 失败，而不是在启动时以 `REVIEW_MODELS_CONFIG_INVALID` 停下。ADR 0255 说 `allowed` 仍然只有项目允许的两个模型，所以当前值没问题；但配置化之后，这个校验边界值得收紧。

**证据**：

```js
// :331-343
export const MODEL_LENSES = {
  "deepseek-v4.1-flash": "...",
  "glm-5.3-flash": "...",
};
export function lensFor(mode, model) {
  ...
  const lens = MODEL_LENSES[model.split("/").pop()];
  if (!lens) throw new Error(`LENS_UNKNOWN ${model}`);
  return lens;
}
```

**建议**：要么在 `reviewModelsProblems` 里把 `allowed` 限制到支持列表，要么在文档里明确“`allowed` 只能改这两个模型，只有 `default` 可以自由改”。当前题目下前者更稳。

---

### 4. 低（推测）— `delegate.mjs` 用本地 checkout 的默认模型，可能和 `task.tip` 所在提交的配置不一致

**文件:行**：`scripts/model-review/delegate.mjs:299`、`:320-325`

**问题**：`expectedModels = parseArgs(reviewArgv(task)).models` 使用的是 Mac 本地仓库里的 `review-models.json`；云端线程执行的脚本则来自 `task.tip`。本 PR 把默认模型变成可配置文件后，如果一个被复核的分支修改了 `review-models.json`（本 PR 自己就是），或者 Mac 的 checkout 与 `task.tip` 不是同一个提交，云端实际跑的模型和本地 `check` 期望的模型就可能不同，导致 `DELEGATION_RECORD_MISMATCH model=...` 或 `absent=...` 误报。文中说“任务不写 models 时期望的是默认模型”在本地成立，但没有处理“默认模型随提交不同”这一点。

**建议**：生产上的委派任务显式写 `models`（测试 fixture 现在默认写了，但生产创建任务的地方未见改动），或让 `checkResult` 从 `task.tip` 读取 `review-models.json`，而不是用本地导入的常量。此项是代码推断，部署/任务创建流程未核实。

---

## 侧重检查

- **错误路径**：重点查了 DeepSeek 服务失败后的第 1 轮替补路径，发现 `substituteFor` 已放开但 `reserveModels` 仍挡住，见问题 1。这是本次改动最直接可触发的功能回归：DeepSeek 一宕机，第 1 轮替补也跑不起来。
- **不可信输入/安全**：合并门读取的 `usage.jsonl` 属于线程可写的输入，`parseUsage` 对 `model`、`substitute` 的类型/白名单校验不足；新逻辑把 `model` 名直接当作“这一轮要跑的模型”，未知模型可满足完整复核，见问题 2。`delegate.mjs` 有白名单校验而合并门没有，两端不一致。
- **资源耗尽/不可逆操作**：未发现本次改动新增循环、无界读取或破坏性操作；`review-models.json` 是同步小文件读取，解析失败会以 `REVIEW_MODELS_CONFIG_INVALID` 停下。合并门本身是阻止合并的边界，问题 2 削弱的是这道边界，不是额外制造破坏。
- **规则/文档与代码一致性**：ADR 0255 第 4 条和 `.agents/instructions/model-review.md:60` 关于“第 1 轮替补也生效”与代码不一致（问题 1）。ADR 0175 已被 0255 标注 `amended_by`，本身保留旧文字可以接受；`.agents/handoffs/`、`docs/engineering-casebook.md` 里“第 1 轮两个模型”的说法是历史记录，不是现行规则，未按错误处理。
- **未核实**：没有运行测试或真实 Magpie；问题 1 的“网关无 GLM 组导致请求失败”是由 `reserveModels → startLiveGateway → startGateway → launchModel` 代码链推断的。`review-models.json` 在部署/打包时是否总随脚本一起复制，未找到打包清单（`package.json` 无引用），未核实。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变 DeepSeek 已见请求开头。** `buildPrompt` 的固定部分只用 `mode`、`model`、`questions`，没有用 `options.models` 或默认模型列表：

```js
// opencode-review.mjs:345-361
export function buildPrompt({ mode, model, questions, head, base, previous, brief }) {
  ...
  const fixed = [text.role, ..., ...(lens ? [lens] : []), text.output].join("\n");
```

`head/base/previous/brief` 等每轮会变的值仍然只放在末尾的 `material` 块（`:362-374`）。工具定义/provider 模型表仍来自 `REVIEW_MODELS`（`:184-208`），本 PR 的 `allowed` 没变，所以 DeepSeek 看到的工具、系统提示和历史前缀不变。只有“这次实际调用哪些模型”变了（`options.models`，`:3379`），这不影响单个模型已见请求的字节。若以后修改 `allowed`，`gatewayProvider` 生成的 provider 模型表会变，才可能影响请求开头；本 PR 没有改 `allowed`。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 新增的 `review-models.json` 读取是确定性的，JSON 数组保持文件中的顺序；`coveragePoints` 里的 `Set` 只用于内部判断，不进入提示词。没有新增时间字段，账本里的 `at` 时间戳是原有字段，也不会发给模型。遮盖逻辑没有改动。默认模型变化只决定调用哪个模型，不会让同一段文字在不同请求里被序列化成不同字节。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，但不完整。**

已覆盖：
- 配置读取/非法配置：`test/tooling/opencode-review.test.mjs:509-550`。
- 第 1 轮默认模型单独完成、失败的第 1 轮不通过、默认回退、替补：`test/tooling/opencode-review-merge-gate.test.mjs:1025-1160`。
- `parseArgs` 默认值与各模式：`opencode-review-merge-gate.test.mjs:2331-2360`。
- 委派任务不写 models 时期望默认模型、未请求的模型被拒：`test/tooling/review-delegate.test.mjs:828-856`。

这些用例在旧代码上确实会失败，属于有效反向用例。但缺少两条关键反向用例：

- 账本里只有未知模型 `ok` 记录时，合并门必须不通过（问题 2）。
- `reserveModels({ mode: "code-review", previous: undefined, models: [deepseek] })` 必须返回 `[deepseek, glm]`（问题 1）。现有 `test/tooling/review-gateway.test.mjs:820-830` 仍按旧假设只测了“有 `previous`”的情况，`previous` 为 `undefined` 时用的是两个模型，恰好绕开了单模型第 1 轮。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

- `allowed` → `REVIEW_MODELS`：当前值仍是两个已知模型，`parseArgs`、`lensFor`、`gatewayProvider`、`readGatewayConfig`、`delegate.validateTask` 都能接受。但配置校验没有保证 `allowed` 中的模型都有对应 lens/gateway 条目，见问题 3。
- `default` → `DEFAULT_REVIEW_MODELS`：被 `parseArgs` 用作默认值、被 `coveragePoints` 用作回退集合；校验保证非空、无重复且是 `allowed` 子集，两端都能接受。
- `substitutes` → `SUBSTITUTES`：被 `substituteFor`、`coveragePoints`、`reserveModels` 使用；校验保证键值都在 `allowed` 且不是自替补。`substituteFor` 和 `coveragePoints` 已接受第 1 轮，但 `reserveModels` 仍不接受，见问题 1。
- `REVIEW_MODELS_CONFIG_INVALID`：由 `readReviewModels` 抛出，直接在模块导入时终止，没有下游需要解析该错误串。
- `review-models.json` 文件本身：作为模块同级文件在导入时同步读取；仓库内路径正确，但部署时是否随脚本一起复制未核实。
