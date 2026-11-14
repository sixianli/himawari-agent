# PR 498 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中：删除“被结果表引用的种类”不会被拦截，外键关闭时会留下孤儿结果行。迁移 sql 原 decision_ledger_kinds_in_use_no_delete 只查账本；已加 OR EXISTS 查结果表并补反向测试；触发：外键关闭的连接上手工 DELETE 一个只有结果行引用、还没有账本行的种类；后果：留下孤儿结果行，foreign_check 不再为空；产品连接外键开启，外键会拦下，只有故意构造才触发；判低理由：产品连接 foreign_keys=ON（migration-engine.ts 的 openQualifiedDatabase），正常使用不会触发，只有绕过外键的手工删除才会
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：参照表没有 UPDATE 守卫，外键关闭时改名会静默改坏已有账本行。迁移 sql 原来只有 DELETE 守卫；已加两个 BEFORE UPDATE 守卫并补反向测试；触发：外键关闭的连接上手工 UPDATE 被引用的参照表行；后果：已有账本行指向旧值，foreign_key_check 报错；产品连接外键开启时被拦下
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低：作者说明与代码不一致，容易误导后续维护者。材料说明与代码事实有出入（旧测试改动范围、外键在产品连接上开启），只影响复核材料文字，不影响迁移代码或运行
