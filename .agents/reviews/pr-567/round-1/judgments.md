# PR 567 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1（高）第 3 条把“夜间覆盖率”写成已经实现，仓库里没有这个定时任务。ADR 0267 第 83 行“第 2 步之前，覆盖率暂时没人统计”；ci/quality-policy.json 的 schedule enabled false。已改成第 2 步未做。；触发：读者照文档以为夜里已在量覆盖率；后果：以为覆盖率有人统计，实际没有
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2（高）第 2 条把 ADR 0266 的“立即切换”说成“试跑对得上才切”，还引用仓库里不存在的实测记录。ADR 0266 决定第 6 条“不再等 20 次试跑一致才切换”。已改写，试跑数字标未核实，删掉 1.5 到 2 倍。；触发：读者照文档以为 ADR 0266 有“试跑一致才切”的闸门；后果：按不存在的规则设计切换流程
- 3（deepseek-v4.1-flash）成立，会出错，中高：### 3（中）“2 GB 内存池”是旧值，当前汇总 runner 上限是 4 GB。docs/runbooks/ci-vps-runner-runbook.md:67 上限 4 GB。已改。；触发：按文档估算汇总作业可用内存；后果：低估一半内存
- 4（deepseek-v4.1-flash）成立，会出错，中高：### 4（中）第 6 条内部数字对不上：25 分钟 + 35 分钟 ≠ 46 分钟。25 分钟和 46 分钟属于 run 43675431801，35 分钟是错的（实为约 21 分钟）。已按两次运行分别写清，并新增 .agents/evidence/ci-runs-2026-11-15.md 归档作业时间。；触发：读者把 25、35、46 分钟相加；后果：数字自相矛盾
- 5（deepseek-v4.1-flash）成立，会出错，中高：### 5（中）把 integration 挪到 ARM 的计划缺两项关键前提：build 产物取不到、ARM 4 核已有超时。run-share.mjs get 只读本机；run.mjs 要求产物平台和本机一致。已列为三项前置工作。；触发：照计划直接把 integration 挪到 ARM；后果：tests 取不到产物、ARM 更挤
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6（低）“机器和作业现状”表漏了 main/evidence、main/confirmation、merge-queue。main.yml、merge-queue.yml 的 runs-on。已在表下注明。；触发：用表做容量计算；后果：漏算 main/evidence 和 merge-queue
- 7（deepseek-v4.1-flash）成立，会出错，低：### 7（低）I-93/I-95 的日期口径与事故清单不一致。已写成事发日和登记日两个日期。；触发：按事故清单日期核对；后果：日期对不上
