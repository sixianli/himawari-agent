# PR 431 第 3 轮逐条判断（DeepSeek）

1. 中：候选同时放宽扫描规则并删台账条目，原来会红的检查会变绿。不成立。依据：扫描规则 `findBuildSecrets` 本来就是候选分支的代码，`createPublishedFixtureReview.inspect` 对台账之外的成员只看候选扫描规则给出的命中（`scripts/ci/security-published-fixtures.mjs` 里 `if (!entry) { assert(findings.length === 0, ...) }`），改前改后都一样。构建归档里绝大多数成员不在台账里（台账现在 79 条），所以改前一个放宽扫描规则的 PR 对这些成员同样能通过，台账从来不是扫描规则强度的保护。这道防线靠的是对扫描规则改动本身的代码复核，删台账条目在 diff 里同样看得见。改前那 79 条的作用只是让 PR 和合并提交红一次，正是本 PR 要去掉的情况。这个取舍写进交付报告，给 Andy 看。
2. 低：设计文档写“候选不能替换例外、命中集合变化须重新审阅”，和撤掉例外不一致。成立，会出错，低。触发：后来的人照文档以为候选什么都不能改；后果：误判检查行为。已在 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md` 写明：候选只能撤掉 published-synthetic-fixture 条目，不能新增或修改，被撤掉的成员仍有命中就失败。
3. 低：base 台账结构错误时先抛 TypeError，诊断码退化。成立，会出错，低。触发：base 台账的 exceptions 不是数组而候选正常；后果：报 SECURITY_EXECUTION_FAILED 而不是 SECURITY_EXCEPTION_SCHEMA_INVALID。已改为先校验再计算，用校验后的数组。新增用例“base台账结构错误时报受控错误码”；用改前代码跑失败（已运行）。
4. 低：边界用例不全。成立，会出错，低。补了“候选把例外改到别的路径”（原路径和新路径都按没有例外处理）、“初始化时没有可撤掉的例外”。owner 清单同路径和候选解析失败两种情况，代码在计算撤掉列表之前就已失败（`SECURITY_EXCEPTION_DUPLICATE`、候选先校验），模型自己也核对过，不另加用例。
5. 提示：全大写、无数字的值仍会放过。成立，会出错，低，和第 2 轮 r2-4 相同。和 gitleaks 默认配置的取舍一样，不再改。
