我会先查看两次 diff 和本轮的增量，然后对照规则文件核查。
## 侧重检查

- **错误路径**：`portErrorSite` 对 `null`、非对象、缺 `code`/`message`、非字符串、非 `PORT_` 前缀都返回 `undefined`；消息截到 200 字符（`packages/platform-node/src/service-runtime.ts:61-73`）。`siteField` 只在有值时展开字段（`apps/agent-service/src/service-main.ts:181-184`）。非 `PORT_` 错误不会写消息，原有“标题失败不暴露 message”的用例仍覆盖这一点（`apps/agent-service/test/service-orchestration.unit.test.ts:1103-1111`）。
- **不可信输入**：预算分级先经 `classification()` 校验（`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:914`），数据库 `CHECK` 只允许四个值（`migrations/0049_thread_title_budget.sql:16-17`）；提升分类只更新一行，事务内抛错会回滚。
- **安全**：`site` 写的是 `PORT_*` 错误的原始 message；`writeServiceDiagnostic` 在 JSON 序列化后调用 `redactMachineSecrets`（`service-runtime.ts:85-86`）。当前预算路径的 message 多为静态文字或标识符，未发现直接输出用户正文；但这是“按前缀信任 message”的做法，见下面推测项。
- **资源耗尽 / 不可撤销**：消息最多 200 字符；提升分类只做一次单行 `UPDATE`，没有循环。分类只升不降（`sqlite-model-budget-operations.ts:1470-1486`），即使高分级调用后来被释放或失败，账户仍保持高分级；这是设计选择，不是删除或不可恢复业务操作，事务可回滚。
- **规则/文档一致性**：`docs/incidents-and-gates.md:128` 的 I-94 描述与代码一致：`run`/`thread-title` 提升，`occurrence`/`memory-projection` 仍走严格相等分支；四个失败事件都加了 `siteField`。文档也自己说明 integration 测试不在 `npm run check` 中。
- **增量**：`git diff ec16a06a..b2f25352` 只有 `.agents/reviews/pr-417/usage.jsonl` 和测试文件一行代码变化；没有改断言，也没有测试枚举 `repository` 的键。

## 读代码证实的发现

### 中 — “后台任务和记忆重算账户仍不许改”没有反向测试锁住

- 文件:行：`packages/persistence-sqlite/src/sqlite-model-budget-operations.ts:494-498`
- 问题：代码确实只对 `thread-title`/`run` 提升分类，`occurrence`/`memory-projection` 仍调用 `assertAccountClassification`；但新增测试只有两个正向用例，没有测试锁住“后台任务或记忆重算账户传入不同分级必须被拒”。原来的反例删除的是 `run` 账户的高分级拒绝（旧测试 1175 行附近），而不是 `occurrence` 的反例；`occurrence` 分支目前没有对应的反向测试。
- 证据：
  ```ts
  if (input.parent.kind === "thread-title" || input.parent.kind === "run") {
    account = this.raiseAccountClassification(account, input.dataClassification);
  } else {
    this.assertAccountClassification(account, input.dataClassification);
  }
  ```
  ```ts
  if (account.dataClassification !== dataClassification) {
    this.fail("PORT_CONFLICT", "Budget account classification is immutable");
  }
  ```
  新增测试只有 `lets a Run account take a higher-classification call...` 和 `lets auxiliary calls of one Run use different data classifications`（`test/integration/sqlite-model-budget-operations.test.ts:2123-2185`）。`memory-projection` 有一个不同分级的用例，但它命中的是更早的 `Memory projection classification mismatch` 检查（`test/integration/durable-memory-projection.test.ts:666-667`），不是账户不可变分支。
- 建议：补 `occurrence` 账户的“先按分级 A 建立、再按分级 B 预留必须 `PORT_CONFLICT`”用例；再补一条 `run` 账户“升到 sensitive 后 private 仍可、但低于本轮输入仍被拒”的组合用例。这样才真正锁住文档里的“后台任务和记忆重算账户仍不许改”。

### 低 — 四个事件的 `site` 只用源码文本扫描验证，未验证运行时装配

- 文件:行：`apps/agent-service/test/service-orchestration.unit.test.ts:1128-1141`
- 问题：这个测试读取 `service-main.ts` 源文件，在 `event: "..."` 后 200 个字符内找 `...siteField(error)`。它能发现“文本被删掉”，但不能证明 `memory-capture`、`memory-episode`、`memory-consolidation` 三个回调在运行时真的带上了 `site`；如果 `siteField` 被放进不可达分支、或未来格式化把字段移出 200 字符窗口，测试会误报/漏报。文档也承认“其余三条共用同一个 `siteField`，没有单独的装配测试”（`docs/incidents-and-gates.md:128`）。
- 证据：
  ```ts
  const source = readFileSync(new URL("../src/service-main.ts", import.meta.url), "utf8");
  ...
  expect(source.slice(start, start + 200)).toContain("...siteField(error)");
  ```
- 建议：像标题那条一样，在 `service-orchestration` 里用 `.mock.calls[0]?.[0]` 拿到各回调并触发一个 `PORT_CONFLICT`，断言 stderr 中出现对应事件和 `site`；至少把三个回调的装配抽成可单测的 helper。

## 推测 / 未核实

- **推测（低）**：`portErrorSite` 只按 `PORT_` 前缀信任 `error.message`，并把前 200 字符写进日志。当前预算相关的 `PORT_CONFLICT` 消息是静态的，但代码库里存在带动态标识符的 `PORT_` 消息（例如 `sqlite-thread-operations.ts` 的 `Thread ${...} not found`）。如果未来有 `PORT_PROVIDER_FAILURE` 之类把供应商/用户文本放进 message，`site` 会把它带进日志；`redactMachineSecrets` 只能按已知模式遮盖。建议改成只写受控的检查名/原因码，或对 `site` 使用白名单。
- **未核实**：没有运行测试（工具限制），所以作者所说“改前失败、改后通过”“该文件约 68 例失败”“在干净的 main 副本上验证过”都只能按代码推断，未实际执行。仓库是 sparse checkout（69%），`.github` 工作流未检出；只读了 `ci/policy.json`，其中 `coverage` 任务包含 `integration` 项目且未排除该测试文件（`ci/policy.json:108,158-172`），实际 CI 是否执行未核实。

## 作者说法核对

- “上一轮复核到 `ec16a06a`，之后只有两处”：`git diff ec16a06a..b2f25352` 的代码变化只有 `service-orchestration.unit.test.ts` 一行；此外还有 `.agents/reviews/pr-417/usage.jsonl` 变化。代码层面“一行”属实；“两处”若把复核账本算进去则描述不精确。`ec16a06a` 本身是合入 main 的 merge commit，不在这段增量里。
- “main 上 PR 413 在 `service-main.ts` 加了 `repository.externalMemoryProposals()` 调用”：属实，当前代码在 `apps/agent-service/src/service-main.ts:2195` 调用；增量没有改 `service-main.ts`，所以该调用在基线提交里已存在。
- “假仓库的写法是否和同一列表里其它项一致”：一致。新增项在同一循环里，和 `memoryIndex`、`memoryEpisodes` 一样执行 `repository[key] = vi.fn(() => ({}))`（`apps/agent-service/test/service-orchestration.unit.test.ts:280-295`）。
- “这样补是否放宽了任何断言”：没有。增量只增加一个 mock 方法，没有改任何 `expect`；该文件也没有枚举或比较 `repository` 键集合的断言。
- 需要补充的维护性提醒：假仓库的 `externalMemoryProposals` 返回 `{}`，当前测试不调用 MCP proposal 方法，所以够用；若以后有测试走到 `listPending`/`submit`，会得到 `undefined is not a function`，而不是有意义的假实现。与同列表其它项一致，但不是完整的假端口。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   **不会。** 改动只涉及 `model_budget_accounts.data_classification`、stderr 诊断日志、测试和文档；没有改 `packages/runtime-pi`、prompt 组装、系统提示、工具定义或历史序列化。`site` 只进日志，`data_classification` 只进预算表；grep 没有发现预算账户分类被 prompt 组装读取。发给模型的内容仍按原路径只在末尾追加，每轮变化的值仍由原逻辑放在最后一条消息中（`prompt-prefix.md:27-29,35,50-52`）。唯一的行为变化是某些预算调用从失败变为成功，从而可能让对话继续产生新的尾部内容，但不会改写已发出的请求开头。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   **不会。** `site` 是日志字段，带时间戳是 `writeServiceDiagnostic` 原有行为，不进入模型请求；`data_classification` 是数据库值，不序列化进 prompt。分类提升取决于调用顺序，但它不参与消息文本的序列化，也没有引入无序集合或前后文相关的遮盖。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   **部分有。** 预算行为有两条正向 `[I-94]` integration 测试；按代码推断，改前会在 `assertAccountClassification` 处失败，但未实际运行。`run` 账户“低于本轮输入分级仍被拒”的反向用例仍在（`test/integration/sqlite-model-budget-operations.test.ts:1170-1177`）。缺少 `occurrence` 账户不可变的反向用例，见上面“中”级发现。日志方面，`portErrorSite` 有 unit 测试覆盖 `PORT_`/非 `PORT_`/截断；标题路径有运行时用例；其余三个事件只有源码文本扫描，没有运行时装配测试。测试文件不在 `npm run check` 中（文档已说明），但 `ci/policy.json` 的 `coverage` 任务包含 `integration` 项目且未排除它。

4. **每个产生/修改的值，两端都能接受吗？**
   - `site`：产生端 `portErrorSite`/`siteField` 返回 `string | undefined`；使用端 `writeServiceDiagnostic` 接受 `string`，并做 JSON 序列化和 `redactMachineSecrets`；没有额外 schema 拒绝该字段。当前可接受，未来需限制 message 内容。
   - `data_classification`：产生端只使用 `ModelClassification`，输入经 `classification()` 校验；数据库 `CHECK` 允许 `public/private/sensitive/restricted`；读取端 `readAccount` 再次用 `classification()` 校验，`toAccount` 类型接受。没有发现消费方要求它保持旧值或等于 run 的分类。
   - `externalMemoryProposals`：假仓库键名与真实方法名 `product-state-repository.ts:570` 一致；使用端 `service-main.ts:2195` 把它传给需要 `ExternalMemoryProposalStorePort` 的 `ProductionMcpMemoryWriter`。当前测试只在构造时使用，未调用其方法，因此 `{}` 不会触发校验；这不是完整假端口，但和同列表其它 mock 一致。
   - 没有新增配置键或序列化格式。

**总体结论**：增量本身（假仓库补一行）写法正确、没有放宽断言；全量改动的预算提升逻辑与文档一致，未发现会改变 prompt 前缀或请求字节确定性的路径。主要问题是测试覆盖不足和 `site` 日志对 `PORT_` message 的信任边界。
