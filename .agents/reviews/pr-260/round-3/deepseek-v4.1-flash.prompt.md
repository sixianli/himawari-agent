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
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作。另一个复核者侧重别的方面，所以你仍要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 597047997f432c1f3409f9f31495409d088bc3e9。
对比基准是 a429ff078841802a812ad2db43d4da98f61d4aa2，先运行 git diff a429ff078841802a812ad2db43d4da98f61d4aa2..597047997f432c1f3409f9f31495409d088bc3e9 看改动。
上一轮复核到 57910cd0e4fadc4b4f863704a545b713ee331237，先看 git diff 57910cd0e4fadc4b4f863704a545b713ee331237..597047997f432c1f3409f9f31495409d088bc3e9 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 260 代码复核材料

范围：`git diff a429ff0..HEAD`（a429ff0 是合并 PR 259 后的 main）。

## 改了什么

1. `scripts/operations/hermes-runner/resume-runners.sh`：恢复 runner 的顺序改为“对账 → 加回 `hermes-home` 标签并回读确认（没加上就不启动服务）→ 在 Hermes 上启动服务 → 等 GitHub 显示 online”。原因：Hermes 上两次实测，先启动、上线后再加标签，排队任务一直不派，重启一次 runner 才派（推断 GitHub 只在 runner 连上时按当时标签匹配排队任务，没找到官方文档）。
2. `scripts/operations/hermes-runner/install-runner.sh`：ERR 处理先打印 `INSTALL_STEP_FAILED line <行号> exit <码>: <命令>` 再放回备份。
3. `vitest.workspace.ts`：`tooling` 项目单条测试时限 15 秒（其他项目不变，`integration` 仍 30 秒）；删了该文件原有注释。`test/tooling/test-timeout.test.mjs` 锁住这些值。
4. 测试：`test/tooling/hermes-runner-scripts.test.mjs` 相应更新。
5. 文档：Runbook、ADR 0168、ADR 0169、测试主机手册；长任务记录；`.agents/reviews/topic-policy-migration/`（另一件事的方案讨论记录，不属于本 PR 的代码）。

## 约束

- runner 离线时带着标签也不会被派任务，所以先加标签没有风险（GitHub 文档：只派给 online 且 idle 的匹配 runner）。
- Mac 上的脚本要能在 macOS 自带 bash 3.2 上运行。
- 不写代码注释。

## 作者的说法（请核对）

- 标签加不上时不启动服务；服务起不来、没上线时如实报告 `labels=restored`。
- 旧顺序的 `resume-runners.sh` 跑新测试有 6 条失败；旧 `install-runner.sh` 跑新断言失败；旧 vitest 配置跑新 test-timeout 断言失败。

## 第 2 轮：按第 1 轮意见做的修改（提交 57910cd）

- resume-runners.sh 报告改为 `did not start the services`；服务没全起来时写“已启动的 runner 可能已经在接排队任务”。Runbook 同步。
- test-and-production-hosts.md、architecture-v0.1.md、CI 质量门执行规格写明 tooling 15 秒这一个例外。
- ADR 0169 测试清单改为新顺序。
- 补“加标签后回读 GitHub 失败不启动服务”的测试。

## 第 3 轮：按第 2 轮意见做的修改（提交 5970479）

- install-runner.sh：出错位置作为参数交给 restore_backup，在它关掉 set -e 之后再打印，stderr 写不出去也照样回滚；新增 stderr 关闭时的回滚测试。
- resume-runners.sh：启动前失败的提示加上“本来就在跑的 runner 可能已经在接排队任务”。
- 测试主机规则和手册写明 integration 30 秒、tooling 15 秒两处。
