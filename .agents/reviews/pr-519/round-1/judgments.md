# PR 519 第 1 轮判断（deepseek-v4.1-flash）

- R1-1（deepseek-v4.1-flash）成立，会出错，中高：1. 高：按 episode 删除不受计划时刻限制，会删掉计划之后收到的记录（轨迹点同理）。成立。episode 目标现在也加 received_at_ms <= 计划时刻；新测试「keeps a record added to an episode after the plan」。；触发：episode 删除不带计划时刻上限；后果：计划之后收到、已并入同一经历的记录被一起删
- R1-2（deepseek-v4.1-flash）成立，会出错，中高：2. 高/中：按天/类型删除按 `received_at` 选记录，但抑制按 `occurred_at` 判断，删除可被重传复活。成立。删除范围现在存下所有被删记录的编号，入库时按编号一律挡下（不只按发生时间）；反向测试沿用「refuses to take back deleted records」。；触发：记录在计划前收到但发生时间晚于计划时刻（设备时钟偏差）；后果：被删记录重发后因编号已不在库里而复活
- R1-3（deepseek-v4.1-flash）成立，会出错，中高：3. 中：payload 删除失败被静默吞掉，`verified` 回执可能不真实；文件删除在事务之外。成立。去掉 try/catch，错误向外抛，这一块整体回滚、删除保持 running 待续做；文件在事务外删的窗口：perception 正文是 sqlite_blob，文件型只在大正文出现，接受。；触发：删 payload 时数据库报错；后果：错误被吞掉，回执仍可能 verified 而正文还在
- R1-4（deepseek-v4.1-flash）成立，可以更好：4. 中：媒体关联跨设备复用且 `recordIds` 不校验归属，可能删掉另一台设备仍在使用的原始文件。不改。关联只在同一主人名下，设备之间共用一个主人，删除只在“所有关联记录都已被删”时才删文件；校验记录编号属于哪台设备会误伤还没入库的编号。
- R1-5（deepseek-v4.1-flash）成立，会出错，中高：5. 中（可达性为推测）：`remaining` 非空时仍返回 `progressed: true`，续做可能死循环并卡住启动。成立（推测可达）。progressed 现在只在本块处理了条目或状态变成 verified 时为 true。；触发：待清列表为空但仍有匹配记录；后果：progressed 恒为 true，续做死循环
- R1-6（deepseek-v4.1-flash）成立，会出错，中高：6. 中/低：删除 feed 的 `revision` 是全局最大值而不是本页最后一条，分页可能跳条。成立。路由 revision 现在是本页最后一条的编号，另给 latest；新测试「reports the last revision of a page」。；触发：设备读第一页后用返回的 revision 当 after；后果：revision 是全局最大值，跳过后面的页
- R1-7（deepseek-v4.1-flash）成立，会出错，低：7. 低：形如 `2026-02-30` 的日期会抛 `RangeError`（500）而不是参数错误（400）。成立但低。现在先判 NaN 再比较，走 PERCEPTION_DELETION_INVALID；测试覆盖 2026-02-30 和 2026-13-40。；触发：day 为 2026-13-40；后果：Date 解析得 Invalid Date，toISOString 抛 RangeError 变成 500 而不是 400 类错误
- R1-8（deepseek-v4.1-flash）成立，可以更好：8. 低：`perception.deletion.plan` 是 query 层却写数据库，过期计划/删除范围没有清理上限。不改成非 query。plan 写库是方案定的形态（先看影响再删），已在 prune 里清掉过期未执行的计划。依据：计划行小，prune 每小时跑。
- R1-9（deepseek-v4.1-flash）成立，可以更好：9. 低：轨迹点被删除范围抑制时计入 `duplicates`，与记录路径的 `suppressed_by_deletion` 语义不一致。不改。轨迹点没有“新结果”字段，设备不重试的语义相同；响应形状不变更稳。
- R1-10（deepseek-v4.1-flash）成立，可以更好：10. 低：`ci/operations-pending.json` 的三个新描述是复制来的，与 PR 说明不一致。已改：三条操作的说明改成删除专用文字。
