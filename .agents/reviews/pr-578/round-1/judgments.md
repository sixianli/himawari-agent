# PR 578 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1【中】步骤说明和 ADR 0086 仍宣称 S8 逐行比对，与代码相反。steps/README.md:77 和 docs/adr/0086...:51 原文仍写 S8 逐行比较，与 run-maintenance.mjs S8 只比两份停服读回不符；已改文字。；触发：操作者照 steps/README.md 第 77 行或 ADR 0086 第 51 行上线；后果：以为 S8 仍会拦住启动后老行被改，实际已不拦，会据此做错判断
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2【低】verify-fixtures 的输出 scope 仍声称 S8 逐行比对，证据自述失真。verify-fixtures.mjs:633 scope 含 S8 row-by-row；该文件已无 compareHistoryRows 调用；已删这句。；触发：读 verify-fixtures 输出 scope 的人；后果：产物自述声称检查了 S8 逐行比对，文字不准但不误导操作
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3【低】“S7 启动前再比一次”只比较两份已保存证据，不重新读生产库。S7-switch-start-readback.py:234-240 比较的是两份已保存的 s7 读回；已把 ADR 0279、P-readback-design.md、delivery-mode.md 的说法改为比较两份已保存的停服读回。；触发：读文档的人把“再比一次”当成新读库；后果：措辞不准但不误导：服务已停、只有 root 能写
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4【低】新增的“无开关”夹具测试与已有测试重复，不是反向用例。test_make_packet.py 原 622-627 与 580-587 渲染同样两个包并断言同样内容；已删重复用例和不再用的 history_fixtures 辅助函数，源码文本断言保留。；触发：维护测试的人；后果：重复用例，不影响运行结果
