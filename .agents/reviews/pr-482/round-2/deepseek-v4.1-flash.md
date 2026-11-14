## 复核结论

本轮增量（`b457a0f7f..88ba0f33a`，提交 `833301850`、`88ba0f33a`）与作者描述基本一致，未发现高危或阻断问题。下面按严重度列出发现，均为低severity；另有一条属于总 diff 但不在本轮增量的观察。

## 发现的问题（按严重度）

### 低-1：新增的截断逻辑没有任何自动用例，长值反例缺失
- 文件：`scripts/ci/coverage-model.mjs:242-248`、`test/tooling/coverage.test.mjs:334-349`
- 问题：新代码增加了 `type` 截到 40 字符、`counts` 截到 200 字符，但两个新用例只用了短值，未覆盖截断本身。反向用例只能证明“非法命中数会报错且格式对”，不能证明超长 `type`/`counts` 被限制，也无法防止将来把 200 去掉导致 CI 日志被超大数组撑爆。此外 `counts` 截断后，若非法元素位于数组靠后位置，会从报错里消失，只剩分支号/行号可定位。
- 证据：
  ```js
  // scripts/ci/coverage-model.mjs:242-248
  if (!record.b[id].every(integer)) {
    const type = JSON.stringify(branch.type)?.slice(0, 40);
    const counts = JSON.stringify(record.b[id]).slice(0, 200);
    assert(
      false,
      `invalid branch hit count: ${filename} branch ${id} line ${branch.loc.start.line} type ${type} counts ${counts}`,
    );
  }
  ```
  ```js
  // test/tooling/coverage.test.mjs:334-348
  const negative = record();
  negative.b[0][1] = -2;
  ...
  const implicitElse = record();
  ...
  implicitElse.b[0] = [3, -2];
  ```
- 建议：加一个长 `type`（>40）和长 `counts`（>200）的用例，断言消息长度上限，并断言仍保留 `branch <id> line <n>`；`counts` 被截断时可显式加 `…` 或标注 `truncated`，避免误读。

### 低-2：`branch id` 原样拼进异常文本（推测风险）
- 文件：`scripts/ci/coverage-model.mjs:242,247`
- 问题：`id` 来自 `Object.entries(record.branchMap)` 的 JSON 对象键，JSON 键可以包含换行或控制字符。新消息把 `branch ${id}` 原样拼进 CI 错误日志，而 `type` 和 `counts` 都做了编码/截断，`id` 没有，存在日志注入或伪造日志行的可能。
- 证据：
  ```js
  for (const [id, branch] of Object.entries(record.branchMap)) {
    ...
    `invalid branch hit count: ${filename} branch ${id} line ${branch.loc.start.line} type ${type} counts ${counts}`,
  ```
- 建议：对 `id` 也用 `JSON.stringify(id)?.slice(0, 40)` 或统一转义。当前 coverage 报告由固定工具生成且另有摘要/来源校验，所以定为低。

### 非本轮增量观察（低）：总 diff 删除了三处解释性/授权注释
- 文件：`scripts/ci/coverage-model.mjs:170`、`:232-241`、`:486-491` 附近
- 问题：`8c8c895..88ba0f3` 的总 diff 删除了 `Infinity -> null`、隐式 `else` 占位、以及 `Owner-approved on 2026-09-15` 阈值迁移的注释。`git log -S` 显示是 `b457a0f7f`（上一轮基点）删的，不在本轮两个提交里；行为未变，但可维护性和审计线索下降。批准事实仍记录在 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:225`。
- 建议：至少保留授权注释或改成指向 Spec 的链接。

## 读代码证实的

- 覆盖率改动确实只在命中数不合法时拼报错；`type` 做了 JSON 编码并截断 40，`counts` 截断 200，消息加了 `branch ${id}`（`scripts/ci/coverage-model.mjs:242-248`）。
- `branch.loc.start.line` 去掉了 `?.`，但前面 `location(branch.loc, lines, filename)` 已校验 `branch.loc` 和 `start.line`（`:224`），不会因缺字段变成 TypeError。
- 两个新用例的期望串与实现完全一致（`:337`、`:348`），且旧 `b457` 的消息是 `... line ${branch.loc?.start?.line} ${branch.type} counts ...`（无 `branch 0`、`type` 无引号），所以这两个用例在旧代码上会失败。
- `AttachmentKind` 现在只在 `draft-attachments.ts` 定义，`attachment-text.ts` 从它 `import type`（`draft-attachments.ts:1`、`attachment-text.ts:3`）。
- 全仓库 TypeScript 侧使用 `AttachmentKind` 的地方只有：`draft-attachments.ts:7,17,49` 和 `attachment-text.ts:18,37,57`；`index.ts:6-9` 不导出 `attachment-text`，没有旧导出被删后无人接的路径。Swift 的两个 `AttachmentKind` 是另一门语言里同名独立枚举，不受影响。
- `draft-attachments.ts` 只使用 `TextEncoder` 等 Node 侧能力；原先带 DOM 的是 `attachment-image.ts`（`FileReader`、`createImageBitmap`、`document.createElement("canvas")`，`:31,45,61`），经 `attachment-text.ts:2` 被引入。
- 根 `tsconfig.json:6-13` 通过 `test/tooling/apple-attachment-fixture.test.ts:3` 只拉入 `draft-attachments.ts`，不再经过 `attachment-text.ts/attachment-image.ts`。
- `npm run typecheck` 的第一条确实是根 `tsconfig.json`（`package.json:91`），所以该修复由类型检查本身兜底。

## 推测/未核实

- 未能实际运行 `tsc`：当前 checkout 没有 `node_modules`，无法验证“10 个错误全部消失”。按代码推断，原错误来自 `attachment-image.ts` 的 DOM 全局，移动类型后应消失。
- 根 `tsconfig` 仍会通过 `test/integration/owner-settings-sync.test.ts:9` 拉入 `browser-storage.ts`，后者在 `browser-storage.ts:57` 使用 `Storage`。这依赖 `@types/node` 22 是否声明 `Storage`；我无法在本环境核实。若该类型不在 Node 类型里，根 `tsc` 仍会失败，建议作者在装有依赖的环境跑一次 `npm run typecheck` 确认。
- `branch id` 的日志注入风险依赖“coverage 报告可被不可信方影响”的前提；正常流水线里报告由固定工具生成并有摘要校验，故仅为推测性低风险。

## 侧重检查

- 错误路径：非法分支命中数的路径已按“只在失败时拼消息”改写；隐式 `else` 的第二位置被跳过校验，但其命中数仍会走 `every(integer)`，新用例覆盖了 `[3,-2]`。分支定位靠 `id + line + type`，截断后仍能定位到分支，但具体非法下标可能被截掉（见低-1）。
- 不可信输入：`type`/`counts` 有编码与长度上限；`id` 未转义（低-2）；`filename` 的拼接是既有行为，本次未新增。
- 资源耗尽：消息只在失败时构造，优于旧代码对每个分支都 `JSON.stringify`；但 `JSON.stringify(record.b[id])` 仍会先生成完整字符串再截断，超大数组仍有分配开销，属于既有输入规模问题，未新增放大。
- 不可撤销操作：本次改动无文件写入、无数据库、无网络、无删除操作。
- 文档/规则一致性：未改 `.claude/rules/prompt-prefix.md`；`draft-attachments` 的序列化格式、`KINDS` 清单和 `TAG` 正则均未变，Swift 夹具仍可由 `joinDraft/splitDraft` 对拍。
- 类型挪动：`attachment-text.ts` 只做 `import type`，`draft-attachments.ts` 不再反向依赖，无运行时循环；所有 TS 消费点都能取到类型。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次没有改动任何发给模型的文本生成路径：`draft-attachments.ts` 只把类型声明从 `attachment-text.ts` 挪过来（`draft-attachments.ts:1`、`attachment-text.ts:3`），`joinDraft/splitDraft` 的函数体和 `KINDS` 清单逐字未变；覆盖率报错只存在于 CI 工具。因此仍然是“只在末尾追加”，也没有把每轮变化的值塞进系统提示或工具定义。
2. **不会让同一段文字在不同请求里变成不同字节。** 改动不涉及遮盖、时间字段或集合顺序；`joinDraft` 的拼接顺序和附件标签格式未变，`KINDS` 顺序未变。覆盖率消息里的 `id` 来自 JSON 键的插入顺序，只影响 CI 日志，不进入模型请求。
3. **覆盖率改动有自动检查，反向用例会失败；类型改动的检查是 `tsc` 本身，但未实跑。** 新用例期望 `branch 0 ... type "cond-expr"/"if"`，而 `b457` 的旧消息没有 `branch 0` 且 `type` 无引号，基准则只有 `invalid branch hit count: <file>`，所以旧代码必然不匹配。不足是截断行为没有用例（低-1）。类型挪动的反向用例是根 `npm run typecheck`：若把类型挪回去，`apple-attachment-fixture.test.ts` 会经 `draft-attachments -> attachment-text -> attachment-image` 把 `FileReader/createImageBitmap/document` 带进无 DOM 的根配置而报错；但本环境无 `node_modules`，实际是否全绿标为未核实。
4. **逐个核对了产生和使用两端。** `AttachmentKind`：产生处为 `draft-attachments.ts:1`，使用处为 `draft-attachments.ts:7,17,49` 与 `attachment-text.ts:18,37,57`，全仓库无其他 TS 引用；`KINDS` 清单与联合类型取值一致，`TAG` 的 `[a-z]+` 仍能接受全部取值；控制中心包入口 `index.ts` 不导出 `attachment-text`，所以移除该模块的 `AttachmentKind` 导出没有断掉包级 API。覆盖率消息：产生处为 `coverage-model.mjs:247`，消费处只有 `coverage.test.mjs:337,348` 两处精确字符串断言（grep `invalid branch hit count` 无其他消费方），两端已同步；唯一需要额外处理的是 `branch id` 未转义（低-2）。
