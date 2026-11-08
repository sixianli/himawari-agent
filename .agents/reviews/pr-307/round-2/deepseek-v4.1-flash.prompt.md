你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 e1ec166a3965cec697f2f7ef770ee4725916fbf1。
对比基准是 ab4421d1a0fbfd497c4bfb7d1a0c8174fab72c19，先运行 git diff ab4421d1a0fbfd497c4bfb7d1a0c8174fab72c19..e1ec166a3965cec697f2f7ef770ee4725916fbf1 看改动。
上一轮复核到 d1b03b614d2b2b67083323276cf66aba626adcfb，先看 git diff d1b03b614d2b2b67083323276cf66aba626adcfb..e1ec166a3965cec697f2f7ef770ee4725916fbf1 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR #307 代码复核材料

分支 claude/project-thread-qlqysx，基准 origin/main 的 2995d535 之后的最新 main（用 git merge-base origin/main HEAD），复核提交 d1b03b61。

## 问题
2026-10-19 生产重启后进了新内核，服务停了约 51 小时、没有任何人知道。重启策略不改，缺的是告警。

## 做法
- scripts/operations/heartbeat/himawari-heartbeat.py：每分钟问本机 http://127.0.0.1:8400/health/ready（200 就绪，否则 503，见 packages/platform-node/src/http-gateway-server.ts:917）。200 就向 Healthchecks.io 专属网址发心跳（GET）；其他情况向「网址/fail」POST 一行原因。整台机器停了或定时任务不跑，由 Healthchecks.io 超时发警。
- install-heartbeat.sh：install（网址从标准输入读）、install --keep-url、remove [--purge]、status；装一个 systemd oneshot 单元和每分钟定时器，单元用 root 运行（要读 root 0600 的网址文件），加了 NoNewPrivileges、ProtectSystem=strict、ProtectHome、PrivateTmp、PrivateDevices、空 CapabilityBoundingSet、RestrictAddressFamilies=AF_INET AF_INET6。
- 专属网址只放生产机 /etc/himawari/healthcheck-url（root、0600）；脚本只接受 https://hc-ping.com/ 开头、字符集受限的网址。
- 不随上线包安装（Andy 选定）：告警要在上线失败、回滚、重启后仍在。
- 测试 scripts/operations/heartbeat/test_heartbeat.py（check:heartbeat）；运行手册 docs/runbooks/production-server-access-runbook.md「心跳告警」一节；docs/incidents-and-gates.md I-83 行。

## 约束
- 不写代码注释。安装到生产机要 Andy 同意，本 PR 不动生产。
- 在测试里网络用假的 opener，ready 探测走真实本机 HTTP 服务。

## 想请你重点看
- 失败信号该不该这样发：就绪不是 200（含超时、连接被拒）一律发 /fail；Healthchecks.io 收到 /fail 立刻告警。有没有会漏报（该告警没告警）或误报（服务正常却告警）的情况，例如服务启动期、重启期间每分钟都发 /fail 是否合理。
- 网址校验与泄露面：有没有办法让网址出现在日志、命令行或输出里；URL 文件被替换成别的主机能否把请求发往别处。
- systemd 单元的限制是否会让脚本在真实 Ubuntu 24.04 上跑不起来（ProtectSystem=strict 下读 /etc、RestrictAddressFamilies、空能力集下 root 读 0600 文件、-I 隔离模式下运行没有 .py 后缀的文件）。
- install-heartbeat.sh 的幂等、失败时是否会留下半装状态（例如网址文件已写但 enable 失败）。
- 这个改动会不会改变模型已经见过的请求开头（预期不会，只是运维脚本）。
