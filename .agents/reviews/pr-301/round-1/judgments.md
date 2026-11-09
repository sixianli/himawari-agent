# PR 301 第 1 轮复核：线程判断（复核提交 40907d24，base 2995d535）
费用：本轮累计 0.3675 美元（含两次 OpenDesign 上游中断后重跑）。CodeBuddy 积分低于底线被去掉，实际走 OpenDesign。
原始意见：deepseek-v4.1-flash.md、glm-5.3-flash.md（同目录）。

## 会出错 · 中、高（要改）
1. 没有“未决模型调用必须留给对账”的反向测试（DS 中-2，GLM 5）。依据：两个新场景都不插 model_invocation_identities；删掉新分支里的 NOT EXISTS 模型调用三行，现有测试仍过。这正是协调者交代的硬约束，事故记录也承认没测。建议：加 reserved、started、unknown 各一个（至少 unknown）诊断码为 deadline 且零沙箱记录的场景，断言不收尾、也不出现在可收尾列表里。
2. 没有“有沙箱记录时不走新分支”的反向测试（DS 中-2 后半）。建议：诊断码为 deadline、存在一条未过期或 originalDeadlineAt 为空的沙箱记录，断言不收尾；两条都做变异验证（删条件必须失败）。

## 会出错 · 低（线程判断，供 Andy 抽查）
3. “deadline-code-before-deadline”不是新分支的反向用例（DS 中-1、GLM 2）：新 SQL 分支没有时间条件，截止前不收尾由 sqlite-run-dispatch-operations.ts:425 和 production-run-expiry.ts:72 保证，该场景在旧 SQL 下也通过；新分支让截止前的 deadline 诊断运行被 listReconciliationRequired 反复列出（每个扫描周期解密、校验一次后返回 false，行为正确）。触发：运行诊断码为 deadline 但时间未到。后果：多一点周期开销，事故记录的“门槛”说明夸大。模型给的是“中”，我判低：无错误结果，只是说明不准和测试守的不是新分支。建议：事故记录里改写这条归因，并加断言“截止前被列出但不收尾、状态不变”。
4. 测试夹具冻结输入没有 startedAt，生产收尾包装器 createProductionRunExpiry 完全没有测试（GLM 1）：真实冻结输入由 run-execution-input-service.ts 生成，必带 startedAt（:41、:170、:236），所以生产不会因此失败；缺口只是没有一条经包装器的端到端用例。模型给“中”，我判低。建议：夹具补 startedAt，或加一条走包装器的用例；I-88 的只读查询顺带确认冻结输入合法。
5. I-88 的“未确认清单”不完整（GLM 4，DS 低-3）：除诊断码和模型调用状态，新分支还要求“无任何 sandbox_execution_records”和整条 RUN_RESOURCES_RELEASED_SQL 成立；“只有沙箱预热”若留下记录或环境未释放，收尾仍会落空，上线会再被 TWENTYNINTH_MAINTENANCE_NON_TERMINAL_RUNS 拦下。建议：收尾前把整个谓词当只读 SQL 在生产库跑一遍；事故记录把“零命令记录”改成“零沙箱记录”。

## 可以更好 / 不成立（不改，列给 Andy）
- DS 低-1 夹具关外键删记录与生产不完全一致：建议采纳（用只建预热环境的夹具），不强制。
- DS 低-2 / GLM 3 settleExpired 对零记录时不校验传入 deadline、不检查 background hold：预先存在，生产唯一调用方已过滤；纵深防御，建议暂不改。
- DS 低-4 提交说明缺 Untested-critical-path 行：补完上面的反向测试后自然消失，否则需补该行。
- GLM 提到“仓库里没有离线收尾命令”：属实性未核实，I-88 说的是停服窗口另做；留给作者线程确认。
- 两个模型都确认：不改变发给模型的请求开头；SQL 无外部输入拼接；资源未释放不会收尾。
