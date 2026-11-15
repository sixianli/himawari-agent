# PR 591 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高 - 人物建议 ID 可能超过后端 machineString 128 上限，导致“人物”确认命令必失败（I-73 类问题）。sqlite-memory-book-operations.ts:362 原为 person-suggestion:<personId>:<candidateId>；memoryId=memory:memory-review:<32hex>:n 约 55，personId 约 64，总长约 147，validation.ts:49-56 上限 128。已改为 person-suggestion:<32位摘要>，测试断言格式；触发：会话回顾产生的记忆里出现两个人物且其中一个被判可能是同一人时，suggestionId 约 147 字符；后果：suggestionId 超过 machineString 128 上限，memory.person.respond 命令被拒，人物确认不可用
- 2（deepseek-v4.1-flash）不成立：### 2. 高 - 手动新建先把原文以 private 上传再分类，卡号/密码等会先发给分类模型。production-memory-classification.ts:70,217 的 classify 在调用模型前先对每段文本做 deterministicallySensitive（含卡号、证件、凭据正则），命中直接返回敏感，不会送给分类模型；模型只看到不含这些特征的文本。private 副本只是留在本机 payload 库，与普通会话文本同级，随后 #createMemory 会升级
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 中 - 手动新建没有长度上限，超过 2000 字的记忆会被读取截断，编辑保存会丢尾部。MemoryAddSheet 原无上限，memory-page.tsx:2366 web 限 500。已在 MemoryAddSheet 加 500 字上限（输入截断，保存禁用）；触发：在手机上新建超过 2000 字的记忆再编辑保存；后果：编辑回填被 singleLine 截到 2000 字，保存后丢尾部；判低理由：需要故意输入超过 2000 字的记忆才触发，一般记忆是一两句话；web 端本就限 500 字
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 中 - “敏感用 sensitive 重新上传”没有自动检查，去掉重传测试仍会通过。测试 Recorder 原不记录上传；已改为记录上传的 dataClassification，断言先 private 后 sensitive、memory.create.contentRef 指向 sensitive 的 ref（MemoryDecisionTests.swift）
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 中 - 新手写的记忆 DTO 没有与 contracts-v2 的自动一致性检查，解码失败还会被静默吞掉。手写 DTO 与 contracts-v2 没有共享夹具确实是测试缺口，但当前字段名核对一致；try? 静默是有意的降级，不阻塞主列表。属于工程改进，不在本 PR 范围，建议后续从合约生成或加夹具测试
- 6（deepseek-v4.1-flash）成立，可以更好：### 6. 低 - 记忆依据读取失败会被当成“没有依据”，用户无法区分。MemoryAwaitingActions.swift:104-112 读取失败返回空数组，详情只是少一行“整理自”，不显示错误内容，属体验改进
- 7（deepseek-v4.1-flash）成立，可以更好：### 7. 低 - `memory.review.read` 里的规则待审项被完全忽略，页签数字可能少算。本 PR 范围是待确认记忆；规则待审不在本次需求内（MemoryAwaiting.swift 只解码 memories），属范围问题而非错误
- 8（deepseek-v4.1-flash）成立，可以更好：### 8. 低 - `reflect` 整理动作没有对应文案，会落到泛化的“整理了”。M.tidyAction 对 reflect 走通用“整理了”，文字不误导，补文案是改进
- 9（deepseek-v4.1-flash）成立，可以更好：### 9. 低 - 页签数字只算“新确认”，不含同页签里的“可以撤销的”行。页签数字定义为需要用户确认的项，撤销行是已完成动作的回退入口，不计入是有意设计；可在文档写明
