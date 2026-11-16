## 侧重检查

- **缺失/非法 `--pr-brief`**：读了 `scripts/model-review/opencode-review.mjs:3514`、`3651-3655`。不传时 `options.prBrief` 保持 `undefined`；传了不存在时在花钱前以 `ARG_PR_BRIEF_MISSING` 停下；与 `--shadow`、无 `--previous`、非 `code-review` 组合时以 `ARG_PR_BRIEF_ONLY_WITH_PREVIOUS` 停下。路径完整。
- **打印条件**：读了 `opencode-review.mjs:4338-4354`。仍是 `planned?.block` + 有 `outcome=ok` + 抽样次数未满；`planned` 只在 `commits.previous` 存在时产生（`4029-4041`），所以不会在首轮误打印。
- **委托链路**：读了 `scripts/model-review/delegate.mjs:106-128`、`420-455`。`reviewArgv` 不生成 `--pr-brief`，`COMMAND_OPTIONS` 也不接受它；委托的增量轮必然走 `SHADOW_FULL_SKIPPED`。文档已写明这是预期行为。
- **命令拼接与不可信输入**：读了 `scripts/model-review/increment.mjs:330-350`。`prBrief` 仍经 `shellQuote` 进入打印命令；新增函数只是把 `brief` 固定成 `prBrief`，没有引入新的注入面。现有测试覆盖了含空格和单引号的路径（`test/tooling/review-increment.test.mjs:591-611`）。
- **文档与代码一致性**：流程卡 `model-review-card.md:18`、`model-review.md:165` 与代码一致；ADR 0280 有一处旧句子未同步（见下）。新增数据文件里 668/151 秒、各轮步数、材料哈希与 ADR 对应段落一致；按表统计“别处的读”占比约 79.8%，能支撑 ADR 的“70% 到 90%”。
- **未核实**：`docs/assets/review-cost/2026-11-16-incremental-round-task-scope.txt` 声称与 `.agents/reviews/pr-584/usage.jsonl` 一致——按本轮规则未读该目录，未核实。未运行测试（只能跑 git 命令），只核对了测试代码。

**上一轮意见核对**

- 第 1 条（中高）：有害部分已修好。`shadowSuggestion` 在 `prBrief === undefined` 时直接返回 `SKIPPED`，不再用本轮材料顶替（`increment.mjs:346-350`）。残留是委托轮次永远不抽样（见意见 2）。
- 第 2 条（低）：只做了文档缓解。流程卡说“不在了就去掉 `--pr-brief`”，但 `--finish-round` 打印的 `NEXT` 仍无条件带 `--pr-brief`（见意见 1）。

### 1. 低 — `--finish-round` 的 `NEXT` 仍无条件带 `--pr-brief`，上一轮第 2 条只靠人工看文档删除

文件：`scripts/model-review/opencode-review.mjs:2121`、`.agents/instructions/model-review-card.md:18`

问题：`NEXT fix-and-rereview` 固定输出 `--pr-brief <整份 PR 材料>`，只有流程卡新增的一句“第 1 轮材料已经不在了就去掉 `--pr-brief`”在兜底。主线程若照“照抄 `NEXT`”执行而没注意括号，仍会走 `ARG_PR_BRIEF_MISSING`，这正是上一轮第 2 条描述的错误路径。

证据：

```js
// opencode-review.mjs:2121
`NEXT fix-and-rereview ... --brief <本轮材料> --pr-brief <整份 PR 材料>${gateway}`,
```

```md
<!-- model-review-card.md:18 -->
...（只在脚本建议抽样全量复核时用到；第 1 轮材料已经不在了就去掉 `--pr-brief`，...）
```

建议：让 `finishRound` 在生成 `NEXT` 时检查第 1 轮材料是否存在，存在才带 `--pr-brief`；或至少把“材料不在就不带”写成命令生成逻辑，而不是只写进说明。这样第 2 条才算结构性修好。

（读代码证实）

### 2. 低 — 委托轮次不再错误顶替，但也永远不会抽样，漏查衡量的样本会缺一块

文件：`scripts/model-review/delegate.mjs:106-128`、`scripts/model-review/increment.mjs:346-350`

问题：第 1 条意见的“静默拿本轮材料当整份材料”已消除，但委托链路仍然不认、不传 `--pr-brief`，所以委托的增量轮只会打印 `SHADOW_FULL_SKIPPED pr-brief-missing`。若 PR 584 这类轮次多由云端线程跑，ADR 0280 的验收（“看抽样全量复核有没有报出增量轮漏掉的中高问题”）会长期缺少这部分样本。这是有意取舍，文档已说明，但属于功能缺口。

证据：

```js
// delegate.mjs:107-125（没有 --pr-brief）
const argv = [ "--mode", task.mode, ... "--previous", task.previous,
  "--models", ..., "--brief", task.brief, "--gateway", "magpie", ... ];
```

建议：在 `delegate.mjs` 的 `COMMAND_OPTIONS`、`reviewArgv`、`parseTask` 中支持并转发 `--pr-brief`，由 Mac 线程传入第 1 轮材料路径；若继续选择不抽样，至少在报表里把跳过次数单独列出，避免把“没有样本”误读成“没有漏查”。

（读代码证实；对“样本缺失影响验收”的判断为推测）

### 3. 低 — ADR 0280 仍写增量轮一定打印 `SHADOW_FULL_SUGGESTED`，没有同步新增的 `SKIPPED` 分支

文件：`docs/adr/0280-incremental-review-rounds-see-only-the-pr-s-own-increment.md:113`

问题：代码现在可能打印 `SHADOW_FULL_SKIPPED pr-brief-missing`，但 ADR 这一句仍是无条件表述。同一份 ADR 本轮被修改过，却只改了第 130、141 行，容易让后来读 ADR 的人以为没有 `--pr-brief` 也会给抽样命令。

证据：

```md
<!-- 0280:113 -->
...脚本在增量轮后打印 `SHADOW_FULL_SUGGESTED <命令>`，主线程照跑...
```

```js
// increment.mjs:347-349
prBrief === undefined
  ? "SHADOW_FULL_SKIPPED pr-brief-missing"
  : `SHADOW_FULL_SUGGESTED ${shadowCommand({ ...run, brief: prBrief })}`;
```

建议：把第 113 行改成“有 `--pr-brief` 时打印 `SHADOW_FULL_SUGGESTED`，没有时打印 `SHADOW_FULL_SKIPPED`”，与第 145 行一起补上缺失分支。

（读代码证实）

### 4. 低 — 新增测试只覆盖 `shadowSuggestion` 辅助函数，没有覆盖 `opencode-review.mjs` 的调用端

文件：`test/tooling/review-increment.test.mjs:614-622`、`scripts/model-review/opencode-review.mjs:4344-4353`

问题：测试能锁住辅助函数的正反两路；但上一轮真正的缺陷在调用端（`options.prBrief ?? options.brief`）。如果以后有人只把调用端改回 `prBrief: options.prBrief ?? options.brief`，`shadowSuggestion` 仍会返回 `SUGGESTED`，现有测试不会失败。反向用例没有真正覆盖“整条调用路径”。

证据：

```js
// test:616-621
const suggested = shadowSuggestion({ ...run, prBrief: "/r/first.md" });
...
expect(shadowSuggestion({ ...run, brief: "/r/round.md" })).toBe(
  "SHADOW_FULL_SKIPPED pr-brief-missing",
);
```

```js
// opencode-review.mjs:4344-4353
shadowSuggestion({
  pr, base, head,
  prBrief: options.prBrief,   // 这里若改成 ?? options.brief，单测抓不到
  ...
})
```

建议：加一条调用端级别的检查，例如把“从 `options` 生成抽样提示”的逻辑抽成可测函数并断言它只读 `options.prBrief`；或在现有读取脚本源码的测试里断言不再出现 `options.prBrief ?? options.brief`。

（读代码证实）

## 必答问题

1. **涉及。** 增量改了 `.agents/instructions/model-review.md`，需要确认它是否进入模型提示。核对结果：`reviewQuestions` 只截取 `<a id="checklist"></a>` 之后的两段（`opencode-review.mjs:306-317`），改动在第 165 行“怎么跑”一节，不在提取范围内；`buildPrompt` 的固定前缀（`370-399`）未改，工具定义、历史消息和遮盖逻辑也未改。每轮会变的 `head`、`base`、`previous`、`brief`、`increment` 仍全部放在末尾的 `material`（`400-423`）。因此发给模型的内容结构不变，仍然只在末尾追加，每轮变化值仍在最后一段。上一轮意见的修复没有碰提示内容。

2. **不涉及。** 新增的只有 stdout 给主线程看的 `SHADOW_FULL_SKIPPED pr-brief-missing` 和 `shadowSuggestion` 的纯函数结果；由输入决定，没有时间字段、无序集合或依赖前后文的遮盖。模型请求字节不变。

3. **涉及。** 新增了 `shadowSuggestion` 的单测，有 `prBrief` 和无 `prBrief` 两种情况；无 `prBrief` 的反向断言也确实存在。缺口是只测辅助函数、不测调用端（见意见 4）。测试未实际运行，只读了代码。

4. **涉及。** 逐个核对：`shadowSuggestion`（导出）的使用端是 `opencode-review.mjs:51,4344` 和测试 `review-increment.test.mjs:21,616-621`，入参字段与 `shadowCommand` 的解构一致；`SHADOW_FULL_SKIPPED pr-brief-missing` 没有代码解析，只有流程卡/说明文档消费；`prBrief` 的生产端是 `parseArgs`（`3514`，`resolve` 成绝对路径）和校验（`3651-3655`），消费端是 `shadowSuggestion`；缺失时返回 SKIPPED，存在时交给 `shadowCommand`，两端校验相容。没有新增配置键或序列化格式。残留问题见意见 1、2。
