# PR 408 第 1 轮逐条判断

- **ds-1**（deepseek-v4.1-flash）「待确认正文按「码点」限 2000，但快照契约按 UTF-16 长度限 2000，可让整个记忆页打不开」：成立，中高。已改：MCP 入口和保存时都按 UTF-16 码元数限 2000（和记忆页、记忆条目的上限一致，JSON Schema 的 maxLength 仍是 2000，服务端更严）。新用例：1001 个表情符号回「没有保存」，1000 个能进待确认、快照里每条不超过 2000。
- **ds-2**（deepseek-v4.1-flash）「`idempotencyKey` 允许 128 字符，但被直接当批次号拼进决策记录 id，超过 128 位会写失败」：成立，中高。已改：批次号改为 `batch-` 加幂等键 SHA-256 前 32 位（externalProposalBatchId），记忆编号、决策记录编号都不超过 100 字。网页用例改用 128 字的幂等键；把批次号改回幂等键原样后用例失败（已实际运行）。
- **ds-3**（deepseek-v4.1-flash）「网页路径之外，保存时没有和已有 active 记忆按正文去重，与 ADR 0228 决定 5 不符」：成立，中。已改：按正文找已有记忆挪进 keep()，网页确认和客户端确认框共用；去掉 keepAsExisting。新用例：确认框路径同意一条与已有记忆同文的提议，返回已有记忆编号、不新建。
- **ds-4**（deepseek-v4.1-flash）「同一批内多条改成相同正文时，去重表只算一次，仍会建出重复记忆」：成立，中。已改：keep() 新建记忆后把摘要写回同一张表。新用例：两条改成同样正文只建一条，第二条指向第一条；去掉写回后用例失败（已实际运行）。
- **ds-5**（deepseek-v4.1-flash）「`keep()` 忽略 `proposals.decide()` 的返回值，和 `submit()` 的 sourceKey 替换并发时会「记忆已建、提议却不是 committed」」：成立，中。已改：写入器的所有提交和决定（submit、keep、decline）改为在同一个队列里一次处理一个；keep 检查 decide 的结果，没改成功就报 MCP_PROPOSAL_ALREADY_DECIDED。并发交错没有写成用例（队列串行后不可再现），记在这里。
- **ds-6**（deepseek-v4.1-flash）「`respond` 的部分失败完全不返回给调用方，网页可能看到「成功」但实际有条目没处理」：可以更好。没处理成的条目仍在待确认里，下一次快照能看到；把逐条结果放进命令结果要改约定和网页，放到做网页区块的 PR A2 一起做，列给 Andy。
- **ds-7**（deepseek-v4.1-flash）「拒绝正文 30 天清理对「清理后再次被提议」的场景失效，会留下永不清理的 payload」：成立，中。已改：存储层命中已有行时，若新写的 payload 没有任何一行引用就删掉。30 天用例补断言：重发后 payload 仍不存在；去掉删除后用例失败（已实际运行）。
- **ds-8**（deepseek-v4.1-flash）「同一正文先以普通分类提交、再以 health/finance 提交时，分级不会调高」：成立，中。已改：命中待确认行且新算的分级是敏感时，把这一行调成敏感（只升不降）；保存时取行上分级和重新算的分级中较高的。新用例：保存后的记忆是敏感；去掉调高后用例失败（已实际运行）。
- **ds-9**（deepseek-v4.1-flash）「撤销不是原子的，失败路径会留下「记忆已进回收站、提议仍 committed」」：不成立。#externalUndo 只对 active、archived 的记忆调 trash，中途失败后重试会跳过已进回收站的，再 reopenBatch，结果和一次做完相同；失败时命令报错，网页可以重试。
- **ds-10**（deepseek-v4.1-flash）「每次 `revision()` 轮询都解密最多 100 条待确认正文，纯属浪费且放大故障面」：成立，低。已改：修订串改用 pendingSummary，只读编号和分级，不解密、不清理。
- **ds-11**（deepseek-v4.1-flash）「`superseded` 提议的正文永不清理」：成立，低。已改：被替换的条目和拒绝的一样 30 天后清掉正文（迁移 CHECK 允许 superseded 的 content_ref 为空），同样正文又在待确认里时保留 payload。新用例覆盖。
- **gl-1**（glm-5.3-flash）「已被清掉正文的「已拒绝」提议，重新提同样的话会把明文正文重新写回磁盘，成为永远无人清理的孤儿 payload。」：同 ds-7，已修。
- **gl-2**（glm-5.3-flash）「每次计算修订串（revision）都会解密最多 100 条待确认正文，并在读路径里顺带做写清理。」：成立，低（同 ds-10），已修。
- **gl-3**（glm-5.3-flash）「撤销没有整体事务，且撤销后整个批次从批次列表里消失。」：不成立。重试见 ds-9；撤销后批次从列表里消失是有意的：条目回到待确认，再确认用新批次号。
- **gl-4**（glm-5.3-flash）「新写入的 `pending_approval`（mcp_proposal_pending）和 `superseded`（mcp_proposal_superseded）账本行会进每日回顾池」：成立，低。已改：daily-review.ts 跳过这两种原因码。每日回顾用例补了待确认和被替换的记录，断言不出现；去掉跳过后用例失败（已实际运行）。
- **gl-5**（glm-5.3-flash）「撤销批次后若用同一个批次号再次 respond，`keep` 发现同号记忆已存在（在回收站里）就跳过建记忆、把提议标回 committed，记忆不被恢复。」：成立，低。已改：keep 发现同号记忆不是 active 或 archived 时报 MCP_PROPOSAL_MEMORY_REMOVED，不再标为已保存。
- **gl-6**（glm-5.3-flash）「`respond` 逐条的成败计数在控制层被丢弃。」：同 ds-6，放到 PR A2。
- **gl-7**（glm-5.3-flash）「`key`（sourceKey）不做机器密钥扫描，且明文入库。」：成立，低。已改：key 也扫机器密钥，命中回 secret；提示词文字同步改为「正文或 key」。新用例覆盖。
- **gl-8**（glm-5.3-flash）「`subject_ref` 直接存 Access 凭证主体，代码端不校验长度，超 128 字符会让整次提议以通用 FAILED 收场。」：成立，低（Access 校验器给的是 sha256: 加 64 位，正常到不了）。已改：超过 128 字或为空时存它的 sha256 摘要。新用例覆盖。
- **gl-9**（glm-5.3-flash）「提议已存但「pending」账本行可能永久缺失。」：成立，低。已改：重发命中仍是待确认的行时补写（appendOnce 按编号去重）。

另外按 deepseek 必答问题 3 的建议，补了 memory.external.respond 约定的四条反向用例（拒绝带改过的正文、同一批重复编号、0 条、501 条）。
