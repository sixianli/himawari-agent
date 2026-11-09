# PR 312 复核结论

## 读代码证实的（与作者说法逐条核对）

作者材料中的全部「已核对事实」我都读到了对应代码，**没有发现与代码不符的说法**：

- `packages/execution-contracts/src/sandbox-memory-limit.ts:1` 确为 `1024 * 1024 * 1024`；`apps/agent-service/src/service-main.ts:166` 确为 `48 * 1024`，且在 `service-main.ts:1343` 作为 `maxOutputBytes` 使用。
- 改动前 `limitBytes` 按 1_000_000/1_000 换算、内存段另写一次 `/ 1_000_000`（diff 可见）；`apps/control-center/src/delivered-files.ts:52-55` 确按 1024 换算。
- 改动前两份 `SAFE_TOOL_REASON_CODES` 完全相同，投影侧本就 import 了 `thread-execution-state.js`；删除的 `test/tooling/safe-tool-reason-codes.test.mjs` 用 `readFileSync` 按文本切分比对（diff 可见）。
- `production-tool-result-recovery.ts`：恢复（`recoverMissingResult`，现 150–156 行）确实先于写记录判断（现 157–168 行）执行；写记录的 `if` 仍要求 `options.resultUnrecoverable` 存在（159 行）、`facts.result` 的 kind 不是 `result`/`error`（165 行）。全仓库原 `recordUnrecoverable` 传参只剩 `production-run-composition.ts` 的 `authorizeAuthorityChange` 一处，dispatcher（`production-run-dispatcher.ts:336`）不传；现在没有任何地方再传第二参。
- 改动后 `inspectToolResultRecovery`（composition.ts:334）是唯一不含 `resultUnrecoverable` 的实例，只被 `authorizeAuthorityChange`（:343）使用；`options.resultUnrecoverable` 在函数里只有写记录那一处用（159、166 行）。**去掉开关后没有任何路径的行为改变**：authorize 路径旧代码靠 `purpose.recordUnrecoverable === false` 压住写记录，新代码靠实例上根本没有这个回调，效果等价；dispatcher 路径旧代码 `purpose` 为 undefined、条件恒真，与新代码一致。
- 作者的推断「单个沙箱调用的轮次不可能同时满足『已经恢复出结果』和『还有一个结果未知且永远恢复不了的调用』」**成立**：恢复成功后该 admission 的 `facts.result.kind` 变为 `result`/`error`，165 行直接不满足；恢复不成功则结果未知，不可能同时作为 `knownToolResult` 续场。且即便推断不成立（多调用批次），authorize 路径在结构上也已拿不到写入口，推断只影响「要不要补用例」的论证，不影响行为。
- `loss-unrecoverable` 断言恰好一条 `sandbox-tool-result-unrecoverable:%` 记录（sqlite-sandbox-execution-v2.test.ts:6190-6197）；`late`/`batch` 场景存在（:5344、:5354），`batch` 加的确实是 `local_probe` 纯本地探针（:5439-5444）。这些场景都走真实 `createProductionRunComposition`（:5766），即新的双实例接线。

## 发现的问题（按严重度从高到低）

**1.（中低）docs/lessons.md:668 — 引用已删除的门槛文件，文档与代码不一致**
证据：`lessons.md:668` 写「第 0 层清单里必须手工加上按路径扫源码的门槛（`prompt-catalog.unit.test.ts`、`test/tooling/safe-tool-reason-codes.test.mjs`、`check:glossary`）」，而该文件本次已删除，全仓库只剩这一处引用。I-84 那行同类问题有 `check:incident-gates` 拦（scripts/check-incident-gates.mjs:68-70 只查 `docs/incidents-and-gates.md`），lessons.md 没有任何机器检查兜着。
建议：更新该行，把这条门槛替换为「白名单已是单份导出、无漂移可能」的说法。

**2.（低）docs/backlog/BL-20261017-005 — 本 PR 已实现该待办但未关闭**
证据：该文件 `record_state: "open"`，第 30 行写的处理方向「只留一份清单，两处都从同一个导出读取」正是本 PR 第二条改动。
建议：关闭该待办并填 `result`。

**3.（低/信息）双实例的分离只靠构造方式保证，无反向用例**
证据：`toolResultRecoveryParts`（composition.ts:315-327）是共享对象；若将来有人把 `resultUnrecoverable` 挪进共享部分，authorize 路径恢复写记录能力，现有测试不会变红——`late` 单调用场景里 authorize 时结果已恢复（165 行不满足），`loss-unrecoverable` 走的是 prepare 实例（本就该写）。文档 I-84 行已如实写了这一点（「要让用例跑红得造一个同一批里有两个沙箱调用的夹具」），与代码相符。
建议：可接受；若要机器保证，可让 `createProductionToolResultRecovery` 在缺/有 `resultUnrecoverable` 时返回不同类型，或加一个断言 `inspectToolResultRecovery` 实例无写入口的单测。

**4.（信息）`limitBytes` 的边界读法**
证据：`production-sandbox-tool-result.ts:147-152`——落在 [1 MB, 1 MiB) 的值（如 1_000_000 字节）现在读作「976.6 KB」而不是「1.0 MB」；KB 用 `toFixed(1)`，而 `delivered-files.ts:54` 的 KB 用 `Math.round`。生产上限只有 1024 MiB 和 48 KiB，不受影响；纯文案边界，确定性不受影响。

**5.（信息）白名单收缩防护只覆盖 11/21 个码**
证据：`thread-execution-state.unit.test.ts:41-53` 的 `projects only allowlisted tool failure reasons` 只列了 11 个码（外加一个反向）。从单一集合里删掉未列的 10 个码（如 `DIRECTORY_TARGET_CHANGED`、`WORKER_ADMISSION_CONFLICT`）不会有任何测试失败。这与改动前等价（旧比对测试也拦不住「两份同时删」），不是退步，仅记录。

## 侧重检查（普通流程走查）

流程：用户发消息 → 模型发起沙箱命令 → 内存超限被资源监视器杀掉 → v2 执行记失败 → 恢复扫描/提前结算 → 模型收到上限文案 → 界面显示原因词。

- 模型文案段：`production-runtime-tools.ts:2103-2106` 用回执里的 `resourceCeiling` 生成 `sandboxCeilingExceededMessage`，`:2144-2159` 作为该次工具结果的 `modelContent` 追加发出——**有覆盖**（production-runtime-tools.unit.test.ts 改后的正反向断言、production-sandbox-tool-result.unit.test.ts 改后的用例）。
- 界面段：`thread-execution-state.ts:155,161`、`thread-execution-projection.ts:420` 用 `SAFE_TOOL_REASON_CODES.has`——**有覆盖**（projection 用例），control-center 的 `execution-view.ts:369` 原因词映射和 i18n 用例**未亲自读**。
- 执行段：v2 把 `resource_limit` 写成明确失败——对应 `sandbox-v2-worker-lifecycle.test.ts` 用例**未亲自读**；SRT 路径接线文档自认无用例（未核实，维持作者说法）。
- 本流程中**无测试覆盖的路径**：authorize 路径的「不写记录」（结构性保证，见问题 3）；失败回执已存在但模型尚未消费时跨升级重发文案的再生路径（推测存在，未逐行核实，但该情形下旧文案从未进入已发历史，不破坏追加性）。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。改动只触及工具结果里新造的文案（`production-sandbox-tool-result.ts:147-163`），它在失败交付时作为该轮最后一条消息追加（`production-runtime-tools.ts:2103-2159`）；系统提示、工具定义、历史、遮盖均未被本 diff 触及。已发出的「内存 1073.7 MB」存进历史后不被改写（规则第 5 条，代码无重写历史的路径）。**是**：仍然只在末尾追加，每轮会变的值不受本 PR 影响。与 prompt-prefix 规则无冲突——改的是「还没发出的新文案」，不是已发内容。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。`limitBytes` 是上限字节数的纯函数（上限记录在回执里，同版本代码同输入同输出）；没引入时间字段；`SAFE_TOOL_REASON_CODES` 只用 `.has`，从不迭代输出。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 第一条：有，单测正反向都改了，回退到 1000 换算会挂「内存 1024 MB」「输出 48 KB」断言。第二条：漂移已从结构上不可能（单一导出），残余保护是投影用例（覆盖 11/21 个码，见问题 5）；`check:incident-gates` 我读了实现（只查 backtick 路径的 `existsSync`），I-84 行里已无被删文件的引用，我抽查了行内引用的 6 个关键路径全部存在，作者报的 85 incidents/0 errors 与该逻辑一致（未亲自运行）。第三条：无直接用例，行为等价靠读代码证实（见上），文档对「为什么不为它加用例」的论证与代码相符。

**4. 每个产生/修改的值，两端都能接受吗？**
- `export const SAFE_TOOL_REASON_CODES`（thread-execution-state.ts:28）：产生于 state，消费于同文件 ：155,161 和 projection.ts:29,420，全仓库无其他消费方，同包 import，无需公开 API 注册。✓
- `limitBytes` 的新读法：只进模型文案，测试两端同步更新；与 delivered-files 的 1024 换算一致。✓
- `inspectToolResultRecovery`（composition.ts:334→343）：唯一使用点是 authorize 回调，其调用契约（返回 match、比较 binding/previousAuthority）与旧路径逐字段相同。✓
- 删除的 `purpose` 参数：所有调用方（dispatcher:336、composition:343、单测夹具）都是单参，typecheck 兜底。✓
