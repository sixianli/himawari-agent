# 第 1 轮（提交 29acb405）线程逐条判断

分类由线程做。“会出错”的严重度和模型自己给的并列。

## DeepSeek
- r1-ds-1 回放写真实敏感拦截表：成立，会出错，中高。依据：`production-proactive.ts` 把 onMasked 传给回放，`proactive-mail-check-service.ts` 的 `#reportMasked` 调它，`service-main.ts` 里它接 `mailEgress.reportMasked` 写真实表。已改：回放不传 onMasked；反向测试用带银行卡号的历史邮件走回放命令，onMasked 零调用，恢复旧写法时 3 条命中、用例失败（已实际运行）。
- r1-ds-2 不按 receivedAt 排序：不成立。预算停止时记 BUDGET_REACHED，已判断的每封结果都正确；Gmail 列表本来就是新到旧，回放是取样，不依赖顺序；没有错误结果可构造。
- r1-ds-3 recordResult 抛错时封存文字没释放：成立，中高。依据：`#execute` 原先只处理返回 false。已改：抛错时先释放再抛；测试断言释放并记 REPLAY_ERROR。
- r1-ds-4 stop() 不等回放：成立，中高。已改：cancel() 让回放在下一封前停下并标 interrupted；用例覆盖。
- r1-ds-5 回放没接 memory：不成立。方案（plan.md 第 14 节）明定回放关记忆，以免用今天的记忆去判过去的邮件；PR 说明已写。
- r1-ds-6 单条删除只返回 refs：成立，低（模型也判低）。触发：将来界面直接调 store.deleteRun。已改：服务层 deleteRun 先删行再释放；测试断言封存文字真的没了。
- r1-ds-7 asOf 说法不准：成立，低。asOf 的确也流向 fetch.since 与 costSince，回放里被假读取器和隔离 store 抵消。已改：PR 说明更正。
- r1-ds-8 没做范围后置过滤：成立，低。已改：丢弃范围外邮件，测试覆盖。

## GLM
- r1-glm-1 遮盖事件写真实表：同 r1-ds-1。
- r1-glm-2 deleteRun 无生产入口：成立，低（模型写“中低”，线程判低：只是文字与现状不符，没有错误结果）。已改：schema-catalog 的删除说明写成“主人清空主动记录或断开邮箱时删除；单条删除尚未对主人开放”。
- r1-glm-3 skipReason 为空的耦合：不成立。现在唯一的跳过点固定传 "category"（`#skip(item, "category")`），没有可达输入。
- r1-glm-4 404 邮件静默丢弃：不成立。run 记录里 listed 与 judged 之差可见，没有错误结果。
- r1-glm-5 两套停止规则：不成立。源不可用与模型失败本来就是两件事，行为合理。
- r1-glm-6 npm run check 失败无法验证：不成立。我在没有本改动的 main 上跑过：check:security-review 同样 2 例失败；check:delivery-packet 报“浅克隆里缺历史提交”。
