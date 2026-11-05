# 计划：hermes-runner

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- HR-4：部署前先留一份 Hermes 服务、端口、磁盘的只读快照，部署后再取一份对比；证据：两份快照加 Claude 审核
- HR-8：写暂停开关脚本并在 Hermes 上演示暂停时 job 排队、恢复后继续；证据：演示记录加 Claude 审核
- HR-1：用户运行 root 安装脚本，runner 注册并在线；证据：GitHub 接口显示 hermes-home 在线空闲

## 之后

- HR-9
- HR-7
- HR-6
- HR-2
- HR-3
- HR-5

## 计划改动记录

- 2026-11-04 00:46 建立任务。
- 2026-11-04 00:47 补记 G2 至 G6，建立 HR-1 至 HR-9；G1、G5、G6 记为 durable，由 HR-7 的新 ADR 承接；G3 的只运行在 Linux 由用户另起的线程写 ADR，本任务只取移除 macOS job 的范围。
- 2026-11-04 09:29 用户在 G8 推翻 G3：以后还会在 macOS 上运行。HR-6 里移除 macOS job 的做法（G4）暂停，等用户重新决定 macOS 的两个 job 怎么处理；HR-6 的 done_when 不变。
- 2026-11-04 09:35 G9：macOS 两个 job 保留定义但暂不运行，ci/required 暂时只要求 Linux job；HR-6 按此做。G9 记为 durable，HR-7 的 goal_ref 加 G9，done_when 不变（ADR 正文要写明 macOS job 暂停及恢复条件）。G10 批准临时 sudo 60 分钟。
- 2026-11-04 09:35 更正上一条：HR-7 的 done_when 要改，doc 检查的 quotes 加 G9，否则长期决定 G9 没有文档承接。
- 2026-11-04 09:56 HR-1 的 done_when 里 command 检查的 host 由 mac 改为 MacBookAir，与长任务脚本记录的本机名一致，否则证据记不进去。
- 2026-11-04 10:17 合入最新 main 后 ADR 编号 0154、0155 已被占用，HR-7 的 done_when 里文档路径改为 docs/adr/0156-self-hosted-runner-on-hermes.md。
- 2026-11-04 10:33 G11：用户选 A，HR-6 在 resolvePolicySource 加一段只认当前旧写法的策略升级，macOS 成员用 paused 标记；G11 记为 once（实现细节，ADR 0156 里写明）。done_when 不变。

## 意外和发现

- 2026-11-04 ADR 0092 已在 2026-10-27 比较并放弃 Hermes 自托管 runner，理由是与受保护第 3、4 层测试抢资源；规则集也不要求 ci/required。已向用户报告，用户回复按条件继续（G6）。

## 决定

- 2026-11-04 Hermes 22.04 判定 ci/required；根盘加 8 GB 底线钩子；批准在验收 PR 推送前打开 Actions 总开关，打开前再向用户确认一次（G5）。
