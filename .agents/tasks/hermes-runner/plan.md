# 计划：hermes-runner

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- HR-13：开搬迁 PR，打开 ci.yml，让完整 CI 在 VPS 上跑通；合并后打开 main.yml 看 main 确认通过；证据：两次运行的链接和 runner 名加 Claude 审核
- HR-15：CI 通过后、合并前，暂停并注销 Hermes 的两个 runner；证据：GitHub 上只剩 ci-vps-1、ci-vps-2 加 Claude 审核

## 之后

- HR-14
- HR-13
- HR-15
- HR-16
- HR-4
- HR-1
- HR-7
- HR-6
- HR-3
- HR-5
- HR-17

## 计划改动记录

- 2026-11-04 00:46 建立任务。
- 2026-11-04 00:47 补记 G2 至 G6，建立 HR-1 至 HR-9；G1、G5、G6 记为 durable，由 HR-7 的新 ADR 承接；G3 的只运行在 Linux 由用户另起的线程写 ADR，本任务只取移除 macOS job 的范围。
- 2026-11-04 09:29 用户在 G8 推翻 G3：以后还会在 macOS 上运行。HR-6 里移除 macOS job 的做法（G4）暂停，等用户重新决定 macOS 的两个 job 怎么处理；HR-6 的 done_when 不变。
- 2026-11-04 09:35 G9：macOS 两个 job 保留定义但暂不运行，ci/required 暂时只要求 Linux job；HR-6 按此做。G9 记为 durable，HR-7 的 goal_ref 加 G9，done_when 不变（ADR 正文要写明 macOS job 暂停及恢复条件）。G10 批准临时 sudo 60 分钟。
- 2026-11-04 09:35 更正上一条：HR-7 的 done_when 要改，doc 检查的 quotes 加 G9，否则长期决定 G9 没有文档承接。
- 2026-11-04 09:56 HR-1 的 done_when 里 command 检查的 host 由 mac 改为 MacBookAir，与长任务脚本记录的本机名一致，否则证据记不进去。
- 2026-11-04 10:17 合入最新 main 后 ADR 编号 0154、0155 已被占用，HR-7 的 done_when 里文档路径改为 docs/adr/0156-self-hosted-runner-on-hermes.md。
- 2026-11-04 10:33 G11：用户选 A，HR-6 在 resolvePolicySource 加一段只认当前旧写法的策略升级，macOS 成员用 paused 标记；G11 记为 once（实现细节，ADR 0156 里写明）。done_when 不变。

- 2026-11-06 23:52 补记 G17 至 G20。G17、G19 记为 once；G18、G20 记为 durable，由 HR-14 的新 ADR 承接。G20 决定 CI 搬到 OVH VPS、注销 Hermes runner，所以撤掉只对 Hermes 有意义的 HR-2、HR-8、HR-9，新增 HR-10 至 HR-16；当前批次改为 HR-10、HR-11、HR-12。另加 HR-17，核对长期决定 G12、G16 已由 ADR 0168、ADR 0170 原文承接。
- 2026-11-06 23:54 更正 HR-17 的 done_when：ADR 0168 把 G12 的两句话分在两个问题下引用，不是连续原文；改为由沿用这些时限的 ADR 0176 连续引用 G12。
- 2026-11-07 00:32 HR-10、HR-12 做完，当前批次换成 HR-13（开 PR 在 VPS 上跑完整 CI）和 HR-15（CI 通过后注销 Hermes 的 runner）。quality.yml（HR-16）照 ADR 0176 决定第 8 条另开 PR。
- 2026-11-07 00:40 G21：quality.yml 的 container 检查给第三个专用账号用 rootless Docker，记为 durable，由 HR-16 那个 PR 的 ADR 原文承接；HR-16 的 goal_ref 加 G21。
- 2026-11-07 19:30 合入 main 后 ADR 编号 0177 已被 gitleaks 精确值白名单占用（PR 275），HR-16 的 done_when 里文档路径改为 docs/adr/0178-quality-on-ci-vps.md。

## 意外和发现

- 2026-11-04 ADR 0092 已在 2026-10-27 比较并放弃 Hermes 自托管 runner，理由是与受保护第 3、4 层测试抢资源；规则集也不要求 ci/required。已向用户报告，用户回复按条件继续（G6）。

- 2026-11-07 安装回滚测试偶尔以 141 结束：假的 sha256sum 不读输入就退出，脚本里 `echo … | sha256sum -c -` 的 echo 被 SIGPIPE 打断。改成假命令先读完输入，同一用例在 Hermes 连跑 20 次 0 失败。

## 决定

- 2026-11-04 Hermes 22.04 判定 ci/required；根盘加 8 GB 底线钩子；批准在验收 PR 推送前打开 Actions 总开关，打开前再向用户确认一次（G5）。
