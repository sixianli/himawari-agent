# PR 640 复核材料

ADR 0286 第 2 步后半：开局附一次记忆清单（取代主人档案块），之后每轮在最后一条消息里只附“记忆变化”。

作者说法：
1. OwnerProfileService.compose 不再产出 owner-profile 块，改为 memory-snapshot 块；清单只含主人可见、未关闭、未被取代、未过期、非规则类的记忆，待确认的单列；字数上限 snapshotCharacterBudget（窗口 10%），超出时按重要程度、最近更新、编号保留，并在“你还能查到的”里写各类省略了几条。
2. runtime-pi 的 splitMemorySnapshot 只在本对话上次 compactionSummary / branchSummary 之后的历史里找不到清单时才附清单；找到时只用新旧清单文本比出“记忆变化”，放在最后一条消息里，不改已发出的内容。只认 <himawari-context> 开头的用户消息和 himawari.memory-snapshot 自定义消息里的清单，主人在 owner-message 里打的同样文字不算。
3. 新清单有“因篇幅没有列出”行时，不报“已不再有效”，避免把省略误报为失效。
4. 运行中压缩后，memorySnapshotAfterCompaction 补发一次清单（steer 自定义消息），已补发过不再补。
5. conversationTurn.span 只统计 allowedClassifications 允许的级别，同一 owner 和 agent。
6. 请求开头只追加：清单附上后冻结，会变的“记忆变化”只在最后一条消息；系统提示（chat.ts identity）的改动是按对话冻结的系统提示的新版本，旧对话的系统提示不变吗？请核对系统提示是否按对话冻结。

请重点看：记忆变化的比对（entries 解析编号、类别），压缩/分支摘要后的重发逻辑，以及清单字数预算计算。
