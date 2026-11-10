# PR 338 第 1 轮复核判断

两个模型都指出的中等问题只有一个：规则、ADR 0198 决定 7 和案例 86 说已有“打开 Pi 自动重试后会失败”的反向用例，仓库里其实没有。适配器把重试写死为关闭，没有从外面打开的入口；实施时是手动改设置验证的。已把三处改成如实描述：提交的用例证明 503 后同一轮不再发第二次请求，打开重试会让它失败这一点是手动验证的。

## 会出错（已修）

- r1-ds-1 / r1-glm-1（中）：文档措辞改为如实描述，见上。
- r1-ds-3 / r1-glm-2（模型判中、中低，线程判低）：`PI_REQUEST_TOOLS_DIVERGED` 补了端到端用例：冻结的工具名和 Pi 能执行的不一致时，回环服务一条请求都收不到，轮次失败。临时去掉检查后用例失败（收到 1 条请求）。
- r1-ds-2 / r1-glm-3（低）：`json-tool-arguments.unit.test.ts`，16 条用例。
- r1-ds-4（低）：`withoutRemovedDependencies` 直接单测，覆盖 advisory、published-synthetic-fixture 和保留 synthetic-secret。
- r1-ds-5（低）：`docs/architecture-v0.1.md` 的版本改成 1.5.0。
- r1-ds-6（低）：规则第 4 条写明“Himawari 关着自动重试，所以只和压缩一起发生”。
- r1-ds-7（低）：捕获时比较条目重建出的消息和内存里的消息（都去掉 system），不一致就拒绝保存（`PI_CONTINUATION_PREFIX_INVALID`），加了单测。
- r1-glm-5（低）：审批续跑的 compat 用例加了逐字节比较：续跑请求的开头和挂起前的请求逐字节相同。

## 可以更好（不改，列给 Andy）

- r1-ds-8：安全例外的 sha256 仍按 base 原文件算，过滤后的子集没有单独的哈希。
- r1-ds-9：每次捕获都多次整段克隆和重建会话。
- r1-glm-4：恢复扫描遇到 v2 快照跳过这一步没有扫描层的用例；`inspectPiToolBatch` 对 v2 返回 undefined 有单测。

## 不成立

- r1-ds-10：丢掉 Pi 加的全部 system 消息是 ADR 0198 决定 2 的设计，系统提示和工具由冻结的那份重新生成。
- r1-glm-6：删除注释是项目规则的要求。
