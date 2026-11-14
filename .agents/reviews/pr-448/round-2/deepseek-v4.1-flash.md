## 结论

第 2 轮的 4 条修改**基本落实**：`reserveModels` 已去掉 `previous` 条件；`coveragePoints` 的 `requested` 和 `direct` 已改成只认 `substitute === undefined`；文档和测试补了“加模型要三样东西”；`reviewArgv` 已总是写 `--models`。

但第 2 条只改了一半：`covering` 仍把 `substitute` 非 `true` 的记录当作直接覆盖记录，和新的“只认没有 `substitute` 字段”不一致。另有允许模型集合不再被限定为 Andy 批准的两个、文档措辞与代码不一致、以及 delegate 本地默认模型和远端提交配置可能不一致的风险。

## 侧重检查

我重点查了这些路径：

- **错误路径**：DeepSeek 服务报错后的替补路径（`substituteFor`）、第一轮替补、`reserveModels` 预留 GLM；未发现会绕过替补条件的路径，但替补记录字段没有在账本解析时校验。
- **不合规范/不可信输入**：`review-models.json` 的 `allowed/default/substitutes`；账本里的 `model`、`substitute`、`substituteFor`；`--models` 的短名/完整名。`review-models.json` 校验了基本结构、重复短名、默认和替补是否在 allowed 内；但账本的 `substitute` 字段可任意取值，见发现 2。
- **安全/权限**：没有新增写文件、执行命令或越过只读限制的代码；`readReviewModels` 只读配置文件。模型集合现在可由配置扩大，见发现 1。
- **资源耗尽**：`reserveModels` 现在第一轮单模型也预留 GLM 积分和路由组，符合第 1 轮意见，但会让第一轮按两个模型预留额度；这是预期行为。
- **不可撤销操作**：本改动不引入删除、覆盖历史、强制推送等不可逆操作。合并门仍只读账本；低严重度/覆盖记录写入是原有逻辑。
- **规则/文档与代码一致性**：发现 1、3；其余默认模型、替补、链起点、`requested/default/substitute` 的说明与代码基本一致。

## 发现（读代码证实的）

### 1. 中：`allowed` 不再被限制为项目规则批准的两个模型

文件:行：`scripts/model-review/opencode-review.mjs:57-80`、`test/tooling/opencode-review.test.mjs:524-529`、`docs/adr/0255-review-models-default-to-deepseek.md:48`

问题：配置校验只要求 `allowed` 非空、无重复、名字格式合法；新增测试只核对“当前每个 allowed 模型都有侧重、输出上限、网关条目”。没有任何检查保证 `allowed` 仍然只有 Andy 批准的两个模型。一个 PR 只要把第三个模型同时加进 `allowed`、`MODEL_LENSES`、`MODEL_OUTPUT_LIMITS` 和 `gateway.json`，现有测试就会通过，但 ADR 写的是“`allowed`（能用的模型，仍然只有项目指令第 17 条允许的两个）”。

证据：

```js
59:  const names = (list) =>
60:    Array.isArray(list) &&
61:    list.length > 0 &&
62:    list.every((name) => typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(name)) &&
63:    new Set(list).size === list.length;
64:  if (!names(config?.allowed)) problems.push("allowed");
```

```js
524:    for (const model of REVIEW_MODELS) {
525:      const name = model.split("/").pop();
526:      expect(MODEL_LENSES[name]).toEqual(expect.any(String));
527:      expect(MODEL_OUTPUT_LIMITS[name]).toEqual(expect.any(Number));
528:      expect(readGatewayConfig(undefined, REVIEW_MODELS).models[model]).toBeDefined();
529:    }
```

建议：要么在测试里直接断言 `REVIEW_MODELS` 等于批准的两个完整模型名；要么把允许集合继续写在代码里，只把 `default`/`substitutes` 放进配置。若确实要允许第三个模型，应先改项目规则/ADR，并让测试明确列出批准集合。

### 2. 低：`covering` 仍把带 `substitute` 字段但值不是 `true` 的记录当作直接覆盖

文件:行：`scripts/model-review/opencode-review.mjs:1281-1282`、`scripts/model-review/opencode-review.mjs:1306-1311`、`test/tooling/opencode-review-merge-gate.test.mjs:1070-1077`

问题：作者说“直接通过只认没有 `substitute` 字段的记录”，`direct()` 和 `requested` 确实用了 `=== undefined`，但 `covering` 的 else 分支对任何“不是 `=== true`”的记录都按直接记录处理，包括 `substitute: false`、字符串 `"true"`、`null`。这些记录虽然不能单独让一轮通过（因为 `direct()` 仍不认它们），但会参与 `covering.map(record => record.head)` 和 `previous` 的计算；和另一条有效记录一起出现且 `head` 不同时，会把本应忽略的坏记录变成 `REVIEW_ROUND_HEADS_DIFFER` 硬错误。

证据：

```js
1281:    const direct = (model) =>
1282:      passed.some((record) => record.model === model && record.substitute === undefined);
```

```js
1306:    const covering = passed.filter((record) =>
1307:      record.substitute === true
1308:        ? needed.includes(record.substituteFor) &&
1309:          record.model === SUBSTITUTES[record.substituteFor]
1310:        : needed.includes(record.model),
1311:    );
```

新增的反向用例只有单条坏记录：

```js
1071:        ok(1, f.reviewed, "nobody/model"),
1072:        ok(1, f.reviewed, glm, { substitute: "true", substituteFor: deepseek }),
1073:        ok(1, f.reviewed, deepseek, { substitute: false }),
```

单条时 `needed` 为空，走不到 `covering`，所以这个不一致没有被测到。

建议：`covering` 的非替补分支也改成 `record.substitute === undefined && needed.includes(record.model)`；或者在 `parseUsage` 里直接拒绝 `substitute` 不是 `undefined/true` 的记录。再加一个“有效记录 + 同轮 `substitute:false` 且不同 head”的反向用例。

### 3. 低：文档措辞与代码不一致

文件:行：`docs/adr/0255-review-models-default-to-deepseek.md:48`、`scripts/model-review/opencode-review.mjs:68-79`、`test/tooling/opencode-review.test.mjs:531`、`.agents/instructions/model-review.md:68`

问题一：ADR 说“三项都要在 `allowed` 里，清单不能为空、不能重复”，代码实际只检查 `default` 和 `substitutes` 的键/值在 `allowed` 内；`substitutes` 允许空对象，新增测试还明确断言空 `substitutes` 合法：

```js
531:    expect(reviewModelsProblems({ ...valid, default: valid.allowed, substitutes: {} })).toEqual([]);
```

问题二：`model-review.md` 第 68 行说“账本里这一轮出现过的、不是替补的模型”，而代码用 `substitute === undefined` 判断，`substitute:false` 虽然“不是替补”也会被排除。

建议：把 ADR 改成“`allowed` 不能为空且不能重复；`default` 和 `substitutes` 的模型都必须在 `allowed` 里；`substitutes` 可以为空”，并把规则文件的“不是替补”改成“没有 `substitute` 字段”。

## 推测/风险（未证实）

### 4. 低：delegate 写的是本地默认模型，远端分支配置可能不同

文件:行：`scripts/model-review/delegate.mjs:115-116`、`scripts/model-review/delegate.mjs:143-149`、`scripts/model-review/opencode-review.mjs:2869-2882`

`reviewArgv` 总是把本地模块的 `DEFAULT_REVIEW_MODELS` 转成短名写进命令。但这条命令是在云端 checkout 的 `task.tip` 上执行的，复核脚本会用那个提交里的 `review-models.json` 校验 `--models`。如果 Mac 本地工作区配置和 `task.tip` 的配置不同，就可能出现远端 `ARG_INVALID --models`，或者实际跑的模型集合和本地 `checkResult` 预期的集合不同。正常流程里本地应已在 `task.tip`，所以这是风险而不是已确认的当前缺陷。

建议：任务没写模型时，要么继续省略 `--models` 让远端用自己提交里的默认值，要么从 `task.tip` 读取 `review-models.json` 后再生成命令；并加一条本地配置与 tip 配置不同的测试。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   没有发现。这个改动改的是复核脚本的模型选择、覆盖判断和配置读取，不改 `buildPrompt` 的固定部分，也不改系统提示、工具定义、历史或遮盖。`buildPrompt` 的固定文字在 `scripts/model-review/opencode-review.mjs:350-361`，每轮变化的 `head/base/previous/brief` 都在后面的“本次材料”里（`362-374`），即最后一条用户消息。每个复核模型每次运行都是独立会话；改默认模型不会重写已经发过的请求前缀。

2. **同一段文字会不会在不同请求里变成不同字节？**
   没有发现新增的不确定性。`review-models.json` 在模块加载时读一次，数组顺序由提交里的文件固定；`coveragePoints` 里的 `Set` 顺序取决于账本顺序，不是模型请求内容；账本的 `at` 时间字段也没有进入提示词。允许列表顺序若被人改动，`REVIEW_MODELS[0]` 相关探针行为会变，但那是每次提交固定的配置变化，不是同一请求内的字节漂移。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有检查：`test/tooling/review-gateway.test.mjs:819-824` 覆盖 `previous` 为 `undefined`/`"abc"` 时都预留 GLM；`test/tooling/opencode-review-merge-gate.test.mjs:1070-1077` 覆盖非 allowed 模型、字符串 `"true"`、`substitute:false`；`test/tooling/opencode-review.test.mjs:524-529` 覆盖 allowed 模型的侧重/上限/网关条目；`test/tooling/review-delegate.test.mjs:827-834` 覆盖 `reviewArgv` 写出默认 `--models`。
   按代码阅读，这些反向用例会失败：保留 `previous` 条件时 undefined 用例失败；去掉 `REVIEW_MODELS.includes` 时 `nobody/model` 用例会通过，从而测试失败；`direct` 改回 `!== true` 时 `substitute:false` 用例会通过，从而测试失败；去掉 `--models` 时字符串断言失败。
   但**没有实际运行测试**（本轮只能读代码）。另有一个测试缺口：没有覆盖“有效记录 + 同轮 `substitute:false` 且不同 head”的情况，因此发现 2 不会被现有测试抓住。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   大部分能：`review-models.json` 的完整模型名用于 `parseArgs`、账本 `model`/`substituteFor`、`gateway.json`；短名用于 `MODEL_LENSES`、`MODEL_OUTPUT_LIMITS`、`reviewArgv` 的 `--models`；`parseArgs` 同时接受短名和完整名；重复短名会被 `reviewModelsProblems` 拒绝；测试核对了每个 allowed 模型的侧重、上限和网关条目。
   但有四处不一致或缺口：`allowed` 可被扩大（发现 1）；`covering` 没有使用与 `direct` 相同的字段判断（发现 2）；ADR/规则措辞与代码不完全一致（发现 3）；delegate 生成本地默认模型、远端在 `task.tip` 用另一份配置校验（发现 4，风险）。

## 未核实

- `.agents/reviews/pr-448/round-1/judgments.md`、`verdicts.jsonl` 等记录文件读不到：git 保护返回 `REVIEW_GIT_REFUSED records-path`。因此我只能核对本轮材料转述的四条判断，无法亲自确认 judgments 原文。
- 未运行任何测试或 `npm run check`，以上“反向用例会失败”是按代码阅读推断，不是实测结果。
- 未验证真实 OpenCode/Magpie 环境下的第一轮 GLM 预留和替补行为，只核对了对应函数和单元测试代码。
