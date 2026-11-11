# PR 390 作者说明

问题：记忆整理变化记录里，每条未撤销的整理改动都显示「撤销」按钮。后端 `MemoryConsolidationService.undo` 只在记忆当前修订号等于整理时记下的 afterRevision 时才成功，记忆被用户改过后点击必报 MEMORY_CHANGED_AFTER_CONSOLIDATION。
目标：界面显示和实际能力一致，不让用户点到注定失败的按钮；不改表，不改发给模型的内容。
做法：memory-engine 新增 isConsolidationUndoable，undo 与概览查询共用；网关概览 tidyUps 增加 undoable 字段；网页在不可撤销时不显示按钮并说明原因。可以不局限于这个做法，若你认为更好（例如让撤销真的可用）请提出。
已核对：Layer-0 相关 27 个测试文件全过；typecheck、lint 通过。
