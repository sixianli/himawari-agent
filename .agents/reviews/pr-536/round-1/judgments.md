# PR 536 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 低：Chromium 策略只验证步骤存在，不验证顺序或条件，门槛可被绕过。scripts/ci/check-policy.mjs 原来只用 some 判断存在；已改成要求安装步骤在 scripts/ci/run.mjs 那一步之前且没有 if（continue-on-error 原有检查已拦，报 Step can hide failure）；test/tooling/policy.test.mjs 加“挪到检查之后”“带条件”两条反向用例，950 条通过；触发：以后有人把安装 Chromium 的一步挪到检查之后或加上 if；后果：策略检查不报，tooling 作业又在没有浏览器时跑测试
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：ARM 准备 Runbook 仍只写 static 需要 Chromium，改动后 tooling 也需要，文档与代码不一致。docs/runbooks/ci-vps-runner-runbook.md:186 已补上 tooling 的 Safari 面板测试和新步骤名；触发：有人照 Runbook 判断哪些检查需要 Chromium 系统库；后果：以为只有 static 需要，删库时漏掉 tooling
