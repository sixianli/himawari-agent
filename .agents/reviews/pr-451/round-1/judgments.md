# PR 451 第 1 轮复核：逐条判断

复核的提交 1338704f1（基线 856179978），只用 DeepSeek（Andy 2026-11-12 定默认只用 DeepSeek；用的是 PR 448 分支上的脚本），花费 0.18 美元，累计 0.18 美元。

- **R1-1** 会出错（中、高）：「中高：来历入口检查只覆盖提醒/规则/设备动作，其他有后果的工具完全不经过它」。部分成立。详细设计新值清单写的是“所有有后果的工具入口”，代码只管建提醒、取消提醒、改规则、非读取的设备动作，文档和代码对不上。把所有有后果的工具收到同一个出口是 /mnt/project-files/owner-scope-approval/integrated-plan.md（Andy 2026-11-12 定稿选 A）第 1、2 步的事，那份方案还写明在已授权工作目录里读写文件、跑命令不变；苹果端设计线程 2026-11-12 明确要求这一批不要再往按一轮记的标记上加东西。所以这一轮不扩范围，改的是文档：计划文档“第 5 批的任务”写明这一批只管四种动作、其余由那份方案接手。

- **R1-2** 会出错（中、高）：「中：`perception` 类型出处没有检查“记录是否存在”，与作者说法第 5 条和计划不符」。成立。保存记忆的同一个事务里，新增的 perception 出处要求同一主人、同一 Agent 下有这条 active 的感知记录，否则 PORT_INVALID_OPERATION；已经记过的出处（记忆更新时重存）不再查，免得记录后来被删导致记忆改不了。测试「stores perception sources with their type…」加了格式正确但不存在的编号；临时把检查换成恒假后实际运行，这条用例失败。

- **R1-3** 会出错（低）：「中：重抽/重试会把同一条提议重复交给提议入口（作者说法第 3 条后半不成立）」。部分成立：我在材料里写的“不会重复写入”说得不准。实际是提议编号由经历、引用和记录编号算出来，重抽时编号相同，入口按编号去重；生产里入口还没接，接入口的方案（proposed-actions-plan.md 的 proposal_observations）按来源种类、来源编号去重。判低：触发后不会多出记录，只是入口多收一次同编号的提议。新测试「hands over the same proposal id and writes no second ledger row when an episode is extracted again」固定这个行为：两次交出的编号相同、proposal 决策记录 1 行、记忆 1 条。模型给的严重度是中，我判低的理由是现在没有任何消费方会因此出错。

- **R1-4** 会出错（中、高）：「中：生产里后台被拦下的“想做的事”其实被丢弃，账本里也恢复不出来」。成立的是说明文字不实。提议入口生产里先不接是 PR 描述里写明的范围（入口表由提议的编码线程建；权限审批方案也写“它落地之前，后台这种情况只拒绝并记决策记录”）。改法：给模型的固定说明改成“这次被拦下已经写进决策记录，主人以后能看到”，不再说留给主人决定；计划文档写明动作名和参数要等入口接上才保存。提示词清单已重新生成。

- **R1-5** 会出错（中、高）：「中低：等待预算的日子会消耗重试次数，长期卡预算后一次普通模型错误就直接判 failed」。成立。重新开始抽取时，上一次状态是 waiting_budget 的不再给 attempts 加一。新测试「does not count days spent waiting for the cost limit as failed attempts」：上限 2 次、连续 3 天卡预算后模型出错，结果是 retry、attempts 为 1；临时改回原来的写法后实际运行，这条用例失败。

- **R1-6** 会出错（低）：「低：`device_action` 的 `confirm` 标记只展示、不执行，和固定工具文字“会先请主人确认”不一致」。成立。改成默认拒绝：confirm 为真的动作，没有接确认入口或确认入口没有返回同意时，不执行并返回 DEVICE_ACTION_UNAVAILABLE。新测试「does not carry out an action that needs the owner's confirmation when nothing can ask for it」。

- **R1-7** 会出错（低）：「低：数据导入路径不校验 `memory_provenance.source_type`，可以重新引入未登记类型和指向不存在感知记录的出处」。成立。导入时类型没登记或 perception 编号格式不对就以 DATA_IMPORT_LINE_INVALID 拒绝整次导入；perception 出处一律标成“出处已删”，因为导入不恢复感知记录。类型清单和编号格式挪到 memory-source-types.ts，写入和导入共用。新测试「import refuses an unregistered memory source type and marks perception sources as gone」。

- **R1-8** 会出错（低）：「低（边界情况，部分推测）：超大经历会让 `commandUtterances` 超过 5000 上限，整段抽取失败」。成立。改成每 1000 个编号查一次。没有单独加测试：造 5000 条以上记录的集成用例太慢，现有的口头指令用例走的是同一段代码。

- **R1-9** 会出错（低）：「低（推测）：`perception_read` 在无 query 时即使已满额也会扫完整个时间范围；抽取则把整段记录和全文一次读入内存」。读工具那一半成立。新配置 readMaximumScanned（默认 5000，可配 500 到 200000）：一次调用最多看这么多条，没看的条数如实告诉模型。新测试「stops looking after the configured number of records and says how many it did not look at」。抽取把整段读入内存那一半不改：一段经历最长由 episodeMaximumSeconds（默认 1 小时）限定，记录数由每日记录上限限定，分块发给模型前本来就要排好序。

- **R1-10** 会出错（低）：「一个小的跨环境不确定性」。成立。toLocaleLowerCase 改成 toLowerCase。

- **R1-11** 不成立：「生产未注入 `ownerVoiceQualified`」。不成立，是预期状态。详细设计写明主人声音达标前所有听到的话都算 other；达标判断由后面的批次接。production-http-composition.ts 不传这个选项、默认 false 正是这个状态。

- **R1-12** 不成立：「作者说法第 2 条“引用必须在遮盖后或原文里逐字出现”与代码不一致」。代码没有问题：perception-extraction.ts 的 quotedSource 要求遮盖后的文字和原文里都逐字出现，比我在复核材料里写的更严。写错的是复核材料那一句，材料不是项目文档；计划文档第 8 条写的是“能在原文里逐字找到”，和代码一致。

- **R1-13** 会出错（低）：「测试位置和规格不一致」。成立。详细设计里三处文件名改成实际的 test/integration/perception-tools.test.ts。

- **R1-14** 不成立：「`perception-source-prompts.ts` 的五个来源检查和看图函数在生产没有调用点」。不成立，是预期范围。计划文档第 2 条要求提示词文字在这一批一次写全（同一次发布的硬性要求），来源检查和看图的调用在后面的批次接；apps/agent-service/test/prompt-output-contracts.unit.test.ts 已经登记了它们的解析器。

- **R1-15** 不成立：「如果这一步抛错，命令已被接受却返回失败」。不成立。device-api-routes.ts 里记口头指令编号排在对话入口接受之后；这一步失败时设备会用同一个 messageId 重试，对话入口按 messageId 幂等、不会重复执行，重试时再记一次编号。反过来先记编号再发消息，消息没被接受时这句话会被抽取白白跳过，更糟。

- **R1-16** 可以更好：「`[iOS-5]` 的结构测试使用的是测试里手写的假工具定义和假 `modelContent`」。可以更好，不改。这 4 条用例检查的是请求体的结构（感知内容出现在哪一条消息、什么角色），和工具定义的文字无关；真实定义不随设备变化由 test/integration/perception-tools.test.ts「lists devices and actions…」用真实的 perceptionToolDescriptors() 前后比对。把真实定义接进结构用例只改测试的写法，不改变任何被检查的行为。
