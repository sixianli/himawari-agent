我核对了本次对比差异、提交 `627b6cbe7`、`DeviceAPIError.server` 的定义、所有 `.server` 的匹配点、相关测试和 ADR。先给结论：这条改动本身仍然是编译错误；此外，给出的对比基准把大量无关回退混进了 diff，和作者“只改一行”的说法不一致。

### 1. 致命：新模式仍是 4 个关联值，而 `DeviceAPIError.server` 只有 3 个，Swift 仍无法编译

文件:行：`clients/apple/Sources/HimawariCore/PairingDecisions.swift:55`、`clients/apple/Sources/HimawariCore/DeviceAPIClient.swift:20-26`

问题：改动把 `.server(code, reason?, _)` 改成 `.server(code, reason?, _, _)`，子模式从 3 个变成 4 个；但 enum case 从基准到本次提交都只有 3 个关联值。Swift 要求子模式个数与关联值个数一致，因此这不是修复，而是新引入的编译错误。

证据：
```swift
// PairingDecisions.swift:55（本次改动后）
guard status == .unrecognized, case let .server(code, reason?, _, _)? = error as? DeviceAPIError else { return false }

// DeviceAPIClient.swift:21（基准和本次提交相同，diff 未改这个文件）
case server(status: Int, code: String?, pairingCodeTtlSeconds: Int? = nil)

// DeviceAPIClient.swift:24-26
public var code: String? {
    if case let .server(_, code, _) = self { return code }
```
基准 `9dd41fe` 中的原行是 `.server(code, reason?, _)`，恰好 3 个，能匹配这个 case。作者说“该 case 有四个关联值”与代码不符；`reason` 这个关联值也不存在。即使把模式改回 3 个，第一位绑定的是 `status`，第二位绑定的是 `code`，变量名 `code`/`reason` 和实际语义也是反的。

建议：改回 3 个子模式并用准确的变量名，例如：
```swift
guard status == .unrecognized,
      case let .server(httpStatus, code?, _)? = error as? DeviceAPIError
else { return false }
return httpStatus == 403 && code != "DEVICE_PENDING"
```
不要为了“补一个 `_`”去迁就不存在的第四个关联值。

### 2. 高：给出的 diff 基准不是 merge-base，包含大量与“只改一行”不符的回退

文件：`scripts/model-review/opencode-review.mjs`、`scripts/check-incident-gates.mjs`、`.agents/reviews/pr-506/*`、`.agents/instructions/model-review.md`、`.claude/rules/owner-standing-rules.md`、`docs/adr/0269-...md` 等

问题：`git show --stat 627b6cbe7` 只有 `PairingDecisions.swift` 一个文件；但按题目给出的 `9dd41fe..627b6cbe7` 做 diff 却有 18 个文件、`7 insertions(+), 234 deletions(-)`。原因是 `9dd41fe` 的父提交包含 `8a9f84456` 和 PR #506 的 `3f7e888f5`，而 `627b6cbe7` 的父提交是 `8a9f84456`。也就是说，`9dd41fe` 已经合入 PR #506，`627b6cbe7` 没有；两点 diff 把 PR #506 的内容当成了“删除”。

证据：
```text
git show --stat 627b6cbe7
 clients/apple/Sources/HimawariCore/PairingDecisions.swift | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

git log --pretty="%h parents=%p %s" -3 9dd41fe89
9dd41fe89 parents=8a9f84456 3f7e888f5 Merge pull request #506 ...
3f7e888f5 parents=6b849b0aa 8a9f84456 Merge remote-tracking branch 'origin/main' ...

git log --pretty="%h parents=%p %s" -3 627b6cbe7
627b6cbe7 parents=8a9f84456 fix(apple): ...
```
改从 `8a9f84456..627b6cbe7` 看，确实只有一行：
```text
git diff 8a9f84456..627b6cbe7 --stat
 clients/apple/Sources/HimawariCore/PairingDecisions.swift | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```
建议：把复核基准改成 merge-base `8a9f84456`，或先把分支 rebase 到 `9dd41fe` 再复核。不能把当前两点 diff 当成这个 PR 的真实改动；如果按这个 diff 打补丁，会顺带回退 PR #506 的功能、文档和测试。

### 3. 高：该 diff 若被落地，会移除跨 topic 的预算累计和 `--spend-day` 日花费报告，能绕过 1 美元/5 美元限额

文件:行：`scripts/model-review/opencode-review.mjs:3711-3716`、`scripts/model-review/opencode-review.mjs:3754-3762`（删除内容见 diff 的 `@@ -1220,60 +1220,6 @@` 和 `@@ -3829,15 +3752,11 @@`）

问题：diff 删除了 `DAILY_SPEND_LINE_USD`、`claimsFileRecords`、`dailySpend`、`spendDayLines` 和 `--spend-day` 参数，并把预算检查从“本账本 + 同一方案文件在其它 topic 账本里的花费”改回只看本账本。`claimsFile` 仍然写进记录，但不再参与预算累计；换个 topic 名就能重新从零计算同一方案文件的 1 美元额度。同时全项目每天 5 美元的汇总入口被删掉。

证据：
```diff
-  const sameFileRecords =
-    options.selfCheckOnly || options.mode !== "plan-claims"
-      ? []
-      : claimsFileRecords(options.repo, options.claimsFile, reviewKey(options));
...
-        records: [...records, ...sameFileRecords],
+        records,
```
```javascript
// 当前代码仍然记录 claimsFile，但预算检查不再使用它
const claimsRecord = claimsMode
  ? { claimsFile: options.claimsFile, claimsSha256: ... }
  : {};
...
const overBudget = options.selfCheckOnly
  ? null
  : budgetCheck({ mode: options.mode, records, models: options.models, approvedUsd: options.approvedUsd });
```
这属于费用/资源控制回退。作者没有提到这部分；只有在本分支是旧基线、正常 merge 不会真正删除时，它才可能只是复核材料的问题。不能据此认为“行为不变”。

建议：不要把这些回退合入；如果确实要改预算规则，应按仓库规则单独出方案并获得 Andy 同意，同时补上等价的控制和测试。

### 4. 中高：diff 移除了 incident-gates 的读文件错误处理和未知参数拒绝，错误路径会崩溃或静默忽略输入

文件:行：`scripts/check-incident-gates.mjs:46`、`scripts/check-incident-gates.mjs:95-96`

问题：基准版本用 `try/catch` 捕获 `readFileSync` 失败并返回 `INCIDENT_LIST_UNREADABLE`，当前版本直接读取；当清单路径是目录或不可读时会抛出未捕获异常。命令行也不再拒绝未知参数，`--Open` 这类拼写错误会被静默忽略，只打印检查结果行。对应的两个测试在 diff 中被删除。

证据：
```javascript
// 当前版本：没有 try/catch
const { incidents, errors } = readIncidents(readFileSync(file, "utf8"));
...
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { incidents, errors } = checkIncidentGates();
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (process.argv.includes("--open") && errors.length > 0) {
```
diff 同时删除了 `INCIDENT_ARGUMENT_UNKNOWN` 和 `INCIDENT_LIST_UNREADABLE` 的测试。建议恢复错误处理和未知参数校验，保留反向用例。

### 5. 中：ADR 0269 把“云端线程不载入技能”的依据改成“前提 1”，但前提 1 没有这句话

文件:行：`docs/adr/0269-load-instructions-on-demand-at-thread-start.md:30`、`:71`

问题：diff 删除了原来的前提 6（其中引用了 Claude Code 文档“Cloud threads load each repository's `CLAUDE.md` instructions but not its skills...”），同时把业界做法里的“（前提 6）”改成“（前提 1）”。但当前前提 1 只说不载入带 `paths` 前缀的规则，没有说技能不载入，引用与内容不匹配。

证据：
```markdown
// ADR 0269:30（当前）
1. 云端线程开局自动载入仓库根目录的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `.claude/rules/`，不载入带 `paths` 前缀的规则。...

// ADR 0269:71（当前）
云端线程不载入带 `paths` 的规则，也不载入仓库里的技能（前提 1），所以按需的办法只能是“规则里写明什么时候读哪份文件”。
```
建议：恢复被删的前提 6，或把引用改成真正包含“技能不载入”这一事实的前提；不要指向不支持该句话的前提。

### 6. 中：这次修复没有对应的自动检查，现有行为测试在当前代码上根本无法运行

文件:行：`clients/apple/Tests/HimawariCoreTests/ServerValueTests.swift:116-128`

问题：已有的 `waitingForAnUnknownDeviceStatusStopsOnlyWhenTheServerClearlyRefuses` 覆盖了正向和反向行为：403 + 非 `DEVICE_PENDING` 要放弃，403 + `DEVICE_PENDING`、5xx、429、408、401、404、403 + nil code 都不能放弃。反向用例本身是够的；但本次改动没有新增或修改测试，而且编译错误会让整个测试目标无法运行，所以这些用例实际上一条也跑不到。仓库里也没有看到能单独检查“模式子项个数”的测试。

证据：
```swift
let refused = DeviceAPIError.server(status: 403, code: "DEVICE_SUSPENDED")
#expect(ConfirmationWait.givesUp(waitingAs: .unrecognized, after: refused))
#expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 403, code: "DEVICE_PENDING")))
...
#expect(!ConfirmationWait.givesUp(waitingAs: .unrecognized, after: DeviceAPIError.server(status: 403, code: nil)))
```
建议：提交前至少运行 `swift build` / `swift test`。如果只是修编译，不需要新增行为测试，但必须保证现有测试能编译并通过；如果还改了行为，再补对应反向用例。

**读代码证实的**
- `DeviceAPIError.server` 在基准和当前提交都是 `(status: Int, code: String?, pairingCodeTtlSeconds: Int? = nil)`，共 3 个关联值。
- 基准的 `ConfirmationWait` 模式是 3 个子模式；当前提交是 4 个，必然无法匹配。
- 其它所有 `.server` 匹配点都用 3 个子模式：`PairingDecisions.swift:24`、`PairingRecord.swift:36`、`MenuBarModel.swift:131`、`MessageSensing.swift:116/121/127`、`DeviceAPIClient.swift:25`。
- 提交 `627b6cbe7` 本身只改 `PairingDecisions.swift` 一行；题目给出的两点 diff 混入了 PR #506 的回退。
- 当前 `opencode-review.mjs` 仍写入 `claimsFile`，但预算检查不再累计同文件的其它 topic 花费。
- ADR 0269 当前前提 1 不包含“技能不载入”，第 71 行的引用不支持该句。

**推测**
- 如果这个分支用真正的 merge commit 合入，PR #506 的内容通常不会被删除；如果按当前两点 diff 打补丁、rebase 或 cherry-pick，就会真的回退。具体采用哪种合并方式，未核实。
- CI 是否会运行 `swift test`，仓库的稀疏检出里没有 `.github/workflows`，未核实。
- 我没有运行 Swift 编译器（工具限制）；上面的编译结论来自 enum 定义和模式子项个数，按 Swift 模式匹配规则是确定性的。

**侧重检查**
- 错误路径：本次 Swift 改动直接把整个 Apple 客户端变成不可编译，调用方 `AppModel.swift:297` 的等待逻辑完全无法运行。修复后，403 + nil code 仍返回 `false`（测试 `ServerValueTests.swift:127` 明确要求），这是有意的保守行为。
- 不合规范或不可信的输入：`status` 和 `code` 来自服务器错误响应（`DeviceAPIClient.swift:223`）；`givesUp` 只在 403 且 code 非空时放弃等待，不会把任意服务器 code 当成成功或永久状态。这个错误路径本身没有新的注入或越权问题，但当前模式写错了，根本走不到。
- 安全与资源耗尽：本次 diff 的主要资源风险不在 Swift 文件，而在删除了跨 topic 预算累计和每日花费报告，见第 3 条。这会削弱费用控制，属于资源耗尽/费用失控相关的回退。
- 不可撤销的操作：diff 删除了 `.agents/reviews/pr-506/` 下的复核记录、判决和用量账本；如果按 diff 落地，会丢失审计痕迹。Git 历史里还能找回，但在合并后的树里是删除。
- 规则、说明文档和代码一致性：`model-review.md` 和 `owner-standing-rules.md` 的回退与当前代码删掉 `--spend-day` 是一致的，但这是相对基准的功能回退；ADR 0269 的前提引用不一致，见第 5 条；作者关于“case 有四个关联值”的说法与代码不一致。

**必答问题**
1. 不会。实际提交 `627b6cbe7` 只改 Apple 客户端的 `PairingDecisions.swift`，不参与任何发给模型的内容组装；给出的 diff 中其它脚本/文档改动也没有进入 `buildPrompt`（`scripts` 下搜不到 `model-review.md`，prompt 组装在 `opencode-review.mjs:3744-3748` 未被改动）。因此就这个改动而言，发给模型的内容仍只在末尾追加，没有把每轮变化的值放进系统提示、工具定义或历史；不过这是“改动不涉及”，不是对整个仓库现状的重新认证。
2. 不会引入新的字节不确定性。Swift 改动不涉及序列化、遮盖、时间字段或集合顺序；被删除的 `dailySpend` 虽然用时间，但那是本地账本统计，不是发给模型的请求内容。
3. 有行为测试但没有针对这次改动的检查：`ServerValueTests.swift:116-128` 的正向和反向用例能抓住行为改变，但当前代码编译不过，测试无法运行；diff 没有新增测试，反而删除了 incident-gates 和 spend-day 的测试。反向用例在“行为被改错”时确实会失败；但“关联值个数写错”只能由编译器发现。
4. 不接受。按 I-73 逐个核对：产生 `server` 的三处 `DeviceAPIClient.swift:118/144/223` 都是 3 个值；使用 `server` 的 `PairingDecisions.swift:24`、`PairingRecord.swift:36`、`MenuBarModel.swift:131`、`MessageSensing.swift:116/121/127`、`DeviceAPIClient.swift:25` 都是 3 个子模式；只有被改的 `PairingDecisions.swift:55` 用 4 个子模式。没有第四个关联值，`code`/`reason` 实际绑定的是 `status`/`code`，不是作者说的 `code`/`reason`。
