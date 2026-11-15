# PR 546 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1. 高：跳过全部成对检查后，晚合的小编号迁移可能静默失效，出包检查却通过。出包时待上线迁移就是按 id 顺序在生产上执行，生产顺序与全新库顺序都是 id 序（compareOrders 与函数末尾 production 对 fresh 检查仍在，analyze.mjs:298-310）；成对检查是为 PR 上还没合并、顺序未定的迁移设计的，PR 路径（sequential=false）未变。模型的例子里小编号迁移在生产和全新库都先执行，行为一致，没有可达的出包后不一致输入。
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 中：前一个待上线迁移失败后，下一步在 try 外重放它并抛未捕获异常。读代码证实；已改成 sequential 下首个失败后 break，并新增用例（撤掉修复后失败）；触发：待上线迁移里某个失败的后面还有别的迁移时，下一步 cloneFrom(stepBase) 在 try 外重放失败迁移（analyze.mjs:197-199）；后果：抛未捕获异常而非返回 MIGRATION_FAILS；仍拒绝出包，只是诊断变成堆栈；判低理由：只在出包检查已经要拒绝的情况下触发，结果仍是失败关闭，不丢数据不放行
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 中低：新增的反向用例没有真正守住 sequential 路径。原用例确实先被 compareOrders 的 FULL_REPLAY_FAILS 拦下，不区分 sequential；生产逻辑无错。第 2 条的新用例直接断言 analyzeMigrations({sequential:true}) 并含后续合法迁移，已覆盖该路径。
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低：`touched` 在 sequential 下完全没用，`written` 只用于最后的数据比较；每步还重复回放整段前缀。touched 在 sequential 下无用、前缀回放两遍，属效率写法问题，结果正确；紧急修复要求改动最小，不采纳。
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低：作者说明和文档与代码不一致，且新的“批内改动必须声明”没有写进文档。31/14 是作者说明里的口径问题，不在仓库文件里；ADR 0265 未提 sequential 属文档补充，不影响出包行为，可由 Andy 决定是否另补。
