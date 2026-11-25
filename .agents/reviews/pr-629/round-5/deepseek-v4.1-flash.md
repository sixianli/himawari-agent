## 本轮范围

核对了 `git diff ca95acb..132d5ed` 的全部增量。属于本 PR 的新提交只有两个：`82cec62`（memory_open 分页密级修复）和 `6fd4a0f`（集成测试精确核对嵌入）。同一增量里的 `scripts/run-all-checks.mjs`、`scripts/delivery-mode/test_deploy.py`、ADR 0265 等改动来自 main，已经包含在对比基准 `16cc3ac` 中，不是本 PR 改动，我只确认了它们与本结论无关。

逐处读了：`apps/agent-service/src/production-memory-open.ts:155-282`、`apps/agent-service/test/production-memory-open.unit.test.ts:175-193`、`test/integration/production-http-composition-process.test.ts:1552-1563,1906-1928`，并跟踪到使用端 `production-runtime-tools.ts:895-923`、`pi-runtime-adapter.ts:1307-1319,2312-2313`、`production-run-memory.ts:290-293`、`production-memory-episodes.ts:72-90`。

## 上一轮意见核对

第 4 轮意见 1（memory_open 密级按所有页计算）已真正修好。旧代码把每次读到的 `read.dataClassification` 都推进全局 `shownClassifications`；新代码改为 `pageClassifications[页-1]`，只取当前返回页的正文、版本正文、原话，再加上记忆自身密级和请求密级。新单测 `production-memory-open.unit.test.ts:175-193` 对旧代码会失败（旧代码第一页会得到 `sensitive`），是有效的回归用例。

### 1 低 分页数组与密级数组靠两个平行数组同步，读取时缺项用 `?? []` 静默降级（当前不是缺陷，是 fail-open 结构风险）

- 文件:行：`apps/agent-service/src/production-memory-open.ts:236-237`、`245-248`、`260-268`、`275-278`
- 问题：`pages` 和 `pageClassifications` 必须成对 push，但类型上没有绑定；最后用 `pageClassifications[page - 1] ?? []` 取密级，将来若新增一条只 push `pages` 的分支，密级会被静默按空数组计算，而不是报错。
- 证据（读代码证实）：`const pages: ShownPage[] = [];` 与 `const pageClassifications: DataClassification[][] = [];` 平行声明；三个 `pages.push`（240、246、262 行附近）都与 `pageClassifications.push`（241、247、263 行附近）配对；读取处是 `...(pageClassifications[page - 1] ?? [])`（277 行）。当前所有分支确实对齐。
- 推测部分：只有未来修改分页逻辑时才可能出错，现有行为没有错算。
- 建议：把密级并入 `ShownPage`（如 `shown.classifications`），让分页和密级永远是同一个对象；或在缺项时直接抛内部错误，避免密级路径 fail-open。

## 侧重检查

- 错误路径：缺 `number`、非正整数、`page` 越界、多余参数仍抛 `MemoryOpenInputError`；不存在的编号、restricted、`deletion_pending`/`deleted_verified` 仍返回 `found:false`。本次增量没有改这些分支（`production-memory-open.ts:145-166,271-272`），确认未被破坏。
- 不可信输入：`Object.keys` 白名单、`Number.isSafeInteger`、`page` 默认 1，均未改。
- 安全/密级：restricted 的正文、版本正文、原话继续给 `null`，且不会进入密级数组；结果密级走 `highestClassification`，使用端 `#raiseVisible` 还会校验 `isModelVisible` 并与既有可见密级取最大（`pi-runtime-adapter.ts:1307-1319`），修好后不会低报当前页实际展示的内容。
- 资源耗尽：分页仍会先为所有版本建页再检查请求页码，超长记忆会占用与页数成比例的内存；这是旧有行为，本次增量未加重。
- 不可撤销操作：`memory_open` 是只读工具，无副作用。
- 规则/文档一致性：作者说法 5 与代码一致；本次增量没有改提示词、工具说明或文档。

## 必答问题

1. **不改变模型已见过的请求开头。** 增量只改 `contentClassification` 的计算和测试，`memory_open` 的 output JSON 结构、工具定义、系统提示、历史消息、遮盖结果都没变；工具结果仍只追加在末尾。`contentClassification` 只通过 `#raiseVisible` 抬高后续可见密级，不会改写已发出的字节（`prompt-prefix.md` 第 4 条）。
2. **不会让同一段文字在不同请求里变成不同字节。** 每页密级只由该页实际展示的内容和记忆自身密级决定，不依赖其他页、请求顺序或无序集合；文本分页由内容长度确定。`status` 使用 `now` 是旧有行为，不属本次增量。
3. **有对应自动检查，反向用例有效。** 新单测 `production-memory-open.unit.test.ts:175-193` 会卡住旧行为；集成测试 `production-http-composition-process.test.ts:1915-1920` 从“存在即可”改成精确两条 `settled`。我确认嵌入重试会生成 `conversation-turn-...:attempt:N` 的新行（`production-run-memory.ts:290-293`），会被该查询计入并导致测试失败，因此等待和过滤不会漏掉重试型多余调用；非 turn 的 embedding 另有第 1908-1914 行精确核对一条。既有“同页 sensitive 必须抬高”“REVERSE private 不误抬”用例也仍在。
4. **改动值的使用端都能接受。** `contentClassification` 仍是 `DataClassification` 字符串，生产端在 `production-memory-open.ts:275-278`，使用端在 `production-runtime-tools.ts:903,909` 透传、`pi-runtime-adapter.ts:2312-2313` 接收，类型和校验一致；没有新增标识、配置键、清单项或序列化格式。集成测试期望的 `conversation-turn-N:<runId>` 与 `production-memory-episodes.ts:72-75,86-90` 的实际拼接一致。
