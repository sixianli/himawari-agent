## 结论

这次合并的**冲突解决本身是正确的**：`git show bf5cbcf6` 的 combined diff 显示 I-84 保留分支侧的新版本（`+| I-84 …`，main 侧旧版本被丢弃），I-90 作为 main 侧新增行追加（`+| I-90 …`），两行都完整、各自是独立的一行。相对 main 的差异只有本 PR 的 23 个文件，没有丢掉 main 的任何改动；相对合并第一父提交的差异就是 main 带进来的内容（外加 I-90 一行），没有回退本 PR 的改动。但我在合并后的树里发现了两处值得处理的问题，按严重度排列如下。

---

## 问题

### 1. 中 — `.agents/instructions/model-review.md:140` 仍说“没有 check:gitleaks”，与合并后的 `package.json` 直接矛盾

- 文件:行：`.agents/instructions/model-review.md:140`（对照 `package.json:27`、`package.json:66`、`.agents/instructions/delivery-mode.md:18`）
- 问题：合并把 main 的 `check:gitleaks` 带进来了（`package.json:66` 有脚本，且 `package.json:27` 的 `check:steps` 里有 `npm run check:gitleaks`），main 还同步更新了 `delivery-mode.md`；但 `model-review.md` 这一句仍然说“目前 `package.json` 里没有 `check:gitleaks` 这个脚本，云端线程不用跑它”。同一棵树里两份指令互相矛盾，云端复核线程读到的正是不让它跑这道新门槛的旧说法。
- 证据（我亲自读到的行）：
  - `model-review.md:140`：`目前 \`package.json\` 里没有 \`check:gitleaks\` 这个脚本，云端线程不用跑它；以后若加了，任务说明里的“有就先运行”一句已经覆盖，云端线程提交记录之前先运行它…`
  - `package.json:66`：`"check:gitleaks": "node scripts/check-gitleaks.mjs",`
  - `package.json:27`（`check:steps`）含 `... && npm run check:secrets && npm run check:gitleaks && ...`
  - `delivery-mode.md:18`：`…用锁定版本的 gitleaks …（\`npm run check:gitleaks\`，\`npm run check\` 的一步）…`
- 来源说明：这一行在 main（`1a3a1efe`）和分支两侧内容相同，**不是这次冲突解决改坏的，是 main 上原有的不一致被合并原样带进来**。但它现在就在合并结果里，而且与本轮新引入的 gitleaks 门槛直接相关。
- 建议：把 `.agents/instructions/model-review.md:140` 改成“已包含在 `npm run check` 中（`package.json` 的 `check:gitleaks`），云端线程提交记录前必须运行”，与 `delivery-mode.md` 和 `delegate.mjs` 的说法一致；这属于 main 的内容，也可以另开小 PR 修，但合并前至少应记录为已知问题。

### 2. 中（未核实/推测）— 合并后没有跑 `npm run check:gitleaks`，而本 PR 新增了复核记录

- 文件:行：`package.json:27`、`docs/incidents-and-gates.md:123`（I-90）、本 PR 新增的 `.agents/reviews/pr-312/**`
- 问题：这次合并把 `check:gitleaks` 引入分支的 `npm run check`，但作者列出的合并后检查只有 `typecheck` 和 `check:incident-gates`。I-90 的根因原文就写明“复核记录会原样引用像密钥的字符串，最容易触发”，而本 PR 恰恰新增了 `round-1`/`round-2` 的模型复核记录。按 ADR 0176 合并不等 CI，如果这些记录里有未登记的“像密钥”字符串，合并进 main 后才在 CI 的 security 作业红掉，正是 I-86/I-90 那类事故。
- 证据：
  - `docs/incidents-and-gates.md:123`：`…复核记录会原样引用像密钥的字符串，最容易触发…`
  - `package.json:27`、`package.json:66`：合并后 `npm run check` 确实包含 `check:gitleaks`。
- 状态：**未核实**。当前工具环境拒绝通过 git 读取 `.agents/reviews/pr-312/**`（返回 `REVIEW_GIT_REFUSED records-path`），工作区也是稀疏检出、不包含这些文件，我无法确认它们是否含会触发 gitleaks 的字符串；也无法运行 npm。按 I-86 的设计，`opencode-review.mjs` 写入时会遮盖，风险可能已被消掉，但这是推测。
- 建议：在合并后的提交上实际运行 `npm run check:gitleaks`（或完整 `npm run check`）并留下输出；这是本次合并唯一新增、又没被覆盖到的安全类检查。

### 3. 低 — `check:incident-gates` 不能证明“冲突两边都不丢”，也不校验列数；合并后没跑能查列数的 `check:markdown-tables`

- 文件:行：`scripts/check-incident-gates.mjs:31-34`、`:35-37`、`:46-71`、`:80`
- 问题：作者用 `incidents=85→86` 作为“两边都不丢”的证据，但这个脚本只校验**已存在的行**；如果冲突解决把 I-90 整行丢掉，结果是 `incidents=85 errors=0`，依然通过。它也不校验每行的列数：`const [id, date, symptom, cause, count, gate, state] = cells(lines[end]);` 对多出来的单元格直接忽略，少列则靠后续字段校验偶然发现。真正严格查列数的是 `npm run check:markdown-tables`，而合并后只跑了 `check:incident-gates`。就本次文本而言，两行都是各自从前一份已校验文件中逐字节带过来的，**我没有发现实际格式错误**；问题是这道检查兜不住冲突解决的失误。
- 证据：
  - `scripts/check-incident-gates.mjs:32`：`const [id, date, symptom, cause, count, gate, state] = cells(lines[end]);`
  - `scripts/check-incident-gates.mjs:80`：`INCIDENT_GATES … incidents=${incidents.length} errors=${errors.length}`
  - 实测计数：`^\| I-` 在合并后的文件里是 86 行，与作者说法一致（未运行脚本，无法复现 `errors=0`）。
- 建议：合并后在完整检出上跑 `npm run check:incident-gates && npm run check:markdown-tables`（或整条 `npm run check`）；如想长期兜住这类冲突，给 `check-incident-gates` 加“已知编号集合/行数”之类的断言（例如要求 I-90 必须存在）。

---

## 读代码证实的

- **合并完整性**：`git diff --name-status 1a3a1efe..bf5cbcf6` 只有本 PR 的 23 个文件（含 `production-run-composition.ts`、`production-sandbox-tool-result.ts`、`production-tool-result-recovery.ts`、`thread-execution-state.ts`、`thread-execution-projection.ts`、相关测试、`docs/incidents-and-gates.md`、`docs/lessons.md` 等）。没有出现 main 的文件被改回，说明 main 的改动没丢。
- **没有回退本 PR**：`git diff 49e8564a..bf5cbcf6 -- <本 PR 的 5 个代码文件>` 为空；`git log 49e8564a..1a3a1efe -- <这 5 个文件>` 也为空，说明 main 从来没改过它们，合并只是原样保留分支版本。
- **I-84 / I-90 两行**：`git show bf5cbcf6` 的 combined diff 显示 `I-84` 只取分支侧的新文本、`I-90` 只取 main 侧的新行；两行在文件里是相邻但独立的第 122、123 行，内容分别与各自来源逐字节一致，没有粘连成一行。
- **I-84 文案与代码一致**：`production-run-composition.ts:315-334` 建了不含 `resultUnrecoverable` 的 `toolResultRecoveryParts`，`:343` 用 `inspectToolResultRecovery`，`:764` 把它暴露出去；`production-tool-result-recovery.ts:159-166` 的写记录条件以 `options.resultUnrecoverable &&` 为前提。I-84 新文本描述的正是这套机制。
- **反向用例存在**：`test/integration/sqlite-sandbox-execution-v2.test.ts:6159-6173` 用 `inspectToolResultRecovery` 断言返回 `undefined` 且 `sandbox-tool-result-unrecoverable:%` 记录数为 0；I-84 里提到的 `loss-unverified`、`loss-stream-exited` 是相反方向的反向用例。
- **`SAFE_TOOL_REASON_CODES` 只做成员判断**：`thread-execution-state.ts:28` 导出，`thread-execution-state.ts:155/161` 和 `thread-execution-projection.ts:420` 都是 `.has(...)`，不迭代、不序列化，集合顺序不影响任何字节。
- **`limitBytes` 单位换算确定**：`production-sandbox-tool-result.ts:147-152` 只依赖传入的 ceiling 数值；`SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 是 `1024 * 1024 * 1024`（`packages/execution-contracts/src/sandbox-memory-limit.ts:1`），所以旧文案的 `1073.7 MB` 变成 `1024 MB` 是确定且符合常量的；测试已同步（`production-runtime-tools.unit.test.ts`、`production-sandbox-tool-result.unit.test.ts`）。
- **没有残留的旧调用方**：全仓库 grep `recordUnrecoverable` / `resultUnrecoverable` / `prepareToolResultRecovery`，没有地方再给恢复函数传第二个参数 `{ recordUnrecoverable: false }`。
- **`safe-tool-reason-codes.test.mjs` 已删除**（glob 无此文件），`docs/lessons.md:668` 的“PR #312 … 这个文件已删除”与之一致，I-84 的 gate 文本也去掉了对它的引用。
- **I-90 gate 路径存在**：`scripts/check-gitleaks.mjs`、`ci/rules/gitleaks.toml` 在合并树里存在，`ci/toolchain-lock.json` 也在；I-90 的 `id=I-90`、`date`、`count=3` + `已落门槛` 都满足 `check-incident-gates` 的规则。

## 推测 / 未核实

- **gitleaks 是否会因本 PR 新增的复核记录失败**：见问题 2，记录内容读不到，无法判断；`opencode-review.mjs` 有遮盖逻辑，倾向安全，但未证实。
- **`npm run typecheck` / `check:incident-gates` 的实际执行结果**：环境只允许 git/read/grep，不能运行 node；我按脚本逻辑和 86 行计数判断应当通过，但未亲自执行。
- **main 自带改动是否影响模型请求开头**：本轮没有逐条审计 main 从 #290/#291 等带进来的全部改动（这些在 main 上已存在，不构成本 PR 相对 main 的净变化），未核实。

---

## 侧重检查

- **错误路径 / 不可信输入**：恢复写记录的判断以 `options.resultUnrecoverable` 为前提（`production-tool-result-recovery.ts:159-166`），延续授权路径用的是不带该回调的实例（`production-run-composition.ts:315-334,343`），因此那条路径不可能写“不可恢复”记录；这与 I-84 的说明一致，且测试用“0 条记录”断言直接覆盖。未发现新的错误路径或输入校验缺口。
- **安全**：合并把 gitleaks 门槛带进 `npm run check`；新增复核记录可能触发它，但记录不可读、也没有在合并后运行该检查——见问题 2。
- **资源耗尽**：本次代码变化只是文本单位换算和恢复实例拆分，不改变资源上限、重试或循环行为；`limitBytes` 是纯函数，无放大风险。
- **不可撤销操作**：写“不可恢复”记录是较重的状态变更；确认只有 `prepareToolResultRecovery` 实例带回调，`inspectToolResultRecovery` 不带，因此权限校验路径不会产生这种记录。
- **规则文件 / 文档与代码一致**：发现 `.agents/instructions/model-review.md:140` 与 `package.json` 矛盾（问题 1）；I-84、I-90、`docs/lessons.md:668` 与代码/文件系统核对一致。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
没有发现会。相对它要并入的 main，这次合并只增加本 PR 的改动（`git diff --name-status main..merge` 的 23 个文件全部属于本 PR）；PR 的三处代码变化都不碰系统提示、工具定义或历史：失败文案是随工具结果追加的最后内容（`production-sandbox-tool-result.ts:162-173`），恢复实例拆分和 `SAFE_TOOL_REASON_CODES` 导出都在模型请求之外。按 [prompt-prefix](../../.claude/rules/prompt-prefix.md#rules) 的“工具定义 → 系统提示 → 历史 → 最后一条用户消息”，这些都不在前缀里。每轮会变的值没有被挪进请求头。main 带进来的主动提醒等改动是 main 上已有的，不构成本 PR 相对 main 的新增；我没有逐一审计它们（未核实）。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
没有发现。`limitBytes` 只取决于本次生效的 ceiling 数值，是纯确定函数；`SAFE_TOOL_REASON_CODES` 只用于 `.has()` 判定，不参与序列化，集合顺序无关；恢复实例的行为也不生成模型可见文本。没有时间字段或无序集合进入发给模型的内容。main 带入的改动没有改这三个值。

**3. 有没有对应的自动检查，反向用例真的会失败？**
对 PR 代码有：`loss-unrecoverable` / `loss-unverified` / `loss-stream-exited`，以及 `sqlite-sandbox-execution-v2.test.ts:6159-6173` 对“只判断实例不写记录”的直接断言，作者称把 `resultUnrecoverable` 挪进共用参数会让它变红（已实测，我未亲自运行）。对**这次合并/冲突解决**：没有专门的自动断言证明“两边都不丢”；`check:incident-gates` 删掉 I-90 仍会通过（见问题 3）；能查列数的 `check:markdown-tables` 合并后没跑；新引入的 `check:gitleaks` 也没跑（问题 2）。执行结果本人都未亲自复现（工具限制）。

**4. 每个产生/修改的值，两端校验都能接受吗？**
逐项核对如下，均未发现两端不匹配：
- **I-90 行**：产生于 `docs/incidents-and-gates.md:123`；消费方 `scripts/check-incident-gates.mjs` 用 `/^I-\d{2,}$/`（I-90 通过）、日期格式、`count=3` 必须属于 `已落门槛/等 Andy/仓库外`（是）、`已落门槛` 必须写出存在文件（`scripts/check-gitleaks.mjs`、`ci/rules/gitleaks.toml` 均存在）。通过。
- **`SAFE_TOOL_REASON_CODES`**：产生于 `thread-execution-state.ts:28`；使用方 `thread-execution-state.ts:155/161`、`thread-execution-projection.ts:420` 只调用 `.has()`，接受 `Set`，不依赖顺序。通过。
- **`inspectToolResultRecovery`**：产生于 `production-run-composition.ts:334` 并暴露于 `:764`；内部使用方 `:343`，测试使用方 `sqlite-sandbox-execution-v2.test.ts:6160`，参数形状是 `Pick<RunDispatchCandidate,"runId"|"ownerId"|"agentId">`，匹配。全仓库没有残留给恢复函数传第二个参数 `{recordUnrecoverable:false}` 的调用（grep 证实）。typecheck 未亲自运行。
- **`limitBytes` 的二进制单位**：产生于 `production-sandbox-tool-result.ts:147-152`，使用于同文件 `:162-163`；消费方是模型文案和两个单测，测试期望已改成 `1024 MB` / `2.4 MB` / `32 KB` 等，与 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1024*1024*1024` 一致。通过。
- **I-84 行**：产生于 `docs/incidents-and-gates.md:122`；消费方同样是 `check-incident-gates`，`count=1`、`已落门槛`、gate 中所有反引号路径都应存在（作者称检查通过，我未执行；文本与代码逐条核对一致）。
