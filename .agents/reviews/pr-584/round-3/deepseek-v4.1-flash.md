本轮查过的范围：`52a8ee43..437fc0f0` 的 4 个文件（`.agents/instructions/model-review.md`、`biome.json`、`scripts/model-review/opencode-review.mjs`、`test/tooling/review-increment.test.mjs`），以及为核对两端读到的 `increment.mjs`、`plan-claims.mjs`、`review-speed-report.mjs`，和 `buildPrompt`、`budgetCheck`、`linkedLedgerRecords`、`assertReviewed`、`readUsage`、`unreviewedFiles` 相关代码。测试与 lint 没有实际运行（工具限制只能读文件、跑 git 只读命令），凡涉及运行结果的地方都标了「未核实」。

## 意见

### 1. 低：替补预算的测试只覆盖 `substituteRefusal`，没有覆盖 `main` 里实参的组装，传错「已定义但不对」的变量时不会失败

文件：`test/tooling/review-increment.test.mjs:503-519`、`scripts/model-review/opencode-review.mjs:4241-4247`

问题：这一轮修的正是 `main` 里把 `linkedRecords` 传错（原来引用了未定义的 `parentRecords`）。新增测试直接调 `substituteRefusal`，没有一条用例走 `main` 的调用点。`noUndeclaredVariables` 只能抓住「未定义」，抓不住「用了另一个已定义变量 / 漏传 `linkedRecords` / 组装顺序不对」这类同样会让预算少算、但代码能跑的回归。

证据：
```js
// opencode-review.mjs:4241
const refused = substituteRefusal({
  prompt: substitutePrompt,
  mode: options.mode,
  records: [...readUsage(options.out), ...linkedRecords],
  model: substitute.model,
  approvedUsd: options.approvedUsd,
});
```
```js
// review-increment.test.mjs:507
expect(substituteRefusal({ prompt: "p", mode: "code-review", records: own, model })).toBeNull();
expect(
  substituteRefusal({ prompt: "p", mode: "code-review", records: [...own, ...linked], model }),
).toMatch(/^BUDGET_NEEDS_APPROVAL /);
```
两条断言只证明助手函数本身会计入 `linked`，不证明调用点真的把 `linkedRecords` 传进去。

建议：把 `[...readUsage(options.out), ...linkedRecords]` 的组装抽成可测的小函数并加一条反向用例（例如传入不含 shadow 记录的组装结果，必须得到 `null`），或对 `main` 的替补决定做一次可注入的集成测试。

## 上一轮意见核对

- 意见 1（中高，`parentRecords` 未定义）：已改好。`substituteRefusal` 在 `opencode-review.mjs:1736-1739`，调用点在 `4241-4247` 传入的是 `linkedRecords`；全仓库 grep 不到 `parentRecords`（读代码证实）。
- 意见 3（低，文档把 `plan-claims` 排除范围说成全部）：已改好。文档 `model-review.md:165` 改为「本 PR 新增 ADR 对应的 `plan-claims` 核对记录不算」；`claimsProblems`（`plan-claims.mjs:378-420`）只对 `addedAdrs` 对应的记录收集文件，`assertReviewed`（`opencode-review.mjs:1751-1766`）和 `planIncrement`（`1693-1734`）用同一份 `claimsProblems().files` 过滤，两端一致（读代码证实）。`addedAdrs` 用 `merge-base(origin/main, head)..head --diff-filter=A docs/adr`，已经合进来的 main 自带 ADR 不会算成新增，所以「本 PR 新增」这个说法成立。

## 侧重检查

- 错误路径：替补分支重新 `readUsage(options.out)`，非法账本会经 `parseUsage` 抛错；提示超限返回 `PROMPT_TOO_LARGE` 只是跳过替补（`4248`），预算超线返回 `BUDGET_NEEDS_APPROVAL`，都不会写坏账本。`planIncrement` 的 `skip()` 抛错会落进 `catch` 退到 `diff-failed`（`1705-1712`），不会静默当作「没改动」。
- 不可信输入：`substituteRefusal` 只接收内部构造的 prompt 和已解析的账本记录，没有新增外部输入。增量块本身包含仓库 diff 这类不可信文本及分隔标记，但那是更早提交的逻辑，不在本轮 4 个文件的改动里，本轮未重新核对。
- 安全：本轮改动不新增日志、不写敏感字段；文档改动缩小了进入增量的 `plan-claims` 记录范围，方向上是减少暴露。
- 资源耗尽：提示上限统一用 `PROMPT_MAX_BYTES`（`1691`），`planIncrement` 的预算按 `PROMPT_MAX_BYTES - promptBytes - 1` 计算（`1730`），`withIncrement` 再兜底检查（`1744`），替补分支也检查（`1737`），本轮没有引入新的无界循环。
- 不可撤销的操作：本轮只有 lint 配置、文档和纯函数，没有删除/覆盖类操作。
- 规则文档与代码一致：`biome.json:26-36` 用的 `includes` 与同文件其他 override 一致，`correctness.noUndeclaredVariables` 对 schema 2.3.5 是正确位置；文档 `model-review.md:165` 与 `claimsProblems`/`assertReviewed`/`planIncrement` 一致，未发现新的不一致。

## 必答问题

1. **不涉及**（但完整回答）：本轮改动不碰 `buildPrompt`、`MODE_TEXT`、`reviewConfig`，不会改变模型已见过的请求开头。`buildPrompt`（`opencode-review.mjs:381-416`）的 `fixed` 数组只由模式角色、工具说明、任务、必答问题、侧重、输出格式组成，不含 `head`/`previous`/`increment`；会变的值都在 `material` 里，增量块在 `412` 处排在 `brief.trim()` 之后、整条 prompt 的末尾。发给模型的内容仍是「固定前缀 + 末尾材料」，每轮会变的值都在最后这一条用户消息里。文档改动落在 `model-review.md` 的 how-to-run 段，不在 `reviewQuestions` 读取的 `<a id="checklist">` 段（`300-310`），所以固定必答问题逐字不变。
2. **不涉及**：`substituteRefusal` 只影响是否跳过替补，不参与任何文本序列化；`biome.json` 是静态 lint 配置，不进模型请求；文档改动对同一提交是固定字节。已有增量块的排序也确定：文件 `sort()`、`LC_ALL=C`、固定提交哈希（`increment.mjs:68-79、111-141`），没有时间字段或无序集合。本轮没有新增会让同一段文字在不同请求里变成不同字节的来源。
3. **部分涉及**：新增了 `substituteRefusal` 的用例，反向用例是有意义的——把 `linked` 去掉会让第二条 `.toMatch` 失败，去掉提示上限会让第三条失败（按代码逻辑推断，未运行）。但如意见 1 所述，`main` 调用点没有反向用例；另外加了 `noUndeclaredVariables` 作为静态门槛（`biome.json:32`），能覆盖这次的未定义变量类错误，但覆盖不了传错已定义变量。lint 与测试是否真的全绿，未核实。
4. **涉及**，逐个值核对：`substituteRefusal` 的产生处 `1736-1739`，使用处 `4241-4247` 与测试 `503-519`，参数名和返回值（`null`/字符串）两端都接受。`PROMPT_MAX_BYTES` 在 `1691` 定义，使用处 `1730、1737、1744、4009` 和测试 `513` 都是数值比较/减法，全部接受 100000。`biome.json` 新增的 `includes`/`correctness.noUndeclaredVariables` 是 Biome 2.3.5 接受的键，且与同文件既有 override 写法一致。文档改动没有机器消费者，只有人和模型阅读，`reviewQuestions` 不会读到这一段。没有发现使用端会拒绝的改动值。

## 未核实

- `npm run lint`、`npm run format:check` 与 `test/tooling/review-increment.test.mjs` 的实际运行结果未核实（仅能读代码）。
- Biome 的 `noUndeclaredVariables` 对本仓库大量使用的 `process`/`Buffer` 等 Node 全局是否零报错，未能在本地验证；从作者提交说明「改前只报 `parentRecords` 一处」看应当能识别，但这是推测。
