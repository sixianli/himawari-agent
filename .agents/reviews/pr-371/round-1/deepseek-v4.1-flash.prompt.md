你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 36ee0d2ba3c2ad8dcac0f6e2b425c191f7fc27e3。
对比基准是 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f，先运行 git diff aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f..36ee0d2ba3c2ad8dcac0f6e2b425c191f7fc27e3 看改动。
作者的说法（可能有错，请核对）：
# P4-6 每周记忆体检：代码复核材料

## 问题和目标

Andy 要求：每周列出四类记忆，在“每天打分”页面多一组，一键“确认 / 删除 / 合并”：
1. 互相矛盾的两条（来源是 P3-8 的“待确认”记录，P3-8 尚未合并，本 PR 里先返回空列表）；
2. 很久没被用到的（`lastUsedAt ?? recordedAt ?? updatedAt` 早于 N 天，N 由配置 `reviewMemoryUnusedDays` 决定，默认 90）；
3. 置信度低的（低于自动记忆的默认置信度 850‰）；
4. 来源找不到的（沿用 P1-1 的 `memorySourceState` 判为 `unavailable`）。

完成标准：每周能生成清单；三种动作写进数据库并能撤销；一轮处理受每天打分的时间预算限制（有测试）。

## 本 PR 的范围（草稿）

- 数据表（迁移、表目录条目、两份真表测试）按改表排队规则暂不提交，等协调者放行迁移号后再补到本 PR。所以本 PR 当前提交里的 SQLite 操作类 `sqlite-memory-checkup-operations.ts` 已接线，但表还不存在。请把“表不存在时会怎样”当作已知状态，不必报；但请检查操作类的 SQL 本身是否正确。
- 预留的表结构（将来迁移的内容）：`memory_checkup_items(id, owner_id, agent_id, week_start, memory_id FK→memory_records ON DELETE CASCADE, related_memory_id FK ON DELETE SET NULL, reason CHECK 四选一, action CHECK confirm/delete/merge 可空, kept_memory_id FK SET NULL, before_state json_valid 可空, handled_at, undone_at, created_at)`，CHECK：action、handled_at、before_state 三者同为空或同不为空；`related_memory_id IS NULL OR reason='conflict'`；UNIQUE(owner_id, agent_id, week_start, memory_id)。

## 作者的说法（请核对，不要直接相信）

- 每天的预算：服务端只接受“今天展示出来的选中项”里的体检条目动作（`production-proactive.ts` 的 `proactive.review.checkup` 分支），其余返回 `PROACTIVE_REVIEW_BUDGET_USED`；撤销总是允许、不释放名额。今天已处理的条目仍占名额（沿用 `selectDailyReview` 的规则）。
- 确认：普通记忆确认后 84 天（12 周）内不再因非矛盾原因列出，不提高置信度；`tentative` 记忆调用 `memory.confirm`。
- 删除：进回收站（trash），撤销用 recover。
- 合并：`keep` 必须是这一对中的一条；另一条改为 archived，`supersededBy=keep`、`validTo=now`；若 keep 是 tentative 则确认它。撤销按 `before` 还原。合并不搬来源引用（ADR 0218 写明放弃）。
- 撤销：只能对已处理的条目，按 `before_state` 还原，清空 action。
- 打分命令 `proactive.review.rate` 拒绝体检条目的键；页面上“这一页都没问题”不包括体检条目。
- `memorySourceState` 从 control-center 挪到 gateway-contracts，以便服务端复用；control-center 重新导出，行为不变。

## 重点请看

- `packages/application/src/services/memory-checkup.ts`：挑选逻辑、动作与撤销的并发和失败路径（例如动作执行到一半记录失败、两个人同时点、撤销时记忆已被别处改过）。
- `apps/agent-service/src/production-proactive.ts`：预算判断是否可被绕过。
- `packages/gateway-contracts/src/contracts-v2.ts`：新消息类型的约束（merge 必须带 keep）。
- 网页 `apps/control-center/src/components/proactive-reminders.tsx`：按钮与命令对应是否正确。
- 本改动不碰发给对话模型的请求内容。

## 补充

- 网页里体检条目和打分条目放在同一个列表里分页（每页 6 条），这是为了满足 `npm run check:layout` 的“每天打分区不超过一屏、最多 6 行”。
- 应用层服务 `MemoryCheckupService` 的测试是真表集成测试，随数据表一起暂不提交；当前提交里网页有单元测试（`apps/control-center/test/proactive-interactions.unit.test.ts` 的 [P4-6] 用例）。缺测试本身不用报，但若发现某条逻辑错误，请指出触发方式。
