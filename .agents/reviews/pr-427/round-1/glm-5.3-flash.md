# 复核报告：PR 427（工具参数 activity / activityIcon）

## 侧重检查（先走的一条普通流程）

网页用户发消息 → 网关起 run → `pi-runtime-adapter.ts` 组请求头（冻结束重建一次，之后稳定）→ 模型返回 toolCall（带 activity/activityIcon）→ Pi 用副本校验参数（原样进历史）→ 隐藏扩展 `himawari-tool-outcomes` 的 `tool_call` 钩子删掉两项（`pi-runtime-adapter.ts:1529-1532`）→ `preflight`/`execute` 拿到已删参数 → `tool_execution_start` 的 intent 仍带原参数 → `thread-execution-projection.ts` 读 trace 生成记录（`toolActivity`，第 57-88 行）→ 网关按 `threadExecutionRecordSchema` 出 snapshot → 网页 `execution-view.ts:213-214` 按 itemId 合并 → 网页过程行仍显示模板句（模型那句话网页目前不显示，与 ADR 一致）。

走过的结论：
- 主链路每一环都有对应测试：`[ICON-1]`（真实 Pi 会话，锁定义、图标表恰一次、preflight/execute 已删、自有参数保留、intent 保留）、`[ICON-2]`（真实 SQLite，锁两字段、fallback 图标/模板句、input 已删、逐条过契约）、`[ICON-3]`（三语 × 18 类逐字锁）、golden 请求字节对照、manifest 哈希测试。
- **没有测试覆盖的路径**：① `execution-view.ts:213-214` 新加的两行合并逻辑（control-center 全部测试只是给夹具补了空字段，没有一条断言“空值不覆盖”或图标随 activity 的合并规则）；② `toolActivity` 收到非对象参数的分支（`[ICON-2]` 只测了对象参数）；③ 只有执行句柄工具、无冻结工具的线程（见问题 7）。

## 发现的问题（按严重度从高到低）

1. **中** `packages/prompt-catalog/src/trusted.ts:11-15` — 新增的三条目录文字没有进 `TRUSTED_PROMPT_TEXTS`（遮盖白名单）。trusted.ts 聚合的模块列表是 `background, chat, evaluation, mail, memory, review, runtime, tools`，不含新增的 `activity.ts`；`CHAT_PROCESS_ICONS_SECTION`、`TOOL_ACTIVITY_PARAMETER`、`TOOL_ACTIVITY_ICON_PARAMETER` 三条因此不被当成“Himawari 自己写的固定文字”（规则第 11 条），遮盖时按外来内容检查。读代码证实的。当前这三段文字没有数字和“验证码”类字样，实际遮盖结果不变、字节仍确定；但机制约定被绕过，且没有任何测试能发现这种遗漏（`trusted-prompt-egress.unit.test.ts:130` 只抽查 `MEMORY_CAPTURE` 一条）。建议：把 `activity` 加入 trusted.ts 的模块列表，并补一条“每条目录文字都在 TRUSTED_PROMPT_TEXTS 里”的反向测试。

2. **中偏低** `packages/prompt-catalog/src/activity.ts:3-40 与 67-82` — 36 个图标的数组 `PROCESS_ACTIVITY_ICONS` 和系统提示“过程图标”一节的文字是两份手写维护的清单，没有测试锁一致。数组多一个/少一个名字，或文字漏抄一个，服务器接受的名字和模型被告知的名字就会静默分叉（多出的名字模型永远挑不到，少掉的名字被换成 `tools`），无任何检查报警。另：数组确为 36 个、与文字逐名相同（我逐个数过），ADR 里“40 个图标、4 个留给服务器状态”的说法与代码一致（`hand-stop`/`alert-circle`/`player-stop`/`check` 不在数组里）。建议：加一条测试断言数组里每个名字都出现在 `CHAT_PROCESS_ICONS_SECTION.text` 且数组长度为 36。

3. **低** `packages/application/src/services/thread-execution-projection.ts:66,83-88` — 回退模板句按**读取时**的 `thread.answerLocale` 计算，而 trace 里不存当时的语言。对话中途改回答语言（规则第 6 条允许换新）之后，同一历史工具步骤每次读出的模板句会变。只影响网页/手机显示，不影响发给模型的字节。若要“按当时的回答语言”，需在事件里落语言或接受这个回溯变化并写进 ADR。

4. **低** `apps/control-center/src/execution-view.ts:213-214` — 新合并逻辑无测试（见侧重检查①）。且 `activityIcon` 的合并以 `record.activity` 是否为空为开关，依赖“凡 activity 非空则 icon 必非空”这个 `toolActivity` 的隐含不变量（icon 恒有 fallback `tools`），该不变量本身也没有测试锁。建议补一条“started→ended 空值不覆盖、icon 跟随 activity”的单测。

5. **低** `packages/prompt-catalog/src/activity.ts` — 参数说明告诉模型“不超过 30 个字”，`PROCESS_ACTIVITY_MAX_LENGTH` 却是 80（按 Unicode 字符截断）。不算错（服务器截断是兜底），但两处数字没有关联，改一处不会提醒另一处。建议在常量旁注明与说明文字的关系。

6. **低（推测）** `packages/prompt-catalog/src/activity.ts:73`（系统提示“调用任何工具时都可以给”）对照 `tool-activity.ts:14` — 参数结构不是 type:"object" 的工具不会加这两个参数，而系统提示说“任何工具”都可以给；这类工具的严格参数校验会拒掉带 activity 的调用，模型得重试。仓库里有多少非 object 参数的工具未核实。建议把提示文字改为“参数是对象的工具”。

7. **低（推测）** `packages/runtime-pi/src/pi-runtime-adapter.ts:1367-1394` — 冻结束的系统提示只用冻结工具计算；若某对话没有任何冻结的 object 参数工具、某轮只出现执行句柄工具，则该轮工具带 activity 参数、参数说明却引用一个不存在的系统提示“过程图标”一节。属边缘情形，未找到实际会走到这条路的数据。

## 作者说法逐条核对结果

- “删除放在 `himawari-tool-outcomes` 的 tool_call 钩子，Pi 文档说改 event.input 作用到真正执行”：钩子属实（`pi-runtime-adapter.ts:1529-1532`）；Pi 文档行号是外网链接，**未核实**，但 `[ICON-1]` 用真实 Pi 1.5.0 会话行为上锁住了（preflight/execute 收到的参数无这两项），等效证实。
- “工具自己已有 activity 或 activityIcon 时不加、也不删”：属实。`withToolActivityParameters`（tool-activity.ts:16-21）只要任一名字已存在就整体不加；`carriesToolActivity`（38-42 行）按 description 精确匹配判定，`[ICON-1]` 里 `diary_note` 的自有参数原样到达 execute。
- “执行结束那条记录两字段为空，网页合并时空值不覆盖”：属实。ended 记录用 base（activity:""）（projection 501-507 行）；合并见 execution-view.ts:213-214。但“空值不覆盖”这一行为本身没有测试（问题 4）。
- “网页 i18n 的 step.<类> 与共享表 PROCESS_STEP_TEXT 由 [ICON-3] 锁住逐字相同”：属实，测试遍历全部 18 类 × 3 语，反向会失败。
- “Andy 已同意换新一次请求开头”：外部材料（iOS 设计线程、PR 405 提交），**未核实**。
- “手机客户端读同一份值”：iOS 端在外部仓库，**未核实**；服务器侧契约已就绪（新字段必填、旧客户端会报 unknown field，ADR 已承认并写明同发布）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 会，但方式是规则允许的：改动只落在请求开头（工具定义加两个静态可选参数、系统提示末尾追加一段固定图标表，`productSystemPrompt` 第 607 行，`[ICON-1]` 锁住全头恰出现一次）。会变的值（时间、记忆、资料）位置不动；历史里模型自己写的 activity/activityIcon 由 Pi 的副本校验保留原样、只追加不改写（`[ICON-1]` 锁住 intent 里仍有）。头部变化是 `toolSchemaChanged`（thread-prompt-bundle-service.ts:152-157，新属性键不被 description 剥离规则吞掉）触发的**每对话一次**换新（现有 thread-prompt-bundles.test.ts:433 有 tool_schema_changed 用例，夹具细节未逐行核实），换新之后恢复逐字节稳定，golden 请求字节对照已更新。符合 prompt-prefix 规则第 4/6 条；d4-golden 两条请求体与新代码一致。
2. **同一文字会不会变成不同字节？** 发给模型的部分：不会。图标表和参数说明是固定目录文字；activity 原样存历史；遮盖对新文字无敏感匹配且逐次确定。显示层有一处例外（问题 3）：回退模板句随读取时的回答语言变。
3. **有没有对应的自动检查、反向用例会不会真的失败？** 有，且我逐条推演过失败方式：`[ICON-1]` 若漏删，`executed.get("activity-call")` 的 toEqual 精确比较和 preflight 的 toContainEqual 都会失败；`[ICON-2]` 若丢字段，契约 parse 抛 `$.activity`；`[ICON-3]` 若网页文字漂移，全部 18 类比对失败；process-step 契约测试带原型污染反向用例（`constructor`/`toString` 判为 other）；manifest 哈希不匹配报 PROMPT_MANIFEST_STALE 且有 REVERSE 用例。缺口：图标数组↔提示文字、TRUSTED_PROMPT_TEXTS 完整性、execution-view 合并行这三处无检查（问题 1、2、4）。
4. **每个新值的两端都核对过吗？** ① activity/activityIcon 参数：产生于 `withToolActivityParameters`（所有定义都过 `toolDefinition`，含冻结、句柄、内置三路），消费端 Pi 严格校验（已声明故通过）、tool_call 删除、projection 读取——两端一致；`constrainedSampling` 全仓库无实际取值，严格枚举风险是理论的。② `PROCESS_ACTIVITY_ICONS`：消费端仅 projection 校验，与提示文字无锁定（问题 2）。③ `processStepKind`/`PROCESS_STEP_TEXT`：与网页旧表逐条相同（diff 对照），消费端 step-summary 和 projection 回退共用。④ `threadExecutionRecordSchema` 两字段：唯一生产者是 projection，四处 `kind:"tool"` 构造全覆盖（297、318、494 行 + base），`rememberStateRecords` 的清理路径也清空了这两项；消费端网关 snapshot 校验同 schema、control-center 测试夹具全部补齐、手机端未核实。⑤ manifest 三条带 ADR 0250 和哈希，由现有测试锁。⑥ golden 两条请求体与代码一致。
