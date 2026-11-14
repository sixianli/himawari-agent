# PR 513 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高 · 并发/重放时 `OwnerIntentGate.confirm` 可能返回与持久记录相反的结果。owner-intent-gate.ts confirm/#record：冲突后返回本地 result.confirmed；已改为回读持久记录并以它为准，测试 race 在旧代码下失败；触发：两个同一意图的核对并发，后写者提交冲突被吞，返回自己的结果；后果：本次动作按 true 直接执行而持久记录是 false，且同 id 审计字段不同会再抛错
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中 · 反向规则例子没有覆盖 `owner_presence_required`、`disclosure`、`recipient_count`、非 `CREATE_OR_UPDATE`，删掉一个安全条件不会被测试发现。现在的表达式含这些条件且 ownerIntentEligible 也在入口拦截，没有错误输入；只是缺反向例子
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 中 · 核对端口把原始工具参数交给第二个模型，未做遮盖和大小上限；“没有工具结果”只对 `ownerWords` 成立。本批 service-main 未接线（未传 ownerIntent），没有适配器；ADR 本就写输入含动作参数，属第二批接线时的设计项
- 4（deepseek-v4.1-flash）不成立：### 4. 中/低 · 原话校验只是子串匹配，引用被否定的片段也能通过。owner-intent-answer.ts:56-60 按 ADR 0249 程序只校验原话逐字出自主人，语境（否定）由核对模型判，加否定词检查会违反“不写词表”规则
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低 · 已过期的意图仍会调用核对模型并写记录。owner-scope-authorization.ts:216-228 过期时多一次核对调用，结果仍是 denied，不放行也不出错，只是多花一次调用
- 6（deepseek-v4.1-flash）成立，可以更好：### 6. 低 · 失败答案里的 `verdict`/`confidence` 未经过严格解析就写进状态。owner-intent-gate.ts:153-163 只在 confirmed 为 false 时存未校验字段，不影响放行，只是记录里留了模型原值
