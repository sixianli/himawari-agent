# 计划：background-commands

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- BG-1 迁移 0059 加 run_background_holds 表；sqlite 加 park 事务（提交本轮回答、turn 写上提交时间、轮次保持 running、登记命令、租约不放）和 finishParked 事务（确认资源已放、登记写结果、轮次 completed、放租约、开系统通知新一轮）；listClaimable 不再让回答已写进对话的更早轮次挡住后面的轮次，排队和对账都跳过有未放登记的轮次；证据：持久层测试标 [BG-1]。
- BG-2 Pi 适配器去掉等待循环，答完带着后台任务清单返回；后台命令不再跟 Pi 会话的取消信号走，期限改成自己的上限；协调者见到后台任务就 park 不 stopRun；调度器把 park 当已结束并把租约续期交给后台命令；证据：适配器和协调者测试标 [BG-2]。
- BG-3 命令结束时一次事务：放掉登记、停沙箱环境、轮次转 completed、admitSystemNotice 开新一轮（external_event 触发 + system 消息 + turn）；completeRun 对 external_event 接受 system 消息；唤醒调度器；证据：集成测试标 [BG-3]。

## 之后

- BG-4 启动时把没放掉的登记标成 interrupted，停环境，轮次完成并只写一条 system 说明（不调模型）。
- BG-5 契约加 background 状态和 stop 动作，网页回答下方一行、结束说明行样式、等待期间可发送，三语文案。
- BG-6 ADR 0098 改写（引 G1 原话）、案例 33、BL-20261027-012 关闭、check/build。

## 计划改动记录

- 2026-10-27 06:51 建立任务。

- 2026-10-27 07:20 改用“轮次保持 running + 登记表”：runs.status 的 CHECK 约束改不了（SQLite 要重建 runs 表，32 张表外键指向它，历来没重建过）；轮次保持 running 时所有执行许可检查原样有效，只需改排队、对账和收尾。BG-1 内容随之改写。

## 意外和发现

## 决定

- 2026-10-27 不新增轮次状态，轮次在后台命令期间保持 running，用 run_background_holds 表标记“已回答、只剩后台命令”。执行许可（回执、租约、assertRunActive、工作进程 250 ms 复核）一律不放宽；后台命令的最长时间受轮次期限 runMs 约束，上线时由 Andy 选的上限决定 runMs。

- 2026-10-27 不用“轮次标 completed 但另记一把锁”的做法：completed 在 SQL 里是“资源已全部放掉”的保证（completeRun、listLeftovers、恢复和到期结算都靠它），要开十几处例外。改用非终结状态 background_waiting，现有排队和清理逻辑天然跳过它。
- 2026-10-27 重启打断只写说明不调模型：不排队、不花 token，说明里讲清结果未知、重跑前先看有没有副作用。
- 2026-10-27 最终实现以 07:20 的改动记录为准：轮次保持 running + run_background_holds 登记表，没有用 background_waiting 状态。
- 2026-10-27 重启打断也另起一轮让模型告诉用户结果没拿到（不再“只写说明不调模型”）：和正常结束走同一条路径，Andy 要的是跑完一定有汇报，代价是一次模型调用。
- 2026-10-27 网页停止按钮沿用 thread.run.cancel，服务端先交给看守者只停后台命令，再照常另起一轮说明。
- 2026-10-28 PR #64 先合进 main 并占用 ADR 0097，本任务的 ADR 改号为 0098；案例 33 在 main 上仍空着（#64 用了 34），保持 33。
- 2026-10-28 Andy 要求“现在脱钩”：每条 bash 命令开始时存下“开始 + backgroundCommandMs”作为自己的截止时间，句柄、计划、结果恢复都用它；沙箱环境期限为首次截止时间 + backgroundCommandMs；到期结算放行 bash 计划的更晚期限。runMs 保持 5 分钟，上线不再改 runMs。
