# PR 589 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1（中高）直接存仍可用外部 agent 自己声明的 category 绕过“敏感内容待确认”。production-mcp-memory-writer.ts:94-101 只认自报分类；与第 1 轮第 1 条同一缺口，Andy 2026-11-15 14:33Z 在决定卡选“先接受缺口再合并”，沿用原判，已由 Andy 接受（andy-decision）；顺带把 ADR 0281 后果一节和 tools.ts 工具说明里过度承诺“敏感一律待确认”的话改成与已知缺口一致；触发：外部 agent 把健康或财务内容标成 other 等分类，接入设了直接存；后果：敏感内容以 private 不经确认入库并被使用
- 2（deepseek-v4.1-flash）成立，可以更好：### 2（中）直接存绕过待确认/暂存配额，提交行和记忆数量没有上限。sqlite-external-memory-proposal-operations.ts:156-170 上限只统计未提交行属实，但直接存是主人对这个接入明确设的信任，调用仍受每分钟次数和每次 50 条限制，主人可整批撤销；只有失控或恶意 agent 才会放大，且不丢数据不泄露；已在 ADR 0281 后果里写明；是否加每接入条数上限留给 Andy
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3（低）去重命中时仍带批次号，整批撤销对该条目是空操作。production-mcp-memory-writer.ts #keep same 分支原先按本批次提交；已改为直接存时用 batchId null 提交，不再计入批次；test/integration/mcp-write.test.ts 新增用例覆盖；触发：直接存的提议与已有记忆同文；后果：记忆页显示可撤销的批次，撤销对该条是空操作；不丢数据
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4（低）摘要缓存的修复没有自动检查，回归时测试不会失败。已在 test/integration/mcp-write.test.ts 给 listActive 加计数并断言一次 propose_memories 只扫描一次；触发：以后有人把摘要缓存改回去；后果：只是变慢，不出错
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5（低）内存代际尚未建立时，直接存会回“失败”而不是“待确认”。production-mcp-read.ts 两处直接存入口原先没查 proposals.ready()；已加 ready() 检查，未就绪按待确认返回；新增用例 direct+notReady；触发：直接存时内存代际尚未建立；后果：外部 agent 收到失败而不是待确认，提案仍留在待确认；不丢数据
