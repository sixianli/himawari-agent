# PR 408 第 4 轮逐条判断

- **ds4-1**（deepseek-v4.1-flash）「新增的回归用例与本轮存储层实现相反，按代码执行必然失败」：不成立。用例实际运行通过（40 条全过）：待确认里还有同一用例前半段撤销后回到待确认的 PARK（没有 key），所以是 [null, drink] 两条；COFFEE 确实被标为被替换。已补断言：COFFEE 那一行是 superseded，supersededBy 指向新行。
- **ds4-2**（deepseek-v4.1-flash）「`memory.external.respond` 部分失败被静默吞掉，命令仍返回成功，调用方看不到哪些条目没处理。」：同第 1 轮 ds-6，放到 PR A2（要改约定和网页，A2 里一起做）。
- **ds4-3**（deepseek-v4.1-flash）「分级调高只改 `classification`，不改 `category`；保存后的记忆分类和 `sensitiveTopic` 仍是旧分类。」：成立，中。已改：调高分级时把分类一起改成这次提交的分类。分级调高用例补断言：保存后的记忆分类和敏感主题都是 health；不改分类时用例失败（已实际运行）。
- **ds4-4**（deepseek-v4.1-flash）「错误路径会留下无人引用的加密 payload。」：不成立（不会无限增长）。待确认正文和保存时正文的引用都由内容或提议编号决定，重试时写到同一个引用、不会再多一份；只有写库失败且再也不重试时留下一份，大小以 2000 字为上限。
- **ds4-5**（deepseek-v4.1-flash）「跨 key、同正文的替换存在把某个客户端最新正文挤掉的边缘情况。」：可以更好。同一段正文只占一行，是 ADR 决定 2「按正文去重、不按客户端」的取舍；一行挂多个 key 要改表，列给 Andy。后来按项目规矩（可以更好直接改）已改：新增表 `external_memory_proposal_keys`（迁移 0093 内），每个 key 指向它最近的正文，没有 key 指着的待确认行才标为被替换；补用例，旧代码下失败（已实际运行）。
- **ds4-6**（deepseek-v4.1-flash）「摘要缓存只随写入器自己的 `#memoryChanges` 失效，跨路径写入和“建了记忆但决定失败”的窗口会造成缓存陈旧。」：成立，低。已改：新建记忆成功后立刻更新计数和摘要表，不等决定写完。其他路径新建的记忆仍按批开始时读到的为准（批内不重读，ADR 已写明只比对本写入器新建的变化）。
- **ds4-7**（deepseek-v4.1-flash）「`propose_memories` 标了 `idempotentHint: true`，但重发带 key 的批量会新增 superseded 行、新的 proposalId 和决策记录。」：成立，低。已改为 idempotentHint: false。
- **ds4-8**（deepseek-v4.1-flash）「端口层不校验正文长度、机器密钥和 `sourceKey` 长度，坏输入会以 SQLite 约束错误而非 `PORT_INVALID_OPERATION` 冒出。」：可以更好。唯一的调用方是 MCP 入口，已校验；保存时 keep 也再查长度和密钥。后来已改：写入器 submit 自己查正文长度、机器密钥、key 长度和密钥，存储层查各字段长度和分类、分级取值；补用例，旧代码下失败（已实际运行）。
