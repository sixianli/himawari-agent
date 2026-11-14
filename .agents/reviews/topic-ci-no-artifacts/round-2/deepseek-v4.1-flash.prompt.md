你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 9470f9a6be50503385237c3712b1b72f58cfdab5。
待审核的方案：
# 线程方案（整合版）：CI 彻底不用 GitHub 产物（ADR 0242）

## 前提（附来源）
1. 免费账号产物存储 500 MB、按整月累计，周期内超了就一直被拦：https://docs.github.com/en/billing/concepts/product-billing/github-actions ——“Storage charges accrue every hour based on your actual usage throughout the month”“If your account does not have a valid payment method on file, usage is blocked once you use up your quota.”
2. 2026-08-27 GitHub Changelog（https://github.blog/changelog/2026-08-27-actions-retention-will-cover-checks-workflow-runs-and-statuses/）：“Artifacts and logs count toward your billable GitHub Actions storage.”；日志和工作流运行记录都跟随“artifact and log retention”设置，2026-10-01 起默认 90 天。计费页另一句说日志和作业摘要不算产物额度，两份一手材料冲突，按较严的 Changelog 处理：日志也要少写、少留。
3. 作业摘要单步上限 1 MiB：https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands ——“each step is restricted to a maximum size of 1MiB”。
4. main.yml 三个作业都 `runs-on: ci-vps`，和 PR 作业同一台机器（.github/workflows/main.yml）。
5. 共享目录每小时清理 6 小时前的条目（scripts/operations/ci-runner/runners.sh:7、clean-old.sh:24-26），gate 放里面活不过 main 的 24 小时发现窗口（scripts/ci/main-evidence.mjs:107-108）。
6. 轻量确认的可信度来自 verifyGate 对 gate 内容的核对（main-evidence.mjs:132-189）和 MAIN_VALIDATION_CHANGED（:57-71），不来自产物存放位置。
7. run-share.mjs 已有“临时名写完再改名、已存在即失败、取时按摘要重算”的 put/get（run-share.mjs:72-112）。
8. quality.yml 的 handoff 下载的 report-* 产物在 ADR 0238 之后已经不存在（quality.yml:296-307；ADR 0238 决定 1），quality 已停用（docs/runbooks/ci-vps-runner-runbook.md:39）。

## 方案
1. **gate 放 CI 服务器上的独立目录**：新建与共享目录平级的 `/srv/gh-runner-gate`（root:gh-ci-share，2770，两个 runner 的 ReadWritePaths 加上，新环境变量 HIMAWARI_CI_GATE）。`run-share.mjs gate --from .ci-output/gate` 写入 `<runId>-<attempt>/`（沿用 put 的只写一次语义），每次执行时顺带删 7 天前的 gate 目录，不改 root 定时清理。ci/required：入口检查 → collect → required.mjs → gate（条件 REQUIRED_AFTER_ENTRY）→ remove。删除 gate 产物上传。
2. **main 确认读 gate 目录**：discover 照旧用 API 找 24 小时内成功的 PR 运行，再要求 gate 目录存在；verify 从磁盘读 context.json、summary.json，verifyGate 不改。plan→confirm 的交接用 `run-share.mjs put/get`（名字 main-evidence，作业输出传摘要），confirm 按摘要取回后 main-confirm.mjs 照旧再核一遍。任何一步拿不到都走 mode=full。
3. **诊断留在 CI 服务器、摘要给人看**：六个检查作业 put 改为 `--from .ci-output/public`（报告和诊断都进共享目录，collect 只认 result.json，多出的文件无害），完整诊断 6 小时内 Andy 可 ssh 取；新脚本 `ci-summary.mjs` 只把结论、失败原因和每个失败诊断文件末尾若干行（总量不超过 64 KiB）写进作业摘要，二进制文件只列名字、大小、sha256。不把整份诊断打进日志，因为日志也计费（前提 2）。
4. **quality.yml**：删掉 handoff 作业和 ci_run_id 输入，各质量作业的上传换成同一个摘要步骤。
5. **硬规则**：check-policy、main-workflow、quality-policy 三处都禁止 actions/upload-artifact、actions/download-artifact；ci/toolchain-lock.json 和 install-tools.mjs 的期望集合删掉这两个 action；required 必须恰好一个 gate 步骤、条件 REQUIRED_AFTER_ENTRY；每个检查作业恰好一个摘要步骤；main.yml 的 evidence 输出必须是摘要表达式。每条配一个反向用例；ci-optimization.test 改为“三个工作流没有任何产物 action”。
6. **删掉无用的 retentionDays 字段**（ci/policy.json、ci/quality-policy.json、schema、upgradeArtifactRetention 及测试），免得留下没有消费者的配置。
7. **请 Andy 改仓库设置**：Settings → Actions → General → “Artifact and log retention” 从默认 90 天改成 3 天（main 发现窗口 24 小时，留余量），减少日志计费累积。下一账单周期开始后不再被日志撑满。
8. **文档**：ADR 0242 修订 ADR 0238（决定 1 “GitHub 上只留 gate 和诊断”）、ADR 0241（gate 上传条件），双向 amends/amended_by；runbook 加 gate 目录、排查表加 CI_GATE_ROOT_REQUIRED；设计说明同步。
9. **顺序**：PR 409（需 Andy 说“这次不等 CI”）→ 本方案 PR（合并同样要他说一次）→ Andy 在 CI 服务器重跑一次安装脚本（建 gate 目录）→ 第一个 PR 应全绿，用它验证；同时 8 条“不是密钥”例外要随 PR 409 或本 PR 进 main。

## 不选的做法
- gate 写进 ci/required 的步骤日志、main 用 API 解析（DeepSeek 推荐）：不用改 CI 服务器，PR 代码事后也改不了日志；但日志计费（前提 2），而且我们要把日志保留期缩短到 3 天，再加上日志解析脆。放弃，作为“可选加固”：gate 摘要同时打一行到日志，以后需要时可以比对。
- gate 放共享目录子目录：要改 root 定时清理，且容易被 remove/清理误删（前提 5）。
- 诊断整份打进日志（GLM）：日志计费。

## 风险
- runner 重装后忘建 gate 目录：所有 main 确认退成完整 CI，不会假绿；排查表加一条。
- 同机篡改 gate：和今天产物方案同级（gate 本来就是 PR 代码在 runner 上算的），ADR 0238 已接受同机威胁模型。
- 截图、trace 看不到网页版，只能 ssh。
