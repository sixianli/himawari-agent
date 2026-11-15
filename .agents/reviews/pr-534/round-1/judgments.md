# PR 534 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高：“读全文才能同意”的任务提案从不向主人显示任务原文。production-task-proposals.ts 旧 evidence 只放 reason，正文只在 data；提醒类提议把原文放 evidence。已改为按 500 字拆成 task_text 依据，测试 shows the owner the whole task text 证明；触发：任务说明超过 500 字，或超过 60 字被摘要截断；主人点开全文；后果：主人同意的任务原文没有在卡片里展示，等于没看全文就同意
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 高：`external_event` 运行会被自动当作“外部内容”，写操作被规则直接拒绝。owner-scope-authorization.ts:243-252 对 external_event 一律记外部内容标记；action-rules.ts:233-239 对此 refuse。拒绝是安全默认，所以只改效果句和 architecture-v0.1.md 说真话；要不要放开写操作是产品决定，交回 Andy；触发：主人同意任务后，运行里出现任何非读取动作；后果：卡片效果句说仍要另外批准，实际被 refuseBackgroundAfterExternalContent 直接拒绝，主人被误导
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 中：执行中途崩溃会留下空对话或永远“未知”的提议。production-proposals.ts 恢复逻辑找不到原样时记结果不明是既有的文档化行为；空对话残留文档没写，已补进 architecture-v0.1.md；续租一说只是推测未证实；触发：执行在建对话之后、开运行之前失败或进程崩溃；后果：留下没有消息的空对话，提议记失败或结果不明；判低理由：崩溃窗口很窄，只留低量残留，不丢数据也不重复执行
- 4（deepseek-v4.1-flash）成立，会出错，中高：### 4. 中：任务正文固定按 `private` 保存，可能把敏感内容降级。旧代码两处写死 private；已改为 classificationWithIdentifiers(text,'private')，测试 stored as sensitive 证明；触发：任务说明含证件号或凭据；后果：对话消息和触发载荷存成 private，低于提议依据的 sensitive
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 中：同一 pending 任务重新提议可把“读全文/外部内容”标记降级。已让 requiresFullRead 同时看 origin；测试 external-content origin alone 证明。刷新降级是提议箱对所有类型的既有行为，只在同一调用方前后不一致时出现，且当前没有来源调用；触发：调用方只传 origin 为 external_content 而不传 externalContentSeen；后果：短任务不要求读全文，与文档不一致；判低理由：降级路径需要调用方自相矛盾，目前没有调用方
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 中：`proposalId` 的哈希输入有歧义且 `basis` 未排序，不同提议会撞号。旧代码用换行拼接且未排序。已改为 JSON.stringify 加排序，测试 without ambiguity 证明；触发：任务说明含换行和冒号，可与另一组说明加依据拼成同一串；后果：两个不同提议撞同一编号；判低理由：要特意构造撞号的文本才触发，后果是少开一次提议
- 7（deepseek-v4.1-flash）成立，可以更好：### 7. 中：store 返回 `closed` 时仍返回 `proposalId`，成功过的同一任务永远不能再提议。closed 时返回编号是存储层既有语义，提醒类提议同样；文档已写明同一说明加依据办过后不再重开。是否让 propose 把 closed 交给调用方是提议箱的设计，影响所有类型，留给来源接入时定
- 8（deepseek-v4.1-flash）成立，会出错，低：### 8. 中低：`readBack` 只确认存在，不确认运行是否已开始、失败或取消。readBack 只查存在。成功指运行已建立并被受理，不改代码，architecture-v0.1.md 已改成这个定义；触发：运行建好后被取消或失败，再走恢复读回；后果：仍记成功，文档说已经开始办；判低理由：只是文字不准，实际含义由运行自己的状态给出，不误导主人的决定
- 9（deepseek-v4.1-flash）成立，可以更好：### 9. 低：自动检查覆盖不足，若干反向场景不会被测试抓到。测试缺口：已补任务全文展示、origin 单独读全文、编号无歧义、分级四条测试；幂等键单独不可测、崩溃恢复和审批规则需要大改夹具，留作建议
