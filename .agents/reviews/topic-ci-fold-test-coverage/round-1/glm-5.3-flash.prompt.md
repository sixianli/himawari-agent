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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 34843f52b7eb856626c1dee94f833e1ea454aa4f。
待审核的方案：
# 线程的方案：去掉 node-floor 作业，把 test 作业并进 coverage 作业

Andy 已同意方向（2026-11-08 原话：“按方案做”）。请找出方案漏掉的场景、判断错的地方，以及每一步验证能不能真的拦住错误。

## 前提（都已对照 origin/main 34843f52 核对）

1. 现在 PR 的 CI 有 9 个作业：`scripts/ci/check-policy.mjs:31-41` 的 `jobIds`；`ci/policy.json` 的 `checks`。
2. node-floor 用 Node 22.19.0 干净安装、构建，再跑 unit、contracts、integration、e2e、pi-compat（`ci/policy.json` 的 node-floor 项；`scripts/ci/run.mjs:419-433`）。它存在的理由是 `package.json:8` 的 `"node": ">=22.19.0"`，22.19.0 来自 Pi 的最低版本（`docs/archive/plans/2026-08-25-agent-foundation-plan.md:90`）。
3. 生产和上线包只接受 v22.22.3：`scripts/delivery-mode/packet-template/acceptance/cloud/prepare-runtime-tools.py:66` `if name == 'node' and version != 'v22.22.3'`；`finalize-cloud-inputs.py:77` `proof['node'] != 'v22.22.3'`。Hermes 服务也固定 22.22.3（`docs/runbooks/hermes-control-center-upgrade-runbook.md:270`）。
4. test 作业（Node 22.22.3，linux-x64，另有一个暂停的 macos-arm64 成员）经 `scripts/ci/test.mjs` 对 unit、contracts、integration、e2e、pi-compat 逐个项目跑 vitest，每个项目核对“实际跑的测试文件集合 = 按 policy 的 include/exclude 从 git 文件里算出的集合”（`test.mjs:101-112` `CI_TEST_FILE_SET_MISMATCH`），integration 用 `testWorkerCount` 算的进程数（VPS 上 3），其余 1 个进程，跑完再核对构建包摘要没变（`CI_TEST_ARCHIVE_CHANGED`）。
5. coverage 作业（Node 22.22.3）用同一份 Linux 构建包，一次 vitest 调用跑 unit、contracts、tooling、integration 并统计覆盖率（`run.mjs` 的 `checkId === "coverage"` 分支，`--maxWorkers 2`），只核对每个项目的结果非空（`CI_COVERAGE_PROJECT_UNIDENTIFIED`），不核对文件集合。覆盖率范围由 `ci/coverage-policy.json` 定，`scripts/ci/coverage-model.mjs` 的 `coverageProjects` 和 `validateCoveragePolicy` 要求它恰好是这四个项目。
6. 上次 VPS 运行 42362797124 的机器时间：node-floor 39.9 分钟，test 33.0，coverage 32.6，总计 152.3。
7. PR 的策略检查同时拿“提议的 policy”和“基准提交上的 policy（经 `resolvePolicySource` 里固定的升级函数链 `upgradeHostedRunnerPolicy`→`upgradeRunnerLabel`→`upgradeArtifactRetention` 升级后）”去校验 ci.yml（`check-policy.mjs` 的 `main()`）。所以作业清单变化必须配一个只认旧形状、逐字段比对的固定升级函数，否则基准 policy 校验会因 ci.yml 少了作业而失败。
8. main 合并后的确认运行（`scripts/ci/main-confirm.mjs:58-61`）只跑 build 和 security，或调用完整 ci.yml；`aggregate.mjs:202` 按作业名核对“消费的构建包 = 本次构建”。`scripts/ci/local.mjs`（`npm test` = `local.mjs --check test`）在本地按检查名执行。

## 方案

1. **去掉 node-floor 作业**：从 `jobIds`、`ci/policy.json`、`ci.yml`、`required` 的 needs、`run.mjs`、超时和 Chromium 名单里删掉；`package.json` 的 `engines.node` 改成 `>=22.22.3`；`ci/toolchain-lock.json` 删掉 `node.floor` 和 22.19.0 的下载项，`validateToolchain`、`install-tools.mjs` 不再要求 `floor`。
2. **去掉 test 作业，coverage 作业接手 e2e 和 pi-compat**：
   - `ci/policy.json` 的 coverage 项 `projects` 改为 unit、contracts、tooling、integration、e2e、pi-compat 六个；`ci/coverage-policy.json` 不变（覆盖率仍只统计原来四个项目，基线和比较不受影响）。
   - `run.mjs` 的 coverage 分支：覆盖率那次 vitest 调用只带 `coverageProjects` 里的四个项目；剩下的 e2e、pi-compat 在覆盖率测完之后，用 test.mjs 原来的逐项目做法跑（把 `runTests` 改成接收项目清单和时间预算，保留文件集合核对、`--retry 0`、构建包摘要核对）。
   - 覆盖率那次调用也加上和 test.mjs 一样的“实际文件集合 = 应有文件集合”核对，补上 test 作业原来对 unit、contracts、integration 的这道检查。
   - macOS 的 test 成员一并去掉（它从 ADR 0176 起一直暂停）。以后恢复 macOS 检查时，要重新加一个 macOS 的测试作业，写进 ADR。
   - `aggregate.mjs`、`local.mjs` 去掉 test；`package.json` 的 `test` 脚本改成 `local.mjs --check coverage`，本地“跑全部测试”仍是一个命令。
3. **基准升级函数** `upgradeFoldTestAndDropNodeFloor`：基准 policy 恰好是旧形状（9 个作业、test 和 node-floor 的字段与现在 main 完全一样）时，删掉这两个作业、把 coverage 的 projects 换成六个、required 的 needs 去掉这两个；其他任何形状原样返回，交给 `validatePolicy` 拒绝。
4. **超时**：coverage 保持 60 分钟（现在 32.6 分钟，加上 e2e 和 pi-compat 预计 5 分钟以内）。
5. **文档**：新 ADR 修订 CI 设计（`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:119`“最低兼容版本为 `22.19.0`”、`:201` node-floor 行、test 行），同步 `README.md:19-21`、`docs/architecture-v0.1.md:158,613`。

## 验证

- `test/tooling/policy.test.mjs` 等现有用例按新作业清单改；新增：旧形状基准能升级、改动一个字段的旧形状不升级并被拒、ci.yml 多出 test 或 node-floor 作业被拒、coverage 作业缺 e2e 或 pi-compat 被拒、文件集合少一个文件时 coverage 失败（反向）。
- Hermes 上跑 tooling 测试、`npm run check`、`npm run build`。
- 开 PR 后在 VPS 上跑一次完整 CI：7 个作业全部通过，coverage 报告里六个项目都有结果，记下 coverage 作业耗时。

## 想请你们重点看

- 去掉 test 作业后，有没有哪道检查或哪份证据只在 test 作业里出现、方案没补上（例如 JUnit 报告、macOS、构建包摘要、integration 的进程数从 3 变 2）？
- 覆盖率那次 vitest 调用里，e2e、pi-compat 放在外面单独跑，而不是一起放进覆盖率调用，这个取舍对不对？
- 基准升级函数会不会让一个削弱检查的 PR 混过去？
- `engines` 提到 `>=22.22.3` 会不会影响别的地方（例如依赖安装、Pi 包、Mac 上的开发）？
