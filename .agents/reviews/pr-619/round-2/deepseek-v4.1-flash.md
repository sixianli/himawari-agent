## 结论与意见

### 1、中高：外部事件的“读过外来内容”标记只在生成模型请求时才写，运行在那之前失败或取消时，正文已经进了历史却没有标记，后续写操作可能按“没读过外来内容”直接放行
- 文件：`apps/agent-service/src/production-run-composition.ts:363-365`、`apps/agent-service/src/context-external-content.ts:202-206`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1145-1163`
- 问题：增量把外部事件打标记放在 `resolveProjection` 里。可是消息在 admission 事务里就以 `committed` 写进了 `thread_messages`；如果这一轮在第一次 projection 之前失败（策略解析失败、租约/权限丢失、停机取消、队列丢弃等），标记永远不会写。规格写的是“外来的事写进对话时就打上标记，不等授权”，实现晚了一步。
- 证据（读代码证实的）：`production-run-composition.ts` 为 `await externalContent.markRunSource(request.runId); const resolved = await resolvedProjection.resolveProjection(request);`；`context-external-content.ts` 的 `markRunSource` 只有被调用才 `mark`；`sqlite-thread-operations.ts` 在 admission 事务中插入 `thread_messages ... 'committed'`，并在同一事务里返回，不依赖 run 成功。
- 推测（未逐行核实 projection 的历史筛选）：后续主人消息的运行会把这条已 committed 的正文当作历史，但 `owner-scope-authorization.ts:264-269` 读不到标记，`context_external_content` 不入 facts，`action_preauthorize_owner_data`（`action-rules.ts:91`，只看 `!("context_external_content" in facts)`）就可能把 `reminder_set`、可撤回的设备写直接放行。新测试只覆盖“成功回完话”的路径。
- 建议：把标记移到“事件写进对话”这一步（admission/触发落库后立即写，或至少在 dispatcher 开始执行、任何可能失败步骤之前写），并补一条反向测试：让外部事件运行在 projection 前失败，断言 thread 上仍有标记、下一次运行 facts 里有 `context_external_content`。

### 2、中：外部事件改成每件事一个 origin 后，增量又让每次外部事件运行都写标记；thread 标记和之后每条写入的 sourceRefs 会随邮件数量无限增长
- 文件：`apps/agent-service/src/context-external-content.ts:84-89`、`222-233`、`33-54`；`apps/agent-service/src/production-run-composition.ts:363-365`；`apps/agent-service/src/production-runtime-tools.ts:647-651`；`apps/agent-service/src/production-reminder-writer.ts:250-254`；`apps/agent-service/src/production-owner-rules.ts:754-758`；`apps/agent-service/src/owner-scope-authorization.ts:264-269`
- 问题：origin 现在是 `external_event:<sourceId>`，每封邮件/每个事件一个不同的值；`#write` 只按 origin 去重、只追加、从不清理；增量又让“只回话不调工具”的外部事件运行也写标记。于是长寿命主对话的历史标记会一直变大，之后每次 `reminder_set`/`rule_set` 的 `#provenance` 又把“对话里所有 origin”整份抄进这条记忆的 `sourceRefs`（每个 origin 一条 `external-content:` ref）。这既不是“哪件事引起的”那种精确来源，也会让单条记忆记录和每次授权排序随邮件数线性增长。
- 证据（读代码证实的）：`externalEventOrigin` 拼 `sourceId`；`#write` 里 `sources: [...sources, {...}]`，无上限；`#provenance` 返回 `originsOf(await externalContent.read(runId))`（thread+run 全部）；`externalContentSourceRefs` 对每个 origin 生成一条 ref；`#externalSources` 每次授权都对整份列表 `sort()`。
- 建议：给对话标记设上限或改成“是否有外来内容”的布尔/最近 N 条（真正需要的因果来源在产生记录时按本次运行或本次工具结果取，而不是复制全历史）；补一条测试：同一对话灌入大量不同的 `external_event:*` 后，标记大小和记忆 `sourceRefs` 有界。

### 3、低：`reminder_cancel` 的登记行仍然写 `reversible: true` / `sideEffect: "reversible"`，和“取消撤不回”矛盾；登记表校验只信这个自报字段
- 文件：`apps/agent-service/src/production-tool-actions.ts:61-73`、`282-292`；`packages/application/src/services/tool-action-registry.ts:82-92`
- 问题：本次只删掉了 `reminder_cancel` 的 `himawariSideOnly`，却没有改它的 `reversible`/`sideEffect`。`assertRow` 判断“不会撤不回”时只看 `row.reversible`，所以作者说法 2“工具登记表的校验保证……不会撤不回”并不成立——当初 cancel 正是这样误标并通过校验的；将来谁再把 `himawariSideOnly` 加回去，校验仍会放行。另外作者材料开头“现在是建提醒、取消提醒”也与最终代码/规格不一致：规格第二行只写“定提醒和跟进”，代码里只剩 `reminder_set`。
- 证据（读代码证实的）：`OWNER_WRITE_DEFAULTS` 是 `reversible: true, sideEffect: "reversible"`；`reminder_cancel` 展开这套默认值；`production-reminder-writer.ts:403-421` 的 `cancel` 只把状态改成 `cancelled`，没有恢复入口；`assertRow` 的 himawari 条件是 `!row.reversible` 才报错。
- 建议：把 cancel 的登记改成真实语义（`reversible: false`/`sideEffect: "irreversible"`，必要时 `actionKind: "DELETE"`），或者新增一个由测试保证的“可撤销”字段；同时把材料/规格里“取消提醒直接做”的旧说法删掉。

### 4、低（潜在，当前调用方不可达）：`ruleSource` 在 `room <= 17` 时退回不加哈希，仍可能截掉 `|base`
- 文件：`apps/agent-service/src/production-owner-rules.ts:622-627`
- 问题：当 `room = 256 - 17 - |base| - 1` 小于等于 17 时，`kept = origins`（不截断），最后的 `.slice(0, 256)` 会从 origin 中间切掉，仍会截断 `|<base>`，也就是上一轮意见 6 的同一类问题。
- 证据（读代码证实的）：`const kept = origins.length <= room || room <= RULE_SOURCE_DIGEST + 1 ? origins : ...` 之后 `return \`${prefix}${kept}${tail}\`.slice(0, RULE_SOURCE_LIMIT);`。
- 推理：`base` 目前只来自 `chat:<threadId>` 或 `mcp:<connectionId>`；`ThreadId`/`connectionId` 是 1–128 的机器标识（`packages/domain/src/identifiers.ts:39`、`packages/gateway-contracts/src/validation.ts:49`），`room >= 105`，所以现在走不到；但把 `proposal.source` 变成更长的来源、同时带 origins 时就会撞上。
- 建议：`room <= RULE_SOURCE_DIGEST + 1` 时改为截断/哈希 `base`（或丢掉 origins 只保留 `|base`），保证 `|base` 始终保留；补一条长 `source` 的单测。

**侧重检查**

- 不可撤销操作：`reminder_cancel` 的 `cancel()` 只改状态、无恢复入口，确认上一轮意见 1 的修复方向正确；残留问题见意见 3。
- 不可信/不合规范输入：外部事件 `sourceId` 走 `machineString`（≤128、限定字符集），origin 长度受控；`ruleSource`、记忆 `sourceRefs`、卡片原因文字（`askedBecause` 每段截 80）都做了长度处理；未发现新值撞长度上限（`rule_book_rules.source` 要求 1–256，`ruleSource` 保证 ≤256）。
- 错误路径：发现意见 1 的“projection 前失败”窗口；没有找到覆盖它的测试。
- 资源耗尽：发现意见 2 的无界增长（增量放大了写入频率）。
- 安全：确认 `untrustedOriginAllowed`、`readUntrustedContent` 在仓库内已无任何读取（`grep` 零命中）；设备动作确实仍走 `OwnerScopeAuthorization`，读过外来内容时得到 `ask`，更新后的测试也改了；设备硬拒绝删掉后没有留下旧的读取端。
- 规则/文档一致性：规格第二行不含“取消提醒”；作者材料仍写“建提醒、取消提醒”，与最终代码不一致；材料说法 2 对“校验保证撤不回”说过头了；规格说“写进对话时打标记”，代码实际在 projection 时打（意见 1）。控制台三种语言的规则文案和冻结 id 清单已同步，新增 id 已进 `rule-ids.frozen.json`。

**上一轮意见与本轮核查范围**

- 意见 1（取消提醒直接放行）：已改好。`reminder_cancel` 不再有 `himawariSideOnly`，读过外来内容后走 `action_ask_after_external_content`；新增反向测试断言 `awaiting_approval`、`reminders` 未被调用、facts 不含 `himawari_side_only`，若把标记加回去这条测试会失败。
- 意见 6（来源超长切片截掉 `|base`）：对现网输入已改好。超长 origin 会被截短并加 16 位 sha256，`|<base>` 保留；新测试断言 ≤256、正则以 `~[0-9a-f]{16}|` 结尾且 `endsWith('|chat:...')`，旧实现会失败。仅剩意见 4 那段不可达的退化分支。
- 本轮查过：`git diff cd32f11e..b3e3f4681`（含两个修复提交）、`action-rules.ts`、`owner-scope-authorization.ts`、`context-external-content.ts`、`production-run-composition.ts`、`production-runtime-tools.ts`、`production-reminder-writer.ts`、`production-owner-rules.ts`、`tool-action-registry.ts`、`policy-fact-registry.ts`、`production-device-action(s)*`、`service-main.ts` 调用点、相关 SQLite 迁移、`gateway-contracts`/`domain` 的长度校验、控制台 i18n 与测试、规格文档。未运行任何测试（本轮只允许读和 git 命令）；`ContextProjectionService` 对失败运行消息的历史筛选、以及“冻结 prompt”的内部实现未逐行读，相关判断已标为推测/未核实。上一轮复核原文不在稀疏检出里（diff 显示为 Bin），只能依据材料列出的两条意见核对。

**必答问题**

1. **不会改变老对话已经见过的请求开头。** 增量的新值（`external_event:<sourceId>`、`himawari_side_only`、`ruleSource` 的哈希后缀）都不进系统提示或工具定义，只出现在授权 facts、审批卡片、记忆/规则记录和工具结果里；工具结果属于末尾追加。唯一进前缀的是 `chat.identity` 新增的一行，按 `.agents/instructions/prompt-prefix.md` 第 6 条只对新对话生效，老对话沿用冻结字节；规则 11 的遮盖风险也小：新行没有数字/验证码样式内容，旧行文字未改。（冻结实现未逐行读，按规则文件和已更新的 prompt golden/manifest 判断。）
2. **没有让模型可见的同一段文字在不同请求里变成不同字节。** 新 origin 由稳定的 `sourceId` 决定；`ruleSource` 先固定 locale 排序再做确定性 sha256；`runtimePolicyFacts` 会排序去重；`firstSeenAt` 只写进标记记录，不进 prompt、也不参与相等比较。需要注意的只是意见 2 的列表会随时间变长（同一事件的字节仍然稳定）。
3. **有自动检查，且从断言看反向用例真的会失败。** 取消提醒反向测试、超长 `ruleSource` 测试、`markRunSource` 单测和 lifecycle 正向测试都在。缺口：没有覆盖“外部事件运行在 projection 前失败/取消”的反向用例；`ruleSource` 测试也没覆盖 `room <= 17` 分支。测试未实际执行。
4. **逐个值核对了两端。** 新规则 id 进了冻结清单、三语 i18n、开关列表测试；新 fact code 进了 `POLICY_FACT_CODES`/`POLICY_FACT_REGISTRY`、授权 facts、规则表达式和测试；新 origin 被 `askedBecause`（80 字符截断）、`externalContentSourceRefs`（>256 哈希、总 ref ≤512）、`ruleSource`（≤256，满足 `rule_book_rules.source` 的 1–256）接受；`markRunSource` 的类型已在 `ProductionRunCompositionOptions` 的 `Pick` 中补上，生产装配点传的是完整实例；被删的 `untrustedOriginAllowed`/`readUntrustedContent` 全仓库无读取端。仍存在的问题见意见 1–4。
