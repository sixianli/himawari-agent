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
仓库就是当前目录，已检出 ce942046c8624514e2c024ba33520259823a2594。
对比基准是 3086f38b297a7d68646dc7ce09f606edb1688762，先运行 git diff 3086f38b297a7d68646dc7ce09f606edb1688762..ce942046c8624514e2c024ba33520259823a2594 看改动。
作者的说法（可能有错，请核对）：
# PR 457 第 1 轮：作者说明

背景：ADR 0256（`docs/adr/0256-gate-job-gets-its-own-runner.md`，已在 main）决定在 CI 服务器上加第 3 个 runner，只跑汇总作业 `ci/required`；main 的确认只保留最新一次。这个 PR 是 ADR 里的“PR A”和“第 2 步”，不改 `ci.yml`（汇总作业切到新 runner 在下一个 PR）。

改动：

1. `scripts/operations/ci-runner/runners.sh`：`RUNNER_IDS="1 2 3"`；3 号 runner 名字和标签都是 `ci-vps-gate`，用户 `gh-runner-gate`，目录 `/srv/gh-runner-gate`；每个 runner 有自己的标签、内存池、内存和进程数限额；`render_runner_unit` 把这些填进服务模板。
2. `gh-runner.service.in`、`gh-runners.slice`（上限从 20 GB 降到 18 GB）、新文件 `ghgate.slice`（预留和上限各 2 GB）。分组名不带短横线，因为 systemd 把短横线当上下级，预留内存要每一级都设才生效。
3. `install-runner.sh`、`uninstall-runner.sh`、`register-runner.sh`、`prepare-vps.sh`、`gh-runner-nft.service`、`runner-pause.sh`：认 3 号。
4. `mac-runners.sh`、`pause-runners.sh`、`resume-runners.sh`：暂停去掉 runner 身上所有会接作业的标签（`ci-vps`、`ci-vps-gate`，包括应急时加在 1 号上的），恢复只给每个 runner 加回它自己的标签。
5. 新文件 `gate-fallback.sh on|off`：3 号坏了时在 Mac 上把 `ci-vps-gate` 临时加到 `ci-vps-1` 上。
6. `.github/workflows/main.yml` 并发组改成固定的 `main-confirmation`（`cancel-in-progress` 仍是 `false`）；`scripts/ci/main-workflow.mjs` 的硬规则同步。
7. `docs/runbooks/ci-vps-runner-runbook.md` 改成三个 runner。
8. `test/tooling/security-published.test.mjs`：原来一条用例连续扫 63 个文件，合计 2.8 到 3.7 秒，CI 上偶发超过 5 秒上限；拆成每个登记文件一条用例。

请重点看：

- 暂停、恢复、应急三个脚本在各种中间状态下会不会留下“服务停了但标签还在”或“给 3 号加了 `ci-vps`”的情况。
- 在已经有两个 runner 的机器上安装（先暂停、上传、`install-runner.sh`、`register-runner.sh 3`、恢复）会不会弄坏现有的两个 runner；安装中途失败的回滚有没有漏掉新加的文件（`ghgate.slice`、3 号的用户和目录）。
- 3 号 runner 的服务文件有没有藏住另外两个 runner 的目录，反过来也是。

本 PR 不改产品代码，不改发给模型的任何内容。

实际跑过的检查：`npm run check` 50 步通过；`test/tooling/ci-runner-scripts.test.mjs` 122 条通过。反向验证：3 号标签写成 `ci-vps`、恢复时给 3 号加 `ci-vps`、1 号看得到 3 号目录、暂停只去 `ci-vps`、`RUNNER_IDS` 漏掉 3、并发组改回带运行号、`cancel-in-progress` 改成 `true`，对应用例都失败。没有在真实的 CI 服务器上跑过。
