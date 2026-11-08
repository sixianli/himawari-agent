## 结论概述

我没有发现高、中严重度的功能回归。三条改动在代码层面基本实现了作者描述的目标：字节上限改用 1024 换算、白名单只剩一份、延续授权路径不再拿到写“不可恢复”记录的入口。发现的问题集中在文档一致性和“变更三没有反向门槛”上。

## 侧重检查

我按本次侧重查了这些路径：

- 错误路径：`production-tool-result-recovery.ts:84-96` 的空检查/诊断码过滤、`:143-168` 的逐条 admission 恢复与写记录、`:294` 的“恰好一个匹配”约束。没有发现新改动扩大或缩小这些错误分支。
- 不可信输入：`sandboxCeilingExceededMessage` 的上限数字来自 `completion.resourceCeiling ?? ceiling`（`production-runtime-tools.ts:2105`），改动前后同样把外部/持久化的数字拼进文案；`limitBytes` 只做算术和 `toFixed`，没有注入或解析风险。白名单 `Set` 的值仍是源码字面量，`projection:420` 只做 `.has`。
- 安全：导出 `SAFE_TOOL_REASON_CODES` 只在包内被两处 `.has` 使用（`thread-execution-state.ts:155,161`、`thread-execution-projection.ts:420`），不在 `packages/application/src/index.ts` 的公开导出里，未扩大对外可变更面。
- 资源耗尽：`createProductionToolResultRecovery` 建两个实例只多做几次轻量的 `payloadStore` 绑定；恢复循环上限仍在 `:116`（10000 条 trace），没有新增循环。
- 不可撤销操作：写 `sandbox-tool-result-unrecoverable:` 记录是不可撤销的 artifact 提交；新代码让 inspect 实例在结构上没有该回调，方向正确。
- 规则/文档一致性：发现两处旧文档没有随代码更新（见下），I-84 事故行本身的措辞基本与代码相符，但“在类型上”措辞不精确。

## A. 读代码证实的问题

### 1. 低：`docs/lessons.md` 仍要求使用已删除的门槛文件

- 文件:行：`docs/lessons.md:668`
- 问题：该教训把 `test/tooling/safe-tool-reason-codes.test.mjs` 列为“改了会发给模型的固定文字时必须手工加上的门槛”。本 PR 已删除这个文件，但仍留着这条指引，后续照做会引用不存在的文件。
- 证据：`docs/lessons.md:668` 原文：
  > `凡是改了会发给模型或显示给用户的固定文字，第 0 层清单里必须手工加上按路径扫源码的门槛（`prompt-catalog.unit.test.ts`、`test/tooling/safe-tool-reason-codes.test.mjs`、`check:glossary`）`

  而 `git diff` 中该文件已被删除（`test/tooling/safe-tool-reason-codes.test.mjs | 25 ------------------`），全仓库仅 `docs/lessons.md` 还提到它。
- 建议：把该文件名从这条教训里替换成“白名单现在只有一处定义”的说明，或删掉该例子。

### 2. 低：Backlog `BL-20261017-005` 仍显示为未完成，且描述与当前代码相反

- 文件:行：`docs/backlog/BL-20261017-005-合-并-两-份-界-面-可-显.md:4,22,30`
- 问题：本 PR 正是该 backlog 的“处理方向：只留一份清单，两处都从同一个导出读取”，但文档仍是 `record_state: "open"`，摘要仍说“现在有两份”。
- 证据：`BL-20261017-005...md:4` `record_state: "open"`；`:22` `这份“可显示的原因码”清单 ... 现在有两份`；`:30` `处理方向：只留一份清单，两处都从同一个导出读取`。代码现在是 `thread-execution-state.ts:28` 单一定义、`thread-execution-projection.ts:29` import。
- 建议：按仓库 backlog 惯例把该条置为已完成并填写 `result`，或至少更新摘要。

### 3. 低：变更三没有对应的自动检查，也没有“不写记录”的反向用例

- 文件:行：`apps/agent-service/src/production-run-composition.ts:328-334`、`apps/agent-service/src/production-tool-result-recovery.ts:157-168`
- 问题：`inspectToolResultRecovery` 不传 `resultUnrecoverable`，靠 `options.resultUnrecoverable &&` 这个条件保证不写记录；但没有任何测试直接断言“这条路径不写记录”，也没有测试会在有人把 `resultUnrecoverable` 加回 `toolResultRecoveryParts` 时失败。作者在 I-84 行用推理代替了测试。
- 证据：
  - `production-run-composition.ts:334` `const inspectToolResultRecovery = createProductionToolResultRecovery(toolResultRecoveryParts);`（parts 在 `:315-327` 不含 `resultUnrecoverable`）
  - `production-tool-result-recovery.ts:157-168` 写记录的前置条件：
    ```
    if (
      saved.checkpoint.diagnosticCode === "RUNTIME_TOOL_RESULT_UNKNOWN" &&
      options.resultUnrecoverable &&
      ...
      (await options.resultUnrecoverable(admission.record))
    )
      await markUnrecoverable(candidate.runId, admission.record);
    ```
  - 现有集成测试只覆盖正向：`sqlite-sandbox-execution-v2.test.ts:6185-6215` 断言 `loss-unrecoverable` 会写一条，`:6232-6249` 断言 `late` 能恢复；没有“inspect 实例不写”的断言。
- 建议：加一条直接测试：用 `createProductionToolResultRecovery` 不传 `resultUnrecoverable`，构造满足其余条件的 admission，断言 `run_payload_artifacts` 里没有 `sandbox-tool-result-unrecoverable:%`；或者用同批两个沙箱调用的夹具覆盖。这样 I-84 行“结构上拿不到写入口”才有可执行证据。

### 4. 低：I-84 行“在类型上就拿不到写入口”措辞不精确

- 文件:行：`docs/incidents-and-gates.md` I-84 行（当前第 122 行）、`apps/agent-service/src/production-tool-result-recovery.ts:49,159`
- 问题：`resultUnrecoverable` 仍是 `createProductionToolResultRecovery` 的可选类型字段（`production-tool-result-recovery.ts:49`），所谓“拿不到”是这次实例没有传值，并且运行期条件在 `:159`，不是类型系统禁止。文档这样写会让读者以为类型层面无法传入。
- 证据：`:49` `readonly resultUnrecoverable?: (record: SandboxExecutionRecord) => Promise<boolean>;`；`:159` `options.resultUnrecoverable &&`。
- 建议：改成“这条路的实例没有传入 `resultUnrecoverable` 回调，写记录的条件不成立”。

### 5. 信息/取舍：`KB`/`MB` 实际按 1024 计算，严格说是 `KiB`/`MiB`

- 文件:行：`apps/agent-service/src/production-sandbox-tool-result.ts:147-152`
- 问题：新换算用 1024，但单位仍写 `KB`/`MB`。例如 `2_500_000` 字节显示为 `2.4 MB`（`production-runtime-tools.unit.test.ts:563`），比十进制 2.5 MB 略小。这是作者有意与上限常量对齐的取舍，不是功能缺陷，但会让人误读为十进制单位。
- 证据：`:148-151` `value >= 1024 * 1024 ? ... MB : value >= 1024 ? ... KB`；测试期望 `[2_500_000, "输出 2.4 MB"]`。
- 建议：若要严谨，写 `MiB`/`KiB`；若要保持与现有常量文案一致，至少在注释/文档里说明 KB 指 1024 字节。

## B. 推测 / 未核实

- 推测（低）：作者“单个沙箱调用的轮次不可能同时满足『已经恢复出结果』和『还有一个结果未知且永远恢复不了的调用』”的论证，对同一个 admission 成立：`recoverMissingResult` 在写记录判断之前执行（`production-tool-result-recovery.ts:150-156`），恢复成功后 `facts.result.kind` 变为 `result`/`error`，`:165` 的排除条件不再成立。但我没有找到“同一轮次不可能有多个沙箱 admission”的硬性保证（`inventory.admissions` 是整轮的集合，`:143`）。不过即便这个极端场景可达，旧代码在 authorize 路径传 `recordUnrecoverable:false`，新代码用没有回调的实例，行为都是不写，因此不是行为回归，只是“推理可能不严谨”。
- 未核实：作者列出的测试数量、`typecheck`、`lint`、`check:incident-gates` 结果，我没有重跑（工具限制只允许读和指定 git 命令）。
- 未核实：`docs/incidents-and-gates.md` I-84 新行里其余路径是否全部存在；从 `scripts/check-incident-gates.mjs:65-70` 的规则看，只要有一个反引号路径不存在就会报 `INCIDENT_GATE_PATH_MISSING`，作者称 errors=0，我未亲自运行。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。改动只影响 `sandboxCeilingExceededMessage` 生成的文案（`production-sandbox-tool-result.ts:162-163`），它经 `production-runtime-tools.ts:2103-2105` 计算后，作为本次工具结果的 `modelContent` 返回（`:2144-2159`）。工具结果在 Pi 循环里是追加在对话末尾的新消息，不是系统提示、工具定义或历史。已发送的历史按原字节保存；`production-tool-result-recovery.ts:92` 明确跳过 `saved.checkpoint.output !== null` 的轮次，已交付的结果不会被重新生成。每轮会变的上限数字也在末尾这条工具结果里，且对同一条命令来自 `plan.resourceCeiling`（`production-sandbox-tool-result.ts:389-391`、`production-runtime-tools.ts:894`、`:2105`），不是时间或环境。与“只追加”不冲突。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

不会。`limitBytes`/`limitAmount` 是纯函数，只依赖传入的上限数字（`production-sandbox-tool-result.ts:130,147-152`），没有时间、随机、无序集合或前后文依赖。`SAFE_TOOL_REASON_CODES` 只用于 `.has`（`thread-execution-state.ts:155,161`、`thread-execution-projection.ts:420`），不序列化、不迭代，集合顺序不影响输出。对同一条命令，失败路径和恢复路径都用 `plan.resourceCeiling`/持久化 receipt，数值稳定。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

- 变更一：有。新正向断言在旧实现下会失败（旧：`268.4 MB`、`2.5 MB`、`32.8 KB`；新：`256 MB`、`2.4 MB`、`32 KB`），见 `production-runtime-tools.unit.test.ts:526,558,563-565` 和 `production-sandbox-tool-result.unit.test.ts:162-173`。新增的 `not.toContain` 反向断言偏弱，但正向断言已能拦住旧实现。
- 变更二：删除了唯一“两份一致”的比对测试；现在只剩一处定义，结构上不会漂移。`thread-execution-state.unit.test.ts:49-52` 仍覆盖 `SANDBOX_CPU_TIME_LIMIT`、`SANDBOX_MEMORY_LIMIT`、`SANDBOX_RESOURCE_LIMIT`、`SANDBOX_OUTPUT_LIMIT` 能投影。没有“新增第三份拷贝会失败”的反向用例，但原测试也没有覆盖这种情况。
- 变更三：没有专门测试，也没有“inspect 实例不写记录”的反向用例。现有 `loss-unrecoverable` 覆盖 prepare 实例会写，`late` 覆盖 inspect 实例能认领；但“反向用例真的会失败”这一条不成立。见问题 3。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对：

- `limitBytes` 的字符串产物 → `sandboxCeilingExceededMessage` → `modelContent`（`production-runtime-tools.ts:2144-2150`）。消费端只拼文案，不解析、不校验格式；测试接受新值。无问题。
- `SAFE_TOOL_REASON_CODES` 导出 → `thread-execution-state.ts:155,161` 和 `thread-execution-projection.ts:420`，两边都只依赖 `Set<string>.has`；值本身未变，无 schema 校验。无问题。
- `toolResultRecoveryParts` → 两次 `createProductionToolResultRecovery`（`production-run-composition.ts:328-334`）。工厂只读 options（`production-tool-result-recovery.ts:37-52`），必填字段齐全。无问题。
- 删除 `purpose` 参数 → 唯一调用点 `production-run-dispatcher.ts:92-94,336` 本来就只传一个参数；旧的第二个参数只在 `production-run-composition.ts` 传 `{recordUnrecoverable:false}`，现已改为独立实例。无问题。
- `docs/incidents-and-gates.md` I-84 行 → `scripts/check-incident-gates.mjs:65-70` 从反引号里提取路径并 `existsSync`；删除已删测试的引用是必需的。补充：该检查对所有行都查路径，不只“已关闭行”，作者这句话略不准确，但处理方式正确。

## 对作者特别想知道的三点

1. **第一条文案与“只追加”**：不冲突。它只是末尾新工具结果消息里的文字；历史里的旧字节不动，已交付结果不会被重新生成（`production-tool-result-recovery.ts:92`）。
2. **删除门槛后 I-84 的保护是否站得住**：站得住。原来要防的“两份拷贝不一致”在只剩一份定义后不存在；关键原因码仍由 `thread-execution-state.unit.test.ts:49-52` 覆盖，投影侧和状态侧通过同一 import 使用同一集合。I-84 新行也已去掉对已删门槛的引用，措辞基本相符。唯一可加强的是补一条“新增第三份拷贝”的静态检查，但这不是本 PR 引入的缺口。
3. **第三条推断与行为是否变化**：推断对单个 admission 成立（恢复先于判断，见 `production-tool-result-recovery.ts:150-168`）；多沙箱调用的极端场景我没有完全排除，但由于 inspect 实例根本没有 `resultUnrecoverable`，行为与旧代码传 `{recordUnrecoverable:false}` 完全一致，不构成回归。建议补一条“inspect 实例不写记录”的测试，把这条保证从推理变成门槛。
