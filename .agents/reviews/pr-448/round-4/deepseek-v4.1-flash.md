## 结论

没有发现会让正常脚本写出的账本把未复核改动放行的功能性错误；作者列的几条说法（配置来源、一轮算数的条件、链起点）与代码一致。发现的主要问题在**合并门的边界（缺记录账本）**和**文档承诺「只改配置 default 即可」与测试实际硬编码不一致**。

下面「读代码证实的」条目我亲自打开了对应代码行；「推测」条目写明触发前提。

---

## 发现（按严重度从高到低）

### 1. 中：只有一条替补记录、没有失败原模型记录的轮次也能起链/算数

**文件:行**：`scripts/model-review/opencode-review.mjs:1283-1311`、`:1342`

**问题**：`stoodIn(model)` 只看替补记录本身，不要求被替补的模型这一轮里真的有一条（失败）记录；`complete(DEFAULT_REVIEW_MODELS)` 又独立于 `requested` 生效。因此一条 `{model: glm, substitute: true, substituteFor: deepseek, outcome: "ok", previous: null}` 的账本记录，就能让一轮算数并成为链的起点，而 DeepSeek 那次「失败」在账本里根本没有记录。

**证据（读代码证实）**：

```js
const stoodIn = (model) =>
  passed.some(
    (record) =>
      record.substitute === true &&
      record.substituteFor === model &&
      record.model === SUBSTITUTES[model],
  );
...
const needed = complete(requested)
  ? requested
  : complete(DEFAULT_REVIEW_MODELS)
    ? DEFAULT_REVIEW_MODELS
    : [];
const covering = passed.filter((record) =>
  record.substitute === true
    ? needed.includes(record.substituteFor) &&
      record.model === SUBSTITUTES[record.substituteFor]
    : record.substitute === undefined && needed.includes(record.model),
);
```

`requested` 只收 `substitute === undefined` 的记录（`:1290-1298`），所以上面这条替补记录使 `requested = []`，`complete([])` 为假，随后 `complete(DEFAULT_REVIEW_MODELS)` 靠 `stoodIn("opencode-go/deepseek-v4.1-flash")` 为真；`point.previous === null` 时 `walkChain` 直接重置并接受（`:1342`）。

**触发前提（推测）**：账本缺了那次 `api-error` 记录（脚本正常会先写失败记录再替补，所以正常运行不会出现）。这属于仓库已声明的「防误操作，不防有意」范围，但它是「哪种账本内容会让没被完整复核的改动通过」的具体答案。

**建议**：`stoodIn(model)` 额外要求这一轮里 `model` 本身有记录（例如 `inRound.some(r => r.model === model && r.substitute === undefined)`），或要求 `record.substituteFor` 出现在 `requested` 里；这样「只有一条替补记录」不能单独起链。

---

### 2. 中：ADR 0259 说「只改 default 即可」，但测试硬编码了默认值，改配置必然红

**文件:行**：`docs/adr/0259-review-models-default-to-deepseek.md:48`、`.agents/instructions/model-review.md:4`、`test/tooling/opencode-review.test.mjs:524`、`test/tooling/opencode-review-merge-gate.test.mjs:1065,2350`

**问题**：文档承诺「以后要改默认，只改这个文件的 `default`」，但有多处断言把当前默认写死为 DeepSeek 一个。只按文档改 `default`，这些测试会失败；而且 `[merge gate]` 里以 `round-1:default` 为预期语义的用例也会失效。实际改默认需要同时改测试，文档说法与事实不符。

**证据（读代码证实）**：

- ADR 0259:48：「以后要改默认，只改这个文件的 `default`」
- `test/tooling/opencode-review.test.mjs:524`：`expect(DEFAULT_REVIEW_MODELS).toEqual(["opencode-go/deepseek-v4.1-flash"]);`
- `test/tooling/opencode-review-merge-gate.test.mjs:1065`：`expect(DEFAULT_REVIEW_MODELS).toEqual([deepseek]);`
- `test/tooling/opencode-review-merge-gate.test.mjs:2350`：`expect(DEFAULT_REVIEW_MODELS).toEqual([REVIEW_MODELS[0]]);`
- `test/tooling/opencode-review-merge-gate.test.mjs:1050-1056` 把丢弃 GLM 的轮次断言成 `round-1:default`，默认改成两个模型后语义也会变。

**建议**：要么把这些断言改成从 `readReviewModels()` 派生、只校验「配置被读入」而不校验具体值；要么把文档改成「改 `default` 后要同步更新测试里写死的默认断言」。

---

### 3. 低：ADR 0175 正文仍写着旧规则，只在 frontmatter 加了 amended_by

**文件:行**：`docs/adr/0175-cheaper-code-review-rounds.md:62-63,70,72,93`

**问题**：该 ADR 仍是 `status: active`，正文继续写「第 1 轮两个模型都跑」「起点是最后一轮两个模型都通过」「方案讨论仍然两个模型都跑」，只有头部 `amended_by` 指向 0259。直接读 0175 的人会得到与当前代码/规则相反的结论。

**证据（读代码证实）**：`docs/adr/0175-cheaper-code-review-rounds.md:62`「代码复核第 1 轮两个模型都跑，之后默认只跑 DeepSeek。第 1 轮只给一个模型时脚本拒绝」；`:63`「起点是最后一轮不带 `--previous`、两个模型都通过的复核」；`:70`「方案讨论……仍然两个模型都跑」。而代码 `parseArgs` 默认 `DEFAULT_REVIEW_MODELS`（`opencode-review.mjs:2815`），`walkChain` 起点条件已改为 `point.by !== "low-fix" && point.previous === null`（`:1342`）。

**建议**：在 0175 对应条目加一句「已被 ADR 0259 修正」的行内说明，或确认仓库接受仅靠 `amended_by` 的约定（若接受，本条可降为不处理）。

---

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆 / 文档一致）

- **不可信账本输入**：`record.substitute` 用严格 `=== true` / `=== undefined` 判断（`opencode-review.mjs:1281-1311`），`"true"`、`false`、`null` 都不会被当成通过；`record.model` 通过 `REVIEW_MODELS.includes` 过滤；`SUBSTITUTES[record.substituteFor]` 对 `__proto__`/`constructor` 之类字符串只会得到非字符串，无法通过 `record.model === ...`。这些是读代码证实的，未发现绕过。
- **配置输入**：`reviewModelsProblems` 校验 `allowed`/`default`/`substitutes` 的类型、重复、子集关系（`:57-81`）；`readReviewModels` 对读不到/解析失败/校验失败都以 `REVIEW_MODELS_CONFIG_INVALID` 抛出（`:83-93`）。未发现 `allowed` 名字可用于路径穿越：正则只允许单个 `/`，且 `promptFileName` 会再拼后缀。
- **资源/花费**：`reserveModels`（`:3012-3015`）为单模型代码复核预留 GLM，但初始 `budgetCheck`（`:3214-3219`）仍只按 `options.models` 计 1 个模型；替补时另有 `budgetCheck({models:[substitute.model]})`（`:3396-3401`）会拦住超额，因此不会真正突破先问线，只是「预留」和「预计花费」口径不一致（既有设计，非本次引入）。
- **不可逆操作**：本改动只读配置、写账本/记录，没有新增删除或覆盖用户数据的路径。
- **文档与代码一致**：`model-review.md` 第 4/49/60/68/104/155 行的主要说法与代码一致（默认、替补、链规则、自检仍跑 `allowed` 两个模型）；发现的不一致见上面第 2、3 条。
- **未核实**：PR 自己的 `round-1`～`round-4` 复核记录不在工作区（`git` 读取 `.agents/reviews/pr-448` 被环境拒绝），我没有核对那几份 verdicts 本身；我也不能运行测试，反向用例「会失败」是读代码推理的结论。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** （读代码证实）`buildPrompt` 仍是固定部分（角色、工具、任务、必问问题、`MODEL_LENSES`、输出格式）在前，`head`/`base`/`previous`/`brief` 等每轮变化的值只放在「本次材料」这一条最后（`opencode-review.mjs:345-375`）。本 PR 没有改 `buildPrompt`、`MODE_TEXT`、`MODEL_LENSES`；DeepSeek 的系统提示与工具定义与改动前相同。默认模型从两个变成一个只改变「这次调用哪个模型」，不改变发给同一模型的字节。`delegate.mjs` 新增的 `--models` 只出现在给云端执行线程的命令文本里，不进入复核模型已发出的历史（`delegate.mjs:106-128`）。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**不会。** 新增的 `REVIEW_MODELS` / `DEFAULT_REVIEW_MODELS` / `SUBSTITUTES` 来自静态 JSON；`reviewModelsProblems` 里的 `Object.entries` 只影响校验、不参与序列化。`delegate.reviewArgv` 的 `--models` 由数组 `map/join` 生成，顺序来自 JSON 数组，固定。`coveragePoints` 里的 `Set` 顺序只影响门槛判断和 `REVIEW_CHAIN` 打印，不进入提示词。没有新增时间字段（账本的 `at` 不发给模型）。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有，且按代码推理反向用例会失败，但我没有实际运行（不能跑测试）。**
- `test/tooling/opencode-review.test.mjs:511-558` 覆盖配置读取与非法配置（空、重复、短名冲突、`default` 越界、`substitutes` 非对象/自替补）。
- 合并门用例覆盖：单默认模型首轮起链成功、失败轮不能起链、清单外模型/写坏的 `substitute`/`substitute:false` 不通过（`opencode-review-merge-gate.test.mjs:1062-1095`）；默认模型通过但另一模型失败时按 `default` 算数（`:1049-1056`）；只有替补顶上才算数（`:1144-1169`）。
- 反向验证：把 `walkChain` 改回 `by === "both"`、把 `substituteFor` 的 `previous` 条件加回、把 `reserveModels` 的 `previous` 条件加回、把 `delegate` 的 `--models` 去掉，对应用例都会失败。
- **缺口**：没有用例覆盖上面第 1 条「只有替补记录、没有失败原模型记录」的账本；也没有用例验证「只改 `default` 配置后测试仍绿」（事实相反，见第 2 条）。

### 4. 每个产生/修改的值，所有使用它的地方都能接受吗？

逐个核对（读代码证实）：
- `allowed`→`REVIEW_MODELS`：`parseArgs` 短名解析（`:2869-2882`）、`coveragePoints` 的 `requested`（`:1290-1298`）、`gatewayProvider`/`outputBounds`（`:185-225`）、verdicts（`:1189`）、claims（`:1779`）、自检（`:2375`）、`delegate` 校验（`:81,93,322`）。都接受完整模型名；短名冲突由 `reviewModelsProblems` 的 `allowed.short-name-repeats` 拦住。
- `default`→`DEFAULT_REVIEW_MODELS`：`parseArgs` 默认（`:2815`）、`coveragePoints` 回退（`:1303-1304`）、`delegate.reviewArgv`（`:116`）。都按完整名处理，`delegate` 再转短名；`default ⊆ allowed` 已校验。
- `substitutes`→`SUBSTITUTES`：`substituteFor`（`:982`）、`stoodIn`（`:1288`）、`covering`（`:1309`）、`reserveModels`（`:3013`）。都要求 full→full 且目标在 `allowed`，配置校验已覆盖。
- 新的 `by` 值 `requested`/`default`/`substitute`：`walkChain` 只区分 `low-fix`（`:1342-1359`），`assertReviewed` 只检查 `complete.by === "low-fix"`（`:1558`），`reviewReport` 只检查 `point.by !== "low-fix"`/`=== "low-fix"`（`:1642,1656`）。都接受新值。
- `--models` 总由 `delegate.reviewArgv` 写出：`parseArgs` 接受短名/完整名（测试 `review-delegate.test.mjs:830-841` 验证默认值），`checkResult` 用同一结果算 `expectedModels`；未发现不接受的地方。
- **不一致点**：`default` 的消费者没问题，但测试把当前 `default` 写死为 DeepSeek 一个（见发现 2），与「只改配置」的文档承诺冲突。
