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
仓库就是当前目录，已检出 aee93e1084297d068e20318bffc45de06c873852。
对比基准是 34843f52b7eb856626c1dee94f833e1ea454aa4f，先运行 git diff 34843f52b7eb856626c1dee94f833e1ea454aa4f..aee93e1084297d068e20318bffc45de06c873852 看改动。
上一轮复核到 336ff040a74c8c0ab28a4cb4adebd7ef0163d53c，先看 git diff 336ff040a74c8c0ab28a4cb4adebd7ef0163d53c..aee93e1084297d068e20318bffc45de06c873852 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 291：去掉 node-floor 作业，把 test 作业并进 coverage 作业

## 问题
VPS 上的 CI 每个 PR 跑 9 个作业，其中 node-floor（Node 22.19.0）、test、coverage 三个作业把同一批测试跑了三遍，分别用了 39.9、33.0、32.6 分钟（运行 42362797124）。生产和上线包只接受 Node v22.22.3（`scripts/delivery-mode/packet-template/acceptance/cloud/prepare-runtime-tools.py`）。

## 目标（Andy 2026-11-08 同意的方案）
- `engines.node` 改成 `>=22.22.3`，删掉 node-floor 作业和工具链锁文件里的 22.19.0。
- 删掉 test 作业（含暂停的 macOS 成员）。coverage 作业的 projects 改成 unit、contracts、tooling、integration、e2e、pi-compat 六个：前四个照旧在一次带覆盖率的 Vitest 调用里跑；之后用 `scripts/ci/test.mjs` 的 `runTests` 接着跑 e2e、pi-compat（核对文件集合、`--retry 0`、跑完核对构建包摘要），覆盖率失败也照样跑，两边失败一起报告。
- `ci/required` 的 needs、`aggregate.mjs`、`local.mjs` 跟着改；`npm test` 改成 `local.mjs --check coverage`。
- `check-policy.mjs` 新增 `upgradeRetiredTestChecks`：PR 的策略检查会拿目标分支（base）上的旧策略经升级函数链升级后去校验 ci.yml；只有旧策略和 2026-11-08 的 main 逐字段相同时才升级成 7 个作业，否则原样返回交给校验拒绝。
- `ci/policy.schema.json` 作业数下限 9→7，`ci/evidence.schema.json` 结果条数上下限 10/12→8/9。
- 新 ADR 0181，并更新 CI 设计文档、README、架构文档。

## 约束
- coverage 作业时限保持 60 分钟，不调高任何测试超时。
- 覆盖率范围（`ci/coverage-policy.json`）和基线不变。
- 丢掉 unit、contracts、integration 的单独 JUnit 报告，这是已接受的后果。

## 作者的说法（请核对，不要当成事实）
- 去掉 test 作业后，没有哪道只在 test 作业里存在的检查被漏掉（文件集合核对由 `check-coverage.mjs` 对前四个项目做；e2e、pi-compat 仍走 `runTests`）。
- 升级函数不会让一个削弱检查的 PR 混过去。
- 所有引用 test、node-floor 作业名的地方（脚本、schema、测试、文档、main 合并后的确认运行 `scripts/ci/main-confirm.mjs`）都已同步。
- Hermes 上 tooling 项目 1984 通过、1 个失败在改动前也失败；第 3 层 npm test 的 7 个失败经单独重跑或在 base 上复现，和本改动无关。

## 第 2 轮：336ff040 之后的修改（请先看增量，再按需读任何文件）
- `scripts/ci/run.mjs`：覆盖率部分通过、只有 e2e 或 pi-compat 失败时，记 `failed` 和它的真实退出码；覆盖率也失败时保留覆盖率进程的退出码。
- `scripts/ci/check-policy.mjs`：`upgradeRetiredTestChecks` 现在把 test、node-floor、coverage、required 四项都和 2026-11-08 main 的原样逐字段比对；报错文字 nine 改为 seven。
- 新增测试：e2e/pi-compat 失败两条；升级守卫 3 条反向用例；用 5daedc92（覆盖率基线所在提交）的托管九作业策略走完整条升级链。
- `test/tooling/environment.test.mjs`：main 的 4be522b3 给 tooling 项目环境加了 `HIMAWARI_REVIEW_GATEWAY: ""`，这条测试没跟上，main 上一直失败；改成接受并核对它被清空。
